import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, requireHealthyApi, test, type APIRequestContext, type Locator, type Page } from './fixtures';
import {
  buildCardImportPayload,
  serializeCardImportPayload,
  type CardImportDraftRow,
  type CardOpeningMonthView,
  type CardOpeningMonthsResponse,
} from '@finance-tracker/shared';

/**
 * The owner's card opening months, reached from the overview's months note. A card first seen in mid-August marks
 * every month before it as possibly missing spending; "Confirm when your cards were opened" lists it with its month
 * prefilled from the first day Holdr has. The disposable stack starts without the opening months table (only the
 * Root-GO-gated operator command installs it), so on the live API the screen first says that confirming needs that
 * install, and changes run against a stand-in for /spending/card-openings that keeps months as the API does. Then the
 * operator command itself installs the table on this run's own disposable database (plan, a synthetic Root GO for it,
 * install), and the last tests confirm months on the live API: a later month than the first day Holdr has is refused,
 * and a month complete only because a card opened in it says so. Synthetic data only (fictional merchants, made-up
 * amounts); the page clock is fixed on Sep 20, 2024.
 *
 * The screen's answer is narrowed to this spec's own cards: whether a card is first seen after the earliest card (then
 * flagged, and left out of "Confirm all shown") must not depend on the cards other specs leave in the same disposable
 * stack. Where a test needs this spec's card flagged, a synthetic earlier card, never stored and not shown, joins the
 * answer.
 */

const SUFFIX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'openings';
const NICKNAME = `Openings ${SUFFIX}`;
const LABEL = `Chase ${NICKNAME} ··4343 · Casey`;
const MUTATION_HEADERS = { 'Content-Type': 'application/json', 'X-Holdr-Request': '1' };
const CONFIRMED_AT = '2024-09-20T12:00:00.000Z';
const PREFILL = 'August 2024 is where Holdr\'s history of this card begins, which may not be the month it was opened';
/** Another card account, first seen on Mar 1, 2024 and not in any view here: synthetic, never stored. */
const EARLIER: CardOpeningMonthView = {
  cardAccountId: 'card-acct-e2e-earlier-synthetic', firstRowDate: '2024-03-01', firstCoverageDate: '2024-03-01', firstKnownDate: '2024-03-01',
  prefillMonth: '2024-03', openingMonth: null, confirmedAt: null, status: null, history: [],
};

/** The screen's answer with only this spec's cards `own` (unconfirmed when `fresh`), and `earlier` when given. */
function ownAnswer(live: CardOpeningMonthsResponse, own: readonly string[], options: { earlier?: CardOpeningMonthView; fresh?: boolean } = {}) {
  const cards = live.cards.filter((card) => own.includes(card.cardAccountId))
    .map((card) => (options.fresh ? { ...card, openingMonth: null, confirmedAt: null, status: null, history: [] } : card));
  return { ...live, cards: options.earlier ? [...cards, options.earlier] : cards };
}

const purchase = (transactionDate: string, amountMinor: number, description: string): CardImportDraftRow =>
  ({ transactionDate, amountMinor, kind: 'purchase', description, issuerCategory: 'Groceries' });
// The card's record starts with its first statement on August 14.
const FIRST_STATEMENT = serializeCardImportPayload(buildCardImportPayload({
  source: 'e2e-sync', parserVersion: 'e2e@1', issuer: 'chase', currency: 'USD', coverage: { start: '2024-08-14', end: '2024-09-20' },
  rows: [purchase('2024-08-14', 4_200, 'NORTHWIND GROCERY'), purchase('2024-08-30', 2_500, 'PROSEWARE BISTRO'), purchase('2024-09-06', 3_100, 'NORTHWIND GROCERY')],
}).payload);

let cardId = '';

async function seed(request: APIRequestContext): Promise<void> {
  const created = await request.post('/card-accounts', {
    headers: MUTATION_HEADERS, data: JSON.stringify({ issuer: 'chase', owner: 'casey', nickname: NICKNAME, last4: '4343', currency: 'USD' }),
  });
  expect(created.status(), await created.text()).toBe(201);
  cardId = (await created.json() as { id: string }).id;
  const committed = await request.post(`/card-imports/commit?cardAccountId=${cardId}`, { headers: MUTATION_HEADERS, data: FIRST_STATEMENT });
  expect(committed.status(), await committed.text()).toBe(201);
}

