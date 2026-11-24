/**
 * The raw-derived observations of the content rule (`METALS_RULES.content`, design §4.4.1 step 5; unchanged since
 * `metals-content-v1`): the purity a title states, the basis of its stated mass, and the coin design it names. The
 * Walmart and CollectPure converters read them from a product's raw title, before any sanitizing, normalizing or
 * truncating; a payload carries them as pinned observations, and nothing downstream re-runs them (a stored title may be
 * cut or sanitized).
 *
 * They fail closed, and never read more than the text shows:
 * - The text is read in full only when it is a non-blank string, every character is printable ASCII or one of
 *   RETAIL_PACK_ALPHABET_EXTRAS (so a fullwidth, lookalike or invisible character, "…", a tab or a line break is never
 *   read past), and it shows no cut or mask (three dots or three asterisks in a row anywhere). Otherwise there is no
 *   purity and no design, and the mass basis is `unknown`.
 * - Purity: every form of METALS_PURITY_FORMS the title writes as a whole token; none, or two that differ in exact
 *   value, is no purity.
 * - Mass basis: `conflict` when the title qualifies its mass as both gross and fine; otherwise `approximate`, `gross`
 *   or `fine`, the first whose closed qualifiers it names, in that order; otherwise `none`.
 * - Design: a design word right after a metal word, or a coin's own name; two different designs are no design.
 *
 * Every list is closed, and any change to one is a new version of the content rule. Words are whole runs of ASCII
 * letters, compared in upper case (only ASCII letters are folded, never by `toUpperCase`), so "EAGLES" is no EAGLE and
 * the Kelvin sign no K; numbers are whole runs of ASCII digits; a phrase is its words in a row, only spaces between.
 *
 * Pure: no file system, network or clock.
 */

import { RETAIL_PACK_ALPHABET_EXTRAS } from '../retailImportTool/metalPackRule.js';
import type { MetalsCoinDesign, MetalsMassBasis, MetalsPurity } from './model.js';
import { formatRational, rational } from './rational.js';

const exact = (num: bigint, den: bigint) => formatRational(rational(num, den));

/**
 * The purities a title may state, closed: each form as written (a title's k reads as K) with its exact value in lowest
 * terms. A point fineness is a decimal (".9999"), a whole or decimal one is in thousandths ("999", "999.9"), a
 * percentage in hundredths, a karat in 24ths. Nothing else is a purity ("0.999", "9999", "925", "18K").
 */
export const METALS_PURITY_FORMS: ReadonlyMap<string, string> = new Map([
  ['.999', exact(999n, 1000n)],
  ['.9995', exact(9995n, 10000n)],
  ['.9999', exact(9999n, 10000n)],
  ['.99999', exact(99999n, 100000n)],
  ['999', exact(999n, 1000n)],
  ['999.9', exact(9999n, 10000n)],
  ['99.9%', exact(999n, 1000n)],
  ['99.99%', exact(9999n, 10000n)],
  ['90%', exact(90n, 100n)],
  ['91.67%', exact(9167n, 10000n)],
  ['24K', exact(24n, 24n)],
  ['22K', exact(22n, 24n)],
]);

/** What may stand right before a purity form, besides the start: a space, an opening bracket, a dash, a colon, a comma
 * or a quote. */
export const METALS_PURITY_BEFORE: ReadonlySet<string> = new Set([
  ' ', '\u00A0', '(', '[', '-', ':', ',', '"', '\'', '\u2018', '\u2019', '\u201C', '\u201D',
]);

/** What may stand right after one, besides the end: a space, a closing bracket, a comma, a dash, a colon, a semicolon or
 * a quote; never a letter, a digit, a point, a slash or a percent sign. */
export const METALS_PURITY_AFTER: ReadonlySet<string> = new Set([
  ' ', '\u00A0', ')', ']', ',', '-', ':', ';', '"', '\'', '\u2018', '\u2019', '\u201C', '\u201D',
]);

/** Qualifiers that make the stated mass the piece's gross weight, anywhere in the title (GROSS alone is one). */
export const METALS_GROSS_QUALIFIERS: ReadonlySet<string> = new Set(['GROSS', 'GROSS WEIGHT', 'GROSS WT']);

/** Qualifiers that make it the fine (metal) content, anywhere in the title. */
export const METALS_FINE_QUALIFIERS: ReadonlySet<string> = new Set([
  'AGW', 'ASW', 'APW', 'FINE WEIGHT', 'FINE WT', 'ACTUAL GOLD WEIGHT', 'ACTUAL SILVER WEIGHT',
]);

/**
 * Qualifiers that make it the fine content only right after a stated mass ("1 ozt Fine Gold"); anywhere else ("Fine
 * Gold Bar 1 oz", ".9999 Fine Gold") they describe the metal, not the mass.
 */
export const METALS_FINE_METAL_QUALIFIERS: ReadonlySet<string> = new Set([
  'FINE GOLD', 'FINE SILVER', 'FINE PLATINUM', 'FINE PALLADIUM',
]);

