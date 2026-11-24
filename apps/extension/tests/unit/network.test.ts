/**
 * The two network paths, with injected fetches: `bankRead` (the collector's
 * single bank-read entry, plan §4.2) and the worker's Holdr client (plan
 * §3.3, §6; E2's seam).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAKE_CHASE_READS } from '../../src/adapters/fake/chase/isolated.js';
import type { Budget } from '../../src/contracts/messages.js';
import { UI_COMMANDS } from '../../src/contracts/messages.js';
import { checkContract, createBankReader, createPageContext, type BankReadContract } from '../../src/isolated/bankRead.js';
import { CAPABILITIES, HOLDR_ERROR_STATUS, REDEEM_REQUEST, RUN_ABORT_REASONS, type RunAbortReason } from '../../src/contracts/holdrApi.js';
import { parseStrict, parseStrictUnion } from '../../src/common/strict.js';
import { createHoldrClient, unknownOutcome } from '../../src/worker/holdrClient.js';

const BUDGET: Budget = { maxPages: 10, maxRequests: 5, requestTimeoutMs: 1_000, requestIntervalMs: 0, startDelayMs: 0, runLimitMs: 60_000, maxResponseBytes: 1_024 };
const ACTIVITY = FAKE_CHASE_READS.find((contract) => contract.operationId === 'fake-chase.activity')!;

interface Call {
  url: string;
  init: RequestInit;
}

function reader(respond: (call: Call) => Response, budget: Budget = BUDGET) {
  const calls: Call[] = [];
  const bank = createBankReader({
    contracts: FAKE_CHASE_READS,
    budget,
    signal: new AbortController().signal,
    fetchImpl: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    },
    now: () => Date.now(),
    sleep: async () => undefined,
  });
  return { bank, calls };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const context = createPageContext({ accountId: '90000000123' });
const window = { start: '2026-09-17', end: '2026-10-16' };

test('checkContract refuses money movement, forbidden headers and bodies on GET', () => {
  assert.equal(checkContract(ACTIVITY), null);
  const variant = (change: Partial<BankReadContract>): BankReadContract => ({ ...ACTIVITY, ...change });
  assert.equal(checkContract(variant({ path: [{ literal: 'fake-api' }, { literal: 'transfer' }] })), 'deny-list');
  assert.equal(checkContract(variant({ path: [{ literal: 'billpay' }, { literal: 'list' }] })), 'deny-list');
  assert.equal(checkContract(variant({ headers: [['cookie', 'a=b']] })), 'header');
  assert.equal(checkContract(variant({ body: { kind: 'form-empty' } })), 'body');
  assert.equal(checkContract(variant({ origin: 'http://chase.e3.test/x' })), 'origin');
});

test('bankRead builds exactly the declared request: account id from the page handle, no cookies across sites, no redirects', async () => {
  const { bank, calls } = reader(() => json({ activities: [], more: false, cursor: null }));
  const result = await bank.bankRead('fake-chase.activity', { ...window, cursor: null }, context);
  assert.deepEqual(result, { ok: true, json: { activities: [], more: false, cursor: null } });
  assert.equal(calls[0].url, 'http://chase.e3.test/fake-api/accounts/90000000123/activity?start=2026-09-17&end=2026-10-16&count=50');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.mode, 'same-origin');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(await bank.bankRead('fake-chase.activity', { ...window, extra: 'x' }, context), { ok: false, error: 'refused', retryAfterMs: null });
  assert.deepEqual(await bank.bankRead('fake-chase.activity', { ...window }, createPageContext({ accountId: '../x' })), { ok: false, error: 'refused', retryAfterMs: null });
  assert.deepEqual(await bank.bankRead('fake-chase.unknown', {}, context), { ok: false, error: 'refused', retryAfterMs: null });
  assert.equal(calls.length, 1);
});

test('bankRead maps answers to fixed errors: sign-in, rate limit, HTML, server errors, size and bad JSON', async () => {
  const cases: Array<[Response, string, number | null]> = [
    [json({ error: 'x' }, 401), 'auth-required', null],
    [json({ error: 'x' }, 403), 'auth-required', null],
    [json({ error: 'x' }, 429, { 'retry-after': '120' }), 'rate-limited', 120_000],
    [new Response('<form id="login"></form>', { status: 200, headers: { 'content-type': 'text/html' } }), 'auth-required', null],
    [json({ error: 'x' }, 500), 'unexpected-response', null],
    [json({ big: 'x'.repeat(2_000) }), 'too-large', null],
    [new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }), 'unexpected-response', null],
  ];
  for (const [response, error, retryAfterMs] of cases) {
    const { bank } = reader(() => response);
    assert.deepEqual(await bank.bankRead('fake-chase.activity', { ...window }, context), { ok: false, error, retryAfterMs }, error);
  }
});

test('bankRead never sends a cursor twice, and stops at the request budget', async () => {
  const { bank, calls } = reader(() => json({ activities: [], more: true, cursor: 'c2' }), { ...BUDGET, maxRequests: 3 });
  assert.equal((await bank.bankRead('fake-chase.activity', { ...window, cursor: 'c2' }, context)).ok, true);
  assert.deepEqual(await bank.bankRead('fake-chase.activity', { ...window, cursor: 'c2' }, context), { ok: false, error: 'repeated-cursor', retryAfterMs: null });
  assert.equal(calls.length, 1);
  await bank.bankRead('fake-chase.activity', { ...window, cursor: 'c3' }, context);
  await bank.bankRead('fake-chase.activity', { ...window, cursor: 'c4' }, context);
  assert.deepEqual(await bank.bankRead('fake-chase.activity', { ...window, cursor: 'c5' }, context), { ok: false, error: 'cap', retryAfterMs: null });
  assert.equal(calls.length, 3);
});

test('bankRead spaces requests across readers: a new reader waits out the issuer spacing left by the previous read', async () => {
  let clock = 1_000_000;
  const sent: number[] = [];
  const waits: number[] = [];
  const spaced = (startDelayMs: number) =>
    createBankReader({
      contracts: FAKE_CHASE_READS,
      budget: { ...BUDGET, requestIntervalMs: 5_000, startDelayMs },
      signal: new AbortController().signal,
      fetchImpl: async () => {
        sent.push(clock);
        return json({ activities: [], more: false, cursor: null });
      },
      now: () => clock,
      sleep: async (ms: number) => {
        waits.push(ms);
        clock += ms;
      },
    });
  // A read whose issuer read nothing recently starts at once, then spaces its own requests.
  const first = spaced(0);
  await first.bankRead('fake-chase.activity', { ...window }, context);
  await first.bankRead('fake-chase.activity', { ...window }, context);
  assert.deepEqual(sent, [1_000_000, 1_005_000]);
  // Another tab's read (a new reader) handed the lease 1.2 s after that read ended: its first request waits the remaining 3.8 s.
  clock += 1_200;
  const next = spaced(3_800);
  await next.bankRead('fake-chase.activity', { ...window }, context);
  assert.deepEqual(waits, [5_000, 3_800]);
  assert.equal(sent[2] - sent[1], 5_000);
});

// ---------------------------------------------------------------------------
// Holdr client
// ---------------------------------------------------------------------------

const TOKEN = `hdv1_${'a'.repeat(64)}`;
const RUN = `run_${'b'.repeat(32)}`;

function holdr(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const client = createHoldrClient({
    origin: 'http://holdr.e3.test',
    requireHttps: false,
    timeoutMs: 1_000,
    clientVersion: '0.1.0',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return respond({ url, init });
    },
  });
  return { client, calls };
}

const headerMap = (call: Call) => new Map((call.init.headers as Array<[string, string]>).map(([name, value]) => [name.toLowerCase(), value]));

test('the Holdr client needs an exact origin, HTTPS where the target requires it, and this build’s version', () => {
  assert.throws(() => createHoldrClient({ origin: 'http://holdr.e3.test', requireHttps: true, timeoutMs: 1_000, clientVersion: '0.1.0' }));
  assert.throws(() => createHoldrClient({ origin: 'https://holdr.e3.test/api', requireHttps: true, timeoutMs: 1_000, clientVersion: '0.1.0' }));
  assert.doesNotThrow(() => createHoldrClient({ origin: 'https://node3.example.ts.net', requireHttps: true, timeoutMs: 1_000, clientVersion: '0.1.0' }));
  for (const clientVersion of ['', '0.1', 'v0.1.0', '0.1.0-beta', '1000.0.0']) {
    assert.throws(() => createHoldrClient({ origin: 'https://node3.example.ts.net', requireHttps: true, timeoutMs: 1_000, clientVersion }), clientVersion);
  }
});

test('M1: every request names the client and this build’s version, the pairing redeem included', async () => {
  const counts = { insert: 0, update: 0, unchanged: 0, aliased: 0, matched: 0, attributed: 0, promoted: 0, corrected: 0, rejected: 0, unmatched: 0, superseded: 0 };
  const { client, calls } = holdr((call) => {
    const path = new URL(call.url).pathname;
    if (path.endsWith('/receipt')) return json({ runId: RUN, observationSetId: null, acceptance: 'none', ledger: 'none', payloadDigest: null, acceptedAt: null, expiresAt: null });
    if (path.endsWith('/abort')) return json({ status: 'aborted' });
    return json({ status: 'owner-review', observationSetId: `obs_${'c'.repeat(32)}`, counts, reviewCount: 0 });
  });
  await client.redeem('a'.repeat(32), 'Laptop Chrome', '0.1.0');
  await client.capabilities(TOKEN);
  await client.createRun(TOKEN, { clientRunId: `crn_${'e'.repeat(32)}`, bindingId: `bnd_${'f'.repeat(32)}`, bindingVersion: 1, adapterVersion: 'holdr-ext@0.1.0', contractVersion: 1, trigger: 'manual' });
  await client.submitObservation(TOKEN, RUN, '{}', `crn_${'e'.repeat(32)}`);
  await client.preparePlan(TOKEN, RUN, `obs_${'c'.repeat(32)}`);
  await client.commit(TOKEN, { runId: RUN, previewId: `prv_${'a'.repeat(32)}`, payloadDigest: `pd1:${'d'.repeat(64)}`, planDigest: `pl1:${'e'.repeat(64)}` });
  await client.receipt(TOKEN, RUN);
  await client.abort(TOKEN, RUN, 'user-cancelled');
  assert.equal(calls.length, 8);
  for (const call of calls) {
    const headers = headerMap(call);
    assert.equal(headers.get('x-holdr-client'), 'extension-v1', call.url);
    assert.equal(headers.get('x-holdr-client-version'), '0.1.0', call.url);
    assert.equal(headers.has('cookie'), false, call.url);
    assert.equal(call.init.credentials, 'omit', call.url);
  }
});

const CAPABILITIES_BODY = {
  status: 'active',
  deviceId: `dev_${'f'.repeat(32)}`,
  deviceLabel: 'Laptop Chrome',
  deviceExpiresAt: '2026-11-15T12:00:00.000Z',
  holdrOrigin: 'http://holdr.e3.test',
  syncEnabled: true,
  payloadVersions: [2],
  contractVersions: [1],
  maxPayloadBytes: 2 * 1024 * 1024,
  maxRows: 2_000,
  issuers: [{ issuer: 'chase', enabled: true }],
  bindings: [] as unknown[],
};

test('M2: capabilities are taken only from the Holdr the client is pinned to: holdrOrigin must name exactly its origin', async () => {
  const read = async (body: unknown) => holdr(() => json(body)).client.capabilities(TOKEN);
  const own = await read(CAPABILITIES_BODY);
  assert.ok(own.ok && own.value.holdrOrigin === 'http://holdr.e3.test');
  const { holdrOrigin: _origin, ...without } = CAPABILITIES_BODY;
  const variants: Array<[string, unknown]> = [
    ['missing', without],
    ['https', { ...CAPABILITIES_BODY, holdrOrigin: 'https://holdr.e3.test' }],
    ['path', { ...CAPABILITIES_BODY, holdrOrigin: 'http://holdr.e3.test/' }],
    ['other', { ...CAPABILITIES_BODY, holdrOrigin: 'https://node3.example.ts.net' }],
  ];
  for (const [name, body] of variants) {
    assert.deepEqual(await read(body), { ok: false, kind: 'protocol', status: 200, code: null, issues: [] }, name);
  }
});

test('M3: a device label starts with a letter and has at most 32 characters, as Holdr’s device API takes it', () => {
  for (const label of ['Laptop Chrome', 'E3 Test Chromium', 'a', `A${'b'.repeat(31)}`, 'Laptop_2.0-x']) {
    assert.ok(parseStrict({ clientVersion: '0.1.0', deviceLabel: label }, REDEEM_REQUEST).ok, label);
    assert.ok(parseStrictUnion({ type: 'ui-command/v1', command: 'pair', pairingCode: 'a'.repeat(32), deviceLabel: label }, 'command', UI_COMMANDS).ok, label);
  }
  for (const label of ['20 Chrome', '9', ' Chrome', '_Chrome', `A${'b'.repeat(32)}`, '', 'Chrome/1', 'Ch\u00e9rie']) {
    assert.equal(parseStrict({ clientVersion: '0.1.0', deviceLabel: label }, REDEEM_REQUEST).ok, false, label);
    assert.equal(parseStrictUnion({ type: 'ui-command/v1', command: 'pair', pairingCode: 'a'.repeat(32), deviceLabel: label }, 'command', UI_COMMANDS).ok, false, label);
    assert.equal(parseStrict({ ...CAPABILITIES_BODY, deviceLabel: label }, CAPABILITIES).ok, false, label);
  }
});

test('M4: a binding lists up to 39 card hints (39 known scopes and the holder-unknown one); 40 is refused', () => {
  const binding = (cards: number) => ({
    bindingId: `bnd_${'a'.repeat(32)}`,
    bindingVersion: 1,
    issuer: 'chase',
    source: 'chase-api',
    bindingLabel: 'Synthetic',
    cards: Array.from({ length: cards }, (_, index) => String(5184 + index)),
    scopes: Array.from({ length: Math.min(cards + 1, 40) }, (_, index) => ({ cardScopeId: `scp_${String.fromCharCode(97 + (index % 16)).repeat(31)}${String.fromCharCode(97 + Math.floor(index / 16))}`, scopeLabel: `Card ${index}`, last4: index < cards ? String(5184 + index) : null, holderUnknown: index >= cards })),
  });
  for (const cards of [0, 20, 21, 39]) assert.ok(parseStrict({ ...CAPABILITIES_BODY, bindings: [binding(cards)] }, CAPABILITIES).ok, String(cards));
  assert.equal(parseStrict({ ...CAPABILITIES_BODY, bindings: [binding(40)] }, CAPABILITIES).ok, false);
});

/** A contract id: the prefix and 32 letters a–p encoding `n`. */
const idOf = (prefix: string, n: number) => `${prefix}_${n.toString(16).padStart(32, '0').replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)))}`;

