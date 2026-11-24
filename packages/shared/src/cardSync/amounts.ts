/**
 * Amounts for card-sync adapters: issuer decimal text becomes Holdr's signed
 * integer minor units by string arithmetic only (never `parseFloat` or
 * multiplying a float by 100), and anything unusual is refused rather than
 * guessed: exponent notation, more decimals than the currency has, signs
 * anywhere but the front, whitespace, currency symbols, ambiguous thousands
 * separators and amounts beyond v1's bounds.
 *
 * Holdr's sign: positive = money spent (purchase, fee, interest); negative =
 * money back (refund, payment, credit). Issuers disagree, so every adapter
 * states its source convention explicitly through the helpers below.
 */
import { CARD_IMPORT_MAX_AMOUNT_MINOR } from '../cardImport.js';
import type { CardTransactionKind } from '../types.js';

export type DecimalAmountProblem =
  | 'not-a-string'
  | 'not-a-number'
  | 'invalid-exponent'
  | 'empty'
  | 'whitespace'
  | 'exponent-notation'
  | 'misplaced-sign'
  | 'invalid-character'
  | 'missing-digits'
  | 'leading-zero'
  | 'too-many-decimals'
  | 'ambiguous-separator'
  | 'out-of-range';

export type DecimalAmountResult = { ok: true; minor: number } | { ok: false; problem: DecimalAmountProblem };

export interface DecimalAmountOptions {
  /**
   * `none` (default): digits, an optional `.` and decimals; any comma is refused.
   * `comma`: also `1,234.56`, where every group after the first has exactly three
   * digits and the first has one to three without a leading zero.
   */
  grouping?: 'none' | 'comma';
}

/** Largest ISO 4217 minor-unit exponent (CLF, UYW). */
export const CARD_SYNC_MAX_EXPONENT = 4;

const GROUPED = /^[1-9][0-9]{0,2}(?:,[0-9]{3})+$/;

function fail(problem: DecimalAmountProblem): DecimalAmountResult {
  return { ok: false, problem };
}

/**
 * Parses issuer decimal text such as `12.34`, `-0.5` or `1,234.56` (with
 * `grouping: 'comma'`) into signed integer minor units for a currency with
 * `exponent` decimals, keeping the text's own sign. One leading `+` or `-` is
 * allowed; whole digits are required (`.5` and `12.` are refused), as is the
 * absence of leading zeros (`007`). The result never exceeds v1's bound of
 * 9,999,999,999 minor units and is never -0.
 */
export function parseDecimalToMinor(text: string, exponent: number, options: DecimalAmountOptions = {}): DecimalAmountResult {
  if (typeof text !== 'string') return fail('not-a-string');
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > CARD_SYNC_MAX_EXPONENT) return fail('invalid-exponent');
  if (text.length === 0) return fail('empty');
  if (text.length > 64) return fail('out-of-range');
  if (/\s/u.test(text)) return fail('whitespace');
  if (/[eE]/.test(text)) return fail('exponent-notation');
  let body = text;
  let negative = false;
  if (body[0] === '-' || body[0] === '+') {
    negative = body[0] === '-';
    body = body.slice(1);
  }
  if (/[+\-\u2212]/.test(body)) return fail('misplaced-sign');
  if (body.length === 0) return fail('missing-digits');
  if (!/^[0-9.,]+$/.test(body)) return fail('invalid-character');
  const point = body.indexOf('.');
  if (point !== body.lastIndexOf('.')) return fail('ambiguous-separator');
  let whole = point === -1 ? body : body.slice(0, point);
  const fraction = point === -1 ? null : body.slice(point + 1);
  if (fraction !== null && fraction.includes(',')) return fail('ambiguous-separator');
  if (whole.includes(',')) {
    if (options.grouping !== 'comma' || !GROUPED.test(whole)) return fail('ambiguous-separator');
    whole = whole.replace(/,/g, '');
  }
  if (whole.length === 0 || fraction === '') return fail('missing-digits');
  if (whole.length > 1 && whole[0] === '0') return fail('leading-zero');
  if (fraction !== null && fraction.length > exponent) return fail('too-many-decimals');
  const digits = `${whole}${(fraction ?? '').padEnd(exponent, '0')}`.replace(/^0+(?=[0-9])/, '');
  if (digits.length > String(CARD_IMPORT_MAX_AMOUNT_MINOR).length) return fail('out-of-range');
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor) || minor > CARD_IMPORT_MAX_AMOUNT_MINOR) return fail('out-of-range');
  return { ok: true, minor: negative && minor !== 0 ? -minor : minor };
}

