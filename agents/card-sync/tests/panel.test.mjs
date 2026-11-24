// The panel on the American Express page, driven the way a person uses it, on a minimal DOM: it reads nothing while OFF,
// syncs on a click once switched ON, and shows what was saved. Behind it run the real worker logic and receiver.
import assert from 'node:assert/strict';
import test from 'node:test';

import { listOutbox } from '../lib/outbox.mjs';
import { ACCOUNT, amexSite, loadTab, startReceiver, startWorker } from './harness.mjs';
import { startFakeHoldr } from './helpers.mjs';

const find = (document, predicate) => [...document.body.walk()].find(predicate) ?? null;
async function until(check, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the panel');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('the panel stays OFF until a person switches it ON, syncs on a click, and lists what it saved', async (t) => {
  const holdr = await startFakeHoldr(t, { accounts: [ACCOUNT] });
  const { config } = await startReceiver(t, { holdr });
  const { worker } = startWorker({ extensionDir: config.extensionDir });
  const site = amexSite();
  const tab = loadTab(site, { worker });
  t.after(() => tab.panel.dispose());
  const { document, chrome } = tab;
  const button = (text) => find(document, (node) => node.tagName === 'BUTTON' && node.textContent === text);
  const toggle = find(document, (node) => node.tagName === 'LABEL');
  const dot = find(document, (node) => node.className === 'dot');
  const status = () => find(document, (node) => node.className === 'muted').textContent;

  await until(() => dot.classList.contains('ok'));
  assert.match(status(), /^OFF: nothing is read/);
  button('Sync').click();
  await until(() => /Switch ON first/.test(status()));
  assert.deepEqual(site.requests, [], 'nothing is read from the bank while OFF');

  toggle.click();
  await until(() => chrome.store.holdrOn === true);
  assert.match(status(), /^ON: click Sync/);
  button('Sync').click();
  await until(() => /^Saved 2 files/.test(status()));
  assert.equal(button('Sync').disabled, false);
  const lines = [...document.body.walk()].filter((node) => node.tagName === 'LI').map((node) => node.textContent);
  assert.equal(lines.length, 4);
  assert.match(lines.join('\n'), /Alex ··91005 Sample Rewards: saved 7 rows; Holdr preview: 7 new, 0 already imported/);
  assert.match(lines.join('\n'), /··33003: not synced \(another card here has the same ending\)/);
  assert.equal(listOutbox(config.outboxDir).length, 2);
  assert.match(chrome.store.holdrLastSummary, /^Saved 2 files \(8 rows\)/);

  toggle.click();
  await until(() => chrome.store.holdrOn === false);
  assert.match(status(), /^OFF/);
});
