import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_UNCATEGORIZED,
  cardCoverageContains,
  cardMinorToMajor,
  cardSpendingExclusionOf,
  cardSpendingOtherMerchants,
  cardSpendingRole,
  effectiveCardCategory,
  effectiveCardMerchant,
  mergeCardCoverage,
  parseCardAmountQuery,
  primaryCardCurrency,
  summarizeCardSpending,
  toCardTransactionView,
  type CardSpendingRow,
} from './cardSpending.js';
import { cardMerchantKey, groupCardMerchantKeys } from './cardMerchants.js';
import type { CardOwner, CardTransaction } from './types.js';
import { seededRandom, syntheticSpendingLedger } from './__fixtures__/syntheticSpendingLedger.js';

// Synthetic rows only: made-up merchants, amounts and card ids.
function row(overrides: Partial<CardSpendingRow> = {}): CardSpendingRow {
  return {
    cardAccountId: 'card-acct-a',
    transactionDate: '2026-09-10',
    status: 'posted',
    amountMinor: 1000,
    currency: 'USD',
    kind: 'purchase',
    description: 'SAMPLE STORE',
    merchant: null,
    issuerCategory: null,
    userCategory: null,
    ...overrides,
  };
}

const owners = new Map<string, CardOwner>([['card-acct-a', 'alex'], ['card-acct-b', 'casey'], ['card-acct-c', 'joint']]);

describe('card spending roles and labels', () => {
  it('counts purchases, fees, interest, refunds and adjustments; payments are transfers; other is not counted', () => {
    assert.equal(cardSpendingRole('purchase'), 'spending');
    assert.equal(cardSpendingRole('fee'), 'spending');
    assert.equal(cardSpendingRole('interest'), 'spending');
    assert.equal(cardSpendingRole('refund'), 'spending');
    assert.equal(cardSpendingRole('adjustment'), 'spending');
    assert.equal(cardSpendingRole('payment'), 'transfer');
    assert.equal(cardSpendingRole('other'), 'excluded');
    assert.equal(cardSpendingRole('constructor' as never), 'excluded');
  });

  it('prefers the custom category, then the issuer category', () => {
    assert.equal(effectiveCardCategory({ userCategory: 'Groceries', issuerCategory: 'Merchandise' }), 'Groceries');
    assert.equal(effectiveCardCategory({ userCategory: null, issuerCategory: 'Merchandise' }), 'Merchandise');
    assert.equal(effectiveCardCategory({}), CARD_UNCATEGORIZED);
    // An enriched answer's inferred category: on a row with neither, or over the issuer's for a tax payment's rule.
    assert.equal(effectiveCardCategory({ inferredCategory: 'Groceries' }), 'Groceries');
    assert.equal(effectiveCardCategory({ issuerCategory: 'Utilities', inferredCategory: 'Taxes' }), 'Taxes');
    assert.equal(effectiveCardCategory({ userCategory: 'Mine', issuerCategory: 'Utilities', inferredCategory: 'Taxes' }), 'Mine');
    assert.equal(effectiveCardMerchant({ merchant: 'Sample Cafe', description: 'SQ *SAMPLE CAFE' }), 'Sample Cafe');
    assert.equal(effectiveCardMerchant({ merchant: null, description: 'SQ *SAMPLE CAFE' }), 'SQ *SAMPLE CAFE');
  });
});

