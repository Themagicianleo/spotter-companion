// statsUI.js
// The Stats drawer: what's flying right now, since you opened the page, over the last 24 hours
// (from your recorder, if set up), and your own spotting log.
// Charts are plain HTML bars: one colour (single series), every value written as text too.

import { CONFIG } from './config.js';
import { topCounts, airlineCode, SessionTally, fillHours } from './stats.js';
import { airlineFor } from './airlines.js';

const session = new SessionTally();
let panel;
let getAircraft = () => [];
let getLog = () => ({});
let recorderStats = null; // last answer from /stats, or { error }
let recorderLoadedAt = 0;
let recorderLoading = false;

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const airlineName = (code) => airlineFor(`${code}1`)?.name ?? null;

// Horizontal bars: label | bar | number. rows = [{ key, count, other? }]
function barList(title, rows, { total = null, describe = null } = {}) {
  const box = h('div', 'stat-block');
  box.append(h('h4', null, title));
  if (!rows.length) {
    box.append(h('p', 'muted', 'No data yet.'));
    return box;
  }
  const max = Math.max(...rows.map((r) => r.count));
  const list = h('ol', 'bars');
  for (const r of rows) {
    const li = h('li', r.other ? 'bars__row bars__row--other' : 'bars__row');
    const name = describe && !r.other ? describe(r.key) : null;
    const labelEl = h('span', 'bars__label', String(r.key));
    if (name) labelEl.title = name;
    const track = h('span', 'bars__track');
    const fill = h('span', 'bars__fill');
    fill.style.width = `${Math.max((r.count / max) * 100, 2)}%`;
    track.append(fill);
    li.title = `${r.key}${name ? ` (${name})` : ''}: ${r.count}${total ? ` of ${total}` : ''}`;
    li.append(labelEl, track, h('span', 'bars__value', String(r.count)));
    list.append(li);
  }
  box.append(list);
  return box;
}

function tiles(pairs) {
  const box = h('div', 'tiles stat-tiles');
  for (const [label, value] of pairs) {
    const t = h('div', 'tile');
    t.append(h('span', 'tile__label', label), h('span', 'tile__value', String(value)));
    box.append(t);
  }
  return box;
}

// Columns for aircraft per hour (local time labels every 3 hours, exact numbers on hover/tap).
function hourChart(perHour) {
  const box = h('div', 'stat-block');
  box.append(h('h4', null, 'Aircraft per hour'));
  const max = Math.max(1, ...perHour.map((p) => p.aircraft));
  const chart = h('div', 'cols');
  chart.setAttribute('role', 'img');
  const peak = perHour.reduce((best, p) => (p.aircraft > best.aircraft ? p : best), perHour[0]);
  chart.setAttribute('aria-label', `Aircraft per hour over the last ${perHour.length} hours; busiest ${new Date(peak.hour * 1000).getHours()}:00 with ${peak.aircraft}`);
  perHour.forEach((p, i) => {
    const time = new Date(p.hour * 1000);
    const col = h('div', 'cols__col');
    col.title = `${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${p.aircraft} aircraft`;
    const bar = h('span', 'cols__bar');
    bar.style.height = `${(p.aircraft / max) * 100}%`;
    col.append(bar, h('span', 'cols__label', i % 3 === 0 ? String(time.getHours()).padStart(2, '0') : ''));
    chart.append(col);
  });
  box.append(chart, h('p', 'muted', `Busiest hour: ${String(new Date(peak.hour * 1000).getHours()).padStart(2, '0')}:00 (${peak.aircraft} aircraft). Hover or tap a column for its number.`));
  return box;
}

async function loadRecorderStats() {
  if (!CONFIG.recorderBase || recorderLoading || Date.now() - recorderLoadedAt < 5 * 60 * 1000) return;
  recorderLoading = true;
  try {
    const response = await fetch(`${CONFIG.recorderBase}/stats?hours=24`);
    const body = await response.json().catch(() => null);
    if (response.status === 404 || !body) recorderStats = { error: 'Your worker is older than this page: update it to get 24-hour stats (see proxy/README.md).' };
    else if (!response.ok || body.error) recorderStats = { error: body.error ?? `HTTP ${response.status}` };
    else recorderStats = body;
  } catch {
    recorderStats = { error: 'Could not reach your recorder (it only answers the GitHub Pages site).' };
  } finally {
    recorderLoadedAt = Date.now();
    recorderLoading = false;
    render();
  }
}

