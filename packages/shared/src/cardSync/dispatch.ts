/**
 * Exact version dispatch for `holdr.card-import` payloads.
 *
 * `version: 1` goes to v1's `validateCardImportPayload`, unchanged and given
 * the caller's value as is, so v1 answers exactly as it always has (callers
 * keep running v1's `findCardImportSensitivePaths` first, as the v1 routes
 * do). `version: 2` goes to `validateCardSyncPayloadV2`, which scans for card
 * data itself. Anything else gets one fixed issue. There is no fallback and
 * no "strip unknown fields" compatibility: each version is accepted only in
 * its own exact form.
 */
import { CARD_IMPORT_FORMAT, CARD_IMPORT_VERSION, validateCardImportPayload, type CardImportValidation } from '../cardImport.js';
import type { CardSyncIssue } from './issues.js';
import { CARD_SYNC_V2_VERSION, validateCardSyncPayloadV2, type CardSyncV2Validation } from './wireV2.js';

export const CARD_IMPORT_SUPPORTED_VERSIONS: readonly number[] = Object.freeze([CARD_IMPORT_VERSION, CARD_SYNC_V2_VERSION]);

export type CardImportAnyVersionValidation =
  | { version: 1; validation: CardImportValidation }
  | { version: 2; validation: CardSyncV2Validation }
  | { version: null; validation: { ok: false; issues: CardSyncIssue[] } };

type Peeked = { kind: 'not-object' } | { kind: 'object'; format: unknown; version: unknown };

const ABSENT = Symbol('absent');

/** Reads `format` and `version` as own data properties only: no getter runs, no exotic object throws through. */
function peek(value: unknown): Peeked {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'not-object' };
    const proto = Reflect.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return { kind: 'not-object' };
    const read = (key: string): unknown => {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      return descriptor && 'value' in descriptor ? descriptor.value : ABSENT;
    };
    return { kind: 'object', format: read('format'), version: read('version') };
  } catch {
    return { kind: 'not-object' };
  }
}

/**
 * Validates a `holdr.card-import` payload of either version. The result names
 * the version that judged it; `version: null` means no validator accepted the
 * version, with one fixed issue (`wrong-type` at `$`, `unsupported-format` at
 * `$.format` or `unsupported-version` at `$.version`). Never throws: v1 input
 * gets v1's validator exactly, and an exotic object that makes v1 throw gets
 * v1's own catch-all issue (`$`, "is invalid") instead.
 */
export function validateCardImportAnyVersion(value: unknown): CardImportAnyVersionValidation {
  const peeked = peek(value);
  if (peeked.kind === 'object' && peeked.version === CARD_IMPORT_VERSION) {
    try {
      return { version: 1, validation: validateCardImportPayload(value) };
    } catch {
      // v1 never throws on parsed JSON; only an exotic object (a proxy whose traps throw) gets here.
      // Answer with v1's own catch-all issue rather than throw.
      return { version: 1, validation: { ok: false, issues: [{ path: '$', message: 'is invalid' }] } };
    }
  }
  if (peeked.kind === 'object' && peeked.version === CARD_SYNC_V2_VERSION) {
    return { version: 2, validation: validateCardSyncPayloadV2(value) };
  }
  let issue: CardSyncIssue;
  if (peeked.kind === 'not-object') issue = { code: 'wrong-type', path: '$' };
  else if (peeked.format !== CARD_IMPORT_FORMAT) issue = { code: 'unsupported-format', path: '$.format' };
  else issue = { code: 'unsupported-version', path: '$.version' };
  return { version: null, validation: { ok: false, issues: [issue] } };
}
