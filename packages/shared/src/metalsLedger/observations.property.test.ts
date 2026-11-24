import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RETAIL_PACK_ALPHABET_EXTRAS } from '../retailImportTool/metalPackRule.js';
import {
  METALS_APPROXIMATE_QUALIFIERS,
  METALS_APPROXIMATE_SIGNS,
  METALS_FINE_METAL_QUALIFIERS,
  METALS_FINE_QUALIFIERS,
  METALS_GROSS_QUALIFIERS,
  METALS_PURITY_AFTER,
  METALS_PURITY_BEFORE,
  METALS_PURITY_FORMS,
  metalsDesignReading,
  metalsMassBasisReading,
  metalsPurityReading,
} from './observations.js';
import { formatRational, rational } from './rational.js';

/**
 * The content observations as properties: every purity form reads its exact value wherever it stands whole, and
 * nothing joined to it or near it reads; no character outside the closed alphabet ever lets anything read; every
 * qualifier gives its mass basis in any case and position, and gross with fine is always a conflict; a design word
 * names its design only right after a metal word. Synthetic titles only. Exact values, near misses, units, metal and
 * design words are written here, never read from the rule's own lists, so a slip there fails.
 */

/** Titles read in full that state no purity, qualify no mass and name no design. */
const PLAIN = [
  'Gold Bar 1 oz Sample Mint',
  '1 oz Silver Round',
  '100 g Platinum Bar (In Assay)',
  '2024 1 oz Gold American Eagle BU',
  'GOLD BAR 1OZ SAMPLE',
];

/** Titles read in full that state a purity, qualify their mass and name a design, with what they read. */
const FULL: Array<[string, string]> = [
  ['1 oz Gold Eagle 22K AGW', '22K = 11/12 | fine | eagle'],
  ['Gold Krugerrand 10 g GROSS, 90%', '90% = 9/10 | gross | krugerrand'],
  ['Silver Maple 1 ozt FINE SILVER .9999', '.9999 = 9999/10000 | fine | maple-leaf'],
  ['Gold Buffalo min. 1 oz .999', '.999 = 999/1000 | approximate | buffalo'],
];
const NOTHING = 'null | unknown | null';

/** Numeric strings near a purity form that are none. */
const NEAR_MISSES = [
  '9999', '99999', '999999', '99.999', '999.99', '9.999', '99.9', '99.99', '0.999', '0.9999', '1.999', '2.999', '1999',
  '9990', '.99', '.9', '.9990', '.99990', '.999999', '.9998', '99%', '100%', '99.5%', '99.95%', '91.6%', '91.667%',
  '89%', '090%', '9.9%', '23K', '25K', '18K', '14K', '10K', '24KT', '22KT', '22KARAT', '24 K', '22 K', 'K24', '24K24',
  '24KK', '024K', '224K', '24.0K', '22.5K', '$999', '#999', '+999', '999+', '999%', '999/1000', '1/999', '999X',
  'X999', '999G', '999FINE', '925', '.925', '958', '.958', '916', '.916', '9167', '.9167', '995', '.995', '999.5',
  '.999.', '999.', '999.9.', '.999/', '/.999', '9.99',
];

/** Words and signs near a mass qualifier that are none. */
const QUALIFIER_NEAR_MISSES = [
  'GROSSE', 'GROS', 'ENGROSS', 'GROSSWEIGHT', 'AGWS', 'ASWX', 'XAPW', 'FINEWEIGHT', 'FINE-WEIGHT', 'FINE_WEIGHT',
  'WEIGHT FINE', 'ACTUALGOLDWEIGHT', 'ACTUAL WEIGHT', 'ACTUAL PLATINUM WEIGHT', 'ACTUAL GOLD', 'GOLD WEIGHT', 'WT',
  'NET WEIGHT', 'MINT', 'MINI', 'MINS', 'MINIMAL', 'CAN', 'CAD', 'AT', 'LEAST', 'ATLEAST', 'AT-LEAST', 'LEAST AT',
  'APPROXIMATE', 'APPROXIMATED', 'ABOUT', 'AROUND', 'NEARLY', '+-', '+/', '/-', '-/+', '+ / -', '+/\u2013', '\u2013/+',
];

