/**
 * The ISOLATED collector's store of projected batches for one document
 * (contract section 10a). ISOLATED re-validates every batch (layer 2), keeps
 * the transaction batches of its stream, and merges the batches that carry
 * one account candidate with `mergeProjectedBatches`, whose result is
 * validated again and is authoritative. Which batches count depends on the
 * adapter's mode:
 *
 * - `main-passive`: a batch is one observed response and is incremental. The
 *   producer never sends a page twice (contract §10a: rows without a stable
 *   id are kept as sent), so every batch counts; identical rows with a
 *   stable id are kept once by the merge.
 * - `isolated-read` and `dom-passive`: a batch is a complete read (or a
 *   cumulative rendered snapshot) of its accounts and supersedes their
 *   earlier batches.
 *
 * A batch that cannot be merged is refused and not kept. An identity
 * conflict (the same issuer id with other content) blocks every capture from
 * this page until it is reloaded. A batch from another stream is accepted
 * only as the start (sequence 0) of a new stream, which discards everything;
 * older or repeated sequences are stale and dropped. After a capture of an
 * account is frozen, the batches it was built from stop counting (`release`
 * with the build's watermark); batches that arrived since stay.
 */
import {
  mergeProjectedBatches,
  type CardSyncIssue,
  type CardSyncMode,
  type ProjectedAccountCandidate,
  type ProjectedBankBatchV1,
  type ProjectedBankBatchValidation,
} from '@finance-tracker/shared';
import type { AccountSummary, GroupSummary } from '../contracts/messages.js';

export const STORE_MAX_ACCOUNTS = 20;

interface KeptBatch {
  /** Arrival number, from 1. */
  readonly n: number;
  readonly batch: ProjectedBankBatchV1;
  /** The candidates the batch has rows or coverage for. */
  readonly refs: ReadonlySet<string>;
}

export type AcceptResult =
  | { ok: true; reset: boolean; added: number }
  | { ok: false; code: 'stale-stream' | 'identity-conflict' | 'unexpected-response' | 'projection-refused'; issues: CardSyncIssue[] };

function carried(batch: ProjectedBankBatchV1): Set<string> {
  return new Set([...batch.transactions.map((row) => row.accountRef), ...batch.coverage.map((entry) => entry.accountRef)]);
}

const STALE: AcceptResult = { ok: false, code: 'stale-stream', issues: [] };

export class StreamStore {
  private boundStream: string | null = null;
  private lastSequence = -1;
  /** Handles of streams this store has left behind: their late messages are always stale. */
  private readonly retired = new Set<string>();
  private readonly candidates = new Map<string, ProjectedAccountCandidate>();
  private kept: KeptBatch[] = [];
  private arrivals = 0;
  /** Per account: batches with an arrival number up to this no longer count for it (superseded or released). */
  private readonly through = new Map<string, number>();
  private readonly merged = new Map<string, ProjectedBankBatchValidation>();
  private conflict = false;

  constructor(readonly mode: CardSyncMode) {}

  get conflicted(): boolean {
    return this.conflict;
  }

  get streamHandle(): string | null {
    return this.boundStream;
  }

  /** The arrival number of the newest batch kept: a build's watermark. */
  get arrivalCount(): number {
    return this.arrivals;
  }

  /** Forgets everything; the current stream (if any) is retired. */
  reset(): void {
    if (this.boundStream !== null) {
      this.retired.add(this.boundStream);
      if (this.retired.size > 64) this.retired.delete(this.retired.values().next().value as string);
    }
    this.boundStream = null;
    this.lastSequence = -1;
    this.candidates.clear();
    this.kept = [];
    this.arrivals = 0;
    this.through.clear();
    this.merged.clear();
    this.conflict = false;
  }

  hasAccount(ref: string): boolean {
    return this.candidates.has(ref);
  }

  /** The batches that count for one account, in arrival order. */
  private batchesFor(ref: string): ProjectedBankBatchV1[] {
    const since = this.through.get(ref) ?? 0;
    return this.kept.filter((item) => item.n > since && item.refs.has(ref)).map((item) => item.batch);
  }

  /** The merge of one account's batches (validated again by the merge), or null when none counts. */
  mergedFor(ref: string): ProjectedBankBatchValidation | null {
    const cached = this.merged.get(ref);
    if (cached) return cached;
    const batches = this.batchesFor(ref);
    if (batches.length === 0) return null;
    const result = mergeProjectedBatches(batches);
    this.merged.set(ref, result);
    return result;
  }

  /**
   * The account's batches up to `upTo` (the watermark of the build that was
   * frozen) stop counting; batches that arrived after the build stay for the
   * next capture.
   */
  release(ref: string, upTo: number = this.arrivals): void {
    this.through.set(ref, Math.max(this.through.get(ref) ?? 0, Math.min(upTo, this.arrivals)));
    this.merged.delete(ref);
    this.collect();
  }

