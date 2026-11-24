import type { Database } from 'better-sqlite3';
import { isAmazonTaxonomyNode, type AmazonTaxonomyNodeId } from '@finance-tracker/shared';
import { digest, exact, opaque, refuse } from './policy.js';
import { productKey, publicTitle, validTitle } from './products.js';
import { hasAmazonSchema } from './schema.js';
import { effectiveCategories, validCategory } from './resolver.js';
// STEP 9 integration (A10-A14, #174)
import { classifiableProductKey, hasAmazonTaxonomySchema } from './taxonomy.js';
// Keyless holds (Root, after STEP 9): owner line decisions, by stable line identity.
import {
  lineKey, lineProductPin, lineTaxonomyDecisionReader, lineTaxonomyKeyReader, orderLineIdentities, planLineTaxonomyMoves, shownTitle,
  type LineTaxonomyClaim, type LineTaxonomyKey, type LineTaxonomyMove, type StoredLineTaxonomyDecision, type TaxonomyKeylessHold,
} from './lineTaxonomy.js';
import type { ItemObservation, OrderObservation } from './types.js';

/**
 * Display replacement preserves owner decisions (Root, #168). When a later read replaces the displayed order, the owner's
 * category for a displayed line (its item override, keyed by the line's capture-scoped ref) moves to the one line of the
 * later read with the same identity: its ASIN, else its exact title. A line categorized only by the agent, keyed by
 * product, must resolve to the same agent category. A category that cannot follow unambiguously keeps the display.
 * STEP 9 integration (#161 x #168): a displayed line's item taxonomy (#161, keyed by product like agent categories)
 * follows the same way. A taxonomy decision is the full tuple (node, source, confidence). A learned ASIN changes the
 * product key, and the decision may follow it only to a key without any taxonomy row (the owner's carries; the agent's
 * waits for the application-time adoption of #171/#174) or to a key whose decision is identical. Any other row there
 * keeps the display, counted unmatched for the owner to resolve: nothing is overwritten or kept silently (Root).
 * Keyless holds (Root, after STEP 9): a hold that leaves no learned key (the matched line is not unique, or its title is
 * one the card-data guard holds) is resolved by the owner's GO'd decision for the line itself, by its stable line
 * identity (lineTaxonomy.ts, taxonomyLineDecisions.ts). A line so decided shows that decision and follows by it alone.
 */
export interface ItemCategoryPlan {
  /** Item overrides to carry, from a displayed line's ref to its matched line's ref in the later capture. */
  carries: Array<{ from: string; to: string; category: string }>;
  /** Categorized displayed lines that cannot follow: no or several matching lines, or another agent category. */
  unmatched: number;
  /** STEP 9 integration B2 (Root): displayed lines whose taxonomy decision cannot follow a key change (taxonomy-unmatched). */
  taxonomyUnmatched: number;
  // STEP 9 integration (A10-A14, #174)
  /** Of the category-unmatched lines, each line categorized only by the agent whose one matching line has a new product
   * key the agent has not categorized (a learned ASIN): the next GO'd category review adopts it (categoryKeyAdoptions,
   * adoptionReview). A new key the agent already categorized differently is never offered, since an adoption never
   * overwrites an agent decision: that line stays unmatched, for the owner to resolve. */
  adoptions: CategoryKeyAdoption[];
  /** STEP 9 integration (#161 x #168): owner taxonomy assignments to carry from a displayed line's product key to its
   * matched line's new key (only a key without any taxonomy row), with the version and mapping digest they carry. */
  taxonomyCarries: TaxonomyCarry[];
  /** Keyless holds (Root, after STEP 9): the taxonomy-unmatched lines no learned key can resolve (lineTaxonomy.ts), by
   * stable line identity and reason. Private: never printed. */
  keyless: TaxonomyKeylessHold[];
  /** Keyless holds (Root, after STEP 9): owner line decisions to move with their lines to their places in the re-read. */
  lineCarries: LineTaxonomyMove[];
}
/** A new product key that should adopt the agent category its displayed line already has. Private: never printed. */
export interface CategoryKeyAdoption {
  productKey: string;
  previousProductKey: string;
  category: string;
  confidence: number;
}
export interface TaxonomyCarry { from: string; to: string; node: string; taxonomyVersion: number; mappingDigest: string }
// STEP 9 integration (revocation)
const sameLine = (shown: ItemObservation, next: ItemObservation) =>
  shown.itemId !== null ? next.itemId === shown.itemId : next.title === shown.title;
