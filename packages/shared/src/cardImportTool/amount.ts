/**
 * Exact decimal amounts for issuer exports: strings become integer minor
 * units by digit arithmetic, never through floating point, and anything more
 * precise than the currency allows is refused instead of rounded.
 */

// ISO 4217 currencies whose minor unit is not two digits.
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function currencyExponent(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

export interface AmountSyntax {
  /** `1,234.56` (groups of exactly three). */
  thousands?: boolean;
  /** `12,34` as a decimal comma, for OFX files from comma locales. Not combined with thousands. */
  decimalComma?: boolean;
  /** A `$` after the sign, and `(12.34)` for negatives. */
  symbols?: boolean;
}

export type AmountResult = { ok: true; minor: number } | { ok: false; reason: string };

const PLAIN = /^(\d*)(?:\.(\d+))?$/;
const GROUPED = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/;
const COMMA_DECIMAL = /^(\d*),(\d+)$/;

/** Parses a decimal amount into signed integer minor units. */
export function parseAmount(raw: string, exponent: number, syntax: AmountSyntax = {}): AmountResult {
  let text = raw.trim();
  if (!text) return { ok: false, reason: 'is empty' };
  let negative = false;
  if (syntax.symbols && text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (/^[-+\u2212]/.test(text)) {
    if (negative) return { ok: false, reason: 'is not a number' };
    negative = text[0] !== '+';
    text = text.slice(1).trim();
  }
  if (syntax.symbols && text.startsWith('$')) text = text.slice(1).trim();
  let whole: string;
  let fraction: string;
  const plain = PLAIN.exec(text);
  const grouped = syntax.thousands ? GROUPED.exec(text) : null;
  const comma = syntax.decimalComma ? COMMA_DECIMAL.exec(text) : null;
  if (plain) {
    whole = plain[1];
    fraction = plain[2] ?? '';
  } else if (grouped) {
    whole = grouped[1].replace(/,/g, '');
    fraction = grouped[2] ?? '';
  } else if (comma) {
    whole = comma[1];
    fraction = comma[2];
  } else {
    return { ok: false, reason: 'is not a number' };
  }
  if (!whole && !fraction) return { ok: false, reason: 'is not a number' };
  if (fraction.length > exponent) {
    if (/[^0]/.test(fraction.slice(exponent))) return { ok: false, reason: `has more than ${exponent} decimal places` };
    fraction = fraction.slice(0, exponent);
  }
  const digits = `${whole || '0'}${fraction.padEnd(exponent, '0')}`.replace(/^0+(?=\d)/, '');
  if (digits.length > 15) return { ok: false, reason: 'is too large' };
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) return { ok: false, reason: 'is too large' };
  return { ok: true, minor: negative && minor !== 0 ? -minor : minor };
}

/** `-1,234.56` style text for summaries; deterministic, no locale. */
export function formatMinor(minor: number, exponent: number): string {
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = exponent > 0 ? `.${digits.slice(-exponent)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}
