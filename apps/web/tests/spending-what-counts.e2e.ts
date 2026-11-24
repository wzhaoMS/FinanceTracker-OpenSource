import { createHash } from 'node:crypto';

import { expect, test, type Locator, type Page } from './fixtures';
import {
  buildCardSpendingAccounting,
  cardMerchantKey,
  computeCardInsights,
  effectiveCardMerchant,
  previewCardSpendingRule,
  resolveCardSpendingExclusions,
  suggestCardAssetPurchases,
  summarizeCardSpending,
  toCardTransactionView,
  toLetterHex,
  withCardSpendingExclusion,
  type CardAccount,
  type CardMetalsMerchantClass,
  type CardOwner,
  type CardSpendingRule,
  type CardTransaction,
} from '@finance-tracker/shared';

/**
 * What counts as spending, end to end in the page: a charge that may be precious metals is counted until the owner
 * decides, the total says what is waiting and the total without it, and the owner's word moves it. The panel is one
 * line until opened (what waits, and Review); open, it shows what waits first, then the card activity as a statement
 * (counted as spending, not counted, each line a label and its signed amount) that adds up to all card activity to the
 * cent, then the owner's rules, folded. The page talks to a fake that answers with the API's own shared code over
 * synthetic rows (fictional descriptors, made-up amounts), keeps the owner's categories and rules, and so recomputes
 * every figure the way the API does; a rule's preview match is the API's (`srp1:` and the letter hex of sha256 over the
 * same parts), and a rule whose match is stale is refused.
 */

const AT = '2026-10-01T00:00:00.000Z';
const WHOLESALE = 'Merchandise & Supplies-Wholesale Stores';
const INTERNET = 'Merchandise & Supplies-Internet Purchase';
const ONLINE = 'COSTCO.COM *ONLINE SAMPLE WA';

type Row = [
  card: 'a' | 'b', date: string, amountMinor: number, description: string, category: string | null, kind?: CardTransaction['kind'],
  /** The owner's own category, and a row not posted yet. */
  more?: { userCategory?: string; status?: CardTransaction['status'] },
];

