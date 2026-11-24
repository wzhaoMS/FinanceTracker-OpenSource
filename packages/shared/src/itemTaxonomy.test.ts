import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  AMAZON_ITEM_TAXONOMY,
  AMAZON_ITEM_TAXONOMY_VERSION,
  AMAZON_TAXONOMY_CARD_CATEGORIES,
  AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE,
  AMAZON_TAXONOMY_NEEDS_REVIEW,
  AMAZON_TAXONOMY_NODES,
  AMAZON_TAXONOMY_POLICY,
  AMAZON_TAXONOMY_SOURCES,
  AMAZON_TAXONOMY_SUGGESTED_BELOW,
  AMAZON_TAXONOMY_TOP_IDS,
  amazonTaxonomyNode,
  amazonTaxonomyPath,
  amazonTaxonomyTop,
  isAmazonTaxonomyNode,
  isAmazonTaxonomyTop,
  type AmazonTaxonomyNodeId,
  type AmazonTaxonomyTopId,
} from './amazonTaxonomy.js';
import { CARD_CATEGORY_NAMES } from './cardCategoryNames.js';
import { CARD_ASSET_CATEGORY } from './cardSpending.js';
import {
  ITEM_TAXONOMY_ASSET_NODE,
  ITEM_TAXONOMY_BP_POLICY,
  ITEM_TAXONOMY_BP_SCALE,
  ITEM_TAXONOMY_MIN_AGENT_BP,
  ITEM_TAXONOMY_RESIDUAL,
  ITEM_TAXONOMY_SOURCES,
  ITEM_TAXONOMY_SUGGESTED_BELOW_BP,
  ITEM_TAXONOMY_V1,
  ITEM_TAXONOMY_V1_VIEW,
  ITEM_TAXONOMY_V2,
  ITEM_TAXONOMY_V2_ADDITIONS,
  ITEM_TAXONOMY_V2_DIGEST,
  ITEM_TAXONOMY_V2_DIGEST_INPUT,
  ITEM_TAXONOMY_V2_VIEW,
  ITEM_TAXONOMY_VERSION_V1,
  ITEM_TAXONOMY_VERSION_V2,
  isSuggestedItemTaxonomy,
  itemTaxonomyCategoriesMissing,
  itemTaxonomyDigest,
  itemTaxonomyView,
  resolveItemTaxonomy,
  spliceItemTaxonomy,
  type ItemTaxonomyAddition,
  type ItemTaxonomyDigestInput,
  type ItemTaxonomyNode,
  type ItemTaxonomyTopDeclaration,
  type ItemTaxonomyV2NodeId,
  type ItemTaxonomyV2TopId,
  type ItemTaxonomyView,
} from './itemTaxonomy.js';

// The card categories as recorded literals (never the shared constants), so a changed name fails the pins below.
const GROCERIES = 'Merchandise & Supplies-Groceries';
const PHARMACIES = 'Merchandise & Supplies-Pharmacies';
const FURNISHING = 'Merchandise & Supplies-Furnishing';
const HARDWARE = 'Merchandise & Supplies-Hardware Supplies';
const COMPUTER = 'Merchandise & Supplies-Computer Supplies';
const ELECTRONICS = 'Merchandise & Supplies-Electronics Stores';
const INTERNET = 'Merchandise & Supplies-Internet Purchase';
const GENERAL = 'Merchandise & Supplies-General Retail';
const ARTS = 'Merchandise & Supplies-Arts & Jewelry';
const OFFICE = 'Business Services-Office Supplies';
const BOOKS = 'Merchandise & Supplies-Book Stores';
const CLOTHING = 'Merchandise & Supplies-Clothing Stores';
const SPORTING = 'Merchandise & Supplies-Sporting Goods Stores';
const AUTO = 'Transportation-Auto Services';

