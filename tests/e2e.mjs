// e2e.mjs: drives the real page in a headless browser.
// Run with:  npm run test:e2e   (needs Playwright: npm install --no-save playwright)
//
// Scenarios:
//   real      - no tricks: whatever the real provider answers (in a blocked network, an error banner)
//   fixture   - the provider is replaced by tests/fixtures/point_response.synthetic.json
//   ratelimit - the provider answers HTTP 429
//   empty     - the provider answers with zero aircraft
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); // preinstalled copy in the build environment
}

const BASE = 'http://localhost:8000';
const fixture = readFileSync(new URL('./fixtures/point_response.synthetic.json', import.meta.url), 'utf8');
const results = [];

// The flight card opens as a short preview; "More info" shows the full card.
async function moreInfo(page) {
  const btn = page.locator('#info-panel [data-act="more"]');
  await btn.waitFor();
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
}

function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}

async function startServer() {
  const server = spawn('python3', ['scripts/dev_server.py'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE);
      return server;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('dev server did not start');
}

async function newPage(browser, scenario) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => check(`[${scenario}] no JavaScript errors`, false, e.message));
  // Map tiles can't be fetched in an offline test, so answer them with nothing.
  await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204 }));
  if (scenario === 'fixture') await page.route('**/relay?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fixture }));
  if (scenario === 'ratelimit') await page.route('**/relay?**', (r) => r.fulfill({ status: 429, body: '' }));
  if (scenario === 'empty') await page.route('**/relay?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ac":[],"msg":"No error","now":0,"total":0,"ctime":0,"ptime":0}' }));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('spotters-companion:open-panel', 'list-panel'); // start with the list open
  });
  await page.goto(BASE);
  return page;
}

