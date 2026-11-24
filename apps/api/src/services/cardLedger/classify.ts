import { cardMerchantKey } from '@finance-tracker/shared';

import type { BankValues, LedgerOverlay, LedgerRow, StoredIdentity, Tuple } from './ledgerView.js';

/**
 * The plan §7.4 state machine for one observation against the ledger as the
 * plan leaves it (E1b design §4.3–§4.4): pure, it reads only the overlay it
 * is given and writes nothing. The planner (simulate.ts) turns its answer
 * into an action, applying the owner's decision when the answer is review.
 */

/** The owner's decisions and their bits in `allowed_actions` (§2.14). */
export const REVIEW_ACTION_BITS = Object.freeze({
  'same-transaction': 1, 'attribute-and-link': 2, attribute: 4, 'insert-new': 8, 'accept-correction': 16, 'keep-current': 32,
  'accept-difference': 64, 'reject-row': 128,
} as const);
export type ReviewDecisionAction = keyof typeof REVIEW_ACTION_BITS;
export const REVIEW_DECISION_ACTIONS = Object.freeze(Object.keys(REVIEW_ACTION_BITS) as ReviewDecisionAction[]);

export type ReviewReason = 'cross-source-similar' | 'identity-conflict' | 'detached-identity' | 'no-stable-id' | 'unknown-scope'
  | 'pending-posted' | 'pending-may-have-posted' | 'removed-hit' | 'posted-correction' | 'pending-changed' | 'statement-mismatch';
export type ReviewCategory = 'cross-source-similar' | 'no-stable-id' | 'scope-unknown' | 'pending-link' | 'posted-correction'
  | 'reconciliation-difference';

/** Every action a category may offer (`ck_rvw_actions_in_category`); the classifier narrows it per item. */
export const CATEGORY_ACTIONS: Readonly<Record<ReviewCategory, number>> = Object.freeze({
  'cross-source-similar': 139, 'no-stable-id': 137, 'scope-unknown': 141, 'pending-link': 137, 'posted-correction': 48,
  'reconciliation-difference': 64,
});

export type ContentResolution = 'inserted' | 'promoted' | 'corrected' | 'linked' | 'matched-current' | 'kept-current';
export type CandidateRule = 'identity:v1' | 'near-content:v1' | 'exact-content:v1';

/** `matched_on` bits (owner API `matchedOn`). */
export const MATCHED_ON = Object.freeze({ date: 1, amount: 2, merchant: 4, description: 8, postedId: 16 });

/** Per-namespace automatic admission as the classifier reads it; CARD_SYNC_ADMISSIONS keeps every gate closed (Q5). */
export type Admissions = Readonly<Record<string, { readonly autoInsert: boolean; readonly lifecycle: boolean } | undefined>>;

/** One observation as the planner sees it: its tuples (primary first), values and content digest. */
export interface PlanObservation {
  ordinal: number;
  id: string;
  /** Its review item, when it has one. */
  itemId: string | null;
  origin: 'extension' | 'file';
  scopeId: string;
  scopeKind: 'known' | 'unknown' | 'legacy';
  /** The primary tuple, then each secondary id (§4.2). */
  tuples: readonly Tuple[];
  values: BankValues;
  content: string;
}

export interface PlanCandidate {
  transactionId: string;
  rule: CandidateRule;
  matchedOn: number;
  blocked: 'different-known-cards' | null;
  scopeId: string;
  scopeKind: 'known' | 'unknown' | 'legacy';
  status: 'pending' | 'posted' | 'removed';
}

export interface ReviewClassification {
  kind: 'review';
  reason: ReviewReason;
  category: ReviewCategory;
  allowed: number;
  candidates: PlanCandidate[];
  /** The row the observation's ids resolve to (identity hits), or null. */
  row: LedgerRow | null;
  hits: StoredIdentity[];
  detached: StoredIdentity[];
  /** Tuples with no identity yet. */
  fresh: Tuple[];
}

