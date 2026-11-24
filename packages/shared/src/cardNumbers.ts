/**
 * Card-number detection and redaction for text stored in the local finance database.
 *
 * Guarantee: after redaction, no card-length span shows more than four digits.
 *
 * A span is a maximal run of digits, mask symbols and separators that starts and ends on a digit or mask.
 * - Masks: * • ● ∗ ⁎, X and x unless they belong to a word (Xbox; in AmexXXXX only the x of Amex), and # only
 *   when doubled (a single # is a number sign and ends the span, so `Account # XXXX-...` keeps its label).
 * - Separators: whitespace, every dash, and . / \ , _ | ' · ∙ ⋅ in any mix and number.
 * - Everything else, including letters, colons, parentheses, $, @ and a single #, ends a span.
 * Standalone dates (2026-10-16, 2026/10/16, 2026.10.16, 10/16/2026, 16.10.2026, 1/2/26) and amounts with
 * exactly two decimals and at most eight digits (1,234.56, 12.345,67, 1234.56) are cut out of a span, so a
 * date or amount next to a card stays intact, as long as the text beside it shows at most four digits in all
 * once redacted. Next to more digits it stays part of the span, so it cannot hide the digits of a card.
 *
 * A span is card-length when it holds 13 or more digit and mask symbols, or exactly 12 that could be a
 * 12-digit card: only Maestro issues those, so a 12-symbol span must start with a mask or a Maestro prefix.
 * A span is card data when it is card-length and shows five or more digits, or, at any length, when a run of
 * two or more masks is followed, directly or after separators, by five or more digits in a row: a masked
 * card such as `XXXX-90003` (Amex's Account #) then shows more than its last four. A lone x or * is not a
 * mask run there, so `2 x 12345` and `PAYPAL *12345678` stay. Card data is replaced whole by `***` plus its
 * last four symbols, or just `***` when any of those is masked. Replacements are 3 or 7 symbols long and each kept
 * date or amount is judged against its final neighbours, so redacted text never holds card data.
 *
 * Accepted over-redaction: long numeric blobs in free text, such as long reference numbers, IBANs, phone
 * numbers longer than 11 digits, chained IP addresses, or several numbers joined only by separators.
 *
 * Known limit: digits inside a kept date or amount are not counted, so a card number deliberately written in
 * date- or amount-shaped pieces (`4111.11 1111.11 1111.11 11`, or `353011,13` before the rest of a card) shows
 * those pieces. One date or amount and the digits beside it show at most 12 digits, so only a run of them can
 * show a whole card. Card numbers in exports and statements are not written that way.
 */
export type CardNetwork =
  | 'amex' | 'visa' | 'mastercard' | 'discover' | 'diners' | 'jcb' | 'unionpay' | 'maestro'
  | 'mir' | 'rupay' | 'troy' | 'uatp';

/** A detected card number. Only the last four digits are ever exposed. */
export interface CardNumberMatch {
  network: CardNetwork;
  last4: string;
}

interface Span {
  start: number;
  end: number;
  symbols: number;
  digits: number;
  /** Up to six digits before the first mask. */
  leading: string;
  /** The last four symbols when they are all digits, else null. */
  last4: string | null;
  /** A run of two or more masks followed, after any separators, by five or more digits in a row. */
  revealing: boolean;
}

