/**
 * One capture at a time, from the user's confirmed mapping to Holdr's durable
 * acceptance and, separately, the ledger commit (plan §3.4, §4.4, §6.4).
 *
 * prepare   the popup sends the binding and the scope for every
 *           (holder group, last four) pair; the worker checks them against
 *           Holdr's capabilities and asks the collector to build the v2 payload.
 * freeze    validation layer 3: the payload is validated again, matched against
 *           the capture (binding, capture id, source, mode, scopes, cards),
 *           serialized with `canonicalJson` and frozen in trusted session
 *           storage with its digest. Ten minutes to review; new page data goes
 *           to a new capture.
 * send      only from the popup, only with the digest of the bytes the popup
 *           displayed. The worker sends exactly the frozen bytes. On an unknown
 *           outcome it asks Holdr for the receipt first, then retries at most
 *           twice with the same bytes and idempotency key. After Holdr's
 *           durable ACK the local copy is cleared. A stop after the run exists
 *           tells Holdr why (the run abort reason, Q4).
 * plan,     the ledger plan and its commit are separate, explicit steps. Holdr
 * commit    answers a plan with an executable plan or with `owner-review`
 *           (E1b X24: the owner decides in Holdr, nothing to commit here; with
 *           contract 1's admissions closed, every first sync).
 * receipts  committed, rejected (the owner discarded the set; X13) and an
 *           expired review are final: nothing is sent, planned or committed
 *           for that capture again.
 */
import {
  CARD_SYNC_CONTRACT_VERSION,
  CARD_SYNC_V2_VERSION,
  canonicalJson,
  cardSyncPayloadDigest,
  utf8ByteLength,
  validateCardSyncPayloadV2,
  type CardSyncIssue,
} from '@finance-tracker/shared';
import { newCardSyncId } from '../common/ids.js';
import type { Binding, Capabilities, HoldrErrorCode, ObservationAccepted, Receipt, RunAbortReason } from '../contracts/holdrApi.js';
import type { CollectorMessage, ScopeEntry, UiErrorCode } from '../contracts/messages.js';
import { grantedOrigins, isAdapterActive } from './activity.js';
import { findDoc, sendToCollector } from './collectorLink.js';
import {
  adapterById,
  beginWork,
  deviceSignal,
  forIssuer,
  holdr,
  inShapeMode,
  issuerHalt,
  pausePending,
  serialized,
  sleep,
  target,
  type Halt,
  type IssuerWork,
  type StopCause,
} from './context.js';
import { activeDevice, failureCode, handleUnauthorized } from './device.js';
import { unknownOutcome, type HoldrFailure, type HoldrResult } from './holdrClient.js';
import { adapterActive, shapeChangedPause } from './registration.js';
import {
  pushLastRun,
  readSession,
  readSettings,
  sessionBytes,
  writeSession,
  type CaptureRecord,
  type CaptureStage,
  type CollectorDoc,
  type Settings,
  type ShapeState,
} from './storage.js';

const ACTIVE_STAGES: readonly CaptureStage[] = ['building', 'preview', 'sending', 'outcome-unknown'];

function blank(fields: Pick<CaptureRecord, 'captureId' | 'clientRunId' | 'deviceId' | 'adapterId' | 'docRef' | 'accountRef' | 'bindingId' | 'bindingVersion' | 'bindingLabel' | 'scopes' | 'confirmedScopes' | 'cards'>): CaptureRecord {
  return {
    ...fields,
    stage: 'building',
    createdAt: Date.now(),
    expiresAt: null,
    text: null,
    digest: null,
    byteLength: null,
    rows: 0,
    pending: 0,
    posted: 0,
    runId: null,
    uploadUncertain: false,
    runClosed: false,
    observationSetId: null,
    acceptance: null,
    acceptedAt: null,
    acceptExpiresAt: null,
    previewId: null,
    planDigest: null,
    plan: null,
    ownerReview: null,
    committing: false,
    commitUncertain: false,
    committedAt: null,
    error: null,
    holdrError: null,
    issues: [],
  };
}

async function update(captureId: string, change: (capture: CaptureRecord) => CaptureRecord | null): Promise<CaptureRecord | null> {
  const capture = await readSession('capture');
  if (!capture || capture.captureId !== captureId) return null;
  const next = change(capture);
  if (next) await writeSession('capture', next);
  return next;
}

function failed(capture: CaptureRecord, error: UiErrorCode, holdrFailure: HoldrFailure | null = null, issues: CardSyncIssue[] = []): CaptureRecord {
  return { ...capture, stage: 'failed', error, holdrError: holdrFailure?.code ?? null, issues, text: null, expiresAt: null };
}

/** Lazily expires an unsent frozen batch (no alarms permission: checked whenever the capture is touched). */
/**
 * Frozen bytes live at most `previewTtlMs` in every stage that still holds
 * them: an unsent preview becomes `expired`; an unknown outcome keeps what a
 * receipt check needs (run, digest), not the bytes. A send in flight finishes
 * its bounded attempts first.
 */
export function expireIfDue(capture: CaptureRecord, now = Date.now()): CaptureRecord {
  if (capture.expiresAt === null || capture.expiresAt > now) return capture;
  // An earlier upload of these bytes may still be stored: the bytes go, the outcome stays checkable.
  if (capture.stage === 'preview' && capture.uploadUncertain) return { ...capture, stage: 'outcome-unknown', text: null, expiresAt: null };
  if (capture.stage === 'preview' || capture.stage === 'building') return { ...capture, stage: 'expired', text: null, expiresAt: null };
  if (capture.stage === 'outcome-unknown') return { ...capture, text: null, expiresAt: null };
  return capture;
}

/** Holdr must list the payload and contract versions this build sends; nothing is downgraded. */
export function acceptsFormat(capabilities: Pick<Capabilities, 'payloadVersions' | 'contractVersions'>): boolean {
  return capabilities.payloadVersions.includes(CARD_SYNC_V2_VERSION) && capabilities.contractVersions.includes(CARD_SYNC_CONTRACT_VERSION);
}

/** Fallback when a request was aborted but the gate shows no stop (it always should). */
const STOPPED: Halt = { code: 'stopped', cause: 'issuer-disabled' };

/**
 * Holdr work for a capture goes on only while nothing stopped it: no stop
 * since it began and none requested but not stored yet (the stop gate,
 * context.ts), no stored global pause and, for work gated on its issuer, the
 * issuer still active (enabled, consented, permitted) and not in shape mode.
 * Checked before every request and retry; the gate is read again after the
 * storage reads, so no await separates the last check from the request.
 * Requests are also bound to the work's signal, which every later stop of
 * its issuer aborts.
 */
async function stillAllowed(job: IssuerWork): Promise<Halt | null> {
  const before = held(job);
  if (before) return before;
  const settings = await readSettings();
  if (settings.paused || !job.gate) return haltAfterReads(job, settings, new Set(), null);
  const granted = await grantedOrigins();
  const shape = await readSession('shape');
  return haltAfterReads(job, settings, granted, shape);
}

/**
 * What stops `job` once `stillAllowed` has read storage and the browser's
 * site permissions. The gate comes first: a stop that arrived during those
 * reads is what they show the effect of, and the first stop since the work
 * began is what Holdr hears (Q4). Storage alone (a change the gate never
 * saw) names what it shows: a contract paused on a site change, the site
 * permission gone, or the issuer switched off.
 */
