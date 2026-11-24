import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  COIN_DESIGN_WORDS,
  RETAIL_METAL_GUARD,
  RETAIL_METAL_GUARD_CLAUSES,
  RETAIL_METAL_GUARD_EVIDENCE,
  RETAIL_METAL_GUARD_FINENESS_SHAPES,
  RETAIL_METAL_GUARD_FINENESS_WORDS,
  RETAIL_METAL_GUARD_KARAT_WORDS,
  RETAIL_METAL_GUARD_REFUSALS,
  RETAIL_METAL_GUARD_SHAPE_WORDS,
  RETAIL_METAL_TITLE_RULE,
  RETAIL_WEIGHT_RANGE_WORDS,
  RETAIL_WEIGHT_SCAN_SEPARATORS,
  retailMetalTitleEvidence,
  retailMetalTitleGuard,
  retailStatedWeights,
} from './metalTitleRule.js';
import { RETAIL_PACK_FINENESS_SHAPES, RETAIL_PACK_FINENESS_WORDS, RETAIL_PACK_KARAT_WORDS } from './metalPackRule.js';

const match = (title: string) => retailMetalTitleEvidence(title);

/** Each title must still be a gold bar, with no exact weight. */
function noExactWeight(titles: readonly string[]): void {
  for (const title of titles) {
    const evidence = match(title);
    assert.equal(evidence?.form, 'bar', `${title}: still a gold bar, never dropped from the metal evidence`);
    assert.equal(evidence?.statedWeight, null, title);
    assert.deepEqual(retailStatedWeights(title), [], title);
  }
}