async function openOpenings(page: Page) {
  await page.clock.setFixedTime(new Date('2024-09-20T12:00:00'));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Spending', exact: true }).click();
  await page.getByRole('combobox', { name: 'Card' }).selectOption({ label: LABEL });
  const overview = page.getByRole('region', { name: 'Spending overview' });
  await expect(overview).toHaveAttribute('aria-busy', 'false');
  const months = overview.getByRole('group', { name: 'Months' });
  // Before the card first appears its record may not reach back, and August's 1st to 13th are not in it.
  await expect(months.locator('[data-month="2024-07"]')).toHaveAttribute('data-partial', 'true');
  await expect(months.locator('[data-month="2024-08"]')).toHaveAttribute('data-partial', 'true');
  await months.getByRole('button', { name: 'Confirm when your cards were opened' }).click();
  const panel = overview.getByRole('region', { name: 'When your cards were opened' });
  await expect(panel).toBeFocused();
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  return { overview, panel, card: panel.getByRole('list', { name: 'Cards' }).getByRole('listitem') };
}

/**
 * The live answer of /spending/card-openings (its table not installed yet), narrowed to this spec's card. Only reads
 * happen while nothing can be confirmed.
 */
async function narrowAnswer(page: Page) {
  await page.route((url) => url.pathname === '/spending/card-openings', async (route) => {
    const live = await route.fetch();
    await route.fulfill({ status: live.status(), json: ownAnswer(await live.json() as CardOpeningMonthsResponse, [cardId]) });
  });
}

/**
 * A stand-in for /spending/card-openings with its table installed: the live screen at first (this spec's cards `own`,
 * see `ownAnswer`), then the owner's months kept as the API keeps them (one in force per card, every change and clear in
 * the history). Every request is kept.
 */
async function standIn(page: Page, options: { own?: readonly string[]; earlier?: CardOpeningMonthView; fresh?: boolean } = {}) {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  let screen: CardOpeningMonthsResponse | null = null;
  const update = (id: string, change: (card: CardOpeningMonthView) => CardOpeningMonthView) => {
    screen = { installed: true, cards: screen!.cards.map((card) => (card.cardAccountId === id ? change(card) : card)) };
  };
  const end = (card: CardOpeningMonthView): CardOpeningMonthView => ({
    ...card, openingMonth: null, confirmedAt: null, status: null,
    history: card.history.map((item) => (item.revokedAt === null ? { ...item, revokedAt: CONFIRMED_AT } : item)),
  });
  await page.route((url) => url.pathname === '/spending/card-openings' || url.pathname.startsWith('/spending/card-openings/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (screen === null) {
      const live = await route.fetch({ method: 'GET', url: new URL('/spending/card-openings', request.url()).toString(), postData: undefined });
      screen = { ...ownAnswer(await live.json() as CardOpeningMonthsResponse, options.own ?? [cardId], options), installed: true };
    }
    sent.push({ method: request.method(), path, body: request.postData() === null ? null : request.postDataJSON() });
    if (request.method() === 'PUT') {
      const { cards } = request.postDataJSON() as { cards: Array<{ cardAccountId: string; openingMonth: string }> };
      for (const { cardAccountId, openingMonth } of cards) {
        update(cardAccountId, (card) => {
          const ended = end(card);
          return { ...ended, openingMonth, confirmedAt: CONFIRMED_AT, status: 'applied',
            history: [...ended.history, { openingMonth, confirmedAt: CONFIRMED_AT, revokedAt: null }] };
        });
      }
      return route.fulfill({ json: { ...screen!, changed: cards.length } });
    }
    if (request.method() === 'DELETE') {
      const id = decodeURIComponent(path.split('/').pop()!);
      const cleared = screen!.cards.find((card) => card.cardAccountId === id)?.openingMonth != null;
      update(id, end);
      return route.fulfill({ json: { ...screen!, cleared } });
    }
    return route.fulfill({ json: screen! });
  });
  return sent;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await requireHealthyApi(request);
  await seed(request);
});

