/**
 * Category splits of card rows. A reviewed source (Amazon orders, from their
 * import) may say which categories a posted card purchase or refund paid for.
 * Spending keeps every ledger figure (totals, months, merchants, cards,
 * owners, row counts) and only files a split row's amount under the
 * categories of its parts. Nothing here reads or writes such a source: a
 * resolver hands parts in, this module validates them, and whatever it cannot
 * accept keeps its row whole, counted under a fixed reason.
 *
 * Rules (the Spending ⇄ Amazon contract):
 * - only posted purchases and refunds without a custom category split; a
 *   custom category keeps the whole row in it, whatever the parts say;
 * - a split says how the source tied the row to its order: a payment event,
 *   or (lower evidence) a unique order total;
 * - parts are nonzero safe integers in the row's currency, each with the row's
 *   sign, and add up to the row's amount exactly;
 * - a part names a reviewed category (an item override may name a new one, an
 *   agent classification or a reviewed mapping only one in use), or none: the
 *   residual, filed under the row's own effective category;
 * - without a resolver nothing is split, and the marker says so.
 *
 * Every function is pure and deterministic.
 */

import { cardCategoryPartTotals, effectiveCardCategory } from './cardSpending.js';
import type { CardCategoryInferenceMarker, CardCategoryRowSourceCounts } from './cardCategoryInference.js';
import type { CardTransactionKind, CardTransactionStatus } from './types.js';

/** Which categories a Spending answer files amounts under: split parts where accepted, or each row's own. */
export type CardCategoryBasis = 'enriched' | 'original';

export const CARD_CATEGORY_BASES: readonly CardCategoryBasis[] = ['enriched', 'original'];

export function isCardCategoryBasis(value: unknown): value is CardCategoryBasis {
  return value === 'enriched' || value === 'original';
}

/**
 * How a source tied a card row to its Amazon order: a payment event the order lists, or (lower evidence) the
 * order's grand total matching exactly one row of a bound card. Every marker counts split rows by both.
 */
export const CARD_CATEGORY_EVIDENCE_CLASSES = ['payment-event', 'unique-total-match', 'payment-ledger-complete'] as const;
export type CardCategoryEvidenceClass = (typeof CARD_CATEGORY_EVIDENCE_CLASSES)[number];

export function isCardCategoryEvidenceClass(value: unknown): value is CardCategoryEvidenceClass {
  return typeof value === 'string' && (CARD_CATEGORY_EVIDENCE_CLASSES as readonly string[]).includes(value);
}

/**
 * Why a source keeps a row whole on its own account: a fixed vocabulary, never free text. The last two are a
 * receipt's precious metals (Costco receipts 4/7 §7.4): `asset-purchase` when a line is one, `asset-uncertain` when
 * one may be. The Amazon domain never gives them.
 */
export const CARD_CATEGORY_HOLD_REASONS = [
  'match-held',
  'mixed-tender-unproven',
  'item-identity-unproven',
  'negative-component',
  'currency-mismatch',
  'inconsistent-evidence',
  'refund-unattributed',
  'asset-purchase',
  'asset-uncertain',
] as const;
export type CardCategoryHoldReason = (typeof CARD_CATEGORY_HOLD_REASONS)[number];

export function isCardCategoryHoldReason(value: unknown): value is CardCategoryHoldReason {
  return typeof value === 'string' && (CARD_CATEGORY_HOLD_REASONS as readonly string[]).includes(value);
}

/** Why Spending refused a split: a fixed vocabulary. */
export const CARD_CATEGORY_INVALID_REASONS = [
  'malformed',
  'key-mismatch',
  'not-in-scope',
  'not-eligible',
  'bad-hold-reason',
  'bad-evidence-class',
  'not-linked',
  'currency-mismatch',
  'too-many-parts',
  'incoherent-part',
  'duplicate-part',
  'bad-item-ref',
  'bad-amount',
  'sign-mismatch',
  'sum-mismatch',
  'bad-category',
  'unknown-mapped-category',
] as const;
export type CardCategoryInvalidReason = (typeof CARD_CATEGORY_INVALID_REASONS)[number];