describe('RETAIL_METAL_TITLE_RULE: bullion by product name', () => {
  it('is version 3: the assay card (v2: the year word, and a mixed number\'s whole number of three digits at most)', () => {
    assert.equal(RETAIL_METAL_TITLE_RULE, 'title-rule-v3');
  });

  it('matches gold and silver bars and coins, labelled as the title rule', () => {
    assert.deepEqual(match('1 oz Gold Bar Sample Refinery (New in Assay)'), {
      metal: 'XAU', form: 'bar', statedWeight: { value: '1', unit: 'oz' }, rule: RETAIL_METAL_TITLE_RULE,
    });
    assert.deepEqual(match('2025 American Gold Eagle 1 oz Coin'), {
      metal: 'XAU', form: 'coin', statedWeight: { value: '1', unit: 'oz' }, rule: 'title-rule-v3',
    });
    assert.deepEqual(match('Silver Maple Leaf Coins, 25 Count Tube'), {
      metal: 'XAG', form: 'coin', statedWeight: null, rule: 'title-rule-v3',
    });
    assert.equal(match('10 oz Silver Bar')?.metal, 'XAG');
    assert.equal(match('1 kilo Silver Bar')?.statedWeight?.unit, 'kg');
    assert.equal(match('Platinum Bar 1 Troy Oz')?.metal, 'XPT');
    assert.equal(match('Palladium Bullion')?.form, 'bullion');
    assert.equal(match('1 oz Gold Krugerrand')?.form, 'coin');
  });

  it('reads the design names only right after a metal word, from a closed list', () => {
    assert.deepEqual([...COIN_DESIGN_WORDS].sort(), ['BUFFALO', 'EAGLE', 'KANGAROO', 'MAPLE', 'PANDA']);
    assert.equal(match('Gold Buffalo')?.form, 'coin');
    assert.equal(match('Silver Panda')?.form, 'coin');
    assert.equal(match('Gold Kangaroo')?.form, 'coin');
    // A design word not right after a metal word, with no other bullion form, is not bullion.
    assert.equal(match('American Eagle Gold'), null);
    assert.equal(match('Gold Liberty'), null);
  });

  it('never matches the near-misses: gold-tone, plated, silverware, flatware, coin cells, stools, chocolate, Eagle brands', () => {
    for (const title of [
      'Gold-Tone Stainless Watch',
      'Goldtone Picture Frame Bar 1 oz',
      '18K Gold Plated Necklace',
      'Gold Filled Bracelet',
      'Silverware Set, 20 Piece',
      'Sterling Silver Flatware 1 oz',
      'Silver Oxide Coin Cell Batteries',
      'Gold Bar Stool, Set of 2',
      'Milk Chocolate Gold Bars 3.5 oz',
      'Eagle Creek Silver Backpack',
      'Eagle Brand Sweetened Condensed Milk 14 oz',
      'Silver Eagle Tequila Gift Card',
      'Gold Leaf Sheets',
      'Gold Star Membership',
      'Silver Coin Purse',
      'GOLDFISH CRACKERS 30 OZ',
      'Golden Raisins 2 lb',
      'KS ORGANIC EGGS',
    ]) {
      assert.equal(match(title), null, title);
    }
  });

  it('keeps MAPLE LEAF a coin design while LEAF alone is a near-miss', () => {
    assert.equal(match('Gold Maple Leaf 1/10 oz')?.form, 'coin');
    assert.equal(match('Gold Leaf Coin 1 oz'), null);
  });

  it('needs a stated weight for a shape word alone', () => {
    assert.equal(match('Gold Coin'), null);
    assert.equal(match('Silver Round'), null);
    assert.equal(match('Gold Coin 1 oz')?.form, 'coin');
    assert.equal(match('Silver Round 1 oz')?.form, 'round');
  });

  it('gives a form only when the title names one: bar or coin over bullion, none when two compete', () => {
    assert.equal(match('Gold Bar in Assay 1 oz')?.form, 'bar');
    assert.equal(match('Gold Coin Bullion 1 oz')?.form, 'coin');
    assert.equal(match('Gold Ingot 100 g')?.form, 'ingot');
    assert.equal(match('Silver Bullion 10 oz')?.form, 'bullion');
    assert.equal(match('Gold Bar and Coin Set 1 oz')?.form, null);
    assert.equal(match('Silver Bar Round 1 oz')?.form, null);
    assert.equal(match('Silver Round Ingot 1 oz')?.form, null);
    assert.equal(match('Silver Round Bullion 1 oz')?.form, null);
    assert.equal(match('Gold Ingot in Assay')?.form, null);
  });

  it('gives no metal when a title names several', () => {
    const evidence = match('Gold and Silver Coin Set 1 oz');
    assert.equal(evidence?.metal, null);
    assert.equal(evidence?.form, 'coin');
  });

  it('keeps weights exactly as stated: a bare oz is never troy, nothing is converted', () => {
    assert.deepEqual(retailStatedWeights('1 oz Gold Bar'), [{ value: '1', unit: 'oz' }]);
    assert.deepEqual(retailStatedWeights('1 Troy Oz Gold Bar'), [{ value: '1', unit: 'ozt' }]);
    assert.deepEqual(retailStatedWeights('1 troy ounce gold coin'), [{ value: '1', unit: 'ozt' }]);
    assert.deepEqual(retailStatedWeights('1 OZT Gold'), [{ value: '1', unit: 'ozt' }]);
    assert.deepEqual(retailStatedWeights('1 ounce gold coin'), [{ value: '1', unit: 'oz' }]);
    assert.deepEqual(retailStatedWeights('2 ounces'), [{ value: '2', unit: 'oz' }]);
    assert.deepEqual(retailStatedWeights('1/10 oz Gold Eagle'), [{ value: '1/10', unit: 'oz' }]);
    assert.deepEqual(retailStatedWeights('1/4 oz Gold Eagle'), [{ value: '1/4', unit: 'oz' }]);
    assert.deepEqual(retailStatedWeights('1 / 4 oz Gold Eagle'), [], 'a fraction with spaces is outside the grammar');
    assert.deepEqual(retailStatedWeights('1oz gold'), [{ value: '1', unit: 'oz' }]);
    assert.deepEqual(retailStatedWeights('1-oz gold'), [{ value: '1', unit: 'oz' }]);
    assert.deepEqual(retailStatedWeights('100 g gold'), [{ value: '100', unit: 'g' }]);
    assert.deepEqual(retailStatedWeights('100g gold'), [{ value: '100', unit: 'g' }]);
    assert.deepEqual(retailStatedWeights('31.10 grams gold'), [{ value: '31.1', unit: 'g' }]);
    assert.deepEqual(retailStatedWeights('1 kg silver'), [{ value: '1', unit: 'kg' }]);
    assert.deepEqual(retailStatedWeights('1 Kilogram silver'), [{ value: '1', unit: 'kg' }]);
    assert.deepEqual(retailStatedWeights('0.5 oz gold'), [{ value: '0.5', unit: 'oz' }]);
    assert.deepEqual(retailStatedWeights('1 gallon'), []);
    assert.deepEqual(retailStatedWeights('0 oz'), []);
    assert.deepEqual(retailStatedWeights('1/0 oz'), []);
  });

  it('gives a weight only when every weight the title states is exact and the same; a differing or unreadable one gives none', () => {
    assert.deepEqual(match('1 oz Gold Bar, 1 oz')?.statedWeight, { value: '1', unit: 'oz' }, 'the same statement twice');
    assert.deepEqual(match('Gold Bar 1 oz (1 oz)')?.statedWeight, { value: '1', unit: 'oz' });
    assert.deepEqual(match('Gold Bar \u00bd oz (1/2 oz)')?.statedWeight, { value: '1/2', unit: 'oz' });
    assert.deepEqual(match('Gold Coin 1 troy oz (1 ozt)')?.statedWeight, { value: '1', unit: 'ozt' });
    noExactWeight([
      '1 oz Gold Bar (31.1 g)',
      '1 oz Gold Bar 1 troy oz',
      'Gold Bar 1 oz (1 ozt)',
      'Gold Bar 1 oz (2 oz)',
      'Gold Bar 0.5 oz (1/2 oz)',
      'Gold Bar 1 oz (\uff11 oz)',
      'Gold Bar 1 oz (1 \uff4f\uff5a)',
      'Gold Bar 1 oz, 1 oz, 2 oz',
    ]);
    assert.equal(match('Gold Bar in Assay')?.statedWeight, null);
  });

  it('closes the left scan over a fixed list: these separators and range words, and nothing else', () => {
    assert.deepEqual([...RETAIL_WEIGHT_SCAN_SEPARATORS], [
      '-', '\u2013', '\u2014', '+', '/', '\u00b1', '~', ':', ',', '"', '\'', '\u201c', '\u201d', '\u2018', '\u2019', '(', '[', '\u00d7',
    ]);
    assert.deepEqual([...RETAIL_WEIGHT_RANGE_WORDS], ['to', 'or', 'and', 'x', 'through', 'thru', 'plus', 'minus', 'times']);
  });

  it('reads a number as exact only when the start or a plain word comes before any number, past separators and range words', () => {
    const exact: Array<[string, { value: string; unit: string }]> = [
      ['Gold Bar - \u00bd oz', { value: '1/2', unit: 'oz' }],
      ['Gold Bar - 4 oz', { value: '4', unit: 'oz' }],
      ['Gold Bar \u2014 4 oz', { value: '4', unit: 'oz' }],
      ['Gold Bar, 1 oz', { value: '1', unit: 'oz' }],
      ['Weight: 1 oz Gold Bar', { value: '1', unit: 'oz' }],
      ['Gold Bar "1 oz"', { value: '1', unit: 'oz' }],
      ['"1 oz" Gold Bar', { value: '1', unit: 'oz' }],
      ['Gold Bar \u201c1 oz\u201d', { value: '1', unit: 'oz' }],
      ['Gold Bar to 4 oz', { value: '4', unit: 'oz' }],
      ['Box 1 oz Gold Bar', { value: '1', unit: 'oz' }],
      ['Gold-Bar 1 oz', { value: '1', unit: 'oz' }],
      ['2025 American Gold Eagle 1 oz Coin', { value: '1', unit: 'oz' }],
    ];
    for (const [title, weight] of exact) assert.deepEqual(match(title)?.statedWeight, weight, title);
    noExactWeight([
      'Gold Bar 1 to 4 oz',
      'Gold Bar 1 +/- 4 oz',
      'Gold Bar 1 -- 4 oz',
      'Gold Bar 1 + - 4 oz',
      'Gold Bar 2 x 1 oz',
      'Gold Bar 1 or 2 oz',
      'Gold Bar 1 and 2 oz',
      'Gold Bar 1 through 4 oz',
      'Gold Bar 1 THRU 4 oz',
      'Gold Bar 1 plus 4 oz',
      'Gold Bar 2x 1 oz',
      'Gold Bar 2 X 1 oz',
      'Gold Bar 2 \u00d7 1 oz',
      'Gold Bar 1 - to - 4 oz',
      'Gold Bar 24K 1 oz',
      'Gold Bar 1a 4 oz',
      'Gold Bar (2) 1 oz',
      'Gold Bar; 1 oz',
      'Gold Bar 1 & 4 oz',
      'Gold Bar 1 \u2212 4 oz',
      'Gold Bar 1 \u0445 4 oz',
      'Gold Bar 1 \uff54\uff4f 4 oz',
      'Gold Bar 1 t\u200bo 4 oz',
    ]);
  });

  it('reads a year right before the weight as a word, in one narrow form only (v2)', () => {
    const exact: Array<[string, { value: string; unit: string }]> = [
      ['2024 1 oz Gold Bar', { value: '1', unit: 'oz' }],
      ['Gold Bar 2024 1 oz', { value: '1', unit: 'oz' }],
      ['American Gold Eagle 2024 1 oz Coin', { value: '1', unit: 'oz' }],
      ['GOLD BAR 2024 1 OZ', { value: '1', unit: 'oz' }],
      ['Gold Bar (2024 1 oz)', { value: '1', unit: 'oz' }],
      ['Gold Bar [2024 \u00bd oz]', { value: '1/2', unit: 'oz' }],
      ['Gold Coin 1900 1/10 oz', { value: '1/10', unit: 'oz' }],
      ['Gold Coin 2099 1 \u00bd troy oz', { value: '1 1/2', unit: 'ozt' }],
      ['Gold-Eagle 2024 31.1 g', { value: '31.1', unit: 'g' }],
      ['Gold Eagle 2024 1 oz (1 oz)', { value: '1', unit: 'oz' }],
    ];
    for (const [title, weight] of exact) assert.deepEqual(match(title)?.statedWeight, weight, title);
    // A mixed number's whole part has three digits at most, so a year is never one (v2).
    assert.deepEqual(match('Gold Bar 2024 \u00bd oz')?.statedWeight, { value: '1/2', unit: 'oz' }, 'the year 2024, then \u00bd');
    assert.deepEqual(match('Gold Bar 999 \u00bd oz')?.statedWeight, { value: '999 1/2', unit: 'oz' });
    noExactWeight(['Gold Bar 1000 \u00bd g', 'Gold Bar 2024 2025 \u00bd oz', 'Gold Bar 12024 \u00bd oz', 'Gold Bar 02024 \u00bd oz']);
    // Root's list, before and after the shape word.
    const roots = ['2 2024 1 oz', '2024 2025 1 oz', '2024 to 2025 1 oz', '12024 1 oz', '2024-1 oz', '2024  1 oz'];
    noExactWeight([...roots.map((text) => `Gold Bar ${text}`), ...roots.map((text) => `${text} Gold Bar`)]);
    noExactWeight([
      'Gold Bar 1899 1 oz', 'Gold Bar 2100 1 oz', 'Gold Bar 0024 1 oz', 'Gold Bar 202 1 oz', 'Gold Bar 20245 1 oz',
      'Gold Bar \u0662\u0660\u0662\u0664 1 oz', 'Gold Bar \uff12\uff10\uff12\uff14 1 oz', 'Gold Bar \u00b22024 1 oz',
      'Gold Bar 2024\u00b2 1 oz', 'Gold Bar 2024\u00a01 oz', 'Gold Bar 2024 - 1 oz', 'Gold Bar 2024, 1 oz', 'Gold Bar 2024 (1 oz)',
      'Gold Bar 2024 x 1 oz', 'Gold Bar, 2024 1 oz', 'Gold Bar - 2024 1 oz', 'Gold Bar x 2024 1 oz', 'Gold Bar TO 2024 1 oz',
      'Gold Bar  2024 1 oz', 'Gold Bar ( 2024 1 oz)', 'Gold Bar "2024 1 oz"', 'Gold Bar 24K 2024 1 oz', 'Gold Bar \u0445 2024 1 oz',
      'Gold Bar\u200b 2024 1 oz', 'Gold Bar 2024\u200b 1 oz', 'Gold Bar 2024\u0301 1 oz', 'Gold Bar 2 x (2024 1 oz)',
      'Gold Bar 1 - (2024 1 oz)',
    ]);
  });

  it('reads a unit as exact only when the end, white space or a letter follows it, closing marks aside', () => {
    for (const title of [
      'Gold Bar 1 oz', 'Gold Bar (1 oz)', 'Gold Bar [1 oz]', 'Gold Bar 1 oz, PAMP', 'Gold Bar 1 oz.', 'Gold Bar 1 oz...',
      'Gold Bar 1 oz\u2122', 'Gold Bar 1 oz\u00ae Fine', 'Gold Bar "1 oz"', 'Gold Bar 1 oz(New)', 'Gold Bar 1 oz;PAMP',
    ]) {
      assert.deepEqual(match(title)?.statedWeight, { value: '1', unit: 'oz' }, title);
    }
    noExactWeight([
      'Gold Bar 1 oz+', 'Gold Bar 1 oz\u00b1', 'Gold Bar 1 oz/2', 'Gold Bar 1 oz.5', 'Gold Bar 1 oz-2', 'Gold Bar 1 oz-PAMP',
      'Gold Bar 1 oz~', 'Gold Bar 1 oz*', 'Gold Bar 1 oz(2 g)', 'Gold Bar 1 oz\u200b', 'Gold Bar 1 oz\ufeff', 'Gold Bar 1 oz\u0301',
      'Gold Bar 1 oz\u2122\u00b9', 'Gold Bar 1 oz)2',
    ]);
  });

  it('closes the unit-side false exacts found at 0be157df: a Kelvin-sign unit, a hidden troy t, a number across an invisible character', () => {
    noExactWeight([
      'Gold Bar 1 \u212ag',
      'Gold Bar 1 \u212ailogram',
      'Gold Bar 1 ounce\u017f',
      'Gold Bar 1 oz\u200bt',
      'Gold Bar 1 oz\u00adt',
      'Gold Bar 1\u200b 4 oz',
      'Gold Bar 1\u0301 4 oz',
      'Gold Bar 1\u200boz',
      'Gold Bar\ufeff1 oz',
      'Gold Bar 1 troy\u00a0oz',
    ]);
  });

  it('reads exact weights by a strict grammar only; any other form leaves the weight unknown, never a repair or a tail', () => {
    const allowed: Array<[string, { value: string; unit: string }]> = [
      ['Gold Bar \u00bd oz', { value: '1/2', unit: 'oz' }],
      ['Gold Bar \u00bc oz', { value: '1/4', unit: 'oz' }],
      ['Gold Bar \u00be oz', { value: '3/4', unit: 'oz' }],
      ['Gold Coin \u2152 oz', { value: '1/10', unit: 'oz' }],
      ['Gold Bar 1 \u00bd oz', { value: '1 1/2', unit: 'oz' }],
      ['Gold Bar 2 \u00bd oz', { value: '2 1/2', unit: 'oz' }],
      ['Gold Bar 1/2 oz', { value: '1/2', unit: 'oz' }],
      ['Gold Bar - \u00bd oz', { value: '1/2', unit: 'oz' }],
      ['Gold Bar (\u00bd oz)', { value: '1/2', unit: 'oz' }],
      ['\u00bd oz Gold Bar', { value: '1/2', unit: 'oz' }],
      ['Gold Bar - 1 oz', { value: '1', unit: 'oz' }],
      ['Gold Bar (1 oz)', { value: '1', unit: 'oz' }],
      ['Gold Bar: 1 oz', { value: '1', unit: 'oz' }],
      ['Gold Bar 1 \u00bdoz', { value: '1 1/2', unit: 'oz' }],
    ];
    for (const [title, weight] of allowed) assert.deepEqual(match(title)?.statedWeight, weight, title);
    for (const title of [
      'Gold Bar 1 1/2 oz',
      'Gold Bar 1\u00bd oz',
      'Gold Bar 1  \u00bd oz',
      'Gold Bar \u00b9\u00bd oz',
      'Gold Bar \uff11\u00bd oz',
      'Gold Bar \u0661\u00bd oz',
      'Gold Bar \u2160\u00bd oz',
      'Gold Bar \u0661 \u00bd oz',
      'Gold Bar \u2153 oz',
      'Gold Bar 1 \u2153 oz',
      'Gold Bar 1\u20444 oz',
      'Gold Bar \uff08\u00bd oz\uff09',
      'Gold Bar -\u00bd oz',
      'Gold Bar X\u00bd oz',
      'Gold Bar \u2212\u00bd oz',
      'Gold Bar \uff0d\u00bd oz',
      'Gold Bar \u00b1\u00bd oz',
      'Gold Bar -1 oz',
      'Gold Bar +1 oz',
      'Gold Bar 1e3 oz',
      'Gold Bar 1E3oz',
      'Gold Bar X1 oz',
      'Gold Bar 2 1 oz',
      'Gold Bar 1,000 g',
      'Gold Bar 1 oz/31.1 g',
      'Gold Bar .5 oz',
      'Gold Bar 0 oz',
      'Gold Bar 1 oz2',
      'Gold Bar \uff11 oz',
    ]) {
      const evidence = match(title);
      assert.equal(evidence?.form, 'bar', `${title}: still a gold bar, never dropped from the metal evidence`);
      assert.equal(evidence?.statedWeight, null, title);
      assert.deepEqual(retailStatedWeights(title), [], title);
    }
    assert.equal(match('Gold Bar \uff11\uff4f\uff5a')?.form, 'bar', 'a fullwidth weight still states one, though never exactly');
    assert.equal(match('Gold Bar \uff11\uff4f\uff5a')?.statedWeight, null);
    assert.equal(match('Gold Coin -1'), null, 'a shape word still needs something that reads as a weight');
  });

  it('is deterministic and reads unit words in any case, but weights only as written', () => {
    assert.deepEqual(match('1 OZ GOLD BAR'), match('1 oz gold bar'));
    assert.deepEqual(match('1 oz Gold Bar'), match('1 oz   Gold   Bar'));
    assert.equal(match('1  oz Gold Bar')?.statedWeight, null, 'two spaces before the unit are outside the grammar');
    assert.equal(match('1  oz Gold Bar')?.form, 'bar');
    assert.equal(match(''), null);
  });
});

