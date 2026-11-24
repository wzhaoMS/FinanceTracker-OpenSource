/**
 * Opaque identifiers of the card-sync contract. Every id is a fixed prefix,
 * an underscore and exactly 32 letters `a`–`p` (16 random bytes in the letter
 * hex of `cardDedupe`): no digits, so no id can ever look like card data to
 * Holdr's detectors, and no structure a reader could mistake for meaning.
 *
 * Producers draw 16 bytes from a cryptographic source
 * (`crypto.getRandomValues(new Uint8Array(16))`) and pass them to
 * `formatCardSyncId`; this module itself stays pure and deterministic.
 */
import { toLetterHex } from '../cardDedupe.js';

export const CARD_SYNC_ID_PREFIXES = Object.freeze({
  /** Server-issued: one confirmed billing-account binding. */
  binding: 'bnd',
  /** Producer-issued: one capture run, shared by every payload it sends. */
  capture: 'cpt',
  /** Server-issued: one confirmed card scope (a known card, or "holder unknown") within a binding. */
  cardScope: 'scp',
  /** Page-issued: one projected stream on one document; never stored. */
  stream: 'stm',
  /** Page-issued: one redacted account candidate within a stream. */
  accountCandidate: 'cnd',
  /** Page-issued: one group of rows that share an issuer cardholder field, standing in for the name. */
  holderGroup: 'hld',
  // Control envelope (E2).
  /** Server-issued: one sync run. */
  run: 'run',
  /** Extension-issued: the client's own id for a run, also the observation's Idempotency-Key. */
  clientRun: 'crn',
  /** Server-issued: one accepted observation set (a received payload). */
  observationSet: 'obs',
  /** Server-issued: one import preview (the plan the user confirms). */
  preview: 'prv',
  /** Server-issued: one paired device. */
  device: 'dev',
} as const);

export type CardSyncIdKind = keyof typeof CARD_SYNC_ID_PREFIXES;

export const CARD_SYNC_ID_BYTES = 16;
/** Letters after the prefix: two per byte. */
export const CARD_SYNC_ID_LETTERS = CARD_SYNC_ID_BYTES * 2;

const PATTERNS = Object.fromEntries(
  Object.entries(CARD_SYNC_ID_PREFIXES).map(([kind, prefix]) => [kind, new RegExp(`^${prefix}_[a-p]{${CARD_SYNC_ID_LETTERS}}$`)]),
) as Record<CardSyncIdKind, RegExp>;

/** True when `value` is an id of this kind: prefix, `_`, then exactly 32 letters a–p. */
export function isCardSyncId(kind: CardSyncIdKind, value: unknown): value is string {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PATTERNS, kind) && PATTERNS[kind].test(value);
}

/** The id of `kind` for 16 bytes of randomness. Throws on anything but exactly 16 bytes. */
export function formatCardSyncId(kind: CardSyncIdKind, bytes: Uint8Array): string {
  if (!Object.prototype.hasOwnProperty.call(CARD_SYNC_ID_PREFIXES, kind)) throw new Error('unknown card sync id kind');
  if (!(bytes instanceof Uint8Array) || bytes.length !== CARD_SYNC_ID_BYTES) {
    throw new Error(`card sync ids take exactly ${CARD_SYNC_ID_BYTES} random bytes`);
  }
  return `${CARD_SYNC_ID_PREFIXES[kind]}_${toLetterHex(bytes)}`;
}

/**
 * A device's bearer token (E2): `hdv1_` and 64 letters a–p (32 random bytes).
 * Only the pairing-redeem response carries it, under a fixed exact shape read
 * by a dedicated parser; it is never put in a message or a payload.
 */
export const CARD_SYNC_DEVICE_TOKEN_PREFIX = 'hdv1_';
const DEVICE_TOKEN = /^hdv1_[a-p]{64}$/;

/** True when `value` has the device token form: `hdv1_` and exactly 64 letters a–p. */
export function isCardSyncDeviceToken(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_TOKEN.test(value);
}

/**
 * A pairing code (E2): 32 letters a–p (16 random bytes), single use. It is
 * shown in 8 groups of 4 (`formatCardSyncPairingCode`) and read back with or
 * without the spaces or hyphens between groups (`parseCardSyncPairingCode`).
 */
export const CARD_SYNC_PAIRING_CODE_LETTERS = 32;
const PAIRING_CODE = /^[a-p]{32}$/;

/** True when `value` is a pairing code in its canonical form: exactly 32 letters a–p. */
export function isCardSyncPairingCode(value: unknown): value is string {
  return typeof value === 'string' && PAIRING_CODE.test(value);
}

/** A canonical pairing code shown as 8 groups of 4 letters separated by spaces; null for anything else. */
export function formatCardSyncPairingCode(code: string): string | null {
  return isCardSyncPairingCode(code) ? code.match(/.{4}/g)!.join(' ') : null;
}

/** The canonical pairing code typed as 8 groups of 4 (spaces or hyphens between groups, either case); null otherwise. */
export function parseCardSyncPairingCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const trimmed = input.trim().toLowerCase();
  if (!/^[a-p]{4}(?:[ -]?[a-p]{4}){7}$/.test(trimmed)) return null;
  return trimmed.replace(/[ -]/g, '');
}
