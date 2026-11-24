import { describe, expect, it } from 'vitest';
import { AMAZON_IMAGE_FAILURES, fetchAmazonImage, fetchAmazonImageById, fetchPlannedImages, type ImageFetch } from './imageFetch.js';
import { AMAZON_IMAGE_POLICY } from './images.js';
import { placeholderGif, syntheticJpeg, syntheticPng, syntheticWebp } from './fixtures.testSupport.js';

// No network: every request goes to a fake fetch. ASINs, image IDs, bytes and hosts are synthetic.
const URL_OF = (asin: string) => `https://m.media-amazon.com/images/P/${asin}.01._SL160_.jpg`;
const ID_URL_OF = (imageId: string) => `https://m.media-amazon.com/images/I/${imageId}._SL160_.jpg`;
const image = (bytes: BodyInit | null, type: string | null, init: ResponseInit = {}) =>
  new Response(bytes, { status: 200, ...init, headers: { ...(type ? { 'content-type': type } : {}), ...(init.headers as object) } });
const answering = (response: () => Response): ImageFetch => async () => response();
const withProperty = (response: Response, key: 'url' | 'redirected', value: unknown) =>
  Object.defineProperty(response, key, { value }) as Response;
const stream = (chunks: number, size: number, onPull?: () => void) => {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (sent++ < chunks) controller.enqueue(new Uint8Array(size).fill(0xff));
      else controller.close();
    },
  });
};

