/**
 * `RETAIL_METAL_PACK_RULE` ('metals-pack-v2'): whether a bullion product's own title sells one piece per ordered unit,
 * read from its raw text alone, before any sanitizing, normalizing or truncating. A title may state one coin's weight
 * while the unit sold is a tube of twenty, so a stated weight is a unit's weight only when the title is `single`.
 *
 * It fails closed, and any doubt is `multiple` or `unknown`, never `single`:
 * - `multiple`: the readable text names more than one piece per unit: a pack word, a plural form word, or a count of two
 *   or more joined to a count noun, to an `x` or `×` (either side), after a container "of" or a count label, or as a
 *   whole number filling brackets. A digit group of two or more right against such a marker is a count even inside a
 *   longer phrase ("x 2/1"). A face value is no count, even right before a count noun: its whole phrase is an amount of
 *   money right after "$" ("$50 Coin", "$1.00 Coin").
 * - `unknown`: the text is missing or blank; holds a character outside the closed alphabet (so a fullwidth, lookalike
 *   or invisible character can never hide a marker); names a word that may mean several pieces (box, set, case, any
 *   count word, …); holds a count that could be a year, a code or zero, or that is not a whole number ("2/1 x",
 *   "20.01 Item", "x ½", "½ Coin"); holds a numeric phrase nothing explains (only a weight, karat, fineness, percentage,
 *   face value, grade or year explains one, each in a closed shape and context, so "2/1", "[2.0]", "1/0", "2.1.1" or a
 *   lone "½" never does); or shows it was cut or masked (three dots or three asterisks in a row anywhere; "…" is
 *   outside the alphabet).
 * - `single`: none of these, on text read in full.
 * A marker found in what reads makes the title `multiple` even when another character is outside the alphabet. A vulgar
 * fraction in the alphabet (½ ¼ ¾ ⅒) is a number like any other: right after a whole number it ends that number's
 * phrase ("1½", "1 ½"), and otherwise it is a phrase of its own, a proper fraction ("½ oz", "x ½").
 *
 * Every list is closed, and any change to one is a new version. Words are whole runs of ASCII letters, compared in
 * upper case (only ASCII letters are folded, never by `toUpperCase`), so "TUBELESS" is no TUBE.
 *
 * v2 (from v1): a face value right before a count noun is no count. v1 read the count noun first, so "$50 Coin" was
 * fifty coins and "$1.00 Coin" a doubtful count "00". A count elsewhere still reads ("$1 Coin 10-Pack",
 * "2 x $50 Coin"), and so does a number not right after "$" ("50 Coin"). Nothing else changed.
 *
 * Pure: no file system, network or clock.
 */

export const RETAIL_METAL_PACK_RULE = 'metals-pack-v2' as const;
export type RetailMetalPackRule = typeof RETAIL_METAL_PACK_RULE;

export const RETAIL_METAL_PACKS = ['single', 'multiple', 'unknown'] as const;
export type RetailMetalPack = (typeof RETAIL_METAL_PACKS)[number];

/** Why a title got its pack, as closed codes (for converter reports and tests; a payload line carries only the pack). */
export const RETAIL_METAL_PACK_REASONS = [
  'none',
  'pack-word',
  'plural-form',
  'count',
  'times-count',
  'container-count',
  'label-count',
  'bracketed-count',
  'doubt-word',
  'number-word',
  'doubtful-count',
  'stray-number',
  'outside-alphabet',
  'cut-or-masked',
  'missing',
] as const;
export type RetailMetalPackReason = (typeof RETAIL_METAL_PACK_REASONS)[number];

export interface RetailMetalPackAssessment {
  pack: RetailMetalPack;
  reason: RetailMetalPackReason;
}

/** Words that always mean more than one piece per unit. */
export const RETAIL_PACK_WORDS: ReadonlySet<string> = new Set([
  'TUBE', 'TUBES', 'ROLL', 'ROLLS', 'MONSTER', 'MONSTERBOX', 'MONSTERBOXES', 'PACK', 'PACKS', 'MULTIPACK', 'MULTIPACKS',
  'BUNDLE', 'BUNDLES', 'LOT', 'LOTS', 'SHEET', 'SHEETS', 'PCS', 'PIECES', 'QTY', 'QUANTITY', 'SETS', 'BOXES', 'CASES',
  'PAIR', 'PAIRS', 'DUO', 'TRIO', 'COMBIBAR', 'COMBIBARS', 'MULTICARD', 'MULTICARDS',
]);

