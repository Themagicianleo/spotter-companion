// types.test.mjs: checks data/aircraft_types.json follows the rules. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { types } = JSON.parse(readFileSync(new URL('../data/aircraft_types.json', import.meta.url)));

// The original list, plus the additions made after checking against Doc 8643 / tar1090-db.
const REQUIRED = `BCS1 BCS3 A318 A319 A320 A321 A19N A20N A21N A306 A310 A332 A333 A338 A339 A342 A343 A345 A346
  A359 A35K A388 B712 B721 B722 B733 B734 B735 B736 B737 B738 B739 B37M B38M B39M B3XM B741 B742 B743 B744 B748
  B752 B753 B762 B763 B764 B772 B77L B773 B77W B788 B789 B78X  B732 A30B B74S B778 B779`.split(/\s+/);

test('every required ICAO code is present exactly once', () => {
  const codes = types.map((t) => t.icao);
  assert.equal(new Set(codes).size, codes.length, 'duplicate code');
  for (const code of REQUIRED) assert.ok(codes.includes(code), `missing ${code}`);
});

test('every row has the required fields and at least one source with a URL', () => {
  for (const t of types) {
    assert.match(t.icao, /^[A-Z0-9]{2,4}$/, t.icao);
    for (const key of ['model', 'manufacturer', 'family']) assert.ok(t[key], `${t.icao} ${key}`);
    assert.ok([2, 3, 4].includes(t.engineCount), `${t.icao} engineCount`);
    assert.ok(t.engineOptions.length > 0, `${t.icao} engineOptions`);
    for (const e of t.engineOptions) {
      assert.ok(e.maker && e.model, `${t.icao} engine maker/model`);
      assert.equal(typeof e.verified, 'boolean', `${t.icao} engine verified flag`);
    }
    assert.ok(t.source.length > 0 && t.source.every((s) => s.name && /^https?:\/\//.test(s.url)), `${t.icao} source`);
  }
});

test('row verification label matches its engine options', () => {
  for (const t of types) {
    const v = t.engineOptions.map((e) => e.verified);
    const expected = v.every(Boolean) ? 'verified-secondary' : v.some(Boolean) ? 'partly-unverified' : 'unverified';
    assert.equal(t.verification, expected, t.icao);
  }
});
