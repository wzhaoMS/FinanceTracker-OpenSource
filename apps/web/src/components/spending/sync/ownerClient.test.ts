import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cardSyncPayloadDigest, cardSyncPlanDigest, isForbiddenCardSyncKey, type JsonValue } from '@finance-tracker/shared';
import * as api from './ownerApi';
import { OwnerApiError, createOwnerClient, isOwnerApiError, isUnknownOutcome, type OwnerTransport, type TransportResult } from './ownerClient';
import { FAKE_OWNER_PASSWORD, FakeOwnerServer, LEDGER_STORY_IDS, MINUTE, fakeOwnerTransport } from './fakeOwnerServer';
import { pageCursor } from './fake/model';

/** Letters only, as every cursor is: what the client passes through without reading it. */
const SOME_CURSOR = 'abcdefghijklmnop';
import { schemaKeys, type Spec } from './strict';
import { fingerprintText } from './syncFormat';
import { REMOVED_TEXT } from './ledgerText';
import { runRowsNote } from './syncText';

function client(server = new FakeOwnerServer({ recentAuth: 'granted' })) {
  return { server, owner: createOwnerClient(fakeOwnerTransport(server), 'mock') };
}

/** A transport that answers every request with one fixed result, and records what it was asked. */
function fixed(result: TransportResult) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const transport: OwnerTransport = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      return result;
    },
  };
  return { calls, owner: createOwnerClient(transport) };
}

async function rejects(promise: Promise<unknown>, check: (error: OwnerApiError) => void): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(isOwnerApiError(error), 'an OwnerApiError');
    check(error);
    return true;
  });
}

describe('owner API schemas', () => {
  test('every key the client sends or reads passes the card-sync key policy', () => {
    const specs = (Object.values(api) as unknown[]).filter((value): value is Spec => typeof value === 'object' && value !== null && 't' in value);
    assert.ok(specs.length >= 30, `found ${specs.length} schemas`);
    const keys = new Set<string>();
    for (const spec of specs) schemaKeys(spec, keys);
    const refused = [...keys].filter((key) => isForbiddenCardSyncKey(key));
    assert.deepEqual(refused, []);
    for (const key of ['cardAccountRef', 'pairingCode', 'holderAlias', 'deviceExpiresAt', 'payload']) assert.ok(keys.has(key), key);
  });

  test('the names the policy refuses are not used, and would be refused if Holdr sent them', () => {
    for (const key of ['cardAccountId', 'nickname', 'link', 'expiry', 'authorization', 'sessionId', 'deviceToken', 'tokenExpiresAt']) {
      assert.equal(isForbiddenCardSyncKey(key), true, key);
    }
  });
});

