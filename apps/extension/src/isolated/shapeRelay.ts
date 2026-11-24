/**
 * The ISOLATED side of shape capture (plan §5.1): registered instead of the
 * issuer's collector while shape mode is on. It only relays validated
 * `shape-report/v1` messages (field names and types, never values) from the
 * MAIN shape observer to the worker, shows a panel saying so, and stops the
 * observer when told. No rows, no reads, nothing for Holdr.
 */
import { newLocalId } from '../common/ids.js';
import { BATCH_MESSAGE_LIMITS, parseStrictUnion } from '../common/strict.js';
import { BRIDGE_CHANNEL, BRIDGE_FROM_MAIN, WORKER_TO_COLLECTOR, type BridgeFromIsolated, type CollectorMessage, type CollectorReply } from '../contracts/messages.js';
import { shapeReportConfirmed, type ShapeContractSpec } from '../contracts/shapeReport.js';
import { createStream } from '../projection/stream.js';
import { createPanel } from './panel.js';

export interface ShapeRelayIdentity {
  readonly id: string;
  readonly label: string;
  readonly pageOrigin: string;
  /** What each of the adapter's contracts may report (its descriptor's `shapeContracts`). */
  readonly shapeContracts: Readonly<Partial<Record<string, ShapeContractSpec>>>;
}

export function runShapeRelay(adapters: readonly ShapeRelayIdentity[]): void {
  const identity = adapters.find((adapter) => adapter.pageOrigin === location.origin);
  if (!identity || window.top !== window) return;
  const nonce = newLocalId('nonce');
  const stream = createStream();
  let seq = 0;
  let stopped = false;
  let reports = 0;
  const panel = createPanel(document);
  const show = (status: string) =>
    panel.update({ title: `Holdr · shape capture · ${identity.label}`, status, lines: [`${reports} response shape(s) recorded.`], partial: false });
  show('Recording field names and types of this page’s own responses. No values, nothing sent to Holdr.');

  const send = (message: CollectorMessage) => chrome.runtime.sendMessage(message).catch(() => null);
  const postBridge = (message: BridgeFromIsolated) => window.postMessage(message, location.origin);

  window.addEventListener('message', (event: MessageEvent) => {
    if (stopped || event.source !== window || event.origin !== location.origin) return;
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null || (data as { channel?: unknown }).channel !== BRIDGE_CHANNEL) return;
    const kind = (data as { kind?: unknown }).kind;
    if (kind !== 'main-ready' && kind !== 'shape') return;
    const parsed = parseStrictUnion(data, 'kind', BRIDGE_FROM_MAIN, { limits: BATCH_MESSAGE_LIMITS });
    if (!parsed.ok) return;
    const message = parsed.value;
    if (message.kind === 'main-ready') {
      if (message.adapterId === identity.id) postBridge({ channel: BRIDGE_CHANNEL, kind: 'hello', nonce });
      return;
    }
    if (message.kind !== 'shape' || message.nonce !== nonce || message.report.adapterId !== identity.id) return;
    // Authoritative here (MAIN's output is advisory): only a report that is exactly what its contract allows is relayed.
    if (!shapeReportConfirmed(message.report, identity.shapeContracts[message.report.contract])) return;
    reports += 1;
    show('Recording field names and types of this page’s own responses. No values, nothing sent to Holdr.');
    void send({ type: 'collector-shape/v1', adapterId: identity.id, seq: seq++, report: message.report });
  });
  postBridge({ channel: BRIDGE_CHANNEL, kind: 'hello', nonce });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return;
    const parsed = parseStrictUnion(message, 'type', WORKER_TO_COLLECTOR);
    if (!parsed.ok || parsed.value.type !== 'collector-stop/v1') {
      sendResponse({ ok: false, code: 'bad-config' } satisfies CollectorReply);
      return;
    }
    stopped = true;
    postBridge({ channel: BRIDGE_CHANNEL, kind: 'stop', nonce });
    show('Shape capture stopped.');
    sendResponse({ ok: true, code: null } satisfies CollectorReply);
  });

  // Leaving the page (a navigation, or the back/forward cache) ends shape capture here for good.
  window.addEventListener('pagehide', () => {
    if (stopped) return;
    stopped = true;
    postBridge({ channel: BRIDGE_CHANNEL, kind: 'stop', nonce });
    show('Shape capture stopped.');
  });

  void send({ type: 'collector-ready/v1', adapterId: identity.id, seq: seq++, role: 'shape', streamHandle: stream.streamHandle, pageState: 'other' });
}
