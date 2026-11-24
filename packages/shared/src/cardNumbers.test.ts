import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cardLast4, cardNetwork, containsCardData, containsCardNumber, findCardNumberPaths, findCardNumbers,
  isCardNumberField, isCardSecretField, luhnValid, redactCardNumbers,
} from './cardNumbers.js';

// Public test numbers published by the card networks and payment processors; none are real accounts.
const TEST_CARDS = {
  visa: ['4111111111111111', '4012888888881881', '4222222222222'],
  mastercard: ['5555555555554444', '2223003122003222'],
  amex: ['378282246310005', '371449635398431'],
  discover: ['6011111111111117', '6011000990139424'],
  diners: ['30569309025904', '38520000023237'],
  jcb: ['3530111333300000', '3566002020360505'],
  unionpay: ['6200000000000005'],
  maestro: ['6759649826438453', '6304000000000000'],
} as const;

describe('card number detection', () => {
  it('validates the Luhn checksum', () => {
    assert.equal(luhnValid('4111111111111111'), true);
    assert.equal(luhnValid('4111111111111112'), false);
    assert.equal(luhnValid('4111 1111 1111 1111'), false, 'separators are not digits');
    assert.equal(luhnValid(''), false);
  });

  it('recognizes each network by prefix and length', () => {
    for (const [network, numbers] of Object.entries(TEST_CARDS)) {
      for (const number of numbers) {
        assert.equal(cardNetwork(number), network, number);
        assert.deepEqual(findCardNumbers(`paid with ${number}.`), [{ network, last4: number.slice(-4) }], number);
      }
    }
    assert.equal(cardNetwork('37828224648222'), null, 'Amex must be 15 digits');
    assert.equal(cardNetwork('411111111111'), null, 'too short');
    assert.equal(cardNetwork('9111111111111111'), null, 'unknown prefix');
    assert.equal(cardNetwork('501800000009'), 'maestro', '12-digit Maestro');
    assert.equal(cardNetwork('4111111111111114254'), 'visa', '19-digit Visa');
  });

  it('flags UnionPay numbers even without a Luhn check digit', () => {
    assert.equal(luhnValid('6212345678901234'), false);
    assert.deepEqual(findCardNumbers('UnionPay 6212 3456 7890 1234'), [{ network: 'unionpay', last4: '1234' }]);
  });

  it('finds grouped, Unicode, and zero-width-split numbers', () => {
    const variants = [
      '4111 1111 1111 1111',
      '4111-1111-1111-1111',
      '4111  1111  1111  1111',
      '4111 - 1111 - 1111 - 1111',
      '4111\t1111\t1111\t1111',
      '4111\n1111\n1111\n1111',
      '4111\u20101111\u20101111\u20101111',
      '4111\u22121111\u22121111\u22121111',
      '3782 822463 10005',
      '４１１１１１１１１１１１１１１１',
      '\u0664\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661',
      '4111\u00a01111\u00a01111\u00a01111',
      '4111\u200b1111\u200b1111\u200b1111',
      'CARD4111111111111111END',
      'Card 1 4111 1111 1111 1111',
    ];
    for (const text of variants) assert.equal(containsCardNumber(text), true, JSON.stringify(text));
  });

  it('ignores dates, amounts, phone numbers, failed checksums and long references', () => {
    const clean = [
      '2026-10-16 AMAZON MKTP US*AB12CD34E 123.45',
      'Call 1-800-528-4800 or 425-555-0100',
      'Order 4111111111111112',
      'Reference 320252940123456789012',
      'Points 12345678901',
      'Statement 10/15/2026 balance $4,111.11',
    ];
    for (const text of clean) assert.equal(containsCardNumber(text), false, text);
    // None of these is a card number, but a long reference is still a card-length span of digits, so redaction
    // drops it: accepted over-redaction under the span policy.
    assert.equal(redactCardNumbers('Reference 320252940123456789012'), 'Reference ***9012');
    assert.equal(redactCardNumbers('Order 4111111111111112'), 'Order ***1112');
  });

  it('finds several numbers and never returns more than the last four digits', () => {
    const matches = findCardNumbers('4111 1111 1111 1111 then 5555-5555-5555-4444');
    assert.deepEqual(matches, [{ network: 'visa', last4: '1111' }, { network: 'mastercard', last4: '4444' }]);
    assert.ok(!JSON.stringify(matches).includes('411111'));
  });
});

