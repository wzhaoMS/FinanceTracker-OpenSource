import type Database from 'better-sqlite3';

import { digest } from '../amazon/policy.js';
import { toValueFreeDbError } from '../dbErrors.js';
import { RetailRefusal, checkRetailWriteContext, newRetailId, retailIdPattern, retailLetters, type RetailWriteContext } from './common.js';
import { retailReceiptByRef } from './identity.js';
import { appendRetailEvent, retailEvidence, retailEvidenceDigest } from './receipts.js';
import {
  RETAIL_WRITTEN_DECISIONS,
  appendRetailAudit,
  requireRetailSchema,
  retailSchemaForRead,
  type RetailQuarantineReason,
  type RetailWrittenDecision,
} from './schema.js';

/**
 * Reviews (plan v5 §6): an owner's decision on a quarantined receipt, pinned to the receipt's whole evidence set.
 *
 * `review-receipt` checks, in this order: the file's shape (before anything is looked up: an empty file, a receipt named
 * twice, decisions out of order, or a decision its writer may not take, `correct` included, are `retail-review-invalid`);
 * the exact file again (`retail-already-reviewed` when its SHA-256 is recorded for every receipt it names, before any
 * stale check); then every decision's pins, all before any write, under the write lock: the evidence digest
 * (`retail-review-stale`), the receipt quarantined (`retail-receipt-not-quarantined`), `before` its canonical version and
 * `chosen` one of its versions (`retail-review-invalid`). One failing decision refuses the whole file.
 *
 * `canonical` makes the receipt active on the chosen version; `keep-quarantined` records the decision and changes
 * nothing else. Each writes a review row, whose `through_import_seq` resolves exactly the holds it pinned (§5.5), and a
 * `review` event. A decision binds only the evidence it pinned: a later quarantining sighting holds the receipt again.
 */

export const RETAIL_REVIEW_FORMAT = 'holdr.retail-receipt-review' as const;
/** A review file's keys, and each decision's, exactly (the CLI checks the key sets with the shared `exactKeys`). */
export const RETAIL_REVIEW_KEYS = ['format', 'version', 'decisions'] as const;
export const RETAIL_REVIEW_DECISION_KEYS = ['receiptRef', 'evidenceDigest', 'decision', 'before', 'chosen'] as const;
/** At most this many decisions in one file. */
export const RETAIL_REVIEW_MAX_DECISIONS = 1_000;

export interface RetailReviewDecisionInput {
  receiptRef: string;
  /** The receipt's evidence digest as `quarantine` listed it (lowercase hex). */
  evidenceDigest: string;
  decision: RetailWrittenDecision;
  before: string;
  chosen: string | null;
}

export interface RetailReviewFile {
  format: typeof RETAIL_REVIEW_FORMAT;
  version: 1;
  decisions: RetailReviewDecisionInput[];
}

const RECEIPT_REF = retailIdPattern('rcp-');
const VERSION_REF = retailIdPattern('rrv-');
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * A review file's values (§6 step 1), its key sets already checked: the format and version, one to `RETAIL_REVIEW_MAX_DECISIONS` decisions sorted
 * by receipt ref with each ref once, and each decision a writer may take (`canonical` with a chosen version, or
 * `keep-quarantined` with none). The reserved `correct` is refused as input (plan §5.7). Anything else is
 * `retail-review-invalid`; nothing is looked up.
 */
export function retailReviewOf(file: { format: unknown; version: unknown; decisions: unknown }): RetailReviewFile {
  const refuse = (): never => { throw new RetailRefusal('retail-review-invalid'); };
  if (file.format !== RETAIL_REVIEW_FORMAT || file.version !== 1 || !Array.isArray(file.decisions)) return refuse();
  const decisions = file.decisions as unknown[];
  if (decisions.length < 1 || decisions.length > RETAIL_REVIEW_MAX_DECISIONS) return refuse();
  const checked = decisions.map((value): RetailReviewDecisionInput => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return refuse();
    const entry = value as Record<string, unknown>;
    const { receiptRef, evidenceDigest, decision, before, chosen } = entry;
    if (typeof receiptRef !== 'string' || !RECEIPT_REF.test(receiptRef) || typeof evidenceDigest !== 'string' || !HEX64.test(evidenceDigest)
      || typeof before !== 'string' || !VERSION_REF.test(before)) return refuse();
    if (typeof decision !== 'string' || !(RETAIL_WRITTEN_DECISIONS as readonly string[]).includes(decision)) return refuse();
    if (decision === 'canonical' ? typeof chosen !== 'string' || !VERSION_REF.test(chosen) : chosen !== null) return refuse();
    return { receiptRef, evidenceDigest, decision: decision as RetailWrittenDecision, before, chosen: chosen as string | null };
  });
  checked.forEach((entry, index) => {
    if (index > 0 && !(checked[index - 1].receiptRef < entry.receiptRef)) refuse();
  });
  return { format: RETAIL_REVIEW_FORMAT, version: 1, decisions: checked };
}

