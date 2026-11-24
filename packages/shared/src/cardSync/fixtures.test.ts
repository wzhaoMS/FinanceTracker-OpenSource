import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { canonicalJson, type JsonValue } from './canonical.js';
import { CARD_SYNC_ISSUE_CODES, CARD_SYNC_ISSUE_PATH } from './issues.js';
import { validateProjectedBankBatch } from './projectedBatch.js';
import { CARD_SYNC_SOURCE_SPECS } from './registry.js';
import { validateCardSyncPayloadV2, type CardSyncPayloadV2 } from './wireV2.js';
import { CARD_SYNC_V2_FIXTURE_BUILDERS, fixtureId, PROJECTED_BATCH_FIXTURE_BUILDERS } from './__fixtures__/drafts.js';
import { CARD_SYNC_CORPUS_BASES, CARD_SYNC_INVALID_CORPUS, getterCalls } from './__fixtures__/invalidCorpus.js';

const directory = new URL('./__fixtures__/valid/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, directory), 'utf8');

describe('valid fixtures', () => {
  it('are exactly what the builders produce (regenerate with __fixtures__/generate.ts)', () => {
    const builders = { ...CARD_SYNC_V2_FIXTURE_BUILDERS, ...PROJECTED_BATCH_FIXTURE_BUILDERS };
    assert.deepEqual(readdirSync(directory).sort(), Object.keys(builders).sort());
    for (const [name, build] of Object.entries(builders)) assert.equal(read(name), `${JSON.stringify(build(), null, 2)}\n`, name);
  });

  it('validate, and come back equal to the file', () => {
    for (const name of Object.keys(CARD_SYNC_V2_FIXTURE_BUILDERS)) {
      const text = read(name);
      const result = validateCardSyncPayloadV2(JSON.parse(text));
      assert.ok(result.ok, name);
      assert.deepEqual(result.payload, JSON.parse(text));
      assert.equal(result.byteLength, Buffer.byteLength(canonicalJson(JSON.parse(text) as JsonValue)));
    }
    for (const name of Object.keys(PROJECTED_BATCH_FIXTURE_BUILDERS)) {
      const result = validateProjectedBankBatch(JSON.parse(read(name)));
      assert.ok(result.ok, name);
      assert.deepEqual(result.batch, JSON.parse(read(name)));
    }
  });

  it('cover the cases the contract has to carry', () => {
    const payloads = Object.keys(CARD_SYNC_V2_FIXTURE_BUILDERS).map((name) => JSON.parse(read(name)) as CardSyncPayloadV2);
    const rows = payloads.flatMap((payload) => payload.rows);
    const coverage = payloads.flatMap((payload) => payload.coverage);
    assert.deepEqual(new Set(payloads.map((payload) => payload.issuer)), new Set(['chase', 'amex', 'citi', 'wellsfargo']));
    assert.deepEqual(new Set(rows.map((row) => row.status)), new Set(['pending', 'posted']));
    for (const kind of ['purchase', 'refund', 'payment', 'fee', 'interest', 'adjustment']) assert.ok(rows.some((row) => row.kind === kind), kind);
    assert.ok(rows.some((row) => row.originalCurrency === 'EUR') && rows.some((row) => row.originalCurrency === 'JPY'));
    assert.ok(rows.some((row) => row.secondaryIds.length > 0));
    assert.ok(rows.some((row) => row.fingerprint !== null) && rows.some((row) => row.externalIdHash !== null));
    assert.ok(payloads.every((payload) => new Set(payload.rows.map((row) => row.cardScopeId)).size >= 1));
    assert.ok(payloads.some((payload) => new Set(payload.rows.map((row) => row.cardScopeId)).size >= 2));
    for (const label of ['amex/scope/holder-unknown', 'citi/scope/holder-unknown']) {
      assert.ok(rows.some((row) => row.cardScopeId === fixtureId('cardScope', label)), label);
    }
    for (const completeness of ['unknown', 'partial', 'complete']) assert.ok(coverage.some((entry) => entry.completeness === completeness), completeness);
    for (const termination of ['end-marker', 'snapshot', 'more-available', 'cap', 'not-read']) assert.ok(coverage.some((entry) => entry.termination === termination), termination);
    for (const basis of ['transaction', 'posted', 'observation']) assert.ok(coverage.some((entry) => entry.observed?.dateBasis === basis), basis);
    assert.ok(coverage.some((entry) => entry.completeness === 'complete' && entry.observed === null), 'complete with no rows');
    assert.ok(payloads.some((payload) => payload.rejectedCount > 0));
    const wellsFargo = payloads.find((payload) => payload.source === 'wf-dom')!;
    assert.equal(wellsFargo.mode, 'dom-passive');
    assert.ok(wellsFargo.rows.every((row) => row.externalIdHash === null && row.identityNamespace === CARD_SYNC_SOURCE_SPECS['wf-dom'].captureNamespace));
    // Two identical purchases stay two rows, told apart by their fingerprints.
    const twins = wellsFargo.rows.filter((row) => row.description === 'SYNTHETIC COFFEE CART');
    assert.equal(twins.length, 2);
    assert.notEqual(twins[0].fingerprint, twins[1].fingerprint);
  });

  it('use only published test card numbers and invented data', () => {
    for (const name of [...Object.keys(CARD_SYNC_V2_FIXTURE_BUILDERS), ...Object.keys(PROJECTED_BATCH_FIXTURE_BUILDERS)]) {
      const text = read(name);
      assert.doesNotMatch(text, /[0-9]{11}/, name);
      assert.doesNotMatch(text, /https?:|@[a-z]|\.(?:com|net|org)\b/i, name);
      assert.match(text, /SYN|EXAMPLE|Synthetic|Example|"description"|"accounts"/, name);
    }
  });
});

describe('invalid corpus: one case per rule', () => {
  it('has bases that are valid and unique ids', () => {
    for (const build of CARD_SYNC_CORPUS_BASES.v2) assert.ok(validateCardSyncPayloadV2(build()).ok);
    for (const build of CARD_SYNC_CORPUS_BASES.projected) assert.ok(validateProjectedBankBatch(build()).ok);
    assert.equal(new Set(CARD_SYNC_INVALID_CORPUS.map((entry) => entry.id)).size, CARD_SYNC_INVALID_CORPUS.length);
    assert.equal(new Set(CARD_SYNC_INVALID_CORPUS.map((entry) => entry.rule)).size, CARD_SYNC_INVALID_CORPUS.length);
  });

  for (const entry of CARD_SYNC_INVALID_CORPUS) {
    it(`${entry.id}: ${entry.rule}`, () => {
      assert.ok((CARD_SYNC_ISSUE_CODES as readonly string[]).includes(entry.expect.code));
      assert.match(entry.expect.path, CARD_SYNC_ISSUE_PATH);
      const calls = getterCalls.count;
      const value = entry.mutate(entry.base());
      const result = entry.target === 'v2' ? validateCardSyncPayloadV2(value) : validateProjectedBankBatch(value);
      assert.equal(getterCalls.count, calls, 'a getter ran');
      assert.equal(result.ok, false);
      const issues = result.ok ? [] : result.issues;
      assert.ok(issues.some((issue) => issue.code === entry.expect.code && issue.path === entry.expect.path), JSON.stringify(issues));
      if (entry.exact !== false) assert.deepEqual(issues, [entry.expect]);
      for (const issue of issues) {
        assert.deepEqual(Object.keys(issue).sort(), ['code', 'path']);
        assert.match(issue.path, CARD_SYNC_ISSUE_PATH);
      }
    });
  }

  it('reaches every issue code', () => {
    const reached = new Set(CARD_SYNC_INVALID_CORPUS.map((entry) => entry.expect.code));
    assert.deepEqual(CARD_SYNC_ISSUE_CODES.filter((code) => !reached.has(code)), []);
  });
});