test('M4: a full grant (20 bindings of 39 card hints and 40 scopes) is past 64 KiB but within E2c’s bound on a device answer, and is read whole', async () => {
  const bindings = Array.from({ length: 20 }, (_, b) => {
    const cards = Array.from({ length: 39 }, (_, index) => String(5184 + b * 39 + index));
    return {
      bindingId: idOf('bnd', b),
      bindingVersion: 2_147_483_647,
      issuer: 'chase',
      source: 'chase-api',
      bindingLabel: `Synthetic household binding number ${b}`.padEnd(64, '.'),
      cards,
      scopes: [
        ...cards.map((last4, index) => ({ cardScopeId: idOf('scp', b * 40 + index), scopeLabel: `Synthetic household card ${b}-${index}`.padEnd(64, '.'), last4, holderUnknown: false })),
        { cardScopeId: idOf('scp', b * 40 + 39), scopeLabel: 'Holder unknown', last4: null, holderUnknown: true },
      ],
    };
  });
  const body = { ...CAPABILITIES_BODY, issuers: ['amex', 'chase', 'citi', 'wellsfargo'].map((issuer) => ({ issuer, enabled: true })), bindings };
  const size = JSON.stringify(body).length;
  assert.ok(size > 64 * 1024 && size < 256 * 1024, String(size));
  const read = await holdr(() => json(body)).client.capabilities(TOKEN);
  assert.ok(read.ok, JSON.stringify(read));
  assert.equal(read.value.bindings.length, 20);
  assert.ok(read.value.bindings.every((binding) => binding.cards.length === 39 && binding.scopes.length === 40));
  // Nothing past E2c's 256 KiB bound is read, however it is spaced.
  const spaced = JSON.stringify(body, null, 24);
  assert.ok(spaced.length > 256 * 1024);
  assert.deepEqual(await holdr(() => new Response(spaced, { status: 200, headers: { 'content-type': 'application/json' } })).client.capabilities(TOKEN), { ok: false, kind: 'protocol', status: 200, code: null, issues: [] });
});

