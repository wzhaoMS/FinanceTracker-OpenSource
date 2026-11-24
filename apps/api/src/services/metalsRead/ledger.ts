/**
 * The metals ledger's read core (design v8 §4.2–§4.4.5, §7, G3): from the active ledger and Holdr's card and checking
 * rows, everything that is computed once per data version over the whole ledger, never per view or filter.
 *
 * - Content: each line's fine content per unit by METALS_CONTENT_RULE v1 with the owner's live decisions. A product
 *   decision answers the `single`-pack lines of its ref with its content fingerprint; a lot decision answers its own
 *   line while the order's active version digest is the one it approved; anything else under a decision is held
 *   `confirmation-drift`. A present product ref counts as unique: refs are source catalog ids.
 * - Bindings (§7, D-G2-1): an active binding is suspended when its account is gone, its last 4, status or owner differs
 *   from the binding's approval, or a same-kind account with its last 4 (any network, any status) is not among the
 *   approved peers; a removed peer doesn't suspend. Revoked bindings bind nothing.
 * - Card links (§4.4.4, G1d `metalsCardLinks`): metal orders' admitted evidence against Holdr's posted USD purchase
 *   rows of a precious-metals merchant class; every other captured order's card funding (each distinct fact version)
 *   competes; open held records bar.
 * - Deposit links (§4.4.5, G1d `metalsDepositLinks`): sale payouts against the bound checking account's credits, with
 *   its imported coverage. METALS_PAYOUT_DESCRIPTORS holds CollectPure's payout origin text, the counterparty name, so
 *   only a credit that names it can prove a CollectPure payout's link; any other match is at most a possible deposit.
 * - Held records: a held record stays open until a later import observes its key, as an order or as a competitor (every
 *   import that lists a competitor is recorded, unchanged re-reads included). "Later" is G2's causal import sequence,
 *   never the import id (random) or time (G3-C1).
 * - Held for metals (contract follow-up 1 §4, ROOT's binding condition 1; G3-int A0, G3-dec v1): ONE predicate,
 *   `metalsHeldForMetals`, decides once per order whether the order is held. Each line the title guard flagged
 *   (`metalUncertain`) is answered by the owner's live `bullion` decisions through the ONE matcher
 *   (`metalsBullionAnswer`, read through G1d's `metalsEffectiveSkeleton`): a product answer for its ref and content
 *   fingerprint (any pack), or its lot's answer while its order's active version digest is the one that answer pinned.
 *   An order is held while a flagged line has no answer (undecided, or a decision for it drifted), and, fail-closed,
 *   while a line with no flag reads `bullion-unconfirmed`, stored or as this read recomputes it, or a line answered
 *   `bullion` still reads so. A held order is treated exactly as a held record:
 *   - none of its lines is in `lines` (lot and sale membership, the assignment, every figure, list and product);
 *   - it is a held barrier of its merchant class in the card-link input, never a subject or a competitor;
 *   - it has no charge order;
 *   - its payouts contest credits but prove nothing (inactive);
 *   - it is listed in `heldOrders`, which the views count with the held records and show as needing the owner's answer.
 * - The whole-order projection (contract follow-up 1 §4c-2): once every flagged line of an order is answered, the order
 *   is read through `metalsProjectedOrder`, a new value built from the effective skeleton: a `not-bullion` line, with
 *   its fee and coupon lines, is no metal, every kept line's money comes from the WHOLE order's allocation recomputed
 *   over it (a newly mixed skeleton changes the other lines' shares and completeness), and a `bullion` line is a line of
 *   the metal its flag names (the authoritative metal; null: metal unknown). Keys, the raw skeleton, gross funding,
 *   every amount, each line's raw flag and content fingerprint stay as stored (`stored`, `raw`): content and every scope
 *   are read on the raw line. Every figure, list and link of the order (its lots and sales, card links, charge orders,
 *   deposits) is built from the projection; nothing patches one line's totals. An order left with no metal line (every
 *   line answered `not-bullion`) leaves the ledger: in no figure, list, product or funding row, a competitor in the
 *   card-link input (never a subject), and its payouts keep contesting credits, proving nothing (§4b-e).
 *
 * Pure: no file system, network or clock; the caller reads the inputs (source.ts) and caches the graph.
 */

import {
  cardMetalsMerchantClass,
  type CardMetalsMerchantClass,
} from '@finance-tracker/shared';
import {
  metalsAdmission,
  metalsCardLinks,
  metalsDepositLinks,
  metalsEffectiveSkeleton,
  metalsFineContent,
  metalsLineEvidence,
  readRational,
  type Metal,
  type MetalsAdmission,
  type MetalsAdmissionFacts,
  type MetalsBullionAnswer,
  type MetalsCardBinding,
  type MetalsCardLink,
  type MetalsCardLinkGraph,
  type MetalsChannel,
  type MetalsChargeOrder,
  type MetalsContentDecision,
  type MetalsContentResult,
  type MetalsCoverageKind,
  type MetalsDepositEvidence,
  type MetalsDepositLink,
  type MetalsEffectiveOrder,
  type MetalsHoldReason,
  type MetalsLine,
  type MetalsNetwork,
  type MetalsOrder,
  type MetalsSource,
  type Rational,
} from '@finance-tracker/shared/metals-ledger';
import type { MetalsAccountRef } from '@finance-tracker/shared/metals-api';