const keyOf = (item: ItemObservation) => productKey({ asin: item.itemId, title: item.title });
/**
 * Line order is not a fact (Root, 2026-11-23): the line of a later read each displayed line becomes in a replacement,
 * by the displayed line's index in `shown`. By line ordinal, as every replacement compared before. Or, when the later
 * read proves its items complete and its lines pair one-to-one with the displayed lines by identity, by that identity:
 * a displayed line with an ASIN pairs with the one later line of that ASIN, one without with the one later line of its
 * exact title, no two displayed lines share a key and every later line pairs exactly once. compareObservation still
 * compares each pair's every attribute, so a known value that differs stays a conflict. Anything that does not pair so
 * keeps the ordinal pairing.
 */
export function displayedLinePairs(next: OrderObservation, shown: readonly ItemObservation[]): Map<number, ItemObservation> {
  const atOrdinal = new Map(next.items.map((item, index) => [item.lineOrdinal ?? index, item]));
  const byOrdinal = new Map(shown.flatMap((item, index) => {
    const other = atOrdinal.get(item.lineOrdinal ?? index);
    return other ? [[index, other] as const] : [];
  }));
  if (!next.itemProof?.complete || next.items.length !== shown.length) return byOrdinal;
  const identity = (item: ItemObservation) => item.itemId !== null ? `asin:${item.itemId}` : `title:${item.title}`;
  if (new Set(shown.map(identity)).size !== shown.length) return byOrdinal;
  const byIdentity = new Map<number, ItemObservation>(), taken = new Set<ItemObservation>();
  for (const [index, item] of shown.entries()) {
    const matches = next.items.filter(candidate => sameLine(item, candidate));
    if (matches.length !== 1 || taken.has(matches[0])) return byOrdinal;
    taken.add(matches[0]);
    byIdentity.set(index, matches[0]);
  }
  return byIdentity;
}
/** A product key's taxonomy decision (#161): its winning assignment (node, source, confidence), the owner's first. */
export interface TaxonomyDecision { source: 'owner' | 'agent'; node: string; confidence: number; taxonomyVersion: number; mappingDigest: string }
/** STEP 9 integration (#161 x #168): the taxonomy decisions one display replacement weighs, and Root's B2 rule. */
export interface TaxonomyDecisions {
  decisionOf(key: string): TaxonomyDecision | null;
  /**
   * A line moving from product key `from` to `to` (null: a held title, never carried onto). 'same': the key is unchanged,
   * `from` has no decision, or the decision at `to` is identical (node, source, confidence). A carry: the owner's decision
   * moves to a key without any row. 'held' otherwise: the agent's decision waits for its application-time adoption
   * (#171/#174), and any other row there keeps the display, counted unmatched. Nothing is overwritten or kept silently.
   */
  follow(from: string, to: string | null): 'same' | 'held' | TaxonomyCarry;
  /**
   * Keyless holds (Root, after STEP 9): the owner's stored decision that applies to a displayed line holding `identity`,
   * of product `asin` (lineTaxonomy.ts). A line so decided follows by that decision alone and is never held, since the
   * decision is the line's own, not its product's; its move is planned with the replacement's others
   * (planLineTaxonomyMoves).
   */
  lineDecisionOf(identity: string, asin: string | null): StoredLineTaxonomyDecision | null;
  /** Whether a line decision is stored under exactly this key. */
  lineKeyStored(key: LineTaxonomyKey): boolean;
}
/**
 // STEP 9 integration (revocation)
 * The decisions of every key: stored, else an owner decision this reader's `follow` carried there. Null without the (exact) taxonomy table, which only its own GO'd import installs.
 * Keyless holds (Root, after STEP 9): and every line's stored owner decision (lineTaxonomy.ts).
 */
