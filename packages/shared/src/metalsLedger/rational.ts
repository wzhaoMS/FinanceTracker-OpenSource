/**
 * Exact rationals for the metals ledger: fine content in troy ounces, unit conversions and purity products are kept as
 * fractions of arbitrary-precision integers, so sums of ounces are exact and every identity holds without rounding.
 * Only display rounds, and it says so. Pure: no file system, network or clock.
 */

export interface Rational {
  /** Numerator; carries the sign. */
  readonly num: bigint;
  /** Denominator; always positive. */
  readonly den: bigint;
}

const abs = (value: bigint) => (value < 0n ? -value : value);

function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** A rational in lowest terms with a positive denominator. Throws on a zero denominator. */
export function rational(num: bigint, den: bigint = 1n): Rational {
  if (den === 0n) throw new RangeError('rational: zero denominator');
  if (num === 0n) return Object.freeze({ num: 0n, den: 1n });
  const sign = den < 0n ? -1n : 1n;
  const divisor = gcd(num, den);
  return Object.freeze({ num: (sign * num) / divisor, den: (sign * den) / divisor });
}

export const ZERO: Rational = rational(0n);
export const ONE: Rational = rational(1n);
/** Grams in one troy ounce, exactly: 31.1034768 g. */
export const GRAMS_PER_TROY_OUNCE: Rational = rational(311_034_768n, 10_000_000n);

export const add = (a: Rational, b: Rational): Rational => rational(a.num * b.den + b.num * a.den, a.den * b.den);
export const subtract = (a: Rational, b: Rational): Rational => rational(a.num * b.den - b.num * a.den, a.den * b.den);
export const multiply = (a: Rational, b: Rational): Rational => rational(a.num * b.num, a.den * b.den);
export function divide(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new RangeError('rational: division by zero');
  return rational(a.num * b.den, a.den * b.num);
}
export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
}
export const equals = (a: Rational, b: Rational): boolean => a.num === b.num && a.den === b.den;
export function sum(values: Iterable<Rational>): Rational {
  let total = ZERO;
  for (const value of values) total = add(total, value);
  return total;
}

/**
 * Reads an exact, unsigned decimal or fraction as written: "1", "0.5", "31.1", "1/10", "1 1/2" (a whole number, one
 * space and a fraction), or null for anything else (no sign, exponent, separator or other script). Never rounds.
 */
export function parseRational(text: string): Rational | null {
  if (typeof text !== 'string') return null;
  let match = /^(\d{1,9})$/.exec(text);
  if (match) return rational(BigInt(match[1]));
  match = /^(\d{1,9})\.(\d{1,9})$/.exec(text);
  if (match) return rational(BigInt(match[1] + match[2]), 10n ** BigInt(match[2].length));
  match = /^(\d{1,9})\/(\d{1,9})$/.exec(text);
  if (match) return BigInt(match[2]) === 0n ? null : rational(BigInt(match[1]), BigInt(match[2]));
  match = /^(\d{1,9}) (\d{1,9})\/(\d{1,9})$/.exec(text);
  if (match) {
    const den = BigInt(match[3]);
    if (den === 0n) return null;
    return add(rational(BigInt(match[1])), rational(BigInt(match[2]), den));
  }
  return null;
}

/** "n/d" in lowest terms ("3/1" for a whole number): the stored and transported form. */
export const formatRational = (value: Rational): string => `${value.num}/${value.den}`;

/** The stored form back, or null unless the text is exactly formatRational's: lowest terms, positive denominator. */
export function readRational(text: string): Rational | null {
  const match = /^(-?\d{1,40})\/(\d{1,40})$/.exec(typeof text === 'string' ? text : '');
  if (!match) return null;
  const den = BigInt(match[2]);
  if (den === 0n) return null;
  const value = rational(BigInt(match[1]), den);
  return formatRational(value) === text ? value : null;
}

/** Rounds |num| / den to an integer, half to even. */
function roundHalfEven(numerator: bigint, den: bigint): bigint {
  let quotient = numerator / den;
  const twice = (numerator % den) * 2n;
  if (twice > den || (twice === den && quotient % 2n === 1n)) quotient += 1n;
  return quotient;
}

/**
 * The value rounded half to even at `decimals` places, as a decimal string ("3.215"), and whether rounding changed it.
 * Display only: nothing is ever computed from it.
 */
export function toDecimal(value: Rational, decimals: number): { text: string; exact: boolean } {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) throw new RangeError('rational: decimals 0–12');
  const scaled = abs(value.num) * 10n ** BigInt(decimals);
  const quotient = roundHalfEven(scaled, value.den);
  const digits = quotient.toString().padStart(decimals + 1, '0');
  const whole = decimals === 0 ? digits : digits.slice(0, -decimals);
  const fraction = decimals === 0 ? '' : `.${digits.slice(-decimals)}`;
  const sign = value.num < 0n && quotient !== 0n ? '-' : '';
  return { text: `${sign}${whole}${fraction}`, exact: scaled % value.den === 0n };
}

/**
 * An integer from a rational, rounded once, half to even: a value computed from exact ounces and a price is
 * round(oz × price) once, never per part.
 */
export function roundToInteger(value: Rational): bigint {
  const quotient = roundHalfEven(abs(value.num), value.den);
  return value.num < 0n ? -quotient : quotient;
}

/** Troy ounces in a stated mass: grams and kilograms by the exact definition; troy ounces as they are. */
export function troyOunces(value: Rational, unit: 'ozt' | 'g' | 'kg'): Rational {
  if (unit === 'ozt') return value;
  const grams = unit === 'kg' ? multiply(value, rational(1000n)) : value;
  return divide(grams, GRAMS_PER_TROY_OUNCE);
}

/**
 * Splits a whole number of minor units over weights by largest remainder: each part is floor(|total| × w / Σw), and
 * the units left over go one each to the largest remainders, ties to the lower index. Parts always add up to the total
 * exactly. Weights must be non-negative with a positive sum; a negative total is split by its magnitude and keeps its
 * sign.
 */
export function largestRemainder(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) throw new RangeError('largestRemainder: no weights');
  if (weights.some((weight) => weight < 0n)) throw new RangeError('largestRemainder: negative weight');
  const weightSum = weights.reduce((acc, weight) => acc + weight, 0n);
  if (weightSum === 0n) throw new RangeError('largestRemainder: zero weight sum');
  const magnitude = abs(total);
  const parts = weights.map((weight) => (magnitude * weight) / weightSum);
  const order = weights
    .map((weight, index) => ({ index, remainder: (magnitude * weight) % weightSum }))
    .sort((a, b) => (a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : a.index - b.index));
  let left = magnitude - parts.reduce((acc, part) => acc + part, 0n);
  for (const { index } of order) {
    if (left === 0n) break;
    parts[index] += 1n;
    left -= 1n;
  }
  return total < 0n ? parts.map((part) => -part) : parts;
}
