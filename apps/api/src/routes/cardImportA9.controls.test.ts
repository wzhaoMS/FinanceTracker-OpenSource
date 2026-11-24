import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CardImportOracle } from '../testing/cardImportOracle.js';

// E2d review r2, finding 3: negative controls for A9 (routes/cardImportA9.test.ts). Each replaces one production function
// through a module mock, nothing else (the comparison, its projection and v14's fixture are untouched), replays A9's
// sequences until one fails, and requires that the mutation ran and that A9 refused it for what it broke. These are the
// reviewer's two mutations, which the round-1 comparison let through 40 of 40.

const oracle = JSON.parse(fs.readFileSync(new URL('./__fixtures__/cardImportA9.v14.json', import.meta.url), 'utf8')) as CardImportOracle;
const REVIEW = '../services/cardImport/review.js';
const ITEMS = '../services/cardSync/items.js';

afterEach(() => {
  vi.doUnmock(REVIEW);
  vi.doUnmock(ITEMS);
  vi.resetModules();
});

/** A9's sequences on the build as mocked, until the first that fails: its error, or null when all pass. */
async function firstFailure(): Promise<{ seed: number; message: string } | null> {
  const { runA9Sequence } = await import('../testing/cardImportA9.js');
  for (const sequence of oracle.sequences) {
    try {
      await runA9Sequence(sequence, oracle.steps);
    } catch (error) {
      return { seed: sequence.seed, message: (error as Error).message };
    }
  }
  return null;
}

describe('A9 fails on builds that leave required review work out (E2d review r2, finding 3)', () => {
  it('when the E-Q7 work of some rows is dropped (the reviewer\'s NORTHWIND mutation: a selective D1)', async () => {
    let omitted = 0;
    vi.resetModules();
    vi.doMock(REVIEW, async (importOriginal) => {
      const actual = await importOriginal<typeof import('../services/cardImport/review.js')>();
      return {
        ...actual,
        fileReviewWork: (...args: Parameters<typeof actual.fileReviewWork>) => {
          const work = actual.fileReviewWork(...args);
          const review = work.review.filter((entry) => !entry.row.values.description.includes('NORTHWIND'));
          omitted += work.review.length - review.length;
          return { ...work, review };
        },
      };
    });
    const failure = await firstFailure();
    expect(omitted, 'the mutation ran').toBeGreaterThan(0);
    expect(failure?.message).toContain('the answer lists exactly the rows the request must ask about');
  }, 120_000);

  it('when a file set\'s observations are stored without their items (the reviewer\'s drop-file-items mutation)', async () => {
    let dropped = 0;
    vi.resetModules();
    vi.doMock(ITEMS, async (importOriginal) => {
      const actual = await importOriginal<typeof import('../services/cardSync/items.js')>();
      return {
        ...actual,
        insertItems: (...args: Parameters<typeof actual.insertItems>) => {
          const [db, , set] = args;
          if (db.prepare('SELECT origin FROM card_sync_observation_sets WHERE id = ?').pluck().get(set.id) === 'file') {
            dropped += 1;
            return [];
          }
          return actual.insertItems(...args);
        },
      };
    });
    const failure = await firstFailure();
    expect(dropped, 'the mutation ran').toBeGreaterThan(0);
    expect(failure?.message).toContain('the review work it stores');
  }, 120_000);
});
