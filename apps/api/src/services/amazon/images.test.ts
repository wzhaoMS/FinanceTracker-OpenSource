import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { backedUpWrite, importAmazonCapture, recordBindingProposal, recordRootApproval } from './importer.js';
import { placeholderGif, rootApproval, syntheticCapture, syntheticJpeg, syntheticPng, syntheticWebp,
  withSyntheticItems } from './fixtures.testSupport.js';
import { proposeBindings, readCardInventory } from './bindings.js';
import { createAmazonCategoryResolver } from './resolver.js';
import { getAmazonOrder, listAmazonOrders } from './readModel.js';
import { amazonSpending } from './spending.js';
import { opaque, LEDGER_POLICY_DIGEST, POLICY_DIGEST } from './policy.js';
import { AMAZON_SCHEMA_DIGEST } from './schema.js';
import { AMAZON_IMAGE_POLICY, AMAZON_IMAGE_POLICY_DIGEST, AMAZON_IMAGE_SCHEMA_DIGEST, allowedImageUrl, amazonImageGoUsed,
  amazonImageIdUrl, amazonImageUrl, cachedImages, hasAmazonImageIdSchema, hasAmazonImageSchema, hasCachedImage,
  installAmazonImageSchema, isPlaceholderGif, planAmazonImages, readAmazonItemImage, recordAmazonImageGo, sniffImage,
  writeAmazonImageIds, writeAmazonImages, type AmazonImageIdResult, type AmazonImageResult } from './images.js';
import { amazonTaxonomySpending } from './taxonomySpending.js';

// Synthetic only: made-up ASINs (SYNTH00001...), image IDs (91Synth...), titles, order IDs and image bytes.
let dir: string, repo: SqliteStateRepo, backups: number;
const db = () => repo.internalGetDb();
const backup = () => path.join(dir, `backup-${++backups}.db`);
const cache = (results: AmazonImageResult[]) => backedUpWrite(db(), backup(),
  () => writeAmazonImages(db(), results, '2026-10-21T00:00:00.000Z'), installAmazonImageSchema);
const cacheIds = (results: AmazonImageIdResult[]) => backedUpWrite(db(), backup(),
  () => writeAmazonImageIds(db(), results, '2026-10-23T00:00:00.000Z'), installAmazonImageSchema);
const jpeg = (asin: string, label = 'one'): AmazonImageResult => ({ asin, outcome: 'cached', contentType: 'image/jpeg', bytes: syntheticJpeg(label) });
const jpegId = (imageId: string, label = 'by-id'): AmazonImageIdResult =>
  ({ imageId, outcome: 'cached', contentType: 'image/jpeg', bytes: syntheticJpeg(label) });