describe('RETAIL_METAL_TITLE_RULE v3: an assay card is no near-miss', () => {
  // G1b's two Walmart shapes, in synthetic words (written from f77a116f's masked skeletons). v2 refused both on CARD.
  const CASE_A = '1 oz Gold Bar - Sample Testname Example/ Assay Card';
  const CASE_B = '1 oz Gold Bar - Sample Testname (Example/Assay Card)';
  const BAR_1_OZ = { metal: 'XAU', form: 'bar', statedWeight: { value: '1', unit: 'oz' }, rule: 'title-rule-v3' };

  it('reads a bar sold in an assay card as the bar it is', () => {
    assert.deepEqual(match(CASE_A), BAR_1_OZ);
    assert.deepEqual(match(CASE_B), BAR_1_OZ);
    assert.deepEqual(match(CASE_A.toUpperCase()), BAR_1_OZ, 'in any case');
    assert.deepEqual(match('1 oz Gold Bar in Assay Cards'), BAR_1_OZ, 'CARDS too');
    assert.deepEqual(match('1 oz Gold Bar in Assay-Card'), BAR_1_OZ, 'punctuation is no word');
    assert.deepEqual(match('1 oz Gold Bar in Assay/Card'), BAR_1_OZ);
    assert.deepEqual(match('1 oz Gold Bar (in Assay Card).'), BAR_1_OZ, 'CARD is still the last word');
    assert.equal(match('Gold Maple Leaf 1 oz Assay Card')?.form, 'coin', 'a coin design is a bullion form apart from ASSAY');
    assert.equal(match('Gold Bullion Assay Card')?.form, 'bullion', 'so is another bullion word');
  });

  it('exempts only CARD or CARDS right after ASSAY, as the last word, beside a bullion form apart from ASSAY', () => {
    // (i) right after ASSAY
    assert.equal(match('1 oz Gold Bar Gift Card'), null);
    assert.equal(retailMetalTitleGuard('1 oz Gold Bar Gift Card', { assessed: true }).clause, 'near-miss/shape-with-weight', 'the guard flags it');
    assert.equal(match('1 oz Gold Bar Card Assay'), null);
    // (ii) the last word: an accessory names something after the card
    assert.equal(match('Assay Card Holder for 1 oz Gold Bars'), null);
    assert.equal(match('1 oz Gold Bar in Assay Card (Sealed)'), null);
    // (iii) a bullion form apart from ASSAY: ASSAY alone proves nothing of its own
    assert.equal(match('Gold Assay Card'), null);
    assert.equal(retailMetalTitleGuard('Gold Assay Card', { assessed: true }).clause, 'near-miss/bullion-word', 'the guard flags it');
    assert.equal(match('Gold Bar Assay Card'), null, 'a shape word with no weight is no bullion form');
    // Root's required control (G1b): an accessory reads as no metal
    assert.equal(match('Gold Assay Card Holder'), null);
    // CARD or CARDS only, and only that word: any other near-miss word still refuses the title
    assert.equal(match('1 oz Gold Bar Assay Star'), null);
    assert.equal(match('1 oz Gold Plated Bar in Assay Card'), null);
  });

  it('keeps ruling (b)\'s fail-safe: a bar word beside a coin word gives no form, in an assay card too', () => {
    const NO_FORM = { metal: 'XAU', form: null, statedWeight: { value: '1', unit: 'oz' }, rule: 'title-rule-v3' };
    assert.deepEqual(match('1 oz Gold Britannia Bar'), NO_FORM);
    assert.deepEqual(match('1 oz Gold Britannia Bar in Assay Card'), NO_FORM);
  });
});