/** A bullion form named in the plural: more than one piece. */
export const RETAIL_PACK_PLURAL_FORM_WORDS: ReadonlySet<string> = new Set([
  'BARS', 'COINS', 'ROUNDS', 'INGOTS', 'WAFERS', 'NUGGETS', 'MEDALLIONS',
]);

/** Words that may mean several pieces, or a container of them: never `single`. */
export const RETAIL_PACK_DOUBT_WORDS: ReadonlySet<string> = new Set([
  'BOX', 'CASE', 'SET', 'PACKAGE', 'PACKAGED', 'PACKAGES', 'COLLECTION', 'COLLECTIONS', 'COUNT', 'CT', 'PIECE', 'PC',
  'ASSORTED', 'MIXED', 'VARIETY', 'KIT', 'KITS', 'DOUBLE', 'TWIN', 'MULTI', 'MULTIPLE', 'BULK', 'CONTAINER',
  'CONTAINERS', 'CAPSULES', 'SLEEVE', 'SLEEVES', 'BAG', 'BAGS', 'EACH', 'PER', 'UNITS', 'ITEMS', 'REDACTED',
  'SEVERAL', 'FEW', 'MANY', 'BOTH', 'NUMEROUS', 'VARIOUS', 'COMBO', 'COMBOS', 'ASSORTMENT', 'ASSORTMENTS', 'SAMPLER',
  'SAMPLERS', 'TRAY', 'TRAYS', 'STRIP', 'STRIPS',
]);

/**
 * Count words: every English cardinal word (ONE included), every scale word, and the words for fixed counts and
 * multiples. A count written in words is a doubt, never read. GROSS (a gross, 144) is a doubt even in "gross weight",
 * which the ledger's content rule holds anyway.
 */
export const RETAIL_PACK_NUMBER_WORDS: ReadonlySet<string> = new Set([
  'ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN',
  'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN', 'TWENTY', 'THIRTY', 'FORTY', 'FOURTY', 'FIFTY',
  'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY', 'HUNDRED', 'HUNDREDS', 'THOUSAND', 'THOUSANDS', 'MILLION', 'MILLIONS',
  'BILLION', 'BILLIONS', 'DOZEN', 'DOZENS', 'SCORE', 'SCORES', 'GROSS', 'COUPLE', 'TRIPLE', 'QUADRUPLE', 'QUINTUPLE',
]);

/** A count right before one of these (joined: nothing, spaces, or one dash between) counts pieces: "20-Coin", "10 Bars". */
export const RETAIL_PACK_COUNT_NOUNS: ReadonlySet<string> = new Set([
  'COIN', 'COINS', 'BAR', 'BARS', 'ROUND', 'ROUNDS', 'INGOT', 'INGOTS', 'WAFER', 'WAFERS', 'PIECE', 'PIECES', 'PC',
  'PCS', 'PACK', 'PACKS', 'CT', 'COUNT', 'TUBE', 'TUBES', 'ROLL', 'ROLLS', 'UNIT', 'UNITS', 'ITEM', 'ITEMS',
]);

/** A container "of" a count: "Pack of 10", "Box of 20". */
export const RETAIL_PACK_CONTAINER_WORDS: ReadonlySet<string> = new Set([
  'PACK', 'LOT', 'BOX', 'SET', 'CASE', 'ROLL', 'TUBE', 'BAG', 'BUNDLE', 'SHEET', 'SLEEVE', 'PACKAGE', 'CONTAINER',
]);

/** A label before a count, optionally with a colon: "Qty 5", "Count: 10". */
export const RETAIL_PACK_COUNT_LABELS: ReadonlySet<string> = new Set(['QTY', 'QUANTITY', 'COUNT', 'CT', 'PCS', 'PIECES']);

