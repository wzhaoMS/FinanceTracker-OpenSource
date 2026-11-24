/**
 * Dedupe keys for imported card transactions, shared by the API and the
 * offline redaction tool so both compute byte-identical keys on every
 * computer: no salt, no locale, no platform crypto. SHA-256 and UTF-8 are
 * implemented here synchronously in plain TypeScript.
 *
 * Digests are written in "letter hex" (nibbles 0–15 as `a`–`p`). About 4.4%
 * of hex SHA-256 digests contain 13 or more consecutive decimal digits, which
 * the database rejects in every card column, and about 0.14% contain a run
 * that `containsCardData` flags. Letter hex has no digits, so keys need no
 * exemption anywhere.
 *
 * Keys are versioned (`xid1:` / `cfp1:`); any change to the canonical forms
 * below needs a new version. They deliberately exclude the Holdr card-account
 * id, which the offline tool never sees: the database scopes them by keeping
 * them unique per `(card_account_id, key)`, so the same reference or purchase
 * in two card accounts is kept in both, and rows of a supplementary or
 * reissued card can move to their billing account without re-keying.
 */

import { normalizeCardText } from './cardText.js';

export const CARD_DEDUPE_VERSION = 1;

const EXTERNAL_ID_TAG = 'holdr.card-external-id';
const FINGERPRINT_TAG = 'holdr.card-fingerprint';
const EXTERNAL_ID_HASH = new RegExp(`^xid${CARD_DEDUPE_VERSION}:[a-p]{64}$`);
const FINGERPRINT = new RegExp(`^cfp${CARD_DEDUPE_VERSION}:[a-p]{64}$`);
const MAX_EXTERNAL_ID_LENGTH = 255;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** SHA-256 (FIPS 180-4). */
export function sha256(data: Uint8Array): Uint8Array {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const blocks = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  blocks.set(data);
  blocks[data.length] = 0x80;
  const view = new DataView(blocks.buffer);
  const bits = data.length * 8;
  view.setUint32(blocks.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(blocks.length - 4, bits >>> 0);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < blocks.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
  }
  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  for (let i = 0; i < 8; i += 1) out.setUint32(i * 4, state[i]);
  return digest;
}

/** Bytes as letter hex: each nibble 0–15 becomes `a`–`p`, so the result has no digits. */
export function toLetterHex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15));
  return text;
}

function utf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(bytes);
}

function digest(fields: ReadonlyArray<string | number>): string {
  // A JSON array keeps field boundaries unambiguous and escapes lone surrogates.
  return toLetterHex(sha256(utf8(JSON.stringify(fields))));
}

function isAsciiSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Stored form of an issuer's stable transaction reference (OFX FITID, Amex
 * Reference, …). The reference itself never reaches Holdr; only this hash does.
 *
 * Only map a whitelisted reference column here, never a card-number column:
 * an unsalted hash of a card number is brute-forced in moments from its BIN
 * and last four digits. The input is deliberately not run through card
 * detection, because numeric references pass Luhn and a network prefix a few
 * percent of the time. Surrounding ASCII whitespace is ignored; the rest is
 * compared exactly (references are case-sensitive).
 */
export function cardExternalIdHash(externalId: string): string {
  if (typeof externalId !== 'string') throw new Error('card external id must be a string');
  let start = 0;
  let end = externalId.length;
  while (start < end && isAsciiSpace(externalId.charCodeAt(start))) start += 1;
  while (end > start && isAsciiSpace(externalId.charCodeAt(end - 1))) end -= 1;
  const id = externalId.slice(start, end);
  if (!id) throw new Error('card external id must not be empty');
  if (id.length > MAX_EXTERNAL_ID_LENGTH) throw new Error(`card external id must be at most ${MAX_EXTERNAL_ID_LENGTH} characters`);
  if (/[\u0000-\u001f\u007f]/.test(id)) throw new Error('card external id must not contain control characters');
  return `xid${CARD_DEDUPE_VERSION}:${digest([EXTERNAL_ID_TAG, CARD_DEDUPE_VERSION, id])}`;
}

/**
 * Description as compared by fingerprints: `normalizeCardText` (NFKC,
 * invisible characters removed, ASCII digits), whitespace runs collapsed,
 * trimmed, upper-cased. Normalizing first therefore never changes a key.
 */
export function canonicalCardDescription(description: string): string {
  if (typeof description !== 'string') throw new Error('card description must be a string');
  return normalizeCardText(description).replace(/\s+/gu, ' ').trim().toUpperCase();
}

export interface CardFingerprintInput {
  /** YYYY-MM-DD. */
  transactionDate: string;
  /** Signed integer minor units, as stored. */
  amountMinor: number;
  /** Redacted description, as stored. */
  description: string;
}

/**
 * Content key for a row without a stable reference. `occurrence` is the
 * row's 0-based position among the id-less rows of the same export that share
 * its date, amount and canonical description, so two identical purchases get
 * different keys and are both kept, while re-importing the export (from any
 * computer) reproduces the same keys.
 */
export function cardTransactionFingerprint(row: CardFingerprintInput, occurrence: number): string {
  if (!isIsoDate(row.transactionDate)) throw new Error('card fingerprint transactionDate must be a valid YYYY-MM-DD date');
  if (!Number.isSafeInteger(row.amountMinor)) throw new Error('card fingerprint amountMinor must be a safe integer');
  if (!Number.isSafeInteger(occurrence) || occurrence < 0) {
    throw new Error('card fingerprint occurrence must be a non-negative integer');
  }
  const description = canonicalCardDescription(row.description);
  if (!description) throw new Error('card fingerprint description must not be empty');
  // JSON.stringify writes -0 as 0, so a zero amount has one canonical form.
  return `cfp${CARD_DEDUPE_VERSION}:${digest([
    FINGERPRINT_TAG, CARD_DEDUPE_VERSION, row.transactionDate, row.amountMinor, description, occurrence,
  ])}`;
}

export interface CardDedupeRow extends CardFingerprintInput {
  /** From `cardExternalIdHash`, when the issuer exports a stable reference. */
  externalIdHash?: string | null;
}

export type CardDedupeKey = { externalIdHash: string } | { fingerprint: string };

export function isCardExternalIdHash(value: unknown): value is string {
  return typeof value === 'string' && EXTERNAL_ID_HASH.test(value);
}

export function isCardFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT.test(value);
}

/**
 * One dedupe key per row of a single export, in order. Rows with a stable
 * reference keep its hash; occurrence indexes are counted only among rows
 * without one, so an id-less row gets the same key whether or not an
 * id-bearing twin appears in a particular export.
 */
export function assignCardDedupeKeys(rows: readonly CardDedupeRow[]): CardDedupeKey[] {
  const occurrences = new Map<string, number>();
  return rows.map((row, index) => {
    if (row.externalIdHash != null) {
      if (!isCardExternalIdHash(row.externalIdHash)) {
        throw new Error(`rows[${index}].externalIdHash must be a version ${CARD_DEDUPE_VERSION} card external id hash`);
      }
      return { externalIdHash: row.externalIdHash };
    }
    try {
      const group = JSON.stringify([row.transactionDate, row.amountMinor, canonicalCardDescription(row.description)]);
      const occurrence = occurrences.get(group) ?? 0;
      const fingerprint = cardTransactionFingerprint(row, occurrence);
      occurrences.set(group, occurrence + 1);
      return { fingerprint };
    } catch (error) {
      throw new Error(`rows[${index}]: ${(error as Error).message}`);
    }
  });
}
