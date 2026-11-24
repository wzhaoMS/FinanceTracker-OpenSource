import { expect } from 'vitest';

import { fileReviewIssuer } from '../services/cardImport/review.js';
import {
  oraclePayloadJson, oracleRecord, runCardImportSequence, type CardImportOracleWorld, type OracleObservation, type OracleRecord,
  type OracleRequest,
} from './cardImportOracle.js';

/*
 * E1b design §7.4 test 69 (A9) on this build: a recorded sequence replayed request by request against v14's digests
 * (routes/cardImportA9.test.ts runs all of them; routes/cardImportA9.controls.test.ts runs them on broken builds, which
 * must fail). This build may answer otherwise only by the design's declared exceptions, and each is checked against what
 * the request must do, worked out before it runs from the database and the request alone, never from the classifier
 * under test (E2d review r2, finding 3):
 *
 * - E-Q7 (§4.11). The request must ask about the first row of each key in the file whose active legacy identity names a
 *   live row (pending or posted) of the row's own status, with ten bank values (classify's sameValues) that differ from
 *   the row's, unless an open file observation already asks about that key with exactly those values. A pending row of a
 *   posted row is kept-current, a posted row of a pending one posts it or waits for the owner's word, and a dismissed row
 *   stays a duplicate (A19). These sequences have no synced row, no detached key, no row with two keys and no decided
 *   item; that is asserted before every request, so nothing else can ask. The answer must list exactly these rows
 *   (`reviewRows`, `reviewCount`, the `sync-review` warning) and hold none. A commit must store, for each of them, one
 *   open observation at its file position with its key and values and one open item for it with its reason and its row
 *   first among the candidates, and no other review work. Previews, 409s and PATCHes store none.
 * - A16. A commit v14 answered 200 answers 201 only when it must ask about rows, and its batch must be the review-only
 *   one: no row inserted, posted or dismissed, every kept row a duplicate, nothing rejected. It is then compared as
 *   v14's 200, its batch left out of every later ledger.
 *
 * Everything else must equal v14's answer, request by request.
 *
 * On a card of an issuer the browser extension doesn't sync (E2d-D22) there is no exception at all: the request must ask
 * about nothing, so every answer and ledger must equal v14's, and the account never gets a row in a v15 table that
 * checks the issuer (no set, binding, plan or card scope but its legacy one).
 */

type DB = ReturnType<CardImportOracleWorld['repo']['internalGetDb']>;

/** A payload row as the v1 import keys and compares it. */
interface PayloadRow {
  externalIdHash: string | null;
  fingerprint: string | null;
  transactionDate: string;
  postedDate: string | null;
  status: 'pending' | 'posted';
  amountMinor: number;
  originalAmountMinor?: number | null;
  originalCurrency?: string | null;
  kind: string;
  description: string;
  merchant: string | null;
  issuerCategory: string | null;
}

const keyOf = (row: PayloadRow) => (row.externalIdHash ?? row.fingerprint)!;
const BANK_COLUMNS = ['transaction_date', 'posted_date', 'status', 'amount_minor', 'original_amount_minor', 'original_currency', 'kind',
  'description', 'merchant', 'issuer_category'] as const;
/** The ten bank values classify's sameValues compares, in BANK_COLUMNS' order. */
const bankOf = (row: PayloadRow) => [row.transactionDate, row.postedDate, row.status, row.amountMinor, row.originalAmountMinor ?? null,
  row.originalCurrency ?? null, row.kind, row.description, row.merchant, row.issuerCategory];
const storedBank = (row: Record<string, unknown>) => BANK_COLUMNS.map((column) => row[column]);
const rowsOf = (request: OracleRequest & { op: 'preview' | 'commit' }, issuer: string) =>
  (JSON.parse(oraclePayloadJson(request, issuer)) as { rows: PayloadRow[] }).rows;

/** One row the request must ask about (E-Q7). */
interface Ask {
  key: string;
  /** The row its key names. */
  target: string;
  reason: 'posted-correction' | 'pending-changed';
  values: unknown[];
}

/** What a request must do beyond v14, worked out before it runs. */
export interface A9Expectation {
  /** By position in the file, in file order. */
  asks: Map<number, Ask>;
  /** File observations and review items before the request. */
  observations: number;
  items: number;
}

function reviewWork(db: DB): { observations: number; items: number } {
  return {
    observations: db.prepare("SELECT count(*) FROM card_source_observations WHERE origin = 'file'").pluck().get() as number,
    items: db.prepare('SELECT count(*) FROM card_reconciliation_suggestions').pluck().get() as number,
  };
}

