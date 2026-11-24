import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  buildCardImportPayload,
  CARD_IMPORT_FORMAT,
  serializeCardImportPayload,
  validateCardImportPayload,
  type CardImportDraft,
  type CardImportPayload,
} from '../cardImport.js';
import { convertCardExport, type ConvertOptions } from '../cardImportTool/convert.js';
import { chaseFixture, citiFixture, wellsFargoFixture } from './__fixtures__/drafts.js';
import { validateCardImportAnyVersion } from './dispatch.js';
import { validateCardSyncPayloadV2 } from './wireV2.js';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../cardImportTool/fixtures/${name}`, import.meta.url)));
const members = [{ name: 'Alex  Sample', owner: 'casey' as const }, { name: 'JORDAN SAMPLE', owner: 'alex' as const }];

/**
 * v1 outputs of the offline tool for its own synthetic fixtures, pinned byte for byte (SHA-256 of
 * the written JSON). The wire-contract work must leave v1 exactly as it is; only a deliberate v1
 * change by a maintainer may re-pin these. Re-pinned for holdr-card-import 1.0.3, whose bytes for these
 * fixtures differ from 1.0.2's, 1.0.1's and 1.0.0's only in parserVersion (cardImportTool/tool.test.ts proves it).
 */
const V1_GOLDEN: ReadonlyArray<[string, string, Partial<ConvertOptions> & Pick<ConvertOptions, 'format'>, string]> = [
  ['amex-basic', 'amex-basic.csv', { format: 'amex-csv' }, '44e336dd3268350ac510d9610a552165b2df80fe4faf9822f2c6761e0abc636a'],
  ['amex-detailed-members', 'amex-detailed.csv', { format: 'amex-csv', members }, 'cb996bda722571afbacab01bc8fd2366a41d06456ee6d5bc1d8b27eedb3721cb'],
  ['amex-detailed-card', 'amex-detailed.csv', { format: 'amex-csv', members, cards: ['2003'] }, '8f8d4dea907c91d68741c032d1e4a56c358de10d6a16dcc93d52add0a324331d'],
  ['ofx1', 'statement-ofx1.ofx', { format: 'ofx', issuer: 'samplebank' }, 'cf68018c8d7bedb271a44be52c6bfabf330726e9a0238270a08ac04c0376f591'],
  ['ofx2', 'statement-ofx2.ofx', { format: 'ofx', issuer: 'samplebank' }, 'cf68018c8d7bedb271a44be52c6bfabf330726e9a0238270a08ac04c0376f591'],
  ['qfx', 'statement.qfx', { format: 'ofx', issuer: 'samplebank' }, 'cf68018c8d7bedb271a44be52c6bfabf330726e9a0238270a08ac04c0376f591'],
];

function v1Draft(overrides: Partial<CardImportDraft> = {}): CardImportDraft {
  return {
    source: 'test-source',
    parserVersion: 'holdr-card-import@1.0.0',
    issuer: 'amex',
    currency: 'USD',
    owner: 'joint',
    cards: ['0003'],
    statement: { previousBalanceMinor: 10_000, newBalanceMinor: 9_075 },
    rows: [
      { transactionDate: '2026-09-14', amountMinor: 575, kind: 'purchase', description: 'SYNTHETIC COFFEE', externalId: "'320262570000000001'" },
      { transactionDate: '2026-09-15', amountMinor: -1_500, kind: 'payment', description: 'ONLINE PAYMENT - THANK YOU' },
      { transactionDate: '2026-09-16', status: 'pending', amountMinor: 1_200, kind: 'purchase', description: 'EXAMPLE DELI' },
    ],
    ...overrides,
  };
}

function v1Payloads(): Array<[string, string]> {
  const fromTool = V1_GOLDEN.map(([label, file, options]) => [label, convertCardExport(fixture(file), { ...options, status: 'posted' }).json] as [string, string]);
  const built = [
    ['draft', serializeCardImportPayload(buildCardImportPayload(v1Draft()).payload)],
    ['draft-empty', serializeCardImportPayload(buildCardImportPayload(v1Draft({ rows: [], coverage: { start: '2026-09-01', end: '2026-09-30' }, statement: null })).payload)],
  ] as Array<[string, string]>;
  return [...fromTool, ...built];
}

type V1Mutation = [string, (payload: Record<string, unknown>) => unknown];

const V1_MUTATIONS: V1Mutation[] = [
  ['unknown root key', (payload) => ({ ...payload, contractVersion: 1 })],
  ['v2-only root keys', (payload) => ({ ...payload, bindingId: `bnd_${'a'.repeat(32)}`, captureId: `cpt_${'a'.repeat(32)}` })],
  ['missing key', (payload) => { const { coverage: _coverage, ...rest } = payload; return rest; }],
  ['wrong format', (payload) => ({ ...payload, format: 'holdr.other' })],
  ['wrong type', (payload) => ({ ...payload, rejectedCount: '0' })],
  ['card number in text', (payload) => ({ ...payload, rows: [{ ...(payload.rows as object[])[0], description: 'PAY 4111 1111 1111 1111' }, ...(payload.rows as object[]).slice(1)] })],
  ['row with v2 keys', (payload) => ({ ...payload, rows: [{ ...(payload.rows as object[])[0], cardScopeId: `scp_${'a'.repeat(32)}` }, ...(payload.rows as object[]).slice(1)] })],
  ['totals off', (payload) => ({ ...payload, totals: { ...(payload.totals as object), posted: { ...(payload.totals as { posted: object }).posted, count: 99 } } })],
  ['coverage reversed', (payload) => ({ ...payload, coverage: { start: '2026-12-31', end: '2026-01-01' } })],
  ['statement empty', (payload) => ({ ...payload, statement: { chargesMinor: null, creditsMinor: null, netMinor: null, previousBalanceMinor: null, newBalanceMinor: null } })],
  ['rows not array', (payload) => ({ ...payload, rows: {} })],
];

/** Inputs v1 accepts as they are (v1 is unchanged here); only parity is asserted for them. */
const V1_PARITY_ONLY: V1Mutation[] = [
  ['negative zero count', (payload) => ({ ...payload, rejectedCount: -0 })],
  ['row key order', (payload) => ({ ...payload, rows: (payload.rows as Array<Record<string, unknown>>).map((row) => Object.fromEntries(Object.entries(row).reverse())) })],
];

describe('validateCardImportAnyVersion: v1 parity', () => {
  it("leaves the offline tool's v1 output byte for byte as pinned", () => {
    for (const [label, file, options, digest] of V1_GOLDEN) {
      // Closed-statement fixtures: the offline tool has no default status, and --status posted writes the pinned bytes.
      const { json } = convertCardExport(fixture(file), { ...options, status: 'posted' });
      assert.equal(createHash('sha256').update(json).digest('hex'), digest, label);
    }
  });

  it('answers exactly as validateCardImportPayload for every valid v1 payload', () => {
    for (const [label, json] of v1Payloads()) {
      const direct = validateCardImportPayload(JSON.parse(json));
      const dispatched = validateCardImportAnyVersion(JSON.parse(json));
      assert.equal(dispatched.version, 1, label);
      assert.deepEqual(dispatched.validation, direct, label);
      assert.ok(direct.ok && dispatched.validation.ok, label);
      assert.equal(serializeCardImportPayload((dispatched.validation as unknown as { payload: CardImportPayload }).payload), json, label);
    }
  });

  it('answers exactly as validateCardImportPayload for invalid v1 payloads, issue for issue', () => {
    for (const [label, json] of v1Payloads()) {
      for (const [name, mutate] of V1_MUTATIONS) {
        const direct = validateCardImportPayload(mutate(JSON.parse(json)));
        const dispatched = validateCardImportAnyVersion(mutate(JSON.parse(json)));
        assert.equal(dispatched.version, 1, `${label}: ${name}`);
        assert.deepEqual(dispatched.validation, direct, `${label}: ${name}`);
        assert.equal(direct.ok, false, `${label}: ${name}`);
      }
      for (const [name, mutate] of V1_PARITY_ONLY) {
        assert.deepEqual(validateCardImportAnyVersion(mutate(JSON.parse(json))), { version: 1, validation: validateCardImportPayload(mutate(JSON.parse(json))) }, `${label}: ${name}`);
      }
    }
  });

  it('passes the caller’s value to v1 untouched', () => {
    const value = JSON.parse(v1Payloads()[0][1]);
    const before = JSON.stringify(value);
    validateCardImportAnyVersion(value);
    assert.equal(JSON.stringify(value), before);
  });
});

describe('validateCardImportAnyVersion: dispatch', () => {
  it('sends version 2 to the v2 validator', () => {
    for (const build of [chaseFixture, citiFixture, wellsFargoFixture]) {
      const json = JSON.stringify(build());
      const dispatched = validateCardImportAnyVersion(JSON.parse(json));
      assert.equal(dispatched.version, 2);
      assert.deepEqual(dispatched.validation, validateCardSyncPayloadV2(JSON.parse(json)));
      assert.ok(dispatched.validation.ok);
    }
  });

  it('never strips fields to make one version look like the other', () => {
    const v2 = chaseFixture() as unknown as Record<string, unknown>;
    const asV1 = validateCardImportAnyVersion({ ...v2, version: 1 });
    assert.equal(asV1.version, 1);
    assert.equal(asV1.validation.ok, false);
    const v1 = JSON.parse(v1Payloads()[0][1]);
    const asV2 = validateCardImportAnyVersion({ ...v1, version: 2 });
    assert.equal(asV2.version, 2);
    assert.equal(asV2.validation.ok, false);
  });

  it('answers anything else with one fixed issue', () => {
    const cases: Array<[unknown, { code: string; path: string }]> = [
      [null, { code: 'wrong-type', path: '$' }],
      [[], { code: 'wrong-type', path: '$' }],
      ['{"version":2}', { code: 'wrong-type', path: '$' }],
      [42, { code: 'wrong-type', path: '$' }],
      [new Date(0), { code: 'wrong-type', path: '$' }],
      [{ format: CARD_IMPORT_FORMAT }, { code: 'unsupported-version', path: '$.version' }],
      [{ format: CARD_IMPORT_FORMAT, version: 3 }, { code: 'unsupported-version', path: '$.version' }],
      [{ format: CARD_IMPORT_FORMAT, version: '2' }, { code: 'unsupported-version', path: '$.version' }],
      [{ format: CARD_IMPORT_FORMAT, version: 1.5 }, { code: 'unsupported-version', path: '$.version' }],
      [{ format: CARD_IMPORT_FORMAT, version: 0 }, { code: 'unsupported-version', path: '$.version' }],
      [{ format: 'other', version: 3 }, { code: 'unsupported-format', path: '$.format' }],
      [{ version: 3 }, { code: 'unsupported-format', path: '$.format' }],
    ];
    for (const [value, issue] of cases) {
      assert.deepEqual(validateCardImportAnyVersion(value), { version: null, validation: { ok: false, issues: [issue] } }, JSON.stringify(value));
    }
  });

  it('reads the version without running getters and survives exotic objects', () => {
    let calls = 0;
    const getter = { format: CARD_IMPORT_FORMAT };
    Object.defineProperty(getter, 'version', { get: () => { calls += 1; return 2; }, enumerable: true });
    assert.equal(validateCardImportAnyVersion(getter).version, null);
    assert.equal(calls, 0);
    const throwing = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('trap'); } });
    assert.deepEqual(validateCardImportAnyVersion(throwing).validation, { ok: false, issues: [{ code: 'wrong-type', path: '$' }] });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assert.equal(validateCardImportAnyVersion(proxy).version, null);
    // Passes the version peek, then makes v1 throw: answered, not thrown.
    const v1 = JSON.parse(v1Payloads()[0][1]);
    const sneaky = new Proxy(v1, { ownKeys: () => { throw new Error('trap'); } });
    assert.deepEqual(validateCardImportAnyVersion(sneaky), { version: 1, validation: { ok: false, issues: [{ path: '$', message: 'is invalid' }] } });
    const v2 = new Proxy(chaseFixture(), { ownKeys: () => { throw new Error('trap'); } });
    assert.deepEqual(validateCardImportAnyVersion(v2), { version: 2, validation: { ok: false, issues: [{ code: 'unreadable', path: '$' }] } });
  });
});
