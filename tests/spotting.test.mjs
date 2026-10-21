// spotting.test.mjs: watchlist, alert rules, seen log, stats counting and METAR parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultSpotting, alertReasons, cleanWatchValue, watchMatches, logSighting, logCsv } from '../js/spotting.js';
import { topCounts, airlineCode, SessionTally, fillHours } from '../js/stats.js';
import { parseMetar, parseRawMetar, decodeWeather, favouredRunway } from '../js/weather.js';

const plane = (extra) => ({ hex: '76cd41', callsign: 'SIA321', registration: '9V-SJA', typeCode: 'A359', squawk: '2115', emergency: 'none', ...extra });

test('watchlist values are tidied and matched by kind', () => {
  assert.equal(cleanWatchValue('reg', ' 9v-sja '), '9V-SJA');
  assert.equal(cleanWatchValue('type', 'a 388'), 'A388');
  assert.equal(cleanWatchValue('hex', '76CD41xyz'), '76cd41');
  assert.ok(watchMatches(plane(), { kind: 'reg', value: '9VSJA' }), 'dash does not matter');
  assert.ok(watchMatches(plane(), { kind: 'callsign', value: 'SIA' }));
  assert.ok(!watchMatches(plane(), { kind: 'callsign', value: 'QFA' }));
  assert.ok(watchMatches(plane(), { kind: 'type', value: 'A359' }));
  assert.ok(watchMatches(plane(), { kind: 'hex', value: '76cd41' }));
  assert.ok(!watchMatches(plane({ registration: null }), { kind: 'reg', value: '9V-SJA' }));
});

test('alert reasons: watchlist, rare type, flags, squawks; switches turn them off', () => {
  const s = defaultSpotting();
  assert.deepEqual(alertReasons(plane(), s), [], 'an ordinary A350 is not an alert');
  s.watch.push({ kind: 'reg', value: '9V-SJA' });
  assert.deepEqual(alertReasons(plane(), s).map((r) => r.kind), ['watch']);
  assert.deepEqual(alertReasons(plane({ typeCode: 'A124' }), s).map((r) => r.kind), ['watch', 'rare']);
  assert.deepEqual(alertReasons(plane(), s, { military: true, interesting: true }).map((r) => r.kind), ['watch', 'military', 'interesting']);
  const sq = alertReasons(plane({ squawk: '7700' }), s);
  assert.equal(sq[0].kind, 'emergency');
  assert.match(sq[0].text, /7700 \(emergency\)/);
  assert.equal(alertReasons(plane({ emergency: 'minfuel' }), s)[0].text, 'Emergency: minfuel');
  s.alertOn.watch = false;
  s.alertOn.emergency = false;
  assert.deepEqual(alertReasons(plane({ squawk: '7700' }), s), []);
});

