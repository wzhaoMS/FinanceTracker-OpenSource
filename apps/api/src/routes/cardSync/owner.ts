import { Router, type Request, type RequestHandler, type Response } from 'express';
import { isCardSyncDigest, isCardSyncId } from '@finance-tracker/shared';

import { sendRefusal } from '../../ingress/securityHeaders.js';
import { REVIEW_DECISION_ACTIONS } from '../../services/cardLedger/classify.js';
import { cardSyncRefusalCode } from '../../services/cardSync/refusals.js';
import { CARD_SYNC_DISCARD_REASONS, type CardSyncDiscardReason } from '../../services/cardSync/review.js';
import type { OwnerSourcesContinuation, OwnerSourcesNext } from '../../services/cardSync/owner.js';
import type { OwnerTransactionSources } from '../../services/cardSync/ownerViews.js';
import { cardSyncActorRef } from '../../services/cardSyncDigests.js';
import type { SqliteStateRepo } from '../../services/sqliteStateRepo.js';
import { registerCardSyncAuthorizationRoutes, type CardSyncAuthorizationDeps } from './authorization.js';
import type { CardSyncCursorCodec } from './cursor.js';
import {
  arrayOf, boolean, cardSyncErrors, integer, invalidRequest, matching, notFound, nullable, object, oneOf, ownerBody, ownerError, pathId,
  readBody, readQuery, refusedCursor, versionConflict, type Check,
} from './http.js';

/**
 * Card sync's HTTP routes, mounted at `/card-sync` behind sign-in
 * (identify → csrfGuard → requireAuth, as card spending is). E2a serves the
 * owner routes that need only the repository (E1b design §10 items 4, 10,
 * 14, 17–21, 24; the E8-M owner API):
 *
 *   GET  /owner/observation-sets?view=open|closed[&cursor=]          → { observationSets, nextCursor }
 *   GET  /owner/observation-sets/:observationSetId[?itemsCursor=]    → SetDetail (refreshed first, §10 item 4)
 *   POST /owner/observation-sets/:observationSetId/decisions         → SetDetail (first page)
 *   POST /owner/observation-sets/:observationSetId/plan              → Plan (first page of effects)
 *   POST /owner/observation-sets/:observationSetId/discard           → SetSummary
 *   GET  /owner/plans/:previewId/effects?cursor=                     → EffectPage
 *   POST /owner/plans/:previewId/commit                              → CommitResult
 *   GET  /owner/runs[?bindingId=&cursor=]                            → { runs, nextCursor }
 *   GET  /owner/runs/:runId                                          → RunDetail
 *   GET  /owner/runs/:runId/payload                                  → SentPayload
 *   GET  /owner/transactions/:transactionId/sources[?eventsCursor=|identitiesCursor=|mergedRowsCursor=]
 *   POST /owner/identities/:identityId/detach        (recent auth)  → TransactionSources
 *   POST /owner/identities/:identityId/repoint       (recent auth)  → TransactionSources (of the row the alias left)
 *   POST /owner/transactions/:transactionId/revert   (recent auth)  → TransactionSources
 *   POST /owner/transactions/:transactionId/unmerge  (recent auth)  → TransactionSources
 *
 * Every owner route is for the signed-in session only: the service token
 * gets 403 `credential-not-allowed` (Q44), and device credentials never get
 * this far (identify refuses any bearer but the service token). No CORS
 * header is ever sent. Device routes are not mounted: E2c adds them behind
 * E0-I PR D's `DeviceAdmission`. Errors are value-free (http.ts).
 */

/**
 * The authorization generation E2's external gate holds (E1b §10 item 2),
 * which an extension set's plan and commit pin; null while the gate is
 * blocked. E0-I PR B brings the gate (E2b); until then createApp passes
 * CARD_SYNC_GATE_NOT_WIRED, so extension sets answer `authorization-blocked`
 * (none can be accepted before E2c's device routes anyway). File sets and
 * the ledger repairs never consult it (§10 items 10 and 14).
 */
export interface CardSyncAuthorizationGate {
  generationForSourceChecks(): string | null;
}

export const CARD_SYNC_GATE_NOT_WIRED: CardSyncAuthorizationGate = Object.freeze({ generationForSourceChecks: () => null });

