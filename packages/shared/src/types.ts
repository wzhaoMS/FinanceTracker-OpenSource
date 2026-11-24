/** A tradable instrument the user holds. */
export type AssetClass = 'equity' | 'etf' | 'crypto' | 'cash' | 'option' | 'other';

export interface Instrument {
  symbol: string;          // e.g. "AAPL", "BTC-USD"
  name?: string;
  assetClass: AssetClass;
  currency: string;        // ISO 4217 (e.g. "USD")
}

/** A user-named brokerage / retirement / HSA account. */
export interface Account {
  id: string;
  name: string;
  /** Free-form classifier shown in the UI: "Individual", "Roth IRA", "HSA", etc. */
  type?: string;
  /** Cash held inside this account (money-market / settlement). */
  cashBalance: number;
  currency: string;
  /**
   * Full broker-issued account number, OR just the last 4 digits if the
   * user only knows that much. Stored as-is; only ever displayed masked.
   * Powers deterministic matching when importing from a broker page that
   * shows account numbers like "ROTH IRA ***6741" — see matchAccount in
   * apps/api/src/routes/brokerPull.ts.
   */
  accountNumber?: string;
}

/** A single buy or sell. Sells are negative quantity. */
export interface Transaction {
  id: string;
  /** ID of the owning account. */
  accountId: string;
  symbol: string;
  /** ISO date string (YYYY-MM-DD). */
  date: string;
  /** Positive for buy, negative for sell. */
  quantity: number;
  /** Price per share/unit at the time of the trade, in `currency`. */
  pricePerUnit: number;
  /** Present only for option contracts. Absence means the legacy equity path. */
  instrumentType?: 'option';
  /** Deliverable units per contract. Standard US equity options use 100. */
  contractMultiplier?: number;
  /** Whether this option trade opens or closes exposure. */
  positionEffect?: 'open' | 'close';
  /** Optional commission/fees, always positive. */
  fees?: number;
  currency: string;
  notes?: string;
  /**
   * Stable hash that identifies the source row in an idempotent way. Used
   * by the broker-activity importer (Fidelity/Schwab/Citi "Activity &
   * Orders" pages) so re-running a sync doesn't create duplicates.
   *
   * Always optional — manual entries and snapshot-position imports leave
   * it null. The DB enforces uniqueness only on `(account_id,
   * source_fingerprint)` when this field is non-null.
   */
  sourceFingerprint?: string;
}

/** Financial cash movement independent of security position transactions. */
export type CashEventType =
  | 'deposit'
  | 'withdrawal'
  | 'dividend'
  | 'interest'
  | 'transfer'
  | 'fee'
  | 'tax'
  | 'sweep';

export interface CashEventInput {
  accountId: string;
  /** ISO date string (YYYY-MM-DD). */
  date: string;
  eventType: CashEventType;
  /** Signed from the account's perspective: inflow positive, outflow negative. */
  amount: number;
  currency: string;
  broker: string;
  accountLast4: string;
  description: string;
  /** Stable SHA-256 identity of the broker activity row. */
  sourceFingerprint: string;
}

export interface CashEvent extends CashEventInput {
  id: string;
  importedAt: string;
}

/** Whose card a card account is. */
export type CardOwner = 'alex' | 'casey' | 'joint';

export type CardAccountStatus = 'active' | 'closed';

/**
 * A credit-card billing account, identified by issuer, owner and last four
 * digits; Holdr never stores a card number. Supplementary and reissued cards
 * belong to their billing account.
 */
export interface CardAccount {
  id: string;
  /** Lowercase issuer slug, e.g. `amex`, `chase`. */
  issuer: string;
  owner: CardOwner;
  nickname?: string;
  /** Exactly the four digits the issuer shows, never padded. Not unique: last-4 collisions are legal. */
  last4?: string;
  /**
   * The five digits issuers such as American Express show at the end of the
   * account, when known; it always ends with `last4`. Two cards with the same
   * last four digits stay apart by this and their nicknames.
   */
  last5?: string;
  currency: string;
  status: CardAccountStatus;
  createdAt: string;
  updatedAt: string;
}

