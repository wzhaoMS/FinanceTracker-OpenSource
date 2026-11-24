import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { tablesAndCounts } from '../../testing/sqliteContents.js';
import { validateCapture } from './capture.js';
import { backedUpWrite, importAmazonCapture, recordBindingProposal, recordRootApproval } from './importer.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { readLedger, reconcileAmazon } from './matcher.js';
import { createAmazonCategoryResolver } from './resolver.js';
import { amazonSpending } from './spending.js';
import { getAmazonOrder, listAmazonOrders } from './readModel.js';
import { productKey } from './products.js';
import { digest } from './policy.js';
import { splitRef } from './tipSplit.js';
import { rootApproval, syntheticBackfillCapture, syntheticCompleteCapture, syntheticCompleteOrder, syntheticEvidence,
  syntheticRereadCapture, withRefundEvidence } from './fixtures.testSupport.js';
import { BATCH_CAPTURE_REFUSED, batchGoLog, batchGoReusable, batchGoState, batchGoUsed, canonicalJson, hasDuplicateKeys,
  imageIdChanges, importClassifiedCapture, installChangeLog, isRereadCapture, makeClone, orderFactKinds, previewRefusal,
  readCaptureList, readChangeLog, recordBatchAttempt, recordBatchGo, recordBatchRefusal, revisionOrderBreak, rollbackBaseline,
  runBatchCaptures, settleBaseline, verifyRolledBack, type BatchRefusal, type CaptureOut } from './batch.js';
import type { OrderObservation } from './types.js';

