import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  CARD_PAYMENT_DECISIONS_NOT_INSTALLED,
  CARD_PAYMENT_DECISIONS_SCHEMA_SQL,
  CARD_PAYMENT_DECISION_REFUSALS,
  cardPaymentDecisionsSchemaState,
  installCardPaymentDecisionsSchema,
  isCardPaymentDecisionTaken,
  isCardPaymentDecisionsNotInstalled,
  listCardPaymentDecisions,
  recordCardPaymentDecision,
  revokeCardPaymentDecision,
  type CardPaymentDecisionInput,
} from './cardPaymentDecisions.js';
import { HoldrDbError, HoldrRefusal } from './dbErrors.js';

// Synthetic only: made-up ids in the stored grammars, made-up amounts and actors.
const PAYMENT = `card-txn-${'a'.repeat(32)}`;
const PAYMENT_2 = `card-txn-${'b'.repeat(32)}`;
const DEBIT = `chk-txn-${'c'.repeat(32)}`;
const DEBIT_2 = `chk-txn-${'d'.repeat(32)}`;
const OWNER = { actorRef: `usr_${'e'.repeat(32)}`, now: '2026-10-22T12:00:00.000Z' };
const LATER = { actorRef: `usr_${'f'.repeat(32)}`, now: '2026-10-22T13:00:00.000Z' };

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => { db.close(); });

const input = (patch: Partial<CardPaymentDecisionInput> = {}): CardPaymentDecisionInput => {
  const decision = patch.decision ?? 'confirmed';
  return {
    decision, cardTransactionId: PAYMENT, checkingTransactionId: DEBIT, amountMinor: -50_000, currency: 'USD',
    dayOffset: decision === 'confirmed' || decision === 'rejected' ? 1 : null, ...patch,
  };
};
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HoldrRefusal);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('card payment decisions schema', () => {
  it('is absent until installed, installs once, and reports any other shape as a conflict', () => {
    expect(cardPaymentDecisionsSchemaState(db)).toBe('absent');
    installCardPaymentDecisionsSchema(db);
    expect(cardPaymentDecisionsSchemaState(db)).toBe('present');
    installCardPaymentDecisionsSchema(db);
    expect(cardPaymentDecisionsSchemaState(db)).toBe('present');
    db.exec('CREATE TRIGGER synthetic_trigger AFTER INSERT ON card_payment_decisions BEGIN SELECT 1; END');
    expect(cardPaymentDecisionsSchemaState(db)).toBe('conflict');
    expect(refusal(() => installCardPaymentDecisionsSchema(db))).toBe(CARD_PAYMENT_DECISION_REFUSALS.conflict);
    db.exec('DROP TRIGGER synthetic_trigger; DROP INDEX card_payment_decisions_rejected');
    expect(cardPaymentDecisionsSchemaState(db)).toBe('conflict');
    db.exec('DROP TABLE card_payment_decisions; CREATE TABLE card_payment_decisions (id TEXT)');
    expect(cardPaymentDecisionsSchemaState(db)).toBe('conflict');
    db.exec('DROP TABLE card_payment_decisions');
    db.exec('CREATE TABLE synthetic_ledger (note TEXT); CREATE INDEX card_payment_decisions_debit ON synthetic_ledger (note)');
    expect(cardPaymentDecisionsSchemaState(db)).toBe('conflict');
  });

  it('works without the table for reads, and refuses writes with a refusal the API recognizes', () => {
    expect(listCardPaymentDecisions(db)).toEqual([]);
    const error = (() => { try { recordCardPaymentDecision(db, input(), OWNER); } catch (caught) { return caught; } return null; })();
    expect(isCardPaymentDecisionsNotInstalled(error)).toBe(true);
    expect((error as Error).message).toBe(CARD_PAYMENT_DECISIONS_NOT_INSTALLED);
    expect(refusal(() => revokeCardPaymentDecision(db, `cpd_${'a'.repeat(32)}`, OWNER))).toBe(CARD_PAYMENT_DECISIONS_NOT_INSTALLED);
  });

  it('stores only ids, the amount, a pair\'s day gap, the rules version and who decided, in the grammars its checks pin', () => {
    installCardPaymentDecisionsSchema(db);
    const sql = CARD_PAYMENT_DECISIONS_SCHEMA_SQL.join('\n');
    expect(sql).not.toMatch(/REFERENCES|description|text_|notes/i);
    const insert = (values: string) => () => db.exec(`INSERT INTO card_payment_decisions VALUES (${values})`);
    const id = `'cpd_${'a'.repeat(32)}'`;
    const actor = `'usr_${'a'.repeat(32)}'`;
    const at = "'2026-10-22T12:00:00.000Z'";
    expect(insert(`${id}, 'confirmed', '${PAYMENT}', '${DEBIT}', -1, 'USD', 1, 15, ${at}, ${actor}, NULL, NULL`)).not.toThrow();
    db.exec('DELETE FROM card_payment_decisions');
    expect(insert(`${id}, 'elsewhere', '${PAYMENT}', NULL, -1, 'USD', 1, NULL, ${at}, ${actor}, NULL, NULL`)).not.toThrow();
    db.exec('DELETE FROM card_payment_decisions');
    for (const values of [
      `'cpd_1234', 'confirmed', '${PAYMENT}', '${DEBIT}', -1, 'USD', 1, 1, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'maybe', '${PAYMENT}', '${DEBIT}', -1, 'USD', 1, 1, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'confirmed', '4111111111111111', '${DEBIT}', -1, 'USD', 1, 1, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'confirmed', '${PAYMENT}', 'chk-txn-123', -1, 'USD', 1, 1, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'confirmed', '${PAYMENT}', '${DEBIT}', 1, 'USD', 1, 1, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'confirmed', '${PAYMENT}', '${DEBIT}', -1.5, 'USD', 1, 1, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'elsewhere', '${PAYMENT}', '${DEBIT}', -1, 'USD', 1, NULL, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'not-card-payment', '${PAYMENT}', '${DEBIT}', -1, 'USD', 1, NULL, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'confirmed', '${PAYMENT}', NULL, -1, 'USD', 1, 1, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'confirmed', '${PAYMENT}', '${DEBIT}', -1, 'usd', 1, 1, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'confirmed', '${PAYMENT}', '${DEBIT}', -1, 'USD', 1, 1, '2026-10-22', ${actor}, NULL, NULL`,
      `${id}, 'confirmed', '${PAYMENT}', '${DEBIT}', -1, 'USD', 1, 1, ${at}, ${actor}, ${at}, NULL`,
      // A pair's answer keeps its day gap, at most 15 days either way, in whole days; no other answer has one.
      `${id}, 'confirmed', '${PAYMENT}', '${DEBIT}', -1, 'USD', 1, NULL, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'rejected', '${PAYMENT}', '${DEBIT}', -1, 'USD', 1, 16, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'confirmed', '${PAYMENT}', '${DEBIT}', -1, 'USD', 1, -16, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'confirmed', '${PAYMENT}', '${DEBIT}', -1, 'USD', 1, 1.5, ${at}, ${actor}, NULL, NULL`,
      `${id}, 'elsewhere', '${PAYMENT}', NULL, -1, 'USD', 1, 1, ${at}, ${actor}, NULL, NULL`,
    ]) {
      expect(insert(values), values).toThrow();
    }
  });
});

