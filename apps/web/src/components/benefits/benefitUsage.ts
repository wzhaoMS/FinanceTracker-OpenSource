import {
  amazonSpendingWindowRange,
  type BenefitCurrentView,
  type BenefitPeriodView,
  type BenefitView,
  type CardBenefitsCardView,
} from '@finance-tracker/shared';

import { benefitGroupKind, type BenefitGroup, type BenefitGroupMember } from './benefitGroups';

/**
 * How much each benefit was used, for the By benefit view's "Most used" order. Use is counted in card-periods: one
 * period of one card's benefit with a figure above zero counts once, whatever the amount, so a certificate used once
 * counts one and a monthly credit used in nine months counts nine, and a card that never used it adds nothing (it
 * does not dilute the others). This is recorded use (statement credits, the owner's marks, the issuer's figures), not
 * a count of transactions. Display only: every figure is the report's own.
 */

/**
 * Where a benefit is listed: used (at least one card-period with a recorded use), use not known (no recorded use, and
 * a period with no figure: marked by hand and not marked yet, or the issuer reported none), once every few years,
 * not placed yet (no period that counts: an anniversary month to set, or no period begun yet), or no recorded use
 * (every period that counts has a figure of zero). Never "unused" for what is unknown or not placed.
 */
export type UsageTier = 'used' | 'unknown' | 'occasional' | 'unplaced' | 'unused';
export const USAGE_TIERS: readonly UsageTier[] = ['used', 'unknown', 'occasional', 'unplaced', 'unused'];

/** The dates whose periods count. Today's year: the trailing 12 months, last year's report included. Another past year: that year alone. */
export interface UsageWindow {
  from: string;
  to: string;
  /** The trailing 12 months: today's period and last year's periods count too. */
  trailing: boolean;
}

/** The window for a year's view as of `today`; null for a year still to come (nothing has been used in it). */
export function usageWindow(year: number, today: string): UsageWindow | null {
  const thisYear = Number(today.slice(0, 4));
  if (year > thisYear) return null;
  if (year < thisYear) return { from: `${year}-01-01`, to: `${year}-12-31`, trailing: false };
  // The last year as the app counts one everywhere (Amazon's 1Y): from the day after the same date 12 months back.
  return { from: amazonSpendingWindowRange('1Y', today).from, to: today, trailing: true };
}

/** One card's benefit, as history is looked up: the same card and the same benefit id. */
export const memberKey = (card: Pick<CardBenefitsCardView, 'cardAccountId'>, benefit: Pick<BenefitView, 'id'>) => `${card.cardAccountId}|${benefit.id}`;

/** Last year's benefits by member, for the trailing window. */
export function historyIndex(cards: readonly CardBenefitsCardView[]): Map<string, BenefitView> {
  return new Map(cards.flatMap((card) => card.benefits.map((benefit) => [memberKey(card, benefit), benefit] as const)));
}

/**
 * A card's benefit's periods that count in the window: active, begun by its end and not ended before its start. The
 * selected year's periods; in the trailing window also today's period (a cardmember year begun last year is in no
 * period list of this year) and last year's periods of the same card and benefit. Each period once, by its start,
 * this year's figure first (it is the fresher answer).
 */
export function countedPeriods(
  benefit: Pick<BenefitView, 'periods' | 'current'>,
  history: Pick<BenefitView, 'periods'> | undefined,
  window: UsageWindow,
): BenefitPeriodView[] {
  const byStart = new Map<string, BenefitPeriodView>();
  const add = (period: BenefitPeriodView | null | undefined) => {
    if (!period || !period.active || byStart.has(period.start)) return;
    if (period.start > window.to || period.end < window.from) return;
    byStart.set(period.start, period);
  };
  benefit.periods.forEach(add);
  if (window.trailing) {
    add(benefit.current);
    history?.periods.forEach(add);
  }
  return [...byStart.values()];
}

export interface Usage {
  /** Card-periods with a recorded use above zero. */
  usedPeriods: number;
  /** Card-periods with no figure. */
  unknownPeriods: number;
  /** Card-periods that count. */
  countedPeriods: number;
  /** The start of the latest period used, or null. */
  lastUsed: string | null;
}

const NONE: Usage = { usedPeriods: 0, unknownPeriods: 0, countedPeriods: 0, lastUsed: null };

export function periodsUsage(periods: readonly Pick<BenefitPeriodView, 'start' | 'usedMinor'>[]): Usage {
  return periods.reduce<Usage>((usage, period) => ({
    usedPeriods: usage.usedPeriods + (period.usedMinor !== null && period.usedMinor > 0 ? 1 : 0),
    unknownPeriods: usage.unknownPeriods + (period.usedMinor === null ? 1 : 0),
    countedPeriods: usage.countedPeriods + 1,
    lastUsed: period.usedMinor !== null && period.usedMinor > 0 && (usage.lastUsed === null || period.start > usage.lastUsed)
      ? period.start : usage.lastUsed,
  }), NONE);
}

