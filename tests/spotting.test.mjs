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
  // Real response from 22 Oct 2026: visibility can come as text ("6+" miles) and the raw report has a
  // variable-direction group (330V030). Visibility then comes from the raw "9999" (10 km or more).
  const m2 = parseMetar([{ ...REAL_METAR[0], visib: '6+', wdir: 360, wspd: 7, rawOb: 'METAR WSSS 220630Z 36007KT 330V030 9999 FEW020 BKN280 31/25 Q1010 NOSIG' }]);
  assert.equal(m2.visibilityM, 9999);
  assert.deepEqual(m2.weather, []);
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

test('log import: reads our own export back (round trip), no duplicates, formulas un-escaped', async () => {
  const { defaultSpotting, logSighting, logCsv, importLogCsv, parseCsv } = await import('../js/spotting.js');
  const a = defaultSpotting();
  logSighting(a, { hex: '76cd41', registration: '9V-SJA', typeCode: 'A359', typeDescription: 'AIRBUS A-350-900', callsign: 'SIA321', routeLabel: 'LHR → SIN', airline: { name: 'Singapore Airlines' } }, new Date(2026, 9, 21, 14, 5).getTime());
  logSighting(a, { hex: '76cd41', callsign: '=SIA1' }, new Date(2026, 9, 22, 9, 30).getTime());
  logSighting(a, { hex: '750596', registration: '9M-MNL', typeCode: 'A339', callsign: 'MAS144' }, new Date(2026, 9, 22, 10, 0).getTime());
  const csv = logCsv(a.log);

  const b = defaultSpotting();
  const r = importLogCsv(b, csv);
  assert.deepEqual(r, { added: 3, aircraft: 2, skipped: 0 });
  assert.equal(b.log['76cd41'].reg, '9V-SJA');
  assert.equal(b.log['76cd41'].airline, 'Singapore Airlines');
  assert.equal(b.log['76cd41'].sightings.length, 2);
  assert.equal(b.log['76cd41'].sightings[1].callsign, '=SIA1', 'the export\'s apostrophe is removed again');
  assert.equal(b.log['76cd41'].sightings[0].route, 'LHR → SIN');
  assert.equal(b.log['76cd41'].sightings[0].t, new Date(2026, 9, 21, 14, 5).getTime());
  assert.deepEqual(importLogCsv(b, csv), { added: 0, aircraft: 0, skipped: 3 }, 'importing twice adds nothing');
  assert.throws(() => importLogCsv(b, 'name,price\nx,1\n'), /not a SkyWatch log/);
  assert.deepEqual(parseCsv('a,"b, ""c"""\r\n1,2\n'), [['a', 'b, "c"'], ['1', '2']]);
});

test('log import: two sightings in the same minute both come across, and only once', async () => {
  const { defaultSpotting, logSighting, logCsv, importLogCsv } = await import('../js/spotting.js');
  const a = defaultSpotting();
  const t = new Date(2026, 9, 22, 9, 30, 5).getTime();
  logSighting(a, { hex: '7fff01', registration: 'TEST-A' }, t);
  logSighting(a, { hex: '7fff01' }, t + 20e3);
  const b = defaultSpotting();
  assert.equal(importLogCsv(b, logCsv(a.log)).added, 2);
  assert.equal(importLogCsv(b, logCsv(a.log)).added, 0);
});
