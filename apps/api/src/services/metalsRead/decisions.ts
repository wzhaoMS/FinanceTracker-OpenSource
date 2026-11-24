/**
 * The owner's decisions (design v8 §4.4.1, §6, §8, G3; contract follow-up 1 §4, G3-dec), stored in
 * `metals_owner_decisions` (G2):
 *
 * Content, kind `product-content`: what one ordered unit of a product, or of one line, contains, in fine troy ounces.
 * - product scope: a `single`-pack product's ref with the content fingerprint it is confirmed for; reused only by lines
 *   with that ref and fingerprint;
 * - lot scope: one line (a `multiple` or `unknown` pack, or no product ref) with its order's active version digest,
 *   the evidence it approved; never reused by another line.
 *
 * Bullion, kind `bullion`: whether the lines the title guard flagged are bullion (`bullion` | `not-bullion`).
 * - product scope: a ref with the content fingerprint it is answered for, whatever the pack; it answers every flagged
 *   line of that ref and fingerprint, in every order and account;
 * - lot scope: one flagged line with no product ref, pinned to its order's active version digest; any later capture of
 *   the order (a progression included) changes that digest, and the line needs its answer again (drift).
 * The read applies them through the one matcher (ledger.ts); an answer never names a metal.
 *
 * Every write is previewed: the preview lists what the change would do and binds it, with the scope, the value or
 * answer, the decision it replaces, and each line the scope reaches with its version and quarantine, in its digest,
 * together with today's date in New York (a preview made before midnight there is stale after it). The write recomputes
 * the preview from the database inside its IMMEDIATE transaction and is refused (`preview-stale`) unless the digest is
 * the same. A new decision replaces the live one of exactly its own scope (revoked, the one update a decision admits)
 * and is inserted with an explicit rowid, one more than the table's highest, read inside that transaction; revoking a
 * content decision restores the holds, and revoking an answer makes its lines need one again. Nothing is ever deleted.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { toLetterHex } from '@finance-tracker/shared';
import { METALS, formatRational, type Metal, type MetalsBullionAnswer, type Rational } from '@finance-tracker/shared/metals-ledger';
import type {
  MetalsBullionDecision,
  MetalsBullionFigures,
  MetalsBullionOrderCounts,
  MetalsBullionPreview,
  MetalsContentPreview,
  MetalsProductDecision,
} from '@finance-tracker/shared/metals-api';

import { metalsSchemaState } from '../metals/index.js';
import {
  buildMetalsLedgerGraph,
  metalsLedgerGraphWith,
  metalsResolveContent,
  type MetalsBullionDecisionInput,
  type MetalsBullionScope,
  type MetalsDecisionInput,
  type MetalsFlaggedLine,
  type MetalsLedgerGraph,
} from './ledger.js';
import { MetalsCorrectionUnsupported, MetalsSchemaClosed, metalsCorrectionPresent, readMetalsLedgerInputs, type MetalsCardRows } from './source.js';
import { MetalsViews, metalsTroyOz } from './views.js';

export type MetalsContentScope = { kind: 'product'; ref: string; fingerprint: string } | { kind: 'lot'; lotKey: string };

export type MetalsContentChange =
  | { action: 'confirm'; scope: MetalsContentScope; metal: Metal; troyOzPerUnit: Rational }
  | { action: 'revoke'; scope: MetalsContentScope; decisionId: string };

/** Why a change can't be previewed: its scope has no lines, or its decision is not live in that scope. */
export type MetalsContentRefusal = 'scope-not-found' | 'decision-not-found';

const PREVIEW_ID = 'mtl-dec-preview';

function digestOf(value: unknown): string {
  return toLetterHex(createHash('sha256').update(JSON.stringify(value), 'utf8').digest());
}

