import type Database from 'better-sqlite3';
import {
  CARD_PAYMENT_RECONCILIATION_RULES,
  canonicalCardDescription,
  cardPaymentCandidateCheck,
  cardPaymentConfirmRefusal,
  cardPaymentDayOffset,
  cardPaymentRowKind,
  checkingCreditReadsAsReturnedItem,
  checkingPayerReference,
  isReconcilableCardPayment,
  paymentChannelCue,
  reconcileCardPayments,
  type CardPaymentReconciliationInput,
  type ReconciliationCardRow,
  type ReconciliationCheckingRow,
} from '@finance-tracker/shared';

import { kindCorrectionIssuerLabel } from '../services/cardKindCorrections.js';
import { cardPaymentDecisionsSchemaState, listCardPaymentDecisions } from '../services/cardPaymentDecisions.js';
import { createCheckingLedgerReader } from '../services/checking/ledger.js';
import { HoldrRefusal } from '../services/dbErrors.js';

/**
 * The card payment reconciliation's dry run, read-only and value-free (`holdr-payment-reconciliation report`): the rows
 * the API reads (posted and pending payment rows, every checking row, the owner's decisions in force), reconciled under
 * this build's rules, and what became of each group the rules alone hold for the owner. It reports:
 * - **held**: each such group's payments and debits, by card or checking account (issuer or bank and its last four)
 *   and date. For each payment it gives the kind of payment its own words read as and the channel they name (the
 *   interchangeable-rows rule's description cue, Root 04:24Z). For each debit it gives what the debit reads as, the
 *   channel it names, whether it carries a payer reference and which cards proven pairs tie that reference to and how
 *   often, and whether it reads RETRY, came back, or came back unpaid. It says how the rules settled the group (for
 *   interchangeable rows, whether a cue or canonical order paired each pair) or why they did not, and what was left. For
 *   payments of one card and day, it gives their sources, import batches, key kinds and whether their text is the same.
 *   Around the group, it lists the checking credits and the other debits of its amount.
 * - **withheld**: the pairs rules version 3 matched by itself that this version does not (the debit came back unpaid,
 *   the owner answered their group, or this version reads a row of it otherwise); **returnedPulls**: the pulls netted
 *   with their unpaid return, and those held.
 * - **readings**: whether the Bilt card's carrier was found, for how many card products a carrier was found, and how
 *   many retries stand in for a returned pull (Root, RECON-34).
 * - **conflicts**: independent re-checks of every pair the rules matched; each count must be 0.
 * - **unmatchedPayments**: each with why, which checking accounts cover its date, its card's status and last activity,
 *   what is offered, and how many checking debits of its amount lie within 15 days. Counts are by reason and issuer,
 *   and for Amex cards it counts payments on cards with no activity after the payment.
 * - **unmatchedDebits**: counts by what they read as (their issuer), never their reasons: card coverage is not read
 *   here, so a reason could differ from the API's.
 * Every label is built value-free (an issuer, bank or source slug as letters and hyphens only, and an account's own last
 * four), and the line is printed only if it passes a strict schema: digits only in counts, dates and account last fours.
 */

/** A card account's label: issuer slug and last four (an Amex's last five read for its last four). */
interface CardLabelSource {
  id: string;
  issuer: string;
  last4: string | null;
  last5: string | null;
  status: string;
}

interface CardPaymentRow extends ReconciliationCardRow {
  source: string;
  hasReference: number;
  importBatchId: string | null;
}

/** The decisions table in another shape: no report, since the stored answers would be ignored. */
export const REPORT_CONFLICT = 'card payment decisions are not in the shape this build expects; no report';
const ALL_DAYS = { from: '1900-01-01', to: '9999-12-31' } as const;
const DAY_MS = 86_400_000;
const RETRY = /\bRETRY\b/i;

/** A slug as the report prints it: letters and single hyphens only, at most 16 characters; `fallback` when none is left. */
export function reportWord(text: unknown, fallback: string): string {
  if (typeof text !== 'string') return fallback;
  const word = text.toLowerCase().replace(/[^a-z-]+/g, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 16).replace(/-+$/, '');
  return /[a-z]/.test(word) ? word : fallback;
}

