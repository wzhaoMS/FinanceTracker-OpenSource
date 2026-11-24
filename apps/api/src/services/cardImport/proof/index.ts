/**
 * The W4 proof's entry point. `routes/cardSpending.ts` loads it only with a lazy `import()` inside its proof handlers,
 * never statically: the Mac CLI imports that route file for two helpers, and must not load the proof (809617d3). The API
 * process hashes every file here at startup as part of its code identity.
 */
import { CutoverCommitRefusal } from '../../guardedCardCommit.js';
import { errorTypeAndCode, HoldrRefusal, isCardGuardRefusal } from '../../dbErrors.js';

export { commitWithProof, resolveProof, ProofHold } from './commitWithProof.js';
export type {
  AppliedImport, ProofApply, ProofCommitResult, ProofContext, ProofResolveResult, ResolveContext,
} from './commitWithProof.js';
export { parseProofRequest, ProofRequestError, PROOF_QUERY_NAMES, encodeProofDeadline, encodeProofJob } from './request.js';
export type { ProofCommitRequest, ProofRequest, ProofResolveRequest } from './request.js';
export { PROOF_HOLD_CODES, proofReceiptSha256, type ProofHoldCode, type ProofReceipt } from './receipt.js';
export { stoppingLabel, type PermitLabel } from './permit.js';

/**
 * What an error thrown out of the proof transaction was. The transaction has rolled back in every case: better-sqlite3
 * rolls back whenever its function throws, and COMMIT failing included.
 * - `refusal`: the repository refused the import's input (field names and counts only): a 400, as today.
 * - `card-guard`: the database's card guards refused a write: the route's 422.
 * - `cutover`: the guarded cutover commit refused (its own 409).
 * - `error`: anything else, including SQLITE_BUSY at BEGIN: the route's value-free 500 `proof-error`.
 */
export function classifyProofError(error: unknown): 'refusal' | 'card-guard' | 'cutover' | 'error' {
  if (isCardGuardRefusal(error)) return 'card-guard';
  if (error instanceof CutoverCommitRefusal) return 'cutover';
  if (error instanceof HoldrRefusal) return 'refusal';
  return 'error';
}

/** The error's type and SQLite code only, for the operational log. */
export function proofErrorType(error: unknown): string {
  return errorTypeAndCode(error);
}
