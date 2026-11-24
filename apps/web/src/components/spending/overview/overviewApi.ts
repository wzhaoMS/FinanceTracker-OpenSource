import type {
  CardSpendingComparison,
  CardSpendingCoverageGaps,
  CardSpendingMonthCoverage,
  CardSpendingRangeCoverage,
  CardSpendingTrendMonth,
  CardSpendingWindow,
} from '@finance-tracker/shared';

import { api } from '../../../services/api';
import type { CardTransactionListRow, CardTransactionPageResponse, SpendingFilters } from '../spendingApi';
import { collectPages } from './overviewLines';

/**
 * Typed calls for the Spending overview. Paths are relative, on the page's own origin, as every API call
 * (services/api.ts); nothing here names a host.
 */

/** A window of `/spending/compare`, with what is known of its card record. */
export interface OverviewWindow extends CardSpendingWindow {
  coverage: CardSpendingRangeCoverage;
}

export interface OverviewComparison extends Omit<CardSpendingComparison, 'current' | 'baseline'> {
  current: OverviewWindow;
  baseline: OverviewWindow;
}

export interface OverviewCompareResponse {
  basis: 'enriched' | 'original';
  comparison: OverviewComparison;
}

export interface OverviewTrendMonth extends CardSpendingTrendMonth {
  coverage: Omit<CardSpendingMonthCoverage, 'month'>;
}

export interface OverviewTrendResponse {
  basis: 'enriched' | 'original';
  currency: string;
  thresholdMinor: number;
  months: OverviewTrendMonth[];
  /** What keeps the months from being complete, by card id and date (cardSpendingCoverageGaps). */
  gaps: CardSpendingCoverageGaps;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** The summary's filters other than its dates: the overview sets those. */
function viewParams(filters: SpendingFilters) {
  return {
    owner: filters.owner,
    cardAccountId: filters.cardAccountId,
    category: filters.category,
    merchant: filters.merchant,
    q: filters.q?.trim() || undefined,
    categoryBasis: filters.categoryBasis,
  };
}

/** The period against one baseline, for the summary's filters; `currency` as the view shows it. */
export function fetchSpendingCompare(
  filters: SpendingFilters,
  windows: { from: string; to: string; baselineFrom: string; baselineTo: string },
  options: { today: string; currency: string },
): Promise<OverviewCompareResponse> {
  const { from, to, baselineFrom, baselineTo } = windows;
  return api<OverviewCompareResponse>(`/spending/compare${query({
    ...viewParams(filters), from, to, baselineFrom, baselineTo, today: options.today, currency: options.currency,
  })}`);
}

/** Months from `fromMonth` through `toMonth`, each split into recurring charges, large one-offs and everyday spending. */
export function fetchSpendingTrend(
  filters: SpendingFilters,
  months: { fromMonth: string; toMonth: string },
  options: { today: string; currency: string },
): Promise<OverviewTrendResponse> {
  return api<OverviewTrendResponse>(`/spending/trend${query({
    ...viewParams(filters), fromMonth: months.fromMonth, toMonth: months.toMonth, today: options.today, currency: options.currency,
  })}`);
}

/** Spending kinds only: card payments and `other` rows are never spending, so never on a line. */
const SPENDING_KINDS = 'purchase,refund,fee,interest,adjustment';

/**
 * Every posted spending row of a window under the view's filters, read to its last page (at most MAX_LINE_PAGES,
 * overviewLines.ts): a `category` or `merchant` given here takes the view's place.
 */
function fetchPostedSpending(
  filters: SpendingFilters,
  narrow: { from: string; to: string; category?: string; merchant?: string },
): Promise<{ rows: CardTransactionListRow[]; total: number; complete: boolean }> {
  const params: Record<string, string | number | undefined> = { ...viewParams(filters), from: narrow.from, to: narrow.to };
  if (narrow.category !== undefined) params.category = narrow.category;
  if (narrow.merchant !== undefined) params.merchant = narrow.merchant;
  return collectPages((offset) => api<CardTransactionPageResponse>(`/card-transactions${query({
    ...params, status: 'posted', kind: SPENDING_KINDS, limit: 200, offset,
  })}`));
}

/**
 * Every posted spending row behind one merchant line of a category, in a window: the drill-down's last level. The
 * view's own merchant filter is kept (a line's rows are within it; the line's group could be wider), else the line's
 * key filters; the list is read to its last page (at most MAX_LINE_PAGES, overviewLines.ts), and the caller picks the
 * line's rows with `cardSpendingLineRows`.
 */
export function fetchLineTransactions(
  filters: SpendingFilters,
  line: { from: string; to: string; category: string; merchant: string },
): Promise<{ rows: CardTransactionListRow[]; total: number; complete: boolean }> {
  return fetchPostedSpending(filters, { from: line.from, to: line.to, category: line.category, merchant: filters.merchant || line.merchant });
}

/**
 * Every posted spending row of one merchant group in a window, whatever its category: the By merchant view's charges,
 * read to the last page as a line's are. The view's own merchant filter is kept, else the group's key filters.
 */
export function fetchMerchantTransactions(
  filters: SpendingFilters,
  merchant: { from: string; to: string; merchant: string },
): Promise<{ rows: CardTransactionListRow[]; total: number; complete: boolean }> {
  return fetchPostedSpending(filters, { from: merchant.from, to: merchant.to, merchant: filters.merchant || merchant.merchant });
}

/**
 * Every posted spending row of one category in a window, within the view's own merchant filter when it has one: what
 * the category's "other merchants" are picked from (`cardSpendingOtherLines`), read to the last page as a line's are.
 */
export function fetchCategoryTransactions(
  filters: SpendingFilters,
  category: { from: string; to: string; category: string },
): Promise<{ rows: CardTransactionListRow[]; total: number; complete: boolean }> {
  return fetchPostedSpending(filters, { from: category.from, to: category.to, category: category.category });
}

/**
 * Every posted spending row of the view in a window: what the By merchant view's "other merchants" are picked from
 * (`cardSpendingOtherMerchants`), read to the last page as a line's are.
 */
export function fetchViewTransactions(
  filters: SpendingFilters,
  window: { from: string; to: string },
): Promise<{ rows: CardTransactionListRow[]; total: number; complete: boolean }> {
  return fetchPostedSpending(filters, { from: window.from, to: window.to });
}
