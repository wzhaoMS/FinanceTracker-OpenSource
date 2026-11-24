import { MOCKED_API, requireHealthyApi, test, expect, type Locator, type Page } from './fixtures';
import { AT } from './marketClock';

/**
 * Phase E.4 — minimal browser smoke suite.
 *
 * Covers the highest-risk UX surfaces caught by the whole-app review:
 *   1. Initial Portfolio render: banners, header badges, holdings table
 *   2. Combined Holdings: row expansion to contributors
 *   3. Symbol chart: open from row, range switch, crosshair updates
 *      headline (D.1)
 *   4. Portfolio chart: range switch, 1D empty state, Approx popover
 *   5. Per-account chart toggle (E.5)
 *   6. Manual Prices panel (E.7) round-trip: PUT, list, DELETE
 *
 * Runs against a disposable live stack. A test fails, never skips, when
 * /health is unreachable or unhealthy, unless it is tagged MOCKED_API.
 */

const QUOTE_FIXTURE_PRICES = new Map<string, number>([
  ['NBIS', 216.20], ['NVDA', 202.78], ['GOOGL', 358.89], ['CEG', 250.74],
  ['FBTC', 54.96], ['MSFT', 384.36], ['TSLA', 406.55], ['VST', 157.98],
  ['PLTR', 129.04], ['SGOV', 100.48], ['AMZN', 247.04], ['QQQ', 723.28],
  ['TLRY', 4.39], ['CRWV', 89.70], ['SLB', 47.24],
]);

const OCC_OPTION_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;

// Incomplete quote fixtures hide the chart headers this suite exercises.
function syntheticQuotePrice(symbol: string): number {
  let hash = 0;
  for (let index = 0; index < symbol.length; index += 1) hash = (hash * 31 + symbol.charCodeAt(index)) >>> 0;
  return OCC_OPTION_SYMBOL.test(symbol)
    ? Number((2 + (hash % 1_000) / 100).toFixed(2))
    : Number((20 + (hash % 48_000) / 100).toFixed(2));
}

async function installQuoteFixture(page: Page) {
  await page.route('**/quotes?**', async (route) => {
    const asOf = Date.now();
    const requested = (new URL(route.request().url()).searchParams.get('symbols') ?? '')
      .split(',')
      .filter(Boolean);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        quotes: requested.map((symbol) => {
          const price = QUOTE_FIXTURE_PRICES.get(symbol) ?? syntheticQuotePrice(symbol);
          return {
            symbol,
            price,
            currency: 'USD',
            asOf,
            source: 'unknown',
            freshness: 'live',
            session: 'regular',
            changeBasis: 'previousClose',
            baselinePrice: price - 1,
            dayChange: 1,
            dayChangePercent: (1 / (price - 1)) * 100,
          };
        }),
        fallbackSymbols: [],
        missingSymbols: [],
      }),
    });
  });
}

