import type { Database } from 'better-sqlite3';
import { CARD_CATEGORY_EVIDENCE_CLASSES, amazonCardChargeKind, containsCardData, containsCardSecret, containsLongDigitRun, normalizeCardText } from '@finance-tracker/shared';
import { addDays, digest, minor, POLICY_DIGEST, LEDGER_POLICY_DIGEST, ORDER_HISTORY_POLICY_DIGEST, ref } from './policy.js';
import { activeBindings, readCardInventory } from './bindings.js';
import { matchAmazon, readLedger, readSubjects } from './matcher.js';
import { hasAmazonSchema } from './schema.js';
import type { Allocation, CategoryResolver, Contribution, EvidenceClass, LedgerRow, MatchResult, MatchSubject, Resolution } from './types.js';
import { productKey, publicTitle } from './products.js';
import { inertSplitResult } from './tipSplit.js';
import { allocateLedgerSubjects } from './allocation.js';
import { FRESH_SPLIT_POLICY_DIGEST, freshSplit, readFreshSplitOrders, type FreshSplitOrder } from './freshSplit.js';
import { cachedImages, hasCachedImage, type AmazonCachedImages } from './images.js';
import { itemizeRefundCredits, decideRefundCredits, ledgerRefund, readRefundEvidence, refundCreditInputs, REFUND_CREDIT_POLICY_DIGEST,
  REFUND_HOLD_REASONS, REFUND_ORDER_PROOFS, type RefundCharge, type RefundDecision, type RefundHoldReason,
  type RefundOrderProof, type RefundPart } from './refundCredits.js';
export { largestRemainder } from './allocation.js';

export function validCategory(value: string): boolean {
  return Boolean(value && value === value.trim() && value.length <= 100 && normalizeCardText(value) === value
    && !/[\x00-\x1f\x7f<>]/.test(value) && !containsCardData(value) && !containsCardSecret(value) && !containsLongDigitRun(value));
}
/** Same closed names as Spending's listCardCategories, including overridden issuer names. */
export function effectiveCategories(db: Database): string[] {
  return (db.prepare(`SELECT user_category AS category FROM card_transactions WHERE user_category IS NOT NULL
    UNION SELECT issuer_category FROM card_transactions WHERE issuer_category IS NOT NULL
    ORDER BY category`).pluck().all() as string[]).filter(validCategory);
}
export function resolveSubject(row: LedgerRow, subject: MatchSubject, categories: ReadonlySet<string>,
  mappings: ReadonlyMap<string, string>, overrides: ReadonlyMap<string, string>,
  agents: ReadonlyMap<string, string> = new Map(), classificationHeld: ReadonlySet<string> = new Set()): Resolution {
  const whole = (reason: Extract<Resolution, { kind: 'whole-row' }>['reason']): Resolution => (
    { kind: 'whole-row', cardTransactionId: row.id, reason }
  );
  if (row.status !== 'posted' || !['purchase', 'refund'].includes(row.kind) || !minor(row.amountMinor)
    || row.amountMinor === 0) return whole('inconsistent-evidence');
  if (subject.tenderProof === 'mixed' && !subject.allocationComplete) return whole('mixed-tender-unproven');
  if (subject.allocationHoldReason) return whole(subject.allocationHoldReason);
  if (!subject.allocationComplete || !subject.allocations.length) return whole('item-identity-unproven');
  if (subject.money.currency !== row.currency || subject.allocations.some(a => a.currency !== row.currency)) return whole('currency-mismatch');
  const policy = subject.allocations.some(a => a.attribution === 'order-total-policy');
  const ledgerPolicy = subject.allocations.some(a => a.attribution === 'payment-ledger-policy');
  if (ledgerPolicy && (subject.evidenceClass !== 'payment-ledger-complete'
    || !subject.ledgerObservation || subject.nativeOccurrenceId !== null
    || subject.status !== 'completed' || subject.orderRefs.length !== 1
    || subject.provenance !== (row.kind === 'purchase' ? 'ledger-Charged' : 'ledger-Refunded')
    || subject.allocations.some(a => a.attribution !== 'payment-ledger-policy' || a.classification !== 'policy-allocated'))) {
    return whole('inconsistent-evidence');
  }
  if (policy && (subject.evidenceClass !== 'unique-total-match' || subject.provenance !== 'order-total'
    || subject.tenderProof !== 'single-card-complete' || row.kind !== 'purchase' || row.amountMinor <= 0
    || subject.allocations.some(a => a.attribution !== 'order-total-policy'))) return whole('inconsistent-evidence');
  if (subject.money.amountMinor !== row.amountMinor || subject.allocations.length > 200
    || new Set(subject.allocations.map(a => `${a.itemRef}:${a.classification ?? 'source'}`)).size !== subject.allocations.length
    || subject.allocations.some(a => !ref(a.itemRef) || !['explicit-payment-item', 'order-total-policy', 'payment-ledger-policy'].includes(a.attribution)
      || (a.classification !== undefined && !['source', 'policy-allocated'].includes(a.classification)))) return whole('inconsistent-evidence');
  return categorizedSplit(row, subject.evidenceClass, subject.allocations, policy || ledgerPolicy,
    categories, mappings, overrides, agents, classificationHeld);
}
/**
 * The split a row's validated item allocation files: each part under its item's category (override, agent, reviewed
 * mapping), the uncategorized remainder as one residual under the row's own effective category. `exact`: the parts
 * must add up to the whole row.
 */