export function haltAfterReads(job: IssuerWork, settings: Settings, granted: ReadonlySet<string>, shape: ShapeState | null, now = Date.now()): Halt | null {
  const stop = held(job);
  if (stop) return stop;
  if (settings.paused) return { code: 'paused', cause: 'paused' };
  if (!job.gate) return null;
  const adapter = adapterById(job.adapterId);
  if (!adapter) return { code: 'issuer-not-enabled', cause: 'issuer-disabled' };
  if (!adapterActive(adapter, settings, granted)) {
    const cause: StopCause = shapeChangedPause(adapter, settings.issuers[adapter.id])
      ? 'shape-changed'
      : granted.has(adapter.hostPermission) ? 'issuer-disabled' : 'permission-revoked';
    return { code: 'issuer-not-enabled', cause };
  }
  if (shape && shape.adapterId === job.adapterId && shape.expiresAt > now) return SHAPE_MODE;
  return null;
}

/** Nothing of an issuer's capture goes to Holdr while its shape mode records field names (receipt checks and run aborts carry no capture data). */
const SHAPE_MODE: Halt = { code: 'busy', cause: 'shape-mode' };

/** The synchronous part: the stop gate, and shape mode for work gated on its issuer. */
function held(job: IssuerWork): Halt | null {
  return issuerHalt(job) ?? (job.gate && inShapeMode(job.adapterId) ? SHAPE_MODE : null);
}

export interface PrepareInput {
  docRef: string;
  accountRef: string;
  bindingId: string;
  scopes: ScopeEntry[];
}

/** Checks the user's mapping against Holdr's capabilities and the collector's summary, then asks the collector to build. */
export function prepareCapture(input: PrepareInput): Promise<UiErrorCode | null> {
  // Before any await: a stop after the request arrived cancels it, even if a resume follows.
  const work = beginWork();
  return serialized(async () => {
    const settings = await readSettings();
    if (settings.paused) return 'paused';
    const doc = await findDoc(input.docRef);
    if (!doc) return 'unknown-document';
    const adapter = adapterById(doc.adapterId);
    if (!adapter) return 'issuer-not-enabled';
    const job = forIssuer(work, adapter.id);
    const halted = issuerHalt(job);
    if (halted) return halted.code;
    if (!(await isAdapterActive(adapter, settings))) return 'issuer-not-enabled';
    const shape = await readSession('shape');
    if (shape?.adapterId === adapter.id) return 'busy';
    const device = await activeDevice();
    if (!device.ok) return device.code;
    const capabilities = await readSession('capabilities');
    if (!capabilities || !capabilities.syncEnabled) return 'sync-disabled';
    if (!capabilities.issuers.some((item) => item.issuer === adapter.issuer && item.enabled)) return 'sync-disabled';
    if (!acceptsFormat(capabilities)) return 'holdr-incompatible';
    const binding: Binding | undefined = capabilities.bindings.find((item) => item.bindingId === input.bindingId);
    if (!binding) return 'unknown-binding';
    if (binding.issuer !== adapter.issuer || binding.source !== adapter.source) return 'binding-mismatch';
    const account = doc.accounts.find((item) => item.ref === input.accountRef);
    if (!account) return 'unknown-account';

    const pairs = new Set<string>();
    for (const entry of input.scopes) {
      const key = `${entry.holderRef ?? '-'} ${entry.cardLast4 ?? '-'}`;
      if (pairs.has(key)) return 'unmapped-rows';
      pairs.add(key);
      const scope = binding.scopes.find((item) => item.cardScopeId === entry.cardScopeId);
      if (!scope) return 'unknown-scope';
      if (entry.cardLast4 !== null && scope.last4 !== null && !scope.holderUnknown && scope.last4 !== entry.cardLast4) return 'scope-conflict';
    }
    for (const group of account.groups) {
      if (!pairs.has(`${group.holderRef ?? '-'} ${group.cardLast4 ?? '-'}`)) return 'unmapped-rows';
    }
    if (input.scopes.length === 0) return 'unmapped-rows';

    const existing = await readSession('capture');
    // A capture in flight, or one whose commit is in flight or may still land, is never replaced: its outcome must stay visible.
    if (existing && (ACTIVE_STAGES.includes(expireIfDue(existing).stage) || existing.committing || existing.commitUncertain)) return 'busy';

    // E1a §10a: coverage covers every confirmed scope of the bound account, a scope without rows included, so Holdr can
    // tell a card read and empty from one not read; `cards` are the last fours of those scopes (all present in the payload).
    const confirmedScopes = [...new Set(binding.scopes.map((scope) => scope.cardScopeId))].sort();
    const cards = [...new Set(binding.scopes.map((scope) => scope.last4).filter((last4): last4 is string => last4 !== null))].sort();
    const capture = blank({
      captureId: newCardSyncId('capture'),
      clientRunId: newCardSyncId('clientRun'),
      deviceId: device.device.deviceId,
      adapterId: adapter.id,
      docRef: doc.docRef,
      accountRef: input.accountRef,
      bindingId: binding.bindingId,
      bindingVersion: binding.bindingVersion,
      bindingLabel: binding.bindingLabel,
      scopes: input.scopes.map((entry) => ({ ...entry })),
      confirmedScopes,
      cards,
    });
    capture.expiresAt = Date.now() + target.timings.previewTtlMs;
    await writeSession('capture', capture);
    // After the last await: a stop since the request arrived wins, and the page is not asked to build.
    const late = issuerHalt(job);
    if (late) {
      await writeSession('capture', { ...capture, stage: 'discarded', expiresAt: null, error: late.code });
      return late.code;
    }
    const reply = await sendToCollector(doc, {
      type: 'collector-config/v1',
      action: 'build',
      captureId: capture.captureId,
      accountRef: input.accountRef,
      bindingId: binding.bindingId,
      bindingVersion: binding.bindingVersion,
      scopes: capture.scopes,
      confirmedScopes,
      cards,
      window: null,
      budget: null,
    });
    if (!reply || !reply.ok) {
      await writeSession('capture', failed(capture, reply ? 'collector-refused' : 'collector-unreachable'));
      return reply ? 'collector-refused' : 'collector-unreachable';
    }
    return null;
  });
}

/** Validation layer 3 and the freeze: called with a collector batch that already passed the strict message schema. */
export async function onCollectorBatch(doc: CollectorDoc, message: Extract<CollectorMessage, { type: 'collector-batch/v1' }>): Promise<boolean> {
  const capture = await readSession('capture');
  if (!capture || capture.stage !== 'building' || capture.captureId !== message.captureId || capture.docRef !== doc.docRef) return false;
  const adapter = adapterById(doc.adapterId);
  const capabilities = await readSession('capabilities');
  const refuse = async (error: UiErrorCode, issues: CardSyncIssue[] = []) => {
    await writeSession('capture', failed(capture, error, null, issues));
    return false;
  };
  if (!adapter || !capabilities) return refuse('issuer-not-enabled');
  const validation = validateCardSyncPayloadV2(message.payload);
  if (!validation.ok) return refuse('collector-refused', validation.issues);
  const payload = validation.payload;
  // Rows only under the scopes the user mapped; coverage for exactly every confirmed scope of the bound account (§10a).
  const mapped = new Set(capture.scopes.map((entry) => entry.cardScopeId));
  const confirmed = new Set(capture.confirmedScopes);
  const covered = new Set(payload.coverage.map((entry) => entry.cardScopeId));
  const matches = payload.captureId === capture.captureId
    && payload.bindingId === capture.bindingId
    && payload.bindingVersion === capture.bindingVersion
    && payload.issuer === adapter.issuer
    && payload.source === adapter.source
    && payload.mode === adapter.mode
    && payload.parserVersion === adapter.parserVersion
    && payload.owner === null
    && JSON.stringify(payload.cards) === JSON.stringify(capture.cards)
    && payload.rows.every((row) => mapped.has(row.cardScopeId))
    && [...mapped].every((id) => confirmed.has(id))
    && covered.size === confirmed.size
    && [...confirmed].every((id) => covered.has(id));
  if (!matches) return refuse('collector-refused');
  const text = canonicalJson(payload as unknown as Parameters<typeof canonicalJson>[0]);
  const byteLength = utf8ByteLength(text);
  if (byteLength !== validation.byteLength) return refuse('collector-refused');
  if (byteLength > capabilities.maxPayloadBytes || payload.rows.length > capabilities.maxRows) return refuse('too-large');
  if ((await sessionBytes()) + text.length * 2 > target.timings.sessionBudgetBytes) return refuse('session-budget');
  // The digest covers exactly these canonical bytes (`text` is `canonicalJson(payload)`).
  const digest = cardSyncPayloadDigest(payload);
  const now = Date.now();
  await writeSession('capture', {
    ...capture,
    stage: 'preview',
    text,
    digest,
    byteLength,
    rows: payload.rows.length,
    pending: payload.rows.filter((row) => row.status === 'pending').length,
    posted: payload.rows.filter((row) => row.status === 'posted').length,
    expiresAt: now + target.timings.previewTtlMs,
  });
  // The frozen bytes cannot change; whatever the page shows next belongs to a new capture.
  await sendToCollector(doc, {
    type: 'collector-config/v1',
    action: 'release',
    captureId: capture.captureId,
    accountRef: capture.accountRef,
    bindingId: null,
    bindingVersion: null,
    scopes: [],
    confirmedScopes: [],
    cards: [],
    window: null,
    budget: null,
  });
  return true;
}

