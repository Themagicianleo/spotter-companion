// photos.test.mjs: Planespotters response parsing. Run with: npm test
// Fixture shape copied from open-source projects' Planespotters fixtures; values are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePhotos } from '../js/photos.js';

const good = {
  photos: [{
    id: '1',
    thumbnail: { src: 'https://t.plnspttrs.net/1/1_t.jpg', size: { width: 200, height: 133 } },
    thumbnail_large: { src: 'https://t.plnspttrs.net/1/1_280.jpg', size: { width: 420, height: 280 } },
    link: 'https://www.planespotters.net/photo/1/test?utm_source=api',
    photographer: 'Test Photographer',
  }],
};

test('uses the large thumbnail, the photo page link and the photographer', () => {
  assert.deepEqual(parsePhotos(good), {
    src: 'https://t.plnspttrs.net/1/1_280.jpg',
    pageUrl: 'https://www.planespotters.net/photo/1/test?utm_source=api',
    photographer: 'Test Photographer',
  });
});

test('no photos -> null; missing photographer -> null (shown as Unknown photographer)', () => {
  assert.equal(parsePhotos({ photos: [] }), null);
  const p = structuredClone(good);
  delete p.photos[0].photographer;
  assert.equal(parsePhotos(p).photographer, null);
});

test('rejects unexpected shapes and URLs outside planespotters', () => {
  assert.throws(() => parsePhotos({ error: 'x' }));
  const bad = structuredClone(good);
  bad.photos[0].thumbnail_large.src = 'https://evil.example/x.jpg';
  bad.photos[0].thumbnail.src = 'javascript:alert(1)';
  assert.equal(parsePhotos(bad), null);
  const badLink = structuredClone(good);
  badLink.photos[0].link = 'https://evil.example/';
  assert.equal(parsePhotos(badLink), null);
});

test('normalizeModel handles the real OpenSky spellings', async () => {
  const { normalizeModel } = await import('../js/aircraftDb.js');
  assert.equal(normalizeModel('Airbus A320-251N'), 'A320-251N');
  assert.equal(normalizeModel('A320 251NSL'), 'A320-251N');
  assert.equal(normalizeModel('AIRBUS A320-214'), 'A320-214');
  assert.equal(normalizeModel('A321-271NX'), 'A321-271NX');
  assert.equal(normalizeModel('A350-1041'), 'A350-1041');
  assert.equal(normalizeModel('Airbus A330-343(P2F)'), 'A330-343');
  assert.equal(normalizeModel('A320-211 (Airbus)'), 'A320-211');
  assert.equal(normalizeModel('737-824'), null); // Boeing customer code: no engine info
  assert.equal(normalizeModel('Airbus (various models)'), null);
  assert.equal(normalizeModel(null), null);
});
