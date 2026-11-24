import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BULLION_TITLE_WORDS,
  COIN_DESIGN_WORDS,
  METAL_TITLE_WORDS,
  RETAIL_METAL_GUARD_CLAUSES,
  RETAIL_METAL_GUARD_EVIDENCE,
  RETAIL_METAL_GUARD_SHAPE_WORDS,
  retailMetalTitleEvidence,
  retailMetalTitleGuard,
  retailStatedWeights,
} from './metalTitleRule.js';

/**
 * The exact-weight grammar as a property: every character outside it, put next to an allowlisted number, leaves the
 * weight unknown. The alphabets are complete where it matters: every Unicode number (\p{N}, every script), every dash
 * (\p{Pd}) and math symbol (\p{Sm}), the plus and minus signs, the ASCII letters and an even spread of every script's
 * letters (\p{L}).
 */
function codePoints(pattern: RegExp): string[] {
  const found: string[] = [];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const character = String.fromCodePoint(codePoint);
    if (pattern.test(character)) found.push(character);
  }
  return found;
}

const ASCII_DIGITS = new Set([...'0123456789']);
const NUMBERS = codePoints(/^\p{N}$/u).filter((character) => !ASCII_DIGITS.has(character));
const SIGNS = [...new Set([
  ...'+-\u00b1\u2213\u2212\ufe62\ufe63\uff0b\uff0d\u207a\u207b\u208a\u208b',
  ...codePoints(/^\p{Pd}$/u),
  ...codePoints(/^\p{Sm}$/u),
])];
const LETTERS = [...new Set([...'ABEGOXZabegoxz', ...codePoints(/^\p{L}$/u).filter((_, index) => index % 97 === 0)])];
/** After a number, a G is the gram unit itself ("1g" is an allowlisted statement), so it is no stray letter there. */
const LETTERS_AFTER = LETTERS.filter((character) => !/^g$/iu.test(character));
/** The allowlisted numeric spans and the value each states. */
const BASES: Array<[string, string]> = [
  ['1', '1'], ['10', '10'], ['0.5', '0.5'], ['31.1', '31.1'], ['1/10', '1/10'], ['\u00bd', '1/2'], ['\u2152', '1/10'], ['1 \u00bd', '1 1/2'],
];
/** Every mark and invisible format character (\p{M}, \p{Cf}): none shows on its own. */
const INVISIBLES = codePoints(/^[\p{M}\p{Cf}]$/u);
/** Every letter that only case folding reads as an ASCII one: the Kelvin sign K and the long s ſ. */
const FOLDED_LETTERS = codePoints(/^[a-z]$/iu).filter((character) => character.codePointAt(0)! > 0x7f);
/** Every white space but the ASCII space. */
const OTHER_SPACES = codePoints(/^\s$/u).filter((character) => character !== ' ');
const UNIT_SPELLINGS = [
  'oz', 'ozt', 'ounce', 'ounces', 'troy oz', 'troy ounce', 'troy ounces', 'g', 'gram', 'grams', 'kg', 'kilo', 'kilos', 'kilogram', 'kilograms',
];
/** Root's fixed left-scan list, written out here apart from the rule's own (the closed-list test pins that one). */
const SCAN_SEPARATORS = ['-', '\u2013', '\u2014', '+', '/', '\u00b1', '~', ':', ',', '"', '\'', '\u201c', '\u201d', '\u2018', '\u2019', '(', '[', '\u00d7'];
const SCAN_WORDS = ['to', 'or', 'and', 'x', 'through', 'thru', 'plus', 'minus', 'times', 'TO', 'X', 'Thru'];
const SCAN_BASES = BASES.filter(([base]) => ['1', '0.5', '1/10', '\u00bd', '1 \u00bd'].includes(base));
const isScanWord = (item: string) => /^[A-Za-z]+$/.test(item);

/** Every run of one or two listed separators and range words, spaced or glued, never gluing two words into one. */
function scanCombinations(): string[] {
  const items = [...SCAN_SEPARATORS, ...SCAN_WORDS];
  const found = [...items];
  for (const first of items) {
    for (const second of items) {
      found.push(`${first} ${second}`);
      if (!(isScanWord(first) && isScanWord(second))) found.push(`${first}${second}`);
    }
  }
  return found;
}

/** Every set of ten decimal digits but ASCII's: \p{Nd} comes only in runs of ten, zero first. */
function decimalDigitSets(): string[][] {
  const digits = codePoints(/^\p{Nd}$/u);
  const sets: string[][] = [];
  for (let index = 0; index < digits.length; index += 10) {
    const set = digits.slice(index, index + 10);
    const zero = set[0].codePointAt(0)!;
    assert.ok(set.length === 10 && set.every((digit, value) => digit.codePointAt(0) === zero + value), `a run of ten at U+${zero.toString(16)}`);
    if (set[0] !== '0') sets.push(set);
  }
  return sets;
}

const weightOf = (title: string) => retailMetalTitleEvidence(title)?.statedWeight ?? null;

