// The end-to-end harness: a simulated American Express site, the extension's page helper, sync and panel in vm sandboxes,
// the real worker logic, and the real receiver on 127.0.0.1 with a fake Holdr API behind it. No browser, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { createWorker } from '../extension/worker-core.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { convertAmexStatements } from '../lib/convert.mjs';
import { createReceiverCore } from '../lib/core.mjs';
import { createHoldrApi } from '../lib/holdr-api.mjs';
import { ensurePairing, loadState, saveState } from '../lib/pairing.mjs';
import { makePrivateDir } from '../lib/private-fs.mjs';
import { createRawStore } from '../lib/raw-store.mjs';
import { createChannel, createReceiverServer } from '../lib/server.mjs';
import { amexCsv, EXTENSION_DIR, readFixture, tempDir, writeToken } from './helpers.mjs';

export const EXTENSION_ID = 'd'.repeat(32);
export const AMEX = 'https://global.americanexpress.com';
export const TODAY = new Date(2026, 8, 10, 12, 0, 0);
export const ACCOUNT = { id: 'card-1', issuer: 'amex', owner: 'alex', last5: '91005', last4: '1005', currency: 'USD', status: 'active', nickname: 'Sample Rewards' };
export const PERIODS = [
  { statement_start_date: '2026-05-15', statement_end_date: '2026-06-14' },
  { statement_start_date: '2026-06-15', statement_end_date: '2026-07-14' },
  { statement_start_date: '2026-07-15', statement_end_date: '2026-08-14' },
  { statement_start_date: '2026-08-15', statement_end_date: '2026-09-14' },
];
const CARDS = [
  { token: 'tok-main', key: 'key-main', last5: '91005', product: 'Sample Rewards Card\u00ae' },
  { token: 'tok-supp', key: 'key-main', last5: '91005', product: 'Sample Rewards Card', supplementary: true },
  { token: 'tok-new', key: 'key-new', last5: '42002', product: 'Sample Cash Card' },
  { token: 'tok-twin-a', key: 'key-twin-a', last5: '33003', product: 'Sample Twin Card' },
  { token: 'tok-twin-b', key: 'key-twin-b', last5: '33003', product: 'Sample Twin Card' },
];
export const EXPORTS = {
  'key-main': {
    '2026-06-14': '',
    '2026-07-14': amexCsv([['07/02/2026', 'SAMPLE HARDWARE', '42.00', '320261830000000401']]),
    '2026-08-14': readFixture('amex-statement-synthetic.csv'),
    '2026-09-14': amexCsv([['08/20/2026', 'SAMPLE BOOKSHOP', '25.00', '320262320000000201'], ['08/16/2026', 'SAMPLE COFFEE BAR', '4.50', '320262280000000202']]),
  },
  'key-new': {
    '2026-07-14': '',
    '2026-08-14': amexCsv([['08/01/2026', 'SAMPLE PHARMACY', '12.30', '320262130000000501']]),
    '2026-09-14': '',
  },
};

/**
 * The simulated, signed-in American Express page: its state, its two read endpoints, and a request log. `periods` and
 * `exports` (by account key, then closing date) may be changed between syncs.
 */
export function amexSite({ periods = PERIODS, exports = EXPORTS } = {}) {
  const requests = [];
  const initialState = JSON.stringify({
    cards: CARDS.map((card) => ({
      accountToken: card.token, accountKey: card.key, account: { display_account_number: card.last5 },
      product: { description: card.product }, status: { account_status: ['Active'] },
    })),
    supplementaryAccounts: CARDS.filter((card) => card.supplementary).map((card) => ({ accountToken: card.token, accountKey: card.key })),
  });
  const fetch = async (url, init = {}) => {
    const target = new URL(url, AMEX);
    const accountKey = target.searchParams.get('account_key');
    const end = target.searchParams.get('statement_end_date');
    requests.push({ path: target.pathname, method: init.method ?? 'GET', ...(accountKey ? { accountKey } : {}), ...(end ? { end } : {}) });
    if (target.pathname === '/api/servicing/v1/financials/statement_periods') {
      return new Response(JSON.stringify({ data: periods }), { headers: { 'content-type': 'application/json' } });
    }
    if (target.pathname === '/api/servicing/v1/financials/documents') {
      assert.equal(target.searchParams.get('status'), 'posted');
      const text = exports[accountKey]?.[end] ?? '';
      return new Response(text, { headers: { 'content-type': 'text/csv' } });
    }
    return new Response('not found', { status: 404 });
  };
  return { requests, initialState, fetch };
}

