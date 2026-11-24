/**
 * `RETAIL_METAL_TITLE_RULE` v3: whether a retail product's own title names a precious-metal bullion item, read from its
 * words alone. Costco's capture carries no precious-metal flag, so the product name is the only evidence there is.
 *
 * The rule is versioned, deterministic and owned here. Every list below is closed, and any change to one is a new
 * version. A match is derived evidence, labelled "title-rule" ("by product name"), never an issuer fact. Downstream it
 * may only keep a charge whole and feed a suggestion (docs/costco-receipts.md), so a false match errs on the
 * conservative side.
 *
 * Version 2 adds the year word (yearWordBefore): a year right before an exact weight, as in `2024 1 oz`, reads as a
 * word. Version 1 read it as a number joined to the weight, and gave no weight. So that a year is never read as the
 * whole number of a mixed number (`2024 ½ oz` as 2024½ oz), version 2 also allows that whole number three digits at
 * most. Nothing else changed.
 *
 * Version 3 adds the assay card (isAssayCard): CARD or CARDS is no near-miss word when it comes right after ASSAY, as
 * the title's last word, in a title that names a bullion form apart from ASSAY (a shape word with a weight statement, a
 * coin design right after a metal word, or another bullion word). A bar sold "in assay card" then reads as the bar it
 * is, while an accessory (`Gold Assay Card Holder`) or a title whose only bullion word is ASSAY still never matches.
 * Nothing else changed. The metal guard below (RETAIL_METAL_GUARD) catches what the rule still refuses.
 *
 * A title matches when, read as whole words in upper case, it:
 * 1. names a metal: GOLD, SILVER, PLATINUM or PALLADIUM (several metals match with `metal: null`);
 * 2. names no near-miss word (gold-tone, plated, flatware, coin-cell, stool, chocolate, card, …: NEAR_MISS_WORDS), an
 *    assay card aside (v3);
 * 3. names a bullion form: a bullion word, a coin design right after a metal word ("GOLD EAGLE"; an "Eagle" brand
 *    elsewhere never counts), or a shape word (BAR, COIN, ROUND) together with a weight statement, exact or not.
 *
 * Weights are kept exactly as stated: an unqualified OZ stays `oz` and is never read as troy; only TROY OZ, TROY OUNCE
 * or OZT is `ozt`. Nothing is converted or multiplied by a pack count. An exact weight must fit one strict grammar, read
 * on the title as written (EXACT_SPAN, the left scan, EXACT_UNITS and AFTER_UNIT below), and every weight candidate of
 * the title, of any kind, must state that same exact weight: anything else in or next to a number or unit, a number
 * joined to it on the left, or any other weight evidence anywhere in the title leaves the stated weight null, never a
 * repair or a tail.
 *
 * Pure: no file system, network or clock.
 */

export const RETAIL_METAL_TITLE_RULE = 'title-rule-v3' as const;
export type RetailMetalTitleRule = typeof RETAIL_METAL_TITLE_RULE;

export const RETAIL_METALS = ['XAU', 'XAG', 'XPT', 'XPD'] as const;
export type RetailMetal = (typeof RETAIL_METALS)[number];

export const RETAIL_METAL_FORMS = ['bar', 'coin', 'round', 'ingot', 'bullion'] as const;
export type RetailMetalForm = (typeof RETAIL_METAL_FORMS)[number];

export const RETAIL_WEIGHT_UNITS = ['ozt', 'oz', 'g', 'kg'] as const;
export type RetailWeightUnit = (typeof RETAIL_WEIGHT_UNITS)[number];

/** A weight exactly as a title states it: the number as written (normalized) and its unit, qualifier kept. */
export interface RetailStatedWeight {
  value: string;
  unit: RetailWeightUnit;
}

/** What a match records. Derived evidence ("by product name"), never an issuer fact. */
export interface RetailMetalEvidence {
  metal: RetailMetal | null;
  form: RetailMetalForm | null;
  statedWeight: RetailStatedWeight | null;
  rule: RetailMetalTitleRule;
}

/** The metal words, whole words only ("GOLDEN" and "GOLDFISH" are not GOLD). */
export const METAL_TITLE_WORDS: ReadonlyMap<string, RetailMetal> = new Map([
  ['GOLD', 'XAU'], ['SILVER', 'XAG'], ['PLATINUM', 'XPT'], ['PALLADIUM', 'XPD'],
]);

/** Words that make a title name something other than bullion, however much metal it names. LEAF is one too, except
 * in MAPLE LEAF; CARD and CARDS are none in an assay card (v3, isAssayCard). */
export const NEAR_MISS_WORDS: ReadonlySet<string> = new Set([
  'TONE', 'TONED', 'GOLDTONE', 'SILVERTONE', 'PLATED', 'PLATING', 'FILLED', 'FINISH', 'COLOR', 'COLORED', 'COLOUR',
  'FOIL', 'GLITTER', 'CHOCOLATE', 'CANDY', 'COCOA', 'FLATWARE', 'SILVERWARE', 'CUTLERY', 'UTENSIL', 'UTENSILS',
  'JEWELRY', 'NECKLACE', 'BRACELET', 'EARRING', 'EARRINGS', 'PENDANT', 'CHAIN', 'WATCH', 'STOOL', 'PURSE', 'WALLET',
  'BAG', 'BACKPACK', 'CELL', 'BATTERY', 'BATTERIES', 'OXIDE', 'POLISH', 'CLEANER', 'CARD', 'CARDS', 'MEMBER',
  'MEMBERSHIP', 'STAR',
]);