describe('summarizeCardSpending', () => {
  it('ranks real merchants, combining wallet twins but never a wallet-wide bucket', () => {
    const summary = summarizeCardSpending([
      row({ description: 'AplPay TARGET DULUTH GA', amountMinor: 1000 }),
      row({ description: 'TARGET 00012345 DULUTH GA', amountMinor: 2000 }),
      row({ description: 'AplPay MICRO CENTER DULUTH GA', amountMinor: 4000 }),
      row({ description: 'MICRO CENTER #095 DULUTH GA', amountMinor: 5000 }),
      row({ description: 'APLPAY', amountMinor: 100 }),
    ]);
    assert.deepEqual(summary.byMerchant.map((item) => [item.merchantKey, item.spendingMinor, item.count]), [
      ['MICRO CENTER', 9000, 2], ['TARGET', 3000, 2], ['APLPAY', 100, 1],
    ]);
  });

  it('counts posted spending only, offsets refunds and keeps payments, other, pending and removed rows out', () => {
    const summary = summarizeCardSpending([
      row({ amountMinor: 5000 }),
      row({ amountMinor: 250, kind: 'fee', description: 'FOREIGN TRANSACTION FEE' }),
      row({ amountMinor: 120, kind: 'interest', description: 'INTEREST CHARGE' }),
      row({ amountMinor: -1500, kind: 'refund' }),
      row({ amountMinor: -250, kind: 'adjustment', description: 'FEE REVERSAL' }),
      row({ amountMinor: -40000, kind: 'payment', description: 'AUTOPAY PAYMENT' }),
      row({ amountMinor: 20000, kind: 'other', description: 'CASH ADVANCE' }),
      row({ amountMinor: 999, status: 'pending' }),
      row({ amountMinor: -300, status: 'pending', kind: 'refund' }),
      row({ amountMinor: 777, status: 'removed' }),
    ], { owners });
    assert.deepEqual(summary.totals, [{
      currency: 'USD',
      spendingMinor: 3620,
      chargesMinor: 5370,
      creditsMinor: -1750,
      count: 5,
      paymentsMinor: -40000,
      paymentCount: 1,
      otherMinor: 20000,
      otherCount: 1,
    }]);
    assert.deepEqual(summary.pending, [{ currency: 'USD', count: 2, netMinor: 699, chargesMinor: 999, creditsMinor: -300 }]);
    assert.equal(summary.byMonth.length, 1);
    assert.equal(summary.byMonth[0].spendingMinor, 3620);
    assert.deepEqual(summary.byOwner.map((item) => [item.owner, item.spendingMinor]), [['alex', 3620]]);
  });

  it('puts each row in the month of its transaction date, refunds included, and fills empty months', () => {
    const summary = summarizeCardSpending([
      row({ transactionDate: '2026-01-31', amountMinor: 8000 }),
      row({ transactionDate: '2026-02-03', amountMinor: -8000, kind: 'refund' }),
      row({ transactionDate: '2026-04-01', amountMinor: 100 }),
    ]);
    assert.deepEqual(summary.byMonth.map((item) => [item.month, item.spendingMinor, item.count]), [
      ['2026-01', 8000, 1],
      ['2026-02', -8000, 1],
      ['2026-03', 0, 0],
      ['2026-04', 100, 1],
    ]);
    const yearEnd = summarizeCardSpending([
      row({ transactionDate: '2025-11-30' }),
      row({ transactionDate: '2026-01-02' }),
    ]);
    assert.deepEqual(yearEnd.byMonth.map((item) => item.month), ['2025-11', '2025-12', '2026-01']);
  });

  it('never adds amounts across currencies and counts a foreign purchase in the card currency', () => {
    const summary = summarizeCardSpending([
      row({ amountMinor: 5432, description: 'SAMPLE HOTEL PARIS' }),
      row({ cardAccountId: 'card-acct-c', currency: 'CAD', amountMinor: 2000, transactionDate: '2026-08-01' }),
      row({ cardAccountId: 'card-acct-c', currency: 'CAD', amountMinor: 3000, transactionDate: '2026-09-01' }),
    ], { owners });
    assert.deepEqual(summary.totals.map((item) => [item.currency, item.spendingMinor]), [['CAD', 5000], ['USD', 5432]]);
    assert.deepEqual(summary.byMonth.map((item) => [item.currency, item.month, item.spendingMinor]), [
      ['CAD', '2026-08', 2000],
      ['CAD', '2026-09', 3000],
      ['USD', '2026-09', 5432],
    ]);
    assert.deepEqual(summary.byOwner.map((item) => [item.currency, item.owner]), [['CAD', 'joint'], ['USD', 'alex']]);
  });

  it('reports custom categories in place of issuer categories and sorts buckets by spending', () => {
    const summary = summarizeCardSpending([
      row({ amountMinor: 3000, issuerCategory: 'Restaurant' }),
      row({ amountMinor: 2000, issuerCategory: 'Restaurant', userCategory: 'Work lunch' }),
      row({ amountMinor: 4500, issuerCategory: 'Merchandise' }),
      row({ amountMinor: 700 }),
      row({ amountMinor: -700, kind: 'refund' }),
    ]);
    assert.deepEqual(summary.byCategory.map((item) => [item.category, item.spendingMinor, item.count]), [
      ['Merchandise', 4500, 1],
      ['Restaurant', 3000, 1],
      ['Work lunch', 2000, 1],
      [CARD_UNCATEGORIZED, 0, 2],
    ]);
  });

  it('lists the top merchants, grouping descriptor variants, and sums the rest', () => {
    const rows = ['A', 'B', 'C', 'D'].map((name, index) => row({ description: `MERCHANT ${name}`, amountMinor: (index + 1) * 100 }));
    rows.push(row({ description: 'MERCHANT A #114 SEATTLE WA', merchant: 'Merchant A Inc', amountMinor: 50 }));
    const summary = summarizeCardSpending(rows, { topMerchants: 2 });
    assert.deepEqual(summary.byMerchant.map((item) => [item.merchant, item.merchantKey, item.spendingMinor]), [
      ['MERCHANT D', 'MERCHANT D', 400],
      ['MERCHANT C', 'MERCHANT C', 300],
    ]);
    assert.deepEqual(summary.otherMerchants, [
      { currency: 'USD', merchants: 2, spendingMinor: 350, chargesMinor: 350, creditsMinor: 0, count: 3 },
    ]);
    const all = summarizeCardSpending(rows);
    assert.deepEqual(all.byMerchant.find((item) => item.merchantKey === 'MERCHANT A'), {
      merchant: 'MERCHANT A', merchantKey: 'MERCHANT A', currency: 'USD', spendingMinor: 150, chargesMinor: 150, creditsMinor: 0, count: 2,
    });
  });

  /** A row as the transaction list gives it without a category filter: its role, and its merchant's name and key. */
  const listed = (item: CardSpendingRow) => ({
    status: item.status, role: cardSpendingExclusionOf(item) ? 'excluded' : cardSpendingRole(item.kind), currency: item.currency,
    merchantName: effectiveCardMerchant(item), merchantKey: cardMerchantKey(effectiveCardMerchant(item)), amountMinor: item.amountMinor,
  });

  it('reads the merchants behind the rest from the list\'s rows: grouped and named as the summary, adding up to it', () => {
    const rows = ['A', 'B', 'C', 'D'].map((name, index) => row({ description: `MERCHANT ${name}`, amountMinor: (index + 1) * 100 }));
    rows.push(row({ description: 'MERCHANT A #114 SEATTLE WA', merchant: 'Merchant A Inc', amountMinor: 50 }));
    // Never a merchant's: pending, a card payment, an asset purchase. Another currency's keys are grouped with them all.
    rows.push(row({ description: 'MERCHANT E', status: 'pending', amountMinor: 900 }));
    rows.push(row({ description: 'AUTOPAY PAYMENT', kind: 'payment', amountMinor: -5_000 }));
    rows.push(row({ description: 'MERCHANT F', userCategory: 'Precious metals', amountMinor: 70_000 }));
    rows.push(row({ description: 'MERCHANT B', currency: 'CAD', amountMinor: 999 }));
    const summary = summarizeCardSpending(rows, { topMerchants: 2 });
    const whole = { complete: true };
    const others = cardSpendingOtherMerchants(rows.map(listed), summary.byMerchant, 'USD', whole);
    assert.deepEqual(others.merchants.map((item) => [item.merchant, item.merchantKey, item.spendingMinor, item.count, item.rows.map((one) => one.amountMinor)]), [
      ['MERCHANT B', 'MERCHANT B', 200, 1, [200]],
      ['MERCHANT A', 'MERCHANT A', 150, 2, [100, 50]],
    ]);
    const rest = summary.otherMerchants.find((item) => item.currency === 'USD')!;
    assert.deepEqual([others.merchants.length, others.count, others.spendingMinor], [rest.merchants, rest.count, rest.spendingMinor]);
    // In CAD its one merchant is listed by name: nothing is behind the rest.
    assert.deepEqual(cardSpendingOtherMerchants(rows.map(listed), summary.byMerchant, 'CAD', whole), { merchants: [], spendingMinor: 0, count: 0 });
    // Under a category filter the summary counts what each row put in the category, as the list gives it.
    const part = cardSpendingOtherMerchants([{ ...listed(row({ description: 'MERCHANT G', amountMinor: 1_000 })), categoryPortionMinor: 600 }], [], 'USD', whole);
    assert.deepEqual(part.merchants.map((item) => [item.merchant, item.spendingMinor, item.count]), [['MERCHANT G', 600, 1]]);
  });

  it('never shows a listed merchant among the rest when the read stops before its own rows', () => {
    // Newest first, as the list reads them: a store's charges, then the merchant's own older ones past the cut.
    const rows = [
      ...['2026-09-28', '2026-09-27', '2026-09-26'].map((transactionDate) => row({ description: 'NORTHWIND GROCER SEATTLE', amountMinor: 4_000, transactionDate })),
      row({ description: 'FABRIKAM BAKERY', amountMinor: 500, transactionDate: '2026-09-20' }),
      ...['2026-09-02', '2026-09-01'].map((transactionDate) => row({ description: 'NORTHWIND GROCER', amountMinor: 6_000, transactionDate })),
      row({ description: 'TAILSPIN CINEMA', amountMinor: 300, transactionDate: '2026-09-01' }),
    ];
    // The summary reads every row: the store is the grocer's, and the grocer is listed.
    const summary = summarizeCardSpending(rows, { topMerchants: 1 });
    assert.deepEqual(summary.byMerchant.map((item) => [item.merchantKey, item.spendingMinor, item.count]), [['NORTHWIND GROCER', 24_000, 5]]);
    const rest = (items: ReturnType<typeof cardSpendingOtherMerchants>) => items.merchants.map((item) => [item.merchant, item.spendingMinor, item.count]);
    // Every page: the summary's own rest.
    assert.deepEqual(rest(cardSpendingOtherMerchants(rows.map(listed), summary.byMerchant, 'USD', { complete: true })), [['FABRIKAM BAKERY', 500, 1], ['TAILSPIN CINEMA', 300, 1]]);
    // Cut after the bakery: the store's rows stay the listed grocer's, never a merchant of their own among the rest.
    const read = rows.slice(0, 4).map(listed);
    assert.deepEqual(rest(cardSpendingOtherMerchants(read, summary.byMerchant, 'USD', { complete: false })), [['FABRIKAM BAKERY', 500, 1]]);
    // Taken for every page, the same rows would put the grocer's store among the rest: why a read says if it was cut.
    assert.deepEqual(rest(cardSpendingOtherMerchants(read, summary.byMerchant, 'USD', { complete: true })), [['NORTHWIND GROCER SEATTLE', 12_000, 3], ['FABRIKAM BAKERY', 500, 1]]);
  });

  it('never shows a listed merchant among the rest, wherever a read stops, on generated rows', () => {
    const merchants = ['NORTHWIND GROCER', 'FABRIKAM BAKERY', 'PROSEWARE BISTRO', 'LUCERNE OUTFITTERS', 'TAILSPIN CINEMA', 'FOURTH COFFEE', 'WINGTIP TOYS'];
    const variants = ['', ' SEATTLE', ' PORTLAND', ' RETURN'];
    let cuts = 0;
    let stores = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const next = seededRandom(seed);
      const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)];
      const rows = Array.from({ length: 60 }, () => row({
        description: `${pick(merchants)}${pick(variants)}`, amountMinor: 100 + Math.floor(next() * 9_000), currency: next() < 0.15 ? 'EUR' : 'USD',
        transactionDate: `2026-09-${String(1 + Math.floor(next() * 28)).padStart(2, '0')}`,
      })).sort((a, b) => (a.transactionDate < b.transactionDate ? 1 : a.transactionDate > b.transactionDate ? -1 : 0));
      const views = rows.map(listed);
      // What the summary files each key under, from every row.
      const truth = groupCardMerchantKeys(views.map((view) => view.merchantKey));
      const summary = summarizeCardSpending(rows, { topMerchants: 3 });
      for (const currency of ['USD', 'EUR']) {
        const named = new Set(summary.byMerchant.filter((item) => item.currency === currency).map((item) => item.merchantKey));
        const whole = cardSpendingOtherMerchants(views, summary.byMerchant, currency, { complete: true });
        const rest = summary.otherMerchants.find((item) => item.currency === currency);
        assert.deepEqual([whole.merchants.length, whole.count, whole.spendingMinor], [rest?.merchants ?? 0, rest?.count ?? 0, rest?.spendingMinor ?? 0], `seed ${seed} ${currency}`);
        for (const cut of [3, 8, 15, 30, 45]) {
          const read = views.slice(0, cut);
          const shown = cardSpendingOtherMerchants(read, summary.byMerchant, currency, { complete: false });
          for (const item of shown.merchants) {
            for (const one of item.rows) assert.ok(!named.has(truth.get(one.merchantKey)!), `seed ${seed} ${currency} cut ${cut}: ${one.merchantKey}`);
          }
          // How often the read alone would have filed a listed merchant's row apart.
          const alone = groupCardMerchantKeys(read.map((view) => view.merchantKey));
          stores += read.filter((view) => view.currency === currency && named.has(truth.get(view.merchantKey)!) && !named.has(alone.get(view.merchantKey)!)).length;
          cuts += 1;
        }
      }
    }
    assert.ok(stores > 0, `${stores} rows of listed merchants read without their own key, in ${cuts} cuts`);
  });

  it('reads exactly the summary\'s other merchants on generated ledgers, in each currency', () => {
    let merchants = 0;
    for (let seed = 1; seed <= 8; seed += 1) {
      const ledger = syntheticSpendingLedger({ seed, months: 14, foreign: seed % 2 === 0 });
      const month = ledger.lastMonth;
      for (const rows of [ledger.rows, ledger.rows.filter((item) => item.transactionDate.startsWith(month))]) {
        const every = summarizeCardSpending(rows, { topMerchants: Number.MAX_SAFE_INTEGER });
        for (const top of [0, 3]) {
          const summary = summarizeCardSpending(rows, { topMerchants: top });
          for (const currency of ['USD', 'EUR']) {
            const label = `seed ${seed} ${rows.length} rows top ${top} ${currency}`;
            const others = cardSpendingOtherMerchants(rows.map(listed), summary.byMerchant, currency, { complete: true });
            const rest = summary.otherMerchants.find((item) => item.currency === currency);
            assert.deepEqual([others.merchants.length, others.count, others.spendingMinor], [rest?.merchants ?? 0, rest?.count ?? 0, rest?.spendingMinor ?? 0], label);
            assert.deepEqual(
              others.merchants.map((item) => [item.merchantKey, item.merchant, item.spendingMinor, item.count]),
              every.byMerchant.filter((item) => item.currency === currency).slice(top).map((item) => [item.merchantKey, item.merchant, item.spendingMinor, item.count]),
              label,
            );
            merchants += others.merchants.length;
          }
        }
      }
    }
    assert.ok(merchants > 100, `${merchants} merchants`);
  });

  it('groups by card and owner, leaving unknown accounts out of the owner view', () => {
    const summary = summarizeCardSpending([
      row({ cardAccountId: 'card-acct-a', amountMinor: 100 }),
      row({ cardAccountId: 'card-acct-b', amountMinor: 300 }),
      row({ cardAccountId: 'card-acct-c', amountMinor: 200 }),
      row({ cardAccountId: 'card-acct-x', amountMinor: 50 }),
    ], { owners });
    assert.deepEqual(summary.byCard.map((item) => [item.cardAccountId, item.spendingMinor]), [
      ['card-acct-b', 300], ['card-acct-c', 200], ['card-acct-a', 100], ['card-acct-x', 50],
    ]);
    assert.deepEqual(summary.byOwner.map((item) => [item.owner, item.spendingMinor]), [['casey', 300], ['joint', 200], ['alex', 100]]);
  });

  it('returns empty lists for no rows', () => {
    assert.deepEqual(summarizeCardSpending([]), {
      totals: [], pending: [], byMonth: [], byMonthOwner: [], byCategory: [], byMerchant: [], otherMerchants: [], byCard: [], byOwner: [],
    });
  });

  it('totals pending rows separately and never counts them as spending', () => {
    const rows = [
      row({ amountMinor: 1000, transactionDate: '2026-09-01' }),
      row({ cardAccountId: 'card-acct-b', amountMinor: 500, status: 'pending', transactionDate: '2026-10-02' }),
      row({ cardAccountId: 'card-acct-b', amountMinor: -9000, status: 'pending', kind: 'payment', transactionDate: '2026-10-03' }),
    ];
    const summary = summarizeCardSpending(rows, { owners });
    assert.equal(summary.totals[0].spendingMinor, 1000);
    assert.equal(summary.totals[0].paymentsMinor, 0);
    assert.deepEqual(summary.pending, [{ currency: 'USD', count: 2, netMinor: -8500, chargesMinor: 500, creditsMinor: -9000 }]);
    assert.deepEqual(summary.byMonth.map((item) => [item.month, item.spendingMinor]), [['2026-09', 1000]]);
    assert.deepEqual(summary.byMonthOwner.map((item) => [item.month, item.owner, item.spendingMinor]), [['2026-09', 'alex', 1000]]);
    assert.deepEqual(summary.byCard.map((item) => item.cardAccountId), ['card-acct-a']);
  });
});