export const MAX_CARD_CATEGORY_PARTS = 200;
const MAX_CATEGORY_LENGTH = 100;
/** An opaque, household-scoped item reference: never a native order or item id. */
export const CARD_CATEGORY_ITEM_REF = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Who chose a part's category: the owner's override for the item (may name a new category), an agent's
 * classification of the item into the household's categories, or a reviewed mapping of the source's own category. An
 * Amazon Fresh Item List line's part (Amazon's Fresh split policy) says its item category's card category chose it
 * (`item-taxonomy`), or that it is Groceries' visible default while nothing classifies the line (`fresh-default`).
 */
export type CardCategoryPartSource = 'item-override' | 'agent-classification' | 'reviewed-mapping' | 'item-taxonomy' | 'fresh-default';
export type CardCategoryPartClass = 'source' | 'policy-allocated' | 'residual';

const PART_SOURCES: readonly CardCategoryPartSource[] = ['item-override', 'agent-classification', 'reviewed-mapping', 'item-taxonomy',
  'fresh-default'];

/** One part of a row as a source states it. */
export interface CardCategoryContribution {
  /** Nonzero safe integer, with the row's sign. */
  amountMinor: number;
  /** Null exactly for the residual, which stays under the row's own effective category. */
  category: string | null;
  /** Null exactly when `category` is. */
  categorySource: CardCategoryPartSource | null;
  /** `residual` exactly when `category` is null. */
  classification: CardCategoryPartClass;
  /** Opaque and household-scoped, never a native order or item id; non-residual parts only. */
  itemRef?: string;
}

export type CardCategoryResolution =
  | {
    kind: 'split';
    cardTransactionId: string;
    currency: string;
    evidenceClass: CardCategoryEvidenceClass;
    contributions: readonly CardCategoryContribution[];
  }
  | { kind: 'whole-row'; cardTransactionId: string; reason: CardCategoryHoldReason };

export interface CardCategoryResolverInput {
  id: string;
  currency: string;
  amountMinor: number;
}

/** One request's view of a source: every period of that request uses the same snapshot. */
export interface CardCategoryResolverSnapshot {
  /** Changes whenever anything that decides a split changes. */
  readonly version: string;
  /** Resolutions for the rows asked about; anything else is ignored. A throw is an operational failure. */
  resolve(rows: readonly CardCategoryResolverInput[]): ReadonlyMap<string, CardCategoryResolution>;
}

export interface CardCategoryResolver {
  snapshot(): CardCategoryResolverSnapshot;
}

/** An accepted part as reports use it: the residual already under the row's own effective category. */
export interface CardCategoryPart {
  category: string;
  amountMinor: number;
  categorySource: CardCategoryPartSource | 'original-effective';
  classification: CardCategoryPartClass;
  itemRef?: string;
}

export interface CardCategoryCurrencyAmount {
  currency: string;
  amountMinor: number;
}

/**
 * What a Spending answer's categories are based on. Counts and totals only; no row is named. The counts are the
 * answer's own: the rows it reports (a list, its page), and under a category filter only their parts in it.
 */
