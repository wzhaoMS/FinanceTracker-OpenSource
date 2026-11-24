/**
 * `METALS_CARD_LINK_RULE` v1 ('metals-card-link-v1', design v8 §4.4.4): card evidence ↔ a card row, the Amazon
 * matcher's pattern on the ledger's own subjects: binding first, then exact money, then one candidate each way, computed
 * once over the whole ledger, never per view. Every link names its evidence class and version.
 *
 * - Subjects: the card evidence its class admits (metalsAdmission) on a metal order's active version. Only a subject of
 *   an active, unquarantined order with an active binding can prove a link; any other is at most a candidate.
 * - Candidates: the bound account's usable USD purchase rows of the subject's merchant class, of its amount to the
 *   cent, dated in its window.
 * - Contests: every other subject, and every single-charge competitor (another order that settles in one charge),
 *   contests the rows of exactly its amount, in its interval, on its account scope (its binding's account; if unbound,
 *   every account with its last 4; if its binding drifted, those and its last bound account while it exists, since that
 *   account's last 4 may have changed (C4, as metalsCardCapture); with no last 4, every account).
 * - Barriers: an aggregate competitor (any other carded order) bars every row of its merchant class, on any account, in
 *   its interval, up to its cap from metalsAdmission: its gross total, or any amount when that is unknown or the
 *   funding contradicts itself; a dated held record bars every row of its class in its interval, an undated one every
 *   row of its class at any date. Barriers and contests are tested against each row's own date and account.
 * - A subject links only when it has exactly one candidate, no other subject or competitor contests that row, and no
 *   barrier covers it. Adding a competitor, a barrier, a conflict or another candidate row can only keep or remove a
 *   link, never create one.
 *
 * Pure: no file system, network or clock.
 */

import type { CardMetalsMerchantClass } from '../../cardSpendingExclusions.js';
import type {
  MetalsAdmissionFacts,
  MetalsChannel,
  MetalsEvidenceClass,
  MetalsNetwork,
  MetalsSource,
  MetalsTender,
} from '../model.js';
import { metalsCardGraph, type MetalsCardIdentity } from './cardGraph.js';

export { metalsMerchantClass } from './cardGraph.js';

export const METALS_CARD_LINK_RULE = 'metals-card-link-v1' as const;

/** A captured order with card funding, from the active version of its aggregate. */
export interface MetalsFundedOrder {
  orderKey: string;
  source: MetalsSource;
  channel: MetalsChannel;
  date: string;
  admission: MetalsAdmissionFacts;
  /** A metal order, whose admitted evidence is a subject; any other captured order is a competitor only. */
  metal: boolean;
  /** Its version is active and the order is not quarantined (§4.2). */
  active: boolean;
}

/** A held record: a barrier for its merchant class. */
export interface MetalsHeldOrder {
  source: MetalsSource;
  channel: MetalsChannel;
  date: string | null;
}

export interface MetalsCardRow {
  id: string;
  accountId: string;
  date: string;
  /** Positive for a purchase. */
  amountMinor: number;
  kind: 'purchase' | 'credit' | 'other';
  currency: string;
  /** Posted, and not dismissed, removed or merged. */
  usable: boolean;
  merchantClass: CardMetalsMerchantClass | null;
}

export interface MetalsCardAccount {
  id: string;
  last4: string | null;
}

/** An approved binding of a payment identity to one card account; `suspended` when it drifted (§7). */
export interface MetalsCardBinding {
  source: MetalsSource;
  network: MetalsNetwork;
  last4: string;
  accountId: string;
  state: 'active' | 'suspended';
}

export const METALS_CARD_LINK_STATES = [
  'linked', 'ineligible', 'ambiguous', 'no-candidate', 'competitor-unknown', 'competitor-held', 'binding-missing',
  'binding-drift',
] as const;
export type MetalsCardLinkState = (typeof METALS_CARD_LINK_STATES)[number];

