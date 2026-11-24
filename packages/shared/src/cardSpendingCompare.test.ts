import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CardCategoryPart } from './cardCategoryParts.js';
import { cardSpendingExclusionOf, cardSpendingRole, effectiveCardCategory, effectiveCardMerchant, summarizeCardSpending } from './cardSpending.js';
import {
  CARD_OVERVIEW_TOP_MERCHANTS,
  apportionMinor,
  cardSpendingLineRows,
  cardSpendingOtherLines,
  cardSpendingTrend,
  cardSpendingWindow,
  classifyCardSpending,
  compareCardSpending,
  type CardSpendingWindow,
} from './cardSpendingCompare.js';
import { cardMerchantKey } from './cardMerchants.js';
import { splitLargeCardPurchases } from './cardInsights.js';
import { addMonths, daysIn, seededRandom, syntheticSpendingLedger, type SyntheticCardRow } from './__fixtures__/syntheticSpendingLedger.js';

// Synthetic ledgers only (__fixtures__/syntheticSpendingLedger.ts).

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const monthRange = (month: string) => ({ from: `${month}-01`, to: `${month}-${String(daysIn(month)).padStart(2, '0')}` });
const within = (date: string, range: { from: string; to: string }) => date >= range.from && date <= range.to;

/**
 * Item parts for the marketplace rows, as a reviewed category source would accept them: an item part in another
 * category and the rest of the charge (its residual) under the row's own, adding up to the row to the cent.
 */
function marketplaceParts(rows: readonly SyntheticCardRow[], seed: number): Map<string, CardCategoryPart[]> {
  const next = seededRandom(seed * 7919);
  const parts = new Map<string, CardCategoryPart[]>();
  for (const row of rows) {
    if (!row.description.startsWith('SAMPLE MARKETPLACE') || row.status !== 'posted' || next() < 0.3) continue;
    const item = Math.trunc(row.amountMinor * (0.4 + next() * 0.5));
    const itemCategory = next() < 0.5 ? 'Merchandise & Supplies-Groceries' : 'Merchandise & Supplies-Furnishing';
    parts.set(row.id, [
      { category: itemCategory, amountMinor: item, categorySource: 'agent-classification', classification: 'source' },
      { category: row.issuerCategory ?? 'Uncategorized', amountMinor: row.amountMinor - item, categorySource: 'original-effective', classification: 'residual' },
    ]);
  }
  return parts;
}

function expectWindowAddsUp(window: CardSpendingWindow, label: string) {
  assert.equal(window.recurringMinor + window.oneOffMinor + window.everydayMinor, window.spendingMinor, `${label}: split`);
  assert.equal(window.chargesMinor + window.creditsMinor, window.spendingMinor, `${label}: charges and credits`);
  assert.equal(sum(window.categories.map((line) => line.amountMinor)), window.spendingMinor, `${label}: categories`);
  assert.equal(sum(window.categories.map((line) => line.oneOffMinor)), window.oneOffMinor, `${label}: category one-offs`);
  assert.equal(sum(window.categories.map((line) => line.recurringMinor)), window.recurringMinor, `${label}: category recurring`);
  assert.equal(window.oneOffs.grossMinor + window.oneOffs.refundsMinor, window.oneOffMinor, `${label}: one-offs`);
  assert.equal(sum(window.oneOffs.items.map((item) => item.amountMinor)), window.oneOffs.grossMinor, `${label}: one-off items`);
  assert.ok(window.oneOffs.refundsMinor <= 0, `${label}: refunds of one-offs`);
  assert.equal(sum(window.recurring.map((line) => line.amountMinor)), window.recurringMinor, `${label}: recurring merchants`);
  for (const line of window.categories) {
    assert.equal(line.oneOffMinor + line.recurringMinor + line.everydayMinor, line.amountMinor, `${label} ${line.category}: split`);
    const merchants = [...line.merchants, ...(line.otherMerchants ? [line.otherMerchants] : [])];
    assert.equal(sum(merchants.map((item) => item.amountMinor)), line.amountMinor, `${label} ${line.category}: merchants`);
    assert.equal(sum(merchants.map((item) => item.oneOffMinor)), line.oneOffMinor, `${label} ${line.category}: merchant one-offs`);
    assert.equal(sum(merchants.map((item) => item.recurringMinor)), line.recurringMinor, `${label} ${line.category}: merchant recurring`);
    assert.ok(line.merchants.length <= CARD_OVERVIEW_TOP_MERCHANTS);
  }
}

