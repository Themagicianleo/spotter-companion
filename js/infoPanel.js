// infoPanel.js
// The flight card (aircraft info panel), shown when you click a plane. Every value is labelled with where it came from:
//   LIVE  - the live ADS-B feed (adsb.lol etc.), right now
//   DB    - our aircraft database (tar1090-db), matched by hex code
//   TYPE  - our type table (data/aircraft_types.json), matched by ICAO type code
// Missing values show "Unknown". All text is set with textContent, never innerHTML,
// so nothing from the internet can inject HTML into the page.

import * as fmt from './format.js';
import { lookupAircraft, lookupType, getDbMeta, lookupVariant } from './aircraftDb.js';
import { getPhoto } from './photos.js';
import { getCommonsPhotos } from './commons.js';
import { openGallery } from './gallery.js';
import { getTrack } from './track.js';
import { lookupRoute, routeProgress, routeLengthNm, remainingNm, estimateArrival, findTakeoff, distanceNm, currentLegEnd } from './routes.js';

let panel;
let liveSection;
let detailsSection;
let photoSection;
let routeSection;
let currentRoute = null; // the route shown on the card (for the live times), or null
let routeTimesEl = null; // where the departure / arrival lines go
let currentHex = null;
// Preview (the compact card, like flight-tracker apps): what it shows is filled in as lookups finish.
let previewEl;
let lastAc = null; // the aircraft as of the latest update
let pv = {}; // { route (undefined = loading, null = none), photo, photoEl, commons, model, reg }
let stripEl; // "More photos" strip in the full card
let mode = 'preview'; // 'preview' or 'full' ("More info")
let following = false;
let liveSourceName = 'live feed';
let spotBar; // alert chips + "Log as seen" (filled in by spottingUI.js)
let cardBarRenderer = null;

// spottingUI.js hands us a function that fills the bar under the card's title.
export function setCardBar(fn) {
  cardBarRenderer = fn;
}

// --- tiny DOM helpers to keep the code below readable ---
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function sourceTag(kind, title) {
  const tag = h('span', `src src--${kind.toLowerCase()}`, kind);
  tag.title = title;
  return tag;
}
// One row: label | value | source tag (or "—" when the value is unknown)
function row(table, label, value, tag) {
  const tr = table.insertRow();
  tr.insertCell().textContent = label;
  tr.insertCell().textContent = fmt.text(value);
  const cell = tr.insertCell();
  if (value === null || value === undefined || value === '') cell.textContent = '—';
  else cell.append(tag);
}
function safeLink(url, text) {
  const a = h('a', null, text);
  if (/^https?:\/\//.test(url)) {
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
  }
  return a;
}

