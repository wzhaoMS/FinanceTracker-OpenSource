import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RETAIL_METAL_PACK_REASONS,
  RETAIL_METAL_PACK_RULE,
  RETAIL_METAL_PACKS,
  RETAIL_PACK_ALPHABET_EXTRAS,
  RETAIL_PACK_CONTAINER_WORDS,
  RETAIL_PACK_COUNT_LABELS,
  RETAIL_PACK_COUNT_NOUNS,
  RETAIL_PACK_DOUBT_WORDS,
  RETAIL_PACK_FACE_VALUE_WORDS,
  RETAIL_PACK_FINENESS_SHAPES,
  RETAIL_PACK_FINENESS_WORDS,
  RETAIL_PACK_GRADE_PREFIXES,
  RETAIL_PACK_KARAT_WORDS,
  RETAIL_PACK_NUMBER_WORDS,
  RETAIL_PACK_PLURAL_FORM_WORDS,
  RETAIL_PACK_WEIGHT_WORDS,
  RETAIL_PACK_WORDS,
  retailMetalPack,
  retailMetalPackAssessment,
} from './metalPackRule.js';

/** Synthetic titles only, shaped like bullion listings; none is a real product's listing. */
const pack = (title: string | null | undefined) => retailMetalPack(title);
const reason = (title: string | null | undefined) => retailMetalPackAssessment(title).reason;

