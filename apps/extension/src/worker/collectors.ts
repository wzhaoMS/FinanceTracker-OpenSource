/**
 * Collector → worker messages. Each is accepted only from a checked sender
 * (worker/senders.ts), only in its exact schema, only for an adapter that may
 * run right now, and only in increasing per-document sequence. A collector
 * that is no longer allowed to run is told to stop.
 */
import { BATCH_MESSAGE_LIMITS, parseStrictUnion } from '../common/strict.js';
import { newLocalId } from '../common/ids.js';
import { COLLECTOR_MESSAGES, MAX_RETRY_AFTER_MS, type CollectorConfig, type CollectorRole, type StopReason, type UiErrorCode } from '../contracts/messages.js';
import { shapeReportConfirmed } from '../contracts/shapeReport.js';
import { localDay } from '../projection/project.js';
import { isAdapterActive } from './activity.js';
import { failBuildingFor, onCollectorBatch } from './capture.js';
import { dropUnconfirmedStops, findDoc, noteReadsEnded, recordUnconfirmedStops, sendToCollector, stopCollectors, unconfirmedStopOf } from './collectorLink.js';
import { adapterById, beginWork, forIssuer, issuerHalt, pausePending, readBudget, serialized, stopIssuerWork, target, type Halt, type IssuerWork } from './context.js';
import { pauseForShapeChange } from './issuers.js';
import { shapeChangedPause } from './registration.js';
import { checkCollectorSender, onApprovedPath } from './senders.js';
import { readSession, readSettings, writeSession, type CollectorDoc } from './storage.js';

const MAX_DOCS = 20;
const MAX_SHAPE_REPORTS = 20;
const HELD_BY_PAUSE: Halt = { code: 'paused', cause: 'paused' };

function leaseFree(leases: Record<string, { docRef: string; until: number }>, adapterId: string, now: number): boolean {
  const lease = leases[adapterId];
  return !lease || lease.until <= now;
}

/**
 * Takes the issuer's read lease. Returns how long the read must wait before
 * its first request (what is left of the spacing after the issuer's previous
 * read, `noteReadsEnded`), or null while another read holds the lease.
 */
async function takeLease(adapterId: string, docRef: string): Promise<number | null> {
  const leases = await readSession('readLeases');
  const cooldownUntil = (await readSession('readCooldowns'))[adapterId] ?? 0;
  const now = Date.now();
  if (!leaseFree(leases, adapterId, now)) return null;
  const startDelayMs = Math.min(target.timings.requestIntervalMs, Math.max(0, cooldownUntil - now));
  leases[adapterId] = { docRef, until: now + startDelayMs + target.timings.runLimitMs + 5_000 };
  await writeSession('readLeases', leases);
  return startDelayMs;
}

async function releaseLease(adapterId: string, docRef: string): Promise<void> {
  const leases = await readSession('readLeases');
  if (leases[adapterId]?.docRef === docRef) {
    delete leases[adapterId];
    await writeSession('readLeases', leases);
    await noteReadsEnded([adapterId]);
  }
}

async function rateLimited(adapterId: string): Promise<boolean> {
  const until = (await readSession('rateLimitedUntil'))[adapterId];
  return typeof until === 'number' && until > Date.now();
}

function readConfig(action: 'discover' | 'read', accountRef: string | null, window: { start: string; end: string } | null, startDelayMs: number): CollectorConfig {
  return { type: 'collector-config/v1', action, captureId: null, accountRef, bindingId: null, bindingVersion: null, scopes: [], confirmedScopes: [], cards: [], window, budget: { ...readBudget(), startDelayMs } };
}

/** Starts the one-time discovery read of an activity document, if no other read of this issuer holds the lease and nothing stopped the issuer since `job` began. */
async function startDiscovery(doc: CollectorDoc, job: IssuerWork): Promise<void> {
  if (await rateLimited(doc.adapterId)) return;
  const startDelayMs = await takeLease(doc.adapterId, doc.docRef);
  if (startDelayMs === null) return;
  // After the last await: a stop since the triggering message arrived wins, and nothing is asked of the page.
  if (issuerHalt(job)) {
    await releaseLease(doc.adapterId, doc.docRef);
    return;
  }
  const reply = await sendToCollector(doc, readConfig('discover', null, null, startDelayMs));
  if (reply?.ok) {
    const current = (await readSession('collectors')).map((item) => (item.docRef === doc.docRef ? { ...item, discovered: true } : item));
    await writeSession('collectors', current);
  } else {
    await releaseLease(doc.adapterId, doc.docRef);
  }
}

