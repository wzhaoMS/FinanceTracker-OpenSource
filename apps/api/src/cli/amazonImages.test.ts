import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { runAmazonImagesCli, AMAZON_IMAGES_CLI_USAGE } from './amazonImages.js';
import { importAmazonCapture } from '../services/amazon/importer.js';
import { placeholderGif, syntheticCapture, syntheticJpeg, withSyntheticItems } from '../services/amazon/fixtures.testSupport.js';
import { digest } from '../services/amazon/policy.js';
import { AMAZON_IMAGE_POLICY, AMAZON_IMAGE_POLICY_DIGEST, AMAZON_IMAGE_SCHEMA_DIGEST, hasAmazonImageIdSchema,
  hasAmazonImageSchema } from '../services/amazon/images.js';
import type { ImageFetch } from '../services/amazon/imageFetch.js';

// Synthetic only: made-up ASINs (SYNTH00001...), image IDs (91Synth...), titles, order IDs and image bytes; no request leaves the test.
let dir: string, file: string, stdout: string, stderr: string, asked: string[];
const URL_OF = (asin: string) => `https://m.media-amazon.com/images/P/${asin}.01._SL160_.jpg`;
const ID_URL_OF = (imageId: string) => `https://m.media-amazon.com/images/I/${imageId}._SL160_.jpg`;
const IDS = ['91SynthAA0L', '91Synth+01L', 'A1Synth-02S'];
const jpeg = () => new Response(syntheticJpeg(), { status: 200, headers: { 'content-type': 'image/jpeg' } });
const json = (name: string, value: unknown) => { const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(value), { mode: 0o600 }); return p; };
const answer = (by: (url: string) => Response = jpeg): ImageFetch => async (url) => { asked.push(url); return by(url); };
const run = (args: string[], fetchImpl: ImageFetch = answer()) => runAmazonImagesCli(args, {
  env: { ...process.env, HOLDR_CONFIG: 'none' }, fetchImpl, sleep: async () => undefined, now: () => new Date('2026-10-21T00:00:00Z'),
  io: { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } },
});
const plan = async () => {
  stdout = '';
  expect(await run(['plan', '--db', file])).toBe(0);
  const answer = JSON.parse(stdout);
  stdout = '';
  return answer;
};
/** A fresh Root GO for a plan: each one has its own goId and authorizes one run. */
const go = (planDigest: string, patch: Record<string, unknown> = {}) => {
  const goId = randomBytes(16).toString('hex');
  return json(`go-${goId}.json`, {
    format: 'holdr.amazon-image-go', version: 1, authority: 'Root', decision: 'GO', purpose: 'copy-rehearsal', command: 'backfill',
    goId, databaseRef: digest(path.resolve(file)), planDigest, policyDigest: AMAZON_IMAGE_POLICY_DIGEST,
    schemaDigest: AMAZON_IMAGE_SCHEMA_DIGEST, ...patch,
  });
};
const backfill = (goFile: string, backup: string, fetchImpl?: ImageFetch) =>
  run(['backfill', '--db', file, '--backup', path.join(dir, backup), '--root-go', goFile], fetchImpl);
const opened = <T>(fn: (db: Database.Database) => T, target = file) => {
  const db = new Database(target, { readonly: true });
  try { return fn(db); } finally { db.close(); }
};
const audits = () => opened(db => db.prepare(`SELECT action,subject_ref,before_digest,policy_digest FROM amazon_audit
  WHERE action LIKE 'image-backfill%' ORDER BY sequence`).all());
