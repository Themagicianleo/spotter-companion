// map.js
// Everything to do with the Leaflet map: tiles, the search-radius circle, and one rotating
// plane marker per aircraft. `L` is the global object created by vendor/leaflet/leaflet.js.

let map;
let radiusCircle;
let trackLayer; // the selected aircraft's track (a group of coloured line segments)
let trackLegend;
const markers = new Map(); // hex -> Leaflet marker, so we move markers instead of recreating them
let onSelect = () => {}; // set by app.js: what to do when a plane is clicked
let selectedHex = null;

import { SHAPES } from './shapes.js';

// Which silhouette to draw (js/shapes.js). Chosen from the ICAO type code the live feed sends,
// then from the ADS-B emitter category. These are only drawing choices for the icon.
const WIDEBODY = new Set(['A30B', 'A306', 'A310', 'A332', 'A333', 'A338', 'A339', 'A359', 'A35K', 'B762', 'B763', 'B764',
  'B772', 'B77L', 'B773', 'B77W', 'B778', 'B779', 'B788', 'B789', 'B78X']);
const FOUR_ENGINE = new Set(['A342', 'A343', 'A345', 'A346', 'B741', 'B742', 'B743', 'B744', 'B74S', 'B748']);
const TRIJET = new Set(['B721', 'B722']);
const TURBOPROP = /^(AT[4-7]\d|DH8[A-D])$/; // ATR 42/72 and Dash 8 families
export function shapeFor(ac) {
  if (ac.category === 'A7') return 'helicopter';
  if (ac.typeCode === 'A388') return 'a380';
  if (FOUR_ENGINE.has(ac.typeCode)) return 'quad';
  if (WIDEBODY.has(ac.typeCode)) return 'wide';
  if (TRIJET.has(ac.typeCode)) return 'trijet';
  if (TURBOPROP.test(ac.typeCode ?? '')) return 'turboprop';
  if (ac.category === 'A1') return 'light';
  if (ac.category === 'A2') return 'bizjet';
  return 'narrow';
}

let showBadges = true; // airline code badges next to planes (can be switched off in Filters)
export function setShowBadges(on) {
  showBadges = on;
}

// Only letters/digits from the data go into the badge, so nothing can inject HTML.
const safeCode = (s) => (s ?? '').replace(/[^A-Z0-9]/gi, '').slice(0, 3);

// Icon size in pixels, from the ADS-B emitter category the aircraft broadcasts (DO-260B):
//   A1 light (< 15,500 lb), A2 small (< 75,000 lb), A3 large (< 300,000 lb, e.g. A320/737),
//   A4 high-vortex large (B757), A5 heavy (> 300,000 lb, e.g. 777/A350), A7 rotorcraft.
// The A380 (ICAO wake category "Super", above Heavy) gets the biggest icon.
// No category (A0 or missing) gets a middle size, so it's never mistaken for a small plane.
const SIZE_BY_CATEGORY = { A1: 16, A2: 20, A3: 26, A4: 28, A5: 34, A7: 20 };
export function iconSize(ac) {
  if (ac.typeCode === 'A388') return 40;
  return SIZE_BY_CATEGORY[ac.category] ?? 26;
}

function planeIcon(ac) {
  // No track known? Draw it pointing north but faded, so you can tell it's not a real heading.
  const rotation = ac.trackDeg ?? 0;
  const classes = ['plane'];
  if (ac.trackDeg === null) classes.push('plane--no-track');
  if (ac.onGround) classes.push('plane--ground');
  if (ac.hex === selectedHex) classes.push('plane--selected');
  const size = iconSize(ac);
  const badge = showBadges ? safeCode(ac.airline?.iata ?? ac.airline?.icao) : '';
  return L.divIcon({
    className: 'plane-icon', // Leaflet's wrapper; the rotation goes on the inner div
    // The plane rotates; the airline badge (if any) stays upright next to it.
    html: `<div class="${classes.join(' ')}" style="width:${size}px;height:${size}px;transform:rotate(${rotation}deg)">` +
      `<svg viewBox="0 0 64 64" aria-hidden="true">${SHAPES[shapeFor(ac)]}</svg></div>` +
      (badge ? `<span class="plane-badge">${badge}</span>` : ''),
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2], // center of the icon sits on the aircraft position
  });
}

