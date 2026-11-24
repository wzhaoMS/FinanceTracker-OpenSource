import type { Database as DB } from 'better-sqlite3';
import {
  aggregatePositions, dropImportedSnapshotsWhereActivityExists, parseOccSymbol, positionMarketValue,
  type Position, type Transaction,
} from '@finance-tracker/shared';

import {
  CNBC_CHART_SOURCE, CNBC_WEEK_CHART_SOURCE, INTRADAY_CHART_SOURCES, NASDAQ_CHART_SOURCE,
  newYorkWallClock, newYorkWallClockToInstant,
  type IntradayBar, type IntradayBarFetcher,
} from '../providers/intradayBars.js';
import { errorTypeAndCode } from './dbErrors.js';
import { marketDate } from './symbolHistory.js';

/**
 * The 1D and 1W lines computed the way brokers draw them: at every step, the holdings at that
 * step's market prices plus cash. Prices are the snapshot job's own recorded quotes at its ticks and
 * public chart prices between them, each carried forward until the next.
 *
 * 1D values the latest session at today's holdings and cash. Trade times are not recorded, so
 * activity dated the session counts from its start, and the line's change is price movement alone.
 *
 * 1W values each of up to five sessions at that day's holdings and cash: today's, walked back day by
 * day through the ledger and the recorded cash events dated after it. A trade is netted at its price
 * (quantity × price × multiplier + fees), so neither trades nor cash corrections, adoptions or first
 * syncs make a step, while a recorded deposit or withdrawal steps the value at its day's open.
 *
 * The recorded snapshots only check the line (see portfolioHistory).
 */

/** The snapshot job's tick, so the line and the recorded snapshots meet at every tick. */
export const COMPUTED_STEP_MINUTES = 5;
/** 1W: a point every ten minutes, still on the job's grid. */
export const WEEK_STEP_MINUTES = 10;
/** 1W: the newest sessions on the line, today's included. */
export const WEEK_SESSIONS = 5;
const STEP_MS = COMPUTED_STEP_MINUTES * 60_000;
const REGULAR_OPEN_MINUTE = 9 * 60 + 30;
const REGULAR_CLOSE_MINUTE = 16 * 60;
const EXTENDED_OPEN_MINUTE = 4 * 60;
const EXTENDED_CLOSE_MINUTE = 20 * 60;
/** During regular hours, a price older than this is carried forward rather than current. */
export const STALE_PRICE_MS = 30 * 60_000;
/** A point is estimated when holdings worth more than this share of its value are on such prices. */
export const STALE_VALUE_SHARE = 0.01;
const LOOKBACK_DAYS = 10;
const FETCH_RETRY_MS = 5 * 60_000;
const FETCH_CONCURRENCY = 6;
const FETCH_WAIT_MS = 6_000;
/** US mutual fund tickers: five letters ending in X. Priced once a day at their NAV. */
const FUND_SYMBOL = /^[A-Z]{4}X$/;
const CRYPTO_SYMBOL = /^[A-Z]{2,6}-USD$/;
/** Cash events that are investment income, as the ledger's returns count them; every other kind is money moved. */
export const INCOME_EVENT_TYPES: ReadonlySet<string> = new Set(['dividend', 'interest', 'fee']);

export interface IntradayValuationInput {
  db: DB;
  /** In-scope accounts; undefined or empty for the household. */
  accountIds?: string[];
  now: Date;
  /** Fetches a public symbol's latest session of chart bars. Without it only stored prices are used and nothing is written. */
  fetchBars?: IntradayBarFetcher;
  /** 1W: fetches a public symbol's last five sessions of chart bars, for the ticks past sessions missed. */
  fetchWeekBars?: IntradayBarFetcher;
  /** Daily closes (NAVs for funds) of a symbol between two dates, ascending. */
  dailyCloses?: (symbol: string, from: string, to: string) => Array<{ t: string; close: number }>;
  /** Manual price overrides of a symbol. */
  manualPrices?: (symbol: string) => Array<{ date: string; close: number }>;
  /**
   * 1W: up to five sessions from this New York date on, every ten minutes, each day at its own
   * holdings and cash. Unset for 1D: the latest session every five minutes, at today's.
   */
  week?: { from: string };
}

export interface ComputedPoint {
  /** ISO instant on the 5-minute grid (10-minute for 1W). */
  t: string;
  value: number;
  costBasis: number;
  cashBalance: number;
  /** Holdings worth over 1% of the value were on a price more than 30 minutes old during regular
   *  hours, or had no price at all. */
  estimated?: boolean;
  /** 1W, at a session's first point: money moved since the previous session by recorded cash events
   *  (deposits, withdrawals, transfers, taxes). It steps the value but is not return. */
  flow?: number;
}

