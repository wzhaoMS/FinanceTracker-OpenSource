/**
 * The balance-chain verifier (roadmap R1; design W6 v1, approved by Root): whether the balances a bank or issuer states
 * (anchors) follow from each other and the rows Holdr holds between them. For each pair of consecutive anchors,
 * `B(t1) = B(t0) + Σ rows dated in (t0, t1]`, in exact integer minor units and in Holdr's sign for both account types
 * (checking: money in the account is positive; card: money owed is positive; in both, rows add to the balance).
 *
 * Rows come in three classes:
 * - `posting`: posted, dated by a posting date (`BALANCE_CHAIN_POSTING_DATE_SOURCES`);
 * - `timing`: posted, dated by a date that may be the transaction date. It posted somewhere in `[d, d + L]`, so it may
 *   sit on either side of an anchor dated within `L` days after it;
 * - `pending`: not posted yet. It may post in `[d, d + L]`, or never.
 *
 * Each step gets the band of residuals that some placement of its uncertain rows explains. A residual outside the band
 * fails: a row is missing, extra or wrong, or a coverage claim is false. A timing account never passes: a charge dated
 * just before an anchor that posts after it arrives with a later import, so no stored fact proves such a pass final.
 *
 * Every function is pure and deterministic. Results never carry an amount, a balance or a residual: only dates, counts,
 * closed codes and digests over ids.
 */
import { sha256, toLetterHex } from '../cardDedupe.js';
import { cardPaymentPayeeMatchesIssuer } from '../cardPaymentReconciliation.js';
import { addCheckingDays, checkingRangesCover, isCheckingDate, mergeCheckingRanges } from '../checkingImport.js';

export const BALANCE_CHAIN_VERIFIER = 'balance-chain@1';
/** How many calendar days a row without a proven posting date may take to post (design D4, Root: 10). */
export const BALANCE_CHAIN_TIMING_WINDOW_DAYS = 10;

/**
 * Card row sources whose `posted_date` is a posting date by definition, except for the issuer families listed (design
 * D3). Amex keeps one date per row, the transaction date for charges, in its CSV and its QFX DTPOSTED alike (P1's
 * posted-date evidence: 1,321 of 1,321 rows). Every other source, and any row without a posted date, is a timing row.
 */
export const BALANCE_CHAIN_POSTING_DATE_SOURCES: Readonly<Record<string, { readonly exceptIssuers: readonly 'amex'[]; readonly field: string }>> = Object.freeze({
  ofx: Object.freeze({ exceptIssuers: Object.freeze(['amex'] as const), field: 'OFX/QFX/QBO DTPOSTED (cardImportTool/ofx.ts)' }),
  'bilt-csv': Object.freeze({ exceptIssuers: Object.freeze([] as const), field: 'Bilt CSV "Posted Date" (cardImportTool/biltCsv.ts)' }),
  'discover-statement': Object.freeze({ exceptIssuers: Object.freeze([] as const), field: 'Discover statement layout A "Post Date" (cardImportTool/discoverStatement.ts)' }),
});

/**
 * Extractor versions whose `statement-pdf` rows may anchor a card chain (design §2.3, D5): each entry cites a layout
 * whose fixtures prove the printed closing date, and the New Balance in Holdr's owed-positive sign with a credit balance
 * negative. Rows of any other version are counted as untrusted and never chained. A version found wrong is removed here
 * in a reviewed change, and its rows stop counting.
 */
export const BALANCE_ANCHOR_EXTRACTORS: Readonly<Record<string, string>> = Object.freeze({});

export type BalanceAnchorKind = 'statement-closing' | 'statement-opening' | 'ledger' | 'daily';
export type BalanceAnchorSource = 'statement-facts' | 'checking-import';
export type BalanceRowClass = 'posting' | 'timing' | 'pending';
export type BalanceStepVerdict = 'pass' | 'fail' | 'unknown';
export type BalanceStepReason = 'exact' | 'as-dated' | 'mismatch' | 'anchor-conflict' | 'gap' | 'currency' | 'pending' | 'date-basis';
export type BalanceChainState = 'failing' | 'balanced' | 'partly-balanced' | 'not-yet-checked';
export type BalanceChainResultCode = 'pass' | 'fail' | 'unknown';