// Search link on airfleets.net (history, previous operators, delivery date…). Only letters, digits and '-'
// are kept, so nothing odd can end up in the URL.
export function airfleetsUrl(registration) {
  const reg = String(registration ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return reg ? `https://www.airfleets.net/recherche/?key=${encodeURIComponent(reg)}` : null;
}

export function initInfoPanel(element, providerName) {
  panel = element;
  liveSourceName = providerName;
  const header = h('div', 'info__header');
  const titles = h('div');
  titles.append(h('h2', 'info__title', 'Aircraft info'), h('div', 'info__subtitle', ''));
  header.append(titles);
  const close = h('button', 'info__close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close aircraft info');
  close.addEventListener('click', closeInfoPanel);
  header.append(close);
  previewEl = h('section', 'pv');
  stripEl = h('section', 'info__strip');
  spotBar = h('div', 'info__spotbar');
  liveSection = h('section', 'info__section');
  detailsSection = h('section', 'info__section');
  photoSection = h('section', 'info__photo');
  routeSection = h('section', 'info__section');
  // Card order: preview (always), then with "More info": spotting bar, photo, route, live tiles, details.
  // The old header stays for screen readers' title only; the preview shows the same things.
  panel.append(header, previewEl, spotBar, photoSection, stripEl, routeSection, liveSection, detailsSection);
  setMode('preview');
}

export function closeInfoPanel() {
  panel.hidden = true;
  currentHex = null;
  if (following) toggleFollow(false);
  document.body.classList.remove('card-open', 'card-full'); // lets the CSS move map controls back
}

export function isOpenFor(hex) {
  return !panel.hidden && currentHex === hex;
}

// Open the panel for one aircraft (the normalized object from api.js).
export async function openInfoPanel(ac) {
  if (currentHex !== ac.hex && following) toggleFollow(false);
  currentHex = ac.hex;
  lastAc = ac;
  pv = { route: undefined, photo: undefined, photoEl: null, commons: undefined, model: null, reg: ac.registration };
  stripEl.replaceChildren();
  setMode('preview'); // a new plane always starts as the short preview
  panel.hidden = false;
  panel.scrollTop = 0;
  document.body.classList.add('card-open');
  panel.querySelector('.info__title').textContent = ac.callsign ?? ac.registration ?? ac.hex;
  panel.querySelector('.info__subtitle').textContent = [ac.airline?.name, ac.registration, ac.typeCode].filter(Boolean).join(' · ');
  updateLive(ac);
  detailsSection.replaceChildren(h('p', 'info__loading', 'Looking up aircraft and type data…'));
  showPhoto(ac.hex); // runs alongside the lookups below; no need to wait for it
  showRoute(ac);

  // Load the database entry and the type info at the same time.
  const [dbResult, metaResult] = await Promise.allSettled([lookupAircraft(ac.hex), getDbMeta()]);
  const db = dbResult.status === 'fulfilled' ? dbResult.value : null;
  const typeCode = db?.typeCode ?? ac.typeCode;
  // The exact model can come from OpenSky or from the VRS standing data; try both.
  const [typeResult, variantResult] = await Promise.allSettled([
    lookupType(typeCode),
    lookupVariant(db?.osModel).then((v) => v ?? lookupVariant(db?.vrsModel)),
  ]);
  const type = typeResult.status === 'fulfilled' ? typeResult.value : null;
  const variant = variantResult.status === 'fulfilled' ? variantResult.value : null;

  if (currentHex !== ac.hex) return; // user clicked another plane while we were loading
  // Fill in the subtitle from the database if the live feed didn't have it.
  const subtitle = [ac.airline?.name, db?.registration ?? ac.registration, type?.model ?? db?.typeCode ?? ac.typeCode].filter(Boolean).join(' · ');
  if (subtitle) panel.querySelector('.info__subtitle').textContent = subtitle;
  // Preview: the most exact model name we have, and the registration (database first).
  pv.model = db?.osModel ?? db?.vrsModel ?? type?.model ?? db?.typeDescription ?? ac.typeDescription ?? null;
  pv.reg = db?.registration ?? ac.registration ?? null;
  renderPreview(lastAc ?? ac);
  loadMorePhotos(ac.hex, pv.reg);
  renderDetails(ac, db, dbResult.status === 'rejected', metaResult.value, type, typeResult.status === 'rejected', variant);
}

// Pick the first known value and remember which source it came from.
function pick(...candidates) {
  for (const [value, tag] of candidates) if (value !== null && value !== undefined && value !== '') return [value, tag];
  return [null, null];
}

// variant = { variant: <row of data/aircraft_variants.json>, matchedFrom } or null
function renderDetails(ac, db, dbFailed, meta, type, typeFailed, variant) {
  const builtOn = meta?.builtAt ? `, copied ${meta.builtAt.slice(0, 10)}` : '';
  const LIVE = () => sourceTag('LIVE', `Live feed (${liveSourceName})`);
  const DB = () => sourceTag('DB', `tar1090-db (Mictronics aircraft database)${builtOn}`);
  const OSN = () => sourceTag('OSN', `OpenSky Network aircraft database${builtOn}`);
  const VRS = () => sourceTag('VRS', `Virtual Radar Server standing data (crowd-sourced, CC0)${builtOn}`);
  const TCDS = () => sourceTag('TCDS', 'Official type certificate data sheet (see sources below)');
  const TYPE = () => sourceTag('TYPE', 'Type table (data/aircraft_types.json)');

  const parts = [];

  // ---- This aircraft ----
  parts.push(h('h3', null, 'This aircraft'));
  if (dbFailed) parts.push(h('p', 'info__warn', 'The aircraft database could not be loaded, so only live-feed values are shown.'));
  else if (!db) parts.push(h('p', 'info__note', 'Not in our database (it only holds the Boeing/Airbus types in the type table).'));

  const t1 = h('table', 'info__table');
  // The live feed's registration/type also come from the provider's own database.
  const [reg, regTag] = pick([db?.registration, DB()], [ac.registration, LIVE()]);
  const [code, codeTag] = pick([db?.typeCode, DB()], [db?.osTypeCode, OSN()], [ac.typeCode, LIVE()]);
  const [model, modelTag] = pick([type?.model, TYPE()], [db?.typeDescription, DB()], [ac.typeDescription, LIVE()]);
  const [exact, exactTag] = pick([db?.osModel, OSN()], [db?.vrsModel, VRS()]);

  // Show the rows we know; list the missing ones on one line instead of a stack of "Unknown"s.
  const missing = [];
  const known = (label, value, tag, missingName = label.toLowerCase()) => {
    if (value === null || value === undefined || value === '') missing.push(missingName);
    else row(t1, label, value, tag);
  };
  known('Registration', reg, regTag);
  known('ICAO type code', code, codeTag, 'type code');
  known('Type', model, modelTag);
  known('Exact model', exact, exactTag);
  known('Manufacturer', type?.manufacturer, TYPE());
  parts.push(t1);
  // airfleets.net has no open data, so we only link to its own search page for this registration.
  const regUrl = airfleetsUrl(reg);
  if (regUrl) {
    const more = h('p', 'info__more');
    const a = safeLink(regUrl, `More about ${reg} on airfleets.net ↗`);
    a.className = 'info__more-link';
    more.append(a);
    parts.push(more);
  }
  if (missing.length) parts.push(h('p', 'info__note', `Unknown (not in our databases): ${missing.join(', ')}.`));
  // Crowd-sourced databases sometimes disagree; say so rather than silently picking one.
  const disagree = [];
  const differs = (a, b) => a && b && a.replace(/[\s-]/g, '').toUpperCase() !== b.replace(/[\s-]/g, '').toUpperCase();
  if (differs(db?.osModel, db?.vrsModel)) disagree.push(`model: OpenSky says ${db.osModel}, VRS says ${db.vrsModel}`);
  if (disagree.length) parts.push(h('p', 'info__warn', `The databases disagree on the ${disagree.join('; ')}.`));

  // ---- Engines ----
  parts.push(h('h3', null, 'Engines'));
  const engineTable = h('table', 'info__table');
  const single = type && type.engineOptions.length === 1 && type.engineOptions[0].verified ? type.engineOptions[0] : null;
  if (variant) {
    const v = variant.variant;
    row(engineTable, `Certified for ${v.model}`, `${v.engineCount ?? '?'} × ${v.engines.join(' or ')}`, TCDS());
    if (db?.osEngines) row(engineTable, 'Recorded for this aircraft', db.osEngines, OSN());
    parts.push(engineTable);
    if (variant.matchedFrom) parts.push(h('p', 'info__note', `The database records the model as ${variant.matchedFrom}; matched to the certified model ${v.model}.`));
    if (v.engines.length > 1) {
      parts.push(h('p', 'info__note', `The certificate lists ${v.engines.length} versions for this model (thrust ratings or modifications). The database doesn't say which one this aircraft has.`));
    }
    if (v.note) parts.push(h('p', 'info__note', v.note));
    const src = h('details', 'info__sources');
    src.append(h('summary', null, 'Certificate source'));
    const ul = h('ul');
    for (const s of v.source) {
      const li = h('li');
      li.append(safeLink(s.url, s.name), s.line ? ` (text line ${s.line})` : '');
      ul.append(li);
    }
    src.append(ul);
    parts.push(src);
  } else if (single) {
    row(engineTable, 'Engine', `${type.engineCount} × ${single.maker} ${single.model}`, TYPE());
    if (db?.osEngines) row(engineTable, 'Recorded for this aircraft', db.osEngines, OSN());
    parts.push(engineTable);
    parts.push(h('p', 'info__note', 'This is the only engine offered for this aircraft type, so it applies to this aircraft.'));
  } else {
    if (db?.osEngines) {
      row(engineTable, 'Recorded for this aircraft', db.osEngines, OSN());
      parts.push(engineTable);
    }
    const why = exact ? `The exact model "${exact}" isn't in our certificate table` : 'The exact model of this aircraft is unknown';
    parts.push(h('p', 'info__note', `${why}, so only the engine options for the type are shown below.`));
  }

  // All options for the type: open by default only when we couldn't narrow it down.
  if (typeFailed) {
    parts.push(h('p', 'info__warn', 'The type table could not be loaded.'));
  } else if (!type) {
    parts.push(h('p', 'info__note', code ? `Type ${code} is not in our type table (it covers common Boeing and Airbus airliners).` : 'Type unknown.'));
  } else {
    const box = h('details', 'info__options');
    box.open = !variant && !single;
    box.append(h('summary', null, `Engine options for the ${type.icao} type (${type.engineOptions.length})`));
    const list = h('ul', 'info__engines');
    for (const e of type.engineOptions) {
      const li = h('li', null, `${e.maker} ${e.model}`);
      if (!e.verified) li.append(' ', h('span', 'badge badge--warn', 'unconfirmed'));
      list.append(li);
    }
    box.append(list);
    const status = { 'verified-secondary': 'Checked against cited sources (via search excerpts).', 'partly-unverified': 'Some options are unconfirmed.', unverified: 'Unconfirmed: please treat with caution.' };
    box.append(h('p', 'info__note', `Number of engines: ${type.engineCount}. Verification: ${status[type.verification] ?? type.verification}`));
    if (type.notes) box.append(h('p', 'info__note', type.notes));
    const ul = h('ul', 'info__sources');
    for (const s of type.source) {
      const li = h('li');
      li.append(safeLink(s.url, s.name));
      ul.append(li);
    }
    box.append(ul);
    parts.push(box);
  }

  // ---- Where the data comes from ----
  const legend = h('p', 'info__legend');
  legend.append(LIVE(), ` live feed (${liveSourceName}) · `, DB(), ' tar1090-db · ', OSN(), ' OpenSky aircraft database · ',
    TCDS(), ' official type certificate · ', VRS(), ' VRS standing data · ', sourceTag('ROUTE', 'Route database'), ' route database · ', TYPE(), ' type table');
  parts.push(legend);
  parts.push(h('p', 'info__note',
    'Database entries are community-maintained and can be outdated or wrong.'));

  detailsSection.replaceChildren(...parts);
}

// Flight route from data/routes.json (Virtual Radar Server standing data, crowd-sourced).
async function showRoute(ac) {
  routeSection.replaceChildren();
  currentRoute = null;
  routeTimesEl = null;
  if (!ac.callsign) return;
  let route;
  try {
    route = await lookupRoute(ac.callsign, ac.lat === null ? null : ac);
  } catch {
    pv.route = null; // routes file unavailable: no route in the preview either
    renderPreview(lastAc ?? ac);
    return; // and leave the section empty
  }
  if (currentHex !== ac.hex) return;
  const ROUTE = () => sourceTag('ROUTE', 'Virtual Radar Server standing data (crowd-sourced, CC0)');
  const parts = [h('h3', null, 'Route')];
  pv.route = route ?? null;
  renderPreview(lastAc ?? ac);
  if (!route) {
    parts.push(h('p', 'info__note', `No route on record for ${ac.callsign} (only routes passing near Singapore are included).`));
    routeSection.replaceChildren(...parts);
    return;
  }
  // Big airport codes ("FOC ✈ SIN") with city names, any stops, and a progress bar.
  const from = route.airports[0];
  const to = route.airports.at(-1);
  const code = (a) => a.iata ?? a.icao ?? a.code;
  const end = (a, cls, labelText) => {
    const box = h('div', `route__end ${cls}`);
    const c = h('div', 'route__code', code(a));
    c.title = `${labelText}: ${a.name ?? a.code} (${[a.iata, a.icao].filter(Boolean).join(' / ') || a.code})`;
    box.append(c, h('div', 'route__city', a.city ?? a.name ?? ''));
    return box;
  };
  const block = h('div', 'route');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '26');
  icon.setAttribute('height', '26');
  icon.classList.add('route__icon');
  icon.innerHTML = '<path d="M12 2c.8 0 1.3.9 1.3 2v5.2l7.7 4.6v2l-7.7-2.3v4.6l2.2 1.7v1.6L12 20.4l-3.5 1.2V20l2.2-1.7v-4.6L3 16v-2l7.7-4.6V4c0-1.1.5-2 1.3-2z"/>'; // fixed icon, no data
  block.append(end(from, 'route__end--from', 'From'), icon, end(to, 'route__end--to', 'To'));
  parts.push(block);
  if (route.airports.length > 2) parts.push(h('div', 'route__via', `via ${route.airports.slice(1, -1).map(code).join(', ')}`));
  const progress = route.plausible === false ? null : routeProgress(ac.lat === null ? null : ac, route.airports);
  if (progress !== null) {
    const bar = h('div', 'progress');
    const fill = h('div', 'progress__bar');
    fill.style.width = `${Math.round(progress * 100)}%`;
    bar.append(fill);
    bar.title = `About ${Math.round(progress * 100)}% of the way (straight-line estimate)`;
    parts.push(bar);
  }
  // Great-circle distance: the shortest path over the Earth between the airports (sum of the legs).
  const lengthNm = routeLengthNm(route.airports);
  const stats = h('dl', 'facts');
  if (route.airports.length > 2) {
    // Flights with stops (e.g. QF1 SYD → SIN → LHR): each leg on its own line, then the total.
    // The leg the plane is flying now is marked (only if the route matches where it is).
    const nowOn = route.plausible === false ? null : currentLegEnd(ac.lat === null ? null : ac, route.airports);
    for (let i = 1; i < route.airports.length; i++) {
      const a = route.airports[i - 1];
      const b = route.airports[i];
      const name = `${a.iata ?? a.icao ?? a.code} → ${b.iata ?? b.icao ?? b.code}`;
      stats.append(h('dt', null, name), h('dd', null, nmAndKm(distanceNm(a, b)) + (i === nowOn ? ' · flying now' : '')));
    }
    stats.append(h('dt', null, 'Total'), h('dd', null, nmAndKm(lengthNm)));
  } else {
    stats.append(h('dt', null, 'Distance'), h('dd', null, nmAndKm(lengthNm)));
  }
  parts.push(stats);
  // Departure / arrival lines, refreshed on every live update. Skipped if the route doesn't match
  // where the plane is, since the numbers would be wrong.
  if (route.plausible !== false) {
    currentRoute = route;
    routeTimesEl = h('div');
    parts.push(routeTimesEl);
  }
  // Full names in a table too, with their source tag.
  const table = h('table', 'info__table');
  const label = (a) => `${a.name ?? a.code} (${[a.iata, a.icao].filter(Boolean).join(' / ') || a.code})`;
  const names = ['From', ...route.airports.slice(1, -1).map(() => 'Via'), 'To'];
  route.airports.forEach((a, i) => row(table, names[i], label(a), ROUTE()));
  const details = h('details', 'info__sources');
  details.append(h('summary', null, 'Airport details'), table);
  parts.push(details);
  if (route.plausible === false) {
    parts.push(h('p', 'info__warn', `This is the route on record for ${route.callsign}, but the aircraft isn't near it. The record may be outdated.`));
  } else {
    parts.push(h('p', 'info__note', 'Route by callsign from a crowd-sourced database; it can be outdated.'));
  }
  routeSection.replaceChildren(...parts);
  renderRouteTimes(ac);
}

