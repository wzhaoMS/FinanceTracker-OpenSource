import type { IncomingMessage } from 'node:http';
import type { CardSyncDeviceAuth, CardSyncDeviceView, SqliteStateRepo } from '../../services/sqliteStateRepo.js';
import {
  DEVICE_CLIENT_MARKER, DEVICE_CLIENT_VERSION, DeviceHttpError, readDeviceAuthorization, singleDeviceHeader,
} from './deviceProtocol.js';

/** Proposed E2c version binding (M1): an unversioned old E3 client is refused, never silently treated as the stored version. */
export const DEVICE_VERSION_HEADER = 'x-holdr-client-version';
export type DeviceAuthRepository = Pick<SqliteStateRepo, 'findCardSyncDeviceByTokenDigest' | 'getCardSyncDevice'>;

export function requireDeviceClient(req: IncomingMessage): void {
  if (singleDeviceHeader(req, 'x-holdr-client') !== DEVICE_CLIENT_MARKER) throw new DeviceHttpError(400, 'bad-request');
}

export function resolveDevice(
  req: IncomingMessage,
  repo: DeviceAuthRepository,
  allowPending = false,
): { auth: CardSyncDeviceAuth; view: CardSyncDeviceView } {
  requireDeviceClient(req);
  const { digest } = readDeviceAuthorization(req);
  const auth = repo.findCardSyncDeviceByTokenDigest(digest);
  if (!auth) throw new DeviceHttpError(401, 'unauthorized');
  const version = singleDeviceHeader(req, DEVICE_VERSION_HEADER);
  const view = repo.getCardSyncDevice(auth.deviceId);
  if (typeof version !== 'string' || !DEVICE_CLIENT_VERSION.test(version) || !view || view.clientVersion !== version
    || view.deviceId !== auth.deviceId || view.status !== auth.status) throw new DeviceHttpError(401, 'unauthorized');
  if (auth.status !== 'active' && !allowPending) throw new DeviceHttpError(403, 'device-pending');
  return { auth, view };
}

/** Small bounded, continuous-clock limiter; no code/token is a key and no caller can configure it through the environment. */
export class DevicePairingLimiter {
  private readonly attempts = new Map<string, { began: bigint; count: number }>();
  private last = 0n;
  constructor(private readonly now: () => bigint = () => process.hrtime.bigint()) {}

  take(req: IncomingMessage): void {
    const now = this.now();
    if (now < this.last) throw new DeviceHttpError(503, 'unavailable');
    this.last = now;
    for (const [key, entry] of this.attempts) {
      if (now - entry.began >= 60_000_000_000n) this.attempts.delete(key);
    }
    const key = req.holdrIngress?.clientAddress ?? 'unknown';
    const entry = this.attempts.get(key);
    if (entry && entry.count >= 10) throw new DeviceHttpError(429, 'rate-limited');
    if (!entry && this.attempts.size >= 1024) throw new DeviceHttpError(429, 'rate-limited');
    this.attempts.set(key, entry ? { began: entry.began, count: entry.count + 1 } : { began: now, count: 1 });
  }
}