const later = (a: string | null, b: string | null) => (a === null || (b !== null && b > a) ? b : a);
const sooner = (a: string | null, b: string | null) => (a === null || (b !== null && b < a) ? b : a);

function addUsage(a: Usage, b: Usage): Usage {
  return {
    usedPeriods: a.usedPeriods + b.usedPeriods,
    unknownPeriods: a.unknownPeriods + b.unknownPeriods,
    countedPeriods: a.countedPeriods + b.countedPeriods,
    lastUsed: later(a.lastUsed, b.lastUsed),
  };
}

export function memberUsage(member: BenefitGroupMember, history: ReadonlyMap<string, BenefitView>, window: UsageWindow): Usage {
  return periodsUsage(countedPeriods(member.benefit, history.get(memberKey(member.card, member.benefit)), window));
}

export interface GroupUsage extends Usage {
  tier: UsageTier;
  /** Once every few years: the soonest date a card that used it can use it again; else null. */
  nextEligible: string | null;
}

export function groupUsage(group: Pick<BenefitGroup, 'kind' | 'members'>, history: ReadonlyMap<string, BenefitView>, window: UsageWindow): GroupUsage {
  const usage = group.members.map((member) => memberUsage(member, history, window)).reduce(addUsage, NONE);
  if (group.kind === 'window') {
    // Its periods span years: the last use Holdr knows of says more, and when it can be used again.
    const windows = group.members.map(({ benefit }) => benefit.window);
    return {
      ...usage,
      tier: 'occasional',
      lastUsed: windows.reduce<string | null>((last, entry) => later(last, entry?.lastUsed ?? null), null),
      nextEligible: windows.reduce<string | null>((next, entry) => sooner(next, entry?.lastUsed ? entry.nextEligible : null), null),
    };
  }
  const tier: UsageTier = usage.usedPeriods > 0 ? 'used'
    : usage.unknownPeriods > 0 ? 'unknown'
      : usage.countedPeriods === 0 ? 'unplaced' : 'unused';
  return { ...usage, tier, nextEligible: null };
}

/** The most used first: more card-periods used, then the latest use; otherwise the order they came in. */
function byUse<T extends { usage: Usage; index: number }>(a: T, b: T): number {
  return b.usage.usedPeriods - a.usage.usedPeriods
    || (b.usage.lastUsed ?? '').localeCompare(a.usage.lastUsed ?? '')
    || a.index - b.index;
}

/** Once every few years: the latest used first, then the soonest usable again; never used, in the order they came in. */
function byLastUse<T extends { usage: GroupUsage; index: number }>(a: T, b: T): number {
  return (b.usage.lastUsed ?? '').localeCompare(a.usage.lastUsed ?? '')
    || (a.usage.nextEligible ?? '9999').localeCompare(b.usage.nextEligible ?? '9999')
    || a.index - b.index;
}

export interface RankedTier {
  tier: UsageTier;
  groups: BenefitGroup[];
}

/**
 * The groups by tier (USAGE_TIERS): the used ones most used first, the once-every-few-years ones by their last use,
 * every other tier in the order the groups came in (By category's). Every group is listed once; nothing about a group
 * changes, only where it is listed.
 */
export function rankGroups(groups: readonly BenefitGroup[], usage: ReadonlyMap<string, GroupUsage>): RankedTier[] {
  const entries = groups.map((group, index) => ({
    group, index, usage: usage.get(group.key) ?? { ...NONE, tier: 'unused' as const, nextEligible: null },
  }));
  return USAGE_TIERS
    .map((tier) => ({
      tier,
      groups: entries.filter((entry) => entry.usage.tier === tier)
        .sort(tier === 'used' ? byUse : tier === 'occasional' ? byLastUse : (a, b) => a.index - b.index)
        .map((entry) => entry.group),
    }))
    .filter((entry) => entry.groups.length > 0);
}

function rankMembersBy(members: readonly BenefitGroupMember[], usageOf: (member: BenefitGroupMember) => Usage): BenefitGroupMember[] {
  return members
    .map((member, index) => ({ member, index, usage: usageOf(member) }))
    .sort(byUse)
    .map((entry) => entry.member);
}

/** A group's cards, the most used first; cards with no recorded use keep their order (issuer, then person). */
export function rankMembers(members: readonly BenefitGroupMember[], history: ReadonlyMap<string, BenefitView>, window: UsageWindow): BenefitGroupMember[] {
  return rankMembersBy(members, (member) => memberUsage(member, history, window));
}