describe('metal pack rule: closed lists and label', () => {
  it('names its version and closed vocabularies', () => {
    assert.equal(RETAIL_METAL_PACK_RULE, 'metals-pack-v2');
    assert.deepEqual([...RETAIL_METAL_PACKS], ['single', 'multiple', 'unknown']);
    assert.deepEqual([...RETAIL_METAL_PACK_REASONS], [
      'none', 'pack-word', 'plural-form', 'count', 'times-count', 'container-count', 'label-count', 'bracketed-count',
      'doubt-word', 'number-word', 'doubtful-count', 'stray-number', 'outside-alphabet', 'cut-or-masked', 'missing',
    ]);
  });

  it('pins every closed list (a change to one is a new version)', () => {
    assert.deepEqual([...RETAIL_PACK_WORDS], [
      'TUBE', 'TUBES', 'ROLL', 'ROLLS', 'MONSTER', 'MONSTERBOX', 'MONSTERBOXES', 'PACK', 'PACKS', 'MULTIPACK', 'MULTIPACKS',
      'BUNDLE', 'BUNDLES', 'LOT', 'LOTS', 'SHEET', 'SHEETS', 'PCS', 'PIECES', 'QTY', 'QUANTITY', 'SETS', 'BOXES', 'CASES',
      'PAIR', 'PAIRS', 'DUO', 'TRIO', 'COMBIBAR', 'COMBIBARS', 'MULTICARD', 'MULTICARDS',
    ]);
    assert.deepEqual([...RETAIL_PACK_PLURAL_FORM_WORDS], ['BARS', 'COINS', 'ROUNDS', 'INGOTS', 'WAFERS', 'NUGGETS', 'MEDALLIONS']);
    assert.deepEqual([...RETAIL_PACK_DOUBT_WORDS], [
      'BOX', 'CASE', 'SET', 'PACKAGE', 'PACKAGED', 'PACKAGES', 'COLLECTION', 'COLLECTIONS', 'COUNT', 'CT', 'PIECE', 'PC',
      'ASSORTED', 'MIXED', 'VARIETY', 'KIT', 'KITS', 'DOUBLE', 'TWIN', 'MULTI', 'MULTIPLE', 'BULK', 'CONTAINER',
      'CONTAINERS', 'CAPSULES', 'SLEEVE', 'SLEEVES', 'BAG', 'BAGS', 'EACH', 'PER', 'UNITS', 'ITEMS', 'REDACTED',
      'SEVERAL', 'FEW', 'MANY', 'BOTH', 'NUMEROUS', 'VARIOUS', 'COMBO', 'COMBOS', 'ASSORTMENT', 'ASSORTMENTS', 'SAMPLER',
      'SAMPLERS', 'TRAY', 'TRAYS', 'STRIP', 'STRIPS',
    ]);
    assert.deepEqual([...RETAIL_PACK_NUMBER_WORDS], [
      'ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN',
      'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN', 'TWENTY', 'THIRTY', 'FORTY', 'FOURTY', 'FIFTY',
      'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY', 'HUNDRED', 'HUNDREDS', 'THOUSAND', 'THOUSANDS', 'MILLION', 'MILLIONS',
      'BILLION', 'BILLIONS', 'DOZEN', 'DOZENS', 'SCORE', 'SCORES', 'GROSS', 'COUPLE', 'TRIPLE', 'QUADRUPLE', 'QUINTUPLE',
    ]);
    assert.deepEqual([...RETAIL_PACK_COUNT_NOUNS], [
      'COIN', 'COINS', 'BAR', 'BARS', 'ROUND', 'ROUNDS', 'INGOT', 'INGOTS', 'WAFER', 'WAFERS', 'PIECE', 'PIECES', 'PC',
      'PCS', 'PACK', 'PACKS', 'CT', 'COUNT', 'TUBE', 'TUBES', 'ROLL', 'ROLLS', 'UNIT', 'UNITS', 'ITEM', 'ITEMS',
    ]);
    assert.deepEqual([...RETAIL_PACK_CONTAINER_WORDS], [
      'PACK', 'LOT', 'BOX', 'SET', 'CASE', 'ROLL', 'TUBE', 'BAG', 'BUNDLE', 'SHEET', 'SLEEVE', 'PACKAGE', 'CONTAINER',
    ]);
    assert.deepEqual([...RETAIL_PACK_COUNT_LABELS], ['QTY', 'QUANTITY', 'COUNT', 'CT', 'PCS', 'PIECES']);
    assert.deepEqual([...RETAIL_PACK_WEIGHT_WORDS], [
      'OZ', 'OZT', 'OUNCE', 'OUNCES', 'TROY', 'G', 'GR', 'GRAM', 'GRAMS', 'KG', 'KILO', 'KILOS', 'KILOGRAM', 'KILOGRAMS',
      'TOLA', 'TOLAS',
    ]);
    assert.deepEqual([...RETAIL_PACK_KARAT_WORDS], ['K', 'KT', 'KARAT', 'KARATS']);
    assert.deepEqual([...RETAIL_PACK_FINENESS_WORDS], ['FINE', 'PURE', 'PURITY']);
    assert.deepEqual([...RETAIL_PACK_FACE_VALUE_WORDS], ['DOLLAR', 'DOLLARS']);
    assert.deepEqual([...RETAIL_PACK_FINENESS_SHAPES], [
      '375', '585', '750', '800', '900', '916', '917', '925', '950', '958', '986', '995', '999', '9167', '9995', '9999',
      '99999', '91.67', '99.5', '99.9', '99.95', '99.99', '99.999', '916.7', '999.5', '999.9', '999.99', '.900', '.916',
      '.9167', '.925', '.958', '.986', '.995', '.999', '.9995', '.9999', '.99999', '0.900', '0.916', '0.9167', '0.925',
      '0.958', '0.986', '0.995', '0.999', '0.9995', '0.9999', '0.99999',
    ]);
    assert.deepEqual([...RETAIL_PACK_GRADE_PREFIXES], ['MS', 'PF', 'PR', 'SP', 'AU', 'VF', 'XF', 'EF', 'PL']);
    assert.deepEqual([...RETAIL_PACK_ALPHABET_EXTRAS], [
      '\u00BD', '\u00BC', '\u00BE', '\u2152', '\u00A0', '\u00AE', '\u2122', '\u00A9', '\u2013', '\u2014',
      '\u2018', '\u2019', '\u201C', '\u201D', '\u00D7',
    ]);
  });

  it('keeps every word list in upper-case ASCII letters', () => {
    for (const list of [RETAIL_PACK_WORDS, RETAIL_PACK_PLURAL_FORM_WORDS, RETAIL_PACK_DOUBT_WORDS, RETAIL_PACK_NUMBER_WORDS,
      RETAIL_PACK_COUNT_NOUNS, RETAIL_PACK_CONTAINER_WORDS, RETAIL_PACK_COUNT_LABELS, RETAIL_PACK_WEIGHT_WORDS,
      RETAIL_PACK_KARAT_WORDS, RETAIL_PACK_FINENESS_WORDS, RETAIL_PACK_FACE_VALUE_WORDS, RETAIL_PACK_GRADE_PREFIXES]) {
      for (const word of list) assert.match(word, /^[A-Z]+$/);
    }
    for (const fineness of RETAIL_PACK_FINENESS_SHAPES) assert.match(fineness, /^(?:\d+|\d*\.\d+)$/);
  });
});