export function taxonomyDecisions(db: Database): TaxonomyDecisions | null {
  if (!hasAmazonTaxonomySchema(db)) return null;
  const rows = db.prepare(`SELECT source,node,confidence,taxonomy_version AS taxonomyVersion,mapping_digest AS mappingDigest
    FROM amazon_product_taxonomy WHERE product_key=? ORDER BY CASE source WHEN 'owner' THEN 0 ELSE 1 END`);
  const pending = new Map<string, TaxonomyCarry>();
  const carriedTo = (key: string) => pending.get(key);
  const stored = (key: string) => rows.all(key) as TaxonomyDecision[];
  const decisionOf = (key: string): TaxonomyDecision | null => {
    const valid = stored(key).filter(row => isAmazonTaxonomyNode(row.node));
    const owner = valid.find(row => row.source === 'owner'), extra = carriedTo(key);
    return owner ?? (extra ? { source: 'owner', node: extra.node, confidence: 1, taxonomyVersion: extra.taxonomyVersion,
      mappingDigest: extra.mappingDigest } : valid.find(row => row.source === 'agent') ?? null);
  };
  // Keyless holds (Root, after STEP 9): owner line decisions as stored.
  const lineDecisionOf = lineTaxonomyDecisionReader(db), lineKeyStored = lineTaxonomyKeyReader(db);
  return {
    decisionOf,
    follow(from, to) {
      const decision = decisionOf(from);
      if (decision === null || to === from) return 'same';
      if (to === null) return 'held';
      const empty = stored(to).length === 0 && carriedTo(to) === undefined;
      if (empty && decision.source === 'owner') {
        const carry = { from, to, node: decision.node, taxonomyVersion: decision.taxonomyVersion, mappingDigest: decision.mappingDigest };
        pending.set(to, carry);
        return carry;
      }
      const there = empty ? null : decisionOf(to);
      return there !== null && there.node === decision.node && there.source === decision.source
        && there.confidence === decision.confidence ? 'same' : 'held';
    },
    lineDecisionOf,
    lineKeyStored,
  };
}
/**
 * Read-only: what a replacement of the displayed capture's lines by `next`'s (imported as `captureDigest`) would carry.
 */