test('M5: every code Holdr’s device routes answer keeps its own status and code, D’s admission codes included; none is folded into another', async () => {
  // The device-reachable E2c codes and D's, as listed by Casey Mac (handoff 10/18 07:40) and E2c's response mapping.
  const required = ['authorization-blocked', 'ingress-unverified', 'ingress-refused', 'device-transport-refused', 'contract-unsupported', 'payload-digest-mismatch', 'scope-not-in-binding', 'capture-already-accepted', 'too-many-open-runs', 'run-rate-limited', 'run-not-found', 'device-not-active', 'plan-mismatch', 'plan-needs-review', 'plan-quota-exceeded', 'credential-not-allowed', 'set-closed', 'internal-error'];
  for (const code of required) assert.ok(code in HOLDR_ERROR_STATUS, code);
  for (const [code, status] of Object.entries(HOLDR_ERROR_STATUS)) {
    assert.deepEqual(await holdr(() => json({ error: code }, status)).client.receipt(TOKEN, RUN), { ok: false, kind: 'http', status, code, issues: [] }, code);
  }
  // With issues, and with a retry hint.
  assert.deepEqual(await holdr(() => json({ error: 'scope-not-in-binding', issues: [{ code: 'invalid-format', path: '$' }] }, 422)).client.receipt(TOKEN, RUN), { ok: false, kind: 'http', status: 422, code: 'scope-not-in-binding', issues: [{ code: 'invalid-format', path: '$' }] });
  assert.deepEqual(await holdr(() => json({ error: 'unavailable', retryAfterSeconds: 1 }, 503)).client.receipt(TOKEN, RUN), { ok: false, kind: 'http', status: 503, code: 'unavailable', issues: [] });
  // `bad-request` is also a stalled body (408) and an abort reason off the enum (422).
  assert.deepEqual(await holdr(() => json({ error: 'bad-request', issues: [{ code: 'unreadable', path: '$' }] }, 408)).client.receipt(TOKEN, RUN), { ok: false, kind: 'http', status: 408, code: 'bad-request', issues: [{ code: 'unreadable', path: '$' }] });
  assert.deepEqual(await holdr(() => json({ error: 'bad-request', issues: [{ code: 'invalid-enum', path: '$.reason' }] }, 422)).client.abort(TOKEN, RUN, 'user-cancelled'), { ok: false, kind: 'http', status: 422, code: 'bad-request', issues: [{ code: 'invalid-enum', path: '$.reason' }] });
  // Not Holdr's refusal, so an unknown outcome: a code Holdr never sends (E3's earlier names included), or a known code with a status Holdr never gives it.
  const notHoldrs: Array<[unknown, number]> = [
    [{ error: 'not-a-holdr-code' }, 409],
    [{ error: 'binding-not-allowed' }, 409],
    [{ error: 'observation-set-closed' }, 409],
    [{ error: 'sync-paused' }, 403],
    [{ error: 'run-closed' }, 400],
    [{ error: 'unavailable' }, 500],
    [{ error: 'bad-request' }, 409],
    [{ error: 'set-closed', extra: true }, 409],
    [{ message: 'conflict' }, 409],
  ];
  for (const [body, status] of notHoldrs) {
    const answer = await holdr(() => json(body, status)).client.receipt(TOKEN, RUN);
    assert.deepEqual(answer, { ok: false, kind: 'protocol', status, code: null, issues: [] }, JSON.stringify(body));
    assert.equal(unknownOutcome(answer as never), true, JSON.stringify(body));
  }
  // An answer that is not JSON at all (a page from something in front of Holdr) keeps only its status.
  assert.deepEqual(await holdr(() => new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } })).client.receipt(TOKEN, RUN), { ok: false, kind: 'http', status: 502, code: null, issues: [] });
});