describe('one cookieless, bounded image request', () => {
  it('asks exactly the allowlisted URL, with no credentials, cookies or redirects, and keeps a proven image', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const outcome = await fetchAmazonImage('SYNTH00001', async (url, init) => {
      calls.push([url, init]);
      return image(syntheticJpeg(), 'image/jpeg; charset=binary');
    });
    expect(outcome).toEqual({ outcome: 'cached', contentType: 'image/jpeg', bytes: syntheticJpeg() });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe(URL_OF('SYNTH00001'));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect([...new Headers(init.headers).keys()]).toEqual(['accept']);
    expect(init.body).toBeUndefined();
    expect(await fetchAmazonImage('SYNTH00002', answering(() => image(syntheticPng(), 'image/png'))))
      .toEqual({ outcome: 'cached', contentType: 'image/png', bytes: syntheticPng() });
    expect(await fetchAmazonImage('SYNTH00003', answering(() => image(syntheticWebp(), 'image/webp'))))
      .toEqual({ outcome: 'cached', contentType: 'image/webp', bytes: syntheticWebp() });
  });
  it('never builds a request from an invalid ASIN', async () => {
    let called = false;
    await expect(fetchAmazonImage('../SYNTH1', async () => { called = true; return image(syntheticJpeg(), 'image/jpeg'); }))
      .rejects.toThrow('amazon input refused');
    expect(called).toBe(false);
  });
  it('asks exactly the image-ID URL for a captured image ID, under the same bounds, and never builds one from an invalid ID', async () => {
    const calls: Array<[string, RequestInit]> = [];
    for (const imageId of ['91SynthAA0L', '91Synth+01L', 'A1Synth-02S']) {
      expect(await fetchAmazonImageById(imageId, async (url, init) => {
        calls.push([url, init]);
        return image(syntheticJpeg(), 'image/jpeg');
      })).toEqual({ outcome: 'cached', contentType: 'image/jpeg', bytes: syntheticJpeg() });
    }
    expect(calls.map(([url]) => url)).toEqual(['91SynthAA0L', '91Synth+01L', 'A1Synth-02S'].map(ID_URL_OF));
    for (const [, init] of calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      expect([...new Headers(init.headers).keys()]).toEqual(['accept']);
    }
    // An unknown image ID is a 404 on the image host: a negative answer, like an unknown ASIN's.
    expect(await fetchAmazonImageById('91SynthAA0L', answering(() => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }))))
      .toEqual({ outcome: 'missing', reason: 'not-found' });
    expect(await fetchAmazonImageById('91SynthAA0L', answering(() => image(placeholderGif(), 'image/gif'))))
      .toEqual({ outcome: 'missing', reason: 'placeholder' });
    expect(await fetchAmazonImageById('91SynthAA0L', answering(() => withProperty(image(syntheticJpeg(), 'image/jpeg'), 'url',
      ID_URL_OF('91SynthAB0L'))))).toEqual({ outcome: 'failed', reason: 'redirect' });
    let called = false;
    for (const imageId of ['+1SynthAA0L', '91SynthAA0-', '91SynthAA0', '91SynthAA0LL', '91Synth/01L', '91Synth.01L', '91Synth%01L',
      '91Synth 01L', '91Synth?01L', '91Synth#01L', 'SYNTH00001', '', 'https://m.media-amazon.com/images/I/91SynthAA0L.jpg']) {
      await expect(fetchAmazonImageById(imageId, async () => { called = true; return image(syntheticJpeg(), 'image/jpeg'); }), imageId)
        .rejects.toThrow('amazon input refused');
    }
    expect(called).toBe(false);
  });
  it.each([
    ['the 1x1 placeholder', () => image(placeholderGif(), 'image/gif'), { outcome: 'missing', reason: 'placeholder' }],
    ['404', () => new Response('synthetic not found', { status: 404, headers: { 'content-type': 'text/html' } }), { outcome: 'missing', reason: 'not-found' }],
    ['410', () => new Response(null, { status: 410 }), { outcome: 'missing', reason: 'not-found' }],
    ['a 302', () => new Response(null, { status: 302, headers: { location: 'https://example.invalid/synthetic.jpg' } }), { outcome: 'failed', reason: 'redirect' }],
    ['a 307', () => new Response(null, { status: 307, headers: { location: URL_OF('SYNTH00009') } }), { outcome: 'failed', reason: 'redirect' }],
    ['a followed redirect', () => withProperty(image(syntheticJpeg(), 'image/jpeg'), 'redirected', true), { outcome: 'failed', reason: 'redirect' }],
    ['another final URL', () => withProperty(image(syntheticJpeg(), 'image/jpeg'), 'url', 'https://example.invalid/x.jpg'), { outcome: 'failed', reason: 'redirect' }],
    ['a 403', () => new Response('synthetic', { status: 403 }), { outcome: 'failed', reason: 'status' }],
    ['a 429', () => new Response(null, { status: 429 }), { outcome: 'failed', reason: 'status' }],
    ['a 503', () => new Response(null, { status: 503 }), { outcome: 'failed', reason: 'status' }],
    ['a 204', () => new Response(null, { status: 204 }), { outcome: 'failed', reason: 'status' }],
    ['HTML', () => image('<html>synthetic</html>', 'text/html'), { outcome: 'failed', reason: 'content-type' }],
    ['SVG', () => image('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'), { outcome: 'failed', reason: 'content-type' }],
    ['no content type', () => image(syntheticJpeg(), null), { outcome: 'failed', reason: 'content-type' }],
    ['a GIF that is not the placeholder', () => image(placeholderGif(2, 2), 'image/gif'), { outcome: 'failed', reason: 'content-type' }],
    ['PNG bytes called JPEG', () => image(syntheticPng(), 'image/jpeg'), { outcome: 'failed', reason: 'invalid-image' }],
    ['HTML called JPEG', () => image('<html>', 'image/jpeg'), { outcome: 'failed', reason: 'invalid-image' }],
    ['an empty JPEG', () => image(null, 'image/jpeg'), { outcome: 'failed', reason: 'invalid-image' }],
    ['a declared oversize body', () => image(syntheticJpeg(), 'image/jpeg', { headers: { 'content-length': String(AMAZON_IMAGE_POLICY.maxBytes + 1) } }),
      { outcome: 'failed', reason: 'too-large' }],
    ['a malformed length', () => image(syntheticJpeg(), 'image/jpeg', { headers: { 'content-length': '12, 12' } }), { outcome: 'failed', reason: 'too-large' }],
    ['an undeclared oversize body', () => image(stream(3, 65536), 'image/jpeg'), { outcome: 'failed', reason: 'too-large' }],
  ] as Array<[string, () => Response, unknown]>)('%s', async (_name, response, expected) => {
    expect(await fetchAmazonImage('SYNTH00001', answering(response))).toEqual(expected);
  });
  it('does not read a body declared too large, and stops reading at the cap', async () => {
    let pulls = 0;
    const declared = image(stream(1, 16, () => { pulls++; }), 'image/jpeg', { headers: { 'content-length': '999999999' } });
    expect(await fetchAmazonImage('SYNTH00001', answering(() => declared))).toEqual({ outcome: 'failed', reason: 'too-large' });
    expect(pulls).toBeLessThanOrEqual(1);
    pulls = 0;
    const endless = image(stream(1_000_000, 16384, () => { pulls++; }), 'image/jpeg');
    expect(await fetchAmazonImage('SYNTH00001', answering(() => endless))).toEqual({ outcome: 'failed', reason: 'too-large' });
    expect(pulls).toBeLessThan(AMAZON_IMAGE_POLICY.maxBytes / 16384 + 4);
  });
  it('reports a network failure or a timeout by fixed reason, never the foreign error or URL', async () => {
    expect(await fetchAmazonImage('SYNTH00001', async (url) => { throw new TypeError(`synthetic failure for ${url}`); }))
      .toEqual({ outcome: 'failed', reason: 'network' });
    const hang: ImageFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('synthetic abort', 'AbortError')));
    });
    expect(await fetchAmazonImage('SYNTH00001', hang, 20)).toEqual({ outcome: 'failed', reason: 'timeout' });
    const stalled: ImageFetch = async (_url, init) => image(new ReadableStream({
      start(controller) {
        controller.enqueue(syntheticJpeg());
        init.signal!.addEventListener('abort', () => controller.error(new DOMException('synthetic abort', 'AbortError')));
      },
    }), 'image/jpeg');
    expect(await fetchAmazonImage('SYNTH00001', stalled, 20)).toEqual({ outcome: 'failed', reason: 'timeout' });
  });
});

