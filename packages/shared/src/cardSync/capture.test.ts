import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson, type JsonValue } from './canonical.js';
import { expandCoverageToScopes, mergeProjectedBatches, PROJECTED_BATCH_MAX_MERGED } from './capture.js';
import { CARD_SYNC_ISSUE_PATH } from './issues.js';
import type { ProjectedBankBatchV1, ProjectedTransaction } from './projectedBatch.js';
import { buildCardSyncPayloadV2, cardSyncObservedRange, type CardSyncDraftV2 } from './wireV2.js';
import { chaseFixture, fixtureId, projectedChaseActivityFixture } from './__fixtures__/drafts.js';

const json = (value: unknown) => canonicalJson(value as JsonValue);

/** The Chase activity fixture as two incremental batches: rows [0, cut) then [cut, n), one page each. */
function increments(cut: number, extra: (rows: ProjectedTransaction[]) => ProjectedTransaction[] = (rows) => rows): [ProjectedBankBatchV1, ProjectedBankBatchV1] {
  const whole = projectedChaseActivityFixture();
  const part = (rows: ProjectedTransaction[], sequence: number, observedAt: string, last: boolean): ProjectedBankBatchV1 => ({
    ...whole,
    sequence,
    observedAt,
    transactions: rows,
    coverage: whole.coverage.map((entry) => {
      const mine = rows.filter((row) => row.status === entry.status);
      return {
        ...entry,
        observed: mine.length === 0 ? null : cardSyncObservedRange(mine, 'transaction')!,
        pageCount: 1,
        ...(last ? {} : { termination: 'more-available' as const, completeness: 'partial' as const }),
      };
    }),
  });
  return [
    part(whole.transactions.slice(0, cut), 0, '2026-10-16T14:04:00.000Z', false),
    part(extra(whole.transactions.slice(cut)), whole.sequence, whole.observedAt, true),
  ];
}

describe('mergeProjectedBatches', () => {
  it('merges incremental batches back into the whole batch, byte for byte', () => {
    const whole = projectedChaseActivityFixture();
    for (let cut = 1; cut < whole.transactions.length; cut += 1) {
      const result = mergeProjectedBatches(increments(cut));
      assert.ok(result.ok, `cut ${cut}: ${JSON.stringify(result.ok ? [] : result.issues)}`);
      assert.equal(json(result.batch), json(whole), `cut ${cut}`);
    }
    const single = mergeProjectedBatches([whole]);
    assert.ok(single.ok);
    assert.equal(json(single.batch), json(whole));
  });

  it('drops repeated and stale sequences, and keeps an identical repeated row once', () => {
    const [first, second] = increments(3);
    const result = mergeProjectedBatches([first, second, second, first]);
    assert.ok(result.ok);
    assert.equal(json(result.batch), json(projectedChaseActivityFixture()));
    // The second batch sends the first batch's last row again, unchanged.
    const [early, late] = increments(3, (rows) => [projectedChaseActivityFixture().transactions[2], ...rows]);
    const repeated = mergeProjectedBatches([early, late]);
    assert.ok(repeated.ok, JSON.stringify(repeated.ok ? [] : repeated.issues));
    assert.equal(json(repeated.batch), json(projectedChaseActivityFixture()));
  });

  it('refuses the same identity with other content, naming the batch and row', () => {
    const [early, late] = increments(3, (rows) => [{ ...projectedChaseActivityFixture().transactions[2], amountMinor: 1 }, ...rows]);
    const result = mergeProjectedBatches([early, late]);
    assert.deepEqual(result.ok ? [] : result.issues, [{ code: 'identity-conflict', path: '$[1].transactions[0]' }]);
  });

  it('refuses batches of another stream, a changed window, too many pages and a changed candidate', () => {
    const [first, second] = increments(3);
    const otherStream = { ...second, streamHandle: fixtureId('stream', 'projected/chase/other-stream') };
    assert.deepEqual(mergeProjectedBatches([first, otherStream]), { ok: false, issues: [{ code: 'inconsistent', path: '$[1].streamHandle' }] });
    const otherWindow = { ...second, coverage: second.coverage.map((entry, index) => (index === 0 ? { ...entry, requested: { ...entry.requested!, start: '2026-09-15' } } : entry)) };
    assert.deepEqual(mergeProjectedBatches([first, otherWindow]), { ok: false, issues: [{ code: 'inconsistent', path: '$[1].coverage[0].requested' }] });
    const manyPages = { ...second, coverage: second.coverage.map((entry) => ({ ...entry, pageCount: 100 })) };
    const pages = mergeProjectedBatches([first, manyPages]);
    assert.deepEqual(pages.ok ? [] : pages.issues, [
      { code: 'out-of-range', path: '$[1].coverage[0].pageCount' }, { code: 'out-of-range', path: '$[1].coverage[1].pageCount' },
    ]);
    const renamed = { ...second, accounts: [{ ...second.accounts[0], productHint: 'Another Card' }] };
    assert.deepEqual(mergeProjectedBatches([first, renamed]), { ok: false, issues: [{ code: 'identity-conflict', path: '$[1].accounts[0]' }] });
  });

  it('reports an invalid batch at its place in the input, and never throws', () => {
    const [first, second] = increments(3);
    const broken = { ...second, sequence: -1 };
    assert.deepEqual(mergeProjectedBatches([first, broken]), { ok: false, issues: [{ code: 'out-of-range', path: '$[1].sequence' }] });
    for (const bad of [[], null, 'x', {}, [null], Array.from({ length: PROJECTED_BATCH_MAX_MERGED + 1 }, () => first)]) {
      const result = mergeProjectedBatches(bad as unknown as unknown[]);
      assert.equal(result.ok, false);
      if (!result.ok) for (const issue of result.issues) assert.match(issue.path, CARD_SYNC_ISSUE_PATH);
    }
    const hostile = new Proxy([first], { get: () => { throw new Error('secret 4111111111111111'); } });
    const result = mergeProjectedBatches(hostile);
    assert.deepEqual(result, { ok: false, issues: [{ code: 'unreadable', path: '$' }] });
  });
});

