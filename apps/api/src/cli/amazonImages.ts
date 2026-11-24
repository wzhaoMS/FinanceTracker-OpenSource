import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openWriterDb } from '../control/writerDb.js';
import type { Io } from './controlCommon.js';
import { HoldrRefusal, errorTypeAndCode, toValueFreeDbError } from '../services/dbErrors.js';
import { digest, exact, refuse } from '../services/amazon/policy.js';
import { backedUpWrite } from '../services/amazon/importer.js';
import { AMAZON_IMAGE_POLICY_DIGEST, AMAZON_IMAGE_SCHEMA_DIGEST, amazonImageGoUsed, installAmazonImageSchema,
  planAmazonImages, recordAmazonImageGo, writeAmazonImageIds, writeAmazonImages, type AmazonImagePlan } from '../services/amazon/images.js';
import { fetchPlannedImages, type ImageFetch } from '../services/amazon/imageFetch.js';

export const AMAZON_IMAGES_CLI_USAGE = `Amazon product thumbnail cache operator CLI (existing finance.db only)
  plan --db DB
  backfill --db DB --backup NEW_FILE --root-go ARTIFACT
plan opens the database read-only, contacts nothing, and prints counts and digests only.
backfill is the only Amazon command with network access. It requires a single-use Root GO pinned to this
database, the current plan, the image policy and the image cache schema. After a new pre-write backup it installs
any absent cache table and records the GO as used, before any request; then it fetches each planned item ASIN's
thumbnail once, then each planned captured image ID's (the image-ID pass: items without a cached ASIN thumbnail),
from the allowlisted Amazon image host (no cookies or credentials, redirects refused, type, size and time bounded),
and stores cached and negative results in one transaction. It exits 1 unless every planned ASIN and image ID got a
cached or negative answer. Nothing fetches on page view or at startup. Output is counts and digests only, never ASINs,
image IDs, titles or URLs.
`;
const GO_KEYS = ['format', 'version', 'authority', 'decision', 'purpose', 'command', 'goId', 'databaseRef', 'planDigest',
  'policyDigest', 'schemaDigest'];
function readJson(file: string): unknown {
  if (!path.isAbsolute(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size > 64 * 1024) return refuse();
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return refuse(); }
}
function options(args: string[], expected: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!expected.includes(args[i]) || result.has(args[i]) || !value || !path.isAbsolute(value)) return refuse();
    result.set(args[i], value);
  }
  if (result.size !== expected.length) return refuse();
  return result;
}
/**
 * The GO's fixed fields, checked before the database is opened or anything is fetched. Every field is compared strictly,
 * by type and value: a value that only reads as the right one once coerced (`["copy-rehearsal"]`, `"1"`) refuses.
 */
function authorize(input: unknown, database: string): { goId: string; planDigest: string } {
  const go = exact(input, GO_KEYS);
  if (go.format !== 'holdr.amazon-image-go' || go.version !== 1 || go.authority !== 'Root' || go.decision !== 'GO'
    || typeof go.purpose !== 'string' || !['copy-rehearsal', 'production-backfill'].includes(go.purpose) || go.command !== 'backfill'
    || typeof go.goId !== 'string' || !/^[a-f0-9]{32}$/.test(go.goId)
    || go.databaseRef !== digest(path.resolve(database)) || go.policyDigest !== AMAZON_IMAGE_POLICY_DIGEST
    || go.schemaDigest !== AMAZON_IMAGE_SCHEMA_DIGEST || typeof go.planDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(go.planDigest)) return refuse();
  return { goId: go.goId, planDigest: go.planDigest };
}
async function withDatabase<T>(env: NodeJS.ProcessEnv, database: string, readonly: boolean,
  fn: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const handle = await openWriterDb(env, () => new Database(database, { readonly, fileMustExist: true }));
  try {
    if (!readonly) handle.db.pragma('foreign_keys=ON');
    return await fn(handle.db);
  } finally { handle.close(); }
}
const readPlan = (env: NodeJS.ProcessEnv, database: string, goId?: string) => withDatabase(env, database, true,
  db => db.transaction((): AmazonImagePlan & { goUsed: boolean } =>
    ({ ...planAmazonImages(db), goUsed: goId !== undefined && amazonImageGoUsed(db, goId) }))());