const nmAndKm = (nm) => `${Math.round(nm).toLocaleString('en')} nm (${Math.round(nm * 1.852).toLocaleString('en')} km)`;
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Departure (if we saw the takeoff), distance to go, and an estimated arrival time.
function renderRouteTimes(ac) {
  if (!routeTimesEl || !currentRoute) return;
  const airports = currentRoute.airports;
  const takeoff = findTakeoff(getTrack(ac.hex), airports[0]);
  const rest = remainingNm(ac.lat === null ? null : ac, airports);
  const eta = estimateArrival(ac, airports);
  const facts = h('dl', 'facts');
  const line = (label, value) => facts.append(h('dt', null, label), h('dd', null, value));
  line('Departed', takeoff ? `${clock(takeoff)} (seen taking off)` : 'Not available (no schedule data)');
  if (rest !== null) line('To go', nmAndKm(rest));
  line('Est. arrival', eta ? `about ${clock(eta)} (estimate)` : ac.onGround ? 'Not available (on the ground)' : 'Not available');
  const note = h('p', 'info__note',
    'Times are in your time zone. Departure is shown only if this app saw the takeoff. Arrival = distance to go ÷ current ground speed, so it ignores winds and the approach and is only a rough guide.');
  routeTimesEl.replaceChildren(facts, note);
}

