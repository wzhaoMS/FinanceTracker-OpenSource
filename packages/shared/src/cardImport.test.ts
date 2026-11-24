import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCardImportPayload,
  CARD_IMPORT_MAX_RAW_TEXT,
  CARD_IMPORT_MAX_ROWS,
  CardImportError,
  cardImportTextProblem,
  findCardImportSensitivePaths,
  reconcileCardImport,
  sanitizeCardText,
  serializeCardImportPayload,
  summarizeCardImportRows,
  validateCardImportPayload,
  type CardImportDraft,
  type CardImportPayload,
} from './cardImport.js';
import { assignCardDedupeKeys, cardExternalIdHash } from './cardDedupe.js';
import { containsCardData } from './cardNumbers.js';
import { containsLongDigitRun, normalizeCardText } from './cardText.js';

// Published test card numbers only.
const PANS = ['4111111111111111', '371449635398431', '5555555555554444', '6011111111111117', '3530111333300000'];

function assertSafeText(text: string | null, pan?: string): void {
  if (text === null) return;
  assert.equal(containsCardData(text), false, 'containsCardData');
  assert.equal(containsLongDigitRun(text), false, 'long digit run');
  assert.doesNotMatch(text, /\d{13}/);
  if (pan) {
    // At most the last four digits of the card number survive.
    for (let i = 0; i + 5 <= pan.length; i += 1) assert.ok(!text.replace(/\D/g, '').includes(pan.slice(i, i + 5)), 'exposes 5+ PAN digits');
  }
}

function draft(overrides: Partial<CardImportDraft> = {}): CardImportDraft {
  return {
    source: 'test-source',
    parserVersion: 'holdr-card-import@1.0.0',
    issuer: 'amex',
    currency: 'USD',
    rows: [
      { transactionDate: '2026-09-14', amountMinor: 575, kind: 'purchase', description: 'BLUE BOTTLE COFFEE', externalId: "'320262570000000001'" },
      { transactionDate: '2026-09-15', amountMinor: -12000, kind: 'payment', description: 'ONLINE PAYMENT - THANK YOU' },
    ],
    ...overrides,
  };
}

function payload(overrides: Partial<CardImportDraft> = {}): CardImportPayload {
  return buildCardImportPayload(draft(overrides)).payload;
}

