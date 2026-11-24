/**
 * Cross-field checks: card data or a card secret that no single field shows
 * but that a reader gets by putting a row's text together, or its text and
 * card hints. Refuse-only, bounded, value-free. Phase 1's detectors and
 * network rules (cardNumbers.ts) are used as they are.
 *
 * - Reconstruction from whole digit runs. Each field is read as the sequence
 *   of its whole digit runs (digits joined by the separators Phase 1's span
 *   detector accepts). Redaction tokens (a run of masks and the four or five
 *   digits it kept, such as `***1881` or `XXXX-90003`) are deleted, and their
 *   kept digits become hints; the text is also read once more with those
 *   digits as ordinary runs, so a number cannot hide in tokens either. Within
 *   each field, and across fields in every arrangement, no window of
 *   consecutive whole runs, alone or followed by a hint (the payload's card
 *   hints and the row's token digits), may form a card number: a known
 *   network prefix and length (`cardNetwork`), a valid Luhn check digit
 *   (`luhnValid`), 15 to 19 digits. So a card number's first twelve digits in
 *   three groups between words, with its last four kept by redactions
 *   (`ALPHA NNNN BRAVO ***NNNN CHARLIE NNNN DELTA ***NNNN ECHO NNNN`, N = digit),
 *   is refused. Windows use whole runs only, never arbitrary digit slices, which
 *   keeps ordinary phone, store and order numbers from pairing with hints.
 * - Joined text. The fields are also joined in every order, with single
 *   spaces and with no separator where a boundary touches a digit. Each
 *   boundary a span of digits and masks can cross is judged by Phase 1's
 *   card-number recognition and mask rule, and the whole join by the
 *   card-secret detector (`CVV` in one field and its digits, `NNN`, in the next).
 */
import { CARD_SPAN_MASK, CARD_SPAN_SEPARATOR } from '../cardImportTool/leaks.js';
import { cardNetwork, containsCardData, containsCardNumber, luhnValid } from '../cardNumbers.js';
import { containsCardSecret } from '../cardSecrets.js';
import { CARD_SYNC_TEXT_LIMITS, prepareCardSyncText, type CardSyncTextProblem } from './text.js';

/** The body of a one-class pattern such as `/[abc]/u`. */
function classBody(pattern: RegExp): string {
  return pattern.source.slice(1, -1);
}

/** Separators Phase 1's span detector treats as part of a span (shared with card import's leak check). */
const SEPARATORS = classBody(CARD_SPAN_SEPARATOR);
/** Phase 1's mask symbols (shared likewise); x, X and # are masks there in some contexts. */
const MASKS = classBody(CARD_SPAN_MASK);
const SPAN_CHAR = new RegExp(`^[0-9${MASKS}#xX${SEPARATORS}]$`, 'u');
const SPAN_CORE = new RegExp(`^[0-9${MASKS}#xX]$`, 'u');
const DIGIT_RUN = new RegExp(`[0-9](?:[${SEPARATORS}]*[0-9])*`, 'gu');
const REDACTION_TOKEN = new RegExp(`(?:[${MASKS}]{2,}|[xX]{2,}|#{2,})[${SEPARATORS}]*([0-9]{4,5})(?![0-9])`, 'gu');
const ANY_DIGIT = /[0-9]/;
const NOT_DIGIT = /[^0-9]/g;
const HINT = /^[0-9]{4,5}$/;

/**
 * Shortest card number a reconstruction counts. Phase 1's span rule already
 * refuses 13 or more digit symbols in one span; counting 12- to 14-digit
 * results across runs would make every phone number a candidate (a 10-digit
 * number and a hint make 14 digits, and one hint in ten passes Luhn).
 * Current cards are 15 (Amex) to 19 digits long.
 */
export const CARD_SYNC_RECONSTRUCTION_MIN_DIGITS = 15;
const MAX_CARD_DIGITS = 19;

function luhnDigit(digit: number, doubled: boolean): number {
  if (!doubled) return digit;
  const twice = digit * 2;
  return twice > 9 ? twice - 9 : twice;
}

/** Luhn sum of `digits` when `offset` more digits follow them in the number. */
function luhnSum(digits: string, offset = 0): number {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    sum += luhnDigit(digits.charCodeAt(digits.length - 1 - index) - 48, (offset + index) % 2 === 1);
  }
  return sum;
}

