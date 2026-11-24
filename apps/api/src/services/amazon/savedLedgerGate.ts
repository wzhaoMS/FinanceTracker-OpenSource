import type { Database } from 'better-sqlite3';
import { activeBindings, readCardInventory } from './bindings.js';
import { readLedger } from './matcher.js';
import { addDays, day, LEDGER_POLICY, LEDGER_POLICY_DIGEST, minor, opaque } from './policy.js';
import { splitRef, tipsDescriptor } from './tipSplit.js';
import type { Binding, LedgerRow, MatchResult, MatchSubject, Money } from './types.js';

/**
 * The saved-pages gate's ledger branch (design v2, 5b01e72f's design PASS eda8816a…; Root's path L). A saved order whose
 * charge neither its total nor its order part explains passes on `charge: 'ledger'` only when Amazon's own payments
 * ledger proves it: every completed single-order Charged observation naming the order is linked under LEDGER_POLICY to
 * its own card row, no other subject claims those rows, every observation matches the saved card and currency, and the
 * linked charges sum exactly to the saved total minus the saved tip. At most one observation of the tip's exact amount,
 * whose only would-be row is a single tips-class row, is the tip's own charge: it stays unlinked and deferred.
 * It infers nothing (no subset sum): POLICY, LEDGER_POLICY, TIP_SPLIT_POLICY, bindings and every match are unchanged.
 */
export const LEDGER_GATE_CODES = ['passed', 'ledger-total-ineligible', 'ledger-part-ineligible', 'ledger-other-evidence',
  'ledger-none', 'ledger-pending', 'ledger-multi-order', 'ledger-method', 'ledger-tip-ambiguous', 'ledger-unlinked',
  'ledger-shared-row', 'ledger-sum'] as const;
export type LedgerGateCode = typeof LEDGER_GATE_CODES[number];
/** One order's ledger branch, value-free: the first failing rule's code (or `passed`) and counts. */
export interface SavedGateLedger { code: LedgerGateCode; members: number; anchors: number; duplicates: number; tip: 0 | 1 }
/** What the branch reads once per gate: every subject (ledger ones derived as the matcher derives them), every stored
 * result, each card row's candidate subjects over BOTH candidate tables, and (lazily) the bindings and live ledger. */
export interface LedgerGateContext {
  subjects: readonly MatchSubject[];
  results: ReadonlyMap<string, MatchResult>;
  owners: ReadonlyMap<string, ReadonlySet<string>>;
  bindings: () => Binding[];
  rows: () => LedgerRow[];
}
export function ledgerGateContext(db: Database, subjects: readonly MatchSubject[]): LedgerGateContext {
  const results = new Map((db.prepare(`SELECT subject_ref,data_json FROM amazon_matches
    UNION ALL SELECT subject_ref,data_json FROM amazon_ledger_matches`).all() as Array<{ subject_ref: string; data_json: string }>)
    .map(r => [r.subject_ref, JSON.parse(r.data_json) as MatchResult]));
  const owners = new Map<string, Set<string>>();
  for (const c of db.prepare(`SELECT subject_ref,card_transaction_id FROM amazon_candidates
    UNION ALL SELECT subject_ref,card_transaction_id FROM amazon_ledger_candidates`).all() as
    Array<{ subject_ref: string; card_transaction_id: string }>) {
    const set = owners.get(c.card_transaction_id) ?? new Set<string>();
    set.add(c.subject_ref); owners.set(c.card_transaction_id, set);
  }
  let bindings: Binding[] | undefined, rows: LedgerRow[] | undefined;
  return { subjects, results, owners, bindings: () => (bindings ??= activeBindings(db, readCardInventory(db))),
    rows: () => (rows ??= readLedger(db)) };
}
/** The saved order's facts the branch reads. */
export interface LedgerGateOrder { orderId: string; total: Money; tip: number; network: string; last4: string }

/**
 * Whether the rows LEDGER_POLICY would otherwise consider for a charge observation (its bound card's live posted
 * purchases of its exact amount and currency, card date within [ledger date − 3, + 7]) are exactly one tips-class row.
 */
function soleTipsRow(ctx: LedgerGateContext, s: MatchSubject): boolean {
  if (s.method.kind !== 'card') return false;
  const bound = ctx.bindings().filter(b => b.network === s.method.network && b.last4 === s.method.last4);
  if (bound.length !== 1) return false;
  const from = addDays(s.date, -LEDGER_POLICY.daysBefore), through = addDays(s.date, LEDGER_POLICY.daysAfter);
  const rows = ctx.rows().filter(row => row.cardAccountId === bound[0].cardAccountId && row.status === 'posted'
    && row.kind === 'purchase' && row.currency === s.money.currency && minor(row.amountMinor)
    && row.amountMinor === s.money.amountMinor && day(row.transactionDate) && row.transactionDate >= from
    && row.transactionDate <= through);
  return rows.length === 1 && tipsDescriptor(rows[0].description);
}

