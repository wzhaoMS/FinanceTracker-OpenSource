/**
 * Pure parsing helpers for the broker activity importer.
 *
 * The bridge (`apps/portfolio-bridge`) scrapes Fidelity's "Activity & Orders"
 * page and hands us rows as-strings. This module turns those strings into
 * a structured ParsedActivity, computes a stable dedup fingerprint, and
 * decides per-row whether we want to import, skip, or reject it.
 *
 * Everything here is pure (no I/O, no DB) so it's exhaustively unit-testable.
 */

import { createHash } from 'node:crypto';
import { buildOccSymbol } from '@finance-tracker/shared';

/** Raw shape the bridge produces. All fields are user-facing strings. */
export interface ActivityRow {
  /** e.g. "May-07-2026" — broker's display format. */
  date: string;
  /** e.g. "BrokerageLink ***2943" — the Account column text. */
  accountLabel: string;
  /** e.g. "YOU BOUGHT NEBIUS GROUP N V COM USD0.01 CL A (NBIS) (Cash)". */
  description: string;
  /** e.g. "-$127.00" — the visible Amount column. */
  amount: string;
  /** e.g. "1" — only present after the row was expanded. */
  quantity?: string;
  /** e.g. "$127.00" — only present after the row was expanded. */
  pricePerUnit?: string;
}

/**
 * What the description tells us happened. We resolve this even for cash
 * events so the UI can show "12 dividend rows skipped" instead of a
 * generic "couldn't parse".
 */
export type ParsedAction =
  | 'BUY'
  | 'SELL'
  | 'BUY_TO_OPEN'
  | 'SELL_TO_OPEN'
  | 'BUY_TO_CLOSE'
  | 'SELL_TO_CLOSE'
  | 'REINVEST'
  | 'DIVIDEND'
  | 'TRANSFER'
  | 'CONTRIB'
  | 'ACH'
  | 'UNKNOWN';

/** Successfully parsed row, ready for fingerprinting / classification. */
export interface ParsedActivity {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** Last-4 alphanumerics of the broker account label. May be null when
   *  the account column was missing or unreadable. */
  accountLast4: string | null;
  action: ParsedAction;
  /** Ticker, when the description carried one. Cash events have no symbol. */
  symbol: string | null;
  /** Signed quantity: positive for BUY/REINVEST, negative for SELL.
   *  Null when the row's expanded panel didn't expose a quantity, which
   *  is normal for cash events. */
  quantity: number | null;
  /** Per-share price, always positive. Null for cash events. */
  pricePerUnit: number | null;
  /** Always positive when present. Fees aren't on the activity grid by
   *  default; reserved for a phase-2 expand-to-detail extractor. */
  fees: number | null;
  instrumentType?: 'option';
  contractMultiplier?: number;
  positionEffect?: 'open' | 'close';
  parseError?: string;
  /** Original description preserved verbatim — useful for debugging
   *  and as the `notes` field on the resulting Transaction. */
  rawDescription: string;
  /** Original amount preserved verbatim. */
  rawAmount: string;
}

/* ------------------------------------------------------------------ */
/* Date parsing                                                       */
/* ------------------------------------------------------------------ */

const MONTH_ABBREV: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/**
 * Parse Fidelity's `Mon-DD-YYYY` date string into ISO `YYYY-MM-DD`.
 * Returns null on any unexpected shape — the caller treats null as a
 * reject reason, never as a silent fallback.
 */
