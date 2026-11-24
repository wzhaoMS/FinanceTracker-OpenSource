import { expect, requireHealthyApi, test, type APIRequestContext, type Page, type Route } from './fixtures';
import { buildCardImportPayload, serializeCardImportPayload, type CardImportDraftRow } from '@finance-tracker/shared';

/**
 * The Card transactions page while it reads. A figure not read yet is a spinner in its place, its label heard once:
 * "Comparing" in the headline's comparison, "Loading transactions" beside the list's title, never the old "Comparing…"
 * or "Loading…" text, and never "—" for a total still being read. Read again after a change, each panel keeps its last
 * figures, dimmed at once, with one spinner beside its title, until about 300 ms after the new answer lands, however
 * quick the read (50 ms here): no number changes unmarked. A read again that fails leaves its error and "—", no spinner.
 * A read for another view that fails leaves none of the last view's figures, not for one change of the page: each panel
 * says its error in their place ("—" for a count), and the page says it with Try again, until a read of the view
 * succeeds; the same view read again that fails keeps its own rows, as before. What counts alone not read, for another
 * view or the same one, says its own error with its own Try again, never its last figures, while the other panels show
 * theirs, with no page error.
 * A spinner's ring is hidden from screen readers and is never a live region; under reduced motion it turns slowly and
 * nothing fades. Synthetic data only (fictional merchants, made-up amounts) on cards of their own; the page clock is
 * fixed on Sep 20, 2024.
 */

const SUFFIX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'spinner';
const NICKNAME = `Spinners ${SUFFIX}`;
const LABEL = `Chase ${NICKNAME} ··4848 · Casey`;
/** A card of its own for the quick read, whose total the change moves. */
const QUICK_NICKNAME = `Spinners quick ${SUFFIX}`;
const QUICK_LABEL = `Chase ${QUICK_NICKNAME} ··4949 · Casey`;
const MUTATION_HEADERS = { 'Content-Type': 'application/json', 'X-Holdr-Request': '1' };

const ROWS = serializeCardImportPayload(buildCardImportPayload({
  source: 'e2e-sync', parserVersion: 'e2e@1', issuer: 'chase', currency: 'USD', coverage: { start: '2024-08-01', end: '2024-09-20' },
  rows: [
    { transactionDate: '2024-08-06', amountMinor: 4200, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
    { transactionDate: '2024-08-19', amountMinor: 2500, kind: 'purchase', description: 'PROSEWARE BISTRO', issuerCategory: 'Dining' },
    { transactionDate: '2024-09-04', amountMinor: 6100, kind: 'purchase', description: 'NORTHWIND GROCERY', issuerCategory: 'Groceries' },
    { transactionDate: '2024-09-11', amountMinor: 1800, kind: 'purchase', description: 'PROSEWARE BISTRO', issuerCategory: 'Dining' },
  ] satisfies CardImportDraftRow[],
}).payload);

let mainId = '';
let quickId = '';

async function createCard(request: APIRequestContext, nickname: string, last4: string): Promise<string> {
  const created = await request.post('/card-accounts', {
    headers: MUTATION_HEADERS, data: JSON.stringify({ issuer: 'chase', owner: 'casey', nickname, last4, currency: 'USD' }),
  });
  expect(created.status(), await created.text()).toBe(201);
  const id = (await created.json() as { id: string }).id;
  const committed = await request.post(`/card-imports/commit?cardAccountId=${id}`, { headers: MUTATION_HEADERS, data: ROWS });
  expect(committed.status(), await committed.text()).toBe(201);
  return id;
}

/** Holds the page's GETs that `match` until released, or refused (each answered 503 with `message`); every other request goes on. */
function holdReads(page: Page, match: (url: URL) => boolean) {
  const held: Route[] = [];
  let holding = true;
  const ready = page.route((url) => match(url), async (route) => {
    if (!holding || route.request().method() !== 'GET') return route.continue();
    held.push(route);
  });
  return {
    ready,
    count: () => held.length,
    release: async () => {
      holding = false;
      for (const route of held.splice(0)) await route.continue();
    },
    refuse: async (message: string) => {
      holding = false;
      for (const route of held.splice(0)) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: message }) });
      }
    },
  };
}

