import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, type JsonValue } from '@finance-tracker/shared';
import { newCardSyncId, pairingCodeDigest, randomCardSyncLetters } from '../../services/cardSyncDigests.js';
import { cardSyncRefusal, type CardSyncRefusalCode } from '../../services/cardSync/refusals.js';
import { cardSyncDeviceWorld, DEVICE_TEST_ORIGIN } from '../../testing/cardSyncDeviceWorld.js';
import { SCENARIO_OWNER } from '../../testing/cardSyncScenario.js';
import { DEVICE_EXTENSION_ORIGINS } from './deviceCors.js';
import { DEVICE_ENDPOINTS, DeviceHttpError, type DeviceHttpCode } from './deviceProtocol.js';
import { deviceError } from './deviceResponses.js';

// Load the actual E3 client without making extension source part of the API's production TypeScript build.
const extension = (file: string) => import(new URL(`../../../../extension/${file}`, import.meta.url).href);

/** The device answer (status and code) E2c gives an error, through its real error mapping. */
function answerTo(error: unknown): { status: number; error: string } {
  let status = 0;
  let body: { error: string } = { error: '' };
  const res = {
    headersSent: false, destroyed: false, setHeader: () => undefined,
    status: (value: number) => { status = value; return { json: (value: { error: string }) => { body = value; } }; },
  };
  deviceError({} as never, res as never, error, () => undefined);
  return { status, error: body.error };
}
const deviceAnswer = (code: CardSyncRefusalCode) => answerTo(cardSyncRefusal(code));

/** E2c's own protocol-level answers (deviceAuth, deviceBody, deviceCors, deviceProtocol, device.ts): `bad-request` comes with three statuses. */
const PROTOCOL_ANSWERS: ReadonlyArray<readonly [number, DeviceHttpCode]> = [
  [400, 'bad-request'], [408, 'bad-request'], [422, 'bad-request'], [401, 'unauthorized'], [401, 'pairing-invalid'], [429, 'pairing-locked'],
  [403, 'device-pending'], [403, 'credential-not-allowed'], [429, 'rate-limited'], [503, 'unavailable'], [413, 'too-large'],
  [415, 'unsupported-media-type'], [500, 'internal-error'], [404, 'not-found'], [404, 'run-not-found'], [409, 'idempotency-conflict'],
  [409, 'plan-mismatch'], [422, 'payload-invalid'], [400, 'payload-digest-mismatch'],
];

/** Repository refusals a device route can meet (run creation, acceptance, device prepare and commit, receipts, aborts, redeem). */
const DEVICE_REFUSALS: readonly CardSyncRefusalCode[] = [
  'principal-not-allowed', 'generation-mismatch', 'not-found', 'sync-paused', 'issuer-disabled', 'contract-unsupported',
  'binding-needs-reconfirmation', 'binding-retired', 'binding-stale', 'device-not-active', 'run-not-found', 'run-closed', 'run-expired',
  'idempotency-conflict', 'payload-invalid', 'payload-digest-mismatch', 'scope-not-in-binding', 'capture-already-accepted',
  'review-quota-exceeded', 'too-many-open-runs', 'run-rate-limited', 'set-closed', 'observation-expired', 'plan-not-found', 'plan-expired',
  'plan-cancelled', 'preview-stale', 'plan-mismatch', 'plan-needs-review', 'plan-quota-exceeded',
];