describe('sanitizeCardText', () => {
  it('leaves no card number, masked card number or 13+ digit run in any grouping or script', () => {
    for (const pan of PANS) {
      const groups = pan.match(/.{1,4}/g)!;
      const variants = [
        pan,
        `PURCHASE ${pan} SEATTLE`,
        groups.join(' '),
        groups.join('-'),
        groups.join('\u2013'),
        groups.join('\t'),
        groups.join('  '),
        groups.join('\t\t\t\t'),
        [...pan].join('\u200b'),
        pan.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))),
        pan.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d))),
        `00${pan}99`,
        `REF${pan}`,
        `${pan.slice(0, 6)}******${pan.slice(-4)}`,
        `XXXX-XXXXXX-${pan.slice(-5)}`,
        `line one\n${groups.join(' ')}\nline three`,
      ];
      for (const variant of variants) assertSafeText(sanitizeCardText(variant, 500), pan);
    }
  });

  it('collapses every run of 13 or more digits to its last four', () => {
    const out = sanitizeCardText('FOLIO 1234567890123456789 ROOM 12', 500)!;
    assertSafeText(out);
    assert.match(out, /^FOLIO \*\*\*6789 ROOM 12$/);
    assert.equal(sanitizeCardText('PHONE 800-555-1234 STORE 00123', 500), 'PHONE 800-555-1234 STORE 00123');
  });

  it('normalizes text: NFKC, single spaces, no control, invisible or bidi characters', () => {
    assert.equal(sanitizeCardText('  ＣＡＦＥ\u00a0\u00a0É\t\r\nLINE\u202e TWO\u0007 ', 500), 'CAFE É LINE TWO');
    assert.equal(sanitizeCardText('ZERO\u200bWIDTH', 500), 'ZEROWIDTH');
    assert.equal(sanitizeCardText('\u200b\u2066 \n\t', 500), null);
    assert.equal(sanitizeCardText('', 500), null);
    assert.equal(sanitizeCardText('caf\u0065\u0301', 500), 'café');
    assert.equal(sanitizeCardText('lone \ud800 surrogate', 500), 'lone \ufffd surrogate');
  });

  it('neutralizes spreadsheet formulas with a leading apostrophe', () => {
    assert.equal(sanitizeCardText('=HYPERLINK("http://x.example","y")', 500), '\'=HYPERLINK("http://x.example","y")');
    for (const lead of ['+', '-', '@']) assert.equal(sanitizeCardText(`${lead}cmd|' /C calc'!A0`, 500)![0], "'");
    assert.equal(sanitizeCardText(' =1+1', 500), "'=1+1");
  });

  it('truncates to the limit without splitting a surrogate pair, and is idempotent', () => {
    const long = `${'A'.repeat(98)}😀😀`;
    const out = sanitizeCardText(long, 100)!;
    assert.ok(out.length <= 100);
    assert.equal(cardImportTextProblem(out, 100), null);
    for (const sample of ['BLUE  BOTTLE', `X ${PANS[0]}`, '=SUM(1)', long, 'ＡＢＣ　１２３']) {
      const once = sanitizeCardText(sample, 100);
      assert.equal(sanitizeCardText(once ?? '', 100), once);
    }
  });

  it('never outputs a five-digit prefix of a card number present anywhere in its input', () => {
    // Redaction sees the complete input and only then is the result cut, so no cut can leave a prefix behind.
    const pans = ['4012888888881881', '371449635398431', '5555555555554444'];
    const pads: Array<(size: number) => string> = [
      (size) => '\u200b'.repeat(size),
      (size) => 'A'.repeat(size),
      (size) => 'AB '.repeat(Math.ceil(size / 3)).slice(0, size),
    ];
    const sizes = [0, 7, 484, 490, 495, 500, 19_980, 19_987, 19_988, 20_000, 40_000];
    for (const pan of pans) {
      const grouped = pan.match(/.{1,4}/g)!.join(' ');
      for (const pad of pads) {
        for (const size of sizes) {
          for (const input of [`${pad(size)}${pan}`, `${pad(size)} ${grouped} TAIL`, `${pan} ${pad(size)}`]) {
            for (const limit of [500, 100]) {
              const out = sanitizeCardText(input, limit) ?? '';
              assert.ok(!out.replace(/\D/g, '').includes(pan.slice(0, 5)), `${pan.slice(-4)} padded ${size} limit ${limit}`);
              assert.equal(containsCardData(out), false);
            }
          }
        }
      }
    }
    const atCap = `${'A'.repeat(CARD_IMPORT_MAX_RAW_TEXT - 16)}${pans[0]}`;
    assert.equal(sanitizeCardText(atCap, 500), 'A'.repeat(500));
  });

  it('refuses input longer than the raw cap instead of cutting it', () => {
    const over = `${'A'.repeat(CARD_IMPORT_MAX_RAW_TEXT - 15)}${PANS[0]}`;
    assert.throws(() => sanitizeCardText(over, 500), (error: Error) => error instanceof CardImportError
      && /longer than 65536 characters before redaction; refused, never truncated/.test(error.message) && !/\d{5}/.test(error.message.replace('65536', '')));
    try {
      buildCardImportPayload(draft({ rows: [{ transactionDate: '2026-09-14', amountMinor: 1, kind: 'purchase', description: over }] }));
      assert.fail('expected an error');
    } catch (error) {
      assert.ok(error instanceof CardImportError);
      assert.deepEqual(error.issues, [{ path: '$.rows[0].description', message: 'is longer than 65536 characters before redaction; refused, never truncated' }]);
    }
  });

  it('only produces text that passes the payload text rules', () => {
    const samples = ['  a  b ', `${PANS[1]} x`, '-5 DISCOUNT', 'é\u0301', '\u202eevil', 'X'.repeat(600)];
    for (const sample of samples) {
      const out = sanitizeCardText(sample, 500);
      if (out !== null) assert.equal(cardImportTextProblem(out, 500), null, sample);
    }
  });
});

