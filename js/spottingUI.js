// spottingUI.js
// The Spotting drawer (alerts, watchlist, rare types, seen log), the alert pop-ups, and the
// "Log as seen" bar on the flight card. The rules themselves live in spotting.js.
// All text from the feed is inserted with textContent, never innerHTML.

import {
  loadSpotting, saveSpotting, alertReasons, cleanWatchValue, logSighting, logCsv, WATCH_KINDS, DEFAULT_RARE_TYPES,
} from './spotting.js';
import { flagsFor } from './flags.js';

const settings = loadSpotting();
const alerted = new Set(); // "hex|reason" already shown this visit, so each alert pops up once
let selectFn = () => {};
let currentMatches = []; // aircraft with at least one alert reason, right now
let onChange = () => {}; // re-draw the map/list after a setting changes

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const label = (ac) => ac.callsign ?? ac.registration ?? ac.hex;
const save = () => {
  if (!saveSpotting(settings)) note('Your browser would not save this (private mode?). It will be forgotten when you close the page.');
};

export const getSpotting = () => settings;

// ---- Alerts ----

// Called after every update with the full aircraft list: marks each aircraft's alert reasons
// (used by the map and list) and pops up anything new.
export function checkAlerts(aircraft) {
  currentMatches = [];
  for (const ac of aircraft) {
    ac.alerts = alertReasons(ac, settings, flagsFor(ac.hex));
    if (!ac.alerts.length) continue;
    currentMatches.push(ac);
    const fresh = ac.alerts.filter((r) => !alerted.has(`${ac.hex}|${r.key}`));
    if (!fresh.length) continue;
    for (const r of fresh) alerted.add(`${ac.hex}|${r.key}`);
    toast(ac, fresh);
  }
  renderNow();
}

function toast(ac, reasons) {
  const box = document.getElementById('alerts');
  const emergency = reasons.some((r) => r.kind === 'emergency');
  const item = h('button', `alert-toast${emergency ? ' alert-toast--emergency' : ''}`);
  item.type = 'button';
  const title = h('strong', null, label(ac));
  const detail = [ac.typeCode, ac.routeLabel].filter(Boolean).join(' · ');
  item.append(title, h('span', null, reasons.map((r) => r.text).join(' · ')), detail ? h('small', null, detail) : '');
  item.title = 'Show on map';
  item.addEventListener('click', () => {
    selectFn(ac.hex, { fromList: true });
    item.remove();
  });
  box.prepend(item);
  while (box.children.length > 4) box.lastChild.remove(); // keep the stack short
  setTimeout(() => item.remove(), emergency ? 60_000 : 20_000);

  // Optional system notification (phone/desktop), only if the user switched it on and allowed it.
  if (settings.notify && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try {
      new Notification(`${label(ac)}: ${reasons[0].text}`, { body: detail || 'Spotter\'s Companion', tag: ac.hex });
    } catch {
      // Some phones only allow notifications from an installed app; the pop-up still shows.
    }
  }
}

function note(text) {
  const p = document.getElementById('spot-note');
  if (p) p.textContent = text;
}

// "Right now" list in the drawer: everything currently matching an alert rule.
function renderNow() {
  const list = document.getElementById('alert-now');
  if (!list) return;
  if (!currentMatches.length) {
    list.replaceChildren(h('li', 'muted', 'Nothing matching right now.'));
    return;
  }
  list.replaceChildren(...currentMatches.map((ac) => {
    const li = h('li');
    const b = h('button', 'linklike', label(ac));
    b.type = 'button';
    b.addEventListener('click', () => selectFn(ac.hex, { fromList: true }));
    li.append(b, ` ${ac.typeCode ?? ''} · ${ac.alerts.map((r) => r.text).join(', ')}`);
    return li;
  }));
}

// ---- Watchlist and rare types ----

