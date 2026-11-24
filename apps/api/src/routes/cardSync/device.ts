import type { Request, Response, Router } from 'express';
import {
  CARD_SYNC_ISSUERS, CARD_SYNC_V2_MAX_BYTES, CARD_SYNC_V2_MAX_ROWS, isCardSyncId,
} from '@finance-tracker/shared';
import {
  changeWithAuthorizationLockHeld, narrowBlockedWithAuthorizationLockHeld, type AuthorizationEffectGuard, type AuthorizationFenceContext,
} from '../../control/authorizationChange.js';
import type { DeviceAdmission, DeviceAuthorization } from '../../ingress/deviceAdmission.js';
import { createDeviceRouter, type DeviceRoute } from '../../ingress/deviceRouter.js';
import { errorTypeAndCode, isCardGuardRefusal } from '../../services/dbErrors.js';
import { cardSyncRefusalCode } from '../../services/cardSync/refusals.js';
import type { CardSyncDeviceAuth, CardSyncDeviceView, CardSyncRunRefusal, SqliteStateRepo } from '../../services/sqliteStateRepo.js';
import { DevicePairingLimiter, requireDeviceClient, resolveDevice } from './deviceAuth.js';
import { deviceBody } from './deviceBody.js';
import { assertDeviceCors, devicePreflight } from './deviceCors.js';
import {
  DEVICE_ENDPOINTS, DEVICE_LABEL, DeviceHttpError, displayDeviceFingerprint, newDeviceCredential,
  parseDeviceAbort, parseDeviceCommit, parseDevicePrepare, parseDeviceRedeem, parseDeviceRun, parseDeviceUpload,
  readDeviceAuthorization, singleDeviceHeader, deviceUploadRunId, deviceEndpoint, type DeviceEndpointName,
} from './deviceProtocol.js';
import { deviceError, deviceReply, pairingReply } from './deviceResponses.js';

export interface CardSyncDeviceOptions {
  readonly repo: SqliteStateRepo;
  readonly admission: DeviceAdmission;
  readonly holdrOrigin: string;
  /** Only consulted inside D's already-held lock. Never calls a lock-acquiring owner gate. */
  readonly authorization: AuthorizationFenceContext;
  readonly log?: (line: string) => void;
}

function clientRunId(req: Request): string {
  const key = singleDeviceHeader(req, 'idempotency-key');
  if (!isCardSyncId('clientRun', key)) throw new DeviceHttpError(400, 'bad-request');
  return key;
}

function ownRun(repo: SqliteStateRepo, deviceId: string, runId: string) {
  if (!isCardSyncId('run', runId)) throw new DeviceHttpError(404, 'run-not-found');
  return repo.getCardSyncRunReceipt({ principal: { kind: 'device', deviceId }, runId });
}

function capabilities(repo: SqliteStateRepo, auth: CardSyncDeviceAuth, view: CardSyncDeviceView, holdrOrigin: string) {
  const settings = repo.getCardSyncSettings();
  const bindings = [];
  for (const grant of auth.grants) {
    const binding = repo.getCardSourceBinding(grant.bindingId);
    if (!binding || binding.status !== 'confirmed' || binding.bindingVersion !== grant.bindingVersion) continue;
    const scopes = binding.scopes.filter((scope) => scope.status === 'active').map((scope) => ({
      cardScopeId: scope.cardScopeId, scopeLabel: scope.scopeLabel, last4: scope.last4, holderUnknown: scope.kind === 'unknown',
    }));
    const cards = [...new Set(scopes.flatMap((scope) => scope.last4 === null ? [] : [scope.last4]))].sort();
    // E1b allows 39 known scopes plus the unknown scope. Do not truncate their card hints to E3's proposed limit of 20.
    if (bindings.length >= 20 || scopes.length > 40 || cards.length > 39) throw new DeviceHttpError(503, 'unavailable');
    bindings.push({
      bindingId: binding.bindingId, bindingVersion: binding.bindingVersion, issuer: binding.issuer, source: binding.source,
      bindingLabel: binding.bindingLabel, cards, scopes,
    });
  }
  if (!DEVICE_LABEL.test(view.label)) throw new DeviceHttpError(503, 'unavailable');
  return {
    status: auth.status, deviceId: auth.deviceId, deviceLabel: view.label, deviceExpiresAt: auth.expiresAt,
    holdrOrigin, syncEnabled: auth.status === 'active' && !settings.paused,
    payloadVersions: [2], contractVersions: [1], maxPayloadBytes: CARD_SYNC_V2_MAX_BYTES, maxRows: CARD_SYNC_V2_MAX_ROWS,
    issuers: CARD_SYNC_ISSUERS.map((issuer) => ({ issuer, enabled: settings.issuers.find((row) => row.issuer === issuer)?.enabled === true })),
    bindings,
  };
}