test.describe('Card opening months (desktop)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('lists the card with its month prefilled from its first statement, and says confirming needs the install', async ({ page }) => {
    await narrowAnswer(page);
    const { panel, card } = await openOpenings(page);
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(LABEL);
    await expect(panel.getByLabel(`${LABEL}: opened in`)).toHaveValue('2024-08');
    await expect(card.getByTestId('opening-status')).toHaveText('Not confirmed: shown from the first day Holdr has');
    // What Holdr has of the card, and where its prefilled month comes from, are folded under it.
    const evidence = card.getByTestId('opening-evidence');
    await expect(evidence).not.toHaveAttribute('open');
    await expect(card.getByTestId('opening-record')).toBeHidden();
    await evidence.getByText('What Holdr has', { exact: true }).click();
    await expect(card.getByTestId('opening-record')).toHaveText('Holdr has it from Aug 14, 2024');
    // Said plainly once open: the month shown may be only where Holdr's history of the card begins.
    await expect(card.getByTestId('opening-prefill')).toHaveText(PREFILL);
    await expect(card.getByTestId('opening-prefill')).toBeVisible();
    // The earliest card in the answer: not flagged.
    await expect(card.getByTestId('opening-later')).toHaveCount(0);
    // What confirming it would say, before the click.
    await expect(card.getByTestId('opening-assert')).toHaveText('Confirming August 2024 says this card had no spending before Aug 14, 2024');
    await expect(panel.getByTestId('openings-not-installed'))
      .toHaveText('Opening months need a one-time install on this Holdr first; until then nothing can be confirmed.');
    await expect(panel).toContainText('Confirm the month each card was opened (its first statement).');
    await expect(panel.getByRole('button', { name: 'Confirm all shown (1)' })).toBeDisabled();
    await expect(panel.getByRole('button', { name: `Confirm ${LABEL}` })).toBeDisabled();
    await panel.getByRole('button', { name: 'Done' }).click();
    await expect(panel).toHaveCount(0);
  });

  test('confirms the months shown at once or one card alone, refuses a month later than its record, and clears one', async ({ page }) => {
    const sent = await standIn(page);
    const trend: string[] = [];
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/spending/trend') trend.push(request.url()); });
    const { panel, card } = await openOpenings(page);
    const month = panel.getByLabel(`${LABEL}: opened in`);
    await expect(month).toHaveValue('2024-08');
    await expect(panel.getByTestId('openings-not-installed')).toHaveCount(0);

    // An older card than its record: the owner sets the month it opened, and confirms all shown.
    await month.fill('2024-07');
    await expect(card.getByTestId('opening-prefill')).toHaveCount(0);
    await expect(card.getByTestId('opening-assert')).toHaveText('Confirming July 2024 says this card had no spending before Jul 1, 2024; '
      + 'the months before Aug 14, 2024, its first day in Holdr, stay marked as possibly missing spending');
    await expect(panel.getByTestId('openings-confirm-all-note')).toHaveText('Confirming says each card had no spending before the day its line names.');
    const reads = trend.length;
    await panel.getByRole('button', { name: 'Confirm all shown (1)' }).click();
    await expect(panel.getByRole('status')).toHaveText('Confirmed 1 card\'s opening month');
    expect(sent.filter((item) => item.method === 'PUT').map((item) => item.body)).toEqual([{ cards: [{ cardAccountId: cardId, openingMonth: '2024-07' }] }]);
    await expect(card).toContainText('Confirmed July 2024 on Sep 20, 2024');
    await expect(panel.getByRole('button', { name: 'Every month shown is confirmed' })).toBeDisabled();
    // Every figure that reads coverage is read again.
    await expect.poll(() => trend.length).toBeGreaterThan(reads);

    // A month later than the first day Holdr has for it is refused before anything is sent.
    await month.fill('2024-09');
    await expect(card).toContainText('Holdr has it from Aug 14, 2024: choose August 2024 or earlier');
    await expect(month).toHaveAttribute('aria-invalid', 'true');
    await expect(panel.getByRole('button', { name: 'Confirm all shown' })).toBeDisabled();
    await expect(panel).toContainText('Fix the months marked first.');

    // One card alone, then cleared: its months are kept in its history, and it shows its first statement's month again.
    await month.fill('2024-08');
    await panel.getByRole('button', { name: `Confirm ${LABEL}` }).click();
    await expect(card).toContainText('Confirmed August 2024 on Sep 20, 2024');
    await panel.getByRole('button', { name: `Clear ${LABEL}` }).click();
    await expect(panel.getByRole('status')).toHaveText(`Cleared ${LABEL}'s opening month`);
    await expect(card).toContainText('Not confirmed: shown from the first day Holdr has');
    await expect(card.getByTestId('opening-prefill')).toHaveText(PREFILL);
    await expect(month).toHaveValue('2024-08');
    expect(sent.filter((item) => item.method !== 'GET').map((item) => [item.method, item.path, item.body])).toEqual([
      ['PUT', '/spending/card-openings', { cards: [{ cardAccountId: cardId, openingMonth: '2024-07' }] }],
      ['PUT', '/spending/card-openings', { cards: [{ cardAccountId: cardId, openingMonth: '2024-08' }] }],
      ['DELETE', `/spending/card-openings/${cardId}`, null],
    ]);
  });

  test('leaves a card first seen after the earliest one out of Confirm all shown: it takes its own Confirm', async ({ page }) => {
    // The earliest card in the answer is another one, first seen on Mar 1, 2024 and not shown here.
    const sent = await standIn(page, { earlier: EARLIER });
    const { panel, card } = await openOpenings(page);
    await expect(card).toHaveCount(1);
    await expect(panel.getByLabel(`${LABEL}: opened in`)).toHaveValue('2024-08');
    await expect(card.getByTestId('opening-prefill')).toHaveText(PREFILL);
    await expect(card.getByTestId('opening-later')).toHaveText('First seen after your earliest card (Mar 1, 2024): confirm only if it was opened then');
    await expect(card.getByTestId('opening-assert')).toHaveText('Confirming August 2024 says this card had no spending before Aug 14, 2024');
    // "Confirm all shown" confirms nothing, and says so.
    await expect(panel.getByRole('button', { name: 'Nothing to confirm at once: each card left is flagged', exact: true })).toBeDisabled();
    await expect(panel.getByTestId('openings-flagged-note')).toHaveText('1 flagged card is left out: it needs its own Confirm.');
    await expect(panel.getByTestId('openings-confirm-all-note')).toHaveCount(0);

    // Its own Confirm, deliberately.
    await panel.getByRole('button', { name: `Confirm ${LABEL}` }).click();
    await expect(panel.getByRole('status')).toHaveText('Confirmed 1 card\'s opening month');
    await expect(card).toContainText('Confirmed August 2024 on Sep 20, 2024');
    await expect(card.getByTestId('opening-prefill')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Every month shown is confirmed', exact: true })).toBeDisabled();
    await expect(panel.getByTestId('openings-flagged-note')).toHaveCount(0);
    expect(sent.filter((item) => item.method !== 'GET').map((item) => item.body)).toEqual([{ cards: [{ cardAccountId: cardId, openingMonth: '2024-08' }] }]);
  });
});

