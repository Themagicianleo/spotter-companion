// cloudflare-worker.js: the Spotter's Companion worker on Cloudflare. See proxy/README.md.
//
// It does two jobs:
//
// 1. RELAY (fetch handler, /?url=...): fetches data for the website from providers that don't
//    send CORS headers. Only relays to ALLOWED_HOSTS, so it can't be used as an open proxy.
//
// 2. RECORDER (scheduled handler, every minute + /track and /recorder-status):
//    once a minute it asks adsb.lol for all aircraft around RECORD_CENTER and saves their positions
//    in a D1 database (binding name "DB"), one row per minute. The website asks /track?hex=...
//    for an aircraft's path, so tracks don't start only when you open the page.
//    /stats sums up the last 24 hours (aircraft per hour, top types and airlines) for the Stats panel.
//
// Free-plan budget (checked Oct 2026): D1 allows 100,000 row writes/day; this uses about 2,900
// (one insert + one cleanup delete per minute). Workers allow 10 ms CPU per run; the database
// does the heavy lifting (json_extract), not the worker.

const ALLOWED_HOSTS = ['api.adsb.lol', 'api.airplanes.live', 'api.planespotters.net', 'aviationweather.gov'];
// How long Cloudflare may reuse an answer, per host (seconds). Weather changes every 30-60 minutes.
const CACHE_SECONDS = { 'aviationweather.gov': 300 };

// Set this to your GitHub Pages address so only your site can use the relay and track API.
const ALLOWED_ORIGIN = 'https://themagicianleo.github.io';

const USER_AGENT = 'SpottersCompanion/1.0 (personal non-commercial project; +https://github.com/Themagicianleo/spotter-companion)';

// Recorder settings.
const RECORD_CENTER = { lat: 1.35, lon: 103.82 }; // Singapore
const RECORD_RADIUS_NM = 80; // a bit bigger than the website's default 40 nm
const KEEP_HOURS = 24; // older snapshots are deleted
const MAX_TRACK_MINUTES = 24 * 60;

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

// ---------------------------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------------------------

// Turn the adsb.lol answer into a compact snapshot:
//   { "76cd41": [lat, lon, altFt|0 on ground|null, track|null, callsign|null, typeCode|null], ... }
// Uses the same readsb fields the website uses (hex, lat, lon, alt_baro, track/true_heading/calc_track,
// flight, t). Snapshots recorded before Oct 2026's update have only the first four values.
export function buildSnapshot(data) {
  const snapshot = {};
  for (const ac of data?.ac ?? []) {
    if (typeof ac.hex !== 'string' || !/^[0-9a-f]{6}$/.test(ac.hex)) continue; // skip non-ICAO "~" addresses
    if (typeof ac.lat !== 'number' || typeof ac.lon !== 'number') continue;
    const alt = ac.alt_baro === 'ground' ? 0 : typeof ac.alt_baro === 'number' ? ac.alt_baro : null;
    const track = ac.track ?? ac.true_heading ?? ac.calc_track ?? null;
    const callsign = typeof ac.flight === 'string' ? ac.flight.trim() || null : null;
    const type = typeof ac.t === 'string' ? ac.t : null;
    snapshot[ac.hex] = [Math.round(ac.lat * 1e4) / 1e4, Math.round(ac.lon * 1e4) / 1e4, alt, track === null ? null : Math.round(track), callsign, type];
  }
  return snapshot;
}

async function ensureTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS snapshots (t INTEGER PRIMARY KEY, data TEXT NOT NULL)').run();
}

async function record(env) {
  const url = `https://api.adsb.lol/v2/point/${RECORD_CENTER.lat}/${RECORD_CENTER.lon}/${RECORD_RADIUS_NM}`;
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) {
    console.log(`recorder: adsb.lol answered HTTP ${response.status}; skipping this minute`);
    return;
  }
  const snapshot = buildSnapshot(await response.json());
  const now = Math.floor(Date.now() / 1000);
  await ensureTable(env.DB);
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO snapshots (t, data) VALUES (?, ?)').bind(now, JSON.stringify(snapshot)),
    env.DB.prepare('DELETE FROM snapshots WHERE t < ?').bind(now - KEEP_HOURS * 3600),
  ]);
}

// One aircraft's recorded path: [{ t, lat, lon, alt }], oldest first.
async function getTrack(env, hex, minutes) {
  const since = Math.floor(Date.now() / 1000) - minutes * 60;
  // json_extract runs inside the database, so the worker doesn't parse every snapshot itself.
  const path = `$."${hex}"`; // hex is checked to be 6 hex characters before we get here
  const { results } = await env.DB.prepare(
    'SELECT t, json_extract(data, ?1) AS p FROM snapshots WHERE t >= ?2 AND json_extract(data, ?1) IS NOT NULL ORDER BY t',
  ).bind(path, since).all();
  return results.map((r) => {
    const [lat, lon, alt] = JSON.parse(r.p);
    return { t: r.t, lat, lon, alt };
  });
}