/** The decisions as they would be after the change: a confirmation replaces the scope's live decision. */
function decisionsAfter(views: MetalsViews, change: MetalsContentChange): { after: MetalsDecisionInput[]; replaced: MetalsDecisionInput | null } {
  const live = views.liveDecisionFor(change.scope);
  if (change.action === 'revoke') return { after: views.graph.decisions.filter((decision) => decision.id !== change.decisionId), replaced: live };
  const decision: MetalsDecisionInput = change.scope.kind === 'product'
    ? { id: PREVIEW_ID, scope: 'product', productRef: change.scope.ref, fingerprint: change.scope.fingerprint, lotKey: null, evidenceDigest: null,
      metal: change.metal, troyOzPerUnit: formatRational(change.troyOzPerUnit), decidedAt: '' }
    : { id: PREVIEW_ID, scope: 'lot', productRef: null, fingerprint: null, lotKey: change.scope.lotKey,
      evidenceDigest: views.graph.lineByKey.get(change.scope.lotKey)?.order.digest ?? null, metal: change.metal,
      troyOzPerUnit: formatRational(change.troyOzPerUnit), decidedAt: '' };
  return { after: [...views.graph.decisions.filter((entry) => entry.id !== live?.id), decision], replaced: live };
}

/**
 * What a change would do, or why it can't be previewed. `today` (New York) is the day recorded holdings are measured.
 * Deterministic in the ledger, the decisions and the change.
 */
export function metalsContentPreview(views: MetalsViews, change: MetalsContentChange, metal: Metal): MetalsContentPreview | MetalsContentRefusal {
  const scopeLines = views.scopeLines(change.scope);
  if (scopeLines.length === 0) return 'scope-not-found';
  if (change.action === 'revoke') {
    const live = views.liveDecisionFor(change.scope);
    if (!live || live.id !== change.decisionId) return 'decision-not-found';
  }
  const { after, replaced } = decisionsAfter(views, change);
  // Lines a decision of this scope can reach: every line of the product ref, or the one line.
  const reach = change.scope.kind === 'product'
    ? views.graph.lines.filter((entry) => entry.line.productRef === (change.scope as { ref: string }).ref)
    : scopeLines;
  const overrides = new Map<string, Rational | null>();
  const affected: unknown[] = [];
  let lots = 0;
  let units = 0;
  for (const entry of reach) {
    // Content is read on the line as stored, with the live bullion answers, never on its projection.
    const next = metalsResolveContent(entry.order.source, entry.raw, entry.order.digest, after, views.graph.bullionDecisions);
    const before = entry.content.known ? `${formatRational(entry.content.troyOz)}:${entry.content.basis}` : `held:${entry.content.missing.join(',')}`;
    const now = next.content.known ? `${formatRational(next.content.troyOz)}:${next.content.basis}` : `held:${next.content.missing.join(',')}`;
    if (before === now) continue;
    affected.push([entry.key, entry.order.digest, before, now]);
    const fineBefore = entry.content.known ? formatRational(entry.content.troyOz) : null;
    const fineAfter = next.content.known ? formatRational(next.content.troyOz) : null;
    if (fineBefore !== fineAfter) {
      overrides.set(entry.key, next.content.known ? next.content.troyOz : null);
      lots += 1;
      units += entry.line.quantity;
    }
  }
  const changed = views.withFine(overrides);
  const holdingsBefore = views.holdings(metal, views.today).holdings.troyOz;
  const holdingsAfter = changed.holdings(metal, views.today).holdings.troyOz;
  const knownBefore = new Map(views.assignment(views.today).sales.map((line) => [line.key, line.known]));
  const saleLines = changed.assignment(views.today).sales.filter((line) => (knownBefore.get(line.key) ?? false) !== line.known).length;
  // Bound as well: each line the scope reaches with its version and quarantine (a conflicting capture leaves the active
  // digest as it was), and the reasons the preview shows, so a write after either changed is refused.
  const reached = reach.map((entry) => [entry.key, entry.order.digest, entry.order.quarantined])
    .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
  const measured = (measure: typeof holdingsBefore) => [measure.value?.exact ?? null, measure.state, measure.reasons.map((reason) => [reason.code, reason.records])];
  const digest = digestOf(['holdr.metals-content-preview', 2, change.action, change.scope, metal,
    change.action === 'confirm' ? formatRational(change.troyOzPerUnit) : change.decisionId, replaced?.id ?? null,
    affected.sort((a, b) => ((a as string[])[0] < (b as string[])[0] ? -1 : 1)), reached, views.today,
    measured(holdingsBefore), measured(holdingsAfter), saleLines]);
  return { digest, lots, units, holdingsTroyOz: { before: holdingsBefore, after: holdingsAfter }, saleLines };
}