const NO_IMAGES = { asins: new Set(), imageIds: new Set() };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-images-synthetic-'));
  backups = 0;
  repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  const card = repo.createCardAccount({ issuer: 'chase', owner: 'casey', last4: '9001', currency: 'USD', nickname: 'Synthetic card' });
  repo.importCardTransactions({ cardAccountId: card.id, source: 'synthetic', parserVersion: 'synthetic@1',
    rows: [{ transactionDate: '2026-09-02', status: 'posted', kind: 'purchase', amountMinor: 1100, currency: 'USD',
      description: 'SYNTHETIC RETAIL', issuerCategory: 'Shopping' }] });
});
afterEach(() => { repo.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('image URL policy', () => {
  it('builds the only fetchable URL from a validated ASIN on the allowlisted host', () => {
    expect(amazonImageUrl('SYNTH00001').href).toBe('https://m.media-amazon.com/images/P/SYNTH00001.01._SL160_.jpg');
    expect(AMAZON_IMAGE_POLICY.hosts).toEqual(['m.media-amazon.com']);
    for (const asin of ['synth00001', 'SYNTH0001', 'SYNTH000011', '../SYNTH01', 'SYNTH/0001', 'SYNTH%2F01', 'SYNTH0000 ',
      '', 'SYNTH0000\n', 'SYNTH.0001', 'SYNTH?0001', 'SYNTH#0001', 'SYNTH@0001']) {
      expect(() => amazonImageUrl(asin), JSON.stringify(asin)).toThrow('amazon input refused');
    }
  });
  it('builds the image-ID pass\'s only URL from a validated captured image ID, never from captured URL text', () => {
    expect(amazonImageIdUrl('91SynthAA0L').href).toBe('https://m.media-amazon.com/images/I/91SynthAA0L._SL160_.jpg');
    expect(amazonImageIdUrl('91Synth+01L').href).toBe('https://m.media-amazon.com/images/I/91Synth+01L._SL160_.jpg');
    expect(amazonImageIdUrl('A1Synth-02S').href).toBe('https://m.media-amazon.com/images/I/A1Synth-02S._SL160_.jpg');
    for (const imageId of ['+1SynthAA0L', '-1SynthAA0L', '91SynthAA0+', '91SynthAA0-', '91SynthAA0', '91SynthAA0LL', '91Synth/01L',
      '91Synth.01L', '91Synth%01L', '91Synth 01L', '91Synth?01L', '91Synth#01L', '91Synth_01L', '../SynthA0L', 'SYNTH00001', '',
      '91SynthAA0L\n', 'https://m.media-amazon.com/images/I/91SynthAA0L._SL160_.jpg']) {
      expect(() => amazonImageIdUrl(imageId), JSON.stringify(imageId)).toThrow('amazon input refused');
    }
  });
  it('refuses any other host, scheme, port, credential, query, fragment or path shape', () => {
    expect(allowedImageUrl(new URL('https://M.MEDIA-AMAZON.COM/images/P/SYNTH00001.01._SL160_.jpg'))).toBe(true);
    expect(allowedImageUrl(new URL('https://m.media-amazon.com/images/I/91Synth+01L._SL160_.jpg'))).toBe(true);
    for (const url of [
      'http://m.media-amazon.com/images/P/SYNTH00001.01._SL160_.jpg',
      'https://images-na.ssl-images-amazon.com/images/P/SYNTH00001.01._SL160_.jpg',
      'https://m.media-amazon.com.example.invalid/images/P/SYNTH00001.01._SL160_.jpg',
      'https://example.invalid/images/P/SYNTH00001.01._SL160_.jpg',
      'https://m.media-amazon.com:8443/images/P/SYNTH00001.01._SL160_.jpg',
      'https://user:user6@example.com/images/P/SYNTH00001.01._SL160_.jpg',
      'https://m.media-amazon.com/images/P/SYNTH00001.01._SL160_.jpg?x=1',
      'https://m.media-amazon.com/images/P/SYNTH00001.01._SL160_.jpg#x',
      'https://m.media-amazon.com/images/I/SYNTH00001._SL160_.jpg',
      'https://m.media-amazon.com/images/P/SYNTH00001.01._SL1600_.jpg',
      'https://m.media-amazon.com/images/P/SYNTH%30%30001.01._SL160_.jpg',
      'https://m.media-amazon.com/images/P/SYNTH00001.01._SL160_.jpg/..%2F..%2Fx',
      'http://m.media-amazon.com/images/I/91SynthAA0L._SL160_.jpg',
      'https://images-na.ssl-images-amazon.com/images/I/91SynthAA0L._SL160_.jpg',
      'https://m.media-amazon.com/images/I/91SynthAA0L._SL160_.jpg?x=1',
      'https://m.media-amazon.com/images/I/91SynthAA0L.jpg',
      'https://m.media-amazon.com/images/I/91SynthAA0L._AC_SL1500_.jpg',
      'https://m.media-amazon.com/images/I/91SynthAA0L._SL160_.png',
      'https://m.media-amazon.com/images/I/+1SynthAA0L._SL160_.jpg',
      'https://m.media-amazon.com/images/I/91Synth%2B01L._SL160_.jpg',
      'https://m.media-amazon.com/images/P/91SynthAA0L._SL160_.jpg',
    ]) expect(allowedImageUrl(new URL(url)), url).toBe(false);
  });
  it('accepts only image bytes that prove their type, and recognizes the host\'s 1x1 placeholder', () => {
    expect([syntheticJpeg(), syntheticPng(), syntheticWebp()].map(sniffImage)).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    for (const bytes of [placeholderGif(), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('<html>'),
      Buffer.alloc(0), Buffer.from([0xff, 0xd8])]) expect(sniffImage(bytes)).toBeNull();
    expect(isPlaceholderGif(placeholderGif())).toBe(true);
    expect(isPlaceholderGif(Buffer.concat([Buffer.from('GIF87a'), placeholderGif().subarray(6)]))).toBe(true);
    expect(isPlaceholderGif(placeholderGif(2, 1))).toBe(false);
    expect(isPlaceholderGif(placeholderGif(1, 2))).toBe(false);
    expect(isPlaceholderGif(Buffer.concat([placeholderGif(), Buffer.alloc(1024)]))).toBe(false);
    expect(isPlaceholderGif(syntheticPng())).toBe(false);
  });
  it('keeps the network fetcher out of the API: only the gated operator CLI imports it', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path.join(d, e.name)] : []);
    const importers = files(src).filter(f => /from\s+['"][^'"]*\/imageFetch\.js['"]/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(src, f).split(path.sep).join('/'));
    expect(importers).toEqual(['cli/amazonImages.ts']);
    expect(fs.readFileSync(path.join(src, 'services', 'amazon', 'images.ts'), 'utf8')).not.toMatch(/\bfetch\s*\(/);
  });
});