function serveSpending(page: Page, options: {
  refuse?: ReadonlySet<string>;
  /** Rules installed; `hold` delays a rule preview's answer for a minimum until it resolves; `made` are there already. */
  rules?: { installed: boolean; hold?: (minAmountMinor: number) => Promise<void>; made?: CardSpendingRule[] };
  extra?: Row[];
  /** The rows instead of the usual five. */
  data?: Row[];
} = {}) {
  const account = (letter: string, issuer: string, owner: CardOwner, last4: string): CardAccount => ({
    id: `card-acct-${letter.repeat(32)}`, issuer, owner, nickname: `Counts ${letter}`, last4, currency: 'USD',
    status: 'active', createdAt: AT, updatedAt: AT,
  });
  const accounts = [account('a', 'citi', 'alex', '0001'), account('b', 'amex', 'casey', '0002')];
  const owners = new Map(accounts.map((item) => [item.id, item.owner]));
  const data: Row[] = [
    ...(options.data ?? [
      ['a', '2026-10-02', 8_450, 'SAMPLE GROCER', 'Groceries'],
      ['a', '2026-10-05', 412_399, ONLINE, WHOLESALE],
      ['b', '2026-10-08', 250_099, 'WALMART.COM 800-555-0100 AR', INTERNET],
      ['b', '2026-10-09', 3_150, 'SAMPLE BISTRO', 'Dining'],
      ['a', '2026-10-10', -100_000, 'AUTOPAY PAYMENT THANK YOU', null, 'payment'],
    ] satisfies Row[]),
    ...(options.extra ?? []),
  ];
  const toRow = ([card, transactionDate, amountMinor, description, issuerCategory, kind = 'purchase', more = {}]: Row, index: number): CardTransaction => ({
    id: `card-txn-${'abcdefghijklmnop'[index].repeat(32)}`,
    cardAccountId: `card-acct-${card.repeat(32)}`, source: 'e2e-sync', fingerprint: `e2e-counts-${index}`, transactionDate, postedDate: transactionDate,
    status: more.status ?? 'posted', amountMinor, currency: 'USD', kind, description,
    ...(issuerCategory ? { issuerCategory } : {}), ...(more.userCategory ? { userCategory: more.userCategory } : {}), createdAt: AT, updatedAt: AT,
  });
  const rows: CardTransaction[] = data.map(toRow);
  const patches: Array<{ id: string; userCategory: unknown }> = [];
  const ruleItems: CardSpendingRule[] = [...(options.rules?.made ?? [])];
  const ruleBodies: unknown[] = [];
  /** The API's preview match for a candidate rule over the rows as they are now. */
  const matchOf = (candidate: { merchantClass: CardMetalsMerchantClass; currency: string; minAmountMinor: number }) => {
    const preview = previewCardSpendingRule(rows, ruleItems, candidate);
    const parts = ['holdr.card-spending-rule-preview', 1, candidate.merchantClass, candidate.currency, candidate.minAmountMinor,
      preview.amounts.count, preview.amounts.netMinor, preview.rowIds];
    const { rowIds: _rowIds, ...figures } = preview;
    return { ...figures, match: { count: preview.amounts.count, netMinor: preview.amounts.netMinor,
      digest: `srp1:${toLetterHex(createHash('sha256').update(JSON.stringify(parts), 'utf8').digest())}` } };
  };

  return page.route((url) => /^\/(?:card-accounts|card-imports|card-transactions|spending)(?:[/?]|$)/.test(url.pathname), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const param = (name: string) => url.searchParams.get(name) ?? undefined;
    const inRange = rows.filter((row) => row.transactionDate >= (param('from') ?? '0000-01-01') && row.transactionDate <= (param('to') ?? '9999-12-31'));
    const exclusions = resolveCardSpendingExclusions(rows, ruleItems);
    const view = (row: CardTransaction) => withCardSpendingExclusion(toCardTransactionView(row), exclusions.get(row.id));
    let body: unknown = null;
    let code = 200;
    const one = /^\/card-transactions\/([^/]+)$/.exec(url.pathname);
    if (one && request.method() === 'PATCH') {
      const row = rows.find((item) => item.id === decodeURIComponent(one[1]))!;
      if (options.refuse?.has(row.id)) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic refusal' }) });
      }
      const change = JSON.parse(request.postData() ?? '{}') as { userCategory?: string | null };
      patches.push({ id: row.id, userCategory: change.userCategory });
      if (change.userCategory) row.userCategory = change.userCategory;
      else delete row.userCategory;
      body = withCardSpendingExclusion(toCardTransactionView(row), resolveCardSpendingExclusions(rows, ruleItems).get(row.id));
    } else if (one) {
      const row = rows.find((item) => item.id === decodeURIComponent(one[1]));
      if (row) body = { transaction: view(row), cardAccount: accounts.find((item) => item.id === row.cardAccountId) ?? null, importBatch: null, possiblyPostedAs: [], possiblyPaidFrom: [] };
    }
    if (url.pathname === '/spending/rules/preview') {
      const minAmountMinor = Number(param('minAmountMinor'));
      await options.rules?.hold?.(minAmountMinor);
      body = { preview: matchOf({ merchantClass: param('merchantClass') as CardMetalsMerchantClass, currency: param('currency') ?? 'USD', minAmountMinor }) };
    }
    if (url.pathname === '/spending/rules' && request.method() === 'POST') {
      const posted = JSON.parse(request.postData() ?? '{}') as { merchantClass: CardMetalsMerchantClass; currency: string; minAmountMinor: number; preview: unknown };
      ruleBodies.push(posted);
      const { preview: seen, ...fields } = posted;
      if (!options.rules?.installed) {
        code = 409;
        body = { error: 'owner spending rules are not installed on this Holdr' };
      } else if (JSON.stringify(seen) !== JSON.stringify(matchOf(fields).match)) {
        code = 409;
        body = { error: 'this rule would now take out other charges than its preview showed; preview it again', reason: 'preview-stale' };
      } else {
        const rule: CardSpendingRule = {
          id: `csr_${'abcdefghijklmnop'[ruleItems.length].repeat(32)}`, reason: 'asset-purchase', category: 'Precious metals', ...fields,
          createdAt: AT, revokedAt: null,
        };
        ruleItems.push(rule);
        code = 201;
        body = { rule };
      }
    }
    if (url.pathname === '/card-accounts') body = { cardAccounts: accounts };
    if (url.pathname === '/spending/coverage') body = { cards: [] };
    if (url.pathname === '/spending/summary') body = { ...summarizeCardSpending(inRange, { owners, exclusions }), categories: [] };
    if (url.pathname === '/spending/insights') {
      body = computeCardInsights(rows, { month: param('month') ?? '2026-10', today: param('today') ?? '2026-10-16', currency: 'USD', exclusions });
    }
    if (url.pathname === '/spending/accounting') {
      const ids = new Set(inRange.map((row) => row.id));
      const suggestions = suggestCardAssetPurchases(rows, exclusions).filter((item) => ids.has(item.id));
      const byId = new Map(rows.map((row) => [row.id, row]));
      const merchant = (row: CardTransaction) => ({
        description: row.description, merchantName: effectiveCardMerchant(row), merchantKey: cardMerchantKey(effectiveCardMerchant(row)),
      });
      body = {
        accounting: buildCardSpendingAccounting(inRange, { exclusions, suggestions }),
        suggestions: suggestions.map((item) => {
          const row = byId.get(item.id)!;
          return { ...item, ...merchant(row), category: row.userCategory ?? row.issuerCategory ?? 'Uncategorized' };
        }),
        assetPurchases: inRange.filter((row) => exclusions.has(row.id)).map((row) => ({
          id: row.id, kind: row.kind, status: row.status, transactionDate: row.transactionDate, amountMinor: row.amountMinor,
          currency: row.currency, cardAccountId: row.cardAccountId, ...merchant(row), category: row.userCategory ?? 'Uncategorized',
          spendingCategory: row.issuerCategory ?? 'Uncategorized', exclusion: exclusions.get(row.id),
        })),
        rules: {
          installed: options.rules?.installed ?? false,
          items: ruleItems.map((rule) => {
            const covered = rows.filter((row) => exclusions.get(row.id)?.ruleId === rule.id);
            return { ...rule, covers: { purchases: covered.length, refunds: 0, netMinor: covered.reduce((sum, row) => sum + row.amountMinor, 0) } };
          }),
        },
      };
    }
    if (url.pathname === '/card-transactions') {
      const status = param('status');
      const listed = inRange.filter((row) => !status || row.status === status).sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
      body = { transactions: listed.map(view), total: listed.length, limit: 100, offset: 0, nextOffset: null };
    }
    return route.fulfill(body === null
      ? { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) }
      : { status: code, contentType: 'application/json', body: JSON.stringify(body) });
  }).then(() => ({
    patches,
    ruleBodies,
    /** A row imported after the page read the rows: what a rule takes out changes. */
    add: (extra: Row) => { rows.push(toRow(extra, rows.length)); },
  }));
}

