import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CARD_IMPORT_KINDS, CARD_IMPORT_MAX_AMOUNT_MINOR } from '../cardImport.js';
import type { CardTransactionKind } from '../types.js';
import {
  cardAmountFromDirection,
  cardAmountFromIssuerSigned,
  cardAmountSignAllowed,
  CARD_SYNC_KIND_SIGNS,
  parseDecimalToMinor,
  parseJsonNumberToMinor,
  type CardAmountDirection,
  type DecimalAmountProblem,
} from './amounts.js';

function minor(text: string, exponent = 2, grouping?: 'none' | 'comma'): number {
  const result = parseDecimalToMinor(text, exponent, grouping ? { grouping } : {});
  assert.ok(result.ok, `${text}: ${result.ok ? '' : result.problem}`);
  return result.minor;
}

function problem(text: unknown, exponent = 2, grouping?: 'none' | 'comma'): DecimalAmountProblem {
  const result = parseDecimalToMinor(text as string, exponent, grouping ? { grouping } : {});
  assert.equal(result.ok, false, String(text));
  return result.ok ? ('none' as DecimalAmountProblem) : result.problem;
}

describe('parseDecimalToMinor', () => {
  it('reads plain decimals exactly', () => {
    assert.equal(minor('0'), 0);
    assert.equal(minor('0.5'), 50);
    assert.equal(minor('12.34'), 1234);
    assert.equal(minor('12.3'), 1230);
    assert.equal(minor('-12.34'), -1234);
    assert.equal(minor('+7'), 700);
    assert.equal(minor('99999999.99'), CARD_IMPORT_MAX_AMOUNT_MINOR);
    assert.equal(minor('-99999999.99'), -CARD_IMPORT_MAX_AMOUNT_MINOR);
    assert.equal(minor('9999999999', 0), CARD_IMPORT_MAX_AMOUNT_MINOR);
    assert.equal(minor('1.234', 3), 1234);
    assert.equal(minor('31200', 0), 31200);
    assert.equal(minor('1,234.56', 2, 'comma'), 123456);
    assert.equal(minor('12,345,678.90', 2, 'comma'), 1234567890);
    assert.ok(Object.is(minor('-0.00'), 0));
    assert.ok(Object.is(minor('-0'), 0));
  });

  it('refuses everything unusual instead of guessing', () => {
    const cases: Array<[unknown, number, 'none' | 'comma' | undefined, DecimalAmountProblem]> = [
      [12.34, 2, undefined, 'not-a-string'],
      ['1', 5, undefined, 'invalid-exponent'],
      ['1', -1, undefined, 'invalid-exponent'],
      ['1', 1.5, undefined, 'invalid-exponent'],
      ['', 2, undefined, 'empty'],
      [' 1.00', 2, undefined, 'whitespace'],
      ['1.00\u00a0', 2, undefined, 'whitespace'],
      ['1e3', 2, undefined, 'exponent-notation'],
      ['1E-2', 2, undefined, 'exponent-notation'],
      ['1-', 2, undefined, 'misplaced-sign'],
      ['--1', 2, undefined, 'misplaced-sign'],
      ['+-1', 2, undefined, 'misplaced-sign'],
      ['1\u22122', 2, undefined, 'misplaced-sign'],
      ['-', 2, undefined, 'missing-digits'],
      ['.5', 2, undefined, 'missing-digits'],
      ['12.', 2, undefined, 'missing-digits'],
      ['007', 2, undefined, 'leading-zero'],
      ['00.50', 2, undefined, 'leading-zero'],
      ['1.234', 2, undefined, 'too-many-decimals'],
      ['1.230', 2, undefined, 'too-many-decimals'],
      ['1.0', 0, undefined, 'too-many-decimals'],
      ['1.2.3', 2, undefined, 'ambiguous-separator'],
      ['1,234.56', 2, undefined, 'ambiguous-separator'],
      ['1,23', 2, 'comma', 'ambiguous-separator'],
      ['12,345,6', 2, 'comma', 'ambiguous-separator'],
      ['1234,567', 2, 'comma', 'ambiguous-separator'],
      [',123', 2, 'comma', 'ambiguous-separator'],
      ['01,234', 2, 'comma', 'ambiguous-separator'],
      ['1.234,56', 2, 'comma', 'ambiguous-separator'],
      ['$12.00', 2, undefined, 'invalid-character'],
      ['(12.00)', 2, undefined, 'invalid-character'],
      ['12.00 USD'.replace(' ', ''), 2, undefined, 'invalid-character'],
      ['\u0661\u0662', 2, undefined, 'invalid-character'],
      ['\uff11\uff12', 2, undefined, 'invalid-character'],
      ['0x10', 2, undefined, 'invalid-character'],
      ['Infinity', 2, undefined, 'invalid-character'],
      ['NaN', 2, undefined, 'invalid-character'],
      ['10000000000', 0, undefined, 'out-of-range'],
      ['100000000.00', 2, undefined, 'out-of-range'],
      ['9'.repeat(30), 2, undefined, 'out-of-range'],
      ['1'.repeat(65), 0, undefined, 'out-of-range'],
    ];
    for (const [text, exponent, grouping, expected] of cases) assert.equal(problem(text, exponent, grouping), expected, String(text));
  });

  it('agrees with exact integer arithmetic for every exponent', () => {
    let state = 2026;
    const random = () => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state / 4_294_967_296;
    };
    for (let round = 0; round < 5_000; round += 1) {
      const exponent = round % 4;
      const value = BigInt(Math.floor(random() * 2 * CARD_IMPORT_MAX_AMOUNT_MINOR) - CARD_IMPORT_MAX_AMOUNT_MINOR);
      const magnitude = value < 0n ? -value : value;
      const scale = 10n ** BigInt(exponent);
      const whole = (magnitude / scale).toString();
      const fraction = exponent === 0 ? '' : `.${(magnitude % scale).toString().padStart(exponent, '0')}`;
      const text = `${value < 0n ? '-' : ''}${whole}${fraction}`;
      assert.equal(minor(text, exponent), Number(value), text);
    }
  });
});