describe('owner client over the fake Holdr', () => {
  test('reads every scenario\'s state through the strict schemas', async () => {
    for (const scenario of ['demo', 'fresh', 'restored'] as const) {
      const { owner } = client(new FakeOwnerServer({ scenario }));
      const state = await owner.getState();
      assert.equal(state.generatedAt, '2026-10-17T12:00:00.000Z');
      assert.match(state.holdrOrigin, /^https:\/\//);
    }
  });

  test('reads every set, run and exact sent object of the demo', async () => {
    const { owner } = client();
    for (const view of ['open', 'closed'] as const) {
      const page = await owner.listObservationSets(view);
      for (const set of page.observationSets) await owner.getObservationSet(set.observationSetId);
    }
    const runs = await owner.listRuns();
    assert.equal(runs.runs.length, 9);
    assert.deepEqual(runs.runs.filter((run) => run.abortReason !== null).map((run) => [run.abortReason, run.acceptance]), [['not-signed-in', 'none']]);
    let shown = 0;
    for (const run of runs.runs) {
      const detail = await owner.getRun(run.runId);
      if (!detail.receiptAvailable) continue;
      const sent = await owner.getSentPayload(run.runId);
      assert.equal(cardSyncPayloadDigest(sent.payload), detail.payloadDigest);
      shown += 1;
    }
    assert.equal(shown, 1);
  });

  test('never sends a credential: owner calls carry the session\'s CSRF header and no Authorization', async () => {
    const { server, owner } = client();
    await owner.getState();
    await owner.pause();
    assert.ok(server.requests.length >= 2);
    assert.ok(server.requests.every((request) => !request.hadAuthorization));
    assert.ok(server.requests.filter((request) => request.method === 'POST').every((request) => request.hadCsrfHeader));
  });

  test('the fake refuses what E2 would refuse: any Authorization header, and writes without the CSRF header', () => {
    const server = new FakeOwnerServer();
    const withCredential = server.handle({ method: 'GET', url: '/card-sync/owner/state', headers: { authorization: 'HoldrDevice x' } });
    assert.deepEqual(withCredential, { status: 400, body: { error: 'credential-not-allowed' } });
    const noCsrf = server.handle({ method: 'POST', url: '/card-sync/owner/pause', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual(noCsrf, { status: 403, body: { error: 'csrf-required' } });
    const extraKey = server.handle({
      method: 'POST', url: '/card-sync/owner/pause', headers: { 'content-type': 'application/json', 'x-holdr-request': '1' }, body: '{"force":true}',
    });
    assert.equal(extraKey.status, 422);
    assert.deepEqual(extraKey.body, { error: 'invalid-request', issues: [{ code: 'unknown-key', path: '$.<key>' }] });
  });
});

describe('no silent fallback', () => {
  test('Holdr\'s answer that it has no extension sync is "not available", on the state route only', async () => {
    const answer = { kind: 'json', status: 200, body: { extensionSync: 'not-configured' } } as const;
    await rejects(fixed(answer).owner.getState(), (error) => assert.equal(error.kind, 'unavailable'));
    await rejects(fixed(answer).owner.listRuns(), (error) => assert.equal(error.kind, 'invalid-answer'));
    const padded = fixed({ kind: 'json', status: 200, body: { extensionSync: 'not-configured', bindings: [] } });
    await rejects(padded.owner.getState(), (error) => assert.equal(error.kind, 'invalid-answer'));
  });

  test('a failure on the state route stays an error, not "not set up"', async () => {
    for (const status of [500, 503]) {
      const { owner } = fixed({ kind: 'json', status, body: { error: 'unavailable', retryAfterSeconds: 1 } });
      await rejects(owner.getState(), (error) => assert.deepEqual([error.kind, error.status], ['http', status]));
    }
  });

  test('a 404 on the state route (a Holdr from before the explicit answer) means Holdr has no owner API', async () => {
    const { owner } = fixed({ kind: 'json', status: 404, body: { error: 'not-found' } });
    await rejects(owner.getState(), (error) => assert.equal(error.kind, 'unavailable'));
  });

  test('an HTML answer (a page server\'s fallback) on the state route is "not available", not data', async () => {
    const { owner } = fixed({ kind: 'other', status: 200 });
    await rejects(owner.getState(), (error) => assert.equal(error.kind, 'unavailable'));
  });

  test('a 404 elsewhere is a plain not-found', async () => {
    const { owner } = fixed({ kind: 'json', status: 404, body: { error: 'not-found' } });
    await rejects(owner.getObservationSet(`obs_${'a'.repeat(32)}`), (error) => {
      assert.equal(error.kind, 'http');
      assert.equal(error.code, 'not-found');
    });
  });

  test('no answer at all is a network error', async () => {
    const transport: OwnerTransport = { request: async () => { throw new TypeError('offline'); } };
    await rejects(createOwnerClient(transport).getState(), (error) => assert.equal(error.kind, 'network'));
  });
});

describe('answers the client refuses to show', () => {
  async function stateWith(change: (state: Record<string, unknown>) => void) {
    const server = new FakeOwnerServer();
    const body = JSON.parse(JSON.stringify(server.handle({ method: 'GET', url: '/card-sync/owner/state' }).body)) as Record<string, unknown>;
    change(body);
    return fixed({ kind: 'json', status: 200, body }).owner.getState();
  }

  test('anything carrying a token is refused, whatever the key', async () => {
    await rejects(stateWith((state) => { state.deviceToken = `hdv1_${'a'.repeat(64)}`; }), (error) => assert.equal(error.kind, 'invalid-answer'));
    await rejects(stateWith((state) => {
      (state.devices as Array<Record<string, unknown>>)[0].tokenExpiresAt = '2026-11-01T00:00:00.000Z';
    }), (error) => {
      assert.equal(error.kind, 'invalid-answer');
      assert.ok(error.extra.issues?.some((issue) => issue.code === 'forbidden-key'));
    });
  });

  test('a pairing address that is not HTTPS is refused', async () => {
    await rejects(stateWith((state) => { state.holdrOrigin = 'http://homeserver.local:4000'; }), (error) => assert.equal(error.kind, 'invalid-answer'));
  });

  test('card data in a label is refused', async () => {
    await rejects(stateWith((state) => {
      (state.bindings as Array<Record<string, unknown>>)[0].bindingLabel = 'Card 4111 1111 1111 1111';
    }), (error) => assert.equal(error.kind, 'invalid-answer'));
  });

  test('a missing or unknown key is refused', async () => {
    await rejects(stateWith((state) => { delete state.gate; }), (error) => assert.equal(error.kind, 'invalid-answer'));
    await rejects(stateWith((state) => { state.debugInfo = 'x'; }), (error) => assert.equal(error.kind, 'invalid-answer'));
  });

  test('E1b\'s stored shapes pass: a plain 16-letter confirmation code and 64-character labels; member-b is not an alias (rev 2)', async () => {
    const state = await stateWith((value) => {
      (value.devices as Array<Record<string, unknown>>)[0].fingerprint = 'aaaabbbbccccdddd';
      (value.bindings as Array<Record<string, unknown>>)[0].bindingLabel = 'L'.repeat(64);
    });
    assert.equal(state.devices[0].fingerprint, 'aaaabbbbccccdddd');
    assert.equal(state.bindings[0].bindingLabel.length, 64);
    assert.equal(fingerprintText(state.devices[0].fingerprint), 'aaaa-bbbb-cccc-dddd');
    assert.equal(fingerprintText('aaaa-bbbb-cccc-dddd'), 'aaaa-bbbb-cccc-dddd');
    await rejects(stateWith((value) => { (value.devices as Array<Record<string, unknown>>)[0].fingerprint = 'aaaa-bbbbccccdddd-'; }),
      (error) => assert.equal(error.kind, 'invalid-answer'));
    await rejects(stateWith((value) => { (value.bindings as Array<Record<string, unknown>>)[0].bindingLabel = 'L'.repeat(65); }),
      (error) => assert.equal(error.kind, 'invalid-answer'));
    await rejects(stateWith((value) => {
      (((value.bindings as Array<Record<string, unknown>>)[0].scopes) as Array<Record<string, unknown>>)[0].holderAlias = 'member-b';
    }), (error) => assert.equal(error.kind, 'invalid-answer'));
  });

  test('an unknown abort reason or auto-sync gate is refused', async () => {
    const server = new FakeOwnerServer();
    server.startRun('wellsfargo', 'not-signed-in');
    const body = JSON.parse(JSON.stringify(server.handle({ method: 'GET', url: '/card-sync/owner/state' }).body)) as {
      bindings: Array<{ issuer: string; sync: { lastRun: { abortReason: string | null } }; autoSync: { gate: string } }>;
    };
    const wf = body.bindings.find((binding) => binding.issuer === 'wellsfargo')!;
    assert.equal(wf.sync.lastRun.abortReason, 'not-signed-in');
    assert.equal((await fixed({ kind: 'json', status: 200, body }).owner.getState()).bindings.length, body.bindings.length);
    wf.sync.lastRun.abortReason = 'network-error';
    await rejects(fixed({ kind: 'json', status: 200, body }).owner.getState(), (error) => assert.equal(error.kind, 'invalid-answer'));
    wf.sync.lastRun.abortReason = 'not-signed-in';
    wf.autoSync.gate = 'ajar';
    await rejects(fixed({ kind: 'json', status: 200, body }).owner.getState(), (error) => assert.equal(error.kind, 'invalid-answer'));
    wf.autoSync.gate = 'closed';
    (wf.sync.lastRun as Record<string, unknown>).runState = 'stalled';
    await rejects(fixed({ kind: 'json', status: 200, body }).owner.getState(), (error) => assert.equal(error.kind, 'invalid-answer'));
    (wf.sync.lastRun as Record<string, unknown>).runState = 'aborted';
    (wf.autoSync as Record<string, unknown>).revision = -1;
    await rejects(fixed({ kind: 'json', status: 200, body }).owner.getState(), (error) => assert.equal(error.kind, 'invalid-answer'));
  });

  test('an exact sent object that does not hash to its digest is not shown', async () => {
    const server = new FakeOwnerServer();
    const chaseRun = server.store.runs.find((run) => run.observationSetId === server.store.sets[0].observationSetId)!;
    const body = JSON.parse(JSON.stringify(server.handle({ method: 'GET', url: `/card-sync/owner/runs/${chaseRun.runId}/payload` }).body)) as {
      payload: { rows: Array<{ amountMinor: number }> };
    };
    body.payload.rows[0].amountMinor += 1;
    await rejects(fixed({ kind: 'json', status: 200, body }).owner.getSentPayload(chaseRun.runId), (error) => assert.equal(error.kind, 'invalid-answer'));
  });
});

describe('v1 file review sets (E2d, E2a-Q3/Q14)', () => {
  /** A set's detail as the fake answers it, to change and serve as Holdr's answer. */
  const detailOf = (server: FakeOwnerServer, setId: string) => JSON.parse(JSON.stringify(
    server.handle({ method: 'GET', url: `/card-sync/owner/observation-sets/${setId}` }).body)) as api.SetDetail;
  const served = (body: unknown) => fixed({ kind: 'json', status: 200, body: JSON.parse(JSON.stringify(body)) }).owner;
  const invalid = (error: OwnerApiError) => assert.equal(error.kind, 'invalid-answer');
  const letters = (n: number) => [...n.toString(16).padStart(32, '0')].map((digit) => 'abcdefghijklmnop'['0123456789abcdef'.indexOf(digit)]).join('');

  test('reads a file set as Holdr sends it: no run, binding, device, payload digest or coverage, and legacy-file rows at their file positions', async () => {
    const { server, owner } = client();
    const setId = server.addFileReviewSet();
    const detail = await owner.getObservationSet(setId);
    assert.deepEqual([detail.sourceKind, detail.runId, detail.bindingId, detail.deviceId, detail.payloadDigest, detail.coverage],
      ['file', null, null, null, null, []]);
    assert.ok(detail.importBatchId);
    assert.ok(detail.items.length > 0 && detail.items.every((entry) => entry.observation?.identity === 'legacy-file'));
    assert.ok((await owner.listObservationSets('open')).observationSets.some((set) => set.observationSetId === setId && set.sourceKind === 'file'));
    // A v1 file has up to 10,000 rows: a row near its end keeps its position in the file.
    const far = detailOf(server, setId);
    far.items[0].rowIndex = 9_999;
    far.items[0].observation!.rowIndex = 9_999;
    assert.equal((await served(far).getObservationSet(setId)).items[0].observation?.rowIndex, 9_999);
    far.items[0].rowIndex = 10_000;
    far.items[0].observation!.rowIndex = 10_000;
    await rejects(served(far).getObservationSet(setId), invalid);
  });

  test('refuses a set whose shape is not its source\'s', async () => {
    const { server } = client();
    const fileId = server.addFileReviewSet();
    const file = detailOf(server, fileId);
    const extensionId = server.store.sets.find((set) => set.origin === 'extension' && (set.payload?.coverage.length ?? 0) > 0
      && set.items.some((entry) => entry.rowIndex !== null))!.observationSetId;
    const extension = detailOf(server, extensionId);
    assert.ok(extension.coverage.length > 0 && extension.items.some((entry) => entry.observation !== null));
    await served(file).getObservationSet(fileId);
    await served(extension).getObservationSet(extensionId);
    const observed = (set: api.SetDetail) => set.items.find((entry) => entry.observation !== null)!;
    const fileChanges: Array<(set: api.SetDetail) => void> = [
      (set) => { set.runId = extension.runId; },
      (set) => { set.bindingId = extension.bindingId; },
      (set) => { set.deviceId = extension.deviceId; },
      (set) => { set.importBatchId = null; },
      (set) => { set.payloadDigest = extension.payloadDigest; },
      (set) => { set.coverage = extension.coverage; },
      (set) => { observed(set).observation!.identity = 'stable'; },
    ];
    for (const change of fileChanges) {
      const changed = structuredClone(file);
      change(changed);
      await rejects(served(changed).getObservationSet(fileId), invalid);
    }
    const extensionChanges: Array<(set: api.SetDetail) => void> = [
      (set) => { set.importBatchId = file.importBatchId; },
      (set) => { set.runId = null; },
      (set) => { observed(set).observation!.identity = 'legacy-file'; },
      // An extension payload has at most 2,000 rows.
      (set) => { observed(set).rowIndex = 2_000; observed(set).observation!.rowIndex = 2_000; },
    ];
    for (const change of extensionChanges) {
      const changed = structuredClone(extension);
      change(changed);
      await rejects(served(changed).getObservationSet(extensionId), invalid);
    }
    // A list answers for every set it lists, and a discard for the set it closed.
    const summary = Object.fromEntries(Object.keys(api.SET_SUMMARY.keys).map((key) => [key, file[key as keyof api.SetDetail]]));
    await served({ observationSets: [summary], nextCursor: null }).listObservationSets('open');
    await rejects(served({ observationSets: [{ ...summary, deviceId: extension.deviceId }], nextCursor: null }).listObservationSets('open'), invalid);
    await rejects(served({ ...summary, importBatchId: null }).discardObservationSet(fileId, { expectedVersion: file.version, reason: 'other' }), invalid);
  });

  test('a plan names rows as its set does: by payload ordinal for an extension set, by file position for a file set', async () => {
    const plan = (payloadDigest: string | null, rowIndex: number): api.Plan => ({
      previewId: `prv_${letters(1)}`, observationSetId: `obs_${letters(1)}`, setVersion: 1, planKind: 'set', payloadDigest,
      planDigest: cardSyncPlanDigest({ plan: 'q14' } as unknown as JsonValue),
      createdAt: '2026-10-17T09:00:00.000Z', expiresAt: '2026-10-17T09:30:00.000Z', observationExpiresAt: '2026-10-31T09:00:00.000Z',
      counts: { insert: 1, update: 0, unchanged: 0, aliased: 0, matched: 0, attributed: 0, promoted: 0, corrected: 0, rejected: 0, unmatched: 0, superseded: 0 },
      effectCount: 1,
      effects: [{
        itemId: `rvw_${letters(1)}`, rowIndex, effect: 'insert', transactionId: `card-txn-${letters(1)}`, before: null,
        after: { status: 'posted', transactionDate: '2026-10-08', postedDate: '2026-10-09', amountMinor: 1250, kind: 'purchase', description: 'SYNTHETIC CAFE', merchant: null, cardScopeId: null },
      }],
      nextEffectsCursor: null,
    });
    const prepare = (body: api.Plan) => fixed({ kind: 'json', status: 201, body: JSON.parse(JSON.stringify(body)) }).owner
      .preparePlan(`obs_${letters(1)}`, { expectedVersion: 1, sourceReviewed: false });
    const extensionDigest = cardSyncPayloadDigest(new FakeOwnerServer().store.sets[0].payload!);
    assert.equal((await prepare(plan(null, 9_999))).effects[0].rowIndex, 9_999);
    assert.equal((await prepare(plan(extensionDigest, 1_999))).effects[0].rowIndex, 1_999);
    await rejects(prepare(plan(extensionDigest, 2_000)), invalid);
  });

  test('a file set comes in its card account\'s currency, an extension set in USD only', async () => {
    const { server } = client();
    const fileId = server.addFileReviewSet();
    const file = detailOf(server, fileId);
    assert.equal((await served({ ...file, currency: 'CAD' }).getObservationSet(fileId)).currency, 'CAD');
    await rejects(served({ ...file, currency: 'cad' }).getObservationSet(fileId), invalid);
    const extensionId = server.store.sets.find((set) => set.origin === 'extension')!.observationSetId;
    const extension = detailOf(server, extensionId);
    assert.equal((await served(extension).getObservationSet(extensionId)).currency, 'USD');
    await rejects(served({ ...extension, currency: 'CAD' }).getObservationSet(extensionId), invalid);
  });
});

describe('error mapping', () => {
  test('fixed codes with their extra fields', async () => {
    const cases: Array<[TransportResult, (error: OwnerApiError) => void]> = [
      [{ kind: 'json', status: 409, body: { error: 'version-conflict', currentVersion: 7 } }, (error) => {
        assert.equal(error.code, 'version-conflict');
        assert.equal(error.extra.currentVersion, 7);
      }],
      [{ kind: 'json', status: 422, body: { error: 'invalid-request', issues: [{ code: 'unknown-key', path: '$.<key>' }] } }, (error) => {
        assert.equal(error.code, 'invalid-request');
        assert.deepEqual(error.extra.issues, [{ code: 'unknown-key', path: '$.<key>' }]);
      }],
      [{ kind: 'json', status: 429, body: { error: 'rate-limited', retryAfterSeconds: 30 } }, (error) => assert.equal(error.extra.retryAfterSeconds, 30)],
      [{ kind: 'json', status: 403, body: { error: 'recent-auth-required' } }, (error) => assert.equal(error.code, 'recent-auth-required')],
      [{ kind: 'json', status: 500, body: { error: 'Internal: details here' } }, (error) => assert.equal(error.code, null)],
    ];
    for (const [result, check] of cases) await rejects(fixed(result).owner.pause(), check);
  });

  test('ids are checked before anything is sent', async () => {
    const { calls, owner } = fixed({ kind: 'json', status: 200, body: {} });
    await rejects(owner.revokeDevice('../../state'), (error) => assert.equal(error.kind, 'invalid-input'));
    await rejects(owner.cancelPairing('dev_x'), (error) => assert.equal(error.kind, 'invalid-input'));
    await rejects(owner.enableIssuer('discover' as never, { expectedVersion: 1, mainWorldAcknowledged: false }), (error) => assert.equal(error.kind, 'invalid-input'));
    assert.equal(calls.length, 0);
  });

  test('the password goes to the recent-auth route once, in the body', async () => {
    const server = new FakeOwnerServer();
    const { owner } = client(server);
    await rejects(owner.resume(server.store.settingsVersion), (error) => assert.equal(error.code, 'recent-auth-required'));
    await rejects(owner.confirmPassword('wrong password'), (error) => assert.equal(error.status, 403));
    const confirmed = await owner.confirmPassword(FAKE_OWNER_PASSWORD);
    assert.equal(confirmed.verifiedUntil, '2026-10-17T12:05:00.000Z');
    await owner.resume(server.store.settingsVersion);
  });
});

describe('revision 2 wire shapes and paged answers (R7)', () => {
  /** One UTF-16 unit and three UTF-8 bytes: the widest character the text rules allow, per character of a limit. */
  const WIDE = '\u6d88';
  const wide = (count: number) => WIDE.repeat(count);
  const LETTERS = 'abcdefghijklmnop';
  /** A letters-only id with `n` written in it, so every id of a page is different. */
  const letterId = (prefix: string, n: number) => `${prefix}${[...n.toString(16).padStart(32, '0')].map((digit) => LETTERS['0123456789abcdef'.indexOf(digit)]).join('')}`;
  const DAY = '2026-10-08';
  const TIME = '2026-10-17T09:00:00.000Z';
  const KIND = 'adjustment';
  const SCOPE = letterId('scp_', 1);

  function widestValues(): api.TxnValues {
    return { status: 'removed', transactionDate: DAY, postedDate: DAY, amountMinor: -9_999_999_999, kind: KIND, description: wide(500), merchant: wide(200), cardScopeId: SCOPE };
  }

  /** A review item with every field at its widest: the observation, five candidates with the owner's own edits, both decisions. */
  function widestItem(index: number): api.ReviewItem {
    const itemId = letterId('rvw_', index);
    const decision = { itemId, action: 'attribute-and-link' as const, transactionId: letterId('card-txn-', 99_999), cardScopeId: SCOPE };
    return {
      itemId,
      category: 'reconciliation-difference',
      rowIndex: 1_999,
      reason: 'pending-may-have-posted',
      observation: {
        rowIndex: 1_999, transactionDate: DAY, postedDate: DAY, status: 'posted', amountMinor: -9_999_999_999, kind: KIND,
        description: wide(500), merchant: wide(200), issuerCategory: wide(100), cardScopeId: SCOPE, identity: 'capture',
        originalAmountMinor: -9_999_999_999, originalCurrency: 'JPY',
      },
      candidates: [1, 2, 3, 4, 5].map((n) => ({
        transactionId: letterId('card-txn-', index * 10 + n), cardScopeId: SCOPE, scopeKind: 'unknown' as const, sourceKind: 'extension' as const,
        status: 'removed' as const, transactionDate: DAY, postedDate: DAY, amountMinor: -9_999_999_999, kind: KIND,
        description: wide(500), merchant: wide(200), userCategory: wide(api.USER_CATEGORY_MAX), notes: wide(api.NOTES_MAX),
        matchedOn: ['date', 'amount', 'merchant', 'description', 'posted-id'] as api.Candidate['matchedOn'], blockedReason: 'different-known-cards' as const,
      })),
      difference: { field: 'new-balance', expectedMinor: -99_999_999_999, actualMinor: -99_999_999_999 },
      allowedActions: [...api.DECISION_ACTIONS],
      decision: { ...decision, decidedAt: TIME },
      committed: { ...decision, committedAt: TIME },
    };
  }

  test('a page of the widest legal review items fits one answer, which a whole set at the maximum never could', async () => {
    const { server } = client();
    const base = server.handle({ method: 'GET', url: `/card-sync/owner/observation-sets/${server.store.sets[0].observationSetId}` }).body as api.SetDetail;
    const page: api.SetDetail = { ...base, itemCount: api.SET_ITEMS_PAGE, items: Array.from({ length: api.SET_ITEMS_PAGE }, (_value, index) => widestItem(index)), nextItemsCursor: null };
    const bytes = Buffer.byteLength(JSON.stringify(page));
    assert.ok(bytes <= api.LARGE_ANSWER_LIMITS.maxBytes / 2, `a page is ${bytes} bytes`);
    // The shared strict-JSON reader never accepts more than 16 MiB in one answer: the whole set has to come in pages.
    assert.ok((bytes / api.SET_ITEMS_PAGE) * api.MAX_SET_ITEMS > 16 * 1024 * 1024);
    const detail = await fixed({ kind: 'json', status: 200, body: JSON.parse(JSON.stringify(page)) }).owner.getObservationSet(base.observationSetId);
    assert.equal(detail.items.length, api.SET_ITEMS_PAGE);
    assert.equal(detail.items[0].candidates[4].notes, wide(api.NOTES_MAX));
  });

  test('a page of the widest legal plan effects fits one answer, which the largest adjustment never could', async () => {
    const effects = Array.from({ length: api.PLAN_EFFECTS_PAGE }, (_value, index) => ({
      itemId: letterId('rvw_', index), rowIndex: 1_999, effect: 'restore-attribution' as const, transactionId: letterId('card-txn-', index),
      before: widestValues(), after: widestValues(),
    }));
    const count = 1_000_000_000;
    const plan: api.Plan = {
      previewId: letterId('prv_', 1), observationSetId: letterId('obs_', 1), setVersion: 2_147_483_647, planKind: 'adjustment',
      payloadDigest: cardSyncPayloadDigest(new FakeOwnerServer().store.sets[0].payload!),
      planDigest: cardSyncPlanDigest({ plan: 'widest' } as unknown as JsonValue),
      createdAt: TIME, expiresAt: TIME, observationExpiresAt: TIME,
      // Every count at its widest, except `aliased`, which must equal the alias effects listed (none here).
      counts: { insert: count, update: count, unchanged: count, aliased: 0, matched: count, attributed: count, promoted: count, corrected: count, rejected: count, unmatched: count, superseded: count },
      effectCount: api.PLAN_EFFECTS_PAGE, effects, nextEffectsCursor: null,
    };
    const bytes = Buffer.byteLength(JSON.stringify(plan));
    assert.ok(bytes <= api.LARGE_ANSWER_LIMITS.maxBytes / 2, `a page is ${bytes} bytes`);
    assert.ok((bytes / api.PLAN_EFFECTS_PAGE) * api.MAX_EFFECTS > 16 * 1024 * 1024);
    const prepared = await fixed({ kind: 'json', status: 201, body: JSON.parse(JSON.stringify(plan)) }).owner.preparePlan(letterId('obs_', 1), { expectedVersion: 1, sourceReviewed: false });
    assert.equal(prepared.effects.length, api.PLAN_EFFECTS_PAGE);
  });

  test('a set of 250 items arrives in pages of 100 and is put together in order', async () => {
    const { server, owner } = client();
    const setId = server.addLargeOpenSet(250);
    const detail = await owner.getObservationSet(setId);
    assert.deepEqual([detail.itemCount, detail.items.length, detail.nextItemsCursor], [250, 250, null]);
    assert.deepEqual(detail.items.map((entry) => entry.itemId), server.store.sets.find((set) => set.observationSetId === setId)!.items.map((entry) => entry.itemId));
    assert.equal(server.requests.filter((request) => request.method === 'GET' && request.path.endsWith(setId)).length, 3);
    // Saving decisions answers with the first page; the client reads the rest.
    const saved = await owner.recordDecisions(setId, {
      expectedVersion: detail.version,
      decisions: detail.items.slice(200).map((entry) => ({ itemId: entry.itemId, action: 'insert-new' as const, transactionId: null, cardScopeId: null })),
    });
    assert.deepEqual([saved.items.length, saved.items.filter((entry) => entry.decision !== null).length, saved.version], [250, 50, detail.version + 1]);
  });

  test('a set that changes between its pages is read again from the start; one that keeps changing is a conflict', async () => {
    const { server } = client();
    const setId = server.addLargeOpenSet(250);
    const set = server.store.sets.find((item) => item.observationSetId === setId)!;
    const change = () => server.core.recordDecisions(setId, set.version, [{ itemId: set.items[0].itemId, action: 'reject-row', transactionId: null, cardScopeId: null }]);
    const watching = (changeOn: (page: number) => boolean) => {
      let pages = 0;
      const owner = createOwnerClient({
        async request(method, path, body) {
          const result = await fakeOwnerTransport(server).request(method, path, body);
          if (method === 'GET' && path.includes(setId)) {
            pages += 1;
            if (changeOn(pages)) change();
          }
          return result;
        },
      });
      return { owner, pages: () => pages };
    };
    const once = watching((page) => page === 1);
    const detail = await once.owner.getObservationSet(setId);
    assert.deepEqual([detail.version, detail.items.length, detail.items[0].decision?.action], [set.version, 250, 'reject-row']);
    assert.equal(once.pages(), 5, 'two pages of the first try, then three');
    const always = watching(() => true);
    await rejects(always.owner.getObservationSet(setId), (error) => assert.deepEqual([error.status, error.code], [409, 'version-conflict']));
  });

  test('pages that repeat, run over, come back empty or do not add up are refused, never shown as the whole set', async () => {
    const { server } = client();
    const setId = server.addLargeOpenSet(150);
    const tampered = (edit: (body: Record<string, unknown>, page: number) => void) => {
      let pages = 0;
      return createOwnerClient({
        async request(method, path, body) {
          const result = await fakeOwnerTransport(server).request(method, path, body);
          if (result.kind === 'json' && method === 'GET' && path.includes(setId)) {
            pages += 1;
            edit(result.body as Record<string, unknown>, pages);
          }
          return result;
        },
      });
    };
    const firstPage = server.handle({ method: 'GET', url: `/card-sync/owner/observation-sets/${setId}` }).body as api.SetDetail;
    const cases: Array<(body: Record<string, unknown>, page: number) => void> = [
      (body, page) => { if (page === 2) body.nextItemsCursor = firstPage.nextItemsCursor; },
      (body, page) => { if (page === 1) body.itemCount = 151; },
      (body, page) => { if (page === 2) body.items = (firstPage.items as unknown[]).slice(0, 50); },
      (body, page) => { if (page === 2) { body.items = []; body.nextItemsCursor = firstPage.nextItemsCursor; } },
    ];
    for (const edit of cases) {
      await rejects(tampered(edit).getObservationSet(setId), (error) => assert.equal(error.kind, 'invalid-answer'));
    }
  });

  test('a later page Holdr refuses as read against another version or ledger revision is read again from the start (revision 4)', async () => {
    const { server } = client();
    const setId = server.addLargeOpenSet(250);
    let pages = 0;
    let refusals = 0;
    const owner = createOwnerClient({
      async request(method, path, body) {
        if (method === 'GET' && path.includes(setId)) {
          pages += 1;
          if (path.includes('itemsCursor') && refusals === 0) {
            refusals += 1;
            return { kind: 'json', status: 409, body: { error: 'version-conflict', currentVersion: 1 } };
          }
        }
        return fakeOwnerTransport(server).request(method, path, body);
      },
    });
    const detail = await owner.getObservationSet(setId);
    assert.deepEqual([detail.items.length, new Set(detail.items.map((entry) => entry.itemId)).size, pages], [250, 250, 5]);
  });

  test('a continuation Holdr no longer takes (422 on the cursor) starts the walk over, at most three times; another 422 is shown at once (E1b revision 7)', async () => {
    const { server } = client();
    const setId = server.addLargeOpenSet(250);
    const cursorRefused = { kind: 'json' as const, status: 422, body: { error: 'invalid-request', issues: [{ code: 'invalid-format', path: '$.itemsCursor' }] } };
    const walking = (refuse: (path: string, refusals: number) => TransportResult | null) => {
      let pages = 0;
      let refusals = 0;
      const owner = createOwnerClient({
        async request(method, path, body) {
          if (method === 'GET' && path.includes(setId)) {
            pages += 1;
            const refusal = path.includes('itemsCursor') ? refuse(path, refusals) : null;
            if (refusal) {
              refusals += 1;
              return refusal;
            }
          }
          return fakeOwnerTransport(server).request(method, path, body);
        },
      });
      return { owner, pages: () => pages };
    };
    // Once (as after a restart of Holdr that changed how it signs cursors): the walk starts over and completes.
    const once = walking((_path, refusals) => (refusals === 0 ? cursorRefused : null));
    const detail = await once.owner.getObservationSet(setId);
    assert.deepEqual([detail.items.length, new Set(detail.items.map((entry) => entry.itemId)).size, once.pages()], [250, 250, 5]);
    // Always: three walks, then the owner reads it again.
    const always = walking(() => cursorRefused);
    await rejects(always.owner.getObservationSet(setId), (error) => assert.deepEqual([error.status, error.code], [409, 'version-conflict']));
    assert.equal(always.pages(), 6);
    // A 422 about anything else is no cursor refusal: shown as it is, with no second walk.
    const other = walking(() => ({ kind: 'json', status: 422, body: { error: 'invalid-request', issues: [{ code: 'out-of-range', path: '$.limit' }] } }));
    await rejects(other.owner.getObservationSet(setId), (error) => assert.deepEqual([error.status, error.code], [422, 'invalid-request']));
    assert.equal(other.pages(), 2);
  });

  test('every later page of a plan\'s effects echoes that plan: another digest is refused, a replaced or run-out plan says so (revision 4)', async () => {
    const { server } = client();
    const setId = server.addLargeOpenSet(600);
    const set = server.store.sets.find((item) => item.observationSetId === setId)!;
    server.core.recordDecisions(setId, set.version, set.items.map((entry) => ({ itemId: entry.itemId, action: 'insert-new' as const, transactionId: null, cardScopeId: null })));
    const echoing = (edit: (page: Record<string, unknown>) => void) => createOwnerClient({
      async request(method, path, body) {
        const result = await fakeOwnerTransport(server).request(method, path, body);
        if (result.kind === 'json' && method === 'GET' && path.includes('/effects?cursor=')) edit(result.body as Record<string, unknown>);
        return result;
      },
    });
    const prepare = (owner: ReturnType<typeof echoing>) => owner.preparePlan(setId, { expectedVersion: set.version, sourceReviewed: false });
    const other = (digest: unknown) => `${String(digest).slice(0, -1)}${String(digest).endsWith('a') ? 'b' : 'a'}`;
    await rejects(prepare(echoing((page) => { page.planDigest = other(page.planDigest); })), (error) => assert.equal(error.kind, 'invalid-answer'));
    await rejects(prepare(echoing((page) => { page.state = 'superseded'; })), (error) => assert.deepEqual([error.status, error.code], [409, 'preview-stale']));
    await rejects(prepare(echoing((page) => { page.state = 'expired'; })), (error) => assert.deepEqual([error.status, error.code], [410, 'plan-expired']));
    // Committed meanwhile, as from another window (X42: consumed → committed): the plan isn't shown, the set is read again.
    await rejects(prepare(echoing((page) => { page.state = 'committed'; })), (error) => assert.deepEqual([error.status, error.code], [409, 'preview-stale']));
    const plan = await prepare(echoing(() => undefined));
    assert.equal(plan.effects.length, 600);
  });

  test('the largest adjustment, 2,000 linked, attributed and promoted rows all changed, is 6,000 effects in pages, within the limit', async () => {
    const { server, owner } = client();
    const setId = server.addLegacyPendingSet(2_000);
    const set = server.store.sets.find((item) => item.observationSetId === setId)!;
    server.core.recordDecisions(setId, set.version, set.items.map((entry) => ({
      itemId: entry.itemId, action: 'attribute-and-link' as const, transactionId: entry.candidates[0].transactionId,
      cardScopeId: set.payload!.rows[entry.rowIndex!].cardScopeId,
    })));
    const linked = await owner.preparePlan(setId, { expectedVersion: set.version, sourceReviewed: false });
    assert.deepEqual([linked.effectCount, linked.counts.matched, linked.counts.promoted, linked.counts.attributed], [2_000, 2_000, 2_000, 2_000]);
    await owner.commitPlan(linked.previewId, linked);
    server.core.recordDecisions(setId, set.version, set.items.map((entry) => ({ itemId: entry.itemId, action: 'insert-new' as const, transactionId: null, cardScopeId: null })));
    const adjustment = await owner.preparePlan(setId, { expectedVersion: set.version, sourceReviewed: false });
    assert.deepEqual([adjustment.planKind, adjustment.effectCount, adjustment.effects.length], ['adjustment', 6_000, 6_000]);
    assert.ok(adjustment.effectCount <= api.MAX_EFFECTS);
    // The promotion's revert restores the whole snapshot, card scope included, so no separate attribution step (E1b §2.10, §4.8).
    const byItem = new Map<string, string[]>();
    for (const effect of adjustment.effects) byItem.set(effect.itemId!, [...(byItem.get(effect.itemId!) ?? []), effect.effect]);
    assert.equal(byItem.size, 2_000);
    assert.ok([...byItem.values()].every((kinds) => kinds.join() === 'revert,unmatch,insert'));
    const revert = adjustment.effects[0];
    assert.deepEqual([revert.before?.status, revert.after?.status, revert.after?.cardScopeId], ['posted', 'pending', set.items[0].candidates[0].cardScopeId]);
    assert.equal(server.requests.filter((request) => request.path.endsWith('/effects')).length, 3 + 11);
    await owner.commitPlan(adjustment.previewId, adjustment);
  });

  test('a set\'s own fields are one request however many items it has', async () => {
    const { server, owner } = client();
    const setId = server.addLargeOpenSet(250);
    const before = server.requests.length;
    const summary = await owner.getSetSummary(setId);
    assert.equal(server.requests.length - before, 1);
    assert.deepEqual(Object.keys(summary).sort(), Object.keys(api.SET_SUMMARY.keys).sort());
    assert.deepEqual([summary.observationSetId, summary.reviewCount, summary.rowCount], [setId, 250, 250]);
  });

  test('a plan of 600 effects arrives in pages of 500 and is put together; its effects go when the plan expires', async () => {
    const { server, owner } = client();
    const setId = server.addLargeOpenSet(600);
    const set = server.store.sets.find((item) => item.observationSetId === setId)!;
    server.core.recordDecisions(setId, set.version, set.items.map((entry) => ({ itemId: entry.itemId, action: 'insert-new' as const, transactionId: null, cardScopeId: null })));
    const plan = await owner.preparePlan(setId, { expectedVersion: set.version, sourceReviewed: false });
    assert.deepEqual([plan.effectCount, plan.effects.length, plan.nextEffectsCursor, plan.counts.insert], [600, 600, null, 600]);
    assert.equal(new Set(plan.effects.map((effect) => effect.rowIndex)).size, 600);
    assert.equal(server.requests.filter((request) => request.path.endsWith('/effects')).length, 1);
    server.advance(11 * MINUTE);
    const late = server.handle({ method: 'GET', url: `/card-sync/owner/plans/${plan.previewId}/effects?cursor=${pageCursor('effects', plan.previewId, api.PLAN_EFFECTS_PAGE)}` });
    assert.deepEqual([late.status, late.body], [410, { error: 'plan-expired' }]);
  });

  test('the agreed wire shape of a file set passes as written; the name `origin` is refused by the key policy', async () => {
    const summary = `{"observationSetId":"obs_aaaabbbbccccddddeeeeffffgggghhhh","sourceKind":"file","runId":null,"bindingId":null,"deviceId":null,
      "importBatchId":"card-import-aaaabbbbccccddddeeeeffffgggghhhh","cardAccountRef":"card-acct-aaaabbbbccccddddeeeeffffgggghhhh",
      "version":1,"state":"needs-review","acceptedAt":"2026-10-17T09:00:00.000Z","expiresAt":"2026-11-16T09:00:00.000Z",
      "rowCount":1,"byteCount":0,"reviewCount":1,"categories":[{"category":"pending-link","count":1}],"plan":null,
      "committedAt":null,"closedAt":null,"closeReason":null`;
    const page = `{"observationSets":[${summary}}],"nextCursor":null}`;
    const listed = await fixed({ kind: 'json', status: 200, body: JSON.parse(page) }).owner.listObservationSets('open');
    assert.deepEqual([listed.observationSets[0].sourceKind, listed.observationSets[0].runId], ['file', null]);
    const detail = `${summary},"currency":"USD","payloadDigest":null,"receiptExpiresAt":null,"rejectedCount":0,"coverage":[],"itemCount":1,
      "items":[{"itemId":"rvw_aaaabbbbccccddddeeeeffffgggghhhh","category":"pending-link","rowIndex":2412,"reason":"removed-hit",
        "observation":{"rowIndex":2412,"transactionDate":"2026-10-08","postedDate":"2026-10-09","status":"posted","amountMinor":6420,
          "kind":"purchase","description":"WINGTIP TOYS","merchant":null,"issuerCategory":null,"cardScopeId":"scp_aaaabbbbccccddddeeeeffffgggghhhh",
          "identity":"legacy-file","originalAmountMinor":null,"originalCurrency":null},
        "candidates":[{"transactionId":"card-txn-aaaabbbbccccddddeeeeffffgggghhhh","cardScopeId":"scp_bbbbccccddddeeeeffffgggghhhhiiii",
          "scopeKind":"known","sourceKind":"extension","status":"removed","transactionDate":"2026-10-08","postedDate":null,"amountMinor":6420,
          "kind":"purchase","description":"WINGTIP TOYS PENDING","merchant":null,"userCategory":"Gifts","notes":"Birthday present (synthetic)",
          "matchedOn":["date","amount","merchant"],"blockedReason":null}],
        "difference":null,"allowedActions":["same-transaction","reject-row"],"decision":null,"committed":null}],
      "nextItemsCursor":null}`;
    const read = await fixed({ kind: 'json', status: 200, body: JSON.parse(detail) }).owner.getObservationSet('obs_aaaabbbbccccddddeeeeffffgggghhhh');
    assert.deepEqual([read.sourceKind, read.payloadDigest, read.items[0].reason, read.items[0].candidates[0].status], ['file', null, 'removed-hit', 'removed']);
    // E2d's rows: `legacy-file` at their position in the file, which can be past an extension payload's 2,000 rows.
    assert.deepEqual([read.items[0].rowIndex, read.items[0].observation?.identity], [2412, 'legacy-file']);
    await rejects(fixed({ kind: 'json', status: 200, body: JSON.parse(page.replace('"sourceKind":"file"', '"origin":"file"')) }).owner.listObservationSets('open'), (error) => {
      assert.equal(error.kind, 'invalid-answer');
      assert.ok(error.extra.issues?.some((issue) => issue.code === 'forbidden-key'));
    });
  });

  test('a candidate\'s own edits follow Phase 4\'s limits: longer notes or a control character are refused', async () => {
    const { server } = client();
    const amex = server.store.sets.find((set) => set.state === 'needs-review' && set.items.some((entry) => entry.candidates.some((candidate) => candidate.notes)))!;
    const body = () => JSON.parse(JSON.stringify(server.handle({ method: 'GET', url: `/card-sync/owner/observation-sets/${amex.observationSetId}` }).body)) as api.SetDetail;
    const withNotes = (notes: string) => {
      const value = body();
      value.items.find((entry) => entry.candidates.some((candidate) => candidate.notes))!.candidates[0].notes = notes;
      return value;
    };
    assert.ok((await fixed({ kind: 'json', status: 200, body: withNotes(wide(api.NOTES_MAX)) }).owner.getObservationSet(amex.observationSetId)).items.length > 0);
    for (const notes of [wide(api.NOTES_MAX + 1), 'two\nlines', '']) {
      await rejects(fixed({ kind: 'json', status: 200, body: withNotes(notes) }).owner.getObservationSet(amex.observationSetId), (error) => assert.equal(error.kind, 'invalid-answer'));
    }
  });
});

describe('X29: ledger repairs over the wire (proposal §3.8)', () => {
  const ids = LEDGER_STORY_IDS;
  const ident = `card-ident-${'a'.repeat(32)}`;
  const sourcesBody = (server: FakeOwnerServer, transactionId: string) =>
    JSON.parse(JSON.stringify(server.handle({ method: 'GET', url: `/card-sync/owner/transactions/${transactionId}/sources` }).body)) as api.TransactionSources;

  test('ids, revisions and a move onto the charge it is on are refused before anything is sent', async () => {
    const { calls, owner } = fixed({ kind: 'json', status: 200, body: {} });
    const cases: Array<() => Promise<unknown>> = [
      () => owner.getTransactionSources('../state'),
      () => owner.getTransactionSources(`card-txn-${'q'.repeat(32)}`),
      () => owner.detachIdentity(`scp_${'a'.repeat(32)}`, { transactionId: ids.tailspin, expectedRevision: 1 }),
      () => owner.detachIdentity(ident, { transactionId: 'card-txn-x', expectedRevision: 1 }),
      () => owner.detachIdentity(ident, { transactionId: ids.tailspin, expectedRevision: 0 }),
      () => owner.detachIdentity(ident, { transactionId: ids.tailspin, expectedRevision: 1.5 }),
      () => owner.repointIdentity(ident, { fromTransactionId: ids.tailspin, expectedRevision: 1, toTransactionId: ids.tailspin, expectedToRevision: 1 }),
      () => owner.repointIdentity(ident, { fromTransactionId: ids.tailspin, expectedRevision: 1, toTransactionId: '../x', expectedToRevision: 1 }),
      () => owner.repointIdentity(ident, { fromTransactionId: '../x', expectedRevision: 1, toTransactionId: ids.tailspinLater, expectedToRevision: 1 }),
      () => owner.repointIdentity(ident, { fromTransactionId: ids.tailspin, expectedRevision: 1, toTransactionId: ids.tailspinLater, expectedToRevision: Number.NaN }),
      () => owner.revertChange(ids.coho, { eventId: ident, expectedRevision: 1 }),
      () => owner.unmergeTransaction(ids.fabrikamDuplicate, { expectedRevision: 1, expectedSurvivorRevision: -1 }),
    ];
    for (const call of cases) await rejects(call(), (error) => assert.equal(error.kind, 'invalid-input'));
    assert.equal(calls.length, 0);
  });

  test('each repair is one POST with exactly its fields; each list is read on with the cursor it was given', async () => {
    const server = new FakeOwnerServer();
    const event = `card-event-${'b'.repeat(32)}`;
    const answer = (transactionId: string) => fixed({ kind: 'json', status: 200, body: sourcesBody(server, transactionId) });
    const reads = (['events', 'identities', 'merged'] as const).map((list) => ({ list, sent: answer(ids.tailspin) }));
    for (const { list, sent } of reads) await sent.owner.getTransactionSources(ids.tailspin, { list, cursor: SOME_CURSOR });
    const detach = answer(ids.tailspin);
    await detach.owner.detachIdentity(ident, { transactionId: ids.tailspin, expectedRevision: 3 });
    const move = answer(ids.tailspin);
    await move.owner.repointIdentity(ident, { fromTransactionId: ids.tailspin, expectedRevision: 3, toTransactionId: ids.tailspinLater, expectedToRevision: 5 });
    const revert = answer(ids.coho);
    await revert.owner.revertChange(ids.coho, { eventId: event, expectedRevision: 2 });
    const unmerge = answer(ids.fabrikamDuplicate);
    await unmerge.owner.unmergeTransaction(ids.fabrikamDuplicate, { expectedRevision: 2, expectedSurvivorRevision: 4 });
    const sources = `/card-sync/owner/transactions/${ids.tailspin}/sources`;
    assert.deepEqual([...reads.map((read) => read.sent), detach, move, revert, unmerge].map((sent) => sent.calls), [
      [{ method: 'GET', path: `${sources}?eventsCursor=${SOME_CURSOR}`, body: undefined }],
      [{ method: 'GET', path: `${sources}?identitiesCursor=${SOME_CURSOR}`, body: undefined }],
      [{ method: 'GET', path: `${sources}?mergedRowsCursor=${SOME_CURSOR}`, body: undefined }],
      [{ method: 'POST', path: `/card-sync/owner/identities/${ident}/detach`, body: { transactionId: ids.tailspin, expectedRevision: 3 } }],
      [{ method: 'POST', path: `/card-sync/owner/identities/${ident}/repoint`, body: {
        fromTransactionId: ids.tailspin, toTransactionId: ids.tailspinLater, expectedRevision: 3, expectedToRevision: 5,
      } }],
      [{ method: 'POST', path: `/card-sync/owner/transactions/${ids.coho}/revert`, body: { eventId: event, expectedRevision: 2 } }],
      [{ method: 'POST', path: `/card-sync/owner/transactions/${ids.fabrikamDuplicate}/unmerge`, body: { expectedRevision: 2, expectedSurvivorRevision: 4 } }],
    ]);
  });

  test('an answer about another charge, or one that does not hold together, is refused, never shown', async () => {
    const server = new FakeOwnerServer();
    const bodies = {
      tailspin: sourcesBody(server, ids.tailspin),
      coho: sourcesBody(server, ids.coho),
      fabrikam: sourcesBody(server, ids.fabrikam),
      fabrikamDuplicate: sourcesBody(server, ids.fabrikamDuplicate),
    };
    const read = (body: unknown, transactionId: string) => fixed({ kind: 'json', status: 200, body }).owner.getTransactionSources(transactionId);
    for (const [name, body] of Object.entries(bodies)) assert.equal((await read(body, ids[name as keyof typeof bodies])).transaction.transactionId, ids[name as keyof typeof bodies]);
    const otherAccount = server.store.cardAccounts.find((account) => account.id !== bodies.tailspin.transaction.cardAccountRef)!.id;
    type Edit = (body: api.TransactionSources) => void;
    const cases: Array<[keyof typeof bodies, string, Edit]> = [
      ['tailspin', 'about another charge', (body) => { body.transaction.transactionId = ids.coho; }],
      ['tailspin', 'no revision on an event that is no alias leaving', (body) => { body.events[0].revision = null; }],
      ['fabrikamDuplicate', 'an alias that left for this same charge', (body) => { body.events[0].relatedTransactionId = ids.fabrikamDuplicate; }],
      ['fabrikam', 'a re-point from nowhere', (body) => {
        const repoint = body.events.find((event) => event.eventType === 'identity-repointed')!;
        repoint.relatedTransactionId = null;
      }],
      ['tailspin', 'an alias event naming no alias', (body) => { body.events[0].identityId = null; }],
      // E1b `ck_evt_*`: each event keeps a reason its own type allows, also when one update wrote several.
      ['coho', 'a promotion with a restore\'s reason', (body) => { body.events[0].reason = 'restore'; }],
      ['tailspin', 'a link with a repair\'s reason', (body) => { body.events[0].reason = 'maintenance'; }],
      ['fabrikam', 'a category edit with a merge\'s reason', (body) => { body.events[0].reason = 'superseded'; }],
      ['fabrikamDuplicate', 'a merge with the other merge\'s reason', (body) => {
        body.events.find((event) => event.eventType === 'superseded')!.reason = 'settled-into';
      }],
      ['fabrikamDuplicate', 'a merge naming no other charge', (body) => {
        body.events.find((event) => event.eventType === 'superseded')!.relatedTransactionId = null;
      }],
      ['fabrikam', 'an edit naming no field', (body) => { body.events[0].edited = []; }],
      ['tailspin', 'a field edit on an event that is no edit', (body) => { body.events[0].edited = ['notes']; }],
      ['tailspin', 'an undo offered for a change that can\'t be undone', (body) => { body.revertibleEventId = body.events[0].eventId; }],
      ['fabrikamDuplicate', 'an undo offered for an alias that left', (body) => { body.revertibleEventId = body.events[0].eventId; }],
      ['coho', 'an undo offered for a browser\'s change', (body) => {
        body.events[0].actor = 'device';
        body.events[0].deviceId = `dev_${'a'.repeat(32)}`;
      }],
      ['tailspin', 'an alias twice', (body) => { body.identities.push({ ...body.identities[0] }); }],
      ['tailspin', 'an event twice', (body) => { body.events.push({ ...body.events[0] }); }],
      ['tailspin', 'a device event without its device', (body) => { body.events[0].actor = 'device'; }],
      ['tailspin', 'an owner event naming a device', (body) => { body.events[0].deviceId = `dev_${'a'.repeat(32)}`; }],
      ['coho', 'a reversal that names nothing', (body) => { body.events[0].eventType = 'reversed'; }],
      ['coho', 'a promotion that names a reversal', (body) => { body.events[0].reversesEventId = body.events[1].eventId; }],
      ['tailspin', 'a removal reason on a live row', (body) => { body.transaction.removedReason = 'dismissed'; }],
      ['tailspin', 'merged without a merge', (body) => { body.transaction.mergedIntoId = ids.coho; }],
      ['fabrikamDuplicate', 'merged into itself', (body) => { body.transaction.mergedIntoId = ids.fabrikamDuplicate; }],
      ['fabrikamDuplicate', 'a merge reason without the row', (body) => { body.transaction.mergedIntoId = null; }],
      ['fabrikam', 'a merged row of another charge', (body) => { body.mergedRows[0].mergedIntoId = ids.coho; }],
      ['fabrikam', 'a merged row still live', (body) => { body.mergedRows[0].values.status = 'posted'; }],
      ['fabrikam', 'a merged row dismissed', (body) => { body.mergedRows[0].removedReason = 'dismissed'; }],
      ['fabrikam', 'a merged row of another account', (body) => { body.mergedRows[0].cardAccountRef = otherAccount; }],
      ['fabrikam', 'a merged row twice', (body) => { body.mergedRows.push({ ...body.mergedRows[0] }); }],
      ['tailspin', 'a refused key', (body) => { (body.events[0] as unknown as Record<string, unknown>).origin = 'session'; }],
      ['tailspin', 'an unknown key', (body) => { (body.identities[0] as unknown as Record<string, unknown>).namespace = 'x'; }],
      ['tailspin', 'a card number in a description', (body) => { body.transaction.values.description = 'TAILSPIN 4111 1111 1111 1111'; }],
      ['tailspin', 'an alias of an unknown kind', (body) => { (body.identities[0] as unknown as Record<string, unknown>).namespaceKind = 'guess'; }],
    ];
    for (const [name, label, edit] of cases) {
      const body = JSON.parse(JSON.stringify(bodies[name])) as api.TransactionSources;
      edit(body);
      await assert.rejects(read(body, ids[name]), (error: unknown) => {
        assert.ok(isOwnerApiError(error) && error.kind === 'invalid-answer', label);
        return true;
      });
    }
    // The change that can be undone may be on an older page of the history: that is fine.
    const olderPage = JSON.parse(JSON.stringify(bodies.coho)) as api.TransactionSources;
    olderPage.events = olderPage.events.slice(1);
    assert.equal((await read(olderPage, ids.coho)).revertibleEventId, bodies.coho.revertibleEventId);
  });

  test('the repair errors map to their fixed codes', async () => {
    for (const code of ['transaction-revision-stale', 'merge-not-allowed', 'cross-card-link-refused'] as const) {
      await rejects(fixed({ kind: 'json', status: 409, body: { error: code } }).owner.unmergeTransaction(ids.fabrikamDuplicate, {
        expectedRevision: 2, expectedSurvivorRevision: 2,
      }), (error) => assert.deepEqual([error.kind, error.status, error.code], ['http', 409, code]));
    }
  });
});

describe('revision 7 (E1b): alias effects over the wire (X37)', () => {
  /** The fake's plan of the fresh Chase capture: four rows to add, one unchanged, one alias. */
  const planBody = (server: FakeOwnerServer) => {
    const set = server.store.sets[0];
    const answer = server.handle({
      method: 'POST', url: `/card-sync/owner/observation-sets/${set.observationSetId}/plan`,
      headers: { 'x-holdr-request': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: set.version, sourceReviewed: false }),
    });
    assert.equal(answer.status, 200);
    return { set, body: JSON.parse(JSON.stringify(answer.body)) as api.Plan };
  };

  test('an alias effect is shown only with its charge, its values unchanged, and the aliased count matching the effects listed', async () => {
    const { set, body } = planBody(new FakeOwnerServer({ recentAuth: 'granted' }));
    const prepare = (plan: api.Plan) => fixed({ kind: 'json', status: 201, body: plan }).owner
      .preparePlan(set.observationSetId, { expectedVersion: set.version, sourceReviewed: false });
    const plan = await prepare(body);
    const alias = plan.effects.find((effect) => effect.effect === 'alias')!;
    assert.deepEqual([plan.counts.aliased, plan.counts.unchanged, plan.effects.length, plan.effectCount], [1, 1, 5, 5]);
    assert.deepEqual(alias.before, alias.after);
    const aliasOf = (tampered: api.Plan) => tampered.effects.find((effect) => effect.effect === 'alias')!;
    const cases: Array<[string, (tampered: api.Plan) => void]> = [
      ['a value changed under an alias', (tampered) => { aliasOf(tampered).after!.amountMinor += 1; }],
      ['a card changed under an alias', (tampered) => { aliasOf(tampered).after!.cardScopeId = null; }],
      ['an alias naming no charge', (tampered) => { aliasOf(tampered).transactionId = null; }],
      ['an alias of no observed row', (tampered) => { aliasOf(tampered).rowIndex = null; }],
      ['an alias without the values it keeps', (tampered) => { aliasOf(tampered).before = null; }],
      ['more aliases counted than listed', (tampered) => { tampered.counts.aliased = 2; }],
      ['an alias listed but not counted', (tampered) => { tampered.counts.aliased = 0; }],
    ];
    for (const [label, edit] of cases) {
      const tampered = JSON.parse(JSON.stringify(body)) as api.Plan;
      edit(tampered);
      await rejects(prepare(tampered), (error) => assert.equal(error.kind, 'invalid-answer', label));
    }
  });

  test('a plan without `aliased` in its counts is refused: the strict reader wants every count', async () => {
    const { set, body } = planBody(new FakeOwnerServer({ recentAuth: 'granted' }));
    const { aliased: _aliased, ...counts } = body.counts;
    await rejects(fixed({ kind: 'json', status: 201, body: { ...body, counts } }).owner
      .preparePlan(set.observationSetId, { expectedVersion: set.version, sourceReviewed: false }), (error) => assert.equal(error.kind, 'invalid-answer'));
  });
});

describe('E2a\'s answers the first client didn\'t know (handoff 10/18 02:30)', () => {
  const ids = LEDGER_STORY_IDS;
  const previewId = `prv_${'b'.repeat(32)}`;

  test('item 1: transaction-not-found, link-not-reversible and internal-error are fixed codes; only the 500 leaves the outcome unknown', async () => {
    await rejects(fixed({ kind: 'json', status: 404, body: { error: 'transaction-not-found' } }).owner.getTransactionSources(ids.coho),
      (error) => assert.deepEqual([error.kind, error.status, error.code], ['http', 404, 'transaction-not-found']));
    await rejects(fixed({ kind: 'json', status: 409, body: { error: 'link-not-reversible' } }).owner.unmergeTransaction(ids.fabrikamDuplicate, {
      expectedRevision: 2, expectedSurvivorRevision: 2,
    }), (error) => {
      assert.deepEqual([error.kind, error.status, error.code], ['http', 409, 'link-not-reversible']);
      assert.equal(isUnknownOutcome(error), false, 'a refused unmerge changed nothing');
    });
    await rejects(fixed({ kind: 'json', status: 500, body: { error: 'internal-error' } }).owner.pause(), (error) => {
      assert.deepEqual([error.status, error.code], [500, 'internal-error']);
      assert.equal(isUnknownOutcome(error), true, 'a failure part-way may have saved it');
    });
  });

  test('item 1: authorization-blocked is a refusal at 409 (E2b) and at 503 (E2a\'s plan and commit while the gate is blocked)', async () => {
    for (const status of [409, 503]) {
      await rejects(fixed({ kind: 'json', status, body: { error: 'authorization-blocked' } }).owner.commitPlan(previewId, {
        payloadDigest: null, planDigest: `pl1:${'a'.repeat(64)}`,
      }), (error) => {
        assert.deepEqual([error.status, error.code], [status, 'authorization-blocked']);
        assert.equal(isUnknownOutcome(error), false, `${status}: nothing was written`);
      });
    }
    // A 503 without that code (a busy database) still leaves a write's outcome unknown.
    await rejects(fixed({ kind: 'json', status: 503, body: { error: 'unavailable', retryAfterSeconds: 1 } }).owner.pause(),
      (error) => assert.equal(isUnknownOutcome(error), true));
  });

  test('item 2: a charge an earlier Holdr removed without recording why reads as removed for the reason `legacy`', async () => {
    const { server, owner } = client();
    const sources = await owner.getTransactionSources(server.addLegacyRemovedCharge());
    assert.deepEqual([sources.transaction.values.status, sources.transaction.removedReason, sources.transaction.mergedIntoId, sources.events],
      ['removed', 'legacy', null, []]);
    assert.deepEqual(sources.identities.map((identity) => [identity.createdBy, identity.namespaceKind, identity.scopeKind]),
      [['migration', 'legacy-file', 'legacy']]);
    assert.match(REMOVED_TEXT.legacy, /didn't record why/);
  });

  test('item 4: a run whose review expired lists no row of its own; its record says none was added', async () => {
    const { server, owner } = client();
    const set = server.store.sets.find((item) => item.state === 'accepted-uncommitted' && item.runId !== null)!;
    const before = await owner.getRun(set.runId!);
    assert.ok(before.results.length > 0);
    server.advance(set.expiresAt - server.now() + MINUTE);
    const after = await owner.getRun(set.runId!);
    assert.deepEqual([after.acceptance, after.results], ['expired-unreviewed', []]);
    assert.match(runRowsNote(after) ?? '', /expired before anyone reviewed (it|them), so nothing from this run was added/);
  });

  test('item 4: a run whose review expired lists no row even while Holdr still keeps its content', async () => {
    // E2a's retention closes a set at its deadline and clears its content in a later chunk (retention.ts phases 3 and 5);
    // until then its run says the content is kept, and lists no row of its own. The fake clears at once, so this sets that
    // moment up directly.
    const { server, owner } = client();
    const set = server.store.sets.find((item) => item.state === 'accepted-uncommitted' && item.runId !== null)!;
    assert.ok((await owner.getRun(set.runId!)).results.length > 0);
    Object.assign(set, { state: 'expired-unreviewed', closedAt: server.now(), closeReason: 'expired' });
    assert.ok(set.payload, 'its content is still there');
    const run = await owner.getRun(set.runId!);
    assert.deepEqual([run.acceptance, run.contentRetained, run.results], ['expired-unreviewed', true, []]);
    assert.match(runRowsNote(run) ?? '', /^\d+ rows? expired before anyone reviewed (it|them), so nothing from this run was added\.$/);
  });
});