/** v1 as main declared it (amazonTaxonomy.ts at a799778f): every node's id, label, parent and card category, in order. */
const RECORDED_V1 = [
  ['groceries', 'Groceries', null, GROCERIES],
  ['groceries/meat-seafood', 'Meat & Seafood', 'groceries', GROCERIES],
  ['groceries/dairy-eggs', 'Dairy & Eggs', 'groceries', GROCERIES],
  ['groceries/produce', 'Produce', 'groceries', GROCERIES],
  ['groceries/bakery-bread', 'Bakery & Bread', 'groceries', GROCERIES],
  ['groceries/snacks-sweets', 'Snacks & Sweets', 'groceries', GROCERIES],
  ['groceries/beverages', 'Beverages', 'groceries', GROCERIES],
  ['groceries/pantry-cooking', 'Pantry & Cooking', 'groceries', GROCERIES],
  ['groceries/frozen', 'Frozen', 'groceries', GROCERIES],
  ['groceries/prepared-meals', 'Prepared Meals', 'groceries', GROCERIES],
  ['household', 'Household Supplies', null, GENERAL],
  ['household/cleaning', 'Cleaning', 'household', GENERAL],
  ['household/paper-disposables', 'Paper & Disposables', 'household', GENERAL],
  ['household/laundry', 'Laundry', 'household', GENERAL],
  ['household/storage-organization', 'Storage & Organization', 'household', FURNISHING],
  ['health', 'Health & Pharmacy', null, PHARMACIES],
  ['health/medicine-otc', 'Medicine & OTC', 'health', PHARMACIES],
  ['health/vitamins-supplements', 'Vitamins & Supplements', 'health', PHARMACIES],
  ['health/medical-supplies-devices', 'Medical Supplies & Devices', 'health', PHARMACIES],
  ['personal-care', 'Personal Care & Beauty', null, PHARMACIES],
  ['personal-care/oral-care', 'Oral Care', 'personal-care', PHARMACIES],
  ['personal-care/hair-care', 'Hair Care', 'personal-care', PHARMACIES],
  ['personal-care/skin-body', 'Skin & Body Care', 'personal-care', PHARMACIES],
  ['personal-care/shaving-grooming', 'Shaving & Grooming', 'personal-care', PHARMACIES],
  ['baby-kids', 'Baby & Kids', null, GENERAL],
  ['pet-supplies', 'Pet Supplies', null, GENERAL],
  ['pet-supplies/food-treats', 'Food & Treats', 'pet-supplies', GENERAL],
  ['pet-supplies/care-accessories', 'Care & Accessories', 'pet-supplies', GENERAL],
  ['home-kitchen', 'Home & Kitchen', null, FURNISHING],
  ['home-kitchen/kitchen-dining', 'Kitchen & Dining', 'home-kitchen', FURNISHING],
  ['home-kitchen/small-appliances', 'Small Appliances', 'home-kitchen', ELECTRONICS],
  ['home-kitchen/furniture-decor', 'Furniture & Decor', 'home-kitchen', FURNISHING],
  ['home-kitchen/bedding-bath', 'Bedding & Bath', 'home-kitchen', FURNISHING],
  ['home-kitchen/water-air-treatment', 'Water & Air Treatment', 'home-kitchen', HARDWARE],
  ['tools-home-improvement', 'Tools & Home Improvement', null, HARDWARE],
  ['tools-home-improvement/tools', 'Tools', 'tools-home-improvement', HARDWARE],
  ['tools-home-improvement/hardware-electrical', 'Hardware & Electrical', 'tools-home-improvement', HARDWARE],
  ['tools-home-improvement/plumbing', 'Plumbing', 'tools-home-improvement', HARDWARE],
  ['electronics', 'Electronics', null, ELECTRONICS],
  ['electronics/computers-components', 'Computers & Components', 'electronics', COMPUTER],
  ['electronics/computer-accessories', 'Computer Accessories', 'electronics', COMPUTER],
  ['electronics/networking', 'Networking', 'electronics', COMPUTER],
  ['electronics/phones-tablets', 'Phones & Tablets', 'electronics', ELECTRONICS],
  ['electronics/audio-video', 'Audio & Video', 'electronics', ELECTRONICS],
  ['electronics/smart-home', 'Smart Home', 'electronics', ELECTRONICS],
  ['electronics/cables-chargers-batteries', 'Cables, Chargers & Batteries', 'electronics', ELECTRONICS],
  ['toys-hobbies', 'Toys, Hobbies & RC', null, GENERAL],
  ['toys-hobbies/toys-games', 'Toys & Games', 'toys-hobbies', GENERAL],
  ['toys-hobbies/rc-drones', 'RC & Drones', 'toys-hobbies', GENERAL],
  ['toys-hobbies/3d-printing', '3D Printing', 'toys-hobbies', GENERAL],
  ['toys-hobbies/arts-crafts', 'Arts & Crafts', 'toys-hobbies', ARTS],
  ['sports-outdoors', 'Sports & Outdoors', null, SPORTING],
  ['sports-outdoors/exercise-fitness', 'Exercise & Fitness', 'sports-outdoors', SPORTING],
  ['sports-outdoors/outdoor-recreation', 'Outdoor Recreation', 'sports-outdoors', SPORTING],
  ['clothing', 'Clothing, Shoes & Accessories', null, CLOTHING],
  ['clothing/clothing', 'Clothing', 'clothing', CLOTHING],
  ['clothing/shoes', 'Shoes', 'clothing', CLOTHING],
  ['clothing/bags-accessories', 'Bags & Accessories', 'clothing', CLOTHING],
  ['books-media', 'Books, Media & Software', null, BOOKS],
  ['books-media/books', 'Books', 'books-media', BOOKS],
  ['books-media/movies-music-games', 'Movies, Music & Games', 'books-media', ELECTRONICS],
  ['books-media/software', 'Software', 'books-media', COMPUTER],
  ['office-school', 'Office & School', null, OFFICE],
  ['office-school/office-supplies', 'Office Supplies', 'office-school', OFFICE],
  ['office-school/printers-ink-paper', 'Printers, Ink & Paper', 'office-school', OFFICE],
  ['automotive', 'Automotive', null, AUTO],
  ['garden-patio', 'Garden & Patio', null, HARDWARE],
  ['gift-cards-digital', 'Gift Cards & Digital', null, INTERNET],
  ['gift-cards-digital/gift-cards', 'Gift Cards', 'gift-cards-digital', INTERNET],
  ['gift-cards-digital/digital-content', 'Digital Content & Subscriptions', 'gift-cards-digital', INTERNET],
  ['needs-review', 'Needs review', null, INTERNET],
] as const;