/** A collector's stream changed or it stopped while a payload was being built for it. */
export async function failBuildingFor(docRef: string, error: UiErrorCode): Promise<void> {
  const capture = await readSession('capture');
  if (capture && capture.stage === 'building' && capture.docRef === docRef) await writeSession('capture', failed(capture, error));
}

/**
 * A stop (kill switch, issuer disabled, permission revoked, contract paused)
 * drops what was not sent. A send that may already have reached Holdr (in
 * flight now, or an earlier upload whose answer never came) keeps only what
 * a receipt check needs (run, digest), never the bytes.
 */
export async function dropCapture(match: (capture: CaptureRecord) => boolean): Promise<void> {
  const capture = await readSession('capture');
  if (!capture || !match(capture)) return;
  const checkable = capture.stage === 'sending' || capture.stage === 'outcome-unknown' || (capture.stage === 'preview' && capture.uploadUncertain);
  // A send stopped once its run exists may have dispatched its upload: known in this same write, so a worker that ends
  // before the send's own cleanup cannot lose it.
  const uncertain = capture.uploadUncertain || (capture.stage === 'sending' && capture.runId !== null);
  if (checkable) await writeSession('capture', { ...capture, stage: 'outcome-unknown', text: null, expiresAt: null, uploadUncertain: uncertain });
  else if (capture.stage === 'building' || capture.stage === 'preview') await writeSession('capture', { ...capture, stage: 'discarded', text: null, expiresAt: null });
}

async function withDevice<T>(capture: CaptureRecord, work: (token: string) => Promise<T>): Promise<T | UiErrorCode> {
  const device = await activeDevice();
  if (!device.ok) return device.code;
  if (device.device.deviceId !== capture.deviceId) return replacedDevice(capture.captureId);
  return work(device.device.token);
}

/** Stages a capture of a replaced pairing ends in (a send in flight finishes first; final stages stay). */
const LIVE_STAGES: readonly CaptureStage[] = ['building', 'preview', 'outcome-unknown', 'accepted', 'planned'];

/**
 * A capture belongs to the paired device it was made under: after "forget"
 * and a new pairing, the new credential never acts on the old capture's run
 * (Holdr would not show it another device's run either). The capture ends
 * here, unless a commit of it is still in flight; Holdr keeps what it
 * accepted for review there.
 */
async function replacedDevice(captureId: string): Promise<UiErrorCode> {
  // This pairing can never settle the capture's run, a commit that may still land included: Holdr shows what happened.
  await serialized(() => update(captureId, (current) => (!current.committing && LIVE_STAGES.includes(current.stage) ? { ...failed(current, 'device-replaced'), commitUncertain: false } : null)));
  return 'device-replaced';
}

/** A 401 wipes exactly the credential it was answered for (`token`), never one that replaced it meanwhile. */
async function unauthorizedOr(result: HoldrFailure, token: string): Promise<UiErrorCode> {
  if (result.status === 401) {
    await handleUnauthorized(token);
    return 'device-revoked';
  }
  return failureCode(result);
}

/** What Holdr is told when a stop ends a run (Q4). */
const ABORT_REASON: Readonly<Record<StopCause, RunAbortReason>> = Object.freeze({
  paused: 'user-cancelled',
  'issuer-disabled': 'user-cancelled',
  'shape-mode': 'user-cancelled',
  cancelled: 'user-cancelled',
  'permission-revoked': 'site-permission-revoked',
  'shape-changed': 'unknown-page-structure',
});

/** Captures whose run Holdr may still hold open, so a discard aborts it. */
const ABORTABLE_STAGES: readonly CaptureStage[] = ['preview', 'outcome-unknown', 'accepted', 'planned'];

/** Captures a receipt check applies to. */
const RECEIPT_STAGES: readonly CaptureStage[] = ['outcome-unknown', 'accepted', 'planned'];

/**
 * Tells Holdr why a run ends here, so its 「发送结果待核对」 can name the cause
 * (Q4). It carries no bank data, so it also goes after the run's issuer
 * stopped (that is when `site-permission-revoked` and `unknown-page-structure`
 * apply), but never while the kill switch is on: then nothing goes to Holdr,
 * and the run simply expires there. One attempt; only the kill switch aborts
 * it. Holdr keeps an observation it already accepted (the abort only cancels
 * its automatic path), and a receipt check still settles what it has. Only
 * the credential of the device that made the capture sends it (`deviceId`).
 */
async function abortRun(runId: string, reason: RunAbortReason, deviceId: string): Promise<boolean> {
  const signal = deviceSignal();
  if (pausePending() || (await readSettings()).paused) return false;
  const device = await activeDevice();
  if (!device.ok || device.device.deviceId !== deviceId || pausePending()) return false;
  const result = await holdr(signal).abort(device.device.token, runId, reason);
  if (!result.ok && result.status === 401) await handleUnauthorized(device.device.token);
  return result.ok;
}

/** A receipt that ends the capture's Holdr path, and what the user is told then; null while the set is open or nothing arrived. */
function finalReceipt(value: Receipt): { code: UiErrorCode | null } | null {
  if (value.ledger === 'committed') return { code: null };
  if (value.acceptance === 'rejected') return { code: 'holdr-rejected' };
  if (value.acceptance === 'expired-unreviewed') return { code: 'review-expired' };
  return null;
}

/**
 * A receipt applied to the stored capture. Committed, rejected (the owner
 * discarded the set; X13) and expired are final: the capture keeps no bytes
 * and no plan, and nothing is sent, planned or committed for it again.
 * Monotonic: Holdr's acceptance is durable, so an answer of "nothing
 * arrived" that was overtaken by a newer one never undoes a known acceptance.
 * "Nothing arrived" settles nothing while an upload that got no answer may
 * still arrive: unless Holdr had closed the run before the receipt was asked
 * for (`closedBeforeRequest`; a closure confirmed later does not make an
 * older answer current), such a capture without bytes stays checkable.
 */
