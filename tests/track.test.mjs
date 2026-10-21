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

test('recorded positions from the recorder come first, then the page\'s own', async () => {
  const realFetch = globalThis.fetch;
  // t in seconds. 0 = an earlier flight (hours before), 9000/9060 = this flight, 99999 = after the page's first point.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ points: [
    { t: 0, lat: 5, lon: 100, alt: 0 }, { t: 9000, lat: 1, lon: 103, alt: 1000 }, { t: 9060, lat: 1.1, lon: 103.1, alt: null }, { t: 99999, lat: 9, lon: 9, alt: 0 },
  ] }) });
  try {
    const { loadRecordedTrack } = await import('../js/track.js');
    recordPositions([plane(1.5, { hex: 'cccccc' })], 9_120_000); // page's own first point at t=9120 s
    assert.equal(await loadRecordedTrack('cccccc'), true);
    const t = getTrack('cccccc');
    // kept: the two recorded points of this flight, then the page's own point.
    // dropped: the earlier flight (2.5 h gap) and the point overlapping the page's own.
    assert.deepEqual(t.map((p) => p.lat), [1, 1.1, 1.5]);
    assert.equal(t[0].recorded, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