// Format in the browser so expectations share its locale and timezone.
function chartDateLabel(page: Page, value: string): Promise<string> {
  return page.evaluate((raw) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00Z`) : new Date(raw);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }, value);
}

interface ObservedCoverageBody {
  coverage: {
    requestedFrom: string;
    requestedTo: string;
    actualFrom: string | null;
    actualTo: string | null;
    complete: boolean;
    percent: number;
  };
  reliability?: { unreliablePoints: number; latestReliableFrom: string | null };
}

async function expectObservedCoverageLine(
  page: Page,
  chart: Locator,
  body: ObservedCoverageBody,
  range: string,
) {
  const line = chart.locator('.portfolio-chart-coverage');
  const unreliablePoints = body.reliability?.unreliablePoints ?? 0;
  if (unreliablePoints > 0) {
    expect(body.reliability?.latestReliableFrom).toBeTruthy();
    await expect(line).toContainText(
      `since ${await chartDateLabel(page, body.reliability!.latestReliableFrom!)}`,
    );
  } else {
    expect(body.coverage.actualFrom).toBeTruthy();
    await expect(line).toContainText(
      `Observed since ${await chartDateLabel(page, body.coverage.actualFrom!)}`
      + ` · ${body.coverage.percent.toFixed(1)}% of requested ${range}`,
    );
  }
  await expect(chart.locator('.portfolio-chart-change')).toHaveCount(0);
}

test.beforeEach(async ({ page, request }, testInfo) => {
  // Every test here needs the live API behind WEB_URL, except the focused
  // chart regressions tagged MOCKED_API: they mock every data route and only
  // need the Vite page (their API contracts are covered in
  // portfolioHistory.test.ts).
  //
  // An unreachable or unhealthy API FAILS the test. A failed health check is
  // never a reason to skip: this suite only runs against a disposable stack
  // with HOLDR_E2E_WRITES=1, and a release run must not finish green while
  // skipping what it should validate.
  if (!testInfo.tags.includes(MOCKED_API)) {
    await requireHealthyApi(request);
  }
  if (!testInfo.title.includes('partial quotes')) {
    await installQuoteFixture(page);
  }
  await page.goto('/');
});

test('renders local-only chip + header badges + holdings', async ({ page }) => {
  // Sprint 1: the persistent .banner.local-only was demoted to a compact
  // header chip (.local-only-chip) so the security note doesn't take a
  // full row on every render. Full warning still in title/aria-label.
  await expect(page.locator('.local-only-chip')).toBeVisible();
  await expect(page.locator('.local-only-chip')).toHaveAttribute('title', /Local only/);
  // Quote status badge: scope to the actual quote-status (which has
  // .quote-live / .quote-pre / .quote-after / .quote-eod / .quote-stale /
  // .quote-delayed / .quote-synthetic). The Snapshot pill also reuses .quote-status as a
  // base class but has no kind modifier, so we filter by the kind classes.
  const quoteStatus = page.locator(
    '.quote-status.quote-live, .quote-status.quote-pre, .quote-status.quote-after,'
    + ' .quote-status.quote-eod, .quote-status.quote-stale, .quote-status.quote-delayed, .quote-status.quote-synthetic',
  ).first();
  await expect(quoteStatus).toBeVisible();
  // Badge grammar. `Partial N` would mean the fixture left a held symbol
  // unpriced, which silently strips the chart header rows other tests assert.
  await expect(quoteStatus).toHaveText(/^(Live|Pre-market|After hours|Closed|Stale|Delayed|Synthetic)$/);
  // Combined Holdings header is visible.
  await expect(page.locator('.account.combined .account-name')).toContainText('Invested holdings');
});

test('1D chart keeps normal movement legible when a leading snapshot is anomalous', { tag: MOCKED_API }, async ({ page }, testInfo) => {
  let partialCoverage = false;
  const normalValues = Array.from({ length: 24 }, (_, index) => 1_120_000 + index * 1_000);
  const points = [119_169.55, ...normalValues].map((value, index) => ({
    t: new Date(Date.parse('2026-07-10T13:00:00Z') + index * 5 * 60_000).toISOString(),
    value,
    costBasis: index === 0 ? 119_169.55 : 974_860.65,
  }));
  await page.route('**/accounts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      accounts: [{ id: 'chart-account', name: 'Chart account', cashBalance: 1_143_000, currency: 'USD' }],
    }),
  }));
  await page.route('**/transactions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ transactions: [] }),
  }));
  await page.route('**/portfolio/history?**', (route) => {
    const responsePoints = partialCoverage ? points.slice(-6) : points;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
      range: '1D',
      from: '2026-07-10',
      to: '2026-07-10',
      supported: true,
      approximate: false,
      approximationReasons: [],
      source: 'snapshots',
      valueMethod: 'observed_snapshot',
      coverage: {
        requestedFrom: '2026-07-10', requestedTo: '2026-07-10',
        actualFrom: responsePoints[0].t, actualTo: responsePoints.at(-1)?.t ?? null,
        complete: !partialCoverage, percent: partialCoverage ? 25 : 100,
      },
      points: responsePoints,
      summary: {
        startValue: responsePoints[0].value,
        endValue: responsePoints.at(-1)?.value ?? 0,
        change: (responsePoints.at(-1)?.value ?? 0) - responsePoints[0].value,
        changePercent: (((responsePoints.at(-1)?.value ?? 0) - responsePoints[0].value) / responsePoints[0].value) * 100,
      },
      }),
    });
  });
  await page.evaluate(() => localStorage.removeItem('finance-tracker:state:v2'));
  await page.reload();

  const line = page.locator('.breakdown > .portfolio-chart .symbol-chart-line');
  await expect(line).toBeVisible();
  const geometry = await line.evaluate((path) => {
    const commands = (path.getAttribute('d') ?? '').match(/[MLC][^MLCZ]*/g) ?? [];
    const coordinates = commands.map((command) => {
      const values = command.slice(1).trim().split(/[\s,]+/).map(Number);
      return command[0] === 'C'
        ? [values[values.length - 2], values[values.length - 1]]
        : [values[0], values[1]];
    });
    const xCoordinates = coordinates.map(([x]) => x);
    const yCoordinates = coordinates.map(([, y]) => y);
    return {
      pointCount: coordinates.length,
      xMin: Math.min(...xCoordinates),
      xMax: Math.max(...xCoordinates),
      spread: Math.max(...yCoordinates) - Math.min(...yCoordinates),
    };
  });
  expect(geometry.pointCount).toBe(normalValues.length);
  expect(geometry.xMin).toBeCloseTo(4, 5);
  expect(geometry.xMax).toBeCloseTo(796, 5);
  expect(geometry.spread).toBeGreaterThan(180);
  const chart = page.locator('.breakdown > .portfolio-chart');
  await expect(chart.locator('.portfolio-chart-change')).toContainText('$23,000.00');
  await expect(chart.locator('.portfolio-chart-change')).toContainText('2.05%');
  await expect(chart).not.toContainText('854%');
  const desktopScreenshot = testInfo.outputPath('1d-chart-endpoint-outlier-desktop.png');
  await chart.screenshot({ path: desktopScreenshot, animations: 'disabled' });
  await testInfo.attach('1d-chart-endpoint-outlier-desktop', {
    path: desktopScreenshot,
    contentType: 'image/png',
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await chart.scrollIntoViewIfNeeded();
  const mobileGeometry = await line.evaluate((path) => {
    const box = path.getBoundingClientRect();
    return { width: box.width, height: box.height };
  });
  expect(mobileGeometry.height).toBeGreaterThan(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const mobileScreenshot = testInfo.outputPath('1d-chart-endpoint-outlier-mobile.png');
  await chart.screenshot({ path: mobileScreenshot, animations: 'disabled' });
  await testInfo.attach('1d-chart-endpoint-outlier-mobile', {
    path: mobileScreenshot,
    contentType: 'image/png',
  });

  partialCoverage = true;
  await page.setViewportSize({ width: 700, height: 900 });
  await page.reload();
  await expect(chart.locator('.portfolio-chart-coverage')).toContainText('25.0%');
  await expect(chart.locator('.portfolio-chart-coverage')).toContainText('latest session');
  await expect(chart.locator('.chart-unobserved-region')).toHaveCount(0);
  const partialGeometry = await line.evaluate((path) => {
    const commands = (path.getAttribute('d') ?? '').match(/[MLC][^MLCZ]*/g) ?? [];
    const coordinates = commands.map((command) => {
      const values = command.slice(1).trim().split(/[\s,]+/).map(Number);
      return command[0] === 'C'
        ? [values[values.length - 2], values[values.length - 1]]
        : [values[0], values[1]];
    });
    const xCoordinates = coordinates.map(([x]) => x);
    return { pointCount: coordinates.length, xMin: Math.min(...xCoordinates), xMax: Math.max(...xCoordinates) };
  });
  expect(partialGeometry.pointCount).toBe(6);
  expect(partialGeometry.xMin).toBeCloseTo(4, 5);
  expect(partialGeometry.xMax).toBeCloseTo(796, 5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const panelScreenshot = testInfo.outputPath('1d-chart-partial-small-panel.png');
  await chart.screenshot({ path: panelScreenshot, animations: 'disabled' });
  await testInfo.attach('1d-chart-partial-small-panel', {
    path: panelScreenshot,
    contentType: 'image/png',
  });
});

test('1D chart breaks its line across a gap in observations and draws lone ones as points', { tag: MOCKED_API }, async ({ page }, testInfo) => {
  // Observed 9:18–9:28 AM, then nothing until 11:22 AM New York time: the line must not join the two.
  const runs = [
    ['2026-10-19T13:18:00.000Z', '2026-10-19T13:23:00.000Z', '2026-10-19T13:28:00.000Z'],
    ['2026-10-19T15:22:00.000Z', '2026-10-19T15:27:00.000Z'],
  ];
  let lone = false;
  await page.route('**/accounts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ accounts: [{ id: 'gap-account', name: 'Gap account', cashBalance: 1_100_000, currency: 'USD' }] }),
  }));
  await page.route('**/transactions', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ transactions: [] }),
  }));
  await page.route('**/portfolio/history?**', (route) => {
    const times = lone ? [runs[0][2], runs[1][0]] : runs.flat();
    const points = times.map((t, index) => ({
      t,
      value: 1_100_000 - index * 2_000,
      costBasis: 900_000,
      ...(t === runs[1][0] ? { gapBefore: true } : {}),
    }));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        range: '1D', from: '2026-10-19', to: '2026-10-19', supported: true,
        approximate: false, approximationReasons: [], source: 'snapshots', valueMethod: 'observed_snapshot',
        coverage: {
          requestedFrom: '2026-10-19', requestedTo: '2026-10-19',
          actualFrom: times[0], actualTo: times.at(-1), complete: false, percent: lone ? 2.2 : 4.5,
        },
        points,
        summary: {
          startValue: points[0].value, endValue: points.at(-1)!.value,
          change: points.at(-1)!.value - points[0].value,
          changePercent: ((points.at(-1)!.value - points[0].value) / points[0].value) * 100,
        },
      }),
    });
  });
  await page.evaluate(() => localStorage.removeItem('finance-tracker:state:v2'));
  await page.reload();

  const chart = page.locator('.breakdown > .portfolio-chart');
  const line = chart.locator('.symbol-chart-line');
  await expect(line).toBeVisible();
  const subpaths = () => line.evaluate((path) => (path.getAttribute('d') ?? '').match(/M[^M]*/g) ?? []);
  // One subpath per observed stretch; nothing joins 9:28 to 11:22.
  expect(await subpaths()).toHaveLength(2);
  await expect(chart.locator('.portfolio-chart-coverage')).toContainText('4.5% of latest session');
  const desktop = testInfo.outputPath('1d-chart-gap-desktop.png');
  await chart.screenshot({ path: desktop, animations: 'disabled' });
  await testInfo.attach('1d-chart-gap-desktop', { path: desktop, contentType: 'image/png' });

  lone = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(chart.locator('.portfolio-chart-coverage')).toContainText('2.2% of latest session');
  // Two lone observations: two points (zero-length subpaths with round caps), no line between them.
  const lonePaths = await subpaths();
  expect(lonePaths).toHaveLength(2);
  expect(lonePaths.every((d) => /l0,0$/.test(d))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const mobile = testInfo.outputPath('1d-chart-lone-points-mobile.png');
  await chart.screenshot({ path: mobile, animations: 'disabled' });
  await testInfo.attach('1d-chart-lone-points-mobile', { path: mobile, contentType: 'image/png' });
});

test('1D at market prices spans the session, never breaks, and says where prices were carried', { tag: MOCKED_API }, async ({ page }, testInfo) => {
  // 4:00 AM to 2:00 PM New York time every 5 minutes, on an axis that runs to 4:00 PM.
  const times: string[] = [];
  for (let at = Date.parse('2026-10-19T08:00:00.000Z'); at <= Date.parse('2026-10-19T18:00:00.000Z'); at += 300_000) {
    times.push(new Date(at).toISOString());
  }
  const estimated = (t: string) => t >= '2026-10-19T14:00:00.000Z' && t <= '2026-10-19T14:30:00.000Z';
  await page.route('**/accounts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ accounts: [{ id: 'market-account', name: 'Market account', cashBalance: 1_000_000, currency: 'USD' }] }),
  }));
  await page.route('**/transactions', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ transactions: [] }),
  }));
  await page.route('**/portfolio/history?**', (route) => {
    const points = times.map((t, index) => ({
      t, value: 1_000_000 + index * 100, costBasis: 900_000, ...(estimated(t) ? { estimated: true } : {}),
    }));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        range: '1D', from: '2026-10-19', to: '2026-10-19', supported: true, approximate: true,
        approximationReasons: [
          'computed every 5 minutes from the current holdings at market prices plus each account\'s current cash',
          '7 points estimated: holdings worth over 1% of the value had no price for more than 30 minutes',
        ],
        source: 'intraday_prices', valueMethod: 'holdings_at_market',
        coverage: {
          requestedFrom: '2026-10-19', requestedTo: '2026-10-19',
          actualFrom: times[0], actualTo: times.at(-1), complete: true, percent: 100,
        },
        points,
        window: { from: '2026-10-19T08:00:00.000Z', to: '2026-10-19T20:00:00.000Z' },
        reliability: { totalPoints: points.length, unreliablePoints: 0, latestReliableFrom: times[0] },
        summary: {
          startValue: points[0].value, endValue: points.at(-1)!.value,
          change: points.at(-1)!.value - points[0].value,
          changePercent: ((points.at(-1)!.value - points[0].value) / points[0].value) * 100,
        },
      }),
    });
  });
  await page.evaluate(() => localStorage.removeItem('finance-tracker:state:v2'));
  await page.reload();

  const chart = page.locator('.breakdown > .portfolio-chart');
  const line = chart.locator('.symbol-chart-line');
  await expect(line).toBeVisible();
  // One unbroken line, ending at 2:00 PM, ten twelfths along an axis from 4:00 AM to 4:00 PM.
  const geometry = await line.evaluate((path) => {
    const d = path.getAttribute('d') ?? '';
    const numbers = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const viewBox = (path.ownerSVGElement?.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
    return { subpaths: (d.match(/M/g) ?? []).length, lastX: numbers[numbers.length - 2], width: viewBox[2] };
  });
  expect(geometry.subpaths).toBe(1);
  expect(geometry.lastX / geometry.width).toBeGreaterThan(0.7);
  expect(geometry.lastX / geometry.width).toBeLessThan(0.9);

  const svg = chart.locator('.symbol-chart-svg');
  await svg.focus();
  for (let index = 0; index < 72; index++) await svg.press('ArrowRight');
  const change = chart.locator('.portfolio-chart-change');
  await expect(change).toContainText('estimated: some prices are over 30 minutes old');
  for (let index = 0; index < 7; index++) await svg.press('ArrowRight');
  await expect(change).not.toContainText('estimated');
  await svg.press('Escape');

  await chart.getByRole('button', { name: 'How this line is computed' }).click();
  await expect(chart.locator('.approx-popover-title')).toHaveText('How this line is computed');
  const desktop = testInfo.outputPath('1d-market-line-desktop.png');
  await chart.screenshot({ path: desktop, animations: 'disabled' });
  await testInfo.attach('1d-market-line-desktop', { path: desktop, contentType: 'image/png' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(line).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const mobile = testInfo.outputPath('1d-market-line-mobile.png');
  await chart.screenshot({ path: mobile, animations: 'disabled' });
  await testInfo.attach('1d-market-line-mobile', { path: mobile, contentType: 'image/png' });
});

test('1W at market prices sets five sessions side by side in one line, and says how it is computed', { tag: MOCKED_API }, async ({ page }, testInfo) => {
  // Five sessions, 4:00 AM to 8:00 PM New York time every 10 minutes; nights and the weekend have no points.
  const times: string[] = [];
  for (const day of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']) {
    const open = Date.parse(`${day}T08:00:00.000Z`);
    for (let at = open; at <= open + 16 * 3_600_000; at += 600_000) times.push(new Date(at).toISOString());
  }
  await page.route('**/accounts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ accounts: [{ id: 'market-account', name: 'Market account', cashBalance: 1_000_000, currency: 'USD' }] }),
  }));
  await page.route('**/transactions', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ transactions: [] }),
  }));
  await page.route('**/portfolio/history?**', (route) => {
    const range = new URL(route.request().url()).searchParams.get('range') ?? '1D';
    const points = times.map((t, index) => ({ t, value: 1_000_000 + index * 10, costBasis: 900_000 }));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        range, from: '2026-10-12', to: '2026-10-16', supported: true, approximate: false,
        approximationReasons: [
          "computed every 10 minutes over the last 5 sessions from each day's holdings at market prices plus its cash",
        ],
        source: 'intraday_prices', valueMethod: 'holdings_at_market',
        coverage: {
          requestedFrom: '2026-10-09', requestedTo: '2026-10-16',
          actualFrom: times[0], actualTo: times.at(-1), complete: true, percent: 100,
        },
        points,
        reliability: { totalPoints: points.length, unreliablePoints: 0, latestReliableFrom: times[0] },
        summary: {
          startValue: points[0].value, endValue: points.at(-1)!.value,
          change: points.at(-1)!.value - points[0].value,
          changePercent: ((points.at(-1)!.value - points[0].value) / points[0].value) * 100,
        },
      }),
    });
  });
  await page.evaluate(() => localStorage.removeItem('finance-tracker:state:v2'));
  await page.reload();

  const chart = page.locator('.breakdown > .portfolio-chart');
  await chart.getByRole('button', { name: '1W', exact: true }).click();
  await expect(chart.getByRole('button', { name: '1W', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const line = chart.locator('.symbol-chart-line');
  await expect(line).toBeVisible();
  // One unbroken line across the five sessions, from the left edge to the right.
  const geometry = await line.evaluate((path) => {
    const d = path.getAttribute('d') ?? '';
    const numbers = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const viewBox = (path.ownerSVGElement?.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
    return { subpaths: (d.match(/M/g) ?? []).length, firstX: numbers[0], lastX: numbers[numbers.length - 2], width: viewBox[2] };
  });
  expect(geometry.subpaths).toBe(1);
  expect(geometry.firstX / geometry.width).toBeLessThan(0.1);
  expect(geometry.lastX / geometry.width).toBeGreaterThan(0.9);
  await chart.getByRole('button', { name: 'How this line is computed' }).click();
  await expect(chart.locator('.approx-popover-title')).toHaveText('How this line is computed');
  const desktop = testInfo.outputPath('1w-market-line-desktop.png');
  await chart.screenshot({ path: desktop, animations: 'disabled' });
  await testInfo.attach('1w-market-line-desktop', { path: desktop, contentType: 'image/png' });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(line).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const mobile = testInfo.outputPath('1w-market-line-mobile.png');
  await chart.screenshot({ path: mobile, animations: 'disabled' });
  await testInfo.attach('1w-market-line-mobile', { path: mobile, contentType: 'image/png' });
});

test('1M chart renders daily observations instead of intraday blocks', { tag: MOCKED_API }, async ({ page }, testInfo) => {
  const points = [
    { t: '2026-06-10T20:00:00.000Z', value: 1_121_100, costBasis: 950_000 },
    { t: '2026-06-25T20:00:00.000Z', value: 1_101_100, costBasis: 950_000 },
    { t: '2026-07-10T20:00:00.000Z', value: 1_141_100, costBasis: 950_000 },
  ];
  await page.route('**/accounts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      accounts: [{ id: 'month-chart', name: 'Month chart', cashBalance: 1_150_000, currency: 'USD' }],
    }),
  }));
  await page.route('**/transactions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ transactions: [] }),
  }));
  await page.route('**/portfolio/history?**', (route) => {
    const range = new URL(route.request().url()).searchParams.get('range') ?? '1D';
    const responsePoints = range === '1M' ? points : points.slice(-2);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        range,
        from: '2026-06-10',
        to: '2026-07-10',
        supported: true,
        approximate: false,
        approximationReasons: [],
        source: 'snapshots',
        valueMethod: 'observed_snapshot',
        coverage: {
          requestedFrom: '2026-06-10', requestedTo: '2026-07-10',
          actualFrom: responsePoints[0].t, actualTo: responsePoints.at(-1)?.t ?? null,
          complete: true, percent: 100,
        },
        points: responsePoints,
        summary: {
          startValue: responsePoints[0].value,
          endValue: responsePoints.at(-1)?.value ?? 0,
          change: (responsePoints.at(-1)?.value ?? 0) - responsePoints[0].value,
          changePercent: (((responsePoints.at(-1)?.value ?? 0) - responsePoints[0].value) / responsePoints[0].value) * 100,
        },
      }),
    });
  });
  await page.evaluate(() => localStorage.removeItem('finance-tracker:state:v2'));
  await page.reload();
  const chart = page.locator('.breakdown > .portfolio-chart');
  await chart.getByRole('button', { name: '1M', exact: true }).click();
  await expect(chart.getByRole('button', { name: '1M', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const line = chart.locator('.symbol-chart-line');
  await expect(line).toBeVisible();
  await expect.poll(() => line.getAttribute('d').then((value) => (value?.match(/[MLC][^MLCZ]*/g) ?? []).length)).toBe(3);
  const geometry = await line.evaluate((path) => {
    const commands = (path.getAttribute('d') ?? '').match(/[MLC][^MLCZ]*/g) ?? [];
    const points = commands.map((command) => {
      const values = command.slice(1).trim().split(/[\s,]+/).map(Number);
      return command[0] === 'C'
        ? [values[values.length - 2], values[values.length - 1]]
        : [values[0], values[1]];
    });
    const x = points.map(([pointX]) => pointX);
    const y = points.map(([, pointY]) => pointY);
    return { pointCount: points.length, gaps: x.slice(1).map((value, index) => value - x[index]), y };
  });
  expect(geometry.pointCount).toBe(3);
  expect(Math.abs(geometry.gaps[0] - geometry.gaps[1])).toBeLessThan(0.01);
  expect(geometry.y[1]).toBeGreaterThan(geometry.y[0]);
  expect(geometry.y[0]).toBeGreaterThan(geometry.y[2]);
  await expect(chart.locator('.chart-extreme-high')).toContainText('1,141,100');
  await expect(chart.locator('.chart-extreme-low')).toContainText('1,101,100');
  await expect(chart.locator('.portfolio-chart-coverage')).toHaveCount(0);
  const desktopScreenshot = testInfo.outputPath('1m-daily-observations-desktop.png');
  await chart.screenshot({ path: desktopScreenshot, animations: 'disabled' });
  await testInfo.attach('1m-daily-observations-desktop', { path: desktopScreenshot, contentType: 'image/png' });

  await page.setViewportSize({ width: 390, height: 844 });
  await chart.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const mobileScreenshot = testInfo.outputPath('1m-daily-observations-mobile.png');
  await chart.screenshot({ path: mobileScreenshot, animations: 'disabled' });
  await testInfo.attach('1m-daily-observations-mobile', { path: mobileScreenshot, contentType: 'image/png' });
});

test('Portfolio chart: captured history stays continuous but never drives verified returns', { tag: MOCKED_API }, async ({ page }) => {
  await page.route('**/accounts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      accounts: [{ id: 'gap-account', name: 'Gap account', cashBalance: 100, currency: 'USD' }],
    }),
  }));
  await page.route('**/transactions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ transactions: [] }),
  }));
  await page.route('**/portfolio/history?**', async (route) => {
    const range = new URL(route.request().url()).searchParams.get('range') ?? '1D';
    const points = [
      { t: '2026-08-20T13:00:00.000Z', value: 1_000, costBasis: 900 },
      { t: '2026-08-20T14:00:00.000Z', value: 1_100, costBasis: 900 },
      { t: '2026-08-24T14:00:00.000Z', value: 1_200, costBasis: 900, unreliable: true },
      { t: '2026-08-27T18:05:00.000Z', value: 1_900, costBasis: 1_900, unreliable: true },
      { t: '2026-08-27T18:10:00.000Z', value: 2_000, costBasis: 1_900 },
      { t: '2026-08-27T18:15:00.000Z', value: 2_100, costBasis: 1_900 },
    ];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        range,
        from: '2026-08-20',
        to: '2026-08-27',
        supported: true,
        approximate: true,
        approximationReasons: [
          '2 captured snapshots predate later broker activity; shown as unverified context and excluded from return calculations',
        ],
        source: 'snapshots',
        valueMethod: 'observed_snapshot',
        coverage: {
          requestedFrom: '2026-08-20', requestedTo: '2026-08-27',
          actualFrom: points[0].t, actualTo: points.at(-1)?.t ?? null,
          complete: true, percent: 100,
        },
        reliability: {
          totalPoints: 6,
          unreliablePoints: 2,
          latestReliableFrom: '2026-08-27T18:10:00.000Z',
        },
        points,
        summary: { startValue: 2_000, endValue: 2_100, change: 100, changePercent: 5 },
      }),
    });
  });

  await page.reload();
  const chart = page.locator('.breakdown > .portfolio-chart');
  await chart.getByRole('button', { name: '1W', exact: true }).click();
  await expect(chart.locator('.symbol-chart-observed-line')).toHaveCount(1);
  await expect(chart.locator('.symbol-chart-verified-line')).toHaveCount(0);
  await expect(chart.locator('.symbol-chart-unreliable-line')).toHaveCount(0);
  await expect(chart.locator('.symbol-chart-area')).toHaveCount(1);
  await expect(chart.locator('.chart-unobserved-region')).toHaveCount(0);
  await expect(chart.locator('.chart-baseline-label')).toHaveCount(0);
  await expect(chart.locator('.portfolio-chart-reliability')).toContainText('Verified +$100.00');
  await expect(chart.locator('.portfolio-chart-series-legend')).toHaveCount(0);
  await expect(chart.locator('.symbol-chart-svg')).toHaveAttribute(
    'aria-label',
    /captured snapshots excluded from return calculations/,
  );
  await expect(chart).not.toContainText('50.0% of requested');

  const svg = chart.locator('.symbol-chart-svg');
  await svg.focus();
  await svg.press('ArrowRight');
  await svg.press('ArrowRight');
  await expect(chart.locator('.portfolio-chart-coverage')).toContainText('Captured before broker sync');
  await expect(chart.locator('.portfolio-chart-change')).toHaveCount(0);
  await svg.press('ArrowRight');
  await svg.press('ArrowRight');
  await svg.press('ArrowRight');
  await expect(chart.locator('.portfolio-chart-change')).toContainText('$100.00');
  await expect(chart.locator('.portfolio-chart-change')).not.toContainText('$1,100.00');

  await page.setViewportSize({ width: 320, height: 700 });
  await chart.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const rangeButtonTops = await chart.locator('.chart-floating-ranges .seg').evaluateAll((buttons) => (
    buttons.map((button) => Math.round(button.getBoundingClientRect().top))
  ));
  expect(new Set(rangeButtonTops).size).toBe(1);
  const mobileBounds = await chart.evaluate((root) => {
    const chartRect = root.getBoundingClientRect();
    const buttons = Array.from(root.querySelectorAll('.chart-floating-ranges .seg'));
    const reliability = root.querySelector('.portfolio-chart-reliability');
    return {
      buttonsInside: buttons.every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left >= chartRect.left - 1 && rect.right <= chartRect.right + 1;
      }),
      reliabilityHeight: reliability?.getBoundingClientRect().height ?? 0,
      reliabilityLineHeight: reliability ? Number.parseFloat(getComputedStyle(reliability).lineHeight) : 0,
      visibleTradeMarkers: Array.from(root.querySelectorAll('.trade-marker-badge'))
        .filter((marker) => getComputedStyle(marker).display !== 'none').length,
    };
  });
  expect(mobileBounds.buttonsInside).toBe(true);
  expect(mobileBounds.reliabilityHeight).toBeLessThanOrEqual(mobileBounds.reliabilityLineHeight + 1);
  expect(mobileBounds.visibleTradeMarkers).toBe(0);
});

test('Portfolio chart: ledger cash that stands in around a trade is approximate, and a cash correction is not a market move', { tag: MOCKED_API }, async ({ page }) => {
  await page.route('**/accounts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      accounts: [{ id: 'ledger-account', name: 'Ledger account', cashBalance: 1_090, currency: 'USD' }],
    }),
  }));
  await page.route('**/transactions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ transactions: [] }),
  }));
  await page.route('**/portfolio/history?**', async (route) => {
    const range = new URL(route.request().url()).searchParams.get('range') ?? '1M';
    const points = [
      { t: '2026-06-10', value: 1_000, costBasis: 900 },
      { t: '2026-06-11', value: 1_010, costBasis: 900, unreliable: true },
      { t: '2026-06-12', value: 1_020, costBasis: 900 },
      { t: '2026-06-15', value: 1_080, costBasis: 900, cashCorrection: true },
      { t: '2026-06-16', value: 1_090, costBasis: 900 },
    ];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        range,
        from: '2026-06-10',
        to: '2026-06-16',
        supported: true,
        approximate: true,
        approximationReasons: [
          "cash steps to the broker's balance where the recorded cash events don't reach it, a correction rather than a market move, which returns leave out: Ledger account (2026-06-15)",
        ],
        source: 'reconstruction',
        valueMethod: 'ledger_estimate',
        coverage: {
          requestedFrom: '2026-06-10', requestedTo: '2026-06-16',
          actualFrom: '2026-06-10', actualTo: '2026-06-16',
          complete: true, percent: 100,
        },
        reliability: { totalPoints: 5, unreliablePoints: 1, latestReliableFrom: '2026-06-12' },
        points,
        summary: { startValue: 1_020, endValue: 1_090, change: 70, changePercent: (70 / 1_020) * 100 },
      }),
    });
  });

  await page.reload();
  const chart = page.locator('.breakdown > .portfolio-chart');
  await chart.getByRole('button', { name: '1M', exact: true }).click();
  // The period change starts after the approximate day, never across it.
  await expect(chart.locator('.portfolio-chart-reliability')).toContainText('Verified +$70.00');

  const svg = chart.locator('.symbol-chart-svg');
  await svg.focus();
  await svg.press('ArrowRight');
  await expect(chart.locator('.portfolio-chart-coverage')).toContainText('Approximate cash');
  await expect(chart.locator('.portfolio-chart-coverage')).not.toContainText('Captured before broker sync');
  await svg.press('ArrowRight');
  await svg.press('ArrowRight');
  const change = chart.locator('.portfolio-chart-change');
  await expect(change).toContainText('+$60.00');
  await expect(change).toContainText("includes a cash correction to the broker's balance, not a market move");
});

test('persisted quote fallback keeps NAV visible and is never labeled live', { tag: MOCKED_API }, async ({ page }) => {
  await page.route('**/accounts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      accounts: [{ id: 'cached-account', name: 'Cached account', cashBalance: 100, currency: 'USD' }],
    }),
  }));
  await page.route('**/transactions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      transactions: [{
        id: 'cached-position', accountId: 'cached-account', symbol: 'AAPL',
        date: '2026-08-01', quantity: 2, pricePerUnit: 150, currency: 'USD',
      }],
    }),
  }));
  await page.route('**/quotes?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      quotes: [{
        symbol: 'AAPL', price: 200, currency: 'USD', asOf: Date.now(),
        source: 'cache', freshness: 'stale', session: 'regular',
      }],
      fallbackSymbols: ['AAPL'],
      missingSymbols: [],
    }),
  }));
  await page.route('**/portfolio/history?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      range: '1D', from: '2026-08-27', to: '2026-08-27', supported: true,
      approximate: false, approximationReasons: [], source: 'snapshots',
      valueMethod: 'observed_snapshot',
      coverage: {
        requestedFrom: '2026-08-27', requestedTo: '2026-08-27',
        actualFrom: '2026-08-27T13:00:00Z', actualTo: '2026-08-27T14:00:00Z',
        complete: true, percent: 100,
      },
      reliability: { totalPoints: 2, unreliablePoints: 0, latestReliableFrom: '2026-08-27T13:00:00Z' },
      points: [
        { t: '2026-08-27T13:00:00Z', value: 490, costBasis: 400 },
        { t: '2026-08-27T14:00:00Z', value: 500, costBasis: 400 },
      ],
      summary: { startValue: 490, endValue: 500, change: 10, changePercent: 10 / 490 * 100 },
    }),
  }));

  await page.evaluate(() => localStorage.removeItem('finance-tracker:quotes:v1'));
  await page.reload();
  const chart = page.locator('.breakdown > .portfolio-chart');
  await expect(chart.locator('.portfolio-chart-value')).toContainText('$500.00');
  await expect(chart).not.toContainText('Price unavailable');
  await expect(page.locator('.quote-status').filter({ hasText: 'Stale' })).toBeVisible();
  await expect(page.locator('.account.combined .account-value')).toContainText('$400.00');
  // The stale price is still used, and says so under its symbol, dated, without a hover.
  await expect(page.locator('.account.combined tr.holding-row').filter({ hasText: 'AAPL' }).locator('.holding-price-note'))
    .toHaveText(/^Stale price · /);
});

test('dense portfolio history adapts visual detail without losing observed extrema', { tag: MOCKED_API }, async ({ page }, testInfo) => {
  const start = Date.parse('2026-07-03T08:05:00.000Z');
  const points = Array.from({ length: 936 }, (_, index) => ({
    t: new Date(start + index * 10 * 60_000).toISOString(),
    value: 1_200_000 + Math.sin(index / 14) * 5_000 + Math.cos(index / 5) * 1_200 + index * 50,
    costBasis: 950_000,
  }));
  points[333].value = 1_100_000;
  points[707].value = 1_400_000;
  const transactions = [
    { id: 'dense-trade-1', accountId: 'dense-account', symbol: 'NBIS', date: '2026-07-05', quantity: 1, pricePerUnit: 200, currency: 'USD' },
    { id: 'dense-trade-1b', accountId: 'dense-account', symbol: 'NBIS', date: '2026-07-05', quantity: 2, pricePerUnit: 201, currency: 'USD' },
    { id: 'dense-trade-2', accountId: 'dense-account', symbol: 'NBIS', date: '2026-07-08', quantity: -1, pricePerUnit: 205, currency: 'USD' },
    { id: 'dense-trade-3', accountId: 'dense-account', symbol: 'NBIS', date: '2026-07-09', quantity: 1, pricePerUnit: 206, currency: 'USD' },
    { id: 'dense-trade-3b', accountId: 'dense-account', symbol: 'NBIS', date: '2026-07-09', quantity: -1, pricePerUnit: 207, currency: 'USD' },
  ];
  await page.route('**/accounts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      accounts: [{ id: 'dense-account', name: 'Dense chart', cashBalance: 1_200_000, currency: 'USD' }],
    }),
  }));
  await page.route('**/transactions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ transactions }),
  }));
  await page.route('**/portfolio/history?**', (route) => {
    const range = new URL(route.request().url()).searchParams.get('range') ?? '1D';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        range,
        from: '2026-07-03',
        to: '2026-07-09',
        supported: true,
        approximate: false,
        approximationReasons: [],
        source: 'snapshots',
        valueMethod: 'observed_snapshot',
        coverage: {
          requestedFrom: '2026-07-03', requestedTo: '2026-07-09',
          actualFrom: points[0].t, actualTo: points.at(-1)?.t ?? null,
          complete: true, percent: 100,
        },
        points,
        summary: {
          startValue: points[0].value,
          endValue: points.at(-1)?.value ?? 0,
          change: (points.at(-1)?.value ?? 0) - points[0].value,
          changePercent: (((points.at(-1)?.value ?? 0) - points[0].value) / points[0].value) * 100,
        },
      }),
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.removeItem('finance-tracker:state:v2'));
  await page.reload();
  const chart = page.locator('.breakdown > .portfolio-chart');
  await chart.getByRole('button', { name: '1W', exact: true }).click();
  await expect(chart.getByRole('button', { name: '1W', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const line = chart.locator('.symbol-chart-line');
  await expect(line).toBeVisible();

  const readGeometry = () => line.evaluate((path) => {
    const d = path.getAttribute('d') ?? '';
    const commands = d.match(/[MLC][^MLCZ]*/g) ?? [];
    const coordinates = commands.map((command) => {
      const values = command.slice(1).trim().split(/[\s,]+/).map(Number);
      return command[0] === 'C'
        ? [values[values.length - 2], values[values.length - 1]]
        : [values[0], values[1]];
    });
    const x = coordinates.map(([pointX]) => pointX);
    const y = coordinates.map(([, pointY]) => pointY);
    const box = path.closest('svg')!.getBoundingClientRect();
    return {
      pointCount: coordinates.length,
      cubicCount: (d.match(/C/g) ?? []).length,
      lineCount: (d.match(/L/g) ?? []).length,
      xMin: Math.min(...x), xMax: Math.max(...x),
      yMin: Math.min(...y), yMax: Math.max(...y),
      minYPointX: x[y.indexOf(Math.min(...y))],
      maxYPointX: x[y.indexOf(Math.max(...y))],
      endpointXs: x,
      width: box.width,
    };
  });
  const mobileGeometry = await readGeometry();
  const mobileTarget = Math.max(72, Math.min(240, Math.round(mobileGeometry.width / 3)));
  expect(mobileGeometry.pointCount).toBeGreaterThanOrEqual(mobileTarget - 10);
  expect(mobileGeometry.pointCount).toBeLessThanOrEqual(mobileTarget + 6);
  expect(mobileGeometry.cubicCount).toBe(mobileGeometry.pointCount - 1);
  expect(mobileGeometry.lineCount).toBe(0);
  expect(mobileGeometry.xMin).toBeCloseTo(4, 5);
  expect(mobileGeometry.xMax).toBeCloseTo(796, 5);
  expect(mobileGeometry.yMin).toBeCloseTo(8, 1);
  expect(mobileGeometry.yMax).toBeCloseTo(212, 1);
  await expect(chart.locator('.trade-marker-badge')).toHaveCount(3);
  await expect(chart.locator('.trade-marker-badge.multi')).toHaveCount(2);
  const buyMarker = chart.locator('.trade-marker-buy.multi');
  const sellMarker = chart.locator('.trade-marker-sell.single');
  const mixedMarker = chart.locator('.trade-marker-mixed.multi');
  await expect(buyMarker).toBeHidden();
  await expect(sellMarker).toBeHidden();
  await expect(mixedMarker).toBeHidden();

  await page.setViewportSize({ width: 900, height: 900 });
  await chart.scrollIntoViewIfNeeded();
  await expect(buyMarker).toHaveText('↑2');
  await expect(buyMarker).toHaveAccessibleName('2 NBIS trades: 2 buys on 2026-07-05');
  await expect(sellMarker).toHaveText('↓');
  await expect(sellMarker).toHaveAccessibleName('Sell 1 NBIS at 205 on 2026-07-08');
  await expect(mixedMarker).toHaveText('↕2');
  await expect(mixedMarker).toHaveAccessibleName('2 NBIS trades: 1 buy and 1 sell on 2026-07-09');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => buyMarker.evaluate((marker) => getComputedStyle(marker).transitionDuration)).toBe('0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await buyMarker.focus();
  await expect(page.getByRole('dialog', { name: 'Trade details' })).toBeVisible();
  await buyMarker.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Trade details' })).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await chart.scrollIntoViewIfNeeded();
  const ariaLabel = await chart.locator('.symbol-chart-svg').getAttribute('aria-label');
  const ariaCount = ariaLabel?.match(/936 points observed, (\d+) used for the trend line/);
  expect(ariaCount).not.toBeNull();
  expect(Number(ariaCount![1])).toBe(mobileGeometry.pointCount);
  expect(ariaLabel).toContain('inspect every observation');
  await expect(chart.locator('.chart-extreme').first()).toBeHidden();

  const svg = chart.locator('.symbol-chart-svg');
  const svgBox = await svg.boundingBox();
  expect(svgBox).not.toBeNull();
  await svg.dispatchEvent('pointermove', {
    clientX: svgBox!.x + (mobileGeometry.minYPointX / 800) * svgBox!.width,
    clientY: svgBox!.y + svgBox!.height / 2,
  });
  await expect(chart.locator('.portfolio-chart-value')).toContainText('$1,400,000.00');
  await svg.dispatchEvent('pointermove', {
    clientX: svgBox!.x + (mobileGeometry.maxYPointX / 800) * svgBox!.width,
    clientY: svgBox!.y + svgBox!.height / 2,
  });
  await expect(chart.locator('.portfolio-chart-value')).toContainText('$1,100,000.00');

  const unsampledIndex = points.findIndex((_, index) => {
    if (index === 0 || index === points.length - 1 || index === 333 || index === 707) return false;
    const x = 4 + (index / (points.length - 1)) * 792;
    return mobileGeometry.endpointXs.every((endpointX) => Math.abs(endpointX - x) > 0.01);
  });
  expect(unsampledIndex).toBeGreaterThan(0);
  const unsampledX = 4 + (unsampledIndex / (points.length - 1)) * 792;
  const unsampledValue = points[unsampledIndex].value;
  const unsampledY = 8 + (1 - (unsampledValue - 1_100_000) / 300_000) * 204;
  await svg.dispatchEvent('pointermove', {
    clientX: svgBox!.x + (unsampledX / 800) * svgBox!.width,
    clientY: svgBox!.y + svgBox!.height / 2,
  });
  await expect(chart.locator('.portfolio-chart-value')).toContainText(
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(unsampledValue),
  );
  const rawPuck = await chart.locator('.symbol-chart-crosshair-puck').evaluate((puck) => ({
    x: Number(puck.getAttribute('cx')),
    y: Number(puck.getAttribute('cy')),
  }));
  expect(rawPuck.x).toBeCloseTo(unsampledX, 1);
  expect(rawPuck.y).toBeCloseTo(unsampledY, 1);

  const expectedTradeIndex = points.reduce((best, point, index) => {
    const target = Date.parse('2026-07-05T12:00:00Z');
    return Math.abs(Date.parse(point.t) - target) < Math.abs(Date.parse(points[best].t) - target)
      ? index
      : best;
  }, 0);
  const expectedTradeX = 4 + (expectedTradeIndex / (points.length - 1)) * 792;
  const expectedTradeY = 8 + (1 - (points[expectedTradeIndex].value - 1_100_000) / 300_000) * 204;
  const markerGeometry = await buyMarker.evaluate((marker) => {
    const leftMatch = (marker as HTMLElement).style.left.match(/,\s*([\d.]+)%/);
    return {
      x: Number(leftMatch?.[1]) / 100 * 800,
      y: Number.parseFloat((marker as HTMLElement).style.top) / 100 * 220,
    };
  });
  expect(markerGeometry.x).toBeCloseTo(expectedTradeX, 3);
  expect(markerGeometry.y).toBeCloseTo(expectedTradeY, 3);

  await svg.focus();
  await svg.press('Escape');
  await svg.press('ArrowRight');
  await expect(chart.locator('.portfolio-chart-value')).toContainText(
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(points[1].value),
  );
  await svg.press('ArrowRight');
  await expect(chart.locator('.portfolio-chart-value')).toContainText(
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(points[2].value),
  );
  await svg.press('Escape');
  const chartBox = await chart.locator('.interactive-chart').boundingBox();
  expect(chartBox).not.toBeNull();
  expect(svgBox!.width).toBeLessThanOrEqual(chartBox!.width + 1);
  const mobileScreenshot = testInfo.outputPath('adaptive-density-mobile.png');
  await chart.screenshot({ path: mobileScreenshot, animations: 'disabled' });
  await testInfo.attach('adaptive-density-mobile', { path: mobileScreenshot, contentType: 'image/png' });

  await page.setViewportSize({ width: 280, height: 844 });
  await expect(chart.locator('.trade-marker-badge')).toHaveCount(2);
  const compactCluster = chart.locator('.trade-marker-mixed.multi');
  await expect(compactCluster).toBeHidden();
  const compactTradeCount = await chart.locator('.trade-marker-badge').evaluateAll((markers) => (
    markers.reduce((sum, marker) => sum + Number((marker as HTMLElement).dataset.tradeCount), 0)
  ));
  expect(compactTradeCount).toBe(transactions.length);

  await page.setViewportSize({ width: 600, height: 900 });
  await chart.scrollIntoViewIfNeeded();
  await expect(chart.locator('.chart-extreme').first()).toBeHidden();
  await expect(chart.locator('.trade-marker-badge')).toHaveCount(3);
  await expect(chart.locator('.trade-marker-badge').first()).toBeHidden();

  await page.setViewportSize({ width: 900, height: 900 });
  await chart.scrollIntoViewIfNeeded();
  await expect(chart.locator('.trade-marker-badge').first()).toBeVisible();
  await expect.poll(async () => (await readGeometry()).pointCount).toBeGreaterThan(mobileGeometry.pointCount + 40);
  const desktopGeometry = await readGeometry();
  expect(desktopGeometry.pointCount).toBeLessThanOrEqual(246);
  expect(desktopGeometry.cubicCount).toBe(desktopGeometry.pointCount - 1);
  await expect(chart.locator('.chart-extreme').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const desktopScreenshot = testInfo.outputPath('adaptive-density-desktop.png');
  await chart.screenshot({ path: desktopScreenshot, animations: 'disabled' });
  await testInfo.attach('adaptive-density-desktop', { path: desktopScreenshot, contentType: 'image/png' });
});

test('partial quotes never present cash-only value as the full portfolio', async ({ page }) => {
  // The initial page load's live quote response rewrites the browser cache;
  // let it land first so clearing the cache below cannot race with it.
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => localStorage.removeItem('finance-tracker:quotes:v1'));
  await page.route('**/quotes?**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        // AMD exists in the ledger but is currently closed. A quote for it
        // must not make the app treat all live holdings as priced.
        quotes: [{
          symbol: 'AMD',
          price: 100,
          currency: 'USD',
          asOf: Date.now(),
          source: 'unknown',
          freshness: 'live',
          session: 'regular',
        }],
      }),
    });
  });
  await page.reload();

  await expect(page.locator('.portfolio-chart-value')).toHaveText('—');
  const totals = page.locator('.account.combined .account-totals');
  await expect(totals).toContainText('Price unavailable for');
  await expect(totals).not.toContainText('-100%');
});

test('a fully priced account keeps its NAV when another account has an unpriced option', async ({ page }) => {
  const accounts = [
    { id: 'priced', name: 'Priced account', cashBalance: 100, currency: 'USD' },
    { id: 'unpriced', name: 'Unpriced account', cashBalance: 200, currency: 'USD' },
  ];
  const transactions = [
    { id: 'aapl', accountId: 'priced', symbol: 'AAPL', date: '2026-07-10', quantity: 1, pricePerUnit: 50, currency: 'USD' },
    {
      id: 'put', accountId: 'unpriced', symbol: 'NBIS260731P00165000', date: '2026-07-10',
      quantity: -1, pricePerUnit: 6, currency: 'USD', instrumentType: 'option',
      contractMultiplier: 100, positionEffect: 'open',
    },
  ];
  await page.unroute('**/quotes?**');
  await page.route('**/accounts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ accounts }),
  }));
  await page.route('**/transactions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ transactions }),
  }));
  await page.route('**/quotes?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      quotes: [{
        symbol: 'AAPL', price: 100, currency: 'USD', asOf: Date.now(),
        source: 'nasdaq', freshness: 'live', session: 'regular',
      }],
    }),
  }));
  await page.evaluate(() => {
    localStorage.removeItem('finance-tracker:state:v2');
    localStorage.removeItem('finance-tracker:quotes:v1');
  });
  await page.reload();

  await expect(page.locator('.portfolio-chart-value')).toHaveText('—');
  const priced = page.locator('.breakdown > .account:not(.combined)').filter({
    has: page.getByText('Priced account', { exact: true }),
  });
  await expect(priced.locator('.account-value')).toHaveText('$200.00');
  await expect(priced.locator('.account-totals')).toContainText('Share of total unavailable');
  await expect(priced.locator('.account-totals')).not.toContainText('Price unavailable');
  const unpriced = page.locator('.breakdown > .account:not(.combined)').filter({
    has: page.getByText('Unpriced account', { exact: true }),
  });
  await expect(unpriced.locator('.account-value')).toHaveText('—');
  await expect(unpriced.locator('.account-totals')).toContainText('Price unavailable for 1 holding');
});

/**
 * Show one synthetic household: its accounts, their trades and a live price for each symbol, nothing cached. With `at`
 * (one of AT) the page's clock is pinned there and each quote is taken five minutes before it, so what the page shows
 * by session is the same whenever the test runs; without it the page keeps the real clock and its session.
 */
async function showSyntheticHousehold(page: Page, household: {
  accounts: Array<{ id: string; name: string; cashBalance: number; currency: string }>;
  transactions: Array<Record<string, unknown>>;
  prices: Record<string, number>;
  /** More of a symbol's quote: its day change and basis, or an overnight price. */
  quoteFields?: Record<string, Record<string, unknown>>;
  /** When the page's clock says it is. */
  at?: string;
}) {
  if (household.at) await page.clock.setFixedTime(new Date(household.at));
  const asOf = () => (household.at ? Date.parse(household.at) - 5 * 60_000 : Date.now());
  await page.unroute('**/quotes?**');
  await page.route('**/accounts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ accounts: household.accounts }),
  }));
  await page.route('**/transactions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ transactions: household.transactions }),
  }));
  await page.route('**/quotes?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      quotes: Object.entries(household.prices).map(([symbol, price]) => ({
        symbol, price, currency: 'USD', asOf: asOf(), source: 'nasdaq', freshness: 'live', session: 'regular',
        ...(household.quoteFields?.[symbol] ?? {}),
      })),
    }),
  }));
  await page.evaluate(() => {
    localStorage.removeItem('finance-tracker:state:v2');
    localStorage.removeItem('finance-tracker:quotes:v1');
  });
  await page.reload();
}

/** The percent a gain/loss line shows in its brackets: "50.00%", or "—" when it is unknown. */
async function shownPercent(line: Locator): Promise<string | undefined> {
  const matches = [...(await line.innerText()).matchAll(/\(([^()]*%|—)\)/g)];
  return matches.at(-1)?.[1];
}

const GAIN_LOSS_LABEL = 'Gain/loss on invested positions (excludes cash)';

/** Each place Portfolio shows a gain/loss percent: the household line, the holdings card, and an account's header and footer. */
function gainLossLines(page: Page, accountName: string) {
  const account = page.locator('.breakdown > .account:not(.combined)').filter({ has: page.getByText(accountName, { exact: true }) });
  return {
    household: page.locator('.breakdown > .portfolio-chart .portfolio-value-gl'),
    card: page.locator('.account.combined .holdings-total-gain'),
    account,
    header: account.locator('.account-gl'),
    footer: account.locator('tfoot td.col-gl'),
  };
}

test('one gain/loss percent per scope, cash left out: one account reads the same in its header and footer, the household line and the holdings card', async ({ page }) => {
  // One synthetic account: $1,000 cash and 10 AAPL bought at $100, now $150. The gain is $500, 50.00% of the $1,000 the
  // positions cost. The retired percent counted the cash as cost too (25.00% of $2,000): it shows nowhere now.
  await showSyntheticHousehold(page, {
    accounts: [{ id: 'known-cash', name: 'Known cash account', cashBalance: 1000, currency: 'USD' }],
    transactions: [
      { id: 'known-cash-buy', accountId: 'known-cash', symbol: 'AAPL', date: '2026-07-10', quantity: 10, pricePerUnit: 100, currency: 'USD' },
    ],
    prices: { AAPL: 150 },
  });

  await expect(page.locator('.breakdown > .portfolio-chart .portfolio-chart-value')).toHaveText('$2,500.00');
  const { household, card, account, header, footer } = gainLossLines(page, 'Known cash account');
  const aaplRow = page.locator('.account.combined tr.holding-row').filter({ hasText: 'AAPL' }).locator('td.col-gl');
  for (const line of [household, card, header, footer, aaplRow]) {
    await expect(line).toContainText('$500.00 (50.00%)');
    await expect(line).not.toContainText('25.00%');
  }
  // One scope, one percent: the account is the household here.
  const percents = await Promise.all([household, card, header, footer].map(shownPercent));
  expect(percents).toEqual(['50.00%', '50.00%', '50.00%', '50.00%']);
  // The label says cash is left out wherever the percent shows.
  await expect(household).toContainText(GAIN_LOSS_LABEL);
  await expect(card.locator('.holdings-total-label')).toHaveText(GAIN_LOSS_LABEL);
  await expect(header.locator('.account-gl-label')).toHaveText(GAIN_LOSS_LABEL);
  await expect(page.locator('.account.combined table.holdings th.col-gl')).toHaveText('Gain/loss (excludes cash)');
  await expect(account.locator('table.holdings th.col-gl')).toHaveText('Gain/loss (excludes cash)');
});

test('one gain/loss percent per scope, cash left out: several accounts read the same household percent above and in the holdings card, and each account its own', async ({ page }) => {
  // Three synthetic accounts: a $500 gain on $1,000 with $1,000 cash, a $200 loss on $1,000 with none, and $500 cash
  // alone. The household gains $300 on the $2,000 its positions cost: 15.00% (the retired percent read 8.57% of $3,500).
  await showSyntheticHousehold(page, {
    accounts: [
      { id: 'scope-brokerage', name: 'Synthetic brokerage', cashBalance: 1000, currency: 'USD' },
      { id: 'scope-ira', name: 'Synthetic IRA', cashBalance: 0, currency: 'USD' },
      { id: 'scope-savings', name: 'Synthetic cash account', cashBalance: 500, currency: 'USD' },
    ],
    transactions: [
      { id: 'scope-aapl', accountId: 'scope-brokerage', symbol: 'AAPL', date: '2026-07-10', quantity: 10, pricePerUnit: 100, currency: 'USD' },
      { id: 'scope-msft', accountId: 'scope-ira', symbol: 'MSFT', date: '2026-07-10', quantity: 4, pricePerUnit: 250, currency: 'USD' },
    ],
    prices: { AAPL: 150, MSFT: 200 },
  });

  await expect(page.locator('.breakdown > .portfolio-chart .portfolio-chart-value')).toHaveText('$3,800.00');
  const brokerage = gainLossLines(page, 'Synthetic brokerage');
  const ira = gainLossLines(page, 'Synthetic IRA');
  const savings = gainLossLines(page, 'Synthetic cash account');

  // The household: the line above and the holdings card are one scope, so one percent.
  await expect(brokerage.household).toContainText('$300.00 (15.00%)');
  await expect(brokerage.card).toContainText('$300.00 (15.00%)');
  expect(await shownPercent(brokerage.card)).toBe(await shownPercent(brokerage.household));
  for (const line of [brokerage.household, brokerage.card]) await expect(line).not.toContainText('8.57%');

  // Each account: its header and its footer are one scope.
  await expect(brokerage.header).toContainText('$500.00 (50.00%)');
  await expect(ira.header).toContainText('-$200.00 (-20.00%)');
  for (const { header, footer } of [brokerage, ira]) {
    await expect(footer).toHaveText(await header.locator('.gain, .loss').innerText());
    expect(await shownPercent(footer)).toBe(await shownPercent(header));
    await expect(header.locator('.account-gl-label')).toHaveText(GAIN_LOSS_LABEL);
  }
  await expect(brokerage.header).not.toContainText('25.00%');

  // Cash alone has no gain or loss: no line, and a dash in the footer, never 0.00%.
  await expect(savings.header).toHaveCount(0);
  await expect(savings.footer).toHaveText('—');
});

test('a gain/loss percent that is unknown reads as a dash with its reason, never 0%: positions that cost nothing', async ({ page }) => {
  // One synthetic holding received at no cost: 5 shares at $0, now $40. The gain is $200, but there is no cost to take
  // a percent of, so every place says the percent is unknown.
  await showSyntheticHousehold(page, {
    accounts: [{ id: 'no-cost', name: 'Synthetic gifted shares', cashBalance: 0, currency: 'USD' }],
    transactions: [
      { id: 'no-cost-gift', accountId: 'no-cost', symbol: 'GIFT', date: '2026-07-10', quantity: 5, pricePerUnit: 0, currency: 'USD' },
    ],
    prices: { GIFT: 40 },
  });

  const { household, card, header, footer, account } = gainLossLines(page, 'Synthetic gifted shares');
  const accountRow = account.locator('tbody tr').filter({ hasText: 'GIFT' }).locator('td.col-gl');
  const combinedRow = page.locator('.account.combined tr.holding-row').filter({ hasText: 'GIFT' }).locator('td.col-gl');
  for (const line of [household, card, header, footer, accountRow, combinedRow]) {
    await expect(line).toContainText('$200.00 (—)');
    await expect(line).not.toContainText('0.00%');
    const reason = line.locator('.gl-percent-unknown');
    await expect(reason).toHaveText('Percent unknown: no cost basis');
    await expect(reason).toBeVisible();
    expect(await reason.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
  }
});

/** A gain/loss shown in neither colour and without an arrow: no gain or loss class on it or inside it, no drawn arrow. */
async function expectNeutral(line: Locator) {
  expect(await line.evaluate((node) => [node, ...node.querySelectorAll('*')]
    .filter((el) => el.classList.contains('gain') || el.classList.contains('loss'))
    .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`))).toEqual([]);
  await expect(line.locator('svg')).toHaveCount(0);
}

