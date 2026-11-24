import { cardSyncRefusal } from './refusals.js';

/**
 * Who calls a card-sync repository method (E1b design §5.0), as E2 resolves
 * it: a paired browser by its `HoldrDevice` bearer (never with a cookie), the
 * signed-in owner (`usr_` reference, owner routes only), or the loopback
 * service token (reads and v1 imports only, Q44).
 */
export type CardSyncPrincipal =
  | { kind: 'device'; deviceId: string }
  | { kind: 'session'; actorRef: string }
  | { kind: 'service' };

const ACTOR_REF = /^usr_[a-p]{32}$/;
const DEVICE_ID = /^dev_[a-p]{32}$/;

/** The owner's `usr_` reference; any other principal, or a malformed one, is `principal-not-allowed`. */
export function sessionActorOf(principal: unknown): string {
  const candidate = principal as { kind?: unknown; actorRef?: unknown } | null;
  if (typeof candidate !== 'object' || candidate === null || candidate.kind !== 'session'
    || typeof candidate.actorRef !== 'string' || !ACTOR_REF.test(candidate.actorRef)) {
    throw cardSyncRefusal('principal-not-allowed');
  }
  return candidate.actorRef;
}

/** The calling device's id; any other principal, or a malformed one, is `principal-not-allowed`. */
export function deviceIdOf(principal: unknown): string {
  const candidate = principal as { kind?: unknown; deviceId?: unknown } | null;
  if (typeof candidate !== 'object' || candidate === null || candidate.kind !== 'device'
    || typeof candidate.deviceId !== 'string' || !DEVICE_ID.test(candidate.deviceId)) {
    throw cardSyncRefusal('principal-not-allowed');
  }
  return candidate.deviceId;
}

/**
 * What an authorization change returns (§5.0, §5.1): its value, whether it
 * changed anything, and the database's generation after the call (an
 * idempotent repeat changes nothing and does not advance it).
 */
export interface CardSyncAuthChange<T> {
  value: T;
  changed: boolean;
  authorizationGeneration: string;
}
