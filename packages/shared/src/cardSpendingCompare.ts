/**
 * Spending's overview in one currency: a period's true spend (spending as counted: asset purchases, transfers and
 * `other` rows aside), split into recurring charges, large one-offs and everyday spending, by category and merchant;
 * and what changed against a baseline: large one-offs apart, then the categories that moved the rest, each with the
 * merchants behind it, and everything else. Pure and deterministic.
 *
 * Accounting (exact, in integer minor units of the currency; the tests prove each identity):
 * - a window's spending, charges, credits and count are the spending summary's totals for the same rows, and its
 *   categories are the summary's `byCategory` (a split row counts under its parts' categories);
 * - recurring + one-offs + everyday = spending, for a window, a category and a merchant line;
 * - a window's categories add up to its spending, and a category's merchant lines (with "other merchants") to it;
 * - one-offs are the insights' large purchases (`splitLargeCardPurchases`: one threshold as of the period's last day)
 *   dated in the window, less the parts of refunds dated in the window that were set against large purchases (with
 *   `orderLinks`, a credit with a decisive order link only against one of its orders' charges); a refund's part is
 *   apportioned over its categories by largest remainder, so its categories still add up to it;
 * - recurring charges are the purchases of the insights' recurring series (`findRecurringCardSeries`, as of today),
 *   never a large one-off;
 * - the change: the one-offs' change + the drivers' changes + everything else = current − baseline spending.
 *
 * Merchant lines are keyed by the merchant's group root (`cardMerchantGroupRoot`): the transaction list's `merchant`
 * filter with that key finds the line's rows (under a view's own merchant filter, the list keeps that filter and
 * `cardSpendingLineRows` picks the line's rows, so a narrower merchant is never widened); a split row (Amazon items)
 * is a line of its own beside the merchant's whole rows, as the list marks it with `split`. The lines behind a
 * category's "other merchants" are picked the same way from the list's rows for the category (`cardSpendingOtherLines`).
 */
import { findRecurringCardSeries, splitLargeCardPurchases, type CardInsightRow, type CardOrderLinks } from './cardInsights.js';
import type { CardCategoryPart } from './cardCategoryParts.js';
import {
  cardCategoryPartTotals, cardSpendingExclusionOf, cardSpendingRole, effectiveCardCategory, effectiveCardMerchant,
  type CardCategoryAmount, type CardSpendingExclusion,
} from './cardSpending.js';
import { cardMerchantDisplayNames, cardMerchantGroupRoot, cardMerchantKey } from './cardMerchants.js';

/** Merchants named per category; the rest are summed into `otherMerchants`. */
export const CARD_OVERVIEW_TOP_MERCHANTS = 8;
/** Categories named as drivers of a change; the rest are "everything else". */
export const CARD_OVERVIEW_TOP_DRIVERS = 5;
/** Merchants named behind a driver; the rest of its change is `otherMerchants`. */
export const CARD_OVERVIEW_DRIVER_MERCHANTS = 3;

/** Inclusive YYYY-MM-DD bounds. */
export interface CardSpendingRange {
  from: string;
  to: string;
}

export interface CardSpendingClassifyOptions {
  currency: string;
  /** Large one-offs are judged as of this day (the period's last day), as the insights judge a period's. */
  through: string;
  /** Recurring charges as of this day (default `through`). */
  today?: string;
  /** Asset purchases by row id (cardSpendingExclusions.ts): not spending, so never classified. */
  exclusions?: ReadonlyMap<string, CardSpendingExclusion>;
  /**
   * Category parts per row id, as the summary files the rows (its `categoryParts`). Under a category filter the rows'
   * amounts and these parts are the category's portions.
   */
  categoryParts?: ReadonlyMap<string, readonly CardCategoryAmount[]>;
  /**
   * Every part of each split row, with how it was classified: which part of a refund in a category was set against
   * large one-offs, and what item parts put in each category. Default `categoryParts`.
   */
  fullParts?: ReadonlyMap<string, readonly (CardCategoryAmount & Partial<Pick<CardCategoryPart, 'classification'>>)[]>;
  /** Rows the answer files through parts (the list marks them `split`): their merchant lines are their own. */
  splitIds?: ReadonlySet<string>;
  /** Where large one-offs and recurring charges are found: every row of the cards in view, every date (default the rows). */
  detectionRows?: readonly CardInsightRow[];
  /**
   * Order links (the Amazon domain's), the household's. A credit with a decisive order link (one of its orders has a
   * charge linked to a card row) is set only against a large one-off that is one of those charges; without this, and
   * for any other credit, refunds go by the merchant rule alone.
   */
  orderLinks?: CardOrderLinks;
}

