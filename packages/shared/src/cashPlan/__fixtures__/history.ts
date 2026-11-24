import { addDays, easternDate, startOfEasternDay } from '../dates.js';
import { cashPlanForCard, type CardPlan, type CardPlanInput, type CashPlanCycle } from '../engine.js';
import type { CardScheduleObservation } from '../observations.js';
import type { CashPlanCardRow } from '../payments.js';

/** Synthetic histories for the cash plan tests: invented cards, dates and cents only. */

export const CARD = Object.freeze({ id: 'card-a', issuer: 'testbank', currency: 'USD', status: 'active' as const });
export const FULL_COVERAGE = Object.freeze([{ start: '2025-01-01', end: '2027-12-31' }]);
const REF = `sha256:${'a'.repeat(64)}`;

/** An Eastern wall-clock instant: `et('2026-10-13', 12)` is noon ET that day. */
export function et(date: string, hour = 12, minute = 0): string {
  return new Date(startOfEasternDay(date) + (hour * 60 + minute) * 60_000).toISOString();
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${String(++counter).padStart(5, '0')}`;

export function observation(fields: Partial<CardScheduleObservation>): CardScheduleObservation {
  const observedAt = fields.observedAt ?? '2026-01-01T12:00:00.000Z';
  return {
    id: nextId('cso'),
    cardAccountId: CARD.id,
    issuer: CARD.issuer,
    currency: CARD.currency,
    sourceKind: 'issuer-dashboard-dom',
    sourceRef: REF,
    observedAt,
    financialAsOf: observedAt,
    asOfSource: 'explicit',
    asOfPrecision: 'instant',
    importRef: REF,
    payloadDigest: 'b'.repeat(64),
    extractorVersion: 'test@1',
    statementPeriodStartDate: null,
    statementClosingDate: null,
    paymentDueDate: null,
    statementBalanceMinor: null,
    minimumDueMinor: null,
    minimumBasis: null,
    remainingStatementMinor: null,
    currentBalanceMinor: null,
    pastDueMinor: null,
    lastPaymentDate: null,
    lastPaymentMinor: null,
    scheduledPaymentDate: null,
    scheduledPaymentMinor: null,
    autopay: null,
    autopayFixedMinor: null,
    issuerPhrase: null,
    status: 'accepted',
    heldReason: null,
    importedAt: observedAt,
    ...fields,
  };
}

export interface StatementFacts {
  D?: string;
  S?: number;
  M?: number;
  start?: string;
  P?: number;
  phrase?: CardScheduleObservation['issuerPhrase'];
  lastPayment?: [string, number];
  /** When Holdr read it (default: two days after the close, 08:00 ET). */
  seenAt?: string;
}

const statementFields = (f: StatementFacts): Partial<CardScheduleObservation> => ({
  paymentDueDate: f.D ?? null,
  statementBalanceMinor: f.S ?? null,
  minimumDueMinor: f.M ?? null,
  minimumBasis: f.M === undefined ? null : 'total-due',
  statementPeriodStartDate: f.start ?? null,
  pastDueMinor: f.P ?? null,
  issuerPhrase: f.phrase ?? null,
  lastPaymentDate: f.lastPayment?.[0] ?? null,
  lastPaymentMinor: f.lastPayment?.[1] ?? null,
});

/** A statement PDF for the cycle closing on C: every field effective at C. */
export function statement(C: string, f: StatementFacts = {}): CardScheduleObservation {
  const seenAt = f.seenAt ?? et(addDays(C, 2), 8);
  return observation({
    sourceKind: 'statement-pdf', observedAt: seenAt, importedAt: seenAt,
    financialAsOf: C, asOfSource: 'statement', asOfPrecision: 'date', statementClosingDate: C, ...statementFields(f),
  });
}

export interface ReadFacts extends StatementFacts {
  C?: string;
  R?: number;
  balance?: number;
  autopay?: CardScheduleObservation['autopay'];
  autopayFixed?: number;
  scheduled?: [string | null, number | null];
  /** No issuer-stated as-of: implicit-capture at the read. */
  implicit?: boolean;
  /** An issuer-stated as-of date (date precision) instead of the instant. */
  asOfDate?: string;
}

/** A dashboard read at the instant `at` (an explicit instant as-of unless `implicit` or `asOfDate`). */
export function dashboard(at: string, f: ReadFacts = {}): CardScheduleObservation {
  const seenAt = f.seenAt ?? at;
  return observation({
    observedAt: seenAt, importedAt: seenAt,
    financialAsOf: f.asOfDate ?? at,
    asOfSource: f.implicit ? 'implicit-capture' : 'explicit',
    asOfPrecision: f.asOfDate ? 'date' : 'instant',
    statementClosingDate: f.C ?? null,
    ...statementFields(f),
    remainingStatementMinor: f.R ?? null,
    currentBalanceMinor: f.balance ?? null,
    autopay: f.autopay ?? null,
    autopayFixedMinor: f.autopayFixed ?? null,
    scheduledPaymentDate: f.scheduled?.[0] ?? null,
    scheduledPaymentMinor: f.scheduled?.[1] ?? null,
  });
}

export function cardRow(fields: Partial<CashPlanCardRow> & { id: string }): CashPlanCardRow {
  return {
    cardAccountId: CARD.id,
    source: 'ofx',
    transactionDate: '2026-01-01',
    postedDate: null,
    status: 'posted',
    amountMinor: -5000,
    currency: CARD.currency,
    kind: 'payment',
    description: 'PAYMENT THANK YOU',
    createdAt: '2026-01-01T12:00:00.000Z',
    mergedIntoId: null,
    removedReason: null,
    removedFromStatus: null,
    ...fields,
  };
}

/** A posted OFX payment: a registry posting date, its transaction date (DTUSER; default the posting date), imported the next morning. */
export function ofxPayment(id: string, minor: number, posted: string, opts: { txn?: string; createdAt?: string } = {}): CashPlanCardRow {
  return cardRow({ id, amountMinor: -minor, postedDate: posted, transactionDate: opts.txn ?? posted, createdAt: opts.createdAt ?? et(addDays(posted, 1), 6) });
}

/** A posted payment from a source with no posting date (Amex CSV): first appearance is its only date evidence. */
export function csvPayment(id: string, minor: number, date: string, createdAt: string): CashPlanCardRow {
  return cardRow({ id, source: 'amex-csv', amountMinor: -minor, transactionDate: date, postedDate: null, createdAt });
}

/** A pending payment first seen at `seenAt` (its transaction date defaults to that Eastern date). */
export function pendingPayment(id: string, minor: number, seenAt: string, opts: { txn?: string; source?: string } = {}): CashPlanCardRow {
  return cardRow({ id, source: opts.source ?? 'chase-api', status: 'pending', amountMinor: -minor, transactionDate: opts.txn ?? easternDate(seenAt), createdAt: seenAt });
}

/** A posted non-payment credit (a refund) first seen at `seenAt`. */
export function refund(id: string, minor: number, seenAt: string): CashPlanCardRow {
  return cardRow({ id, kind: 'refund', description: 'REFUND', source: 'amex-csv', amountMinor: -minor, transactionDate: easternDate(seenAt), createdAt: seenAt });
}

export interface History {
  observations: CardScheduleObservation[];
  rows: CashPlanCardRow[];
  asOf: string;
  coverage?: CardPlanInput['coverage'];
  returned?: string[];
  uncertain?: string[];
  /** Per returned or possibly reversed payment row: its (latest possible) reversal's date. */
  reversalDates?: Record<string, string>;
  rules?: CardPlanInput['rules'];
  mode?: CardPlanInput['mode'];
}

export function plan(history: History, w?: number): CardPlan {
  return cashPlanForCard({
    card: CARD,
    observations: history.observations,
    rows: history.rows,
    coverage: history.coverage ?? FULL_COVERAGE,
    asOf: history.asOf,
    returnedPaymentIds: new Set(history.returned ?? []),
    uncertainPaymentIds: new Set(history.uncertain ?? []),
    reversalDates: new Map(Object.entries(history.reversalDates ?? {})),
    rules: history.rules,
    mode: history.mode,
    firstAppearanceDays: w,
  });
}

export function cycleOf(result: CardPlan, closingDate: string): CashPlanCycle {
  const found = result.cycles.find((cycle) => cycle.closingDate === closingDate);
  if (!found) throw new Error(`no cycle ${closingDate}`);
  return found;
}

/** The rule ids on one cycle (A11 and R2a with their reason), sorted. */
export function rulesOf(cycle: CashPlanCycle): string[] {
  return cycle.attention.map((item) => (item.rule === 'A11' || item.rule === 'R2a' ? `${item.rule}:${item.reason}` : item.rule)).sort();
}

/** Every red item on the card, by rule and subject. */
export function redOf(result: CardPlan): string[] {
  return result.attention.filter((item) => item.severity === 'red').map((item) => `${item.rule}@${item.closingDate ?? item.dueDate ?? 'card'}`).sort();
}

/**
 * The v9 regression base (spec v9 §6): C_k = Oct 11 with M_k = 5000 total and a printed start that identifies k−1
 * (Sep 11, not required), D_k = Nov 6, T = Nov 3 noon ET, complete coverage. X posts (OFX) and is dated Oct 12.
 */
export const V9 = Object.freeze({ C: '2026-10-11', D: '2026-11-06', T: et('2026-11-03', 12), prevC: '2026-09-11', prevD: '2026-10-06' });

export function v9History(extra: { observations?: CardScheduleObservation[]; rows?: CashPlanCardRow[] }): History {
  return {
    observations: [
      statement(V9.prevC, { D: V9.prevD, S: 0, M: 0, P: 0 }),
      statement(V9.C, { start: '2026-09-12', D: V9.D, S: 20000, M: 5000, P: 0 }),
      ...(extra.observations ?? []),
    ],
    rows: extra.rows ?? [],
    asOf: V9.T,
  };
}

/** An issuer read naming its last payment (date d, cents), linked to the statement current at its as-of. */
export function lastPaymentRead(asOf: string, d: string, minor: number, statementOf: { C: string; D: string }): CardScheduleObservation {
  return dashboard(asOf, { C: statementOf.C, D: statementOf.D, lastPayment: [d, minor] });
}