/** A real, authenticated device is the only source of the device id; the client key never chooses another device's run. */
function recordRefusal(repo: SqliteStateRepo, req: Request, deviceId: string, error: unknown, admitted: DeviceAuthorization): void {
  let code: CardSyncRunRefusal | undefined = error instanceof DeviceHttpError ? error.runRefusal : undefined;
  if (isCardGuardRefusal(error)) code = 'card-data';
  const refusal = cardSyncRefusalCode(error);
  if (refusal && [
    'payload-invalid', 'payload-digest-mismatch', 'review-quota-exceeded', 'binding-stale', 'scope-not-in-binding',
    'contract-unsupported', 'capture-already-accepted',
  ].includes(refusal)) code = refusal as CardSyncRunRefusal;
  if (error instanceof DeviceHttpError && !code && error.status >= 400 && error.status < 500) code = 'payload-invalid';
  if (!code) return;
  let run = null;
  try { run = repo.getCardSyncRunByClientRunId({ deviceId, clientRunId: clientRunId(req) }); }
  catch (failure) {
    if (!(failure instanceof DeviceHttpError)) throw failure;
  }
  if (!run) {
    let runId: string | null;
    try { runId = deviceUploadRunId(deviceBody(req)); } catch { return; }
    if (runId) {
      try { run = ownRun(repo, deviceId, runId); }
      catch (failure) {
        if (cardSyncRefusalCode(failure) !== 'run-not-found') throw failure;
      }
    }
  }
  if (run) {
    admitted.assertCurrent();
    repo.recordCardSyncRunRefusal({ deviceId, runId: run.runId, code });
  }
}

function receiptSet(repo: SqliteStateRepo, setId: string) {
  const page = repo.getCardSyncObservationSetPage({ setId, after: null, limit: 1 });
  if (!page) throw new DeviceHttpError(500, 'internal-error');
  return page.set;
}

function receipt(repo: SqliteStateRepo, deviceId: string, runId: string) {
  const run = ownRun(repo, deviceId, runId);
  if (!run.observationSetId) return {
    runId: run.runId, observationSetId: null, acceptance: 'none', ledger: 'none',
    payloadDigest: null, acceptedAt: null, expiresAt: null,
  };
  const set = receiptSet(repo, run.observationSetId);
  const state = set.state;
  const acceptance = state === 'blocked-review' || state === 'recovery-review' ? 'needs-review'
    : state === 'committed' ? 'accepted-uncommitted' : state;
  return {
    runId: run.runId, observationSetId: run.observationSetId, acceptance, ledger: state === 'committed' ? 'committed' : 'none',
    payloadDigest: run.payloadDigest, acceptedAt: run.acceptedAt, expiresAt: set.expiresAt,
  };
}