function render() {
  if (!panel || panel.hidden) return;
  const now = getAircraft();
  const parts = [h('h2', null, 'Stats')];

  // ---- Right now ----
  const airborne = now.filter((a) => !a.onGround).length;
  parts.push(h('h3', null, 'Right now (your search area)'));
  parts.push(tiles([
    ['In the air', airborne],
    ['On the ground', now.length - airborne],
    ['Types', new Set(now.map((a) => a.typeCode).filter(Boolean)).size],
    ['Airlines', new Set(now.map((a) => airlineCode(a.callsign)).filter(Boolean)).size],
  ]));
  const grid = h('div', 'stat-grid');
  grid.append(
    barList('Types', topCounts(now, (a) => a.typeCode), { total: now.length }),
    barList('Airlines', topCounts(now, (a) => airlineCode(a.callsign)), { total: now.length, describe: airlineName }),
  );
  parts.push(grid);

  // ---- This visit ----
  const visit = session.list;
  const minutes = Math.max(1, Math.round((Date.now() - session.started) / 60000));
  parts.push(h('h3', null, `Since you opened the page (${minutes} min)`));
  parts.push(h('p', 'muted', `${visit.length} different aircraft seen.`));
  const grid2 = h('div', 'stat-grid');
  grid2.append(
    barList('Types', topCounts(visit, (a) => a.type), { total: visit.length }),
    barList('Airlines', topCounts(visit, (a) => a.airline), { total: visit.length, describe: airlineName }),
  );
  parts.push(grid2);

  // ---- Last 24 hours, from the recorder ----
  parts.push(h('h3', null, 'Last 24 hours (your recorder)'));
  if (!CONFIG.recorderBase) {
    parts.push(h('p', 'muted', 'Needs the recorder (proxy/README.md).'));
  } else if (!recorderStats) {
    parts.push(h('p', 'muted', 'Loading…'));
  } else if (recorderStats.error) {
    parts.push(h('p', 'muted', recorderStats.error));
  } else {
    const s = recorderStats;
    const nowS = Math.floor(Date.now() / 1000);
    parts.push(h('p', 'muted', `${s.uniqueAircraft.toLocaleString('en')} different aircraft within ${s.area.radiusNm} nm of the recorder's center.`));
    if (s.perHour.length) parts.push(hourChart(fillHours(s.perHour, Math.max(s.oldest ?? nowS, nowS - 23 * 3600), nowS)));
    const grid3 = h('div', 'stat-grid');
    grid3.append(
      barList('Types', s.types.map((r) => ({ key: r.type, count: r.aircraft }))),
      barList('Airlines', s.airlines.map((r) => ({ key: r.airline, count: r.aircraft })), { describe: airlineName }),
    );
    parts.push(grid3);
    if (!s.detailsSince) parts.push(h('p', 'muted', 'Types and airlines appear once the updated worker has recorded for a while.'));
    else if (s.detailsSince - (s.oldest ?? s.detailsSince) > 3600) {
      parts.push(h('p', 'muted', `Types and airlines only since ${new Date(s.detailsSince * 1000).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })} (when the worker started recording them).`));
    }
  }

  // ---- Your log ----
  const log = Object.values(getLog());
  parts.push(h('h3', null, 'Your spotting log'));
  if (!log.length) {
    parts.push(h('p', 'muted', 'Nothing logged yet. Press "Log as seen" on a flight card.'));
  } else {
    parts.push(tiles([
      ['Aircraft', log.length],
      ['Types', new Set(log.map((e) => e.type).filter(Boolean)).size],
      ['Airlines', new Set(log.map((e) => e.airline).filter(Boolean)).size],
      ['Sightings', log.reduce((n, e) => n + e.sightings.length, 0)],
    ]));
    parts.push(barList('Your most-logged types', topCounts(log, (e) => e.type)));
  }
  parts.push(h('p', 'credits', 'Counts come from the live feed (adsb.lol, ODbL) and only include aircraft that broadcast ADS-B/MLAT positions.'));
  panel.replaceChildren(...parts);
}

export function initStats(element, { aircraft, log }) {
  panel = element;
  getAircraft = aircraft;
  getLog = log;
}

// Called after every update (cheap when the drawer is closed).
export function updateStats(list) {
  session.add(list);
  if (panel && !panel.hidden) {
    render();
    loadRecorderStats();
  }
}

export function showStats() {
  render();
  loadRecorderStats();
}