export function withReceipt(current: CaptureRecord, runId: string, value: Receipt, closedBeforeRequest = false, requestedAt = Date.now()): CaptureRecord {
  const closed = { runId, text: null, expiresAt: null, previewId: null, planDigest: null, plan: null, ownerReview: null, commitUncertain: false } as const;
  if (value.ledger === 'committed') return { ...current, ...closed, stage: 'committed', committedAt: current.committedAt ?? new Date().toISOString(), error: null };
  if (value.acceptance === 'rejected') return { ...current, ...closed, stage: 'failed', observationSetId: value.observationSetId ?? current.observationSetId, error: 'holdr-rejected' };
  if (value.acceptance === 'expired-unreviewed') return { ...current, ...closed, stage: 'failed', error: 'review-expired' };
  if (value.acceptance === 'none') {
    if (current.stage === 'accepted' || current.stage === 'planned') return current;
    if (current.text === null && current.uploadUncertain && !closedBeforeRequest) return { ...current, runId, stage: 'outcome-unknown', error: 'upload-pending' };
    const back = expireIfDue({ ...current, runId, stage: current.text !== null ? 'preview' : 'expired' });
    return { ...back, error: null };
  }
  if (value.payloadDigest !== current.digest) return { ...current, runId, stage: 'failed', error: 'digest-mismatch', text: null, expiresAt: null };
  const accepted = {
    runId,
    text: null,
    expiresAt: null,
    observationSetId: value.observationSetId,
    acceptance: value.acceptance === 'needs-review' ? ('needs-review' as const) : ('accepted-uncommitted' as const),
    acceptedAt: value.acceptedAt,
    acceptExpiresAt: value.expiresAt,
  };
  if (current.stage === 'planned' && current.commitUncertain) {
    // Not committed yet, but a commit of the pinned plan may still land: until that plan had expired at Holdr (plans
    // are never extended, and an expired one is never committed) before this receipt was asked for, it stays pinned.
    const lapsed = current.plan !== null && Date.parse(current.plan.expiresAt) + target.timings.planSettleMarginMs <= requestedAt;
    if (!lapsed) return { ...current, ...accepted, stage: 'planned', error: 'commit-pending' };
    return { ...current, ...accepted, stage: 'accepted', previewId: null, planDigest: null, plan: null, commitUncertain: false, error: null };
  }
  return { ...current, ...accepted, stage: current.stage === 'planned' ? 'planned' : 'accepted', error: null };
}

/**
 * Applies a receipt to the capture (if it is still this one, in a stage
 * `when` accepts) and keeps the recent-runs list in step with a rejection. A
 * final answer also ends a commit that is still retrying for this capture:
 * nothing is dispatched for a set Holdr closed. That latch is set before any
 * await, so no commit attempt slips out while the new state is being stored.
 */
async function applyReceipt(
  captureId: string,
  runId: string,
  value: Receipt,
  when: (current: CaptureRecord) => boolean = () => true,
  options: { dropBytes?: boolean; runClosed?: boolean; closedBeforeRequest?: boolean; requestedAt?: number } = {},
): Promise<CaptureRecord | null> {
  const final = finalReceipt(value);
  if (final) settledCaptures.set(captureId, final.code);
  const done = await serialized(() =>
    update(captureId, (current) => {
      if (!when(current)) return null;
      const base = {
        ...current,
        ...(options.dropBytes ? { text: null, expiresAt: null } : {}),
        runClosed: current.runClosed || options.runClosed === true,
      };
      const next = withReceipt(base, runId, value, options.closedBeforeRequest === true, options.requestedAt ?? Date.now());
      // Also an end the receipt alone does not show (its digest is not this capture's): set before the write.
      if (current.committing && (next.stage === 'failed' || next.stage === 'committed')) cancelCommit(captureId);
      return next;
    }),
  );
  if (done && done.error === 'holdr-rejected' && done.observationSetId) {
    await pushLastRun({ captureId, adapterId: done.adapterId, bindingLabel: done.bindingLabel, rows: done.rows, digest: done.digest ?? '', observationSetId: done.observationSetId, status: 'rejected', at: new Date().toISOString() });
  }
  return done;
}

/** Refusals that mean this run or its set can never take these bytes again. */
const CLOSED_REFUSALS: readonly HoldrErrorCode[] = ['set-closed', 'observation-expired', 'run-closed', 'run-expired'];

/**
 * A commit refused because the set changed under its plan (E2c: the owner committed or discarded it in Holdr, an abort
 * or revocation cancelled the plan): the receipt says whether the set is closed now, before the capture plans again.
 */
const STALE_PLAN_REFUSALS: readonly HoldrErrorCode[] = ['preview-stale', 'plan-mismatch'];

/** An upload's acknowledgement that is final (M7: a replay answers the set as it is now), as the receipt that says the same. */
const FINAL_ACKS: readonly ObservationAccepted['status'][] = ['committed', 'rejected', 'expired-unreviewed'];

function ackReceipt(ack: ObservationAccepted): Receipt {
  return {
    runId: ack.runId,
    observationSetId: ack.observationSetId,
    // E2c's receipt reads a committed set as accepted with its ledger committed.
    acceptance: ack.status === 'committed' ? 'accepted-uncommitted' : (ack.status as Receipt['acceptance']),
    ledger: ack.status === 'committed' ? 'committed' : 'none',
    payloadDigest: ack.payloadDigest,
    acceptedAt: ack.acceptedAt,
    expiresAt: ack.expiresAt,
  };
}

/**
 * Cancels of a capture's commit attempts, counted (this worker life). A Close
 * counts one the moment it arrives, before it waits for anything, and so does
 * a receipt that ends a committing capture. A commit compares the count with
 * the one it saw when it began: any newer cancel stops its further attempts.
 * After a Close the plan stays, so a receipt check can settle whether an
 * attempt already dispatched landed.
 */
const commitCancels = new Map<string, number>();
const CANCELLED: Halt = { code: 'stopped', cause: 'cancelled' };

function cancelCount(captureId: string): number {
  return commitCancels.get(captureId) ?? 0;
}

function cancelCommit(captureId: string): void {
  commitCancels.set(captureId, cancelCount(captureId) + 1);
}

/**
 * Captures whose run got a final answer from Holdr (committed, rejected,
 * review expired) in this worker life, with what the user is told: nothing is
 * sent, planned or committed for them again. Set before the answer is stored;
 * never cleared (after a restart the stored stage says the same).
 */
const settledCaptures = new Map<string, UiErrorCode | null>();

/** Checked synchronously right before every commit dispatch, with no await in between. */
function commitHeld(captureId: string, cancelsAtStart: number): boolean {
  return cancelCount(captureId) !== cancelsAtStart || settledCaptures.has(captureId);
}

/** Stages a final receipt for the capture's own run ends (a discarded or already final capture stays as it is). */
const SETTLE_STAGES: readonly CaptureStage[] = ['preview', 'sending', 'outcome-unknown', 'accepted', 'planned'];

/**
 * Definite refusals that Holdr lifts by itself without closing the run, or
 * that came before any run existed: Holdr's own pause, an issuer it switched
 * off (E2c records neither on the run), its limits on open runs and runs per
 * day (run creation), a rate limit. The frozen bytes stay until they expire,
 * to be sent once Holdr allows it. After any other definite refusal Holdr has
 * closed the run (E2c records the refusal on it: an invalid or mismatched
 * payload, a stale binding, a scope outside it, a quota), or the bytes can
 * never fit it again (a binding retired or awaiting re-confirmation, a
 * revoked device), so they go.
 */
const KEEPS_RUN_OPEN: readonly HoldrErrorCode[] = ['sync-paused', 'sync-disabled', 'too-many-open-runs', 'run-rate-limited', 'rate-limited'];

function keepsPreview(failure: HoldrFailure): boolean {
  return failure.status !== 401 && failure.code !== null && KEEPS_RUN_OPEN.includes(failure.code);
}

