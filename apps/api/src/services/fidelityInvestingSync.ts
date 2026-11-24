import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { aggregatePositions, buildOccSymbol, dropImportedSnapshotsWhereActivityExists, parseOccSymbol, type Transaction } from '@finance-tracker/shared';
import { computeFingerprint, parseDescription } from './activityParser.js';
import { HoldrRefusal, toValueFreeDbError } from './dbErrors.js';
import { FIDELITY_CASH_ADOPTED_REASON } from './historyCorrections.js';
import { createSnapshotRepo } from './snapshotJob.js';
import { marketDate } from './symbolHistory.js';
import type { SqliteStateRepo } from './sqliteStateRepo.js';

export interface FidelityActivity {
  key: string;
  date: string;
  description: string;
  symbol: string | null;
  quantity: number;
  pricePerUnit: number | null;
  amount: number;
  fees: number;
}
export interface FidelityCaptureAccount {
  sourceId: string;
  last4: string;
  currency: 'USD';
  coverage: { from: string; to: string };
  activity: FidelityActivity[];
  positions: { symbol: string; quantity: number; pricePerUnit: number; costBasis: number | null; marketValue?: number }[];
  cashBalance: number;
  pendingBalance?: number;
  totalValue: number;
}
export interface FidelityInvestingCapture {
  format: 'holdr.fidelity-investing-capture';
  version: 1;
  capturedAt: string;
  accounts: FidelityCaptureAccount[];
}
export interface FidelityInvestingPolicy {
  bindings: { sourceId: string; last4: string; accountId: string }[];
  ignoredSources: string[];
}
export interface FidelityImportAccountResult {
  last4: string;
  status: 'applied' | 'held' | 'ignored';
  reason?: string;
  added: number;
  rekeyed: number;
  duplicates: number;
  audited: number;
  activityTypes?: Partial<Record<FidelityActivityType, number>>;
  baseline?: boolean;
  baselineCashAdoption?: boolean;
  bridgedBaseline?: boolean;
  bridgedRowCount?: number;
}
export type FidelityActivityType = 'trade' | 'split' | 'reverseSplit' | 'inKindTransfer'
  | 'rsuDeposit' | 'esppDeposit' | 'reinvestment' | 'cash' | 'coreSettlement' | 'coreIncome' | 'otherQuantity'
  | 'exercise' | 'assignment' | 'expiration';
export interface FidelityImportReceipt {
  receiptId: string;
  captureDigest: string;
  accounts: FidelityImportAccountResult[];
}
export interface FidelityTransportAudit {
  jobId: string;
  heldSources: number;
  heldActivity: number;
  cancelled: number;
  boundaryRows: number;
}

const CASH = new Set(['FDRXX', 'FZFXX', 'SPAXX', 'FCASH']);
/** The history correction an import records when it adopts the broker's cash by more than the tolerance. */
export { FIDELITY_CASH_ADOPTED_REASON };
export const FIDELITY_CASH_ADOPTION_TOLERANCE = 0.02;

/**
 * Where a cash adoption's correction starts: the market day of the account's last observation before the capture,
 * which still held Holdr's old cash, or the capture's own day when there is none. Snapshots from then until the
 * adoption become captured-before-sync context, so no chart measures across the correction as a gain or loss.
 */
