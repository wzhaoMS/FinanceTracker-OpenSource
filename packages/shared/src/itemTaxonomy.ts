/**
 * The shared item tree: what an item is (pork, paper towels, a router, a gold coin), finer than the merchant-style card
 * categories Spending files card charges under. Amazon's item taxonomy (amazonTaxonomy.ts) is its v1 view; retail's
 * receipt lines read its v2 view. Every node is declared once, here: v1's in the v1 literal, moved unchanged from
 * amazonTaxonomy.ts, and v2's additions in their own literal, each with its position. A view only arranges declared
 * nodes; it never adds one.
 *
 * A node's `id` is stable: never renamed, reused or removed. A later version may add nodes, never take one away.
 * Top-level ids are one slug (`groceries`); a subcategory's is `top/slug` (`groceries/meat-seafood`). Any node may be
 * assigned, so an item that fits its top level but none of its subcategories is assigned to the top level itself. The
 * residual, `needs-review`, is where every item without a usable assignment is listed, so it is always shown, never
 * guessed.
 *
 * Each node names the card category its items correspond to, for compatibility: card Spending never reads it. The
 * issuer names come from cardCategoryNames.ts and the asset category from cardSpending.ts, so this module holds no
 * category literal.
 */
import { CARD_ASSET_CATEGORY } from './cardSpending.js';
import {
  CARD_CATEGORY_ARTS_JEWELRY as ARTS,
  CARD_CATEGORY_AUTO_SERVICES as AUTO,
  CARD_CATEGORY_BOOK_STORES as BOOKS,
  CARD_CATEGORY_CLOTHING_STORES as CLOTHING,
  CARD_CATEGORY_COMPUTER_SUPPLIES as COMPUTER,
  CARD_CATEGORY_ELECTRONICS_STORES as ELECTRONICS,
  CARD_CATEGORY_FUEL as FUEL,
  CARD_CATEGORY_FURNISHING as FURNISHING,
  CARD_CATEGORY_GENERAL_RETAIL as GENERAL,
  CARD_CATEGORY_GROCERIES as GROCERIES,
  CARD_CATEGORY_HARDWARE_SUPPLIES as HARDWARE,
  CARD_CATEGORY_INTERNET_PURCHASE as INTERNET,
  CARD_CATEGORY_OFFICE_SUPPLIES as OFFICE,
  CARD_CATEGORY_PHARMACIES as PHARMACIES,
  CARD_CATEGORY_RESTAURANT as RESTAURANT,
  CARD_CATEGORY_SPORTING_GOODS_STORES as SPORTING,
  CARD_CATEGORY_WHOLESALE_STORES as WHOLESALE,
} from './cardCategoryNames.js';
import { sha256 } from './cardDedupe.js';
import { canonicalJson } from './cardSync/canonical.js';

export const ITEM_TAXONOMY_VERSION_V1 = 1 as const;
export const ITEM_TAXONOMY_VERSION_V2 = 2 as const;

/** A subcategory as declared. Without its own `cardCategory`, it corresponds to its top level's. */
export interface ItemTaxonomyChildDeclaration<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
  readonly cardCategory?: string;
}
/** A top level as declared, with its subcategories in display order. */
export interface ItemTaxonomyTopDeclaration<TopId extends string = string, ChildId extends string = string> {
  readonly id: TopId;
  readonly label: string;
  readonly cardCategory: string;
  readonly children: readonly ItemTaxonomyChildDeclaration<ChildId>[];
}

/**
 * The taxonomy, in display order. A subcategory without its own `cardCategory` corresponds to its top level's.
 * Version 1: Root's nodes, plus subcategories for the top levels that had none where Amazon items split naturally.
 * Amazon's tree: amazonTaxonomy.ts exports this literal itself as `AMAZON_ITEM_TAXONOMY`.
 */
