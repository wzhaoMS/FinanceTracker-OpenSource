// Frozen copy of packages/shared/src/cardNumbers.ts as build a075553 shipped it
// (Phase 1 at 72d436f, git blob b6c5621539888d36773afb41c882a3f0ed48b000).
// Cross-build tests register it as that build's holdr_card_data_v2 detector to
// reproduce exactly what an a075553 deployment would accept. Never edit it.

export type CardNetwork =
  | 'amex' | 'visa' | 'mastercard' | 'discover' | 'diners' | 'jcb' | 'unionpay' | 'maestro'
  | 'mir' | 'rupay' | 'troy' | 'uatp';

/** A detected card number. Only the last four digits are ever exposed. */
export interface CardNumberMatch {
  network: CardNetwork;
  last4: string;
}

interface Hit {
  start: number;
  end: number;
  last4: string;
}

interface PanHit extends Hit {
  network: CardNetwork;
}

/** A run of digits and mask symbols between separators. */
interface Chunk {
  start: number;
  end: number;
  size: number;
  digits: number;
  masks: number;
  trailingDigits: number;
}

// Invisible format characters (zero-width, soft hyphen, bidi marks, variation selectors) are dropped before scanning.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const OTHER_DIGIT = /(?![0-9])\p{Nd}/gu;
const MASK_SYMBOLS = 'Xx*•·●∗∙⋅';
// Up to three whitespace or dash characters separate groups. Card digits may also be split by the dot-like
// mask symbols; masked identifiers cannot, because a symbol must not be both a separator and a mask there.
const SEPARATOR = '[\\s\\u0085\\p{Pd}\\u2043\\u2212]';
const PAN_SEPARATOR = '[\\s\\u0085\\p{Pd}\\u2043\\u2212•·●∙⋅]';
// Digits never match a separator, so these patterns cannot backtrack catastrophically.
const DIGIT_RUN = new RegExp(`(?<!\\d)\\d+(?:${PAN_SEPARATOR}{1,3}\\d+)*(?!\\d)`, 'gu');
const NEXT_DIGIT_GROUP = new RegExp(`${PAN_SEPARATOR}{1,3}(\\d+)`, 'uy');
const MASKED_RUN = new RegExp(`[0-9${MASK_SYMBOLS}]+(?:${SEPARATOR}{1,3}[0-9${MASK_SYMBOLS}]+)*`, 'gu');
const LETTER_BEFORE = /[\p{L}\p{M}]$/u;
const LETTER_AFTER = /^[\p{L}\p{M}]/u;
const MAX_PAN_DIGITS = 19;
const MAX_GROUP = 6;
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

/** Leading digits of a number of at least six digits, as integers. */
interface Prefix {
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  p6: number;
}

function prefixOf(digits: string): Prefix {
  let value = 0;
  const leading: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    value = value * 10 + digits.charCodeAt(index) - 48;
    leading.push(value);
  }
  return { p1: leading[0], p2: leading[1], p3: leading[2], p4: leading[3], p6: leading[5] };
}

function networkOf({ p1, p2, p3, p4, p6 }: Prefix, length: number): CardNetwork | null {
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
  if (p6 === 493698 || p2 === 50 || within(p2, 56, 59) || p1 === 6) return 'maestro';
  return null;
}

/**
 * Network by issuer prefix and length, covering Braintree's credit-card-type table (Elo, Hiper, Hipercard,
 * Naranja and Verve ranges fall inside the Visa, Mastercard, Discover, UnionPay and Maestro ranges), legacy
 * lengths, RuPay and UATP. Null for anything that is not a plausible card number.
 */
export function cardNetwork(digits: string): CardNetwork | null {
  return /^\d{12,19}$/.test(digits) ? networkOf(prefixOf(digits), digits.length) : null;
}

function cardIn(digits: string, prefix: Prefix): CardNetwork | null {
  const network = networkOf(prefix, digits.length);
  // Some UnionPay cards do not carry a Luhn check digit.
  return network && (network === 'unionpay' || luhnValid(digits)) ? network : null;
}

