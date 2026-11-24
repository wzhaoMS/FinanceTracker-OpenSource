/**
 * `CardSyncOwnerClient`: everything the Spending tab's sync controls ask of
 * Holdr, behind one interface. `createOwnerClient` speaks Holdr's owner API
 * (E2a–E2d) over a transport: in the app that is `services/api.ts` `api()`
 * (ownerTransport.ts); in tests and the explicit dev mock it is the fake
 * Holdr (fakeOwnerServer.ts). Both go through the same strict parsing, so a
 * mock can never show the UI an answer the real client would refuse.
 *
 * There is no fallback: when Holdr has no extension sync (`GET /state` says
 * so with `{extensionSync: 'not-configured'}`; a Holdr from before that
 * answered 404) or no owner API at all (an answer that is not JSON),
 * `getState` throws `unavailable` and the UI says so. It never switches to
 * fake data.
 */
import {
  CARD_SYNC_ISSUERS,
  isCardSyncId,
  type CardSyncIssue,
  type CardSyncIssuer,
  type StrictJsonLimits,
} from '@finance-tracker/shared';
import {
  BINDING,
  AUTHORITY_DEVICE_PAGE, AUTHORITY_BINDING_PAGE, AUTHORITY_PAIRING_PAGE, BINDING_DEVICE_PAGE,
  COMMIT_RESULT,
  DEVICE,
  EFFECT_PAGE,
  ERROR_BODY,
  ERROR_WITH_ISSUES,
  ERROR_WITH_RETRY,
  ERROR_WITH_VERSION,
  EVENT_REASONS,
  LARGE_ANSWER_LIMITS,
  NO_EXTENSION_SYNC,
  OWNER_API_PREFIX,
  PAIRING,
  PAIRING_AND_DEVICE,
  PAIRING_CREATED,
  PAYLOAD_ANSWER_LIMITS,
  PLAN,
  RECENT_AUTH_CONFIRMED,
  RECENT_AUTH_PATH,
  RUN_DETAIL,
  RUN_PAGE,
  SENT_PAYLOAD,
  SETTINGS,
  SET_DETAIL,
  SET_PAGE,
  SET_SUMMARY,
  STATE,
  TRANSACTION_SOURCES,
  isCardTransactionId,
  isLedgerEventId,
  isLedgerIdentityId,
  isOwnerId,
  sentPayloadMatches,
  type Binding,
  type AuthorityDevicePage, type AuthorityBindingPage, type AuthorityPairingPage, type BindingDevicePage,
  type CommitResult,
  type ConfirmBindingRequest,
  type CreateBindingRequest,
  type Decision,
  type Device,
  type DiscardReason,
  type EffectPage,
  type OwnerErrorCode,
  type OwnerState,
  type Pairing,
  type PairingAndDevice,
  type PairingCreated,
  type Plan,
  type RunDetail,
  type RunPage,
  type SentPayload,
  type SetDetail,
  type SetPage,
  type SetSummary,
  type Settings,
  type TransactionSources,
} from './ownerApi';
import { parseStrict, parseStrictValue, type Spec } from './strict';

export type HttpMethod = 'GET' | 'POST';

/** The lists of a charge's sources that come in pages (§3.8). */
export type SourcesList = 'events' | 'identities' | 'merged';
const SOURCES_CURSOR_PARAM: Record<SourcesList, string> = { events: 'eventsCursor', identities: 'identitiesCursor', merged: 'mergedRowsCursor' };

/** Times a paged read of a set starts again because the set changed between its pages, before it gives up. */
const PAGED_READ_ATTEMPTS = 3;

const SUMMARY_KEYS = Object.keys(SET_SUMMARY.keys) as Array<keyof SetSummary>;

/** A set's own fields, without its items. */
function summaryOf(detail: SetDetail): SetSummary {
  return Object.fromEntries(SUMMARY_KEYS.map((key) => [key, detail[key]])) as SetSummary;
}

/** What a transport hands back: a parsed JSON body with its status, a non-JSON answer, or no answer at all. */
export type TransportResult =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'other'; status: number }
  | { kind: 'network' };

export interface OwnerTransport {
  request(method: HttpMethod, path: string, body?: unknown): Promise<TransportResult>;
}

export type OwnerErrorKind = 'unavailable' | 'http' | 'invalid-answer' | 'network' | 'invalid-input';

/** A failed owner call. Carries only fixed codes and numbers, never a value from the request or the answer. */
export class OwnerApiError extends Error {
  constructor(
    readonly kind: OwnerErrorKind,
    readonly status: number | null = null,
    readonly code: OwnerErrorCode | null = null,
    readonly extra: { currentVersion?: number; retryAfterSeconds?: number; issues?: readonly CardSyncIssue[] } = {},
  ) {
    super(code ? `card sync owner API: ${kind} ${status ?? ''} ${code}`.trim() : `card sync owner API: ${kind}${status ? ` ${status}` : ''}`);
    this.name = 'OwnerApiError';
  }
}

