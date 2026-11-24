import { expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * The origin guard: every page a test opens may contact only the app's own origin. The owner
 * decides what leaves the machine, and a page load contacts no other host.
 *
 * origin-guard-coverage.harness.ts lists every way this browser build can reach the network and
 * which layer covers it. Each layer covers what the one before it cannot:
 * 1. Playwright reports, and lets the guard refuse, requests from pages, frames, popups and
 *    service workers, and it reports WebSockets from pages.
 * 2. Pages can reach the network through APIs whose traffic it does not see: other workers and
 *    worklets, keepalive and deferred requests, UDP, and the browser's own fetches for Privacy
 *    Sandbox, FedCM and similar APIs. The guard switches those off in every frame before the
 *    page's own scripts run, and reports each attempt (switchOffUnwatchedChannels). The app uses
 *    none of them. The init script reaches only documents created after it, so the guard is
 *    installed before the context has a page, and refuses one that has.
 * 3. Speculation rules can be neither refused nor switched off: Chromium starts their prefetches
 *    itself, outside Playwright's routing, and neither its feature flags nor DevTools' URL
 *    blocking or request interception stop them. The guard reports every rule set the browser
 *    accepts and every load it starts (watchFromStart), every response that delivers rules in a
 *    Speculation-Rules header, and every rules script a page adds.
 * 4. Response headers can make the browser send something later or elsewhere: reports, link
 *    hints, attribution and session registrations. The guard parses them as the browser does,
 *    reads each URL in them every way the browser may (readingsOf), and reports each header that
 *    sends something elsewhere, and each one it cannot parse (reportHeaders).
 * 5. The browser's report covers a page only from when the guard attaches to it, so each page
 *    is watched before its first navigation (OriginGuard.watch), and any other page fails the
 *    test. A popup cannot be watched that way: it runs as soon as it opens. So window.open is
 *    switched off, every window a watched page opens is reported, and so is every page the
 *    guard did not watch, however briefly it lived. A page that closes during the test fails it
 *    too: what it starts while closing goes past Playwright's routing.
 * 6. Launch switches act in every context, documents and workers no init script reached
 *    included (guardedBrowserArgs). The browser resolves only loopback hosts and the app's own,
 *    so a load the guard cannot refuse still never reaches another machine; WebRTC sends no UDP;
 *    and the unused APIs Chromium has a switch for are removed. watchOrigin refuses a browser
 *    without them.
 *
 * fixtures.ts installs the guard in every e2e test and watches its page, global-setup.ts on the
 * page it loads, and the harness specs and viteFileAccess.test.ts, which load the real app,
 * install it themselves. origin-guard.harness.ts checks each channel against two loopback origins.
 */

/** A network request one of the pages made. */
export interface PageRequest {
  resourceType: string;
  url: string;
}

/** What the pages asked the network for: everything, and what went to, or tried to reach, another origin. */
export interface OriginGuard {
  readonly appOrigin: string;
  readonly requests: readonly PageRequest[];
  readonly foreign: readonly string[];
  /**
   * Watches a page the test opened, before its first navigation: call it right after creating
   * the page. A page that has navigated already, or that cannot be watched, fails the test.
   */
  watch(page: Page): Promise<void>;
  /** Waits for the watches in progress, then reports every page the guard did not watch. */
  settled(): Promise<void>;
}

/**
 * Where a URL reaches over the network as an http(s) URL (ws: and wss: map to
 * http: and https:), or null for one that never leaves the browser (data:,
 * blob:, about:).
 */
export function networkTarget(raw: string): URL | null {
  const url = new URL(raw);
  if (url.protocol === 'ws:' || url.protocol === 'wss:') url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

const isLoopbackName = (hostname: string) => hostname === 'localhost' || hostname.endsWith('.localhost')
  || /^127(?:\.\d{1,3}){3}$/.test(hostname) || hostname === '[::1]';

/**
 * The app's own origin is the one it is served from, where Vite also proxies the
 * API. The same scheme and port under another loopback name reach the same server
 * (spending.e2e.ts opens the app as holdr-e2e.localhost).
 */
export function isAppOrigin(target: URL, app: URL): boolean {
  return target.origin === app.origin || (
    target.protocol === app.protocol && target.port === app.port
    && isLoopbackName(target.hostname) && isLoopbackName(app.hostname)
  );
}

/** Hosts the test browser resolves; Chromium itself resolves every *.localhost name to loopback. */
const RESOLVED_HOSTS = ['localhost', '*.localhost', '127.0.0.1', '::1'];

/**
 * Blink features the test browser runs without: APIs the app does not use that can reach the
 * network unseen. Each name was checked to remove its API in this build (origin-guard-coverage.harness.ts).
 * Without them the APIs are gone from every context, documents and workers no init script
 * reaches included. In the pages, the init script still defines a stub for each, so an attempt
 * is reported.
 */
export const DISABLED_BLINK_FEATURES = [
  'FetchLaterAPI', 'WebSocketStream', 'SharedWorker', 'SharedStorageAPI', 'AdInterestGroupAPI', 'Fledge', 'FencedFrames', 'FedCm', 'WebOTP',
  'DocumentPictureInPictureAPI', 'Presentation', 'Notifications', 'ScriptedSpeechRecognition', 'ScriptedSpeechSynthesis', 'TranslationAPI',
  'LanguageDetectionAPI', 'AISummarizationAPI', 'InstalledApp', 'BackgroundFetch', 'PeriodicBackgroundSync', 'PushMessaging',
];

/**
 * Chromium switches for every browser the web tests launch (both Playwright configs,
 * global-setup.ts, viteFileAccess.test.ts, browserZoom.ts). They apply to every context the browser runs, before
 * any page or init script exists:
 * - no host name or address resolves except the loopback ones and the app's own host, IP literals
 *   included, so whatever the guard cannot refuse (a speculation-rules prefetch, WebTransport)
 *   fails without a packet leaving the machine. The harness's second loopback origin still
 *   resolves, so it checks that the guard reports them.
 * - WebRTC sends no UDP that does not go through a proxy, and there is none: the resolver does not
 *   stop a STUN request to an IP address.
 * - the Blink features in DISABLED_BLINK_FEATURES are off.
 */
export function guardedBrowserArgs(appUrl?: string): string[] {
  const hosts = [...RESOLVED_HOSTS];
  const appHost = appUrl ? new URL(appUrl).hostname.replace(/^\[(.*)\]$/, '$1') : 'localhost';
  if (!hosts.includes(appHost) && !appHost.endsWith('.localhost')) hosts.push(appHost);
  return [
    `--host-resolver-rules=MAP * ~NOTFOUND , ${hosts.map((host) => `EXCLUDE ${host}`).join(' , ')}`,
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    `--disable-blink-features=${DISABLED_BLINK_FEATURES.join(',')}`,
  ];
}

/**
 * Fails unless `context`'s browser was launched with every switch of guardedBrowserArgs(appUrl) in effect. The switches
 * are read from the context's browser; a persistent context has none, so its caller passes the command line it read
 * through the context's first tab (Browser.getBrowserCommandLine, tests/browserZoom.ts).
 */
async function requireGuardedBrowser(context: BrowserContext, appUrl: string, commandLine?: readonly string[]): Promise<void> {
  const expected = guardedBrowserArgs(appUrl);
  const switches = commandLine ?? await browserCommandLine(context, expected);
  for (const wanted of expected) {
    const name = wanted.slice(0, wanted.indexOf('='));
    // Chromium uses a switch's last value. An empty one is listed without its '='.
    const found = switches.filter((value) => value === name || value.startsWith(`${name}=`)).pop();
    if (found !== wanted) {
      throw new Error(`The origin guard needs a browser launched with guardedBrowserArgs (originGuard.ts), `
        + `so that nothing it cannot refuse reaches another machine: expected ${wanted}, found ${found ?? 'none'}`);
    }
  }
}

/** The command line of `context`'s browser, from chromium.launch(). */
async function browserCommandLine(context: BrowserContext, expected: readonly string[]): Promise<string[]> {
  const browser = context.browser();
  if (!browser) throw new Error(`The origin guard needs a browser from chromium.launch() with ${expected.join(' ')}`);
  const session = await browser.newBrowserCDPSession();
  try {
    return (await session.send('Browser.getBrowserCommandLine')).arguments;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** The page-side name of the guard's report channel. */
const SWITCHED_OFF = '__holdrOriginGuardSwitchedOff';

/**
 * Runs in every frame before the page's own scripts. It switches off the APIs whose traffic
 * neither Playwright nor the browser's report shows the guard (origin-guard-coverage.harness.ts):
 * - dedicated, shared and service workers (Playwright misses the last two's traffic, and nothing
 *   could switch off WebTransport inside a dedicated worker), and audio, paint and shared storage
 *   worklets;
 * - WebRTC and WebTransport (UDP), and WebSocketStream;
 * - keepalive and deferred requests (sendBeacon, fetch with keepalive, fetchLater), which go
 *   out even while, or after, the page closes;
 * - new windows (window.open, document.open with three arguments, Document Picture-in-Picture):
 *   a window runs before the guard can watch it;
 * - the APIs whose fetches the browser makes itself: Protected Audience, Shared Storage, FedCM
 *   and the rest of navigator.credentials, Payment Request, the Presentation API, notifications
 *   (their icons), geolocation (its network location provider), speech recognition and
 *   synthesis, the built-in AI models, and getInstalledRelatedApps.
 * Each attempt is reported, and fails as the API would: a SecurityError (thrown, or as a
 * rejected promise), or null and false where a popup or a beacon is refused. Where a launch switch
 * removed the API (DISABLED_BLINK_FEATURES), the page finds a stand-in, so an attempt is still
 * reported. The script also
 * reports every speculation rules script the page adds, at any depth of what it adds, or fills
 * in later (the browser reports those too, shadow roots and headers included: watchFromStart),
 * every link hint that would open a connection, and every origin trial the page declares, also
 * where an attribute set later makes an element in the page one.
 */
function switchOffUnwatchedChannels(binding: string): void {
  const describe = (target: unknown) => {
    try {
      return typeof target === 'object' && target !== null && !(target instanceof URL) ? JSON.stringify(target) : String(target ?? '');
    } catch {
      return '(a value that cannot be printed)';
    }
  };
  const report = (channel: string, target: unknown) => {
    try {
      const send = (window as unknown as Record<string, ((channel: string, target: string) => Promise<void>) | undefined>)[binding];
      void send?.(channel, describe(target).slice(0, 300));
    } catch {
      // The attempt still fails below.
    }
  };
  const refusal = (channel: string) => new DOMException(
    `${channel} is switched off in e2e tests: the origin guard (apps/web/tests/originGuard.ts) cannot watch its traffic`,
    'SecurityError',
  );
  // Whether this build has the API or not (DISABLED_BLINK_FEATURES removes several), the page finds
  // the stand-in, so that an attempt is reported.
  const lock = (owner: object | undefined, name: string, value: unknown) => {
    if (!owner) return;
    try {
      Object.defineProperty(owner, name, { value, writable: false, configurable: false });
    } catch {
      // Already locked in this frame.
    }
  };
  const refuse = (channel: string) => function switchedOff(target?: unknown): never {
    report(channel, target);
    throw refusal(channel);
  };
  const reject = (channel: string) => function switchedOff(target?: unknown): Promise<never> {
    report(channel, target);
    return Promise.reject(refusal(channel));
  };
  const globals = window as unknown as Record<string, { prototype?: object } & object | undefined>;
  const prototypeOf = (name: string) => globals[name]?.prototype;
  type Methods = Record<string, (channel: string) => (target?: unknown) => unknown>;
  const methods = (path: string, of: Methods) => Object.fromEntries(Object.entries(of).map(([name, off]) => [name, off(`${path}.${name}`)]));
  /**
   * An API reached through an object: where this build has it, its methods are switched off on
   * `owner`; where it does not, `window[name]` becomes a stand-in with the same methods.
   */
  const switchOffObject = (name: string, owner: object | undefined, of: Methods, extra: Record<string, unknown> = {}) => {
    if (name in window && owner) {
      for (const [method, off] of Object.entries(of)) lock(owner, method, off(`${name}.${method}`));
    } else {
      lock(window, name, Object.freeze({ ...methods(name, of), ...extra }));
    }
  };
  for (const name of ['Worker', 'SharedWorker', 'WebTransport', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'WebSocketStream',
    'fetchLater', 'PaymentRequest', 'PresentationRequest', 'Notification', 'SpeechRecognition', 'webkitSpeechRecognition']) {
    lock(window, name, refuse(name));
  }
  lock(prototypeOf('ServiceWorkerContainer'), 'register', reject('ServiceWorker'));
  lock(prototypeOf('Worklet'), 'addModule', reject('Worklet'));
  const workletMethods = { addModule: reject, run: reject, selectURL: reject };
  switchOffObject('sharedStorage', prototypeOf('SharedStorage'), {
    set: reject, append: reject, delete: reject, clear: reject, get: reject, batchUpdate: reject, createWorklet: reject, run: reject, selectURL: reject,
  }, { worklet: Object.freeze(methods('sharedStorage.worklet', workletMethods)) });
  for (const [method, off] of Object.entries(workletMethods)) lock(prototypeOf('SharedStorageWorklet'), method, off(`sharedStorage.worklet.${method}`));
  for (const name of ['joinAdInterestGroup', 'leaveAdInterestGroup', 'clearOriginJoinedAdInterestGroups', 'runAdAuction',
    'getInterestGroupAdAuctionData', 'createAuctionNonce', 'deprecatedReplaceInURN', 'deprecatedURNToURL', 'getInstalledRelatedApps']) {
    lock(Navigator.prototype, name, reject(`navigator.${name}`));
  }
  lock(Navigator.prototype, 'updateAdInterestGroups', refuse('navigator.updateAdInterestGroups'));
  for (const name of ['get', 'create', 'store', 'preventSilentAccess']) lock(prototypeOf('CredentialsContainer'), name, reject(`navigator.credentials.${name}`));
  switchOffObject('IdentityCredential', globals.IdentityCredential, { disconnect: reject });
  switchOffObject('IdentityProvider', globals.IdentityProvider, { getUserInfo: reject, resolve: reject, close: refuse });
  for (const name of ['Translator', 'LanguageDetector', 'Summarizer']) switchOffObject(name, globals[name], { create: reject });
  for (const name of ['getCurrentPosition', 'watchPosition']) lock(prototypeOf('Geolocation'), name, refuse(`geolocation.${name}`));
  switchOffObject('speechSynthesis', prototypeOf('SpeechSynthesis'), { speak: refuse });
  switchOffObject('documentPictureInPicture', prototypeOf('DocumentPictureInPicture'), { requestWindow: reject });
  lock(window, 'open', function open(target?: unknown): null {
    report('window.open', target);
    return null;
  });
  const nativeDocumentOpen = Document.prototype.open;
  lock(Document.prototype, 'open', function open(this: Document, ...args: unknown[]) {
    if (args.length < 3) return Reflect.apply(nativeDocumentOpen, this, args) as Document;
    // With three arguments it opens a window, as window.open does.
    report('document.open', args[0]);
    return null;
  });
  lock(Navigator.prototype, 'sendBeacon', function sendBeacon(target?: unknown): boolean {
    report('navigator.sendBeacon', target);
    return false;
  });
  const nativeFetch = window.fetch;
  lock(window, 'fetch', function fetch(this: unknown, input: unknown, init?: unknown) {
    const options = typeof init === 'object' && init !== null ? init as { keepalive?: unknown } : {};
    const request = typeof input === 'object' && input !== null ? input as { keepalive?: unknown; url?: unknown } : {};
    if ('keepalive' in options ? Boolean(options.keepalive) : request.keepalive === true) {
      report('fetch keepalive', request.url ?? input);
      return Promise.reject(refusal('fetch keepalive'));
    }
    return Reflect.apply(nativeFetch, this, [input, init].slice(0, arguments.length)) as Promise<Response>;
  });
  // By name and attribute, not instanceof: an element made in another frame belongs to that frame's realm.
  const isElement = (node: Node, name: string): node is Element => node.nodeType === Node.ELEMENT_NODE && (node as Element).localName === name;
  const check = (node: Node) => {
    if (isElement(node, 'script') && (node.getAttribute('type') ?? '').trim().toLowerCase() === 'speculationrules') {
      report('speculation rules', node.textContent);
    }
    if (isElement(node, 'link')) {
      const rel = (node.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
      // The browser reads the href against the document. Read on its own as well, as the header
      // checks read every URL (readingsOf).
      const href = (node as HTMLLinkElement).href;
      const raw = (node.getAttribute('href') ?? '').trim();
      const alone = URL.canParse(raw) ? new URL(raw).href : href;
      for (const hint of ['preconnect', 'dns-prefetch', 'prerender']) {
        if (!rel.includes(hint)) continue;
        report(`link hint ${hint}`, href);
        if (alone !== href) report(`link hint ${hint}`, alone);
      }
    }
    if (isElement(node, 'meta') && (node.getAttribute('http-equiv') ?? '').trim().toLowerCase() === 'origin-trial') {
      report('origin trial', node.getAttribute('content'));
    }
  };
  new MutationObserver((records) => {
    for (const record of records) {
      // Text added to a script already in the page, which the browser then reads as rules, or an
      // attribute that makes an element in the page a hint, a rules script or an origin trial.
      check(record.target);
      for (const node of Array.from(record.addedNodes)) {
        check(node);
        if (node.nodeType === Node.ELEMENT_NODE) (node as Element).querySelectorAll('script, link, meta').forEach(check);
      }
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'rel', 'href', 'http-equiv', 'content'] });
}

/**
 * The init script: switchOffUnwatchedChannels's source, run in every frame. A transpiler may add
 * helper calls to that source (tsx adds __name), so it gets a no-op one. If the guard still fails
 * to install in a frame, it says so, and the test fails.
 */
function initScript(binding: string): string {
  const send = `window[${JSON.stringify(binding)}]`;
  return `(() => {
  const __name = (fn) => fn;
  try {
    (${switchOffUnwatchedChannels.toString()})(${JSON.stringify(binding)});
  } catch (error) {
    ${send}?.('origin guard', 'not installed in ' + location.href + ': ' + error);
  }
})();`;
}

/**
 * Reports, from the browser itself, what `page` does that neither Playwright nor the init script
 * sees: every speculation rule set the browser accepts, however it arrived (the parser, a script
 * at any depth or in a shadow root, a Speculation-Rules header), every prefetch or prerender it
 * starts, and every window it opens (a link or form with a target, as window.open is off).
 */
async function watchFromStart(context: BrowserContext, page: Page, note: (text: string) => void): Promise<void> {
  const session = await context.newCDPSession(page);
  session.on('Preload.ruleSetUpdated', ({ ruleSet }) => {
    note(`speculation rule set ${ruleSet.url ?? 'inline'} ${ruleSet.sourceText.slice(0, 300)}`);
  });
  session.on('Preload.prefetchStatusUpdated', ({ prefetchUrl }) => note(`speculative prefetch ${prefetchUrl}`));
  session.on('Preload.prerenderStatusUpdated', ({ key }) => note(`speculative prerender ${key.url}`));
  session.on('Page.windowOpen', ({ url }) => note(`popup ${url}`));
  await session.send('Page.enable');
  await session.send('Preload.enable');
}

/** One link-value of a Link header: its target and its parameters (RFC 8288). */
interface LinkValue { target: string; params: Record<string, string> }

/**
 * A Link header's link-values, or null where it does not parse. Playwright joins a repeated header
 * with newlines; the browser reads the lines as one comma-separated list. A quoted parameter may
 * hold commas and angle brackets.
 */
export function parseLinkHeader(value: string): LinkValue[] | null {
  const text = value.split('\n').join(',');
  const links: LinkValue[] = [];
  let at = 0;
  const skip = (chars: RegExp) => {
    while (at < text.length && chars.test(text[at])) at++;
  };
  for (;;) {
    skip(/[ \t,]/);
    if (at >= text.length) return links;
    if (text[at] !== '<') return null;
    const close = text.indexOf('>', at);
    if (close < 0) return null;
    const link: LinkValue = { target: text.slice(at + 1, close), params: {} };
    at = close + 1;
    for (;;) {
      skip(/[ \t]/);
      if (at >= text.length || text[at] === ',') break;
      if (text[at] !== ';') return null;
      at++;
      skip(/[ \t]/);
      const name = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/.exec(text.slice(at))?.[0];
      if (!name) return null;
      at += name.length;
      skip(/[ \t]/);
      let param = '';
      if (text[at] === '=') {
        at++;
        skip(/[ \t]/);
        if (text[at] === '"') {
          for (at++; at < text.length && text[at] !== '"'; at++) {
            if (text[at] === '\\') at++;
            param += text[at] ?? '';
          }
          if (text[at] !== '"') return null;
          at++;
        } else {
          param = /^[^\s;,]*/.exec(text.slice(at))![0];
          at += param.length;
        }
      }
      link.params[name.toLowerCase()] ??= param;
    }
    links.push(link);
  }
}

/**
 * Every string in a Report-To header, its endpoint URLs among them, or null where it does not
 * parse: the browser reads the header, repeated headers joined with commas, as a JSON list of
 * endpoint groups. Each string counts as an endpoint, keys and the values of repeated keys
 * included, so the check does not depend on which of two `url`s the browser keeps.
 */
export function parseReportTo(value: string): string[] | null {
  const text = `[${value.split('\n').join(',')}]`;
  try {
    const groups: unknown = JSON.parse(text);
    for (const group of groups as unknown[]) {
      const endpoints = (group as { endpoints?: unknown } | null)?.endpoints;
      if (!Array.isArray(endpoints)) return null;
      if (endpoints.some((endpoint) => typeof (endpoint as { url?: unknown } | null)?.url !== 'string')) return null;
    }
    // The text is valid JSON, so this finds exactly its strings.
    return (text.match(/"(?:[^"\\]|\\.)*"/g) ?? []).map((token) => JSON.parse(token) as string);
  } catch {
    return null;
  }
}

/**
 * The endpoint URLs of a Reporting-Endpoints header, a structured-field dictionary of strings
 * (RFC 8941), or null where it does not parse. A member whose value is not a string, or that has
 * parameters, is not read either.
 */
export function parseReportingEndpoints(value: string): string[] | null {
  const text = value.split('\n').join(',');
  const urls: string[] = [];
  let at = 0;
  const skip = () => {
    while (text[at] === ' ' || text[at] === '\t') at++;
  };
  skip();
  if (at >= text.length) return urls;
  for (;;) {
    const key = /^[a-z*][a-z0-9_\-.*]*/.exec(text.slice(at))?.[0];
    if (!key || text[at + key.length] !== '=' || text[at + key.length + 1] !== '"') return null;
    let url = '';
    for (at += key.length + 2; ; at++) {
      const char = text[at];
      if (char === undefined || char < ' ' || char > '~') return null;
      if (char === '"') break;
      if (char === '\\') {
        at++;
        if (text[at] !== '"' && text[at] !== '\\') return null;
      }
      url += text[at];
    }
    at++;
    urls.push(url);
    skip();
    if (at >= text.length) return urls;
    if (text[at] !== ',') return null;
    at++;
    skip();
  }
}

/**
 * Every URL the browser may read `raw` as, in a response from `at`: against the response's URL, as
 * Chromium reads a Link target, a CSP report-uri, a Speculation-Rules URL and a link's href, and,
 * where `raw` has a scheme, on its own, as Chromium's Reporting API reads each endpoint that is not
 * a path. The two differ for a URL with the response's scheme and no "//": `https:host/x` from an
 * https page is a path on the page's origin against its URL, and that host on its own. Null
 * stands for a reading that does not parse.
 */
export function readingsOf(raw: string, at: string): (string | null)[] {
  const read = (base?: string) => {
    try {
      return new URL(raw.trim(), base).href;
    } catch {
      return null;
    }
  };
  const alone = read();
  return alone === null ? [read(at)] : [read(at), alone];
}

/** Response headers that make the browser send something later, or to an address the URL does not show. */
const SENDS_LATER = [
  'attribution-reporting-register-source', 'attribution-reporting-register-trigger',
  'attribution-reporting-register-os-source', 'attribution-reporting-register-os-trigger',
  'sec-session-registration', 'origin-trial',
];

/**
 * Reports what a response's headers make the browser do beyond loading it:
 * - rules to prefetch by (Speculation-Rules);
 * - links to another origin (Link);
 * - report endpoints at another origin: Reporting-Endpoints, Report-To and a CSP report-uri. NEL,
 *   COOP, COEP and the other policies send their reports to those endpoints;
 * - attribution and device-bound session registrations;
 * - origin trials, which can switch on APIs this guard has not reviewed;
 * - alternative services.
 * Headers are parsed as the browser parses them. Each URL in them counts as wherever the browser
 * may read it (readingsOf), so an escaped, relative, protocol-relative or schemed URL counts as
 * what it resolves to. A header that does not parse is reported too.
 */
function reportHeaders(headers: Record<string, string>, at: string, isForeign: (url: string) => boolean, note: (text: string) => void): void {
  // The first reading of `raw` that is not a URL at the app's own origin (`raw` itself where that
  // reading does not parse), or null where every reading is.
  const elsewhere = (raw: string) => {
    for (const url of readingsOf(raw, at)) {
      if (url === null || isForeign(url)) return url ?? raw;
    }
    return null;
  };
  const unparsed = (name: string) => note(`${name} header that the guard cannot parse, on ${at}: ${headers[name].slice(0, 200)}`);
  if (headers['speculation-rules'] !== undefined) note(`Speculation-Rules header ${headers['speculation-rules']} on ${at}`);
  if (headers.link !== undefined) {
    const links = parseLinkHeader(headers.link);
    if (!links) unparsed('link');
    for (const { target, params } of links ?? []) {
      const url = elsewhere(target);
      if (url !== null) note(`Link header ${params.rel ?? ''} ${url} on ${at}`);
      // An image preload fetches one of its imagesrcset candidates instead of its target. Every
      // word is checked, descriptors too, so a candidate URL that holds a comma is not missed.
      for (const word of (params.imagesrcset ?? '').split(/[\s,]+/)) {
        const candidate = word ? elsewhere(word) : null;
        if (candidate !== null) note(`Link header ${params.rel ?? ''} imagesrcset ${candidate} on ${at}`);
      }
    }
  }
  for (const [name, parse] of [['reporting-endpoints', parseReportingEndpoints], ['report-to', parseReportTo]] as const) {
    if (headers[name] === undefined) continue;
    const urls = parse(headers[name]);
    if (!urls) unparsed(name);
    for (const target of urls ?? []) {
      const url = elsewhere(target);
      if (url !== null) note(`${name} header sends reports to ${url}, from ${at}`);
    }
  }
  for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
    for (const policy of (headers[name] ?? '').split(/[\n,]/)) {
      for (const directive of policy.split(';')) {
        const [directiveName, ...targets] = directive.trim().split(/[\t\n\f\r ]+/);
        if (directiveName?.toLowerCase() !== 'report-uri') continue;
        for (const target of targets) {
          const url = elsewhere(target);
          if (url !== null) note(`${name} header sends reports to ${url}, from ${at}`);
        }
      }
    }
  }
  for (const name of SENDS_LATER) {
    if (headers[name] !== undefined) note(`${name} header ${headers[name].slice(0, 200)} on ${at}`);
  }
  if (headers['alt-svc'] !== undefined && headers['alt-svc'].trim() !== 'clear') note(`alt-svc header ${headers['alt-svc']} on ${at}`);
}

/**
 * Guards every page of `context` against `appUrl`'s origin. Install it before the context has a
 * page, then watch each page the test opens before its first navigation (OriginGuard.watch).
 * Records every request and refuses (never sends) those to another origin, records WebSockets to
 * another origin and speculative loads, switches off the channels it cannot watch, and reports
 * every page it did not watch. A persistent context passes its browser's `commandLine` (see requireGuardedBrowser).
 */
export async function watchOrigin(context: BrowserContext, appUrl: string, options: { commandLine?: readonly string[] } = {}): Promise<OriginGuard> {
  // The init script reaches only documents created after it is installed: an existing page keeps
  // every API the guard switches off.
  if (context.pages().length > 0) {
    throw new Error(`Install the origin guard before the context has a page: ${context.pages().length} exist already, `
      + 'and their documents keep every API the guard switches off');
  }
  const app = new URL(appUrl);
  const requests: PageRequest[] = [];
  const foreign: string[] = [];
  const isForeign = (raw: string) => {
    const target = networkTarget(raw);
    return target !== null && !isAppOrigin(target, app);
  };
  // The browser repeats a rule set's report as its state changes; one line each is enough.
  const noted = new Set<string>();
  const note = (text: string) => {
    const line = `${text} (a channel the guard cannot watch)`;
    if (noted.has(line)) return;
    noted.add(line);
    foreign.push(line);
  };
  // Every page from here on. Playwright reports every page, even one that closed while it was
  // setting it up. One created before the init script is installed keeps the native APIs.
  const seen: Page[] = [];
  const early = new Set<Page>();
  let installed = false;
  context.on('page', (page) => {
    seen.push(page);
    if (!installed) early.add(page);
    page.on('websocket', (socket) => {
      if (isForeign(socket.url())) foreign.push(`websocket ${socket.url()}`);
    });
  });
  await requireGuardedBrowser(context, appUrl, options.commandLine);
  context.on('request', (request) => {
    requests.push({ resourceType: request.resourceType(), url: request.url() });
    if (isForeign(request.url())) foreign.push(`${request.resourceType()} ${request.url()}`);
  });
  context.on('response', (response) => reportHeaders(response.headers(), response.url(), isForeign, note));
  const watched = new Set<Page>();
  const reported = new Set<Page>();
  const watching = new Set<Promise<void>>();
  const watch = async (page: Page) => {
    if (watched.has(page)) return;
    watched.add(page);
    // A closing page's own requests go past Playwright's routing (the context's close runs no
    // unload handlers, so the pages a test leaves open close without sending anything).
    page.once('close', () => foreign.push(`the page at ${page.url()} closed during the test: what it starts while closing goes past the guard`));
    const blank = () => {
      if (page.url() !== 'about:blank') throw new Error(`it had navigated to ${page.url()} already`);
    };
    const watchingPage = (async () => {
      if (early.has(page)) throw new Error('it was created before the guard was installed, so it keeps every API the guard switches off');
      blank();
      await watchFromStart(context, page, note);
      blank();
    })().catch((error: Error) => {
      // Closed or not: what it did before closing went unwatched.
      foreign.push(`the guard could not watch the page at ${page.url()} from before its first navigation: ${error.message.split('\n')[0]}`);
    });
    watching.add(watchingPage);
    await watchingPage;
  };
  await context.route((url) => isForeign(url.href), (route) => route.abort('blockedbyclient'));
  await context.exposeBinding(SWITCHED_OFF, (_source, channel: string, target: string) => {
    // A link hint to the app's own origin opens no connection elsewhere.
    if (channel.startsWith('link hint ') && URL.canParse(target) && !isForeign(target)) return;
    foreign.push(`${channel} ${target} (a channel the guard cannot watch)`);
  });
  await context.addInitScript({ content: initScript(SWITCHED_OFF) });
  installed = true;
  const settled = async () => {
    for (let count = -1; count !== watching.size;) {
      count = watching.size;
      await Promise.all(watching);
    }
    for (const page of seen) {
      if (watched.has(page) || reported.has(page)) continue;
      reported.add(page);
      foreign.push(`a page the guard did not watch from before its first navigation, at ${page.url()} (a popup, or a page opened without OriginGuard.watch)`);
    }
  };
  return { appOrigin: app.origin, requests, foreign, watch, settled };
}

/** Fails when a page contacted another origin, or tried to through a channel the guard cannot watch. */
export async function expectNoForeignTraffic(guard: OriginGuard, step?: string): Promise<void> {
  await guard.settled();
  expect(guard.foreign, `${step ? `${step}: ` : ''}traffic to an origin other than ${guard.appOrigin}`).toEqual([]);
}
