/**
 * A synthetic Holdr for the extension e2e (tests only, loopback only). It
 * answers the device routes as Holdr's E2c does (`apps/api/src/routes/cardSync/`,
 * `apps/api/src/routes/cardSync/device*.ts` and the repository rules behind
 * them), as far as a device can observe: the same checks in the same order,
 * the same codes with the same statuses, the same bodies. Where the
 * extension's behaviour depends on it:
 *
 * - every device request names the client (`X-Holdr-Client: extension-v1`)
 *   and carries `X-Holdr-Client-Version` equal to the version the device was
 *   paired with, or it is 401 (M1); no Cookie, ever (401); `HoldrDevice` only,
 *   `HoldrPair` only at redeem; CORS only for the test extension's origin
 *   (E2c pins the production id; this fake serves the test build);
 * - capabilities name Holdr's own origin (`holdrOrigin`, M2), every issuer
 *   switch, and only the bindings granted to this device at their current
 *   version (none while it is pending); `syncEnabled` is off while Holdr is
 *   paused;
 * - one authorization predicate (E1b row 15) at run creation, upload, prepare
 *   and commit, never at receipts or aborts: Holdr's pause (409
 *   `sync-paused`), an issuer switched off (409 `sync-disabled`), a retired or
 *   unconfirmed binding, a grant not at the binding's current version (409
 *   `binding-stale`; a re-confirmation re-grants no device unless asked, Q35);
 * - runs: idempotent on the client run id, at most two open per device (429
 *   `too-many-open-runs`) and 50 a day (429 `run-rate-limited`), a 600 s
 *   upload window (410 `run-expired`);
 * - uploads: the exact canonical envelope (else 400 `payload-digest-mismatch`),
 *   E1a validation (422 `payload-invalid` with its issues), scopes of the
 *   binding only (422 `scope-not-in-binding`), one acceptance per capture
 *   (409 `capture-already-accepted`); a refusal of those kinds, and
 *   `binding-stale`, is recorded on the run, which closes it, while the
 *   authorization refusals leave it open; a replay of an accepted upload
 *   answers the set as it is now, `committed`, `rejected` and
 *   `expired-unreviewed` included (M7);
 * - prepare: a closed set is 409 `set-closed`; `owner-review` unless the
 *   device may commit the set itself (contract 1 closes every admission:
 *   `admissionsOpen` opens them for the device-commit tests); at most two
 *   held plans per device (429 `plan-quota-exceeded`);
 * - commit: the device's own run (404 `run-not-found`) and plan (404
 *   `not-found`); a plan whose set changed meanwhile (the owner committed or
 *   discarded it, an abort or revocation cancelled it) is 409 `preview-stale`;
 *   an expired one 410 `plan-expired`; the same plan replays its result;
 * - receipts as E2c reads them (blocked and recovery reviews as
 *   `needs-review`, a committed set as accepted with its ledger committed);
 * - aborts: a fixed reason (else 422 `bad-request`); an open run closes, an
 *   accepted one keeps its set and loses its plans, the same reason again is
 *   a repeat, any other on a closed run 409 `run-closed`;
 * - a revoked device's open runs expire without an abort reason and its open
 *   sets are suspended for the owner (Q36); a credential that lapses after its
 *   30 days suspends nothing (E1b revision 4).
 *
 * In-memory only, synthetic data only. Failure injection lets the tests drop
 * a response after processing (lost ACK), answer 503 or any Holdr error
 * (before processing, or after it: an effect Holdr made whose answer says
 * otherwise), delay, hold or go offline. Raw request bodies are kept so a test
 * can compare the bytes sent with the bytes previewed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseStrict } from '../../../src/common/strict.js';
import { CLIENT_VERSION_PATTERN } from '../../../src/contracts/grammar.js';
import {
  ABORT_REQUEST,
  COMMIT_REQUEST,
  PLAN_REQUEST,
  REDEEM_REQUEST,
  RUN_REQUEST,
  type Binding,
  type HoldrErrorCode,
  type RunAbortReason,
} from '../../../src/contracts/holdrApi.js';
import { EXTENSION_VERSION } from '../../../build/manifest.js';
import {
  CARD_SYNC_DEVICE_TOKEN_PREFIX,
  CARD_SYNC_ISSUERS,
  canonicalJson,
  cardSyncPayloadDigest,
  cardSyncPlanDigest,
  formatCardSyncId,
  isCardSyncDeviceToken,
  isCardSyncId,
  isCardSyncPairingCode,
  sha256,
  toLetterHex,
  validateCardSyncPayloadV2,
  type CardSyncIdKind,
  type CardSyncIssue,
  type CardSyncIssuer,
  type CardSyncSource,
  type JsonValue,
} from '@finance-tracker/shared';

export const TEST_EXTENSION_ORIGIN = 'chrome-extension://icilknejhlhobkgcejnkbhbebnkfldmc';
/** The origin this fake serves, as the test build reaches it; capabilities name it as Holdr's own (M2). */
export const FAKE_HOLDR_ORIGIN = 'http://holdr.e3.test';

const PAIRING_MS = 300_000;
const PENDING_MS = 600_000;
const DEVICE_MS = 30 * 86_400_000;
const RUN_MS = 600_000;
const OPEN_RUNS_PER_DEVICE = 2;
const PLANS_PER_DEVICE = 2;
const PAIRING_FAILURES = 5;
const PREFLIGHT_HEADERS = new Set(['authorization', 'content-type', 'x-holdr-client', 'x-holdr-client-version', 'idempotency-key', 'accept']);

function letters(label: string): Uint8Array {
  return sha256(new TextEncoder().encode(label)).slice(0, 16);
}
function fresh(kind: CardSyncIdKind): string {
  return formatCardSyncId(kind, crypto.getRandomValues(new Uint8Array(16)));
}

export interface FakeBindingSpec {
  issuer: CardSyncIssuer;
  source: CardSyncSource;
  label: string;
  scopes: Array<{ label: string; last4: string | null; holderUnknown?: boolean }>;
}

