import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AMAZON_ITEM_TAXONOMY,
  AMAZON_ITEM_TAXONOMY_VERSION,
  AMAZON_TAXONOMY_CARD_CATEGORIES,
  AMAZON_TAXONOMY_GROCERIES,
  AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE,
  AMAZON_TAXONOMY_NEEDS_REVIEW,
  AMAZON_TAXONOMY_NODES,
  AMAZON_TAXONOMY_SUGGESTED_BELOW,
  AMAZON_TAXONOMY_TOP_IDS,
  amazonTaxonomyNode,
  amazonTaxonomyPath,
  amazonTaxonomyTop,
  isAmazonTaxonomyNode,
  isAmazonTaxonomyTop,
  isSuggestedAmazonTaxonomy,
} from './amazonTaxonomy.js';

/** Root's v1 nodes: a later version may add to them, never rename or remove one. */
const ROOT_V1: ReadonlyArray<[string, readonly string[]]> = [
  ['Groceries', ['Meat & Seafood', 'Dairy & Eggs', 'Produce', 'Bakery & Bread', 'Snacks & Sweets', 'Beverages',
    'Pantry & Cooking', 'Frozen', 'Prepared Meals']],
  ['Household Supplies', ['Cleaning', 'Paper & Disposables', 'Laundry', 'Storage & Organization']],
  ['Health & Pharmacy', ['Medicine & OTC', 'Vitamins & Supplements', 'Medical Supplies & Devices']],
  ['Personal Care & Beauty', []],
  ['Baby & Kids', []],
  ['Pet Supplies', []],
  ['Home & Kitchen', ['Kitchen & Dining', 'Small Appliances', 'Furniture & Decor', 'Bedding & Bath', 'Water & Air Treatment']],
  ['Tools & Home Improvement', ['Tools', 'Hardware & Electrical', 'Plumbing']],
  ['Electronics', ['Computers & Components', 'Computer Accessories', 'Networking', 'Phones & Tablets', 'Audio & Video',
    'Smart Home', 'Cables, Chargers & Batteries']],
  ['Toys, Hobbies & RC', []],
  ['Sports & Outdoors', []],
  ['Clothing, Shoes & Accessories', []],
  ['Books, Media & Software', []],
  ['Office & School', []],
  ['Automotive', []],
  ['Garden & Patio', []],
  ['Gift Cards & Digital', []],
  ['Needs review', []],
];
/** Root wrote "Cables Chargers & Batteries"; the label only adds the comma. */
const sameName = (a: string, b: string) => a.replace(/,/g, '') === b.replace(/,/g, '');

