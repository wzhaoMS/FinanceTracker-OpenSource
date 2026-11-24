/**
 * Fake issuer sites for the extension e2e (plan §9.2). Everything here is
 * invented: names, numbers, merchants, amounts. Each site runs on its own
 * loopback port and is reachable from the test browser only through the
 * egress gate under a made-up `*.e3.test` host.
 *
 * Canaries that must never leave the page in any form:
 *   CANARY_PAN (the full test card number; may leave only redacted),
 *   the account tokens/ids and the cardholder names.
 * A row containing a card security code must be refused, never redacted.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const CANARY_PAN = '4111111111111111';
export const CANARY_SECRET_ROW = 'SYNTHETIC GADGETS CVV 123';
export const CHASE_ACCOUNT_IDS = ['90000000123', '90000000456', '90000000789'];
export const AMEX_TOKEN = 'TOKEN-AMEX-0001-SYNTH';
export const CITI_ACCOUNT_ID = 'CITI-ACC-77001';
/** Another account's id: reached only through a redirect of the page's own request (never on the page's tiles). */
export const CITI_OTHER_ACCOUNT_ID = 'CITI-ACC-77002';
export const CITI_NAMES = ['EXAMPLE PRIMARY', 'EXAMPLE AUTHORIZED'];
export const AMEX_SUPPLEMENTARY_NAME = 'Example Supplementary';
/** Routing material used as an object key (letters only, so no digit rule could catch it). */
export const AMEX_ROUTING_KEY = 'SyntheticRoutingKeyAlpha';
export const WF_ACCOUNT_KEY = 'WF-ACCT-SYN-5501';

export const PAGE_CANARIES: readonly string[] = [CANARY_PAN, ...CHASE_ACCOUNT_IDS, AMEX_TOKEN, AMEX_ROUTING_KEY, CITI_ACCOUNT_ID, CITI_OTHER_ACCOUNT_ID, ...CITI_NAMES, AMEX_SUPPLEMENTARY_NAME, WF_ACCOUNT_KEY, 'CVV 123'];

export type ChaseVariant = 'normal' | 'repeated-cursor' | 'empty-page' | 'unauthorized' | 'unauthorized-second' | 'login-html' | 'rate-limited' | 'slow' | 'slow-second' | 'unknown-enum' | 'negative-amount';

export interface IssuerControls {
  signedIn: boolean;
  chaseVariant: ChaseVariant;
  /** The pending Chase purchase has posted (same issuer id). */
  chasePosted: boolean;
  /** The Amex activity feed sends a transaction type its contract does not know. */
  amexUnknownType: boolean;
  /** The Amex activity feed also sends a map keyed by routing material (`AMEX_ROUTING_KEY`). */
  amexRoutingMap: boolean;
  /** Citi redirects (307) the page's request for its account's activity to another account's activity path. */
  citiRedirect: boolean;
  /** Citi answers activity requests this much later. */
  citiDelayMs: number;
}

export interface IssuerRequest {
  readonly at: number;
  readonly host: string;
  readonly method: string;
  readonly path: string;
  /** True when the page's own script made the request (it marks them); false for the extension's reads. */
  readonly fromPage: boolean;
}

