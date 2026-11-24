/**
 * The card cross-check's served read side (design v3.2 §1, §5–§8; PR-B, G3): the capture check (`metalsCardCapture`,
 * G1d's), the coverage proof with the card check's gap catalog (`metalsCoverageProof`) and the roster preview's binding
 * digests, computed once per read snapshot from cardCheckInputs.ts's inputs and mapped onto the served types.
 *
 * - **A one-sided diagnostic (§1).** The card check can show a card charge at a gold merchant that no captured order
 *   explains; it never shows that a purchase history is complete. Only the served proof is the headline's gate (b).
 * - **The roster reads `not-installed`.** The attestation table comes later (PR-C), and this build has no owner answer
 *   and keeps the owner-answer gate closed. So every scope with a need stays incomplete, carrying at least `roster` and
 *   `prefix`, and the headline keeps refusing with named gaps.
 * - **Once per snapshot (§8.3).** A data version's capture is computed once; its proof once per snapshot token and as-of
 *   day. A failure keeps only its type and code and is logged once. The card check then answers unavailable, never
 *   zero rows; the overview's proof is recomputed without the capture, so every scope and total reads `unavailable`.
 * - Nothing here writes or fetches: nothing leaves the host.
 */

import {
  METALS_CAPTURE_ALIASES,
  METALS_CAPTURE_ALIAS_POLICY,
  METALS_SOURCES,
  metalsBindingDigest,
  metalsBindingEvidence,
  metalsBindingKeyOf,
  metalsCardCapture,
  metalsCoverageProof,
  metalsLatestFactVersions,
  metalsRosterPreviewDigest,
  type MetalsBindingKey,
  type MetalsCardCaptureInput,
  type MetalsCardCaptureResult,
  type MetalsCoverageCatalog,
  type MetalsCoverageProofInput,
} from '@finance-tracker/shared/metals-ledger';
import type {
  MetalsCardCheck,
  MetalsCardCheckGroup,
  MetalsCardCheckStatus,
  MetalsCoverageProof,
  MetalsRosterPreview,
  MetalsRosterPreviewBinding,
} from '@finance-tracker/shared/metals-api';

import { errorTypeAndCode } from '../dbErrors.js';
import {
  metalsCaptureAccounts,
  metalsCaptureHolds,
  metalsCaptureLedgerOrders,
  metalsCaptureRows,
  metalsCardHistory,
  metalsProofRecords,
  metalsReadSnapshot,
  metalsStatedCoverage,
  type MetalsCardCheckSource,
  type MetalsImportedAccount,
} from './cardCheckInputs.js';
import { metalsSourceOfKey, type MetalsLedgerGraph } from './ledger.js';
import type { MetalsLedgerSnapshot } from './source.js';
import type { MetalsViews } from './views.js';

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Why the card check, or the overview's proof, can't be served: answered as the fixed, value-free `unavailable`. */
export class MetalsCardCheckUnavailable extends Error {
  constructor() {
    super('card-check-unavailable');
    this.name = 'MetalsCardCheckUnavailable';
  }
}

/** The roster as this build reads it: no attestation table, so no answer, and the owner-answer gate closed. */
export const METALS_ROSTER_NOT_INSTALLED: MetalsCoverageProofInput['roster'] = Object.freeze({ installed: false, asking: false, stored: null });

/**
 * The capture check's input (§3.1–§3.3): the ledger's buy orders with card funding facts, each by its admission alone,
 * and one competitor per order key not in the ledger, at the fact-version its latest listing names (C2 a); the open
 * held records; posted purchases and credits; every card account; the bindings links read; the imported accounts and
 * the stated coverage.
 */
export function metalsCaptureInput(graph: MetalsLedgerGraph, check: MetalsCardCheckSource): MetalsCardCaptureInput {
  const versions = check.competitors.filter((competitor) => metalsSourceOfKey(competitor.orderKey) !== null && !graph.orders.has(competitor.orderKey));
  const competitors = metalsLatestFactVersions(versions, check.listings).map((competitor) => ({
    orderKey: competitor.orderKey, source: metalsSourceOfKey(competitor.orderKey)!, channel: competitor.channel, date: competitor.date,
    admission: competitor.admission, active: true,
  }));
  return {
    orders: [...metalsCaptureLedgerOrders(graph), ...competitors],
    holds: metalsCaptureHolds(graph),
    rows: metalsCaptureRows(graph, check.reads),
    accounts: metalsCaptureAccounts(graph),
    bindings: check.bindings,
    importedAccounts: check.reads.importedAccounts.map(({ accountId, source }) => ({ accountId, source })),
    coverage: metalsStatedCoverage(graph),
  };
}

