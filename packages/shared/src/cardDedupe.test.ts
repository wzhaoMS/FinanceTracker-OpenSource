import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  assignCardDedupeKeys, canonicalCardDescription, CARD_DEDUPE_VERSION, cardExternalIdHash, cardTransactionFingerprint,
  isCardExternalIdHash, isCardFingerprint, sha256, toLetterHex,
} from './cardDedupe.js';
import { containsCardData } from './cardNumbers.js';
import { containsLongDigitRun } from './cardText.js';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));
const letters = (hexText: string) => hexText.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

// Synthetic rows. Every stored key depends on these vectors: if one changes,
// existing imports stop deduping, so bump CARD_DEDUPE_VERSION instead.
const coffee = { transactionDate: '2026-10-01', amountMinor: 1250, description: 'BLUE BOTTLE COFFEE' };
const refund = { transactionDate: '2026-10-03', amountMinor: -4599, description: 'AMAZON MKTP US*AB12CD34E ***1234' };
const VECTORS = {
  amexReference: 'xid1:mcmjgdhekkpjnilofgnbagoolmjnnagagfcleagnlkalgffkpglejenjimbbmejp',
  fitid: 'xid1:egkchegjemallchngpkhmaocgdbglafpkajllhcdiajpopoooleihhpahapiekdp',
  coffee0: 'cfp1:jpobcocddojijibgkdmghefpemmdndjakjepadndpeiimpllbaeimabikejihhbd',
  coffee1: 'cfp1:kkikkklnaabnbmejljfokoapngdglmdhnnopiandmkmlhbcdiagijcolmabpijpg',
  refund0: 'cfp1:jmnnbjfnliackgchcdbooogbhholaaljaebkakdbhmanobilphkcfbhhaaeigdoa',
};