describe('metal pack rule: single', () => {
  for (const title of [
    '1 oz Gold Bar PAMP Suisse Lady Fortuna Veriscan (New in Assay)',
    '1 oz Gold Bar - Sample Refinery (In Assay) .9999 Fine',
    '2024 1 oz Gold American Eagle BU',
    '1/10 oz Gold Maple Leaf Coin',
    '1 \u00BD oz Gold Round',
    '100 g Gold Bar \u2013 Sample Mint\u00AE',
    '1 oz Gold Buffalo Coin (2024)',
    '1 oz Gold Bar [1999]',
    '1 x 1 oz Gold Bar',
    '1 oz Gold Bar x 1',
    'Gold Kangaroo 1 oz \u201CBU\u201D',
    '10 oz Silver Bar',
    '1 kg Silver Bar',
    '1 oz Gold Eagle MS70',
    '24K Gold Bar 1 oz',
    '99.99% Gold Bar 1 oz',
    '$50 Gold Eagle 1 oz',
    '50 Dollar Gold Eagle 1 oz',
    '1,000 g Silver Bar',
    '9999 Fine Gold Bar 1 oz',
    '1 1/2 oz Gold Round',
    '10 Tola Gold Bar',
    '31.1 g Gold Bar',
    '1/10 oz Gold Coin',
    '1\u00BD oz Gold Round',
    '.5 oz Silver Round',
    '22 kt Gold Eagle 1 oz',
    '18-Karat Gold Bar 1 g',
    '999.9 Fine Gold Bar 1 oz',
    'Gold Bar 1 oz 0.9999',
    'Gold Bar 1 oz (999.9)',
    '90% Silver Round 1 oz',
    '$2.50 Gold Coin 1/10 oz',
    '$1,000 Gold Coin 1 oz',
    '1 oz Gold Eagle PF69',
  ]) {
    it(`reads one piece: ${JSON.stringify(title)}`, () => {
      assert.equal(pack(title), 'single');
      assert.equal(reason(title), 'none');
    });
  }

  it('reads a warehouse title joined from both lines like any other', () => {
    assert.equal(pack('GOLD BAR 1OZ PAMP SAMPLE'), 'single');
    assert.equal(pack('GOLD BAR 1OZ PAMP 25 PACK'), 'multiple');
  });
});

describe('metal pack rule: multiple', () => {
  const cases: Array<[string, string]> = [
    ['1 oz Gold Eagle Tube', 'pack-word'],
    ['Silver Maple Monster Box', 'pack-word'],
    ['Gold Bar 1 g CombiBar', 'pack-word'],
    ['Lot #5 1 oz Gold Bar', 'pack-word'],
    ['1 oz Gold Bars', 'plural-form'],
    ['Gold Coins 1 oz', 'plural-form'],
    ['1 oz Gold Eagle 20-Coin', 'count'],
    ['1 oz Gold Eagle 20 Coin', 'count'],
    ['1 oz Gold Eagle 20Coin', 'count'],
    ['1 oz Gold Eagle 20 - coin', 'count'],
    ['1 oz Gold Eagle 20\u2013Coin', 'count'],
    ['1 g gold bar 50 Unit', 'count'],
    ['10 x 1 oz Gold Bar', 'times-count'],
    ['10x 1 oz Gold Bar', 'times-count'],
    ['10X1 oz Gold Bar', 'times-count'],
    ['1 oz Gold Bar x 10', 'times-count'],
    ['1 oz Gold Bar x10', 'times-count'],
    ['1 oz Gold Bar \u00D7 10', 'times-count'],
    ['10\u00D71 oz Gold Bar', 'times-count'],
    ['Gold Bar 41 x 24 mm', 'times-count'],
    ['1 oz Gold Coin Box of 20', 'container-count'],
    ['1 oz Gold Coin set OF 3', 'container-count'],
    ['1 oz Gold Coin Count: 10', 'label-count'],
    ['1 oz Gold Coin Count 10', 'label-count'],
    ['1 oz Gold Eagle (25)', 'bracketed-count'],
    ['1 oz Gold Eagle [ 10 ]', 'bracketed-count'],
    ['1 oz Gold Eagle ( 2 )', 'bracketed-count'],
    ['Gold Bar 1 oz x 2/1', 'times-count'],
    ['Gold Bar 1 oz x2.0', 'times-count'],
    ['Gold Bar 1 oz (2/1) Tube', 'pack-word'],
    ['Pack of 1 Gold Bar 1 oz 1/0', 'pack-word'],
    ['Gold Bars 1 oz 2.1', 'plural-form'],
  ];
  for (const [title, why] of cases) {
    it(`reads several pieces: ${JSON.stringify(title)}`, () => {
      assert.equal(pack(title), 'multiple');
      assert.equal(reason(title), why);
    });
  }

  it('says multiple when a marker reads even beside a character outside the alphabet', () => {
    assert.equal(pack('1 oz Gold Eagle Tube \u4E00'), 'multiple');
    assert.equal(pack('\u200B10 x 1 oz Gold Bar'), 'multiple');
  });
});