export type CardTransactionStatus = 'pending' | 'posted' | 'removed';

/** Purchases, fees and interest are spending; refunds offset it; a card payment is a transfer, not spending. */
export type CardTransactionKind = 'purchase' | 'refund' | 'payment' | 'fee' | 'interest' | 'adjustment' | 'other';

export interface CardTransaction {
  id: string;
  cardAccountId: string;
  /** Where the row came from, e.g. `amex-csv`. */
  source: string;
  /** `cardExternalIdHash` of the issuer's stable reference; the reference itself is never stored. */
  externalIdHash?: string;
  /** `cardTransactionFingerprint` for rows without a stable reference. Exactly one of the two keys is set. */
  fingerprint?: string;
  /** ISO date string (YYYY-MM-DD). */
  transactionDate: string;
  postedDate?: string;
  status: CardTransactionStatus;
  /** Integer minor units of `currency`: positive = money spent, negative = refund, payment or cashback. */
  amountMinor: number;
  currency: string;
  /** Foreign-currency purchases: the amount in `originalCurrency` minor units, same sign convention. */
  originalAmountMinor?: number;
  originalCurrency?: string;
  kind: CardTransactionKind;
  /** Issuer description after redaction. */
  description: string;
  merchant?: string;
  issuerCategory?: string;
  userCategory?: string;
  notes?: string;
  importBatchId?: string;
  /** For a pending row someone dismissed (status `removed`): when. */
  dismissedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** One committed card import: provenance and counts only, never file names or raw content. */
export interface CardImportBatch {
  id: string;
  cardAccountId: string;
  source: string;
  parserVersion: string;
  /** newCount + duplicateCount + rejectedCount. */
  rowCount: number;
  newCount: number;
  duplicateCount: number;
  rejectedCount: number;
  /** The dates the import spoke for (inclusive), when it said; absent on batches from before v14. */
  coverage?: { start: string; end: string };
  importedAt: string;
}

/** UI/action-layer error record for async mutations. */
export interface ActionError {
  action: string;
  error: string;
  timestamp: number;
}

export interface CostBasisCheck {
  transactionId: string;
  symbol: string;
  date: string;
  enteredPrice: number;
  historicalPrice: number | null;
  historicalDate?: string;
  deviationPercent: number | null;
  warningLevel: 'none' | 'minor' | 'major' | 'unknown';
  reason?: string;
}

/**
 * Where a quote came from. `synthetic` is a stored daily close served as the quote when the API runs on stored
 * market data only (`HOLDR_MARKET_DATA=stored`, the demo): no provider was asked.
 */
export type QuoteSource = 'nasdaq' | 'cnbc' | 'coingecko' | 'stooq' | 'cboe' | 'cache' | 'synthetic' | 'unknown';

/**
 * Where an *indicative* (overnight/weekend, non-official) price came from.
 * These are NEVER official exchange prints and must never feed valuation,
 * cost-basis, day-change, or snapshots — they exist only to give a rough
 * "where is this drifting while the US market is closed" signal.
 *
 *   hyperliquid-perp — oracle price of the matching equity perpetual on the
 *                      Hyperliquid `xyz` HIP-3 DEX. Anonymous third-party
 *                      venue; priced in USDC; a *lagging echo* of the last
 *                      official price plus crypto-trader positioning, NOT an
 *                      independent valuation.
 *   btc-proxy        — a Bitcoin ETF (e.g. FBTC) repriced off spot BTC's move
 *                      since the ETF's last official close. The only truly
 *                      24/7, high-confidence indicative because it tracks a
 *                      real 24/7 underlying.
 */
export type IndicativeSource = 'hyperliquid-perp' | 'btc-proxy';

/**
 * Confidence in an indicative price.
 *   ok          — venue liquid, premium small relative to the symbol's own
 *                 volatility. Reasonable rough read.
 *   thin        — low venue volume / open interest; treat loosely.
 *   dislocated  — |indicative − last official close| is large for THIS symbol
 *                 (volatility-scaled). Likely venue froth, not real move.
 */
export type IndicativeConfidence = 'ok' | 'thin' | 'dislocated';

/**
 * A clearly-labeled, non-official price shown only while the official US
 * market is closed. Lives in its own field on `Quote` so it is structurally
 * impossible for it to leak into `price`-driven math (valuation, P&L,
 * snapshots). The UI surfaces it in a separate, collapsed-by-default
 * "Overnight/Weekend · indicative" view with an explicit "not official" tag.
 */
export interface IndicativeQuote {
  /** The indicative price itself (USD; USDC treated 1:1 with a caveat tag). */
  price: number;
  source: IndicativeSource;
  /** Epoch ms when the indicative datum was observed. */
  asOf: number;
  /**
   * Official close this indicative is compared against — the most recent
   * dated daily-close bar (session-invariant; NOT a live quote's
   * prev-close field, which shifts meaning by session).
   */
  baselineClose: number;
  /** `(price - baselineClose) / baselineClose`, signed. */
  premiumPct: number;
  confidence: IndicativeConfidence;
  /** True when `price` is denominated in USDC rather than USD. */
  usdcDenominated?: boolean;
  /** Free-form note for the UI (e.g. "thin volume", "USDC-priced"). */
  note?: string;
}

/**
 * How fresh the quote is relative to current US market hours.
 *   live     — taken during the current US session, < ~30 min old
 *   delayed  — taken during the current US session but older
 *   eod      — most recent close, served outside market hours
 *   stale    — markets are open right now but our data is from a prior session
 */
export type QuoteFreshness = 'live' | 'delayed' | 'eod' | 'stale';

/**
 * What kind of US market session is currently active. Distinct from
 * `QuoteFreshness` (which describes datum recency); a quote can be `live`
 * during `pre-market`, `regular`, OR `after-hours`. Closed = overnight,
 * weekends, or holidays.
 *
 *   pre-market   — weekday 04:00–09:30 ET (extended-hours pre-open)
 *   regular      — weekday 09:30–16:00 ET (regular session)
 *   after-hours  — weekday 16:00–20:00 ET (extended-hours close)
 *   closed       — weekday 20:00–04:00 ET, weekends, or holidays
 *
 * The UI uses this to label day-change correctly: a Nasdaq response after
 * 16:00 ET reports the *current* price plus today's *regular-session close*
 * as the baseline, which would mislabel as "Today" when it's really
 * "After hours" delta vs that close.
 */
export type QuoteSession = 'pre-market' | 'regular' | 'after-hours' | 'closed';

/**
 * What baseline a quote's day-change is measured against. Brokerages always
 * use prior-regular-session close; some sources only expose the day's open
 * (intraday delta) or 24h-change (crypto). The discriminator lets the UI
 * decide whether to show or hide the change.
 *
 *   previousClose  — yesterday's regular-session close. Brokerage standard.
 *                    Safe to display without caveats.
 *   open           — today's open. Intraday only; misleading if shown as
 *                    "today's change" because morning gaps disappear.
 *   24h            — 24 hours ago (CoinGecko-style rolling window). Tag
 *                    explicitly in the UI; not the same as a market-day delta.
 *   provider       — source claims a generic "change" without specifying;
 *                    treat as approximate.
 */
export type QuoteChangeBasis = 'previousClose' | 'open' | '24h' | 'provider';

/** Live or last-known market quote for a symbol. */
export interface Quote {
  symbol: string;
  price: number;
  currency: string;
  /** Epoch ms. */
  asOf: number;
  /** Provider that supplied this price; absent on legacy callers. */
  source?: QuoteSource;
  /** Raw option market fields when the source exposes them. */
  bid?: number;
  ask?: number;
  last?: number;
  /** How `price` was selected for an option quote. */
  pricingMethod?: 'mid' | 'last';
  /** How fresh the price is; computed server-side from `asOf` + market hours. */
  freshness?: QuoteFreshness;
  /** Which US session is active when this quote was fetched. Optional for
   *  back-compat; absent on legacy callers. */
  session?: QuoteSession;