async function openSpending(page: Page, label = LABEL) {
  await page.clock.setFixedTime(new Date('2024-09-20T12:00:00'));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Spending', exact: true }).click();
  await page.getByRole('combobox', { name: 'Card' }).selectOption({ label });
  await expect(page.locator('.spending-month-label')).toHaveText('September 2024');
}

/** Everything read, nothing marked: the page at rest. */
async function settled(page: Page) {
  await expect(overviewOf(page)).toHaveAttribute('aria-busy', 'false');
  await expect(overviewOf(page).getByTestId('overview-total')).toHaveText('$79.00');
  await expect(listOf(page).locator('.spending-panel-head .spending-muted')).toHaveText('2 posted');
  await expect(page.locator('[data-updating]')).toHaveCount(0);
  await expect(page.locator('.spinner')).toHaveCount(0);
}

/** The owner files the bistro's September charge under `category`, in the list. */
async function setCategory(page: Page, category: string) {
  const list = listOf(page);
  await list.getByRole('button', { name: /^Category .* for PROSEWARE BISTRO; change$/ }).click();
  const input = list.getByRole('combobox', { name: 'Category for PROSEWARE BISTRO' });
  await input.fill(category);
  await input.press('Enter');
}

interface HeadlineFrames {
  /** The first frame whose total is still `from` and marked as being read again: how visible the marks were. */
  firstPendingFrame: { spinnerOpacity: number; figureOpacity: number } | null;
  /** When the total's text became `to` (the DOM swap), and the first frames after it without the spinner, the dim. */
  swappedAt: number | null;
  spinnerGoneAt: number | null;
  dimGoneAt: number | null;
}

/**
 * Watches the headline from now on, frame by frame (requestAnimationFrame) as the reviewer's probe does: the first frame
 * its total is marked as being read again, the swap of its text (a MutationObserver), and when each mark leaves after it.
 */
async function watchHeadline(page: Page, from: string, to: string | null) {
  return page.evaluateHandle(([fromText, toText]) => {
    const result: HeadlineFrames = { firstPendingFrame: null, swappedAt: null, spinnerGoneAt: null, dimGoneAt: null };
    let stopped = false;
    const sample = () => {
      const total = document.querySelector('[data-testid="overview-total"]');
      const spinner = document.querySelector('[data-testid="overview-updating"]');
      const figure = document.querySelector('.overview-total-line');
      const updating = document.querySelector('[data-card="spent"]')?.getAttribute('data-updating') === 'true';
      const spinnerOpacity = spinner ? Number(getComputedStyle(spinner).opacity) : 0;
      const figureOpacity = figure ? Number(getComputedStyle(figure).opacity) : 1;
      if (result.firstPendingFrame === null && total?.textContent === fromText && updating) {
        result.firstPendingFrame = { spinnerOpacity, figureOpacity };
      }
      if (result.swappedAt !== null) {
        if (spinnerOpacity < 0.99 && result.spinnerGoneAt === null) result.spinnerGoneAt = performance.now();
        if (figureOpacity >= 0.99 && result.dimGoneAt === null) result.dimGoneAt = performance.now();
      }
      if (!stopped) requestAnimationFrame(sample);
    };
    const observer = new MutationObserver(() => {
      if (result.swappedAt === null && toText !== null && document.querySelector('[data-testid="overview-total"]')?.textContent === toText) {
        result.swappedAt = performance.now();
      }
    });
    observer.observe(document.querySelector('[data-testid="overview-headline"]')!, { subtree: true, childList: true, characterData: true });
    requestAnimationFrame(sample);
    return { result, stop: () => { stopped = true; observer.disconnect(); } };
  }, [from, to] as const);
}

const overviewOf = (page: Page) => page.getByRole('region', { name: 'Spending overview' });
const listOf = (page: Page) => page.getByRole('region', { name: 'Card transactions' });

/** The panels a read of the list or of the insights answers, by their names. */
const READ_PANELS = ['Card transactions', 'What counts as spending', 'Insights', 'Recurring charges'];

/** August's own reads of the list and of the insights, on the main card: what the failed-view tests refuse. */
const augustReads = (url: URL) => url.searchParams.get('cardAccountId') === mainId && (
  (url.pathname === '/card-transactions' && url.searchParams.get('from') === '2024-08-01')
  || (url.pathname === '/spending/insights' && url.searchParams.get('month') === '2024-08'));