export type Classification =
  | { kind: 'unchanged'; row: LedgerRow; resolution: ContentResolution | null; hits: StoredIdentity[]; fresh: Tuple[] }
  | { kind: 'promote'; row: LedgerRow; hits: StoredIdentity[]; fresh: Tuple[] }
  | { kind: 'insert'; fresh: Tuple[]; detached: StoredIdentity[] }
  | ReviewClassification;

export interface ClassifyContext {
  overlay: LedgerOverlay;
  admissions: Admissions;
  /** Rows another observation of the same set reaches by identity: never this one's candidates (§4.4). */
  excluded: { has(rowId: string): boolean };
  /** The binding's active known scopes, the targets of `attribute` and of `attribute-and-link` for an unknown-scope row. */
  knownScopes: ReadonlySet<string>;
}

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00.000Z`) / DAY_MS;
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS)
  .toISOString().slice(0, 10);

const text = (value: string) => value.normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();

/** Equal in every normalized bank field, status included (the `rcd1:` content's fields). */
export function sameValues(row: BankValues | LedgerRow, values: BankValues): boolean {
  return row.status === values.status && row.transactionDate === values.transactionDate && row.postedDate === values.postedDate
    && row.amountMinor === values.amountMinor && row.originalAmountMinor === values.originalAmountMinor
    && row.originalCurrency === values.originalCurrency && row.kind === values.kind && row.description === values.description
    && row.merchant === values.merchant && row.issuerCategory === values.issuerCategory;
}

/** A material difference (§4.4): amount, dates, kind or the original amount; `notify` on the event. */
type MaterialFields = Pick<BankValues, 'amountMinor' | 'transactionDate' | 'postedDate' | 'kind' | 'originalAmountMinor'
  | 'originalCurrency'>;

export function materialChange(before: MaterialFields, after: MaterialFields): boolean {
  return before.amountMinor !== after.amountMinor || before.transactionDate !== after.transactionDate
    || (after.postedDate !== null && before.postedDate !== after.postedDate) || before.kind !== after.kind
    || before.originalAmountMinor !== after.originalAmountMinor || before.originalCurrency !== after.originalCurrency;
}

const admitted = (admissions: Admissions, namespace: string, gate: 'autoInsert' | 'lifecycle') =>
  admissions[namespace]?.[gate] === true;

/** Whether a device may commit this classification's action (§4.4's last column; W7). */
export function deviceCommittable(classification: Classification, observation: PlanObservation, admissions: Admissions): boolean {
  switch (classification.kind) {
    case 'unchanged': return classification.fresh.every((tuple) => admitted(admissions, tuple.namespace, 'autoInsert'));
    case 'promote': return observation.tuples.every((tuple) => admitted(admissions, tuple.namespace, 'lifecycle'))
      && classification.fresh.every((tuple) => admitted(admissions, tuple.namespace, 'autoInsert'));
    case 'insert': return observation.tuples.every((tuple) => admitted(admissions, tuple.namespace, 'autoInsert'));
    default: return false;
  }
}

function review(reason: ReviewReason, category: ReviewCategory, allowed: number, fields: Partial<ReviewClassification>):
  ReviewClassification {
  return {
    kind: 'review', reason, category, allowed: allowed & CATEGORY_ACTIONS[category], candidates: fields.candidates ?? [],
    row: fields.row ?? null, hits: fields.hits ?? [], detached: fields.detached ?? [], fresh: fields.fresh ?? [],
  };
}

export const identityCandidate = (row: LedgerRow, observation: PlanObservation): PlanCandidate => ({
  transactionId: row.id, rule: 'identity:v1', blocked: null, scopeId: row.cardScopeId, scopeKind: row.scopeKind, status: row.status,
  matchedOn: MATCHED_ON.postedId | (row.amountMinor === observation.values.amountMinor ? MATCHED_ON.amount : 0)
    | (row.transactionDate === observation.values.transactionDate ? MATCHED_ON.date : 0),
});

/**
 * `near-content:v1` (§4.4): live rows of the account and currency with the
 * same amount and a close date, ranked by merchant, description and date
 * distance (row id last, so the order is total), at most five. Rows another
 * observation of the set reaches by identity and rows established as
 * distinct are excluded; a row on a different known card stays visible but
 * blocked. A v1 row (a file observation) takes only rows with sync provenance
 * (synced by a browser, or carrying a browser's identity:
 * LedgerView.syncProvenance); among the others Phase 4's exact-content rule
 * decides (§4.4).
 *
 * A candidate-heavy pool (many rows of one amount) is never scanned whole
 * (slice 2 review r1, finding 8): the amount's stored rows are indexed once
 * per view (`nearIndex`), and the ranking's four tiers (merchant and
 * description, merchant only, description only, neither) are walked in rank
 * order, each outward from the observation's date, until five rows qualify.
 * When the plan has already changed a stored row of this amount, its pool is
 * scanned row by row through the overlay instead (`nearContentCandidatesByScan`,
 * the reference both ways must equal).
 *
 * `eligible`, when given, narrows the rows considered before they are ranked:
 * the five are the best rows it accepts, never the best five filtered after
 * the cut (E2d review r2, finding 1: five pending rows ranked above a posted
 * rival hid it from a search for posted rivals).
 */
export function nearContentCandidates(observation: PlanObservation, ctx: ClassifyContext, eligible?: (row: LedgerRow) => boolean):
  PlanCandidate[] {
  const values = observation.values;
  if (ctx.overlay.changedAmount(values.amountMinor)) return nearContentCandidatesByScan(observation, ctx, eligible);
  const index = nearIndex(ctx.overlay.amountPool(values.amountMinor));
  const day = dayNumber(values.transactionDate);
  const merchant = values.merchant === null ? null : cardMerchantKey(values.merchant);
  const description = text(values.description);
  const primary = observation.tuples[0];
  const fromFile = observation.origin === 'file';
  const best: RankedCandidate[] = [];
  const qualifies = (entry: NearEntry, merchantMatch: boolean, descriptionMatch: boolean): boolean => {
    const { row } = entry;
    const distance = day - entry.day;
    if (ctx.excluded.has(row.id) || row.status === 'removed' || (eligible !== undefined && !eligible(row))
      || !inNearWindow(row.status, values.status, distance) || (fromFile && !ctx.overlay.syncProvenance(row))
      || establishedDistinct(row, observation, primary, ctx)) {
      return false;
    }
    best.push({ row, merchantMatch, descriptionMatch, distance });
    return best.length === 5;
  };
  const matchesMerchant = (entry: NearEntry) => merchant !== null && entry.merchant === merchant;
  const ofMerchant = merchant === null ? undefined : index.byMerchant.get(merchant);
  // The tiers in rank order: merchant and description, merchant only, description only, neither.
  const tiers: Array<[NearGroup | undefined, (entry: NearEntry) => boolean]> = [
    [ofMerchant?.byDescription.get(description), (entry) => qualifies(entry, true, true)],
    [ofMerchant?.all, (entry) => entry.description !== description && qualifies(entry, true, false)],
    [index.byDescription.get(description), (entry) => !matchesMerchant(entry) && qualifies(entry, false, true)],
    [index.all, (entry) => !matchesMerchant(entry) && entry.description !== description && qualifies(entry, false, false)],
  ];
  for (const [group, visit] of tiers) {
    if (group !== undefined && visitNearest(group, day, visit)) break;
  }
  return best.map((entry) => nearCandidate(entry, observation));
}

/** `nearContentCandidates` by scanning the pool through the overlay: the plan's changed rows as it leaves them. */
export function nearContentCandidatesByScan(observation: PlanObservation, ctx: ClassifyContext, eligible?: (row: LedgerRow) => boolean):
  PlanCandidate[] {
  const values = observation.values;
  const day = dayNumber(values.transactionDate);
  const primary = observation.tuples[0];
  const pool = ctx.overlay.rowsNear(values.amountMinor, addDays(values.transactionDate, -NEAR_DAYS),
    addDays(values.transactionDate, NEAR_DAYS));
  const merchant = values.merchant === null ? null : cardMerchantKey(values.merchant);
  const description = text(values.description);
  // The five best kept in rank order while the pool is scanned (never sorted whole); the costly distinctness check
  // only for a row that would enter them. Same ranking and tie-break (row id) as a full sort, so the same five.
  const best: RankedCandidate[] = [];
  for (const row of pool) {
    if (ctx.excluded.has(row.id) || row.status === 'removed' || (eligible !== undefined && !eligible(row))) continue;
    const keys = keysOf(row);
    const distance = day - keys.day;
    if (!inNearWindow(row.status, values.status, distance) || (observation.origin === 'file' && !ctx.overlay.syncProvenance(row))) continue;
    const merchantMatch = merchant !== null && keys.merchant !== null && keys.merchant === merchant;
    const descriptionMatch = keys.description === description;
    const entry: RankedCandidate = { row, merchantMatch, descriptionMatch, distance };
    if (best.length === 5 && compareRanked(entry, best[4]) >= 0) continue;
    if (establishedDistinct(row, observation, primary, ctx)) continue;
    let at = best.length;
    while (at > 0 && compareRanked(entry, best[at - 1]) < 0) at -= 1;
    best.splice(at, 0, entry);
    if (best.length > 5) best.pop();
  }
  return best.map((entry) => nearCandidate(entry, observation));
}

/** How many days apart a near-content candidate may be, at most (the widest of `inNearWindow`'s windows). */
const NEAR_DAYS = 10;

/** §4.4's date windows: ±3 days at the same status; a pending row 2 days after to 10 before; a posted row 10 after to 2 before. */
function inNearWindow(rowStatus: LedgerRow['status'], status: BankValues['status'], distance: number): boolean {
  return rowStatus === status ? Math.abs(distance) <= 3
    : rowStatus === 'pending' ? distance >= -2 && distance <= 10 : distance >= -10 && distance <= 2;
}

function nearCandidate({ row, merchantMatch, descriptionMatch, distance }: RankedCandidate, observation: PlanObservation): PlanCandidate {
  return {
    transactionId: row.id, rule: 'near-content:v1', scopeId: row.cardScopeId, scopeKind: row.scopeKind, status: row.status,
    blocked: observation.scopeKind === 'known' && row.scopeKind === 'known' && row.cardScopeId !== observation.scopeId
      ? 'different-known-cards' : null,
    matchedOn: MATCHED_ON.amount | (distance === 0 ? MATCHED_ON.date : 0) | (merchantMatch ? MATCHED_ON.merchant : 0)
      | (descriptionMatch ? MATCHED_ON.description : 0),
  };
}

interface RankedCandidate {
  row: LedgerRow;
  merchantMatch: boolean;
  descriptionMatch: boolean;
  distance: number;
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** §4.4's ranking: merchant, then description, then date distance, then row id (a total order). */
function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  return (a.merchantMatch ? 0 : 1) - (b.merchantMatch ? 0 : 1) || (a.descriptionMatch ? 0 : 1) - (b.descriptionMatch ? 0 : 1)
    || Math.abs(a.distance) - Math.abs(b.distance) || compareIds(a.row.id, b.row.id);
}

/** A pool row's normalized keys, computed once per row object (the view's rows are shared and never mutated). */
const rowKeys = new WeakMap<LedgerRow, { day: number; merchant: string | null; description: string }>();
function keysOf(row: LedgerRow): { day: number; merchant: string | null; description: string } {
  let keys = rowKeys.get(row);
  if (!keys) {
    keys = { day: dayNumber(row.transactionDate), merchant: row.merchant === null ? null : cardMerchantKey(row.merchant),
      description: text(row.description) };
    rowKeys.set(row, keys);
  }
  return keys;
}

/** A stored row with the keys near-content ranks by. */
interface NearEntry {
  row: LedgerRow;
  day: number;
  merchant: string | null;
  description: string;
}

/** Entries sorted by (day, row id). */
type NearGroup = readonly NearEntry[];

/** One amount's stored rows, grouped by the ranking's keys; every group sorted by (day, row id). */
interface NearIndex {
  all: NearGroup;
  byDescription: ReadonlyMap<string, NearGroup>;
  byMerchant: ReadonlyMap<string, { all: NearGroup; byDescription: ReadonlyMap<string, NearGroup> }>;
}

/** Built once per pool, i.e. once per view and amount (the view's pools are never mutated). */
const nearIndexes = new WeakMap<readonly LedgerRow[], NearIndex>();
function nearIndex(pool: readonly LedgerRow[]): NearIndex {
  const cached = nearIndexes.get(pool);
  if (cached) return cached;
  const all = pool.map((row): NearEntry => ({ row, ...keysOf(row) })).sort((a, b) => a.day - b.day || compareIds(a.row.id, b.row.id));
  const add = <K>(map: Map<K, NearEntry[]>, key: K, entry: NearEntry) => {
    const group = map.get(key);
    if (group) group.push(entry);
    else map.set(key, [entry]);
  };
  const byDescription = new Map<string, NearEntry[]>();
  const merchants = new Map<string, NearEntry[]>();
  const merchantDescriptions = new Map<string, Map<string, NearEntry[]>>();
  for (const entry of all) {
    add(byDescription, entry.description, entry);
    if (entry.merchant === null) continue;
    add(merchants, entry.merchant, entry);
    let descriptions = merchantDescriptions.get(entry.merchant);
    if (!descriptions) {
      descriptions = new Map();
      merchantDescriptions.set(entry.merchant, descriptions);
    }
    add(descriptions, entry.description, entry);
  }
  const byMerchant = new Map([...merchants].map(([key, group]) => [key, { all: group, byDescription: merchantDescriptions.get(key)! }]));
  const index: NearIndex = { all, byDescription, byMerchant };
  nearIndexes.set(pool, index);
  return index;
}

/**
 * Visits a group's entries within NEAR_DAYS of `day` in rank order (date
 * distance, then row id), stopping as soon as `visit` returns true; whether
 * it stopped.
 */
function visitNearest(group: NearGroup, day: number, visit: (entry: NearEntry) => boolean): boolean {
  let low = 0;
  let high = group.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (group[middle].day < day) low = middle + 1;
    else high = middle;
  }
  let right = low;
  let left = low - 1;
  for (let distance = 0; distance <= NEAR_DAYS; distance += 1) {
    // [leftStart, left] lie `distance` days before, [right, rightEnd) `distance` days after (or on the day): each by id.
    let rightEnd = right;
    while (rightEnd < group.length && group[rightEnd].day === day + distance) rightEnd += 1;
    let leftStart = left + 1;
    if (distance > 0) while (leftStart > 0 && group[leftStart - 1].day === day - distance) leftStart -= 1;
    let l = leftStart;
    let r = right;
    while (l <= left || r < rightEnd) {
      const fromLeft = r >= rightEnd || (l <= left && compareIds(group[l].row.id, group[r].row.id) < 0);
      if (visit(fromLeft ? group[l++] : group[r++])) return true;
    }
    left = leftStart - 1;
    right = rightEnd;
  }
  return false;
}

/**
 * Established distinctness (§4.4, finding 4): the row already has another id
 * of the observation's own stable (scope, namespace), and either both ids were
 * first seen posted or the namespace's ids are proven to survive posting
 * (lifecycle-admitted). Never for capture or legacy namespaces.
 */
function establishedDistinct(row: LedgerRow, observation: PlanObservation, primary: Tuple, ctx: ClassifyContext): boolean {
  if (primary.namespaceKind !== 'stable') return false;
  const lifecycle = admitted(ctx.admissions, primary.namespace, 'lifecycle');
  return ctx.overlay.activeIdentitiesIn(row.id, primary.scopeId, primary.namespace).some((identity) => identity.idHash !== primary.idHash
    && (lifecycle || (identity.firstSeenStatus === 'posted' && observation.values.status === 'posted')));
}

/**
 * Whether a plain `same-transaction` may link the observation to this
 * candidate (§4.4 row 5, design test S10): never across two known cards
 * (blocked), and never a known observation onto an unresolved row (unknown
 * or legacy scope) without attributing that row, which only
 * `attribute-and-link` does.
 */
export function plainlyLinkable(candidate: Pick<PlanCandidate, 'blocked' | 'scopeKind'>, observation: Pick<PlanObservation, 'scopeKind'>):
  boolean {
  return candidate.blocked === null && !(observation.scopeKind === 'known' && candidate.scopeKind !== 'known');
}

/** Whether `attribute-and-link` has a legal (target, scope) pair among the candidates (§4.6's scope rules). */
function attributeAndLinkPossible(candidates: readonly PlanCandidate[], observation: PlanObservation, ctx: ClassifyContext): boolean {
  const scopeAvailable = observation.scopeKind === 'known' || ctx.knownScopes.size > 0;
  return scopeAvailable && candidates.some((candidate) => candidate.blocked === null && candidate.scopeKind !== 'known');
}

/**
 * A v1 row that would post `row` (a pending row, or one dismissed while pending, revived on the owner's word) while a
 * posted row with sync provenance is near its values: that row may be the same purchase, already posted (E2d review r1,
 * finding 2; r2, findings 1 and 2). The owner decides before anything posts: linking to `row` posts it (restoring it
 * when removed: a match that promotes), linking to another row is refused (the file's key belongs to `row`), rejecting
 * leaves `row` as it is. Only posted rows are searched, so pending rows ranked above them never hide one; `row` comes
 * first in the item, then the best four of them.
 */
function filePromotionHold(observation: PlanObservation, ctx: ClassifyContext, row: LedgerRow, hits: StoredIdentity[],
  fresh: Tuple[]): ReviewClassification | null {
  if (observation.origin !== 'file' || observation.values.status !== 'posted') return null;
  const rivals = nearContentCandidates(observation, ctx, (candidate) => candidate.status === 'posted' && candidate.id !== row.id);
  if (rivals.length === 0) return null;
  return review('cross-source-similar', 'cross-source-similar', REVIEW_ACTION_BITS['same-transaction'] | REVIEW_ACTION_BITS['reject-row'],
    { candidates: [identityCandidate(row, observation), ...rivals].slice(0, 5), row, hits, fresh });
}

/** The table of §4.4 for one observation. */
export function classify(observation: PlanObservation, ctx: ClassifyContext): Classification {
  const { overlay, admissions } = ctx;
  const probes = observation.tuples.map((tuple) => ({ tuple, identity: overlay.identity(tuple) }));
  const hits = probes.flatMap((probe) => probe.identity?.status === 'active' ? [probe.identity] : []);
  const detached = probes.flatMap((probe) => probe.identity?.status === 'detached' ? [probe.identity] : []);
  const fresh = probes.flatMap((probe) => probe.identity === undefined ? [probe.tuple] : []);
  const rowIds = [...new Set(hits.map((identity) => identity.canonicalId))];

  if (rowIds.length > 1) {
    // Plan §7.4 row 3: the ids name two canonical rows. Plan-local rows cannot be candidates (they do not exist yet).
    const candidates = rowIds.flatMap((id) => {
      const row = overlay.row(id);
      return row && row.newRef === undefined ? [identityCandidate(row, observation)] : [];
    });
    return review('identity-conflict', 'cross-source-similar', REVIEW_ACTION_BITS['reject-row']
      | (candidates.some((candidate) => plainlyLinkable(candidate, observation)) ? REVIEW_ACTION_BITS['same-transaction'] : 0),
    { candidates, hits, detached, fresh });
  }

  if (rowIds.length === 1) {
    const row = overlay.row(rowIds[0]);
    if (!row) throw new Error('card ledger: an identity names a row the ledger does not hold');
    const onRow = hits;
    // §4.3: content this very tuple's identity already resolved is a replay, whatever the row looks like now.
    if (onRow.some((identity) => overlay.knowsContent(identity.id, observation.content))) {
      return { kind: 'unchanged', row, resolution: null, hits: onRow, fresh: row.status === 'removed' ? [] : fresh };
    }
    if (row.status === 'removed') {
      if (row.removedReason === 'legacy') return { kind: 'unchanged', row, resolution: null, hits: onRow, fresh: [] };
      const fromPending = row.removedFromStatus === 'pending';
      if (observation.values.status === 'posted' && fromPending) {
        // Reviving a row dismissed while pending is no proof it is another purchase than a synced posted row (r2, finding 2).
        const held = filePromotionHold(observation, ctx, row, onRow, fresh);
        if (held) return held;
        return review('removed-hit', 'pending-link', REVIEW_ACTION_BITS['same-transaction'] | REVIEW_ACTION_BITS['reject-row'], {
          candidates: [identityCandidate(row, observation)], row, hits: onRow, fresh,
        });
      }
      // A pending observation never brings back a row removed from posted with its pending values (no downgrade).
      const allowed = observation.values.status === 'pending' && !fromPending ? REVIEW_ACTION_BITS['keep-current']
        : REVIEW_ACTION_BITS['accept-correction'] | REVIEW_ACTION_BITS['keep-current'];
      return review('removed-hit', 'posted-correction', allowed, { candidates: [identityCandidate(row, observation)], row, hits: onRow, fresh });
    }
    if (sameValues(row, observation.values)) return { kind: 'unchanged', row, resolution: 'matched-current', hits: onRow, fresh };
    if (row.status === 'posted') {
      if (observation.values.status === 'pending') return { kind: 'unchanged', row, resolution: 'kept-current', hits: onRow, fresh };
      return review('posted-correction', 'posted-correction', CATEGORY_ACTIONS['posted-correction'], {
        candidates: [identityCandidate(row, observation)], row, hits: onRow, fresh,
      });
    }
    if (observation.values.status === 'posted') {
      const held = filePromotionHold(observation, ctx, row, onRow, fresh);
      if (held) return held;
      if (observation.tuples.every((tuple) => admitted(admissions, tuple.namespace, 'lifecycle'))) {
        return { kind: 'promote', row, hits: onRow, fresh };
      }
      return review('pending-posted', 'pending-link', REVIEW_ACTION_BITS['same-transaction'] | REVIEW_ACTION_BITS['reject-row'], {
        candidates: [identityCandidate(row, observation)], row, hits: onRow, fresh,
      });
    }
    return review('pending-changed', 'posted-correction', CATEGORY_ACTIONS['posted-correction'], {
      candidates: [identityCandidate(row, observation)], row, hits: onRow, fresh,
    });
  }

  const candidates = nearContentCandidates(observation, ctx);
  const linkable = candidates.some((candidate) => plainlyLinkable(candidate, observation));
  const same = linkable ? REVIEW_ACTION_BITS['same-transaction'] : 0;
  const attributeAndLink = attributeAndLinkPossible(candidates, observation, ctx) ? REVIEW_ACTION_BITS['attribute-and-link'] : 0;
  const base = same | REVIEW_ACTION_BITS['insert-new'] | REVIEW_ACTION_BITS['reject-row'];
  const primary = observation.tuples[0];
  if (detached.length > 0) {
    return review('detached-identity', 'cross-source-similar', base | attributeAndLink, { candidates, detached, fresh });
  }
  if (primary.namespaceKind === 'capture') return review('no-stable-id', 'no-stable-id', base, { candidates, fresh });
  // §4.4 row 4 (v1 vs extension): a v1 row goes to its legacy scope as Phase 4 inserts it, unless rows with sync
  // provenance are near it; then it is held for the owner as `cross-source-similar`, whatever the statuses.
  if (observation.origin === 'file') {
    if (candidates.length === 0) return { kind: 'insert', fresh, detached: [] };
    return review('cross-source-similar', 'cross-source-similar', base | attributeAndLink, { candidates, fresh });
  }
  if (observation.scopeKind !== 'known') {
    const attribute = ctx.knownScopes.size > 0 ? REVIEW_ACTION_BITS.attribute : 0;
    return review('unknown-scope', 'scope-unknown', base | attribute, { candidates, fresh });
  }
  if (candidates.length === 0) return { kind: 'insert', fresh, detached: [] };
  if (candidates[0].status === observation.values.status) {
    return review('cross-source-similar', 'cross-source-similar', base | attributeAndLink, { candidates, fresh });
  }
  return review('pending-may-have-posted', 'pending-link', base, { candidates, fresh });
}