describe('card number redaction', () => {
  it('reduces full numbers to the last four digits, preferring the longest valid number', () => {
    assert.equal(redactCardNumbers('Card 3782 822463 87649 charged'), 'Card ***7649 charged');
    assert.equal(redactCardNumbers('a 4111111111111111 b 5555555555554444'), 'a ***1111 b ***4444');
    assert.equal(redactCardNumbers('4111 1111 1111 1111 797'), '***1797');
  });

  it('reduces masked identifiers that reveal more than the last four digits', () => {
    assert.equal(redactCardNumbers('411111******1111'), '***1111');
    assert.equal(redactCardNumbers('Amex 411111******1111'), 'Amex ***1111');
    assert.equal(redactCardNumbers('Account # XXXX-XXXXXX-90003'), 'Account # ***0003');
    assert.equal(redactCardNumbers('XXXX-XXXXXX-90003 2026-10-16'), '***0003 2026-10-16');
    assert.equal(redactCardNumbers('4111 XXXX XXXX 1111 paid'), '***1111 paid');
    assert.equal(containsCardData('411111******1111'), true);
    // A mask followed by five digits shows more than the last four, whatever the length (rule h).
    assert.equal(redactCardNumbers('(XXXX-90003)'), '(***0003)');
    assert.equal(containsCardData('XXXX-90003'), true);
  });

  it('leaves ordinary text and last-four-only forms alone', () => {
    const texts = ['Xbox Live 14.99', 'Tax 2026-10-16', 'Ending in 1234', '•••• 1234', '**** **** **** 4444',
      'AMAZON MKTP US*AB12CD34E'];
    for (const text of texts) {
      assert.equal(redactCardNumbers(text), text);
      assert.equal(containsCardData(text), false, text);
    }
    // Card-length spans that show five or more digits are redacted even when they are not cards: accepted
    // over-redaction under the span policy.
    assert.equal(redactCardNumbers('Model x 1234567890123'), 'Model ***0123');
    assert.equal(redactCardNumbers('Paid 25 XXXX XXXX XXXX 1234'), 'Paid ***1234');
  });

  it('stays fast on hostile input', () => {
    const started = Date.now();
    // Long runs of digits are card-length spans, so these are card data under the span policy.
    assert.equal(containsCardData('1 '.repeat(200_000)), true);
    assert.equal(redactCardNumbers('X'.repeat(200_000)), 'X'.repeat(200_000));
    assert.equal(containsCardNumber('-'.repeat(100_000) + '9'.repeat(100_000)), false);
    assert.equal(redactCardNumbers(')'.repeat(100_000) + 'a'), ')'.repeat(100_000) + 'a');
    assert.equal(containsCardData('1'.repeat(100_000) + 'XX'), true);
    assert.ok(Date.now() - started < 5000);
  });

  it('leaves no detectable card number behind', () => {
    const text = Object.values(TEST_CARDS).flat().join(' / ');
    assert.equal(containsCardNumber(redactCardNumbers(text)), false);
  });
});

describe('card identifiers and fields', () => {
  it('extracts the last four digits from issuer identifiers', () => {
    assert.equal(cardLast4('XXXX-XXXXXX-90003'), '0003');
    assert.equal(cardLast4('Platinum Card (-90003)'), '0003');
    assert.equal(cardLast4('Ending in 1234.'), '1234');
    assert.equal(cardLast4('4111 1111 1111 1111'), '1111');
    assert.equal(cardLast4('Card 12'), null);
  });

  it('reports paths, not values, for card data in nested values, numbers and keys', () => {
    const payload = {
      account: { display: 'XXXX-XXXXXX-90003', number: '378282246310005' },
      rows: [{ memo: 'ok' }, { memo: 'paid 4111 1111 1111 1111' }],
      raw: 4111111111111111,
      rounded: Number('4000000000000000006'),
      byAccount: { '5555555555554444': { balance: 1 }, 'ref 98765432': { memo: '4111111111111111' } },
    };
    const paths = findCardNumberPaths(payload);
    assert.deepEqual(paths, [
      '$.account.display', '$.account.number', '$.rows[1].memo', '$.raw', '$.rounded',
      '$.byAccount.<card number>', '$.byAccount.<key>.memo',
    ]);
    assert.ok(!paths.join(' ').match(/\d{5}/));
    assert.deepEqual(findCardNumberPaths({ amount: 12.34, cents: -123456, memo: 'coffee', when: '2026-10-16' }), []);
  });

  it('fails closed on cyclic, deep, or oversized input', () => {
    const cyclic: Record<string, unknown> = { memo: 'ok' };
    cyclic.self = cyclic;
    assert.deepEqual(findCardNumberPaths(cyclic), ['$<limit>']);
    let deep: unknown = 'leaf';
    for (let i = 0; i < 100; i += 1) deep = { next: deep };
    assert.deepEqual(findCardNumberPaths(deep), ['$<limit>']);
    assert.deepEqual(findCardNumberPaths(Array.from({ length: 60_000 }, () => 1)), ['$<limit>']);
    assert.deepEqual(findCardNumberPaths(['x'.repeat(6_000_000)]), ['$<limit>']);
  });

  it('classifies secret and card-number columns without catching look-alikes', () => {
    for (const name of ['CVV', 'cvv2', 'CVC', 'CVV Number', 'Security Code', 'Exp. Date', 'expiryDate', 'Expiration Date', 'Exp Month', 'Valid Thru', 'PIN']) {
      assert.equal(isCardSecretField(name), true, name);
    }
    for (const name of ['Expense', 'Export', 'Expected', 'Description', 'Category', 'Pinned']) {
      assert.equal(isCardSecretField(name), false, name);
    }
    for (const name of ['Card Number', 'CardNumber', 'Card No.', 'Account #', 'Account Number', 'ACCTID', 'PAN']) {
      assert.equal(isCardNumberField(name), true, name);
    }
    for (const name of ['Card Member', 'Reference', 'Amount', 'Account Type']) {
      assert.equal(isCardNumberField(name), false, name);
    }
  });
});

