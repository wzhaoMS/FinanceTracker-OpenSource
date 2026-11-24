import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { matchAmazon, readLedger } from './matcher.js';
import { syntheticCards, syntheticRow, syntheticSubject, rootApproval } from './fixtures.testSupport.js';
import { proposeBindings, validateApproval, validateProposal } from './bindings.js';
import { opaque } from './policy.js';
import type { Binding } from './types.js';

const bindings: Binding[] = syntheticCards.map(c => ({ network: 'visa', last4: c.last4!, cardAccountId: c.id }));
const match = (s = syntheticSubject(), r = syntheticRow()) => matchAmazon([s], [r], bindings).results[0];

describe('Amazon ledger adapter live-row boundary', () => {
  const markers = ['dismissed_at', 'removed_at', 'merged_into_id'] as const;
  for (const marker of markers) {
    it(`excludes ${marker} rows from both matches and ambiguity even if their status says posted`, () => {
      // A permissive synthetic legacy table exercises each lifecycle marker independently of modern shape constraints.
      const db = new Database(':memory:');
      try {
        db.exec(`CREATE TABLE card_transactions (
          id TEXT PRIMARY KEY,card_account_id TEXT,transaction_date TEXT,status TEXT,kind TEXT,currency TEXT,
          amount_minor INTEGER,user_category TEXT,issuer_category TEXT,dismissed_at TEXT,removed_at TEXT,merged_into_id TEXT,description TEXT
        )`);
        const insert = db.prepare(`INSERT INTO card_transactions
          (id,card_account_id,transaction_date,status,kind,currency,amount_minor,${marker})
          VALUES(?,?,?,?,?,?,?,?)`);
        const row = syntheticRow();
        insert.run('excluded', row.cardAccountId, row.transactionDate, 'posted', row.kind, row.currency, row.amountMinor, 'synthetic-marker');
        expect(readLedger(db)).toEqual([]);
        expect(matchAmazon([syntheticSubject()], readLedger(db), bindings).results[0])
          .toMatchObject({ state: 'held', reason: 'no-candidate', candidateCount: 0 });
        insert.run(row.id, row.cardAccountId, row.transactionDate, row.status, row.kind, row.currency, row.amountMinor, null);
        const live = readLedger(db);
        expect(live.map(r => r.id)).toEqual([row.id]);
        expect(matchAmazon([syntheticSubject()], live, bindings).results[0])
          .toMatchObject({ state: 'linked', reason: 'unique', candidateCount: 1, cardTransactionId: row.id });
        expect(db.prepare('SELECT count(*) FROM card_transactions').pluck().get()).toBe(2);
      } finally { db.close(); }
    });
  }
});

