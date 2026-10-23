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

// ---- Import: read a CSV made by logCsv() (e.g. exported from the other address of this app) ----

// Split CSV text into rows of cells (handles "quoted, cells", doubled "" quotes and CRLF).
export function parseCsv(text) {
  const rows = [];
  let row = [], cellText = '', quoted = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cellText += '"'; i++; }
      else if (c === '"') quoted = false;
      else cellText += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cellText); cellText = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cellText); rows.push(row); row = []; cellText = '';
    } else cellText += c;
  }
  if (cellText !== '' || row.length) { row.push(cellText); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}

// Adds the sightings in `csvText` to settings.log. Sightings already in the log (same aircraft,
// same minute) are skipped. Returns { added, aircraft, skipped } or throws if it isn't our format.
export function importLogCsv(settings, csvText) {
  const rows = parseCsv(csvText);
  const header = rows.shift() ?? [];
  const col = Object.fromEntries(header.map((name, i) => [name.trim(), i]));
  for (const needed of ['date', 'time', 'registration', 'hex']) {
    if (!(needed in col)) throw new Error('This file is not a SkyWatch log (missing a "' + needed + '" column).');
  }
  // Undo logCsv's spreadsheet safety: a leading ' was added before = + - @.
  const get = (r, name) => {
    const v = (col[name] === undefined ? '' : r[col[name]] ?? '').trim();
    return (/^'[=+\-@]/.test(v) ? v.slice(1) : v) || null;
  };
  let added = 0, skipped = 0;
  const touched = new Set();
  // The export keeps times to the minute, so "already in the log" means: same aircraft, same minute,
  // compared with what was in the log BEFORE this import (two rows of the file may share a minute).
  const minute = (t) => Math.floor(t / 60e3);
  const before = Object.fromEntries(Object.entries(settings.log).map(([hex, e]) => [hex, new Set(e.sightings.map((x) => minute(x.t)))]));
  for (const r of rows) {
    const hex = (get(r, 'hex') ?? '').toLowerCase();
    const date = get(r, 'date'), time = get(r, 'time') ?? '00:00';
    const t = new Date(`${date}T${time}`).getTime(); // local time, as exported
    if (!/^[0-9a-f]{6}$/.test(hex) || !Number.isFinite(t)) { skipped++; continue; }
    const entry = settings.log[hex] ?? { reg: null, type: null, typeName: null, airline: null, sightings: [] };
    entry.reg ??= get(r, 'registration');
    entry.type ??= get(r, 'type');
    entry.typeName ??= get(r, 'type_description');
    entry.airline ??= get(r, 'airline');
    if (before[hex]?.has(minute(t))) { skipped++; continue; }
    entry.sightings.push({ t, callsign: get(r, 'callsign'), route: get(r, 'route') });
    entry.sightings.sort((a, b) => a.t - b.t);
    settings.log[hex] = entry;
    touched.add(hex);
    added++;
  }
  return { added, aircraft: touched.size, skipped };
}