describe('apportioning a minor amount', () => {
  it('adds up exactly, follows the weights of its sign, and never gives a part more than its weight', () => {
    const next = seededRandom(17);
    for (let round = 0; round < 500; round += 1) {
      const weights = Array.from({ length: 1 + Math.floor(next() * 5) }, () => -Math.floor(next() * 10_000) - 1);
      const whole = -sum(weights);
      const total = -Math.floor(next() * (whole + 1));
      const shares = apportionMinor(total, weights);
      assert.equal(sum(shares), total);
      shares.forEach((share, index) => assert.ok(share <= 0 && share >= weights[index], `${share} of ${weights[index]}`));
    }
    assert.deepEqual(apportionMinor(-10, [-1, -1, -1]), [-4, -3, -3]);
    assert.deepEqual(apportionMinor(-5, [-7, 3]), [-5, 0]);
    assert.deepEqual(apportionMinor(0, [-4, -6]), [0, 0]);
    assert.deepEqual(apportionMinor(7, []), []);
  });
});

describe('the overview of a period on generated ledgers', () => {
  it('reports the summary\'s totals and categories, and every split adds up to the cent', () => {
    for (let seed = 1; seed <= 16; seed += 1) {
      const ledger = syntheticSpendingLedger({ seed, months: 20, foreign: seed % 4 === 0 });
      const parts = seed % 2 === 0 ? marketplaceParts(ledger.rows, seed) : undefined;
      for (const offset of [1, 4, 13]) {
        const month = addMonths(ledger.lastMonth, -offset);
        const current = monthRange(month);
        const classification = classifyCardSpending(ledger.rows, {
          currency: 'USD', through: current.to, today: `${ledger.lastMonth}-15`, categoryParts: parts, splitIds: new Set(parts?.keys() ?? []),
        });
        const window = cardSpendingWindow(classification, current);
        const summary = summarizeCardSpending(ledger.rows.filter((row) => within(row.transactionDate, current)), { categoryParts: parts });
        const totals = summary.totals.find((item) => item.currency === 'USD');
        assert.deepEqual(
          [window.spendingMinor, window.chargesMinor, window.creditsMinor, window.count],
          [totals?.spendingMinor ?? 0, totals?.chargesMinor ?? 0, totals?.creditsMinor ?? 0, totals?.count ?? 0],
          `seed ${seed} ${month}: totals`,
        );
        assert.deepEqual(
          window.categories.map((line) => [line.category, line.amountMinor]).sort(),
          summary.byCategory.filter((item) => item.currency === 'USD').map((item) => [item.category, item.spendingMinor]).sort(),
          `seed ${seed} ${month}: categories`,
        );
        expectWindowAddsUp(window, `seed ${seed} ${month}`);
        // The owner's precious metals are not spending, so never a one-off; a recurring charge never is either.
        for (const item of window.oneOffs.items) {
          const row = ledger.rows.find((candidate) => candidate.id === item.id)!;
          assert.equal(cardSpendingExclusionOf(row), null);
          assert.ok(row.amountMinor >= classification.thresholdMinor);
        }
        // Item parts: what they put in each category, never more than the category.
        for (const line of window.categories) {
          const items = sum([...(parts ?? new Map<string, CardCategoryPart[]>())].filter(([id]) => {
            const row = ledger.rows.find((candidate) => candidate.id === id)!;
            return within(row.transactionDate, current) && row.currency === 'USD' && row.status === 'posted';
          }).flatMap(([, rowParts]) => rowParts.filter((part) => part.classification !== 'residual' && part.category === line.category).map((part) => part.amountMinor)));
          assert.equal(line.itemsMinor, items, `seed ${seed} ${month} ${line.category}: items`);
        }
      }
    }
  });

  it('puts recurring charges, one-offs and everyday spending in exactly one part each', () => {
    for (let seed = 1; seed <= 8; seed += 1) {
      const ledger = syntheticSpendingLedger({ seed, months: 18 });
      const through = `${ledger.lastMonth}-${daysIn(ledger.lastMonth)}`;
      const classification = classifyCardSpending(ledger.rows, { currency: 'USD', through });
      const recurring = classification.counted.filter((item) => item.recurring);
      assert.ok(recurring.length > 0, `seed ${seed} has recurring charges`);
      assert.ok(recurring.every((item) => !item.large && item.oneOffMinor === 0 && item.row.kind === 'purchase'));
      assert.ok(recurring.some((item) => item.row.description === 'SAMPLE STREAMING'), `seed ${seed}: the streaming bill recurs`);
      const split = splitLargeCardPurchases(ledger.rows, { currency: 'USD', through });
      assert.deepEqual(classification.counted.filter((item) => item.large).map((item) => item.row.id).sort(),
        split.large.filter((item) => item.row.status === 'posted').map((item) => item.row.id).sort());
    }
  });

  it('keeps a category filter\'s portions consistent: the categories\' one-offs add up to the whole view\'s', () => {
    for (let seed = 2; seed <= 16; seed += 2) {
      const ledger = syntheticSpendingLedger({ seed, months: 20 });
      // Refunds of split rows, so a refund's part set against a one-off is apportioned over its categories.
      const parts = marketplaceParts(ledger.rows, seed);
      const current = { from: `${addMonths(ledger.lastMonth, -12)}-01`, to: `${ledger.lastMonth}-${daysIn(ledger.lastMonth)}` };
      const options = { currency: 'USD', through: current.to, categoryParts: parts, splitIds: new Set(parts.keys()) };
      const whole = cardSpendingWindow(classifyCardSpending(ledger.rows, options), current);
      const categories = whole.categories.map((line) => line.category);
      let oneOffs = 0;
      let spending = 0;
      for (const category of categories) {
        // As the summary's view reads a category filter: a split row for its part in the category, a whole row by its own.
        const portions = new Map<string, CardCategoryPart[]>();
        const shown = ledger.rows.flatMap((row) => {
          const rowParts = parts.get(row.id);
          if (!rowParts) return effectiveCardCategory(row) === category ? [row] : [];
          const portion = sum(rowParts.filter((part) => part.category === category).map((part) => part.amountMinor));
          if (portion === 0) return [];
          portions.set(row.id, [{ category, amountMinor: portion, categorySource: 'original-effective', classification: 'source' }]);
          return [{ ...row, amountMinor: portion }];
        });
        const window = cardSpendingWindow(classifyCardSpending(shown, {
          ...options, categoryParts: portions, fullParts: parts, detectionRows: ledger.rows,
        }), current);
        expectWindowAddsUp(window, `seed ${seed} ${category}`);
        const line = whole.categories.find((item) => item.category === category)!;
        assert.deepEqual([window.spendingMinor, window.oneOffMinor, window.recurringMinor, window.categories[0]?.itemsMinor ?? 0],
          [line.amountMinor, line.oneOffMinor, line.recurringMinor, line.itemsMinor], `seed ${seed} ${category}`);
        oneOffs += window.oneOffMinor;
        spending += window.spendingMinor;
      }
      assert.equal(oneOffs, whole.oneOffMinor);
      assert.equal(spending, whole.spendingMinor);
    }
  });

  it('sets a split refund against a split one-off category by category, to the cent', () => {
    const ledger = syntheticSpendingLedger({ seed: 3, months: 6 });
    const card = ledger.cards[0].id;
    const base = { cardAccountId: card, status: 'posted' as const, currency: 'USD', description: 'SAMPLE MARKETPLACE*ZZ99YY', merchant: null };
    const purchase: SyntheticCardRow = { ...base, id: 'syn-big-order', transactionDate: `${ledger.lastMonth}-03`, kind: 'purchase', amountMinor: 2_000_001,
      issuerCategory: 'Merchandise & Supplies-Internet Purchase' };
    const refund: SyntheticCardRow = { ...base, id: 'syn-big-return', transactionDate: `${ledger.lastMonth}-09`, kind: 'refund', amountMinor: -700_003,
      issuerCategory: 'Merchandise & Supplies-Internet Purchase' };
    const part = (category: string, amountMinor: number, classification: 'source' | 'residual'): CardCategoryPart =>
      ({ category, amountMinor, categorySource: classification === 'source' ? 'agent-classification' : 'original-effective', classification });
    const parts = new Map<string, CardCategoryPart[]>([
      [purchase.id, [part('Electronics', 1_500_000, 'source'), part('Furnishing', 400_000, 'source'), part('Merchandise & Supplies-Internet Purchase', 100_001, 'residual')]],
      [refund.id, [part('Electronics', -500_000, 'source'), part('Furnishing', -200_002, 'source'), part('Merchandise & Supplies-Internet Purchase', -1, 'residual')]],
    ]);
    const rows = [...ledger.rows, purchase, refund];
    const current = monthRange(ledger.lastMonth);
    const options = { currency: 'USD', through: current.to, categoryParts: parts, splitIds: new Set(parts.keys()) };
    const whole = cardSpendingWindow(classifyCardSpending(rows, options), current);
    assert.ok(whole.oneOffs.items.some((item) => item.id === purchase.id));
    const refundShares = classifyCardSpending(rows, options).entries.filter((entry) => entry.rowId === refund.id);
    assert.equal(sum(refundShares.map((entry) => entry.oneOffMinor)), -700_003);
    assert.deepEqual(refundShares.map((entry) => [entry.category, entry.oneOffMinor]).sort(),
      [['Electronics', -500_000], ['Furnishing', -200_002], ['Merchandise & Supplies-Internet Purchase', -1]].sort());
    for (const category of ['Electronics', 'Furnishing', 'Merchandise & Supplies-Internet Purchase']) {
      const portion = (row: SyntheticCardRow) => sum(parts.get(row.id)!.filter((item) => item.category === category).map((item) => item.amountMinor));
      const shown = [{ ...purchase, amountMinor: portion(purchase) }, { ...refund, amountMinor: portion(refund) }];
      const portions = new Map(shown.map((row) => [row.id, [{ category, amountMinor: row.amountMinor, categorySource: 'original-effective', classification: 'source' } satisfies CardCategoryPart]]));
      const window = cardSpendingWindow(classifyCardSpending(shown, { ...options, categoryParts: portions, fullParts: parts, detectionRows: rows }), current);
      assert.equal(window.oneOffMinor, portion(purchase) + portion(refund), category);
      expectWindowAddsUp(window, category);
    }
  });
});

