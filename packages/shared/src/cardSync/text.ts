/**
 * Free text in card-sync payloads (descriptions, merchants, issuer
 * categories, product hints) follows v1's storage rules exactly
 * (`cardImportTextProblem`): `normalizeCardText` form, single spaces, no
 * control, invisible or unpaired characters, no leading `= + - @`, no card
 * data, long digit runs or card secrets. Holdr stores what the producer sent,
 * so what the user previews is what is stored.
 *
 * - `cardSyncTextIssue` is the validator's check. It only refuses: text that
 *   is not already canonical and redacted is an error, never rewritten.
 * - `prepareCardSyncText` is the producer's helper for issuer text. It never
 *   cuts raw text: it refuses raw text over `CARD_SYNC_RAW_TEXT_MAX`, redacts
 *   the complete text first, cuts only redacted text, and redacts and scans
 *   again after every transformation, so padding (zero-width characters,
 *   whitespace) cannot push part of a card number past a limit unredacted.
 *   It does not use v1's `sanitizeCardText`.
 */
import { cardImportTextProblem, CARD_IMPORT_TEXT_LIMITS, normalizeCardImportText } from '../cardImport.js';
import { containsCardData, redactCardNumbers } from '../cardNumbers.js';
import { containsCardSecret } from '../cardSecrets.js';
import { containsLongDigitRun } from '../cardText.js';
import type { CardSyncIssueCode } from './issues.js';

/** Most UTF-16 units of issuer text `prepareCardSyncText` accepts; longer text is refused, never cut. */
export const CARD_SYNC_RAW_TEXT_MAX = 4_096;

/** v1's limits, plus the account candidates' product hint. */
export const CARD_SYNC_TEXT_LIMITS = Object.freeze({
  description: CARD_IMPORT_TEXT_LIMITS.description,
  merchant: CARD_IMPORT_TEXT_LIMITS.merchant,
  issuerCategory: CARD_IMPORT_TEXT_LIMITS.issuerCategory,
  productHint: 100,
} as const);

const LONG_RUN_ALL = /\p{Nd}{13,}/gu;
const FORMULA_START = /^[=+\-@]/;
const MAX_PASSES = 8;

/** Normalized form, as card import stores text: unpaired surrogates as U+FFFD, `normalizeCardText`, control characters as spaces, single spaces, trimmed. */
const tidy = normalizeCardImportText;

function cardIssue(text: string): CardSyncIssueCode | null {
  if (containsCardData(text) || containsLongDigitRun(text)) return 'card-data';
  if (containsCardSecret(text)) return 'card-secret';
  return null;
}

export interface CardSyncTextCheckOptions {
  /**
   * The card detectors already ran on this exact string and found nothing
   * (as `snapshotStrictJson` does for every string), so they run here only
   * to name the problem when v1's text rule refuses the text.
   */
  scanned?: boolean;
}

/**
 * Why `text` may not be sent as a field with this limit, or null when it is
 * acceptable as is. Refuse-only: nothing is truncated or rewritten.
 */
export function cardSyncTextIssue(text: unknown, maxLength: number, options: CardSyncTextCheckOptions = {}): CardSyncIssueCode | null {
  if (typeof text !== 'string') return 'wrong-type';
  if (text.length === 0) return 'text-empty';
  if (text.length > maxLength) return 'text-too-long';
  if (!options.scanned) {
    const issue = cardIssue(text);
    if (issue) return issue;
  }
  if (cardImportTextProblem(text, maxLength) !== null) return cardIssue(text) ?? 'text-not-canonical';
  // Redaction and tidying must both leave it unchanged: then it is already in the stored form.
  if (redactCardNumbers(text) !== text || tidy(text) !== text) return 'text-not-canonical';
  return null;
}

export type CardSyncTextProblem =
  | 'not-a-string'
  | 'invalid-limit'
  | 'raw-too-long'
  | 'card-secret'
  | 'card-data'
  | 'not-canonical'
  | 'unstable';

export type CardSyncTextResult =
  | {
    ok: true;
    /** Canonical redacted text, or null when nothing is left. */
    text: string | null;
    /** Card data or a long digit run was replaced by `***` and its last four symbols. */
    redacted: boolean;
    /** The redacted text was longer than `maxLength` and was cut. */
    truncated: boolean;
  }
  | { ok: false; problem: CardSyncTextProblem };

function redactPass(text: string): string {
  const redacted = redactCardNumbers(tidy(text));
  return tidy(redacted.replace(LONG_RUN_ALL, (run) => `***${run.slice(-4)}`));
}

function cut(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = maxLength;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

function neutralizeFormula(text: string, maxLength: number): string {
  return FORMULA_START.test(text) ? cut(`'${text}`, maxLength) : text;
}

/** Applies `step` until the text stops changing; null when it does not settle. */
function settle(text: string, step: (text: string) => string): string | null {
  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = step(current);
    if (next === current) return current;
    current = next;
  }
  return null;
}

function refuse(problem: CardSyncTextProblem): CardSyncTextResult {
  return { ok: false, problem };
}

/**
 * Issuer text to a payload field with limit `maxLength`, for adapters:
 * 1. refuses raw text longer than `CARD_SYNC_RAW_TEXT_MAX` (never cut raw);
 * 2. refuses card secrets (security codes, PINs, expiry dates): they are never redacted;
 * 3. normalizes and redacts the complete text until it stops changing;
 * 4. scans again, then cuts only the redacted text to `maxLength` (never
 *    inside a surrogate pair) and neutralizes a leading `= + - @` with `'`;
 * 5. redacts, cuts and scans again until stable, then requires
 *    `cardSyncTextIssue` to accept the result.
 * Returns `text: null` for text that is empty once normalized.
 */
export function prepareCardSyncText(raw: string, maxLength: number): CardSyncTextResult {
  if (typeof raw !== 'string') return refuse('not-a-string');
  if (!Number.isSafeInteger(maxLength) || maxLength < 8 || maxLength > CARD_SYNC_RAW_TEXT_MAX) return refuse('invalid-limit');
  if (raw.length > CARD_SYNC_RAW_TEXT_MAX) return refuse('raw-too-long');
  if (containsCardSecret(raw)) return refuse('card-secret');

  const whole = settle(raw, redactPass);
  if (whole === null) return refuse('unstable');
  if (containsCardSecret(whole)) return refuse('card-secret');
  if (containsCardData(whole) || containsLongDigitRun(whole)) return refuse('card-data');
  const redacted = whole !== tidy(raw);
  const truncated = whole.length > maxLength;

  const text = settle(whole, (current) => neutralizeFormula(cut(redactPass(current), maxLength), maxLength));
  if (text === null) return refuse('unstable');
  if (text === '') return { ok: true, text: null, redacted, truncated };
  if (containsCardSecret(text)) return refuse('card-secret');
  const issue = cardSyncTextIssue(text, maxLength);
  if (issue === 'card-data') return refuse('card-data');
  if (issue !== null) return refuse('not-canonical');
  return { ok: true, text, redacted, truncated };
}
