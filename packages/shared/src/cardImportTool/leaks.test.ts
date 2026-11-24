import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCardImportText, sanitizeCardText } from '../cardImport.js';
import { findCardNumbers, redactCardNumbers } from '../cardNumbers.js';
import { CARD_SPAN_MASK, CARD_SPAN_SEPARATOR, cardNumberCandidates, cardRuns, showsCardDigits } from './leaks.js';

const PAN = '4012888888881881';

describe('card numbers a row\'s raw text holds', () => {
  it('are the numbers the shared recognizer redacts, in any spacing, script or separators', () => {
    for (const text of [
      `SHOP ${PAN}`, 'SHOP 4012  8888 8888 1881', 'SHOP 4012\u200b 8888 8888 1881', 'ＳＨＯＰ ４０１２ ８８８８ ８８８８ １８８１',
      'SHOP 4012.8888 8888.1881', 'SHOP 4012-8888-8888-1881 REF', `09/14/2026 ${PAN}`, `CARD 12 ${PAN}`,
    ]) {
      assert.ok(cardNumberCandidates(text).has(PAN), text);
    }
    // UnionPay numbers may lack a Luhn check digit, as in the shared recognizer.
    assert.ok(cardNumberCandidates('UNIONPAY 6212 3456 7890 1235').has('6212345678901235'));
    // Read as card import stores the text: control characters between the groups are spaces there.
    assert.ok(cardNumberCandidates('PAY 4012\u00018888\u00018888\u00011881').has(PAN));
  });

  it('leave out digits the recognizer keeps: dates, amounts, phone numbers, short and masked numbers', () => {
    for (const text of [
      'PAID 09/14/2026 12.50 1234', 'CALL 1-800-555-0199 EXT 12345', 'UBER *TRIP 8005928996 CA', 'SHOP 4012 8888 8888',
      'XXXX-XXXXXX-90003', '4012 88** **** 1881', 'AMAZON MKTP US*2K4 #1234', 'ORDER 2026-09-14 AMT 1,234.56',
    ]) {
      assert.deepEqual([...cardNumberCandidates(text)], [], text);
    }
  });
});