test('M5: D’s late authorization-blocked and a 500 may follow an effect Holdr made, so a send or commit asks for the receipt; the others are definite', () => {
  const http = (status: number, code: string | null) => ({ ok: false as const, kind: 'http' as const, status, code: code as never, issues: [] });
  assert.equal(unknownOutcome(http(409, 'authorization-blocked')), true);
  assert.equal(unknownOutcome(http(500, 'internal-error')), true);
  assert.equal(unknownOutcome(http(503, 'ingress-unverified')), true);
  assert.equal(unknownOutcome(http(503, 'unavailable')), true);
  for (const [code, status] of [['run-closed', 409], ['set-closed', 409], ['scope-not-in-binding', 422], ['too-many-open-runs', 429], ['device-transport-refused', 403], ['credential-not-allowed', 403], ['run-not-found', 404]] as const) {
    assert.equal(unknownOutcome(http(status, code)), false, code);
  }
});

test('M7: an upload acknowledgement may name the set’s final state on a replay (committed, rejected, review expired)', async () => {
  const ack = { observationSetId: `obs_${'c'.repeat(32)}`, runId: RUN, payloadDigest: `pd1:${'d'.repeat(64)}`, status: 'accepted-uncommitted', acceptedAt: '2026-10-16T12:00:00.000Z', expiresAt: '2026-11-15T12:00:00.000Z' };
  for (const status of ['accepted-uncommitted', 'needs-review', 'committed', 'rejected', 'expired-unreviewed']) {
    const result = await holdr(() => json({ ...ack, status })).client.submitObservation(TOKEN, RUN, '{}', `crn_${'e'.repeat(32)}`);
    assert.ok(result.ok && result.value.status === status, status);
  }
  for (const status of ['blocked-review', 'recovery-review', 'aborted', 'none']) {
    assert.equal((await holdr(() => json({ ...ack, status })).client.submitObservation(TOKEN, RUN, '{}', `crn_${'e'.repeat(32)}`)).ok, false, status);
  }
});

