import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { ensureAmazonSchema } from './schema.js';
import { opaque, SOURCE } from './policy.js';
import { syntheticCapture, syntheticSubject } from './fixtures.testSupport.js';
import { listAmazonOrders } from './readModel.js';
import { createAmazonCategoryResolver } from './resolver.js';

describe('bounded order projection over large synthetic history', () => {
  it('indexes order matches once per snapshot instead of rescanning all subjects for every list row', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE card_accounts(id,issuer,owner,last4,currency,status);
        CREATE TABLE card_transactions(id,card_account_id,transaction_date,status,kind,currency,amount_minor,
          user_category,issuer_category,dismissed_at,removed_at,merged_into_id,description);`);
      ensureAmazonSchema(db);
      const capture = syntheticCapture();
      db.prepare('INSERT INTO amazon_sources VALUES(?)').run(SOURCE);
      db.prepare('INSERT INTO amazon_captures VALUES(?,?,?,?,?,?,?,?,?)').run('synthetic-capture', SOURCE, 3,
        '2026-08-21', '2026-10-19', JSON.stringify(capture.staging.coverage), '{}', '2026-10-19', '{}');
      const order = db.prepare('INSERT INTO amazon_orders VALUES(?,?,?,?,?,NULL)');
      const subject = db.prepare('INSERT INTO amazon_subjects VALUES(?,?,?,?,?)');
      db.transaction(() => {
        for (let n = 0; n < 5000; n++) {
          const native = `synthetic-order-${n}`, orderRef = opaque('order', native);
          order.run(orderRef, SOURCE, native, 'synthetic-capture',
            JSON.stringify({ ...capture.staging.orders[0], orderId: native, items: [] }));
          const s = syntheticSubject({ ref: opaque('subject', n), nativeOccurrenceId: `synthetic-event-${n}`, orderRefs: [orderRef] });
          subject.run(s.ref, SOURCE, s.evidenceClass, s.nativeOccurrenceId, JSON.stringify(s));
        }
      })();
      const start = performance.now();
      const page = listAmazonOrders(db, 0, 100);
      const elapsed = performance.now() - start;
      expect(page.orders).toHaveLength(100);
      expect(page.orders.every(o => o.matches.length === 1 && o.matches[0].state === 'held')).toBe(true);
      expect(elapsed).toBeLessThan(1000);
      const snapshot = createAmazonCategoryResolver(db).snapshot(), orderRef = page.orders[0].ref;
      const first = snapshot.getOrderMatches(orderRef);
      first.length = 0;
      const second = snapshot.getOrderMatches(orderRef);
      expect(second).toHaveLength(1);
      if (second[0].state === 'held') second[0].candidateCount = 999;
      expect(snapshot.getOrderMatches(orderRef)[0]).toMatchObject({ candidateCount: 0 });
    } finally { db.close(); }
  });
});
