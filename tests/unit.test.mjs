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
