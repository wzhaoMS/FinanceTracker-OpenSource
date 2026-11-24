import { classifyFreshness, currentMarketSession, parseOccSymbol, type Quote } from '@finance-tracker/shared';

import { fetchNasdaqQuotes } from './nasdaq.js';
import { fetchCnbcQuotes } from './cnbc.js';
import { fetchCoinGeckoQuotes } from './coingecko.js';
import { fetchStooqQuotes } from './stooq.js';
import { computeIndicatives } from './indicative.js';
import { fetchCboeQuotes } from './cboe.js';

interface CacheEntry {
  quote: Quote;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000; // 1 minute
const cache = new Map<string, CacheEntry>();

/**
 * Preserve time monotonicity across provider fallbacks. A DNS/rate-limit
 * failure can make the fallback provider return yesterday's close after
 * Nasdaq already returned a newer print. Older data must never replace the
 * newer quote, and a total provider miss should continue serving last known.
 */
export function preferNewerQuote(existing: Quote | undefined, candidate: Quote | undefined): Quote | undefined {
  if (!existing) return candidate;
  if (!candidate) return existing;
  return candidate.asOf >= existing.asOf ? candidate : existing;
}

/**
 * Asset-class router + provider chain.
 *
 *   STOCKS / ETFs / mutual funds:
 *     1. nasdaq (real-time during US market hours, no key)
 *     2. cnbc   (real-time, no key)
 *     3. stooq  (EOD, last-resort)
 *
 *   CRYPTO (symbols ending in `-USD`):
 *     1. coingecko (real-time, no key)
 *     2. stooq     (some pairs available, EOD)
 *
 * Every returned `Quote` is tagged with `source` (which provider supplied
 * the price) and `freshness` (`live`/`delayed`/`eod`/`stale`) computed
 * from `asOf` against US market hours. The freshness label is what the UI
 * uses to color the "Refresh quotes" pill — the provider name alone is
 * not enough, because Stooq during after-hours is `eod` (correct), while
 * Stooq during market hours is `stale` (worth flagging).
 */

function isCrypto(symbol: string): boolean {
  return /^[A-Z]{2,6}-USD$/i.test(symbol);
}

function isOption(symbol: string): boolean {
  return parseOccSymbol(symbol) != null;
}

async function fetchStocks(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  let live: Quote[] = [];
  try {
    live = await fetchNasdaqQuotes(symbols);
  } catch (err) {
    console.warn('[quotes] nasdaq failed, falling back to cnbc:', (err as Error).message);
  }
  const have = new Set(live.map((q) => q.symbol));
  const missing = symbols.filter((s) => !have.has(s));
  if (missing.length > 0) {
    try {
      const cnbc = await fetchCnbcQuotes(missing);
      live = live.concat(cnbc);
    } catch (err) {
      console.warn('[quotes] cnbc failed, falling back to stooq:', (err as Error).message);
    }
  }
  const have2 = new Set(live.map((q) => q.symbol));
  const stillMissing = symbols.filter((s) => !have2.has(s));
  if (stillMissing.length > 0) {
    try {
      const stooq = await fetchStooqQuotes(stillMissing);
      live = live.concat(stooq);
    } catch (err) {
      console.warn('[quotes] stooq fallback failed:', (err as Error).message);
    }
  }
  return live;
}

async function fetchCryptoChain(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  let live: Quote[] = [];
  try {
    live = await fetchCoinGeckoQuotes(symbols);
  } catch (err) {
    console.warn('[quotes] coingecko failed:', (err as Error).message);
  }
  const have = new Set(live.map((q) => q.symbol));
  const missing = symbols.filter((s) => !have.has(s));
  if (missing.length > 0) {
    try {
      const stooq = await fetchStooqQuotes(missing);
      live = live.concat(stooq);
    } catch (err) {
      console.warn('[quotes] stooq fallback (crypto) failed:', (err as Error).message);
    }
  }
  return live;
}

export async function getQuotes(
  symbols: string[],
  opts: { indicative?: boolean } = {},
): Promise<Quote[]> {
  const now = Date.now();
  const fromCache: Quote[] = [];
  const stale: string[] = [];

  for (const symbol of symbols) {
    const hit = cache.get(symbol);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) {
      fromCache.push(hit.quote);
    } else {
      stale.push(symbol);
    }
  }

