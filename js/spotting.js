// spotting.js
// The spotter's own data: a watchlist, which alerts to show, and a log of aircraft you've seen.
// Everything is kept in this browser only (localStorage). Nothing is sent anywhere.
// The functions at the top are pure (no page access), so they can be tested with Node.

import { cell } from './csv.js';

const KEY = 'spotters-companion:spotting';

// A starter list of types that are big, old or unusual; edit it in the Spotting panel.
// This is a personal choice, not data: "rare" depends on where you spot.
export const DEFAULT_RARE_TYPES = [
  'A124', 'AN12', 'AN22', 'A225', 'IL76', 'IL62', 'A3ST', 'A337', 'BLCF', 'B742', 'B743', 'B74S', 'B74R',
  'A342', 'A343', 'A345', 'A346', 'MD11', 'DC10', 'B762', 'B752', 'B753', 'C17', 'C5M', 'A400', 'K35R', 'E3TF', 'CONC',
];

// Squawk codes every pilot and spotter knows (ICAO standard).
export const SPECIAL_SQUAWKS = { 7500: 'hijack', 7600: 'radio failure', 7700: 'emergency' };

export const WATCH_KINDS = {
  reg: 'Registration',
  type: 'Type code',
  callsign: 'Callsign / airline prefix',
  hex: 'Hex code',
};

export function defaultSpotting() {
  return {
    watch: [], // [{ kind, value }]
    rareTypes: [...DEFAULT_RARE_TYPES],
    alertOn: { watch: true, rare: true, military: true, interesting: true, emergency: true },
    notify: false, // also show phone/desktop notifications (needs the browser's permission)
    log: {}, // hex -> { reg, type, typeName, airline, sightings: [{ t, callsign, route }] }
  };
}

// Tidy what someone typed: "9v-ska " -> "9V-SKA", "a 388" -> "A388".
export function cleanWatchValue(kind, value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (kind === 'hex') return v.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6);
  if (kind === 'reg') return v.replace(/[^A-Z0-9-]/g, '');
  return v.replace(/[^A-Z0-9]/g, '');
}

const plainReg = (r) => String(r ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function watchMatches(ac, entry) {
  if (!entry?.value) return false;
  switch (entry.kind) {
    case 'reg': return !!ac.registration && plainReg(ac.registration) === plainReg(entry.value);
    case 'type': return ac.typeCode === entry.value;
    case 'callsign': return !!ac.callsign && ac.callsign.toUpperCase().startsWith(entry.value);
    case 'hex': return ac.hex === entry.value;
    default: return false;
  }
}

// Why this aircraft deserves attention: [{ key, kind, text }]. key is unique per reason, so
// each alert pops up once per aircraft. flags = { military, interesting } from flags.js.
export function alertReasons(ac, settings, flags = { military: false, interesting: false }) {
  const reasons = [];
  const on = settings.alertOn;
  if (on.emergency) {
    const label = SPECIAL_SQUAWKS[ac.squawk];
    if (label) reasons.push({ key: `sq${ac.squawk}`, kind: 'emergency', text: `Squawk ${ac.squawk} (${label})` });
    else if (ac.emergency && ac.emergency !== 'none') reasons.push({ key: `em-${ac.emergency}`, kind: 'emergency', text: `Emergency: ${ac.emergency}` });
  }
  if (on.watch) {
    for (const entry of settings.watch) {
      if (watchMatches(ac, entry)) reasons.push({ key: `w-${entry.kind}-${entry.value}`, kind: 'watch', text: `Watchlist: ${entry.value}` });
    }
  }
  if (on.rare && ac.typeCode && settings.rareTypes.includes(ac.typeCode)) {
    reasons.push({ key: `r-${ac.typeCode}`, kind: 'rare', text: `Rare type: ${ac.typeCode}` });
  }
  if (on.military && flags.military) reasons.push({ key: 'mil', kind: 'military', text: 'Military (database flag)' });
  if (on.interesting && flags.interesting) reasons.push({ key: 'int', kind: 'interesting', text: 'Interesting (database flag)' });
  return reasons;
}

// ---- Seen log ----

// Add a sighting of this aircraft to the log (returns the updated entry).
export function logSighting(settings, ac, now = Date.now()) {
  const entry = settings.log[ac.hex] ?? { reg: null, type: null, typeName: null, airline: null, sightings: [] };
  entry.reg = ac.registration ?? entry.reg;
  entry.type = ac.typeCode ?? entry.type;
  entry.typeName = ac.typeDescription ?? entry.typeName;
  entry.airline = ac.airline?.name ?? entry.airline;
  entry.sightings.push({ t: now, callsign: ac.callsign ?? null, route: ac.routeLabel ?? null });
  if (entry.sightings.length > 100) entry.sightings.splice(0, entry.sightings.length - 100);
  settings.log[ac.hex] = entry;
  return entry;
}

export function logCsv(log) {
  const header = ['date', 'time', 'registration', 'type', 'type_description', 'airline', 'callsign', 'route', 'hex'];
  const lines = [header.join(',')];
  const rows = [];
  for (const [hex, e] of Object.entries(log)) {
    for (const s of e.sightings) rows.push([s.t, e, s, hex]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  for (const [t, e, s, hex] of rows) {
    const d = new Date(t);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const time = d.toTimeString().slice(0, 5);
    lines.push([date, time, e.reg, e.type, e.typeName, e.airline, s.callsign, s.route, hex].map(cell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ---- Storage ----

export function loadSpotting() {
  const settings = defaultSpotting();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.watch)) settings.watch = saved.watch.filter((w) => WATCH_KINDS[w?.kind] && w.value);
      if (Array.isArray(saved.rareTypes)) settings.rareTypes = saved.rareTypes.filter((t) => typeof t === 'string');
      Object.assign(settings.alertOn, saved.alertOn);
      settings.notify = saved.notify === true;
      if (saved.log && typeof saved.log === 'object') settings.log = saved.log;
    }
  } catch {
    // Storage blocked or corrupted: start fresh (nothing is lost on the page itself).
  }
  return settings;
}

// Returns false if the browser wouldn't save (private mode, storage full).
export function saveSpotting(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