export const ITEM_TAXONOMY_V1 = [
  { id: 'groceries', label: 'Groceries', cardCategory: GROCERIES, children: [
    { id: 'groceries/meat-seafood', label: 'Meat & Seafood' },
    { id: 'groceries/dairy-eggs', label: 'Dairy & Eggs' },
    { id: 'groceries/produce', label: 'Produce' },
    { id: 'groceries/bakery-bread', label: 'Bakery & Bread' },
    { id: 'groceries/snacks-sweets', label: 'Snacks & Sweets' },
    { id: 'groceries/beverages', label: 'Beverages' },
    { id: 'groceries/pantry-cooking', label: 'Pantry & Cooking' },
    { id: 'groceries/frozen', label: 'Frozen' },
    { id: 'groceries/prepared-meals', label: 'Prepared Meals' },
  ] },
  { id: 'household', label: 'Household Supplies', cardCategory: GENERAL, children: [
    { id: 'household/cleaning', label: 'Cleaning' },
    { id: 'household/paper-disposables', label: 'Paper & Disposables' },
    { id: 'household/laundry', label: 'Laundry' },
    { id: 'household/storage-organization', label: 'Storage & Organization', cardCategory: FURNISHING },
  ] },
  { id: 'health', label: 'Health & Pharmacy', cardCategory: PHARMACIES, children: [
    { id: 'health/medicine-otc', label: 'Medicine & OTC' },
    { id: 'health/vitamins-supplements', label: 'Vitamins & Supplements' },
    { id: 'health/medical-supplies-devices', label: 'Medical Supplies & Devices' },
  ] },
  { id: 'personal-care', label: 'Personal Care & Beauty', cardCategory: PHARMACIES, children: [
    { id: 'personal-care/oral-care', label: 'Oral Care' },
    { id: 'personal-care/hair-care', label: 'Hair Care' },
    { id: 'personal-care/skin-body', label: 'Skin & Body Care' },
    { id: 'personal-care/shaving-grooming', label: 'Shaving & Grooming' },
  ] },
  { id: 'baby-kids', label: 'Baby & Kids', cardCategory: GENERAL, children: [] },
  { id: 'pet-supplies', label: 'Pet Supplies', cardCategory: GENERAL, children: [
    { id: 'pet-supplies/food-treats', label: 'Food & Treats' },
    { id: 'pet-supplies/care-accessories', label: 'Care & Accessories' },
  ] },
  { id: 'home-kitchen', label: 'Home & Kitchen', cardCategory: FURNISHING, children: [
    { id: 'home-kitchen/kitchen-dining', label: 'Kitchen & Dining' },
    { id: 'home-kitchen/small-appliances', label: 'Small Appliances', cardCategory: ELECTRONICS },
    { id: 'home-kitchen/furniture-decor', label: 'Furniture & Decor' },
    { id: 'home-kitchen/bedding-bath', label: 'Bedding & Bath' },
    { id: 'home-kitchen/water-air-treatment', label: 'Water & Air Treatment', cardCategory: HARDWARE },
  ] },
  { id: 'tools-home-improvement', label: 'Tools & Home Improvement', cardCategory: HARDWARE, children: [
    { id: 'tools-home-improvement/tools', label: 'Tools' },
    { id: 'tools-home-improvement/hardware-electrical', label: 'Hardware & Electrical' },
    { id: 'tools-home-improvement/plumbing', label: 'Plumbing' },
  ] },
  { id: 'electronics', label: 'Electronics', cardCategory: ELECTRONICS, children: [
    { id: 'electronics/computers-components', label: 'Computers & Components', cardCategory: COMPUTER },
    { id: 'electronics/computer-accessories', label: 'Computer Accessories', cardCategory: COMPUTER },
    { id: 'electronics/networking', label: 'Networking', cardCategory: COMPUTER },
    { id: 'electronics/phones-tablets', label: 'Phones & Tablets' },
    { id: 'electronics/audio-video', label: 'Audio & Video' },
    { id: 'electronics/smart-home', label: 'Smart Home' },
    { id: 'electronics/cables-chargers-batteries', label: 'Cables, Chargers & Batteries' },
  ] },
  { id: 'toys-hobbies', label: 'Toys, Hobbies & RC', cardCategory: GENERAL, children: [
    { id: 'toys-hobbies/toys-games', label: 'Toys & Games' },
    { id: 'toys-hobbies/rc-drones', label: 'RC & Drones' },
    { id: 'toys-hobbies/3d-printing', label: '3D Printing' },
    { id: 'toys-hobbies/arts-crafts', label: 'Arts & Crafts', cardCategory: ARTS },
  ] },
  { id: 'sports-outdoors', label: 'Sports & Outdoors', cardCategory: SPORTING, children: [
    { id: 'sports-outdoors/exercise-fitness', label: 'Exercise & Fitness' },
    { id: 'sports-outdoors/outdoor-recreation', label: 'Outdoor Recreation' },
  ] },
  { id: 'clothing', label: 'Clothing, Shoes & Accessories', cardCategory: CLOTHING, children: [
    { id: 'clothing/clothing', label: 'Clothing' },
    { id: 'clothing/shoes', label: 'Shoes' },
    { id: 'clothing/bags-accessories', label: 'Bags & Accessories' },
  ] },
  { id: 'books-media', label: 'Books, Media & Software', cardCategory: BOOKS, children: [
    { id: 'books-media/books', label: 'Books' },
    { id: 'books-media/movies-music-games', label: 'Movies, Music & Games', cardCategory: ELECTRONICS },
    { id: 'books-media/software', label: 'Software', cardCategory: COMPUTER },
  ] },
  { id: 'office-school', label: 'Office & School', cardCategory: OFFICE, children: [
    { id: 'office-school/office-supplies', label: 'Office Supplies' },
    { id: 'office-school/printers-ink-paper', label: 'Printers, Ink & Paper' },
  ] },
  { id: 'automotive', label: 'Automotive', cardCategory: AUTO, children: [] },
  { id: 'garden-patio', label: 'Garden & Patio', cardCategory: HARDWARE, children: [] },
  { id: 'gift-cards-digital', label: 'Gift Cards & Digital', cardCategory: INTERNET, children: [
    { id: 'gift-cards-digital/gift-cards', label: 'Gift Cards' },
    { id: 'gift-cards-digital/digital-content', label: 'Digital Content & Subscriptions' },
  ] },
  { id: 'needs-review', label: 'Needs review', cardCategory: INTERNET, children: [] },
] as const;

