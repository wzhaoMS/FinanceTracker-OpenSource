/**
 * A fake Holdr owner API for tests and the explicitly enabled dev mock, never
 * for production: the HTTP behaviour of Holdr's owner API (E2a–E2d), over
 * in-memory synthetic data. `handle` takes a request the way a server would
 * see it, applies the owner API's rules (session only: any `Authorization`
 * header is refused; writes need `X-Holdr-Request: 1`; JSON bodies are parsed
 * strictly with exact keys) and answers with a status and a JSON body.
 *
 * Playwright serves it to the real client through `page.route`; unit tests
 * and the dev mock reach it through `fakeOwnerTransport`.
 */
import { CARD_SYNC_ISSUERS, type CardSyncIssuer, type CardTransaction } from '@finance-tracker/shared';
import {
  APPROVE_PAIRING_REQUEST,
  AUTO_SYNC_REQUEST,
  COMMIT_REQUEST,
  CONFIRM_BINDING_REQUEST,
  CREATE_BINDING_REQUEST,
  CREATE_PAIRING_REQUEST,
  DECISIONS_REQUEST,
  DETACH_REQUEST,
  DISCARD_REQUEST,
  EMPTY_REQUEST,
  ENABLE_ISSUER_REQUEST,
  OWNER_API_PREFIX,
  PLAN_REQUEST,
  RECENT_AUTH_PATH,
  REGRANT_REQUEST,
  REJECT_PAIRING_REQUEST,
  REPOINT_REQUEST,
  REVERT_REQUEST,
  UNMERGE_REQUEST,
  VERSION_REQUEST,
  type AbortReason,
  type RunErrorCode,
} from './ownerApi';
import type { OwnerTransport, TransportResult } from './ownerClient';
import { S, parseStrictValue, type Infer, type Spec } from './strict';
import { FakeOwnerCore, FakeRefusal } from './fake/core';
import { ledgerRevisionOf, transactionSourcesView } from './fake/ledger';
import { LEDGER_STORY_IDS, seedLedgerFromCandidates, seedLegacyRemovedCharge } from './fake/ledgerSeed';
import { FAKE_NOW, HOUR, iso, itemsPinOf, pageCursor, pageOffset, type CursorKind, type FakeStore } from './fake/model';
import { addCommittedHistory, addFileReviewSet, addLargeOpenSet, addLegacyPendingSet, demoStore, freshStore, type FakeScenario } from './fake/scenario';
import {
  bindingView,
  deviceView,
  effectPageView,
  pairingView,
  planView,
  runDetailView,
  runSummaryView,
  setDetailView,
  setSummaryView,
  settingsView,
  stateView,
} from './fake/views';

export { FAKE_HOLDR_ORIGIN, FAKE_NOW, FAKE_OWNER_PASSWORD, DAY, HOUR, MINUTE } from './fake/model';
export { fakeCardAccounts, type FakeScenario } from './fake/scenario';
export { LEDGER_STORY_IDS };

export interface FakeRequest {
  method: string;
  /** Path and query, e.g. `/card-sync/owner/runs?bindingId=…`. */
  url: string;
  /** Header names in lower case. */
  headers?: Record<string, string | undefined>;
  body?: string | null;
}

export interface FakeResponse {
  status: number;
  body: unknown;
}

export interface FakeRecord {
  method: string;
  path: string;
  status: number;
  hadAuthorization: boolean;
  hadCsrfHeader: boolean;
}

export interface FakeOwnerOptions {
  scenario?: FakeScenario;
  /** Start of the fake's clock (ms); `FAKE_NOW` by default. */
  start?: number;
  /** Follow the wall clock instead of a manual clock (the dev mock). */
  wallClock?: boolean;
  /** 'required': the first sensitive action asks for the password; 'granted': it never does. */
  recentAuth?: 'required' | 'granted';
}

