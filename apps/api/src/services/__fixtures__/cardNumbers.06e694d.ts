// Frozen copy of packages/shared/src/cardNumbers.ts as Phase 1 06e694d left it
// (git blob f0892e23520978a986e9bcd22dfced3069f113a1). Builds 9eac1b2 to 1f1ffbf
// shipped it as their revision 3 detector, holdr_card_data_v3. Cross-build tests
// register it to reproduce exactly what those builds accept. Never edit it.

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
  /** Kind of separator before the chunk: whitespace only, or with a dash; empty for the first chunk. */
  gap: '' | 'space' | 'dash';
}

// Invisible format characters (zero-width, soft hyphen, bidi marks, variation selectors) are dropped before scanning.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const OTHER_DIGIT = /(?![0-9])\p{Nd}/gu;
const MASK_SYMBOLS = 'Xx*•·●∗∙⋅';
// Masked identifiers are grouped by up to three whitespace or dash characters.
const SEPARATOR = '[\\s\\u0085\\p{Pd}\\u2043\\u2212]';
// Card digits may be grouped by any mix of up to three separators: whitespace, dashes, the dot-like mask
// symbols, and punctuation. Punctuation also separates dates, amounts, versions, addresses and times, so a
// group of digits that uses it only counts as a card when its groups fall where a card's blocks do.
const SOFT_SEPARATORS = '\\s\\u0085\\p{Pd}\\u2043\\u2212•·●∙⋅';
const PUNCTUATION = "./\\,_:|'";
const THOUSANDS_SEPARATORS = ",.'";
const DIGIT_SEPARATOR = `[${SOFT_SEPARATORS}${PUNCTUATION.replace(/[\\\]]/g, '\\$&')}]{1,3}`;
// Digits never match a separator, so these patterns cannot backtrack catastrophically.
const DIGIT_RUN = new RegExp(`(?<!\\d)\\d+(?:${DIGIT_SEPARATOR}\\d+)*(?!\\d)`, 'gu');
const NEXT_DIGIT_GROUP = new RegExp(`${DIGIT_SEPARATOR}(\\d+)`, 'uy');
const MASKED_RUN = new RegExp(`[0-9${MASK_SYMBOLS}]+(?:${SEPARATOR}{1,3}[0-9${MASK_SYMBOLS}]+)*`, 'gu');
const LETTER_BEFORE = /[\p{L}\p{M}]$/u;
const LETTER_AFTER = /^[\p{L}\p{M}]/u;
const REPLACEMENT = /^\*\*\*\d{4}$/;
const MIN_PAN_DIGITS = 12;
const MAX_PAN_DIGITS = 19;
// Where printed cards break between blocks: every four digits, or 4-6-x for Amex and Diners.
const BLOCK_ENDS = [4, 8, 10, 12, 16];
// Lengths at which a card printed in blocks of four, or as 4-6-5 and 4-6-4, ends on a block boundary.
const FOUR_BLOCK_ENDS = [12, 16];
const AMEX_ENDS = [14, 15];
const CARD_ENDS = [12, 14, 15, 16];
// A 13-19 digit number written with thousands separators, e.g. 4,111,111,111,111,111.
const THOUSANDS_LAYOUTS = [1, 2, 3].flatMap((lead) => [4, 5, 6].map((count) => [lead, ...Array<number>(count).fill(3)]))
  .filter((layout) => within(layout.reduce((sum, size) => sum + size, 0), 13, MAX_PAN_DIGITS));
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

interface Candidate {
  start: number;
  end: number;
  network: CardNetwork;
}

/** Offsets of the digit groups in text[start, end): group k spans groups[2k] to groups[2k + 1]. */
function digitGroups(text: string, start: number, end: number): number[] {
  const groups: number[] = [];
  for (let index = start; index < end; index += 1) {
    if (!isDigit(text.charCodeAt(index))) continue;
    groups.push(index);
    while (index < end && isDigit(text.charCodeAt(index))) index += 1;
    groups.push(index);
  }
  return groups;
}

/** True when the separator before group `k` holds only whitespace, dashes or dot-like symbols. */
function softBefore(text: string, groups: readonly number[], k: number): boolean {
  for (let index = groups[2 * k - 1]; index < groups[2 * k]; index += 1) if (PUNCTUATION.includes(text[index])) return false;
  return true;
}

