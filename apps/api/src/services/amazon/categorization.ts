import type { Database } from 'better-sqlite3';
import { digest, exact, refuse } from './policy.js';
import { productKey, productTitle, publicTitle, validateProductProjection } from './products.js';
import { effectiveCategories, validCategory } from './resolver.js';
export { effectiveCategories } from './resolver.js';

export interface AgentCategory {
  productKey: string;
  category: string;
  confidence: number;
  source: 'agent';
  rationale: 'categorized from product title';
}
export interface AgentReview {
  kind: 'agent-classification';
  productsDigest: string;
  categoriesDigest: string;
  entries: AgentCategory[];
}
export function categoryInventory(input: unknown): string[] {
  const c = Array.isArray(input) ? input : (() => {
    const record = exact(input, ['format', 'version', 'categories']);
    if (record.format !== 'holdr.amazon-effective-categories' || record.version !== 1) return refuse();
    return record.categories;
  })();
  if (!Array.isArray(c) || !c.every((v): v is string => typeof v === 'string' && validCategory(v))
    || new Set(c).size !== c.length) return refuse();
  return [...c].sort();
}
/**
 * An agent classification's own structure, every field and entry by exact type and value, with no database: what it
 * names (the inventory its categories come from, the products it classifies) is checked against the database later.
 */
export function agentReviewShape(input: unknown): AgentReview {
  const r = exact(input, ['kind', 'productsDigest', 'categoriesDigest', 'entries']);
  if (r.kind !== 'agent-classification' || typeof r.productsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(r.productsDigest)
    || typeof r.categoriesDigest !== 'string' || !/^[a-f0-9]{64}$/.test(r.categoriesDigest)
    || !Array.isArray(r.entries) || r.entries.length > 10000) return refuse();
  const seen = new Set<string>();
  for (const value of r.entries) {
    const e = exact(value, ['productKey', 'category', 'confidence', 'source', 'rationale']);
    if (typeof e.productKey !== 'string' || !/^[a-f0-9]{64}$/.test(e.productKey) || seen.has(e.productKey)
      || typeof e.category !== 'string' || !validCategory(e.category)
      || typeof e.confidence !== 'number' || !Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1
      || e.source !== 'agent' || e.rationale !== 'categorized from product title') return refuse();
    seen.add(e.productKey);
  }
  return input as AgentReview;
}
export function validateAgentReview(input: unknown, categories: readonly string[]): AgentReview {
  const review = agentReviewShape(input);
  if (review.categoriesDigest !== digest([...categories].sort())
    || review.entries.some(e => !categories.includes(e.category))) return refuse();
  return review;
}
export function makeAgentReview(projection: unknown, inventory: unknown, assignments: unknown): AgentReview {
  const p = validateProductProjection(projection);
  const keys = new Set(p.products.map(productKey));
  const categories = categoryInventory(inventory);
  const review = validateAgentReview({ kind: 'agent-classification', productsDigest: digest(projection),
    categoriesDigest: digest(categories), entries: assignments }, categories);
  if (review.entries.some(e => !keys.has(e.productKey))) return refuse();
  return review;
}
export function applyAgentReview(db: Database, input: unknown): void {
  const review = validateAgentReview(input, effectiveCategories(db));
  const known = new Set((db.prepare('SELECT data_json FROM amazon_items').pluck().all() as string[]).flatMap(text => {
    const item = JSON.parse(text);
    const product = productTitle({ asin: item.itemId, title: item.title });
    return publicTitle(product.title) === product.title ? [productKey(product)] : [];
  }));
  if (review.entries.some(e => !known.has(e.productKey))) return refuse();
  const put = db.prepare(`INSERT INTO amazon_agent_categories VALUES(?,?,?,?,?)
    ON CONFLICT(product_key) DO UPDATE SET category=excluded.category,confidence=excluded.confidence,
      source=excluded.source,rationale=excluded.rationale`);
  for (const e of review.entries) put.run(e.productKey, e.category, e.confidence, e.source, e.rationale);
}