export function parseFidelityDate(s: string): string | null {
  const m = s.trim().match(/^([A-Z][a-z]{2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const mm = MONTH_ABBREV[m[1]];
  if (!mm) return null;
  const dd = m[2].length === 1 ? `0${m[2]}` : m[2];
  const year = Number(m[3]);
  const month = Number(mm);
  const day = Number(dd);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${m[3]}-${mm}-${dd}`;
}

/* ------------------------------------------------------------------ */
/* Money / quantity parsing                                           */
/* ------------------------------------------------------------------ */

/**
 * Parse a money string like "-$13,663.00", "+$152.07", "$127.00" into a
 * signed number. Returns null on garbage. The leading `+`/`-` matters:
 * Fidelity uses negative for outflows (purchases, debits) and positive
 * for inflows (sales, credits). Returns the signed magnitude, leaving
 * the importer to decide whether to keep the sign.
 */
export function parseSignedMoney(s: string | undefined): number | null {
  if (!s) return null;
  const raw = s.replace(/[,\s]/g, '').trim();
  if (!raw) return null;
  const m = raw.match(/^([+\-])?\$?([0-9]+(?:\.[0-9]+)?)$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const n = Number(m[2]);
  return Number.isFinite(n) ? sign * n : null;
}

/**
 * Parse a quantity string into the magnitude. Comma-tolerant. Tolerates
 * a leading `+`/`-` because Fidelity's expanded-row panel formats SELL
 * shares as `-1.000` and BUYs as `+1.000`; the sign convention is
 * applied downstream by `parseActivityRow` based on the action verb,
 * so here we always return the absolute value.
 *
 * Returns null for empty input, zero, or non-numeric garbage.
 */
export function parseQuantity(s: string | undefined): number | null {
  if (!s) return null;
  const raw = s.replace(/[,\s]/g, '').trim();
  if (!raw) return null;
  const m = raw.match(/^([+\-])?([0-9]+(?:\.[0-9]+)?)$/);
  if (!m) return null;
  const n = Number(m[2]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* ------------------------------------------------------------------ */
/* Account-label parsing                                              */
/* ------------------------------------------------------------------ */

/**
 * Extract last-4 alphanumerics from a label like "BrokerageLink ***2943"
 * or "ROTH IRA ***6741". Falls back to the last 4 of any digits in the
 * label for portals that don't use the `***` mask. Returns null when
 * fewer than 4 alphanumeric characters exist.
 */
export function parseAccountLast4(label: string | undefined): string | null {
  if (!label) return null;
  // Prefer an explicit ***NNNN suffix; it's the strongest signal.
  const masked = label.match(/\*{2,}\s*([A-Za-z0-9]{4,})\s*$/);
  if (masked) return masked[1].slice(-4);
  // Fall back to "last 4 alphanumerics anywhere in the label".
  const stripped = label.replace(/[^A-Za-z0-9]/g, '');
  return stripped.length >= 4 ? stripped.slice(-4) : null;
}

/* ------------------------------------------------------------------ */
/* Description parsing                                                */
/* ------------------------------------------------------------------ */

/**
 * Pattern table — checked in order, first match wins. Each entry returns
 * the action; symbol-bearing patterns also pull the ticker out of the
 * trailing parenthetical, e.g. "(NBIS)".
 *
 * Tickers run 1–6 alphanumerics + `.` + `-` (covers BRK.B, RDS-A style).
 *
 * Ordering matters: REINVESTMENT must come before BUY because some real
 * Fidelity descriptions look like "REINVESTMENT YOU BOUGHT" (rare but
 * documented). Specifics first.
 */
const TICKER = '([A-Z0-9.\\-]{1,8})';
const OPTION_DESCRIPTION = /^YOU\s+(BOUGHT|SOLD)\s+(OPENING|CLOSING)\s+TRANSACTION\s+(PUT|CALL)\s+\(([A-Z]{1,6})\)\s+.+?\s+([A-Z]{3})\s+(\d{1,2})\s+(\d{2})\s+\$([0-9,]+(?:\.\d{1,3})?)\s+\((\d+)\s+SHS\)\s+\((?:Cash|Margin)\)$/i;

const ACTION_PATTERNS: Array<{ re: RegExp; action: ParsedAction; capturesSymbol: boolean }> = [
  // Non-greedy `.+?` so we capture the FIRST parenthetical (the ticker),
  // not the trailing `(Cash)` / `(Margin)` qualifier. Backslashes are
  // doubled because these are template-literal strings: in JS strings,
  // `\s` is an unknown escape and silently becomes just `s`.
  { re: new RegExp(`^REINVESTMENT\\s.+?\\(${TICKER}\\)`, 'i'), action: 'REINVEST', capturesSymbol: true },
  { re: new RegExp(`^DIVIDEND\\s+RECEIVED\\b`, 'i'),             action: 'DIVIDEND', capturesSymbol: false },
  { re: new RegExp(`^YOU\\s+BOUGHT\\s.+?\\(${TICKER}\\)`, 'i'), action: 'BUY',      capturesSymbol: true },
  { re: new RegExp(`^YOU\\s+SOLD\\s.+?\\(${TICKER}\\)`, 'i'),   action: 'SELL',     capturesSymbol: true },
  // Regex literals (slashes) handle backslashes correctly without doubling.
  { re: /^TRANSFERRED\b/i,                                     action: 'TRANSFER', capturesSymbol: false },
  { re: /^(?:Contributions|PARTIC\s+CONTR)\b/i,               action: 'CONTRIB',  capturesSymbol: false },
  { re: /^(?:Electronic\s+Funds\s+Transfer|DIRECT\s+DEBIT)\b/i, action: 'ACH',  capturesSymbol: false },
];

/**
 * Classify a Fidelity activity description and (when applicable) extract
 * the ticker. Always returns an action — `UNKNOWN` for anything we
 * haven't seen, which the importer surfaces in the rejected pile rather
 * than guessing.
 */
export function parseDescription(desc: string): {
  action: ParsedAction;
  symbol: string | null;
  instrumentType?: 'option';
  contractMultiplier?: number;
  positionEffect?: 'open' | 'close';
  parseError?: string;
} {
  const trimmed = (desc ?? '').trim();
  const optionMatch = trimmed.match(OPTION_DESCRIPTION);
  if (optionMatch) {
    const [, sideRaw, effectRaw, optionRaw, underlyingRaw, monthRaw, dayRaw, yearRaw, strikeRaw, multiplierRaw] = optionMatch;
    const side = sideRaw.toUpperCase() as 'BOUGHT' | 'SOLD';
    const positionEffect = effectRaw.toUpperCase() === 'OPENING' ? 'open' : 'close';
    const action = `${side === 'BOUGHT' ? 'BUY' : 'SELL'}_TO_${positionEffect.toUpperCase()}` as ParsedAction;
    const monthKey = monthRaw[0].toUpperCase() + monthRaw.slice(1).toLowerCase();
    const month = MONTH_ABBREV[monthKey];
    const contractMultiplier = Number(multiplierRaw);
    if (!month) {
      return { action, symbol: null, instrumentType: 'option', contractMultiplier, positionEffect, parseError: 'option expiration month is not recognized' };
    }
    if (contractMultiplier !== 100) {
      return { action, symbol: null, instrumentType: 'option', contractMultiplier, positionEffect, parseError: 'adjusted option contracts are not supported' };
    }
    try {
      const symbol = buildOccSymbol({
        underlyingSymbol: underlyingRaw,
        expirationDate: `20${yearRaw}-${month}-${dayRaw.padStart(2, '0')}`,
        optionType: optionRaw.toUpperCase() === 'PUT' ? 'put' : 'call',
        strikePrice: Number(strikeRaw.replace(/,/g, '')),
      });
      return { action, symbol, instrumentType: 'option', contractMultiplier, positionEffect };
    } catch (error) {
      return { action, symbol: null, instrumentType: 'option', contractMultiplier, positionEffect, parseError: (error as Error).message };
    }
  }
  for (const { re, action, capturesSymbol } of ACTION_PATTERNS) {
    const m = trimmed.match(re);
    if (m) {
      const symbol = capturesSymbol ? m[1].toUpperCase() : null;
      return { action, symbol };
    }
  }
  return { action: 'UNKNOWN', symbol: null };
}

/* ------------------------------------------------------------------ */
/* Whole-row parser                                                   */
/* ------------------------------------------------------------------ */

/** Round to 4 decimal places. Used before fingerprinting so insignificant
 *  re-rounding by Fidelity (e.g. $127.0001 → $127.00) doesn't change the
 *  hash on subsequent pulls. */
export function roundTo4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Parse a raw bridge row into a ParsedActivity. Always returns a value;
 * fields that couldn't be parsed are left null and the consumer decides
 * what to do (reject, skip, or import-as-cash-event).
 */
export function parseActivityRow(row: ActivityRow): ParsedActivity {
  const date = parseFidelityDate(row.date) ?? '';
  const accountLast4 = parseAccountLast4(row.accountLabel);
  const description = parseDescription(row.description);
  const { action, symbol } = description;

  const qty = parseQuantity(row.quantity);
  const px = (() => {
    const m = parseSignedMoney(row.pricePerUnit);
    return m != null && m > 0 ? m : null;
  })();

  // Apply sign convention: SELL = negative quantity, everything else
  // (BUY, REINVEST) = positive. Cash events leave qty null.
  const sellAction = action === 'SELL' || action === 'SELL_TO_OPEN' || action === 'SELL_TO_CLOSE';
  const signedQty = qty == null
    ? null
    : sellAction
      ? -qty
      : qty;

  let fees: number | null = null;
  let parseError = description.parseError;
  if (description.instrumentType === 'option' && qty != null && px != null && !parseError) {
    const amount = parseSignedMoney(row.amount);
    if (amount == null || (sellAction ? amount <= 0 : amount >= 0)) {
      parseError = 'option net amount is missing or has the wrong sign';
    } else {
      const grossPremium = qty * (description.contractMultiplier ?? 0) * px;
      const fee = sellAction
        ? grossPremium - Math.abs(amount)
        : Math.abs(amount) - grossPremium;
      if (fee < -0.02 || fee > Math.max(5, qty * 5)) {
        parseError = 'option net amount does not reconcile with contracts and price';
      } else {
        fees = Math.round(Math.max(0, fee) * 100) / 100;
      }
    }
  }

  return {
    date,
    accountLast4,
    action,
    symbol,
    quantity: signedQty,
    pricePerUnit: px,
    fees,
    ...(description.instrumentType === 'option'
      ? {
          instrumentType: 'option' as const,
          contractMultiplier: description.contractMultiplier,
          positionEffect: description.positionEffect,
          ...(parseError ? { parseError } : {}),
        }
      : {}),
    rawDescription: row.description,
    rawAmount: row.amount,
  };
}

/* ------------------------------------------------------------------ */
/* Fingerprint                                                        */
/* ------------------------------------------------------------------ */

/**
 * Stable hash that uniquely identifies an activity row across pulls.
 *
 * Fields chosen for stability across re-renders:
 *   - date          — broker-side; doesn't drift after settlement.
 *   - accountLast4  — survives account renames.
 *   - action        — distinguishes a same-day BUY from a same-day SELL.
 *   - symbol        — ticker.
 *   - quantity@4dp  — rounded so post-settlement re-rounding doesn't shift.
 *   - price@4dp     — same.
 *
 * Deliberately omitted:
 *   - description   — Fidelity occasionally massages the wording.
 *   - amount        — derived from qty*price; redundant.
 *   - notes / fees  — not always present; keeping fingerprint orthogonal.
 *
 * Returns the hex digest. Caller passes this to
 * `repo.findTransactionByFingerprint(accountId, fp)` for the dedup check.
 */
export function computeFingerprint(p: {
  date: string;
  accountLast4: string | null;
  action: ParsedAction;
  symbol: string | null;
  quantity: number | null;
  pricePerUnit: number | null;
}): string {
  const fields = [
    p.date,
    p.accountLast4 ?? '',
    p.action,
    p.symbol ?? '',
    p.quantity != null ? roundTo4(p.quantity).toFixed(4) : '',
    p.pricePerUnit != null ? roundTo4(p.pricePerUnit).toFixed(4) : '',
  ];
  return createHash('sha256').update(fields.join('|')).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Import-decision policy                                             */
/* ------------------------------------------------------------------ */

/**
 * Per-row outcome the importer surfaces to the UI. The importer uses these
 * to bucket rows into "going to commit" vs "skipped" vs "you should
 * review", so users always see why something was or wasn't imported.
 */
export type ImportDecision =
  /** Has a real symbol+qty+price; will become a Transaction. */
  | { kind: 'import' }
  /** Cash-only event we deliberately don't store (DIVIDEND, TRANSFER, …). */
  | { kind: 'skip-cash'; reason: string }
  /** Money-market sweep reinvestment — off by default; user can opt in. */
  | { kind: 'skip-sweep'; reason: string }
  /** Looked importable but the bridge didn't capture qty/price. */
  | { kind: 'reject-incomplete'; reason: string }
  /** Description didn't match any known pattern. */
  | { kind: 'reject-unknown'; reason: string };

export interface ClassifyOptions {
  /**
   * Tickers we treat as money-market cash sweeps. Fidelity's defaults are
   * FDRXX (Fidelity Government Cash Reserves) and SPAXX (Government Money
   * Market). Any REINVESTMENT into one of these is noise — dozens of tiny
   * rows that don't move real positions. Off by default; user can opt in
   * to import them.
   */
  sweepTickers?: ReadonlySet<string>;
  /** Set true when the user has opted into importing sweep reinvestments. */
  importSweep?: boolean;
}

const DEFAULT_SWEEP = new Set(['FDRXX', 'SPAXX']);

/**
 * Decide what to do with a parsed row given user options. Pure function;
 * the importer wires DB writes and previews around the result.
 */
export function classifyForImport(
  p: ParsedActivity,
  opts: ClassifyOptions = {},
): ImportDecision {
  if (p.parseError) {
    return { kind: 'reject-incomplete', reason: p.parseError };
  }
  // Hard skips (cash events) — surface the reason for the UI tally.
  if (p.action === 'DIVIDEND') {
    return { kind: 'skip-cash', reason: 'dividend payment (cash event)' };
  }
  if (p.action === 'TRANSFER') {
    return { kind: 'skip-cash', reason: 'cash transfer' };
  }
  if (p.action === 'CONTRIB') {
    return { kind: 'skip-cash', reason: 'plan contribution (cash event)' };
  }
  if (p.action === 'ACH') {
    return { kind: 'skip-cash', reason: 'ACH / bank transfer (cash event)' };
  }
  if (p.action === 'UNKNOWN') {
    return { kind: 'reject-unknown', reason: 'unrecognized description' };
  }

  // Sweep policy — only applies to REINVEST.
  if (p.action === 'REINVEST') {
    const sweep = opts.sweepTickers ?? DEFAULT_SWEEP;
    if (p.symbol && sweep.has(p.symbol)) {
      if (!opts.importSweep) {
        return { kind: 'skip-sweep', reason: `${p.symbol} money-market sweep reinvestment` };
      }
    }
  }

  // BUY / SELL / REINVEST: must have symbol + qty + price to import.
  if (!p.symbol) {
    return { kind: 'reject-incomplete', reason: 'no ticker parsed from description' };
  }
  if (!p.date) {
    return { kind: 'reject-incomplete', reason: 'date not parseable' };
  }
  if (p.quantity == null || p.quantity === 0) {
    return { kind: 'reject-incomplete', reason: 'quantity missing — expand the row in the broker UI before syncing' };
  }
  if (p.pricePerUnit == null || p.pricePerUnit <= 0) {
    return { kind: 'reject-incomplete', reason: 'price-per-unit missing — expand the row in the broker UI before syncing' };
  }
  if (
    p.instrumentType === 'option'
    && (!p.contractMultiplier || !p.positionEffect || !Number.isInteger(p.quantity))
  ) {
    return { kind: 'reject-incomplete', reason: 'option contract metadata is incomplete' };
  }
  return { kind: 'import' };
}