describe('parseJsonNumberToMinor', () => {
  it('uses the number’s shortest decimal text, never float multiplication', () => {
    assert.equal((parseJsonNumberToMinor(12.34, 2) as { minor: number }).minor, 1234);
    assert.equal((parseJsonNumberToMinor(1234.5, 2) as { minor: number }).minor, 123450);
    assert.equal((parseJsonNumberToMinor(-0.07, 2) as { minor: number }).minor, -7);
    assert.ok(Object.is((parseJsonNumberToMinor(-0, 2) as { minor: number }).minor, 0));
    // 1.005 * 100 is 100.49999999999999 in floating point; the text 1.005 is refused, not rounded.
    assert.deepEqual(parseJsonNumberToMinor(1.005, 2), { ok: false, problem: 'too-many-decimals' });
    assert.deepEqual(parseJsonNumberToMinor(0.1 + 0.2, 2), { ok: false, problem: 'too-many-decimals' });
    assert.deepEqual(parseJsonNumberToMinor(1e21, 2), { ok: false, problem: 'exponent-notation' });
    assert.deepEqual(parseJsonNumberToMinor(1e-7, 2), { ok: false, problem: 'exponent-notation' });
    assert.deepEqual(parseJsonNumberToMinor(Number.NaN, 2), { ok: false, problem: 'not-a-number' });
    assert.deepEqual(parseJsonNumberToMinor('12.34' as unknown as number, 2), { ok: false, problem: 'not-a-number' });
  });
});

describe("Holdr's sign convention", () => {
  it('signs explicit debit and credit magnitudes', () => {
    assert.deepEqual(cardAmountFromDirection(1234, 'debit'), { ok: true, minor: 1234 });
    assert.deepEqual(cardAmountFromDirection(1234, 'credit'), { ok: true, minor: -1234 });
    assert.ok(Object.is((cardAmountFromDirection(0, 'credit') as { minor: number }).minor, 0));
    assert.deepEqual(cardAmountFromDirection(-1, 'debit'), { ok: false, problem: 'misplaced-sign' });
    assert.deepEqual(cardAmountFromDirection(1.5, 'debit'), { ok: false, problem: 'misplaced-sign' });
    assert.deepEqual(cardAmountFromDirection(CARD_IMPORT_MAX_AMOUNT_MINOR + 1, 'debit'), { ok: false, problem: 'out-of-range' });
    assert.deepEqual(cardAmountFromDirection(1, 'sideways' as CardAmountDirection), { ok: false, problem: 'invalid-character' });
  });

  it('keeps or flips amounts the issuer already signs, by declared convention', () => {
    assert.deepEqual(cardAmountFromIssuerSigned(500, 'debit-positive'), { ok: true, minor: 500 });
    assert.deepEqual(cardAmountFromIssuerSigned(-500, 'debit-positive'), { ok: true, minor: -500 });
    assert.deepEqual(cardAmountFromIssuerSigned(500, 'credit-positive'), { ok: true, minor: -500 });
    assert.ok(Object.is((cardAmountFromIssuerSigned(-0, 'debit-positive') as { minor: number }).minor, 0));
    assert.ok(Object.is((cardAmountFromIssuerSigned(0, 'credit-positive') as { minor: number }).minor, 0));
    assert.deepEqual(cardAmountFromIssuerSigned(0.5, 'debit-positive'), { ok: false, problem: 'not-a-number' });
    assert.deepEqual(cardAmountFromIssuerSigned(-1e10, 'debit-positive'), { ok: false, problem: 'out-of-range' });
  });

  it('requires purchases, fees and interest positive and refunds negative; the rest may be either', () => {
    const expected: Record<CardTransactionKind, [boolean, boolean, boolean]> = {
      purchase: [false, false, true],
      fee: [false, false, true],
      interest: [false, false, true],
      refund: [true, false, false],
      payment: [true, true, true],
      adjustment: [true, true, true],
      other: [true, true, true],
    };
    for (const kind of CARD_IMPORT_KINDS) {
      assert.deepEqual([-1, 0, 1].map((amount) => cardAmountSignAllowed(kind, amount)), expected[kind], kind);
    }
    assert.deepEqual(Object.keys(CARD_SYNC_KIND_SIGNS).sort(), [...CARD_IMPORT_KINDS].sort());
    for (const kind of ['toString', '__proto__', 'constructor', 'transfer']) assert.equal(cardAmountSignAllowed(kind as CardTransactionKind, 1), false);
  });
});
