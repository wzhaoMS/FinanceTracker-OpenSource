import { expect, test, type Locator, type Page } from './fixtures';
import {
  buildCardSpendingAccounting,
  computeCardInsights,
  summarizeCardSpending,
  toCardTransactionView,
  type CardAccount,
  type CardTransaction,
} from '@finance-tracker/shared';

/**
 * Card payments and the checking withdrawals (debits) that paid them, in the page: the Spending tab's panel is compact
 * until asked, its headline the next action counted in payments ("3 payments to review"); Review lists the groups
 * held for the owner's word, each counted by what it holds, and what is left on either side with why; Details says
 * where every posted payment stands (matched only when matched), with the settled pairs, the checking coverage and the
 * owner's answers; a payment's details say where it stands. The owner's answers go to the API as they are, and the last
 * one stays in sight with its Undo. The page talks to a fake that answers with synthetic rows (fictional descriptors,
 * made-up amounts and ids) and keeps the owner's answers; the matching itself is the API's and is tested there
 * (routes/cardPaymentReconciliation.test.ts).
 */

const AT = '2026-10-01T00:00:00.000Z';
const id = (prefix: string, letter: string) => `${prefix}${letter.repeat(32)}`;
const AMEX = id('card-acct-', 'a');
const CITI = id('card-acct-', 'b');
const AMEX2 = id('card-acct-', 'c');
const WF = id('chk-acct-', 'a');

const accounts: CardAccount[] = [
  // An Amex shows five digits of its ending (last5); the reconciliation shows four, as everywhere it shows a number.
  { id: AMEX, issuer: 'amex', owner: 'alex', nickname: 'Sample Gold', last4: '0003', last5: '90003', currency: 'USD', status: 'active', createdAt: AT, updatedAt: AT },
  { id: CITI, issuer: 'citi', owner: 'alex', nickname: 'Sample Double', last4: '0022', currency: 'USD', status: 'active', createdAt: AT, updatedAt: AT },
  { id: AMEX2, issuer: 'amex', owner: 'casey', nickname: 'Sample Platinum', last4: '0033', currency: 'USD', status: 'active', createdAt: AT, updatedAt: AT },
];

const row = (letter: string, cardAccountId: string, transactionDate: string, amountMinor: number, description: string, kind: CardTransaction['kind'] = 'payment'): CardTransaction => ({
  id: id('card-txn-', letter), cardAccountId, source: 'e2e-sync', fingerprint: `e2e-payments-${letter}`, transactionDate,
  postedDate: transactionDate, status: 'posted', amountMinor, currency: 'USD', kind, description, createdAt: AT, updatedAt: AT,
});
const rows = [
  row('a', AMEX, '2026-10-02', -50_000, 'AUTOPAY PAYMENT RECEIVED - THANK YOU'),
  row('b', AMEX, '2026-10-06', -30_000, 'ONLINE PAYMENT THANK YOU'),
  row('c', AMEX2, '2026-10-07', -30_000, 'ONLINE PAYMENT THANK YOU'),
  row('d', CITI, '2026-10-09', -9_999, 'ONLINE PAYMENT, THANK YOU'),
  row('e', AMEX, '2026-10-08', 12_345, 'SAMPLE BISTRO', 'purchase'),
];
const payment = (item: CardTransaction) => ({
  id: item.id, cardAccountId: item.cardAccountId, date: item.transactionDate, amountMinor: item.amountMinor, currency: 'USD', description: item.description,
});
const debit = (letter: string, date: string, amountMinor: number, extra: Record<string, unknown>) => ({
  id: id('chk-txn-', letter), checkingAccountId: WF, accountLabel: 'Sample Bank Everyday Checking', date, amountMinor, currency: 'USD', ...extra,
});
const amexDebit = debit('a', '2026-10-03', -50_000, { class: 'card-payment', payee: 'amex', payeeLabel: 'American Express', descriptor: 'AMEX EPAYMENT ACH PMT ***9999 W9999 SAMPLE HOLDER' });
const groupDebit1 = debit('b', '2026-10-07', -30_000, { class: 'card-payment', payee: 'amex', payeeLabel: 'American Express', descriptor: 'AMEX EPAYMENT ACH PMT ***9999 W9999 SAMPLE HOLDER' });
const groupDebit2 = debit('c', '2026-10-08', -30_000, { class: 'card-payment', payee: 'amex', payeeLabel: 'American Express', descriptor: 'AMEX EPAYMENT ACH PMT ***9999 W9999 SAMPLE HOLDER' });
const discover = debit('d', '2026-10-05', -4_000, { class: 'card-payment', payee: 'discover', payeeLabel: 'Discover', descriptor: 'DISCOVER E-PAYMENT ***9999 SAMPLE HOLDER' });
const housing = debit('e', '2026-10-01', -300_000, { class: 'bilt-housing', payee: 'bilt', payeeLabel: 'Bilt', descriptor: 'BILT RENT ACH DEBIT ***9999 SAMPLE HOLDER' });
const citi1 = debit('f', '2026-10-10', -9_999, { class: 'card-payment', payee: 'citi', payeeLabel: 'Citi', descriptor: 'CITI AUTOPAY PAYMENT ***9999 SAMPLE HOLDER' });
const citi2 = debit('g', '2026-10-11', -9_999, { class: 'card-payment', payee: 'citi', payeeLabel: 'Citi', descriptor: 'CITI AUTOPAY PAYMENT ***9999 SAMPLE HOLDER' });

const amount = (count: number, amountMinor: number) => ({ count, amountMinor });
const zero = amount(0, 0);

interface Decision { decision: string; cardTransactionId?: string; checkingTransactionId?: string }

/** The fake's answer: the rules' matches, with the owner's answers applied the way the API applies them. */
function reconciliation(decisions: Decision[]) {
  const confirmed = decisions.find((item) => item.decision === 'confirmed' && item.cardTransactionId === rows[1].id);
  const elsewhere = decisions.some((item) => item.decision === 'elsewhere');
  const notCard = decisions.some((item) => item.decision === 'not-card-payment');
  const settled = confirmed !== undefined;
  const other = confirmed?.checkingTransactionId === groupDebit1.id ? groupDebit2 : groupDebit1;
  return {
    rulesVersion: 1,
    rules: { daysBefore: 5, daysAfter: 5, confirmDays: 15 },
    checking: { installed: true, accounts: [{ id: WF, label: 'Sample Bank Everyday Checking', institution: 'wellsfargo', last4: '0001', currency: 'USD', status: 'active', coverage: [{ start: '2024-09-22', end: '2026-10-15' }] }] },
    decisions: { installed: true, stale: [] },
    totals: [{
      currency: 'USD',
      payments: {
        all: amount(4, -119_999), matched: settled ? amount(2, -80_000) : amount(1, -50_000), confirmed: settled ? amount(1, -30_000) : zero,
        ambiguous: settled ? zero : amount(2, -60_000), unmatched: elsewhere ? zero : amount(1, -9_999), elsewhere: elsewhere ? amount(1, -9_999) : zero,
        pending: zero,
      },
      debits: {
        all: notCard ? amount(3, -110_000) : amount(4, -114_000), matched: settled ? amount(2, -80_000) : amount(1, -50_000),
        confirmed: settled ? amount(1, -30_000) : zero, ambiguous: settled ? zero : amount(2, -60_000),
        unmatched: notCard ? zero : amount(1, -4_000), notCardPayment: notCard ? amount(1, -4_000) : zero, biltHousing: amount(1, -300_000),
      },
    }],
    pairs: [
      { status: 'matched', dayOffset: 1, payment: payment(rows[0]), debit: amexDebit },
      ...(settled ? [
        { status: 'confirmed', dayOffset: confirmed.checkingTransactionId === groupDebit1.id ? 1 : 2, decisionId: id('cpd_', 'a'), payment: payment(rows[1]),
          debit: confirmed.checkingTransactionId === groupDebit1.id ? groupDebit1 : groupDebit2 },
        { status: 'matched', dayOffset: other === groupDebit1 ? 0 : 1, payment: payment(rows[2]), debit: other },
      ] : []),
    ],
    ambiguous: settled ? [] : [{
      id: rows[1].id,
      payments: [payment(rows[1]), payment(rows[2])],
      debits: [groupDebit1, groupDebit2],
      candidates: [
        { paymentId: rows[1].id, debitId: groupDebit1.id, dayOffset: 1 }, { paymentId: rows[1].id, debitId: groupDebit2.id, dayOffset: 2 },
        { paymentId: rows[2].id, debitId: groupDebit1.id, dayOffset: 0 }, { paymentId: rows[2].id, debitId: groupDebit2.id, dayOffset: 1 },
      ],
    }],
    unmatchedPayments: elsewhere ? [] : [{ payment: payment(rows[3]), reason: 'no-checking-debit', possibleDebits: [], brokerageSuggestions: 1 }],
    unmatchedDebits: notCard ? [] : [{ debit: discover, reason: 'no-card-account', possiblePayments: [] }],
    elsewhere: elsewhere ? [{ payment: payment(rows[3]), decisionId: id('cpd_', 'b') }] : [],
    notCardPayments: notCard ? [{ debit: discover, decisionId: id('cpd_', 'c') }] : [],
    biltHousing: [{ debit: housing, reason: 'no-card-account', possiblePayments: [] }],
  };
}

