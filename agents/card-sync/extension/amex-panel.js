// Holdr Card Sync: the panel on global.americanexpress.com (isolated world, top frame). OFF by default: opening the page
// never starts a sync, and nothing is read until you switch ON and click Sync. Switching OFF stops a running sync at once.
// The sync itself is in amex-sync.js; the page helper (amex-page.js) does the reading.
(() => {
  'use strict';
  if (window.top !== window || (window.__holdrAmexPanel && window.__holdrAmexPanel.live())) return;
  if (window.__holdrAmexPanel) window.__holdrAmexPanel.dispose();
  const sync = globalThis.HoldrAmexSync;
  if (!sync) return;
  const installedRuntime = chrome.runtime;
  const waiting = new Map();
  let on = false;
  let running = false;
  let cancelRequested = false;

  // ---- the extension worker (and through it the local receiver) ----
  function sw(op, data) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'holdr-sync', op, ...(data || {}) }, (response) => {
          const failure = chrome.runtime.lastError;
          if (failure) { reject(Object.assign(new Error('The extension did not answer: reload this page'), { code: 'extension-unavailable' })); return; }
          if (!response) { reject(Object.assign(new Error('The extension did not answer: reload this page'), { code: 'extension-unavailable' })); return; }
          if (response.ok) resolve(response.result || {});
          else reject(Object.assign(new Error(response.error || 'failed'), { code: response.code, status: response.status }));
        });
      } catch (error) {
        reject(Object.assign(new Error('The extension was updated: reload this page'), { code: 'extension-unavailable' }));
      }
    });
  }

  // ---- the page helper (main world) over DOM events ----
  const onPageResult = (event) => {
    let message;
    try { message = JSON.parse(event.detail); } catch (_) { return; }
    const entry = message && waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.value); else entry.reject(new Error(message.error || 'the page helper failed'));
  };
  document.addEventListener('holdr-sync:result', onPageResult);
  function rpc(fn, ...args) {
    const id = `holdr-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${fn} timed out`)); }, 180000);
      waiting.set(id, { resolve, reject, timer });
      document.dispatchEvent(new CustomEvent('holdr-sync:call', { detail: JSON.stringify({ id, fn, args }) }));
    });
  }

  const loggedInPage = () => location.host === 'global.americanexpress.com' && !/login|logout/i.test(location.pathname);
  const checkpoint = () => {
    if (cancelRequested || !on) throw new sync.Stop(sync.STOP_TEXT.off);
  };

  // ---- the panel (DOM APIs only: the page enforces Trusted Types) ----
  const ui = (() => {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .card{font:13px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif;color:#e9eaf0;background:#16181f;border:1px solid #2c3040;
        border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.35);width:300px;padding:10px 12px}
      .row{display:flex;align-items:center;gap:8px}
      .brand{font-weight:700}
      .dot{width:8px;height:8px;border-radius:50%;background:#6b6f80;display:inline-block}
      .dot.ok{background:#3ccf7a}.dot.bad{background:#ff6b6b}
      .grow{flex:1}
      button{font:inherit;color:#e9eaf0;background:#262a37;border:1px solid #3a4052;border-radius:8px;padding:5px 10px;cursor:pointer}
      button:hover{background:#30364a}
      button.primary{background:#5b5bd6;border-color:#6d6de0}
      button:disabled{opacity:.55;cursor:default}
      .toggle{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
      .sw{width:34px;height:18px;border-radius:9px;background:#3a3f50;position:relative}
      .sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff}
      .sw.on{background:#3ccf7a}.sw.on::after{left:18px}
      .muted{color:#a2a6b5;font-size:12px;margin-top:6px;min-height:16px}
      .progress{color:#c9cbf7;font-size:12px;min-height:16px;margin-top:6px}
      ul{margin:6px 0 0;padding-left:16px;max-height:180px;overflow:auto;font-size:12px;color:#c4c7d4}
      .pill{font:12px -apple-system,"Segoe UI",sans-serif;color:#e9eaf0;background:#16181f;border:1px solid #2c3040;border-radius:16px;
        padding:6px 10px;cursor:pointer;display:flex;align-items:center;gap:6px}
      .x{background:none;border:none;color:#a2a6b5;padding:2px 4px}
    `;
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const card = el('div', 'card');
    const top = el('div', 'row');
    const dot = el('span', 'dot');
    const toggle = el('label', 'toggle');
    const knob = el('span', 'sw');
    const toggleText = el('span', null, 'OFF');
    toggle.append(knob, toggleText);
    const hide = el('button', 'x', '–');
    hide.title = 'Minimize';
    top.append(dot, el('span', 'brand', 'Holdr'), el('span', 'grow'), toggle, hide);
    const actions = el('div', 'row');
    actions.style.marginTop = '8px';
    const syncButton = el('button', 'primary', 'Sync');
    const openButton = el('button', null, 'Open Holdr');
    actions.append(syncButton, openButton);
    const progress = el('div', 'progress');
    const status = el('div', 'muted', 'OFF: nothing is read until you switch ON and click Sync');
    const list = el('ul');
    card.append(top, actions, progress, status, list);
    const pill = el('div', 'pill');
    const pillDot = el('span', 'dot');
    pill.append(pillDot, el('span', null, 'Holdr'));
    pill.style.display = 'none';
    root.append(style, card, pill);
    const mount = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
    const mountTimer = setInterval(mount, 3000);
    const setCollapsed = (collapsed) => {
      card.style.display = collapsed ? 'none' : '';
      pill.style.display = collapsed ? 'flex' : 'none';
      chrome.storage.local.set({ holdrCollapsed: collapsed }).catch(() => {});
    };
    hide.addEventListener('click', () => setCollapsed(true));
    pill.addEventListener('click', () => setCollapsed(false));
    let onToggle = () => {};
    let onSync = () => {};
    toggle.addEventListener('click', (event) => { event.preventDefault(); if (event.isTrusted) onToggle(); });
    syncButton.addEventListener('click', (event) => { if (event.isTrusted) onSync(); });
    openButton.addEventListener('click', () => {
      sw('open-holdr').catch((error) => { status.textContent = error.message.slice(0, 200); });
    });
    return {
      dispose() { clearInterval(mountTimer); host.remove(); },
      handlers(toggleHandler, syncHandler) { onToggle = toggleHandler; onSync = syncHandler; },
      setOn(value) { knob.classList.toggle('on', value); toggleText.textContent = value ? 'ON' : 'OFF'; },
      connected(value) { for (const d of [dot, pillDot]) { d.classList.toggle('ok', value === true); d.classList.toggle('bad', value === false); } },
      busy(value) { syncButton.disabled = value; syncButton.textContent = value ? 'Syncing…' : 'Sync'; },
      progress(text) { progress.textContent = text || ''; },
      status(text) { status.textContent = text || ''; },
      clearLines() { list.replaceChildren(); },
      addLine(text) { list.append(el('li', null, text)); },
      setCollapsed,
    };
  })();

  const NOT_CONNECTED = new Set(['receiver-unreachable', 'not-paired', 'pairing-mismatch', 'extension-id-mismatch', 'extension-unavailable']);

  async function runSync() {
    if (running) return;
    if (!on) { ui.status('Switch ON first: nothing is read while Holdr is OFF'); return; }
    if (!loggedInPage()) { ui.status('Sign in to American Express first, then Sync'); return; }
    running = true;
    cancelRequested = false;
    ui.busy(true);
    ui.clearLines();
    ui.status('');
    try {
      const outcome = await sync.runSync({ sw, rpc, checkpoint, ui: { progress: ui.progress, cardDone: ui.addLine } });
      ui.connected(true);
      ui.status(outcome.summary);
      await chrome.storage.local.set({ holdrLastSummary: outcome.summary, holdrLastSync: Date.now() });
    } catch (error) {
      if (error instanceof sync.Stop) {
        ui.status(error.message);
      } else {
        ui.status(String(error.message || error).slice(0, 240));
        if (NOT_CONNECTED.has(error.code)) ui.connected(false);
      }
    } finally {
      running = false;
      cancelRequested = false;
      ui.busy(false);
      ui.progress('');
    }
  }

  function applyOn(value) {
    on = value;
    ui.setOn(value);
    if (!value) {
      if (running) cancelRequested = true;
      rpc('stop').catch(() => {});
      ui.status('OFF: nothing is read until you switch ON and click Sync');
    } else if (!running) {
      ui.status('ON: click Sync to save new statements for Holdr');
    }
  }
  async function setOn(value) {
    applyOn(value);
    await chrome.storage.local.set({ holdrOn: value });
    if (!value) sw('stop').catch(() => {});
  }
  const onStorageChanged = (changes, area) => {
    if (area === 'local' && changes.holdrOn) applyOn(changes.holdrOn.newValue === true);
  };
  chrome.storage.onChanged.addListener(onStorageChanged);
  ui.handlers(() => { setOn(!on).catch(() => {}); }, () => { runSync(); });

  window.__holdrAmexPanel = {
    live() { try { return Boolean(installedRuntime.id); } catch (_) { return false; } },
    dispose() {
      cancelRequested = true;
      on = false;
      document.removeEventListener('holdr-sync:result', onPageResult);
      try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (_) { /* the extension is gone */ }
      for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(new Error('Panel replaced')); }
      waiting.clear();
      ui.dispose();
    },
  };

  (async () => {
    const stored = await chrome.storage.local.get(['holdrOn', 'holdrLastSummary', 'holdrLastSync', 'holdrCollapsed']);
    on = stored.holdrOn === true;
    ui.setOn(on);
    if (stored.holdrCollapsed) ui.setCollapsed(true);
    if (stored.holdrLastSummary) ui.status(`${stored.holdrLastSummary} (last sync ${new Date(stored.holdrLastSync).toLocaleString()})`);
    else if (on) ui.status('ON: click Sync to save new statements for Holdr');
    try {
      await sw('ping');
      ui.connected(true);
    } catch (error) {
      ui.connected(false);
      if (!stored.holdrLastSummary) ui.status(String(error.message || error).slice(0, 240));
    }
  })().catch(() => ui.connected(false));
})();