/** One merchant's amount in one category: a whole-row line, or its split rows' (`itemized`). */
export interface CardSpendingMerchantLine {
  /** The merchant's group root: the list's `merchant` filter with it finds the line's rows; `cardSpendingLineRows` picks them. */
  key: string;
  name: string;
  /** Split rows (Amazon items): the list shows them with `split`. */
  itemized: boolean;
  amountMinor: number;
  oneOffMinor: number;
  recurringMinor: number;
  /** Rows with an amount in the category. */
  count: number;
}

export interface CardSpendingCategoryLine {
  category: string;
  amountMinor: number;
  oneOffMinor: number;
  recurringMinor: number;
  everydayMinor: number;
  count: number;
  /** What item parts (not a charge's rest) put here: a part of `amountMinor`, as the summary's `fromAmazonItems`. */
  itemsMinor: number;
  /** The largest merchant lines, at most {@link CARD_OVERVIEW_TOP_MERCHANTS}. */
  merchants: CardSpendingMerchantLine[];
  /** The rest, so the lines add up to the category; null when every line is named. */
  otherMerchants: { amountMinor: number; oneOffMinor: number; recurringMinor: number; lines: number; count: number } | null;
}

/** A large one-off purchase in a window. */
export interface CardSpendingOneOff {
  id: string;
  date: string;
  /** The row's own merchant name, and its merchant group root. */
  merchant: string;
  key: string;
  /** Its amount in this answer (under a category filter, a split row's part in the category). */
  amountMinor: number;
  /** Refunds set against it so far, whatever their date (the insights' rule). */
  refundedMinor: number;
  /** The category with most of its amount. */
  category: string;
}

export interface CardSpendingWindow extends CardSpendingRange {
  /** As the summary's totals count them. */
  spendingMinor: number;
  chargesMinor: number;
  creditsMinor: number;
  count: number;
  /** recurring + one-offs + everyday = spending. */
  recurringMinor: number;
  oneOffMinor: number;
  everydayMinor: number;
  /** The large purchases dated in the window (largest first) and the refunds dated in it that were set against any. */
  oneOffs: { count: number; grossMinor: number; refundsMinor: number; items: CardSpendingOneOff[] };
  /** Recurring charges dated in the window, per merchant, largest first. */
  recurring: Array<{ key: string; name: string; amountMinor: number; count: number }>;
  /** Largest first, as the summary's `byCategory`. */
  categories: CardSpendingCategoryLine[];
}

/** A merchant behind a driver's change. */
export interface CardSpendingDriverMerchant {
  key: string;
  name: string;
  itemized: boolean;
  currentMinor: number;
  baselineMinor: number;
  deltaMinor: number;
}

/** A category whose spending without large one-offs moved, with the merchants behind it. */
export interface CardSpendingDriver {
  category: string;
  currentMinor: number;
  baselineMinor: number;
  deltaMinor: number;
  /** The merchants that moved it most, at most {@link CARD_OVERVIEW_DRIVER_MERCHANTS}. */
  merchants: CardSpendingDriverMerchant[];
  /** The rest of its change, so the merchants add up to it. */
  otherMerchants: { deltaMinor: number; lines: number };
}