type V1Top = (typeof ITEM_TAXONOMY_V1)[number];
export type ItemTaxonomyV1TopId = V1Top['id'];
export type ItemTaxonomyV1ChildId = V1Top['children'][number]['id'];
export type ItemTaxonomyV1NodeId = ItemTaxonomyV1TopId | ItemTaxonomyV1ChildId;

/**
 * Where an addition goes: first or last among its top level's subcategories as they stand when it is placed, or
 * straight after or before a sibling (a top level beside a top level, a subcategory beside a subcategory).
 */
export type ItemTaxonomyPosition =
  | { readonly firstChildOf: string }
  | { readonly lastChildOf: string }
  | { readonly after: string }
  | { readonly before: string };
/** A node a later version adds: its parent (null for a top level) and its position. */
export interface ItemTaxonomyAddition {
  readonly id: string;
  readonly label: string;
  readonly parent: string | null;
  readonly cardCategory?: string;
  readonly position: ItemTaxonomyPosition;
}

/**
 * The nodes v2 adds for retail (design v5 §8.1), placed in this order: each position names a v1 node or an earlier
 * addition. `automotive/tires-service` states its top level's card category; the health subcategories inherit theirs.
 * `precious-metals` is the asset node; `memberships-fees` is filed with wholesale stores, as the card rows are (Q-T6).
 */