/** Stated masses as titles write them: numbers and units. */
const MASS_NUMBERS = ['1', '10', '31.1', '1/10', '0.5', '100', '1 1/2'];
const MASS_UNITS = [
  'OZ', 'OZT', 'OUNCE', 'OUNCES', 'TROY OZ', 'TROY OUNCE', 'TROY OUNCES', 'G', 'GRAM', 'GRAMS', 'KG', 'KILO', 'KILOS',
  'KILOGRAM', 'KILOGRAMS',
];

const METAL_WORDS = ['GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM'];
const AFTER_METAL: Array<[string, string]> = [
  ['EAGLE', 'eagle'], ['MAPLE', 'maple-leaf'], ['BUFFALO', 'buffalo'], ['KANGAROO', 'kangaroo'], ['PANDA', 'panda'],
];
const OWN_NAMES: Array<[string, string]> = [
  ['KRUGERRAND', 'krugerrand'], ['KRUGERRANDS', 'krugerrand'], ['BRITANNIA', 'britannia'], ['BRITANNIAS', 'britannia'],
  ['PHILHARMONIC', 'philharmonic'], ['PHILHARMONICS', 'philharmonic'],
];
const NOT_METALS = [
  'AMERICAN', 'CANADIAN', 'CHINESE', 'GOLDEN', 'SILVERY', 'GOLDS', 'PLATINUMS', 'XGOLD', 'GOLDX', 'OZ', 'BU', 'COIN',
  'BAR', 'FINE', 'PURE', 'BALD', 'SAMPLE',
];
/** What may stand between a metal word and a design word, other than spaces alone. */
const NOT_SPACES = [
  '-', ', ', ' - ', '/', ' 2024 ', ' (', '\u2013', '\u00AE ', '\u2122 ', ' 1 oz ', '.', ': ', '_', '+', '&', ' & ', '\'',
];
const DESIGN_NEAR_MISSES = [
  'EAGLES', 'EAGLET', 'MAPLES', 'MAPLELEAF', 'BUFFALOS', 'BUFFALOES', 'KANGAROOS', 'PANDAS', 'LEAF', 'KRUGER', 'BRIT',
  'PHIL', 'PHILHARMONIKER', 'KRUGERRANDT', 'BRITANNIAN', 'BRITANIA', 'KRUGERAND', 'PHILHARMONICA',
];

const GROSS = [...METALS_GROSS_QUALIFIERS];
/** The fine qualifiers as a title writes them: a fine-metal one right after a stated mass. */
const FINE = [...METALS_FINE_QUALIFIERS, ...[...METALS_FINE_METAL_QUALIFIERS].map((phrase) => `1 ozt ${phrase}`)];
const APPROXIMATE = [...METALS_APPROXIMATE_QUALIFIERS, ...METALS_APPROXIMATE_SIGNS];

const asciiUpper = (text: string) => text.replace(/[a-z]/g, (letter) => letter.toUpperCase());

/** A text in upper case, lower case, title case and alternating case. */
function casings(text: string): string[] {
  const lower = text.toLowerCase();
  return [...new Set([
    asciiUpper(text),
    lower,
    lower.replace(/(^|[^a-z])([a-z])/g, (_, before: string, letter: string) => `${before}${letter.toUpperCase()}`),
    [...lower].map((character, index) => (index % 2 === 0 ? character : character.toUpperCase())).join(''),
  ])];
}

/** A text put into a title as words of its own: first, in the middle, or last. */
function withWord(title: string, text: string): string[] {
  const words = title.split(' ');
  const middle = Math.floor(words.length / 2);
  return [`${text} ${title}`, [...words.slice(0, middle), text, ...words.slice(middle)].join(' '), `${title} ${text}`];
}

/** A text standing whole in a title: alone, first, in the middle and last, between every pair of allowed marks. */
function* placed(title: string, text: string): Iterable<string> {
  const words = title.split(' ');
  const middle = Math.floor(words.length / 2);
  const head = words.slice(0, middle).join(' ');
  const tail = words.slice(middle).join(' ');
  yield text;
  for (const after of METALS_PURITY_AFTER) yield `${text}${after}${title}`;
  for (const before of METALS_PURITY_BEFORE) yield `${title}${before}${text}`;
  for (const before of METALS_PURITY_BEFORE) {
    for (const after of METALS_PURITY_AFTER) {
      yield `${before}${text}${after}${title}`;
      yield `${head}${before}${text}${after}${tail}`;
      yield `${title}${before}${text}${after}`;
    }
  }
}

