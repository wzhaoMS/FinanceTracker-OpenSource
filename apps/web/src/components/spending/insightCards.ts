/**
 * The Spending tab's insight cards, built from the API's findings for the
 * period shown (`computeCardInsights`): a headline, one reason, the rows or
 * merchants behind it, and where to look. Pure, so cards are tested (and
 * previewed on a copy of real data) without React.
 *
 * Findings of a kind come as one card listing them, never one card each. The
 * month's pace leads, possible duplicates follow (they need acting on), and
 * everything else is ranked by the money it is about. Names are cleaned for
 * reading (`merchantDisplayName`), while every action keeps exactly what the
 * card names: Open goes to the row's own id, Show filters by the group key
 * or the category.
 */
import type { CardSpendingInsights, RecurringCharge } from '@finance-tracker/shared';
import { cardMinorToMajor } from '@finance-tracker/shared';

import {
  formatMinor,
  longDate,
  merchantDisplayName,
  monthLabel,
  shiftMonth,
  shortDate,
  type SpendingPeriod,
  type SpendingPeriodRange,
} from './spendingFormat';

export type InsightTone = 'warn' | 'good' | 'info';

export type InsightKind =
  | 'pace'
  | 'duplicates'
  | 'large'
  | 'category'
  | 'merchants'
  | 'recurring-new'
  | 'recurring-up'
  | 'recurring-stopped'
  | 'new-merchants'
  | 'pending-refunds'
  | 'costs';

/** Where an insight leads: one row (Open), or the period's rows at a merchant group or in a category (Show). */
export type InsightTarget =
  | { type: 'row'; id: string }
  | { type: 'merchant'; key: string; name: string }
  | { type: 'category'; category: string };

export interface InsightItem {
  key: string;
  label: string;
  /** Its date, cadence or change: "Oct 2 · first time here". */
  note: string;
  amount: string;
  target: InsightTarget;
}

export interface InsightCard {
  id: string;
  kind: InsightKind;
  tone: InsightTone;
  /** The money it is about, in minor units: the order after the lead cards. */
  impactMinor: number;
  title: string;
  detail: string;
  /** How it was found, as a tooltip. */
  hint?: string;
  items: InsightItem[];
  action?: { label: 'Open' | 'Show'; target: InsightTarget };
}

/** The period's words, as its comparison card says them. */
export interface InsightContext {
  /** After a figure: "this month", "in September 2026", "in the last 90 days". */
  period: string;
  /** After a figure: "by this day last month", "in August 2026", "in the 90 days before"; null without a comparison. */
  baseline: string | null;
  /** The panel's subtitle: "This month so far, against last month to this day". */
  heading: string;
}

/** What `/spending/insights` is asked for. */
export interface InsightRequest {
  month: string;
  today: string;
  from?: string;
  to?: string;
  baselineFrom?: string;
  baselineTo?: string;
}

/** Cards shown before "Show all". */
export const VISIBLE_INSIGHTS = 6;
/** Category changes get a card each, up to this many. */
const CATEGORY_CARDS = 3;
/** Rows listed on a card. */
const LISTED_ITEMS = 5;
/** A card about less than this (in major units) waits behind every card about more, whatever its kind. */
const MATERIAL_MAJOR = 50;
/** A change of this many times the comparison or more reads as an amount, not as a percentage. */
const PERCENT_LIMIT = 5;

/**
 * What the cards answer, taken in turns so that one kind never fills the
 * first six: the large one-offs, what changed, what repeats, what to check.
 */
const PILLAR: Record<InsightKind, 'lead' | 'one-offs' | 'changed' | 'repeats' | 'check'> = {
  pace: 'lead',
  duplicates: 'lead',
  large: 'one-offs',
  category: 'changed',
  merchants: 'changed',
  'recurring-new': 'repeats',
  'recurring-up': 'repeats',
  'recurring-stopped': 'repeats',
  'new-merchants': 'check',
  'pending-refunds': 'check',
  costs: 'check',
};

const CADENCE: Record<RecurringCharge['cadence'], { word: string; perYear: number }> = {
  weekly: { word: 'weekly', perYear: 52 },
  biweekly: { word: 'every 2 weeks', perYear: 26 },
  monthly: { word: 'monthly', perYear: 12 },
  quarterly: { word: 'quarterly', perYear: 4 },
  annual: { word: 'yearly', perYear: 1 },
};

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase('en-US') + text.slice(1);