test('seen log: sightings add up and export as CSV (formulas neutralised)', () => {
  const s = defaultSpotting();
  logSighting(s, plane({ routeLabel: 'LHR → SIN', airline: { name: 'Singapore Airlines' } }), Date.UTC(2026, 9, 21, 6));
  logSighting(s, plane({ callsign: '=SIA1' }), Date.UTC(2026, 9, 22, 6));
  assert.equal(s.log['76cd41'].sightings.length, 2);
  assert.equal(s.log['76cd41'].airline, 'Singapore Airlines');
  const csv = logCsv(s.log).trim().split('\r\n');
  assert.equal(csv.length, 3);
  assert.match(csv[1], /9V-SJA,A359,,Singapore Airlines,SIA321,LHR → SIN,76cd41$/);
  assert.match(csv[2], /,'=SIA1,/);
});

test('stats: top counts with "Other", airline codes, session tally, empty hours filled', () => {
  const items = ['A', 'B', 'A', 'C', 'A', 'B', null].map((k) => ({ k }));
  assert.deepEqual(topCounts(items, (i) => i.k, 2), [{ key: 'A', count: 3 }, { key: 'B', count: 2 }, { key: 'Other', count: 1, other: true }]);
  assert.equal(airlineCode('SIA321'), 'SIA');
  assert.equal(airlineCode('9VSJA'), null);
  const tally = new SessionTally(0);
  tally.add([plane(), plane({ hex: 'abcdef', callsign: 'QFA1', typeCode: 'A388' })], 1);
  tally.add([plane()], 2);
  assert.equal(tally.list.length, 2);
  assert.deepEqual(fillHours([{ hour: 7200, aircraft: 5 }], 3600, 10800), [{ hour: 3600, aircraft: 0 }, { hour: 7200, aircraft: 5 }, { hour: 10800, aircraft: 0 }]);
});

// The real response for WSSS fetched on 21 Oct 2026 (see js/weather.js).
const REAL_METAR = [{ icaoId: 'WSSS', receiptTime: '2026-10-21T13:30:57.930Z', obsTime: 1792589400, reportTime: '2026-10-21T13:30:00.000Z', temp: 28, dewp: 25, wdir: 360, wspd: 4, visib: 5.59, altim: 1012, qcField: 16, metarType: 'METAR', rawOb: 'METAR WSSS 211330Z 36004KT 9000 FEW018 BKN280 28/25 Q1012 NOSIG', lat: 1.368, lon: 103.982, elev: 17, name: 'Singapore/Changi Intl, 4, SG', cover: 'BKN', clouds: [{ cover: 'FEW', base: 1800 }, { cover: 'BKN', base: 28000 }], fltCat: 'VFR' }];

test('METAR: real Changi response parses; runway hint from the wind', () => {
  const m = parseMetar(REAL_METAR);
  assert.equal(m.station, 'WSSS');
  assert.equal(m.windDir, 360);
  assert.equal(m.windKt, 4);
  assert.equal(m.visibilityM, 9000);
  assert.equal(m.qnhHpa, 1012);
  assert.deepEqual(m.clouds.map((c) => `${c.cover}${c.baseFt}`), ['FEW1800', 'BKN28000']);
  assert.equal(m.observedMs, 1792589400000);
  assert.equal(favouredRunway('WSSS', m).runway, '02');
  assert.equal(favouredRunway('WSSS', { ...m, windDir: 200, windKt: 12 }).runway, '20');
  assert.equal(favouredRunway('WSSS', { ...m, windKt: 2 }), null, 'too light to say');
  assert.equal(favouredRunway('KJFK', m), null, 'unknown runways: no guess');
  assert.equal(parseMetar([]), null);
  assert.throws(() => parseMetar({}), /Unexpected/);
});

test('METAR raw groups: gusts, weather, CB clouds, trend ignored', () => {
  const r = parseRawMetar('METAR WSSS 211330Z 22015G28KT 3000 -TSRA VCSH FEW015CB SCT020 25/24 Q1010 TEMPO 1500 +TSRA');
  assert.equal(r.gustKt, 28);
  assert.equal(r.visibilityM, 3000, 'TEMPO visibility is a forecast, not now');
  assert.deepEqual(r.weather.map((w) => w.code), ['-TSRA', 'VCSH']);
  assert.equal(r.clouds[0].type, 'CB');
  assert.equal(decodeWeather('HZ'), 'haze');
  assert.equal(decodeWeather('WSSS'), null);
  assert.equal(decodeWeather('Q1010'), null);
});

test('flags file: real hex lists, no privacy flags copied', () => {
  const doc = JSON.parse(readFileSync(new URL('../data/aircraft_flags.json', import.meta.url)));
  assert.ok(doc.military.length > 1000);
  assert.ok(doc.military.every((h) => /^[0-9a-f]{6}$/.test(h)));
  assert.deepEqual(Object.keys(doc).sort(), ['builtAt', 'interesting', 'military', 'note', 'source', 'sourceLastModified', 'sourceUrl']);
});