describe('metal pack rule: unknown (fails closed)', () => {
  it('a missing, empty or blank title', () => {
    for (const title of [null, undefined, '', '   ', '\u00A0']) {
      assert.equal(pack(title), 'unknown');
      assert.equal(reason(title), 'missing');
    }
    assert.equal(pack(42 as unknown as string), 'unknown');
  });

  it('a character outside the alphabet hides nothing: fullwidth, lookalikes, invisibles, other scripts', () => {
    for (const title of [
      '1 oz Gold \uFF22\uFF21\uFF32\uFF33',
      '1 oz Gold Bar \u0422UBE',
      '1 oz Gold Bar T\u200BUBE',
      '1 oz Gold Bar\uFEFF',
      '1 oz Gold Bar \u00E9',
      '1 oz Gold Bar \u0661\u0660 x',
      '1 oz Gold Bar \u2026',
      '1 oz Gold Bar\t',
      '1 oz Gold Bar\n2',
    ]) {
      assert.equal(pack(title), 'unknown', JSON.stringify(title));
      assert.equal(reason(title), 'outside-alphabet', JSON.stringify(title));
    }
  });

  it('a word that may mean several pieces', () => {
    for (const title of ['1 oz Gold Eagle in Original Box', '1 oz Gold Proof Set', '1 oz Gold Eagle in Case',
      '$20 Gold Double Eagle', '1 oz Gold Bar Each', '1 Piece 1 oz Gold Bar', 'Assorted 1 oz Gold Rounds Mixed',
      '1 oz Gold Bar Combo', 'Gold Bar 1 g Assortment', 'Gold Coin Sampler 1/10 oz', '1 g Gold Bar Tray', '1 g Gold Bar Strip']) {
      assert.notEqual(pack(title), 'single', title);
    }
    assert.equal(reason('1 oz Gold Eagle in Original Box'), 'doubt-word');
    assert.equal(reason('$20 Gold Double Eagle'), 'doubt-word');
  });

  it('a count written out in words, any cardinal or scale word', () => {
    for (const title of ['Two 1 oz Gold Eagle', 'One 1 oz Gold Eagle', 'ZERO 1 oz Gold Eagle', 'THIRTEEN 1 oz Gold Eagle',
      'Gold Bar 1 oz nineteen', 'Gold Bar 1 oz sixty', 'Ninety 1 oz Gold Eagle', 'Gold Bar 1 oz thousand',
      'Twenty-One 1 oz Gold Eagle', 'Gold Bar 1 oz a score', 'Gold Bar 1 oz Gross']) {
      assert.equal(pack(title), 'unknown', title);
      assert.equal(reason(title), 'number-word', title);
    }
    assert.equal(pack('Dozen Gold Rounds'), 'multiple');
    assert.equal(pack('Several 1 oz Gold Eagle'), 'unknown');
  });

  it('a count that could be a year, a code or zero', () => {
    for (const title of ['2024 Coin 1 oz Gold Eagle', '1 oz Gold Eagle 2024 x', '1 oz Gold Eagle (5000)', '0 x 1 oz Gold Bar',
      '1 oz Gold Eagle (0)']) {
      assert.equal(pack(title), 'unknown', title);
      assert.equal(reason(title), 'doubtful-count', title);
    }
  });

  it('a count that is not a whole number is never cut down to its last group', () => {
    for (const title of ['2/1 x 1 oz Gold Bar', '20/1 Coin 1 oz Gold Eagle', 'Gold Bar 1 oz 2.1x', 'Gold Bar 1 oz 20.01 Item',
      'Gold Bar 1 oz x 1.0', 'Box of 1,000 Gold Bar 1 g', 'Gold Bar 1 oz x 1/2']) {
      assert.equal(pack(title), 'unknown', title);
      assert.equal(reason(title), title.startsWith('Box') ? 'doubt-word' : 'doubtful-count', title);
    }
  });

  it('a title the site cut or masked', () => {
    assert.equal(pack('1 oz Gold Bar PAMP Suisse Lady Fortu...'), 'unknown');
    assert.equal(reason('1 oz Gold Bar PAMP Suisse Lady Fortu...'), 'cut-or-masked');
    assert.equal(pack('1 oz Gold Bar Lady Fortu... 2024 1 oz'), 'unknown');
    assert.equal(pack('1 oz Gold Bar ****'), 'unknown');
    assert.equal(reason('1 oz Gold Bar ****'), 'cut-or-masked');
    assert.equal(pack('1 oz Gold Bar [redacted]'), 'unknown');
  });

  it('a number nothing explains could be a count', () => {
    for (const title of ['1 oz Gold Eagle - 20', '20 1 oz Gold Eagle', 'Gold Bar 1 oz Series 2', 'No. 5 Gold Bar 1 oz',
      'No.5 Gold Bar 1 oz', '1 oz Gold Eagle MS 70', '1 oz Gold Bar 999']) {
      assert.equal(pack(title), 'unknown', title);
      assert.equal(reason(title), 'stray-number', title);
    }
  });

  it('a phrase explains nothing unless its shape is valid in its context', () => {
    for (const title of [
      // Not a measure: improper, zero or whole-valued fractions and decimals, two points, a mixed number above 1.
      'Gold Bar 1 oz (2/1)', 'Gold Bar 1 oz [2.0]', 'Gold Bar 1 oz [12.0]', 'Gold Bar 1 oz 20.0', 'Gold Bar 1 oz 1/0',
      'Gold Bar 1 oz 0/0', 'Gold Bar 1 oz 2.1.1', 'Gold Bar 1 oz 1/2', '1/1 oz Gold Bar', '3/2 oz Gold Bar',
      '0/5 oz Gold Bar', '2 1/2 oz Gold Round', '10 1/10 oz Gold Eagle', '2\u00BD oz Gold Round', '2 \u00BD oz Gold Round',
      '1,00 g Gold Bar', '1,000.5 g Gold Bar', '1 - 1/2 oz Gold Round',
      // Not a karat, fineness, percentage, face value or grade.
      '5K Gold Bar 1 oz', '30 Karat Gold Bar 1 oz', '2 Fine Gold Bar 1 oz', '24 Fine Gold Bar 1 oz', '150% Gold Bar 1 oz',
      '0% Gold Bar 1 oz', '$2.5 Gold Coin 1 oz', '$0 Gold Coin 1 oz', '1.5 Dollar Gold Coin 1 oz', '1 oz Gold Eagle MS71',
      '1 oz Gold Eagle MS0', '1 oz Gold Bar 9999', '1 oz Gold Bar (.5)', '1 oz Gold Bar 98.5 %',
    ]) {
      assert.equal(pack(title), 'unknown', title);
      assert.equal(reason(title), 'stray-number', title);
    }
  });
});

