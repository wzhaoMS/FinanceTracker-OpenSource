import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import * as names from './cardCategoryNames.js';
import { CARD_CATEGORY_NAMES } from './cardCategoryNames.js';
import { CARD_CATEGORY_RULES, CARD_CATEGORY_RULES_RETARGETED, CARD_TAX_CATEGORY as INFERENCE_TAX_CATEGORY } from './cardCategoryInference.js';
import { CARD_ASSET_CATEGORY } from './cardSpending.js';
import { ITEM_TAXONOMY_ASSET_NODE, ITEM_TAXONOMY_V1_VIEW, ITEM_TAXONOMY_V2_VIEW } from './itemTaxonomy.js';

/** Every category name, as recorded literals: the one source must hold exactly these. */
const RECORDED: ReadonlyArray<readonly [string, string]> = [
  ['CARD_CATEGORY_GROCERIES', 'Merchandise & Supplies-Groceries'],
  ['CARD_CATEGORY_WHOLESALE_STORES', 'Merchandise & Supplies-Wholesale Stores'],
  ['CARD_CATEGORY_PHARMACIES', 'Merchandise & Supplies-Pharmacies'],
  ['CARD_CATEGORY_FURNISHING', 'Merchandise & Supplies-Furnishing'],
  ['CARD_CATEGORY_HARDWARE_SUPPLIES', 'Merchandise & Supplies-Hardware Supplies'],
  ['CARD_CATEGORY_COMPUTER_SUPPLIES', 'Merchandise & Supplies-Computer Supplies'],
  ['CARD_CATEGORY_ELECTRONICS_STORES', 'Merchandise & Supplies-Electronics Stores'],
  ['CARD_CATEGORY_INTERNET_PURCHASE', 'Merchandise & Supplies-Internet Purchase'],
  ['CARD_CATEGORY_GENERAL_RETAIL', 'Merchandise & Supplies-General Retail'],
  ['CARD_CATEGORY_ARTS_JEWELRY', 'Merchandise & Supplies-Arts & Jewelry'],
  ['CARD_CATEGORY_BOOK_STORES', 'Merchandise & Supplies-Book Stores'],
  ['CARD_CATEGORY_CLOTHING_STORES', 'Merchandise & Supplies-Clothing Stores'],
  ['CARD_CATEGORY_SPORTING_GOODS_STORES', 'Merchandise & Supplies-Sporting Goods Stores'],
  ['CARD_CATEGORY_OFFICE_SUPPLIES', 'Business Services-Office Supplies'],
  ['CARD_CATEGORY_RESTAURANT', 'Restaurant-Restaurant'],
  ['CARD_CATEGORY_BAR_CAFE', 'Restaurant-Bar & Caf\u00e9'],
  ['CARD_CATEGORY_AUTO_SERVICES', 'Transportation-Auto Services'],
  ['CARD_CATEGORY_FUEL', 'Transportation-Fuel'],
  ['CARD_CATEGORY_TAXIS_COACH', 'Transportation-Taxis & Coach'],
  ['CARD_CATEGORY_PARKING_CHARGES', 'Transportation-Parking Charges'],
  ['CARD_CATEGORY_TOLLS_FEES', 'Transportation-Tolls & Fees'],
  ['CARD_CATEGORY_AIRLINE', 'Travel-Airline'],
  ['CARD_CATEGORY_LODGING', 'Travel-Lodging'],
  ['CARD_CATEGORY_VEHICLE_RENTAL', 'Travel-Vehicle Rental'],
  ['CARD_CATEGORY_TRAVEL_AGENCIES', 'Travel-Travel Agencies'],
  ['CARD_CATEGORY_FEES_ADJUSTMENTS', 'Fees & Adjustments-Fees & Adjustments'],
  ['CARD_TAX_CATEGORY', 'Taxes'],
];

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const parse = (fileName: string, text: string) => ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