export const ITEM_TAXONOMY_V2_ADDITIONS = [
  { id: 'automotive/fuel', label: 'Fuel', parent: 'automotive', cardCategory: FUEL, position: { firstChildOf: 'automotive' } },
  {
    id: 'automotive/tires-service', label: 'Tires & Service', parent: 'automotive', cardCategory: AUTO,
    position: { after: 'automotive/fuel' },
  },
  { id: 'health/pharmacy', label: 'Prescriptions', parent: 'health', position: { lastChildOf: 'health' } },
  { id: 'health/optical', label: 'Optical', parent: 'health', position: { after: 'health/pharmacy' } },
  { id: 'dining', label: 'Food Court & Dining', parent: null, cardCategory: RESTAURANT, position: { after: 'groceries' } },
  {
    id: 'precious-metals', label: 'Precious metals', parent: null, cardCategory: CARD_ASSET_CATEGORY,
    position: { before: 'needs-review' },
  },
  {
    id: 'memberships-fees', label: 'Memberships & Fees', parent: null, cardCategory: WHOLESALE,
    position: { before: 'precious-metals' },
  },
] as const satisfies readonly ItemTaxonomyAddition[];

type V2Addition = (typeof ITEM_TAXONOMY_V2_ADDITIONS)[number];
export type ItemTaxonomyV2TopId = ItemTaxonomyV1TopId | Extract<V2Addition, { readonly parent: null }>['id'];
export type ItemTaxonomyV2ChildId = ItemTaxonomyV1ChildId | Exclude<V2Addition, { readonly parent: null }>['id'];
export type ItemTaxonomyV2NodeId = ItemTaxonomyV2TopId | ItemTaxonomyV2ChildId;

/**
 * A new frozen tree: `base` with `additions` placed in order. The base's nodes keep their order, so the base is a
 * subsequence of the result. Refuses a node declared twice, a position naming no sibling, a top level without a card
 * category, and a position its node can't take.
 */
export function spliceItemTaxonomy(
  base: readonly ItemTaxonomyTopDeclaration[], additions: readonly ItemTaxonomyAddition[],
): readonly ItemTaxonomyTopDeclaration[] {
  const tops = base.map((top) => ({ ...top, children: [...top.children] }));
  const declared = new Set<string>(tops.flatMap((top) => [top.id, ...top.children.map((child) => child.id)]));
  const indexIn = (siblings: readonly { readonly id: string }[], id: string): number => {
    const index = siblings.findIndex((sibling) => sibling.id === id);
    if (index < 0) throw new RangeError('item taxonomy position names no sibling');
    return index;
  };
  for (const { id, label, parent, cardCategory, position } of additions) {
    if (declared.has(id)) throw new RangeError('item taxonomy node declared twice');
    declared.add(id);
    if (parent === null) {
      if (cardCategory === undefined) throw new RangeError('item taxonomy top level without a card category');
      const node = { id, label, cardCategory, children: [] as ItemTaxonomyChildDeclaration[] };
      if ('after' in position) tops.splice(indexIn(tops, position.after) + 1, 0, node);
      else if ('before' in position) tops.splice(indexIn(tops, position.before), 0, node);
      else throw new RangeError('item taxonomy top level positioned as a subcategory');
      continue;
    }
    const { children } = tops[indexIn(tops, parent)];
    const node: ItemTaxonomyChildDeclaration = cardCategory === undefined ? { id, label } : { id, label, cardCategory };
    if ('firstChildOf' in position && position.firstChildOf === parent) children.unshift(node);
    else if ('lastChildOf' in position && position.lastChildOf === parent) children.push(node);
    else if ('after' in position) children.splice(indexIn(children, position.after) + 1, 0, node);
    else if ('before' in position) children.splice(indexIn(children, position.before), 0, node);
    else throw new RangeError('item taxonomy subcategory positioned under another top level');
  }
  return Object.freeze(tops.map((top) => Object.freeze({ ...top, children: Object.freeze(top.children) })));
}

/** v2: v1's nodes in v1's order, with the additions spliced in at their positions. */
export const ITEM_TAXONOMY_V2 = spliceItemTaxonomy(ITEM_TAXONOMY_V1, ITEM_TAXONOMY_V2_ADDITIONS) as
  readonly ItemTaxonomyTopDeclaration<ItemTaxonomyV2TopId, ItemTaxonomyV2ChildId>[];