export async function runAmazonImagesCli(args: string[], context: {
  env: NodeJS.ProcessEnv;
  io: Io;
  fetchImpl?: ImageFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}): Promise<number> {
  const { io } = context;
  const now = () => (context.now ?? (() => new Date()))().toISOString();
  try {
    const [command, ...rest] = args;
    if (command === '--help') { io.stdout.write(AMAZON_IMAGES_CLI_USAGE); return 0; }
    if (command === 'plan') {
      const database = options(rest, ['--db']).get('--db')!;
      const plan = await readPlan(context.env, database);
      io.stdout.write(JSON.stringify({ code: 'images-planned', schema: plan.schema, itemsWithAsin: plan.itemsWithAsin,
        distinctAsins: plan.distinctAsins, cached: plan.cached, missing: plan.missing, toFetch: plan.toFetch.length,
        deferred: plan.deferred, idSchema: plan.idSchema, itemsWithImageId: plan.itemsWithImageId,
        distinctImageIds: plan.distinctImageIds, imageIdsNeeded: plan.imageIdsNeeded, idCached: plan.idCached,
        idMissing: plan.idMissing, toFetchIds: plan.toFetchIds.length, deferredIds: plan.deferredIds,
        planDigest: plan.planDigest, policyDigest: AMAZON_IMAGE_POLICY_DIGEST,
        schemaDigest: AMAZON_IMAGE_SCHEMA_DIGEST, databaseRef: digest(path.resolve(database)) }) + '\n');
      return 0;
    }
    if (command !== 'backfill') return refuse();
    const opts = options(rest, ['--db', '--backup', '--root-go']);
    const database = opts.get('--db')!, backup = opts.get('--backup')!;
    const go = authorize(readJson(opts.get('--root-go')!), database);
    if (fs.lstatSync(backup, { throwIfNoEntry: false })
      || !fs.statSync(path.dirname(backup), { throwIfNoEntry: false })?.isDirectory()) return refuse();
    // A used GO, or one for another plan, refuses before any backup, write or request.
    const plan = await readPlan(context.env, database, go.goId);
    if (plan.goUsed || plan.planDigest !== go.planDigest) return refuse();
    if (plan.toFetch.length === 0 && plan.toFetchIds.length === 0) {
      io.stdout.write(JSON.stringify({ code: 'images-nothing-to-fetch', planDigest: go.planDigest }) + '\n');
      return 0;
    }
    // The run's one pre-write backup, then the GO recorded as used before the first request: never replayed, even
    // when every request fails or the results cannot be stored.
    await withDatabase(context.env, database, false, db => backedUpWrite(db, backup,
      () => recordAmazonImageGo(db, go.goId, now()), installAmazonImageSchema));
    const run = await fetchPlannedImages({ asins: plan.toFetch, imageIds: plan.toFetchIds },
      { fetchImpl: context.fetchImpl, sleep: context.sleep });
    const complete = run.stopped === null && Object.values(run.failed).every(n => n === 0);
    const receipt = { planDigest: go.planDigest, planned: plan.toFetch.length, plannedIds: plan.toFetchIds.length,
      attempted: run.attempted,
      cached: run.results.filter(r => r.outcome === 'cached').length,
      missing: run.results.filter(r => r.outcome === 'missing').length,
      cachedIds: run.idResults.filter(r => r.outcome === 'cached').length,
      missingIds: run.idResults.filter(r => r.outcome === 'missing').length, failed: run.failed, stopped: run.stopped };
    // Network work holds no lease; its results land in one IMMEDIATE transaction, after the backup taken above.
    const stored = await withDatabase(context.env, database, false, db => {
      try {
        return db.transaction(() => {
          const at = now(), none = { written: 0, unchanged: 0 };
          const asins = run.results.length > 0 ? writeAmazonImages(db, run.results, at) : none;
          const ids = run.idResults.length > 0 ? writeAmazonImageIds(db, run.idResults, at) : none;
          const counts = { written: asins.written + ids.written, unchanged: asins.unchanged + ids.unchanged };
          db.prepare(`INSERT INTO amazon_audit(action,subject_ref,before_digest,after_digest,policy_digest,created_at)
            VALUES('image-backfill',NULL,NULL,?,?,?)`).run(digest({ ...receipt, ...counts }), AMAZON_IMAGE_POLICY_DIGEST, at);
          return counts;
        }).immediate();
      } catch (error) { throw toValueFreeDbError('amazon image backfill write', error); }
    });
    io.stdout.write(JSON.stringify({ code: complete ? 'images-backfilled' : 'images-backfill-incomplete', ...receipt,
      ...stored }) + '\n');
    return complete ? 0 : 1;
  } catch (error) {
    io.stderr.write(`amazon-images: ${error instanceof HoldrRefusal ? 'input-refused' : 'operation-failed'} ${errorTypeAndCode(error)}\n`);
    return 1;
  }
}
