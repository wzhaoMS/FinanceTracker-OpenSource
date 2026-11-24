import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CARD_IMPORT_MAX_RAW_TEXT } from '../cardImport.js';
import { CARD_SYNC_RAW_TEXT_MAX, CARD_SYNC_TEXT_LIMITS, cardSyncTextIssue, prepareCardSyncText } from './text.js';

// Published test card numbers only.
const PANS = ['4111111111111111', '371449635398431', '5555555555554444', '6011111111111117', '3530111333300000'];

/** True when the digits of `text` contain five consecutive digits of `pan`. */
function showsPanDigits(text: string, pan: string): boolean {
  const digits = text.replace(/[^0-9]/g, '');
  for (let index = 0; index + 5 <= pan.length; index += 1) if (digits.includes(pan.slice(index, index + 5))) return true;
  return false;
}

function prepared(raw: string, maxLength: number): string | null {
  const result = prepareCardSyncText(raw, maxLength);
  assert.ok(result.ok, `refused: ${result.ok ? '' : result.problem}`);
  return result.text;
}

describe('cardSyncTextIssue (validator, refuse-only)', () => {
  it('accepts canonical redacted text', () => {
    for (const text of ['SYNTHETIC COFFEE #42 OAKLAND CA', 'CAFÉ ***1111', "'=SUM(1)", 'Food & Drink', '(no description)', 'STORE 0042 REF 1234']) {
      assert.equal(cardSyncTextIssue(text, 500), null, text);
    }
  });

  it('names each refusal and never rewrites', () => {
    const cases: Array<[unknown, string]> = [
      [42, 'wrong-type'],
      [null, 'wrong-type'],
      ['', 'text-empty'],
      ['A'.repeat(501), 'text-too-long'],
      ['PAY 4111 1111 1111 1111', 'card-data'],
      ['REF 12345678901234', 'card-data'],
      ['CARD XX 90003', 'card-data'],
      ['CVV 123', 'card-secret'],
      ['valid thru 12/29', 'card-secret'],
      ['DOUBLE  SPACE', 'text-not-canonical'],
      [' LEADING', 'text-not-canonical'],
      ['TRAILING ', 'text-not-canonical'],
      ['TAB\tHERE', 'text-not-canonical'],
      ['NBSP\u00a0HERE', 'text-not-canonical'],
      ['ZERO\u200bWIDTH', 'text-not-canonical'],
      ['\uff26\uff35\uff2c\uff2c', 'text-not-canonical'],
      ['SIGN\u0600FORMAT', 'text-not-canonical'],
      ['BELL\u0007', 'text-not-canonical'],
      ['LONE \ud800', 'text-not-canonical'],
      ['=HYPERLINK("x")', 'text-not-canonical'],
      ['+1 FEE', 'text-not-canonical'],
      ['-5 DISCOUNT', 'text-not-canonical'],
      ['@HANDLE', 'text-not-canonical'],
      ['caf\u0065\u0301', 'text-not-canonical'],
    ];
    for (const [text, code] of cases) assert.equal(cardSyncTextIssue(text, 500), code, String(text));
  });

  it('still names card data when the caller says the string was scanned', () => {
    assert.equal(cardSyncTextIssue('PAY 4111 1111 1111 1111', 500, { scanned: true }), 'card-data');
    assert.equal(cardSyncTextIssue('CVV 123', 500, { scanned: true }), 'card-secret');
    assert.equal(cardSyncTextIssue('OK TEXT', 500, { scanned: true }), null);
  });
});

