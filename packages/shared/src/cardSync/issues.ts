/**
 * Value-free validation issues for the card-sync wire contract.
 *
 * An issue is exactly `{ code, path }`. The code comes from a fixed list and
 * the path is JSONPath-like: `$`, then `.name` for a key the schema knows,
 * `.<key>` for any other key, and `[n]` for an array index. Neither part is
 * ever built from an input value, so an issue can be logged, shown or sent
 * back to a producer without leaking what the producer sent.
 */

export const CARD_SYNC_ISSUE_CODES = [
  // Strict JSON: structure and safety (strictJson.ts).
  'unreadable',
  'not-json-value',
  'non-finite-number',
  'negative-zero',
  'not-integer',
  'not-plain-object',
  'invalid-array',
  'accessor-property',
  'hidden-property',
  'prototype-key',
  'forbidden-key',
  'cyclic-reference',
  'too-deep',
  'too-many-keys',
  'too-many-items',
  'too-many-nodes',
  'string-too-long',
  'key-too-long',
  'too-large',
  'ill-formed-unicode',
  'card-data',
  'card-secret',
  // Schema (wireV2.ts, projectedBatch.ts, dispatch.ts).
  'unknown-key',
  'missing-key',
  'wrong-type',
  'invalid-format',
  'invalid-enum',
  'invalid-date',
  'invalid-timestamp',
  'out-of-range',
  'unsupported-format',
  'unsupported-version',
  'unsupported-contract',
  'text-empty',
  'text-too-long',
  'text-not-canonical',
  'duplicate',
  'unsorted',
  'date-order',
  'inconsistent',
  'sign-mismatch',
  'source-mismatch',
  'identity-conflict',
  'unknown-reference',
  'fingerprint-mismatch',
  'totals-mismatch',
  'coverage-mismatch',
] as const;

export type CardSyncIssueCode = (typeof CARD_SYNC_ISSUE_CODES)[number];

export interface CardSyncIssue {
  code: CardSyncIssueCode;
  /** `$`, `.knownKey`, `.<key>` and `[index]` segments only; never a value. */
  path: string;
}

/** Fixed English text per code, for logs and UIs. None mentions a value. */
export const CARD_SYNC_ISSUE_DESCRIPTIONS: Readonly<Record<CardSyncIssueCode, string>> = Object.freeze({
  unreadable: 'could not be read as plain data (an exotic object refused inspection)',
  'not-json-value': 'is not a JSON value (undefined, function, symbol or bigint)',
  'non-finite-number': 'is NaN or infinite',
  'negative-zero': 'is negative zero',
  'not-integer': 'is not an integer',
  'not-plain-object': 'is not a plain object',
  'invalid-array': 'is not a plain, dense array without extra properties',
  'accessor-property': 'is a getter or setter; accessors are refused and never invoked',
  'hidden-property': 'is a non-enumerable or symbol-keyed property',
  'prototype-key': 'is a prototype key such as __proto__, constructor or prototype',
  'forbidden-key': 'is a key that may never be sent (raw data, tokens, names, contact details, card numbers or secrets, headers, URLs, diagnostics)',
  'cyclic-reference': 'contains itself (a cycle); JSON has none',
  'too-deep': 'is nested too deeply',
  'too-many-keys': 'has too many keys',
  'too-many-items': 'has too many items',
  'too-many-nodes': 'has too many values in total',
  'string-too-long': 'is a string longer than the strict JSON limit',
  'key-too-long': 'is a key longer than the strict JSON limit',
  'too-large': 'makes the canonical JSON larger than the byte budget',
  'ill-formed-unicode': 'contains an unpaired surrogate',
  'card-data': 'contains a card number, a card-length span showing more than four digits, a long digit run or an identifier-sized number',
  'card-secret': 'contains a card security code, PIN or expiry date',
  'unknown-key': 'is not part of the schema',
  'missing-key': 'is required',
  'wrong-type': 'has the wrong type',
  'invalid-format': 'does not match the required format',
  'invalid-enum': 'is not a registered value',
  'invalid-date': 'is not a valid YYYY-MM-DD calendar date from 1970 to 2099',
  'invalid-timestamp': 'is not a UTC timestamp in YYYY-MM-DDTHH:MM:SS.sssZ form',
  'out-of-range': 'is outside the allowed range',
  'unsupported-format': 'is not holdr.card-import',
  'unsupported-version': 'is not a supported version',
  'unsupported-contract': 'is not a supported contract version',
  'text-empty': 'must not be empty',
  'text-too-long': 'is longer than the field allows',
  'text-not-canonical': 'is not in canonical redacted form (normalized, single-spaced, no control or invisible characters, no leading = + - @)',
  duplicate: 'repeats an earlier entry',
  unsorted: 'is not sorted',
  'date-order': 'has a start after its end',
  inconsistent: 'contradicts another field',
  'sign-mismatch': 'has a sign that contradicts its kind or paired amount',
  'source-mismatch': 'is not allowed for this source',
  'identity-conflict': 'breaks the identity rules (one primary key, matching namespace kinds, no repeated ids)',
  'unknown-reference': 'refers to an entry that is not declared',
  'fingerprint-mismatch': 'does not match the fingerprint recomputed from the rows',
  'totals-mismatch': 'does not match the totals recomputed from the rows',
  'coverage-mismatch': 'does not match the rows it describes',
});

const CODES: ReadonlySet<string> = new Set(CARD_SYNC_ISSUE_CODES);

export function isCardSyncIssueCode(value: unknown): value is CardSyncIssueCode {
  return typeof value === 'string' && CODES.has(value);
}

/** The only paths an issue may carry. */
export const CARD_SYNC_ISSUE_PATH = /^\$(?:\.(?:[A-Za-z][A-Za-z0-9]{0,63}|<key>)|\[(?:0|[1-9][0-9]{0,8})\])*$/;

/** Most issues a validator reports; it stops looking once this many are found. */
export const CARD_SYNC_MAX_ISSUES = 20;

const SAFE_KEY = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** `parent.key` when the schema knows the key, else `parent.<key>`. */
export function cardSyncKeyPath(parent: string, key: string, known: ReadonlySet<string>): string {
  return SAFE_KEY.test(key) && known.has(key) ? `${parent}.${key}` : `${parent}.<key>`;
}

export function cardSyncIndexPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

/** Collects issues in order, drops exact repeats and stops at a cap. */
export class CardSyncIssueList {
  readonly list: CardSyncIssue[] = [];
  private readonly seen = new Set<string>();

  constructor(readonly max: number = CARD_SYNC_MAX_ISSUES) {}

  add(code: CardSyncIssueCode, path: string): void {
    if (this.list.length >= this.max) return;
    const id = `${code} ${path}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.list.push({ code, path });
  }

  get full(): boolean {
    return this.list.length >= this.max;
  }

  get size(): number {
    return this.list.length;
  }
}