describe('buildCardImportPayload', () => {
  it('hashes references, fingerprints the rest and keeps two identical purchases', () => {
    const { payload: result } = buildCardImportPayload(draft({
      rows: [
        { transactionDate: '2026-09-14', amountMinor: 575, kind: 'purchase', description: 'BLUE BOTTLE COFFEE' },
        { transactionDate: '2026-09-14', amountMinor: 575, kind: 'purchase', description: 'BLUE  bottle coffee ' },
        { transactionDate: '2026-09-15', amountMinor: -500, kind: 'refund', description: 'REFUND', externalId: ' 320262570000000002 ' },
      ],
    }));
    const [a, b, c] = result.rows;
    assert.ok(a.fingerprint && b.fingerprint && a.fingerprint !== b.fingerprint);
    assert.equal(a.externalIdHash, null);
    assert.equal(c.externalIdHash, cardExternalIdHash('320262570000000002'));
    assert.equal(c.fingerprint, null);
    assert.equal(b.description, 'BLUE bottle coffee');
    const keys = assignCardDedupeKeys(result.rows);
    assert.deepEqual(keys.map((key) => ('fingerprint' in key ? key.fingerprint : key.externalIdHash)), [a.fingerprint, b.fingerprint, c.externalIdHash]);
  });

  it('keys rows that share a reference by content so none is dropped', () => {
    const built = buildCardImportPayload(draft({
      rows: [
        { transactionDate: '2026-09-14', amountMinor: 575, kind: 'purchase', description: 'A', externalId: 'REF-1' },
        { transactionDate: '2026-09-16', amountMinor: -575, kind: 'refund', description: 'A', externalId: 'REF-1' },
        { transactionDate: '2026-09-17', amountMinor: 100, kind: 'purchase', description: 'B', externalId: 'REF-2' },
      ],
    }));
    assert.deepEqual(built.repeatedExternalIdRows, [0, 1]);
    assert.equal(built.payload.rows[0].externalIdHash, null);
    assert.ok(built.payload.rows[0].fingerprint);
    assert.equal(built.payload.rows[2].externalIdHash, cardExternalIdHash('REF-2'));
  });

  it('computes coverage, widens a requested range to include every row, and totals by status and kind', () => {
    const plain = payload();
    assert.deepEqual(plain.coverage, { start: '2026-09-14', end: '2026-09-15' });
    const built = buildCardImportPayload(draft({ coverage: { start: '2026-09-15', end: '2026-09-30' } }));
    assert.equal(built.coverageWidened, true);
    assert.deepEqual(built.payload.coverage, { start: '2026-09-14', end: '2026-09-30' });
    const pending = payload({
      rows: [
        { transactionDate: '2026-09-14', amountMinor: 575, kind: 'purchase', description: 'A' },
        { transactionDate: '2026-09-14', amountMinor: 900, kind: 'purchase', description: 'B', status: 'pending' },
        { transactionDate: '2026-09-14', amountMinor: -200, kind: 'refund', description: 'C' },
      ],
    });
    assert.equal(pending.totals.posted.count, 2);
    assert.equal(pending.totals.posted.chargesMinor, 575);
    assert.equal(pending.totals.posted.creditsMinor, -200);
    assert.equal(pending.totals.posted.netMinor, 375);
    assert.equal(pending.totals.pending.netMinor, 900);
    assert.deepEqual(pending.totals.posted.byKind.refund, { count: 1, amountMinor: -200 });
    assert.throws(() => buildCardImportPayload(draft({ rows: [] })), /explicit coverage/);
    assert.equal(payload({ rows: [], coverage: { start: '2026-09-01', end: '2026-09-30' } }).rows.length, 0);
  });

  it('redacts every text field and reports which rows changed', () => {
    const built = buildCardImportPayload(draft({
      rows: [{
        transactionDate: '2026-09-14', amountMinor: 1, kind: 'purchase',
        description: `HOTEL ${PANS[0]}`, merchant: `SHOP ${PANS[1]}`, issuerCategory: 'CAT 12345678901234',
      }],
    }));
    const [row] = built.payload.rows;
    assertSafeText(row.description, PANS[0]);
    assertSafeText(row.merchant, PANS[1]);
    assertSafeText(row.issuerCategory);
    assert.deepEqual(built.redactedRows, [0]);
    assert.doesNotMatch(serializeCardImportPayload(built.payload), /\d{13}/);
  });

  it('writes text in the stored form, so the repository keeps it unchanged and recomputes the same keys', () => {
    const descriptions = [
      'ＣＡＦＥ ２４', 'CAFE\u00a0\u00a0CREME', 'TEA\u200b HOUSE', 'SHOP ❤️ 12', 'كافيه ٤٥', 'MAN\u0303ANA e\u0301',
      'DINER \u2066NO 7\u2069', 'VS\ufe0fTEST', 'ᄀ\u1161 MART', 'MIXED ２٤5', 'TEA HOUSE',
    ];
    const { payload: built } = buildCardImportPayload(draft({
      rows: descriptions.map((description, index) => ({
        transactionDate: '2026-09-14', amountMinor: 100 + (index % 2), kind: 'purchase' as const, description,
        externalId: index % 3 === 0 ? `REF-${index}` : null,
      })),
    }));
    // Phase 2's repository stores normalizeCardText(text).trim() and keys rows with assignCardDedupeKeys.
    const stored = built.rows.map((row) => ({ ...row, description: normalizeCardText(row.description).trim() }));
    assert.deepEqual(stored.map((row) => row.description), built.rows.map((row) => row.description));
    const keys = assignCardDedupeKeys(stored).map((key) => ('fingerprint' in key ? key.fingerprint : key.externalIdHash));
    assert.deepEqual(keys, built.rows.map((row) => row.fingerprint ?? row.externalIdHash));
    assert.equal(built.rows[0].description, 'CAFE 24');
    assert.equal(built.rows[4].description, 'كافيه 45');
    assert.equal(built.rows[2].description, 'TEA HOUSE');
    assert.notEqual(built.rows[2].fingerprint, built.rows[10].fingerprint);
  });

  it('refuses card security codes, PINs and expiry dates instead of redacting them', () => {
    try {
      buildCardImportPayload(draft({
        rows: [
          { transactionDate: '2026-09-14', amountMinor: 1, kind: 'purchase', description: 'CVV 123; expiry 12/29' },
          { transactionDate: '2026-09-14', amountMinor: 2, kind: 'purchase', description: 'SHOP', merchant: 'PIN 2468' },
          { transactionDate: '2026-09-14', amountMinor: 3, kind: 'purchase', description: 'SHOP', issuerCategory: '{"cvv":"123"}' },
          { transactionDate: '2026-09-14', amountMinor: 4, kind: 'purchase', description: 'EXPEDIA 12/29 PINTEREST CVS PHARMACY' },
        ],
      }));
      assert.fail('expected an error');
    } catch (error) {
      assert.ok(error instanceof CardImportError);
      assert.deepEqual(error.issues.map((issue) => issue.path), ['$.rows[0].description', '$.rows[1].merchant', '$.rows[2].issuerCategory']);
      assert.ok(error.issues.every((issue) => /security code, PIN or expiry date/.test(issue.message)));
      assert.doesNotMatch(JSON.stringify(error.issues), /123|2468|12\/29/);
    }
  });

  it('rejects bad drafts with value-free issues', () => {
    try {
      buildCardImportPayload(draft({
        rows: [{ transactionDate: '2026-02-30', amountMinor: 1.5, kind: 'purchase', description: 'X', externalId: `bad\u0001${PANS[0]}` }],
      }));
      assert.fail('expected an error');
    } catch (error) {
      assert.ok(error instanceof CardImportError);
      const text = JSON.stringify(error.issues);
      assert.match(text, /transactionDate/);
      assert.match(text, /amountMinor/);
      assert.match(text, /control characters/);
      assert.doesNotMatch(text, /4111/);
    }
    assert.throws(() => buildCardImportPayload(draft({ source: 'Amex CSV' })), CardImportError);
    assert.throws(() => buildCardImportPayload(draft({ rejectedCount: CARD_IMPORT_MAX_ROWS })), /split the export/);
  });
});

