import type { Database } from 'better-sqlite3';

import type { CardAccount } from '@finance-tracker/shared';

import type { ProofHoldCode, VerifierResult } from './receipt.js';

/**
 * G-ADMISSION (design v1.1 §3.4, roadmap v1.4 §5.3): the hook for per-source admission predicates. A verifier
 * registered for the account's source (W6's R1 card chain first, later W15) runs on the state before and after the
 * import, inside the proof's transaction.
 * - `fail` after the import holds (`proof-admission`).
 * - So does a regression: `pass` before but not after, or `reconciledThrough` moving backwards.
 * - `unknown` and `not-applicable` are recorded. They never hold, and never read as reconciled: "history without an
 *   anchor is not yet reconciled".
 *
 * The registry ships empty. A verifier joins it only through a reviewed change. Each source's DAILY INTERIM or AUTO
 * enable is gated by ROOT on its own verifier.
 */
export interface AdmissionVerdict {
  result: VerifierResult;
  /** YYYY-MM-DD, or null when the verifier proves no date. */
  reconciledThrough: string | null;
}

export interface AdmissionVerifier {
  /** A slug: letters, digits and single hyphens. */
  id: string;
  appliesTo(account: CardAccount): boolean;
  /** Read-only, on the proof's own connection. */
  evaluate(db: Database, account: CardAccount): AdmissionVerdict;
}

export const ADMISSION_VERIFIERS: readonly AdmissionVerifier[] = Object.freeze([]);

export interface AdmissionEntry {
  id: string;
  before: AdmissionVerdict;
  after: AdmissionVerdict;
}

export function evaluateAdmission(verifiers: readonly AdmissionVerifier[], db: Database,
  account: CardAccount): Map<string, AdmissionVerdict> {
  const results = new Map<string, AdmissionVerdict>();
  for (const verifier of verifiers) {
    if (verifier.appliesTo(account)) results.set(verifier.id, verifier.evaluate(db, account));
  }
  return results;
}

export function checkAdmission(before: ReadonlyMap<string, AdmissionVerdict>,
  after: ReadonlyMap<string, AdmissionVerdict>): { code: ProofHoldCode | null; entries: AdmissionEntry[] } {
  const entries: AdmissionEntry[] = [];
  let failed = false;
  for (const [id, now] of after) {
    const was = before.get(id) ?? { result: 'unknown' as const, reconciledThrough: null };
    entries.push({ id, before: was, after: now });
    if (now.result === 'fail') failed = true;
    else if (was.result === 'pass' && now.result !== 'pass') failed = true;
    else if (was.reconciledThrough !== null && (now.reconciledThrough === null || now.reconciledThrough < was.reconciledThrough)) {
      failed = true;
    }
  }
  if (before.size !== after.size) failed = true;
  return { code: failed ? 'proof-admission' : null, entries };
}
