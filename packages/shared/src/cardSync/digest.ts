/**
 * Digests of canonical JSON for the card-sync envelope (plan §6.3): the
 * payload digest that ties the popup's confirmation to the bytes the worker
 * sends, the plan digest of an import preview, and Idempotency-Key material.
 *
 * A digest is a registered prefix, `:`, and 64 letters `a`–`p`: SHA-256 of the
 * UTF-8 bytes of `canonicalJson(value)`, in the letter hex of `cardDedupe`.
 * It has no run of digits for Holdr's card detectors to read, so it passes
 * `snapshotStrictJson` as a value. Portable and synchronous: `cardDedupe`'s
 * pure SHA-256 and a pure UTF-8 encoder; no TextEncoder, WebCrypto or
 * node:crypto.
 */
import { sha256, toLetterHex } from '../cardDedupe.js';
import { canonicalJson, utf8ByteLength, type JsonValue } from './canonical.js';

export const CARD_SYNC_DIGEST_PREFIXES = Object.freeze({
  /** A `holdr.card-import` v2 payload: the canonical bytes previewed, sent and kept as the receipt. */
  payload: 'pd1',
  /** An import plan (preview) the user confirms before commit. */
  plan: 'pl1',
} as const);

export type CardSyncDigestKind = keyof typeof CARD_SYNC_DIGEST_PREFIXES;

/** Letters after the prefix: two per byte of SHA-256. */
export const CARD_SYNC_DIGEST_LETTERS = 64;

const PATTERNS = Object.fromEntries(
  Object.entries(CARD_SYNC_DIGEST_PREFIXES).map(([kind, prefix]) => [kind, new RegExp(`^${prefix}:[a-p]{${CARD_SYNC_DIGEST_LETTERS}}$`)]),
) as Record<CardSyncDigestKind, RegExp>;

/** UTF-8 bytes of `text`, as `TextEncoder` writes them (an unpaired surrogate becomes U+FFFD). */
export function encodeCardSyncUtf8(text: string): Uint8Array {
  const bytes = new Uint8Array(utf8ByteLength(text));
  let at = 0;
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdfff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else {
        code = 0xfffd;
      }
    }
    if (code < 0x80) {
      bytes[at++] = code;
    } else if (code < 0x800) {
      bytes[at++] = 0xc0 | (code >> 6);
      bytes[at++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      bytes[at++] = 0xe0 | (code >> 12);
      bytes[at++] = 0x80 | ((code >> 6) & 0x3f);
      bytes[at++] = 0x80 | (code & 0x3f);
    } else {
      bytes[at++] = 0xf0 | (code >> 18);
      bytes[at++] = 0x80 | ((code >> 12) & 0x3f);
      bytes[at++] = 0x80 | ((code >> 6) & 0x3f);
      bytes[at++] = 0x80 | (code & 0x3f);
    }
  }
  return bytes;
}

/**
 * The digest of `kind` for a strict JSON value: its prefix, `:`, and the
 * letter hex of SHA-256 over the UTF-8 bytes of `canonicalJson(value)`. Key
 * order does not matter. Throws `CanonicalJsonError` (which names no value)
 * for anything `canonicalJson` refuses, and an Error for an unknown kind.
 */
export function cardSyncDigest(kind: CardSyncDigestKind, value: JsonValue): string {
  if (!Object.prototype.hasOwnProperty.call(CARD_SYNC_DIGEST_PREFIXES, kind)) throw new Error('unknown card sync digest kind');
  return `${CARD_SYNC_DIGEST_PREFIXES[kind]}:${toLetterHex(sha256(encodeCardSyncUtf8(canonicalJson(value))))}`;
}

/** `pd1:` and 64 letters: the digest of a v2 payload's canonical bytes. It does not validate the payload. */
export function cardSyncPayloadDigest(payload: JsonValue | object): string {
  return cardSyncDigest('payload', payload as JsonValue);
}

/** `pl1:` and 64 letters: the digest of an import plan's canonical bytes. */
export function cardSyncPlanDigest(plan: JsonValue | object): string {
  return cardSyncDigest('plan', plan as JsonValue);
}

/** True when `value` is a digest of this kind: its prefix, `:`, then exactly 64 letters a–p. */
export function isCardSyncDigest(kind: CardSyncDigestKind, value: unknown): value is string {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PATTERNS, kind) && PATTERNS[kind].test(value);
}
