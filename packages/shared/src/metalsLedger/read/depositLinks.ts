/**
 * `METALS_DEPOSIT_LINK_RULE` v1 ('metals-deposit-link-v1', design v8 §4.4.5): a sale's payout ↔ a checking deposit.
 *
 * - Binding first: a payout destination (source, last 4) reaches a checking account only through an approved, active
 *   binding for that source; a binding for another source never matches.
 * - Subjects: complete ACH payouts in USD of a sell order that passes proof eligibility (active, unquarantined).
 * - Candidates: the bound account's usable USD credits of the payout's amount to the cent, posted within
 *   [payout date, payout date + 5 days]. Only a credit that names the payout's own source's reviewed origin text
 *   (`originSources`, from METALS_PAYOUT_DESCRIPTORS) can prove a link; an amount-and-date match alone is a possible
 *   deposit, never a link.
 * - The account's imported coverage must include every day of the window, else `not-covered`, never "none found".
 * - One each way over all payouts: every complete or pending payout contests the credits naming its own source's
 *   origin that it could account for, on its account scope (its active binding's account; otherwise every account
 *   showing its destination's last 4, and, if its binding drifted, its last bound account while it exists, since that
 *   account's last 4 may have changed (C4, as metalsCardLinks); with no last 4, every account), in its window (a
 *   pending one from the day it was initiated, since the capture can be older than the bank data) or, undated, at any
 *   date, even when it can't prove a link itself (pending, unbound, drifted, undated, not covered or quarantined).
 *   Coverage and binding gate a payout's own proof, never the competition it adds. A failed payout moved no money and
 *   contests nothing.
 *
 * Only proof links classify a credit as asset-sale proceeds (metalsDepositEvidence); candidates classify nothing.
 *
 * Pure: no file system, network or clock.
 */

import type { MetalsPayoutStatus, MetalsSource } from '../model.js';

export const METALS_DEPOSIT_LINK_RULE = 'metals-deposit-link-v1' as const;
export const METALS_DEPOSIT_WINDOW_DAYS = 5;

export interface MetalsPayoutSubject {
  payoutKey: string;
  saleOrderKey: string;
  /** The sell order's source: a destination is bound per (source, last 4). */
  source: MetalsSource;
  amountMinor: number;
  /** When the dealer initiated it: a pending payout contests credits from this day on. */
  initiatedDate: string | null;
  payoutDate: string | null;
  destinationLast4: string | null;
  status: MetalsPayoutStatus;
  /** The sale's version is active and the order is not quarantined (§4.2). */
  active: boolean;
}

export interface MetalsCheckingRow {
  id: string;
  accountId: string;
  date: string;
  /** Positive for a credit. */
  amountMinor: number;
  kind: 'credit' | 'debit';
  currency: string;
  usable: boolean;
  /**
   * The sources whose reviewed payout origin text its description names; [] when it names none. A list, since one
   * processor's name can serve two dealers: then both sources' payouts contest it, one each way.
   */
  originSources: readonly MetalsSource[];
}

/** An approved binding of a payout destination (source, last 4) to one checking account; `suspended` when it drifted. */
export interface MetalsCheckingBinding {
  source: MetalsSource;
  last4: string;
  accountId: string;
  state: 'active' | 'suspended';
}

/** A checking account and the last 4 it shows, or null when it shows none: an unbound payout's possible accounts. */
export interface MetalsCheckingAccount {
  id: string;
  last4: string | null;
}

/** A checking account's imported coverage: the days it has complete data for. */
export interface MetalsCheckingCoverage {
  accountId: string;
  from: string;
  to: string;
}

export const METALS_DEPOSIT_LINK_STATES = [
  'linked', 'ineligible', 'possible', 'ambiguous', 'no-candidate', 'not-covered', 'not-complete', 'date-unknown',
  'binding-missing', 'binding-drift',
] as const;
export type MetalsDepositLinkState = (typeof METALS_DEPOSIT_LINK_STATES)[number];

export interface MetalsDepositLink {
  payoutKey: string;
  saleOrderKey: string;
  rule: typeof METALS_DEPOSIT_LINK_RULE;
  state: MetalsDepositLinkState;
  /** The linked credit (proof), or the one credit an ineligible or possible match points at (a candidate only). */
  rowId: string | null;
  /**
   * With an active binding and a complete payout: the bound account's compatible credits in the window (at any date when
   * undated), shown for audit, including those of a payout that is not covered; otherwise none.
   */
  candidates: string[];
  proof: boolean;
}

export interface MetalsDepositEvidence {
  rowId: string;
  classification: 'asset-sale-proceeds';
  saleKey: string;
  payoutKey: string;
}

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Whether the ranges cover every day from `from` to `to`, both inclusive. */
function covers(ranges: readonly MetalsCheckingCoverage[], from: string, to: string): boolean {
  let next = from;
  const sorted = [...ranges].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  for (const range of sorted) {
    if (range.from > next) break;
    if (range.to >= next) next = addDays(range.to, 1);
    if (next > to) return true;
  }
  return next > to;
}

