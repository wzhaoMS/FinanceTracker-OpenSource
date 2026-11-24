import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

import {
  METALS_IDENTITY_FORMAT,
  checkMetalsIdentityPin,
  hexOfLetters,
  lettersOfHex,
  metalsIdentityDigest,
  metalsIdentityText,
  newMetalsIdentityKeyText,
  parseMetalsFolderRegistry,
  parseMetalsIdentityKey,
  serializeMetalsFolderRegistry,
  type MetalsIdentity,
} from './index.js';

// Synthetic only: an invented key, folders and membership last 4s.

const KEY = Buffer.alloc(32, 0x5a);
const OTHER_KEY = Buffer.alloc(32, 0x5b);
const WALMART: MetalsIdentity = { source: 'walmart', folder: 'walmart', identityLast4: null };
const COSTCO: MetalsIdentity = { source: 'costco', folder: 'costco-2', identityLast4: '1111' };
const MALFORMED = { code: 'metals-identity-input-unusable', details: { reason: 'malformed' } };

/** A refusal's code and details, or null when nothing was thrown. */
function refusalOf(fn: () => unknown): { code: unknown; details: unknown } | null {
  try {
    fn();
  } catch (error) {
    const refusal = error as { code?: unknown; details?: unknown };
    return { code: refusal.code, details: refusal.details };
  }
  return null;
}

describe('metals identity pin (corrections design r6, section 2.8)', () => {
  it('digests the canonical identity text with HMAC-SHA256 under the key, as 64 letters a–p', () => {
    expect(metalsIdentityText(COSTCO)).toBe(`${METALS_IDENTITY_FORMAT}\ncostco\ncostco-2\n1111\n`);
    expect(metalsIdentityText(WALMART)).toBe('holdr.metals-identity v1\nwalmart\nwalmart\n\n');
    const expected = lettersOfHex(createHmac('sha256', KEY).update('holdr.metals-identity v1\ncostco\ncostco-2\n1111\n', 'utf8').digest('hex'));
    expect(metalsIdentityDigest(KEY, COSTCO)).toBe(expected);
    expect(expected).toMatch(/^[a-p]{64}$/);
    // Keyed, and over every field: another key, last 4, folder or source gives another digest.
    expect(metalsIdentityDigest(OTHER_KEY, COSTCO)).not.toBe(expected);
    expect(metalsIdentityDigest(KEY, { ...COSTCO, identityLast4: '2222' })).not.toBe(expected);
    expect(metalsIdentityDigest(KEY, { ...COSTCO, folder: 'costco' })).not.toBe(expected);
    expect(metalsIdentityDigest(KEY, WALMART)).not.toBe(metalsIdentityDigest(KEY, { ...WALMART, folder: 'walmart-2' }));
    expect(refusalOf(() => metalsIdentityDigest(Buffer.alloc(31), COSTCO))).toEqual(MALFORMED);
  });

  it('makes a key file of 32 random bytes as 64 letters a–p and an LF, and reads back only that shape', () => {
    const text = newMetalsIdentityKeyText();
    expect(text).toMatch(/^[a-p]{64}\n$/);
    expect(newMetalsIdentityKeyText()).not.toBe(text);
    expect(parseMetalsIdentityKey(Buffer.from(text, 'latin1')).toString('hex')).toBe(hexOfLetters(text.slice(0, 64)));
    for (const bad of [text.slice(0, 64), `${text.slice(0, 63)}\n`, `${text}\n`, `${text.slice(0, 63)}q\n`, text.toUpperCase(), `${text.slice(0, 64)}\r\n`]) {
      expect(refusalOf(() => parseMetalsIdentityKey(Buffer.from(bad, 'latin1')))).toEqual(MALFORMED);
    }
  });

  it('reads a folder registry under the payload\'s own folder and last-4 rules, each source and folder once, and nothing else', () => {
    const text = serializeMetalsFolderRegistry({ folders: [WALMART, COSTCO] });
    expect(JSON.parse(text)).toEqual({ format: 'holdr.metals-folder-registry', version: 1, folders: [WALMART, COSTCO] });
    expect(parseMetalsFolderRegistry(Buffer.from(text, 'utf8')).folders).toEqual([WALMART, COSTCO]);
    const base = { format: 'holdr.metals-folder-registry', version: 1, folders: [WALMART] };
    for (const bad of [
      'not json', { ...base, format: 'holdr.metals-folders' }, { ...base, version: 2 }, { ...base, note: 'x' }, { ...base, folders: {} },
      { ...base, folders: [{ ...WALMART, note: 'x' }] }, { ...base, folders: [{ ...WALMART, source: 'ebay' }] },
      { ...base, folders: [{ ...WALMART, folder: 'costco' }] }, { ...base, folders: [{ ...WALMART, folder: 'walmart-0' }] },
      { ...base, folders: [{ ...WALMART, identityLast4: '1111' }] }, { ...base, folders: [{ ...COSTCO, identityLast4: null }] },
      { ...base, folders: [{ ...COSTCO, identityLast4: '111' }] }, { ...base, folders: [WALMART, WALMART] },
    ]) {
      expect(refusalOf(() => parseMetalsFolderRegistry(Buffer.from(typeof bad === 'string' ? bad : JSON.stringify(bad), 'utf8')))).toEqual(MALFORMED);
    }
    expect(refusalOf(() => parseMetalsFolderRegistry(Buffer.from([0x7b, 0xff, 0x7d])))).toEqual(MALFORMED);
  });

  it('admits an account-creating import only when the registry\'s entry and the payload\'s stated identity both give the pin', () => {
    const registry = { folders: [WALMART, COSTCO] };
    const pin = metalsIdentityDigest(KEY, COSTCO);
    expect(refusalOf(() => checkMetalsIdentityPin(pin, KEY, registry, COSTCO))).toBeNull();
    expect(refusalOf(() => checkMetalsIdentityPin(metalsIdentityDigest(KEY, WALMART), KEY, registry, WALMART))).toBeNull();
    const mismatch = { code: 'metals-identity-mismatch', details: {} };
    // The payload states another membership than the registry holds for its folder.
    expect(refusalOf(() => checkMetalsIdentityPin(pin, KEY, registry, { ...COSTCO, identityLast4: '2222' }))).toEqual(mismatch);
    // The registry holds another membership than the pin names, though the payload agrees with the pin.
    expect(refusalOf(() => checkMetalsIdentityPin(pin, KEY, { folders: [{ ...COSTCO, identityLast4: '2222' }] }, COSTCO))).toEqual(mismatch);
    // A pin made under another key.
    expect(refusalOf(() => checkMetalsIdentityPin(pin, OTHER_KEY, registry, COSTCO))).toEqual(mismatch);
    // A folder the registry doesn't list.
    expect(refusalOf(() => checkMetalsIdentityPin(pin, KEY, { folders: [WALMART] }, COSTCO))).toEqual({ code: 'metals-identity-unregistered', details: {} });
    // A pin of another shape.
    expect(refusalOf(() => checkMetalsIdentityPin(pin.toUpperCase(), KEY, registry, COSTCO))).toEqual({ code: 'metals-go-invalid', details: {} });
  });
});