/** The text a part of the page draws, as one line: its text without what only a screen reader gets (`.visually-hidden`). */
function shownText(part: Locator): Promise<string> {
  return part.evaluate((node) => {
    const drawn = node.cloneNode(true) as Element;
    for (const hidden of drawn.querySelectorAll('.visually-hidden')) hidden.remove();
    return (drawn.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/** What a screen reader hears of a part of the page, as one line: its accessibility tree's text, aria-hidden text left out. */
async function heardText(part: Locator): Promise<string> {
  return (await part.ariaSnapshot()).split('\n')
    .map((line) => /^\s*- [a-z]+(?: "[^"]*")?: (.*)$/.exec(line)?.[1].replace(/^"(.*)"$/, '$1') ?? '')
    .filter(Boolean)
    .join(' ');
}

test('a true zero reads "$0.00 (0.00%)" in neither colour and without an arrow, everywhere Portfolio shows a gain/loss', async ({ page }) => {
  // Two synthetic accounts hold SYNZ at what it now costs (3 and 0.25 shares at $0.30, still $0.30): every gain/loss
  // is a true zero. Summed in floats it lands a hair under zero, which read "-$0.00 (0.00%)" in the loss colour.
  await showSyntheticHousehold(page, {
    accounts: [
      { id: 'zero-a', name: 'Synthetic zero A', cashBalance: 0, currency: 'USD' },
      { id: 'zero-b', name: 'Synthetic zero B', cashBalance: 0, currency: 'USD' },
    ],
    transactions: [
      { id: 'zero-a-buy', accountId: 'zero-a', symbol: 'SYNZ', date: '2025-01-02', quantity: 3, pricePerUnit: 0.3, currency: 'USD' },
      { id: 'zero-b-buy', accountId: 'zero-b', symbol: 'SYNZ', date: '2025-02-03', quantity: 0.25, pricePerUnit: 0.3, currency: 'USD' },
    ],
    prices: { SYNZ: (3 * 0.3 + 0.25 * 0.3) / (3 + 0.25) },
  });

  const zeroA = gainLossLines(page, 'Synthetic zero A');
  const zeroB = gainLossLines(page, 'Synthetic zero B');
  const combinedRow = page.locator('.account.combined tr.holding-row').filter({ hasText: 'SYNZ' });
  const accountRows = [zeroA, zeroB].map(({ account }) => account.locator('tbody tr').filter({ hasText: 'SYNZ' }).locator('td.col-gl'));
  const lines = [zeroA.household, zeroA.card, zeroA.header, zeroA.footer, zeroB.header, zeroB.footer, ...accountRows, combinedRow.locator('td.col-gl')];
  for (const line of lines) {
    await expect(line).toContainText('$0.00 (0.00%)');
    await expect(line).not.toContainText('-$0.00');
    await expect(line).not.toContainText('-0.00%');
    await expectNeutral(line);
  }

  // The accounts that hold it, under the holding.
  await combinedRow.getByRole('button', { name: 'SYNZ details', exact: true }).click();
  const contributors = page.locator('.account.combined tr.contributor-row td.col-gl');
  await expect(contributors).toHaveCount(2);
  for (const contributor of await contributors.all()) {
    await expect(contributor).toContainText('$0.00 (0.00%)');
    await expectNeutral(contributor);
  }

  // A holding's details on a phone.
  await page.setViewportSize({ width: 375, height: 812 });
  const details = page.locator('.account.combined tr.holding-details-row .holding-details-gl dd');
  await expect(details).toBeVisible();
  await expect(details).toContainText('$0.00 (0.00%)');
  await expectNeutral(details);
});

test('a gain and a loss keep their colour and arrow: "$500.00 (50.00%)" a gain, "-$200.00 (-20.00%)" a loss', async ({ page }) => {
  await showSyntheticHousehold(page, {
    accounts: [
      { id: 'tone-gain', name: 'Synthetic gaining account', cashBalance: 0, currency: 'USD' },
      { id: 'tone-loss', name: 'Synthetic losing account', cashBalance: 0, currency: 'USD' },
    ],
    transactions: [
      { id: 'tone-aapl', accountId: 'tone-gain', symbol: 'AAPL', date: '2026-07-10', quantity: 10, pricePerUnit: 100, currency: 'USD' },
      { id: 'tone-msft', accountId: 'tone-loss', symbol: 'MSFT', date: '2026-07-10', quantity: 4, pricePerUnit: 250, currency: 'USD' },
    ],
    prices: { AAPL: 150, MSFT: 200 },
  });
  for (const [name, symbol, text, tone] of [
    ['Synthetic gaining account', 'AAPL', '$500.00 (50.00%)', 'gain'],
    ['Synthetic losing account', 'MSFT', '-$200.00 (-20.00%)', 'loss'],
  ] as const) {
    const { header, footer, account } = gainLossLines(page, name);
    const accountRow = account.locator('tbody tr').filter({ hasText: symbol }).locator('td.col-gl');
    const combinedRow = page.locator('.account.combined tr.holding-row').filter({ hasText: symbol }).locator('td.col-gl');
    for (const line of [header, footer]) {
      await expect(line.locator(`.${tone}`)).toHaveText(text);
      await expect(line.locator(`.${tone} svg`)).toHaveCount(1);
    }
    for (const row of [accountRow, combinedRow]) {
      await expect(row).toHaveClass(new RegExp(`\\b${tone}\\b`));
      await expect(row).toContainText(text);
      await expect(row.locator('svg')).toHaveCount(1);
    }
  }
});

test('a holding with no price: the accounts under it read "—" in neither colour, never as a gain', async ({ page }) => {
  // With no price a holding's gain/loss is unknown: the summary holds each account's amount at 0, and the dash took
  // the gain colour from it.
  await showSyntheticHousehold(page, {
    accounts: [
      { id: 'unpriced-a', name: 'Synthetic unpriced A', cashBalance: 0, currency: 'USD' },
      { id: 'unpriced-b', name: 'Synthetic unpriced B', cashBalance: 0, currency: 'USD' },
    ],
    transactions: [
      { id: 'unpriced-a-buy', accountId: 'unpriced-a', symbol: 'SYNM', date: '2025-01-02', quantity: 3, pricePerUnit: 10, currency: 'USD' },
      { id: 'unpriced-b-buy', accountId: 'unpriced-b', symbol: 'SYNM', date: '2025-02-03', quantity: 2, pricePerUnit: 12, currency: 'USD' },
    ],
    prices: {},
  });
  const row = page.locator('.account.combined tr.holding-row').filter({ hasText: 'SYNM' });
  await expect(row.locator('td.col-gl')).toHaveText('—');
  await row.getByRole('button', { name: 'SYNM details', exact: true }).click();
  const contributors = page.locator('.account.combined tr.contributor-row td.col-gl');
  await expect(contributors).toHaveCount(2);
  for (const contributor of await contributors.all()) {
    await expect(contributor).toHaveText('—');
    await expectNeutral(contributor);
  }
});

/** A synthetic price history for a symbol's chart and sparkline: one close a day from 2026-07-01. */
function symbolHistory(symbol: string, closes: number[]) {
  const day = (index: number) => new Date(Date.UTC(2026, 6, 1 + index)).toISOString().slice(0, 10);
  const first = closes[0];
  const last = closes[closes.length - 1];
  return {
    symbol, range: '3M', from: day(0), to: day(closes.length - 1), supported: true,
    points: closes.map((close, index) => ({ t: day(index), close })),
    summary: { first, last, change: last - first, changePercent: ((last - first) / first) * 100 },
    sources: ['synthetic'],
  };
}

test('a day change that reads zero is unsigned and in neither colour, in the holdings and the ticker; a missing one reads "—" in the ticker', async ({ page }) => {
  // Four synthetic holdings at $10: unchanged today, down a tenth of a cent, with no day change, and up 50 cents. In a
  // weekday's regular session: in pre-market and after hours the holdings write the session under each change.
  await showSyntheticHousehold(page, {
    at: AT.regular,
    accounts: [{ id: 'day-zero', name: 'Synthetic day changes', cashBalance: 0, currency: 'USD' }],
    transactions: ['SYNF', 'SYNN', 'SYNM', 'SYNG'].map((symbol, index) => ({
      id: `day-${symbol}`, accountId: 'day-zero', symbol, date: '2026-07-10', quantity: 40 - index * 10, pricePerUnit: 10, currency: 'USD',
    })),
    prices: { SYNF: 10, SYNN: 10, SYNM: 10, SYNG: 10 },
    quoteFields: {
      SYNF: { dayChange: 0, dayChangePercent: 0, changeBasis: 'previousClose' },
      SYNN: { dayChange: -0.001, dayChangePercent: -0.0001, changeBasis: 'previousClose' },
      SYNG: { dayChange: 0.5, dayChangePercent: 5.26, changeBasis: 'previousClose' },
    },
  });

  const dayChange = (symbol: string) => page.locator('.account.combined tr.holding-row').filter({ hasText: symbol }).locator('td.col-day');
  for (const symbol of ['SYNF', 'SYNN']) {
    await expect(dayChange(symbol)).toHaveText('$0.00');
    await expectNeutral(dayChange(symbol));
  }
  await expect(dayChange('SYNG')).toHaveText('+$0.50');
  await expect(dayChange('SYNG').locator('.day-change')).toHaveClass(/\bgain\b/);

  await page.getByRole('group', { name: 'Show day change in' }).getByRole('button', { name: 'Percent' }).click();
  for (const symbol of ['SYNF', 'SYNN']) {
    await expect(dayChange(symbol)).toHaveText('0.00%');
    await expectNeutral(dayChange(symbol));
  }
  await expect(dayChange('SYNG')).toHaveText('+5.26%');
  await expect(dayChange('SYNG').locator('.day-change')).toHaveClass(/\bgain\b/);

  // The ticker: its first copy (the second repeats it for the loop, hidden from screen readers).
  const ticker = (symbol: string) => page.locator('.ticker-banner .ticker-row').first()
    .locator('.ticker-item').filter({ hasText: symbol }).locator('.ticker-change');
  for (const symbol of ['SYNF', 'SYNN']) {
    await expect(ticker(symbol)).toHaveText('$0.00 0.00%');
    await expectNeutral(ticker(symbol));
  }
  await expect(ticker('SYNM')).toHaveText('—No day change');
  await expect(ticker('SYNM').locator('.visually-hidden')).toHaveText('No day change');
  await expectNeutral(ticker('SYNM'));
  await expect(ticker('SYNG')).toHaveText('$0.50 5.26%');
  await expect(ticker('SYNG')).toHaveClass(/\bgain\b/);
});

/**
 * Show synthetic holdings at $10, each up 50 cents (5.26%) on the basis its quote gives, with the page's clock at `at`
 * (each quote taken five minutes before unless it says otherwise).
 */
async function showDayChanges(page: Page, at: string, quotes: Record<string, Record<string, unknown>>) {
  const symbols = Object.keys(quotes);
  await showSyntheticHousehold(page, {
    at,
    accounts: [{ id: 'day-changes', name: 'Synthetic day changes', cashBalance: 0, currency: 'USD' }],
    transactions: symbols.map((symbol, index) => ({
      id: `day-change-${symbol}`, accountId: 'day-changes', symbol, date: '2026-07-10', quantity: 60 - index * 5, pricePerUnit: 10, currency: 'USD',
    })),
    prices: Object.fromEntries(symbols.map((symbol) => [symbol, 10])),
    quoteFields: Object.fromEntries(symbols.map((symbol) => [symbol, { dayChange: 0.5, dayChangePercent: 5.26, ...quotes[symbol] }])),
  });
}

/** Four synthetic day changes: over 24 hours (as for crypto), a provider's, against the prior close, and with no basis. */
const DAY_CHANGE_BASES = { SYND: { changeBasis: '24h' }, SYNP: { changeBasis: 'provider' }, SYNC: { changeBasis: 'previousClose' }, SYNX: {} };

/** The note each change carries in each session, as the ticker draws it; written in full under the holding. */
const DAY_CHANGE_NOTES = [
  { session: 'regular', notes: { SYND: '24h', SYNP: 'approximate', SYNC: null, SYNX: null } },
  { session: 'closed', notes: { SYND: '24h', SYNP: 'approximate', SYNC: null, SYNX: null } },
  { session: 'pre-market', notes: { SYND: '24h', SYNP: 'approximate', SYNC: 'pre-market', SYNX: null } },
  { session: 'after-hours', notes: { SYND: '24h', SYNP: 'approximate', SYNC: 'after hours', SYNX: null } },
] as const;
const IN_FULL: Record<string, string> = { '24h': '24-hour change' };

test('the ticker says what each day change is measured over, as its holding does, and screen readers hear each note once, in full', async ({ page }) => {
  const rows = page.locator('.ticker-banner .ticker-row');
  const heard = page.getByRole('region', { name: 'Top holdings ticker' }).getByRole('listitem');
  for (const { session, notes } of DAY_CHANGE_NOTES) {
    await showDayChanges(page, AT[session], DAY_CHANGE_BASES);
    for (const [symbol, drawn] of Object.entries(notes)) {
      const full = drawn ? IN_FULL[drawn] ?? drawn : null;
      const which = `${symbol} in ${session}`;
      // The holdings write it under the change; a change with no basis isn't shown there ("—").
      const holdingNote = page.locator('.account.combined tr.holding-row').filter({ hasText: symbol }).locator('td.col-day .day-change-note');
      if (full) await expect(holdingNote, which).toHaveText(full);
      else await expect(holdingNote, which).toHaveCount(0);
      // The ticker draws it beside the change, short where it has a short form, in neither colour, in both copies of the loop.
      for (const row of [rows.first(), rows.nth(1)]) {
        const item = row.locator('.ticker-item').filter({ hasText: symbol });
        await expect(item.locator('.ticker-change'), which).toHaveText('$0.50 5.26%');
        if (drawn) {
          await expect.poll(() => shownText(item.locator('.ticker-note')), which).toBe(drawn);
          await expectNeutral(item.locator('.ticker-note'));
        } else {
          await expect(item.locator('.ticker-note'), which).toHaveCount(0);
        }
      }
      // Heard once, in full: the loop's second copy is hidden from screen readers whole.
      expect(await heardText(heard.filter({ hasText: symbol })), which).toBe(`${symbol} $10.00 $0.50 5.26%${full ? ` ${full}` : ''}`);
    }
    await expect(rows.nth(1)).toHaveAttribute('aria-hidden', 'true');
    await expect(heard).toHaveCount(Object.keys(notes).length);
  }

  // After hours, three notes in each copy: at the band's size on a phone and a wide screen, 14px, never less.
  const drawnNotes = page.locator('.ticker-banner .ticker-note');
  await expect(drawnNotes).toHaveCount(6);
  for (const width of [375, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const size of await drawnNotes.evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).fontSize)))) {
      expect(size).toBeGreaterThanOrEqual(14);
    }
  }
});

test('the ticker writes no note where its holding writes none, after hours too: a stale change, or one from the open', async ({ page }) => {
  // After hours, three synthetic changes: from a quote a week old (stale), from today's open, and from the prior close.
  // Only the last is the extended-hours move, and only it says so.
  await showDayChanges(page, AT['after-hours'], {
    SYNS: { changeBasis: 'previousClose', asOf: Date.parse(AT['after-hours']) - 7 * 24 * 60 * 60_000 },
    SYNO: { changeBasis: 'open' },
    SYNC: { changeBasis: 'previousClose' },
  });
  const holding = (symbol: string) => page.locator('.account.combined tr.holding-row').filter({ hasText: symbol }).locator('td.col-day');
  const ticker = (symbol: string) => page.locator('.ticker-banner .ticker-item').filter({ hasText: symbol });
  await expect(holding('SYNC').locator('.day-change-note')).toHaveText('after hours');
  await expect(ticker('SYNC').locator('.ticker-note')).toHaveText(['after hours', 'after hours']);
  for (const symbol of ['SYNS', 'SYNO']) {
    await expect(holding(symbol)).toHaveText('—No day change');
    await expect(ticker(symbol)).toHaveCount(2);
    await expect(ticker(symbol).locator('.ticker-note')).toHaveCount(0);
  }
});

test("a flat price: its sparkline, its chart's line and changes are in neither colour, and against its average buy it reads 0.0%", async ({ page }) => {
  // SYNF has held $10 for ten days and was bought at $10; SYNG rose from $8 to $10 and was bought at $8.
  await page.route(/\/symbols\/[^/]+\/history\?/, (route) => {
    const symbol = decodeURIComponent(/\/symbols\/([^/]+)\/history/.exec(route.request().url())?.[1] ?? '');
    const closes = symbol === 'SYNF' ? Array<number>(10).fill(10) : [8, 8.5, 9, 9.5, 10, 10, 10, 10, 10, 10];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(symbolHistory(symbol, closes)) });
  });
  await showSyntheticHousehold(page, {
    // In a weekday's regular session, where a price chart's day change reads "Today".
    at: AT.regular,
    accounts: [{ id: 'flat-price', name: 'Synthetic flat price', cashBalance: 0, currency: 'USD' }],
    transactions: [
      { id: 'flat-SYNF', accountId: 'flat-price', symbol: 'SYNF', date: '2026-07-02', quantity: 30, pricePerUnit: 10, currency: 'USD' },
      { id: 'flat-SYNG', accountId: 'flat-price', symbol: 'SYNG', date: '2026-07-02', quantity: 20, pricePerUnit: 8, currency: 'USD' },
    ],
    prices: { SYNF: 10, SYNG: 10 },
    quoteFields: {
      SYNF: { dayChange: 0, dayChangePercent: 0, changeBasis: 'previousClose' },
      SYNG: { dayChange: 0.5, dayChangePercent: 5.26, changeBasis: 'previousClose' },
    },
  });
  const holding = (symbol: string) => page.locator('.account.combined tr.holding-row').filter({ hasText: symbol });
  const mutedColour = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--text-muted)';
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });

  await expect(holding('SYNF').locator('svg.sparkline')).toHaveClass(/\bneutral\b/);
  expect(await holding('SYNF').locator('svg.sparkline').evaluate((node) => getComputedStyle(node).color)).toBe(mutedColour);
  await expect(holding('SYNG').locator('svg.sparkline')).toHaveClass(/\bpositive\b/);

  const chartOf = (symbol: string) => page.locator('.account.combined tr.chart-row .symbol-chart')
    .filter({ has: page.locator('.symbol-chart-title', { hasText: symbol }) });
  const vsAvgBuy = (symbol: string) => chartOf(symbol).locator('.trade-quality-strip > div').filter({ hasText: 'Vs avg buy' }).locator('strong');

  await holding('SYNF').getByRole('button', { name: 'Show SYNF price chart' }).first().click();
  await expect(chartOf('SYNF').locator('.symbol-chart-change')).toHaveText('$0.00 (0.00%) Today');
  await expect(chartOf('SYNF').locator('.symbol-chart-period')).toHaveText('$0.00 (0.00%) past 3M');
  await expect(vsAvgBuy('SYNF')).toHaveText('0.0%');
  for (const shown of [chartOf('SYNF').locator('.symbol-chart-change'), chartOf('SYNF').locator('.symbol-chart-period'), vsAvgBuy('SYNF')]) {
    await expectNeutral(shown);
  }
  await expect(chartOf('SYNF').locator('.symbol-chart-line')).toHaveAttribute('stroke', 'var(--text-muted)');

  await holding('SYNG').getByRole('button', { name: 'Show SYNG price chart' }).first().click();
  await expect(chartOf('SYNG').locator('.symbol-chart-period')).toHaveText('+$2.00 (+25.00%) past 3M');
  await expect(chartOf('SYNG').locator('.symbol-chart-period .gain')).toHaveCount(1);
  await expect(vsAvgBuy('SYNG')).toHaveText('+25.0%');
  await expect(vsAvgBuy('SYNG')).toHaveClass(/\bgain\b/);
  await expect(chartOf('SYNG').locator('.symbol-chart-line')).toHaveAttribute('stroke', 'var(--gain-strong)');
});