function categorizedSplit(row: LedgerRow, evidenceClass: EvidenceClass,
  allocations: ReadonlyArray<Pick<Allocation, 'itemRef' | 'amountMinor' | 'sourceCategory' | 'classification'>>, exact: boolean,
  categories: ReadonlySet<string>, mappings: ReadonlyMap<string, string>, overrides: ReadonlyMap<string, string>,
  agents: ReadonlyMap<string, string>, classificationHeld: ReadonlySet<string>): Resolution {
  const whole = (reason: Extract<Resolution, { kind: 'whole-row' }>['reason']): Resolution => (
    { kind: 'whole-row', cardTransactionId: row.id, reason }
  );
  const contributions: Contribution[] = [];
  let sum = 0n;
  for (const allocation of allocations) {
    if (!minor(allocation.amountMinor)) return whole('inconsistent-evidence');
    if (allocation.amountMinor === 0) continue;
    if (Math.sign(allocation.amountMinor) !== Math.sign(row.amountMinor)) return whole('negative-component');
    sum += BigInt(allocation.amountMinor);
    const override = overrides.get(allocation.itemRef);
    const agent = agents.get(allocation.itemRef);
    const mapped = allocation.sourceCategory ? mappings.get(allocation.sourceCategory) : undefined;
    const category = classificationHeld.has(allocation.itemRef) ? undefined : override ?? agent ?? mapped;
    if (category && (!validCategory(category) || (!override && !categories.has(category)))) return whole('inconsistent-evidence');
    if (category) contributions.push({ itemRef: allocation.itemRef, amountMinor: allocation.amountMinor,
      category, categorySource: override ? 'item-override' : agent ? 'agent-classification' : 'reviewed-mapping',
      classification: allocation.classification ?? 'source' });
  }
  if ((row.amountMinor > 0 && sum > BigInt(row.amountMinor)) || (row.amountMinor < 0 && sum < BigInt(row.amountMinor))) {
    return whole('inconsistent-evidence');
  }
  if (exact && sum !== BigInt(row.amountMinor)) return whole('inconsistent-evidence');
  // Uncategorized/unproven remainder stays in the card row's original effective category.
  const categorized = contributions.reduce((n, p) => n + BigInt(p.amountMinor), 0n);
  const residual = BigInt(row.amountMinor) - categorized;
  if (residual) contributions.push({ amountMinor: Number(residual), category: null, categorySource: null, classification: 'residual' });
  if (contributions.length > 200) return whole('inconsistent-evidence');
  return { kind: 'split', cardTransactionId: row.id, currency: row.currency, evidenceClass, contributions };
}
/**
 * A linked credit's split from its item parts (refundCredits.ts: mirrored from a full refund's charges, or attributed
 * to the lines a partial refund paid back): a live posted credit, every part negative, in its currency, on a distinct
 * opaque item, adding up to the whole credit. Anything else keeps it whole.
 */