describe('amounts and views', () => {
  it('reads a plain amount search as minor units of each currency', () => {
    assert.equal(parseCardAmountQuery('12.34', 'USD'), 1234);
    assert.equal(parseCardAmountQuery('$12', 'USD'), 1200);
    assert.equal(parseCardAmountQuery(' 1,234.5 ', 'USD'), 123450);
    assert.equal(parseCardAmountQuery('12.340', 'USD'), 1234);
    assert.equal(parseCardAmountQuery('12.345', 'USD'), null);
    assert.equal(parseCardAmountQuery('1500', 'JPY'), 1500);
    assert.equal(parseCardAmountQuery('1500.5', 'JPY'), null);
    assert.equal(parseCardAmountQuery('1.234', 'KWD'), 1234);
    for (const text of ['', 'coffee', '-12', '12,34', '1e3', '12.', '.5x', '12345678901']) {
      assert.equal(parseCardAmountQuery(text, 'USD'), null, text);
    }
    assert.equal(cardMinorToMajor(-1234, 'USD'), -12.34);
    assert.equal(cardMinorToMajor(1500, 'JPY'), 1500);
  });

  it('lists rows without dedupe keys, with the category, merchant and role they are reported under', () => {
    const stored: CardTransaction = {
      id: 'card-txn-a', cardAccountId: 'card-acct-a', source: 'test', fingerprint: 'cfp1:abc', transactionDate: '2026-09-10',
      status: 'posted', amountMinor: -500, currency: 'USD', kind: 'refund', description: 'SAMPLE STORE REFUND',
      issuerCategory: 'Merchandise', createdAt: 'x', updatedAt: 'x',
    };
    const view = toCardTransactionView(stored);
    assert.equal('fingerprint' in view, false);
    assert.equal('externalIdHash' in view, false);
    assert.equal(view.category, 'Merchandise');
    assert.equal(view.merchantName, 'SAMPLE STORE REFUND');
    assert.equal(view.merchantKey, 'SAMPLE STORE REFUND');
    assert.equal(view.role, 'spending');
  });
});