/**
 * Design v2's rules 1–8, in order: the first failing rule names the code. The counts always describe the whole of S
 * (members, anchors, verified duplicates, and 1 where exactly one tip charge T qualifies), whichever rule fails.
 */
export function ledgerChargeProof(ctx: LedgerGateContext, o: LedgerGateOrder): SavedGateLedger {
  const orderRef = opaque('order', o.orderId);
  const result = (ref: string) => ctx.results.get(ref);
  // The ledger set S (rule 2): completed single-order Charged observations of this order.
  const naming = ctx.subjects.filter(s => s.evidenceClass === 'payment-ledger-complete' && s.orderRefs.includes(orderRef));
  const set = naming.filter(s => s.provenance === 'ledger-Charged' && s.status === 'completed' && s.orderRefs.length === 1);
  // Canonical charges (rule 3): anchors are linked unique under LEDGER_POLICY; a duplicate is only a verified
  // `corroborated` alias of an anchor in S. Nothing is set aside for merely carrying `corroboratedBy`.
  const anchors = set.filter(s => {
    const r = result(s.ref);
    return r?.state === 'linked' && r.reason === 'unique' && r.policyDigest === LEDGER_POLICY_DIGEST && !!r.cardTransactionId;
  });
  const anchorRefs = new Set(anchors.map(s => s.ref));
  const duplicates = set.filter(s => {
    const r = result(s.ref);
    return r?.state === 'held' && r.reason === 'corroborated' && !!r.corroboratedBy && anchorRefs.has(r.corroboratedBy);
  });
  const duplicateRefs = new Set(duplicates.map(s => s.ref));
  // The tip charge T (rule 5): a non-anchor of the tip's exact amount, held no-candidate, its only would-be row a tips row.
  const tips = o.tip > 0 ? set.filter(s => !anchorRefs.has(s.ref) && s.money.amountMinor === o.tip
    && result(s.ref)?.state === 'held' && result(s.ref)?.reason === 'no-candidate' && soleTipsRow(ctx, s)) : [];
  const tipCharge = tips.length === 1 ? tips[0] : undefined;
  const report = (code: LedgerGateCode): SavedGateLedger => ({ code, members: set.length, anchors: anchors.length,
    duplicates: duplicates.length, tip: tipCharge ? 1 : 0 });
  // 1. Eligibility: the total, and a tipped order's part, found no candidate at all; no native payment event names it.
  const total = result(opaque('order-total', o.orderId));
  if (total?.state !== 'held' || total.reason !== 'no-candidate' || total.candidateCount !== 0) return report('ledger-total-ineligible');
  if (o.tip > 0) {
    const part = result(splitRef(o.orderId, 'order'));
    if (part?.state !== 'held' || (part.reason !== 'no-candidate' && part.reason !== 'superseded') || part.candidateCount !== 0) {
      return report('ledger-part-ineligible');
    }
  }
  if (ctx.subjects.some(s => s.evidenceClass === 'payment-event' && s.orderRefs.includes(orderRef))) return report('ledger-other-evidence');
  // 2. S is not empty, and no pending, unknown-status or multi-order ledger observation names the order.
  if (!set.length) return report('ledger-none');
  if (naming.some(s => s.status !== 'completed')) return report('ledger-pending');
  if (naming.some(s => s.orderRefs.length !== 1)) return report('ledger-multi-order');
  // 4. Every member, the tip charge included, is on the saved card and in the saved currency.
  if (set.some(s => s.method.kind !== 'card' || s.method.network !== o.network || s.method.last4 !== o.last4
    || s.money.currency !== o.total.currency)) return report('ledger-method');
  // 5. At most one member qualifies as T.
  if (tips.length > 1) return report('ledger-tip-ambiguous');
  // 6. Every other member is an anchor or a verified duplicate of one; the anchors' rows are pairwise distinct.
  if (set.some(s => s !== tipCharge && !anchorRefs.has(s.ref) && !duplicateRefs.has(s.ref))) return report('ledger-unlinked');
  const anchorRows = anchors.map(s => result(s.ref)!.cardTransactionId!);
  if (new Set(anchorRows).size !== anchorRows.length) return report('ledger-shared-row');
  // 7. Each anchor's row: its candidate subjects in BOTH candidate tables, each charge class collapsed, are that anchor alone.
  const classOf = (ref: string) => duplicateRefs.has(ref) ? result(ref)!.corroboratedBy! : ref;
  for (const [i, anchor] of anchors.entries()) {
    const owners = new Set([...(ctx.owners.get(anchorRows[i]) ?? [])].map(classOf));
    if (owners.size !== 1 || !owners.has(anchor.ref)) return report('ledger-shared-row');
  }
  // 8. The anchors, one per charge class and T excluded, sum exactly to the saved total minus the saved tip.
  if (anchors.reduce((n, s) => n + s.money.amountMinor, 0) !== o.total.amountMinor - o.tip) return report('ledger-sum');
  return report('passed');
}
