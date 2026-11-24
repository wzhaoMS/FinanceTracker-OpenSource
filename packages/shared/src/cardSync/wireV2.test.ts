import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cardExternalIdHash } from '../cardDedupe.js';
import { buildCardImportPayload, summarizeCardImportRows } from '../cardImport.js';
import { canonicalJson, type JsonValue } from './canonical.js';
import {
  CARD_SYNC_COMPLETENESS,
  CARD_SYNC_MODES,
  CARD_SYNC_SOURCE_SPECS,
  CARD_SYNC_TERMINATIONS,
  cardSyncCompletenessAllowed,
  cardSyncCompletenessCeiling,
} from './registry.js';
import {
  buildCardSyncPayloadV2,
  cardSyncObservedRange,
  CARD_SYNC_V2_MAX_BYTES,
  CARD_SYNC_V2_MAX_ROWS,
  validateCardSyncPayloadV2,
  type CardSyncDraftV2,
  type CardSyncPayloadV2,
  type CardSyncRowDraftV2,
} from './wireV2.js';
import { amexFixture, amexRestFixture, chaseFixture, citiFixture, fixtureId, wellsFargoFixture } from './__fixtures__/drafts.js';

const FIXTURES = [chaseFixture, amexFixture, amexRestFixture, citiFixture, wellsFargoFixture];

function draftOf(payload: CardSyncPayloadV2): CardSyncDraftV2 {
  const { format: _format, version: _version, totals: _totals, rows, ...rest } = payload;
  return { ...rest, rows: rows.map(({ fingerprint: _fingerprint, ...row }) => row) };
}

/** A Chase-shaped payload with `count` stable-id rows with text of the given lengths, all in one scope. */
function bulkPayload(count: number, descriptionLength: number, merchantLength = 0, categoryLength = 0): CardSyncDraftV2 {
  const base = chaseFixture();
  const scope = base.coverage[0].cardScopeId;
  // Numbers that start no card network, so the repeated runs never read as a card number with a hint.
  const text = (length: number) => 'SYNTHETIC MERCHANT STORE 77 OAKLAND CA ORDER 90 THANK YOU '.repeat(20).slice(0, length).trim();
  const words = text(descriptionLength);
  const merchant = merchantLength > 0 ? text(merchantLength) : null;
  const category = categoryLength > 0 ? text(categoryLength) : null;
  const rows: CardSyncRowDraftV2[] = Array.from({ length: count }, (_, index) => {
    const day = String(1 + (index % 28)).padStart(2, '0');
    return {
      transactionDate: `2026-09-${day}`, postedDate: `2026-09-${day}`, status: 'posted', amountMinor: 100 + index, kind: 'purchase',
      description: words, merchant, issuerCategory: category, externalIdHash: cardExternalIdHash(`SYN-BULK-${index}`),
      cardScopeId: scope, identityNamespace: 'chase-api:sor:v1', secondaryIds: [], originalAmountMinor: null, originalCurrency: null,
    };
  });
  const observed = cardSyncObservedRange(rows, 'transaction')!;
  return {
    ...draftOf(base),
    coverage: [{ cardScopeId: scope, status: 'posted', requested: null, observed, completeness: 'partial', pageCount: 10, termination: 'cap' }],
    rows,
  };
}

