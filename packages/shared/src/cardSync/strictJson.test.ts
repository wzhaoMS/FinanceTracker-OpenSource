import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson, utf8ByteLength } from './canonical.js';
import { CARD_SYNC_ISSUE_CODES, CARD_SYNC_ISSUE_PATH, type CardSyncIssue } from './issues.js';
import {
  CARD_SYNC_PROTOTYPE_KEYS,
  checkExactKeys,
  isForbiddenCardSyncKey,
  snapshotStrictJson,
  STRICT_JSON_DEFAULT_LIMITS,
} from './strictJson.js';
import { CardSyncIssueList } from './issues.js';
import { CARD_SYNC_V2_KNOWN_KEYS } from './wireV2.js';
import { PROJECTED_BATCH_KNOWN_KEYS } from './projectedBatch.js';
import { formatCardSyncId } from './ids.js';

// Published test card numbers only.
const PANS = ['4111111111111111', '371449635398431', '5555555555554444', '6011111111111117'];
const CANARY = 'ZQXCANARYTOKEN';

function issuesOf(value: unknown, options?: Parameters<typeof snapshotStrictJson>[1]): CardSyncIssue[] {
  const result = snapshotStrictJson(value, options);
  assert.equal(result.ok, false, 'expected refusal');
  return result.ok ? [] : result.issues;
}

function assertOnly(value: unknown, code: CardSyncIssue['code'], path: string, options?: Parameters<typeof snapshotStrictJson>[1]): void {
  assert.deepEqual(issuesOf(value, options), [{ code, path }]);
}

function assertValueFree(issues: readonly CardSyncIssue[], secrets: readonly string[] = []): void {
  for (const issue of issues) {
    assert.deepEqual(Object.keys(issue).sort(), ['code', 'path']);
    assert.ok((CARD_SYNC_ISSUE_CODES as readonly string[]).includes(issue.code), issue.code);
    assert.match(issue.path, CARD_SYNC_ISSUE_PATH);
  }
  const text = JSON.stringify(issues);
  for (const secret of [CANARY, ...secrets]) assert.ok(!text.includes(secret), 'an issue echoes input');
}

describe('snapshotStrictJson: plain JSON', () => {
  it('returns a detached deep copy and the canonical UTF-8 length', () => {
    const input = { b: [1, { c: 'é😀\n"' }], a: null, t: true, f: false, n: -42 };
    const result = snapshotStrictJson(input);
    assert.ok(result.ok);
    assert.deepEqual(result.value, input);
    assert.notEqual(result.value, input);
    assert.equal(result.byteLength, utf8ByteLength(canonicalJson(result.value)));
    (input.b[1] as { c: string }).c = 'changed';
    assert.equal(((result.value as typeof input).b[1] as { c: string }).c, 'é😀\n"');
  });

  it('accepts null-prototype objects and empty containers', () => {
    const bare = Object.create(null);
    bare.x = [];
    bare.y = {};
    const result = snapshotStrictJson(bare);
    assert.ok(result.ok);
    assert.equal(result.byteLength, canonicalJson(result.value).length);
  });

  it('copies an object shared by two parents twice, as JSON would', () => {
    const shared = { start: '2026-09-14' };
    const result = snapshotStrictJson({ a: shared, b: [shared, shared] });
    assert.ok(result.ok);
    const value = result.value as { a: object; b: object[] };
    assert.deepEqual(value.a, shared);
    assert.notEqual(value.a, value.b[0]);
    assert.notEqual(value.b[0], value.b[1]);
  });

  it('measures exactly the canonical bytes for escapes, astral and control characters', () => {
    const samples = ['', 'plain', '"\\', '\u0000\u0001\u001f\u007f', '\b\f\n\r\t', 'é', '€', '😀', '\u2028\u2029', 'a/b'];
    for (const sample of samples) {
      const result = snapshotStrictJson({ [`k${samples.indexOf(sample)}`]: sample });
      assert.ok(result.ok);
      assert.equal(result.byteLength, Buffer.byteLength(canonicalJson(result.value), 'utf8'));
    }
  });
});