const spent = (page: Page) => page.locator('[data-card="spent"] .spending-card-value');
const panel = (page: Page) => page.getByRole('region', { name: 'What counts as spending' });
/** The panel's toggle: its title. */
const toggle = (page: Page) => panel(page).getByRole('button', { name: 'What counts', exact: true });
const statement = (page: Page) => panel(page).getByTestId('reconciliation');

/** An amount as shown ("$6,740.98", "−$1,000.00"), in cents. */
function cents(text: string): number {
  const sign = /^[−-]/.test(text) ? -1 : 1;
  return sign * Math.round(Number(text.replace(/[^0-9.]/g, '')) * 100);
}

/** The statement as shown: each line's key, its label (without the note under it) and its figure, the total last. */
function statementLines(page: Page): Promise<Array<[string, string, string]>> {
  return statement(page).locator('.what-counts-row').evaluateAll((rows) => rows.map((row) => [
    row.getAttribute('data-row') ?? '',
    (row.querySelector('.what-counts-label')?.firstChild?.textContent ?? '').trim(),
    (row.querySelector('.what-counts-figure')?.textContent ?? '').trim(),
  ] as [string, string, string]));
}

/** The lines add up to the total, to the cent, and the total is the activity expected; nothing is an equation. */
async function expectTiesOut(page: Page, activityCents: number) {
  const lines = await statementLines(page);
  const total = lines.at(-1)!;
  expect(total.slice(0, 2), 'the last line is all card activity').toEqual(['activity', 'All card activity']);
  expect(lines.slice(0, -1).reduce((sum, [, , figure]) => sum + cents(figure), 0), 'the lines add up to the total').toBe(cents(total[2]));
  expect(cents(total[2]), 'the total is the card activity').toBe(activityCents);
  await expect(statement(page)).not.toContainText('=');
  await expect(statement(page)).not.toContainText('+');
}

/** Opens the spending tab on the fixed day. */
async function openSpending(page: Page) {
  await page.clock.setFixedTime(new Date('2026-10-16T12:00:00'));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Spending', exact: true }).click();
}

/**
 * Every text in a region meets the reading floors: 14px for every text, the tier badge included (status, not a
 * secondary badge), 16px for reading text (a statement line, a merchant, an amount, a sentence, an error), the title
 * 18px (20px from 1280px wide), and every one at line-height 1.5. What was measured, so a state cannot pass by measuring
 * nothing, and a test can check what was read as reading text.
 */