/** A node as a view lists it. */
export interface ItemTaxonomyNode<Id extends string = string, TopId extends Id = Id> {
  readonly id: Id;
  readonly label: string;
  /** Its top level's id; null for a top-level node. */
  readonly parent: TopId | null;
  /** The card category its items correspond to (an issuer category name, or the asset category). Card Spending never reads it. */
  readonly cardCategory: string;
  /** Its subcategories' ids, in display order; empty for a subcategory or a top level without any. */
  readonly children: readonly Id[];
}
/** A tree's nodes and the helpers that read them. Its functions close over the view and never read `this`. */
export interface ItemTaxonomyView<Id extends string = string, TopId extends Id = Id> {
  /** Every node, each top level followed by its subcategories, in display order. */
  readonly nodes: readonly ItemTaxonomyNode<Id, TopId>[];
  /** The top-level nodes' ids, in display order. */
  readonly topIds: readonly TopId[];
  /** Every card category a node corresponds to, sorted. */
  readonly cardCategories: readonly string[];
  readonly isNode: (value: unknown) => value is Id;
  readonly isTop: (value: unknown) => value is TopId;
  /** A node by id, or undefined for anything that isn't one. */
  readonly node: (id: unknown) => ItemTaxonomyNode<Id, TopId> | undefined;
  /** A node's top level: itself for a top-level node. */
  readonly top: (id: Id) => TopId;
  /** A node's labels from its top level down: `['Groceries', 'Meat & Seafood']`. */
  readonly path: (id: Id) => string[];
}

/**
 * The view of a tree: its nodes and helpers, extracted from amazonTaxonomy.ts, whose exports are the v1 view's. `name`
 * only words the errors (`unknown ${name} taxonomy node`).
 */
export function itemTaxonomyView<TopId extends string, ChildId extends string>(
  tree: readonly ItemTaxonomyTopDeclaration<TopId, ChildId>[], name: string,
): ItemTaxonomyView<TopId | ChildId, TopId> {
  type Id = TopId | ChildId;
  const nodes: readonly ItemTaxonomyNode<Id, TopId>[] = Object.freeze(tree.flatMap((top): ItemTaxonomyNode<Id, TopId>[] => [
    Object.freeze({ id: top.id, label: top.label, parent: null, cardCategory: top.cardCategory,
      children: Object.freeze(top.children.map((child) => child.id)) }),
    ...top.children.map((child) => Object.freeze({ id: child.id, label: child.label, parent: top.id,
      cardCategory: child.cardCategory ?? top.cardCategory, children: Object.freeze([]) })),
  ]));
  const byId: ReadonlyMap<string, ItemTaxonomyNode<Id, TopId>> = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new RangeError(`${name} taxonomy node declared twice`);
  const unknownNode = () => new RangeError(`unknown ${name} taxonomy node`);
  const isNode = (value: unknown): value is Id => typeof value === 'string' && byId.has(value);
  return Object.freeze({
    nodes,
    topIds: Object.freeze(tree.map((top) => top.id)),
    cardCategories: Object.freeze([...new Set(nodes.map((node) => node.cardCategory))].sort()),
    isNode,
    isTop: (value: unknown): value is TopId => isNode(value) && byId.get(value)!.parent === null,
    node: (id: unknown): ItemTaxonomyNode<Id, TopId> | undefined => (typeof id === 'string' ? byId.get(id) : undefined),
    top: (id: Id): TopId => {
      const node = byId.get(id);
      if (!node) throw unknownNode();
      return node.parent ?? (node.id as TopId);
    },
    path: (id: Id): string[] => {
      const node = byId.get(id);
      if (!node) throw unknownNode();
      return node.parent === null ? [node.label] : [byId.get(node.parent)!.label, node.label];
    },
  });
}