/** Every title of `titles` that yields an exact weight: none may. */
function exactWeights(titles: Iterable<string>): string[] {
  const exact: string[] = [];
  for (const title of titles) {
    if (weightOf(title) !== null || retailStatedWeights(title).length > 0) exact.push(title);
  }
  return exact;
}

function* around(characters: readonly string[], place: (character: string, base: string) => string): Generator<string> {
  for (const character of characters) for (const [base] of BASES) yield place(character, base);
}

describe('RETAIL_METAL_TITLE_RULE v2: the exact-weight grammar as a property', () => {
  it('covers the whole number category, and every base form is exact on its own', () => {
    assert.ok(NUMBERS.length > 1800, `${NUMBERS.length} numbers`);
    assert.ok(SIGNS.length > 900, `${SIGNS.length} signs`);
    for (const [base, value] of BASES) {
      for (const title of [`Gold Bar ${base} oz`, `Gold Bar - ${base} oz`, `Gold Bar (${base} oz)`, `${base} oz Gold Bar`, `Gold Bar ${base}-oz`]) {
        assert.deepEqual(weightOf(title), { value, unit: 'oz' }, title);
      }
    }
  });

  it('gives no exact weight with any number, sign or letter right before the number', () => {
    const exact = exactWeights(around([...NUMBERS, ...SIGNS, ...LETTERS], (character, base) => `Gold Bar ${character}${base} oz`));
    assert.deepEqual(exact.slice(0, 10), [], `${exact.length} false exact weights`);
  });

  it('gives no exact weight with any number, sign or letter right after the number', () => {
    const exact = exactWeights(around([...NUMBERS, ...SIGNS, ...LETTERS_AFTER], (character, base) => `Gold Bar ${base}${character} oz`));
    assert.deepEqual(exact.slice(0, 10), [], `${exact.length} false exact weights`);
  });

  it('gives no exact weight with any other number just before it across white space', () => {
    const exact = exactWeights(around(NUMBERS, (character, base) => `Gold Bar ${character} ${base} oz`));
    assert.deepEqual(exact.slice(0, 10), [], `${exact.length} false exact weights`);
    for (const title of ['Gold Bar 2 1 oz', 'Gold Bar 2 0.5 oz', 'Gold Bar 2 1/10 oz', 'Gold Bar 2 1 \u00bd oz', 'Gold Bar 2  \u00bd oz']) {
      assert.equal(weightOf(title), null, title);
    }
  });

  it('gives no exact weight for the tail of a number split by spaces: a spaced fraction, decimal or division', () => {
    const joiners = ['/', '\u2044', '\u2215', '.', '\u00f7'];
    const exact = exactWeights(around(joiners, (joiner, base) => `Gold Bar 1 ${joiner} ${base} oz`));
    assert.deepEqual(exact, [], `${exact.length} false exact weights`);
    const glued = exactWeights(around(joiners, (joiner, base) => `Gold Bar 1${joiner} ${base} oz`));
    assert.deepEqual(glued, [], `${glued.length} false exact weights`);
    for (const [title, weight] of [['Gold Bar, 1 oz', '1'], ['Weight: 1 oz Gold Bar', '1']] as const) {
      assert.deepEqual(weightOf(title), { value: weight, unit: 'oz' }, `${title}: a list comma or a label is no part of the number`);
    }
    assert.equal(weightOf('Gold Bar 2 x 1 oz'), null, 'a pack count is a number joined to it: no exact weight');
  });

  it('gives no exact weight with an ASCII digit glued to a vulgar fraction, either side', () => {
    for (const digit of ASCII_DIGITS) {
      for (const fraction of ['\u00bd', '\u00bc', '\u00be', '\u2152']) {
        assert.equal(weightOf(`Gold Bar ${digit}${fraction} oz`), null, `${digit}${fraction}`);
        assert.equal(weightOf(`Gold Bar ${fraction}${digit} oz`), null, `${fraction}${digit}`);
      }
    }
  });

  it('gives no exact weight after a dash or math sign that follows a number across white space: a range or a sum', () => {
    const exact = exactWeights(around(SIGNS, (sign, base) => `Gold Bar 1 ${sign} ${base} oz`));
    assert.deepEqual(exact.slice(0, 10), [], `${exact.length} false exact weights`);
    const glued = exactWeights(around(SIGNS, (sign, base) => `Gold Bar 1${sign} ${base} oz`));
    assert.deepEqual(glued.slice(0, 10), [], `${glued.length} false exact weights`);
    for (const dash of ['-', '\u2013', '\u2014']) {
      for (const [base, value] of BASES) {
        assert.deepEqual(weightOf(`Gold Bar ${dash} ${base} oz`), { value, unit: 'oz' }, `${dash}: a separator, with no number before it`);
      }
    }
  });

  it('scans left over any run of listed separators and range words: between two numbers never exact, after a word or the start always', () => {
    const combinations = scanCombinations();
    assert.ok(combinations.length > 1600, `${combinations.length} combinations`);
    const joined: string[] = [];
    for (const combination of combinations) {
      for (const left of ['1', '\u00bd', '\u0663']) {
        for (const [base] of SCAN_BASES) joined.push(`Gold Bar ${left} ${combination} ${base} oz`, `Gold Bar ${left}${combination} ${base} oz`);
      }
    }
    const exact = exactWeights(joined);
    assert.deepEqual(exact.slice(0, 10), [], `${exact.length} false exact weights of ${joined.length}`);
    const dropped = joined.filter((title) => retailMetalTitleEvidence(title)?.form !== 'bar');
    assert.deepEqual(dropped.slice(0, 10), [], `${dropped.length} bars dropped`);
    const unread: string[] = [];
    for (const combination of combinations) {
      // Glued to the word only by a separator: a glued range word would make another word ("Barto"), and no bar.
      const forms = (base: string) => [
        `Gold Bar ${combination} ${base} oz`, `${combination} ${base} oz Gold Bar`,
        ...(isScanWord(combination[0]) ? [] : [`Gold Bar${combination} ${base} oz`]),
      ];
      for (const [base, value] of SCAN_BASES) {
        for (const title of forms(base)) {
          const weight = weightOf(title);
          if (weight?.value !== value || weight.unit !== 'oz') unread.push(title);
        }
      }
    }
    assert.deepEqual(unread.slice(0, 10), [], `${unread.length} weights not read after a word or the start`);
  });

  it('gives no exact weight for two adjacent signs between two numbers, whatever separates them (the review\'s 1,280 cases)', () => {
    const signs = ['+', '-', '\u00b1', '\u2213', '\u2212', '\u2013', '\u2014', '\u00d7'];
    const gaps = ['', ' ', '\u200b', '\u0301 '];
    const bases = ['1', '31.1', '1/10', '\u00bd', '1 \u00bd'];
    const titles: string[] = [];
    for (const first of signs) for (const second of signs) for (const gap of gaps) for (const base of bases) {
      titles.push(`Gold Bar 1 ${first}${gap}${second} ${base} oz`);
    }
    assert.equal(titles.length, 1280);
    assert.deepEqual(exactWeights(titles).slice(0, 10), [], `${exactWeights(titles).length} false exact weights`);
    assert.deepEqual(titles.filter((title) => retailMetalTitleEvidence(title)?.form !== 'bar'), []);
  });

  it('gives no exact weight for three or four signs between two numbers, glued or spaced', () => {
    const signs = ['+', '-', '/', '\u00b1', '\u2213', '\u2212', '\u2013', '\u2014', '\u00d7', '~', ':', ','];
    const titles: string[] = [];
    for (const a of signs) for (const b of signs) for (const c of signs) {
      for (const gap of ['', ' ']) for (const gap2 of ['', ' ']) {
        for (const base of ['1', '\u00bd']) titles.push(`Gold Bar 1 ${a}${gap}${b}${gap2}${c} ${base} oz`);
      }
    }
    const four = ['+', '-', '/', '\u00b1'];
    for (const a of four) for (const b of four) for (const c of four) for (const d of four) {
      for (const base of ['1', '\u00bd']) titles.push(`Gold Bar 1 ${a}${b}${c}${d} ${base} oz`, `Gold Bar 1 ${a} ${b} ${c} ${d} ${base} oz`);
    }
    assert.ok(titles.length > 14000, `${titles.length} titles`);
    assert.deepEqual(exactWeights(titles).slice(0, 10), [], `${exactWeights(titles).length} false exact weights`);
  });

  it('reads every year 1900 to 2099 right before every allowed number as a word, and no other four-digit token (v2)', () => {
    const wrong: string[] = [];
    let checked = 0;
    for (let token = 0; token <= 9999; token += 1) {
      const year = String(token).padStart(4, '0');
      const isYear = token >= 1900 && token <= 2099;
      for (const [base, value] of BASES) {
        const title = `Gold Bar ${year} ${base} oz`;
        const weight = weightOf(title);
        checked += 1;
        if (isYear ? weight?.value !== value || weight?.unit !== 'oz' : weight !== null) wrong.push(title);
      }
    }
    assert.equal(checked, 80000);
    assert.deepEqual(wrong.slice(0, 10), [], `${wrong.length} wrong of ${checked}`);
  });

  it('gives no exact weight for Root\'s cases, nor with any other number next to the year, nor for a year in other digits (v2)', () => {
    const titles: string[] = [];
    for (const [base] of BASES) {
      for (const text of [`2 2024 ${base}`, `2024 2025 ${base}`, `2024 to 2025 ${base}`, `12024 ${base}`, `2024-${base}`, `2024  ${base}`]) {
        titles.push(`Gold Bar ${text} oz`, `${text} oz Gold Bar`);
      }
    }
    for (const character of [...NUMBERS, ...ASCII_DIGITS]) {
      for (const [base] of BASES) {
        titles.push(
          `Gold Bar ${character}2024 ${base} oz`, `Gold Bar 2024${character} ${base} oz`, `Gold Bar ${character} 2024 ${base} oz`,
          `${character}2024 ${base} oz Gold Bar`, `${character} 2024 ${base} oz Gold Bar`,
        );
      }
    }
    const sets = decimalDigitSets();
    assert.ok(sets.length > 60, `${sets.length} digit sets`);
    for (const set of sets) {
      const year = `${set[2]}${set[0]}${set[2]}${set[4]}`;
      for (const [base] of BASES) titles.push(`Gold Bar ${year} ${base} oz`, `${year} ${base} oz Gold Bar`);
    }
    const exact = exactWeights(titles);
    assert.deepEqual(exact.slice(0, 10), [], `${exact.length} false exact weights of ${titles.length}`);
    const dropped = titles.filter((title) => retailMetalTitleEvidence(title)?.form !== 'bar');
    assert.deepEqual(dropped.slice(0, 10), [], `${dropped.length} bars dropped`);
  });

  it('reads a year as a word only after the start, an opening bracket right before it, or one space after a plain word that is no range word (v2)', () => {
    for (const [base, value] of BASES) {
      for (const title of [
        `2024 ${base} oz Gold Bar`, `Gold Bar 2024 ${base} oz`, `Gold Bar (2024 ${base} oz)`, `Gold Bar [2024 ${base} oz]`,
        `Gold Bar(2024 ${base} oz)`, `Gold-Bar 2024 ${base} oz`, `Gold Bar x (2024 ${base} oz)`, `(2024 ${base} oz) Gold Bar`,
      ]) {
        assert.deepEqual(weightOf(title), { value, unit: 'oz' }, title);
      }
    }
    const titles: string[] = [];
    for (const [base] of BASES) {
      for (const word of SCAN_WORDS) titles.push(`Gold Bar ${word} 2024 ${base} oz`, `${word} 2024 ${base} oz Gold Bar`);
      for (const separator of SCAN_SEPARATORS) {
        titles.push(`Gold Bar ${separator} 2024 ${base} oz`, `Gold Bar${separator} 2024 ${base} oz`);
        if (separator !== '(' && separator !== '[') titles.push(`Gold Bar ${separator}2024 ${base} oz`, `${separator}2024 ${base} oz Gold Bar`);
      }
      for (const space of [...OTHER_SPACES, '  ']) {
        titles.push(`Gold Bar${space}2024 ${base} oz`, `${space}2024 ${base} oz Gold Bar`, `Gold Bar 2024${space}${base} oz`);
      }
      // After a neutral word, so a mark can change only that word, never BAR.
      for (const character of [...INVISIBLES, ...FOLDED_LETTERS, '\u0445', '\u00e9']) {
        titles.push(`Gold Bar Fine${character} 2024 ${base} oz`, `Gold Bar ${character}2024 ${base} oz`, `Gold Bar 2024${character} ${base} oz`);
      }
    }
    assert.ok(titles.length > 60000, `${titles.length} titles`);
    const exact = exactWeights(titles);
    assert.deepEqual(exact.slice(0, 10), [], `${exact.length} false exact weights`);
    const dropped = titles.filter((title) => retailMetalTitleEvidence(title)?.form !== 'bar');
    assert.deepEqual(dropped.slice(0, 10), [], `${dropped.length} bars dropped`);
  });

  it('lets no number through a year word: past a bracket the left scan goes on, over any run of separators and range words (v2)', () => {
    const combinations = scanCombinations();
    const joined: string[] = [];
    const unread: string[] = [];
    for (const combination of combinations) {
      for (const [base, value] of SCAN_BASES) {
        for (const left of ['1', '\u00bd', '\u0663', '2023']) {
          joined.push(`Gold Bar ${left} ${combination} (2024 ${base} oz)`, `Gold Bar ${left} ${combination} 2024 ${base} oz`);
        }
        for (const title of [`Gold Bar ${combination} (2024 ${base} oz)`, `${combination} (2024 ${base} oz) Gold Bar`]) {
          const weight = weightOf(title);
          if (weight?.value !== value || weight.unit !== 'oz') unread.push(title);
        }
      }
    }
    const exact = exactWeights(joined);
    assert.deepEqual(exact.slice(0, 10), [], `${exact.length} false exact weights of ${joined.length}`);
    assert.deepEqual(unread.slice(0, 10), [], `${unread.length} weights not read after a word or the start`);
  });

  it('reads an exact unit only in ASCII letters: no letter only case folding reads as one, and no other space', () => {
    assert.ok(FOLDED_LETTERS.includes('\u212a') && FOLDED_LETTERS.includes('\u017f'), `${FOLDED_LETTERS.length} folded letters`);
    const titles: string[] = [];
    for (const spelling of UNIT_SPELLINGS) {
      assert.notEqual(weightOf(`Gold Bar 1 ${spelling}`), null, spelling);
      for (const folded of FOLDED_LETTERS) {
        const plain = folded.normalize('NFKC').toLowerCase();
        [...spelling].forEach((letter, index) => {
          if (letter === plain) titles.push(`Gold Bar 1 ${spelling.slice(0, index)}${folded}${spelling.slice(index + 1)}`);
        });
      }
      if (spelling.startsWith('troy ')) for (const space of OTHER_SPACES) titles.push(`Gold Bar 1 ${spelling.replace(' ', space)}`);
    }
    assert.ok(titles.length > 40, `${titles.length} titles`);
    const dropped = titles.filter((title) => retailMetalTitleEvidence(title)?.form !== 'bar');
    assert.deepEqual(dropped, [], 'each is still a weight statement, so the bar still matches');
    assert.deepEqual(exactWeights(titles), [], `${exactWeights(titles).length} false exact weights`);
    assert.equal(weightOf('Gold Bar 1 \u212ag'), null, 'a Kelvin-sign K is no exact kg, and never 1 g');
    assert.equal(weightOf('Gold Bar 1 troy  oz'), null, 'at most one space in TROY OZ');
  });

  it('gives no exact weight with a mark or an invisible character next to the number or the unit, or inside the unit', () => {
    assert.ok(INVISIBLES.length > 2500, `${INVISIBLES.length} marks and invisible characters`);
    const beside: string[] = [];
    const touching: string[] = [];
    for (const character of INVISIBLES) {
      for (const [base] of BASES) {
        beside.push(
          `Gold Bar ${base}${character} oz`, `Gold Bar ${base} ${character}oz`, `Gold Bar ${base} oz${character}`,
          `Gold Bar ${base} oz${character}t`, `Gold Bar 1${character} ${base} oz`,
        );
        // Inside the unit, or between a word and the number: a mark there may also change the word itself (Bar´ is Baŕ).
        touching.push(`Gold Bar ${base} o${character}z`, `Gold Bar${character}${base} oz`);
      }
    }
    const exact = exactWeights([...beside, ...touching]);
    assert.deepEqual(exact.slice(0, 10), [], `${exact.length} false exact weights`);
    const dropped = beside.filter((title) => retailMetalTitleEvidence(title)?.form !== 'bar');
    assert.deepEqual(dropped.slice(0, 10), [], `${dropped.length} bars dropped: each is still a weight statement`);
    assert.equal(weightOf('Gold Bar 1 oz\u200bt'), null, 'an invisible character can hide the troy t: never oz');
    assert.equal(weightOf('Gold Bar\ufeff1 oz'), null, 'U+FEFF is white space to a regex, but shows none');
  });

  it('gives no exact weight beside any other weight candidate anywhere in the title, of any kind, in either order', () => {
    const fullwidth = (text: string) => [...text]
      .map((character) => (character === ' ' ? character : String.fromCodePoint(character.codePointAt(0)! + 0xfee0))).join('');
    // The review's composition property: 14 candidates only normalization reads, each on its own a weight of unknown value.
    const unknown: string[] = [];
    for (const unit of ['oz', 'ozt', 'g', 'kg', 'grams', 'ounces', 'troy oz']) {
      for (const number of ['2', '\uff12']) unknown.push(`${number} ${fullwidth(unit)}`);
    }
    assert.equal(unknown.length, 14);
    // And statements only an invisible character or a lookalike letter keeps from being exact.
    const recognized = [...unknown, '2 k\u200bg', '2\u200bg', '2\u0301 g', '2 \u212ag', '2 ounce\u017f', '2 troy\u00a0oz'];
    for (const fragment of recognized) {
      assert.equal(retailMetalTitleEvidence(`Gold Bar ${fragment}`)?.form, 'bar', `${fragment}: a weight statement on its own`);
      assert.equal(weightOf(`Gold Bar ${fragment}`), null, fragment);
    }
    const others = [...recognized, '2 g', '1 oz', '31.1 g', '\u00bd oz', '1\u338f', '\u0661 oz', '\u2160oz'];
    const titles: string[] = [];
    for (const [base, value] of BASES) {
      for (const other of others) {
        // The same exact statement again agrees with it (Root's ruling); every other one leaves the weight unknown.
        if (other === `${base} oz`) {
          for (const title of [`Gold Bar ${base} oz (${other})`, `Gold Bar ${other} (${base} oz)`]) {
            assert.deepEqual(weightOf(title), { value, unit: 'oz' }, title);
          }
          continue;
        }
        titles.push(`Gold Bar ${base} oz (${other})`, `Gold Bar ${other} (${base} oz)`);
      }
      assert.deepEqual(weightOf(`Gold Bar ${base} oz (${base} oz)`), { value, unit: 'oz' }, `${base}: the same statement twice`);
      assert.equal(weightOf(`Gold Bar ${base} oz (${base} ozt)`), null, `${base}: oz beside ozt`);
    }
    assert.deepEqual(exactWeights(titles).slice(0, 10), [], `${exactWeights(titles).length} false exact weights`);
    // Normalization that hides the exact candidate itself (™ becomes letters) still counts the other one.
    assert.equal(weightOf('Gold Bar 1 oz\u2122 (\uff12\uff47)'), null);
  });
});