describe('validateCardSyncPayloadV2', () => {
  it('accepts every fixture and returns a detached copy equal to the input, without touching the input', () => {
    for (const build of FIXTURES) {
      const input = JSON.parse(JSON.stringify(build()));
      const before = JSON.stringify(input);
      const result = validateCardSyncPayloadV2(input);
      assert.ok(result.ok);
      assert.equal(JSON.stringify(input), before);
      assert.deepEqual(result.payload, input);
      assert.equal(result.byteLength, Buffer.byteLength(canonicalJson(input as JsonValue)));
      input.rows[0].description = 'CHANGED';
      input.coverage[0].requested = null;
      assert.notEqual(result.payload.rows[0].description, 'CHANGED');
      assert.notEqual(result.payload.coverage[0], input.coverage[0]);
      const again = validateCardSyncPayloadV2(result.payload);
      assert.ok(again.ok);
      assert.deepEqual(again.payload, result.payload);
    }
  });

  it('refuses a v1 payload with the version issue alone', () => {
    const v1 = buildCardImportPayload({
      source: 'amex-csv', parserVersion: 'holdr-card-import@1.0.0', issuer: 'amex', currency: 'USD',
      rows: [{ transactionDate: '2026-09-14', amountMinor: 575, kind: 'purchase', description: 'SYNTHETIC COFFEE' }],
    }).payload;
    assert.deepEqual(validateCardSyncPayloadV2(v1), { ok: false, issues: [{ code: 'unsupported-version', path: '$.version' }] });
  });

  it('reports card data before anything else, as a value-free issue', () => {
    const payload = chaseFixture() as unknown as Record<string, unknown>;
    const result = validateCardSyncPayloadV2({ ...payload, version: 9, extra: 'x', bindingId: 'bnd_4111111111111111' });
    assert.equal(result.ok, false);
    // The strict scan reports in key order and stops there: no schema issue (version, unknown key) is reached.
    assert.deepEqual(result.ok ? [] : result.issues, [{ code: 'card-data', path: '$.bindingId' }, { code: 'forbidden-key', path: '$.<key>' }]);
  });

  it('accepts each source only with its approved mode and issuer', () => {
    for (const build of FIXTURES) {
      const payload = build();
      const spec = CARD_SYNC_SOURCE_SPECS[payload.source];
      for (const mode of CARD_SYNC_MODES) {
        const result = validateCardSyncPayloadV2({ ...payload, mode });
        if (mode === spec.mode) assert.ok(result.ok, `${payload.source} ${mode}`);
        else assert.deepEqual(result, { ok: false, issues: [{ code: 'source-mismatch', path: '$.mode' }] }, `${payload.source} ${mode}`);
      }
    }
  });

  it('accepts statement figures in v1 form', () => {
    const payload = chaseFixture();
    const net = payload.totals.posted.netMinor;
    for (const statement of [
      { chargesMinor: null, creditsMinor: null, netMinor: null, previousBalanceMinor: 81_240, newBalanceMinor: 81_240 + net },
      { chargesMinor: payload.totals.posted.chargesMinor, creditsMinor: payload.totals.posted.creditsMinor, netMinor: net, previousBalanceMinor: null, newBalanceMinor: null },
    ]) {
      const result = validateCardSyncPayloadV2({ ...payload, statement });
      assert.ok(result.ok);
      assert.deepEqual(result.payload.statement, statement);
    }
  });

  it('accepts an empty capture and a scope read to the end with no rows', () => {
    const payload = chaseFixture();
    const scope = payload.coverage[0].cardScopeId;
    const result = validateCardSyncPayloadV2({
      ...payload,
      owner: null,
      cards: [],
      coverage: [{ cardScopeId: scope, status: 'posted', requested: { start: '2026-09-01', end: '2026-09-30', dateBasis: 'posted' }, observed: null, completeness: 'complete', pageCount: 1, termination: 'end-marker' }],
      totals: summarizeCardImportRows([]),
      rows: [],
    });
    assert.ok(result.ok);
    assert.ok(validateCardSyncPayloadV2({ ...payload, coverage: [], totals: summarizeCardImportRows([]), rows: [] }).ok);
  });

  it('accepts 2,000 rows (rows plus rejected) within the time budget and refuses one more', () => {
    const draft = bulkPayload(CARD_SYNC_V2_MAX_ROWS, 120);
    const started = performance.now();
    const built = buildCardSyncPayloadV2(draft);
    assert.ok(built.ok, JSON.stringify(built.ok ? [] : built.issues));
    const validated = validateCardSyncPayloadV2(JSON.parse(canonicalJson(built.payload as unknown as JsonValue)));
    assert.ok(validated.ok);
    assert.ok(performance.now() - started < 10_000);
    const fewer = buildCardSyncPayloadV2({ ...bulkPayload(CARD_SYNC_V2_MAX_ROWS - 5, 20), rejectedCount: 5 });
    assert.ok(fewer.ok);
    const over = buildCardSyncPayloadV2({ ...bulkPayload(CARD_SYNC_V2_MAX_ROWS - 5, 20), rejectedCount: 6 });
    assert.deepEqual(over.ok ? [] : over.issues, [{ code: 'too-many-items', path: '$.rows' }]);
  });

  it('refuses a payload over 2 MiB of canonical JSON and accepts one just under, quickly', () => {
    // 1,700 of these rows come to 563 bytes under the budget; one more row is over it.
    const fits = buildCardSyncPayloadV2(bulkPayload(1_700, 500, 200, 100));
    assert.ok(fits.ok);
    assert.ok(CARD_SYNC_V2_MAX_BYTES - fits.byteLength < 1_000, String(fits.byteLength));
    const started = performance.now();
    assert.ok(validateCardSyncPayloadV2(JSON.parse(canonicalJson(fits.payload as unknown as JsonValue))).ok);
    assert.ok(performance.now() - started < 10_000);
    const big = buildCardSyncPayloadV2(bulkPayload(1_701, 500, 200, 100));
    assert.deepEqual(big.ok ? [] : big.issues, [{ code: 'too-large', path: '$.rows[1700].description' }]);
  });

  it('never throws on malformed drafts', () => {
    for (const draft of [null, undefined, {}, { rows: 'x' }, { rows: [null] }, { rows: [{}] }, new Proxy({}, { get: () => { throw new Error('x'); } })]) {
      const result = buildCardSyncPayloadV2(draft as unknown as CardSyncDraftV2);
      assert.equal(result.ok, false);
    }
  });
});