export interface MetalsCardLink {
  /** `<order key>#<tender index>`. */
  subject: string;
  orderKey: string;
  tender: number;
  evidenceClass: MetalsEvidenceClass;
  rule: typeof METALS_CARD_LINK_RULE;
  amountMinor: number;
  state: MetalsCardLinkState;
  /** The linked row (proof) or, for `ineligible`, the one row it would take (a candidate only). */
  rowId: string | null;
  candidates: string[];
  proof: boolean;
}

export interface MetalsCardLinkGraph {
  links: MetalsCardLink[];
  /** Proof links only: row id → subject. */
  proofByRow: Map<string, string>;
}

/** Computes every card link of the ledger at once. */
export function metalsCardLinks(input: {
  orders: readonly MetalsFundedOrder[];
  held: readonly MetalsHeldOrder[];
  rows: readonly MetalsCardRow[];
  accounts: readonly MetalsCardAccount[];
  bindings: readonly MetalsCardBinding[];
}): MetalsCardLinkGraph {
  const seen = new Set<string>();
  for (const order of input.orders) {
    if (seen.has(order.orderKey)) throw new RangeError('metalsCardLinks: an order is listed twice');
    seen.add(order.orderKey);
  }
  const last4ByAccount = new Map(input.accounts.map((account) => [account.id, account.last4]));
  const bindingOf = (source: MetalsSource, network: MetalsNetwork, last4: string | null) =>
    last4 === null ? undefined : input.bindings.find((binding) => binding.source === source && binding.network === network && binding.last4 === last4);
  const scopeOf = (source: MetalsSource, network: MetalsNetwork, last4: string | null): ((accountId: string) => boolean) => {
    const binding = bindingOf(source, network, last4);
    if (binding?.state === 'active') return (accountId) => accountId === binding.accountId;
    // C4: a drifted binding's last bound account, while it exists, whatever last 4 it shows now.
    const bound = binding !== undefined && last4ByAccount.has(binding.accountId) ? binding.accountId : null;
    if (last4 !== null) return (accountId) => accountId === bound || last4ByAccount.get(accountId) === last4;
    return () => true;
  };
  // Candidates only on an active binding's account; contests on scopeOf's accounts.
  type Unbound = 'binding-missing' | 'binding-drift';
  const identify = (source: MetalsSource, method: MetalsTender): MetalsCardIdentity<Unbound> => {
    const inScope = scopeOf(source, method.network, method.last4);
    const binding = bindingOf(source, method.network, method.last4);
    if (binding?.state === 'active') return { inScope, account: binding.accountId, reason: null };
    return { inScope, account: null, reason: binding ? 'binding-drift' : 'binding-missing' };
  };
  const graph = metalsCardGraph<MetalsFundedOrder, MetalsCardRow, Unbound>({
    orders: input.orders, held: input.held, rows: input.rows, isSubject: (order) => order.metal, identify,
  });

  const links: MetalsCardLink[] = [];
  const proofByRow = new Map<string, string>();
  for (const subject of graph.subjects) {
    const base = {
      subject: subject.id, orderKey: subject.order.orderKey, tender: subject.evidence.tender, evidenceClass: subject.evidence.class,
      rule: METALS_CARD_LINK_RULE, amountMinor: subject.evidence.amountMinor,
    };
    const identity = subject.identity;
    if (identity.account === null) {
      links.push({ ...base, state: identity.reason, rowId: null, candidates: [], proof: false });
      continue;
    }
    const candidates = graph.candidatesOf(subject);
    const ids = candidates.map((row) => row.id);
    if (candidates.length !== 1) {
      links.push({ ...base, state: candidates.length === 0 ? 'no-candidate' : 'ambiguous', rowId: null, candidates: ids, proof: false });
      continue;
    }
    const [row] = candidates;
    const barrier = graph.barrierOn(row);
    if (barrier !== null || graph.contested(row, subject.id)) {
      links.push({ ...base, state: barrier ?? 'ambiguous', rowId: null, candidates: ids, proof: false });
      continue;
    }
    if (!subject.order.active) {
      links.push({ ...base, state: 'ineligible', rowId: row.id, candidates: ids, proof: false });
      continue;
    }
    links.push({ ...base, state: 'linked', rowId: row.id, candidates: ids, proof: true });
    proofByRow.set(row.id, subject.id);
  }
  return { links, proofByRow };
}
