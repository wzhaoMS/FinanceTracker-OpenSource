import type { Request, Response } from 'express';
import {
  isCardSyncDeviceToken, isCardSyncId, isCardSyncTimestamp, snapshotStrictJson, type CardSyncIssue,
} from '@finance-tracker/shared';
import { isAuthorizationBlocked } from '../../control/authorizationChange.js';
import { errorTypeAndCode, HoldrDbError, isCardGuardRefusal } from '../../services/dbErrors.js';
import { cardSyncRefusalCode } from '../../services/cardSync/refusals.js';
import { ownerRefusal } from './http.js';
import { DeviceHttpError } from './deviceProtocol.js';
import { DeviceAdmissionRefusal } from '../../ingress/deviceAdmission.js';

export const DEVICE_RESPONSE_BYTES = 256 * 1024;

export function deviceReply(res: Response, value: unknown, status = 200): void {
  const snapshot = snapshotStrictJson(value, {
    limits: { maxBytes: DEVICE_RESPONSE_BYTES, maxDepth: 8, maxNodes: 10_000, maxArrayLength: 2000, maxStringLength: 256 },
  });
  if (!snapshot.ok) throw new DeviceHttpError(500, 'internal-error');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(snapshot.value);
}

/** The sole bearer-bearing response, with its own exact grammar instead of weakening the general output key policy. */
export function pairingReply(res: Response, value: {
  deviceId: string; deviceToken: string; fingerprint: string; status: 'pending'; pendingExpiresAt: string;
}, beforeSend?: () => void): void {
  if (!isCardSyncId('device', value.deviceId) || !isCardSyncDeviceToken(value.deviceToken)
    || !/^[a-p]{4}(?:-[a-p]{4}){3}$/.test(value.fingerprint) || value.status !== 'pending'
    || !isCardSyncTimestamp(value.pendingExpiresAt)) throw new DeviceHttpError(500, 'internal-error');
  res.setHeader('Cache-Control', 'no-store');
  beforeSend?.();
  res.status(200).json({
    deviceId: value.deviceId, deviceToken: value.deviceToken, fingerprint: value.fingerprint,
    status: value.status, pendingExpiresAt: value.pendingExpiresAt,
  });
}

function responseFailure(error: unknown): { status: number; code: string; issues?: readonly CardSyncIssue[]; retry?: number } {
  if (error instanceof DeviceHttpError) return error;
  if (isAuthorizationBlocked(error)) return { status: 409, code: 'authorization-blocked' };
  if (isCardGuardRefusal(error)) return { status: 422, code: 'payload-invalid', issues: [{ code: 'card-data', path: '$' }] };
  const code = cardSyncRefusalCode(error);
  if (code) {
    if (code === 'generation-mismatch') return { status: 409, code: 'authorization-blocked' };
    if (code === 'issuer-disabled') return { status: 409, code: 'sync-disabled' };
    if (code === 'run-not-found') return { status: 404, code };
    if (code === 'contract-unsupported') return { status: 422, code };
    const mapped = ownerRefusal(code);
    return { status: mapped.status, code: mapped.error };
  }
  if (error instanceof HoldrDbError && /SQLITE_(?:BUSY|LOCKED)/.test(error.code)) return { status: 503, code: 'unavailable', retry: 1 };
  return { status: 500, code: 'internal-error' };
}

export function deviceError(req: Request, res: Response, error: unknown, log: (line: string) => void): void {
  if (error instanceof DeviceAdmissionRefusal) throw error;
  const failure = responseFailure(error);
  if (failure.status >= 500) log(`[card-sync] device request failed: ${errorTypeAndCode(error)}`);
  if (res.headersSent || res.destroyed) { res.destroy(); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Holdr-Error', failure.code);
  if (failure.retry) res.setHeader('Retry-After', String(failure.retry));
  const body = {
    error: failure.code,
    ...(failure.issues ? { issues: failure.issues.slice(0, 20).map(({ code, path }) => ({ code, path })) } : {}),
    ...(failure.retry ? { retryAfterSeconds: failure.retry } : {}),
  };
  res.status(failure.status).json(body);
  void req;
}