export const BALANCE_ANCHOR_KINDS: readonly BalanceAnchorKind[] = Object.freeze(['statement-closing', 'statement-opening', 'ledger', 'daily']);
export const BALANCE_STEP_REASONS: readonly BalanceStepReason[] = Object.freeze(['exact', 'as-dated', 'mismatch', 'anchor-conflict', 'gap', 'currency',
  'pending', 'date-basis']);

/** Rank by authority (1 first): imported statement balances, P1's statement facts, OFX LEDGERBAL, daily balances. */
export function balanceAnchorRank(kind: BalanceAnchorKind, source: BalanceAnchorSource): number {
  if (kind === 'statement-closing' || kind === 'statement-opening') return source === 'checking-import' ? 1 : 2;
  return kind === 'ledger' ? 3 : 4;
}

export interface BalanceAnchorInput {
  /** The balance at the end of this day, after every row posted on it. */
  date: string;
  /** Integer minor units in Holdr's sign. Read only inside the check; never returned. */
  balanceMinor: number;
  kind: BalanceAnchorKind;
  source: BalanceAnchorSource;
  /** A value-free reference to where the anchor came from: `lh1:` and 64 letters, or a `chk-imp-` id. */
  ref: string;
}

export interface BalanceRowInput {
  /** The row's opaque id: it only feeds the failing steps' pins. */
  id: string;
  /** The posting date of a posting row; the transaction date of a timing or pending row. */
  date: string;
  /** Integer minor units in Holdr's sign. Read only inside the check; never returned. */
  amountMinor: number;
  rowClass: BalanceRowClass;
  currency: string;
  /**
   * How many times the row's tracked values (status, dates, amount, …) changed in place; absent means 0. Card rows can
   * change in place (v15 keeps each replaced version in `card_transaction_versions`); checking rows never do. It feeds
   * the pins only, so an accepted failure lapses when a row in its step changes, but not on an owner's category or note.
   */
  version?: number;
}

export interface BalanceCoverageRange {
  /** Inclusive YYYY-MM-DD bounds of days the imports claim complete. */
  start: string;
  end: string;
}

export interface BalanceChainInput {
  /** The account's opaque id, for pins. */
  accountId: string;
  currency: string;
  anchors: readonly BalanceAnchorInput[];
  rows: readonly BalanceRowInput[];
  coverage: readonly BalanceCoverageRange[];
}

export interface BalanceChainOptions {
  timingWindowDays?: number;
  /** The rules digest results and pins are bound to; `balanceChainRules()` for the default window by default. */
  rules?: string;
}

export interface BalanceChainAnchorRef {
  date: string;
  kind: BalanceAnchorKind;
  source: BalanceAnchorSource;
  rank: number;
  state: 'chained' | 'before-history' | 'conflict';
  /** The highest-ranked anchor's ref at this date. */
  ref: string;
  /** Every distinct ref at this date, sorted: a second statement's copy, or another kind, shows here. */
  refs: string[];
}

export interface BalanceChainStep {
  from: string;
  to: string;
  verdict: BalanceStepVerdict;
  reason: BalanceStepReason;
  /** Failing steps only: what an accepted failure is frozen to (its rows' ids, dates, classes and change counts; its anchors' refs). */
  pin?: string;
  /** Failing steps of a posting account only: whether its rows near the two dates, read as timing rows, explain it. */
  timingWouldExplain?: boolean;
}