// Small label shown when you hover over a plane: "SIA321 · A359 · LHR → SIN".
// Built with DOM methods, not innerHTML: callsigns come from the internet, and textContent
// guarantees they are shown as text and never run as code.
function labelContent(ac) {
  const box = document.createElement('span');
  const name = document.createElement('b');
  name.textContent = ac.callsign ?? ac.registration ?? ac.hex;
  box.append(name);
  const extra = [ac.airline?.name, ac.typeCode, ac.routeLabel, ac.onGround ? 'on ground' : ac.altitudeFt === null ? null : `${ac.altitudeFt.toLocaleString('en')} ft`];
  box.append(extra.filter(Boolean).map((x) => ` · ${x}`).join(''));
  return box;
}

export function initMap(elementId, center, radiusNm, attributionHtml, selectHandler) {
  onSelect = selectHandler;
  map = L.map(elementId, { zoomControl: false }).setView([center.lat, center.lon], 9);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Two backgrounds. Each carries the attribution its licence requires; Leaflet shows the
  // attribution of whichever layer is currently on the map.
  const osmAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  const ofmAttribution = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
    '&copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
    'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

  // Sharp vector maps from OpenFreeMap (free, no key; attribution required), drawn by MapLibre.
  // Only offered if MapLibre loaded and this browser supports WebGL; otherwise the image maps remain.
  const vector = (style) => L.maplibreGL({ style: `https://tiles.openfreemap.org/styles/${style}`, attribution: ofmAttribution });
  const canDrawVector = typeof L.maplibreGL === 'function' && typeof maplibregl !== 'undefined' &&
    (() => {
      try {
        return !!document.createElement('canvas').getContext('webgl2') || !!document.createElement('canvas').getContext('webgl');
      } catch {
        return false;
      }
    })();

  const baseLayers = {
    ...(canDrawVector ? { Dark: vector('dark'), Streets: vector('liberty') } : {}),
    // EOX Sentinel-2 cloudless 2024: free for non-commercial use with attribution
    // (CC BY-NC-SA 4.0). About 10 m per pixel, so airports are visible but not parked planes.
    // Tiles exist up to zoom 16; beyond that Leaflet enlarges the zoom-16 tiles.
    Satellite: L.tileLayer('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg', {
      maxZoom: 18,
      maxNativeZoom: 16,
      attribution: '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX IT Services GmbH ' +
        '(contains modified Copernicus Sentinel data 2024), ' +
        '<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>',
    }),
    // OpenStreetMap's standard image tiles. Their tile policy requires this attribution.
    Classic: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: osmAttribution }),
  };
  (baseLayers[loadBaseLayerName(Object.keys(baseLayers))] ?? baseLayers.Classic).addTo(map);
  L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => saveBaseLayerName(e.name)); // remember the choice
  map.attributionControl.addAttribution(attributionHtml);

  radiusCircle = L.circle([center.lat, center.lon], {
    radius: radiusNm * 1852, // Leaflet wants metres
    color: '#ffc400',
    weight: 1,
    opacity: 0.6,
    fill: false,
    dashArray: '4 6',
  }).addTo(map);

  trackLayer = L.layerGroup().addTo(map);
  // Small legend explaining the track colours, shown only while a track is drawn.
  trackLegend = L.control({ position: 'bottomleft' });
  trackLegend.onAdd = () => {
    const box = L.DomUtil.create('div', 'track-legend');
    box.innerHTML = '<strong>Track altitude</strong>' + // fixed text, no API data
      ALT_BANDS.map((b) => `<span><i style="background:${b.color}"></i>${b.label}</span>`).join('');
    return box;
  };
  // Clicking empty map (not a plane) clears the selection.
  map.on('click', () => onSelect(null, { openPanel: false }));
  return map;
}

