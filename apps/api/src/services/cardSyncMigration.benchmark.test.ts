import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { cardSchemaDump } from '../testing/cardSchemaDump.js';
import { writeLargeV14CardLedger } from '../testing/cardSyncLedgerSeed.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { SqliteStateRepo } from './sqliteStateRepo.js';
import Database from 'better-sqlite3';

// Card-sync schema v15 (E1b design §7.11 P6, P9): the upgrade's time on
// realistic v14 ledgers, guard re-check included, and the reopen of an
// up-to-date database. Heavy (a 50,000-row ledger), so kept in its own file.
// The budgets are wall-clock on the design's reference Mac (this suite's
// host); a busy machine gets a second attempt on a byte-identical copy, and
// every attempt is reported.

const BUDGETS_MS: Array<[rows: number, budget: number]> = [[5_000, 3_000], [50_000, 30_000]];
const REOPEN_BUDGET_MS = 50;
const GOLDEN = new URL('./__fixtures__/card-schema-v15.sql', import.meta.url);

let dir: string;

beforeAll(async () => {
  dir = await makeScratchDir('card-sync-migration-');
});

afterAll(async () => {
  await removeScratchDir(dir);
});

describe('card schema v15: upgrade time on realistic v14 ledgers (P9) and reopen time (P6)', () => {
  it.each(BUDGETS_MS)('upgrades %i v14 card rows within %i ms, guard re-check included', (rows, budget) => {
    const v14 = path.join(dir, `v14-${rows}.db`);
    const { batches } = writeLargeV14CardLedger(v14, rows);
    const attempts: number[] = [];
    let upgraded = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      upgraded = path.join(dir, `v15-${rows}-${attempt}.db`);
      fs.copyFileSync(v14, upgraded);
      const started = performance.now();
      new SqliteStateRepo({ file: upgraded }).close();
      attempts.push(performance.now() - started);
      if (attempts.at(-1)! <= budget) break;
    }
    const report = `${rows} rows in ${batches} imports: ${attempts.map((ms) => `${ms.toFixed(0)} ms`).join(', then ')}`;
    console.info(`card schema v15 upgrade: ${report} (budget ${budget} ms)`);
    expect(Math.min(...attempts), report).toBeLessThanOrEqual(budget);

    const db = new Database(upgraded, { readonly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM card_source_identities').get()).toEqual({ n: rows });
      expect(db.prepare('SELECT count(*) AS n FROM card_identity_contents').get()).toEqual({ n: rows });
      expect(cardSchemaDump(db)).toBe(fs.readFileSync(GOLDEN, 'utf8'));
    } finally {
      db.close();
    }

    if (rows === BUDGETS_MS.at(-1)![0]) {
      const reopens = Array.from({ length: 9 }, () => {
        const started = performance.now();
        new SqliteStateRepo({ file: upgraded }).close();
        return performance.now() - started;
      }).sort((a, b) => a - b);
      const median = reopens[4];
      console.info(`card schema v15 reopen of ${rows} rows: median ${median.toFixed(1)} ms of ${reopens.map((ms) => ms.toFixed(0)).join('/')}`);
      expect(median, reopens.map((ms) => ms.toFixed(1)).join('/')).toBeLessThanOrEqual(REOPEN_BUDGET_MS);
    }
  }, 300_000);
});
