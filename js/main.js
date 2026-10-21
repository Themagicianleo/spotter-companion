// main.js
// Entry point loaded by index.html. It wires the modules together and starts the app.

import { start, setRenderer, setSelectHandler, state, updateStatus } from './app.js';
import { CONFIG } from './config.js';
import { PROVIDERS } from './api.js';
import * as mapView from './map.js';
import { parseFilterInputs, applyFilters } from './filters.js';
import { initList, renderList, highlightRow, getShownInOrder } from './list.js';
import { downloadCsv } from './csv.js';
import { initInfoPanel, openInfoPanel, updateLive, isOpenFor } from './infoPanel.js';

// ---- Phase 2: filters, list and CSV export ----
const filterForm = document.getElementById('filters');
const inputs = {
  types: document.getElementById('filter-types'),
  prefix: document.getElementById('filter-prefix'),
  minAlt: document.getElementById('filter-min-alt'),
  maxAlt: document.getElementById('filter-max-alt'),
  ground: document.getElementById('filter-ground'),
};
const listCount = document.getElementById('list-count');
const seenTypes = document.getElementById('seen-types');

function currentFilters() {
  return parseFilterInputs({
    types: inputs.types.value,
    prefix: inputs.prefix.value,
    minAlt: inputs.minAlt.value,
    maxAlt: inputs.maxAlt.value,
    includeGround: inputs.ground.checked,
  });
}

// Offer the type codes currently in the air as suggestions in the "Type codes" box.
function updateTypeSuggestions() {
  const codes = [...new Set(state.aircraft.map((a) => a.typeCode).filter(Boolean))].sort();
  seenTypes.replaceChildren(...codes.map((c) => Object.assign(document.createElement('option'), { value: c })));
}

// Runs after every data refresh and every filter change.
function render() {
  const visible = applyFilters(state.aircraft, currentFilters());
  mapView.updateAircraft(visible);
  renderList(visible);
  listCount.textContent = `${visible.length} of ${state.aircraft.length} shown`;
  updateTypeSuggestions();
  updateStatus();
  // Keep the info panel's "Live" numbers fresh.
  const selected = state.aircraft.find((a) => isOpenFor(a.hex));
  if (selected) updateLive(selected);
}

// Selecting a plane (from the map or the list) highlights it in both places.
// openPanel is true when the popup's "Aircraft info" button was clicked.
function select(hex, { openPanel = false, fromList = false } = {}) {
  mapView.selectAircraft(hex, { pan: fromList, openPopup: fromList });
  highlightRow(hex);
  const ac = state.aircraft.find((a) => a.hex === hex);
  if (ac && openPanel) openInfoPanel(ac);
}

filterForm.addEventListener('input', render);
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
