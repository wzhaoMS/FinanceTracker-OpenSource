import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import { buildCardImportPayload, cardExternalIdHash, type CardImportDraftRow, type CardImportPayload } from '@finance-tracker/shared';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { indexesOf } from './cardImport/plan.js';
import { SqliteStateRepo, type CardImportRow } from './sqliteStateRepo.js';

// Card-sync schema v15 (E1b design §7.11 P4; review r1, finding 2): a 2,000-row
// v1 import through the ledger writer, on a fresh file-backed database with all
// 62 card guards and the design's 113 invariant triggers in place, within
// 1,000 ms, every row recorded with its identity, content and event; and its
// replay within 300 ms, writing nothing. Three imports: the reviewer's (2,000
// new rows, one description for every row), a statement's mix (2,000 new rows,
// every description distinct, merchants and categories repeating, a fifth of
// the rows without an issuer reference, some foreign amounts), and the
// statement that posts 2,000 pending rows (each promoted in place). Opening
// the database, creating the account and importing the pending rows are not
// timed. The budgets are wall-clock on the design's reference Mac (this
// suite's host). On a machine other processes share, slice 2 review r2's rule
// (finding 4, as the candidate-heavy benchmark): up to three attempts, each on
// a fresh database, every attempt reported with the machine's load, and each
// phase judged by its best attempt against the original budgets. When no
// attempt meets them and every attempt ran with the 1-minute load average at
// or above the number of cores, the measurement is inconclusive: reported and
// skipped, never passed. Any attempt below that load makes a miss a failure.

const ROWS = 2_000;
const IMPORT_BUDGET_MS = 1_000;
const REPLAY_BUDGET_MS = 300;

interface Attempt { importMs: number; replayMs: number; load: number }

/** P4's verdict over a case's attempts (the rule above); skips the test when it is inconclusive. */
function judge(title: string, attempts: Attempt[], ctx: { skip(): void }): void {
  const cores = os.cpus().length;
  const best = { importMs: Math.min(...attempts.map((a) => a.importMs)), replayMs: Math.min(...attempts.map((a) => a.replayMs)) };
  const met = best.importMs <= IMPORT_BUDGET_MS && best.replayMs <= REPLAY_BUDGET_MS;
  const report = `${attempts.map((a) => `${a.importMs.toFixed(0)} ms (replay ${a.replayMs.toFixed(0)} ms; 1-minute load ${a.load.toFixed(1)})`)
    .join(', then ')} on ${cores} cores (budgets ${IMPORT_BUDGET_MS} and ${REPLAY_BUDGET_MS} ms)`;
  if (!met && attempts.every((a) => a.load >= cores)) {
    console.info(`${title}: INCONCLUSIVE, every attempt ran on a machine loaded at or above its ${cores} cores; ${report}`);
    ctx.skip();
  }
  console.info(`${title}: ${met ? 'met' : 'NOT MET'}; ${report}`);
  expect(best.importMs, report).toBeLessThanOrEqual(IMPORT_BUDGET_MS);
  expect(best.replayMs, report).toBeLessThanOrEqual(REPLAY_BUDGET_MS);
}

const MERCHANTS = [
  'BLUE BOTTLE COFFEE', 'SYNTHETIC GROCERY MARKET', 'SYNTHETIC HARDWARE', 'SYNTHETIC AIRLINE', 'SYNTHETIC HOTEL', 'SYNTHETIC BOOKS',
  'SYNTHETIC PHARMACY', 'SYNTHETIC FUEL STATION', 'SYNTHETIC STREAMING', 'SYNTHETIC RESTAURANT', 'SYNTHETIC CAFE PARIS',
  'SYNTHETIC RIDE SHARE',
] as const;
const CATEGORIES = ['Restaurants', 'Groceries', 'Travel', 'Shopping', 'Gas', 'Entertainment'] as const;
const letters = (n: number) => `${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + (Math.floor(n / 26) % 26))}`;

function reviewerRows(): CardImportRow[] {
  return Array.from({ length: ROWS }, (_, i) => ({
    externalIdHash: cardExternalIdHash(`SYNTHETIC-BENCH-${i}`), transactionDate: '2026-09-03', postedDate: '2026-09-04',
    status: 'posted', amountMinor: 1000 + i, currency: 'USD', kind: 'purchase', description: 'SYNTHETIC BENCHMARK MERCHANT',
    merchant: 'Synthetic merchant', issuerCategory: 'Shopping',
  }));
}