/**
 * The imported accounts a snapshot's proof reads: as read beside the graph, or, when those reads failed (the proof is
 * then unavailable), the graph's own accounts, none retired since the tripwire refuses any retirement.
 */
function importedAccountsOf(snapshot: MetalsLedgerSnapshot): MetalsImportedAccount[] {
  return 'failed' in snapshot.check
    ? [...snapshot.graph.accounts.values()].map((account) => ({ ...account, retired: false }))
    : snapshot.check.reads.importedAccounts;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; failed: string };

interface Proved {
  token: string;
  proof: MetalsCoverageProof;
  catalog: MetalsCoverageCatalog;
}

/** Proofs kept per snapshot, at most: one per as-of day asked of it, normally today's. */
const PROOFS_KEPT = 32;

/** One snapshot's card check: its capture, once, and its proofs, once per snapshot token and as-of day. */
export class MetalsCardCheckState {
  private captured: Outcome<MetalsCardCaptureResult> | null = null;
  private readonly proofs = new Map<string, Outcome<Proved>>();
  private readonly logged = new Set<string>();

  constructor(private readonly snapshot: MetalsLedgerSnapshot, private readonly log: (line: string) => void) {}

  /** The snapshot token of this data version on a New York day (§8.3). */
  token(day: string): string {
    return metalsReadSnapshot({ dataVersion: this.snapshot.version, aliasPolicy: METALS_CAPTURE_ALIAS_POLICY, day });
  }

  /** The capture of this snapshot, computed once, or why it failed: its reads, or the rule. */
  capture(): Outcome<MetalsCardCaptureResult> {
    if (this.captured === null) {
      const check = this.snapshot.check;
      if ('failed' in check) this.captured = this.failed(`reads ${check.failed}`);
      else {
        try {
          this.captured = { ok: true, value: metalsCardCapture(metalsCaptureInput(this.snapshot.graph, check)) };
        } catch (error) {
          this.captured = this.failed(`capture ${errorTypeAndCode(error)}`);
        }
      }
    }
    return this.captured;
  }

  /**
   * The card check's capture, proof and catalog as of `asOf` on `day`'s token. Unavailable (`MetalsCardCheckUnavailable`)
   * when the capture or the proof failed: the card check never answers without its catalog.
   */
  cardCheck(views: MetalsViews, asOf: string, day: string): Proved & { capture: MetalsCardCaptureResult } {
    const capture = this.capture();
    if (!capture.ok) throw new MetalsCardCheckUnavailable();
    const proved = this.proved(views, asOf, day, capture.value);
    if (!proved.ok) throw new MetalsCardCheckUnavailable();
    return { ...proved.value, capture: capture.value };
  }

  /**
   * The overview's proof as of `asOf`: with the capture; else (the capture or that proof failed) without it, so every
   * scope and total reads `unavailable` and carries `card-check`. Unavailable when that fails too: an overview never
   * answers without a proof.
   */
  overviewProof(views: MetalsViews, asOf: string, day: string): MetalsCoverageProof {
    const capture = this.capture();
    const proved = capture.ok ? this.proved(views, asOf, day, capture.value) : null;
    if (proved?.ok) return proved.value.proof;
    const unavailable = this.proved(views, asOf, day, null);
    if (!unavailable.ok) throw new MetalsCardCheckUnavailable();
    return unavailable.value.proof;
  }

