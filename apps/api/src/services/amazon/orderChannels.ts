import type { Database } from 'better-sqlite3';
import { HoldrRefusal } from '../dbErrors.js';

/**
 * An Amazon order's purchase channel when it is not an ordinary Amazon order (Root 2026-10-24, 03:25Z): today only a
 * Whole Foods in-store purchase (a `/fopo/` receipt, read from saved pages or by the kit's /fopo/ adapter, whose capture
 * marks its Fresh list `source: 'fopo'`), whose item list is groceries bought in a store, never an Amazon Fresh delivery.
 * The UI labels it from `purchaseChannel`; absent means an ordinary Amazon order.
 *
 * Additive and boot-safe: one table, created only on the first write (inside the importer's backed-up transaction), and
 * outside AMAZON_SCHEMA, so AMAZON_SCHEMA_DIGEST and every Root GO naming it are unchanged. Reads never migrate: with no
 * table, no order has a channel.
 */
export const PURCHASE_CHANNELS = ['whole-foods-in-store'] as const;
export type PurchaseChannel = typeof PURCHASE_CHANNELS[number];
const CHANNEL_SCHEMA = `CREATE TABLE IF NOT EXISTS amazon_order_channels (
  order_ref TEXT PRIMARY KEY REFERENCES amazon_orders(ref),
  channel TEXT NOT NULL CHECK(channel IN ('whole-foods-in-store')),
  capture_digest TEXT NOT NULL REFERENCES amazon_captures(digest))`;
export function hasOrderChannels(db: Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amazon_order_channels'").get();
}
/** Inside the caller's transaction: the order's channel, first write wins (a channel never changes). */
export function recordOrderChannel(db: Database, orderRef: string, channel: PurchaseChannel, captureDigest: string): boolean {
  if (!db.inTransaction || !PURCHASE_CHANNELS.includes(channel)) throw new HoldrRefusal('amazon order channel refused');
  db.exec(CHANNEL_SCHEMA);
  return db.prepare('INSERT INTO amazon_order_channels VALUES(?,?,?) ON CONFLICT(order_ref) DO NOTHING')
    .run(orderRef, channel, captureDigest).changes === 1;
}
/** Every order's recorded channel, by order ref; empty without the table. */
export function orderChannels(db: Database): Map<string, PurchaseChannel> {
  if (!hasOrderChannels(db)) return new Map();
  return new Map((db.prepare('SELECT order_ref,channel FROM amazon_order_channels').all() as Array<{ order_ref: string; channel: string }>)
    .filter(row => (PURCHASE_CHANNELS as readonly string[]).includes(row.channel))
    .map(row => [row.order_ref, row.channel as PurchaseChannel]));
}