describe('validateCardImportPayload', () => {
  const valid = () => JSON.parse(serializeCardImportPayload(payload())) as Record<string, any>;

  it('accepts the canonical serialization and returns a fresh copy', () => {
    const input = valid();
    const result = validateCardImportPayload(input);
    assert.ok(result.ok);
    assert.notEqual(result.payload, input);
    assert.equal(serializeCardImportPayload(result.payload), serializeCardImportPayload(payload()));
  });

  it('rejects unknown, missing and mistyped keys without echoing them', () => {
    const extra = valid();
    extra.JaneDoe = 'hello';
    extra.rows[0].cardNumberDigits = 'x';
    const result = validateCardImportPayload(extra);
    assert.equal(result.ok, false);
    const text = JSON.stringify(result);
    assert.doesNotMatch(text, /JaneDoe|cardNumberDigits|hello/);
    assert.match(text, /unexpected key/);

    const missing = valid();
    delete missing.coverage;
    delete missing.rows[1].kind;
    const issues = (validateCardImportPayload(missing) as { issues: Array<{ path: string }> }).issues.map((issue) => issue.path);
    assert.ok(issues.includes('$.coverage'));
    assert.ok(issues.includes('$.rows[1].kind'));

    for (const [key, value] of [['version', 2], ['format', 'other'], ['source', 'Amex'], ['currency', 'usd'], ['owner', 'bob'], ['cards', ['12345']]] as const) {
      const bad = valid();
      bad[key] = value;
      assert.equal(validateCardImportPayload(bad).ok, false, key);
    }
    assert.equal(validateCardImportPayload([]).ok, false);
    assert.equal(validateCardImportPayload(null).ok, false);
  });

  it('enforces row types, text rules and lengths', () => {
    const cases: Array<[string, unknown]> = [
      ['amountMinor', 12.5],
      ['amountMinor', 10_000_000_000],
      ['amountMinor', '575'],
      ['transactionDate', '2026-13-01'],
      ['postedDate', '20260914'],
      ['status', 'removed'],
      ['kind', 'transfer'],
      ['description', ''],
      ['description', ' padded'],
      ['description', 'two  spaces'],
      ['description', 'X'.repeat(501)],
      ['description', '=cmd'],
      ['description', 'bell\u0007'],
      ['description', 'ＷＩＤＥ'],
      ['description', `card ${PANS[0]}`],
      ['description', 'ref 1234567890123'],
      ['merchant', 'M'.repeat(201)],
      ['description', 'CVV 123; expiry 12/29'],
      ['merchant', 'PIN 2468'],
      ['issuerCategory', 'security_code=1234'],
      ['issuerCategory', 7],
      ['externalIdHash', 'xid1:abc'],
    ];
    for (const [field, value] of cases) {
      const bad = valid();
      bad.rows[0][field] = value;
      const result = validateCardImportPayload(bad);
      assert.equal(result.ok, false, `${field}=${String(value).slice(0, 20)}`);
      assert.doesNotMatch(JSON.stringify(result), /4111|1234567890123/);
    }
  });

  it('recomputes dedupe keys, coverage and totals instead of trusting them', () => {
    const fingerprint = valid();
    fingerprint.rows[1].amountMinor = -12001;
    const result = validateCardImportPayload(fingerprint);
    assert.equal(result.ok, false);
    const paths = (result as { issues: Array<{ path: string }> }).issues.map((issue) => issue.path);
    assert.ok(paths.includes('$.rows[1].fingerprint'));
    assert.ok(paths.includes('$.totals.posted.netMinor'));

    const both = valid();
    both.rows[0].fingerprint = both.rows[1].fingerprint;
    assert.equal(validateCardImportPayload(both).ok, false);

    const outside = valid();
    outside.coverage.end = '2026-09-14';
    assert.equal(validateCardImportPayload(outside).ok, false);

    const repeated = JSON.parse(serializeCardImportPayload(payload({
      rows: [
        { transactionDate: '2026-09-14', amountMinor: 1, kind: 'purchase', description: 'A', externalId: 'R1' },
        { transactionDate: '2026-09-14', amountMinor: 2, kind: 'purchase', description: 'B', externalId: 'R2' },
      ],
    })));
    repeated.rows[1].externalIdHash = repeated.rows[0].externalIdHash;
    assert.equal(validateCardImportPayload(repeated).ok, false);
  });

  it('limits rows plus rejected rows', () => {
    const big = valid();
    big.rejectedCount = CARD_IMPORT_MAX_ROWS - 1;
    assert.equal(validateCardImportPayload(big).ok, false);
    const rows = Array.from({ length: CARD_IMPORT_MAX_ROWS + 1 }, (_value, index) => ({ ...big.rows[1], amountMinor: -(index + 1) }));
    const tooMany = { ...valid(), rows };
    const result = validateCardImportPayload(tooMany);
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result), /at most 10000/);
  });

  it('checks statement figures', () => {
    for (const statement of [
      { chargesMinor: -1, creditsMinor: null, netMinor: null, previousBalanceMinor: null, newBalanceMinor: null },
      { chargesMinor: null, creditsMinor: 5, netMinor: null, previousBalanceMinor: null, newBalanceMinor: null },
      { chargesMinor: null, creditsMinor: null, netMinor: null, previousBalanceMinor: 100, newBalanceMinor: null },
      { chargesMinor: null, creditsMinor: null, netMinor: null, previousBalanceMinor: null, newBalanceMinor: null },
      { chargesMinor: 1e12, creditsMinor: null, netMinor: null, previousBalanceMinor: null, newBalanceMinor: null },
    ]) {
      const bad = valid();
      bad.statement = statement;
      assert.equal(validateCardImportPayload(bad).ok, false, JSON.stringify(statement));
    }
  });
});