const BINDINGS: FakeBindingSpec[] = [
  { issuer: 'chase', source: 'chase-api', label: 'Chase Sapphire (synthetic)', scopes: [{ label: 'Primary card', last4: '3391' }, { label: 'Authorized user', last4: '7720' }, { label: 'Holder unknown', last4: null, holderUnknown: true }] },
  { issuer: 'amex', source: 'amex-api-recent', label: 'Amex Gold (synthetic)', scopes: [{ label: 'Basic card', last4: '0003' }, { label: 'Supplementary card', last4: '3382' }, { label: 'Holder unknown', last4: null, holderUnknown: true }] },
  { issuer: 'citi', source: 'citi-api', label: 'Citi Double Cash (synthetic)', scopes: [{ label: 'Primary cardholder', last4: null }, { label: 'Authorized user', last4: null }, { label: 'Holder unknown', last4: null, holderUnknown: true }] },
  { issuer: 'wellsfargo', source: 'wf-dom', label: 'WF Active Cash (synthetic)', scopes: [{ label: 'Card', last4: '4417' }, { label: 'Holder unknown', last4: null, holderUnknown: true }] },
];

const MODES: Record<string, string> = { 'chase-api': 'isolated-read', 'amex-api-recent': 'main-passive', 'citi-api': 'main-passive', 'wf-dom': 'dom-passive' };

export function fakeBindings(): Binding[] {
  return BINDINGS.map((spec) => ({
    bindingId: formatCardSyncId('binding', letters(`binding/${spec.issuer}`)),
    bindingVersion: 1,
    issuer: spec.issuer,
    source: spec.source,
    bindingLabel: spec.label,
    cards: spec.scopes.map((scope) => scope.last4).filter((last4): last4 is string => last4 !== null).sort(),
    scopes: spec.scopes.map((scope) => ({
      cardScopeId: formatCardSyncId('cardScope', letters(`scope/${spec.issuer}/${scope.label}`)),
      scopeLabel: scope.label,
      last4: scope.last4,
      holderUnknown: scope.holderUnknown === true,
    })),
  }));
}

interface Device {
  deviceId: string;
  token: string;
  label: string;
  fingerprint: string;
  /** The extension version it was paired with: every request must name exactly this one (M1). */
  clientVersion: string;
  /** `expired`: its 30-day credential lapsed on its own (E1b revision 4), as opposed to `revoked` by the owner. */
  status: 'pending' | 'active' | 'revoked' | 'expired';
  pendingExpiresAt: number;
  deviceExpiresAt: string;
}
interface Run {
  runId: string;
  deviceId: string;
  clientRunId: string;
  bindingId: string;
  bindingVersion: number;
  adapterVersion: string;
  contractVersion: number;
  createdAt: number;
  uploadExpiresAt: number;
  /**
   * E1b §5.4: `open` until an upload is accepted (`accepted`) or refused for a reason Holdr records on it (`refused`),
   * the extension aborts it (`aborted`), or its device is revoked (`expired`, Q36: no abort reason).
   */
  state: 'open' | 'accepted' | 'refused' | 'expired' | 'aborted';
  /** The abort reason, also on an accepted run (which keeps its set). */
  abortReason: RunAbortReason | null;
  digest: string | null;
  setId: string | null;
}
interface ObservationSet {
  observationSetId: string;
  runId: string;
  captureId: string;
  digest: string;
  /** What a device sees (X13): Holdr's blocked and recovery reviews read as `needs-review`; `rejected` once the owner discarded the set. */
  status: 'accepted-uncommitted' | 'needs-review' | 'rejected';
  /**
   * Suspended for the owner's review (Holdr's blocked review): its device was revoked (also a password reset or a
   * binding change). A device's natural 30-day expiry does not suspend it (E1b revision 4). Devices see `needs-review`.
   */
  suspended: boolean;
  acceptedAt: string;
  expiresAt: string;
  rows: number;
}
interface Plan {
  previewId: string;
  runId: string;
  observationSetId: string;
  /** The device that prepared it: only that device may commit it (E1b's own-run principal check). */
  deviceId: string;
  payloadDigest: string;
  planDigest: string;
  expiresAt: number;
  /** `cancelled`: the set changed under it (owner commit or discard, an abort, a revocation): a commit is `preview-stale`. */
  status: 'prepared' | 'consumed' | 'cancelled';
  result: { committedAt: string; inserted: number; updated: number } | null;
}

export interface RecordedRequest {
  readonly at: number;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: string;
  readonly hadCookie: boolean;
  readonly origin: string | null;
  readonly clientVersion: string | null;
}

/** Answer with Holdr's own error for this code (its E2c status unless given): before processing, or after it (`after`). */
export interface ErrorFault {
  readonly code: HoldrErrorCode;
  readonly status: number;
  readonly after?: boolean;
}

/**
 * One fault per request: lose the answer after processing, also rejecting what was stored (owner discard), answer
 * 503, delay 5 s (past the client timeout) or 1.5 s, hold it until released (then process it as usual), process it
 * now but hold its answer until released (`hold-reply`), process it but answer off-contract (`garble`) or with a body
 * that contradicts the request (`contradict`), answer one of Holdr's errors (`ErrorFault`), or nothing.
 */
export type Fault = 'drop-after-processing' | 'reject-after-processing' | 'status-503' | 'delay' | 'slow' | 'hold' | 'hold-reply' | 'garble' | 'contradict' | ErrorFault | null;

class Refusal {
  constructor(
    readonly status: number,
    readonly code: HoldrErrorCode,
    readonly issues?: readonly CardSyncIssue[],
    /** E2c records this refusal on the upload's run (which closes it). */
    readonly closesRun = false,
  ) {}
}
function refuse(status: number, code: HoldrErrorCode, issues?: readonly CardSyncIssue[], closesRun = false): never {
  throw new Refusal(status, code, issues, closesRun);
}