export function isOwnerApiError(error: unknown, code?: OwnerErrorCode): error is OwnerApiError {
  return error instanceof OwnerApiError && (code === undefined || error.code === code);
}

/**
 * Holdr refused a continuation it gave as no longer one of its cursors (E1b revision 7: 422 `invalid-format` naming the
 * cursor): the list changed under it, or Holdr restarted. A cursor carries positions and pins, never authority, so the read
 * starts over from the first page.
 */
export function isRefusedCursor(error: unknown, path: string): boolean {
  return isOwnerApiError(error, 'invalid-request') && error.status === 422
    && (error.extra.issues ?? []).some((issue) => issue.code === 'invalid-format' && issue.path === path);
}

/**
 * After a write, whether Holdr may have done it anyway: no answer, an answer this page refused, or a server failure
 * without a fixed refusal code. A fixed 4xx code means Holdr refused it, and nothing changed. So does 503
 * `authorization-blocked`: E2a answers a plan or commit while the authorization gate is blocked (or not wired) with 503
 * (`generation-mismatch`), a refusal made before anything is written, never a failure part-way.
 */
export function isUnknownOutcome(error: unknown): boolean {
  if (!isOwnerApiError(error)) return true;
  if (error.kind === 'network' || error.kind === 'invalid-answer') return true;
  if (error.kind !== 'http') return false;
  if (error.code === 'authorization-blocked') return false;
  return error.code === null || (error.status ?? 0) >= 500;
}

export interface CardSyncOwnerClient {
  /** 'mock' only for the test and explicit dev fake; the UI labels it on screen. */
  readonly mode: 'live' | 'mock';
  getState(): Promise<OwnerState>;
  pause(): Promise<Settings>;
  resume(expectedVersion: number): Promise<Settings>;
  enableIssuer(issuer: CardSyncIssuer, options: { expectedVersion: number; mainWorldAcknowledged: boolean }): Promise<Settings>;
  disableIssuer(issuer: CardSyncIssuer): Promise<Settings>;
  createBinding(request: CreateBindingRequest): Promise<Binding>;
  confirmBinding(bindingId: string, request: ConfirmBindingRequest): Promise<Binding>;
  retireBinding(bindingId: string, expectedVersion: number): Promise<Binding>;
  /**
   * Automatic sending for one binding (Q28): on for every current browser grant, or off for all. "On" names the
   * auto-sync revision it saw (R1). Holdr answers `gate-closed` until the issuer's own gate (E4–E7) opens.
   */
  setAutoSync(bindingId: string, options: { expectedVersion: number; expectedAutoSyncRevision: number; enabled: boolean }): Promise<Binding>;
  createPairing(options: { bindingIds: string[]; replacesDeviceId: string | null }): Promise<PairingCreated>;
  cancelPairing(pairingId: string): Promise<Pairing>;
  approvePairing(pairingId: string, shown: { deviceId: string; fingerprint: string }): Promise<PairingAndDevice>;
  rejectPairing(pairingId: string, deviceId: string): Promise<PairingAndDevice>;
  revokeDevice(deviceId: string): Promise<Device>;
  /** Allows a browser again for bindings whose grant lapsed when they were confirmed again (Q35). */
  regrantDevice(deviceId: string, bindingIds: string[]): Promise<Device>;
  listObservationSets(view: 'open' | 'closed', cursor?: string | null): Promise<SetPage>;
  /** The whole set, every page of its items put together (R7): as many requests as it has pages. */
  getObservationSet(observationSetId: string): Promise<SetDetail>;
  /** Just the set's own fields (state, version, plan) from the first page of its detail: one request, however large the set. */
  getSetSummary(observationSetId: string): Promise<SetSummary>;
  recordDecisions(observationSetId: string, request: { expectedVersion: number; decisions: Decision[] }): Promise<SetDetail>;
  preparePlan(observationSetId: string, request: { expectedVersion: number; sourceReviewed: boolean }): Promise<Plan>;
  /** `payloadDigest` is null exactly for a file set's plan. */
  commitPlan(previewId: string, digests: { payloadDigest: string | null; planDigest: string }): Promise<CommitResult>;
  discardObservationSet(observationSetId: string, request: { expectedVersion: number; reason: DiscardReason }): Promise<SetSummary>;
  listRuns(options?: { bindingId?: string | null; cursor?: string | null }): Promise<RunPage>;
  getRun(runId: string): Promise<RunDetail>;
  /** The exact object a run sent (7 days). Refused unless its canonical bytes hash to the recorded digest. */
  getSentPayload(runId: string): Promise<SentPayload>;
  /** The login branch's recent-auth check (proposal Q2). The password goes in the body once and is never kept. */
  confirmPassword(password: string): Promise<{ verifiedUntil: string }>;
  /**
   * One charge's sources and history (§3.8): a page each of its aliases, the rows merged into it and its events (newest
   * first), and the change that can be undone now. `more` continues one list after its cursor; the others come as their
   * first page, as they are now.
   */
  getTransactionSources(transactionId: string, more?: { list: SourcesList; cursor: string } | null): Promise<TransactionSources>;
  /** Detaches an active alias from the charge the owner saw it on (`transactionId`, at `expectedRevision`). */
  detachIdentity(identityId: string, options: { transactionId: string; expectedRevision: number }): Promise<TransactionSources>;
  /** Moves an alias the owner saw on `fromTransactionId` to another live charge of the same card account; answers the charge it left. */
  repointIdentity(identityId: string, options: {
    fromTransactionId: string; expectedRevision: number; toTransactionId: string; expectedToRevision: number;
  }): Promise<TransactionSources>;
  /** Undoes the charge's latest reversible change, the event Holdr names as `revertibleEventId`. */
  revertChange(transactionId: string, options: { eventId: string; expectedRevision: number }): Promise<TransactionSources>;
  /** Separates a merged row from the charge it was merged into; answers the separated row. */
  unmergeTransaction(transactionId: string, options: { expectedRevision: number; expectedSurvivorRevision: number }): Promise<TransactionSources>;
}