/** A purity form's exact value, worked out from how it is written: a karat in 24ths, a percentage in hundredths, a point
 * fineness as a decimal, any other fineness in thousandths. */
function valueOf(form: string): string {
  const exactly = (digits: string, scale: bigint) => formatRational(rational(BigInt(digits), scale));
  const tens = (decimals: string | undefined) => 10n ** BigInt(decimals?.length ?? 0);
  let match = /^(\d+)K$/.exec(form);
  if (match) return exactly(match[1], 24n);
  match = /^(\d+)(?:\.(\d+))?%$/.exec(form);
  if (match) return exactly(match[1] + (match[2] ?? ''), 100n * tens(match[2]));
  match = /^\.(\d+)$/.exec(form);
  if (match) return exactly(match[1], tens(match[1]));
  match = /^(\d+)(?:\.(\d+))?$/.exec(form);
  if (match) return exactly(match[1] + (match[2] ?? ''), 1000n * tens(match[2]));
  throw new Error(`no value for ${form}`);
}

function readPurity(title: string): string | null {
  const reading = metalsPurityReading(title);
  return reading === null ? null : `${reading.text} = ${reading.value}`;
}

const readAll = (title: string) =>
  `${readPurity(title)} | ${metalsMassBasisReading(title)} | ${metalsDesignReading(title)}`;

/** The first twenty titles whose reading is not the one expected. */
function mismatches(cases: Iterable<[string, string | null]>, read: (title: string) => string | null): string[] {
  const failed: string[] = [];
  for (const [title, expected] of cases) {
    const actual = read(title);
    if (actual !== expected) failed.push(`${JSON.stringify(title)} -> ${String(actual)}, not ${String(expected)}`);
    if (failed.length >= 20) break;
  }
  return failed;
}

function inAlphabet(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (codePoint >= 0x20 && codePoint <= 0x7e) || RETAIL_PACK_ALPHABET_EXTRAS.has(character);
}

/** Every character of the closed alphabet: printable ASCII and the extras. */
function alphabet(): string[] {
  const characters: string[] = [];
  for (let codePoint = 0x20; codePoint <= 0x7e; codePoint += 1) characters.push(String.fromCharCode(codePoint));
  return [...characters, ...RETAIL_PACK_ALPHABET_EXTRAS];
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
  for (let codePoint = 0x10000; codePoint <= 0x10ffff; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    if (special.test(character) || codePoint % 97 === 0) found.push(character);
  }
  return found;
}

describe('metals observation properties: base titles', () => {
  it('reads nothing from every plain title, and all three from every full one', () => {
    for (const title of PLAIN) assert.equal(readAll(title), 'null | none | null', title);
    for (const [title, read] of FULL) assert.equal(readAll(title), read, title);
  });
});

describe('metals observation properties: the closed alphabet', () => {
  it('reads nothing at all with any character outside the alphabet, anywhere', () => {
    const characters = outsideCharacters();
    assert.ok(characters.length > 60_000);
    const [[base], ...others] = FULL;
    function* cases(): Iterable<[string, string | null]> {
      for (const character of characters) {
        yield [`${character}${base}`, NOTHING];
        yield [`${base.slice(0, 9)}${character}${base.slice(9)}`, NOTHING];
        yield [`${base}${character}`, NOTHING];
      }
      for (const [title] of others) {
        for (let index = 0; index < characters.length; index += 13) {
          yield [`${characters[index]}${title}`, NOTHING];
          yield [`${title} ${characters[index]}`, NOTHING];
        }
      }
    }
    assert.deepEqual(mismatches(cases(), readAll), []);
  });
});

