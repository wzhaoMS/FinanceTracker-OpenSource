import dgram from 'node:dgram';
import http from 'node:http';

import { chromium, expect, test, type Page } from '@playwright/test';

import { closeServer, elsewhereServer, listen, type Elsewhere, type Recorder } from './guardServers';
import { expectNoForeignTraffic, guardedBrowserArgs, watchOrigin, type OriginGuard } from './originGuard';

/**
 * The origin guard (originGuard.ts) against pages that reach for another origin, through every
 * channel it watches or switches off. Two loopback origins: the app, which serves each page and
 * its worker scripts, and another one that records whatever reaches it (HTTP, WebSocket upgrades,
 * and UDP, for STUN and QUIC). Each case passes only if the guard reports the attempt, so a test
 * under it fails, and, where it can refuse it, nothing reached the other origin. Loads it cannot
 * refuse still reach this loopback origin; guardedBrowserArgs keeps them from any other machine,
 * and the last tests check that. origin-guard-coverage.harness.ts goes through every other way
 * this browser build can reach the network.
 */

/** What a worker or service worker script does with the other origin: an HTTP request or a WebSocket. */
const reach = (elsewhere: string, how: string) => (how === 'ws'
  ? `new WebSocket(${JSON.stringify(`${elsewhere.replace('http:', 'ws:')}/from-${how}`)});`
  : `fetch(${JSON.stringify(`${elsewhere}/from-${how}`)}).catch(() => {});`);

/** Speculation rules that prefetch `path` from the other origin. */
const prefetchRules = (elsewhere: string, path: string) => JSON.stringify({ prefetch: [{ source: 'list', urls: [`${elsewhere}/${path}`] }] });

/** Each page's script, given the other origin's URL and its UDP port. */
const PAGES: Record<string, (elsewhere: string, udpPort: number) => string> = {
  'shared worker, HTTP': () => `new SharedWorker('/worker.js?how=http');`,
  'shared worker, WebSocket': () => `new SharedWorker('/worker.js?how=ws');`,
  'dedicated worker, HTTP': () => `new Worker('/worker.js?how=http');`,
  'dedicated worker, WebSocket': () => `new Worker('/worker.js?how=ws');`,
  'service worker, HTTP': () => `await navigator.serviceWorker.register('/service.js?how=http');`,
  'service worker, WebSocket': () => `await navigator.serviceWorker.register('/service.js?how=ws');`,
  'audio worklet': (elsewhere) => `await new AudioContext().audioWorklet.addModule(${JSON.stringify(`${elsewhere}/worklet.js`)});`,
  'WebRTC (STUN)': (_elsewhere, udpPort) => `const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] });
    peer.createDataChannel('probe');
    await peer.setLocalDescription(await peer.createOffer());`,
  'WebTransport': (_elsewhere, udpPort) => `await new WebTransport('https://127.0.0.1:${udpPort}/probe').ready;`,
  'speculation rules': (elsewhere) => `const rules = document.createElement('script');
    rules.type = 'speculationrules';
    rules.textContent = JSON.stringify({ prefetch: [{ source: 'list', urls: [${JSON.stringify(`${elsewhere}/prefetch`)}] }] });
    document.head.append(rules);`,
  // The rules arrive inside an element the page builds before adding it.
  'speculation rules in an added subtree': (elsewhere) => `const box = document.createElement('div');
    const rules = document.createElement('script');
    rules.type = 'speculationrules';
    rules.textContent = ${JSON.stringify(prefetchRules(elsewhere, 'subtree'))};
    box.append(rules);
    document.body.append(box);`,
  // No page observer sees into a closed shadow root; only the browser's own report does.
  'speculation rules in a shadow root': (elsewhere) => `const host = document.createElement('div');
    document.body.append(host);
    const rules = document.createElement('script');
    rules.type = 'speculationrules';
    rules.textContent = ${JSON.stringify(prefetchRules(elsewhere, 'shadow'))};
    host.attachShadow({ mode: 'closed' }).append(rules);`,
  // No script: the page's response carries a Speculation-Rules header, and /rules.json prefetches from the other origin.
  'speculation rules from a Speculation-Rules header': () => '',
  // A same-origin page whose image is on the other origin. Chromium does not prerender while DevTools drives it.
  'speculation rules, prerender': () => `const rules = document.createElement('script');
    rules.type = 'speculationrules';
    rules.textContent = JSON.stringify({ prerender: [{ source: 'list', urls: ['/prerendered'] }] });
    document.head.append(rules);`,
  // Popups (Astra's race), opened by script or by a link; see POPUP.
  'popup by window.open': () => `window.open('/popup?run=' + new URLSearchParams(location.search).get('run'));`,
  'popup by a link': () => `const link = document.createElement('a');
    link.href = '/popup?run=' + new URLSearchParams(location.search).get('run');
    link.target = '_blank';
    link.rel = 'noreferrer';
    document.body.append(link);
    link.click();`,
  'page fetch': (elsewhere) => `await fetch(${JSON.stringify(`${elsewhere}/from-page`)});`,
  'page WebSocket': (elsewhere) => `new WebSocket(${JSON.stringify(`${elsewhere.replace('http:', 'ws:')}/from-page`)});`,
  'same origin only': () => `await fetch('/same-origin');`,
};

