import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { CARD_SYNC_BLOCKS, CARD_SYNC_DESIGN_SOURCE, CARD_SYNC_QUERIES } from './cardSyncSchemaSql.js';

// cardSyncSchemaSql.ts is generated from the approved design (revision 8) by
// scripts/card-sync-extract-sql.mjs; `node scripts/card-sync-extract-sql.mjs
// <design.md> --check` proves the file is exactly what the design yields.
// These pins fail on any hand edit. After regenerating from a newer approved
// revision, re-pin them and review the diff. The blocks pin covers the public
// release's one reviewed edit: the placeholder owner aliases 'alex' and 'casey'
// (see the header of cardSyncSchemaSql.ts).

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('card-sync schema SQL, as lifted from the approved design', () => {
  it('comes from revision 8 of the design, by its hash', () => {
    expect(CARD_SYNC_DESIGN_SOURCE).toEqual({
      revision: 8, sha256: '0863ffadf12504f722f80a19c43a74f8362c373d358f45f96d191d9a540caccd',
    });
  });

  it('holds every design section the migration runs, each starting at its own fence, and nothing else', () => {
    expect(Object.keys(CARD_SYNC_BLOCKS)).toEqual(['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.9', '2.10', '2.11',
      '2.12', '2.13', '2.14', '2.15', '2.16', '2.17', '2.18', '2.19', '3.4a', '3.4b', '3.4c']);
    for (const [section, sql] of Object.entries(CARD_SYNC_BLOCKS)) {
      expect(sql.startsWith(`-- @block ${section}\n`), section).toBe(true);
      expect([...sql.matchAll(/^-- @block (\S+)$/gm)].every((m) => m[1] === section), section).toBe(true);
    }
  });

  it('holds the 22 named statements of §5.3.1', () => {
    expect(Object.keys(CARD_SYNC_QUERIES)).toEqual([
      'adjustment-reversible', 'auto-sync-step', 'revoke-grants-of-device', 'revoke-grants-of-binding', 'revoke-grant',
      'revoke-all-grants', 'withdraw-consent-of-binding', 'quarantine-sets-of-device', 'cancel-plans-of-device',
      'close-pairing-of-device', 'set-level-item', 'set-items-page', 'values-at-revision', 'plan-effects-page',
      'transaction-history-page', 'revertible-event', 'transaction-aliases-page', 'transaction-merged-page', 'touch-set',
      'audit-cutoff-refresh', 'audit-delete-chunk', 'audit-cutoff-ahead',
    ]);
    for (const [name, sql] of Object.entries(CARD_SYNC_QUERIES)) expect(sql, name).not.toMatch(/-- @/);
  });

  it('is byte for byte the text that was approved', () => {
    expect({
      blocks: sha256(JSON.stringify(CARD_SYNC_BLOCKS)),
      queries: sha256(JSON.stringify(CARD_SYNC_QUERIES)),
    }).toEqual({
      blocks: '9c86d009fd5e07eff408a6e8b3b183bedbb8736116b1560e6745a5792db2ad96',
      queries: '2d1debf9838b9f80490fb4eb7dc864a8006f0928d4d60d8e4376294ec9ca9282',
    });
  });
});
