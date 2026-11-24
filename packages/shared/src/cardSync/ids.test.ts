import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { containsCardData } from '../cardNumbers.js';
import { containsCardSecret } from '../cardSecrets.js';
import { toLetterHex } from '../cardDedupe.js';
import {
  CARD_SYNC_ID_BYTES,
  CARD_SYNC_ID_PREFIXES,
  formatCardSyncId,
  formatCardSyncPairingCode,
  isCardSyncDeviceToken,
  isCardSyncId,
  isCardSyncPairingCode,
  parseCardSyncPairingCode,
  type CardSyncIdKind,
} from './ids.js';
import { snapshotStrictJson } from './strictJson.js';
import { CARD_SYNC_V2_KNOWN_KEYS } from './wireV2.js';

const KINDS = Object.keys(CARD_SYNC_ID_PREFIXES) as CardSyncIdKind[];

function randomBytes(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(CARD_SYNC_ID_BYTES));
}

describe('card sync id grammar', () => {
  it('is a fixed prefix, an underscore and 32 letters a-p', () => {
    for (const kind of KINDS) {
      const id = formatCardSyncId(kind, randomBytes());
      assert.match(id, new RegExp(`^${CARD_SYNC_ID_PREFIXES[kind]}_[a-p]{32}$`));
      assert.equal(isCardSyncId(kind, id), true);
    }
    assert.equal(formatCardSyncId('binding', new Uint8Array(16)), `bnd_${'a'.repeat(32)}`);
    assert.equal(formatCardSyncId('capture', new Uint8Array(16).fill(255)), `cpt_${'p'.repeat(32)}`);
  });

  it('uses a distinct prefix per kind and never accepts one kind for another', () => {
    assert.equal(new Set(Object.values(CARD_SYNC_ID_PREFIXES)).size, KINDS.length);
    for (const kind of KINDS) {
      const id = formatCardSyncId(kind, randomBytes());
      for (const other of KINDS) if (other !== kind) assert.equal(isCardSyncId(other, id), false);
    }
  });

  it('refuses anything else', () => {
    const good = `scp_${'abcdefghijklmnop'.repeat(2)}`;
    assert.equal(isCardSyncId('cardScope', good), true);
    for (const bad of [
      good.toUpperCase(), `scp_${'a'.repeat(31)}`, `scp_${'a'.repeat(33)}`, `scp-${'a'.repeat(32)}`, `scp_${'q'.repeat(32)}`,
      `scp_${'1'.repeat(32)}`, ` ${good}`, `${good}\n`, `scp_${'a'.repeat(31)}é`, '', null, 42, { toString: () => good },
    ]) {
      assert.equal(isCardSyncId('cardScope', bad), false, String(bad));
    }
    assert.equal(isCardSyncId('toString' as CardSyncIdKind, good), false);
  });

  it('formats only from exactly 16 bytes of a known kind', () => {
    assert.throws(() => formatCardSyncId('binding', new Uint8Array(15)));
    assert.throws(() => formatCardSyncId('binding', new Uint8Array(17)));
    assert.throws(() => formatCardSyncId('binding', [1, 2] as unknown as Uint8Array));
    assert.throws(() => formatCardSyncId('nope' as CardSyncIdKind, new Uint8Array(16)));
  });

  it('can never look like card data or a card secret, alone or next to any schema key', () => {
    for (let round = 0; round < 2_000; round += 1) {
      const kind = KINDS[round % KINDS.length];
      const id = formatCardSyncId(kind, randomBytes());
      assert.equal(containsCardData(id), false);
      assert.equal(containsCardSecret(id), false);
      if (round % 50 === 0) {
        for (const key of CARD_SYNC_V2_KNOWN_KEYS) assert.equal(containsCardSecret(`${key}: ${id}`), false);
      }
      assert.ok(snapshotStrictJson({ [kind]: id }).ok);
    }
  });

  it('includes the control envelope ids (E2)', () => {
    assert.deepEqual(
      Object.fromEntries(['run', 'clientRun', 'observationSet', 'preview', 'device'].map((kind) => [kind, CARD_SYNC_ID_PREFIXES[kind as CardSyncIdKind]])),
      { run: 'run', clientRun: 'crn', observationSet: 'obs', preview: 'prv', device: 'dev' },
    );
  });
});

describe('device token and pairing code forms (E2)', () => {
  const token = `hdv1_${toLetterHex(globalThis.crypto.getRandomValues(new Uint8Array(32)))}`;

  it('accept only hdv1_ and 64 letters a-p for a device token', () => {
    assert.equal(isCardSyncDeviceToken(token), true);
    for (const bad of [token.slice(0, -1), `${token}a`, token.toUpperCase(), token.replace('hdv1_', 'hdv2_'), token.replace(/.$/, '1'), ` ${token}`, null, 1]) {
      assert.equal(isCardSyncDeviceToken(bad), false, String(bad).slice(0, 8));
    }
    assert.equal(containsCardData(token), false);
    assert.equal(containsCardSecret(token), false);
  });

  it('show a pairing code as 8 groups of 4 and read it back however it is typed', () => {
    const code = toLetterHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    assert.equal(isCardSyncPairingCode(code), true);
    const shown = formatCardSyncPairingCode(code)!;
    assert.match(shown, /^[a-p]{4}(?: [a-p]{4}){7}$/);
    for (const typed of [shown, shown.toUpperCase(), shown.replace(/ /g, '-'), ` ${shown} `, code]) assert.equal(parseCardSyncPairingCode(typed), code);
    for (const bad of [code.slice(1), `${code}a`, code.replace(/^./, 'q'), shown.replace(/ /g, '  '), `${shown.slice(0, 4)}_${shown.slice(5)}`, 'x'.repeat(65)]) {
      assert.equal(parseCardSyncPairingCode(bad), null);
    }
    assert.equal(formatCardSyncPairingCode(code.toUpperCase()), null);
    assert.equal(containsCardData(shown), false);
  });
});