describe('comparing a period with its baseline on generated ledgers', () => {
  it('splits the change exactly: one-offs + drivers + everything else, and each driver into its merchants', () => {
    let drivers = 0;
    for (let seed = 1; seed <= 16; seed += 1) {
      const ledger = syntheticSpendingLedger({ seed, months: 20 });
      const parts = seed % 2 === 0 ? marketplaceParts(ledger.rows, seed) : undefined;
      for (const [currentMonth, baselineMonth] of [
        [addMonths(ledger.lastMonth, -1), addMonths(ledger.lastMonth, -2)],
        [addMonths(ledger.lastMonth, -1), addMonths(ledger.lastMonth, -13)],
      ]) {
        const current = monthRange(currentMonth);
        const baseline = monthRange(baselineMonth);
        const comparison = compareCardSpending(ledger.rows, {
          currency: 'USD', through: current.to, today: `${ledger.lastMonth}-20`, current, baseline, categoryParts: parts, splitIds: new Set(parts?.keys() ?? []),
        });
        const label = `seed ${seed} ${currentMonth} vs ${baselineMonth}`;
        expectWindowAddsUp(comparison.current, `${label} current`);
        expectWindowAddsUp(comparison.baseline, `${label} baseline`);
        const summaryOf = (range: { from: string; to: string }) =>
          summarizeCardSpending(ledger.rows.filter((row) => within(row.transactionDate, range)), { categoryParts: parts }).totals
            .find((item) => item.currency === 'USD')?.spendingMinor ?? 0;
        assert.equal(comparison.current.spendingMinor, summaryOf(current), label);
        assert.equal(comparison.baseline.spendingMinor, summaryOf(baseline), label);
        assert.equal(comparison.deltaMinor, summaryOf(current) - summaryOf(baseline), label);
        assert.equal(comparison.oneOffDeltaMinor, comparison.current.oneOffMinor - comparison.baseline.oneOffMinor);
        assert.equal(comparison.oneOffDeltaMinor + sum(comparison.drivers.map((driver) => driver.deltaMinor)) + comparison.remainder.deltaMinor,
          comparison.deltaMinor, `${label}: the change`);
        // Everything else is the other categories' change, not a plug.
        const withoutOneOffs = (window: CardSpendingWindow) => new Map(window.categories.map((line) => [line.category, line.amountMinor - line.oneOffMinor]));
        const now = withoutOneOffs(comparison.current);
        const before = withoutOneOffs(comparison.baseline);
        const named = new Set(comparison.drivers.map((driver) => driver.category));
        const others = [...new Set([...now.keys(), ...before.keys()])].filter((category) => !named.has(category))
          .map((category) => (now.get(category) ?? 0) - (before.get(category) ?? 0));
        assert.equal(comparison.remainder.deltaMinor, sum(others), `${label}: everything else`);
        assert.equal(comparison.remainder.categories, others.filter((delta) => delta !== 0).length);
        for (const driver of comparison.drivers) {
          drivers += 1;
          assert.equal(driver.deltaMinor, driver.currentMinor - driver.baselineMinor);
          assert.equal(driver.currentMinor, now.get(driver.category) ?? 0);
          assert.equal(driver.baselineMinor, before.get(driver.category) ?? 0);
          assert.equal(sum(driver.merchants.map((item) => item.deltaMinor)) + driver.otherMerchants.deltaMinor, driver.deltaMinor, `${label} ${driver.category}`);
          assert.ok(driver.merchants.every((item) => item.deltaMinor === item.currentMinor - item.baselineMinor && item.deltaMinor !== 0));
        }
        // Largest change first.
        const sizes = comparison.drivers.map((driver) => Math.abs(driver.deltaMinor));
        assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
      }
    }
    assert.ok(drivers > 40);
  });

  it('keeps one-offs out of the drivers: a one-off moves only the one-off line', () => {
    const ledger = syntheticSpendingLedger({ seed: 5, months: 14 });
    const current = monthRange(addMonths(ledger.lastMonth, -1));
    const baseline = monthRange(addMonths(ledger.lastMonth, -2));
    const options = { currency: 'USD', through: current.to, current, baseline };
    const before = compareCardSpending(ledger.rows, options);
    const extra: SyntheticCardRow = {
      id: 'syn-extra-one-off', cardAccountId: ledger.cards[0].id, transactionDate: `${current.from.slice(0, 7)}-14`, status: 'posted',
      kind: 'purchase', amountMinor: 5_000_000, currency: 'USD', description: 'SAMPLE PIANO GALLERY', merchant: null,
      issuerCategory: 'Merchandise & Supplies-General Retail',
    };
    const after = compareCardSpending([...ledger.rows, extra], options);
    assert.equal(after.deltaMinor - before.deltaMinor, 5_000_000);
    assert.equal(after.oneOffDeltaMinor - before.oneOffDeltaMinor, 5_000_000);
    assert.ok(after.current.oneOffs.items.some((item) => item.id === 'syn-extra-one-off'));
    assert.ok(!after.drivers.some((driver) => driver.merchants.some((merchant) => merchant.key === 'SAMPLE PIANO GALLERY')));
  });
});