function ordinalDay(day: number): string {
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix}`;
}

function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function joined(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** A category as a card names it: the part after its top level ("Merchandise & Supplies-Groceries" → "Groceries"). */
function categoryLabel(category: string): string {
  const dash = category.indexOf('-');
  return (dash > 1 ? category.slice(dash + 1).trim() : '') || category;
}

/** A split purchase's categories, largest first: two named, the rest counted. */
function splitLabel(split: ReadonlyArray<{ category: string }>): string {
  const names = split.map((item) => categoryLabel(item.category));
  return names.length <= 2 ? joined(names) : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/**
 * The order cards are shown in: the pace, then a possible duplicate; then, in
 * turns, the largest card left of each of the one-offs, what changed, what
 * repeats and what to check (each turn by the money it is about); then
 * whatever is about less than `MATERIAL_MAJOR`, by its money.
 */
function ranked(cards: readonly InsightCard[], currency: string): InsightCard[] {
  const byMoney = (a: InsightCard, b: InsightCard) => b.impactMinor - a.impactMinor;
  const material = (card: InsightCard) => cardMinorToMajor(card.impactMinor, currency) >= MATERIAL_MAJOR;
  const lead = cards.filter((card) => PILLAR[card.kind] === 'lead');
  const queues = (['one-offs', 'changed', 'repeats', 'check'] as const)
    .map((pillar) => cards.filter((card) => PILLAR[card.kind] === pillar && material(card)).sort(byMoney));
  const turns: InsightCard[] = [];
  while (queues.some((queue) => queue.length > 0)) {
    turns.push(...queues.filter((queue) => queue.length > 0).map((queue) => queue.shift()!).sort(byMoney));
  }
  const rest = cards.filter((card) => PILLAR[card.kind] !== 'lead' && !material(card)).sort(byMoney);
  return [...lead, ...turns, ...rest];
}

/**
 * The insights' period for the period shown, and its words. A month is the
 * month against the month before, to the same day while it is the current
 * month (the engine's own, `cardMonthInsightPeriod`); a span against what its
 * comparison card compares it with.
 */
export function insightQuery(
  period: SpendingPeriod,
  range: SpendingPeriodRange,
  month: string,
  today: string,
): { request: InsightRequest; context: InsightContext } {
  if (period === 'month') {
    const current = month === today.slice(0, 7);
    const before = monthLabel(shiftMonth(month, -1));
    return {
      request: { month, today },
      context: current
        ? { period: 'this month', baseline: 'by this day last month', heading: 'This month so far, against last month to this day' }
        : { period: `in ${monthLabel(month)}`, baseline: `in ${before}`, heading: `${monthLabel(month)}, against ${before}` },
    };
  }
  const { previous } = range;
  return {
    request: {
      month: today.slice(0, 7),
      today,
      from: range.from,
      to: range.to,
      ...(previous ? { baselineFrom: previous.from, baselineTo: previous.to } : {}),
    },
    context: {
      period: `in ${range.phrase}`,
      baseline: previous ? `in ${previous.phrase}` : null,
      heading: previous ? `${capitalize(range.phrase)}, against ${previous.phrase}` : capitalize(range.phrase),
    },
  };
}

/**
 * The cards for one answer of `/spending/insights`, in the order they are shown. Under a category filter
 * (`category`, as the filter names it), a split large purchase also says its part in that category.
 */
export function buildInsightCards(
  insights: CardSpendingInsights,
  context: InsightContext,
  options: { category?: string | null } = {},
): InsightCard[] {
  const money = (minor: number) => formatMinor(minor, insights.currency);
  const signed = (minor: number) => `${minor < 0 ? '−' : '+'}${money(Math.abs(minor))}`;
  /** " (+35%)", or nothing when there is nothing to compare with or the change is many times over. */
  const percent = (share: number | null) => (share === null || share < -1 || share >= PERCENT_LIMIT
    ? '' : ` (${share < 0 ? '−' : '+'}${Math.round(Math.abs(share) * 100)}%)`);
  const name = (merchant: string, key: string) => merchantDisplayName(merchant, key);
  const baseline = context.baseline ?? 'before';
  /** "in line with $5,080.00 in the 90 days before", "up 34% on …", "down 12% on …", "against …" when many times over. */
  const against = (current: number, base: number) => {
    // Nothing at all usually means the imported history does not go back that far.
    if (base <= 0) return `with nothing recorded ${baseline}`;
    const change = (current - base) / base;
    if (Math.abs(change) < 0.1) return `in line with ${money(base)} ${baseline}`;
    if (change >= PERCENT_LIMIT || change < -1) return `against ${money(base)} ${baseline}`;
    return `${change > 0 ? 'up' : 'down'} ${Math.round(Math.abs(change) * 100)}% on ${money(base)} ${baseline}`;
  };
  const rowItem = (id: string, label: string, note: string, amountMinor: number): InsightItem =>
    ({ key: id, label, note, amount: money(amountMinor), target: { type: 'row', id } });
  const merchantTarget = (charge: { key: string; merchant: string }): InsightTarget =>
    ({ type: 'merchant', key: charge.key, name: charge.merchant });
  const recurringItem = (charge: RecurringCharge, note: string, amount: string): InsightItem => ({
    key: `${charge.key}-${charge.typicalMinor}-${charge.cadence}`,
    label: name(charge.merchant, charge.key),
    note,
    amount,
    target: merchantTarget(charge),
  });

  const cards: InsightCard[] = [];

  // The month's pace: spent so far plus what the rest of a usual month adds, and without its large one-offs.
  const { pace } = insights;
  if (pace) {
    const pending = pace.pendingMinor > 0 ? `; ${money(pace.pendingMinor)} pending, not counted yet` : '';
    const byNow = `${money(pace.spentMinor)} so far vs ${money(pace.typicalToDateMinor)} by the ${ordinalDay(pace.daysElapsed)} in a usual month${pending}.`;
    if (pace.projectedMinor !== null) {
      // Without this month's large one-offs: their purchases, or (when larger) refunds for earlier ones.
      const core = pace.projectedMinor - pace.largeMinor;
      const ratio = pace.typicalMonthMinor > 0 ? core / pace.typicalMonthMinor : null;
      const oneOffs = pace.largeMinor > 0
        ? `${pace.largeCount === 1 ? 'the large purchase' : `the ${pace.largeCount} large purchases`} (${money(pace.largeMinor)})`
        : `refunds for large purchases (${money(-pace.largeMinor)})`;
      cards.push({
        id: 'pace',
        kind: 'pace',
        tone: ratio === null ? 'info' : ratio > 1.15 ? 'warn' : ratio < 0.9 ? 'good' : 'info',
        impactMinor: pace.projectedMinor,
        title: `On pace for ${money(pace.projectedMinor)} this month`,
        detail: pace.largeMinor !== 0
          ? `${money(core)} without ${oneOffs}, vs a usual ${money(pace.typicalMonthMinor)} (last ${pace.historyMonths} months, large purchases aside). ${byNow}`
          : `Usual month ${money(pace.typicalMonthMinor)} (last ${pace.historyMonths} months, large purchases aside). ${byNow}`,
        items: [],
      });
    } else {
      cards.push({ id: 'pace', kind: 'pace', tone: 'info', impactMinor: pace.spentMinor, title: `${money(pace.spentMinor)} spent so far`, detail: byNow, items: [] });
    }
  }

  const { duplicates } = insights;
  if (duplicates.length === 1) {
    const [duplicate] = duplicates;
    cards.push({
      id: 'duplicates',
      kind: 'duplicates',
      tone: 'warn',
      impactMinor: duplicate.amountMinor,
      title: `Possible duplicate at ${name(duplicate.merchant, duplicate.key)}`,
      detail: `${money(duplicate.amountMinor)} on ${shortDate(duplicate.dates[0])} and ${shortDate(duplicate.dates[1])}, same card, no refund yet. Worth checking with the issuer.`,
      items: [],
      action: { label: 'Open', target: { type: 'row', id: duplicate.ids[1] } },
    });
  } else if (duplicates.length > 1) {
    const total = duplicates.reduce((sum, item) => sum + item.amountMinor, 0);
    const latest = [...duplicates].sort((a, b) => (a.dates[1] < b.dates[1] ? 1 : a.dates[1] > b.dates[1] ? -1 : 0)).slice(0, LISTED_ITEMS);
    cards.push({
      id: 'duplicates',
      kind: 'duplicates',
      tone: 'warn',
      impactMinor: total,
      title: `${duplicates.length} possible duplicate charges`,
      detail: `Same card, merchant and amount within a few days, no refund yet: ${money(total)} may have been charged twice.${
        duplicates.length > latest.length ? ` The ${latest.length} latest are listed.` : ''}`,
      items: latest.map((item) => rowItem(item.ids[1], name(item.merchant, item.key), `${shortDate(item.dates[0])} and ${shortDate(item.dates[1])}`, item.amountMinor)),
    });
  }

  const large = insights.largePurchases;
  if (large) {
    const share = large.share !== null ? `${Math.round(large.share * 100)}% of your spending ${context.period}. ` : '';
    const rest = large.baselineCoreMinor !== null ? `, ${against(large.coreMinor, large.baselineCoreMinor)}` : '';
    const more = large.count > large.items.length ? ` The ${large.items.length} largest are listed.` : '';
    cards.push({
      id: 'large',
      kind: 'large',
      tone: 'info',
      impactMinor: large.totalMinor,
      title: `${counted(large.count, 'large purchase')}: ${money(large.totalMinor)}`,
      detail: `${share}Without ${large.count === 1 ? 'it' : 'them'}: ${money(large.coreMinor)}${rest}.${more}`,
      hint: `Purchases of ${money(large.thresholdMinor)} or more: large for you over the past year, and not at a merchant that bills you regularly.`,
      items: large.items.map((item) => {
        const split = item.split && item.split.length > 1 ? item.split : null;
        // The whole purchase stays its amount; its part in the category filtered on is said beside it.
        const portion = split && options.category ? split.find((part) => part.category === options.category) : undefined;
        return rowItem(
          item.id,
          name(item.merchant, item.key),
          [
            shortDate(item.date),
            item.refundedMinor > 0 ? `${money(item.refundedMinor)} refunded` : null,
            item.firstTime ? 'first time here' : null,
            split ? `split: ${splitLabel(split)}` : null,
            portion ? `${money(portion.amountMinor)} in ${categoryLabel(portion.category)}` : null,
          ].filter((part): part is string => part !== null).join(' · '),
          item.amountMinor,
        );
      }),
    });
  }

  // What changed, large one-offs aside: a card per category, naming the merchants behind it.
  const named: string[] = [];
  for (const mover of insights.movers.slice(0, CATEGORY_CARDS)) {
    const up = mover.deltaMinor > 0;
    const category = categoryLabel(mover.category);
    named.push(...mover.drivers.map((driver) => driver.key));
    const drivers = mover.drivers.map((driver) => `${name(driver.merchant, driver.key)} (${signed(driver.deltaMinor)})`);
    const reason = drivers.length > 0 ? ` Mostly ${joined(drivers)}.` : '';
    cards.push({
      id: `category-${mover.category}`,
      kind: 'category',
      tone: up ? 'warn' : 'good',
      impactMinor: Math.abs(mover.deltaMinor),
      title: `${category} ${up ? 'up' : 'down'} ${money(Math.abs(mover.deltaMinor))}${percent(mover.share)}`,
      detail: mover.share === null
        ? `${money(mover.currentMinor)} ${context.period}, none ${baseline}.${reason}`
        : `${money(mover.currentMinor)} vs ${money(mover.typicalMinor)} ${baseline}.${reason}`,
      items: [],
      action: { label: 'Show', target: { type: 'category', category: mover.category } },
    });
  }

  // Merchants that moved and no category or first-time card already names.
  const merchants = insights.merchantMovers.filter((mover) => !named.includes(mover.key)
    && !insights.newMerchants.some((item) => item.key === mover.key));
  if (merchants.length === 1) {
    const [mover] = merchants;
    const up = mover.deltaMinor > 0;
    cards.push({
      id: `merchant-${mover.key}`,
      kind: 'merchants',
      tone: up ? 'warn' : 'good',
      impactMinor: Math.abs(mover.deltaMinor),
      title: `${name(mover.merchant, mover.key)} ${up ? 'up' : 'down'} ${money(Math.abs(mover.deltaMinor))}${percent(mover.share)}`,
      detail: mover.share === null
        ? `${money(mover.currentMinor)} ${context.period}, none ${baseline}.`
        : `${money(mover.currentMinor)} vs ${money(mover.baselineMinor)} ${baseline}.`,
      items: [],
      action: { label: 'Show', target: merchantTarget(mover) },
    });
  } else if (merchants.length > 1) {
    const ups = merchants.filter((mover) => mover.deltaMinor > 0).length;
    cards.push({
      id: 'merchants',
      kind: 'merchants',
      tone: ups === merchants.length ? 'warn' : ups === 0 ? 'good' : 'info',
      impactMinor: Math.max(...merchants.map((mover) => Math.abs(mover.deltaMinor))),
      title: 'Biggest changes by merchant',
      detail: `Against what you spent ${baseline}, large purchases aside.`,
      items: merchants.map((mover) => ({
        key: mover.key,
        label: name(mover.merchant, mover.key),
        note: mover.share === null ? `${money(mover.currentMinor)}, none before` : `${money(mover.currentMinor)} vs ${money(mover.baselineMinor)}`,
        amount: signed(mover.deltaMinor),
        target: merchantTarget(mover),
      })),
    });
  }

  // What repeats: recurring charges that started, went up or stopped in the period; the cards list the largest five.
  const listed = (count: number) => (count > LISTED_ITEMS ? ` The ${LISTED_ITEMS} largest are listed.` : '');
  const { started, priceUps, stopped } = insights.recurringChanges;
  if (started.length > 0) {
    const yearly = started.reduce((sum, charge) => sum + charge.typicalMinor * CADENCE[charge.cadence].perYear, 0);
    const [first] = started;
    cards.push(started.length === 1 ? {
      id: 'recurring-new',
      kind: 'recurring-new',
      tone: 'info',
      impactMinor: yearly,
      title: `New ${CADENCE[first.cadence].word} charge: ${name(first.merchant, first.key)}`,
      detail: `${money(first.typicalMinor)} since ${shortDate(first.firstDate)}: about ${money(yearly)} a year.`,
      items: [],
      action: { label: 'Show', target: merchantTarget(first) },
    } : {
      id: 'recurring-new',
      kind: 'recurring-new',
      tone: 'info',
      impactMinor: yearly,
      title: `${started.length} new recurring charges: ${money(started.reduce((sum, charge) => sum + charge.monthlyMinor, 0))} a month`,
      detail: `Started ${context.period}: about ${money(yearly)} a year.${listed(started.length)}`,
      items: [...started].sort((a, b) => b.monthlyMinor - a.monthlyMinor).slice(0, LISTED_ITEMS)
        .map((charge) => recurringItem(charge, `${CADENCE[charge.cadence].word} since ${shortDate(charge.firstDate)}`, money(charge.typicalMinor))),
    });
  }
  if (priceUps.length > 0) {
    const increase = (charge: RecurringCharge) => charge.priceChange!.toMinor - charge.priceChange!.fromMinor;
    const yearlyUp = (charge: RecurringCharge) => increase(charge) * CADENCE[charge.cadence].perYear;
    const yearly = priceUps.reduce((sum, charge) => sum + yearlyUp(charge), 0);
    const [first] = priceUps;
    cards.push(priceUps.length === 1 ? {
      id: 'recurring-up',
      kind: 'recurring-up',
      tone: 'warn',
      impactMinor: yearly,
      title: `${name(first.merchant, first.key)} went up to ${money(first.priceChange!.toMinor)}`,
      detail: `Was ${money(first.priceChange!.fromMinor)}, ${CADENCE[first.cadence].word}; last charged ${shortDate(first.lastDate)}. About ${money(yearly)} more a year.`,
      items: [],
      action: { label: 'Show', target: merchantTarget(first) },
    } : {
      id: 'recurring-up',
      kind: 'recurring-up',
      tone: 'warn',
      impactMinor: yearly,
      title: `${priceUps.length} price increases: ${money(yearly)} more a year`,
      detail: `Recurring charges that went up ${context.period}.${listed(priceUps.length)}`,
      items: [...priceUps].sort((a, b) => yearlyUp(b) - yearlyUp(a)).slice(0, LISTED_ITEMS).map((charge) => recurringItem(
        charge,
        `${money(charge.priceChange!.fromMinor)} → ${money(charge.priceChange!.toMinor)} ${CADENCE[charge.cadence].word}`,
        signed(increase(charge)),
      )),
    });
  }
  if (stopped.length > 0) {
    const monthly = stopped.reduce((sum, charge) => sum + charge.monthlyMinor, 0);
    const [first] = stopped;
    cards.push(stopped.length === 1 ? {
      id: 'recurring-stopped',
      kind: 'recurring-stopped',
      tone: 'good',
      impactMinor: monthly * 12,
      title: `${name(first.merchant, first.key)} may have stopped`,
      detail: `Last charged ${longDate(first.lastDate)}; the next ${CADENCE[first.cadence].word} ${money(first.typicalMinor)} was due about ${shortDate(first.nextDate)}. About ${money(monthly)} a month less.`,
      items: [],
      action: { label: 'Show', target: merchantTarget(first) },
    } : {
      id: 'recurring-stopped',
      kind: 'recurring-stopped',
      tone: 'good',
      impactMinor: monthly * 12,
      title: `${stopped.length} recurring charges may have stopped`,
      detail: `Their next charges are overdue: about ${money(monthly)} a month less, if they were cancelled.${listed(stopped.length)}`,
      items: [...stopped].sort((a, b) => b.monthlyMinor - a.monthlyMinor).slice(0, LISTED_ITEMS)
        .map((charge) => recurringItem(charge, `${CADENCE[charge.cadence].word}, last ${shortDate(charge.lastDate)}`, money(charge.typicalMinor))),
    });
  }

  const fresh = insights.newMerchants;
  if (fresh.length > 0) {
    const total = fresh.reduce((sum, item) => sum + item.amountMinor, 0);
    const [first] = fresh;
    cards.push(fresh.length === 1 ? {
      id: 'new-merchants',
      kind: 'new-merchants',
      tone: 'info',
      impactMinor: total,
      title: `First time at ${name(first.merchant, first.key)}: ${money(first.amountMinor)}`,
      detail: `A new merchant on ${shortDate(first.date)}, and one of your larger charges.`,
      items: [],
      action: { label: 'Open', target: { type: 'row', id: first.id } },
    } : {
      id: 'new-merchants',
      kind: 'new-merchants',
      tone: 'info',
      impactMinor: total,
      title: `${fresh.length} first-time merchants: ${money(total)}`,
      detail: `None of them in the year before, and each one of your larger charges.${
        fresh.length > LISTED_ITEMS ? ` The ${LISTED_ITEMS} largest are listed.` : ''}`,
      items: fresh.slice(0, LISTED_ITEMS).map((item) => rowItem(item.id, name(item.merchant, item.key), shortDate(item.date), item.amountMinor)),
    });
  }

  const refunds = insights.pendingRefunds;
  if (refunds) {
    const [first] = refunds.items;
    cards.push(refunds.count === 1 && first ? {
      id: 'pending-refunds',
      kind: 'pending-refunds',
      tone: 'info',
      impactMinor: refunds.totalMinor,
      title: `${money(refunds.totalMinor)} refund pending from ${name(first.merchant, first.key)}`,
      detail: `Dated ${shortDate(first.date)}; it counts once it posts.`,
      items: [],
      action: { label: 'Open', target: { type: 'row', id: first.id } },
    } : {
      id: 'pending-refunds',
      kind: 'pending-refunds',
      tone: 'info',
      impactMinor: refunds.totalMinor,
      title: `${refunds.count} refunds pending: ${money(refunds.totalMinor)}`,
      detail: 'Money coming back; each counts once it posts.',
      items: refunds.items.map((item) => rowItem(item.id, name(item.merchant, item.key), shortDate(item.date), item.amountMinor)),
    });
  }

  const { period: costs, year } = insights.costs;
  const cost = costs.feesMinor + costs.interestMinor;
  const yearCost = year.feesMinor + year.interestMinor;
  if (cost > 0 || yearCost > 0) {
    const parts = [
      costs.interestMinor ? `interest ${money(costs.interestMinor)}` : null,
      costs.feesMinor ? `fees ${money(costs.feesMinor)}${costs.foreignFeesMinor ? ` (foreign transaction ${money(costs.foreignFeesMinor)})` : ''}` : null,
      costs.reversalsMinor ? `reversed ${money(-costs.reversalsMinor)}` : null,
    ].filter((part): part is string => part !== null);
    cards.push({
      id: 'costs',
      kind: 'costs',
      tone: cost > 0 ? 'warn' : 'info',
      impactMinor: cost,
      title: cost > 0 ? `${money(cost)} in interest and fees` : `${money(yearCost)} in interest and fees in ${year.year}`,
      detail: `${parts.length > 0 ? `${capitalize(context.period)}: ${parts.join(', ')}. ` : ''}${year.year} so far: ${money(yearCost)}${year.foreignFeesMinor ? `, of which foreign transaction fees ${money(year.foreignFeesMinor)}` : ''}.`,
      items: [],
    });
  }

  return ranked(cards, insights.currency);
}