/** The longest card number made of whole groups starting at group `first`, across soft separators only. */
function longestCardFrom(text: string, groups: readonly number[], first: number): Candidate | null {
  // No network starts with 0 or 7.
  const lead = text.charCodeAt(groups[2 * first]);
  if (lead === 48 || lead === 55) return null;
  let best: Candidate | null = null;
  let digits = '';
  let prefix: Prefix | null = null;
  for (let last = first; 2 * last < groups.length; last += 1) {
    const start = groups[2 * last];
    const end = groups[2 * last + 1];
    if (last > first && !softBefore(text, groups, last)) break;
    if (digits.length + end - start > MAX_PAN_DIGITS) break;
    digits += text.slice(start, end);
    if (digits.length < MIN_PAN_DIGITS) continue;
    prefix ??= prefixOf(digits);
    const network = cardIn(digits, prefix);
    if (network) best = { start: groups[2 * first], end, network };
  }
  return best;
}

function pushCard(text: string, groups: readonly number[], first: number, last: number, digits: string,
  found: Candidate[]): void {
  const plausible = within(digits.length, MIN_PAN_DIGITS, MAX_PAN_DIGITS) && digits[0] !== '0';
  const network = plausible ? cardIn(digits, prefixOf(digits)) : null;
  if (network) found.push({ start: groups[2 * first], end: groups[2 * last + 1], network });
}

/**
 * Card numbers starting at group `first` whose groups break where a printed card's blocks do, whatever mix of
 * separators joins them: `4111.1111 1111-1111`, `3782-822463.10005`, or `4111.11111111.1111` once an invisible
 * separator is dropped. Stray digits stuck to the first group (`84111 1111 1111 1111`) are dropped, and so are
 * extra digits after the last block.
 */
function blockCardsFrom(text: string, groups: readonly number[], first: number, found: Candidate[]): void {
  const count = groups.length / 2;
  const start = groups[2 * first];
  const length = groups[2 * first + 1] - start;
  for (const block of BLOCK_ENDS) {
    // The first group must end at a block boundary, after dropping any stray leading digits.
    const lead = text.charCodeAt(start + length - block);
    if (block > length || lead === 48 || lead === 55) continue;
    let digits = text.slice(start + length - block, start + length);
    let everyFour = block % 4 === 0;
    let amex = block === 4 || block === 10;
    for (let last = first + 1; last < count; last += 1) {
      const from = groups[2 * last];
      const size = groups[2 * last + 1] - from;
      const total = digits.length + size;
      if (total >= MIN_PAN_DIGITS && total <= MAX_PAN_DIGITS && (everyFour || (amex && (total === 14 || total === 15)))) {
        pushCard(text, groups, first, last, digits + text.slice(from, from + size), found);
      }
      // Drop extra digits stuck to the last group, keeping it up to where a full card ends.
      for (const end of everyFour && amex ? CARD_ENDS : everyFour ? FOUR_BLOCK_ENDS : amex ? AMEX_ENDS : []) {
        const keep = end - digits.length;
        if (keep > 0 && keep < size) pushCard(text, groups, first, last, digits + text.slice(from, from + keep), found);
      }
      digits += text.slice(from, from + size);
      everyFour &&= digits.length % 4 === 0 && digits.length <= 16;
      amex &&= digits.length === 10 && last === first + 1;
      if ((!everyFour && !amex) || digits.length >= MAX_PAN_DIGITS) break;
    }
  }
}

/** True when the separator before group `k` matches text[from, to). */
function separatorIs(text: string, groups: readonly number[], k: number, from: number, to: number): boolean {
  const start = groups[2 * k - 1];
  if (groups[2 * k] - start !== to - from) return false;
  for (let offset = 0; offset < to - from; offset += 1) if (text[start + offset] !== text[from + offset]) return false;
  return true;
}

/** A 13-19 digit card number written as one number with thousands separators, starting at group `first`. */
function thousandsCardsFrom(text: string, groups: readonly number[], first: number, found: Candidate[]): void {
  const from = groups[2 * first + 1];
  const to = groups[2 * first + 2];
  if (to - from !== 1 || !THOUSANDS_SEPARATORS.includes(text[from])) return;
  // Only a whole number counts, not part of a longer one.
  if (first > 0 && separatorIs(text, groups, first, from, to)) return;
  for (const layout of THOUSANDS_LAYOUTS) {
    const last = first + layout.length - 1;
    if (2 * last + 1 >= groups.length) continue;
    if (2 * last + 3 < groups.length && separatorIs(text, groups, last + 1, from, to)) continue;
    let digits = '';
    for (let k = first; k <= last; k += 1) {
      const size = groups[2 * k + 1] - groups[2 * k];
      if (size !== layout[k - first] || (k > first && !separatorIs(text, groups, k, from, to))) {
        digits = '';
        break;
      }
      digits += text.slice(groups[2 * k], groups[2 * k + 1]);
    }
    pushCard(text, groups, first, last, digits, found);
  }
}