// Entirely synthetic: invented order IDs, ASINs, titles, image IDs and amounts.
const IMAGES = ['91SynthAA0L', '91Synth+01L', '91Synth-02L'];
const NOW = '2026-10-23T00:00:00.000Z';
let dir: string, repo: SqliteStateRepo, backupNumber: number;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++backupNumber}.db`);
const order = syntheticCompleteOrder, first = syntheticCompleteCapture;
/** A re-read of the order showing `imageIds`, changed by `change`. */
const reread = (imageIds: Array<string | undefined>, change: (o: OrderObservation) => void = () => undefined, run = 2) => {
  const o = order(...imageIds);
  change(o);
  return syntheticRereadCapture(o, run);
};
/** One capture's classified import in its own transaction: its classification, and whether it was kept. */
async function classify(input: unknown) {
  const capture = await validateCapture(input), out: CaptureOut = {};
  try {
    importClassifiedCapture(db(), capture, digest(input), NOW, out);
    return { ...out.result!.classification, kept: true };
  } catch (error) {
    if (!out.result || (error as Error).message !== BATCH_CAPTURE_REFUSED) throw error;
    return { ...out.result.classification, kept: false };
  }
}
/** Every table's rows, to show a refused capture rolled back whole. */
const tables = () => Object.fromEntries((db().prepare(`SELECT name FROM sqlite_master WHERE type='table'
  AND name NOT LIKE 'sqlite%' ORDER BY name`).pluck().all() as string[]).map(name => [name, db().prepare(`SELECT * FROM "${name}"`).all()]));
const displayed = () => JSON.parse(db().prepare('SELECT data_json FROM amazon_orders').pluck().get() as string) as OrderObservation;
const shownItems = () => getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!.items;
/** What the household sees of the order and its card charge, without the capture-scoped line refs. */
const measures = () => {
  const resolved = [...createAmazonCategoryResolver(db()).snapshot().resolve(readLedger(db())).values()];
  const spending = amazonSpending(db(), '2Y', '2026-10-19');
  return {
    items: shownItems().map(i => [i.title, i.asin, i.quantity, i.category, i.categorySource]),
    resolved: resolved.map(r => r.kind === 'split' ? r.contributions.map(({ itemRef: _ref, ...part }) => part) : r),
    totals: spending.totals, categories: spending.categories,
    matches: db().prepare('SELECT subject_ref,state,card_transaction_id FROM amazon_matches ORDER BY subject_ref').all(),
  };
};
const audits = (action: string) => db().prepare('SELECT count(*) FROM amazon_audit WHERE action=?').pluck().get(action) as number;
/** A card row the matcher would now link to or weigh against the synthetic order, without any Amazon reconcile. */
const addCardRow = (description: string) => repo.importCardTransactions({ cardAccountId: readCardInventory(db())[0].id,
  source: 'synthetic', parserVersion: 'synthetic@1', rows: [{ transactionDate: '2026-09-02', status: 'posted', kind: 'purchase',
    currency: 'USD', amountMinor: 1100, description, issuerCategory: 'Shopping' }] });

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-batch-synthetic-')); backupNumber = 0;
  repo = new SqliteStateRepo({ file: path.join(dir, 'synthetic.db') });
  const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD' });
  repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1',
    rows: [{ transactionDate: '2026-09-03', status: 'posted', kind: 'purchase', currency: 'USD', amountMinor: 1100,
      description: 'AMAZON SYNTHETIC TOTAL', issuerCategory: 'Shopping' }] });
  const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(db()));
  await recordBindingProposal(db(), proposal, backup());
  await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('re-read captures', () => {
  it('takes a backfill slice of one detail request continuing a cursor, with one order and no payments', async () => {
    const capture = reread([IMAGES[0]]);
    await expect(validateCapture(capture)).resolves.toBeDefined();
    expect(isRereadCapture(capture)).toBe(true);
    const variants: Array<[string, unknown]> = [
      ['a recent read', first()],
      ['a first backfill slice (no cursor before it)', syntheticBackfillCapture()],
      ['two requests', { ...capture, structure: { ...capture.structure, requests: 2 } }],
      ['a list page', { ...capture, structure: { ...capture.structure, pages: [{ kind: 'orders' }] } }],
      ['no order', { ...capture, staging: { ...capture.staging, orders: [] } }],
      ['two orders', { ...capture, staging: { ...capture.staging, orders: [order(), { ...order(), orderId: '000-0000001-0000002' }] } }],
      ['a payment', { ...capture, staging: { ...capture.staging, payments: [{}] } }],
      ['Fresh lists', { ...capture, fresh: {} }],
      ['no continuation', { structure: capture.structure, staging: capture.staging }],
      ['a v2 staging', { ...capture, staging: { ...capture.staging, version: 2 } }],
    ];
    for (const [name, variant] of variants) expect(isRereadCapture(variant), name).toBe(false);
  });
  it('reads a strict, private capture list of distinct absolute paths', () => {
    const file = (n: number) => path.join(dir, `capture-${n}.json`);
    const list = (captures: unknown, patch: Record<string, unknown> = {}) =>
      ({ format: 'holdr.amazon-capture-list', version: 1, captures, ...patch });
    expect(readCaptureList(list([file(1), file(2)]), 2)).toEqual([file(1), file(2)]);
    for (const bad of [list([]), list([file(1), file(2), file(3)]), list(['capture.json']), list([file(1), file(1)]),
      list([file(1), 7]), list(file(1)), list([file(1)], { version: '1' }), list([file(1)], { format: 'holdr.amazon-captures' }),
      list([file(1)], { extra: true }), null, [file(1)]]) {
      expect(() => readCaptureList(bad, 2), JSON.stringify(bad)).toThrow('amazon input refused');
    }
    if (process.platform === 'win32') expect(() => readCaptureList(list([file(1), file(1).toUpperCase()]), 2)).toThrow();
  });
  it('finds the first capture out of commit order: within one cursor, each revision above the one before it', () => {
    const at = (id: string, revision: unknown) => ({ continuation: { before: null, after: { id, revision } } });
    const [x, y] = ['00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000bb'];
    // Two cursors may interleave; a capture with no readable cursor position is passed over (it is refused on its own).
    expect(revisionOrderBreak([at(x, 2), at(y, 1), at(x, 3), null, {}, first(), at(x, '9'), at(y, 7)])).toBeNull();
    expect(revisionOrderBreak([at(x, 2), at(y, 9), at(x, 2)])).toBe(2);
    expect(revisionOrderBreak([at(x, 3), at(y, 1), at(x, 2)])).toBe(2);
    expect(revisionOrderBreak([reread([IMAGES[0]], undefined, 2), reread([IMAGES[0]], undefined, 3)])).toBeNull();
    expect(revisionOrderBreak([reread([IMAGES[0]], undefined, 3), reread([IMAGES[0]], undefined, 2)])).toBe(1);
  });
});

describe('order facts and image IDs', () => {
  it('compares every fact but the display-only image ID, collections in any order', () => {
    const a = order(IMAGES[0]), b = order(undefined, IMAGES[1]);
    expect([...orderFactKinds(a, b)]).toEqual([]);
    b.summary = [...b.summary!].reverse(); b.items = [...b.items].reverse();
    expect([...orderFactKinds(a, b)]).toEqual([]);
    const changed = (change: (o: OrderObservation) => void) => { const o = order(); change(o); return [...orderFactKinds(o, a)]; };
    expect(changed(o => { o.total!.amountMinor = 1200; })).toEqual(['order-total']);
    expect(changed(o => { o.date = '2026-09-02'; })).toEqual(['order-date']);
    expect(changed(o => { o.items[1].itemId = null; })).toEqual(['order-items']);
    expect(changed(o => { o.items.pop(); })).toEqual(['order-items']);
    expect(changed(o => { o.paymentMethods![0].last4 = '9002'; })).toEqual(['order-methods']);
    expect(changed(o => { o.summary!.pop(); })).toEqual(['order-summary']);
    expect(changed(o => { o.refundSummary = { currency: 'USD', amountMinor: 300 }; })).toEqual(['order-refund-total']);
    expect(changed(o => { o.tenderProof!.unknownSummary = true; })).toEqual(['order-proofs']);
    expect(changed(o => { delete o.itemProof; })).toEqual(['order-proofs']);
  });
  it('counts the displayed lines whose image ID was added, replaced or removed', () => {
    expect(imageIdChanges(order(), order(IMAGES[0], IMAGES[1]))).toEqual({ added: 2, replaced: 0, removed: 0 });
    expect(imageIdChanges(order(IMAGES[0]), order(IMAGES[0], IMAGES[1]))).toEqual({ added: 1, replaced: 0, removed: 0 });
    expect(imageIdChanges(order(IMAGES[0], IMAGES[1]), order(IMAGES[2]))).toEqual({ added: 0, replaced: 1, removed: 1 });
    expect(imageIdChanges(null, order(IMAGES[0]))).toEqual({ added: 1, replaced: 0, removed: 0 });
  });
});

describe('the change log', () => {
  it('logs every table, nets a rebuilt or restored row to nothing, and rolls back with its write', async () => {
    await importAmazonCapture(db(), first(), backup());
    const before = tables();
    expect(() => db().transaction(() => {
      installChangeLog(db());
      reconcileAmazon(db(), NOW);
      db().prepare("UPDATE amazon_orders SET beneficiary='alex'").run();
      db().prepare('UPDATE amazon_orders SET beneficiary=NULL').run();
      expect(readChangeLog(db()).size).toBe(0);
      db().prepare("UPDATE amazon_orders SET beneficiary='joint'").run();
      db().prepare("UPDATE card_transactions SET user_category='Synthetic',revision=revision+1").run();
      const changes = readChangeLog(db());
      expect([...changes.keys()].sort()).toEqual(['amazon_orders', 'card_transactions']);
      expect(changes.get('amazon_orders')!.removed.map(({ row }) => row.beneficiary)).toEqual([null]);
      expect(changes.get('amazon_orders')!.added.map(({ row }) => row.beneficiary)).toEqual(['joint']);
      throw new Error('synthetic rollback');
    })()).toThrow('synthetic rollback');
    expect(tables()).toEqual(before);
    expect(() => installChangeLog(db())).toThrow('amazon input refused');
  });
  it('logs every value exactly: text past an embedded NUL, blobs and reals tell apart, the same value still nets out', () => {
    db().exec('CREATE TABLE synthetic_values(id INTEGER PRIMARY KEY, t TEXT, b BLOB, r REAL)');
    db().prepare('INSERT INTO synthetic_values VALUES(1,?,?,?)').run('synthetic\0before', Buffer.from([0, 1]), 0.3);
    const rewrite = (t: string, b: Buffer, r: number) => db().prepare('UPDATE synthetic_values SET t=?,b=?,r=?').run(t, b, r);
    expect(() => db().transaction(() => {
      installChangeLog(db());
      rewrite('synthetic\0before', Buffer.from([0, 1]), 0.3);
      expect(readChangeLog(db()).size).toBe(0);
      rewrite('synthetic\0after', Buffer.from([0, 2]), 0.1 + 0.2);
      const change = readChangeLog(db()).get('synthetic_values')!;
      expect(change.removed.map(({ row }) => row)).toEqual([{ id: 1, t: 'synthetic\0before', b: Buffer.from([0, 1]), r: 0.3 }]);
      expect(change.added.map(({ row }) => row)).toEqual([{ id: 1, t: 'synthetic\0after', b: Buffer.from([0, 2]), r: 0.1 + 0.2 }]);
      // Each value's exact image: its type, then its bytes or SQLite's exact rendering.
      expect(change.added[0].cells).toEqual({ id: 'i1', t: `t${Buffer.from('synthetic\0after').toString('hex').toUpperCase()}`,
        b: 'b0002', r: 'r3.000000000000000445e-01' });
      throw new Error('synthetic rollback');
    })()).toThrow('synthetic rollback');
  });
  it('logs an update that moves a rowid, which no row image shows, and never nets it out', () => {
    db().exec(`CREATE TABLE synthetic_keyed(k TEXT PRIMARY KEY, v TEXT); INSERT INTO synthetic_keyed VALUES('a','synthetic');
      CREATE TABLE synthetic_keyless(v TEXT); INSERT INTO synthetic_keyless VALUES('synthetic');`);
    expect(() => db().transaction(() => {
      installChangeLog(db());
      db().exec('UPDATE synthetic_keyed SET rowid=rowid+1; UPDATE synthetic_keyless SET rowid=rowid+1');
      const changes = readChangeLog(db());
      expect([...changes].map(([table, { added, removed, moved }]) => [table, added.length, removed.length, moved]))
        .toEqual([['synthetic_keyed', 0, 0, 1], ['synthetic_keyless', 0, 0, 1]]);
      throw new Error('synthetic rollback');
    })()).toThrow('synthetic rollback');
  });
  it('finds a repeated key in any JSON object, by its decoded name', () => {
    for (const text of ['{"a":1,"a":2}', '{"date":"2024-01-01","items":[],"date":"2026-09-01"}', '[{"a":{"b":1,"b":1}}]',
      '{"a":1,"\\u0061":2}', '{"x":{"a":1},"y":{"a":2},"x":3}']) expect(hasDuplicateKeys(text), text).toBe(true);
    for (const text of ['{"a":1,"b":{"a":2}}', '[{"a":1},{"a":2}]', '{"a":"a,\\"a\\":1","b":["a","a"]}', '"a"', '{}', '[]', '1'])
      expect(hasDuplicateKeys(text), text).toBe(false);
  });
  it('reads stored JSON only from a text cell holding exactly JSON.stringify of its reading', () => {
    const text = (value: string | Buffer) => `t${Buffer.from(value).toString('hex').toUpperCase()}`;
    const canonical = JSON.stringify({ date: '2026-09-01', total: { currency: 'USD', amountMinor: 1100 }, title: 'Synthetic \ufffd' });
    expect(canonicalJson(text(canonical))).toEqual(JSON.parse(canonical));
    // Its key order is the writer's own: the caller pins the bytes where that matters.
    expect(canonicalJson(text('{"total":{"amountMinor":1100,"currency":"USD"},"date":"2026-09-01"}'))).toBeDefined();
    const invalid = Buffer.concat([Buffer.from(canonical).subarray(0, -5), Buffer.from([0x80]), Buffer.from('"}')]);
    for (const image of [text(canonical.replace(':1100', ':1100.0')), text(canonical.replace(':1100', ':1100e0')),
      text(canonical.replace(':1100', ':11e2')), text(JSON.stringify(JSON.parse(canonical), null, 1)),
      text(canonical.replace('"date"', '"\\u0064ate"')), text(canonical.replace('"2026', '"\\u0032026')),
      text(`{"date":"2024-01-01",${canonical.slice(1)}`), text(invalid), text('{"a":9007199254740993}'), text('not json'),
      `b${Buffer.from(canonical).toString('hex').toUpperCase()}`, 'i5', 'n', undefined]) {
      expect(canonicalJson(image), image).toBeUndefined();
    }
  });
});

describe('a verified rollback', () => {
  it('holds only when every changed row, the schema and the counters are back as they were', async () => {
    await importAmazonCapture(db(), first(), backup());
    db().exec(`CREATE TABLE synthetic_counted(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
      CREATE TABLE synthetic_keyless(v TEXT); INSERT INTO synthetic_counted(v) VALUES('one');`);
    // Runs `write` in a savepoint inside one transaction, rolls the savepoint back unless `keep`, then checks it.
    const attempt = (write: () => void, keep = false) => db().transaction(() => {
      const baseline = rollbackBaseline(db());
      let changes: ReturnType<typeof readChangeLog> | undefined;
      try {
        db().transaction(() => {
          installChangeLog(db());
          write();
          changes = readChangeLog(db());
          if (!keep) throw new Error('synthetic refusal');
        })();
      } catch { /* the savepoint rolled back */ }
      const verified = verifyRolledBack(db(), baseline, changes);
      if (keep) throw new Error(`synthetic undo ${verified}`);
      return verified;
    })();
    const ordinary = () => {
      db().prepare("UPDATE amazon_orders SET beneficiary='joint'").run();
      db().prepare("INSERT INTO synthetic_counted(v) VALUES('two')").run();
      db().prepare("DELETE FROM synthetic_counted WHERE v='one'").run();
    };
    expect(attempt(ordinary)).toBe(true);
    expect(() => attempt(ordinary, true)).toThrow('synthetic undo false');
    expect(attempt(() => db().exec('CREATE TABLE synthetic_new(v TEXT)'))).toBe(true);
    expect(() => attempt(() => db().exec('CREATE TABLE synthetic_new(v TEXT)'), true)).toThrow('synthetic undo false');
    // A changed table without a primary key cannot be checked row by row: not verified. Nor can a moved rowid.
    expect(attempt(() => db().prepare("INSERT INTO synthetic_keyless VALUES('x')").run())).toBe(false);
    expect(attempt(() => db().prepare('UPDATE synthetic_counted SET id=id+10').run())).toBe(false);
    expect(verifyRolledBack(db(), rollbackBaseline(db()), undefined)).toBe(false);
  });
});

describe('a classified re-read', () => {
  it('keeps a re-read that only adds image IDs: the owner category is carried, and the card link and totals stay', async () => {
    await importAmazonCapture(db(), first(), backup());
    const items = shownItems();
    db().prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(items[0].ref, 'Synthetic owner choice');
    db().prepare('INSERT INTO amazon_agent_categories VALUES(?,?,?,?,?)').run(productKey({ asin: 'SYNTH00002',
      title: 'Synthetic second widget' }), 'Shopping', 0.9, 'agent', 'categorized from product title');
    const before = measures();
    expect(before.matches).toEqual([expect.objectContaining({ state: 'linked' })]);
    expect(before.items).toEqual([expect.arrayContaining(['Synthetic owner choice', 'item-override']),
      expect.arrayContaining(['Shopping', 'agent-classification'])]);
    expect(await classify(reread([IMAGES[0], IMAGES[1]]))).toEqual({ class: 'image-ids-only', display: 'replaced',
      imageIds: { added: 2, replaced: 0, removed: 0 }, changed: [], kept: true });
    expect(displayed().items.map(i => i.imageId)).toEqual([IMAGES[0], IMAGES[1]]);
    expect(measures()).toEqual(before);
    expect(audits('item-override-carried')).toBe(1);
  });
  it('keeps a re-read that adds the image ID a line still lacks', async () => {
    await importAmazonCapture(db(), first(IMAGES[0]), backup());
    expect(await classify(reread([IMAGES[0], IMAGES[1]]))).toMatchObject({ class: 'image-ids-only',
      imageIds: { added: 1, replaced: 0, removed: 0 }, kept: true });
  });
  it.each<[string, (o: OrderObservation) => void, string, Partial<Record<'display', string>>]>([
    ['a Refund Total', o => { o.refundSummary = { currency: 'USD', amountMinor: 300 }; }, 'order-refund-total', { display: 'replaced' }],
    ['a changed line price', o => { o.items[0].unitPrice!.amountMinor = 400; o.items[1].unitPrice!.amountMinor = 600; },
      'order-items', { display: 'kept' }],
    ['an item list it could not prove whole', o => { o.itemProof = { complete: false, unknownLine: true, conflict: false }; },
      'order-proofs', { display: 'kept' }],
    ['another order', o => { o.orderId = '000-0000001-0000002'; }, 'order-new', { display: 'new' }],
  ])('refuses and rolls back a re-read with %s', async (_, change, kind, expected) => {
    await importAmazonCapture(db(), first(), backup());
    const before = tables();
    const result = await classify(reread([IMAGES[0]], change));
    expect(result).toMatchObject({ class: 'facts-changed', kept: false, ...expected });
    expect(result.changed).toContain(kind);
    expect(tables()).toEqual(before);
  });
  it('refuses a re-read carrying refund evidence: new refund records and events', async () => {
    await importAmazonCapture(db(), first(), backup());
    const before = tables();
    const result = await classify(withRefundEvidence(reread([IMAGES[0]]), [syntheticEvidence()]));
    expect(result).toMatchObject({ class: 'facts-changed', display: 'replaced', kept: false });
    expect(result.changed).toEqual(expect.arrayContaining(['refund-evidence', 'refund-events']));
    expect(tables()).toEqual(before);
  });
  it('refuses a replaced or a lost image ID', async () => {
    await importAmazonCapture(db(), first(IMAGES[0], IMAGES[1]), backup());
    expect(await classify(reread([IMAGES[2], IMAGES[1]]))).toMatchObject({ class: 'facts-changed', kept: false,
      imageIds: { added: 0, replaced: 1, removed: 0 }, changed: ['image-ids-replaced'] });
    expect(await classify(reread([IMAGES[0]]))).toMatchObject({ class: 'facts-changed', kept: false,
      imageIds: { added: 0, replaced: 0, removed: 1 }, changed: ['image-ids-removed'] });
  });
  it('refuses a re-read that adds no image ID, and an exact repeat', async () => {
    await importAmazonCapture(db(), first(IMAGES[0], IMAGES[1]), backup());
    expect(await classify(reread([IMAGES[0], IMAGES[1]]))).toEqual({ class: 'no-new-image-ids', display: 'replaced',
      imageIds: { added: 0, replaced: 0, removed: 0 }, changed: [], kept: false });
    await importAmazonCapture(db(), first(), backup());
    const capture = reread([IMAGES[0], IMAGES[1]], undefined, 3);
    await importAmazonCapture(db(), capture, backup());
    expect(await classify(capture)).toMatchObject({ class: 'already-imported', display: 'kept', kept: false });
  });
  it('refuses a re-read whose import would land a card change pending since the last Amazon write, until a reconcile', async () => {
    await importAmazonCapture(db(), first(), backup());
    addCardRow('AMAZON SYNTHETIC LATER');
    const before = tables();
    const result = await classify(reread([IMAGES[0]]));
    expect(result).toMatchObject({ class: 'facts-changed', display: 'replaced', kept: false });
    expect(result.changed).toContain('card-links');
    expect(tables()).toEqual(before);
    await backedUpWrite(db(), backup(), () => reconcileAmazon(db(), NOW));
    expect(await classify(reread([IMAGES[0]]))).toMatchObject({ class: 'image-ids-only', kept: true });
  });
  // TIP_SPLIT_POLICY (#244, Root 05:28Z): fail-closed for a tipped order stored before its split subjects existed.
  it('refuses an image-only re-read of a tipped order stored before its split subjects, until one import writes them', async () => {
    // The synthetic order with a 200 driver tip, 1300 in all: its order part, 1100, is the synthetic Amazon card charge.
    const tipped = (o: OrderObservation) => {
      o.total = { currency: 'USD', amountMinor: 1300 };
      o.summary = [...o.summary!.filter(s => s.kind !== 'grand-total'), { kind: 'tip', money: { currency: 'USD', amountMinor: 200 } },
        { kind: 'grand-total', money: { currency: 'USD', amountMinor: 1300 } }];
    };
    const capture = first();
    tipped(capture.staging.orders[0]);
    await importAmazonCapture(db(), capture, backup());
    const orderId = capture.staging.orders[0].orderId, parts = [splitRef(orderId, 'order'), splitRef(orderId, 'tip')];
    const linked = () => db().prepare("SELECT subject_ref FROM amazon_matches WHERE state='linked'").pluck().all();
    expect(linked()).toEqual([parts[0]]);
    // As an import before TIP_SPLIT_POLICY left it: no split subject, nor its order link, match, candidate or audit.
    for (const ref of parts) {
      for (const table of ['amazon_matches', 'amazon_candidates', 'amazon_event_orders', 'amazon_audit']) {
        db().prepare(`DELETE FROM ${table} WHERE subject_ref=?`).run(ref);
      }
      db().prepare('DELETE FROM amazon_subjects WHERE ref=?').run(ref);
    }
    expect(linked()).toEqual([]);
    const before = tables();
    const refused = await classify(reread([IMAGES[0]], tipped));
    expect(refused).toMatchObject({ class: 'facts-changed', display: 'replaced', kept: false });
    expect(refused.changed).toEqual(['subjects', 'card-links', 'card-candidates']);
    expect(tables()).toEqual(before);
    // One ordinary import of a new read of the order writes its split subjects; its image-only re-read then batches.
    await importAmazonCapture(db(), reread([], tipped, 3), backup());
    expect(linked()).toEqual([parts[0]]);
    expect(await classify(reread([IMAGES[0]], tipped, 4))).toEqual({ class: 'image-ids-only', display: 'replaced',
      imageIds: { added: 1, replaced: 0, removed: 0 }, changed: [], kept: true });
    expect(linked()).toEqual([parts[0]]);
  });
  it('refuses a write the importer never makes, in any table', async () => {
    await importAmazonCapture(db(), first(), backup());
    // Synthetic side effects of a display move, standing in for any write a later change might add.
    db().exec(`CREATE TABLE synthetic_side(n INTEGER); CREATE TABLE amazon_synthetic_side(n INTEGER);
      CREATE TABLE amazon_fresh_synthetic_side(n INTEGER);
      CREATE TRIGGER synthetic_side_effect AFTER UPDATE ON amazon_orders BEGIN
        INSERT INTO synthetic_side VALUES(1); INSERT INTO amazon_synthetic_side VALUES(1);
        INSERT INTO amazon_fresh_synthetic_side VALUES(1); END;`);
    const result = await classify(reread([IMAGES[0]]));
    expect(result).toMatchObject({ class: 'facts-changed', kept: false });
    expect(result.changed).toEqual(expect.arrayContaining(['non-amazon', 'other-amazon', 'fresh-lists']));
  });
  it('refuses a replaced display whose lines would not keep their owner categories', async () => {
    await importAmazonCapture(db(), first(), backup());
    db().prepare('INSERT INTO amazon_item_overrides VALUES(?,?)').run(shownItems()[0].ref, 'Synthetic owner choice');
    // A synthetic loss of the carried override, standing in for any change that would drop one.
    db().exec(`CREATE TRIGGER synthetic_drop_carry AFTER INSERT ON amazon_item_overrides BEGIN
      DELETE FROM amazon_item_overrides WHERE item_ref=NEW.item_ref; END;`);
    const result = await classify(reread([IMAGES[0]]));
    expect(result).toMatchObject({ class: 'facts-changed', display: 'replaced', kept: false });
    // Its carry audit is left with no carried row too.
    expect(result.changed).toEqual(['categories', 'audit-other']);
  });
  // The independent review's repros at 33607746 (reviewer 5b01e72f): each is now refused and rolled back.
  it('refuses a capture whose write would install a missing Amazon table', async () => {
    await importAmazonCapture(db(), first(), backup());
    db().exec('DROP TABLE amazon_line_joins; DROP TABLE amazon_shipments;');
    const before = tables();
    const result = await classify(reread([IMAGES[0]]));
    expect(result).toMatchObject({ class: 'facts-changed', kept: false });
    expect(result.changed).toContain('schema');
    expect(tables()).toEqual(before);
  });
  it('refuses a change past an embedded NUL in any other table', async () => {
    await importAmazonCapture(db(), first(), backup());
    db().exec('CREATE TABLE synthetic_side(v TEXT)');
    db().prepare('INSERT INTO synthetic_side VALUES(?)').run('synthetic\0before');
    db().exec(`CREATE TRIGGER synthetic_side_write AFTER UPDATE ON amazon_orders BEGIN
      UPDATE synthetic_side SET v='synthetic'||char(0)||'after'; END;`);
    expect(await classify(reread([IMAGES[0]]))).toMatchObject({ class: 'facts-changed', kept: false, changed: ['non-amazon'] });
    expect(db().prepare('SELECT v FROM synthetic_side').pluck().get()).toBe('synthetic\0before');
  });
  it('refuses a write that moves an AUTOINCREMENT counter, even with its row gone again', async () => {
    await importAmazonCapture(db(), first(), backup());
    db().exec(`CREATE TABLE synthetic_counted(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
      CREATE TRIGGER synthetic_counted_write AFTER UPDATE ON amazon_orders BEGIN
        INSERT INTO synthetic_counted(v) VALUES('synthetic'); DELETE FROM synthetic_counted; END;`);
    const counter = () => db().prepare("SELECT seq FROM sqlite_sequence WHERE name='synthetic_counted'").pluck().get();
    expect(await classify(reread([IMAGES[0]]))).toMatchObject({ class: 'facts-changed', kept: false, changed: ['non-amazon'] });
    expect(counter()).toBeUndefined();
  });
  it.each([
    ['an item row', `CREATE TRIGGER synthetic_write AFTER INSERT ON amazon_items BEGIN
      UPDATE amazon_items SET data_json=json_set(data_json,'$.unitPrice.amountMinor',123) WHERE ref=NEW.ref; END;`, 'history-changed'],
    ['an item observation', `CREATE TRIGGER synthetic_write AFTER INSERT ON amazon_observations WHEN NEW.family='item' BEGIN
      UPDATE amazon_observations SET data_json=json_set(data_json,'$.unitPrice.amountMinor',123) WHERE ref=NEW.ref; END;`,
    'history-changed'],
    ['the capture row', `CREATE TRIGGER synthetic_write AFTER UPDATE OF receipt_json ON amazon_captures BEGIN
      UPDATE amazon_captures SET window_from='2024-10-20' WHERE digest=NEW.digest; END;`, 'history-changed'],
    ['the display', `CREATE TRIGGER synthetic_write AFTER UPDATE OF data_json ON amazon_orders BEGIN
      UPDATE amazon_orders SET data_json=json_set(data_json,'$.items[0].imageId','91Synth-02L') WHERE ref=NEW.ref; END;`,
    'order-other'],
    ['an audit row', `CREATE TRIGGER synthetic_write AFTER INSERT ON amazon_audit WHEN NEW.action='capture-import' BEGIN
      UPDATE amazon_audit SET after_digest='0' WHERE sequence=NEW.sequence; END;`, 'audit-other'],
  ])('refuses a capture whose own new rows do not hold exactly its facts: %s', async (_, trigger, kind) => {
    await importAmazonCapture(db(), first(), backup());
    db().exec(trigger);
    const before = tables();
    const result = await classify(reread([IMAGES[0]]));
    expect(result).toMatchObject({ class: 'facts-changed', kept: false });
    expect(result.changed).toContain(kind);
    expect(tables()).toEqual(before);
  });
  // The independent review's residual repros at 878e1c99 (reviewer 5b01e72f), and their variants.
  it.each([
    ['a duplicate date put first in the display, which SQLite reads and JavaScript does not', `CREATE TRIGGER synthetic_write
      AFTER UPDATE OF data_json ON amazon_orders BEGIN
      UPDATE amazon_orders SET data_json='{"date":"2024-01-01",'||substr(NEW.data_json,2) WHERE ref=NEW.ref; END;`, 'order-other'],
    ['a duplicate price put first in a new item row', `CREATE TRIGGER synthetic_write AFTER INSERT ON amazon_items BEGIN
      UPDATE amazon_items SET data_json='{"unitPrice":{"currency":"USD","amountMinor":1},'||substr(NEW.data_json,2)
      WHERE ref=NEW.ref; END;`, 'history-changed'],
    ['an extra kept-details audit', `CREATE TRIGGER synthetic_write AFTER INSERT ON amazon_items BEGIN
      INSERT INTO amazon_audit(action,subject_ref,before_digest,after_digest,policy_digest,created_at)
      VALUES('header-only-kept-details',NULL,'synthetic-before','synthetic-after','synthetic-policy','synthetic-time'); END;`,
    'audit-other'],
    ['no display audit', `CREATE TRIGGER synthetic_write AFTER INSERT ON amazon_audit WHEN NEW.action='order-observation' BEGIN
      DELETE FROM amazon_audit WHERE sequence=NEW.sequence; END;`, 'audit-other'],
    ['a moved rowid in another table', `CREATE TABLE synthetic_side(v TEXT); INSERT INTO synthetic_side VALUES('synthetic');
      CREATE TRIGGER synthetic_write AFTER UPDATE ON amazon_orders BEGIN UPDATE synthetic_side SET rowid=rowid+1; END;`,
    'non-amazon'],
  ])('refuses a capture whose write leaves %s', async (_, trigger, kind) => {
    await importAmazonCapture(db(), first(), backup());
    db().exec(trigger);
    const before = tables();
    const result = await classify(reread([IMAGES[0]]));
    expect(result).toMatchObject({ class: 'facts-changed', kept: false });
    expect(result.changed).toContain(kind);
    expect(tables()).toEqual(before);
  });
  // Root (01:30Z), after #222: stored JSON is read only in exactly the importer's JSON.stringify form, and anything else
  // refuses. The display before is pinned byte for byte to the importer's JSON of the re-read's order with that
  // display's own image IDs; the subject before, to the importer's JSON of the subject. Each variant keeps every fact as
  // JavaScript reads it (the reviewer's probes at e04b6ab1, 5b01e72f), so only the stored form tells it apart.
  const storedForms: Array<[string, (text: string) => string]> = [
    ['an amount written as a decimal (1100.0)', text => text.replace(/("amountMinor":)(-?\d+)/g, '$1$2.0')],
    ['an amount written with an exponent (1100e0)', text => text.replace(/("amountMinor":)(-?\d+)/g, '$1$2e0')],
    ['whitespace', text => JSON.stringify(JSON.parse(text), null, 1)],
    ['another key order', text => {
      const { date, ...rest } = JSON.parse(text) as Record<string, unknown>;
      return JSON.stringify({ ...rest, date });
    }],
    ['an escaped key', text => text.replace('"date":', '"\\u0064ate":')],
    ['an escaped value', text => {
      const date = (JSON.parse(text) as { date: string }).date;
      return text.replace(JSON.stringify(date), `"\\u00${date.charCodeAt(0).toString(16)}${date.slice(1)}"`);
    }],
    ['a repeated key', text => `{"date":"2024-01-01",${text.slice(1)}`],
  ];
  /** Rewrites a table's stored JSON to exactly the given bytes, as TEXT. */
  const restore = (table: string, transform: (text: string) => string | Buffer) => {
    for (const { id, text } of db().prepare(`SELECT rowid AS id,data_json AS text FROM ${table}`).all() as Array<{ id: number; text: string }>) {
      const out = transform(text);
      expect(Buffer.from(out).equals(Buffer.from(text)), 'a variant').toBe(false);
      db().prepare(`UPDATE ${table} SET data_json=CAST(? AS TEXT) WHERE rowid=?`).run(Buffer.from(out), id);
    }
  };
  it.each([
    ...storedForms,
    ['its items\' keys in another order', (text: string) => {
      const order = JSON.parse(text) as { items: Array<Record<string, unknown>> };
      order.items = order.items.map(({ title, ...line }) => ({ ...line, title }));
      return JSON.stringify(order);
    }],
    ['the JSON null', () => 'null'],
  ])('refuses a re-read over a display stored with %s, not as the importer writes it', async (_, transform) => {
    await importAmazonCapture(db(), first(), backup());
    restore('amazon_orders', transform);
    const before = tables();
    expect(await classify(reread([IMAGES[0]]))).toMatchObject({ class: 'facts-changed', display: 'replaced', kept: false,
      changed: ['order-stored-form'] });
    expect(tables()).toEqual(before);
  });
  it('refuses a re-read over a display stored with invalid UTF-8 the driver decodes to the same text', async () => {
    const titled = (o: OrderObservation) => { o.items[0].title = 'Synthetic replacement \ufffd'; };
    const firstRead = first();
    titled(firstRead.staging.orders[0]);
    await importAmazonCapture(db(), firstRead, backup());
    restore('amazon_orders', text => {
      const bytes = Buffer.from(text), at = bytes.indexOf(Buffer.from('\ufffd'));
      expect(at).toBeGreaterThan(0);
      return Buffer.concat([bytes.subarray(0, at), Buffer.from([0x80]), bytes.subarray(at + 3)]);
    });
    expect(db().prepare('SELECT data_json FROM amazon_orders').pluck().get()).toContain('\ufffd');
    const before = tables();
    expect(await classify(reread([IMAGES[0]], titled))).toMatchObject({ class: 'facts-changed', kept: false,
      changed: ['order-stored-form'] });
    expect(tables()).toEqual(before);
  });
  it('refuses a re-read over a display stored as a BLOB cell', async () => {
    await importAmazonCapture(db(), first(), backup());
    db().exec('UPDATE amazon_orders SET data_json=CAST(data_json AS BLOB)');
    const before = tables();
    expect(await classify(reread([IMAGES[0]]))).toMatchObject({ class: 'facts-changed', kept: false, changed: ['order-stored-form'] });
    expect(tables()).toEqual(before);
    expect(db().prepare('SELECT typeof(data_json) FROM amazon_orders').pluck().get()).toBe('blob');
  });
  it.each(storedForms)('refuses a re-read over an order-total subject stored with %s', async (_, transform) => {
    await importAmazonCapture(db(), first(), backup());
    restore('amazon_subjects', transform);
    const before = tables();
    const result = await classify(reread([IMAGES[0]]));
    expect(result).toMatchObject({ class: 'facts-changed', kept: false });
    expect(result.changed).toContain('subjects');
    expect(tables()).toEqual(before);
  });
  it('keeps a display it does not replace only with exactly its kept-details audit, and never as image-IDs-only', async () => {
    await importAmazonCapture(db(), first(), backup());
    // A read whose item list is not proven whole is history only: the display is kept, with the importer's one audit.
    const unproven = await classify(reread([IMAGES[0]], o => { o.itemProof = { complete: false, unknownLine: true, conflict: false }; }));
    expect(unproven).toMatchObject({ class: 'facts-changed', display: 'kept', kept: false, changed: ['order-proofs'] });
    expect(audits('conflicting-observation-kept-details') + audits('poorer-observation-kept-details')).toBe(0);
  });
});

describe('the preview baseline', () => {
  it('reports what the importer\'s own recheck would change before any capture, then settles', async () => {
    await importAmazonCapture(db(), first(), backup());
    expect(settleBaseline(db(), NOW)).toEqual([]);
    addCardRow('AMAZON SYNTHETIC LATER');
    expect(settleBaseline(db(), NOW)).toContain('card-links');
    expect(settleBaseline(db(), NOW)).toEqual([]);
  });
});

describe('the preview clone', () => {
  it('copies the database whole, and refuses a source in a transaction before it creates anything', async () => {
    const before = tablesAndCounts(db());
    expect(before).toContainEqual(['card_accounts', 1]);
    const clone = backup();
    await makeClone(db(), clone);
    const copy = new Database(clone, { readonly: true, fileMustExist: true });
    try {
      expect(tablesAndCounts(copy)).toEqual(before);
    } finally {
      copy.close();
    }
    // A backup of a source in a write transaction resolves with nothing copied (better-sqlite3 takes a first busy step
    // as done: the backup sweep, 11/09). Any transaction on the source is refused, and the clone is never made.
    for (const begin of ['BEGIN', 'BEGIN IMMEDIATE']) {
      const refused = backup();
      db().exec(begin);
      try {
        await expect(makeClone(db(), refused), begin).rejects.toThrow('amazon backup refused');
      } finally {
        db().exec('ROLLBACK');
      }
      expect(fs.existsSync(refused), begin).toBe(false);
    }
    expect(tablesAndCounts(db())).toEqual(before);
  });
});

describe('Root\'s GO-reuse rule', () => {
  const go = { goId: 'b'.repeat(32), goDigest: digest({ synthetic: 'batch go' }) };
  const prepared = (inputs: unknown[]) =>
    Promise.all(inputs.map(async input => ({ inputDigest: digest(input), capture: await validateCapture(input) })));
  const refusals = () => db().prepare("SELECT subject_ref,before_digest FROM amazon_audit WHERE action='capture-batch-refused'").all();
  /** Every table as before, but for the audit rows a run appended. */
  const unchangedBut = (before: ReturnType<typeof tables>, audits: number) => {
    const after = tables();
    expect(after.amazon_audit.length).toBe(before.amazon_audit.length + audits);
    expect({ ...after, amazon_audit: after.amazon_audit.slice(0, before.amazon_audit.length) }).toEqual(before);
  };
  it('records a GO\'s attempts, refusals and use by digest only, and reuses a GO only unused, logged and as the same artifact', async () => {
    await importAmazonCapture(db(), first(), backup());
    const edited = { ...go, goDigest: digest({ synthetic: 'edited go' }) };
    expect([batchGoState(db(), go), batchGoReusable(db(), go)]).toEqual(['unused', true]);
    expect(() => recordBatchGo(db(), go.goId, go.goDigest, NOW)).toThrow('amazon input refused');
    // An attempt whose refusal is not logged (yet, or ever) leaves the GO unusable, so a second run cannot start.
    recordBatchAttempt(db(), go, NOW);
    expect([batchGoState(db(), go), batchGoReusable(db(), go)]).toEqual(['unlogged', false]);
    expect(() => recordBatchAttempt(db(), go, NOW)).toThrow('amazon input refused');
    const refusal: BatchRefusal = { stage: 'preview', index: 0, inputDigest: '0'.repeat(64), reason: 'facts-changed',
      changed: ['card-links'], rollback: 'not-started' };
    recordBatchRefusal(db(), go, refusal, NOW, false);
    expect(batchGoLog(db(), go.goId)).toEqual({ attempts: 1, refusals: 1, goDigests: [go.goDigest] });
    expect([batchGoUsed(db(), go.goId), batchGoState(db(), go), batchGoReusable(db(), go)]).toEqual([false, 'unused', true]);
    // The same goId as another artifact is never reused.
    expect(batchGoState(db(), edited)).toBe('edited');
    expect(() => recordBatchAttempt(db(), edited, NOW)).toThrow('amazon input refused');
    await backedUpWrite(db(), backup(), () => recordBatchGo(db(), go.goId, go.goDigest, NOW));
    expect([batchGoState(db(), go), batchGoReusable(db(), go)]).toEqual(['consumed', false]);
    expect(() => recordBatchAttempt(db(), go, NOW)).toThrow('amazon input refused');
    await expect(backedUpWrite(db(), backup(), () => recordBatchGo(db(), go.goId, go.goDigest, NOW))).rejects.toThrow();
    expect(JSON.stringify(db().prepare("SELECT * FROM amazon_audit WHERE action LIKE 'capture-batch-%'").all())).not.toContain(go.goId);
  });
  it('a refused first capture, verified rolled back, leaves the GO unused with its refusal logged; a retry may use it', async () => {
    await importAmazonCapture(db(), first(), backup());
    addCardRow('AMAZON SYNTHETIC LATER');
    const before = tables();
    const run = runBatchCaptures(db(), go, await prepared([reread([IMAGES[0]])]), () => NOW);
    expect(run.imported).toBe(0);
    expect(run.refusal).toMatchObject({ stage: 'database', index: 0, reason: 'facts-changed', rollback: 'verified', logged: true });
    expect(run.refusal!.changed).toContain('card-links');
    expect(batchGoUsed(db(), go.goId)).toBe(false);
    expect(refusals()).toEqual([{ subject_ref: expect.stringMatching(/^[a-f0-9]{64}$/), before_digest: go.goDigest }]);
    // Its attempt and its refusal.
    unchangedBut(before, 2);
    // After a reconcile the same GO runs again, and its committed capture consumes it.
    await backedUpWrite(db(), backup(), () => reconcileAmazon(db(), NOW));
    expect(batchGoReusable(db(), go)).toBe(true);
    expect(runBatchCaptures(db(), go, await prepared([reread([IMAGES[0]])]), () => NOW)).toMatchObject({ imported: 1, refusal: null });
    expect([batchGoUsed(db(), go.goId), batchGoReusable(db(), go)]).toEqual([true, false]);
    expect(batchGoLog(db(), go.goId)).toEqual({ attempts: 2, refusals: 1, goDigests: [go.goDigest] });
  });
  it('a first capture that fails in the importer is rolled back, verified, and keeps the GO', async () => {
    await importAmazonCapture(db(), first(), backup());
    db().exec("CREATE TRIGGER synthetic_abort BEFORE INSERT ON amazon_items BEGIN SELECT RAISE(ABORT, 'synthetic abort'); END;");
    const before = tables();
    const run = runBatchCaptures(db(), go, await prepared([reread([IMAGES[0]])]), () => NOW);
    expect(run.refusal).toMatchObject({ stage: 'database', index: 0, reason: 'operation-failed', rollback: 'verified', logged: true });
    expect(JSON.stringify(run)).not.toContain('synthetic abort');
    expect(batchGoState(db(), go)).toBe('unused');
    unchangedBut(before, 2);
  });
  it('a refused first capture whose rollback cannot be verified spends the GO', async () => {
    await importAmazonCapture(db(), first(), backup());
    // A side write to a table with no primary key: its rows cannot be checked one by one after the rollback.
    db().exec(`CREATE TABLE synthetic_keyless(n INTEGER);
      CREATE TRIGGER synthetic_keyless_write AFTER INSERT ON amazon_items BEGIN INSERT INTO synthetic_keyless VALUES(1); END;`);
    const before = tables();
    const run = runBatchCaptures(db(), go, await prepared([reread([IMAGES[0]])]), () => NOW);
    expect(run.refusal).toMatchObject({ stage: 'database', index: 0, reason: 'facts-changed', changed: ['non-amazon'],
      rollback: 'unverified', logged: true });
    expect(batchGoState(db(), go)).toBe('consumed');
    // Its attempt, its refusal, and the GO recorded as used.
    unchangedBut(before, 3);
  });
  it('commits the GO record with the first capture only as exactly its own row', async () => {
    await importAmazonCapture(db(), first(), backup());
    db().exec(`CREATE TABLE synthetic_side(id INTEGER PRIMARY KEY, n INTEGER);
      CREATE TRIGGER synthetic_go_side AFTER INSERT ON amazon_audit WHEN NEW.action='capture-batch-go' BEGIN
        INSERT INTO synthetic_side(n) VALUES(1); END;`);
    const before = tables();
    const run = runBatchCaptures(db(), go, await prepared([reread([IMAGES[0]])]), () => NOW);
    expect(run.refusal).toMatchObject({ stage: 'database', index: 0, reason: 'facts-changed', changed: ['non-amazon'],
      rollback: 'verified', logged: true });
    expect(run.entries).toEqual([expect.objectContaining({ code: 'refused', class: 'facts-changed', changed: ['non-amazon'] })]);
    expect(batchGoState(db(), go)).toBe('unused');
    unchangedBut(before, 2);
  });
  // The independent review's repros at 33607746 (reviewer 5b01e72f), as a batch's first capture on the database itself
  // (the `classify` tests above run each as a later capture): each is refused, rolled back verified, and logged.
  it.each<[string, () => void, () => unknown, string]>([
    ['a missing Amazon table the write would install', () => db().exec('DROP TABLE amazon_line_joins; DROP TABLE amazon_shipments;'),
      () => db().prepare("SELECT count(*) FROM sqlite_master WHERE name IN ('amazon_line_joins','amazon_shipments')").pluck().get(),
      'schema'],
    ['a change past an embedded NUL in another table', () => {
      // Keyed, so its rollback can be checked row by row: a keyless table's cannot (the GO is then spent, above).
      db().exec('CREATE TABLE synthetic_side(id INTEGER PRIMARY KEY, v TEXT)');
      db().prepare('INSERT INTO synthetic_side(v) VALUES(?)').run('synthetic\0before');
      db().exec(`CREATE TRIGGER synthetic_guard_probe AFTER UPDATE ON amazon_orders BEGIN
        UPDATE synthetic_side SET v='synthetic'||char(0)||'after'; END;`);
    }, () => db().prepare('SELECT v FROM synthetic_side').pluck().get(), 'non-amazon'],
    ['a changed price in a new item row', () => db().exec(`CREATE TRIGGER synthetic_guard_probe AFTER INSERT ON amazon_items BEGIN
      UPDATE amazon_items SET data_json=json_set(data_json,'$.unitPrice.amountMinor',123) WHERE ref=NEW.ref; END;`),
    () => shownItems().map(item => item.unitPrice), 'history-changed'],
    // The residual repros at 878e1c99.
    ['a duplicate date put first in the display', () => db().exec(`CREATE TRIGGER synthetic_probe AFTER UPDATE OF data_json ON amazon_orders
      BEGIN UPDATE amazon_orders SET data_json='{"date":"2024-01-01",'||substr(NEW.data_json,2) WHERE ref=NEW.ref; END;`),
    () => db().prepare("SELECT json_extract(data_json,'$.date') FROM amazon_orders").pluck().get(), 'order-other'],
    ['an extra kept-details audit', () => db().exec(`CREATE TRIGGER synthetic_probe AFTER INSERT ON amazon_items BEGIN
      INSERT INTO amazon_audit(action,subject_ref,before_digest,after_digest,policy_digest,created_at)
      VALUES('header-only-kept-details',NULL,'synthetic-before','synthetic-after','synthetic-policy','synthetic-time'); END;`),
    () => audits('header-only-kept-details'), 'audit-other'],
    ['no display audit', () => db().exec(`CREATE TRIGGER synthetic_probe AFTER INSERT ON amazon_audit WHEN NEW.action='order-observation'
      BEGIN DELETE FROM amazon_audit WHERE sequence=NEW.sequence; END;`), () => audits('order-observation'), 'audit-other'],
  ])('refuses the review repro with %s as a first capture on the database', async (_, install, probe, kind) => {
    await importAmazonCapture(db(), first(), backup());
    install();
    const before = tables(), value = probe();
    const run = runBatchCaptures(db(), go, await prepared([reread([IMAGES[0]])]), () => NOW);
    expect(run).toMatchObject({ imported: 0, refusal: { stage: 'database', index: 0, reason: 'facts-changed', rollback: 'verified',
      logged: true } });
    expect(run.refusal!.changed).toContain(kind);
    expect([probe(), batchGoState(db(), go)]).toEqual([value, 'unused']);
    unchangedBut(before, 2);
  });
  it('refuses its own bookkeeping row when writing it would change anything else', async () => {
    await importAmazonCapture(db(), first(), backup());
    db().exec(`CREATE TABLE synthetic_side(id INTEGER PRIMARY KEY, n INTEGER);
      CREATE TRIGGER synthetic_attempt_side AFTER INSERT ON amazon_audit WHEN NEW.action='capture-batch-attempt' BEGIN
        INSERT INTO synthetic_side(n) VALUES(1); END;`);
    const before = tables();
    expect(() => recordBatchAttempt(db(), go, NOW)).toThrow('amazon input refused');
    expect(() => runBatchCaptures(db(), go, [], () => NOW)).toThrow('amazon input refused');
    expect(tables()).toEqual(before);
    expect(batchGoState(db(), go)).toBe('unused');
  });
  it('a committed capture consumes the GO: a later refusal is logged, and the rest needs a new GO', async () => {
    await importAmazonCapture(db(), first(), backup());
    const captures = await prepared([reread([IMAGES[0]], undefined, 2),
      reread([IMAGES[0]], o => { o.refundSummary = { currency: 'USD', amountMinor: 300 }; }, 3), reread([IMAGES[0], IMAGES[1]], undefined, 4)]);
    const run = runBatchCaptures(db(), go, captures, () => NOW);
    expect(run.imported).toBe(1);
    expect(run.refusal).toEqual({ stage: 'database', index: 1, inputDigest: captures[1].inputDigest, reason: 'facts-changed',
      changed: ['order-refund-total'], rollback: 'not-checked', logged: true });
    expect(run.entries.map(entry => entry.code)).toEqual(['imported', 'refused', 'not-attempted']);
    expect([batchGoUsed(db(), go.goId), batchGoReusable(db(), go)]).toEqual([true, false]);
  });
  it('a refusal by the run\'s own preview is logged before any capture is written, and leaves the GO unused', async () => {
    await importAmazonCapture(db(), first(), backup());
    const captures = await prepared([reread([IMAGES[0]])]);
    expect(previewRefusal({ baseline: [], outcomes: [] })).toBeNull();
    const refusal = previewRefusal({ baseline: ['card-links'], outcomes: [] })!;
    expect(refusal).toEqual({ stage: 'preview', index: null, inputDigest: null, reason: 'baseline-pending', changed: ['card-links'],
      rollback: 'not-started' });
    const before = tables();
    const run = runBatchCaptures(db(), go, captures, () => NOW, refusal);
    expect(run).toEqual({ imported: 0, refusal: { ...refusal, logged: true },
      entries: [{ index: 0, inputDigest: captures[0].inputDigest, code: 'not-attempted' }] });
    expect(batchGoUsed(db(), go.goId)).toBe(false);
    // Its attempt and its refusal: no capture was written.
    unchangedBut(before, 2);
  });
});