describe('the drill-down\'s rows of a merchant line', () => {
  /** A row as the list gives it, without a category filter (a whole row's amount is in its own category). */
  const listed = (row: SyntheticCardRow) => ({
    row, id: row.id, status: row.status, role: cardSpendingExclusionOf(row) ? 'excluded' : cardSpendingRole(row.kind), currency: row.currency,
    merchantName: effectiveCardMerchant(row), merchantKey: cardMerchantKey(effectiveCardMerchant(row)), amountMinor: row.amountMinor,
  });
  /**
   * The rows the list gives for a category in a window: a split row (`split`) for what its parts put there, as
   * `categoryPortionMinor`, only when that is not zero; a whole row by its own category.
   */
  const listedIn = (rows: readonly SyntheticCardRow[], range: { from: string; to: string }, category: string,
    parts: ReadonlyMap<string, readonly CardCategoryPart[]>) => rows.filter((row) => within(row.transactionDate, range)).flatMap((row) => {
    const rowParts = parts.get(row.id);
    if (!rowParts) return effectiveCardCategory(row) === category ? [listed(row)] : [];
    const portion = sum(rowParts.filter((part) => part.category === category).map((part) => part.amountMinor));
    return portion === 0 ? [] : [{ ...listed(row), split: rowParts, categoryPortionMinor: portion }];
  });

  it('are exactly the line\'s rows among its category\'s, on generated ledgers', () => {
    let lines = 0;
    for (let seed = 1; seed <= 8; seed += 1) {
      const ledger = syntheticSpendingLedger({ seed, months: 14, foreign: seed % 2 === 0 });
      const current = monthRange(addMonths(ledger.lastMonth, -1));
      const comparison = compareCardSpending(ledger.rows, { currency: 'USD', through: current.to, current, baseline: monthRange(addMonths(ledger.lastMonth, -2)) });
      const inWindow = ledger.rows.filter((row) => within(row.transactionDate, current)).map(listed);
      for (const category of comparison.current.categories) {
        const rows = inWindow.filter((item) => effectiveCardCategory(item.row) === category.category);
        for (const merchant of category.merchants) {
          const picked = cardSpendingLineRows(rows, merchant, 'USD');
          assert.equal(picked.sumMinor, merchant.amountMinor, `seed ${seed} ${category.category} / ${merchant.key}`);
          assert.equal(picked.rows.length, merchant.count);
          lines += 1;
        }
      }
    }
    assert.ok(lines > 40, `${lines} lines`);
  });

  it('keep to the line\'s merchant group, and split rows to the items line', () => {
    const base = { status: 'posted', role: 'spending', currency: 'USD', amountMinor: 1_000 };
    const rows = [
      { ...base, id: 'seattle', merchantKey: cardMerchantKey('NORTHWIND GROCER SEATTLE'), amountMinor: 5_000 },
      { ...base, id: 'portland', merchantKey: cardMerchantKey('NORTHWIND GROCER PORTLAND'), amountMinor: 7_000 },
      { ...base, id: 'other', merchantKey: cardMerchantKey('NORTHWIND GROCERY OUTLET') },
      { ...base, id: 'pending', status: 'pending', merchantKey: cardMerchantKey('NORTHWIND GROCER') },
      { ...base, id: 'euro', currency: 'EUR', merchantKey: cardMerchantKey('NORTHWIND GROCER') },
      { ...base, id: 'items', merchantKey: cardMerchantKey('NORTHWIND GROCER'), categoryPortionMinor: 600, split: [] },
    ];
    const whole = cardSpendingLineRows(rows, { key: 'NORTHWIND GROCER', itemized: false }, 'USD');
    assert.deepEqual([whole.rows.map((row) => row.id), whole.sumMinor], [['seattle', 'portland'], 12_000]);
    // Under a view of one store, the list already holds only that store's rows: the line stays that store's.
    const store = cardSpendingLineRows(rows.filter((row) => row.id !== 'portland'), { key: 'NORTHWIND GROCER', itemized: false }, 'USD');
    assert.deepEqual([store.rows.map((row) => row.id), store.sumMinor], [['seattle'], 5_000]);
    const items = cardSpendingLineRows(rows, { key: 'NORTHWIND GROCER', itemized: true }, 'USD');
    assert.deepEqual([items.rows.map((row) => row.id), items.sumMinor], [['items'], 600]);
  });

  it('behind "other merchants" are exactly the lines not named, each with the rows its line picks, on generated ledgers', () => {
    let rest = 0;
    let itemized = 0;
    for (let seed = 1; seed <= 8; seed += 1) {
      const ledger = syntheticSpendingLedger({ seed, months: 14, foreign: seed % 2 === 0 });
      const parts = seed % 2 === 0 ? marketplaceParts(ledger.rows, seed) : new Map<string, CardCategoryPart[]>();
      const current = monthRange(addMonths(ledger.lastMonth, -1));
      const options = {
        currency: 'USD', through: current.to, current, baseline: monthRange(addMonths(ledger.lastMonth, -2)),
        categoryParts: parts, splitIds: new Set(parts.keys()),
      };
      // Every line of each category, in the window's order: the rest is what follows the named ones.
      const every = compareCardSpending(ledger.rows, { ...options, topMerchants: Number.MAX_SAFE_INTEGER }).current;
      for (const top of [0, 1, 2]) {
        for (const category of compareCardSpending(ledger.rows, { ...options, topMerchants: top }).current.categories) {
          const label = `seed ${seed} top ${top} ${category.category}`;
          const rows = listedIn(ledger.rows, current, category.category, parts);
          const others = cardSpendingOtherLines(rows, category.merchants, 'USD');
          const all = every.categories.find((line) => line.category === category.category)!.merchants;
          assert.deepEqual(
            others.lines.map((line) => [line.key, line.itemized, line.amountMinor, line.count]),
            all.slice(top).map((line) => [line.key, line.itemized, line.amountMinor, line.count]),
            label,
          );
          const otherMerchants = category.otherMerchants ?? { lines: 0, count: 0, amountMinor: 0 };
          assert.deepEqual([others.lines.length, others.count, others.sumMinor], [otherMerchants.lines, otherMerchants.count, otherMerchants.amountMinor], label);
          for (const line of others.lines) {
            assert.deepEqual(line.rows, cardSpendingLineRows(rows, line, 'USD').rows, `${label} / ${line.key}`);
            assert.ok(line.rows.some((row) => row.merchantName === line.name), `${label} / ${line.key}: named by its rows`);
            if (line.itemized) itemized += 1;
          }
          rest += others.lines.length;
        }
      }
    }
    assert.ok(rest > 50, `${rest} lines`);
    assert.ok(itemized > 4, `${itemized} items lines`);
  });

  it('behind "other merchants" leave out only the named lines: a merchant\'s items line stays apart from its whole rows', () => {
    const base = { status: 'posted', role: 'spending', currency: 'USD', amountMinor: 1_000 };
    const at = (name: string) => ({ merchantName: name, merchantKey: cardMerchantKey(name) });
    const rows = [
      { ...base, id: 'seattle', ...at('NORTHWIND GROCER SEATTLE'), amountMinor: 5_000 },
      { ...base, id: 'items', ...at('NORTHWIND GROCER'), categoryPortionMinor: 600, split: [] },
      { ...base, id: 'outlet', ...at('Lucerne Outfitters'), amountMinor: 2_000 },
      { ...base, id: 'outlet-return', ...at('LUCERNE OUTFITTERS'), amountMinor: -500 },
      { ...base, id: 'outlet-again', ...at('Lucerne Outfitters'), amountMinor: 1_500 },
      { ...base, id: 'bistro', ...at('PROSEWARE BISTRO'), amountMinor: 3_000 },
      // Never on a line: not posted, another currency, not spending.
      { ...base, id: 'pending', status: 'pending', ...at('PROSEWARE BISTRO') },
      { ...base, id: 'euro', currency: 'EUR', ...at('PROSEWARE BISTRO') },
      { ...base, id: 'metals', role: 'excluded', ...at('PROSEWARE BISTRO') },
    ];
    const others = cardSpendingOtherLines(rows, [{ key: 'NORTHWIND GROCER', itemized: false }], 'USD');
    // As the window orders lines: by amount, then by charges.
    assert.deepEqual(others.lines.map((line) => [line.key, line.name, line.itemized, line.amountMinor, line.count, line.rows.map((row) => row.id)]), [
      ['LUCERNE OUTFITTERS', 'Lucerne Outfitters', false, 3_000, 3, ['outlet', 'outlet-return', 'outlet-again']],
      ['PROSEWARE BISTRO', 'PROSEWARE BISTRO', false, 3_000, 1, ['bistro']],
      ['NORTHWIND GROCER', 'NORTHWIND GROCER', true, 600, 1, ['items']],
    ]);
    assert.deepEqual([others.sumMinor, others.count], [6_600, 5]);
    // Nothing named: every line is behind it; every line named: none.
    assert.equal(cardSpendingOtherLines(rows, [], 'USD').sumMinor, 11_600);
    const everyLine = [{ key: 'NORTHWIND GROCER', itemized: false }, ...others.lines.map(({ key, itemized }) => ({ key, itemized }))];
    assert.deepEqual(cardSpendingOtherLines(rows, everyLine, 'USD').lines, []);
  });
});