  /** Drops batches that no longer count for any account they carry. */
  private collect(): void {
    this.kept = this.kept.filter((item) => [...item.refs].some((ref) => item.n > (this.through.get(ref) ?? 0)));
  }

  accept(batch: ProjectedBankBatchV1, transactionsContract: boolean): AcceptResult {
    let reset = false;
    if (this.retired.has(batch.streamHandle)) return STALE;
    if (this.boundStream !== batch.streamHandle) {
      if (this.boundStream !== null && batch.sequence !== 0) return STALE;
      if (this.boundStream !== null) {
        this.reset();
        reset = true;
      }
      this.boundStream = batch.streamHandle;
    }
    if (batch.sequence <= this.lastSequence) return STALE;
    const newRefs = batch.accounts.filter((account) => !this.candidates.has(account.ref)).length;
    if (this.candidates.size + newRefs > STORE_MAX_ACCOUNTS) return { ok: false, code: 'unexpected-response', issues: [] };

    if (!transactionsContract) {
      for (const candidate of batch.accounts) this.candidates.set(candidate.ref, { ...candidate });
      this.lastSequence = batch.sequence;
      return { ok: true, reset, added: 0 };
    }

    const refs = carried(batch);

    // Keep the batch tentatively, merge every account it carries, and undo on refusal.
    const superseded = new Map<string, number | undefined>();
    if (this.mode !== 'main-passive') {
      for (const ref of refs) {
        superseded.set(ref, this.through.get(ref));
        this.through.set(ref, this.arrivals);
      }
    }
    this.arrivals += 1;
    this.kept.push({ n: this.arrivals, batch, refs });
    const results = new Map<string, ProjectedBankBatchValidation>();
    for (const ref of refs) {
      const result = mergeProjectedBatches(this.batchesFor(ref));
      if (!result.ok) {
        this.kept.pop();
        this.arrivals -= 1;
        for (const [key, value] of superseded) {
          if (value === undefined) this.through.delete(key);
          else this.through.set(key, value);
        }
        const conflict = result.issues.some((issue) => issue.code === 'identity-conflict');
        if (conflict) this.conflict = true;
        return { ok: false, code: conflict ? 'identity-conflict' : 'projection-refused', issues: result.issues };
      }
      results.set(ref, result);
    }
    for (const candidate of batch.accounts) this.candidates.set(candidate.ref, { ...candidate });
    for (const [ref, result] of results) this.merged.set(ref, result);
    this.collect();
    this.lastSequence = batch.sequence;
    return { ok: true, reset, added: batch.transactions.length };
  }

  /** Row-free summaries for the worker and the trusted popup. */
  summaries(): AccountSummary[] {
    const result: AccountSummary[] = [];
    for (const candidate of this.candidates.values()) {
      const merged = this.mergedFor(candidate.ref);
      const batch = merged?.ok ? merged.batch : null;
      const rows = batch ? batch.transactions.filter((row) => row.accountRef === candidate.ref) : [];
      const coverage = batch ? batch.coverage.filter((entry) => entry.accountRef === candidate.ref) : [];
      const groups = new Map<string, GroupSummary>();
      for (const row of rows) {
        const key = `${row.holderRef ?? '-'} ${row.cardLast4 ?? '-'}`;
        const group = groups.get(key) ?? {
          holderRef: row.holderRef,
          cardLast4: row.cardLast4,
          pending: 0,
          posted: 0,
          firstDate: row.transactionDate,
          lastDate: row.transactionDate,
        };
        if (row.status === 'pending') group.pending += 1;
        else group.posted += 1;
        if (row.transactionDate < group.firstDate) group.firstDate = row.transactionDate;
        if (row.transactionDate > group.lastDate) group.lastDate = row.transactionDate;
        groups.set(key, group);
      }
      const posted = coverage.find((entry) => entry.status === 'posted');
      const pending = coverage.find((entry) => entry.status === 'pending');
      const lead = posted ?? pending ?? null;
      result.push({
        ref: candidate.ref,
        last4: candidate.last4,
        productHint: candidate.productHint,
        pending: rows.filter((row) => row.status === 'pending').length,
        posted: rows.filter((row) => row.status === 'posted').length,
        rejected: Math.min(batch?.rejectedCount ?? 0, 2_000),
        pageCount: Math.max(posted?.pageCount ?? 0, pending?.pageCount ?? 0),
        termination: lead ? lead.termination : null,
        completeness: lead ? lead.completeness : null,
        groups: [...groups.values()].slice(0, 60),
      });
    }
    return result;
  }
}