/**
 * A popup that starts a prefetch of the other origin from a closed shadow root, which no page
 * script can see, and closes itself 1 to 5 ms later: gone before anything could attach to it.
 */
const POPUP = (elsewhere: string, run: string) => `<!doctype html><title>popup</title><body><script>
  const host = document.createElement('div');
  document.body.append(host);
  const rules = document.createElement('script');
  rules.type = 'speculationrules';
  rules.textContent = ${JSON.stringify(prefetchRules(elsewhere, `popup-${run}`))};
  host.attachShadow({ mode: 'closed' }).append(rules);
  setTimeout(() => window.close(), 1 + Math.floor(Math.random() * 5));
</script></body>`;

/** Response headers for a page, beside its content type. */
const HEADERS: Record<string, Record<string, string>> = {
  'speculation rules from a Speculation-Rules header': { 'speculation-rules': '"/rules.json"' },
};

/** The guard's suffix for a channel it cannot watch. */
const UNWATCHED = ' \\(a channel the guard cannot watch\\)$';
const unwatched = (line: string) => new RegExp(`^${line}${UNWATCHED}`);

/** What the guard reports for each page (every line), and whether it refuses it (nothing reaches the other origin). */
const EXPECTED: Record<string, { reported: RegExp[]; refused: boolean }> = {
  'shared worker, HTTP': { reported: [unwatched('SharedWorker /worker\\.js\\?how=http')], refused: true },
  'shared worker, WebSocket': { reported: [unwatched('SharedWorker /worker\\.js\\?how=ws')], refused: true },
  'dedicated worker, HTTP': { reported: [unwatched('Worker /worker\\.js\\?how=http')], refused: true },
  'dedicated worker, WebSocket': { reported: [unwatched('Worker /worker\\.js\\?how=ws')], refused: true },
  'service worker, HTTP': { reported: [unwatched('ServiceWorker /service\\.js\\?how=http')], refused: true },
  'service worker, WebSocket': { reported: [unwatched('ServiceWorker /service\\.js\\?how=ws')], refused: true },
  'audio worklet': { reported: [unwatched('Worklet http://127\\.0\\.0\\.1:\\d+/worklet\\.js')], refused: true },
  'WebRTC (STUN)': { reported: [unwatched('RTCPeerConnection \\{"iceServers":\\[\\{"urls":"stun:127\\.0\\.0\\.1:\\d+"\\}\\]\\}')], refused: true },
  'WebTransport': { reported: [unwatched('WebTransport https://127\\.0\\.0\\.1:\\d+/probe')], refused: true },
  // Speculation rules: the page's own report, the browser's (the rule set and the load it starts)
  // and, for a header, the response's. The prefetch may already have started, but the test fails.
  'speculation rules': {
    reported: [
      unwatched('speculation rules \\{"prefetch":.*/prefetch.*'),
      unwatched('speculation rule set inline \\{"prefetch":.*/prefetch.*'),
      unwatched('speculative prefetch http://127\\.0\\.0\\.1:\\d+/prefetch'),
    ],
    refused: false,
  },
  'speculation rules in an added subtree': {
    reported: [
      unwatched('speculation rules \\{"prefetch":.*/subtree.*'),
      unwatched('speculation rule set inline \\{"prefetch":.*/subtree.*'),
      unwatched('speculative prefetch http://127\\.0\\.0\\.1:\\d+/subtree'),
    ],
    refused: false,
  },
  'speculation rules in a shadow root': {
    reported: [
      unwatched('speculation rule set inline \\{"prefetch":.*/shadow.*'),
      unwatched('speculative prefetch http://127\\.0\\.0\\.1:\\d+/shadow'),
    ],
    refused: false,
  },
  'speculation rules from a Speculation-Rules header': {
    reported: [
      unwatched('Speculation-Rules header "/rules\\.json" on http://127\\.0\\.0\\.1:\\d+/\\?page=.*'),
      unwatched('speculation rule set http://127\\.0\\.0\\.1:\\d+/rules\\.json \\{"prefetch":.*/header.*'),
      unwatched('speculative prefetch http://127\\.0\\.0\\.1:\\d+/header'),
    ],
    refused: false,
  },
  'speculation rules, prerender': {
    reported: [
      unwatched('speculation rules \\{"prerender":.*'),
      unwatched('speculation rule set inline \\{"prerender":.*'),
      unwatched('speculative prerender http://127\\.0\\.0\\.1:\\d+/prerendered'),
    ],
    refused: true,
  },
  'page fetch': { reported: [/^fetch http:\/\/127\.0\.0\.1:\d+\/from-page$/], refused: true },
  // Reported, so the test fails; the connection itself is not stopped.
  'page WebSocket': { reported: [/^websocket ws:\/\/127\.0\.0\.1:\d+\/from-page$/], refused: false },
  'same origin only': { reported: [], refused: true },
};