/**
 * Holdr refused a plan or commit because the set or run is closed (or its
 * review expired): its receipt says how, and the capture follows it, if it is
 * still where the refused step began (`when`). Anything else leaves the
 * capture as it was, with the refusal shown.
 */
async function settleClosed(
  job: IssuerWork,
  token: string,
  captureId: string,
  runId: string,
  refusal: HoldrFailure,
  when: (current: CaptureRecord) => boolean,
): Promise<UiErrorCode | null> {
  const halted = await stillAllowed(job);
  const final = halted ? null : await finalFromReceipt(job, token, captureId, runId, when);
  if (final) return final.code;
  const code = halted ? halted.code : await unauthorizedOr(refusal, token);
  await serialized(() => update(captureId, (current) => (when(current) ? { ...current, error: code, holdrError: refusal.code } : null)));
  return code;
}

/** Asks Holdr's receipt for the run; a final one (committed, rejected, review expired) is applied and returned, else null. */
async function finalFromReceipt(
  job: IssuerWork,
  token: string,
  captureId: string,
  runId: string,
  when: (current: CaptureRecord) => boolean,
): Promise<{ code: UiErrorCode | null } | null> {
  const receipt = await holdr(job.signal).receipt(token, runId);
  if (!receipt.ok) return null;
  const final = finalReceipt(receipt.value);
  if (!final) return null;
  await applyReceipt(captureId, runId, receipt.value, when);
  return final;
}

type HaltCheck = () => Promise<Halt | null>;

/** Creates (or, after a lost response, finds again: same clientRunId) the run for a capture. `halt` is checked before every attempt. */
async function ensureRun(
  token: string,
  capture: CaptureRecord,
  halt: HaltCheck,
  signal: AbortSignal,
): Promise<{ ok: true; runId: string } | { ok: false; failure: HoldrFailure } | { ok: false; stopped: Halt }> {
  if (capture.runId) return { ok: true, runId: capture.runId };
  const adapter = adapterById(capture.adapterId);
  const request = {
    clientRunId: capture.clientRunId,
    bindingId: capture.bindingId,
    bindingVersion: capture.bindingVersion,
    adapterVersion: adapter?.parserVersion ?? 'unknown',
    contractVersion: CARD_SYNC_CONTRACT_VERSION,
    trigger: 'manual' as const,
  };
  let last: HoldrFailure | null = null;
  for (let attempt = 0; attempt <= target.timings.holdrRetryDelaysMs.length; attempt += 1) {
    const stopped = await halt();
    if (stopped) return { ok: false, stopped };
    const result = await holdr(signal).createRun(token, request);
    if (result.ok) return { ok: true, runId: result.value.runId };
    if (result.kind === 'aborted') return { ok: false, stopped: (await halt()) ?? STOPPED };
    last = result;
    if (!unknownOutcome(result) || attempt === target.timings.holdrRetryDelaysMs.length) break;
    await sleep(target.timings.holdrRetryDelaysMs[attempt]);
  }
  return { ok: false, failure: last! };
}