/** Completes a synthetic number (not a real account) with a Luhn check digit. */
function synthetic(prefix: string, length: number): string {
  const body = prefix.padEnd(length - 1, '0');
  for (let digit = 0; digit <= 9; digit += 1) if (luhnValid(`${body}${digit}`)) return `${body}${digit}`;
  throw new Error(body);
}

/** Deterministic PRNG (mulberry32) so property-style cases are reproducible. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same as `text` with every `***1234` replacement collapsed to `#`, so only surviving input digits remain. */
function survivingDigits(text: string): string {
  return text.replace(/\*\*\*\d{4}/g, '#');
}

/** True when five or more consecutive digits of `pan` survive, whatever separates them. */
function revealsMoreThanFour(text: string, pan: string): boolean {
  const surviving = survivingDigits(text);
  for (let i = 0; i + 5 <= pan.length; i += 1) {
    if (new RegExp(pan.slice(i, i + 5).split('').join('[^0-9#]*')).test(surviving)) return true;
  }
  return false;
}

function assertRedactedClean(input: string, output: string): void {
  assert.equal(containsCardData(output), false, `${JSON.stringify(input)} -> ${JSON.stringify(output)}`);
  assert.deepEqual(findCardNumberPaths({ memo: output }), [], JSON.stringify(output));
  assert.equal(redactCardNumbers(output), output, 'redaction is idempotent');
}

/** Mirrors Phase 2's database guard: no text column may hold 13 consecutive digits. */
function passesLongDigitGuard(text: string): boolean {
  return !/[0-9]{13}/.test(text);
}

const MAESTRO = ['493698', '50', '56', '57', '58', '59', '6'];

