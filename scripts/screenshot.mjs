// screenshot.mjs: takes REAL screenshots of the app (live planes, real map tiles).
// Needs network access and Playwright. Used by .github/workflows/screenshots.yml, which runs it on
// GitHub's servers. Run locally with:  python3 scripts/dev_server.py &  node scripts/screenshot.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? 'shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 }); // 2x = like a Retina screen
  page.on('pageerror', (e) => console.log(`[${name}] page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && console.log(`[${name}] console: ${m.text()}`));
  await page.addInitScript(() => localStorage.clear());
  await page.goto('http://localhost:8000');
  await page.waitForSelector('.plane', { timeout: 60_000 }).catch(() => console.log(`[${name}] no planes appeared`));
  await page.waitForTimeout(6000); // let map tiles and fonts load
  await page.screenshot({ path: `${OUT}/${name}-dark.png` });

  for (const layer of ['Streets', 'Satellite']) {
    await page.locator('.leaflet-control-layers').hover();
    await page.getByLabel(layer).check();
    await page.mouse.move(5, 300);
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${OUT}/${name}-${layer.toLowerCase()}.png` });
  }

  // Back to Dark, zoom in around Changi, open the first plane's flight card.
  await page.locator('.leaflet-control-layers').hover();
  await page.getByLabel('Dark').check();
  await page.mouse.move(5, 300);
  await page.locator('.leaflet-marker-icon').first().dispatchEvent('click');
  await page.waitForTimeout(6000); // photo, route and details
  await page.screenshot({ path: `${OUT}/${name}-card.png` });
  await page.close();
}
await browser.close();
console.log('done');
