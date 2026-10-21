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

// Later phases add their own scenarios to this list.
export const extraScenarios = [];

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