/**
 * Journey 5: 3 payments in 2 groups (2 payments and 2 withdrawals that could pay them; 1 payment and 2 withdrawals),
 * beside 1 matched. Confirming a pairing in the first group settles it (the rules match the rest), as the API does.
 */
function threeInTwo(decisions: Decision[]) {
  const settled = decisions.some((item) => item.decision === 'confirmed' && item.cardTransactionId === rows[1].id);
  const body = reconciliation(decisions);
  return {
    ...body,
    totals: [{
      currency: 'USD',
      payments: {
        all: amount(4, -119_999), matched: settled ? amount(2, -80_000) : amount(1, -50_000), confirmed: settled ? amount(1, -30_000) : zero,
        ambiguous: settled ? amount(1, -9_999) : amount(3, -69_999), unmatched: zero, elsewhere: zero, pending: zero,
      },
      debits: {
        all: amount(5, -129_998), matched: settled ? amount(2, -80_000) : amount(1, -50_000), confirmed: settled ? amount(1, -30_000) : zero,
        ambiguous: settled ? amount(2, -19_998) : amount(4, -79_998), unmatched: zero, notCardPayment: zero, biltHousing: zero,
      },
    }],
    ambiguous: [...body.ambiguous, {
      id: rows[3].id, payments: [payment(rows[3])], debits: [citi1, citi2],
      candidates: [{ paymentId: rows[3].id, debitId: citi1.id, dayOffset: 1 }, { paymentId: rows[3].id, debitId: citi2.id, dayOffset: 2 }],
    }],
    unmatchedPayments: [], unmatchedDebits: [], elsewhere: [], notCardPayments: [], biltHousing: [],
  };
}

/**
 * Nothing left to review: every payment matched; every posted one matched beside a pending one; or two matched beside
 * one paid from another account and one the card took back.
 */
function settledAnswer(kind: 'matched' | 'pending' | 'otherwise') {
  const otherwise = kind === 'otherwise';
  const reversal = { id: id('card-txn-', 'm'), cardAccountId: AMEX, date: '2026-10-09', amountMinor: 30_000, currency: 'USD', description: 'RETURNED PAYMENT' };
  return {
    ...reconciliation([]),
    rules: { daysBefore: 5, daysAfter: 5, confirmDays: 15, returnDays: 30 },
    totals: [{
      currency: 'USD',
      payments: {
        all: otherwise ? amount(4, -119_999) : amount(2, -80_000), matched: amount(2, -80_000), confirmed: zero, ambiguous: zero, unmatched: zero,
        elsewhere: otherwise ? amount(1, -9_999) : zero, returned: otherwise ? amount(1, -30_000) : zero, pending: kind === 'pending' ? amount(1, -12_000) : zero,
      },
      debits: { all: amount(2, -80_000), matched: amount(2, -80_000), confirmed: zero, ambiguous: zero, unmatched: zero, notCardPayment: zero, biltHousing: zero },
    }],
    pairs: [
      { status: 'matched', dayOffset: 1, payment: payment(rows[0]), debit: amexDebit },
      { status: 'matched', dayOffset: 0, payment: payment(rows[2]), debit: groupDebit1 },
    ],
    ambiguous: [], unmatchedPayments: [], unmatchedDebits: [], notCardPayments: [], biltHousing: [],
    elsewhere: otherwise ? [{ payment: payment(rows[3]), decisionId: id('cpd_', 'b') }] : [],
    returned: otherwise ? [{ payment: payment(rows[1]), reversal, dayOffset: 3 }] : [],
  };
}

/** A payment's place for its details, from the answer the panel reads. */
function paymentMatch(paymentId: string, body: ReturnType<typeof reconciliation>) {
  const pair = body.pairs.find((item) => item.payment.id === paymentId);
  if (pair) {
    const evidence = (pair as { evidence?: unknown }).evidence;
    return {
      status: pair.status, debit: { ...pair.debit, dayOffset: pair.dayOffset }, ...('decisionId' in pair ? { decisionId: pair.decisionId } : {}),
      ...(evidence ? { evidence } : {}),
    };
  }
  const group = body.ambiguous.find((item) => item.payments.some((entry) => entry.id === paymentId));
  if (group) {
    return {
      status: 'ambiguous', otherPayments: group.payments.length - 1,
      candidates: group.candidates.filter((item) => item.paymentId === paymentId)
        .map((item) => ({ ...group.debits.find((entry) => entry.id === item.debitId)!, dayOffset: item.dayOffset })),
    };
  }
  // Payments the card took back, and the card's rows offered with a gap, where an answer has them.
  const more = body as unknown as {
    checking: { installed: boolean };
    returned?: Array<{ payment: { id: string }; reversal: object; dayOffset: number }>;
    unmatchedPayments: Array<{ payment: { id: string }; reason: string; possibleReversals?: Array<{ reversal: object; dayOffset: number }> }>;
  };
  const back = more.returned?.find((item) => item.payment.id === paymentId);
  if (back) return { status: 'returned', reversal: { ...back.reversal, dayOffset: back.dayOffset } };
  const gap = more.unmatchedPayments.find((item) => item.payment.id === paymentId);
  const offered = gap?.possibleReversals ? { possibleReversals: gap.possibleReversals.map((item) => ({ ...item.reversal, dayOffset: item.dayOffset })) } : null;
  // Without checking there is no checking side: only what the card's own rows say, as the API answers.
  if (!more.checking.installed) return gap && offered ? { status: 'unmatched', reason: gap.reason, possibleDebits: [], ...offered } : null;
  return { status: 'unmatched', reason: gap?.reason ?? 'no-checking-debit', possibleDebits: [], ...offered };
}

/** With no checking imported: the owner's earlier answers still stand, a stale one and a rejection among them. */
function withoutChecking(decisions: Decision[], undone: string[]) {
  const answers = [
    { id: id('cpd_', 'd'), decision: 'confirmed', createdAt: AT, stale: 'row-missing', payment: payment(rows[0]) },
    { id: id('cpd_', 'e'), decision: 'rejected', createdAt: AT, payment: payment(rows[1]) },
  ].filter((item) => !undone.includes(item.id));
  const elsewhere = decisions.some((item) => item.decision === 'elsewhere') && !undone.includes(id('cpd_', 'b'));
  const unmatched = rows.filter((item) => item.kind === 'payment' && !(elsewhere && item.id === rows[3].id));
  return {
    rulesVersion: 1,
    rules: { daysBefore: 5, daysAfter: 5, confirmDays: 15 },
    checking: { installed: false, accounts: [] },
    decisions: { installed: true, stale: answers.some((item) => item.stale) ? [{ decisionId: id('cpd_', 'd'), reason: 'row-missing' }] : [], answers },
    totals: [{
      currency: 'USD',
      payments: {
        all: amount(4, -119_999), matched: zero, confirmed: zero, ambiguous: zero,
        unmatched: elsewhere ? amount(3, -110_000) : amount(4, -119_999), elsewhere: elsewhere ? amount(1, -9_999) : zero, pending: zero,
      },
      debits: { all: zero, matched: zero, confirmed: zero, ambiguous: zero, unmatched: zero, notCardPayment: zero, biltHousing: zero },
    }],
    pairs: [],
    ambiguous: [],
    unmatchedPayments: unmatched.map((item) => ({ payment: payment(item), reason: 'no-checking-account', possibleDebits: [], brokerageSuggestions: 0 })),
    unmatchedDebits: [],
    elsewhere: elsewhere ? [{ payment: payment(rows[3]), decisionId: id('cpd_', 'b') }] : [],
    notCardPayments: [],
    biltHousing: [],
  };
}

/**
 * Holdr matched the held group from evidence (a payer reference, then what was left), until the owner undoes one of its
 * pairs: then the whole group is the owner's again, without the pair the owner rejected (#231, Root 02:32Z).
 */