/** Words only bullion carries. INGOT also gives the form `ingot`; BULLION and ASSAY only `bullion`. */
export const BULLION_TITLE_WORDS: ReadonlySet<string> = new Set([
  'BULLION', 'INGOT', 'ASSAY', 'KRUGERRAND', 'BRITANNIA', 'PHILHARMONIC',
]);

/** The coin designs, closed: each counts only right after a metal word ("GOLD EAGLE", "SILVER MAPLE LEAF"). */
export const COIN_DESIGN_WORDS: ReadonlySet<string> = new Set(['EAGLE', 'MAPLE', 'BUFFALO', 'KANGAROO', 'PANDA']);

const BAR_WORDS: ReadonlySet<string> = new Set(['BAR', 'BARS']);
const COIN_WORDS: ReadonlySet<string> = new Set(['COIN', 'COINS', 'KRUGERRAND', 'BRITANNIA', 'PHILHARMONIC']);
const ROUND_WORDS: ReadonlySet<string> = new Set(['ROUND', 'ROUNDS']);

/**
 * Exact weights follow one strict grammar, read on the title exactly as written: nothing is normalized, repaired or
 * spaced apart first. A weight statement is a numeric span, then at most one space or hyphen, then a unit token.
 *
 * - The numeric span is one of: an ASCII decimal (`0.5`, `31.1`); an ASCII fraction (`1/10`, the design's own
 *   example); an ASCII whole number of at most three digits, one space and one vulgar fraction from VULGAR_FRACTIONS
 *   (`1 ½`; v2 caps the whole number, so a year is never one: `2024 ½` is the year 2024, then ½); such a vulgar
 *   fraction alone (`½`); or an ASCII whole number (`1`).
 * - Only the start, white space that shows (not the zero-width U+FEFF), `(`, `[`, a quote or `:` may come right before
 *   the span.
 * - The left scan (standsAlone): from the span, stepping left over white space, RETAIL_WEIGHT_SCAN_SEPARATORS and
 *   RETAIL_WEIGHT_RANGE_WORDS, the start of the title or a plain word must come before any number. So a range, a sum
 *   or a pack count (`1 - 4 oz`, `1 +/- 4 oz`, `1 to 4 oz`, `2 x 1 oz`) gives no exact weight, however many signs or
 *   words join the two numbers.
 * - The year word (yearWordBefore, v2): a year right before the span (`Gold Eagle 2024 1 oz`) is a word, not a number,
 *   but only in one narrow form, and the left scan then goes on from the year's start. Any other year is a number.
 * - The unit token is one of EXACT_UNITS: ASCII letters, in any case, not part of a longer word. Only AFTER_UNIT may
 *   follow it: closing marks, then the end, white space or a letter; never a number, sign, slash, mark or invisible
 *   character (`oz`, U+200B, `t` would read as `ozt`; `1 oz/2`, `1 oz.5`).
 *
 * Anything else in or next to the numeric span or the unit leaves the weight unknown: a null weight, never a guess, a
 * repair or a tail. That covers another number of any script (Arabic-Indic, Devanagari, Roman, superscript, fullwidth,
 * another fraction), a sign (`-`, `+`, `−`, `±`, fullwidth), a letter, a mark or invisible character, a letter only
 * case folding reads as a unit's (the Kelvin sign K, the long s ſ), or any other mark. Such a title still states a
 * weight (a number right before a unit), so a bar or coin stated that way still matches, with no stated weight.
 */
const UNIT = String.raw`TROY\s*(?:OUNCES?|OZ)|OZT|OUNCES?|OZ|KILOGRAMS?|KILOS?|KG|GRAMS?|G`;
/**
 * A unit word as written, in ASCII letters of either case, for telling whether a title states a weight. Case is spelled
 * out letter by letter rather than folded: folding reads the Kelvin sign as a K, and a mark (U+0345) as a letter. The
 * normalized reading of weightCandidates still sees a lookalike unit; an exact one must be one of EXACT_UNITS.
 */
const UNIT_TOKEN = new RegExp(
  String.raw`(?<!\p{L})(?:${UNIT.replace(/[A-Z]/g, (letter) => `[${letter}${letter.toLowerCase()}]`)})(?!\p{L})`, 'gu');
/**
 * The units an exact weight may use, each written in ASCII letters, with at most one ASCII space in TROY OZ or TROY
 * OUNCE(S). A bare OZ stays `oz`; only TROY OZ, TROY OUNCE(S) or OZT is `ozt`.
 */
const EXACT_UNITS: ReadonlyArray<readonly [RegExp, RetailWeightUnit]> = [
  [/^(?:TROY ?(?:OUNCES?|OZ)|OZT)$/i, 'ozt'],
  [/^(?:OUNCES?|OZ)$/i, 'oz'],
  [/^(?:KILOGRAMS?|KILOS?|KG)$/i, 'kg'],
  [/^(?:GRAMS?|G)$/i, 'g'],
];
/** The vulgar fractions an exact weight may use, closed: the common fractional bullion sizes. */
export const RETAIL_WEIGHT_VULGAR_FRACTIONS: ReadonlyMap<string, string> = new Map([
  ['\u00BD', '1/2'], ['\u00BC', '1/4'], ['\u00BE', '3/4'], ['\u2152', '1/10'],
]);
const VULGAR = String.raw`[\u00BD\u00BC\u00BE\u2152]`;
const EXACT_SPAN = new RegExp(
  String.raw`(?<=^|[^\S\uFEFF]|[(\["':\u201C\u2018])(\d{1,5}\.\d{1,4}|\d{1,4}\/\d{1,4}|\d{1,3} ${VULGAR}|${VULGAR}|\d{1,5})[ -]?$`, 'u');
