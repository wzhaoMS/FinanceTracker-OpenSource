import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { serializeCardImportPayload, validateCardImportPayload } from '@finance-tracker/shared';

import { indexesOf } from '../services/cardImport/plan.js';
import { commitWithProof, type AppliedImport } from '../services/cardImport/proof/commitWithProof.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';

/**
 * A child process for the proof's crash tests (design §6 D): one automatic proof commit on a database file, which stops
 * for the parent to kill it at one point: after the import is applied, mid-gates, after F2 just before COMMIT, or after
 * COMMIT. Synthetic data only.
 */
type Stage = 'after-apply' | 'mid-gates' | 'before-commit' | 'after-commit';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
  db: string; accountId: string; payload: string; jobId: string; stage: Stage;
};
const pause = (stage: Stage) => {
  process.stdout.write(`${stage}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
};

const repo = new SqliteStateRepo({ file: config.db });
const db = repo.internalGetDb();
const account = repo.getCardAccount(config.accountId);
const checked = validateCardImportPayload(JSON.parse(config.payload));
if (!account || !checked.ok) throw new Error('synthetic crash fixture invalid');
const payload = checked.payload;
const commitOnce = () => {
  const plan = repo.previewCardImport({ cardAccountId: account.id, payload }).plan;
  return repo.commitCardImport({ cardAccountId: account.id, payload, decisions: {}, shown: {
    possibleDuplicateRows: indexesOf(plan, 'possible-duplicate'), pendingMatchRows: indexesOf(plan, 'pending-match'),
    dismissedMatchRows: indexesOf(plan, 'dismissed-match'), stalePendingIds: plan.stale.map((row) => row.id),
  } });
};
// F1, the projection time, F2, then the receipt's commit time: the fourth call is after F2, just before the INSERT.
let nowCalls = 0, evaluations = 0;
commitWithProof({
  db, repo, account, payload, route: 'commit',
  payloadSha256: createHash('sha256').update(serializeCardImportPayload(payload)).digest('hex'),
  now: () => {
    nowCalls += 1;
    if (config.stage === 'before-commit' && nowCalls === 4) pause('before-commit');
    return Date.now();
  },
  verifiers: [{
    id: 'synthetic-pause', appliesTo: () => true,
    evaluate: () => {
      evaluations += 1;
      if (config.stage === 'mid-gates' && evaluations === 2) pause('mid-gates');
      return { result: 'not-applicable', reconciledThrough: null };
    },
  }],
}, { mode: 'automatic', jobId: config.jobId, attempt: 1, deadlineMs: Date.now() + 60_000, statementPolicy: 'require-match' }, {
  commit(): AppliedImport {
    const result = commitOnce();
    if (result.status === 'decision-required') throw new Error('synthetic plan not clean');
    if (config.stage === 'after-apply') pause('after-apply');
    return {
      outcome: result.status === 'imported' ? 'committed' : 'nothing-new', planDigest: result.preview.previewDigest,
      newCount: result.status === 'imported' ? result.batch.newCount : 0, promotedCount: result.counts.pendingPostedCount,
      skippedRows: [], heldCount: result.applied.heldRows.length + result.applied.heldOpenRows.length,
      reviewCount: result.applied.reviewRows.length,
    };
  },
  reapplyAddsNothing: () => commitOnce().status === 'nothing-new',
});
if (config.stage === 'after-commit') pause('after-commit');
process.stdout.write('finished\n');
