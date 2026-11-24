import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CARD_TEXT_FORBIDDEN_RANGES, containsLongDigitRun, LONG_DIGIT_RUN, normalizeCardText } from './cardText.js';

const ARABIC_INDIC_PAN = '\u0664\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661';

const FORBIDDEN = new Uint8Array(0x110000);
for (const [start, end] of CARD_TEXT_FORBIDDEN_RANGES) FORBIDDEN.fill(1, start, end + 1);

function isForbidden(code: number): boolean {
  return FORBIDDEN[code] === 1;
}

function hidesDigits(char: string): boolean {
  return /\p{Default_Ignorable_Code_Point}/u.test(char) || /\p{Nd}/u.test(char.normalize('NFKC'));
}

describe('card text normalization', () => {
  it('writes every decimal digit as ASCII and drops invisible characters', () => {
    assert.equal(normalizeCardText(ARABIC_INDIC_PAN), '4111111111111111');
    assert.equal(normalizeCardText('４１１１ ①② x²'), '4111 12 x2');
    assert.equal(normalizeCardText('4111\u200b1111\u20631111\u00ad1111\ufeff'), '4111111111111111');
    assert.equal(normalizeCardText('\u06f1\u0968\u09e9\u0e54\ud835\udfd3'), '12345');
    assert.equal(normalizeCardText('Café 東京 ☕'), 'Café 東京 ☕');
  });

  it('is idempotent', () => {
    for (const text of [ARABIC_INDIC_PAN, '４１１１ ①② x²', 'e\u200b\u0301', 'ＢＬＵＥ\u3000ＣＯＦＦＥＥ ⑳']) {
      assert.equal(normalizeCardText(normalizeCardText(text)), normalizeCardText(text), JSON.stringify(text));
    }
  });
});

describe('long digit runs', () => {
  it('flags 13 or more consecutive digits of any script, card number or not', () => {
    assert.equal(LONG_DIGIT_RUN, 13);
    const flagged = [
      'REF 1234567890123',
      '4111111111111111',
      'x4111111111111111003y',
      '１２３４５６７８９０１２３',
      '\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u0660\u0661\u0662\u0663',
      '123456\u200b7890123',
      '12345678901２3',
      ARABIC_INDIC_PAN,
    ];
    for (const text of flagged) assert.equal(containsLongDigitRun(text), true, JSON.stringify(text));
  });

  it('leaves shorter or separated runs to card detection', () => {
    for (const text of ['ORDER 123456789012', '4111 1111 1111 1111', '2026-10-16 12:30', '***1234', 'xid1:abcdefghijklmnop', '']) {
      assert.equal(containsLongDigitRun(text), false, JSON.stringify(text));
    }
  });

  it('stays fast on hostile input', () => {
    const started = Date.now();
    assert.equal(containsLongDigitRun('123456789012 '.repeat(50_000)), false);
    assert.equal(containsLongDigitRun('1'.repeat(1_000_000)), true);
    assert.ok(Date.now() - started < 5000);
  });
});

describe('characters forbidden in stored card text', () => {
  it('lists sorted, disjoint ranges outside ASCII', () => {
    let previous = 0x7f;
    for (const [start, end] of CARD_TEXT_FORBIDDEN_RANGES) {
      assert.ok(start > previous + 1 && end >= start, `${start.toString(16)}-${end.toString(16)}`);
      previous = end;
    }
  });

  it('covers the common digit scripts, compatibility digits and invisible characters', () => {
    const samples = {
      'Arabic-Indic': 0x0664, 'Extended Arabic-Indic': 0x06f4, Devanagari: 0x096a, Bengali: 0x09ea, Thai: 0x0e54,
      fullwidth: 0xff14, superscript: 0x00b2, circled: 0x2463, 'mathematical bold': 0x1d7d2, 'zero width space': 0x200b,
      'invisible separator': 0x2063, 'soft hyphen': 0x00ad, 'byte order mark': 0xfeff,
    };
    for (const [label, code] of Object.entries(samples)) assert.equal(isForbidden(code), true, label);
    for (const char of '0123456789 abcXYZ-./:#éß東€') assert.equal(isForbidden(char.codePointAt(0)!), false, char);
  });

  it('includes every character that can hide a digit, and normalization never emits one', () => {
    const missing: string[] = [];
    const leaked: string[] = [];
    for (let code = 0x80; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCodePoint(code);
      if (hidesDigits(char) && !isForbidden(code)) missing.push(code.toString(16));
      for (const out of normalizeCardText(char)) {
        if (isForbidden(out.codePointAt(0)!)) leaked.push(code.toString(16));
      }
    }
    assert.deepEqual(missing, [], 'extend CARD_TEXT_FORBIDDEN_RANGES for this Unicode version and bump the guard revision');
    assert.deepEqual(leaked, []);
  });
});