export function planItemCategories(db: Database, orderRef: string, displayedDigest: string, next: OrderObservation,
  // STEP 9 integration (revocation)
  captureDigest: string): ItemCategoryPlan {
  const plan: ItemCategoryPlan = { carries: [], unmatched: 0, taxonomyUnmatched: 0, adoptions: [], taxonomyCarries: [], keyless: [],
    lineCarries: [] };
  const lines = db.prepare(`SELECT i.ref,i.data_json,v.category FROM amazon_items i
    LEFT JOIN amazon_item_overrides v ON v.item_ref=i.ref
    WHERE i.order_ref=? AND i.native_line_id LIKE ? || ':%' ORDER BY i.ref`).all(orderRef, displayedDigest) as
    Array<{ ref: string; data_json: string; category: string | null }>;
  const agents = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amazon_agent_categories'").get()
    ? db.prepare(`SELECT category,confidence FROM amazon_agent_categories WHERE product_key=? AND source='agent'
      AND rationale='categorized from product title'`) : null;
  const agent = (item: ItemObservation) => (agents?.get(keyOf(item)) as { category: string; confidence: number } | undefined) ?? null;
  // STEP 9 integration (#161 x #168): taxonomy decisions follow a key change only by Root's B2 rule.
  // STEP 9 integration (revocation)
  const decisions = taxonomyDecisions(db);
  const items = lines.map(line => JSON.parse(line.data_json) as ItemObservation);
  // Keyless holds (Root, after STEP 9): each line's stable identity (order-history v3's lineTieKeys), in both reads.
  const shownIds = decisions ? orderLineIdentities(next.orderId, items) : new Map<number, string>();
  const nextIds = decisions ? orderLineIdentities(next.orderId, next.items) : new Map<number, string>();
  const claims: LineTaxonomyClaim[] = [];
  // Line order is not a fact (Root, 2026-11-23): each displayed line's own line of the re-read, as the display rule pairs them.
  const pairs = displayedLinePairs(next, items);
  for (const [index, line] of lines.entries()) {
    const item = items[index], key = keyOf(item);
    const category = line.category, byAgent = category === null ? agent(item) : null;
    const identity = item.lineOrdinal === undefined ? undefined : shownIds.get(item.lineOrdinal);
    // A line the owner decided by its identity shows that decision, not its product's: it follows by it alone.
    const decided = identity === undefined ? null : decisions?.lineDecisionOf(identity, item.itemId) ?? null;
    const taxonomy = decided === null ? decisions?.decisionOf(key) ?? null : null;
    if (category === null && byAgent === null && taxonomy === null && decided === null) continue;
    const matches = next.items.filter(candidate => sameLine(item, candidate));
    const matched = matches.length === 1 && matches[0].lineOrdinal !== undefined ? matches[0] : null;
    let unmatched = false;
    if (category !== null || byAgent !== null) {
      // STEP 9 integration (A10-A14, #174)
      const nextAgent = matched && byAgent !== null ? agent(matched) : null;
      if (!matched || (byAgent !== null && nextAgent?.category !== byAgent.category)) {
        unmatched = true;
        // A category review can adopt the new key only for a line every review may classify (a public title), and only a
        // key the agent has not categorized: an adoption never overwrites an agent decision (#174).
        if (matched && byAgent !== null && nextAgent === null && validTitle(matched.title)
          && publicTitle(matched.title) === matched.title) {
          plan.adoptions.push({ productKey: keyOf(matched), previousProductKey: key, category: byAgent.category,
            confidence: byAgent.confidence });
        }
      } else if (category !== null) plan.carries.push({ from: line.ref, category,
        to: opaque('line-observation', [captureDigest, next.orderId, matched.lineOrdinal]) });
    }
    if (decided !== null) {
      // Its own line of the re-read is the one it pairs with (displayedLinePairs): the one at its position, or, when the
      // re-read proves its lines are the displayed ones reordered, the one of its identity. A display replacement is a
      // per-fact superset, so that line has its title and ASIN. Any other line of its identity, even of its title, is
      // another line.
      const paired = pairs.get(index), own = paired && sameLine(item, paired) ? paired : undefined;
      const place = own === undefined ? undefined : nextIds.get(own.lineOrdinal!);
      claims.push({ decision: decided, to: place === undefined ? null : lineKey(place, own!.itemId) });
    } else if (taxonomy !== null) {
      // Never onto a held title: an assignment that cannot follow keeps the display.
      // STEP 9 integration (B2-fix)
      const to = matched ? classifiableProductKey(matched) : null;
      const follow = decisions!.follow(key, to);
      if (follow === 'held') {
        plan.taxonomyUnmatched++;
        // Keyless holds (Root, after STEP 9): no learned key to adopt or map, so the owner decides the line itself.
        if (to === null && identity !== undefined) plan.keyless.push({ family: 'ordinary', lineIdentity: identity,
          reason: matched ? 'card-data-guard' : 'ambiguous-match',
          held: { node: taxonomy.node as AmazonTaxonomyNodeId, source: taxonomy.source, confidence: taxonomy.confidence },
          product: lineProductPin('ordinary', identity, key), productKey: key, asin: item.itemId, title: shownTitle(item.title) });
      } else if (follow !== 'same') plan.taxonomyCarries.push(follow);
    }
    if (unmatched) plan.unmatched++;
  }
  // Keyless holds (Root, after STEP 9): the decided lines' moves, as one set (chains and swaps of identities move whole).
  if (decisions) plan.lineCarries = planLineTaxonomyMoves(claims, decisions.lineKeyStored);
  return plan;
}
/**
 * STEP 9 integration (#161 x #168): writes one carried owner taxonomy assignment, keeping the carried row's version and
 // STEP 9 integration (B2-fix)
 * mapping digest. A plan carries only onto a key without any taxonomy row (Root), so a conflict throws and the write
 * rolls back: an existing decision is never overwritten or kept silently. Only with the (exact) taxonomy table installed
 * by its own GO'd import: never created here. Returns whether a row was written, for the caller's audit.
 */