describe('snapshotStrictJson: JSON-only values', () => {
  it('refuses undefined, functions, symbols and bigints', () => {
    assertOnly({ a: undefined }, 'not-json-value', '$.<key>');
    assertOnly({ a: () => 1 }, 'not-json-value', '$.<key>');
    assertOnly([Symbol('s')], 'not-json-value', '$[0]');
    assertOnly([1n], 'not-json-value', '$[0]');
    assertOnly(undefined, 'not-json-value', '$');
  });

  it('refuses NaN, infinities, -0 and (by default) fractions', () => {
    assertOnly([Number.NaN], 'non-finite-number', '$[0]');
    assertOnly([Number.POSITIVE_INFINITY], 'non-finite-number', '$[0]');
    assertOnly([Number.NEGATIVE_INFINITY], 'non-finite-number', '$[0]');
    assertOnly([-0], 'negative-zero', '$[0]');
    assertOnly([0.5], 'not-integer', '$[0]');
    assert.ok(snapshotStrictJson([0.5], { allowFractions: true }).ok);
    assert.ok(snapshotStrictJson([0, -1, 9_999_999_999]).ok);
  });

  it('refuses objects that are not plain', () => {
    class Row {
      amount = 1;
    }
    for (const value of [new Date(0), new Map(), new Set(), /x/, new Row(), new String('x'), new Number(1), new Error('x'), Object.create({})]) {
      assertOnly([value], 'not-plain-object', '$[0]');
    }
    assertOnly([new Uint8Array(4)], 'not-plain-object', '$[0]');
    class Rows extends Array {}
    assertOnly([Rows.from([1])], 'invalid-array', '$[0]');
  });

  it('refuses holes and extra properties on arrays', () => {
    const sparse = [1, 2, 3];
    delete sparse[1];
    assertOnly({ list: sparse }, 'invalid-array', '$.<key>');
    // eslint-disable-next-line no-sparse-arrays
    assertOnly([1, , 3], 'invalid-array', '$');
    const extra = Object.assign([1], { note: 'x' });
    assertOnly(extra, 'invalid-array', '$');
    const symbol = [1];
    (symbol as unknown as Record<symbol, number>)[Symbol('s')] = 1;
    assertOnly(symbol, 'invalid-array', '$');
    const long: unknown[] = [];
    long.length = 4_000_000_000;
    assertOnly(long, 'too-many-items', '$');
  });

  it('refuses accessors without ever invoking them', () => {
    let calls = 0;
    const object = {};
    Object.defineProperty(object, 'description', { get: () => { calls += 1; return 'x'; }, enumerable: true });
    assertOnly(object, 'accessor-property', '$.<key>');
    const setterOnly = {};
    Object.defineProperty(setterOnly, 'value', { set: () => { calls += 1; }, enumerable: true });
    assertOnly(setterOnly, 'accessor-property', '$.<key>');
    const array = [1, 2];
    Object.defineProperty(array, 1, { get: () => { calls += 1; return 2; }, enumerable: true });
    assertOnly(array, 'accessor-property', '$[1]');
    assert.equal(calls, 0);
  });

  it('refuses non-enumerable and symbol-keyed properties, which JSON would silently drop', () => {
    const hidden = {};
    Object.defineProperty(hidden, 'amountMinor', { value: 1, enumerable: false });
    assertOnly(hidden, 'hidden-property', '$.<key>');
    assertOnly({ [Symbol('s')]: 1 }, 'hidden-property', '$.<key>');
    const args = (function (..._values: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      return arguments;
    })(1);
    assert.equal(snapshotStrictJson(args).ok, false);
  });

  it('refuses cycles but not shared references', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    assertOnly(loop, 'cyclic-reference', '$.<key>');
    const list: unknown[] = [];
    list.push([list]);
    assertOnly(list, 'cyclic-reference', '$[0][0]');
  });

  it('refuses unpaired surrogates in values and keys, accepts pairs', () => {
    assertOnly(['\ud800'], 'ill-formed-unicode', '$[0]');
    assertOnly(['x\udfff'], 'ill-formed-unicode', '$[0]');
    assertOnly({ ['k\ud83d']: 1 }, 'ill-formed-unicode', '$.<key>');
    assert.ok(snapshotStrictJson(['😀']).ok);
  });

  it('reports exotic objects that throw as unreadable and never throws itself', () => {
    const throwing = (trap: keyof ProxyHandler<object>) => new Proxy({ a: 1 }, { [trap]: () => { throw new Error(CANARY); } });
    for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const) {
      const issues = issuesOf({ value: throwing(trap) }, { knownKeys: new Set(['value']) });
      assert.deepEqual(issues.map((issue) => issue.code), ['unreadable']);
      assertValueFree(issues);
    }
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assert.deepEqual(issuesOf([proxy]).map((issue) => issue.code), ['unreadable']);
    const arrayProxy = new Proxy([1, 2], { getOwnPropertyDescriptor: () => { throw new Error(CANARY); } });
    assert.deepEqual(issuesOf([arrayProxy]).map((issue) => issue.code), ['unreadable']);
  });

  it('reads a well-behaved proxy once per property and keeps a plain copy', () => {
    const reads = new Map<PropertyKey, number>();
    const target = { a: 1, b: 'two' };
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(object, key) {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
    });
    const result = snapshotStrictJson(proxy);
    assert.ok(result.ok);
    assert.deepEqual(result.value, target);
    for (const count of reads.values()) assert.equal(count, 1);
  });
});