test('a flat portfolio: its value line and change, and in Return its line, return and gain, are in neither colour; so is performance that reads $0', async ({ page }) => {
  // A synthetic household worth $300 throughout: 1D observed snapshots, and a ledger estimate for the Return view whose
  // time-weighted return and gain are float noise either side of zero.
  await page.route('**/portfolio/history?**', (route) => {
    const range = new URL(route.request().url()).searchParams.get('range') ?? '1D';
    const ledger = range !== '1D';
    const times = ledger
      ? Array.from({ length: 6 }, (_, index) => new Date(Date.UTC(2026, 0, 2 + index * 30)).toISOString().slice(0, 10))
      : Array.from({ length: 6 }, (_, index) => new Date(Date.parse('2026-10-23T13:30:00Z') + index * 60 * 60_000).toISOString());
    const from = times[0].slice(0, 10);
    const to = times[times.length - 1].slice(0, 10);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        range, from, to, supported: true, approximate: ledger, approximationReasons: [],
        source: ledger ? 'reconstruction' : 'snapshots',
        valueMethod: ledger ? 'ledger_estimate' : 'observed_snapshot',
        coverage: { requestedFrom: from, requestedTo: to, actualFrom: times[0], actualTo: times[times.length - 1], complete: true, percent: 100 },
        points: times.map((t) => ({ t, value: 300, costBasis: 300 })),
        summary: { startValue: 300, endValue: 300, change: 0, changePercent: 0 },
        ...(ledger ? {
          returns: {
            method: 'time_weighted',
            points: times.map((t) => ({ t, cumulative: 0, gain: 0 })),
            summary: { cumulative: 1e-18, annualized: null, gain: -5.55e-17, netFlows: 0, moneyWeighted: null, moneyWeightedAnnualized: null },
            notes: [],
          },
        } : {}),
      }),
    });
  });
  // Performance whose gains, flows and returns are float noise either side of zero, or a few cents ("$0" compact).
  const figures = { from: '2026-01-02', to: '2026-10-23', partial: false, startValue: 300, endValue: 300, timeWeightedAnnualized: null, moneyWeightedAnnualized: null, benchmarks: {} };
  await page.route('**/portfolio/performance**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      supported: true, asOf: '2026-10-23', inception: '2026-01-02', completeFrom: '2026-01-02', benchmarks: [], notes: [],
      periods: [{ ...figures, key: 'YTD', gain: 5.55e-17, netFlows: 0, timeWeighted: 1e-18, moneyWeighted: -1e-18 }],
      years: [{ ...figures, year: 2026, ytd: true, gain: -0.04, netFlows: 1e-17, timeWeighted: -1e-18, moneyWeighted: 1e-18 }],
    }),
  }));
  await showSyntheticHousehold(page, {
    accounts: [{ id: 'flat-portfolio', name: 'Synthetic flat portfolio', cashBalance: 0, currency: 'USD' }],
    transactions: [{ id: 'flat-portfolio-buy', accountId: 'flat-portfolio', symbol: 'SYNF', date: '2026-01-02', quantity: 30, pricePerUnit: 10, currency: 'USD' }],
    prices: { SYNF: 10 },
  });

  const chart = page.locator('.breakdown > .portfolio-chart');
  const change = chart.locator('.portfolio-chart-change');
  await expect(change).toContainText('$0.00 0.00%');
  await expect(change).not.toContainText('+$0.00');
  await expectNeutral(change);
  await expect(chart.locator('.symbol-chart-line')).toHaveAttribute('stroke', 'var(--text-muted)');
  // A time picked on the line.
  const svg = chart.locator('.symbol-chart-svg');
  await svg.focus();
  await svg.press('ArrowRight');
  await expect(change).toContainText('$0.00 (0.00%)');
  await expectNeutral(change);
  await svg.press('Escape');

  await chart.getByRole('group', { name: 'Chart view' }).getByRole('button', { name: 'Return' }).click();
  await expect(chart.locator('.portfolio-chart-value')).toHaveText('0.00%');
  await expect(change).toContainText('$0.00 gain');
  await expectNeutral(change);
  await expect(chart.locator('.symbol-chart-line')).toHaveAttribute('stroke', 'var(--text-muted)');

  const performance = page.locator('.performance-card');
  await performance.scrollIntoViewIfNeeded();
  const period = performance.locator('.performance-periods tbody tr').first();
  const year = performance.locator('.performance-years tbody tr').first();
  for (const cell of [period.locator('td[data-label="Gain"]'), year.locator('td[data-label="Gain"]'), year.locator('td[data-label="Added"]')]) {
    await expect(cell).toHaveText('$0');
    await expectNeutral(cell);
  }
  for (const row of [period, year]) {
    for (const label of ['Time-weighted', 'Money-weighted']) {
      await expect(row.locator(`td[data-label="${label}"]`)).toHaveText('0.00%');
      await expectNeutral(row.locator(`td[data-label="${label}"]`));
    }
  }
});

