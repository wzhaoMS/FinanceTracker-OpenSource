/**
 * Fail-closed check, independent of how a parser joins or splits fields: no
 * stored field of a row, alone or put together with the row's other stored
 * fields, may show five consecutive digits of a card number found in the
 * row's raw text. Redaction keeps a card's last four digits, so this catches
 * a second, shortened copy of the number (a repeated NAME, a reference)
 * whose digits survive next to the redacted one and would rebuild it.
 *
 * Candidates are full card numbers as the shared recognizer sees them, in
 * the raw text normalized as card import stores it: in a run of digits,
 * masks and separators that it counts as card data, a stretch of whole digit
 * groups, or the stretch with stray digits dropped at either end, of 12 to
 * 19 digits that cardNetwork accepts and that pass the Luhn check (UnionPay
 * excepted, as in cardNumbers). Stored text is compared as digits only: each
 * redaction the redactor writes (`***` and the four digits it keeps) is left
 * out whole, and every other digit of a field, then of the fields joined in
 * each order, is read as one string, however many redactions and letters lie
 * between them. This only ever refuses a row; it redacts nothing and never
 * makes a row acceptable.
 */
import { normalizeCardImportText } from '../cardImport.js';
import { cardNetwork, containsCardData, luhnValid } from '../cardNumbers.js';

const MIN_DIGITS = 12;
const MAX_DIGITS = 19;
const WINDOW = 5;
/**
 * The shared recognizer's separators and masks (cardNumbers.ts), copied; a
 * test checks them against it character by character. X and # are masks
 * only outside words, which this check does not model: masks never join digit
 * groups, so leaving them out can only split a run.
 */
export const CARD_SPAN_SEPARATOR = /[\s\u0085\p{Pd}\u2043\u2212./\\,_|'·∙⋅]/u;
export const CARD_SPAN_MASK = /[*•●∗⁎]/u;
const CARD_RUN = new RegExp(`(?:[0-9]|${CARD_SPAN_SEPARATOR.source}|${CARD_SPAN_MASK.source})+`, 'gu');
const MASK_RUN = new RegExp(`${CARD_SPAN_MASK.source}+`, 'u');
const FORMAT = /\p{Cf}/gu;
// A redaction exactly as the redactor writes it: `***` and the last four digits it keeps.
const KEPT_LAST_FOUR = /\*\*\*[0-9]{4}(?![0-9])/g;

function isCardNumber(digits: string): boolean {
  const network = cardNetwork(digits);
  return network !== null && (network === 'unionpay' || luhnValid(digits));
}

/** Card numbers in one stretch of digit groups (masks split stretches, separators split groups). */
function addCardNumbers(groups: readonly string[], found: Set<string>): void {
  const digits = groups.join('');
  if (digits.length < MIN_DIGITS) return;
  for (let first = 0; first < groups.length; first += 1) {
    let candidate = '';
    for (let last = first; last < groups.length; last += 1) {
      candidate += groups[last];
      if (candidate.length > MAX_DIGITS) break;
      if (candidate.length >= MIN_DIGITS && isCardNumber(candidate)) found.add(candidate);
    }
  }
  for (let length = MIN_DIGITS; length <= Math.min(MAX_DIGITS, digits.length); length += 1) {
    for (const candidate of [digits.slice(0, length), digits.slice(-length)]) if (isCardNumber(candidate)) found.add(candidate);
  }
}

/** Runs of digits, separators and masks, where card spans lie, in raw text normalized as card import stores it. */
export function cardRuns(text: string): string[] {
  return [...normalizeCardImportText(text).replace(FORMAT, '').matchAll(CARD_RUN)].map(([run]) => run);
}

/** Full card numbers in raw text, digits only: only those in runs the shared recognizer redacts. */
export function cardNumberCandidates(text: string): Set<string> {
  const found = new Set<string>();
  for (const run of cardRuns(text)) {
    if (!/[0-9]/.test(run) || !containsCardData(run)) continue;
    for (const stretch of run.split(MASK_RUN)) addCardNumbers(stretch.split(/[^0-9]+/).filter(Boolean), found);
  }
  return found;
}

/** Every ordering of every non-empty selection of `items`. */
function arrangements(items: readonly string[]): string[][] {
  const out: string[][] = [];
  const extend = (chosen: string[], rest: readonly string[]) => {
    for (let index = 0; index < rest.length; index += 1) {
      const next = [...chosen, rest[index]];
      out.push(next);
      extend(next, [...rest.slice(0, index), ...rest.slice(index + 1)]);
    }
  };
  extend([], items);
  return out;
}

/**
 * True when the stored fields of a row, alone or joined in any order, show
 * five consecutive digits of a card number in any of the row's raw source
 * texts (ParsedRow.sourceTexts, which include the joins a parser makes),
 * counting every digit outside the redactions' kept last four.
 */
export function showsCardDigits(stored: ReadonlyArray<string | null>, sources: ReadonlyArray<string | null>): boolean {
  const windows = new Set<string>();
  for (const text of sources) {
    if (typeof text !== 'string' || text === '') continue;
    for (const candidate of cardNumberCandidates(text)) {
      for (let i = 0; i + WINDOW <= candidate.length; i += 1) windows.add(candidate.slice(i, i + WINDOW));
    }
  }
  if (windows.size === 0) return false;
  // Each field's digits in order, without the four each redaction keeps; nothing else splits them.
  const shown = stored
    .filter((text): text is string => typeof text === 'string' && text !== '')
    .map((text) => text.replace(KEPT_LAST_FOUR, '').replace(/[^0-9]/g, ''));
  for (const arrangement of arrangements(shown)) {
    const digits = arrangement.join('');
    for (let i = 0; i + WINDOW <= digits.length; i += 1) if (windows.has(digits.slice(i, i + WINDOW))) return true;
  }
  return false;
}