export function carryOwnerTaxonomy(db: Database, carry: TaxonomyCarry): boolean {
  if (!hasAmazonTaxonomySchema(db)) return false;
  db.prepare(`INSERT INTO amazon_product_taxonomy(product_key,source,node,confidence,taxonomy_version,mapping_digest)
    VALUES(?,'owner',?,1,?,?)`).run(carry.to, carry.node, carry.taxonomyVersion, carry.mappingDigest);
  return true;
}
/**
 * The category-review worklist's adoptions (Root, #168): each new product key that a read retained after its order's
 * displayed capture gives a line categorized only by the agent (a learned ASIN changes the key), with the displayed
 * line's category and confidence, and that line's old key. The importer never writes agent categories: a GO'd `review`
 * adopts these keys with the same category (`amazon adoption-review` writes the adoption, adoptionReview, and
 * applyCategoryAdoption applies it), and the order's next re-read can then replace the display. Read-only; an adopted
 * key drops out, and a key the agent already categorized is never listed (planItemCategories). Lines that agree on a key's
 * category merge into the one with the lowest confidence, so each adoption is exactly one old key's agent category. A key
 * that two displayed categories would claim is left out: the review classifies it like any other.
 */
export function categoryKeyAdoptions(db: Database): CategoryKeyAdoption[] {
  return collectAdoptions(db).adoptions;
}
/** categoryKeyAdoptions, and how many keys it leaves out because two displayed categories would claim them. */
function collectAdoptions(db: Database): { adoptions: CategoryKeyAdoption[]; ambiguous: number } {
  if (!hasAmazonSchema(db)) return { adoptions: [], ambiguous: 0 };
  const orders = db.prepare(`SELECT o.ref,o.latest_digest,c.rowid AS shown FROM amazon_orders o
    JOIN amazon_captures c ON c.digest=o.latest_digest ORDER BY o.ref`).all() as
    Array<{ ref: string; latest_digest: string; shown: number }>;
  const later = db.prepare(`SELECT b.capture_digest,b.data_json FROM amazon_observations b
    JOIN amazon_captures c ON c.digest=b.capture_digest
    WHERE b.family='order' AND b.order_ref=? AND c.rowid>? ORDER BY c.rowid,b.ordinal`);
  const found = new Map<string, CategoryKeyAdoption | null>();
  for (const order of orders) {
    for (const read of later.all(order.ref, order.shown) as Array<{ capture_digest: string; data_json: string }>) {
      const next = JSON.parse(read.data_json) as OrderObservation;
      for (const adoption of planItemCategories(db, order.ref, order.latest_digest, next, read.capture_digest).adoptions) {
        const seen = found.get(adoption.productKey);
        found.set(adoption.productKey, seen === undefined ? adoption : seen === null || seen.category !== adoption.category ? null
          : adoption.confidence < seen.confidence ? adoption : seen);
      }
    }
  }
  const listed = [...found.values()];
  return { adoptions: listed.filter((a): a is CategoryKeyAdoption => a !== null)
    .sort((a, b) => a.productKey < b.productKey ? -1 : a.productKey > b.productKey ? 1 : 0),
  ambiguous: listed.filter(a => a === null).length };
}
const RATIONALE = 'categorized from product title';
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const inventoryDigest = (db: Database) => digest([...effectiveCategories(db)].sort());
/**
 * The adoption `amazon adoption-review` writes (Root: adoption provenance). Each entry is a new key, its old key and the
 * exact adopted agent category and confidence, sorted by new key. Private: only its digest is printed.
 */