async function expectReadable(region: Locator, width: number, state: string): Promise<Array<{ where: string; reading: boolean }>> {
  const texts = await region.evaluate((root) => {
    const READING = '.what-counts-row, .what-counts-group-head, .what-counts-lede, .what-counts-compact, .spending-row-merchant, '
      + '.spending-what-counts-amount, .spending-error, .spending-what-counts-queue h4, .spending-what-counts-rule p, '
      + '.spending-what-counts-rules li > span, .what-counts-rules-fold > .fold-toggle';
    // A row's whole line is one button that opens it; its merchant and amount are reading text, not an action's label.
    const HELP = '.what-counts-note, .spending-muted, .spending-row-description, .spending-row-date, .spending-row-original, '
      + '.spending-badge, button:not(.fold-toggle, .spending-what-counts-open), select, input, .what-counts-help';
    const found: Array<{ text: string; size: number; leading: number; where: string; reading: boolean; title: boolean }> = [];
    for (const element of root.querySelectorAll('*')) {
      const own = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join('').trim();
      if (!own) continue;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
      const size = parseFloat(style.fontSize);
      found.push({
        text: own.slice(0, 48), size, leading: parseFloat(style.lineHeight) / size,
        where: `<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}">`,
        reading: element.closest(READING) !== null && element.closest(HELP) === null,
        title: element.closest('h3') !== null,
      });
    }
    return found;
  });
  for (const item of texts) {
    const where = `${state}, ${width}px: ${item.where} "${item.text}"`;
    expect(item.size, where).toBeGreaterThanOrEqual(14);
    if (item.reading) expect(item.size, where).toBeGreaterThanOrEqual(16);
    if (item.title) expect(item.size, where).toBeGreaterThanOrEqual(width >= 1280 ? 20 : 18);
    // "normal" is no number: it fails here too.
    expect(item.leading, `${where} line-height`).toBeGreaterThanOrEqual(1.49);
  }
  return texts.map(({ where, reading }) => ({ where, reading }));
}

