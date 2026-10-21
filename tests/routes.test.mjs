// routes.test.mjs: callsign normalisation and route plausibility. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCallsign, distanceToSegmentNm, isPlausible } from '../js/routes.js';

test('callsigns are normalised like the standing data README examples', () => {
  assert.equal(normalizeCallsign('EZY1200'), 'EZY1200');
  assert.equal(normalizeCallsign('EZY0001'), 'EZY1');
  assert.equal(normalizeCallsign('EZY0000'), 'EZY0');
  assert.equal(normalizeCallsign('EZY00AB'), 'EZY0AB');
  assert.equal(normalizeCallsign('sia0321 '), 'SIA321');
  assert.equal(normalizeCallsign('9VSJA'), null); // registration, no route
  assert.equal(normalizeCallsign('SIA12345'), null); // number too long
  assert.equal(normalizeCallsign(null), null);
});

// Real airport coordinates from the standing data.
const ZSFZ = { lat: 25.935101, lon: 119.663002 }; // Fuzhou
const WSSS = { lat: 1.35019, lon: 103.994003 }; // Singapore Changi
const EGLL = { lat: 51.4706, lon: -0.461941 }; // London Heathrow

test('distance to a route leg', () => {
  assert.ok(distanceToSegmentNm(WSSS, ZSFZ, WSSS) < 0.01); // at the end of the leg
  // The great-circle midpoint of Fuzhou-Changi lies exactly on the leg...
  const midpoint = { lat: 13.76596720503663, lon: 111.41156788991924 };
  assert.ok(distanceToSegmentNm(midpoint, ZSFZ, WSSS) < 0.01);
  // ...one degree north of it is about 31 nm off (the leg runs diagonally).
  const off = distanceToSegmentNm({ lat: midpoint.lat + 1, lon: midpoint.lon }, ZSFZ, WSSS);
  assert.ok(off > 30 && off < 32, String(off));
});

test('plausibility: near the route yes, far away no', () => {
  assert.equal(isPlausible({ lat: 1.6, lon: 104.3 }, [ZSFZ, WSSS]), true); // approaching Changi
  assert.equal(isPlausible({ lat: -8.7, lon: 115.2 }, [ZSFZ, WSSS]), false); // over Bali
  assert.equal(isPlausible({ lat: 1.4, lon: 103.9 }, [EGLL, WSSS]), true);
});

test('route progress: 0 at origin, about halfway at the midpoint, 1 at destination', async () => {
  const { routeProgress } = await import('../js/routes.js');
  assert.ok(routeProgress(ZSFZ, [ZSFZ, WSSS]) < 0.01);
  const half = routeProgress({ lat: 13.76596720503663, lon: 111.41156788991924 }, [ZSFZ, WSSS]);
  assert.ok(Math.abs(half - 0.5) < 0.01, String(half));
  assert.ok(routeProgress(WSSS, [ZSFZ, WSSS]) > 0.99);
  assert.equal(routeProgress(null, [ZSFZ, WSSS]), null);
});

test('route length, distance to go, arrival estimate and takeoff detection', async () => {
  const { routeLengthNm, remainingNm, estimateArrival, findTakeoff, distanceNm } = await import('../js/routes.js');
  const length = routeLengthNm([ZSFZ, WSSS]);
  assert.ok(Math.abs(length - distanceNm(ZSFZ, WSSS)) < 1e-9);
  assert.ok(length > 1500 && length < 1800, String(length)); // Fuzhou-Changi is about 1,730 nm (3,200 km)
  const midpoint = { lat: 13.76596720503663, lon: 111.41156788991924 };
  assert.ok(Math.abs(remainingNm(midpoint, [ZSFZ, WSSS]) - length / 2) < 1);
  // Halfway at 480 kt: about length/2/480 hours from now.
  const eta = estimateArrival({ ...midpoint, onGround: false, groundSpeedKt: 480 }, [ZSFZ, WSSS], 0);
  assert.ok(Math.abs(eta.getTime() - (length / 2 / 480) * 3_600_000) < 60_000);
  assert.equal(estimateArrival({ ...midpoint, onGround: true, groundSpeedKt: 0 }, [ZSFZ, WSSS]), null);
  // Takeoff: ground point at Fuzhou then airborne -> time of the first airborne point.
  const track = [{ ...ZSFZ, alt: 0, time: 1000 }, { lat: 25.9, lon: 119.6, alt: 1500, time: 2000 }, { lat: 25, lon: 119, alt: 9000, time: 3000 }];
  assert.equal(findTakeoff(track, ZSFZ), 2000);
  assert.equal(findTakeoff(track.slice(1), ZSFZ), null); // never seen on the ground: unknown
  assert.equal(findTakeoff(track, WSSS), null); // ground point wasn't at the origin
});

test('current leg of a multi-stop route', async () => {
  const { currentLegEnd } = await import('../js/routes.js');
  const YSSY = { lat: -33.946098, lon: 151.177002 }; // Sydney
  assert.equal(currentLegEnd({ lat: -20, lon: 130 }, [YSSY, WSSS, EGLL]), 1); // over Australia: SYD -> SIN
  assert.equal(currentLegEnd({ lat: 25, lon: 70 }, [YSSY, WSSS, EGLL]), 2); // over Arabian Sea: SIN -> LHR
  assert.equal(currentLegEnd(null, [YSSY, WSSS, EGLL]), null);
});
