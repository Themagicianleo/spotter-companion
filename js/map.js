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

// A simple top-down airplane drawn pointing north (up). We rotate it to the aircraft's track.
const PLANE_SVG =
  '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">' +
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
    iconSize: [28, 28],
    iconAnchor: [14, 14], // center of the icon sits on the aircraft position
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
  const extra = [ac.typeCode, ac.routeLabel, ac.onGround ? 'on ground' : ac.altitudeFt === null ? null : `${ac.altitudeFt.toLocaleString('en')} ft`];
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
  const baseLayers = {
    // The same OpenStreetMap tiles, darkened in the browser with a CSS filter (.tiles-dark)
    // so the map matches the dark interface. The tiles themselves are unchanged.
    'Dark map': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      className: 'tiles-dark',
      attribution: osmAttribution,
    }),
    // OpenStreetMap's standard tiles. Their tile policy requires this attribution.
    Map: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }),
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
  };
  baseLayers[loadBaseLayerName()].addTo(map);
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
function loadBaseLayerName() {
  try {
    const saved = localStorage.getItem(BASE_LAYER_KEY);
    return ['Map', 'Satellite', 'Dark map'].includes(saved) ? saved : 'Dark map';
  } catch {
    return 'Dark map';
  }
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