test('observations: exactly the frozen bytes inside a canonical envelope, device auth, idempotency key, never cookies', async () => {
  const accepted = { observationSetId: `obs_${'c'.repeat(32)}`, runId: RUN, payloadDigest: `pd1:${'d'.repeat(64)}`, status: 'accepted-uncommitted', acceptedAt: '2026-10-16T12:00:00.000Z', expiresAt: '2026-11-15T12:00:00.000Z' };
  const { client, calls } = holdr(() => json(accepted, 201));
  const frozen = '{"b":1,"a":"x"}';
  const result = await client.submitObservation(TOKEN, RUN, frozen, `crn_${'e'.repeat(32)}`);
  assert.ok(result.ok);
  assert.equal(calls[0].url, 'http://holdr.e3.test/card-sync/observations');
  assert.equal(calls[0].init.body, `{"payload":${frozen},"runId":"${RUN}"}`);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'error');
  const headers = new Map((calls[0].init.headers as Array<[string, string]>).map(([name, value]) => [name.toLowerCase(), value]));
  assert.equal(headers.get('authorization'), `HoldrDevice ${TOKEN}`);
  assert.equal(headers.get('idempotency-key'), `crn_${'e'.repeat(32)}`);
  assert.equal(headers.get('x-holdr-client'), 'extension-v1');
  assert.equal(headers.has('cookie'), false);
});

