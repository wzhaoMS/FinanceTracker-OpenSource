import type {
  BenefitCurrentView,
  BenefitFigureSource,
  BenefitIssuerFigure,
  BenefitManualReason,
  BenefitPeriodView,
  BenefitReminder,
  BenefitTotals,
  BenefitView,
  CardBenefitsCardView,
  CardOwner,
} from '@finance-tracker/shared';

import { OWNERS, issuerLabel } from '../spending/spendingFormat';
import type { UsageTier, UsageWindow } from './benefitUsage';

/** Display helpers for the Benefits area. Dates are calendar dates (YYYY-MM-DD). */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "$15", "$12.95", "$1,250": whole dollars without cents. */
export function formatBenefitUsd(amountMinor: number): string {
  const whole = amountMinor % 100 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2,
  }).format(amountMinor / 100);
}

/** An amount of a benefit's own unit: dollars, or a count of its noun ("1 free night", "2 certificates"). */
export function formatBenefitAmount(benefit: Pick<BenefitView, 'unit' | 'noun'>, amount: number): string {
  if (benefit.unit === 'usd') return formatBenefitUsd(amount);
  const noun = benefit.noun ?? 'item';
  return `${amount} ${amount === 1 ? noun : pluralNoun(noun)}`;
}

function pluralNoun(noun: string): string {
  if (/(?:s|x|ch|sh)$/.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

/** "$15 of $25", "1 of 1 free night", "— of $25" when the use is unknown. */
export function usedOfAvailable(benefit: Pick<BenefitView, 'unit' | 'noun'>, used: number | null, available: number): string {
  if (benefit.unit === 'usd') return `${used === null ? '—' : formatBenefitUsd(used)} of ${formatBenefitUsd(available)}`;
  return `${used === null ? '—' : used} of ${formatBenefitAmount(benefit, available)}`;
}

/** 0–1, for a bar; 0 when nothing is available or the use is unknown. */
export function usedFraction(used: number | null, available: number): number {
  if (used === null || !(available > 0)) return 0;
  return Math.min(Math.max(used / available, 0), 1);
}

/** How full a period's cell is drawn. */
export type PeriodFill = 'inactive' | 'unknown' | 'none' | 'partial' | 'full' | 'future';

export function periodFill(period: Pick<BenefitPeriodView, 'active' | 'usedMinor' | 'availableMinor' | 'state'>): PeriodFill {
  if (!period.active) return 'inactive';
  if (period.usedMinor === null) return period.state === 'future' ? 'future' : 'unknown';
  if (period.usedMinor >= period.availableMinor && period.availableMinor > 0) return 'full';
  if (period.usedMinor > 0) return 'partial';
  return period.state === 'future' ? 'future' : 'none';
}

/** "Last day", "12 days left". */
export function daysLeftLabel(days: number): string {
  if (days <= 1) return 'Last day';
  return `${days} days left`;
}

/** "Oct 19", or "Oct 19, 2025" in another year than `today`'s. */
export function shortDate(date: string, today: string): string {
  const label = `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
  return date.slice(0, 4) === today.slice(0, 4) ? label : `${label}, ${date.slice(0, 4)}`;
}

/** "Jan 1 – Jun 30, 2026", or with both years when they differ. */
export function periodRange(period: Pick<BenefitPeriodView, 'start' | 'end'>): string {
  const day = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
  return period.start.slice(0, 4) === period.end.slice(0, 4)
    ? `${day(period.start)} – ${day(period.end)}, ${period.end.slice(0, 4)}`
    : `${day(period.start)}, ${period.start.slice(0, 4)} – ${day(period.end)}, ${period.end.slice(0, 4)}`;
}

/** Where a figure came from, in words. */
export function sourceLabel(source: BenefitFigureSource, issuer: BenefitIssuerFigure | null, today: string): string {
  if (source === 'issuer' && issuer) return `Issuer · as of ${shortDate(issuer.observedAt.slice(0, 10), today)}${issuer.stale ? ' (stale)' : ''}`;
  if (source === 'manual') return 'Marked by you';
  if (source === 'derived') return 'From statement credits';
  return 'Not marked';
}

const MANUAL_REASONS: Record<BenefitManualReason, string> = {
  'partner-balance': 'Lands in the partner\'s app, not on the statement: mark it by hand',
  certificate: 'A certificate in the loyalty account: mark it by hand',
  discount: 'Taken off at checkout, not posted as a credit: mark it by hand',
  activation: 'Activate it each period, then mark it here',
  'not-itemized': 'Its statement credit has no wording Holdr can match: mark it by hand',
};

export function manualReasonLabel(reason: BenefitManualReason | undefined): string {
  return reason ? MANUAL_REASONS[reason] : 'Mark it by hand';
}

/** What an Unverified tag means. */
export const UNVERIFIED_TITLE = 'Amount or period not yet confirmed on the issuer\'s page';

/** The words for a period's cell, for its accessible name and tooltip. */
export function periodCellLabel(benefit: BenefitView, period: BenefitPeriodView, today: string): string {
  if (!period.active) return `${period.label}: not offered then`;
  const figure = usedOfAvailable(benefit, period.usedMinor, period.availableMinor);
  const when = period.state === 'current' ? ' (now)' : period.state === 'future' ? ' (ahead)' : '';
  return `${period.label}${when}: ${figure} · ${sourceLabel(period.source, period.issuer, today)}`;
}

/** The card's name as the area shows it: its product, else its nickname, else its issuer. */
export function cardTitle(card: Pick<CardBenefitsCardView, 'product' | 'nickname' | 'issuer'>): string {
  return card.product?.shortName ?? card.nickname ?? issuerLabel(card.issuer);
}

/** "··0009", or nothing. */
export function cardEndingLabel(card: Pick<CardBenefitsCardView, 'last5' | 'last4'>): string {
  const ending = card.last5 ?? card.last4;
  return ending ? `··${ending}` : '';
}

const ISSUER_ORDER = ['amex', 'chase', 'citi'];

/** Cards by issuer (Amex, Chase, Citi, then others by name), then by owner, keeping their order within. */
export function groupBenefitCards(cards: readonly CardBenefitsCardView[]): Array<{
  issuer: string;
  label: string;
  owners: Array<{ owner: CardOwner; cards: CardBenefitsCardView[] }>;
}> {
  const rank = (issuer: string) => (ISSUER_ORDER.includes(issuer) ? ISSUER_ORDER.indexOf(issuer) : ISSUER_ORDER.length);
  const issuers = [...new Set(cards.map((card) => card.issuer))]
    .sort((a, b) => rank(a) - rank(b) || issuerLabel(a).localeCompare(issuerLabel(b)));
  return issuers.map((issuer) => ({
    issuer,
    label: issuerLabel(issuer),
    owners: OWNERS
      .map((owner) => ({ owner, cards: cards.filter((card) => card.issuer === issuer && card.owner === owner) }))
      .filter((group) => group.cards.length > 0),
  }));
}

/** The current period's line: what is left and how long, or what to do. */
export function currentLine(benefit: Pick<BenefitView, 'unit' | 'noun'>, current: BenefitCurrentView): string {
  const left = daysLeftLabel(current.daysLeft);
  if (current.remainingMinor === null) return `${unknownUse(current.source)} · ${left}`;
  if (current.remainingMinor === 0) return `Used · renews after ${MONTHS[Number(current.end.slice(5, 7)) - 1]} ${Number(current.end.slice(8, 10))}`;
  return `${formatBenefitAmount(benefit, current.remainingMinor)} left · ${left}`;
}

/** What an unknown use says: the issuer did not report it, or nobody marked it yet. */
export function unknownUse(source: BenefitFigureSource): string {
  return source === 'issuer' ? 'Use not reported' : 'Not marked yet';
}

/** The share of the annual fee the credits used cover, as a whole percentage; null without a fee. */
export function feeCoverage(capturedMinor: number, annualFeeMinor: number | null): number | null {
  if (!annualFeeMinor) return null;
  return Math.round((capturedMinor / annualFeeMinor) * 100);
}

/** A reminder's amount: what is left, or "Use unknown" and why, never a $0 left. */
export function reminderLeft(
  benefit: Pick<BenefitView, 'unit' | 'noun'>,
  reminder: Pick<BenefitReminder, 'remainingMinor' | 'source'>,
): { text: string; why: string | null } {
  if (reminder.remainingMinor === null) {
    return { text: 'Use unknown', why: reminder.source === 'issuer' ? 'not reported by the issuer' : 'not marked yet' };
  }
  return { text: `${formatBenefitAmount(benefit, reminder.remainingMinor)} left`, why: null };
}

/** A reminder's deadline: "Use by Oct 31 · 5 days left", "Use by Oct 31 · Last day". */
export function reminderDeadline(reminder: Pick<BenefitReminder, 'end' | 'daysLeft'>, today: string): string {
  return `Use by ${shortDate(reminder.end, today)} · ${daysLeftLabel(reminder.daysLeft)}`;
}

/** Periods so far whose use nobody knows yet, and the credits they hold: left out of every "credits used" figure. */
export interface UnknownUse {
  periods: number;
  availableMinor: number;
}

/**
 * The periods of the dollar totals (credits counted in totals, the year's periods up to today) whose use is not known:
 * a benefit marked by hand and not marked yet, or an issuer that reported no figure. The report counts them as nothing
 * used; said apart, they are never read as $0. The caller picks the cards (the household: its open cards).
 */
export function unknownUseOf(cards: ReadonlyArray<Pick<CardBenefitsCardView, 'benefits'>>): UnknownUse {
  let periods = 0;
  let availableMinor = 0;
  for (const card of cards) {
    for (const benefit of card.benefits) {
      if (!benefit.inTotals) continue;
      for (const period of benefit.periods) {
        if (!period.active || period.state === 'future' || period.usedMinor !== null) continue;
        periods += 1;
        availableMinor += period.availableMinor;
      }
    }
  }
  return { periods, availableMinor };
}

/** "10 periods ($170 in credits)": what "Use unknown" covers. */
export function unknownUseText(unknown: UnknownUse): string {
  return `${unknown.periods} ${unknown.periods === 1 ? 'period' : 'periods'} (${formatBenefitUsd(unknown.availableMinor)} in credits)`;
}

/** The figure's note: "of $5,000 available in 2026 · 28%"; with nothing counted, it says only that. */
export function creditsUsedNote(totals: Pick<BenefitTotals, 'capturedMinor' | 'availableMinor'>, year: number): string {
  if (!(totals.availableMinor > 0)) return `No dollar credits counted in ${year}`;
  return `of ${formatBenefitUsd(totals.availableMinor)} available in ${year} · ${Math.round(usedFraction(totals.capturedMinor, totals.availableMinor) * 100)}%`;
}

/**
 * What the dollar figures leave out until cards are set up: the credits of cards whose product is not known (not
 * chosen yet, or gone from the catalog; not those set to track nothing), and of cards with a dollar credit that renews
 * each cardmember year but no anniversary month to place it. The report counts both as nothing available, which is no
 * proof there is nothing: "credits on 2 cards that need a product, and on 1 card that needs an anniversary month".
 * Null when nothing is left out that way.
 */
export function notCountedYetText(cards: ReadonlyArray<Pick<CardBenefitsCardView, 'product' | 'productChoice' | 'benefits'>>): string | null {
  const noProduct = cards.filter((card) => card.product === null && card.productChoice !== 'none').length;
  const unplaced = cards.filter((card) => card.product !== null
    && card.benefits.some((benefit) => benefit.inTotals && benefit.needsAnniversary)).length;
  const parts = [
    noProduct > 0 ? `${noProduct} ${noProduct === 1 ? 'card that needs' : 'cards that need'} a product` : '',
    unplaced > 0 ? `${unplaced} ${unplaced === 1 ? 'card that needs' : 'cards that need'} an anniversary month` : '',
  ].filter(Boolean);
  return parts.length === 0 ? null : `credits on ${parts.join(', and on ')}`;
}

/** "Annual fees $1,890 · credits used cover 73% of them", or "No annual fees". */
export function annualFeesText(totals: Pick<BenefitTotals, 'capturedMinor' | 'annualFeesMinor'>): string {
  const coverage = feeCoverage(totals.capturedMinor, totals.annualFeesMinor);
  if (coverage === null) return 'No annual fees';
  return `Annual fees ${formatBenefitUsd(totals.annualFeesMinor)} · credits used cover ${coverage}% of them`;
}

/** "Credits used minus annual fees: −$515 (dollar credits only)": a difference, never called a saving. */
export function creditsMinusFeesText(totals: Pick<BenefitTotals, 'capturedMinor' | 'annualFeesMinor'>): string {
  const difference = totals.capturedMinor - totals.annualFeesMinor;
  return `Credits used minus annual fees: ${difference < 0 ? '−' : ''}${formatBenefitUsd(Math.abs(difference))} (dollar credits only)`;
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'] as const;

/** What a card to set up still needs, in a few words: its product, or the month its cardmember year starts. */
export function setupReason(card: Pick<CardBenefitsCardView, 'product' | 'productSource' | 'needsAnniversary'>): string {
  if (!card.product) return card.productSource === 'missing' ? 'Its product left the catalog: choose another' : 'Choose its product';
  return card.needsAnniversary ? 'Set its anniversary month' : '';
}

/** The folded "Cards to set up" list, said in one line: "2 need a product, 12 need an anniversary month". */
export function setupSummaryText(cards: ReadonlyArray<Pick<CardBenefitsCardView, 'product' | 'needsAnniversary'>>): string {
  const needs = (count: number, what: string) => `${count} ${count === 1 ? 'needs' : 'need'} ${what}`;
  const product = cards.filter((card) => !card.product).length;
  const anniversary = cards.filter((card) => card.product && card.needsAnniversary).length;
  return [product > 0 ? needs(product, 'a product') : '', anniversary > 0 ? needs(anniversary, 'an anniversary month') : '']
    .filter(Boolean).join(', ');
}

/** Why the cards are set up, said once above them rather than on each. */
export const SETUP_WHY = 'A card\'s product says which benefits it has; its anniversary month places the benefits that renew each cardmember year.';

/** How many compared cards lack a benefit: "12 of 20 compared cards". */
export function missingCountText(missing: number, compared: number): string {
  return `${missing} of ${compared} compared ${compared === 1 ? 'card' : 'cards'}`;
}

/**
 * Most used: each tier's heading, and what puts a benefit in it. The window is the last 12 months for this year's view,
 * the year itself for a past one.
 */
export function usageTierText(tier: UsageTier, window: Pick<UsageWindow, 'trailing'>, year: number): { title: string; note: string } {
  const span = window.trailing ? 'the last 12 months' : String(year);
  switch (tier) {
    case 'used':
      return { title: 'Recorded use', note: `The most used first: by how many periods had a recorded use in ${span}, then by the latest use` };
    case 'unknown':
      return { title: 'Use unknown', note: 'No recorded use, and periods not marked yet or not reported by the issuer' };
    case 'occasional':
      return { title: 'Occasional', note: 'Once every few years: the latest used first' };
    case 'unplaced':
      return { title: 'Not placed yet', note: 'Nothing to count yet: a card needs its anniversary month, or the benefit has not begun' };
    case 'unused':
      return { title: 'No recorded use', note: `Nothing recorded in ${span}: open one to see its cards` };
  }
}