/** Words after a measure that make it a weight: "1 oz", "100 g", "1/10 oz", "1 1/2 oz", "31.1 g", "1 kilo". */
export const RETAIL_PACK_WEIGHT_WORDS: ReadonlySet<string> = new Set([
  'OZ', 'OZT', 'OUNCE', 'OUNCES', 'TROY', 'G', 'GR', 'GRAM', 'GRAMS', 'KG', 'KILO', 'KILOS', 'KILOGRAM', 'KILOGRAMS',
  'TOLA', 'TOLAS',
]);

/** Words after a whole number from 8 to 24 that make it a karat: "24K", "22 kt", "18-Karat". */
export const RETAIL_PACK_KARAT_WORDS: ReadonlySet<string> = new Set(['K', 'KT', 'KARAT', 'KARATS']);

/** Words after a listed fineness that make it a purity: "9999 Fine", ".999 Pure". */
export const RETAIL_PACK_FINENESS_WORDS: ReadonlySet<string> = new Set(['FINE', 'PURE', 'PURITY']);

/** Words after an amount of money that make it a face value: "50 Dollar". */
export const RETAIL_PACK_FACE_VALUE_WORDS: ReadonlySet<string> = new Set(['DOLLAR', 'DOLLARS']);

/**
 * Finenesses as written: before a fineness word ("999 Fine"), or alone when written with a point (".9999", "999.9").
 * A whole number alone is never a fineness, since it could be a count.
 */
export const RETAIL_PACK_FINENESS_SHAPES: ReadonlySet<string> = new Set([
  '375', '585', '750', '800', '900', '916', '917', '925', '950', '958', '986', '995', '999', '9167', '9995', '9999',
  '99999', '91.67', '99.5', '99.9', '99.95', '99.99', '99.999', '916.7', '999.5', '999.9', '999.99', '.900', '.916',
  '.9167', '.925', '.958', '.986', '.995', '.999', '.9995', '.9999', '.99999', '0.900', '0.916', '0.9167', '0.925',
  '0.958', '0.986', '0.995', '0.999', '0.9995', '0.9999', '0.99999',
]);

/** Grade prefixes written right before a whole grade from 1 to 70 with nothing between: "MS70", "PF69". */
export const RETAIL_PACK_GRADE_PREFIXES: ReadonlySet<string> = new Set(['MS', 'PF', 'PR', 'SP', 'AU', 'VF', 'XF', 'EF', 'PL']);

/**
 * The closed alphabet beyond printable ASCII (U+0020–U+007E): the title rule's vulgar fractions, the no-break space,
 * the signs ®, ™ and ©, the en and em dashes, the curly quotes, and the multiplication sign (a count marker itself).
 * None of them can be or hide a letter or a digit.
 */
export const RETAIL_PACK_ALPHABET_EXTRAS: ReadonlySet<string> = new Set([
  '\u00BD', '\u00BC', '\u00BE', '\u2152', '\u00A0', '\u00AE', '\u2122', '\u00A9', '\u2013', '\u2014',
  '\u2018', '\u2019', '\u201C', '\u201D', '\u00D7',
]);

const VULGAR_FRACTIONS: ReadonlySet<string> = new Set(['\u00BD', '\u00BC', '\u00BE', '\u2152']);

type TokenKind = 'word' | 'number' | 'times' | 'open' | 'close' | 'space' | 'dash' | 'colon' | 'barrier' | 'other';
interface Token {
  kind: TokenKind;
  text: string;
}

const isAsciiLetter = (character: string) => (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z');
const isAsciiDigit = (character: string) => character >= '0' && character <= '9';
/** Upper case for ASCII letters only: nothing else is a letter here. */
const asciiUpper = (text: string) => text.replace(/[a-z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) - 32));

function inAlphabet(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (codePoint >= 0x20 && codePoint <= 0x7e) || RETAIL_PACK_ALPHABET_EXTRAS.has(character);
}

/**
 * The text as tokens. A character outside the alphabet becomes a barrier: it joins nothing on either side, so it can
 * never complete a word, a number or a count.
 */