export interface CardSpendingComparison {
  currency: string;
  /** Purchases at or above this, not at a recurring merchant, are large one-offs (as of the period's last day). */
  thresholdMinor: number;
  current: CardSpendingWindow;
  baseline: CardSpendingWindow;
  /** current − baseline spending. */
  deltaMinor: number;
  /** current − baseline one-offs. */
  oneOffDeltaMinor: number;
  /** The categories that moved spending without one-offs most, largest change first. */
  drivers: CardSpendingDriver[];
  /** Everything else: oneOffDeltaMinor + the drivers' changes + this = deltaMinor. */
  remainder: { deltaMinor: number; categories: number };
}

export interface CardSpendingTrendMonth {
  month: string;
  spendingMinor: number;
  recurringMinor: number;
  oneOffMinor: number;
  everydayMinor: number;
  count: number;
}

/** One row's amount in one category, and how much of it is a one-off or recurring. */
export interface CardSpendingEntry {
  rowId: string;
  date: string;
  category: string;
  key: string;
  itemized: boolean;
  amountMinor: number;
  oneOffMinor: number;
  recurringMinor: number;
  itemsMinor: number;
}

/** A counted row (posted spending in the currency), as a whole. */
export interface CardSpendingClassifiedRow {
  row: CardInsightRow;
  key: string;
  large: boolean;
  recurring: boolean;
  oneOffMinor: number;
  refundedMinor: number;
}

/** The rows classified once, for any window of the answer. */
export interface CardSpendingClassification {
  currency: string;
  thresholdMinor: number;
  counted: CardSpendingClassifiedRow[];
  entries: CardSpendingEntry[];
  names: ReadonlyMap<string, string>;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const within = (date: string, range: CardSpendingRange) => date >= range.from && date <= range.to;

/**
 * `total` split over `weights` in integers that add up to it exactly: in proportion to the weights of its own sign
 * (all of them when none has it), the largest remainders first and then the earliest weight.
 */
export function apportionMinor(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sign = Math.sign(total);
  const same = weights.map((weight) => (Math.sign(weight) === sign ? Math.abs(weight) : 0));
  const basis = same.some((weight) => weight > 0) ? same : weights.map((weight) => Math.abs(weight));
  const whole = basis.reduce((sum, weight) => sum + weight, 0);
  if (whole === 0) return weights.map((_, index) => (index === 0 ? total : 0));
  const magnitude = Math.abs(total);
  const raw = basis.map((weight) => (magnitude * weight) / whole);
  const shares = raw.map((value) => Math.floor(value));
  let left = magnitude - shares.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) {
    if (left === 0) break;
    shares[index] += 1;
    left -= 1;
  }
  return shares.map((share) => (sign < 0 ? -share : share) || 0);
}

function categoryAmounts(row: CardInsightRow, parts: ReadonlyMap<string, readonly CardCategoryAmount[]> | undefined): Array<[string, number]> {
  const rowParts = parts?.get(row.id);
  return rowParts ? [...cardCategoryPartTotals(rowParts)] : [[effectiveCardCategory(row), row.amountMinor]];
}

/**
 * Classifies `rows` (the answer's rows, any dates and statuses: posted spending rows in the currency count, asset
 * purchases aside) into one-offs, recurring charges and everyday spending, per category.
 */
