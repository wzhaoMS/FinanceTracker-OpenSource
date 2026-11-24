import { afterEach, describe, expect, it } from 'vitest';

import { serializeCardImportPayload, validateCardImportPayload, type CardAccount } from '@finance-tracker/shared';

import { indexesOf } from '../plan.js';
import {
  commitWithProof, ProofHold, type AppliedImport, type ProofApply, type ProofCommitResult, type ProofContext,
} from './commitWithProof.js';
import { stopPermit } from './permit.js';
import type { ProofCommitRequest } from './request.js';
import { PROOF_PERMIT_TABLE } from './schema.js';
import { payloadText, ProofWorld, sha256 } from '../../../testing/cardImportProofWorld.js';
import { createHash } from 'node:crypto';

const AMEX_DEBIT = 'AMEX EPAYMENT ACH PMT 999999 W9999 SAMPLE HOLDER';

// Synthetic only. The orchestrator's gates that a real import cannot reach on its own, driven with crafted `apply`
// closures: each must hold, and the database must be exactly as it was.
const worlds: ProofWorld[] = [];
afterEach(() => { for (const world of worlds.splice(0)) world.close(); });

const SEPTEMBER = payloadText('amex', [
  { transactionDate: '2026-09-04', postedDate: '2026-09-05', amountMinor: 4200, kind: 'purchase', description: 'NORTHWIND GROCERY', externalId: 'proof-ref-1' },
], { start: '2026-09-01', end: '2026-09-30' });
const OCTOBER = payloadText('amex', [
  { transactionDate: '2026-10-02', postedDate: '2026-10-03', amountMinor: 999, kind: 'purchase', description: 'SAMPLE STREAMING', externalId: 'proof-ref-3' },
], { start: '2026-10-01', end: '2026-10-20' }, { statement: true });
// A pending row, and a file that posts it by its issuer reference with its text unchanged (D12).
const PENDING_SEPTEMBER = payloadText('amex', [
  { transactionDate: '2026-09-04', postedDate: '2026-09-05', amountMinor: 4200, kind: 'purchase', description: 'NORTHWIND GROCERY', externalId: 'proof-ref-1' },
  { transactionDate: '2026-09-28', status: 'pending', amountMinor: 2500, kind: 'purchase', description: 'FABRIKAM CAFE', externalId: 'proof-pend-1' },
], { start: '2026-09-01', end: '2026-09-30' });
const POSTING_OCTOBER = payloadText('amex', [
  { transactionDate: '2026-09-28', postedDate: '2026-10-02', status: 'posted', amountMinor: 2500, kind: 'purchase', description: 'FABRIKAM CAFE', externalId: 'proof-pend-1' },
], { start: '2026-10-01', end: '2026-10-05' }, { statement: true });

/** The card's September seeded by its owner, and `october` the file the proof imports. */
async function setup(files: { september?: string; october?: string } = {}) {
  const w = new ProofWorld();
  worlds.push(w);
  w.live('amex');
  const card = w.account();
  await w.seed(card, files.september ?? SEPTEMBER);
  const checked = validateCardImportPayload(JSON.parse(files.october ?? OCTOBER));
  if (!checked.ok) throw new Error('synthetic payload invalid');
  const payload = checked.payload;
  const commitOnce = () => {
    const plan = w.repo.previewCardImport({ cardAccountId: card.id, payload }).plan;
    return w.repo.commitCardImport({ cardAccountId: card.id, payload, decisions: {}, shown: {
      possibleDuplicateRows: indexesOf(plan, 'possible-duplicate'), pendingMatchRows: indexesOf(plan, 'pending-match'),
      dismissedMatchRows: indexesOf(plan, 'dismissed-match'), stalePendingIds: plan.stale.map((row) => row.id),
    } });
  };
  /** The route's own commit, as the proof sees it, then `extra` inside the same savepoint. */
  const apply = (extra: (applied: AppliedImport) => AppliedImport = (a) => a, reapply = () => commitOnce().status === 'nothing-new'): ProofApply => ({
    commit() {
      const result = commitOnce();
      if (result.status === 'decision-required') throw new Error('synthetic plan not clean');
      return extra({
        outcome: result.status === 'imported' ? 'committed' : 'nothing-new', planDigest: result.preview.previewDigest,
        newCount: result.status === 'imported' ? result.batch.newCount : 0, promotedCount: result.counts.pendingPostedCount,
        skippedRows: [], heldCount: 0, reviewCount: 0,
      });
    },
    reapplyAddsNothing: reapply,
  });
  const ctx = (patch: Partial<ProofContext> = {}): ProofContext => ({ db: w.db, repo: w.repo, account: card as CardAccount, payload,
    payloadSha256: createHash('sha256').update(serializeCardImportPayload(payload)).digest('hex'), route: 'commit', now: Date.now, ...patch });
  const request = (patch: Partial<ProofCommitRequest> = {}): ProofCommitRequest => ({ mode: 'automatic', jobId: sha256('synthetic-orchestrator-job'),
    attempt: 1, deadlineMs: Date.now() + 30_000, statementPolicy: 'require-match', ...patch });
  return { w, card, payload, apply, ctx, request };
}

