/**
 * The metals price store (design v8 §9): each metal's daily spot closes, cached in the shared `symbol_price_bars`
 * table under a symbol no ticker can have (`holdr:metal:XAU`, so `/symbols` answers never change), `range_kind 'daily'`
 * and source `cnbc-spot-daily`. It writes with its own statements and its own rule; the shared history repo
 * (symbolHistory.ts) and every existing source keep theirs.
 *
 * The metals rule:
 * - A bar dated today or later in New York is incomplete: never stored, never used.
 * - Bars dated in the last 7 days (today − 7 through yesterday) are provisional: a fresh fetch replaces them.
 * - Older bars are final: inserted once, never fetched again, never overwritten. A later fetch that differs for a final
 *   bar is counted in the log, and the stored bar stands.
 * - Two different closes for one date in one fetch store neither (counted); a later fetch may settle it.
 * - Fetching happens only when this Holdr fetches prices (HOLDR_METALS_PRICES=1) and only while the Gold page asks (a
 *   signed-in owner's read): the provisional window at most every 6 hours per metal, older history once per depth.
 * - A history request starts on 1 January of the year that holds the earliest day valued, less the margin: the provider
 *   learns a symbol and a coarse date range, never a day taken from the owner's data.
 *
 * Reads take every stored bar of the symbol, whatever its source: two different closes for one date refuse that date
 * (`bar-conflict`, metalsScreenCloses).
 */

import type { Database } from 'better-sqlite3';

import {
  METALS_PRICE_SOURCE,
  equals,
  metalsPriceSymbol,
  parseRational,
  type Metal,
  type MetalsPriceBar,
} from '@finance-tracker/shared/metals-ledger';

import type { MetalSpotBar, MetalSpotBarFetcher } from '../../providers/metalSpotBars.js';
import { errorTypeAndCode } from '../dbErrors.js';
import { marketDate } from '../symbolHistory.js';

export const METALS_PROVISIONAL_DAYS = 7;
export const METALS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How far before the earliest day a figure values the history reaches: the outlier check reads up to 5 earlier closes. */
export const METALS_HISTORY_MARGIN_DAYS = 21;

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 1 January of the year that holds `earliest` less the margin: where its history starts, never a day of its own. */
function historyFrom(earliest: string): string {
  return `${addDays(earliest, -METALS_HISTORY_MARGIN_DAYS).slice(0, 4)}-01-01`;
}

/** A stored close as decimal text: the REAL prints back the decimal it was stored from (at most 13 significant digits). */
function closeText(value: number): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? String(value) : null;
}

const sameClose = (left: string, right: string) => {
  const a = parseRational(left);
  const b = parseRational(right);
  return a !== null && b !== null && equals(a, b);
};

export interface MetalsPriceWrite {
  inserted: number;
  replaced: number;
  unchanged: number;
  /** Final bars a fetch disagreed with; the stored bar stands. */
  finalDiffered: number;
  /** Dates a fetch gave two different closes for; neither is stored. */
  conflicting: number;
  /** Bars dated today or later in New York. */
  incomplete: number;
}

export interface MetalsPriceStore {
  /** Every stored bar of the metal's symbol, any source, oldest first: what valuation screens. */
  bars(metal: Metal): MetalsPriceBar[];
  /** The first and last dates of the metal's stored cnbc-spot-daily bars, or null. */
  span(metal: Metal): { first: string; last: string } | null;
  /** Writes a fetch's bars by the metals rule, as of `today` (New York). */
  record(metal: Metal, bars: readonly MetalSpotBar[], today: string): MetalsPriceWrite;
}

/** Every stored bar of a metal's symbol, any source, oldest first: what valuation screens. */
const BARS = `SELECT t, close FROM symbol_price_bars WHERE symbol = ? AND range_kind = 'daily' ORDER BY t, source`;
const barsOf = (rows: ReadonlyArray<{ t: string; close: number }>): MetalsPriceBar[] =>
  rows.map((row) => ({ date: row.t, close: closeText(row.close) ?? 'unreadable' }));