/**
 * For issuer JSON that carries amounts as numbers (`12.34`): reads the
 * number's shortest round-trip decimal text and parses that, so `12.34`
 * becomes 1234 exactly. Float artifacts such as `0.30000000000000004`, and
 * values JavaScript prints in exponent notation, are refused.
 */
export function parseJsonNumberToMinor(value: number, exponent: number): DecimalAmountResult {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail('not-a-number');
  return parseDecimalToMinor(String(value), exponent);
}

// ---------------------------------------------------------------------------
// Holdr's sign convention
// ---------------------------------------------------------------------------

/** `debit`: money spent (purchase, fee, interest). `credit`: money back (refund, payment, cashback). */
export type CardAmountDirection = 'debit' | 'credit';

/** How an issuer field signs amounts that it already signs itself. */
export type IssuerSignConvention = 'debit-positive' | 'credit-positive';

/**
 * Holdr's signed amount from an unsigned magnitude and an explicit direction
 * (Chase `creditDebitCode`, Amex REST `type`, Wells Fargo debit and credit
 * columns): debit is positive, credit negative. The magnitude must already
 * be a non-negative integer within v1's bound; a signed one is refused
 * rather than flipped twice.
 */
export function cardAmountFromDirection(magnitudeMinor: number, direction: CardAmountDirection): DecimalAmountResult {
  if (!Number.isSafeInteger(magnitudeMinor) || magnitudeMinor < 0) return fail('misplaced-sign');
  if (magnitudeMinor > CARD_IMPORT_MAX_AMOUNT_MINOR) return fail('out-of-range');
  if (direction === 'debit') return { ok: true, minor: magnitudeMinor };
  if (direction === 'credit') return { ok: true, minor: magnitudeMinor === 0 ? 0 : -magnitudeMinor };
  return fail('invalid-character');
}

/**
 * Holdr's signed amount from an amount the issuer already signs, given the
 * issuer's convention for that field (each adapter contract fixes it after
 * testing purchases, refunds and payments): `debit-positive` keeps the sign,
 * `credit-positive` flips it.
 */
export function cardAmountFromIssuerSigned(signedMinor: number, convention: IssuerSignConvention): DecimalAmountResult {
  if (!Number.isSafeInteger(signedMinor)) return fail('not-a-number');
  if (Math.abs(signedMinor) > CARD_IMPORT_MAX_AMOUNT_MINOR) return fail('out-of-range');
  if (convention === 'debit-positive') return { ok: true, minor: signedMinor + 0 };
  if (convention === 'credit-positive') return { ok: true, minor: signedMinor === 0 ? 0 : -signedMinor };
  return fail('invalid-character');
}

/**
 * Sign each kind must have in contract version 1. Purchases, fees and
 * interest are money spent; a refund is money back. Payments may be negative
 * (a payment) or positive (a returned payment, as v1's classifier files it);
 * adjustments and other rows may have either sign or be zero.
 */
export const CARD_SYNC_KIND_SIGNS: Readonly<Record<CardTransactionKind, 'positive' | 'negative' | 'any'>> = Object.freeze({
  purchase: 'positive',
  fee: 'positive',
  interest: 'positive',
  refund: 'negative',
  payment: 'any',
  adjustment: 'any',
  other: 'any',
});

/** True when `amountMinor` has the sign `kind` requires (see `CARD_SYNC_KIND_SIGNS`). */
export function cardAmountSignAllowed(kind: CardTransactionKind, amountMinor: number): boolean {
  if (!Object.prototype.hasOwnProperty.call(CARD_SYNC_KIND_SIGNS, kind) || typeof amountMinor !== 'number') return false;
  const sign = CARD_SYNC_KIND_SIGNS[kind];
  if (sign === 'positive') return amountMinor > 0;
  if (sign === 'negative') return amountMinor < 0;
  return true;
}
