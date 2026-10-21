// infoPanel.js
// The aircraft info panel. Every value is labelled with where it came from:
//   LIVE  - the live ADS-B feed (adsb.lol etc.), right now
//   DB    - our aircraft database (tar1090-db), matched by hex code
//   TYPE  - our type table (data/aircraft_types.json), matched by ICAO type code
// Missing values show "Unknown". All text is set with textContent, never innerHTML,
// so nothing from the internet can inject HTML into the page.

import * as fmt from './format.js';
import { lookupAircraft, lookupType, getDbMeta, ageFromYear } from './aircraftDb.js';
import { getPhoto } from './photos.js';

let panel;
let liveSection;
let detailsSection;
let photoSection;
let currentHex = null;
let liveSourceName = 'live feed';

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

export function initInfoPanel(element, providerName) {
  panel = element;
  liveSourceName = providerName;
  const header = h('div', 'info__header');
  header.append(h('h2', 'info__title', 'Aircraft info'));
  const close = h('button', 'info__close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close aircraft info');
  close.addEventListener('click', closeInfoPanel);
  header.append(close);
  liveSection = h('section', 'info__section');
  detailsSection = h('section', 'info__section');
  photoSection = h('section', 'info__photo');
  panel.append(header, photoSection, detailsSection, liveSection);
}

export function closeInfoPanel() {
  panel.hidden = true;
  currentHex = null;
}

export function isOpenFor(hex) {
  return !panel.hidden && currentHex === hex;
}

// Open the panel for one aircraft (the normalized object from api.js).
export async function openInfoPanel(ac) {
  currentHex = ac.hex;
  panel.hidden = false;
  panel.querySelector('.info__title').textContent = ac.callsign ?? ac.registration ?? ac.hex;
  updateLive(ac);
  detailsSection.replaceChildren(h('p', 'info__loading', 'Looking up aircraft and type data…'));
  showPhoto(ac.hex); // runs alongside the lookups below; no need to wait for it

  // Load the database entry and the type info at the same time.
  const [dbResult, metaResult] = await Promise.allSettled([lookupAircraft(ac.hex), getDbMeta()]);
  const db = dbResult.status === 'fulfilled' ? dbResult.value : null;
  const typeCode = db?.typeCode ?? ac.typeCode;
  const typeResult = await Promise.allSettled([lookupType(typeCode)]);
  const type = typeResult[0].status === 'fulfilled' ? typeResult[0].value : null;

  if (currentHex !== ac.hex) return; // user clicked another plane while we were loading
  renderDetails(ac, db, dbResult.status === 'rejected', metaResult.value, type, typeResult[0].status === 'rejected');
}

// Pick the first known value and remember which source it came from.
function pick(...candidates) {
  for (const [value, tag] of candidates) if (value !== null && value !== undefined && value !== '') return [value, tag];
  return [null, null];
}