/** Sends exactly the frozen bytes, if the popup confirmed exactly those bytes. */
export async function sendCapture(captureId: string, digest: string): Promise<UiErrorCode | null> {
  // Before any await: a stop from here on ends this send.
  const work = beginWork();
  // Phase 1: checks and the move to `sending`, serialized with every other state change.
  const start = await serialized(async (): Promise<{ ok: true; capture: CaptureRecord; token: string; job: IssuerWork } | { ok: false; code: UiErrorCode }> => {
    const settings = await readSettings();
    if (settings.paused) return { ok: false, code: 'paused' };
    const stored = await readSession('capture');
    if (!stored || stored.captureId !== captureId) return { ok: false, code: 'no-capture' };
    const capture = expireIfDue(stored);
    if (capture !== stored) {
      await writeSession('capture', capture);
      // Expired unsent; or, if an earlier upload may still be stored, left to a receipt check.
      return { ok: false, code: capture.stage === 'expired' ? 'capture-expired' : 'wrong-stage' };
    }
    if (capture.stage !== 'preview' || capture.text === null || capture.digest === null) return { ok: false, code: 'wrong-stage' };
    if (capture.digest !== digest) return { ok: false, code: 'digest-mismatch' };
    // Holdr's answer for this run is final already (its storing may still be under way): never sent again.
    if (settledCaptures.has(captureId)) return { ok: false, code: settledCaptures.get(captureId) ?? 'wrong-stage' };
    const adapter = adapterById(capture.adapterId);
    if (!adapter || !(await isAdapterActive(adapter, settings))) return { ok: false, code: 'issuer-not-enabled' };
    const device = await activeDevice();
    if (!device.ok) return { ok: false, code: device.code };
    if (device.device.deviceId !== capture.deviceId) {
      // Made under an earlier pairing: never sent with another device's credential (see `replacedDevice`).
      await writeSession('capture', failed(capture, 'device-replaced'));
      return { ok: false, code: 'device-replaced' };
    }
    const capabilities = await readSession('capabilities');
    const binding = capabilities?.bindings.find((item) => item.bindingId === capture.bindingId);
    if (!capabilities || !capabilities.syncEnabled) return { ok: false, code: 'sync-disabled' };
    if (!acceptsFormat(capabilities)) return { ok: false, code: 'holdr-incompatible' };
    if (!binding || binding.bindingVersion !== capture.bindingVersion) return { ok: false, code: 'unknown-binding' };
    const job = forIssuer(work, capture.adapterId);
    const halted = held(job);
    if (halted) return { ok: false, code: halted.code };
    const sending: CaptureRecord = { ...capture, stage: 'sending', error: null, holdrError: null };
    await writeSession('capture', sending);
    return { ok: true, capture: sending, token: device.device.token, job };
  });
  if (!start.ok) return start.code;
  const { capture, token, job } = start;
  const halt: HaltCheck = () => stillAllowed(job);

  // Phase 2: network, outside the lock so a stop is never queued behind it. Every request and retry checks for a stop first.
  const run = await ensureRun(token, capture, halt, job.signal);
  if (!run.ok) {
    if ('stopped' in run) {
      const code = run.stopped.code;
      // No observation request was made: nothing of the payload left. A stop already dropped the bytes; make sure.
      await serialized(() => update(captureId, (current) => (current.stage === 'sending' || current.stage === 'outcome-unknown' ? { ...current, stage: 'discarded', text: null, expiresAt: null, error: code } : null)));
      return code;
    }
    const code = await unauthorizedOr(run.failure, token);
    const failure = run.failure;
    await serialized(() => update(captureId, (current) => {
      if (current.stage !== 'sending') return null;
      if (unknownOutcome(failure) || failure.kind === 'aborted') return { ...current, stage: 'outcome-unknown', error: code };
      // Holdr refused to start a run: nothing of the payload left. Only a refusal that Holdr lifts by itself keeps the frozen bytes.
      return keepsPreview(failure) ? { ...current, stage: 'preview', error: code, holdrError: failure.code } : failed(current, code, failure);
    }));
    return code;
  }
  await serialized(() => update(captureId, (current) => (current.stage === 'sending' || current.stage === 'outcome-unknown' ? { ...current, runId: run.runId } : null)));

  let accepted: { observationSetId: string; status: 'accepted-uncommitted' | 'needs-review'; acceptedAt: string; expiresAt: string } | null = null;
  let final: Receipt | null = null;
  let finalFailure: HoldrFailure | null = null;
  let mismatch = false;
  let stopped: Halt | null = null;
  let attempted = false;
  // A final answer from Holdr arrived meanwhile (another receipt check): it is the outcome, and nothing more is sent.
  let settled = false;
  // An upload whose answer never came, in this send or an earlier one, may have been stored: a later refusal alone
  // then proves nothing. Kept with the capture (`uploadUncertain`) across sends, receipt checks and restarts.
  let ambiguous = capture.uploadUncertain;
  for (let attempt = 0; attempt <= target.timings.holdrRetryDelaysMs.length; attempt += 1) {
    stopped = await halt();
    if (stopped) break;
    // Synchronous with the dispatch below.
    if (settledCaptures.has(captureId)) {
      settled = true;
      break;
    }
    attempted = true;
    const answer = await holdr(job.signal).submitObservation(token, run.runId, capture.text!, capture.clientRunId);
    // A success answer that contradicts the request (another run, other bytes) proves nothing either way, like an
    // unreadable one: the receipt decides.
    const result: HoldrResult<ObservationAccepted> = answer.ok && (answer.value.payloadDigest !== capture.digest || answer.value.runId !== run.runId)
      ? { ok: false, kind: 'protocol', status: answer.status, code: null, issues: [] }
      : answer;
    if (result.ok) {
      const ack = result.value;
      // A replay of an accepted upload answers the set as it is now (M7): a final state is the outcome, as its receipt
      // would be, and nothing is sent again.
      if (FINAL_ACKS.includes(ack.status)) final = ackReceipt(ack);
      else accepted = { observationSetId: ack.observationSetId, status: ack.status === 'needs-review' ? 'needs-review' : 'accepted-uncommitted', acceptedAt: ack.acceptedAt, expiresAt: ack.expiresAt };
      break;
    }
    finalFailure = result;
    if (result.kind === 'aborted') {
      ambiguous = true;
      stopped = (await halt()) ?? STOPPED;
      break;
    }
    if (!unknownOutcome(result)) break;
    ambiguous = true;
    // The outcome is unknown: Holdr may have stored it. Ask before sending again.
    stopped = await halt();
    if (stopped) break;
    const receipt = await holdr(job.signal).receipt(token, run.runId);
    if (receipt.ok && (receipt.value.acceptance !== 'none' || receipt.value.ledger === 'committed')) {
      // Rejected or expired already: final, never sent again.
      if (finalReceipt(receipt.value)) final = receipt.value;
      else if (receipt.value.payloadDigest !== capture.digest || receipt.value.observationSetId === null) mismatch = true;
      else accepted = {
        observationSetId: receipt.value.observationSetId,
        status: receipt.value.acceptance === 'needs-review' ? 'needs-review' : 'accepted-uncommitted',
        acceptedAt: receipt.value.acceptedAt ?? new Date().toISOString(),
        expiresAt: receipt.value.expiresAt ?? new Date().toISOString(),
      };
      break;
    }
    // A stop during the receipt request (or since) ends the send here, on the last attempt too, with its reason.
    stopped = await halt();
    if (stopped) break;
    if (attempt === target.timings.holdrRetryDelaysMs.length) break;
    await sleep(target.timings.holdrRetryDelaysMs[attempt]);
  }

  const inFlight = (current: CaptureRecord) => current.stage === 'sending' || current.stage === 'outcome-unknown';
  const uncertain = (current: CaptureRecord) => current.uploadUncertain || ambiguous;
  // A stop ends the send: the bytes go. If an upload may have reached Holdr (now or earlier) the outcome stays
  // checkable, and the run exists, so Holdr hears why it ends here (Q4).
  const endStopped = async (halted: Halt): Promise<UiErrorCode> => {
    await serialized(() =>
      update(captureId, (current) => (inFlight(current)
        ? { ...current, stage: attempted || uncertain(current) ? 'outcome-unknown' : 'discarded', text: null, expiresAt: null, error: halted.code, uploadUncertain: uncertain(current) }
        : null)),
    );
    // Acknowledged: the run takes nothing more, so a later "nothing arrived" is final.
    if (await abortRun(run.runId, ABORT_REASON[halted.cause], capture.deviceId)) {
      await serialized(() => update(captureId, (current) => (current.runId === run.runId && !current.runClosed ? { ...current, runClosed: true } : null)));
    }
    return halted.code;
  };
  // Phase 3: apply the outcome, unless something else (kill switch, discard) already moved the capture on.
  // A final answer that arrived meanwhile is stored by its own check (it ends a sending capture too).
  if (settled) return settledCaptures.get(captureId) ?? null;
  if (accepted) {
    const result = accepted;
    const done = await serialized(() =>
      update(captureId, (current) => (inFlight(current)
        ? { ...current, stage: 'accepted', text: null, expiresAt: null, observationSetId: result.observationSetId, acceptance: result.status, acceptedAt: result.acceptedAt, acceptExpiresAt: result.expiresAt, error: null, holdrError: null }
        : null)),
    );
    if (done) {
      await pushLastRun({ captureId, adapterId: done.adapterId, bindingLabel: done.bindingLabel, rows: done.rows, digest: done.digest ?? '', observationSetId: result.observationSetId, status: result.status, at: new Date().toISOString() });
    }
    return null;
  }
  if (final) {
    const value = final;
    await applyReceipt(captureId, run.runId, value, inFlight);
    return finalReceipt(value)?.code ?? null;
  }
  if (mismatch) {
    await serialized(() => update(captureId, (current) => (inFlight(current) ? { ...current, stage: 'failed', error: 'digest-mismatch', text: null, expiresAt: null } : null)));
    return 'digest-mismatch';
  }
  if (stopped) return endStopped(stopped);
  const failure = finalFailure!;
  const code = await unauthorizedOr(failure, token);
  const unknown = unknownOutcome(failure) || failure.kind === 'aborted';
  const closedRun = failure.code !== null && CLOSED_REFUSALS.includes(failure.code);
  if (!unknown && (closedRun || ambiguous)) {
    // The run or set is closed, or an upload may have been stored: what Holdr has decides, never this refusal alone.
    // Its bytes go unless this run can still take them. A stop meanwhile ends the send like any other stop.
    let receipt: HoldrResult<Receipt> | null = null;
    if (failure.status !== 401) {
      const settleHalt = await halt();
      if (settleHalt) return endStopped(settleHalt);
      receipt = await holdr(job.signal).receipt(token, run.runId);
      if (!receipt.ok && receipt.kind === 'aborted') return endStopped((await halt()) ?? STOPPED);
    }
    const arrived = receipt !== null && receipt.ok && (receipt.value.acceptance !== 'none' || receipt.value.ledger === 'committed');
    if (receipt && receipt.ok && (arrived || closedRun)) {
      // The refusal that closed the run came before this receipt was asked for: its "nothing arrived" is final.
      const done = await applyReceipt(captureId, run.runId, receipt.value, inFlight, { dropBytes: true, runClosed: closedRun, closedBeforeRequest: closedRun || capture.runClosed });
      return !done || done.stage === 'expired' ? code : done.error;
    }
    if (!receipt || !receipt.ok) {
      // Not settled: kept checkable.
      const keep = keepsPreview(failure);
      await serialized(() => update(captureId, (current) => (inFlight(current) ? { ...current, stage: 'outcome-unknown', ...(keep ? {} : { text: null, expiresAt: null }), error: code, holdrError: failure.code, uploadUncertain: uncertain(current) } : null)));
      return code;
    }
    // Nothing arrived and the run is open: this refusal is the outcome, as below. A refusal that closed the run means
    // nothing can arrive any more; one that keeps it open keeps the bytes and the uncertainty.
  }
  await serialized(() =>
    update(captureId, (current) => {
      if (current.stage !== 'sending') return null;
      if (unknown) return { ...current, stage: 'outcome-unknown', error: code, holdrError: failure.code, uploadUncertain: uncertain(current) };
      // A definite refusal stored nothing. Holdr closes the run on most of them (E1b: a refused run, or a revoked
      // device's run, never takes an upload again), so the bytes go; only a refusal it lifts by itself keeps them.
      if (keepsPreview(failure)) return { ...current, stage: 'preview', error: code, holdrError: failure.code, issues: failure.issues, uploadUncertain: uncertain(current) };
      return failed(current, code, failure, failure.issues);
    }),
  );
  return code;
}
/** After an unknown outcome or a worker restart: ask Holdr what it has for this capture's run. Not while paused; a disabled issuer may still ask. */
export async function checkReceipt(captureId: string): Promise<UiErrorCode | null> {
  const work = beginWork();
  if ((await readSettings()).paused) return 'paused';
  const capture = await readSession('capture');
  if (!capture || capture.captureId !== captureId) return 'no-capture';
  if (!RECEIPT_STAGES.includes(capture.stage)) return 'wrong-stage';
  const job = forIssuer(work, capture.adapterId, false);
  const halt: HaltCheck = () => stillAllowed(job);
  const outcome = await withDevice(capture, async (token) => {
    const run = await ensureRun(token, capture, halt, job.signal);
    if (!run.ok) return 'stopped' in run ? run.stopped.code : unauthorizedOr(run.failure, token);
    const halted = await halt();
    if (halted) return halted.code;
    // What the answer may settle is judged as of now, when it is asked for (not when it is stored).
    const requestedAt = Date.now();
    const receipt = await holdr(job.signal).receipt(token, run.runId);
    if (!receipt.ok) return receipt.kind === 'aborted' ? ((await halt()) ?? STOPPED).code : unauthorizedOr(receipt, token);
    // The capture shows the outcome unless it moved on meanwhile. A final one (committed, rejected, review expired) ends
    // the capture in any live stage of this run, a preview that another check restored included; "nothing arrived" is
    // final only if Holdr had closed the run before this check began.
    const stages = finalReceipt(receipt.value) ? SETTLE_STAGES : RECEIPT_STAGES;
    await applyReceipt(captureId, run.runId, receipt.value, (current) => stages.includes(current.stage) && (current.runId === null || current.runId === run.runId), {
      closedBeforeRequest: capture.runClosed,
      requestedAt,
    });
    return null;
  });
  return outcome;
}

