import type { Database } from 'better-sqlite3';
import { hasAmazonSchema } from './schema.js';
import { createAmazonCategoryResolver, effectiveCategories, validCategory, type AmazonSnapshot, type OrderMatchView } from './resolver.js';
import type { ItemObservation, Money, OrderObservation, PaymentObservation, Staging } from './types.js';
import { productKey, publicTitle } from './products.js';
import { cachedImages, hasCachedImage, type AmazonCachedImages } from './images.js';
import { orderChannels, type PurchaseChannel } from './orderChannels.js';
import { refuse } from './policy.js';

export interface RefundView {
  ref: string;
  status: 'issued' | 'pending' | 'unknown';
  date: string;
  amount: Money;
  destination: 'card' | 'balance' | 'points' | 'unknown';
}
export interface ItemView {
  ref: string;
  title: string;
  asin: string | null;
  quantity: number | null;
  unitPrice: Money | null;
  attribution: 'observation-only';
  category: string | null;
  categorySource: 'item-override' | 'agent-classification' | null;
  confidence: number | null;
  /**
   * Present only when the owner-only cache holds a thumbnail for the item's ASIN, or else for its own captured image ID
   * (`GET /amazon/items/:ref/image`).
   */
  image?: true;
}

export interface OrderView {
  ref: string;
  date: string;
  total: OrderObservation['total'];
  beneficiary: 'alex' | 'casey' | 'joint' | 'unknown';
  tenderCoverage: 'single-card-proven' | 'multi-tender' | 'unknown';
  paymentCoverage: 'held';
  itemObservations: number;
  matches: OrderMatchView[];
  refunds: RefundView[];
  items: Array<Pick<ItemView, 'ref' | 'title' | 'asin' | 'quantity' | 'category' | 'categorySource' | 'image'>>;
  /** Only when the order was not an ordinary Amazon order (orderChannels.ts): e.g. a Whole Foods in-store receipt. */
  purchaseChannel?: PurchaseChannel;
}
interface StoredOrder { ref: string; data_json: string; beneficiary: 'alex' | 'casey' | 'joint' | null }
function view(row: StoredOrder, snapshot: AmazonSnapshot, refunds: ReadonlyMap<string, RefundView[]>,
  channels: ReadonlyMap<string, PurchaseChannel>): Omit<OrderView, 'items'> {
  const order = JSON.parse(row.data_json) as OrderObservation;
  const channel = channels.get(row.ref);
  return { ref: row.ref, date: order.date, total: order.total, beneficiary: row.beneficiary ?? 'unknown',
    tenderCoverage: order.tenderCoverage ?? 'unknown', paymentCoverage: 'held', itemObservations: order.items.length,
    matches: snapshot.getOrderMatches(row.ref), refunds: refunds.get(order.orderId) ?? [],
    ...(channel ? { purchaseChannel: channel } : {}) };
}
export function listAmazonOrders(db: Database, offset: number, limit: number, beneficiary?: string): { total: number; orders: OrderView[] } {
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000000 || !Number.isInteger(limit) || limit < 1 || limit > 100) return refuse();
  if (!hasAmazonSchema(db)) return { total: 0, orders: [] };
  return db.transaction(() => {
    const snapshot = createAmazonCategoryResolver(db).snapshot();
    const where = beneficiary ? ' WHERE COALESCE(beneficiary,\'unknown\')=?' : '';
    const args = beneficiary ? [beneficiary] : [];
    const total = db.prepare(`SELECT count(*) FROM amazon_orders${where}`).pluck().get(...args) as number;
    const rows = db.prepare(`SELECT ref,data_json,beneficiary FROM amazon_orders${where}
      ORDER BY json_extract(data_json,'$.date') DESC,ref LIMIT ? OFFSET ?`).all(...args, limit, offset) as StoredOrder[];
    const refunds = readRefunds(db, new Set(rows.map(r => (JSON.parse(r.data_json) as OrderObservation).orderId)));
    const categories = new Set(effectiveCategories(db)), images = cachedImages(db), channels = orderChannels(db);
    return { total, orders: rows.map(row => ({ ...view(row, snapshot, refunds, channels),
      items: readItems(db, row.ref, categories, images).map(({ ref, title, asin, quantity, category, categorySource, image }) => (
        { ref, title, asin, quantity, category, categorySource, ...(image ? { image } : {}) }
      )) })) };
  })();
}
export function getAmazonOrder(db: Database, orderRef: string) {
  if (!hasAmazonSchema(db)) return null;
  return db.transaction(() => {
    const snapshot = createAmazonCategoryResolver(db).snapshot();
    const row = db.prepare('SELECT ref,data_json,beneficiary FROM amazon_orders WHERE ref=?').get(orderRef) as StoredOrder | undefined;
    if (!row) return null;
    const order = JSON.parse(row.data_json) as OrderObservation;
    return { ...view(row, snapshot, readRefunds(db, new Set([order.orderId])), orderChannels(db)),
      items: readItems(db, orderRef, new Set(effectiveCategories(db)), cachedImages(db)),
      summary: order.summary ?? [], paymentMethods: order.paymentMethods ?? [],
      refundSummary: order.refundSummary ?? null };
  })();
}
function readItems(db: Database, orderRef: string, categories: ReadonlySet<string>, images: AmazonCachedImages): ItemView[] {
  const observed = db.prepare(`SELECT ref,data_json FROM amazon_items WHERE order_ref=?
    AND native_line_id LIKE (SELECT latest_digest || ':%' FROM amazon_orders WHERE ref=?)
    ORDER BY json_extract(data_json,'$.lineOrdinal'),ref LIMIT 101`)
    .all(orderRef, orderRef) as Array<{ ref: string; data_json: string }>;
  if (observed.length > 100) return refuse();
  const hasAgents = hasAgentCategories(db);
  return observed.map(i => {
    const item = JSON.parse(i.data_json) as OrderObservation['items'][number];
    const override = db.prepare('SELECT category FROM amazon_item_overrides WHERE item_ref=?').pluck().get(i.ref) as string | undefined;
    const agent = hasAgents && publicTitle(item.title) === item.title ? db.prepare(`SELECT category,confidence FROM amazon_agent_categories
      WHERE product_key=? AND source='agent' AND rationale='categorized from product title'`)
      .get(productKey({ asin: item.itemId, title: item.title })) as AgentCategory | undefined : undefined;
    const { title, category, categorySource, confidence } = classifyItem(item, override, agent, categories);
    return { ref: i.ref, title, asin: item.itemId, quantity: item.quantity,
      unitPrice: item.unitPrice, attribution: 'observation-only' as const, category, categorySource, confidence,
      ...(hasCachedImage(images, item) ? { image: true as const } : {}) };
  });
}
export interface AgentCategory { category: string; confidence: number }
export function hasAgentCategories(db: Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amazon_agent_categories'").get());
}
/**
 * An observed item's public title and the category Amazon's views file it under: the owner's item override, else the
 * agent's classification from its title when that names one of Spending's categories. A title the card-data guard
 * hides gets neither, and nothing else is ever guessed: no category is null.
 */