/** White space that shows: any but the zero-width U+FEFF, which a regex counts as white space. */
const VISIBLE_SPACE = /^[^\S\uFEFF]$/u;
/**
 * What the left scan steps over, closed (Root's list): hyphen, en and em dash, plus, slash, plus-minus, tilde, colon,
 * comma, the quotes, an opening bracket and the multiplication sign. Anything else stops it with no exact weight.
 */
export const RETAIL_WEIGHT_SCAN_SEPARATORS: ReadonlySet<string> = new Set([
  '-', '\u2013', '\u2014', '+', '/', '\u00B1', '~', ':', ',', '"', '\'', '\u201C', '\u201D', '\u2018', '\u2019', '(', '[', '\u00D7',
]);
/**
 * The words the left scan steps over, closed, in ASCII letters of any case: Root's range words, and the arithmetic
 * words for the signs the list holds. A word it steps over can only make a weight unknown, never exact.
 */
export const RETAIL_WEIGHT_RANGE_WORDS: ReadonlySet<string> = new Set([
  'to', 'or', 'and', 'x', 'through', 'thru', 'plus', 'minus', 'times',
]);
const ASCII_LETTER = /^[A-Za-z]$/;
/** A year the year word may be: exactly four ASCII digits, 1900 to 2099. */
const YEAR = /^(?:19|20)[0-9]{2}$/;
/**
 * What may come right after an exact weight's unit: closing marks (and an opening bracket), then the end, white space
 * that shows, or a letter. So `1 oz)`, `1 oz,`, `1 oz.` and `1 oz™` read, and `1 oz+`, `1 oz±`, `1 oz/2`, `1 oz.5`,
 * `1 oz-2` or an invisible character after the unit do not.
 */