/** A new decision id: `mtl-dec-` and 32 letters a–p from 16 random bytes. */
function newDecisionId(): string {
  return `mtl-dec-${toLetterHex(randomBytes(16))}`;
}

export class MetalsPreviewStale extends Error {
  constructor() {
    super('preview-stale');
    this.name = 'MetalsPreviewStale';
  }
}

export class MetalsContentNotFound extends Error {
  constructor(readonly refusal: MetalsContentRefusal) {
    super(refusal);
    this.name = 'MetalsContentNotFound';
  }
}

interface WriteContext {
  db: Database;
  repo: MetalsCardRows;
  /** Today in New York. */
  today: string;
  /** The write's instant (ISO, milliseconds, Z). */
  at: string;
  actorRef: string;
  previewDigest: string;
  /** The owner's assignment policy (`HOLDR_METALS_FUNGIBLE`) the reads apply: the preview is recomputed with it. */
  fungible?: readonly Metal[];
}

/** Recomputes the preview from the database inside the write transaction: the views a change is judged on. */
function freshViews(context: WriteContext): MetalsViews {
  const graph: MetalsLedgerGraph = buildMetalsLedgerGraph(readMetalsLedgerInputs(context.db, context.repo, { links: false }));
  return new MetalsViews({ graph, today: context.today, screen: () => ({ admissible: [], levelShifts: [] }), fetching: false,
    fungible: context.fungible });
}

/**
 * Every decision write's own checks, inside its IMMEDIATE transaction: the schema is exactly this build's (`present`: no
 * quarantine marker, no other shape) and the ledger holds no correction this build can't read.
 */
function requireWritableLedger(db: Database): void {
  if (metalsSchemaState(db) !== 'present') throw new MetalsSchemaClosed();
  if (metalsCorrectionPresent(db)) throw new MetalsCorrectionUnsupported();
}

/**
 * G2's protected-table rule for every decision writer: it gives each row its rowid itself, inside its fence (its
 * IMMEDIATE transaction): the largest so far plus one, positive, and checked free before the insert.
 */
function decisionRowids(db: Database): () => number {
  const next = db.prepare('SELECT coalesce(max(rowid), 0) + 1 FROM metals_owner_decisions').pluck();
  const taken = db.prepare('SELECT 1 FROM metals_owner_decisions WHERE rowid = ?').pluck();
  return () => {
    const rowid = next.get() as number;
    if (!Number.isSafeInteger(rowid) || rowid < 1 || taken.get(rowid) !== undefined) throw new Error('metals: no free decision rowid');
    return rowid;
  };
}

/**
 * Writes a previewed change in one IMMEDIATE transaction: the preview is recomputed from the database and must have
 * the digest the owner saw, else nothing is written (`MetalsPreviewStale`). A confirmation revokes the scope's live
 * decision and inserts the new one; a revocation revokes the decision. A schema that isn't `present` (a quarantine
 * marker, another shape) or a correction this build can't read, found inside the transaction, writes nothing
 * (`MetalsSchemaClosed`, `MetalsCorrectionUnsupported`).
 */