export interface RetailReviewContext extends RetailWriteContext {
  /** The GO's `reviewSha256` (lowercase hex): the file's own SHA-256. */
  reviewSha256: string;
  /** The preflight's plan digest, or null to plan and write at once. */
  planDigest: string | null;
}

export interface RetailReviewPlan {
  reviewSha256: string;
  alreadyReviewed: boolean;
  /** Each decision's receipt and, once written, its review. */
  decisions: Array<{ receiptRef: string; decision: RetailWrittenDecision; reviewRef: string | null }>;
  throughImportSeq: number;
  /** Lowercase hex. */
  planDigest: string;
}

export interface RetailReviewReceipt extends RetailReviewPlan {
  code: 'retail-reviewed' | 'retail-already-reviewed';
}

interface Pinned {
  entry: RetailReviewDecisionInput;
  state: 'active' | 'quarantined';
  firstReason: string | null;
}

/**
 * The plan: the STOP and the schema first; the exact file again; then every decision's pins. Read inside the caller's
 * transaction, so a write sees the pins under its lock.
 */
function prepare(db: Database.Database, review: RetailReviewFile, reviewSha256: string): { plan: RetailReviewPlan; pinned: Pinned[] } {
  requireRetailSchema(db);
  const recorded = db.prepare('SELECT review_ref FROM retail_receipt_reviews WHERE review_sha256 = ? AND receipt_ref = ?').pluck();
  const sha = retailLetters(reviewSha256);
  const replayed = review.decisions.map((entry) => recorded.get(sha, entry.receiptRef) as string | undefined);
  const throughImportSeq = db.prepare('SELECT coalesce(max(import_seq), 0) FROM retail_imports').pluck().get() as number;
  if (replayed.every((reviewRef) => reviewRef !== undefined)) {
    return {
      plan: {
        reviewSha256, alreadyReviewed: true, throughImportSeq,
        decisions: review.decisions.map((entry, index) => ({ receiptRef: entry.receiptRef, decision: entry.decision, reviewRef: replayed[index]! })),
        planDigest: digest({ format: 'holdr.retail-review-plan', version: 1, reviewSha256, alreadyReviewed: replayed }),
      },
      pinned: [],
    };
  }
  const versions = db.prepare('SELECT 1 FROM retail_receipt_versions WHERE version_ref = ? AND receipt_ref = ?');
  const pinned = review.decisions.map((entry): Pinned => {
    const receipt = retailReceiptByRef(db, entry.receiptRef);
    if (receipt === null) throw new RetailRefusal('retail-receipt-unknown', { receiptRef: entry.receiptRef });
    if (retailEvidenceDigest(retailEvidence(db, receipt.receiptRef)) !== entry.evidenceDigest) {
      throw new RetailRefusal('retail-review-stale', { receiptRef: entry.receiptRef });
    }
    if (receipt.state !== 'quarantined') throw new RetailRefusal('retail-receipt-not-quarantined', { receiptRef: entry.receiptRef });
    if (entry.before !== receipt.canonicalVersion || (entry.chosen !== null && versions.get(entry.chosen, receipt.receiptRef) === undefined)) {
      throw new RetailRefusal('retail-review-invalid', { receiptRef: entry.receiptRef });
    }
    return { entry, state: receipt.state, firstReason: receipt.firstReason };
  });
  return {
    plan: {
      reviewSha256, alreadyReviewed: false, throughImportSeq,
      decisions: review.decisions.map((entry) => ({ receiptRef: entry.receiptRef, decision: entry.decision, reviewRef: null })),
      planDigest: digest({
        format: 'holdr.retail-review-plan', version: 1, reviewSha256, throughImportSeq,
        decisions: review.decisions.map((entry) => [entry.receiptRef, entry.evidenceDigest, entry.decision, entry.before, entry.chosen]),
      }),
    },
    pinned,
  };
}

