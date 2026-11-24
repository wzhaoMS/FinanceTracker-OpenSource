/**
 * The MV3 service worker. Listeners are registered synchronously at the top
 * level so a cold start never misses an event; every handler first waits for
 * the start-up reconcile. There is deliberately no `onMessageExternal` or
 * `onConnectExternal` listener and the manifest has no
 * `externally_connectable`: no web page or other extension can reach it.
 */
import { parseStrictUnion } from '../common/strict.js';
import { UI_COMMANDS, type UiErrorCode } from '../contracts/messages.js';
import type { UiReply } from '../contracts/uiState.js';
import { checkReceipt, commitCapture, discardCapture, planCapture, prepareCapture, sendCapture } from './capture.js';
import { forgetTab, onCollectorMessage, requestRead } from './collectors.js';
import { deviceSignal, serialized, target } from './context.js';
import { forgetDevice, pair, refreshDevice, setTrustBrowser } from './device.js';
import { disableIssuer, enableIssuer, noteRevokedOrigins, onPermissionsRemoved, reconcileRegistrations, setPaused, startShape, startup, stopShape } from './issuers.js';
import { checkUiSender } from './senders.js';
import { uiState } from './uiState.js';

const ready = startup().catch(() => undefined);

chrome.runtime.onInstalled.addListener(() => {
  void ready;
});
chrome.runtime.onStartup.addListener(() => {
  void ready;
});
chrome.permissions.onRemoved.addListener((permissions) => {
  const origins = permissions.origins ?? [];
  // Their issuers' Holdr work stops now; storage, scripts and pages follow once start-up is done.
  noteRevokedOrigins(origins);
  void ready.then(() => onPermissionsRemoved(origins));
});
chrome.permissions.onAdded.addListener(() => {
  void ready.then(() => serialized(() => reconcileRegistrations()));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(() => forgetTab(tabId));
});

async function handleUi(message: unknown): Promise<UiReply> {
  const parsed = parseStrictUnion(message, 'command', UI_COMMANDS);
  if (!parsed.ok) return { ok: false, code: 'invalid-command', state: await uiState() };
  const command = parsed.value;
  let error: UiErrorCode | null = null;
  switch (command.command) {
    case 'get-state':
      break;
    case 'pair': {
      // Taken when the command arrives: a pause after this aborts the request, even if a resume follows.
      const signal = deviceSignal();
      error = await serialized(() => pair(command.pairingCode, command.deviceLabel, signal));
      break;
    }
    case 'refresh-device': {
      const signal = deviceSignal();
      error = await serialized(() => refreshDevice(signal));
      break;
    }
    case 'forget-device':
      error = await serialized(() => forgetDevice());
      break;
    case 'set-trust-browser':
      error = await serialized(() => setTrustBrowser(command.on));
      break;
    case 'enable-issuer':
      error = await enableIssuer(command.adapterId, command.mainPassiveAccepted);
      break;
    case 'disable-issuer':
      error = await disableIssuer(command.adapterId);
      break;
    case 'set-paused':
      await setPaused(command.on);
      break;
    case 'read':
      error = await requestRead(command.docRef, command.accountRef);
      break;
    case 'prepare':
      error = await prepareCapture({ docRef: command.docRef, accountRef: command.accountRef, bindingId: command.bindingId, scopes: command.scopes });
      break;
    case 'send':
      error = await sendCapture(command.captureId, command.digest);
      break;
    case 'discard':
      error = await discardCapture(command.captureId);
      break;
    case 'check-receipt':
      error = await checkReceipt(command.captureId);
      break;
    case 'plan':
      error = await planCapture(command.captureId);
      break;
    case 'commit':
      error = await commitCapture(command.captureId, command.previewId, command.planDigest);
      break;
    case 'shape-start':
      error = await startShape(command.adapterId);
      break;
    case 'shape-stop':
      await stopShape();
      break;
    case 'open-holdr':
      await chrome.tabs.create({ url: `${target.holdrOrigin}/` });
      break;
    default:
      error = 'invalid-command';
  }
  const state = await uiState();
  return error === null ? { ok: true, state } : { ok: false, code: error, state };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (checkUiSender(sender, chrome.runtime.id)) {
    ready
      .then(() => handleUi(message))
      .then(sendResponse, () => sendResponse({ ok: false, code: 'invalid-command', state: null } satisfies UiReply));
    return true;
  }
  if (sender.tab) {
    ready
      .then(() => onCollectorMessage(message, sender))
      .then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  sendResponse({ ok: false, code: 'not-trusted-sender', state: null } satisfies UiReply);
  return undefined;
});
