// weather.js
// Airport weather (METAR observation + TAF forecast) from NOAA's Aviation Weather Center data API.
//
// Endpoints and fields checked against the docs (aviationweather.gov/data/api) and a real response
// fetched on 21 Oct 2026:
//   /api/data/metar?ids=WSSS&format=json ->
//     [{ icaoId, name, obsTime (unix s), reportTime, temp, dewp, wdir, wspd, visib (statute miles),
//        altim (hPa), rawOb, clouds: [{cover, base}], fltCat, ... }]
//   /api/data/taf?ids=WSSS&format=raw -> plain text, e.g. "TAF WSSS 211100Z 2112/2218 07007KT ..."
// The docs say: at most 100 requests/minute, set a custom User-Agent, and "Cross-origin resource
// sharing is not permitted", so browsers can't call it directly; we go through our relay, which
// adds the User-Agent. We ask at most once every 10 minutes (METARs are issued every 30-60 min).
// NWS data is public domain; we credit it and say it's not for flight planning.

import { CONFIG } from './config.js';

const API = 'https://aviationweather.gov/api/data';
const REFRESH_MS = 10 * 60 * 1000;

// Runway directions (runway number x 10 = magnetic heading). Only airports we're sure about.
const RUNWAYS = { WSSS: { names: ['02', '20'], headings: [20, 200], label: 'Changi (runways 02 and 20)' } };

const COVER = { FEW: 'Few', SCT: 'Scattered', BKN: 'Broken', OVC: 'Overcast' };
const WX_WORDS = {
  TS: 'thunderstorm', SH: 'showers', RA: 'rain', DZ: 'drizzle', SN: 'snow', GR: 'hail', GS: 'small hail',
  BR: 'mist', FG: 'fog', HZ: 'haze', FU: 'smoke', DU: 'dust', SA: 'sand', SQ: 'squalls', FC: 'funnel cloud',
  VA: 'volcanic ash', FZ: 'freezing', MI: 'shallow', BC: 'patches of', PR: 'partial', DR: 'drifting', BL: 'blowing',
};

// "-TSRA" -> "light thunderstorm with rain", "VCSH" -> "showers nearby". Returns null if it isn't a weather group.
export function decodeWeather(token) {
  const m = /^(\+|-|VC)?((?:MI|BC|PR|DR|BL|SH|TS|FZ)?)((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)*)$/.exec(token);
  if (!m || (!m[2] && !m[3])) return null;
  const words = [];
  if (m[1] === '-') words.push('light');
  if (m[1] === '+') words.push('heavy');
  if (m[2]) words.push(WX_WORDS[m[2]]);
  const kinds = (m[3].match(/../g) ?? []).map((k) => WX_WORDS[k] ?? k);
  if (kinds.length) words.push((m[2] === 'TS' ? 'with ' : '') + kinds.join(' and '));
  if (m[1] === 'VC') words.push('nearby');
  return words.join(' ');
}

// Pull out what the JSON doesn't give directly, from the raw report (standard METAR groups).
export function parseRawMetar(raw) {
  const out = { gustKt: null, visibilityM: null, cavok: false, weather: [], clouds: [] };
  const tokens = String(raw ?? '').split(/\s+/);
  for (const t of tokens) {
    if (t === 'RMK' || t === 'TEMPO' || t === 'BECMG' || t === 'NOSIG') break; // trend/remarks: not "now"
    let m;
    if ((m = /^(?:\d{3}|VRB)\d{2,3}G(\d{2,3})KT$/.exec(t))) out.gustKt = Number(m[1]);
    else if (t === 'CAVOK') out.cavok = true;
    else if (/^\d{4}$/.test(t) && out.visibilityM === null) out.visibilityM = Number(t);
    else if ((m = /^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/.exec(t))) out.clouds.push({ cover: m[1], baseFt: Number(m[2]) * 100, type: m[3] ?? null });
    else {
      const text = decodeWeather(t);
      if (text) out.weather.push({ code: t, text });
    }
  }
  return out;
}