/** Just enough DOM for the panel: elements with children, a shadow root, classes and click listeners. */
class FakeElement {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parent = null;
    this.style = { cssText: '' };
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.disabled = false;
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    };
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  attachShadow() { const root = new FakeElement('#shadow-root', this.ownerDocument); root.parent = this; this.shadowRoot = root; return root; }
  get isConnected() { let node = this; while (node.parent) node = node.parent; return node === this.ownerDocument.body; }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  /** A click as a person makes it (isTrusted), which the panel requires. */
  click() { for (const listener of this.listeners.get('click') ?? []) listener({ type: 'click', isTrusted: true, preventDefault() {} }); }
  *walk() { yield this; for (const child of [...this.children, ...(this.shadowRoot ? [this.shadowRoot] : [])]) yield* child.walk(); }
}

function fakeDocument() {
  const document = new EventTarget();
  document.body = new FakeElement('body', document);
  document.documentElement = document.body;
  document.createElement = (tag) => new FakeElement(tag, document);
  document.getElementById = () => null;
  document.querySelector = () => null;
  return document;
}

/** chrome.* for the content scripts: messages go to the worker as from the Amex tab, storage is in memory. */
function fakeChrome(worker) {
  const store = {};
  const listeners = [];
  const sender = { id: EXTENSION_ID, tab: { id: 7 }, frameId: 0, url: `${AMEX}/dashboard` };
  return {
    store,
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      sendMessage: (message, callback) => { worker.onMessage(message, sender, callback); },
    },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries([].concat(keys).filter((key) => key in store).map((key) => [key, store[key]])),
        set: async (values) => {
          const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: store[key], newValue: value }]));
          Object.assign(store, values);
          for (const listener of listeners) listener(changes, 'local');
        },
      },
      onChanged: { addListener: (listener) => listeners.push(listener), removeListener: () => {} },
    },
  };
}

/**
 * One simulated tab: the page helper in the main world, and in the isolated world the sync (and, given a worker, the
 * panel). Returns the panel's rpc bridge, HoldrAmexSync, and with a panel its DOM and chrome storage.
 */
export function loadTab(site, { worker = null } = {}) {
  const document = fakeDocument();
  const timers = { setTimeout: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; }, clearTimeout };
  const shared = { document, crypto: globalThis.crypto, TextEncoder, URLSearchParams, CustomEvent, AbortController, Response, console };
  const source = (name) => fs.readFileSync(path.join(EXTENSION_DIR, name), 'utf8');
  vm.runInNewContext(source('amex-page.js'), { ...shared, window: { __INITIAL_STATE__: site.initialState }, fetch: site.fetch, setTimeout: (callback) => setImmediate(callback) },
    { filename: 'amex-page.js' });
  const chrome = worker ? fakeChrome(worker) : null;
  const isolatedWindow = {};
  isolatedWindow.top = isolatedWindow;
  const isolated = vm.createContext({
    ...shared, ...timers, window: isolatedWindow, chrome, location: { host: 'global.americanexpress.com', pathname: '/dashboard' },
    setInterval: () => 0, clearInterval: () => {},
  });
  vm.runInContext(source('amex-sync.js'), isolated, { filename: 'amex-sync.js' });
  if (worker) vm.runInContext(source('amex-panel.js'), isolated, { filename: 'amex-panel.js' });
  let next = 0;
  // The same bridge as amex-panel.js: DOM events with JSON details.
  const rpc = (fn, ...args) => new Promise((resolve, reject) => {
    const id = `call-${(next += 1)}`;
    const onResult = (event) => {
      const message = JSON.parse(event.detail);
      if (message.id !== id) return;
      document.removeEventListener('holdr-sync:result', onResult);
      if (message.ok) resolve(message.value); else reject(new Error(message.error));
    };
    document.addEventListener('holdr-sync:result', onResult);
    document.dispatchEvent(new CustomEvent('holdr-sync:call', { detail: JSON.stringify({ id, fn, args }) }));
  });
  return { rpc, sync: isolated.HoldrAmexSync, document, chrome, panel: isolatedWindow.__holdrAmexPanel };
}