function isCardNumber(digits: string): CardNetwork | null {
  return digits.length >= 12 && digits.length <= MAX_PAN_DIGITS ? cardIn(digits, prefixOf(digits)) : null;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** The last four digits in text[start, end). */
function lastFour(text: string, start: number, end: number): string {
  let digits = '';
  for (let index = end - 1; index >= start && digits.length < 4; index -= 1) {
    if (isDigit(text.charCodeAt(index))) digits = text[index] + digits;
  }
  return digits;
}

/** The longest card number made of whole groups starting at group `first`. */
function longestCardFrom(text: string, groups: readonly number[], first: number): { last: number; network: CardNetwork } | null {
  // No network starts with 0 or 7.
  const lead = text.charCodeAt(groups[2 * first]);
  if (lead === 48 || lead === 55) return null;
  let best: { last: number; network: CardNetwork } | null = null;
  let digits = '';
  let prefix: Prefix | null = null;
  for (let last = first; 2 * last < groups.length; last += 1) {
    const start = groups[2 * last];
    const end = groups[2 * last + 1];
    if (digits.length + end - start > MAX_PAN_DIGITS) break;
    digits += text.slice(start, end);
    if (digits.length < 12) continue;
    prefix ??= prefixOf(digits);
    const network = cardIn(digits, prefix);
    if (network) best = { last, network };
  }
  return best;
}

/** A card spanning digit groups `first` to `last`; `groups` holds the start and end offset of each group. */
function panHit(text: string, groups: readonly number[], first: number, last: number, network: CardNetwork): PanHit {
  const start = groups[2 * first];
  const end = groups[2 * last + 1];
  return { network, start, end, last4: lastFour(text, start, end) };
}

/**
 * Card numbers made of whole digit groups. Every group is tried as a start, and overlapping matches merge,
 * so a checksum-valid combination of a neighbouring reference and part of a card cannot hide the card.
 */
function scanPans(text: string): PanHit[] {
  const hits: PanHit[] = [];
  for (const run of text.matchAll(DIGIT_RUN)) {
    const groups: number[] = [];
    const runEnd = run.index! + run[0].length;
    for (let index = run.index!; index < runEnd; index += 1) {
      if (!isDigit(text.charCodeAt(index))) continue;
      groups.push(index);
      while (index < runEnd && isDigit(text.charCodeAt(index))) index += 1;
      groups.push(index);
    }
    let first = -1;
    let last = -1;
    let network: CardNetwork | null = null;
    for (let start = 0; 2 * start < groups.length; start += 1) {
      const card = longestCardFrom(text, groups, start);
      if (!card) continue;
      if (network && start <= last) {
        // Keep the network of the card that reaches furthest; only its end survives redaction.
        if (card.last > last) ({ last, network } = card);
        continue;
      }
      if (network) hits.push(panHit(text, groups, first, last, network));
      first = start;
      ({ last, network } = card);
    }
    if (network) hits.push(panHit(text, groups, first, last, network));
  }
  return hits;
}

function isX(text: string, index: number): boolean {
  return text[index] === 'X' || text[index] === 'x';
}

// Digits and mask symbols are single UTF-16 units; anything else inside a masked run is a separator.
function isUnit(text: string, index: number): boolean {
  return isDigit(text.charCodeAt(index)) || MASK_SYMBOLS.includes(text[index]);
}

function chunkOf(text: string, start: number, end: number): Chunk {
  let digits = 0;
  let trailingDigits = 0;
  for (let index = start; index < end; index += 1) {
    trailingDigits = isDigit(text.charCodeAt(index)) ? trailingDigits + 1 : 0;
    if (trailingDigits > 0) digits += 1;
  }
  return { start, end, size: end - start, digits, masks: end - start - digits, trailingDigits };
}

/** Digit and mask runs of a masked span, without X or x that belong to an adjacent word such as Amex or Xbox. */
function maskedChunks(text: string, runStart: number, runEnd: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (let start = runStart; start < runEnd;) {
    let end = start;
    while (end < runEnd && isUnit(text, end)) end += 1;
    chunks.push(chunkOf(text, start, end));
    for (start = end; start < runEnd && !isUnit(text, start); start += 1);
  }
  // Only the letter that ends the word, so `AmexXXXX-52694` still keeps its mask.
  if (isX(text, runStart) && LETTER_BEFORE.test(text.slice(Math.max(0, runStart - 2), runStart))) {
    const first = chunks[0];
    if (first.size > 1) chunks[0] = chunkOf(text, first.start + 1, first.end);
    else chunks.shift();
  }
  const last = chunks[chunks.length - 1];
  if (last && isX(text, runEnd - 1) && LETTER_AFTER.test(text.slice(runEnd, runEnd + 2))) {
    let end = last.end;
    while (end > last.start && isX(text, end - 1)) end -= 1;
    if (end > last.start) chunks[chunks.length - 1] = chunkOf(text, last.start, end);
    else chunks.pop();
  }
  return chunks;
}

/**
 * Masked card identifiers that still reveal more than four digits, e.g. 411111******1111, XXXX-52694 or
 * 4111 XXXX XXXX 1111. An identifier starts at a group with mask symbols and ends at the first group that
 * ends in four digits. Groups after the first hold at most six symbols, and leading 4-6 digit groups count
 * only while the whole fits in 19 symbols, so an amount or a `***1234` replacement next to a card stays out.
 */
function scanMasked(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const run of text.matchAll(MASKED_RUN)) {
    const chunks = maskedChunks(text, run.index!, run.index! + run[0].length);
    let index = 0;
    let floor = 0;
    while (index < chunks.length) {
      let first = index;
      while (first < chunks.length && chunks[first].masks === 0) first += 1;
      if (first === chunks.length) break;
      let last = first;
      while (chunks[last].trailingDigits < 4) {
        last += 1;
        if (last === chunks.length || chunks[last].size > MAX_GROUP) break;
      }
      if (last === chunks.length) break;
      if (last > first && chunks[last].size > MAX_GROUP) {
        index = last;
        continue;
      }
      let start = first;
      let symbols = 0;
      let grouped = true;
      for (let k = first; k <= last; k += 1) {
        symbols += chunks[k].size;
        grouped &&= chunks[k].size <= MAX_GROUP;
      }
      while (grouped && start > floor) {
        const lead = chunks[start - 1];
        if (lead.masks > 0 || lead.size < 4 || lead.size > MAX_GROUP || symbols + lead.size > MAX_PAN_DIGITS) break;
        symbols += lead.size;
        start -= 1;
      }
      let masks = 0;
      let digits = 0;
      for (let k = start; k <= last; k += 1) {
        masks += chunks[k].masks;
        digits += chunks[k].digits;
      }
      if (masks >= 2 && digits > 4) {
        const { end } = chunks[last];
        hits.push({ start: chunks[start].start, end, last4: lastFour(text, chunks[last].start, end) });
        floor = last + 1;
      }
      index = last + 1;
    }
  }
  return hits;
}