export interface IntradayValuation {
  /** The newest session on the line. */
  sessionDate: string;
  /** Every session on the line, oldest first: one for 1D, up to five for 1W. */
  sessions: string[];
  /** Every account valued: all of them must be in a recorded snapshot that checks the line. */
  accountIds: string[];
  /** The span on the x-axis: for 1D, the session, 9:30 AM to 4:00 PM ET at least, from 4:00 AM or to
   *  8:00 PM where prices exist. */
  window: { from: string; to: string };
  points: ComputedPoint[];
  /** The latest change to any in-scope account's ledger, cash or history (ms); recorded snapshots
   *  taken before it hold older figures and cannot check the line. Null when none is known. */
  lastChange: number | null;
  /** Activity dated the newest session day or later, counted from its start. */
  activityOnSession: boolean;
  /** Holdings that had no price at some point and were left out there. */
  unpricedSymbols: number;
  optionPositions: number;
  fundPositions: number;
  /** 1W: share transactions after the first session, netted at their price as if paid from cash. */
  nettedTransactions: number;
  /** 1W: recorded deposits, withdrawals, transfers and taxes after the first session. */
  recordedFlows: number;
  /** 1W: in-scope accounts synced from Fidelity, whose dividends and deposits have no event records. */
  syncedAccounts: number;
}

interface Observation {
  at: number;
  price: number;
  /** At the same instant the lower rank wins (SOURCE_RANK and the ranks after it). */
  rank: number;
}

/**
 * The precedence at one instant: the snapshot job's recorded quote, Nasdaq's 1-minute bar, CNBC's
 * 1-minute bar, CNBC's 5-minute bar, then an owner's price, a daily close, a trade price.
 */
const SOURCE_RANK: Readonly<Record<string, number>> = {
  [NASDAQ_CHART_SOURCE]: 1,
  [CNBC_CHART_SOURCE]: 2,
  [CNBC_WEEK_CHART_SOURCE]: 3,
};
const MANUAL_RANK = 4;
const DAILY_RANK = 5;
const TRADE_RANK = 6;
/** Every source not a chart's is the snapshot job's recorded quote. */
const sourceRank = (source: string) => SOURCE_RANK[source] ?? 0;

/**
 * The chart bars a session reads. The newest session (1D's, and 1W's newest) reads that session's
 * 1-minute bars, which its own refresh fetches; an earlier 1W session reads CNBC's 5-minute bars,
 * which 1W's refresh fetches. Neither reads the other's: a past day's 1-minute bars exist only if
 * 1D was looked at that day, and the newest session's 5-minute bars only as far as the last 1W
 * fetch, so either would make a line depend on which range was looked at first.
 */
const SESSION_CHART_SOURCES: readonly string[] = [NASDAQ_CHART_SOURCE, CNBC_CHART_SOURCE];
const WEEK_CHART_SOURCES: readonly string[] = [CNBC_WEEK_CHART_SOURCE];
type SessionKind = 'session' | 'week';
const chartSourcesOf = (kind: SessionKind) => (kind === 'session' ? SESSION_CHART_SOURCES : WEEK_CHART_SOURCES);
/** The chart sources a session of this kind never reads. */
const otherChartSources = (kind: SessionKind) => INTRADAY_CHART_SOURCES.filter((source) => !chartSourcesOf(kind).includes(source));

/** The instant New York's clock reads `minute` minutes after midnight on `day` (YYYY-MM-DD). */
export function newYorkInstant(day: string, minute: number): number {
  const [year, month, date] = day.split('-').map(Number);
  const instant = newYorkWallClockToInstant(Date.UTC(year, month - 1, date) + minute * 60_000);
  if (instant === null) throw new Error('no such New York time');
  return instant;
}

function newYorkMinute(instant: number): number {
  return Math.floor((((newYorkWallClock(instant) % 86_400_000) + 86_400_000) % 86_400_000) / 60_000);
}

