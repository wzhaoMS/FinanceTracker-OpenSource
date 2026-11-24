import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CanonicalJsonError, canonicalJson, canonicalJsonByteLength, jsonStringByteLength, utf8ByteLength, type JsonValue } from './canonical.js';
import { snapshotStrictJson } from './strictJson.js';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ALPHABET = ['a', 'Z', '0', ' ', '"', '\\', '/', '\n', '\t', '\u0000', '\u001f', '\u007f', 'é', '€', '\u2028', '😀', '\ud800', '\udc00', '\uffff'];

function randomText(random: () => number, length: number): string {
  let text = '';
  for (let index = 0; index < length; index += 1) text += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return text;
}

describe('canonicalJson', () => {
  it('writes the RFC 8785 form: sorted keys by UTF-16 units, no whitespace, JSON.stringify escapes', () => {
    const value = { b: 1, a: [true, null, 'x'], é: '\u0001\n"\\/', '\ud83d\ude00': 2, A: -5, '\ufb01': 3, '': 0 };
    assert.equal(
      canonicalJson(value),
      '{"":0,"A":-5,"a":[true,null,"x"],"b":1,"é":"\\u0001\\n\\"\\\\/","\ud83d\ude00":2,"\ufb01":3}',
    );
    // An astral key sorts by its surrogates (0xD83D) before U+FB01, unlike code point order.
    assert.ok(canonicalJson(value).indexOf('\ud83d') < canonicalJson(value).indexOf('\ufb01'));
  });

  it('does not depend on the order keys were added', () => {
    const one = { rows: [{ b: 2, a: 1 }], format: 'x', version: 2 };
    const two = { version: 2, format: 'x', rows: [{ a: 1, b: 2 }] };
    assert.equal(canonicalJson(one), canonicalJson(two));
  });

  it('writes numbers in shortest round-trip form', () => {
    assert.equal(canonicalJson([0, -1, 9_999_999_999, 1e21, 0.5, 1e-7]), '[0,-1,9999999999,1e+21,0.5,1e-7]');
  });

  it('round-trips: parsing the text gives the value, and canonicalizing again gives the same text', () => {
    const random = seeded(7);
    for (let round = 0; round < 200; round += 1) {
      const value: JsonValue = {
        [randomText(random, 3).replace(/[\ud800-\udfff]/g, 'x')]: randomText(random, 20).replace(/[\ud800-\udfff]/g, 'y'),
        list: [Math.floor(random() * 1e6) - 5e5, true, null, { nested: randomText(random, 5).replace(/[\ud800-\udfff]/g, 'z') }],
      };
      const text = canonicalJson(value);
      assert.deepEqual(JSON.parse(text), value);
      assert.equal(canonicalJson(JSON.parse(text)), text);
    }
  });

  it('refuses values outside strict JSON without naming them', () => {
    const accessor = {};
    Object.defineProperty(accessor, 'x', { get: () => 1, enumerable: true });
    const hidden = {};
    Object.defineProperty(hidden, 'x', { value: 1, enumerable: false });
    // eslint-disable-next-line no-sparse-arrays
    const invalid: unknown[] = [undefined, () => 1, Symbol('s'), 1n, Number.NaN, Number.POSITIVE_INFINITY, -0, 'ZQX\ud800', { ['ZQX\udc00']: 1 },
      new Date(0), accessor, hidden, [1, , 2], { [Symbol('s')]: 1 }];
    let deep: unknown = 1;
    for (let level = 0; level < 70; level += 1) deep = [deep];
    invalid.push(deep);
    for (const value of invalid) {
      assert.throws(() => canonicalJson(value as JsonValue), (error: unknown) => {
        assert.ok(error instanceof CanonicalJsonError);
        assert.ok(!(error as Error).message.includes('ZQX'));
        return true;
      });
    }
  });
});

describe('UTF-8 lengths', () => {
  it('match Buffer and TextEncoder, unpaired surrogates included', () => {
    const random = seeded(11);
    const encoder = new TextEncoder();
    for (let round = 0; round < 500; round += 1) {
      const text = randomText(random, Math.floor(random() * 40));
      assert.equal(utf8ByteLength(text), encoder.encode(text).length);
      assert.equal(utf8ByteLength(text), Buffer.byteLength(text, 'utf8'));
      assert.equal(jsonStringByteLength(text), Buffer.byteLength(JSON.stringify(text), 'utf8'));
    }
  });

  it('give the same budget figure as the strict snapshot', () => {
    const random = seeded(13);
    for (let round = 0; round < 100; round += 1) {
      const value = { text: randomText(random, 30).replace(/[\ud800-\udfff]/g, ''), n: Math.floor(random() * 1e9), list: [true, null] };
      const snapshot = snapshotStrictJson(value);
      assert.ok(snapshot.ok);
      assert.equal(snapshot.byteLength, canonicalJsonByteLength(snapshot.value));
    }
  });
});
