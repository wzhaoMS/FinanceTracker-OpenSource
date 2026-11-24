import {
  BENEFIT_CATEGORIES,
  type BenefitCategory,
  type BenefitIssuerFigure,
  type BenefitView,
  type CardBenefitsCardView,
  type CardOwner,
} from '@finance-tracker/shared';

import { OWNERS } from '../spending/spendingFormat';
import {
  UNVERIFIED_TITLE,
  cardEndingLabel,
  cardTitle,
  formatBenefitAmount,
  groupBenefitCards,
  manualReasonLabel,
} from './benefitsFormat';

/**
 * The Benefits area's By benefit view: one group per benefit across the cards
 * shown, with every card that has it and every compared card that does not.
 * Presentation only: each card's figures are the report's own, unchanged, and
 * a group's year adds up its cards' years.
 */

/**
 * Dollar credits (the ones the totals count), counted things (certificates,
 * activations) and once-every-few-years credits. Groups never mix them, so a
 * group's year never adds dollars to counts.
 */
export type BenefitGroupKind = 'credit' | 'count' | 'window';

/**
 * Where the view lists a group: its catalog category (travel, hotels, dining,
 * shopping and lifestyle, business), the way card communities sort credits,
 * or `other` for a benefit without one.
 */
export type BenefitSection = BenefitCategory | 'other';

/** Sections in the order the view lists them. */
export const BENEFIT_SECTIONS: readonly BenefitSection[] = [...BENEFIT_CATEGORIES, 'other'];

export function benefitGroupKind(benefit: Pick<BenefitView, 'unit' | 'inTotals'>): BenefitGroupKind {
  if (benefit.inTotals) return 'credit';
  return benefit.unit === 'count' ? 'count' : 'window';
}

/**
 * A benefit's name as groups compare it: without ®, ™ or ℠, with
 * compatibility forms and accents folded, in lower case, "&" read as "and",
 * apostrophes and hyphens dropped ("Dunkin’", "Wi-Fi"), and any other run of
 * punctuation or spacing as one space. "+", "$" and "%" stay, because a
 * "Walmart+ credit" is not a Walmart credit.
 */