// Photo from Planespotters.net. The terms require the photographer credit and a link to the
// photo's page, so the image itself is that link.
async function showPhoto(hex) {
  photoSection.replaceChildren(h('p', 'info__note', 'Looking for a photo…'));
  let photo;
  try {
    photo = await getPhoto(hex);
  } catch {
    if (currentHex === hex) {
      photoSection.replaceChildren(h('p', 'info__note', 'Photo service could not be reached.'));
      pv.photo = null;
      renderPreview(lastAc);
    }
    return;
  }
  if (currentHex !== hex) return; // another plane was clicked meanwhile
  pv.photo = photo ?? null;
  renderPreview(lastAc);
  if (!photo) {
    photoSection.replaceChildren(h('p', 'info__note', 'No photo of this aircraft on Planespotters.net.'));
    return;
  }
  const link = safeLink(photo.pageUrl, '');
  link.rel = 'noopener noreferrer';
  const img = h('img');
  img.src = photo.src;
  img.alt = 'Photo of this aircraft';
  img.loading = 'lazy';
  img.addEventListener('error', () => photoSection.replaceChildren(h('p', 'info__note', 'Photo could not be loaded.')));
  link.append(img);
  const credit = h('p', 'info__credit');
  credit.append(`© ${photo.photographer ?? 'Unknown photographer'} · `, safeLink(photo.pageUrl, 'via Planespotters.net'));
  credit.querySelector('a').rel = 'noopener noreferrer';
  const caveat = h('p', 'info__note', 'Matched by hex code. It may show the aircraft in an older livery.');
  photoSection.replaceChildren(link, credit, caveat);
}

