// api.js
// The ONLY file that talks to live-data providers. Everything else in the app works with the
// "normalized" aircraft objects this module returns, so switching providers never touches
// the map, list or filters.
//
// What we know about the response, and how we know it:
//   adsb.lol's API source code (github.com/adsblol/api, utils/api_v2.py) forwards /v2/point
//   requests to readsb with the "jv2" option. readsb's source (github.com/wiedehopf/readsb,
//   api.c) shows that "jv2" produces:
//       { "ac": [ ...aircraft... ], "msg": "No error", "now": <ms>, "total": <n>,
//         "ctime": <ms>, "ptime": <ms> }
//   and that radius queries add "dst" (distance, nm) and "dir" (bearing) to each aircraft.
//   The per-aircraft field names come from readsb's README-json.md. Fields are LEFT OUT when
//   there is no data, which is why every field below falls back to null.

import { CONFIG } from './config.js';

// Each provider says how to build its URL and how to credit it on the page.
export const PROVIDERS = {
  adsbLol: {
    name: 'adsb.lol',
    csvCredit: 'adsb.lol (ODbL 1.0)', // added as a "source" column to exported CSV files
    attributionHtml:
      'Live positions: <a href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a> ' +
      '(<a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener">ODbL 1.0</a>)',
    pointUrl: (lat, lon, radiusNm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${radiusNm}`,
  },
  // Same software (readsb) and same URL pattern, but I could NOT confirm its response format
  // or that it is still public (a report says feeders-only since Aug 2026). If its response
  // doesn't have the shape above, the app shows a "format" error instead of guessing.
  airplanesLive: {
    name: 'airplanes.live',
    csvCredit: 'airplanes.live (non-commercial use)',
    attributionHtml:
      'Live positions: <a href="https://airplanes.live" target="_blank" rel="noopener">airplanes.live</a> ' +
      '(non-commercial use)',
    pointUrl: (lat, lon, radiusNm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${radiusNm}`,
  },
};

// A custom error type, so the page can show a different message for each kind of problem.
//   kind: 'network'      - request never got an answer (offline, blocked, or CORS)
//         'timeout'      - provider took too long
//         'rate_limited' - HTTP 429, we asked too often
//         'http'         - any other non-OK HTTP status (provider down, 403 etc.)
//         'format'       - we got an answer but it wasn't the JSON shape we expect
export class ApiError extends Error {
  constructor(kind, message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// Remembers the last answer for each URL, plus when we last sent any request at all.
const cache = new Map(); // url -> { time, result }
let lastRequestTime = 0;

// Turn one raw aircraft object from the provider into the app's own format.
// Only fields documented in readsb's README-json.md are read. Anything missing becomes null.
export function normalizeAircraft(ac) {
  return {
    hex: ac.hex ?? null, // 24-bit ICAO address. May start with "~" (non-ICAO address).
    callsign: typeof ac.flight === 'string' ? ac.flight.trim() || null : null,
    registration: ac.r ?? null, // from the provider's aircraft database
    typeCode: ac.t ?? null, // ICAO type designator, e.g. "A359"
    typeDescription: ac.desc ?? null, // long type name, e.g. "AIRBUS A-350-900"
    operator: ac.ownOp ?? null, // owner/operator from the provider's database
    yearBuilt: ac.year ?? null, // readsb sends this as a string, e.g. "2019"
    lat: typeof ac.lat === 'number' ? ac.lat : null,
    lon: typeof ac.lon === 'number' ? ac.lon : null,
    // alt_baro is either a number (feet) or the string "ground".
    altitudeFt: typeof ac.alt_baro === 'number' ? ac.alt_baro : null,
    onGround: ac.alt_baro === 'ground',
    groundSpeedKt: ac.gs ?? null,
    // Prefer track over ground; on the ground some aircraft only send true_heading.
    // calc_track (seen in a real Oct 2026 response) is readsb's track worked out from positions.
    trackDeg: ac.track ?? ac.true_heading ?? ac.calc_track ?? null,
    // Barometric rate is what pilots see; fall back to the GPS-based rate.
    verticalRateFpm: ac.baro_rate ?? ac.geom_rate ?? null,
    squawk: ac.squawk ?? null,
    // Emergency state the aircraft reports ("none" in the real Oct 2026 response; readsb's README
    // lists general, lifeguard, minfuel, nordo, unlawful, downed). null when not sent.
    emergency: typeof ac.emergency === 'string' ? ac.emergency : null,
    // ADS-B emitter category (DO-260B), sent by the aircraft: A1 light ... A5 heavy, A7 rotorcraft.
    category: typeof ac.category === 'string' ? ac.category : null,
    distanceNm: ac.dst ?? null, // only present on radius queries
    secondsSinceSeen: ac.seen ?? null,
  };
}

// Check the response really looks like readsb "jv2" output before we trust it.
function parseResponse(data) {
  if (!data || !Array.isArray(data.ac)) {
    throw new ApiError('format', 'The provider answered, but not in the expected format (no "ac" list).');
  }
  return {
    aircraft: data.ac.map(normalizeAircraft),
    providerTimeMs: typeof data.now === 'number' ? data.now : null,
  };
}

// Small helper: wait for `ms` milliseconds.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Main function: get all aircraft within radiusNm of (lat, lon).
// Returns { aircraft: [...], fetchedAt, providerTimeMs, fromCache }.
export async function fetchAircraftNear(lat, lon, radiusNm, providerKey = CONFIG.provider) {
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new Error(`Unknown provider "${providerKey}"`);

  // Round the inputs so tiny map movements don't defeat the cache.
  const radius = Math.min(Math.max(Math.round(radiusNm), 1), 250);
  let url = provider.pointUrl(lat.toFixed(4), lon.toFixed(4), radius);
  if (CONFIG.proxyBase) url = CONFIG.proxyBase + encodeURIComponent(url);

  // 1) Cache: if we asked the same thing very recently, reuse the answer.
  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < CONFIG.cacheTtlMs) {
    return { ...cached.result, fromCache: true };
  }

  // 2) Rate limit: never send two requests closer together than minRequestGapMs.
  const wait = lastRequestTime + CONFIG.minRequestGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestTime = Date.now();

  // 3) Send the request, with a timeout so a hung provider can't freeze the app.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ApiError('timeout', `${provider.name} did not answer within ${CONFIG.requestTimeoutMs / 1000} s.`);
    }
    // Browsers report CORS blocks and "offline" the same way, as a generic TypeError.
    throw new ApiError('network', `Could not reach ${provider.name}. You may be offline, or the provider may block requests from web pages (CORS).`);
  } finally {
    clearTimeout(timer);
  }

  // 4) Handle HTTP errors.
  if (response.status === 429) {
    // Retry-After (seconds) is a standard header; use it only if the provider sends it.
    const seconds = Number(response.headers.get('Retry-After'));
    throw new ApiError('rate_limited', `${provider.name} says we are asking too often (HTTP 429).`, {
      status: 429,
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    });
  }
  if (!response.ok) {
    throw new ApiError('http', `${provider.name} returned HTTP ${response.status}.`, { status: response.status });
  }

  // 5) Parse and validate the JSON.
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError('format', `${provider.name} sent something that is not valid JSON.`);
  }
  const result = { ...parseResponse(data), fetchedAt: Date.now() };
  cache.set(url, { time: result.fetchedAt, result });
  return { ...result, fromCache: false };
}
