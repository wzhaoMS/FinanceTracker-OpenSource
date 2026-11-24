import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RETAIL_PACK_ALPHABET_EXTRAS,
  RETAIL_PACK_CONTAINER_WORDS,
  RETAIL_PACK_COUNT_LABELS,
  RETAIL_PACK_COUNT_NOUNS,
  RETAIL_PACK_DOUBT_WORDS,
  RETAIL_PACK_FINENESS_SHAPES,
  RETAIL_PACK_PLURAL_FORM_WORDS,
  RETAIL_PACK_WORDS,
  retailMetalPack,
} from './metalPackRule.js';

/**
 * The pack rule as properties: nothing outside the closed alphabet, no pack marker in any case or position, no count of
 * two or more in any of its forms, no count word, and no numeric phrase that is not a valid measure in its context can
 * ever leave a title `single`. Synthetic titles only. The count words are built here from the structure of English
 * numbers, never read from the rule's own list, so an omission there fails.
 */
const SINGLES = [
  '1 oz Gold Bar PAMP Suisse Lady Fortuna (In Assay)',
  '2024 1 oz Gold American Eagle BU',
  '1/10 oz Gold Maple Leaf Coin',
  '100 g Gold Bar Sample Mint',
  'GOLD BAR 1OZ PAMP SAMPLE',
];
const COUNTS = [2, 3, 5, 9, 10, 12, 20, 25, 50, 99, 100, 250, 500, 999];
const JOINERS = ['', ' ', '-', ' - ', '\u2013', '\u2014', '  ', '\u00A0'];
const casings = (word: string) => [word, word.toLowerCase(), word[0] + word.slice(1).toLowerCase()];

/**
 * English count words, independent of the rule: zero to ninety-nine (compounds joined by a dash or a space), the scale
 * words, and the words for fixed counts and multiples, singular and plural.
 */
