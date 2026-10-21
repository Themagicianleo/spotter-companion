// map.js
// Everything to do with the Leaflet map: tiles, the search-radius circle, and one rotating
// plane marker per aircraft. `L` is the global object created by vendor/leaflet/leaflet.js.

import * as fmt from './format.js';

let map;
let radiusCircle;
let trackLayer; // the selected aircraft's track (a group of coloured line segments)
let trackLegend;
const markers = new Map(); // hex -> Leaflet marker, so we move markers instead of recreating them
let onSelect = () => {}; // set by app.js: what to do when a plane is clicked
let selectedHex = null;

// A simple top-down airplane drawn pointing north (up). We rotate it to the aircraft's track.
const PLANE_SVG =
  '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
  '<path d="M12 2c.8 0 1.3.9 1.3 2v5.2l7.7 4.6v2l-7.7-2.3v4.6l2.2 1.7v1.6L12 20.4l-3.5 1.2V20l2.2-1.7v-4.6L3 16v-2l7.7-4.6V4c0-1.1.5-2 1.3-2z"/>' +
  '</svg>';

function planeIcon(ac) {
  // No track known? Draw it pointing north but faded, so you can tell it's not a real heading.
  const rotation = ac.trackDeg ?? 0;
  const classes = ['plane'];
  if (ac.trackDeg === null) classes.push('plane--no-track');
  if (ac.onGround) classes.push('plane--ground');
  if (ac.hex === selectedHex) classes.push('plane--selected');
  return L.divIcon({
    className: 'plane-icon', // Leaflet's wrapper; the rotation goes on the inner div
    html: `<div class="${classes.join(' ')}" style="transform: rotate(${rotation}deg)">${PLANE_SVG}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13], // center of the icon sits on the aircraft position
  });
}

// Build the popup with DOM methods, not innerHTML: callsigns come from the internet, and
// textContent guarantees they are shown as text and never run as code.
function popupContent(ac) {
  const box = document.createElement('div');
  box.className = 'popup';
  const title = document.createElement('strong');
  title.textContent = ac.callsign ?? ac.registration ?? ac.hex;
  box.append(title);

  const rows = [
    ['Callsign', fmt.text(ac.callsign)],
    ['Registration', fmt.text(ac.registration)],
    ['Type', fmt.text(ac.typeCode)],
    ['Altitude', fmt.altitude(ac)],
    ['Ground speed', fmt.speed(ac.groundSpeedKt)],
    ['Vertical speed', fmt.verticalRate(ac.verticalRateFpm)],
    ['Squawk', fmt.text(ac.squawk)],
  ];
  const table = document.createElement('table');
  for (const [label, value] of rows) {
    const tr = table.insertRow();
    tr.insertCell().textContent = label;
    tr.insertCell().textContent = value;
  }
  box.append(table);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'popup__more';
  more.textContent = 'Aircraft info →';
  more.addEventListener('click', () => onSelect(ac.hex, { openPanel: true }));
  box.append(more);
  return box;
}

export function initMap(elementId, center, radiusNm, attributionHtml, selectHandler) {
  onSelect = selectHandler;
  map = L.map(elementId).setView([center.lat, center.lon], 9);

  // OpenStreetMap's standard tiles. Their tile policy requires this attribution.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(map);
  map.attributionControl.addAttribution(attributionHtml);

  radiusCircle = L.circle([center.lat, center.lon], {
    radius: radiusNm * 1852, // Leaflet wants metres
    color: '#3b82f6',
    weight: 1,
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
  // One short line per pair of points, so each piece can have its own altitude colour.
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: altColor(b.alt), weight: 3, opacity: 0.9, interactive: false }).addTo(trackLayer);
  }
  trackLegend.addTo(map);
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
      marker = L.marker([ac.lat, ac.lon], { icon: planeIcon(ac), title: ac.callsign ?? ac.hex });
      marker.on('click', () => onSelect(ac.hex, { openPanel: false }));
      marker.bindPopup('');
      marker.addTo(map);
      markers.set(ac.hex, marker);
    } else {
      marker.setLatLng([ac.lat, ac.lon]);
      marker.setIcon(planeIcon(ac));
    }
    // Keep the popup's numbers fresh if it's open.
    marker.setPopupContent(popupContent(ac));
  }
  for (const [hex, marker] of markers) {
    if (!seen.has(hex)) {
      marker.remove();
      markers.delete(hex);
    }
  }
}

// Highlight one aircraft and (optionally) open its popup and pan to it.
export function selectAircraft(hex, { pan = false, openPopup = false } = {}) {
  const previous = selectedHex;
  selectedHex = hex;
  if (hex === null) map.closePopup();
  // Re-draw the old and new selection so the highlight moves.
  for (const h of [previous, hex]) {
    const m = markers.get(h);
    if (m) m.getElement()?.querySelector('.plane')?.classList.toggle('plane--selected', h === hex);
  }
  const marker = markers.get(hex);
  if (!marker) return;
  if (pan) map.panTo(marker.getLatLng());
  if (openPopup) marker.openPopup();
}