export interface CategoryAdoption {
  kind: 'adoption';
  /** The digest of `entries`: the adoption list this adoption adopts. */
  productsDigest: string;
  /** The digest of the sorted card category inventory it was written against, as for an agent review. */
  categoriesDigest: string;
  entries: CategoryKeyAdoption[];
}
/** An adoption's exact shape, or the refusal any malformed review gets. */
export function validateCategoryAdoption(input: unknown): CategoryAdoption {
  const r = exact(input, ['kind', 'productsDigest', 'categoriesDigest', 'entries']);
  if (r.kind !== 'adoption' || typeof r.categoriesDigest !== 'string' || !HEX_DIGEST.test(r.categoriesDigest)
    || !Array.isArray(r.entries) || r.entries.length > 10000) return refuse();
  let previous = '';
  for (const value of r.entries) {
    const e = exact(value, ['productKey', 'previousProductKey', 'category', 'confidence']);
    if (typeof e.productKey !== 'string' || !HEX_DIGEST.test(e.productKey) || e.productKey <= previous
      || typeof e.previousProductKey !== 'string' || !HEX_DIGEST.test(e.previousProductKey) || e.previousProductKey === e.productKey
      || typeof e.category !== 'string' || !validCategory(e.category)
      || typeof e.confidence !== 'number' || !Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1) return refuse();
    previous = e.productKey;
  }
  if (r.productsDigest !== digest(r.entries)) return refuse();
  return input as CategoryAdoption;
}
/** What `amazon adoption-review` writes and counts. Private: only the counts and the adoption's digest are printed. */
export interface AdoptionReview {
  /** The adoption: exactly the listed keys whose category is in the inventory, each with its old key, category and confidence. */
  review: CategoryAdoption;
  /** Keys left out because two displayed categories would claim them (categoryKeyAdoptions). */
  ambiguous: number;
  /** Listed keys left out because their category is no longer in the card category inventory. */
  outsideInventory: number;
}
/**
 * The consumer of the adoption list (Root, #168): an adoption of each listed key with the same category and confidence,
 * carrying its old key, and pinned to the database's category inventory (`categoriesDigest`) and to the exact list it
 * adopts (`productsDigest`). Only an owner override introduces a category, so a listed key whose category is no longer
 * in the inventory is counted and left out. Read-only; only the GO'd `review` applies it (applyCategoryAdoption).
 */
export function adoptionReview(db: Database): AdoptionReview {
  const categories = effectiveCategories(db), listed = collectAdoptions(db);
  const entries = listed.adoptions.filter(a => categories.includes(a.category));
  return { review: validateCategoryAdoption({ kind: 'adoption', productsDigest: digest(entries),
    categoriesDigest: digest([...categories].sort()), entries }), ambiguous: listed.ambiguous,
  outsideInventory: listed.adoptions.length - entries.length };
}
/** A refused adoption's counts-only outcome (`adoption-stale`): its entries, and how many are no longer current. */
export interface AdoptionCounts {
  entries: number;
  stale: number;
}
/**
 * Applies an adoption inside the caller's write transaction (Root: adoption contracts hold at application time), so a
 * change committed by any connection before the transaction began, the pre-write backup's included, is seen. Before any
 * write, every entry is checked against the database as it is now:
 * - its new key still has no agent category, even the same one, so an adoption never overwrites an agent decision;
 * - its old key's agent category still exists and equals the adopted category and confidence;
 * - the card category inventory is still the one the adoption pinned (else every entry is stale);
 * - the adoption list, derived again, still lists it unchanged. A key since claimed by another category, or whose display
 *   was since replaced, is no longer listed. The list offers only a public-titled line of a retained read, so the new key
 *   is a known safe product, as for any agent review.
 * If any entry is no longer current, `stale` gets the counts and the whole application is refused before any write: the
 * operator writes a new adoption and GOes it again. Otherwise each new key gets its agent category by a plain insert,
 * never an upsert. A malformed adoption, an empty one, or a call outside a transaction is refused like any review.
 */
export function applyCategoryAdoption(db: Database, input: unknown, stale: (counts: AdoptionCounts) => void): void {
  const { categoriesDigest, entries } = validateCategoryAdoption(input);
  if (!entries.length || !db.inTransaction) return refuse();
  const pinned = categoriesDigest === inventoryDigest(db);
  const listed = new Map(collectAdoptions(db).adoptions.map(a => [a.productKey, a]));
  const row = db.prepare('SELECT category,confidence,source,rationale FROM amazon_agent_categories WHERE product_key=?');
  const current = (e: CategoryKeyAdoption) => {
    const old = row.get(e.previousProductKey) as { category: string; confidence: number; source: string; rationale: string }
      | undefined, now = listed.get(e.productKey);
    return pinned && row.get(e.productKey) === undefined
      && old?.category === e.category && old.confidence === e.confidence && old.source === 'agent' && old.rationale === RATIONALE
      && now?.previousProductKey === e.previousProductKey && now.category === e.category && now.confidence === e.confidence;
  };
  const count = entries.filter(e => !current(e)).length;
  if (count) {
    stale({ entries: entries.length, stale: count });
    return refuse();
  }
  const insert = db.prepare('INSERT INTO amazon_agent_categories VALUES(?,?,?,?,?)');
  for (const e of entries) insert.run(e.productKey, e.category, e.confidence, 'agent', RATIONALE);
}