/**
 * The units of a stated mass before a fine-metal qualifier. A stated mass is a number (ASCII digits with at most one
 * decimal part or fraction: "1", "31.1", "1/10"; never part of a longer run of digits joined by points, commas or
 * slashes, such as "2.1.1", "1,000" or ".5"), at most one space, and one of these units; one or more spaces then come
 * before the qualifier.
 */
export const METALS_FINE_MASS_UNITS: ReadonlySet<string> = new Set([
  'OZ', 'OZT', 'OUNCE', 'OUNCES', 'TROY OZ', 'TROY OUNCE', 'TROY OUNCES', 'G', 'GRAM', 'GRAMS', 'KG', 'KILO', 'KILOS',
  'KILOGRAM', 'KILOGRAMS',
]);

/** Qualifiers that make the stated mass a minimum or an approximation, anywhere in the title. */
export const METALS_APPROXIMATE_QUALIFIERS: ReadonlySet<string> = new Set([
  'MIN', 'MINIMUM', 'AT LEAST', 'APPROX', 'APPROXIMATELY', 'CA',
]);

/** Signs that do the same, as these characters in a row anywhere in the title. */
export const METALS_APPROXIMATE_SIGNS: ReadonlySet<string> = new Set(['~', '+/-']);

/** The metal words a design word must follow. */
export const METALS_METAL_WORDS: ReadonlySet<string> = new Set(['GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM']);

/**
 * Design words that name a design only right after a metal word, with only spaces between ("Gold Eagle", "Silver
 * Maple Leaf"); "American Eagle", "Gold-Eagle" or "Gold 2024 Eagle" names none.
 */
export const METALS_DESIGNS_AFTER_METAL: ReadonlyMap<string, MetalsCoinDesign> = new Map([
  ['EAGLE', 'eagle'], ['MAPLE', 'maple-leaf'], ['BUFFALO', 'buffalo'], ['KANGAROO', 'kangaroo'], ['PANDA', 'panda'],
]);

/** Coins' own names, singular or plural: a design wherever they stand. */
export const METALS_DESIGN_NAMES: ReadonlyMap<string, MetalsCoinDesign> = new Map([
  ['KRUGERRAND', 'krugerrand'], ['KRUGERRANDS', 'krugerrand'], ['BRITANNIA', 'britannia'], ['BRITANNIAS', 'britannia'],
  ['PHILHARMONIC', 'philharmonic'], ['PHILHARMONICS', 'philharmonic'],
]);

/** A title's three content observations, as a payload line pins them. */
export interface MetalsTitleObservations {
  purity: MetalsPurity | null;
  massBasis: MetalsMassBasis;
  design: MetalsCoinDesign | null;
}

type TokenKind = 'word' | 'number' | 'space' | 'other';
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

/** The raw text when it can be read in full: a non-blank string, every character in the alphabet, not cut or masked. */
function readInFull(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  for (const character of raw) if (!inAlphabet(character)) return null;
  return /\.{3}|\*{3}/.test(raw) ? null : raw;
}

/** Text read in full as tokens: words (in upper case), numbers and runs of spaces, and every other character alone. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const character of text) {
    const kind: TokenKind = isAsciiLetter(character) ? 'word'
      : isAsciiDigit(character) ? 'number'
        : character === ' ' || character === '\u00A0' ? 'space'
          : 'other';
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind && kind !== 'other') last.text += character;
    else tokens.push({ kind, text: character });
  }
  for (const token of tokens) if (token.kind === 'word') token.text = asciiUpper(token.text);
  return tokens;
}

/** The index of a phrase's last word when its words stand from `start` with only spaces between, or -1. */
function phraseEnd(tokens: readonly Token[], start: number, phrase: readonly string[]): number {
  if (start < 0) return -1;
  for (let index = 0; index < phrase.length; index += 1) {
    const at = start + 2 * index;
    if (index > 0 && tokens[at - 1]?.kind !== 'space') return -1;
    if (tokens[at]?.kind !== 'word' || tokens[at].text !== phrase[index]) return -1;
  }
  return start + 2 * (phrase.length - 1);
}

const wordsOf = (phrases: ReadonlySet<string>) => [...phrases].map((phrase) => phrase.split(' '));
const GROSS_PHRASES = wordsOf(METALS_GROSS_QUALIFIERS);
const FINE_PHRASES = wordsOf(METALS_FINE_QUALIFIERS);
const FINE_METAL_PHRASES = wordsOf(METALS_FINE_METAL_QUALIFIERS);
const MASS_UNIT_PHRASES = wordsOf(METALS_FINE_MASS_UNITS);
const APPROXIMATE_PHRASES = wordsOf(METALS_APPROXIMATE_QUALIFIERS);

/** Whether one of the phrases starts at token `start`. */
const startsPhrase = (tokens: readonly Token[], start: number, phrases: readonly (readonly string[])[]) =>
  phrases.some((phrase) => phraseEnd(tokens, start, phrase) >= 0);

const hasPhrase = (tokens: readonly Token[], phrases: readonly (readonly string[])[]) =>
  tokens.some((_, start) => startsPhrase(tokens, start, phrases));

const isJoiner = (token: Token | undefined) =>
  token !== undefined && token.kind === 'other' && (token.text === '.' || token.text === ',' || token.text === '/');

