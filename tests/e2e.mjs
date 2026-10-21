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
  await page.addInitScript(() => localStorage.clear());
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
    await page.locator('.leaflet-marker-icon').first().click();
    await page.waitForSelector('.popup');
    const popup = await page.textContent('.popup');
    check('[fixture] popup shows callsign, registration, type, altitude, speed, VS, squawk',
      ['TST101', 'TEST-A', 'A359', '12,000 ft', '310 kt', '-1,280 ft/min', '2301'].every((s) => popup.includes(s)), popup.slice(0, 120));
    const status = await page.textContent('#status');
    check('[fixture] status counts aircraft on map separately', status.includes('4 aircraft on map (+1 without position)'), status);
    mkdirSync('docs/screenshots', { recursive: true });
    await page.waitForTimeout(500); // let the popup finish fading in
    await page.screenshot({ path: 'docs/screenshots/synthetic-test-data.png' });
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
  const topAlt = await rows().first().locator('td').nth(3).textContent();
  check('[sort] clicking Alt twice sorts highest first', topAlt === '36,000 ft', topAlt);

  await rows().first().click();
  check('[select] clicking a row highlights it and opens the map popup',
    (await page.locator('tr.selected').count()) === 1 && (await page.locator('.plane--selected').count()) === 1 && (await page.isVisible('.popup')));

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => check('[panel] no JavaScript errors', false, e.message));
  await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204 }));
  await page.route('**/relay?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }));
  // Planespotters: a made-up photo for a03618, none for anything else. The image is a 1x1 PNG.
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
  await page.goto(BASE);
  await page.waitForSelector('#aircraft-list tbody tr');

  const openPanelFor = async (callsign) => {
    await page.locator('#aircraft-list tbody tr', { hasText: callsign }).click();
    // Click the button in THIS aircraft's popup (an old popup may still be fading out).
    await page.locator('.leaflet-popup', { hasText: callsign }).locator('.popup__more').click();
    await page.waitForFunction((cs) => {
      const panel = document.getElementById('info-panel');
      return !panel.hidden && panel.querySelector('.info__title').textContent === cs && panel.querySelector('.info__legend');
    }, callsign);
    return page.textContent('#info-panel');
  };
  const rowText = (label) => page.locator('#info-panel tr', { hasText: label }).first().textContent();

  let text = await openPanelFor('TST202');
  check('[panel] registration from database, tagged DB', (await rowText('Registration')) === 'RegistrationN11206DB');
  check('[panel] year built and calculated age', (await rowText('Year built')).includes('2000') && (await rowText('Age')).includes(`about ${new Date().getFullYear() - 2000} years`));
  check('[panel] operator from database', (await rowText('Operator')).includes('UNITED AIRLINES INC'));
  check('[panel] type name from type table, tagged TYPE', (await page.locator('#info-panel tr', { hasText: /^Type/ }).first().textContent()) === 'TypeBoeing 737-800 (737 NG)TYPE');
  check('[panel] exact model and serial number from OpenSky, tagged OSN',
    (await rowText('Exact model')) === 'Exact model (as recorded)737-824OSN' && (await rowText('Serial number')) === 'Serial number (MSN)30578OSN');
  check('[panel] single-engine type: engine applies to this aircraft', (await rowText('Engine')).includes('2 × CFM International CFM56-7B series') && text.includes('only engine offered for this aircraft type'));
  check('[panel] engine as recorded by OpenSky shown verbatim', (await rowText('Recorded for this aircraft')).includes('CFM INTL. CFM56 SERIES'));
  check('[panel] live section with live tags', (await rowText('Squawk')) === 'Squawk4512LIVE');
  await page.waitForSelector('.info__photo img');
  const photoLink = page.locator('.info__photo > a');
  check('[photo] image links to its Planespotters page', (await photoLink.getAttribute('href')) === 'https://www.planespotters.net/photo/1/test');
  check('[photo] photographer credit shown', (await page.textContent('.info__credit')).includes('© Test Photographer'));
  await page.screenshot({ path: 'docs/screenshots/info-panel-synthetic.png' });
  await page.click('.info__close');

  text = await openPanelFor('TST101');
  check('[panel] A320-251N gets its certified engine LEAP-1A26 from the TCDS',
    (await rowText('Certified for')) === 'Certified for A320-251N2 × LEAP-1A26TCDS', await rowText('Certified for'));
  if (process.env.SHOT2) await page.screenshot({ path: process.env.SHOT2 });
  check('[panel] certificate source cited with line number', text.includes('UK CAA TCDS UK.TC.A.00010') && /text line \d+/.test(text));
  await page.waitForFunction(() => document.querySelector('.info__photo')?.textContent.includes('No photo'));
  check('[photo] aircraft without a photo says so', true);
  await page.click('.info__close');

  text = await openPanelFor('XYZ9'); // hex not in database
  check('[panel] aircraft not in database says so, falls back to live type', text.includes('Not in our database') && (await rowText('ICAO type code')) === 'ICAO type codeB77WLIVE');
  check('[panel] database shard downloaded once (cached)', new Set(shardRequests).size === shardRequests.length, shardRequests.join(' '));
  check('[panel] unconfirmed badge only where verified=false', !text.includes('unconfirmed'));
  await page.click('.info__close');
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
    const data = JSON.parse(fixture);
    data.ac[0].lat += update * 0.02; // TST101 climbs north-east, 12,000 ft -> 27,000 ft
    data.ac[0].lon += update * 0.02;
    data.ac[0].alt_baro += update * 5000;
    update++;
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto(BASE);
  await page.waitForSelector('.plane');
  for (let i = 0; i < 3; i++) {
    await page.clock.runFor(11_000); // fire the next update...
    await page.waitForTimeout(300); // ...and give its (real-time) network reply a moment to arrive
  }
  await page.waitForFunction(() => document.querySelectorAll('.plane').length === 4);
  check('[track] several updates were fetched', update >= 4, `${update} updates`);

  await page.locator('#aircraft-list tbody tr', { hasText: 'TST101' }).click();
  const segments = await page.locator('.leaflet-overlay-pane path.leaflet-interactive, .leaflet-overlay-pane path').count();
  // 1 path is the dashed search circle, 1 is the track's dark outline; the rest are coloured segments.
  check('[track] selecting a plane draws its track (one segment per move)', segments - 2 === update - 1, `${segments - 2} segments`);
  const colors = await page.locator('.leaflet-overlay-pane path[stroke="#2563eb"]').count();
  check('[track] segments above 25,000 ft are blue', colors >= 1);
  check('[track] legend appears', await page.isVisible('.track-legend'));
  await page.locator('.leaflet-popup', { hasText: 'TST101' }).locator('.popup__more').click();
  await page.waitForSelector('#info-panel:not([hidden])');
  const recorded = await page.locator('#info-panel tr', { hasText: 'Track on map' }).textContent();
  check('[track] info panel says how much track is recorded', recorded.includes('recorded since you opened the page'), recorded);
  await page.click('.info__close');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

  // Same again, but by clicking the plane ON THE MAP (how people actually use it).
  await page.click('#map', { position: { x: 30, y: 400 } });
  await page.locator('.leaflet-marker-icon', { has: page.locator('.plane') }).nth(0).click();
  await page.waitForTimeout(300);
  const viaMarker = await page.locator('.leaflet-overlay-pane path').count();
  check('[track] clicking the plane on the map also draws its track', viaMarker > 2, `${viaMarker - 2} segments`);

  await page.click('#map', { position: { x: 30, y: 400 } }); // empty map
  const after = await page.locator('.leaflet-overlay-pane path').count();
  check('[track] clicking empty map hides the track and legend', after === 1 && !(await page.isVisible('.track-legend')));
  await page.close();
}

// Map / Satellite switch.
async function satellite(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => check('[satellite] no JavaScript errors', false, e.message));
  const tileHosts = new Set();
  await page.route(/tile\.openstreetmap\.org|tiles\.maps\.eox\.at/, (r) => { tileHosts.add(new URL(r.request().url()).hostname); r.fulfill({ status: 204 }); });
  await page.route('**/relay?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fixture }));
  await page.goto(BASE);
  await page.waitForSelector('.plane');
  check('[satellite] starts on the street map', tileHosts.has('tile.openstreetmap.org') && !tileHosts.has('tiles.maps.eox.at'));
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

export const extraScenarios = [phase2, phase4, tracks, satellite];

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
