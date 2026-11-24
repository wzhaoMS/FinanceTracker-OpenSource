import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cardNetwork, luhnValid } from '../cardNumbers.js';
import { CARD_SPAN_MASK, CARD_SPAN_SEPARATOR } from '../cardImportTool/leaks.js';
import { convertCardExport, type ConvertOptions } from '../cardImportTool/convert.js';
import {
  CARD_SYNC_RECONSTRUCTION_MIN_DIGITS,
  CardHintSet,
  cardSyncCombinedTextIssue,
  cardSyncTextDigits,
  prepareCardSyncRowText,
} from './crossField.js';
import { cardSyncTextIssue } from './text.js';
import { CARD_SYNC_V2_FIXTURE_BUILDERS, PROJECTED_BATCH_FIXTURE_BUILDERS } from './__fixtures__/drafts.js';

// Published test card numbers only.
const PANS = ['4242424242424242', '4111111111111111', '371449635398431', '5555555555554444', '6011111111111117'];
/** Hints used by the synthetic fixtures (v2 and the offline tool's). */
const FIXTURE_HINTS = ['3391', '7720', '2999', '2008', '5502', '8086', '0003', '2003', '1111'];
const ALL_HINTS = Array.from({ length: 10_000 }, (_, index) => String(index).padStart(4, '0'));

/** Realistic card descriptors: phone, store, station and order numbers, dates. Each passes the single-field rules. */
const DESCRIPTORS = [
  'UBER *TRIP 8005928996 CA', 'AMAZON MKTP US*2K4 #1234', 'SQ *COFFEE 4155551212', 'AMZN Mktp US*2K4AB1CD2 Amzn.com/bill WA',
  'PAYPAL *SPOTIFY 4029357733 CA', 'GOOGLE *YouTube 6502530000 CA', 'APPLE.COM/BILL 866-712-7753 CA', 'NETFLIX.COM 866-579-7172 CA',
  'LYFT *RIDE SUN 4PM 8554659338 CA', 'DOORDASH*BURGER PLACE 855-973-1040 CA', 'SHELL OIL 57444937300 SAN JOSE CA',
  'CHEVRON 0204587 MOUNTAIN VIEW CA', 'COSTCO WHSE #0423 MOUNTAIN VIEW CA', 'TARGET 00012345 SUNNYVALE CA', 'WALGREENS #12345 SEATTLE WA',
  'CVS/PHARMACY #01234 BOSTON MA', 'WHOLEFDS MKT 10234 PALO ALTO CA', 'TST* SYNTHETIC CAFE - 2026-10-14', 'SPOTIFY USA 877-778-1161 NY',
  'PG&E WEBRECURRING 800-743-5000 CA', 'AT&T*BILL PAYMENT 800-288-2020 TX', 'DELTA AIR 0062345678 ATLANTA GA',
  'MARRIOTT HOTEL 12/03 - 12/05 SAN FRANCISCO', 'ETSY.COM*SELLER 718-8557955 NY', 'VENMO *JOHN 855-812-4430', 'GEICO *AUTO 800-841-3000 DC',
  'STARBUCKS STORE 05678 SEATTLE WA', "MCDONALD'S F12345 OAKLAND CA", 'HOME DEPOT #6601 SAN CARLOS CA', 'LOWES #01234* SAN MATEO CA',
  'TRADER JOE S #123 PALO ALTO CA', 'IN-N-OUT BURGER #123 MILPITAS CA', 'CLIPPER SERVICE 877-878-8883 CA', 'FASTRAK CSC 877-229-8655 CA',
  'COMCAST CALIFORNIA 800-266-2278 CA', 'PARKING 4155551234 SF', '1-800-FLOWERS.COM 18004681141 NY', 'SHELL SERVICE 57442118700',
  'EXXONMOBIL 47661234 HOUSTON TX', 'BP#9876543 CHICAGO IL', 'ORDER 1234567890 SHIPPED', 'INVOICE 98765432101 ACME',
  'AMZN.COM*RT4QW1234 AMZN.COM/BILL WA', 'UNITED 016 2345678 HOUSTON TX', 'AIRBNB * HMABCDEF12 415-800-5959 CA', 'TICKETMASTER 8006533000 CA',
  'SAFEWAY #1234 PALO ALTO CA 06/14', 'WM SUPERCENTER #5260', 'MICROSOFT*XBOX 800-642-7676 WA', 'EVENTBRITE/SYNTHETIC 8014137200 CA',
  'CITY OF PALO ALTO 650-329-2100', 'DMV CA ONLINE 916-657-6437', 'PIN PAD TEST STORE 12', 'EXPRESS 0123 STANFORD CA',
  // Several numbers in one descriptor: windows of whole runs can combine them.
  'HOTEL FOLIO 123456 ARR 10/14 DEP 10/16', 'PARKING METER 1234 ZONE 56 SF', 'TOLL 2026-10-14 08:15 PLAZA 12',
  'PAYPAL *EBAY 402-935-7733 ORDER 123456', 'AMTRAK TKT 0123456789 NYP-WAS 12/15', 'SQ *FARMERS MKT 12 BOOTH 34 4155550199',
  'UBER *EATS 8005928996 ORDER 4521', 'VERIZON WRLS 800-922-0204 ACCT 1234', 'DD *DOORDASH 855-973-1040 ORDER 98 7654',
  'COSTCO GAS #0423 PUMP 12 2026-10-14', 'SP * SYNTHETIC SHOP 888-555-0142 INV 2026 0042', 'ATT*BILL 800-288-2020 ACCT 123456789',
];