export interface CardSyncRouteDeps {
  repo: SqliteStateRepo;
  /** login's recent-auth check (POST /auth/reverify within the last 5 minutes), for the ledger repairs (§10 item 14). */
  requireRecentAuth: RequestHandler;
  cursors: CardSyncCursorCodec;
  gate: CardSyncAuthorizationGate;
  /** E2b's authorization routes (authorization.ts), on this same owner router. */
  authorization: Omit<CardSyncAuthorizationDeps, 'repo' | 'requireRecentAuth' | 'cursors'>;
  /** Operational log: error types and refusal codes only. Defaults to console.error. */
  log?: (line: string) => void;
}

const SET_ID = /^obs_[a-p]{32}$/;
const PREVIEW_ID = /^prv_[a-p]{32}$/;
const RUN_ID = /^run_[a-p]{32}$/;
const BINDING_ID = /^bnd_[a-p]{32}$/;
const TRANSACTION_ID = /^card-txn-[a-p]{32}$/;
const IDENTITY_ID = /^card-ident-[a-p]{32}$/;
const EVENT_ID = /^card-event-[a-p]{32}$/;
const ITEM_ID = /^rvw_[a-p]{32}$/;
const MAX_VERSION = 2_147_483_647;

const version = integer(1, MAX_VERSION);
const id = (test: (value: string) => boolean): Check => (value, path, issues) => {
  if (typeof value !== 'string') {
    issues.add('wrong-type', path);
    return false;
  }
  if (test(value)) return true;
  issues.add('invalid-format', path);
  return false;
};

const DECISIONS = {
  expectedVersion: version,
  decisions: arrayOf(object({
    itemId: matching(ITEM_ID),
    action: oneOf(REVIEW_DECISION_ACTIONS),
    transactionId: nullable(matching(TRANSACTION_ID)),
    cardScopeId: nullable(id((value) => isCardSyncId('cardScope', value))),
  }), 1, 200),
};
const DECISION_KEYS = ['itemId', 'action', 'transactionId', 'cardScopeId'];
const PLAN = { expectedVersion: version, sourceReviewed: boolean };
const COMMIT = {
  payloadDigest: nullable(id((value) => isCardSyncDigest('payload', value))),
  planDigest: id((value) => isCardSyncDigest('plan', value)),
};
const DISCARD = { expectedVersion: version, reason: oneOf(CARD_SYNC_DISCARD_REASONS) };
const DETACH = { transactionId: matching(TRANSACTION_ID), expectedRevision: version };
const REPOINT = {
  fromTransactionId: matching(TRANSACTION_ID), toTransactionId: matching(TRANSACTION_ID), expectedRevision: version,
  expectedToRevision: version,
};
const REVERT = { eventId: matching(EVENT_ID), expectedRevision: version };
const UNMERGE = { expectedRevision: version, expectedSurvivorRevision: version };

interface DecisionsBody {
  expectedVersion: number;
  decisions: Array<{ itemId: string; action: (typeof REVIEW_DECISION_ACTIONS)[number]; transactionId: string | null; cardScopeId: string | null }>;
}

/** Owner routes: the signed-in session only (Q44, §5.11 `principal-not-allowed`). */
const sessionOnly: RequestHandler = (req, _res, next) => {
  next(req.holdrAuth?.kind === 'session' ? undefined : ownerError(403, 'credential-not-allowed'));
};

/** The owner as the card ledger names actors (`usr_…`, never the user id itself). */
function actorOf(req: Request): string {
  const auth = req.holdrAuth;
  if (auth?.kind !== 'session') throw ownerError(403, 'credential-not-allowed');
  return cardSyncActorRef(auth.userId);
}

