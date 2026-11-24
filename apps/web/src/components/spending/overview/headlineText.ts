/**
 * The words of the Spending tab's headline, pure so they can be tested: what the headline total is called, whose
 * cards it covers, the one comparison it makes (only between windows the coverage rule says are comparable, else
 * "Not comparable" with both figures labelled), and what is not in the total. A window with no card data is never
 * shown as $0, and no percentage is said.
 */
import { CARD_INSIGHT_THRESHOLDS, type CardAccount, type CardOwner, type CardPendingTotals, type CardSpendingTotals } from '@finance-tracker/shared';

import { cardOptionLabel, formatMinor, formatRowAmount, longDate, OWNER_LABELS, type SpendingPeriodRange } from '../spendingFormat';
import { comparisonSentence, windowReasons, type OverviewComparisonWindow, type OverviewPeriod, type SentenceWindow } from './overviewText';

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "Spent in September so far", "Spent in August 2024", "Spent in the last 90 days". */
export function headlineLabel(period: Pick<OverviewPeriod, 'name'>): string {
  return `Spent in ${period.name}`;
}

/** Said after the total of a period still going whose name doesn't already say so ("so far"); none otherwise. */
export function soFarMarker(period: Pick<OverviewPeriod, 'name' | 'inProgress'>): string | null {
  return period.inProgress && !/\b(?:so far|to date)$/.test(period.name) ? 'so far' : null;
}

/** Whose cards a figure covers: the card chosen, a person's cards, or all of them. */
export function scopeWords(view: { owner?: CardOwner | ''; card?: CardAccount | null }): string {
  if (view.card) return cardOptionLabel(view.card);
  if (view.owner === 'joint') return 'Joint cards';
  if (view.owner) return `${OWNER_LABELS[view.owner]}'s cards`;
  return 'All cards';
}

/** What the total is: posted charges, after refunds (with how much, when there were any). */
export function headlineBasis(creditsMinor: number, currency: string): string {
  const credits = -creditsMinor || 0;
  return credits > 0 ? `Posted, after ${formatMinor(credits, currency)} in refunds` : 'Posted, after refunds';
}

/** What is known of a window's card record, as far as its figure needs it. */
export interface WindowRecord {
  cardsWithData: number;
  cardsCovered: number;
  cardsExpected: number;
}

/**
 * A window's figure is known, a zero included, only when posted spending is recorded in it (`rows`), or when every card
 * expected in it is recorded for all of it. A pending row or a part of the dates recorded is not enough: $0 would be a
 * claim the record doesn't make.
 */
export function figureKnown(rows: number, record: WindowRecord): boolean {
  return rows > 0 || (record.cardsExpected > 0 && record.cardsCovered === record.cardsExpected);
}

/**
 * What an unknown window is called: "No card data" when no card in view was there then (before the record reaches
 * back), "Not recorded" when a card was but its spending then is not on record.
 */
export function unknownText(record: WindowRecord): string {
  return record.cardsExpected === 0 ? 'No card data' : 'Not recorded';
}

/** A window's figure: its amount when it is known, else what is missing. */
export function windowFigure(amountMinor: number, rows: number, record: WindowRecord, currency: string): string {
  return figureKnown(rows, record) ? formatMinor(amountMinor, currency) : unknownText(record);
}

/**
 * The headline figure, from the period's summary: "—" until it is in; its amount when posted spending is recorded;
 * with none, $0 only when every card expected is recorded for the whole period (a genuine zero), else what is missing
 * ("No card data", "Not recorded"), "—" while that is not known yet, and "No posted spending" when it can't be read.
 */
export function headlineFigure(input: {
  amountMinor: number | null;
  rows: number;
  record: WindowRecord | null;
  recordFailed: boolean;
  currency: string;
}): string {
  if (input.amountMinor === null) return '—';
  if (input.rows > 0 || input.amountMinor !== 0) return formatMinor(input.amountMinor, input.currency);
  if (input.record) return windowFigure(0, 0, input.record, input.currency);
  return input.recordFailed ? 'No posted spending' : '—';
}

/** The comparison the headline makes: the one with the baseline the tab's period names (as the insights do), else the first. */
export function headlineComparisonWindow(period: Pick<OverviewPeriod, 'comparisons'>, previous: SpendingPeriodRange['previous']): OverviewComparisonWindow | null {
  const named = previous
    ? period.comparisons.find((item) => item.baselineFrom === previous.from && item.baselineTo === previous.to)
    : undefined;
  return named ?? period.comparisons[0] ?? null;
}

/** A window as a comparison reads it: its record says what its figure is worth. */
export type ComparedWindow = SentenceWindow;

export interface FigureRow {
  key: 'current' | 'baseline';
  label: string;
  figure: string;
}

export type HeadlineComparison =
  | { kind: 'compared'; text: string; tone: 'more' | 'less' | 'same'; baseline: FigureRow }
  | {
    kind: 'notComparable';
    /** In a few words, after "Not comparable: ". */
    reason: string;
    /** Both figures, labelled; a window with no card data says so. */
    rows: FigureRow[];
    /** Why, each in a few words: each window that may be incomplete, and the card counts when they differ. */
    why: Array<{ about: 'current' | 'baseline' | 'both'; text: string }>;
  };

/**
 * The one comparison, by the coverage rule (comparisonSentence): "$2,550.00 more than July" only when both windows are
 * complete with data from as many cards; otherwise "Not comparable" with the reason that matters most, both figures
 * labelled and why. Never a percentage, and never "no spending" for a window with no card data.
 */