import { metalsPayoutOriginSources } from './payoutDescriptors.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface MetalsOrderInput {
  order: MetalsOrder;
  /** The active version's digest: the evidence a lot-scoped decision (of either kind) pins. */
  digest: string;
  /** Some version of the order is in conflict (§4.2): its figures are partial and it proves nothing. */
  quarantined: boolean;
  /** The metals of its conflicting versions' lines, each once (null: a line of unknown metal); empty when none. */
  conflictMetals: Array<Metal | null>;
}

/** A live product-content decision: fine troy ounces per ordered unit, for a product (ref, fingerprint) or one lot. */
export interface MetalsDecisionInput {
  id: string;
  scope: 'product' | 'lot';
  productRef: string | null;
  fingerprint: string | null;
  lotKey: string | null;
  evidenceDigest: string | null;
  metal: Metal | null;
  /** "n/d", lowest terms. */
  troyOzPerUnit: string;
  decidedAt: string;
}

/**
 * A live `bullion` decision: whether the lines the title guard flagged are bullion, for a product (ref and content
 * fingerprint, any pack) or one lot (pinned to its order's active version digest when it was answered).
 */
export interface MetalsBullionDecisionInput {
  id: string;
  scope: 'product' | 'lot';
  productRef: string | null;
  fingerprint: string | null;
  lotKey: string | null;
  evidenceDigest: string | null;
  answer: MetalsBullionAnswer;
  decidedAt: string;
}

export interface MetalsHoldInput {
  importId: string;
  seq: number;
  source: MetalsSource;
  accountId: string;
  key: string | null;
  channel: MetalsChannel;
  date: string | null;
  reason: MetalsHoldReason;
  check: string;
}

export interface MetalsCoverageInput {
  importId: string;
  source: MetalsSource;
  accountId: string;
  kind: MetalsCoverageKind;
  from: string;
  to: string;
  stated: number | null;
  seen: number;
  complete: boolean;
}

export interface MetalsBindingInput {
  kind: 'card' | 'checking';
  source: MetalsSource;
  network: MetalsNetwork | null;
  last4: string;
  accountId: string;
  state: 'active' | 'revoked';
  /** The bound account's status at approval. */
  accountStatus: 'active' | 'closed';
  /** The bound account's owner at approval (card accounts; null for checking, which has none). */
  accountOwner: string | null;
  /** Every same-kind account with this last 4 at approval, the bound one included. */
  peerAccountIds: string[];
}

export interface MetalsCardAccountInput {
  id: string;
  issuer: string;
  owner: string;
  nickname: string | null;
  last4: string | null;
  last5: string | null;
  status: 'active' | 'closed';
}

/** A posted card purchase in US dollars, as Holdr stores it. */
export interface MetalsCardRowInput {
  id: string;
  accountId: string;
  date: string;
  amountMinor: number;
  kind: string;
  currency: string;
  merchant: string | null;
  description: string;
}

export interface MetalsCheckingInput {
  installed: boolean;
  accounts: Array<{ id: string; label: string; last4: string; status: 'active' | 'closed' }>;
  /** Posted rows: positive amounts are credits. */
  rows: Array<{ id: string; accountId: string; date: string; amountMinor: number; currency: string; description: string }>;
  /** Merged covered days per account. */
  coverage: Array<{ accountId: string; from: string; to: string }>;
}

export interface MetalsLedgerInputs {
  orders: MetalsOrderInput[];
  observations: Array<{ importId: string; accountId: string; orderKey: string }>;
  accounts: MetalsAccountRef[];
  /**
   * `importSeq` is G2's causal import sequence (rising with commit order): the only chronology of imports. Each import's
   * provenance, as stored: its capture's schema (null for an import that isn't a capture) and the full
   * `holdr-metals-convert x.y.z` that converted it.
   */
  imports: Array<{
    importId: string; importSeq: number; source: MetalsSource; accountId: string; capturedAt: string | null; importedAt: string;
    captureSchema: string | null; converterVersion: string;
  }>;
  competitors: Array<{ orderKey: string; channel: MetalsChannel; date: string; admission: MetalsAdmissionFacts; factsDigest: string; importId: string }>;
  /** Every import that listed a competitor (D-G2-2), unchanged re-reads included: what closes an earlier hold of its key. */
  competitorObservations: Array<{ importId: string; orderKey: string; factsDigest: string }>;
  holds: MetalsHoldInput[];
  coverage: MetalsCoverageInput[];
  bindings: MetalsBindingInput[];
  /** Live product-content decisions (not revoked). */
  decisions: MetalsDecisionInput[];
  /** Live bullion decisions (not revoked): the owner's answers for the lines the title guard flagged. */
  bullionDecisions: MetalsBullionDecisionInput[];
  cardAccounts: MetalsCardAccountInput[];
  cardRows: MetalsCardRowInput[];
  checking: MetalsCheckingInput;
}