function write(db: Database.Database, review: RetailReviewFile, prepared: { plan: RetailReviewPlan; pinned: Pinned[] },
  authority: ReturnType<typeof checkRetailWriteContext>): RetailReviewReceipt {
  const { plan, pinned } = prepared;
  const insert = db.prepare(`INSERT INTO retail_receipt_reviews (review_ref, review_sha256, receipt_ref, evidence_digest, through_import_seq,
    decision, before_version, chosen_version, go_id, purpose, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const decisions = pinned.map(({ entry, firstReason }) => {
    const reviewRef = newRetailId('rtl-rev-');
    insert.run(reviewRef, retailLetters(plan.reviewSha256), entry.receiptRef, retailLetters(entry.evidenceDigest), plan.throughImportSeq,
      entry.decision, entry.before, entry.chosen, authority.goId, authority.purpose, authority.at);
    const canonical = entry.decision === 'canonical';
    appendRetailEvent(db, entry.receiptRef, {
      kind: 'review', state: canonical ? 'active' : 'quarantined', firstReason: canonical ? null : (firstReason as RetailQuarantineReason),
      canonicalVersion: canonical ? entry.chosen! : entry.before, reason: null, cause: { reviewRef }, importId: null, goId: authority.goId,
      at: authority.at,
    });
    return { receiptRef: entry.receiptRef, decision: entry.decision, reviewRef };
  });
  appendRetailAudit(db, { kind: 'review', inputSha256: retailLetters(plan.reviewSha256), planDigest: retailLetters(plan.planDigest), authority });
  return { code: 'retail-reviewed', ...plan, decisions };
}

/** Read-only: what the review would do, or the refusal it would meet. */
export function planRetailReview(db: Database.Database, review: RetailReviewFile, reviewSha256: string): RetailReviewPlan {
  const checked = retailReviewOf(review);
  if (typeof reviewSha256 !== 'string' || !HEX64.test(reviewSha256)) throw new RetailRefusal('retail-digest-invalid');
  try {
    return db.transaction(() => prepare(db, checked, reviewSha256).plan)();
  } catch (error) {
    if (error instanceof RetailRefusal) throw error;
    throw toValueFreeDbError('plan retail review', error);
  }
}

/** Records the review file's decisions, all or nothing, in one IMMEDIATE transaction (the operator's backed-up one). */
export function reviewRetailReceipts(db: Database.Database, review: RetailReviewFile, context: RetailReviewContext): RetailReviewReceipt {
  const authority = checkRetailWriteContext(context, 'review-receipt');
  const checked = retailReviewOf(review);
  if (typeof context.reviewSha256 !== 'string' || !HEX64.test(context.reviewSha256)) throw new RetailRefusal('retail-digest-invalid');
  if (context.planDigest !== null && (typeof context.planDigest !== 'string' || !HEX64.test(context.planDigest))) {
    throw new RetailRefusal('retail-digest-invalid');
  }
  try {
    return db.transaction((): RetailReviewReceipt => {
      const prepared = prepare(db, checked, context.reviewSha256);
      if (prepared.plan.alreadyReviewed) return { code: 'retail-already-reviewed', ...prepared.plan };
      if (context.planDigest !== null && prepared.plan.planDigest !== context.planDigest) throw new RetailRefusal('retail-plan-changed');
      return write(db, checked, prepared, authority);
    }).immediate();
  } catch (error) {
    if (error instanceof RetailRefusal) throw error;
    throw toValueFreeDbError('review retail receipts', error);
  }
}

/** One quarantined receipt as `quarantine` lists it (§6): refs, closed reasons, digest prefixes, policies and dates only. */
export interface RetailQuarantineEntry {
  receiptRef: string;
  firstReason: string;
  causes: Array<{ seq: number; reason: string; ref: string }>;
  observations: string[];
  held: string[];
  versions: Array<{ versionRef: string; source: string; meaning: string; provenance: string; policyVersion: number; date: string }>;
  canonicalVersion: string;
  evidenceDigest: string;
}

export interface RetailQuarantineList {
  code: 'retail-quarantine-listed';
  schema: 'present' | 'absent';
  receipts: RetailQuarantineEntry[];
}

/** Letter-hex digests are value-free; their first twelve letters tell versions apart. */
const PREFIX = 12;

/** Every quarantined receipt and its evidence, for a review to be built from (§6, §8.3); shows no fact but dates. */
export function retailQuarantine(db: Database.Database): RetailQuarantineList {
  if (retailSchemaForRead(db) === 'absent') return { code: 'retail-quarantine-listed', schema: 'absent', receipts: [] };
  const refs = db.prepare(`SELECT receipt_ref FROM retail_receipts WHERE state = 'quarantined' ORDER BY receipt_ref`).pluck().all() as string[];
  const causes = db.prepare(`SELECT seq, reason, coalesce(observation_ref, held_ref) AS ref FROM retail_receipt_events
    WHERE receipt_ref = ? AND kind IN ('quarantined', 'cause') ORDER BY seq`);
  const versions = db.prepare(`SELECT version_ref AS versionRef, substr(source_digest, 1, ${PREFIX}) AS source,
      substr(meaning_digest, 1, ${PREFIX}) AS meaning, substr(provenance_digest, 1, ${PREFIX}) AS provenance, policy_version AS policyVersion, date
    FROM retail_receipt_versions WHERE receipt_ref = ? ORDER BY version_ref`);
  return {
    code: 'retail-quarantine-listed', schema: 'present',
    receipts: refs.map((receiptRef) => {
      const evidence = retailEvidence(db, receiptRef);
      return {
        receiptRef,
        firstReason: evidence.firstReason!,
        causes: causes.all(receiptRef) as RetailQuarantineEntry['causes'],
        observations: evidence.observations.map(([ref]) => ref),
        held: evidence.held.map(([ref]) => ref),
        versions: versions.all(receiptRef) as RetailQuarantineEntry['versions'],
        canonicalVersion: evidence.canonicalVersion,
        evidenceDigest: retailEvidenceDigest(evidence),
      };
    }),
  };
}