export function headlineComparison(
  current: ComparedWindow,
  baseline: ComparedWindow,
  options: { currency: string; periodName: string; baselineName: string },
): HeadlineComparison {
  const { currency, periodName, baselineName } = options;
  const sentence = comparisonSentence(current, baseline, options);
  const rows: FigureRow[] = [
    { key: 'current', label: capitalize(periodName), figure: windowFigure(current.spendingMinor, current.count, current.coverage, currency) },
    { key: 'baseline', label: capitalize(baselineName), figure: windowFigure(baseline.spendingMinor, baseline.count, baseline.coverage, currency) },
  ];
  if (sentence.bothKnown && sentence.tone !== 'none') {
    return { kind: 'compared', text: sentence.text, tone: sentence.tone, baseline: rows[1] };
  }
  const why = [
    ...windowReasons(current).map((text) => ({ about: 'current' as const, text: `${capitalize(periodName)}: ${text}` })),
    ...windowReasons(baseline).map((text) => ({ about: 'baseline' as const, text: `${capitalize(baselineName)}: ${text}` })),
    ...sentence.notes.filter((note) => note.about === 'both').map((note) => ({ about: 'both' as const, text: note.text })),
  ];
  return { kind: 'notComparable', reason: notComparableReason(current, baseline, options), rows, why };
}

/** What keeps two windows apart, the reason that matters most first: no data, still going, incomplete, unlike cards. */
export function notComparableReason(current: ComparedWindow, baseline: ComparedWindow, names: { periodName: string; baselineName: string }): string {
  const missing = (window: ComparedWindow, name: string) => (window.coverage.cardsExpected === 0 ? `no card data for ${name}` : `no record for ${name}`);
  if (!figureKnown(baseline.count, baseline.coverage)) return missing(baseline, names.baselineName);
  if (!figureKnown(current.count, current.coverage)) return missing(current, names.periodName);
  if (current.coverage.inProgress) return 'this period is still in progress';
  if (windowReasons(baseline).length > 0) return `${names.baselineName} may be incomplete`;
  if (windowReasons(current).length > 0) return `${names.periodName} may be incomplete`;
  return 'the two periods have data from different numbers of cards';
}

/** One line of "Not in this total": its amount, then what it is. */
export interface OutRow {
  key: 'pending' | 'payments' | 'metals' | 'other';
  amount: string;
  text: string;
  /** A suggestion said under it (card payments that brokerage cash may have paid). */
  note: string | null;
}

/**
 * What the view's posted spending leaves out, from the same summary as the total: pending charges (not posted, so not
 * in it), card payments (transfers), precious metals the owner bought (an asset) and other rows (cash advances and the
 * like). Only what there is; none when nothing is left out. Each says what is true now, never what will happen.
 */
export function notInTotalRows(input: {
  totals: Pick<CardSpendingTotals, 'paymentsMinor' | 'paymentCount' | 'otherMinor' | 'otherCount' | 'assetPurchasesMinor' | 'assetPurchaseCount'> | undefined;
  pending: Pick<CardPendingTotals, 'count' | 'netMinor'> | undefined;
  paidFromBrokerage: number;
  currency: string;
}): OutRow[] {
  const { totals, pending, currency } = input;
  const rows: OutRow[] = [];
  if (pending && pending.count > 0) {
    // What is true now: not posted, so not in the total. A hold may change or vanish before it posts.
    rows.push({ key: 'pending', amount: formatRowAmount(pending.netMinor, currency), text: `pending · ${pending.count} not posted yet; not included`, note: null });
  }
  if (totals && totals.paymentCount > 0) {
    rows.push({
      key: 'payments',
      amount: formatMinor(-totals.paymentsMinor || 0, currency),
      text: `card payments · ${plural(totals.paymentCount, 'transfer')}, not spending`,
      note: input.paidFromBrokerage > 0 ? `${input.paidFromBrokerage} possibly paid from brokerage cash` : null,
    });
  }
  if (totals?.assetPurchaseCount) {
    rows.push({ key: 'metals', amount: formatMinor(totals.assetPurchasesMinor ?? 0, currency), text: 'precious metals bought · not counted', note: null });
  }
  if (totals && totals.otherCount > 0) {
    rows.push({ key: 'other', amount: formatRowAmount(totals.otherMinor, currency), text: `other, not counted · ${plural(totals.otherCount, 'cash advance or the like', 'cash advances and the like')}`, note: null });
  }
  return rows;
}

/** The Insights and Recurring panels read the cards in view, not the list's filters. */
export const FILTER_SCOPE = 'Ignores search and category/merchant filters; person and card apply';

/** The recurring charges' actual period: as of today, from their lookback (a yearly one's is longer). */
export function recurringPeriod(today: string): string {
  const { recurringLookbackDays: days, recurringAnnualLookbackDays: yearly } = CARD_INSIGHT_THRESHOLDS;
  return `As of ${longDate(today)}, from the last ${days} days of charges (${yearly} days for yearly ones)`;
}

/** "3 matching charges": the list's rows for the filters in use. */
export function matchingText(count: number): string {
  return `${count.toLocaleString('en-US')} matching ${count === 1 ? 'charge' : 'charges'}`;
}

/** The imported dates' folded line: how many cards, and gaps when there are any. */
export function coverageSummary(cards: number, gaps: number): string {
  return gaps > 0 ? `${plural(cards, 'card')} · ${plural(gaps, 'gap')}` : plural(cards, 'card');
}