/** Realistic description, merchant and category together, including merchants that start with digits. */
const ROWS: Array<[string, string | null, string | null]> = [
  ['UBER *TRIP 8005928996 CA', 'Uber', 'Travel'], ['AMAZON MKTP US*2K4 #1234', 'Amazon', 'Shopping'], ['SQ *COFFEE 4155551212', 'Square Coffee', 'Food & Drink'],
  ['SQ *COFFEE 4155551212', '76', 'Gas'], ['76 SYNTHETIC GAS 8005551234', '76', 'Transportation-Fuel'], ['7-ELEVEN 12345 SAN JOSE CA', '7-Eleven', 'Groceries'],
  ['24 HOUR FITNESS USA 8005551234', '24 Hour Fitness', 'Health & Wellness'], ['99 RANCH MARKET #12 CUPERTINO CA', '99 Ranch Market', 'Groceries'],
  ['1-800-FLOWERS.COM 18004681141 NY', '1-800-Flowers', 'Shopping'], ['SHELL OIL 57444937300 SAN JOSE CA', 'Shell', 'Gas'],
  ['PAYPAL *SPOTIFY 4029357733 CA', 'Spotify', 'Entertainment'], ['GOOGLE *YouTube 6502530000 CA', 'YouTube', 'Entertainment'],
  ['FASTRAK CSC 877-229-8655 CA', 'FasTrak', 'Travel'], ['PIN PAD TEST STORE 12', 'Pin Pad', null], ['EXPRESS 0123 STANFORD CA', 'Express', 'Shopping'],
  ['VALID PARKING 415 555 1212', 'Valid Parking', 'Travel'], ['GOOD EATS 2026-10-14', 'Good Eats', 'Food & Drink'], ['ORDER 1234567890', '123 Main Street Deli', null],
  ['SALES TAX 1234567890', '123 Main', null], ['HOTEL 12/03 - 12/05', '12 Oaks Hotel', 'Travel'], ['TICKETMASTER 8006533000 CA', '8006533000', 'Entertainment'],
  ['EXP DATE MOTORS 12', 'Exp Date Motors', null], ['PINE ST 2900 SF', 'Pine St Cafe', 'Food & Drink'],
];