// The live section is refreshed on every poll while the panel is open.
export function updateLive(ac) {
  if (!ac || ac.hex !== currentHex) return;
  lastAc = ac;
  renderPreview(ac);
  const tiles = h('div', 'tiles');
  const tile = (label, value) => {
    const t = h('div', 'tile');
    t.append(h('span', 'tile__label', label), h('span', 'tile__value', value));
    tiles.append(t);
  };
  tile('Altitude', fmt.altitude(ac));
  tile('Speed', fmt.speed(ac.groundSpeedKt));
  tile('Vertical', fmt.verticalRate(ac.verticalRateFpm));
  tile('Heading', ac.trackDeg === null ? fmt.UNKNOWN : `${Math.round(ac.trackDeg)}°`);
  tile('Squawk', fmt.text(ac.squawk));
  tile('Distance', fmt.distance(ac.distanceNm));

  const heading = h('h3');
  heading.append('Live ', sourceTag('LIVE', `Live feed (${liveSourceName})`));
  // How much track we have so far, and the hex code (useful for looking the plane up elsewhere).
  const track = getTrack(ac.hex);
  const minutes = track.length > 1 ? Math.round((track.at(-1).time - track[0].time) / 60000) : 0;
  const fromRecorder = track.some((p) => p.recorded);
  const trackText = track.length < 2
    ? 'Starting… (needs two updates, about 20 s)'
    : `${minutes < 1 ? 'under 1' : minutes} min of track` + (fromRecorder ? ' (includes earlier positions from your recorder)' : ' (since you opened the page)');
  const facts = h('dl', 'facts');
  for (const [label, value] of [['Track on map', trackText], ['Hex (ICAO address)', ac.hex]]) {
    facts.append(h('dt', null, label), h('dd', null, value));
  }
  liveSection.replaceChildren(heading, tiles, facts);
  cardBarRenderer?.(ac, spotBar); // alerts can change (e.g. a new squawk)
  renderRouteTimes(ac); // the arrival estimate changes as the plane flies
}