/**
 * End of the longest run of following digit groups that would form a card number together with the four
 * digits a replacement leaves behind, so `***1234` can never complete a new card number.
 */
function completedBy(text: string, start: number, end: number): number {
  let digits = lastFour(text, start, end);
  let best = end;
  NEXT_DIGIT_GROUP.lastIndex = end;
  for (let group = NEXT_DIGIT_GROUP.exec(text); group; group = NEXT_DIGIT_GROUP.exec(text)) {
    if (digits.length + group[1].length > MAX_PAN_DIGITS) break;
    digits += group[1];
    if (isCardNumber(digits)) best = NEXT_DIGIT_GROUP.lastIndex;
  }
  return best;
}

/** Card numbers and revealing masks, with overlapping spans merged; each keeps only its terminal four digits. */
function redactionHits(text: string): Hit[] {
  const found: Hit[] = [...scanPans(text), ...scanMasked(text)].sort((a, b) => a.start - b.start);
  const hits: Hit[] = [];
  let index = 0;
  while (index < found.length) {
    const start = found[index].start;
    let end = found[index].end;
    index += 1;
    for (;;) {
      while (index < found.length && found[index].start < end) {
        end = Math.max(end, found[index].end);
        index += 1;
      }
      const extended = completedBy(text, start, end);
      if (extended === end) break;
      end = extended;
    }
    hits.push({ start, end, last4: lastFour(text, start, end) });
  }
  return hits;
}

function applyHits(text: string, hits: readonly Hit[]): string {
  if (hits.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const hit of hits) {
    parts.push(text.slice(cursor, hit.start), `***${hit.last4}`);
    cursor = hit.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

export function findCardNumbers(text: string): CardNumberMatch[] {
  return scanPans(normalize(text)).map(({ network, last4 }) => ({ network, last4 }));
}

/** True when the text holds a full card number. */
export function containsCardNumber(text: string): boolean {
  return scanPans(normalize(text)).length > 0;
}

/** True when the text holds a full card number or a masked one that reveals more than the last four digits. */
export function containsCardData(text: string): boolean {
  const normalized = normalize(text);
  return scanPans(normalized).length > 0 || scanMasked(normalized).length > 0;
}

/**
 * Replace card numbers, and masked identifiers that reveal more than the last
 * four digits, with `***1234`. The result is NFKC-normalized.
 */
export function redactCardNumbers(text: string): string {
  let redacted = normalize(text);
  // A replacement can complete a new masked identifier (`1X4111111111111111` becomes `1X***1111`), so repeat
  // until none is left. Every pass replaces more than four digits with four, so this always ends.
  for (let hits = redactionHits(redacted); hits.length > 0; hits = redactionHits(redacted)) {
    redacted = applyHits(redacted, hits);
  }
  return redacted;
}

/** Last four digits of a card identifier such as `XXXX-XXXXXX-52694` or `Ending in 1234`. */
export function cardLast4(identifier: string): string | null {
  const text = normalize(identifier);
  const hits = scanPans(text);
  if (hits.length > 0) return hits[hits.length - 1].last4;
  return /(\d{4})\D*$/.exec(text)?.[1] ?? null;
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