/** Plan §3.2's table of v2's additions, in the plan's order. A missing `cardCategory` is the top level's. */
const RECORDED_ADDITIONS = [
  { id: 'automotive/fuel', label: 'Fuel', parent: 'automotive', cardCategory: 'Transportation-Fuel', position: { firstChildOf: 'automotive' } },
  { id: 'automotive/tires-service', label: 'Tires & Service', parent: 'automotive', cardCategory: AUTO, position: { after: 'automotive/fuel' } },
  { id: 'health/pharmacy', label: 'Prescriptions', parent: 'health', position: { lastChildOf: 'health' } },
  { id: 'health/optical', label: 'Optical', parent: 'health', position: { after: 'health/pharmacy' } },
  { id: 'dining', label: 'Food Court & Dining', parent: null, cardCategory: 'Restaurant-Restaurant', position: { after: 'groceries' } },
  {
    id: 'memberships-fees', label: 'Memberships & Fees', parent: null, cardCategory: 'Merchandise & Supplies-Wholesale Stores',
    position: { before: 'precious-metals' },
  },
  { id: 'precious-metals', label: 'Precious metals', parent: null, cardCategory: 'Precious metals', position: { before: 'needs-review' } },
] as const;

type RecordedV1Row = (typeof RECORDED_V1)[number];
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
// Compile-time pins (tsc checks them): Amazon's id unions are exactly the recorded ids, never widened.
const amazonNodeIdsPinned: Equal<AmazonTaxonomyNodeId, RecordedV1Row[0]> = true;
const amazonTopIdsPinned: Equal<AmazonTaxonomyTopId, Extract<RecordedV1Row, readonly [string, string, null, string]>[0]> = true;
const v2NodeIdsPinned: Equal<ItemTaxonomyV2NodeId, RecordedV1Row[0] | (typeof RECORDED_ADDITIONS)[number]['id']> = true;
const v2TopIdsPinned: Equal<ItemTaxonomyV2TopId, Extract<RecordedV1Row, readonly [string, string, null, string]>[0]
  | Extract<(typeof RECORDED_ADDITIONS)[number], { readonly parent: null }>['id']> = true;

type Fact = readonly [string, string, string | null, string];
const fact = (node: ItemTaxonomyNode): Fact => [node.id, node.label, node.parent, node.cardCategory];
const recordedFact = (id: string): Fact => {
  const v1 = RECORDED_V1.find((row) => row[0] === id);
  if (v1) return v1;
  const added = RECORDED_ADDITIONS.find((row) => row.id === id)!;
  const parentCategory = RECORDED_V1.find((row) => row[0] === added.parent)?.[3];
  return [added.id, added.label, added.parent, 'cardCategory' in added ? added.cardCategory : parentCategory!];
};
/** A v1 top level and its v1 subcategories, by the recorded list. */
const v1Group = (top: string) => RECORDED_V1.filter((row) => row[0] === top || row[2] === top).map((row) => row[0] as string);
/** v2's display order: v1's groups in v1's order, with each addition where §3.2 puts it. */
const V2_ORDER: readonly string[] = [
  ...v1Group('groceries'), 'dining', ...v1Group('household'), ...v1Group('health'), 'health/pharmacy', 'health/optical',
  ...v1Group('personal-care'), ...v1Group('baby-kids'), ...v1Group('pet-supplies'), ...v1Group('home-kitchen'),
  ...v1Group('tools-home-improvement'), ...v1Group('electronics'), ...v1Group('toys-hobbies'), ...v1Group('sports-outdoors'),
  ...v1Group('clothing'), ...v1Group('books-media'), ...v1Group('office-school'), ...v1Group('automotive'), 'automotive/fuel',
  'automotive/tires-service', ...v1Group('garden-patio'), ...v1Group('gift-cards-digital'), 'memberships-fees', 'precious-metals',
  ...v1Group('needs-review'),
];

/** The double just below a positive one, and just above it. */
const bits = (x: number, step: bigint) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigUint64(0, view.getBigUint64(0) + step);
  return view.getFloat64(0);
};
const below = (x: number) => bits(x, -1n);
const above = (x: number) => bits(x, 1n);

/** v1's id, parent and card-category rules, on a view of any version. */
function checkView<Id extends string, TopId extends Id>(name: string, view: ItemTaxonomyView<Id, TopId>,
  tree: readonly ItemTaxonomyTopDeclaration[]): void {
  let top: string | null = null;
  for (const node of view.nodes) {
    assert.match(node.id, node.parent === null ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/ : /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/,
      `${name} ${node.id}`);
    assert.equal(node.label.trim(), node.label);
    assert.notEqual(node.label, '');
    if (node.parent === null) top = node.id;
    else {
      assert.equal(node.parent, top, `${name} ${node.id}`);
      assert.equal(node.id.startsWith(`${node.parent}/`), true, `${name} ${node.id}`);
      assert.deepEqual(node.children, []);
      assert.equal(view.node(node.parent)!.children.includes(node.id), true, `${name} ${node.id}`);
    }
    assert.equal(Object.isFrozen(node), true);
    assert.equal(Object.isFrozen(node.children), true);
    const named = (CARD_CATEGORY_NAMES as readonly string[]).includes(node.cardCategory);
    assert.equal(named || (node.id === ITEM_TAXONOMY_ASSET_NODE && node.cardCategory === CARD_ASSET_CATEGORY), true, `${name} ${node.id}`);
  }
  // A subcategory without its own card category has its top level's.
  for (const declared of tree) {
    for (const child of declared.children) {
      assert.equal(view.node(child.id)!.cardCategory, child.cardCategory ?? declared.cardCategory, `${name} ${child.id}`);
    }
  }
  assert.deepEqual(view.topIds, view.nodes.filter((node) => node.parent === null).map((node) => node.id));
  assert.deepEqual(view.cardCategories, [...new Set(view.nodes.map((node) => node.cardCategory))].sort());
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.nodes), true);
  assert.equal(Object.isFrozen(view.topIds), true);
  assert.equal(Object.isFrozen(view.cardCategories), true);
}