/** Owner write bodies: 200 decisions of the largest shape fit with room to spare. */
const BODY_LIMIT = 64 * 1024;
const ROUTE_ID = '([a-z]{3}_[a-p]{32})';
/** Holdr's own ledger ids in a path (§3.8). */
const TXN_ID = '(card-txn-[a-p]{32})';
const IDENTITY_ROUTE_ID = '(card-ident-[a-p]{32})';
/** E2a's lists of sets and runs come in fixed pages of 50 (`OWNER_PAGE_LIMITS`): no `limit` parameter. */
const LIST_PAGE = 50;
const BINDING_QUERY_ID = /^bnd_[a-p]{32}$/;

/** E2a orders by `id DESC` after the time: plain code-unit order, as SQLite compares text. */
const byIdDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

/**
 * E2a reads only the query parameters a route names (`readQuery`): any other is a 422 `unknown-key` at `$.<key>`, never
 * naming it, and a repeated one a `wrong-type` at its own path.
 */
function allowQuery(query: URLSearchParams, allowed: readonly string[]): void {
  const issues: Array<{ code: string; path: string }> = [];
  const seen = new Set<string>();
  for (const key of query.keys()) {
    if (!allowed.includes(key)) issues.push({ code: 'unknown-key', path: '$.<key>' });
    else if (seen.has(key)) issues.push({ code: 'wrong-type', path: `$.${key}` });
    seen.add(key);
  }
  if (issues.length > 0) throw new InvalidRequest(issues.slice(0, 20));
}

/**
 * The offset a query's cursor names (0 without one), or a 422 for anything that isn't a cursor of this list: malformed, of
 * another kind or for another resource (E1b revision 7). A cursor never grants access; the route already decided that.
 */
function offsetOf(query: URLSearchParams, name: string, kind: CursorKind, resource: string): number {
  const cursor = query.get(name);
  if (cursor === null) return 0;
  const offset = pageOffset(kind, resource, cursor);
  if (offset === null || offset < 1) throw new InvalidRequest([{ code: 'invalid-format', path: `$.${name}` }]);
  return offset;
}

function pageOf<T>(items: T[], query: URLSearchParams, kind: CursorKind, resource: string): { items: T[]; nextCursor: string | null } {
  const offset = offsetOf(query, 'cursor', kind, resource);
  // Holdr gives a cursor only for a position inside the list. At or past its end it is out of range (422), also when the list
  // shrank since (a set closed): the client then reads the list again from its first page. An empty list is one empty page.
  if (offset > 0 && offset >= items.length) throw new InvalidRequest([{ code: 'invalid-format', path: '$.cursor' }]);
  const end = offset + LIST_PAGE;
  return { items: items.slice(offset, end), nextCursor: end < items.length ? pageCursor(kind, resource, end) : null };
}

const SYNC_ISSUER = S.enum(CARD_SYNC_ISSUERS);

export class FakeOwnerServer {
  readonly store: FakeStore;
  readonly core: FakeOwnerCore;
  readonly requests: FakeRecord[] = [];
  private offset = 0;
  private readonly start: number;
  private readonly wallClock: boolean;
  private readonly faults: Array<{ match: RegExp; response: FakeResponse; remaining: number; skip: number }> = [];

  constructor(options: FakeOwnerOptions = {}) {
    this.wallClock = options.wallClock === true;
    this.start = options.start ?? (this.wallClock ? Date.now() : FAKE_NOW);
    const scenario = options.scenario ?? 'demo';
    this.store = scenario === 'fresh' ? freshStore(this.start) : demoStore(this.start);
    this.core = new FakeOwnerCore(this.store, () => this.now());
    if (scenario === 'restored') this.core.restoreFromBackup(this.start - HOUR);
    if (options.recentAuth === 'granted') this.store.recentAuthUntil = Number.MAX_SAFE_INTEGER;
  }

  now(): number {
    return this.wallClock ? Date.now() + this.offset : this.start + this.offset;
  }

  /** Moves the fake's clock forward (expiry tests). */
  advance(ms: number): void {
    this.offset += ms;
  }

  /** The next matching requests, after the first `skip` of them, get this answer instead (faults, outages). */
  failNext(match: RegExp, response: FakeResponse, times = 1, skip = 0): void {
    this.faults.push({ match, response, remaining: times, skip });
  }