export function normalizeBenefitName(name: string): string {
  return name
    .replace(/[®™℠]/g, ' ')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['‘’ʼ‐‑-]/g, '')
    .replace(/[^\p{L}\p{N}+$%]+/gu, ' ')
    .trim();
}

/** Benefits with one key are one benefit: the same kind, the same counted thing, and the same comparison name once normalized. */
export function benefitGroupKey(benefit: Pick<BenefitView, 'name' | 'compareAs' | 'unit' | 'noun' | 'inTotals'>): string {
  const kind = benefitGroupKind(benefit);
  return [kind, kind === 'count' ? normalizeBenefitName(benefit.noun ?? '') : '', normalizeBenefitName(comparisonName(benefit))].join('|');
}

/** The name a benefit is compared under: the catalog's comparison name, else its own. */
export function comparisonName(benefit: Pick<BenefitView, 'name' | 'compareAs'>): string {
  return benefit.compareAs ?? benefit.name;
}

/**
 * What one period gives, when every active period of the year gives the
 * same, and how often: "$300 · Twice a year". Only how often when the
 * periods differ ($15 a month, $35 in December) or are not placed yet.
 */
export function benefitTerms(benefit: Pick<BenefitView, 'unit' | 'noun' | 'cadenceLabel' | 'periods'>): string {
  const amounts = [...new Set(benefit.periods.filter((period) => period.active).map((period) => period.availableMinor))];
  return amounts.length === 1 ? `${formatBenefitAmount(benefit, amounts[0])} · ${benefit.cadenceLabel}` : benefit.cadenceLabel;
}

/** A tag of a benefit: its terms, or what to know before using it. Tags with one key say the same. */
export interface BenefitTag {
  key: string;
  label: string;
  tone?: 'warning' | 'manual' | 'muted';
  title?: string;
}

/**
 * A benefit's tags as parts: what one period gives (when every active period of the year gives the same), how often,
 * then what to know before using it. An amount and its cadence are shown as one tag (joinTerms).
 */
function tagParts(benefit: BenefitView): BenefitTag[] {
  const amounts = [...new Set(benefit.periods.filter((period) => period.active).map((period) => period.availableMinor))];
  const tags: BenefitTag[] = [];
  if (amounts.length === 1) {
    const amount = formatBenefitAmount(benefit, amounts[0]);
    tags.push({ key: `amount|${amount}`, label: amount });
  }
  tags.push({ key: `cadence|${benefit.cadenceLabel}`, label: benefit.cadenceLabel });
  if (benefit.enrollment) tags.push({ key: 'enrollment', label: 'Enrollment required', tone: 'warning' });
  if (benefit.tracking === 'manual') {
    const title = manualReasonLabel(benefit.manualReason);
    tags.push({ key: `manual|${title}`, label: 'Mark by hand', tone: 'manual', title });
  }
  if (benefit.verify) tags.push({ key: 'verify', label: 'Unverified', tone: 'muted', title: UNVERIFIED_TITLE });
  return tags;
}

const isAmount = (tag: BenefitTag) => tag.key.startsWith('amount|');
const isCadence = (tag: BenefitTag) => tag.key.startsWith('cadence|');

/** Tags as shown: an amount beside its cadence reads as one, first ("$300 · Twice a year"). */
function joinTerms(tags: readonly BenefitTag[]): BenefitTag[] {
  const amount = tags.find(isAmount);
  const cadence = tags.find(isCadence);
  if (!amount || !cadence) return [...tags];
  const label = `${amount.label} · ${cadence.label}`;
  return [{ key: `terms|${label}`, label }, ...tags.filter((tag) => tag !== amount && tag !== cadence)];
}

/** A card's benefit's tags, as the By card view tags it, its terms with the amount. */
export function benefitTags(benefit: BenefitView): BenefitTag[] {
  return joinTerms(tagParts(benefit));
}

/**
 * A group's tags: what every card's benefit says alike is said once, for the group; each card says only the rest. How
 * often is said once when it is the same on every card, and the amount with it when that is the same too; an amount
 * alone is never said for the group ("$50" over a quarterly card and a monthly one would mislead). What only some
 * cards have (enrollment, Unverified) stays on those cards. `own` follows `benefits`' order.
 */
export function groupTags(benefits: readonly BenefitView[]): { shared: BenefitTag[]; own: BenefitTag[][] } {
  const lists = benefits.map(tagParts);
  if (lists.length === 0) return { shared: [], own: [] };
  const common = lists[0].filter((tag) => lists.every((tags) => tags.some((other) => other.key === tag.key)));
  const keys = new Set((common.some(isCadence) ? common : common.filter((tag) => !isAmount(tag))).map((tag) => tag.key));
  return {
    shared: joinTerms(lists[0].filter((tag) => keys.has(tag.key))),
    own: lists.map((tags) => joinTerms(tags.filter((tag) => !keys.has(tag.key)))),
  };
}

export interface BenefitGroupMember {
  card: CardBenefitsCardView;
  benefit: BenefitView;
}

export interface BenefitGroupYear {
  capturedMinor: number;
  availableMinor: number;
  unknownPeriods: number;
}

export interface BenefitGroup {
  /** Unique among the groups of one grouping. */
  key: string;
  kind: BenefitGroupKind;
  /** The first member's category, else `other`. */
  section: BenefitSection;
  /** The first member's comparison name (the catalog's, else its own). */
  name: string;
  unit: 'usd' | 'count';
  noun?: string;
  /** The note, when every member has the same one. */
  note?: string;
  /** Every card's benefit in the group, in card order (issuer, person, then the report's order). */
  members: BenefitGroupMember[];
  /** How many cards have it (a card is counted once). */
  cardCount: number;
  /** The compared cards that do not have it, in card order. */
  missing: CardBenefitsCardView[];
  /** What every card's benefit says alike (groupTags): said once, for the group; each card says only the rest. */
  sharedTags: BenefitTag[];
  /** The selected year added up across members, for credits and counts; null for once-every-few-years credits. */
  year: BenefitGroupYear | null;
  /** Members whose periods cannot be placed until their card's anniversary month is set: their year counts nothing yet. */
  unplaced: number;
  /** Once-every-few-years credits: how many members can use it as of today (never used, or eligible again); else null. */
  availableNow: number | null;
}

export interface BenefitGrouping {
  groups: BenefitGroup[];
  /** The cards compared, in card order: those whose product is known. */
  compared: CardBenefitsCardView[];
  /** Cards its owner set to track no benefits: not compared, so never said to lack one. In card order. */
  notTracked: CardBenefitsCardView[];
  /** The cards whose product is not known yet (none matched, or the chosen one left the catalog), in card order. */
  unknown: CardBenefitsCardView[];
}

/**
 * Whether a card takes part in the comparison: its product is known, so the
 * catalog says what it has. Without one (not chosen yet, or set to track no
 * benefits) nothing says which benefits it lacks.
 */
export function isComparedCard(card: Pick<CardBenefitsCardView, 'product'>): boolean {
  return card.product !== null;
}

/** Cards in the By card view's order: Amex, Chase, Citi, then other issuers; by person within; the report's order within. */
export function benefitCardOrder(cards: readonly CardBenefitsCardView[]): CardBenefitsCardView[] {
  return groupBenefitCards(cards).flatMap((issuer) => issuer.owners.flatMap((owner) => owner.cards));
}

const KIND_ORDER: Record<BenefitGroupKind, number> = { credit: 0, count: 1, window: 2 };

/** Whether a once-every-few-years credit can be used on `today`: never used as far as Holdr knows, or eligible again. */
function usableNow(benefit: Pick<BenefitView, 'window'>, today: string): boolean {
  return !benefit.window?.lastUsed || (benefit.window.nextEligible !== null && benefit.window.nextEligible <= today);
}

/**
 * The cards' benefits grouped by benefit. Two cards' benefits are one group
 * when their keys match (benefitGroupKey: same kind and normalized comparison
 * name), and always when they are the same benefit of the same product,
 * whatever a version calls it. Groups come by section (BENEFIT_SECTIONS);
 * within one, dollar credits first, the most available in the year first,
 * then counted benefits, then once-every-few-years credits, each by how many
 * cards have them; ties keep the order they first appear in. `today`
 * (YYYY-MM-DD) dates which once-every-few-years credits are usable.
 */
export function groupCardsByBenefit(cards: readonly CardBenefitsCardView[], today: string): BenefitGrouping {
  const ordered = benefitCardOrder(cards);
  const compared = ordered.filter(isComparedCard);
  const notTracked = ordered.filter((card) => !isComparedCard(card) && card.productChoice === 'none');
  const unknown = ordered.filter((card) => !isComparedCard(card) && card.productChoice !== 'none');
  const members: BenefitGroupMember[] = compared.flatMap((card) => card.benefits.map((benefit) => ({ card, benefit })));

  // Each set's root is its first member, so groups keep the order they first appear in.
  const parent = members.map((_, index) => index);
  const root = (index: number): number => {
    let at = index;
    while (parent[at] !== at) at = parent[at];
    return at;
  };
  const firstWithKey = new Map<string, number>();
  members.forEach(({ card, benefit }, index) => {
    const keys = [`name|${benefitGroupKey(benefit)}`];
    if (card.product) keys.push(`benefit|${card.product.id}|${benefit.id}`);
    for (const key of keys) {
      const seen = firstWithKey.get(key);
      if (seen === undefined) {
        firstWithKey.set(key, index);
        continue;
      }
      const [a, b] = [root(seen), root(index)];
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const sets = new Map<number, BenefitGroupMember[]>();
  members.forEach((member, index) => {
    const at = root(index);
    sets.set(at, [...(sets.get(at) ?? []), member]);
  });

  const groups = [...sets.entries()].map(([first, list]) => {
    const [head] = list;
    const kind = benefitGroupKind(head.benefit);
    const cardIds = new Set(list.map(({ card }) => card.cardAccountId));
    const notes = new Set(list.map(({ benefit }) => benefit.note));
    const year = kind === 'window' ? null : list.reduce<BenefitGroupYear>((sum, { benefit }) => ({
      capturedMinor: sum.capturedMinor + benefit.year.capturedMinor,
      availableMinor: sum.availableMinor + benefit.year.availableMinor,
      unknownPeriods: sum.unknownPeriods + benefit.year.unknownPeriods,
    }), { capturedMinor: 0, availableMinor: 0, unknownPeriods: 0 });
    const group: BenefitGroup = {
      key: benefitGroupKey(head.benefit),
      kind,
      section: head.benefit.category ?? 'other',
      name: comparisonName(head.benefit),
      unit: head.benefit.unit,
      ...(head.benefit.noun === undefined ? {} : { noun: head.benefit.noun }),
      ...(notes.size === 1 && head.benefit.note !== undefined ? { note: head.benefit.note } : {}),
      members: list,
      cardCount: cardIds.size,
      missing: compared.filter((card) => !cardIds.has(card.cardAccountId)),
      sharedTags: groupTags(list.map(({ benefit }) => benefit)).shared,
      year,
      unplaced: list.filter(({ benefit }) => benefit.needsAnniversary).length,
      availableNow: kind === 'window' ? list.filter(({ benefit }) => usableNow(benefit, today)).length : null,
    };
    return { group, first };
  });
  groups.sort((a, b) => BENEFIT_SECTIONS.indexOf(a.group.section) - BENEFIT_SECTIONS.indexOf(b.group.section)
    || KIND_ORDER[a.group.kind] - KIND_ORDER[b.group.kind]
    || (a.group.kind === 'credit' ? b.group.year!.availableMinor - a.group.year!.availableMinor : 0)
    || b.group.cardCount - a.group.cardCount
    || a.first - b.first);
  return { groups: groups.map(({ group }) => group), compared, notTracked, unknown };
}

/** A section's dollar credits added up for the year; null when it has none. */
export function sectionYear(groups: readonly Pick<BenefitGroup, 'kind' | 'year'>[]): BenefitGroupYear | null {
  const credits = groups.filter((group) => group.kind === 'credit' && group.year !== null);
  if (credits.length === 0) return null;
  return credits.reduce<BenefitGroupYear>((sum, { year }) => ({
    capturedMinor: sum.capturedMinor + year!.capturedMinor,
    availableMinor: sum.availableMinor + year!.availableMinor,
    unknownPeriods: sum.unknownPeriods + year!.unknownPeriods,
  }), { capturedMinor: 0, availableMinor: 0, unknownPeriods: 0 });
}

/**
 * What a group's year leaves out, in words: periods whose use is not known
 * (a benefit marked by hand and not marked yet, or an issuer that reported no
 * figure) count as nothing used, and a benefit not placed in its cardmember
 * year counts nothing available.
 */
export function groupYearNotes(group: Pick<BenefitGroup, 'year' | 'unplaced'>): string[] {
  const notes: string[] = [];
  const unknown = group.year?.unknownPeriods ?? 0;
  if (unknown > 0) notes.push(`${unknown} ${unknown === 1 ? 'period' : 'periods'} with use unknown`);
  if (group.unplaced > 0) notes.push(`${group.unplaced} ${group.unplaced === 1 ? 'card' : 'cards'} without an anniversary month`);
  return notes;
}

export interface MissingProduct {
  key: string;
  name: string;
  cards: CardBenefitsCardView[];
}

/** Cards without a benefit, by person, then by product (a card without one by its own name), in card order. */
export function missingByOwner(cards: readonly CardBenefitsCardView[]): Array<{ owner: CardOwner; products: MissingProduct[] }> {
  return OWNERS.map((owner) => {
    const products = new Map<string, MissingProduct>();
    for (const card of cards) {
      if (card.owner !== owner) continue;
      const key = card.product ? `product:${card.product.id}` : `card:${card.cardAccountId}`;
      const entry = products.get(key) ?? { key, name: cardTitle(card), cards: [] };
      entry.cards.push(card);
      products.set(key, entry);
    }
    return { owner, products: [...products.values()] };
  }).filter((entry) => entry.products.length > 0);
}

/**
 * A product's cards without a benefit, in words that account for each card:
 * "Gold ··9155 ··6823", "Gold ··9155 +1" (one more without an ending),
 * "Gold ×2" (two, neither with an ending).
 */
export function missingProductLabel(product: Pick<MissingProduct, 'name' | 'cards'>): string {
  const endings = product.cards.map(cardEndingLabel).filter((ending) => ending !== '');
  const unnamed = product.cards.length - endings.length;
  const rest = endings.length > 0 ? (unnamed > 0 ? ` +${unnamed}` : '') : (unnamed > 1 ? ` ×${unnamed}` : '');
  return [product.name, ...endings].join(' ') + rest;
}

/**
 * What issuers reported that no catalog benefit maps, by the issuer's own
 * tracker id: each with every card that reported it, in card order.
 */
export function issuerTrackerGroups(cards: readonly CardBenefitsCardView[]): Array<{
  key: string;
  name: string;
  entries: Array<{ card: CardBenefitsCardView; tracker: BenefitIssuerFigure }>;
}> {
  const groups = new Map<string, { key: string; name: string; entries: Array<{ card: CardBenefitsCardView; tracker: BenefitIssuerFigure }> }>();
  for (const card of benefitCardOrder(cards)) {
    for (const tracker of card.issuerTrackers) {
      const key = `${card.issuer}|${tracker.issuerBenefitId}`;
      const group = groups.get(key) ?? { key, name: tracker.name, entries: [] };
      group.entries.push({ card, tracker });
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}