export async function planCapture(captureId: string): Promise<UiErrorCode | null> {
  const work = beginWork();
  const capture = await readSession('capture');
  if (!capture || capture.captureId !== captureId) return 'no-capture';
  if ((capture.stage !== 'accepted' && capture.stage !== 'planned') || !capture.runId || !capture.observationSetId) return 'wrong-stage';
  // The plan a commit in flight (or one that may still land) is pinned to is never replaced.
  if (capture.committing || capture.commitUncertain) return 'busy';
  const job = forIssuer(work, capture.adapterId);
  // Results apply only while the capture is still where this plan began (and no commit started meanwhile): a discard or a final receipt wins.
  const open = (current: CaptureRecord) => (current.stage === 'accepted' || current.stage === 'planned') && !current.committing && !current.commitUncertain && current.runId === capture.runId && current.observationSetId === capture.observationSetId;
  const blocked = await stillAllowed(job);
  if (blocked) return blocked.code;
  return withDevice(capture, async (token) => {
    const late = held(job);
    if (late) return late.code;
    // Synchronous with the dispatch below: a final answer for this run means nothing is planned again.
    if (settledCaptures.has(captureId)) return settledCaptures.get(captureId) ?? null;
    const result = await holdr(job.signal).preparePlan(token, capture.runId!, capture.observationSetId!);
    if (!result.ok) {
      // A closed set (rejected, review expired, committed): the receipt says which, and nothing is planned again.
      if (result.code !== null && CLOSED_REFUSALS.includes(result.code)) return settleClosed(job, token, captureId, capture.runId!, result, open);
      const code = result.kind === 'aborted' ? ((await stillAllowed(job)) ?? STOPPED).code : await unauthorizedOr(result, token);
      await serialized(() => update(captureId, (current) => (open(current) ? { ...current, error: code, holdrError: result.code } : null)));
      return code;
    }
    const plan = result.value;
    if (plan.status === 'owner-review') {
      // The owner decides in Holdr (X24): no plan to commit here. A receipt check later shows what the owner did.
      if (plan.observationSetId !== capture.observationSetId) return 'holdr-protocol';
      const halted = await stillAllowed(job);
      if (halted) return halted.code;
      const review = { reviewCount: plan.reviewCount, counts: plan.counts };
      const done = await serialized(() =>
        update(captureId, (current) => (open(current)
          ? { ...current, stage: 'accepted', previewId: null, planDigest: null, plan: null, ownerReview: review, error: null, holdrError: null }
          : null)),
      );
      return done ? null : 'wrong-stage';
    }
    if (plan.payloadDigest !== capture.digest) return 'digest-mismatch';
    // A plan that came back after a stop is not offered for commit.
    const halted = await stillAllowed(job);
    if (halted) return halted.code;
    const done = await serialized(() =>
      update(captureId, (current) => (open(current)
        ? {
            ...current,
            stage: 'planned',
            previewId: plan.previewId,
            planDigest: plan.planDigest,
            plan: { counts: plan.counts, expiresAt: plan.expiresAt },
            ownerReview: null,
            error: null,
            holdrError: null,
          }
        : null)),
    );
    return done ? null : 'wrong-stage';
  });
}