/** Runs `fn` with the schema trigger `name` lifted, then puts it back from its own SQL: the schema text is as it was. */
function unguarded(w: ProofWorld, name: string, fn: () => unknown): void {
  const sql = w.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").pluck().get(name);
  if (typeof sql !== 'string') throw new Error('no such trigger');
  w.db.exec(`DROP TRIGGER ${name}`);
  try { fn(); } finally { w.db.exec(sql); }
}

/**
 * The run, and whether the database is exactly as it was. Only the declared hold, a ProofHold, is caught; anything else is
 * re-thrown unchanged, so it fails the test as an error, never as an assertion (ROOT's kill standard, addendum 3).
 */
function attemptHold(w: ProofWorld, run: () => unknown) {
  const before = w.image();
  let held: ProofHold | undefined;
  try {
    run();
  } catch (caught) {
    if (!(caught instanceof ProofHold)) throw caught;
    held = caught;
  }
  return { held, unchanged: w.image().equals(before) };
}

/** Assertion-only: held as `code`, with the database exactly as it was. */
function expectHeld(attempted: ReturnType<typeof attemptHold>, code: string) {
  expect(attempted.held).toBeInstanceOf(ProofHold);
  expect(attempted.held?.code).toBe(code);
  expect(attempted.unchanged).toBe(true);
}

/**
 * Runs a commit that must pass. A hold fails here as an assertion that names its code, never as a ProofHold thrown out of
 * the test; any other error is thrown as it was.
 */
function expectCommit(run: () => ProofCommitResult): ProofCommitResult {
  let result: ProofCommitResult | undefined;
  let held: string | null = null;
  try {
    result = run();
  } catch (caught) {
    if (!(caught instanceof ProofHold)) throw caught;
    held = caught.code;
  }
  expect(held, 'the proof held a commit that must pass').toBeNull();
  return result as ProofCommitResult;
}

