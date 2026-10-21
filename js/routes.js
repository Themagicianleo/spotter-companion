// routes.js
// Where is a flight going? Looks up the callsign in data/routes.json, built from Virtual Radar
// Server's crowd-sourced "standing data" (CC0) by scripts/build_routes.py. Only routes passing
// near Singapore are included.
//
// Route databases go stale (airlines reuse flight numbers for different routes), so like
// adsb.lol we check the route is "plausible": the aircraft must be within 50 nm, or 20% of the
// leg's length, of the straight (great-circle) line between two consecutive airports.

let routesPromise = null;

// Normalise a callsign the way the standing data does: "SIA0321" -> "SIA321", "EZY0000" -> "EZY0".
// Returns null for callsigns that can't have a route (e.g. a registration like "9VSJA").
export function normalizeCallsign(raw) {
  if (!raw) return null;
  const m = raw.trim().toUpperCase().match(/^([A-Z]{3})(\d[A-Z0-9]*)$/);
  if (!m) return null; // routes are stored against 3-letter ICAO airline codes
  let number = m[2].replace(/^0+/, '');
  if (number === '' || /^[A-Z]+$/.test(number)) number = '0' + number;
  if (!/^(?:\d{1,4}|\d{1,3}[A-Z]|\d{1,2}[A-Z]{2})$/.test(number)) return null;
  return m[1] + number;
}

const EARTH_NM = 3440.065;
const toXyz = (lat, lon) => {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
};
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const angle = (u, v) => Math.acos(Math.max(-1, Math.min(1, dot(u, v))));

// Shortest distance in nm from point p to the great-circle segment a-b (each {lat, lon}).
export function distanceToSegmentNm(p, a, b) {
  const P = toXyz(p.lat, p.lon);
  const A = toXyz(a.lat, a.lon);
  const B = toXyz(b.lat, b.lon);
  let n = [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
  const len = Math.hypot(...n);
  if (len < 1e-12) return angle(P, A) * EARTH_NM; // a and b are the same place
  n = n.map((x) => x / len);
  const cross = Math.asin(Math.max(-1, Math.min(1, dot(P, n))));
  let c = P.map((x, i) => x - Math.sin(cross) * n[i]); // closest point on the full great circle
  const cLen = Math.hypot(...c);
  if (cLen > 1e-12) {
    c = c.map((x) => x / cLen);
    if (Math.abs(angle(A, c) + angle(c, B) - angle(A, B)) < 1e-6) return Math.abs(cross) * EARTH_NM;
  }
  return Math.min(angle(P, A), angle(P, B)) * EARTH_NM; // closest point is an end of the segment
}

// Is the aircraft near any leg of the route? (adsb.lol's threshold: 50 nm or 20% of the leg)
export function isPlausible(position, airports) {
  for (let i = 1; i < airports.length; i++) {
    const legNm = angle(toXyz(airports[i - 1].lat, airports[i - 1].lon), toXyz(airports[i].lat, airports[i].lon)) * EARTH_NM;
    if (distanceToSegmentNm(position, airports[i - 1], airports[i]) <= Math.max(50, 0.2 * legNm)) return true;
  }
  return false;
}

// Returns { callsign, airports: [{code, name, iata, icao, city, country, lat, lon}], plausible }
// or null if there's no route on record. `position` ({lat, lon}) may be null (plausible = null).
export async function lookupRoute(rawCallsign, position) {
  const callsign = normalizeCallsign(rawCallsign);
  if (!callsign) return null;
  routesPromise ??= fetch('data/routes.json')
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .catch((err) => {
      routesPromise = null; // allow a retry later
      throw err;
    });
  const data = await routesPromise;
  const codes = data.routes[callsign];
  if (!codes) return null;
  const airports = codes.split('-').map((code) => ({ code, ...data.airports[code] }));
  const plausible = position && position.lat !== null ? isPlausible(position, airports) : null;
  return { callsign, airports, plausible };
}

// Short label for lists: "FOC → SIN" (IATA codes, falling back to ICAO).
export function shortRoute(route) {
  return route.airports.map((a) => a.iata ?? a.icao ?? a.code).join(' → ');
}