describe('gated thumbnail cache', () => {
  it('is never created by reads, needs the Amazon schema, and treats a conflicting table as a hold', async () => {
    const plain = new Database(':memory:');
    try {
      expect(() => plain.transaction(() => installAmazonImageSchema(plain))()).toThrow('amazon input refused');
      expect(hasAmazonImageSchema(plain)).toBe(false);
    } finally { plain.close(); }
    await importAmazonCapture(db(), syntheticCapture(), backup());
    const itemRef = getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!.items[0].ref;
    expect(planAmazonImages(db())).toMatchObject({ schema: 'absent', idSchema: 'absent', toFetch: ['SYNTH00001'], toFetchIds: [] });
    expect(readAmazonItemImage(db(), itemRef)).toBeNull();
    expect(cachedImages(db())).toEqual(NO_IMAGES);
    expect(hasAmazonImageSchema(db())).toBe(false);
    expect(hasAmazonImageIdSchema(db())).toBe(false);
    db().exec('CREATE TABLE amazon_product_images(asin TEXT PRIMARY KEY, bytes BLOB)');
    db().prepare('INSERT INTO amazon_product_images VALUES(?,?)').run('SYNTH00001', syntheticJpeg());
    expect(hasAmazonImageSchema(db())).toBe(false);
    expect(() => planAmazonImages(db())).toThrow('amazon input refused');
    expect(readAmazonItemImage(db(), itemRef)).toBeNull();
    expect(cachedImages(db())).toEqual(NO_IMAGES);
    expect(getAmazonOrder(db(), listAmazonOrders(db(), 0, 1).orders[0].ref)!.items[0]).not.toHaveProperty('image');
    const target = backup();
    await expect(backedUpWrite(db(), target, () => writeAmazonImages(db(), [jpeg('SYNTH00001')], 'now'), installAmazonImageSchema))
      .rejects.toThrow();
    expect(db().prepare('SELECT count(*) FROM amazon_product_images').pluck().get()).toBe(1);
    // A conflicting image-ID table is a hold just the same, and the backfill's install never repairs it.
    db().exec('DROP TABLE amazon_product_images; CREATE TABLE amazon_product_image_ids(image_id TEXT PRIMARY KEY)');
    expect(hasAmazonImageIdSchema(db())).toBe(false);
    expect(() => planAmazonImages(db())).toThrow('amazon input refused');
    await expect(backedUpWrite(db(), backup(), () => writeAmazonImages(db(), [jpeg('SYNTH00001')], 'now'), installAmazonImageSchema))
      .rejects.toThrow();
    expect(hasAmazonImageSchema(db())).toBe(false);
    expect(cachedImages(db())).toEqual(NO_IMAGES);
  });
  it('plans every distinct item ASIN once, fetch-once: neither cached nor negative-cached ASINs are planned again', async () => {
    await importAmazonCapture(db(), withSyntheticItems(syntheticCapture(), 3), backup());
    const first = planAmazonImages(db());
    expect(first).toMatchObject({ schema: 'absent', itemsWithAsin: 3, distinctAsins: 3, cached: 0, missing: 0, deferred: 0,
      toFetch: ['SYNTH00001', 'SYNTH00002', 'SYNTH00003'] });
    expect(planAmazonImages(db()).planDigest).toBe(first.planDigest);
    expect(await cache([jpeg('SYNTH00001'), { asin: 'SYNTH00002', outcome: 'missing', reason: 'placeholder' }]))
      .toEqual({ written: 2, unchanged: 0 });
    const second = planAmazonImages(db());
    expect(second).toMatchObject({ schema: 'present', cached: 1, missing: 1, toFetch: ['SYNTH00003'] });
    expect(second.planDigest).not.toBe(first.planDigest);
    // A cached or negative result is never overwritten.
    expect(await cache([jpeg('SYNTH00001', 'two'), jpeg('SYNTH00002')])).toEqual({ written: 0, unchanged: 2 });
    expect(db().prepare('SELECT asin,state,reason,content_type FROM amazon_product_images ORDER BY asin').all()).toEqual([
      { asin: 'SYNTH00001', state: 'cached', reason: null, content_type: 'image/jpeg' },
      { asin: 'SYNTH00002', state: 'missing', reason: 'placeholder', content_type: null },
    ]);
    expect(db().prepare("SELECT bytes FROM amazon_product_images WHERE asin='SYNTH00001'").pluck().get()).toEqual(syntheticJpeg());
  });
  it('records a backfill GO as used once, only inside a write, as a digest', async () => {
    await importAmazonCapture(db(), syntheticCapture(), backup());
    const goId = 'a'.repeat(32), other = 'b'.repeat(32);
    expect(amazonImageGoUsed(db(), goId)).toBe(false);
    expect(() => recordAmazonImageGo(db(), goId, 'now')).toThrow('amazon input refused');
    await backedUpWrite(db(), backup(), () => recordAmazonImageGo(db(), goId, '2026-10-21T00:00:00.000Z'), installAmazonImageSchema);
    expect([amazonImageGoUsed(db(), goId), amazonImageGoUsed(db(), other)]).toEqual([true, false]);
    await expect(backedUpWrite(db(), backup(), () => recordAmazonImageGo(db(), goId, 'later'), installAmazonImageSchema)).rejects.toThrow();
    expect(db().prepare("SELECT count(*) FROM amazon_audit WHERE action='image-backfill-go'").pluck().get()).toBe(1);
    expect(JSON.stringify(db().prepare("SELECT * FROM amazon_audit WHERE action='image-backfill-go'").all())).not.toContain(goId);
  });
  it('caps a run and leaves the rest for a later plan', async () => {
    await importAmazonCapture(db(), syntheticCapture(), backup());
    const orderRef = listAmazonOrders(db(), 0, 1).orders[0].ref;
    const insert = db().prepare('INSERT INTO amazon_items VALUES(?,?,?,?)');
    db().transaction(() => {
      for (let n = 2; n <= AMAZON_IMAGE_POLICY.maxPerRun + 5; n++) {
        insert.run(opaque('item', ['synthetic-extra', n]), orderRef, `synthetic-extra:${n}`,
          JSON.stringify({ itemId: `SYNTH${String(n).padStart(5, '0')}`, title: 'Synthetic extra', quantity: 1, unitPrice: null }));
      }
      insert.run(opaque('item', 'synthetic-no-asin'), orderRef, 'synthetic-extra:none',
        JSON.stringify({ itemId: null, title: 'Synthetic without ASIN', quantity: 1, unitPrice: null }));
    })();
    const plan = planAmazonImages(db());
    expect(plan).toMatchObject({ itemsWithAsin: AMAZON_IMAGE_POLICY.maxPerRun + 5, deferred: 5 });
    expect(plan.toFetch).toHaveLength(AMAZON_IMAGE_POLICY.maxPerRun);
    expect([...plan.toFetch].sort()).toEqual(plan.toFetch);
  });
  it('writes all or nothing, only inside a transaction, and only re-verified results', async () => {
    await importAmazonCapture(db(), syntheticCapture(), backup());
    expect(() => writeAmazonImages(db(), [jpeg('SYNTH00001')], 'now')).toThrow('amazon input refused');
    for (const bad of [
      [jpeg('SYNTH00001'), { asin: 'SYNTH00001', outcome: 'missing', reason: 'not-found' }],
      [{ asin: 'SYNTH00001', outcome: 'cached', contentType: 'image/png', bytes: syntheticJpeg() }],
      [{ asin: 'SYNTH00001', outcome: 'cached', contentType: 'image/svg+xml', bytes: Buffer.from('<svg/>') }],
      [{ asin: 'SYNTH00001', outcome: 'cached', contentType: 'image/jpeg', bytes: Buffer.concat([syntheticJpeg(), Buffer.alloc(AMAZON_IMAGE_POLICY.maxBytes)]) }],
      [{ asin: 'synth00001', outcome: 'missing', reason: 'not-found' }],
      [{ asin: 'SYNTH00001', outcome: 'missing', reason: 'blocked' }],
      [jpeg('SYNTH00002'), { asin: 'SYNTH00001', outcome: 'failed', reason: 'status' }],
    ] as unknown as AmazonImageResult[][]) {
      await expect(cache(bad), JSON.stringify(bad.map(r => [r.asin, r.outcome]))).rejects.toThrow();
    }
    expect(hasAmazonImageSchema(db())).toBe(false);
    expect(hasAmazonImageIdSchema(db())).toBe(false);
  });
  it('leaves the Amazon schema and both policies untouched, and pins both cache tables under one schema digest', () => {
    expect([AMAZON_SCHEMA_DIGEST, POLICY_DIGEST, LEDGER_POLICY_DIGEST].map(d => d.slice(0, 8))).toEqual(['4c1e900c', '856eccc9', '92153307']);
    // The image-ID pass is a new image policy and cache schema: a GO pinned to the previous ones never authorizes it.
    expect(AMAZON_IMAGE_POLICY_DIGEST.slice(0, 8)).not.toBe('715777c2');
    expect(AMAZON_IMAGE_SCHEMA_DIGEST.slice(0, 8)).not.toBe('f6b0bc39');
  });
});