describe('cardSyncObservedRange', () => {
  it('is the hull of the rows on a basis, null without rows, undefined without posted dates', () => {
    const rows = [{ transactionDate: '2026-09-03', postedDate: '2026-09-05' }, { transactionDate: '2026-09-01', postedDate: '2026-09-02' }];
    assert.deepEqual(cardSyncObservedRange(rows, 'transaction'), { start: '2026-09-01', end: '2026-09-03', dateBasis: 'transaction' });
    assert.deepEqual(cardSyncObservedRange(rows, 'posted'), { start: '2026-09-02', end: '2026-09-05', dateBasis: 'posted' });
    assert.equal(cardSyncObservedRange([], 'posted'), null);
    assert.equal(cardSyncObservedRange([{ transactionDate: '2026-09-01', postedDate: null }], 'posted'), undefined);
  });
});

describe('row identity across scopes', () => {
  it('keeps identical id-less purchases on two cards apart by occurrence, not merged', () => {
    const payload = amexFixture();
    const other = fixtureId('cardScope', 'amex/scope/holder-unknown');
    const draft = draftOf(payload);
    const twin = { ...draft.rows[1], cardScopeId: other };
    draft.rows = [...draft.rows, twin];
    draft.coverage = draft.coverage.map((entry) => entry.cardScopeId === other && entry.status === 'posted'
      ? { ...entry, observed: cardSyncObservedRange(draft.rows.filter((row) => row.cardScopeId === other && row.status === 'posted'), 'transaction')! }
      : entry);
    const result = buildCardSyncPayloadV2(draft);
    assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.issues));
    const fingerprints = result.payload.rows.filter((row) => row.description === twin.description).map((row) => row.fingerprint);
    assert.equal(new Set(fingerprints).size, 3);
  });
});

describe('identity tuples (card scope, namespace, digest)', () => {
  it('accepts the same digest under another namespace or another card scope', () => {
    const payload = chaseFixture();
    // SOR and derived ids with equal text in one row.
    const sameRow = JSON.parse(JSON.stringify(payload));
    sameRow.rows[0].secondaryIds[0].idHash = sameRow.rows[0].externalIdHash;
    assert.ok(validateCardSyncPayloadV2(sameRow).ok);
    // Two rows of one scope: one keyed by SOR, the other by a derived id with the same digest.
    const twoRows = JSON.parse(JSON.stringify(payload));
    twoRows.rows[3].identityNamespace = 'chase-api:derived:v1';
    twoRows.rows[3].externalIdHash = twoRows.rows[2].externalIdHash;
    assert.ok(validateCardSyncPayloadV2(twoRows).ok);
    // The same SOR digest under two card scopes.
    const twoScopes = JSON.parse(JSON.stringify(payload));
    twoScopes.rows[4].externalIdHash = twoScopes.rows[0].externalIdHash;
    assert.ok(validateCardSyncPayloadV2(twoScopes).ok);
  });

  it('refuses a repeated identity within one scope, primary or secondary', () => {
    const payload = chaseFixture();
    const repeated = JSON.parse(JSON.stringify(payload));
    repeated.rows[3].externalIdHash = repeated.rows[2].externalIdHash;
    assert.deepEqual(validateCardSyncPayloadV2(repeated), { ok: false, issues: [{ code: 'duplicate', path: '$.rows[3].externalIdHash' }] });
    const secondary = JSON.parse(JSON.stringify(payload));
    secondary.rows[2].secondaryIds = [{ namespace: 'chase-api:derived:v1', idHash: secondary.rows[0].secondaryIds[0].idHash }];
    assert.deepEqual(validateCardSyncPayloadV2(secondary), { ok: false, issues: [{ code: 'duplicate', path: '$.rows[2].secondaryIds[0].idHash' }] });
  });
});

describe('completeness ceiling', () => {
  const window = { start: '2026-09-14', end: '2026-10-14', dateBasis: 'transaction' as const };

  it('maps every termination as the contract states', () => {
    for (const termination of CARD_SYNC_TERMINATIONS) {
      const expected = termination === 'end-marker' ? 'complete' : termination === 'snapshot' || termination === 'not-read' ? 'unknown' : 'partial';
      assert.equal(cardSyncCompletenessCeiling(termination, window), expected, termination);
      assert.equal(cardSyncCompletenessCeiling(termination, null), termination === 'end-marker' ? 'unknown' : expected, termination);
    }
  });

  it('is exactly what the validator enforces, at the completeness path', () => {
    for (const termination of CARD_SYNC_TERMINATIONS) {
      for (const completeness of CARD_SYNC_COMPLETENESS) {
        for (const requested of [window, null]) {
          const payload = chaseFixture() as unknown as { coverage: Array<Record<string, unknown>> };
          payload.coverage[0] = { ...payload.coverage[0], termination, completeness, requested, pageCount: termination === 'not-read' ? 0 : 2 };
          const result = validateCardSyncPayloadV2(payload);
          const flagged = !result.ok && result.issues.some((issue) => issue.path === '$.coverage[0].completeness');
          assert.equal(flagged, !cardSyncCompletenessAllowed(completeness, termination, requested), `${termination} ${completeness} ${requested ? 'window' : 'none'}`);
        }
      }
    }
  });
});