export function classifyCardSpending(rows: readonly CardInsightRow[], options: CardSpendingClassifyOptions): CardSpendingClassification {
  const { currency, exclusions } = options;
  const today = options.today ?? options.through;
  const detection = options.detectionRows ?? rows;
  const split = splitLargeCardPurchases(detection, { currency, through: options.through, today, exclusions, orderLinks: options.orderLinks });
  const refunded = new Map(split.large.map((item) => [item.row.id, item.refundedMinor]));
  // The same rows the split reads: a recurring charge's purchase is at a recurring merchant, so never a large one-off.
  const inCurrency = detection.filter((row) => row.currency === currency && !cardSpendingExclusionOf(row, exclusions));
  const recurringIds = new Set(findRecurringCardSeries(inCurrency, today).flatMap((series) => series.rowIds));
  const fullParts: CardSpendingClassifyOptions['fullParts'] = options.fullParts ?? options.categoryParts;

  const counted: CardSpendingClassifiedRow[] = [];
  const entries: CardSpendingEntry[] = [];
  const named: Array<{ key: string; name: string }> = [];
  for (const row of rows) {
    if (row.currency !== currency || row.status !== 'posted' || cardSpendingRole(row.kind) !== 'spending') continue;
    if (cardSpendingExclusionOf(row, exclusions)) continue;
    const name = effectiveCardMerchant(row);
    const key = cardMerchantGroupRoot(cardMerchantKey(name));
    named.push({ key, name });
    const amounts = categoryAmounts(row, options.categoryParts);
    const large = refunded.has(row.id);
    const setAgainst = split.refundsSetAgainstLarge.get(row.id) ?? 0;
    // A refund's part set against large one-offs, apportioned over all its categories, then read in the ones shown.
    const shares = new Map<string, number>();
    if (!large && setAgainst > 0) {
      const full = fullParts?.has(row.id) ? categoryAmounts(row, fullParts) : amounts;
      apportionMinor(-setAgainst, full.map(([, amount]) => amount)).forEach((share, index) => shares.set(full[index][0], share));
    }
    const recurring = !large && recurringIds.has(row.id);
    const itemized = options.splitIds?.has(row.id) ?? false;
    const items = new Map<string, number>();
    for (const part of fullParts?.get(row.id) ?? []) {
      if (part.classification === undefined || part.classification === 'residual') continue;
      items.set(part.category, (items.get(part.category) ?? 0) + part.amountMinor);
    }
    let rowOneOff = 0;
    for (const [category, amountMinor] of amounts) {
      const oneOffMinor = large ? amountMinor : shares.get(category) ?? 0;
      rowOneOff += oneOffMinor;
      entries.push({
        rowId: row.id, date: row.transactionDate, category, key, itemized, amountMinor, oneOffMinor,
        recurringMinor: recurring ? amountMinor - oneOffMinor : 0, itemsMinor: items.get(category) ?? 0,
      });
    }
    counted.push({ row, key, large, recurring, oneOffMinor: rowOneOff, refundedMinor: refunded.get(row.id) ?? 0 });
  }
  const groups = new Map(named.map((item) => [item.key, item.key]));
  return { currency, thresholdMinor: split.thresholdMinor, counted, entries, names: cardMerchantDisplayNames(named, groups) };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** What a classified answer says of one window. */
export function cardSpendingWindow(
  classification: CardSpendingClassification,
  range: CardSpendingRange,
  options: { topMerchants?: number } = {},
): CardSpendingWindow {
  const topMerchants = options.topMerchants ?? CARD_OVERVIEW_TOP_MERCHANTS;
  const rows = classification.counted.filter((item) => within(item.row.transactionDate, range));
  const entries = classification.entries.filter((entry) => within(entry.date, range));
  const amounts = rows.map((item) => item.row.amountMinor);
  const spendingMinor = sum(amounts);
  const oneOffMinor = sum(rows.map((item) => item.oneOffMinor));
  const recurringMinor = sum(rows.filter((item) => item.recurring).map((item) => item.row.amountMinor - item.oneOffMinor));
  const nameOf = (key: string) => classification.names.get(key) ?? key;

  const largeRows = rows.filter((item) => item.large);
  const items: CardSpendingOneOff[] = largeRows.map((item) => {
    const own = entries.filter((entry) => entry.rowId === item.row.id).sort((a, b) => b.amountMinor - a.amountMinor || byText(a.category, b.category));
    return {
      id: item.row.id, date: item.row.transactionDate, merchant: effectiveCardMerchant(item.row), key: item.key,
      amountMinor: item.row.amountMinor, refundedMinor: item.refundedMinor, category: own[0]?.category ?? effectiveCardCategory(item.row),
    };
  }).sort((a, b) => b.amountMinor - a.amountMinor || byText(a.date, b.date) || byText(a.id, b.id));
  const grossMinor = sum(items.map((item) => item.amountMinor));

  const recurring = new Map<string, { key: string; name: string; amountMinor: number; count: number }>();
  for (const item of rows) {
    if (!item.recurring) continue;
    const line = recurring.get(item.key) ?? { key: item.key, name: nameOf(item.key), amountMinor: 0, count: 0 };
    line.amountMinor += item.row.amountMinor - item.oneOffMinor;
    line.count += 1;
    recurring.set(item.key, line);
  }

  const categories = new Map<string, { line: CardSpendingCategoryLine; rows: Set<string>; merchants: Map<string, CardSpendingMerchantLine & { rows: Set<string> }> }>();
  for (const entry of entries) {
    let category = categories.get(entry.category);
    if (!category) {
      category = {
        line: { category: entry.category, amountMinor: 0, oneOffMinor: 0, recurringMinor: 0, everydayMinor: 0, count: 0, itemsMinor: 0, merchants: [], otherMerchants: null },
        rows: new Set(),
        merchants: new Map(),
      };
      categories.set(entry.category, category);
    }
    category.line.amountMinor += entry.amountMinor;
    category.line.oneOffMinor += entry.oneOffMinor;
    category.line.recurringMinor += entry.recurringMinor;
    category.line.itemsMinor += entry.itemsMinor;
    category.rows.add(entry.rowId);
    const lineKey = JSON.stringify([entry.key, entry.itemized]);
    const merchant = category.merchants.get(lineKey)
      ?? { key: entry.key, name: nameOf(entry.key), itemized: entry.itemized, amountMinor: 0, oneOffMinor: 0, recurringMinor: 0, count: 0, rows: new Set<string>() };
    merchant.amountMinor += entry.amountMinor;
    merchant.oneOffMinor += entry.oneOffMinor;
    merchant.recurringMinor += entry.recurringMinor;
    merchant.rows.add(entry.rowId);
    category.merchants.set(lineKey, merchant);
  }
  const lines = [...categories.values()].map(({ line, rows: ids, merchants }) => {
    const sorted = [...merchants.values()].map(({ rows: merchantRows, ...merchant }) => ({ ...merchant, count: merchantRows.size }))
      .sort((a, b) => b.amountMinor - a.amountMinor || b.count - a.count || byText(a.key, b.key) || Number(a.itemized) - Number(b.itemized));
    const rest = sorted.slice(topMerchants);
    return {
      ...line,
      everydayMinor: line.amountMinor - line.oneOffMinor - line.recurringMinor,
      count: ids.size,
      merchants: sorted.slice(0, topMerchants),
      otherMerchants: rest.length === 0 ? null : {
        amountMinor: sum(rest.map((item) => item.amountMinor)),
        oneOffMinor: sum(rest.map((item) => item.oneOffMinor)),
        recurringMinor: sum(rest.map((item) => item.recurringMinor)),
        lines: rest.length,
        count: sum(rest.map((item) => item.count)),
      },
    };
  }).sort((a, b) => b.amountMinor - a.amountMinor || b.count - a.count || byText(a.category, b.category));

  return {
    from: range.from,
    to: range.to,
    spendingMinor,
    chargesMinor: sum(amounts.filter((amount) => amount > 0)),
    creditsMinor: sum(amounts.filter((amount) => amount < 0)),
    count: rows.length,
    recurringMinor,
    oneOffMinor,
    everydayMinor: spendingMinor - oneOffMinor - recurringMinor,
    oneOffs: { count: items.length, grossMinor, refundsMinor: oneOffMinor - grossMinor, items },
    recurring: [...recurring.values()].sort((a, b) => b.amountMinor - a.amountMinor || byText(a.key, b.key)),
    categories: lines,
  };
}

/**
 * The period against its baseline, from one classification of the rows of both (and every row of the cards in view
 * for large one-offs and recurring charges): one-offs apart, the drivers of the rest, and everything else.
 */
export function compareCardSpending(
  rows: readonly CardInsightRow[],
  options: CardSpendingClassifyOptions & {
    current: CardSpendingRange;
    baseline: CardSpendingRange;
    topDrivers?: number;
    topMerchants?: number;
    driverMerchants?: number;
  },
): CardSpendingComparison {
  const classification = classifyCardSpending(rows, options);
  const current = cardSpendingWindow(classification, options.current, { topMerchants: options.topMerchants });
  const baseline = cardSpendingWindow(classification, options.baseline, { topMerchants: options.topMerchants });
  const deltaMinor = current.spendingMinor - baseline.spendingMinor;
  const oneOffDeltaMinor = current.oneOffMinor - baseline.oneOffMinor;

  // Spending without one-offs, per category and per merchant line, in each window.
  const withoutOneOffs = (range: CardSpendingRange) => {
    const byCategory = new Map<string, number>();
    const byLine = new Map<string, Map<string, { key: string; itemized: boolean; amountMinor: number }>>();
    for (const entry of classification.entries) {
      if (!within(entry.date, range)) continue;
      const amount = entry.amountMinor - entry.oneOffMinor;
      byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + amount);
      const lines = byLine.get(entry.category) ?? new Map<string, { key: string; itemized: boolean; amountMinor: number }>();
      const lineKey = JSON.stringify([entry.key, entry.itemized]);
      const line = lines.get(lineKey) ?? { key: entry.key, itemized: entry.itemized, amountMinor: 0 };
      line.amountMinor += amount;
      lines.set(lineKey, line);
      byLine.set(entry.category, lines);
    }
    return { byCategory, byLine };
  };
  const now = withoutOneOffs(options.current);
  const before = withoutOneOffs(options.baseline);
  const changes = [...new Set([...now.byCategory.keys(), ...before.byCategory.keys()])].map((category) => {
    const currentMinor = now.byCategory.get(category) ?? 0;
    const baselineMinor = before.byCategory.get(category) ?? 0;
    return { category, currentMinor, baselineMinor, deltaMinor: currentMinor - baselineMinor };
  }).filter((change) => change.deltaMinor !== 0)
    .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor) || byText(a.category, b.category));
  const topDrivers = options.topDrivers ?? CARD_OVERVIEW_TOP_DRIVERS;
  const driverMerchants = options.driverMerchants ?? CARD_OVERVIEW_DRIVER_MERCHANTS;
  const drivers = changes.slice(0, topDrivers).map((change): CardSpendingDriver => {
    const nowLines = now.byLine.get(change.category) ?? new Map();
    const beforeLines = before.byLine.get(change.category) ?? new Map();
    const merchants = [...new Set([...nowLines.keys(), ...beforeLines.keys()])].map((lineKey) => {
      const line = nowLines.get(lineKey) ?? beforeLines.get(lineKey)!;
      const currentMinor = nowLines.get(lineKey)?.amountMinor ?? 0;
      const baselineMinor = beforeLines.get(lineKey)?.amountMinor ?? 0;
      return {
        key: line.key, name: classification.names.get(line.key) ?? line.key, itemized: line.itemized,
        currentMinor, baselineMinor, deltaMinor: currentMinor - baselineMinor,
      };
    }).filter((merchant) => merchant.deltaMinor !== 0)
      .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor) || byText(a.key, b.key) || Number(a.itemized) - Number(b.itemized));
    const named = merchants.slice(0, driverMerchants);
    return {
      ...change,
      merchants: named,
      otherMerchants: { deltaMinor: change.deltaMinor - sum(named.map((item) => item.deltaMinor)), lines: merchants.length - named.length },
    };
  });
  return {
    currency: classification.currency,
    thresholdMinor: classification.thresholdMinor,
    current,
    baseline,
    deltaMinor,
    oneOffDeltaMinor,
    drivers,
    remainder: {
      // By construction the parts add up to the change; the tests also check this is the other categories' change.
      deltaMinor: deltaMinor - oneOffDeltaMinor - sum(drivers.map((driver) => driver.deltaMinor)),
      categories: changes.length - drivers.length,
    },
  };
}

