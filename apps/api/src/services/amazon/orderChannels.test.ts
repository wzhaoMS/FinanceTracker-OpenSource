import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { importAmazonCapture, recordBindingProposal, recordRootApproval } from './importer.js';
import { rootApproval } from './fixtures.testSupport.js';
import { digest, opaque } from './policy.js';
import { AMAZON_SCHEMA, AMAZON_SCHEMA_DIGEST, ensureAmazonSchema } from './schema.js';
import { importSavedOrders, parseSavedOrders, type SavedOrdersFile } from './savedOrders.js';
import { SAVED_CHARGES, SAVED_CLASSIC, SAVED_FRESH, syntheticSavedOrders } from './savedOrdersFixtures.testSupport.js';
import { hasOrderChannels, orderChannels, recordOrderChannel } from './orderChannels.js';
import { getAmazonOrder, listAmazonOrders } from './readModel.js';
import { amazonFresh, amazonFreshOrder } from './fresh.js';

const TODAY = '2026-10-24';
let dir: string, repo: SqliteStateRepo, backups = 0;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++backups}.db`);
async function importSaved(file: SavedOrdersFile) {
  const parsed = await parseSavedOrders(file, TODAY);
  return db().transaction(() => {
    ensureAmazonSchema(db());
    return importSavedOrders(db(), parsed, digest(file), '2026-10-24T04:00:00.000Z');
  }).immediate();
}
/** The synthetic file with its Fresh order read from a /fopo/ in-store receipt. */
const inStore = () => { const file = syntheticSavedOrders(); file.orders[1].family = 'fopo'; return file; };
const FRESH_REF = opaque('order', SAVED_FRESH), CLASSIC_REF = opaque('order', SAVED_CLASSIC);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-channel-synthetic-'));
  backups = 0;
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD', nickname: 'Synthetic Prime Visa' });
  repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1',
    rows: SAVED_CHARGES.map(c => ({ ...c, status: 'posted', kind: 'purchase', currency: 'USD', description: 'AMAZON SYNTHETIC',
      issuerCategory: 'Shopping' })) });
  const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db()));
  await recordBindingProposal(db(), proposal, backup());
  await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('purchaseChannel (Root 03:25Z: a Whole Foods in-store receipt never shows as an Amazon Fresh delivery)', () => {
  it('records a /fopo/ order as whole-foods-in-store and shows it on every order view; others have no channel', async () => {
    const outcome = await importSaved(inStore());
    expect(outcome.held).toEqual([]);
    expect([...orderChannels(db())]).toEqual([[FRESH_REF, 'whole-foods-in-store']]);
    const listed = new Map(listAmazonOrders(db(), 0, 10).orders.map(o => [o.ref, o]));
    expect(listed.get(FRESH_REF)!.purchaseChannel).toBe('whole-foods-in-store');
    expect(Object.hasOwn(listed.get(CLASSIC_REF)!, 'purchaseChannel')).toBe(false);
    expect(getAmazonOrder(db(), FRESH_REF)).toMatchObject({ purchaseChannel: 'whole-foods-in-store' });
    expect(Object.hasOwn(getAmazonOrder(db(), CLASSIC_REF)!, 'purchaseChannel')).toBe(false);
    const fresh = amazonFresh(db(), '2Y', TODAY);
    expect(fresh.orderList.map(o => [o.ref, o.purchaseChannel])).toEqual([[FRESH_REF, 'whole-foods-in-store']]);
    expect(amazonFreshOrder(db(), FRESH_REF)).toMatchObject({ purchaseChannel: 'whole-foods-in-store' });
  });
  it('shows an Amazon Fresh delivery with no channel, and never creates the table for it', async () => {
    await importSaved(syntheticSavedOrders());
    expect(hasOrderChannels(db())).toBe(false);
    expect(Object.hasOwn(amazonFresh(db(), '2Y', TODAY).orderList[0], 'purchaseChannel')).toBe(false);
    expect(Object.hasOwn(amazonFreshOrder(db(), FRESH_REF)!, 'purchaseChannel')).toBe(false);
    expect(Object.hasOwn(getAmazonOrder(db(), FRESH_REF)!, 'purchaseChannel')).toBe(false);
  });
  it('is additive and outside the Amazon schema: its digest is unchanged, and reads never migrate', async () => {
    const empty = new Database(':memory:');
    try {
      ensureAmazonSchema(empty);
      expect(hasOrderChannels(empty)).toBe(false);
      expect(orderChannels(empty).size).toBe(0);
      expect(empty.prepare("SELECT count(*) FROM sqlite_master WHERE name='amazon_order_channels'").pluck().get()).toBe(0);
    } finally { empty.close(); }
    await importSaved(inStore());
    expect(hasOrderChannels(db())).toBe(true);
    // Outside AMAZON_SCHEMA, so AMAZON_SCHEMA_DIGEST (and every Root GO naming it) is unchanged.
    expect(AMAZON_SCHEMA).not.toContain('amazon_order_channels');
    expect(AMAZON_SCHEMA_DIGEST).toBe(digest(AMAZON_SCHEMA));
    expect(() => recordOrderChannel(db(), FRESH_REF, 'whole-foods-in-store', 'x')).toThrow();
  });
  it('writes nothing for a held /fopo/ order, and a re-import keeps the one channel row', async () => {
    const held = inStore();
    held.orders[1].date = '2026-06-02';
    const outcome = await importSaved(held);
    expect(outcome.held.map(o => o.index)).toEqual([1]);
    expect(hasOrderChannels(db())).toBe(false);
    await importSaved(inStore());
    await importSaved(inStore());
    expect(db().prepare('SELECT count(*) FROM amazon_order_channels').pluck().get()).toBe(1);
  });
});

// The kit's own /fopo/ adapter (tools/amazon-capture/README.md): a capture whose Fresh list was read from
// the order's in-store receipt (`source: 'fopo'`) records the same channel, inside the import's own backed-up write.
describe('purchaseChannel from a kit capture of a /fopo/ in-store receipt', () => {
  const kit = async () => import(new URL('../../../../../tools/amazon-capture/fixtures/amazon-capture.mjs',
    import.meta.url).href);
  it('records whole-foods-in-store for the order whose list the kit read from its receipt, and shows it', async () => {
    const { fopoReadFixture, fopoReceiptId } = await kit();
    const ref = opaque('order', fopoReceiptId), capture = fopoReadFixture();
    expect(hasOrderChannels(db())).toBe(false);
    await importAmazonCapture(db(), capture, backup());
    expect([...orderChannels(db())]).toEqual([[ref, 'whole-foods-in-store']]);
    expect(db().prepare('SELECT capture_digest FROM amazon_order_channels WHERE order_ref=?').pluck().get(ref)).toBe(digest(capture));
    expect(getAmazonOrder(db(), ref)).toMatchObject({ purchaseChannel: 'whole-foods-in-store' });
    expect(listAmazonOrders(db(), 0, 10).orders.find(o => o.ref === ref)!.purchaseChannel).toBe('whole-foods-in-store');
    expect(amazonFreshOrder(db(), ref)).toMatchObject({ purchaseChannel: 'whole-foods-in-store',
      list: { rows: 5, lines: 5, unreadable: 0, complete: true, reconciled: true } });
    // The stored list record is exactly any Fresh list's: `source` stays in the capture, the channel in its own table.
    const record = JSON.parse(db().prepare('SELECT data_json FROM amazon_fresh_lists').pluck().get() as string);
    expect(Object.keys(record).sort()).toEqual(['lines', 'proof', 'provenance', 'reconciled', 'rows', 'statedCount']);
    expect(record.provenance.page).toBe('uff-itemmod');
  });
  it('keeps the first channel row on a re-import and on a later capture of the same order', async () => {
    const { fopoReadFixture } = await kit();
    const first = fopoReadFixture();
    await importAmazonCapture(db(), first, backup());
    await importAmazonCapture(db(), fopoReadFixture(), backup());
    const later = fopoReadFixture();
    later.staging.runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await importAmazonCapture(db(), later, backup());
    expect(db().prepare('SELECT count(*) FROM amazon_order_channels').pluck().get()).toBe(1);
    expect(db().prepare('SELECT capture_digest FROM amazon_order_channels').pluck().get()).toBe(digest(first));
  });
  it('never creates the table for a held /fopo/ read or an ordinary capture, and leaves the schema digest unchanged', async () => {
    const { fopoHeldFixture, constructedFopoFixture } = await kit();
    await importAmazonCapture(db(), fopoHeldFixture(), backup());
    await importAmazonCapture(db(), constructedFopoFixture(), backup());
    expect(hasOrderChannels(db())).toBe(false);
    expect(AMAZON_SCHEMA).not.toContain('amazon_order_channels');
    expect(AMAZON_SCHEMA_DIGEST).toBe(digest(AMAZON_SCHEMA));
  });
  it('refuses a malformed /fopo/ list or read at the import boundary, writing nothing', async () => {
    const { fopoReadFixture, fopoHeldFixture, invalidFopoReadCaptures, invalidFopoHeldCaptures } = await kit();
    for (const [make, mutations] of [[fopoReadFixture, invalidFopoReadCaptures()], [fopoHeldFixture, invalidFopoHeldCaptures()]] as const) {
      for (const mutate of mutations) {
        const capture = make(); mutate(capture);
        await expect(importAmazonCapture(db(), capture, backup())).rejects.toThrow();
      }
    }
    expect(hasOrderChannels(db())).toBe(false);
    expect(db().prepare('SELECT count(*) FROM amazon_captures').pluck().get()).toBe(0);
  });
});
