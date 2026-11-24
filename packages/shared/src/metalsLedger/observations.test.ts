import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { METALS_COIN_DESIGNS } from './model.js';
import {
  METALS_APPROXIMATE_QUALIFIERS,
  METALS_APPROXIMATE_SIGNS,
  METALS_DESIGN_NAMES,
  METALS_DESIGNS_AFTER_METAL,
  METALS_FINE_MASS_UNITS,
  METALS_FINE_METAL_QUALIFIERS,
  METALS_FINE_QUALIFIERS,
  METALS_GROSS_QUALIFIERS,
  METALS_METAL_WORDS,
  METALS_PURITY_AFTER,
  METALS_PURITY_BEFORE,
  METALS_PURITY_FORMS,
  metalsDesignReading,
  metalsMassBasisReading,
  metalsPurityReading,
  metalsTitleObservations,
  type MetalsTitleObservations,
} from './observations.js';
import { readRational } from './rational.js';

/** Synthetic titles only, shaped like bullion listings; none is a real product's listing. */
const purity = (title: string | null | undefined) => metalsPurityReading(title);
const basis = (title: string | null | undefined) => metalsMassBasisReading(title);
const design = (title: string | null | undefined) => metalsDesignReading(title);
const NOTHING: MetalsTitleObservations = { purity: null, massBasis: 'unknown', design: null };
/** A title that states a purity, qualifies its mass and names a design. */
const FULL = '1 oz Gold Eagle 22K AGW';
const FULL_READ: MetalsTitleObservations = { purity: { text: '22K', value: '11/12' }, massBasis: 'fine', design: 'eagle' };

describe('metals observations: closed lists', () => {
  it('pins every closed list (a change to one is a new version of the content rule)', () => {
    assert.deepEqual([...METALS_PURITY_FORMS], [
      ['.999', '999/1000'], ['.9995', '1999/2000'], ['.9999', '9999/10000'], ['.99999', '99999/100000'],
      ['999', '999/1000'], ['999.9', '9999/10000'], ['99.9%', '999/1000'], ['99.99%', '9999/10000'], ['90%', '9/10'],
      ['91.67%', '9167/10000'], ['24K', '1/1'], ['22K', '11/12'],
    ]);
    assert.deepEqual([...METALS_PURITY_BEFORE], [
      ' ', '\u00A0', '(', '[', '-', ':', ',', '"', '\'', '\u2018', '\u2019', '\u201C', '\u201D',
    ]);
    assert.deepEqual([...METALS_PURITY_AFTER], [
      ' ', '\u00A0', ')', ']', ',', '-', ':', ';', '"', '\'', '\u2018', '\u2019', '\u201C', '\u201D',
    ]);
    assert.deepEqual([...METALS_GROSS_QUALIFIERS], ['GROSS', 'GROSS WEIGHT', 'GROSS WT']);
    assert.deepEqual([...METALS_FINE_QUALIFIERS], [
      'AGW', 'ASW', 'APW', 'FINE WEIGHT', 'FINE WT', 'ACTUAL GOLD WEIGHT', 'ACTUAL SILVER WEIGHT',
    ]);
    assert.deepEqual([...METALS_FINE_METAL_QUALIFIERS], ['FINE GOLD', 'FINE SILVER', 'FINE PLATINUM', 'FINE PALLADIUM']);
    assert.deepEqual([...METALS_FINE_MASS_UNITS], [
      'OZ', 'OZT', 'OUNCE', 'OUNCES', 'TROY OZ', 'TROY OUNCE', 'TROY OUNCES', 'G', 'GRAM', 'GRAMS', 'KG', 'KILO', 'KILOS',
      'KILOGRAM', 'KILOGRAMS',
    ]);
    assert.deepEqual([...METALS_APPROXIMATE_QUALIFIERS], ['MIN', 'MINIMUM', 'AT LEAST', 'APPROX', 'APPROXIMATELY', 'CA']);
    assert.deepEqual([...METALS_APPROXIMATE_SIGNS], ['~', '+/-']);
    assert.deepEqual([...METALS_METAL_WORDS], ['GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM']);
    assert.deepEqual([...METALS_DESIGNS_AFTER_METAL], [
      ['EAGLE', 'eagle'], ['MAPLE', 'maple-leaf'], ['BUFFALO', 'buffalo'], ['KANGAROO', 'kangaroo'], ['PANDA', 'panda'],
    ]);
    assert.deepEqual([...METALS_DESIGN_NAMES], [
      ['KRUGERRAND', 'krugerrand'], ['KRUGERRANDS', 'krugerrand'], ['BRITANNIA', 'britannia'],
      ['BRITANNIAS', 'britannia'], ['PHILHARMONIC', 'philharmonic'], ['PHILHARMONICS', 'philharmonic'],
    ]);
  });

  it('keeps every purity value exact and in lowest terms', () => {
    for (const value of METALS_PURITY_FORMS.values()) assert.notEqual(readRational(value), null, value);
  });

  it('names every coin design of the model, and only those', () => {
    const named = new Set([...METALS_DESIGNS_AFTER_METAL.values(), ...METALS_DESIGN_NAMES.values()]);
    assert.deepEqual([...named].sort(), [...METALS_COIN_DESIGNS].sort());
  });

  it('keeps every phrase in upper-case ASCII letters, one space between words', () => {
    const phrases = [
      ...METALS_GROSS_QUALIFIERS, ...METALS_FINE_QUALIFIERS, ...METALS_FINE_METAL_QUALIFIERS, ...METALS_FINE_MASS_UNITS,
      ...METALS_APPROXIMATE_QUALIFIERS, ...METALS_METAL_WORDS, ...METALS_DESIGNS_AFTER_METAL.keys(),
      ...METALS_DESIGN_NAMES.keys(),
    ];
    for (const phrase of phrases) assert.match(phrase, /^[A-Z]+(?: [A-Z]+)*$/);
    for (const form of METALS_PURITY_FORMS.keys()) assert.match(form, /^(?:\.\d+|\d+(?:\.\d+)?%?|\d+K)$/);
  });
});