/** Per month (YYYY-MM), from one classification: spending and its recurring, one-off and everyday parts. */
export function cardSpendingTrend(classification: CardSpendingClassification, months: readonly string[]): CardSpendingTrendMonth[] {
  return months.map((month) => {
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    const window = cardSpendingWindow(classification, { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }, { topMerchants: 0 });
    return {
      month,
      spendingMinor: window.spendingMinor,
      recurringMinor: window.recurringMinor,
      oneOffMinor: window.oneOffMinor,
      everydayMinor: window.everydayMinor,
      count: window.count,
    };
  });
}

/** What a merchant line's rows are picked by, of a row the transaction list returns. */
export interface CardSpendingListedRow {
  status: string;
  role: string;
  currency: string;
  /** `cardMerchantKey` of the row's merchant, as the list gives it. */
  merchantKey: string;
  amountMinor: number;
  /** Under a category filter, what the row put in the category. */
  categoryPortionMinor?: number;
  /** Present on a split row (Amazon items). */
  split?: unknown;
}

/**
 * The rows of one merchant line among the list's rows for its window and category (the list filtered by the view's own
 * merchant when it has one, else by the line's key): posted spending in `currency` whose merchant's group root is the
 * line's key, split rows only on the itemized line; and what they put in the category. Exactly the rows the line
 * counts, so they add up to it; a view's narrower merchant is never widened to the line's group.
 */