describe('recording and undoing card payment decisions', () => {
  beforeEach(() => installCardPaymentDecisionsSchema(db));

  it('records a decision, lists it in force, and undoes it, keeping it with who and when', () => {
    const confirmed = recordCardPaymentDecision(db, input(), OWNER);
    expect(confirmed).toEqual({
      id: expect.stringMatching(/^cpd_[a-p]{32}$/), decision: 'confirmed', cardTransactionId: PAYMENT, checkingTransactionId: DEBIT,
      amountMinor: -50_000, currency: 'USD', createdAt: OWNER.now, rulesVersion: 6, dayOffset: 1, revokedAt: null,
    });
    expect(listCardPaymentDecisions(db)).toEqual([confirmed]);
    const undone = revokeCardPaymentDecision(db, confirmed.id, LATER);
    expect(undone).toEqual({ ...confirmed, revokedAt: LATER.now });
    expect(revokeCardPaymentDecision(db, confirmed.id, OWNER)).toEqual(undone);
    expect(listCardPaymentDecisions(db)).toEqual([]);
    expect(listCardPaymentDecisions(db, { includeRevoked: true })).toEqual([undone]);
    expect(db.prepare('SELECT created_by, revoked_by FROM card_payment_decisions').get())
      .toEqual({ created_by: OWNER.actorRef, revoked_by: LATER.actorRef });
    expect(revokeCardPaymentDecision(db, `cpd_${'p'.repeat(32)}`, OWNER)).toBeNull();
  });

  it('keeps one decision in force per payment, per debit and per rejected pair', () => {
    const first = recordCardPaymentDecision(db, input(), OWNER);
    const taken = (patch: Partial<CardPaymentDecisionInput>) => {
      let caught: unknown;
      try { recordCardPaymentDecision(db, input(patch), OWNER); } catch (error) { caught = error; }
      expect(isCardPaymentDecisionTaken(caught)).toBe(true);
      return (caught as Error).message;
    };
    expect(taken({ checkingTransactionId: DEBIT_2 })).toBe(CARD_PAYMENT_DECISION_REFUSALS.paymentTaken);
    expect(taken({ decision: 'elsewhere', checkingTransactionId: null })).toBe(CARD_PAYMENT_DECISION_REFUSALS.paymentTaken);
    expect(taken({ cardTransactionId: PAYMENT_2 })).toBe(CARD_PAYMENT_DECISION_REFUSALS.debitTaken);
    expect(taken({ decision: 'not-card-payment', cardTransactionId: null })).toBe(CARD_PAYMENT_DECISION_REFUSALS.debitTaken);
    expect(taken({ decision: 'rejected' })).toBe(CARD_PAYMENT_DECISION_REFUSALS.pairConfirmed);
    // A rejection of another pair is fine, once; a rejected pair cannot be confirmed until its rejection is undone.
    const rejected = recordCardPaymentDecision(db, input({ decision: 'rejected', cardTransactionId: PAYMENT_2, checkingTransactionId: DEBIT_2 }), OWNER);
    expect(taken({ decision: 'rejected', cardTransactionId: PAYMENT_2, checkingTransactionId: DEBIT_2 })).toBe(CARD_PAYMENT_DECISION_REFUSALS.pairRejected);
    expect(taken({ cardTransactionId: PAYMENT_2, checkingTransactionId: DEBIT_2 })).toBe(CARD_PAYMENT_DECISION_REFUSALS.pairRejected);
    revokeCardPaymentDecision(db, rejected.id, LATER);
    recordCardPaymentDecision(db, input({ cardTransactionId: PAYMENT_2, checkingTransactionId: DEBIT_2 }), OWNER);
    // Undone, a decision's rows are free again.
    revokeCardPaymentDecision(db, first.id, LATER);
    recordCardPaymentDecision(db, input({ decision: 'elsewhere', checkingTransactionId: null }), OWNER);
    recordCardPaymentDecision(db, input({ decision: 'not-card-payment', cardTransactionId: null }), OWNER);
    expect(listCardPaymentDecisions(db).map((item) => item.decision).sort()).toEqual(['confirmed', 'elsewhere', 'not-card-payment']);
    expect(listCardPaymentDecisions(db, { includeRevoked: true })).toHaveLength(5);
  });

  it('refuses malformed decisions with messages that never repeat what was sent', () => {
    const cases: Array<[Partial<CardPaymentDecisionInput>, string]> = [
      [{ decision: 'maybe' }, CARD_PAYMENT_DECISION_REFUSALS.decision],
      [{ checkingTransactionId: null }, CARD_PAYMENT_DECISION_REFUSALS.rows],
      [{ decision: 'elsewhere' }, CARD_PAYMENT_DECISION_REFUSALS.rows],
      [{ decision: 'not-card-payment' }, CARD_PAYMENT_DECISION_REFUSALS.rows],
      [{ cardTransactionId: '4111 1111 1111 1111' }, CARD_PAYMENT_DECISION_REFUSALS.cardTransactionId],
      [{ checkingTransactionId: 'chk-txn-4111111111111111' }, CARD_PAYMENT_DECISION_REFUSALS.checkingTransactionId],
      [{ amountMinor: 50_000 }, CARD_PAYMENT_DECISION_REFUSALS.amount],
      [{ amountMinor: -0.5 }, CARD_PAYMENT_DECISION_REFUSALS.amount],
      [{ currency: 'usd' }, CARD_PAYMENT_DECISION_REFUSALS.currency],
      [{ dayOffset: null }, CARD_PAYMENT_DECISION_REFUSALS.dayOffset],
      [{ dayOffset: 16 }, CARD_PAYMENT_DECISION_REFUSALS.dayOffset],
      [{ decision: 'rejected', dayOffset: -16 }, CARD_PAYMENT_DECISION_REFUSALS.dayOffset],
      [{ dayOffset: 1.5 }, CARD_PAYMENT_DECISION_REFUSALS.dayOffset],
      [{ decision: 'elsewhere', checkingTransactionId: null, dayOffset: 1 }, CARD_PAYMENT_DECISION_REFUSALS.dayOffset],
    ];
    for (const [patch, message] of cases) {
      expect(refusal(() => recordCardPaymentDecision(db, input(patch), OWNER)), JSON.stringify(patch)).toBe(message);
    }
    expect(refusal(() => recordCardPaymentDecision(db, null as never, OWNER))).toBe(CARD_PAYMENT_DECISION_REFUSALS.input);
    expect(refusal(() => recordCardPaymentDecision(db, input(), { actorRef: 'someone', now: OWNER.now }))).toBe(CARD_PAYMENT_DECISION_REFUSALS.actor);
    expect(refusal(() => recordCardPaymentDecision(db, input(), { actorRef: OWNER.actorRef, now: 'today' }))).toBe(CARD_PAYMENT_DECISION_REFUSALS.now);
    expect(refusal(() => revokeCardPaymentDecision(db, '4111111111111111', OWNER))).toBe(CARD_PAYMENT_DECISION_REFUSALS.id);
    expect(listCardPaymentDecisions(db)).toEqual([]);
  });

  it('turns any database failure into a value-free error', () => {
    db.close();
    let caught: unknown;
    try { listCardPaymentDecisions(db); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(HoldrDbError);
    expect((caught as Error).message).toMatch(/^list card payment decisions failed \((SQLITE_[A-Z_]+|UNKNOWN)\)$/);
    db = new Database(':memory:');
  });
});