function tokenize(raw: string): { tokens: Token[]; outside: boolean } {
  const tokens: Token[] = [];
  let outside = false;
  const push = (kind: TokenKind, character: string) => {
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind && (kind === 'word' || kind === 'number' || kind === 'space')) last.text += character;
    else tokens.push({ kind, text: character });
  };
  for (const character of raw) {
    if (!inAlphabet(character)) {
      outside = true;
      tokens.push({ kind: 'barrier', text: '' });
    } else if (isAsciiLetter(character)) {
      push('word', character);
    } else if (isAsciiDigit(character)) {
      push('number', character);
    } else if (character === ' ' || character === '\u00A0') {
      push('space', ' ');
    } else if (character === '\u00D7') {
      tokens.push({ kind: 'times', text: character });
    } else if (character === '(' || character === '[') {
      tokens.push({ kind: 'open', text: character });
    } else if (character === ')' || character === ']') {
      tokens.push({ kind: 'close', text: character });
    } else if (character === '-' || character === '\u2013' || character === '\u2014') {
      tokens.push({ kind: 'dash', text: character });
    } else if (character === ':') {
      tokens.push({ kind: 'colon', text: character });
    } else {
      tokens.push({ kind: 'other', text: character });
    }
  }
  for (const token of tokens) if (token.kind === 'word') token.text = asciiUpper(token.text);
  return { tokens, outside };
}

/**
 * The index of the next meaningful token after `index`, stepping over spaces and at most one dash ("20-Coin",
 * "20 - Coin", "20Coin") and, when allowed, one colon; -1 at the end.
 */
function joinedAfter(tokens: readonly Token[], index: number, allowColon = false): number {
  let dashes = 0;
  let colons = 0;
  for (let next = index + 1; next < tokens.length; next += 1) {
    const kind = tokens[next].kind;
    if (kind === 'space') continue;
    if (kind === 'dash' && dashes === 0) { dashes += 1; continue; }
    if (kind === 'colon' && allowColon && colons === 0) { colons += 1; continue; }
    return next;
  }
  return -1;
}

/** As joinedAfter, leftwards, over spaces and at most one dash. */
function joinedBefore(tokens: readonly Token[], index: number): number {
  let dashes = 0;
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const kind = tokens[previous].kind;
    if (kind === 'space') continue;
    if (kind === 'dash' && dashes === 0) { dashes += 1; continue; }
    return previous;
  }
  return -1;
}

/** Only spaces strictly between `from` and `to`. */
function onlySpacesBetween(tokens: readonly Token[], from: number, to: number): boolean {
  for (let index = from + 1; index < to; index += 1) if (tokens[index].kind !== 'space') return false;
  return true;
}

/** What a count reads as: one piece, two to 999, or a doubt (zero, or four digits or more: a year or a code). */
function countOf(digits: string): 'one' | 'many' | 'doubt' {
  if (digits.length > 3) return 'doubt';
  const value = Number(digits);
  if (value === 0) return 'doubt';
  return value === 1 ? 'one' : 'many';
}

const isYear = (digits: string) => digits.length === 4 && Number(digits) >= 1900 && Number(digits) <= 2099;
const isTimes = (token: Token | undefined) => token !== undefined && (token.kind === 'times' || (token.kind === 'word' && token.text === 'X'));
const isOther = (token: Token | undefined, text: string) => token !== undefined && token.kind === 'other' && token.text === text;
const isNumber = (token: Token | undefined) => token !== undefined && token.kind === 'number';
/** A vulgar fraction in the alphabet: a number, a phrase of its own when no whole number before it takes it. */
const isVulgar = (token: Token | undefined) => token !== undefined && token.kind === 'other' && VULGAR_FRACTIONS.has(token.text);

interface Finding {
  multiple: RetailMetalPackReason | null;
  doubt: RetailMetalPackReason | null;
}

/**
 * A numeric phrase and its written shape. A measure shape is one of: a whole number, thousands in groups of three
 * ("1,000"), a decimal ("31.1"), a leading-point decimal (".9999"), a proper fraction ("1/10": 1 ≤ top < bottom; or a
 * lone vulgar fraction, "½"), or a mixed number whose whole part is 1 ("1 1/2", "1 ½", "1½"). A whole part other than 1
 * may count fractional pieces ("2 1/2 oz" may be two half-ounce coins); with 1, both readings are one piece. Anything
 * else, an improper or zero fraction ("2/1", "1/0"), a number with two points ("2.1.1"), is invalid and can explain
 * nothing.
 */