// Invisible format characters (zero-width, soft hyphen, bidi marks, variation selectors) are dropped before scanning.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const OTHER_DIGIT = /(?![0-9])\p{Nd}/gu;
const BREAK = 0;
const DIGIT = 1;
const MASK = 2;
const SEPARATOR = 3;
const X_RUN = 4;
const HASH_RUN = 5;
const MASK_SYMBOLS = '*•●∗⁎';
const SEPARATOR_SYMBOL = /^[\s\u0085\p{Pd}\u2043\u2212./\\,_|'·∙⋅]$/u;
const LETTER_BEFORE = /[\p{L}\p{M}]$/u;
const LETTER_AFTER = /^[\p{L}\p{M}]/u;
const DATE_YEAR_FIRST = /^(?:19|20)\d\d([-/.])(?:0?[1-9]|1[0-2])\1(?:0?[1-9]|[12]\d|3[01])$/;
const DATE_YEAR_LAST = /^(\d{1,2})([-/.])(\d{1,2})\2(?:(?:19|20)\d\d|\d\d)$/;
const AMOUNT = /^(?:\d{1,3}(?:,\d{3})+\.\d\d|\d{1,3}(?:\.\d{3})+,\d\d|\d{1,3}(?:'\d{3})+\.\d\d|\d{1,9}[.,]\d\d)$/;
// Dates and amounts are short, and an amount has at most eight digits (999,999.99), so one of them and the four
// digits allowed beside it can never show a 13-digit card.
const MAX_TOKEN_LENGTH = 16;
const MAX_TOKEN_DIGITS = 8;
const MAESTRO_PREFIXES = ['493698', '50', '56', '57', '58', '59', '6'];
const MIN_PAN_DIGITS = 12;
const MAX_PAN_DIGITS = 19;
const LIMITS = { paths: 50, depth: 32, nodes: 50_000, textChars: 5_000_000 };

const asciiDigits = new Map<string, string>();

function asciiDigit(char: string): string {
  let digit = asciiDigits.get(char);
  if (digit === undefined) {
    // Unicode encodes every decimal digit set as ten contiguous code points starting at zero.
    const code = char.codePointAt(0)!;
    let zero = code;
    while (zero > 0 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
    digit = String((code - zero) % 10);
    asciiDigits.set(char, digit);
  }
  return digit;
}

function normalize(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(OTHER_DIGIT, asciiDigit);
}

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function within(value: number, low: number, high: number): boolean {
  return value >= low && value <= high;
}

/**
 * Network by issuer prefix and length, covering Braintree's credit-card-type table (Elo, Hiper, Hipercard,
 * Naranja and Verve ranges fall inside the Visa, Mastercard, Discover, UnionPay and Maestro ranges), legacy
 * lengths, RuPay and UATP. Null for anything that is not a plausible card number.
 */
export function cardNetwork(digits: string): CardNetwork | null {
  if (!/^\d{12,19}$/.test(digits)) return null;
  const length = digits.length;
  const p1 = Number(digits[0]);
  const p2 = Number(digits.slice(0, 2));
  const p3 = Number(digits.slice(0, 3));
  const p4 = Number(digits.slice(0, 4));
  if ((p2 === 34 || p2 === 37) && length === 15) return 'amex';
  if (p1 === 4 && length >= 13) return 'visa';
  if ((within(p2, 51, 55) || within(p4, 2221, 2720)) && length === 16) return 'mastercard';
  if (within(p4, 2200, 2204) && length >= 16) return 'mir';
  if ((p2 === 62 || p3 === 810 || within(p4, 8110, 8171)) && length >= 14) return 'unionpay';
  if ((p4 === 6011 || within(p3, 644, 649) || p2 === 65) && length >= 16) return 'discover';
  if ((within(p4, 3528, 3589) && length >= 16) || ((p4 === 1800 || p4 === 2131) && length >= 15)) return 'jcb';
  if ((within(p3, 300, 305) || p2 === 36 || p2 === 38 || p2 === 39) && length >= 14) return 'diners';
  if ((p2 === 81 || p2 === 82) && length === 16) return 'rupay';
  if (p4 === 9792 && length === 16) return 'troy';
  if (p1 === 1 && length === 15) return 'uatp';
  // Maestro's IIN space is broad; flagging extra numbers only costs redacted text.
  if (MAESTRO_PREFIXES.some((prefix) => digits.startsWith(prefix))) return 'maestro';
  return null;
}

function isCardNumber(digits: string): CardNetwork | null {
  const network = cardNetwork(digits);
  // Some UnionPay cards do not carry a Luhn check digit.
  return network && (network === 'unionpay' || luhnValid(digits)) ? network : null;
}

const ASCII_KINDS = new Uint8Array(128);
for (let code = 48; code <= 57; code += 1) ASCII_KINDS[code] = DIGIT;
for (const char of ' \t\n\v\f\r-./\\,_|\'') ASCII_KINDS[char.charCodeAt(0)] = SEPARATOR;
ASCII_KINDS['*'.charCodeAt(0)] = MASK;
ASCII_KINDS['X'.charCodeAt(0)] = X_RUN;
ASCII_KINDS['x'.charCodeAt(0)] = X_RUN;
ASCII_KINDS['#'.charCodeAt(0)] = HASH_RUN;
const otherKinds = new Map<number, number>();

function otherKind(codePoint: number): number {
  let kind = otherKinds.get(codePoint);
  if (kind === undefined) {
    const char = String.fromCodePoint(codePoint);
    kind = MASK_SYMBOLS.includes(char) ? MASK : SEPARATOR_SYMBOL.test(char) ? SEPARATOR : BREAK;
    otherKinds.set(codePoint, kind);
  }
  return kind;
}

/** What each UTF-16 unit of normalized text is to a span: a digit, a mask, a separator, or a break. */
function classify(text: string): Uint8Array {
  const kinds = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 128) {
      kinds[index] = ASCII_KINDS[code];
      continue;
    }
    const codePoint = text.codePointAt(index)!;
    kinds[index] = otherKind(codePoint);
    if (codePoint > 0xffff) kinds[++index] = kinds[index - 1];
  }
  // # is a mask only when doubled. X and x are masks unless they belong to a word: a run that a letter follows is
  // part of a word (Xbox, XXL), and after a letter only the first x is (Amex, AmexXXXX-90003).
  for (let start = 0; start < text.length;) {
    const kind = kinds[start];
    if (kind !== X_RUN && kind !== HASH_RUN) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < text.length && kinds[end] === kind) end += 1;
    if (kind === HASH_RUN) {
      kinds.fill(end - start > 1 ? MASK : BREAK, start, end);
    } else if (LETTER_AFTER.test(text.slice(end, end + 2))) {
      kinds.fill(BREAK, start, end);
    } else {
      const word = LETTER_BEFORE.test(text.slice(Math.max(0, start - 2), start)) ? 1 : 0;
      kinds.fill(BREAK, start, start + word);
      kinds.fill(MASK, start + word, end);
    }
    start = end;
  }
  return kinds;
}

function isSpace(code: number): boolean {
  return code === 32 || within(code, 9, 13) || code === 0x85 || code === 0x1680 || code === 0x2028 || code === 0x2029;
}

/** True for a standalone date or an amount with two decimals, which must survive next to a card. */
function isDateOrAmount(word: string): boolean {
  if (DATE_YEAR_FIRST.test(word)) return true;
  const date = DATE_YEAR_LAST.exec(word);
  if (date) {
    const first = Number(date[1]);
    const second = Number(date[3]);
    return within(first, 1, 31) && within(second, 1, 31) && (first <= 12 || second <= 12);
  }
  return AMOUNT.test(word) && word.replace(/\D/g, '').length <= MAX_TOKEN_DIGITS;
}

/** Digit and mask counts of a stretch of a span, kept so that neighbouring stretches combine in constant time. */
interface Stretch {
  start: number;
  end: number;
  symbols: number;
  digits: number;
  /** Up to six digits before the first mask. */
  leading: string;
  masked: boolean;
  /** The last four symbols, masks as `*`. */
  tail: string;
  /** A run of two or more masks followed, after any separators, by five or more digits in a row. */
  revealing: boolean;
  /** Length of the mask run that the last symbols form, or 0 when a digit came after it. */
  trailingMasks: number;
  /** Length of the run of digits the symbols start with, or 0 when they start with a mask. */
  leadingRun: number;
}

function stretchOf(text: string, kinds: Uint8Array, start: number, end: number): Stretch {
  let symbols = 0;
  let digits = 0;
  let leading = '';
  let masked = false;
  let tail = '';
  let revealing = false;
  let leadingRun = 0;
  // The current run of masks or digits, the mask run waiting for digits, and that run's length when digits began.
  let run = 0;
  let trailingMasks = 0;
  let masksBefore = 0;
  for (let index = start; index < end; index += 1) {
    const kind = kinds[index];
    if (kind !== DIGIT && kind !== MASK) {
      run = 0;
      continue;
    }
    const continues = index > start && kinds[index - 1] === kind;
    run = continues ? run + 1 : 1;
    if (kind === DIGIT) {
      digits += 1;
      if (!masked && leading.length < 6) leading += text[index];
      if (!continues) masksBefore = trailingMasks;
      trailingMasks = 0;
      if (masksBefore >= 2 && run >= 5) revealing = true;
      // The first run of digits, while nothing else has come before it.
      if (run === symbols + 1) leadingRun = run;
    } else {
      masked = true;
      trailingMasks = run;
    }
    symbols += 1;
    tail = (tail + (kind === DIGIT ? text[index] : '*')).slice(-4);
  }
  return { start, end, symbols, digits, leading, masked, tail, revealing, trailingMasks, leadingRun };
}

function joined(left: Stretch, right: Stretch): Stretch {
  return {
    start: left.start,
    end: right.end,
    symbols: left.symbols + right.symbols,
    digits: left.digits + right.digits,
    leading: left.masked || left.leading.length >= 6 ? left.leading : (left.leading + right.leading).slice(0, 6),
    masked: left.masked || right.masked,
    tail: (left.tail + right.tail).slice(-4),
    // Separators always lie between joined stretches, so runs never continue across the join.
    revealing: left.revealing || right.revealing || (left.trailingMasks >= 2 && right.leadingRun >= 5),
    trailingMasks: right.symbols > 0 ? right.trailingMasks : left.trailingMasks,
    leadingRun: left.symbols > 0 ? left.leadingRun : right.leadingRun,
  };
}

/** Digits a stretch shows once redacted: the last four of card data (none when masked), or all of them. */
function shownDigits(stretch: Stretch): number {
  if (!isCardData(stretch)) return stretch.digits;
  return /^\d{4}$/.test(stretch.tail) ? 4 : 0;
}

function addSpan(text: string, kinds: Uint8Array, stretch: Stretch, spans: Span[]): void {
  let { start, end } = stretch;
  while (start < end && kinds[start] === SEPARATOR) start += 1;
  while (end > start && kinds[end - 1] === SEPARATOR) end -= 1;
  if (start === end) return;
  const last4 = /^\d{4}$/.test(stretch.tail) ? stretch.tail : null;
  const { symbols, digits, leading, revealing } = stretch;
  spans.push({ start, end, symbols, digits, leading, last4, revealing });
}

/**
 * Spans of normalized text. A standalone date or amount is cut out when the text on both sides of it shows at
 * most four digits in all once redacted, so `Card ****6011 2026-10-16` keeps its date; next to more digits
 * (`NNNN NNNN NNNN NNNN,25`, N = digit) it stays part of the span, so it cannot hide the digits of a card. Tokens are
 * decided left to right, and absorbing one re-checks the kept tokens before it against the larger stretch, so
 * every kept token meets the rule against its final neighbours and redacted text is never redacted again.
 */
function cardSpans(text: string): { kinds: Uint8Array; spans: Span[] } {
  const kinds = classify(text);
  const spans: Span[] = [];
  for (let start = 0; start < text.length;) {
    if (kinds[start] !== DIGIT && kinds[start] !== MASK) {
      start += 1;
      continue;
    }
    let end = start;
    let stop = start;
    for (; stop < text.length && kinds[stop] !== BREAK; stop += 1) if (kinds[stop] !== SEPARATOR) end = stop + 1;
    // Whitespace-delimited words that are dates or amounts, ignoring separators at their edges.
    const tokens: number[] = [];
    for (let word = start; word < end;) {
      while (word < end && isSpace(text.charCodeAt(word))) word += 1;
      let wordEnd = word;
      while (wordEnd < end && !isSpace(text.charCodeAt(wordEnd))) wordEnd += 1;
      let first = word;
      let last = wordEnd;
      while (first < last && kinds[first] === SEPARATOR) first += 1;
      while (last > first && kinds[last - 1] === SEPARATOR) last -= 1;
      if (last > first && last - first <= MAX_TOKEN_LENGTH && isDateOrAmount(text.slice(first, last))) tokens.push(first, last);
      word = wordEnd;
    }
    // Kept tokens, each with the stretch before it; `left` is the stretch before the next token.
    const kept: Array<{ before: Stretch; token: Stretch }> = [];
    let left = stretchOf(text, kinds, start, tokens.length > 0 ? tokens[0] : end);
    for (let index = 0; index < tokens.length; index += 2) {
      const token = stretchOf(text, kinds, tokens[index], tokens[index + 1]);
      const right = stretchOf(text, kinds, tokens[index + 1], index + 2 < tokens.length ? tokens[index + 2] : end);
      if (shownDigits(left) + shownDigits(right) <= 4) {
        kept.push({ before: left, token });
        left = right;
        continue;
      }
      left = joined(joined(left, token), right);
      while (kept.length > 0 && shownDigits(kept[kept.length - 1].before) + shownDigits(left) > 4) {
        const previous = kept.pop()!;
        left = joined(joined(previous.before, previous.token), left);
      }
    }
    for (const { before } of kept) addSpan(text, kinds, before, spans);
    addSpan(text, kinds, left, spans);
    start = stop;
  }
  return { kinds, spans };
}

/** A span that could be a card number and shows more than four of its digits, or a mask showing five or more. */
function isCardData(span: Pick<Span, 'symbols' | 'digits' | 'leading' | 'revealing'>): boolean {
  if (span.revealing) return true;
  if (span.digits < 5) return false;
  if (span.symbols >= 13) return true;
  // Only Maestro issues 12-digit cards, so 12 symbols are card-length only after a mask or a Maestro prefix.
  const maestro = MAESTRO_PREFIXES.some((prefix) => prefix.startsWith(span.leading) || span.leading.startsWith(prefix));
  return span.symbols === 12 && maestro;
}

/**
 * The most plausible card number in a stretch of digits: the longest one made of whole groups, else the longest
 * after dropping stray digits stuck to either end. `breaks` holds the offsets where a separator split the digits.
 */
function cardWithin(digits: string, breaks: readonly number[]): CardNumberMatch | null {
  if (digits.length < MIN_PAN_DIGITS) return null;
  const edges = [0, ...breaks, digits.length];
  let best: { length: number; match: CardNumberMatch } | null = null;
  for (let first = 0; first < edges.length; first += 1) {
    for (let last = first + 1; last < edges.length && edges[last] - edges[first] <= MAX_PAN_DIGITS; last += 1) {
      const length = edges[last] - edges[first];
      if (length < MIN_PAN_DIGITS || (best && length < best.length)) continue;
      const candidate = digits.slice(edges[first], edges[last]);
      const network = isCardNumber(candidate);
      if (network) best = { length, match: { network, last4: candidate.slice(-4) } };
    }
  }
  if (best) return best.match;
  for (let length = Math.min(MAX_PAN_DIGITS, digits.length - 1); length >= MIN_PAN_DIGITS; length -= 1) {
    for (const candidate of [digits.slice(-length), digits.slice(0, length)]) {
      const network = isCardNumber(candidate);
      if (network) return { network, last4: candidate.slice(-4) };
    }
  }
  return null;
}

/** Full card numbers, one per card span: its network and the last four digits that redaction keeps. */
export function findCardNumbers(text: string): CardNumberMatch[] {
  const normalized = normalize(text);
  const { kinds, spans } = cardSpans(normalized);
  const matches: CardNumberMatch[] = [];
  for (const span of spans) {
    if (!isCardData(span)) continue;
    // Masks split the span; any stretch between them may hold a full card number.
    let digits = '';
    let breaks: number[] = [];
    let card: CardNumberMatch | null = null;
    for (let index = span.start; index <= span.end && !card; index += 1) {
      const kind = index < span.end ? kinds[index] : MASK;
      if (kind === DIGIT) {
        if (digits && kinds[index - 1] === SEPARATOR) breaks.push(digits.length);
        digits += normalized[index];
      } else if (kind === MASK) {
        card = cardWithin(digits, breaks);
        digits = '';
        breaks = [];
      }
    }
    if (card) matches.push({ network: card.network, last4: span.last4 ?? card.last4 });
  }
  return matches;
}

/** True when the text holds a full card number. */
export function containsCardNumber(text: string): boolean {
  return findCardNumbers(text).length > 0;
}

/** True when the text holds a card-length span that shows more than four digits. */
export function containsCardData(text: string): boolean {
  const normalized = normalize(text);
  return cardSpans(normalized).spans.some(isCardData);
}

/**
 * Replace card numbers, and masked identifiers that reveal more than the last
 * four digits, with `***1234`. The result is NFKC-normalized.
 * Every card-length span that shows more than four digits is replaced whole, by `***` alone when its last
 * four symbols are masked.
 */
export function redactCardNumbers(text: string): string {
  const normalized = normalize(text);
  const parts: string[] = [];
  let cursor = 0;
  for (const span of cardSpans(normalized).spans) {
    if (!isCardData(span)) continue;
    parts.push(normalized.slice(cursor, span.start), `***${span.last4 ?? ''}`);
    cursor = span.end;
  }
  parts.push(normalized.slice(cursor));
  return parts.join('');
}

/**
 * Last four digits of a card identifier such as `XXXX-XXXXXX-90003` or `Ending in 1234`: the last four symbols
 * of its last span, or null when there are fewer than four or any of them is masked.
 */
export function cardLast4(identifier: string): string | null {
  const { spans } = cardSpans(normalize(identifier));
  for (let index = spans.length - 1; index >= 0; index -= 1) if (spans[index].symbols >= 4) return spans[index].last4;
  return null;
}

function pathKey(key: string): string {
  if (containsCardData(key)) return '<card number>';
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) && !/\d{5,}/.test(key) ? key : '<key>';
}