describe('snapshotStrictJson: prototype and forbidden keys', () => {
  it('refuses every prototype key and never pollutes Object.prototype', () => {
    for (const key of CARD_SYNC_PROTOTYPE_KEYS) {
      const value = JSON.parse(`{"row":{${JSON.stringify(key)}:{"polluted":true}}}`);
      assert.deepEqual(issuesOf(value, { knownKeys: new Set(['row']) }), [{ code: 'prototype-key', path: '$.row.<key>' }]);
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
  });

  it('refuses keys that may never be sent, in any spelling and at any depth', () => {
    const forbidden = [
      'raw', 'rawData', 'raw_response', 'extra', 'extraFields', 'metadata', 'META', 'diagnostics', 'debug', 'stack', 'errorMessage',
      'accountToken', 'account_token', 'ACCOUNT-TOKEN', 'bizToken', 'CCPToken', 'csrfToken', 'X-XSRF-TOKEN', 'apiKey', 'accountKey',
      'secret', 'password', 'sessionId', 'Authorization', 'bearer', 'cookie', 'Set-Cookie', 'headers', 'x-jpmc-csrf-token',
      'accountId', 'account_id', 'digitalAccountIdentifier', 'accountNumber', 'account_number', 'cardNumber', 'pan', 'ACCTID', 'acct',
      'cvv', 'cvc2', 'pin', 'securityCode', 'expiry', 'exp', 'expirationDate', 'validThru',
      'name', 'firstName', 'last_name', 'cardMemberName', 'embossed_name', 'greetingName', 'holder', 'cardholder', 'profile',
      'email', 'emailAddress', 'address', 'billingAddress', 'phone', 'phoneNumber', 'zipCode', 'ssn', 'dob',
      'url', 'nextUrl', 'baseURL', 'href', 'links', 'origin', 'referrer', 'host', 'endpoint', 'selector', 'accountSelector',
      '__INITIAL_STATE__', 'html', 'body', 'response', 'request', 'har', '\uff52\uff41\uff57', 'account', 'card',
    ];
    for (const key of forbidden) {
      assert.equal(isForbiddenCardSyncKey(key), true, key);
      const issues = issuesOf({ rows: [{ [key]: 'x' }] }, { knownKeys: new Set(['rows']) });
      assert.deepEqual(issues[0], { code: 'forbidden-key', path: '$.rows[0].<key>' }, key);
      // A card-secret column (cvv, pin, expiry) with any value is also a secret, as in v1.
      for (const issue of issues.slice(1)) assert.deepEqual(issue, { code: 'card-secret', path: '$.rows[0].<key>' }, key);
    }
  });

  it('allows every schema key and ordinary message keys', () => {
    for (const key of [...CARD_SYNC_V2_KNOWN_KEYS, ...PROJECTED_BATCH_KNOWN_KEYS, 'type', 'payload', 'state', 'idempotencyKey', 'runId', 'count']) {
      assert.equal(isForbiddenCardSyncKey(key), false, key);
    }
  });
});

describe('snapshotStrictJson: card data and secrets', () => {
  it('refuses card numbers in values in any grouping, script or padding', () => {
    for (const pan of PANS) {
      const groups = pan.match(/.{1,4}/g)!;
      const variants = [
        pan, `PURCHASE ${pan}`, groups.join(' '), groups.join('-'), groups.join('\u2013'), [...pan].join('\u200b'),
        pan.replace(/\d/g, (digit) => String.fromCharCode(0xff10 + Number(digit))),
        pan.replace(/\d/g, (digit) => String.fromCharCode(0x0660 + Number(digit))),
        `${pan.slice(0, 6)}******${pan.slice(-4)}`, `XXXX-XXXXXX-${pan.slice(-5)}`, `${'\u200b'.repeat(500)}${pan}`,
      ];
      for (const variant of variants) {
        const issues = issuesOf({ text: variant }, { knownKeys: new Set(['text']) });
        assert.deepEqual(issues, [{ code: 'card-data', path: '$.text' }], variant.slice(0, 40));
        assertValueFree(issues, [pan]);
      }
    }
    assertOnly({ text: '1234567890123' }, 'card-data', '$.<key>');
  });

  it('refuses card numbers in keys and identifier-sized numbers', () => {
    for (const pan of PANS) {
      const issues = issuesOf({ [pan]: 1 });
      assert.deepEqual(issues, [{ code: 'card-data', path: '$.<key>' }]);
      assertValueFree(issues, [pan]);
      assertOnly({ value: Number(pan) }, 'card-data', '$.<key>');
    }
    assertOnly([1e11], 'card-data', '$[0]');
    assertOnly([-1e11], 'card-data', '$[0]');
    assertOnly([1e21], 'card-data', '$[0]');
    assert.ok(snapshotStrictJson([99_999_999_999]).ok);
  });

  it('refuses card secrets in values, keys and key/value pairs', () => {
    assertOnly({ note: 'CVV 123' }, 'card-secret', '$.<key>');
    assertOnly({ note: 'exp 12/29' }, 'card-secret', '$.<key>');
    assertOnly({ 'cvv 123': 1 }, 'card-secret', '$.<key>');
    assertOnly({ x_cvv: '123' }, 'card-secret', '$.<key>');
    assertOnly({ x_pin: 1234 }, 'card-secret', '$.<key>');
    assertOnly({ x_exp_date: '2029-12' }, 'card-secret', '$.<key>');
    assert.deepEqual(issuesOf({ cvv: '123' }).map((issue) => issue.code).sort(), ['card-secret', 'forbidden-key']);
    assert.deepEqual(issuesOf({ pin: 1234 }).map((issue) => issue.code).sort(), ['card-secret', 'forbidden-key']);
  });

  it('does not flag dates, amounts, opaque ids or hashes', () => {
    const value = {
      transactionDate: '2026-09-14',
      observedAt: '2026-10-16T14:05:09.123Z',
      amountMinor: 9_999_999_999,
      bindingId: `bnd_${'cidpinexp'.repeat(4).slice(0, 32)}`,
      externalIdHash: `xid1:${'abcdefghijklmnop'.repeat(4)}`,
      description: 'STORE 0042 ORDER 1234 REF 77',
    };
    assert.ok(snapshotStrictJson(value).ok);
  });
});

describe('snapshotStrictJson: limits', () => {
  const limits = { maxDepth: 2, maxKeysPerObject: 3, maxArrayLength: 3, maxNodes: 12, maxStringLength: 5, maxKeyLength: 4, maxBytes: 40 };

  it('accepts values at each limit and refuses one past it', () => {
    assert.ok(snapshotStrictJson({ a: [[1]] }, { limits }).ok);
    assertOnly({ a: [[[1]]] }, 'too-deep', '$.<key>[0][0]', { limits });
    assert.ok(snapshotStrictJson({ a: 1, b: 2, c: 3 }, { limits }).ok);
    assertOnly({ a: 1, b: 2, c: 3, d: 4 }, 'too-many-keys', '$', { limits });
    assert.ok(snapshotStrictJson([1, 2, 3], { limits }).ok);
    assertOnly([1, 2, 3, 4], 'too-many-items', '$', { limits });
    assert.ok(snapshotStrictJson(['abcde'], { limits }).ok);
    assertOnly(['abcdef'], 'string-too-long', '$[0]', { limits });
    assert.ok(snapshotStrictJson({ abcd: 1 }, { limits }).ok);
    assertOnly({ abcde: 1 }, 'key-too-long', '$.<key>', { limits });
    assertOnly([[1, 2, 3], [1, 2, 3], [1, 2, 3]], 'too-many-nodes', '$[2][2]', { limits });
  });

  it('measures the byte budget on the canonical form, exactly', () => {
    const value = { a: 'x'.repeat(30) };
    const size = canonicalJson(value).length;
    assert.ok(snapshotStrictJson(value, { limits: { maxBytes: size, maxStringLength: 100 } }).ok);
    assertOnly(value, 'too-large', '$.<key>', { limits: { maxBytes: size - 1, maxStringLength: 100 } });
  });

  it('stops scanning once a budget is spent', () => {
    const bulk = Array.from({ length: 50_000 }, () => 'x'.repeat(4_000));
    const started = performance.now();
    const issues = issuesOf(bulk, { limits: { maxArrayLength: 100_000 } });
    assert.equal(issues[issues.length - 1].code, 'too-large');
    assert.ok(performance.now() - started < 2_000);
  });

  it('clamps limits to hard ceilings and ignores invalid overrides', () => {
    let deep: unknown = 1;
    for (let level = 0; level < 40; level += 1) deep = [deep];
    assert.deepEqual(issuesOf(deep, { limits: { maxDepth: 1e9 } }).map((issue) => issue.code), ['too-deep']);
    assert.ok(snapshotStrictJson([1], { limits: { maxDepth: -1, maxNodes: Number.NaN } as never }).ok);
    let veryDeep: unknown = 1;
    for (let level = 0; level < 100_000; level += 1) veryDeep = [veryDeep];
    assert.deepEqual(issuesOf(veryDeep).map((issue) => issue.code), ['too-deep']);
    assert.equal(STRICT_JSON_DEFAULT_LIMITS.maxDepth, 16);
  });

  it('caps the number of issues and reports each code and path once', () => {
    const many = Array.from({ length: 40 }, () => undefined);
    assert.equal(issuesOf(many).length, 20);
    assert.equal(issuesOf(many, { maxIssues: 5 }).length, 5);
    // Unknown keys all read `<key>`, so the same problem under several of them is one issue.
    const unknown = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`key${String.fromCharCode(97 + index)}`, undefined]));
    assert.deepEqual(issuesOf(unknown), [{ code: 'not-json-value', path: '$.<key>' }]);
  });
});