type PhraseShape = 'integer' | 'thousands' | 'decimal' | 'leading-decimal' | 'fraction' | 'mixed' | 'invalid';
interface Phrase {
  start: number;
  end: number;
  /** Indices of its number tokens (or of its lone vulgar fraction), in order. */
  numbers: number[];
  /** The phrase as written: "2/1", "20.01", ".9999", "1 1/2", "1 ½", "1,000", "½". */
  text: string;
  shape: PhraseShape;
}

const proper = (top: string, bottom: string) => Number(top) >= 1 && Number(top) < Number(bottom);

function shapeOf(text: string): PhraseShape {
  if (/^\d+$/.test(text)) return 'integer';
  if (/^\d{1,3}(?:,\d{3})+$/.test(text)) return 'thousands';
  if (/^\d+\.\d+$/.test(text)) return 'decimal';
  if (/^\.\d+$/.test(text)) return 'leading-decimal';
  const fraction = /^(\d{1,3})\/(\d{1,3})$/.exec(text);
  if (fraction) return proper(fraction[1], fraction[2]) ? 'fraction' : 'invalid';
  const mixed = /^1 (\d{1,3})\/(\d{1,3})$/.exec(text);
  if (mixed) return proper(mixed[1], mixed[2]) ? 'mixed' : 'invalid';
  // ½, ¼, ¾ and ⅒ are all proper.
  if (/^[\u00BD\u00BC\u00BE\u2152]$/.test(text)) return 'fraction';
  return /^1 ?[\u00BD\u00BC\u00BE\u2152]$/.test(text) ? 'mixed' : 'invalid';
}

/**
 * The numeric phrase starting at a number: digits joined, with nothing between, by points, commas or slashes
 * ("31.1", "1,000", "1/10", "2/1", "2.1.1"); a leading point after no letter or number (".9999"); and, after a whole
 * number of one to three digits (never a year), a vulgar fraction right after it or after one space ("1½", "1 ½") or a
 * fraction after one space ("1 1/2").
 */
function phraseAt(tokens: readonly Token[], start: number): Phrase {
  const numbers = [start];
  const leadingDot = isOther(tokens[start - 1], '.')
    && !(tokens[start - 2]?.kind === 'word' || tokens[start - 2]?.kind === 'number');
  let text = `${leadingDot ? '.' : ''}${tokens[start].text}`;
  let end = start;
  for (;;) {
    const next = tokens[end + 1];
    if ((isOther(next, '.') || isOther(next, ',') || isOther(next, '/')) && isNumber(tokens[end + 2])) {
      text += `${next!.text}${tokens[end + 2].text}`;
      numbers.push(end + 2);
      end += 2;
      continue;
    }
    if (!/^\d{1,3}$/.test(text)) break;
    if (next?.kind === 'other' && VULGAR_FRACTIONS.has(next.text)) {
      text += next.text;
      end += 1;
    } else if (next?.kind === 'space' && tokens[end + 2]?.kind === 'other' && VULGAR_FRACTIONS.has(tokens[end + 2].text)) {
      text += ` ${tokens[end + 2].text}`;
      end += 2;
    } else if (next?.kind === 'space' && isNumber(tokens[end + 2]) && isOther(tokens[end + 3], '/') && isNumber(tokens[end + 4])) {
      text += ` ${tokens[end + 2].text}/${tokens[end + 4].text}`;
      numbers.push(end + 2, end + 4);
      end += 4;
    }
    break;
  }
  return { start, end, numbers, text, shape: shapeOf(text) };
}

/**
 * Every numeric phrase, keyed by each of its number tokens: one per number (see phraseAt), and one for every vulgar
 * fraction that no whole number took ("½ oz", "x ½", "(½)"), keyed by its own token.
 */