function fromEvidence(decisions: Decision[]) {
  const base = reconciliation([]);
  const rejected = decisions.find((item) => item.decision === 'rejected');
  if (rejected) {
    const [group] = base.ambiguous;
    return {
      ...base,
      ambiguous: [{
        ...group,
        candidates: group.candidates.filter((item) => item.paymentId !== rejected.cardTransactionId || item.debitId !== rejected.checkingTransactionId),
      }],
    };
  }
  const [totals] = base.totals;
  return {
    ...base,
    totals: [{
      ...totals,
      payments: { ...totals.payments, matched: amount(3, -110_000), ambiguous: zero },
      debits: { ...totals.debits, matched: amount(3, -110_000), ambiguous: zero },
    }],
    pairs: [
      ...base.pairs,
      { status: 'matched', dayOffset: 1, evidence: { basis: 'reference', proofs: 8 }, payment: payment(rows[1]), debit: groupDebit1 },
      { status: 'matched', dayOffset: 1, evidence: { basis: 'remainder' }, payment: payment(rows[2]), debit: groupDebit2 },
    ],
    ambiguous: [],
  };
}

/** The fake's switches: another answer for the reconciliation, and reads that fail. */
interface Fake {
  answer?: (decisions: Decision[], undone: string[]) => unknown;
  failReads: boolean;
  failMatch: boolean;
}