describe('checkExactKeys', () => {
  it('names missing keys and hides unknown ones', () => {
    const issues = new CardSyncIssueList();
    assert.equal(checkExactKeys({ a: 1, [`${CANARY}`]: 2 }, '$.row', ['a', 'b'], issues), false);
    assert.deepEqual(issues.list, [{ code: 'unknown-key', path: '$.row.<key>' }, { code: 'missing-key', path: '$.row.b' }]);
    assertValueFree(issues.list);
    assert.equal(checkExactKeys({ a: 1, b: 2 }, '$', ['a', 'b'], new CardSyncIssueList()), true);
  });
});

describe('E2 response keys (contract doc section 15a)', () => {
  /** Key names E2's device-facing JSON may use: each passes the unchanged policy. */
  const APPROVED = [
    'error', 'issues', 'code', 'path', 'status', 'deviceId', 'deviceLabel', 'deviceExpiresAt', 'fingerprint', 'pendingExpiresAt',
    'clientVersion', 'syncEnabled', 'payloadVersions', 'contractVersions', 'maxPayloadBytes', 'maxRows', 'issuers', 'issuer', 'enabled',
    'bindings', 'bindingId', 'bindingVersion', 'bindingLabel', 'source', 'cards', 'scopes', 'cardScopeId', 'scopeLabel', 'last4',
    'holderUnknown', 'clientRunId', 'runId', 'adapterVersion', 'contractVersion', 'trigger', 'expiresAt', 'observationSetId',
    'payloadDigest', 'acceptedAt', 'previewId', 'planDigest', 'insert', 'update', 'unchanged', 'needsReview', 'committedAt',
    'inserted', 'updated', 'acceptance', 'ledger', 'holdrOrigin', 'retryAfterSeconds',
  ];
  const id = (kind: Parameters<typeof formatCardSyncId>[0]) => formatCardSyncId(kind, new Uint8Array(16).fill(0x5a));

  it('passes the approved names and refuses the bearer, session, name and location ones', () => {
    for (const key of APPROVED) assert.equal(isForbiddenCardSyncKey(key), false, key);
    for (const key of ['deviceName', 'deviceToken', 'sessionId', 'targetUrl', 'issuerName', 'tokenExpiresAt', 'credentialExpiresAt']) {
      assert.equal(isForbiddenCardSyncKey(key), true, key);
    }
  });

  it('accepts a capabilities response written in them, and refuses the redeem response that needs its own parser', () => {
    const capabilities = {
      status: 'active', deviceId: id('device'), deviceLabel: 'Example Chrome', deviceExpiresAt: '2026-11-15T00:00:00.000Z',
      syncEnabled: true, payloadVersions: [2], contractVersions: [1], maxPayloadBytes: 2_097_152, maxRows: 2_000,
      issuers: [{ issuer: 'chase', enabled: true }],
      bindings: [{
        bindingId: id('binding'), bindingVersion: 3, issuer: 'chase', source: 'chase-api', bindingLabel: 'Example Card', cards: ['3391'],
        scopes: [{ cardScopeId: id('cardScope'), scopeLabel: 'Example Card', last4: '3391', holderUnknown: false }],
      }],
    };
    assert.ok(snapshotStrictJson(capabilities).ok);
    const redeem = {
      deviceId: id('device'), deviceToken: `hdv1_${'k'.repeat(64)}`, fingerprint: 'abcd efgh ijkl mnop', status: 'pending',
      pendingExpiresAt: '2026-10-16T12:05:00.000Z',
    };
    const result = snapshotStrictJson(redeem);
    assert.deepEqual(result.ok ? [] : result.issues, [{ code: 'forbidden-key', path: '$.<key>' }]);
  });
});