describe('RETAIL_METAL_GUARD v1: a line naming a metal with bullion evidence is never silently no metal', () => {
  const guard = (title: string, assessed = true) => retailMetalTitleGuard(title, { assessed });
  function flagged(title: string, clause: string, evidence: readonly string[], assessed = true): void {
    const reading = guard(title, assessed);
    assert.equal(reading.uncertain, true, title);
    assert.equal(reading.clause, clause, title);
    assert.deepEqual(reading.evidence, evidence, title);
  }

  it('is version 1, with closed lists: the evidence in its order, the refusals, 30 clauses and the shape words', () => {
    assert.equal(RETAIL_METAL_GUARD, 'metal-guard-v1');
    assert.deepEqual(RETAIL_METAL_GUARD_EVIDENCE,
      ['bullion-word', 'design-after-metal', 'shape-with-weight', 'troy-or-metric-weight', 'purity', 'adjacency']);
    assert.deepEqual(RETAIL_METAL_GUARD_REFUSALS, ['not-assessed', 'no-metal-word', 'near-miss', 'shape-without-weight', 'no-bullion-form']);
    assert.deepEqual(RETAIL_METAL_GUARD_CLAUSES,
      RETAIL_METAL_GUARD_REFUSALS.flatMap((refusal) => RETAIL_METAL_GUARD_EVIDENCE.map((evidence) => `${refusal}/${evidence}`)));
    assert.equal(new Set(RETAIL_METAL_GUARD_CLAUSES).size, 30);
    assert.deepEqual([...RETAIL_METAL_GUARD_SHAPE_WORDS].sort(),
      ['BAR', 'BARS', 'BRITANNIA', 'COIN', 'COINS', 'INGOT', 'INGOTS', 'KRUGERRAND', 'PHILHARMONIC', 'ROUND', 'ROUNDS']);
  });

  it('holds the pack rule\'s purity lists as its own, equal to them today (metals-pack-v2)', () => {
    assert.deepEqual([...RETAIL_METAL_GUARD_KARAT_WORDS].sort(), [...RETAIL_PACK_KARAT_WORDS].sort());
    assert.deepEqual([...RETAIL_METAL_GUARD_FINENESS_WORDS].sort(), [...RETAIL_PACK_FINENESS_WORDS].sort());
    assert.deepEqual([...RETAIL_METAL_GUARD_FINENESS_SHAPES].sort(), [...RETAIL_PACK_FINENESS_SHAPES].sort());
  });

  it('flags each kind of bullion evidence on its own, so that no evidence clause goes unnoticed', () => {
    flagged('Gold Assay Card Holder', 'near-miss/bullion-word', ['bullion-word']);
    flagged('Gold Eagle Candy', 'near-miss/design-after-metal', ['design-after-metal']);
    flagged('Gold Chocolate Coin 1.5 oz', 'near-miss/shape-with-weight', ['shape-with-weight']);
    flagged('Gold Foil 1 ozt', 'near-miss/troy-or-metric-weight', ['troy-or-metric-weight']);
    flagged('Gold Plated Pendant 10 g', 'near-miss/troy-or-metric-weight', ['troy-or-metric-weight']);
    flagged('Silver Tone 1 kg', 'near-miss/troy-or-metric-weight', ['troy-or-metric-weight']);
    flagged('Gold Plated .9999 Fine', 'near-miss/purity', ['purity']);
    flagged('999 Fine Silver Polish', 'near-miss/purity', ['purity']);
    flagged('24K Gold Plated Card', 'near-miss/purity', ['purity']);
    flagged('Gold Bar Candy', 'near-miss/adjacency', ['adjacency']);
    flagged('Bar Gold Candy', 'near-miss/adjacency', ['adjacency']);
    flagged('Gold Ingots Chocolate', 'near-miss/adjacency', ['adjacency']);
  });

  it('flags only a line that is no metal, names a metal as a whole word and shows evidence', () => {
    assert.deepEqual(guard('1 oz Gold Bar'),
      { uncertain: false, clause: null, evidence: ['shape-with-weight', 'adjacency'], metalWord: true, metal: 'XAU' }, 'the rule reads it as metal');
    assert.deepEqual(guard('.9999 Fine 1 oz Bar'),
      { uncertain: false, clause: null, evidence: ['shape-with-weight', 'purity'], metalWord: false, metal: null }, 'no metal word');
    assert.deepEqual(guard('Gold Star Membership'),
      { uncertain: false, clause: null, evidence: [], metalWord: true, metal: 'XAU' }, 'a metal word with no evidence: counted, not flagged');
    assert.deepEqual(guard(''), { uncertain: false, clause: null, evidence: [], metalWord: false, metal: null });
    // Purity only in its closed shapes: a karat is 8 to 24, and a fineness has a point or a fineness word after it.
    assert.deepEqual(guard('Silver Tone 2K Watch').evidence, [], 'no karat below 8');
    assert.deepEqual(guard('Silver Tone 25K Watch').evidence, [], 'no karat above 24');
    assert.deepEqual(guard('999 Silver Polish').evidence, [], 'a whole number alone is no fineness');
    assert.deepEqual(guard('Gold Tone 1 oz Pendant').evidence, [], 'a bare oz is no troy or metric weight');
  });

  it('flags a line the rule never reads (a fee or fuel line) on the same evidence, as not-assessed', () => {
    flagged('1 oz Gold Bar Insurance', 'not-assessed/shape-with-weight', ['shape-with-weight', 'adjacency'], false);
    assert.equal(guard('Gold Star Membership Fee', false).uncertain, false);
    assert.equal(guard('Regular Unleaded', false).uncertain, false);
  });

  it('names what refused the line: the rule\'s own refusal, or an invisible character splitting the metal word for it', () => {
    flagged('Go\u200Bld Bar Candy', 'no-metal-word/adjacency', ['adjacency']);
    flagged('Gold Bar', 'shape-without-weight/adjacency', ['adjacency']);
    flagged('Gold Ingots', 'no-bullion-form/adjacency', ['adjacency']);
    flagged('Gold .9999 Fine', 'no-bullion-form/purity', ['purity']);
    flagged('Gold Leaf Bar 1 oz', 'near-miss/shape-with-weight', ['shape-with-weight']);
  });

  it('sees through width, punctuation and invisible characters, whether one splits a word or joins two', () => {
    for (const title of ['\uff27\uff2f\uff2c\uff24 \uff22\uff21\uff32 \uff23\uff21\uff2e\uff24\uff39', '\uff27\uff2f\uff2c\uff24\u3000\uff22\uff21\uff32 Candy',
      'Gold-Bar Candy', 'Gold/Bar Candy', 'Gold.Bar Candy', '(Gold)Bar Candy', 'Gold\u200BBar Candy', 'Gold\u00ADBar Candy', 'Gold \u200BBar Candy']) {
      flagged(title, 'near-miss/adjacency', ['adjacency']);
    }
    flagged('Gol\u00ADd Bar Candy', 'no-metal-word/adjacency', ['adjacency']);
    flagged('Go\u200Bld\u200BBar Candy', 'no-metal-word/adjacency', ['adjacency'], true);
    flagged('Gold 10 Bar Candy', 'near-miss/adjacency', ['adjacency']);
    assert.equal(guard('Gold X Bar Candy').evidence.includes('adjacency'), false, 'a word between them parts them');
    assert.equal(guard('Golden Bar Candy').metalWord, false, 'GOLDEN is no GOLD');
    flagged('\uff12\uff14\uff2b Gold Plated Card', 'near-miss/purity', ['purity']);
    flagged('Gold Foil 1\u200Bozt', 'near-miss/troy-or-metric-weight', ['troy-or-metric-weight']);
  });

  it('sees a word through any character that never shows, and through a sign normalization spells in letters', () => {
    // Default-ignorable code points that are no format character (\p{Cf}), and two that are.
    for (const never of ['\u034F', '\uFE0F', '\u180B', '\u3164', '\u115F', '\u17B4', '\u{E0100}', '\u00AD', '\u200B']) {
      flagged(`1 oz Go${never}ld Bar`, 'no-metal-word/shape-with-weight', ['shape-with-weight', 'adjacency']);
      flagged(`1 oz Gold B${never}ar Candy`, 'near-miss/shape-with-weight', ['shape-with-weight', 'adjacency']);
    }
    assert.equal(guard('1 oz Go\u034Fld Bar').metal, 'XAU');
    // Compatibility normalization spells TM and SM in letters, joined to the word: the title as written still parts them.
    flagged('1 oz Gold\u2122 Bar', 'no-metal-word/shape-with-weight', ['shape-with-weight', 'adjacency']);
    flagged('Silver\u2120 Round 1 oz', 'no-metal-word/shape-with-weight', ['shape-with-weight', 'adjacency']);
    assert.equal(guard('Silver\u2120 Round 1 oz').metal, 'XAG');
    // The guard's own purity and troy-or-metric readings drop them too.
    flagged('Gold Plated .99\u034F99 Fine', 'near-miss/purity', ['purity']);
    flagged('Gold Foil 1 oz\u034Ft', 'near-miss/troy-or-metric-weight', ['troy-or-metric-weight']);
    // So does its reading of a weight statement beside a shape word (9854b7c2, 11/09): a mark inside the unit, and a
    // Hangul filler (a letter to the rule's unit token) right before or after it.
    flagged('Gold Chocolate Coin 1.5 o\u034Fz', 'near-miss/shape-with-weight', ['shape-with-weight']);
    flagged('Gold Chocolate Coin 1.5 \u3164oz', 'near-miss/shape-with-weight', ['shape-with-weight']);
    flagged('Gold Chocolate Coin 1.5 oz\u3164', 'near-miss/shape-with-weight', ['shape-with-weight']);
    assert.equal(retailMetalTitleEvidence('1 o\u034Fz Gold Bar'), null, 'the rule still reads no weight there: its reading is unchanged');
  });

  it('reads the rule\'s design path as evidence, through any character that never shows: a coin design right after a metal word', () => {
    // c3decfa5, 11/09: each visible twin is metal by its design alone; split, it must be flagged, never silently no metal.
    flagged('1 oz Go\u200Bld Buffalo', 'no-metal-word/design-after-metal', ['design-after-metal']);
    flagged('1 oz Gold Buf\u00ADfalo', 'no-bullion-form/design-after-metal', ['design-after-metal']);
    flagged('Gold Ma\u034Fple Leaf', 'near-miss/design-after-metal', ['design-after-metal']);
    for (const twin of ['1 oz Gold Buffalo', 'Gold Maple Leaf']) assert.notEqual(retailMetalTitleEvidence(twin), null, twin);
    assert.deepEqual(guard('1 oz Gold Buffalo').evidence, ['design-after-metal'], 'the rule\'s design path is evidence on a metal line too');
    assert.deepEqual(guard('Gold 1 oz Buffalo').evidence, [], 'a word between them parts them, as for the rule');
    assert.equal(retailMetalTitleEvidence('Gold 1 oz Buffalo'), null);
    assert.deepEqual(guard('Buffalo Gold Candy').evidence, [], 'a design before the metal word is none, as for the rule');
  });

  it('carries the one metal the words name, or none when they name several', () => {
    assert.equal(guard('Gold Bar Candy').metal, 'XAU');
    assert.equal(guard('Silver Coin Purse 1 oz').metal, 'XAG');
    assert.equal(guard('Silver Coin Purse 1 oz').uncertain, true);
    const several = guard('Gold and Silver Bar Candy');
    assert.deepEqual([several.uncertain, several.metal], [true, null]);
    assert.equal(guard('Go\u200Bld Silver Bar Candy').metal, null, 'a metal only one reading sees still counts');
  });

  it('gives a clause only when uncertain: the refusal and the first evidence, from the closed list', () => {
    const titles = ['1 oz Gold Bar', 'Gold Bar', 'Gold Bar Candy', 'Gold Assay Card Holder', 'Gold Star Membership', 'KS ORGANIC EGGS',
      '24K Gold Plated Card', 'Gold Foil 1 ozt', 'Gold Chocolate Coin 1.5 oz', 'Go\u200Bld Bar Candy', '1 oz Gold Bar - Sample Testname Example/ Assay Card'];
    for (const title of titles) {
      for (const assessed of [true, false]) {
        const reading = guard(title, assessed);
        assert.deepEqual(reading.evidence, RETAIL_METAL_GUARD_EVIDENCE.filter((kind) => reading.evidence.includes(kind)), `${title}: in the closed order, once each`);
        if (assessed && match(title) !== null) assert.equal(reading.uncertain, false, `${title}: the rule reads it as metal`);
        assert.equal(reading.uncertain, reading.metalWord && reading.evidence.length > 0 && (!assessed || match(title) === null), title);
        if (!reading.uncertain) {
          assert.equal(reading.clause, null, title);
          continue;
        }
        assert.ok(RETAIL_METAL_GUARD_CLAUSES.includes(reading.clause!), title);
        assert.equal(reading.clause!.split('/')[1], reading.evidence[0], title);
        assert.equal(reading.clause!.startsWith('not-assessed/'), !assessed, title);
      }
    }
  });
});