async function serveSpending(page: Page, options: { answer?: Fake['answer']; accounts?: CardAccount[] } = {}) {
  const cardAccounts = options.accounts ?? accounts;
  const decisions: Decision[] = [];
  const undone: string[] = [];
  const fake: Fake = { answer: options.answer, failReads: false, failMatch: false };
  const answer = () => (fake.answer ? fake.answer(decisions, undone) : reconciliation(decisions));
  const failure = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic read failure' }) };
  await page.route((url) => /^\/(?:card-accounts|card-imports|card-transactions|spending)(?:[/?]|$)/.test(url.pathname), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body: unknown = null;
    let status = 200;
    const one = /^\/card-transactions\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const item = rows.find((entry) => entry.id === decodeURIComponent(one[1]));
      if (item) {
        body = {
          transaction: toCardTransactionView(item), cardAccount: cardAccounts.find((entry) => entry.id === item.cardAccountId) ?? null,
          importBatch: null, possiblyPostedAs: [], possiblyPaidFrom: [],
        };
      }
    }
    const standing = /^\/spending\/payment-reconciliation\/payments\/([^/]+)$/.exec(url.pathname);
    if (standing) {
      if (fake.failMatch) return route.fulfill(failure);
      const item = rows.find((entry) => entry.id === decodeURIComponent(standing[1]));
      if (item) {
        body = {
          checking: { installed: true }, decisions: { installed: true },
          paymentMatch: item.kind === 'payment' ? paymentMatch(item.id, answer() as ReturnType<typeof reconciliation>) : null,
        };
      }
    }
    if (url.pathname === '/card-accounts') body = { cardAccounts };
    if (url.pathname === '/spending/coverage') body = { cards: [] };
    if (url.pathname === '/spending/summary') body = { ...summarizeCardSpending(rows, { owners: new Map(cardAccounts.map((item) => [item.id, item.owner])) }), categories: [] };
    if (url.pathname === '/spending/insights') {
      body = computeCardInsights(rows, { month: url.searchParams.get('month') ?? '2026-10', today: url.searchParams.get('today') ?? '2026-10-16', currency: 'USD' });
    }
    if (url.pathname === '/spending/accounting') {
      body = { accounting: buildCardSpendingAccounting(rows), suggestions: [], assetPurchases: [], rules: { installed: false, items: [] } };
    }
    if (url.pathname === '/card-transactions') {
      const listed = rows.filter((item) => !url.searchParams.get('status') || item.status === url.searchParams.get('status'));
      body = { transactions: listed.map(toCardTransactionView), total: listed.length, limit: 100, offset: 0, nextOffset: null };
    }
    if (url.pathname === '/spending/payment-reconciliation') {
      if (fake.failReads) return route.fulfill(failure);
      body = answer();
    }
    if (url.pathname === '/spending/payment-reconciliation/decisions' && request.method() === 'POST') {
      const posted = JSON.parse(request.postData() ?? '{}') as Decision;
      decisions.push(posted);
      status = 201;
      body = { decision: { id: id('cpd_', 'abc'[decisions.length - 1] ?? 'd'), ...posted, amountMinor: -1, currency: 'USD', createdAt: AT, rulesVersion: 1, revokedAt: null } };
    }
    const undo = /^\/spending\/payment-reconciliation\/decisions\/([^/]+)$/.exec(url.pathname);
    if (undo && request.method() === 'DELETE') {
      const undoneId = decodeURIComponent(undo[1]);
      undone.push(undoneId);
      // The fake's answers carry fixed ids: a, the confirmed pairing; b, paid elsewhere; c, not a card payment.
      const kind = ({ [id('cpd_', 'a')]: 'confirmed', [id('cpd_', 'b')]: 'elsewhere', [id('cpd_', 'c')]: 'not-card-payment' } as Record<string, string>)[undoneId];
      decisions.splice(0, decisions.length, ...decisions.filter((item) => item.decision !== kind));
      body = { decision: { id: undoneId, decision: kind ?? 'confirmed', revokedAt: AT } };
    }
    return route.fulfill(body === null
      ? { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) }
      : { status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { decisions, undone, fake };
}

const panel = (page: Page) => page.getByRole('region', { name: 'Card payments and checking' });

/** Opens one of the panel's two folds when it is closed. */
async function unfold(page: Page, name: 'Review' | 'Details') {
  const toggle = panel(page).getByRole('button', { name, exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

async function openSpending(page: Page) {
  await page.clock.setFixedTime(new Date('2026-10-16T12:00:00'));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Spending', exact: true }).click();
}

/**
 * Every text shown in `root`, with its computed size and what it is: a badge, a row (a payment or withdrawal line, not
 * its masked text), the headline, a heading or an action.
 */
async function textSizes(root: Locator) {
  return root.evaluate((element) => {
    const found: Array<{ text: string; size: number; kind: 'badge' | 'row' | 'read' | 'title' | 'action' | 'help' }> = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? '';
      const parent = node.parentElement;
      if (!text || !parent) continue;
      const box = parent.getBoundingClientRect();
      const style = getComputedStyle(parent);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
      const kind = parent.closest('.spending-badge') ? 'badge'
        : parent.closest('.spending-detail-suggestion-text') ? 'help'
          : parent.closest('.spending-payments-open, .spending-payments-debit') ? 'row'
            : parent.closest('.payments-help, .payments-note, .spending-muted') ? 'help'
              : parent.closest('.payments-headline, .payments-breakdown, .payments-review-count, .payments-block > h4') ? 'read'
                : parent.closest('h3') ? 'title'
                  : parent.closest('button') ? 'action' : 'help';
      found.push({ text: text.slice(0, 50), size: Number.parseFloat(style.fontSize), kind });
    }
    return found;
  });
}

/** The reading floors (plan D1): 16px read, 18px or more for the title, 14px for help, status and actions, the badge too. */
async function expectFloors(root: Locator, where: string) {
  const sizes = await textSizes(root);
  expect(sizes.length, where).toBeGreaterThan(0);
  // "Confirmed by you" is status, not a short secondary badge: 14px like any status text.
  const floor = { badge: 14, help: 14, action: 14, row: 16, read: 16, title: 18 } as const;
  const below = sizes.filter((item) => item.size < floor[item.kind]);
  expect(below, `${where}: text under its floor`).toEqual([]);
}

test.describe('Spending tab (card payments and checking)', () => {
  test('pairs Holdr matched from evidence say why under Review, and Undo hands their group back to the owner (#231)', async ({ page }) => {
    const { decisions } = await serveSpending(page, { answer: fromEvidence });
    await openSpending(page);
    // Matched from evidence: no longer counted as to review; the payment and the withdrawals left over still are.
    await expect(panel(page).getByTestId('payments-headline')).toHaveText('1 payment and 2 withdrawals to review');
    await unfold(page, 'Review');
    const evidence = panel(page).getByTestId('payments-evidence');
    await expect(evidence.getByRole('heading')).toHaveText('Matched by Holdr from evidence: 2 payments');
    // Before any Undo, what it saves (Astra's visual review): the owner's "not this one", which hands the whole group back.
    // The lead claims no single answer: for interchangeable rows, any pairing gives the same result.
    await expect(evidence.getByTestId('payments-evidence-lead')).toHaveText('Holdr matched these by itself, from the evidence shown under each pair. '
      + 'Undo on a pair saves that its withdrawal did not pay its payment and hands the whole group back to you: Holdr then asks which '
      + 'withdrawal paid which payment, without that pairing.');
    await expect(evidence.getByTestId('payments-evidence-why')).toHaveText([
      'Matched: this checking withdrawal carries the same reference as 8 other payments to this card.',
      'Matched: once the pairs matched by reference were taken out of its group, this was the only withdrawal left for it.',
    ]);
    await expect(evidence.getByRole('button', { name: 'Undo' })).toHaveCount(2);
    await expect(panel(page).getByTestId('payments-ambiguous')).toHaveCount(0);

    // A payment's details say the same, with its Undo: the owner's "not this one" for that pair.
    await evidence.getByRole('button', { name: /Oct 6, 2026/ }).click();
    const section = page.getByRole('dialog').getByRole('region', { name: 'Paid from checking' });
    await expect(section.getByTestId('payment-evidence-why')).toHaveText('Matched: this checking withdrawal carries the same reference as 8 other '
      + 'payments to this card. Undo saves that this withdrawal did not pay this payment and hands the whole group back to you: Holdr then '
      + 'asks which withdrawal paid which payment, without this pairing.');
    await section.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => decisions.length).toBe(1);
    expect(decisions[0]).toEqual({ decision: 'rejected', cardTransactionId: rows[1].id, checkingTransactionId: groupDebit1.id });
    await expect(section).toContainText('Paid by this withdrawal?');

    // The panel reads again: the group is the owner's again, without the pair the owner said no to.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(panel(page).getByTestId('payments-evidence')).toHaveCount(0);
    await expect(panel(page).getByTestId('payments-ambiguous').getByRole('button', { name: 'Paid by this withdrawal' })).toHaveCount(3);
  });

  test('the Undo beside a pair Holdr matched from evidence is the owner\'s "not this one", kept in sight with its own Undo (#231)', async ({ page }) => {
    const { decisions } = await serveSpending(page, { answer: fromEvidence });
    await openSpending(page);
    await unfold(page, 'Review');
    await panel(page).getByTestId('payments-evidence').getByRole('button', { name: 'Undo' }).first().click();
    await expect.poll(() => decisions.length).toBe(1);
    expect(decisions[0]).toEqual({ decision: 'rejected', cardTransactionId: rows[1].id, checkingTransactionId: groupDebit1.id });
    // The answer said before the click is the one saved, kept in sight with its own Undo.
    await expect(panel(page).getByTestId('payments-saved'))
      .toHaveText('Saved: the withdrawal on Oct 7, 2026 did not pay the $300.00 payment on Oct 6, 2026. Undo');
    await expect(panel(page).getByTestId('payments-saved').getByRole('button', { name: 'Undo' })).toHaveCount(1);
    await expect(panel(page).getByTestId('payments-evidence')).toHaveCount(0);
    await expect(panel(page).getByTestId('payments-ambiguous').getByRole('button', { name: 'Paid by this withdrawal' })).toHaveCount(3);
    await expect(panel(page).getByTestId('payments-headline')).toHaveText('3 payments and 2 withdrawals to review');
  });

  test.use({ viewport: { width: 1280, height: 900 } });

  test('counts what is left in payments, lists it under Review, sends the owner\'s answers and keeps the last in sight', async ({ page }) => {
    const { decisions } = await serveSpending(page);
    await openSpending(page);

    // Compact: the next action, counted in payments, the withdrawals left over counted apart; the scope; both folds closed.
    await expect(panel(page).getByTestId('payments-headline')).toHaveText('3 payments and 2 withdrawals to review');
    await expect(panel(page).getByTestId('payments-scope')).toHaveText('All imported card payments, any date or person');
    await expect(panel(page).getByRole('button', { name: 'Review', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page).getByRole('button', { name: 'Details', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page).getByTestId('payments-review')).toHaveCount(0);
    await expect(panel(page).getByRole('list', { name: 'Checking accounts' })).toHaveCount(0);

    await unfold(page, 'Review');
    await expect(panel(page).getByTestId('payments-review-count')).toHaveText('To review: 3 payments and 2 withdrawals');
    await expect(panel(page).getByTestId('payments-consequence')).toHaveText('Answers can be undone and never change spending: card payments are transfers.');
    const word = panel(page).getByTestId('payments-ambiguous');
    await expect(word).toContainText('Holdr does not pair these by itself');
    await expect(word.getByTestId('payments-ambiguous-why')).toHaveText([
      '2 payments; 2 withdrawals could pay them. Say which withdrawal paid which payment.',
    ]);
    await expect(word.getByRole('button', { name: 'Paid by this withdrawal' })).toHaveCount(4);
    await expect(word.getByRole('button', { name: 'Not this one' })).toHaveCount(4);
    // The first payment's second candidate: the owner's word goes to the API as it is.
    await word.getByRole('button', { name: 'Paid by this withdrawal' }).nth(1).click();
    await expect.poll(() => decisions.length).toBe(1);
    expect(decisions[0]).toEqual({ decision: 'confirmed', cardTransactionId: rows[1].id, checkingTransactionId: groupDebit2.id });
    await expect(panel(page).getByTestId('payments-ambiguous')).toHaveCount(0);
    await expect(panel(page).getByTestId('payments-headline')).toHaveText('1 payment and 2 withdrawals to review');
    // What was saved stays in sight with its Undo, and takes the focus from the button that left with its group.
    const saved = panel(page).getByTestId('payments-saved');
    await expect(saved).toHaveText('Saved: the $300.00 payment on Oct 6, 2026 was paid by the withdrawal on Oct 8, 2026. Undo');
    await expect(saved).toBeFocused();
    await expect(saved.getByRole('button', { name: 'Undo' })).toBeEnabled();

    const unmatched = panel(page).getByTestId('payments-unmatched');
    await expect(unmatched.getByRole('heading')).toHaveText('No checking withdrawal found');
    await expect(unmatched).toContainText('No checking withdrawal of this amount within 5 days. Paid from another account?');
    await expect(unmatched.getByTestId('brokerage-hint')).toBeVisible();
    await unmatched.getByRole('button', { name: 'Paid from another account' }).click();
    await expect.poll(() => decisions.length).toBe(2);
    expect(decisions[1]).toEqual({ decision: 'elsewhere', cardTransactionId: rows[3].id });
    await expect(saved).toHaveText('Saved: the $99.99 payment on Oct 9, 2026 was paid from another account. Undo');

    const debits = panel(page).getByTestId('debits-unmatched');
    await expect(debits.getByRole('heading')).toHaveText('Withdrawals with no card payment');
    await expect(debits).toContainText('Paid to Discover');
    await expect(debits).toContainText('DISCOVER E-PAYMENT ***9999 SAMPLE HOLDER');
    await expect(debits).toContainText('No Discover card is in Holdr.');
    await debits.getByRole('button', { name: 'Not a card payment' }).click();
    await expect.poll(() => decisions.length).toBe(3);
    expect(decisions[2]).toEqual({ decision: 'not-card-payment', checkingTransactionId: discover.id });
    await expect(saved).toHaveText('Saved: the $40.00 withdrawal on Oct 5, 2026 is not a card payment. Undo');

    await expect(panel(page).getByTestId('debits-bilt-housing')).toContainText('Bilt housing pull (rent or mortgage)');
    // Only a withdrawal is left: the headline counts it, and the line under it says where the payments stand. One was
    // paid from another account, so they are not called matched.
    await expect(panel(page).getByTestId('payments-headline')).toHaveText('1 withdrawal to review');
    await expect(panel(page).getByTestId('payments-status')).toHaveText('No payments need review');
    await expect(panel(page).getByTestId('payments-review-count')).toHaveText('To review: 1 withdrawal');

    // Details: every posted payment in one part with its reason, adding up to the 4 posted; then the checking coverage.
    await unfold(page, 'Details');
    const breakdown = panel(page).getByTestId('payments-breakdown');
    await expect(breakdown.locator('p').first()).toHaveText('Of 4 posted card payments:');
    await expect(breakdown.getByRole('listitem')).toHaveText(['3 matched to a checking withdrawal (1 confirmed by you)', '1 paid from another account, as you said']);
    await expect(breakdown).toContainText('1 withdrawal you said is not a card payment.');
    await expect(panel(page).getByRole('list', { name: 'Checking accounts' })).toContainText('Sample Bank Everyday Checking ··0001');
    const matched = panel(page).getByTestId('payments-matched');
    await expect(matched.getByRole('heading')).toHaveText('Matched: 3 payments');
    await expect(matched.getByText('Confirmed by you')).toHaveCount(1);
    // No number of five or more digits is shown anywhere: each is cut to its last four, the Amex's five-digit ending too.
    await expect(matched).toContainText('Amex ··0003');
    await expect(panel(page)).not.toContainText(/\d{5}/);
    await expect(panel(page)).not.toContainText(/need your word/i);
  });

  test('3 payments in 2 groups: the headline and the section both count 3 payments, and an answer stays in sight with its Undo', async ({ page }) => {
    // Journey 5: one unit, payments; a group is counted only inside, by what it holds.
    const { decisions, undone } = await serveSpending(page, { answer: (answered) => threeInTwo(answered) });
    await openSpending(page);

    await expect(panel(page).getByTestId('payments-headline')).toHaveText('3 payments to review');
    await expect(panel(page).getByTestId('payments-status')).toHaveCount(0);
    await unfold(page, 'Review');
    await expect(panel(page).getByTestId('payments-review-count')).toHaveText('To review: 3 payments');
    const word = panel(page).getByTestId('payments-ambiguous');
    await expect(word.getByTestId('payments-ambiguous-why')).toHaveText([
      '2 payments; 2 withdrawals could pay them. Say which withdrawal paid which payment.',
      '1 payment; 2 withdrawals could pay it. Say which one did.',
    ]);
    await expect(word.getByRole('button', { name: /^Oct \d+, 2026 · / })).toHaveCount(3);
    // Each card payment is its own labeled part, with the withdrawals that could pay it, and their answers, under it.
    const parts = word.getByTestId('payments-candidates');
    await expect(parts).toHaveCount(3);
    for (const [index, payment] of [[0, 'Oct 6, 2026 · Amex ··0003'], [1, 'Oct 7, 2026 · Amex ··0033'], [2, 'Oct 9, 2026 · Citi ··0022']] as const) {
      const part = parts.nth(index);
      await expect(part.locator('.payments-part-label')).toHaveText(['Card payment', 'Possible checking withdrawals']);
      await expect(part.getByRole('button', { name: new RegExp(`^${payment}`) })).toHaveCount(1);
      await expect(part.getByRole('list', { name: /^Possible checking withdrawals for the / }).getByRole('button', { name: 'Paid by this withdrawal' })).toHaveCount(2);
    }
    // A withdrawal is said as whom it paid, never as a card payment.
    await expect(word).toContainText('Oct 7, 2026 · Paid to American Express, 1 day after');
    await expect(word).not.toContainText(/card payment,/i);
    // The 2 groups are never counted as if they were what is left.
    await expect(panel(page)).not.toContainText(/\(2\)|need your word|2 to review/i);
    // What an answer does is said before any is given.
    await expect(panel(page).getByTestId('payments-consequence')).toBeVisible();
    await unfold(page, 'Details');
    await expect(panel(page).getByTestId('payments-breakdown').getByRole('listitem')).toHaveText(['1 matched to a checking withdrawal', '3 to review']);

    await word.getByRole('button', { name: 'Paid by this withdrawal' }).nth(1).click();
    await expect.poll(() => decisions.length).toBe(1);
    await expect(panel(page).getByTestId('payments-headline')).toHaveText('1 payment to review');
    await expect(panel(page).getByTestId('payments-review-count')).toHaveText('To review: 1 payment');
    await expect(word.getByTestId('payments-ambiguous-why')).toHaveText(['1 payment; 2 withdrawals could pay it. Say which one did.']);
    await expect(panel(page).getByTestId('payments-breakdown').getByRole('listitem'))
      .toHaveText(['3 matched to a checking withdrawal (1 confirmed by you)', '1 to review']);
    const saved = panel(page).getByTestId('payments-saved');
    await expect(saved).toBeFocused();
    await expect(saved).toHaveText('Saved: the $300.00 payment on Oct 6, 2026 was paid by the withdrawal on Oct 8, 2026. Undo');
    // Undone from that line: the answer goes, the group is back to review, and the line says so.
    await saved.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => undone).toEqual([id('cpd_', 'a')]);
    await expect(panel(page).getByTestId('payments-headline')).toHaveText('3 payments to review');
    await expect(saved).toHaveText('Undone: the $300.00 payment on Oct 6, 2026 was paid by the withdrawal on Oct 8, 2026.');
    await expect(saved).toBeFocused();
    await expect(word.getByTestId('payments-ambiguous-why')).toHaveCount(2);
  });

  test('names a withdrawal\'s checking account only when more than one is imported', async ({ page }) => {
    const second = {
      id: id('chk-acct-', 'b'), label: 'Sample Credit Union Checking', institution: 'sample', last4: '0002', currency: 'USD', status: 'active',
      coverage: [{ start: '2025-01-01', end: '2026-10-15' }],
    };
    const shown: { accounts: 1 | 2 } = { accounts: 1 };
    await serveSpending(page, {
      answer: (answered) => {
        const body = threeInTwo(answered);
        return shown.accounts === 1 ? body : { ...body, checking: { ...body.checking, accounts: [...body.checking.accounts, second] } };
      },
    });
    await openSpending(page);
    await unfold(page, 'Review');
    const word = panel(page).getByTestId('payments-ambiguous');
    await expect(word).toContainText('Oct 7, 2026 · Paid to American Express, 1 day after');
    await expect(word).not.toContainText('Sample Bank Everyday Checking');
    shown.accounts = 2;
    await openSpending(page);
    await unfold(page, 'Review');
    await expect(word).toContainText('Oct 7, 2026 · Sample Bank Everyday Checking ··0001 · Paid to American Express, 1 day after');
    await unfold(page, 'Details');
    await expect(panel(page).getByRole('list', { name: 'Checking accounts' }).getByRole('listitem')).toHaveCount(2);
  });

  test('says "matched" only when every payment is matched; one paid elsewhere or returned by the card is never called matched', async ({ page }) => {
    const shown: { kind: 'matched' | 'pending' | 'otherwise' } = { kind: 'otherwise' };
    await serveSpending(page, { answer: () => settledAnswer(shown.kind) });
    await openSpending(page);

    // Settled otherwise: no review is needed, nothing is called matched, and Details says why for each payment.
    await expect(panel(page).getByTestId('payments-headline')).toHaveText('No payments need review');
    await expect(panel(page).getByTestId('payments-status')).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
    await expect(panel(page)).not.toContainText(/matched/i);
    await unfold(page, 'Details');
    await expect(panel(page).getByTestId('payments-breakdown').getByRole('listitem')).toHaveText([
      '2 matched to a checking withdrawal', '1 paid from another account, as you said', '1 returned by the card, so no withdrawal is owed',
    ]);
    await expect(panel(page).getByTestId('payments-elsewhere').getByRole('heading')).toHaveText('Paid from another account: 1 payment');
    await expect(panel(page).getByTestId('payments-elsewhere').getByRole('button', { name: 'Undo' })).toBeEnabled();
    await expect(panel(page).getByTestId('payments-returned').getByRole('heading')).toHaveText('Returned by the card: 1 payment');
    await expect(panel(page).getByTestId('payments-matched').getByRole('heading')).toHaveText('Matched: 2 payments');
    for (const testId of ['payments-elsewhere', 'payments-returned']) await expect(panel(page).getByTestId(testId)).not.toContainText(/matched/i);

    // Every payment matched: said so.
    shown.kind = 'matched';
    await openSpending(page);
    await expect(panel(page).getByTestId('payments-headline')).toHaveText('All card payments are matched');
    await expect(panel(page).getByTestId('payments-status')).toHaveCount(0);
    // Every posted one matched, beside a pending one: "every" is said of the posted ones, and the pending one is said.
    shown.kind = 'pending';
    await openSpending(page);
    await expect(panel(page).getByTestId('payments-headline')).toHaveText('All posted card payments are matched');
    await expect(panel(page).getByTestId('payments-status')).toHaveText('1 pending payment is checked once it posts');
  });

  test('a payment\'s details say which withdrawal paid it, ask when more than one fits, and undo the owner\'s answer', async ({ page }) => {
    const { decisions, undone } = await serveSpending(page);
    await openSpending(page);

    await unfold(page, 'Review');
    await panel(page).getByTestId('payments-ambiguous').getByRole('button', { name: /Oct 6, 2026/ }).click();
    const dialog = page.getByRole('dialog');
    const section = dialog.getByRole('region', { name: 'Paid from checking' });
    await expect(section).toContainText('Which withdrawal paid it?');
    await expect(section.getByTestId('payment-ambiguous-why')).toHaveText(
      'Which withdrawal paid it? 2 checking withdrawals of this amount fit, and 1 other card payment of this amount is close by. Holdr does not pick: say which.',
    );
    await expect(section.getByTestId('payment-consequence')).toHaveText('Answers can be undone and never change spending: card payments are transfers.');
    await expect(section.getByRole('button', { name: 'Paid by this withdrawal' })).toHaveCount(2);
    await expect(section.getByRole('button', { name: 'Not this one' })).toHaveCount(2);
    await section.getByRole('button', { name: 'Paid by this withdrawal' }).first().click();
    await expect.poll(() => decisions.length).toBe(1);
    expect(decisions[0]).toEqual({ decision: 'confirmed', cardTransactionId: rows[1].id, checkingTransactionId: groupDebit1.id });
    await expect(section).toContainText('Paid from checking (you confirmed it)');
    await expect(section).toContainText('Sample Bank Everyday Checking');
    await section.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => undone.length).toBe(1);
    await expect(section).toContainText('Which withdrawal paid it?');
    // The brokerage suggestions keep their own section, empty here.
    await expect(dialog.getByRole('region', { name: 'Possibly paid from' })).toHaveCount(0);
  });

  test('shows the owner\'s answers with their Undo when no checking is imported, stale and rejected ones included', async ({ page }) => {
    const { decisions, undone } = await serveSpending(page, { answer: withoutChecking });
    await openSpending(page);

    await expect(panel(page).getByTestId('payments-headline')).toHaveText('No checking account is imported yet');
    await expect(panel(page).getByTestId('stale-decisions')).toHaveText(
      '1 earlier answer no longer fits its rows (a row changed or is gone) and does nothing: undo it under Details.',
    );
    // Nothing to review before checking is imported: no Review action, and no payment is called "to review".
    await expect(panel(page).getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
    await unfold(page, 'Details');
    await expect(panel(page).getByTestId('payments-breakdown').getByRole('listitem')).toHaveText(['4 waiting for checking history']);
    const answers = panel(page).getByTestId('payments-answers');
    await expect(answers.getByRole('heading')).toHaveText('Your other answers: 2');
    await expect(answers).toContainText('Paid by this withdrawal (no longer fits: a row is gone)');
    await expect(answers).toContainText('Not this one');
    await expect(answers.getByRole('button', { name: 'Undo' })).toHaveCount(2);
    await expect(answers.getByRole('button', { name: 'Undo' }).first()).toBeEnabled();
    await answers.getByRole('button', { name: 'Undo' }).first().click();
    await expect.poll(() => undone).toEqual([id('cpd_', 'd')]);
    await expect(panel(page).getByTestId('payments-answers').getByRole('heading')).toHaveText('Your other answers: 1');
    await expect(panel(page).getByTestId('stale-decisions')).toHaveCount(0);
    // The answer undone is said in sight, with no Undo of its own.
    await expect(panel(page).getByTestId('payments-saved')).toHaveText('Undone: the $500.00 payment on Oct 2, 2026 was paid by the withdrawal.');
    // An answer given before checking was imported: paid from another account, with its Undo.
    decisions.push({ decision: 'elsewhere', cardTransactionId: rows[3].id });
    await openSpending(page);
    await unfold(page, 'Details');
    const elsewhere = panel(page).getByTestId('payments-elsewhere');
    await expect(elsewhere.getByRole('heading')).toHaveText('Paid from another account: 1 payment');
    await expect(elsewhere.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await expect(panel(page).getByTestId('payments-breakdown').getByRole('listitem'))
      .toHaveText(['3 waiting for checking history', '1 paid from another account, as you said']);
  });

  test('a failed read shows why and leaves nothing to answer until a read succeeds', async ({ page }) => {
    const { decisions, undone, fake } = await serveSpending(page);
    await openSpending(page);

    await unfold(page, 'Review');
    await panel(page).getByTestId('payments-unmatched').getByRole('button', { name: 'Paid from another account' }).click();
    await expect.poll(() => decisions.length).toBe(1);
    await unfold(page, 'Details');
    const elsewhere = panel(page).getByTestId('payments-elsewhere');
    // The undo is taken, and the read after it fails: the old answer stays in sight, nothing of it can be acted on.
    fake.failReads = true;
    await elsewhere.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => undone).toEqual([id('cpd_', 'b')]);
    const failed = panel(page).getByTestId('payments-read-error');
    await expect(failed).toContainText('could not be read again');
    await expect(elsewhere.getByRole('button', { name: 'Undo' })).toBeDisabled();
    await expect(panel(page).getByTestId('payments-ambiguous').getByRole('button', { name: 'Paid by this withdrawal' }).first()).toBeDisabled();
    await expect(panel(page).getByTestId('debits-unmatched').getByRole('button', { name: 'Not a card payment' })).toBeDisabled();
    fake.failReads = false;
    await failed.getByRole('button', { name: 'Read again' }).click();
    await expect(panel(page).getByTestId('payments-read-error')).toHaveCount(0);
    await expect(panel(page).getByTestId('payments-elsewhere')).toHaveCount(0);
    await expect(panel(page).getByTestId('debits-unmatched').getByRole('button', { name: 'Not a card payment' })).toBeEnabled();

    // In a payment's details too: an answer is sent, the read after it fails, and nothing stale is left to act on.
    await panel(page).getByTestId('payments-ambiguous').getByRole('button', { name: /Oct 6, 2026/ }).click();
    const section = page.getByRole('dialog').getByRole('region', { name: 'Paid from checking' });
    await expect(section.getByRole('button', { name: 'Paid by this withdrawal' })).toHaveCount(2);
    fake.failMatch = true;
    await section.getByRole('button', { name: 'Paid by this withdrawal' }).first().click();
    await expect.poll(() => decisions.length).toBe(1);
    await expect(section.getByRole('alert')).toContainText('could not be read');
    await expect(section.getByRole('button')).toHaveCount(1);
    fake.failMatch = false;
    await section.getByRole('button', { name: 'Read again' }).click();
    await expect(section).toContainText('Paid from checking (you confirmed it)');
  });

  test('says how many pairings fit a group held for the owner, never "more than one" where one does, in the panel and the details', async ({ page }) => {
    // Root 04:25Z: one payment and one withdrawal, two payments and one withdrawal, one payment and two withdrawals.
    const held = {
      ...reconciliation([]),
      totals: [{
        currency: 'USD',
        payments: { all: amount(4, -119_999), matched: zero, confirmed: zero, ambiguous: amount(4, -119_999), unmatched: zero, elsewhere: zero, pending: zero },
        debits: { all: amount(4, -99_998), matched: zero, confirmed: zero, ambiguous: amount(4, -99_998), unmatched: zero, notCardPayment: zero, biltHousing: zero },
      }],
      pairs: [],
      ambiguous: [
        { id: rows[0].id, payments: [payment(rows[0])], debits: [amexDebit], candidates: [{ paymentId: rows[0].id, debitId: amexDebit.id, dayOffset: 1 }] },
        {
          id: rows[1].id, payments: [payment(rows[1]), payment(rows[2])], debits: [groupDebit1],
          candidates: [{ paymentId: rows[1].id, debitId: groupDebit1.id, dayOffset: 1 }, { paymentId: rows[2].id, debitId: groupDebit1.id, dayOffset: 0 }],
        },
        {
          id: rows[3].id, payments: [payment(rows[3])], debits: [citi1, citi2],
          candidates: [{ paymentId: rows[3].id, debitId: citi1.id, dayOffset: 1 }, { paymentId: rows[3].id, debitId: citi2.id, dayOffset: 2 }],
        },
      ],
      unmatchedPayments: [], unmatchedDebits: [], elsewhere: [], notCardPayments: [], biltHousing: [],
    };
    await serveSpending(page, { answer: () => held });
    await openSpending(page);

    await expect(panel(page).getByTestId('payments-headline')).toHaveText('4 payments to review');
    await unfold(page, 'Review');
    await expect(panel(page).getByTestId('payments-review-count')).toHaveText('To review: 4 payments');
    const word = panel(page).getByTestId('payments-ambiguous');
    await expect(word.getByTestId('payments-ambiguous-why')).toHaveText([
      '1 payment; 1 withdrawal could pay it. Holdr does not pair them by itself: confirm it if it did.',
      '2 payments; 1 withdrawal could pay one of them. Say which one it paid.',
      '1 payment; 2 withdrawals could pay it. Say which one did.',
    ]);
    await expect(word).not.toContainText(/more than one/i);
    await expect(word.getByRole('button', { name: 'Paid by this withdrawal' })).toHaveCount(5);
    await expect(panel(page).getByTestId('payments-status')).toHaveCount(0);
    // Each payment's details say the same from its own side: one withdrawal asks for a confirmation, never which.
    const oneWithdrawalOfTwoPayments = 'Paid by this withdrawal? One checking withdrawal of this amount fits, and 1 other card payment of this amount is'
      + ' close by: Holdr does not pick. Confirm it if it paid this one.';
    const details: Array<[RegExp, string, number]> = [
      [/Oct 2, 2026/, 'Paid by this withdrawal? This pairing needs your confirmation: Holdr does not pair it by itself.', 1],
      [/Oct 6, 2026/, oneWithdrawalOfTwoPayments, 1],
      [/Oct 7, 2026/, oneWithdrawalOfTwoPayments, 1],
      [/Oct 9, 2026/, 'Which withdrawal paid it? 2 checking withdrawals of this amount fit. Holdr does not pick: say which.', 2],
    ];
    for (const [date, text, buttons] of details) {
      await word.getByRole('button', { name: date }).click();
      const section = page.getByRole('dialog').getByRole('region', { name: 'Paid from checking' });
      await expect(section.getByTestId('payment-ambiguous-why')).toHaveText(text);
      await expect(section.getByRole('button', { name: 'Paid by this withdrawal' })).toHaveCount(buttons);
      await expect(section).not.toContainText(/more than one/i);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  });

  test('shows a card with a custom issuer slug with no number of the slug, and only the card\'s last four', async ({ page }) => {
    const slugs = ['synthetic-12345', 'synthetic-1234567890', 'synthetic-1234-5678', 'synthetic-123-456-7890'];
    const custom: CardAccount[] = slugs.map((issuer, index) => ({ ...accounts[1], id: id('card-acct-', 'defg'[index]), issuer, last4: '0003' }));
    const customRows = custom.map((account, index) => row('hijk'[index], account.id, `2026-10-1${index}`, -(1_000 + index), 'ONLINE PAYMENT THANK YOU'));
    await serveSpending(page, {
      accounts: [...accounts, ...custom],
      answer: () => ({
        ...reconciliation([]),
        totals: [{
          currency: 'USD',
          payments: { all: amount(4, -4_006), matched: zero, confirmed: zero, ambiguous: zero, unmatched: amount(4, -4_006), elsewhere: zero, pending: zero },
          debits: { all: zero, matched: zero, confirmed: zero, ambiguous: zero, unmatched: zero, notCardPayment: zero, biltHousing: zero },
        }],
        pairs: [], ambiguous: [], unmatchedDebits: [], biltHousing: [],
        unmatchedPayments: customRows.map((item) => ({ payment: payment(item), reason: 'no-checking-debit', possibleDebits: [], brokerageSuggestions: 0 })),
      }),
    });
    await openSpending(page);

    await expect(panel(page).getByTestId('payments-headline')).toHaveText('4 payments to review');
    await unfold(page, 'Review');
    const unmatched = panel(page).getByTestId('payments-unmatched');
    await expect(unmatched.getByText('Synthetic ··0003')).toHaveCount(4);
    for (const digits of [/\d{5}/, '1234 5678', '123 456', 'Synthetic 1']) await expect(panel(page)).not.toContainText(digits);
  });

  test('never says nothing needs review while another currency still has a gap', async ({ page }) => {
    const euroCard: CardAccount = { ...accounts[1], id: id('card-acct-', 'h'), currency: 'EUR', last4: '0044' };
    const euroRow = row('l', euroCard.id, '2026-10-09', -12_000, 'ONLINE PAYMENT, THANK YOU');
    const settled = (currency: string, all: ReturnType<typeof amount>, part: 'matched' | 'unmatched' | 'elsewhere') => ({
      currency,
      payments: { all, matched: zero, confirmed: zero, ambiguous: zero, unmatched: zero, elsewhere: zero, pending: zero, [part]: all },
      debits: { all: part === 'matched' ? all : zero, matched: part === 'matched' ? all : zero, confirmed: zero, ambiguous: zero, unmatched: zero, notCardPayment: zero, biltHousing: zero },
    });
    const { decisions } = await serveSpending(page, {
      accounts: [...accounts, euroCard],
      answer: (answered) => {
        const elsewhere = answered.some((item) => item.decision === 'elsewhere');
        return {
          ...reconciliation([]),
          totals: [settled('USD', amount(1, -50_000), 'matched'), settled('EUR', amount(1, -12_000), elsewhere ? 'elsewhere' : 'unmatched')],
          pairs: [{ status: 'matched', dayOffset: 1, payment: payment(rows[0]), debit: amexDebit }],
          ambiguous: [], unmatchedDebits: [], biltHousing: [],
          unmatchedPayments: elsewhere ? [] : [{ payment: { ...payment(euroRow), currency: 'EUR' }, reason: 'no-checking-debit', possibleDebits: [], brokerageSuggestions: 0 }],
          elsewhere: elsewhere ? [{ payment: { ...payment(euroRow), currency: 'EUR' }, decisionId: id('cpd_', 'b') }] : [],
        };
      },
    });
    await openSpending(page);

    // Every USD payment is matched; the euro one is not: it counts, in payments, whatever its currency.
    await expect(panel(page).getByTestId('payments-headline')).toHaveText('1 payment to review');
    await unfold(page, 'Review');
    await panel(page).getByTestId('payments-unmatched').getByRole('button', { name: 'Paid from another account' }).click();
    await expect.poll(() => decisions.length).toBe(1);
    // Once the euro payment is answered too, nothing is left in any currency; the one paid elsewhere is not called matched.
    await expect(panel(page).getByTestId('payments-headline')).toHaveText('No payments need review');
    await expect(panel(page).getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
    await expect(panel(page).getByTestId('payments-saved')).toContainText('payment on Oct 9, 2026 was paid from another account');
    await unfold(page, 'Details');
    await expect(panel(page).getByTestId('payments-breakdown').getByRole('listitem'))
      .toHaveText(['1 matched to a checking withdrawal', '1 paid from another account, as you said']);
  });

  test('shows a payment the card took back apart with its reversal, and only offers a row that adds a gap\'s amount back', async ({ page }) => {
    // Root 15:03Z: a returned payment is its own visible state and needs no withdrawal; anything less sure goes to the owner.
    const reversal = { id: id('card-txn-', 'm'), cardAccountId: CITI, date: '2026-10-12', amountMinor: 9_999, currency: 'USD', description: 'RETURNED PAYMENT' };
    const charge = { id: id('card-txn-', 'n'), cardAccountId: AMEX, date: '2026-10-11', amountMinor: 30_000, currency: 'USD', description: 'AUTOPAY PAYMENT SAMPLE UTILITY' };
    await serveSpending(page, {
      answer: () => ({
        ...reconciliation([]),
        rules: { daysBefore: 5, daysAfter: 5, confirmDays: 15, returnDays: 30 },
        totals: [{
          currency: 'USD',
          payments: {
            all: amount(4, -119_999), matched: amount(2, -80_000), confirmed: zero, ambiguous: zero, unmatched: amount(1, -30_000),
            elsewhere: zero, returned: amount(1, -9_999), pending: zero,
          },
          debits: { all: amount(2, -80_000), matched: amount(2, -80_000), confirmed: zero, ambiguous: zero, unmatched: zero, notCardPayment: zero, biltHousing: zero },
        }],
        pairs: [
          { status: 'matched', dayOffset: 1, payment: payment(rows[0]), debit: amexDebit },
          { status: 'matched', dayOffset: 0, payment: payment(rows[2]), debit: groupDebit1 },
        ],
        ambiguous: [], unmatchedDebits: [], biltHousing: [],
        unmatchedPayments: [{ payment: payment(rows[1]), reason: 'no-checking-debit', possibleDebits: [], brokerageSuggestions: 0, possibleReversals: [{ reversal: charge, dayOffset: 5 }] }],
        returned: [{ payment: payment(rows[3]), reversal, dayOffset: 3 }],
      }),
    });
    await openSpending(page);

    await expect(panel(page).getByTestId('payments-headline')).toHaveText('1 payment to review');
    // The gap: the card's row adding its amount back is offered as a hint, with nothing to pair it by.
    await unfold(page, 'Review');
    const unmatched = panel(page).getByTestId('payments-unmatched');
    await expect(unmatched.getByTestId('reversal-hint')).toHaveText(
      'A row on this card adds this amount back: if the card took this payment back, no checking withdrawal is owed. Holdr does not decide it by itself.',
    );
    await expect(unmatched).toContainText('Oct 11, 2026 · Adds this amount back, 5 days after');
    await expect(unmatched).toContainText('AUTOPAY PAYMENT SAMPLE UTILITY');
    await expect(unmatched.getByRole('button', { name: 'Paid by this withdrawal' })).toHaveCount(0);
    // The returned payment, apart under Details with the card's row that took it back: settled, never called matched.
    await unfold(page, 'Details');
    await expect(panel(page).getByTestId('payments-breakdown').getByRole('listitem')).toHaveText([
      '2 matched to a checking withdrawal', '1 to review', '1 returned by the card, so no withdrawal is owed',
    ]);
    const returned = panel(page).getByTestId('payments-returned');
    await expect(returned.getByRole('heading')).toHaveText('Returned by the card: 1 payment');
    await expect(returned).toContainText('never paid, so no checking withdrawal is owed');
    await expect(returned).toContainText('Citi ··0022');
    await expect(returned).toContainText('Oct 12, 2026 · Taken back by the card, 3 days after');
    await expect(returned).toContainText('RETURNED PAYMENT');
    await expect(returned).not.toContainText(/matched/i);
    await expect(returned.getByRole('button', { name: /Paid|Undo/ })).toHaveCount(0);
    await expect(panel(page)).not.toContainText(/\d{5}/);

    // Its details say the same.
    await returned.getByRole('button', { name: /Oct 9, 2026/ }).click();
    const section = page.getByRole('dialog').getByRole('region', { name: 'Paid from checking' });
    await expect(section.getByTestId('payment-returned')).toHaveText(
      'Returned by the card. The card took this payment back 3 days after it: never paid, so no checking withdrawal is owed. A transfer, not spending.',
    );
    await expect(section).toContainText('Oct 12, 2026, 3 days after the payment');
    await expect(section.getByRole('button')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The gap's details offer the card's row too, and still let the owner say it was paid from another account.
    await unmatched.getByRole('button', { name: /Oct 6, 2026/ }).click();
    const gap = page.getByRole('dialog').getByRole('region', { name: 'Paid from checking' });
    await expect(gap.getByTestId('payment-reversal-hint')).toContainText('A row on this card adds this amount back');
    await expect(gap).toContainText('Oct 11, 2026, 5 days after the payment');
    await expect(gap.getByRole('button', { name: 'Paid from another account' })).toBeVisible();
    await expect(gap.getByTestId('payment-consequence')).toBeVisible();
  });

  test('shows a payment the card took back, and one a row may have taken back, with no checking imported', async ({ page }) => {
    // Root 15:42Z: neither waits for checking, in the panel or in a payment's details.
    const reversal = { id: id('card-txn-', 'm'), cardAccountId: CITI, date: '2026-10-12', amountMinor: 9_999, currency: 'USD', description: 'RETURNED PAYMENT' };
    const charge = { id: id('card-txn-', 'n'), cardAccountId: AMEX, date: '2026-10-11', amountMinor: 30_000, currency: 'USD', description: 'AUTOPAY PAYMENT SAMPLE UTILITY' };
    await serveSpending(page, {
      answer: (decisions, undone) => ({
        ...withoutChecking(decisions, undone),
        totals: [{
          currency: 'USD',
          payments: {
            all: amount(4, -119_999), matched: zero, confirmed: zero, ambiguous: zero, unmatched: amount(3, -110_000), elsewhere: zero,
            returned: amount(1, -9_999), pending: zero,
          },
          debits: { all: zero, matched: zero, confirmed: zero, ambiguous: zero, unmatched: zero, notCardPayment: zero, biltHousing: zero },
        }],
        unmatchedPayments: [rows[0], rows[1], rows[2]].map((item) => ({
          payment: payment(item), reason: 'no-checking-account', possibleDebits: [], brokerageSuggestions: 0,
          ...(item === rows[1] ? { possibleReversals: [{ reversal: charge, dayOffset: 5 }] } : {}),
        })),
        returned: [{ payment: payment(rows[3]), reversal, dayOffset: 3 }],
      }),
    });
    await openSpending(page);

    await expect(panel(page).getByTestId('payments-headline')).toHaveText('No checking account is imported yet');
    await expect(panel(page).getByTestId('payments-status')).toHaveText('1 payment may have been taken back by the card');
    // No gap list without checking; the payment a row on its card may have taken back shows on its own, read only.
    await unfold(page, 'Review');
    await expect(panel(page).getByTestId('payments-unmatched')).toHaveCount(0);
    await expect(panel(page).getByTestId('payments-consequence')).toHaveCount(0);
    const hints = panel(page).getByTestId('payments-reversal-hints');
    await expect(hints.getByRole('heading')).toHaveText('Possibly taken back by the card');
    await expect(panel(page).getByTestId('reversal-hint')).toHaveCount(1);
    await expect(hints).toContainText('Oct 11, 2026 · Adds this amount back, 5 days after');
    await expect(hints.getByRole('button', { name: /Paid/ })).toHaveCount(0);
    await unfold(page, 'Details');
    await expect(panel(page).getByTestId('payments-breakdown').getByRole('listitem'))
      .toHaveText(['3 waiting for checking history', '1 returned by the card, so no withdrawal is owed']);
    const returned = panel(page).getByTestId('payments-returned');
    await expect(returned).toContainText('Oct 12, 2026 · Taken back by the card, 3 days after');
    await expect(returned).toContainText('RETURNED PAYMENT');
    await expect(panel(page)).not.toContainText(/\d{5}/);

    await returned.getByRole('button', { name: /Oct 9, 2026/ }).click();
    const section = page.getByRole('dialog').getByRole('region', { name: 'Paid from checking' });
    await expect(section).toHaveAttribute('data-status', 'returned');
    await expect(section.getByTestId('payment-returned')).toContainText('Returned by the card. The card took this payment back 3 days after it');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await hints.getByRole('button', { name: /Oct 6, 2026/ }).click();
    const gap = page.getByRole('dialog').getByRole('region', { name: 'Paid from checking' });
    await expect(gap).toContainText('No checking account is imported yet.');
    await expect(gap.getByTestId('payment-reversal-hint')).toContainText('A row on this card adds this amount back');
    await expect(gap.getByRole('button')).toHaveCount(0);
    await expect(gap.getByTestId('payment-consequence')).toHaveCount(0);
  });

  for (const width of [375, 1920]) {
    test(`keeps every text at its reading floor at ${width}px: compact, under Review and Details, empty, failed, and in a payment's details`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { fake } = await serveSpending(page);
      const mode: { answer: 'full' | 'empty' | 'evidence' } = { answer: 'full' };
      fake.answer = (decisions) => (mode.answer === 'empty'
        ? { ...reconciliation([]), totals: [], pairs: [], ambiguous: [], unmatchedPayments: [], unmatchedDebits: [], elsewhere: [], notCardPayments: [], biltHousing: [] }
        : mode.answer === 'evidence' ? fromEvidence(decisions) : reconciliation(decisions));
      await openSpending(page);

      // The title: a section head, 18px on a phone and 20px from 1280px, at 1.5 line height (D1).
      const title = await panel(page).getByRole('heading', { level: 3 }).evaluate((element) => {
        const style = getComputedStyle(element);
        return { size: Number.parseFloat(style.fontSize), leading: Number.parseFloat(style.lineHeight) };
      });
      expect(title.size, `${width}px title`).toBe(width >= 1280 ? 20 : 18);
      expect(title.leading / title.size, `${width}px title line height`).toBeCloseTo(1.5, 2);
      await expectFloors(panel(page), `${width}px compact`);
      await unfold(page, 'Review');
      await unfold(page, 'Details');
      await expectFloors(panel(page), `${width}px under Review and Details`);
      // The headline and every payment or withdrawal row read at 1.5 too.
      for (const selector of ['.payments-headline', '.spending-payments-open', '.spending-payments-debit']) {
        const leading = await panel(page).locator(selector).first().evaluate((element) => {
          const style = getComputedStyle(element);
          return Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize);
        });
        expect(leading, `${width}px ${selector} line height`).toBeCloseTo(1.5, 2);
      }
      // Everything unfolded: still no sideways scroll at this width.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${width}px sideways`).toBeLessThanOrEqual(0);
      // An answer: its line in sight, and the pair it confirmed with its badge under Details.
      await panel(page).getByTestId('payments-ambiguous').getByRole('button', { name: 'Paid by this withdrawal' }).first().click();
      await expect(panel(page).getByTestId('payments-saved')).toBeVisible();
      await expect(panel(page).getByTestId('payments-matched').getByText('Confirmed by you')).toBeVisible();
      await expectFloors(panel(page), `${width}px after an answer`);
      // A payment's details.
      await panel(page).getByTestId('payments-unmatched').getByRole('button', { name: /Oct 9, 2026/ }).click();
      const section = page.getByRole('dialog').getByRole('region', { name: 'Paid from checking' });
      await expect(section.getByRole('button', { name: 'Paid from another account' })).toBeVisible();
      await expectFloors(section, `${width}px a payment's details`);
      await page.keyboard.press('Escape');

      // Pairs Holdr matched from evidence (#231): their block under Review, their badge under Details, their details.
      mode.answer = 'evidence';
      await openSpending(page);
      await unfold(page, 'Review');
      await unfold(page, 'Details');
      await expect(panel(page).getByTestId('payments-evidence')).toBeVisible();
      await expect(panel(page).getByTestId('payments-matched').getByText('From evidence')).toHaveCount(2);
      await expectFloors(panel(page), `${width}px from evidence`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${width}px sideways, from evidence`).toBeLessThanOrEqual(0);
      await panel(page).getByTestId('payments-evidence').getByRole('button', { name: /Oct 6, 2026/ }).click();
      const evidenceSection = page.getByRole('dialog').getByRole('region', { name: 'Paid from checking' });
      await expect(evidenceSection.getByTestId('payment-evidence-why')).toBeVisible();
      await expectFloors(evidenceSection, `${width}px a payment matched from evidence`);
      await page.keyboard.press('Escape');

      // Nothing posted yet.
      mode.answer = 'empty';
      await openSpending(page);
      await expect(panel(page).getByTestId('payments-headline')).toHaveText('No posted card payments yet');
      await unfold(page, 'Details');
      await expectFloors(panel(page), `${width}px empty`);
      // A failed first read.
      fake.failReads = true;
      await openSpending(page);
      await expect(panel(page).getByTestId('payments-read-error')).toContainText('could not be read');
      await expectFloors(panel(page), `${width}px failed read`);
    });
  }
});

