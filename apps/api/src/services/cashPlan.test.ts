import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateCardScheduleObservation, type ValidCardScheduleObservation } from '@finance-tracker/shared';
import { cardCoverageEvidence } from '../routes/cardSpendingOverview.js';
import {
  CASH_PLAN_SCHEMA_SQL,
  cashPaymentsView,
  cashPlanCardCoverage,
  cashPlanSchemaState,
  importCardScheduleObservations,
  installCashPlanSchema,
  listCardScheduleObservations,
  readCashPlanInputs,
} from './cashPlan.js';
import { HoldrRefusal } from './dbErrors.js';
import { SqliteStateRepo, type CardImportRow } from './sqliteStateRepo.js';

// The declared schema delta, the import and the reads, on a database made by this build. Synthetic only: made-up
// issuers' cards, last fours, dates and cents.

let dir: string;
let repo: SqliteStateRepo;
const NOW = '2026-11-03T17:00:00.000Z';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-cash-plan-'));
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db'), now: () => new Date(NOW) });
});
afterEach(async () => {
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

const db = () => repo.internalGetDb();
const REF = `sha256:${'d'.repeat(64)}`;

function valid(input: Record<string, unknown>): ValidCardScheduleObservation {
  const result = validateCardScheduleObservation({
    currency: 'USD', sourceKind: 'statement-pdf', sourceRef: REF, observedAt: '2026-10-13T12:00:00Z', extractorVersion: 'synthetic@1',
    ...input,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
const statementOf = (card: Record<string, string>, C: string, extra: Record<string, unknown> = {}) => valid({
  card, statementClosingDate: C, paymentDueDate: '2026-11-06', asOf: { source: 'statement', at: C, precision: 'date' },
  statementBalanceMinor: 20000, minimum: { minor: 5000, basis: 'total-due' }, pastDueMinor: 0, ...extra,
});

function row(patch: Partial<CardImportRow>): CardImportRow {
  return {
    transactionDate: '2026-10-12', postedDate: '2026-10-12', status: 'posted', amountMinor: -5000, currency: 'USD',
    kind: 'payment', description: 'ONLINE PAYMENT THANK YOU', merchant: null, issuerCategory: null, ...patch,
  } as CardImportRow;
}

describe('the declared schema delta', () => {
  it('is absent until installed; installs once, verified; another shape or object is a conflict', () => {
    expect(cashPlanSchemaState(db())).toBe('absent');
    installCashPlanSchema(db());
    expect(cashPlanSchemaState(db())).toBe('present');
    installCashPlanSchema(db());
    expect(cashPlanSchemaState(db())).toBe('present');
    db().exec('CREATE TRIGGER card_schedule_observations_t AFTER INSERT ON card_schedule_observations BEGIN SELECT 1; END');
    expect(cashPlanSchemaState(db())).toBe('conflict');
    expect(() => installCashPlanSchema(db())).toThrow();
    db().exec('DROP TRIGGER card_schedule_observations_t');
    db().exec('DROP INDEX card_schedule_observations_card_cycle');
    expect(cashPlanSchemaState(db())).toBe('conflict');
  });

  it('a lone object of its name in another letter case is a conflict', () => {
    db().exec('CREATE TABLE Card_Schedule_Observations (id TEXT)');
    expect(cashPlanSchemaState(db())).toBe('conflict');
  });

  it('the literal DDL enforces the M contract, the mixed-row rule and the per-field ranges', () => {
    installCashPlanSchema(db());
    const card = repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '1234', currency: 'USD' });
    let n = 0;
    const insert = (patch: Record<string, unknown>) => {
      const base: Record<string, unknown> = {
        id: `cso-${String.fromCharCode(97 + (n % 16)).repeat(16)}${String.fromCharCode(97 + Math.floor(n / 16) % 16).repeat(16)}`,
        card_account_id: card.id, issuer: 'testbank', currency: 'USD', source_kind: 'statement-pdf', source_ref: REF,
        observed_at: '2026-10-13T12:00:00.000Z', financial_as_of: '2026-10-11', as_of_source: 'statement', as_of_precision: 'date',
        import_ref: REF, payload_digest: (n.toString(16).padStart(64, '0')), extractor_version: 'synthetic@1',
        statement_closing_date: '2026-10-11', payment_due_date: '2026-11-06', minimum_due_minor: 5000, minimum_basis: 'total-due',
        status: 'accepted', held_reason: null, imported_at: NOW, ...patch,
      };
      n++;
      const columns = Object.keys(base);
      return () => db().prepare(`INSERT INTO card_schedule_observations (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...columns.map((column) => base[column] as never));
    };
    expect(insert({})).not.toThrow();
    const refused = [
      { minimum_basis: null },
      { minimum_due_minor: null },
      { minimum_due_minor: -1 },
      { statement_closing_date: null },
      { as_of_source: 'explicit', as_of_precision: 'instant', financial_as_of: '2026-10-12T12:00:00.000Z' },
      { financial_as_of: '2026-10-12' },
      { source_kind: 'issuer-dashboard-dom' },
      { status: 'held' },
      { card_account_id: null },
      { statement_period_start_date: '2026-10-11' },
      { payment_due_date: '2026-10-10' },
      { past_due_minor: -5 },
      { last_payment_minor: 0 },
      { autopay: 'on-statement', autopay_fixed_minor: 5000 },
      { statement_balance_minor: 1_000_000_000_000 },
      { payment_due_date: '2026-02-30' },
      { id: 'cso-1' },
      { observed_at: '2026-10-13 12:00:00' },
    ];
    for (const patch of refused) expect(insert(patch), JSON.stringify(patch)).toThrow();
    expect(insert({ source_kind: 'issuer-dashboard-dom', as_of_source: 'explicit', as_of_precision: 'instant', financial_as_of: '2026-10-12T12:00:00.000Z',
      remaining_statement_minor: -300, statement_balance_minor: -300 })).not.toThrow();
    expect(insert({ status: 'held', held_reason: 'minimum-basis', minimum_due_minor: null, minimum_basis: null })).not.toThrow();
    expect(insert({ status: 'held', held_reason: 'unbound', card_account_id: null })).not.toThrow();
  });

  it('is two statements, the table then its index', () => {
    expect(CASH_PLAN_SCHEMA_SQL).toHaveLength(2);
    expect(CASH_PLAN_SCHEMA_SQL[0]).toMatch(/^CREATE TABLE card_schedule_observations \(/);
    expect(CASH_PLAN_SCHEMA_SQL[1]).toBe('CREATE INDEX card_schedule_observations_card_cycle ON card_schedule_observations(card_account_id, statement_closing_date, payment_due_date)');
  });
});

describe('importCardScheduleObservations', () => {
  it('binds each observation to exactly one card of its issuer, digits and currency, or holds it; never guesses', () => {
    installCashPlanSchema(db());
    const a = repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '1234', currency: 'USD' });
    repo.createCardAccount({ issuer: 'otherbank', owner: 'alex', last4: '5555', currency: 'USD' });
    repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '5555', currency: 'USD' });
    repo.createCardAccount({ issuer: 'eurobank', owner: 'alex', last4: '7777', currency: 'EUR' });
    const amex = repo.createCardAccount({ issuer: 'amexlike', owner: 'alex', last4: '4321', last5: '84321', currency: 'USD' });
    const summary = importCardScheduleObservations(db(), [
      statementOf({ issuer: 'testbank', last4: '1234' }, '2026-10-11'),
      statementOf({ issuer: 'otherbank', last4: '5555' }, '2026-10-11'),
      statementOf({ issuer: 'eurobank', last4: '7777' }, '2026-10-11'),
      statementOf({ issuer: 'nobank', last4: '0000' }, '2026-10-11'),
      statementOf({ issuer: 'amexlike', last5: '84321' }, '2026-10-11'),
      statementOf({ issuer: 'amexlike', last5: '94321' }, '2026-10-11'),
      statementOf({ issuer: 'testbank', last4: '1234' }, '2026-09-11', { minimum: { minor: 5000, basis: 'current-only' } }),
    ], { importRef: REF, now: NOW });
    expect(summary).toEqual({ inserted: 7, duplicates: 0, held: { 'ambiguous-card': 1, invalid: 1, unbound: 2, 'minimum-basis': 1 }, cards: 2,
      dueDateRange: { from: '2026-11-06', to: '2026-11-06' } });
    const stored = listCardScheduleObservations(db());
    expect(stored.filter((o) => o.status === 'accepted').map((o) => o.cardAccountId).sort()).toEqual([a.id, amex.id].sort());
    expect(stored.filter((o) => o.heldReason === 'unbound' || o.heldReason === 'ambiguous-card' || o.heldReason === 'invalid').every((o) => o.cardAccountId === null)).toBe(true);
    const basis = stored.find((o) => o.heldReason === 'minimum-basis')!;
    expect(basis.cardAccountId).toBe(a.id);
    expect(basis.minimumDueMinor).toBeNull();
    // An Amex five-digit reference that ends in the same four but differs is not the card: held, never guessed.
    expect(stored.filter((o) => o.issuer === 'amexlike' && o.status === 'held')).toHaveLength(1);
  });

  it('an owner or a nickname in the reference tells apart cards that share an ending; one no card has holds the row', () => {
    installCashPlanSchema(db());
    repo.createCardAccount({ issuer: 'otherbank', owner: 'alex', last4: '5555', currency: 'USD' });
    const casey = repo.createCardAccount({ issuer: 'otherbank', owner: 'casey', last4: '5555', currency: 'USD' });
    const gold = repo.createCardAccount({ issuer: 'amexlike', owner: 'casey', nickname: 'Sample Gold', last4: '0005', last5: '70005', currency: 'USD' });
    const platinum = repo.createCardAccount({ issuer: 'amexlike', owner: 'casey', nickname: 'Sample Platinum', last4: '0005', last5: '70005', currency: 'USD' });
    const summary = importCardScheduleObservations(db(), [
      statementOf({ issuer: 'otherbank', last4: '5555' }, '2026-10-11'),
      statementOf({ issuer: 'otherbank', last4: '5555', owner: 'casey' }, '2026-09-11'),
      statementOf({ issuer: 'amexlike', last5: '70005', owner: 'casey' }, '2026-10-11'),
      statementOf({ issuer: 'amexlike', last5: '70005', owner: 'casey', nickname: ' sample  GOLD ' }, '2026-09-11'),
      statementOf({ issuer: 'amexlike', last5: '70005', nickname: 'Sample Platinum' }, '2026-08-11'),
      statementOf({ issuer: 'amexlike', last5: '70005', nickname: 'Sample Green' }, '2026-07-11'),
      statementOf({ issuer: 'otherbank', last4: '5555', owner: 'joint' }, '2026-07-11'),
    ], { importRef: REF, now: NOW });
    expect(summary).toMatchObject({ inserted: 7, duplicates: 0, held: { 'ambiguous-card': 2, unbound: 2 }, cards: 3 });
    const stored = listCardScheduleObservations(db());
    const boundTo = (issuer: string, closing: string) => stored.find((o) => o.issuer === issuer && o.statementClosingDate === closing)!.cardAccountId;
    expect([boundTo('otherbank', '2026-09-11'), boundTo('amexlike', '2026-09-11'), boundTo('amexlike', '2026-08-11')]).toEqual([casey.id, gold.id, platinum.id]);
    // Digits alone, or an owner both cards share, stay ambiguous; a nickname or an owner no card has is unbound.
    expect([boundTo('otherbank', '2026-10-11'), boundTo('amexlike', '2026-10-11'), boundTo('amexlike', '2026-07-11'), boundTo('otherbank', '2026-07-11')])
      .toEqual([null, null, null, null]);
    // A bound row's identity is its card, however the reference named it: the same fact again is a duplicate.
    expect(importCardScheduleObservations(db(), [statementOf({ issuer: 'otherbank', last4: '5555', owner: 'casey' }, '2026-09-11')],
      { importRef: REF, now: NOW, dryRun: true })).toMatchObject({ inserted: 0, duplicates: 1 });
  });

  it('is idempotent: the same facts again insert nothing, including held ones, whatever the capture time', () => {
    installCashPlanSchema(db());
    repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '1234', currency: 'USD' });
    const facts = [statementOf({ issuer: 'testbank', last4: '1234' }, '2026-10-11'), statementOf({ issuer: 'nobank', last4: '0000' }, '2026-10-11')];
    expect(importCardScheduleObservations(db(), facts, { importRef: REF, now: NOW }).inserted).toBe(2);
    const again = facts.map((fact) => ({ ...fact, observedAt: '2026-10-20T12:00:00.000Z' }));
    expect(importCardScheduleObservations(db(), again, { importRef: REF, now: NOW })).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(importCardScheduleObservations(db(), [...facts, facts[0]], { importRef: REF, now: NOW, dryRun: true })).toMatchObject({ inserted: 0, duplicates: 3 });
    expect(listCardScheduleObservations(db())).toHaveLength(2);
  });

  it('refuses without the table', () => {
    expect(() => importCardScheduleObservations(db(), [], { importRef: REF, now: NOW })).toThrow(HoldrRefusal);
  });
});

describe('readCashPlanInputs and the view', () => {
  it('reads coverage exactly as the card routes do, every credit row (removals included), and answers installed:false without the table', () => {
    const card = repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '1234', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: card.id, source: 'ofx', parserVersion: 'synthetic@1', coverage: { start: '2026-08-01', end: '2026-11-02' },
      rows: [row({}), row({ transactionDate: '2026-10-20', postedDate: '2026-10-20', amountMinor: 12_345, kind: 'purchase', description: 'SAMPLE SHOP' })] });
    expect(readCashPlanInputs(db(), null)).toMatchObject({ installed: false, accounts: [], rows: [] });
    expect(cashPaymentsView(readCashPlanInputs(db(), null), new Date(NOW))).toMatchObject({ installed: false, cards: [], totals: { red: 0, amber: 0, unknown: 0, held: 0 } });
    installCashPlanSchema(db());
    const inputs = readCashPlanInputs(db(), null);
    expect(inputs.installed).toBe(true);
    expect(inputs.rows.map((r) => [r.source, r.postedDate, r.amountMinor, r.kind])).toEqual([['ofx', '2026-10-12', -5000, 'payment']]);
    const fromRoutes = new Map(cardCoverageEvidence(repo).map((item) => [item.cardAccountId, item.ranges]));
    expect([...cashPlanCardCoverage(db())].map(([id, ranges]) => [id, ranges])).toEqual([[card.id, fromRoutes.get(card.id)]]);
  });

  it('every active card is listed; a closed card only while it still matters', () => {
    installCashPlanSchema(db());
    const active = repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '1234', currency: 'USD' });
    const closedQuiet = repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '2222', currency: 'USD', status: 'closed' });
    const closedOwing = repo.createCardAccount({ issuer: 'testbank', owner: 'casey', last4: '3333', currency: 'USD', status: 'closed' });
    importCardScheduleObservations(db(), [
      statementOf({ issuer: 'testbank', last4: '2222' }, '2026-10-11', { statementBalanceMinor: 0, minimum: { minor: 0, basis: 'total-due' } }),
      statementOf({ issuer: 'testbank', last4: '3333' }, '2026-10-11'),
    ], { importRef: REF, now: NOW });
    const view = cashPaymentsView(readCashPlanInputs(db(), null), new Date(NOW));
    expect(view.cards.map((card) => card.cardAccountId).sort()).toEqual([active.id, closedOwing.id].sort());
    expect(view.cards.find((card) => card.cardAccountId === closedQuiet.id)).toBeUndefined();
  });

  it('a payment the card returned after an issuer read undoes that read (#269 finding 3): the reversal date comes from the reconciliation', () => {
    const card = repo.createCardAccount({ issuer: 'testbank', owner: 'alex', last4: '1234', currency: 'USD' });
    repo.importCardTransactions({ cardAccountId: card.id, source: 'ofx', parserVersion: 'synthetic@1', coverage: { start: '2026-08-01', end: '2026-11-02' },
      rows: [
        row({ transactionDate: '2026-10-26', postedDate: '2026-10-26' }),
        row({ transactionDate: '2026-10-28', postedDate: '2026-10-28', amountMinor: 5000, description: 'RETURNED PAYMENT' }),
      ] });
    installCashPlanSchema(db());
    importCardScheduleObservations(db(), [
      statementOf({ issuer: 'testbank', last4: '1234' }, '2026-10-02', { paymentDueDate: '2026-10-27', statementBalanceMinor: 5000 }),
      valid({ card: { issuer: 'testbank', last4: '1234' }, sourceKind: 'issuer-dashboard-dom', observedAt: '2026-10-27T16:00:00Z',
        asOf: { source: 'explicit', at: '2026-10-27T16:00:00Z', precision: 'instant' }, statementClosingDate: '2026-10-02', paymentDueDate: '2026-10-27',
        remainingStatementMinor: 0, issuerPhrase: 'not-required' }),
    ], { importRef: REF, now: '2026-10-29T12:00:00.000Z' });
    const inputs = readCashPlanInputs(db(), null);
    const payment = inputs.rows.find((r) => r.amountMinor === -5000)!;
    expect([...inputs.returned]).toEqual([payment.id]);
    expect([...inputs.reversalDates]).toEqual([[payment.id, '2026-10-28']]);
    // Imported rows take SQLite's clock for created_at: evaluate once Holdr knows them (knowledge mode).
    const knownAt = new Date(Math.max(...inputs.rows.map((r) => Date.parse(r.createdAt))) + 60_000);
    const [view] = cashPaymentsView(inputs, knownAt).cards;
    expect(view.cycles[0]).toMatchObject({ closingDate: '2026-10-02', state: 'past-due-unconfirmed',
      answers: { minimumMetByDue: false, statementSatisfied: false } });
    expect(view.attention.map((item) => [item.rule, item.reason])).toEqual([['A11', 'past-due-unconfirmed']]);
  });
});