  /** The proof as of `asOf` with or without the capture, computed once per snapshot token and as-of day. */
  private proved(views: MetalsViews, asOf: string, day: string, capture: MetalsCardCaptureResult | null): Outcome<Proved> {
    const token = this.token(day);
    const key = JSON.stringify([capture === null ? 'without-capture' : 'with-capture', token, asOf]);
    let outcome = this.proofs.get(key);
    if (outcome === undefined) {
      try {
        const graph = this.snapshot.graph;
        const input: MetalsCoverageProofInput = {
          snapshot: token, asOf, today: day, sources: METALS_SOURCES, importedAccounts: importedAccountsOf(this.snapshot),
          coverage: metalsStatedCoverage(graph), records: metalsProofRecords(views, asOf), capture, roster: METALS_ROSTER_NOT_INSTALLED,
          cardHistory: 'failed' in this.snapshot.check ? [] : metalsCardHistory(graph, this.snapshot.check.reads),
        };
        outcome = { ok: true, value: { token, ...metalsCoverageProof(input) } };
      } catch (error) {
        outcome = this.failed(`${capture === null ? 'unavailable proof' : 'proof'} ${errorTypeAndCode(error)}`);
      }
      if (this.proofs.size >= PROOFS_KEPT) this.proofs.clear();
      this.proofs.set(key, outcome);
    }
    return outcome;
  }

  /** A served answer built from this snapshot's check: a failure is logged once by its type and code, and answers unavailable. */
  serve<T>(what: string, build: () => T): T {
    try {
      return build();
    } catch (error) {
      if (error instanceof MetalsCardCheckUnavailable) throw error;
      this.failed(`${what} ${errorTypeAndCode(error)}`);
      throw new MetalsCardCheckUnavailable();
    }
  }

  /** A failure, logged once per snapshot by its type and code only. */
  private failed(reason: string): { ok: false; failed: string } {
    if (!this.logged.has(reason)) {
      this.logged.add(reason);
      this.log(`[metals] card check unavailable: ${reason}`);
    }
    return { ok: false, failed: reason };
  }
}

const states = new WeakMap<MetalsLedgerSnapshot, MetalsCardCheckState>();

/** The card check of a snapshot: one per data version, kept as long as the read model keeps the snapshot. */
export function metalsCardCheckState(snapshot: MetalsLedgerSnapshot, log: (line: string) => void): MetalsCardCheckState {
  let state = states.get(snapshot);
  if (state === undefined) states.set(snapshot, (state = new MetalsCardCheckState(snapshot, log)));
  return state;
}

/** A group's display name: the source for a mixed group, else the name its key carries. */
export function metalsCardGroupLabel(group: string): string {
  if (group === 'costco') return 'Costco';
  if (group === 'walmart') return 'Walmart';
  const at = group.indexOf(':');
  return at < 0 ? group : group.slice(at + 1);
}

const STATUSES: readonly MetalsCardCheckStatus[] = ['explained', 'possible-aggregate', 'held', 'outside-coverage', 'no-capture-match'];
const counts = <S extends string>(statuses: readonly S[]) => Object.fromEntries(statuses.map((status) => [status, 0])) as Record<S, number>;

/**
 * The card check (§8.1) from one snapshot's capture and catalog. Every in-scope purchase row is counted in its group by
 * status; every one but the explained is listed with the catalog entries it cites; credits are listed only.
 */