/** August's reads of What counts on the main card (the list's, and the overview's for its headline). */
const augustAccounting = (url: URL) => url.pathname === '/spending/accounting' && url.searchParams.get('cardAccountId') === mainId
  && url.searchParams.get('from') === '2024-08-01';

/** Answers the page's GETs 503 with `message`; every other request goes on. */
const refuseWith = (message: string) => (route: Route) => (route.request().method() === 'GET'
  ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: message }) })
  : route.continue());

/**
 * Watches the page from now on, after each change to it (a MutationObserver), for the panels named. `unmarked`: those
 * that showed figures (rows, insights, charges, What counts' line or statement, an amount, a count, "none") with neither
 * the mark of a read again (data-updating) nor their error, that is, earlier figures passing as the view's own. `mixed`:
 * those that showed figures beside their error.
 */
async function watchPanels(page: Page, names: string[]) {
  return page.evaluateHandle((labels) => {
    const result = { unmarked: [] as string[], mixed: [] as string[] };
    const root = document.querySelector('section.spending')!;
    const shown = '.spending-row, .spending-insight, .spending-recurring-row, [data-testid="what-counts-compact"], [data-testid="reconciliation"]';
    const answer = /\$|\d+ posted|No card transactions|Nothing stands out|None found yet|Nothing to confirm/;
    const note = (list: string[], label: string) => { if (!list.includes(label)) list.push(label); };
    const observer = new MutationObserver(() => {
      for (const label of labels) {
        const panel = root.querySelector(`section[aria-label="${label}"]`);
        if (!panel || (panel.querySelector(shown) === null && !answer.test(panel.textContent ?? ''))) continue;
        if (panel.querySelector('.overview-error')) note(result.mixed, label);
        else if (panel.getAttribute('data-updating') !== 'true') note(result.unmarked, label);
      }
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    return { result, stop: () => observer.disconnect() };
  }, names);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await requireHealthyApi(request);
  mainId = await createCard(request, NICKNAME, '4848');
  quickId = await createCard(request, QUICK_NICKNAME, '4949');
});

test.describe('Card transactions while reading (spinners)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('a comparison and a list not read yet are spinners with their labels, heard once, never the old text', async ({ page }) => {
    const compare = holdReads(page, (url) => url.pathname === '/spending/compare');
    const posted = holdReads(page, (url) => url.pathname === '/card-transactions' && url.searchParams.get('status') === 'posted');
    await Promise.all([compare.ready, posted.ready]);
    await openSpending(page);
    await expect.poll(() => compare.count()).toBeGreaterThan(0);
    const overview = overviewOf(page);
    const box = overview.getByTestId('overview-compare');
    await expect(box.getByTestId('overview-comparing')).toBeVisible();
    await expect(overview.getByText('Comparing…')).toHaveCount(0);
    // Nothing shown yet: this spinner may wait a moment, so a quick first read never flickers.
    await expect(box.getByTestId('overview-comparing')).toHaveClass(/\bdeferred\b/);
    // Heard once: the label, and nothing of the ring.
    await expect(box).toMatchAriaSnapshot('- paragraph: Comparing');
    await expect(box.locator('.spinner-ring')).toHaveAttribute('aria-hidden', 'true');
    await expect(box.locator('[role="status"], [aria-live]')).toHaveCount(0);
    // The total was read: its figure, with no spinner of its own.
    await expect(overview.getByTestId('overview-total')).toHaveText('$79.00');
    await expect(overview.getByTestId('overview-total-reading')).toHaveCount(0);

    const list = listOf(page);
    await expect(list.getByTestId('transactions-loading')).toBeVisible();
    await expect(list.getByText('Loading…')).toHaveCount(0);
    await expect(list.locator('.spending-panel-head')).toMatchAriaSnapshot(`
      - heading "Transactions" [level=3]
      - text: Loading transactions
    `);
    await expect(list.locator('.spending-panel-head')).not.toContainText('posted');

    // A turning ring, slower under reduced motion, and never still.
    const ring = box.locator('.spinner-ring');
    await expect.poll(() => ring.evaluate((element) => getComputedStyle(element).animationDuration)).toBe('0.8s');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => ring.evaluate((element) => getComputedStyle(element).animationDuration)).toBe('2.4s');
    await expect.poll(() => ring.evaluate((element) => getComputedStyle(element).animationName)).not.toBe('none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await compare.release();
    await posted.release();
    await expect(box.getByTestId('overview-comparing')).toHaveCount(0);
    await expect(box.getByTestId('overview-not-comparable-reason')).toHaveText('Not comparable: this period is still in progress');
    await settled(page);
  });

  test('read again after a change, each panel keeps its last figures, dimmed at once, with one spinner by its title', async ({ page }) => {
    await openSpending(page);
    await settled(page);
    const overview = overviewOf(page);
    const list = listOf(page);

    // The owner files a charge under a category of their own: everything that reads it is read again, and held here.
    const reads = holdReads(page, (url) => ['/spending/summary', '/spending/compare', '/spending/trend', '/card-transactions'].includes(url.pathname));
    await reads.ready;
    const watch = await watchHeadline(page, '$79.00', null);
    await setCategory(page, 'Eating out');
    await expect.poll(() => reads.count()).toBeGreaterThanOrEqual(4);

    // The headline: on the very first frame it is marked, the spinner is fully there and the total already dimmed.
    await expect.poll(() => watch.evaluate((value) => value.result.firstPendingFrame !== null)).toBe(true);
    const first = await watch.evaluate((value) => { value.stop(); return value.result.firstPendingFrame!; });
    expect(first.spinnerOpacity, 'the spinner shows on the first frame the total is read again').toBe(1);
    expect(first.figureOpacity, 'the total is dimmed on that same frame').toBeCloseTo(0.86, 2);
    const total = overview.locator('[data-card="spent"]');
    await expect(overview.getByTestId('overview-updating')).toBeVisible();
    await expect(overview.getByTestId('overview-updating')).not.toHaveClass(/\bdeferred\b/);
    await expect(overview.getByTestId('overview-total')).toHaveText('$79.00');
    await expect(total).toHaveAttribute('data-updating', 'true');
    await expect(overview.getByTestId('overview-compare')).toHaveAttribute('data-updating', 'true');
    await expect(total.locator('.overview-headline-head')).toMatchAriaSnapshot(`
      - heading "Spent in September so far" [level=3]
      - text: Updating
    `);
    expect(await total.locator('.overview-headline-head').evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    // Every other panel the change reads again: its spinner by its title, its figures dimmed.
    for (const name of ['Where it went', 'What changed', 'Months']) {
      const block = overview.getByRole('group', { name, exact: true });
      await expect(block, name).toHaveAttribute('data-updating', 'true');
      await expect(block.locator('.overview-block-head .spinner'), name).toHaveCount(1);
    }
    await expect(overview.locator('.overview-categories')).toHaveAttribute('data-updating', 'true');
    // The list: its rows stay, dimmed at once, and its title says it is loading; no count until the new one is in.
    await expect(list).toHaveAttribute('data-updating', 'true');
    await expect(list.getByTestId('transactions-loading')).toBeVisible();
    await expect(list.getByTestId('transactions-loading')).not.toHaveClass(/\bdeferred\b/);
    await expect(list.locator('.spending-row')).toHaveCount(2);
    expect(await list.locator('.spending-group').first().evaluate((element) => getComputedStyle(element).opacity)).toBe('0.86');
    // No spinner is a live region: nothing is read out by itself.
    await expect(page.locator('.spinner[role], .spinner [role], .spinner[aria-live], .spinner [aria-live]')).toHaveCount(0);
    // Nothing fades, under reduced motion either: neither a panel's body nor the words beside its title.
    const counts = page.getByRole('region', { name: 'What counts as spending' });
    await expect(counts).toHaveAttribute('data-updating', 'true');
    for (const motion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion: motion });
      for (const part of [counts.locator('.spending-panel-head > .spending-muted'), list.locator('.spending-group').first()]) {
        await expect.poll(() => part.evaluate((element) => getComputedStyle(element).transitionDuration), motion).toBe('0s');
      }
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await reads.release();
    await settled(page);
    expect(await total.locator('.overview-total-line').evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
  });

  test('a total not read yet is a spinner in its place, never "—", and nothing on a first read is marked as updating', async ({ page }) => {
    const totals = holdReads(page, (url) => url.pathname === '/spending/summary' && url.searchParams.get('to') === '2024-09-20');
    await totals.ready;
    await openSpending(page);
    await expect.poll(() => totals.count()).toBeGreaterThan(0);
    const overview = overviewOf(page);
    await expect(overview.getByTestId('overview-total-reading')).toBeVisible();
    await expect(overview.getByTestId('overview-total')).toHaveCount(0);
    await expect(overview.getByTestId('overview-out-reading')).toBeVisible();
    await expect(overview.getByTestId('overview-headline')).not.toContainText('—');
    // The comparison is in, the total not yet: this view's first read shows nothing earlier, so nothing is marked.
    await expect(overview.getByRole('group', { name: 'Where it went', exact: true })).toBeVisible();
    await expect(overview.locator('[data-updating]')).toHaveCount(0);
    await expect(overview.getByTestId('overview-updating')).toHaveCount(0);
    await totals.release();
    await expect(overview.getByTestId('overview-total')).toHaveText('$79.00');
    await expect(overview.getByTestId('overview-total-reading')).toHaveCount(0);
    await expect(overview.getByTestId('overview-out-reading')).toHaveCount(0);
  });

  test('a quick read again (50 ms) marks the total on its first frame and keeps the marks about 300 ms after it changes', async ({ page }, testInfo) => {
    // The reviewer's probe (#263, r1/r2): the same view read again answers in 50 ms, with the total the change makes.
    const summaries = new Map<string, { totals: Array<{ currency: string; spendingMinor: number }> }>();
    const isSummary = (url: URL) => url.pathname === '/spending/summary' && url.searchParams.get('cardAccountId') === quickId;
    await page.route(isSummary, async (route) => {
      const response = await route.fetch();
      summaries.set(route.request().url(), await response.json() as { totals: Array<{ currency: string; spendingMinor: number }> });
      await route.fulfill({ response });
    });
    await openSpending(page, QUICK_LABEL);
    await settled(page);
    await page.unroute(isSummary);
    await page.route(isSummary, async (route) => {
      const prior = summaries.get(route.request().url());
      expect(prior, 'the same view was read before').toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ...prior, totals: prior!.totals.map((entry) => (entry.currency === 'USD' ? { ...entry, spendingMinor: 6100 } : entry)) }),
      });
    });
    const watch = await watchHeadline(page, '$79.00', '$61.00');
    try {
      // Filed under precious metals, the bistro's charge leaves spending: $79.00 becomes $61.00.
      await setCategory(page, 'Precious metals');
      await expect(overviewOf(page).getByTestId('overview-total')).toHaveText('$61.00');
      await expect.poll(() => watch.evaluate((value) => value.result.spinnerGoneAt !== null && value.result.dimGoneAt !== null)).toBe(true);
      const result = await watch.evaluate((value) => value.result);
      await testInfo.attach('quick-read-frames.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
      expect(result.firstPendingFrame, 'a frame was painted while the quick read was pending').not.toBeNull();
      expect(result.firstPendingFrame!.spinnerOpacity, 'the spinner shows on the first pending frame').toBe(1);
      expect(result.firstPendingFrame!.figureOpacity, 'the old total is dimmed on the first pending frame').toBeCloseTo(0.86, 2);
      expect(result.swappedAt).not.toBeNull();
      expect(result.spinnerGoneAt! - result.swappedAt!, 'the spinner stays about 300 ms after the total changes').toBeGreaterThanOrEqual(295);
      expect(result.dimGoneAt! - result.swappedAt!, 'the dim stays about 300 ms after the total changes').toBeGreaterThanOrEqual(295);
    } finally {
      await watch.evaluate((value) => value.stop());
    }
  });

  test('a read again that fails leaves its error and "—": no spinner, no earlier figure and never $0', async ({ page }) => {
    await openSpending(page);
    await expect(overviewOf(page)).toHaveAttribute('aria-busy', 'false');
    await expect(overviewOf(page).getByTestId('overview-total')).toHaveText('$79.00');
    await page.route((url) => url.pathname === '/spending/summary' && url.searchParams.get('cardAccountId') === mainId,
      (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic read refused' }) }));
    await setCategory(page, 'Eating in');
    const overview = overviewOf(page);
    await expect(overview.getByTestId('overview-totals-error')).toContainText('synthetic read refused');
    await expect(overview.getByTestId('overview-total')).toHaveText('—');
    await expect(overview.getByTestId('overview-total-reading')).toHaveCount(0);
    await expect(overview.getByTestId('overview-updating')).toHaveCount(0);
    await expect(overview.locator('[data-card="spent"]')).not.toHaveAttribute('data-updating', 'true');
    await expect(overview.getByTestId('overview-headline')).not.toContainText('$0.00');
  });

  test('a read for another view that fails leaves none of the last view\'s figures: each panel\'s error, "—", and Try again', async ({ page }) => {
    await openSpending(page);
    await settled(page);
    const list = listOf(page);
    const counts = page.getByRole('region', { name: 'What counts as spending', exact: true });
    const insights = page.getByRole('region', { name: 'Insights', exact: true });
    const recurring = page.getByRole('region', { name: 'Recurring charges', exact: true });
    await expect(list.locator('.spending-row')).toHaveCount(2);
    await expect(counts.getByTestId('what-counts-compact')).toBeVisible();
    await expect(recurring).toBeVisible();

    // August's list and insights are held, then refused; the overview reads August on its own.
    const reads = holdReads(page, augustReads);
    await reads.ready;
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(page.locator('.spending-month-label')).toHaveText('August 2024');
    await expect.poll(() => reads.count()).toBe(3);
    // While August is read, September's figures stay, marked as being read again (#263).
    for (const name of READ_PANELS) await expect(page.getByRole('region', { name, exact: true }), name).toHaveAttribute('data-updating', 'true');
    const watch = await watchPanels(page, READ_PANELS);
    await reads.refuse('synthetic read refused');

    // Nothing of September stays, not for one change of the page: each panel says the error in place of its figures.
    const alert = page.getByTestId('spending-read-error');
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toContainText('synthetic read refused');
    await expect(alert.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect(list.getByTestId('transactions-error')).toHaveText('Couldn\'t read these transactions: synthetic read refused');
    await expect(counts.getByTestId('what-counts-error')).toHaveText('Couldn\'t read what counts: synthetic read refused');
    await expect(insights.getByTestId('insights-error')).toHaveText('Couldn\'t read the insights: synthetic read refused');
    await expect(recurring.getByTestId('recurring-error')).toHaveText('Couldn\'t read the recurring charges: synthetic read refused');
    const shown = await watch.evaluate((value) => { value.stop(); return value.result; });
    expect(shown.unmarked, 'panels shown unmarked').toEqual([]);
    expect(shown.mixed, 'panels shown beside their error').toEqual([]);
    // One Try again, the page's: What counts' own is for its read alone.
    await expect(counts.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    // Unknown, never none: "—" for the counts, no "No card transactions", no "Nothing to confirm", no amount at all.
    await expect(list.locator('.spending-row')).toHaveCount(0);
    await expect(list.locator('.spending-panel-head .spending-muted')).toHaveText('—');
    await expect(list).not.toContainText('No card transactions');
    await expect(counts.getByTestId('what-counts-compact')).toHaveCount(0);
    await expect(insights.locator('.spending-insight')).toHaveCount(0);
    await expect(insights).not.toContainText('Nothing stands out');
    await expect(recurring.locator('.spending-panel-head .spending-muted')).toHaveText('—');
    for (const name of READ_PANELS) {
      const panel = page.getByRole('region', { name, exact: true });
      await expect(panel, name).not.toContainText('$');
      await expect(panel, name).not.toHaveAttribute('data-updating', 'true');
      await expect(panel.locator('.spinner'), name).toHaveCount(0);
    }
    // Opened, What counts says the same.
    await counts.getByRole('button', { name: 'What counts', exact: true }).click();
    await expect(counts.getByTestId('what-counts-error')).toBeVisible();
    await expect(counts.getByTestId('reconciliation')).toHaveCount(0);
    // The overview read August on its own.
    await expect(overviewOf(page).getByTestId('overview-total')).toHaveText('$67.00');

    // Try again, from the keyboard: until a read succeeds, only the error, and each panel being read says so.
    const retried = holdReads(page, augustReads);
    await retried.ready;
    await alert.getByRole('button', { name: 'Try again', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => retried.count()).toBe(3);
    await expect(alert.getByTestId('spending-retrying')).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Trying again', exact: true })).toBeFocused();
    await expect(list.getByTestId('transactions-loading')).toBeVisible();
    await expect(counts.getByTestId('what-counts-reading')).toBeVisible();
    await expect(insights.getByTestId('insights-looking')).toBeVisible();
    await expect(recurring.getByTestId('recurring-reading')).toBeVisible();
    for (const name of READ_PANELS) {
      const panel = page.getByRole('region', { name, exact: true });
      await expect(panel.locator('.overview-error'), name).toBeVisible();
      await expect(panel, name).not.toContainText('$');
    }
    const retryWatch = await watchPanels(page, READ_PANELS);
    await retried.release();

    // August's own figures, and focus on what was read.
    await expect(alert).toHaveCount(0);
    await expect(list.locator('.spending-row')).toHaveCount(2);
    await expect(list.locator('.spending-panel-head .spending-muted')).toHaveText('2 posted');
    await expect(list).toContainText('$42.00');
    await expect(list).toContainText('$25.00');
    await expect(list).toBeFocused();
    await expect(counts.getByTestId('reconciliation')).toBeVisible();
    await expect(insights.getByTestId('insights-looking')).toHaveCount(0);
    for (const name of READ_PANELS) await expect(page.getByRole('region', { name, exact: true }).locator('.overview-error'), name).toHaveCount(0);
    await expect(page.locator('.spending-error')).toHaveCount(0);
    expect(await retryWatch.evaluate((value) => { value.stop(); return value.result.mixed; }), 'panels shown beside their error').toEqual([]);
  });

  test('after a view whose read failed, another view shows its own figures, the failure is not said under it, and focus stays put', async ({ page }) => {
    await openSpending(page);
    await settled(page);
    await page.route(augustReads, refuseWith('synthetic read refused'));
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(listOf(page).getByTestId('transactions-error')).toBeVisible();
    const alert = page.getByTestId('spending-read-error');
    await expect(alert).toBeVisible();

    // Try again from the keyboard; while August is read again, focus falls to the page (as when the control used goes: a
    // filter's chip, cleared), and September is chosen without moving it. Focus is not taken to a list it didn't retry.
    const retried = holdReads(page, augustReads);
    await retried.ready;
    await alert.getByRole('button', { name: 'Try again', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => retried.count()).toBe(3);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.getByRole('button', { name: 'Next month' }).dispatchEvent('click');
    await expect(page.locator('.spending-month-label')).toHaveText('September 2024');
    await settled(page);
    await expect(listOf(page).locator('.spending-row')).toHaveCount(2);
    await expect(alert).toHaveCount(0);
    await expect(page.locator('.spending-error, .overview-error')).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement === document.body), 'focus stays on the page').toBe(true);
    await retried.release();
  });

  test('the same view read again that fails keeps its own rows, as before: the page says its error, with no Try again', async ({ page }) => {
    await openSpending(page);
    await settled(page);
    await page.route((url) => url.pathname === '/card-transactions' && url.searchParams.get('cardAccountId') === mainId,
      refuseWith('synthetic read refused'));
    // A category no other test files it under, so the change is always one, and the list is read again.
    await setCategory(page, 'Takeaway');
    const list = listOf(page);
    await expect(page.locator('.spending-error')).toHaveText('synthetic read refused');
    await expect(list.locator('.spending-row')).toHaveCount(2);
    await expect(list.getByTestId('transactions-error')).toHaveCount(0);
    await expect(page.getByTestId('spending-read-error')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  });

  test('What counts alone not read for another view: its own error and Try again, never the last view\'s, and the other panels\' figures', async ({ page }) => {
    await openSpending(page);
    await settled(page);
    const list = listOf(page);
    const counts = page.getByRole('region', { name: 'What counts as spending', exact: true });
    await expect(counts.getByTestId('what-counts-compact')).toBeVisible();

    // August's What counts is held, then refused; the rest of August is read.
    const reads = holdReads(page, augustAccounting);
    await reads.ready;
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(page.locator('.spending-month-label')).toHaveText('August 2024');
    await expect.poll(() => reads.count()).toBe(2);
    await expect(counts).toHaveAttribute('data-updating', 'true');
    const watch = await watchPanels(page, ['What counts as spending']);
    await reads.refuse('synthetic read refused');

    // What counts says why, in place of September's, with its own Try again; nothing else failed, so no page error.
    const error = counts.getByTestId('what-counts-error');
    await expect(error).toContainText('Couldn\'t read what counts: synthetic read refused');
    await expect(error).toHaveAttribute('role', 'status');
    const retry = error.getByRole('button', { name: 'Try again', exact: true });
    await expect(retry).toBeVisible();
    const shown = await watch.evaluate((value) => { value.stop(); return value.result; });
    expect(shown.unmarked, 'What counts shown unmarked').toEqual([]);
    expect(shown.mixed, 'What counts shown beside its error').toEqual([]);
    await expect(counts.getByTestId('what-counts-compact')).toHaveCount(0);
    await expect(counts).not.toContainText('$');
    await expect(counts).not.toHaveAttribute('data-updating', 'true');
    await expect(counts.locator('.spinner')).toHaveCount(0);
    await expect(list.locator('.spending-row')).toHaveCount(2);
    await expect(list.locator('.spending-panel-head .spending-muted')).toHaveText('2 posted');
    await expect(list).toContainText('$42.00');
    await expect(overviewOf(page).getByTestId('overview-total')).toHaveText('$67.00');
    await expect(page.getByTestId('spending-read-error')).toHaveCount(0);
    await expect(page.locator('.spending-error')).toHaveCount(0);

    // Try again, from the keyboard: What counts alone is read again, and says so; nothing else is.
    await expect(page.locator('[data-updating]')).toHaveCount(0);
    const retried = holdReads(page, augustAccounting);
    await retried.ready;
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => retried.count()).toBe(1);
    await expect(counts.getByTestId('what-counts-retrying')).toBeVisible();
    await expect(counts.getByTestId('what-counts-reading')).toBeVisible();
    const trying = error.getByRole('button', { name: 'Trying again', exact: true });
    await expect(trying).toBeFocused();
    await expect(trying).toHaveAttribute('aria-disabled', 'true');
    // Pressed again while it reads, nothing more is asked for (given a moment, a second read would be held here too).
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    expect(retried.count(), 'What counts alone, read once').toBe(1);
    await expect(page.locator('[data-updating]')).toHaveCount(0);
    await expect(list.getByTestId('transactions-loading')).toHaveCount(0);
    await retried.release();

    // August's What counts, and focus on its title.
    await expect(counts.getByTestId('what-counts-compact')).toBeVisible();
    await expect(counts.getByTestId('what-counts-error')).toHaveCount(0);
    await expect(counts.locator('.spinner')).toHaveCount(0);
    await expect(counts.getByRole('button', { name: 'What counts', exact: true })).toBeFocused();
  });

  test('What counts alone not read again for the same view: its own error and Try again, not its last figures; the list keeps its rows', async ({ page }) => {
    await openSpending(page);
    await settled(page);
    const list = listOf(page);
    const counts = page.getByRole('region', { name: 'What counts as spending', exact: true });
    await expect(counts.getByTestId('what-counts-compact')).toBeVisible();
    const accountingReads = (url: URL) => url.pathname === '/spending/accounting' && url.searchParams.get('cardAccountId') === mainId;
    await page.route(accountingReads, refuseWith('synthetic read refused'));
    // A category no other test files it under, so the change is always one, and everything is read again.
    await setCategory(page, 'Brunch');

    const error = counts.getByTestId('what-counts-error');
    await expect(error).toContainText('Couldn\'t read what counts: synthetic read refused');
    await expect(counts.getByTestId('what-counts-compact')).toHaveCount(0);
    await expect(counts).not.toContainText('$');
    // The other panels, read again, show their figures; nothing else failed, so no page error.
    await settled(page);
    await expect(list.locator('.spending-row')).toHaveCount(2);
    await expect(page.getByTestId('spending-read-error')).toHaveCount(0);
    await expect(page.locator('.spending-error')).toHaveCount(0);

    // Try again, with the mouse, once What counts can be read.
    await page.unroute(accountingReads);
    await error.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(counts.getByTestId('what-counts-compact')).toBeVisible();
    await expect(counts.getByTestId('what-counts-error')).toHaveCount(0);
    await expect(counts.locator('.spinner')).toHaveCount(0);
  });
});