export interface CardCategoryBasisMarker {
  requested: CardCategoryBasis;
  /** What the amounts use: `enriched` only when some row the answer reports is filed under its parts. */
  effective: CardCategoryBasis;
  /** `unavailable`: no resolver is configured, so nothing can be split. */
  availability: 'available' | 'unavailable' | 'not-requested';
  /** The resolver snapshot's version, `none` without a resolver, or `original`. */
  version: string;
  /** Rows the answer reports through their parts. */
  splitRows: number;
  /**
   * The split rows by how their order was tied to them, always both classes (a count of 0 included): the share
   * resting on the lower-evidence unique order total is never left implicit.
   */
  splitRowsByEvidence: Array<{ evidenceClass: CardCategoryEvidenceClass; count: number }>;
  /** Rows the source split that a custom category keeps whole. */
  keptWholeByUserCategory: number;
  /** Rows the source itself kept whole, by its reason. */
  heldOrDeclined: Array<{ reason: CardCategoryHoldReason; count: number }>;
  /**
   * Splits Spending refused (their rows stay whole), by reason. `not-in-scope` counts answers about rows the request
   * did not have at all: they are the request's, so every marker of the request has them.
   */
  invalid: Array<{ reason: CardCategoryInvalidReason; count: number }>;
  /** Within the split rows' reported parts, per currency: amounts a policy allocated, and residuals. */
  policyAllocatedMinor: CardCategoryCurrencyAmount[];
  residualMinor: CardCategoryCurrencyAmount[];
  /**
   * Enriched answers only (an original answer is exactly the one before them): the rows the answer files under a
   * category, each once by where its category comes from (cardCategoryInference.ts). `effective` is `enriched`
   * when any of them is split or inferred.
   */
  rowsBySource?: CardCategoryRowSourceCounts;
  /**
   * Enriched answers only: the version of the reviewed rules inferred categories came from, and the rows counted as
   * inferred by basis (merchant history, rule), both always listed, a count of 0 included.
   */
  inference?: CardCategoryInferenceMarker;
}

/**
 * What became of one row the source answered about. A row the owner's own category keeps whole still carries the
 * source's parts when they are valid, for its detail to list; reports never use them.
 */
export type CardCategoryOutcome =
  | { kind: 'split'; currency: string; evidenceClass: CardCategoryEvidenceClass; parts: readonly CardCategoryPart[] }
  | { kind: 'kept-whole-by-user-category'; parts?: readonly CardCategoryPart[] }
  | { kind: 'held'; reason: CardCategoryHoldReason }
  | { kind: 'invalid'; reason: CardCategoryInvalidReason };

/** The fields of a stored row a split decision needs. */
export interface CardCategorySplitRow {
  id: string;
  status: CardTransactionStatus;
  kind: CardTransactionKind;
  currency: string;
  amountMinor: number;
  userCategory?: string | null;
  issuerCategory?: string | null;
  /**
   * An inferred category (cardCategoryInference.ts): a residual with no issuer category goes there, as does one whose
   * issuer's category a rule takes precedence over (a tax payment).
   */
  inferredCategory?: string | null;
}

export interface CardCategorySplitOptions {
  requested: CardCategoryBasis;
  /** The request's snapshot; null when no resolver is configured. */
  snapshot: CardCategoryResolverSnapshot | null;
  /** Holdr categories in use: an agent classification or a reviewed mapping may name only these. */
  knownCategories: ReadonlySet<string>;
  /** The rules a custom category name passes (no card data, no hidden characters). */
  isAllowedCategoryName: (name: string) => boolean;
  /**
   * Whether the source itself links the row to its order, when it can say (the Amazon domain's card details): a
   * split for a row it holds or does not link contradicts it, and is refused as `not-linked`.
   */
  isLinkedRow?: (id: string) => boolean;
}

export interface CardCategorySplits {
  /** Accepted parts per row id. */
  parts: ReadonlyMap<string, readonly CardCategoryPart[]>;
  /** What became of each row the source answered for, by row id (a row that cannot split: `not-eligible`). */
  outcomes: ReadonlyMap<string, CardCategoryOutcome>;
  /** Answers about rows the request did not have at all (`not-in-scope`). */
  strayAnswers: number;
  /** The marker of an answer reporting every row given (see {@link cardCategoryBasisMarkerFor} for fewer). */
  marker: CardCategoryBasisMarker;
}

/** A posted purchase or refund with an amount: the only rows a source may split. */
export function cardCategorySplitEligible(row: Pick<CardCategorySplitRow, 'status' | 'kind' | 'amountMinor'>): boolean {
  return row.status === 'posted' && (row.kind === 'purchase' || row.kind === 'refund') && row.amountMinor !== 0;
}