describe('Shared item tree', () => {
  it('declares v1 as the recorded literal list, and Amazon\'s exports are the v1 view\'s own', () => {
    assert.equal(ITEM_TAXONOMY_VERSION_V1, 1);
    assert.equal(ITEM_TAXONOMY_VERSION_V2, 2);
    assert.deepEqual(ITEM_TAXONOMY_V1_VIEW.nodes.map(fact), RECORDED_V1);
    assert.deepEqual(ITEM_TAXONOMY_V1_VIEW.topIds, RECORDED_V1.filter((row) => row[2] === null).map((row) => row[0]));
    // One implementation: Amazon's names are the shared values and functions themselves, not copies.
    assert.equal(AMAZON_ITEM_TAXONOMY, ITEM_TAXONOMY_V1);
    assert.equal(AMAZON_ITEM_TAXONOMY_VERSION, ITEM_TAXONOMY_VERSION_V1);
    assert.equal(AMAZON_TAXONOMY_NODES, ITEM_TAXONOMY_V1_VIEW.nodes);
    assert.equal(AMAZON_TAXONOMY_TOP_IDS, ITEM_TAXONOMY_V1_VIEW.topIds);
    assert.equal(AMAZON_TAXONOMY_CARD_CATEGORIES, ITEM_TAXONOMY_V1_VIEW.cardCategories);
    assert.equal(isAmazonTaxonomyNode, ITEM_TAXONOMY_V1_VIEW.isNode);
    assert.equal(isAmazonTaxonomyTop, ITEM_TAXONOMY_V1_VIEW.isTop);
    assert.equal(amazonTaxonomyNode, ITEM_TAXONOMY_V1_VIEW.node);
    assert.equal(amazonTaxonomyTop, ITEM_TAXONOMY_V1_VIEW.top);
    assert.equal(amazonTaxonomyPath, ITEM_TAXONOMY_V1_VIEW.path);
    assert.equal(AMAZON_TAXONOMY_NEEDS_REVIEW, ITEM_TAXONOMY_RESIDUAL);
    assert.equal(AMAZON_TAXONOMY_SOURCES, ITEM_TAXONOMY_SOURCES);
    assert.deepEqual([amazonNodeIdsPinned, amazonTopIdsPinned, v2NodeIdsPinned, v2TopIdsPinned], [true, true, true, true]);
  });

  it('keeps every v2 node out of v1', () => {
    for (const { id } of RECORDED_ADDITIONS) {
      assert.equal(ITEM_TAXONOMY_V1_VIEW.isNode(id), false, id);
      assert.equal(isAmazonTaxonomyNode(id), false, id);
      assert.equal(ITEM_TAXONOMY_V2_VIEW.isNode(id), true, id);
    }
    assert.equal(ITEM_TAXONOMY_V1_VIEW.nodes.length, RECORDED_V1.length);
  });

  it('adds exactly §3.2\'s nodes to v2, each where its position puts it', () => {
    assert.deepEqual(new Map(ITEM_TAXONOMY_V2_ADDITIONS.map((addition) => [addition.id, addition] as const)),
      new Map(RECORDED_ADDITIONS.map((addition) => [addition.id, addition] as const)));
    assert.equal(ITEM_TAXONOMY_V2_ADDITIONS.length, RECORDED_ADDITIONS.length);
    assert.deepEqual(ITEM_TAXONOMY_V2_VIEW.nodes.map((node) => node.id), V2_ORDER);
    assert.deepEqual(ITEM_TAXONOMY_V2_VIEW.nodes.map(fact), V2_ORDER.map(recordedFact));
    const children = (top: string) => ITEM_TAXONOMY_V2_VIEW.node(top)!.children;
    assert.deepEqual(children('automotive'), ['automotive/fuel', 'automotive/tires-service']);
    assert.deepEqual(children('health'), ['health/medicine-otc', 'health/vitamins-supplements', 'health/medical-supplies-devices',
      'health/pharmacy', 'health/optical']);
    const tops = ITEM_TAXONOMY_V2_VIEW.topIds;
    assert.equal(tops[tops.indexOf('groceries') + 1], 'dining');
    assert.deepEqual(tops.slice(-3), ['memberships-fees', 'precious-metals', 'needs-review']);
  });

  it('keeps v1 a subsequence of v2, which declares no node twice', () => {
    const v2 = ITEM_TAXONOMY_V2_VIEW.nodes;
    assert.deepEqual(v2.filter((node) => ITEM_TAXONOMY_V1_VIEW.isNode(node.id)).map(fact), ITEM_TAXONOMY_V1_VIEW.nodes.map(fact));
    assert.deepEqual(v2.filter((node) => !ITEM_TAXONOMY_V1_VIEW.isNode(node.id)).map((node) => node.id).sort(),
      RECORDED_ADDITIONS.map((addition) => addition.id).sort());
    assert.equal(new Set(v2.map((node) => node.id)).size, v2.length);
    assert.equal(v2.length, RECORDED_V1.length + RECORDED_ADDITIONS.length);
    // The v1 declarations are v2's own: a subcategory v1 declared is the same object in both trees.
    const v1Child = ITEM_TAXONOMY_V1[0].children[0];
    assert.equal(ITEM_TAXONOMY_V2[0].children[0], v1Child);
  });

  it('follows the id, parent and card-category rules in both views', () => {
    checkView('v1', ITEM_TAXONOMY_V1_VIEW, ITEM_TAXONOMY_V1);
    checkView('v2', ITEM_TAXONOMY_V2_VIEW, ITEM_TAXONOMY_V2);
    assert.equal(ITEM_TAXONOMY_V2_VIEW.node('health/pharmacy')!.cardCategory, PHARMACIES);
    assert.equal(ITEM_TAXONOMY_V2_VIEW.node('automotive/tires-service')!.cardCategory, AUTO);
  });

  it('names the residual and the asset node', () => {
    assert.equal(ITEM_TAXONOMY_RESIDUAL, 'needs-review');
    assert.equal(ITEM_TAXONOMY_ASSET_NODE, 'precious-metals');
    for (const view of [ITEM_TAXONOMY_V1_VIEW, ITEM_TAXONOMY_V2_VIEW]) {
      assert.equal(view.isTop(ITEM_TAXONOMY_RESIDUAL), true);
      assert.equal(view.topIds.at(-1), ITEM_TAXONOMY_RESIDUAL);
      assert.equal(view.node(ITEM_TAXONOMY_RESIDUAL)!.cardCategory, INTERNET);
    }
    assert.equal(ITEM_TAXONOMY_V1_VIEW.isNode(ITEM_TAXONOMY_ASSET_NODE), false);
    assert.equal(ITEM_TAXONOMY_V2_VIEW.isTop(ITEM_TAXONOMY_ASSET_NODE), true);
    const asset = ITEM_TAXONOMY_V2_VIEW.node(ITEM_TAXONOMY_ASSET_NODE)!;
    assert.equal(asset.cardCategory, CARD_ASSET_CATEGORY);
    assert.equal(asset.cardCategory, 'Precious metals');
    assert.equal(asset.label, 'Precious metals');
    assert.deepEqual(asset.children, []);
  });

  it('holds the thresholds in basis points, and Amazon\'s floats are exactly 0.6 and 0.8', () => {
    assert.equal(ITEM_TAXONOMY_BP_SCALE, 10_000);
    assert.equal(ITEM_TAXONOMY_MIN_AGENT_BP, 6_000);
    assert.equal(ITEM_TAXONOMY_SUGGESTED_BELOW_BP, 8_000);
    assert.equal(Object.is(AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE, 0.6), true);
    assert.equal(Object.is(AMAZON_TAXONOMY_SUGGESTED_BELOW, 0.8), true);
    assert.equal(AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE === 0.6, true);
    assert.equal(AMAZON_TAXONOMY_SUGGESTED_BELOW === 0.8, true);
    assert.deepEqual(ITEM_TAXONOMY_BP_POLICY, { residual: 'needs-review', minAgent: 6_000, suggestedBelow: 8_000 });
    assert.deepEqual(AMAZON_TAXONOMY_POLICY, { residual: 'needs-review', minAgent: 0.6, suggestedBelow: 0.8 });
    assert.equal(Object.isFrozen(ITEM_TAXONOMY_BP_POLICY), true);
    assert.equal(Object.isFrozen(AMAZON_TAXONOMY_POLICY), true);
  });

  it('shares the sources, the owner first', () => {
    assert.deepEqual(ITEM_TAXONOMY_SOURCES, ['owner', 'agent']);
    assert.equal(Object.isFrozen(ITEM_TAXONOMY_SOURCES), true);
  });

  it('words a view\'s errors by its name', () => {
    assert.throws(() => ITEM_TAXONOMY_V1_VIEW.top('unknown' as never), { name: 'RangeError', message: 'unknown Amazon taxonomy node' });
    assert.throws(() => ITEM_TAXONOMY_V1_VIEW.path('unknown' as never), { name: 'RangeError', message: 'unknown Amazon taxonomy node' });
    assert.throws(() => ITEM_TAXONOMY_V2_VIEW.top('unknown' as never), { name: 'RangeError', message: 'unknown item taxonomy node' });
    assert.throws(() => ITEM_TAXONOMY_V2_VIEW.path('unknown' as never), { name: 'RangeError', message: 'unknown item taxonomy node' });
    assert.equal(ITEM_TAXONOMY_V2_VIEW.top('automotive/fuel'), 'automotive');
    assert.deepEqual(ITEM_TAXONOMY_V2_VIEW.path('health/optical'), ['Health & Pharmacy', 'Optical']);
    assert.deepEqual(ITEM_TAXONOMY_V2_VIEW.path('precious-metals'), ['Precious metals']);
    const twice = [{ id: 'a', label: 'A', cardCategory: 'K', children: [{ id: 'a', label: 'Again' }] }];
    assert.throws(() => itemTaxonomyView(twice, 'synthetic'), { name: 'RangeError', message: 'synthetic taxonomy node declared twice' });
  });
});