describe('metals observations: acceptance cases', () => {
  it('reads a gross mass with its stated purity', () => {
    assert.deepEqual(purity('Gold Bar 10 g GROSS, 90%'), { text: '90%', value: '9/10' });
    assert.equal(basis('Gold Bar 10 g GROSS, 90%'), 'gross');
  });

  it('reads fine gold right after the stated mass as fine content', () => {
    assert.equal(basis('Gold Bar 1 ozt FINE GOLD .9999'), 'fine');
    assert.deepEqual(purity('Gold Bar 1 ozt FINE GOLD .9999'), { text: '.9999', value: '9999/10000' });
  });

  it('reads a purity with no qualifier as an unqualified mass', () => {
    assert.equal(basis('Gold Bar 1 oz .9999'), 'none');
  });

  it('reads gross and fine together as a conflict', () => {
    assert.equal(basis('Gold Bar 1 oz GROSS WEIGHT FINE WEIGHT .9999'), 'conflict');
    assert.equal(basis('10 g GROSS 1 ozt FINE GOLD'), 'conflict');
  });

  it('reads a minimum or an approximation as approximate', () => {
    assert.equal(basis('Gold Bar min. 1 oz .999'), 'approximate');
    assert.equal(basis('Gold Round ~1 oz'), 'approximate');
    assert.equal(basis('Silver Bar 10 oz +/- '), 'approximate');
  });

  it('reads the ordinary Eagle at 22K: its design and purity, its mass unqualified', () => {
    assert.deepEqual(metalsTitleObservations('1 oz Gold Eagle 22K'), {
      purity: { text: '22K', value: '11/12' }, massBasis: 'none', design: 'eagle',
    });
  });

  it('reads a design word only right after a metal word, and a coin name anywhere', () => {
    assert.equal(design('2024 1 oz Gold American Eagle BU'), null);
    assert.equal(design('Gold Krugerrand 1 oz'), 'krugerrand');
    assert.equal(design('1 oz Silver Maple Leaf'), 'maple-leaf');
    assert.equal(design('Gold Eagle and Silver Maple'), null);
  });

  it('never resolves conflicting purities, and keeps one purity stated twice as first written', () => {
    assert.equal(purity('.999 and .9999'), null);
    assert.deepEqual(purity('.9999 99.99%'), { text: '.9999', value: '9999/10000' });
  });

  it('reads nothing from a fullwidth, invisible, cut or masked title', () => {
    assert.deepEqual(metalsTitleObservations(FULL), FULL_READ);
    for (const title of [
      `${FULL} \uFF11`, `\uFF11 oz Gold Eagle 22K AGW`, '1 oz Gold\u200B Eagle 22K AGW', `${FULL}\u2026`, `${FULL}...`,
      '1 oz Gold Eagle *** 22K AGW',
    ]) {
      assert.deepEqual(metalsTitleObservations(title), NOTHING, title);
      assert.equal(purity(title), null, title);
      assert.equal(basis(title), 'unknown', title);
      assert.equal(design(title), null, title);
    }
  });
});