function pendingRows(): CardImportRow[] {
  return Array.from({ length: ROWS }, (_, i) => ({
    externalIdHash: cardExternalIdHash(`SYNTHETIC-HOLD-${i}`), transactionDate: '2026-09-03', postedDate: null, status: 'pending',
    amountMinor: 1000 + i, currency: 'USD', kind: 'purchase', description: `SYNTHETIC HOLD ${letters(i)}`,
  }));
}

/** The same purchases posted: the issuer's final values and a merchant, each promoting its pending row. */
function postingRows(): CardImportRow[] {
  return pendingRows().map((row, i) => ({
    ...row, status: 'posted', postedDate: '2026-09-05', amountMinor: row.amountMinor + (i % 3), merchant: 'Synthetic merchant',
  }));
}

function statementRows(): CardImportRow[] {
  let state = 0x2545f491;
  const next = (n: number) => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state % n;
  };
  const day = (offset: number) => new Date(Date.UTC(2026, 8, 1) + offset * 86_400_000).toISOString().slice(0, 10);
  return Array.from({ length: ROWS }, (_, i) => {
    const merchant = MERCHANTS[next(MERCHANTS.length)];
    const date = next(28);
    const foreign = merchant === 'SYNTHETIC CAFE PARIS';
    return {
      ...(next(5) === 0 ? {} : { externalIdHash: cardExternalIdHash(`SYNTHETIC-STATEMENT-${i}`) }),
      transactionDate: day(date), postedDate: day(date + 1 + next(2)), status: 'posted', amountMinor: 100 + next(250_000),
      currency: 'USD', ...(foreign ? { originalAmountMinor: 100 + next(9_000), originalCurrency: 'EUR' } : {}), kind: 'purchase',
      description: `${merchant} ${100 + next(900)} ${letters(i)}`,
      ...(next(3) === 0 ? {} : { merchant }), ...(next(4) === 0 ? {} : { issuerCategory: CATEGORIES[next(CATEGORIES.length)] }),
    };
  });
}

// Each attempt's database has a short fixed name, never its case's title. The scratch directory is inside the
// checkout, and on Windows without long paths SQLite cannot create a database whose rollback journal's path is
// longer than 259 characters ("open database failed (SQLITE_CANTOPEN)"): a title-derived name failed the longest
// case in a deeply nested checkout before it imported anything.
let dir: string;

beforeAll(async () => {
  dir = await makeScratchDir('card-sync-import-');
});

afterAll(async () => {
  await removeScratchDir(dir);
});

describe('card schema v15: a 2,000-row v1 import and its replay under the guards (P4)', () => {
  type Case = { file: string; rows: () => CardImportRow[]; before?: () => CardImportRow[]; promoted: boolean };
  const CASES: Array<[string, Case]> = [
    ['the reviewer\'s 2,000 new rows', { file: 'reviewer', rows: reviewerRows, promoted: false }],
    ['a statement\'s mix of 2,000 new rows', { file: 'statement', rows: statementRows, promoted: false }],
    ['2,000 posted rows promoting their pending rows', { file: 'promoting', rows: postingRows, before: pendingRows, promoted: true }],
  ];

  it.for(CASES)('imports %s within 1,000 ms and replays them within 300 ms, ledger accounting included', { timeout: 120_000 },
    ([label, { file, rows: makeRows, before, promoted }], ctx) => {
      const rows = makeRows();
      const attempts: Attempt[] = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const repo = new SqliteStateRepo({ file: path.join(dir, `import-${file}-${attempt}.db`) });
        try {
          const db = repo.internalGetDb();
          const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
          expect(count("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_card%_guard_%'")).toBe(62);
          expect(count("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_card%_inv_%'")).toBe(113);
          const cardAccountId = repo.createCardAccount({ issuer: 'chase', owner: 'joint', last4: '3391', currency: 'USD' }).id;
          const input = { cardAccountId, source: 'chase-csv', parserVersion: 'csv@1.0.0', rows };
          if (before) repo.importCardTransactions({ ...input, rows: before() });

          let started = performance.now();
          const batch = repo.importCardTransactions(input);
          const importMs = performance.now() - started;
          expect(batch).toMatchObject({ rowCount: ROWS, newCount: promoted ? 0 : ROWS, duplicateCount: promoted ? ROWS : 0 });
          const ledger = () => ({
            rows: count("SELECT count(*) AS n FROM card_transactions WHERE status = 'posted'"),
            identities: count("SELECT count(*) AS n FROM card_source_identities WHERE status = 'active'"),
            inserted: count("SELECT count(*) AS n FROM card_identity_contents WHERE resolution = 'inserted'"),
            promoted: count("SELECT count(*) AS n FROM card_identity_contents WHERE resolution = 'promoted'"),
            created: count("SELECT count(*) AS n FROM card_transaction_events WHERE event_type = 'created'"),
            promotions: count("SELECT count(*) AS n FROM card_transaction_events WHERE event_type = 'promoted'"),
            versions: count('SELECT count(*) AS n FROM card_transaction_versions'),
            revision: count('SELECT ledger_revision AS n FROM card_accounts'),
          });
          const recorded = ledger();
          expect(recorded).toEqual({
            rows: ROWS, identities: ROWS, inserted: ROWS, promoted: promoted ? ROWS : 0, created: ROWS, promotions: promoted ? ROWS : 0,
            versions: promoted ? ROWS : 0, revision: promoted ? 2 : 1,
          });

          started = performance.now();
          const replay = repo.importCardTransactions(input);
          const replayMs = performance.now() - started;
          expect(replay).toMatchObject({ newCount: 0, duplicateCount: ROWS });
          expect(ledger()).toEqual(recorded);
          attempts.push({ importMs, replayMs, load: os.loadavg()[0] });
        } finally {
          repo.close();
        }
        const last = attempts.at(-1)!;
        if (last.importMs <= IMPORT_BUDGET_MS && last.replayMs <= REPLAY_BUDGET_MS) break;
      }
      judge(`card schema v15 v1 import of ${ROWS} rows, ${label}`, attempts, ctx);
  });
});

