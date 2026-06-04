// Generate README screenshots with Playwright's headless Chromium.
//
//   npm install playwright --no-save && npx playwright install chromium
//   TOKEN=$(node -e "import('../src/auth.js').then(m=>console.log(m.issueToken()))") \
//   BASE=http://localhost:8787 node scripts/screenshots.mjs
//
// TOKEN must be a valid cc-deck cookie value signed with this instance's CCDECK_SECRET.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.BASE || 'http://localhost:8787';
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('Set TOKEN to a valid ccdeck cookie value (see header).');
  process.exit(1);
}

const OUT = new URL('../docs/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1340, height: 880 }, deviceScaleFactor: 2 });
await ctx.addCookies([
  { name: 'ccdeck', value: TOKEN, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' },
]);
const page = await ctx.newPage();

const shot = async (name, full = false) => {
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: full });
  console.log('wrote docs/' + name + '.png');
};

// Active grid (wait for live pane previews to stream in)
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);
await shot('active');

// Usage / ROI (full page — it's tall)
await page.click('button[data-tab="usage"]');
await page.waitForTimeout(3000);
await shot('usage', true);

// History
await page.click('button[data-tab="history"]');
await page.waitForTimeout(2000);
await shot('history');

// Grouped view (expand the groups so cards show)
await page.click('button[data-tab="active"]');
await page.click('button[data-view="group"]');
await page.waitForTimeout(400);
// Each toggle re-renders, so re-query for a still-collapsed group every time.
for (let i = 0; i < 20; i++) {
  const h = await page.$('.group:not(.open) > .group-head');
  if (!h) break;
  await h.click();
  await page.waitForTimeout(150);
}
await page.waitForTimeout(2500);
await shot('grouped');

// In-browser terminal of the first session
const name = await page.$eval('.card', (el) => el.getAttribute('data-name')).catch(() => null);
if (name) {
  await page.goto(`${BASE}/terminal.html?session=${name}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await shot('terminal');
}

await browser.close();
console.log('done');