function phrasesOf(tokens: readonly Token[]): Map<number, Phrase> {
  const byNumber = new Map<number, Phrase>();
  const taken = new Set<number>();
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isNumber(tokens[index]) || byNumber.has(index)) continue;
    const phrase = phraseAt(tokens, index);
    for (const number of phrase.numbers) byNumber.set(number, phrase);
    for (let covered = phrase.start; covered <= phrase.end; covered += 1) taken.add(covered);
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isVulgar(tokens[index]) || taken.has(index)) continue;
    const text = tokens[index].text;
    byNumber.set(index, { start: index, end: index, numbers: [index], text, shape: shapeOf(text) });
  }
  return byNumber;
}

/** An amount of money: whole, in thousands or with two decimal places, above zero ("50", "1,000", "2.50"). */
const isMoney = (text: string) => /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{2})?$/.test(text)
  && Number(text.replace(/,/g, '')) > 0;

/**
 * Whether a phrase is no count, by a valid shape in its context: a weight (a measure shape before a weight word), a
 * karat (8 to 24 before a karat word), a fineness (listed, before a fineness word, or alone when written with a point),
 * a percentage (above 0 and at most 100, with % right after), a face value (money after $ or before a dollar word), a
 * grade (1 to 70 right after a grade prefix), or a year (1900 to 2099). Nothing else explains a number.
 */
function explained(tokens: readonly Token[], phrase: Phrase): boolean {
  const { text, shape } = phrase;
  const afterIndex = joinedAfter(tokens, phrase.end);
  const afterWord = afterIndex >= 0 && tokens[afterIndex].kind === 'word' ? tokens[afterIndex].text : '';
  const previous = tokens[(text.startsWith('.') ? phrase.start - 1 : phrase.start) - 1];
  const whole = shape === 'integer' ? Number(text) : Number.NaN;
  if (shape !== 'invalid' && RETAIL_PACK_WEIGHT_WORDS.has(afterWord)) return true;
  if (whole >= 8 && whole <= 24 && RETAIL_PACK_KARAT_WORDS.has(afterWord)) return true;
  if (RETAIL_PACK_FINENESS_SHAPES.has(text) && (RETAIL_PACK_FINENESS_WORDS.has(afterWord) || text.includes('.'))) return true;
  if ((shape === 'integer' || shape === 'decimal' || shape === 'leading-decimal') && isOther(tokens[phrase.end + 1], '%')
    && Number(text) > 0 && Number(text) <= 100) return true;
  if (isMoney(text) && (isOther(previous, '$') || RETAIL_PACK_FACE_VALUE_WORDS.has(afterWord))) return true;
  if (whole >= 1 && whole <= 70 && previous?.kind === 'word' && RETAIL_PACK_GRADE_PREFIXES.has(previous.text)) return true;
  return shape === 'integer' && isYear(text);
}