let app: Recorder;
let elsewhere: Elsewhere;
let udp: dgram.Socket;
let udpPort = 0;
const udpReached: string[] = [];

test.beforeAll(async () => {
  elsewhere = await elsewhereServer();
  udp = dgram.createSocket('udp4');
  udp.on('message', () => udpReached.push('udp'));
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
  udpPort = udp.address().port;
  const reached: string[] = [];
  const server = http.createServer((req, res) => {
    reached.push(req.url ?? '');
    const url = new URL(req.url ?? '/', 'http://app.invalid');
    const how = url.searchParams.get('how') ?? '';
    if (url.pathname === '/worker.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(reach(elsewhere.url, how));
    }
    if (url.pathname === '/service.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(`self.addEventListener('install', () => { ${reach(elsewhere.url, how)} });`);
    }
    if (url.pathname === '/same-origin') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    if (url.pathname === '/rules.json') {
      res.writeHead(200, { 'content-type': 'application/speculationrules+json' });
      return res.end(prefetchRules(elsewhere.url, 'header'));
    }
    if (url.pathname === '/popup') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(POPUP(elsewhere.url, url.searchParams.get('run') ?? ''));
    }
    if (url.pathname === '/prerendered') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><title>prerendered</title><img src="${elsewhere.url}/from-prerender">`);
    }
    const page = url.searchParams.get('page') ?? '';
    const script = PAGES[page]?.(elsewhere.url, udpPort) ?? '';
    res.writeHead(200, { 'content-type': 'text/html', ...HEADERS[page] });
    res.end(`<!doctype html><title>trying</title><script type="module">
      try { ${script} } catch (error) { window.refusedWith = String(error); }
      document.title = 'tried';
    </script>`);
  });
  app = { url: await listen(server), reached, close: closeServer(server) };
});

test.afterAll(async () => {
  await app?.close();
  await elsewhere?.close();
  udp?.close();
});

for (const [name, expected] of Object.entries(EXPECTED)) {
  test(`${name}: ${expected.reported.length > 0 ? 'the guard reports it' : 'nothing to report'}${expected.refused ? ', and nothing reaches the other origin' : ''}`, async ({ browser }) => {
    elsewhere.reached.length = 0;
    udpReached.length = 0;
    const context = await browser.newContext();
    try {
      const guard = await watchOrigin(context, app.url);
      const page = await context.newPage();
      await guard.watch(page);
      await page.goto(`${app.url}/?page=${encodeURIComponent(name)}`);
      await expect(page).toHaveTitle('tried');
      if (expected.reported.length > 0) {
        await expect.poll(() => guard.foreign).toEqual(expect.arrayContaining(expected.reported.map((line) => expect.stringMatching(line))));
        await expect(expectNoForeignTraffic(guard), 'a test under the guard fails').rejects.toThrow(/traffic to an origin other than/);
      }
      // Long enough for a worker, a service worker or a peer connection that was not stopped to get through.
      await page.waitForTimeout(1500);
      if (expected.refused) {
        expect(elsewhere.reached, 'what reached the other origin').toEqual([]);
        expect(udpReached, 'UDP that reached the other origin').toEqual([]);
      }
      if (expected.reported.length === 0) await expectNoForeignTraffic(guard);
    } finally {
      await context.close();
    }
  });
}

// Astra's race, fifty times each way. window.open is switched off, so that popup never opens. A
// link's popup does, and may prefetch before it closes; the window its opener opened is reported
// at once, and the page the guard never watched when it checks.
for (const [how, opened, refused] of [
  ['window.open', (run: number) => unwatched(`window\\.open /popup\\?run=${run}`), true],
  ['a link', (run: number) => unwatched(`popup http://127\\.0\\.0\\.1:\\d+/popup\\?run=${run}`), false],
] as const) {
  test(`fifty popups by ${how}, each closing 1 to 5 ms after a prefetch from a closed shadow root: the guard reports every one${refused ? ', and none opens' : ''}`, async ({ browser }) => {
    test.setTimeout(180_000);
    const prefetched: number[] = [];
    for (let run = 0; run < 50; run++) {
      elsewhere.reached.length = 0;
      const context = await browser.newContext();
      try {
        const guard = await watchOrigin(context, app.url);
        const page = await context.newPage();
        await guard.watch(page);
        await page.goto(`${app.url}/?page=${encodeURIComponent(`popup by ${how}`)}&run=${run}`);
        await expect(page).toHaveTitle('tried');
        await expect.poll(() => guard.foreign, { message: `run ${run}` }).toEqual(expect.arrayContaining([expect.stringMatching(opened(run))]));
        if (!refused) {
          await expect.poll(async () => {
            await guard.settled();
            return guard.foreign;
          }, { message: `run ${run}` }).toEqual(expect.arrayContaining([expect.stringMatching(/^a page the guard did not watch from before its first navigation/)]));
        }
        await expect(expectNoForeignTraffic(guard), `run ${run}: a test under the guard fails`).rejects.toThrow(/traffic to an origin other than/);
        await page.waitForTimeout(100);
        if (refused) expect(context.pages(), `run ${run}: no popup opened`).toEqual([page]);
        if (elsewhere.reached.length > 0) prefetched.push(run);
      } finally {
        await context.close();
      }
    }
    if (refused) expect(prefetched, 'runs whose popup reached the other origin').toEqual([]);
    test.info().annotations.push({ type: 'popups whose prefetch reached the other origin', description: `${prefetched.length} of 50` });
  });
}

test('a page the guard does not watch from before its first navigation fails the test', async ({ browser }) => {
  for (const [why, open, failure] of [
    ['never watched', async (_guard: OriginGuard, page: Page) => {
      await page.goto(`${app.url}/?page=${encodeURIComponent('same origin only')}`);
    }, /^a page the guard did not watch from before its first navigation, at http:\/\/127\.0\.0\.1:\d+\/\?page=same/],
    ['watched only after it navigated', async (guard: OriginGuard, page: Page) => {
      await page.goto(`${app.url}/?page=${encodeURIComponent('same origin only')}`);
      await guard.watch(page);
    }, /^the guard could not watch the page at .* from before its first navigation: it had navigated to /],
    ['closed before it could be watched', async (guard: OriginGuard, page: Page) => {
      await page.close();
      await guard.watch(page);
    }, /^the guard could not watch the page at about:blank from before its first navigation: /],
  ] as const) {
    const context = await browser.newContext();
    try {
      const guard = await watchOrigin(context, app.url);
      await open(guard, await context.newPage());
      await expect(expectNoForeignTraffic(guard), why).rejects.toThrow(/traffic to an origin other than/);
      expect(guard.foreign, why).toEqual([expect.stringMatching(failure)]);
    } finally {
      await context.close();
    }
  }
});

test('the guard refuses a context that already has a page: that page\'s documents keep every API it switches off', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await context.newPage();
    await expect(watchOrigin(context, app.url)).rejects.toThrow(/Install the origin guard before the context has a page/);
  } finally {
    await context.close();
  }
});