export function writeMetalsContentChange(
  context: WriteContext,
  change: MetalsContentChange,
  metal: Metal,
): { decision: MetalsProductDecision } | { revoked: { id: string; revokedAt: string } } {
  const revoke = context.db.prepare(`UPDATE metals_owner_decisions SET revoked_at = ?, revoked_by = ?
    WHERE decision_id = ? AND kind = 'product-content' AND revoked_at IS NULL`);
  const insert = context.db.prepare(`INSERT INTO metals_owner_decisions (rowid, decision_id, kind, scope, product_ref, fingerprint, lot_key,
      evidence_digest, metal, troy_oz_per_unit, preview_digest, decided_at, decided_by)
    VALUES (?, ?, 'product-content', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const allocateRowid = decisionRowids(context.db);
  return context.db.transaction(() => {
    requireWritableLedger(context.db);
    const views = freshViews(context);
    const preview = metalsContentPreview(views, change, metal);
    if (typeof preview === 'string') throw new MetalsContentNotFound(preview);
    if (preview.digest !== context.previewDigest) throw new MetalsPreviewStale();
    const live = views.liveDecisionFor(change.scope);
    if (change.action === 'revoke') {
      if (revoke.run(context.at, context.actorRef, change.decisionId).changes !== 1) throw new MetalsContentNotFound('decision-not-found');
      return { revoked: { id: change.decisionId, revokedAt: context.at } };
    }
    if (live) revoke.run(context.at, context.actorRef, live.id);
    const id = newDecisionId();
    const troyOzPerUnit = formatRational(change.troyOzPerUnit);
    if (change.scope.kind === 'product') {
      insert.run(allocateRowid(), id, 'product', change.scope.ref, change.scope.fingerprint, null, null, change.metal, troyOzPerUnit, preview.digest,
        context.at, context.actorRef);
    } else {
      const evidenceDigest = views.graph.lineByKey.get(change.scope.lotKey)!.order.digest;
      insert.run(allocateRowid(), id, 'lot', null, null, change.scope.lotKey, evidenceDigest, change.metal, troyOzPerUnit, preview.digest, context.at,
        context.actorRef);
    }
    return { decision: { id, metal: change.metal, troyOzPerUnit: metalsTroyOz(change.troyOzPerUnit), decidedAt: context.at } };
  }).immediate();
}

// ---------------------------------------------------------------------------
// The owner's bullion answers (contract follow-up 1 §4; G3-dec)
// ---------------------------------------------------------------------------

/** An answer for a scope, or the revocation of the scope's live answer. */
export type MetalsBullionChange =
  | { action: 'answer'; scope: MetalsBullionScope; answer: MetalsBullionAnswer }
  | { action: 'revoke'; scope: MetalsBullionScope; decisionId: string };

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The live answer of exactly a scope's key: its ref and fingerprint, or its lot. */
export function metalsLiveBullionAnswer(graph: MetalsLedgerGraph, scope: MetalsBullionScope): MetalsBullionDecisionInput | null {
  return graph.bullionDecisions.find((decision) => (scope.kind === 'product'
    ? decision.scope === 'product' && decision.productRef === scope.ref && decision.fingerprint === scope.fingerprint
    : decision.scope === 'lot' && decision.lotKey === scope.lotKey)) ?? null;
}

/**
 * The flagged lines an answer of the scope is written for: every flagged line of that ref and fingerprint (its product
 * scope, in any order or account), or the one flagged line with no ref that is the lot.
 */
export function metalsBullionScopeLines(graph: MetalsLedgerGraph, scope: MetalsBullionScope): MetalsFlaggedLine[] {
  return graph.flagged.filter((entry) => (scope.kind === 'product'
    ? entry.scope.kind === 'product' && entry.scope.ref === scope.ref && entry.scope.fingerprint === scope.fingerprint
    : entry.scope.kind === 'lot' && entry.scope.lotKey === scope.lotKey));
}

/** Where a flagged line stands, as /metals/answers says it. */
const standingOf = (entry: MetalsFlaggedLine) => entry.answer ?? (entry.drift ? 'drift' : 'needs-your-answer');

/** The views a bullion preview reads, on every path alike: no prices, since none of its figures depends on one. */
const unpricedViews = (graph: MetalsLedgerGraph, today: string, fungible?: readonly Metal[]) =>
  new MetalsViews({ graph, today, screen: () => ({ admissible: [], levelShifts: [] }), fetching: false, fungible });

function bullionFigures(views: MetalsViews, metal: Metal): MetalsBullionFigures {
  const { holdings } = views.holdings(metal, views.today);
  const activity = views.activity(metal, { from: null, to: views.today });
  return {
    lots: views.lines(metal, 'buy').length,
    saleLines: views.lines(metal, 'sell').length,
    holdingsTroyOz: holdings.troyOz,
    holdingsCostMinor: holdings.costMinor,
    boughtCostMinor: activity.bought.costMinor,
    soldNetMinor: activity.sold.netMinor,
  };
}

/** How each card subject (a buy's tender) links, and each payout's deposit: state, row and proof, by its key. */
const cardLinkStates = (graph: MetalsLedgerGraph) => new Map(graph.cardGraph.links.map((link) => [link.subject,
  `${link.state}|${link.rowId ?? ''}|${String(link.proof)}`]));
const depositStates = (graph: MetalsLedgerGraph) => new Map([...graph.depositLinks].map(([payoutKey, link]) => [payoutKey,
  `${link.state}|${link.rowId ?? ''}|${String(link.proof)}`]));

/** The keys whose value differs, a key on one side only included, sorted, with both values. */
function changedKeys(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): Array<[string, string | null, string | null]> {
  return [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).sort(compareText)
    .map((key) => [key, before.get(key) ?? null, after.get(key) ?? null]);
}

/**
 * What an answer or a revocation would do, or why it can't be previewed. The graph is rebuilt WHOLE from the same inputs
 * with the answers as they would be (`metalsLedgerGraphWith`; a new answer replaces the live one of exactly its own
 * scope), and compared with the graph as it is: the flagged lines whose state moves, the orders they belong to, every
 * metal's figures that change, and the card links and deposits that change. `today` (New York) is the day holdings are
 * measured. Deterministic in the ledger, the answers, the change and the day; `fungible` is the owner's assignment policy
 * the reads apply (`HOLDR_METALS_FUNGIBLE`; none: metals-assignment-v1).
 */
export function metalsBullionPreview(graph: MetalsLedgerGraph, today: string, change: MetalsBullionChange,
  fungible?: readonly Metal[]): MetalsBullionPreview | MetalsContentRefusal {
  const live = metalsLiveBullionAnswer(graph, change.scope);
  let after: MetalsBullionDecisionInput[];
  if (change.action === 'revoke') {
    if (live === null || live.id !== change.decisionId) return 'decision-not-found';
    after = graph.bullionDecisions.filter((decision) => decision !== live);
  } else {
    const lines = metalsBullionScopeLines(graph, change.scope);
    if (lines.length === 0) return 'scope-not-found';
    const decision: MetalsBullionDecisionInput = change.scope.kind === 'product'
      ? { id: PREVIEW_ID, scope: 'product', productRef: change.scope.ref, fingerprint: change.scope.fingerprint, lotKey: null, evidenceDigest: null,
        answer: change.answer, decidedAt: '' }
      : { id: PREVIEW_ID, scope: 'lot', productRef: null, fingerprint: null, lotKey: change.scope.lotKey, evidenceDigest: lines[0].order.digest,
        answer: change.answer, decidedAt: '' };
    after = [...graph.bullionDecisions.filter((entry) => entry !== live), decision];
  }
  const next = metalsLedgerGraphWith(graph, after);
  // The flagged lines the change can move: every one of the ref (an answer for one fingerprint makes the ref's lines of
  // another fingerprint drift), or the lot's one line, whatever its scope (a stray lot answer governs it first).
  const reached = graph.flagged.filter((entry) => (change.scope.kind === 'product' ? entry.line.productRef === change.scope.ref
    : entry.key === change.scope.lotKey)).sort((a, b) => compareText(a.key, b.key));
  const moved = reached.filter((entry) => standingOf(entry) !== standingOf(next.flaggedByKey.get(entry.key)!));
  const orderKeys = [...new Set(reached.map((entry) => entry.order.order.key))];
  const orderCounts = (built: MetalsLedgerGraph): MetalsBullionOrderCounts => {
    const counts = { held: 0, counted: 0, left: 0 };
    for (const key of orderKeys) {
      const order = built.orders.get(key)!;
      if (order.heldForMetals) counts.held += 1;
      else if (order.leftLedger) counts.left += 1;
      else counts.counted += 1;
    }
    return counts;
  };
  const beforeViews = unpricedViews(graph, today, fungible);
  const afterViews = unpricedViews(next, today, fungible);
  const metals = METALS.map((metal) => ({ metal, before: bullionFigures(beforeViews, metal), after: bullionFigures(afterViews, metal) }))
    .filter((entry) => JSON.stringify(entry.before) !== JSON.stringify(entry.after));
  const unknownOf = (built: MetalsLedgerGraph) => ({
    lots: built.lines.filter((entry) => entry.side === 'buy' && entry.line.metal === null).length,
    saleLines: built.lines.filter((entry) => entry.side === 'sell' && entry.line.metal === null).length,
  });
  const cardLinks = changedKeys(cardLinkStates(graph), cardLinkStates(next));
  const deposits = changedKeys(depositStates(graph), depositStates(next));
  const shown = {
    lines: moved.length,
    units: moved.reduce((total, entry) => total + entry.line.quantity, 0),
    orders: { before: orderCounts(graph), after: orderCounts(next) },
    metals,
    metalUnknown: { before: unknownOf(graph), after: unknownOf(next) },
    cardLinks: cardLinks.length,
    deposits: deposits.length,
  };
  // Bound as well: each flagged line reached with its order, the order's version and quarantine (a conflicting capture
  // leaves the active digest as it was) and how it reads before and after, and every link it changes, so a write after
  // any of them changed is refused.
  const evidence = reached.map((entry) => [entry.key, entry.order.order.key, entry.order.digest, entry.order.quarantined, standingOf(entry),
    standingOf(next.flaggedByKey.get(entry.key)!)]);
  const digest = digestOf(['holdr.metals-bullion-preview', 1, change.action, change.scope,
    change.action === 'answer' ? change.answer : change.decisionId, live?.id ?? null, evidence, today, shown, cardLinks, deposits]);
  return { digest, ...shown };
}

/**
 * Writes a previewed answer or revocation in one IMMEDIATE transaction, as the content writer does: the schema must be
 * `present` and hold no correction this build can't read, and the preview, recomputed from the database with card and
 * checking rows (an answer changes card links and deposits), must have the digest the owner saw, else nothing is written
 * (`MetalsSchemaClosed`, `MetalsCorrectionUnsupported`, `MetalsPreviewStale`). An answer revokes the live answer of
 * exactly its scope and inserts its own, kind `bullion`, with the next rowid; a revocation revokes the one answer.
 */
export function writeMetalsBullionChange(
  context: WriteContext,
  change: MetalsBullionChange,
): { decision: MetalsBullionDecision } | { revoked: { id: string; revokedAt: string } } {
  const revoke = context.db.prepare(`UPDATE metals_owner_decisions SET revoked_at = ?, revoked_by = ?
    WHERE decision_id = ? AND kind = 'bullion' AND revoked_at IS NULL`);
  const insert = context.db.prepare(`INSERT INTO metals_owner_decisions (rowid, decision_id, kind, scope, product_ref, fingerprint, lot_key,
      evidence_digest, answer, preview_digest, decided_at, decided_by)
    VALUES (?, ?, 'bullion', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const allocateRowid = decisionRowids(context.db);
  return context.db.transaction(() => {
    requireWritableLedger(context.db);
    const graph = buildMetalsLedgerGraph(readMetalsLedgerInputs(context.db, context.repo, { links: true }));
    const shown = metalsBullionPreview(graph, context.today, change, context.fungible);
    if (typeof shown === 'string') throw new MetalsContentNotFound(shown);
    if (shown.digest !== context.previewDigest) throw new MetalsPreviewStale();
    if (change.action === 'revoke') {
      if (revoke.run(context.at, context.actorRef, change.decisionId).changes !== 1) throw new MetalsContentNotFound('decision-not-found');
      return { revoked: { id: change.decisionId, revokedAt: context.at } };
    }
    const live = metalsLiveBullionAnswer(graph, change.scope);
    if (live !== null && revoke.run(context.at, context.actorRef, live.id).changes !== 1) throw new MetalsContentNotFound('decision-not-found');
    const id = newDecisionId();
    if (change.scope.kind === 'product') {
      insert.run(allocateRowid(), id, 'product', change.scope.ref, change.scope.fingerprint, null, null, change.answer, shown.digest, context.at,
        context.actorRef);
      return { decision: { id, answer: change.answer, scope: { ...change.scope }, decidedAt: context.at } };
    }
    const evidenceDigest = metalsBullionScopeLines(graph, change.scope)[0].order.digest;
    insert.run(allocateRowid(), id, 'lot', null, null, change.scope.lotKey, evidenceDigest, change.answer, shown.digest, context.at, context.actorRef);
    return { decision: { id, answer: change.answer, scope: { kind: 'lot' as const, lotKey: change.scope.lotKey, evidenceDigest }, decidedAt: context.at } };
  }).immediate();
}