test('a cash flow and an overnight premium that read zero are unsigned and in neither colour', async ({ page }) => {
  const event = (id: string, eventType: string, amount: number, description: string) => ({
    id, accountId: 'flows-zero', date: '2026-05-07', eventType, amount, currency: 'USD', broker: 'fidelity',
    accountLast4: '0001', description, sourceFingerprint: id.padEnd(64, '0'), importedAt: '2026-07-10T12:00:00.000Z',
  });
  await page.route('**/cash-events', (route) => (route.request().method() !== 'GET' ? route.continue() : route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      cashEvents: [
        event('flow-in', 'deposit', 100, 'Synthetic deposit'),
        event('flow-out', 'withdrawal', -100, 'Synthetic withdrawal'),
        event('flow-sweep', 'sweep', 0, 'Synthetic zero sweep'),
      ],
    }),
  })));
  // Overnight prices: one at its last close, one a hair below it, one 25% above it.
  const overnight = (price: number, premiumPct: number) => ({
    freshness: 'eod', session: 'closed',
    indicative: { price, source: 'hyperliquid-perp', asOf: Date.now(), baselineClose: 10, premiumPct, confidence: 'ok' },
  });
  await showSyntheticHousehold(page, {
    accounts: [{ id: 'flows-zero', name: 'Synthetic flows', cashBalance: 0, currency: 'USD' }],
    transactions: ['SYNF', 'SYNN', 'SYNG'].map((symbol, index) => ({
      id: `night-${symbol}`, accountId: 'flows-zero', symbol, date: '2026-07-10', quantity: 30 - index * 10, pricePerUnit: 10, currency: 'USD',
    })),
    prices: { SYNF: 10, SYNN: 10, SYNG: 10 },
    quoteFields: { SYNF: overnight(10, 0), SYNN: overnight(10, -1e-18), SYNG: overnight(12.5, 0.25) },
  });

  const panel = page.getByRole('region', { name: 'Overnight prices' });
  await panel.locator('.indicative-header > button').first().click();
  const premium = (symbol: string) => panel.locator('.indicative-table tbody tr').filter({ hasText: symbol }).locator('td[data-label="vs last close"]');
  for (const symbol of ['SYNF', 'SYNN']) {
    await expect(premium(symbol)).toHaveText('0.00%');
    await expectNeutral(premium(symbol));
  }
  await expect(premium('SYNG')).toHaveText('+25.00%');
  await expect(premium('SYNG')).toHaveClass(/\bgain\b/);

  await page.getByRole('tab', { name: 'Transactions' }).click();
  const ledger = page.getByRole('region', { name: 'Cash ledger' });
  const net = ledger.locator('.cash-ledger-net strong');
  await expect(net).toHaveText('$0.00');
  await expectNeutral(net);
  await ledger.getByRole('button', { name: 'Cash ledger' }).click();
  const amount = (description: string) => ledger.locator('.cash-ledger-row').filter({ hasText: description }).locator('.cash-event-amount');
  await expect(amount('Synthetic zero sweep')).toHaveText('$0.00');
  await expectNeutral(amount('Synthetic zero sweep'));
  await expect(amount('Synthetic deposit')).toHaveText('+$100.00');
  await expect(amount('Synthetic deposit')).toHaveClass(/\bgain\b/);
  await expect(amount('Synthetic withdrawal')).toHaveText('-$100.00');
  await expect(amount('Synthetic withdrawal')).toHaveClass(/\bloss\b/);
});

/** Two synthetic cash events, $100 in and $50 out: the ledger's known total is +$50.00 over 2 events. */
const SYNTHETIC_CASH_EVENTS = [
  { id: 'known-in', eventType: 'deposit', amount: 100, description: 'Synthetic deposit' },
  { id: 'known-out', eventType: 'withdrawal', amount: -50, description: 'Synthetic withdrawal' },
].map((event) => ({
  ...event, accountId: 'synthetic-cash', date: '2026-05-07', currency: 'USD', broker: 'fidelity', accountLast4: '0001',
  sourceFingerprint: event.id.padEnd(64, '0'), importedAt: '2026-07-10T12:00:00.000Z',
}));

/** Open Transactions and its cash ledger: the ledger asks for its events when it first shows. */
async function openCashLedger(page: Page) {
  await page.getByRole('tab', { name: 'Transactions' }).click();
  const ledger = page.getByRole('region', { name: 'Cash ledger' });
  await expect(ledger.getByRole('heading', { name: 'Cash ledger' })).toBeVisible();
  return ledger;
}

/**
 * A ledger whose events are not known: its count and net flow read "—", in neither colour, and it never says it is empty.
 * A screen reader hears them as unknown, never as "em dash events".
 */
async function expectCashUnknown(ledger: Locator) {
  const count = ledger.locator('.cash-ledger-stats > span').first();
  const net = ledger.locator('.cash-ledger-net');
  await expect.poll(() => shownText(count)).toBe('— events');
  await expect.poll(() => shownText(net)).toBe('Net cash flow —');
  await expect.poll(() => heardText(count)).toBe('Unknown number of events');
  await expect.poll(() => heardText(net)).toBe('Net cash flow unknown');
  await expectNeutral(ledger.locator('.cash-ledger-stats'));
  await expect(ledger).not.toContainText('0 events');
  await expect(ledger).not.toContainText('$0.00');
  await expect(ledger).not.toContainText('No broker cash events imported.');
}

const CASH_UNKNOWN_NOTE = 'Cash events couldn’t be loaded, so their count and net cash flow are unknown.';

test('while the cash ledger loads its count and net flow read "—", never "0 events · $0.00"', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/cash-events', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await held;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ cashEvents: SYNTHETIC_CASH_EVENTS }) });
  });
  const ledger = await openCashLedger(page);
  await expect(ledger).toContainText('Loading cash events...');
  await expectCashUnknown(ledger);
  await expect(ledger).not.toContainText(CASH_UNKNOWN_NOTE);

  release();
  await expect(ledger.locator('.cash-ledger-stats > span').first()).toHaveText('2 events');
  await expect(ledger.locator('.cash-ledger-net')).toHaveText('Net cash flow +$50.00');
  await expect(ledger.locator('.cash-ledger-net strong')).toHaveClass(/\bgain\b/);
  // Known, they are heard as they read.
  expect(await heardText(ledger.locator('.cash-ledger-stats > span').first())).toBe('2 events');
  expect(await heardText(ledger.locator('.cash-ledger-net'))).toBe('Net cash flow +$50.00');
});

test('when the cash ledger fails to load it says so: its count and net flow read "—", never "no events imported"', async ({ page }) => {
  await page.route('**/cash-events', (route) => (route.request().method() !== 'GET' ? route.continue() : route.fulfill({
    status: 500, contentType: 'text/plain', body: 'synthetic failure',
  })));
  const ledger = await openCashLedger(page);
  await expect(ledger.getByRole('alert')).toBeVisible();
  await expect(ledger).toContainText(CASH_UNKNOWN_NOTE);
  await expect(ledger).not.toContainText('Loading cash events...');
  await expectCashUnknown(ledger);
});

test('a cash ledger that loads empty reads "0 events" and a $0.00 net flow in neither colour, and says none are imported', async ({ page }) => {
  await page.route('**/cash-events', (route) => (route.request().method() !== 'GET' ? route.continue() : route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ cashEvents: [] }),
  })));
  const ledger = await openCashLedger(page);
  await expect(ledger.locator('.cash-ledger-stats > span').first()).toHaveText('0 events');
  await expect(ledger.locator('.cash-ledger-net')).toHaveText('Net cash flow $0.00');
  await expectNeutral(ledger.locator('.cash-ledger-stats'));
  expect(await heardText(ledger.locator('.cash-ledger-stats > span').first())).toBe('0 events');
  expect(await heardText(ledger.locator('.cash-ledger-net'))).toBe('Net cash flow $0.00');
  await expect(ledger).toContainText('No broker cash events imported.');
  await expect(ledger).not.toContainText(CASH_UNKNOWN_NOTE);
});

test('a failed cash event delete keeps the known count, net flow and rows, and shows only its error', async ({ page }) => {
  await page.route('**/cash-events', (route) => (route.request().method() !== 'GET' ? route.continue() : route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ cashEvents: SYNTHETIC_CASH_EVENTS }),
  })));
  await page.route('**/cash-events/*', (route) => route.fulfill({ status: 500, contentType: 'text/plain', body: 'synthetic delete failure' }));
  const ledger = await openCashLedger(page);
  await expect(ledger.locator('.cash-ledger-stats > span').first()).toHaveText('2 events');
  await ledger.getByRole('button', { name: 'Cash ledger' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await ledger.getByRole('button', { name: 'Remove cash event Synthetic withdrawal' }).click();

  await expect(ledger.getByRole('alert')).toContainText('synthetic delete failure');
  await expect(ledger.locator('.cash-ledger-stats > span').first()).toHaveText('2 events');
  await expect(ledger.locator('.cash-ledger-net')).toHaveText('Net cash flow +$50.00');
  await expect(ledger.locator('.cash-ledger-row').filter({ hasText: 'Synthetic withdrawal' })).toHaveCount(1);
  await expect(ledger).not.toContainText(CASH_UNKNOWN_NOTE);
  await expect(ledger).not.toContainText('No broker cash events imported.');
});

test('short put renders as a delayed liability on desktop and mobile', async ({ page }, testInfo) => {
  const optionSymbol = 'NBIS260731P00165000';
  const account = {
    id: 'option-fixture-account',
    name: 'Casey · Fidelity Individual',
    type: 'Individual',
    accountNumber: '7142',
    cashBalance: 10_000,
    currency: 'USD',
  };
  const transactions = [
    {
      id: 'option-sto-4', accountId: account.id, symbol: optionSymbol, date: '2026-07-10',
      quantity: -4, pricePerUnit: 6.10, fees: 2.72, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
      sourceFingerprint: 'a'.repeat(64),
    },
    {
      id: 'option-sto-1', accountId: account.id, symbol: optionSymbol, date: '2026-07-10',
      quantity: -1, pricePerUnit: 8.45, fees: 0.68, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
      sourceFingerprint: 'b'.repeat(64),
    },
  ];

  await page.unroute('**/quotes?**');
  await page.route('**/accounts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ accounts: [account] }),
  }));
  await page.route('**/transactions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ transactions }),
  }));
  await page.route('**/quotes?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      quotes: [{
        symbol: optionSymbol,
        price: 6.05,
        currency: 'USD',
        asOf: Date.now(),
        source: 'cboe',
        freshness: 'delayed',
        session: 'regular',
        pricingMethod: 'mid',
        bid: 6,
        ask: 6.10,
      }],
    }),
  }));
  await page.evaluate(() => {
    localStorage.removeItem('finance-tracker:state:v2');
    localStorage.removeItem('finance-tracker:quotes:v1');
  });
  const optionQuoteRequest = page.waitForRequest((request) => (
    request.url().includes('/quotes?symbols=')
    && request.url().includes(optionSymbol)
  ));
  await page.reload();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('finance-tracker:state:v2');
    if (!raw) return null;
    const state = JSON.parse(raw) as { transactions?: Array<Record<string, unknown>> };
    const transaction = state.transactions?.find((row) => row.symbol === 'NBIS260731P00165000');
    return transaction
      ? {
          instrumentType: transaction.instrumentType,
          contractMultiplier: transaction.contractMultiplier,
          positionEffect: transaction.positionEffect,
        }
      : null;
  })).toEqual({ instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open' });
  await optionQuoteRequest;

  await expect(page.locator('.portfolio-chart-value')).toHaveText('$6,975.00');
  const optionRow = page.locator('.account.combined table.holdings tbody tr').filter({ hasText: "NBIS Jul 31 '26 $165 Put" });
  await expect(optionRow).toHaveCount(1);
  await expect(optionRow).toContainText('Short put');
  await expect(optionRow).toContainText('-5 contracts');
  await expect(optionRow).toContainText('$6.56');
  await expect(optionRow).toContainText('Avg credit');
  await expect(optionRow).toContainText('$6.05');
  await expect(optionRow).toContainText('Delayed mark');
  await expect(optionRow).toContainText('-$3,025.00');
  await expect(optionRow).toContainText('$256.60');
  await expect(optionRow).toContainText('$82,500.00 exercise notional');
  await expect(optionRow.locator('.chart-toggle, .sparkline-wrap')).toHaveCount(0);

  const desktopScreenshot = testInfo.outputPath('short-put-desktop.png');
  await page.locator('.account.combined').screenshot({ path: desktopScreenshot, animations: 'disabled' });
  await testInfo.attach('short-put-desktop', { path: desktopScreenshot, contentType: 'image/png' });

  await page.getByRole('tab', { name: 'Transactions' }).click();
  const optionRows = page.locator('.tx-row').filter({ hasText: "NBIS Jul 31 '26 $165 Put" });
  await expect(optionRows).toHaveCount(2);
  await expect(optionRows.nth(0)).toContainText('Sold to open');
  await expect(optionRows.nth(0)).toContainText('$845.00');
  await expect(optionRows.nth(1)).toContainText('$2,440.00');
  // Quantity and price are in the row's drawer: 1 contract at $8.45 a share, 100 shares a contract.
  await optionRows.nth(0).locator('.tx-row-main').click();
  const optionDrawer = optionRows.nth(0).locator('.tx-row-drawer');
  await expect(optionDrawer).toContainText('1 contract');
  await expect(optionDrawer).toContainText('$8.45');
  await expect(optionDrawer).toContainText('multiplier 100');
  await expect(optionDrawer).not.toContainText('Historical price');
  await optionRows.nth(1).locator('.tx-row-main').click();
  await expect(optionRows.nth(1).locator('.tx-row-drawer')).toContainText('4 contracts');
  await expect(optionRows.nth(1).locator('.tx-row-drawer')).toContainText('$6.10');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Portfolio' }).click();
  await optionRow.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const mobileScreenshot = testInfo.outputPath('short-put-mobile.png');
  await page.locator('.account.combined').screenshot({ path: mobileScreenshot, animations: 'disabled' });
  await testInfo.attach('short-put-mobile', { path: mobileScreenshot, contentType: 'image/png' });

  await page.unroute('**/quotes?**');
  await page.route('**/quotes?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ quotes: [] }),
  }));
  await page.evaluate(() => localStorage.removeItem('finance-tracker:quotes:v1'));
  await page.reload();
  await expect(page.locator('.portfolio-chart-value')).toHaveText('—');
  await expect(page.locator('.account.combined .account-totals')).toContainText('Price unavailable for 1 holding');
  await expect(page.locator('.account.combined')).toContainText("NBIS Jul 31 '26 $165 Put");
});

test('quote status scopes to held symbols and names stale or missing holdings', async ({ page }) => {
  await page.unroute('**/quotes?**');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => localStorage.removeItem('finance-tracker:quotes:v1'));
  let requestedSymbols: string[] = [];
  await page.route('**/quotes?**', async (route) => {
    const url = new URL(route.request().url());
    requestedSymbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean);
    const asOf = Date.now();
    // A week old is before the latest close on any day; two days old is
    // still Friday's close on a Sunday, which the app rightly calls current.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        quotes: requestedSymbols
          .filter((symbol) => symbol !== 'NVDA')
          .map((symbol) => ({
            symbol,
            price: 100,
            currency: 'USD',
            asOf: symbol === 'NBIS' ? asOf - 7 * 24 * 60 * 60 * 1000 : asOf,
            source: 'nasdaq',
            freshness: symbol === 'NBIS' ? 'stale' : 'live',
            session: 'regular',
          })),
      }),
    });
  });
  const quoteRequest = page.waitForRequest((request) => request.url().includes('/quotes?symbols='));
  await page.reload();
  await quoteRequest;
  await expect.poll(() => requestedSymbols.length).toBeGreaterThan(0);

  expect(requestedSymbols).not.toContain('FNILX');
  expect(requestedSymbols).not.toContain('AMD');
  expect(requestedSymbols).toContain('NBIS');
  expect(requestedSymbols).toContain('NVDA');
  const status = page.locator('.quote-status.quote-delayed');
  await expect(status).toHaveText('Partial 2');
  await expect(status).toHaveAttribute('title', /Stale: NBIS/);
  await expect(status).toHaveAttribute('title', /Missing: NVDA/);
});