describe('the image-ID pass', () => {
  it('plans the captured image IDs of items without a cached ASIN thumbnail, after the ASINs, fetch-once', async () => {
    const capture = withSyntheticItems(syntheticCapture(), 5);
    const items = capture.staging.orders[0].items;
    // SYNTH00001 will be cached by ASIN; 00002 and 00005 get the placeholder and share one picture; 00003 is never asked;
    // 00004 has no captured image ID.
    [items[0].imageId, items[1].imageId, items[2].imageId, items[4].imageId] = ['91SynthAA0L', '91Synth+01L', 'A1Synth-02S', '91Synth+01L'];
    await importAmazonCapture(db(), capture, backup());
    const asins = ['SYNTH00001', 'SYNTH00002', 'SYNTH00003', 'SYNTH00004', 'SYNTH00005'];
    const first = planAmazonImages(db());
    expect(first).toEqual({ schema: 'absent', itemsWithAsin: 5, distinctAsins: 5, cached: 0, missing: 0, toFetch: asins, deferred: 0,
      idSchema: 'absent', itemsWithImageId: 4, distinctImageIds: 3, imageIdsNeeded: 3, idCached: 0, idMissing: 0,
      toFetchIds: ['91Synth+01L', '91SynthAA0L', 'A1Synth-02S'], deferredIds: 0, planDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(planAmazonImages(db()).planDigest).toBe(first.planDigest);

    await cache([jpeg('SYNTH00001'), { asin: 'SYNTH00002', outcome: 'missing', reason: 'placeholder' },
      { asin: 'SYNTH00004', outcome: 'missing', reason: 'not-found' }, { asin: 'SYNTH00005', outcome: 'missing', reason: 'placeholder' }]);
    const second = planAmazonImages(db());
    expect(second).toMatchObject({ schema: 'present', idSchema: 'present', cached: 1, missing: 3, toFetch: ['SYNTH00003'],
      itemsWithImageId: 4, distinctImageIds: 3, imageIdsNeeded: 2, idCached: 0, idMissing: 0, toFetchIds: ['91Synth+01L', 'A1Synth-02S'] });
    expect(second.planDigest).not.toBe(first.planDigest);

    expect(await cacheIds([jpegId('91Synth+01L'), { imageId: 'A1Synth-02S', outcome: 'missing', reason: 'not-found' }]))
      .toEqual({ written: 2, unchanged: 0 });
    expect(planAmazonImages(db())).toMatchObject({ toFetch: ['SYNTH00003'], imageIdsNeeded: 2, idCached: 1, idMissing: 1, toFetchIds: [] });
    // A cached or negative image ID is never overwritten either.
    expect(await cacheIds([jpegId('91Synth+01L', 'two'), jpegId('A1Synth-02S')])).toEqual({ written: 0, unchanged: 2 });
    expect(db().prepare('SELECT image_id,state,reason,content_type,policy_digest FROM amazon_product_image_ids ORDER BY image_id').all())
      .toEqual([
        { image_id: '91Synth+01L', state: 'cached', reason: null, content_type: 'image/jpeg', policy_digest: AMAZON_IMAGE_POLICY_DIGEST },
        { image_id: 'A1Synth-02S', state: 'missing', reason: 'not-found', content_type: null, policy_digest: AMAZON_IMAGE_POLICY_DIGEST },
      ]);
    expect(db().prepare("SELECT bytes FROM amazon_product_image_ids WHERE image_id='91Synth+01L'").pluck().get())
      .toEqual(syntheticJpeg('by-id'));
    // The ASIN cache is unchanged by the image-ID pass.
    expect(db().prepare('SELECT count(*) FROM amazon_product_images').pluck().get()).toBe(4);
  });
  it('caps the image-ID pass with the ASINs: one run\'s requests, ASINs first', async () => {
    await importAmazonCapture(db(), syntheticCapture(), backup());
    const orderRef = listAmazonOrders(db(), 0, 1).orders[0].ref;
    const insert = db().prepare('INSERT INTO amazon_items VALUES(?,?,?,?)');
    db().transaction(() => {
      for (let n = 2; n < AMAZON_IMAGE_POLICY.maxPerRun; n++) {
        insert.run(opaque('item', ['synthetic-extra', n]), orderRef, `synthetic-extra:${n}`,
          JSON.stringify({ itemId: `SYNTH${String(n).padStart(5, '0')}`, title: 'Synthetic extra', quantity: 1, unitPrice: null }));
      }
      for (let n = 0; n < 5; n++) {
        insert.run(opaque('item', ['synthetic-picture', n]), orderRef, `synthetic-picture:${n}`,
          JSON.stringify({ itemId: null, title: 'Synthetic without ASIN', quantity: 1, unitPrice: null, imageId: `91SynthB${n}0L` }));
      }
    })();
    const plan = planAmazonImages(db());
    expect(plan).toMatchObject({ deferred: 0, itemsWithImageId: 5, imageIdsNeeded: 5, toFetchIds: ['91SynthB00L'], deferredIds: 4 });
    expect(plan.toFetch).toHaveLength(AMAZON_IMAGE_POLICY.maxPerRun - 1);
  });
  it('writes the image-ID table all or nothing, inside a transaction, re-verified, and its own CHECKs hold the grammar', async () => {
    await importAmazonCapture(db(), syntheticCapture(), backup());
    expect(() => writeAmazonImageIds(db(), [jpegId('91SynthAA0L')], 'now')).toThrow('amazon input refused');
    for (const bad of [
      [jpegId('91SynthAA0L'), { imageId: '91SynthAA0L', outcome: 'missing', reason: 'not-found' }],
      [{ imageId: '91SynthAA0L', outcome: 'cached', contentType: 'image/png', bytes: syntheticJpeg() }],
      [{ imageId: '91SynthAA0L', outcome: 'cached', contentType: 'image/gif', bytes: placeholderGif() }],
      [{ imageId: '+1SynthAA0L', outcome: 'missing', reason: 'not-found' }],
      [{ imageId: 'SYNTH00001', outcome: 'missing', reason: 'not-found' }],
      [{ imageId: '91SynthAA0L', outcome: 'missing', reason: 'blocked' }],
      [jpegId('91SynthAB0L'), { imageId: '91SynthAA0L', outcome: 'failed', reason: 'status' }],
    ] as unknown as AmazonImageIdResult[][]) {
      await expect(cacheIds(bad), JSON.stringify(bad.map(r => [r.imageId, r.outcome]))).rejects.toThrow();
    }
    expect(hasAmazonImageIdSchema(db())).toBe(false);
    expect(await cacheIds([])).toEqual({ written: 0, unchanged: 0 });
    expect([hasAmazonImageSchema(db()), hasAmazonImageIdSchema(db())]).toEqual([true, true]);
    const row = db().prepare(`INSERT INTO amazon_product_image_ids(image_id,state,reason,policy_digest,fetched_at)
      VALUES(?,'missing','not-found','synthetic','2026-10-23T00:00:00.000Z')`);
    for (const id of ['+1SynthAA0L', '-1SynthAA0L', '91SynthAA0-', '91SynthAA0+', '91SynthAA0', '91SynthAA0LL', '91Synth_01L', '91Synth/01L']) {
      expect(() => row.run(id), id).toThrow();
    }
    expect(row.run('91Synth+-1L').changes).toBe(1);
  });
  it('flags and serves an item by its own captured image ID when its ASIN has none, the ASIN\'s thumbnail first', async () => {
    const cards = readCardInventory(db());
    const proposal = proposeBindings(cards.map(c => ({ network: 'visa', last4: c.last4, cardAccountId: c.id })), cards);
    await recordBindingProposal(db(), proposal, backup());
    await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
    const capture = withSyntheticItems(syntheticCapture(), 2);
    [capture.staging.orders[0].items[0].imageId, capture.staging.orders[0].items[1].imageId] = ['91SynthAA0L', '91SynthAB0L'];
    await importAmazonCapture(db(), capture, backup());
    const row = repo.queryCardTransactions({}).transactions[0];
    const resolver = createAmazonCategoryResolver(db()), before = resolver.snapshot();
    const orderRef = before.getCardDetail(row.id).orderRefs![0];
    const [byId, byAsin] = getAmazonOrder(db(), orderRef)!.items.map(i => i.ref);

    // SYNTH00001's ASIN has only the placeholder: its own picture is cached by image ID. SYNTH00002's ASIN is cached,
    // and so is its picture: the ASIN's thumbnail is the one served.
    await cache([{ asin: 'SYNTH00001', outcome: 'missing', reason: 'placeholder' }, jpeg('SYNTH00002')]);
    expect(getAmazonOrder(db(), orderRef)!.items.map(i => i.image)).toEqual([undefined, true]);
    expect(readAmazonItemImage(db(), byId)).toBeNull();
    await cacheIds([jpegId('91SynthAA0L'), jpegId('91SynthAB0L', 'unused')]);
    expect(cachedImages(db())).toEqual({ asins: new Set(['SYNTH00002']), imageIds: new Set(['91SynthAA0L', '91SynthAB0L']) });
    expect(getAmazonOrder(db(), orderRef)!.items.map(i => [i.asin, i.image])).toEqual([['SYNTH00001', true], ['SYNTH00002', true]]);
    expect(listAmazonOrders(db(), 0, 10).orders[0].items.map(i => i.image)).toEqual([true, true]);
    const after = resolver.snapshot();
    expect(after.version).toBe(before.version);
    expect(after.getCardDetail(row.id).items!.map(i => [i.asin, i.image]).sort())
      .toEqual([['SYNTH00001', true], ['SYNTH00002', true]]);
    // Only the base line is priced, so it is each spending list's only product.
    expect(amazonSpending(db(), '2Y', '2026-10-21').products.map(p => [p.ref, p.image])).toEqual([[byId, true]]);
    expect(amazonTaxonomySpending(db(), '2Y', '2026-10-21').products.map(p => [p.ref, p.image])).toEqual([[byId, true]]);
    expect(readAmazonItemImage(db(), byId)).toEqual({ contentType: 'image/jpeg', bytes: syntheticJpeg('by-id') });
    expect(readAmazonItemImage(db(), byAsin)).toEqual({ contentType: 'image/jpeg', bytes: syntheticJpeg() });

    // The first cached thumbnail decides: one that fails re-verification is never replaced by the other.
    db().prepare("UPDATE amazon_product_images SET bytes=? WHERE asin='SYNTH00002'").run(syntheticJpeg('tampered'));
    expect(readAmazonItemImage(db(), byAsin)).toBeNull();
    db().prepare("UPDATE amazon_product_image_ids SET bytes=? WHERE image_id='91SynthAA0L'").run(syntheticJpeg('tampered'));
    expect(readAmazonItemImage(db(), byId)).toBeNull();
  });
  it('flags by the item\'s own image ID only, with or without an ASIN', () => {
    const images = { asins: new Set(['SYNTH00001']), imageIds: new Set(['91SynthAA0L']) };
    expect([
      { itemId: 'SYNTH00001' }, { itemId: 'SYNTH00001', imageId: '91SynthAB0L' }, { itemId: 'SYNTH00002', imageId: '91SynthAA0L' },
      { itemId: null, imageId: '91SynthAA0L' }, { itemId: null }, { itemId: 'SYNTH00002' }, { itemId: 'SYNTH00002', imageId: '91SynthAB0L' },
      { itemId: null, imageId: ['91SynthAA0L'] }, { itemId: ['SYNTH00001'] },
    ].map(item => hasCachedImage(images, item))).toEqual([true, true, true, true, false, false, false, false, false]);
  });
});

describe('items flagged with a cached thumbnail', () => {
  it('flags order items and linked card-charge items, without changing the evidence version, and serves re-verified bytes', async () => {
    const cards = readCardInventory(db());
    const proposal = proposeBindings(cards.map(c => ({ network: 'visa', last4: c.last4, cardAccountId: c.id })), cards);
    await recordBindingProposal(db(), proposal, backup());
    await recordRootApproval(db(), proposal, rootApproval(proposal), backup());
    const capture = withSyntheticItems(syntheticCapture(), 2);
    await importAmazonCapture(db(), capture, backup());
    const row = repo.queryCardTransactions({}).transactions[0];
    const resolver = createAmazonCategoryResolver(db()), before = resolver.snapshot();
    const detail = before.getCardDetail(row.id);
    expect(detail.match).toBe('linked');
    expect(detail.items!.map(i => [i.asin, 'image' in i])).toEqual([['SYNTH00001', false], ['SYNTH00002', false]]);
    const orderRef = detail.orderRefs![0];
    expect(getAmazonOrder(db(), orderRef)!.items.every(i => !('image' in i))).toBe(true);

    await cache([jpeg('SYNTH00001'), { asin: 'SYNTH00002', outcome: 'missing', reason: 'not-found' }]);
    const after = resolver.snapshot();
    expect(after).not.toBe(before);
    expect(after.version).toBe(before.version);
    const items = after.getCardDetail(row.id).items!;
    expect(items).toEqual([{ ...detail.items![0], image: true }, detail.items![1]]);
    const order = getAmazonOrder(db(), orderRef)!;
    expect(order.items.map(i => [i.asin, i.image])).toEqual([['SYNTH00001', true], ['SYNTH00002', undefined]]);
    expect(listAmazonOrders(db(), 0, 10).orders[0].items.map(i => i.image)).toEqual([true, undefined]);
    // The spending-by-item list flags its product the same way (only the base line is priced, so it is the only product).
    expect(amazonSpending(db(), '2Y', '2026-10-21').products.map(p => [p.asin, p.image])).toEqual([['SYNTH00001', true]]);

    const flagged = order.items[0].ref, unflagged = order.items[1].ref;
    expect(readAmazonItemImage(db(), flagged)).toEqual({ contentType: 'image/jpeg', bytes: syntheticJpeg() });
    expect(readAmazonItemImage(db(), unflagged)).toBeNull();
    expect(readAmazonItemImage(db(), opaque('item', 'synthetic-unknown'))).toBeNull();
    expect(readAmazonItemImage(db(), 'not-a-ref')).toBeNull();
    // Bytes that no longer match their digest are never served.
    db().prepare("UPDATE amazon_product_images SET bytes=? WHERE asin='SYNTH00001'").run(syntheticJpeg('tampered'));
    expect(readAmazonItemImage(db(), flagged)).toBeNull();
  });
});
