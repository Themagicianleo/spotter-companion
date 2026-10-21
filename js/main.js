// main.js
// Entry point loaded by index.html. It wires the modules together and starts the app.

import { start, setRenderer, setSelectHandler, state, updateStatus } from './app.js';
import { CONFIG } from './config.js';
import { PROVIDERS } from './api.js';
import * as mapView from './map.js';
import { parseFilterInputs, applyFilters } from './filters.js';
import { initList, renderList, highlightRow, getShownInOrder } from './list.js';
import { downloadCsv } from './csv.js';
import { initInfoPanel, openInfoPanel, updateLive, isOpenFor, closeInfoPanel } from './infoPanel.js';
import { getTrack, loadRecordedTrack } from './track.js';
import { lookupRoute, isPlausible, shortRoute } from './routes.js';

// ---- Routes: callsign -> airports (data/routes.json) ----
const routeCache = new Map(); // callsign -> route object, or null if none on record
const pendingRoutes = new Set();

// Give each aircraft a short route label ("FOC → SIN"), looking up new callsigns in the
// background and re-drawing once they're known. "(?)" = the plane isn't near that route.
function attachRoutes(aircraft) {
  for (const ac of aircraft) {
    ac.routeLabel = null;
    if (!ac.callsign) continue;
    if (routeCache.has(ac.callsign)) {
      const route = routeCache.get(ac.callsign);
      if (!route) continue;
      const plausible = ac.lat === null ? null : isPlausible(ac, route.airports);
      ac.routeLabel = shortRoute(route) + (plausible === false ? ' (?)' : '');
    } else if (!pendingRoutes.has(ac.callsign)) {
      pendingRoutes.add(ac.callsign);
      lookupRoute(ac.callsign, null)
        .then((route) => routeCache.set(ac.callsign, route))
        .catch(() => {}) // routes file unavailable: just no route labels
        .finally(() => {
          pendingRoutes.delete(ac.callsign);
          if (!pendingRoutes.size) render(); // redraw once the current batch is known
        });
    }
  }
}

let selectedHex = null; // the aircraft whose track is drawn (null = none)

// ---- Phase 2: filters, list and CSV export ----
const filterForm = document.getElementById('filters');
const inputs = {
  types: document.getElementById('filter-types'),
  prefix: document.getElementById('filter-prefix'),
  minAlt: document.getElementById('filter-min-alt'),
  maxAlt: document.getElementById('filter-max-alt'),
  ground: document.getElementById('filter-ground'),
};
const searchBox = document.getElementById('search');
const listCount = document.getElementById('list-count');
const seenTypes = document.getElementById('seen-types');

function currentFilters() {
  return parseFilterInputs({
    types: inputs.types.value,
    prefix: inputs.prefix.value,
    minAlt: inputs.minAlt.value,
    maxAlt: inputs.maxAlt.value,
    includeGround: inputs.ground.checked,
    search: searchBox.value,
  });
}

// Offer the type codes currently in the air as suggestions in the "Type codes" box.
function updateTypeSuggestions() {
  const codes = [...new Set(state.aircraft.map((a) => a.typeCode).filter(Boolean))].sort();
  seenTypes.replaceChildren(...codes.map((c) => Object.assign(document.createElement('option'), { value: c })));
}

// Runs after every data refresh and every filter change.
function render() {
  attachRoutes(state.aircraft);
  const visible = applyFilters(state.aircraft, currentFilters());
  mapView.updateAircraft(visible);
  mapView.showTrack(selectedHex ? getTrack(selectedHex) : []);
  renderList(visible);
  listCount.textContent = `${visible.length} of ${state.aircraft.length} shown`;
  updateTypeSuggestions();
  updateStatus();
  // Keep the info panel's "Live" numbers fresh.
  const selected = state.aircraft.find((a) => isOpenFor(a.hex));
  if (selected) updateLive(selected);
}

// Selecting a plane (from the map or the list) highlights it in both places.
// Clicking a plane or a list row opens its flight card; clicking empty map clears the selection.
function select(hex, { openPanel = false, fromList = false } = {}) {
  selectedHex = hex;
  mapView.showTrack(hex ? getTrack(hex) : []);
  // Fetch the recorder's earlier positions, then redraw if this plane is still selected.
  if (hex) {
    loadRecordedTrack(hex).then((found) => {
      if (!found || selectedHex !== hex) return;
      mapView.showTrack(getTrack(hex));
      const current = state.aircraft.find((a) => a.hex === hex);
      if (current && isOpenFor(hex)) updateLive(current); // card's "Track on map" now includes them
    });
  }
  mapView.selectAircraft(hex, { pan: fromList });
  highlightRow(hex);
  if (hex === null) closeInfoPanel();
  const ac = state.aircraft.find((a) => a.hex === hex);
  if (ac && (openPanel || fromList)) openInfoPanel(ac);
}

filterForm.addEventListener('input', render);
searchBox.addEventListener('input', render);

// ---- Top-bar buttons: open/close the Filters, List and Area drawers (one at a time) ----
const PANEL_KEY = 'spotters-companion:open-panel';
const toggles = [...document.querySelectorAll('[data-toggle]')];
function showPanel(id) {
  for (const button of toggles) {
    const open = button.dataset.toggle === id;
    button.setAttribute('aria-expanded', String(open));
    document.getElementById(button.dataset.toggle).hidden = !open;
  }
  // Tells the CSS how far to move the map's right-hand controls out of the drawer's way.
  document.body.dataset.drawer = !id ? '' : id === 'list-panel' ? 'wide' : 'small';
  try {
    localStorage.setItem(PANEL_KEY, id ?? '');
  } catch {
    // remembering is optional
  }
}
for (const button of toggles) {
  button.addEventListener('click', () => showPanel(button.getAttribute('aria-expanded') === 'true' ? null : button.dataset.toggle));
}
// "Filters" opens the List drawer with its filter section expanded.
const filtersBox = document.getElementById('filters-box');
const filtersButton = document.getElementById('filters-btn');
const syncFiltersButton = () => filtersButton.setAttribute('aria-expanded', String(filtersBox.open && !document.getElementById('list-panel').hidden));
filtersButton.addEventListener('click', () => {
  const opening = filtersButton.getAttribute('aria-expanded') !== 'true';
  if (opening) showPanel('list-panel');
  filtersBox.open = opening;
  syncFiltersButton();
});
filtersBox.addEventListener('toggle', syncFiltersButton);
for (const button of toggles) button.addEventListener('click', syncFiltersButton);
try {
  const saved = localStorage.getItem(PANEL_KEY);
  if (saved && document.getElementById(saved)) showPanel(saved);
} catch {
  // storage blocked: start with everything closed
}
// "reset" fires before the boxes are cleared, so wait one tick before re-rendering.
filterForm.addEventListener('reset', () => setTimeout(render));
filterForm.addEventListener('submit', (e) => e.preventDefault());

document.getElementById('export-csv').addEventListener('click', () => {
  downloadCsv(getShownInOrder(), PROVIDERS[CONFIG.provider].csvCredit);
});

initInfoPanel(document.getElementById('info-panel'), PROVIDERS[CONFIG.provider].name);
initList(document.getElementById('aircraft-list'), (hex) => select(hex, { fromList: true }));
setRenderer(render);
setSelectHandler(select);
start();