describe('Splicing additions into a tree', () => {
  const base: readonly ItemTaxonomyTopDeclaration[] = [
    { id: 'a', label: 'A', cardCategory: 'K', children: [{ id: 'a/x', label: 'X' }, { id: 'a/y', label: 'Y', cardCategory: 'L' }] },
    { id: 'b', label: 'B', cardCategory: 'K', children: [] },
  ];
  const ids = (tree: readonly ItemTaxonomyTopDeclaration[]) => tree.map((top) => [top.id, top.children.map((child) => child.id)]);
  const add = (addition: Partial<ItemTaxonomyAddition> & Pick<ItemTaxonomyAddition, 'id' | 'parent' | 'position'>) =>
    spliceItemTaxonomy(base, [{ label: 'New', ...addition }]);

  it('places each addition where its position says, and leaves the base as it was', () => {
    assert.deepEqual(ids(add({ id: 'a/w', parent: 'a', position: { firstChildOf: 'a' } })), [['a', ['a/w', 'a/x', 'a/y']], ['b', []]]);
    assert.deepEqual(ids(add({ id: 'a/w', parent: 'a', position: { lastChildOf: 'a' } })), [['a', ['a/x', 'a/y', 'a/w']], ['b', []]]);
    assert.deepEqual(ids(add({ id: 'a/w', parent: 'a', position: { after: 'a/x' } })), [['a', ['a/x', 'a/w', 'a/y']], ['b', []]]);
    assert.deepEqual(ids(add({ id: 'a/w', parent: 'a', position: { before: 'a/x' } })), [['a', ['a/w', 'a/x', 'a/y']], ['b', []]]);
    assert.deepEqual(ids(add({ id: 'b/w', parent: 'b', position: { firstChildOf: 'b' } })), [['a', ['a/x', 'a/y']], ['b', ['b/w']]]);
    assert.deepEqual(ids(add({ id: 'c', parent: null, cardCategory: 'M', position: { after: 'a' } })), [['a', ['a/x', 'a/y']], ['c', []], ['b', []]]);
    assert.deepEqual(ids(add({ id: 'c', parent: null, cardCategory: 'M', position: { before: 'a' } })), [['c', []], ['a', ['a/x', 'a/y']], ['b', []]]);
    // In order: a later addition may name an earlier one.
    assert.deepEqual(ids(spliceItemTaxonomy(base, [
      { id: 'c', label: 'C', parent: null, cardCategory: 'M', position: { before: 'b' } },
      { id: 'd', label: 'D', parent: null, cardCategory: 'M', position: { before: 'c' } },
      { id: 'c/z', label: 'Z', parent: 'c', position: { lastChildOf: 'c' } },
    ])), [['a', ['a/x', 'a/y']], ['d', []], ['c', ['c/z']], ['b', []]]);
    const spliced = add({ id: 'a/w', parent: 'a', cardCategory: 'N', position: { after: 'a/y' } });
    assert.deepEqual(spliced[0].children.at(-1), { id: 'a/w', label: 'New', cardCategory: 'N' });
    assert.deepEqual(add({ id: 'c', parent: null, cardCategory: 'M', position: { after: 'b' } }).at(-1),
      { id: 'c', label: 'New', cardCategory: 'M', children: [] });
    assert.equal(Object.isFrozen(spliced), true);
    assert.equal(Object.isFrozen(spliced[0]), true);
    assert.equal(Object.isFrozen(spliced[0].children), true);
    assert.deepEqual(ids(base), [['a', ['a/x', 'a/y']], ['b', []]]);
  });

  it('refuses a node declared twice, a position naming no sibling, and a position its node can\'t take', () => {
    const refused: Array<[string, Parameters<typeof add>[0], string]> = [
      ['a base id again', { id: 'a/x', parent: 'a', position: { lastChildOf: 'a' } }, 'item taxonomy node declared twice'],
      ['a top id again', { id: 'b', parent: null, cardCategory: 'M', position: { after: 'a' } }, 'item taxonomy node declared twice'],
      ['an unknown sibling', { id: 'a/w', parent: 'a', position: { after: 'a/nope' } }, 'item taxonomy position names no sibling'],
      ['a sibling under another top', { id: 'b/w', parent: 'b', position: { after: 'a/x' } }, 'item taxonomy position names no sibling'],
      ['a top beside a subcategory', { id: 'c', parent: null, cardCategory: 'M', position: { after: 'a/x' } },
        'item taxonomy position names no sibling'],
      ['an unknown parent', { id: 'z/w', parent: 'z', position: { lastChildOf: 'z' } }, 'item taxonomy position names no sibling'],
      ['a top without a card category', { id: 'c', parent: null, position: { after: 'a' } },
        'item taxonomy top level without a card category'],
      ['a top placed as a subcategory', { id: 'c', parent: null, cardCategory: 'M', position: { firstChildOf: 'a' } },
        'item taxonomy top level positioned as a subcategory'],
      ['first under another top', { id: 'a/w', parent: 'a', position: { firstChildOf: 'b' } },
        'item taxonomy subcategory positioned under another top level'],
      ['last under another top', { id: 'a/w', parent: 'a', position: { lastChildOf: 'b' } },
        'item taxonomy subcategory positioned under another top level'],
    ];
    for (const [what, addition, message] of refused) assert.throws(() => add(addition), { name: 'RangeError', message }, what);
    assert.throws(() => spliceItemTaxonomy(base, [
      { id: 'a/w', label: 'W', parent: 'a', position: { lastChildOf: 'a' } },
      { id: 'a/w', label: 'W', parent: 'a', position: { lastChildOf: 'a' } },
    ]), { name: 'RangeError', message: 'item taxonomy node declared twice' });
  });
});