describe('a paced run over the plan', () => {
  const asins = (n: number) => Array.from({ length: n }, (_, i) => `SYNTH${String(i + 1).padStart(5, '0')}`);
  it('fetches in plan order, paced, keeps cached and negative results, and counts failures by reason only', async () => {
    const asked: string[] = [], sleeps: number[] = [];
    const answers: Record<string, () => Response> = {
      [URL_OF('SYNTH00001')]: () => image(syntheticJpeg(), 'image/jpeg'),
      [URL_OF('SYNTH00002')]: () => image(placeholderGif(), 'image/gif'),
      [URL_OF('SYNTH00003')]: () => new Response(null, { status: 503 }),
      [URL_OF('SYNTH00004')]: () => new Response(null, { status: 404 }),
    };
    const run = await fetchPlannedImages({ asins: asins(4), imageIds: [] }, {
      fetchImpl: async (url) => { asked.push(url); return answers[url](); },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(asked).toEqual(asins(4).map(URL_OF));
    expect(sleeps).toEqual([AMAZON_IMAGE_POLICY.delayMs, AMAZON_IMAGE_POLICY.delayMs, AMAZON_IMAGE_POLICY.delayMs]);
    expect(run).toEqual({
      results: [{ asin: 'SYNTH00001', outcome: 'cached', contentType: 'image/jpeg', bytes: syntheticJpeg() },
        { asin: 'SYNTH00002', outcome: 'missing', reason: 'placeholder' },
        { asin: 'SYNTH00004', outcome: 'missing', reason: 'not-found' }],
      idResults: [], attempted: 4, stopped: null,
      failed: Object.fromEntries(AMAZON_IMAGE_FAILURES.map(reason => [reason, reason === 'status' ? 1 : 0])),
    });
  });
  it('fetches the image-ID pass after the ASINs, as one paced run, keeping each answer for its own table', async () => {
    const asked: string[] = [], sleeps: number[] = [];
    const answers: Record<string, () => Response> = {
      [URL_OF('SYNTH00001')]: () => image(placeholderGif(), 'image/gif'),
      [ID_URL_OF('91SynthAA0L')]: () => image(syntheticJpeg('by-id'), 'image/jpeg'),
      [ID_URL_OF('91Synth+01L')]: () => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }),
      [ID_URL_OF('A1Synth-02S')]: () => new Response(null, { status: 503 }),
    };
    const run = await fetchPlannedImages({ asins: ['SYNTH00001'], imageIds: ['91SynthAA0L', '91Synth+01L', 'A1Synth-02S'] }, {
      fetchImpl: async (url) => { asked.push(url); return answers[url](); },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(asked).toEqual([URL_OF('SYNTH00001'), ...['91SynthAA0L', '91Synth+01L', 'A1Synth-02S'].map(ID_URL_OF)]);
    expect(sleeps).toEqual(Array(3).fill(AMAZON_IMAGE_POLICY.delayMs));
    expect(run).toEqual({
      results: [{ asin: 'SYNTH00001', outcome: 'missing', reason: 'placeholder' }],
      idResults: [{ imageId: '91SynthAA0L', outcome: 'cached', contentType: 'image/jpeg', bytes: syntheticJpeg('by-id') },
        { imageId: '91Synth+01L', outcome: 'missing', reason: 'not-found' }],
      attempted: 4, stopped: null,
      failed: Object.fromEntries(AMAZON_IMAGE_FAILURES.map(reason => [reason, reason === 'status' ? 1 : 0])),
    });
    // The consecutive-failure stop spans both lists: failing ASINs then failing image IDs stop the run together.
    const limit = AMAZON_IMAGE_POLICY.stopAfterConsecutiveFailures, failing: string[] = [];
    const stopped = await fetchPlannedImages({ asins: asins(limit - 2), imageIds: ['91SynthAA0L', '91SynthAB0L', '91SynthAC0L'] }, {
      fetchImpl: async (url) => { failing.push(url); return new Response(null, { status: 429 }); }, sleep: async () => undefined,
    });
    expect(stopped).toMatchObject({ attempted: limit, stopped: 'consecutive-failures', results: [], idResults: [] });
    expect(failing).toEqual([...asins(limit - 2).map(URL_OF), ID_URL_OF('91SynthAA0L'), ID_URL_OF('91SynthAB0L')]);
  });
  it('stops after consecutive failures, and a success resets the count', async () => {
    const limit = AMAZON_IMAGE_POLICY.stopAfterConsecutiveFailures;
    const asked: string[] = [];
    const stopped = await fetchPlannedImages({ asins: asins(limit + 3), imageIds: [] }, {
      fetchImpl: async (url) => { asked.push(url); return new Response(null, { status: 429 }); }, sleep: async () => undefined,
    });
    expect(stopped).toMatchObject({ attempted: limit, stopped: 'consecutive-failures', results: [] });
    expect(asked).toHaveLength(limit);
    const pattern = [...Array(limit - 1).fill(false), true, ...Array(limit - 1).fill(false)];
    const recovering = await fetchPlannedImages({ asins: asins(pattern.length), imageIds: [] }, {
      fetchImpl: async (url) => (pattern[asins(pattern.length).map(URL_OF).indexOf(url)]
        ? image(syntheticJpeg(), 'image/jpeg') : new Response(null, { status: 500 })),
      sleep: async () => undefined,
    });
    expect(recovering).toMatchObject({ attempted: pattern.length, stopped: null });
    expect(recovering.results).toHaveLength(1);
  });
  it('stops at the run\'s byte budget', async () => {
    const big = Buffer.concat([syntheticJpeg(), Buffer.alloc(AMAZON_IMAGE_POLICY.maxBytes - syntheticJpeg().length)]);
    const fit = AMAZON_IMAGE_POLICY.maxRunBytes / AMAZON_IMAGE_POLICY.maxBytes;
    const run = await fetchPlannedImages({ asins: asins(fit + 2), imageIds: [] }, {
      fetchImpl: async () => image(big, 'image/jpeg'), sleep: async () => undefined,
    });
    expect(run).toMatchObject({ attempted: fit + 1, stopped: 'byte-budget' });
    expect(run.results).toHaveLength(fit);
    // The budget spans the image-ID pass too.
    const split = await fetchPlannedImages({ asins: asins(fit - 1), imageIds: ['91SynthAA0L', '91SynthAB0L'] }, {
      fetchImpl: async () => image(big, 'image/jpeg'), sleep: async () => undefined,
    });
    expect(split).toMatchObject({ attempted: fit + 1, stopped: 'byte-budget' });
    expect([split.results.length, split.idResults.length]).toEqual([fit - 1, 1]);
  });
});
