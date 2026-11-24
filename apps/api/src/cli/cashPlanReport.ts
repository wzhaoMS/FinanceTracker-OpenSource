import type Database from 'better-sqlite3';
import { CASH_PLAN_RED_RULES, observationAsOf, type CashPlanRuleId } from '@finance-tracker/shared';

import { cashPaymentsView, readCashPlanInputs } from '../services/cashPlan.js';
import { createCheckingLedgerReader } from '../services/checking/ledger.js';

/**
 * `holdr-cash report`: the card payment schedule as the API would answer it now, as one value-free line. Counts and one
 * date only: active cards, cards with a statement cycle, red and amber items by rule, held observations and the newest
 * financial as-of date. Never an amount, a card's digits, an id or a source reference.
 */

export interface CashPlanReport {
  code: 'cash-plan-report';
  schema: 'present' | 'absent';
  activeCards: number;
  cardsWithCycle: number;
  red: Partial<Record<CashPlanRuleId, number>>;
  amber: Partial<Record<CashPlanRuleId, number>>;
  held: number;
  newestAsOf: string | null;
}

const RULES: readonly CashPlanRuleId[] = ['R1a', 'R1b', 'R2a', 'R2b', 'A1', 'A1b', 'A1c', 'A2', 'A2b', 'A5', 'A8', 'A9', 'A10', 'A11'];

export function cashPlanReport(db: Database.Database, now: Date): CashPlanReport {
  const inputs = readCashPlanInputs(db, createCheckingLedgerReader(db));
  const activeCards = db.prepare(`SELECT count(*) FROM card_accounts WHERE status = 'active'`).pluck().get() as number;
  const report: CashPlanReport = {
    code: 'cash-plan-report', schema: inputs.installed ? 'present' : 'absent', activeCards, cardsWithCycle: 0, red: {}, amber: {}, held: 0, newestAsOf: null,
  };
  if (!inputs.installed) return report;
  const view = cashPaymentsView(inputs, now);
  report.cardsWithCycle = view.cards.filter((card) => card.cycles.length > 0).length;
  report.held = view.totals.held;
  for (const item of view.cards.flatMap((card) => card.attention)) {
    const bucket = item.severity === 'red' ? report.red : report.amber;
    bucket[item.rule] = (bucket[item.rule] ?? 0) + 1;
  }
  report.red = sorted(report.red);
  report.amber = sorted(report.amber);
  const dates = inputs.observations.filter((o) => o.status === 'accepted').map((o) => observationAsOf(o).date).sort();
  report.newestAsOf = dates.length > 0 ? dates[dates.length - 1] : null;
  return report;
}

const sorted = (counts: Partial<Record<CashPlanRuleId, number>>) =>
  Object.fromEntries(RULES.filter((rule) => counts[rule] !== undefined).map((rule) => [rule, counts[rule]!])) as Partial<Record<CashPlanRuleId, number>>;

const KEYS = ['activeCards', 'amber', 'cardsWithCycle', 'code', 'held', 'newestAsOf', 'red', 'schema'];
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const isCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 99_999;

/** The report as one JSON line, or null when anything in it falls outside the strict schema (digits only in counts and the date). */
export function formatCashPlanReport(report: CashPlanReport): string | null {
  const record = report as unknown as Record<string, unknown>;
  if (Object.keys(record).sort().join('|') !== KEYS.join('|')) return null;
  if (report.code !== 'cash-plan-report' || (report.schema !== 'present' && report.schema !== 'absent')) return null;
  if (![report.activeCards, report.cardsWithCycle, report.held].every(isCount)) return null;
  if (report.newestAsOf !== null && (typeof report.newestAsOf !== 'string' || !DATE.test(report.newestAsOf))) return null;
  for (const [bucket, red] of [[report.red, true], [report.amber, false]] as const) {
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return null;
    for (const [rule, count] of Object.entries(bucket)) {
      if (!RULES.includes(rule as CashPlanRuleId) || CASH_PLAN_RED_RULES.includes(rule as CashPlanRuleId) !== red || !isCount(count)) return null;
    }
  }
  return `${JSON.stringify(report)}\n`;
}
