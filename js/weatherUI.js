// weatherUI.js
// The Weather drawer and the little summary on the top-bar Weather button.

import { getWeather, favouredRunway, describeCover, WEATHER_REFRESH_MS } from './weather.js';

const STATION_KEY = 'spotters-companion:weather-station';
let panel;
let button;
let station = 'WSSS';
let latest = null; // { metar, taf, fetchedAt } or { error }
let timer = null;

try {
  const saved = localStorage.getItem(STATION_KEY);
  if (/^[A-Z0-9]{4}$/.test(saved ?? '')) station = saved;
} catch {
  // storage blocked: use Changi
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const ago = (ms) => {
  const min = Math.round((Date.now() - ms) / 60000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`;
};

function windText(m) {
  if (m.windKt === null) return 'Unknown';
  if (m.windKt === 0) return 'Calm';
  const dir = m.windVariable || m.windDir === null ? 'Variable' : `${String(m.windDir).padStart(3, '0')}°`;
  return `${dir} at ${m.windKt} kt${m.gustKt ? `, gusting ${m.gustKt} kt` : ''}`;
}

function visibilityText(m) {
  if (m.cavok) return 'CAVOK (10 km or more, no significant cloud or weather)';
  if (m.visibilityM === null) return 'Unknown';
  if (m.visibilityM >= 9999) return '10 km or more';
  return m.visibilityM < 5000 ? `${m.visibilityM} m` : `${(m.visibilityM / 1000).toFixed(m.visibilityM % 1000 ? 1 : 0)} km`;
}

function updateButton() {
  const m = latest?.metar;
  if (!m) {
    button.textContent = 'Weather';
    return;
  }
  const bits = [];
  if (m.tempC !== null) bits.push(`${m.tempC}°`);
  if (m.windKt !== null) bits.push(m.windKt === 0 ? 'calm' : `${m.windKt}${m.gustKt ? `G${m.gustKt}` : ''} kt`);
  if (m.weather.some((w) => /TS/.test(w.code))) bits.push('⚡');
  button.textContent = bits.length ? `${station} ${bits.join(' ')}` : 'Weather';
  button.title = `Weather at ${station}: ${m.raw}`;
}

function render() {
  if (!panel) return;
  const parts = [h('h2', null, 'Weather')];
  const form = h('form', 'wx-form');
  const input = h('input');
  input.value = station;
  input.maxLength = 4;
  input.setAttribute('aria-label', 'Airport ICAO code');
  input.autocapitalize = 'characters';
  const go = h('button', 'primary', 'Show');
  go.type = 'submit';
  form.append(h('label', 'muted', 'Airport (ICAO code)'), input, go);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = input.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) return;
    station = code;
    try {
      localStorage.setItem(STATION_KEY, code);
    } catch {
      // optional
    }
    latest = null;
    render();
    refresh();
  });
  parts.push(form);

  if (!latest) {
    parts.push(h('p', 'muted', 'Loading…'));
  } else if (latest.error) {
    parts.push(h('p', 'info__warn', latest.error));
  } else if (!latest.metar) {
    parts.push(h('p', 'muted', `No recent METAR for ${station}. Check the ICAO code (e.g. WSSS for Changi, WSSL for Seletar).`));
  } else {
    const m = latest.metar;
    parts.push(h('p', 'wx-station', `${m.name ?? m.station}`));
    parts.push(h('p', 'muted', m.observedMs ? `Observed ${new Date(m.observedMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${ago(m.observedMs)})` : ''));
    const dl = h('dl', 'facts wx-facts');
    const add = (label, value) => dl.append(h('dt', null, label), h('dd', null, value));
    add('Wind', windText(m));
    add('Visibility', visibilityText(m));
    if (m.weather.length) add('Weather', m.weather.map((w) => `${w.text} (${w.code})`).join(', '));
    add('Cloud', m.clouds.length
      ? m.clouds.map((c) => `${describeCover(c.cover)} ${c.baseFt.toLocaleString('en')} ft${c.type === 'CB' ? ' (cumulonimbus)' : c.type === 'TCU' ? ' (towering cumulus)' : ''}`).join(', ')
      : m.cavok ? 'None significant' : 'None reported');
    if (m.tempC !== null) add('Temperature', `${m.tempC} °C (dew point ${m.dewpointC ?? '?'} °C)`);
    if (m.qnhHpa !== null) add('QNH', `${Math.round(m.qnhHpa)} hPa`);
    if (m.flightCategory) add('Flight category', m.flightCategory);
    parts.push(dl);
    const rw = favouredRunway(m.station, m);
    if (rw) {
      parts.push(h('p', 'wx-runway', `Wind favours runway ${rw.runway} direction at ${rw.label}: ${rw.headwindKt} kt headwind, ${rw.crosswindKt} kt crosswind.`));
      parts.push(h('p', 'muted', 'Only a hint: air traffic control picks the runway, and light winds often don\'t decide it.'));
    } else if (m.station === 'WSSS') {
      parts.push(h('p', 'muted', 'Wind too light or variable to favour a runway direction.'));
    }
    parts.push(h('h3', null, 'Report as sent (METAR)'));
    parts.push(h('pre', 'wx-raw', m.raw));
  }
  if (latest?.taf) {
    parts.push(h('h3', null, 'Forecast (TAF)'));
    parts.push(h('pre', 'wx-raw', latest.taf));
  }
  const credit = h('p', 'credits');
  const link = h('a', null, 'NOAA Aviation Weather Center');
  link.href = 'https://aviationweather.gov';
  link.target = '_blank';
  link.rel = 'noopener';
  credit.append('Weather: ', link, ' (aviationweather.gov, US public domain). Updated every 10 minutes. Not for flight planning.');
  parts.push(credit);
  panel.replaceChildren(...parts);
}

async function refresh() {
  clearTimeout(timer);
  try {
    latest = await getWeather(station);
  } catch (err) {
    latest = { error: `Weather unavailable: ${err.message}` };
  }
  updateButton();
  if (!panel.hidden) render();
  timer = setTimeout(refresh, WEATHER_REFRESH_MS);
}

export function initWeather(panelElement, buttonElement) {
  panel = panelElement;
  button = buttonElement;
  render();
  refresh();
}

export function showWeather() {
  render();
}