test('Holdr answers are parsed with exact keys; error bodies keep only their fixed code and value-free issues', async () => {
  const receipt = { runId: RUN, observationSetId: null, acceptance: 'none', ledger: 'none', payloadDigest: null, acceptedAt: null, expiresAt: null };
  assert.ok((await holdr(() => json(receipt)).client.receipt(TOKEN, RUN)).ok);
  assert.deepEqual(await holdr(() => json({ ...receipt, extra: 1 })).client.receipt(TOKEN, RUN), { ok: false, kind: 'protocol', status: 200, code: null, issues: [] });
  assert.deepEqual(await holdr(() => json({ error: 'unavailable', retryAfterSeconds: 30 }, 503)).client.receipt(TOKEN, RUN), { ok: false, kind: 'http', status: 503, code: 'unavailable', issues: [] });
  const invalid = await holdr(() => json({ error: 'payload-invalid', issues: [{ code: 'card-data', path: '$.rows[0]' }] }, 422)).client.receipt(TOKEN, RUN);
  assert.deepEqual(invalid, { ok: false, kind: 'http', status: 422, code: 'payload-invalid', issues: [{ code: 'card-data', path: '$.rows[0]' }] });
  assert.deepEqual(await holdr(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })).client.receipt(TOKEN, RUN), { ok: false, kind: 'protocol', status: 200, code: null, issues: [] });
});

