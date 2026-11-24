import type { Request, RequestHandler, Response, Router } from 'express';
import {
  CARD_SYNC_CONTRACT_VERSION, CARD_SYNC_ISSUERS, CARD_SYNC_SOURCES, CARD_SYNC_SOURCE_SPECS, CardSyncIssueList, cardSyncTextIssue,
  type CardSyncIssuer, type CardSyncSource,
} from '@finance-tracker/shared';

import { asyncRoute } from '../../asyncRoute.js';
import {
  isAuthorizationBlocked, type AuthorizationChangeKind, type CardSyncAuthorizationService, type GenerationReport, type GenerationStep,
} from '../../control/authorizationChange.js';
import { ControlError } from '../../control/errors.js';
import type { CardSyncHolderAlias } from '../../services/cardSync/bindings.js';
import { cardSyncRefusalCode } from '../../services/cardSync/refusals.js';
import { cardSyncActorRef, pairingCodeDigest, randomCardSyncLetters } from '../../services/cardSyncDigests.js';
import type { SqliteStateRepo } from '../../services/sqliteStateRepo.js';
import type { AuthorityKind, AuthorityMark } from '../../services/cardSync/ownerInventory.js';
import type { OwnerBinding } from '../../services/cardSync/ownerAuthorization.js';
import type { CardSyncCursorCodec } from './cursor.js';
import {
  OwnerHttpError, arrayOf, boolean, integer, invalidRequest, matching, notFound, nullable, object, oneOf, ownerBody, ownerError, pathId,
  readBody, readQuery, versionConflict, type Check,
} from './http.js';

/**
 * E2b: the owner routes that change who may send card data (the E8-M owner API §3.1–§3.4; E1b design §5.0–§5.3, §5.11,
 * §10 items 2, 9, 10, 12, 15, 16). They join E2a's `/card-sync/owner` router (`createCardSyncRouter` in owner.ts), so the
 * session-only rule, the 404 and the value-free error answers are E2a's:
 *
 *   GET  /owner/state                                   → State, or {extensionSync: 'not-configured'} where this Holdr has
 *                                                         no HTTPS ingress (no extension sync: a normal state, not a 404)
 *   POST /owner/pause                  {}                → Settings                       narrowing
 *   POST /owner/resume                 (recent auth)     → Settings                       widening
 *   POST /owner/issuers/:issuer/enable (recent auth)     → Settings                       widening
 *   POST /owner/issuers/:issuer/disable {}               → Settings                       narrowing
 *   POST /owner/bindings               (recent auth)     → 201 Binding                    widening
 *   POST /owner/bindings/:bindingId/confirm (recent auth) → Binding                      widening
 *   POST /owner/bindings/:bindingId/retire               → Binding                       narrowing
 *   POST /owner/bindings/:bindingId/auto-sync (recent auth only to switch on) → Binding  on widening, off narrowing
 *   POST /owner/pairings               (recent auth)     → 201 {pairing, pairingCode, holdrOrigin}  widening
 *   POST /owner/pairings/:pairingId/cancel               → Pairing                       narrowing
 *   POST /owner/pairings/:pairingId/approve (recent auth) → {pairing, device}            widening
 *   POST /owner/pairings/:pairingId/reject               → {pairing, device}             narrowing
 *   POST /owner/devices/:deviceId/revoke                 → Device                        narrowing
 *   POST /owner/devices/:deviceId/regrant (recent auth)  → Device                        widening
 *
 * Every change runs through E2's generation protocol (control/authorizationChange.ts): `authorization.lock`, the fence
 * written `blocked/change` first, the repository's compare-and-set, the fence opened again. While the gate is blocked,
 * widening changes answer 409 `authorization-blocked` and narrowing ones still apply (owner API rule 7). Pairing and
 * approval also need the device API (409 `device-api-disabled` until E2c serves it behind PR D's admission) and an HTTPS
 * origin. The pairing code exists only in the 201 that creates it: the database holds its digest, nothing logs it.
 */