test.describe('Card opening months (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('fits the screen', async ({ page }) => {
    // Every line there is: the flag, what confirming asserts, the batch's notes, and, with the card's fold open, the
    // prefill said plainly.
    await standIn(page, { earlier: EARLIER });
    const { overview, panel, card } = await openOpenings(page);
    await expect(panel.getByLabel(`${LABEL}: opened in`)).toBeVisible();
    await card.getByTestId('opening-evidence').getByText('What Holdr has', { exact: true }).click();
    for (const id of ['opening-prefill', 'opening-later', 'opening-assert', 'opening-record']) await expect(card.getByTestId(id)).toBeVisible();
    await expect(panel.getByTestId('openings-flagged-note')).toBeVisible();
    const overflow = await overview.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

/**
 * Every visible text in `root` below the floors (plan D1): set under `floor` px, or, for running text that can wrap (not
 * a heading or a single-line control), set tighter than 1.5.
 */
function textBelow(root: Locator, floor: number): Promise<string[]> {
  return root.evaluate((element, min) => {
    const small: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      if (!text || !parent) continue;
      const box = parent.getBoundingClientRect();
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || box.width <= 1 || box.height <= 1) continue;
      const size = Number.parseFloat(style.fontSize);
      if (size < min) small.push(`${text} (${size}px)`);
      if (parent.closest('h1, h2, h3, h4, h5, h6, button, select, summary, input, .spending-toggle') === null
        && !(Number.parseFloat(style.lineHeight) >= size * 1.5 - 0.5)) small.push(`${text} (line-height ${style.lineHeight} at ${size}px)`);
    }
    return small;
  }, floor);
}