function findMarkers(tokens: readonly Token[]): Finding {
  let multiple: RetailMetalPackReason | null = null;
  let doubt: RetailMetalPackReason | null = null;
  const phrases = phrasesOf(tokens);
  const accounted = new Set<Phrase>();
  const many = (reason: RetailMetalPackReason) => { multiple ??= reason; };
  const unsure = (reason: RetailMetalPackReason) => { doubt ??= reason; };
  /**
   * The count at the number token right beside a marker. A whole number is a count of its own. In any other phrase
   * ("2/1", "20.01", "1,000"), a group of two or more right against the marker is still a count of several pieces
   * ("x 2/1"), and anything else is a doubt: a phrase is never cut down to a group of 1. A lone vulgar fraction is
   * never a whole number, so it is always a doubt ("x ½", "½ Coin").
   */
  const readAdjacent = (index: number, reason: RetailMetalPackReason) => {
    const phrase = phrases.get(index)!;
    accounted.add(phrase);
    const count = isNumber(tokens[index]) ? countOf(tokens[index].text) : 'doubt';
    if (count === 'many') many(reason);
    else if (count === 'doubt' || phrase.shape !== 'integer') unsure('doubtful-count');
  };
  /** v2: the phrase at a number is a face value: an amount of money right after "$" ("$50", "$1.00", "$1,000"). */
  const faceValue = (index: number) => {
    const phrase = phrases.get(index);
    return phrase !== undefined && isMoney(phrase.text) && isOther(tokens[phrase.start - 1], '$');
  };

  // Words, and the counts they introduce.
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'word') {
      if (RETAIL_PACK_WORDS.has(token.text)) many('pack-word');
      if (RETAIL_PACK_PLURAL_FORM_WORDS.has(token.text)) many('plural-form');
      if (RETAIL_PACK_DOUBT_WORDS.has(token.text)) unsure('doubt-word');
      if (RETAIL_PACK_NUMBER_WORDS.has(token.text)) unsure('number-word');
      if (RETAIL_PACK_CONTAINER_WORDS.has(token.text)) {
        const of = joinedAfter(tokens, index);
        if (of >= 0 && tokens[of].kind === 'word' && tokens[of].text === 'OF' && onlySpacesBetween(tokens, index, of)) {
          const count = joinedAfter(tokens, of);
          if (isNumber(tokens[count]) && onlySpacesBetween(tokens, of, count)) readAdjacent(count, 'container-count');
        }
      }
      if (RETAIL_PACK_COUNT_LABELS.has(token.text)) {
        const count = joinedAfter(tokens, index, true);
        if (isNumber(tokens[count])) readAdjacent(count, 'label-count');
      }
    } else if (token.kind === 'number' || (isVulgar(token) && phrases.has(index))) {
      // A number, or a vulgar fraction no whole number took ("½ Coin", "x ½").
      const after = joinedAfter(tokens, index);
      const before = joinedBefore(tokens, index);
      // A count right before a count noun: "20-Coin", "10 Bars", "5pcs". A face value is no count (v2).
      if (after >= 0 && tokens[after].kind === 'word' && RETAIL_PACK_COUNT_NOUNS.has(tokens[after].text) && !faceValue(index)) {
        readAdjacent(index, 'count');
      }
      // A count joined to an x or × on either side: "10 x 1 oz", "1 oz x 10", "10x", "×10".
      if (isTimes(tokens[after]) || isTimes(tokens[before])) readAdjacent(index, 'times-count');
    } else if (token.kind === 'open') {
      // A bracketed count is a whole number filling the brackets: "(25)", "[ 10 ]"; a whole year from 1900 to 2099 is
      // a year. Any other bracketed phrase ("(2/1)", "[2.0]") must be explained like any other number below.
      const count = joinedAfter(tokens, index);
      if (isNumber(tokens[count]) && onlySpacesBetween(tokens, index, count)) {
        const phrase = phrases.get(count)!;
        const close = joinedAfter(tokens, phrase.end);
        if (phrase.shape === 'integer' && !isYear(phrase.text) && close >= 0 && tokens[close].kind === 'close'
          && onlySpacesBetween(tokens, phrase.end, close)) {
          readAdjacent(count, 'bracketed-count');
        }
      }
    } else if (isOther(token, '*') || isOther(token, '.')) {
      // Three or more asterisks in a row are a mask; three or more dots, a title the site cut short.
      let run = 1;
      while (isOther(tokens[index + run], token.text)) run += 1;
      if (run >= 3) unsure('cut-or-masked');
      index += run - 1;
    }
  }

  // Every other numeric phrase must be explained; anything else could be a count.
  for (const phrase of new Set(phrases.values())) {
    if (!accounted.has(phrase) && !explained(tokens, phrase)) unsure('stray-number');
  }
  return { multiple, doubt };
}

/** The rule's answer for one raw title, with its reason. Deterministic: the same text always gives the same answer. */
export function retailMetalPackAssessment(raw: string | null | undefined): RetailMetalPackAssessment {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { pack: 'unknown', reason: 'missing' };
  const { tokens, outside } = tokenize(raw);
  const { multiple, doubt } = findMarkers(tokens);
  if (multiple) return { pack: 'multiple', reason: multiple };
  if (outside) return { pack: 'unknown', reason: 'outside-alphabet' };
  if (doubt) return { pack: 'unknown', reason: doubt };
  return { pack: 'single', reason: 'none' };
}

/** The pack alone: what a payload line carries, under `RETAIL_METAL_PACK_RULE`. */
export function retailMetalPack(raw: string | null | undefined): RetailMetalPack {
  return retailMetalPackAssessment(raw).pack;
}