export function cardSpendingLineRows<T extends CardSpendingListedRow>(
  rows: readonly T[],
  line: Pick<CardSpendingMerchantLine, 'key' | 'itemized'>,
  currency: string,
): { rows: T[]; sumMinor: number } {
  const kept = rows.filter((row) => row.status === 'posted' && row.role === 'spending' && row.currency === currency
    && (row.split !== undefined) === line.itemized && cardMerchantGroupRoot(row.merchantKey) === line.key);
  return { rows: kept, sumMinor: sum(kept.map((row) => row.categoryPortionMinor ?? row.amountMinor)) };
}

/** A merchant line read from the list's rows: the rows `cardSpendingLineRows` picks for it, and what they put in the category. */
export interface CardSpendingListedLine<T> extends Pick<CardSpendingMerchantLine, 'key' | 'name' | 'itemized' | 'amountMinor' | 'count'> {
  rows: T[];
}

/**
 * The lines behind a category's "other merchants", from the list's rows for its window and category (the list filtered
 * by the view's own merchant when it has one, as for one line): every line of posted spending in `currency` that is not
 * one of the `named` lines, each with exactly the rows `cardSpendingLineRows` picks for it, largest first as the window
 * orders its lines. So they add up to the category's `otherMerchants`: as many lines, as many rows and the amount. A
 * line is named by its rows' most frequent merchant name.
 */