// Totals for the last `hours` hours. The database does the counting (json_each walks each
// snapshot's aircraft), so the worker stays within its CPU limit. An aircraft counts once per
// hour it was seen, and once overall.
async function getStats(env, hours) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const from = 'FROM snapshots AS s, json_each(s.data) AS j WHERE s.t >= ?1';
  const [perHour, types, airlines, total] = await env.DB.batch([
    env.DB.prepare(`SELECT (s.t / 3600) * 3600 AS hour, COUNT(DISTINCT j.key) AS aircraft ${from} GROUP BY hour ORDER BY hour`).bind(since),
    env.DB.prepare(`SELECT json_extract(j.value, '$[5]') AS type, COUNT(DISTINCT j.key) AS aircraft ${from}
      AND json_extract(j.value, '$[5]') IS NOT NULL GROUP BY type ORDER BY aircraft DESC LIMIT 15`).bind(since),
    env.DB.prepare(`SELECT substr(json_extract(j.value, '$[4]'), 1, 3) AS airline, COUNT(DISTINCT j.key) AS aircraft ${from}
      AND json_extract(j.value, '$[4]') GLOB '[A-Z][A-Z][A-Z][0-9]*' GROUP BY airline ORDER BY aircraft DESC LIMIT 15`).bind(since),
    env.DB.prepare(`SELECT COUNT(DISTINCT j.key) AS aircraft, MIN(s.t) AS oldest,
      MIN(CASE WHEN json_array_length(j.value) >= 6 THEN s.t END) AS detailsSince ${from}`).bind(since),
  ]);
  const t = total.results[0] ?? {};
  return {
    hours,
    area: { ...RECORD_CENTER, radiusNm: RECORD_RADIUS_NM },
    uniqueAircraft: t.aircraft ?? 0,
    oldest: t.oldest ?? null, // unix seconds of the oldest snapshot used
    detailsSince: t.detailsSince ?? null, // types/callsigns are only recorded from this time on
    perHour: perHour.results, // [{ hour (unix s), aircraft }]
    types: types.results, // [{ type, aircraft }]
    airlines: airlines.results, // [{ airline (ICAO code), aircraft }]
  };
}

let statsCache = null; // { time, hours, body }: stats change slowly, so reuse them for 5 minutes

// ---------------------------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------------------------

async function relay(request) {
  const target = new URL(request.url).searchParams.get('url') ?? '';
  let host = '';
  try {
    host = new URL(target).hostname;
  } catch {
    // not a valid URL; handled below
  }
  if (!target.startsWith('https://') || !ALLOWED_HOSTS.includes(host)) {
    return new Response('Not allowed', { status: 400 });
  }
  const upstream = await fetch(target, {
    headers: { 'User-Agent': USER_AGENT },
    // Ask Cloudflare to cache answers for 5 s, so many viewers = few provider requests.
    cf: { cacheTtl: CACHE_SECONDS[host] ?? 5, cacheEverything: true },
  });
  const headers = new Headers(corsHeaders);
  const retryAfter = upstream.headers.get('Retry-After');
  if (retryAfter) headers.set('Retry-After', retryAfter);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/track') {
      if (!env.DB) return json({ error: 'Recorder database not connected (add a D1 binding named DB)' }, 503);
      const hex = (url.searchParams.get('hex') ?? '').toLowerCase();
      if (!/^[0-9a-f]{6}$/.test(hex)) return json({ error: 'hex must be 6 hex characters' }, 400);
      const minutes = Math.min(Math.max(Number(url.searchParams.get('minutes')) || 180, 1), MAX_TRACK_MINUTES);
      try {
        return json({ hex, minutes, points: await getTrack(env, hex, minutes) });
      } catch (err) {
        return json({ error: `Track lookup failed: ${err.message}` }, 500); // e.g. no snapshots yet
      }
    }

    if (url.pathname === '/stats') {
      if (!env.DB) return json({ error: 'Recorder database not connected (add a D1 binding named DB)' }, 503);
      const hours = Math.min(Math.max(Math.round(Number(url.searchParams.get('hours')) || 24), 1), KEEP_HOURS);
      if (statsCache && statsCache.hours === hours && Date.now() - statsCache.time < 5 * 60 * 1000) return json(statsCache.body);
      try {
        const body = await getStats(env, hours);
        statsCache = { time: Date.now(), hours, body };
        return json(body);
      } catch (err) {
        return json({ error: `Stats failed: ${err.message}` }, 500); // e.g. nothing recorded yet
      }
    }

    if (url.pathname === '/recorder-status') {
      if (!env.DB) return json({ connected: false, error: 'No D1 binding named DB' });
      try {
        const row = await env.DB.prepare('SELECT COUNT(*) AS snapshots, MIN(t) AS oldest, MAX(t) AS newest FROM snapshots').first();
        const latest = await env.DB.prepare('SELECT data FROM snapshots ORDER BY t DESC LIMIT 1').first();
        return json({
          connected: true,
          snapshots: row.snapshots,
          oldest: row.oldest ? new Date(row.oldest * 1000).toISOString() : null,
          newest: row.newest ? new Date(row.newest * 1000).toISOString() : null,
          aircraftInLatest: latest ? Object.keys(JSON.parse(latest.data)).length : 0,
          area: { ...RECORD_CENTER, radiusNm: RECORD_RADIUS_NM },
        });
      } catch (err) {
        return json({ connected: true, snapshots: 0, note: `Nothing recorded yet (${err.message})` });
      }
    }

    return relay(request);
  },

  // Runs on the Cron Trigger (every minute).
  async scheduled(controller, env, ctx) {
    if (!env.DB) {
      console.log('recorder: no D1 binding named DB; nothing recorded');
      return;
    }
    ctx.waitUntil(record(env));
  },
};