const fontSize = (locator: Locator) => locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));

for (const [width, height] of [[375, 812], [1920, 1080]] as const) {
  test.describe(`Card opening months at the type floors (${width}px)`, () => {
    test.use({ viewport: { width, height } });

    test('every line, the card\'s fold open, and a refused confirmation read at 14px or more; the name and month at 16px', async ({ page }) => {
      await standIn(page, { earlier: EARLIER });
      // Every confirmation is refused.
      await page.route((url) => url.pathname === '/spending/card-openings', (route) => (route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unable to save the months' }) })
        : route.fallback()));
      const { panel, card } = await openOpenings(page);
      await expect(card.getByTestId('opening-later')).toBeVisible();
      expect(await textBelow(panel, 14)).toEqual([]);
      // Its title is a section head (D1), an h3 like the overview's other block titles: 18px, 20px from 1280px wide.
      const title = panel.getByRole('heading', { level: 3, name: 'When your cards were opened' });
      expect(await fontSize(title)).toBeGreaterThanOrEqual(width >= 1280 ? 20 : 18);
      expect(await fontSize(card.locator('.openings-name'))).toBeGreaterThanOrEqual(16);
      expect(await fontSize(panel.getByLabel(`${LABEL}: opened in`))).toBeGreaterThanOrEqual(16);
      await card.getByTestId('opening-evidence').getByText('What Holdr has', { exact: true }).click();
      await expect(card.getByTestId('opening-record')).toBeVisible();
      expect(await textBelow(panel, 14)).toEqual([]);
      await panel.getByRole('button', { name: `Confirm ${LABEL}` }).click();
      await expect(panel.getByRole('alert')).toHaveText('Unable to save the months');
      expect(await textBelow(panel, 14)).toEqual([]);
    });

    test('the install note, the note beside "Confirm all shown", and a view with no cards read at 14px or more', async ({ page }) => {
      await narrowAnswer(page);
      let { panel } = await openOpenings(page);
      await expect(panel.getByTestId('openings-not-installed')).toBeVisible();
      expect(await textBelow(panel, 14)).toEqual([]);
      await page.unrouteAll({ behavior: 'wait' });
      await standIn(page);
      ({ panel } = await openOpenings(page));
      await expect(panel.getByTestId('openings-confirm-all-note')).toBeVisible();
      expect(await textBelow(panel, 14)).toEqual([]);
      await page.unrouteAll({ behavior: 'wait' });
      await standIn(page, { own: [] });
      ({ panel } = await openOpenings(page));
      await expect(panel).toContainText('No cards in this view.');
      expect(await textBelow(panel, 14)).toEqual([]);
    });
  });
}

const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const LATER = 'openingMonth must not be after the month of the first day Holdr has for the card';