describe('findCardImportSensitivePaths', () => {
  it('reports paths, never values, and hides keys outside the schema', () => {
    const body = {
      ...JSON.parse(serializeCardImportPayload(payload())),
      JaneDoe: PANS[0],
      [PANS[1]]: 'x',
    };
    body.rows[1].description = `PAY ${PANS[2]}`;
    body.rows[0].merchant = 'ref 99999999999999999';
    body.rows[0].amountMinor = 4111111111111111;
    const paths = findCardImportSensitivePaths(body);
    assert.ok(paths.includes('$.<key>'));
    assert.ok(paths.includes('$.<card number>'));
    assert.ok(paths.includes('$.rows[1].description'));
    assert.ok(paths.includes('$.rows[0].merchant'));
    assert.ok(paths.includes('$.rows[0].amountMinor'));
    const text = JSON.stringify(paths);
    assert.doesNotMatch(text, /JaneDoe|\d{5}/);
  });

  it('reports card secrets in values, keys and key/value pairs, and leaves look-alike merchants alone', () => {
    const body = JSON.parse(serializeCardImportPayload(payload()));
    body.rows[0].description = 'CVV 123; expiry 12/29';
    body.rows[0].merchant = 'PIN 2468';
    body.rows[1].issuerCategory = '{"cvv":"123","expiry":"12/29"}';
    body.rows[1].cvv = '123';
    body.rows[1].securityCode = 1234;
    body.statement = { exp_date: '12/29' };
    body['CVV 999'] = true;
    const paths = findCardImportSensitivePaths(body);
    assert.deepEqual(paths, [
      '$.statement.<key>', '$.<key>', '$.rows[0].description', '$.rows[0].merchant',
      '$.rows[1].issuerCategory', '$.rows[1].<key>',
    ]);
    assert.doesNotMatch(JSON.stringify(paths), /cvv|security|exp_date|123|2468/i);
    const clean = JSON.parse(serializeCardImportPayload(payload()));
    clean.rows[0].description = 'EXPEDIA 12/29 PINTEREST CVS PHARMACY EXP REALTY';
    assert.deepEqual(findCardImportSensitivePaths(clean), []);
  });

  it('fails closed on deep or cyclic input', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i += 1) deep = [deep];
    assert.ok(findCardImportSensitivePaths({ rows: [deep] }).some((path) => path.endsWith('<limit>')));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.ok(findCardImportSensitivePaths(cyclic).some((path) => path.endsWith('<limit>')));
  });

  it('scans a maximum-size payload row by row without hitting the scan limits', () => {
    const base = JSON.parse(serializeCardImportPayload(payload()));
    const rows = Array.from({ length: CARD_IMPORT_MAX_ROWS }, () => ({ ...base.rows[0] }));
    assert.deepEqual(findCardImportSensitivePaths({ ...base, rows }), []);
    rows[9_999] = { ...rows[9_999], description: PANS[0] };
    assert.deepEqual(findCardImportSensitivePaths({ ...base, rows }), ['$.rows[9999].description']);
  });

  it('accepts a clean payload', () => {
    assert.deepEqual(findCardImportSensitivePaths(JSON.parse(serializeCardImportPayload(payload()))), []);
  });
});