function isCard(digits: string): boolean {
  return digits.length >= CARD_SYNC_RECONSTRUCTION_MIN_DIGITS && digits.length <= 19 && cardNetwork(digits) !== null && luhnValid(digits);
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

/** Every window of consecutive whole runs, in every arrangement of the fields, alone or followed by a hint. */
function bruteForce(fields: readonly (readonly string[])[], hints: readonly string[]): boolean {
  for (const order of permutations(fields)) {
    const runs = order.flat();
    for (let first = 0; first < runs.length; first += 1) {
      for (let last = first; last < runs.length; last += 1) {
        const digits = runs.slice(first, last + 1).join('');
        if (digits.length > 19) break;
        if (isCard(digits) || hints.some((hint) => isCard(`${digits}${hint}`))) return true;
      }
    }
  }
  return false;
}

function showsPanDigits(text: string, pan: string): boolean {
  const digits = text.replace(/[^0-9]/g, '');
  for (let index = 0; index + 5 <= pan.length; index += 1) if (digits.includes(pan.slice(index, index + 5))) return true;
  return false;
}

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 4_294_967_296;
  };
}

describe('CardHintSet', () => {
  it('completes whole digits with a hint, never a suffix of them', () => {
    for (const pan of PANS) {
      const prefix = pan.slice(0, -4);
      const set = new CardHintSet([pan.slice(-4), '0000']);
      assert.equal(set.completes(prefix), true, pan);
      assert.equal(set.completes(`9${prefix}`), isCard(`9${pan}`), `${pan} after a stray digit`);
      assert.equal(set.completes(prefix.slice(1)), isCard(`${prefix.slice(1)}${pan.slice(-4)}`) || isCard(`${prefix.slice(1)}0000`), `${pan} missing a digit`);
    }
  });

  it('agrees with Phase 1 network and Luhn rules over random digits and hints', () => {
    const random = lcg(77);
    for (let round = 0; round < 3_000; round += 1) {
      const digits = Array.from({ length: 6 + Math.floor(random() * 10) }, () => Math.floor(random() * 10)).join('');
      const hints = Array.from({ length: 1 + Math.floor(random() * 4) }, () => String(Math.floor(random() * (random() < 0.2 ? 100_000 : 10_000))).padStart(random() < 0.2 ? 5 : 4, '0'));
      assert.equal(new CardHintSet(hints).completes(digits), hints.some((hint) => isCard(`${digits}${hint}`)), `${digits} ${hints}`);
    }
  });

  it('ignores anything that is not a 4- or 5-digit hint, and never counts fewer than 15 digits', () => {
    const set = new CardHintSet(['424', '4242424', 'abcd', '42 42']);
    assert.equal(set.size, 0);
    assert.equal(set.completes('424242424242'), false);
    // 10 digits + 4 = 14: never counted (a phone number is not a card prefix).
    for (const hint of ALL_HINTS.filter((_, index) => index % 7 === 0)) assert.equal(new CardHintSet([hint]).completes('4155551212'), false);
  });
});

describe('cardSyncTextDigits', () => {
  it('reads whole runs as Phase 1 spans group digits, after deleting redaction tokens', () => {
    assert.deepEqual(cardSyncTextDigits('CALL 415-555-1212 OR 12/03 A1B2'), { runs: ['4155551212', '1203', '1', '2'], hints: [] });
    // Four or five digits after a run of masks (Amex shows five) are a token; a lone mask is not, nor six digits.
    assert.deepEqual(
      cardSyncTextDigits('CARD ***4242 XXXX-1234 ##5678 *9999 x1111 XX12345 XX123456'),
      { runs: ['9999', '1111', '123456'], hints: ['4242', '1234', '5678', '12345'] },
    );
    assert.deepEqual(
      cardSyncTextDigits('ALPHA 4012 BRAVO ***1881 CHARLIE 8888 DELTA ***1881 ECHO 8888'),
      { runs: ['4012', '8888', '8888'], hints: ['1881', '1881'] },
    );
    // A token ends the runs beside it rather than joining them.
    assert.deepEqual(cardSyncTextDigits('4012 ***1881 8888'), { runs: ['4012', '8888'], hints: ['1881'] });
  });
});