describe('Shared resolver', () => {
  const resolve = (node: string, source: 'owner' | 'agent', confidence: number | null) =>
    resolveItemTaxonomy({ node, source, confidence }, ITEM_TAXONOMY_BP_POLICY);
  const counted = (node: string, source: 'owner' | 'agent', confidence: number | null, suggested: boolean) =>
    ({ node, source, confidence, suggested, suggestion: null });
  const residual = (suggestion: { node: string; confidence: number } | null) =>
    ({ node: 'needs-review', source: null, confidence: null, suggested: false, suggestion });

  it('resolves in basis points: the owner always, an agent from 6_000, suggested below 8_000, else the residual', () => {
    assert.deepEqual(resolveItemTaxonomy(undefined, ITEM_TAXONOMY_BP_POLICY), residual(null));
    for (const node of ['groceries/frozen', 'precious-metals']) {
      assert.deepEqual(resolve(node, 'owner', null), counted(node, 'owner', null, false), node);
      assert.deepEqual(resolve(node, 'agent', 0), residual({ node, confidence: 0 }), node);
      assert.deepEqual(resolve(node, 'agent', 5_999), residual({ node, confidence: 5_999 }), node);
      assert.deepEqual(resolve(node, 'agent', 6_000), counted(node, 'agent', 6_000, true), node);
      assert.deepEqual(resolve(node, 'agent', 7_999), counted(node, 'agent', 7_999, true), node);
      assert.deepEqual(resolve(node, 'agent', 8_000), counted(node, 'agent', 8_000, false), node);
      assert.deepEqual(resolve(node, 'agent', 10_000), counted(node, 'agent', 10_000, false), node);
    }
    // An explicit residual: the owner's is final; an agent's counts from 6_000, never suggested, and is no suggestion below.
    assert.deepEqual(resolve('needs-review', 'owner', null), counted('needs-review', 'owner', null, false));
    assert.deepEqual(resolve('needs-review', 'agent', 5_999), residual(null));
    for (const bp of [6_000, 7_999, 8_000, 10_000]) {
      assert.deepEqual(resolve('needs-review', 'agent', bp), counted('needs-review', 'agent', bp, false), String(bp));
    }
    // An agent's row without a confidence never counts and suggests nothing.
    assert.deepEqual(resolve('groceries', 'agent', null), residual(null));
    // The owner's confidence passes through untouched, whatever it is.
    assert.deepEqual(resolve('groceries', 'owner', 1), counted('groceries', 'owner', 1, false));
  });

  it('marks as suggested only an agent\'s node at or above the minimum and below the suggested bound', () => {
    const cases: Array<[Parameters<typeof isSuggestedItemTaxonomy>, boolean]> = [
      [[ITEM_TAXONOMY_BP_POLICY, 'agent', 5_999, 'groceries'], false],
      [[ITEM_TAXONOMY_BP_POLICY, 'agent', 6_000, 'groceries'], true],
      [[ITEM_TAXONOMY_BP_POLICY, 'agent', 7_999, 'groceries'], true],
      [[ITEM_TAXONOMY_BP_POLICY, 'agent', 8_000, 'groceries'], false],
      [[ITEM_TAXONOMY_BP_POLICY, 'agent', 7_000, undefined], true],
      [[ITEM_TAXONOMY_BP_POLICY, 'agent', 7_000, 'needs-review'], false],
      [[ITEM_TAXONOMY_BP_POLICY, 'agent', 7_000, 'precious-metals'], true],
      [[ITEM_TAXONOMY_BP_POLICY, 'owner', 7_000, 'groceries'], false],
      [[ITEM_TAXONOMY_BP_POLICY, null, 7_000, 'groceries'], false],
      [[ITEM_TAXONOMY_BP_POLICY, 'agent', null, 'groceries'], false],
      [[AMAZON_TAXONOMY_POLICY, 'agent', below(0.6), 'groceries'], false],
      [[AMAZON_TAXONOMY_POLICY, 'agent', 0.6, 'groceries'], true],
      [[AMAZON_TAXONOMY_POLICY, 'agent', below(0.8), 'groceries'], true],
      [[AMAZON_TAXONOMY_POLICY, 'agent', 0.8, 'groceries'], false],
    ];
    for (const [args, expected] of cases) assert.equal(isSuggestedItemTaxonomy(...args), expected, JSON.stringify(args.slice(1)));
  });

  it('resolves in Amazon\'s unit at the float boundaries, so no conversion crosses a threshold', () => {
    const amazon = (confidence: number) =>
      resolveItemTaxonomy({ node: 'groceries/frozen', source: 'agent', confidence }, AMAZON_TAXONOMY_POLICY);
    assert.deepEqual(amazon(below(0.6)), residual({ node: 'groceries/frozen', confidence: below(0.6) }));
    assert.deepEqual(amazon(0.6), counted('groceries/frozen', 'agent', 0.6, true));
    assert.deepEqual(amazon(above(0.6)), counted('groceries/frozen', 'agent', above(0.6), true));
    assert.deepEqual(amazon(below(0.8)), counted('groceries/frozen', 'agent', below(0.8), true));
    assert.deepEqual(amazon(0.8), counted('groceries/frozen', 'agent', 0.8, false));
    assert.deepEqual(amazon(1), counted('groceries/frozen', 'agent', 1, false));
  });
});