// Where no init script ran, a page still finds RTCPeerConnection, and the resolver does not stop
// UDP to an IP address. The WebRTC policy in guardedBrowserArgs does. The STUN server it is given
// listens on 127.0.0.1, as every listener a test starts does (P-NET).
test('WebRTC sends no STUN packet to a STUN server at an IP address, even where no init script ran', async ({ browser }) => {
  const listener = dgram.createSocket('udp4');
  let packets = 0;
  listener.on('message', () => { packets++; });
  await new Promise<void>((resolve) => listener.bind(0, '127.0.0.1', resolve));
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${app.url}/?page=${encodeURIComponent('same origin only')}`);
    const candidates = await page.evaluate(async (stun) => {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: stun }] });
      peer.createDataChannel('probe');
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return (peer.localDescription?.sdp.match(/a=candidate/g) ?? []).length;
    }, `stun:127.0.0.1:${listener.address().port}`);
    expect(candidates, 'ICE candidates').toBe(0);
    expect(packets, 'STUN packets that reached 127.0.0.1').toBe(0);
  } finally {
    await context.close();
    listener.close();
  }
});

test('the browser resolves no host but a loopback one, IP addresses included, so what the guard cannot refuse stays on this machine', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // 192.0.2.1 is a documentation address (RFC 5737). Without guardedBrowserArgs this would try to connect.
    const failure = await page.goto('http://192.0.2.1/', { timeout: 10_000 }).then(() => 'loaded', (error: Error) => error.message);
    expect(failure).toContain('net::ERR_NAME_NOT_RESOLVED');
  } finally {
    await context.close();
  }
});

// Without switches of its own, a browser launched in a test takes the config's launchOptions.
for (const [without, args] of [['with no switches', []], ['with the rules replaced later', [...guardedBrowserArgs(), '--host-resolver-rules=']]] as const) {
  test(`the guard refuses a browser launched ${without}`, async () => {
    const unguarded = await chromium.launch({ args: [...args] });
    try {
      await expect(watchOrigin(await unguarded.newContext(), app.url)).rejects.toThrow(/needs a browser launched with guardedBrowserArgs/);
    } finally {
      await unguarded.close();
    }
  });
}