/**
 * Whether a number of the stated-mass grammar ends at token `end`: the whole run of digits joined by points, commas or
 * slashes that ends there is digits with at most one decimal part or fraction.
 */
function massNumberEndsAt(tokens: readonly Token[], end: number): boolean {
  if (tokens[end]?.kind !== 'number') return false;
  let start = end;
  while (isJoiner(tokens[start - 1]) && tokens[start - 2]?.kind === 'number') start -= 2;
  if (isJoiner(tokens[start - 1])) return false;
  return /^\d+(?:[./]\d+)?$/.test(tokens.slice(start, end + 1).map((token) => token.text).join(''));
}

/** Whether a stated mass stands right before token `index`: a number, at most one space, a unit, then spaces. */
function afterStatedMass(tokens: readonly Token[], index: number): boolean {
  if (tokens[index - 1]?.kind !== 'space') return false;
  for (const unit of MASS_UNIT_PHRASES) {
    const start = index - 2 * unit.length;
    if (phraseEnd(tokens, start, unit) < 0) continue;
    const gap = tokens[start - 1];
    if (massNumberEndsAt(tokens, gap?.kind === 'space' && gap.text.length === 1 ? start - 2 : start - 1)) return true;
  }
  return false;
}

/** The mass basis of text read in full. */
function massBasisOf(text: string, tokens: readonly Token[]): MetalsMassBasis {
  const gross = hasPhrase(tokens, GROSS_PHRASES);
  const fineAfterMass = (_: Token, start: number) =>
    startsPhrase(tokens, start, FINE_METAL_PHRASES) && afterStatedMass(tokens, start);
  const fine = hasPhrase(tokens, FINE_PHRASES) || tokens.some(fineAfterMass);
  const approximate = hasPhrase(tokens, APPROXIMATE_PHRASES)
    || [...METALS_APPROXIMATE_SIGNS].some((sign) => text.includes(sign));
  if (gross && fine) return 'conflict';
  if (approximate) return 'approximate';
  if (gross) return 'gross';
  return fine ? 'fine' : 'none';
}

/**
 * Every purity form standing whole in text read in full, in order: a form counts only with an allowed character, or
 * the start or end, on each side, so nothing is ever cut out of a longer number or word ("1999", "24KT", "999/1000").
 */
function purityReadings(text: string): MetalsPurity[] {
  const upper = asciiUpper(text);
  const readings: MetalsPurity[] = [];
  for (let start = 0; start < upper.length; start += 1) {
    if (start > 0 && !METALS_PURITY_BEFORE.has(upper[start - 1])) continue;
    for (const [form, value] of METALS_PURITY_FORMS) {
      const end = start + form.length;
      if (!upper.startsWith(form, start)) continue;
      if (end < upper.length && !METALS_PURITY_AFTER.has(upper[end])) continue;
      readings.push({ text: form, value });
    }
  }
  return readings;
}

/** The purity of text read in full: its readings when they all agree in exact value, as first written; else null. */
function purityOf(text: string): MetalsPurity | null {
  const readings = purityReadings(text);
  if (readings.length === 0) return null;
  const [first] = readings;
  return readings.every((reading) => reading.value === first.value) ? first : null;
}

/** The design of text read in full: exactly one design named, however often; else null. */
function designOf(tokens: readonly Token[]): MetalsCoinDesign | null {
  const designs = new Set<MetalsCoinDesign>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'word') continue;
    const named = METALS_DESIGN_NAMES.get(token.text);
    if (named) designs.add(named);
    const design = METALS_DESIGNS_AFTER_METAL.get(token.text);
    const metal = tokens[index - 2];
    if (design && tokens[index - 1]?.kind === 'space' && metal?.kind === 'word' && METALS_METAL_WORDS.has(metal.text)) {
      designs.add(design);
    }
  }
  return designs.size === 1 ? [...designs][0] : null;
}

/** The purity a raw title states, or null: none stated, two that differ, or text not read in full. */
export function metalsPurityReading(raw: string | null | undefined): MetalsPurity | null {
  const text = readInFull(raw);
  return text === null ? null : purityOf(text);
}

/** The basis of a raw title's stated mass; `unknown` when the text is not read in full. */
export function metalsMassBasisReading(raw: string | null | undefined): MetalsMassBasis {
  const text = readInFull(raw);
  return text === null ? 'unknown' : massBasisOf(text, tokenize(text));
}

/** The coin design a raw title names, or null: none, two different ones, or text not read in full. */
export function metalsDesignReading(raw: string | null | undefined): MetalsCoinDesign | null {
  const text = readInFull(raw);
  return text === null ? null : designOf(tokenize(text));
}

/** All three observations of one raw title. Deterministic: the same text always gives the same answer. */
export function metalsTitleObservations(raw: string | null | undefined): MetalsTitleObservations {
  const text = readInFull(raw);
  if (text === null) return { purity: null, massBasis: 'unknown', design: null };
  const tokens = tokenize(text);
  return { purity: purityOf(text), massBasis: massBasisOf(text, tokens), design: designOf(tokens) };
}
