// unit.test.mjs: tests for the pure logic (no browser needed).
// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeAircraft } from '../js/api.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/point_response.synthetic.json', import.meta.url)));
const list = fixture.ac.map(normalizeAircraft);

test('normalize: reads documented fields and trims callsign padding', () => {
  const a = list[0];
  assert.equal(a.callsign, 'TST101');
  assert.equal(a.registration, 'TEST-A');
  assert.equal(a.typeCode, 'A359');
  assert.equal(a.altitudeFt, 12000);
  assert.equal(a.verticalRateFpm, -1280);
  assert.equal(a.distanceNm, 8.4);
});

test('normalize: "ground" altitude becomes onGround, track falls back to true_heading', () => {
  const a = list[2];
  assert.equal(a.onGround, true);
  assert.equal(a.altitudeFt, null);
  assert.equal(a.trackDeg, 200);
});

test('normalize: missing fields become null, never undefined or a guess', () => {
  const a = list[3];
  for (const key of ['callsign', 'registration', 'typeCode', 'operator', 'yearBuilt', 'squawk', 'trackDeg', 'groundSpeedKt']) {
    assert.equal(a[key], null, key);
  }
});

test('normalize: aircraft without position keep lat/lon null', () => {
  assert.equal(list[4].lat, null);
  assert.equal(list[4].lon, null);
});

test('icon size follows the ADS-B emitter category; A380 biggest; unknown is medium', async () => {
  const { iconSize } = await import('../js/map.js');
  assert.ok(iconSize({ category: 'A1' }) < iconSize({ category: 'A2' }));
  assert.ok(iconSize({ category: 'A2' }) < iconSize({ category: 'A3' }));
  assert.ok(iconSize({ category: 'A3' }) < iconSize({ category: 'A5' }));
  assert.ok(iconSize({ category: 'A5', typeCode: 'A388' }) > iconSize({ category: 'A5' }));
  assert.equal(iconSize({ category: null }), iconSize({ category: 'A3' }));
  assert.equal(iconSize({ category: 'A0' }), iconSize({ category: 'A3' }));
});

test('normalize: emitter category is read when present', () => {
  assert.equal(normalizeAircraft({ hex: 'abcdef', category: 'A5' }).category, 'A5');
  assert.equal(normalizeAircraft({ hex: 'abcdef' }).category, null);
});

test('plane shapes: widebody, four-engine, A380, turboprop, helicopter, light, default narrow', async () => {
  const { shapeFor } = await import('../js/map.js');
  const { SHAPES } = await import('../js/shapes.js');
  const cases = [
    [{ typeCode: 'B77W', category: 'A5' }, 'wide'], [{ typeCode: 'B744', category: 'A5' }, 'quad'],
    [{ typeCode: 'A388', category: 'A5' }, 'a380'], [{ typeCode: 'AT76', category: 'A2' }, 'turboprop'],
    [{ typeCode: 'EC35', category: 'A7' }, 'helicopter'], [{ typeCode: 'C172', category: 'A1' }, 'light'],
    [{ typeCode: 'GLF6', category: 'A2' }, 'bizjet'], [{ typeCode: 'A20N', category: 'A3' }, 'narrow'],
    [{ typeCode: null, category: null }, 'narrow'],
  ];
  for (const [ac, shape] of cases) {
    assert.equal(shapeFor(ac), shape, JSON.stringify(ac));
    assert.ok(SHAPES[shape].includes('<'), `${shape} has a drawing`);
  }
});

test('airline from callsign; registrations used as callsigns are not airlines', async () => {
  const { airlineFor } = await import('../js/airlines.js');
  assert.equal(airlineFor('SIA321'), null); // not loaded yet -> null, never a guess
});

test('airfleets.net link: search URL for the registration, nothing when unknown', async () => {
  const { airfleetsUrl } = await import('../js/infoPanel.js');
  assert.equal(airfleetsUrl('9V-SCP'), 'https://www.airfleets.net/recherche/?key=9V-SCP');
  assert.equal(airfleetsUrl(' 9v-scp '), 'https://www.airfleets.net/recherche/?key=9V-SCP');
  assert.equal(airfleetsUrl('9V"><x'), 'https://www.airfleets.net/recherche/?key=9VX');
  assert.equal(airfleetsUrl(null), null);
  assert.equal(airfleetsUrl(''), null);
});

test('web-app manifest: name, start URL and every icon file exists', async () => {
  const { existsSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('../manifest.webmanifest', import.meta.url)));
  assert.equal(manifest.name, 'SkyWatch');
  assert.ok(manifest.short_name.length <= 12, 'fits under a home-screen icon');
  assert.equal(manifest.start_url, './'); // relative, so it works under /spotter-companion/ on GitHub Pages
  for (const icon of manifest.icons) assert.ok(existsSync(new URL(`../${icon.src}`, import.meta.url)), icon.src);
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const ref of ['manifest.webmanifest', 'icons/apple-touch-icon.png', 'apple-mobile-web-app-title']) assert.ok(html.includes(ref), ref);
});