/**
 * Card numbers in runs of digit groups joined by any mix of separators. Every group is tried as a start; whole
 * groups joined by whitespace or dashes may be any size, groups joined by punctuation must break where a card's
 * blocks do, and overlapping matches merge, so a checksum-valid neighbouring reference or a stray extra digit
 * cannot hide a card.
 */
function scanPans(text: string): PanHit[] {
  const hits: PanHit[] = [];
  for (const run of text.matchAll(DIGIT_RUN)) {
    const groups = digitGroups(text, run.index!, run.index! + run[0].length);
    const found: Candidate[] = [];
    for (let first = 0; 2 * first < groups.length; first += 1) {
      const card = longestCardFrom(text, groups, first);
      if (card) found.push(card);
      if (2 * first + 2 < groups.length) {
        blockCardsFrom(text, groups, first, found);
        thousandsCardsFrom(text, groups, first, found);
      }
    }
    // Candidates arrive in order of their first group.
    let current: Candidate | null = null;
    for (const card of found) {
      if (current && card.start < current.end) {
        // Keep the network of the card that reaches furthest; only its end survives redaction.
        if (card.end > current.end) current = { start: current.start, end: card.end, network: card.network };
        continue;
      }
      if (current) hits.push({ ...current, last4: lastFour(text, current.start, current.end) });
      current = card;
    }
    if (current) hits.push({ ...current, last4: lastFour(text, current.start, current.end) });
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

function chunkOf(text: string, start: number, end: number, gap: Chunk['gap']): Chunk {
  let digits = 0;
  let trailingDigits = 0;
  for (let index = start; index < end; index += 1) {
    trailingDigits = isDigit(text.charCodeAt(index)) ? trailingDigits + 1 : 0;
    if (trailingDigits > 0) digits += 1;
  }
  return { start, end, size: end - start, digits, masks: end - start - digits, trailingDigits, gap };
}

/** Digit and mask runs of a masked span, without X or x that belong to an adjacent word such as Amex or Xbox. */
function maskedChunks(text: string, runStart: number, runEnd: number): Chunk[] {
  const chunks: Chunk[] = [];
  let gap: Chunk['gap'] = '';
  for (let start = runStart; start < runEnd;) {
    let end = start;
    while (end < runEnd && isUnit(text, end)) end += 1;
    chunks.push(chunkOf(text, start, end, gap));
    gap = 'space';
    for (start = end; start < runEnd && !isUnit(text, start); start += 1) if (!/\s/.test(text[start])) gap = 'dash';
  }
  // Only the letter that ends the word, so `AmexXXXX-52694` still keeps its mask.
  if (isX(text, runStart) && LETTER_BEFORE.test(text.slice(Math.max(0, runStart - 2), runStart))) {
    const first = chunks[0];
    if (first.size > 1) chunks[0] = chunkOf(text, first.start + 1, first.end, '');
    else if (chunks.shift() && chunks.length > 0) chunks[0] = { ...chunks[0], gap: '' };
  }
  const last = chunks[chunks.length - 1];
  if (last && isX(text, runEnd - 1) && LETTER_AFTER.test(text.slice(runEnd, runEnd + 2))) {
    let end = last.end;
    while (end > last.start && isX(text, end - 1)) end -= 1;
    if (end > last.start) chunks[chunks.length - 1] = chunkOf(text, last.start, end, last.gap);
    else chunks.pop();
  }
  return chunks;
}

/** True when the digits at text[start] continue a number written with punctuation, such as 1.2345 or 12/2026. */
function gluedBefore(text: string, start: number): boolean {
  return start >= 2 && PUNCTUATION.includes(text[start - 1]) && isDigit(text.charCodeAt(start - 2));
}

function gluedAfter(text: string, end: number): boolean {
  return PUNCTUATION.includes(text[end] ?? '') && isDigit(text.charCodeAt(end + 1));
}

/** A digits-only group that may extend a masked identifier, unless it belongs to a number such as 25.00. */
function digitGroup(text: string, chunk: Chunk | undefined): boolean {
  return chunk !== undefined && chunk.masks === 0 && !gluedBefore(text, chunk.start) && !gluedAfter(text, chunk.end);
}

/**
 * Masked identifiers within chunks[from, to) that reveal more than four digits. An identifier starts at a group
 * with mask symbols and runs to the first group ending in a digit. It then takes visible leading groups of 4-8
 * digits (a BIN, or the first eight digits PCI allows) and further digit groups written the same way
 * (`4111 XXXX 1111 1111`, `XXXX-XXXXXX-3502-1`), leading ones first, up to 19 symbols. A finished last-four
 * form on its own (`****1111 2026-10-16`, `2500 ****1111`) does not take the numbers around it.
 */
function maskedInSegment(text: string, chunks: readonly Chunk[], from: number, to: number, hits: Hit[]): void {
  let index = from;
  let floor = from;
  while (index < to) {
    let first = index;
    while (first < to && chunks[first].masks === 0) first += 1;
    let end = first;
    while (end < to && chunks[end].trailingDigits === 0) end += 1;
    if (end >= to) return;
    const finished = chunks[end].trailingDigits >= 4;
    let symbols = 0;
    for (let k = first; k <= end; k += 1) symbols += chunks[k].size;
    let gap = first < end ? chunks[first + 1].gap : '';
    let start = first;
    while (start > floor && digitGroup(text, chunks[start - 1]) && within(chunks[start - 1].size, 4, 8)
      && symbols + chunks[start - 1].size <= MAX_PAN_DIGITS && (!gap || chunks[start].gap === gap)) {
      gap = chunks[start].gap;
      symbols += chunks[start - 1].size;
      start -= 1;
    }
    const lead = first - start;
    let last = end;
    // A group followed by a masked one starts the next identifier.
    while ((!finished || end > first || lead > 0) && last + 1 < to && digitGroup(text, chunks[last + 1])
      && symbols + chunks[last + 1].size <= MAX_PAN_DIGITS && (!gap || chunks[last + 1].gap === gap)
      && (last + 2 >= to || (chunks[last + 2].masks === 0 && chunks[last + 2].gap === chunks[last + 1].gap))) {
      gap = chunks[last + 1].gap;
      symbols += chunks[last + 1].size;
      last += 1;
    }
    // Numbers next to a finished last-four form join it only when the whole is card-sized.
    if (finished && symbols < 13) {
      if (last > end) {
        for (let k = end + 1; k <= last; k += 1) symbols -= chunks[k].size;
        last = end;
      }
      if (first === end && lead > 0) {
        for (let k = start; k < first; k += 1) symbols -= chunks[k].size;
        start = first;
      }
    }
    let masks = 0;
    let digits = 0;
    for (let k = start; k <= last; k += 1) {
      masks += chunks[k].masks;
      digits += chunks[k].digits;
    }
    if (masks >= 2 && digits > 4) {
      const { end: stop } = chunks[last];
      hits.push({ start: chunks[start].start, end: stop, last4: lastFour(text, chunks[first].start, stop) });
      floor = last + 1;
      index = last + 1;
    } else {
      index = end + 1;
    }
  }
}

/** Masked card identifiers that still reveal more than four digits, e.g. 411111******1111 or XXXX-52694. */
function scanMasked(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const run of text.matchAll(MASKED_RUN)) {
    const chunks = maskedChunks(text, run.index!, run.index! + run[0].length);
    // `***1234` is already safe; it never joins the groups around it.
    let from = 0;
    for (let k = 0; k <= chunks.length; k += 1) {
      if (k < chunks.length && !REPLACEMENT.test(text.slice(chunks[k].start, chunks[k].end))) continue;
      maskedInSegment(text, chunks, from, k, hits);
      from = k + 1;
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
  // Both scanners report hits in text order, so a merge keeps them sorted.
  const pans = scanPans(text);
  const masks = scanMasked(text);
  const found: Hit[] = [];
  for (let p = 0, m = 0; p < pans.length || m < masks.length;) {
    found.push(m >= masks.length || (p < pans.length && pans[p].start <= masks[m].start) ? pans[p++] : masks[m++]);
  }
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
