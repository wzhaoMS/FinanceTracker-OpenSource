import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { hasAmazonSchema } from './schema.js';
import { digest, ref, refuse } from './policy.js';
import { validImageId } from './products.js';

/**
 * Owner-only product thumbnail cache. Nothing here contacts the network: the explicit, Root-GO-gated operator command
 * (cli/amazonImages.ts, through imageFetch.ts) is the only fetcher, and the API only serves what that command stored.
 * Images are keyed by validated ASIN, or by an item's validated captured image ID (the image-ID pass); each URL is built
 * from that key alone, for the allowlisted Amazon image host.
 */
export const AMAZON_IMAGE_HOSTS: readonly string[] = Object.freeze(['m.media-amazon.com']);
export const AMAZON_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp'] as const);
export type AmazonImageType = typeof AMAZON_IMAGE_TYPES[number];
export const AMAZON_IMAGE_POLICY = Object.freeze({
  version: 'amazon-product-image-cache-v2',
  key: 'validated-asin',
  url: 'https://m.media-amazon.com/images/P/{asin}.01._SL160_.jpg',
  imageIdKey: 'validated-captured-image-id',
  imageIdUrl: 'https://m.media-amazon.com/images/I/{imageId}._SL160_.jpg',
  imageIdPlan: 'items-without-a-cached-asin-thumbnail',
  serve: 'asin-then-image-id',
  hosts: AMAZON_IMAGE_HOSTS,
  contentTypes: AMAZON_IMAGE_TYPES,
  magicBytes: 'must-match-content-type',
  placeholder: 'gif-1x1-is-missing',
  notFound: Object.freeze([404, 410]),
  redirects: 'refused',
  credentials: 'none',
  maxBytes: 131072,
  maxRunBytes: 33554432,
  timeoutMs: 10000,
  delayMs: 500,
  maxPerRun: 600,
  runOrder: 'asins-then-image-ids',
  stopAfterConsecutiveFailures: 5,
  negativeCache: 'fetch-once',
  trigger: 'operator-cli-with-root-go',
});
export const AMAZON_IMAGE_POLICY_DIGEST = digest(AMAZON_IMAGE_POLICY);

const AMAZON_IMAGE_SCHEMA_SQL = `CREATE TABLE amazon_product_images (
  asin TEXT PRIMARY KEY NOT NULL CHECK(length(asin)=10 AND asin NOT GLOB '*[^A-Z0-9]*'),
  state TEXT NOT NULL CHECK(state IN ('cached','missing')),
  reason TEXT CHECK(reason IN ('placeholder','not-found')),
  content_type TEXT CHECK(content_type IN ('image/jpeg','image/png','image/webp')),
  bytes BLOB CHECK(typeof(bytes) IN ('blob','null') AND (bytes IS NULL OR length(bytes) BETWEEN 1 AND 131072)),
  sha256 TEXT CHECK(sha256 IS NULL OR (length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*')),
  policy_digest TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  CHECK((state='cached' AND reason IS NULL AND content_type IS NOT NULL AND bytes IS NOT NULL AND sha256 IS NOT NULL)
    OR (state='missing' AND reason IS NOT NULL AND content_type IS NULL AND bytes IS NULL AND sha256 IS NULL))
)`;
/** The image-ID pass's cache: the same row shape, keyed by a captured image ID (the producer kit's closed grammar). */
const AMAZON_IMAGE_ID_SCHEMA_SQL = `CREATE TABLE amazon_product_image_ids (
  image_id TEXT PRIMARY KEY NOT NULL CHECK(length(image_id)=11 AND image_id NOT GLOB '*[^A-Za-z0-9+-]*'
    AND substr(image_id,1,1) NOT IN ('+','-') AND substr(image_id,11,1) NOT IN ('+','-')),
  state TEXT NOT NULL CHECK(state IN ('cached','missing')),
  reason TEXT CHECK(reason IN ('placeholder','not-found')),
  content_type TEXT CHECK(content_type IN ('image/jpeg','image/png','image/webp')),
  bytes BLOB CHECK(typeof(bytes) IN ('blob','null') AND (bytes IS NULL OR length(bytes) BETWEEN 1 AND 131072)),
  sha256 TEXT CHECK(sha256 IS NULL OR (length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*')),
  policy_digest TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  CHECK((state='cached' AND reason IS NULL AND content_type IS NOT NULL AND bytes IS NOT NULL AND sha256 IS NOT NULL)
    OR (state='missing' AND reason IS NOT NULL AND content_type IS NULL AND bytes IS NULL AND sha256 IS NULL))
)`;
const normalizeSql = (sql: string) => sql.trim().replace(/\s+/g, ' ');
/** The whole cache schema a backfill GO pins: both tables' exact SQL, ASIN table first. */
export const AMAZON_IMAGE_SCHEMA_DIGEST = digest([AMAZON_IMAGE_SCHEMA_SQL, AMAZON_IMAGE_ID_SCHEMA_SQL].map(normalizeSql));