/** The v1 view: Amazon's, exactly as amazonTaxonomy.ts built it before the tree was shared (its errors still name Amazon). */
export const ITEM_TAXONOMY_V1_VIEW = itemTaxonomyView<ItemTaxonomyV1TopId, ItemTaxonomyV1ChildId>(ITEM_TAXONOMY_V1, 'Amazon');
/** The v2 view: retail's. */
export const ITEM_TAXONOMY_V2_VIEW = itemTaxonomyView<ItemTaxonomyV2TopId, ItemTaxonomyV2ChildId>(ITEM_TAXONOMY_V2, 'item');

/** Where every item without a usable assignment is listed: a top level of every version. */
export const ITEM_TAXONOMY_RESIDUAL = 'needs-review' satisfies ItemTaxonomyV1TopId;
/**
 * The asset node, v2 only: precious metals, filed under the asset category and never a part (design v5 §9). It is
 * exempt from the card-category residual rule (`itemTaxonomyCategoriesMissing`'s `except`).
 */
export const ITEM_TAXONOMY_ASSET_NODE = 'precious-metals' satisfies ItemTaxonomyV2TopId;

/** Basis points in a confidence of 1. */
export const ITEM_TAXONOMY_BP_SCALE = 10_000;
/**
 * The one threshold: an agent's assignment at or above it is assigned to its node; below it, the item is listed in the
 * residual with the agent's node as a suggestion. The owner's assignment always counts, whatever an agent said.
 */
export const ITEM_TAXONOMY_MIN_AGENT_BP = 6_000;
/** An agent's assignment that counts but is below this confidence is marked "suggested", for the owner to confirm. */
export const ITEM_TAXONOMY_SUGGESTED_BELOW_BP = 8_000;

/** Who assigned a subject to a node: the owner's assignment always wins over an agent's. */
export const ITEM_TAXONOMY_SOURCES = Object.freeze(['owner', 'agent'] as const);
export type ItemTaxonomySource = (typeof ITEM_TAXONOMY_SOURCES)[number];

/**
 * How a caller resolves its assignments: its residual, and the thresholds in its own confidence unit (Amazon's from 0
 * to 1, retail's in basis points), so no conversion ever crosses a threshold.
 */
export interface ItemTaxonomyPolicy<Node extends string = string> {
  readonly residual: Node;
  readonly minAgent: number;
  readonly suggestedBelow: number;
}
/** The policy in basis points. */
export const ITEM_TAXONOMY_BP_POLICY: ItemTaxonomyPolicy<typeof ITEM_TAXONOMY_RESIDUAL> = Object.freeze({
  residual: ITEM_TAXONOMY_RESIDUAL,
  minAgent: ITEM_TAXONOMY_MIN_AGENT_BP,
  suggestedBelow: ITEM_TAXONOMY_SUGGESTED_BELOW_BP,
});

/**
 * Whether an assigned item is only suggested: an agent's, at or above the policy's `minAgent` but below its
 * `suggestedBelow`, filed under a node. The residual is never "suggested", whoever put an item there: it holds what
 * isn't classified, so it stays outside the assigned and suggested counts.
 */
export function isSuggestedItemTaxonomy(policy: ItemTaxonomyPolicy, source: ItemTaxonomySource | null, confidence: number | null,
  node?: string): boolean {
  return source === 'agent' && node !== policy.residual && confidence !== null
    && confidence >= policy.minAgent && confidence < policy.suggestedBelow;
}

/** A subject's one winning assignment, as its reader picks it: the owner's when there is one, else the agent's. */
export interface ItemTaxonomyAssignment<Node extends string = string, Confidence extends number | null = number | null> {
  readonly node: Node;
  readonly source: ItemTaxonomySource;
  readonly confidence: Confidence;
}
/** Where an assignment counts. */
export interface ItemTaxonomyResolution<Node extends string = string, Confidence extends number | null = number | null> {
  /** Where the subject is counted: the residual when nothing usable assigns it. */
  node: Node;
  /** Who put it there; null when it is in the residual for want of a usable assignment. */
  source: ItemTaxonomySource | null;
  /** The assignment's confidence, untouched (an owner's too); null when unassigned. */
  confidence: Confidence | null;
  /** An agent's assignment to a node below the policy's `suggestedBelow`: shown as suggested. Never the residual. */
  suggested: boolean;
  /** An agent's node below the policy's `minAgent`: shown in the residual, never counted there. */
  suggestion: { node: Node; confidence: number } | null;
}
/**
 * Where an assignment counts, extracted from Amazon's `resolveTaxonomy`: the owner's always, its confidence passed
 * through; an agent's from the policy's `minAgent`; anything else in the residual, with the agent's node as a
 * suggestion unless the agent named the residual itself.
 */
