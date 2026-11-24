// Holdr Card Sync worker logic: relays the American Express panel and the popup to the local receiver over the encrypted
// channel. Kept free of chrome.* globals (they are passed in) so that it runs under Node in the tests.
import { createSecureClient } from './secure-channel.mjs';

export const AMEX_ORIGIN = 'https://global.americanexpress.com';
export const PAIRING_FILE = 'local-key.json';
const ROUTES = Object.freeze({
  ping: ['GET', '/sync/ping', []],
  config: ['GET', '/sync/config', []],
  status: ['GET', '/sync/status', []],
  claim: ['POST', '/sync/claim', ['lease']],
  release: ['POST', '/sync/release', ['lease']],
  stop: ['POST', '/sync/stop', []],
  cards: ['POST', '/sync/amex/cards', ['lease', 'cards']],
  plan: ['POST', '/sync/amex/plan', ['lease', 'card', 'periods']],
  statement: ['POST', '/sync/amex/statement', ['lease', 'card', 'period', 'csv']],
  discard: ['POST', '/sync/amex/discard', ['lease', 'card']],
  finish: ['POST', '/sync/amex/finish', ['lease', 'card']],
});
const PAGE_OPS = new Set(['ping', 'config', 'claim', 'release', 'stop', 'cards', 'plan', 'statement', 'discard', 'finish', 'open-holdr']);
const POPUP_OPS = new Set(['ping', 'status', 'open-holdr']);
const SPENDING_ROUTE = '/everyday/transactions';

export class WorkerError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
    this.status = status;
  }
}

export function createWorker({ chromeApi, fetchImpl = (...args) => fetch(...args) }) {
  let pairing = null;
  let client = null;

  async function loadPairing() {
    if (pairing) return pairing;
    let value;
    try {
      const response = await fetchImpl(chromeApi.runtime.getURL(PAIRING_FILE), { cache: 'no-store' });
      if (!response.ok) throw new Error('missing');
      value = await response.json();
    } catch {
      throw new WorkerError('not-paired', 'Not paired with the Holdr receiver yet: run "npm run agent -- pair", then reload this extension');
    }
    if (!value || value.format !== 'holdr-card-sync-pairing' || value.version !== 1 || !/^[0-9a-f]{64}$/.test(value.pairingKey || '')
      || !Number.isInteger(value.receiverPort) || value.receiverPort < 1024 || value.receiverPort > 65535) {
      throw new WorkerError('not-paired', 'The pairing file is damaged: run "npm run agent -- pair --rotate", then reload this extension');
    }
    pairing = value;
    client = createSecureClient({ base: `http://127.0.0.1:${value.receiverPort}`, getToken: () => value.pairingKey, fetchImpl });
    return pairing;
  }

  async function rx(method, path, body) {
    await loadPairing();
    let response;
    try {
      response = await client.request(method, path, {
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      // Read the pairing file again next time: it may have been rotated.
      pairing = null;
      client = null;
      if (error && error.status === 403) {
        throw new WorkerError('extension-id-mismatch', `The receiver does not accept this extension (ID ${chromeApi.runtime.id}): `
          + `start it with HOLDR_EXTENSION_ID=${chromeApi.runtime.id}, or load the extension folder unchanged`);
      }
      if ((error && error.status === 401) || /authentication failed/i.test(String(error && error.message))) {
        throw new WorkerError('pairing-mismatch', 'The receiver has a different pairing key: restart the receiver, then reload this extension');
      }
      throw new WorkerError('receiver-unreachable', 'The Holdr receiver is not running on this computer: start it with "npm run agent"');
    }
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    if (!response.ok) {
      throw new WorkerError(typeof json?.error === 'string' ? json.error : 'receiver-error',
        typeof json?.message === 'string' ? json.message.slice(0, 300) : `The receiver answered ${response.status}`, response.status);
    }
    return json || {};
  }

  function senderKind(sender) {
    if (!sender || sender.id !== chromeApi.runtime.id) return null;
    if (sender.tab) {
      let origin;
      try { origin = new URL(sender.url).origin; } catch { return null; }
      return origin === AMEX_ORIGIN && sender.frameId === 0 ? 'amex' : null;
    }
    return sender.url === chromeApi.runtime.getURL('popup.html') ? 'popup' : null;
  }

  async function openHoldr() {
    const config = await rx('GET', '/sync/config');
    let url;
    try { url = new URL(config.webUrl); } catch { throw new WorkerError('invalid-web-url', 'The receiver has no valid Holdr web address (HOLDR_WEB_URL)'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.username || url.password) {
      throw new WorkerError('invalid-web-url', 'The receiver has no valid Holdr web address (HOLDR_WEB_URL)');
    }
    url.hash = SPENDING_ROUTE;
    await chromeApi.tabs.create({ url: url.href });
    return { opened: true };
  }

  async function handle(message, sender) {
    const kind = senderKind(sender);
    const allowed = kind === 'amex' ? PAGE_OPS : kind === 'popup' ? POPUP_OPS : null;
    if (!allowed || !message || typeof message.op !== 'string' || !allowed.has(message.op)) throw new WorkerError('refused', 'Request refused');
    if (message.op === 'open-holdr') return openHoldr();
    const [method, path, keys] = ROUTES[message.op];
    const body = method === 'POST' ? Object.fromEntries(keys.filter((key) => message[key] !== undefined).map((key) => [key, message[key]])) : undefined;
    const result = await rx(method, path, body);
    return message.op === 'status' ? { ...result, extensionId: chromeApi.runtime.id } : result;
  }

  /** A chrome.runtime.onMessage listener: answers `{ ok, result }` or `{ ok: false, code, error, status }`. */
  function onMessage(message, sender, sendResponse) {
    if (!message || message.type !== 'holdr-sync') return undefined;
    handle(message, sender).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({
        ok: false, code: (error && error.code) || 'error', error: String((error && error.message) || error).slice(0, 300), status: error && error.status,
      }),
    );
    return true;
  }

  return { handle, onMessage, loadPairing };
}
