import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';

import { runA9Sequence } from '../testing/cardImportA9.js';
import type { CardImportOracle } from '../testing/cardImportOracle.js';

// E1b design §7.4 test 69 (A9): this build's v1 imports against the integrated Phase 4 code, main 89c568b (schema v14,
// with #22's pending decisions and 73bd3e4's dismissedMatches), over 40 random multi-step sequences: imports through the
// real routes, each previewed and committed until every 409 is answered with a random decision, interleaved with the
// owner's dismissals, restores, postedAs, category and notes edits, on a Chase card and on a Discover card. Every
// request's status, normalized body and the ledger after it must match what v14 answered (testing/cardImportOracle.ts;
// __fixtures__/cardImportA9.v14.json and cardImportA9.v14.discover.json hold v14's digests), except, on the Chase card,
// for the design's declared exceptions, E-Q7 and A16. Each is checked against what the request
// must do, worked out before it runs from the database and the request alone, never from the classifier: exactly the
// rows it must ask about, listed, and on a commit their observations and items stored, at their file positions, and
// nothing else (testing/cardImportA9.ts; E2d review r1 D13, r2 finding 3). routes/cardImportA9.controls.test.ts shows
// that builds which leave some of that work out, or store it only in part, fail.
//
// To record the oracle again: `git worktree add --detach <dir> 89c568b`, `npm ci` there, copy
// testing/cardImportOracle.ts and testing/cardImportOracle.generate.test.ts into its apps/api/src/testing, then in its
// apps/api run `A9_ORACLE_OUT=<file> A9_ORACLE_NAME='…' [A9_ORACLE_ISSUER=discover] npx vitest run
// src/testing/cardImportOracle.generate.test.ts`. A9_FULL_SEED=<seed> writes one sequence in full instead, on either
// build, to compare a difference by hand. Both recordings are deterministic (recorded twice, byte for byte).

const load = (name: string) => JSON.parse(fs.readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')) as CardImportOracle;

/** What every fixture's sequences must reach: each decision and outcome the comparison is for. */
const REACHED = ['preview 200', 'commit 201', 'commit 200', 'commit 409', 'patch 200', 'decision possibleDuplicates=skip',
  'decision possibleDuplicates=import', 'decision pendingMatches=post', 'decision pendingMatches=skip', 'decision pendingMatches=split',
  'decision pendingMatches=import', 'decision dismissedMatches=post', 'decision dismissedMatches=keep', 'decision stalePending=dismiss',
  'decision acceptMismatch=true', '409 possible duplicates', '409 pending matches', '409 dismissed matches', '409 statement mismatch',
  '200 nothing new', '201 promoted', '201 stale dismissed', '201 with a reference conflict', '201 skipped possible duplicates',
  'patch status=removed', 'patch status=pending', 'patch postedAs', 'patch userCategory', 'patch notes'];
const EXCEPTIONS = ['E-Q7 rows asked', 'E-Q7 posted-correction items stored', 'E-Q7 pending-changed items stored', 'A16 answers'];

// A Chase card (an issuer the browser extension syncs: the design's E-Q7 and A16 exceptions occur and are checked), and a
// Discover card (an issuer it doesn't sync: no file set can exist, so no exception may occur and every answer must be
// v14's; E2d-D22). The Discover fixture was recorded on 89c568b with A9_ORACLE_ISSUER=discover.
describe.each([
  { issuer: 'chase', fixture: 'cardImportA9.v14.json', exceptions: true },
  { issuer: 'discover', fixture: 'cardImportA9.v14.discover.json', exceptions: false },
])('A9 on a $issuer card: v1 imports answer as the integrated Phase 4 code (main 89c568b, schema v14), but for its declared exceptions',
  ({ issuer, fixture, exceptions }) => {
    const oracle = load(fixture);
    /** What the sequences reached, from this build's own observations once they matched v14's. */
    const seen = new Map<string, number>();
    const note = (what: string) => seen.set(what, (seen.get(what) ?? 0) + 1);
    let completed = 0;

    it.each(oracle.sequences.map((sequence) => [sequence.seed, sequence] as const))('sequence %i, request by request',
      async (_seed, sequence) => {
        expect(oracle.issuer ?? 'chase').toBe(issuer);
        await runA9Sequence(sequence, oracle.steps, note, issuer);
        completed += 1;
      }, 60_000);

    afterAll(() => {
      // The sequences must reach every decision and every outcome the comparison is for, or the comparison means little
      // (checked when all of them ran and matched); the exceptions on a Chase card, and never on a Discover card.
      if (completed < oracle.sequences.length) return;
      const missing = [...REACHED, ...(exceptions ? EXCEPTIONS : [])].filter((what) => !seen.has(what));
      expect(missing, JSON.stringify(Object.fromEntries(seen))).toEqual([]);
      if (!exceptions) expect(EXCEPTIONS.filter((what) => seen.has(what))).toEqual([]);
    });
  });
