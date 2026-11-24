/**
 * `METALS_CARD_CAPTURE_RULE` v1 ('metals-card-capture-v1', card cross-check design v3.2 §2–§5; G1d C1–C4): every card
 * charge at a gold merchant either has a captured order that explains it or keeps its reason. A capture-only
 * association: never a card link, an approved binding, asset proof or spending proof (ruling 2), and no result of it
 * reaches any of them.
 *
 * - Rows: usable USD rows only, purchases and credits apart, classed by the shared recognizers read-only. Gold-only: a
 *   bullion dealer in any channel (`dealer:`, or the generic bullion-word `merchant:` group), and the capture-only
 *   `unresolved:` (processor) and `alias:` groups, matched in that order, only on rows of no class or of that generic
 *   group. Mixed online: Costco's and Walmart's online classes, channel not `store`. Anything else is counted only.
 * - Occurrences: every captured order, metal or not, one per order key at its active fact-version (C2 (a)), read by the
 *   engine metalsCardLinks reads (cardGraph.ts, C1): each single-charge card tender a subject, contesting as itself; an
 *   aggregate a barrier up to its cap; an open hold a barrier at any amount. An order's role comes from its admission
 *   alone: being metal, or held for metals, never matters (C2 (b)).
 * - Identity first (§2.4, C4): an active binding's account, else the one account showing the suffix with no
 *   conflicting issuer network. Anything else explains nothing and contests every account showing the suffix (every
 *   account without a last 4); a drifted binding contests its last bound account too.
 * - A row is explained when exactly one subject wants it, that subject is active, resolved and has exactly that one
 *   candidate, and no other occurrence contests it and no barrier covers it. Nothing is consumed greedily.
 * - Credits are listed only: no refund evidence contract admits a match (§4).
 *
 * Pure: no file system, network or clock.
 */

import {
  cardMetalsMerchantClass,
  cardRefundSeller,
  cardSellerChannel,
  type CardMetalsMerchantClass,
} from '../../cardSpendingExclusions.js';
import type { MetalsCardCheckReason, MetalsCardCheckStatus } from '../../metalsApi.js';
import {
  METALS_SETTLEMENT_WINDOW_DAYS,
  type MetalsAdmissionFacts,
  type MetalsChannel,
  type MetalsNetwork,
  type MetalsSource,
  type MetalsTender,
} from '../model.js';
import { metalsCardGraph, type MetalsCardGraphRow, type MetalsCardIdentity, type MetalsCardOccurrence } from './cardGraph.js';
import type { MetalsCardBinding } from './cardLinks.js';
import { metalsCoverageOf, type MetalsStatedCoverage } from './coverage.js';

export const METALS_CARD_CAPTURE_RULE = 'metals-card-capture-v1' as const;
export const METALS_CAPTURE_ALIAS_POLICY = 'metals-capture-alias-v1' as const;
/** R5: empty until a governed review admits a rule; COLLECTPURE → collectpure is the only candidate. */
export const METALS_CAPTURE_ALIASES: ReadonlyArray<{ id: string; source: MetalsSource; token: RegExp }> = Object.freeze([]);
/** Processors are never aliases: rows naming one form `unresolved:<id>`. */
export const METALS_CAPTURE_PROCESSORS: ReadonlyArray<{ id: string; pattern: RegExp }> =
  Object.freeze([Object.freeze({ id: 'pm-technologies', pattern: /\bPM ?TECHNOLOGIES\b/ })]);

export interface MetalsCaptureOrder {
  /** Unique: a duplicate throws (C2 (a): one per order key, at its active fact-version; see metalsLatestFactVersions). */
  orderKey: string;
  source: MetalsSource;
  channel: MetalsChannel;
  date: string;
  /** Its role comes from metalsAdmission alone: being metal, or held for metals, never matters (C2 (b)). */
  admission: MetalsAdmissionFacts;
  /** Its version is active and the order isn't quarantined. */
  active: boolean;
}

/** An open held record; an order held for metals is an ordinary order here (C2 (b)). */
export interface MetalsCaptureHold {
  source: MetalsSource;
  channel: MetalsChannel;
  date: string | null;
}