/** After a read ends, the next activity document of the same issuer that is still waiting for discovery gets its turn. */
async function discoverNextWaiting(adapterId: string, inShapeMode: boolean, job: IssuerWork): Promise<void> {
  if (inShapeMode) return;
  const adapter = adapterById(adapterId);
  if (!adapter || adapter.mode !== 'isolated-read') return;
  const waiting = (await readSession('collectors')).find((doc) => doc.adapterId === adapterId && doc.pageState === 'activity' && !doc.discovered);
  if (waiting) await startDiscovery(waiting, job);
}

/** The default overlap window: the last `defaultWindowDays` issuer calendar days, ending today. */
export function defaultWindow(now = new Date()): { start: string; end: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (target.timings.defaultWindowDays - 1));
  return { start: localDay(start), end: localDay(now) };
}

export async function onCollectorMessage(message: unknown, sender: chrome.runtime.MessageSender): Promise<{ ok: boolean }> {
  // Before any await: a stop after this message arrived cancels what it would start.
  const work = beginWork();
  const checked = checkCollectorSender(sender, target.adapters, chrome.runtime.id);
  if (!checked) return { ok: false };
  const parsed = parseStrictUnion(message, 'type', COLLECTOR_MESSAGES, { limits: BATCH_MESSAGE_LIMITS });
  if (!parsed.ok) return { ok: false };
  const msg = parsed.value;
  const adapter = checked.adapter;
  if (msg.adapterId !== adapter.id) return { ok: false };
  const approved = onApprovedPath(adapter, sender.url);
  // The page reports that the site changed what it sends: the issuer's Holdr work, reads and discovery stop now;
  // the contract pause is stored as soon as the report is admitted below.
  const drift = msg.type === 'collector-status/v1' && msg.code === 'shape-changed';
  if (drift) stopIssuerWork(adapter.id, 'shape-changed', true);
  const job = forIssuer(work, adapter.id);

  return serialized(async () => {
    const settings = await readSettings();
    const docs = await readSession('collectors');
    let doc = docs.find((item) => item.tabId === checked.tabId && item.documentId === checked.documentId);
    const shape = await readSession('shape');
    const inShapeMode = shape?.adapterId === adapter.id;
    const liveShape = inShapeMode && shape.expiresAt > Date.now();
    // What runs in this page: declared in its first message and kept with its document. Only collectors send status
    // and batches, only shape relays send shape reports.
    const role: CollectorRole = msg.type === 'collector-ready/v1' ? msg.role : (doc?.role ?? (msg.type === 'collector-shape/v1' ? 'shape' : 'collector'));
    // A page told to stop that does not answer may still run: it joins the unconfirmed stops (warning, retries).
    const stopPage = async (reason: StopReason) => {
      const page = { tabId: checked.tabId, documentId: checked.documentId };
      const reply = await sendToCollector(page, { type: 'collector-stop/v1', reason });
      if (!reply?.ok) await recordUnconfirmedStops([{ ...page, adapterId: adapter.id, reason }]);
      return { ok: false };
    };
    // A drift report stopped the issuer's work when it arrived. The contract pause it stands for is stored whatever
    // becomes of this message, so the issuer is never blocked in memory only (unless this adapter version's contract is
    // paused already, which changes nothing).
    if (drift && !shapeChangedPause(adapter, settings.issuers[adapter.id])) void pauseForShapeChange(adapter.id);
    // A page that missed an earlier stop never runs again: it is told to stop now (a reload starts it afresh).
    const missed = await unconfirmedStopOf(checked.tabId, checked.documentId);
    if (missed) {
      const reply = await sendToCollector(missed, { type: 'collector-stop/v1', reason: missed.reason });
      if (reply?.ok) await dropUnconfirmedStops((entry) => entry.tabId === missed.tabId && entry.documentId === missed.documentId);
      return { ok: false };
    }
    // A stop since this message arrived, or requested but not stored yet, counts as stored. The drift report is itself that stop.
    const hold = drift ? (pausePending() ? HELD_BY_PAUSE : null) : issuerHalt(job);
    const paused = settings.paused || hold?.code === 'paused';
    // A contract paused after a site change still records the new form while shape mode is on, with the site permission
    // granted, and held back by nothing but that contract pause and its shape mode (a revocation or any other stop wins).
    const shapeOnly = role === 'shape' && liveShape && !paused && shapeChangedPause(adapter, settings.issuers[adapter.id])
      && (hold === null || (hold.code === 'issuer-not-enabled' && (hold.cause === 'shape-changed' || hold.cause === 'shape-mode')))
      && (await chrome.permissions.contains({ origins: [adapter.hostPermission] }));
    if (!shapeOnly && (hold !== null || !(await isAdapterActive(adapter, settings)))) return stopPage(paused ? 'kill-switch' : 'issuer-paused');
    // Shape relays run only during a live shape mode of their issuer, collectors never during one, and a document keeps
    // the role it started with: a page that got its scripts just before shape mode started or ended is told to stop.
    if ((role === 'shape' ? !liveShape : inShapeMode) || (doc !== undefined && doc.role !== role)) return stopPage('shape-mode');

    if (msg.type === 'collector-ready/v1') {
      if (!approved && msg.pageState === 'activity') return { ok: false };
      // A tab holds one live document: a new document replaces the old one's entry.
      const others = docs.filter((item) => item.tabId !== checked.tabId);
      const previous = docs.find((item) => item.tabId === checked.tabId);
      if (previous && previous.documentId !== checked.documentId) {
        await failBuildingFor(previous.docRef, 'collector-refused');
        await releaseLease(previous.adapterId, previous.docRef);
      }
      if (!doc || doc.streamHandle !== msg.streamHandle) {
        if (doc) await failBuildingFor(doc.docRef, 'collector-refused');
        doc = {
          docRef: doc?.docRef ?? newLocalId('document'),
          tabId: checked.tabId,
          documentId: checked.documentId,
          adapterId: adapter.id,
          role,
          streamHandle: msg.streamHandle,
          lastSeq: -1,
          pageState: msg.pageState,
          state: 'waiting',
          code: null,
          issues: [],
          accounts: [],
          // A new stream (navigation, account switch) dropped its candidates: discover again.
          discovered: false,
          updatedAt: Date.now(),
        };
      }
      if (msg.seq <= doc.lastSeq) return { ok: false };
      doc = { ...doc, lastSeq: msg.seq, pageState: msg.pageState, updatedAt: Date.now() };
      // Tracking is bounded: the oldest documents leave it, told to stop first (and kept as unconfirmed stops if they do
      // not answer), so every page that may run stays reachable by the next stop.
      const tracked = [...others, doc];
      const evicted = tracked.slice(0, Math.max(0, tracked.length - MAX_DOCS));
      if (evicted.length > 0) {
        for (const old of evicted) {
          await failBuildingFor(old.docRef, 'collector-unreachable');
          await releaseLease(old.adapterId, old.docRef);
        }
        await stopCollectors((item) => evicted.some((old) => old.docRef === item.docRef), 'superseded');
      }
      const kept = (await readSession('collectors')).filter((item) => item.tabId !== checked.tabId);
      await writeSession('collectors', [...kept, doc]);

      // Discovery is the one read that starts on its own: once per activity document, when nothing else of this issuer is reading.
      if (role === 'collector' && adapter.mode === 'isolated-read' && msg.pageState === 'activity' && !doc.discovered && !inShapeMode) await startDiscovery(doc, job);
      return { ok: true };
    }

    // A page the worker does not track (forgotten by a stop, or replaced) cannot be stopped later: it stops now.
    if (!doc) return stopPage(drift ? 'issuer-paused' : 'superseded');
    if (msg.seq <= doc.lastSeq) return { ok: false };

    if (msg.type === 'collector-shape/v1') {
      if (doc.role !== 'shape' || !liveShape || !shape) return { ok: false };
      // Layer 3: only a report that is exactly what its contract allows is kept (plan §5.1).
      if (!shapeReportConfirmed(msg.report, adapter.shapeContracts[msg.report.contract])) return { ok: false };
      await writeSession('collectors', docs.map((item) => (item.docRef === doc!.docRef ? { ...item, lastSeq: msg.seq, updatedAt: Date.now() } : item)));
      const key = `${msg.report.contract} ${msg.report.method} ${msg.report.pathTemplate}`;
      const reports = shape.reports.filter((report) => `${report.contract} ${report.method} ${report.pathTemplate}` !== key);
      reports.push(msg.report);
      await writeSession('shape', { ...shape, reports: reports.slice(-MAX_SHAPE_REPORTS) });
      return { ok: true };
    }

    if (msg.type === 'collector-status/v1') {
      if (!approved && msg.accounts.length > 0) return { ok: false };
      if (msg.streamHandle !== doc.streamHandle) await failBuildingFor(doc.docRef, 'collector-refused');
      const next: CollectorDoc = {
        ...doc,
        lastSeq: msg.seq,
        streamHandle: msg.streamHandle,
        pageState: msg.pageState,
        state: msg.state,
        code: msg.code,
        issues: msg.issues,
        accounts: msg.accounts,
        updatedAt: Date.now(),
      };
      await writeSession('collectors', docs.map((item) => (item.docRef === doc!.docRef ? next : item)));
      // A rate limit pauses the issuer before its lease is handed on, so no other tab reads in the meantime.
      if (msg.code === 'rate-limited') {
        const limits = await readSession('rateLimitedUntil');
        const pause = Math.max(target.timings.rateLimitPauseMs, Math.min(msg.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS));
        limits[adapter.id] = Math.max(limits[adapter.id] ?? 0, Date.now() + pause);
        await writeSession('rateLimitedUntil', limits);
      }
      if (msg.state !== 'reading' && msg.state !== 'discovering') {
        await releaseLease(adapter.id, doc.docRef);
        await discoverNextWaiting(adapter.id, inShapeMode, job);
      }
      if (msg.state === 'error' || msg.state === 'stopped') await failBuildingFor(doc.docRef, 'collector-refused');
      return { ok: true };
    }

    // collector-batch/v1
    if (!approved || inShapeMode) return { ok: false };
    await writeSession('collectors', docs.map((item) => (item.docRef === doc!.docRef ? { ...item, lastSeq: msg.seq, updatedAt: Date.now() } : item)));
    return { ok: await onCollectorBatch(doc, msg) };
  });
}