const exactTable = (db: Database, name: string, sql: string) => {
  const object = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(name) as
    { type: string; sql: string | null } | undefined;
  return object?.type === 'table' && typeof object.sql === 'string' && normalizeSql(object.sql) === normalizeSql(sql);
};
/** Read-only capability detection: absence or a conflicting table is a hold (no images), never repaired by a read. */
export function hasAmazonImageSchema(db: Database): boolean {
  return exactTable(db, 'amazon_product_images', AMAZON_IMAGE_SCHEMA_SQL);
}
/** The same, for the image-ID table: absent until the first backfill of a version that installs it. */
export function hasAmazonImageIdSchema(db: Database): boolean {
  return exactTable(db, 'amazon_product_image_ids', AMAZON_IMAGE_ID_SCHEMA_SQL);
}

const ASIN = /^[A-Z0-9]{10}$/;
export const validAsin = (value: unknown): value is string => typeof value === 'string' && ASIN.test(value);
/** One cache table: its key column, the key's validator and its exact-SQL detection. */
interface ImageCache {
  table: 'amazon_product_images' | 'amazon_product_image_ids';
  column: 'asin' | 'image_id';
  sql: string;
  valid: (value: unknown) => value is string;
  present: (db: Database) => boolean;
}
const ASIN_CACHE: ImageCache = { table: 'amazon_product_images', column: 'asin', sql: AMAZON_IMAGE_SCHEMA_SQL,
  valid: validAsin, present: hasAmazonImageSchema };
const IMAGE_ID_CACHE: ImageCache = { table: 'amazon_product_image_ids', column: 'image_id', sql: AMAZON_IMAGE_ID_SCHEMA_SQL,
  valid: validImageId, present: hasAmazonImageIdSchema };
const CACHES = [ASIN_CACHE, IMAGE_ID_CACHE] as const;
const conflicting = (db: Database, cache: ImageCache) => !cache.present(db)
  && Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(cache.table));

/**
 * Only the backed-up, Root-GO-gated backfill calls this, inside its write transaction: it installs whichever cache table
 * is absent. Never creates the Amazon schema, and refuses any other object under a cache table's name.
 */
export function installAmazonImageSchema(db: Database): void {
  if (!hasAmazonSchema(db)) return refuse();
  for (const cache of CACHES) {
    if (cache.present(db)) continue;
    if (conflicting(db, cache)) return refuse();
    db.exec(cache.sql);
    if (!cache.present(db)) return refuse();
  }
}