describe('metals observations: purity', () => {
  it('reads every closed form alone, as written, with its exact value', () => {
    for (const [form, value] of METALS_PURITY_FORMS) assert.deepEqual(purity(form), { text: form, value }, form);
  });

  it('reads a karat written with a lower-case k, keeping it as K', () => {
    assert.deepEqual(purity('24k'), { text: '24K', value: '1/1' });
    assert.deepEqual(purity('Gold Bar 1 oz 22k'), { text: '22K', value: '11/12' });
  });

  it('reads a form between any allowed marks', () => {
    const cases: Array<[string, string, string]> = [
      ['Gold Bar (.9999) 1 oz', '.9999', '9999/10000'],
      ['Gold Bar [999.9] 1 oz', '999.9', '9999/10000'],
      ['Gold Bar - 24K - 1 oz', '24K', '1/1'],
      ['Gold Bar-24K-1 oz', '24K', '1/1'],
      ['Purity:.9999; 1 oz Gold Bar', '.9999', '9999/10000'],
      ['Gold Bar,99.99%,1 oz', '99.99%', '9999/10000'],
      ['Gold Bar \u201C.999\u201D 1 oz', '.999', '999/1000'],
      ['Gold Bar \u2018999\u2019 1 oz', '999', '999/1000'],
      ['Gold Bar "90%" 1 oz', '90%', '9/10'],
      ['Gold Bar \'91.67%\' 1 oz', '91.67%', '9167/10000'],
      ['Gold Bar\u00A0.99999\u00A01 oz', '.99999', '99999/100000'],
      ['99.9%: Gold Bar 1 oz', '99.9%', '999/1000'],
      ['Gold Bar 1 oz .9995', '.9995', '1999/2000'],
    ];
    for (const [title, text, value] of cases) assert.deepEqual(purity(title), { text, value }, title);
  });

  it('reads no near miss: a form stands whole, and only the closed forms are forms', () => {
    for (const written of [
      '24KT', '22Karat', '999FINE', '1999', '2.999', '999.99', '.99', '9999', '99%', '23K', '$999', '999/1000', '0.999',
      '18K', '14k', '925', '.925', '99.9', '99.99', '24 K', '999.', '.999.', '999%', '999+', '/999', '#999', '999x',
      '22.5K', '0.9999', '9.999', '100%', '91.6%', '91.667%', '090%', '024K', '24\u212A',
    ]) {
      assert.equal(purity(`Gold Bar 1 oz ${written}`), null, written);
      assert.equal(purity(`${written} Gold Bar 1 oz`), null, written);
    }
  });

  it('never resolves two purities that differ in exact value', () => {
    for (const title of [
      '.999 and .9999', 'Gold Bar 1 oz 24K .9999', '1 oz Gold Eagle 22K 91.67%', 'Silver Round 90% 999',
      'Gold Bar .9995 .9999', 'Gold Bar 999 999.9', 'Gold Bar 99.9% 99.99%', 'Gold Bar 22K 24K',
    ]) assert.equal(purity(title), null, title);
  });

  it('keeps one purity stated several ways, as first written', () => {
    assert.deepEqual(purity('Gold Bar 999.9 .9999 99.99%'), { text: '999.9', value: '9999/10000' });
    assert.deepEqual(purity('Gold Bar 999 Fine .999 99.9%'), { text: '999', value: '999/1000' });
    assert.deepEqual(purity('24k Gold Bar 24K'), { text: '24K', value: '1/1' });
    assert.deepEqual(purity('Gold Bar 1 oz .9999 (.9999)'), { text: '.9999', value: '9999/10000' });
  });
});