// Check and tidy one METAR from the JSON answer. Missing values become null.
export function parseMetar(data) {
  if (!Array.isArray(data)) throw new Error('Unexpected METAR response format');
  const m = data[0];
  if (!m || typeof m.rawOb !== 'string') return null; // no recent report for this station
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const raw = parseRawMetar(m.rawOb);
  return {
    station: typeof m.icaoId === 'string' ? m.icaoId : null,
    name: typeof m.name === 'string' ? m.name : null,
    observedMs: num(m.obsTime) === null ? null : m.obsTime * 1000,
    tempC: num(m.temp),
    dewpointC: num(m.dewp),
    windDir: num(m.wdir), // null when variable ("VRB") or missing
    windVariable: m.wdir === 'VRB',
    windKt: num(m.wspd),
    gustKt: raw.gustKt,
    visibilityM: raw.visibilityM ?? (num(m.visib) === null ? null : Math.round(m.visib * 1609.344)),
    cavok: raw.cavok,
    qnhHpa: num(m.altim),
    clouds: raw.clouds.length ? raw.clouds
      : (Array.isArray(m.clouds) ? m.clouds : []).filter((c) => COVER[c?.cover] && num(c.base) !== null).map((c) => ({ cover: c.cover, baseFt: c.base, type: null })),
    weather: raw.weather,
    flightCategory: typeof m.fltCat === 'string' ? m.fltCat : null,
    raw: m.rawOb,
  };
}

// Which way does the wind favour? Returns { runway, headwindKt, crosswindKt } for the best direction,
// or null if we don't know the airport's runways or the wind is calm/variable.
export function favouredRunway(station, metar) {
  const rw = RUNWAYS[station];
  if (!rw || !metar || metar.windDir === null || metar.windKt === null || metar.windKt < 3) return null;
  let best = null;
  rw.headings.forEach((heading, i) => {
    const angle = ((metar.windDir - heading) * Math.PI) / 180;
    const headwindKt = Math.round(metar.windKt * Math.cos(angle));
    const crosswindKt = Math.abs(Math.round(metar.windKt * Math.sin(angle)));
    if (!best || headwindKt > best.headwindKt) best = { runway: rw.names[i], headwindKt, crosswindKt, label: rw.label };
  });
  return best;
}

export const describeCover = (code) => COVER[code] ?? code;

// ---- Fetching (through the relay; the API blocks browsers) ----

const cache = new Map(); // station -> { time, result }

async function getText(url) {
  const target = CONFIG.proxyBase ? CONFIG.proxyBase + encodeURIComponent(url) : url;
  const response = await fetch(target);
  if (response.status === 204) return ''; // valid request, no data
  if (response.status === 400 && CONFIG.proxyBase) {
    const text = await response.text();
    // Our relay answers 400 "Not allowed" for hosts it doesn't know yet.
    if (/not allowed/i.test(text)) throw new Error('The relay does not allow aviationweather.gov yet. Update the Cloudflare worker (see proxy/README.md).');
    throw new Error('HTTP 400');
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

// Returns { metar, taf, fetchedAt }. Cached for 10 minutes per station.
export async function getWeather(station, { force = false } = {}) {
  const cached = cache.get(station);
  if (!force && cached && Date.now() - cached.time < REFRESH_MS) return cached.result;
  const ids = encodeURIComponent(station);
  const metarText = await getText(`${API}/metar?ids=${ids}&format=json`);
  const metar = metarText ? parseMetar(JSON.parse(metarText)) : null;
  let taf = null;
  try {
    taf = (await getText(`${API}/taf?ids=${ids}&format=raw`)).trim() || null;
  } catch {
    // The forecast is a bonus; the observation still shows.
  }
  const result = { metar, taf, fetchedAt: Date.now() };
  cache.set(station, { time: Date.now(), result });
  return result;
}

export const WEATHER_REFRESH_MS = REFRESH_MS;
