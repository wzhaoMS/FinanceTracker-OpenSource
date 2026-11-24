import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

export interface CutoverCommitGuard {
  jobId: string;
  accountId: string;
  payloadSha256: string;
  epoch: string;
  start: string;
  proposalDigest: string;
  issuer: string;
  owner: string;
  currency: string;
  last4: string;
}
export interface CutoverCommitCounts {
  cardAccountId: string;
  imported: boolean;
  rowCount: number;
  newCount: number;
  duplicateCount: number;
}
export interface CutoverCommitReceipt extends CutoverCommitCounts {
  version: 1;
  jobId: string;
  payloadSha256: string;
  proposalDigest: string;
  start: string;
  epochBefore: string;
  epochAfter: string;
  guardDigest: string;
  boundaryReconciled: false;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class CutoverCommitRefusal extends Error {
  constructor() { super('Cutover commit preconditions changed or receipt conflicts'); }
}
function requireCondition(value: unknown): asserts value {
  if (!value) throw new CutoverCommitRefusal();
}
const CUTOVER_SCHEMA_SQL = `CREATE TABLE card_cutover_commit_receipts (
    job_id TEXT PRIMARY KEY NOT NULL,
    card_account_id TEXT NOT NULL REFERENCES card_accounts(id),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
  )`;
const normalizeSql = (sql: string) => sql.trim().replace(/\s+/g,' ');
export const CUTOVER_SCHEMA_DIGEST = digest(normalizeSql(CUTOVER_SCHEMA_SQL));
/** Read-only capability detection: absence or a conflicting schema is a hold. */
export function hasCutoverReceiptSchema(db: Database): boolean {
  const object = db.prepare("SELECT type,sql FROM sqlite_master WHERE name='card_cutover_commit_receipts'")
    .get() as {type:string;sql:string|null}|undefined;
  return object?.type==='table' && typeof object.sql==='string'
    && normalizeSql(object.sql)===normalizeSql(CUTOVER_SCHEMA_SQL);
}
/** Only the explicit, backed-up operator schema command may call this installer. */
export function installCutoverReceiptSchema(db: Database): void {
  db.transaction(()=>{
    if(hasCutoverReceiptSchema(db))return;
    requireCondition(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='card_cutover_commit_receipts'").get());
    db.exec(CUTOVER_SCHEMA_SQL);
    requireCondition(hasCutoverReceiptSchema(db));
  }).immediate();
}
export function cardAccountEpoch(db: Database, accountId: string): string {
  const account = db.prepare('SELECT * FROM card_accounts WHERE id=?').get(accountId);
  requireCondition(account);
  const rows = db.prepare('SELECT * FROM card_transactions WHERE card_account_id=? ORDER BY id').all(accountId);
  return digest([account, rows]);
}
export function readCutoverCommitReceipt(db: Database, accountId: string, jobId: string): CutoverCommitReceipt | null {
  requireCondition(hasCutoverReceiptSchema(db));
  const row = db.prepare('SELECT receipt_json FROM card_cutover_commit_receipts WHERE job_id=? AND card_account_id=?')
    .get(jobId, accountId) as { receipt_json: string } | undefined;
  if (!row) return null;
  const receipt: CutoverCommitReceipt = JSON.parse(row.receipt_json);
  requireCondition(receipt.version === 1 && receipt.jobId === jobId && receipt.cardAccountId === accountId
    && /^[a-f0-9]{64}$/.test(receipt.payloadSha256) && /^[a-f0-9]{64}$/.test(receipt.epochAfter));
  return receipt;
}
export function commitGuardedCardImport(
  db: Database, guard: CutoverCommitGuard, commit: (repeat: boolean) => CutoverCommitCounts,
): { receipt: CutoverCommitReceipt; repeated: boolean } {
  requireCondition(hasCutoverReceiptSchema(db));
  requireCondition([guard.jobId,guard.payloadSha256,guard.epoch,guard.proposalDigest].every(value =>
    /^[a-f0-9]{64}$/.test(value))
    && /^card-acct-[a-p]{32}$/.test(guard.accountId)
    && /^\d{4}-\d{2}-\d{2}$/.test(guard.start) && Number.isFinite(Date.parse(guard.start))
    && new Date(guard.start).toISOString().slice(0,10) === guard.start
    && ['citi','chase'].includes(guard.issuer) && ['alex','casey'].includes(guard.owner)
    && /^[A-Z]{3}$/.test(guard.currency) && /^\d{4}$/.test(guard.last4));
  return db.transaction(() => {
    const account = db.prepare('SELECT issuer,owner,currency,last4,status FROM card_accounts WHERE id=?')
      .get(guard.accountId) as { issuer: string; owner: string; currency: string; last4: string; status: string } | undefined;
    requireCondition(account?.status === 'active' && account.issuer === guard.issuer && account.owner === guard.owner
      && account.currency === guard.currency && account.last4 === guard.last4);
    const previous = readCutoverCommitReceipt(db, guard.accountId, guard.jobId);
    const guardDigest = digest(guard);
    const epoch = cardAccountEpoch(db, guard.accountId);
    if (previous) {
      requireCondition(previous.guardDigest === guardDigest && previous.epochAfter === epoch
        && previous.payloadSha256 === guard.payloadSha256 && previous.proposalDigest === guard.proposalDigest);
      const repeated = commit(true);
      requireCondition(repeated.imported === false && repeated.newCount === 0
        && repeated.duplicateCount === previous.rowCount && repeated.rowCount === previous.rowCount
        && repeated.cardAccountId === guard.accountId && cardAccountEpoch(db, guard.accountId) === epoch);
      return { receipt: previous, repeated: true };
    }
    requireCondition(epoch === guard.epoch);
    const result = commit(false);
    requireCondition(result.cardAccountId === guard.accountId && Number.isSafeInteger(result.newCount)
      && Number.isSafeInteger(result.duplicateCount) && result.newCount >= 0 && result.duplicateCount >= 0
      && result.rowCount === result.newCount + result.duplicateCount);
    const receipt: CutoverCommitReceipt = { ...result, version: 1, jobId: guard.jobId,
      payloadSha256: guard.payloadSha256, proposalDigest: guard.proposalDigest, start: guard.start,
      epochBefore: epoch, epochAfter: cardAccountEpoch(db, guard.accountId), guardDigest, boundaryReconciled: false };
    db.prepare('INSERT INTO card_cutover_commit_receipts(job_id,card_account_id,receipt_json) VALUES(?,?,?)')
      .run(guard.jobId, guard.accountId, JSON.stringify(receipt));
    return { receipt, repeated: false };
  }).immediate();
}