describe('span characters', () => {
  it("join runs across exactly card import's separators and read exactly its masks, over the whole BMP", () => {
    for (let code = 0; code <= 0xffff; code += 1) {
      const char = String.fromCharCode(code);
      if (code >= 0x30 && code <= 0x39) continue;
      const label = `U+${code.toString(16).padStart(4, '0')}`;
      assert.equal(cardSyncTextDigits(`1${char}1`).runs.length === 1, CARD_SPAN_SEPARATOR.test(char), label);
      const token = cardSyncTextDigits(`A${char}${char}1234`).hints.length === 1;
      assert.equal(token, CARD_SPAN_MASK.test(char) || char === 'x' || char === 'X' || char === '#', label);
    }
  });
});

describe('whole-run reconstruction', () => {
  it('agrees with a brute-force search over every window and arrangement', () => {
    const random = lcg(2026);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    let found = 0;
    for (let round = 0; round < 4_000; round += 1) {
      const fieldCount = 1 + Math.floor(random() * 3);
      const fields: string[][] = Array.from({ length: fieldCount }, () => []);
      // Noise runs, and sometimes a card number cut into whole runs scattered over the fields in order.
      for (const field of fields) {
        for (let count = Math.floor(random() * 4); count > 0; count -= 1) field.push(String(Math.floor(random() * 10 ** (1 + Math.floor(random() * 7)))));
      }
      const pan = pick(PANS);
      const hints = Array.from({ length: Math.floor(random() * 3) }, () => String(Math.floor(random() * 10_000)).padStart(4, '0'));
      if (random() < 0.6) {
        const body = random() < 0.5 ? pan.slice(0, -4) : pan;
        if (body !== pan) hints.push(pan.slice(-4));
        const cuts = [...new Set(Array.from({ length: Math.floor(random() * 4) }, () => 1 + Math.floor(random() * (body.length - 1))))].sort((a, b) => a - b);
        const pieces = [0, ...cuts].map((start, index) => body.slice(start, [...cuts, body.length][index]));
        let field = Math.floor(random() * fieldCount);
        let at = Math.floor(random() * (fields[field].length + 1));
        for (const piece of pieces) {
          fields[field].splice(at, 0, piece);
          at += 1;
          if (random() < 0.3 && field + 1 < fieldCount) {
            field += 1;
            at = 0;
          }
        }
      }
      const texts = fields.map((runs) => (runs.length === 0 ? 'QZ' : `Q ${runs.join(' Z ')} Q`));
      const expected = bruteForce(fields, hints);
      if (expected) found += 1;
      assert.equal(cardSyncCombinedTextIssue(texts, hints) === 'card-data', expected, `${JSON.stringify(texts)} ${hints}`);
    }
    assert.ok(found > 1_000);
  });

  it('refuses card numbers in fragments between words and redaction tokens', () => {
    const pattern = 'ALPHA 4012 BRAVO ***1881 CHARLIE 8888 DELTA ***1881 ECHO 8888';
    assert.equal(cardSyncTextIssue(pattern, 500), null, 'no single-field rule sees it');
    assert.equal(cardSyncCombinedTextIssue([pattern], []), 'card-data');
    assert.equal(cardSyncCombinedTextIssue(['ALPHA 4012 BRAVO ***1881 CHARLIE 8888', 'DELTA ***1881 ECHO 8888'], []), 'card-data');
    assert.equal(cardSyncCombinedTextIssue(['ECHO 8888', 'ALPHA 4012 BRAVO ***1881', 'CHARLIE 8888'], []), 'card-data');
    // The kept digits may come from a token in another field, or from the payload's hints.
    assert.equal(cardSyncCombinedTextIssue(['ALPHA 4012 BRAVO 8888 CHARLIE 8888', 'CARD ***1881'], []), 'card-data');
    assert.equal(cardSyncCombinedTextIssue(['ALPHA 4012 BRAVO 8888 CHARLIE 8888'], ['1881']), 'card-data');
    // Alone, without any hint, and hidden entirely in tokens.
    assert.equal(cardSyncCombinedTextIssue(['ALPHA 4012 BRAVO 8888 CHARLIE 8888 DELTA 1881'], []), 'card-data');
    assert.equal(cardSyncCombinedTextIssue(['ALPHA ***4012 BRAVO ***8888 CHARLIE ***8888 DELTA ***1881'], []), 'card-data');
    // An Amex number with its last five as the hint.
    assert.equal(cardSyncCombinedTextIssue(['ALPHA 3714 BRAVO 4963', 'CHARLIE 53'], ['98431']), 'card-data');
    // Fragments out of order, or with a digit changed, are not a card number.
    assert.equal(cardSyncCombinedTextIssue(['ALPHA 8888 BRAVO 4012 CHARLIE 8888 DELTA ***1881'], []), null);
    assert.equal(cardSyncCombinedTextIssue(['ALPHA 4012 BRAVO 8888 CHARLIE 8887 DELTA ***1881'], []), null);
  });
});