test('only the listed Holdr routes can be called; anything else is refused before the network', async () => {
  const { client, calls } = holdr(() => json({}));
  assert.deepEqual(await client.receipt(TOKEN, '../../admin'), { ok: false, kind: 'refused', status: null, code: null, issues: [] });
  assert.deepEqual(await client.abort(TOKEN, 'run_x', 'user-cancelled'), { ok: false, kind: 'refused', status: null, code: null, issues: [] });
  assert.equal(calls.length, 0);
});

test('a run abort carries exactly one of the fixed reasons (Q4); any other reason never leaves the browser', async () => {
  const { client, calls } = holdr(() => json({ status: 'aborted' }));
  for (const reason of RUN_ABORT_REASONS) assert.ok((await client.abort(TOKEN, RUN, reason)).ok, reason);
  assert.deepEqual(calls.map((call) => call.init.body), RUN_ABORT_REASONS.map((reason) => `{"reason":"${reason}"}`));
  assert.ok(calls.every((call) => call.url === `http://holdr.e3.test/card-sync/runs/${RUN}/abort` && call.init.method === 'POST' && call.init.credentials === 'omit'));
  assert.deepEqual(await client.abort(TOKEN, RUN, 'certificate-ignored' as RunAbortReason), { ok: false, kind: 'refused', status: null, code: null, issues: [] });
  assert.equal(calls.length, RUN_ABORT_REASONS.length);
});

test('receipts: a rejected set is a state devices see (X13); Holdr’s internal review states are not', async () => {
  const receipt = { runId: RUN, observationSetId: `obs_${'c'.repeat(32)}`, acceptance: 'rejected', ledger: 'none', payloadDigest: `pd1:${'d'.repeat(64)}`, acceptedAt: '2026-10-16T12:00:00.000Z', expiresAt: '2026-11-15T12:00:00.000Z' };
  const rejected = await holdr(() => json(receipt)).client.receipt(TOKEN, RUN);
  assert.ok(rejected.ok);
  assert.equal(rejected.value.acceptance, 'rejected');
  for (const acceptance of ['blocked-review', 'recovery-review', 'committed', 'aborted']) {
    assert.equal((await holdr(() => json({ ...receipt, acceptance })).client.receipt(TOKEN, RUN)).ok, false, acceptance);
  }
});