export function cashAdoptionEffectiveDate(db: ReturnType<SqliteStateRepo['internalGetDb']>, accountId: string, capturedAt: string): string {
  const lastObserved = db.prepare('SELECT MAX(taken_at) FROM account_snapshots WHERE account_id = ? AND taken_at < ?')
    .pluck().get(accountId, capturedAt) as string | null;
  return marketDate(new Date(lastObserved ?? capturedAt));
}
const SOURCE = /^fidelity-[a-f0-9]{64}$/;
const KEY = /^[a-f0-9]{64}$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9 .:/_-]{0,39}$/;
export const fidelityInvestingDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => (
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : item
))).digest('hex');
const hash = fidelityInvestingDigest;
const close = (a: number, b: number, epsilon = 1e-8): boolean => Math.abs(a - b) <= epsilon;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function captureOption(symbol: string) {
  const standard = parseOccSymbol(symbol);
  if (standard) return standard;
  const match = /^-?([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d+(?:\.\d{1,3})?)$/.exec(symbol);
  if (!match) return null;
  try {
    return parseOccSymbol(buildOccSymbol({ underlyingSymbol: match[1],
      expirationDate: `20${match[2]}-${match[3]}-${match[4]}`,
      optionType: match[5] === 'C' ? 'call' : 'put', strikePrice: Number(match[6]) }));
  } catch { return null; }
}
const captureSymbol = (symbol: string): string => captureOption(symbol)?.symbol ?? symbol;
function refuse(): never { throw new HoldrRefusal('invalid fidelity investing input'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join('|') !== [...keys].sort().join('|')) return refuse();
  return row;
}
function day(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function unique(values: unknown[]): void {
  if (new Set(values).size !== values.length) refuse();
}

export function validateFidelityActivity(value: unknown, from: string, to: string): void {
  const r = object(value, ['key', 'date', 'description', 'symbol', 'quantity', 'pricePerUnit', 'amount', 'fees']);
  if (typeof r.key !== 'string' || !KEY.test(r.key) || !day(r.date) || r.date < from || r.date > to
    || typeof r.description !== 'string' || r.description.length > 4000
    || (r.symbol !== null && (typeof r.symbol !== 'string' || (!SYMBOL.test(r.symbol) && !captureOption(r.symbol))))
    || !finite(r.quantity) || !finite(r.amount) || !finite(r.fees) || r.fees < 0
    || (r.pricePerUnit !== null && (!finite(r.pricePerUnit) || r.pricePerUnit < 0))) refuse();
}

/** Validate an untrusted JSON boundary; reject extra fields rather than retain secrets. */
export function validateFidelityInvestingInput(capture: unknown, policy: unknown): void {
  const c = object(capture, ['format', 'version', 'capturedAt', 'accounts']);
  if (c.format !== 'holdr.fidelity-investing-capture' || c.version !== 1
    || typeof c.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(c.capturedAt)
    || !day(c.capturedAt.slice(0, 10)) || !Number.isFinite(Date.parse(c.capturedAt))
    || !Array.isArray(c.accounts)) refuse();
  for (const value of c.accounts) {
    const hasPending = value !== null && typeof value === 'object' && Object.hasOwn(value, 'pendingBalance');
    const a = object(value, ['sourceId', 'last4', 'currency', 'coverage', 'activity', 'positions', 'cashBalance', 'totalValue',
      ...(hasPending ? ['pendingBalance'] : [])]);
    if (typeof a.sourceId !== 'string' || !SOURCE.test(a.sourceId)
      || typeof a.last4 !== 'string' || !/^\d{4}$/.test(a.last4) || a.currency !== 'USD'
      || !finite(a.cashBalance) || !finite(a.totalValue) || !Array.isArray(a.activity) || !Array.isArray(a.positions)
      || (hasPending && !finite(a.pendingBalance))) refuse();
    const coverage = object(a.coverage, ['from', 'to']);
    if (!day(coverage.from) || !day(coverage.to) || coverage.from > coverage.to
      || coverage.to > new Date(c.capturedAt as string).toISOString().slice(0, 10)) refuse();
    for (const value of a.activity as unknown[]) validateFidelityActivity(value, coverage.from as string, coverage.to as string);
    unique((a.activity as FidelityActivity[]).map(r => r.key));
    for (const value of a.positions as unknown[]) {
      const nativeValue = value !== null && typeof value === 'object' && Object.hasOwn(value, 'marketValue');
      const p = object(value, ['symbol', 'quantity', 'pricePerUnit', 'costBasis', ...(nativeValue ? ['marketValue'] : [])]);
      if (typeof p.symbol !== 'string' || (!SYMBOL.test(p.symbol) && !captureOption(p.symbol)) || !finite(p.quantity)
        || !finite(p.pricePerUnit) || p.pricePerUnit < 0 || (p.costBasis !== null && !finite(p.costBasis))
        || (nativeValue && !finite(p.marketValue))) refuse();
    }
    const positions = a.positions as FidelityCaptureAccount['positions'];
    if (positions.some(p => p.marketValue !== undefined) && positions.some(p => p.marketValue === undefined)) refuse();
    unique(positions.map(p => captureSymbol(p.symbol)));
  }
  unique((c.accounts as FidelityCaptureAccount[]).map(a => a.sourceId));
  const p = object(policy, ['bindings', 'ignoredSources']);
  if (!Array.isArray(p.bindings) || !Array.isArray(p.ignoredSources)) refuse();
  for (const value of p.bindings) {
    const b = object(value, ['sourceId', 'last4', 'accountId']);
    if (typeof b.sourceId !== 'string' || !SOURCE.test(b.sourceId) || typeof b.last4 !== 'string'
      || !/^\d{4}$/.test(b.last4) || typeof b.accountId !== 'string' || !b.accountId || b.accountId.length > 200) refuse();
  }
  if (!p.ignoredSources.every(s => typeof s === 'string' && SOURCE.test(s))) refuse();
  const bindings = p.bindings as FidelityInvestingPolicy['bindings'];
  unique([...bindings.map(b => b.sourceId), ...p.ignoredSources]);
  unique(bindings.map(b => b.accountId));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fidelity_investing_receipts (
  id TEXT PRIMARY KEY, capture_digest TEXT NOT NULL, policy_digest TEXT NOT NULL,
  captured_at TEXT NOT NULL, imported_at TEXT NOT NULL, result_json TEXT NOT NULL,
  job_id TEXT, transport_json TEXT
);
CREATE TABLE IF NOT EXISTS fidelity_investing_sources (
  source_id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
  captured_at TEXT NOT NULL, capture_digest TEXT NOT NULL, applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fidelity_investing_activity (
  source_id TEXT NOT NULL REFERENCES fidelity_investing_sources(source_id) ON DELETE RESTRICT,
  activity_key TEXT NOT NULL, content_digest TEXT NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY(source_id, activity_key)
);
CREATE TABLE IF NOT EXISTS fidelity_investing_activity_aliases (
  source_id TEXT NOT NULL, activity_key TEXT NOT NULL, canonical_key TEXT NOT NULL,
  PRIMARY KEY(source_id, activity_key),
  FOREIGN KEY(source_id, activity_key) REFERENCES fidelity_investing_activity(source_id, activity_key) ON DELETE RESTRICT,
  FOREIGN KEY(source_id, canonical_key) REFERENCES fidelity_investing_activity(source_id, activity_key) ON DELETE RESTRICT,
  CHECK(activity_key <> canonical_key)
);
CREATE TABLE IF NOT EXISTS fidelity_investing_bridges (
  source_id TEXT PRIMARY KEY REFERENCES fidelity_investing_sources(source_id) ON DELETE RESTRICT,
  cutoff_day TEXT NOT NULL, row_count INTEGER NOT NULL, cash_delta REAL NOT NULL,
  cash_adopted INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fidelity_investing_incremental (
  source_id TEXT PRIMARY KEY REFERENCES fidelity_investing_sources(source_id) ON DELETE RESTRICT,
  cutoff_day TEXT NOT NULL, ledger_digest TEXT NOT NULL, cash_balance REAL NOT NULL,
  previous_cash_balance REAL NOT NULL, baseline_cash_adopted INTEGER NOT NULL,
  baseline_at TEXT NOT NULL, baseline_digest TEXT NOT NULL
);`;

function activityType(row: FidelityActivity): FidelityActivityType {
  const text = row.description.toUpperCase();
  if (/^(?:EXERCISED?|YOU\s+(?:BOUGHT|SOLD)\s+EXERCISED?)\b/.test(text)) return 'exercise';
  if (/^(?:ASSIGNED|ASSIGNMENT|YOU\s+(?:BOUGHT|SOLD)\s+ASSIGNED)\b/.test(text)) return 'assignment';
  if (/^(?:EXPIRED|EXPIRATION)\b/.test(text)) return 'expiration';
  if (row.symbol && CASH.has(row.symbol)) {
    if (/\b(?:YOU BOUGHT|YOU SOLD|REINVESTMENT|REDEMPTION|PURCHASE INTO CORE|CORE PURCHASE)\b/.test(text)) return 'coreSettlement';
    if (/\b(?:CASH DIVIDEND|DIVIDEND RECEIVED|INTEREST)\b/.test(text)) return 'coreIncome';
  }
  if (row.quantity === 0) return 'cash';
  if (row.symbol && CASH.has(row.symbol)) return 'otherQuantity';
  if (/\bREVERSE (?:STOCK )?SPLIT\b/.test(text)) return 'reverseSplit';
  if (/\b(?:STOCK SPLIT|FORWARD SPLIT|SPLIT)\b/.test(text)) return row.quantity < 0 ? 'reverseSplit' : 'split';
  if (/\b(?:RSU|RESTRICTED STOCK)\b/.test(text)) return 'rsuDeposit';
  if (/\b(?:ESPP|EMPLOYEE STOCK PURCHASE)\b/.test(text)) return 'esppDeposit';
  if (/\b(?:IN[- ]KIND|ACAT|TRANSFERRED|TRANSFER OF (?:ASSETS|SHARES))\b/.test(text)) return 'inKindTransfer';
  if (/\bREINVEST(?:MENT|ED)?\b/.test(text)) return 'reinvestment';
  return row.amount !== 0 ? 'trade' : 'otherQuantity';
}

function cashImpact(row: FidelityActivity): number | string {
  const type = activityType(row);
  // Core holdings are already cash. Their settlement legs merely move money
  // inside cash; core income, unlike its reinvestment leg, increases total cash.
  if (type === 'coreSettlement') return row.fees === 0 ? 0 : 'unsupported-core-cash-activity';
  if (type === 'coreIncome') return row.amount >= 0 ? row.amount : 'unsupported-core-cash-activity';
  if (row.symbol && CASH.has(row.symbol) && row.quantity !== 0) return 'unsupported-core-cash-activity';
  return row.amount;
}

function incrementalTransaction(
  row: FidelityActivity, account: FidelityCaptureAccount, existing: Transaction[], eligible: FidelityActivity[], accountId: string,
): Transaction | string | null {
  const type = activityType(row);
  if (['exercise', 'assignment', 'expiration'].includes(type)) return lifecycleTransaction(row, account, accountId);
  // Options still require parser-confirmed metadata, including their multiplier.
  const probe = transaction({ ...row, pricePerUnit: 1 }, accountId);
  if (typeof probe === 'string' || !probe) return probe;
  if (type === 'split' || type === 'reverseSplit') {
    if (type === 'reverseSplit' || row.amount !== 0 || row.fees !== 0
      || dropImportedSnapshotsWhereActivityExists(existing).filter(t => t.symbol === row.symbol).reduce((n, t) => n + t.quantity, 0) <= 0
      || probe.instrumentType === 'option') return 'quantity-only-basis-unproven';
    return { ...probe, pricePerUnit: 0, fees: 0 };
  }
  if (row.pricePerUnit !== null && row.pricePerUnit > 0) return transaction(row, accountId);
  if (row.amount !== 0) {
    // Native amount is NET, so this effective unit amount already includes fees.
    return { ...probe, pricePerUnit: Math.abs(row.amount / row.quantity) / (probe.contractMultiplier ?? 1), fees: 0 };
  }
  if (['inKindTransfer', 'rsuDeposit', 'esppDeposit', 'reinvestment'].includes(type)) {
    const current = account.positions.find(p => captureSymbol(p.symbol) === probe.symbol);
    // Only an entire newly introduced holding has a unique basis allocation here.
    // Current total basis cannot establish an old lot's historical execution price.
    if (row.quantity > 0 && row.fees === 0 && probe.instrumentType !== 'option'
      && !existing.some(t => t.symbol === probe.symbol)
      && eligible.filter(r => r.symbol && captureSymbol(r.symbol) === probe.symbol && r.quantity !== 0).length === 1
      && current && close(current.quantity, row.quantity) && finite(current.costBasis) && current.costBasis >= 0) {
      return { ...probe, pricePerUnit: current.costBasis / row.quantity, fees: 0 };
    }
  }
  return 'quantity-only-basis-unproven';
}

function economic(t: Transaction): string {
  return JSON.stringify([t.date, t.symbol, t.quantity, t.pricePerUnit, t.fees ?? 0, t.currency,
    t.instrumentType ?? null, t.contractMultiplier ?? null, t.positionEffect ?? null]);
}

function provenLegacy(row: FidelityActivity, last4: string, existing: Transaction): boolean {
  const parsed = parseDescription(row.description);
  if (parsed.action === 'UNKNOWN' || !row.symbol || parsed.symbol !== captureSymbol(row.symbol)) return false;
  return existing.sourceFingerprint === computeFingerprint({
    date: row.date, accountLast4: last4, action: parsed.action,
    symbol: row.symbol, quantity: row.quantity, pricePerUnit: row.pricePerUnit,
  });
}

function transaction(row: FidelityActivity, accountId: string): Transaction | string | null {
  if (row.quantity === 0 || (row.symbol && CASH.has(row.symbol))) return null;
  if (!row.symbol) return 'missing-security-symbol';
  if (row.pricePerUnit === null || row.pricePerUnit <= 0) return 'missing-security-price';
  const parsed = parseDescription(row.description);
  if (parsed.parseError) return 'unsupported-option';
  const option = parsed.instrumentType === 'option';
  const symbol = captureSymbol(row.symbol);
  if (parseOccSymbol(symbol) && !option) return 'missing-option-metadata';
  if (option && parsed.symbol !== symbol) return 'option-symbol-mismatch';
  if (option && parsed.contractMultiplier !== 100) return 'unsupported-option-multiplier';
  return {
    id: randomUUID(), accountId, date: row.date, symbol, quantity: row.quantity,
    pricePerUnit: row.pricePerUnit, fees: row.fees, currency: 'USD', sourceFingerprint: row.key,
    ...(option ? { instrumentType: parsed.instrumentType, contractMultiplier: parsed.contractMultiplier,
      positionEffect: parsed.positionEffect } : {}),
  };
}

function lifecyclePair(row: FidelityActivity, account: FidelityCaptureAccount) {
  const type = activityType(row);
  if (!['exercise', 'assignment'].includes(type) || !row.symbol) return null;
  const ownOption = captureOption(row.symbol);
  const candidates = account.activity.filter(other => {
    if (!other.symbol || other === row || other.date !== row.date || activityType(other) !== type) return false;
    const optionRow = ownOption ? row : other, stockRow = ownOption ? other : row;
    const option = captureOption(optionRow.symbol!);
    if (!option || captureOption(stockRow.symbol!)) return false;
    const direction = (type === 'assignment' ? option.optionType === 'put' : option.optionType === 'call') ? 1 : -1;
    return option.underlyingSymbol === stockRow.symbol
      && Number.isInteger(optionRow.quantity) && optionRow.quantity !== 0
      && Math.sign(optionRow.quantity) === (type === 'assignment' ? 1 : -1)
      && close(stockRow.quantity, direction * Math.abs(optionRow.quantity) * 100)
      && close(optionRow.amount, -optionRow.fees, 0.02)
      && close(stockRow.amount, -stockRow.quantity * option.strikePrice - stockRow.fees, 0.02)
      && (stockRow.pricePerUnit === null || stockRow.pricePerUnit === 0 || close(stockRow.pricePerUnit, option.strikePrice));
  });
  if (candidates.length !== 1) return null;
  const optionRow = ownOption ? row : candidates[0], stockRow = ownOption ? candidates[0] : row;
  return { optionRow, stockRow, option: captureOption(optionRow.symbol!)! };
}

function lifecycleTransaction(row: FidelityActivity, account: FidelityCaptureAccount, accountId: string): Transaction | string | null {
  if (row.quantity === 0) return null;
  if (!row.symbol) return 'option-lifecycle-leg-unproven';
  const option = captureOption(row.symbol);
  const type = activityType(row);
  if (!option) {
    const pair = lifecyclePair(row, account);
    return pair ? transaction({ ...row, pricePerUnit: pair.option.strikePrice }, accountId)
      : 'option-lifecycle-leg-unproven';
  }
  const starts = [...row.description.matchAll(/\b(?:PUT|CALL)\s+\([A-Z]{1,6}\)/gi)];
  const tail = starts.at(-1)?.index;
  const parsed = tail === undefined ? null : parseDescription('YOU BOUGHT CLOSING TRANSACTION ' + row.description.slice(tail));
  if (!parsed || parsed.parseError || parsed.symbol !== option.symbol || parsed.contractMultiplier !== 100
    || !Number.isInteger(row.quantity) || row.quantity === 0
    || (row.pricePerUnit !== null && row.pricePerUnit !== 0)
    || !close(row.amount, -row.fees, 0.02)
    || (type === 'expiration' ? row.date < option.expirationDate : !lifecyclePair(row, account))) {
    return 'option-lifecycle-leg-unproven';
  }
  return { id: randomUUID(), accountId, date: row.date, symbol: option.symbol, quantity: row.quantity,
    pricePerUnit: 0, fees: row.fees, currency: 'USD', sourceFingerprint: row.key,
    instrumentType: 'option', contractMultiplier: 100, positionEffect: 'close' };
}

function nativeNetAgrees(row: FidelityActivity, tx: Transaction): boolean {
  return close(row.amount, -tx.quantity * (tx.contractMultiplier ?? 1) * tx.pricePerUnit - (tx.fees ?? 0), 0.02);
}

function bridgeRows(account: FidelityCaptureAccount, existing: Transaction[], captureDay: string, latestCashDay: string | null) {
  const stored = dropImportedSnapshotsWhereActivityExists(existing);
  const latest = [...existing.map(t => t.date), ...(latestCashDay ? [latestCashDay] : [])].sort().at(-1);
  if (!existing.length || !latest || !day(latest) || latest > captureDay) return null;
  const net = new Map<string, number>();
  for (const tx of stored) net.set(tx.symbol, (net.get(tx.symbol) ?? 0) + tx.quantity);
  // A day-only feed can prove end-of-day boundaries, never an intraday cutoff.
  const candidates = [...new Set(account.activity.map(row =>
    new Date(Date.parse(row.date) - 86400000).toISOString().slice(0, 10)))]
    .filter(date => date >= latest && date >= account.coverage.from && date < captureDay).sort().reverse();
  for (const cutoff of candidates) {
    const rows = account.activity.filter(row => row.date > cutoff);
    const rolled = new Map(account.positions.filter(p => !CASH.has(p.symbol)).map(p => [captureSymbol(p.symbol), p.quantity]));
    for (const row of rows) {
      if (row.quantity !== 0 && row.symbol && !CASH.has(row.symbol)) {
        const symbol = captureSymbol(row.symbol);
        rolled.set(symbol, (rolled.get(symbol) ?? 0) - row.quantity);
      }
    }
    if ([...new Set([...rolled.keys(), ...net.keys()])].every(symbol =>
      close(rolled.get(symbol) ?? 0, net.get(symbol) ?? 0))) return { cutoff, rows };
  }
  return null;
}

function bridgeDirectDebit(row: FidelityActivity, currency: FidelityCaptureAccount['currency']): boolean {
  return /^DIRECT DEBIT(?:\s|$)/.test(row.description.toUpperCase())
    && currency === 'USD' && row.quantity === 0 && row.fees === 0 && row.amount < 0
    && (row.symbol === null || CASH.has(row.symbol));
}

function bridgeEvidence(row: FidelityActivity, tx: Transaction | null, currency: FidelityCaptureAccount['currency']): boolean {
  const type = activityType(row);
  const text = row.description.toUpperCase();
  if (/^DIRECT DEBIT(?:\s|$)/.test(text)) {
    return bridgeDirectDebit(row, currency);
  }
  if (['assignment', 'expiration'].includes(type)) return !!tx && nativeNetAgrees(row, tx);
  if (type === 'coreSettlement') return row.fees === 0
    && /^(?:YOU BOUGHT|YOU SOLD|REINVESTMENT|REDEMPTION|PURCHASE INTO CORE|CORE PURCHASE)\b/.test(text)
    && close(row.amount, -row.quantity, 0.02);
  if (type === 'coreIncome') return row.fees === 0 && row.quantity === 0 && row.amount >= 0
    && /^(?:CASH DIVIDEND|DIVIDEND RECEIVED|INTEREST)\b/.test(text);
  if (type === 'cash') {
    return row.fees === 0 && /^(?:CASH DIVIDEND|DIVIDEND RECEIVED|INTEREST|ELECTRONIC FUNDS TRANSFER|BANK WIRE|JOURNALED CASH|CASH DEPOSIT|CASH WITHDRAWAL)\b/.test(text);
  }
  const side = /^YOU (BOUGHT|SOLD)\b/.exec(text)?.[1];
  return type === 'trade' && !!tx && !!side && Math.sign(row.quantity) === (side === 'BOUGHT' ? 1 : -1)
    && row.pricePerUnit !== null && row.pricePerUnit > 0 && nativeNetAgrees(row, tx);
}

function explainedNativeBasis(account: FidelityCaptureAccount, symbol: string, quantity: number, accountId: string): number | null {
  const rows = account.activity.filter(row => row.symbol && captureSymbol(row.symbol) === symbol && row.quantity !== 0);
  if (!rows.length || rows.some(row => rows.some(other =>
    other.date === row.date && Math.sign(other.quantity) !== Math.sign(row.quantity)))) return null;
  const transactions: Transaction[] = [];
  for (const row of rows) {
    const tx = incrementalTransaction(row, account, [], rows, accountId);
    if (!tx || typeof tx === 'string' || !nativeNetAgrees(row, tx)) return null;
    if (['exercise', 'assignment'].includes(activityType(row)) && !captureOption(row.symbol!)) {
      const pair = lifecyclePair(row, account);
      if (!pair) return null;
      const openingRows = account.activity.filter(other => other.symbol && other.key !== pair.optionRow.key
        && captureSymbol(other.symbol) === pair.option.symbol && other.date <= row.date);
      const openings = openingRows.map(other => incrementalTransaction(other, account, [], openingRows, accountId));
      if (openings.length !== 1 || !openings[0] || typeof openings[0] === 'string'
        || openings[0].positionEffect !== 'open' || !close(openings[0].quantity, -pair.optionRow.quantity)
        || !nativeNetAgrees(openingRows[0], openings[0])) return null;
      const premium = aggregatePositions([openings[0]])[0]?.costBasis;
      if (!finite(premium) || tx.quantity <= 0) return null;
      // Basis-only replay of native consideration; the imported execution price remains the strike.
      tx.pricePerUnit += premium / tx.quantity;
      if (tx.pricePerUnit < 0) return null;
    }
    transactions.push(tx);
  }
  try {
    const position = aggregatePositions(transactions).find(p => p.symbol === symbol);
    return position && close(position.quantity, quantity) && finite(position.costBasis) ? position.costBasis : null;
  } catch { return null; }
}

/**
 * Caller owns authentication and owner-approved private bindings. No network or live
 * database discovery. Backup directory must be private, existing, and writable.
 */
export async function importFidelityInvesting(
  state: SqliteStateRepo,
  captureInput: unknown,
  policyInput: unknown,
  options: { backupDirectory: string; now?: () => Date; transport?: FidelityTransportAudit; mode?: 'incremental' | 'full-backfill' },
): Promise<FidelityImportReceipt> {
  validateFidelityInvestingInput(captureInput, policyInput);
  // Detach caller-owned objects before the asynchronous backup.
  const capture: FidelityInvestingCapture = JSON.parse(JSON.stringify(captureInput));
  const policy: FidelityInvestingPolicy = JSON.parse(JSON.stringify(policyInput));
  const incremental = options.mode !== 'full-backfill';
  validateFidelityInvestingInput(capture, policy);
  const transport = options.transport && { ...options.transport };
  if (transport) {
    object(transport, ['jobId', 'heldSources', 'heldActivity', 'cancelled', 'boundaryRows']);
    if (!KEY.test(transport.jobId) || [transport.heldSources, transport.heldActivity, transport.cancelled, transport.boundaryRows]
      .some(n => !Number.isSafeInteger(n) || n < 0)) refuse();
  }
  if (capture.accounts.length === 0 && !transport?.heldSources) refuse();
  const now = (options.now ?? (() => new Date()))();
  const capturedAt = new Date(capture.capturedAt).toISOString();
  if (Date.parse(capturedAt) > now.getTime() + 60_000 || now.getTime() - Date.parse(capturedAt) > 24 * 60 * 60_000) {
    throw new HoldrRefusal('fidelity capture is stale or future dated');
  }
  const db = state.internalGetDb();
  if (db.inTransaction) throw new HoldrRefusal('fidelity import requires an independent transaction');
  const digest = hash(capture);
  const policyDigest = hash(policy);
  const version = (): string => JSON.stringify([db.pragma('data_version', { simple: true }),
    db.prepare('SELECT total_changes()').pluck().get()]);
  const before = version();
  try {
    const backup = path.join(options.backupDirectory, `fidelity-investing-${randomUUID()}.sqlite`);
    closeSync(openSync(backup, 'wx', 0o600));
    await db.backup(backup);
    return db.transaction(() => {
      if (version() !== before) throw new HoldrRefusal('fidelity database changed during backup; retry import');
      db.exec(SCHEMA);
      const columns = (table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map(c => c.name);
      if (!['previous_cash_balance', 'baseline_cash_adopted', 'baseline_at', 'baseline_digest']
        .every(name => columns('fidelity_investing_incremental').includes(name))) {
        throw new HoldrRefusal('fidelity incremental schema requires reviewed migration');
      }
      if (!columns('fidelity_investing_sources').includes('applied_at')) {
        // An older importer did not record write provenance. Never guess it.
        db.exec("ALTER TABLE fidelity_investing_sources ADD COLUMN applied_at TEXT NOT NULL DEFAULT ''");
      }
      for (const name of ['job_id', 'transport_json']) {
        if (!columns('fidelity_investing_receipts').includes(name)) db.exec(`ALTER TABLE fidelity_investing_receipts ADD COLUMN ${name} TEXT`);
      }
      const receipt: FidelityImportReceipt = { receiptId: randomUUID(), captureDigest: digest, accounts: [] };
      for (const account of capture.accounts) {
        const result: FidelityImportAccountResult = {
          last4: account.last4, status: 'held', added: 0, rekeyed: 0, duplicates: 0, audited: 0,
        };
        receipt.accounts.push(result);
        if (policy.ignoredSources.includes(account.sourceId)) { result.status = 'ignored'; continue; }
        const binding = policy.bindings.find(b => b.sourceId === account.sourceId);
        const target = binding && state.getAccount(binding.accountId);
        if (!binding || binding.last4 !== account.last4 || !target || target.currency !== account.currency
          || (target.accountNumber && !target.accountNumber.endsWith(account.last4))) {
          result.reason = 'explicit-account-binding-required'; continue;
        }
        const previous = db.prepare('SELECT account_id, captured_at, capture_digest, applied_at FROM fidelity_investing_sources WHERE source_id = ?')
          .get(account.sourceId) as { account_id: string; captured_at: string; capture_digest: string; applied_at: string } | undefined;
        const other = db.prepare('SELECT source_id FROM fidelity_investing_sources WHERE account_id = ?').get(target.id) as { source_id: string } | undefined;
        if ((previous && previous.account_id !== target.id) || (other && other.source_id !== account.sourceId)) {
          result.reason = 'source-binding-conflict'; continue;
        }
        if (previous && (capturedAt < previous.captured_at
          || (capturedAt === previous.captured_at && previous.capture_digest !== digest))) {
          result.reason = 'stale-or-conflicting-capture'; continue;
        }
        const existing = state.listTransactions(target.id);
        const observedCash = account.cashBalance + (account.pendingBalance ?? 0);
        if (!finite(observedCash)) { result.reason = 'invalid-snapshot-basis'; continue; }
        const cursor = db.prepare('SELECT cutoff_day, ledger_digest, cash_balance FROM fidelity_investing_incremental WHERE source_id = ?')
          .get(account.sourceId) as { cutoff_day: string; ledger_digest: string; cash_balance: number } | undefined;
        if (!incremental && cursor) { result.reason = 'incremental-source-requires-separate-migration'; continue; }
        let baselineDay = '';
        let provenCash = target.cashBalance;
        let eligible = account.activity;
        let bridged = false;
        let bridgeCashDelta = 0;
        let baselineCashAdopted = target.cashBalance !== observedCash;
        const establishingBaseline = incremental && !cursor && !previous;
        if (incremental) {
          result.activityTypes = {};
          for (const row of account.activity) {
            const type = activityType(row);
            result.activityTypes[type] = (result.activityTypes[type] ?? 0) + 1;
          }
          const captureDay = marketDate(new Date(capturedAt));
          baselineDay = cursor?.cutoff_day ?? captureDay;
          if (cursor) {
            if (cursor.ledger_digest !== hash(existing)) { result.reason = 'incremental-ledger-changed'; continue; }
            if (!close(target.cashBalance, cursor.cash_balance, 0.005)) { result.reason = 'incremental-cash-changed'; continue; }
            provenCash = cursor.cash_balance;
          } else if (previous) { result.reason = 'existing-source-requires-reviewed-cutoff'; continue; }
          if ((previous && account.coverage.from > marketDate(new Date(previous.captured_at)))
            || account.coverage.to < captureDay) {
            result.reason = 'incomplete-incremental-coverage'; continue;
          }
          // Owner-approved capture-time baseline: all observed keys are covered,
          // including the boundary day, without reconstructing legacy history.
          eligible = establishingBaseline ? [] : account.activity;
          if (establishingBaseline) {
            const stored = new Map<string, number>();
            for (const tx of dropImportedSnapshotsWhereActivityExists(existing)) {
              stored.set(tx.symbol, (stored.get(tx.symbol) ?? 0) + tx.quantity);
            }
            const native = new Map(account.positions.filter(p => !CASH.has(p.symbol)).map(p => [captureSymbol(p.symbol), p.quantity]));
            if ([...new Set([...stored.keys(), ...native.keys()])].some(symbol =>
              !close(stored.get(symbol) ?? 0, native.get(symbol) ?? 0))) {
              const latestCashDay = db.prepare(`SELECT MAX(activity_day) FROM (
                SELECT event_date AS activity_day FROM account_cash_events WHERE account_id = ?
                UNION ALL SELECT as_of_date FROM account_cash_history WHERE account_id = ?
              )`).pluck().get(target.id, target.id) as string | null;
              const bridge = bridgeRows(account, existing, captureDay, latestCashDay);
              if (!bridge) { result.reason = 'baseline-holdings-mismatch'; continue; }
              if (account.pendingBalance === undefined || account.positions.some(p => p.marketValue === undefined)
                || bridge.rows.some(row => row.date > captureDay)) {
                result.reason = 'bridged-baseline-evidence-unproven'; continue;
              }
              bridged = true; baselineDay = bridge.cutoff; eligible = bridge.rows;
            }
          }
        }
        if (!incremental && existing.some(t => t.sourceFingerprint?.startsWith('pos:')
          || (!t.sourceFingerprint && /^imported/i.test(t.notes ?? '')))) {
          result.reason = 'synthetic-baseline-requires-reviewed-migration'; continue;
        }
        const planned: { row: FidelityActivity; tx: Transaction; legacy?: Transaction }[] = [];
        const claimed = new Set<string>();
        const auditRows = db.prepare('SELECT activity_key, content_digest, kind FROM fidelity_investing_activity WHERE source_id = ?')
          .all(account.sourceId) as { activity_key: string; content_digest: string; kind: string }[];
        const known = new Map(auditRows.map(r => [r.activity_key, r.content_digest]));
        const covered = new Set(auditRows.filter(r => r.kind === 'baseline-covered').map(r => r.activity_key));
        const aliases = new Map((db.prepare(`SELECT activity_key, canonical_key FROM fidelity_investing_activity_aliases
          WHERE source_id = ?`).all(account.sourceId) as { activity_key: string; canonical_key: string }[])
          .map(r => [r.activity_key, r.canonical_key]));
        const newAliases = new Map<string, { canonicalKey: string; kind: string; contentDigest: string }>();
        const priorBridge = db.prepare('SELECT cutoff_day FROM fidelity_investing_bridges WHERE source_id = ?')
          .get(account.sourceId) as { cutoff_day: string } | undefined;
        for (const row of account.activity) {
          if (known.has(row.key) && known.get(row.key) !== hash(row)) { result.reason = 'activity-key-content-conflict'; break; }
        }
        if (incremental && !result.reason) {
          const canonicalRows = auditRows.filter(r => !aliases.has(r.activity_key));
          const incomingKeys = new Set(account.activity.map(r => r.key));
          const identities = new Set<string>();
          for (const row of account.activity) {
            let canonicalKey = aliases.get(row.key) ?? row.key;
            if (!known.has(row.key)) {
              // Substitute ONLY the audited key: every other field must reproduce its immutable digest.
              const candidates = canonicalRows.filter(r => r.content_digest === hash({ ...row, key: r.activity_key }));
              if (candidates.length > 1 || (candidates.length === 1 && incomingKeys.has(candidates[0].activity_key))) {
                result.reason = 'activity-key-content-conflict'; break;
              }
              if (candidates.length === 1) {
                canonicalKey = candidates[0].activity_key;
                newAliases.set(row.key, { canonicalKey, kind: candidates[0].kind, contentDigest: hash(row) });
              }
            }
            // Old/new coappearance or multiple new keys cannot consume one audited identity twice.
            if (identities.has(canonicalKey)) { result.reason = 'activity-key-content-conflict'; break; }
            identities.add(canonicalKey);
          }
          for (const [key, alias] of newAliases) {
            aliases.set(key, alias.canonicalKey);
            known.set(key, alias.contentDigest);
          }
          for (const [aliasKey, canonicalKey] of aliases) {
            if (covered.has(canonicalKey)) covered.add(aliasKey);
          }
        }
        for (const row of eligible) {
          if (result.reason) break;
          if (priorBridge && !known.has(row.key) && row.date <= priorBridge.cutoff_day) {
            result.reason = 'bridged-baseline-overlap'; break;
          }
          // Reuse a previously proven basis rule on replay; re-deriving a quantity-only
          // event against today's holdings would turn a safe retry into a new guess.
          const keyed = existing.find(t => t.sourceFingerprint === (incremental ? aliases.get(row.key) ?? row.key : row.key));
          if (incremental && known.has(row.key)) {
            if (!covered.has(row.key) && row.quantity !== 0 && row.symbol && !CASH.has(row.symbol)) {
              if (!keyed) { result.reason = 'ledger-key-content-conflict'; break; }
              claimed.add(keyed.id); result.duplicates++;
            }
            continue;
          }
          const tx = incremental ? incrementalTransaction(row, account, existing, eligible.filter(r => !known.has(r.key)), target.id)
            : ['exercise', 'assignment', 'expiration'].includes(activityType(row))
              ? lifecycleTransaction(row, account, target.id) : transaction(row, target.id);
          if (typeof tx === 'string') { result.reason = tx; break; }
          if (bridged && !bridgeEvidence(row, tx, account.currency)) { result.reason = 'bridged-baseline-evidence-unproven'; break; }
          if (!tx) continue;
          if (keyed) {
            if (economic(keyed) !== economic(tx)) { result.reason = 'ledger-key-content-conflict'; break; }
            claimed.add(keyed.id); result.duplicates++; continue;
          }
          // Reconstruct legacy provenance, not merely a hash-shaped or manual economic match.
          const legacy = !incremental ? existing.find(t => !claimed.has(t.id)
            && !account.activity.some(r => r.key === t.sourceFingerprint)
            && !known.has(t.sourceFingerprint ?? '') && economic(t) === economic(tx)
            && provenLegacy(row, account.last4, t)) : undefined;
          if (legacy) claimed.add(legacy.id);
          planned.push({ row, tx, legacy });
        }
        if (!incremental && !result.reason && existing.some(t => t.date >= account.coverage.from && t.date <= account.coverage.to && !claimed.has(t.id))) {
          result.reason = 'unmatched-existing-activity-in-coverage';
        }
        if (result.reason) { result.duplicates = 0; continue; }
        const projected = [...existing, ...planned.filter(p => !p.legacy).map(p => p.tx)];
        const net = new Map<string, number>();
        for (const t of incremental ? dropImportedSnapshotsWhereActivityExists(projected) : projected) {
          net.set(t.symbol, (net.get(t.symbol) ?? 0) + t.quantity);
        }
        const expected = new Map(account.positions.filter(p => !CASH.has(p.symbol)).map(p => [captureSymbol(p.symbol), p.quantity]));
        if (incremental && cursor && [...net].some(([symbol, quantity]) =>
          !close(quantity, 0) && close(expected.get(symbol) ?? 0, 0))) {
          result.reason = 'closed-position-activity-unproven'; result.duplicates = 0; continue;
        }
        if (incremental) {
          const visible = new Set(dropImportedSnapshotsWhereActivityExists(projected).map(t => t.id));
          if (dropImportedSnapshotsWhereActivityExists(existing).some(t => !visible.has(t.id))) {
            result.reason = 'incremental-baseline-would-be-hidden'; result.duplicates = 0; continue;
          }
          let cashDelta = 0;
          for (const row of eligible.filter(row => !known.has(row.key))) {
            const impact = bridged && bridgeDirectDebit(row, account.currency) ? row.amount : cashImpact(row);
            if (typeof impact === 'string') { result.reason = impact; break; }
            cashDelta += impact;
          }
          if (result.reason) { result.duplicates = 0; continue; }
          if (!establishingBaseline && (!finite(cashDelta) || !close(provenCash + cashDelta, observedCash, 0.02))) {
            result.reason = 'projected-cash-mismatch'; result.duplicates = 0; continue;
          }
          if (bridged) {
            if (!finite(cashDelta) || !finite(provenCash + cashDelta)) {
              result.reason = 'projected-cash-mismatch'; result.duplicates = 0; continue;
            }
            bridgeCashDelta = cashDelta;
            baselineCashAdopted = !close(provenCash + cashDelta, observedCash, 0.02);
          }
        }
        // The v1 contract has no execution time/order guarantee within a calendar day.
        if (planned.some(p => !p.legacy && projected.some(t => t.symbol === p.tx.symbol
          && t.date === p.tx.date && Math.sign(t.quantity) !== Math.sign(p.tx.quantity)))) {
          result.reason = 'same-day-execution-order-unproven'; result.duplicates = 0; continue;
        }
        if ([...new Set([...net.keys(), ...expected.keys()])].some(s => !close(net.get(s) ?? 0, expected.get(s) ?? 0))
          || [...expected].some(([s, q]) => q < 0 && !parseOccSymbol(s))) {
          result.reason = establishingBaseline ? 'baseline-holdings-mismatch' : 'projected-holdings-mismatch'; result.duplicates = 0; continue;
        }
        let positions: ReturnType<typeof aggregatePositions>;
        try { positions = aggregatePositions(projected); }
        catch { result.reason = 'invalid-projected-ledger'; result.duplicates = 0; continue; }
        if ([...expected].some(([s, q]) => !close(positions.find(p => p.symbol === s)?.quantity ?? 0, q))
          || positions.some(p => !finite(p.costBasis) || !finite(p.averageCost))) {
          result.reason = 'invalid-projected-ledger'; result.duplicates = 0; continue;
        }
        const observedValue = observedCash + account.positions.filter(p => !CASH.has(p.symbol))
          // Fidelity's native row valuation need not equal quantity times the displayed last quote.
          .reduce((n, p) => n + (p.marketValue ?? p.quantity * p.pricePerUnit * (captureOption(p.symbol) ? 100 : 1)), 0);
        if (!finite(observedValue) || !close(observedValue, account.totalValue, 0.02)) {
          result.reason = 'snapshot-total-mismatch'; result.duplicates = 0; continue;
        }
        const snapshot = db.prepare('SELECT market_value, cost_basis, cash_balance FROM account_snapshots WHERE account_id = ? AND taken_at = ?')
          .get(target.id, capturedAt) as { market_value: number; cost_basis: number; cash_balance: number } | undefined;
        let basis = observedCash;
        for (const position of account.positions.filter(p => !CASH.has(p.symbol))) {
          const value = position.costBasis ?? explainedNativeBasis(account, captureSymbol(position.symbol), position.quantity, target.id);
          if (value === null) {
            result.reason = account.activity.some(row => row.symbol === position.symbol
              && ['exercise', 'assignment'].includes(activityType(row)))
              ? 'option-lifecycle-basis-unproven' : 'unknown-position-basis-unproven';
            break;
          }
          basis += value;
        }
        if (result.reason) { result.duplicates = 0; continue; }
        if (!finite(basis)) { result.reason = 'invalid-snapshot-basis'; result.duplicates = 0; continue; }
        // Only the job's exact writer identity proves a derived valuation; unknown rows still block.
        const newerSnapshot = db.prepare(`SELECT 1 FROM account_snapshots
          WHERE account_id = ? AND taken_at > ?
            AND id IS NOT ('snap-' || account_id || '-' || taken_at)
          LIMIT 1`)
          .get(target.id, capturedAt);
        if (newerSnapshot && (!previous || previous.capture_digest !== digest)) {
          result.reason = 'newer-account-observation-exists'; result.duplicates = 0; continue;
        }
        const updatedAt = db.prepare('SELECT updated_at FROM accounts WHERE id = ?').pluck().get(target.id) as string;
        const previousSnapshot = previous && db.prepare('SELECT cash_balance FROM account_snapshots WHERE account_id = ? AND taken_at = ?')
          .get(target.id, previous.captured_at) as { cash_balance: number } | undefined;
        const lastWriteWasOurs = previous && updatedAt === previous.applied_at
          && previousSnapshot && target.cashBalance === previousSnapshot.cash_balance;
        if (previous?.capture_digest !== digest && target.cashBalance !== observedCash
          && (!Number.isFinite(Date.parse(updatedAt)) || (Date.parse(updatedAt) > Date.parse(capturedAt) && !lastWriteWasOurs))) {
          result.reason = 'newer-account-change-exists'; result.duplicates = 0; continue;
        }
        if (snapshot && (!close(snapshot.market_value, account.totalValue) || !close(snapshot.cost_basis, basis) || !close(snapshot.cash_balance, observedCash))) {
          result.reason = 'existing-snapshot-conflict'; result.duplicates = 0; continue;
        }
        for (const p of planned) {
          if (p.legacy) {
            db.prepare('UPDATE transactions SET source_fingerprint = ?, updated_at = ? WHERE id = ?')
              .run(p.row.key, now.toISOString(), p.legacy.id);
            result.rekeyed++;
          } else {
            const t = p.tx;
            db.prepare(`INSERT INTO transactions (id, account_id, symbol, date, quantity, price_per_unit,
              instrument_type, contract_multiplier, position_effect, fees, currency, sort_order, source_fingerprint)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM transactions), ?)`)
              .run(t.id, t.accountId, t.symbol, t.date, t.quantity, t.pricePerUnit, t.instrumentType ?? null,
                t.contractMultiplier ?? null, t.positionEffect ?? null, t.fees, t.currency, p.row.key);
            result.added++;
          }
        }
        if (result.added) {
          db.prepare(`INSERT INTO account_history_invalidations (account_id, effective_date, detected_at, reason)
            VALUES (?, ?, ?, 'fidelity investing activity imported')
            ON CONFLICT(account_id, effective_date, detected_at, reason) DO NOTHING`)
            .run(target.id, planned.filter(p => !p.legacy).map(p => p.tx.date).sort()[0], now.toISOString());
        }
        db.prepare(`INSERT INTO fidelity_investing_sources VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(source_id) DO UPDATE SET captured_at = excluded.captured_at,
          capture_digest = excluded.capture_digest, applied_at = excluded.applied_at`)
          .run(account.sourceId, target.id, capturedAt, digest,
            previous?.capture_digest === digest ? previous.applied_at : now.toISOString());
        if (incremental) {
          db.prepare(`INSERT INTO fidelity_investing_incremental VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id) DO UPDATE SET ledger_digest = excluded.ledger_digest, cash_balance = excluded.cash_balance`)
            .run(account.sourceId, baselineDay, hash(state.listTransactions(target.id)), observedCash,
              target.cashBalance, Number(baselineCashAdopted), capturedAt, digest);
          if (establishingBaseline) {
            result.baseline = true;
            result.baselineCashAdoption = baselineCashAdopted;
            if (bridged) {
              result.bridgedBaseline = true;
              result.bridgedRowCount = eligible.length;
              db.prepare('INSERT INTO fidelity_investing_bridges VALUES (?, ?, ?, ?, ?)')
                .run(account.sourceId, baselineDay, eligible.length, bridgeCashDelta, Number(baselineCashAdopted));
            }
          }
        }
        for (const row of account.activity) {
          result.audited += db.prepare('INSERT OR IGNORE INTO fidelity_investing_activity VALUES (?, ?, ?, ?)')
            .run(account.sourceId, row.key, hash(row),
              newAliases.get(row.key)?.kind
                ?? (establishingBaseline && (!bridged || row.date <= baselineDay) ? 'baseline-covered'
                : row.quantity !== 0 && row.symbol && !CASH.has(row.symbol) ? 'security' : 'cash-or-nonsecurity')).changes;
        }
        for (const [key, alias] of newAliases) {
          db.prepare('INSERT INTO fidelity_investing_activity_aliases VALUES (?, ?, ?)')
            .run(account.sourceId, key, alias.canonicalKey);
        }
        // Cash and non-security movements are audited, not guessed into trade or cash-event types.
        if (!previous || previous.capture_digest !== digest) {
          db.prepare('UPDATE accounts SET cash_balance = ?, updated_at = ? WHERE id = ?')
            .run(observedCash, now.toISOString(), target.id);
          if (!close(target.cashBalance, observedCash, FIDELITY_CASH_ADOPTION_TOLERANCE)) {
            // Adopting the broker's cash corrects Holdr's figure; it is not a market move. The account's
            // snapshots since its last observation before the capture become captured-before-sync context.
            db.prepare(`INSERT INTO account_history_invalidations (account_id, effective_date, detected_at, reason)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(account_id, effective_date, detected_at, reason) DO NOTHING`)
              .run(target.id, cashAdoptionEffectiveDate(db, target.id, capturedAt), now.toISOString(), FIDELITY_CASH_ADOPTED_REASON);
          }
          createSnapshotRepo(state).insertAccountSnapshots([{
            id: randomUUID(), accountId: target.id, takenAt: capturedAt,
            marketValue: account.totalValue, costBasis: basis, cashBalance: observedCash,
          }]);
        }
        // One row per account/market day: preserve the first observation, including legacy history.
        db.prepare(`INSERT INTO account_cash_history
          (account_id, as_of_date, cash_balance, currency, broker, account_last4, source_hash, method)
          VALUES (?, ?, ?, ?, 'fidelity', ?, ?, 'fidelity-capture')
          ON CONFLICT(account_id, as_of_date) DO NOTHING`)
          .run(target.id, marketDate(new Date(capturedAt)), observedCash, account.currency, account.last4, digest);
        result.status = 'applied';
      }
      db.prepare('INSERT INTO fidelity_investing_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(receipt.receiptId, digest, policyDigest, capturedAt, now.toISOString(), JSON.stringify(receipt.accounts),
          transport?.jobId ?? null, transport ? JSON.stringify(transport) : null);
      return receipt;
    }).immediate();
  } catch (error) {
    throw toValueFreeDbError('fidelity investing import', error);
  }
}
