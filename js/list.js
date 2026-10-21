// list.js
// The sortable table next to the map. It only draws; filtering and sorting logic live in
// filters.js. Clicking a column header sorts; clicking a row selects that aircraft.

import * as fmt from './format.js';
import { sortAircraft } from './filters.js';

// Columns: [header text, aircraft field used for sorting, how to display it]
const COLUMNS = [
  ['Callsign', 'callsign', (a) => fmt.text(a.callsign)],
  ['Reg', 'registration', (a) => fmt.text(a.registration)],
  ['Type', 'typeCode', (a) => fmt.text(a.typeCode)],
  ['Alt', 'altitudeFt', (a) => fmt.altitude(a)],
  ['Speed', 'groundSpeedKt', (a) => fmt.speed(a.groundSpeedKt)],
  ['V/S', 'verticalRateFpm', (a) => fmt.verticalRate(a.verticalRateFpm)],
  ['Squawk', 'squawk', (a) => fmt.text(a.squawk)],
  ['Dist', 'distanceNm', (a) => fmt.distance(a.distanceNm)],
];

const sort = { key: 'distanceNm', direction: 'asc' }; // closest first by default
let table;
let onRowClick = () => {};
let selectedHex = null;
let lastList = []; // the (filtered) aircraft we were last asked to show
let shownInOrder = []; // the same aircraft in the order the table shows them

export function initList(tableElement, rowClickHandler) {
  table = tableElement;
  onRowClick = rowClickHandler;

  // Header row with clickable column names.
  const headRow = table.createTHead().insertRow();
  for (const [label, key] of COLUMNS) {
    const th = document.createElement('th');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.key = key;
    button.addEventListener('click', () => {
      // Clicking the current column flips the direction; a new column starts ascending.
      sort.direction = sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc';
      sort.key = key;
      renderList(lastList);
    });
    th.append(button);
    headRow.append(th);
  }
  table.createTBody();
}

export function renderList(aircraft) {
  lastList = aircraft;
  const sorted = sortAircraft(aircraft, sort.key, sort.direction);
  shownInOrder = sorted;

  // Show which column is sorted and which way.
  for (const button of table.tHead.querySelectorAll('button')) {
    const active = button.dataset.key === sort.key;
    button.parentElement.setAttribute('aria-sort', active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
  }

  // Rebuild the body. (A few hundred rows at most, so rebuilding is fast enough and simple.)
  const body = document.createElement('tbody');
  for (const ac of sorted) {
    const row = body.insertRow();
    row.dataset.hex = ac.hex;
    if (ac.hex === selectedHex) row.classList.add('selected');
    for (const [, , show] of COLUMNS) row.insertCell().textContent = show(ac); // textContent: safe from HTML in data
    row.addEventListener('click', () => onRowClick(ac.hex));
  }
  table.tBodies[0].replaceWith(body);
}

// What the table shows right now, in its order. CSV export uses this so the file matches the screen.
export function getShownInOrder() {
  return shownInOrder;
}

export function highlightRow(hex) {
  selectedHex = hex;
  for (const row of table.tBodies[0].rows) row.classList.toggle('selected', row.dataset.hex === hex);
  table.tBodies[0].querySelector('tr.selected')?.scrollIntoView({ block: 'nearest' });
}
