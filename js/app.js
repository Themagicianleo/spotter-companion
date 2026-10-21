// app.js
// The "conductor": it asks api.js for data on a timer, hands the result to the map,
// and shows status and error messages. It contains no provider-specific code.

import { CONFIG } from './config.js';
import { fetchAircraftNear, PROVIDERS } from './api.js';
import * as mapView from './map.js';

// ---- Settings the user can change (remembered in this browser if storage is allowed) ----
const SETTINGS_KEY = 'spotters-companion:settings';

function loadSettings() {
  const defaults = { center: CONFIG.defaultCenter, radiusNm: CONFIG.defaultRadiusNm };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (saved && Number.isFinite(saved.center?.lat) && Number.isFinite(saved.center?.lon) && Number.isFinite(saved.radiusNm)) {
      return saved;
    }
  } catch {
    // Storage blocked or corrupted: just use the defaults.
  }
  return defaults;
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not important if this fails; the app works without it.
  }
}

const settings = loadSettings();

// ---- App state ----
const state = {
  aircraft: [], // latest normalized list from api.js
  lastUpdate: null, // Date of the last successful fetch
  backoffMs: 0, // extra wait after errors (0 when healthy)
  timer: null, // the pending setTimeout for the next poll
};

// ---- Page elements ----
const el = {
  banner: document.getElementById('banner'),
  status: document.getElementById('status'),
  latInput: document.getElementById('center-lat'),
  lonInput: document.getElementById('center-lon'),
  radiusInput: document.getElementById('radius'),
  centerForm: document.getElementById('center-form'),
  useMapCenter: document.getElementById('use-map-center'),
  resetCenter: document.getElementById('reset-center'),
};

// Show (or hide, if message is null) the coloured message bar above the map.
function showBanner(message, level = 'error') {
  if (!message) {
    el.banner.hidden = true;
    return;
  }
  el.banner.hidden = false;
  el.banner.className = `banner banner--${level}`;
  el.banner.textContent = message;
}

function updateStatus(extra = '') {
  const parts = [];
  const onMap = state.aircraft.filter((a) => a.lat !== null && a.lon !== null).length;
  const noPosition = state.aircraft.length - onMap;
  parts.push(`${onMap} aircraft on map` + (noPosition ? ` (+${noPosition} without position)` : ''));
  if (state.lastUpdate) parts.push(`updated ${state.lastUpdate.toLocaleTimeString()}`);
  if (extra) parts.push(extra);
  el.status.textContent = parts.join(' · ');
}

// Called whenever the aircraft list changes. Phase 2 adds filters and the list here.
let render = () => {
  mapView.updateAircraft(state.aircraft);
  updateStatus();
};
export function setRenderer(fn) {
  render = fn;
}
export { state, el, updateStatus };

// ---- Polling ----
async function poll() {
  const { center, radiusNm } = settings;
  try {
    const result = await fetchAircraftNear(center.lat, center.lon, radiusNm);
    state.aircraft = result.aircraft;
    state.lastUpdate = new Date(result.fetchedAt);
    state.backoffMs = 0;
    if (result.aircraft.length === 0) {
      showBanner(`No aircraft reported within ${radiusNm} nm right now. That's normal late at night or in a quiet area; try a bigger radius.`, 'info');
    } else {
      showBanner(null);
    }
    render();
  } catch (err) {
    handleError(err);
  } finally {
    scheduleNextPoll();
  }
}

function handleError(err) {
  // Double the wait after each failure (10 s, 20 s, 40 s ... up to maxBackoffMs).
  state.backoffMs = Math.min(Math.max(state.backoffMs * 2, CONFIG.pollIntervalMs), CONFIG.maxBackoffMs);
  if (err.retryAfterMs) state.backoffMs = Math.max(state.backoffMs, err.retryAfterMs);
  const retryIn = Math.round((CONFIG.pollIntervalMs + state.backoffMs) / 1000);

  const messages = {
    network: `${err.message} Retrying in ${retryIn} s. (Running locally? Use scripts/dev_server.py, see README.)`,
    timeout: `${err.message} Retrying in ${retryIn} s.`,
    rate_limited: `${err.message} Slowing down; retrying in ${retryIn} s.`,
    http:
      err.status === 403 || err.status === 401
        ? `${err.message} The provider refused access. It may now be limited to feeders. Try another provider in js/config.js.`
        : `${err.message} The provider may be down. Retrying in ${retryIn} s.`,
    format: `${err.message} Retrying in ${retryIn} s.`,
  };
  showBanner(messages[err.kind] ?? `Unexpected error: ${err.message}`, 'error');
  // Keep showing the last good positions (if any) rather than blanking the map.
  updateStatus(state.aircraft.length ? 'showing last known positions' : '');
  console.error(err);
}

function scheduleNextPoll() {
  clearTimeout(state.timer);
  // Don't poll while the tab is hidden: it saves the provider's bandwidth and yours.
  if (document.hidden) return;
  state.timer = setTimeout(poll, CONFIG.pollIntervalMs + state.backoffMs);
}

// When the tab becomes visible again, refresh straight away.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
  else clearTimeout(state.timer);
});

// ---- Center / radius controls ----
function fillCenterForm() {
  el.latInput.value = settings.center.lat.toFixed(4);
  el.lonInput.value = settings.center.lon.toFixed(4);
  el.radiusInput.value = settings.radiusNm;
}

function applyCenter(center, radiusNm) {
  settings.center = center;
  settings.radiusNm = radiusNm;
  saveSettings();
  fillCenterForm();
  mapView.setSearchArea(center, radiusNm);
  poll();
}

el.centerForm.addEventListener('submit', (event) => {
  event.preventDefault(); // stop the browser reloading the page
  const lat = Number(el.latInput.value);
  const lon = Number(el.lonInput.value);
  const radius = Number(el.radiusInput.value);
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && radius >= 1 && radius <= 250)) {
    showBanner('Please enter a latitude between -90 and 90, a longitude between -180 and 180, and a radius from 1 to 250 nm.', 'error');
    return;
  }
  applyCenter({ lat, lon }, radius);
});

el.useMapCenter.addEventListener('click', () => applyCenter(mapView.getMapCenter(), settings.radiusNm));
el.resetCenter.addEventListener('click', () => applyCenter(CONFIG.defaultCenter, CONFIG.defaultRadiusNm));

// ---- Start-up ----
// Selecting a plane: in Phase 1 this only highlights it. Later phases replace this.
let selectHandler = (hex) => mapView.selectAircraft(hex);
export function setSelectHandler(fn) {
  selectHandler = fn;
}

export function start() {
  const provider = PROVIDERS[CONFIG.provider];
  document.getElementById('provider-credit').innerHTML = provider.attributionHtml; // our own fixed text, not API data
  mapView.initMap('map', settings.center, settings.radiusNm, provider.attributionHtml, (hex, opts) => selectHandler(hex, opts));
  fillCenterForm();
  updateStatus('loading…');
  poll();
}