describe.skipIf(process.platform !== 'darwin')('E2c with the E3 client and its strict schemas (M1–M7 applied)', () => {
  let f: Awaited<ReturnType<typeof cardSyncDeviceWorld>>;
  let e3: any;
  let strict: any;
  let clients: any;
  let binding: ReturnType<Awaited<ReturnType<typeof cardSyncDeviceWorld>>['w']['binding']>;
  let device: ReturnType<Awaited<ReturnType<typeof cardSyncDeviceWorld>>['w']['device']>;
  beforeAll(async () => {
    [e3, strict, clients] = await Promise.all([
      extension('src/contracts/holdrApi.ts'), extension('src/common/strict.ts'), extension('src/worker/holdrClient.ts'),
    ]);
    f = await cardSyncDeviceWorld();
    f.w.enable();
    binding = f.w.binding();
    device = f.w.device([binding.bindingId]);
    await f.syncFence();
  });
  afterAll(async () => { await f?.close(); });

  /**
   * The E3 client as the extension builds it, pinned to `origin` and naming `clientVersion` (the scenario pairs its
   * devices as 1.2.3). The test transport forwards exactly the client's own request headers: nothing is added.
   */
  const client = (options: { clientVersion?: string; origin?: string } = {}) => clients.createHoldrClient({
    origin: options.origin ?? DEVICE_TEST_ORIGIN, requireHttps: true, timeoutMs: 20_000, clientVersion: options.clientVersion ?? '1.2.3',
    fetchImpl: async (url: string, init: RequestInit) => {
      expect(new URL(url).origin).toBe(options.origin ?? DEVICE_TEST_ORIGIN);
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', mode: 'cors' });
      const headers = Array.from(new Headers(init.headers).entries());
      expect(headers.some(([name]) => name === 'cookie')).toBe(false);
      expect(headers).toContainEqual(['x-holdr-client', 'extension-v1']);
      const result = await f.raw(init.method!, new URL(url).pathname, headers, Buffer.from(init.body as string ?? ''));
      return new Response(new Uint8Array(result.bytes), { status: result.status, headers: result.headers });
    },
  });

  it('pins the exact eight E3 routes and the production extension id, never its HTTP fake-issuer test id', async () => {
    const manifest = await extension('build/manifest.ts');
    expect(DEVICE_EXTENSION_ORIGINS).toEqual([`chrome-extension://${manifest.KEYS.production.id}`]);
    expect(DEVICE_EXTENSION_ORIGINS).not.toContain(`chrome-extension://${manifest.KEYS.test.id}`);
    expect(manifest.TEST_HOST.test(DEVICE_TEST_ORIGIN)).toBe(false);
    expect(e3.HOLDR_ROUTES).toHaveLength(DEVICE_ENDPOINTS.length);
    for (const endpoint of DEVICE_ENDPOINTS) {
      const path = `/card-sync${endpoint.path.replace(':runId', newCardSyncId('run_'))}`;
      expect(e3.HOLDR_ROUTES.filter((route: any) => route.method === endpoint.method.toUpperCase() && route.path.test(path))).toHaveLength(1);
    }
  });

  it('M1/M2: the client names its version on every request and takes capabilities only with Holdr’s own origin', async () => {
    const own = await client().capabilities(device.token);
    expect(own).toMatchObject({ ok: true, value: { holdrOrigin: DEVICE_TEST_ORIGIN, deviceId: device.deviceId } });
    // Another build than the one the device was paired with is refused, and never updates the grant.
    expect(await client({ clientVersion: '1.2.4' }).capabilities(device.token)).toMatchObject({ ok: false, kind: 'http', status: 401, code: 'unauthorized' });
    expect(f.repo.getCardSyncDevice(device.deviceId)!.clientVersion).toBe('1.2.3');
    // A client pinned to another origin does not take this Holdr's capabilities as its own.
    expect(await client({ origin: 'https://holdr.example' }).capabilities(device.token)).toMatchObject({ ok: false, kind: 'protocol', status: 200 });
    const raw = await f.request('GET', '/card-sync/capabilities', undefined, f.deviceHeaders(device.token));
    expect(strict.parseStrict(raw.json, e3.CAPABILITIES).ok).toBe(true);
  });

  it('round-trips E3 run/upload/owner-review/receipt/abort with the client’s own headers', async () => {
    const api = client();
    const clientRunId = `crn_${randomCardSyncLetters()}`;
    const created = await api.createRun(device.token, {
      clientRunId, bindingId: binding.bindingId, bindingVersion: binding.bindingVersion,
      adapterVersion: 'holdr-ext@0.1.0', contractVersion: 1, trigger: 'manual',
    });
    expect(created.ok).toBe(true);
    const payload = f.w.payload(binding, [{
      scope: f.w.scopes(binding).known[0], date: '2026-10-01', amount: 250, description: 'Synthetic café',
    }]);
    const received = await api.submitObservation(device.token, created.value.runId, canonicalJson(payload as unknown as JsonValue), clientRunId);
    expect(received.ok).toBe(true);
    const plan = await api.preparePlan(device.token, created.value.runId, received.value.observationSetId);
    expect(plan.ok).toBe(true);
    expect(plan.value.status).toBe('owner-review');
    expect(plan.value).not.toHaveProperty('previewId');
    expect((await api.receipt(device.token, created.value.runId)).ok).toBe(true);
    expect((await api.abort(device.token, created.value.runId, 'user-cancelled')).ok).toBe(true);
  });

  it('M3: redeems through the E3 client and its dedicated exact bearer-response parser, with a label both sides accept', async () => {
    const code = randomCardSyncLetters();
    f.repo.createCardSyncPairing({
      actorRef: SCENARIO_OWNER, codeDigest: pairingCodeDigest(code), bindingIds: [binding.bindingId],
      replacesDeviceId: null, ...f.w.step(),
    });
    await f.syncFence();
    // The client refuses what the API would (a digit first, more than 32 characters) before the network.
    expect(strict.parseStrict({ clientVersion: '1.2.3', deviceLabel: '2nd Chrome' }, e3.REDEEM_REQUEST).ok).toBe(false);
    expect(strict.parseStrict({ clientVersion: '1.2.3', deviceLabel: `A${'b'.repeat(32)}` }, e3.REDEEM_REQUEST).ok).toBe(false);
    const result = await client().redeem(code, 'Synthetic Chrome', '1.2.3');
    expect(result.ok).toBe(true);
    expect(result.value.status).toBe('pending');
    expect(result.value.fingerprint).toMatch(e3.DEVICE_FINGERPRINT);
    expect(f.repo.getCardSyncDevice(result.value.deviceId)!.status).toBe('pending');
    // The pending device's capabilities read through the same strict parser.
    await f.syncFence();
    expect(await client().capabilities(result.value.deviceToken)).toMatchObject({ ok: true, value: { status: 'pending', bindings: [] } });
  });

  it('round-trips E3 executable prepare and commit; M7: a replay after the commit is acknowledged as committed', async () => {
    const values = [{
      scope: f.w.scopes(binding).known[0], date: '2026-10-04', amount: 1700, description: 'Synthetic ticket', id: 'compat-stable',
    }];
    f.w.ingest(device, binding, values);
    const api = client();
    const clientRunId = `crn_${randomCardSyncLetters()}`;
    const created = await api.createRun(device.token, {
      clientRunId, bindingId: binding.bindingId, bindingVersion: binding.bindingVersion,
      adapterVersion: 'holdr-ext@0.1.0', contractVersion: 1, trigger: 'manual',
    });
    expect(created.ok).toBe(true);
    const payload = canonicalJson(f.w.payload(binding, values) as unknown as JsonValue);
    const received = await api.submitObservation(device.token, created.value.runId, payload, clientRunId);
    expect(received.ok).toBe(true);
    const plan = await api.preparePlan(device.token, created.value.runId, received.value.observationSetId);
    expect(plan.ok).toBe(true);
    expect(plan.value.status).toBe('executable');
    const committed = await api.commit(device.token, {
      runId: created.value.runId, previewId: plan.value.previewId,
      payloadDigest: plan.value.payloadDigest, planDigest: plan.value.planDigest,
    });
    expect(committed.ok).toBe(true);
    expect(committed.value).toMatchObject({ status: 'committed', inserted: 0, updated: 0 });
    const replay = await api.submitObservation(device.token, created.value.runId, payload, clientRunId);
    expect(replay).toMatchObject({ ok: true, value: { status: 'committed', observationSetId: received.value.observationSetId } });
    const receipt = await api.receipt(device.token, created.value.runId);
    expect(receipt.ok).toBe(true);
    expect(receipt.value.ledger).toBe('committed');
  });

  it('M5: every answer a device route gives a repository refusal is in the client’s table with its status; D’s codes too', () => {
    for (const refusal of DEVICE_REFUSALS) {
      const { status, error } = deviceAnswer(refusal);
      expect(e3.HOLDR_ERROR_STATUS[error], `${refusal} -> ${error}`).toBe(status);
      expect(e3.holdrErrorStatusFits(error, status), `${refusal} -> ${error} ${status}`).toBe(true);
      expect(strict.parseStrict({ error }, e3.HOLDR_ERROR).ok, error).toBe(true);
    }
    // E2c's protocol-level answers, through the same mapper: each is a refusal the client takes as Holdr's (M5).
    for (const [status, code] of PROTOCOL_ANSWERS) {
      expect(answerTo(new DeviceHttpError(status, code))).toEqual({ status, error: code });
      expect(e3.holdrErrorStatusFits(code, status), `${code} ${status}`).toBe(true);
    }
    for (const [error, status] of [['authorization-blocked', 409], ['ingress-unverified', 503], ['ingress-refused', 503], ['device-transport-refused', 403]] as const) {
      expect(e3.HOLDR_ERROR_STATUS[error], error).toBe(status);
      expect(e3.holdrErrorStatusFits(error, status), error).toBe(true);
    }
    for (const error of ['credential-not-allowed', 'internal-error', 'unauthorized', 'device-pending', 'bad-request', 'too-large', 'unsupported-media-type', 'unavailable', 'rate-limited']) {
      expect(strict.parseStrict({ error }, e3.HOLDR_ERROR).ok, error).toBe(true);
    }
  });

  it('M4: returns every legal card hint, and the client reads them all', async () => {
    const manyCards = f.w.binding({
      scopes: Array.from({ length: 21 }, (_, index) => ({
        label: `Synthetic card ${index}`, holderAlias: 'member-a', last4: String(5184 + index),
      })),
    });
    const paired = f.w.device([manyCards.bindingId]);
    await f.syncFence();
    const raw = await f.request('GET', '/card-sync/capabilities', undefined, f.deviceHeaders(paired.token));
    expect(raw.status).toBe(200);
    expect(raw.json.bindings).toHaveLength(1);
    expect(raw.json.bindings[0].cards).toHaveLength(21);
    expect(raw.json.bindings[0].scopes).toHaveLength(22);
    expect(strict.parseStrict(raw.json, e3.CAPABILITIES).ok).toBe(true);
    expect(await client().capabilities(paired.token)).toMatchObject({ ok: true, value: { bindings: [{ cards: raw.json.bindings[0].cards }] } });
  });

  it('M4: a full grant past 64 KiB (20 bindings of 39 card hints and 40 scopes) is read whole, within E2c’s bound on a device answer', async () => {
    const bindingIds = Array.from({ length: 20 }, (_, b) => f.w.binding({
      scopes: Array.from({ length: 39 }, (_, index) => ({
        label: `Synthetic household card ${b}-${index}`, holderAlias: 'member-a' as const, last4: String(5184 + b * 39 + index),
      })),
    }).bindingId);
    const paired = f.w.device(bindingIds);
    await f.syncFence();
    const raw = await f.request('GET', '/card-sync/capabilities', undefined, f.deviceHeaders(paired.token));
    expect(raw.status).toBe(200);
    expect(raw.json.bindings).toHaveLength(20);
    expect(JSON.stringify(raw.json).length).toBeGreaterThan(64 * 1024);
    const read = await client().capabilities(paired.token);
    expect(read.ok).toBe(true);
    expect(read.value.bindings).toHaveLength(20);
    expect(read.value.bindings.every((binding: any) => binding.cards.length === 39 && binding.scopes.length === 40)).toBe(true);
  });
});