describe('Amazon evidence admission and global candidate graph', () => {
  it('supports both explicitly bound cards, not household frequency', () => {
    for (const card of syntheticCards) expect(match(syntheticSubject({ method: { kind: 'card', network: 'visa', last4: card.last4 } }),
      syntheticRow({ cardAccountId: card.id }))).toMatchObject({ state: 'linked', evidenceClass: 'payment-event' });
  });
  it.each(['2026-09-01', '2026-09-15'])('admits inclusive settlement edge %s', date => {
    expect(match(syntheticSubject(), syntheticRow({ transactionDate: date })).state).toBe('linked');
  });
  it.each(['2026-08-31', '2026-09-16', '2026-02-30', ''])('holds date outside bounded window %s', date => {
    expect(match(syntheticSubject(), syntheticRow({ transactionDate: date })).state).toBe('held');
  });
  it('requires exact currency, amount, direction and posted purchase/refund', () => {
    for (const patch of [
      { currency: 'EUR' }, { amountMinor: 1099 }, { amountMinor: -1100 }, { status: 'pending' },
      { status: 'removed' }, { kind: 'fee' }, { kind: 'payment' }, { kind: 'adjustment' },
    ]) expect(match(syntheticSubject(), syntheticRow(patch)).state).toBe('held');
  });
  it('never matches unknown, pending, balance or missing-method evidence', () => {
    for (const subject of [
      syntheticSubject({ status: 'pending' }), syntheticSubject({ nativeOccurrenceId: null }),
      syntheticSubject({ method: { kind: 'balance', network: 'unknown', last4: null } }),
      syntheticSubject({ method: { kind: 'card', network: 'unknown', last4: '9001' } }),
      syntheticSubject({ method: { kind: 'card', network: 'visa', last4: null } }),
    ]) expect(match(subject).state).toBe('held');
  });
  it('requires ledger Refunded provenance, not order refund summaries or a return', () => {
    const refund = syntheticSubject({ money: { currency: 'USD', amountMinor: -500 }, provenance: 'ledger-Refunded' });
    const row = syntheticRow({ kind: 'refund', amountMinor: -500 });
    expect(match(refund, row).state).toBe('linked');
    expect(match({ ...refund, provenance: 'order-total' }, row).state).toBe('held');
    expect(match({ ...refund, provenance: 'ledger-Charged' }, row).state).toBe('held');
  });
  it('keeps equal-amount rows and orders ambiguous in both directions; never chooses nearest', () => {
    const s = syntheticSubject(), r = syntheticRow();
    expect(matchAmazon([s], [r, { ...r, id: 'second', transactionDate: '2026-09-05' }], bindings).results[0])
      .toMatchObject({ state: 'held', candidateCount: 2, reason: 'ambiguous' });
    expect(matchAmazon([s, { ...s, ref: opaque('subject', 'two'), nativeOccurrenceId: 'synthetic-two' }], [r], bindings).results
      .every(result => result.state === 'held')).toBe(true);
  });
  it('reserves preferred candidates against fallback and invalidates with later ambiguity', () => {
    const s = syntheticSubject(), r = syntheticRow();
    const total = { ...s, ref: opaque('total', 'one'), nativeOccurrenceId: null, evidenceClass: 'unique-total-match' as const,
      provenance: 'order-total' as const };
    expect(match(total, r).state).toBe('linked');
    expect(matchAmazon([total, s], [r], bindings).results.every(result => result.state === 'held')).toBe(true);
  });
  it('lower-evidence totals require positive single-tender proof, never refund inference', () => {
    const s = syntheticSubject({ nativeOccurrenceId: null, evidenceClass: 'unique-total-match', provenance: 'order-total' });
    expect(match(s).state).toBe('linked');
    for (const patch of [
      { tenderProof: 'unknown' as const }, { tenderProof: 'mixed' as const }, { orderRefs: [] },
      { money: { currency: 'USD', amountMinor: -1100 } },
    ]) expect(match({ ...s, ...patch }).state).toBe('held');
  });
  it('does not collapse distinct duplicate-looking events by amount/date; duplicate occurrence keys hold', () => {
    const s = syntheticSubject();
    const result = matchAmazon([s, { ...s, ref: opaque('subject', 'duplicate') }], [syntheticRow()], bindings);
    expect(result.results.every(r => r.reason === 'evidence-held')).toBe(true);
  });
  it('conflicting approved method bindings hold rather than choosing a card', () => {
    const conflicting = [...bindings, { ...bindings[0], cardAccountId: 'synthetic-other' }];
    expect(matchAmazon([syntheticSubject()], [syntheticRow()], conflicting).results[0].reason).toBe('binding-held');
  });
});
describe('separate Root binding proposal and approval', () => {
  it('pins inventory identity and policy, covers both cards, never autoapproves', () => {
    const proposal = proposeBindings(bindings, syntheticCards);
    expect(proposal.bindings).toHaveLength(2);
    expect(Object.hasOwn(proposal, 'approved')).toBe(false);
    expect(validateProposal(proposal, syntheticCards)).toEqual(proposal);
    expect(validateApproval(rootApproval(proposal), proposal).decision).toBe('approved');
    expect(() => validateApproval({ ...rootApproval(proposal), policyDigest: 'bad' }, proposal)).toThrow();
    expect(() => validateProposal(proposal, syntheticCards.map(c => ({ ...c, owner: 'joint' })))).toThrow();
  });
  it('never resolves duplicate last4 by inferred owner', () => {
    const cards = syntheticCards.map(c => ({ ...c, last4: '9001' }));
    expect(() => proposeBindings(cards.map(c => ({ network: 'visa', last4: c.last4, cardAccountId: c.id })), cards)).toThrow();
  });
});
