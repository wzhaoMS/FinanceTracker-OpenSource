import type { Database } from 'better-sqlite3';
import {
  compareCashPlanAsOf,
  easternDate,
  mergeLiveFacts,
  observationAsOf,
  type CardScheduleObservation,
  type CardScheduleSourceKind,
  type CashPlanAsOf,
} from '@finance-tracker/shared';

import { CASH_PLAN_CONFLICT, cashPlanSchemaState, listCardScheduleObservations } from './cashPlan.js';
import { HoldrRefusal } from './dbErrors.js';

/**
 * Owed now (Everyday → Card transactions): each card's current balance as its issuer last showed it, read-only, from the
 * card schedule observations `holdr-cash import` appends. A balance needs no statement cycle: besides accepted rows, a row
 * held only because it names neither a closing nor a due date (`cycle-unknown`: a balance-only read, an issuer download's
 * ledger balance say) gives its card's figures here, and nothing else; the payment schedule (`GET /cash/payments`) still
 * never reads it. A row held for any other reason (no single card, another currency, a minimum's basis) is counted in
 * `held`, never shown. Amounts are minor units, positive owed and negative a credit; unknown is null, never 0.
 */

/** One card's figures, each as the newest read that shows it. */
export interface CashOwedRead {
  /** The newest current balance read; null when the newest reads of it disagree (`conflict`) or none showed one. */
  currentBalanceMinor: number | null;
  conflict: boolean;
  /** The financial as-of of the balance (or, without one, of the newest read): an instant …Z or a YYYY-MM-DD date. */
  asOf: string;
  /** Its household (Eastern) date. */
  asOfDate: string;
  sourceKind: CardScheduleSourceKind;
  /** The issuer's last statement balance, and its close where one of its reads named it. */
  statementBalanceMinor: number | null;
  statementClosingDate: string | null;
  /** What remains of that statement to pay, from its reads and the reads after them. */
  remainingStatementMinor: number | null;
  /** The newest due date read since that statement (from any read, without one). */
  paymentDueDate: string | null;
  /** The minimum due by that due date (the issuer's total minimum). */
  minimumDueMinor: number | null;
}

export interface CashOwedCardView {
  cardAccountId: string;
  issuer: string;
  owner: string;
  nickname: string | null;
  last4: string | null;
  last5: string | null;
  currency: string;
  status: 'active' | 'closed';
  /** Null: nothing read for this card yet. */
  read: CashOwedRead | null;
}

export interface CashOwedView {
  /** False until the operator installs the observations table: every card is listed, none read. */
  installed: boolean;
  asOf: string;
  today: string;
  /** Every active card, and each closed card whose newest balance is not zero. */
  cards: CashOwedCardView[];
  /** Stored reads shown on no card (held for no single card, another currency, a minimum's basis). */
  held: number;
}

interface OwedAccount {
  id: string;
  issuer: string;
  owner: string;
  nickname: string | null;
  last4: string | null;
  last5: string | null;
  currency: string;
  status: 'active' | 'closed';
}

interface OwedFact {
  observation: CardScheduleObservation;
  asOf: CashPlanAsOf;
}

const byId = (a: OwedFact, b: OwedFact) => (a.observation.id < b.observation.id ? -1 : a.observation.id > b.observation.id ? 1 : 0);
/** The latest of `facts` by financial as-of (ties by id, so the answer never depends on row order). */
const latestOf = (facts: readonly OwedFact[]): OwedFact => [...facts].sort((a, b) => b.asOf.lowerMs - a.asOf.lowerMs || byId(a, b))[0];

/** The value `pick` reads in the newest facts that show one: null when none does, or when the newest disagree. */
function newest<T>(facts: readonly OwedFact[], pick: (o: CardScheduleObservation) => T | null): { value: T | null; fact: OwedFact | null } {
  const shown = facts.filter((fact) => pick(fact.observation) !== null);
  const top = shown.filter((fact) => !shown.some((other) => compareCashPlanAsOf(other.asOf, fact.asOf) === 'after'));
  if (top.length === 0 || new Set(top.map((fact) => JSON.stringify(pick(fact.observation)))).size > 1) return { value: null, fact: null };
  const fact = latestOf(top);
  return { value: pick(fact.observation), fact };
}

/**
 * The reads of the statement shown, and every read after them: what is left of it and when it is due come only from
 * these, so an earlier statement's figures never pair with a later one. The statement's reads are those showing its
 * balance (and its close: the newest one so named; a read naming none counts from that closing day on), back to the
 * newest read of any other statement; when the newest statement reads disagree, those reads. A read of the same day at
 * another precision can't be ordered against them, so it counts only if it is one of them. Without a statement read,
 * every read.
 */