describe('metals observation properties: purity', () => {
  it('reads every closed form, in any case, wherever it stands whole between allowed marks', () => {
    function* cases(): Iterable<[string, string | null]> {
      for (const form of METALS_PURITY_FORMS.keys()) {
        const expected = `${form} = ${valueOf(form)}`;
        for (const written of new Set([form, form.toLowerCase()])) {
          for (const title of PLAIN) for (const variant of placed(title, written)) yield [variant, expected];
        }
      }
    }
    assert.deepEqual(mismatches(cases(), readPurity), []);
  });

  it('never reads a form with anything but an allowed mark joined to it, unless that makes another whole form', () => {
    const forms = [...METALS_PURITY_FORMS.keys()];
    const whole = (text: string) => (forms.includes(asciiUpper(text)) ? `${asciiUpper(text)} = ${valueOf(asciiUpper(text))}` : null);
    function* cases(): Iterable<[string, string | null]> {
      for (const form of forms) {
        for (const character of alphabet()) {
          for (const title of PLAIN) {
            if (!METALS_PURITY_BEFORE.has(character)) yield [`${title} ${character}${form} Bar`, whole(`${character}${form}`)];
            if (!METALS_PURITY_AFTER.has(character)) yield [`${title} ${form}${character} Bar`, whole(`${form}${character}`)];
          }
        }
      }
    }
    assert.deepEqual(mismatches(cases(), readPurity), []);
  });

  it('never reads a near miss, wherever it stands, and a near miss never unsettles a form beside it', () => {
    function* cases(): Iterable<[string, string | null]> {
      for (const nearMiss of NEAR_MISSES) {
        for (const written of casings(nearMiss)) {
          for (const title of PLAIN) {
            for (const variant of withWord(title, written)) yield [variant, null];
            yield [`${title} ${written} .9999`, '.9999 = 9999/10000'];
            yield [`24K ${written} ${title}`, '24K = 1/1'];
          }
          for (const title of PLAIN.slice(0, 2)) for (const variant of placed(title, written)) yield [variant, null];
        }
      }
    }
    assert.deepEqual(mismatches(cases(), readPurity), []);
  });

  it('never resolves two forms that differ in exact value, and keeps forms that agree as first written', () => {
    const forms = [...METALS_PURITY_FORMS.keys()];
    function* cases(): Iterable<[string, string | null]> {
      for (const first of forms) {
        for (const second of forms) {
          const expected = valueOf(first) === valueOf(second) ? `${first} = ${valueOf(first)}` : null;
          for (const title of PLAIN) {
            yield [`${first} ${title} ${second}`, expected];
            yield [`${title} (${first}) [${second}]`, expected];
          }
        }
      }
    }
    assert.deepEqual(mismatches(cases(), readPurity), []);
  });
});