export interface CardSyncAuthorizationDeps {
  repo: SqliteStateRepo;
  /** Recent authentication (POST /auth/reverify within five minutes), for the routes marked above. */
  requireRecentAuth: RequestHandler;
  /** The same check as a predicate, for auto-sync, which needs it only to switch on (owner API §3.3). */
  recentlyAuthenticated(req: Request): boolean;
  /** Original session/user/credential epoch, revalidated inside the host lock, after body reads and lock waits. */
  currentSession(req: Request): boolean;
  cursors: CardSyncCursorCodec;
  /** E2's generation protocol and the gate it keeps. */
  gate: CardSyncAuthorizationService;
  /** The one HTTPS origin devices pair with (`dist`'s public origin), or null: no extension sync here. */
  holdrOrigin: string | null;
  /** Whether the device API is served (E2c behind PR D's admission); `disabled` until then. */
  deviceApi: 'enabled' | 'disabled';
}

const BINDING_ID = /^bnd_[a-p]{32}$/;
const DEVICE_ID = /^dev_[a-p]{32}$/;
const PAIRING_ID = /^pai_[a-p]{32}$/;
const SCOPE_ID = /^scp_[a-p]{32}$/;
const CARD_ACCOUNT_REF = /^card-acct-[a-p]{32}$/;
/** The non-secret confirmation code as Holdr shows it: 16 letters a–p, plain or grouped by four with hyphens. */
const FINGERPRINT = /^[a-p]{4}-?[a-p]{4}-?[a-p]{4}-?[a-p]{4}$/;
const HOLDER_ALIASES: readonly CardSyncHolderAlias[] = ['alex', 'casey', 'joint', 'member-a'];
const MAX_VERSION = 2_147_483_647;

const version = integer(1, MAX_VERSION);
const revision = integer(0, MAX_VERSION);
/** Binding and card labels: 1–64 characters of canonical, redacted display text (owner API `LABEL`, E1b S2-D5). */
const label: Check = (value, path, issues) => {
  const issue = cardSyncTextIssue(value, 64);
  if (issue === null) return true;
  issues.add(issue, path);
  return false;
};
const literalTrue: Check = (value, path, issues) => {
  if (value === true) return true;
  issues.add(typeof value === 'boolean' ? 'invalid-enum' : 'wrong-type', path);
  return false;
};
const LAST4 = nullable(matching(/^[0-9]{4}$/));

const RESUME = { expectedVersion: version };
const ENABLE = { expectedVersion: version, riskAcknowledged: literalTrue, mainWorldAcknowledged: boolean };
const CREATE_BINDING = {
  issuer: oneOf(CARD_SYNC_ISSUERS), source: oneOf(CARD_SYNC_SOURCES), cardAccountRef: matching(CARD_ACCOUNT_REF), bindingLabel: label,
  scopes: arrayOf(object({ scopeLabel: label, holderAlias: oneOf(HOLDER_ALIASES), last4: LAST4 }), 1, 39),
};
const CONFIRM_BINDING = {
  expectedVersion: version, bindingLabel: label,
  scopes: arrayOf(object({ cardScopeId: nullable(matching(SCOPE_ID)), scopeLabel: label, holderAlias: oneOf(HOLDER_ALIASES), last4: LAST4 }), 0, 39),
  regrantDeviceIds: arrayOf(matching(DEVICE_ID), 0, 50),
};
const SCOPE_KEYS = ['cardScopeId', 'scopeLabel', 'holderAlias', 'last4'];
const RETIRE = { expectedVersion: version };
const AUTO_SYNC = { expectedVersion: version, expectedAutoSyncRevision: revision, enabled: boolean };
const CREATE_PAIRING = { bindingIds: arrayOf(matching(BINDING_ID), 1, 20), replacesDeviceId: nullable(matching(DEVICE_ID)) };
const APPROVE = { deviceId: matching(DEVICE_ID), fingerprint: matching(FINGERPRINT) };
const REJECT = { deviceId: matching(DEVICE_ID) };
const REGRANT = { bindingIds: arrayOf(matching(BINDING_ID), 1, 20) };

interface ScopeBody { scopeLabel: string; holderAlias: CardSyncHolderAlias; last4: string | null }

/** Each listed id at most once (owner API §3.3–§3.4: 422 otherwise), naming the later copies. */
function distinct(values: readonly (string | null)[], path: string): void {
  const issues = new CardSyncIssueList(20);
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (value === null) return;
    if (seen.has(value)) issues.add('duplicate', `${path}[${index}]`);
    seen.add(value);
  });
  if (issues.size > 0) throw invalidRequest(issues.list);
}