function readsOfStatement(facts: readonly OwedFact[], value: number | null): { since: OwedFact[]; close: string | null } {
  const shown = facts.filter((fact) => fact.observation.statementBalanceMinor !== null);
  if (shown.length === 0) return { since: [...facts], close: null };
  const top = shown.filter((fact) => !shown.some((other) => compareCashPlanAsOf(other.asOf, fact.asOf) === 'after'));
  let run = top;
  let close: string | null = null;
  if (value !== null) {
    const closes = shown.filter((fact) => fact.observation.statementBalanceMinor === value)
      .map((fact) => fact.observation.statementClosingDate).filter((date): date is string => date !== null).sort();
    close = closes[closes.length - 1] ?? null;
    const same = (fact: OwedFact) => fact.observation.statementBalanceMinor === value && (close === null
      // A read naming no close is one of the statement's reads only from its closing day on.
      || (fact.observation.statementClosingDate === null ? fact.asOf.date >= close : fact.observation.statementClosingDate === close));
    const own = shown.filter((fact) => same(fact)
      && !shown.some((other) => !same(other) && compareCashPlanAsOf(other.asOf, fact.asOf) === 'after'));
    if (own.length > 0) run = own;
    // The close only where one of the statement's own reads names it.
    if (!run.some((fact) => fact.observation.statementClosingDate === close)) close = null;
  }
  const start = run.reduce((oldest, fact) => (fact.asOf.lowerMs < oldest.asOf.lowerMs ? fact : oldest));
  const inRun = new Set(run);
  const since = facts.filter((fact) => {
    if (inRun.has(fact)) return true;
    const order = compareCashPlanAsOf(fact.asOf, start.asOf);
    return order === 'after' || order === 'equal';
  });
  return { since, close };
}

/** A card's figures from its reads (accepted and balance-only), or null without any. */
function owedRead(observations: readonly CardScheduleObservation[]): CashOwedRead | null {
  if (observations.length === 0) return null;
  const facts: OwedFact[] = observations.map((observation) => ({ observation, asOf: observationAsOf(observation) }));
  const live = mergeLiveFacts(observations);
  const statement = newest(facts, (o) => o.statementBalanceMinor);
  const { since, close } = readsOfStatement(facts, statement.value);
  const remaining = mergeLiveFacts(since.map((fact) => fact.observation)).remaining.value;
  const due = newest(since, (o) => o.paymentDueDate);
  const minimum = due.value === null ? null
    : newest(since.filter((fact) => fact.observation.paymentDueDate === due.value), (o) => o.minimumDueMinor).value;
  const anchor = live.currentBalance.fact ?? latestOf(facts);
  return {
    currentBalanceMinor: live.currentBalance.value,
    conflict: live.currentBalance.conflict,
    asOf: anchor.observation.financialAsOf,
    asOfDate: anchor.asOf.date,
    sourceKind: anchor.observation.sourceKind,
    statementBalanceMinor: statement.value,
    statementClosingDate: close,
    remainingStatementMinor: remaining,
    paymentDueDate: due.value,
    minimumDueMinor: minimum,
  };
}

/** Whether a stored row gives its card's figures: accepted, or held only for naming no statement cycle. */
const shownOnCard = (o: CardScheduleObservation) => o.cardAccountId !== null && (o.status === 'accepted' || o.heldReason === 'cycle-unknown');

/**
 * `GET /cash/owed`, as of `now`: what Holdr knew by then (rows observed and imported by `now`). A table in another shape
 * is the fixed conflict refusal, as for the payment schedule; without the table every card is listed unread.
 */
export function cashOwedView(db: Database, now: Date): CashOwedView {
  const state = cashPlanSchemaState(db);
  if (state === 'conflict') throw new HoldrRefusal(CASH_PLAN_CONFLICT);
  const T = now.getTime();
  const accounts = db.prepare(`SELECT id, issuer, owner, nickname, last4, last5, currency, status FROM card_accounts
    ORDER BY created_at, rowid`).all() as OwedAccount[];
  const observations = state === 'present'
    ? listCardScheduleObservations(db).filter((o) => Date.parse(o.observedAt) <= T && Date.parse(o.importedAt) <= T)
    : [];
  const view: CashOwedView = {
    installed: state === 'present',
    asOf: now.toISOString(),
    today: easternDate(now),
    cards: [],
    held: observations.filter((o) => !shownOnCard(o)).length,
  };
  for (const account of accounts) {
    const read = owedRead(observations.filter((o) => shownOnCard(o) && o.cardAccountId === account.id && o.currency === account.currency));
    // A closed card stays only while its newest balance may not be zero.
    if (account.status === 'closed' && !(read !== null && (read.conflict || (read.currentBalanceMinor ?? 0) !== 0))) continue;
    view.cards.push({
      cardAccountId: account.id,
      issuer: account.issuer,
      owner: account.owner,
      nickname: account.nickname,
      last4: account.last4,
      last5: account.last5,
      currency: account.currency,
      status: account.status,
      read,
    });
  }
  return view;
}