export function resolveRefundCredit(row: LedgerRow, evidenceClass: EvidenceClass, parts: readonly RefundPart[],
  categories: ReadonlySet<string>, mappings: ReadonlyMap<string, string>, overrides: ReadonlyMap<string, string>,
  agents: ReadonlyMap<string, string> = new Map(), classificationHeld: ReadonlySet<string> = new Set()): Resolution {
  if (row.status !== 'posted' || row.kind !== 'refund' || !minor(row.amountMinor) || row.amountMinor >= 0 || !parts.length
    || parts.length > 200 || new Set(parts.map(p => p.itemRef)).size !== parts.length
    || parts.some(p => !ref(p.itemRef) || p.classification !== 'policy-allocated')) {
    return { kind: 'whole-row', cardTransactionId: row.id, reason: 'inconsistent-evidence' };
  }
  if (parts.some(p => p.currency !== row.currency)) return { kind: 'whole-row', cardTransactionId: row.id, reason: 'currency-mismatch' };
  return categorizedSplit(row, evidenceClass, parts, true, categories, mappings, overrides, agents, classificationHeld);
}
export interface AmazonCardDetail {
  version: string;
  match: 'linked' | 'held' | 'none';
  evidenceClass?: EvidenceClass;
  orderRefs?: string[];
  /** `image`: present only when the owner-only cache holds a thumbnail for the item's ASIN. */
  items?: Array<{ itemRef: string; title: string; quantity: number | null; asin: string | null; image?: true }>;
  parts?: Array<{ category: string; categorySource: 'item-override' | 'agent-classification' | 'reviewed-mapping' | 'item-taxonomy'
    | 'fresh-default' | 'original-effective';
    classification: Contribution['classification']; amountMinor: number; itemRef?: string }>;
  hold?: { reason: 'match-held'; candidateCount: number };
  coverage: { complete: boolean; provenFrom?: string; provenTo?: string };
}
export interface AmazonSnapshot extends ReturnType<CategoryResolver['snapshot']> {
  readonly getCardDetail: (id: string) => AmazonCardDetail;
  readonly getOrderMatches: (orderRef: string) => OrderMatchView[];
  readonly isAmazonCharge: (id: string) => boolean;
  /**
   * A card row linked to an Amazon order, if it is a live posted purchase: `itemized` when the domain files it under
   * its items (an accepted split with an item part, and no category of the owner's own: `itemizedRows`' rule, without
   * its period, currency or descriptor), else `whole`. Null for any other row. No period: the caller scopes.
   */
  readonly linkedChargeItemization: (id: string) => 'itemized' | 'whole' | null;
  readonly matchCounts: Readonly<AmazonMatchCounts>;
}
export const AMAZON_ITEMIZATION_REASONS = ['match-held', 'binding-held', 'evidence-held', 'no-candidate', 'ambiguous',
  'multiple-orders', 'mixed-tender-unproven', 'item-identity-unproven', 'negative-component',
  'currency-mismatch', 'inconsistent-evidence', 'refund-unattributed', 'user-category', 'no-evidence', 'category-unreviewed'] as const;
export const AMAZON_LEDGER_OBSERVATION_REASONS = ['unique', 'binding-held', 'evidence-held', 'no-candidate',
  'ambiguous', 'multiple-orders', 'superseded', 'corroborated'] as const satisfies readonly MatchResult['reason'][];
export const AMAZON_EXCLUDED_REASONS = ['pending', 'refund', 'not-itemizable', 'other-currency',
  'nonpositive', 'other-kind', 'other-status'] as const;
/** Why a credit linked to its order stays whole: closed, every value listed with its count. */
export const AMAZON_REFUND_WHOLE_REASONS = ['refund-unattributed', 'inconsistent-evidence', 'currency-mismatch',
  'user-category', 'category-unreviewed'] as const;
/**
 * The KPI period's live posted USD Amazon credits with an itemizable descriptor (refundCredits.ts): linked by a ledger
 * `Refunded` row, linked by an exact-cents order proof (each proof counted, so a credit with two counts twice),
 * held by reason (`no-candidate` included: nothing explains it), and of the linked ones how many are filed under
 * their items' categories (as `itemizedRows` counts charges) or kept whole, by reason.
 */
export interface AmazonRefundCreditCounts {
  rows: number; ledgerLinked: number; linked: number; itemized: number;
  linkedByProof: ReadonlyArray<{ proof: RefundOrderProof; count: number }>;
  itemAttribution: Readonly<{ unique: number; held: number }>;
  heldByReason: ReadonlyArray<{ reason: RefundHoldReason; count: number }>;
  wholeByReason: ReadonlyArray<{ reason: typeof AMAZON_REFUND_WHOLE_REASONS[number]; count: number }>;
}
export interface AmazonMatchCounts {
  linked: number; held: number;
  itemizedRows: number; itemParts: number;
  cohortRows: number; notItemizableRows: number; itemizableRows: number; nonUsdRows: number;
  asOf: string; from: string;
  amazonRows: number;
  excludedRows: ReadonlyArray<{ reason: typeof AMAZON_EXCLUDED_REASONS[number]; count: number }>;
  ledgerObservationsByReason: ReadonlyArray<{ reason: typeof AMAZON_LEDGER_OBSERVATION_REASONS[number]; count: number }>;
  heldByReason: ReadonlyArray<{ reason: typeof AMAZON_ITEMIZATION_REASONS[number]; count: number }>;
  splitRowsByEvidence: ReadonlyArray<{ evidenceClass: EvidenceClass; count: number }>;
  refundCredits: Readonly<AmazonRefundCreditCounts>;
}
export type OrderMatchView =
  | { state: 'linked'; evidenceClass: EvidenceClass; cardTransactionId: string; cardAccountId: string }
  | { state: 'held'; evidenceClass: EvidenceClass; reason: Exclude<MatchResult['reason'], 'unique'>; candidateCount: number };
