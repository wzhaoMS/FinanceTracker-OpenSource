import type { IndicativeSource } from '@finance-tracker/shared';

/**
 * Hyperliquid indicative price provider (overnight / weekend only).
 *
 * Source: the `metaAndAssetCtxs` info endpoint of the Hyperliquid `xyz`
 * HIP-3 builder-deployed perp DEX, which lists equity perpetuals whose
 * `oraclePx` tracks the underlying stock. We read **oracle**, not mark/mid,
 * because oracle is the venue's smoothed reference and is far less jumpy than
 * the order-book mark on a thin weekend book.
 *
 *   POST https://api.hyperliquid.xyz/info   body: {"type":"metaAndAssetCtxs","dex":"xyz"}
 *   → [ { universe: [{name:"xyz:NVDA",szDecimals},...] }, [ {oraclePx, premium, dayNtlVlm, ...}, ... ] ]
 *
 * IMPORTANT CAVEATS (enforced by the orchestrator, not here):
 *   - Prices are denominated in USDC, treated 1:1 with USD but tagged.
 *   - The response carries NO per-asset timestamp, so freshness can't be read
 *     directly; `dayNtlVlm` is used as a liveness proxy.
 *   - `xyz` is an anonymous third-party DEX. The dex name is configurable via
 *     `HL_DEX` so we can repoint or disable without a code change.
 *   - This is a *lagging echo* of the last official price plus crypto-trader
 *     positioning — never an independent valuation.
 *
 * This module is deliberately thin: it fetches and parses raw oracle rows for
 * an exact allowlist. All policy (baseline comparison, sanity band, confidence,
 * dislocation flag, USD treatment) lives in `indicative.ts` so it sits in one
 * auditable place.
 */

export const HL_SOURCE: IndicativeSource = 'hyperliquid-perp';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const HL_DEX = process.env.HL_DEX ?? 'xyz';

/**
 * EXACT allowlist: held equity ticker → its `xyz:` perp name. Exact identity
 * only — never a fuzzy lookup. This is the hard guard against symbol
 * collisions: the `xyz` universe also carries index/sector/meme tickers
 * (SP500, SMH, XLE, VIX, GOLD, ...) that must NEVER be mapped to a holding.
 * Verified 2026-06-14 against the live 90-symbol `xyz` universe: zero
 * collisions with these keys.
 *
 * Coverage is intentionally partial — symbols absent here simply get no
 * indicative (blank cell), never a wrong one.
 */
export const HL_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  NBIS: 'xyz:NBIS',
  NVDA: 'xyz:NVDA',
  TSLA: 'xyz:TSLA',
  GOOGL: 'xyz:GOOGL',
  MSFT: 'xyz:MSFT',
  AMZN: 'xyz:AMZN',
  PLTR: 'xyz:PLTR',
  COIN: 'xyz:COIN',
  CRWV: 'xyz:CRWV',
});

/** Raw, validated oracle row for one allowlisted symbol. */
export interface HlOracleRow {
  /** Held ticker (e.g. "NVDA"), not the `xyz:` perp name. */
  symbol: string;
  /** Oracle price in USDC. */
  oraclePx: number;
  /** Perp premium vs its own oracle (HL-internal dislocation), fraction. */
  premium: number;
  /** 24h notional volume in USDC — our liveness/liquidity proxy. */
  dayNtlVlm: number;
}

// Shapes of the untrusted JSON we read. Everything optional/unknown-guarded.
interface HlUniverseEntry {
  name?: unknown;
}
interface HlMeta {
  universe?: HlUniverseEntry[];
}
interface HlCtx {
  oraclePx?: unknown;
  premium?: unknown;
  dayNtlVlm?: unknown;
}
export type HlMetaAndCtxs = [HlMeta, HlCtx[]];

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Pure parser: given the raw `metaAndAssetCtxs` payload and the set of held
 * symbols requested, return validated oracle rows for those that are both
 * allowlisted and present with a sane positive oracle. Exposed for tests.
 */
export function parseHyperliquidOracles(
  json: unknown,
  requestedSymbols: string[],
): HlOracleRow[] {
  if (!Array.isArray(json) || json.length < 2) return [];
  const meta = json[0] as HlMeta | undefined;
  const ctxs = json[1] as HlCtx[] | undefined;
  const universe = meta?.universe;
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) return [];

  // Map requested held tickers → their perp name, only if allowlisted.
  const wantPerpToSymbol = new Map<string, string>();
  for (const s of requestedSymbols) {
    const up = s.toUpperCase();
    const perp = HL_ALLOWLIST[up];
    if (perp) wantPerpToSymbol.set(perp, up);
  }
  if (wantPerpToSymbol.size === 0) return [];

  const out: HlOracleRow[] = [];
  const n = Math.min(universe.length, ctxs.length);
  for (let i = 0; i < n; i++) {
    const name = universe[i]?.name;
    if (typeof name !== 'string') continue;
    const symbol = wantPerpToSymbol.get(name);
    if (!symbol) continue;

    const oraclePx = toFiniteNumber(ctxs[i]?.oraclePx);
    if (oraclePx == null || oraclePx <= 0) continue; // invalid → skip, never guess
    const premium = toFiniteNumber(ctxs[i]?.premium) ?? 0;
    const dayNtlVlm = toFiniteNumber(ctxs[i]?.dayNtlVlm) ?? 0;

    out.push({ symbol, oraclePx, premium, dayNtlVlm });
  }
  return out;
}

interface CacheEntry {
  rows: HlOracleRow[];
  fetchedAt: number;
}
const CACHE_TTL_MS = 60_000; // 1 minute
let cache: CacheEntry | null = null;

/**
 * Fetch validated oracle rows for the requested held symbols. Batched: one
 * POST returns the whole `xyz` universe, so we cache the full result and
 * filter per call. Returns [] on any error/timeout (graceful: the feature
 * silently degrades to "no indicative" rather than breaking quotes).
 *
 * `fetchImpl` and `now` are injectable for tests.
 */
export async function fetchHyperliquidOracles(
  symbols: string[],
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<HlOracleRow[]> {
  const requested = symbols.map((s) => s.toUpperCase()).filter((s) => HL_ALLOWLIST[s]);
  if (requested.length === 0) return [];

  const nowMs = (opts.now ?? Date.now)();
  const doFetch = opts.fetchImpl ?? fetch;

  // Serve from cache (full universe) when warm.
  if (cache && nowMs - cache.fetchedAt < CACHE_TTL_MS) {
    const want = new Set(requested);
    return cache.rows.filter((r) => want.has(r.symbol));
  }

  // Fetch the FULL allowlist in one shot so the cache is reusable across calls.
  const allKeys = Object.keys(HL_ALLOWLIST);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await doFetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: HL_DEX }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return [];
    const json = (await res.json()) as unknown;
    const rows = parseHyperliquidOracles(json, allKeys);
    cache = { rows, fetchedAt: nowMs };
    const want = new Set(requested);
    return rows.filter((r) => want.has(r.symbol));
  } catch {
    return [];
  }
}

/** Test helper. */
export function _clearHyperliquidCache(): void {
  cache = null;
}