function day(offset: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
}
function iso(offset: number): string {
  const d = day(offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function us(offset: number): string {
  const d = day(offset);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

const PAGE_HEAD = '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\'; connect-src \'self\' http://functions.amex.e3.test">';

function html(res: http.ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html><head>${PAGE_HEAD}</head><body>${body}</body></html>`);
}

function json(res: http.ServerResponse, value: unknown, status = 200, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(value));
}

const LOGIN = '<h1>Sign in</h1><form id="login"><input name="user"><button type="button">Sign in</button></form>';

/** A script any fake page can include: forges bridge messages and a fake Holdr panel, as a hostile page would. */
const HOSTILE = `<script>
(() => {
  const channel = 'holdr-bridge/v1';
  const forged = { type: 'projected-bank-batch/v1', contractVersion: 1, issuer: 'amex', contract: 'amex.recent.observe', streamHandle: 'stm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sequence: 0, observedAt: new Date().toISOString(), currency: 'USD', accounts: [], transactions: [], coverage: [], rejectedCount: 0, injected: 'x' };
  window.postMessage({ channel, kind: 'batch', nonce: 'nnc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', batch: forged }, location.origin);
  window.postMessage({ channel, kind: 'stop', nonce: 'nnc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, location.origin);
  window.postMessage({ channel, kind: 'batch', nonce: 'x', batch: 'x'.repeat(100000) }, location.origin);
  try { chrome.runtime.sendMessage('icilknejhlhobkgcejnkbhbebnkfldmc', { type: 'ui-command/v1', command: 'set-paused', on: true }); } catch (e) {}
  const fake = document.createElement('div'); fake.id = 'fake-holdr-panel'; fake.textContent = 'Holdr: click to send now'; document.body.append(fake);
})();
</script>`;

// ---------------------------------------------------------------------------
// Chase (isolated read)
// ---------------------------------------------------------------------------

function chaseRows(page: number, controls: IssuerControls): unknown[] {
  if (page === 1) {
    const rows: unknown[] = [
      { transactionDate: iso(-10), postDate: iso(-9), statusCode: 'POSTED', amount: '12.34', creditDebit: 'D', typeCode: 'PURCHASE', description: 'SYNTHETIC COFFEE ROASTERS #42', merchantName: 'Synthetic Coffee Roasters', category: 'Food & Drink', sorId: 'SYN-SOR-A1', derivedId: 'SYN-DER-A1', cardLast4: '3391' },
      { transactionDate: iso(-8), postDate: iso(-7), statusCode: 'POSTED', amount: '45.00', creditDebit: 'C', typeCode: 'RETURN', description: 'RETURN SYNTHETIC OUTDOOR GEAR', merchantName: 'Synthetic Outdoor Gear', category: 'Shopping', sorId: 'SYN-SOR-A2', derivedId: 'SYN-DER-A2', cardLast4: '3391' },
      { transactionDate: iso(-7), postDate: iso(-7), statusCode: 'POSTED', amount: '1500.00', creditDebit: 'C', typeCode: 'PAYMENT', description: 'AUTOMATIC PAYMENT - THANK YOU', merchantName: null, category: null, sorId: 'SYN-SOR-A3', cardLast4: '3391' },
      { transactionDate: iso(-6), postDate: iso(-5), statusCode: 'POSTED', amount: '20.00', creditDebit: 'D', typeCode: 'PURCHASE', description: `SYNTHETIC STORE REF ${CANARY_PAN}`, merchantName: 'Synthetic Store', category: 'Shopping', sorId: 'SYN-SOR-A4', cardLast4: '3391' },
      { transactionDate: iso(-6), postDate: iso(-5), statusCode: 'POSTED', amount: '5.00', creditDebit: 'D', typeCode: 'PURCHASE', description: CANARY_SECRET_ROW, merchantName: null, category: null, sorId: 'SYN-SOR-A5', cardLast4: '3391' },
    ];
    if (controls.chaseVariant === 'unknown-enum') (rows[0] as Record<string, unknown>).statusCode = 'MYSTERY';
    // The amount is a magnitude and the sign is in creditDebit: a signed amount is a changed form.
    if (controls.chaseVariant === 'negative-amount') (rows[0] as Record<string, unknown>).amount = '-12.34';
    return rows;
  }
  return [
    { transactionDate: iso(-4), postDate: iso(-4), statusCode: 'POSTED', amount: '3.21', creditDebit: 'D', typeCode: 'INTEREST', description: 'PURCHASE INTEREST CHARGE', merchantName: null, category: 'Fees & Adjustments', sorId: 'SYN-SOR-A6', cardLast4: '3391' },
    { transactionDate: iso(-3), postDate: iso(-2), statusCode: 'POSTED', amount: '9.99', creditDebit: 'D', typeCode: 'PURCHASE', description: 'SYNTHETIC SNACK BAR', merchantName: 'Synthetic Snack Bar', category: 'Food & Drink', sorId: 'SYN-SOR-A7', cardLast4: '7720' },
    { transactionDate: iso(-3), postDate: iso(-2), statusCode: 'POSTED', amount: '9.99', creditDebit: 'D', typeCode: 'PURCHASE', description: 'SYNTHETIC SNACK BAR', merchantName: 'Synthetic Snack Bar', category: 'Food & Drink', sorId: 'SYN-SOR-A8', cardLast4: '7720' },
    controls.chasePosted
      ? { transactionDate: iso(-1), postDate: iso(0), statusCode: 'POSTED', amount: '8.75', creditDebit: 'D', typeCode: 'PURCHASE', description: 'SYNTHETIC CORNER MARKET', merchantName: 'Synthetic Corner Market', category: 'Groceries', sorId: 'SYN-SOR-A9', cardLast4: '3391' }
      : { transactionDate: iso(-1), postDate: null, statusCode: 'PENDING', amount: '8.75', creditDebit: 'D', typeCode: 'PURCHASE', description: 'SYNTHETIC CORNER MARKET', merchantName: 'Synthetic Corner Market', category: 'Groceries', sorId: 'SYN-SOR-A9', cardLast4: '3391' },
  ];
}

const CURSOR_2 = 'c2#opaque/+==';

function chase(controls: IssuerControls, log: (req: http.IncomingMessage) => void): http.RequestListener {
  return (req, res) => {
    log(req);
    const url = new URL(req.url ?? '/', 'http://chase.e3.test');
    if (url.pathname === '/favicon.ico') return void res.writeHead(404).end();
    if (url.pathname === '/login') return html(res, LOGIN);
    if (url.pathname.startsWith('/dashboard')) {
      if (!controls.signedIn) return html(res, LOGIN);
      // Signed in, but a page without the activity view (summary): nothing to read here.
      if (url.searchParams.get('view') === 'summary') return html(res, '<h1>Fake Chase</h1><p>Summary only.</p><nav><a id="to-activity" href="/dashboard">Activity</a></nav>');
      const hostile = url.searchParams.get('hostile') === '1' ? HOSTILE : '';
      return html(
        res,
        `<h1>Fake Chase</h1><nav><a id="to-other" href="/dashboard/account/2">Other card</a> <button id="sign-out-in-place">Sign out (in place)</button><button id="sign-in-in-place">Sign in again (in place)</button></nav>
<div id="activity-root" data-ready="true"><ul id="rows"></ul></div>
<script>
const marker = { 'x-fake-page': '1' };
fetch('/fake-api/accounts/list', { method: 'POST', body: '', headers: { ...marker, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' } })
  .then((r) => r.json()).then((data) => {
    const card = data.tiles.find((tile) => tile.category === 'CARD');
    return fetch('/fake-api/accounts/' + card.accountId + '/activity?start=${iso(-29)}&end=${iso(0)}&count=50', { headers: marker });
  })
  .then((r) => r.json()).then((page) => {
    for (const row of page.activities) { const li = document.createElement('li'); li.textContent = row.transactionDate + ' ' + row.description + ' ' + row.amount; document.getElementById('rows').append(li); }
  }).catch(() => {});
document.getElementById('to-other').addEventListener('click', (event) => { event.preventDefault(); history.pushState({}, '', '/dashboard/account/2'); });
// Signed out in place: the sign-in view replaces the activity view at the same address, and back.
document.getElementById('sign-out-in-place').addEventListener('click', () => { document.getElementById('activity-root').dataset.ready = 'false'; const form = document.createElement('form'); form.id = 'login'; document.body.append(form); });
document.getElementById('sign-in-in-place').addEventListener('click', () => { document.getElementById('login')?.remove(); document.getElementById('activity-root').dataset.ready = 'true'; });
</script>${hostile}`,
      );
    }
    if (req.method === 'POST' && url.pathname === '/fake-api/accounts/list') {
      return json(res, {
        tiles: [
          { accountId: CHASE_ACCOUNT_IDS[0], mask: 'XXXX3391', nickname: 'Sapphire Example', category: 'CARD' },
          { accountId: CHASE_ACCOUNT_IDS[1], mask: 'XXXX7720', nickname: 'Freedom Example', category: 'CARD' },
          { accountId: CHASE_ACCOUNT_IDS[2], mask: 'XXXX0042', nickname: 'Checking Example', category: 'DDA' },
        ],
      });
    }
    const activity = /^\/fake-api\/accounts\/([0-9]+)\/activity$/.exec(url.pathname);
    if (req.method === 'GET' && activity) {
      const fromPage = req.headers['x-fake-page'] === '1';
      const variant = fromPage ? 'normal' : controls.chaseVariant;
      if (variant === 'unauthorized') return json(res, { error: 'signed out' }, 401);
      // Signed out between two pages of one read: the first page answers, the second is refused.
      if (variant === 'unauthorized-second' && url.searchParams.get('cursor') === CURSOR_2) return json(res, { error: 'signed out' }, 401);
      if (variant === 'login-html') return html(res, LOGIN);
      if (variant === 'rate-limited') return json(res, { error: 'slow down' }, 429, { 'retry-after': '120' });
      const send = () => {
        const cursor = url.searchParams.get('cursor');
        if (cursor === null) return json(res, { activities: chaseRows(1, controls), more: true, cursor: CURSOR_2 });
        if (cursor === CURSOR_2) {
          if (variant === 'repeated-cursor') return json(res, { activities: chaseRows(2, controls).slice(0, 1), more: true, cursor: CURSOR_2 });
          if (variant === 'empty-page') return json(res, { activities: [], more: true, cursor: 'c3' });
          return json(res, { activities: chaseRows(2, controls), more: false, cursor: null });
        }
        return json(res, { activities: [], more: false, cursor: null });
      };
      if (variant === 'slow' && url.searchParams.get('cursor') === null) setTimeout(send, 6_000);
      else if (variant === 'slow-second' && url.searchParams.get('cursor') === CURSOR_2) setTimeout(send, 2_500);
      else send();
      return;
    }
    res.writeHead(404).end();
  };
}

// ---------------------------------------------------------------------------
// American Express (MAIN passive, cross-origin wrapper)
// ---------------------------------------------------------------------------

function amexPage(controls: IssuerControls, log: (req: http.IncomingMessage) => void): http.RequestListener {
  return (req, res) => {
    log(req);
    const url = new URL(req.url ?? '/', 'http://amex.e3.test');
    if (url.pathname === '/favicon.ico') return void res.writeHead(404).end();
    // A script that keeps the parser waiting, so the page's own data can arrive before DOMContentLoaded.
    if (url.pathname === '/slow-parse.js') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end('// parsed late\n');
      }, 1_500);
      return;
    }
    if (url.pathname !== '/activity') return html(res, '<h1>Fake Amex home</h1>');
    if (!controls.signedIn) return html(res, LOGIN);
    const hostile = url.searchParams.get('hostile') === '1' ? HOSTILE : '';
    const slowParse = url.searchParams.get('slowParse') === '1' ? '<script src="/slow-parse.js"></script><p id="late">late</p>' : '';
    // With the routing map on, the page also names a request header after routing material.
    const routingHeader = controls.amexRoutingMap ? `, '${AMEX_ROUTING_KEY.toLowerCase()}': '1'` : '';
    return html(
      res,
      `<script>window.__FAKE_AMEX_STATE__ = { cards: [ { token: '${AMEX_TOKEN}', display: '-30003', product: 'Gold Card Example' } ] };</script>
<h1>Fake Amex</h1><div id="activity-app" data-ready="true"><ul id="rows"></ul></div>
<button id="load-more">Load more</button><button id="refresh">Refresh</button>
<script>
const load = (offset) => fetch('http://functions.amex.e3.test/ReadAccountActivity.web.v1', {
  method: 'POST', headers: { 'content-type': 'application/json', 'ce-source': 'WEB'${routingHeader} },
  body: JSON.stringify({ accountToken: window.__FAKE_AMEX_STATE__.cards[0].token, locale: 'en-US', limit: 50, offset, view: 'RECENT' }),
}).then((r) => r.json()).then((page) => {
  for (const row of page.transactions) { const li = document.createElement('li'); li.textContent = row.displayDate + ' ' + row.description; document.getElementById('rows').append(li); }
  document.getElementById('activity-app').dataset.loaded = String(Number(document.getElementById('activity-app').dataset.loaded || 0) + 1);
});
load(0);
document.getElementById('load-more').addEventListener('click', () => load(50));
document.getElementById('refresh').addEventListener('click', () => load(0));
</script>${slowParse}${hostile}`,
    );
  };
}

function amexFunctions(controls: IssuerControls, log: (req: http.IncomingMessage) => void): http.RequestListener {
  const cors = {
    'access-control-allow-origin': 'http://amex.e3.test',
    'access-control-allow-headers': `content-type, ce-source, ${AMEX_ROUTING_KEY.toLowerCase()}`,
    'access-control-allow-methods': 'POST',
    vary: 'Origin',
  };
  return (req, res) => {
    log(req);
    const url = new URL(req.url ?? '/', 'http://functions.amex.e3.test');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/ReadAccountActivity.web.v1') return void res.writeHead(404, cors).end();
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let offset = 0;
      try {
        offset = Number(JSON.parse(body).offset) || 0;
      } catch {
        offset = 0;
      }
      const first = [
        { displayDate: iso(-5), description: 'ANNUAL MEMBERSHIP FEE', amount: 95, type: 'FEE', status: 'posted', memberName: null, cardEnding: '30003', category: 'Fees & Adjustments' },
        { displayDate: iso(-4), description: 'SYNTHETIC GROCERY MARKET', amount: 64.2, type: 'CHARGE', status: 'posted', memberName: null, cardEnding: '30003', category: 'Groceries' },
        { displayDate: iso(-3), description: 'SYNTHETIC BOOKSHOP', amount: 18.5, type: 'CHARGE', status: 'posted', memberName: AMEX_SUPPLEMENTARY_NAME, cardEnding: '33382', category: 'Shopping' },
        { displayDate: iso(-3), description: 'SYNTHETIC BOOKSHOP', amount: 18.5, type: 'CHARGE', status: 'posted', memberName: AMEX_SUPPLEMENTARY_NAME, cardEnding: '33382', category: 'Shopping' },
        { displayDate: iso(-2), description: 'RETURN SYNTHETIC SHOES', amount: -30, type: 'CREDIT', status: 'posted', memberName: null, cardEnding: '30003', category: 'Shopping' },
        { displayDate: iso(-1), description: 'SYNTHETIC TAXI', amount: 12.75, type: 'CHARGE', status: 'pending', memberName: null, cardEnding: '30003', category: 'Travel' },
      ];
      const second = [{ displayDate: iso(-20), description: 'SYNTHETIC HARDWARE', amount: 41.1, type: 'CHARGE', status: 'posted', memberName: null, cardEnding: '30003', category: 'Home' }];
      if (controls.amexUnknownType) first[0] = { ...first[0], type: 'MYSTERY' };
      const page: Record<string, unknown> = offset === 0 ? { transactions: first, hasMore: true } : { transactions: second, hasMore: false };
      if (controls.amexRoutingMap) {
        page.cardsByToken = { [AMEX_ROUTING_KEY]: { status: 'ACTIVE' } };
        // A wide structure of confirmed names (15 × 15 paths): a shape report well over a hundred entries.
        const names = ['amount', 'type', 'status', 'category', 'description', 'displayDate', 'memberName', 'cardEnding', 'hasMore', 'transactions', 'locale', 'limit', 'offset', 'view', 'accountToken'];
        page.details = Object.fromEntries(names.map((outer) => [outer, Object.fromEntries(names.map((inner) => [inner, 1]))]));
      }
      json(res, page, 200, cors);
    });
  };
}

// ---------------------------------------------------------------------------
// Citi (MAIN passive over XHR, string continuation flag, cache-only "load more",
// an SPA account switch that shows cached rows, a redirect to another account)
// ---------------------------------------------------------------------------

function citi(controls: IssuerControls, log: (req: http.IncomingMessage) => void): http.RequestListener {
  return (req, res) => {
    log(req);
    const url = new URL(req.url ?? '/', 'http://citi.e3.test');
    if (url.pathname === '/favicon.ico') return void res.writeHead(404).end();
    if (url.pathname === '/accounts') {
      if (!controls.signedIn) return html(res, LOGIN);
      return html(
        res,
        `<h1>Fake Citi</h1><div id="citi-app" data-ready="true"><ul id="rows"></ul><ul id="cached" hidden><li>cached row</li></ul></div>
<button id="load-more">Load more</button><button id="show-cached">Show more (cached)</button><button id="to-other">Other account (cached)</button><button id="to-main">First account (cached)</button><button id="switch-and-load">Other account (loads at once)</button><button id="reuse-xhr">Reuse a request</button><button id="sign-out-in-place">Sign out (in place)</button><button id="sign-in-in-place">Sign in again (in place)</button><button id="sign-in-and-load">Sign in again and load (in place)</button><button id="load-3-pages">Load pages 3 to 5</button><button id="load-9-pages">Load pages 3 to 11</button>
<script>
const xhr = (method, path, body) => new Promise((resolve) => {
  const request = new XMLHttpRequest();
  request.open(method, path);
  if (body !== undefined) request.setRequestHeader('content-type', 'application/json');
  request.addEventListener('load', () => {
    const app = document.getElementById('citi-app');
    app.dataset.answers = String(Number(app.dataset.answers || 0) + 1);
    resolve(JSON.parse(request.responseText));
  });
  request.send(body === undefined ? null : JSON.stringify(body));
});
const render = (page) => { for (const row of [...page.pendingTransactions, ...page.postedTransactions]) { const li = document.createElement('li'); li.textContent = row.purchaseDate + ' ' + row.description; document.getElementById('rows').append(li); } };
const retrievePath = '/gcg-fake/v1/accounts/${CITI_ACCOUNT_ID}/transactions/retrieve';
const firstPage = { nextTableIndex: null, moreTransactionsFlag: null, isRedesignPage: true };
if (new URLSearchParams(location.search).get('chain') === '1') {
  // One XHR for both pages: it is opened again for page 2 inside its own load handler.
  xhr('GET', '/gcg-fake/v1/dashboard/tiles').then(() => {
    const request = new XMLHttpRequest();
    let pages = 0;
    request.addEventListener('load', () => {
      render(JSON.parse(request.responseText));
      pages += 1;
      if (pages === 1) {
        request.open('POST', retrievePath);
        request.setRequestHeader('content-type', 'application/json');
        request.send(JSON.stringify({ nextTableIndex: 2, moreTransactionsFlag: 'true', isRedesignPage: true }));
      } else {
        document.getElementById('citi-app').dataset.chained = 'true';
      }
    });
    request.open('POST', retrievePath);
    request.setRequestHeader('content-type', 'application/json');
    request.send(JSON.stringify(firstPage));
  });
} else {
  xhr('GET', '/gcg-fake/v1/dashboard/tiles').then(() => xhr('POST', retrievePath, firstPage)).then(render);
}
document.getElementById('load-more').addEventListener('click', () => xhr('POST', '/gcg-fake/v1/accounts/${CITI_ACCOUNT_ID}/transactions/retrieve', { nextTableIndex: 2, moreTransactionsFlag: 'true', isRedesignPage: true }).then(render));
document.getElementById('show-cached').addEventListener('click', () => { document.getElementById('cached').hidden = false; });
document.getElementById('to-other').addEventListener('click', () => { history.pushState({}, '', '/accounts/other'); document.getElementById('rows').replaceChildren(); document.getElementById('cached').hidden = false; });
document.getElementById('to-main').addEventListener('click', () => { history.pushState({}, '', '/accounts'); document.getElementById('cached').hidden = false; });
document.getElementById('switch-and-load').addEventListener('click', () => {
  history.pushState({}, '', '/accounts/other');
  document.getElementById('rows').replaceChildren();
  xhr('POST', '/gcg-fake/v1/accounts/${CITI_ACCOUNT_ID}/transactions/retrieve', { nextTableIndex: 2, moreTransactionsFlag: 'true', isRedesignPage: true }).then(render);
});
// One XHR object for two requests to the same endpoint: the first (page 2) is aborted, the second asks for page 1.
document.getElementById('sign-out-in-place').addEventListener('click', () => { document.getElementById('citi-app').dataset.ready = 'false'; const form = document.createElement('form'); form.id = 'login'; document.body.append(form); });
document.getElementById('sign-in-in-place').addEventListener('click', () => { document.getElementById('login')?.remove(); document.getElementById('citi-app').dataset.ready = 'true'; });
// A new sign-in that loads its activity at once, before anything else looks at the page.
document.getElementById('sign-in-and-load').addEventListener('click', () => {
  document.getElementById('login')?.remove();
  document.getElementById('citi-app').dataset.ready = 'true';
  xhr('POST', retrievePath, { nextTableIndex: 2, moreTransactionsFlag: 'true', isRedesignPage: true }).then(render);
});
// The page loads further pages (3, 4, …) on its own, as one may while it still shows its sign-in view after a new sign-in.
const loadPages = (count) => {
  for (let index = 3; index < 3 + count; index += 1) xhr('POST', retrievePath, { nextTableIndex: index, moreTransactionsFlag: 'true', isRedesignPage: true }).then(render);
};
document.getElementById('load-3-pages').addEventListener('click', () => loadPages(3));
document.getElementById('load-9-pages').addEventListener('click', () => loadPages(9));
document.getElementById('reuse-xhr').addEventListener('click', () => {
  const request = new XMLHttpRequest();
  request.open('POST', '/gcg-fake/v1/accounts/${CITI_ACCOUNT_ID}/transactions/retrieve');
  request.setRequestHeader('content-type', 'application/json');
  request.send(JSON.stringify({ nextTableIndex: 2, moreTransactionsFlag: 'true', isRedesignPage: true }));
  request.abort();
  request.open('POST', '/gcg-fake/v1/accounts/${CITI_ACCOUNT_ID}/transactions/retrieve');
  request.setRequestHeader('content-type', 'application/json');
  request.addEventListener('load', () => { document.getElementById('citi-app').dataset.reused = 'true'; });
  request.send(JSON.stringify({ nextTableIndex: null, moreTransactionsFlag: null, isRedesignPage: true }));
});
</script>`,
      );
    }
    if (req.method === 'GET' && url.pathname === '/gcg-fake/v1/dashboard/tiles') {
      return json(res, { creditCardAccounts: [{ accountId: CITI_ACCOUNT_ID, displayNumber: '-8812', name: 'Double Cash Example', status: 'ACTIVE' }] });
    }
    if (req.method === 'POST' && url.pathname === `/gcg-fake/v1/accounts/${CITI_OTHER_ACCOUNT_ID}/transactions/retrieve`) {
      req.resume();
      req.on('end', () => {
        json(res, {
          pendingTransactions: [],
          postedTransactions: [{ transactionId: 'CT-9001', purchaseDate: us(-2), postedDate: us(-1), description: 'SYNTHETIC OTHER ACCOUNT', amount: '99.00', transactionType: 'PURCHASE', cardMemberName: CITI_NAMES[0] }],
          moreTransactionsFlag: 'false',
          nextTableIndex: null,
        });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === `/gcg-fake/v1/accounts/${CITI_ACCOUNT_ID}/transactions/retrieve`) {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        if (controls.citiRedirect) {
          return void res.writeHead(307, { location: `/gcg-fake/v1/accounts/${CITI_OTHER_ACCOUNT_ID}/transactions/retrieve` }).end();
        }
        let index: unknown = null;
        try {
          index = JSON.parse(body).nextTableIndex;
        } catch {
          index = null;
        }
        // Pages 3 to 20: one distinct purchase each, with more to come.
        const extra = typeof index === 'number' && Number.isInteger(index) && index >= 3 && index <= 20 ? index : null;
        const answer = index === 2
          ? {
            pendingTransactions: [],
            postedTransactions: [{ transactionId: 'CT-1004', purchaseDate: us(-15), postedDate: us(-14), description: 'SYNTHETIC FUEL', amount: '45.67', transactionType: 'PURCHASE', cardMemberName: CITI_NAMES[1] }],
            moreTransactionsFlag: 'false',
            nextTableIndex: null,
          }
          : extra !== null
            ? {
              pendingTransactions: [],
              postedTransactions: [{ transactionId: `CT-11${String(extra).padStart(2, '0')}`, purchaseDate: us(-20 - extra), postedDate: us(-19 - extra), description: 'SYNTHETIC BOOKSHOP', amount: '12.34', transactionType: 'PURCHASE', cardMemberName: CITI_NAMES[0] }],
              moreTransactionsFlag: 'true',
              nextTableIndex: extra + 1,
            }
            : {
              pendingTransactions: [{ transactionId: 'CT-P-1001', purchaseDate: us(-1), postedDate: null, description: 'SYNTHETIC PHARMACY', amount: '23.10', transactionType: 'PURCHASE', cardMemberName: CITI_NAMES[0] }],
              postedTransactions: [
                { transactionId: 'CT-1001', purchaseDate: us(-6), postedDate: us(-5), description: 'SYNTHETIC AIRLINE', amount: '320.00', transactionType: 'PURCHASE', cardMemberName: CITI_NAMES[0] },
                { transactionId: 'CT-1002', purchaseDate: us(-6), postedDate: us(-5), description: 'SYNTHETIC HOTEL', amount: '210.40', transactionType: 'PURCHASE', cardMemberName: CITI_NAMES[1] },
                { transactionId: 'CT-1003', purchaseDate: us(-4), postedDate: us(-3), description: 'PAYMENT THANK YOU', amount: '-500.00', transactionType: 'PAYMENT', cardMemberName: CITI_NAMES[0] },
              ],
              moreTransactionsFlag: 'true',
              nextTableIndex: 2,
            };
        setTimeout(() => json(res, answer), controls.citiDelayMs);
      });
      return;
    }
    res.writeHead(404).end();
  };
}

// ---------------------------------------------------------------------------
// Wells Fargo (rendered DOM only, virtual list)
// ---------------------------------------------------------------------------

function wf(controls: IssuerControls, log: (req: http.IncomingMessage) => void): http.RequestListener {
  return (req, res) => {
    log(req);
    const url = new URL(req.url ?? '/', 'http://wf.e3.test');
    if (url.pathname === '/favicon.ico') return void res.writeHead(404).end();
    if (url.pathname !== '/activity') return html(res, '<h1>Fake WF home</h1>');
    if (!controls.signedIn) return html(res, LOGIN);
    const rows = [
      { section: 'pending', date: us(-1), description: 'SYNTHETIC CAFE', debit: '6.50', credit: '' },
      { section: 'pending', date: us(-1), description: 'SYNTHETIC PARKING', debit: '3.00', credit: '' },
      { section: 'posted', date: us(-3), description: 'SYNTHETIC GROCER', debit: '54.21', credit: '' },
      { section: 'posted', date: us(-4), description: 'SYNTHETIC GROCER', debit: '54.21', credit: '' },
      { section: 'posted', date: us(-5), description: 'ONLINE PAYMENT THANK YOU', debit: '', credit: '1,200.00' },
      { section: 'posted', date: us(-6), description: 'SYNTHETIC BAD ROW', debit: '1.00', credit: '1.00' },
      { section: 'posted', date: us(-7), description: 'SYNTHETIC CINEMA', debit: '24.00', credit: '' },
      { section: 'posted', date: us(-8), description: 'SYNTHETIC REFUND', debit: '', credit: '15.00' },
      { section: 'posted', date: us(-9), description: 'SYNTHETIC BAKERY', debit: '7.25', credit: '' },
      { section: 'posted', date: us(-10), description: 'SYNTHETIC BIKE SHOP', debit: '88.00', credit: '' },
    ];
    return html(
      res,
      `<h1>Fake Wells Fargo</h1>
<select id="account-select"><option>VISA SIGNATURE ...4417</option></select>
<div id="activity" role="grid" data-product-type="credit" data-account-key="${WF_ACCOUNT_KEY}" data-account-mask="...4417" data-product="Active Cash Example" aria-rowcount="${rows.length}">
  <div role="row"><span role="columnheader">Date</span><span role="columnheader">Description</span><span role="columnheader">Debit</span><span role="columnheader">Credit</span></div>
  <div role="rowgroup" data-section="pending"></div>
  <div role="rowgroup" data-section="posted"></div>
</div>
<button id="scroll-down">Scroll down</button>
<button id="load-more">Load more</button>
<table id="deposit-activity"><tr><th>Date</th><th>Description</th><th>Withdrawals</th><th>Deposits</th><th>Balance</th></tr><tr><td>${us(-2)}</td><td>DEPOSIT ACCOUNT ROW</td><td>10.00</td><td></td><td>990.00</td></tr></table>
<script>
const rows = ${JSON.stringify(rows)};
const render = (from, to) => {
  for (const group of document.querySelectorAll('[role="rowgroup"]')) group.replaceChildren();
  rows.forEach((row, i) => {
    if (i < from || i >= to) return;
    const el = document.createElement('div'); el.setAttribute('role', 'row'); el.setAttribute('aria-rowindex', String(i + 1));
    for (const [col, text] of [['date', row.date], ['description', row.description], ['debit', row.debit], ['credit', row.credit]]) { const cell = document.createElement('span'); cell.setAttribute('role', 'gridcell'); cell.dataset.col = col; cell.textContent = text; el.append(cell); }
    document.querySelector('[role="rowgroup"][data-section="' + row.section + '"]').append(el);
  });
};
render(0, 6);
document.getElementById('scroll-down').addEventListener('click', () => { render(4, 10); document.getElementById('load-more').hidden = true; });
</script>`,
    );
  };
}

// ---------------------------------------------------------------------------

export class FakeIssuers {
  readonly controls: IssuerControls = { signedIn: true, chaseVariant: 'normal', chasePosted: false, amexUnknownType: false, amexRoutingMap: false, citiRedirect: false, citiDelayMs: 0 };
  readonly requests: IssuerRequest[] = [];
  private servers: http.Server[] = [];
  readonly ports = new Map<string, number>();

  static async start(): Promise<FakeIssuers> {
    const issuers = new FakeIssuers();
    const log = (host: string) => (req: http.IncomingMessage) => {
      const path = (req.url ?? '').split('?')[0];
      // The page's own API calls carry a marker; an unmarked call to an API path can only be the extension's bankRead.
      const fromPage = !(path.startsWith('/fake-api/') && req.headers['x-fake-page'] !== '1');
      issuers.requests.push({ at: Date.now(), host, method: req.method ?? '?', path, fromPage });
    };
    const sites: Array<[string, http.RequestListener]> = [
      ['chase.e3.test', chase(issuers.controls, log('chase.e3.test'))],
      ['amex.e3.test', amexPage(issuers.controls, log('amex.e3.test'))],
      ['functions.amex.e3.test', amexFunctions(issuers.controls, log('functions.amex.e3.test'))],
      ['citi.e3.test', citi(issuers.controls, log('citi.e3.test'))],
      ['wf.e3.test', wf(issuers.controls, log('wf.e3.test'))],
    ];
    for (const [host, listener] of sites) {
      const server = http.createServer(listener);
      server.on('clientError', (_error, socket) => socket.destroy());
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      issuers.servers.push(server);
      issuers.ports.set(host, (server.address() as AddressInfo).port);
    }
    return issuers;
  }

  reset(): void {
    this.controls.signedIn = true;
    this.controls.chaseVariant = 'normal';
    this.controls.chasePosted = false;
    this.controls.amexUnknownType = false;
    this.controls.amexRoutingMap = false;
    this.controls.citiRedirect = false;
    this.controls.citiDelayMs = 0;
    this.requests.length = 0;
  }

  /** Requests the extension itself made to an issuer (not the page's own). */
  extensionReads(host: string): IssuerRequest[] {
    return this.requests.filter((request) => request.host === host && !request.fromPage);
  }

  async close(): Promise<void> {
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  }
}