function segment(kind: 'binding' | 'device' | 'observationSet' | 'preview' | 'run', id: string): string {
  if (!isCardSyncId(kind, id)) throw new OwnerApiError('invalid-input');
  return id;
}
function pairingSegment(id: string): string {
  if (!isOwnerId('pairing', id)) throw new OwnerApiError('invalid-input');
  return id;
}
function transactionSegment(id: string): string {
  if (!isCardTransactionId(id)) throw new OwnerApiError('invalid-input');
  return id;
}
function identitySegment(id: string): string {
  if (!isLedgerIdentityId(id)) throw new OwnerApiError('invalid-input');
  return id;
}
function revisionInput(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new OwnerApiError('invalid-input');
  return value;
}
function issuerSegment(issuer: string): string {
  if (!(CARD_SYNC_ISSUERS as readonly string[]).includes(issuer)) throw new OwnerApiError('invalid-input');
  return issuer;
}
function cursorQuery(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** The error a non-2xx answer stands for, read only through the fixed error shapes. */
function errorFor(status: number, body: unknown): OwnerApiError {
  const withIssues = parseStrict(ERROR_WITH_ISSUES, body);
  if (withIssues.ok) return new OwnerApiError('http', status, 'invalid-request', { issues: withIssues.value.issues });
  const withVersion = parseStrict(ERROR_WITH_VERSION, body);
  if (withVersion.ok) return new OwnerApiError('http', status, 'version-conflict', { currentVersion: withVersion.value.currentVersion });
  const withRetry = parseStrict(ERROR_WITH_RETRY, body);
  if (withRetry.ok) return new OwnerApiError('http', status, withRetry.value.error, { retryAfterSeconds: withRetry.value.retryAfterSeconds });
  const plain = parseStrict(ERROR_BODY, body);
  if (plain.ok) return new OwnerApiError('http', status, plain.value.error);
  return new OwnerApiError('http', status, null);
}

export function createOwnerClient(transport: OwnerTransport, mode: 'live' | 'mock' = 'live'): CardSyncOwnerClient {
  /**
   * One owner call. `unavailableWithoutSync` is for the state read: Holdr's answer that it has no extension sync (or the
   * 404 a Holdr from before that sent), and a page server's HTML or empty answer, mean "not available", not an error.
   */
  async function call(
    method: HttpMethod,
    path: string,
    spec: Spec,
    options: { body?: unknown; limits?: Partial<StrictJsonLimits>; unavailableWithoutSync?: boolean } = {},
  ): Promise<unknown> {
    let result: TransportResult;
    try {
      result = await transport.request(method, path, method === 'POST' ? options.body ?? {} : undefined);
    } catch {
      result = { kind: 'network' };
    }
    if (result.kind === 'network') throw new OwnerApiError('network');
    if (result.kind === 'other') {
      // A page server's HTML (an SPA fallback) or an empty answer: not Holdr's owner API.
      if (options.unavailableWithoutSync && (result.status === 404 || (result.status >= 200 && result.status < 300))) {
        throw new OwnerApiError('unavailable', result.status);
      }
      throw new OwnerApiError(result.status >= 200 && result.status < 300 ? 'invalid-answer' : 'http', result.status);
    }
    if (result.status < 200 || result.status > 299) {
      if (options.unavailableWithoutSync && result.status === 404) throw new OwnerApiError('unavailable', 404);
      throw errorFor(result.status, result.body);
    }
    if (options.unavailableWithoutSync && parseStrict(NO_EXTENSION_SYNC, result.body).ok) {
      throw new OwnerApiError('unavailable', result.status);
    }
    const parsed = parseStrictValue(spec, result.body, options.limits);
    if (!parsed.ok) throw new OwnerApiError('invalid-answer', result.status, null, { issues: parsed.issues });
    return parsed.value;
  }

  const owner = (path: string) => `${OWNER_API_PREFIX}${path}`;
  const setPath = (id: string, action = '') => owner(`/observation-sets/${segment('observationSet', id)}${action}`);

  /** One page of a set's detail (R7); `cursor` null for the first. */
  const setPage = async (id: string, cursor: string | null) => checkedSet((await call('GET', `${setPath(id)}${cursorQuery({ itemsCursor: cursor })}`, SET_DETAIL, {
    limits: LARGE_ANSWER_LIMITS,
  })) as SetDetail);

  /**
   * The whole set from its first page: the remaining pages, put together. Null when the set changed between pages, so the
   * caller reads it again from the start: Holdr refuses a later page whose pins (the set's version, the card's ledger revision
   * and whether the set is past its deadline) moved with 409 `version-conflict` (R7; E1b revision 7, X38), and the client also
   * compares the version itself. A continuation Holdr no longer takes (422 on `itemsCursor`, as after a restart that changed
   * how it signs cursors) also starts over. Pages that repeat, overrun, come back empty or don't add up to `itemCount` are
   * refused as an invalid answer: the page never shows part of a set as the whole.
   */
  async function withAllItems(id: string, first: SetDetail): Promise<SetDetail | null> {
    const items = [...first.items];
    const cursors = new Set<string>();
    let cursor = first.nextItemsCursor;
    while (cursor !== null) {
      if (cursors.has(cursor) || items.length >= first.itemCount) throw new OwnerApiError('invalid-answer', 200);
      cursors.add(cursor);
      let page: SetDetail;
      try {
        page = await setPage(id, cursor);
      } catch (error) {
        if (isOwnerApiError(error, 'version-conflict') || isRefusedCursor(error, '$.itemsCursor')) return null;
        throw error;
      }
      if (page.observationSetId !== first.observationSetId) throw new OwnerApiError('invalid-answer', 200);
      if (page.version !== first.version) return null;
      if (page.items.length === 0) throw new OwnerApiError('invalid-answer', 200);
      items.push(...page.items);
      cursor = page.nextItemsCursor;
    }
    if (items.length !== first.itemCount || new Set(items.map((entry) => entry.itemId)).size !== items.length) {
      throw new OwnerApiError('invalid-answer', 200);
    }
    return { ...first, items, nextItemsCursor: null };
  }

  async function readSet(id: string): Promise<SetDetail> {
    for (let attempt = 0; attempt < PAGED_READ_ATTEMPTS; attempt += 1) {
      const whole = await withAllItems(id, await setPage(id, null));
      if (whole) return whole;
    }
    // It kept changing while it was read, as when a write loses a race: the owner reads it again.
    throw new OwnerApiError('http', 409, 'version-conflict');
  }

  const appendUnique = <T,>(into: T[], rows: T[], key: (row: T) => string) => {
    const known = new Set(into.map(key));
    for (const row of rows) if (!known.has(key(row))) { into.push(row); known.add(key(row)); }
  };

  async function walkAuthority<T extends { nextCursor: string | null }>(
    first: string | null | undefined, path: string, spec: Spec, apply: (page: T) => void,
  ): Promise<void> {
    let cursor = first ?? null;
    const seen = new Set<string>();
    while (cursor !== null) {
      if (seen.has(cursor)) throw new OwnerApiError('invalid-answer', 200);
      seen.add(cursor);
      const page = await call('GET', owner(`${path}${cursorQuery({ cursor })}`), spec, { limits: LARGE_ANSWER_LIMITS }) as T;
      apply(page);
      cursor = page.nextCursor;
    }
  }

  /** Like large set/effect reads, consume every bounded page before publishing a complete authorization inventory. */
  async function readState(): Promise<OwnerState> {
    for (let attempt = 0; attempt < PAGED_READ_ATTEMPTS; attempt++) {
      const state = await call('GET', owner('/state'), STATE, { unavailableWithoutSync: true, limits: LARGE_ANSWER_LIMITS }) as OwnerState;
      try {
        await walkAuthority<AuthorityDevicePage>(state.inventory?.devices.nextCursor, '/devices', AUTHORITY_DEVICE_PAGE, (page) => {
          appendUnique(state.devices, page.devices, (row) => row.deviceId);
          appendUnique(state.quota.devices, page.quota, (row) => row.deviceId);
          if (state.inventory) state.inventory.devices.total = page.total;
        });
        await walkAuthority<AuthorityBindingPage>(state.inventory?.bindings.nextCursor, '/bindings', AUTHORITY_BINDING_PAGE, (page) => {
          appendUnique(state.bindings, page.bindings, (row) => row.bindingId);
          if (state.inventory) state.inventory.bindings.total = page.total;
        });
        await walkAuthority<AuthorityPairingPage>(state.inventory?.pairings.nextCursor, '/pairings', AUTHORITY_PAIRING_PAGE, (page) => {
          appendUnique(state.pairings, page.pairings, (row) => row.pairingId);
          if (state.inventory) state.inventory.pairings.total = page.total;
        });
        for (const binding of state.bindings) {
          await walkAuthority<BindingDevicePage>(binding.deviceInventory?.nextCursor,
            `/bindings/${segment('binding', binding.bindingId)}/devices`, BINDING_DEVICE_PAGE, (page) => {
              appendUnique(binding.deviceIds, page.devices.map((row) => row.deviceId), (id) => id);
              appendUnique(binding.autoSync.devices, page.devices.filter((row) => row.status === 'active')
                .map(({ deviceId, enabled, consentedAt }) => ({ deviceId, enabled, consentedAt })), (row) => row.deviceId);
              if (binding.deviceInventory) {
                binding.deviceInventory.total = page.total;
                binding.deviceInventory.active = page.active;
              }
            });
          if (binding.deviceInventory) {
            if (binding.deviceIds.length < binding.deviceInventory.total || binding.autoSync.devices.length < binding.deviceInventory.active) {
              throw new OwnerApiError('invalid-answer', 200);
            }
            binding.deviceInventory.nextCursor = null;
          }
        }
        if (state.inventory) {
          if (state.devices.filter((row) => row.status === 'active' || row.status === 'pending').length < state.inventory.devices.total
            || state.bindings.filter((row) => row.status !== 'retired').length < state.inventory.bindings.total
            || state.pairings.filter((row) => row.status === 'open' || row.status === 'redeemed').length < state.inventory.pairings.total) {
            throw new OwnerApiError('invalid-answer', 200);
          }
          for (const entry of Object.values(state.inventory)) entry.nextCursor = null;
        }
        return state;
      } catch (error) {
        if (!isRefusedCursor(error, '$.cursor')) throw error;
      }
    }
    throw new OwnerApiError('http', 409, 'version-conflict');
  }

  /**
   * The plan with every effect: its first page, then `GET /plans/:previewId/effects` until the last (R7). Every page
   * echoes the plan's digest, which must be this plan's, and its state (X42): a page that says the plan was replaced, ran
   * out, or was committed (from another window) ends the read, and the set is read again.
   */
  async function withAllEffects(plan: Plan): Promise<Plan> {
    const effects = [...plan.effects];
    const cursors = new Set<string>();
    let cursor = plan.nextEffectsCursor;
    while (cursor !== null) {
      if (cursors.has(cursor) || effects.length >= plan.effectCount) throw new OwnerApiError('invalid-answer', 200);
      cursors.add(cursor);
      const page = (await call('GET', owner(`/plans/${segment('preview', plan.previewId)}/effects${cursorQuery({ cursor })}`), EFFECT_PAGE, {
        limits: LARGE_ANSWER_LIMITS,
      })) as EffectPage;
      if (page.previewId !== plan.previewId || page.planDigest !== plan.planDigest || page.effects.length === 0) {
        throw new OwnerApiError('invalid-answer', 200);
      }
      if (page.state === 'superseded' || page.state === 'committed') throw new OwnerApiError('http', 409, 'preview-stale');
      if (page.state === 'expired') throw new OwnerApiError('http', 410, 'plan-expired');
      effects.push(...page.effects);
      cursor = page.nextCursor;
    }
    if (effects.length !== plan.effectCount || !aliasesHoldTogether(plan, effects) || !effectsFitSource(plan, effects)) {
      throw new OwnerApiError('invalid-answer', 200);
    }
    return { ...plan, effects, nextEffectsCursor: null };
  }

  return {
    mode,
    getState: readState,
    pause: async () => (await call('POST', owner('/pause'), SETTINGS)) as Settings,
    resume: async (expectedVersion) => (await call('POST', owner('/resume'), SETTINGS, { body: { expectedVersion } })) as Settings,
    enableIssuer: async (issuer, options) => (await call('POST', owner(`/issuers/${issuerSegment(issuer)}/enable`), SETTINGS, {
      body: { expectedVersion: options.expectedVersion, riskAcknowledged: true, mainWorldAcknowledged: options.mainWorldAcknowledged },
    })) as Settings,
    disableIssuer: async (issuer) => (await call('POST', owner(`/issuers/${issuerSegment(issuer)}/disable`), SETTINGS)) as Settings,
    createBinding: async (request) => (await call('POST', owner('/bindings'), BINDING, { body: request })) as Binding,
    confirmBinding: async (bindingId, request) => (await call(
      'POST', owner(`/bindings/${segment('binding', bindingId)}/confirm`), BINDING, { body: request },
    )) as Binding,
    retireBinding: async (bindingId, expectedVersion) => (await call(
      'POST', owner(`/bindings/${segment('binding', bindingId)}/retire`), BINDING, { body: { expectedVersion } },
    )) as Binding,
    setAutoSync: async (bindingId, options) => (await call('POST', owner(`/bindings/${segment('binding', bindingId)}/auto-sync`), BINDING, {
      body: { expectedVersion: options.expectedVersion, expectedAutoSyncRevision: options.expectedAutoSyncRevision, enabled: options.enabled },
    })) as Binding,
    createPairing: async (options) => (await call('POST', owner('/pairings'), PAIRING_CREATED, {
      body: { bindingIds: options.bindingIds, replacesDeviceId: options.replacesDeviceId },
    })) as PairingCreated,
    cancelPairing: async (pairingId) => (await call('POST', owner(`/pairings/${pairingSegment(pairingId)}/cancel`), PAIRING)) as Pairing,
    approvePairing: async (pairingId, shown) => (await call('POST', owner(`/pairings/${pairingSegment(pairingId)}/approve`), PAIRING_AND_DEVICE, {
      body: { deviceId: shown.deviceId, fingerprint: shown.fingerprint },
    })) as PairingAndDevice,
    rejectPairing: async (pairingId, deviceId) => (await call('POST', owner(`/pairings/${pairingSegment(pairingId)}/reject`), PAIRING_AND_DEVICE, {
      body: { deviceId },
    })) as PairingAndDevice,
    revokeDevice: async (deviceId) => (await call('POST', owner(`/devices/${segment('device', deviceId)}/revoke`), DEVICE)) as Device,
    regrantDevice: async (deviceId, bindingIds) => (await call('POST', owner(`/devices/${segment('device', deviceId)}/regrant`), DEVICE, {
      body: { bindingIds: bindingIds.map((bindingId) => segment('binding', bindingId)) },
    })) as Device,
    listObservationSets: async (view, cursor) => {
      const page = (await call('GET', owner(`/observation-sets${cursorQuery({ view, cursor })}`), SET_PAGE, {
        limits: LARGE_ANSWER_LIMITS,
      })) as SetPage;
      page.observationSets.forEach(checkedSet);
      return page;
    },
    getObservationSet: (observationSetId) => readSet(observationSetId),
    getSetSummary: async (observationSetId) => summaryOf(await setPage(observationSetId, null)),
    recordDecisions: async (observationSetId, request) => {
      const first = checkedSet((await call('POST', setPath(observationSetId, '/decisions'), SET_DETAIL, {
        body: { expectedVersion: request.expectedVersion, decisions: request.decisions },
        limits: LARGE_ANSWER_LIMITS,
      })) as SetDetail);
      // Saved. The other pages follow; if the set moved meanwhile, the whole of its newer version.
      return (await withAllItems(observationSetId, first)) ?? readSet(observationSetId);
    },
    preparePlan: async (observationSetId, request) => withAllEffects((await call('POST', setPath(observationSetId, '/plan'), PLAN, {
      body: { expectedVersion: request.expectedVersion, sourceReviewed: request.sourceReviewed },
      limits: LARGE_ANSWER_LIMITS,
    })) as Plan),
    commitPlan: async (previewId, digests) => (await call('POST', owner(`/plans/${segment('preview', previewId)}/commit`), COMMIT_RESULT, {
      body: { payloadDigest: digests.payloadDigest, planDigest: digests.planDigest },
    })) as CommitResult,
    discardObservationSet: async (observationSetId, request) => checkedSet((await call('POST', setPath(observationSetId, '/discard'), SET_SUMMARY, {
      body: { expectedVersion: request.expectedVersion, reason: request.reason },
    })) as SetSummary),
    listRuns: async (options = {}) => {
      if (options.bindingId) segment('binding', options.bindingId);
      return (await call('GET', owner(`/runs${cursorQuery({ bindingId: options.bindingId, cursor: options.cursor })}`), RUN_PAGE)) as RunPage;
    },
    getRun: async (runId) => (await call('GET', owner(`/runs/${segment('run', runId)}`), RUN_DETAIL, { limits: LARGE_ANSWER_LIMITS })) as RunDetail,
    getSentPayload: async (runId) => {
      const sent = (await call('GET', owner(`/runs/${segment('run', runId)}/payload`), SENT_PAYLOAD, { limits: PAYLOAD_ANSWER_LIMITS })) as SentPayload;
      if (sent.runId !== runId || !sentPayloadMatches(sent)) throw new OwnerApiError('invalid-answer', 200);
      return sent;
    },
    confirmPassword: async (password) => {
      if (typeof password !== 'string' || password.length === 0 || password.length > 1_024) throw new OwnerApiError('invalid-input');
      return (await call('POST', RECENT_AUTH_PATH, RECENT_AUTH_CONFIRMED, { body: { password } })) as { verifiedUntil: string };
    },
    getTransactionSources: async (transactionId, more) => {
      const query = more ? cursorQuery({ [SOURCES_CURSOR_PARAM[more.list]]: more.cursor }) : '';
      return sourcesOf(transactionId, await call(
        'GET', owner(`/transactions/${transactionSegment(transactionId)}/sources${query}`), TRANSACTION_SOURCES, { limits: LARGE_ANSWER_LIMITS },
      ));
    },
    detachIdentity: async (identityId, options) => {
      const body = { transactionId: transactionSegment(options.transactionId), expectedRevision: revisionInput(options.expectedRevision) };
      return sourcesOf(options.transactionId, await call('POST', owner(`/identities/${identitySegment(identityId)}/detach`), TRANSACTION_SOURCES, {
        body,
        limits: LARGE_ANSWER_LIMITS,
      }));
    },
    repointIdentity: async (identityId, options) => {
      if (options.toTransactionId === options.fromTransactionId) throw new OwnerApiError('invalid-input');
      const body = {
        fromTransactionId: transactionSegment(options.fromTransactionId),
        toTransactionId: transactionSegment(options.toTransactionId),
        expectedRevision: revisionInput(options.expectedRevision),
        expectedToRevision: revisionInput(options.expectedToRevision),
      };
      return sourcesOf(options.fromTransactionId, await call('POST', owner(`/identities/${identitySegment(identityId)}/repoint`), TRANSACTION_SOURCES, {
        body,
        limits: LARGE_ANSWER_LIMITS,
      }));
    },
    revertChange: async (transactionId, options) => {
      if (!isLedgerEventId(options.eventId)) throw new OwnerApiError('invalid-input');
      return sourcesOf(transactionId, await call('POST', owner(`/transactions/${transactionSegment(transactionId)}/revert`), TRANSACTION_SOURCES, {
        body: { eventId: options.eventId, expectedRevision: revisionInput(options.expectedRevision) },
        limits: LARGE_ANSWER_LIMITS,
      }));
    },
    unmergeTransaction: async (transactionId, options) => sourcesOf(transactionId, await call(
      'POST', owner(`/transactions/${transactionSegment(transactionId)}/unmerge`), TRANSACTION_SOURCES, {
        body: { expectedRevision: revisionInput(options.expectedRevision), expectedSurvivorRevision: revisionInput(options.expectedSurvivorRevision) },
        limits: LARGE_ANSWER_LIMITS,
      },
    )),
  };
}

/**
 * A charge's sources, checked to be the charge asked about and to hold together: no alias, merged row or event twice,
 * every merged row removed by a merge into it on the same card account, every event with a reason its type allows, device
 * events naming their device, reversals naming what they undo, and re-points naming the other row: with this row's revision
 * where the alias came from, with none (an alias that left, revision 4) the row it joined. Anything else is an invalid
 * answer, never shown.
 */
function sourcesOf(transactionId: string, answer: unknown): TransactionSources {
  const sources = answer as TransactionSources;
  if (sources.transaction.transactionId !== transactionId || !rowHoldsTogether(sources.transaction)) throw new OwnerApiError('invalid-answer', 200);
  const ids = new Set(sources.identities.map((identity) => identity.identityId));
  if (ids.size !== sources.identities.length) throw new OwnerApiError('invalid-answer', 200);
  const mergedIds = new Set(sources.mergedRows.map((merged) => merged.transactionId));
  if (mergedIds.size !== sources.mergedRows.length) throw new OwnerApiError('invalid-answer', 200);
  for (const merged of sources.mergedRows) {
    if (merged.mergedIntoId !== transactionId || merged.cardAccountRef !== sources.transaction.cardAccountRef || !rowHoldsTogether(merged)) {
      throw new OwnerApiError('invalid-answer', 200);
    }
  }
  if (new Set(sources.events.map((event) => event.eventId)).size !== sources.events.length) throw new OwnerApiError('invalid-answer', 200);
  for (const event of sources.events) {
    const repointed = event.eventType === 'identity-repointed';
    if ((event.revision === null && !repointed) || (repointed && (event.relatedTransactionId === null || event.relatedTransactionId === transactionId))
      || !EVENT_REASONS[event.eventType].includes(event.reason)
      || (IDENTITY_EVENTS.has(event.eventType) && event.identityId === null)
      || (MERGE_EVENTS.has(event.eventType) && event.relatedTransactionId === null)
      || (event.eventType === 'user-edited') !== (event.edited.length > 0)
      || (event.actor === 'device') !== (event.deviceId !== null) || (event.eventType === 'reversed') !== (event.reversesEventId !== null)) {
      throw new OwnerApiError('invalid-answer', 200);
    }
  }
  // The change offered for undo, when it is on this page: a change a person decided, of this row (§3.8). It may be older.
  const offered = sources.events.find((event) => event.eventId === sources.revertibleEventId);
  if (offered && (!REVERSIBLE_EVENTS.has(offered.eventType) || offered.revision === null || offered.actor !== 'owner')) {
    throw new OwnerApiError('invalid-answer', 200);
  }
  return sources;
}

/** E1b's event constraints the page relies on: an alias event names its alias, a merge its other row (`ck_evt_*`). */
const IDENTITY_EVENTS: ReadonlySet<string> = new Set(['identity-linked', 'identity-repointed', 'identity-detached']);
const MERGE_EVENTS: ReadonlySet<string> = new Set(['superseded', 'settled-into']);
/** The changes `revert` undoes (E1b §5.7.1). */
const REVERSIBLE_EVENTS: ReadonlySet<string> = new Set(['corrected', 'promoted', 'restored', 'attributed']);

/**
 * A row's removal fields agree with its values: a removal reason only on a removed row, and a merge reason (`superseded`,
 * `settled-into`) exactly when it names another row it was merged into.
 */
function rowHoldsTogether(row: TransactionSources['transaction']): boolean {
  const mergeReason = row.removedReason === 'superseded' || row.removedReason === 'settled-into';
  return (row.removedReason === null || row.values.status === 'removed') && mergeReason === (row.mergedIntoId !== null)
    && row.mergedIntoId !== row.transactionId;
}

const TXN_VALUE_KEYS = ['status', 'transactionDate', 'postedDate', 'amountMinor', 'kind', 'description', 'merchant', 'cardScopeId'] as const;

/**
 * E1b revision 7 (X37): an `alias` effect is an observed row Holdr already has, with the same values, that adds a new source
 * to it. It names that row and an observed row, leaves the values exactly as they were (before = after), and the plan's
 * `aliased` count is the number of them. Anything else would show a change as "already in spending", or the reverse.
 */
function aliasesHoldTogether(plan: Plan, effects: Plan['effects']): boolean {
  const aliases = effects.filter((effect) => effect.effect === 'alias');
  return aliases.length === plan.counts.aliased && aliases.every((effect) => effect.transactionId !== null && effect.rowIndex !== null
    && effect.before !== null && effect.after !== null
    && TXN_VALUE_KEYS.every((key) => effect.before![key] === effect.after![key]));
}

/** An extension set's rows are payload ordinals (at most 2,000 rows, E1a); a v1 file set's are file positions (0–9,999). */
const EXTENSION_SET_ROWS = 2_000;

/**
 * A set's source decides its shape (E1b's `ck_set_extension_shape` and `ck_set_file_shape`; E2d, §5.5/§5.6). A file set has
 * no run, binding or device, names its import batch, has no payload digest or coverage, and its rows are `legacy-file` at
 * their file positions, in its card account's currency. An extension set has all three and no batch, is in USD (E1a), and
 * its rows are the extension's own (stable or capture) at payload ordinals.
 */
function setHoldsTogether(set: SetSummary | SetDetail): boolean {
  const file = set.sourceKind === 'file';
  if ((set.runId === null) !== file || (set.bindingId === null) !== file || (set.deviceId === null) !== file
    || (set.importBatchId !== null) !== file) return false;
  if (!('items' in set)) return true;
  if (file ? set.payloadDigest !== null || set.coverage.length > 0 : set.currency !== 'USD') return false;
  return set.items.every((item) => (item.observation === null || (item.observation.identity === 'legacy-file') === file)
    && (file || ((item.rowIndex ?? 0) < EXTENSION_SET_ROWS && (item.observation?.rowIndex ?? 0) < EXTENSION_SET_ROWS)));
}

/** A set as Holdr answered it, refused as an invalid answer unless its shape fits its source. */
function checkedSet<T extends SetSummary | SetDetail>(set: T): T {
  if (!setHoldsTogether(set)) throw new OwnerApiError('invalid-answer', 200);
  return set;
}

/** A plan names rows as its set does: an extension set's plan (the one with a payload digest) by payload ordinal. */
function effectsFitSource(plan: Plan, effects: Plan['effects']): boolean {
  return plan.payloadDigest === null || effects.every((effect) => effect.rowIndex === null || effect.rowIndex < EXTENSION_SET_ROWS);
}