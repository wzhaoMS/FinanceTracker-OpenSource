// Holdr Card Sync: the American Express page helper, installed in the signed-in global.americanexpress.com page (main
// world). Read-only: it reads the card list the page already holds, and GETs the statement dates and Amex's own statement
// CSV exports (what Amex's Download button produces), at least 1.2 s apart. It stops at the first 401, 403 or 429, or a
// login page. Account tokens and keys stay in this page: callers get card endings, product names, statement dates, a
// salted digest that tells cards apart, and the CSV text.
(() => {
  'use strict';
  const VERSION = 'card-sync-1';
  // Calls from the extension's panel (isolated world) arrive as DOM events with JSON details.
  if (!window.__holdrSyncRpc) {
    window.__holdrSyncRpc = true;
    document.addEventListener('holdr-sync:call', async (event) => {
      let request;
      try { request = JSON.parse(event.detail); } catch (_) { return; }
      if (!request || typeof request.id !== 'string' || !['loadAccounts', 'periods', 'csv', 'stop'].includes(request.fn)) return;
      let message;
      try {
        const value = await window.__holdrSync[request.fn](...(Array.isArray(request.args) ? request.args : []));
        message = { id: request.id, ok: true, value };
      } catch (error) {
        message = { id: request.id, ok: false, error: String((error && error.message) || error).slice(0, 200) };
      }
      document.dispatchEvent(new CustomEvent('holdr-sync:result', { detail: JSON.stringify(message) }));
    });
  }
  if (window.__holdrSync && window.__holdrSync.version === VERSION) return 'already installed';
  const previousStop = window.__holdrSync && (window.__holdrSync.authFailure || window.__holdrSync.stopped);
  let authFailure = previousStop && ['session-expired', 'forbidden'].includes(previousStop.reason)
    ? { reason: previousStop.reason, status: previousStop.status } : null;

  // ---- Transit JSON reader (transit-js semantics, including transit-immutable-js tags) ----
  const BASE = 48;
  const DIGITS = 44;
  const MAX = DIGITS * DIGITS;
  function Tag(tag) { this.tag = tag; }
  function keyString(k) {
    if (typeof k === 'string') return k;
    if (typeof k === 'number' || typeof k === 'boolean' || k === null) return String(k);
    try { return JSON.stringify(k); } catch (_) { return String(k); }
  }
  function transitRead(root) {
    const cache = new Array(MAX);
    let idx = 0;
    const write = (v) => { if (idx === MAX) idx = 0; cache[idx++] = v; return v; };
    const codeToIdx = (c) => (c.length === 2
      ? c.charCodeAt(1) - BASE
      : (c.charCodeAt(1) - BASE) * DIGITS + (c.charCodeAt(2) - BASE));
    const cacheable = (s, asKey) => s.length > 3 && (asKey || (s[0] === '~' && (s[1] === ':' || s[1] === '$' || s[1] === '#')));
    const isCode = (s) => s[0] === '^' && s[1] !== ' ';
    function parseString(s) {
      if (s[0] !== '~') return s;
      const c = s[1];
      if (c === '~' || c === '^' || c === '`') return s.slice(1);
      if (c === '#') return new Tag(s.slice(2));
      const rest = s.slice(2);
      switch (c) {
        case 'i': case 'n': { const n = Number(rest); return Number.isSafeInteger(n) ? n : rest; }
        case 'd': case 'f': case 'm': { const n = Number(rest); return Number.isFinite(n) ? n : rest; }
        case '_': return null;
        case '?': return rest === 't';
        default: return rest;
      }
    }
    function decodeString(s, asKey) {
      if (cacheable(s, asKey)) return write(parseString(s));
      if (isCode(s)) return cache[codeToIdx(s)];
      return parseString(s);
    }
    function tagged(tag, rep) {
      switch (tag) {
        case 'iM': case 'iOM': case 'cmap': {
          const o = {};
          if (Array.isArray(rep)) for (let i = 0; i + 1 < rep.length; i += 2) o[keyString(rep[i])] = rep[i + 1];
          return o;
        }
        case 'iL': case 'iS': case 'iOS': case 'iStk': case 'list': case 'set': return Array.isArray(rep) ? rep : [];
        case 'iR': return rep && typeof rep === 'object' && 'v' in rep ? rep.v : rep;
        default: return rep;
      }
    }
    const KNOWN = new Set(['iM', 'iOM', 'cmap', 'iL', 'iS', 'iOS', 'iStk', 'list', 'set', 'iR']);
    function decode(node, asKey, tagValue) {
      if (node === null || node === undefined) return null;
      if (typeof node === 'string') return decodeString(node, asKey);
      if (Array.isArray(node)) return node[0] === '^ ' ? decodeArrayHash(node) : decodeArray(node, asKey, tagValue);
      if (typeof node === 'object') return decodeHash(node);
      return node;
    }
    function decodeArrayHash(node) {
      const out = {};
      for (let i = 1; i < node.length; i += 2) {
        const k = decode(node[i], true, false);
        out[keyString(k)] = decode(node[i + 1], false, false);
      }
      return out;
    }
    function decodeArray(node, asKey, tagValue) {
      if (tagValue) return node.map((x) => decode(x, asKey, false));
      const saved = idx;
      if (node.length === 2 && typeof node[0] === 'string') {
        const t = decode(node[0], false, false);
        if (t instanceof Tag) return tagged(t.tag, decode(node[1], asKey, KNOWN.has(t.tag)));
      }
      idx = saved;
      return node.map((x) => decode(x, asKey, false));
    }
    function decodeHash(hash) {
      const ks = Object.keys(hash);
      if (ks.length === 1) {
        const t = decode(ks[0], false, false);
        if (t instanceof Tag) return tagged(t.tag, decode(hash[ks[0]], false, KNOWN.has(t.tag)));
      }
      const out = {};
      for (const k of ks) out[keyString(decode(k, true, false))] = decode(hash[k], false, false);
      return out;
    }
    return decode(root, false, false);
  }

  // ---- the card list the page already holds ----
  async function stateJson() {
    const v = window.__INITIAL_STATE__;
    if (typeof v === 'string' && v.length > 2) return { from: 'window', json: JSON.parse(v) };
    if (v && typeof v === 'object') return { from: 'window-object', json: v };
    const r = await fetch('/overview', { credentials: 'include', headers: { accept: 'text/html' } });
    const html = await r.text();
    const m = html.match(/__INITIAL_STATE__\s*=\s*("(?:[^"\\]|\\.)*")/);
    if (!m) return { from: 'overview-' + r.status, json: null };
    const literal = m[1].replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1');
    return { from: 'overview', json: JSON.parse(JSON.parse(literal)) };
  }

  function findAccounts(root) {
    const byToken = new Map();
    const seen = new Set();
    let visits = 0;
    const str = (x) => (typeof x === 'string' && x ? x : null);
    function note(o, supp) {
      const token = str(o.accountToken) || str(o.account_token);
      if (!token) return;
      const e = byToken.get(token) || { token, key: null, last5: null, product: null, status: null, supplementary: false };
      e.key = e.key || str(o.accountKey) || str(o.account_key);
      const acct = o.account && typeof o.account === 'object' ? o.account : null;
      const digits = (acct && str(acct.display_account_number)) || str(o.display_account_number) || str(o.displayAccountNumber);
      if (!e.last5 && digits && /^\d{4,5}$/.test(digits)) e.last5 = digits;
      const prod = o.product && typeof o.product === 'object' ? str(o.product.description) : null;
      if (!e.product && prod) e.product = prod.slice(0, 120);
      const st = o.status && typeof o.status === 'object' ? o.status : null;
      const stVal = st ? (Array.isArray(st.account_status) ? st.account_status.join('|') : str(st.account_status) || str(st.accountStatus)) : str(o.account_status);
      if (!e.status && stVal) e.status = stVal.slice(0, 60);
      if (supp) e.supplementary = true;
      byToken.set(token, e);
    }
    (function walk(v, supp, d) {
      if (!v || typeof v !== 'object' || d > 60 || ++visits > 600000 || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) { for (const x of v) walk(x, supp, d + 1); return; }
      note(v, supp);
      for (const k of Object.keys(v)) walk(v[k], supp || /supplementary/i.test(k), d + 1);
    })(root, false, 0);
    return Array.from(byToken.values());
  }

  // The hydrated page keeps its state in a Redux store: find the react-redux Provider through the React root.
  function reduxPlainState() {
    const toPlain = (x, d) => {
      if (!x || typeof x !== 'object' || d > 3) return x;
      if (typeof x.toJS === 'function') { try { return x.toJS(); } catch (_) { return null; } }
      if (Array.isArray(x)) return x.map((y) => toPlain(y, d + 1));
      const o = {};
      for (const k of Object.keys(x)) o[k] = toPlain(x[k], d + 1);
      return o;
    };
    const roots = [document.getElementById('root'), document.querySelector('[data-reactroot]'), ...Array.from(document.body ? document.body.children : [])];
    for (const el of roots) {
      if (!el) continue;
      const key = Object.keys(el).find((k) => k.startsWith('__reactContainer$') || k.startsWith('_reactRootContainer') || k.startsWith('__reactFiber$'));
      if (!key) continue;
      let fiber = el[key];
      if (key.startsWith('_reactRootContainer')) fiber = (fiber && fiber._internalRoot && fiber._internalRoot.current) || (fiber && fiber.current);
      const queue = [fiber];
      let n = 0;
      while (queue.length && n++ < 50000) {
        const f = queue.shift();
        if (!f) continue;
        const p = f.memoizedProps;
        if (p && p.store && typeof p.store.getState === 'function') return toPlain(p.store.getState(), 0);
        if (f.child) queue.push(f.child);
        if (f.sibling) queue.push(f.sibling);
      }
    }
    return null;
  }

  async function loadAccounts(salt) {
    if (typeof salt !== 'string' || !/^[0-9a-f]{64}$/.test(salt)) throw new Error('local identity salt required');
    if (authFailure) return { ok: false, stopped: { ...authFailure }, accounts: [] };
    S.stopped = null;
    let accounts = [];
    const tryRoot = (root) => {
      if (accounts.length || !root) return;
      try { const found = findAccounts(root); if (found.length) accounts = found; } catch (_) { /* try the next source */ }
    };
    const v = window.__INITIAL_STATE__;
    if (typeof v === 'string' && v.length > 2) {
      try { tryRoot(transitRead(JSON.parse(v))); } catch (_) { /* not transit JSON */ }
    }
    if (!accounts.length) tryRoot(reduxPlainState());
    if (!accounts.length && window.__APOLLO_CLIENT__ && window.__APOLLO_CLIENT__.cache) {
      try { tryRoot(window.__APOLLO_CLIENT__.cache.extract()); } catch (_) { /* no Apollo cache */ }
    }
    if (!accounts.length) {
      try { const st = await stateJson(); if (st.json) tryRoot(transitRead(st.json)); } catch (_) { /* no overview state */ }
    }
    // Keys stay in this page. A salted digest of the account key identifies a card across visits; a shared ending
    // (two accounts with the same last five digits) is never treated as one account.
    const keysByEnding = new Map();
    for (const a of accounts) {
      if (!a.last5 || !a.key) continue;
      const keys = keysByEnding.get(a.last5) || new Set();
      keys.add(a.key);
      keysByEnding.set(a.last5, keys);
    }
    const groups = new Map();
    for (const a of accounts) {
      if (!a.last5) continue;
      const keys = keysByEnding.get(a.last5);
      const key = a.key || (keys && keys.size === 1 ? [...keys][0] : null);
      const groupId = JSON.stringify([a.last5, key]);
      const g = groups.get(groupId) || { last5: a.last5, tokens: [], key, product: null, status: null, supplementary: true, conflict: !key, sharedEnding: (keys ? keys.size : 0) > 1 };
      if (!g.tokens.includes(a.token)) g.tokens.push(a.token);
      g.product = g.product || a.product;
      g.status = g.status || a.status;
      g.supplementary = g.supplementary && a.supplementary;
      groups.set(groupId, g);
    }
    for (const g of groups.values()) {
      if (!g.key) continue;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`holdr-amex-account-v1:${salt}:${g.key}`));
      g.sourceId = 'amex-' + [...new Uint8Array(digest)].map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
    }
    S.cards = Array.from(groups.values());
    return {
      ok: S.cards.length > 0,
      readerVersion: VERSION,
      accounts: S.cards.map((a) => ({
        last5: a.last5, product: a.product, status: a.status, supplementary: a.supplementary,
        conflict: a.conflict, sharedEnding: a.sharedEnding, sourceId: a.sourceId || null,
      })),
    };
  }

  // ---- statement periods ----
  function isoDay(v) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 1e11) return new Date(v).toISOString().slice(0, 10);
    if (typeof v !== 'string') return null;
    let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return null;
  }
  const END_KEYS = /^(statement_?end_?date|statementEndDate|end_?date|endDate|closing_?date|closingDate|statement_?closing_?date|statementClosingDate|statementDate|statement_date)$/i;
  const START_KEYS = /^(statement_?start_?date|statementStartDate|start_?date|startDate|opening_?date|openingDate|statement_?opening_?date|statementOpeningDate)$/i;
  function parsePeriods(root) {
    const found = new Map();
    const seen = new Set();
    (function walk(v, d) {
      if (!v || typeof v !== 'object' || d > 12 || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
      let end = null;
      let start = null;
      for (const [k, x] of Object.entries(v)) {
        if (!end && END_KEYS.test(k)) end = isoDay(x);
        if (!start && START_KEYS.test(k)) start = isoDay(x);
      }
      if (end && !found.has(end)) found.set(end, { start, end });
      for (const x of Object.values(v)) if (x && typeof x === 'object') walk(x, d + 1);
    })(root, 0);
    return Array.from(found.values()).sort((a, b) => (a.end < b.end ? 1 : -1));
  }

  // ---- paced requests; a 403 or 429, a login page, or a session-wide 401 stops the whole run ----
  const MIN_GAP_MS = 1200;
  let lastRequestAt = 0;
  let activeFetch = null;
  function recordStop(reason, status) {
    S.stopped = { reason, status };
    if (reason === 'session-expired' || reason === 'forbidden') authFailure = { reason, status };
  }
  function stop() {
    S.stopped = { reason: 'off' };
    if (activeFetch) activeFetch.abort();
    return { stopped: true };
  }
  async function amexFetch(url, init) {
    if (authFailure) return { stopped: { ...authFailure } };
    if (S.stopped) return { stopped: S.stopped };
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (authFailure) return { stopped: { ...authFailure } };
    if (S.stopped) return { stopped: S.stopped };
    lastRequestAt = Date.now();
    activeFetch = new AbortController();
    let r;
    try { r = await fetch(url, { ...init, signal: activeFetch.signal }); }
    catch (error) { if (S.stopped) return { stopped: S.stopped }; throw error; }
    const ct = r.headers.get('content-type') || '';
    let reason = null;
    if (r.status === 429) reason = 'rate-limited';
    else if (r.status === 403) reason = 'forbidden';
    else if (r.redirected && /login|logout/i.test(r.url)) reason = 'session-expired';
    else if (/text\/html/i.test(ct) && r.ok) reason = 'session-expired';
    if (reason) recordStop(reason, r.status);
    return { r, ct };
  }

  async function readAccount(sourceId, read) {
    const matches = typeof sourceId === 'string' && /^amex-[a-p]{64}$/.test(sourceId)
      ? S.cards.filter((a) => a.sourceId === sourceId) : [];
    if (matches.length !== 1) return { ok: false, conflict: true, sourceId: null, error: 'conflicting or missing card identity' };
    const account = matches[0];
    return { ...await read(account), sourceId: account.sourceId, last5: account.last5 };
  }
  const periods = (sourceId) => readAccount(sourceId, periodsFor);
  const csv = (sourceId, opts) => readAccount(sourceId, (account) => csvFor(account, opts || {}));

  async function periodsFor(a) {
    if (a.conflict) return { ok: false, conflict: true, statuses: [] };
    const statuses = [];
    for (const token of a.tokens) {
      const f = await amexFetch('/api/servicing/v1/financials/statement_periods', { credentials: 'include', headers: { account_token: token, accept: 'application/json' } });
      if (f.stopped) return { ok: false, stopped: f.stopped, statuses };
      statuses.push(f.r.status);
      if (f.r.ok && f.ct.includes('json')) {
        const today = new Date().toLocaleDateString('en-CA');
        const list = parsePeriods(await f.r.json());
        if (list.length) return { ok: true, statuses, periods: list.map((p) => ({ ...p, open: p.end >= today })) };
      }
    }
    if (statuses.length > 0 && statuses.every((s) => s === 401)) recordStop('session-expired', 401);
    return { ok: false, stopped: S.stopped || undefined, statuses };
  }

  // ---- a statement's CSV (Amex's own export, posted transactions); a quiet statement is a 200 with no bytes ----
  async function csvFor(a, opts) {
    if (a.conflict) return { status: 0, error: 'conflicting accounts share this ending' };
    if (typeof opts.end !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(opts.end)) return { status: 0, error: 'statement end date required' };
    const attempt = async (token) => {
      const q = new URLSearchParams({ file_format: 'csv', limit: 'all', status: 'posted', additional_fields: 'true', client_id: 'AmexAPI' });
      if (a.key) q.set('account_key', a.key);
      q.set('statement_end_date', opts.end);
      const headers = { accept: 'text/csv,application/octet-stream,*/*' };
      if (token) headers.account_token = token;
      const f = await amexFetch('/api/servicing/v1/financials/documents?' + q.toString(), { credentials: 'include', headers });
      if (f.stopped) return { status: f.stopped.status || 0, stopped: f.stopped };
      const text = await f.r.text();
      const head = text.slice(0, 400);
      const looksCsv = /(^|\n)\s*"?Date"?\s*,/.test(head) && /Amount/i.test(head);
      const empty = f.r.status === 200 && text.length === 0;
      return { status: f.r.status, looksCsv, empty, text: looksCsv ? text : null };
    };
    const candidates = a.key ? [null, ...a.tokens] : a.tokens;
    let res = null;
    const statuses = [];
    for (const token of candidates) {
      res = await attempt(token);
      statuses.push(res.status);
      if (res.looksCsv || res.empty || res.stopped) break;
      if (res.status === 401 && statuses.filter((s) => s === 401).length === candidates.length) {
        recordStop('session-expired', 401);
        res.stopped = S.stopped;
      }
    }
    res.statuses = statuses;
    return res;
  }

  const S = {
    version: VERSION, cards: [], stopped: authFailure,
    get authFailure() { return authFailure ? { ...authFailure } : null; },
    loadAccounts, periods, csv, stop,
    _transitRead: transitRead, _findAccounts: findAccounts, _parsePeriods: parsePeriods,
  };
  window.__holdrSync = S;
  return 'installed';
})();