function renderWatch() {
  const list = document.getElementById('watch-list');
  if (!settings.watch.length) {
    list.replaceChildren(h('li', 'muted', 'Empty. Add a registration (9V-SMA), type (A388), callsign prefix (QFA) or hex code.'));
    return;
  }
  list.replaceChildren(...settings.watch.map((entry, i) => {
    const li = h('li', 'chip');
    li.append(h('span', 'chip__kind', WATCH_KINDS[entry.kind]), ` ${entry.value} `);
    const remove = h('button', 'chip__x', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${entry.value}`);
    remove.addEventListener('click', () => {
      settings.watch.splice(i, 1);
      save();
      renderWatch();
      onChange();
    });
    li.append(remove);
    return li;
  }));
}

// ---- Seen log ----

const dateText = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

function renderLog() {
  const entries = Object.entries(settings.log).sort((a, b) => b[1].sightings.at(-1).t - a[1].sightings.at(-1).t);
  const sightings = entries.reduce((n, [, e]) => n + e.sightings.length, 0);
  const types = new Set(entries.map(([, e]) => e.type).filter(Boolean));
  document.getElementById('log-summary').textContent = entries.length
    ? `${entries.length} aircraft · ${types.size} types · ${sightings} sightings`
    : 'Nothing logged yet. Open a plane\'s card and press "Log as seen".';
  const table = document.getElementById('log-table');
  table.replaceChildren();
  if (!entries.length) return;
  const head = table.createTHead().insertRow();
  for (const t of ['Registration', 'Type', 'Airline', 'Last seen', 'Times', '']) head.append(h('th', null, t));
  const body = table.createTBody();
  for (const [hex, e] of entries) {
    const tr = body.insertRow();
    tr.insertCell().textContent = e.reg ?? hex;
    tr.insertCell().textContent = e.type ?? '—';
    tr.insertCell().textContent = e.airline ?? '—';
    tr.insertCell().textContent = dateText(e.sightings.at(-1).t);
    tr.insertCell().textContent = e.sightings.length;
    const remove = h('button', 'chip__x', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${e.reg ?? hex} from the log`);
    remove.addEventListener('click', () => {
      if (!confirm(`Remove ${e.reg ?? hex} and its ${e.sightings.length} sighting(s) from your log?`)) return;
      delete settings.log[hex];
      save();
      renderLog();
      refreshCardBar();
    });
    tr.insertCell().append(remove);
  }
}

function downloadLog() {
  const blob = new Blob([logCsv(settings.log)], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `my-spotting-log-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---- Flight card bar: alert reasons + "Log as seen" ----

let cardAc = null;
let cardBar = null;

export function renderCardBar(ac, container) {
  cardAc = ac;
  cardBar = container;
  container.replaceChildren();
  for (const r of ac.alerts ?? []) container.append(h('span', `alert-chip alert-chip--${r.kind}`, r.text));
  const entry = settings.log[ac.hex];
  const button = h('button', entry ? 'log-btn log-btn--done' : 'log-btn', entry ? 'Log again' : '✓ Log as seen');
  button.type = 'button';
  button.addEventListener('click', () => {
    logSighting(settings, ac);
    save();
    renderLog();
    renderCardBar(ac, container);
  });
  container.append(button);
  if (entry) {
    const first = dateText(entry.sightings[0].t);
    const times = entry.sightings.length;
    container.append(h('span', 'log-note', `In your log since ${first}${times > 1 ? ` · seen ${times}×` : ''}`));
  }
}

function refreshCardBar() {
  if (cardAc && cardBar?.isConnected) renderCardBar(cardAc, cardBar);
}

// ---- Set-up ----

export function initSpotting({ select, changed }) {
  selectFn = select;
  onChange = changed;

  // Alert switches
  for (const key of Object.keys(settings.alertOn)) {
    const box = document.getElementById(`alert-${key}`);
    if (!box) continue;
    box.checked = settings.alertOn[key];
    box.addEventListener('change', () => {
      settings.alertOn[key] = box.checked;
      save();
      onChange();
    });
  }
  const notify = document.getElementById('alert-notify');
  notify.checked = settings.notify;
  notify.addEventListener('change', async () => {
    settings.notify = notify.checked;
    if (notify.checked) {
      if (!('Notification' in window)) {
        note('This browser has no notifications; you\'ll still get the pop-ups on the map.');
      } else if (Notification.permission !== 'granted') {
        const answer = await Notification.requestPermission();
        if (answer !== 'granted') {
          settings.notify = false;
          notify.checked = false;
          note('Notifications were not allowed. You can change that in the browser\'s site settings.');
        }
      }
    }
    save();
  });

  // Watchlist form
  const form = document.getElementById('watch-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const kind = form.elements['watch-kind'].value;
    const value = cleanWatchValue(kind, form.elements['watch-value'].value);
    if (!value) return;
    if (!settings.watch.some((w) => w.kind === kind && w.value === value)) settings.watch.push({ kind, value });
    form.elements['watch-value'].value = '';
    save();
    renderWatch();
    onChange();
  });

  // Rare types: one comma-separated box
  const rare = document.getElementById('rare-types');
  const showRare = () => { rare.value = settings.rareTypes.join(', '); };
  showRare();
  rare.addEventListener('change', () => {
    settings.rareTypes = [...new Set(rare.value.toUpperCase().split(/[\s,]+/).map((t) => t.replace(/[^A-Z0-9]/g, '')).filter(Boolean))];
    showRare();
    save();
    onChange();
  });
  document.getElementById('rare-reset').addEventListener('click', () => {
    settings.rareTypes = [...DEFAULT_RARE_TYPES];
    showRare();
    save();
    onChange();
  });

  document.getElementById('log-export').addEventListener('click', downloadLog);
  renderWatch();
  renderLog();
  renderNow();
}
