/**
 * The proof's query parameters on the two card-import commit routes (design v1.1 §3.2). Every value is encoded so that
 * the card-data scan (13 or more digits in a row) never refuses it.
 * - `proofJob=h1:<64 letters a-p>`: the Mac job id, a sha256 in the cutover route's letter encoding.
 * - `proofAttempt=<1-6 digits>`: the job's attempt number, which the runner persists before it sends.
 * - `proofDeadline=d1:<1-12 letters a-p>`: the client's deadline, in epoch milliseconds, hex in the same letters. It only
 *   bounds how late a commit can land; correctness never depends on it.
 * - `proofMode=automatic|supervised|resolve`.
 * - `proofStatementPolicy=require-match|allow-unchecked-no-figures`: required unless resolving.
 *
 * Parsing never echoes a value; a refusal names only the parameter.
 */

export const PROOF_QUERY_NAMES = Object.freeze(['proofJob', 'proofAttempt', 'proofDeadline', 'proofMode', 'proofStatementPolicy']);

export type ProofMode = 'automatic' | 'supervised' | 'resolve';
export type ProofCommitMode = Exclude<ProofMode, 'resolve'>;
export type StatementPolicy = 'require-match' | 'allow-unchecked-no-figures';

/** The furthest a client's deadline may lie in the future when the request is parsed. */
export const PROOF_MAX_DEADLINE_MS = 60_000;
/** The largest attempt number: far more than any job's retries, and fewer than 13 digits. */
export const PROOF_MAX_ATTEMPT = 999_999;

export interface ProofCommitRequest {
  mode: ProofCommitMode;
  /** 64 lowercase hex. */
  jobId: string;
  attempt: number;
  deadlineMs: number;
  statementPolicy: StatementPolicy;
}

export interface ProofResolveRequest {
  mode: 'resolve';
  jobId: string;
  attempt: number;
}

export type ProofRequest = ProofCommitRequest | ProofResolveRequest;

const HEX_LETTERS = /^[a-p]+$/;

/** Hex as the cutover route writes it: one letter a-p per hex digit. */
export function hexToLetters(hex: string): string {
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

export function lettersToHex(letters: string): string {
  return [...letters].map((letter) => (letter.charCodeAt(0) - 97).toString(16)).join('');
}

export function encodeProofJob(jobId: string): string {
  return 'h1:' + hexToLetters(jobId);
}

export function encodeProofDeadline(deadlineMs: number): string {
  return 'd1:' + hexToLetters(Math.trunc(deadlineMs).toString(16));
}

/** True when any proof parameter is present: the request asks for the proof, and must be complete. */
export function hasProofParams(query: ReadonlyMap<string, string>): boolean {
  return PROOF_QUERY_NAMES.some((name) => query.has(name));
}

/** A refusal of the request's shape (the route's 400), naming one parameter and never its value. */
export class ProofRequestError extends Error {
  constructor(readonly parameter: string) {
    super(`${parameter} is missing or invalid`);
    this.name = 'ProofRequestError';
  }
}

function decodeJob(value: string | undefined): string {
  if (value === undefined || !/^h1:[a-p]{64}$/.test(value)) throw new ProofRequestError('proofJob');
  return lettersToHex(value.slice(3));
}

function decodeAttempt(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]{0,5}$/.test(value)) throw new ProofRequestError('proofAttempt');
  const attempt = Number(value);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > PROOF_MAX_ATTEMPT) throw new ProofRequestError('proofAttempt');
  return attempt;
}

function decodeDeadline(value: string | undefined, now: number): number {
  if (value === undefined || !/^d1:[a-p]{1,12}$/.test(value) || !HEX_LETTERS.test(value.slice(3))) {
    throw new ProofRequestError('proofDeadline');
  }
  const deadline = Number.parseInt(lettersToHex(value.slice(3)), 16);
  // A deadline already passed is the fence's to refuse (409, nothing written), not a malformed request.
  if (!Number.isSafeInteger(deadline) || deadline > now + PROOF_MAX_DEADLINE_MS) throw new ProofRequestError('proofDeadline');
  return deadline;
}

/**
 * The proof request in `query`, or a ProofRequestError. Resolve takes exactly the job and its attempt; the commit modes
 * take every parameter.
 */
export function parseProofRequest(query: ReadonlyMap<string, string>, now: number): ProofRequest {
  const mode = query.get('proofMode');
  if (mode !== 'automatic' && mode !== 'supervised' && mode !== 'resolve') throw new ProofRequestError('proofMode');
  const jobId = decodeJob(query.get('proofJob'));
  const attempt = decodeAttempt(query.get('proofAttempt'));
  if (mode === 'resolve') {
    if (query.has('proofDeadline')) throw new ProofRequestError('proofDeadline');
    if (query.has('proofStatementPolicy')) throw new ProofRequestError('proofStatementPolicy');
    return { mode, jobId, attempt };
  }
  const deadlineMs = decodeDeadline(query.get('proofDeadline'), now);
  const statementPolicy = query.get('proofStatementPolicy');
  if (statementPolicy !== 'require-match' && statementPolicy !== 'allow-unchecked-no-figures') {
    throw new ProofRequestError('proofStatementPolicy');
  }
  return { mode, jobId, attempt, deadlineMs, statementPolicy };
}
