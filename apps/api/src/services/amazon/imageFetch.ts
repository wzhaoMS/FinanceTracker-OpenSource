import { AMAZON_IMAGE_POLICY, AMAZON_IMAGE_TYPES, amazonImageIdUrl, amazonImageUrl, cacheableImage, isPlaceholderGif,
  type AmazonImageIdResult, type AmazonImageResult, type AmazonImageType } from './images.js';

/**
 * The only network code of the Amazon domain, used only by the Root-GO-gated operator backfill (cli/amazonImages.ts);
 * the API never imports it. Each request is a cookieless, credential-free GET of one URL built from a validated ASIN or
 * captured image ID on the allowlisted image host. Redirects are refused, not followed; the body is read under a byte
 * cap and a timeout, and only an allowed image type whose bytes prove that type is kept.
 */
export type AmazonImageFailure = 'timeout' | 'network' | 'status' | 'redirect' | 'content-type' | 'too-large' | 'invalid-image';
export type AmazonImageOutcome =
  | { outcome: 'cached'; contentType: AmazonImageType; bytes: Buffer }
  | { outcome: 'missing'; reason: 'placeholder' | 'not-found' }
  | { outcome: 'failed'; reason: AmazonImageFailure };
export type ImageFetch = (url: string, init: RequestInit) => Promise<Response>;
export const AMAZON_IMAGE_FAILURES: readonly AmazonImageFailure[] = Object.freeze(
  ['timeout', 'network', 'status', 'redirect', 'content-type', 'too-large', 'invalid-image']);

async function readCapped(response: Response, max: number): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, total);
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
}
const discard = (response: Response) => response.body?.cancel().catch(() => undefined);

export async function fetchAmazonImage(asin: string, fetchImpl: ImageFetch = fetch,
  timeoutMs: number = AMAZON_IMAGE_POLICY.timeoutMs): Promise<AmazonImageOutcome> {
  return fetchImageAt(amazonImageUrl(asin), fetchImpl, timeoutMs);
}
/** The image-ID pass's request: the same bounded GET, of the URL built from a validated captured image ID. */
export async function fetchAmazonImageById(imageId: string, fetchImpl: ImageFetch = fetch,
  timeoutMs: number = AMAZON_IMAGE_POLICY.timeoutMs): Promise<AmazonImageOutcome> {
  return fetchImageAt(amazonImageIdUrl(imageId), fetchImpl, timeoutMs);
}
async function fetchImageAt(url: URL, fetchImpl: ImageFetch, timeoutMs: number): Promise<AmazonImageOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.href, {
      method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
      headers: { accept: 'image/jpeg,image/png,image/webp,image/gif;q=0.1' }, signal: controller.signal,
    });
    if (response.redirected || (response.url !== '' && response.url !== url.href) || response.type === 'opaqueredirect'
      || (response.status >= 300 && response.status < 400)) {
      await discard(response);
      return { outcome: 'failed', reason: 'redirect' };
    }
    if ((AMAZON_IMAGE_POLICY.notFound as readonly number[]).includes(response.status)) {
      await discard(response);
      return { outcome: 'missing', reason: 'not-found' };
    }
    if (response.status !== 200) {
      await discard(response);
      return { outcome: 'failed', reason: 'status' };
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d{1,12}$/.test(declared.trim()) || Number(declared) > AMAZON_IMAGE_POLICY.maxBytes)) {
      await discard(response);
      return { outcome: 'failed', reason: 'too-large' };
    }
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'image/gif' && !(AMAZON_IMAGE_TYPES as readonly string[]).includes(type)) {
      await discard(response);
      return { outcome: 'failed', reason: 'content-type' };
    }
    const bytes = await readCapped(response, AMAZON_IMAGE_POLICY.maxBytes);
    if (bytes === null) return { outcome: 'failed', reason: 'too-large' };
    if (type === 'image/gif') return isPlaceholderGif(bytes) ? { outcome: 'missing', reason: 'placeholder' }
      : { outcome: 'failed', reason: 'content-type' };
    if (!cacheableImage(type, bytes)) return { outcome: 'failed', reason: 'invalid-image' };
    return { outcome: 'cached', contentType: type as AmazonImageType, bytes };
  } catch {
    // Never keep a foreign error: it can carry the URL (and so the ASIN or image ID).
    return { outcome: 'failed', reason: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export interface AmazonImageRun {
  results: AmazonImageResult[];
  /** The image-ID pass's answers, for the image-ID table. */
  idResults: AmazonImageIdResult[];
  attempted: number;
  failed: Record<AmazonImageFailure, number>;
  /** Why the run ended before its plan: consecutive failures, or the run's byte budget. */
  stopped: 'consecutive-failures' | 'byte-budget' | null;
}
/**
 * Sequential, paced fetches of a planned list, its ASINs then its image IDs as one run: the pacing, the consecutive-failure
 * stop and the byte budget span both. It stops early on repeated failures or the run's byte budget.
 */
export async function fetchPlannedImages(planned: { asins: readonly string[]; imageIds: readonly string[] }, deps: {
  fetchImpl?: ImageFetch;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<AmazonImageRun> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const failed = Object.fromEntries(AMAZON_IMAGE_FAILURES.map(reason => [reason, 0])) as Record<AmazonImageFailure, number>;
  const results: AmazonImageResult[] = [], idResults: AmazonImageIdResult[] = [];
  let attempted = 0, consecutive = 0, bytes = 0;
  let stopped: AmazonImageRun['stopped'] = null;
  const targets = [...planned.asins.map(key => ({ key, byId: false })), ...planned.imageIds.map(key => ({ key, byId: true }))];
  for (const { key, byId } of targets) {
    if (attempted > 0) await sleep(AMAZON_IMAGE_POLICY.delayMs);
    attempted++;
    const outcome = byId ? await fetchAmazonImageById(key, deps.fetchImpl) : await fetchAmazonImage(key, deps.fetchImpl);
    if (outcome.outcome === 'failed') {
      failed[outcome.reason]++;
      if (++consecutive >= AMAZON_IMAGE_POLICY.stopAfterConsecutiveFailures) { stopped = 'consecutive-failures'; break; }
      continue;
    }
    consecutive = 0;
    if (outcome.outcome === 'cached') {
      bytes += outcome.bytes.length;
      if (bytes > AMAZON_IMAGE_POLICY.maxRunBytes) { stopped = 'byte-budget'; break; }
    }
    if (byId) idResults.push({ imageId: key, ...outcome });
    else results.push({ asin: key, ...outcome });
  }
  return { results, idResults, attempted, failed, stopped };
}
