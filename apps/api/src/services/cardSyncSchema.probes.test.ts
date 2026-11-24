import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type CardSyncValidatorRun, runCardSyncValidator } from '../testing/cardSyncValidator.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { CARD_SYNC_QUERIES } from './cardSyncSchemaSql.js';

// Card-sync schema v15 (E1b): every probe of the design's validator, run on
// this build's migration. Each catalogued CHECK, foreign key, UNIQUE key and
// invariant trigger is refused by at least one probe whose unmutated twin is
// accepted, and every behaviour the design states is executed. The guarded
// retention benchmark is the validator's last check and runs on its own, in
// cardSyncRetention.benchmark.test.ts.

let dir: string;
let run: CardSyncValidatorRun;

beforeAll(async () => {
  dir = await makeScratchDir('card-sync-probes-');
  run = runCardSyncValidator({ workDir: dir, sections: { probes: true } });
}, 300_000);

afterAll(async () => {
  await removeScratchDir(dir);
});

describe('card-sync schema v15: the design validator\'s probes', () => {
  it.each([
    'migration', 'phase A', 'phase B', 'fixtures', 'FK index audit', 'revision 3', 'revision 4', 'revision 5', 'revision 6',
    'revision 7', 'revision 8', 'census',
  ])('%s: every probe refused exactly as expected, every twin accepted', (section) => {
    expect(run.sectionFailures[section], `section ${section} ran`).toBeDefined();
    expect(run.sectionFailures[section]).toEqual([]);
  });

  it('catalogues the design\'s DDL: 29 tables, 389 column and 113 table CHECKs, 53 unique keys, 113 triggers', () => {
    expect(run.results.coverage).toMatchObject({
      newTables: 29, columnChecks: 389, tableChecks: 113, uniqueTotal: 53, triggerTotal: 113, fkTotal: 73,
    });
  });

  it('refuses through every catalogued constraint and trigger', () => {
    expect(run.results.coverage).toMatchObject({ checks: 502, fks: 73, uniques: 53, triggers: 113 });
  });

  it('runs the validator\'s 767 accepted twins, 994 refusals and its behaviour checks but the benchmark', () => {
    expect(run.results.failures).toEqual([]);
    expect({ accepted: run.results.accepted, refused: run.results.refused, behaviour: run.results.behaviour })
      .toEqual({ accepted: 767, refused: 994, behaviour: 33 });
  });

  it('executes all 22 named statements', () => {
    expect([...run.queriesUsed].sort()).toEqual(Object.keys(CARD_SYNC_QUERIES).sort());
    expect(run.queriesUsed).toHaveLength(22);
  });

  it('migrates fresh and upgraded v14 databases to identical schemas, and rolls a refused upgrade back byte for byte', () => {
    expect(run.results.notes).toEqual(expect.arrayContaining([
      expect.stringMatching(/^migration: 5 rows kept with rowids; fresh and upgraded schemas identical \(247 objects\)$/),
      expect.stringMatching(/^refused upgrade .* rolls back: file byte-identical, user_version 14$/),
    ]));
  });
});