/** The E-Q7 rows a request must ask about (see the header), from the database before it and the request alone. */
export function a9Expectation(request: OracleRequest, world: CardImportOracleWorld): A9Expectation {
  const db = world.repo.internalGetDb();
  const expectation: A9Expectation = { asks: new Map(), ...reviewWork(db) };
  expect(db.prepare(`SELECT
      (SELECT count(*) FROM card_transactions WHERE first_sync_run_id IS NOT NULL),
      (SELECT count(*) FROM card_source_identities WHERE status <> 'active' OR namespace <> 'legacy-file:v1'),
      (SELECT count(*) FROM (SELECT canonical_transaction_id FROM card_source_identities GROUP BY 1 HAVING count(*) > 1)),
      (SELECT count(*) FROM card_reconciliation_suggestions WHERE status <> 'open')`).raw().get(),
  'these sequences have no synced row, no detached key, no row with two keys and no decided item').toEqual([0, 0, 0, 0]);
  if (!fileReviewIssuer(world.issuer)) {
    // Another issuer's card (E2d-D22): nothing to ask, and no row in the v15 tables that check the issuer.
    expect(db.prepare(`SELECT (SELECT count(*) FROM card_sync_observation_sets), (SELECT count(*) FROM card_source_bindings),
        (SELECT count(*) FROM card_sync_commit_plans), (SELECT count(*) FROM card_scopes WHERE kind <> 'legacy')`).raw().get(),
    `a ${world.issuer} card has no set, binding, plan or scope but its legacy one`).toEqual([0, 0, 0, 0]);
    return expectation;
  }
  if (request.op === 'patch') return expectation;
  const named = db.prepare(`SELECT t.id, ${BANK_COLUMNS.map((column) => `t.${column}`).join(', ')}
      FROM card_source_identities i JOIN card_transactions t ON t.id = i.canonical_transaction_id
     WHERE i.namespace = 'legacy-file:v1' AND i.id_hash = ? AND i.status = 'active'`);
  const askedAlready = db.prepare(`SELECT count(*) FROM card_source_observations
     WHERE origin = 'file' AND state = 'open' AND identity_namespace = 'legacy-file:v1' AND identity_hash = ?
       AND ${BANK_COLUMNS.map((column) => `${column} IS ?`).join(' AND ')}`).pluck();
  const firsts = new Set<string>();
  rowsOf(request, world.issuer).forEach((row, index) => {
    const key = keyOf(row);
    if (firsts.has(key)) return;
    firsts.add(key);
    const stored = named.get(key) as Record<string, unknown> | undefined;
    if (!stored || stored.status !== row.status) return;
    const values = bankOf(row);
    if (JSON.stringify(storedBank(stored)) === JSON.stringify(values)) return;
    if ((askedAlready.get(key, ...values) as number) > 0) return;
    expectation.asks.set(index, { key, target: stored.id as string, values,
      reason: row.status === 'posted' ? 'posted-correction' : 'pending-changed' });
  });
  return expectation;
}

/**
 * Checks one answer and what it stored against the expectation (see the header), and returns the answer as v14 would
 * have given it; throws at an exception that is not one. `note` counts what the sequences reached.
 */
export function a9AsV14(observation: OracleObservation, expectation: A9Expectation, v14: OracleRecord,
  note: (what: string) => void): OracleObservation {
  const { request, status } = observation;
  const world = observation.world as CardImportOracleWorld;
  const db = world.repo.internalGetDb();
  const answered = request.op !== 'patch' && (status === 200 || status === 201);
  const committed = answered && request.op === 'commit';
  const asks = [...expectation.asks];
  const stored = committed ? asks.length : 0;
  expect(reviewWork(db), `${request.op} ${status}: the review work it stores`)
    .toEqual({ observations: expectation.observations + stored, items: expectation.items + stored });
  if (!answered) return observation;
  const raw = structuredClone(observation.raw) as Record<string, unknown>;
  const warnings = raw.warnings as Array<{ code: string }>;
  expect({ reviewRows: raw.reviewRows, reviewCount: raw.reviewCount, heldCount: raw.heldCount, heldRows: raw.heldRows,
    warned: warnings.some((warning) => warning.code === 'sync-review') },
  'the answer lists exactly the rows the request must ask about, and holds none')
    .toEqual({ reviewRows: asks.map(([index]) => index), reviewCount: asks.length, heldCount: 0, heldRows: [], warned: asks.length > 0 });
  if (asks.length === 0) return observation;
  note('E-Q7 rows asked');
  let projected = status;
  if (committed) {
    expect(status, 'a commit that asks about rows records its batch (A16)').toBe(201);
    const batchId = (raw.batch as { id: string }).id;
    const kept = db.prepare(`SELECT o.file_row_index, o.identity_hash, o.state, ${BANK_COLUMNS.map((column) => `o.${column}`).join(', ')},
        r.status AS item_status, r.reason,
        (SELECT c.transaction_id FROM card_reconciliation_candidates c WHERE c.review_item_id = r.id ORDER BY c.rank LIMIT 1) AS target,
        (SELECT count(*) FROM card_reconciliation_suggestions x WHERE x.observation_id = o.id) AS items
      FROM card_sync_observation_sets s JOIN card_source_observations o ON o.observation_set_id = s.id
      LEFT JOIN card_reconciliation_suggestions r ON r.observation_id = o.id
     WHERE s.import_batch_id = ? AND s.origin = 'file' ORDER BY o.file_row_index`).all(batchId) as Array<Record<string, unknown>>;
    expect(kept.map((row) => ({ index: row.file_row_index, key: row.identity_hash, state: row.state, values: storedBank(row),
      items: row.items, item: row.item_status, reason: row.reason, target: row.target })),
    'one open observation per row asked about, at its file position, with one open item that names its row first')
      .toEqual(asks.map(([index, ask]) => ({ index, key: ask.key, state: 'open', values: ask.values, items: 1, item: 'open',
        reason: ask.reason, target: ask.target })));
    for (const [, ask] of asks) note(`E-Q7 ${ask.reason} items stored`);
    if (v14[1] === 200) {
      // A16: v14 recorded nothing. Here the batch must be the review-only one; it is left out of the comparison.
      const rows = rowsOf(request as OracleRequest & { op: 'commit' }, world.issuer).length
        - Number(raw.skippedPossibleDuplicates ?? 0);
      const batch = db.prepare(`SELECT row_count AS rowCount, new_count AS newCount, duplicate_count AS duplicateCount,
          rejected_count AS rejectedCount FROM card_import_batches WHERE id = ?`).get(batchId);
      const reviewOnly = { rowCount: rows, newCount: 0, duplicateCount: rows, rejectedCount: 0 };
      expect(batch, 'A16: the review-only batch').toEqual(reviewOnly);
      expect(raw, 'A16: nothing else is new').toMatchObject({ newCount: 0, pendingPostedCount: 0, stalePendingDismissedCount: 0,
        batch: { id: batchId, newCount: 0, duplicateCount: rows, rejectedCount: 0 } });
      world.hideBatch(batchId);
      Object.assign(raw, { imported: false, batch: null, newCount: 0 });
      projected = 200;
      note('A16 answers');
    }
  }
  raw.reviewRows = [];
  raw.reviewCount = 0;
  raw.warnings = warnings.filter((warning) => warning.code !== 'sync-review');
  return { ...observation, status: projected, body: world.normalize(raw, true), ledger: world.ledger() };
}