export interface AmazonResolver extends CategoryResolver { snapshot(): AmazonSnapshot }
const snapshots = new WeakMap<Database, { stamp: string; value: AmazonSnapshot }>();
/** No migrations or writes on reads. Revalidation prevents stale links after card backfill or identity drift. */
export function createAmazonCategoryResolver(db: Database): AmazonResolver {
  return {
    get version() { return snapshot().version; },
    snapshot,
  };
  function snapshot(): AmazonSnapshot {
    const asOf = new Date().toISOString().slice(0, 10), from = addDays(asOf, -730);
    const cacheable = !db.inTransaction;
    const stamp = `${asOf}:${db.pragma('data_version', { simple: true })}:${db.prepare('SELECT total_changes()').pluck().get()}`;
    const cached = snapshots.get(db);
    if (cacheable && cached?.stamp === stamp) return cached.value;
    // Thumbnail availability is read in the same transaction but is not evidence: it stays out of `version`.
    let images: AmazonCachedImages = { asins: new Set(), imageIds: new Set() };
    // Amazon Fresh split policy (freshSplit.ts): the Fresh orders whose proven, reconciled Item List may split a charge. Read in
    // the same transaction; they enter `version` only through a split that used them (below).
    let freshOrders = new Map<string, FreshSplitOrder>();
    const state = db.transaction(() => {
      if (!hasAmazonSchema(db)) return null;
      images = cachedImages(db);
      const rows = readLedger(db), observed = readSubjects(db);
      const bindings = activeBindings(db, readCardInventory(db));
      const matches = matchAmazon(observed, rows, bindings);
      const subjects = allocateLedgerSubjects(db, observed, matches.results);
      const mappings = db.prepare('SELECT source_category,category FROM amazon_category_mappings WHERE reviewed=1').all() as
        Array<{ source_category: string; category: string }>;
      const overrides = db.prepare('SELECT item_ref,category FROM amazon_item_overrides').all() as Array<{ item_ref: string; category: string }>;
      const categories = effectiveCategories(db);
      const coverage = db.prepare('SELECT digest,coverage_json FROM amazon_captures ORDER BY digest').all();
      const items = db.prepare(`SELECT i.ref,i.order_ref,i.data_json FROM amazon_items i JOIN amazon_orders o ON o.ref=i.order_ref
        WHERE i.native_line_id LIKE o.latest_digest || ':%'
          OR i.ref IN (SELECT value FROM json_each(?)) ORDER BY i.ref`)
        .all(JSON.stringify(subjects.flatMap(s => s.allocations.map(a => a.itemRef)))) as
        Array<{ ref: string; order_ref: string; data_json: string }>;
      const hasAgents = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amazon_agent_categories'").get();
      const agents = hasAgents ? db.prepare('SELECT product_key,category,confidence,source,rationale FROM amazon_agent_categories ORDER BY product_key').all() as
        Array<{ product_key: string; category: string; confidence: number; source: string; rationale: string }> : [];
      const refunds = readRefundEvidence(db, bindings);
      freshOrders = readFreshSplitOrders(db);
      return { rows, subjects, bindings, matches, mappings, overrides, categories, coverage, items, agents, refunds };
    })();
    const allRows = state?.rows ?? db.transaction(() => readLedger(db))();
    // A Map does not serialize: the stated destinations and charge observations enter the version as ordered entries.
    const facts = state && { ...state, refunds: { ...state.refunds, statedDestinations: [...state.refunds.statedDestinations],
      chargeSnapshots: [...state.refunds.chargeSnapshots],
      lineTies: [...state.refunds.lineTies].map(([orderRef, ties]) => [orderRef, [...ties]]) } }; // STEP 9 integration (B5)
    const resolutions = new Map<string, Resolution>();
    /** Linked card rows: how each was tied to its order(s), and the item allocation it rests on. */
    const linked = new Map<string, { evidenceClass: EvidenceClass; orderRefs: readonly string[]; allocationComplete: boolean;
      allocations: ReadonlyArray<{ itemRef: string }>; fresh?: FreshSplitOrder }>();
    const held = new Map<string, number>();
    const heldReasons = new Map<string, 'ambiguous' | 'multiple-orders'>();
    const orderMatches = new Map<string, OrderMatchView[]>();
    const rowsById = new Map(allRows.map(r => [r.id, r]));
    const subjectsByRef = new Map(state?.subjects.map(s => [s.ref, s]));
    const resultsByRef = new Map(state?.matches.results.map(r => [r.subjectRef, r]));
    /** In-scope credits' decisions (refundCredits.ts); ledger `Refunded` links are the matcher's, and final. */
    let refundDecisions = new Map<string, RefundDecision>();
    let ledgerRefundLinks = new Map<string, { orderRef: string; evidenceClass: EvidenceClass }>();
    if (state) {
      const mappings = new Map(state.mappings.map(m => [m.source_category, m.category]));
      const overrides = new Map(state.overrides.map(o => [o.item_ref, o.category]));
      const agentProducts = new Map(state.agents.filter(a => a.source === 'agent' && a.rationale === 'categorized from product title'
        && Number.isFinite(a.confidence) && a.confidence >= 0 && a.confidence <= 1).map(a => [a.product_key, a.category]));
      const classificationHeld = new Set<string>();
      const agents = new Map(state.items.flatMap(i => {
        const item = JSON.parse(i.data_json) as { itemId: string | null; title: string };
        if (publicTitle(item.title) !== item.title) {
          classificationHeld.add(i.ref);
          return [];
        }
        const category = agentProducts.get(productKey({ asin: item.itemId, title: item.title }));
        return category === undefined ? [] : [[i.ref, category] as const];
      }));
      const categories = new Set(state.categories);
      const charges = new Map<string, RefundCharge[]>(), ledgerRefundRows = new Map<string, MatchSubject>();
      for (const result of state.matches.results) {
        if (result.corroboratedBy) continue;
        const subject = subjectsByRef.get(result.subjectRef)!;
        // A tipped order's split part that says nothing of its charge (tipSplit.ts) is left out, as an alias is.
        if (inertSplitResult(subject, result)) continue;
        let detail: OrderMatchView;
        if (result.state === 'linked' && result.cardTransactionId) {
          const row = rowsById.get(result.cardTransactionId)!;
          // A ledger refund's credit is resolved below, once every charge it could reverse is.
          if (ledgerRefund(subject)) ledgerRefundRows.set(row.id, subject);
          else {
            const own = resolveSubject(row, subject, categories, mappings, overrides, agents, classificationHeld);
            // Amazon Fresh split policy: a charge of a Fresh order its own items can't explain, split by the Item List.
            const fresh = freshSplit(row, subject, own, freshOrders, categories);
            const resolution = fresh ?? own;
            linked.set(row.id, { evidenceClass: subject.evidenceClass, orderRefs: subject.orderRefs,
              allocationComplete: subject.allocationComplete, allocations: subject.allocations,
              ...(fresh ? { fresh: freshOrders.get(subject.orderRefs[0]) } : {}) });
            resolutions.set(row.id, resolution);
            // Refund credits mirror their order's charges as before (refundCredits.ts): never by a Fresh split.
            if (subject.money.amountMinor > 0) for (const orderRef of new Set(subject.orderRefs)) {
              charges.set(orderRef, [...(charges.get(orderRef) ?? []), { id: row.id, amountMinor: row.amountMinor, currency: row.currency,
                itemized: own.kind === 'split' && !row.userCategory?.trim(), allocations: subject.allocations }]);
            }
          }
          detail = { state: 'linked', evidenceClass: result.evidenceClass, cardTransactionId: row.id, cardAccountId: row.cardAccountId };
        } else {
          if (result.reason === 'unique') throw Error('amazon match state refused');
          detail = { state: 'held', evidenceClass: result.evidenceClass, reason: result.reason, candidateCount: result.candidateCount };
        }
        for (const orderRef of new Set(subject.orderRefs)) {
          const entries = orderMatches.get(orderRef) ?? [];
          entries.push(detail);
          orderMatches.set(orderRef, entries);
        }
      }
      for (const c of state.matches.candidates) if (!linked.has(c.cardTransactionId) && !ledgerRefundRows.has(c.cardTransactionId)) {
        held.set(c.cardTransactionId, (held.get(c.cardTransactionId) ?? 0) + 1);
        resolutions.set(c.cardTransactionId, { kind: 'whole-row', cardTransactionId: c.cardTransactionId, reason: 'match-held' });
        const result = resultsByRef.get(c.subjectRef);
        if (result?.reason === 'multiple-orders') heldReasons.set(c.cardTransactionId, 'multiple-orders');
        else if (!heldReasons.has(c.cardTransactionId)) heldReasons.set(c.cardTransactionId, 'ambiguous');
      }
      const inputs = refundCreditInputs(state.refunds, allRows, state.subjects, state.matches.results);
      ledgerRefundLinks = inputs.ledgerLinks;
      refundDecisions = decideRefundCredits(inputs);
      const creditOrders = new Map<string, Array<{ id: string; evidenceClass: EvidenceClass }>>();
      const linkCredit = (id: string, orderRef: string, evidenceClass: EvidenceClass) => {
        held.delete(id);
        creditOrders.set(orderRef, [...(creditOrders.get(orderRef) ?? []), { id, evidenceClass }]);
      };
      for (const [id, link] of ledgerRefundLinks) linkCredit(id, link.orderRef, link.evidenceClass);
      // A matcher-linked refund naming several orders stays linked, but no single order's items can explain it.
      for (const [id, subject] of ledgerRefundRows) if (!ledgerRefundLinks.has(id)) {
        linked.set(id, { evidenceClass: subject.evidenceClass, orderRefs: subject.orderRefs, allocationComplete: false, allocations: [] });
        resolutions.set(id, { kind: 'whole-row', cardTransactionId: id, reason: 'refund-unattributed' });
      }
      for (const [id, decision] of refundDecisions) {
        if (decision.outcome === 'linked') {
          linkCredit(id, decision.orderRef, 'unique-total-match');
          // A ledger link is already among the order's matches (the matcher's own result); a proof link joins them.
          orderMatches.set(decision.orderRef, [...(orderMatches.get(decision.orderRef) ?? []), { state: 'linked',
            evidenceClass: 'unique-total-match', cardTransactionId: id, cardAccountId: rowsById.get(id)!.cardAccountId }]);
        } else if (decision.outcome === 'held' && decision.reason !== 'no-candidate' && !held.has(id)) {
          held.set(id, decision.candidates);
          resolutions.set(id, { kind: 'whole-row', cardTransactionId: id, reason: 'match-held' });
        }
      }
      const totals = new Map(state.refunds.orders.map(o => [o.ref, o.total]));
      for (const [orderRef, linkedCredits] of creditOrders) {
        const rows = linkedCredits.map(c => rowsById.get(c.id)!);
        const plans = itemizeRefundCredits(rows, charges.get(orderRef) ?? [], totals.get(orderRef) ?? null,
          state.refunds.chargeSnapshots.get(orderRef) ?? [], state.refunds.lineTies.get(orderRef)); // STEP 9 integration (B5)
        for (const { id, evidenceClass } of linkedCredits) {
          const plan = plans.get(id)!;
          linked.set(id, { evidenceClass, orderRefs: [orderRef], allocationComplete: plan.kind !== 'whole',
            allocations: plan.kind === 'whole' ? [] : plan.parts });
          resolutions.set(id, plan.kind === 'whole' ? { kind: 'whole-row', cardTransactionId: id, reason: plan.reason }
            : resolveRefundCredit(rowsById.get(id)!, evidenceClass, plan.parts, categories, mappings, overrides, agents, classificationHeld));
        }
      }
    }
    // The Fresh split policy and every Item List a split used enter the version only when a split was made: an answer no split
    // touched stays byte for byte as it was before the policy.
    const freshUsed = [...new Map([...linked.values()].flatMap(link => link.fresh ? [[link.fresh.ref, link.fresh] as const] : []))]
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, order]) => order);
    const version = `amazon-v1-${digest([POLICY_DIGEST, LEDGER_POLICY_DIGEST, ORDER_HISTORY_POLICY_DIGEST, REFUND_CREDIT_POLICY_DIGEST,
      asOf, facts ?? allRows, ...(freshUsed.length ? [FRESH_SPLIT_POLICY_DIGEST, freshUsed] : [])]).slice(0, 24)}`;
    const chargeKind = (id: string) => {
      const row = rowsById.get(id);
      return row && row.status === 'posted' && row.kind === 'purchase' && row.amountMinor > 0
        ? amazonCardChargeKind({ description: row.description ?? '' }) : null;
    };
    /** The item parts a row is filed under: an accepted split's non-residual parts, unless the owner categorized the row. */
    const itemizedParts = (row: LedgerRow, resolution = resolutions.get(row.id)): Contribution[] =>
      !row.userCategory?.trim() && resolution?.kind === 'split'
        ? resolution.contributions.filter(p => p.classification !== 'residual') : [];
    const reasonCounts = new Map<string, number>();
    const evidenceCounts = new Map<EvidenceClass, number>();
    const excluded = new Map<string, number>();
    const refundHeld = new Map<string, number>(), refundWhole = new Map<string, number>(), refundProofs = new Map<string, number>();
    const refunds = { rows: 0, ledgerLinked: 0, linked: 0, itemized: 0, unique: 0, attributionHeld: 0 };
    let itemizedRows = 0, itemParts = 0, cohortRows = 0, notItemizableRows = 0, nonUsdRows = 0, amazonRows = 0;
    for (const row of allRows) {
      const kind = amazonCardChargeKind({ description: row.description ?? '' });
      if (!kind || row.transactionDate < from || row.transactionDate > asOf) continue;
      amazonRows++;
      const exclusion = row.currency !== 'USD' ? 'other-currency' : row.kind === 'refund' ? 'refund'
        : row.kind !== 'purchase' ? 'other-kind' : row.status === 'pending' ? 'pending'
          : row.status !== 'posted' ? 'other-status' : row.amountMinor <= 0 ? 'nonpositive'
            : kind === 'not-itemizable' ? 'not-itemizable' : null;
      if (exclusion) excluded.set(exclusion, (excluded.get(exclusion) ?? 0) + 1);
      if (row.currency !== 'USD') { nonUsdRows++; continue; }
      const decision = refundDecisions.get(row.id);
      if (decision && decision.outcome !== 'out-of-scope') {
        refunds.rows++;
        if (decision.outcome === 'held') refundHeld.set(decision.reason, (refundHeld.get(decision.reason) ?? 0) + 1);
        else {
          // Every credit the matcher already links is a final ledger refund (one order or several).
          if (decision.outcome === 'already-linked') refunds.ledgerLinked++;
          else {
            refunds.linked++;
            for (const proof of decision.proof.split('+')) refundProofs.set(proof, (refundProofs.get(proof) ?? 0) + 1);
            if (decision.itemAttribution === 'unique') refunds.unique++;
            else refunds.attributionHeld++;
          }
          const resolution = resolutions.get(row.id);
          if (itemizedParts(row, resolution).length > 0) refunds.itemized++;
          else if (linked.has(row.id)) {
            const reason = row.userCategory?.trim() ? 'user-category' : resolution?.kind === 'whole-row' ? resolution.reason : 'category-unreviewed';
            refundWhole.set(reason, (refundWhole.get(reason) ?? 0) + 1);
          }
        }
      }
      if (row.kind !== 'purchase' || row.status !== 'posted' || row.amountMinor <= 0) continue;
      cohortRows++;
      if (kind === 'not-itemizable') { notItemizableRows++; continue; }
      const resolution = resolutions.get(row.id);
      const parts = itemizedParts(row, resolution);
      if (resolution?.kind === 'split' && parts.length > 0) {
        itemizedRows++; itemParts += parts.length;
        evidenceCounts.set(resolution.evidenceClass, (evidenceCounts.get(resolution.evidenceClass) ?? 0) + 1);
      } else {
        const reason = row.userCategory?.trim() ? 'user-category'
          : resolution?.kind === 'whole-row' ? heldReasons.get(row.id) ?? resolution.reason
            : resolution?.kind === 'split' ? 'category-unreviewed' : 'no-evidence';
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }
    const counts: AmazonMatchCounts = {
      linked: state?.matches.results.filter(r => r.state === 'linked').length ?? 0,
      held: state?.matches.results.filter(r => r.state === 'held' && !r.corroboratedBy
        && !inertSplitResult(subjectsByRef.get(r.subjectRef), r)).length ?? 0,
      itemizedRows, itemParts, cohortRows, notItemizableRows, itemizableRows: cohortRows - notItemizableRows, nonUsdRows, asOf, from,
      amazonRows,
      excludedRows: Object.freeze(AMAZON_EXCLUDED_REASONS.map(reason => Object.freeze({ reason, count: excluded.get(reason) ?? 0 }))),
      ledgerObservationsByReason: Object.freeze(AMAZON_LEDGER_OBSERVATION_REASONS.map(reason => Object.freeze({ reason,
        count: state?.matches.results.filter(r => r.evidenceClass === 'payment-ledger-complete' && r.reason === reason).length ?? 0 }))),
      heldByReason: Object.freeze(AMAZON_ITEMIZATION_REASONS.map(reason => Object.freeze({ reason, count: reasonCounts.get(reason) ?? 0 }))),
      splitRowsByEvidence: Object.freeze(CARD_CATEGORY_EVIDENCE_CLASSES
        .map(evidenceClass => Object.freeze({ evidenceClass, count: evidenceCounts.get(evidenceClass) ?? 0 }))),
      refundCredits: Object.freeze({
        rows: refunds.rows, ledgerLinked: refunds.ledgerLinked, linked: refunds.linked, itemized: refunds.itemized,
        linkedByProof: Object.freeze(REFUND_ORDER_PROOFS.map(proof => Object.freeze({ proof, count: refundProofs.get(proof) ?? 0 }))),
        itemAttribution: Object.freeze({ unique: refunds.unique, held: refunds.attributionHeld }),
        heldByReason: Object.freeze(REFUND_HOLD_REASONS.map(reason => Object.freeze({ reason, count: refundHeld.get(reason) ?? 0 }))),
        wholeByReason: Object.freeze(AMAZON_REFUND_WHOLE_REASONS.map(reason => Object.freeze({ reason, count: refundWhole.get(reason) ?? 0 }))),
      }),
    };
    const value: AmazonSnapshot = {
      version,
      matchCounts: Object.freeze(counts),
      isAmazonCharge(id) { return chargeKind(id) === 'itemizable'; },
      linkedChargeItemization(id) {
        const row = rowsById.get(id);
        if (!row || !linked.has(id) || row.status !== 'posted' || row.kind !== 'purchase' || !(row.amountMinor > 0)) return null;
        return itemizedParts(row).length > 0 ? 'itemized' : 'whole';
      },
      resolve(rows) {
        const answer = new Map<string, Resolution>();
        for (const row of rows) {
          const original = rowsById.get(row.id);
          const resolution = resolutions.get(row.id);
          if (!resolution) continue;
          if (!original || original.currency !== row.currency || original.amountMinor !== row.amountMinor) {
            answer.set(row.id, { kind: 'whole-row', cardTransactionId: row.id, reason: 'inconsistent-evidence' });
          } else answer.set(row.id, structuredClone(resolution));
        }
        return answer;
      },
      getOrderMatches(orderRef) {
        return (orderMatches.get(orderRef) ?? []).map(result => ({ ...result }));
      },
      getCardDetail(id) {
        const base = { version, coverage: { complete: false } };
        const link = linked.get(id);
        if (!link) return held.has(id) ? { ...base, match: 'held', hold: { reason: 'match-held', candidateCount: held.get(id)! } }
          : { ...base, match: 'none' };
        const resolution = resolutions.get(id);
        const row = rowsById.get(id)!;
        const effective = row.effectiveCategory ?? 'Uncategorized';
        // Only snapshot facts go into the public response; a read never promotes held candidates. A Fresh split's items are
        // its Item List's delivered, priced lines (freshSplit.ts), each title behind the card-data guard.
        return { ...base, match: 'linked', evidenceClass: link.evidenceClass, orderRefs: [...link.orderRefs],
          items: link.fresh ? link.fresh.lines.map(line => ({ itemRef: line.ref, title: publicTitle(line.title), quantity: line.quantity,
            asin: line.asin, ...(hasCachedImage(images, { itemId: line.asin }) ? { image: true as const } : {}) }))
            : state!.items.filter(i => link.orderRefs.includes(i.order_ref)
            && (!link.allocationComplete || link.allocations.some(a => a.itemRef === i.ref))).map(i => {
            const item = JSON.parse(i.data_json) as { title: string; quantity: number | null; itemId: string | null; imageId?: string };
            return { itemRef: i.ref, title: publicTitle(item.title), quantity: item.quantity, asin: item.itemId,
              ...(hasCachedImage(images, item) ? { image: true as const } : {}) };
          }),
          ...(resolution?.kind === 'split' ? { parts: resolution.contributions.map(p => ({
            ...p, category: p.category ?? effective, categorySource: p.categorySource ?? 'original-effective' as const,
          })) } : {}) };
      },
    };
    const frozen = Object.freeze(value);
    if (cacheable) snapshots.set(db, { stamp, value: frozen });
    return frozen;
  }
}