export function metalsCardCheckView(input: {
  capture: MetalsCardCaptureResult;
  proof: MetalsCoverageProof;
  catalog: MetalsCoverageCatalog;
  token: string;
  asOf: string;
  views: MetalsViews;
}): MetalsCardCheck {
  const { capture, catalog, views } = input;
  const groups = new Map<string, MetalsCardCheckGroup>();
  const groupOf = (group: string, scope: MetalsCardCheckGroup['scope'], source: MetalsCardCheckGroup['source']) => {
    let entry = groups.get(group);
    if (entry === undefined) {
      entry = {
        group, label: metalsCardGroupLabel(group), scope, source, exemption: null, purchases: counts(STATUSES), credits: 0, rows: [], creditRows: [],
      };
      groups.set(group, entry);
    }
    return entry;
  };
  for (const row of capture.rows) {
    const entry = groupOf(row.group, row.scope, row.source);
    entry.purchases[row.status] += 1;
    if (row.status === 'explained') continue;
    entry.rows.push({
      rowId: row.rowId, date: row.date, amountMinor: row.amountMinor, account: views.cardAccountView(row.accountId), status: row.status,
      reasons: [...row.reasons], gapIds: [...(catalog.rowGaps.get(row.rowId) ?? [])],
    });
  }
  for (const credit of capture.credits) {
    const entry = groupOf(credit.group, credit.scope, metalsCardGroupSource(credit.group, capture));
    entry.credits += 1;
    entry.creditRows.push({
      rowId: credit.rowId, date: credit.date, amountMinor: credit.amountMinor, account: views.cardAccountView(credit.accountId), status: 'listed',
      reason: 'no-refund-evidence-contract',
    });
  }
  return {
    installed: true,
    rule: capture.rule,
    aliasPolicy: capture.aliasPolicy,
    snapshot: input.token,
    asOf: input.asOf,
    gaps: catalog.gaps,
    groups: [...groups.values()].sort((a, b) => compareText(a.group, b.group)),
    outOfScope: { ...capture.outOfScope },
    unchecked: capture.unchecked.map((entry) => ({ ...entry })),
    cardHistory: catalog.cardHistory.map((entry) => ({ account: views.cardAccountView(entry.accountId), unsynced: entry.unsynced.map((range) => ({ ...range })) })),
    limits: [...input.proof.limits],
  };
}

/** A group's source, as its purchase rows name it; for a group of credits only, the source its key names (a mixed group, or an alias's). */
function metalsCardGroupSource(group: string, capture: MetalsCardCaptureResult): MetalsCardCheckGroup['source'] {
  const purchase = capture.rows.find((row) => row.group === group);
  if (purchase !== undefined) return purchase.source;
  if (group === 'costco' || group === 'walmart') return group;
  return group.startsWith('alias:') ? METALS_CAPTURE_ALIASES.find((alias) => `alias:${alias.id}` === group)?.source ?? null : null;
}

/**
 * The roster preview (§6.5, §7.4): the imported accounts per supported source, and every binding with evidence (a key
 * with at least one non-explained in-scope purchase row: one with none can't be answered), each with its row count, its
 * rows per capture status (display only) and its evidence digest; and the preview digest over the bindings' keys, row
 * counts and digests and the imported accounts. The rows themselves are the card check's, at the same snapshot.
 */
export function metalsRosterPreviewView(input: {
  capture: MetalsCardCaptureResult;
  importedAccounts: readonly MetalsImportedAccount[];
  token: string;
}): MetalsRosterPreview {
  const accounts = input.importedAccounts.map(({ accountId, source, retired }) => ({ accountId, source, retired }));
  const evidence = new Map<MetalsBindingKey, MetalsRosterPreviewBinding['statuses']>();
  for (const row of input.capture.rows) {
    if (row.status === 'explained') continue;
    const key = metalsBindingKeyOf(row);
    if (key === null) continue;
    const statuses = evidence.get(key) ?? counts(STATUSES.filter((status): status is Exclude<MetalsCardCheckStatus, 'explained'> => status !== 'explained'));
    statuses[row.status] += 1;
    evidence.set(key, statuses);
  }
  const bindings = [...evidence.entries()].sort(([a], [b]) => compareText(a, b)).map(([key, statuses]) => {
    const bound = metalsBindingEvidence(input.capture, key, accounts);
    const shown = Object.values(statuses).reduce((total, count) => total + count, 0);
    // The rule's evidence and this listing count the same rows, or nothing is served.
    if (bound.rows !== shown) throw new RangeError('metals roster preview: a binding\'s evidence and its listed rows differ');
    return { key, rows: bound.rows, statuses, digest: metalsBindingDigest(bound) };
  });
  return {
    installed: true,
    snapshot: input.token,
    importedAccounts: METALS_SOURCES.map((source) => ({
      source,
      accounts: input.importedAccounts.filter((account) => account.source === source)
        .map(({ accountId, label, retired }) => ({ accountId, label, retired })),
    })),
    bindings: bindings satisfies MetalsRosterPreviewBinding[],
    digest: metalsRosterPreviewDigest({ bindings: bindings.map(({ key, rows, digest }) => ({ key, rows, digest })), importedAccounts: accounts }),
  };
}