export function classifyItem(item: Pick<ItemObservation, 'title'>, override: string | undefined,
  agent: AgentCategory | undefined, categories: ReadonlySet<string>): Pick<ItemView, 'title' | 'category' | 'categorySource' | 'confidence'> {
  const title = publicTitle(item.title), classificationHeld = title !== item.title;
  const overridden = !classificationHeld && override !== undefined && validCategory(override);
  const classified = !classificationHeld && agent !== undefined && categories.has(agent.category)
    && Number.isFinite(agent.confidence) && agent.confidence >= 0 && agent.confidence <= 1;
  return { title,
    category: overridden ? override : classified ? agent.category : null,
    categorySource: overridden ? 'item-override' : classified ? 'agent-classification' : null,
    confidence: !overridden && classified ? agent.confidence : null };
}
export function readRefunds(db: Database, orderIds: ReadonlySet<string>): Map<string, RefundView[]> {
  const answer = new Map<string, RefundView[]>();
  if (!orderIds.size) return answer;
  const rows = db.prepare('SELECT ref,data_json FROM amazon_refunds ORDER BY ref').all() as Array<{ ref: string; data_json: string }>;
  for (const row of rows) {
    const p = JSON.parse(row.data_json) as PaymentObservation;
    // A summary or legacy refund label is not a ledger moneyflow or destination.
    if (p.kind !== 'refund' || p.status !== 'completed' || p.provenance?.source !== 'ledger' || p.provenance.status !== 'Refunded') continue;
    const destinations = db.prepare('SELECT kind FROM amazon_refund_destinations WHERE refund_ref=?').pluck().all(row.ref) as string[];
    const destination = destinations.length === 1 && ['card', 'balance', 'points'].includes(destinations[0])
      ? destinations[0] as 'card' | 'balance' | 'points' : 'unknown';
    for (const orderId of new Set(p.orderIds)) if (orderIds.has(orderId)) {
      const list = answer.get(orderId) ?? [];
      list.push({ ref: row.ref, status: 'issued', date: p.date, amount: p.money, destination });
      answer.set(orderId, list);
    }
  }
  return answer;
}
export function amazonSummary(db: Database) {
  const empty = { measure: 'amazon-order-observations-not-card-spending' as const, orders: 0, paymentObservations: 0,
    refundObservations: 0, issuedRefundObservations: 0, linked: 0, held: 0, unknownBeneficiary: 0,
    itemAttribution: 'unproven' as const, coverage: [] as Array<{ captureRef: string; coverage: Staging['coverage'] }> };
  if (!hasAmazonSchema(db)) return { ...empty, ...createAmazonCategoryResolver(db).snapshot().matchCounts };
  return db.transaction(() => {
    const count = (sql: string) => db.prepare(sql).pluck().get() as number;
    const coverage = db.prepare('SELECT digest,coverage_json FROM amazon_captures ORDER BY imported_at DESC,digest').all() as
      Array<{ digest: string; coverage_json: string }>;
    // Count observations, not deduplicated economic refunds/events; native occurrence identity is still absent.
    // Displayed return/refund statuses (refund-family ordinals from 1000) are evidence, not these ledger counts.
    const resolver = createAmazonCategoryResolver(db).snapshot();
    return { ...empty, orders: count('SELECT count(*) FROM amazon_orders'),
      paymentObservations: count("SELECT count(*) FROM amazon_observations WHERE family='payment'"),
      refundObservations: count("SELECT count(*) FROM amazon_observations WHERE family='refund' AND ordinal<1000"),
      issuedRefundObservations: count(`SELECT count(*) FROM amazon_refunds WHERE execution_status='issued'
        AND json_extract(data_json,'$.provenance.source')='ledger'`),
      ...resolver.matchCounts,
      version: resolver.version,
      unknownBeneficiary: count('SELECT count(*) FROM amazon_orders WHERE beneficiary IS NULL'),
      coverage: coverage.map(c => ({ captureRef: c.digest, coverage: JSON.parse(c.coverage_json) as Staging['coverage'] })) };
  })();
}