describe('the monthly trend on generated ledgers', () => {
  it('is the summary\'s months, each split into recurring, one-offs and everyday spending', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const ledger = syntheticSpendingLedger({ seed, months: 16, foreign: seed % 3 === 0 });
      const months = Array.from({ length: 12 }, (_, index) => addMonths(ledger.lastMonth, index - 11));
      const classification = classifyCardSpending(ledger.rows, { currency: 'USD', through: `${ledger.lastMonth}-${daysIn(ledger.lastMonth)}` });
      const trend = cardSpendingTrend(classification, months);
      const summary = summarizeCardSpending(ledger.rows);
      for (const item of trend) {
        const month = summary.byMonth.find((entry) => entry.currency === 'USD' && entry.month === item.month);
        assert.equal(item.spendingMinor, month?.spendingMinor ?? 0, `seed ${seed} ${item.month}`);
        assert.equal(item.count, month?.count ?? 0);
        assert.equal(item.recurringMinor + item.oneOffMinor + item.everydayMinor, item.spendingMinor);
      }
      // Rows outside every month shown are not in it, and pending or excluded rows never are.
      const counted = ledger.rows.filter((row) => row.currency === 'USD' && row.status === 'posted' && cardSpendingRole(row.kind) === 'spending'
        && !cardSpendingExclusionOf(row) && row.transactionDate >= `${months[0]}-01` && row.transactionDate <= `${ledger.lastMonth}-31`);
      assert.equal(sum(trend.map((item) => item.spendingMinor)), sum(counted.map((row) => row.amountMinor)));
    }
  });
});
