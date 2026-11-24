import type Database from 'better-sqlite3';

import { metalsSchemaState } from '../services/metals/schema.js';

/**
 * `holdr-metals report`: the metals ledger as one value-free line. Counts and dates only: accounts and imports; active
 * orders, lots and dispositions; versions by state and quarantined orders; competitor orders, held records and coverage
 * ranges; bindings and owner decisions; the newest import's day and the range of order dates. Never an amount, a last 4,
 * a key, a title or a label.
 */

export interface MetalsReport {
  code: 'metals-report';
  schema: 'present' | 'absent';
  accounts: number;
  imports: number;
  orders: { buy: number; sell: number };
  lots: number;
  dispositions: number;
  versions: { active: number; superseded: number; proposed: number; conflict: number };
  quarantined: number;
  competitors: number;
  holds: number;
  coverage: number;
  bindings: { active: number; revoked: number };
  decisions: { live: number; revoked: number };
  newestImport: string | null;
  orderDates: { from: string; to: string } | null;
}

const zero = (): MetalsReport => ({
  code: 'metals-report', schema: 'absent', accounts: 0, imports: 0, orders: { buy: 0, sell: 0 }, lots: 0, dispositions: 0,
  versions: { active: 0, superseded: 0, proposed: 0, conflict: 0 }, quarantined: 0, competitors: 0, holds: 0, coverage: 0,
  bindings: { active: 0, revoked: 0 }, decisions: { live: 0, revoked: 0 }, newestImport: null, orderDates: null,
});

/** The report of a database whose tables are present or absent (a conflict is the caller's to refuse). */
export function metalsReport(db: Database.Database): MetalsReport {
  const report = zero();
  if (metalsSchemaState(db) !== 'present') return report;
  const count = (sql: string) => db.prepare(sql).pluck().get() as number;
  report.schema = 'present';
  report.accounts = count('SELECT count(*) FROM metals_accounts');
  report.imports = count('SELECT count(*) FROM metals_imports');
  report.orders = { buy: count(`SELECT count(*) FROM metals_orders WHERE side = 'buy'`), sell: count(`SELECT count(*) FROM metals_orders WHERE side = 'sell'`) };
  report.lots = count('SELECT count(*) FROM metals_lots');
  report.dispositions = count('SELECT count(*) FROM metals_dispositions');
  for (const state of ['active', 'superseded', 'proposed', 'conflict'] as const) {
    report.versions[state] = db.prepare('SELECT count(*) FROM metals_order_versions WHERE state = ?').pluck().get(state) as number;
  }
  report.quarantined = count(`SELECT count(DISTINCT order_key) FROM metals_order_versions WHERE state = 'conflict'`);
  report.competitors = count('SELECT count(DISTINCT order_key) FROM metals_competitors');
  report.holds = count('SELECT count(*) FROM metals_holds');
  report.coverage = count('SELECT count(*) FROM metals_coverage');
  report.bindings = { active: count(`SELECT count(*) FROM metals_bindings WHERE state = 'active'`), revoked: count(`SELECT count(*) FROM metals_bindings WHERE state = 'revoked'`) };
  report.decisions = {
    live: count('SELECT count(*) FROM metals_owner_decisions WHERE revoked_at IS NULL'),
    revoked: count('SELECT count(*) FROM metals_owner_decisions WHERE revoked_at IS NOT NULL'),
  };
  const newest = db.prepare('SELECT max(imported_at) FROM metals_imports').pluck().get() as string | null;
  report.newestImport = newest === null ? null : newest.slice(0, 10);
  const dates = db.prepare('SELECT min(order_date) AS "from", max(order_date) AS "to" FROM metals_orders').get() as { from: string | null; to: string | null };
  report.orderDates = dates.from === null || dates.to === null ? null : { from: dates.from, to: dates.to };
  return report;
}

const KEYS = ['accounts', 'bindings', 'code', 'competitors', 'coverage', 'decisions', 'dispositions', 'holds', 'imports', 'lots', 'newestImport',
  'orderDates', 'orders', 'quarantined', 'schema', 'versions'];
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const isCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 9_999_999;
const isCounts = (value: unknown, keys: readonly string[]) => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|') && keys.every((key) => isCount((value as Record<string, unknown>)[key]));

/** The report as one JSON line, or null when anything in it falls outside the strict schema (digits only in counts and dates). */
export function formatMetalsReport(report: MetalsReport): string | null {
  const record = report as unknown as Record<string, unknown>;
  if (Object.keys(record).sort().join('|') !== KEYS.join('|')) return null;
  if (report.code !== 'metals-report' || (report.schema !== 'present' && report.schema !== 'absent')) return null;
  if (![report.accounts, report.imports, report.lots, report.dispositions, report.quarantined, report.competitors, report.holds, report.coverage]
    .every(isCount)) return null;
  if (!isCounts(report.orders, ['buy', 'sell']) || !isCounts(report.versions, ['active', 'superseded', 'proposed', 'conflict'])
    || !isCounts(report.bindings, ['active', 'revoked']) || !isCounts(report.decisions, ['live', 'revoked'])) return null;
  if (report.newestImport !== null && (typeof report.newestImport !== 'string' || !DATE.test(report.newestImport))) return null;
  const dates = report.orderDates as unknown;
  if (dates !== null && (typeof dates !== 'object' || Object.keys(dates as object).sort().join('|') !== 'from|to'
    || !DATE.test(String((dates as { from: unknown }).from)) || !DATE.test(String((dates as { to: unknown }).to)))) return null;
  return `${JSON.stringify(report)}\n`;
}