describe('metals observations: mass basis', () => {
  it('reads each gross qualifier, in any case, anywhere', () => {
    for (const title of [
      'Gold Bar 10 g GROSS', 'gross 10 g Gold Bar', 'Gold Bar 10 g Gross Weight', 'Gold Bar 10 g (gross wt.)',
      'GROSS-WEIGHT 10 g Gold Bar',
    ]) assert.equal(basis(title), 'gross', title);
  });

  it('reads each fine qualifier, in any case, anywhere', () => {
    for (const title of [
      'Gold Bar 1 oz AGW', 'Silver Round 1 oz (asw)', 'Platinum Bar 1 oz APW', 'Fine Weight 1 oz Gold Bar',
      'Gold Bar 1 oz fine wt.', 'Actual Gold Weight: 1 oz', 'Silver Bar ACTUAL SILVER WEIGHT 10 oz',
    ]) assert.equal(basis(title), 'fine', title);
  });

  it('reads fine gold, silver, platinum or palladium as fine content only right after a stated mass', () => {
    for (const title of [
      '1 ozt FINE GOLD', 'Silver Bar 31.1 g Fine Silver', '1/10 oz fine platinum', 'Palladium Bar 1 kilo Fine Palladium',
      '1 troy ounce Fine Gold Round', 'Gold Bar 10g  Fine  Gold', '1 1/2 oz Fine Gold', '0.5 Troy Oz Fine Silver',
      '1\u00A0oz\u00A0fine gold',
    ]) assert.equal(basis(title), 'fine', title);
    for (const title of [
      'Fine Gold Bar 1 oz', '.9999 Fine Gold Bar 1 oz', 'Gold Bar 1 oz .9999 Fine Gold', '1 oz Bar Fine Gold',
      '1 oz, Fine Gold', '1 oz - Fine Gold', '1 oz. Fine Gold', '1  oz Fine Gold', '1-oz Fine Gold', '.5 oz Fine Gold',
      '2.1.1 oz Fine Gold', '1,000 g Fine Silver', '1 oz FineGold', '1 oz Fine-Gold', '1 oz Fine Golden Bar',
      '1 tola Fine Gold', '1 gr Fine Gold', '\u00BD oz Fine Gold', '1 oz Fine', 'Gold Bar 1 oz .9999 Fine',
    ]) assert.equal(basis(title), 'none', title);
  });

  it('reads each approximate qualifier and sign, in any case, anywhere', () => {
    for (const title of [
      'Gold Bar min 1 oz', 'Gold Bar Minimum 1 oz', 'Gold Bar at least 1 oz', 'Gold Bar approx. 1 oz',
      'Gold Bar APPROXIMATELY 1 oz', 'Gold Bar ca. 31 g', 'Gold Bar~1 oz', 'Silver Bar 10 oz +/-0.1 g',
      'Silver Bar 10 oz (+/-)',
    ]) assert.equal(basis(title), 'approximate', title);
  });

  it('reads no near miss of a qualifier', () => {
    for (const title of [
      'Gold Bar 1 oz Sample Mint', 'Mini Gold Bar 1 g', 'Gold Bar 1 oz Grosse', 'Gold Bar 1 oz Engrossed',
      'Gold Bar 1 oz GrossWeight', 'Gold Bar 1 oz AGWs', 'Gold Bar 1 oz FineWeight', 'Gold Bar 1 oz Fine-Weight',
      'Gold Bar 1 oz Actual Weight', 'Gold Bar 1 oz Actual Platinum Weight', 'Gold Bar 1 oz Net Weight',
      'Gold Bar 1 oz atleast', 'Gold Bar 1 oz at-least', 'Gold Bar 1 oz approximate', 'Gold Bar 1 oz +- 0.1 g',
      'Gold Bar 1 oz + / - 0.1 g', 'Gold Bar 1 oz -/+ 0.1 g', 'Gold Bar 1 oz +/\u2013 0.1 g', 'Gold Bar 1 oz Canada',
      'Gold Bar 1 oz .9999 Fine', 'Gold Bar 1 oz Pure',
    ]) assert.equal(basis(title), 'none', title);
  });

  it('reads gross with fine as a conflict before anything else, then approximate before gross or fine', () => {
    assert.equal(basis('min. 10 g GROSS, 1 oz AGW'), 'conflict');
    assert.equal(basis('~10 g gross 1 ozt fine gold'), 'conflict');
    assert.equal(basis('Gold Bar min. 10 g GROSS'), 'approximate');
    assert.equal(basis('Gold Bar ~1 oz AGW'), 'approximate');
    assert.equal(basis('Gold Bar at least 1 ozt Fine Gold'), 'approximate');
    assert.equal(basis('Gold Bar 1 oz'), 'none');
  });
});