function isDateOrAmountWord(word: string): boolean {
  if (/^(?:19|20)\d\d([-/.])(?:0?[1-9]|1[0-2])\1(?:0?[1-9]|[12]\d|3[01])$/.test(word)) return true;
  const date = /^(\d{1,2})([-/.])(\d{1,2})\2(?:\d\d|(?:19|20)\d\d)$/.exec(word);
  if (date) return Math.max(+date[1], +date[3]) <= 31 && Math.min(+date[1], +date[3]) >= 1 && Math.min(+date[1], +date[3]) <= 12;
  const amount = /^(?:\d{1,3}(?:,\d{3})+\.\d\d|\d{1,3}(?:\.\d{3})+,\d\d|\d{1,3}(?:'\d{3})+\.\d\d|\d{1,9}[.,]\d\d)$/;
  return amount.test(word) && word.replace(/\D/g, '').length <= 8;
}

/**
 * The guarantee, checked independently of the implementation and written from the documented policy: every
 * span of digits, masks and separators that is card-length and shows more than four digits. A standalone date
 * or amount is cut out of its span unless the text on both sides of it shows more than four digits in all once
 * redacted; such tokens are absorbed leftmost first until none is left.
 */
function exposedCardSpans(text: string): string[] {
  const masked = text.normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
    // An x run that a letter follows belongs to a word; after a letter only its first x does.
    .replace(/[Xx]+/g, (run, offset: number, whole: string) => {
      if (/^[\p{L}\p{M}]/u.test(whole.slice(offset + run.length))) return run;
      const word = /[\p{L}\p{M}]$/u.test(whole.slice(0, offset)) ? 1 : 0;
      return run.slice(0, word) + '*'.repeat(run.length - word);
    })
    .replace(/##+/g, (run) => '*'.repeat(run.length))
    .replace(/[•●∗⁎]/gu, '*');
  const isCardData = (span: string) => {
    const symbols = span.replace(/[^0-9*]/g, '');
    const leading = /^\d*/.exec(symbols)![0].slice(0, 6);
    const cardLength = symbols.length >= 13
      || (symbols.length === 12 && MAESTRO.some((prefix) => prefix.startsWith(leading) || leading.startsWith(prefix)));
    // Rule (h): two or more masks, then only separators, then five digits in a row.
    return (cardLength && symbols.replace(/\*/g, '').length >= 5) || /\*{2,}[^0-9*]*\d{5}/.test(span);
  };
  const shown = (span: string) => {
    if (!isCardData(span)) return span.replace(/\D/g, '').length;
    return /^\d{4}$/.test(span.replace(/[^0-9*]/g, '').slice(-4)) ? 4 : 0;
  };
  const exposed: string[] = [];
  for (const piece of masked.split(/[^0-9*\s\u0085\p{Pd}\u2043\u2212./\\,_|'·∙⋅]+/u)) {
    // Text between tokens, and the tokens: between[0] tokens[0] between[1] tokens[1] ... between[n].
    const between: string[] = [''];
    const tokens: string[] = [];
    for (const word of piece.split(/\s+/)) {
      const core = word.replace(/^[^0-9*]+|[^0-9*]+$/g, '');
      if (core && core.length <= 16 && isDateOrAmountWord(core)) {
        tokens.push(word);
        between.push('');
      } else {
        between[between.length - 1] += ` ${word}`;
      }
    }
    // Absorb the leftmost date or amount whose neighbours show more than four digits, until none does.
    for (let index = 0; index < tokens.length;) {
      if (shown(between[index]) + shown(between[index + 1]) <= 4) {
        index += 1;
        continue;
      }
      between.splice(index, 2, `${between[index]} ${tokens[index]} ${between[index + 1]}`);
      tokens.splice(index, 1);
      index = 0;
    }
    for (const span of between) if (isCardData(span)) exposed.push(span.trim());
  }
  return exposed;
}

/** Redacts card data, then checks the result against the guarantee, the 13-digit guard and idempotence. */
function assertRedactsTo(text: string, expected: string): void {
  assert.equal(containsCardData(text), true, JSON.stringify(text));
  assert.deepEqual(findCardNumberPaths({ memo: text }), ['$.memo'], JSON.stringify(text));
  const redacted = redactCardNumbers(text);
  assert.equal(redacted, expected, JSON.stringify(text));
  assertRedactedClean(text, redacted);
  assert.deepEqual(exposedCardSpans(redacted), [], redacted);
  assert.equal(passesLongDigitGuard(redacted), true, redacted);
}

function assertUntouched(text: string): void {
  assert.equal(containsCardData(text), false, JSON.stringify(text));
  assert.equal(redactCardNumbers(text), text.normalize('NFKC'), JSON.stringify(text));
  assert.deepEqual(exposedCardSpans(text), [], JSON.stringify(text));
}

describe('span policy: bypasses from three review rounds', () => {
  it('round 1: overlapping matches, UnionPay 81, labelled masks and split card numbers', () => {
    const cases: Array<[string, string]> = [
      ['Reference 60000005 4111 1111 1111 1111', 'Reference ***1111'],
      ['Card 57 4012 8888 8888 1881', 'Card ***1881'],
      ['8100000000000002', '***0002'],
      ['Account:XXXX-XXXXXX-90003', 'Account:***0003'],
      ['XXXX\u2013XXXXXX\u201390003', '***0003'],
      ['4111\tXXXX\tXXXX\t1111', '***1111'],
      ['4111  XXXX  XXXX  1111', '***1111'],
      ['Paid 4111111111155555 5555 5555 4444', 'Paid ***4444'],
      ['4111\u00ad1111\u00ad1111\u00ad1111', '***1111'],
      ['4111\u20431111\u20431111\u20431111', '***1111'],
      ['4111 \u00b7 1111 \u00b7 1111 \u00b7 1111', '***1111'],
      ['1X4111111111111111', '***1111'],
    ];
    for (const [text, expected] of cases) assertRedactsTo(text, expected);
    assert.deepEqual(findCardNumberPaths({ accountNumber: '8100000000000002' }), ['$.accountNumber']);
  });

  it('round 2: truncations, continued groups, punctuation, mixed separators and stray digits', () => {
    const cases: Array<[string, string]> = [
      ['41111111 **** 1111', '***1111'],
      ['XXXX-XXXX-11111111', '***1111'],
      ['4111 XXXX 1111 1111', '***1111'],
      ['XXXX-XXXXXX-9000-3', '***0003'],
      ['4111.1111.1111.1111', '***1111'],
      ['4111/1111/1111/1111', '***1111'],
      ['84111 1111 1111 1111', '***1111'],
      ['4111.1111 1111.1111', '***1111'],
      ['4111.1111-1111.1111', '***1111'],
      ['Card 3782.822463.10005 charged', 'Card ***0005 charged'],
      ['6011_0009_9013_9424', '***9424'],
      ['4111|1111|1111|1111', '***1111'],
      ['4,111,111,111,111,111', '***1111'],
      ['84111\u200b1111\u00ad1111\u20601111', '***1111'],
      ['Paid with 6011.0009 9013-9424 on 16.10.2026', 'Paid with ***9424 on 16.10.2026'],
    ];
    for (const [text, expected] of cases) assertRedactsTo(text, expected);
  });

  it('a date or amount cannot hide the digits of a card next to it', () => {
    const cases: Array<[string, string]> = [
      ['4111 1111 1111 1111,25', '***1125'],
      ['Card: 4222222222 - 222,42\n273\n13)', 'Card: ***7313)'],
      ['Item 4111-11 / 1111.11 / 1111', 'Item ***1111'],
      ['411111111.11 11111', '***1111'],
      ['Card: 38676780\'58648800\'46 4222\n222.22\t2 222', 'Card: ***2222'],
      ['422222.22 22222', '***2222'],
      // Found by the fuzz test: absorbing 22222.22 must re-check 22,22 before it, or the result is card data again.
      ['(42 - 22,22\t22222.22 5249731', '(***9731'],
    ];
    for (const [text, expected] of cases) assertRedactsTo(text, expected);
  });

  it('round 3: every card length, mixed masks, impersonated replacements, masked endings and 12-digit Maestro', () => {
    const cases: Array<[string, string]> = [
      ['4000 0000 0000 0000 0060', '***0060'],
      ['4111.1111.1111.1111.0038', '***0038'],
      ['4111-11** ****-1111', '***1111'],
      ['3782-82**** *0005', '***0005'],
      ['41111111-**** 1111', '***1111'],
      ['411111 *** ***1111', '***1111'],
      ['411111 XXX XXX1111', '***1111'],
      ['401288888888****', '***'],
      ['40128888 8888 ****', '***'],
      ['5018 ****0009', '***0009'],
      ['5018 **** 0009', '***0009'],
    ];
    for (const [text, expected] of cases) assertRedactsTo(text, expected);
    // When the real last four are masked, there is no last four to report.
    assert.equal(cardLast4('401288888888****'), null);
    assert.equal(cardLast4('40128888 8888 ****'), null);
  });

  it('round 3: a date next to a last-four form stays a date', () => {
    for (const text of ['Card ****6011 2026-10-16', 'Card ****6304 2026-10-12']) {
      assertUntouched(text);
      assert.deepEqual(findCardNumbers(text), []);
      assert.equal(passesLongDigitGuard(text), true);
    }
    assert.equal(cardLast4('Card ****6011 2026-10-16'), '6011');
  });
});

describe('span policy: what is left alone', () => {
  it('leaves dates, amounts, times, phone numbers, short references, IPs, versions and last-four forms', () => {
    const texts = [
      '2026-10-16', '2026/10/16', '2026.10.16', '12/29/2026', '16.10.2026', '1/2/26', '1,234.56', '12.345,67', '1234.56',
      '$1,234,567.89', '1.234.567,89 EUR', "1'234'567.89 CHF", '12:34:56', '2026-10-16 12:34:56.789', '+1 (425) 555-0100',
      '1-800-555-1212', 'Call 1-800-528-4800 or 425-555-0100', '1234-5678-90', '192.168.24.10', '10.0.0.1:8080', '1.2.3.4',
      'v10.4.1.2', 'Card ****1111 2026-10-16', 'XXXX 1111 25 USD', '2500 ****1111', 'Amex***0003', 'Card ****1111 25.00',
      'Card XXXX 1111 2026-10-16', 'XXXX-XXXXXX-0003', 'Account # XXXX-XXXXXX-0003', '****1111', '**** **** **** 4444',
      '****\t****\t****\t1111', 'Ending in 1234', 'Statement 10/15/2026 balance $4,111.11', 'AMAZON MKTP US*AB12CD34E',
      '2026-10-16 AMAZON MKTP US*AB12CD34E 123.45', 'Xbox 2026-10-16', 'XXL shirt 12345', 'Max 90003', 'Box x12345',
      'Order 1234.5678.9012', 'Period 2026/01-2026/12', '########1234', '2026.10.16 1234.56 7890.12', 'Points 12345678901',
      '1,234.56 12,345.67',
    ];
    for (const text of texts) assertUntouched(text);
  });

  it('rule (h): a mask followed by five or more digits is card data at any length', () => {
    const cases: Array<[string, string]> = [
      ['XXXX-90003', '***0003'],
      ['****90003', '***0003'],
      ['Account:XXXX-XXXXXX-90003', 'Account:***0003'],
      ['(XXXX-90003)', '(***0003)'],
      ['Card \u25cf\u25cf\u25cf\u25cf 90003', 'Card ***0003'],
      ['AmexXXXX-90003', 'Amex***0003'],
      ['AMEXXXXX-90003', 'AMEX***0003'],
      ['Card#XXXX-90003', 'Card#***0003'],
      ['Order XX-12345', 'Order ***2345'],
      ['\uff0a\uff0a\uff0a\uff0a\uff0d\uff19\uff10\uff10\uff10\uff13', '***0003'],
      ['XXXX  90003', '***0003'],
      ['XXXX\t\u2013 90003', '***0003'],
      ['XXXX-90003 2026-10-16', '***0003 2026-10-16'],
      ['Ref 1234567 XX 90003.00 1', 'Ref ***3001'],
    ];
    for (const [text, expected] of cases) assertRedactsTo(text, expected);
    assert.equal(cardLast4('XXXX-90003'), '0003');
  });

  it('rule (h) needs a mask run of two or more right before five digits in a row', () => {
    const texts = [
      'XXXX 1111 25 USD', '2500 ****1111', '****1111', 'Card ****1111 2026-10-16', 'Amex***0003', 'XXXX-XXXXXX-0003',
      'Box x12345', '2 x 12345', 'PAYPAL *12345678', 'SQ *12345', 'Maxx 12345', 'Max 90003', '** *12345', 'XX 90 003',
      'XXXX 90003.00',
    ];
    for (const text of texts) assertUntouched(text);
  });

  it('redacts long numeric blobs that are not cards: accepted over-redaction', () => {
    const cases: Array<[string, string]> = [
      ['Reference 320252940123456789012', 'Reference ***9012'],
      ['IBAN DE89 3704 0044 0532 0130 00', 'IBAN DE***3000'],
      ['Tel 0049 30 1234 5678', 'Tel ***5678'],
      ['IPs 10.0.0.1/24 192.168.1.0/24', 'IPs ***1024'],
      ['Tel 425.555.0100 / 425-555-0101', 'Tel ***0101'],
      ['ISBN 978-3-16-148410-0', 'ISBN ***4100'],
      ['Invoice #123456789012345', 'Invoice #***2345'],
      ['Amount 1234 4111 XXXX XXXX 1111', 'Amount ***1111'],
      ['Paid 2500 XXXX XXXX XXXX 1234', 'Paid ***1234'],
      ['Ref 20261016 ***1234', 'Ref ***1234'],
      ['4111 XXXX XXXX 1111 4111 XXXX XXXX 1111', '***1111'],
      ['16.10.2026 1,234.56 192.168.24.10 12:34:56', '16.10.2026 ***1012:34:56'],
    ];
    for (const [text, expected] of cases) assertRedactsTo(text, expected);
  });
});

describe('span policy: card numbers and last four', () => {
  it('names the card in a span, preferring one made of whole groups', () => {
    assert.deepEqual(findCardNumbers('Reference 60000005 4111 1111 1111 1111'), [{ network: 'visa', last4: '1111' }]);
    assert.deepEqual(findCardNumbers('Card 57 4012 8888 8888 1881'), [{ network: 'visa', last4: '1881' }]);
    assert.deepEqual(findCardNumbers('84111 1111 1111 1111'), [{ network: 'visa', last4: '1111' }]);
    assert.deepEqual(findCardNumbers('4111.1111.1111.1111.0038'), [{ network: 'visa', last4: '0038' }]);
    assert.deepEqual(findCardNumbers('XX 4111111111111111'), [{ network: 'visa', last4: '1111' }]);
    assert.deepEqual(findCardNumbers('411111******1111'), []);
    assert.equal(containsCardNumber('Order 4111111111111112'), false);
    assert.equal(containsCardData('Order 4111111111111112'), true);
  });

  it('reads the last four of the last span', () => {
    assert.equal(cardLast4('XXXX-XXXXXX-9000-3'), '0003');
    assert.equal(cardLast4('3782-822463.10005'), '0005');
    assert.equal(cardLast4('Card 57 4012 8888 8888 1881'), '1881');
    assert.equal(cardLast4('XXXX-XXXX-XXXX-****'), null);
  });
});

// Braintree credit-card-type, src/lib/card-types.ts on main (checked 2026-10-16): [patterns, lengths] per network.
const BRAINTREE_TABLE: Record<string, [string[], number[]]> = {
  visa: [['4'], [16, 18, 19]],
  mastercard: [['51-55', '2221-2229', '223-229', '23-26', '270-271', '2720'], [16]],
  'american-express': [['34', '37'], [15]],
  'diners-club': [['300-305', '36', '38', '39'], [14, 16, 19]],
  troy: [['9792', '650052', '650082-650083', '650092', '650161', '650170', '650173', '650175', '650268', '650271',
    '650273-650274', '650456-650457', '650836', '650846-650850', '650923', '650987', '650990', '654997', '657366',
    '657998', '658758', '658767-658768', '65083700-65083704', '65085800-65085804', '65085900-65085901', '65086000',
    '65086100-65086105', '65086200-65086203', '65875000-65875003', '65875009', '65875101-65875104', '65875200',
    '65875501', '65875601', '65875900', '65876000-65876002', '65876100-65876103', '65876110', '65876115-65876116',
    '65876200-65876201', '65876500', '65876504-65876505', '65876600-65876602', '65877100-65877101',
    '65877600-65877602', '65877700', '65877801-65877802', '65878200-65878202', '65878300-65878311',
    '65878400-65878405', '65878500-65878505', '65878600-65878601', '65879800', '65880800', '65880900'], [16]],
  discover: [['6011', '644-649', '65'], [16, 19]],
  jcb: [['2131', '1800', '3528-3589'], [16, 17, 18, 19]],
  unionpay: [['620', '62100-62182', '62184-62187', '62185-62197', '62200-62205', '622010-622999', '622018', '62207-62209',
    '623-626', '6270', '6272', '6276', '627700-627779', '627781-627799', '6282-6289', '6291', '6292', '810', '8110-8131',
    '8132-8151', '8152-8163', '8164-8171'], [14, 15, 16, 17, 18, 19]],
  maestro: [
    ['493698', '500000-504174', '504176-506698', '506779-508999', '56-59', '63', '67', '6'],
    [12, 13, 14, 15, 16, 17, 18, 19],
  ],
  elo: [['401178', '401179', '438935', '457631', '457632', '431274', '451416', '457393', '504175', '506699-506778',
    '509000-509999', '627780', '636297', '636368', '650031-650033', '650035-650051', '650057-650081', '650405-650439',
    '650485-650538', '650541-650598', '650700-650718', '650720-650727', '650901-650978', '651652-651679',
    '651680-651704', '655000-655019', '655021-655058'], [16]],
  mir: [['2200-2204'], [16, 17, 18, 19]],
  hiper: [['637095', '63737423', '63743358', '637568', '637599', '637609', '637612'], [16]],
  hipercard: [['606282'], [16]],
  naranja: [['589562', '402918', '527572'], [16]],
  verve: [['506099-506127', '506129', '506133-506150', '506158-506163', '506166', '506168', '506170', '506173',
    '506176-506180', '506184', '506187-506188', '506191', '506195', '506197', '507865', '507866', '507868-507877',
    '507880-507888', '507900', '507941'], [16, 18, 19]],
};

describe('card network ranges', () => {
  it('detects every range and length in the Braintree table', () => {
    for (const [network, [patterns, lengths]] of Object.entries(BRAINTREE_TABLE)) {
      for (const prefix of patterns.flatMap((pattern) => pattern.split('-'))) {
        for (const length of lengths) {
          const number = synthetic(prefix, length);
          const label = `${network} ${prefix} ${length}: ${number}`;
          assert.notEqual(cardNetwork(number), null, label);
          assert.equal(containsCardNumber(`paid ${number}.`), true, label);
          assert.equal(redactCardNumbers(`paid ${number}.`), `paid ***${number.slice(-4)}.`, label);
        }
      }
    }
  });

  it('flags UnionPay 81 ranges like 62, at every length and without a check digit', () => {
    assert.equal(cardNetwork('8100000000000002'), 'unionpay');
    for (const prefix of ['810', '8109', '8110', '8131', '8132', '8151', '8152', '8163', '8164', '8171', '62']) {
      for (let length = 14; length <= 19; length += 1) {
        const valid = synthetic(prefix, length);
        const invalid = `${valid.slice(0, -1)}${(Number(valid.slice(-1)) + 1) % 10}`;
        assert.equal(luhnValid(invalid), false);
        for (const number of [valid, invalid]) {
          assert.equal(cardNetwork(number), 'unionpay', number);
          assert.deepEqual(findCardNumbers(`UnionPay ${number}`), [{ network: 'unionpay', last4: number.slice(-4) }], number);
          assert.equal(redactCardNumbers(`UnionPay ${number}`), `UnionPay ***${number.slice(-4)}`, number);
        }
      }
    }
    // Outside the ranges or lengths there is no network, RuPay's 81 and 82 ranges need a check digit, and the digits
    // are still redacted as a long number either way.
    for (const number of ['8100000000000', '81000000000000000000', '8099999999999995']) {
      assert.equal(cardNetwork(number), null, number);
    }
    for (const number of ['8172000000000001', '8200000000000002']) assert.equal(containsCardNumber(number), false, number);
    for (const number of ['8100000000000', '81000000000000000000', '8099999999999995', '8172000000000001', '8200000000000002']) {
      assert.equal(containsCardData(redactCardNumbers(number)), false, number);
    }
    assert.equal(cardNetwork(synthetic('8172', 16)), 'rupay');
  });

  it('labels Mir, Troy, RuPay, UATP and the JCB and Maestro ranges', () => {
    const expected: Array<[string, number, string]> = [
      ['2200', 16, 'mir'], ['2204', 19, 'mir'], ['9792', 16, 'troy'], ['82', 16, 'rupay'], ['1', 15, 'uatp'], ['1800', 15, 'jcb'],
      ['2131', 19, 'jcb'], ['59', 16, 'maestro'], ['493698', 12, 'maestro'], ['4', 18, 'visa'], ['62', 14, 'unionpay'],
    ];
    for (const [prefix, length, network] of expected) {
      assert.equal(cardNetwork(synthetic(prefix, length)), network, `${prefix} ${length}`);
    }
    const outside = [
      ['2199', 16], ['2205', 16], ['9791', 16], ['9793', 16], ['1', 14], ['1', 16], ['1800', 14], ['80', 16],
    ] as const;
    for (const [prefix, length] of outside) assert.equal(cardNetwork(synthetic(prefix, length)), null, `${prefix} ${length}`);
  });
});

describe('path limits', () => {
  it('charges object keys to the text budget before scanning them', () => {
    assert.deepEqual(findCardNumberPaths({ ['a'.repeat(6_000_000)]: null }), ['$<limit>']);
    const keys = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [String.fromCharCode(97 + index).repeat(1e6), null]));
    assert.deepEqual(findCardNumberPaths(keys), ['$<limit>']);
    assert.deepEqual(findCardNumberPaths({ ['a'.repeat(3_000_000)]: 'b'.repeat(3_000_000) }), ['$<limit>']);
    // An oversized key holding a card number is never scanned: only the limit is reported.
    assert.deepEqual(findCardNumberPaths({ [`4111111111111111 ${'a'.repeat(6_000_000)}`]: 1 }), ['$<limit>']);
    assert.deepEqual(findCardNumberPaths({ ['a'.repeat(4_000_000)]: 'ok' }), []);
  });
});

describe('span policy: the guarantee on random input', () => {
  it('never leaves more than four digits of a test card, whatever surrounds or splits it', () => {
    const random = seeded(20261016);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const digits = (count: number) => Array.from({ length: count }, () => String(Math.floor(random() * 10))).join('');
    const separators = [
      ' ', '  ', '\t', '\n', '-', ' - ', '\u2013', '\u2212', '\u00a0', '.', '/', ',', '_', '|', "'", '\u00b7', ' / ',
    ];
    const pans = [
      ...Object.values(TEST_CARDS).flat(), '8100000000000002', synthetic('2200', 16), synthetic('8171', 19), synthetic('62', 14),
      synthetic('9792', 16), synthetic('493698', 12), synthetic('59', 13), synthetic('1800', 15), synthetic('509000', 16),
    ];
    for (const pan of pans) {
      for (let round = 0; round < 120; round += 1) {
        const groups = () => Array.from({ length: Math.floor(random() * 4) }, () => digits(1 + Math.floor(random() * 8)))
          .join(pick(separators));
        const prefix = groups();
        const suffix = groups();
        // Skip the rare draw where the random digits themselves repeat five digits of the card.
        if (revealsMoreThanFour(prefix, pan) || revealsMoreThanFour(suffix, pan)) continue;
        let grouped = '';
        for (const [index, digit] of [...pan].entries()) {
          if (index > 0 && random() < 0.25) grouped += pick([...separators, '\u200b', '\u00ad', '\u200e']);
          // Sometimes a digit before the last four is masked.
          grouped += index < pan.length - 4 && random() < 0.05 ? pick(['X', '*', '\u2022']) : digit;
        }
        const text = [
          pick(['', 'Ref ', 'Card: ', '(']), prefix, prefix && pick(separators), grouped, suffix && pick(separators), suffix,
          pick(['', ' end', '.', ')']),
        ].join('');
        const redacted = redactCardNumbers(text);
        assertRedactedClean(text, redacted);
        assert.deepEqual(exposedCardSpans(redacted), [], redacted);
        assert.equal(passesLongDigitGuard(redacted), true, redacted);
        // The documented limit: digits in a piece that reads as a date or amount are kept like any date or amount.
        const words = text.normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '').split(/\s+/)
          .map((word) => word.replace(/^[^0-9*]+|[^0-9*]+$/g, ''));
        if (words.some((word) => word.length <= 16 && isDateOrAmountWord(word))) continue;
        assert.equal(containsCardData(text), true, JSON.stringify(text));
        assert.equal(revealsMoreThanFour(redacted, pan), false, `${JSON.stringify(text)} -> ${JSON.stringify(redacted)}`);
        assert.equal(passesLongDigitGuard(redacted), true, redacted);
      }
    }
  });

  it('agrees with the independent check on random spans and leaves no exposed span behind', () => {
    const random = seeded(4111);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const pieces = [
      '4111', '1111', '6011', '5018', '2500', '0009', '90003', '12', '5', '41111111', '2026', 'XXXX', 'xx', 'X', '****', '*',
      '\u2022\u2022\u2022\u2022', '\u25cf\u25cf', '##', '#', '2026-10-16', '16.10.2026', '1/2/26', '1,234.56', '12.345,67',
      '25.00',
      ' ', '  ', '-', '\u2013', '.', '/', ',', '_', '|', "'", '\u00b7', '\t', '\u00a0', '\u200b', ':', '(', ')', '$', '@', ';',
      'Card ', 'Amex', 'AMEX', 'Xbox', 'Max', ' USD', '\uff14', '12345', 'AmexXXXX', '****90003', 'XX-12345',
    ];
    for (let round = 0; round < 20_000; round += 1) {
      let text = '';
      for (let count = 1 + Math.floor(random() * 14); count > 0; count -= 1) text += pick(pieces);
      assert.equal(containsCardData(text), exposedCardSpans(text).length > 0, JSON.stringify(text));
      const redacted = redactCardNumbers(text);
      assert.deepEqual(exposedCardSpans(redacted), [], `${JSON.stringify(text)} -> ${JSON.stringify(redacted)}`);
      assert.equal(containsCardData(redacted), false, JSON.stringify(redacted));
      assert.equal(redactCardNumbers(redacted), redacted, JSON.stringify(redacted));
      assert.equal(passesLongDigitGuard(redacted), true, redacted);
    }
  });
});

describe('span policy: hostile input', () => {
  it('stays linear on long runs of digits, masks, separators, words, dates and amounts', () => {
    const started = Date.now();
    assert.equal(redactCardNumbers('1 '.repeat(250_000)), '***1111 ');
    assert.equal(redactCardNumbers('1.'.repeat(250_000)), '***1111.');
    assert.equal(containsCardData('X'.repeat(500_000)), false);
    assert.equal(containsCardData('aX'.repeat(250_000)), false);
    assert.equal(containsCardData('#'.repeat(500_000)), false);
    assert.equal(containsCardData('1#'.repeat(250_000)), false);
    assert.equal(containsCardData('X1'.repeat(250_000)), true);
    assert.equal(containsCardData('2026-10-16 '.repeat(50_000)), false);
    assert.equal(containsCardData('1,234.56 '.repeat(50_000)), false);
    assert.equal(containsCardData(`${'1.'.repeat(500_000)}5`), true);
    assert.equal(containsCardNumber('9'.repeat(1_000_000)), false);
    assert.equal(containsCardNumber('\u0661'.repeat(1_000_000)), false);
    assert.deepEqual(findCardNumbers('4111 '.repeat(200_000)), [{ network: 'visa', last4: '4111' }]);
    assert.equal(cardLast4(`${'XXXX '.repeat(200_000)}1234`), '1234');
    assert.equal(containsCardData('XX 1234 '.repeat(120_000)), true);
    assert.equal(containsCardData('X 12345 '.repeat(120_000)), true);
    assert.equal(containsCardData('**1 '.repeat(250_000)), true);
    assert.equal(redactCardNumbers('XX 1,234.56 '.repeat(80_000)), 'XX 1,234.56 '.repeat(80_000));
    assert.equal(containsCardData('XX-90003 x'.repeat(100_000)), true);
    assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`);
  });
});