/** A marker with nothing split: the amounts are the original ones, whatever the availability. */
function emptyMarker(requested: CardCategoryBasis, availability: CardCategoryBasisMarker['availability'], version: string): CardCategoryBasisMarker {
  return {
    requested,
    effective: 'original',
    availability,
    version,
    splitRows: 0,
    splitRowsByEvidence: CARD_CATEGORY_EVIDENCE_CLASSES.map((evidenceClass) => ({ evidenceClass, count: 0 })),
    keptWholeByUserCategory: 0,
    heldOrDeclined: [],
    invalid: [],
    policyAllocatedMinor: [],
    residualMinor: [],
  };
}

/** The marker of an answer that never asked a resolver: the original basis, or the split one without a resolver. */
export function cardCategoryBasisWithoutSplits(requested: CardCategoryBasis): CardCategoryBasisMarker {
  return requested === 'original'
    ? emptyMarker('original', 'not-requested', 'original')
    : emptyMarker('enriched', 'unavailable', 'none');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Checked = { ok: true; parts: CardCategoryPart[] } | { ok: false; reason: CardCategoryInvalidReason };

/** The checks of one `split`, against its row; precedence and eligibility are decided before. */
function checkSplit(
  row: CardCategorySplitRow,
  resolution: Record<string, unknown>,
  options: CardCategorySplitOptions,
): Checked {
  if (!isCardCategoryEvidenceClass(resolution.evidenceClass)) return { ok: false, reason: 'bad-evidence-class' };
  if (resolution.currency !== row.currency) return { ok: false, reason: 'currency-mismatch' };
  const contributions = resolution.contributions;
  if (!Array.isArray(contributions) || contributions.length === 0) return { ok: false, reason: 'malformed' };
  if (contributions.length > MAX_CARD_CATEGORY_PARTS) return { ok: false, reason: 'too-many-parts' };
  const residualCategory = effectiveCardCategory(row);
  const seenItems = new Set<string>();
  let residuals = 0;
  let sum = 0;
  const parts: CardCategoryPart[] = [];
  for (const contribution of contributions as unknown[]) {
    if (!isPlainRecord(contribution)) return { ok: false, reason: 'malformed' };
    const { amountMinor, category, categorySource, classification, itemRef } = contribution;
    // Coherence: a residual has neither a category nor a source; every other part has both.
    if (classification !== 'source' && classification !== 'policy-allocated' && classification !== 'residual') {
      return { ok: false, reason: 'incoherent-part' };
    }
    const residual = classification === 'residual';
    if (residual !== (category === null) || residual !== (categorySource === null)) return { ok: false, reason: 'incoherent-part' };
    if (!residual && !(PART_SOURCES as readonly unknown[]).includes(categorySource)) return { ok: false, reason: 'incoherent-part' };
    if (itemRef !== undefined) {
      if (residual || typeof itemRef !== 'string' || !CARD_CATEGORY_ITEM_REF.test(itemRef)) return { ok: false, reason: 'bad-item-ref' };
      const key = `${itemRef}\u0000${classification}`;
      if (seenItems.has(key)) return { ok: false, reason: 'duplicate-part' };
      seenItems.add(key);
    }
    if (residual) {
      residuals += 1;
      if (residuals > 1) return { ok: false, reason: 'duplicate-part' };
    }
    if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor === 0) {
      return { ok: false, reason: 'bad-amount' };
    }
    if (Math.sign(amountMinor) !== Math.sign(row.amountMinor)) return { ok: false, reason: 'sign-mismatch' };
    sum += amountMinor;
    if (!Number.isSafeInteger(sum)) return { ok: false, reason: 'sum-mismatch' };
    let name = residualCategory;
    if (!residual) {
      if (typeof category !== 'string' || category.length === 0 || category.length > MAX_CATEGORY_LENGTH
        || category.trim() !== category || !options.isAllowedCategoryName(category)) {
        return { ok: false, reason: 'bad-category' };
      }
      // Only the owner's own override may name a new category; an agent or a reviewed mapping never invents one.
      if (categorySource !== 'item-override' && !options.knownCategories.has(category)) {
        return { ok: false, reason: 'unknown-mapped-category' };
      }
      name = category;
    }
    parts.push({
      category: name,
      amountMinor,
      categorySource: residual ? 'original-effective' : categorySource as CardCategoryPartSource,
      classification,
      ...(typeof itemRef === 'string' ? { itemRef } : {}),
    });
  }
  if (sum !== row.amountMinor) return { ok: false, reason: 'sum-mismatch' };
  return { ok: true, parts };
}

