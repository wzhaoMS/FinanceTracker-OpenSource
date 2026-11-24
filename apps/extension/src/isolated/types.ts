/**
 * What an adapter provides to the generic ISOLATED collector. Everything
 * here runs in the isolated world of an approved issuer page.
 */
import type { CardSyncIssuer, CardSyncMode, CardSyncReadContractId, CardSyncSource, ProjectedBankBatchV1, ProjectedBankBatchValidation } from '@finance-tracker/shared';
import type { Budget, CollectorCode, PageState } from '../contracts/messages.js';
import type { StreamContext } from '../projection/stream.js';
import type { BankReadContract, BankReader } from './bankRead.js';

export interface CollectorIdentity {
  readonly id: string;
  readonly label: string;
  readonly issuer: CardSyncIssuer;
  readonly source: CardSyncSource;
  readonly mode: CardSyncMode;
  readonly parserVersion: string;
  readonly pageOrigin: string;
  readonly pagePaths: readonly string[];
  readonly discoveryContract: CardSyncReadContractId;
  readonly transactionsContract: CardSyncReadContractId;
  /** True when batches come from the MAIN observer over the bridge. */
  readonly usesMainObserver: boolean;
}

export interface ReadIo {
  readonly reader: BankReader;
  readonly stream: StreamContext;
  readonly budget: Budget;
  readonly signal: AbortSignal;
}

/** A server's Retry-After, when a read stopped on a 429: the worker pauses the issuer at least this long. */
export interface RetryAfter {
  readonly retryAfterMs?: number | null;
}

export type DiscoverOutcome = { ok: true; batch: ProjectedBankBatchV1 } | ({ ok: false; code: CollectorCode } & RetryAfter);
/** A read keeps what it got before stopping: `code` names why it stopped early, the batch says how far it went. */
export type ReadOutcome = ({ ok: true; batch: ProjectedBankBatchV1; code: CollectorCode | null } & RetryAfter) | ({ ok: false; code: CollectorCode } & RetryAfter);

export interface DomIo {
  readonly stream: StreamContext;
  readonly signal: AbortSignal;
  emit(result: ProjectedBankBatchValidation): void;
}

export interface IsolatedAdapter {
  readonly identity: CollectorIdentity;
  /** From the rendered page only (no network): is the activity view ready, is this a login page? */
  pageState(doc: Document, location: Location): PageState;
  /** isolated-read: the adapter's fixed bank read contracts. */
  readonly readContracts?: readonly BankReadContract[];
  discover?(io: ReadIo): Promise<DiscoverOutcome>;
  readAccount?(io: ReadIo, accountRef: string, window: { start: string; end: string }): Promise<ReadOutcome>;
  /** dom-passive: watch the rendered activity and emit cumulative snapshots until the signal aborts. */
  watch?(io: DomIo): void;
}