test.describe('Spending tab (what counts as spending)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('a possible precious-metals charge counts until the owner decides, and the total says what is waiting', async ({ page }) => {
    const { patches } = await serveSpending(page);
    await openSpending(page);

    // Everything counts until the owner says otherwise; the total says what is waiting, and the total without it.
    await expect(spent(page)).toHaveText('$6,740.98');
    await expect(page.getByTestId('possible-metals')).toHaveText(
      '$6,624.98 possibly precious metals awaiting your confirmation · $116.00 without them',
    );
    // Folded, the panel is one line: what waits, and Review. Nothing of the statement yet.
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page).getByTestId('what-counts-compact')).toHaveText(
      'To confirm (2) Possibly precious metals, counted as spending until you decide. Review',
    );
    await expect(statement(page)).toHaveCount(0);
    await panel(page).getByRole('button', { name: 'Review 2 to confirm' }).click();
    // Review opens the panel at what waits: it comes first, and has focus.
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    const queue = panel(page).getByRole('group', { name: 'To confirm (2)' });
    await expect(queue.getByRole('heading', { name: 'To confirm (2)' })).toBeFocused();
    await expect(panel(page).locator('.what-counts-body > *').first()).toHaveClass(/spending-what-counts-queue/);
    await expect(queue.getByTestId('queue-effect')).toHaveText(
      'Possibly precious metals, counted as spending until you decide. Confirming both takes $6,624.98 out of spending.',
    );
    await expect(queue.getByRole('listitem')).toHaveCount(2);
    // The card activity in words: what counts, what does not, each with its signed amount, adding up to all of it.
    await expect.poll(() => statementLines(page)).toEqual([
      ['spending-charges', 'Charges', '$6,740.98'],
      ['transfers', 'Card payments', '−$1,000.00'],
      ['activity', 'All card activity', '$5,740.98'],
    ]);
    await expect(statement(page).getByRole('group', { name: 'Counted as spending' })).toContainText('Charges $6,740.98');
    await expect(statement(page).getByRole('group', { name: 'Not counted' })).toContainText('Card payments −$1,000.00');
    await expectTiesOut(page, 574_098);
    const list = page.getByRole('region', { name: 'Card transactions' });
    await expect(list.getByText('Possibly precious metals?')).toHaveCount(2);

    // The owner's word: the Costco.com order is precious metals. It leaves spending and is said apart; all card activity
    // is what it was.
    await queue.locator('li', { hasText: 'COSTCO.COM' }).getByRole('button', { name: 'Precious metals' }).click();
    await expect(spent(page)).toHaveText('$2,616.99');
    await expect(page.getByTestId('metals-not-counted')).toHaveText('$4,123.99 precious metals bought · not counted');
    await expect(panel(page).getByTestId('asset-total')).toContainText('$4,123.99');
    await expect.poll(() => statementLines(page)).toEqual([
      ['spending-charges', 'Charges', '$2,616.99'],
      ['asset-charges', 'Precious metals bought', '$4,123.99'],
      ['transfers', 'Card payments', '−$1,000.00'],
      ['activity', 'All card activity', '$5,740.98'],
    ]);
    await expect(panel(page).getByTestId('asset-total')).toContainText('An asset, not spending · Show the 1');
    await expectTiesOut(page, 574_098);
    const waiting = panel(page).getByRole('group', { name: 'To confirm (1)' });
    await expect(waiting.getByRole('listitem')).toHaveCount(1);
    await expect(list.getByText('Precious metals · not spending')).toHaveCount(1);

    // Not metals: the Walmart.com order stays spending, filed under the category it was shown under, and is not asked again.
    await waiting.locator('li', { hasText: 'WALMART.COM' }).getByRole('button', { name: 'Not metals' }).click();
    await expect(panel(page).getByRole('group', { name: /^To confirm/ })).toHaveCount(0);
    await expect(page.getByTestId('possible-metals')).toHaveCount(0);
    await expect(spent(page)).toHaveText('$2,616.99');
    await expectTiesOut(page, 574_098);
    // Folded again, it says nothing waits.
    await toggle(page).click();
    await expect(panel(page).getByTestId('what-counts-compact')).toHaveText('Nothing to confirm');
    await expect(statement(page)).toHaveCount(0);
    expect(patches).toEqual([
      { id: `card-txn-${'b'.repeat(32)}`, userCategory: 'Precious metals' },
      { id: `card-txn-${'c'.repeat(32)}`, userCategory: INTERNET },
    ]);
  });

  test('a net refund and a negative part: every line keeps its sign, refunds apart, and they tie out to all card activity', async ({ page }) => {
    // October: a small charge and a larger refund (spending is negative), a refund the owner filed as precious metals
    // for a September purchase (a negative part), a cash advance, a card payment, and one charge still pending.
    await serveSpending(page, {
      data: [
        ['b', '2026-09-20', 98_000, 'SAMPLE COIN SHOP', null, 'purchase', { userCategory: 'Precious metals' }],
        ['a', '2026-10-02', 3_150, 'SAMPLE BISTRO', 'Dining'],
        ['a', '2026-10-06', -20_000, 'SAMPLE OUTFITTER', 'Shopping', 'refund'],
        ['b', '2026-10-07', -98_000, 'SAMPLE COIN SHOP', null, 'refund', { userCategory: 'Precious metals' }],
        ['b', '2026-10-09', 20_000, 'SAMPLE CASH ADVANCE', null, 'other'],
        ['a', '2026-10-10', -50_000, 'AUTOPAY PAYMENT THANK YOU', null, 'payment'],
        ['a', '2026-10-15', 4_200, 'SAMPLE PHARMACY', 'Health', 'purchase', { status: 'pending' }],
      ],
    });
    await openSpending(page);
    await expect(panel(page).getByTestId('what-counts-compact')).toHaveText('Nothing to confirm');
    await toggle(page).click();
    await expect.poll(() => statementLines(page)).toEqual([
      ['spending-charges', 'Charges', '$31.50'],
      ['spending-credits', 'Refunds and credits', '−$200.00'],
      ['asset-credits', 'Precious metals refunds and credits', '−$980.00'],
      ['other', 'Other (cash advances and the like)', '$200.00'],
      ['transfers', 'Card payments', '−$500.00'],
      ['activity', 'All card activity', '−$1,448.50'],
    ]);
    // October's posted rows, to the cent: 31.50 − 200.00 − 980.00 + 200.00 − 500.00. September's purchase and the
    // pending charge are in none of the figures, and the pending one is said.
    await expectTiesOut(page, 3_150 - 20_000 - 98_000 + 20_000 - 50_000);
    const counted = statement(page).getByRole('group', { name: 'Counted as spending' });
    await expect(counted.locator('.what-counts-row')).toHaveCount(2);
    await expect(statement(page)).toContainText('1 pending transaction is not in these figures until it posts.');
    // The precious-metals line opens its row, said as the owner filed it.
    await statement(page).getByRole('button', { name: 'Show the 1' }).click();
    const metals = statement(page).getByRole('list', { name: 'Precious metals, not counted' });
    await expect(metals.getByRole('listitem')).toHaveCount(1);
    await expect(metals).toContainText(/sample coin shop/i);
    await expect(metals).toContainText('−$980.00');
    await expect(metals).toContainText('Precious metals · your category');
  });

  test('the panel opens and folds from its title, from the keyboard, and when something moves focus to it', async ({ page }) => {
    await serveSpending(page);
    await openSpending(page);
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await toggle(page).focus();
    await page.keyboard.press('Enter');
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(statement(page)).toBeVisible();
    await page.keyboard.press('Space');
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(statement(page)).toHaveCount(0);
    // Another part of the page sends focus here (the overview's Excluded chip does): the panel opens.
    await panel(page).evaluate((element) => { element.setAttribute('tabindex', '-1'); (element as HTMLElement).focus(); });
    await expect(panel(page)).toBeFocused();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(statement(page)).toBeVisible();
  });

  test('a confirmation the server refuses stays said, and what was saved is shown', async ({ page }) => {
    const { patches } = await serveSpending(page, { refuse: new Set([`card-txn-${'c'.repeat(32)}`]) });
    await openSpending(page);
    await expect(spent(page)).toHaveText('$6,740.98');

    await panel(page).getByRole('button', { name: 'Review 2 to confirm' }).click();
    await panel(page).getByRole('button', { name: 'Confirm all 2 charges shown as precious metals' }).click();
    // The first was saved and counts as metals; the second was refused, and the refusal outlasts the refresh.
    await expect(spent(page)).toHaveText('$2,616.99');
    await expect(panel(page).getByRole('alert')).toHaveText('Saved 1 of 2; the rest were not changed: synthetic refusal');
    await expect(panel(page).getByRole('group', { name: /^To confirm/ }).getByRole('listitem')).toHaveCount(1);
    await expectTiesOut(page, 574_098);
    // Folded, the refusal is still said.
    await toggle(page).click();
    await expect(panel(page).getByRole('alert')).toHaveText('Saved 1 of 2; the rest were not changed: synthetic refusal');
    expect(patches).toEqual([{ id: `card-txn-${'b'.repeat(32)}`, userCategory: 'Precious metals' }]);
  });

  test('a rule is made only from the preview of the minimum on screen: an earlier preview answering late is dropped', async ({ page }) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const server = await serveSpending(page, {
      rules: { installed: true, hold: (minAmountMinor) => (minAmountMinor === 600_000 ? held : Promise.resolve()) },
      extra: [['a', '2026-10-11', 600_001, ONLINE, WHOLESALE], ['a', '2026-10-12', 120_001, ONLINE, WHOLESALE]],
    });
    await openSpending(page);
    await panel(page).getByRole('button', { name: 'Review 4 to confirm' }).click();
    await panel(page).getByRole('button', { name: 'Make it a rule for future charges…' }).click();
    const editor = panel(page).getByRole('group', { name: 'Make it a rule' });
    const make = editor.getByRole('button', { name: 'Make this my rule' });

    await editor.getByLabel('Minimum amount').fill('6000');
    await editor.getByRole('button', { name: 'Preview' }).click();
    await expect(editor.getByTestId('rule-previewing')).toBeVisible();
    await expect(make).toBeDisabled();
    // The owner changes the minimum while that preview is on its way; then its answer arrives, late.
    await editor.getByLabel('Minimum amount').fill('1000');
    const late = page.waitForResponse((response) => response.url().includes('minAmountMinor=600000'));
    release();
    await late;
    // The page has had the late answer: it shows nothing of it, and nothing can be made from it.
    await page.waitForTimeout(250);
    await expect(editor.getByTestId('rule-preview')).toHaveCount(0);
    await expect(make).toBeDisabled();

    // A preview of the minimum on screen, and only then the rule, bound to that preview. The rule just made is shown.
    await editor.getByRole('button', { name: 'Preview' }).click();
    await expect(editor.getByTestId('rule-preview')).toContainText('Takes $11,324.01 out of spending: 3 charges');
    await expect(make).toBeEnabled();
    await make.click();
    await expect(panel(page).getByRole('button', { name: 'Your rules (1)' })).toHaveAttribute('aria-expanded', 'true');
    await expect(panel(page).getByRole('list', { name: 'Your rules' })).toContainText('Costco.com charges of $1,000.00 or more are precious metals');
    expect(server.ruleBodies).toEqual([{
      merchantClass: 'costco-online', currency: 'USD', minAmountMinor: 100_000,
      preview: { count: 3, netMinor: 1_132_401, digest: expect.stringMatching(/^srp1:[a-p]{64}$/) },
    }]);
  });

  test('a rule whose charges changed since its preview is refused, said, and made only after a new preview', async ({ page }) => {
    const server = await serveSpending(page, { rules: { installed: true }, extra: [['a', '2026-10-11', 600_001, ONLINE, WHOLESALE]] });
    await openSpending(page);
    await panel(page).getByRole('button', { name: 'Review 3 to confirm' }).click();
    await panel(page).getByRole('button', { name: 'Make it a rule for future charges…' }).click();
    const editor = panel(page).getByRole('group', { name: 'Make it a rule' });
    const make = editor.getByRole('button', { name: 'Make this my rule' });
    await editor.getByLabel('Minimum amount').fill('1000');
    await editor.getByRole('button', { name: 'Preview' }).click();
    await expect(editor.getByTestId('rule-preview')).toContainText('Takes $10,124.00 out of spending: 2 charges');

    // A covered charge arrives after the preview: the rule would take out more than the owner saw.
    server.add(['a', '2026-10-13', 130_001, ONLINE, WHOLESALE]);
    await make.click();
    await expect(panel(page).getByRole('alert')).toHaveText('this rule would now take out other charges than its preview showed; preview it again');
    await expect(editor.getByTestId('rule-preview')).toHaveCount(0);
    await expect(make).toBeDisabled();
    await expect(panel(page).getByRole('list', { name: 'Your rules' })).toHaveCount(0);

    await editor.getByRole('button', { name: 'Preview' }).click();
    await expect(editor.getByTestId('rule-preview')).toContainText('Takes $11,424.01 out of spending: 3 charges');
    await make.click();
    await expect(panel(page).getByRole('list', { name: 'Your rules' })).toContainText('Costco.com charges of $1,000.00 or more are precious metals');
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    expect(server.ruleBodies.map((body) => (body as { preview: { count: number; netMinor: number } }).preview))
      .toEqual([expect.objectContaining({ count: 2, netMinor: 1_012_400 }), expect.objectContaining({ count: 3, netMinor: 1_142_401 })]);
  });

  test('the owner\'s rules are folded under their count, and open to show each with Remove', async ({ page }) => {
    const rule: CardSpendingRule = {
      id: `csr_${'z'.repeat(32)}`, reason: 'asset-purchase', category: 'Precious metals', merchantClass: 'walmart-online', currency: 'USD',
      minAmountMinor: 200_000, createdAt: AT, revokedAt: null,
    };
    await serveSpending(page, { rules: { installed: true, made: [rule] } });
    await openSpending(page);
    // The rule took the Walmart.com order out: one charge waits, and the statement says the metals apart.
    await panel(page).getByRole('button', { name: 'Review 1 to confirm' }).click();
    await expect.poll(() => statementLines(page)).toEqual([
      ['spending-charges', 'Charges', '$4,239.99'],
      ['asset-charges', 'Precious metals bought', '$2,500.99'],
      ['transfers', 'Card payments', '−$1,000.00'],
      ['activity', 'All card activity', '$5,740.98'],
    ]);
    await expectTiesOut(page, 574_098);
    const rules = panel(page).getByRole('button', { name: 'Your rules (1)' });
    await expect(rules).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page).getByRole('list', { name: 'Your rules' })).toHaveCount(0);
    // Last: after what waits and the statement.
    await expect(panel(page).locator('.what-counts-body > *').last()).toHaveClass(/what-counts-rules-fold/);
    await rules.click();
    const list = panel(page).getByRole('list', { name: 'Your rules' });
    await expect(list).toContainText('Walmart.com charges of $2,000.00 or more are precious metals');
    await expect(list).toContainText('takes out 1 charge ($2,500.99)');
    await expect(list.getByRole('button', { name: 'Remove rule' })).toBeEnabled();
  });
});

