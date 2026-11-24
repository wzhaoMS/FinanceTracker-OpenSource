import { createHash, randomBytes } from 'node:crypto';

import { canonicalJson, toLetterHex, type JsonValue } from '@finance-tracker/shared';

/**
 * The server-side grammars of card-sync schema v15 (E1b design §2.0.3): row
 * ids, actor references, credential and content digests. Every one is
 * letters `a`–`p` after a fixed prefix, so nothing card-sync stores can
 * contain a digit run (a random hex id trips the 13-digit guard about once in
 * a hundred). Golden vectors in cardSyncDigests.test.ts pin each function.
 *
 * H(parts) = letter hex of sha256(utf8(JSON.stringify(parts))): a JSON array
 * keeps field boundaries unambiguous, and the first two parts name the
 * purpose and its version, so no digest of one kind equals one of another.
 */
export function cardSyncHash(parts: readonly unknown[]): string {
  return toLetterHex(createHash('sha256').update(JSON.stringify(parts), 'utf8').digest());
}

/** 16 CSPRNG bytes as 32 letters a–p. */
/**
 * Shared's `cardSyncPayloadDigest` (E1a: `pd1:` and the letter hex of sha256 over the UTF-8 of shared's canonical JSON)
 * with the host's native SHA-256 instead of shared's portable one: the same digest, several times faster for a payload
 * of 2 MiB. cardSyncDigests.test.ts pins it to shared's on random payloads, odd text included.
 */
export function cardSyncPayloadDigestNative(payload: JsonValue | object): string {
  return `pd1:${toLetterHex(createHash('sha256').update(canonicalJson(payload as JsonValue), 'utf8').digest())}`;
}

export function randomCardSyncLetters(): string {
  return toLetterHex(randomBytes(16));
}

/** The prefixes of the server's internal row ids (design §2.0.3), each followed by 32 letters a–p. */
export const CARD_SYNC_ROW_ID_PREFIXES = [
  'card-ident-', 'card-event-', 'card-cover-', 'card-audit-', 'card-obsid-', 'card-link-', 'card-obsrow-', 'card-bscope-',
  'card-dscope-', 'card-pscope-',
] as const;
export type CardSyncRowIdPrefix = (typeof CARD_SYNC_ROW_ID_PREFIXES)[number];

/** A new internal row id, e.g. `card-ident-` + 32 letters. */
export function newCardSyncRowId(prefix: CardSyncRowIdPrefix): string {
  return `${prefix}${randomCardSyncLetters()}`;
}

/** Wire and E2 id prefixes the server issues (E1a's `scp_`, `bnd_`, … and E2's `pai_`, `rvw_`), plus the generation. */
export type CardSyncIssuedIdPrefix = 'scp_' | 'bnd_' | 'run_' | 'obs_' | 'prv_' | 'dev_' | 'pai_' | 'rvw_' | 'agn_';

/** A new server-issued id, e.g. a legacy card scope's `scp_` + 32 letters, or a fresh authorization generation. */
export function newCardSyncId(prefix: CardSyncIssuedIdPrefix): string {
  return `${prefix}${randomCardSyncLetters()}`;
}

/** `usr_` + the first 16 bytes of H(["holdr.card-sync-actor", 1, <local_users.id>]): who acted, without the account id. */
export function cardSyncActorRef(localUserId: string): string {
  if (typeof localUserId !== 'string' || localUserId.length === 0) throw new TypeError('an actor needs a local user id');
  return `usr_${cardSyncHash(['holdr.card-sync-actor', 1, localUserId]).slice(0, 32)}`;
}

/** The bank fields an `rcd1:` content digest covers, as stored (normalized text, integer minor units, issuer days). */
export interface CardRowContent {
  transactionDate: string;
  postedDate: string | null;
  status: 'pending' | 'posted';
  amountMinor: number;
  kind: string;
  description: string;
  merchant: string | null;
  issuerCategory: string | null;
  originalAmountMinor: number | null;
  originalCurrency: string | null;
}

/**
 * `rcd1:` + H(["holdr.card-row-content", 1, …]): the content of an
 * observation, and what an identity's replay knowledge records. The one
 * function the v15 backfill and the writer both use, so a v1 replay of the
 * file that created a row produces exactly its baseline digest.
 */
export function rowContentDigest(row: CardRowContent): string {
  return `rcd1:${cardSyncHash(['holdr.card-row-content', 1, row.transactionDate, row.postedDate, row.status, row.amountMinor,
    row.kind, row.description, row.merchant, row.issuerCategory, row.originalAmountMinor, row.originalCurrency])}`;
}

/** `ccf1:` + H(["holdr.card-capture-fingerprint", 1, captureId, cfp1]): a capture-namespace row's identity, scoped to its capture. */
export function captureFingerprintIdentity(captureId: string, fingerprint: string): string {
  return `ccf1:${cardSyncHash(['holdr.card-capture-fingerprint', 1, captureId, fingerprint])}`;
}

/** `hdh1:` + H(["holdr.card-sync-device-token", 1, token]): the only form of a device token the database holds. */
export function deviceTokenDigest(token: string): string {
  return `hdh1:${cardSyncHash(['holdr.card-sync-device-token', 1, token])}`;
}

/** `hph1:` + H(["holdr.card-sync-pairing-code", 1, code]): the only form of a pairing code the database holds. */
export function pairingCodeDigest(code: string): string {
  return `hph1:${cardSyncHash(['holdr.card-sync-pairing-code', 1, code])}`;
}

/** `cer1:` + H(["holdr.cash-event-ref", 1, <account_cash_events.id>]): a payment link's source, without the cash event's id. */
export function cashEventRef(cashEventId: string): string {
  return `cer1:${cardSyncHash(['holdr.cash-event-ref', 1, cashEventId])}`;
}

/** The first 8 bytes of H(["holdr.card-sync-device-fingerprint", 1, token]) (16 letters), shown in the popup and in Holdr. */
export function deviceFingerprint(token: string): string {
  return cardSyncHash(['holdr.card-sync-device-fingerprint', 1, token]).slice(0, 16);
}