const dayOf = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function count<T>(items: Iterable<T>, keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

export function paymentReconciliationReport(db: Database.Database) {
  const decisionsState = cardPaymentDecisionsSchemaState(db);
  if (decisionsState === 'conflict') throw new HoldrRefusal(REPORT_CONFLICT);
  const cardAccounts = db.prepare(`SELECT id, issuer, last4, last5, status FROM card_accounts ORDER BY created_at, rowid`).all() as CardLabelSource[];
  const cardRows = (db.prepare(`SELECT id, card_account_id AS cardAccountId, source, external_id_hash IS NOT NULL AS hasReference,
      import_batch_id AS importBatchId, transaction_date AS transactionDate, posted_date AS postedDate, status, amount_minor AS amountMinor,
      currency, kind, description, merchant, issuer_category AS issuerCategory
    FROM card_transactions WHERE status IN ('pending', 'posted') AND kind IN ('payment') ORDER BY transaction_date, rowid`)
    .safeIntegers(false).all() as Array<Record<string, unknown>>)
    // As the API reads them: an absent value is undefined.
    .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? undefined : value])) as unknown as CardPaymentRow);
  const lastActivity = new Map((db.prepare(`SELECT card_account_id AS id, max(transaction_date) AS last FROM card_transactions
    WHERE status IN ('pending', 'posted') GROUP BY card_account_id`).all() as Array<{ id: string; last: string }>).map((row) => [row.id, row.last]));
  const reader = createCheckingLedgerReader(db);
  const installed = reader.installed();
  const checkingAccounts = installed ? reader.listAccounts() : [];
  const checkingRows: ReconciliationCheckingRow[] = installed ? reader.listRows(ALL_DAYS) : [];
  const coverage = installed ? reader.coverage() : [];
  const decisions = decisionsState === 'present' ? listCardPaymentDecisions(db) : [];
  const input: CardPaymentReconciliationInput = {
    cardAccounts: cardAccounts.map((account) => ({ id: account.id, issuer: account.issuer, last4: account.last4, last5: account.last5 })),
    cardRows,
    checkingAccounts: checkingAccounts.map((account) => ({ id: account.id, last4: account.last4 })),
    checkingRows,
    decisions,
    checkingCoverage: coverage.map((item) => ({ accountId: item.checkingAccountId, ranges: item.ranges })),
  };
  const result = reconcileCardPayments(input);

  const cardsById = new Map(cardAccounts.map((account) => [account.id, account]));
  const cardLabel = (id: string) => {
    const account = cardsById.get(id);
    const last4 = account?.last4 && /^\d{4}$/.test(account.last4) ? account.last4
      : account?.last5 && /^\d{5}$/.test(account.last5) ? account.last5.slice(1) : '----';
    return `${kindCorrectionIssuerLabel(typeof account?.issuer === 'string' ? account.issuer : '')}:${last4}`;
  };
  const issuerOf = (id: string) => cardLabel(id).split(':')[0];
  /** What a payment row's own words read as (Root 04:24Z): an ordinary or a housing card payment, a reversal, a credit. */
  const kindOf = (row: CardPaymentRow) => cardPaymentRowKind(row, cardsById.get(row.cardAccountId)?.issuer ?? '');
  const banksById = new Map(checkingAccounts.map((account) => [account.id, account]));
  const bankLabel = (id: string) => {
    const account = banksById.get(id);
    return `${reportWord(account?.institution, 'bank')}:${account && /^\d{4}$/.test(account.last4) ? account.last4 : '----'}`;
  };
  const payments = new Map(cardRows.map((row) => [row.id, row]));
  const rows = new Map(checkingRows.map((row) => [row.id, row]));
  const reads = (id: string) => {
    const kind = result.classes.get(id);
    return kind ? (kind.payee ? `${kind.class}:${kind.payee}` : kind.class) : 'not-a-debit';
  };
  const creditsOf = (row: ReconciliationCheckingRow) => checkingRows.filter((credit) => credit.checkingAccountId === row.checkingAccountId
    && credit.status === 'posted' && credit.currency === row.currency && credit.amountMinor === -row.amountMinor
    && dayOf(credit.date) >= dayOf(row.date) && dayOf(credit.date) - dayOf(row.date) <= CARD_PAYMENT_RECONCILIATION_RULES.debitReturnDays);
  const cameBack = (row: ReconciliationCheckingRow) => creditsOf(row).length > 0;
  const cameBackUnpaid = (row: ReconciliationCheckingRow) => creditsOf(row).some((credit) => checkingCreditReadsAsReturnedItem(credit.description));

  // Proven pairs, as the rules learn from them: every pair matched or confirmed without evidence, whose pull did not come
  // back (by any credit of its amount, unpaid or not).
  const base = result.pairs.filter((pair) => !pair.evidence && !cameBack(rows.get(pair.debitId)!));
  const proofs = new Map<string, Map<string, number>>();
  for (const pair of base) {
    const reference = checkingPayerReference(rows.get(pair.debitId)!.description);
    if (reference === null) continue;
    const card = payments.get(pair.paymentId)!.cardAccountId;
    const byCard = proofs.get(reference) ?? new Map<string, number>();
    byCard.set(card, (byCard.get(card) ?? 0) + 1);
    proofs.set(reference, byCard);
  }
  const proofsOf = (debitId: string) => {
    const reference = checkingPayerReference(rows.get(debitId)!.description);
    return [...(reference === null ? [] : proofs.get(reference) ?? new Map<string, number>())]
      .map(([card, times]) => ({ card: cardLabel(card), proofs: times }))
      .sort((a, b) => (a.card < b.card ? -1 : 1));
  };

  const unmatchedById = new Map(result.unmatchedPayments.map((item) => [item.paymentId, item]));
  const unmatchedDebitsById = new Map(result.unmatchedDebits.map((item) => [item.debitId, item]));
  const debitView = (id: string) => {
    const row = rows.get(id)!;
    return { account: bankLabel(row.checkingAccountId), date: row.date, reads: reads(id) };
  };
  const groups = result.heldGroups.map((check, index) => {
    const held = check.paymentIds.map((id) => payments.get(id)!);
    const dates = held.map((row) => row.transactionDate).sort();
    const { amountMinor, currency } = held[0];
    const inGroup = new Set(check.debitIds);
    const near = (date: string) => date >= shift(dates[0], -CARD_PAYMENT_RECONCILIATION_RULES.daysBefore)
      && date <= shift(dates[dates.length - 1], CARD_PAYMENT_RECONCILIATION_RULES.debitReturnDays);
    const sameDay = new Map<string, CardPaymentRow[]>();
    for (const row of held) {
      const key = `${row.cardAccountId} ${row.transactionDate}`;
      sameDay.set(key, [...(sameDay.get(key) ?? []), row]);
    }
    return {
      group: index + 1,
      outcome: check.outcome,
      ...(check.held ? { held: check.held } : {}),
      ...(check.notInterchangeable ? { notInterchangeable: check.notInterchangeable } : {}),
      payments: held.map((row) => ({
        card: cardLabel(row.cardAccountId), date: row.transactionDate, posted: row.postedDate ?? null,
        kind: kindOf(row), cue: paymentChannelCue(row.description),
      })),
      debits: check.debitIds.map((id) => {
        const row = rows.get(id)!;
        return {
          ...debitView(id), cue: paymentChannelCue(row.description), hasReference: checkingPayerReference(row.description) !== null, proofs: proofsOf(id),
          retry: RETRY.test(row.description), cameBack: cameBack(row), cameBackUnpaid: cameBackUnpaid(row),
        };
      }),
      settled: result.pairs.filter((pair) => pair.evidence && check.paymentIds.includes(pair.paymentId)).map((pair) => ({
        card: cardLabel(payments.get(pair.paymentId)!.cardAccountId), paymentDate: payments.get(pair.paymentId)!.transactionDate,
        ...debitView(pair.debitId), dayOffset: pair.dayOffset, ...pair.evidence,
      })),
      leftover: {
        payments: check.paymentIds.filter((id) => unmatchedById.has(id)).map((id) => ({
          card: cardLabel(payments.get(id)!.cardAccountId), date: payments.get(id)!.transactionDate,
          offered: unmatchedById.get(id)!.possibleDebits.map((option) => ({ ...debitView(option.debitId), dayOffset: option.dayOffset })),
        })),
        debits: check.debitIds.filter((id) => unmatchedDebitsById.has(id)).map((id) => debitView(id)),
        stillHeld: result.ambiguous.filter((group) => group.paymentIds.some((id) => check.paymentIds.includes(id)))
          .map((group) => ({ payments: group.paymentIds.length, debits: group.debitIds.length })),
      },
      sameCardAndDay: [...sameDay.values()].filter((same) => same.length > 1).map((same) => ({
        card: cardLabel(same[0].cardAccountId), date: same[0].transactionDate, rows: same.length,
        sources: [...new Set(same.map((row) => reportWord(row.source, 'other')))].sort(),
        batches: new Set(same.map((row) => row.importBatchId ?? 'none')).size,
        keys: count(same, (row) => (row.hasReference ? 'issuer-reference' : 'fingerprint')),
        sameText: new Set(same.map((row) => (typeof row.description === 'string' ? canonicalCardDescription(row.description) : ''))).size === 1,
        samePostedDate: new Set(same.map((row) => row.postedDate ?? 'none')).size === 1,
      })),
      around: {
        credits: checkingRows.filter((row) => row.status === 'posted' && row.amountMinor === -amountMinor && row.currency === currency && near(row.date))
          .map((row) => ({ account: bankLabel(row.checkingAccountId), date: row.date, returnedItem: checkingCreditReadsAsReturnedItem(row.description) })),
        otherDebits: checkingRows.filter((row) => !inGroup.has(row.id) && row.status === 'posted' && row.amountMinor === amountMinor
          && row.currency === currency && near(row.date)).map((row) => debitView(row.id)),
      },
    };
  });

  // Every pair the rules matched, re-checked against the rows without the rules' own bookkeeping.
  const evidencePairs = result.pairs.filter((pair) => pair.evidence);
  const autoPairs = result.pairs.filter((pair) => pair.status === 'matched');
  // The owner's rejections of pairs the rules read as candidates, by the rules' own test of a pair
  // (`cardPaymentCandidateCheck`: amount, days, Bilt's lanes and the day Cardless issued the Bilt card, masked numbers, the
  // carriers of the Bilt card and of each card product, a retry standing in for its returned pull, the issuer; never a
  // test of the report's own, PR280-R4), but a pull netted with its unpaid return (no candidate at all). A pair the rules
  // matched never shares a row with one (the group is the owner's).
  const nettedPulls = new Set(result.returnedDebits.map((item) => item.debitId));
  const isCandidate = cardPaymentCandidateCheck(input, result);
  const rejectedRows = new Set(decisions.filter((item) => item.decision === 'rejected').flatMap((item) => {
    const payment = item.cardTransactionId ? payments.get(item.cardTransactionId) : undefined;
    const debit = item.checkingTransactionId ? rows.get(item.checkingTransactionId) : undefined;
    if (!payment || !debit || nettedPulls.has(debit.id)) return [];
    return isCandidate(payment, debit) ? [`p:${payment.id}`, `d:${debit.id}`] : [];
  }));
  const places = (ids: string[]) => ids.length - new Set(ids).size;
  const paymentPlaces = [...result.pairs.map((pair) => pair.paymentId), ...result.ambiguous.flatMap((group) => group.paymentIds),
    ...result.unmatchedPayments.map((item) => item.paymentId), ...result.elsewhere.map((item) => item.paymentId), ...result.returned.map((item) => item.paymentId)];
  const debitPlaces = [...result.pairs.map((pair) => pair.debitId), ...result.ambiguous.flatMap((group) => group.debitIds),
    ...result.unmatchedDebits.map((item) => item.debitId), ...result.notCardPayments.map((item) => item.debitId),
    ...result.biltHousing.map((item) => item.debitId), ...result.returnedDebits.map((item) => item.debitId)];
  const placed = new Set(paymentPlaces);
  const identifies = (debitId: string, card: string) => {
    const reference = checkingPayerReference(rows.get(debitId)!.description);
    const byCard = reference === null ? undefined : proofs.get(reference);
    return byCard !== undefined && byCard.size === 1 && (byCard.get(card) ?? 0) >= CARD_PAYMENT_RECONCILIATION_RULES.referenceProofs;
  };
  const elsewhereProof = (debitId: string, card: string) => {
    const reference = checkingPayerReference(rows.get(debitId)!.description);
    return [...(reference === null ? [] : proofs.get(reference)?.keys() ?? [])].some((other) => other !== card);
  };
  // Interchangeable rows as Root ruled them (02:05Z, relaxed 04:24Z): one card, transaction and posted date, amount and
  // currency, every row the same kind of card payment (descriptions may differ); and each pair a cue chose names the
  // same channel on both sides.
  const interchangeBroken = result.heldGroups.filter((check) => check.outcome === 'interchangeable').filter((check) => {
    const same = check.paymentIds.map((id) => payments.get(id)!);
    const [first] = same;
    const kinds = same.map(kindOf);
    return same.length < 2 || check.debitIds.length > same.length
      || kinds.some((kind) => kind !== kinds[0]) || (kinds[0] !== 'payment' && kinds[0] !== 'housing')
      || same.some((row) => row.cardAccountId !== first.cardAccountId || row.transactionDate !== first.transactionDate
        || (row.postedDate ?? null) !== (first.postedDate ?? null) || row.amountMinor !== first.amountMinor || row.currency !== first.currency);
  }).length;
  const cueBroken = evidencePairs.filter((pair) => {
    const evidence = pair.evidence;
    if (evidence?.basis !== 'interchangeable' || evidence.pairedBy !== 'cue') return false;
    const cue = paymentChannelCue(payments.get(pair.paymentId)!.description);
    return cue === null || cue !== paymentChannelCue(rows.get(pair.debitId)!.description);
  }).length;
  const conflicts = {
    paymentInTwoPlaces: places(paymentPlaces),
    debitInTwoPlaces: places(debitPlaces),
    postedPaymentInNoPlace: cardRows.filter((row) => isReconcilableCardPayment(row) && !placed.has(row.id)).length,
    newPairNotACandidate: evidencePairs.filter((pair) => {
      const payment = payments.get(pair.paymentId)!;
      const debit = rows.get(pair.debitId)!;
      const offset = cardPaymentDayOffset(payment, debit);
      return cardPaymentConfirmRefusal(payment, debit, cardsById.get(payment.cardAccountId)?.issuer ?? '') !== null || offset === null
        || offset < -CARD_PAYMENT_RECONCILIATION_RULES.daysBefore || offset > CARD_PAYMENT_RECONCILIATION_RULES.daysAfter;
    }).length,
    autoPairOnRejectedRows: autoPairs.filter((pair) => rejectedRows.has(`p:${pair.paymentId}`) || rejectedRows.has(`d:${pair.debitId}`)).length,
    autoPairWithReturnedPull: autoPairs.filter((pair) => cameBackUnpaid(rows.get(pair.debitId)!)).length,
    evidencePairOnPullThatCameBack: evidencePairs.filter((pair) => cameBack(rows.get(pair.debitId)!)).length,
    referencePairNotProven: evidencePairs.filter((pair) => pair.evidence!.basis === 'reference'
      && !identifies(pair.debitId, payments.get(pair.paymentId)!.cardAccountId)).length,
    remainderPairAgainstAProof: evidencePairs.filter((pair) => pair.evidence!.basis === 'remainder'
      && elsewhereProof(pair.debitId, payments.get(pair.paymentId)!.cardAccountId)).length,
    interchangeGroupNotIdentical: interchangeBroken,
    interchangeCueNotShared: cueBroken,
    nettedPullStillPaired: result.returnedDebits.filter((item) => !cameBackUnpaid(rows.get(item.debitId)!)
      || result.pairs.some((pair) => pair.debitId === item.debitId)).length,
  };

  const coveredBy = (date: string) => checkingAccounts.filter((account) => coverage.some((item) => item.checkingAccountId === account.id
    && item.ranges.some((range) => range.start <= date && range.end >= date))).map((account) => bankLabel(account.id));
  const fromHeldGroups = new Set(result.heldGroups.flatMap((check) => check.paymentIds));
  const unmatched = result.unmatchedPayments.map((item) => {
    const row = payments.get(item.paymentId)!;
    const covered = coveredBy(row.transactionDate);
    const last = lastActivity.get(row.cardAccountId) ?? null;
    return {
      card: cardLabel(row.cardAccountId),
      date: row.transactionDate,
      reason: item.reason,
      coveredBy: covered,
      notCoveredBy: checkingAccounts.map((bank) => bankLabel(bank.id)).filter((label) => !covered.includes(label)),
      cardStatus: reportWord(cardsById.get(row.cardAccountId)?.status, 'other'),
      lastCardActivity: last,
      laterCardActivity: last !== null && last > row.transactionDate,
      offered: item.possibleDebits.map((option) => ({ ...debitView(option.debitId), dayOffset: option.dayOffset })),
      reversalsOffered: item.possibleReversals?.length ?? 0,
      // Checking debits of its amount within 15 days either way, whatever they read as or whatever they paid.
      sameAmountDebitsNearby: checkingRows.filter((debit) => debit.status === 'posted' && debit.amountMinor === row.amountMinor
        && debit.currency === row.currency && Math.abs(dayOf(debit.date) - dayOf(row.transactionDate)) <= 15).length,
      leftFromAHeldGroup: fromHeldGroups.has(item.paymentId),
    };
  });
  const amex = result.unmatchedPayments.filter((item) => issuerOf(payments.get(item.paymentId)!.cardAccountId) === 'amex')
    .map((item) => unmatched[result.unmatchedPayments.indexOf(item)]);
  const cameBackHolds = result.heldGroups.filter((check) => check.held === 'came-back');
  // The owner's confirmations stand whatever came back: "a returned pull is never a payment" governs the rules' own
  // pairs (Root 03:28Z). Those whose pull came back unpaid prove no reference, and are listed for the owner to see.
  const confirmedPairs = result.pairs.filter((pair) => pair.status === 'confirmed');
  const returnedConfirmed = confirmedPairs.filter((pair) => cameBackUnpaid(rows.get(pair.debitId)!));

  return {
    code: 'payment-reconciliation-report',
    rulesVersion: result.rulesVersion,
    referenceProofs: CARD_PAYMENT_RECONCILIATION_RULES.referenceProofs,
    // What the rows show beyond the descriptors' words (Root, RECON-34): whether the Bilt card's carrier was found, how
    // many card products a carrier was found for, and how many retries stand in for a returned pull.
    readings: { biltCarrier: result.biltCarrier === null ? 0 : 1, productCarriers: result.productCarriers.length, retries: result.retries.length },
    checking: {
      installed,
      accounts: checkingAccounts.map((account) => ({
        account: bankLabel(account.id),
        coverage: (coverage.find((item) => item.checkingAccountId === account.id)?.ranges ?? []).map((range) => `${range.start}..${range.end}`),
      })),
    },
    decisions: { installed: decisionsState === 'present', inForce: count(decisions, (item) => item.decision), stale: result.staleDecisions.length },
    totals: result.totals.map((entry) => ({
      currency: reportWord(entry.currency, 'other'),
      payments: Object.fromEntries(Object.entries(entry.payments).map(([part, value]) => [part, value.count])),
      debits: Object.fromEntries(Object.entries(entry.debits).map(([part, value]) => [part, value.count])),
    })),
    held: {
      before: {
        groups: result.heldGroups.length,
        payments: result.heldGroups.reduce((sum, check) => sum + check.paymentIds.length, 0),
        debits: result.heldGroups.reduce((sum, check) => sum + check.debitIds.length, 0),
      },
      after: {
        groups: result.ambiguous.length,
        payments: result.ambiguous.reduce((sum, group) => sum + group.paymentIds.length, 0),
        debits: result.ambiguous.reduce((sum, group) => sum + group.debitIds.length, 0),
      },
      outcomes: count(result.heldGroups, (check) => (check.held ? `${check.outcome}:${check.held}` : check.outcome)),
      pairs: count(evidencePairs, (pair) => pair.evidence!.basis),
      leftoverPayments: result.heldGroups.reduce((sum, check) => sum + check.orphanPayments, 0),
      leftoverDebits: result.heldGroups.reduce((sum, check) => sum + check.orphanDebits, 0),
      // The groups no rule read because a pull came back by a credit of its amount in other words (Root 03:22Z).
      cameBackHolds: { groups: cameBackHolds.length, payments: cameBackHolds.reduce((sum, check) => sum + check.paymentIds.length, 0) },
      groups,
    },
    // The pairs rules version 3 matched one to one that this build does not, each reason counted apart (Root 03:22Z).
    withheld: {
      total: result.withheld.length,
      answered: result.withheld.filter((item) => item.reason === 'answered').length,
      returned: result.withheld.filter((item) => item.reason === 'returned').length,
      reread: result.withheld.filter((item) => item.reason === 'reread').length,
    },
    returnedPulls: {
      netted: result.returnedDebits.length,
      held: result.ambiguous.flatMap((group) => group.debitIds).filter((id) => cameBackUnpaid(rows.get(id)!)).length,
    },
    confirmed: {
      total: confirmedPairs.length,
      returnedDebit: returnedConfirmed.length,
      list: returnedConfirmed.map((pair) => {
        const payment = payments.get(pair.paymentId)!;
        const debit = rows.get(pair.debitId)!;
        return {
          card: cardLabel(payment.cardAccountId), paymentDate: payment.transactionDate, account: bankLabel(debit.checkingAccountId), date: debit.date,
          returnedOn: creditsOf(debit).filter((credit) => checkingCreditReadsAsReturnedItem(credit.description)).map((credit) => credit.date).sort()[0],
        };
      }),
    },
    conflicts: { total: Object.values(conflicts).reduce((sum, value) => sum + value, 0), ...conflicts },
    references: {
      identifyingOneCard: [...proofs.values()].filter((byCard) => byCard.size === 1 && [...byCard.values()][0] >= CARD_PAYMENT_RECONCILIATION_RULES.referenceProofs).length,
      provenOnceOnly: [...proofs.values()].filter((byCard) => byCard.size === 1 && [...byCard.values()][0] < CARD_PAYMENT_RECONCILIATION_RULES.referenceProofs).length,
      tiedToSeveralCards: [...proofs.values()].filter((byCard) => byCard.size > 1).length,
    },
    unmatchedPayments: {
      total: unmatched.length,
      byReason: count(unmatched, (item) => item.reason),
      byIssuer: count(unmatched, (item) => item.card.split(':')[0]),
      amex: {
        total: amex.length,
        noLaterCardActivity: amex.filter((item) => !item.laterCardActivity).length,
        cardClosed: amex.filter((item) => item.cardStatus === 'closed').length,
      },
      list: unmatched,
    },
    unmatchedDebits: { total: result.unmatchedDebits.length, byReads: count(result.unmatchedDebits, (item) => reads(item.debitId)) },
  };
}