describe('the orchestrator holds what a real import cannot provoke', () => {
  it('passes the plain apply, so every hold below is the crafted change alone', async () => {
    const { ctx, request, apply } = await setup();
    expect(expectCommit(() => commitWithProof(ctx(), request(), apply())).receipt.outcome).toBe('committed');
  });

  it('holds rows held or under review (G-PLAN)', async () => {
    const { w, ctx, request, apply } = await setup();
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => ({ ...a, heldCount: 1 })))), 'proof-plan-not-clean');
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => ({ ...a, reviewCount: 1 })))), 'proof-plan-not-clean');
  });

  it('holds a re-apply that would add anything (G-REPLAY)', async () => {
    const { w, ctx, request, apply } = await setup();
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply(undefined, () => false))), 'proof-replay');
  });

  it('holds a batch count that is not what the commit reported (G-ROWS)', async () => {
    const { w, ctx, request, apply } = await setup();
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => ({ ...a, newCount: 2 })))), 'proof-rows');
  });

  it('holds an extra coverage window (C6)', async () => {
    const { w, ctx, request, apply } = await setup();
    const other = w.account('citi', '1234');
    const empty = validateCardImportPayload(JSON.parse(payloadText('citi', [], { start: '2026-10-01', end: '2026-10-05' })));
    if (!empty.ok) throw new Error('synthetic payload invalid');
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      w.repo.commitCardImport({ cardAccountId: other.id, payload: empty.payload, decisions: {},
        shown: { possibleDuplicateRows: [], pendingMatchRows: [], dismissedMatchRows: [], stalePendingIds: [] } });
      return a;
    }))), 'proof-coverage-windows');
  });

  it('holds a card-payment change the import\'s rows do not explain (G-PAYMENTS), before the tables gate sees it', async () => {
    const { w, ctx, request, apply } = await setup();
    // One unmatched debit paying Amex, dated inside the card's September coverage.
    const [debit] = w.checking([{ date: '2026-09-15', amountMinor: -5000, description: AMEX_DEBIT }]);
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      w.db.prepare('DELETE FROM checking_transactions WHERE id = ?').run(debit);
      return a;
    }))), 'proof-payments-unmatched');
    // The control: the same import, the debit left alone, commits and reports it unmatched before and after.
    expect(expectCommit(() => commitWithProof(ctx(), request(), apply())).receipt).toMatchObject({ outcome: 'committed',
      payments: { pairsChangedOrGone: 0, unmatchedDebitsBefore: 1, unmatchedDebitsAfter: 1 } });
  });

  it('(c) holds a new pair between rows the import neither inserted nor promoted (G-PAYMENTS)', async () => {
    const { w, card, ctx, request, apply } = await setup();
    // A posted Amex payment from before, and a debit naming Chase: no pair, until something re-reads that debit.
    await w.seed(card, payloadText('amex', [{ transactionDate: '2026-09-10', postedDate: '2026-09-11', amountMinor: -7000, kind: 'payment',
      description: 'AUTOPAY PAYMENT RECEIVED - THANK YOU', externalId: 'proof-pay-9' }], { start: '2026-09-10', end: '2026-09-11' }));
    const [debit] = w.checking([{ date: '2026-09-11', amountMinor: -7000, description: 'CHASE CREDIT CRD EPAY 999999 ***9999 SAMPLE HOLDER' }]);
    // Were the import's rows every row, this would hold only later, as proof-payments-unmatched.
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      w.db.prepare('UPDATE checking_transactions SET description = ? WHERE id = ?').run(AMEX_DEBIT, debit);
      return a;
    }))), 'proof-payments-pair');
  });

  it('holds a new batch that is not over the payload\'s coverage, and a change to an older batch (C6)', async () => {
    const { w, ctx, request, apply } = await setup();
    const older = w.db.prepare('SELECT id FROM card_import_batches').pluck().get() as string;
    const newest = () => w.db.prepare('SELECT id FROM card_import_batches ORDER BY rowid DESC LIMIT 1').pluck().get() as string;
    // Starting a day early leaves the merged coverage, and so the C-rules and the replay, as they were: only C6 tells it
    // from the payload's own range. (Ending a day early would uncover the payload, which the replay gate holds first.)
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      w.db.prepare("UPDATE card_import_batches SET coverage_start = '2026-09-30' WHERE id = ?").run(newest());
      return a;
    }))), 'proof-coverage-windows');
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      w.db.prepare("UPDATE card_import_batches SET parser_version = 'rebound@1' WHERE id = ?").run(older);
      return a;
    }))), 'proof-coverage-windows');
  });

  it('holds a new window bound to an older batch, or over another range (C6)', async () => {
    const { w, ctx, request, apply } = await setup();
    // The schema's triggers never let a committed window change after its INSERT, so only an importer that wrote it
    // wrong could leave one so. Each fault lifts the one trigger in its way and puts it back from its own SQL, inside
    // the proof's transaction: the schema is the same at every gate, and the gate alone must tell.
    const older = w.db.prepare('SELECT id FROM card_import_batches').pluck().get() as string;
    // An older batch without a window, so that a window can be bound to it.
    unguarded(w, 'trg_card_coverage_windows_inv_delete', () =>
      w.db.prepare('DELETE FROM card_coverage_windows WHERE import_batch_id = ?').run(older));
    const newWindow = () => w.db.prepare(`SELECT id FROM card_coverage_windows
      WHERE import_batch_id = (SELECT id FROM card_import_batches ORDER BY rowid DESC LIMIT 1)`).pluck().get() as string;
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      unguarded(w, 'trg_card_coverage_windows_inv_update', () =>
        w.db.prepare('UPDATE card_coverage_windows SET import_batch_id = ? WHERE id = ?').run(older, newWindow()));
      return a;
    }))), 'proof-coverage-windows');
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      unguarded(w, 'trg_card_coverage_windows_inv_update', () =>
        w.db.prepare("UPDATE card_coverage_windows SET requested_end = '2026-10-19' WHERE id = ?").run(newWindow()));
      return a;
    }))), 'proof-coverage-windows');
    // The control: untouched, the same import commits in this world.
    expect(expectCommit(() => commitWithProof(ctx(), request(), apply())).receipt.outcome).toBe('committed');
  });

  it('holds an older identity re-pointed to another live row, which changes no card row and no count (ledger)', async () => {
    const { w, ctx, request, apply } = await setup();
    const older = w.db.prepare('SELECT id, canonical_transaction_id AS row FROM card_source_identities').get() as { id: string; row: string };
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      const fresh = w.db.prepare('SELECT id FROM card_transactions WHERE id <> ? ORDER BY rowid DESC LIMIT 1').pluck().get(older.row);
      w.db.prepare('UPDATE card_source_identities SET canonical_transaction_id = ? WHERE id = ?').run(fresh, older.id);
      return a;
    }))), 'proof-tables');
  });

  it('holds an import table that grows by more than the import explains (v1.1 §3.4 expected counts)', async () => {
    const { w, ctx, request, apply } = await setup();
    const columns = (w.db.prepare('PRAGMA table_info(card_transaction_events)').all() as Array<{ name: string }>)
      .map((column) => column.name).filter((name) => name !== 'id').join(', ');
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      const newest = w.db.prepare('SELECT id FROM card_transaction_events ORDER BY rowid DESC LIMIT 1').pluck().get() as string;
      w.db.prepare(`INSERT INTO card_transaction_events (id, ${columns}) SELECT ?, ${columns} FROM card_transaction_events WHERE id = ?`)
        .run(`card-event-${'p'.repeat(32)}`, newest);
      return a;
    }))), 'proof-tables');
  });

  it('holds a write to a table an import never touches (G-TABLES)', async () => {
    const { w, ctx, request, apply } = await setup();
    w.db.exec('CREATE TABLE card_synthetic_unrelated (id TEXT)');
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      w.db.exec("INSERT INTO card_synthetic_unrelated VALUES ('x')");
      return a;
    }))), 'proof-tables');
  });

  it('holds an admission verifier that fails, or regresses, after the import (G-ADMISSION)', async () => {
    const { w, ctx, request, apply } = await setup();
    let calls = 0;
    const verifier = (after: 'fail' | 'unknown') => [{ id: 'synthetic-chain', appliesTo: () => true,
      evaluate: () => ({ result: (calls++ % 2 === 0 ? 'pass' : after) as 'pass' | 'fail' | 'unknown', reconciledThrough: null }) }];
    expectHeld(attemptHold(w, () => commitWithProof(ctx({ verifiers: verifier('fail') }), request(), apply())), 'proof-admission');
    calls = 0;
    expectHeld(attemptHold(w, () => commitWithProof(ctx({ verifiers: verifier('unknown') }), request(), apply())), 'proof-admission');
  });

  it('holds when a STOP lands between F1 and F2, or the deadline passes during the proof', async () => {
    const { w, ctx, request, apply } = await setup();
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      stopPermit(w.db, 'amex', 'consent-off', new Date().toISOString(), new Date());
      return a;
    }))), 'proof-permit-dead');
    let calls = 0;
    const late = () => (++calls >= 3 ? Date.now() + 120_000 : Date.now());
    expectHeld(attemptHold(w, () => commitWithProof(ctx({ now: late }), request(), apply())), 'proof-fence-expired');
  });

  it('holds a repeated job whose replay is no longer clean', async () => {
    const { w, card, ctx, request, apply } = await setup();
    expect(expectCommit(() => commitWithProof(ctx(), request(), apply())).repeated).toBe(false);
    // The owner later imports a pending row inside the job's coverage; the job's file, without pending rows, would now
    // leave it out as stale, so its replay is no longer clean.
    await w.seed(card, payloadText('amex', [{ transactionDate: '2026-10-04', status: 'pending', amountMinor: 1200, kind: 'purchase',
      description: 'CONTOSO HARDWARE', externalId: 'proof-pend-9' }], { start: '2026-10-04', end: '2026-10-04' }));
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply())), 'proof-replay');
  });

  it('holds a new identity bound to an older batch, which changes no card row and no count (ledger)', async () => {
    const { w, ctx, request, apply } = await setup();
    const older = w.db.prepare('SELECT id FROM card_import_batches').pluck().get() as string;
    // A source identity's batch is frozen by its trigger, so only an importer that wrote it wrong could leave one so: the
    // fault lifts that one trigger inside the proof's transaction and puts it back from its own SQL.
    let rebound = 0;
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      unguarded(w, 'trg_card_source_identities_inv_frozen', () => {
        rebound = w.db.prepare(`UPDATE card_source_identities SET import_batch_id = ?
          WHERE rowid = (SELECT max(rowid) FROM card_source_identities) AND import_batch_id <> ?`).run(older, older).changes;
      });
      return a;
    }))), 'proof-tables');
    expect(rebound).toBe(1);
  });

  it('holds a promotion whose kept version is filed at another revision, which changes no card row and no count (ledger)', async () => {
    const { w, ctx, request, apply } = await setup({ september: PENDING_SEPTEMBER, october: POSTING_OCTOBER });
    const pending = w.db.prepare("SELECT id, revision FROM card_transactions WHERE status = 'pending'").get() as { id: string; revision: number };
    // The snapshot trigger keeps the pending row at its revision before, and versions are append-only: the fault lifts the
    // one trigger in its way to file that version a revision on, and puts it back.
    let refiled = 0;
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      unguarded(w, 'trg_card_transaction_versions_inv_no_update', () => {
        refiled = w.db.prepare('UPDATE card_transaction_versions SET revision = ? WHERE card_transaction_id = ? AND revision = ?')
          .run(pending.revision + 1, pending.id, pending.revision).changes;
      });
      return a;
    }))), 'proof-tables');
    expect(refiled).toBe(1);
    // The control: untouched, the same promotion commits in this world.
    expect(expectCommit(() => commitWithProof(ctx(), request(), apply())).receipt.counts).toMatchObject({ new: 0, promoted: 1 });
  });

  it('holds an older coverage window changed where its triggers leave it open, or removed (C6)', async () => {
    const { w, ctx, request, apply } = await setup();
    const older = w.db.prepare('SELECT id FROM card_coverage_windows').pluck().get() as string;
    // The window's update trigger leaves updated_at open, so this change lifts no trigger: no gate but C6 reads it.
    let touched = 0;
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      touched = w.db.prepare(`UPDATE card_coverage_windows SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+1 second')
        WHERE id = ?`).run(older).changes;
      return a;
    }))), 'proof-coverage-windows');
    expect(touched).toBe(1);
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      unguarded(w, 'trg_card_coverage_windows_inv_delete', () => w.db.prepare('DELETE FROM card_coverage_windows WHERE id = ?').run(older));
      return a;
    }))), 'proof-coverage-windows');
  });

  it('holds a batch and a window the commit\'s outcome does not account for, though each is exactly this import\'s own (C6)', async () => {
    const { w, ctx, request, apply } = await setup();
    // The import adds its one batch and its one window, each over the payload's coverage; reported as nothing new, it
    // should add neither, and only the count can tell.
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => ({ ...a, outcome: 'nothing-new' })))), 'proof-coverage-windows');
  });

  it('holds a write outside the card tables that no payments rule reads: a checking row, or the schema (G-TABLES)', async () => {
    const { w, ctx, request, apply } = await setup();
    // A debit-card purchase reads as no card payment, so G-PAYMENTS never sees it, and it is in no card table: only the
    // digests of the tables an import never touches can tell.
    const [purchase] = w.checking([{ date: '2026-09-20', amountMinor: -1234, description: 'PURCHASE AUTHORIZED ON 09/20 SAMPLE HARDWARE' }]);
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      w.db.prepare('UPDATE checking_transactions SET description = ? WHERE id = ?').run('PURCHASE AUTHORIZED ON 09/21 SAMPLE HARDWARE', purchase);
      return a;
    }))), 'proof-tables');
    expectHeld(attemptHold(w, () => commitWithProof(ctx(), request(), apply((a) => {
      w.db.exec('CREATE TABLE synthetic_unrelated (id TEXT)');
      return a;
    }))), 'proof-tables');
    // The control: the same import, both left alone, commits in this world.
    expect(expectCommit(() => commitWithProof(ctx(), request(), apply())).receipt.outcome).toBe('committed');
  });
});

