import { describe, expect, it } from 'vitest';

import { SqliteStateRepo } from '../sqliteStateRepo.js';
import {
  installRetailSchema,
  proposeRetailBindings,
  retailInventoryDigest,
  retailLetters,
  serializeRetailBindingProposal,
} from './index.js';
import { RETAIL_TEST_GO, RETAIL_TEST_NOW, importPayload, rows } from '../../testing/retailDb.js';
import { onlineLine, onlineOrder, syntheticRetailPayload, warehouseLine, warehouseReceipt } from '../../testing/retailPayloads.js';

// Bindings, propose only (plan v5 §7, Q-B1), on an in-memory Holdr database made by this build. Synthetic values only.

describe('retail bindings: propose only (§7, Q-B1)', () => {
  it('lists every card and card-refund identity with each card account of its last four, and nothing for any other tender', () => {
    const repo = new SqliteStateRepo({ file: ':memory:', now: () => new Date(RETAIL_TEST_NOW) });
    try {
      const target = repo.internalGetDb();
      installRetailSchema(target, { now: RETAIL_TEST_NOW, authority: RETAIL_TEST_GO });
      const first = repo.createCardAccount({ issuer: 'citi', owner: 'alex', last4: '0007', currency: 'USD' });
      repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '0007', currency: 'USD' });
      repo.createCardAccount({ issuer: 'amex', owner: 'joint', last4: '0011', currency: 'USD' });
      const refund = warehouseReceipt(2, { lines: [warehouseLine(0, -1_000, { quantity: -1, unitPriceMinor: 1_000 })], taxMinor: -80,
        tenders: [{ kind: 'card-refund', network: 'visa', last4: '0042', amountMinor: -1_080 }] });
      const mixed = warehouseReceipt(3, { tenders: [{ kind: 'shop-card', network: 'unknown', last4: null, amountMinor: 500 },
        { kind: 'reward-certificate', network: 'unknown', last4: null, amountMinor: 300 }, { kind: 'debit', network: 'unknown', last4: null, amountMinor: 200 },
        { kind: 'cash', network: 'unknown', last4: null, amountMinor: 80 }] });
      importPayload(target, syntheticRetailPayload({ receipts: [warehouseReceipt(1), refund, mixed, onlineOrder(4, { card: '0011', lines: [onlineLine(4, 0, 2_000)] })] }));
      const audits = rows(target, 'SELECT count(*) FROM retail_audit');
      const { proposal, summary } = proposeRetailBindings(target, 'f'.repeat(64));
      expect(summary).toEqual({ identities: 3, oneCandidate: 1, severalCandidates: 1, noCandidate: 1 });
      expect(proposal.identities.map((identity) => [identity.network, identity.last4, identity.candidates.map((candidate) => candidate.issuer).sort()]))
        .toEqual([['visa', '0007', ['chase', 'citi']], ['visa', '0011', ['amex']], ['visa', '0042', []]]);
      expect(proposal).toMatchObject({ format: 'holdr.retail-binding-proposal', version: 1, databaseRef: 'f'.repeat(64), pairs: [] });
      const accounts = target.prepare('SELECT id, issuer, owner, last4, status FROM card_accounts ORDER BY id').all() as Parameters<typeof retailInventoryDigest>[0];
      expect(proposal.inventoryDigest).toBe(retailInventoryDigest(accounts));
      const text = serializeRetailBindingProposal(proposal);
      expect(JSON.parse(text)).toEqual(proposal);
      expect(text.endsWith('}\n')).toBe(true);
      expect(Object.keys(JSON.parse(text))).toEqual([...Object.keys(JSON.parse(text))].sort());
      // Read-only: no row written; and any change to a card account changes the inventory digest.
      expect(rows(target, 'SELECT count(*) FROM retail_audit')).toBe(audits);
      repo.updateCardAccount(first.id, { status: 'closed' });
      expect(proposeRetailBindings(target, 'f'.repeat(64)).proposal.inventoryDigest).not.toBe(proposal.inventoryDigest);
      expect(retailLetters(proposal.inventoryDigest)).toMatch(/^[a-p]{64}$/);
    } finally {
      repo.close();
    }
  });
});