describe('stored text that shows card digits', () => {
  const sources = ['SHOP 4012 8888 8888', `SHOP 4012  8888 8888 ${PAN.slice(-4)}`, 'XXXX-1881'];

  it('is caught however the digits got there, field by field or put together', () => {
    // The reported output: NAME's 12 digits beside MEMO's redacted card number.
    assert.equal(showsCardDigits(['SHOP 4012 8888 8888 SHOP ***1881', 'SHOP 4012 8888 8888', null], sources), true);
    // Injected straight into the stored fields, past any join or merchant logic.
    assert.equal(showsCardDigits(['SHOP ***1881', 'SHOP 40128', null], sources), true);
    assert.equal(showsCardDigits(['SHOP ***1881', 'SHOP', '4012 8888 8888'], sources), true);
    // Split across fields, in either order, and between letters.
    assert.equal(showsCardDigits(['28 SHOP ***1881', 'SHOP 401', null], sources), true);
    assert.equal(showsCardDigits(['SHOP 401', '28 SHOP', null], sources), true);
    assert.equal(showsCardDigits(['SHOP 4 A 0 B 1 C 2 D 8 ***1881', null, null], sources), true);
    // A full card number in another raw field, such as ACCTID, counts too.
    assert.equal(showsCardDigits(['PAYMENT 4111 1111 1111', null, null], ['PAYMENT 4111 1111 1111', null, '4111111111111111']), true);
  });

  it('is caught across redactions: only the four digits each one keeps are left out', () => {
    // The reported case: extra copies of the number put redactions between the shortened copy's groups.
    const reported = `ALPHA 4012 BRAVO ${PAN} CHARLIE 8888 DELTA ${PAN} ECHO 8888`;
    assert.equal(showsCardDigits(['ALPHA 4012 BRAVO ***1881 CHARLIE 8888 DELTA ***1881 ECHO 8888', null, null], [reported, null, PAN]), true);
    // Fragments between several redactions and letters.
    assert.equal(showsCardDigits(['A 40 ***1881 B 12 ***1881 C 88 ***1881 D 8', null, null], sources), true);
    // Fragments split across fields, with a redaction in each.
    assert.equal(showsCardDigits(['X 4012 ***1881', 'Y ***1881 8888', 'Z 88 ***1881 88'], sources), true);
    assert.equal(showsCardDigits(['Z 88 ***1881 88', 'X 4012 ***1881', 'Y ***1881 8888'], sources), true);
    // Control characters between the groups of the full number, which storage reads as spaces.
    assert.equal(showsCardDigits(['PAY ***1881 REF 4012 8888 8888', null, null], ['PAY 4012\u00018888\u00018888\u00011881 REF 4012 8888 8888']), true);
  });

  it('is not claimed for redacted text, the last four it keeps, or digits that are not the card\'s', () => {
    assert.equal(showsCardDigits(['SHOP ***1881', 'SHOP', null], sources), false);
    // A store number and an amount on either side of the redaction are not the card's digits.
    assert.equal(showsCardDigits(['STORE #204 PAID 12.50 CARD ***1881', 'STORE #204', null], [...sources, `STORE #204 PAID 12.50 CARD ${PAN}`]), false);
    assert.equal(showsCardDigits(['STORE #204 CARD ***1881 PAID 12.50', 'STORE #204', 'SIC 5411'], [...sources, `STORE #204 CARD ${PAN} PAID 12.50`]), false);
    // A redaction cut short by the length limit keeps its digits in the comparison, which stays clean here.
    assert.equal(showsCardDigits([`${'A'.repeat(495)} ***1`, 'A'.repeat(200), null], ['A'.repeat(495), PAN]), false);
    // The digit before `***1881` is the card's, but a redaction keeps only the last four on its own.
    assert.equal(showsCardDigits(['SHOP 8 ***1881', 'SHOP 8', null], sources), false);
    assert.equal(showsCardDigits(['SHOP #2026 09/14 12.50 ***1881', 'SHOP #2026', 'SIC 5411'], sources), false);
    // Rows without a card number in their raw text are never refused.
    assert.equal(showsCardDigits(['PAID 09/14/2026 12.50 1234', null, null], ['PAID 09/14/2026 12.50 1234']), false);
    assert.equal(showsCardDigits(['SHOP 4012 8888 8888', null, null], ['SHOP 4012 8888 8888', null, 'XXXX-1881']), false);
  });
});

describe('the separators and masks leaks.ts copies from the shared recognizer', () => {
  it('match it character by character, in both directions', () => {
    const label = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    let copied = 0;
    let compared = 0;
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCodePoint(code);
      const text = `4012${char}8888${char}8888${char}1881`;
      // Each copied character keeps the groups one card span for the recognizer; a separator also
      // joins them into one card number, while a mask splits them.
      const separator = CARD_SPAN_SEPARATOR.test(char);
      if (separator || CARD_SPAN_MASK.test(char)) {
        copied += 1;
        assert.equal(redactCardNumbers(text), '***1881', `${label(code)} is not part of a card span for the recognizer`);
        assert.equal(findCardNumbers(text).length, separator ? 1 : 0, `${label(code)} joins or splits the groups differently`);
      }
      // Every other character, as card import stores it: where the recognizer redacts the groups as
      // one span, leaks.ts must see one run, and where they form one card number, that candidate.
      // Letters and digits are neither; X and # are masks only outside words, left out on purpose.
      if (/[\p{Cn}\p{Co}\p{L}\p{N}]/u.test(char)) continue;
      const stored = normalizeCardImportText(char);
      if (/[\p{L}\p{N}#]/u.test(stored)) continue;
      compared += 1;
      const oneSpan = sanitizeCardText(text, 500) === '***1881';
      assert.equal(cardRuns(text).length === 1, oneSpan, `${label(code)}: runs differ from the recognizer's spans`);
      const oneCard = oneSpan && findCardNumbers(normalizeCardImportText(text)).length === 1;
      assert.equal(cardNumberCandidates(text).has(PAN), oneCard, `${label(code)}: candidates differ from the recognizer's card numbers`);
    }
    assert.ok(copied > 40 && compared > 5_000, `${copied} copied, ${compared} compared`);
  });
});