test('Combined Holdings: clicking a row expands contributors', async ({ page }) => {
  // Wait for at least one holdings row to be there.
  await page.locator('table.holdings tbody tr').first().waitFor({ timeout: 5_000 });
  // Click on the row directly (not inside a td that might hold a button).
  // The first row is the highest-value holding. Click an inner cell that
  // can't be the chart-toggle button: pick the avg-cost cell (3rd td).
  const firstRow = page.locator('.account.combined table.holdings tbody tr').first();
  await firstRow.locator('td').nth(2).click();
  // Real table rows replaced the old nested .contributor-list markup.
  const contributor = page.locator('.account.combined tr.contributor-row').first();
  await expect(contributor).toBeVisible({ timeout: 5_000 });
  await expect(contributor.locator('.contributor-name')).not.toBeEmpty();
});

test('NAV statement preview stays read-only until an account is explicitly selected', async ({ page }, testInfo) => {
  await page.route('**/import/nav-statement/preview', async (route) => {
    expect(route.request().headers()['content-type']).toBe('application/pdf');
    expect(route.request().headers()['x-file-name']).toBe('Brokerage Statement.pdf');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        statement: {
          broker: 'schwab',
          statementPeriodStart: '2025-04-01',
          statementPeriodEnd: '2025-04-30',
          observedAt: '2025-04-30',
          nav: 12_345.67,
          currency: 'USD',
          accountLast4: '2468',
          sourcePage: 1,
        },
        source: {
          documentHash: '0123456789ab'.padEnd(64, '0'),
          fileName: 'Brokerage Statement.pdf',
          page: 1,
        },
        previewToken: 'signed-preview-token',
        accountMatches: [],
        requiresExplicitAccountSelection: true,
      }),
    });
  });
  let importRequests = 0;
  await page.route('**/accounts/*/nav-history/import', async (route) => {
    importRequests += 1;
    await route.abort();
  });

  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByRole('radio', { name: 'A broker statement (PDF)' }).check();
  await page.getByLabel('Statement PDF').setInputFiles({
    name: 'Brokerage Statement.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7 deterministic browser fixture'),
  });
  await page.getByRole('button', { name: 'Preview statement' }).click();

  const panel = page.locator('.nav-statement-import');
  await expect(panel.getByText('$12,345.67', { exact: true })).toBeVisible();
  await expect(panel.getByText('***2468', { exact: true })).toBeVisible();
  await expect(panel.getByText(/Holdr will not guess/)).toBeVisible();
  await expect(panel.getByLabel('Import into account')).toHaveValue('');
  const commit = panel.getByRole('button', { name: 'Import statement value' });
  await expect(commit).toBeDisabled();
  expect(Number(await commit.evaluate((button) => getComputedStyle(button).opacity))).toBeLessThanOrEqual(0.5);
  expect(await commit.evaluate((button) => getComputedStyle(button).cursor)).toBe('not-allowed');
  expect(importRequests).toBe(0);

  const desktopScreenshot = testInfo.outputPath('nav-statement-preview-desktop.png');
  await panel.screenshot({ path: desktopScreenshot, animations: 'disabled' });
  await testInfo.attach('nav-statement-preview-desktop', {
    path: desktopScreenshot,
    contentType: 'image/png',
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const mobileScreenshot = testInfo.outputPath('nav-statement-preview-mobile.png');
  await panel.screenshot({ path: mobileScreenshot, animations: 'disabled' });
  await testInfo.attach('nav-statement-preview-mobile', {
    path: mobileScreenshot,
    contentType: 'image/png',
  });
});

/** An account as Import names it, in full: its name, type and masked number (Astra's review of #248). */
const accountIdentity = (account: { name: string; type?: string; accountNumber?: string }) =>
  [account.name, account.type, account.accountNumber ? `***${account.accountNumber.replace(/[^A-Za-z0-9]/g, '').slice(-4)}` : '']
    .filter(Boolean).join(' · ');

test('NAV statement commit is bound to its signed preview and selected account', async ({ page, request }) => {
  const accountsResponse = await request.get('/accounts');
  expect(accountsResponse.ok()).toBe(true);
  const { accounts } = await accountsResponse.json() as {
    accounts: Array<{ id: string; name: string; type?: string; accountNumber?: string }>;
  };
  const target = accounts[0];
  expect(target).toBeDefined();

  await page.route('**/import/nav-statement/preview', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        statement: {
          broker: 'schwab',
          statementPeriodStart: '2025-04-01',
          statementPeriodEnd: '2025-04-30',
          observedAt: '2025-04-30',
          nav: 12_345.67,
          currency: 'USD',
          accountLast4: '2468',
          sourcePage: 1,
        },
        source: {
          documentHash: '0123456789ab'.padEnd(64, '0'),
          fileName: 'Brokerage Statement.pdf',
          page: 1,
        },
        previewToken: 'signed-preview-token',
        accountMatches: [target],
        requiresExplicitAccountSelection: false,
      }),
    });
  });

  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let markCommitSeen!: () => void;
  const commitSeen = new Promise<void>((resolve) => { markCommitSeen = resolve; });
  await page.route('**/accounts/*/nav-history/import', async (route) => {
    expect(route.request().headers()['x-nav-preview-token']).toBe('signed-preview-token');
    expect(route.request().headers()['x-confirm-account-last4']).toBe('2468');
    expect(route.request().url()).toContain(`/accounts/${encodeURIComponent(target.id)}/nav-history/import`);
    markCommitSeen();
    await commitGate;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        inserted: true,
        observation: {
          id: 'nav-test',
          accountId: target.id,
          observedAt: '2025-04-30',
          nav: 12_345.67,
          importedAt: '2026-07-10T12:00:00.000Z',
        },
      }),
    });
  });

  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByRole('radio', { name: 'A broker statement (PDF)' }).check();
  const fileInput = page.getByLabel('Statement PDF');
  await fileInput.setInputFiles({
    name: 'Brokerage Statement.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7 deterministic browser fixture'),
  });
  await page.getByRole('button', { name: 'Preview statement' }).click();
  const panel = page.locator('.nav-statement-import');
  const accountSelect = panel.getByLabel('Import into account');
  await expect(accountSelect).toHaveValue('');
  await expect(panel.getByText(new RegExp(`Exact account-number match: ${target.name}`))).toBeVisible();
  // The match, the line under the select and the outcome name the account in full, its masked number included.
  await expect(panel.locator('.nav-statement-match')).toHaveText(`Exact account-number match: ${accountIdentity(target)}. Confirm it below.`);
  const commit = panel.getByRole('button', { name: 'Import statement value' });
  await expect(commit).toBeDisabled();
  await expect(panel.locator('.import-destination')).toHaveCount(0);
  await accountSelect.selectOption(target.id);
  await expect(panel.locator('.import-destination')).toHaveText(`The statement's value goes into ${accountIdentity(target)}.`);
  await expect(commit).toBeEnabled();
  await commit.click();
  await commitSeen;
  try {
    await expect(fileInput).toBeDisabled();
    await expect(accountSelect).toBeDisabled();
  } finally {
    releaseCommit();
  }
  await expect(panel.getByRole('status')).toHaveText(`Imported $12,345.67 as of 2025-04-30 into ${accountIdentity(target)}.`);
  await expect(commit).toBeDisabled();
});

test('Ambiguous activity account matches are visible but never committable', async ({ page }, testInfo) => {
  await page.route('**/import/activity-from-broker', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        rows: [{
          date: 'May-07-2026',
          accountLabel: 'Brokerage ***1234',
          description: 'YOU BOUGHT WIDGET CORP (WDGT) (Cash)',
          amount: '-$10.00',
          action: 'BUY',
          symbol: 'WDGT',
          quantity: 1,
          pricePerUnit: 10,
          fingerprint: 'f'.repeat(64),
          status: {
            kind: 'ambiguous-account-match',
            accountLast4: '1234',
            accountIds: ['account-a', 'account-b'],
          },
        }],
        summary: {
          total: 1,
          new: 0,
          duplicates: 0,
          skippedCash: 0,
          skippedSweep: 0,
          rejected: 0,
          noAccountMatch: 0,
          ambiguousAccountMatch: 1,
        },
        source: { broker: 'fidelity', sourceUrl: null },
        accounts: [],
      }),
    });
  });

  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByRole('button', { name: /^Advanced/ }).click();
  await page.getByRole('button', { name: 'Pull activity' }).click();
  const preview = page.locator('.preview').filter({ hasText: 'Activity preview' });
  await expect(preview.getByText('1 ambiguous account', { exact: true })).toBeVisible();
  await expect(preview.getByText('ambiguous account', { exact: true }).last()).toBeVisible();
  await expect(preview.locator('tbody input[type="checkbox"]')).toHaveCount(0);
  const commit = preview.getByRole('button', { name: 'Nothing new to import' });
  await expect(commit).toBeDisabled();
  expect(Number(await commit.evaluate((button) => getComputedStyle(button).opacity))).toBeLessThanOrEqual(0.5);
  expect(await commit.evaluate((button) => getComputedStyle(button).cursor)).toBe('not-allowed');

  const screenshot = testInfo.outputPath('ambiguous-activity-read-only.png');
  await preview.screenshot({ path: screenshot, animations: 'disabled' });
  await testInfo.attach('ambiguous-activity-read-only', {
    path: screenshot,
    contentType: 'image/png',
  });
});

test('Typed cash activity commits to the cash ledger, not transactions', async ({ page }, testInfo) => {
  await page.route('**/import/activity-from-broker', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        rows: [{
          date: 'May-07-2026',
          accountLabel: 'Brokerage ***2468',
          accountLast4: '2468',
          description: 'DIVIDEND RECEIVED SYNTHETIC FUND (TEST) (Cash)',
          amount: '+$12.34',
          action: 'DIVIDEND',
          symbol: null,
          quantity: null,
          pricePerUnit: null,
          cashEventType: 'dividend',
          cashAmount: 12.34,
          cashOccurrence: 0,
          fingerprint: 'c'.repeat(64),
          status: { kind: 'new-cash', accountId: 'fid-test', fingerprint: 'c'.repeat(64) },
        }],
        summary: {
          total: 1,
          new: 0,
          duplicates: 0,
          newCash: 1,
          duplicateCash: 0,
          rejectedCash: 0,
          skippedCash: 0,
          skippedSweep: 0,
          rejected: 0,
          noAccountMatch: 0,
          ambiguousAccountMatch: 0,
        },
        source: { broker: 'fidelity', sourceUrl: null },
        accounts: [{ id: 'fid-test', name: 'Synthetic Fidelity', type: 'Individual', accountNumber: 'XXXX-2468' }],
      }),
    });
  });
  let transactionRequests = 0;
  await page.route('**/accounts/fid-test/transactions', async (route) => {
    transactionRequests += 1;
    await route.abort();
  });
  let cashBody: Record<string, unknown> | null = null;
  await page.route('**/accounts/fid-test/cash-events', async (route) => {
    expect(route.request().headers()['x-confirm-account-last4']).toBe('2468');
    cashBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        inserted: true,
        event: {
          id: 'cash-test',
          accountId: 'fid-test',
          date: '2026-05-07',
          eventType: 'dividend',
          amount: 12.34,
          currency: 'USD',
          broker: 'fidelity',
          accountLast4: '2468',
          description: 'DIVIDEND RECEIVED SYNTHETIC FUND (TEST) (Cash)',
          sourceFingerprint: 'c'.repeat(64),
          importedAt: '2026-07-10T12:00:00.000Z',
        },
      }),
    });
  });

  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByRole('button', { name: /^Advanced/ }).click();
  await page.getByRole('button', { name: 'Pull activity' }).click();
  const preview = page.locator('.preview').filter({ hasText: 'Activity preview' });
  await expect(preview.getByText('1 new cash event', { exact: true })).toBeVisible();
  await expect(preview.getByText('new cash', { exact: true })).toBeVisible();
  await expect(preview.locator('tbody input[type="checkbox"]')).toBeChecked();
  // The routes fold under Advanced; their results never do (D5): with the fold closed, the preview keeps its count and
  // its one action in view.
  const advanced = page.getByRole('button', { name: /^Advanced/ });
  await advanced.click();
  await expect(advanced).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Pull activity' })).toHaveCount(0);
  await expect(preview.getByText('1 new cash event', { exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Import 1 new record' })).toBeVisible();
  await preview.getByRole('button', { name: 'Import 1 new record' }).click();
  await expect(preview.getByRole('status')).toHaveText('1 imported');

  expect(transactionRequests).toBe(0);
  expect(cashBody).toMatchObject({
    date: '2026-05-07',
    eventType: 'dividend',
    amount: 12.34,
    currency: 'USD',
    broker: 'fidelity',
    accountLast4: '2468',
    sourceOccurrence: 0,
    sourceFingerprint: 'c'.repeat(64),
  });

  const screenshot = testInfo.outputPath('typed-cash-event-commit.png');
  await preview.screenshot({ path: screenshot, animations: 'disabled' });
  await testInfo.attach('typed-cash-event-commit', {
    path: screenshot,
    contentType: 'image/png',
  });

  // On a phone the preview reads down: the description first (16px), then each value beside its column's name,
  // inside the card, nothing scrolled sideways; the column heads stay for screen readers.
  await page.setViewportSize({ width: 375, height: 812 });
  const cells = await preview.locator('table.import-activity-table tbody td').evaluateAll((nodes) => nodes
    .filter((node) => node.getBoundingClientRect().width > 0)
    .map((node) => {
      const wrap = node.closest('.import-activity-scroll')!.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      return {
        label: node.getAttribute('data-label'),
        shown: getComputedStyle(node, '::before').content,
        inside: box.left >= wrap.left - 0.5 && box.right <= wrap.right + 0.5,
        size: parseFloat(getComputedStyle(node).fontSize),
      };
    }));
  expect(cells.map((cell) => cell.label)).toEqual(['Include', 'Date', 'Account', 'Description', 'Action', 'Qty', 'Price', 'Amount', 'Status']);
  for (const cell of cells) {
    expect(cell.inside, JSON.stringify(cell)).toBe(true);
    expect(cell.size, JSON.stringify(cell)).toBeGreaterThanOrEqual(cell.label === 'Description' ? 16 : 14);
    if (cell.label !== 'Description') expect(cell.shown, JSON.stringify(cell)).toContain(`"${cell.label}"`);
  }
  expect(await preview.locator('.import-activity-scroll').evaluate((wrap) => wrap.scrollWidth <= wrap.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await expect(preview.getByRole('columnheader')).toHaveCount(9);
});

test('a broker pull that finds several accounts keeps each one\'s count and action in view with Advanced closed', async ({ page, request }) => {
  const { accounts } = await (await request.get('/accounts')).json() as {
    accounts: Array<{ id: string; name: string; type?: string; accountNumber?: string }>;
  };
  const target = accounts[0];
  expect(target).toBeDefined();
  // A synthetic pull: two account sections, one matched to a household account, one not.
  await page.route('**/import/from-broker', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      previews: [
        {
          section: 'Brokerage ***1111',
          suggestion: { accountId: target.id, accountName: target.name, confidence: 0.92 },
          transactions: [{ id: 'pull-a', accountId: '', symbol: 'MSFT', date: '2026-07-10', quantity: 2, pricePerUnit: 300, currency: 'USD' }],
          rejected: [{ row: { Symbol: 'CASH' }, reason: 'cash or non-symbol row' }],
          mapping: { symbol: 'Symbol', quantity: 'Quantity', price: 'Price', cost: null },
        },
        {
          section: 'Roth IRA ***2222',
          suggestion: null,
          transactions: [{ id: 'pull-b', accountId: '', symbol: 'SGOV', date: '2026-07-10', quantity: 5, pricePerUnit: 100, currency: 'USD' }],
          rejected: [],
          mapping: { symbol: 'Symbol', quantity: 'Quantity', price: 'Price', cost: null },
        },
      ],
      source: { broker: 'schwab', sourceUrl: null, tableCount: 2, candidateCount: 2 },
      accounts: [],
    }),
  }));

  await page.getByRole('tab', { name: 'Import' }).click();
  const advanced = page.getByRole('button', { name: /^Advanced/ });
  await advanced.click();
  await page.getByRole('button', { name: /^Pull positions from/ }).click();
  const found = page.getByRole('region', { name: 'Accounts found' });
  await expect(found).toContainText('2 accounts found.');
  // The routes fold under Advanced; their results never do (D5): closed, each account found keeps its count and its
  // one action in view, and the one fold left (why a row was skipped) is not inside another.
  await advanced.click();
  await expect(advanced).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: /^Pull positions from/ })).toHaveCount(0);
  await expect(found).toBeVisible();
  await expect(found.getByText('1 position · 1 skipped', { exact: true })).toBeVisible();
  // The suggestion and the button name the account in full, its type and masked number included (review of #248).
  await expect(found.getByText(`Suggested: ${accountIdentity(target)} (92% match)`, { exact: true })).toBeVisible();
  await expect(found.getByRole('button', { name: `Import 1 into ${accountIdentity(target)}`, exact: true })).toBeEnabled();
  await expect(found.getByRole('button', { name: 'Import 1 into the chosen account' })).toBeDisabled();
  const skipped = found.getByRole('button', { name: 'Why 1 row was skipped' });
  await expect(skipped).toBeVisible();
  expect(await skipped.evaluate((node) => node.closest('.import-advanced') === null)).toBe(true);
});