describe('Amazon item taxonomy', () => {
  it('keeps every one of Root\'s v1 nodes, in Root\'s order, under its top level', () => {
    assert.equal(AMAZON_ITEM_TAXONOMY_VERSION, 1);
    assert.deepEqual(AMAZON_ITEM_TAXONOMY.map((top) => top.label), ROOT_V1.map(([label]) => label));
    for (const [label, children] of ROOT_V1) {
      const top = AMAZON_ITEM_TAXONOMY.find((entry) => entry.label === label)!;
      const labels = top.children.map((child) => child.label as string);
      // Root's subcategories first, in Root's order; added ones only after them.
      assert.equal(labels.length >= children.length, true, label);
      children.forEach((child, index) => assert.equal(sameName(labels[index], child), true, `${label} › ${child}`));
    }
  });

  it('has the stable ids Fresh and the import name, each unique and well-formed', () => {
    const ids = AMAZON_TAXONOMY_NODES.map((node) => node.id as string);
    assert.equal(new Set(ids).size, ids.length);
    for (const node of AMAZON_TAXONOMY_NODES) {
      assert.match(node.id, node.parent === null ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/ : /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
      if (node.parent !== null) assert.equal(node.id.startsWith(`${node.parent}/`), true, node.id);
      assert.equal(node.label.trim(), node.label);
      assert.notEqual(node.label, '');
    }
    assert.equal(AMAZON_TAXONOMY_NEEDS_REVIEW, 'needs-review');
    assert.equal(AMAZON_TAXONOMY_GROCERIES, 'groceries');
    assert.deepEqual(amazonTaxonomyNode(AMAZON_TAXONOMY_GROCERIES)?.children, [
      'groceries/meat-seafood', 'groceries/dairy-eggs', 'groceries/produce', 'groceries/bakery-bread', 'groceries/snacks-sweets',
      'groceries/beverages', 'groceries/pantry-cooking', 'groceries/frozen', 'groceries/prepared-meals',
    ]);
    assert.equal(AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE, 0.6);
    assert.equal(AMAZON_TAXONOMY_SUGGESTED_BELOW, 0.8);
    assert.equal(isSuggestedAmazonTaxonomy('agent', 0.6), true);
    assert.equal(isSuggestedAmazonTaxonomy('agent', 0.79), true);
    assert.equal(isSuggestedAmazonTaxonomy('agent', 0.8), false);
    assert.equal(isSuggestedAmazonTaxonomy('agent', 0.59), false);
    assert.equal(isSuggestedAmazonTaxonomy('owner', 0.7), false);
    assert.equal(isSuggestedAmazonTaxonomy(null, null), false);
    // Needs review is never suggested, even when an agent itself put an item there with middling confidence.
    for (const confidence of [0.59, 0.6, 0.7, 0.799, 0.8]) {
      assert.equal(isSuggestedAmazonTaxonomy('agent', confidence, 'needs-review'), false, String(confidence));
    }
    assert.equal(isSuggestedAmazonTaxonomy('agent', 0.7, 'groceries'), true);
  });

  it('lists each top level followed by its subcategories, and links them both ways', () => {
    assert.deepEqual([...AMAZON_TAXONOMY_TOP_IDS], AMAZON_TAXONOMY_NODES.filter((node) => node.parent === null).map((node) => node.id));
    let top: string | null = null;
    for (const node of AMAZON_TAXONOMY_NODES) {
      if (node.parent === null) top = node.id;
      else {
        assert.equal(node.parent, top, node.id);
        assert.deepEqual(node.children, []);
        assert.equal(amazonTaxonomyNode(node.parent)!.children.includes(node.id), true, node.id);
      }
    }
    assert.equal(Object.isFrozen(AMAZON_TAXONOMY_NODES), true);
    assert.equal(Object.isFrozen(AMAZON_TAXONOMY_NODES[0]), true);
  });

  it('maps every node to one card category, by Spending\'s issuer names, a subcategory inheriting its top level\'s', () => {
    for (const node of AMAZON_TAXONOMY_NODES) {
      assert.match(node.cardCategory, /^[A-Z][A-Za-z &]+-[A-Z][A-Za-z &]+$/, node.id);
      assert.equal(AMAZON_TAXONOMY_CARD_CATEGORIES.includes(node.cardCategory), true, node.id);
    }
    assert.deepEqual([...AMAZON_TAXONOMY_CARD_CATEGORIES], [...new Set(AMAZON_TAXONOMY_CARD_CATEGORIES)].sort());
    assert.equal(amazonTaxonomyNode('groceries/frozen')?.cardCategory, 'Merchandise & Supplies-Groceries');
    assert.equal(amazonTaxonomyNode('electronics/networking')?.cardCategory, 'Merchandise & Supplies-Computer Supplies');
    assert.equal(amazonTaxonomyNode('electronics/smart-home')?.cardCategory, 'Merchandise & Supplies-Electronics Stores');
    assert.equal(amazonTaxonomyNode('health/medicine-otc')?.cardCategory, 'Merchandise & Supplies-Pharmacies');
  });

  it('recognizes only its own ids, and names a node\'s top level and path', () => {
    for (const value of ['groceries', 'groceries/frozen', 'needs-review']) assert.equal(isAmazonTaxonomyNode(value), true, value);
    for (const value of ['Groceries', 'groceries/', 'groceries/unknown', 'frozen', ' groceries', '', null, undefined, 1, {}]) {
      assert.equal(isAmazonTaxonomyNode(value), false, String(value));
      assert.equal(amazonTaxonomyNode(value), undefined);
    }
    assert.equal(isAmazonTaxonomyTop('groceries'), true);
    assert.equal(isAmazonTaxonomyTop('groceries/frozen'), false);
    assert.equal(amazonTaxonomyTop('groceries/frozen'), 'groceries');
    assert.equal(amazonTaxonomyTop('needs-review'), 'needs-review');
    assert.deepEqual(amazonTaxonomyPath('groceries/meat-seafood'), ['Groceries', 'Meat & Seafood']);
    assert.deepEqual(amazonTaxonomyPath('automotive'), ['Automotive']);
    assert.throws(() => amazonTaxonomyPath('groceries/unknown' as never), RangeError);
    assert.throws(() => amazonTaxonomyTop('unknown' as never), RangeError);
  });
});