function isWeekday(day: string): boolean {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function daysBefore(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function previousWeekday(day: string): string {
  let candidate = daysBefore(day, 1);
  while (!isWeekday(candidate)) candidate = daysBefore(candidate, 1);
  return candidate;
}

const floorTo = (instant: number, stepMs: number) => instant - (((instant % stepMs) + stepMs) % stepMs);
const floorStep = (instant: number) => floorTo(instant, STEP_MS);
const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(',');

/** Symbols a public chart can price: not options, crypto pairs or mutual funds. */
function chartSymbol(symbol: string): boolean {
  return !parseOccSymbol(symbol) && !CRYPTO_SYMBOL.test(symbol) && !FUND_SYMBOL.test(symbol);
}

/** A position pull ("pos:") or a legacy "imported" row: holdings that existed before Holdr tracked them. */
function isPositionSnapshot(transaction: Transaction): boolean {
  if (transaction.sourceFingerprint) return transaction.sourceFingerprint.startsWith('pos:');
  return typeof transaction.notes === 'string' && /^imported\b/i.test(transaction.notes);
}

/** The cash a trade moved: quantity × price × multiplier, plus fees, out of cash for a purchase. */
export function tradeCash(transaction: Transaction): number {
  const multiplier = transaction.instrumentType === 'option' ? transaction.contractMultiplier ?? 100 : 1;
  return -(transaction.quantity * transaction.pricePerUnit * multiplier) - (transaction.fees ?? 0);
}

interface TxRow {
  id: string; account_id: string; symbol: string; date: string; quantity: number; price_per_unit: number;
  fees: number | null; currency: string; instrument_type: string | null; contract_multiplier: number | null;
  position_effect: string | null; notes: string | null; source_fingerprint: string | null;
}

/** The ledger exactly as the snapshot job reads it, so both count the same positions. */
function loadTransactions(db: DB, accountIds: string[]): Transaction[] {
  const rows = db.prepare(
    `SELECT id, account_id, symbol, date, quantity, price_per_unit, fees, currency,
            instrument_type, contract_multiplier, position_effect, notes, source_fingerprint
       FROM transactions WHERE account_id IN (${placeholders(accountIds)})`,
  ).all(...accountIds) as TxRow[];
  return rows.map((row) => ({
    id: row.id, accountId: row.account_id, symbol: row.symbol, date: row.date,
    quantity: row.quantity, pricePerUnit: row.price_per_unit,
    ...(row.instrument_type === 'option'
      ? {
          instrumentType: 'option' as const,
          contractMultiplier: row.contract_multiplier ?? undefined,
          positionEffect: row.position_effect === 'open' || row.position_effect === 'close' ? row.position_effect : undefined,
        }
      : {}),
    fees: row.fees ?? undefined, currency: row.currency,
    ...(row.source_fingerprint ? { sourceFingerprint: row.source_fingerprint } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
  }));
}

interface ChartFetchState {
  /** Per kind of fetch and symbol: its latest attempt, and when its latest answer arrived. */
  symbols: Map<string, { attemptAt: number; coveredThrough: number }>;
  /** Fetches waiting or running, shared by every request on this database. */
  inFlight: Map<string, Promise<void>>;
  active: number;
  waiting: Array<() => void>;
}

const fetchStates = new WeakMap<DB, ChartFetchState>();

function fetchStateOf(db: DB): ChartFetchState {
  let state = fetchStates.get(db);
  if (!state) fetchStates.set(db, state = { symbols: new Map(), inFlight: new Map(), active: 0, waiting: [] });
  return state;
}

/** At most FETCH_CONCURRENCY fetches run at once, across every request on the database. */
function acquireFetchSlot(state: ChartFetchState): Promise<void> {
  if (state.active < FETCH_CONCURRENCY) {
    state.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => state.waiting.push(resolve));
}

function releaseFetchSlot(state: ChartFetchState): void {
  const next = state.waiting.shift();
  // The slot passes straight to the next fetch in line.
  if (next) next();
  else state.active -= 1;
}

/**
 * Starts fetching chart bars for symbols whose recorded quotes have holes on any of `days` (ticks
 * the snapshot job missed) that no stored chart bar of the kind those days read covers yet, and
 * returns this request's fetches, its own or another request's. At most one attempt per kind and
 * symbol every five minutes, shared by concurrent requests.
 */
function startChartRefresh(
  db: DB,
  fetchBars: IntradayBarFetcher,
  kind: SessionKind,
  symbols: string[],
  days: string[],
  now: number,
): Array<Promise<void>> {
  // The job's first tick is 4:05 AM; the newest tick may still be on its way.
  const spans = days
    .map((day) => ({
      day,
      open: newYorkInstant(day, EXTENDED_OPEN_MINUTE),
      close: newYorkInstant(day, EXTENDED_CLOSE_MINUTE),
      from: newYorkInstant(day, EXTENDED_OPEN_MINUTE + COMPUTED_STEP_MINUTES),
      through: Math.min(floorStep(now) - STEP_MS, newYorkInstant(day, EXTENDED_CLOSE_MINUTE)),
    }))
    .filter((span) => span.through >= span.from)
    .sort((left, right) => right.from - left.from);
  if (spans.length === 0) return [];
  const state = fetchStateOf(db);
  const keyOf = (symbol: string) => `${kind}\u0000${symbol}`;
  const chartSources = placeholders(INTRADAY_CHART_SOURCES);
  const ownSources = chartSourcesOf(kind);
  const recordedTicks = db.prepare(
    `SELECT t FROM symbol_price_bars
      WHERE range_kind = 'intraday' AND symbol = ? AND t >= ? AND t <= ? AND source NOT IN (${chartSources})`,
  ).pluck();
  // Only the chart bars these days read cover their holes: another kind's would not be used.
  const latestChart = db.prepare(
    `SELECT MAX(t) FROM symbol_price_bars
      WHERE range_kind = 'intraday' AND symbol = ? AND t >= ? AND t <= ? AND source IN (${placeholders(ownSources)})`,
  ).pluck();
  const iso = (instant: number) => new Date(instant).toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO symbol_price_bars (symbol, range_kind, t, close, source) VALUES (?, 'intraday', ?, ?, ?)`,
  );
  const store = (bars: IntradayBar[]) => {
    try {
      db.transaction(() => {
        for (const bar of bars) {
          if (Date.parse(bar.t) <= now) insert.run(bar.symbol, bar.t, bar.close, bar.source);
        }
      })();
    } catch (error) {
      // A cache: the line still uses what is stored. Type and code only.
      console.warn('[portfolio] intraday price cache not written', errorTypeAndCode(error));
    }
  };
  const oldest = spans[spans.length - 1];
  const newest = spans[0];
  for (const symbol of symbols) {
    const key = keyOf(symbol);
    const known = state.symbols.get(key);
    // Also skips a symbol another request is fetching: its attempt is recorded before it waits.
    if (known && now - known.attemptAt < FETCH_RETRY_MS) continue;
    const ticks = new Set((recordedTicks.all(symbol, iso(oldest.from), iso(newest.through), ...INTRADAY_CHART_SOURCES) as string[])
      .map((t) => floorStep(Date.parse(t))));
    // Due when a day's latest hole is later than that day's stored chart bars and the last answer.
    const due = spans.some((span) => {
      let latestMissing: number | null = null;
      for (let t = span.through; t >= span.from; t -= STEP_MS) {
        if (!ticks.has(t)) { latestMissing = t; break; }
      }
      if (latestMissing === null) return false;
      const stored = Date.parse((latestChart.get(symbol, iso(span.open), iso(span.close), ...ownSources) as string | null) ?? '');
      return Math.max(known?.coveredThrough ?? 0, Number.isFinite(stored) ? stored : 0) < latestMissing;
    });
    if (!due) continue;
    const entry = { attemptAt: now, coveredThrough: known?.coveredThrough ?? 0 };
    state.symbols.set(key, entry);
    const fetching: Promise<void> = (async () => {
      await acquireFetchSlot(state);
      try {
        const bars = await fetchBars(symbol).catch(() => [] as IntradayBar[]);
        if (bars.length > 0) {
          store(bars.filter((bar) => bar.symbol === symbol));
          entry.coveredThrough = now;
        }
      } finally {
        releaseFetchSlot(state);
        // Unless a later attempt has taken the symbol over since.
        if (state.symbols.get(key) === entry) state.inFlight.delete(key);
      }
    })();
    state.inFlight.set(key, fetching);
  }
  return symbols.flatMap((symbol) => state.inFlight.get(keyOf(symbol)) ?? []);
}

/** Waits for chart fetches up to six seconds; a slower answer is stored for the next request. */
async function waitForFetches(pending: Array<Promise<void>>): Promise<void> {
  if (pending.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FETCH_WAIT_MS);
    timer.unref?.();
  });
  await Promise.race([Promise.all(pending), waited]);
  clearTimeout(timer);
}

/** One session's holdings and cash. */
interface DayPlan {
  day: string;
  positions: Map<string, Position[]>;
  cash: number;
  /** Money moved by recorded cash events since the previous session's plan. */
  flow: number;
}

/** The prices one kind of session reads. */
interface PriceBook {
  observations: Map<string, Observation[]>;
  /** Each day's session bounds, and its earliest and latest price instant. */
  bounds: Map<string, { open: number; close: number; earliest: number; latest: number }>;
}

/**
 * The computed line, or null when there is nothing to compute: no holdings, or no intraday price of
 * them in the session days looked at.
 */
export async function computeIntradayValuation(input: IntradayValuationInput): Promise<IntradayValuation | null> {
  const { db, now } = input;
  const nowMs = now.getTime();
  const week = input.week ?? null;
  const stepMs = (week ? WEEK_STEP_MINUTES : COMPUTED_STEP_MINUTES) * 60_000;
  const scope = input.accountIds && input.accountIds.length > 0 ? input.accountIds : null;
  const accounts = (scope
    ? db.prepare(`SELECT id, cash_balance FROM accounts WHERE id IN (${placeholders(scope)})`).all(...scope)
    : db.prepare('SELECT id, cash_balance FROM accounts').all()) as Array<{ id: string; cash_balance: number }>;
  if (accounts.length === 0) return null;
  const accountIds = accounts.map((account) => account.id);
  const ledger = loadTransactions(db, accountIds);
  const ledgerOf = new Map(accountIds.map((id) => [id, ledger.filter((transaction) => transaction.accountId === id)]));
  // The current holdings, exactly as the snapshot job counts them.
  const positions = new Map(accountIds.map((id) => [id, aggregatePositions(ledgerOf.get(id)!)]));
  // The ledger an earlier day is walked back through: position pulls give way to activity as in
  // the current holdings, and stand on every day.
  const effective = accountIds.flatMap((id) => dropImportedSnapshotsWhereActivityExists(ledgerOf.get(id)!));
  const walked = effective.filter((transaction) => !isPositionSnapshot(transaction));
  // Every symbol the line can hold: today's holdings and, for 1W, whatever an earlier day held. A
  // holding an earlier day had and today lacks was traded since that day, so since the week began.
  const held = new Set([
    ...[...positions.values()].flat().map((position) => position.symbol),
    ...(week ? walked.filter((transaction) => transaction.date >= week.from).map((transaction) => transaction.symbol) : []),
  ]);
  if (held.size === 0) return null;
  const today = marketDate(now);
  const sessionStarted = isWeekday(today) && newYorkMinute(nowMs) > EXTENDED_OPEN_MINUTE + COMPUTED_STEP_MINUTES;

  // The newest session: today's once its first tick is due; before that (and on weekends) the
  // latest weekday's, which may have missed ticks nobody looked at since.
  const refreshDay = sessionStarted ? today : previousWeekday(today);
  // Every symbol the line reads: the held ones and the underlyings an unquoted option is valued by.
  // Each range fetches all of them itself, so another range's fetches never add a price it reads.
  const underlyings = [...held]
    .map((symbol) => parseOccSymbol(symbol)?.underlyingSymbol)
    .filter((symbol): symbol is string => Boolean(symbol));
  const symbols = [...new Set([...held, ...underlyings])];

  if (input.fetchBars || (week && input.fetchWeekBars)) {
    const chartSymbols = symbols.filter(chartSymbol).sort();
    const pending: Array<Promise<void>> = [];
    // The newest session's 1-minute bars, for 1D and 1W alike; the earlier 1W sessions' 5-minute ones.
    if (input.fetchBars) pending.push(...startChartRefresh(db, input.fetchBars, 'session', chartSymbols, [refreshDay], nowMs));
    if (week && input.fetchWeekBars) {
      const pastDays: string[] = [];
      for (let day = daysBefore(refreshDay, 1); day >= week.from; day = daysBefore(day, 1)) {
        if (isWeekday(day)) pastDays.push(day);
      }
      if (pastDays.length > 0) pending.push(...startChartRefresh(db, input.fetchWeekBars, 'week', chartSymbols, pastDays, nowMs));
    }
    await waitForFetches([...new Set(pending)]);
  }

  // The sessions, each found by the prices it reads: the newest weekday with a recorded quote or a
  // 1-minute bar of a held symbol during session hours (the same for 1D and 1W), and for 1W up to
  // four earlier weekdays of the week with a recorded quote or a 5-minute bar.
  const iso = (instant: number) => new Date(instant).toISOString();
  const sessionWith = (kind: SessionKind) => {
    const excluded = otherChartSources(kind);
    const query = db.prepare(
      `SELECT 1 FROM symbol_price_bars
        WHERE range_kind = 'intraday' AND symbol IN (${placeholders(symbols)}) AND t >= ? AND t <= ?
          AND source NOT IN (${placeholders(excluded)}) LIMIT 1`,
    ).pluck();
    return (day: string) => {
      if (!isWeekday(day)) return false;
      const open = newYorkInstant(day, EXTENDED_OPEN_MINUTE);
      const close = Math.min(newYorkInstant(day, EXTENDED_CLOSE_MINUTE), nowMs);
      return close >= open && query.get(...symbols, iso(open), iso(close), ...excluded) !== undefined;
    };
  };
  const newestHasPrices = sessionWith('session');
  let newestDay: string | null = null;
  for (let day = today; day >= (week ? week.from : daysBefore(today, LOOKBACK_DAYS)); day = daysBefore(day, 1)) {
    if (newestHasPrices(day)) { newestDay = day; break; }
  }
  if (!newestDay) return null;
  const sessions: string[] = [newestDay];
  if (week) {
    const earlierHasPrices = sessionWith('week');
    for (let day = daysBefore(newestDay, 1); day >= week.from && sessions.length < WEEK_SESSIONS; day = daysBefore(day, 1)) {
      if (earlierHasPrices(day)) sessions.unshift(day);
    }
  }
  const firstDay = sessions[0];
  const sessionDate = newestDay;

  /**
   * The prices a kind of session reads, on its days and the last instant before them: the job's
   * recorded quotes, that kind's chart bars, owners' prices, daily closes and, for a holding with
   * none of these, its trade price. Rows come in a fixed order, so equal instants of equal rank
   * resolve the same way every time.
   */
  const buildBook = (kind: SessionKind, days: string[]): PriceBook => {
    const excluded = otherChartSources(kind);
    const from = newYorkInstant(days[0], EXTENDED_OPEN_MINUTE);
    const end = newYorkInstant(days[days.length - 1], 24 * 60);
    const lastDay = days[days.length - 1];
    const observations = new Map<string, Observation[]>(symbols.map((symbol) => [symbol, []]));
    const intradayRows = db.prepare(
      `SELECT symbol, t, close, source FROM symbol_price_bars
        WHERE range_kind = 'intraday' AND symbol IN (${placeholders(symbols)}) AND t >= ? AND t < ?
          AND source NOT IN (${placeholders(excluded)})
        ORDER BY symbol, t, source`,
    ).all(...symbols, iso(from), iso(end), ...excluded) as Array<{ symbol: string; t: string; close: number; source: string }>;
    // Each session's earliest and latest price instant, from numeric bounds: a New York date per row
    // would cost a time-zone lookup each, and the rows can number tens of thousands.
    const bounds = new Map(days.map((day) => [day, {
      open: newYorkInstant(day, EXTENDED_OPEN_MINUTE),
      close: newYorkInstant(day, EXTENDED_CLOSE_MINUTE),
      earliest: Number.POSITIVE_INFINITY,
      latest: Number.NEGATIVE_INFINITY,
    }]));
    const boundsList = [...bounds.values()];
    for (const row of intradayRows) {
      const at = Date.parse(row.t);
      if (!Number.isFinite(at) || at > nowMs || !(row.close > 0)) continue;
      observations.get(row.symbol)!.push({ at, price: row.close, rank: sourceRank(row.source) });
      const span = boundsList.find((candidate) => at >= candidate.open && at <= candidate.close);
      if (span) {
        if (at < span.earliest) span.earliest = at;
        if (at > span.latest) span.latest = at;
      }
    }
    // A symbol's last price from before these days still stands until a newer one, at its own age:
    // a long halt, a fund or an option past expiry (which keeps its last recorded mark, as the
    // snapshot job does) is carried forward like any other price, not replaced by the trade price.
    // Every row at that last instant is kept, so the precedence picks among them.
    const olderIntraday = db.prepare(
      `SELECT t, close, source FROM symbol_price_bars
        WHERE symbol = ? AND range_kind = 'intraday' AND close > 0 AND source NOT IN (${placeholders(excluded)})
          AND t = (SELECT MAX(t) FROM symbol_price_bars
                    WHERE symbol = ? AND range_kind = 'intraday' AND t < ? AND close > 0 AND source NOT IN (${placeholders(excluded)}))
        ORDER BY source`,
    );
    const olderDaily = db.prepare(
      `SELECT t, close FROM symbol_price_bars
        WHERE symbol = ? AND range_kind = 'daily' AND close > 0
          AND t = (SELECT MAX(t) FROM symbol_price_bars WHERE symbol = ? AND range_kind = 'daily' AND t < ? AND close > 0)
        ORDER BY source`,
    );
    const fromDay = daysBefore(days[0], LOOKBACK_DAYS);
    for (const symbol of symbols) {
      const rows = observations.get(symbol)!;
      for (const bar of olderIntraday.all(symbol, ...excluded, symbol, iso(from), ...excluded) as Array<{ t: string; close: number; source: string }>) {
        if (!Number.isFinite(Date.parse(bar.t))) continue;
        rows.push({ at: Date.parse(bar.t), price: bar.close, rank: sourceRank(bar.source) });
      }
      for (const close of olderDaily.all(symbol, symbol, fromDay) as Array<{ t: string; close: number }>) {
        rows.push({ at: newYorkInstant(close.t.slice(0, 10), REGULAR_CLOSE_MINUTE), price: close.close, rank: DAILY_RANK });
      }
      for (const price of input.manualPrices?.(symbol) ?? []) {
        if (price.date <= lastDay && price.close > 0) {
          rows.push({ at: newYorkInstant(price.date, REGULAR_CLOSE_MINUTE), price: price.close, rank: MANUAL_RANK });
        }
      }
      for (const close of input.dailyCloses?.(symbol, fromDay, lastDay) ?? []) {
        if (close.close > 0) rows.push({ at: newYorkInstant(close.t.slice(0, 10), REGULAR_CLOSE_MINUTE), price: close.close, rank: DAILY_RANK });
      }
      if (rows.length === 0 && !parseOccSymbol(symbol)) {
        // The last resort, as in the ledger replay: the trade price.
        for (const transaction of ledger) {
          if (transaction.symbol === symbol && transaction.date <= lastDay && transaction.pricePerUnit > 0) {
            rows.push({ at: newYorkInstant(transaction.date, REGULAR_CLOSE_MINUTE), price: transaction.pricePerUnit, rank: TRADE_RANK });
          }
        }
      }
      // Ascending by time, and at the same time the preferred price last, where the search lands.
      rows.sort((left, right) => left.at - right.at || right.rank - left.rank);
    }
    return { observations, bounds };
  };
  const sessionBook = buildBook('session', [newestDay]);
  const weekBook = sessions.length > 1 ? buildBook('week', sessions.slice(0, -1)) : null;
  const bookOf = (day: string) => (day === newestDay || !weekBook ? sessionBook : weekBook);

  const lastAtOrBefore = (rows: Observation[], t: number): Observation | null => {
    let low = 0;
    let high = rows.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (rows[middle].at <= t) { found = middle; low = middle + 1; } else { high = middle - 1; }
    }
    // Before a symbol's first price, its earliest one stands in: the preferred one at that instant.
    if (found >= 0) return rows[found];
    let first = 0;
    while (first + 1 < rows.length && rows[first + 1].at === rows[0].at) first += 1;
    return rows[first] ?? null;
  };
  const priceFor = (book: PriceBook, position: Position, t: number): Observation | null => {
    const own = lastAtOrBefore(book.observations.get(position.symbol) ?? [], t);
    if (own) return own;
    const contract = parseOccSymbol(position.symbol);
    if (!contract) return null;
    // An option never quoted: its intrinsic value at the underlying's price.
    const underlying = lastAtOrBefore(book.observations.get(contract.underlyingSymbol) ?? [], t);
    if (!underlying) return null;
    const intrinsic = contract.optionType === 'call'
      ? Math.max(0, underlying.price - contract.strikePrice)
      : Math.max(0, contract.strikePrice - underlying.price);
    return { at: underlying.at, price: intrinsic, rank: underlying.rank };
  };

  // The latest change to these accounts' ledger, cash or history: a recorded snapshot taken before
  // it holds older figures, so it cannot check the line.
  const scopeIds = placeholders(accountIds);
  const changes = [
    db.prepare(`SELECT MAX(updated_at) FROM accounts WHERE id IN (${scopeIds})`).pluck().get(...accountIds),
    db.prepare(`SELECT MAX(MAX(created_at), MAX(updated_at)) FROM transactions WHERE account_id IN (${scopeIds})`).pluck().get(...accountIds),
    db.prepare(`SELECT MAX(detected_at) FROM account_history_invalidations WHERE account_id IN (${scopeIds})`).pluck().get(...accountIds),
  ].map((value) => (typeof value === 'string' ? Date.parse(value) : NaN)).filter(Number.isFinite);
  const lastChange = changes.length > 0 ? Math.max(...changes) : null;

  // Each session's holdings and cash. The newest session counts every account all session at its
  // current holdings and cash, as 1D does. An earlier day walks them back through the ledger and the
  // recorded cash events dated after it; position pulls stand on every day.
  const currentCash = accounts.reduce((sum, account) => sum + account.cash_balance, 0);
  const cashEvents = (db.prepare(
    `SELECT account_id, event_date, event_type, amount FROM account_cash_events WHERE account_id IN (${scopeIds})`,
  ).all(...accountIds) as Array<{ account_id: string; event_date: string; event_type: string; amount: number }>);
  const plans: DayPlan[] = sessions.map((day, index) => {
    if (index === sessions.length - 1) return { day, positions, cash: currentCash, flow: 0 };
    const dayPositions = new Map(accountIds.map((id) => [id, aggregatePositions(effective.filter((transaction) => (
      transaction.accountId === id && (transaction.date <= day || isPositionSnapshot(transaction))
    )))]));
    const later = walked.filter((transaction) => transaction.date > day).reduce((sum, transaction) => sum + tradeCash(transaction), 0);
    const events = cashEvents.filter((event) => event.event_date > day).reduce((sum, event) => sum + event.amount, 0);
    return { day, positions: dayPositions, cash: currentCash - events - later, flow: 0 };
  });
  for (let index = 1; index < plans.length; index++) {
    const previous = plans[index - 1].day;
    const through = index === plans.length - 1 ? null : plans[index].day;
    plans[index].flow = cashEvents
      .filter((event) => !INCOME_EVENT_TYPES.has(event.event_type) && event.event_date > previous
        && (through === null || event.event_date <= through))
      .reduce((sum, event) => sum + event.amount, 0);
  }

  const fundPositions = new Set<string>();
  const optionPositions = new Set<string>();
  const unpricedSymbols = new Set<string>();
  for (const position of plans.flatMap((plan) => [...plan.positions.values()].flat())) {
    if (parseOccSymbol(position.symbol)) optionPositions.add(position.symbol);
    else if (FUND_SYMBOL.test(position.symbol)) fundPositions.add(position.symbol);
  }

  const points: ComputedPoint[] = [];
  let spanFrom = Number.NaN;
  let spanTo = Number.NaN;
  for (const plan of plans) {
    const day = plan.day;
    const sessionOpen = newYorkInstant(day, EXTENDED_OPEN_MINUTE);
    const sessionClose = newYorkInstant(day, EXTENDED_CLOSE_MINUTE);
    const regularOpen = newYorkInstant(day, REGULAR_OPEN_MINUTE);
    const regularClose = newYorkInstant(day, REGULAR_CLOSE_MINUTE);
    const book = bookOf(day);
    const bounds = book.bounds.get(day)!;
    const earliest = Number.isFinite(bounds.earliest) ? bounds.earliest : null;
    const latest = Number.isFinite(bounds.latest) ? bounds.latest : null;
    // The session on the x-axis, and the line up to now.
    const windowFrom = earliest !== null && earliest < regularOpen ? Math.max(sessionOpen, floorTo(earliest, stepMs)) : regularOpen;
    const windowTo = latest !== null && latest > regularClose ? sessionClose : regularClose;
    const lineEnd = day === today ? Math.min(windowTo, floorTo(nowMs, stepMs)) : windowTo;
    if (lineEnd <= windowFrom && !week) return null;
    if (Number.isNaN(spanFrom)) spanFrom = windowFrom;
    spanTo = windowTo;
    const staleExempt = (symbol: string) => {
      if (FUND_SYMBOL.test(symbol)) return true;
      const contract = parseOccSymbol(symbol);
      // An option past expiry keeps its last mark until the closing record arrives.
      return contract !== null && contract.expirationDate < day;
    };
    let first = true;
    for (let t = windowFrom; t <= lineEnd; t += stepMs) {
      let value = plan.cash;
      let costBasis = plan.cash;
      let staleValue = 0;
      let unpriced = false;
      const regular = t >= regularOpen && t < regularClose;
      for (const id of accountIds) {
        for (const position of plan.positions.get(id) ?? []) {
          costBasis += position.costBasis;
          const quote = priceFor(book, position, t);
          if (!quote) {
            unpriced = true;
            unpricedSymbols.add(position.symbol);
            continue;
          }
          const positionValue = positionMarketValue(position, { price: quote.price });
          value += positionValue;
          if (regular && !staleExempt(position.symbol) && Math.abs(t - quote.at) > STALE_PRICE_MS) staleValue += Math.abs(positionValue);
        }
      }
      points.push({
        t: new Date(t).toISOString(),
        value,
        costBasis,
        cashBalance: plan.cash,
        ...(unpriced || staleValue > STALE_VALUE_SHARE * Math.max(1, Math.abs(value)) ? { estimated: true } : {}),
        ...(first && plan.flow !== 0 && points.length > 0 ? { flow: plan.flow } : {}),
      });
      first = false;
    }
  }
  if (Number.isNaN(spanFrom) || points.length < 2) return null;

  const walkedBack = sessions.length > 1;
  const syncedTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fidelity_investing_sources'").pluck().get();
  return {
    sessionDate,
    sessions: plans.map((plan) => plan.day),
    accountIds,
    window: { from: new Date(spanFrom).toISOString(), to: new Date(spanTo).toISOString() },
    points,
    lastChange,
    activityOnSession: ledger.some((transaction) => transaction.date >= sessionDate),
    unpricedSymbols: unpricedSymbols.size,
    optionPositions: optionPositions.size,
    fundPositions: fundPositions.size,
    nettedTransactions: walkedBack
      ? walked.filter((transaction) => transaction.date > firstDay && tradeCash(transaction) !== 0).length
      : 0,
    recordedFlows: walkedBack
      ? cashEvents.filter((event) => !INCOME_EVENT_TYPES.has(event.event_type) && event.event_date > firstDay).length
      : 0,
    syncedAccounts: walkedBack && syncedTable
      ? (db.prepare(`SELECT COUNT(*) FROM fidelity_investing_sources WHERE account_id IN (${scopeIds})`).pluck().get(...accountIds) as number)
      : 0,
  };
}