  // ---------------------------------------------------------------------------
  // Day-change fields (Phase A.1). All optional — providers that can't supply
  // a trustworthy day-change leave these undefined and the UI shows `—`.
  // ---------------------------------------------------------------------------

  /** What `baselinePrice` represents; absent when day-change is unavailable. */
  changeBasis?: QuoteChangeBasis;
  /** Baseline price the change is measured against. Same units as `price`. */
  baselinePrice?: number;
  /**
   * Today's absolute price change. Always derived as `price - baselinePrice`
   * when both are known, even if the provider supplied a separate "change"
   * field (those are usually rounded to 2dp). Absent when there's no baseline.
   */
  dayChange?: number;
  /**
   * Today's percent change. Derived from `(dayChange / baselinePrice) * 100`
   * unless the provider supplies it directly with more precision.
   */
  dayChangePercent?: number;

  // ---------------------------------------------------------------------------
  // Indicative (overnight/weekend) + extended-hours fields. All optional.
  // ---------------------------------------------------------------------------

  /**
   * Non-official overnight/weekend price (Hyperliquid perp oracle or BTC
   * proxy). Present only while the official US market is closed AND a
   * covered symbol has indicative data. NEVER read by valuation/snapshot
   * code — `summarizePortfolio` and `snapshotJob` use `price` only.
   * Surfaced in a separate, collapsed-by-default UI view.
   */
  indicative?: IndicativeQuote;