function bump<K extends string>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function addAmount(totals: Map<string, number>, currency: string, amountMinor: number): void {
  totals.set(currency, (totals.get(currency) ?? 0) + amountMinor);
}

function counted<K extends string>(counts: Map<K, number>): Array<{ reason: K; count: number }> {
  return [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([reason, count]) => ({ reason, count }));
}

function amounts(totals: Map<string, number>): CardCategoryCurrencyAmount[] {
  return [...totals].filter(([, amountMinor]) => amountMinor !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, amountMinor]) => ({ currency, amountMinor }));
}

/**
 * The accepted splits of `rows`, what became of each row the source answered for, and the marker of an answer
 * reporting all of them. The original basis never asks the resolver; without one the split basis is unavailable.
 * A resolver that throws, or answers with something other than a map, is an operational failure and throws: it
 * never reads as "no splits".
 */
export function resolveCardCategorySplits(rows: readonly CardCategorySplitRow[], options: CardCategorySplitOptions): CardCategorySplits {
  if (options.requested === 'original' || options.snapshot === null) {
    return { parts: new Map(), outcomes: new Map(), strayAnswers: 0, marker: cardCategoryBasisWithoutSplits(options.requested) };
  }
  const { snapshot } = options;
  const version = snapshot.version;
  if (typeof version !== 'string' || version.length === 0) throw new Error('the category resolver has no version');
  const eligible = rows.filter(cardCategorySplitEligible);
  const byId = new Map(eligible.map((row) => [row.id, row]));
  const inScope = new Set(rows.map((row) => row.id));
  const answer = snapshot.resolve(eligible.map((row) => ({ id: row.id, currency: row.currency, amountMinor: row.amountMinor })));
  if (!(answer instanceof Map)) throw new Error('the category resolver did not answer with a map');

  let strayAnswers = 0;
  const outcomes = new Map<string, CardCategoryOutcome>();
  const parts = new Map<string, readonly CardCategoryPart[]>();
  for (const [key, value] of answer as Map<unknown, unknown>) {
    const row = typeof key === 'string' ? byId.get(key) : undefined;
    if (!row) {
      // A row of the request that cannot split is that row's; a row the request does not have is nobody's.
      if (typeof key === 'string' && inScope.has(key)) outcomes.set(key, { kind: 'invalid', reason: 'not-eligible' });
      else strayAnswers += 1;
      continue;
    }
    const outcome = outcomeOf(row, value, options);
    outcomes.set(row.id, outcome);
    if (outcome.kind === 'split') parts.set(row.id, outcome.parts);
  }
  const splits = { parts, outcomes, strayAnswers, marker: emptyMarker('enriched', 'available', version) };
  return { ...splits, marker: cardCategoryBasisMarkerFor(splits, rows.map((row) => row.id)) };
}