describe('metal pack rule: review MP-01/MP-02 boundary (synthetic)', () => {
  const falseSingles = (titles: readonly string[]) => titles.filter((title) => pack(title) === 'single');

  it('keeps single-piece and stated-measure controls single', () => {
    for (const title of ['1 oz Gold Bar', '1 x 1 oz Gold Bar', '1 oz Gold Bar x 1', '31.1 g Gold Bar', '1/10 oz Gold Coin',
      '1 1/2 oz Gold Round', '1,000 g Silver Bar', '99.99% Gold Bar 1 oz', '$50 Gold Eagle 1 oz', '1 oz Gold Eagle MS70']) {
      assert.equal(pack(title), 'single', title);
    }
  });

  it('never cuts a numeric phrase before a count marker down to its last group', () => {
    assert.deepEqual(falseSingles(['2/1 x 1 oz Gold Bar', '20/1 Coin 1 oz Gold Eagle', 'Gold Bar 1 oz 2.1x',
      'Gold Bar 1 oz 20.01 Item']), []);
  });

  it('never reads a bracketed whole-valued fraction or decimal as one piece', () => {
    const titles: string[] = [];
    for (let count = 2; count <= 12; count += 1) titles.push(`Gold Bar 1 oz (${count}/1)`, `Gold Bar 1 oz [${count}.0]`);
    assert.deepEqual(falseSingles(titles), []);
    for (const title of titles) assert.equal(pack(title), 'unknown', title);
  });

  it('never explains an unexplained decimal or an invalid fraction as a measure', () => {
    assert.deepEqual(falseSingles(['Gold Bar 1 oz 20.0', 'Gold Bar 1 oz 1/0', 'Gold Bar 1 oz 0/0', 'Gold Bar 1 oz 2.1.1']), []);
  });

  it('never reads zero, teen, tens or scale count words as one piece', () => {
    const titles: string[] = [];
    for (const word of ['ZERO', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN', 'SIXTY',
      'SEVENTY', 'EIGHTY', 'NINETY', 'THOUSAND']) {
      titles.push(`${word} 1 oz Gold Eagle`, `Gold Bar 1 oz ${word.toLowerCase()}`);
    }
    assert.deepEqual(falseSingles(titles), []);
  });

  it('keeps readable definite markers multiple beside numeric uncertainty', () => {
    for (const title of ['Gold Bar 1 oz (2/1) Tube', 'Gold Bars 1 oz 2.1', 'Pack of 1 Gold Bar 1 oz 1/0', '2 x 1 oz Gold Bar',
      'Gold Bar 1 oz x 2/1']) {
      assert.equal(pack(title), 'multiple', title);
    }
  });

  it('reads markers past a display-title cut, and never reads single beside a mask or an unsupported character', () => {
    const prefix = `Gold Bar 1 oz ${'Sample Mint '.repeat(30)}`;
    assert.ok(prefix.length > 240);
    assert.equal(pack(`${prefix}Tube`), 'multiple');
    assert.equal(pack(`${prefix}20-Coin`), 'multiple');
    for (const suffix of ['...', '***', '\u200B', '\uFEFF', '\uD800', '\u{1D7D8}']) {
      assert.notEqual(pack(`Gold Bar 1 oz ${suffix}`), 'single', JSON.stringify(suffix));
    }
  });
});