const IMAGE_PATHS = Object.freeze([
  /^\/images\/P\/[A-Z0-9]{10}\.01\._SL160_\.jpg$/,
  /^\/images\/I\/[A-Za-z0-9][A-Za-z0-9+-]{9}[A-Za-z0-9]\._SL160_\.jpg$/,
]);
/** Exactly the allowlisted host and one of the two URL shapes: https, default port, no credentials, query or fragment. */
export function allowedImageUrl(url: URL): boolean {
  return url.protocol === 'https:' && AMAZON_IMAGE_HOSTS.includes(url.hostname) && url.port === ''
    && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
    && IMAGE_PATHS.some(path => path.test(url.pathname));
}
/** The only URL the fetcher may request for an ASIN: built from a validated ASIN, never from captured or user-supplied text. */
export function amazonImageUrl(asin: string): URL {
  if (!validAsin(asin)) return refuse();
  const url = new URL(AMAZON_IMAGE_POLICY.url.replace('{asin}', asin));
  if (!allowedImageUrl(url) || url.pathname !== `/images/P/${asin}.01._SL160_.jpg`) return refuse();
  return url;
}
/** The only URL the fetcher may request for a captured image ID: built from the validated ID alone, never from a URL. */
export function amazonImageIdUrl(imageId: string): URL {
  if (!validImageId(imageId)) return refuse();
  const url = new URL(AMAZON_IMAGE_POLICY.imageIdUrl.replace('{imageId}', imageId));
  if (!allowedImageUrl(url) || url.pathname !== `/images/I/${imageId}._SL160_.jpg`) return refuse();
  return url;
}