describe('metals observation properties: mass basis', () => {
  it('reads each qualifier alone as its basis, in any case and position', () => {
    const lists: Array<[string[], string]> = [[GROSS, 'gross'], [FINE, 'fine'], [APPROXIMATE, 'approximate']];
    function* cases(): Iterable<[string, string | null]> {
      for (const [qualifiers, expected] of lists) {
        for (const qualifier of qualifiers) {
          for (const written of casings(qualifier)) {
            for (const title of PLAIN) for (const variant of withWord(title, written)) yield [variant, expected];
          }
        }
      }
    }
    assert.deepEqual(mismatches(cases(), metalsMassBasisReading), []);
  });

  it('reads an approximate sign joined to anything, anywhere', () => {
    function* cases(): Iterable<[string, string | null]> {
      for (const sign of METALS_APPROXIMATE_SIGNS) {
        for (const title of PLAIN) {
          for (let index = 0; index <= title.length; index += 1) {
            yield [`${title.slice(0, index)}${sign}${title.slice(index)}`, 'approximate'];
          }
        }
      }
    }
    assert.deepEqual(mismatches(cases(), metalsMassBasisReading), []);
  });

  it('reads every gross qualifier with every fine qualifier as a conflict, in either order and any case', () => {
    function* cases(): Iterable<[string, string | null]> {
      for (const gross of GROSS) {
        for (const fine of FINE) {
          for (const grossWritten of casings(gross)) {
            for (const fineWritten of casings(fine)) {
              for (const title of PLAIN) {
                for (const pair of [`${grossWritten} ${fineWritten}`, `${fineWritten} ${grossWritten}`]) {
                  for (const variant of withWord(title, pair)) yield [variant, 'conflict'];
                }
                yield [`${grossWritten} ${title} ${fineWritten}`, 'conflict'];
                yield [`${fineWritten} ${title} ${grossWritten}`, 'conflict'];
              }
            }
          }
        }
      }
    }
    assert.deepEqual(mismatches(cases(), metalsMassBasisReading), []);
  });

  it('keeps a conflict whatever approximate qualifier stands beside it', () => {
    function* cases(): Iterable<[string, string | null]> {
      for (const approximate of APPROXIMATE) {
        for (const gross of GROSS) {
          for (const fine of FINE) {
            for (const title of PLAIN) {
              yield [`${approximate} ${gross} ${title} ${fine}`, 'conflict'];
              yield [`${title} ${fine} ${approximate} ${gross}`, 'conflict'];
            }
          }
        }
      }
    }
    assert.deepEqual(mismatches(cases(), metalsMassBasisReading), []);
  });

  it('reads an approximate qualifier with gross or with fine, but not both, as approximate', () => {
    function* cases(): Iterable<[string, string | null]> {
      for (const approximate of APPROXIMATE) {
        for (const written of casings(approximate)) {
          for (const other of [...GROSS, ...FINE]) {
            for (const title of PLAIN) {
              yield [`${written} ${other} ${title}`, 'approximate'];
              yield [`${title} ${other} ${written}`, 'approximate'];
              for (const variant of withWord(title, `${other} ${written}`)) yield [variant, 'approximate'];
            }
          }
        }
      }
    }
    assert.deepEqual(mismatches(cases(), metalsMassBasisReading), []);
  });

  it('reads no near miss of a qualifier, in any case and position', () => {
    function* cases(): Iterable<[string, string | null]> {
      for (const nearMiss of QUALIFIER_NEAR_MISSES) {
        for (const written of casings(nearMiss)) {
          for (const title of PLAIN) for (const variant of withWord(title, written)) yield [variant, 'none'];
        }
      }
    }
    assert.deepEqual(mismatches(cases(), metalsMassBasisReading), []);
  });

  it('reads FINE and a metal word right after every stated mass as fine, and beside GROSS as a conflict', () => {
    const gaps: Array<[string, string]> = [[' ', ' '], ['  ', '  '], ['\u00A0', ' '], [' \u00A0', '\u00A0']];
    function* cases(): Iterable<[string, string | null]> {
      for (const number of MASS_NUMBERS) {
        for (const unit of MASS_UNITS) {
          for (const joiner of ['', ' ', '\u00A0']) {
            for (const [gap, metalGap] of gaps) {
              for (const metal of METAL_WORDS) {
                const statement = `${number}${joiner}${unit}${gap}FINE${metalGap}${metal}`;
                for (const written of casings(statement)) {
                  yield [written, 'fine'];
                  yield [`Gold Bar ${written} Sample Mint`, 'fine'];
                  yield [`${written} Bar`, 'fine'];
                }
                yield [`${statement} GROSS`, 'conflict'];
                yield [`GROSS ${statement}`, 'conflict'];
              }
            }
          }
        }
      }
    }
    assert.deepEqual(mismatches(cases(), metalsMassBasisReading), []);
  });

  it('never reads FINE and a metal word as fine unless right after a stated mass', () => {
    const statement = (number: string, joiner: string, unit: string, gap: string, fine: string, metalGap: string, metal: string) =>
      `${number}${joiner}${unit}${gap}${fine}${metalGap}${metal}`;
    const variants = [
      ...['', '.5', '2.1.1', '1/2/3', '1.5/2', '1,000', '1,5', '1.', 'x', '-', '\u00BD', '1\u00BD', '1 \u00BD']
        .map((number) => statement(number, ' ', 'OZT', ' ', 'FINE', ' ', 'GOLD')),
      ...['  ', '-', '.', ',', '/', '_', '\u2013', ' - ', '\u00A0 ', 'x']
        .map((joiner) => statement('1', joiner, 'OZT', ' ', 'FINE', ' ', 'GOLD')),
      ...['GR', 'GMS', 'TOLA', 'LB', 'OZS', 'TROY', 'T OZ', 'OUNCESS', 'GRAMME', 'KGS', 'DWT', 'MG', 'CT', 'OZ T', 'TROYOZ',
        'BAR', 'COIN'].map((unit) => statement('1', ' ', unit, ' ', 'FINE', ' ', 'GOLD')),
      ...['', '-', ', ', '.', ' - ', ' (', ' BAR ', '. ', ':', ' 999 ', ' .9999 ']
        .map((gap) => statement('1', ' ', 'OZT', gap, 'FINE', ' ', 'GOLD')),
      ...['FINEST', 'FINER', 'PURE', 'FIN', 'FINES'].map((fine) => statement('1', ' ', 'OZT', ' ', fine, ' ', 'GOLD')),
      ...['', '-', ' - ', '/', '.', ', '].map((metalGap) => statement('1', ' ', 'OZT', ' ', 'FINE', metalGap, 'GOLD')),
      ...['GOLDEN', 'SILVERY', 'COPPER', 'BRASS', 'PURE', 'WEIGHTS', 'GOLDS', 'AU', 'AG', 'PLATINUMS']
        .map((metal) => statement('1', ' ', 'OZT', ' ', 'FINE', ' ', metal)),
    ];
    function* cases(): Iterable<[string, string | null]> {
      for (const variant of variants) {
        for (const written of casings(variant)) {
          for (const title of [written, `Gold Bar ${written} Sample Mint`, `${written} Bar`]) yield [title, 'none'];
        }
      }
    }
    assert.deepEqual(mismatches(cases(), metalsMassBasisReading), []);
  });
});