describe('Card categories missing', () => {
  it('lists the view\'s card categories a known set lacks, sorted, as Amazon\'s plan did', () => {
    const all = [...AMAZON_TAXONOMY_CARD_CATEGORIES];
    assert.deepEqual(itemTaxonomyCategoriesMissing(ITEM_TAXONOMY_V1_VIEW, new Set<string>()), all);
    assert.notEqual(itemTaxonomyCategoriesMissing(ITEM_TAXONOMY_V1_VIEW, new Set<string>()), AMAZON_TAXONOMY_CARD_CATEGORIES);
    assert.deepEqual(itemTaxonomyCategoriesMissing(ITEM_TAXONOMY_V1_VIEW, new Set([GROCERIES, 'Synthetic-Other'])),
      all.filter((category) => category !== GROCERIES));
    assert.deepEqual(itemTaxonomyCategoriesMissing(ITEM_TAXONOMY_V1_VIEW, new Set(all)), []);
  });

  it('leaves out only the excepted nodes, the asset node included, and refuses an unknown one', () => {
    const v2 = [...ITEM_TAXONOMY_V2_VIEW.cardCategories];
    assert.equal(v2.includes(CARD_ASSET_CATEGORY), true);
    assert.deepEqual(itemTaxonomyCategoriesMissing(ITEM_TAXONOMY_V2_VIEW, new Set<string>()), v2);
    assert.deepEqual(itemTaxonomyCategoriesMissing(ITEM_TAXONOMY_V2_VIEW, new Set<string>(), { except: [ITEM_TAXONOMY_ASSET_NODE] }),
      v2.filter((category) => category !== CARD_ASSET_CATEGORY));
    // A category another node still names stays listed.
    assert.deepEqual(itemTaxonomyCategoriesMissing(ITEM_TAXONOMY_V2_VIEW, new Set<string>(), { except: ['health/pharmacy'] }), v2);
    assert.deepEqual(itemTaxonomyCategoriesMissing(ITEM_TAXONOMY_V2_VIEW, new Set<string>(), { except: ['dining'] }),
      v2.filter((category) => category !== 'Restaurant-Restaurant'));
    assert.throws(() => itemTaxonomyCategoriesMissing(ITEM_TAXONOMY_V2_VIEW, new Set<string>(), { except: ['dining/nope' as never] }),
      { name: 'RangeError', message: 'unknown item taxonomy node' });
    assert.throws(() => itemTaxonomyCategoriesMissing(ITEM_TAXONOMY_V1_VIEW, new Set<string>(), { except: [ITEM_TAXONOMY_ASSET_NODE as never] }),
      { name: 'RangeError', message: 'unknown item taxonomy node' });
  });
});

