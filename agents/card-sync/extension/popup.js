// Holdr Card Sync popup: the receiver's and Holdr's state, and a button that opens Holdr.
'use strict';
const $ = (id) => document.getElementById(id);
const show = (id, text, good) => {
  const node = $(id);
  node.textContent = text;
  node.className = good === true ? 'ok' : good === false ? 'bad' : '';
};
const ask = (op) => new Promise((resolve) => {
  chrome.runtime.sendMessage({ type: 'holdr-sync', op }, (response) => {
    resolve(chrome.runtime.lastError || !response ? { ok: false, error: 'The extension did not answer' } : response);
  });
});

(async () => {
  const response = await ask('status');
  if (!response.ok) {
    show('receiver', response.error, false);
    return;
  }
  const status = response.result;
  show('receiver', `running${status.busy ? ', syncing now' : ''}${status.paused ? '; paused: see the receiver log' : ''}`, !status.paused);
  show('holdr', status.holdr?.status === 'ok' ? `reachable (schema ${status.holdr.schemaVersion})` : status.holdr?.message || 'unknown',
    status.holdr?.status === 'ok');
  const count = status.outbox?.count ?? 0;
  show('outbox', `${count} file${count === 1 ? '' : 's'} in ${status.outbox?.folder ?? 'the outbox'}`);
})();

$('open').addEventListener('click', async () => {
  const response = await ask('open-holdr');
  $('message').textContent = response.ok ? '' : response.error;
});