export interface MetalsCaptureCardRow {
  id: string;
  accountId: string;
  date: string;
  /** A purchase's amount is positive; a credit's as stored. */
  amountMinor: number;
  kind: 'purchase' | 'credit';
  currency: string;
  /** Posted, and not dismissed, removed or merged. */
  usable: boolean;
  merchant: string | null;
  description: string;
}

/** A card account Holdr holds, any status. */
export interface MetalsCaptureCardAccount {
  id: string;
  /** Lowercase issuer slug: `amex` and `discover` imply their network. */
  issuer: string;
  last4: string | null;
  status: string;
}

export interface MetalsCardCaptureInput {
  orders: readonly MetalsCaptureOrder[];
  holds: readonly MetalsCaptureHold[];
  rows: readonly MetalsCaptureCardRow[];
  accounts: readonly MetalsCaptureCardAccount[];
  /** metalsCardLinks' bindings: `suspended` when drifted. */
  bindings: readonly MetalsCardBinding[];
  /** The source accounts imported (ledger accounts), and the complete coverage, for the mixed-row label only. */
  importedAccounts: ReadonlyArray<{ accountId: string; source: MetalsSource }>;
  coverage: readonly MetalsStatedCoverage[];
}

export type MetalsCaptureScope = 'gold-only' | 'mixed-online';

export interface MetalsCaptureOutOfScope {
  warehouse: number;
  samsClub: number;
  store: number;
  unclassed: number;
}

export interface MetalsCardCaptureRow {
  rowId: string;
  accountId: string;
  date: string;
  amountMinor: number;
  /** The shared class, read-only: null for an alias or processor row the shared classifier gives none. */
  merchantClass: CardMetalsMerchantClass | null;
  group: string;
  scope: MetalsCaptureScope;
  /** The source that should explain it: a mixed group's, an alias's; null for a dealer or a processor. */
  source: MetalsSource | null;
  status: MetalsCardCheckStatus;
  /** Primary first, then the rest, in MetalsCardCheckReason's order; none when explained. */
  reasons: MetalsCardCheckReason[];
  explainedBy: string | null;
}

export interface MetalsCardCaptureCredit {
  rowId: string;
  accountId: string;
  date: string;
  amountMinor: number;
  group: string;
  scope: MetalsCaptureScope;
}

export interface MetalsCardCaptureResult {
  rule: typeof METALS_CARD_CAPTURE_RULE;
  aliasPolicy: typeof METALS_CAPTURE_ALIAS_POLICY;
  /** Every in-scope usable USD purchase row, by row id. */
  rows: MetalsCardCaptureRow[];
  /** Every in-scope usable USD credit, by row id: listed only, never matched (status `listed`, no-refund-evidence-contract). */
  credits: MetalsCardCaptureCredit[];
  /** Usable USD purchases out of scope, per reason. */
  outOfScope: MetalsCaptureOutOfScope;
  /** Single-charge occurrences whose card couldn't be checked, per source with any, by source. */
  unchecked: Array<{ source: MetalsSource; cardNotInHoldr: number; identityAmbiguous: number }>;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Folded exactly as cardSpendingExclusions' classText: upper case, marks and apostrophes removed, any other mark a space. */
function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().replace(/['\u2019\u2018`]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ').trim();
}

/** Whether a token matches whole tokens of folded text: from its start or a space, to its end or a space. */
function wholeToken(token: RegExp, text: string): boolean {
  const pattern = new RegExp(token.source, token.flags.includes('g') ? token.flags : `${token.flags}g`);
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (match[0].length > 0 && (start === 0 || text[start - 1] === ' ') && (end === text.length || text[end] === ' ')) return true;
  }
  return false;
}

/** A row's capture group, its scope and source, or why it is out of scope. */
export type MetalsCaptureGrouping =
  | { inScope: true; merchantClass: CardMetalsMerchantClass | null; group: string; scope: MetalsCaptureScope; source: MetalsSource | null }
  | { inScope: false; merchantClass: CardMetalsMerchantClass | null; outOfScope: keyof MetalsCaptureOutOfScope };

