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

test('Commons: real response shape, licence and author as plain text, title filter for reused registrations', async () => {
  const { parseCommons, plainText } = await import('../js/commons.js');
  // Trimmed from real API answers on 22 Oct 2026 (search for "9V-SMA").
  const page = (title, artist, license, index) => ({ pageid: index, ns: 6, title, index, imageinfo: [{ thumburl: `https://thumb.wikimedia.org/x/${index}.jpg`, thumbwidth: 640, thumbheight: 448, descriptionurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`, mime: 'image/jpeg',
    extmetadata: { Artist: { value: artist }, LicenseShortName: { value: license }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' } } }] });
  const data = { query: { pages: {
    1: page('File:17-12-04-Aeropuerto de Barcelona-El Prat-RalfR-DSCF0697.jpg', '<bdi><a href="https://www.wikidata.org/wiki/Q15080600"><span title="German civil engineer">Ralf Roletschek</span></a></bdi>', 'GFDL 1.2', 1),
    2: page('File:9V-SMA@HKG (20190414123010).jpg', '<a href="//commons.wikimedia.org/wiki/User:N509FZ" title="User:N509FZ">N509FZ</a>', 'CC BY-SA 4.0', 2),
    3: page('File:N5573B B747-412 Boeing Acft BFI 21MAR89 (6582356485).jpg', 'Ken Fielding', 'CC BY-SA 3.0', 3),
    4: { pageid: 4, ns: 6, title: 'File:9V-SMA video.webm', index: 4, imageinfo: [{ thumburl: 'https://x/y.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:v', mime: 'video/webm', extmetadata: { LicenseShortName: { value: 'CC0' } } }] },
  } } };
  const all = parseCommons(data, '9V-SMA');
  assert.equal(all.length, 3, 'the video is dropped');
  const titled = parseCommons(data, '9V-SMA', { titleMustContain: true });
  assert.deepEqual(titled.map((p) => p.title), ['9V-SMA@HKG (20190414123010).jpg'], 'search results must name the registration');
  assert.equal(titled[0].photographer, 'N509FZ');
  assert.equal(titled[0].license, 'CC BY-SA 4.0');
  assert.equal(all[0].photographer, 'Ralf Roletschek');
  assert.equal(plainText('Tom &amp; Jerry <b>x</b>'), 'Tom & Jerry x');
  assert.deepEqual(parseCommons({}, '9V-SMA'), []);
  // no licence -> dropped
  const noLicence = { query: { pages: { 1: { ...page('File:9V-SMA a.jpg', 'A', 'x', 1) } } } };
  noLicence.query.pages[1].imageinfo[0].extmetadata.LicenseShortName.value = '';
  assert.deepEqual(parseCommons(noLicence, '9V-SMA'), []);
});

test('Commons dates: every format seen in real responses, never more precise than given, newest first', async () => {
  const { parseTaken, newestFirst } = await import('../js/commons.js');
  const { takenText } = await import('../js/gallery.js').catch(() => ({}));
  const d = (s) => parseTaken(s);
  assert.deepEqual(d('2025-10-26 17:47:23'), { ms: Date.UTC(2025, 9, 26), precision: 'day' });
  assert.deepEqual(d('2017-10-24'), { ms: Date.UTC(2017, 9, 24), precision: 'day' });
  assert.deepEqual(d('Taken on 1 August 2024'), { ms: Date.UTC(2024, 7, 1), precision: 'day' });
  assert.deepEqual(d('<span>August 2024</span>'), { ms: Date.UTC(2024, 7, 1), precision: 'month' });
  assert.deepEqual(d('circa 2019'), { ms: Date.UTC(2019, 0, 1), precision: 'year' });
  assert.equal(d(''), null);
  assert.equal(d('unknown'), null);
  const sorted = newestFirst([
    { title: 'a', taken: d('2016-10-14 15:50:34') }, { title: 'b', taken: null }, { title: 'c', taken: d('2025-10-26 17:47:23') }, { title: 'd', taken: d('Taken on 1 August 2024') }, { title: 'e', taken: null },
  ]);
  assert.deepEqual(sorted.map((p) => p.title), ['c', 'd', 'a', 'b', 'e'], 'undated photos last, in their original order');
});

test('date text is never more precise than the source', async () => {
  const { takenText } = await import('../js/gallery.js');
  assert.equal(takenText({ ms: Date.UTC(2025, 9, 26), precision: 'day' }), '26 Oct 2025');
  assert.equal(takenText({ ms: Date.UTC(2024, 7, 1), precision: 'month' }), 'Aug 2024');
  assert.equal(takenText({ ms: Date.UTC(2019, 0, 1), precision: 'year' }), '2019');
});