export function cardSpendingOtherLines<T extends CardSpendingListedRow & { merchantName: string }>(
  rows: readonly T[],
  named: ReadonlyArray<Pick<CardSpendingMerchantLine, 'key' | 'itemized'>>,
  currency: string,
): { lines: CardSpendingListedLine<T>[]; sumMinor: number; count: number } {
  const lineId = (key: string, itemized: boolean) => JSON.stringify([key, itemized]);
  const namedIds = new Set(named.map((line) => lineId(line.key, line.itemized)));
  const lines = new Map<string, CardSpendingListedLine<T>>();
  const names: Array<{ key: string; name: string }> = [];
  for (const row of rows) {
    if (row.status !== 'posted' || row.role !== 'spending' || row.currency !== currency) continue;
    const key = cardMerchantGroupRoot(row.merchantKey);
    const itemized = row.split !== undefined;
    const id = lineId(key, itemized);
    if (namedIds.has(id)) continue;
    const line = lines.get(id) ?? { key, name: key, itemized, amountMinor: 0, count: 0, rows: [] };
    line.amountMinor += row.categoryPortionMinor ?? row.amountMinor;
    line.count += 1;
    line.rows.push(row);
    lines.set(id, line);
    names.push({ key, name: row.merchantName });
  }
  const display = cardMerchantDisplayNames(names, new Map(names.map((item) => [item.key, item.key])));
  const sorted = [...lines.values()].map((line) => ({ ...line, name: display.get(line.key) ?? line.key }))
    .sort((a, b) => b.amountMinor - a.amountMinor || b.count - a.count || byText(a.key, b.key) || Number(a.itemized) - Number(b.itemized));
  return { lines: sorted, sumMinor: sum(sorted.map((line) => line.amountMinor)), count: sum(sorted.map((line) => line.count)) };
}