  /**
   * Extended-hours (pre-market / after-hours) price, when the official feed
   * supplies one fresher than today's regular close. This IS an official
   * exchange print, so unlike `indicative` it may be promoted into `price`
   * by the provider. The separate fields let the UI show "After hours +Y%"
   * distinct from the regular-session day change.
   */
  extendedPrice?: number;
  /** Epoch ms of the extended-hours print. */
  extendedAsOf?: number;
  /** `extendedPrice - todayRegularClose` (extended move vs today's close). */
  extendedChange?: number;
  /** Percent form of `extendedChange` against today's regular close. */
  extendedChangePercent?: number;
}

/** Aggregated position derived from transactions. */
export interface Position {
  symbol: string;
  quantity: number;
  /** Average cost per unit, weighted by buy lots only. */
  averageCost: number;
  /** Sum of all cash spent (buys + fees) - cash received (sells). */
  costBasis: number;
  currency: string;
  instrumentType?: 'option';
  contractMultiplier?: number;
}

/** Position enriched with a current quote. */
export interface ValuedPosition extends Position {
  marketPrice: number;
  marketValue: number;
  unrealizedPnL: number;
  /** `positionsPnLPercent` of this holding: null, never 0, when it cost nothing. */
  unrealizedPnLPercent: number | null;
}

export interface PortfolioSummary {
  totalCostBasis: number;
  totalMarketValue: number;
  totalUnrealizedPnL: number;
  /** The gain/loss over the positions' cost (`positionsPnLPercent`): null when a price is missing or they cost nothing. */
  positionsUnrealizedPnLPercent: number | null;
  positions: ValuedPosition[];
  /** Symbols with transactions but no quote available. */
  missingQuotes: string[];
  /** False when totals omit at least one open position. */
  valueAvailable: boolean;
}

/**
 * Mask an account number for display: keep only the last 4 chars and
 * prefix with `***`. Returns an empty string for null/undefined/empty
 * inputs so callers can confidently inline it.
 *
 * Examples:
 *   maskAccountNumber('Z85325841')  // '***5841'
 *   maskAccountNumber('5841')        // '***5841'
 *   maskAccountNumber('99')          // '***99'   (no padding — keep what we have)
 *   maskAccountNumber(undefined)     // ''
 */
export function maskAccountNumber(n: string | null | undefined): string {
  if (!n) return '';
  const digits = n.replace(/[^A-Za-z0-9]/g, '');
  if (!digits) return '';
  return '***' + digits.slice(-4);
}

/**
 * Extract the last-4 alphanumeric chars from any string, or null if there
 * are fewer than 4 alphanumeric chars total. Used by the broker matcher
 * to compare a section label like "ROTH IRA ***6741" or "ROTH IRA 191596741"
 * against a stored Account.accountNumber.
 */
export function lastFour(s: string | null | undefined): string | null {
  if (!s) return null;
  const digits = s.replace(/[^A-Za-z0-9]/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}