export type PaymentReconciliationReport = ReturnType<typeof paymentReconciliationReport>;

/** The report's own keys: any other key is refused. */
const KEYS = new Set([
  'code', 'rulesVersion', 'referenceProofs', 'readings', 'biltCarrier', 'productCarriers', 'retries', 'checking', 'installed', 'accounts',
  'account', 'coverage', 'decisions', 'inForce', 'stale',
  'totals', 'currency', 'payments', 'debits', 'all', 'matched', 'confirmed', 'ambiguous', 'unmatched', 'elsewhere', 'returned', 'pending',
  'notCardPayment', 'biltHousing', 'held', 'before', 'after', 'groups', 'outcomes', 'pairs', 'leftoverPayments', 'leftoverDebits', 'group',
  'outcome', 'notInterchangeable', 'card', 'date', 'posted', 'reads', 'hasReference', 'proofs', 'retry', 'cameBack', 'cameBackUnpaid',
  'settled', 'paymentDate', 'dayOffset', 'basis', 'leftover', 'offered', 'stillHeld', 'sameCardAndDay', 'rows', 'sources', 'batches', 'keys',
  'sameText', 'samePostedDate', 'around', 'credits', 'returnedItem', 'otherDebits', 'withheld', 'total', 'byReason', 'returnedPulls', 'netted',
  'cameBackHolds', 'answered', 'reread', 'returnedDebit', 'returnedOn',
  'conflicts', 'paymentInTwoPlaces', 'debitInTwoPlaces', 'postedPaymentInNoPlace', 'newPairNotACandidate', 'autoPairOnRejectedRows',
  'autoPairWithReturnedPull', 'evidencePairOnPullThatCameBack', 'referencePairNotProven', 'remainderPairAgainstAProof', 'interchangeGroupNotIdentical',
  'interchangeCueNotShared', 'nettedPullStillPaired', 'kind', 'cue', 'pairedBy',
  'references', 'identifyingOneCard', 'provenOnceOnly', 'tiedToSeveralCards', 'unmatchedPayments', 'byIssuer', 'amex', 'noLaterCardActivity',
  'cardClosed', 'list', 'reason', 'coveredBy', 'notCoveredBy', 'cardStatus', 'lastCardActivity', 'laterCardActivity', 'reversalsOffered',
  'sameAmountDebitsNearby', 'leftFromAHeldGroup', 'unmatchedDebits', 'byReads',
]);
/** Objects whose keys are words the report counts by (a reason, an issuer, a rule's outcome), each with a count. */
const COUNT_MAPS = new Set(['inForce', 'outcomes', 'pairs', 'keys', 'byReason', 'byIssuer', 'byReads']);
/** The only strings with digits: an account (issuer or bank, and its own last four), a date, a range of dates. */
const ACCOUNT_KEYS = new Set(['card', 'account', 'coveredBy', 'notCoveredBy']);
const DATE_KEYS = new Set(['date', 'paymentDate', 'posted', 'lastCardActivity', 'returnedOn']);
const ACCOUNT = /^[a-z]+(?:-[a-z]+)*:(?:[0-9]{4}|----)$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const RANGE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.\.[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const WORD = /^[a-z]+(?:[-:][a-z]+)*$/;

/** Whether `value`, under `key`, is what the report may print: digits only in counts, dates and account last fours. */
function valueFree(value: unknown, key: string | null): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value) && Math.abs(value) <= 99_999;
  if (typeof value === 'string') {
    if (key !== null && ACCOUNT_KEYS.has(key)) return ACCOUNT.test(value);
    if (key !== null && DATE_KEYS.has(key)) return DATE.test(value);
    if (key === 'coverage') return RANGE.test(value);
    return WORD.test(value);
  }
  if (Array.isArray(value)) return value.every((item) => valueFree(item, key));
  if (typeof value !== 'object') return false;
  const counted = key !== null && COUNT_MAPS.has(key);
  return Object.entries(value).every(([name, item]) => (counted ? WORD.test(name) && typeof item === 'number' : KEYS.has(name))
    && valueFree(item, counted ? null : name));
}

/** The report as one JSON line, or null when anything in it falls outside the strict schema or could carry a value. */
export function formatPaymentReconciliationReport(report: PaymentReconciliationReport): string | null {
  const text = JSON.stringify(report);
  return valueFree(report, null) && !/[0-9]{5,}/.test(text) ? `${text}\n` : null;
}