describe('the permit at F1 and F2', () => {
  it('reads it at F1 and again at F2 inside one IMMEDIATE transaction, which nothing ends or begins again between them', async () => {
    const { w, ctx, request, apply } = await setup();
    // Every statement the connection runs, in order, with whether a transaction was open as it began. better-sqlite3
    // runs its own BEGIN, COMMIT, ROLLBACK and savepoints as statements too; `exec` is the only other way in.
    type Run = (this: { source: string }, ...args: unknown[]) => unknown;
    const methods = ['run', 'get', 'all', 'iterate'] as const;
    const statements = Object.getPrototypeOf(w.db.prepare('SELECT 1')) as Record<(typeof methods)[number], Run>;
    const originals = methods.map((name) => statements[name]);
    const exec = w.db.exec.bind(w.db);
    const ran: Array<{ sql: string; inTransaction: boolean }> = [];
    const traced = <T>(fn: () => T): T => {
      methods.forEach((name, index) => {
        statements[name] = function trace(this: { source: string }, ...args: unknown[]) {
          ran.push({ sql: this.source, inTransaction: w.db.inTransaction });
          return originals[index].apply(this, args);
        };
      });
      Object.defineProperty(w.db, 'exec', { configurable: true, writable: true, value: (sql: string) => {
        ran.push({ sql, inTransaction: w.db.inTransaction });
        return exec(sql);
      } });
      try {
        return fn();
      } finally {
        methods.forEach((name, index) => { statements[name] = originals[index]; });
        Reflect.deleteProperty(w.db, 'exec');
      }
    };
    const result = traced(() => expectCommit(() => commitWithProof(ctx(), request(), apply((a) => {
      ran.push({ sql: '-- the import applied', inTransaction: w.db.inTransaction });
      return a;
    }))));
    expect(result.receipt).toMatchObject({ outcome: 'committed', permit: { globalGeneration: 1, issuerGeneration: 1 } });
    const permitRead = new RegExp(`\\bFROM ${PROOF_PERMIT_TABLE} WHERE issuer = \\?`);
    const begins = (sql: string) => /^\s*BEGIN\b/i.test(sql);
    const ends = (sql: string) => /^\s*(?:COMMIT|END|ROLLBACK(?!\s+TO\b))\b/i.test(sql);
    const reads = ran.flatMap((entry, index) => (permitRead.test(entry.sql) ? [index] : []));
    const applied = ran.findIndex((entry) => entry.sql === '-- the import applied');
    // F1 reads the `*` row and the issuer's before the import; F2 reads both again after it.
    expect([reads.filter((index) => index < applied).length, reads.filter((index) => index > applied).length]).toEqual([2, 2]);
    expect(reads.map((index) => ran[index].inTransaction)).toEqual([true, true, true, true]);
    const first = reads[0], last = reads[reads.length - 1];
    const control = (from: number, to: number) => ran.slice(from, to).filter((entry) => begins(entry.sql) || ends(entry.sql))
      .map((entry) => entry.sql);
    // One transaction, IMMEDIATE, begins before F1; nothing begins or ends one from F1 through F2; it ends once, by COMMIT.
    expect(control(0, first)).toEqual(['BEGIN IMMEDIATE']);
    expect(control(first, last + 1)).toEqual([]);
    expect(control(last + 1, ran.length)).toEqual(['COMMIT']);
    expect(w.db.inTransaction).toBe(false);
  });
});