/** A card number by Phase 1's network table and the Luhn check, 15 to 19 digits. */
function isCardNumberDigits(digits: string): boolean {
  return digits.length >= CARD_SYNC_RECONSTRUCTION_MIN_DIGITS && digits.length <= MAX_CARD_DIGITS
    && cardNetwork(digits) !== null && luhnValid(digits);
}

/** Last-four (or -five) hints, indexed by length and Luhn residue. */
export class CardHintSet {
  private readonly byLength = new Map<number, Map<number, string[]>>();
  private count = 0;

  constructor(hints: Iterable<string> = []) {
    for (const hint of hints) this.add(hint);
  }

  /** Adds a 4- or 5-digit hint; anything else is ignored. */
  add(hint: string): void {
    if (typeof hint !== 'string' || !HINT.test(hint)) return;
    let residues = this.byLength.get(hint.length);
    if (!residues) {
      residues = new Map();
      this.byLength.set(hint.length, residues);
    }
    const residue = luhnSum(hint) % 10;
    const list = residues.get(residue) ?? [];
    if (list.includes(hint)) return;
    list.push(hint);
    residues.set(residue, list);
    this.count += 1;
  }

  get size(): number {
    return this.count;
  }

  /** The hint lengths present (4, 5). */
  lengths(): number[] {
    return [...this.byLength.keys()];
  }

  /** The hints of `length` whose own Luhn sum leaves `residue` modulo 10. */
  matching(length: number, residue: number): readonly string[] {
    return this.byLength.get(length)?.get(residue) ?? [];
  }

  /** A copy with more hints. */
  with(hints: Iterable<string>): CardHintSet {
    const copy = new CardHintSet();
    for (const residues of this.byLength.values()) for (const list of residues.values()) for (const hint of list) copy.add(hint);
    for (const hint of hints) copy.add(hint);
    return copy;
  }