export interface BalanceChainResult {
  verifier: typeof BALANCE_CHAIN_VERIFIER;
  rules: string;
  /** False when an input is not a valid date or a safe integer: then nothing is checked. */
  readable: boolean;
  dateBasis: 'posting' | 'timing';
  state: BalanceChainState;
  result: BalanceChainResultCode;
  reconciledFrom: string | null;
  reconciledThrough: string | null;
  latestRun: { from: string; through: string; steps: number } | null;
  latestAnchor: string | null;
  latestStatementAnchor: string | null;
  history: { from: string; through: string; uncoveredRuns: number } | null;
  anchors: {
    total: number;
    chained: number;
    beforeHistory: number;
    conflicted: number;
    byKind: Partial<Record<BalanceAnchorKind, number>>;
    list: BalanceChainAnchorRef[];
  };
  steps: BalanceChainStep[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Row classes and rules
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Whether a card source's `posted_date` is a posting date for an issuer (the registry's answer, design D3): `posting`
 * for a registered source and an issuer it doesn't except, else `timing`. A row without a posted date is a timing row
 * whatever its source (Discover's layout B, for one).
 */
export function balanceSourceDateBasis(source: string, issuer: string): 'posting' | 'timing' {
  const entry = Object.hasOwn(BALANCE_CHAIN_POSTING_DATE_SOURCES, source) ? BALANCE_CHAIN_POSTING_DATE_SOURCES[source] : undefined;
  if (!entry) return 'timing';
  return entry.exceptIssuers.some((family) => cardPaymentPayeeMatchesIssuer(family, issuer)) ? 'timing' : 'posting';
}

/** A live card row's class under the date-basis registry. Removed rows have none: callers leave them out. */
export function balanceCardRowClass(
  row: { status: 'pending' | 'posted'; postedDate: string | null; source: string },
  issuer: string,
): BalanceRowClass {
  if (row.status === 'pending') return 'pending';
  if (row.postedDate === null) return 'timing';
  return balanceSourceDateBasis(row.source, issuer);
}

/**
 * A card-import payload's date basis, for W4's P-STATEMENT: `posting` when its source is posting-dated for its issuer
 * and every posted row carries a posted date (Discover layout B carries none), else `timing`. Pending rows don't count.
 */
export function balancePayloadDateBasis(payload: {
  source: string;
  issuer: string;
  rows: ReadonlyArray<{ status: string; postedDate: string | null }>;
}): 'posting' | 'timing' {
  if (balanceSourceDateBasis(payload.source, payload.issuer) === 'timing') return 'timing';
  return payload.rows.every((row) => row.status !== 'posted' || row.postedDate !== null) ? 'posting' : 'timing';
}

const encoder = new TextEncoder();
const letterDigest = (value: unknown) => `lh1:${toLetterHex(sha256(encoder.encode(JSON.stringify(value))))}`;

/** A digest of everything besides the data that decides a verdict: the verifier, `L`, the registry and the allowlist. */
export function balanceChainRules(options: { timingWindowDays?: number; anchorExtractors?: Readonly<Record<string, string>> } = {}): string {
  const sources = Object.keys(BALANCE_CHAIN_POSTING_DATE_SOURCES).sort()
    .map((source) => [source, [...BALANCE_CHAIN_POSTING_DATE_SOURCES[source].exceptIssuers].sort()]);
  const extractors = Object.keys(options.anchorExtractors ?? BALANCE_ANCHOR_EXTRACTORS).sort();
  return letterDigest(['holdr.balance-chain-rules', BALANCE_CHAIN_VERIFIER, options.timingWindowDays ?? BALANCE_CHAIN_TIMING_WINDOW_DAYS,
    sources, extractors]);
}

/** A `sha256:<64 hex>` source reference as a value-free `lh1:` ref (letters a-p, no digit); null for anything else. */
export function balanceAnchorRefFromSha256(sourceRef: string): string | null {
  const match = /^sha256:([0-9a-f]{64})$/.exec(sourceRef);
  if (!match) return null;
  return `lh1:${match[1].replace(/[0-9a-f]/g, (nibble) => String.fromCharCode(97 + parseInt(nibble, 16)))}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------------------------------

interface MergedAnchor {
  date: string;
  /** Null when the anchors of this date disagree. */
  balance: bigint | null;
  conflicted: boolean;
  primary: BalanceAnchorInput;
  rank: number;
  refs: string[];
}

interface DatedRow {
  id: string;
  date: string;
  amount: bigint;
  rowClass: BalanceRowClass | 'other-currency';
  version: number;
}

/** Index of the first row dated after `date` (rows sorted by date). */
function firstAfter(rows: readonly DatedRow[], date: string): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].date <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Rows dated in `(from, to]`. */
function within(rows: readonly DatedRow[], from: string, to: string): DatedRow[] {
  return to <= from ? [] : rows.slice(firstAfter(rows, from), firstAfter(rows, to));
}

const ZERO = BigInt(0);
const total = (rows: readonly DatedRow[]) => rows.reduce((sum, row) => sum + row.amount, ZERO);
const positive = (rows: readonly DatedRow[]) => rows.reduce((sum, row) => (row.amount > ZERO ? sum + row.amount : sum), ZERO);
const negative = (rows: readonly DatedRow[]) => rows.reduce((sum, row) => (row.amount < ZERO ? sum + row.amount : sum), ZERO);
const later = (a: string, b: string) => (a > b ? a : b);

/**
 * Whether `r = ΣY − ΣX` for some `X ⊆ out` (rows dated in the step that may have posted after it) and some
 * `Y ⊆ into` (rows dated before it, or pending, that may have posted inside it).
 */
function inBand(r: bigint, out: readonly DatedRow[], into: readonly DatedRow[]): boolean {
  return r >= negative(into) - positive(out) && r <= positive(into) - negative(out);
}

const KINDS: ReadonlySet<string> = new Set(BALANCE_ANCHOR_KINDS);
const SOURCES: ReadonlySet<string> = new Set(['statement-facts', 'checking-import']);
const CLASSES: ReadonlySet<string> = new Set(['posting', 'timing', 'pending']);

function readableInput(input: BalanceChainInput): boolean {
  return typeof input.accountId === 'string' && typeof input.currency === 'string'
    && input.anchors.every((anchor) => isCheckingDate(anchor.date) && Number.isSafeInteger(anchor.balanceMinor)
      && KINDS.has(anchor.kind) && SOURCES.has(anchor.source) && typeof anchor.ref === 'string')
    && input.rows.every((row) => typeof row.id === 'string' && isCheckingDate(row.date) && Number.isSafeInteger(row.amountMinor)
      && CLASSES.has(row.rowClass) && typeof row.currency === 'string'
      && (row.version === undefined || (Number.isSafeInteger(row.version) && row.version >= 0)))
    && input.coverage.every((range) => isCheckingDate(range.start) && isCheckingDate(range.end) && range.start <= range.end);
}

function mergeAnchors(anchors: readonly BalanceAnchorInput[]): MergedAnchor[] {
  const byDate = new Map<string, BalanceAnchorInput[]>();
  for (const anchor of anchors) {
    const list = byDate.get(anchor.date);
    if (list) list.push(anchor);
    else byDate.set(anchor.date, [anchor]);
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, list]) => {
    const ranked = [...list].sort((a, b) => balanceAnchorRank(a.kind, a.source) - balanceAnchorRank(b.kind, b.source)
      || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    const conflicted = list.some((anchor) => anchor.balanceMinor !== list[0].balanceMinor);
    return {
      date, conflicted, primary: ranked[0], rank: balanceAnchorRank(ranked[0].kind, ranked[0].source),
      balance: conflicted ? null : BigInt(list[0].balanceMinor), refs: [...new Set(list.map((anchor) => anchor.ref))].sort(),
    };
  });
}

/**
 * What an accepted failing step is frozen to: its rows' ids, dates, classes and change counts, and its anchors' refs.
 * No amount: an amount changed in place moves its row's change count instead.
 */
function pinOf(rules: string, accountId: string, from: string, to: string, rows: readonly DatedRow[], start: MergedAnchor, end: MergedAnchor): string {
  const ids = [...new Map(rows.map((row) => [row.id, [row.id, row.date, row.rowClass, row.version]])).values()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return letterDigest(['holdr.balance-chain-pin', 1, rules, accountId, from, to, ids, start.refs, end.refs]);
}

/** Checks one account's chain. The result holds dates, counts, codes and digests only: no amount, balance or residual. */
export function verifyBalanceChain(input: BalanceChainInput, options: BalanceChainOptions = {}): BalanceChainResult {
  const L = options.timingWindowDays ?? BALANCE_CHAIN_TIMING_WINDOW_DAYS;
  if (!Number.isSafeInteger(L) || L < 1 || L > 90) throw new RangeError('timingWindowDays must be a whole number of days from 1 to 90');
  const rules = options.rules ?? balanceChainRules({ timingWindowDays: L });
  const timingAccount = input.rows.some((row) => row.rowClass === 'timing' && row.currency === input.currency);
  const empty = { total: input.anchors.length, chained: 0, beforeHistory: 0, conflicted: 0, byKind: {}, list: [] };
  if (!readableInput(input)) {
    return {
      verifier: BALANCE_CHAIN_VERIFIER, rules, readable: false, dateBasis: timingAccount ? 'timing' : 'posting', state: 'not-yet-checked',
      result: 'unknown', reconciledFrom: null, reconciledThrough: null, latestRun: null, latestAnchor: null, latestStatementAnchor: null,
      history: null, anchors: empty, steps: [],
    };
  }

  const coverage = mergeCheckingRanges(input.coverage);
  const covers = (start: string, end: string) => checkingRangesCover(coverage, start, end);
  const rows: DatedRow[] = input.rows
    .map((row): DatedRow => ({ id: row.id, date: row.date, amount: BigInt(row.amountMinor),
      rowClass: row.currency === input.currency ? row.rowClass : 'other-currency', version: row.version ?? 0 }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const posted = rows.filter((row) => row.rowClass === 'posting' || row.rowClass === 'timing');
  const postingRows = rows.filter((row) => row.rowClass === 'posting');
  const timingRows = rows.filter((row) => row.rowClass === 'timing');
  const pendingRows = rows.filter((row) => row.rowClass === 'pending');
  const otherRows = rows.filter((row) => row.rowClass === 'other-currency');

  const merged = mergeAnchors(input.anchors);
  const firstCovered = coverage.length > 0 ? coverage[0].start : null;
  // The chain starts where Holdr's history does: for a timing account, where the rows that may straddle it are claimed.
  const startIndex = firstCovered === null ? -1 : merged.findIndex((anchor) => !anchor.conflicted && (timingAccount
    ? covers(addCheckingDays(anchor.date, 1 - L), anchor.date)
    : anchor.date >= addCheckingDays(firstCovered, -1)));
  const chained = startIndex === -1 ? [] : merged.slice(startIndex);

  const steps: BalanceChainStep[] = [];
  for (let i = 1; i < chained.length; i += 1) {
    const start = chained[i - 1];
    const end = chained[i];
    const from = start.date;
    const to = end.date;
    const back = addCheckingDays(from, -L);
    const push = (verdict: BalanceStepVerdict, reason: BalanceStepReason, extra: { pin?: string; timingWouldExplain?: boolean } = {}) => {
      steps.push({ from, to, verdict, reason, ...extra });
    };
    if (start.conflicted || end.conflicted) {
      push('fail', 'anchor-conflict', { pin: pinOf(rules, input.accountId, from, to, within(rows, back, to), start, end) });
      continue;
    }
    if (!covers(timingAccount ? addCheckingDays(from, 1 - L) : addCheckingDays(from, 1), to)) {
      push('unknown', 'gap');
      continue;
    }
    if (within(otherRows, back, to).length > 0) {
      push('unknown', 'currency');
      continue;
    }
    const inStep = within(posted, from, to);
    const r = end.balance! - start.balance! - total(inStep);
    const outEdge = later(from, addCheckingDays(to, -L));
    const leaving = within(timingRows, outEdge, to);
    const entering = [...within(timingRows, back, from), ...within(pendingRows, back, to)];
    if (!inBand(r, leaving, entering)) {
      const extra: { pin?: string; timingWouldExplain?: boolean } = { pin: pinOf(rules, input.accountId, from, to, [...inStep, ...entering], start, end) };
      if (!timingAccount) {
        // Design D3's test: would the posting rows near the two dates, read as timing rows, explain the residual?
        extra.timingWouldExplain = inBand(r, within(postingRows, outEdge, to), [...within(postingRows, back, from), ...within(pendingRows, back, to)]);
      }
      push('fail', 'mismatch', extra);
      continue;
    }
    if (r === ZERO) {
      if (timingAccount) push('unknown', 'as-dated');
      else push('pass', leaving.length === 0 && entering.length === 0 ? 'exact' : 'as-dated');
      continue;
    }
    push('unknown', timingAccount && (leaving.length > 0 || entering.some((row) => row.rowClass === 'timing')) ? 'date-basis' : 'pending');
  }

  let reconciledThrough: string | null = null;
  let latestRun: BalanceChainResult['latestRun'] = null;
  if (!timingAccount) {
    for (const step of steps) {
      if (step.verdict !== 'pass') break;
      reconciledThrough = step.to;
    }
    // The latest run of passing steps, walked back from the newest step.
    let runFrom: string | null = null;
    let runThrough: string | null = null;
    let runSteps = 0;
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i].verdict !== 'pass') {
        if (runSteps > 0) break;
        continue;
      }
      runFrom = steps[i].from;
      if (runThrough === null) runThrough = steps[i].to;
      runSteps += 1;
    }
    if (runFrom !== null && runThrough !== null) latestRun = { from: runFrom, through: runThrough, steps: runSteps };
  }
  const failing = steps.some((step) => step.verdict === 'fail');
  const lastChained = chained.length > 0 ? chained[chained.length - 1].date : null;
  const state: BalanceChainState = failing ? 'failing'
    : reconciledThrough !== null && reconciledThrough === lastChained ? 'balanced'
      : reconciledThrough !== null ? 'partly-balanced' : 'not-yet-checked';
  const byKind: Partial<Record<BalanceAnchorKind, number>> = {};
  for (const anchor of input.anchors) byKind[anchor.kind] = (byKind[anchor.kind] ?? 0) + 1;
  const chainedDates = new Set(chained.map((anchor) => anchor.date));
  const list = merged.map((anchor): BalanceChainAnchorRef => ({
    date: anchor.date, kind: anchor.primary.kind, source: anchor.primary.source, rank: anchor.rank, ref: anchor.primary.ref,
    refs: [...anchor.refs],
    state: anchor.conflicted ? 'conflict' : chainedDates.has(anchor.date) ? 'chained' : 'before-history',
  }));
  const statementDates = input.anchors.filter((anchor) => anchor.kind === 'statement-closing').map((anchor) => anchor.date).sort();
  return {
    verifier: BALANCE_CHAIN_VERIFIER,
    rules,
    readable: true,
    dateBasis: timingAccount ? 'timing' : 'posting',
    state,
    result: failing ? 'fail' : state === 'balanced' ? 'pass' : 'unknown',
    reconciledFrom: reconciledThrough === null ? null : chained[0].date,
    reconciledThrough,
    latestRun,
    latestAnchor: merged.length > 0 ? merged[merged.length - 1].date : null,
    latestStatementAnchor: statementDates.length > 0 ? statementDates[statementDates.length - 1] : null,
    history: coverage.length === 0 ? null : { from: coverage[0].start, through: coverage[coverage.length - 1].end, uncoveredRuns: coverage.length - 1 },
    anchors: {
      total: input.anchors.length,
      chained: chained.length,
      beforeHistory: list.filter((anchor) => anchor.state === 'before-history').length,
      conflicted: merged.filter((anchor) => anchor.conflicted).length,
      byKind,
      list,
    },
    steps,
  };
}