/**
 * A row's capture group (§2.2–§2.3): the shared class, seller and channel, read-only; then, only on a row of no class or
 * of the generic bullion-word `merchant:` group, a processor before an alias, never over a named `dealer:` group.
 * metalsCardCapture always reads METALS_CAPTURE_ALIASES; `aliases` lets tests exercise the matcher.
 */
export function metalsCaptureGroup(row: { merchant: string | null; description: string },
  aliases: ReadonlyArray<{ id: string; source: MetalsSource; token: RegExp }> = METALS_CAPTURE_ALIASES): MetalsCaptureGrouping {
  const merchantClass = cardMetalsMerchantClass(row);
  if (merchantClass === 'costco-warehouse') return { inScope: false, merchantClass, outOfScope: 'warehouse' };
  if (merchantClass === 'sams-club') return { inScope: false, merchantClass, outOfScope: 'samsClub' };
  if (merchantClass === 'costco-online' || merchantClass === 'walmart-online') {
    if (cardSellerChannel(row.description) === 'store') return { inScope: false, merchantClass, outOfScope: 'store' };
    const source = merchantClass === 'costco-online' ? 'costco' : 'walmart';
    return { inScope: true, merchantClass, group: source, scope: 'mixed-online', source };
  }
  const seller = merchantClass === 'bullion-dealer' ? cardRefundSeller(row).merchant : null;
  if (seller !== null && seller.startsWith('dealer:')) return { inScope: true, merchantClass, group: seller, scope: 'gold-only', source: null };
  const texts = [row.merchant, row.description].filter((text): text is string => typeof text === 'string' && text.length > 0).map(fold);
  const processor = METALS_CAPTURE_PROCESSORS.find((entry) => texts.some((text) => entry.pattern.test(text)));
  if (processor) return { inScope: true, merchantClass, group: `unresolved:${processor.id}`, scope: 'gold-only', source: null };
  const alias = aliases.find((entry) => texts.some((text) => wholeToken(entry.token, text)));
  if (alias) return { inScope: true, merchantClass, group: `alias:${alias.id}`, scope: 'gold-only', source: alias.source };
  if (seller !== null) return { inScope: true, merchantClass, group: seller, scope: 'gold-only', source: null };
  return { inScope: false, merchantClass, outOfScope: 'unclassed' };
}

/**
 * C2 (a): one version per order key, the one whose facts the latest import listing the key names (highest `importSeq`;
 * at a tie, the greatest digest). A key no listing names, or whose named facts have no version, is dropped. By order key.
 */
export function metalsLatestFactVersions<T extends { orderKey: string; factsDigest: string }>(versions: readonly T[],
  listings: ReadonlyArray<{ orderKey: string; factsDigest: string; importSeq: number }>): T[] {
  const latest = new Map<string, { factsDigest: string; importSeq: number }>();
  for (const listing of listings) {
    const kept = latest.get(listing.orderKey);
    if (kept === undefined || listing.importSeq > kept.importSeq
      || (listing.importSeq === kept.importSeq && listing.factsDigest > kept.factsDigest)) {
      latest.set(listing.orderKey, { factsDigest: listing.factsDigest, importSeq: listing.importSeq });
    }
  }
  const chosen = new Map<string, T>();
  for (const version of versions) {
    if (chosen.has(version.orderKey) || latest.get(version.orderKey)?.factsDigest !== version.factsDigest) continue;
    chosen.set(version.orderKey, version);
  }
  return [...chosen.values()].sort((a, b) => compareText(a.orderKey, b.orderKey));
}

type CaptureIdentityReason = 'binding-drift' | 'identity-ambiguous' | 'card-not-in-holdr';
type Occurrence = MetalsCardOccurrence<MetalsCaptureOrder, CaptureIdentityReason>;

/** The network an issuer implies, when it implies one. */
const impliedNetwork = (issuer: string): MetalsNetwork | null => (issuer === 'amex' || issuer === 'discover' ? issuer : null);