describe('metal pack rule: review MP-03 boundary (synthetic)', () => {
  const FRACTIONS = ['\u00BD', '\u00BC', '\u00BE', '\u2152'];

  it('never reads a lone vulgar fraction at a count marker, in brackets or unexplained as one piece', () => {
    for (const fraction of FRACTIONS) {
      const cases: Array<[string, string]> = [
        [`Gold Bar 1 oz ${fraction}`, 'stray-number'],
        [`Gold Bar 1 oz x ${fraction}`, 'doubtful-count'],
        [`Gold Bar 1 oz ${fraction}x`, 'doubtful-count'],
        [`Gold Bar 1 oz ${fraction} Coin`, 'doubtful-count'],
        [`Gold Bar 1 oz (${fraction})`, 'stray-number'],
        [`Gold Bar 1 oz [${fraction}]`, 'stray-number'],
      ];
      for (const [title, why] of cases) {
        assert.equal(pack(title), 'unknown', title);
        assert.equal(reason(title), why, title);
      }
    }
  });

  it('holds them with any joiner and in any position', () => {
    for (const fraction of FRACTIONS) {
      for (const title of [`Gold Bar 1 oz \u00D7 ${fraction}`, `Gold Bar 1 oz \u00D7${fraction}`, `x${fraction} Gold Bar 1 oz`,
        `${fraction}-Coin Gold 1 oz`, `Gold Bar 1 oz ${fraction}\u00A0X`, `Gold Bar 1 oz ${fraction} Unit`, `Gold ${fraction} Bar 1 oz`,
        `Gold Bar 1 oz ${fraction} Gold`]) {
        assert.equal(pack(title), 'unknown', title);
      }
    }
  });

  it('keeps a vulgar fraction before a weight word single', () => {
    for (const fraction of FRACTIONS) {
      for (const title of [`${fraction} oz Gold Bar`, `1${fraction} oz Gold Bar`, `1 ${fraction} oz Gold Bar`, `Gold Coin (${fraction} oz)`,
        `Gold Coin ${fraction}-oz`, `${fraction} Troy oz Gold Round`, `Gold Eagle ${fraction} Ounce`]) {
        assert.equal(pack(title), 'single', title);
      }
    }
  });

  it('keeps definite markers multiple beside a lone vulgar fraction', () => {
    for (const fraction of FRACTIONS) {
      for (const title of [`Gold Bar 1 oz Tube ${fraction}`, `Gold Bar 1 oz x 2${fraction}`, `Gold Bars 1 oz ${fraction}`,
        `2 x ${fraction} oz Gold Coin`, `${fraction} oz Gold Coin x 10`]) {
        assert.equal(pack(title), 'multiple', title);
      }
    }
  });

  it('never reads single with any other Unicode vulgar fraction, which is outside the alphabet', () => {
    const others = ['\u2150', '\u2151', '\u2153', '\u2154', '\u2155', '\u2156', '\u2157', '\u2158', '\u2159', '\u215A', '\u215B',
      '\u215C', '\u215D', '\u215E', '\u215F', '\u2189'];
    for (const fraction of others) {
      for (const title of [`${fraction} oz Gold Bar`, `Gold Bar 1 oz ${fraction}`, `Gold Bar 1 oz x ${fraction}`]) {
        assert.equal(pack(title), 'unknown', title);
        assert.equal(reason(title), 'outside-alphabet', title);
      }
    }
  });
});

