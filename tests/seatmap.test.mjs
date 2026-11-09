// seatmap.test.mjs: checks the aeroLOPA links are built safely. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aerolopaTypeSlug, aerolopaTypeUrl, aerolopaAirlineUrl, aerolopaUrl } from '../js/seatmap.js';

const { types } = JSON.parse(readFileSync(new URL('../data/aircraft_types.json', import.meta.url)));
const byCode = (c) => types.find((t) => t.icao === c);

test('type slugs follow the aeroLOPA pattern', () => {
  assert.equal(aerolopaTypeUrl(byCode('A359')), 'https://www.aerolopa.com/aircraft/airbus-a350-900');
  assert.equal(aerolopaTypeSlug(byCode('B77W')), 'boeing-777-300er');
  assert.equal(aerolopaTypeSlug(byCode('B772')), 'boeing-777-200');
  assert.equal(aerolopaTypeSlug(byCode('B738')), 'boeing-737-800');
  assert.equal(aerolopaTypeSlug(byCode('A21N')), 'airbus-a321neo');
});

test('every type in the table gets a clean slug', () => {
  for (const t of types) assert.match(aerolopaTypeSlug(t) ?? '', /^[a-z0-9]+(-[a-z0-9]+)+$/, t.icao);
});

test('airline links need a two-character IATA code', () => {
  assert.equal(aerolopaAirlineUrl('SQ'), 'https://www.aerolopa.com/sq');
  assert.equal(aerolopaAirlineUrl('3K'), 'https://www.aerolopa.com/3k');
  for (const bad of [null, undefined, '', 'S', 'SIA', '../x', 'S/']) assert.equal(aerolopaAirlineUrl(bad), null, String(bad));
});

test('the airline page wins; the type page is the fallback; nothing known gives null', () => {
  const type = byCode('A359');
  assert.equal(aerolopaUrl({ airlineIata: 'SQ', type }), 'https://www.aerolopa.com/sq');
  assert.equal(aerolopaUrl({ type }), 'https://www.aerolopa.com/aircraft/airbus-a350-900');
  assert.equal(aerolopaUrl({}), null);
  assert.equal(aerolopaUrl(), null);
});