describe('RETAIL_METAL_TITLE_RULE v3: the assay card as a property', () => {
  // Each base, and whether it names a bullion form apart from ASSAY with no near-miss word of its own: only then does an
  // assay card at the end leave it reading as it would with a plain word there (ZARD) instead.
  const BASES: ReadonlyArray<readonly [string, boolean]> = [
    ['1 oz Gold Bar', true], ['1 oz Gold Coin', true], ['Silver Round 1 oz', true], ['Gold Eagle', true],
    ['Gold Maple Leaf 1 oz', true], ['Gold Bullion', true], ['10 g Gold Ingot', true], ['2 x 1 oz Gold Bars', true],
    ['Gold', false], ['Gold Bar', false], ['Gold Coin', false], ['Silver Round', false], ['1 oz Gold Plated Bar', false],
    ['Gold Leaf Bar 1 oz', false], ['1 oz Gold Bar Gift Card and', false], ['Eagle Gold 1 oz', false],
  ];
  const ENDINGS = [' Assay Card', ' Assay Cards', ' in Assay Card', ' (Assay Card)', ' Assay-Card', '/Assay Card.', ' ASSAY CARD', ' assay card 2'];

  it('reads a title ending in an assay card as the same title ending in a plain word, or not at all', () => {
    for (const [base, exempt] of BASES) {
      for (const ending of ENDINGS) {
        const title = `${base}${ending}`;
        const plain = `${base}${ending.replace(/card/i, (card) => (card === 'CARD' ? 'ZARD' : 'Zard'))}`;
        if (exempt) {
          assert.notEqual(retailMetalTitleEvidence(plain), null, plain);
          assert.deepEqual(retailMetalTitleEvidence(title), retailMetalTitleEvidence(plain), title);
        } else {
          assert.equal(retailMetalTitleEvidence(title), null, title);
        }
      }
    }
  });

  it('never exempts a card that isn\'t the last word, nor any other near-miss word after ASSAY', () => {
    for (const [base] of BASES) {
      for (const title of [`${base} Assay Card Holder`, `${base} Assay Cards Sleeve`, `${base} Assay Card, Sealed`, `${base} Assay Star`,
        `${base} Assay Foil`, `${base} Assay Card Gift Card`]) {
        assert.equal(retailMetalTitleEvidence(title), null, title);
      }
    }
  });
});