/** Every operation, including OPTIONS and credential resolution, is the sole guarded callback of D's router factory. */
export function createCardSyncDeviceRouter(options: CardSyncDeviceOptions): Router {
  const { repo, admission, authorization, holdrOrigin } = options;
  const log = options.log ?? console.warn;
  const pairingLimit = new DevicePairingLimiter();

  function exactEndpoint(req: Request, name: DeviceEndpointName) {
    const rawPath = req.holdrTarget?.rawPath ?? req.originalUrl.split('?')[0];
    if (deviceEndpoint(rawPath, req.method)?.name !== name) throw new DeviceHttpError(404, 'not-found');
  }

  function execute(name: DeviceEndpointName, req: Request, res: Response, admitted: DeviceAuthorization) {
    exactEndpoint(req, name);
    assertDeviceCors(req);
    requireDeviceClient(req);
    if (name === 'redeem') {
      if (req.url.includes('?')) throw new DeviceHttpError(400, 'bad-request');
      pairingLimit.take(req);
      const { digest } = readDeviceAuthorization(req, true);
      const body = parseDeviceRedeem(deviceBody(req));
      const credential = newDeviceCredential();
      admitted.assertCurrent();
      let effects: AuthorizationEffectGuard | undefined;
      let result: ReturnType<SqliteStateRepo['redeemCardSyncPairing']>;
      try {
        result = changeWithAuthorizationLockHeld(authorization, 'widening', (step) => repo.redeemCardSyncPairing({
          codeDigest: digest, deviceId: credential.deviceId, tokenDigest: credential.tokenDigest, fingerprint: credential.fingerprint,
          label: body.deviceLabel, clientVersion: body.clientVersion, ...step,
        }, {
          before: () => effects!.beforeMutation(),
          after: (outcome) => effects!.afterMutation(outcome.authorizationGeneration),
        }), (plan) => (effects = admitted.generationChange(plan)));
        effects!.assertCurrent();
        if (result.ok) {
          pairingReply(res, {
            deviceId: result.deviceId, deviceToken: credential.token, fingerprint: displayDeviceFingerprint(credential.fingerprint),
            status: result.status, pendingExpiresAt: result.pendingExpiresAt,
          }, () => effects!.assertCurrent());
        }
      } catch (error) {
        let refusal = error;
        try {
          if (effects) effects.rethrowRefusal();
          else admitted.assertCurrent();
        } catch (guarded) { refusal = guarded; }
        try {
          if (repo.getCardSyncDevice(credential.deviceId)?.status === 'pending') {
            narrowBlockedWithAuthorizationLockHeld(authorization, (step) => repo.cancelPendingCardSyncRedemption({
              deviceId: credential.deviceId, tokenDigest: credential.tokenDigest, ...step,
            }));
          }
        } catch (cleanup) {
          log(`[card-sync] pending redemption cleanup failed: ${errorTypeAndCode(cleanup)}`);
        }
        throw refusal;
      }
      if (!result.ok) throw new DeviceHttpError(result.code === 'pairing-locked' ? 429 : 401, result.code);
      return;
    }
    const { auth, view } = resolveDevice(req, repo, name === 'capabilities');
    admitted.assertCurrent();
    repo.touchCardSyncDevice(auth.deviceId);
    const reply = (value: unknown) => {
      admitted.assertCurrent();
      deviceReply(res, value);
    };
    const principal = { kind: 'device' as const, deviceId: auth.deviceId };
    if (name !== 'observations' && req.url.includes('?')) throw new DeviceHttpError(400, 'bad-request');
    if (name === 'capabilities') { reply(capabilities(repo, auth, view, holdrOrigin)); return; }
    if (name === 'run') {
      const body = parseDeviceRun(deviceBody(req));
      if (clientRunId(req) !== body.clientRunId) throw new DeviceHttpError(409, 'idempotency-conflict');
      admitted.assertCurrent();
      const created = repo.createCardSyncRun({ ...body, deviceId: auth.deviceId, expectedGeneration: admitted.generation });
      reply({ runId: created.runId, expiresAt: created.uploadExpiresAt });
      return;
    }
    if (name === 'observations') {
      try {
        if (req.url.includes('?')) throw new DeviceHttpError(400, 'bad-request');
        const key = clientRunId(req);
        const upload = parseDeviceUpload(deviceBody(req));
        admitted.assertCurrent();
        const accepted = repo.acceptCardSyncObservations({
          deviceId: auth.deviceId, runId: upload.runId, clientRunId: key, canonicalJson: upload.canonicalJson,
          payloadDigest: upload.payloadDigest, expectedGeneration: admitted.generation,
        });
        const state = receiptSet(repo, accepted.observationSetId).state;
        const status = state === 'blocked-review' || state === 'recovery-review' ? 'needs-review' : state;
        // Terminal replay states stay terminal (§5.4); E3's proposal must extend its ACK enum (M7).
        reply({
          observationSetId: accepted.observationSetId, runId: accepted.runId, payloadDigest: accepted.payloadDigest,
          status, acceptedAt: accepted.acceptedAt, expiresAt: accepted.expiresAt,
        });
      } catch (error) {
        recordRefusal(repo, req, auth.deviceId, error, admitted);
        throw error;
      }
      return;
    }
    if (name === 'prepare') {
      const body = parseDevicePrepare(deviceBody(req));
      const run = ownRun(repo, auth.deviceId, body.runId);
      if (run.observationSetId !== body.observationSetId) throw new DeviceHttpError(404, 'not-found');
      admitted.assertCurrent();
      const prepared = repo.prepareCardSyncPlan({ principal, setId: body.observationSetId, expectedGeneration: admitted.generation });
      if (prepared.status === 'owner-review') {
        reply({
          status: 'owner-review', observationSetId: prepared.observationSetId, counts: prepared.counts, reviewCount: prepared.reviewCount,
        });
      } else {
        if (prepared.payloadDigest === null) throw new DeviceHttpError(500, 'internal-error');
        reply({
          status: 'executable', previewId: prepared.previewId, payloadDigest: prepared.payloadDigest,
          planDigest: prepared.planDigest, expiresAt: prepared.expiresAt, counts: prepared.counts,
        });
      }
      return;
    }
    if (name === 'commit') {
      const body = parseDeviceCommit(deviceBody(req));
      const run = ownRun(repo, auth.deviceId, body.runId);
      if (!run.observationSetId || run.payloadDigest !== body.payloadDigest) throw new DeviceHttpError(409, 'plan-mismatch');
      admitted.assertCurrent();
      const committed = repo.commitCardSyncPlan({
        principal, previewId: body.previewId, payloadDigest: body.payloadDigest, planDigest: body.planDigest,
        expectedGeneration: admitted.generation,
      });
      reply({ status: 'committed', committedAt: committed.committedAt, inserted: committed.counts.insert, updated: committed.counts.update });
      return;
    }
    const runId = req.params.runId;
    if (typeof runId !== 'string' || !isCardSyncId('run', runId)) throw new DeviceHttpError(404, 'run-not-found');
    if (name === 'receipt') { reply(receipt(repo, auth.deviceId, runId)); return; }
    const body = parseDeviceAbort(deviceBody(req));
    admitted.assertCurrent();
    repo.abortCardSyncRun({ deviceId: auth.deviceId, runId, reason: body.reason });
    reply({ status: 'aborted' });
  }

  const routes: DeviceRoute[] = [];
  for (const endpoint of DEVICE_ENDPOINTS) {
    routes.push({
      method: endpoint.method, path: endpoint.path,
      handle: (req, res, admitted) => {
        try { execute(endpoint.name, req, res, admitted); } catch (error) { deviceError(req, res, error, log); }
      },
    });
    routes.push({
      method: 'options', path: endpoint.path,
      handle: (req, res) => {
        try { exactEndpoint(req, endpoint.name); devicePreflight(req, res); }
        catch (error) { deviceError(req, res, error, log); }
      },
    });
  }
  return createDeviceRouter(admission, routes);
}