function renderDetails(ac, db, dbFailed, meta, type, typeFailed) {
  const dbLabel = `Aircraft database: ${meta?.source ?? 'tar1090-db'}${meta?.builtAt ? `, copied ${meta.builtAt.slice(0, 10)}` : ''}`;
  const LIVE = () => sourceTag('LIVE', `Live feed (${liveSourceName})`);
  const DB = () => sourceTag('DB', dbLabel);
  const TYPE = () => sourceTag('TYPE', 'Type table (data/aircraft_types.json)');
  const CALC = () => sourceTag('CALC', 'Calculated from year built');

  const parts = [];

  // ---- This aircraft ----
  parts.push(h('h3', null, 'This aircraft'));
  if (dbFailed) parts.push(h('p', 'info__warn', 'The aircraft database could not be loaded, so only live-feed values are shown.'));
  else if (!db) parts.push(h('p', 'info__note', 'Not in our database (it only holds the Boeing/Airbus types in the type table).'));

  const t1 = h('table', 'info__table');
  // The live feed's registration/type/year/operator also come from the provider's own database.
  const [reg, regTag] = pick([db?.registration, DB()], [ac.registration, LIVE()]);
  const [code, codeTag] = pick([db?.typeCode, DB()], [ac.typeCode, LIVE()]);
  const [model, modelTag] = pick([type?.model, TYPE()], [db?.typeDescription, DB()], [ac.typeDescription, LIVE()]);
  const [year, yearTag] = pick([db?.yearBuilt, DB()], [ac.yearBuilt, LIVE()]);
  const [operator, opTag] = pick([db?.operator, DB()], [ac.operator, LIVE()]);
  const age = ageFromYear(year);
  row(t1, 'Registration', reg, regTag);
  row(t1, 'ICAO type code', code, codeTag);
  row(t1, 'Model', model, modelTag);
  row(t1, 'Manufacturer', type?.manufacturer, TYPE());
  row(t1, 'Year built', year, yearTag);
  row(t1, 'Age', age === null ? null : `about ${age} year${age === 1 ? '' : 's'}`, CALC());
  row(t1, 'Operator / owner', operator, opTag);
  row(t1, 'Serial number (MSN)', null, null);
  parts.push(t1);
  parts.push(h('p', 'info__note', 'Serial numbers are not in our database (tar1090-db has no serial-number field).'));

  // ---- Type information ----
  parts.push(h('h3', null, 'Engine options for this type'));
  if (typeFailed) {
    parts.push(h('p', 'info__warn', 'The type table could not be loaded.'));
  } else if (!type) {
    parts.push(h('p', 'info__note', code ? `Type ${code} is not in our type table (it covers common Boeing and Airbus airliners).` : 'Type unknown.'));
  } else {
    const t2 = h('table', 'info__table');
    row(t2, 'Number of engines', type.engineCount, TYPE());
    parts.push(t2);
    const list = h('ul', 'info__engines');
    for (const e of type.engineOptions) {
      const li = h('li', null, `${e.maker} ${e.model}`);
      if (!e.verified) li.append(' ', h('span', 'badge badge--warn', 'unconfirmed'));
      list.append(li);
    }
    parts.push(list);
    parts.push(h('p', 'info__note',
      'These are the engines offered for this aircraft TYPE. They do not tell you which engine this particular aircraft has.'));
    const status = { 'verified-secondary': 'Checked against cited sources (via search excerpts).', 'partly-unverified': 'Some options are unconfirmed.', unverified: 'Unconfirmed: please treat with caution.' };
    parts.push(h('p', 'info__note', `Verification: ${status[type.verification] ?? type.verification}`));
    if (type.notes) parts.push(h('p', 'info__note', type.notes));
    const sources = h('details', 'info__sources');
    sources.append(h('summary', null, `Sources (${type.source.length})`));
    const ul = h('ul');
    for (const s of type.source) {
      const li = h('li');
      li.append(safeLink(s.url, s.name));
      ul.append(li);
    }
    sources.append(ul);
    parts.push(sources);
  }

  // ---- Where the data comes from ----
  const legend = h('p', 'info__legend');
  legend.append(LIVE(), ` live feed (${liveSourceName}) · `, DB(), ' aircraft database · ', TYPE(), ' type table · ', CALC(), ' calculated');
  parts.push(legend);
  parts.push(h('p', 'info__note',
    'Database entries are community-maintained and can be outdated or wrong (for example after an aircraft changes operator).'));

  detailsSection.replaceChildren(...parts);
}

// Photo from Planespotters.net. The terms require the photographer credit and a link to the
// photo's page, so the image itself is that link.
async function showPhoto(hex) {
  photoSection.replaceChildren(h('p', 'info__note', 'Looking for a photo…'));
  let photo;
  try {
    photo = await getPhoto(hex);
  } catch {
    if (currentHex === hex) photoSection.replaceChildren(h('p', 'info__note', 'Photo service could not be reached.'));
    return;
  }
  if (currentHex !== hex) return; // another plane was clicked meanwhile
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
  const LIVE = () => sourceTag('LIVE', `Live feed (${liveSourceName})`);
  const table = h('table', 'info__table');
  row(table, 'Callsign', ac.callsign, LIVE());
  row(table, 'Hex (ICAO address)', ac.hex, LIVE());
  row(table, 'Altitude', ac.onGround || ac.altitudeFt !== null ? fmt.altitude(ac) : null, LIVE());
  row(table, 'Ground speed', ac.groundSpeedKt === null ? null : fmt.speed(ac.groundSpeedKt), LIVE());
  row(table, 'Vertical speed', ac.verticalRateFpm === null ? null : fmt.verticalRate(ac.verticalRateFpm), LIVE());
  row(table, 'Track', ac.trackDeg === null ? null : `${Math.round(ac.trackDeg)}°`, LIVE());
  row(table, 'Squawk', ac.squawk, LIVE());
  row(table, 'Distance from center', ac.distanceNm === null ? null : fmt.distance(ac.distanceNm), LIVE());
  liveSection.replaceChildren(h('h3', null, 'Live'), table);
}