/** The operator's own command on this run's disposable database: plan, a synthetic Root GO for it, install. */
function installOnDisposableDatabase(): void {
  const auth = process.env.HOLDR_E2E_AUTH_STATE;
  const runDir = auth ? path.dirname(auth) : '';
  // Only ever a disposable run's own database (scripts/e2e-disposable.mjs makes each run-… directory and its data/).
  if (!auth || !path.basename(runDir).startsWith('run-')) throw new Error('the live opening months tests need a disposable run (npm run test:e2e)');
  const database = path.join(runDir, 'data', 'finance.db');
  const env: NodeJS.ProcessEnv = { ...process.env, HOLDR_CONFIG: 'none' };
  for (const name of ['HOLDR_CONTROL_DIR', 'HOLDR_LIFECYCLE_LEASE', 'HOLDR_LIFECYCLE_LEASE_FD']) delete env[name];
  const cli = (args: string[]) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/cardOpeningsMain.ts', ...args], { cwd: API_DIR, env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as Record<string, string>;
  };
  const plan = cli(['plan', '--db', database]);
  if (plan.schema === 'present') return;
  expect(plan.schema).toBe('absent');
  const go = path.join(runDir, `card-openings-go-${randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(go, JSON.stringify({
    format: 'holdr.card-openings-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command: 'install',
    goId: randomBytes(16).toString('hex'), databaseRef: plan.databaseRef, schemaDigest: plan.schemaDigest,
  }), { mode: 0o600 });
  try {
    const backup = path.join(runDir, `before-card-openings-${randomBytes(4).toString('hex')}.db`);
    expect(cli(['install', '--db', database, '--backup', backup, '--root-go', go]).code).toBe('card-openings-installed');
  } finally {
    fs.rmSync(go, { force: true });
  }
}

const OPENED_NICKNAME = `Opened ${SUFFIX}`;
const OPENED_LABEL = `Chase ${OPENED_NICKNAME} ··4545 · Casey`;
let openedId = '';
let declaredId = '';

async function cardWith(request: APIRequestContext, nickname: string, last4: string, coverage: { start: string; end: string },
  rows: CardImportDraftRow[]): Promise<string> {
  const created = await request.post('/card-accounts', {
    headers: MUTATION_HEADERS, data: JSON.stringify({ issuer: 'chase', owner: 'casey', nickname, last4, currency: 'USD' }),
  });
  expect(created.status(), await created.text()).toBe(201);
  const id = (await created.json() as { id: string }).id;
  const json = serializeCardImportPayload(buildCardImportPayload({ source: 'e2e-sync', parserVersion: 'e2e@1', issuer: 'chase', currency: 'USD', coverage, rows }).payload);
  const committed = await request.post(`/card-imports/commit?cardAccountId=${id}`, { headers: MUTATION_HEADERS, data: json });
  expect(committed.status(), await committed.text()).toBe(201);
  return id;
}

const putMonths = (request: APIRequestContext, cards: Array<{ cardAccountId: string; openingMonth: string }>) =>
  request.put('/spending/card-openings', { headers: MUTATION_HEADERS, data: JSON.stringify({ cards }) });

test.describe('Card opening months, with the table the operator installed', () => {
  test.beforeAll(async ({ request }) => {
    installOnDisposableDatabase();
    // Its first statement starts on August 15; and a card whose import declares June 15, though its first row is in September.
    openedId = await cardWith(request, OPENED_NICKNAME, '4545', { start: '2024-08-15', end: '2024-09-20' },
      [purchase('2024-08-15', 1_800, 'NORTHWIND GROCERY'), purchase('2024-08-30', 2_200, 'PROSEWARE BISTRO')]);
    declaredId = await cardWith(request, `Declared ${SUFFIX}`, '4646', { start: '2024-06-15', end: '2024-09-20' },
      [purchase('2024-09-10', 1_500, 'NORTHWIND GROCERY')]);
  });

  test('refuses a month later than the first day Holdr has for a card, by its rows or its declared coverage', async ({ request }) => {
    for (const [cardAccountId, openingMonth] of [[openedId, '2024-09'], [declaredId, '2024-07'], [declaredId, '2024-09']]) {
      const refused = await putMonths(request, [{ cardAccountId, openingMonth }]);
      expect(refused.status(), openingMonth).toBe(400);
      expect(await refused.json()).toEqual({ error: LATER });
    }
    // The month of its first known day, or an earlier one, is taken.
    const taken = await putMonths(request, [{ cardAccountId: declaredId, openingMonth: '2024-06' }]);
    expect(taken.status(), await taken.text()).toBe(200);
    const listed = (await taken.json() as CardOpeningMonthsResponse).cards.find((card) => card.cardAccountId === declaredId)!;
    expect(listed).toMatchObject({ firstRowDate: '2024-09-10', firstKnownDate: '2024-06-15', openingMonth: '2024-06', status: 'applied' });
  });

  for (const width of [1280, 390]) {
    test(`a month complete only because a card opened in it says so, at ${width}px`, async ({ page, request }) => {
      await page.setViewportSize({ width, height: 900 });
      expect((await putMonths(request, [{ cardAccountId: openedId, openingMonth: '2024-08' }])).status()).toBe(200);
      await page.clock.setFixedTime(new Date('2024-09-20T12:00:00'));
      await page.goto('/');
      await page.getByRole('tab', { name: 'Spending', exact: true }).click();
      await page.getByRole('combobox', { name: 'Card' }).selectOption({ label: OPENED_LABEL });
      const overview = page.getByRole('region', { name: 'Spending overview' });
      await expect(overview).toHaveAttribute('aria-busy', 'false');
      const months = overview.getByRole('group', { name: 'Months' });
      const august = months.locator('[data-month="2024-08"]');
      // Complete from August 15, when the owner says it opened: the month says it includes a card opened in it.
      await expect(august).toHaveAttribute('data-partial', 'false');
      await expect(august).toHaveAccessibleName(/; every card's dates recorded \(1 card\); includes a card opened this month$/);
      await expect(august).toHaveAttribute('title', /includes a card opened this month$/);
      await expect(months.getByRole('list', { name: 'Months that include a card opened in them' })).toHaveText('August 2024 includes a card opened this month');
      // August itself, as the period shown: said beside its total.
      await august.click();
      await expect(page.locator('.spending-month-label')).toHaveText('August 2024');
      await expect(overview).toHaveAttribute('aria-busy', 'false');
      await expect(overview.getByTestId('overview-current-opened')).toHaveText('Includes a card opened this month');
      await expect(overview.getByTestId('overview-current-opened')).toBeVisible();
      const overflow = await overview.evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }

  test('confirms all shown except the cards first seen after the earliest one, and says how many it leaves out', async ({ page }) => {
    // This spec's three cards, each still to confirm: Declared is first seen on Jun 15, 2024, the earliest; the cards
    // first seen on Aug 14 and Aug 15 come after it.
    const sent = await standIn(page, { own: [cardId, openedId, declaredId], fresh: true });
    await page.clock.setFixedTime(new Date('2024-09-20T12:00:00'));
    await page.goto('/');
    await page.getByRole('tab', { name: 'Spending', exact: true }).click();
    await page.getByRole('combobox', { name: 'Person' }).selectOption('casey');
    const overview = page.getByRole('region', { name: 'Spending overview' });
    await expect(overview).toHaveAttribute('aria-busy', 'false');
    await overview.getByTestId('overview-openings').click();
    const panel = overview.getByRole('region', { name: 'When your cards were opened' });
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await expect(panel.getByRole('list', { name: 'Cards' }).getByRole('listitem')).toHaveCount(3);
    const line = (id: string) => panel.locator(`[data-card="${id}"]`);
    await expect(line(declaredId).getByTestId('opening-later')).toHaveCount(0);
    for (const id of [cardId, openedId]) {
      await expect(line(id).getByTestId('opening-later')).toHaveText('First seen after your earliest card (Jun 15, 2024): confirm only if it was opened then');
    }
    for (const id of [cardId, openedId, declaredId]) {
      // Each still shows its prefill: said in its status, and plainly in its fold.
      await expect(line(id).getByTestId('opening-status')).toHaveText('Not confirmed: shown from the first day Holdr has');
      await expect(line(id).getByTestId('opening-prefill')).toBeAttached();
    }
    await expect(panel.getByTestId('openings-flagged-note')).toHaveText('2 flagged cards are left out: each needs its own Confirm.');

    // One click confirms only the card not flagged.
    await panel.getByRole('button', { name: 'Confirm all shown except flagged (1)', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('Confirmed 1 card\'s opening month');
    expect(sent.filter((item) => item.method !== 'GET').map((item) => item.body)).toEqual([{ cards: [{ cardAccountId: declaredId, openingMonth: '2024-06' }] }]);
    // The two flagged cards are left, each for its own Confirm.
    await expect(panel.getByRole('button', { name: 'Nothing to confirm at once: each card left is flagged', exact: true })).toBeDisabled();
    await expect(panel.getByTestId('openings-flagged-note')).toHaveText('2 flagged cards are left out: each needs its own Confirm.');
  });
});
