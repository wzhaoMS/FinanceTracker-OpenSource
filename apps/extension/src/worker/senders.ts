/**
 * Who may talk to the worker (plan §4.1). The worker never trusts what a
 * message says about where it came from; it uses `runtime.MessageSender`.
 *
 * - A collector message must come from this extension's content script in
 *   the top frame (frameId 0) of a live document whose exact origin is an
 *   adapter's page origin, on an approved page path, in a normal window.
 * - A UI command must come from this extension's own popup or options page,
 *   never from a content script or another extension (there is no
 *   onMessageExternal listener and no externally_connectable).
 */
import type { AdapterDescriptor } from '../adapters/types.js';

export interface CollectorSender {
  adapter: AdapterDescriptor;
  tabId: number;
  documentId: string;
}

export function checkCollectorSender(
  sender: chrome.runtime.MessageSender,
  adapters: readonly AdapterDescriptor[],
  extensionId: string,
): CollectorSender | null {
  if (sender.id !== extensionId) return null;
  const tab = sender.tab;
  if (!tab || typeof tab.id !== 'number' || !Number.isSafeInteger(tab.id) || tab.id < 0 || tab.incognito === true) return null;
  if (sender.frameId !== 0) return null;
  if (typeof sender.documentId !== 'string' || sender.documentId.length === 0 || sender.documentId.length > 128) return null;
  if (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active') return null;
  if (typeof sender.url !== 'string' || typeof sender.origin !== 'string') return null;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return null;
  }
  const adapter = adapters.find((candidate) => candidate.pageOrigin === sender.origin && candidate.pageOrigin === url.origin);
  if (!adapter) return null;
  if (url.username !== '' || url.password !== '') return null;
  return { adapter, tabId: tab.id, documentId: sender.documentId };
}

/** True when the page path is one the adapter may report from. */
export function onApprovedPath(adapter: AdapterDescriptor, senderUrl: string | undefined): boolean {
  if (typeof senderUrl !== 'string') return false;
  try {
    const { pathname } = new URL(senderUrl);
    return adapter.pagePaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  } catch {
    return false;
  }
}

const UI_PAGES = ['popup.html', 'options.html'];

export function checkUiSender(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  if (sender.id !== extensionId) return false;
  const origin = `chrome-extension://${extensionId}`;
  if (sender.origin !== undefined && sender.origin !== origin) return false;
  if (typeof sender.url !== 'string') return false;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }
  if (url.origin !== origin || url.search !== '' || url.hash !== '') return false;
  if (!UI_PAGES.includes(url.pathname.replace(/^\//, ''))) return false;
  return sender.frameId === undefined || sender.frameId === 0;
}