/**
 * The real receiver on an ephemeral loopback port. `clock.now` is its time (it may be moved between syncs); its state,
 * with the record of when each statement was read, is kept in its imports folder as the receiver keeps it.
 */
export async function startReceiver(t, { holdr, history = 2, clock = { now: TODAY }, webUrl = 'http://127.0.0.1:5173' }) {
  const root = tempDir(t);
  const extensionDir = path.join(root, 'extension');
  fs.mkdirSync(extensionDir);
  const config = resolveConfig({
    env: {},
    argv: ['--imports', path.join(root, 'imports'), '--extension-dir', extensionDir, '--app-url', holdr.url,
      '--token-file', writeToken(path.join(root, 'holdr-data')), '--extension-id', EXTENSION_ID, '--history', String(history),
      '--web-url', webUrl],
  });
  for (const dir of [config.importsDir, config.rawDir, config.outboxDir]) makePrivateDir(dir);
  const events = [];
  const { pairing } = ensurePairing(config.pairingFile, { port: 4401 });
  const state = loadState(config.statePath);
  // The fake Holdr runs in this process: its listener is ours (the real lookup is tested in holdr-api and cli tests).
  const api = createHoldrApi({ appUrl: config.appUrl, tokenFile: config.tokenFile, ownerOf: async () => ({ owner: 'you' }) });
  t.after(() => api.close());
  const core = createReceiverCore({
    config, salt: state.identitySalt, api,
    rawStore: createRawStore(config.rawDir), convert: convertAmexStatements, log: (event) => events.push(event), now: () => clock.now,
    reads: state.reads, saveReads: () => saveState(config.statePath, state),
  });
  const receiver = createReceiverServer({ port: 0, extensionId: EXTENSION_ID, channel: createChannel({ key: pairing.pairingKey, dispatch: core.dispatch }) });
  const { port } = await receiver.listen();
  t.after(() => receiver.close());
  ensurePairing(config.pairingFile, { port });
  return { config, events, receiver, port, clock };
}

/** The extension's worker as Chrome runs it: its own files by chrome-extension:// URL, and its Origin on every request. */
export function startWorker({ extensionDir, origin = `chrome-extension://${EXTENSION_ID}` }) {
  const opened = [];
  const chromeApi = {
    runtime: { id: EXTENSION_ID, getURL: (name) => `chrome-extension://${EXTENSION_ID}/${name}` },
    tabs: { create: async ({ url }) => { opened.push(url); } },
  };
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith(`chrome-extension://${EXTENSION_ID}/`)) {
      const file = path.join(extensionDir, href.slice(`chrome-extension://${EXTENSION_ID}/`.length));
      return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response('', { status: 404 });
    }
    return fetch(url, { ...init, headers: { ...init.headers, Origin: origin } });
  };
  const worker = createWorker({ chromeApi, fetchImpl });
  const amexTab = { id: EXTENSION_ID, tab: { id: 7 }, frameId: 0, url: `${AMEX}/dashboard` };
  const popup = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup.html` };
  return {
    opened,
    worker,
    sw: (op, data) => worker.handle({ type: 'holdr-sync', op, ...data }, amexTab),
    popup: (op) => worker.handle({ type: 'holdr-sync', op }, popup),
    from: (sender, op, data) => worker.handle({ type: 'holdr-sync', op, ...data }, sender),
  };
}