describe('reconcileCardImport', () => {
  const totals = summarizeCardImportRows([
    { status: 'posted', amountMinor: 10_000, kind: 'purchase' },
    { status: 'posted', amountMinor: 500, kind: 'fee' },
    { status: 'posted', amountMinor: -4_000, kind: 'payment' },
    { status: 'pending', amountMinor: 999, kind: 'purchase' },
  ]);

  it('is unchecked without figures, and checks charges, credits, net and balances on posted rows only', () => {
    assert.deepEqual(reconcileCardImport(totals.posted, null), { status: 'unchecked', checks: [] });
    const match = reconcileCardImport(totals.posted, {
      chargesMinor: 10_500, creditsMinor: -4_000, netMinor: 6_500, previousBalanceMinor: 1_000, newBalanceMinor: 7_500,
    });
    assert.equal(match.status, 'match');
    assert.equal(match.checks.length, 4);
    const mismatch = reconcileCardImport(totals.posted, {
      chargesMinor: null, creditsMinor: null, netMinor: null, previousBalanceMinor: 1_000, newBalanceMinor: 7_600,
    });
    assert.equal(mismatch.status, 'mismatch');
    assert.deepEqual(mismatch.checks[0], { check: 'balance', expectedMinor: 7_600, actualMinor: 7_500, differenceMinor: -100, ok: false });
  });
});

