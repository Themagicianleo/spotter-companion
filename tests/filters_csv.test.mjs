// filters_csv.test.mjs: tests for Phase 2 logic. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeAircraft } from '../js/api.js';
import { parseFilterInputs, applyFilters, sortAircraft } from '../js/filters.js';
import { toCsv } from '../js/csv.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/point_response.synthetic.json', import.meta.url)));
const all = fixture.ac.map(normalizeAircraft);
const callsigns = (list) => list.map((a) => a.callsign);

test('no filters keeps everything', () => {
  assert.equal(applyFilters(all, parseFilterInputs({})).length, all.length);
});

test('type filter is case-insensitive and accepts a comma list', () => {
  const out = applyFilters(all, parseFilterInputs({ types: 'a359, b38m' }));
  assert.deepEqual(callsigns(out), ['TST101', 'TST202']);
});

test('prefix filter matches the start of the callsign only', () => {
  assert.deepEqual(callsigns(applyFilters(all, parseFilterInputs({ prefix: 'tst2' }))), ['TST202']);
  assert.equal(applyFilters(all, parseFilterInputs({ prefix: '101' })).length, 0);
});

test('altitude range: ground counts as 0 ft, unknown altitude is excluded', () => {
  const low = applyFilters(all, parseFilterInputs({ maxAlt: '10000' }));
  assert.deepEqual(callsigns(low), ['XYZ9', null, 'NOPOS1']); // ground, 4500 ft, 8000 ft
  const noGround = applyFilters(all, parseFilterInputs({ maxAlt: '10000', includeGround: false }));
  assert.equal(noGround.some((a) => a.onGround), false);
});

test('sorting puts missing values last in both directions', () => {
  const asc = sortAircraft(all, 'squawk', 'asc').map((a) => a.squawk);
  const desc = sortAircraft(all, 'squawk', 'desc').map((a) => a.squawk);
  assert.deepEqual(asc.slice(0, 2), ['2301', '4512']);
  assert.deepEqual(desc.slice(0, 2), ['4512', '2301']);
  assert.equal(asc.at(-1), null);
  assert.equal(desc.at(-1), null);
});

test('CSV: header, empty cells for unknown, source column, and safe escaping', () => {
  const csv = toCsv(all.slice(0, 1), 'adsb.lol (ODbL 1.0)');
  const [header, row] = csv.trim().split('\r\n');
  assert.ok(header.startsWith('hex,callsign,registration,type'));
  assert.ok(header.endsWith(',source'));
  assert.ok(row.startsWith('7fff01,TST101,TEST-A,A359'));
  assert.ok(row.endsWith(',adsb.lol (ODbL 1.0)'));

  const tricky = [{ ...all[3], callsign: '=HYPERLINK("x")', registration: 'A,B' }];
  const trickyRow = toCsv(tricky).trim().split('\r\n')[1];
  assert.ok(trickyRow.includes(`"'=HYPERLINK(""x"")"`), trickyRow); // formula neutralised and quoted
  assert.ok(trickyRow.includes('"A,B"'));
  assert.ok(trickyRow.includes(',,')); // unknown values are empty cells
});