test.describe('What counts, readable from a phone to a wide screen', () => {
  for (const width of [375, 1920]) {
    test(`every text meets the reading floors at ${width}px: folded, open, empty and refused`, async ({ page }) => {
      const rule: CardSpendingRule = {
        id: `csr_${'y'.repeat(32)}`, reason: 'asset-purchase', category: 'Precious metals', merchantClass: 'costco-online', currency: 'USD',
        minAmountMinor: 900_000, createdAt: AT, revokedAt: null,
      };
      await page.setViewportSize({ width, height: 900 });
      await serveSpending(page, {
        rules: { installed: true, made: [rule] },
        refuse: new Set([`card-txn-${'c'.repeat(32)}`]),
        extra: [['a', '2026-10-04', -1_250, 'SAMPLE GROCER', 'Groceries', 'refund'], ['b', '2026-10-03', 125_000, 'SAMPLE COIN SHOP', null, 'purchase', { userCategory: 'Precious metals' }]],
      });
      await openSpending(page);
      expect((await expectReadable(panel(page), width, 'folded')).length).toBeGreaterThanOrEqual(4);
      await panel(page).getByRole('button', { name: 'Review 2 to confirm' }).click();
      await panel(page).getByRole('button', { name: 'Make it a rule for future charges…' }).click();
      await statement(page).getByRole('button', { name: 'Show the 1' }).click();
      await panel(page).getByRole('button', { name: 'Your rules (1)' }).click();
      await expect(panel(page).getByRole('list', { name: 'Your rules' })).toBeVisible();
      const open = await expectReadable(panel(page), width, 'open');
      expect(open.length).toBeGreaterThanOrEqual(40);
      // Measured as reading text (16px): each row's merchant and amount, the waiting ones' and the precious metals' alike,
      // and the statement's labels and figures.
      const read = (pattern: RegExp) => open.filter((item) => item.reading && pattern.test(item.where)).length;
      expect(read(/spending-row-merchant/), 'merchants read at 16px').toBe(3);
      expect(read(/spending-what-counts-amount/), 'amounts read at 16px').toBe(3);
      const lineTexts = open.filter((item) => /what-counts-label|what-counts-figure/.test(item.where));
      expect(lineTexts, 'statement labels and figures, all read at 16px').toEqual(
        Array.from({ length: 10 }, (_, index) => ({
          where: index % 2 === 0 ? '<span class="what-counts-label">' : '<span class="what-counts-figure num">', reading: true,
        })),
      );
      // Refused: the error reads like the rest.
      await panel(page).getByRole('group', { name: /^To confirm/ }).locator('li', { hasText: 'WALMART.COM' }).getByRole('button', { name: 'Precious metals' }).click();
      await expect(panel(page).getByRole('alert')).toHaveText('synthetic refusal');
      const refused = await expectReadable(panel(page), width, 'refused');
      expect(refused.length).toBeGreaterThanOrEqual(40);
      expect(refused.filter((item) => item.reading && /spending-error/.test(item.where)), 'the error reads at 16px').toHaveLength(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${width}px overflow`).toBeLessThanOrEqual(0);
    });

    test(`with no posted activity, the panel says so in readable type at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await serveSpending(page, { data: [['a', '2026-10-15', 4_200, 'SAMPLE PHARMACY', 'Health', 'purchase', { status: 'pending' }]] });
      await openSpending(page);
      await expect(panel(page).getByTestId('what-counts-compact')).toHaveText('Nothing to confirm');
      expect((await expectReadable(panel(page), width, 'empty, folded')).length).toBeGreaterThanOrEqual(3);
      await toggle(page).click();
      // Not a figure of nothing: no lines, no total; the pending charge is said.
      await expect(statement(page).locator('.what-counts-lede')).toHaveText('No posted card activity in October 2026.');
      await expect(statement(page).locator('.what-counts-help')).toHaveText('1 pending transaction is not in these figures until it posts.');
      await expect(statement(page).locator('.what-counts-row')).toHaveCount(0);
      expect((await expectReadable(panel(page), width, 'empty, open')).length).toBeGreaterThanOrEqual(4);
    });
  }
});

test.describe('What counts rows, from a phone to a wide screen', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('each waiting charge keeps its date, merchant and amount on one line, its text readable and never cut mid-word', async ({ page }) => {
    // Beside the fake's own two charges, a fictional dealer with a long descriptor.
    await serveSpending(page, { extra: [['b', '2026-10-07', 98_765, 'NORTHWIND PRECIOUS METALS EXCHANGE DEPOT SAMPLETOWN WA', INTERNET]] });
    await openSpending(page);
    await panel(page).getByRole('button', { name: 'Review 3 to confirm' }).click();
    const rows = panel(page).getByRole('group', { name: /^To confirm/ }).locator('.spending-what-counts-item');
    await expect(rows).toHaveCount(3);
    for (const width of [320, 375, 768, 1000, 1001, 1280, 1920, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await rows.evaluateAll((items) => items.map((item) => {
        const box = (selector: string) => item.querySelector(selector)!.getBoundingClientRect();
        const date = box('.spending-row-date');
        const merchant = box('.spending-row-merchant');
        const text = box('.spending-what-counts-text');
        const amount = box('.spending-what-counts-amount');
        const badge = box('.spending-badge');
        // A word cut across lines: one word's range with boxes on two lines. A hyphen or slash is a word's end (a line may
        // break after one), so "800-555-0100" is three words.
        const broken: string[] = [];
        for (const element of item.querySelectorAll('.spending-row-merchant, .spending-row-description')) {
          const node = element.firstChild;
          if (!node || node.nodeType !== Node.TEXT_NODE) continue;
          for (const word of (node.textContent ?? '').matchAll(/[^\s\-\u2010-\u2014/]+/g)) {
            const range = document.createRange();
            range.setStart(node, word.index!);
            range.setEnd(node, word.index! + word[0].length);
            if (new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))).size > 1) broken.push(word[0]);
          }
        }
        return {
          dateTop: date.top, dateRight: date.right, merchantTop: merchant.top, merchantLeft: merchant.left, textWidth: text.width,
          textRight: text.right, amountTop: amount.top, amountLeft: amount.left, amountRight: amount.right, badgeWidth: badge.width, broken,
        };
      }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${width}px overflow`).toBeLessThanOrEqual(0);
      for (const row of layout) {
        // One line: the date and the amount start where the merchant does, the date to its left and the amount to its right.
        expect(Math.abs(row.dateTop - row.merchantTop), `${width}px date`).toBeLessThanOrEqual(4);
        expect(Math.abs(row.amountTop - row.merchantTop), `${width}px amount`).toBeLessThanOrEqual(4);
        expect(row.dateRight, `${width}px date`).toBeLessThanOrEqual(row.merchantLeft);
        expect(row.amountLeft, `${width}px amount`).toBeGreaterThanOrEqual(row.textRight);
        // A readable column, never a few letters wide, with no word cut across lines; the tier shows at every width.
        expect(row.textWidth, `${width}px text`).toBeGreaterThanOrEqual(width < 400 ? 100 : 190);
        expect(row.broken, `${width}px`).toEqual([]);
        expect(row.badgeWidth, `${width}px tier`).toBeGreaterThan(0);
      }
      // Wide panels share one set of columns: the amounts end on one line down the list.
      if (width >= 1001) expect(new Set(layout.map((row) => Math.round(row.amountRight))).size, `${width}px amounts`).toBe(1);
    }
  });
});