/** Every file in the test directory, by name and content digest: a refusal leaves no backup, journal or change behind. */
const files = () => Object.fromEntries(fs.readdirSync(dir).sort().map(name =>
  [name, createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')]));
const NONE_FAILED = { timeout: 0, network: 0, status: 0, redirect: 0, 'content-type': 0, 'too-large': 0, 'invalid-image': 0 };
const capture = withSyntheticItems(syntheticCapture(), 3);
const privateValues = [...capture.staging.orders[0].items.flatMap(i => [i.itemId!, i.title]), capture.staging.orders[0].orderId,
  'http', 'media-amazon'];
beforeEach(async () => {
  stdout = ''; stderr = ''; asked = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-images-cli-synthetic-'));
  file = path.join(dir, 'finance.db');
  const repo = new SqliteStateRepo({ file });
  try { await importAmazonCapture(repo.internalGetDb(), structuredClone(capture), path.join(dir, 'import-backup.db')); }
  finally { repo.close(); }
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('thumbnail backfill operator CLI', () => {
  it('plans read-only and offline, printing counts and digests only', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(stdout).toBe(AMAZON_IMAGES_CLI_USAGE);
    const before = fs.readFileSync(file);
    const answer = await plan();
    expect(answer).toEqual({ code: 'images-planned', schema: 'absent', itemsWithAsin: 3, distinctAsins: 3, cached: 0, missing: 0,
      toFetch: 3, deferred: 0, idSchema: 'absent', itemsWithImageId: 0, distinctImageIds: 0, imageIdsNeeded: 0, idCached: 0,
      idMissing: 0, toFetchIds: 0, deferredIds: 0, planDigest: expect.stringMatching(/^[a-f0-9]{64}$/), policyDigest: AMAZON_IMAGE_POLICY_DIGEST,
      schemaDigest: AMAZON_IMAGE_SCHEMA_DIGEST, databaseRef: digest(path.resolve(file)) });
    expect(fs.readFileSync(file)).toEqual(before);
    expect(asked).toEqual([]);
    for (const args of [['plan'], ['plan', '--db', 'finance.db'], ['plan', '--db', file, '--db', file], ['fetch', '--db', file]]) {
      expect(await run(args)).toBe(1);
    }
    expect(stderr).toBe('amazon-images: input-refused HoldrRefusal\n'.repeat(4));
  });
  it('refuses every unauthorized backfill before any request, backup or write', async () => {
    const { planDigest } = await plan();
    const backup = path.join(dir, 'never.db');
    const variants: Array<[string, string[]]> = [
      ['no GO', ['backfill', '--db', file, '--backup', backup]],
      ['relative backup', ['backfill', '--db', file, '--backup', 'never.db', '--root-go', go(planDigest)]],
      ...([
        ['legacy write GO', { format: 'holdr.amazon-write-go' }], ['version', { version: 2 }], ['authority', { authority: 'Mac' }],
        ['decision', { decision: 'NO-GO' }], ['purpose', { purpose: 'production-import' }], ['command', { command: 'import' }],
        ['no goId', { goId: undefined }], ['malformed goId', { goId: 'not-a-nonce' }],
        ['database', { databaseRef: digest(path.resolve(dir, 'other.db')) }], ['policy', { policyDigest: digest('other policy') }],
        ['schema', { schemaDigest: digest('other schema') }], ['stale plan', { planDigest: digest('older plan') }],
        ['extra field', { maxFetches: 3 }],
      ] as Array<[string, Record<string, unknown>]>).map(([name, patch]): [string, string[]] =>
        [name, ['backfill', '--db', file, '--backup', backup, '--root-go', go(planDigest, patch)]]),
    ];
    for (const [name, args] of variants) {
      stderr = '';
      expect(await run(args), name).toBe(1);
      expect(stderr, name).toMatch(/^amazon-images: input-refused/);
    }
    fs.writeFileSync(path.join(dir, 'taken.db'), '');
    expect(await backfill(go(planDigest), 'taken.db')).toBe(1);
    expect(await backfill(go(planDigest), path.join('missing', 'b.db'))).toBe(1);
    expect(asked).toEqual([]);
    expect(fs.existsSync(backup)).toBe(false);
    expect(opened(hasAmazonImageSchema)).toBe(false);
    expect(audits()).toEqual([]);
    expect(stdout).toBe('');
  });
  it('fetches each planned ASIN once, stores cached and negative results after a backup, and retries failures only under a new GO', async () => {
    const first = await plan();
    const firstGo = go(first.planDigest);
    const by = (url: string) => url === URL_OF('SYNTH00002') ? new Response(placeholderGif(), { headers: { 'content-type': 'image/gif' } })
      : url === URL_OF('SYNTH00003') ? new Response(null, { status: 503 }) : jpeg();
    // One request failed: what succeeded is stored, and the run says it is incomplete.
    expect(await backfill(firstGo, 'before-images.db', answer(by))).toBe(1);
    expect(asked).toEqual(['SYNTH00001', 'SYNTH00002', 'SYNTH00003'].map(URL_OF));
    expect(JSON.parse(stdout)).toEqual({ code: 'images-backfill-incomplete', planDigest: first.planDigest, planned: 3, plannedIds: 0,
      attempted: 3, cached: 1, missing: 1, cachedIds: 0, missingIds: 0, failed: { ...NONE_FAILED, status: 1 }, stopped: null,
      written: 2, unchanged: 0 });
    expect(stderr).toBe('');
    for (const value of privateValues) expect(stdout).not.toContain(value);
    expect(opened(db => db.prepare('SELECT asin,state,reason,content_type,policy_digest,fetched_at FROM amazon_product_images ORDER BY asin').all()))
      .toEqual([
        { asin: 'SYNTH00001', state: 'cached', reason: null, content_type: 'image/jpeg', policy_digest: AMAZON_IMAGE_POLICY_DIGEST, fetched_at: '2026-10-21T00:00:00.000Z' },
        { asin: 'SYNTH00002', state: 'missing', reason: 'placeholder', content_type: null, policy_digest: AMAZON_IMAGE_POLICY_DIGEST, fetched_at: '2026-10-21T00:00:00.000Z' },
      ]);
    // The GO was recorded as used before the first request, then the run's digest-only receipt.
    expect(audits()).toEqual(['image-backfill-go', 'image-backfill'].map(action =>
      ({ action, subject_ref: null, before_digest: null, policy_digest: AMAZON_IMAGE_POLICY_DIGEST })));
    const backup = path.join(dir, 'before-images.db');
    expect(opened(hasAmazonImageSchema, backup)).toBe(false);
    expect(opened(hasAmazonImageIdSchema, backup)).toBe(false);
    expect(opened(hasAmazonImageIdSchema)).toBe(true);
    expect(opened(db => db.prepare("SELECT count(*) FROM amazon_audit WHERE action LIKE 'image-backfill%'").pluck().get(), backup)).toBe(0);

    // The same GO never runs again. Only the failed ASIN is planned, under a new GO.
    asked = [];
    expect(await backfill(firstGo, 'again.db')).toBe(1);
    expect(asked).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'again.db'))).toBe(false);
    const second = await plan();
    expect(second).toMatchObject({ schema: 'present', cached: 1, missing: 1, toFetch: 1 });
    expect(await backfill(go(second.planDigest), 'retry.db')).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'images-backfilled', planned: 1, cached: 1, failed: NONE_FAILED, written: 1 });
    expect(asked).toEqual([URL_OF('SYNTH00003')]);
    const third = await plan();
    expect(third).toMatchObject({ cached: 2, missing: 1, toFetch: 0 });
    asked = [];
    stdout = '';
    expect(await backfill(go(third.planDigest), 'idle.db')).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ code: 'images-nothing-to-fetch', planDigest: third.planDigest });
    expect(asked).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'idle.db'))).toBe(false);
  });
  it('runs the image-ID pass where the ASIN pass predates it: the ID table after the backup, then each needed image ID once', async () => {
    // The ASIN pass as production ran it before the image-ID pass existed, leaving only the ASIN table.
    const asinPass = await plan();
    const placeholders = (url: string) => url === URL_OF('SYNTH00001') ? jpeg()
      : new Response(placeholderGif(), { headers: { 'content-type': 'image/gif' } });
    expect(await backfill(go(asinPass.planDigest), 'asin-pass.db', answer(placeholders))).toBe(0);
    const writable = new Database(file);
    try { writable.exec('DROP TABLE amazon_product_image_ids'); } finally { writable.close(); }
    // A later re-read by the current producer kit carries each line's captured image ID.
    const reread = structuredClone(capture);
    reread.staging.runId = '00000000-0000-4000-8000-000000000002';
    reread.staging.orders[0].items.forEach((item, n) => { item.imageId = IDS[n]; });
    const repo = new SqliteStateRepo({ file });
    try { await importAmazonCapture(repo.internalGetDb(), reread, path.join(dir, 'reread-backup.db')); } finally { repo.close(); }
    const before = await plan();
    expect(before).toMatchObject({ schema: 'present', cached: 1, missing: 2, toFetch: 0, deferred: 0, idSchema: 'absent',
      itemsWithImageId: 3, distinctImageIds: 3, imageIdsNeeded: 2, idCached: 0, idMissing: 0, toFetchIds: 2, deferredIds: 0 });

    asked = [];
    const notFound = (url: string) => url === ID_URL_OF('A1Synth-02S')
      ? new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }) : jpeg();
    expect(await backfill(go(before.planDigest), 'id-pass.db', answer(notFound))).toBe(0);
    // Only the items whose ASIN has no thumbnail, by their own image IDs; never the line whose ASIN is cached.
    expect(asked).toEqual(['91Synth+01L', 'A1Synth-02S'].map(ID_URL_OF));
    expect(JSON.parse(stdout)).toEqual({ code: 'images-backfilled', planDigest: before.planDigest, planned: 0, plannedIds: 2,
      attempted: 2, cached: 0, missing: 0, cachedIds: 1, missingIds: 1, failed: NONE_FAILED, stopped: null, written: 2, unchanged: 0 });
    expect(stderr).toBe('');
    for (const value of [...privateValues, ...IDS]) expect(stdout).not.toContain(value);
    expect(opened(db => db.prepare('SELECT image_id,state,reason,policy_digest FROM amazon_product_image_ids ORDER BY image_id').all()))
      .toEqual([{ image_id: '91Synth+01L', state: 'cached', reason: null, policy_digest: AMAZON_IMAGE_POLICY_DIGEST },
        { image_id: 'A1Synth-02S', state: 'missing', reason: 'not-found', policy_digest: AMAZON_IMAGE_POLICY_DIGEST }]);
    // The run's backup predates the image-ID table and the run's GO; the ASIN table is untouched.
    const backup = path.join(dir, 'id-pass.db');
    expect([opened(hasAmazonImageSchema, backup), opened(hasAmazonImageIdSchema, backup)]).toEqual([true, false]);
    expect(opened(db => db.prepare("SELECT count(*) FROM amazon_audit WHERE action LIKE 'image-backfill%'").pluck().get(), backup)).toBe(2);
    expect(audits()).toHaveLength(4);
    expect(opened(db => db.prepare('SELECT count(*) FROM amazon_product_images').pluck().get())).toBe(3);
    expect(await plan()).toMatchObject({ idSchema: 'present', imageIdsNeeded: 2, idCached: 1, idMissing: 1, toFetch: 0, toFetchIds: 0 });
  });
  it('treats a conflicting image-ID table as a hold, before any request, backup or write', async () => {
    const { planDigest } = await plan();
    const db = new Database(file);
    try { db.exec('CREATE TABLE amazon_product_image_ids(image_id TEXT PRIMARY KEY)'); } finally { db.close(); }
    expect(await run(['plan', '--db', file])).toBe(1);
    expect(await backfill(go(planDigest), 'never.db')).toBe(1);
    expect(stderr).toBe('amazon-images: input-refused HoldrRefusal\n'.repeat(2));
    expect(asked).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'never.db'))).toBe(false);
    expect(opened(hasAmazonImageSchema)).toBe(false);
    expect(audits()).toEqual([]);
  });
  it('uses a GO up even when every request fails, so only a new GO asks again', async () => {
    const { planDigest } = await plan();
    const used = go(planDigest);
    const offline = answer(() => { throw new TypeError('synthetic offline'); });
    expect(await backfill(used, 'first.db', offline)).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'images-backfill-incomplete', attempted: 3, written: 0,
      failed: { ...NONE_FAILED, network: 3 } });
    expect(fs.existsSync(path.join(dir, 'first.db'))).toBe(true);
    expect(opened(db => db.prepare('SELECT count(*) FROM amazon_product_images').pluck().get())).toBe(0);
    expect((await plan()).planDigest).toBe(planDigest);
    asked = [];
    stderr = '';
    expect(await backfill(used, 'replay.db', offline)).toBe(1);
    expect(stderr).toBe('amazon-images: input-refused HoldrRefusal\n');
    expect(asked).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'replay.db'))).toBe(false);
    expect(await backfill(go(planDigest), 'fresh.db')).toBe(0);
    expect(asked).toHaveLength(3);
  });
  it('keeps a GO used when its results cannot be stored', async () => {
    const { planDigest } = await plan();
    const used = go(planDigest);
    let swapped = false;
    // Mid-run, the cache table is replaced by a conflicting one: the results' write is refused and rolls back.
    const swapping = answer(() => {
      if (!swapped) {
        swapped = true;
        const db = new Database(file);
        try { db.exec('DROP TABLE amazon_product_images; CREATE TABLE amazon_product_images(asin TEXT PRIMARY KEY)'); }
        finally { db.close(); }
      }
      return jpeg();
    });
    expect(await backfill(used, 'first.db', swapping)).toBe(1);
    expect(stderr).toBe('amazon-images: input-refused HoldrRefusal\n');
    expect(opened(db => db.prepare('SELECT count(*) FROM amazon_product_images').pluck().get())).toBe(0);
    const db = new Database(file);
    try { db.exec('DROP TABLE amazon_product_images'); } finally { db.close(); }
    expect((await plan()).planDigest).toBe(planDigest);
    asked = [];
    expect(await backfill(used, 'replay.db')).toBe(1);
    expect(asked).toEqual([]);
    expect(await backfill(go(planDigest), 'fresh.db')).toBe(0);
    expect(asked).toHaveLength(3);
    expect(opened(db => db.prepare("SELECT count(*) FROM amazon_product_images WHERE state='cached'").pluck().get())).toBe(3);
  });
  it('stops a failing run early, keeps what succeeded, and exits non-zero', async () => {
    fs.rmSync(file);
    const repo = new SqliteStateRepo({ file });
    try {
      const many = withSyntheticItems(syntheticCapture(), AMAZON_IMAGE_POLICY.stopAfterConsecutiveFailures + 3);
      await importAmazonCapture(repo.internalGetDb(), many, path.join(dir, 'many-backup.db'));
    } finally { repo.close(); }
    const { planDigest } = await plan();
    expect(await backfill(go(planDigest), 'before-stop.db',
      answer(url => url === URL_OF('SYNTH00001') ? jpeg() : new Response(null, { status: 403 })))).toBe(1);
    const receipt = JSON.parse(stdout);
    expect(receipt).toMatchObject({ code: 'images-backfill-incomplete', stopped: 'consecutive-failures', cached: 1, written: 1,
      attempted: 1 + AMAZON_IMAGE_POLICY.stopAfterConsecutiveFailures, planned: AMAZON_IMAGE_POLICY.stopAfterConsecutiveFailures + 3 });
    expect(receipt.failed.status).toBe(AMAZON_IMAGE_POLICY.stopAfterConsecutiveFailures);
    expect(opened(db => db.prepare('SELECT asin FROM amazon_product_images').pluck().all())).toEqual(['SYNTH00001']);
  });
  it('treats a conflicting cache table as a hold and never repairs it', async () => {
    const db = new Database(file);
    try { db.exec('CREATE TABLE amazon_product_images(asin TEXT PRIMARY KEY)'); } finally { db.close(); }
    expect(await run(['plan', '--db', file])).toBe(1);
    expect(stderr).toBe('amazon-images: input-refused HoldrRefusal\n');
    expect(asked).toEqual([]);
  });
  it('refuses a GO whose fields match only once coerced before any request, backup or write, and never opens a database it names', async () => {
    const { planDigest } = await plan();
    const backup = path.join(dir, 'never.db');
    const coerced: Array<Record<string, unknown>> = [
      { purpose: ['copy-rehearsal'] }, { purpose: [['production-backfill']] }, { purpose: { purpose: 'copy-rehearsal' } },
      { purpose: null }, { purpose: 0 }, { version: '1' }, { version: [1] }, { format: ['holdr.amazon-image-go'] },
      { authority: ['Root'] }, { decision: ['GO'] }, { command: ['backfill'] }, { goId: ['0'.repeat(32)] },
      { databaseRef: [digest(path.resolve(file))] }, { planDigest: [planDigest] }, { policyDigest: [AMAZON_IMAGE_POLICY_DIGEST] },
      { schemaDigest: [AMAZON_IMAGE_SCHEMA_DIGEST] },
    ];
    const gos = coerced.map(patch => go(planDigest, patch));
    const before = files();
    for (const [n, goFile] of gos.entries()) {
      stderr = '';
      expect(await run(['backfill', '--db', file, '--backup', backup, '--root-go', goFile]), JSON.stringify(coerced[n])).toBe(1);
      expect(stderr, JSON.stringify(coerced[n])).toBe('amazon-images: input-refused HoldrRefusal\n');
    }
    expect(files()).toEqual(before);
    // Pinned to a database that doesn't exist, a coerced purpose is a refusal, not a failed open, and creates nothing.
    const absent = path.join(dir, 'absent.db');
    for (const purpose of [['copy-rehearsal'], { purpose: 'production-backfill' }, null, 1]) {
      stderr = '';
      expect(await run(['backfill', '--db', absent, '--backup', backup, '--root-go',
        go(planDigest, { purpose, databaseRef: digest(path.resolve(absent)) })])).toBe(1);
      expect(stderr).toBe('amazon-images: input-refused HoldrRefusal\n');
    }
    expect(fs.readdirSync(dir).filter(name => name.startsWith('absent.db') || name.startsWith('never.db'))).toEqual([]);
    expect(asked).toEqual([]);
    expect(stdout).toBe('');
    // The same GO, uncoerced, still backfills.
    expect(await backfill(go(planDigest), 'never.db')).toBe(0);
    expect(asked).toHaveLength(3);
  });
});