export class FakeHoldr {
  bindings: Binding[] = fakeBindings();
  /** What the owner did to a binding (E1b): retired, or waiting for re-confirmation; re-confirming gives it a new version. */
  private readonly bindingStatus = new Map<string, 'needs-reconfirmation' | 'retired'>();
  /** Device → binding → the binding version it was granted. A re-confirmation re-grants no device unless asked (Q35). */
  private readonly grants = new Map<string, Map<string, number>>();
  readonly requests: RecordedRequest[] = [];
  /** `METHOD /path` of every request as it arrives, before any fault delays its answer. */
  readonly arrivals: string[] = [];
  offline = false;
  /** Holdr's own pause (owner settings): capabilities say sync is off; run creation, uploads, plans and commits get 409 `sync-paused`. */
  paused = false;
  /**
   * Whether Holdr lets a device commit a clean set itself (an auto-eligible plan, E1b revision 3 X24/Q38). Contract 1
   * closes every admission, so by default a device's prepare answers `owner-review`; tests of the device's own commit
   * path open them.
   */
  admissionsOpen = false;
  /** How long a prepared plan stays committable (E1b: 600 s, never extended); tests may shorten it. */
  planTtlMs = 600_000;
  /** Runs a device may create in 24 hours (the policy's `max_runs_per_device_day`, 50 by default). */
  runsPerDay = 50;
  /** The origin capabilities name as Holdr's own; a test may make it another Holdr's (M2). */
  capabilitiesOrigin = FAKE_HOLDR_ORIGIN;
  /** Issuers the owner switched off (or whose MAIN consent was withdrawn): 409 `sync-disabled` at the same four steps. */
  readonly disabledIssuers = new Set<CardSyncIssuer>();
  /** Faults for the next requests to a route name: consumed one per request. */
  readonly faults = new Map<string, Fault[]>();
  /** Callbacks run right after the next successful request to a route name is processed (before its answer): one per request. */
  readonly hooks = new Map<string, Array<(() => void) | null>>();
  private held: Array<{ route: string; resume: () => void }> = [];
  /** Bumped by every reset: requests begun before it belong to an earlier test. */
  private generation = 0;
  private readonly pairings = new Map<string, { expiresAt: number; status: 'open' | 'redeemed' | 'locked'; failures: number }>();
  private readonly devices = new Map<string, Device>();
  private readonly runs = new Map<string, Run>();
  readonly observations = new Map<string, ObservationSet>();
  /** Every accepted abort, in order: which run, and the reason the extension gave. */
  readonly aborts: Array<{ runId: string; reason: RunAbortReason }> = [];
  private readonly plans = new Map<string, Plan>();
  /** Runs whose set is committed (by this device's plan, or by the owner in Holdr). */
  readonly committed = new Set<string>();
  private server!: http.Server;

