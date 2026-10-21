// track.test.mjs: position history used for tracks. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordPositions, getTrack } from '../js/track.js';

const plane = (lat, extra = {}) => ({ hex: 'aaaaaa', lat, lon: 103.8, altitudeFt: 5000, onGround: false, ...extra });

test('records moves, skips repeated positions and aircraft without a position', () => {
  recordPositions([plane(1.0), { hex: 'bbbbbb', lat: null, lon: null }], 0);
  recordPositions([plane(1.0)], 10_000); // same position again: not added
  recordPositions([plane(1.1, { onGround: true, altitudeFt: null })], 20_000);
  assert.deepEqual(getTrack('aaaaaa').map((p) => [p.lat, p.alt]), [[1.0, 5000], [1.1, 0]]);
  assert.deepEqual(getTrack('bbbbbb'), []);
});

test('forgets aircraft not seen for 15 minutes', () => {
  recordPositions([plane(1.2)], 30_000);
  recordPositions([], 30_000 + 16 * 60 * 1000);
  assert.deepEqual(getTrack('aaaaaa'), []);
});