/** Computes every deposit link of the ledger at once. */
export function metalsDepositLinks(input: {
  payouts: readonly MetalsPayoutSubject[];
  rows: readonly MetalsCheckingRow[];
  accounts: readonly MetalsCheckingAccount[];
  bindings: readonly MetalsCheckingBinding[];
  coverage: readonly MetalsCheckingCoverage[];
}): { links: MetalsDepositLink[]; evidence: MetalsDepositEvidence[] } {
  interface Pending {
    link: MetalsDepositLink;
    origin: string[];
  }
  const last4ByAccount = new Map(input.accounts.map((account) => [account.id, account.last4]));
  const pending: Pending[] = [];
  const wanted = new Map<string, number>();
  /** A credit proves, and is contested by, only payouts of a source whose reviewed origin text it names. */
  const namesOwnSource = (row: MetalsCheckingRow, payout: MetalsPayoutSubject) => row.originSources.includes(payout.source);
  for (const payout of input.payouts) {
    const link: MetalsDepositLink = {
      payoutKey: payout.payoutKey, saleOrderKey: payout.saleOrderKey, rule: METALS_DEPOSIT_LINK_RULE, state: 'no-candidate',
      rowId: null, candidates: [], proof: false,
    };
    const entry: Pending = { link, origin: [] };
    pending.push(entry);
    const binding = payout.destinationLast4 === null
      ? undefined
      : input.bindings.find((candidate) => candidate.source === payout.source && candidate.last4 === payout.destinationLast4);
    const bound = binding?.state === 'active' ? binding : undefined;
    // C4: a drifted binding's last bound account, while it exists, whatever last 4 it shows now.
    const drifted = binding !== undefined && bound === undefined && last4ByAccount.has(binding.accountId) ? binding.accountId : null;
    const from = payout.payoutDate;
    const to = from === null ? null : addDays(from, METALS_DEPOSIT_WINDOW_DAYS);
    /** A credit of the payout's amount from `start` through the window's end, or at any date when the payout has none. */
    const fits = (row: MetalsCheckingRow, start: string | null) => row.usable && row.kind === 'credit' && row.currency === 'USD'
      && row.amountMinor === payout.amountMinor && (to === null || (row.date >= start! && row.date <= to));
    const compatible = (row: MetalsCheckingRow) => fits(row, from);
    if (payout.status !== 'failed') {
      // A pending payout may already have landed, since the capture can be older than the bank data: it contests from
      // the day it was initiated. A failed payout moved no money and contests nothing.
      const start = payout.status === 'pending' && payout.initiatedDate !== null && from !== null && payout.initiatedDate < from
        ? payout.initiatedDate
        : from;
      const inScope = bound !== undefined
        ? (accountId: string) => accountId === bound.accountId
        : payout.destinationLast4 !== null
          ? (accountId: string) => accountId === drifted || last4ByAccount.get(accountId) === payout.destinationLast4
          : () => true;
      for (const row of input.rows) {
        if (namesOwnSource(row, payout) && fits(row, start) && inScope(row.accountId)) wanted.set(row.id, (wanted.get(row.id) ?? 0) + 1);
      }
    }
    if (bound === undefined) {
      link.state = binding ? 'binding-drift' : 'binding-missing';
      continue;
    }
    if (payout.status !== 'complete') {
      link.state = 'not-complete';
      continue;
    }
    const candidates = input.rows.filter((row) => compatible(row) && row.accountId === bound.accountId);
    link.candidates = candidates.map((row) => row.id);
    if (from === null) {
      link.state = 'date-unknown';
      continue;
    }
    if (!covers(input.coverage.filter((range) => range.accountId === bound.accountId), from, to!)) {
      link.state = 'not-covered';
      continue;
    }
    const origin = candidates.filter((row) => namesOwnSource(row, payout)).map((row) => row.id);
    entry.origin = origin;
    if (origin.length === 0) {
      link.state = candidates.length === 0 ? 'no-candidate' : 'possible';
      if (candidates.length === 1) link.rowId = candidates[0].id;
      continue;
    }
    link.state = origin.length === 1 ? (payout.active ? 'linked' : 'ineligible') : 'ambiguous';
    if (origin.length === 1) link.rowId = origin[0];
  }
  const evidence: MetalsDepositEvidence[] = [];
  for (const { link, origin } of pending) {
    if (origin.length === 1 && (wanted.get(origin[0]) ?? 0) > 1) {
      link.state = 'ambiguous';
      link.rowId = null;
    }
    link.proof = link.state === 'linked';
    if (link.proof) {
      evidence.push({ rowId: link.rowId!, classification: 'asset-sale-proceeds', saleKey: link.saleOrderKey, payoutKey: link.payoutKey });
    }
  }
  return { links: pending.map((entry) => entry.link), evidence };
}