export const scenarios = {
  async real(browser) {
    const page = await newPage(browser, 'real');
    await page.waitForSelector('#banner:not([hidden])', { timeout: 20000 });
    const text = await page.textContent('#banner');
    check('[real] a clear message is shown when the provider is unreachable', text.length > 20, text.slice(0, 90));
    check('[real] map is still displayed', await page.isVisible('#map'));
    await page.close();
  },

  async fixture(browser) {
    const page = await newPage(browser, 'fixture');
    await page.waitForSelector('.plane');
    const planes = await page.locator('.plane').count();
    check('[fixture] one marker per aircraft with a position (4 of 5)', planes === 4, `${planes} markers`);
    const rotation = await page.locator('.plane').first().getAttribute('style');
    check('[fixture] markers are rotated to the track', rotation.includes('rotate(45.5deg)'), rotation);
    check('[fixture] no error banner', await page.isHidden('#banner'));
    // Click the first plane's icon directly (big icons can overlap each other or the list drawer).
    await page.locator('.leaflet-marker-icon').first().dispatchEvent('click');
    await page.waitForSelector('#info-panel:not([hidden]) .pv__call');
    // Preview first: the short card, like flight-tracker apps
    const pvText = await page.textContent('#info-panel .pv');
    check('[preview] clicking a plane shows a short preview: callsign, type, altitude, speed, registration',
      ['TST101', 'A359', '12,000 ft', '310 kt', 'TEST-A'].every((s) => pvText.includes(s)) && await page.isVisible('#info-panel .pv__call'), pvText.slice(0, 200));
    check('[preview] the full details stay hidden until "More info"', !(await page.isVisible('#info-panel .tiles')) && (await page.textContent('#info-panel [data-act="more"]')).includes('More info'));
    check('[preview] Follow and Share buttons', await page.isVisible('#info-panel [data-act="follow"]') && await page.isVisible('#info-panel [data-act="share"]'));
    // Follow: pressed state; dragging the map stops it
    await page.click('#info-panel [data-act="follow"]');
    check('[preview] Follow is switched on', (await page.getAttribute('#info-panel [data-act="follow"]', 'aria-pressed')) === 'true');
    await page.waitForTimeout(800); // Follow zooms in with an animation; Leaflet ignores drags until it ends
    // Find a spot of empty map (no plane, card, drawer or button under it) and drag from there.
    const spot = await page.evaluate(() => {
      for (let y = 200; y < innerHeight - 80; y += 40) {
        for (let x = 420; x < innerWidth - 700; x += 40) {
          const el = document.elementFromPoint(x, y);
          if (el && el.closest('#map') && !el.closest('.leaflet-marker-icon, .leaflet-control, .track-legend')) return { x, y };
        }
      }
      return null;
    });
    await page.mouse.move(spot.x, spot.y);
    await page.mouse.down();
    await page.mouse.move(spot.x - 60, spot.y - 50, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const afterDrag = { open: await page.isVisible('#info-panel .pv__call'), follow: await page.getAttribute('#info-panel [data-act="follow"]', 'aria-pressed') };
    check('[preview] dragging the map stops Follow (and keeps the card open)', afterDrag.open && afterDrag.follow === 'false', JSON.stringify({ ...afterDrag, spot }));
    // Share: copies a link to this plane (the browser's share sheet on phones)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const hasShare = await page.evaluate(() => !!navigator.share);
    if (!hasShare) {
      await page.click('#info-panel [data-act="share"]');
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      check('[preview] Share copies a link that opens this plane', copied.endsWith('/?hex=7fff01') && (await page.textContent('#info-panel [data-act="share"]')).includes('Link copied'), copied);
    }
    await moreInfo(page);
    await page.waitForSelector('#info-panel:not([hidden]) .tiles');
    check('[preview] "More info" shows the full card and becomes "Less info"', await page.isVisible('#info-panel .tiles') && (await page.textContent('#info-panel [data-act="more"]')).includes('Less info'));
    const card = await page.textContent('#info-panel');
    check('[fixture] clicking a plane opens its card: callsign, registration, type, altitude, speed, VS, squawk',
      ['TST101', 'TEST-A', 'A359', '12,000 ft', '310 kt', '-1,280 ft/min', '2301'].every((s) => card.includes(s)), card.slice(0, 160));
    const widths = await page.locator('.plane').evaluateAll((els) => els.map((e) => e.offsetWidth)); // offsetWidth ignores the rotation
    check('[fixture] icon sizes follow the aircraft category (heavy > large > light)', new Set(widths.map(Math.round)).size === 3 && Math.max(...widths) > Math.min(...widths) * 1.5, widths.map(Math.round).join(', '));
    const status = await page.textContent('#status');
    check('[fixture] status counts aircraft on map separately', status.includes('4 aircraft on map (+1 without position)'), status);
    mkdirSync('docs/screenshots', { recursive: true });
    await page.waitForTimeout(500); // let the popup finish fading in
    await page.screenshot({ path: 'docs/screenshots/synthetic-test-data.png' });
    // A shared link opens that plane's preview by itself
    await page.goto(BASE + '?hex=7fff02');
    await page.waitForSelector('#info-panel:not([hidden]) .pv__call');
    check('[preview] a shared link (?hex=) opens that aircraft', (await page.textContent('#info-panel .pv__call')) === 'TST202');
    await page.close();
  },

  async ratelimit(browser) {
    const page = await newPage(browser, 'ratelimit');
    await page.waitForSelector('#banner:not([hidden])');
    const text = await page.textContent('#banner');
    check('[ratelimit] 429 shows a slow-down message', text.includes('429') && text.includes('Slowing down'), text.slice(0, 90));
    await page.close();
  },

  async empty(browser) {
    const page = await newPage(browser, 'empty');
    await page.waitForSelector('#banner:not([hidden])');
    const text = await page.textContent('#banner');
    check('[empty] empty result shows an info message', text.includes('No aircraft'), text.slice(0, 90));
    await page.close();
  },
};

// Phase 2: filters, list, sorting, CSV export.
async function phase2(browser) {
  const page = await newPage(browser, 'fixture');
  await page.waitForSelector('#aircraft-list tbody tr');
  const rows = () => page.locator('#aircraft-list tbody tr');
  check('[list] all 5 aircraft listed (including one without position)', (await rows().count()) === 5);
  const firstCallsign = await rows().first().locator('td').first().textContent();
  check('[list] default sort is closest first', firstCallsign === 'Unknown', `first row: ${firstCallsign} (3.1 nm, no callsign)`);

  await page.click('#filters-btn'); // filters live in a collapsible section of the List drawer
  check('[filter] Filters button opens the filter section, list still visible', (await page.isVisible('#filter-types')) && (await page.isVisible('#aircraft-list')));
  await page.fill('#filter-types', 'B38M');
  check('[filter] type filter narrows list and map', (await rows().count()) === 1 && (await page.locator('.plane').count()) === 1);
  await page.click('button[type=reset]');
  await page.waitForTimeout(50);
  await page.fill('#filter-prefix', 'tst');
  check('[filter] callsign prefix', (await rows().count()) === 2);
  await page.fill('#filter-prefix', '');
  await page.fill('#filter-min-alt', '10000');
  check('[filter] min altitude', (await rows().count()) === 2);
  check('[filter] count label', (await page.textContent('#list-count')) === '2 of 5 shown');
  await page.click('button[type=reset]');
  await page.waitForTimeout(50);

  await page.click('th button[data-key="altitudeFt"]');
  await page.click('th button[data-key="altitudeFt"]');
  const topAlt = await rows().first().locator('td').nth(4).textContent(); // columns: Callsign, Reg, Type, Route, Alt
  check('[sort] clicking Alt twice sorts highest first', topAlt === '36,000 ft', topAlt);

  await rows().first().click();
  check('[select] clicking a row highlights it and opens its flight card',
    (await page.locator('tr.selected').count()) === 1 && (await page.locator('.plane--selected').count()) === 1 && (await page.isVisible('#info-panel .pv__call')));

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv')]);
  const csv = readFileSync(await download.path(), 'utf8').trim().split('\r\n');
  check('[csv] export has a header plus one line per listed aircraft, in list order', csv.length === 6 && csv[1].includes('TST202'), csv[1]);
  check('[csv] filename', /^aircraft-.*\.csv$/.test(download.suggestedFilename()), download.suggestedFilename());
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'docs/screenshots/synthetic-test-data.png' });
  await page.close();
}