describe('sha256', () => {
  it('matches the FIPS 180-2 examples', () => {
    assert.equal(hex(sha256(bytes('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(hex(sha256(new Uint8Array())), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(
      hex(sha256(bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    assert.equal(
      hex(sha256(new Uint8Array(1_000_000).fill(0x61))),
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('matches node:crypto across padding and block boundaries', () => {
    for (let length = 0; length <= 300; length += 1) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 31 + length * 7) & 0xff);
      assert.equal(hex(sha256(data)), createHash('sha256').update(data).digest('hex'), `length ${length}`);
    }
  });

  it('writes digests as letter hex', () => {
    assert.equal(toLetterHex(Uint8Array.from([0x00, 0x09, 0xa0, 0xff])), 'aaajkapp');
    assert.equal(toLetterHex(sha256(bytes('abc'))), letters('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
  });
});

describe('card external id hash', () => {
  it('is fixed, versioned and digit-free', () => {
    assert.equal(CARD_DEDUPE_VERSION, 1);
    assert.equal(cardExternalIdHash('320252940123456789'), VECTORS.amexReference);
    assert.equal(cardExternalIdHash('FITID20261001.0001'), VECTORS.fitid);
    assert.match(VECTORS.amexReference, /^xid1:[a-p]{64}$/);
    assert.equal(isCardExternalIdHash(VECTORS.fitid), true);
    assert.equal(isCardFingerprint(VECTORS.fitid), false);
  });

  it('ignores surrounding ASCII whitespace but is otherwise exact', () => {
    assert.equal(cardExternalIdHash(' \t320252940123456789\r\n'), VECTORS.amexReference);
    assert.notEqual(cardExternalIdHash('fitid20261001.0001'), VECTORS.fitid);
    assert.notEqual(cardExternalIdHash('320252940123456789 1'), VECTORS.amexReference);
  });

  it('hashes references without running card detection on them', () => {
    // A synthetic numeric reference that happens to pass Luhn with a Visa prefix.
    const reference = '4000056655665556';
    assert.equal(containsCardData(reference), true);
    const key = cardExternalIdHash(reference);
    assert.equal(isCardExternalIdHash(key), true);
    assert.equal(containsCardData(key) || containsLongDigitRun(key), false);
  });

  it('rejects empty, oversized and control-character references without echoing them', () => {
    for (const bad of ['', ' \r\n', 'R'.repeat(256), 'REF\u00001234', 'REF\n1234']) {
      assert.throws(() => cardExternalIdHash(bad), (error: Error) => !error.message.includes('REF'));
    }
    assert.throws(() => cardExternalIdHash(42 as unknown as string), /must be a string/);
    assert.match(cardExternalIdHash('R'.repeat(255)), /^xid1:/);
  });
});

describe('card transaction fingerprint', () => {
  it('is fixed, versioned and digit-free', () => {
    assert.equal(cardTransactionFingerprint(coffee, 0), VECTORS.coffee0);
    assert.equal(cardTransactionFingerprint(coffee, 1), VECTORS.coffee1);
    assert.equal(cardTransactionFingerprint(refund, 0), VECTORS.refund0);
    assert.match(VECTORS.coffee0, /^cfp1:[a-p]{64}$/);
    assert.equal(isCardFingerprint(VECTORS.coffee0), true);
    assert.equal(isCardExternalIdHash(VECTORS.coffee0), false);
  });

  it('compares descriptions after NFKC, whitespace collapsing and upper-casing', () => {
    for (const description of ['  blue  bottle\tcoffee ', 'Blue Bottle Coffee', 'ＢＬＵＥ ＢＯＴＴＬＥ ＣＯＦＦＥＥ', 'BLUE\u00a0BOTTLE COFFEE']) {
      assert.equal(cardTransactionFingerprint({ ...coffee, description }, 0), VECTORS.coffee0, JSON.stringify(description));
    }
    assert.equal(canonicalCardDescription(' Café\u3000 au  lait '), 'CAFÉ AU LAIT');
  });

  it('gives normalized and unnormalized descriptions the same key', () => {
    const ascii = cardTransactionFingerprint({ ...refund, description: 'ORDER 12345 BLUE BOTTLE' }, 0);
    for (const description of ['ORDER \u0661\u0662\u0663\u0664\u0665 BLUE BOTTLE', 'ORDER １２３４５ BLUE\u200b BOTTLE', 'ORDER 12345 BLUE BOT\u2063TLE']) {
      assert.equal(cardTransactionFingerprint({ ...refund, description }, 0), ascii, JSON.stringify(description));
    }
  });

  it('changes with each field and treats -0 as 0', () => {
    const keys = new Set([
      VECTORS.coffee0,
      cardTransactionFingerprint({ ...coffee, transactionDate: '2026-10-02' }, 0),
      cardTransactionFingerprint({ ...coffee, amountMinor: -1250 }, 0),
      cardTransactionFingerprint({ ...coffee, amountMinor: 1251 }, 0),
      cardTransactionFingerprint({ ...coffee, description: 'BLUE BOTTLE COFFEE #2' }, 0),
      cardTransactionFingerprint(coffee, 2),
    ]);
    assert.equal(keys.size, 6);
    assert.equal(
      cardTransactionFingerprint({ ...coffee, amountMinor: -0 }, 0),
      cardTransactionFingerprint({ ...coffee, amountMinor: 0 }, 0),
    );
  });

  it('hashes non-ASCII descriptions as UTF-8', () => {
    const description = 'Café ☕ 东京 𝄞';
    const expected = letters(createHash('sha256').update(JSON.stringify([
      'holdr.card-fingerprint', 1, coffee.transactionDate, coffee.amountMinor, canonicalCardDescription(description), 0,
    ]), 'utf8').digest('hex'));
    assert.equal(cardTransactionFingerprint({ ...coffee, description }, 0), `cfp1:${expected}`);
  });

  it('rejects malformed input', () => {
    const cases: Array<[Partial<typeof coffee>, number, RegExp]> = [
      [{ transactionDate: '2026-02-30' }, 0, /transactionDate/],
      [{ transactionDate: '2026-1-1' }, 0, /transactionDate/],
      [{ amountMinor: 12.5 }, 0, /amountMinor/],
      [{ amountMinor: 2 ** 53 }, 0, /amountMinor/],
      [{ amountMinor: Number.NaN }, 0, /amountMinor/],
      [{}, -1, /occurrence/],
      [{}, 0.5, /occurrence/],
      [{ description: ' \t ' }, 0, /description/],
    ];
    for (const [patch, occurrence, expected] of cases) {
      assert.throws(() => cardTransactionFingerprint({ ...coffee, ...patch }, occurrence), expected);
    }
  });
});

describe('card dedupe keys for an export', () => {
  it('keeps two identical purchases without ids apart, and reproduces their keys on re-import', () => {
    const exportRows = [coffee, { ...coffee }];
    const keys = assignCardDedupeKeys(exportRows);
    assert.deepEqual(keys, [{ fingerprint: VECTORS.coffee0 }, { fingerprint: VECTORS.coffee1 }]);
    assert.deepEqual(assignCardDedupeKeys(exportRows), keys);
  });

  it('counts occurrences only among rows without a stable id', () => {
    const withTwin = assignCardDedupeKeys([{ ...coffee, externalIdHash: VECTORS.fitid }, coffee]);
    const withoutTwin = assignCardDedupeKeys([coffee]);
    assert.deepEqual(withTwin, [{ externalIdHash: VECTORS.fitid }, { fingerprint: VECTORS.coffee0 }]);
    assert.deepEqual(withoutTwin, [{ fingerprint: VECTORS.coffee0 }]);
  });

  it('groups occurrences by date, amount and canonical description', () => {
    const keys = assignCardDedupeKeys([coffee, refund, { ...coffee, description: 'blue bottle coffee' }, { ...coffee, externalIdHash: null }]);
    assert.deepEqual(keys, [
      { fingerprint: VECTORS.coffee0 },
      { fingerprint: VECTORS.refund0 },
      { fingerprint: VECTORS.coffee1 },
      { fingerprint: cardTransactionFingerprint(coffee, 2) },
    ]);
  });

  it('accepts only current-version external id hashes and reports rows by index', () => {
    const hexDigest = createHash('sha256').update('320252940123456789').digest('hex');
    const bad = [hexDigest, '320252940123456789', `xid2:${'a'.repeat(64)}`, VECTORS.amexReference.toUpperCase(), VECTORS.coffee0];
    for (const externalIdHash of bad) {
      assert.throws(
        () => assignCardDedupeKeys([coffee, { ...coffee, externalIdHash }]),
        (error: Error) => error.message.startsWith('rows[1].externalIdHash') && !error.message.includes('3202'),
      );
    }
    assert.throws(() => assignCardDedupeKeys([coffee, { ...coffee, transactionDate: 'soon' }]), /^Error: rows\[1\]: .*transactionDate/);
  });

  it('never produces keys that trip the long-digit guard or card detection, unlike hex digests', () => {
    let hexWithLongRuns = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const reference = `REF-${i}`;
      const keys = [cardExternalIdHash(reference), cardTransactionFingerprint({ ...coffee, description: reference }, i)];
      for (const key of keys) {
        assert.equal(/\d\d/.test(key), false, key);
        assert.equal(containsLongDigitRun(key) || containsCardData(key), false, key);
      }
      if (/\d{13}/.test(createHash('sha256').update(reference).digest('hex'))) hexWithLongRuns += 1;
    }
    assert.ok(hexWithLongRuns > 20, `hex digests with 13-digit runs: ${hexWithLongRuns}`);
  });
});