  // ---- hooks that stand in for the extension and the recovery tool -----------------

  /** The pairing code of an invite, as the owner would read it off the screen. */
  pairingCode(pairingId: string): string {
    return this.core.pairing(pairingId).code;
  }

  /** The extension redeemed the open invite's code: a pending device appears. */
  redeemOpenPairing(deviceLabel = 'Laptop Chrome'): { deviceId: string; fingerprint: string } {
    const open = this.store.pairings.find((pairing) => pairing.status === 'open');
    if (!open) throw new Error('no open pairing to redeem');
    const device = this.core.redeem(open.code, deviceLabel);
    if (!device) throw new Error('the open pairing could not be redeemed');
    return { deviceId: device.deviceId, fingerprint: device.fingerprint };
  }

  restoreFromBackup(): void {
    this.core.restoreFromBackup();
  }

  /** The owner's Holdr password was reset (the reset flow or the `holdr-user` CLI): every browser not revoked yet is revoked. */
  resetPassword(): void {
    this.core.resetPassword();
  }

  setGate(gate: 'open' | 'blocked'): void {
    this.store.gate = gate;
  }

  setDeviceApi(state: 'enabled' | 'disabled'): void {
    this.store.deviceApi = state;
  }

  /** Opens or closes an issuer's automatic-sending gate (E4–E7 passing), for every binding or one issuer's. */
  setAutoSyncGate(gate: 'open' | 'closed', issuer?: CardSyncIssuer): void {
    for (const binding of this.store.bindings) if (!issuer || binding.issuer === issuer) binding.autoSyncGate = gate;
  }

  /**
   * The extension opened a run for this issuer and, with a reason, stopped it before sending (Q4), or Holdr refused what
   * it sent (`errorCode`). Returns the run id.
   */
  startRun(issuer: CardSyncIssuer, abortReason: AbortReason | null = null, errorCode: RunErrorCode | null = null): string {
    return this.core.startRun(issuer, abortReason, errorCode).runId;
  }

  /** Adds one chunk of a v1 file import's conflicts on the Amex account to the queue (X18). Returns its id. */
  addFileReviewSet(): string {
    const id = addFileReviewSet(this.store, this.now()).observationSetId;
    seedLedgerFromCandidates(this.store);
    return id;
  }

  /** Adds one open Chase capture of `rows` posted rows, each linkable to a pending file-import charge without a card. Returns its id. */
  addLegacyPendingSet(rows: number): string {
    const id = addLegacyPendingSet(this.store, this.now(), rows).observationSetId;
    seedLedgerFromCandidates(this.store);
    return id;
  }

  /** Adds `count` older Chase captures already in spending, each with a decision that can move to a second match. */
  addCommittedHistory(count: number): string[] {
    const ids = addCommittedHistory(this.store, this.now(), count).map((set) => set.observationSetId);
    seedLedgerFromCandidates(this.store);
    return ids;
  }

  /** Adds one open Chase capture of `rows` rows that all wait for a decision. Returns its id. */
  addLargeOpenSet(rows: number): string {
    const id = addLargeOpenSet(this.store, this.now(), rows).observationSetId;
    seedLedgerFromCandidates(this.store);
    return id;
  }

  /** Adds a charge an earlier Holdr removed without recording why (the v15 upgrade's `legacy` reason). Returns its id. */
  addLegacyRemovedCharge(): string {
    return seedLegacyRemovedCharge(this.store, this.now());
  }

  /**
   * The ledger as Spending's own routes would list it (Phase 4's `CardTransaction`), for the e2e harness that serves
   * Spending from the same synthetic ledger the owner's repairs change. Not part of the owner API.
   */
  spendingRows(): CardTransaction[] {
    return [...this.store.ledger.rows.values()].map((row) => ({
      id: row.transactionId,
      cardAccountId: row.cardAccountRef,
      source: 'synthetic',
      transactionDate: row.values.transactionDate,
      ...(row.values.postedDate ? { postedDate: row.values.postedDate } : {}),
      status: row.values.status,
      amountMinor: row.values.amountMinor,
      currency: 'USD',
      kind: row.values.kind,
      description: row.values.description,
      ...(row.values.merchant ? { merchant: row.values.merchant } : {}),
      ...(row.removedReason === 'dismissed' ? { dismissedAt: iso(row.updatedAt) } : {}),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    }));
  }