const AFTER_UNIT = /^[)\]([,.;:!?"'\u2019\u201D\u00AE\u2122\u00A9]*(?:$|[^\S\uFEFF]|[A-Za-z])/u;
/**
 * What may sit between a number and its unit when telling whether a title states a weight (never for an exact one):
 * white space, dashes, and marks and invisible format characters, which show nothing of their own.
 */
const NUMBER_UNIT_GAP = /[\s\p{Pd}\u2212\p{M}\p{Cf}]*$/u;
const ENDS_WITH_NUMBER = /\p{N}$/u;
const INVISIBLE = /^\p{Cf}$/u;

/** Words are read in upper case after compatibility normalization; exact weights never are (EXACT_SPAN). */
function upper(title: string): string {
  return title.normalize('NFKC').toUpperCase();
}

/** An exact weight's unit: the token as one of EXACT_UNITS, in ASCII letters, or null. */
function exactUnit(token: string): RetailWeightUnit | null {
  if (!/^[A-Za-z ]+$/.test(token)) return null;
  return EXACT_UNITS.find(([pattern]) => pattern.test(token))?.[1] ?? null;
}

/** An ASCII number as written, normalized: "1/10", "1", "0.5", "31.1" (no needless zeros); null for zero. */
function valueOf(raw: string): string | null {
  const fraction = /^(\d+)\/(\d+)$/.exec(raw);
  if (fraction) {
    const numerator = fraction[1].replace(/^0+(?=\d)/, '');
    const denominator = fraction[2].replace(/^0+(?=\d)/, '');
    return numerator === '0' || denominator === '0' ? null : `${numerator}/${denominator}`;
  }
  const [whole, decimals = ''] = raw.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const fractionDigits = decimals.replace(/0+$/, '');
  const value = fractionDigits ? `${integer}.${fractionDigits}` : integer;
  return /^0(?:\.0*)?$/.test(value) ? null : value;
}

/** A numeric span's value: "1 ½" is "1 1/2", "½" is "1/2"; null for zero. */
function spanValue(span: string): string | null {
  const vulgar = RETAIL_WEIGHT_VULGAR_FRACTIONS.get(span.slice(-1));
  if (vulgar === undefined) return valueOf(span);
  if (span.length === 1) return vulgar;
  const whole = span.slice(0, -2).replace(/^0+(?=\d)/, '');
  return whole === '0' ? null : `${whole} ${vulgar}`;
}

/** The character (code point) that ends at `at` in `text`. */
function characterBefore(text: string, at: number): string {
  const low = text.charCodeAt(at - 1);
  if (at >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(at - 2, at);
  }
  return text.slice(at - 1, at);
}

/**
 * Whether the token a word starts at, back to white space that shows or the start, holds only ASCII letters and
 * RETAIL_WEIGHT_SCAN_SEPARATORS.
 */
function plainToken(title: string, wordStart: number): boolean {
  let at = wordStart;
  while (at > 0) {
    const character = characterBefore(title, at);
    if (VISIBLE_SPACE.test(character)) return true;
    if (!ASCII_LETTER.test(character) && !RETAIL_WEIGHT_SCAN_SEPARATORS.has(character)) return false;
    at -= character.length;
  }
  return true;
}

/**
 * The year word (v2, Root's narrow rule): whether a year stands right before the numeric span at `spanStart` as a word,
 * not as a number joined to it. It does when all of these hold, and in no other form:
 * - it is a token of exactly four ASCII digits, 1900 to 2099 (YEAR);
 * - exactly one ASCII space, then the span, follows it;
 * - its own left neighbour is the start of the title, an opening bracket (`(` or `[`) right before it, or a plain word
 *   (ASCII letters, in a token of only ASCII letters and separators) one ASCII space before it that is no range word.
 *
 * So `2024 1 oz`, `Gold Eagle 2024 1 oz` and `(2024 1 oz)` qualify. `2 2024 1 oz`, `2024 2025 1 oz`,
 * `2024 to 2025 1 oz`, `12024 1 oz`, `2024-1 oz`, `2024  1 oz`, `Gold Bar, 2024 1 oz`, and a year with any other number
 * next to it do not: there the year is a number, as in version 1.
 */
function yearWordBefore(title: string, spanStart: number): boolean {
  const yearStart = spanStart - 5;
  if (yearStart < 0 || title[spanStart - 1] !== ' ' || !YEAR.test(title.slice(yearStart, spanStart - 1))) return false;
  if (yearStart === 0) return true;
  const before = title[yearStart - 1];
  if (before === '(' || before === '[') return true;
  if (before !== ' ' || yearStart < 2 || !ASCII_LETTER.test(title[yearStart - 2])) return false;
  let wordStart = yearStart - 2;
  while (wordStart > 0 && ASCII_LETTER.test(title[wordStart - 1])) wordStart -= 1;
  return !RETAIL_WEIGHT_RANGE_WORDS.has(title.slice(wordStart, yearStart - 1).toLowerCase()) && plainToken(title, wordStart);
}

/**
 * The left scan: whether no number is joined to an exact weight's number on its left. From where the numeric span
 * starts, or from where a year word right before it starts (yearWordBefore), it steps left over white space that shows,
 * RETAIL_WEIGHT_SCAN_SEPARATORS and RETAIL_WEIGHT_RANGE_WORDS (whole runs of ASCII letters). Reaching the start of the
 * title, or a plain word (ASCII letters, in a token of only ASCII letters and separators), means none is. Reaching
 * anything else gives no exact weight: a number of any script (a range, a sum, a pack count, any other year), another
 * letter, a mark, an invisible character, or any other character (`.`, `;`, `)`, `&`, `−`, …), however many separators
 * and range words come first. A year word ends nothing by itself: past an opening bracket the scan goes on, so
 * `2 x (2024 1 oz)` is a pack count, as `2 x (1 oz)` is.
 */
function standsAlone(title: string, spanStart: number): boolean {
  let at = yearWordBefore(title, spanStart) ? spanStart - 5 : spanStart;
  while (at > 0) {
    const character = characterBefore(title, at);
    if (VISIBLE_SPACE.test(character) || RETAIL_WEIGHT_SCAN_SEPARATORS.has(character)) {
      at -= character.length;
      continue;
    }
    if (!ASCII_LETTER.test(character)) return false;
    let wordStart = at - 1;
    while (wordStart > 0 && ASCII_LETTER.test(title[wordStart - 1])) wordStart -= 1;
    if (!RETAIL_WEIGHT_RANGE_WORDS.has(title.slice(wordStart, at).toLowerCase())) return plainToken(title, wordStart);
    at = wordStart;
  }
  return true;
}

/**
 * The exact weight a unit token at `unitAt` states with the number right before it, or null when the number, the left
 * scan, the unit or what follows it isn't the grammar's.
 */
function exactWeight(title: string, unitAt: number, token: string): RetailStatedWeight | null {
  const unit = exactUnit(token);
  if (unit === null || !AFTER_UNIT.test(title.slice(unitAt + token.length))) return null;
  const span = EXACT_SPAN.exec(title.slice(0, unitAt));
  if (!span || !standsAlone(title, span.index)) return null;
  const value = spanValue(span[1]);
  return value === null ? null : { value, unit };
}

interface WeightReading {
  /** The exact weight every weight candidate of the title states, or null. */
  statement: RetailStatedWeight | null;
  /** Whether the title states a weight at all: a number right before a unit, exact or not, raw or normalized. */
  stated: boolean;
}

/** A unit right after a number (NUMBER_UNIT_GAP aside), in `text`. */
const numberedUnits = (text: string) =>
  [...text.matchAll(UNIT_TOKEN)].filter((unit) => ENDS_WITH_NUMBER.test(text.slice(0, unit.index).replace(NUMBER_UNIT_GAP, '')));

/**
 * The title with each character mapped by compatibility normalization (fullwidth digits and units, ㎏, …) and invisible
 * format characters dropped, and where each mapped character came from in the title as written. The weight reader and
 * the metal guard read this one mapping.
 */
function mappedTitle(title: string): { text: string; sources: number[] } {
  let text = '';
  const sources: number[] = [];
  let index = 0;
  for (const character of title) {
    const mapped = INVISIBLE.test(character) ? '' : character.normalize('NFKC');
    text += mapped;
    for (let offset = 0; offset < mapped.length; offset += 1) sources.push(index);
    index += character.length;
  }
  return { text, sources };
}

/**
 * Every weight candidate of a title, by where its unit starts in the title as written. It is read raw, and read on the
 * mapped title (mappedTitle), traced back to where it came from. So a candidate only one reading sees is counted too, and
 * one both see is counted once.
 */
function weightCandidates(title: string): { raw: RegExpMatchArray[]; all: Set<number> } {
  const raw = numberedUnits(title);
  const all = new Set(raw.map((unit) => unit.index ?? -1));
  const { text, sources } = mappedTitle(title);
  for (const unit of numberedUnits(text)) all.add(sources[unit.index ?? 0]);
  return { raw, all };
}

/**
 * Agreement is whole-title: a title states an exact weight only when every weight candidate it holds, of any kind, raw
 * or normalized, is exact as written, and all state the same value and unit qualifier (`1 oz (1 oz)` is 1 oz). One
 * the grammar can't read, a different value, or `oz` beside `ozt` leaves the weight unknown.
 */
function readWeights(title: string): WeightReading {
  const { raw, all } = weightCandidates(title);
  let statement: RetailStatedWeight | null = null;
  if (raw.length > 0 && all.size === raw.length) {
    const weights = raw.map((unit) => exactWeight(title, unit.index ?? 0, unit[0]));
    const [first] = weights;
    if (first && weights.every((weight) => weight !== null && weight.value === first.value && weight.unit === first.unit)) {
      statement = first;
    }
  }
  return { statement, stated: all.size > 0 };
}

/** The title's exact weight statement, as a list of one, or none (readWeights). */
export function retailStatedWeights(title: string): RetailStatedWeight[] {
  const { statement } = readWeights(title);
  return statement === null ? [] : [statement];
}

/** The title's words: runs of letters, in order ("GOLD-TONE" is GOLD and TONE; "GOLDTONE" one word). */
function wordsOf(title: string): string[] {
  return upper(title).split(/[^A-Z]+/).filter((word) => word.length > 0);
}

/**
 * The form a matching title names (v5 §8.5). Bar or coin evidence wins over plain bullion ("bar in assay" is a bar). Bar
 * and coin together give no form; so does bar or coin beside a round or an ingot. Without bar or coin, exactly one of
 * round, ingot and bullion (BULLION or ASSAY) is the form, and two of them give none.
 */
function formOf(words: readonly string[], designAfterMetal: boolean): RetailMetalForm | null {
  const bar = words.some((word) => BAR_WORDS.has(word));
  const coin = designAfterMetal || words.some((word) => COIN_WORDS.has(word));
  const round = words.some((word) => ROUND_WORDS.has(word));
  const ingot = words.includes('INGOT');
  const bullion = words.includes('BULLION') || words.includes('ASSAY');
  if (bar && coin) return null;
  if (bar || coin) return round || ingot ? null : bar ? 'bar' : 'coin';
  const others: RetailMetalForm[] = [];
  if (round) others.push('round');
  if (ingot) others.push('ingot');
  if (bullion) others.push('bullion');
  return others.length === 1 ? others[0] : null;
}

/** The words an assay card ends in (v3): CARD or CARDS right after ASSAY. */
const ASSAY_CARD_WORDS: ReadonlySet<string> = new Set(['CARD', 'CARDS']);

/**
 * Whether the word at `index` is an assay card's (v3), and so no near-miss word: CARD or CARDS right after ASSAY, as the
 * title's last word (numbers and punctuation are no words), in a title that names a bullion form apart from ASSAY. An
 * accessory names something after the card ("Assay Card Holder"), and a title whose only bullion word is ASSAY proves
 * nothing of its own; both stay refused, and the metal guard catches them.
 */
function isAssayCard(words: readonly string[], index: number, formApartFromAssay: boolean): boolean {
  return ASSAY_CARD_WORDS.has(words[index]) && words[index - 1] === 'ASSAY' && index === words.length - 1 && formApartFromAssay;
}

/** What refused a title that names no bullion, as the rule decided it. */
type RuleRefusal = 'no-metal-word' | 'near-miss' | 'shape-without-weight' | 'no-bullion-form';

/** The rule's one reading of a title: its evidence, or what refused it. */
function readTitle(title: string): { evidence: RetailMetalEvidence } | { refusal: RuleRefusal } {
  if (typeof title !== 'string' || title.length === 0) return { refusal: 'no-metal-word' };
  const words = wordsOf(title);
  const metals = new Set<RetailMetal>();
  for (const word of words) {
    const metal = METAL_TITLE_WORDS.get(word);
    if (metal) metals.add(metal);
  }
  if (metals.size === 0) return { refusal: 'no-metal-word' };
  const designAfterMetal = words.some((word, index) => COIN_DESIGN_WORDS.has(word) && index > 0 && METAL_TITLE_WORDS.has(words[index - 1]));
  const shape = words.some((word) => BAR_WORDS.has(word) || COIN_WORDS.has(word) || ROUND_WORDS.has(word));
  // A shape word needs a weight statement beside it. One outside the exact grammar still is one: the title then matches,
  // with no stated weight, rather than dropping a bar or coin from the metal evidence.
  const weights = readWeights(title);
  const shapeWithWeight = shape && weights.stated;
  const formApartFromAssay = designAfterMetal || shapeWithWeight || words.some((word) => word !== 'ASSAY' && BULLION_TITLE_WORDS.has(word));
  if (words.some((word, index) => (NEAR_MISS_WORDS.has(word) && !isAssayCard(words, index, formApartFromAssay))
    || (word === 'LEAF' && words[index - 1] !== 'MAPLE'))) {
    return { refusal: 'near-miss' };
  }
  const bullionWord = words.some((word) => BULLION_TITLE_WORDS.has(word));
  if (!bullionWord && !designAfterMetal && !shapeWithWeight) return { refusal: shape ? 'shape-without-weight' : 'no-bullion-form' };
  return {
    evidence: {
      metal: metals.size === 1 ? [...metals][0] : null,
      form: formOf(words, designAfterMetal),
      statedWeight: weights.statement,
      rule: RETAIL_METAL_TITLE_RULE,
    },
  };
}

/**
 * The rule's evidence for one product title, or null when the title doesn't name bullion. Deterministic: the same title
 * always gives the same answer.
 */
export function retailMetalTitleEvidence(title: string): RetailMetalEvidence | null {
  const reading = readTitle(title);
  return 'evidence' in reading ? reading.evidence : null;
}

// ---------------------------------------------------------------------------
// The metal guard (metal-guard-v1)
// ---------------------------------------------------------------------------

/**
 * `RETAIL_METAL_GUARD` v1, fail-closed (Root's ruling, 11/09): a line the rule does not read as metal, whose title names
 * a metal as a whole word and shows bullion evidence, is metal-uncertain. It is flagged, never silently non-metal: no
 * line with a metal word and bullion evidence is ever classified as no metal. A flag only marks the line and changes
 * nothing else of the retail record. Holding the line is the metals ledger's, from the metals contract's follow-up 1
 * (after this policy); there an owner's decision or a reviewed rule version releases it.
 *
 * It reads the title's words twice (guardReadings): on the rule's own normalization (`upper`: compatibility
 * normalization and upper case, so width never hides a word), and on the title as written, in upper case only, so that
 * a sign normalization spells in letters never joins a word (™ is TM: "GOLD™" is GOLD). In each reading it finds each
 * word of its closed vocabulary (the metal words, BULLION_TITLE_WORDS, the rule's COIN_DESIGN_WORDS and its shape
 * words) as the rule's letters A–Z
 * with no letter right before or after, so punctuation never hides one either; a word either reading finds counts. A
 * character that never shows (NEVER_SHOWS: a format character, or any default-ignorable code point, such as a variation
 * selector, a filler or the combining grapheme joiner) never hides a word wherever it stands: inside a word it is
 * skipped, and beside one it parts it from the next. The rule itself is unchanged. Bullion evidence is any of, in this
 * closed order, which mirrors every path by which the rule reads a title as metal (a bullion word, a coin design right
 * after a metal word, a shape with a weight), so no title the rule reads as metal is ever without evidence:
 * - `bullion-word`: a BULLION_TITLE_WORDS word;
 * - `design-after-metal`: a COIN_DESIGN_WORDS word right after a metal word in the same reading, with no letter between
 *   them: the rule's own design path (c3decfa5, 11/09);
 * - `shape-with-weight`: a guard shape word, and the title states a weight (a number right before a unit, as the rule
 *   reads one: exact or not, raw or mapped), or does with every character that never shows dropped;
 * - `troy-or-metric-weight`: a number right before a troy, gram or kilo unit (TROY OZ, TROY OUNCE(S), OZT, G, GRAM(S),
 *   KG, KILO(S), KILOGRAM(S)), as the rule reads units, on the title raw, mapped, or with every character that never
 *   shows dropped; a bare OZ or OUNCE is none;
 * - `purity`: a karat (a whole number from 8 to 24 right before K, KT, KARAT or KARATS, at most one space or hyphen
 *   between) or a fineness (a listed fineness written with a point, or right before FINE, PURE or PURITY), on the
 *   title mapped, or with every character that never shows dropped too;
 * - `adjacency`: a guard shape word right before or after a metal word in the same reading, with no letter between
 *   them (numbers, punctuation and the characters that never show are no words).
 *
 * The guard's shape words are the rule's own (BAR, BARS, COIN, COINS, KRUGERRAND, BRITANNIA, PHILHARMONIC, ROUND,
 * ROUNDS), and INGOT and INGOTS. Its coin design words are the rule's COIN_DESIGN_WORDS (EAGLE, MAPLE, BUFFALO,
 * KANGAROO, PANDA), read from the rule itself so that its design path and the guard's never diverge. Its purity lists
 * are the pack rule's (metals-pack-v1, unchanged in v2), held here as the guard's own so
 * that neither rule changes the other. Every list is closed, and any change to one is a new guard version.
 *
 * Pure: no file system, network or clock.
 */
export const RETAIL_METAL_GUARD = 'metal-guard-v1' as const;
export type RetailMetalGuard = typeof RETAIL_METAL_GUARD;

/** The bullion evidence the guard reads, in its closed order: a flag lists what fires in this order. */
export const RETAIL_METAL_GUARD_EVIDENCE = ['bullion-word', 'design-after-metal', 'shape-with-weight', 'troy-or-metric-weight', 'purity', 'adjacency'] as const;
export type RetailMetalGuardEvidence = (typeof RETAIL_METAL_GUARD_EVIDENCE)[number];

/**
 * What refused a flagged line: `not-assessed` (a fee or fuel line, or an item line with no first description, which the
 * rule never reads), or the rule's own refusal of the title. `no-metal-word` is reached only when the rule's words hold
 * no metal word but the guard's do: a character that never shows splits one for the rule, or normalization joins
 * letters to it (™ as TM).
 */
export const RETAIL_METAL_GUARD_REFUSALS = ['not-assessed', 'no-metal-word', 'near-miss', 'shape-without-weight', 'no-bullion-form'] as const;
export type RetailMetalGuardRefusal = (typeof RETAIL_METAL_GUARD_REFUSALS)[number];

/** A flag's clause: what refused the line, and the first bullion evidence that fired. Closed: 30 codes. */
export type RetailMetalGuardClause = `${RetailMetalGuardRefusal}/${RetailMetalGuardEvidence}`;
export const RETAIL_METAL_GUARD_CLAUSES: readonly RetailMetalGuardClause[] = RETAIL_METAL_GUARD_REFUSALS.flatMap(
  (refusal) => RETAIL_METAL_GUARD_EVIDENCE.map((evidence): RetailMetalGuardClause => `${refusal}/${evidence}`));

/** The guard's shape words: the rule's own shape words, and INGOT and INGOTS. */
export const RETAIL_METAL_GUARD_SHAPE_WORDS: ReadonlySet<string> = new Set([...BAR_WORDS, ...COIN_WORDS, ...ROUND_WORDS, 'INGOT', 'INGOTS']);
/** Karat words, after a whole number from 8 to 24 (the pack rule's RETAIL_PACK_KARAT_WORDS, metals-pack-v2). */
export const RETAIL_METAL_GUARD_KARAT_WORDS: ReadonlySet<string> = new Set(['K', 'KT', 'KARAT', 'KARATS']);
/** Fineness words, after a listed fineness (the pack rule's RETAIL_PACK_FINENESS_WORDS, metals-pack-v2). */
export const RETAIL_METAL_GUARD_FINENESS_WORDS: ReadonlySet<string> = new Set(['FINE', 'PURE', 'PURITY']);
/** Finenesses as written (the pack rule's RETAIL_PACK_FINENESS_SHAPES, metals-pack-v2). */
export const RETAIL_METAL_GUARD_FINENESS_SHAPES: ReadonlySet<string> = new Set([
  '375', '585', '750', '800', '900', '916', '917', '925', '950', '958', '986', '995', '999', '9167', '9995', '9999',
  '99999', '91.67', '99.5', '99.9', '99.95', '99.99', '99.999', '916.7', '999.5', '999.9', '999.99', '.900', '.916',
  '.9167', '.925', '.958', '.986', '.995', '.999', '.9995', '.9999', '.99999', '0.900', '0.916', '0.9167', '0.925',
  '0.958', '0.986', '0.995', '0.999', '0.9995', '0.9999', '0.99999',
]);

/** A troy, gram or kilo unit, as the rule's unit reading writes it. */
const TROY_OR_METRIC_UNIT = /^(?:TROY\s*(?:OUNCES?|OZ)|OZT|KILOGRAMS?|KILOS?|KG|GRAMS?|G)$/i;
/** A karat: a whole number right before a word, at most one space or hyphen between (checked against the lists). */
const KARAT = /(?<![\p{N}.,/])([0-9]{1,2})[ -]?([A-Z]+)(?![\p{L}\p{N}])/gu;
/** A number that may be a fineness, whole (checked against the list). */
const FINENESS = /(?<![\p{N}.,/])([0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?!\.?\p{N})/gu;
/** The word right after a number, past spaces and hyphens. */
const WORD_AFTER = /^[ -]*([A-Z]+)/;

/**
 * The characters that never show: every format character (\p{Cf}) and every default-ignorable code point (variation
 * selectors, Hangul fillers, the combining grapheme joiner, Mongolian free variation selectors, …). The guard skips them
 * inside a word, and drops them for its own readings of a weight statement, a troy-or-metric weight and purity; the
 * rule's mappedTitle and its weight reading are unchanged.
 */
const NEVER_SHOWS = String.raw`[\p{Cf}\p{Default_Ignorable_Code_Point}]`;
const NEVER_SHOWS_RUNS = new RegExp(`${NEVER_SHOWS}+`, 'gu');
/** The title with every character that never shows dropped: for the guard's own readings only. */
const visibleOnly = (title: string) => title.replace(NEVER_SHOWS_RUNS, '');

/**
 * Whether the title states a weight, exact or not, as the rule's weight reader sees one (readWeights: raw or mapped), or
 * as it sees the title visible only: a character that never shows inside a unit, or a filler right beside one, never
 * hides the statement from the guard (9854b7c2, 11/09). The rule's own statement and exact weight are unchanged.
 */
function weightStated(title: string): boolean {
  return readWeights(title).stated || readWeights(visibleOnly(title)).stated;
}

/** Whether the title states a troy, gram or kilo weight as the rule reads units: raw, mapped, or visible only and mapped. */
function troyOrMetricWeight(title: string): boolean {
  return [title, mappedTitle(title).text, mappedTitle(visibleOnly(title)).text]
    .some((text) => numberedUnits(text).some((unit) => TROY_OR_METRIC_UNIT.test(unit[0])));
}

/** Whether the title, mapped and in upper case, states a karat or a fineness: as mapped, or visible only and mapped. */
function purity(title: string): boolean {
  return [mappedTitle(title).text, mappedTitle(visibleOnly(title)).text].some((text) => purityIn(upper(text)));
}

function purityIn(text: string): boolean {
  for (const match of text.matchAll(KARAT)) {
    const whole = Number(match[1]);
    if (whole >= 8 && whole <= 24 && RETAIL_METAL_GUARD_KARAT_WORDS.has(match[2])) return true;
  }
  for (const match of text.matchAll(FINENESS)) {
    if (!RETAIL_METAL_GUARD_FINENESS_SHAPES.has(match[1])) continue;
    if (match[1].includes('.')) return true;
    const after = WORD_AFTER.exec(text.slice((match.index ?? 0) + match[0].length));
    if (after !== null && RETAIL_METAL_GUARD_FINENESS_WORDS.has(after[1])) return true;
  }
  return false;
}

/** The bullion evidence a title shows, in the closed order, over the guard's readings of its words (guardReadings). */
function guardEvidence(title: string, readings: readonly GuardReading[]): RetailMetalGuardEvidence[] {
  const evidence: RetailMetalGuardEvidence[] = [];
  if (readings.some((found) => found.bullion.length > 0)) evidence.push('bullion-word');
  if (readings.some(designRightAfterMetal)) evidence.push('design-after-metal');
  if (readings.some((found) => found.shapes.length > 0) && weightStated(title)) evidence.push('shape-with-weight');
  if (troyOrMetricWeight(title)) evidence.push('troy-or-metric-weight');
  if (purity(title)) evidence.push('purity');
  if (readings.some(adjacent)) {
    evidence.push('adjacency');
  }
  return evidence;
}

/**
 * Whether one reading has a coin design word right after a metal word, with no letter between the two: the rule's design
 * path, where the design is the metal word's next word (its words are runs of letters), read through what never shows.
 */
function designRightAfterMetal(found: GuardReading): boolean {
  return found.metals.some((metal) => found.designs.some((design) => metal.end <= design.start
    && !/[A-Z]/.test(found.text.slice(metal.end, design.start))));
}

/** Whether one reading has a shape word right before or after a metal word, with no letter between the two (numbers,
 * punctuation and the characters that never show are no words). */
function adjacent(found: GuardReading): boolean {
  const between = (from: number, to: number) => !/[A-Z]/.test(found.text.slice(from, to));
  return found.metals.some((metal) => found.shapes.some((shape) => (metal.end <= shape.start ? between(metal.end, shape.start)
    : shape.end <= metal.start && between(shape.end, metal.start))));
}

/** Where a word of the guard's vocabulary stands in one reading of the title. */
interface GuardWord {
  word: string;
  start: number;
  end: number;
}
/** One reading of the title's words: its text, and the guard's words found in it. */
interface GuardReading {
  text: string;
  metals: GuardWord[];
  bullion: GuardWord[];
  designs: GuardWord[];
  shapes: GuardWord[];
}

const GUARD_PATTERNS = new Map<string, RegExp>();
/**
 * A word of the guard's vocabulary as a reading writes it: its letters in order with only characters that never show
 * between them (NEVER_SHOWS), and no letter (A–Z, the rule's letters) right before or after it. Width and punctuation
 * never hide a word, as for the rule's own tokenizer (wordsOf); and a character that never shows never does either,
 * wherever it stands: inside the word it is skipped, and beside it, it parts the word from the next one.
 */
function guardPattern(word: string): RegExp {
  let pattern = GUARD_PATTERNS.get(word);
  if (pattern === undefined) {
    pattern = new RegExp(`(?<![A-Z])${[...word].join(`${NEVER_SHOWS}*`)}(?![A-Z])`, 'gu');
    GUARD_PATTERNS.set(word, pattern);
  }
  return pattern;
}

/**
 * The guard's two readings of a title's words: on the rule's normalization (`upper`), and on the title as written in
 * upper case only, so that a sign normalization spells in letters (™ as TM, ℠ as SM) never joins a word.
 */
function guardReadings(title: string): GuardReading[] {
  return [upper(title), title.toUpperCase()].map((text) => {
    const find = (words: Iterable<string>) => {
      const found: GuardWord[] = [];
      for (const word of words) {
        for (const match of text.matchAll(guardPattern(word))) {
          found.push({ word, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
        }
      }
      return found;
    };
    return {
      text, metals: find(METAL_TITLE_WORDS.keys()), bullion: find(BULLION_TITLE_WORDS), designs: find(COIN_DESIGN_WORDS),
      shapes: find(RETAIL_METAL_GUARD_SHAPE_WORDS),
    };
  });
}

/** The guard's reading of a line's title. */
export interface RetailMetalGuardReading {
  /** The line is no metal, names a metal as a whole word and shows bullion evidence: flag it. */
  uncertain: boolean;
  /** What refused the line and the first evidence that fired, when uncertain; null otherwise. */
  clause: RetailMetalGuardClause | null;
  /** Every bullion evidence the title shows, in the closed order (also when the line is metal or names none). */
  evidence: RetailMetalGuardEvidence[];
  /** A reading of the guard holds a metal word. */
  metalWord: boolean;
  /**
   * The one metal the title's whole-word metal words name, over both readings; null when they name none or several. A
   * flag carries it, so that an owner's "bullion" decision never has to name the metal.
   */
  metal: RetailMetal | null;
}

/**
 * The metal guard for one line's title (its raw text: a warehouse line's two description lines joined). `assessed` is
 * whether the rule reads this line at all: false for a fee or fuel line, which is never metal. Deterministic.
 */
export function retailMetalTitleGuard(title: string, options: { assessed: boolean }): RetailMetalGuardReading {
  if (typeof title !== 'string' || title.length === 0) return { uncertain: false, clause: null, evidence: [], metalWord: false, metal: null };
  const readings = guardReadings(title);
  const metals = new Set<RetailMetal>(readings.flatMap((found) => found.metals.map(({ word }) => METAL_TITLE_WORDS.get(word)!)));
  const metalWord = metals.size > 0;
  const metal = metals.size === 1 ? [...metals][0] : null;
  const evidence = guardEvidence(title, readings);
  let refusal: RetailMetalGuardRefusal | null = null;
  if (!options.assessed) refusal = 'not-assessed';
  else {
    const reading = readTitle(title);
    if ('refusal' in reading) refusal = reading.refusal;
  }
  const [first] = evidence;
  if (!metalWord || refusal === null || first === undefined) return { uncertain: false, clause: null, evidence, metalWord, metal };
  return { uncertain: true, clause: `${refusal}/${first}`, evidence, metalWord, metal };
}