/** The image type its leading bytes prove, or null; a declared content type alone is never trusted. */
export function sniffImage(bytes: Uint8Array): AmazonImageType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}
/** The image host's answer for an ASIN without an image: a tiny 1x1 GIF. */
export function isPlaceholderGif(bytes: Uint8Array): boolean {
  if (bytes.length < 13 || bytes.length > 1024) return false;
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  return (signature === 'GIF87a' || signature === 'GIF89a')
    && (bytes[6] | (bytes[7] << 8)) === 1 && (bytes[8] | (bytes[9] << 8)) === 1;
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** A cacheable image: allowed type, proven by its bytes, within the size cap. */
export function cacheableImage(contentType: unknown, bytes: unknown): bytes is Buffer {
  return Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= AMAZON_IMAGE_POLICY.maxBytes
    && (AMAZON_IMAGE_TYPES as readonly unknown[]).includes(contentType) && sniffImage(bytes) === contentType;
}

export interface AmazonImagePlan {
  /** Whether the ASIN cache table exists (absent until the first backed-up backfill). */
  schema: 'present' | 'absent';
  /** Item observations naming a valid ASIN, and how many distinct ASINs they name. */
  itemsWithAsin: number;
  distinctAsins: number;
  cached: number;
  missing: number;
  /** Private: the ASINs this run would fetch, sorted. Never printed or logged. */
  toFetch: string[];
  /** ASINs beyond this run's cap, left for a later plan. */
  deferred: number;
  /** The image-ID pass: whether its cache table exists (absent until the first backfill that installs it). */
  idSchema: 'present' | 'absent';
  /** Item observations carrying a valid captured image ID, and how many distinct IDs they carry. */
  itemsWithImageId: number;
  distinctImageIds: number;
  /** Distinct image IDs of item observations without a cached ASIN thumbnail, and how many of those are answered. */
  imageIdsNeeded: number;
  idCached: number;
  idMissing: number;
  /** Private: the image IDs this run would fetch after its ASINs, sorted. Never printed or logged. */
  toFetchIds: string[];
  /** Needed image IDs beyond this run's cap, left for a later plan. */
  deferredIds: number;
  planDigest: string;
}
/**
 * What a backfill would fetch, sorted and capped at one run's requests, ASINs first: every distinct item ASIN not already
 * cached or negative-cached; then the image-ID pass, every distinct captured image ID of an item observation whose ASIN
 * has no cached thumbnail (none, a negative answer, or not yet asked) and that is not itself already answered.
 */
export function planAmazonImages(db: Database): AmazonImagePlan {
  return db.transaction(() => {
    if (CACHES.some(cache => conflicting(db, cache))) return refuse();
    const present = hasAmazonImageSchema(db), idPresent = hasAmazonImageIdSchema(db);
    const items = hasAmazonSchema(db) ? db.prepare(`SELECT json_extract(data_json,'$.itemId') AS asin,
      json_extract(data_json,'$.imageId') AS imageId FROM amazon_items`).all() as Array<{ asin: unknown; imageId: unknown }> : [];
    const states = (cache: ImageCache, exists: boolean) => new Map(exists ? (db.prepare(
      `SELECT ${cache.column} AS key,state FROM ${cache.table}`).all() as Array<{ key: string; state: 'cached' | 'missing' }>)
      .map(k => [k.key, k.state]) : []);
    const asinStates = states(ASIN_CACHE, present), idStates = states(IMAGE_ID_CACHE, idPresent);
    const observed = items.map(i => i.asin).filter(validAsin);
    const asins = new Set(observed);
    const pending = [...asins].filter(a => !asinStates.has(a)).sort();
    const withIds = items.filter((i): i is { asin: unknown; imageId: string } => validImageId(i.imageId));
    const needed = new Set(withIds.filter(i => !(validAsin(i.asin) && asinStates.get(i.asin) === 'cached')).map(i => i.imageId));
    const pendingIds = [...needed].filter(id => !idStates.has(id)).sort();
    const toFetch = pending.slice(0, AMAZON_IMAGE_POLICY.maxPerRun);
    const toFetchIds = pendingIds.slice(0, AMAZON_IMAGE_POLICY.maxPerRun - toFetch.length);
    return {
      schema: present ? 'present' as const : 'absent' as const,
      itemsWithAsin: observed.length, distinctAsins: asins.size,
      cached: [...asins].filter(a => asinStates.get(a) === 'cached').length,
      missing: [...asins].filter(a => asinStates.get(a) === 'missing').length,
      toFetch, deferred: pending.length - toFetch.length,
      idSchema: idPresent ? 'present' as const : 'absent' as const,
      itemsWithImageId: withIds.length, distinctImageIds: new Set(withIds.map(i => i.imageId)).size,
      imageIdsNeeded: needed.size,
      idCached: [...needed].filter(id => idStates.get(id) === 'cached').length,
      idMissing: [...needed].filter(id => idStates.get(id) === 'missing').length,
      toFetchIds, deferredIds: pendingIds.length - toFetchIds.length,
      planDigest: digest({ format: 'holdr.amazon-image-plan', version: 2, policyDigest: AMAZON_IMAGE_POLICY_DIGEST,
        schemaDigest: AMAZON_IMAGE_SCHEMA_DIGEST, asins: toFetch, imageIds: toFetchIds }),
    };
  })();
}

type Answer =
  | { outcome: 'cached'; contentType: AmazonImageType; bytes: Buffer }
  | { outcome: 'missing'; reason: 'placeholder' | 'not-found' };
export type AmazonImageResult = { asin: string } & Answer;
export type AmazonImageIdResult = { imageId: string } & Answer;
/** One cache's write: every key once, re-checked; one invalid result refuses the whole write. */
function writeCache(db: Database, cache: ImageCache, results: ReadonlyArray<readonly [unknown, Answer]>, now: string) {
  if (!db.inTransaction || !cache.present(db) || new Set(results.map(([key]) => key)).size !== results.length) return refuse();
  const insert = db.prepare(`INSERT INTO ${cache.table}(${cache.column},state,reason,content_type,bytes,sha256,policy_digest,fetched_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(${cache.column}) DO NOTHING`);
  let written = 0;
  for (const [key, r] of results) {
    if (!cache.valid(key)) return refuse();
    if (r.outcome === 'cached') {
      if (!cacheableImage(r.contentType, r.bytes)) return refuse();
      written += insert.run(key, 'cached', null, r.contentType, r.bytes, sha256(r.bytes), AMAZON_IMAGE_POLICY_DIGEST, now).changes;
    } else if (r.outcome === 'missing' && (r.reason === 'placeholder' || r.reason === 'not-found')) {
      written += insert.run(key, 'missing', r.reason, null, null, null, AMAZON_IMAGE_POLICY_DIGEST, now).changes;
    } else return refuse();
  }
  return { written, unchanged: results.length - written };
}
/**
 * Inside the caller's backed-up transaction: stores each result once. An ASIN already cached or negative-cached is
 * never overwritten (fetch-once). Every result is re-checked; one invalid result refuses the whole write.
 */
export function writeAmazonImages(db: Database, results: readonly AmazonImageResult[], now: string): { written: number; unchanged: number } {
  return writeCache(db, ASIN_CACHE, results.map(({ asin, ...answer }) => [asin, answer] as const), now);
}
/** The same for the image-ID pass's results, in the image-ID table: fetch-once, re-checked, all or nothing. */
export function writeAmazonImageIds(db: Database, results: readonly AmazonImageIdResult[], now: string): { written: number; unchanged: number } {
  return writeCache(db, IMAGE_ID_CACHE, results.map(({ imageId, ...answer }) => [imageId, answer] as const), now);
}

/** The keys with a cached thumbnail, for read models to flag their items; each empty without its (exact) table. */
export interface AmazonCachedImages { asins: ReadonlySet<string>; imageIds: ReadonlySet<string> }
export function cachedImages(db: Database): AmazonCachedImages {
  const keys = (cache: ImageCache) => new Set(cache.present(db)
    ? db.prepare(`SELECT ${cache.column} FROM ${cache.table} WHERE state='cached'`).pluck().all() as string[] : []);
  return { asins: keys(ASIN_CACHE), imageIds: keys(IMAGE_ID_CACHE) };
}
/** Whether an item has a thumbnail to serve: its ASIN's, else its own captured image ID's (as readAmazonItemImage serves). */
export function hasCachedImage(images: AmazonCachedImages, item: { itemId: unknown; imageId?: unknown }): boolean {
  return (validAsin(item.itemId) && images.asins.has(item.itemId))
    || (validImageId(item.imageId) && images.imageIds.has(item.imageId));
}
const goUse = (goId: string) => digest({ format: 'holdr.amazon-image-go-use', goId });
/** Whether a backfill GO was already used: each one authorizes a single run, even a run that stored nothing. */
export function amazonImageGoUsed(db: Database, goId: string): boolean {
  return hasAmazonSchema(db)
    && Boolean(db.prepare("SELECT 1 FROM amazon_audit WHERE action='image-backfill-go' AND after_digest=?").get(goUse(goId)));
}
/** Inside the backed-up write that precedes any request: records the GO as used (digest only), refusing a used one. */
export function recordAmazonImageGo(db: Database, goId: string, now: string): void {
  if (!db.inTransaction || !hasAmazonSchema(db) || amazonImageGoUsed(db, goId)) return refuse();
  db.prepare(`INSERT INTO amazon_audit(action,subject_ref,before_digest,after_digest,policy_digest,created_at)
    VALUES('image-backfill-go',NULL,NULL,?,?,?)`).run(goUse(goId), AMAZON_IMAGE_POLICY_DIGEST, now);
}
/**
 * An item's cached thumbnail by its opaque ref, re-verified (type, magic bytes, size, digest); null otherwise. Its ASIN's
 * thumbnail first, else its own captured image ID's: the first cached one decides, so a thumbnail that fails its
 * re-verification is a 404, never replaced by the other.
 */
export function readAmazonItemImage(db: Database, itemRef: string): { contentType: AmazonImageType; bytes: Buffer } | null {
  if (!ref(itemRef) || !hasAmazonSchema(db)) return null;
  return db.transaction(() => {
    const item = db.prepare(`SELECT json_extract(data_json,'$.itemId') AS asin,json_extract(data_json,'$.imageId') AS imageId
      FROM amazon_items WHERE ref=?`).get(itemRef) as { asin: unknown; imageId: unknown } | undefined;
    if (!item) return null;
    for (const [cache, key] of [[ASIN_CACHE, item.asin], [IMAGE_ID_CACHE, item.imageId]] as const) {
      if (!cache.valid(key) || !cache.present(db)) continue;
      const image = db.prepare(`SELECT content_type,bytes,sha256 FROM ${cache.table} WHERE ${cache.column}=? AND state='cached'`)
        .get(key) as { content_type: unknown; bytes: unknown; sha256: unknown } | undefined;
      if (!image) continue;
      if (!cacheableImage(image.content_type, image.bytes) || sha256(image.bytes) !== image.sha256) return null;
      return { contentType: image.content_type as AmazonImageType, bytes: image.bytes };
    }
    return null;
  })();
}