describe('metals observation properties: coin design', () => {
  it('reads each design word right after each metal word, in any case, with any spaces between', () => {
    function* cases(): Iterable<[string, string | null]> {
      for (const [word, expected] of AFTER_METAL) {
        for (const metal of METAL_WORDS) {
          for (const gap of [' ', '  ', '\u00A0', ' \u00A0 ']) {
            for (const written of casings(`${metal}${gap}${word}`)) {
              for (const title of PLAIN) for (const variant of withWord(title, written)) yield [variant, expected];
            }
          }
        }
      }
    }
    assert.deepEqual(mismatches(cases(), metalsDesignReading), []);
  });

  it('reads no design word after any other word, or after a metal word with anything but spaces between', () => {
    function* cases(): Iterable<[string, string | null]> {
      for (const [word] of AFTER_METAL) {
        for (const written of casings(word)) {
          for (const title of PLAIN) {
            yield [`${written} ${title}`, null];
            for (const other of NOT_METALS) for (const variant of withWord(title, `${other} ${written}`)) yield [variant, null];
            for (const metal of METAL_WORDS) {
              yield [`${written} ${metal} ${title}`, null];
              for (const between of NOT_SPACES) {
                for (const variant of withWord(title, `${metal}${between}${written}`)) yield [variant, null];
              }
            }
          }
        }
      }
    }
    assert.deepEqual(mismatches(cases(), metalsDesignReading), []);
  });

  it('reads a coin\'s own name anywhere, after anything, in any case', () => {
    function* cases(): Iterable<[string, string | null]> {
      for (const [word, expected] of OWN_NAMES) {
        for (const written of casings(word)) {
          for (const title of PLAIN) {
            for (const variant of withWord(title, written)) yield [variant, expected];
            for (const before of [...METAL_WORDS, ...NOT_METALS]) yield [`${title} ${before} ${written}`, expected];
            for (const between of NOT_SPACES) yield [`${title}${between}${written}`, expected];
          }
        }
      }
    }
    assert.deepEqual(mismatches(cases(), metalsDesignReading), []);
  });

  it('reads no near miss of a design word, even right after a metal word', () => {
    function* cases(): Iterable<[string, string | null]> {
      for (const nearMiss of DESIGN_NEAR_MISSES) {
        for (const written of casings(nearMiss)) {
          for (const title of PLAIN) {
            for (const variant of withWord(title, written)) yield [variant, null];
            for (const metal of METAL_WORDS) for (const variant of withWord(title, `${metal} ${written}`)) yield [variant, null];
          }
        }
      }
    }
    assert.deepEqual(mismatches(cases(), metalsDesignReading), []);
  });

  it('reads no design when two different designs are named, and one named twice as itself', () => {
    const named: Array<[string, string]> = [
      ...AFTER_METAL.map(([word, design]): [string, string] => [`GOLD ${word}`, design]),
      ...OWN_NAMES,
    ];
    function* cases(): Iterable<[string, string | null]> {
      for (const [first, firstDesign] of named) {
        for (const [second, secondDesign] of named) {
          const expected = firstDesign === secondDesign ? firstDesign : null;
          for (const title of PLAIN) {
            yield [`${first} ${title} ${second}`, expected];
            for (const variant of withWord(title, `${first} and ${second}`)) yield [variant, expected];
          }
        }
      }
    }
    assert.deepEqual(mismatches(cases(), metalsDesignReading), []);
  });
});