/** One answer about an eligible row, checked: the parts it is filed under, or why it stays whole. */
function outcomeOf(row: CardCategorySplitRow, value: unknown, options: CardCategorySplitOptions): CardCategoryOutcome {
  if (!isPlainRecord(value) || (value.kind !== 'split' && value.kind !== 'whole-row')) return { kind: 'invalid', reason: 'malformed' };
  if (value.cardTransactionId !== row.id) return { kind: 'invalid', reason: 'key-mismatch' };
  if (value.kind === 'whole-row') {
    return isCardCategoryHoldReason(value.reason) ? { kind: 'held', reason: value.reason } : { kind: 'invalid', reason: 'bad-hold-reason' };
  }
  const checked = checkSplit(row, value, options);
  // A split the source's own detail does not back (a held or unlinked row) is never filed or listed.
  const linked = options.isLinkedRow ? options.isLinkedRow(row.id) : true;
  // Precedence: the owner's own category for the row wins over any split; valid parts stay for its detail only.
  if (row.userCategory) return { kind: 'kept-whole-by-user-category', ...(checked.ok && linked ? { parts: checked.parts } : {}) };
  if (!linked) return { kind: 'invalid', reason: 'not-linked' };
  return checked.ok
    ? { kind: 'split', currency: row.currency, evidenceClass: value.evidenceClass as CardCategoryEvidenceClass, parts: checked.parts }
    : { kind: 'invalid', reason: checked.reason };
}

/**
 * The marker of an answer that reports the rows `rowIds` and, under a category filter (`category`, as the filter
 * spells it), only their parts in that category: the rows it shows, never the others the request looked at.
 * Rows filed under parts make it `enriched`; with none, its amounts are the original ones.
 */
export function cardCategoryBasisMarkerFor(splits: CardCategorySplits, rowIds: Iterable<string>, category?: string): CardCategoryBasisMarker {
  if (splits.marker.availability !== 'available') return splits.marker;
  const marker = emptyMarker('enriched', 'available', splits.marker.version);
  const held = new Map<CardCategoryHoldReason, number>();
  const invalid = new Map<CardCategoryInvalidReason, number>(splits.strayAnswers > 0 ? [['not-in-scope', splits.strayAnswers]] : []);
  const byEvidence = new Map<CardCategoryEvidenceClass, number>();
  const policy = new Map<string, number>();
  const residual = new Map<string, number>();
  for (const id of new Set(rowIds)) {
    const outcome = splits.outcomes.get(id);
    if (!outcome) continue;
    if (outcome.kind === 'kept-whole-by-user-category') marker.keptWholeByUserCategory += 1;
    else if (outcome.kind === 'held') bump(held, outcome.reason);
    else if (outcome.kind === 'invalid') bump(invalid, outcome.reason);
    else {
      const reported = category === undefined ? outcome.parts : outcome.parts.filter((part) => part.category === category);
      if (reported.length === 0) continue;
      marker.splitRows += 1;
      bump(byEvidence, outcome.evidenceClass);
      for (const part of reported) {
        if (part.classification === 'policy-allocated') addAmount(policy, outcome.currency, part.amountMinor);
        if (part.classification === 'residual') addAmount(residual, outcome.currency, part.amountMinor);
      }
    }
  }
  marker.effective = marker.splitRows > 0 ? 'enriched' : 'original';
  marker.splitRowsByEvidence = CARD_CATEGORY_EVIDENCE_CLASSES.map((evidenceClass) => ({ evidenceClass, count: byEvidence.get(evidenceClass) ?? 0 }));
  marker.heldOrDeclined = counted(held);
  marker.invalid = counted(invalid);
  marker.policyAllocatedMinor = amounts(policy);
  marker.residualMinor = amounts(residual);
  return marker;
}

/** A split row's amount per category, largest first (ties by name): what a view lists. */
export function cardCategorySplitView(parts: readonly CardCategoryPart[]): Array<{ category: string; amountMinor: number }> {
  return [...cardCategoryPartTotals(parts)]
    .map(([category, amountMinor]) => ({ category, amountMinor }))
    .sort((a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor) || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
}

/** The category with the largest amount once parts are added up per category; ties go to the name first in order. */
export function largestCardCategory(parts: readonly CardCategoryPart[]): string {
  return cardCategorySplitView(parts)[0]?.category ?? '';
}

/** What a split row puts in `category`; zero when none of its parts is there. */
export function cardCategoryPortion(parts: readonly CardCategoryPart[], category: string): number {
  return cardCategoryPartTotals(parts).get(category) ?? 0;
}
