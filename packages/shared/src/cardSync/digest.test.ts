import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { sha256 } from '../cardDedupe.js';
import { containsCardData } from '../cardNumbers.js';
import { containsCardSecret } from '../cardSecrets.js';
import { canonicalJson, CanonicalJsonError, type JsonValue } from './canonical.js';
import {
  CARD_SYNC_DIGEST_PREFIXES,
  cardSyncDigest,
  cardSyncPayloadDigest,
  cardSyncPlanDigest,
  encodeCardSyncUtf8,
  isCardSyncDigest,
  type CardSyncDigestKind,
} from './digest.js';
import { snapshotStrictJson } from './strictJson.js';
import { CARD_SYNC_V2_FIXTURE_BUILDERS } from './__fixtures__/drafts.js';

/** Letter hex (a–p) back to ordinary hex, for comparing with published vectors. */
function hex(letters: string): string {
  return letters.replace(/[a-p]/g, (letter) => (letter.charCodeAt(0) - 97).toString(16));
}

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 4_294_967_296;
  };
}

/** Random strings over ASCII, the BMP, astral planes and unpaired surrogates. */
function randomText(random: () => number): string {
  let text = '';
  for (let count = Math.floor(random() * 40); count > 0; count -= 1) {
    const pick = random();
    if (pick < 0.4) text += String.fromCharCode(32 + Math.floor(random() * 95));
    else if (pick < 0.7) text += String.fromCharCode(0x80 + Math.floor(random() * 0xd780));
    else if (pick < 0.85) text += String.fromCodePoint(0x10000 + Math.floor(random() * 0xfffff));
    else if (pick < 0.95) text += String.fromCharCode(0xd800 + Math.floor(random() * 0x800));
    else text += String.fromCharCode(0xe000 + Math.floor(random() * 0x2000));
  }
  return text;
}

describe('encodeCardSyncUtf8', () => {
  it('writes the bytes TextEncoder and Buffer write, unpaired surrogates as U+FFFD', () => {
    const random = lcg(31);
    const encoder = new TextEncoder();
    for (let round = 0; round < 5_000; round += 1) {
      const text = randomText(random);
      const bytes = encodeCardSyncUtf8(text);
      assert.deepEqual(bytes, encoder.encode(text));
      assert.deepEqual(Buffer.from(bytes), Buffer.from(text, 'utf8'));
    }
    assert.deepEqual([...encodeCardSyncUtf8('a\ud800')], [0x61, 0xef, 0xbf, 0xbd]);
    assert.deepEqual([...encodeCardSyncUtf8('\udc00\ud83d\ude00')], [0xef, 0xbf, 0xbd, 0xf0, 0x9f, 0x98, 0x80]);
    assert.deepEqual([...encodeCardSyncUtf8('\u00e9\u20ac')], [0xc3, 0xa9, 0xe2, 0x82, 0xac]);
  });
});

describe('SHA-256 over the UTF-8 encoder', () => {
  it('matches the FIPS 180-4 / NIST test vectors', () => {
    const vectors: Array<[string, string]> = [
      ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
      [
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
        'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
      ],
      ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
    ];
    for (const [message, expected] of vectors) {
      assert.equal(Buffer.from(sha256(encodeCardSyncUtf8(message))).toString('hex'), expected, `${message.length} bytes`);
    }
  });

  it('agrees with node:crypto on random text, at every padding boundary', () => {
    const random = lcg(97);
    for (let round = 0; round < 2_000; round += 1) {
      const text = round < 200 ? 'x'.repeat(round) : randomText(random);
      const expected = createHash('sha256').update(text, 'utf8').digest('hex');
      assert.equal(Buffer.from(sha256(encodeCardSyncUtf8(text))).toString('hex'), expected);
    }
  });
});

describe('card sync digests', () => {
  const kinds = Object.keys(CARD_SYNC_DIGEST_PREFIXES) as CardSyncDigestKind[];

  it('are a registered prefix, a colon and the letter hex of SHA-256 over the canonical bytes', () => {
    for (const build of Object.values(CARD_SYNC_V2_FIXTURE_BUILDERS)) {
      const payload = build() as unknown as JsonValue;
      const digest = cardSyncPayloadDigest(payload);
      assert.match(digest, /^pd1:[a-p]{64}$/);
      assert.equal(hex(digest.slice(4)), createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex'));
      assert.equal(isCardSyncDigest('payload', digest), true);
      assert.equal(isCardSyncDigest('plan', digest), false);
    }
    const plan = { insert: 2, update: 1, unchanged: 0, rows: ['a', 'b'] };
    assert.equal(cardSyncPlanDigest(plan), `pl1:${cardSyncDigest('plan', plan).slice(4)}`);
    assert.match(cardSyncPlanDigest(plan), /^pl1:[a-p]{64}$/);
  });

  it('depend on content, not key order, and change with any byte', () => {
    const payload = CARD_SYNC_V2_FIXTURE_BUILDERS['chase.v2.json']() as unknown as Record<string, JsonValue>;
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    assert.equal(cardSyncPayloadDigest(reordered), cardSyncPayloadDigest(payload));
    const changed = JSON.parse(JSON.stringify(payload));
    changed.rows[0].amountMinor += 1;
    assert.notEqual(cardSyncPayloadDigest(changed), cardSyncPayloadDigest(payload));
    // The kind is the prefix only: the same value has the same letters under either kind.
    assert.equal(cardSyncDigest('plan', payload).slice(4), cardSyncDigest('payload', payload).slice(4));
  });

  it('refuse values outside strict JSON and unknown kinds, naming no value', () => {
    for (const bad of [Number.NaN, -0, { a: undefined }, 'x\ud800', [1, () => 2]]) {
      assert.throws(() => cardSyncPayloadDigest(bad as unknown as JsonValue), (error: unknown) => error instanceof CanonicalJsonError && !String((error as Error).message).includes('ud800'));
    }
    assert.throws(() => cardSyncDigest('toString' as CardSyncDigestKind, {}));
    for (const bad of ['pd1:' + 'a'.repeat(63), 'pd1:' + 'q'.repeat(64), 'PD1:' + 'a'.repeat(64), 'pd1_' + 'a'.repeat(64), null, 7]) {
      for (const kind of kinds) assert.equal(isCardSyncDigest(kind, bad), false);
    }
  });

  it('never look like card data or a card secret, and pass the strict snapshot as values', () => {
    const random = lcg(5);
    for (let round = 0; round < 20_000; round += 1) {
      const value = { n: Math.floor(random() * 1e9), t: randomText(random).replace(/[\ud800-\udfff]/g, '') };
      const digest = cardSyncDigest(kinds[round % kinds.length], value);
      assert.equal(/[0-9]/.test(digest.slice(4)), false);
      assert.equal(containsCardData(digest), false);
      assert.equal(containsCardSecret(digest), false);
      if (round % 10 === 0) assert.ok(snapshotStrictJson({ payloadDigest: digest, planDigest: digest }).ok);
    }
  });

  it('digest a 2 MiB payload quickly', () => {
    const big = { rows: Array.from({ length: 2_000 }, (_, index) => ({ description: 'SYNTHETIC MERCHANT '.repeat(50), index })) };
    const started = performance.now();
    const digest = cardSyncPayloadDigest(big);
    assert.ok(performance.now() - started < 2_000);
    assert.equal(hex(digest.slice(4)), createHash('sha256').update(canonicalJson(big), 'utf8').digest('hex'));
  });
});