/** The read core's test seam (see `buildMetalsLedgerGraph`). */
export interface MetalsLedgerBuildOptions {
  originSources?: (description: string) => readonly MetalsSource[];
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

export interface MetalsLedgerOrder {
  /**
   * The order as every figure, list and link reads it: its active version as stored, or, once every line the title guard
   * flagged is answered, its projection (`metalsProjectedOrder`). A held order is read as stored.
   */
  order: MetalsOrder;
  /** The active version's aggregate as stored: the raw skeleton, lines, flags and fingerprints, never changed here. */
  stored: MetalsOrder;
  source: MetalsSource;
  digest: string;
  quarantined: boolean;
  /** The metals of its conflicting versions' lines (null: unknown metal): the read side never reads those versions otherwise. */
  conflictMetals: Array<Metal | null>;
  /** The account that observed it first. */
  account: MetalsAccountRef;
  /** Its card funding's admission, recomputed (null: no card funding, or a sale). */
  admission: MetalsAdmission | null;
  /** Held for metals (`metalsHeldForMetals`): in no figure, a held barrier, counted with the held records. */
  heldForMetals: boolean;
  /**
   * Every line answered `not-bullion`, so no metal line is left: the order left the ledger. It is in no figure, list,
   * product or funding row and is not held; a buy with card funding is a competitor in the card-link input, never a
   * subject; a sale's payouts keep contesting credits, proving nothing (contract follow-up 1 §4, §4b-e).
   */
  leftLedger: boolean;
  /** Each flagged line's standing from the one matcher, in line order (empty when no line is flagged). */
  answers: MetalsEffectiveOrder['answers'];
}

export interface MetalsLedgerLine {
  key: string;
  side: 'buy' | 'sell';
  order: MetalsLedgerOrder;
  /** The line as the figures read it: its order's projection (a `bullion` line is a line of its flag's metal). */
  line: MetalsLine;
  /** The line as stored: its content, fingerprint and every decision scope are read on it. */
  raw: MetalsLine;
  content: MetalsContentResult;
  /** Fine troy ounces per unit, or null while held. */
  fine: Rational | null;
  /** The owner's decision that answers it, if one does. */
  decision: MetalsDecisionInput | null;
  /** A decision exists for its ref or line, but its details differ from what that decision confirmed. */
  drift: boolean;
  /** The confirmation scope its line belongs to (§4.4.1): its product (ref and fingerprint) or itself. */
  scope: { kind: 'product'; ref: string; fingerprint: string } | { kind: 'lot'; why: 'pack-multiple' | 'pack-unknown' | 'ref-missing' };
}

/**
 * Where a flagged line's bullion answer is written (contract follow-up 1 §4: "keyed by productRef + content fingerprint
 * else per lot"): its product ref with its content fingerprint, whatever its pack, when it has a ref; else its own lot,
 * pinned to its order's active version digest.
 */
export type MetalsBullionScope = { kind: 'product'; ref: string; fingerprint: string } | { kind: 'lot'; lotKey: string };

/** A line the title guard flagged, in any order (held, read through its projection, or left), with its standing. */
export interface MetalsFlaggedLine {
  key: string;
  order: MetalsLedgerOrder;
  /** The line as stored, its flag included. */
  line: MetalsLine;
  /** The one matcher's answer: null while undecided, or when a decision for it drifted. */
  answer: MetalsBullionAnswer | null;
  drift: boolean;
  scope: MetalsBullionScope;
  /**
   * The live answer governing it, as the matcher reads them: its lot's (answering, or drifted when pinned to other
   * evidence), else its own product scope's; null when neither has one (a product drift names no one decision).
   */
  decision: MetalsBullionDecisionInput | null;
}

export interface MetalsLedgerGraph {
  /** Every order with an active version: held for metals, counted, or left the ledger. */
  orders: Map<string, MetalsLedgerOrder>;
  /** The lines of every order neither held for metals nor left: the only lines any figure, list or product reads. */
  lines: MetalsLedgerLine[];
  lineByKey: Map<string, MetalsLedgerLine>;
  /** The orders held for metals, by key: their lines are in no figure until the owner answers every flagged line. */
  heldOrders: MetalsLedgerOrder[];
  /** Every line the title guard flagged, of every order, by order key then line order. */
  flagged: MetalsFlaggedLine[];
  flaggedByKey: Map<string, MetalsFlaggedLine>;
  accounts: Map<string, MetalsAccountRef>;
  /**
   * Held records no later import (by G2's causal import sequence) has read: per key those of its latest import, keyless
   * ones each.
   */
  openHolds: MetalsHoldInput[];
  coverage: MetalsCoverageInput[];
  imports: MetalsLedgerInputs['imports'];
  cardGraph: MetalsCardLinkGraph;
  cardLinksByOrder: Map<string, MetalsCardLink[]>;
  depositLinks: Map<string, MetalsDepositLink>;
  depositEvidence: MetalsDepositEvidence[];
  /** Checking account a payout destination is bound to (active binding), by `<source>|<last 4>`. */
  checkingBindingByLast4: Map<string, string>;
  /** The last day each checking account's imported coverage reaches. */
  checkingCoveredThrough: Map<string, string>;
  chargeOrders: Map<string, MetalsChargeOrder>;
  cardRows: Map<string, MetalsCardRowInput>;
  cardAccounts: Map<string, MetalsCardAccountInput>;
  checkingRows: Map<string, MetalsCheckingInput['rows'][number]>;
  checkingAccounts: Map<string, MetalsCheckingInput['accounts'][number]>;
  decisions: MetalsDecisionInput[];
  bullionDecisions: MetalsBullionDecisionInput[];
  /** What the graph was built from: a preview rebuilds it whole with other decisions (`metalsLedgerGraphWith`), never patches it. */
  built: { inputs: MetalsLedgerInputs; options: MetalsLedgerBuildOptions };
}

const SOURCE_OF_KEY = /^(costco|walmart|collectpure)-/;

export function metalsSourceOfKey(key: string): MetalsSource | null {
  const match = SOURCE_OF_KEY.exec(key);
  return match ? (match[1] as MetalsSource) : null;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function toContentDecision(decision: MetalsDecisionInput): MetalsContentDecision | null {
  if (decision.scope === 'product' && decision.productRef !== null && decision.fingerprint !== null) {
    return { scope: 'product', productRef: decision.productRef, fingerprint: decision.fingerprint, troyOzPerUnit: decision.troyOzPerUnit };
  }
  if (decision.scope === 'lot' && decision.lotKey !== null && decision.evidenceDigest !== null) {
    return { scope: 'lot', lotKey: decision.lotKey, evidenceDigest: decision.evidenceDigest, troyOzPerUnit: decision.troyOzPerUnit };
  }
  return null;
}

function toBullionDecision(decision: MetalsBullionDecisionInput): MetalsContentDecision | null {
  if (decision.scope === 'product' && decision.productRef !== null && decision.fingerprint !== null) {
    return { kind: 'bullion', scope: 'product', productRef: decision.productRef, fingerprint: decision.fingerprint, answer: decision.answer };
  }
  if (decision.scope === 'lot' && decision.lotKey !== null && decision.evidenceDigest !== null) {
    return { kind: 'bullion', scope: 'lot', lotKey: decision.lotKey, evidenceDigest: decision.evidenceDigest, answer: decision.answer };
  }
  return null;
}

/**
 * Whether a line's product ref names one product only, for the owner's decisions of BOTH kinds: a present ref does. A
 * ref is a source's catalog id, which names one product per source, and the content fingerprint carries what the line's
 * content evidence is, so a product decision is reused only on the pair. Defined once: the content rule's context
 * (`metalsResolveContent`) and the bullion matcher's (`metalsEffectiveSkeleton`) both read it, and must never diverge.
 */
export function metalsProductRefUnique(productRef: string | null): boolean {
  return productRef !== null;
}

/** The confirmation scope of a line (§4.4.1): product-wide only for a `single` pack with a product ref. */
export function metalsLineScope(line: MetalsLine): MetalsLedgerLine['scope'] {
  if (line.pack === 'single' && line.productRef !== null) return { kind: 'product', ref: line.productRef, fingerprint: line.contentFingerprint };
  return { kind: 'lot', why: line.pack === 'multiple' ? 'pack-multiple' : line.pack === 'unknown' ? 'pack-unknown' : 'ref-missing' };
}

/**
 * The scope a flagged line's bullion answer is written in: its product (ref and content fingerprint, whatever its pack:
 * whether a product is bullion doesn't depend on how many pieces a unit holds) when it has a ref, else its own lot.
 */
export function metalsBullionScopeOf(line: MetalsLine): MetalsBullionScope {
  return line.productRef !== null ? { kind: 'product', ref: line.productRef, fingerprint: line.contentFingerprint } : { kind: 'lot', lotKey: line.key };
}

/** Whether a live bullion decision is one the matcher reads for a line: its lot's, or one of its ref's (any fingerprint). */
function bullionReaches(line: MetalsLine, decision: MetalsBullionDecisionInput): boolean {
  return (decision.scope === 'lot' && decision.lotKey === line.key)
    || (line.productRef !== null && decision.scope === 'product' && decision.productRef === line.productRef);
}

/** The live bullion decisions the matcher reads for a line: its lot's and ALL of its ref's, never pre-filtered by fingerprint. */
function bullionDecisionsOf(line: MetalsLine, bullion: readonly MetalsBullionDecisionInput[]): MetalsBullionDecisionInput[] {
  return bullion.filter((decision) => bullionReaches(line, decision));
}

/**
 * A line's fine content with the owner's decisions. G1a's rule sees every live decision of the line, of both kinds: its
 * own lot's and ALL product decisions of its ref, never pre-filtered by fingerprint, since it detects drift (a ref with
 * decisions, none for the line's fingerprint) only when it sees them all. A lot decision answers its line outright;
 * otherwise the ref's decision with the line's own fingerprint does.
 *
 * The rule reads the line's whole stored evidence (`metalsLineEvidence`), the title guard's flag included, so pass the
 * line AS STORED (`MetalsLedgerLine.raw`), never a projection: its fingerprint is the raw line's. A flagged line is held
 * `bullion-unconfirmed` until its lot or ref carries the owner's `bullion` answer, whatever content decision it has,
 * since a content-only approval never releases the bullion gate; after `bullion` it is a line of its flag's metal.
 */
export function metalsResolveContent(
  source: MetalsSource,
  line: MetalsLine,
  orderDigest: string,
  decisions: readonly MetalsDecisionInput[],
  bullion: readonly MetalsBullionDecisionInput[] = [],
): { content: MetalsContentResult; decision: MetalsDecisionInput | null; drift: boolean } {
  const lot = decisions.find((decision) => decision.scope === 'lot' && decision.lotKey === line.key);
  const products = line.productRef === null ? [] : decisions
    .filter((decision) => decision.scope === 'product' && decision.productRef === line.productRef);
  const content = metalsFineContent(metalsLineEvidence(line, source), {
    lotKey: line.key,
    productRef: line.productRef,
    productRefUnique: metalsProductRefUnique(line.productRef),
    evidenceDigest: orderDigest,
    decisions: [
      ...[...(lot ? [lot] : []), ...products].map(toContentDecision),
      ...bullionDecisionsOf(line, bullion).map(toBullionDecision),
    ].filter((decision): decision is MetalsContentDecision => decision !== null),
  });
  const answering = content.known && content.basis === 'owner-confirmed'
    ? (lot ?? products.find((decision) => decision.fingerprint === line.contentFingerprint) ?? null)
    : null;
  return { content, decision: answering, drift: !content.known && content.missing.includes('confirmation-drift') };
}

const BULLION_UNCONFIRMED = 'bullion-unconfirmed';

/**
 * "Held for metals" (contract follow-up 1 §4, ROOT's binding condition 1): the ONE read-side predicate every metal
 * figure, competitor set and allocation reads, given each line's recomputed content and its answer from the one matcher
 * (`metalsBullionAnswer`, read through `metalsEffectiveSkeleton`; null or left out: no answer). An order is held while
 * any of its lines:
 * - carries the title guard's flag (`metalUncertain`; an aggregate missing the field counts as flagged, fail-closed) and
 *   has no answer: undecided, or a decision for it drifted;
 * - is answered `bullion` but still reads `bullion-unconfirmed` as this read recomputes it (fail-closed);
 * - carries no flag but is stored held `bullion-unconfirmed`, or reads so as this read recomputes it (fail-closed).
 * A line answered `not-bullion` never holds its order: the content rule keeps its `bullion-unconfirmed` by design, and
 * the projection takes it out of metals.
 */
export function metalsHeldForMetals(
  lines: ReadonlyArray<{ line: MetalsLine; content: MetalsContentResult; answer?: MetalsBullionAnswer | null }>,
): boolean {
  return lines.some(({ line, content, answer }) => {
    const readsUnconfirmed = !content.known && content.missing.includes(BULLION_UNCONFIRMED);
    if (line.metalUncertain !== null) {
      if (answer === undefined || answer === null) return true;
      return answer === 'bullion' && readsUnconfirmed;
    }
    const stored = line.fine as { hold?: unknown; missing?: unknown };
    if (stored.hold === BULLION_UNCONFIRMED || (Array.isArray(stored.missing) && stored.missing.includes(BULLION_UNCONFIRMED))) return true;
    return readsUnconfirmed;
  });
}

/**
 * The order as the read counts it once every flagged line is answered (contract follow-up 1 §4c-2): a NEW value, built
 * whole from the stored order and its effective skeleton (`metalsEffectiveSkeleton`), never one line patched.
 * - The skeleton is the effective one: a `not-bullion` line, and the fee and coupon lines attached to it, are no metal.
 * - Its lines are the stored lines but the `not-bullion` ones. Each kept line's direct money, allocated shares, cost (a
 *   buy) or net (a sale) and completeness come from the WHOLE order's allocation over that skeleton, so a newly mixed
 *   skeleton changes the other lines' shares and completeness too, and the order's unattributed cost comes with it.
 * - A `bullion` line is a line of the metal its flag names: the authoritative metal (null: metal unknown).
 * The keys, the raw flags and content fingerprints, the amounts, admission, payouts and full price stay as stored.
 */
export function metalsProjectedOrder(order: MetalsOrder, effective: MetalsEffectiveOrder): MetalsOrder {
  const answers = new Map(effective.answers.map((entry) => [entry.ordinal, entry.answer]));
  const money = new Map(effective.allocation.lines.map((entry) => [entry.ordinal, entry]));
  const lines = order.lines.filter((line) => answers.get(line.ordinal) !== 'not-bullion').map((line): MetalsLine => {
    const share = money.get(line.ordinal);
    // A stored line is a metal item of the stored skeleton, and the effective skeleton changes only the not-bullion lines.
    if (share === undefined || !share.metal) throw new TypeError('metalsProjectedOrder: a kept line is no metal item of the effective skeleton');
    return {
      ...line,
      metal: answers.get(line.ordinal) === 'bullion' ? (line.metalUncertain?.metal ?? null) : line.metal,
      directMinor: share.directMinor,
      allocated: share.allocated.map((entry) => ({ ...entry })),
      costMinor: order.side === 'buy' ? share.totalMinor : null,
      netMinor: order.side === 'sell' ? share.totalMinor : null,
      complete: share.complete,
    };
  });
  return { ...order, skeleton: effective.skeleton, lines, unattributedMinor: effective.allocation.unattributedMinor };
}

/**
 * Whether an active binding drifted since its approval (§7, ROOT's D-G2-1): the bound account is gone; its last 4,
 * status or owner differs from the approval's; or an account with that last 4 (any status) appeared that the approval's
 * peer list doesn't name. A peer that disappeared doesn't suspend it.
 */
export function metalsBindingDrifted(
  binding: Pick<MetalsBindingInput, 'accountId' | 'last4' | 'accountStatus' | 'accountOwner' | 'peerAccountIds'>,
  accounts: ReadonlyArray<{ id: string; last4: string | null; status: string; owner?: string | null }>,
): boolean {
  const account = accounts.find((entry) => entry.id === binding.accountId);
  if (!account || account.last4 !== binding.last4 || account.status !== binding.accountStatus) return true;
  if ((account.owner ?? null) !== binding.accountOwner) return true;
  const approved = new Set(binding.peerAccountIds);
  return accounts.some((entry) => entry.last4 === binding.last4 && !approved.has(entry.id));
}

/**
 * The card bindings card links and the card check read (§7): every active card binding that names a network, suspended
 * when it drifted (`metalsBindingDrifted`). Revoked bindings bind nothing.
 */
export function metalsCardBindings(
  bindings: readonly MetalsBindingInput[],
  cardAccounts: readonly MetalsCardAccountInput[],
): MetalsCardBinding[] {
  return bindings.filter((binding) => binding.kind === 'card' && binding.state === 'active' && binding.network !== null)
    .map((binding) => ({
      source: binding.source,
      network: binding.network!,
      last4: binding.last4,
      accountId: binding.accountId,
      state: metalsBindingDrifted(binding, cardAccounts) ? 'suspended' as const : 'active' as const,
    }));
}

const UNKNOWN_ACCOUNT = (source: MetalsSource): MetalsAccountRef => ({ accountId: '', source, label: 'Unknown account' });

/**
 * Builds the graph. Deterministic in its inputs. `originSources` is a test seam only: the sources whose reviewed payout
 * origin text a checking credit's description names (by default METALS_PAYOUT_DESCRIPTORS: CollectPure's counterparty
 * name, for CollectPure payouts only).
 */
export function buildMetalsLedgerGraph(
  inputs: MetalsLedgerInputs,
  options: MetalsLedgerBuildOptions = {},
): MetalsLedgerGraph {
  const originSources = options.originSources ?? metalsPayoutOriginSources;
  const accounts = new Map(inputs.accounts.map((account) => [account.accountId, account]));
  // Chronology (G3-C1, Root's ruling): imports are ordered only by G2's causal import sequence, assigned inside each
  // import's write transaction, never by import id (random) or time (two imports can share an instant). An import this
  // read doesn't know is fail-closed: it sorts last, its held records are never released and its observations release
  // nothing.
  const importSeq = new Map(inputs.imports.map((entry) => [entry.importId, entry.importSeq]));
  const seqOf = (importId: string) => importSeq.get(importId) ?? Number.MAX_SAFE_INTEGER;

  const firstObserver = new Map<string, { seq: number; accountId: string }>();
  const lastSeen = new Map<string, number>();
  const noteSeen = (orderKey: string, importId: string) => {
    const seq = importSeq.get(importId);
    if (seq !== undefined && seq > (lastSeen.get(orderKey) ?? 0)) lastSeen.set(orderKey, seq);
  };
  for (const observation of inputs.observations) {
    const seq = seqOf(observation.importId);
    const first = firstObserver.get(observation.orderKey);
    if (!first || seq < first.seq) firstObserver.set(observation.orderKey, { seq, accountId: observation.accountId });
    noteSeen(observation.orderKey, observation.importId);
  }
  // A key is seen by every import that lists it: as an order (metals_observations) or as a competitor, unchanged re-reads
  // included (metals_competitor_observations, D-G2-2).
  for (const observation of inputs.competitorObservations) noteSeen(observation.orderKey, observation.importId);

  const orders = new Map<string, MetalsLedgerOrder>();
  const lines: MetalsLedgerLine[] = [];
  const heldOrders: MetalsLedgerOrder[] = [];
  const flagged: MetalsFlaggedLine[] = [];
  const bullionLot = (key: string) => inputs.bullionDecisions.find((decision) => decision.scope === 'lot' && decision.lotKey === key) ?? null;
  const bullionProduct = (ref: string, fingerprint: string) => inputs.bullionDecisions.find((decision) => decision.scope === 'product'
    && decision.productRef === ref && decision.fingerprint === fingerprint) ?? null;
  for (const input of [...inputs.orders].sort((a, b) => compareText(a.order.key, b.order.key))) {
    const source = metalsSourceOfKey(input.order.key);
    if (source === null) continue;
    const observer = firstObserver.get(input.order.key);
    // Each flagged line's answer from the ONE matcher (G1d's effective skeleton reads metalsBullionAnswer), with the
    // bullion decisions of the order's lots and refs, the active version's digest and the one product-ref rule.
    const isFlagged = (line: MetalsLine) => line.metalUncertain !== null;
    const effective = input.order.lines.some(isFlagged)
      ? metalsEffectiveSkeleton(input.order, source, {
        evidenceDigest: input.digest,
        decisions: inputs.bullionDecisions.filter((decision) => input.order.lines.some((line) => bullionReaches(line, decision)))
          .map(toBullionDecision).filter((decision): decision is MetalsContentDecision => decision !== null),
        productRefUnique: metalsProductRefUnique,
      })
      : null;
    const answerOf = new Map((effective?.answers ?? []).map((entry) => [entry.key, entry]));
    const order: MetalsLedgerOrder = {
      order: input.order,
      stored: input.order,
      source,
      digest: input.digest,
      quarantined: input.quarantined,
      conflictMetals: input.conflictMetals,
      account: (observer && accounts.get(observer.accountId)) || UNKNOWN_ACCOUNT(source),
      admission: input.order.admission === null ? null : metalsAdmission(source, input.order.channel, input.order.admission),
      heldForMetals: false,
      leftLedger: false,
      answers: effective?.answers ?? [],
    };
    orders.set(input.order.key, order);
    // Content, on each line AS STORED, with the owner's decisions of both kinds.
    const resolved = new Map(input.order.lines.map((line) => [line.key, {
      line, answer: answerOf.get(line.key)?.answer ?? null,
      ...metalsResolveContent(source, line, input.digest, inputs.decisions, inputs.bullionDecisions),
    }]));
    // The one predicate, once per order: a held order's lines (flagged or not) join no figure.
    order.heldForMetals = metalsHeldForMetals([...resolved.values()]);
    if (!order.heldForMetals && effective !== null) order.order = metalsProjectedOrder(input.order, effective);
    order.leftLedger = !order.heldForMetals && order.order.lines.length === 0;
    for (const line of input.order.lines.filter(isFlagged)) {
      const standing = answerOf.get(line.key);
      const scope = metalsBullionScopeOf(line);
      flagged.push({
        key: line.key, order, line, answer: standing?.answer ?? null, drift: standing?.drift ?? false, scope,
        decision: bullionLot(line.key) ?? (scope.kind === 'product' ? bullionProduct(scope.ref, scope.fingerprint) : null),
      });
    }
    if (order.heldForMetals) {
      heldOrders.push(order);
      continue;
    }
    // Every figure reads the projection's lines; content and scope stay the stored line's.
    lines.push(...order.order.lines.map((line): MetalsLedgerLine => {
      const entry = resolved.get(line.key)!;
      return {
        key: line.key,
        side: input.order.side,
        order,
        line,
        raw: entry.line,
        content: entry.content,
        fine: entry.content.known ? entry.content.troyOz : null,
        decision: entry.decision,
        drift: entry.drift,
        scope: metalsLineScope(entry.line),
      };
    }));
  }
  const lineByKey = new Map(lines.map((entry) => [entry.key, entry]));

  // Held records: open until a later import (by sequence) reads the key, as an order or a competitor; of a key's open
  // records, those of its latest import stay (all of them, should one import hold a key twice); keyless ones each.
  const openByKey = new Map<string, MetalsHoldInput[]>();
  const keyless: MetalsHoldInput[] = [];
  for (const hold of inputs.holds) {
    if (hold.key === null) {
      keyless.push(hold);
      continue;
    }
    const seq = seqOf(hold.importId);
    if ((lastSeen.get(hold.key) ?? 0) > seq) continue;
    const kept = openByKey.get(hold.key);
    if (kept === undefined || seq > seqOf(kept[0].importId)) openByKey.set(hold.key, [hold]);
    else if (seq === seqOf(kept[0].importId)) kept.push(hold);
  }
  const openHolds = [...[...openByKey.values()].flat(), ...keyless]
    .sort((a, b) => seqOf(a.importId) - seqOf(b.importId) || a.seq - b.seq);

  // Card links over the whole ledger. An order held for metals is never a subject or a competitor: it bars every row of
  // its merchant class in its settlement interval, exactly as a held record (contract follow-up 1 §4b-a). The buy
  // orders that count are the subjects here and the charge orders below, from one list. An order that left the ledger
  // (every line answered not bullion) is a competitor computed from its admission facts, never a subject (§4).
  const cardAccounts = new Map(inputs.cardAccounts.map((account) => [account.id, account]));
  const cardBindings = metalsCardBindings(inputs.bindings, inputs.cardAccounts);
  const countedBuys = [...orders.values()].filter((entry) => entry.order.side === 'buy' && entry.order.admission !== null && !entry.heldForMetals
    && !entry.leftLedger);
  const fundedOrders = countedBuys.map((entry) => ({
    orderKey: entry.order.key, source: entry.source, channel: entry.order.channel, date: entry.order.date,
    admission: entry.order.admission!, metal: true, active: !entry.quarantined,
  }));
  const leftBuys = [...orders.values()].filter((entry) => entry.order.side === 'buy' && entry.order.admission !== null && entry.leftLedger)
    .map((entry) => ({
      orderKey: entry.order.key, source: entry.source, channel: entry.order.channel, date: entry.order.date,
      admission: entry.order.admission!, metal: false, active: !entry.quarantined,
    }));
  const factVersions = new Map<string, Set<string>>();
  const competitorOrders: typeof fundedOrders = [];
  for (const competitor of [...inputs.competitors].sort((a, b) => compareText(a.orderKey, b.orderKey) || seqOf(a.importId) - seqOf(b.importId)
    || compareText(a.factsDigest, b.factsDigest))) {
    const source = metalsSourceOfKey(competitor.orderKey);
    if (source === null || orders.has(competitor.orderKey)) continue;
    const seen = factVersions.get(competitor.orderKey) ?? new Set<string>();
    if (seen.has(competitor.factsDigest)) continue;
    seen.add(competitor.factsDigest);
    factVersions.set(competitor.orderKey, seen);
    competitorOrders.push({
      orderKey: seen.size === 1 ? competitor.orderKey : `${competitor.orderKey}~${seen.size}`,
      source, channel: competitor.channel, date: competitor.date, admission: competitor.admission, metal: false, active: true,
    });
  }
  const cardRows = inputs.cardRows.filter((row) => row.kind === 'purchase' && row.currency === 'USD');
  const merchantClasses = new Map<string, CardMetalsMerchantClass | null>(cardRows.map((row) => [row.id,
    cardMetalsMerchantClass({ merchant: row.merchant, description: row.description })]));
  const cardGraph = metalsCardLinks({
    orders: [...fundedOrders, ...leftBuys, ...competitorOrders],
    held: [
      ...openHolds.map((hold) => ({ source: hold.source, channel: hold.channel, date: hold.date })),
      ...heldOrders.map((entry) => ({ source: entry.source, channel: entry.order.channel, date: entry.order.date })),
    ],
    rows: cardRows.filter((row) => merchantClasses.get(row.id) !== null).map((row) => ({
      id: row.id, accountId: row.accountId, date: row.date, amountMinor: row.amountMinor, kind: 'purchase' as const,
      currency: row.currency, usable: true, merchantClass: merchantClasses.get(row.id)!,
    })),
    accounts: inputs.cardAccounts.map((account) => ({ id: account.id, last4: account.last4 })),
    bindings: cardBindings,
  });
  const cardLinksByOrder = new Map<string, MetalsCardLink[]>();
  for (const link of cardGraph.links) {
    const list = cardLinksByOrder.get(link.orderKey) ?? [];
    list.push(link);
    cardLinksByOrder.set(link.orderKey, list);
  }

  // Deposit links over every payout.
  const checkingAccounts = new Map(inputs.checking.accounts.map((account) => [account.id, account]));
  const checkingBindings = inputs.bindings.filter((binding) => binding.kind === 'checking' && binding.state === 'active');
  const checkingBindingByLast4 = new Map<string, string>();
  for (const binding of checkingBindings) {
    const key = `${binding.source}|${binding.last4}`;
    if (!checkingBindingByLast4.has(key)) checkingBindingByLast4.set(key, binding.accountId);
  }
  const checkingCoveredThrough = new Map<string, string>();
  for (const range of inputs.checking.coverage) {
    const through = checkingCoveredThrough.get(range.accountId);
    if (!through || range.to > through) checkingCoveredThrough.set(range.accountId, range.to);
  }
  // A payout of a sale held for metals keeps contesting credits but proves nothing, as a quarantined sale's (§4b-e); so
  // does one of a sale that left the ledger (every line answered not bullion), fail-closed.
  const payouts = [...orders.values()].filter((entry) => entry.order.side === 'sell').flatMap((entry) => entry.order.payouts.map((payout) => ({
    payoutKey: payout.key, saleOrderKey: entry.order.key, source: entry.source, amountMinor: payout.amountMinor,
    initiatedDate: payout.initiatedDate, payoutDate: payout.payoutDate, destinationLast4: payout.destinationLast4, status: payout.status,
    active: !entry.quarantined && !entry.heldForMetals && !entry.leftLedger,
  })));
  const deposits = metalsDepositLinks({
    payouts,
    rows: inputs.checking.rows.filter((row) => row.amountMinor > 0).map((row) => ({
      id: row.id, accountId: row.accountId, date: row.date, amountMinor: row.amountMinor, kind: 'credit' as const, currency: row.currency,
      usable: true, originSources: originSources(row.description),
    })),
    // Every checking account with the last 4 it shows: an unbound or drifted payout contests credits on each that could be its
    // destination, and a drifted one also on its last bound account while it exists, whatever it shows now (C4).
    accounts: inputs.checking.accounts.map((account) => ({ id: account.id, last4: account.last4 })),
    bindings: checkingBindings.map((binding) => ({
      source: binding.source, last4: binding.last4, accountId: binding.accountId,
      state: metalsBindingDrifted(binding, inputs.checking.accounts) ? 'suspended' as const : 'active' as const,
    })),
    coverage: inputs.checking.coverage,
  });

  // Charge orders from the projection: the effective skeleton (a not-bullion line no metal, so its parts are rebuilt from
  // the whole order) and each metal line's metal (a bullion line its flag's).
  const chargeOrders = new Map<string, MetalsChargeOrder>();
  for (const entry of countedBuys) {
    chargeOrders.set(entry.order.key, {
      orderKey: entry.order.key, skeleton: entry.order.skeleton, components: entry.order.components, admission: entry.order.admission!,
      metals: new Map(entry.order.lines.map((line) => [line.ordinal, line.metal])),
    });
  }

  return {
    orders,
    lines,
    lineByKey,
    heldOrders,
    flagged,
    flaggedByKey: new Map(flagged.map((entry) => [entry.key, entry])),
    accounts,
    openHolds,
    coverage: inputs.coverage,
    imports: inputs.imports,
    cardGraph,
    cardLinksByOrder,
    depositLinks: new Map(deposits.links.map((link) => [link.payoutKey, link])),
    depositEvidence: deposits.evidence,
    checkingBindingByLast4,
    checkingCoveredThrough,
    chargeOrders,
    cardRows: new Map(inputs.cardRows.map((row) => [row.id, row])),
    cardAccounts,
    checkingRows: new Map(inputs.checking.rows.map((row) => [row.id, row])),
    checkingAccounts,
    decisions: inputs.decisions,
    bullionDecisions: inputs.bullionDecisions,
    built: { inputs, options },
  };
}

/**
 * The graph rebuilt WHOLE from the inputs it was built from, with other live bullion decisions: what an owner's answer
 * or revocation would make of every figure, list and link (a preview). Nothing of the given graph is patched.
 */
export function metalsLedgerGraphWith(graph: MetalsLedgerGraph, bullionDecisions: MetalsBullionDecisionInput[]): MetalsLedgerGraph {
  return buildMetalsLedgerGraph({ ...graph.built.inputs, bullionDecisions }, graph.built.options);
}

/** A decision's troy ounces per unit, or null when its stored value can't be read. */
export function metalsDecisionTroyOz(decision: MetalsDecisionInput): Rational | null {
  return readRational(decision.troyOzPerUnit);
}