describe('metals observations: coin design', () => {
  it('reads each design word right after each metal word', () => {
    const cases: Array<[string, string]> = [
      ['1 oz Gold Eagle', 'eagle'], ['1 oz platinum eagle', 'eagle'], ['1 oz Silver Maple Leaf', 'maple-leaf'],
      ['PALLADIUM MAPLE 1 oz', 'maple-leaf'], ['1 oz Gold Buffalo', 'buffalo'], ['1 oz Silver Kangaroo', 'kangaroo'],
      ['30 g Gold Panda', 'panda'], ['1 oz Gold\u00A0Eagle', 'eagle'], ['1 oz Gold  Eagle BU', 'eagle'],
    ];
    for (const [title, expected] of cases) assert.equal(design(title), expected, title);
  });

  it('reads a coin\'s own name anywhere, singular or plural', () => {
    const cases: Array<[string, string]> = [
      ['Krugerrand 1 oz Gold', 'krugerrand'], ['1 oz South African Krugerrands', 'krugerrand'],
      ['1 oz Silver Britannia', 'britannia'], ['Britannias 1/4 oz', 'britannia'],
      ['Philharmonic 1 oz Gold', 'philharmonic'], ['1 oz philharmonics', 'philharmonic'],
    ];
    for (const [title, expected] of cases) assert.equal(design(title), expected, title);
  });

  it('reads no design word without a metal word right before it, only spaces between', () => {
    for (const title of [
      'American Eagle 1 oz', '1 oz Gold American Eagle', 'Gold-Eagle 1 oz', 'Gold 2024 Eagle', 'Gold, Eagle 1 oz',
      'Gold (Eagle) 1 oz', 'Gold\u2122 Eagle 1 oz', 'Eagle Gold 1 oz', 'Golden Eagle 1 oz', '1 oz Gold Eagles',
      '1 oz Gold Mapleleaf', '1 oz Gold Leaf', 'SilverEagle 1 oz', '1 oz Gold Kruger', 'Gold 1 oz Eagle',
    ]) assert.equal(design(title), null, title);
  });

  it('reads no design when the title names two different ones, and one named twice as itself', () => {
    for (const title of [
      'Gold Eagle and Silver Maple', 'Gold Eagle Krugerrand', 'Britannia Philharmonic', 'Gold Panda Silver Buffalo',
    ]) assert.equal(design(title), null, title);
    assert.equal(design('Gold Eagle and Silver Eagle'), 'eagle');
    assert.equal(design('Krugerrand Gold Krugerrands'), 'krugerrand');
  });
});

describe('metals observations: fail closed', () => {
  it('reads nothing from a missing, empty, blank or non-string title', () => {
    for (const title of [null, undefined, '', '   ', '\u00A0', 42 as unknown as string, {} as unknown as string]) {
      assert.deepEqual(metalsTitleObservations(title), NOTHING);
      assert.equal(purity(title), null);
      assert.equal(basis(title), 'unknown');
      assert.equal(design(title), null);
    }
  });

  it('reads nothing when any character is outside the closed alphabet, wherever it stands', () => {
    for (const character of [
      '\uFF11', '\uFF2B', '\u212A', '\u0430', '\u043E', '\u200B', '\u200D', '\uFEFF', '\u00AD', '\t', '\n', '\r',
      '\u2026', '\u3000', '\u2007', '\u00B1', '\u2212', '\u2044', '\u00B7', '\uD800', '\uDC00', '\u{1F947}', '\u007F',
      '\u0085', '\u00B5', '\u00E9',
    ]) {
      for (const title of [`${character}${FULL}`, `1 oz Gold${character} Eagle 22K AGW`, `${FULL}${character}`]) {
        assert.deepEqual(metalsTitleObservations(title), NOTHING, JSON.stringify(title));
        assert.equal(purity(title), null);
        assert.equal(basis(title), 'unknown');
        assert.equal(design(title), null);
      }
    }
  });

  it('reads nothing from a title cut or masked anywhere; two marks in a row are no cut', () => {
    for (const mark of ['...', '....', '***', '*****']) {
      for (const title of [`${mark}${FULL}`, `1 oz Gold ${mark} Eagle 22K AGW`, `${FULL}${mark}`, `${FULL} ${mark}`]) {
        assert.deepEqual(metalsTitleObservations(title), NOTHING, title);
      }
    }
    assert.deepEqual(metalsTitleObservations(`${FULL} ..`), FULL_READ);
    assert.deepEqual(metalsTitleObservations(`${FULL} **`), FULL_READ);
  });
});

describe('metals observations: all three at once', () => {
  it('agrees with each reader on every title', () => {
    for (const title of [
      FULL, '1 oz Gold Eagle 22K', 'Gold Bar 10 g GROSS, 90%', '10 g GROSS 1 ozt FINE GOLD', 'Gold Round ~1 oz',
      'Gold Eagle and Silver Maple', '.999 and .9999', `${FULL}...`, '', null, undefined,
    ]) {
      assert.deepEqual(metalsTitleObservations(title), { purity: purity(title), massBasis: basis(title), design: design(title) });
    }
  });
});