describe('The v2 digest', () => {
  /** Amazon's digest form (apps/api policy.ts `digest`), computed with node:crypto from the recorded facts. */
  const independent = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item
  ))).digest('hex');

  it('is the SHA-256 of the canonical JSON of the recorded v2 facts, thresholds, residual and asset node', () => {
    assert.match(ITEM_TAXONOMY_V2_DIGEST, /^[0-9a-f]{64}$/);
    assert.equal(ITEM_TAXONOMY_V2_DIGEST, independent({
      version: 2,
      nodes: V2_ORDER.map(recordedFact).map(([id, label, parent, cardCategory]) => ({ id, label, parent, cardCategory })),
      minAgentBp: 6_000,
      suggestedBelowBp: 8_000,
      residual: 'needs-review',
      assetNode: 'precious-metals',
    }));
    assert.equal(itemTaxonomyDigest(ITEM_TAXONOMY_V2_DIGEST_INPUT), ITEM_TAXONOMY_V2_DIGEST);
    assert.equal(ITEM_TAXONOMY_V2_DIGEST_INPUT.nodes, ITEM_TAXONOMY_V2_VIEW.nodes);
    assert.equal(Object.isFrozen(ITEM_TAXONOMY_V2_DIGEST_INPUT), true);
  });

  it('changes when any node fact, the order, the version, a threshold, the residual or the asset node changes', () => {
    const base = ITEM_TAXONOMY_V2_DIGEST_INPUT;
    const withNode = (index: number, patch: Partial<ItemTaxonomyNode>): ItemTaxonomyDigestInput =>
      ({ ...base, nodes: base.nodes.map((node, at) => (at === index ? { ...node, ...patch } : node)) });
    const mutations: Array<[string, ItemTaxonomyDigestInput]> = base.nodes.flatMap((node, index): Array<[string, ItemTaxonomyDigestInput]> => [
      [`${node.id} id`, withNode(index, { id: `${node.id}-x` })],
      [`${node.id} label`, withNode(index, { label: `${node.label} ` })],
      [`${node.id} parent`, withNode(index, { parent: node.parent === null ? 'groceries' : null })],
      [`${node.id} card category`, withNode(index, { cardCategory: `${node.cardCategory} ` })],
    ]);
    mutations.push(
      ['two nodes swapped', { ...base, nodes: [base.nodes[1], base.nodes[0], ...base.nodes.slice(2)] }],
      ['a node removed', { ...base, nodes: base.nodes.slice(0, -1) }],
      ['a node added', { ...base, nodes: [...base.nodes, { id: 'synthetic', label: 'Synthetic', parent: null, cardCategory: INTERNET }] }],
      ['the version', { ...base, version: 1 }],
      ['the minimum', { ...base, minAgentBp: 6_001 }],
      ['the suggested bound', { ...base, suggestedBelowBp: 7_999 }],
      ['the residual', { ...base, residual: 'groceries' }],
      ['the asset node', { ...base, assetNode: 'dining' }],
    );
    const digests = new Set<string>([ITEM_TAXONOMY_V2_DIGEST]);
    for (const [what, input] of mutations) {
      const changed = itemTaxonomyDigest(input);
      assert.notEqual(changed, ITEM_TAXONOMY_V2_DIGEST, what);
      digests.add(changed);
    }
    assert.equal(digests.size, mutations.length + 1);
  });
});
