import type { Transaction } from '@finance-tracker/shared';

export type RawRow = Record<string, string>;

export interface MapResult {
  transactions: Transaction[];
  /** Rows we couldn't confidently map, for human review. */
  rejected: { row: RawRow; reason: string }[];
  /** Which header we matched for each canonical field (debug aid for the UI). */
  mapping: Record<'symbol' | 'quantity' | 'price' | 'cost', string | null>;
}

const SYMBOL_HEADERS = ['symbol', 'ticker'];
const QUANTITY_HEADERS = ['quantity', 'qty', 'shares', 'units', 'share'];
const PRICE_HEADERS = ['last price', 'price', 'current price', 'last'];
const COST_HEADERS = ['average cost basis', 'avg cost', 'average cost', 'cost basis', 'cost per share'];

function pickHeader(headers: string[], candidates: string[]): string | null {
  const normalized = headers.map((h) => h.toLowerCase().trim());
  for (const c of candidates) {
    const i = normalized.findIndex((h) => h === c);
    if (i >= 0) return headers[i];
  }
  for (const c of candidates) {
    const i = normalized.findIndex((h) => h.includes(c));
    if (i >= 0) return headers[i];
  }
  return null;
}

/** Strip currency symbols, commas, parentheses and trailing G/L deltas. */
export function parseNumber(input: string | undefined): number | null {
  if (!input) return null;
  // Common pattern: "13.14 -0.16 (-1.20%)" — keep first numeric token.
  const first = input.replace(/[,$]/g, '').trim().split(/\s+/)[0];
  const n = Number(first.replace(/[()%]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseQuantity(input: string | undefined): number | null {
  if (!input) return null;
  return parseNumber(input.replace(/,/g, ''));
}

/**
 * Extract a clean ticker from a cell. Real-world cells often look like:
 *   "AAPL"               → AAPL
 *   "AAPL Apple Inc"     → AAPL  (whitespace separator)
 *   "AAPL\nApple Inc"    → AAPL  (newline separator)
 *
 * Pathological case (webhand bug — recorded in the
 * webhand repo): when the source cell uses <br> as the separator, webhand
 * collapses to "AAPLAPPLE INC" with NO separator. We can't recover reliably
 * from that, so we return null and let the row be rejected for review.
 */
export function parseSymbol(input: string | undefined): { symbol: string | null; ambiguous: boolean } {
  if (!input) return { symbol: null, ambiguous: false };
  const trimmed = input.trim();
  if (!trimmed) return { symbol: null, ambiguous: false };
  // Newline-separated → first line.
  const firstLine = trimmed.split(/\r?\n/)[0].trim();
  // Whitespace-separated → first token.
  const firstToken = firstLine.split(/\s+/)[0];
  // If we have a clean short token (typical ticker length 1-5), accept it.
  if (/^[A-Z][A-Z0-9.\-]{0,4}$/.test(firstToken)) {
    return { symbol: firstToken, ambiguous: false };
  }
  // No separators and length > 5 → ambiguous, can't split ticker from name.
  if (/^[A-Z0-9.\-]+$/.test(firstToken) && firstToken.length > 5) {
    return { symbol: firstToken.slice(0, 5), ambiguous: true };
  }
  return { symbol: firstToken.toUpperCase().slice(0, 5), ambiguous: false };
}

export function mapTableToTransactions(
  accountId: string,
  asOf: string,
  headers: string[],
  rows: RawRow[],
): MapResult {
  const symbolHeader = pickHeader(headers, SYMBOL_HEADERS);
  const qtyHeader = pickHeader(headers, QUANTITY_HEADERS);
  const priceHeader = pickHeader(headers, PRICE_HEADERS);
  const costHeader = pickHeader(headers, COST_HEADERS);

  const transactions: Transaction[] = [];
  const rejected: MapResult['rejected'] = [];

  if (!symbolHeader || !qtyHeader) {
    return {
      transactions: [],
      rejected: rows.map((row) => ({ row, reason: 'missing Symbol or Quantity column in headers' })),
      mapping: { symbol: symbolHeader, quantity: qtyHeader, price: priceHeader, cost: costHeader },
    };
  }

  for (const [i, row] of rows.entries()) {
    const { symbol, ambiguous } = parseSymbol(row[symbolHeader]);
    const qty = parseQuantity(row[qtyHeader]);
    // Prefer Average Cost; fall back to current price if cost not provided.
    const cost = costHeader ? parseNumber(row[costHeader]) : null;
    const px = priceHeader ? parseNumber(row[priceHeader]) : null;
    const pricePerUnit = cost ?? px;

    if (!symbol || /^cash$/i.test(symbol)) {
      rejected.push({ row, reason: 'cash or non-symbol row — set as account cash instead' });
      continue;
    }
    if (ambiguous) {
      // The row itself comes back with the reason; the reason does not repeat its text.
      rejected.push({
        row,
        reason: 'ambiguous ticker (no separator between ticker and name — likely a <br> swallowed by the extractor)',
      });
      continue;
    }
    if (qty == null || qty === 0) {
      rejected.push({ row, reason: 'quantity not parseable or zero' });
      continue;
    }
    if (pricePerUnit == null) {
      rejected.push({ row, reason: 'no average-cost or price column found' });
      continue;
    }

    transactions.push({
      id: `imp-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      accountId,
      symbol,
      date: asOf,
      quantity: qty,
      pricePerUnit,
      currency: 'USD',
      notes: 'imported',
    });
  }

  return {
    transactions,
    rejected,
    mapping: { symbol: symbolHeader, quantity: qtyHeader, price: priceHeader, cost: costHeader },
  };
}