function unsafeNumber(value: number | bigint): boolean {
  // Integers this long are identifiers, not amounts; above 2^53 they may already be rounded.
  if (typeof value === 'bigint') return (value < 0n ? -value : value) >= 10n ** 11n;
  return Number.isFinite(value) && Math.abs(value) >= 1e11;
}

/**
 * Paths (never values) where card data appears in strings, numbers, or object
 * keys. Too large, too deep, or cyclic input is reported as `$<limit>` so
 * callers fail closed.
 */
export function findCardNumberPaths(value: unknown): string[] {
  const paths: string[] = [];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let chars = 0;
  let exceeded = false;
  const visit = (node: unknown, at: string, depth: number): void => {
    if (exceeded || paths.length >= LIMITS.paths) return;
    nodes += 1;
    if (nodes > LIMITS.nodes || depth > LIMITS.depth) {
      exceeded = true;
      return;
    }
    if (typeof node === 'string') {
      chars += node.length;
      if (chars > LIMITS.textChars) exceeded = true;
      else if (containsCardData(node)) paths.push(at);
    } else if (typeof node === 'number' || typeof node === 'bigint') {
      if (unsafeNumber(node) || containsCardData(String(node))) paths.push(at);
    } else if (node && typeof node === 'object') {
      if (seen.has(node)) {
        exceeded = true;
        return;
      }
      seen.add(node);
      if (Array.isArray(node)) {
        for (let index = 0; index < node.length && !exceeded; index += 1) visit(node[index], `${at}[${index}]`, depth + 1);
        return;
      }
      for (const [key, child] of Object.entries(node)) {
        if (exceeded || paths.length >= LIMITS.paths) return;
        // Keys are scanned like strings, so they draw on the same budget before any scanning.
        chars += key.length;
        if (chars > LIMITS.textChars) {
          exceeded = true;
          return;
        }
        const safeKey = pathKey(key);
        if (safeKey === '<card number>') paths.push(`${at}.${safeKey}`);
        visit(child, `${at}.${safeKey}`, depth + 1);
      }
    }
  };
  visit(value, '$', 0);
  if (exceeded) paths.push('$<limit>');
  return paths.slice(0, LIMITS.paths + 1);
}

function fieldKey(name: string): string {
  return normalize(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim();
}

/** Columns that must never be kept: security codes, PINs and expiry dates. */
export function isCardSecretField(name: string): boolean {
  const key = fieldKey(name);
  return /^(?:card )?(?:cvv2?|cvc2?|cid|csc|cvn)(?: (?:number|code|value))?$/.test(key)
    || /^(?:card )?(?:pin|security code|card security code|card verification (?:code|value)|valid thru|valid through)$/.test(key)
    || /^(?:card )?(?:exp|expiry|expiration)(?: (?:date|mm|yy|yyyy|month|year))?$/.test(key);
}

/** Columns that carry the card or account number and must be reduced to the last four digits. */
export function isCardNumberField(name: string): boolean {
  const key = fieldKey(name);
  return /^(?:card|card account|card member|account|acct|primary account) (?:number|no|num|#|id)(?: last 4)?$/.test(key)
    || /^(?:pan|acctid|account)$/.test(key);
}