test('a device prepare is a strict union (E1b X24/Q38): an executable plan, or owner-review without any preview id', async () => {
  const counts = { insert: 8, update: 0, unchanged: 0, aliased: 0, matched: 0, attributed: 0, promoted: 0, corrected: 0, rejected: 0, unmatched: 0, superseded: 0 };
  const executable = { status: 'executable', previewId: `prv_${'a'.repeat(32)}`, payloadDigest: `pd1:${'d'.repeat(64)}`, planDigest: `pl1:${'e'.repeat(64)}`, expiresAt: '2026-10-16T12:10:00.000Z', counts };
  const review = { status: 'owner-review', observationSetId: `obs_${'c'.repeat(32)}`, counts, reviewCount: 8 };
  const plan = async (body: unknown) => holdr(() => json(body)).client.preparePlan(TOKEN, RUN, `obs_${'c'.repeat(32)}`);
  const first = await plan(executable);
  assert.ok(first.ok && first.value.status === 'executable' && first.value.previewId === executable.previewId);
  const second = await plan(review);
  assert.ok(second.ok && second.value.status === 'owner-review' && second.value.reviewCount === 8);
  // Never an owner-review with a (made-up or null) preview id, never a variant with the other's keys, never an unknown status.
  for (const body of [
    { ...review, previewId: executable.previewId },
    { ...review, previewId: null },
    { ...executable, reviewCount: 8 },
    { ...executable, status: 'owner-review' },
    { ...review, status: 'needs-review' },
    { ...executable, counts: { ...counts, extra: 1 } },
    { ...review, counts: (({ aliased: _aliased, ...rest }) => rest)(counts) },
    { previewId: executable.previewId, payloadDigest: executable.payloadDigest, planDigest: executable.planDigest, expiresAt: executable.expiresAt, counts },
  ]) {
    assert.deepEqual(await plan(body), { ok: false, kind: 'protocol', status: 200, code: null, issues: [] }, JSON.stringify(body));
  }
});

test('plan counts are E1b revision 8 PlanCounts (X37): a conforming first-sync owner-review, aliased tally included, is read', async () => {
  // E1b revision 8 §5.6: eleven tallies, `aliased` after `unchanged`.
  const counts = { insert: 1, update: 0, unchanged: 0, aliased: 0, matched: 1, attributed: 0, promoted: 1, corrected: 0, rejected: 0, unmatched: 0, superseded: 0 };
  const review = await holdr(() => json({ status: 'owner-review', observationSetId: `obs_${'c'.repeat(32)}`, counts, reviewCount: 2 })).client.preparePlan(TOKEN, RUN, `obs_${'c'.repeat(32)}`);
  assert.ok(review.ok && review.value.status === 'owner-review');
  assert.deepEqual(review.value.counts, counts);
  const aliased = await holdr(() => json({ status: 'owner-review', observationSetId: `obs_${'c'.repeat(32)}`, counts: { ...counts, aliased: 3 }, reviewCount: 2 })).client.preparePlan(TOKEN, RUN, `obs_${'c'.repeat(32)}`);
  assert.ok(aliased.ok && aliased.value.counts.aliased === 3);
});

test('the pairing redeem answer is read by its own exact parser; the bearer appears nowhere else', async () => {
  const redeemed = { deviceId: `dev_${'f'.repeat(32)}`, deviceToken: TOKEN, fingerprint: 'abcd-efgh-ijkl-mnop', status: 'pending', pendingExpiresAt: '2026-10-16T12:10:00.000Z' };
  const { client, calls } = holdr(() => json(redeemed, 201));
  const result = await client.redeem('a'.repeat(32), 'Laptop Chrome', '0.1.0');
  assert.ok(result.ok);
  assert.equal(result.value.deviceToken, TOKEN);
  const headers = new Map((calls[0].init.headers as Array<[string, string]>).map(([name, value]) => [name.toLowerCase(), value]));
  assert.equal(headers.get('authorization'), `HoldrPair ${'a'.repeat(32)}`);
  assert.equal(calls[0].init.body, '{"clientVersion":"0.1.0","deviceLabel":"Laptop Chrome"}');
  for (const broken of [{ ...redeemed, extra: true }, { ...redeemed, deviceToken: `hdv1_${'a'.repeat(63)}9` }, { ...redeemed, deviceId: 'dev_1' }, { ...redeemed, pendingExpiresAt: 1792217520859 }, { ...redeemed, status: 'active' }]) {
    assert.equal((await holdr(() => json(broken, 201)).client.redeem('a'.repeat(32), 'Laptop Chrome', '0.1.0')).ok, false, JSON.stringify(Object.keys(broken)));
  }
});