/** The stored bars as the store's `bars` reads them, with no store (it prepares its writes): the operator's views report. */
export function readMetalsPriceBars(db: Database, metal: Metal): MetalsPriceBar[] {
  return barsOf(db.prepare(BARS).all(metalsPriceSymbol(metal)) as Array<{ t: string; close: number }>);
}

export function createMetalsPriceStore(db: Database): MetalsPriceStore {
  const read = db.prepare(BARS);
  const span = db.prepare(`SELECT MIN(t) AS first, MAX(t) AS last FROM symbol_price_bars
    WHERE symbol = ? AND range_kind = 'daily' AND source = ?`);
  const stored = db.prepare(`SELECT close FROM symbol_price_bars WHERE symbol = ? AND range_kind = 'daily' AND t = ? AND source = ?`).pluck();
  const insert = db.prepare(`INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source, fetched_at)
    VALUES (?, 'daily', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);
  const replace = db.prepare(`UPDATE symbol_price_bars SET close = ?, open = NULL, high = NULL, low = NULL, volume = NULL,
      fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE symbol = ? AND range_kind = 'daily' AND t = ? AND source = ?`);
  return {
    bars(metal) {
      return barsOf(read.all(metalsPriceSymbol(metal)) as Array<{ t: string; close: number }>);
    },
    span(metal) {
      const row = span.get(metalsPriceSymbol(metal), METALS_PRICE_SOURCE) as { first: string | null; last: string | null };
      return row.first === null || row.last === null ? null : { first: row.first, last: row.last };
    },
    record(metal, bars, today) {
      const counts: MetalsPriceWrite = { inserted: 0, replaced: 0, unchanged: 0, finalDiffered: 0, conflicting: 0, incomplete: 0 };
      const byDate = new Map<string, string[]>();
      for (const bar of bars) {
        if (bar.date >= today) {
          counts.incomplete += 1;
          continue;
        }
        const closes = byDate.get(bar.date) ?? [];
        if (!closes.some((close) => sameClose(close, bar.close))) closes.push(bar.close);
        byDate.set(bar.date, closes);
      }
      const provisionalFrom = addDays(today, -METALS_PROVISIONAL_DAYS);
      const symbol = metalsPriceSymbol(metal);
      db.transaction(() => {
        for (const date of [...byDate.keys()].sort()) {
          const closes = byDate.get(date)!;
          if (closes.length !== 1) {
            counts.conflicting += 1;
            continue;
          }
          const [close] = closes;
          const existing = stored.get(symbol, date, METALS_PRICE_SOURCE) as number | undefined;
          if (existing === undefined) {
            insert.run(symbol, date, Number(close), METALS_PRICE_SOURCE);
            counts.inserted += 1;
            continue;
          }
          const previous = closeText(existing);
          const same = previous !== null && sameClose(previous, close);
          if (date >= provisionalFrom) {
            replace.run(Number(close), symbol, date, METALS_PRICE_SOURCE);
            if (same) counts.unchanged += 1;
            else counts.replaced += 1;
          } else if (same) counts.unchanged += 1;
          else counts.finalDiffered += 1;
        }
      })();
      return counts;
    },
  };
}

export interface MetalsPriceRefresherOptions {
  store: MetalsPriceStore;
  /** Unset: this Holdr never fetches (HOLDR_METALS_PRICES unset or 0, disposable e2e stacks, every test). */
  fetcher?: MetalSpotBarFetcher;
  /**
   * Stored market data only (HOLDR_MARKET_DATA=stored, the demo): the Gold page values holdings with the stored closes
   * as if prices were on (`fetching` is true), and nothing is ever fetched, whatever `fetcher` says.
   */
  storedOnly?: boolean;
  now: () => Date;
  log: (line: string) => void;
}

/**
 * Keeps each metal's closes current while the Gold page asks. `refresh(metal, earliest)` fetches what the metals rule
 * allows: the history from 1 January of the year that holds `earliest` less a margin, once per depth, and the
 * provisional window at most every 6 hours; concurrent calls for a metal share one flight. Failures, a failed write
 * included, are logged by type only and retried after the interval.
 */
export class MetalsPriceRefresher {
  private readonly lastRecent = new Map<Metal, number>();
  private readonly deepest = new Map<Metal, { from: string; at: number; ok: boolean }>();
  private readonly flights = new Map<Metal, Promise<void>>();

  constructor(private readonly options: MetalsPriceRefresherOptions) {}

  /** Whether reads value holdings with stored closes: this Holdr fetches them, or serves stored market data only. */
  get fetching(): boolean {
    return this.options.fetcher !== undefined || this.options.storedOnly === true;
  }

  /** Asks for what is due; resolves when that fetch is written (or failed). Never rejects. */
  refresh(metal: Metal, earliest: string | null): Promise<void> {
    if (!this.options.fetcher || this.options.storedOnly) return Promise.resolve();
    const running = this.flights.get(metal);
    if (running) return running;
    const flight = this.run(metal, earliest).catch((error: unknown) => {
      this.options.log(`[metals] ${metal} closes not refreshed: ${errorTypeAndCode(error)}`);
    }).finally(() => this.flights.delete(metal));
    this.flights.set(metal, flight);
    return flight;
  }

  private async run(metal: Metal, earliest: string | null): Promise<void> {
    const fetcher = this.options.fetcher!;
    const nowMs = this.options.now().getTime();
    const today = marketDate(new Date(nowMs));
    const yesterday = addDays(today, -1);
    const recentStart = addDays(today, -METALS_PROVISIONAL_DAYS);
    const wanted = historyFrom(earliest !== null && earliest < today ? earliest : yesterday);
    const span = this.options.store.span(metal);
    const segments: Array<{ from: string; to: string; kind: 'history' | 'recent' }> = [];
    const deep = this.deepest.get(metal);
    const historyTo = span === null ? yesterday : addDays(span.first, -1);
    const triedDeep = deep !== undefined && deep.from <= wanted && (deep.ok || nowMs - deep.at < METALS_REFRESH_INTERVAL_MS);
    if (wanted <= historyTo && !triedDeep) segments.push({ from: wanted, to: historyTo, kind: span === null ? 'recent' : 'history' });
    if (span !== null) {
      const recentFrom = span.last < recentStart ? addDays(span.last, 1) : recentStart;
      const last = this.lastRecent.get(metal);
      if (recentFrom <= yesterday && (last === undefined || nowMs - last >= METALS_REFRESH_INTERVAL_MS)) {
        segments.push({ from: recentFrom, to: yesterday, kind: 'recent' });
      }
    }
    for (const segment of segments) {
      const bars = await fetcher(metal, segment.from, segment.to);
      const at = this.options.now().getTime();
      if (segment.kind === 'recent') this.lastRecent.set(metal, at);
      // The history counts as fetched only once an answer was read and written and the metal has a stored close: a first
      // answer with nothing to keep is asked again after the interval, like a failed one. The attempt is recorded even
      // when the write throws, so a failing write is retried after the interval too, never at once.
      let ok = false;
      try {
        if (bars === null) this.options.log(`[metals] ${metal} closes: the provider gave no readable answer`);
        else {
          const written = this.options.store.record(metal, bars, marketDate(new Date(at)));
          this.options.log(`[metals] ${metal} closes: ${written.inserted} new, ${written.replaced} replaced, ${written.unchanged} unchanged, `
            + `${written.finalDiffered} final bars differed (kept), ${written.conflicting} dates in conflict`);
          ok = this.options.store.span(metal) !== null;
        }
      } finally {
        if (span === null || segment.kind === 'history') this.deepest.set(metal, { from: segment.from, at, ok });
      }
    }
  }
}