test('Transactions shows an auditable cash ledger and confirmed deletion', async ({ page, request }, testInfo) => {
  const accountsResponse = await request.get('/accounts');
  const { accounts } = await accountsResponse.json() as { accounts: Array<{ id: string; name: string }> };
  const target = accounts[0];
  expect(target).toBeDefined();
  let deletedId: string | null = null;
  await page.route('**/cash-events', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cashEvents: [
          {
            id: 'cash-dividend', accountId: target.id, date: '2026-05-07',
            eventType: 'dividend', amount: 12.34, currency: 'USD', broker: 'fidelity',
            accountLast4: '2468', description: 'DIVIDEND RECEIVED SYNTHETIC FUND (TEST) (Cash)',
            sourceFingerprint: 'c'.repeat(64), importedAt: '2026-07-10T12:00:00.000Z',
          },
          {
            id: 'cash-withdrawal', accountId: target.id, date: '2026-05-06',
            eventType: 'withdrawal', amount: -50, currency: 'USD', broker: 'fidelity',
            accountLast4: '2468', description: 'Electronic Funds Transfer Paid (Cash)',
            sourceFingerprint: 'd'.repeat(64), importedAt: '2026-07-10T12:00:00.000Z',
          },
        ],
      }),
    });
  });
  await page.route('**/cash-events/*', async (route) => {
    deletedId = route.request().url().split('/').pop() ?? null;
    await route.fulfill({ status: 204, body: '' });
  });

  await page.getByRole('tab', { name: 'Transactions' }).click();
  const ledger = page.getByRole('region', { name: 'Cash ledger' });
  await expect(ledger.getByRole('heading', { name: 'Cash ledger' })).toBeVisible();
  await expect(ledger).toContainText('2 events');
  await expect(ledger).toContainText('Net cash flow -$37.66');
  const toggle = ledger.getByRole('button', { name: 'Cash ledger' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(ledger.getByRole('table', { name: 'Imported cash events' })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(ledger.getByRole('table', { name: 'Imported cash events' })).toBeVisible();
  const ledgerTable = ledger.getByRole('table', { name: 'Imported cash events' });
  expect(await ledgerTable.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  expect(await ledgerTable.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 820, height: 900 });
  expect(await ledgerTable.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(ledger).toContainText(target.name);
  await expect(ledger).toContainText('Dividend');
  await expect(ledger).toContainText('Withdrawal');
  await expect(ledger).toContainText('+$12.34');
  await expect(ledger).toContainText('-$50.00');
  await expect(ledger).toContainText('Fidelity');

  const screenshot = testInfo.outputPath('cash-ledger-desktop.png');
  await ledger.screenshot({ path: screenshot, animations: 'disabled' });
  await testInfo.attach('cash-ledger-desktop', { path: screenshot, contentType: 'image/png' });

  await page.setViewportSize({ width: 700, height: 900 });
  await ledger.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const tabletScreenshot = testInfo.outputPath('cash-ledger-tablet.png');
  await ledger.screenshot({ path: tabletScreenshot, animations: 'disabled' });
  await testInfo.attach('cash-ledger-tablet', { path: tabletScreenshot, contentType: 'image/png' });

  page.once('dialog', (dialog) => dialog.accept());
  await ledger.getByRole('button', { name: 'Remove cash event Electronic Funds Transfer Paid' }).click();
  await expect(ledger).not.toContainText('Electronic Funds Transfer Paid');
  expect(deletedId).toBe('cash-withdrawal');

  await page.setViewportSize({ width: 390, height: 844 });
  await ledger.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const mobileScreenshot = testInfo.outputPath('cash-ledger-mobile.png');
  await ledger.screenshot({ path: mobileScreenshot, animations: 'disabled' });
  await testInfo.attach('cash-ledger-mobile', { path: mobileScreenshot, contentType: 'image/png' });
});

test('Symbol chart: open from row, switch range, crosshair updates headline', async ({ page, request }) => {
  test.setTimeout(60_000);
  // Select a deterministic held symbol. "First row" depends on quotes and
  // can temporarily be an unpriced/closed symbol while quotes are loading.
  const chartBtn = page.getByRole('button', { name: 'Show NBIS price chart' }).first();
  await expect(chartBtn).toBeVisible({ timeout: 10_000 });
  await chartBtn.click();
  const symbolChart = page.locator('.symbol-chart').first();
  await expect(symbolChart).toBeVisible();
  // The chart opens on 3M with the history the NBIS row's 3M sparkline cached
  // while the page loaded (getCachedSymbolHistory). That request may have
  // finished before the click, and the chart makes none of its own, so wait
  // for what it shows instead: 3M selected, the change over the range (shown
  // only for supported history), and the line.
  await expect(symbolChart.locator('.symbol-chart-ranges button.active')).toHaveText('3M');
  await expect(symbolChart.locator('.symbol-chart-period')).toContainText('past 3M', { timeout: 25_000 });
  await expect(symbolChart.locator('.symbol-chart-line')).toBeVisible();
  // The history behind it: supported, with more than one point.
  const initialResponse = await request.get('/symbols/NBIS/history?range=3M');
  expect(initialResponse.status()).toBe(200);
  const initialBody = await initialResponse.json() as { supported: boolean; points: unknown[] };
  expect(initialBody.supported).toBe(true);
  expect(initialBody.points.length).toBeGreaterThan(1);

  // Hover at midpoint of the chart and assert the headline reflects the
  // hovered point's date — the live-quote price stops being shown.
  const svg = symbolChart.locator('.symbol-chart-svg').first();
  const box = await svg.boundingBox();
  if (!box) test.fail();
  await svg.hover({ position: { x: box!.width * 0.5, y: box!.height / 2 } });
  await expect(symbolChart.locator('.symbol-chart-change').first()).toContainText(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/);
  await expect(symbolChart.locator('.symbol-chart-crosshair')).toBeVisible();
  await svg.focus();
  await svg.press('ArrowRight');
  await expect(symbolChart.locator('.symbol-chart-crosshair')).toBeVisible();
  await svg.press('ArrowLeft');
  await expect(symbolChart.locator('.symbol-chart-crosshair')).toBeVisible();
  await svg.press('Escape');
  await expect(symbolChart.locator('.symbol-chart-crosshair')).toHaveCount(0);
  await svg.hover({ position: { x: box!.width * 0.4, y: box!.height / 2 } });
  await expect(symbolChart.locator('.symbol-chart-crosshair')).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(symbolChart.locator('.symbol-chart-crosshair')).toHaveCount(0);

  // Range switch — scope to *this* chart's range buttons (the portfolio
  // chart on the same screen has its own range row with the same labels).
  const oneMonthHistory = page.waitForResponse(
    (response) => response.url().includes('/symbols/NBIS/history?range=1M') && response.status() === 200,
    { timeout: 25_000 },
  );
  await symbolChart.locator('.symbol-chart-ranges button:has-text("1M")').click();
  await oneMonthHistory;
  await expect(symbolChart.locator('.symbol-chart-svg').first()).toBeVisible({ timeout: 10_000 });

  const oneDayHistory = page.waitForResponse(
    (response) => response.url().includes('/symbols/NBIS/history?range=1D') && response.status() === 200,
    { timeout: 25_000 },
  );
  await symbolChart.locator('.symbol-chart-ranges button:has-text("1D")').click();
  const oneDayResponse = await oneDayHistory;
  const oneDayBody = await oneDayResponse.json() as { supported: boolean; points: unknown[] };
  const expectedSurface = oneDayBody.supported && oneDayBody.points.length > 1
    ? symbolChart.locator('.symbol-chart-svg')
    : symbolChart.locator('.symbol-chart-empty');
  await expect(expectedSurface).toBeVisible({ timeout: 10_000 });
});

test('Portfolio chart: long ranges replay the full ledger and explain the estimate', async ({ page, request }) => {
  // The live default is 1D. 1M..ALL replay every recorded transaction into
  // one continuous daily estimate instead of splicing snapshots and backtests.
  const portfolioChart = page.locator('.breakdown > .portfolio-chart');
  await expect(portfolioChart).toBeVisible();
  // The header rows under test only render once the household is priced.
  await expect(portfolioChart.locator('.portfolio-chart-value')).not.toHaveText('—', { timeout: 15_000 });

  const warmHistory = await request.get('/portfolio/history?range=3M', { timeout: 60_000 });
  expect(warmHistory.ok()).toBe(true);
  const loadedHistory = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/portfolio/history' && url.searchParams.get('range') === '3M' && response.status() === 200;
  }, { timeout: 30_000 });
  await portfolioChart.locator('.symbol-chart-ranges button:has-text("3M")').click();
  await loadedHistory;
  await page.mouse.move(2, 2);
  const historyBody = await warmHistory.json() as {
    approximate: boolean;
    source: string;
    valueMethod: string;
    approximationReasons: string[];
    points: Array<{ t: string; value: number }>;
  };
  expect(historyBody.source).toBe('reconstruction');
  expect(historyBody.valueMethod).toBe('ledger_estimate');
  expect(historyBody.approximate).toBe(true);
  expect(historyBody.points.length).toBeGreaterThan(40);
  // Continuous: one point per business day, never a multi-week hole.
  for (let index = 1; index < historyBody.points.length; index += 1) {
    const gapDays = (Date.parse(historyBody.points[index].t) - Date.parse(historyBody.points[index - 1].t)) / 86_400_000;
    expect(gapDays).toBeLessThanOrEqual(4);
  }
  expect(historyBody.approximationReasons[0]).toBe("estimated by replaying every recorded transaction at each day's closing price");

  await expect(portfolioChart.locator('.portfolio-chart-change')).toContainText('Value change');
  await expect(portfolioChart.locator('.portfolio-chart-coverage')).toHaveCount(0);
  const approx = portfolioChart.locator('.badge.approx');
  await expect(approx).toBeVisible({ timeout: 10_000 });
  await expect(approx).toHaveAttribute('aria-label', 'Approximation details');
  await approx.click();
  const popover = portfolioChart.locator('.approx-popover');
  await expect(popover).toBeVisible();
  await expect(popover.locator('.approx-popover-title')).toHaveText('Approximations applied');
  await expect(popover).toContainText('estimated by replaying every recorded transaction');
  // Close it.
  await approx.click();
  await expect(popover).toHaveCount(0);

  // 1D is empty when the snapshot job hasn't accumulated yet.
  await portfolioChart.locator('.symbol-chart-ranges button:has-text("1D")').click();
  await expect(portfolioChart.getByRole('button', { name: '1D', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(portfolioChart.locator('.symbol-chart-loading')).toHaveCount(0, { timeout: 15_000 });
  // Either snapshots have started (chart visible) or the empty state shows.
  // Both are acceptable; assert one of them.
  await expect(portfolioChart.locator('.symbol-chart-empty, .symbol-chart-svg').first()).toBeVisible();
});

// Mirrors the shared formatPercent: whole percents at or above 100%.
function formatPercentLike(percent: number): string {
  return `${percent > 0 ? '+' : ''}${percent.toFixed(Math.abs(percent) >= 100 ? 0 : 2)}%`;
}

test('Portfolio chart: Return view plots the time-weighted return from the ledger', async ({ page }) => {
  test.setTimeout(90_000);
  const portfolioChart = page.locator('.breakdown > .portfolio-chart');
  await expect(portfolioChart.locator('.portfolio-chart-value')).not.toHaveText('—', { timeout: 15_000 });
  const ranges = portfolioChart.locator('.symbol-chart-ranges button');
  await expect(ranges).toHaveCount(8);

  const allHistory = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/portfolio/history' && url.searchParams.get('range') === 'ALL' && response.status() === 200;
  }, { timeout: 60_000 });
  const modes = portfolioChart.locator('.chart-mode-toggle');
  await modes.getByRole('button', { name: 'Return', exact: true }).click();
  await expect(modes.getByRole('button', { name: 'Return', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const body = await (await allHistory).json() as {
    points: Array<{ t: string }>;
    returns: {
      points: Array<{ t: string; cumulative: number }>;
      summary: {
        cumulative: number;
        annualized: number | null;
        moneyWeighted: number | null;
        moneyWeightedAnnualized: number | null;
      };
    };
  };
  expect(body.returns.points.map((point) => point.t)).toEqual(body.points.map((point) => point.t));
  expect(body.returns.points[0].cumulative).toBe(0);

  // Intraday ranges have no daily ledger, so the Return view opens on ALL.
  await expect(ranges).toHaveCount(6);
  await expect(portfolioChart.getByRole('button', { name: '1D', exact: true })).toHaveCount(0);
  await expect(portfolioChart.getByRole('button', { name: 'ALL', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(portfolioChart.locator('.portfolio-chart-title')).toHaveText('Portfolio return');
  await page.mouse.move(2, 2);
  // At rest the headline is the money-weighted rate; the line is time-weighted.
  const { summary } = body.returns;
  const headline = summary.moneyWeighted == null
    ? summary.cumulative
    : summary.moneyWeightedAnnualized ?? summary.moneyWeighted;
  await expect(portfolioChart.locator('.portfolio-chart-value'))
    .toHaveText(formatPercentLike(headline * 100), { timeout: 10_000 });
  const change = portfolioChart.locator('.portfolio-chart-change');
  await expect(change).toContainText('gain');
  await expect(change).toContainText('· ALL');
  if (summary.moneyWeighted != null) {
    await expect(change).toContainText('money-weighted');
    await expect(portfolioChart.locator('.portfolio-chart-value-unit'))
      .toHaveCount(summary.moneyWeightedAnnualized != null ? 1 : 0);
    const line = portfolioChart.locator('.portfolio-chart-line-return');
    await expect(line).toContainText(`time-weighted ${formatPercentLike(summary.cumulative * 100)}`);
    if (summary.annualized != null) await expect(line).toContainText('/yr');
  } else if (summary.annualized != null) {
    await expect(change).toContainText('/yr');
  }
  const percents = body.returns.points.map((point) => point.cumulative * 100);
  await expect(portfolioChart.locator('.chart-extreme-high .chart-extreme-value')).toHaveText(formatPercentLike(Math.max(...percents)));
  await expect(portfolioChart.locator('.chart-extreme-low .chart-extreme-value')).toHaveText(formatPercentLike(Math.min(...percents)));

  // The keyboard crosshair reads the return up to the selected day.
  const svg = portfolioChart.locator('.symbol-chart-svg').first();
  await svg.focus();
  await svg.press('ArrowRight');
  await expect(portfolioChart.locator('.portfolio-chart-value')).toHaveText(formatPercentLike(percents[1]));
  await expect(change).not.toContainText('· ALL');
  await expect(change).toContainText('time-weighted');
  await svg.press('Escape');
  await expect(change).toContainText('· ALL');

  const details = portfolioChart.getByRole('button', { name: 'Return calculation details' });
  await details.click();
  const popover = portfolioChart.locator('.approx-popover');
  await expect(popover.locator('.approx-popover-title')).toHaveText('How return is calculated');
  await expect(popover).toContainText('time-weighted');
  await details.click();
  await expect(popover).toHaveCount(0);

  await modes.getByRole('button', { name: 'Value', exact: true }).click();
  await expect(ranges).toHaveCount(8);
  await expect(portfolioChart.getByRole('button', { name: 'ALL', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(portfolioChart.locator('.portfolio-chart-title')).toHaveText('Portfolio value');
  await expect(portfolioChart.locator('.portfolio-chart-change')).toContainText('Value change');
});

test('Performance: after the holdings, its results show without a click: returns by period and year next to benchmarks, with a goal', async ({ page, request }) => {
  test.setTimeout(90_000);
  const portfolioChart = page.locator('.breakdown > .portfolio-chart');
  await expect(portfolioChart.locator('.portfolio-chart-value')).not.toHaveText('—', { timeout: 15_000 });
  // The page reads: the portfolio value, the holdings, the AI allocation, then Performance; the accounts after it.
  const section = page.locator('.breakdown > .performance-card');
  await expect(section.getByRole('heading', { level: 2, name: 'Performance' })).toBeAttached();
  const order = await page.locator('.breakdown > *').evaluateAll((nodes) => nodes.map((node) => (
    node.matches('.portfolio-chart') ? 'value'
      : node.matches('.account.combined') ? 'holdings'
      : node.matches('.ai-thesis-panel') ? 'ai'
      : node.matches('.performance-card') ? 'performance'
      : node.matches('.account') ? 'account' : 'other'
  )));
  expect(order.slice(0, 4)).toEqual(['value', 'holdings', 'ai', 'performance']);
  expect(order.slice(4).every((part) => part === 'account')).toBe(true);

  const response = await request.get('/portfolio/performance', { timeout: 60_000 });
  expect(response.ok()).toBe(true);
  const body = await response.json() as {
    supported: boolean;
    benchmarks: string[];
    periods: Array<{ key: string; partial: boolean; timeWeighted: number; timeWeightedAnnualized: number | null }>;
    years: Array<{ year: number; ytd: boolean; partial: boolean; timeWeighted: number }>;
  };
  expect(body.supported).toBe(true);
  await section.scrollIntoViewIfNeeded();
  const panel = section.locator('.performance-panel');

  const periodRows = panel.locator('.performance-periods tbody tr');
  await expect(periodRows).toHaveCount(body.periods.length, { timeout: 30_000 });
  await expect(panel.locator('.performance-periods thead th'))
    .toHaveText(['Period', 'Time-weighted', ...body.benchmarks, 'Money-weighted', 'Gain']);
  const inception = body.periods.at(-1)!;
  expect(inception.key).toBe('INCEPTION');
  await expect(periodRows.last().locator('th')).toContainText('All history');
  await expect(periodRows.last().locator('td').first())
    .toContainText(formatPercentLike((inception.timeWeightedAnnualized ?? inception.timeWeighted) * 100));
  await expect(panel.locator('.performance-periods tr.partial'))
    .toHaveCount(body.periods.filter((period) => period.partial).length);

  // Newest year first.
  const yearRows = panel.locator('.performance-years tbody tr');
  await expect(yearRows).toHaveCount(body.years.length);
  const newest = body.years.at(-1)!;
  await expect(yearRows.first().locator('th')).toContainText(newest.ytd ? `${newest.year} YTD` : String(newest.year));
  await expect(yearRows.first().locator('td').first()).toHaveText(formatPercentLike(newest.timeWeighted * 100));
  await expect(panel.locator('.performance-years tr.partial'))
    .toHaveCount(body.years.filter((year) => year.partial).length);
  // What "Partial" means is written out, not left to a hover.
  if (body.years.some((year) => year.partial)) {
    await expect(panel.locator('.performance-footnote')).toContainText(['Partial: covers only part of the year']);
  }

  // Only the method folds, under "How returns are calculated".
  const method = panel.getByRole('button', { name: 'How returns are calculated' });
  await expect(method).toHaveAttribute('aria-expanded', 'false');
  await method.click();
  await expect(method).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('.performance-notes li').first()).toBeVisible();

  // The Return view keeps its chart and headline; the tables are not repeated in it.
  await portfolioChart.locator('.chart-mode-toggle').getByRole('button', { name: 'Return', exact: true }).click();
  await expect(portfolioChart.locator('.portfolio-chart-title')).toHaveText('Portfolio return');
  await expect(portfolioChart.locator('.performance-panel')).toHaveCount(0);
  await expect(page.locator('.breakdown .performance-panel')).toHaveCount(1);

  // The household goal starts unset: an offer to set one, with no target and no progress. Once set, it is remembered.
  const goal = panel.locator('.performance-goal');
  await expect(goal.locator('.performance-heading p')).toHaveText('Not set');
  await expect(goal.locator('.performance-goal-stat')).toHaveCount(0);
  await expect(goal).not.toContainText('% of goal');
  await goal.getByRole('button', { name: 'Set a goal', exact: true }).click();
  await expect(goal.getByLabel('Target ($)', { exact: true })).toBeFocused();
  await expect(goal.locator('.performance-goal-stat')).toHaveCount(3);
  await goal.getByLabel('Target ($)', { exact: true }).fill('20000000');
  await goal.getByLabel('By', { exact: true }).fill('2036-01-02');
  await expect(goal.locator('.performance-heading p')).toContainText('$20M by Jan 2, 2036');
  await expect(goal.locator('.performance-goal-stat').first().locator('strong')).toContainText('/yr');
  await page.reload();
  const reloaded = page.locator('.breakdown > .performance-card');
  await reloaded.scrollIntoViewIfNeeded();
  await expect(reloaded.locator('.performance-goal').getByLabel('Target ($)', { exact: true })).toHaveValue('20000000', { timeout: 30_000 });
  await expect(reloaded.locator('.performance-goal').getByLabel('By', { exact: true })).toHaveValue('2036-01-02');
  // Removing it returns to the offer, and nothing is left stored.
  await reloaded.locator('.performance-goal').getByRole('button', { name: 'Remove goal', exact: true }).click();
  await expect(reloaded.locator('.performance-goal').getByRole('button', { name: 'Set a goal', exact: true })).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('finance-tracker:goal:v1'))).toBeNull();

  // On a phone the comparison reads down (Astra's review of #246): each period and year is a block, one line per
  // measure, every value beside its column's name; nothing reaches past the card and nothing scrolls sideways. The
  // column heads stay, for screen readers.
  await page.setViewportSize({ width: 375, height: 812 });
  for (const table of [reloaded.locator('.performance-periods'), reloaded.locator('.performance-years')]) {
    await expect(table).toBeVisible();
    const layout = await table.locator('xpath=..').evaluate((wrap) => {
      const box = wrap.getBoundingClientRect();
      return {
        scrolls: wrap.scrollWidth > wrap.clientWidth,
        heads: [...wrap.querySelectorAll('thead th')].slice(1).map((th) => (th.textContent ?? '').trim()),
        rows: [...wrap.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => {
          const r = cell.getBoundingClientRect();
          return {
            label: cell.getAttribute('data-label'),
            shown: getComputedStyle(cell, '::before').content,
            inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5,
            size: parseFloat(getComputedStyle(cell).fontSize),
          };
        })),
      };
    });
    expect(layout.scrolls).toBe(false);
    expect(layout.rows.length).toBeGreaterThan(0);
    for (const cells of layout.rows) {
      expect(cells.map((cell) => cell.label)).toEqual(layout.heads);
      for (const cell of cells) {
        expect(cell.shown, JSON.stringify(cell)).toContain(`"${cell.label}"`);
        expect(cell.inside, JSON.stringify(cell)).toBe(true);
        expect(cell.size, JSON.stringify(cell)).toBeGreaterThanOrEqual(14);
      }
    }
    await expect(table.getByRole('columnheader')).toHaveCount(layout.heads.length + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test('Portfolio chart: partial history stays in its requested time position', async ({ page }, testInfo) => {
  const fixtures = {
    '1M': { requestedFrom: '2026-06-10', actualFrom: '2026-06-10', middle: '2026-06-25', percent: 100 },
    '3M': { requestedFrom: '2026-04-10', actualFrom: '2026-05-07', middle: '2026-06-08', percent: 70.3 },
    YTD: { requestedFrom: '2026-01-01', actualFrom: '2026-05-07', middle: '2026-06-08', percent: 34.2 },
    '1Y': { requestedFrom: '2025-07-10', actualFrom: '2026-05-07', middle: '2026-06-08', percent: 17.8 },
  } as const;
  type RequestedRange = keyof typeof fixtures;

  await page.route('**/portfolio/history?**', async (route) => {
    const url = new URL(route.request().url());
    const range = url.searchParams.get('range') as RequestedRange | null;
    if (!range || !(range in fixtures) || url.searchParams.has('accounts')) {
      await route.continue();
      return;
    }
    const fixture = fixtures[range];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        range,
        from: fixture.requestedFrom,
        to: '2026-07-10',
        supported: true,
        approximate: false,
        approximationReasons: [],
        source: 'snapshots',
        valueMethod: 'observed_snapshot',
        coverage: {
          requestedFrom: fixture.requestedFrom,
          requestedTo: '2026-07-10',
          actualFrom: fixture.actualFrom,
          actualTo: '2026-07-10',
          complete: fixture.percent === 100,
          percent: fixture.percent,
        },
        points: [
          { t: fixture.actualFrom, value: 1_000_000, costBasis: 900_000 },
          { t: fixture.middle, value: 1_200_000, costBasis: 900_000 },
          { t: '2026-07-10', value: 1_100_000, costBasis: 900_000 },
        ],
        ...(fixture.percent < 100 ? {
          referenceSeries: {
            valueMethod: 'current_holdings_backtest',
            label: 'Current holdings backtest',
            approximationReasons: [
              "values use today's holdings at historical closes; intermediate buys and sells are not reflected",
            ],
            points: [
              { t: fixture.requestedFrom, value: 960_000, costBasis: 900_000 },
              { t: fixture.actualFrom, value: 1_010_000, costBasis: 900_000 },
              { t: '2026-07-10', value: 1_090_000, costBasis: 900_000 },
            ],
          },
        } : {}),
        summary: {
          startValue: 1_000_000,
          endValue: 1_100_000,
          change: 100_000,
          changePercent: 10,
        },
      }),
    });
  });

  const chart = page.locator('.breakdown > .portfolio-chart');
  await page.evaluate(() => document.fonts.ready);
  const firstObservedXs: number[] = [];
  for (const range of Object.keys(fixtures) as RequestedRange[]) {
    const response = page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return url.pathname.endsWith('/portfolio/history')
        && url.searchParams.get('range') === range
        && !url.searchParams.has('accounts');
    });
    await chart.getByRole('button', { name: range, exact: true }).click();
    await response;
    await expect(chart.locator('.symbol-chart-svg')).toHaveAttribute('aria-label', /3 points/);
    await expect(chart.locator('.chart-extreme')).toHaveCount(fixtures[range].percent < 100 ? 0 : 2);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));

    const geometry = await chart.locator('.interactive-chart').evaluate((root) => {
      const svg = root.querySelector<SVGSVGElement>('.symbol-chart-svg')!;
      const line = root.querySelector<SVGPathElement>('.symbol-chart-line')!;
      const area = root.querySelector<SVGPathElement>('.symbol-chart-area')!;
      const baseline = root.querySelector<SVGLineElement>('.symbol-chart-baseline')!;
      const unobserved = root.querySelector<HTMLElement>('.chart-unobserved-region');
      const reference = root.querySelector<SVGPathElement>('.symbol-chart-reference-line');
      const referenceClip = root.querySelector<SVGRectElement>('.symbol-chart-reference-clip rect');
      const svgRect = svg.getBoundingClientRect();
      const pathStart = (path: SVGPathElement) => Number(path.getAttribute('d')?.match(/^M([0-9.]+)/)?.[1]);
      const pathStartY = (path: SVGPathElement) => Number(path.getAttribute('d')?.match(/^M[0-9.]+,([0-9.]+)/)?.[1]);
      const yAtX = (path: SVGPathElement, x: number) => {
        let low = 0;
        let high = path.getTotalLength();
        for (let index = 0; index < 28; index += 1) {
          const middle = (low + high) / 2;
          if (path.getPointAtLength(middle).x < x) low = middle;
          else high = middle;
        }
        return path.getPointAtLength((low + high) / 2).y;
      };
      return {
        lineStart: pathStart(line),
        lineStartY: pathStartY(line),
        areaStart: pathStart(area),
        baselineStart: Number(baseline.getAttribute('x1')),
        referenceStart: reference ? pathStart(reference) : null,
        referenceClipWidth: referenceClip ? Number(referenceClip.getAttribute('width')) : null,
        referenceBoundaryY: reference && referenceClip
          ? yAtX(reference, Number(referenceClip.getAttribute('width')))
          : null,
        unobservedRatio: unobserved ? unobserved.getBoundingClientRect().width / svgRect.width : 0,
        markerAnchorRatios: [...root.querySelectorAll<HTMLElement>('.trade-marker-badge')].map((marker) => {
          const leftMatch = marker.style.left.match(/,\s*([\d.]+)%/);
          return Number(leftMatch?.[1]) / 100;
        }),
        markerLineDeltas: [...root.querySelectorAll<HTMLElement>('.trade-marker-badge')].map((marker) => {
          const leftMatch = marker.style.left.match(/,\s*([\d.]+)%/);
          const markerX = Number(leftMatch?.[1]) / 100 * 800;
          const markerY = Number.parseFloat(marker.style.top) / 100 * 220;
          return Math.abs(markerY - yAtX(line, markerX));
        }),
      };
    });
    const expectedUnobservedRatio = (100 - fixtures[range].percent) / 100;
    const lineStartRatio = geometry.lineStart / 800;
    if (fixtures[range].percent < 100) {
      expect(geometry.unobservedRatio).toBeCloseTo(lineStartRatio, 2);
      expect(geometry.referenceStart).toBeGreaterThanOrEqual(4);
      expect(geometry.referenceStart).toBeLessThanOrEqual(10);
      expect(geometry.referenceClipWidth).toBeCloseTo(geometry.lineStart, 1);
      expect(geometry.referenceBoundaryY).toBeCloseTo(geometry.lineStartY, 1);
      await expect(chart.getByText('Dashed line: current holdings backtest', { exact: true })).toBeVisible();
      await expect(chart.getByText('Backtest reference', { exact: true })).toBeVisible();
    } else {
      expect(geometry.unobservedRatio).toBe(0);
      expect(geometry.referenceStart).toBeNull();
      expect(geometry.referenceClipWidth).toBeNull();
      await expect(chart.getByText('Dashed line: current holdings backtest', { exact: true })).toHaveCount(0);
    }
    expect(lineStartRatio).toBeGreaterThanOrEqual(expectedUnobservedRatio - 0.02);
    expect(geometry.areaStart).toBeCloseTo(geometry.lineStart, 2);
    expect(geometry.baselineStart).toBeCloseTo(geometry.lineStart, 2);
    expect(geometry.markerAnchorRatios.every((ratio) => ratio >= expectedUnobservedRatio - 0.02)).toBe(true);
    expect(geometry.markerLineDeltas.every((delta) => delta <= 0.75)).toBe(true);
    if (range === '3M') {
      const multiMarkers = chart.locator('.trade-marker-badge.multi');
      expect(await multiMarkers.count()).toBeGreaterThan(0);
      for (const marker of await multiMarkers.all()) {
        await expect(marker.locator('.trade-marker-count')).toHaveText(
          await marker.getAttribute('data-trade-count') ?? '',
        );
      }
    }
    firstObservedXs.push(geometry.lineStart);

    if (range === '1Y') {
      const svg = chart.locator('.symbol-chart-svg');
      const box = await svg.boundingBox();
      expect(box).not.toBeNull();
      const headlineBefore = await chart.locator('.portfolio-chart-value').textContent();
      await page.mouse.move(box!.x + box!.width * 0.4, box!.y + box!.height / 2);
      await expect(chart.locator('.symbol-chart-crosshair')).toHaveCount(0);
      await expect(chart.locator('.chart-reference-readout')).toContainText('Backtest reference');
      await expect(chart.locator('.portfolio-chart-value')).toHaveText(headlineBefore ?? '');
      await page.mouse.move(box!.x + box!.width * 0.9, box!.y + box!.height / 2);
      await expect(chart.locator('.chart-reference-readout')).toHaveCount(0);
      await expect(chart.locator('.symbol-chart-crosshair')).toBeVisible();
      await page.mouse.move(1, 1);
    }

    const screenshot = testInfo.outputPath(`portfolio-requested-domain-${range}.png`);
    await chart.screenshot({ path: screenshot, animations: 'disabled' });
    await testInfo.attach(`portfolio-requested-domain-${range}`, {
      path: screenshot,
      contentType: 'image/png',
    });
  }

  for (let index = 1; index < firstObservedXs.length; index += 1) {
    expect(firstObservedXs[index]).toBeGreaterThan(firstObservedXs[index - 1] + 40);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const mobileScreenshot = testInfo.outputPath('portfolio-requested-domain-1Y-mobile.png');
  await chart.screenshot({ path: mobileScreenshot, animations: 'disabled' });
  await testInfo.attach('portfolio-requested-domain-1Y-mobile', {
    path: mobileScreenshot,
    contentType: 'image/png',
  });
});

test('Portfolio chart: fallback projection is explicitly labeled as a backtest', async ({ page }) => {
  await page.route('**/portfolio/history?range=3M', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        range: '3M',
        from: '2026-04-08',
        to: '2026-07-10',
        supported: true,
        approximate: true,
        approximationReasons: [
          'cash held at current balance for prior dates (no cash-history log)',
          "values use today's holdings at historical closes; intermediate buys and sells are not reflected",
        ],
        source: 'reconstruction',
        valueMethod: 'current_holdings_backtest',
        coverage: {
          requestedFrom: '2026-04-08',
          requestedTo: '2026-07-10',
          actualFrom: '2026-04-08',
          actualTo: '2026-07-10',
          complete: true,
          percent: 100,
        },
        points: [
          { t: '2026-04-08', value: 900_000, costBasis: 800_000 },
          { t: '2026-07-10', value: 1_000_000, costBasis: 800_000 },
        ],
        summary: {
          startValue: 900_000,
          endValue: 1_000_000,
          change: 100_000,
          changePercent: 11.111111,
        },
      }),
    });
  });

  const chart = page.locator('.breakdown > .portfolio-chart');
  await chart.getByRole('button', { name: '3M', exact: true }).click();
  await expect(chart.locator('.portfolio-chart-title')).toHaveText('Current holdings backtest');
  await expect(chart.locator('.portfolio-chart-change')).toContainText('Backtest');
  await chart.getByRole('button', { name: 'Approximation details' }).click();
  await expect(chart.locator('.approx-popover')).toContainText("today's holdings at historical closes");
});