  let live: Quote[] = [];
  if (stale.length > 0) {
    const options = stale.filter(isOption);
    const crypto = stale.filter((symbol) => !isOption(symbol) && isCrypto(symbol));
    const stocks = stale.filter((symbol) => !isOption(symbol) && !isCrypto(symbol));
    const [stockQuotes, cryptoQuotes, optionQuotes] = await Promise.all([
      fetchStocks(stocks),
      fetchCryptoChain(crypto),
      fetchCboeQuotes(options),
    ]);
    const candidates = new Map(
      [...stockQuotes, ...cryptoQuotes, ...optionQuotes].map((quote) => [quote.symbol, quote]),
    );
    live = stale.flatMap((symbol) => {
      const selected = preferNewerQuote(cache.get(symbol)?.quote, candidates.get(symbol));
      if (!selected) return [];
      cache.set(symbol, { quote: selected, fetchedAt: now });
      return [selected];
    });
  }

  // Freshness is computed at response time, not fetch time, so cached
  // quotes get re-classified as the clock advances. e.g. an EOD quote at
  // 4:30 PM ET starts as `eod`; if the user's browser is open until 9:30
  // tomorrow morning, the same cached row becomes `stale`.
  // `session` is also computed at response time so the badge / labels
  // reflect *current* US session (pre-market / regular / after-hours /
  // closed), independent of when the quote was fetched.
  const session = currentMarketSession().session;
  const merged = new Map<string, Quote>();
  for (const q of [...fromCache, ...live]) {
    const freshness = classifyFreshness(q.asOf);
    merged.set(q.symbol, {
      ...q,
      freshness: q.source === 'cboe' && freshness === 'live' ? 'delayed' : freshness,
      session,
    });
  }
  const ordered = symbols
    .map((s) => merged.get(s))
    .filter((q): q is Quote => Boolean(q));

  // Indicative (overnight/weekend) overlay. Attached only when NO official
  // datum is fresh — a single trade-freshness gate that handles regular hours,
  // extended hours, weekends, AND holidays without a hardcoded calendar (the
  // clock-based session helper deliberately ignores holidays). The indicative
  // lives in its own `Quote.indicative` field and NEVER touches `price`, so it
  // cannot leak into valuation, P&L, or snapshots. Best-effort: any failure
  // degrades silently to "no indicative". Callers that only need `price`
  // (e.g. the snapshot scheduler) pass `{ indicative: false }` to skip the work.
  if (opts.indicative !== false) {
    await attachIndicatives(ordered);
  }
  return ordered;
}

/** Default off-switch + freshness gate for the indicative overlay. */
const INDICATIVE_ENABLED = process.env.INDICATIVE_ENABLED !== '0';
/**
 * If the freshest official quote is younger than this, the US market is
 * effectively live (regular or extended) and we skip indicatives. A closed
 * market's last-close `asOf` is always hours/days old, so this cleanly
 * separates "live" from "closed" — holidays included.
 */
const INDICATIVE_GATE_MS = 30 * 60 * 1000; // 30 min

async function attachIndicatives(quotes: Quote[]): Promise<void> {
  if (!INDICATIVE_ENABLED || quotes.length === 0) return;
  const now = Date.now();
  const eligibleQuotes = quotes.filter((quote) => !isOption(quote.symbol) && !isCrypto(quote.symbol));
  if (eligibleQuotes.length === 0) return;
  const freshestAsOf = eligibleQuotes.reduce((latest, quote) => Math.max(latest, quote.asOf), 0);
  // Some official datum is fresh → market live → no indicative needed.
  if (now - freshestAsOf < INDICATIVE_GATE_MS) return;

  try {
    const indicatives = await computeIndicatives(eligibleQuotes.map((q) => q.symbol), new Date(now));
    for (const q of quotes) {
      const ind = indicatives.get(q.symbol.toUpperCase());
      if (ind) q.indicative = ind;
    }
  } catch (err) {
    console.warn('[quotes] indicative overlay failed:', (err as Error).message);
  }
}

