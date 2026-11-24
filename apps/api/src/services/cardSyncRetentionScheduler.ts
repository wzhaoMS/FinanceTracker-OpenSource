import type { CardSyncRetentionReport } from './cardSync/retention.js';
import { errorTypeAndCode } from './dbErrors.js';

/**
 * Card sync's retention schedule (E1b design §10 items 5 and 23, §5.9):
 * `runCardSyncRetention` at startup and every 10 minutes, called again while
 * it reports `done: false`. Each call is one bounded IMMEDIATE transaction
 * (default `budgetMs` 50, the same as retention's own default); the next
 * call waits for the event loop, so requests are served between calls, and
 * its progress lives in the data, so two processes (or a restart) simply
 * continue each other's work (C30). A call's commit leaves its frames in the
 * WAL; before the first call and after every call, in a turn of its own, the
 * repository copies the WAL back (a PASSIVE checkpoint), so neither step runs
 * long (O100). Retention writes only when the WAL has no frames left to copy
 * back: a call that finds frames a reader still needs (or another connection
 * committing) writes nothing and reports `deferred`. That call, like a
 * checkpoint that cannot finish, ends the pass, logged as
 * `checkpoint-incomplete`. The fence is the repository's and lives in the
 * database, so a later pass, a restart or another process waits the same
 * way, and retention's frames waiting to be copied back never exceed one
 * call's. That bounds the copy-back work, not the WAL file's length.
 * Nothing waits for it to enforce a deadline: every view already presents a
 * set past `expires_at` as expired (Q46). When a call reports
 * `auditCutoffAhead`, the value-free code `audit-cutoff-ahead` is logged once
 * for that call and nothing else changes. A failed call or checkpoint (a busy
 * database included) ends the pass; the next tick tries again.
 */

export const CARD_SYNC_RETENTION_INTERVAL_MS = 10 * 60 * 1000;
export const CARD_SYNC_RETENTION_CALL_BUDGET_MS = 50;
/** A pass stops after this many calls even if work remains; the next tick continues (a bound, never reached in practice). */
export const CARD_SYNC_RETENTION_MAX_CALLS = 10_000;

export interface CardSyncRetentionPass {
  /** The calls that ran; a deferred call (it wrote nothing) is not one. */
  calls: number;
  done: boolean;
  failed: boolean;
  auditCutoffAhead: number;
}

export interface CardSyncRetentionSchedulerOptions {
  repo: {
    runCardSyncRetention(input: { budgetMs?: number }): CardSyncRetentionReport;
    checkpointAfterCardSyncRetention(): { complete: boolean };
  };
  intervalMs?: number;
  budgetMs?: number;
  maxCallsPerPass?: number;
  log?: (line: string) => void;
  /** Test seams; default to the timers. */
  setInterval?: (run: () => void, ms: number) => { unref?: () => unknown };
  clearInterval?: (handle: unknown) => void;
  yieldToEventLoop?: () => Promise<void>;
}

export interface CardSyncRetentionScheduler {
  /** Starts a pass now unless one is running; resolves with the pass this call started or joined. */
  runNow(): Promise<CardSyncRetentionPass>;
  stop(): void;
}

export function startCardSyncRetention(options: CardSyncRetentionSchedulerOptions): CardSyncRetentionScheduler {
  const { repo } = options;
  const intervalMs = options.intervalMs ?? CARD_SYNC_RETENTION_INTERVAL_MS;
  const budgetMs = options.budgetMs ?? CARD_SYNC_RETENTION_CALL_BUDGET_MS;
  const maxCalls = options.maxCallsPerPass ?? CARD_SYNC_RETENTION_MAX_CALLS;
  const log = options.log ?? ((line: string) => console.warn(line));
  const yieldToEventLoop = options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  let stopped = false;
  let running: Promise<CardSyncRetentionPass> | null = null;

  async function pass(): Promise<CardSyncRetentionPass> {
    const result: CardSyncRetentionPass = { calls: 0, done: false, failed: false, auditCutoffAhead: 0 };
    // the WAL is copied back in a turn of its own before the first call and after every call (O100)
    await yieldToEventLoop();
    if (stopped || !copyBack(result)) return result;
    while (!stopped && result.calls < maxCalls) {
      await yieldToEventLoop();
      let report: CardSyncRetentionReport;
      try {
        report = repo.runCardSyncRetention({ budgetMs });
      } catch (error) {
        result.failed = true;
        log(`[card-sync] retention call failed: ${errorTypeAndCode(error)}`);
        break;
      }
      if (report.deferred) {
        log('[card-sync] retention: checkpoint-incomplete');
        break;
      }
      result.calls += 1;
      if (report.auditCutoffAhead) {
        result.auditCutoffAhead += 1;
        log('[card-sync] retention: audit-cutoff-ahead');
      }
      await yieldToEventLoop();
      const copied = copyBack(result);
      if (result.failed) break;
      if (report.done) {
        result.done = true;
        break;
      }
      if (!copied) break;
    }
    return result;
  }

  /** The repository's PASSIVE checkpoint; false ends the pass: it failed, or it could not finish (a reader still needs frames). */
  function copyBack(result: CardSyncRetentionPass): boolean {
    let checkpoint: { complete: boolean };
    try {
      checkpoint = repo.checkpointAfterCardSyncRetention();
    } catch (error) {
      result.failed = true;
      log(`[card-sync] retention checkpoint failed: ${errorTypeAndCode(error)}`);
      return false;
    }
    if (!checkpoint.complete) log('[card-sync] retention: checkpoint-incomplete');
    return checkpoint.complete;
  }

  function runNow(): Promise<CardSyncRetentionPass> {
    if (running) return running;
    running = pass().finally(() => { running = null; });
    return running;
  }

  const tick = () => { void runNow(); };
  const handle = (options.setInterval ?? setInterval)(tick, intervalMs);
  handle.unref?.();
  void runNow();
  return {
    runNow,
    stop() {
      stopped = true;
      (options.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout)))(handle);
    },
  };
}