test('Portfolio chart: a fresh install reports no observed snapshots honestly', async ({ page }) => {
  await page.route('**/portfolio/history?range=1D', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        range: '1D',
        from: '2026-07-09',
        to: '2026-07-10',
        supported: true,
        approximate: false,
        approximationReasons: [],
        source: 'none',
        valueMethod: 'observed_snapshot',
        coverage: {
          requestedFrom: '2026-07-09',
          requestedTo: '2026-07-10',
          actualFrom: null,
          actualTo: null,
          complete: false,
          percent: 0,
        },
        points: [],
        summary: { startValue: 0, endValue: 0, change: 0, changePercent: 0 },
      }),
    });
  });
  await page.reload();

  const chart = page.locator('.breakdown > .portfolio-chart');
  await expect(chart.locator('.portfolio-chart-coverage')).toHaveText('No observed snapshots in requested 1D');
  await expect(chart.locator('.symbol-chart-empty')).toContainText('No 1D snapshots yet');
  await chart.getByRole('button', { name: 'Coverage details' }).click();
  await expect(chart.locator('.approx-popover')).toContainText('No observed snapshots are available');
  await expect(chart.locator('.approx-popover')).toContainText('No backtest values are substituted');
});

test('Portfolio chart: one observed snapshot is not replaced by a backtest', async ({ page }) => {
  await page.route('**/portfolio/history?range=3M', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        range: '3M',
        from: '2026-05-07',
        to: '2026-05-07',
        supported: true,
        approximate: false,
        approximationReasons: [],
        source: 'snapshots',
        valueMethod: 'observed_snapshot',
        coverage: {
          requestedFrom: '2026-04-08',
          requestedTo: '2026-07-10',
          actualFrom: '2026-05-07T20:00:00Z',
          actualTo: '2026-05-07T20:00:00Z',
          complete: false,
          percent: 1.1,
        },
        points: [{ t: '2026-05-07T20:00:00Z', value: 1_000, costBasis: 800 }],
        summary: { startValue: 1_000, endValue: 1_000, change: 0, changePercent: 0 },
      }),
    });
  });

  const chart = page.locator('.breakdown > .portfolio-chart');
  await chart.getByRole('button', { name: '3M', exact: true }).click();
  await expect(chart.locator('.portfolio-chart-title')).toHaveText('Portfolio value');
  await expect(chart.locator('.portfolio-chart-coverage')).toContainText('Observed since May 7, 2026');
  await expect(chart.locator('.symbol-chart-empty')).toContainText('One observed snapshot is available');
  await expect(chart.locator('.portfolio-chart-change')).toHaveCount(0);
});

test('Portfolio chart: clicking a trade marker pins and dismisses trade details', async ({ page, request }) => {
  const portfolioChart = page.locator('.breakdown > .portfolio-chart');
  const warmHistory = await request.get('/portfolio/history?range=3M', { timeout: 60_000 });
  expect(warmHistory.ok()).toBe(true);
  const warmBody = await warmHistory.json() as {
    from: string;
    to: string;
    coverage: { requestedFrom: string; requestedTo: string };
    points: Array<{ t: string }>;
  };
  expect(warmBody.points.length).toBeGreaterThan(1);
  const chartedFrom = warmBody.from;
  const chartedTo = warmBody.to;
  const transactionsResponse = await request.get('/transactions');
  expect(transactionsResponse.ok()).toBe(true);
  const { transactions } = await transactionsResponse.json() as {
    transactions: Array<{ date: string }>;
  };
  const expectedTradeCount = transactions
    .filter((transaction) => transaction.date >= chartedFrom && transaction.date <= chartedTo)
    .length;
  expect(expectedTradeCount).toBeGreaterThan(0);
  await portfolioChart.locator('.symbol-chart-ranges button:has-text("3M")').click();

  const markers = portfolioChart.locator('.trade-marker-badge');
  await expect(markers.first()).toBeVisible({ timeout: 10_000 });
  const markerCounts = await markers.evaluateAll((nodes) => nodes.map(
    (node) => Number((node as HTMLElement).dataset.tradeCount ?? '0'),
  ));
  expect(markerCounts.reduce((sum, count) => sum + count, 0)).toBe(expectedTradeCount);

  const largestMarkerIndex = markerCounts.indexOf(Math.max(...markerCounts));
  const marker = markers.nth(largestMarkerIndex);
  await expect(marker).toBeVisible({ timeout: 10_000 });

  await marker.hover();
  const details = page.getByRole('dialog', { name: 'Trade details' });
  await expect(details).toBeVisible();
  await expect(marker).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.move(2, 2);
  await expect(details).toHaveCount(0);

  await marker.click();
  await expect(details).toBeVisible();
  await expect(details).toContainText(/trades|Buy|Sell/);
  await expect(details.locator('.trade-tooltip-date')).not.toBeEmpty();
  const firstTrade = details.locator('.trade-tooltip-line').first();
  await expect(firstTrade.locator('.trade-tooltip-badge')).toHaveText(/Buy|Sell/);
  await expect(firstTrade.locator('.trade-tooltip-line-date')).not.toBeEmpty();
  await expect(firstTrade.locator('.trade-tooltip-line-trade')).toContainText(/^[A-Z][A-Z0-9.-]* [\d,.]+ @ \$[\d,.]+$/);
  await expect(firstTrade.locator('strong')).not.toBeEmpty();
  await expect(firstTrade.locator('em')).not.toBeEmpty();
  await expect(marker).toHaveAttribute('aria-expanded', 'true');
  expect(await details.evaluate((element) => element.parentElement === document.body)).toBe(true);
  const detailBox = await details.boundingBox();
  const viewport = page.viewportSize();
  expect(detailBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(detailBox!.x).toBeGreaterThanOrEqual(0);
  expect(detailBox!.y).toBeGreaterThanOrEqual(0);
  expect(detailBox!.x + detailBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(detailBox!.y + detailBox!.height).toBeLessThanOrEqual(viewport!.height);

  // Click-pinned details must survive pointer movement away from the badge.
  await page.mouse.move(2, 2);
  await expect(details).toBeVisible();

  await marker.click();
  await expect(details).toHaveCount(0);
  await expect(marker).toHaveAttribute('aria-expanded', 'false');

  await marker.click();
  await expect(details).toBeVisible();
  await page.getByRole('heading', { name: 'Holdr' }).click();
  await expect(details).toHaveCount(0);
  await expect(marker).toHaveAttribute('aria-expanded', 'false');

  await marker.click();
  await expect(details).toBeVisible();
  await marker.press('Escape');
  await expect(details).toHaveCount(0);
});

test('Per-account chart: each account header has a toggle that mounts a chart', async ({ page }) => {
  // Wait for the account sections to render. They're outside .account.combined.
  await page.locator('.account:not(.combined) .account-header').first().waitFor({ timeout: 10_000 });
  const accountToggles = page.locator('.account:not(.combined) .account-header .chart-toggle');
  expect(await accountToggles.count()).toBeGreaterThan(0);
  const scopedHistory = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return url.pathname === '/portfolio/history'
        && url.searchParams.get('range') === '1D'
        && Boolean(url.searchParams.get('accounts'))
        && response.status() === 200;
    },
    { timeout: 25_000 },
  );
  await accountToggles.first().click();
  const response = await scopedHistory;
  const accountScope = new URL(response.url()).searchParams.get('accounts')!.split(',');
  expect(accountScope).toHaveLength(1);
  // A new portfolio-chart appears inside that account section.
  const accountChart = page.locator('.account:not(.combined) .portfolio-chart').first();
  await expect(accountChart).toBeVisible({ timeout: 10_000 });

  const scopedLongHistory = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return url.pathname === '/portfolio/history'
      && url.searchParams.get('range') === '3M'
      && url.searchParams.get('accounts') === accountScope[0]
      && candidate.status() === 200;
  });
  await accountChart.getByRole('button', { name: '3M', exact: true }).click();
  const longResponse = await scopedLongHistory;
  const longBody = await longResponse.json() as ObservedCoverageBody & {
    valueMethod: string;
    source: string;
  };
  if (longBody.valueMethod === 'ledger_estimate') {
    expect(longBody.source).toBe('reconstruction');
    await expect(accountChart.locator('.portfolio-chart-change')).toContainText('Value change');
  } else {
    // Accounts without any ledger rows keep the observed-snapshot fallback.
    expect(longBody.valueMethod).toBe('observed_snapshot');
    expect(longBody.source).toBe('snapshots');
    expect(longBody.coverage.complete).toBe(false);
    await expectObservedCoverageLine(page, accountChart, longBody, '3M');
  }
});

test('Manual Prices: round-trip PUT + DELETE through the UI', async ({ page, request }) => {
  await page.locator('button.tab:has-text("Accounts")').click();
  const panel = page.locator('.manual-prices');
  await expect(panel).toBeVisible();

  // Enter a unique test row (date in 2099 so it can't collide with real data).
  const symbol = 'E2E-TEST-DEL';
  const date = '2099-01-01';
  await panel.locator('.manual-prices-form input[list]').fill(symbol);
  await panel.locator('.manual-prices-form input[type="date"]').fill(date);
  await panel.locator('.manual-prices-form input[type="number"]').fill('123.45');
  await panel.locator('.manual-prices-form button:has-text("Add / update")').click();
  await expect.poll(async () => {
    const response = await request.get('/manual-prices');
    const body = await response.json() as { entries: Array<{ symbol: string; date: string }> };
    return body.entries.some((entry) => entry.symbol === symbol && entry.date === date);
  }, { timeout: 10_000 }).toBe(true);

  // Row appears in the list.
  await expect(panel.locator(`tr:has-text("${symbol}")`)).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(`tr:has-text("${symbol}")`)).toContainText('$123.45');

  // Remove it. Use page.on('dialog') to accept the confirm() prompt.
  page.once('dialog', (dialog) => dialog.accept());
  await panel.locator(`tr:has-text("${symbol}") button:has-text("Remove")`).click();
  await expect.poll(async () => {
    const response = await request.get('/manual-prices');
    const body = await response.json() as { entries: Array<{ symbol: string; date: string }> };
    return body.entries.some((entry) => entry.symbol === symbol && entry.date === date);
  }, { timeout: 10_000 }).toBe(false);

  // Row gone.
  await expect(panel.locator(`tr:has-text("${symbol}")`)).toHaveCount(0, { timeout: 5_000 });
});