describe('card coverage ranges', () => {
  it('joins overlapping and adjacent ranges and keeps gaps', () => {
    assert.deepEqual(mergeCardCoverage([
      { start: '2026-03-01', end: '2026-03-31' },
      { start: '2026-01-01', end: '2026-01-31' },
      { start: '2026-02-01', end: '2026-02-10' },
      { start: '2026-01-15', end: '2026-01-20' },
      { start: '2026-03-15', end: '2026-04-02' },
      { start: '2026-05-01', end: '2026-04-01' },
      { start: 'bad', end: '2026-04-01' },
    ]), [
      { start: '2026-01-01', end: '2026-02-10' },
      { start: '2026-03-01', end: '2026-04-02' },
    ]);
    assert.deepEqual(mergeCardCoverage([{ start: '2024-02-28', end: '2024-02-28' }, { start: '2024-02-29', end: '2024-03-01' }]), [
      { start: '2024-02-28', end: '2024-03-01' },
    ]);
  });

  it('tells whether a range is already covered', () => {
    const covered = [{ start: '2026-01-01', end: '2026-01-31' }, { start: '2026-02-01', end: '2026-02-28' }];
    assert.equal(cardCoverageContains(covered, { start: '2026-01-20', end: '2026-02-05' }), true);
    assert.equal(cardCoverageContains(covered, { start: '2026-02-20', end: '2026-03-01' }), false);
    assert.equal(cardCoverageContains([], { start: '2026-02-20', end: '2026-02-20' }), false);
  });
});
describe('primaryCardCurrency', () => {
  // Synthetic cards: most in dollars, the joint one in euros.
  const accounts: Array<{ id: string; owner: CardOwner; currency: string }> = [
    { id: 'card-acct-a', owner: 'alex', currency: 'USD' },
    { id: 'card-acct-b', owner: 'casey', currency: 'USD' },
    { id: 'card-acct-c', owner: 'casey', currency: 'USD' },
    { id: 'card-acct-d', owner: 'joint', currency: 'EUR' },
  ];

  it('follows the person in view, not every card', () => {
    assert.equal(primaryCardCurrency(accounts), 'USD');
    assert.equal(primaryCardCurrency(accounts, { owner: 'joint' }), 'EUR');
    assert.equal(primaryCardCurrency(accounts, { owner: 'casey' }), 'USD');
  });

  it('follows the card in view, with or without its person', () => {
    assert.equal(primaryCardCurrency(accounts, { cardAccountId: 'card-acct-d' }), 'EUR');
    assert.equal(primaryCardCurrency(accounts, { owner: 'joint', cardAccountId: 'card-acct-d' }), 'EUR');
    // Someone else's card: no card is in view.
    assert.equal(primaryCardCurrency(accounts, { owner: 'alex', cardAccountId: 'card-acct-d' }), 'USD');
  });

  it('breaks ties alphabetically and falls back to USD when no card is in view', () => {
    const withPounds = [...accounts, { id: 'card-acct-e', owner: 'joint' as CardOwner, currency: 'GBP' }];
    assert.equal(primaryCardCurrency(withPounds, { owner: 'joint' }), 'EUR');
    assert.equal(primaryCardCurrency([], { owner: 'joint' }), 'USD');
    assert.equal(primaryCardCurrency([{ id: 'card-acct-f', owner: 'alex', currency: 'JPY' }]), 'JPY');
  });
});