/** What a sequence reached, from this build's observations once they matched v14's. */
function tally(observation: OracleObservation, note: (what: string) => void) {
  const { request, status } = observation;
  const body = observation.body as Record<string, unknown>;
  note(`${request.op} ${status}`);
  if (request.op === 'patch') {
    if (status === 200) {
      note(`patch ${request.postedAs ? 'postedAs' : Object.keys(request.body).join('+')}${request.body.status ? `=${String(request.body.status)}` : ''}`);
    }
    return;
  }
  if (request.op === 'commit' && status !== 409) for (const part of request.query.split('&').filter(Boolean)) note(`decision ${part}`);
  if (request.op !== 'commit') return;
  const when = (what: string, reached: boolean) => reached && note(what);
  when('409 possible duplicates', status === 409 && 'possibleDuplicateRows' in body);
  when('409 pending matches', status === 409 && 'pendingMatchRows' in body);
  when('409 dismissed matches', status === 409 && 'dismissedMatchRows' in body);
  when('409 statement mismatch', status === 409 && 'reconciliation' in body);
  when('200 nothing new', status === 200);
  when('201 promoted', status === 201 && Number(body.pendingPostedCount) > 0);
  when('201 stale dismissed', status === 201 && Number(body.stalePendingDismissedCount) > 0);
  when('201 with a reference conflict', status === 201 && Number(body.conflictCount) > 0);
  when('201 skipped possible duplicates', status === 201 && Number(body.skippedPossibleDuplicates) > 0);
}

/**
 * Replays one recorded sequence on this build, on a card of `issuer` (the fixture's); throws at the first request that
 * differs from v14's beyond the above.
 */
export async function runA9Sequence(sequence: { seed: number; records: OracleRecord[] }, steps: number,
  note: (what: string) => void = () => undefined, issuer = 'chase'): Promise<void> {
  const { seed, records } = sequence;
  let index = 0;
  let expectation: A9Expectation | undefined;
  await runCardImportSequence(seed, steps, (observation) => {
    const v14 = records[index];
    if (!v14 || !expectation) throw new Error(`seed ${seed}, request ${index}: v14 made no such request`);
    const compared = a9AsV14(observation, expectation, v14, note);
    const actual = oracleRecord(compared);
    if (actual.some((value, i) => value !== v14[i])) {
      const parts = ['request', 'status', 'body', 'ledger'].filter((_part, i) => actual[i] !== v14[i]);
      const { world: _world, ...shown } = compared;
      throw new Error(`seed ${seed}, request ${index}: the ${parts.join(', ')} ${parts.length === 1 ? 'differs' : 'differ'} from v14's `
        + `(v14 ${JSON.stringify(v14)}, here ${JSON.stringify(actual)}); here in full:\n${JSON.stringify(shown, null, 1)}`);
    }
    tally(compared, note);
    index += 1;
  }, (request, world) => {
    expectation = a9Expectation(request, world);
  }, issuer);
  expect(index, `seed ${seed}: as many requests as v14 made`).toBe(records.length);
}