/** A tender's identity (§2.4, C4): only `resolved` gives a candidate account; contests use the broader set. */
function identityOf(input: MetalsCardCaptureInput, source: MetalsSource, method: MetalsTender): MetalsCardIdentity<CaptureIdentityReason> {
  const last4 = method.last4;
  if (last4 === null) return { inScope: () => true, account: null, reason: 'identity-ambiguous' };
  const shown = input.accounts.filter((account) => account.last4 === last4);
  const showing = new Set(shown.map((account) => account.id));
  const binding = input.bindings.find((entry) => entry.source === source && entry.network === method.network && entry.last4 === last4);
  if (binding?.state === 'active') return { inScope: (accountId) => accountId === binding.accountId, account: binding.accountId, reason: null };
  if (binding) {
    // C4: its last bound account, while it still exists, and every account showing the suffix.
    const bound = input.accounts.some((account) => account.id === binding.accountId) ? binding.accountId : null;
    return { inScope: (accountId) => accountId === bound || showing.has(accountId), account: null, reason: 'binding-drift' };
  }
  const inScope = (accountId: string) => showing.has(accountId);
  if (shown.length === 1) {
    const implied = impliedNetwork(shown[0].issuer);
    if (implied === null || method.network === 'unknown' || method.network === implied) return { inScope, account: shown[0].id, reason: null };
    return { inScope, account: null, reason: 'card-not-in-holdr' };
  }
  return { inScope, account: null, reason: shown.length === 0 ? 'card-not-in-holdr' : 'identity-ambiguous' };
}