  static async start(): Promise<FakeHoldr> {
    const holdr = new FakeHoldr();
    holdr.server = http.createServer((req, res) => void holdr.handle(req, res));
    holdr.server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise<void>((resolve) => holdr.server.listen(0, '127.0.0.1', resolve));
    return holdr;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  reset(): void {
    this.generation += 1;
    this.requests.length = 0;
    this.arrivals.length = 0;
    this.offline = false;
    this.paused = false;
    this.admissionsOpen = false;
    this.planTtlMs = 600_000;
    this.runsPerDay = 50;
    this.capabilitiesOrigin = FAKE_HOLDR_ORIGIN;
    this.disabledIssuers.clear();
    this.bindings = fakeBindings();
    this.bindingStatus.clear();
    this.grants.clear();
    this.faults.clear();
    this.hooks.clear();
    this.release();
    this.pairings.clear();
    this.devices.clear();
    this.runs.clear();
    this.observations.clear();
    this.aborts.length = 0;
    this.plans.clear();
    this.committed.clear();
  }

  // --- test hooks (what the owner does in Holdr) ------------------------------------------------------
  createPairing(): string {
    const code = toLetterHex(crypto.getRandomValues(new Uint8Array(16)));
    this.pairings.set(code, { expiresAt: Date.now() + PAIRING_MS, status: 'open', failures: 0 });
    return code;
  }
  approveAll(): void {
    for (const device of this.devices.values()) {
      if (device.status !== 'pending' || device.pendingExpiresAt <= Date.now()) continue;
      device.status = 'active';
      device.deviceExpiresAt = new Date(Date.now() + DEVICE_MS).toISOString();
      this.grantAll(device.deviceId);
    }
  }
  private grantAll(deviceId: string): void {
    this.grants.set(deviceId, new Map(this.bindings.map((binding) => [binding.bindingId, binding.bindingVersion])));
  }
  /** The owner re-confirms a binding: a new version; devices keep their old grant unless `regrant` lists them all (Q35). */
  reconfirmBinding(issuer: CardSyncIssuer, regrant = false): void {
    const binding = this.bindingFor(issuer);
    binding.bindingVersion += 1;
    this.bindingStatus.delete(binding.bindingId);
    if (!regrant) return;
    for (const [deviceId, granted] of this.grants) if (this.devices.get(deviceId)?.status === 'active') granted.set(binding.bindingId, binding.bindingVersion);
  }
  /** The owner's binding needs re-confirmation (e.g. a scope changed), or is retired for good. */
  setBindingStatus(issuer: CardSyncIssuer, status: 'needs-reconfirmation' | 'retired'): void {
    this.bindingStatus.set(this.bindingFor(issuer).bindingId, status);
  }
  /**
   * Revokes every device: their open runs expire, without an abort reason (Q36), their open sets are suspended for the
   * owner's review, and their prepared plans are cancelled.
   */
  revokeAll(): void {
    for (const device of this.devices.values()) device.status = 'revoked';
    for (const run of this.runs.values()) if (run.state === 'open') run.state = 'expired';
    for (const set of this.observations.values()) if (this.isOpen(set)) set.suspended = true;
    for (const plan of this.plans.values()) if (plan.status === 'prepared') plan.status = 'cancelled';
  }
  /**
   * Every active device's 30-day credential lapses on its own (E1b revision 4): its requests get 401, but its
   * unprocessed sets stay open for the owner's review, not suspended (only revoking, a password reset or a binding
   * change suspends them).
   */
  expireAll(): void {
    for (const device of this.devices.values()) if (device.status === 'active') device.status = 'expired';
  }
  /** The set of a run as the owner sees it, for assertions: `suspended`, `committed`, or its device-visible status. */
  setState(runId: string): string | null {
    const set = this.setOfRun(runId);
    if (!set) return null;
    if (this.committed.has(runId)) return 'committed';
    return set.suspended ? 'suspended' : set.status;
  }
  /** How a run ended on Holdr's side, for assertions: `aborted:<reason>`, `refused`, `expired`, `accepted` or `open`. */
  runState(runId: string): string | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return run.state === 'aborted' ? `aborted:${run.abortReason}` : run.state;
  }
  /** The single run created so far (tests with one capture). */
  onlyRunId(): string {
    const ids = [...this.runs.keys()];
    if (ids.length !== 1) throw new Error(`expected one run, found ${ids.length}`);
    return ids[0];
  }
  /** The owner discards every open observation set (E8-M "discard"): devices see `rejected`; their plans for it are void. */
  rejectOpenSets(): void {
    for (const set of this.observations.values()) {
      if (!this.isOpen(set)) continue;
      set.status = 'rejected';
      this.cancelPlans(set.observationSetId);
    }
  }
  /** The owner reviews and commits every open observation set in Holdr (E8-M), which a device cannot under closed admissions. */
  ownerCommitAll(): void {
    for (const set of this.observations.values()) {
      if (!this.isOpen(set)) continue;
      this.committed.add(set.runId);
      this.cancelPlans(set.observationSetId);
    }
  }
  /** An active device, as if paired by this extension version and approved: its bearer, for tests that call the API directly. */
  activeDeviceToken(): string {
    const device: Device = {
      deviceId: fresh('device'),
      token: `${CARD_SYNC_DEVICE_TOKEN_PREFIX}${toLetterHex(crypto.getRandomValues(new Uint8Array(32)))}`,
      label: 'Direct test',
      fingerprint: toLetterHex(crypto.getRandomValues(new Uint8Array(8))).replace(/(.{4})(?=.)/g, '$1-'),
      clientVersion: EXTENSION_VERSION,
      status: 'active',
      pendingExpiresAt: Date.now(),
      deviceExpiresAt: new Date(Date.now() + DEVICE_MS).toISOString(),
    };
    this.devices.set(device.deviceId, device);
    this.grantAll(device.deviceId);
    return device.token;
  }
  /** Every paired device now counts as paired by `version` (an extension update would need a new pairing, M1). */
  setPairedVersion(version: string): void {
    for (const device of this.devices.values()) device.clientVersion = version;
  }
  fault(route: string, ...faults: Fault[]): void {
    this.faults.set(route, [...(this.faults.get(route) ?? []), ...faults]);
  }
  /** Runs `fn` right after the next successful request to `route` is processed; `null` entries skip a request. */
  hook(route: string, ...fns: Array<(() => void) | null>): void {
    this.hooks.set(route, [...(this.hooks.get(route) ?? []), ...fns]);
  }
  /** Lets every held request (or only those of `route`) go on: each is processed, or answered, as it would have been then. */
  release(route?: string): void {
    const go = this.held.filter((item) => route === undefined || item.route === route);
    this.held = this.held.filter((item) => !go.includes(item));
    for (const item of go) item.resume();
  }
  /** Lets the oldest held request of `route` go on. */
  releaseOne(route: string): void {
    const index = this.held.findIndex((item) => item.route === route);
    if (index < 0) throw new Error(`nothing of ${route} is held`);
    const [item] = this.held.splice(index, 1);
    item.resume();
  }
  /** How many requests are held right now (of `route`, if given). */
  heldOf(route?: string): number {
    return this.held.filter((item) => route === undefined || item.route === route).length;
  }
  get heldCount(): number {
    return this.held.length;
  }
  bindingFor(issuer: CardSyncIssuer): Binding {
    return this.bindings.find((binding) => binding.issuer === issuer)!;
  }

  private setOfRun(runId: string): ObservationSet | null {
    const setId = this.runs.get(runId)?.setId ?? null;
    return setId ? this.observations.get(setId) ?? null : null;
  }
  private isOpen(set: ObservationSet): boolean {
    return set.status !== 'rejected' && !this.committed.has(set.runId) && Date.parse(set.expiresAt) > Date.now();
  }
  private cancelPlans(setId: string): void {
    for (const plan of this.plans.values()) if (plan.observationSetId === setId && plan.status === 'prepared') plan.status = 'cancelled';
  }
  /** What a device sees of a set (E2c): blocked and recovery reviews as `needs-review`, a committed one as committed. */
  private visibleStatus(set: ObservationSet): 'accepted-uncommitted' | 'needs-review' | 'rejected' | 'committed' | 'expired-unreviewed' {
    if (this.committed.has(set.runId)) return 'committed';
    if (set.status === 'rejected') return 'rejected';
    if (Date.parse(set.expiresAt) <= Date.now()) return 'expired-unreviewed';
    return set.suspended ? 'needs-review' : set.status;
  }