export async function commitCapture(captureId: string, previewId: string, planDigest: string): Promise<UiErrorCode | null> {
  const work = beginWork();
  // Before any await: a Close from here on cancels this commit's further attempts.
  const cancelsAtStart = cancelCount(captureId);
  const capture = await readSession('capture');
  if (!capture || capture.captureId !== captureId) return 'no-capture';
  if (capture.stage !== 'planned' || capture.previewId !== previewId || capture.planDigest !== planDigest || !capture.runId || !capture.digest) return 'wrong-stage';
  if (capture.committing) return 'busy';
  const job = forIssuer(work, capture.adapterId);
  // A discard while this commit runs, or a final receipt applied meanwhile, cancels its further attempts: checked with
  // the gate, and once more synchronously right before each dispatch.
  const halt: HaltCheck = async () => (await stillAllowed(job)) ?? (commitHeld(captureId, cancelsAtStart) ? CANCELLED : null);
  // Results apply only while the capture still holds this plan: a final receipt meanwhile wins.
  const open = (current: CaptureRecord) => current.stage === 'planned' && current.previewId === previewId && current.planDigest === planDigest;
  const blocked = await halt();
  if (blocked) return blocked.code;
  // After a stop the commit may or may not have happened: the plan stays, and a receipt check settles it.
  const stop = async (code: UiErrorCode) => {
    await serialized(() => update(captureId, (current) => (open(current) ? { ...current, error: code } : null)));
    return code;
  };
  // The credential is read, and the marker taken, in one serialized step: a Forget or a new pairing that came first
  // refuses this commit before anything goes out; one that comes later sees the marker and is refused itself. Until the
  // commit ends, a discard cannot hide whether it landed.
  let refusal: UiErrorCode = 'wrong-stage';
  let token = '';
  const marked = await serialized(async () => {
    const device = await activeDevice();
    if (!device.ok) {
      refusal = device.code;
      return null;
    }
    if (device.device.deviceId !== capture.deviceId) {
      // Made under an earlier pairing: never committed with another device's credential (as in `replacedDevice`).
      refusal = 'device-replaced';
      await update(captureId, (current) => (!current.committing && LIVE_STAGES.includes(current.stage) ? { ...failed(current, 'device-replaced'), commitUncertain: false } : null));
      return null;
    }
    token = device.device.token;
    return update(captureId, (current) => {
      if (!open(current)) return null;
      if (current.committing) {
        refusal = 'busy';
        return null;
      }
      return { ...current, committing: true };
    });
  });
  if (!marked) return refusal;
  // Whether a commit of this plan may have gone out without Holdr's answer (now, or in an earlier command), as stored
  // when this commit took the marker: never an older snapshot, which a commit that ran meanwhile may have outdated.
  let unsettled = marked.commitUncertain;
  // Every exit below awaits its own settling before `finally` clears the marker: until the outcome is stored, the
  // capture cannot be replaced or planned again.
  try {
    const request = { runId: capture.runId!, previewId, payloadDigest: capture.digest!, planDigest };
    for (let attempt = 0; attempt <= target.timings.holdrRetryDelaysMs.length; attempt += 1) {
      const before = await halt();
      if (before) return await stop(before.code);
      // Synchronous with the dispatch below: a cancel or a final receipt since the check above still prevents it.
      if (commitHeld(captureId, cancelsAtStart)) return await stop(CANCELLED.code);
      // Bound to the work's signal: a stop at any point since the work began aborts this before it is dispatched.
      const result = await holdr(job.signal).commit(token, request);
      if (result.ok) {
        await serialized(() => update(captureId, (current) => (open(current) ? { ...current, stage: 'committed', committedAt: result.value.committedAt, error: null, holdrError: null } : null)));
        await pushLastRun({ captureId, adapterId: capture.adapterId, bindingLabel: capture.bindingLabel, rows: capture.rows, digest: capture.digest ?? '', observationSetId: capture.observationSetId ?? '', status: 'committed', at: result.value.committedAt });
        return null;
      }
      if (result.kind === 'aborted') {
        unsettled = true;
        return await stop(((await halt()) ?? STOPPED).code);
      }
      if (result.code !== null && CLOSED_REFUSALS.includes(result.code)) return await settleClosed(job, token, captureId, capture.runId!, result, open);
      // The set changed under this plan: if Holdr closed it meanwhile (the owner committed or discarded it), its
      // receipt is the outcome; otherwise the capture plans again below.
      if (result.code !== null && STALE_PLAN_REFUSALS.includes(result.code) && !(await halt())) {
        const final = await finalFromReceipt(job, token, captureId, capture.runId!, open);
        if (final) return final.code;
      }
      if (!unknownOutcome(result)) {
        const code = await unauthorizedOr(result, token);
        await serialized(() =>
          update(captureId, (current) => {
            if (!open(current)) return null;
            // An earlier commit of this plan may still land: this refusal alone proves nothing, so the plan stays pinned.
            if (unsettled || current.commitUncertain) return { ...current, error: code, holdrError: result.code };
            // An expired or stale plan is not a failure of the observation: plan again against the current ledger.
            return { ...current, stage: 'accepted', previewId: null, planDigest: null, plan: null, error: code, holdrError: result.code };
          }),
        );
        return code;
      }
      unsettled = true;
      const between = await halt();
      if (between) return await stop(between.code);
      const receipt = await holdr(job.signal).receipt(token, capture.runId!);
      if (receipt.ok && receipt.value.ledger === 'committed') {
        await serialized(() => update(captureId, (current) => (open(current) ? { ...current, stage: 'committed', committedAt: new Date().toISOString(), error: null } : null)));
        return null;
      }
      // Rejected or expired meanwhile: final, never committed or retried.
      if (receipt.ok && finalReceipt(receipt.value)) {
        await applyReceipt(captureId, capture.runId!, receipt.value, open);
        return finalReceipt(receipt.value)?.code ?? null;
      }
      // A stop during the receipt request (or since) ends the commit here, on the last attempt too.
      const after = await halt();
      if (after) return await stop(after.code);
      if (attempt < target.timings.holdrRetryDelaysMs.length) await sleep(target.timings.holdrRetryDelaysMs[attempt]);
    }
    await serialized(() => update(captureId, (current) => (open(current) ? { ...current, error: 'holdr-unreachable' } : null)));
    return 'holdr-unreachable';
  } finally {
    // The marker goes in one write with what is still uncertain: if this plan is still pinned and a commit of it may
    // still land, it stays pinned (`commitUncertain`) until Holdr's answer settles it. A Close queued behind this write
    // sees either the marker or that uncertainty, and keeps the plan.
    await serialized(() => update(captureId, (current) => ({ ...current, committing: false, commitUncertain: open(current) && (current.commitUncertain || unsettled) })));
  }
}

export async function discardCapture(captureId: string): Promise<UiErrorCode | null> {
  // Before any await: whatever holds the worker's queue, a commit of this capture makes no further attempt from now on.
  cancelCommit(captureId);
  const capture = await readSession('capture');
  if (!capture || capture.captureId !== captureId) return 'no-capture';
  let before: CaptureRecord | null = null as CaptureRecord | null;
  let refusal: UiErrorCode = 'wrong-stage';
  // A send in flight finishes first. A commit in flight may land: it is cancelled (above), not discarded, and the plan stays.
  const discarded = await serialized(() =>
    update(captureId, (current) => {
      if (current.stage === 'sending') return null;
      if (current.committing) {
        refusal = 'stopped';
        return null;
      }
      // A commit of the pinned plan may still land: Close waits until Holdr's answer settles it.
      if (current.commitUncertain) {
        refusal = 'commit-pending';
        return null;
      }
      before = current;
      return { ...current, stage: 'discarded', text: null, expiresAt: null };
    }),
  );
  if (!discarded || !before) return refusal;
  const previous: CaptureRecord = before;
  // Holdr keeps an observation it accepted for review; the abort only ends the run's automatic path and tells Holdr the user cancelled (Q4).
  if (previous.runId && ABORTABLE_STAGES.includes(previous.stage)) await abortRun(previous.runId, 'user-cancelled', previous.deviceId);
  if (previous.stage === 'building' || previous.stage === 'preview') {
    const doc = await findDoc(capture.docRef);
    if (doc) {
      await sendToCollector(doc, {
        type: 'collector-config/v1',
        action: 'release',
        captureId: capture.captureId,
        accountRef: capture.accountRef,
        bindingId: null,
        bindingVersion: null,
        scopes: [],
        confirmedScopes: [],
        cards: [],
        window: null,
        budget: null,
      });
    }
  }
  return null;
}

/**
 * On worker start: a send that was in flight has an unknown outcome (and an
 * upload of it may still be stored once its run exists); frozen bytes past
 * their TTL are dropped; a commit that was in flight may have landed, so its
 * plan stays pinned (`commitUncertain`) until Holdr's answer settles it.
 */
export async function recoverCapture(): Promise<void> {
  const capture = await readSession('capture');
  if (!capture) return;
  const settled = capture.committing
    ? { ...capture, committing: false, commitUncertain: capture.stage === 'planned', error: capture.stage === 'planned' ? ('stopped' as const) : capture.error }
    : capture;
  const next = expireIfDue(settled.stage === 'sending' ? { ...settled, stage: 'outcome-unknown', uploadUncertain: settled.uploadUncertain || settled.runId !== null } : settled);
  if (next !== capture) await writeSession('capture', next);
}

/**
 * Drops frozen bytes past their TTL from the capture stored now, never from
 * an earlier snapshot (a state poll must not overwrite what a receipt or a
 * discard wrote meanwhile).
 */
export function expireStoredCapture(): Promise<void> {
  return serialized(async () => {
    const current = await readSession('capture');
    if (!current) return;
    const next = expireIfDue(current);
    if (next !== current) await writeSession('capture', next);
  });
}