describe('serializeCardImportPayload', () => {
  it('is deterministic, one row per line, and round-trips through the validator', () => {
    const text = serializeCardImportPayload(payload());
    assert.equal(text, serializeCardImportPayload(payload()));
    assert.ok(text.endsWith('}\n'));
    assert.equal(text.split('\n').filter((line) => line.startsWith('    {"transactionDate"')).length, 2);
    const result = validateCardImportPayload(JSON.parse(text));
    assert.ok(result.ok);
    assert.equal(serializeCardImportPayload(result.payload), text);
  });
});

// Regressions for card numbers whose digit groups are split by dots, slashes or mixed
// separators, which the shared recognizer (cardNumbers) handles since Phase 1's 06e694d.
const MIXED = ['4111.1111 1111.1111', '4111.1111-1111.1111', '4111.1111.1111.1111', '4111/1111/1111/1111'];

describe('card numbers split by dots, slashes or mixed separators', () => {
  it('are redacted by sanitizeCardText', () => {
    for (const text of MIXED) assertSafeText(sanitizeCardText(`HOTEL ${text} FOLIO`, 500), PANS[0]);
  });

  it('are reported by the sensitive-path scan and refused by the validator', () => {
    for (const text of MIXED) {
      const body = JSON.parse(serializeCardImportPayload(payload()));
      body.rows[0].description = `HOTEL ${text}`;
      assert.deepEqual(findCardImportSensitivePaths(body), ['$.rows[0].description']);
      assert.equal(validateCardImportPayload(body).ok, false);
    }
  });

  it('never reach a built payload', () => {
    const built = buildCardImportPayload(draft({
      rows: MIXED.map((text, index) => ({ transactionDate: '2026-09-14', amountMinor: 100 + index, kind: 'purchase' as const, description: `HOTEL ${text}` })),
    }));
    for (const row of built.payload.rows) assertSafeText(row.description, PANS[0]);
  });
});