// E2d: the v1 route's path is the repository's classification (previewCardImport, for the complete lists the
// owner's decisions answer) and then commitCardImport (the classification again inside its transaction, the import,
// and the file sets). P4's budgets hold for that whole path: the preview is timed with the commit.
describe('card schema v15: the v1 route\'s preview and commit of 2,000 rows and their replay (P4, E2d)', () => {
  const drafts = (status: 'pending' | 'posted'): CardImportDraftRow[] => Array.from({ length: ROWS }, (_, i) => ({
    externalId: `SYNTHETIC-HOLD-${i}`, transactionDate: '2026-09-03', status, postedDate: status === 'posted' ? '2026-09-05' : null,
    amountMinor: 1000 + i, kind: 'purchase', description: `SYNTHETIC HOLD ${letters(i)}`,
    ...(status === 'posted' ? { merchant: 'Synthetic merchant', issuerCategory: 'Shopping' } : {}),
  }));
  const payloadOf = (rows: CardImportDraftRow[]) => buildCardImportPayload({ source: 'chase-csv', parserVersion: 'csv@1.0.0',
    issuer: 'chase', currency: 'USD', rows }).payload;

  it.for([['2,000 new rows', false], ['2,000 posted rows promoting their pending rows', true]] as const)(
    'previews and commits %s within 1,000 ms and replays them within 300 ms', { timeout: 120_000 }, ([label, promoting], ctx) => {
      const attempts: Attempt[] = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const repo = new SqliteStateRepo({ file: path.join(dir, `route-${promoting ? 'promoting' : 'new'}-${attempt}.db`) });
        try {
          const cardAccountId = repo.createCardAccount({ issuer: 'chase', owner: 'joint', last4: '3391', currency: 'USD' }).id;
          const route = (payload: CardImportPayload) => {
            const { plan } = repo.previewCardImport({ cardAccountId, payload });
            return repo.commitCardImport({ cardAccountId, payload, decisions: {}, shown: {
              possibleDuplicateRows: indexesOf(plan, 'possible-duplicate'), pendingMatchRows: indexesOf(plan, 'pending-match'),
              dismissedMatchRows: indexesOf(plan, 'dismissed-match'), stalePendingIds: plan.stale.map((row) => row.id) } });
          };
          if (promoting) expect(route(payloadOf(drafts('pending')))).toMatchObject({ status: 'imported' });
          const payload = payloadOf(drafts('posted'));
          let started = performance.now();
          const result = route(payload);
          const importMs = performance.now() - started;
          expect(result).toMatchObject({ status: 'imported', heldCount: 0, reviewCount: 0,
            batch: { newCount: promoting ? 0 : ROWS, duplicateCount: promoting ? ROWS : 0 }, counts: { pendingPostedCount: promoting ? ROWS : 0 } });
          started = performance.now();
          expect(route(payload)).toMatchObject({ status: 'nothing-new' });
          const replayMs = performance.now() - started;
          attempts.push({ importMs, replayMs, load: os.loadavg()[0] });
        } finally {
          repo.close();
        }
        const last = attempts.at(-1)!;
        if (last.importMs <= IMPORT_BUDGET_MS && last.replayMs <= REPLAY_BUDGET_MS) break;
      }
      judge(`card schema v15 v1 route of ${ROWS} rows, ${label}`, attempts, ctx);
    });
});