describe('prepareCardSyncText (adapter helper)', () => {
  it('redacts card numbers in any grouping or script and returns canonical text', () => {
    for (const pan of PANS) {
      const groups = pan.match(/.{1,4}/g)!;
      const variants = [
        pan, `PURCHASE ${pan} SEATTLE`, groups.join(' '), groups.join('-'), groups.join('\u2013'), groups.join('\t'),
        groups.join('  '), [...pan].join('\u200b'), pan.replace(/\d/g, (digit) => String.fromCharCode(0xff10 + Number(digit))),
        pan.replace(/\d/g, (digit) => String.fromCharCode(0x0660 + Number(digit))), `00${pan}99`, `REF${pan}`,
        `${pan.slice(0, 6)}******${pan.slice(-4)}`, `XXXX-XXXXXX-${pan.slice(-5)}`, `line one\n${groups.join(' ')}\nline three`,
      ];
      for (const variant of variants) {
        const result = prepareCardSyncText(variant, 500);
        assert.ok(result.ok, variant);
        assert.ok(result.text !== null);
        assert.equal(cardSyncTextIssue(result.text, 500), null, variant);
        assert.equal(showsPanDigits(result.text, pan), false, variant);
        assert.equal(result.redacted, true, variant);
      }
    }
  });

  it('refuses card secrets instead of redacting them', () => {
    for (const raw of ['CVV 123', 'PIN: 1234', 'exp 12/29', 'Expiry (MM/YY) 12/29', 'security code 1234']) {
      assert.deepEqual(prepareCardSyncText(raw, 500), { ok: false, problem: 'card-secret' }, raw);
    }
  });

  it('refuses oversized raw text instead of cutting it, without throwing', () => {
    assert.equal(CARD_SYNC_RAW_TEXT_MAX < CARD_IMPORT_MAX_RAW_TEXT, true);
    for (const length of [CARD_SYNC_RAW_TEXT_MAX + 1, CARD_IMPORT_MAX_RAW_TEXT + 1, 1_000_000]) {
      assert.deepEqual(prepareCardSyncText(`${'\u200b'.repeat(length - 16)}4111111111111111`, 500), { ok: false, problem: 'raw-too-long' });
    }
    assert.ok(prepareCardSyncText('A'.repeat(CARD_SYNC_RAW_TEXT_MAX), 500).ok);
  });

  it('cuts only redacted text and reports what it did', () => {
    const result = prepareCardSyncText(`${'A'.repeat(495)} 4111 1111 1111 1111`, 500);
    assert.ok(result.ok && result.text !== null);
    assert.equal(result.truncated, true);
    assert.equal(result.redacted, true);
    assert.ok(result.text.length <= 500);
    assert.equal(showsPanDigits(result.text, '4111111111111111'), false);
    assert.deepEqual(prepareCardSyncText('PLAIN TEXT', 500), { ok: true, text: 'PLAIN TEXT', redacted: false, truncated: false });
  });

  it('normalizes, neutralizes formulas, keeps surrogate pairs whole and is idempotent', () => {
    assert.equal(prepared('  \uff23\uff21\uff26\uff25\u00a0\u00a0\u00c9\t\r\nLINE\u202e TWO\u0007 ', 500), 'CAFE É LINE TWO');
    assert.equal(prepared('=SUM(1)', 500), "'=SUM(1)");
    assert.equal(prepared('lone \ud800 surrogate', 500), 'lone \ufffd surrogate');
    assert.equal(prepared('\u200b\u2066 \n\t', 500), null);
    const emoji = prepared(`${'A'.repeat(98)}😀😀`, 100)!;
    assert.ok(emoji.length <= 100);
    assert.equal(cardSyncTextIssue(emoji, 100), null);
    for (const sample of ['BLUE  BOTTLE', 'X 4111111111111111', '=SUM(1)', `${'A'.repeat(98)}😀😀`, '\uff21\uff22\uff23\u3000\uff11\uff12\uff13']) {
      const once = prepared(sample, 100);
      if (once !== null) assert.equal(prepared(once, 100), once);
    }
  });

  it('refuses invalid limits and non-strings', () => {
    assert.deepEqual(prepareCardSyncText('x', 7), { ok: false, problem: 'invalid-limit' });
    assert.deepEqual(prepareCardSyncText('x', CARD_SYNC_RAW_TEXT_MAX + 1), { ok: false, problem: 'invalid-limit' });
    assert.deepEqual(prepareCardSyncText('x', 10.5), { ok: false, problem: 'invalid-limit' });
    assert.deepEqual(prepareCardSyncText(42 as unknown as string, 500), { ok: false, problem: 'not-a-string' });
  });

  it('never leaves five digits of a card number when padding pushes it across any limit', () => {
    // Regression for v1's old raw cut: invisible or whitespace padding must not move part of a card
    // number past a length limit unredacted. Every limit the helper applies is straddled.
    const pads = ['\u200b', '\u2060', '\ufeff', '\u00ad', '\ufe0f', ' ', '\t', '\n', '\u00a0', '\u3000', 'A', 'A\u200b', ' \u200b'];
    const limits = [8, CARD_SYNC_TEXT_LIMITS.issuerCategory, CARD_SYNC_TEXT_LIMITS.merchant, CARD_SYNC_TEXT_LIMITS.description];
    let checked = 0;
    for (const pan of ['4111111111111111', '371449635398431']) {
      const shapes = [pan, pan.match(/.{1,4}/g)!.join(' '), [...pan].join('\u200b'), [...pan].join(' ')];
      for (const limit of limits) {
        for (const pad of pads) {
          for (const shape of shapes) {
            for (let inside = 0; inside <= shape.length; inside += 1) {
              const before = Math.max(0, Math.ceil((limit - inside) / pad.length));
              for (const raw of [`${pad.repeat(before)}${shape}${pad.repeat(3)}`, `X${pad.repeat(before)}${shape}`]) {
                const result = prepareCardSyncText(raw, limit);
                checked += 1;
                if (!result.ok || result.text === null) continue;
                assert.ok(result.text.length <= limit);
                assert.equal(cardSyncTextIssue(result.text, limit), null);
                assert.equal(showsPanDigits(result.text, pan), false, JSON.stringify({ limit, pad, inside }));
              }
            }
          }
        }
      }
      // Straddling the raw cap itself: refused when over, fully redacted when under.
      for (const pad of ['\u200b', ' ', 'A']) {
        for (let inside = 0; inside <= pan.length; inside += 1) {
          const raw = `${pad.repeat(CARD_SYNC_RAW_TEXT_MAX - inside)}${pan}`;
          const result = prepareCardSyncText(raw, 500);
          if (raw.length > CARD_SYNC_RAW_TEXT_MAX) assert.deepEqual(result, { ok: false, problem: 'raw-too-long' });
          else assert.ok(result.ok && (result.text === null || !showsPanDigits(result.text, pan)));
        }
      }
      // v1's old 20,000-unit cut: far over the cap, so refused rather than cut.
      assert.deepEqual(prepareCardSyncText(`${'\u200b'.repeat(19_990)}${pan}`, 500), { ok: false, problem: 'raw-too-long' });
    }
    assert.ok(checked > 10_000);
  });
});