  // --- HTTP ------------------------------------------------------------------------------------------
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // A request that began before the last reset belongs to an earlier test: it is dropped, never processed or logged.
    const generation = this.generation;
    const url = new URL(req.url ?? '/', FAKE_HOLDR_ORIGIN);
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const version = typeof req.headers['x-holdr-client-version'] === 'string' ? req.headers['x-holdr-client-version'] : null;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 2 * 1024 * 1024 + 4096) break;
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (generation !== this.generation) return void req.socket.destroy();
    this.arrivals.push(`${req.method ?? '?'} ${url.pathname}`);
    const record = (status: number) => {
      this.requests.push({ at: Date.now(), method: req.method ?? '?', path: url.pathname, status, body, hadCookie: req.headers.cookie !== undefined, origin: origin ?? null, clientVersion: version });
    };
    const cors = (): Record<string, string> => (origin === TEST_EXTENSION_ORIGIN ? { 'access-control-allow-origin': TEST_EXTENSION_ORIGIN, 'access-control-expose-headers': 'X-Holdr-Error, Retry-After', vary: 'Origin' } : { vary: 'Origin' });
    const reply = (status: number, value: unknown) => {
      if (generation !== this.generation) return void req.socket.destroy();
      record(status);
      const error = status >= 400 && value !== null && typeof value === 'object' ? (value as { error?: string }).error : undefined;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(error ? { 'x-holdr-error': error } : {}), ...cors() });
      res.end(JSON.stringify(value));
    };
    const answerError = (failure: Refusal) => reply(failure.status, failure.issues ? { error: failure.code, issues: failure.issues.slice(0, 20) } : { error: failure.code });

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Synthetic Holdr</title><h1>Synthetic Holdr (test)</h1>');
      return;
    }
    const route = this.route(req.method === 'OPTIONS' ? null : req.method ?? '', url.pathname);
    if (!route) return answerError(new Refusal(404, 'not-found'));
    if (req.method === 'OPTIONS') {
      // E2c: only the extension's origin, exactly the route's method, only listed request headers, never credentials.
      const method = req.headers['access-control-request-method'];
      const declared = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map((item) => item.trim()).filter(Boolean);
      if (origin !== TEST_EXTENSION_ORIGIN || method !== route.method || declared.some((item) => !PREFLIGHT_HEADERS.has(item))
        || !declared.includes('authorization') || !declared.includes('x-holdr-client') || req.headers.cookie !== undefined || req.headers.authorization !== undefined) {
        return answerError(new Refusal(403, 'credential-not-allowed'));
      }
      record(204);
      res.writeHead(204, { ...cors(), 'access-control-allow-methods': route.method, 'access-control-allow-headers': declared.join(', '), 'vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' });
      res.end();
      return;
    }
    if (this.offline) return answerError(new Refusal(503, 'unavailable'));

    const fault = this.faults.get(route.name)?.shift() ?? null;
    const hook = this.hooks.get(route.name)?.shift() ?? null;
    if (fault === 'status-503') return answerError(new Refusal(503, 'unavailable'));
    if (fault !== null && typeof fault === 'object' && !fault.after) return answerError(new Refusal(fault.status, fault.code));
    if (fault === 'delay') await new Promise((resolve) => setTimeout(resolve, 5_000));
    if (fault === 'slow') await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (fault === 'hold') await new Promise<void>((resolve) => this.held.push({ route: route.name, resume: resolve }));
    if (generation !== this.generation) return void req.socket.destroy();

    let value: unknown;
    try {
      value = this.process(route, req, url, body, origin, version);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return answerError(error);
    }
    hook?.();
    if (fault === 'drop-after-processing' || fault === 'reject-after-processing') {
      // The owner discards what was just stored before the answer could reach the extension.
      if (fault === 'reject-after-processing') this.rejectOpenSets();
      record(0);
      req.socket.destroy();
      return;
    }
    if (fault !== null && typeof fault === 'object') {
      // The effect is made; the answer is one of Holdr's errors (D's late `authorization-blocked`, a 500 while answering).
      return answerError(new Refusal(fault.status, fault.code));
    }
    // Processed now, answered only when released: the answer describes the state at processing.
    if (fault === 'hold-reply') {
      this.held.push({ route: route.name, resume: () => reply(200, value) });
      return;
    }
    // Processed as usual, but answered with a body the contract does not allow (an extra key).
    if (fault === 'garble') {
      reply(200, { ...(value as Record<string, unknown>), unexpected: true });
      return;
    }
    // Processed as usual, but answered with a well-formed body that contradicts the request (another payload digest).
    if (fault === 'contradict') {
      reply(200, { ...(value as Record<string, unknown>), payloadDigest: `pd1:${'f'.repeat(64)}` });
      return;
    }
    reply(200, value);
  }

  /** One device request, in E2c's order; a `Refusal` is Holdr's error answer. */
  private process(route: { name: string; method: string; runId?: string }, req: http.IncomingMessage, url: URL, body: string, origin: string | undefined, version: string | null): unknown {
    if (origin !== undefined && origin !== TEST_EXTENSION_ORIGIN) refuse(403, 'credential-not-allowed');
    if (req.headers['x-holdr-client'] !== 'extension-v1') refuse(400, 'bad-request');
    if (url.search !== '') refuse(400, 'bad-request');
    if (req.method === 'POST' && !/^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i.test(req.headers['content-type'] ?? '')) {
      refuse(415, 'unsupported-media-type');
    }
    const auth = req.headers.authorization ?? '';
    if (req.headers.cookie !== undefined) refuse(401, 'unauthorized');

    if (route.name === 'redeem') {
      const code = auth.startsWith('HoldrPair ') ? auth.slice('HoldrPair '.length) : '';
      if (!isCardSyncPairingCode(code)) refuse(401, 'pairing-invalid');
      const parsed = parseStrict(safeJson(body), REDEEM_REQUEST);
      if (!parsed.ok) refuse(400, 'bad-request');
      const pairing = this.pairings.get(code);
      if (!pairing || pairing.status !== 'open' || pairing.expiresAt <= Date.now()) {
        // A wrong code counts against every open invitation; the fifth locks it (E1b §5.3).
        let locked = false;
        for (const open of this.pairings.values()) {
          if (open.status !== 'open') continue;
          open.failures += 1;
          if (open.failures >= PAIRING_FAILURES) {
            open.status = 'locked';
            locked = true;
          }
        }
        refuse(locked ? 429 : 401, locked ? 'pairing-locked' : 'pairing-invalid');
      }
      pairing!.status = 'redeemed';
      const device: Device = {
        deviceId: fresh('device'),
        token: `${CARD_SYNC_DEVICE_TOKEN_PREFIX}${toLetterHex(crypto.getRandomValues(new Uint8Array(32)))}`,
        label: parsed.ok ? parsed.value.deviceLabel : '',
        fingerprint: toLetterHex(crypto.getRandomValues(new Uint8Array(8))).replace(/(.{4})(?=.)/g, '$1-'),
        clientVersion: parsed.ok ? parsed.value.clientVersion : '',
        status: 'pending',
        pendingExpiresAt: Date.now() + PENDING_MS,
        deviceExpiresAt: new Date(Date.now() + PENDING_MS).toISOString(),
      };
      this.devices.set(device.deviceId, device);
      return { deviceId: device.deviceId, deviceToken: device.token, fingerprint: device.fingerprint, status: 'pending', pendingExpiresAt: new Date(device.pendingExpiresAt).toISOString() };
    }

    // HoldrDevice: the credential, its lifetime, and the version it was paired with (M1).
    const bearer = auth.startsWith('HoldrDevice ') ? auth.slice('HoldrDevice '.length) : '';
    const device = isCardSyncDeviceToken(bearer) ? [...this.devices.values()].find((item) => item.token === bearer) : undefined;
    const live = device !== undefined && ((device.status === 'pending' && device.pendingExpiresAt > Date.now()) || (device.status === 'active' && Date.parse(device.deviceExpiresAt) > Date.now()));
    if (!device || !live) refuse(401, 'unauthorized');
    if (version === null || !CLIENT_VERSION_PATTERN.test(version) || version !== device!.clientVersion) refuse(401, 'unauthorized');
    const self = device!;
    if (route.name === 'capabilities') return this.capabilities(self);
    if (self.status !== 'active') refuse(403, 'device-pending');

    if (route.name === 'create-run') return this.createRun(self, req, body);
    if (route.name === 'observations') return this.upload(self, req, body);
    if (route.name === 'plan') return this.prepare(self, body);
    if (route.name === 'commit') return this.commit(self, body);
    const run = this.ownRun(self, route.runId!);
    if (route.name === 'receipt') return this.receipt(run);
    return this.abort(run, body);
  }

  private capabilities(device: Device): unknown {
    const active = device.status === 'active';
    return {
      status: device.status,
      deviceId: device.deviceId,
      deviceLabel: device.label,
      deviceExpiresAt: active ? device.deviceExpiresAt : new Date(device.pendingExpiresAt).toISOString(),
      holdrOrigin: this.capabilitiesOrigin,
      syncEnabled: active && !this.paused,
      payloadVersions: [2],
      contractVersions: [1],
      maxPayloadBytes: 2 * 1024 * 1024,
      maxRows: 2_000,
      issuers: CARD_SYNC_ISSUERS.map((issuer) => ({ issuer, enabled: !this.disabledIssuers.has(issuer) })),
      // Only the bindings this device may use now: confirmed, and granted at their current version (none while pending).
      bindings: active
        ? this.bindings.filter((binding) => !this.bindingStatus.has(binding.bindingId) && this.grants.get(device.deviceId)?.get(binding.bindingId) === binding.bindingVersion)
        : [],
    };
  }

  /** E1b row 15: the current-source authorization, at run creation, acceptance, device prepare and commit. */
  private authorize(device: Device, bindingId: string, runVersion: number): void {
    if (this.paused) refuse(409, 'sync-paused');
    const binding = this.bindings.find((item) => item.bindingId === bindingId)!;
    if (this.disabledIssuers.has(binding.issuer)) refuse(409, 'sync-disabled');
    const status = this.bindingStatus.get(bindingId);
    if (status === 'retired') refuse(409, 'binding-retired');
    if (status === 'needs-reconfirmation') refuse(409, 'binding-needs-reconfirmation');
    const granted = this.grants.get(device.deviceId)?.get(bindingId);
    if (granted !== binding.bindingVersion || runVersion !== binding.bindingVersion) refuse(409, 'binding-stale', undefined, true);
  }

  private clientRunKey(req: http.IncomingMessage): string {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !isCardSyncId('clientRun', key)) refuse(400, 'bad-request');
    return key as string;
  }

  private createRun(device: Device, req: http.IncomingMessage, body: string): unknown {
    const parsed = parseStrict(safeJson(body), RUN_REQUEST);
    if (!parsed.ok) refuse(400, 'bad-request');
    const request = parsed.ok ? parsed.value : null!;
    if (this.clientRunKey(req) !== request.clientRunId) refuse(409, 'idempotency-conflict');
    if (request.contractVersion !== 1) refuse(422, 'contract-unsupported');
    const binding = this.bindings.find((item) => item.bindingId === request.bindingId);
    if (!binding) refuse(404, 'not-found');
    this.authorize(device, request.bindingId, request.bindingVersion);
    const existing = [...this.runs.values()].find((run) => run.deviceId === device.deviceId && run.clientRunId === request.clientRunId);
    if (existing) {
      if (existing.bindingId !== request.bindingId || existing.bindingVersion !== request.bindingVersion || existing.adapterVersion !== request.adapterVersion || existing.contractVersion !== request.contractVersion) {
        refuse(409, 'idempotency-conflict');
      }
      return { runId: existing.runId, expiresAt: new Date(existing.uploadExpiresAt).toISOString() };
    }
    const now = Date.now();
    const mine = [...this.runs.values()].filter((run) => run.deviceId === device.deviceId);
    if (mine.filter((run) => run.state === 'open' && run.uploadExpiresAt > now).length >= OPEN_RUNS_PER_DEVICE) refuse(429, 'too-many-open-runs');
    if (mine.filter((run) => run.createdAt > now - 86_400_000).length >= this.runsPerDay) refuse(429, 'run-rate-limited');
    const run: Run = {
      runId: fresh('run'), deviceId: device.deviceId, clientRunId: request.clientRunId, bindingId: request.bindingId, bindingVersion: request.bindingVersion,
      adapterVersion: request.adapterVersion, contractVersion: request.contractVersion, createdAt: now, uploadExpiresAt: now + RUN_MS,
      state: 'open', abortReason: null, digest: null, setId: null,
    };
    this.runs.set(run.runId, run);
    return { runId: run.runId, expiresAt: new Date(run.uploadExpiresAt).toISOString() };
  }

  private ownRun(device: Device, runId: unknown): Run {
    const run = typeof runId === 'string' ? this.runs.get(runId) : undefined;
    if (!run || run.deviceId !== device.deviceId) refuse(404, 'run-not-found');
    return run!;
  }

  private upload(device: Device, req: http.IncomingMessage, body: string): unknown {
    // E2c identifies the run first (its key, else the body's run id) so that a refusal it records closes it.
    let run: Run | undefined;
    try {
      const key = this.clientRunKey(req);
      run = [...this.runs.values()].find((item) => item.deviceId === device.deviceId && item.clientRunId === key);
      return this.accept(device, req, body, key);
    } catch (error) {
      if (error instanceof Refusal && error.closesRun) {
        const bodyRun = run ?? (() => {
          const value = safeJson(body) as { runId?: unknown } | undefined;
          const candidate = value && typeof value === 'object' ? this.runs.get(String(value.runId)) : undefined;
          return candidate?.deviceId === device.deviceId ? candidate : undefined;
        })();
        if (bodyRun && bodyRun.state === 'open') bodyRun.state = 'refused';
      }
      throw error;
    }
  }

  private accept(device: Device, req: http.IncomingMessage, body: string, key: string): unknown {
    void req;
    const raw = safeJson(body);
    const envelope = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    if (!envelope || Object.keys(envelope).length !== 2 || !('payload' in envelope) || !isCardSyncId('run', envelope.runId)) {
      refuse(422, 'payload-invalid', [{ code: 'invalid-format', path: '$' }], true);
    }
    const validation = validateCardSyncPayloadV2(envelope!.payload);
    if (!validation.ok) refuse(422, 'payload-invalid', validation.issues.slice(0, 20), true);
    const payload = validation.ok ? validation.payload : null!;
    const canonical = canonicalJson(payload as unknown as JsonValue);
    if (body !== `{"payload":${canonical},"runId":${JSON.stringify(envelope!.runId)}}`) refuse(400, 'payload-digest-mismatch', [{ code: 'inconsistent', path: '$' }], true);
    const run = this.ownRun(device, envelope!.runId);
    this.authorize(device, run.bindingId, run.bindingVersion);
    if (key !== run.clientRunId) refuse(409, 'idempotency-conflict');
    const digest = cardSyncPayloadDigest(payload);
    if (run.state === 'accepted') {
      // A replay of the accepted upload answers the set as it is now, final states included (M7).
      if (digest !== run.digest || run.setId === null) refuse(409, 'idempotency-conflict');
      const set = this.observations.get(run.setId!)!;
      return { observationSetId: set.observationSetId, runId: run.runId, payloadDigest: set.digest, status: this.visibleStatus(set), acceptedAt: set.acceptedAt, expiresAt: set.expiresAt };
    }
    if (run.state !== 'open') refuse(409, 'run-closed');
    if (Date.now() >= run.uploadExpiresAt) refuse(410, 'run-expired');
    const binding = this.bindings.find((item) => item.bindingId === run.bindingId)!;
    if (payload.bindingId !== run.bindingId || payload.bindingVersion !== run.bindingVersion || payload.bindingVersion !== binding.bindingVersion) refuse(409, 'binding-stale', undefined, true);
    if (payload.contractVersion !== run.contractVersion) refuse(422, 'contract-unsupported', undefined, true);
    if (payload.source !== binding.source || payload.issuer !== binding.issuer || payload.mode !== MODES[binding.source] || payload.currency !== 'USD') refuse(422, 'payload-invalid', undefined, true);
    const scopes = new Set(binding.scopes.map((scope) => scope.cardScopeId));
    if (payload.rows.some((row) => !scopes.has(row.cardScopeId)) || payload.coverage.some((entry) => !scopes.has(entry.cardScopeId))) refuse(422, 'scope-not-in-binding', undefined, true);
    if ([...this.observations.values()].some((set) => set.captureId === payload.captureId)) refuse(409, 'capture-already-accepted', undefined, true);
    const set: ObservationSet = {
      observationSetId: fresh('observationSet'),
      runId: run.runId,
      captureId: payload.captureId,
      digest,
      status: payload.rows.some((row) => row.externalIdHash === null) ? 'needs-review' : 'accepted-uncommitted',
      suspended: false,
      acceptedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      rows: payload.rows.length,
    };
    this.observations.set(set.observationSetId, set);
    run.state = 'accepted';
    run.digest = digest;
    run.setId = set.observationSetId;
    return { observationSetId: set.observationSetId, runId: run.runId, payloadDigest: set.digest, status: set.status, acceptedAt: set.acceptedAt, expiresAt: set.expiresAt };
  }

  private counts(set: ObservationSet) {
    return { insert: set.rows, update: 0, unchanged: 0, aliased: 0, matched: 0, attributed: 0, promoted: 0, corrected: 0, rejected: 0, unmatched: 0, superseded: 0 };
  }

  private prepare(device: Device, body: string): unknown {
    const parsed = parseStrict(safeJson(body), PLAN_REQUEST);
    if (!parsed.ok) refuse(400, 'bad-request');
    const request = parsed.ok ? parsed.value : null!;
    const run = this.ownRun(device, request.runId);
    if (run.setId !== request.observationSetId) refuse(404, 'not-found');
    const set = this.observations.get(run.setId!)!;
    if (Date.parse(set.expiresAt) <= Date.now()) refuse(410, 'observation-expired');
    if (!this.isOpen(set)) refuse(409, 'set-closed');
    this.authorize(device, run.bindingId, run.bindingVersion);
    // X24: a device gets an executable plan only when it may commit the set itself (admissions open, nothing to
    // review); otherwise the owner decides in Holdr, and no previewId is made up.
    if (!this.admissionsOpen || set.status !== 'accepted-uncommitted' || set.suspended) {
      return { status: 'owner-review', observationSetId: set.observationSetId, counts: this.counts(set), reviewCount: set.rows };
    }
    const held = [...this.plans.values()].filter((plan) => plan.deviceId === device.deviceId && plan.status === 'prepared' && plan.expiresAt > Date.now() && plan.observationSetId !== set.observationSetId);
    if (held.length >= PLANS_PER_DEVICE) refuse(429, 'plan-quota-exceeded');
    const previewId = fresh('preview');
    const plan: Plan = {
      previewId, runId: run.runId, observationSetId: set.observationSetId, deviceId: device.deviceId, payloadDigest: set.digest,
      planDigest: cardSyncPlanDigest({ previewId, observationSetId: set.observationSetId, payloadDigest: set.digest }),
      expiresAt: Date.now() + this.planTtlMs, status: 'prepared', result: null,
    };
    this.plans.set(previewId, plan);
    return { status: 'executable', previewId, payloadDigest: set.digest, planDigest: plan.planDigest, expiresAt: new Date(plan.expiresAt).toISOString(), counts: this.counts(set) };
  }

  private commit(device: Device, body: string): unknown {
    const parsed = parseStrict(safeJson(body), COMMIT_REQUEST);
    if (!parsed.ok) refuse(400, 'bad-request');
    const request = parsed.ok ? parsed.value : null!;
    const run = this.ownRun(device, request.runId);
    if (run.setId === null || run.digest !== request.payloadDigest) refuse(409, 'plan-mismatch');
    const plan = this.plans.get(request.previewId);
    if (!plan || plan.deviceId !== device.deviceId) refuse(404, 'not-found');
    const same = plan!.planDigest === request.planDigest && plan!.payloadDigest === request.payloadDigest;
    if (plan!.status === 'consumed') {
      if (!same) refuse(409, 'plan-mismatch');
      return { status: 'committed', ...plan!.result! };
    }
    if (plan!.status === 'cancelled') refuse(409, 'preview-stale');
    if (plan!.expiresAt <= Date.now()) refuse(410, 'plan-expired');
    if (!same) refuse(409, 'plan-mismatch');
    const set = this.observations.get(plan!.observationSetId)!;
    if (Date.parse(set.expiresAt) <= Date.now()) refuse(410, 'observation-expired');
    this.authorize(device, run.bindingId, run.bindingVersion);
    // The set changed under the plan (committed or discarded in Holdr): its pins no longer hold.
    if (!this.isOpen(set)) refuse(409, 'preview-stale');
    const result = { committedAt: new Date().toISOString(), inserted: set.rows, updated: 0 };
    plan!.status = 'consumed';
    plan!.result = result;
    this.committed.add(run.runId);
    this.cancelPlans(set.observationSetId);
    return { status: 'committed', ...result };
  }

  private receipt(run: Run): unknown {
    const set = run.setId ? this.observations.get(run.setId)! : null;
    const visible = set ? this.visibleStatus(set) : null;
    return {
      runId: run.runId,
      observationSetId: set?.observationSetId ?? null,
      acceptance: visible === null ? 'none' : visible === 'committed' ? 'accepted-uncommitted' : visible,
      ledger: visible === 'committed' ? 'committed' : 'none',
      payloadDigest: run.digest,
      acceptedAt: set?.acceptedAt ?? null,
      expiresAt: set?.expiresAt ?? null,
    };
  }

  private abort(run: Run, body: string): unknown {
    // Q4: a fixed reason, anything else 422.
    const parsed = parseStrict(safeJson(body), ABORT_REQUEST);
    if (!parsed.ok) refuse(422, 'bad-request', [{ code: 'invalid-enum', path: '$.reason' }]);
    const reason = parsed.ok ? parsed.value.reason : null!;
    if (run.abortReason !== null) {
      if (run.abortReason !== reason) refuse(409, 'run-closed');
      return { status: 'aborted' };
    }
    if (run.state === 'open') {
      run.state = 'aborted';
    } else if (run.state === 'accepted') {
      // The accepted set stays for the owner's review; only its plans go.
      if (run.setId) this.cancelPlans(run.setId);
    } else {
      refuse(409, 'run-closed');
    }
    run.abortReason = reason;
    this.aborts.push({ runId: run.runId, reason });
    return { status: 'aborted' };
  }

  private route(method: string | null, path: string): { name: string; method: string; runId?: string } | null {
    const fixed: Record<string, [string, string]> = {
      '/card-sync/pairings/redeem': ['redeem', 'POST'],
      '/card-sync/capabilities': ['capabilities', 'GET'],
      '/card-sync/runs': ['create-run', 'POST'],
      '/card-sync/observations': ['observations', 'POST'],
      '/card-sync/imports/preview': ['plan', 'POST'],
      '/card-sync/imports/commit': ['commit', 'POST'],
    };
    const known = fixed[path];
    if (known) return method === null || method === known[1] ? { name: known[0], method: known[1] } : null;
    const run = /^\/card-sync\/runs\/(run_[a-p]{32})\/(receipt|abort)$/.exec(path);
    if (!run) return null;
    const expected = run[2] === 'receipt' ? 'GET' : 'POST';
    return method === null || method === expected ? { name: run[2], method: expected, runId: run[1] } : null;
  }

  /** Raw bodies of observation requests Holdr processed, in order (also those whose answer was lost). */
  observationBodies(): string[] {
    return this.requests.filter((request) => request.path === '/card-sync/observations' && (request.status === 200 || request.status === 0)).map((request) => request.body);
  }

  async close(): Promise<void> {
    this.release();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
