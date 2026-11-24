import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedDemoDataDir } from './demoSeed.js';

// npm run demo, end to end without the web server: a seeded demo folder, the real index.ts started with the
// environment and the offline preload the launcher gives it (scripts/start-local.mjs), signed in to as the web app
// does (Origin, X-Holdr-Request), and every page's answers read through the API. Nothing here leaves the machine:
// the demo's API asks no market-data provider, and the preload refuses any connection that is not loopback.

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..', '..');
const repoRoot = path.resolve(apiDir, '..', '..');
const PASSWORD = 'demo-test-password-1234';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const newYorkDate = (now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);

let scratch = '';
let child: ChildProcess | null = null;
let output = '';
let base = '';
let cookie = '';
let today = '';

type Json = Record<string, any>;

async function get(route: string): Promise<Json> {
  const response = await fetch(`${base}${route}`, { headers: { Cookie: cookie, 'X-Holdr-Request': '1' } });
  const text = await response.text();
  expect(response.status, `${route}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text) as Json;
}

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'holdr-demo-api-test-'));
  const dataDir = path.join(scratch, 'holdr-demo', 'data');
  await seedDemoDataDir(dataDir, { password: PASSWORD });
  today = newYorkDate(new Date());

  const launcher = await import(pathToFileURL(path.join(repoRoot, 'scripts', 'start-local.mjs')).href) as {
    apiEnvFor: (base: NodeJS.ProcessEnv, options: { dataDir: string; apiPort: number; webPort: number; httpsOrigin: null; demo: true }) => NodeJS.ProcessEnv;
  };
  const apiPort = await freePort();
  const webPort = await freePort();
  const env = launcher.apiEnvFor(process.env, { dataDir, apiPort, webPort, httpsOrigin: null, demo: true });
  // A test run's own preloads (a loopback guard) reach the API too.
  if (process.env.NODE_OPTIONS) env.NODE_OPTIONS = process.env.NODE_OPTIONS;
  const offline = pathToFileURL(path.join(repoRoot, 'scripts', 'e2e-offline-fetch.mjs')).href;
  child = spawn(process.execPath, ['--import', 'tsx', '--import', offline, 'src/index.ts'], { cwd: apiDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk; });
  child.stderr!.on('data', (chunk: Buffer) => { output += chunk; });
  base = `http://127.0.0.1:${apiPort}`;
  let healthy = false;
  for (let attempt = 0; attempt < 300 && !healthy && child.exitCode === null; attempt += 1) {
    healthy = await fetch(`${base}/health`).then((response) => response.ok, () => false);
    if (!healthy) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(healthy, output).toBe(true);

  // Signed in as the web app at http://localhost:<web port> does.
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Holdr-Request': '1', Origin: `http://localhost:${webPort}` },
    body: JSON.stringify({ username: 'demo', password: PASSWORD }),
  });
  expect(login.status, await login.clone().text()).toBe(200);
  cookie = login.headers.getSetCookie().find((value) => value.startsWith('holdr_session='))!.split(';')[0];
}, 120_000);

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child!.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  }
  // Windows may release the stopped API's database files a moment later.
  if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the demo API', () => {
  it('runs on stored closes alone: no provider asked, nothing refused, no unknown setting', () => {
    expect(output).toContain('market data: stored closes only');
    expect(output).not.toMatch(/blocked|unknown setting|refused/i);
  });

  it('answers the Portfolio and Accounts pages: five accounts, their trades, cash events, prices, history and returns', async () => {
    const { accounts } = await get('/accounts');
    expect(accounts.map((account: Json) => account.name)).toEqual(['Alex · Brokerage', 'Alex · Roth IRA', 'Casey · Brokerage', 'Casey · Retirement', 'Casey · HSA']);
    expect((await get('/transactions')).transactions.length).toBeGreaterThan(100);
    const { cashEvents } = await get('/accounts/demo-alex-brokerage/cash-events');
    expect(new Set(cashEvents.map((event: Json) => event.eventType))).toEqual(new Set(['dividend', 'interest', 'deposit']));

    const quotes = await get('/quotes?symbols=NBIS,FNILX,QQQ');
    expect(quotes.missingSymbols).toEqual([]);
    expect(quotes.quotes).toHaveLength(3);
    for (const quote of quotes.quotes) {
      expect(quote).toMatchObject({ source: 'synthetic', changeBasis: 'previousClose' });
      expect(quote.price).toBeGreaterThan(0);
      expect(quote.baselinePrice).toBeGreaterThan(0);
    }
    const history = await get('/portfolio/history?range=1M');
    expect(history.supported).toBe(true);
    expect(history.points.length).toBeGreaterThan(15);
    // Up to the last market day (a weekend's is Friday's).
    expect(history.points.at(-1).t > newYorkDate(new Date(Date.now() - 5 * 86_400_000))).toBe(true);
    // A young household's savings: about $60,000 across the five accounts, cash included.
    expect(history.summary.endValue).toBeGreaterThan(60_000);
    expect(history.summary.endValue).toBeLessThan(65_000);
    const symbol = await get('/symbols/NBIS/history?range=3M');
    expect(symbol.sources).toEqual(['synthetic']);
    expect(symbol.points.length).toBeGreaterThan(50);
    const performance = await get('/portfolio/performance');
    expect(performance.supported).toBe(true);
    expect(performance.periods.length).toBeGreaterThan(0);
  });

  it('answers the Gold page: holdings valued from stored closes, purchases, and sales at a gain and a loss paid into checking', async () => {
    const overview = await get('/metals/overview?metal=XAU');
    expect(overview.installed).toBe(true);
    expect(overview.price).toMatchObject({ stale: false, fetching: true });
    expect(overview.holdings.valueMinor.value).toBeGreaterThan(0);
    // About half an ounce of gold and twenty of silver, every unit's fine content known (nothing to confirm).
    expect(overview.holdings.troyOz.value.display).toBe('0.550');
    expect(overview.holdings.contentUnknown.lots).toBe(0);
    expect((await get('/metals/overview?metal=XAG')).holdings.troyOz.value.display).toBe('20.000');
    expect((await get('/metals/purchases?metal=XAU')).purchases.length).toBeGreaterThanOrEqual(4);
    const gold = (await get('/metals/sales?metal=XAU')).sales;
    const silver = (await get('/metals/sales?metal=XAG')).sales;
    expect(gold.map((sale: Json) => Math.sign(sale.profitMinor.value))).toEqual([1]);
    expect(silver.map((sale: Json) => Math.sign(sale.profitMinor.value))).toEqual([-1]);
    for (const sale of [...gold, ...silver]) {
      expect(sale.payouts[0].deposit).toMatchObject({ state: 'linked', row: { account: { ending: '7007' } } });
    }
    expect((await get('/metals/timeline?metal=XAU')).months.length).toBeGreaterThan(12);
    const funding = await get('/metals/funding');
    expect(funding.sales.length + funding.deposits.length).toBeGreaterThan(0);
    expect((await get('/metals/closes?metal=XAU')).closes.length).toBeGreaterThan(250);
    // The default six-month view's sales figures are complete: every day of it is covered by a source's capture.
    const sixMonths = `from=${newYorkDate(new Date(Date.now() - 183 * 86_400_000))}&to=${today}`;
    for (const metal of ['XAU', 'XAG']) {
      const { activity } = await get(`/metals/overview?metal=${metal}&${sixMonths}`);
      expect([activity.sold.netMinor.state, activity.profit.valueMinor.state], metal).toEqual(['complete', 'complete']);
      expect(activity.sold.lines, metal).toBe(1);
    }
    // Nothing on the household's cards needs explaining: the card check raises no gap of its own. (The coverage proof
    // still names the source roster, which this build does not install, and so the history before it.)
    const check = await get('/metals/card-check');
    expect([check.gaps, check.groups]).toEqual([[], []]);
    const cardRaised = ['missing-account', 'missing-kind', 'unsupported-dealer', 'alias-unresolved', 'unexplained-charges', 'card-check-unavailable'];
    expect(overview.coverageProof.asOfScope.gaps.filter((gap: Json) => cardRaised.includes(gap.variant))).toEqual([]);
  });

  it('answers the Spending pages: card transactions, the forecast and patterns', async () => {
    const page = await get('/card-transactions?limit=50');
    expect(page.total).toBeGreaterThan(500);
    expect(page.transactions).toHaveLength(50);
    const forecast = await get('/spending/forecast');
    expect(forecast.months.length).toBeGreaterThanOrEqual(12);
    expect(forecast.pace.projectedMinor).toBeGreaterThan(0);
    expect((await get('/spending/patterns')).bills.items.length).toBeGreaterThan(0);
    expect((await get('/spending/summary')).byCard).toHaveLength(5);
  });

  it('answers the Benefits tab: premium cards, reimbursed credits with dates, credits still open, fees and owners', async () => {
    const report = await get(`/spending/benefits?year=${today.slice(0, 4)}&today=${today}`);
    const product = (nickname: string) => report.cards.find((card: Json) => card.nickname === nickname)?.product?.id ?? null;
    expect([product('Alex Gold Card'), product('Casey Platinum Card'), product('Joint Strata Elite'), product('Casey Everyday Visa')])
      .toEqual(['amex-gold', 'amex-platinum', 'citi-strata-elite', null]);
    expect(report.household.annualFeesMinor).toBe(181_500);
    expect(report.household.capturedMinor).toBeGreaterThan(0);
    expect(Object.keys(report.household.byOwner).sort()).toEqual(['alex', 'casey', 'joint']);
    // No card waits for a product, so the summary has no "Not counted yet" line.
    expect(report.cards.filter((card: Json) => card.product === null && card.productChoice !== 'none')).toEqual([]);
    const benefits = report.cards.flatMap((card: Json) => card.benefits);
    const matches = benefits.flatMap((benefit: Json) => benefit.periods).flatMap((period: Json) => period.matches);
    expect(matches.length).toBeGreaterThan(5);
    expect(matches.every((match: Json) => /^\d{4}-\d{2}-\d{2}$/.test(match.date) && match.amountMinor !== 0)).toBe(true);
    const open = benefits.map((benefit: Json) => benefit.current).filter((period: Json | null) => period && (period.remainingMinor ?? 1) > 0);
    expect(open.length).toBeGreaterThan(3);
    expect(benefits.some((benefit: Json) => benefit.periods.some((period: Json) => period.source === 'manual'))).toBe(true);
  });

  it('answers Owed now and the payment checks: each card\'s statement, and autopays matched to checking debits', async () => {
    const owed = await get('/cash/owed');
    expect(owed.installed).toBe(true);
    expect(owed.cards).toHaveLength(5);
    for (const card of owed.cards) {
      expect(card.read, card.nickname).not.toBeNull();
      expect(card.read.statementBalanceMinor, card.nickname).toBeGreaterThan(0);
      expect(card.read.paymentDueDate, card.nickname).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const payments = await get('/cash/payments');
    expect(payments.installed).toBe(true);
    expect(payments.cards).toHaveLength(5);

    const reconciliation = await get('/spending/payment-reconciliation');
    expect(reconciliation.checking.installed).toBe(true);
    expect(reconciliation.pairs.length).toBeGreaterThan(40);
    expect(reconciliation.ambiguous).toEqual([]);
    // Left over: only payments made after the bank was last read, and the bullion card's payments (a card kept out of Holdr).
    expect(reconciliation.unmatchedPayments.every((entry: Json) => entry.reason === 'checking-not-covered')).toBe(true);
    expect(reconciliation.unmatchedDebits.every((entry: Json) => entry.reason === 'no-card-account')).toBe(true);
    expect((await get('/checking/accounts')).accounts).toHaveLength(1);
  });
});