describe('cardSyncCombinedTextIssue', () => {
  it('refuses every reconstruction the review reproduced', () => {
    assert.equal(cardSyncCombinedTextIssue(['424242424242'], ['4242']), 'card-data');
    assert.equal(cardSyncCombinedTextIssue(['PAY 42424242', '42424242 SHOP'], []), 'card-data');
    assert.equal(cardSyncCombinedTextIssue(['424242', '42424', '24242'], []), 'card-data');
    assert.equal(cardSyncCombinedTextIssue(['CVV', '123'], []), 'card-secret');
    assert.equal(cardSyncCombinedTextIssue(['Example Card 424242424242'], ['4242']), 'card-data');
  });

  it('refuses them in any field order, with masked hints in text, and with masks across fields', () => {
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const order of orders) {
      const parts = ['424242', '42424', '24242'];
      assert.equal(cardSyncCombinedTextIssue(order.map((index) => parts[index]), []), 'card-data', String(order));
    }
    assert.equal(cardSyncCombinedTextIssue(['SYNTHETIC 424242424242', 'CARD ***4242'], []), 'card-data');
    assert.equal(cardSyncCombinedTextIssue(['PAY 424242', '424242 SHOP'], ['4242']), 'card-data');
    assert.equal(cardSyncCombinedTextIssue(['CARD XXXX', '90003 STORE'], []), 'card-data');
    assert.equal(cardSyncCombinedTextIssue(['PIN', '1234'], []), 'card-secret');
    assert.equal(cardSyncCombinedTextIssue(['exp', '12/29'], []), 'card-secret');
  });

  it('passes realistic rows: no false positive without hints, and the measured rate with hints', (context) => {
    for (const [description, merchant, category] of ROWS) {
      for (const text of [description, merchant, category]) if (text !== null) assert.equal(cardSyncTextIssue(text, 500), null, text);
      assert.equal(cardSyncCombinedTextIssue([description, merchant, category], []), null, description);
    }
    for (const descriptor of DESCRIPTORS) assert.equal(cardSyncTextIssue(descriptor, 500), null, descriptor);
    const fixtureRefusals = (texts: ReadonlyArray<string | null>) => FIXTURE_HINTS.filter((hint) => cardSyncCombinedTextIssue(texts, [hint]) !== null).length;
    const descriptorHits = DESCRIPTORS.map((descriptor) => fixtureRefusals([descriptor]));
    const rowHits = ROWS.map((row) => fixtureRefusals(row));
    const anyHint = (texts: ReadonlyArray<string | null>) => ALL_HINTS.some((hint) => cardSyncCombinedTextIssue(texts, [hint]) !== null);
    const descriptorsWithAnyHint = DESCRIPTORS.filter((descriptor) => anyHint([descriptor])).length;
    const rowsWithAnyHint = ROWS.filter((row) => anyHint(row)).length;
    const sum = (list: number[]) => list.reduce((total, value) => total + value, 0);
    context.diagnostic(`descriptors: ${DESCRIPTORS.length}; refused pairs with the ${FIXTURE_HINTS.length} fixture hints: ${sum(descriptorHits)} of ${DESCRIPTORS.length * FIXTURE_HINTS.length}; descriptors some 4-digit hint refuses: ${descriptorsWithAnyHint}`);
    context.diagnostic(`rows: ${ROWS.length}; refused without hints: 0; refused pairs with fixture hints: ${sum(rowHits)} of ${ROWS.length * FIXTURE_HINTS.length}; rows some 4-digit hint refuses: ${rowsWithAnyHint}`);
    // Pinned so any change to the rules shows up here; see wireV2.ts and crossField.ts.
    assert.equal(sum(descriptorHits), 2);
    assert.equal(descriptorsWithAnyHint, 4);
    assert.equal(sum(rowHits), 3);
    assert.equal(rowsWithAnyHint, 4);
  });

  it('finds nothing in the synthetic fixtures or the offline tool fixtures', () => {
    for (const build of Object.values(CARD_SYNC_V2_FIXTURE_BUILDERS)) {
      const payload = build();
      for (const row of payload.rows) assert.equal(cardSyncCombinedTextIssue([row.description, row.merchant, row.issuerCategory], payload.cards), null);
    }
    for (const build of Object.values(PROJECTED_BATCH_FIXTURE_BUILDERS)) {
      const batch = build();
      const hints = [...batch.accounts.map((account) => account.last4), ...batch.transactions.map((row) => row.cardLast4)].filter((hint): hint is string => hint !== null);
      for (const row of batch.transactions) assert.equal(cardSyncCombinedTextIssue([row.description, row.merchant, row.issuerCategory], hints), null);
      for (const account of batch.accounts) assert.equal(cardSyncCombinedTextIssue([account.productHint], hints), null);
    }
    const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../cardImportTool/fixtures/${name}`, import.meta.url)));
    const members = [{ name: 'Alex  Sample', owner: 'casey' as const }, { name: 'JORDAN SAMPLE', owner: 'alex' as const }];
    const exports: Array<[string, Partial<ConvertOptions> & Pick<ConvertOptions, 'format'>]> = [
      ['amex-basic.csv', { format: 'amex-csv' }], ['amex-detailed.csv', { format: 'amex-csv', members }],
      ['statement-ofx1.ofx', { format: 'ofx', issuer: 'samplebank' }], ['statement.qfx', { format: 'ofx', issuer: 'samplebank' }],
    ];
    for (const [file, options] of exports) {
      // Closed-statement fixtures: the offline tool has no default status.
      const { payload } = convertCardExport(fixture(file), { ...options, status: 'posted' });
      for (const row of payload.rows) assert.equal(cardSyncCombinedTextIssue([row.description, row.merchant, row.issuerCategory], [...payload.cards, ...FIXTURE_HINTS]), null, file);
    }
  });

  it('stays fast on adversarial rows', (context) => {
    const digits = 'A1 '.repeat(166);
    const labels = 'PIN1 '.repeat(99);
    // Non-repeating digits that start no card network: nothing is found, so every window is searched.
    const random = lcg(7);
    const quiet = (count: number) => Array.from({ length: count }, () => `A${'0789'[Math.floor(random() * 4)]}`).join(' ');
    const manyHints = Array.from({ length: 40 }, (_, index) => String(1_000 + index * 211).slice(0, 4));
    const cases: Array<[string, string[], readonly string[]]> = [
      ['single digits', [`${digits.slice(0, 497)}12`, `34${digits.slice(0, 197)}`, `56${digits.slice(0, 97)}`], FIXTURE_HINTS],
      ['secret labels', [labels.slice(0, 495), `x${labels.slice(0, 195)}`, `y${labels.slice(0, 95)}`], FIXTURE_HINTS],
      ['no network, 40 hints', [quiet(166), quiet(66), quiet(33)], manyHints],
    ];
    // The last finds nothing, so it is a full search.
    assert.equal(cardSyncCombinedTextIssue(cases[2][1], cases[2][2]), null);
    for (const [name, texts, hints] of cases) {
      const started = performance.now();
      for (let index = 0; index < 1_000; index += 1) cardSyncCombinedTextIssue(texts, hints);
      const perRow = (performance.now() - started) / 1_000;
      context.diagnostic(`${name}: ${perRow.toFixed(2)} ms per row`);
      // A 2,000-row payload of such rows stays within seconds.
      assert.ok(perRow < 3, `${name}: ${perRow.toFixed(2)} ms per row`);
    }
  });
});

describe('prepareCardSyncRowText', () => {
  it('redacts instead of refusing when fields or hints only show card data together', () => {
    const cases: Array<[[string, string | null, string | null], string[], string]> = [
      [['424242424242', null, null], ['4242'], '4242424242424242'],
      [['PAY 42424242', '42424242 SHOP', null], [], '4242424242424242'],
      [['424242', '42424', '24242'], [], '4242424242424242'],
      [['SYNTHETIC 424242424242', 'CARD ***4242', null], [], '4242424242424242'],
      [['ALPHA 4012 BRAVO ***1881 CHARLIE 8888 DELTA ***1881 ECHO 8888', null, null], [], '4012888888881881'],
      [['ALPHA 4012 BRAVO ***1881 CHARLIE 8888', 'DELTA ***1881 ECHO 8888', null], [], '4012888888881881'],
      [['ALPHA ***4012 BRAVO ***8888 CHARLIE ***8888 DELTA ***1881', null, null], [], '4012888888881881'],
      [['ALPHA 4012 BRAVO 8888', 'CHARLIE 8888', 'Travel'], ['1881'], '4012888888881881'],
    ];
    for (const [[description, merchant, issuerCategory], hints, pan] of cases) {
      const result = prepareCardSyncRowText({ description, merchant, issuerCategory }, { hints });
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.redacted, true);
      const texts = [result.description, result.merchant, result.issuerCategory];
      assert.equal(cardSyncCombinedTextIssue(texts, hints), null);
      assert.equal(showsPanDigits(texts.join(' '), pan), false);
    }
    const secret = prepareCardSyncRowText({ description: 'CVV', merchant: '123' });
    assert.ok(secret.ok && cardSyncCombinedTextIssue([secret.description, secret.merchant], []) === null);
  });

  it('keeps realistic rows and resolves every measured false positive by redaction', () => {
    for (const [description, merchant, issuerCategory] of ROWS) {
      const result = prepareCardSyncRowText({ description, merchant, issuerCategory }, { hints: FIXTURE_HINTS });
      assert.ok(result.ok, description);
      assert.equal(cardSyncCombinedTextIssue([result.description, result.merchant, result.issuerCategory], FIXTURE_HINTS), null);
      if (cardSyncCombinedTextIssue([description, merchant, issuerCategory], FIXTURE_HINTS) === null) {
        assert.deepEqual([result.description, result.merchant, result.issuerCategory], [description, merchant, issuerCategory]);
      }
    }
  });

  it('refuses what single fields refuse, naming the field', () => {
    assert.deepEqual(prepareCardSyncRowText({ description: 'OK', merchant: 'CVV 123' }), { ok: false, field: 'merchant', problem: 'card-secret' });
    assert.deepEqual(prepareCardSyncRowText({ description: 'x'.repeat(5_000) }), { ok: false, field: 'description', problem: 'raw-too-long' });
  });
});