/** Mount at /card-sync/owner, never at a device prefix. The outer router retains the existing error/OPTIONS boundary. */
export function createCardSyncOwnerRouter(deps: CardSyncRouteDeps): Router {
  if (!deps?.repo || typeof deps.requireRecentAuth !== 'function' || !deps.cursors || !deps.gate) {
    throw new Error('card sync routes need a repository, a recent-auth check, a cursor codec and an authorization gate');
  }
  const { repo, cursors, gate, requireRecentAuth } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));

  /**
   * §5.11 for a set: a moved version or page pin is 409 `version-conflict`
   * with the set's current version; `review-stale` refreshes the set first
   * (§10 item 4: the UI refetches, E2 refreshes) and answers its new version.
   */
  function withSetVersion<T>(setId: string, run: () => T): T {
    try {
      return run();
    } catch (error) {
      const code = cardSyncRefusalCode(error);
      if (code === 'review-stale') throw versionConflict(repo.refreshCardReviewItems({ setId }).version);
      if (code === 'version-conflict' || code === 'page-stale') {
        const current = repo.getCardSyncOwnerSetVersion(setId);
        if (current !== null) throw versionConflict(current);
      }
      throw error;
    }
  }

  function decoded<K extends Parameters<CardSyncCursorCodec['decode']>[0]>(
    kind: K, resource: string, param: string, cursor: string | undefined,
  ): ReturnType<CardSyncCursorCodec['decode']> | null {
    if (cursor === undefined) return null;
    const values = cursors.decode(kind, resource, cursor);
    if (values === null) throw refusedCursor(param);
    return values;
  }

  const sourcesAnswer = (transactionId: string, result: { sources: OwnerTransactionSources; next: OwnerSourcesNext }) => ({
    transaction: result.sources.transaction,
    identities: result.sources.identities,
    nextIdentitiesCursor: result.next.identities ? cursors.encode('identities', transactionId, result.next.identities) : null,
    mergedRows: result.sources.mergedRows,
    nextMergedRowsCursor: result.next.merged ? cursors.encode('merged', transactionId, result.next.merged) : null,
    revertibleEventId: result.sources.revertibleEventId,
    events: result.sources.events,
    nextEventsCursor: result.next.events ? cursors.encode('events', transactionId, result.next.events) : null,
  });

  const owner = Router();
  owner.use(sessionOnly);

  owner.get('/observation-sets', (req: Request, res: Response) => {
    const query = readQuery(req, ['view', 'cursor']);
    const view = query.view;
    if (view !== 'open' && view !== 'closed') {
      throw invalidRequest([{ code: view === undefined ? 'missing-key' : 'invalid-enum', path: '$.view' }]);
    }
    const after = decoded('sets', view, 'cursor', query.cursor) as { acceptedAt: string; setId: string } | null;
    const { sets, next } = repo.listCardSyncOwnerSets({ view, after, actorRef: actorOf(req) });
    res.json({ observationSets: sets, nextCursor: next ? cursors.encode('sets', view, next) : null });
  });

  owner.get('/observation-sets/:observationSetId', (req: Request, res: Response) => {
    const setId = pathId(req, 'observationSetId', SET_ID);
    const { itemsCursor } = readQuery(req, ['itemsCursor']);
    const after = decoded('items', setId, 'itemsCursor', itemsCursor) as
      { version: number; ledgerRevision: number; pastDeadline: boolean; itemKey: number } | null;
    const page = withSetVersion(setId, () => repo.getCardSyncOwnerSet({ setId, after, actorRef: actorOf(req) }));
    if (!page) throw notFound();
    res.json({ ...page.detail, nextItemsCursor: page.next ? cursors.encode('items', setId, page.next) : null });
  });

  owner.post('/observation-sets/:observationSetId/decisions', ...ownerBody(), (req: Request, res: Response) => {
    const setId = pathId(req, 'observationSetId', SET_ID);
    const body = readBody<DecisionsBody>(req, DECISIONS, DECISION_KEYS);
    const page = withSetVersion(setId, () => repo.recordCardSyncOwnerDecisions({
      setId, expectedVersion: body.expectedVersion, actorRef: actorOf(req),
      decisions: body.decisions.map(({ itemId, action, transactionId, cardScopeId }) => ({ itemId, action, transactionId, cardScopeId })),
    }));
    res.json({ ...page.detail, nextItemsCursor: page.next ? cursors.encode('items', setId, page.next) : null });
  });

  owner.post('/observation-sets/:observationSetId/plan', ...ownerBody(), (req: Request, res: Response) => {
    const setId = pathId(req, 'observationSetId', SET_ID);
    const body = readBody<{ expectedVersion: number; sourceReviewed: boolean }>(req, PLAN);
    const prepared = withSetVersion(setId, () => repo.prepareCardSyncOwnerPlan({
      setId, expectedVersion: body.expectedVersion, sourceReviewed: body.sourceReviewed, actorRef: actorOf(req),
      expectedGeneration: gate.generationForSourceChecks(),
    }));
    res.json({
      ...prepared.plan,
      nextEffectsCursor: prepared.nextAfterOrdinal === null ? null
        : cursors.encode('effects', prepared.plan.previewId, { afterOrdinal: prepared.nextAfterOrdinal }),
    });
  });

  owner.post('/observation-sets/:observationSetId/discard', ...ownerBody(), (req: Request, res: Response) => {
    const setId = pathId(req, 'observationSetId', SET_ID);
    const body = readBody<{ expectedVersion: number; reason: CardSyncDiscardReason }>(req, DISCARD);
    res.json(withSetVersion(setId, () => repo.discardCardSyncOwnerSet({
      setId, expectedVersion: body.expectedVersion, reason: body.reason, actorRef: actorOf(req),
    })));
  });

  owner.get('/plans/:previewId/effects', (req: Request, res: Response) => {
    const previewId = pathId(req, 'previewId', PREVIEW_ID);
    const { cursor } = readQuery(req, ['cursor']);
    const after = decoded('effects', previewId, 'cursor', cursor) as { afterOrdinal: number } | null;
    const result = repo.getCardSyncOwnerPlanEffects({ previewId, afterOrdinal: after?.afterOrdinal ?? -1, actorRef: actorOf(req) });
    if (!result) throw notFound();
    // §5.6: past its deadline a plan's effects are 410 `plan-expired` whatever its state (the repository refuses in its
    // read); until then a committed or superseded plan answers with its state (X42).
    res.json({
      ...result.page,
      nextCursor: result.nextAfterOrdinal === null ? null : cursors.encode('effects', previewId, { afterOrdinal: result.nextAfterOrdinal }),
    });
  });

  owner.post('/plans/:previewId/commit', ...ownerBody(), (req: Request, res: Response) => {
    const previewId = pathId(req, 'previewId', PREVIEW_ID);
    const body = readBody<{ payloadDigest: string | null; planDigest: string }>(req, COMMIT);
    res.json(repo.commitCardSyncOwnerPlan({
      previewId, payloadDigest: body.payloadDigest, planDigest: body.planDigest, actorRef: actorOf(req),
      expectedGeneration: gate.generationForSourceChecks(),
    }));
  });

  owner.get('/runs', (req: Request, res: Response) => {
    const query = readQuery(req, ['bindingId', 'cursor']);
    const bindingId = query.bindingId ?? null;
    if (bindingId !== null && !BINDING_ID.test(bindingId)) throw invalidRequest([{ code: 'invalid-format', path: '$.bindingId' }]);
    // A run list's cursor is bound to its filter: another binding's walk starts over.
    const resource = bindingId ?? '*';
    const after = decoded('runs', resource, 'cursor', query.cursor) as { createdAt: string; runId: string } | null;
    actorOf(req);
    const { runs, next } = repo.listCardSyncOwnerRuns({ bindingId, after });
    res.json({ runs, nextCursor: next ? cursors.encode('runs', resource, next) : null });
  });

  owner.get('/runs/:runId', (req: Request, res: Response) => {
    const runId = pathId(req, 'runId', RUN_ID);
    readQuery(req, []);
    const run = repo.getCardSyncOwnerRun(runId);
    if (!run) throw notFound();
    res.json(run);
  });

  owner.get('/runs/:runId/payload', (req: Request, res: Response) => {
    const runId = pathId(req, 'runId', RUN_ID);
    readQuery(req, []);
    const sent = repo.getCardSyncOwnerRunPayload(runId);
    if (!sent) throw notFound();
    // The stored canonical bytes go out exactly as received, inside the envelope, never parsed and re-serialized.
    const envelope = JSON.stringify({
      runId: sent.runId, observationSetId: sent.observationSetId, payloadDigest: sent.payloadDigest, acceptedAt: sent.acceptedAt,
      receiptExpiresAt: sent.receiptExpiresAt,
    });
    res.type('application/json').send(`${envelope.slice(0, -1)},"payload":${sent.canonicalJson}}`);
  });

  owner.get('/transactions/:transactionId/sources', (req: Request, res: Response) => {
    const transactionId = pathId(req, 'transactionId', TRANSACTION_ID);
    const query = readQuery(req, ['eventsCursor', 'identitiesCursor', 'mergedRowsCursor']);
    const given = Object.keys(query);
    // One list continues per request; the others come as their first page.
    if (given.length > 1) throw invalidRequest(given.map((key) => ({ code: 'inconsistent' as const, path: `$.${key}` })));
    let from: OwnerSourcesContinuation = null;
    if (query.eventsCursor !== undefined) {
      from = { events: decoded('events', transactionId, 'eventsCursor', query.eventsCursor) as { createdAt: string; eventId: string } };
    } else if (query.identitiesCursor !== undefined) {
      from = { identities: decoded('identities', transactionId, 'identitiesCursor', query.identitiesCursor) as
        { createdAt: string; identityId: string } };
    } else if (query.mergedRowsCursor !== undefined) {
      from = { merged: decoded('merged', transactionId, 'mergedRowsCursor', query.mergedRowsCursor) as
        { removedAt: string; transactionId: string } };
    }
    actorOf(req);
    const result = repo.getCardSyncOwnerSources({ transactionId, continue: from });
    if (!result) throw ownerError(404, 'transaction-not-found');
    res.json(sourcesAnswer(transactionId, result));
  });

  // The ledger repairs (§5.7.1; §10 items 14, 18, 24): session only, recent auth, never device or sync state; neither a
  // pause nor a blocked gate stops them.
  owner.post('/identities/:identityId/detach', requireRecentAuth, ...ownerBody(), (req: Request, res: Response) => {
    const identityId = pathId(req, 'identityId', IDENTITY_ID);
    const body = readBody<{ transactionId: string; expectedRevision: number }>(req, DETACH);
    res.json(sourcesAnswer(body.transactionId, repo.detachCardSyncOwnerIdentity({
      identityId, transactionId: body.transactionId, expectedRevision: body.expectedRevision, actorRef: actorOf(req),
    })));
  });

  owner.post('/identities/:identityId/repoint', requireRecentAuth, ...ownerBody(), (req: Request, res: Response) => {
    const identityId = pathId(req, 'identityId', IDENTITY_ID);
    const body = readBody<{ fromTransactionId: string; toTransactionId: string; expectedRevision: number; expectedToRevision: number }>(
      req, REPOINT);
    res.json(sourcesAnswer(body.fromTransactionId, repo.repointCardSyncOwnerIdentity({
      identityId, fromTransactionId: body.fromTransactionId, toTransactionId: body.toTransactionId,
      expectedRevision: body.expectedRevision, expectedToRevision: body.expectedToRevision, actorRef: actorOf(req),
    })));
  });

  owner.post('/transactions/:transactionId/revert', requireRecentAuth, ...ownerBody(), (req: Request, res: Response) => {
    const transactionId = pathId(req, 'transactionId', TRANSACTION_ID);
    const body = readBody<{ eventId: string; expectedRevision: number }>(req, REVERT);
    res.json(sourcesAnswer(transactionId, repo.revertCardSyncOwnerChange({
      transactionId, eventId: body.eventId, expectedRevision: body.expectedRevision, actorRef: actorOf(req),
    })));
  });

  owner.post('/transactions/:transactionId/unmerge', requireRecentAuth, ...ownerBody(), (req: Request, res: Response) => {
    const transactionId = pathId(req, 'transactionId', TRANSACTION_ID);
    const body = readBody<{ expectedRevision: number; expectedSurvivorRevision: number }>(req, UNMERGE);
    res.json(sourcesAnswer(transactionId, repo.unmergeCardSyncOwnerTransaction({
      transactionId, expectedRevision: body.expectedRevision, expectedSurvivorRevision: body.expectedSurvivorRevision,
      actorRef: actorOf(req),
    })));
  });

  // E2b: pause, issuers, bindings, auto-sync, pairing, devices and the state, under the same session-only rule.
  registerCardSyncAuthorizationRoutes(owner, { ...deps.authorization, repo, requireRecentAuth, cursors: deps.cursors });

  const router = Router();
  router.use(owner);
  router.use((req, res) => sendRefusal(req, res, 404, 'not-found'));
  // Last, after every card sync router: their errors end here, value-free, and never reach the app's handler.
  router.use(cardSyncErrors(log));
  return router;
}

/** Compatibility container for /card-sync callers; the actual app uses the explicitly owner-scoped factory above. */
export function createCardSyncRouter(deps: CardSyncRouteDeps): Router {
  const router = Router();
  router.use('/owner', createCardSyncOwnerRouter(deps));
  router.use((req, res) => sendRefusal(req, res, 404, 'not-found'));
  router.use(cardSyncErrors(deps.log ?? ((line: string) => console.error(line))));
  return router;
}
