import { useEffect, useMemo, useRef, useState } from 'react';
import { isOwnerApiError, type CardSyncOwnerClient } from './ownerClient';
import type { OwnerSync } from './useOwnerSync';

export interface UnsettledCommit {
  observationSetId: string;
  previewId: string;
}

export interface CommitSettlement {
  /** A plan was sent for commit but its answer never came: watch its set until Holdr's own record says what happened. */
  watch: (commit: UnsettledCommit) => void;
  /** The commit's answer did arrive: stop watching it. */
  forget: (previewId: string) => void;
}

/** How often watched sets are read, besides every refresh of Holdr's state. */
const CHECK_MS = 5_000;
/** A read that hasn't answered by then stops holding its commit's turn; a later answer from it is ignored. */
const READ_TIMEOUT_MS = 30_000;
/** Plans last 10 minutes; past this Holdr's record of one can no longer change, so watching it ends. */
const GIVE_UP_MS = 15 * 60_000;

interface Watched extends UnsettledCommit {
  since: number;
  /** The read on its way for this commit, if any; each read has its own number. */
  reading: number | null;
  /** Asked to read again while a read was on its way. */
  again: boolean;
}

/**
 * The watch list behind useCommitSettlement. Every watched commit has its own
 * turn: at most one read of its set at a time, a request to check again while
 * one is on its way runs right after it, and nothing one commit waits for can
 * hold up another. An answer counts only for the read that is still current
 * for a commit that is still watched (not forgotten, expired or timed out).
 */
export class CommitWatcher {
  private readonly entries = new Map<string, Watched>();
  private reads = 0;
  private alive = true;

  constructor(
    private readonly reader: () => CardSyncOwnerClient | null,
    private readonly onLedgerChanged: () => void,
    private readonly onCount: (count: number) => void,
    private readonly clock: { now: () => number; after: (ms: number, run: () => void) => void } = {
      now: () => Date.now(),
      after: (ms, run) => { setTimeout(run, ms); },
    },
  ) {}

  get size(): number {
    return this.entries.size;
  }

  start(): void {
    this.alive = true;
  }

  stop(): void {
    this.alive = false;
  }

  watch(commit: UnsettledCommit): void {
    let entry = this.entries.get(commit.previewId);
    if (!entry) {
      entry = { observationSetId: commit.observationSetId, previewId: commit.previewId, since: this.clock.now(), reading: null, again: false };
      this.entries.set(commit.previewId, entry);
      this.onCount(this.entries.size);
    }
    this.read(entry);
  }

  forget(previewId: string): void {
    if (this.entries.delete(previewId)) this.onCount(this.entries.size);
  }

  checkAll(): void {
    for (const entry of [...this.entries.values()]) this.read(entry);
  }

  /** Ends the watches past the limit, whatever their reads are doing, and has Spending read again. */
  expireOverdue(): void {
    const now = this.clock.now();
    const overdue = [...this.entries.values()].filter((entry) => now - entry.since > GIVE_UP_MS);
    if (overdue.length === 0) return;
    for (const entry of overdue) this.entries.delete(entry.previewId);
    this.onCount(this.entries.size);
    if (this.alive) this.onLedgerChanged();
  }

  private current(entry: Watched, read: number): boolean {
    return this.entries.get(entry.previewId) === entry && entry.reading === read;
  }

  private read(entry: Watched): void {
    const client = this.reader();
    if (!client || !this.alive) return;
    if (entry.reading !== null) {
      entry.again = true;
      return;
    }
    const read = ++this.reads;
    entry.reading = read;
    entry.again = false;
    const finish = (settled: boolean | null) => {
      if (!this.current(entry, read)) return;
      entry.reading = null;
      if (!this.alive) return;
      if (settled === true) {
        this.forget(entry.previewId);
        this.onLedgerChanged();
      } else if (entry.again) {
        this.read(entry);
      }
    };
    // A read that never answers frees the turn instead of holding it. Only the set's own fields are read (its plan's
    // state): one request even for a set of thousands of items, so the 30 seconds bound a single answer, not a whole set.
    this.clock.after(READ_TIMEOUT_MS, () => finish(null));
    client.getSetSummary(entry.observationSetId).then(
      (set) => finish(!(set.plan !== null && set.plan.previewId === entry.previewId && set.plan.state === 'valid')),
      (error: unknown) => finish(isOwnerApiError(error) && error.status === 404),
    );
  }
}

/**
 * Commits whose answer was lost (plan §6.4), watched above the review dialog
 * for as long as the Spending tab is open, so closing the dialog or switching
 * areas doesn't lose them. Watched sets are read whenever Holdr's state is
 * read again and every few seconds, until Holdr shows that plan committed or
 * no longer able to commit (another plan, expired, the set gone). Then
 * Spending's figures and lists are read again: a commit Holdr finished late
 * shows up without a reload. A slow answer is always used; a read that never
 * answers stops blocking after 30 seconds, and the 15-minute limit is applied
 * by the timer, so nothing one commit waits for holds up another.
 */
export function useCommitSettlement(sync: OwnerSync, onLedgerChanged: () => void): CommitSettlement {
  const [count, setCount] = useState(0);
  const client = useRef(sync.client);
  client.current = sync.client;
  const ledgerChanged = useRef(onLedgerChanged);
  ledgerChanged.current = onLedgerChanged;
  const [watcher] = useState(() => new CommitWatcher(() => client.current, () => ledgerChanged.current(), setCount));

  useEffect(() => {
    watcher.start();
    return () => watcher.stop();
  }, [watcher]);

  const { revision } = sync;
  useEffect(() => {
    watcher.checkAll();
  }, [revision, watcher]);

  const watching = count > 0;
  useEffect(() => {
    if (!watching) return undefined;
    const timer = setInterval(() => {
      watcher.expireOverdue();
      watcher.checkAll();
    }, CHECK_MS);
    return () => clearInterval(timer);
  }, [watching, watcher]);

  return useMemo(() => ({
    watch: (commit: UnsettledCommit) => watcher.watch(commit),
    forget: (previewId: string) => watcher.forget(previewId),
  }), [watcher]);
}
