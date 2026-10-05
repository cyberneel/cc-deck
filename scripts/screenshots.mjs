// Generate README screenshots with Playwright's headless Chromium.
//
//   npm install playwright --no-save && npx playwright install chromium
//   TOKEN=$(node -e "import('../src/auth.js').then(m=>console.log(m.issueToken()))") \
//   BASE=http://localhost:8787 node scripts/screenshots.mjs
//
// By default this runs in DEMO mode: every /api/** response is mocked with
// fabricated data, so the screenshots contain NO personal session content.
// Set REAL=1 to screenshot your actual data instead (not recommended for a public repo).
//
// TOKEN must be a valid Polymux cookie value (the page HTML/JS is still auth-gated;
// only the /api/** data is mocked).
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.BASE || 'http://localhost:8787';
const TOKEN = process.env.TOKEN;
const DEMO = process.env.REAL !== '1';
if (!TOKEN) {
  console.error('Set TOKEN to a valid ccdeck cookie value (see header).');
  process.exit(1);
}

const OUT = new URL('../docs/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

// ---- fabricated demo data (no real content) ----
const HOME = '/home/dev';
const PREVIEW = `[dev@host auth-service]$ claude
 ▐▛███▜▌   Claude Code
 ▝▜█████▛▘
> Refactor the token refresh logic to retry once on 401
● I'll update the request interceptor and add a test.
  ⎿ Updated src/auth/interceptor.ts (+18 -4)
  ⎿ Added test: refreshes token and replays the request
● Done — interceptor retries once on 401, then logs out.`;

// Per-card previews so the grid shows each CLI doing something different.
const PREVIEWS = {
  'ccdeck-demo02': `[dev@host web-dashboard]$ claude
> Add a dark-mode toggle to the settings page
● Update(src/settings/Theme.tsx)
  ⎿ Do you want to make this edit to Theme.tsx?
    ❯ 1. Yes
      2. Yes, allow all edits this session
      3. No, and tell Claude what to do differently`,
  'ccdeck-demo03': `[dev@host data-pipeline]$ codex
> Speed up the nightly batch job
• Ran: python -m cProfile -s cumtime jobs/nightly.py
• The CSV parse dominates (71%). Switching to pyarrow.
  └ Edited jobs/nightly.py (+12 -9)
• Nightly run: 14m → 3m 40s`,
  'ccdeck-demo04': `[dev@host docs-site]$ agy
> Write a getting-started page for the CLI
✦ Drafted docs/getting-started.md (install, first run,
  config, troubleshooting) and linked it from the sidebar.
✦ Build passes — 0 broken links.`,
  'ccdeck-demo05': `[dev@host billing]$ claude
> Plan the retry/backoff for failed webhook deliveries
● Plan:
  1. Persist failed deliveries with attempt count
  2. Exponential backoff (1m → 6h), jittered
  3. Dead-letter after 8 attempts + alert
  Ready to implement when you approve.`,
};

const now = Date.now();
const min = 60_000;
const live = (n) => `1111111${n}-aaaa-4bbb-8ccc-000000000000`.slice(-36);
const DEMO_SESSIONS = [
  { name: 'ccdeck-demo01', title: 'auth-service', dir: `${HOME}/projects/auth-service`, kind: 'claude', attached: false, paneCommand: 'claude', claudeStatus: 'busy', mode: 'auto', liveSessionId: live(1), noteCount: 1, lastActivity: now - 2 * min, created: now - 40 * min },
  { name: 'ccdeck-demo02', title: 'web-dashboard', dir: `${HOME}/projects/web-dashboard`, kind: 'claude', attached: true, paneCommand: 'claude', claudeStatus: 'idle', waitingFor: 'permission', mode: 'acceptEdits', liveSessionId: live(2), lastActivity: now - 8 * min, created: now - 90 * min },
  { name: 'ccdeck-demo03', title: 'data-pipeline', dir: `${HOME}/work/data-pipeline`, kind: 'codex', attached: false, paneCommand: 'node', lastActivity: now - 35 * min, created: now - 200 * min },
  { name: 'ccdeck-demo04', title: 'docs-site', dir: `${HOME}/projects/docs-site`, kind: 'agy', attached: false, paneCommand: 'node', lastActivity: now - 50 * min, created: now - 240 * min },
  { name: 'ccdeck-demo05', title: 'billing-webhooks', dir: `${HOME}/work/billing`, kind: 'claude', attached: false, paneCommand: 'claude', claudeStatus: 'idle', mode: 'plan', liveSessionId: live(5), lastActivity: now - 70 * min, created: now - 300 * min },
];
const fakeId = (n) => `0000000${n}-aaaa-4bbb-8ccc-000000000000`.slice(-36);
const DEMO_HISTORY = [
  { title: 'Add OAuth2 login flow with refresh tokens', cwd: `${HOME}/projects/auth-service`, gitBranch: 'feat/oauth' },
  { title: 'Fix flaky integration test in CI', cwd: `${HOME}/projects/web-dashboard`, gitBranch: 'fix/ci-retry' },
  { title: 'Refactor payment webhook handler', cwd: `${HOME}/work/billing`, gitBranch: 'main' },
  { title: 'Migrate database to Postgres 16', cwd: `${HOME}/work/data-pipeline`, gitBranch: 'feat/pg16' },
  { title: 'Write README and one-command setup script', cwd: `${HOME}/projects/cli-tool`, gitBranch: 'main' },
  { title: 'Investigate memory growth in the worker', cwd: `${HOME}/work/data-pipeline`, gitBranch: 'main' },
].map((h, i) => ({ ...h, sessionId: fakeId(i + 1), lastModified: now - (i + 1) * 7 * 3600_000, sizeKb: 120 + i * 90 }));

const DEMO_USAGE = (() => {
  const day = 86_400_000;
  const daily = [];
  const pattern = [3, 6, 2, 8, 11, 5, 0, 4, 9, 14, 7, 6, 3, 10, 13, 8, 5, 2, 7, 12, 9, 4, 6, 11, 15, 8, 5, 9, 13, 18];
  for (let i = 29; i >= 0; i--) daily.push({ date: new Date(now - i * day).toISOString().slice(0, 10), cost: pattern[29 - i] });
  const cycleCost = 312.4;
  return {
    generatedAt: now,
    totalEvents: 1240,
    windows: {
      last24h: { cost: 18.0, messages: 64, totalTokens: 22_000_000 },
      last7d: { cost: 121.5, messages: 480, totalTokens: 150_000_000 },
      last30d: { cost: 470.2, messages: 1980, totalTokens: 620_000_000 },
      cycle: { cost: cycleCost, messages: 1240, totalTokens: 410_000_000 },
    },
    cycle: { billingDay: 1, start: now - 12 * day, end: now + 18 * day, daysElapsed: 12, daysInCycle: 30, projectedCost: (cycleCost / 12) * 30 },
    byModel: [
      { model: 'claude-opus-5-5', messages: 920, input: 2_100_000, output: 5_400_000, cacheWrite: 18_000_000, cacheRead: 294_500_000, totalTokens: 320_000_000, cost: 248.6 },
      { model: 'claude-sonnet-5', messages: 250, input: 600_000, output: 1_300_000, cacheWrite: 4_100_000, cacheRead: 64_000_000, totalTokens: 70_000_000, cost: 49.3 },
      { model: 'claude-haiku-4-5', messages: 70, input: 300_000, output: 500_000, cacheWrite: 1_200_000, cacheRead: 18_000_000, totalTokens: 20_000_000, cost: 14.5 },
    ],
    daily,
  };
})();

const DEMO_BURN = {
  available: true,
  limits: {
    session: { utilization: 0.34, budget_pace: 0.61, resets_in_minutes: 82, resets_in_hours: null, window_hours: 5, status: 'behind_pace' },
    weekly: { utilization: 0.21, budget_pace: 0.44, resets_in_minutes: null, resets_in_hours: 96, window_hours: 168, status: 'behind_pace' },
  },
  scopedWeekly: [{ model: 'Fable', utilization: 0.12, budget_pace: 0.44, resets_in_hours: 96, window_hours: 168, status: 'behind_pace' }],
  burn_rate: { limit: 'session', percent_per_hour: 4.1, trend: 'low' },
  recommendation: 'plenty_available',
};

function mockFor(pathname) {
  if (pathname === '/api/config') return { roots: [`${HOME}/projects`, `${HOME}/work`], launchCommand: 'claude', home: HOME, providers: [{ kind: 'claude', label: 'Claude' }, { kind: 'codex', label: 'Codex' }, { kind: 'agy', label: 'Agy' }] };
  if (pathname === '/api/sessions') return { sessions: DEMO_SESSIONS };
  const pv = pathname.match(/^\/api\/sessions\/(.+)\/preview$/);
  if (pv) return { text: PREVIEWS[pv[1]] || PREVIEW };
  if (pathname === '/api/history') return { sessions: DEMO_HISTORY, total: DEMO_HISTORY.length, truncated: false };
  if (pathname === '/api/usage') return DEMO_USAGE;
  if (pathname === '/api/burn') return DEMO_BURN;
  return {};
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1340, height: 880 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: 'ccdeck', value: TOKEN, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
// Skip the first-run welcome so it doesn't cover the dashboard.
await ctx.addInitScript(() => localStorage.setItem('ccdeck.introSeen.v1', '1'));
const page = await ctx.newPage();

if (DEMO) {
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockFor(url.pathname)) });
  });
}

const shot = async (name, full = false) => {
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: full });
  console.log('wrote docs/' + name + '.png');
};

await page.goto(BASE + '/', { waitUntil: 'networkidle' });
// body (height:100%) is the scroller, so fullPage and window.scrollTo miss it; let the document scroll instead.
await page.addStyleTag({ content: 'html, body { height: auto !important; }' });
await page.waitForTimeout(1500);
await shot('active');

await page.click('button[data-tab="usage"]');
await page.waitForTimeout(1500);
await shot('usage', true);

await page.click('button[data-tab="history"]');
await page.waitForTimeout(1200);
await shot('history');

await page.click('button[data-tab="active"]');
await page.click('button[data-view="group"]');
await page.waitForTimeout(400);
for (let i = 0; i < 20; i++) {
  const h = await page.$('.group:not(.open) > .group-head');
  if (!h) break;
  await h.click({ force: true });
  await page.waitForTimeout(200);
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(1200);
await shot('grouped');

await browser.close();
console.log('done' + (DEMO ? ' (demo data)' : ' (REAL data)'));