// Phase 4: info panel. One aircraft gets a hex that really exists in data/aircraft_db
// (a03618 = N11206, B738, year 2000) so we test the real database file. Positions stay synthetic.
async function phase4(browser) {
  const data = JSON.parse(fixture);
  Object.assign(data.ac[1], { hex: 'a03618', t: 'B738', r: undefined, desc: undefined, ownOp: undefined, year: undefined });
  // 010207 = SU-GFM, recorded by OpenSky as an A320-251N (the certificate says LEAP-1A26).
  Object.assign(data.ac[0], { hex: '010207', t: 'A20N', r: undefined, desc: undefined });
  // A real callsign with a route on record: CXA865 = Fuzhou (FOC) -> Singapore (SIN). The fixture puts it at Changi.
  data.ac[2].flight = 'CXA865  ';
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => check('[panel] no JavaScript errors', false, e.message));
  await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204 }));
  await page.route('**/relay?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }));
  // Planespotters: a made-up photo for a03618, none for anything else. The image is a 1x1 PNG.
  // Wikimedia Commons: two photos for N11206 (TST202's registration) in its airframe category; none for others.
  const commonsCalls = [];
  await page.route(/commons\.wikimedia\.org\/w\/api\.php/, (r) => {
    const u = new URL(r.request().url());
    commonsCalls.push({ cat: u.searchParams.get('gcmtitle'), search: u.searchParams.get('gsrsearch'), agent: r.request().headers()['api-user-agent'] });
    const photo = (n, title, artist, license, taken) => ({ pageid: n, ns: 6, title, index: n, imageinfo: [{ thumburl: `https://upload.wikimedia.org/test/${n}.png`, thumbwidth: 640, thumbheight: 427,
      descriptionurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`, mime: 'image/png',
      extmetadata: { Artist: { value: `<a href="//commons.wikimedia.org/wiki/User:${artist}">${artist}</a>` }, LicenseShortName: { value: license }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' }, DateTimeOriginal: { value: taken } } }] });
    const body = u.searchParams.get('gcmtitle') === 'Category:N11206 (aircraft)'
      ? { batchcomplete: '', query: { pages: { 11: photo(1, 'File:N11206 at SIN.jpg', 'Spotter One', 'CC BY-SA 4.0', '2019-03-04 10:47:10'), 12: photo(2, 'File:N11206 landing.jpg', 'Spotter Two', 'CC BY 2.0', 'Taken on 26 October 2025') } } }
      : { batchcomplete: '' };
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await page.route(/upload\.wikimedia\.org\/test/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: readFileSync(new URL('../icons/icon-192.png', import.meta.url)) }));
  await page.route('https://api.planespotters.net/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(r.request().url().endsWith('/a03618')
      ? { photos: [{ thumbnail_large: { src: 'https://t.plnspttrs.net/1/test_280.jpg' }, link: 'https://www.planespotters.net/photo/1/test', photographer: 'Test Photographer' }] }
      : { photos: [] }),
  }));
  await page.route('https://t.plnspttrs.net/**', (r) => r.fulfill({ status: 200, contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') }));
  const shardRequests = [];
  page.on('request', (req) => req.url().includes('/data/aircraft_db/') && shardRequests.push(req.url()));
  await page.addInitScript(() => localStorage.setItem('spotters-companion:open-panel', 'list-panel'));
  await page.goto(BASE);
  await page.waitForSelector('#aircraft-list tbody tr');

  const openPanelFor = async (callsign) => {
    await page.locator('#aircraft-list tbody tr', { hasText: callsign }).click();
    await moreInfo(page);
    await page.waitForFunction((cs) => {
      const panel = document.getElementById('info-panel');
      return !panel.hidden && panel.querySelector('.info__title').textContent === cs && panel.querySelector('.info__legend');
    }, callsign);
    return page.textContent('#info-panel');
  };
  const rowText = (label) => page.locator('#info-panel tr', { hasText: label }).first().textContent();

  let text = await openPanelFor('TST202');
  check('[panel] registration from database, tagged DB', (await rowText('Registration')) === 'RegistrationN11206DB');
  check('[panel] airfleets.net search link for the registration',
    (await page.getAttribute('#info-panel .info__more-link', 'href')) === 'https://www.airfleets.net/recherche/?key=N11206');
  check('[panel] serial number, year built, age and operator are not shown',
    ['Serial number', 'Year built', 'Age', 'Operator'].every((label) => !text.includes(label)));
  check('[panel] type name from type table, tagged TYPE', (await page.locator('#info-panel tr', { hasText: /^Type/ }).first().textContent()) === 'TypeBoeing 737-800 (737 NG)TYPE');
  check('[panel] exact model from OpenSky, tagged OSN', (await rowText('Exact model')) === 'Exact model737-824OSN');
  check('[panel] single-engine type: engine applies to this aircraft', (await rowText('Engine')).includes('2 × CFM International CFM56-7B series') && text.includes('only engine offered for this aircraft type'));
  check('[panel] engine as recorded by OpenSky shown verbatim', (await rowText('Recorded for this aircraft')).includes('CFM INTL. CFM56 SERIES'));
  const squawkTile = await page.locator('#info-panel .tile', { hasText: 'Squawk' }).textContent();
  check('[panel] live tiles, tagged LIVE', squawkTile === 'Squawk4512' && (await page.locator('#info-panel h3 .src--live').count()) === 1, squawkTile);
  await page.waitForSelector('.info__photo img');
  const photoLink = page.locator('.info__photo > a');
  check('[photo] image links to its Planespotters page', (await photoLink.getAttribute('href')) === 'https://www.planespotters.net/photo/1/test');
  check('[photo] photo is not cropped', (await page.locator('.info__photo img').evaluate((img) => getComputedStyle(img).objectFit)) !== 'cover');
  check('[photo] photographer credit shown', (await page.textContent('.info__credit')).includes('© Test Photographer'));
  // More photos: Commons strip in the full card, "+2" on the preview, full-screen viewer
  await page.waitForSelector('#info-panel .strip__item');
  check('[photos] "More photos" strip, newest first, with dates', (await page.locator('#info-panel .strip__item').count()) === 2 && (await page.textContent('#info-panel .info__strip h3')).includes('More photos (2), newest first') &&
    (await page.locator('#info-panel .strip__date').allTextContents()).join('|') === '26 Oct 2025|4 Mar 2019');
  check('[photos] Commons asked twice: airframe category, then a search', commonsCalls.length === 2 && commonsCalls[1].search === '"N11206"');
  check('[photos] Commons asked for the airframe category, with an Api-User-Agent', commonsCalls[0]?.cat === 'Category:N11206 (aircraft)' && /SkyWatchSG/.test(commonsCalls[0]?.agent ?? ''), JSON.stringify(commonsCalls[0]));
  await page.screenshot({ path: 'docs/screenshots/info-panel-synthetic.png' });
  await page.click('#info-panel [data-act="more"]'); // back to the preview
  check('[photos] preview shows "+2" on the photo', (await page.textContent('#info-panel .pv__morephotos')) === '+2');
  await page.click('#info-panel .pv__morephotos');
  await page.waitForSelector('.gallery:not([hidden])');
  check('[gallery] opens on the Planespotters photo: 1 / 3 with its credit (no date given)', (await page.textContent('.gallery__count')) === '1 / 3' && (await page.textContent('.gallery__cap')).includes('© Test Photographer · via Planespotters.net') && (await page.textContent('.gallery__cap')).includes('Date not given by Planespotters'));
  check('[gallery] the photo links to its Planespotters page', (await page.getAttribute('.gallery__imglink', 'href')) === 'https://www.planespotters.net/photo/1/test');
  await page.click('.gallery__nav--next');
  const cap = await page.textContent('.gallery__cap');
  check('[gallery] newest Commons photo comes first, with author, licence, source and date taken', (await page.textContent('.gallery__count')) === '2 / 3' && cap.includes('© Spotter Two · CC BY 2.0 · Wikimedia Commons') && cap.includes('Taken 26 Oct 2025'), cap);
  check('[gallery] licence links to its text, photo to its file page', (await page.getAttribute('.gallery__cap a', 'href')) === 'https://creativecommons.org/licenses/by-sa/4.0' && (await page.getAttribute('.gallery__imglink', 'href')).startsWith('https://commons.wikimedia.org/wiki/File'));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  check('[gallery] arrow keys wrap around', (await page.textContent('.gallery__count')) === '1 / 3');
  await page.keyboard.press('Escape');
  check('[gallery] Esc closes it', await page.isHidden('.gallery'));
  await page.click('.pv__close');

  text = await openPanelFor('TST101');
  check('[panel] A320-251N gets its certified engine LEAP-1A26 from the TCDS',
    (await rowText('Certified for')) === 'Certified for A320-251N2 × LEAP-1A26TCDS', await rowText('Certified for'));
  if (process.env.SHOT2) await page.screenshot({ path: process.env.SHOT2 });
  check('[panel] certificate source cited with line number', text.includes('UK CAA TCDS UK.TC.A.00010') && /text line \d+/.test(text));
  await page.waitForFunction(() => document.querySelector('.info__photo')?.textContent.includes('No photo'));
  check('[photo] aircraft without a photo says so', true);
  await page.click('.pv__close');

  const routeCell = await page.locator('#aircraft-list tbody tr', { hasText: 'CXA865' }).locator('td').nth(3).textContent();
  check('[route] list shows the route', routeCell === 'FOC → SIN', routeCell);
  await page.waitForSelector('.plane-badge');
  check('[airline] CXA865 gets an "MF" (Xiamen Airlines) badge on the map', (await page.locator('.plane-badge', { hasText: 'MF' }).count()) === 1);
  const shapes = await page.locator('.plane svg').evaluateAll((els) => new Set(els.map((e) => e.innerHTML)).size);
  check('[shape] different aircraft get different silhouettes', shapes >= 2, `${shapes} different shapes`);
  text = await openPanelFor('CXA865'); // hex not in database
  check('[airline] card subtitle starts with the airline name', (await page.textContent('#info-panel .info__subtitle')).startsWith('Xiamen Airlines'));
  check('[route] info panel shows full airport names',
    (await rowText('From')).includes('Fuzhou Changle International Airport (FOC / ZSFZ)') && (await rowText('To')).includes('Singapore Changi International Airport (SIN / WSSS)'));
  check('[route] no "outdated" warning when the plane is on its route', !text.includes('may be outdated'));
  check('[route] great-circle distance shown (Fuzhou-Singapore ~1,650 nm)', /Distance1,[5-7]\d\d nm \(\d,\d{3} km\)/.test(text.replace(/\s+/g, '')) || /Distance\s*1,[5-7]\d\d nm/.test(text), text.match(/Distance[^A-Z]{0,40}/)?.[0]);
  check('[route] no made-up times: departure not seen, no arrival estimate on the ground',
    text.includes('Departed') && text.includes('Not available (no schedule data)') && text.includes('Not available (on the ground)'));
  check('[panel] missing fields are listed on one line, not as rows of Unknown',
    text.includes('Unknown (not in our databases): registration') && (await page.locator('#info-panel tr', { hasText: 'Serial number' }).count()) === 0);
  check('[panel] aircraft not in database says so, falls back to live type', text.includes('Not in our database') && (await rowText('ICAO type code')) === 'ICAO type codeB77WLIVE');
  check('[panel] database shard downloaded once (cached)', new Set(shardRequests).size === shardRequests.length, shardRequests.join(' '));
  check('[panel] unconfirmed badge only where verified=false', !text.includes('unconfirmed'));
  await page.click('.pv__close');
  await page.click('#filters-btn');
  await page.uncheck('#show-badges');
  check('[airline] badges can be switched off', (await page.locator('.plane-badge').count()) === 0);
  await page.check('#show-badges');
  await page.locator('#aircraft-list tbody tr', { hasText: 'NOPOS1' }).click(); // no position: no popup
  check('[panel] closing panel shows the list again', await page.isVisible('#aircraft-list'));
  await page.close();
}

// Tracks: the plane moves a little on every update; skip ahead with Playwright's fake clock.
async function tracks(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => check('[track] no JavaScript errors', false, e.message));
  await page.clock.install();
  await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204 }));
  let update = 0;
  await page.route('**/relay?**', (r) => {
    if (!r.request().url().includes('api.adsb.lol')) return r.fulfill({ status: 404, body: '' }); // e.g. weather
    const data = JSON.parse(fixture);
    data.ac[0].lat += update * 0.02; // TST101 climbs north-east, 12,000 ft -> 27,000 ft
    data.ac[0].lon += update * 0.02;
    data.ac[0].alt_baro += update * 5000;
    update++;
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  // The recorder (Cloudflare worker) knows 3 earlier positions of TST101 (7fff01), south-west of it.
  let recorderCalls = 0;
  await page.route('https://spotters-relay.maotianze.workers.dev/track?**', (r) => {
    recorderCalls++;
    const hex = new URL(r.request().url()).searchParams.get('hex');
    const now = Math.floor(Date.now() / 1000); // the page's fake clock starts at the real time
    const points = hex === '7fff01' ? [1, 2, 3].map((i) => ({ t: now - (4 - i) * 60, lat: 1.40 - (4 - i) * 0.03, lon: 103.95 - (4 - i) * 0.03, alt: 3000 * i })) : [];
    // Answer after 500 ms, so the test can count the track before and after the recorder's points arrive.
    setTimeout(() => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hex, minutes: 180, points }) }), 500);
  });
  await page.addInitScript(() => localStorage.setItem('spotters-companion:open-panel', 'list-panel'));
  await page.goto(BASE);
  await page.waitForSelector('.plane');
  for (let i = 0; i < 3; i++) {
    await page.clock.runFor(11_000); // fire the next update...
    await page.waitForTimeout(300); // ...and give its (real-time) network reply a moment to arrive
  }
  await page.waitForFunction(() => document.querySelectorAll('.plane').length === 4);
  check('[track] several updates were fetched', update >= 4, `${update} updates`);

  await page.locator('#aircraft-list tbody tr', { hasText: 'TST101' }).click();
  const segments = await page.locator('.leaflet-overlay-pane path').count();
  // 1 path is the dashed search circle, 1 is the track's dark outline; the rest are coloured segments.
  check('[track] selecting a plane draws its track (one segment per move)', segments - 2 >= update - 1, `${segments - 2} segments`);
  await page.waitForTimeout(900); // the recorder's answer arrives
  const added = (await page.locator('.leaflet-overlay-pane path').count()) - segments;
  check('[recorder] earlier recorded positions are added before the live ones', recorderCalls === 1 && added === 3, `${added} segments added, ${recorderCalls} recorder call(s)`);
  const colors = await page.locator('.leaflet-overlay-pane path[stroke="#2563eb"]').count();
  check('[track] segments above 25,000 ft are blue', colors >= 1);
  check('[track] legend appears', await page.isVisible('.track-legend'));
  await page.waitForSelector('#info-panel:not([hidden])'); // the row click above opened the card
  await moreInfo(page);
  const recorded = await page.locator('#info-panel .facts').textContent();
  check('[track] info panel says how much track is recorded, incl. recorder', recorded.includes('min of track') && recorded.includes('from your recorder'), recorded);
  await page.click('.pv__close');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

  // Same again, but by clicking the plane ON THE MAP (how people actually use it).
  await page.click('#map', { position: { x: 520, y: 700 } }); // empty map between the card and the list
  await page.locator('.leaflet-marker-icon', { has: page.locator('.plane') }).nth(0).click();
  await page.waitForTimeout(300);
  const viaMarker = await page.locator('.leaflet-overlay-pane path').count();
  check('[track] clicking the plane on the map also draws its track', viaMarker > 2, `${viaMarker - 2} segments`);

  await page.click('#map', { position: { x: 520, y: 700 } }); // empty map between the card and the list // empty map
  const after = await page.locator('.leaflet-overlay-pane path').count();
  check('[track] clicking empty map hides the track and legend', after === 1 && !(await page.isVisible('.track-legend')));
  await page.close();
}

// Map / Satellite switch.
async function satellite(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => check('[satellite] no JavaScript errors', false, e.message));
  const tileHosts = new Set();
  await page.route(/tile\.openstreetmap\.org|tiles\.maps\.eox\.at|tiles\.openfreemap\.org/, (r) => { tileHosts.add(new URL(r.request().url()).hostname); r.fulfill({ status: 404 }); });
  await page.route('**/relay?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fixture }));
  await page.addInitScript(() => localStorage.setItem('spotters-companion:open-panel', 'list-panel'));
  await page.goto(BASE);
  await page.waitForSelector('.plane');
  // Default: the sharp "Dark" vector map (OpenFreeMap via MapLibre) if this browser has WebGL, else "Classic".
  const vectorDrawn = (await page.locator('.leaflet-gl-layer, .maplibregl-canvas').count()) > 0;
  const darkOffered = (await page.getByLabel('Dark').count()) === 1;
  check('[map] starts on the sharp Dark map (or Classic when WebGL is missing)',
    darkOffered ? vectorDrawn && tileHosts.has('tiles.openfreemap.org') && !tileHosts.has('tiles.maps.eox.at') : tileHosts.has('tile.openstreetmap.org'),
    `WebGL vector map: ${darkOffered}, hosts asked: ${[...tileHosts].join(', ')}`);
  await page.hover('.leaflet-control-layers');
  await page.getByLabel('Satellite').check();
  await page.waitForTimeout(300);
  check('[satellite] switching loads EOX tiles', tileHosts.has('tiles.maps.eox.at'));
  check('[satellite] EOX attribution shown', (await page.textContent('.leaflet-control-attribution')).includes('EOX'));
  await page.reload();
  await page.waitForSelector('.plane');
  check('[satellite] choice remembered after reload', await page.getByLabel('Satellite').isChecked());
  await page.close();
}

// If MapLibre can't load, the map falls back to the Classic image map and nothing breaks.
async function noVectorFallback(browser) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on('pageerror', (e) => check('[fallback] no JavaScript errors', false, e.message));
  await page.route('**/vendor/maplibre-gl/maplibre-gl.js', (r) => r.fulfill({ status: 404, body: '' }));
  await page.route(/tile\.openstreetmap\.org|tiles\.maps\.eox\.at|tiles\.openfreemap\.org/, (r) => r.fulfill({ status: 204 }));
  await page.route('**/relay?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fixture }));
  await page.addInitScript(() => localStorage.clear());
  await page.goto(BASE);
  await page.waitForSelector('.plane');
  check('[fallback] without MapLibre the Classic map is used and planes still show',
    (await page.getByLabel('Dark').count()) === 0 && (await page.getByLabel('Classic').isChecked()) && (await page.locator('.plane').count()) === 4);
  await page.close();
}

// Spotting (watchlist, alerts, log), Stats and Weather, with the weather API and recorder answered
// by the real responses captured on 21 Oct 2026 (METAR/TAF) and a small /stats answer.
async function spotting(browser, { width = 1280, height = 860 } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => check('[spotting] no JavaScript errors', false, e.message));
  page.on('dialog', (d) => d.accept());
  const data = JSON.parse(fixture);
  data.ac[1].squawk = '7700'; // TST202 declares an emergency
  await page.route(/tile\.openstreetmap\.org|tiles\.maps\.eox\.at|tiles\.openfreemap\.org/, (r) => r.fulfill({ status: 204 }));
  const METAR = '[{"icaoId":"WSSS","receiptTime":"2026-10-21T13:30:57.930Z","obsTime":1792589400,"reportTime":"2026-10-21T13:30:00.000Z","temp":28,"dewp":25,"wdir":360,"wspd":4,"visib":5.59,"altim":1012,"qcField":16,"metarType":"METAR","rawOb":"METAR WSSS 211330Z 36004KT 9000 FEW018 BKN280 28/25 Q1012 NOSIG","lat":1.368,"lon":103.982,"elev":17,"name":"Singapore/Changi Intl, 4, SG","cover":"BKN","clouds":[{"cover":"FEW","base":1800},{"cover":"BKN","base":28000}],"fltCat":"VFR"}]';
  const weatherCalls = [];
  await page.route('**/relay?**', (r) => {
    const target = decodeURIComponent(new URL(r.request().url()).searchParams.get('url'));
    if (target.startsWith('https://aviationweather.gov/api/data/metar?')) { weatherCalls.push(target); return r.fulfill({ status: 200, contentType: 'application/json', body: METAR }); }
    if (target.startsWith('https://aviationweather.gov/api/data/taf?')) { weatherCalls.push(target); return r.fulfill({ status: 200, contentType: 'text/plain', body: 'TAF WSSS 211100Z 2112/2218 07007KT 7000 FEW015 SCT020\n' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.route('**/data/aircraft_flags.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"military":["7fff03"],"interesting":[]}' }));
  const hour = Math.floor(Date.now() / 3600000) * 3600;
  await page.route('https://spotters-relay.maotianze.workers.dev/stats?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    hours: 24, area: { lat: 1.35, lon: 103.82, radiusNm: 80 }, uniqueAircraft: 812, oldest: hour - 5 * 3600, detailsSince: hour - 5 * 3600,
    perHour: [{ hour: hour - 5 * 3600, aircraft: 120 }, { hour: hour - 3 * 3600, aircraft: 210 }, { hour, aircraft: 95 }],
    types: [{ type: 'A359', aircraft: 80 }, { type: 'B77W', aircraft: 60 }], airlines: [{ airline: 'SIA', aircraft: 150 }, { airline: 'TST', aircraft: 4 }],
  }) }));
  await page.route('https://spotters-relay.maotianze.workers.dev/track?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"points":[]}' }));
  await page.addInitScript(() => {
    if (sessionStorage.getItem('started')) return; // keep the log across the reload below
    sessionStorage.setItem('started', '1');
    localStorage.clear();
  });
  await page.goto(BASE);
  await page.waitForSelector('.plane');
  const tag = width < 700 ? '[spotting phone]' : '[spotting]';

  if (width < 700) {
    const overflow = await page.evaluate(() => document.querySelector('.topbar').scrollWidth - document.querySelector('.topbar').clientWidth);
    check(`${tag} top-bar buttons fit the phone screen`, overflow <= 0, `${overflow}px too wide`);
    const bar = await page.locator('.topbar__buttons').boundingBox();
    check(`${tag} panel buttons are a floating tab bar at the bottom`, bar.y + bar.height > height - 40 && bar.width > width - 40, JSON.stringify(bar));
  }

  // Emergency and military alerts pop up on their own.
  await page.waitForSelector('.alert-toast', { timeout: 5000 });
  const toasts = await page.locator('.alert-toast').allTextContents();
  check(`${tag} squawk 7700 pops up as an emergency`, toasts.some((t) => t.includes('TST202') && t.includes('7700 (emergency)')) && (await page.locator('.alert-toast--emergency').count()) === 1, toasts.join(' | '));
  check(`${tag} military database flag pops up`, toasts.some((t) => t.includes('XYZ9') && t.includes('Military')));
  check(`${tag} red pulsing ring on the emergency plane`, (await page.locator('.plane-ring--emergency').count()) === 1);

  // Add a registration to the watchlist.
  await page.click('[data-toggle="spotting-panel"]');
  await page.selectOption('select[name="watch-kind"]', 'reg');
  await page.fill('input[name="watch-value"]', 'test-a');
  await page.click('#watch-form button[type="submit"]');
  check(`${tag} watchlist entry tidied and shown`, (await page.locator('#watch-list').textContent()).includes('TEST-A'));
  await page.waitForFunction(() => [...document.querySelectorAll('.alert-toast')].some((t) => t.textContent.includes('Watchlist: TEST-A')), null, { timeout: 15000 });
  check(`${tag} watchlist match pops up`, true);
  check(`${tag} "Matching right now" lists three aircraft`, (await page.locator('#alert-now li').count()) === 3);
  const toastsBefore = await page.locator('.alert-toast').count();
  await page.waitForTimeout(11000); // next update: the same alerts must not pop up again
  check(`${tag} alerts pop up only once`, (await page.locator('.alert-toast').count()) === toastsBefore);

  // Click the watchlist pop-up: the card opens with its chip; log it.
  if (width < 700) {
    // On a phone the pop-ups hide while a drawer is open; use the drawer's own list instead.
    check(`${tag} pop-ups hidden while a drawer covers the map`, await page.locator('.alerts').isHidden());
    await page.locator('#alert-now button', { hasText: 'TST101' }).click();
  } else {
    await page.locator('.alert-toast', { hasText: 'Watchlist: TEST-A' }).click();
  }
  await page.waitForSelector('#info-panel:not([hidden]) .log-btn');
  check(`${tag} card shows the alert reason`, (await page.locator('#info-panel .alert-chip').allTextContents()).includes('Watchlist: TEST-A'));
  await page.click('#info-panel .log-btn');
  check(`${tag} logged: button changes and says since when`, (await page.textContent('#info-panel .log-btn')) === 'Log again' && (await page.textContent('#info-panel .log-note')).startsWith('In your log since'));
  await page.click('#info-panel .log-btn');
  check(`${tag} logging again counts sightings`, (await page.textContent('#info-panel .log-note')).includes('seen 2×'));
  if (width < 700) check(`${tag} jumping to a plane closes the drawer so the card is visible`, await page.locator('#spotting-panel').isHidden());
  if (await page.locator('#spotting-panel').isHidden()) {
    // On a phone the tab bar steps aside while a flight card is open (like a maps app): close the card first.
    if (width < 700) await page.click('#info-panel .pv__close');
    await page.click('[data-toggle="spotting-panel"]');
  }
  check(`${tag} log table in the Spotting panel`, (await page.textContent('#log-table')).includes('TEST-A') && (await page.textContent('#log-summary')).startsWith('1 aircraft'));
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#log-export')]);
  const csv = readFileSync(await download.path(), 'utf8');
  check(`${tag} log exports as CSV`, csv.startsWith('date,time,registration') && csv.trim().split('\n').length === 3 && csv.includes('TEST-A,A359'));

  // Reload: watchlist and log are remembered.
  await page.reload();
  await page.waitForSelector('.plane');
  check(`${tag} watchlist and log survive a reload`, (await page.textContent('#watch-list')).includes('TEST-A') && (await page.textContent('#log-summary')).startsWith('1 aircraft'));

  // Stats
  await page.click('[data-toggle="stats-panel"]');
  await page.waitForSelector('#stats-panel .cols');
  const stats = await page.textContent('#stats-panel');
  check(`${tag} stats: right now`, stats.includes('In the air') && /In the air\s*4/.test(await page.locator('#stats-panel .stat-tiles').first().textContent()));
  check(`${tag} stats: 24 h from the recorder, hours filled in`, stats.includes('812 different aircraft') && (await page.locator('#stats-panel .cols__col').count()) === 6);
  check(`${tag} stats: airline names from codes`, (await page.locator('#stats-panel .bars__row', { hasText: 'SIA' }).first().getAttribute('title')).includes('Singapore Airlines'));
  check(`${tag} stats: your log`, stats.includes('Your spotting log') && stats.includes('Sightings'));

  // Weather
  await page.waitForFunction(() => document.getElementById('weather-btn').textContent !== 'Weather');
  check(`${tag} weather button shows a summary`, (await page.textContent('#weather-btn')) === 'WSSS 28° 4 kt');
  await page.click('#weather-btn');
  const wx = await page.textContent('#weather-panel');
  check(`${tag} weather decoded`, wx.includes('360° at 4 kt') && wx.includes('9 km') && wx.includes('Few 1,800 ft') && wx.includes('1012 hPa'));
  check(`${tag} runway hint for Changi`, wx.includes('Wind favours runway 02'));
  check(`${tag} raw METAR and TAF shown, NOAA credited`, wx.includes('METAR WSSS 211330Z') && wx.includes('TAF WSSS') && wx.includes('NOAA Aviation Weather Center'));
  check(`${tag} weather asked via the relay, at most once per page load`, weatherCalls.filter((u) => u.includes('/metar?')).length <= 2, weatherCalls.join(', '));
  if (width >= 700) {
    mkdirSync('docs/screenshots', { recursive: true });
    await page.screenshot({ path: 'docs/screenshots/weather-synthetic.png' });
    await page.click('[data-toggle="stats-panel"]');
    await page.screenshot({ path: 'docs/screenshots/stats-synthetic.png' });
  }
  await page.close();
}
const spottingPhone = (browser) => spotting(browser, { width: 390, height: 844 });

export const extraScenarios = [phase2, phase4, tracks, satellite, noVectorFallback, spotting, spottingPhone];

const server = await startServer();
const browser = await chromium.launch();
try {
  for (const run of [...Object.values(scenarios), ...extraScenarios]) await run(browser);
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