export function resolveItemTaxonomy<Node extends string, Confidence extends number | null>(
  assignment: ItemTaxonomyAssignment<Node, Confidence> | undefined, policy: ItemTaxonomyPolicy<Node>,
): ItemTaxonomyResolution<Node, Confidence> {
  if (!assignment) return { node: policy.residual, source: null, confidence: null, suggested: false, suggestion: null };
  const confidence: number | null = assignment.confidence;
  if (assignment.source === 'owner' || (confidence !== null && confidence >= policy.minAgent)) {
    return { node: assignment.node, source: assignment.source, confidence: assignment.confidence,
      suggested: isSuggestedItemTaxonomy(policy, assignment.source, confidence, assignment.node), suggestion: null };
  }
  return { node: policy.residual, source: null, confidence: null, suggested: false,
    suggestion: assignment.node === policy.residual || confidence === null ? null : { node: assignment.node, confidence } };
}

/**
 * The card categories of a view's nodes that `known` lacks, sorted: the pure core of a plan's `cardCategoriesMissing`.
 * `except` leaves nodes out, each a node of the view: retail leaves out the asset node, which is never a part.
 */
export function itemTaxonomyCategoriesMissing<Id extends string, TopId extends Id>(view: ItemTaxonomyView<Id, TopId>,
  known: ReadonlySet<string>, options: { readonly except?: readonly Id[] } = {}): string[] {
  const except = new Set<string>(options.except ?? []);
  for (const id of except) if (!view.isNode(id)) throw new RangeError('unknown item taxonomy node');
  return [...new Set(view.nodes.filter((node) => !except.has(node.id)).map((node) => node.cardCategory))].sort()
    .filter((category) => !known.has(category));
}

/** What a tree's digest covers: its version, every node's facts in order, the thresholds, the residual and the asset node. */
export interface ItemTaxonomyDigestInput {
  readonly version: number;
  readonly nodes: readonly Pick<ItemTaxonomyNode, 'id' | 'label' | 'parent' | 'cardCategory'>[];
  readonly minAgentBp: number;
  readonly suggestedBelowBp: number;
  readonly residual: string;
  readonly assetNode: string;
}
/** Lowercase hex SHA-256 of the input's canonical JSON (keys sorted, no white space). */
export function itemTaxonomyDigest(input: ItemTaxonomyDigestInput): string {
  const text = canonicalJson({
    version: input.version,
    nodes: input.nodes.map(({ id, label, parent, cardCategory }) => ({ id, label, parent, cardCategory })),
    minAgentBp: input.minAgentBp,
    suggestedBelowBp: input.suggestedBelowBp,
    residual: input.residual,
    assetNode: input.assetNode,
  });
  return Array.from(sha256(new TextEncoder().encode(text)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export const ITEM_TAXONOMY_V2_DIGEST_INPUT: ItemTaxonomyDigestInput = Object.freeze({
  version: ITEM_TAXONOMY_VERSION_V2,
  nodes: ITEM_TAXONOMY_V2_VIEW.nodes,
  minAgentBp: ITEM_TAXONOMY_MIN_AGENT_BP,
  suggestedBelowBp: ITEM_TAXONOMY_SUGGESTED_BELOW_BP,
  residual: ITEM_TAXONOMY_RESIDUAL,
  assetNode: ITEM_TAXONOMY_ASSET_NODE,
});
/** v2's digest: retail's `taxonomyDigest`. */
export const ITEM_TAXONOMY_V2_DIGEST = itemTaxonomyDigest(ITEM_TAXONOMY_V2_DIGEST_INPUT);