// Track colour by altitude, like many flight trackers. Checked top to bottom.
const ALT_BANDS = [
  { max: 0, color: '#9ca3af', label: 'Ground' },
  { max: 10000, color: '#f97316', label: '< 10,000 ft' },
  { max: 25000, color: '#16a34a', label: '10–25,000 ft' },
  { max: Infinity, color: '#2563eb', label: '> 25,000 ft' },
];
const UNKNOWN_ALT_COLOR = '#a855f7';
const altColor = (alt) => (alt === null ? UNKNOWN_ALT_COLOR : ALT_BANDS.find((b) => alt <= b.max).color);

// Draw a track from points [{lat, lon, alt}], oldest first. An empty list hides the track.
export function showTrack(points) {
  trackLayer.clearLayers();
  if (points.length < 2) {
    trackLegend.remove();
    return;
  }
  // A dark outline under the whole track, so it stands out on the satellite view too.
  L.polyline(points.map((p) => [p.lat, p.lon]), { color: '#111827', weight: 6, opacity: 0.6, interactive: false }).addTo(trackLayer);
  // Then one short line per pair of points, so each piece can have its own altitude colour.
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: altColor(b.alt), weight: 3.5, opacity: 1, interactive: false }).addTo(trackLayer);
  }
  trackLegend.addTo(map);
}

// Remember Map/Satellite between visits (if this browser allows storage).
const BASE_LAYER_KEY = 'spotters-companion:base-layer';
function loadBaseLayerName(available) {
  // Older versions saved "Map" / "Dark map"; map them to today's names.
  const renamed = { Map: 'Classic', 'Dark map': 'Dark' };
  let saved = null;
  try {
    saved = localStorage.getItem(BASE_LAYER_KEY);
  } catch {
    // storage blocked: use the default
  }
  saved = renamed[saved] ?? saved;
  if (available.includes(saved)) return saved;
  return available.includes('Dark') ? 'Dark' : 'Classic';
}
function saveBaseLayerName(name) {
  try {
    localStorage.setItem(BASE_LAYER_KEY, name);
  } catch {
    // not important
  }
}

export function setSearchArea(center, radiusNm) {
  radiusCircle.setLatLng([center.lat, center.lon]).setRadius(radiusNm * 1852);
  map.setView([center.lat, center.lon]);
}

export function getMapCenter() {
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

// Draw the given aircraft. Markers for aircraft not in the list are removed.
export function updateAircraft(aircraftList) {
  const seen = new Set();
  for (const ac of aircraftList) {
    if (ac.lat === null || ac.lon === null || !ac.hex) continue; // can't place it on a map
    seen.add(ac.hex);
    let marker = markers.get(ac.hex);
    if (!marker) {
      marker = L.marker([ac.lat, ac.lon], { icon: planeIcon(ac), keyboard: true });
      // Clicking a plane selects it and opens its flight card.
      marker.on('click', () => onSelect(ac.hex, { openPanel: true }));
      marker.bindTooltip('', { className: 'plane-label', direction: 'top', offset: [0, -14] });
      marker.addTo(map);
      markers.set(ac.hex, marker);
    } else {
      marker.setLatLng([ac.lat, ac.lon]);
      marker.setIcon(planeIcon(ac));
    }
    // Keep the hover label up to date.
    marker.setTooltipContent(labelContent(ac));
  }
  for (const [hex, marker] of markers) {
    if (!seen.has(hex)) {
      marker.remove();
      markers.delete(hex);
    }
  }
}

// Highlight one aircraft and (optionally) pan the map to it.
export function selectAircraft(hex, { pan = false } = {}) {
  const previous = selectedHex;
  selectedHex = hex;
  // Re-draw the old and new selection so the highlight moves.
  for (const h of [previous, hex]) {
    const m = markers.get(h);
    if (m) m.getElement()?.querySelector('.plane')?.classList.toggle('plane--selected', h === hex);
  }
  const marker = markers.get(hex);
  if (!marker) return;
  if (pan) map.panTo(marker.getLatLng());
}