/** Computes the capture association of the whole ledger at once (§3), and every in-scope row's status (§5). */
export function metalsCardCapture(input: MetalsCardCaptureInput): MetalsCardCaptureResult {
  const seenOrders = new Set<string>();
  for (const order of input.orders) {
    if (seenOrders.has(order.orderKey)) throw new RangeError('metalsCardCapture: an order is listed twice');
    seenOrders.add(order.orderKey);
  }
  const seenRows = new Set<string>();
  for (const row of input.rows) {
    if (seenRows.has(row.id)) throw new RangeError('metalsCardCapture: a row is listed twice');
    seenRows.add(row.id);
  }

  // Every usable USD purchase reaches the engine with its class (candidates are class-based, §3.4); in-scope ones get a status.
  const outOfScope: MetalsCaptureOutOfScope = { warehouse: 0, samsClub: 0, store: 0, unclassed: 0 };
  const purchases: MetalsCardGraphRow[] = [];
  const inScope: Array<{ row: MetalsCardGraphRow; grouping: Extract<MetalsCaptureGrouping, { inScope: true }> }> = [];
  const credits: MetalsCardCaptureCredit[] = [];
  for (const row of input.rows) {
    if (!row.usable || row.currency !== 'USD') continue;
    const grouping = metalsCaptureGroup(row);
    if (row.kind === 'credit') {
      if (grouping.inScope) {
        credits.push({ rowId: row.id, accountId: row.accountId, date: row.date, amountMinor: row.amountMinor, group: grouping.group, scope: grouping.scope });
      }
      continue;
    }
    if (row.kind !== 'purchase') continue;
    const graphRow: MetalsCardGraphRow = {
      id: row.id, accountId: row.accountId, date: row.date, amountMinor: row.amountMinor, kind: 'purchase', currency: 'USD', usable: true,
      merchantClass: grouping.merchantClass,
    };
    purchases.push(graphRow);
    if (grouping.inScope) inScope.push({ row: graphRow, grouping });
    else outOfScope[grouping.outOfScope] += 1;
  }

  const graph = metalsCardGraph<MetalsCaptureOrder, MetalsCardGraphRow, CaptureIdentityReason>({
    orders: input.orders, held: input.holds, rows: purchases, isSubject: () => true,
    identify: (source: MetalsSource, method: MetalsTender) => identityOf(input, source, method),
  });
  const candidates = new Map<string, MetalsCardGraphRow[]>();
  const wanting = new Map<string, Occurrence[]>();
  for (const subject of graph.subjects) {
    const rows = graph.candidatesOf(subject);
    candidates.set(subject.id, rows);
    for (const row of rows) wanting.set(row.id, [...(wanting.get(row.id) ?? []), subject]);
  }
  const candidateCount = (subject: Occurrence) => candidates.get(subject.id)?.length ?? 0;

  // The mixed label (§5.1): inside only when every imported account of the source covers [t − 30, t] online.
  const labelInside = (source: MetalsSource, date: string) => {
    const accounts = input.importedAccounts.filter((account) => account.source === source);
    const from = addDays(date, -METALS_SETTLEMENT_WINDOW_DAYS.online);
    return accounts.length > 0 && accounts.every((account) =>
      metalsCoverageOf(input.coverage, { accountId: account.accountId, kind: 'online', from, to: date }).missing.length === 0);
  };

  const rows: MetalsCardCaptureRow[] = [];
  for (const { row, grouping } of inScope) {
    const subjects = wanting.get(row.id) ?? [];
    let held = false;
    let aggregate = false;
    for (const barrier of graph.barriers) {
      if (!graph.bars(barrier, row)) continue;
      if (barrier.held) held = true;
      else aggregate = true;
    }
    const covering = graph.contesters.filter((occurrence) => graph.covers(occurrence, row));
    const [only] = subjects;
    const explained = subjects.length === 1 && only.order.active && only.identity.reason !== 'binding-drift' && candidateCount(only) === 1
      && !graph.contested(row, only.id) && !held && !aggregate;
    const reasons: MetalsCardCheckReason[] = [];
    if (aggregate) reasons.push('aggregate');
    if (held) reasons.push('held-record');
    if (subjects.some((subject) => !subject.order.active) || covering.some((occurrence) => !occurrence.order.active)) reasons.push('source-quarantined');
    if (covering.some((occurrence) => occurrence.identity.reason === 'binding-drift')) reasons.push('binding-drift');
    if (covering.some((occurrence) => occurrence.identity.reason === 'identity-ambiguous')) reasons.push('identity-ambiguous');
    if (subjects.some((subject) => graph.contested(row, subject.id))) reasons.push('contested');
    if (subjects.some((subject) => candidateCount(subject) >= 2)) reasons.push('ambiguous');
    if (grouping.group.startsWith('unresolved:')) reasons.push('alias-unresolved');
    let status: MetalsCardCheckStatus;
    if (explained) status = 'explained';
    else if (held || aggregate) status = 'possible-aggregate';
    else if (reasons.length > 0) status = 'held';
    else {
      status = grouping.scope === 'mixed-online' && grouping.source !== null && labelInside(grouping.source, row.date) ? 'no-capture-match' : 'outside-coverage';
      reasons.push(status);
    }
    rows.push({
      rowId: row.id, accountId: row.accountId, date: row.date, amountMinor: row.amountMinor, merchantClass: grouping.merchantClass,
      group: grouping.group, scope: grouping.scope, source: grouping.source, status, reasons,
      explainedBy: explained ? only.id : null,
    });
  }

  const unchecked = new Map<MetalsSource, { cardNotInHoldr: number; identityAmbiguous: number }>();
  for (const subject of graph.subjects) {
    const reason = subject.identity.reason;
    if (reason !== 'card-not-in-holdr' && reason !== 'identity-ambiguous') continue;
    const counts = unchecked.get(subject.order.source) ?? { cardNotInHoldr: 0, identityAmbiguous: 0 };
    if (reason === 'card-not-in-holdr') counts.cardNotInHoldr += 1;
    else counts.identityAmbiguous += 1;
    unchecked.set(subject.order.source, counts);
  }
  return {
    rule: METALS_CARD_CAPTURE_RULE,
    aliasPolicy: METALS_CAPTURE_ALIAS_POLICY,
    rows: rows.sort((a, b) => compareText(a.rowId, b.rowId)),
    credits: credits.sort((a, b) => compareText(a.rowId, b.rowId)),
    outOfScope,
    unchecked: [...unchecked.entries()].sort(([a], [b]) => compareText(a, b)).map(([source, counts]) => ({ source, ...counts })),
  };
}