describe('RETAIL_METAL_GUARD v1 as a property: no line naming a metal with bullion evidence is silently no metal', () => {
  const METALS = ['Gold', 'Silver', 'Platinum', 'Go\u200bld', '\uff27\uff2f\uff2c\uff24', 'gold'];
  const SEPARATORS = [' ', '-', '/', '.', ', ', ' \u200b', '\u200b', '\u00ad', ' (', '\u3000'];
  const SHAPES = ['Bar', 'Coin', 'Round', 'Ingots', 'BARS', '\uff22\uff21\uff32'];
  const TAILS = ['', ' 1 oz', ' 10 g', ' 1 ozt', ' .9999', ' 24K'];
  const NEAR_MISSES = ['', ' Candy', ' Holder Card', ' Gift Card'];

  it('flags exactly the lines that name a metal, show evidence and aren\'t metal, with a clause from the closed list', () => {
    let titles = 0;
    let flags = 0;
    for (const metal of METALS) {
      for (const separator of SEPARATORS) {
        for (const shape of SHAPES) {
          for (const tail of TAILS) {
            for (const nearMiss of NEAR_MISSES) {
              for (const title of [`${metal}${separator}${shape}${tail}${nearMiss}`, `${shape}${separator}${metal}${tail}${nearMiss}`]) {
                titles += 1;
                const metalNow = retailMetalTitleEvidence(title) !== null;
                for (const assessed of [true, false]) {
                  const reading = retailMetalTitleGuard(title, { assessed });
                  const notMetal = !assessed || !metalNow;
                  // The shape word right next to the metal word is evidence, however they are separated.
                  assert.equal(reading.metalWord, true, title);
                  assert.ok(reading.evidence.includes('adjacency'), title);
                  assert.equal(reading.uncertain, notMetal, title);
                  if (assessed && metalNow) assert.equal(reading.clause, null, title);
                  if (!reading.uncertain) continue;
                  flags += 1;
                  assert.ok(RETAIL_METAL_GUARD_CLAUSES.includes(reading.clause!), title);
                  assert.equal(reading.clause!.split('/')[1], reading.evidence[0], title);
                  assert.equal(reading.clause!.startsWith('not-assessed/'), !assessed, title);
                }
              }
            }
          }
        }
      }
    }
    assert.equal(titles, METALS.length * SEPARATORS.length * SHAPES.length * TAILS.length * NEAR_MISSES.length * 2);
    assert.ok(flags > titles, `${flags} flags over ${titles} titles, read both as assessed and not`);
  });

  /** Every character that never shows: every format character and every default-ignorable code point. */
  const NEVER_SHOWS_ALL = codePoints(/^[\p{Cf}\p{Default_Ignorable_Code_Point}]$/u);
  /** All of them below the tag and variation-selector block U+E0000–U+E0FFF, all of its format characters, and a closed
   * sample of the rest (the reviewer's list, 11/09, and the block's variation selectors and reserved points). */
  const NEVER_SHOWS = [...new Set([
    ...NEVER_SHOWS_ALL.filter((character) => character.codePointAt(0)! < 0xe0000 || /^\p{Cf}$/u.test(character)),
    '\u034F', '\uFE0F', '\u180B', '\u3164', '\u115F', '\u17B4', '\u{E0000}', '\u{E0100}', '\u{E01EF}', '\u{E0FFF}',
  ])];
  const GUARD_WORDS = [...new Set([...METAL_TITLE_WORDS.keys(), ...RETAIL_METAL_GUARD_SHAPE_WORDS, ...BULLION_TITLE_WORDS, ...COIN_DESIGN_WORDS])];

  it('sees every guard word through every character that never shows, at every place inside it: the line is metal or flagged', () => {
    let titles = 0;
    for (const word of GUARD_WORDS) {
      const metal = METAL_TITLE_WORDS.get(word);
      for (let at = 1; at < word.length; at += 1) {
        for (const never of NEVER_SHOWS) {
          const split = `${word.slice(0, at)}${never}${word.slice(at)}`;
          // A metal word beside a shape with a weight, and beside a coin design alone (the rule's design path, c3decfa5).
          const templates: Array<[string, 'shape' | 'design' | 'other']> = metal
            ? [[`1 oz ${split} Bar`, 'shape'], [`1 oz ${split} Buffalo`, 'design']]
            : [[`1 oz Gold ${split}`, COIN_DESIGN_WORDS.has(word) ? 'design' : RETAIL_METAL_GUARD_SHAPE_WORDS.has(word) ? 'shape' : 'other']];
          for (const [title, path] of templates) {
            titles += 1;
            const reading = retailMetalTitleGuard(title, { assessed: true });
            const name = `${title} (${word} with U+${never.codePointAt(0)!.toString(16)} after ${at})`;
            assert.equal(reading.metalWord, true, name);
            assert.ok(retailMetalTitleEvidence(title) !== null || reading.uncertain, `${name}: silently no metal`);
            if (metal) {
              // The rule's words part the metal word, the guard's never do: always flagged, with its one metal.
              assert.deepEqual([reading.uncertain, reading.metal], [true, metal], name);
              assert.ok(reading.clause!.startsWith('no-metal-word/'), name);
            }
            if (BULLION_TITLE_WORDS.has(word)) assert.ok(reading.evidence.includes('bullion-word'), name);
            if (path === 'shape') assert.ok(reading.evidence.includes('shape-with-weight'), name);
            if (path === 'design') assert.ok(reading.evidence.includes('design-after-metal'), name);
          }
        }
      }
    }
    assert.equal(GUARD_WORDS.length, 22);
    assert.ok(titles > 15_000, `${titles} titles`);
  });

  it('sees a metal word through every format character and default-ignorable code point there is', () => {
    assert.ok(NEVER_SHOWS_ALL.length > 4_000, `${NEVER_SHOWS_ALL.length} code points`);
    for (const never of NEVER_SHOWS_ALL) {
      const reading = retailMetalTitleGuard(`1 oz Go${never}ld Bar`, { assessed: true });
      assert.deepEqual([reading.uncertain, reading.clause, reading.metal], [true, 'no-metal-word/shape-with-weight', 'XAU'],
        `U+${never.codePointAt(0)!.toString(16)}`);
    }
  });

  it('sees a weight statement beside a shape word through every character that never shows: inside the unit, or beside it', () => {
    // 9854b7c2, 11/09: the rule's weight reader keeps a mark or a filler, so the guard also reads the title visible only.
    const UNITS = ['oz', 'ozt', 'g', 'kg', 'grams', 'troy oz'];
    let titles = 0;
    for (const unit of UNITS) {
      const places: Array<(never: string) => string> = [
        (never) => `1.5${never} ${unit}`,
        (never) => `1.5 ${never}${unit}`,
        (never) => `1.5${never}${unit}`,
        (never) => `1.5 ${unit}${never}`,
      ];
      for (let at = 1; at < unit.length; at += 1) places.push((never) => `1.5 ${unit.slice(0, at)}${never}${unit.slice(at)}`);
      for (const place of places) {
        for (const never of NEVER_SHOWS) {
          const title = `Gold Chocolate Coin ${place(never)}`;
          titles += 1;
          const reading = retailMetalTitleGuard(title, { assessed: true });
          const name = `${unit} with U+${never.codePointAt(0)!.toString(16)}: ${JSON.stringify(place('|'))}`;
          assert.deepEqual([reading.uncertain, reading.metal], [true, 'XAU'], name);
          assert.ok(reading.evidence.includes('shape-with-weight'), name);
        }
      }
    }
    assert.equal(titles, UNITS.reduce((sum, unit) => sum + 3 + unit.length, 0) * NEVER_SHOWS.length);
    assert.ok(titles > 6_000, `${titles} titles`);
  });

  /**
   * The unit corpus (c3decfa5, 11/09): every single-quoted literal of metalTitleRule.test.ts up to 60 characters, read
   * from its source as written, so that the closure below never drifts from the unit tests. Its only escapes are
   * \uXXXX; \u{…} and a quoted character are read too.
   */
  function unitCorpus(): string[] {
    const source = readFileSync(new URL('./metalTitleRule.test.ts', import.meta.url), 'utf8');
    const literals = [...source.matchAll(/'((?:[^'\\\r\n]|\\.)*)'/g)].map((found) => found[1].replace(
      /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\(.)/g,
      (_, astral: string | undefined, bmp: string | undefined, other: string | undefined) => (astral !== undefined
        ? String.fromCodePoint(Number.parseInt(astral, 16)) : bmp !== undefined ? String.fromCharCode(Number.parseInt(bmp, 16)) : other!)));
    return literals.filter((literal) => literal.length > 0 && literal.length <= 60);
  }
  /** The generated corpus above, sampled: every pair of shape and tail, with the metal, separator, near-miss and order rotated. */
  function generatedSample(): string[] {
    return SHAPES.flatMap((shape, s) => TAILS.map((tail, t) => {
      const [metal, separator, nearMiss] = [METALS[(s + t) % METALS.length], SEPARATORS[(6 * s + t) % SEPARATORS.length],
        NEAR_MISSES[(s + 2 * t) % NEAR_MISSES.length]];
      return (s + t) % 2 === 0 ? `${metal}${separator}${shape}${tail}${nearMiss}` : `${shape}${separator}${metal}${tail}${nearMiss}`;
    }));
  }
  /** Each path by which the rule reads metal, alone, and lines flagged on one evidence only. */
  const PATH_TITLES = ['Palladium Bullion', '1 oz Gold Buffalo', 'Gold Maple Leaf', '1/10 oz Silver Kangaroo', 'Gold 1 oz Bar',
    'Silver 10 oz Round', 'Gold Eagle Candy', 'Gold Chocolate Coin 1.5 oz', 'Gold Assay Card Holder', 'Gold Foil 1 ozt', '24K Gold Plated Card',
    'Gold Bar Candy'];
  const closureCorpus = () => [...new Set([...unitCorpus(), ...generatedSample(), ...PATH_TITLES])];
  const readsMetal = (title: string) => retailMetalTitleEvidence(title) !== null;

  it('reads evidence on every title the rule reads as metal, by each of its paths: a bullion word, a design after a metal word, a shape with a weight', () => {
    let metal = 0;
    for (const title of closureCorpus()) {
      if (!readsMetal(title)) continue;
      metal += 1;
      // A line the rule never reads is flagged on any evidence: so every metal title must show some.
      assert.ok(retailMetalTitleGuard(title, { assessed: false }).uncertain, `${title}: metal to the rule, with no evidence to the guard`);
    }
    for (const title of ['Palladium Bullion', '1 oz Gold Buffalo', 'Gold 1 oz Bar']) assert.ok(readsMetal(title), title);
    assert.ok(metal >= 60, `${metal} metal titles`);
  });

  /** Root's closed sample, per class (c3decfa5, 11/09): format characters, default-ignorable marks, and fillers. */
  const CLOSURE_SAMPLE = ['\u00AD', '\u200B', '\u2060', '\uFEFF', '\u{E0001}', '\u034F', '\uFE0F', '\u180B', '\u{E0100}', '\u115F', '\u3164', '\u17B4'];

  it('keeps every title the rule reads as metal or the guard flags so with a character that never shows put anywhere: the guard\'s closure', () => {
    const corpus = closureCorpus().filter((title) => readsMetal(title) || retailMetalTitleGuard(title, { assessed: true }).uncertain);
    let titles = 0;
    for (const title of corpus) {
      const characters = [...title];
      for (let at = 0; at <= characters.length; at += 1) {
        for (const never of CLOSURE_SAMPLE) {
          const changed = [...characters.slice(0, at), never, ...characters.slice(at)].join('');
          titles += 1;
          assert.ok(readsMetal(changed) || retailMetalTitleGuard(changed, { assessed: true }).uncertain, `${JSON.stringify(changed)}: silently no metal`);
        }
      }
    }
    // The corpus holds every path and a line flagged on each evidence first.
    for (const title of PATH_TITLES) assert.ok(corpus.includes(title), title);
    const firsts = new Set(corpus.map((title) => retailMetalTitleGuard(title, { assessed: true })).filter((reading) => reading.uncertain)
      .map((reading) => reading.evidence[0]));
    assert.deepEqual(RETAIL_METAL_GUARD_EVIDENCE.filter((evidence) => !firsts.has(evidence)), []);
    assert.ok(corpus.length >= 100, `${corpus.length} titles`);
    assert.ok(titles > 20_000, `${titles} titles`);
  });
});