  // ---- HTTP -------------------------------------------------------------------------

  handle(request: FakeRequest): FakeResponse {
    const url = new URL(request.url, 'http://fake.invalid');
    const headers = request.headers ?? {};
    const method = request.method.toUpperCase();
    const record: FakeRecord = {
      method,
      path: url.pathname,
      status: 0,
      hadAuthorization: headers.authorization !== undefined,
      hadCsrfHeader: headers['x-holdr-request'] === '1',
    };
    const response = this.respond(method, url, headers, request.body ?? null);
    record.status = response.status;
    this.requests.push(record);
    return response;
  }

  private respond(method: string, url: URL, headers: Record<string, string | undefined>, body: string | null): FakeResponse {
    const path = url.pathname;
    if (path !== RECENT_AUTH_PATH && !path.startsWith(`${OWNER_API_PREFIX}/`)) return { status: 404, body: { error: 'not-found' } };
    for (const fault of this.faults) {
      if (fault.remaining > 0 && fault.match.test(`${method} ${path}`)) {
        if (fault.skip > 0) {
          fault.skip -= 1;
          continue;
        }
        fault.remaining -= 1;
        return fault.response;
      }
    }
    if (headers.authorization !== undefined) return { status: 400, body: { error: 'credential-not-allowed' } };
    if (method !== 'GET' && method !== 'POST') return { status: 404, body: { error: 'not-found' } };
    let json: unknown = undefined;
    if (method === 'POST') {
      if (headers['x-holdr-request'] !== '1') return { status: 403, body: { error: 'csrf-required' } };
      // E2a reads an owner POST from its path and body only: any query parameter is refused before the body (D11).
      if (path !== RECENT_AUTH_PATH && [...url.searchParams.keys()].length > 0) {
        return { status: 422, body: { error: 'invalid-request', issues: [{ code: 'unknown-key', path: '$.<key>' }] } };
      }
      if (!(headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return { status: 415, body: { error: 'unsupported-media-type' } };
      if ((body ?? '').length > BODY_LIMIT) return { status: 413, body: { error: 'too-large' } };
      try {
        json = JSON.parse(body ?? '');
      } catch {
        return { status: 400, body: { error: 'bad-request' } };
      }
    }
    try {
      this.core.tick();
      return this.route(method, path, url.searchParams, json);
    } catch (error) {
      if (error instanceof FakeRefusal) return { status: error.status, body: { error: error.code, ...error.extra } };
      if (error instanceof InvalidRequest) return { status: 422, body: { error: 'invalid-request', issues: error.issues } };
      throw error;
    }
  }

  private route(method: string, path: string, query: URLSearchParams, json: unknown): FakeResponse {
    const core = this.core;
    const store = this.store;
    const now = this.now();
    const sub = path.slice(OWNER_API_PREFIX.length);
    const match = (pattern: string) => new RegExp(`^${pattern}$`).exec(sub);
    let m: RegExpExecArray | null;

    if (path === RECENT_AUTH_PATH && method === 'POST') {
      // The login branch's route, outside card-sync: its one key is a password, which the card-sync key policy refuses by design.
      const record = json as Record<string, unknown> | null;
      if (typeof record !== 'object' || record === null || Array.isArray(record) || Object.keys(record).length !== 1
        || typeof record.password !== 'string' || record.password.length > 1_024) {
        return { status: 400, body: { error: 'bad-request' } };
      }
      return ok({ verifiedUntil: iso(core.confirmPassword(record.password)) });
    }
    if (method === 'GET') {
      if (sub === '/state') {
        allowQuery(query, []);
        return ok(stateView(store, now));
      }
      if (sub === '/observation-sets') {
        allowQuery(query, ['view', 'cursor']);
        const view = query.get('view');
        if (view !== 'open' && view !== 'closed') throw new InvalidRequest([{ code: view === null ? 'missing-key' : 'invalid-enum', path: '$.view' }]);
        // E2a: both views newest accepted first; `open` is open and before the deadline, `closed` everything else.
        const sets = store.sets
          .filter((set) => (view === 'open') === ['accepted-uncommitted', 'needs-review', 'blocked-review', 'recovery-review'].includes(set.state))
          .sort((a, b) => b.acceptedAt - a.acceptedAt || byIdDesc(a.observationSetId, b.observationSetId));
        const page = pageOf(sets, query, view === 'open' ? 'open-sets' : 'closed-sets', 'all');
        return ok({ observationSets: page.items.map(setSummaryView), nextCursor: page.nextCursor });
      }
      if ((m = match(`/observation-sets/${ROUTE_ID}`))) {
        allowQuery(query, ['itemsCursor']);
        const set = core.set(m[1]);
        const ledgerRevision = ledgerRevisionOf(store.ledger, set.cardAccountRef);
        const cursor = query.get('itemsCursor');
        if (cursor === null) return ok(setDetailView(set, ledgerRevision, now));
        const pin = itemsPinOf(set.observationSetId, cursor);
        // A cursor of another kind or set, or with any value out of range (E1b revision 7): never one Holdr gave for this set.
        if (pin === null) throw new InvalidRequest([{ code: 'invalid-format', path: '$.itemsCursor' }]);
        // A later page read against another version of the set, of the card's ledger, or across the deadline (R7, X38): read it again.
        if (pin.version !== set.version || pin.ledgerRevision !== ledgerRevision || pin.pastDeadline !== set.expiresAt <= now) {
          throw new FakeRefusal(409, 'version-conflict', { currentVersion: set.version });
        }
        // With the same pins the items are the same, so no cursor Holdr gave points past them.
        if (pin.offset >= set.items.length) throw new InvalidRequest([{ code: 'invalid-format', path: '$.itemsCursor' }]);
        return ok(setDetailView(set, ledgerRevision, now, pin.offset));
      }
      if ((m = match(`/plans/${ROUTE_ID}/effects`))) {
        allowQuery(query, ['cursor']);
        // A plan's later effects (R7) until its `expiresAt`, committed or not (E1b §5.6: 410 past it); they never change, so
        // any page can be read again meanwhile. A commit's replay after that is the commit route's (lost ACK), not this one.
        const plan = core.plan(m[1]);
        if (plan.state === 'expired' || plan.expiresAt <= now) throw new FakeRefusal(410, 'plan-expired');
        const offset = offsetOf(query, 'cursor', 'effects', plan.previewId);
        if (offset >= plan.effects.length) throw new InvalidRequest([{ code: 'invalid-format', path: '$.cursor' }]);
        return ok(effectPageView(plan, offset, now));
      }
      if (sub === '/runs') {
        allowQuery(query, ['bindingId', 'cursor']);
        const bindingId = query.get('bindingId');
        if (bindingId !== null && !BINDING_QUERY_ID.test(bindingId)) throw new InvalidRequest([{ code: 'invalid-format', path: '$.bindingId' }]);
        // E2a: newest first, by when the run was created.
        const runs = store.runs.filter((run) => !bindingId || run.bindingId === bindingId)
          .sort((a, b) => b.createdAt - a.createdAt || byIdDesc(a.runId, b.runId));
        const page = pageOf(runs, query, 'runs', bindingId ?? 'all');
        return ok({ runs: page.items.map((run) => runSummaryView(store, run, now)), nextCursor: page.nextCursor });
      }
      if ((m = match(`/runs/${ROUTE_ID}`))) {
        allowQuery(query, []);
        return ok(runDetailView(store, this.run(m[1]), now));
      }
      if ((m = match(`/transactions/${TXN_ID}/sources`))) {
        allowQuery(query, ['eventsCursor', 'identitiesCursor', 'mergedRowsCursor']);
        const { row, page } = core.transactionSources(m[1], query);
        return ok(transactionSourcesView(store.ledger, row, page));
      }
      if ((m = match(`/runs/${ROUTE_ID}/payload`))) {
        allowQuery(query, []);
        const run = this.run(m[1]);
        const set = run.observationSetId ? core.set(run.observationSetId) : null;
        if (!set) throw new FakeRefusal(404, 'not-found');
        if (!set.payload || set.receiptExpiresAt === null || set.receiptExpiresAt <= now) throw new FakeRefusal(410, 'receipt-expired');
        return ok({
          runId: run.runId,
          observationSetId: set.observationSetId,
          payloadDigest: set.payloadDigest,
          acceptedAt: iso(set.acceptedAt),
          receiptExpiresAt: iso(set.receiptExpiresAt),
          payload: set.payload,
        });
      }
      return { status: 404, body: { error: 'not-found' } };
    }

    if (sub === '/pause') {
      parse(EMPTY_REQUEST, json);
      core.pause();
      return ok(settingsView(store));
    }
    if (sub === '/resume') {
      core.resume(parse(VERSION_REQUEST, json).expectedVersion);
      return ok(settingsView(store));
    }
    if ((m = match('/issuers/([a-z]+)/(enable|disable)'))) {
      const issuer = parse(SYNC_ISSUER, m[1]) as CardSyncIssuer;
      if (m[2] === 'enable') {
        const body = parse(ENABLE_ISSUER_REQUEST, json);
        core.enableIssuer(issuer, body.expectedVersion, body.mainWorldAcknowledged);
      } else {
        parse(EMPTY_REQUEST, json);
        core.disableIssuer(issuer);
      }
      return ok(settingsView(store));
    }
    if (sub === '/bindings') return created(bindingView(store, core.createBinding(parse(CREATE_BINDING_REQUEST, json)), now));
    if ((m = match(`/bindings/${ROUTE_ID}/confirm`))) return ok(bindingView(store, core.confirmBinding(m[1], parse(CONFIRM_BINDING_REQUEST, json)), now));
    if ((m = match(`/bindings/${ROUTE_ID}/retire`))) return ok(bindingView(store, core.retireBinding(m[1], parse(VERSION_REQUEST, json).expectedVersion), now));
    if ((m = match(`/bindings/${ROUTE_ID}/auto-sync`))) {
      return ok(bindingView(store, core.setAutoSync(m[1], parse(AUTO_SYNC_REQUEST, json)), now));
    }
    if (sub === '/pairings') {
      const body = parse(CREATE_PAIRING_REQUEST, json);
      const pairing = core.createPairing(body.bindingIds, body.replacesDeviceId);
      return created({ pairing: pairingView(store, pairing), pairingCode: pairing.code, holdrOrigin: store.holdrOrigin });
    }
    if ((m = match(`/pairings/${ROUTE_ID}/cancel`))) {
      parse(EMPTY_REQUEST, json);
      return ok(pairingView(store, core.cancelPairing(m[1])));
    }
    if ((m = match(`/pairings/${ROUTE_ID}/approve`))) {
      const body = parse(APPROVE_PAIRING_REQUEST, json);
      const result = core.approvePairing(m[1], body.deviceId, body.fingerprint);
      return ok({ pairing: pairingView(store, result.pairing), device: deviceView(result.device) });
    }
    if ((m = match(`/pairings/${ROUTE_ID}/reject`))) {
      const result = core.rejectPairing(m[1], parse(REJECT_PAIRING_REQUEST, json).deviceId);
      return ok({ pairing: pairingView(store, result.pairing), device: deviceView(result.device) });
    }
    if ((m = match(`/devices/${ROUTE_ID}/revoke`))) {
      parse(EMPTY_REQUEST, json);
      return ok(deviceView(core.revokeDevice(m[1])));
    }
    if ((m = match(`/devices/${ROUTE_ID}/regrant`))) {
      return ok(deviceView(core.regrantDevice(m[1], parse(REGRANT_REQUEST, json).bindingIds)));
    }
    if ((m = match(`/observation-sets/${ROUTE_ID}/decisions`))) {
      const body = parse(DECISIONS_REQUEST, json);
      const set = core.recordDecisions(m[1], body.expectedVersion, body.decisions);
      return ok(setDetailView(set, ledgerRevisionOf(store.ledger, set.cardAccountRef), now));
    }
    if ((m = match(`/observation-sets/${ROUTE_ID}/plan`))) {
      const body = parse(PLAN_REQUEST, json);
      const { set, plan } = core.preparePlan(m[1], body.expectedVersion, body.sourceReviewed);
      // E2a answers a prepared plan 200 (the proposal said 201; the client takes any 2xx).
      return ok(planView(plan, set));
    }
    if ((m = match(`/plans/${ROUTE_ID}/commit`))) {
      const body = parse(COMMIT_REQUEST, json);
      const { set, plan } = core.commitPlan(m[1], body.payloadDigest, body.planDigest);
      return ok({ status: 'committed', previewId: plan.previewId, observationSetId: set.observationSetId, committedAt: iso(plan.committedAt ?? now), counts: { ...plan.counts } });
    }
    if ((m = match(`/observation-sets/${ROUTE_ID}/discard`))) {
      const body = parse(DISCARD_REQUEST, json);
      return ok(setSummaryView(core.discard(m[1], body.expectedVersion, body.reason)));
    }
    // Ledger repairs after a set expired (proposal §3.8): session and recent auth, never stopped by a pause or a blocked gate.
    if ((m = match(`/identities/${IDENTITY_ROUTE_ID}/detach`))) {
      const body = parse(DETACH_REQUEST, json);
      const row = core.detachIdentity(m[1], body.transactionId, body.expectedRevision);
      return ok(transactionSourcesView(store.ledger, row, null));
    }
    if ((m = match(`/identities/${IDENTITY_ROUTE_ID}/repoint`))) {
      const body = parse(REPOINT_REQUEST, json);
      const row = core.repointIdentity(m[1], body.fromTransactionId, body.toTransactionId, body.expectedRevision, body.expectedToRevision);
      return ok(transactionSourcesView(store.ledger, row, null));
    }
    if ((m = match(`/transactions/${TXN_ID}/revert`))) {
      const body = parse(REVERT_REQUEST, json);
      return ok(transactionSourcesView(store.ledger, core.revertChange(m[1], body.eventId, body.expectedRevision), null));
    }
    if ((m = match(`/transactions/${TXN_ID}/unmerge`))) {
      const body = parse(UNMERGE_REQUEST, json);
      return ok(transactionSourcesView(store.ledger, core.unmergeTransaction(m[1], body.expectedRevision, body.expectedSurvivorRevision), null));
    }
    return { status: 404, body: { error: 'not-found' } };
  }

  private run(runId: string) {
    return this.store.runs.find((run) => run.runId === runId) ?? (() => { throw new FakeRefusal(404, 'not-found'); })();
  }
}

class InvalidRequest extends Error {
  constructor(readonly issues: unknown[]) {
    super('invalid-request');
  }
}

function parse<T extends Spec>(spec: T, value: unknown): Infer<T> {
  const parsed = parseStrictValue(spec, value);
  if (!parsed.ok) throw new InvalidRequest(parsed.issues);
  return parsed.value as Infer<T>;
}

function ok(body: unknown): FakeResponse {
  return { status: 200, body };
}
function created(body: unknown): FakeResponse {
  return { status: 201, body };
}

/**
 * The fake reached in-process, over the same wire shape: bodies are written
 * and read back as JSON text, with the session-style headers the real client's
 * transport sends (`X-Holdr-Request: 1`, never `Authorization`).
 */
export function fakeOwnerTransport(server: FakeOwnerServer): OwnerTransport {
  return {
    async request(method, path, body): Promise<TransportResult> {
      const response = server.handle({
        method,
        url: path,
        headers: { 'x-holdr-request': '1', 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : null,
      });
      return { kind: 'json', status: response.status, body: JSON.parse(JSON.stringify(response.body)) as unknown };
    },
  };
}