describe('expandCoverageToScopes', () => {
  const posted = { start: '2026-09-01', end: '2026-09-30', dateBasis: 'transaction' as const };
  const scopes = [fixtureId('cardScope', 'expand/a'), fixtureId('cardScope', 'expand/b'), fixtureId('cardScope', 'expand/c')];
  const row = (cardScopeId: string, status: 'pending' | 'posted', transactionDate: string) => ({
    cardScopeId, status, transactionDate, postedDate: status === 'posted' ? transactionDate : null,
  });

  it('gives each scope the account entry per status, observed from that scope rows only', () => {
    const entries = expandCoverageToScopes(
      [
        { status: 'posted', requested: posted, observed: { start: '2026-09-02', end: '2026-09-10', dateBasis: 'transaction' }, completeness: 'complete', pageCount: 3, termination: 'end-marker' },
        { status: 'pending', requested: null, observed: { start: '2026-10-16', end: '2026-10-16', dateBasis: 'observation' }, completeness: 'unknown', pageCount: 3, termination: 'snapshot' },
      ],
      scopes,
      [row(scopes[0], 'posted', '2026-09-10'), row(scopes[0], 'posted', '2026-09-02'), row(scopes[0], 'pending', '2026-10-15'), row(scopes[1], 'posted', '2026-09-05')],
    );
    assert.deepEqual(entries.map((entry) => [entry.cardScopeId, entry.status, entry.observed && `${entry.observed.start}..${entry.observed.end}/${entry.observed.dateBasis}`]), [
      [scopes[0], 'posted', '2026-09-02..2026-09-10/transaction'],
      [scopes[0], 'pending', '2026-10-16..2026-10-16/observation'],
      [scopes[1], 'posted', '2026-09-05..2026-09-05/transaction'],
      [scopes[1], 'pending', null],
      [scopes[2], 'posted', null],
      [scopes[2], 'pending', null],
    ]);
    for (const entry of entries) {
      assert.deepEqual([entry.requested, entry.pageCount], [entry.status === 'posted' ? posted : null, 3]);
      assert.deepEqual([entry.completeness, entry.termination], entry.status === 'posted' ? ['complete', 'end-marker'] : ['unknown', 'snapshot']);
    }
    assert.notEqual(entries[0].requested, posted);
  });

  it('builds coverage a v2 payload accepts', () => {
    const { format: _format, version: _version, totals: _totals, rows, ...rest } = chaseFixture();
    const account = projectedChaseActivityFixture().coverage.map(({ accountRef: _accountRef, ...entry }) => entry);
    const scopeIds = [...new Set(rest.coverage.map((entry) => entry.cardScopeId))];
    const draft: CardSyncDraftV2 = {
      ...rest,
      rows: rows.map(({ fingerprint: _fingerprint, ...row }) => row),
      coverage: expandCoverageToScopes(account, scopeIds, rows),
    };
    const result = buildCardSyncPayloadV2(draft);
    assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.issues));
  });
});
