import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson, type JsonValue } from './canonical.js';
import { CARD_SYNC_READ_CONTRACT_IDS, CARD_SYNC_READ_CONTRACTS } from './registry.js';
import { isForbiddenCardSyncKey } from './strictJson.js';
import { PROJECTED_BATCH_KNOWN_KEYS, validateProjectedBankBatch, type ProjectedBankBatchV1 } from './projectedBatch.js';
import { buildCardSyncPayloadV2 } from './wireV2.js';
import {
  chaseFixture,
  fixtureId,
  projectedChaseActivityFixture,
  projectedCitiTransactionsFixture,
  projectedWellsFargoAccountsFixture,
} from './__fixtures__/drafts.js';

describe('validateProjectedBankBatch', () => {
  it('accepts the fixtures and returns a detached copy', () => {
    for (const build of [projectedChaseActivityFixture, projectedCitiTransactionsFixture, projectedWellsFargoAccountsFixture]) {
      const input = JSON.parse(JSON.stringify(build()));
      const result = validateProjectedBankBatch(input);
      assert.ok(result.ok);
      assert.deepEqual(result.batch, input);
      assert.equal(result.byteLength, Buffer.byteLength(canonicalJson(input as JsonValue)));
      input.accounts[0].last4 = '0000';
      assert.notEqual(result.batch.accounts[0].last4, '0000');
    }
  });

  it('has only keys that may be sent', () => {
    for (const key of PROJECTED_BATCH_KNOWN_KEYS) assert.equal(isForbiddenCardSyncKey(key), false, key);
  });

  it('accepts every registered read contract with its own issuer', () => {
    for (const contract of CARD_SYNC_READ_CONTRACT_IDS) {
      const spec = CARD_SYNC_READ_CONTRACTS[contract];
      const batch: ProjectedBankBatchV1 = { ...projectedWellsFargoAccountsFixture(), issuer: spec.issuer, contract };
      assert.ok(validateProjectedBankBatch(batch).ok, contract);
      for (const issuer of ['amex', 'chase', 'citi', 'wellsfargo'] as const) {
        if (issuer === spec.issuer) continue;
        assert.deepEqual(validateProjectedBankBatch({ ...batch, issuer }), { ok: false, issues: [{ code: 'source-mismatch', path: '$.contract' }] });
      }
    }
  });

  it('accepts a transactions contract that saw nothing', () => {
    const batch = projectedChaseActivityFixture();
    assert.ok(validateProjectedBankBatch({ ...batch, transactions: [], coverage: [] }).ok);
  });

  it('becomes the v2 payload once the user confirms which card each row belongs to', () => {
    // The isolated world maps page-local hints to confirmed scopes; nothing else changes.
    const batch = projectedChaseActivityFixture();
    const expected = chaseFixture();
    const scopeByLast4: Record<string, string> = {
      3391: fixtureId('cardScope', 'chase/scope/primary'),
      7720: fixtureId('cardScope', 'chase/scope/authorized-user'),
    };
    const rows = batch.transactions.map(({ accountRef: _account, holderRef: _holder, cardLast4, ...row }) => ({ ...row, cardScopeId: scopeByLast4[cardLast4!] }));
    const { format: _format, version: _version, totals: _totals, rows: _rows, ...header } = expected;
    const built = buildCardSyncPayloadV2({ ...header, rows });
    assert.ok(built.ok);
    assert.deepEqual(built.payload, expected);
  });
});

describe('projected identity tuples (account candidate, namespace, digest)', () => {
  it('accepts the same digest under two account candidates and refuses it twice under one', () => {
    const batch = projectedChaseActivityFixture();
    const second = fixtureId('accountCandidate', 'projected/chase/account/second');
    const twoAccounts = JSON.parse(JSON.stringify(batch));
    twoAccounts.accounts.push({ ref: second, last4: null, productHint: null });
    const copy = { ...twoAccounts.transactions[2], accountRef: second };
    twoAccounts.transactions.push(copy);
    twoAccounts.coverage.push({ accountRef: second, status: 'posted', requested: null, observed: { start: copy.transactionDate, end: copy.transactionDate, dateBasis: 'transaction' }, completeness: 'partial', pageCount: 1, termination: 'cap' });
    assert.ok(validateProjectedBankBatch(twoAccounts).ok);
    const oneAccount = JSON.parse(JSON.stringify(batch));
    oneAccount.transactions[3].externalIdHash = oneAccount.transactions[2].externalIdHash;
    assert.deepEqual(validateProjectedBankBatch(oneAccount), { ok: false, issues: [{ code: 'duplicate', path: '$.transactions[3].externalIdHash' }] });
  });
});