/** The popup asked to read one account's recent activity (isolated-read adapters only). */
export function requestRead(docRef: string, accountRef: string): Promise<UiErrorCode | null> {
  // Before any await: a stop after the request arrived cancels it, even if a resume follows.
  const work = beginWork();
  return serialized(async () => {
    const settings = await readSettings();
    if (settings.paused) return 'paused';
    const doc = await findDoc(docRef);
    if (!doc) return 'unknown-document';
    const adapter = adapterById(doc.adapterId);
    if (!adapter) return 'issuer-not-enabled';
    const job = forIssuer(work, adapter.id);
    const halted = issuerHalt(job);
    if (halted) return halted.code;
    if (!(await isAdapterActive(adapter, settings))) return 'issuer-not-enabled';
    if (adapter.mode !== 'isolated-read') return 'wrong-stage';
    if ((await readSession('shape'))?.adapterId === adapter.id) return 'busy';
    if (!doc.accounts.some((account) => account.ref === accountRef)) return 'unknown-account';
    if (await rateLimited(adapter.id)) return 'rate-limited';
    const startDelayMs = await takeLease(adapter.id, doc.docRef);
    if (startDelayMs === null) return 'busy';
    // After the last await: a stop since the request arrived wins, and nothing is asked of the page.
    const late = issuerHalt(job);
    if (late) {
      await releaseLease(adapter.id, doc.docRef);
      return late.code;
    }
    const reply = await sendToCollector(doc, readConfig('read', accountRef, defaultWindow(), startDelayMs));
    if (!reply?.ok) {
      await releaseLease(adapter.id, doc.docRef);
      return reply ? 'collector-refused' : 'collector-unreachable';
    }
    return null;
  });
}

/** A closed tab takes its documents with it, and with them any stop they never answered. */
export function forgetTab(tabId: number): Promise<void> {
  return serialized(async () => {
    await dropUnconfirmedStops((entry) => entry.tabId === tabId);
    const docs = await readSession('collectors');
    const gone = docs.filter((doc) => doc.tabId === tabId);
    if (gone.length === 0) return;
    for (const doc of gone) {
      await failBuildingFor(doc.docRef, 'collector-unreachable');
      await releaseLease(doc.adapterId, doc.docRef);
    }
    await writeSession('collectors', docs.filter((doc) => doc.tabId !== tabId));
  });
}