  /** True when `digits` (whole) followed by one of the hints is a card number: 15 to 19 digits, a known network, Luhn-valid. */
  completes(digits: string): boolean {
    if (typeof digits !== 'string' || !/^[0-9]+$/.test(digits)) return false;
    for (const length of this.lengths()) {
      const total = digits.length + length;
      if (total < CARD_SYNC_RECONSTRUCTION_MIN_DIGITS || total > MAX_CARD_DIGITS) continue;
      const residue = (10 - (luhnSum(digits, length) % 10)) % 10;
      if (this.matching(length, residue).some((hint) => isCardNumberDigits(`${digits}${hint}`))) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Whole digit runs
// ---------------------------------------------------------------------------

interface Run {
  digits: string;
  /** Where the run (separators within it included) lies in its field's text. */
  start: number;
  end: number;
  /** Luhn sums of the digits when an even (`even`) or odd (`odd`) number of digits follow them. */
  even: number;
  odd: number;
}

interface FieldDigits {
  /** Whole runs once redaction tokens are deleted. */
  runs: Run[];
  /** Whole runs with the tokens' kept digits read as runs too (`runs` itself when there are no tokens). */
  tokenRuns: Run[];
  /** Digits the redaction tokens kept. */
  hints: string[];
}

function runsOf(text: string): Run[] {
  const runs: Run[] = [];
  for (const match of text.matchAll(DIGIT_RUN)) {
    const start = match.index ?? 0;
    const digits = match[0].replace(NOT_DIGIT, '');
    runs.push({ digits, start, end: start + match[0].length, even: luhnSum(digits, 0), odd: luhnSum(digits, 1) });
  }
  return runs;
}

function fieldDigits(text: string): FieldDigits {
  const hints: string[] = [];
  // Same length, so positions still point into `text`; NUL is no separator, so it ends the runs beside a token.
  const stripped = text.replace(REDACTION_TOKEN, (token: string, kept: string) => {
    hints.push(kept);
    return '\u0000'.repeat(token.length);
  });
  const runs = runsOf(stripped);
  return { runs, tokenRuns: hints.length > 0 ? runsOf(text) : runs, hints };
}

/**
 * The whole digit runs of `text` in order (digits joined by the separators
 * Phase 1's span detector accepts) once redaction tokens such as `***1881`
 * are deleted, and the digits those tokens kept.
 */
export function cardSyncTextDigits(text: string): { runs: string[]; hints: string[] } {
  const { runs, hints } = fieldDigits(text);
  return { runs: runs.map((run) => run.digits), hints };
}

/**
 * The first window [first, last] of consecutive whole runs that, alone or
 * followed by a hint, is a card number; or null. With `cross`, only windows
 * holding both run `cross - 1` and run `cross` count. Windows grow leftwards
 * from each last run and stop past 19 digits, so each run is visited at most
 * 19 times and each visit costs constant time per hint length.
 */
function completingWindow(runs: readonly Run[], hints: CardHintSet, cross: number | null, byLead: Map<string, number>): [number, number] | null {
  const lengths = hints.lengths();
  const offsets = [0];
  for (const run of runs) offsets.push(offsets[offsets.length - 1] + run.digits.length);
  const all = runs.map((run) => run.digits).join('');
  // A network is decided by a number's leading digits (IIN ranges are prefixes of at most 8 digits) and its
  // length, and a window that can reach 15 digits with a hint holds at least 10. So each start run gets one
  // mask of the lengths (15 to 19) its leading digits allow, shared (`byLead`) by windows that start alike,
  // and Phase 1's full check confirms every match.
  const masks = new Int8Array(runs.length).fill(-1);
  const networkMask = (first: number): number => {
    if (masks[first] >= 0) return masks[first];
    const lead = all.slice(offsets[first], offsets[first] + 8);
    let mask = byLead.get(lead);
    if (mask === undefined) {
      mask = 0;
      for (let length = CARD_SYNC_RECONSTRUCTION_MIN_DIGITS; length <= MAX_CARD_DIGITS; length += 1) {
        if (cardNetwork(lead.padEnd(length, '0')) !== null) mask |= 1 << (length - CARD_SYNC_RECONSTRUCTION_MIN_DIGITS);
      }
      byLead.set(lead, mask);
    }
    masks[first] = mask;
    return mask;
  };
  const allows = (first: number, length: number): boolean => ((networkMask(first) >> (length - CARD_SYNC_RECONSTRUCTION_MIN_DIGITS)) & 1) === 1;
  // Shorter windows cannot reach 15 digits even with the longest hint.
  const shortest = CARD_SYNC_RECONSTRUCTION_MIN_DIGITS - Math.max(0, ...lengths);
  for (let last = cross ?? 0; last < runs.length; last += 1) {
    let size = 0;
    // The window's Luhn sum when an even (no hint, a 4-digit hint) or odd (a 5-digit hint) number of digits follow it.
    let evenSum = 0;
    let oddSum = 0;
    for (let first = last; first >= 0; first -= 1) {
      const run = runs[first];
      if (size + run.digits.length > MAX_CARD_DIGITS) break;
      evenSum += size % 2 === 0 ? run.even : run.odd;
      oddSum += size % 2 === 0 ? run.odd : run.even;
      size += run.digits.length;
      if (size < shortest || (cross !== null && first >= cross)) continue;
      // Luhn first (a residue lookup), then the network, then Phase 1's full check.
      if (size >= CARD_SYNC_RECONSTRUCTION_MIN_DIGITS && evenSum % 10 === 0 && allows(first, size)
        && isCardNumberDigits(all.slice(offsets[first], offsets[last + 1]))) {
        return [first, last];
      }
      for (const length of lengths) {
        const total = size + length;
        if (total < CARD_SYNC_RECONSTRUCTION_MIN_DIGITS || total > MAX_CARD_DIGITS) continue;
        const candidates = hints.matching(length, (10 - ((length % 2 === 0 ? evenSum : oddSum) % 10)) % 10);
        if (candidates.length === 0 || !allows(first, total)) continue;
        const digits = all.slice(offsets[first], offsets[last + 1]);
        if (candidates.some((hint) => isCardNumberDigits(`${digits}${hint}`))) return [first, last];
      }
    }
  }
  return null;
}

interface RunRef {
  field: number;
  run: number;
}

/**
 * The runs on each side of the boundary before `order[boundary]` that a
 * window of at most 19 digits holding both sides can reach (at most 18
 * digits a side), in order, and how many lie before the boundary.
 */
function aroundBoundary(fields: readonly (readonly Run[])[], order: readonly number[], boundary: number): { refs: RunRef[]; cross: number } {
  const left: RunRef[] = [];
  let size = 0;
  leftward: for (let position = boundary - 1; position >= 0; position -= 1) {
    const runs = fields[order[position]];
    for (let run = runs.length - 1; run >= 0; run -= 1) {
      size += runs[run].digits.length;
      if (size >= MAX_CARD_DIGITS) break leftward;
      left.unshift({ field: order[position], run });
    }
  }
  const right: RunRef[] = [];
  size = 0;
  rightward: for (let position = boundary; position < order.length; position += 1) {
    const runs = fields[order[position]];
    for (let run = 0; run < runs.length; run += 1) {
      size += runs[run].digits.length;
      if (size >= MAX_CARD_DIGITS) break rightward;
      right.push({ field: order[position], run });
    }
  }
  return { refs: [...left, ...right], cross: left.length };
}

/** The runs of the first reconstruction, within one field or across fields in any arrangement; or null. */
function findReconstruction(fields: readonly (readonly Run[])[], hints: CardHintSet): RunRef[] | null {
  const byLead = new Map<string, number>();
  for (let field = 0; field < fields.length; field += 1) {
    const window = completingWindow(fields[field], hints, null, byLead);
    if (window) return Array.from({ length: window[1] - window[0] + 1 }, (_, offset) => ({ field, run: window[0] + offset }));
  }
  // Arrangements that put the same runs around a boundary are searched once.
  const searched = new Set<string>();
  for (const order of orders(fields.map((_, index) => index))) {
    for (let boundary = 1; boundary < order.length; boundary += 1) {
      const { refs, cross } = aroundBoundary(fields, order, boundary);
      if (cross === 0 || cross === refs.length) continue;
      const first = refs[0];
      const last = refs[refs.length - 1];
      const key = [first.field, first.run, refs[cross - 1].field, refs[cross].field, last.field, last.run].join(',');
      if (searched.has(key)) continue;
      searched.add(key);
      const window = completingWindow(refs.map((ref) => fields[ref.field][ref.run]), hints, cross, byLead);
      if (window) return refs.slice(window[0], window[1] + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Joined text
// ---------------------------------------------------------------------------

/** Does the maximal run of span characters at this end of `text` hold a digit or mask? */
function spanEdge(text: string, fromEnd: boolean): boolean {
  for (let step = 0; step < text.length; step += 1) {
    const char = text[fromEnd ? text.length - 1 - step : step];
    if (!SPAN_CHAR.test(char)) return false;
    if (SPAN_CORE.test(char)) return true;
  }
  return false;
}

/** Could a span of digits and masks run across the boundary between `left` and `right`? */
function mayCross(left: string, right: string): boolean {
  return spanEdge(left, true) && spanEdge(right, false);
}

function orders<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  items.forEach((item, index) => {
    for (const rest of orders([...items.slice(0, index), ...items.slice(index + 1)])) result.push([item, ...rest]);
  });
  return result;
}

interface Joined {
  text: string;
  /** Index in `text` of the first character of each part after the first. */
  boundaries: number[];
}

/** Joined with single spaces, or (tight) with no separator where a boundary touches a digit. */
function join(parts: readonly string[], tight: boolean): Joined {
  let text = parts[0];
  const boundaries: number[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    const touching = ANY_DIGIT.test(text[text.length - 1] ?? '') || ANY_DIGIT.test(parts[index][0] ?? '');
    text += tight && touching ? '' : ' ';
    boundaries.push(text.length);
    text += parts[index];
  }
  return { text, boundaries };
}

const LETTER = /^[\p{L}\p{M}]$/u;
const PLAIN_MASK = new RegExp(`^[${MASKS}]$`, 'u');

/**
 * Whether `text[start, end)` holds a mask as Phase 1 reads masks: * • ● ∗ ⁎
 * always, # only doubled, and an x or X run unless a letter follows it (a
 * word such as Xbox), and then only past its first x when a letter comes
 * before it (Amex, AmexXXXX).
 */
function holdsMask(text: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const char = text[index];
    if (PLAIN_MASK.test(char)) return true;
    if (char === '#' && (text[index + 1] === '#' || text[index - 1] === '#')) return true;
    if (char !== 'x' && char !== 'X') continue;
    let runEnd = index;
    while (runEnd < text.length && (text[runEnd] === 'x' || text[runEnd] === 'X')) runEnd += 1;
    let runStart = index;
    while (runStart > 0 && (text[runStart - 1] === 'x' || text[runStart - 1] === 'X')) runStart -= 1;
    const wordAfter = LETTER.test(text[runEnd] ?? '');
    const wordBefore = LETTER.test(text[runStart - 1] ?? '');
    if (!wordAfter && (runEnd - runStart > 1 || !wordBefore)) return true;
    index = runEnd - 1;
  }
  return false;
}

/** The maximal run of span characters around the boundary at `at`, with the two characters of context Phase 1 classifies by. */
function crossingWindow(text: string, at: number): { text: string; runStart: number; runEnd: number } {
  let start = at;
  while (start > 0 && SPAN_CHAR.test(text[start - 1])) start -= 1;
  let end = at;
  while (end < text.length && SPAN_CHAR.test(text[end])) end += 1;
  const from = Math.max(0, start - 2);
  return { text: text.slice(from, Math.min(text.length, end + 2)), runStart: start - from, runEnd: end - from };
}

/** Letters every card-secret label contains (as in strictJson's pair check). */
const LABEL_STEM = /cvv|cvc|cvn|cav|cid|csc|security|verification|pin|exp|valid|good|mm|yy/;

export type CardSyncCombinedIssue = 'card-data' | 'card-secret';

/**
 * Joined-text issues: a card number or a mask showing five or more digits in a
 * span that crosses a boundary, or a card secret in the whole join.
 */
function joinedIssue(fields: readonly string[]): CardSyncCombinedIssue | null {
  const letters = new Map(fields.map((field) => [field, field.toLowerCase().replace(/[^a-z]/g, '')]));
  for (const order of orders(fields)) {
    const crossing = order.slice(1).map((right, index) => mayCross(order[index], right));
    // A new secret needs digits after the first field and a label somewhere in the join.
    const secret = order.slice(1).some((field) => ANY_DIGIT.test(field)) && LABEL_STEM.test(order.map((field) => letters.get(field)).join(''));
    if (!secret && !crossing.some(Boolean)) continue;
    const spaced = join(order, false);
    const tight = join(order, true);
    for (const joined of tight.text === spaced.text ? [spaced] : [spaced, tight]) {
      for (let index = 0; index < crossing.length; index += 1) {
        if (!crossing[index]) continue;
        const window = crossingWindow(joined.text, joined.boundaries[index]);
        if (containsCardNumber(window.text)) return 'card-data';
        if (holdsMask(window.text, window.runStart, window.runEnd) && containsCardData(window.text)) return 'card-data';
      }
      if (secret && containsCardSecret(joined.text)) return 'card-secret';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

interface Finding {
  issue: CardSyncCombinedIssue | null;
  fields: string[];
  digits: FieldDigits[];
  /** The runs of a reconstruction (empty for joined-text issues). */
  targets: Array<{ field: number; run: Run }>;
}

function examine(texts: ReadonlyArray<string | null | undefined>, hints: CardHintSet | Iterable<string>): Finding {
  const fields = texts.filter((text): text is string => typeof text === 'string' && text.length > 0).slice(0, 3);
  const digits = fields.map(fieldDigits);
  const base = hints instanceof CardHintSet ? hints : new CardHintSet(hints);
  const kept = digits.flatMap((field) => field.hints);
  const set = kept.length > 0 ? base.with(kept) : base;
  for (const reading of kept.length > 0 ? (['runs', 'tokenRuns'] as const) : (['runs'] as const)) {
    const runs = digits.map((field) => field[reading]);
    const found = findReconstruction(runs, set);
    if (found) return { issue: 'card-data', fields, digits, targets: found.map((ref) => ({ field: ref.field, run: runs[ref.field][ref.run] })) };
  }
  return { issue: fields.length < 2 ? null : joinedIssue(fields), fields, digits, targets: [] };
}

/**
 * Why a row's free-text fields (description, merchant, issuer category; or a
 * candidate's product hint), read together and with the card hints, show card
 * data or a card secret that no single field shows; or null. Each field must
 * already pass the single-field rules (`cardSyncTextIssue`). Nulls and empty
 * strings are skipped, and only the first three fields are read. Bounded: 6
 * arrangements, 2 joins each, windows of at most 19 digits.
 */
export function cardSyncCombinedTextIssue(
  texts: ReadonlyArray<string | null | undefined>,
  hints: CardHintSet | Iterable<string> = [],
): CardSyncCombinedIssue | null {
  return examine(texts, hints).issue;
}

// ---------------------------------------------------------------------------
// Producer helper
// ---------------------------------------------------------------------------

const ROW_TEXT_FIELDS = ['description', 'merchant', 'issuerCategory'] as const;
type RowTextField = (typeof ROW_TEXT_FIELDS)[number];
const MAX_REDACTIONS = 16;

export interface CardSyncRowTextInput {
  description: string | null;
  merchant?: string | null;
  issuerCategory?: string | null;
}

export type CardSyncRowTextResult =
  | {
    ok: true;
    description: string | null;
    merchant: string | null;
    issuerCategory: string | null;
    /** Some text was redacted (card data, a long digit run, or runs that rebuild a card number with other text or a hint). */
    redacted: boolean;
    truncated: boolean;
  }
  | { ok: false; field: RowTextField | 'row'; problem: CardSyncTextProblem | 'combined-card-data' | 'combined-card-secret' };

/**
 * Issuer text for one row's description, merchant and issuer category, for
 * adapters: each field through `prepareCardSyncText`, then the row as a whole
 * through `cardSyncCombinedTextIssue` with the payload's card hints. Where the
 * text shows card data or a secret only when read together, it redacts rather
 * than refuse: the runs that rebuild a card number, else the longest digit
 * run, each replaced by `***` and the field prepared again, at most 16 times.
 * A row it cannot make safe is refused (`combined-card-data`,
 * `combined-card-secret`).
 */
export function prepareCardSyncRowText(input: CardSyncRowTextInput, options: { hints?: Iterable<string> } = {}): CardSyncRowTextResult {
  const prepared: Record<RowTextField, string | null> = { description: null, merchant: null, issuerCategory: null };
  let redacted = false;
  let truncated = false;
  const settle = (field: RowTextField, raw: string): CardSyncRowTextResult | null => {
    const result = prepareCardSyncText(raw, CARD_SYNC_TEXT_LIMITS[field]);
    if (!result.ok) return { ok: false, field, problem: result.problem };
    prepared[field] = result.text;
    redacted ||= result.redacted;
    truncated ||= result.truncated;
    return null;
  };
  for (const field of ROW_TEXT_FIELDS) {
    const raw = input[field] ?? null;
    if (raw === null) continue;
    const refused = settle(field, raw);
    if (refused) return refused;
  }
  const hints = new CardHintSet(options.hints ?? []);
  for (let step = 0; ; step += 1) {
    const present = ROW_TEXT_FIELDS.filter((field) => prepared[field] !== null && prepared[field] !== '');
    const found = examine(present.map((field) => prepared[field]), hints);
    if (found.issue === null) {
      return { ok: true, description: prepared.description, merchant: prepared.merchant, issuerCategory: prepared.issuerCategory, redacted, truncated };
    }
    const refusal: CardSyncRowTextResult = { ok: false, field: 'row', problem: found.issue === 'card-secret' ? 'combined-card-secret' : 'combined-card-data' };
    if (step === MAX_REDACTIONS) return refusal;
    let targets = found.targets;
    if (targets.length === 0) {
      // A joined-text issue: give up the longest digit run left (token digits included).
      for (let index = 0; index < found.digits.length; index += 1) {
        for (const run of found.digits[index].tokenRuns) {
          if (targets.length === 0 || run.digits.length > targets[0].run.digits.length) targets = [{ field: index, run }];
        }
      }
      if (targets.length === 0) return refusal;
    }
    for (let index = 0; index < present.length; index += 1) {
      const runs = targets.filter((target) => target.field === index).map((target) => target.run).sort((a, b) => b.start - a.start);
      if (runs.length === 0) continue;
      let text = found.fields[index];
      for (const run of runs) text = `${text.slice(0, run.start)}***${text.slice(run.end)}`;
      redacted = true;
      const refused = settle(present[index], text);
      if (refused) return refused;
    }
  }
}
