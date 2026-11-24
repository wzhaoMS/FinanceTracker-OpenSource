import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  add,
  compare,
  divide,
  equals,
  formatRational,
  GRAMS_PER_TROY_OUNCE,
  largestRemainder,
  multiply,
  ONE,
  parseRational,
  rational,
  readRational,
  roundToInteger,
  subtract,
  sum,
  toDecimal,
  troyOunces,
  ZERO,
} from './rational.js';

describe('rationals', () => {
  it('keeps lowest terms with a positive denominator', () => {
    assert.deepEqual(rational(2n, 4n), { num: 1n, den: 2n });
    assert.deepEqual(rational(-2n, -4n), { num: 1n, den: 2n });
    assert.deepEqual(rational(2n, -4n), { num: -1n, den: 2n });
    assert.deepEqual(rational(0n, -7n), { num: 0n, den: 1n });
    assert.throws(() => rational(1n, 0n), RangeError);
  });

  it('adds, subtracts, multiplies, divides and compares exactly', () => {
    const third = rational(1n, 3n);
    assert.ok(equals(add(third, add(third, third)), ONE));
    assert.ok(equals(subtract(ONE, third), rational(2n, 3n)));
    assert.ok(equals(multiply(third, rational(3n)), ONE));
    assert.ok(equals(divide(ONE, third), rational(3n)));
    assert.throws(() => divide(ONE, ZERO), RangeError);
    assert.equal(compare(third, rational(1n, 2n)), -1);
    assert.equal(compare(rational(2n, 4n), rational(1n, 2n)), 0);
    assert.ok(equals(sum([rational(1n, 10n), rational(2n, 10n), rational(7n, 10n)]), ONE));
  });

  it('reads only exact unsigned decimals and fractions as written', () => {
    assert.deepEqual(parseRational('1'), rational(1n));
    assert.deepEqual(parseRational('0.5'), rational(1n, 2n));
    assert.deepEqual(parseRational('31.1'), rational(311n, 10n));
    assert.deepEqual(parseRational('1/10'), rational(1n, 10n));
    assert.deepEqual(parseRational('1 1/2'), rational(3n, 2n));
    for (const text of ['', '-1', '+1', '1e3', '1,000', '.5', '1.', '1/0', '1 1/0', ' 1', '1 ', '\uFF11', '\u0661', '1  1/2']) {
      assert.equal(parseRational(text), null, JSON.stringify(text));
    }
  });

  it('round-trips the stored "n/d" form and refuses anything not in lowest terms', () => {
    const value = rational(10_000_000n, 311_034_768n);
    assert.deepEqual(readRational(formatRational(value)), value);
    assert.equal(formatRational(rational(3n)), '3/1');
    for (const text of ['2/4', '1/-2', '1/0', '1', '1.5/2', ' 1/2', '-0/1', '01/2']) assert.equal(readRational(text), null, text);
    assert.deepEqual(readRational('-1/2'), rational(-1n, 2n));
  });

  it('converts grams and kilograms to troy ounces by the exact definition', () => {
    assert.deepEqual(GRAMS_PER_TROY_OUNCE, rational(311_034_768n, 10_000_000n));
    assert.ok(equals(troyOunces(rational(311_034_768n, 10_000_000n), 'g'), ONE));
    assert.ok(equals(troyOunces(ONE, 'ozt'), ONE));
    assert.ok(equals(troyOunces(ONE, 'kg'), divide(rational(1000n), GRAMS_PER_TROY_OUNCE)));
    assert.equal(toDecimal(troyOunces(rational(100n), 'g'), 4).text, '3.2151');
  });

  it('rounds for display half to even, and says when rounding changed the value', () => {
    assert.deepEqual(toDecimal(rational(1n, 8n), 2), { text: '0.12', exact: false });
    assert.deepEqual(toDecimal(rational(3n, 8n), 2), { text: '0.38', exact: false });
    assert.deepEqual(toDecimal(rational(5n, 2n), 0), { text: '2', exact: false });
    assert.deepEqual(toDecimal(rational(7n, 2n), 0), { text: '4', exact: false });
    assert.deepEqual(toDecimal(rational(1n, 4n), 3), { text: '0.250', exact: true });
    assert.deepEqual(toDecimal(rational(-1n, 4n), 1), { text: '-0.2', exact: false });
    assert.deepEqual(toDecimal(rational(-1n, 1000n), 2), { text: '0.00', exact: false });
  });

  it('rounds to an integer once, half to even', () => {
    assert.equal(roundToInteger(rational(5n, 2n)), 2n);
    assert.equal(roundToInteger(rational(7n, 2n)), 4n);
    assert.equal(roundToInteger(rational(-5n, 2n)), -2n);
    assert.equal(roundToInteger(rational(10n, 3n)), 3n);
  });

  it('splits by largest remainder, parts adding up exactly, ties to the lower index', () => {
    assert.deepEqual(largestRemainder(1n, [1n, 1n]), [1n, 0n]);
    assert.deepEqual(largestRemainder(10n, [1n, 1n, 1n]), [4n, 3n, 3n]);
    assert.deepEqual(largestRemainder(-10n, [1n, 1n, 1n]), [-4n, -3n, -3n]);
    assert.deepEqual(largestRemainder(100n, [0n, 3n, 1n]), [0n, 75n, 25n]);
    assert.throws(() => largestRemainder(1n, []), RangeError);
    assert.throws(() => largestRemainder(1n, [0n, 0n]), RangeError);
    assert.throws(() => largestRemainder(1n, [1n, -1n]), RangeError);
    for (let seed = 1; seed < 400; seed += 1) {
      const weights = [BigInt(seed % 7), BigInt((seed * 13) % 11), BigInt((seed * 7) % 5) + 1n];
      const total = BigInt(seed * 37 - 5000);
      const parts = largestRemainder(total, weights);
      assert.equal(parts.reduce((acc, part) => acc + part, 0n), total);
    }
  });
});