describe('metal pack rule: v2, a face value is no count (synthetic)', () => {
  // v1 read each number as a count: "$50 Coin" was fifty coins (multiple), and "$1.00 Coin" and "$1,000 Coin" a
  // doubtful count "00" or "000" (unknown).
  for (const title of ['$50 Coin', '$1.00 Coin', '$1,000 Coin', '$50-Coin', '1 oz Gold American Eagle $50 Coin BU']) {
    it(`reads a face value right before a count noun as one piece: ${JSON.stringify(title)}`, () => {
      assert.equal(pack(title), 'single');
      assert.equal(reason(title), 'none');
    });
  }

  it('keeps a face value that is not right before a count noun single, as v1 did', () => {
    for (const title of ['$5 Gold Coin', '2024 $5 Gold Coin 1/10 oz']) {
      assert.equal(pack(title), 'single', title);
      assert.equal(reason(title), 'none', title);
    }
  });

  it('still reads a count elsewhere in the title', () => {
    const cases: Array<[string, string]> = [['$1 Coin 10-Pack', 'count'], ['2 x $50 Coin', 'times-count']];
    for (const [title, why] of cases) {
      assert.equal(pack(title), 'multiple', title);
      assert.equal(reason(title), why, title);
    }
  });

  it('still reads a number as a count unless its whole phrase is money right after "$"', () => {
    const cases: Array<[string, string, string]> = [
      ['50 Coin', 'multiple', 'count'],
      ['$ 50 Coin', 'multiple', 'count'],
      ['$2.5 Coin', 'multiple', 'count'],
      ['$0 Coin', 'unknown', 'doubtful-count'],
      ['$\u00BD Coin', 'unknown', 'doubtful-count'],
    ];
    for (const [title, expected, why] of cases) {
      assert.equal(pack(title), expected, title);
      assert.equal(reason(title), why, title);
    }
  });

  it('still reads a thousands-grouped number before an unlisted word as a stray number', () => {
    for (const title of ['1,000 Sample Gold Bar 1 oz', 'Gold Bar 1 oz 1,000 Sample', 'Gold Bar 1 oz 1,000 Gold']) {
      assert.equal(pack(title), 'unknown', title);
      assert.equal(reason(title), 'stray-number', title);
    }
  });
});

describe('metal pack rule: determinism', () => {
  it('gives the same answer every time, whatever the case of the ASCII letters', () => {
    for (const title of ['1 OZ GOLD BAR', '1 oz gold bar', '1 Oz GoLd BaR']) {
      assert.equal(pack(title), 'single');
    }
    for (const title of ['1 OZ GOLD BARS', '1 oz gold bars', '1 Oz GoLd BaRs']) {
      assert.equal(pack(title), 'multiple');
    }
  });

  it('never folds a non-ASCII letter into an ASCII one (the Kelvin sign is no K, the long s no S)', () => {
    assert.equal(pack('1 oz Gold \u212Aangaroo'), 'unknown');
    assert.equal(pack('1 oz Gold Bar\u017F'), 'unknown');
  });
});
