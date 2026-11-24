/**
 * Holdr's Amazon item taxonomy: what an Amazon item is (pork, paper towels, a router), finer than the merchant-style
 * card categories Spending files card charges under. It is Amazon's own view of its items, by product, and never
 * changes card Spending: each node only names the card category its items correspond to, for compatibility.
 *
 * A node's `id` is stable: never renamed, reused or removed. A later version may add nodes, never take one away.
 * Top-level ids are one slug (`groceries`); a subcategory's is `top/slug` (`groceries/meat-seafood`). Any node may
 * be assigned, so an item that fits its top level but none of its subcategories is assigned to the top level itself.
 * `needs-review` is where every item without a usable assignment is listed, so it is always shown, never guessed.
 *
 * The tree is the shared item tree's v1 (itemTaxonomy.ts), declared there once and shared with retail. This module is
 * Amazon's view of it under the names Amazon has always used: each export is the v1 view's own value or function, or
 * the shared constant, never a copy, with the same values, order and types as when the tree was declared here.
 */
import {
  ITEM_TAXONOMY_BP_SCALE,
  ITEM_TAXONOMY_MIN_AGENT_BP,
  ITEM_TAXONOMY_RESIDUAL,
  ITEM_TAXONOMY_SOURCES,
  ITEM_TAXONOMY_SUGGESTED_BELOW_BP,
  ITEM_TAXONOMY_V1,
  ITEM_TAXONOMY_V1_VIEW,
  ITEM_TAXONOMY_VERSION_V1,
  isSuggestedItemTaxonomy,
  type ItemTaxonomyNode,
  type ItemTaxonomyPolicy,
  type ItemTaxonomySource,
  type ItemTaxonomyV1NodeId,
  type ItemTaxonomyV1TopId,
} from './itemTaxonomy.js';

export const AMAZON_ITEM_TAXONOMY_VERSION = ITEM_TAXONOMY_VERSION_V1;

/**
 * The taxonomy, in display order: the shared tree's v1 literal itself. A subcategory without its own `cardCategory`
 * corresponds to its top level's.
 */
export const AMAZON_ITEM_TAXONOMY = ITEM_TAXONOMY_V1;

export type AmazonTaxonomyTopId = ItemTaxonomyV1TopId;
export type AmazonTaxonomyNodeId = ItemTaxonomyV1NodeId;

/** Where every item without a usable assignment is listed. */
export const AMAZON_TAXONOMY_NEEDS_REVIEW = ITEM_TAXONOMY_RESIDUAL;
/** The top level the Amazon Fresh view breaks down, by its subcategories. */
export const AMAZON_TAXONOMY_GROCERIES = 'groceries' satisfies AmazonTaxonomyTopId;
/**
 * The one threshold: an agent's assignment at or above it is assigned to its node; below it, the item is listed in
 * Needs review with the agent's node as a suggestion. The owner's assignment always counts, whatever an agent said.
 * Derived from the shared threshold in basis points, over the scale: the correctly rounded division gives the very
 * double the literal 0.6 gives.
 */
export const AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE = ITEM_TAXONOMY_MIN_AGENT_BP / ITEM_TAXONOMY_BP_SCALE;
/** An agent's assignment that counts but is below this confidence is marked "suggested", for the owner to confirm. */
export const AMAZON_TAXONOMY_SUGGESTED_BELOW = ITEM_TAXONOMY_SUGGESTED_BELOW_BP / ITEM_TAXONOMY_BP_SCALE;
/** Amazon's policy for the shared resolver (itemTaxonomy.ts): Needs review, and its thresholds as confidences from 0 to 1. */
export const AMAZON_TAXONOMY_POLICY: ItemTaxonomyPolicy<typeof AMAZON_TAXONOMY_NEEDS_REVIEW> = Object.freeze({
  residual: AMAZON_TAXONOMY_NEEDS_REVIEW,
  minAgent: AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE,
  suggestedBelow: AMAZON_TAXONOMY_SUGGESTED_BELOW,
});
/**
 * Whether an assigned item is only suggested: an agent's, at or above `AMAZON_TAXONOMY_MIN_AGENT_CONFIDENCE` but below
 * `AMAZON_TAXONOMY_SUGGESTED_BELOW`, filed under a category. Needs review is never "suggested", whoever put an item
 * there: it holds what isn't classified, so it stays outside the assigned and suggested counts. The shared predicate,
 * in Amazon's unit.
 */
export function isSuggestedAmazonTaxonomy(source: AmazonTaxonomySource | null, confidence: number | null,
  node?: AmazonTaxonomyNodeId): boolean {
  return isSuggestedItemTaxonomy(AMAZON_TAXONOMY_POLICY, source, confidence, node);
}

/** Who assigned a product to a node: the owner's assignment always wins over an agent's. */
export type AmazonTaxonomySource = ItemTaxonomySource;
export const AMAZON_TAXONOMY_SOURCES: readonly AmazonTaxonomySource[] = ITEM_TAXONOMY_SOURCES;

export type AmazonTaxonomyNode = ItemTaxonomyNode<AmazonTaxonomyNodeId, AmazonTaxonomyTopId>;

/** Every node, each top level followed by its subcategories, in display order. */
export const AMAZON_TAXONOMY_NODES: readonly AmazonTaxonomyNode[] = ITEM_TAXONOMY_V1_VIEW.nodes;
/** The top-level nodes' ids, in display order. */
export const AMAZON_TAXONOMY_TOP_IDS: readonly AmazonTaxonomyTopId[] = ITEM_TAXONOMY_V1_VIEW.topIds;
/** Every card category a node corresponds to, sorted. */
export const AMAZON_TAXONOMY_CARD_CATEGORIES: readonly string[] = ITEM_TAXONOMY_V1_VIEW.cardCategories;

export const isAmazonTaxonomyNode = ITEM_TAXONOMY_V1_VIEW.isNode;
export const isAmazonTaxonomyTop = ITEM_TAXONOMY_V1_VIEW.isTop;
/** A node by id, or undefined for anything that isn't one. */
export const amazonTaxonomyNode = ITEM_TAXONOMY_V1_VIEW.node;
/** A node's top level: itself for a top-level node. */
export const amazonTaxonomyTop = ITEM_TAXONOMY_V1_VIEW.top;
/** A node's labels from its top level down: `['Groceries', 'Meat & Seafood']`. */
export const amazonTaxonomyPath = ITEM_TAXONOMY_V1_VIEW.path;