/** The owner as the card ledger names actors (`usr_…`); E2a's router lets only a signed-in session this far. */
function actorOf(req: Request): string {
  const auth = req.holdrAuth;
  if (auth?.kind !== 'session') throw ownerError(403, 'credential-not-allowed');
  return cardSyncActorRef(auth.userId);
}

const unavailable = () => new OwnerHttpError(503, { error: 'unavailable', retryAfterSeconds: 1 }, { 'Retry-After': '1' });

/** `GET /owner/state` where this Holdr has no extension sync (no HTTPS origin devices could pair with). */
const NO_EXTENSION_SYNC = Object.freeze({ extensionSync: 'not-configured' } as const);

export function registerCardSyncAuthorizationRoutes(owner: Router, deps: CardSyncAuthorizationDeps): void {
  if (!deps?.repo || !deps.gate || typeof deps.requireRecentAuth !== 'function' || typeof deps.recentlyAuthenticated !== 'function'
    || typeof deps.currentSession !== 'function') {
    throw new Error('card sync authorization routes need a repository, the gate and the recent-auth checks');
  }
  const { repo, gate, requireRecentAuth } = deps;
  const resource = (kind: AuthorityKind, generation: string, bindingId = '') => `${kind}/${bindingId}/${generation}`;
  const mark = (kind: AuthorityKind, page: AuthorityMark, bindingId = '') => ({
    total: page.total,
    nextCursor: page.next ? deps.cursors.encode('authority', resource(kind, page.next.generation, bindingId),
      { afterRowId: page.next.afterRowId }) : null,
  });
  const bindingAnswer = (binding: OwnerBinding) => ({
    ...binding,
    deviceInventory: { ...mark('binding-devices', binding.deviceInventory, binding.bindingId), active: binding.deviceInventory.active },
  });

  /**
   * One authorization change under the generation protocol. A blocked gate is 409 `authorization-blocked` (owner API rule 7);
   * a lock or fence that cannot be used now is 503 `unavailable`. Repository refusals pass on to E2a's error answers.
   */
  async function change<R extends GenerationReport>(req: Request, kind: AuthorizationChangeKind, call: (step: GenerationStep) => R): Promise<R> {
    try {
      return await gate.change(kind, (step) => {
        if (!deps.currentSession(req)) throw ownerError(401, 'unauthorized');
        if (kind === 'widening' && !deps.recentlyAuthenticated(req)) throw ownerError(403, 'recent-auth-required');
        return call(step);
      });
    } catch (error) {
      if (isAuthorizationBlocked(error)) throw ownerError(409, 'authorization-blocked');
      if (error instanceof ControlError) throw unavailable();
      throw error;
    }
  }

  /** `version-conflict` with the current version the owner must re-read (§5.11); `not-found` if the object is gone. */
  async function versioned<R>(run: () => Promise<R>, current: () => number | null): Promise<R> {
    try {
      return await run();
    } catch (error) {
      if (cardSyncRefusalCode(error) !== 'version-conflict') throw error;
      const now = current();
      throw now === null ? notFound() : versionConflict(now);
    }
  }
  const settingsVersion = () => repo.getCardSyncSettings().settingsVersion;
  const bindingVersion = (bindingId: string) => () => repo.getCardSyncOwnerBinding(bindingId)?.bindingVersion ?? null;

  /** Pairing and approval need the device API and the HTTPS origin devices pair with. */
  function requireDeviceApi(): string {
    if (deps.deviceApi !== 'enabled' || deps.holdrOrigin === null) throw ownerError(409, 'device-api-disabled');
    return deps.holdrOrigin;
  }

  const issuerOf = (req: Request): CardSyncIssuer => {
    const issuer: unknown = req.params.issuer;
    if (typeof issuer !== 'string' || !(CARD_SYNC_ISSUERS as readonly string[]).includes(issuer)) throw notFound();
    return issuer as CardSyncIssuer;
  };

  // ---- §3.1 state -------------------------------------------------------------------------------------------------------

  owner.get('/state', (req: Request, res: Response) => {
    readQuery(req, []);
    actorOf(req);
    // No HTTPS ingress, so no browser can pair: this Holdr has no extension sync (owner API §3.1). That is a state, not an
    // error, and the Spending pages ask on every load, so it is a plain answer instead of a 404 in every browser console.
    if (deps.holdrOrigin === null) {
      res.json(NO_EXTENSION_SYNC);
      return;
    }
    const parts = repo.getCardSyncOwnerState();
    res.json({
      generatedAt: parts.generatedAt,
      holdrOrigin: deps.holdrOrigin,
      deviceApi: deps.deviceApi,
      gate: gate.status(),
      recoveredAt: parts.recoveredAt,
      contractVersions: parts.contractVersions,
      limits: parts.limits,
      settings: parts.settings,
      bindings: parts.bindings.map(bindingAnswer),
      devices: parts.devices,
      pairings: parts.pairings,
      inventory: {
        bindings: mark('bindings', parts.inventory.bindings), devices: mark('devices', parts.inventory.devices),
        pairings: mark('pairings', parts.inventory.pairings),
      },
      queue: parts.queue,
      quota: parts.quota,
    });
  });

  for (const kind of ['devices', 'bindings', 'pairings', 'binding-devices'] as const) {
    owner.get(kind === 'binding-devices' ? '/bindings/:bindingId/devices' : `/${kind}`, (req, res) => {
      actorOf(req);
      const query = readQuery(req, ['cursor']);
      const bindingId = kind === 'binding-devices' ? pathId(req, 'bindingId', BINDING_ID) : undefined;
      const generation = repo.getCardSyncAuthorizationGeneration();
      const cursor = query.cursor ?? null;
      const after = cursor === null ? null : deps.cursors.decode('authority', resource(kind, generation, bindingId), cursor);
      if (cursor !== null && !after) throw invalidRequest([{ code: 'invalid-format', path: '$.cursor' }]);
      let page: ReturnType<SqliteStateRepo['getCardSyncOwnerAuthorityPage']>;
      try {
        page = repo.getCardSyncOwnerAuthorityPage({
          kind, bindingId, expectedGeneration: generation, afterRowId: after?.afterRowId,
        });
      } catch (error) {
        if (cardSyncRefusalCode(error) === 'page-stale') throw invalidRequest([{ code: 'invalid-format', path: '$.cursor' }]);
        throw error;
      }
      const entries = kind === 'bindings' ? (page.items as OwnerBinding[]).map(bindingAnswer) : page.items;
      res.json({
        [kind === 'binding-devices' ? 'devices' : kind]: entries, ...mark(kind, page, bindingId),
        ...(kind === 'binding-devices' ? { active: page.active } : {}),
        ...(kind === 'devices' ? { quota: page.quota } : {}),
      });
    });
  }

  // ---- §3.2 pause and issuers -------------------------------------------------------------------------------------------

  owner.post('/pause', ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    readBody<Record<string, never>>(req, {});
    const actorRef = actorOf(req);
    res.json((await change(req, 'narrowing', (step) => repo.pauseCardSyncOwner({ actorRef, ...step }))).value);
  }));

  owner.post('/resume', requireRecentAuth, ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    const body = readBody<{ expectedVersion: number }>(req, RESUME);
    const actorRef = actorOf(req);
    const result = await versioned(() => change(req, 'widening', (step) => repo.resumeCardSyncOwner({
      expectedVersion: body.expectedVersion, actorRef, ...step,
    })), settingsVersion);
    res.json(result.value);
  }));

  owner.post('/issuers/:issuer/enable', requireRecentAuth, ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    const issuer = issuerOf(req);
    const body = readBody<{ expectedVersion: number; riskAcknowledged: true; mainWorldAcknowledged: boolean }>(req, ENABLE);
    // Amex and Citi read from the page's own world (contract §18): the owner consents to it separately (owner API §3.2).
    if (CARD_SYNC_SOURCES.some((source) => CARD_SYNC_SOURCE_SPECS[source].issuer === issuer && CARD_SYNC_SOURCE_SPECS[source].mode === 'main-passive')
      && !body.mainWorldAcknowledged) {
      throw invalidRequest([{ code: 'inconsistent', path: '$.mainWorldAcknowledged' }]);
    }
    const actorRef = actorOf(req);
    const result = await versioned(() => change(req, 'widening', (step) => repo.enableCardSyncOwnerIssuer({
      issuer, expectedVersion: body.expectedVersion, contractVersion: CARD_SYNC_CONTRACT_VERSION, riskAcknowledged: true,
      mainWorldAcknowledged: body.mainWorldAcknowledged, actorRef, ...step,
    })), settingsVersion);
    res.json(result.value);
  }));

  owner.post('/issuers/:issuer/disable', ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    const issuer = issuerOf(req);
    readBody<Record<string, never>>(req, {});
    const actorRef = actorOf(req);
    res.json((await change(req, 'narrowing', (step) => repo.disableCardSyncOwnerIssuer({ issuer, actorRef, ...step }))).value);
  }));

  // ---- §3.3 bindings and card scopes ------------------------------------------------------------------------------------

  owner.post('/bindings', requireRecentAuth, ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    const body = readBody<{ issuer: CardSyncIssuer; source: CardSyncSource; cardAccountRef: string; bindingLabel: string; scopes: ScopeBody[] }>(
      req, CREATE_BINDING, SCOPE_KEYS);
    if (CARD_SYNC_SOURCE_SPECS[body.source].issuer !== body.issuer) throw invalidRequest([{ code: 'inconsistent', path: '$.source' }]);
    const actorRef = actorOf(req);
    const result = await change(req, 'widening', (step) => repo.createCardSyncOwnerBinding({
      cardAccountId: body.cardAccountRef, source: body.source, label: body.bindingLabel,
      scopes: body.scopes.map((scope) => ({ label: scope.scopeLabel, holderAlias: scope.holderAlias, last4: scope.last4 })),
      actorRef, ...step,
    }));
    res.status(201).json(bindingAnswer(result.value));
  }));

  owner.post('/bindings/:bindingId/confirm', requireRecentAuth, ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    const bindingId = pathId(req, 'bindingId', BINDING_ID);
    const body = readBody<{
      expectedVersion: number; bindingLabel: string; scopes: Array<ScopeBody & { cardScopeId: string | null }>; regrantDeviceIds: string[];
    }>(req, CONFIRM_BINDING, SCOPE_KEYS);
    distinct(body.scopes.map((scope) => scope.cardScopeId), '$.scopes');
    distinct(body.regrantDeviceIds, '$.regrantDeviceIds');
    const actorRef = actorOf(req);
    if (repo.getCardSyncOwnerBinding(bindingId) === null) throw notFound();
    try {
      const result = await versioned(() => change(req, 'widening', (step) => repo.confirmCardSyncOwnerBinding({
        bindingId, expectedVersion: body.expectedVersion, label: body.bindingLabel,
        scopes: body.scopes.map((scope) => ({
          cardScopeId: scope.cardScopeId, label: scope.scopeLabel, holderAlias: scope.holderAlias, last4: scope.last4,
        })),
        regrantDeviceIds: body.regrantDeviceIds, actorRef, ...step,
      })), bindingVersion(bindingId));
      res.json(bindingAnswer(result.value));
    } catch (error) {
      // The binding exists (read above; bindings are never deleted), so `not-found` names a listed browser: one that is
      // not active or never held this binding (owner API §3.3: 422).
      if (cardSyncRefusalCode(error) === 'not-found') throw invalidRequest([{ code: 'unknown-reference', path: '$.regrantDeviceIds' }]);
      throw error;
    }
  }));

  owner.post('/bindings/:bindingId/retire', ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    const bindingId = pathId(req, 'bindingId', BINDING_ID);
    const body = readBody<{ expectedVersion: number }>(req, RETIRE);
    const actorRef = actorOf(req);
    const result = await versioned(() => change(req, 'narrowing', (step) => repo.retireCardSyncOwnerBinding({
      bindingId, expectedVersion: body.expectedVersion, actorRef, ...step,
    })), bindingVersion(bindingId));
    res.json(bindingAnswer(result.value));
  }));

  owner.post('/bindings/:bindingId/auto-sync', ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    const bindingId = pathId(req, 'bindingId', BINDING_ID);
    const body = readBody<{ expectedVersion: number; expectedAutoSyncRevision: number; enabled: boolean }>(req, AUTO_SYNC);
    const actorRef = actorOf(req);
    if (!body.enabled) {
      // Off ignores both versions, always applies and always moves the revision (R1; owner API rule 5).
      res.json(bindingAnswer((await change(req, 'narrowing', (step) => repo.setCardSyncOwnerAutoSync({ bindingId, enabled: false, actorRef, ...step }))).value));
      return;
    }
    if (!deps.recentlyAuthenticated(req)) throw ownerError(403, 'recent-auth-required');
    const result = await versioned(() => change(req, 'widening', (step) => repo.setCardSyncOwnerAutoSync({
      bindingId, enabled: true, expectedVersion: body.expectedVersion, expectedAutoSyncRevision: body.expectedAutoSyncRevision,
      actorRef, ...step,
    })), bindingVersion(bindingId));
    res.json(bindingAnswer(result.value));
  }));

  // ---- §3.4 pairing and devices ------------------------------------------------------------------------------------------

  owner.post('/pairings', requireRecentAuth, ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    const body = readBody<{ bindingIds: string[]; replacesDeviceId: string | null }>(req, CREATE_PAIRING);
    distinct(body.bindingIds, '$.bindingIds');
    const holdrOrigin = requireDeviceApi();
    const actorRef = actorOf(req);
    // 32 letters a–p from 16 CSPRNG bytes; only its digest reaches the database, and only this answer carries the code.
    const pairingCode = randomCardSyncLetters();
    const result = await change(req, 'widening', (step) => repo.createCardSyncOwnerPairing({
      actorRef, codeDigest: pairingCodeDigest(pairingCode), bindingIds: body.bindingIds, replacesDeviceId: body.replacesDeviceId, ...step,
    }));
    res.status(201).setHeader('Cache-Control', 'no-store');
    res.json({ pairing: result.value, pairingCode, holdrOrigin });
  }));

  owner.post('/pairings/:pairingId/cancel', ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    const pairingId = pathId(req, 'pairingId', PAIRING_ID);
    readBody<Record<string, never>>(req, {});
    const actorRef = actorOf(req);
    res.json((await change(req, 'narrowing', (step) => repo.cancelCardSyncOwnerPairing({ pairingId, actorRef, ...step }))).value);
  }));

  owner.post('/pairings/:pairingId/approve', requireRecentAuth, ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    const pairingId = pathId(req, 'pairingId', PAIRING_ID);
    const body = readBody<{ deviceId: string; fingerprint: string }>(req, APPROVE);
    requireDeviceApi();
    const actorRef = actorOf(req);
    // Holdr shows the fingerprint grouped by four; the database keeps the 16 letters.
    const fingerprint = body.fingerprint.replace(/-/g, '');
    const result = await change(req, 'widening', (step) => repo.approveCardSyncOwnerPairing({
      pairingId, deviceId: body.deviceId, fingerprint, actorRef, ...step,
    }));
    res.json(result.value);
  }));

  owner.post('/pairings/:pairingId/reject', ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    const pairingId = pathId(req, 'pairingId', PAIRING_ID);
    const body = readBody<{ deviceId: string }>(req, REJECT);
    const actorRef = actorOf(req);
    res.json((await change(req, 'narrowing', (step) => repo.rejectCardSyncOwnerPairing({
      pairingId, deviceId: body.deviceId, actorRef, ...step,
    }))).value);
  }));

  owner.post('/devices/:deviceId/revoke', ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    const deviceId = pathId(req, 'deviceId', DEVICE_ID);
    readBody<Record<string, never>>(req, {});
    const actorRef = actorOf(req);
    res.json((await change(req, 'narrowing', (step) => repo.revokeCardSyncOwnerDevice({
      deviceId, reason: 'owner', actor: { kind: 'session', actorRef }, ...step,
    }))).value);
  }));

  owner.post('/devices/:deviceId/regrant', requireRecentAuth, ...ownerBody(), asyncRoute(async (req: Request, res: Response) => {
    const deviceId = pathId(req, 'deviceId', DEVICE_ID);
    const body = readBody<{ bindingIds: string[] }>(req, REGRANT);
    distinct(body.bindingIds, '$.bindingIds');
    const actorRef = actorOf(req);
    res.json((await change(req, 'widening', (step) => repo.regrantCardSyncOwnerDevice({
      deviceId, bindingIds: body.bindingIds, actorRef, ...step,
    }))).value);
  }));
}