function countWords(): string[] {
  const units = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
  const teens = ['TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
  const tens = ['TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
  const words = ['ZERO', ...units, ...teens, ...tens];
  for (const ten of tens) for (const unit of units) words.push(`${ten}-${unit}`, `${ten} ${unit}`);
  words.push('HUNDRED', 'HUNDREDS', 'THOUSAND', 'THOUSANDS', 'MILLION', 'MILLIONS', 'BILLION', 'BILLIONS', 'DOZEN',
    'DOZENS', 'SCORE', 'SCORES', 'GROSS', 'COUPLE', 'PAIR', 'PAIRS', 'DOUBLE', 'TRIPLE', 'QUADRUPLE', 'QUINTUPLE');
  return words;
}

/** Numeric phrases that are not a plain whole number, the lone vulgar fractions included. */
const NOT_WHOLE = ['2/1', '20/1', '1/2', '1/20', '1/0', '0/1', '2.0', '1.0', '2.1', '0.5', '.5', '20.01', '1.5', '1,000',
  '2,000', '1.2.3', '1 1/2', '2 1/2', '1\u00BD', '2 \u00BD', '\u00BD', '\u00BC', '\u00BE', '\u2152'];

function inAlphabet(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (codePoint >= 0x20 && codePoint <= 0x7e) || RETAIL_PACK_ALPHABET_EXTRAS.has(character);
}

/** Every Basic Multilingual Plane character outside the alphabet, and every astral number, mark, format character and
 * separator, with an even spread of the other astral code points. */
function outsideCharacters(): string[] {
  const found: string[] = [];
  for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const character = String.fromCodePoint(codePoint);
    if (!inAlphabet(character)) found.push(character);
  }
  const special = /^[\p{Cf}\p{M}\p{N}\p{Z}]$/u;
  for (let codePoint = (0x100 * 0x100); codePoint <= 0x10ffff; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    if (special.test(character) || codePoint % 97 === 0) found.push(character);
  }
  return found;
}

/** A word put into a title as a word of its own: first, in the middle, or last. */
function withWord(title: string, word: string): string[] {
  const words = title.split(' ');
  const middle = Math.floor(words.length / 2);
  return [`${word} ${title}`, [...words.slice(0, middle), word, ...words.slice(middle)].join(' '), `${title} ${word}`];
}

function failures(cases: Iterable<[string, (pack: string) => boolean]>): string[] {
  const failed: string[] = [];
  for (const [title, ok] of cases) {
    const pack = retailMetalPack(title);
    if (!ok(pack)) failed.push(`${JSON.stringify(title)} -> ${pack}`);
    if (failed.length >= 20) break;
  }
  return failed;
}

const isSingle = (pack: string) => pack === 'single';
const notSingle = (pack: string) => pack !== 'single';
const isMultiple = (pack: string) => pack === 'multiple';

describe('metal pack rule properties', () => {
  it('reads every synthetic base title as single', () => {
    for (const title of SINGLES) assert.equal(retailMetalPack(title), 'single', title);
  });

  it('never reads single with any character outside the alphabet, anywhere', () => {
    const characters = outsideCharacters();
    assert.ok(characters.length > 60_000);
    function* cases(): Iterable<[string, (pack: string) => boolean]> {
      const [base] = SINGLES;
      for (const character of characters) {
        yield [`${character}${base}`, notSingle];
        yield [`${base.slice(0, 7)}${character}${base.slice(7)}`, notSingle];
        yield [`${base}${character}`, notSingle];
      }
      for (const title of SINGLES.slice(1)) {
        for (let index = 0; index < characters.length; index += 13) yield [`${title} ${characters[index]}`, notSingle];
      }
    }
    assert.deepEqual(failures(cases()), []);
  });

  it('reads multiple for every pack and plural form word, in any case and position', () => {
    function* cases(): Iterable<[string, (pack: string) => boolean]> {
      for (const word of [...RETAIL_PACK_WORDS, ...RETAIL_PACK_PLURAL_FORM_WORDS]) {
        for (const written of casings(word)) {
          for (const title of SINGLES) for (const variant of withWord(title, written)) yield [variant, isMultiple];
        }
      }
    }
    assert.deepEqual(failures(cases()), []);
  });

  it('never reads single beside a doubt word', () => {
    function* cases(): Iterable<[string, (pack: string) => boolean]> {
      for (const word of RETAIL_PACK_DOUBT_WORDS) {
        for (const written of casings(word)) {
          for (const title of SINGLES) for (const variant of withWord(title, written)) yield [variant, notSingle];
        }
      }
    }
    assert.deepEqual(failures(cases()), []);
  });

  it('never reads single beside any English count word (an independent list), in any case and position', () => {
    const words = countWords();
    assert.ok(words.length > 170);
    function* cases(): Iterable<[string, (pack: string) => boolean]> {
      for (const word of words) {
        for (const written of casings(word)) {
          for (const title of SINGLES) for (const variant of withWord(title, written)) yield [variant, notSingle];
        }
      }
    }
    assert.deepEqual(failures(cases()), []);
  });

  it('never reads single with a phrase that is not a whole number at any count marker', () => {
    const forms = (phrase: string) => [
      `${phrase} Coin`, `${phrase}-Coin`, `${phrase}Coin`, `${phrase} Bar`, `${phrase} Unit`, `${phrase} x`, `${phrase}x`,
      `x ${phrase}`, `x${phrase}`, `${phrase} \u00D7`, `\u00D7${phrase}`, `(${phrase})`, `[ ${phrase} ]`,
      ...[...RETAIL_PACK_CONTAINER_WORDS].map((container) => `${container} of ${phrase}`),
      ...[...RETAIL_PACK_COUNT_LABELS].flatMap((label) => [`${label} ${phrase}`, `${label}: ${phrase}`]),
    ];
    function* cases(): Iterable<[string, (pack: string) => boolean]> {
      for (const phrase of NOT_WHOLE) {
        for (const form of forms(phrase)) {
          for (const title of SINGLES) {
            yield [`${title} ${form}`, notSingle];
            yield [`${form} ${title}`, notSingle];
          }
        }
      }
    }
    assert.deepEqual(failures(cases()), []);
  });

  it('never explains a decimal or fraction alone; a measure shape before a weight word is a weight', () => {
    function* cases(): Iterable<[string, (pack: string) => boolean]> {
      for (const title of SINGLES) {
        for (let whole = 0; whole <= 120; whole += 1) {
          for (const part of ['0', '00', '1', '01', '5', '25', '50', '75']) {
            const decimal = `${whole}.${part}`;
            if (!RETAIL_PACK_FINENESS_SHAPES.has(decimal)) yield [`${title} ${decimal}`, notSingle];
            yield [`${title} ${decimal} oz`, isSingle];
          }
        }
        for (let top = 0; top <= 24; top += 1) {
          for (let bottom = 0; bottom <= 24; bottom += 1) {
            const proper = top >= 1 && top < bottom;
            yield [`${title} ${top}/${bottom}`, notSingle];
            yield [`${title} ${top}/${bottom} oz`, proper ? isSingle : notSingle];
            for (const whole of [0, 1, 2, 3, 10, 12]) {
              yield [`${title} ${whole} ${top}/${bottom} oz`, whole === 1 && proper ? isSingle : notSingle];
            }
          }
        }
        for (const whole of [0, 1, 2, 3, 10, 12]) {
          for (const vulgar of ['\u00BD', '\u00BC', '\u00BE', '\u2152']) {
            yield [`${title} ${whole}${vulgar} oz`, whole === 1 ? isSingle : notSingle];
            yield [`${title} ${whole} ${vulgar} oz`, whole === 1 ? isSingle : notSingle];
          }
        }
        for (const vulgar of ['\u00BD', '\u00BC', '\u00BE', '\u2152']) {
          yield [`${title} ${vulgar}`, notSingle];
          yield [`${vulgar} ${title}`, notSingle];
          yield [`${title} ${vulgar} oz`, isSingle];
          yield [`${title} (${vulgar} oz)`, isSingle];
        }
      }
    }
    assert.deepEqual(failures(cases()), []);
  });

  it('reads multiple for a count of two or more joined to any count noun; one piece stays single', () => {
    const singularNouns = ['COIN', 'BAR', 'ROUND', 'INGOT', 'WAFER', 'UNIT', 'ITEM'];
    function* cases(): Iterable<[string, (pack: string) => boolean]> {
      for (const noun of RETAIL_PACK_COUNT_NOUNS) {
        for (const written of casings(noun)) {
          for (const joiner of JOINERS) {
            for (const count of COUNTS) {
              for (const title of SINGLES) {
                yield [`${title} ${count}${joiner}${written}`, isMultiple];
                yield [`${count}${joiner}${written} ${title}`, isMultiple];
              }
            }
          }
        }
      }
      for (const noun of singularNouns) {
        for (const written of casings(noun)) {
          for (const joiner of JOINERS) for (const title of SINGLES) yield [`${title} 1${joiner}${written}`, isSingle];
        }
      }
    }
    assert.deepEqual(failures(cases()), []);
  });

  it('reads multiple for a count of two or more joined to x or × on either side; one stays single', () => {
    const forms = (count: number) => [
      `${count} x`, `${count}x`, `${count} X`, `x ${count}`, `x${count}`, `X ${count}`,
      `${count} \u00D7`, `${count}\u00D7`, `\u00D7${count}`, `\u00D7 ${count}`,
    ];
    function* cases(): Iterable<[string, (pack: string) => boolean]> {
      for (const title of SINGLES) {
        for (const count of COUNTS) for (const form of forms(count)) yield [`${title} ${form}`, isMultiple];
        for (const form of forms(1)) yield [`${title} ${form}`, isSingle];
      }
    }
    assert.deepEqual(failures(cases()), []);
  });

  it('reads multiple for a container of, or a label with, a count of two or more', () => {
    function* cases(): Iterable<[string, (pack: string) => boolean]> {
      for (const title of SINGLES) {
        for (const count of COUNTS) {
          for (const container of RETAIL_PACK_CONTAINER_WORDS) {
            for (const written of casings(container)) yield [`${title} ${written} of ${count}`, isMultiple];
          }
          for (const label of RETAIL_PACK_COUNT_LABELS) {
            for (const written of casings(label)) {
              yield [`${title} ${written} ${count}`, isMultiple];
              yield [`${title} ${written}: ${count}`, isMultiple];
              yield [`${title} ${written}:${count}`, isMultiple];
            }
          }
        }
        for (const container of RETAIL_PACK_CONTAINER_WORDS) yield [`${title} ${container} of 1`, notSingle];
      }
    }
    assert.deepEqual(failures(cases()), []);
  });

  it('reads bracketed counts as multiple and bracketed years as years', () => {
    function* cases(): Iterable<[string, (pack: string) => boolean]> {
      for (const title of SINGLES) {
        for (const count of COUNTS) {
          for (const form of [`(${count})`, `[${count}]`, `( ${count} )`, `[ ${count} ]`]) yield [`${title} ${form}`, isMultiple];
        }
        yield [`${title} (1)`, isSingle];
        for (let year = 1900; year <= 2099; year += 7) yield [`${title} (${year})`, isSingle];
        for (const code of [0, (10 * 100), (18 * 100 + 99), (21 * 100), (50 * 100), (99 * 100 + 99), (100 * 100), ((12 * 100 + 34) * 100 + 56)]) yield [`${title} (${code})`, notSingle];
      }
    }
    assert.deepEqual(failures(cases()), []);
  });

  it('never reads single with a number nothing explains; a lone year is a year', () => {
    function* cases(): Iterable<[string, (pack: string) => boolean]> {
      for (const title of SINGLES) {
        for (let number = 0; number <= 999; number += 1) yield [`${title} ${number}`, notSingle];
        for (const code of [(10 * 100), (18 * 100 + 99), (21 * 100), (99 * 100 + 99), (100 * 100)]) yield [`${title} ${code}`, notSingle];
        for (let year = 1900; year <= 2099; year += 3) yield [`${title} ${year}`, isSingle];
      }
    }
    assert.deepEqual(failures(cases()), []);
  });

  it('never reads single when cut or masked anywhere', () => {
    function* cases(): Iterable<[string, (pack: string) => boolean]> {
      for (const title of SINGLES) {
        for (const mark of ['...', '....', '***', '*****']) {
          yield [`${title}${mark}`, notSingle];
          yield [`${mark}${title}`, notSingle];
          yield [`${title.slice(0, 5)}${mark}${title.slice(5)}`, notSingle];
        }
      }
    }
    assert.deepEqual(failures(cases()), []);
  });

  it('keeps a pack marker whatever is joined to either side of the title (warehouse lines included)', () => {
    const marked = ['1 oz Gold Eagle Tube', 'Gold Coins 1 oz', '1 oz Gold Eagle 20-Coin', '10 x 1 oz Gold Bar', 'Box of 25 Gold Rounds 1 oz'];
    function* cases(): Iterable<[string, (pack: string) => boolean]> {
      for (const title of marked) {
        for (const other of [...SINGLES, ...marked, '1 oz', 'oz Gold', '20', '(2024)']) {
          yield [`${title} ${other}`, isMultiple];
          yield [`${other} ${title}`, isMultiple];
        }
      }
    }
    assert.deepEqual(failures(cases()), []);
  });
});