interface Literal { text: string; property: string | null }
/** Every string literal and template text in a module, with the property it initializes, if any. */
function stringLiterals(fileName: string, text: string): Literal[] {
  const file = parse(fileName, text);
  const found: Literal[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const parent = node.parent;
      found.push({ text: node.text, property: ts.isPropertyAssignment(parent) && parent.initializer === node ? parent.name.getText(file) : null });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
/** Anything shaped like an issuer category name: `Top-Sub`, both capitalized. */
const ISSUER_SHAPE = /^\p{Lu}[^-]*-\p{Lu}/u;
/** A module's category literals: an issuer name, anything shaped like one, or any literal filed as a category. */
function categoryLiterals(fileName: string, text: string): Literal[] {
  return stringLiterals(fileName, text).filter(({ text: value, property }) => (CARD_CATEGORY_NAMES as readonly string[]).includes(value)
    || ISSUER_SHAPE.test(value) || property === 'cardCategory' || property === 'category');
}
/** Every module a source imports or re-exports, statically or dynamically. */
function dependencies(fileName: string, text: string): string[] {
  const file = parse(fileName, text);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) found.push(node.moduleSpecifier.getText(file));
    else if (ts.isImportEqualsDeclaration(node)) found.push(node.moduleReference.getText(file));
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) found.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('Card category names', () => {
  it('pins every name: its export, its value and its place', () => {
    const exported = Object.fromEntries(Object.entries(names).filter(([key]) => key !== 'CARD_CATEGORY_NAMES'));
    assert.deepEqual(exported, Object.fromEntries(RECORDED));
    assert.deepEqual(CARD_CATEGORY_NAMES, RECORDED.map(([, value]) => value));
    assert.equal(new Set(CARD_CATEGORY_NAMES).size, CARD_CATEGORY_NAMES.length);
    assert.equal(Object.isFrozen(CARD_CATEGORY_NAMES), true);
    assert.equal(names.CARD_CATEGORY_BAR_CAFE.normalize('NFC'), names.CARD_CATEGORY_BAR_CAFE);
    assert.equal((CARD_CATEGORY_NAMES as readonly string[]).includes(CARD_ASSET_CATEGORY), false);
  });

  it('holds exactly the names the item tree and the inference rules use', () => {
    const used = new Set([
      ...CARD_CATEGORY_RULES.map((rule) => rule.category),
      ...Object.values(CARD_CATEGORY_RULES_RETARGETED.categories),
      ...ITEM_TAXONOMY_V1_VIEW.cardCategories,
      ...ITEM_TAXONOMY_V2_VIEW.cardCategories.filter((category) => category !== CARD_ASSET_CATEGORY),
    ]);
    assert.deepEqual([...used].sort(), [...CARD_CATEGORY_NAMES].sort());
    assert.equal(ITEM_TAXONOMY_V2_VIEW.node(ITEM_TAXONOMY_ASSET_NODE)!.cardCategory, CARD_ASSET_CATEGORY);
    // Holdr's own tax category: the tax-payment rule's, and the inference rules export the names module's own.
    assert.equal(CARD_CATEGORY_RULES.find((rule) => rule.id === 'tax-payment')!.category, names.CARD_TAX_CATEGORY);
    assert.equal(INFERENCE_TAX_CATEGORY, names.CARD_TAX_CATEGORY);
  });

  it('is a leaf: it imports nothing', () => {
    // Control: the scan sees each form of dependency.
    assert.deepEqual(dependencies('control.ts', [
      "import { x } from './a.js';", "export { y } from './b.js';", "export * from './c.js';", "import z = require('d');",
      "const e = () => import('./e.js');", "const f = require('f');",
    ].join('\n')).length, 6);
    assert.deepEqual(dependencies('cardCategoryNames.ts', source('./cardCategoryNames.ts')), []);
  });

  it('leaves no category literal in the inference rules, the item tree or Amazon\'s taxonomy', () => {
    // Control: the scan finds a name, an escaped name, a new issuer-shaped name, Holdr's own tax category and the asset
    // category filed as a category.
    const control = [
      "const a = 'Merchandise & Supplies-Groceries';",
      "const b = { cardCategory: `Restaurant-Bar & Caf\\u00e9` };",
      "const c = 'Travel-Synthetic Lines';",
      "const d = { category: 'Precious metals' };",
      "export const e = 'Taxes';",
    ].join('\n');
    assert.deepEqual(categoryLiterals('control.ts', control).map((literal) => literal.text),
      ['Merchandise & Supplies-Groceries', 'Restaurant-Bar & Caf\u00e9', 'Travel-Synthetic Lines', 'Precious metals', 'Taxes']);
    for (const file of ['./cardCategoryInference.ts', './itemTaxonomy.ts', './amazonTaxonomy.ts']) {
      assert.deepEqual(categoryLiterals(file, source(file)), [], file);
    }
    // The asset category's text appears in the item tree only as the asset node's label.
    const asset = stringLiterals('itemTaxonomy.ts', source('./itemTaxonomy.ts')).filter((literal) => literal.text === CARD_ASSET_CATEGORY);
    assert.deepEqual(asset, [{ text: CARD_ASSET_CATEGORY, property: 'label' }]);
    for (const file of ['./cardCategoryInference.ts', './amazonTaxonomy.ts']) {
      assert.deepEqual(stringLiterals(file, source(file)).filter((literal) => literal.text === CARD_ASSET_CATEGORY), [], file);
    }
  });
});