// ---------------------------------------------------------------------------------------------
// Preview card: the short version shown first (like flight-tracker apps). "More info" shows the rest.
// ---------------------------------------------------------------------------------------------

function setMode(m) {
  mode = m;
  panel.classList.toggle('info--full', m === 'full');
  panel.classList.toggle('info--preview', m !== 'full');
  document.body.classList.toggle('card-full', m === 'full'); // CSS hides the zoom buttons behind a tall sheet
  const btn = previewEl?.querySelector('[data-act="more"]');
  if (btn) {
    btn.querySelector('span').textContent = m === 'full' ? 'Less info' : 'More info';
    btn.setAttribute('aria-expanded', String(m === 'full'));
  }
  if (m === 'preview') panel.scrollTop = 0;
}

function toggleFollow(on = !following) {
  following = on;
  previewEl.querySelector('[data-act="follow"]')?.setAttribute('aria-pressed', String(on));
  // main.js listens and keeps the map centred on the plane (until you drag the map)
  panel.dispatchEvent(new CustomEvent('aircraft-follow', { detail: { hex: on ? currentHex : null } }));
}
// main.js calls this when following stops by itself (you dragged the map).
export function setFollowing(on) {
  following = on;
  previewEl.querySelector('[data-act="follow"]')?.setAttribute('aria-pressed', String(on));
}

// Flight number with the airline's IATA code, worked out from the callsign: SIA321 -> SQ321.
// Only for airline-style callsigns whose airline we know; otherwise null (never guessed).
export function flightNumber(callsign, airline) {
  const m = /^[A-Z]{3}(\d[0-9A-Z]{0,4})$/.exec(callsign ?? '');
  return m && airline?.iata ? airline.iata + m[1] : null;
}

async function share(ac) {
  const url = `${location.origin}${location.pathname}?hex=${encodeURIComponent(ac.hex)}`;
  const title = ac.callsign ?? ac.registration ?? ac.hex;
  try {
    if (navigator.share) await navigator.share({ title, text: `${title} on SkyWatch SG`, url });
    else {
      await navigator.clipboard.writeText(url);
      const btn = previewEl.querySelector('[data-act="share"] span');
      btn.textContent = 'Link copied';
      setTimeout(() => { btn.textContent = 'Share'; }, 2000);
    }
  } catch {
    // cancelled, or the browser refused: nothing to do
  }
}

