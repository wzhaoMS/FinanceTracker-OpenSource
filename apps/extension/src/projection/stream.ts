/**
 * One projected stream on one document (contract §6, §10): a page-issued
 * `stm_` handle, message sequence numbers from 0, and page-local refs for
 * accounts (`cnd_`) and cardholder groups (`hld_`). The issuer keys behind
 * the refs (account tokens, account ids, cardholder names) stay in the world
 * that created the stream and are never put in any message.
 *
 * The stream also keeps the card hints its text is prepared against: every
 * candidate last four and row `cardLast4` seen so far. Preparing with more
 * hints only redacts more, so text prepared with the stream's hints also
 * passes a batch's (or a merge's) narrower check.
 */
import { newCardSyncId } from '../common/ids.js';
import { isoTimestamp } from './project.js';

/** More hints than candidates and rows can show are ignored (the validator caps a batch's row hints at 20). */
const MAX_HINTS = 64;

export interface StreamContext {
  readonly streamHandle: string;
  nextSequence(): number;
  candidateRef(issuerKey: string): string;
  holderRef(holderKey: string): string;
  observedAt(): string;
  /** Adds last fours (anything else is ignored) to the stream's card hints. */
  noteHints(values: Iterable<string | null>): void;
  hints(): string[];
  /**
   * Page identity for passive producers (contract §10a: a projector never
   * sends a page twice). `key` is page-local (a candidate ref and the page's
   * position), never sent anywhere.
   */
  pageSeen(key: string): boolean;
  notePage(key: string): void;
  /** A new stream (navigation, logout, account switch): new handle, sequence 0, fresh refs, hints and pages. */
  restart(): void;
}

/** Pages remembered per stream; a page past this many is treated as already sent. */
const MAX_PAGES = 500;

export function createStream(): StreamContext {
  let handle = newCardSyncId('stream');
  let sequence = 0;
  let candidates = new Map<string, string>();
  let holders = new Map<string, string>();
  let hints = new Set<string>();
  let pages = new Set<string>();
  return {
    get streamHandle() {
      return handle;
    },
    nextSequence: () => sequence++,
    candidateRef(key) {
      let ref = candidates.get(key);
      if (!ref) {
        ref = newCardSyncId('accountCandidate');
        candidates.set(key, ref);
      }
      return ref;
    },
    holderRef(key) {
      let ref = holders.get(key);
      if (!ref) {
        ref = newCardSyncId('holderGroup');
        holders.set(key, ref);
      }
      return ref;
    },
    observedAt: () => isoTimestamp(Date.now()),
    noteHints(values) {
      for (const value of values) {
        if (hints.size >= MAX_HINTS) return;
        if (typeof value === 'string' && /^[0-9]{4}$/.test(value)) hints.add(value);
      }
    },
    hints: () => [...hints],
    pageSeen: (key) => pages.has(key) || pages.size >= MAX_PAGES,
    notePage(key) {
      if (pages.size < MAX_PAGES) pages.add(key);
    },
    restart() {
      handle = newCardSyncId('stream');
      sequence = 0;
      candidates = new Map();
      holders = new Map();
      hints = new Set();
      pages = new Set();
    },
  };
}