/** One card's benefit, as a group of its own: its tier and its use (By card). */
export function benefitUsage(
  card: CardBenefitsCardView,
  benefit: BenefitView,
  history: ReadonlyMap<string, BenefitView>,
  window: UsageWindow,
): GroupUsage {
  return groupUsage({ kind: benefitGroupKind(benefit), members: [{ card, benefit }] }, history, window);
}

/** Each card's benefits' use, by member (memberKey), for By card's order, kept as usageSnapshot is. */
export function cardUsageSnapshot(
  cards: readonly CardBenefitsCardView[],
  history: ReadonlyMap<string, BenefitView>,
  window: UsageWindow,
): ReadonlyMap<string, GroupUsage> {
  return new Map(cards.flatMap((card) => card.benefits.map((benefit) => [memberKey(card, benefit), benefitUsage(card, benefit, history, window)] as const)));
}

/**
 * A card's benefits as By card lists them, most used first: by tier as Most used lists groups (USAGE_TIERS), the used
 * ones most used first, the once-every-few-years ones by their last use, the rest in the card's own order.
 */
export function rankCardBenefits(card: CardBenefitsCardView, usageOf: (benefit: BenefitView) => GroupUsage): BenefitView[] {
  const entries = card.benefits.map((benefit, index) => ({ benefit, index, usage: usageOf(benefit) }));
  return USAGE_TIERS.flatMap((tier) => entries.filter((entry) => entry.usage.tier === tier)
    .sort(tier === 'used' ? byUse : tier === 'occasional' ? byLastUse : (a, b) => a.index - b.index)
    .map((entry) => entry.benefit));
}

/**
 * The use the order was set by, kept while the view is open: marking a period changes a group's figures at once but
 * not where it is listed, so the period being marked, and the focus in it, stay put. A group or a card the snapshot
 * has not seen is ranked by its use now.
 */
export interface UsageSnapshot {
  groups: ReadonlyMap<string, GroupUsage>;
  members: ReadonlyMap<string, Usage>;
}

export function usageSnapshot(groups: readonly BenefitGroup[], history: ReadonlyMap<string, BenefitView>, window: UsageWindow): UsageSnapshot {
  return {
    groups: new Map(groups.map((group) => [group.key, groupUsage(group, history, window)])),
    members: new Map(groups.flatMap((group) => group.members.map((member) => [
      memberKey(member.card, member.benefit), memberUsage(member, history, window),
    ] as const))),
  };
}

/** The groups as they are now (their figures), listed by the snapshot's use: by tier, the most used first, and each group's cards the most used first. */
export function rankedTiers(
  groups: readonly BenefitGroup[],
  snapshot: UsageSnapshot,
  history: ReadonlyMap<string, BenefitView>,
  window: UsageWindow,
): RankedTier[] {
  const usage = new Map(groups.map((group) => [group.key, snapshot.groups.get(group.key) ?? groupUsage(group, history, window)]));
  const usageOf = (member: BenefitGroupMember) =>
    snapshot.members.get(memberKey(member.card, member.benefit)) ?? memberUsage(member, history, window);
  return rankGroups(groups, usage).map(({ tier, groups: listed }) => ({
    tier,
    groups: listed.map((group) => ({ ...group, members: rankMembersBy(group.members, usageOf) })),
  }));
}

/**
 * What the order depends on besides use: the window, which groups there are with which cards, which of their benefits
 * can be placed (an anniversary month set), and last year's report as far as it places them. A mark changes none of
 * it; choosing a product, setting a month, another year or another person does, and so the order is set again.
 */
export function rankingFingerprint(
  groups: readonly Pick<BenefitGroup, 'key' | 'members'>[],
  history: readonly CardBenefitsCardView[] | null,
  window: UsageWindow,
): string {
  const placed = (benefit: Pick<BenefitView, 'id' | 'needsAnniversary'>) => `${benefit.id}${benefit.needsAnniversary ? '!' : ''}`;
  return JSON.stringify([
    window.from,
    window.to,
    groups.map((group) => [group.key, group.members.map(({ card, benefit }) => `${card.cardAccountId}|${placed(benefit)}`)]),
    history === null ? null : history.map((card) => [card.cardAccountId, card.benefits.map(placed)]),
  ]);
}

/** A folded group's one line: what its cards have left in today's periods, and the days until the first of those resets. */
export interface GroupNow {
  leftMinor: number;
  daysLeft: number;
}

/** Null when none of its cards has today's period with something left. */
export function groupNow(group: Pick<BenefitGroup, 'members'>): GroupNow | null {
  const open = group.members
    .map(({ benefit }) => benefit.current)
    .filter((current): current is BenefitCurrentView & { remainingMinor: number } =>
      current !== null && current.active && current.remainingMinor !== null && current.remainingMinor > 0);
  if (open.length === 0) return null;
  return {
    leftMinor: open.reduce((sum, current) => sum + current.remainingMinor, 0),
    daysLeft: Math.min(...open.map((current) => current.daysLeft)),
  };
}