const SVG = {
  // fixed icons (no data inside)
  plane: '<path d="M12 2c.8 0 1.3.9 1.3 2v5.2l7.7 4.6v2l-7.7-2.3v4.6l2.2 1.7v1.6L12 20.4l-3.5 1.2V20l2.2-1.7v-4.6L3 16v-2l7.7-4.6V4c0-1.1.5-2 1.3-2z"/>',
  more: '<path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  follow: '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  share: '<path d="M12 3v12M7.5 7.5L12 3l4.5 4.5M5 13v6h14v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
};
function icon(name, size = 20) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = SVG[name];
  return s;
}

const clockShort = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function renderPreview(ac) {
  if (!ac || ac.hex !== currentHex || !previewEl) return;
  const route = pv.route;
  const code = (a) => a.iata ?? a.icao ?? a.code;

  // --- top: callsign, badges, airline, photo, close ---
  const top = h('div', 'pv__top');
  const id = h('div', 'pv__id');
  id.append(h('div', 'pv__call', ac.callsign ?? pv.reg ?? ac.hex));
  const badges = h('div', 'pv__badges');
  const fn = flightNumber(ac.callsign, ac.airline);
  if (fn) { const b = h('span', 'pv__badge', fn); b.title = 'Flight number, worked out from the callsign'; badges.append(b); }
  if (ac.typeCode) badges.append(h('span', 'pv__badge pv__badge--type', ac.typeCode));
  if (badges.childElementCount) id.append(badges);
  id.append(h('div', 'pv__airline', ac.airline?.name ?? (ac.callsign ? '' : 'Unknown operator')));
  top.append(id);
  // Photo thumbnail: the whole photo (no cropping), linked to its page with the photographer's credit.
  const photoBox = h('div', 'pv__photo');
  const photos = allPhotos();
  if (!pv.photo && pv.commons?.length) {
    // No Planespotters photo: show the first Commons photo (tap opens the viewer with its licence).
    const first = pv.commons[0];
    const b = h('button', 'pv__photobtn');
    b.type = 'button';
    b.setAttribute('aria-label', 'Open photos');
    const img = h('img');
    img.src = first.src;
    img.alt = 'Photo of this aircraft';
    b.append(img, h('span', 'pv__credit', `© ${first.photographer ?? 'Unknown'} · ${first.license}`));
    b.addEventListener('click', () => openGallery(photos, 0));
    photoBox.append(b);
  } else if (pv.photo) {
    if (!pv.photoEl) {
      const link = safeLink(pv.photo.pageUrl, '');
      link.rel = 'noopener noreferrer';
      const img = h('img');
      img.src = pv.photo.src;
      img.alt = 'Photo of this aircraft';
      link.append(img, h('span', 'pv__credit', `© ${pv.photo.photographer ?? 'Unknown'} · Planespotters`));
      pv.photoEl = link;
    }
    photoBox.append(pv.photoEl);
  } else {
    photoBox.classList.add('pv__photo--empty');
    photoBox.append(icon('plane', 34), h('span', 'pv__credit', pv.photo === undefined ? 'Looking for a photo…' : 'No photo'));
  }
  if (photos.length > 1) {
    const more = h('button', 'pv__morephotos', `+${photos.length - 1}`);
    more.type = 'button';
    more.title = `${photos.length} photos`;
    more.setAttribute('aria-label', `See all ${photos.length} photos`);
    more.addEventListener('click', () => openGallery(photos, 0));
    photoBox.append(more);
  }
  top.append(photoBox);
  const close = h('button', 'pv__close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => panel.dispatchEvent(new CustomEvent('aircraft-close')));
  top.append(close);

  // --- route box ---
  const routeBox = h('div', 'pv__box pv__route');
  if (route === undefined) {
    routeBox.append(h('div', 'pv__muted', ac.callsign ? 'Looking up the route…' : 'No callsign, so no route'));
  } else if (!route) {
    routeBox.append(h('div', 'pv__muted', 'Route not on record'));
  } else {
    const from = route.airports[0], to = route.airports.at(-1);
    const ends = h('div', 'pv__ends');
    const end = (a, cls) => { const e = h('div', 'pv__end ' + cls); e.append(h('div', 'pv__code', code(a)), h('div', 'pv__city', a.city ?? a.name ?? '')); return e; };
    const mid = h('div', 'pv__mid');
    mid.append(icon('plane', 22));
    ends.append(end(from, 'pv__end--from'), mid, end(to, 'pv__end--to'));
    routeBox.append(ends);
    if (route.airports.length > 2) routeBox.append(h('div', 'pv__via', 'via ' + route.airports.slice(1, -1).map(code).join(', ')));
    // Route records can be outdated: only show progress and times if the plane is near the route.
    const plausible = route.plausible !== false && ac.lat !== null;
    const progress = plausible ? routeProgress(ac, route.airports) : null;
    if (progress !== null) {
      const bar = h('div', 'progress');
      const fill = h('div', 'progress__bar');
      fill.style.width = `${Math.round(progress * 100)}%`;
      bar.append(fill);
      routeBox.append(bar);
    }
    const times = h('div', 'pv__times');
    if (!plausible) {
      times.append(h('span', 'pv__warn', 'Route on record doesn’t match where it is'));
    } else {
      const takeoff = findTakeoff(getTrack(ac.hex), from);
      const eta = estimateArrival(ac, route.airports);
      times.append(h('span', null, takeoff ? `Dep. ${clockShort(takeoff)}` : ac.onGround ? 'On the ground' : 'Dep. not seen'));
      times.append(h('span', null, eta ? `Arr. ~${clockShort(eta)}` : ''));
      if (eta) times.lastChild.title = 'Estimated arrival: distance to go ÷ current ground speed';
      if (!takeoff && !ac.onGround) times.firstChild.title = 'Shown only if the app saw the takeoff (no schedule data)';
    }
    routeBox.append(times);
  }

  // --- live numbers ---
  const live = h('div', 'pv__box pv__live');
  const stat = (label, value) => { const d = h('div', 'pv__stat'); d.append(h('div', 'pv__label', label), h('div', 'pv__value', value)); return d; };
  live.append(stat(ac.onGround ? 'Status' : 'Altitude', fmt.altitude(ac)), stat('Ground speed', fmt.speed(ac.groundSpeedKt)));

  // --- model and registration ---
  const model = h('div', 'pv__box pv__model', pv.model ?? ac.typeDescription ?? ac.typeCode ?? 'Aircraft type unknown');
  const reg = h('div', 'pv__box pv__reg');
  reg.append(h('span', 'pv__label', 'Reg.'), h('span', 'pv__regval', pv.reg ?? '—'));

  const grid = h('div', 'pv__grid');
  grid.append(routeBox, live, model, reg);

  // --- actions ---
  const actions = h('div', 'pv__actions');
  const action = (act, ico, text, attrs = {}) => {
    const b = h('button', 'pv__act');
    b.type = 'button';
    b.dataset.act = act;
    b.append(icon(ico), h('span', null, text));
    for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
    return b;
  };
  const more = action('more', 'more', mode === 'full' ? 'Less info' : 'More info', { 'aria-expanded': String(mode === 'full') });
  more.addEventListener('click', () => setMode(mode === 'full' ? 'preview' : 'full'));
  const follow = action('follow', 'follow', 'Follow', { 'aria-pressed': String(following) });
  follow.addEventListener('click', () => toggleFollow());
  const sh = action('share', 'share', 'Share');
  sh.addEventListener('click', () => share(ac));
  actions.append(more, follow, sh);

  previewEl.replaceChildren(top, grid, actions);
}

// ---------------------------------------------------------------------------------------------
// More photos (Wikimedia Commons), shown as "+N" on the preview photo and a strip in the full card.
// ---------------------------------------------------------------------------------------------

async function loadMorePhotos(hex, reg) {
  let list = [];
  try {
    list = await getCommonsPhotos(reg);
  } catch {
    list = []; // Commons unreachable: just no extra photos
  }
  if (currentHex !== hex) return;
  pv.commons = list;
  renderPreview(lastAc);
  renderStrip();
}

// Planespotters' photo first (if any), then Commons.
function allPhotos() {
  const first = pv.photo ? [{ ...pv.photo, source: 'planespotters' }] : [];
  return [...first, ...(pv.commons ?? [])];
}

function renderStrip() {
  const extra = pv.commons ?? [];
  if (!extra.length) { stripEl.replaceChildren(); return; }
  const offset = pv.photo ? 1 : 0;
  const row = h('div', 'strip');
  extra.forEach((p, k) => {
    const b = h('button', 'strip__item');
    b.type = 'button';
    b.title = `© ${p.photographer ?? 'Unknown'} · ${p.license}`;
    const img = h('img');
    img.src = p.src;
    img.alt = `Photo ${k + 1 + offset}`;
    img.loading = 'lazy';
    b.append(img);
    b.addEventListener('click', () => openGallery(allPhotos(), k + offset));
    row.append(b);
  });
  const head = h('h3');
  head.append(`More photos (${extra.length}) `, sourceTag('COMMONS', 'Wikimedia Commons: free-licence photos; credit and licence shown in the viewer'));
  stripEl.replaceChildren(head, row, h('p', 'info__note', 'From Wikimedia Commons, matched by registration. Tap a photo for its photographer and licence.'));
}
