import { mergeCardCoverage, type CardCoverageRange } from '../cardSpending.js';
import { addDays, daysBetween, easternDate, endOfEasternDay, startOfEasternDay } from './dates.js';
import type { CardAutopayKind, CardIssuerPhrase, CardScheduleObservation, CardScheduleSourceKind } from './observations.js';
import {
  FIRST_APPEARANCE_DAYS,
  dedupeReceiptFacts,
  economicCardPayments,
  identityReceiptBound,
  matchIssuerReceipts,
  type CardCreditIdentity,
  type CashPlanAsOf,
  type CashPlanCardRow,
  type IssuerReceiptFact,
  type ReceiptBinding,
} from './payments.js';

/**
 * The card payment schedule engine (A1 spec v9 §3; note v2.9 §5.4–§5.5). Pure and deterministic: every answer is
 * computed as of an instant T from what was known by T. Unknown is null, never 0, and red needs proof.
 */

export type CashPlanMode = 'knowledge' | 'counterfactual';
export type CashPlanPayPolicy = 'statement' | 'minimum';
export interface CashPlanRules {
  amberDays: number;
  redDays: number;
  policy: CashPlanPayPolicy;
}
/** Alex's defaults (§8 Q4–Q5): pay the statement in full; amber 10 days, red 3 days. */
export const CASH_PLAN_RULES: Readonly<CashPlanRules> = Object.freeze({ amberDays: 10, redDays: 3, policy: 'statement' });
/** A live fact is current for 72 hours after its as-of. Expiry only removes assurance (A10). */
export const CURRENT_FACT_MS = 72 * 3_600_000;
/** Ledger-absence claims need coverage over (C, E_c] with E_c at least two days before today. */
export const COVERAGE_SLACK_DAYS = 2;
/**
 * Root's ruling of 2026-11-08 (b): when k−1 resolves only from issuer evidence, a registry payment posting within this
 * many days after C_k may be k−1's late cure, received before the close. It is uncertain-window for k unless an issuer
 * receipt binding dates it after C_k. It reuses Root's 4-day bound; it is not the property test's varied offset.
 */
export const CURE_POSTING_DAYS = 4;

export type CashPlanRuleId = 'R1a' | 'R1b' | 'R2a' | 'R2b' | 'A1' | 'A1b' | 'A1c' | 'A2' | 'A2b' | 'A5' | 'A8' | 'A9' | 'A10' | 'A11';
export const CASH_PLAN_RED_RULES: readonly CashPlanRuleId[] = ['R1a', 'R1b', 'R2a', 'R2b'];

export interface CashPlanAttentionItem {
  rule: CashPlanRuleId;
  severity: 'red' | 'amber';
  subject: 'card' | 'cycle' | 'bank-read';
  /** The cycle's statement closing date (cycle items). */
  closingDate: string | null;
  dueDate: string | null;
  /**
   * A11: `payment-unconfirmed`, `past-due-unconfirmed` or `confirmation-needed`. R2a: `no-payment-seen` or
   * `payments-dont-cover`. A9: `implicit-later` or `payments-after`. A8: `cycle` or `observations`.
   */
  reason: string | null;
  /** What it says, naming dates only: never an amount. */
  copy: string;
}

export type CardCycleState =
  | 'paid-in-full' | 'minimum-met' | 'paid-late' | 'not-required' | 'carried-forward'
  | 'in-flight' | 'awaiting-posting'
  | 'unpaid' | 'past-due'
  | 'unknown-coverage' | 'payment-unconfirmed' | 'past-due-unconfirmed' | 'confirmation-needed' | 'held' | 'unknown';

export interface CashPlanLiveFacts {
  remainingStatementMinor: number | null;
  pastDueMinor: number | null;
  currentBalanceMinor: number | null;
  autopay: CardAutopayKind | null;
  autopayFixedMinor: number | null;
  scheduledPaymentDate: string | null;
  scheduledPaymentMinor: number | null;
  issuerPhrase: CardIssuerPhrase | null;
  lastPaymentDate: string | null;
  lastPaymentMinor: number | null;
  /** The latest as-of among the merged values, and whether it is within 72 hours of T. */
  asOf: string | null;
  current: boolean;
  /** Fields whose latest facts disagree at the same or incomparable time: held, so null above. */
  conflicts: string[];
}

export interface CashPlanCycle {
  closingDate: string;
  currency: string;
  status: 'accepted' | 'held';
  heldReason: 'contradiction' | 'held-observation' | 'predecessor-contradiction' | null;
  periodStartDate: string | null;
  dueDate: string | null;
  statementBalanceMinor: number | null;
  minimumDueMinor: number | null;
  state: CardCycleState;
  newest: boolean;
  /** Shown: the newest cycle, and every older cycle not resolved. */
  shown: boolean;
  /** W_k = (after, through]; closed once the successor statement is known. */
  window: { after: string; through: string; closed: boolean };
  /** E_c: the end of committed coverage continuous from the day after the close (null: none). */
  coverageThrough: string | null;
  /** The obligation guard (k−1 at C_k): how k−1 was identified and whether it was resolved. */
  predecessor: { kind: 'captured' | 'held' | 'uncaptured' | 'unidentified'; resolved: boolean } | null;
  answers: {
    minimumMetByDue: boolean | null;
    minimumMetSoFar: boolean | null;
    statementSatisfied: boolean | null;
    inFlight: boolean;
    awaitingPosting: boolean;
    issuerShowsOwed: boolean | null;
  };
  /** A and U at T: proven coverage and the other possible payments (identity ids and sums). */
  ledger: { proven: string[]; possible: string[]; provenMinor: number; possibleMinor: number };
  live: CashPlanLiveFacts;
  attention: CashPlanAttentionItem[];
}

export interface CashPlanBankRead {
  dueDate: string;
  minimumDueMinor: number | null;
  live: CashPlanLiveFacts;
  attention: CashPlanAttentionItem[];
}

export interface CashPlanDelinquency {
  pastDueMinor: number | null;
  phrase: 'past-due' | null;
  financialAsOf: string;
  asOfSource: CardScheduleObservation['asOfSource'];
  sourceKind: CardScheduleSourceKind;
  /** A9: an implicit-capture page later showing no past due, or posted payments after the notice covering it. */
  downgraded: 'implicit-later' | 'payments-after' | null;
}

export interface CardPlanInput {
  card: { id: string; issuer: string; currency: string; status: 'active' | 'closed' };
  /** The card's observations (accepted and held). Rows of other cards are ignored. */
  observations: readonly CardScheduleObservation[];
  /** The card's ledger rows (raw: every status, removals and merges). Only credits are read. */
  rows: readonly CashPlanCardRow[];
  returnedPaymentIds?: ReadonlySet<string>;
  uncertainPaymentIds?: ReadonlySet<string>;
  /**
   * Per returned or possibly reversed payment row: the Eastern date of its latest possible reversal. Absent means unknown,
   * which undoes every issuer reassurance the payment could have backed.
   */
  reversalDates?: ReadonlyMap<string, string>;
  /** Committed import coverage (inclusive dates). */
  coverage: readonly CardCoverageRange[];
  /** T: the instant every answer is computed as of. */
  asOf: string;
  mode?: CashPlanMode;
  rules?: Partial<CashPlanRules>;
  /** The widened first-appearance reading (w). Production uses 4; the property test varies it. */
  firstAppearanceDays?: number;
}

export interface CardPlan {
  cardAccountId: string;
  mode: CashPlanMode;
  asOf: string;
  today: string;
  delinquency: CashPlanDelinquency | null;
  /** Every cycle, newest first (`shown` marks the ones retained for display). */
  cycles: CashPlanCycle[];
  bankReads: CashPlanBankRead[];
  /** Card-level and shown cycles' and bank reads' items. */
  attention: CashPlanAttentionItem[];
  bindings: ReceiptBinding[];
  heldObservations: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Financial effective time and the clearing rule
// ---------------------------------------------------------------------------------------------------------------------

export function observationAsOf(observation: Pick<CardScheduleObservation, 'financialAsOf' | 'asOfPrecision'>): CashPlanAsOf {
  if (observation.asOfPrecision === 'date') {
    const date = observation.financialAsOf;
    return { value: date, precision: 'date', date, lowerMs: startOfEasternDay(date), upperMs: endOfEasternDay(date) };
  }
  const ms = Date.parse(observation.financialAsOf);
  return { value: observation.financialAsOf, precision: 'instant', date: easternDate(ms), lowerMs: ms, upperMs: ms };
}

/** Order of two as-ofs: instants by time; otherwise by Eastern date, and the same date at mixed precision is incomparable. */
export function compareAsOf(a: CashPlanAsOf, b: CashPlanAsOf): 'before' | 'after' | 'equal' | 'incomparable' {
  if (a.precision === 'instant' && b.precision === 'instant') {
    return a.lowerMs < b.lowerMs ? 'before' : a.lowerMs > b.lowerMs ? 'after' : 'equal';
  }
  if (a.date !== b.date) return a.date < b.date ? 'before' : 'after';
  return a.precision === b.precision ? 'equal' : 'incomparable';
}

interface Fact {
  observation: CardScheduleObservation;
  asOf: CashPlanAsOf;
}

/** A reassuring value clears an adverse one only when strictly later at comparable precision, and not implicit over explicit/statement. */
function clears(reassuring: Fact, adverse: Fact): boolean {
  return compareAsOf(reassuring.asOf, adverse.asOf) === 'after'
    && !(reassuring.observation.asOfSource === 'implicit-capture' && adverse.observation.asOfSource !== 'implicit-capture');
}

const isAdverseRead = (o: CardScheduleObservation) => (o.pastDueMinor !== null && o.pastDueMinor > 0) || o.issuerPhrase === 'past-due';
/** An observed P = 0 (or a not-required phrase), with nothing adverse in the same read. */
const isReassuringRead = (o: CardScheduleObservation) => !isAdverseRead(o) && (o.pastDueMinor === 0 || o.issuerPhrase === 'not-required');
const isPZero = (o: CardScheduleObservation) => o.pastDueMinor === 0 && o.issuerPhrase !== 'past-due';
const MET_PHRASES: ReadonlySet<CardIssuerPhrase | null> = new Set<CardIssuerPhrase | null>(['not-required', 'paid']);
/** Live fields that decide a cycle's payment state; a conflict in any of them needs confirmation (A11). */
const PAYMENT_STATE_FIELDS: ReadonlySet<string> = new Set(['remaining', 'pastDue', 'phrase', 'scheduled', 'autopay']);

type Classified = 'adverse' | 'reassuring' | 'neutral';

/** How one live field is read from an observation and classified for the clearing rule. */
interface FieldReader<T> {
  pick: (o: CardScheduleObservation) => T | null;
  classify: (value: T) => Classified;
}
const PHRASE_FIELD: FieldReader<CardIssuerPhrase> = {
  pick: (o) => o.issuerPhrase,
  classify: (value) => (value === 'past-due' ? 'adverse' : MET_PHRASES.has(value) ? 'reassuring' : 'neutral'),
};
const REMAINING_FIELD: FieldReader<number> = { pick: (o) => o.remainingStatementMinor, classify: (value) => (value > 0 ? 'adverse' : 'reassuring') };
const PAST_DUE_FIELD: FieldReader<number> = { pick: (o) => o.pastDueMinor, classify: (value) => (value > 0 ? 'adverse' : 'reassuring') };
const NOT_REQUIRED_PHRASE: ReadonlySet<CardIssuerPhrase | null> = new Set<CardIssuerPhrase | null>(['not-required']);

/** Whether `fact`'s value of `field` is held (`mergeFacts`): a fact in `scope` with a different value is tied or incomparable with it. */
function heldOn<T>(fact: Fact, field: FieldReader<T>, scope: readonly Fact[]): boolean {
  const value = field.pick(fact.observation);
  if (value === null) return false;
  const key = JSON.stringify(value);
  return scope.some((other) => {
    const otherValue = field.pick(other.observation);
    if (otherValue === null || JSON.stringify(otherValue) === key) return false;
    const order = compareAsOf(other.asOf, fact.asOf);
    return order === 'equal' || order === 'incomparable';
  });
}

/**
 * Whether a read carries a reassuring value that can clear an adverse fact (the clearing rule): nothing adverse in the
 * read, and an observed P = 0 or one of `phrases`, not held among the card's `known` facts. A held value is no value
 * (5b01e72f's #269 8bd62afe candidates 1–2).
 */
function canClear(z: Fact, phrases: ReadonlySet<CardIssuerPhrase | null>, known: readonly Fact[]): boolean {
  const o = z.observation;
  if (isAdverseRead(o)) return false;
  return (o.pastDueMinor === 0 && !heldOn(z, PAST_DUE_FIELD, known)) || (phrases.has(o.issuerPhrase) && !heldOn(z, PHRASE_FIELD, known));
}

/**
 * Adverse facts in `scope` that no valid clearing read in it clears (the clearing rule): what a reassurance must clear
 * itself. A clearing read that may rest on a payment undone since is not valid, nor is a held one.
 */
function standingAdverse(scope: readonly Fact[], valid: (fact: Fact) => boolean, known: readonly Fact[]): Fact[] {
  return scope.filter((fact) => isAdverseRead(fact.observation)
    && !scope.some((z) => valid(z) && canClear(z, MET_PHRASES, known) && clears(z, fact)));
}

/** An issuer reassurance's result: its fact when it holds; `contested` when adverse evidence it can't clear disputes it. */
interface Reassurance {
  fact: Fact | null;
  contested: boolean;
}
const NO_REASSURANCE: Reassurance = Object.freeze({ fact: null, contested: false });

interface MergedField<T> {
  value: T | null;
  fact: Fact | null;
  conflict: boolean;
  /** The latest value's fact when it was reassuring but couldn't clear an earlier adverse one (the clearing rule): an adverse value stands. */
  outranked: Fact | null;
}

/**
 * One live field over facts (`mergeFacts`): the latest financial as-of wins; a tie or an incomparable pair with
 * different values is held; a reassuring winner replaces an adverse value only under the clearing rule.
 */
function mergeField<T>(facts: readonly Fact[], pick: (o: CardScheduleObservation) => T | null, classify: (value: T) => Classified): MergedField<T> {
  const candidates = facts.map((fact) => ({ fact, value: pick(fact.observation) })).filter((item): item is { fact: Fact; value: T } => item.value !== null);
  if (candidates.length === 0) return { value: null, fact: null, conflict: false, outranked: null };
  const latestOf = (items: typeof candidates) => items.filter((item) => !items.some((other) => compareAsOf(other.fact.asOf, item.fact.asOf) === 'after'));
  const top = latestOf(candidates);
  const same = (a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
  if (top.some((item) => !same(item.value, top[0].value))) return { value: null, fact: null, conflict: true, outranked: null };
  const pickOne = (items: typeof candidates) => [...items].sort((a, b) => b.fact.asOf.lowerMs - a.fact.asOf.lowerMs
    || (a.fact.observation.id < b.fact.observation.id ? -1 : 1))[0];
  const winner = pickOne(top);
  if (classify(winner.value) === 'reassuring') {
    const standing = candidates.filter((item) => classify(item.value) === 'adverse' && !clears(winner.fact, item.fact));
    if (standing.length > 0) {
      const latestStanding = latestOf(standing);
      if (latestStanding.some((item) => !same(item.value, latestStanding[0].value))) return { value: null, fact: null, conflict: true, outranked: winner.fact };
      const adverse = pickOne(latestStanding);
      return { value: adverse.value, fact: adverse.fact, conflict: false, outranked: winner.fact };
    }
  }
  return { value: winner.value, fact: winner.fact, conflict: false, outranked: null };
}

interface LiveMerge {
  remaining: MergedField<number>;
  pastDue: MergedField<number>;
  currentBalance: MergedField<number>;
  autopay: MergedField<{ kind: CardAutopayKind; fixed: number | null }>;
  scheduled: MergedField<{ date: string | null; minor: number | null }>;
  phrase: MergedField<CardIssuerPhrase>;
  lastPayment: MergedField<{ date: string | null; minor: number | null }>;
}

/** `mergeFacts` for live fields. Statement fields (C, D, S, M, period start) are fixed per cycle and merged elsewhere. */
export function mergeLiveFacts(observations: readonly CardScheduleObservation[]): LiveMerge {
  const facts = observations.map((observation) => ({ observation, asOf: observationAsOf(observation) }));
  const neutral = (): Classified => 'neutral';
  return {
    remaining: mergeField(facts, REMAINING_FIELD.pick, REMAINING_FIELD.classify),
    pastDue: mergeField(facts, PAST_DUE_FIELD.pick, PAST_DUE_FIELD.classify),
    currentBalance: mergeField(facts, (o) => o.currentBalanceMinor, neutral),
    autopay: mergeField(facts, (o) => (o.autopay === null ? null : { kind: o.autopay, fixed: o.autopayFixedMinor }), neutral),
    scheduled: mergeField(facts, (o) => (o.scheduledPaymentDate === null && o.scheduledPaymentMinor === null ? null
      : { date: o.scheduledPaymentDate, minor: o.scheduledPaymentMinor }), neutral),
    phrase: mergeField(facts, PHRASE_FIELD.pick, PHRASE_FIELD.classify),
    lastPayment: mergeField(facts, (o) => (o.lastPaymentDate === null && o.lastPaymentMinor === null ? null
      : { date: o.lastPaymentDate, minor: o.lastPaymentMinor }), neutral),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------------------------------------

interface CycleWork {
  C: string;
  accepted: CardScheduleObservation[];
  held: CardScheduleObservation[];
  /** Accepted rows linked to it: its own rows and due-only reads naming its due date. */
  linked: CardScheduleObservation[];
  status: 'accepted' | 'held';
  heldReason: CashPlanCycle['heldReason'];
  D: string | null;
  S: number | null;
  M: number | null;
  start: string | null;
  dueSet: Set<string>;
  windowThrough: string;
  closed: boolean;
  guard: CashPlanCycle['predecessor'];
  /** Identities the posted-date rule assigned to this window. */
  assigned: Set<string>;
  assignedSum: number;
}

const sum = (values: Iterable<number>) => { let total = 0; for (const value of values) total += value; return total; };
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The whole pipeline for one card (`deriveCardCycles` + `cardAttention`): facts merged as of T, cycles with their
 * windows, the obligation guard, the receipt graph, allocation by the posted-date rule only, the aggregate possible-payment
 * guard, the answers and the red and amber items, with the retention rule.
 */
export function cashPlanForCard(input: CardPlanInput): CardPlan {
  const rules: CashPlanRules = { ...CASH_PLAN_RULES, ...input.rules };
  const w = input.firstAppearanceDays ?? FIRST_APPEARANCE_DAYS;
  const mode: CashPlanMode = input.mode ?? 'knowledge';
  const T = Date.parse(input.asOf);
  if (!Number.isFinite(T)) throw new Error('asOf must be an instant');
  const today = easternDate(T);
  const card = input.card;
  const currency = card.currency;

  // Knowledge: what Holdr knew by T. Counterfactual (labelled replays only): facts by their effective time, statements
  // assumed known two days after their close.
  const known = (o: CardScheduleObservation) => (mode === 'knowledge'
    ? Date.parse(o.observedAt) <= T && Date.parse(o.importedAt) <= T
    : o.sourceKind === 'statement-pdf' ? addDays(o.statementClosingDate!, 2) <= today : observationAsOf(o).lowerMs <= T);
  const observations = input.observations.filter((o) => o.cardAccountId === card.id && known(o))
    .sort((a, b) => byText(a.id, b.id));
  const accepted = observations.filter((o) => o.status === 'accepted' && o.currency === currency);
  const heldRows = observations.filter((o) => o.status === 'held');
  const rows = input.rows.filter((row) => row.cardAccountId === card.id && (mode === 'knowledge'
    ? Date.parse(row.createdAt) <= T
    : (row.postedDate ?? row.transactionDate) <= today));
  const coverage = mergeCardCoverage(input.coverage);
  const facts = (list: readonly CardScheduleObservation[]): Fact[] => list.map((observation) => ({ observation, asOf: observationAsOf(observation) }));
  const acceptedFacts = facts(accepted);
  const asOfOf = new Map(acceptedFacts.map((fact) => [fact.observation.id, fact.asOf]));
  const isCurrent = (fact: Fact | null) => fact !== null && T - fact.asOf.lowerMs <= CURRENT_FACT_MS;

  // ----- Cycles: keyed by (card, currency, C); statement facts fixed per cycle -----
  const closings = [...new Set([...accepted, ...heldRows].map((o) => o.statementClosingDate).filter((c): c is string => c !== null))].sort(byText);
  const cycles: CycleWork[] = closings.map((C) => {
    const own = accepted.filter((o) => o.statementClosingDate === C);
    const distinct = <T>(values: Array<T | null>) => [...new Set(values.filter((v): v is T => v !== null))];
    const D = distinct(own.map((o) => o.paymentDueDate));
    const S = distinct(own.map((o) => o.statementBalanceMinor));
    const M = distinct(own.map((o) => o.minimumDueMinor));
    const start = distinct(own.map((o) => o.statementPeriodStartDate));
    const contradiction = D.length > 1 || S.length > 1 || M.length > 1 || start.length > 1;
    return {
      C,
      accepted: own,
      held: heldRows.filter((o) => o.statementClosingDate === C),
      linked: [...own],
      status: own.length === 0 || contradiction ? 'held' : 'accepted',
      heldReason: own.length === 0 ? 'held-observation' : contradiction ? 'contradiction' : null,
      D: D.length === 1 ? D[0] : null,
      S: S.length === 1 ? S[0] : null,
      M: M.length === 1 ? M[0] : null,
      start: start.length === 1 ? start[0] : null,
      dueSet: new Set(D),
      windowThrough: today,
      closed: false,
      guard: null,
      assigned: new Set<string>(),
      assignedSum: 0,
    } satisfies CycleWork;
  });
  // A printed period start S_k identifies k−1 at S_k − 1; a cycle closing strictly between is a contradiction: k is held.
  for (const cycle of cycles) {
    if (cycle.status !== 'accepted' || cycle.start === null) continue;
    const target = addDays(cycle.start, -1);
    if (cycles.some((other) => other.C > target && other.C < cycle.C)) {
      cycle.status = 'held';
      cycle.heldReason = 'predecessor-contradiction';
    }
  }
  cycles.forEach((cycle, index) => {
    const next = cycles[index + 1];
    cycle.windowThrough = next ? next.C : today;
    cycle.closed = next !== undefined;
  });
  // A due-only read links to the unique cycle with its due date; otherwise it is an unlinked bank read.
  const unlinked: CardScheduleObservation[] = [];
  for (const o of accepted) {
    if (o.statementClosingDate !== null || o.paymentDueDate === null) continue;
    const matches = cycles.filter((cycle) => cycle.dueSet.has(o.paymentDueDate!));
    if (matches.length === 1) matches[0].linked.push(o);
    else unlinked.push(o);
  }
  // Root's grace disqualifier: any printed period with D − C ≥ C − S withholds the bounded exception card-wide.
  const graceWithheld = [...accepted, ...heldRows].some((o) => o.statementPeriodStartDate !== null && o.statementClosingDate !== null
    && o.paymentDueDate !== null && daysBetween(o.statementClosingDate, o.paymentDueDate) >= daysBetween(o.statementPeriodStartDate, o.statementClosingDate))
    || cycles.some((cycle) => cycle.start !== null && cycle.D !== null && daysBetween(cycle.C, cycle.D) >= daysBetween(cycle.start, cycle.C));

  // ----- Payments and the receipt graph -----
  const identities = economicCardPayments(rows, card, {
    returnedPaymentIds: input.returnedPaymentIds, uncertainPaymentIds: input.uncertainPaymentIds, reversalDates: input.reversalDates,
  });
  const identityById = new Map(identities.map((identity) => [identity.id, identity]));
  const counting = identities.filter((identity) => identity.counting !== null);
  const receiptFacts: IssuerReceiptFact[] = dedupeReceiptFacts(acceptedFacts
    .filter((fact) => fact.observation.lastPaymentDate !== null && fact.observation.lastPaymentMinor !== null
      && fact.observation.lastPaymentDate <= fact.asOf.date)
    .map((fact) => ({
      id: fact.observation.id,
      date: fact.observation.lastPaymentDate!,
      minor: fact.observation.lastPaymentMinor!,
      asOf: fact.asOf,
      sourceKind: fact.observation.sourceKind,
    })));
  const match = matchIssuerReceipts(receiptFacts, identities, coverage, w);
  const bindingOf = new Map(match.bindings.map((binding) => [binding.identityId, binding]));
  // The earliest date of an unbound fact that could describe each unbound identity (its widened candidates).
  const unboundFactDate = new Map<string, string>();
  for (const { fact, candidates } of match.unbound) {
    for (const id of candidates) {
      if (bindingOf.has(id)) continue;
      const known = unboundFactDate.get(id);
      if (known === undefined || fact.date < known) unboundFactDate.set(id, fact.date);
    }
  }
  /** Proven receipt upper bound for vetoes: a bound receivedOn, else a registry postedOn, else first appearance + w. */
  const vetoBound = (identity: CardCreditIdentity): string | null => bindingOf.get(identity.id)?.receivedOn ?? identityReceiptBound(identity, w);
  const vetoed = (identity: CardCreditIdentity, C: string) => {
    const bound = vetoBound(identity);
    return bound !== null && bound <= C;
  };
  const provenBy = (identity: CardCreditIdentity, E: string) => {
    const binding = bindingOf.get(identity.id);
    return (binding !== undefined && binding.receivedOn <= E) || (identity.registryPostedOn !== null && identity.registryPostedOn <= E);
  };
  const amountOf = (identity: CardCreditIdentity) => identity.counting!.amountMinor;

  // ----- Issuer reassurances (5b01e72f's #269 findings 2–3): merged, never from a conflicting, corrected or undone read -----
  /** Payments undone after the fact: returned, possibly reversed, or a cancelled or dismissed pending payment. */
  const undone = identities.filter((identity) => identity.isPayment && identity.undo !== null);
  /**
   * Whether a payment can underlie an issuer reassurance dated `date` (Root's ruling (a) of 2026-11-08): it posted no
   * later than `date` + CURE_POSTING_DAYS (ruling (b)'s lag), or, with no posting date (an Amex CSV row, a pending
   * payment), its earliest transaction date is. A return outside that window never voids the reassurance.
   */
  const mayUnderlie = (identity: CardCreditIdentity, date: string) => {
    const evidence = identity.registryPostedOn ?? identity.transactionDates[0] ?? null;
    return evidence === null || evidence <= addDays(date, CURE_POSTING_DAYS);
  };
  /**
   * Whether a reassurance effective at `asOf`, about the cycle closing on `closingDate` (null: any), may rest on a payment
   * undone since: one not proven received on or before that close (no registry posting date on or before it), able to
   * underlie a reassurance of that date (`mayUnderlie`), and undone on or after the reassurance's date, or on an unknown
   * date.
   */
  const undoneSince = (asOf: CashPlanAsOf, closingDate: string | null) => undone.some((identity) =>
    (closingDate === null || identity.registryPostedOn === null || identity.registryPostedOn > closingDate)
    && mayUnderlie(identity, asOf.date)
    && (identity.undo!.date === null || identity.undo!.date >= asOf.date));
  /**
   * An issuer reassurance: `field` merged over the `scope` facts effective by `cutoffMs` (`mergeFacts`: the latest
   * financial as-of wins; a tie or an incomparable pair with different values gives none; a reassuring value replaces an
   * adverse one only under the clearing rule), accepted by `accept`. A payment it may rest on undone since, or an adverse
   * fact in `adverse` (P > 0 or a past-due phrase) strictly after it, leaves no reassurance: red stays possible. A latest
   * value the clearing rule outranked, or one that doesn't itself clear a standing adverse fact in `adverse` (tied,
   * incomparable, or an implicit capture after an explicit or statement fact), is contested: no reassurance, and nothing
   * red either (5b01e72f's #269 bcdcbfb6 candidates).
   */
  const reassurance = <T>(scope: readonly Fact[], cutoffMs: number, field: FieldReader<T>, accept: (value: T) => boolean,
    adverse: readonly Fact[], closingDate: string | null): Reassurance => {
    const merged = mergeField(scope.filter((fact) => fact.asOf.upperMs <= cutoffMs), field.pick, field.classify);
    if (merged.conflict || merged.fact === null || merged.value === null) return NO_REASSURANCE;
    const overruled = merged.outranked;
    const fact = accept(merged.value) ? merged.fact
      : overruled !== null && accept(field.pick(overruled.observation)!) ? overruled : null;
    if (fact === null) return NO_REASSURANCE;
    const valid = (z: Fact) => !undoneSince(z.asOf, closingDate);
    if (!valid(fact)) return NO_REASSURANCE;
    if (adverse.some((other) => isAdverseRead(other.observation) && compareAsOf(other.asOf, fact.asOf) === 'after')) return NO_REASSURANCE;
    if (fact === overruled || standingAdverse(adverse, valid, acceptedFacts).some((other) => !clears(fact, other))) return { fact: null, contested: true };
    return { fact, contested: false };
  };
  /** A read's own met phrase (paid or not-required), unless a payment it may rest on was undone since (R2b's "same read"). */
  const metPhraseHolds = (fact: Fact, closingDate: string | null) => MET_PHRASES.has(fact.observation.issuerPhrase)
    && !undoneSince(fact.asOf, closingDate);

  // ----- The obligation guard (k−1 at C_k), then the posted-date rule, oldest cycle first -----
  const dueStatedIn = (from: string, until: string | null) => accepted.some((o) => o.paymentDueDate !== null
    && o.paymentDueDate >= from && (until === null || o.paymentDueDate < until));
  /**
   * k−1 resolved by a reassuring read (an observed P = 0 or the not-required phrase, not held) effective in
   * (after, through]: no adverse fact by `through` is later than, tied with or incomparable to it, it clears every
   * standing adverse fact by then itself (so an implicit capture never clears an explicit or statement fact), and no
   * payment it may rest on was undone since.
   */
  const pZeroClearsWithin = (afterMs: number, throughMs: number, closingDate: string): boolean => {
    const upTo = acceptedFacts.filter((fact) => fact.asOf.upperMs <= throughMs);
    const valid = (z: Fact) => !undoneSince(z.asOf, closingDate);
    const standing = standingAdverse(upTo, valid, acceptedFacts);
    return upTo.some((z) => z.asOf.lowerMs > afterMs && canClear(z, NOT_REQUIRED_PHRASE, acceptedFacts) && valid(z)
      && !upTo.some((other) => isAdverseRead(other.observation) && compareAsOf(other.asOf, z.asOf) !== 'before')
      && standing.every((other) => clears(z, other)));
  };
  const ownPZeroAtClose = (cycle: CycleWork): boolean => {
    const own = cycle.linked.filter((o) => isPZero(o)
      && (o.sourceKind === 'statement-pdf' || (o.asOfSource === 'explicit' && asOfOf.get(o.id)!.date === cycle.C)));
    return own.some((o) => !undoneSince(asOfOf.get(o.id)!, null))
      && !acceptedFacts.some((fact) => isAdverseRead(fact.observation) && fact.asOf.date === cycle.C);
  };
  /** k−1 observed not-required by C_k: the not-required phrase only (spec v9 §3; never "paid"), merged and not undone. */
  const notRequiredByClose = (prev: CycleWork, closingDate: string): boolean => {
    const cutoff = endOfEasternDay(closingDate);
    return reassurance(facts(prev.linked), cutoff, PHRASE_FIELD, (value) => value === 'not-required',
      acceptedFacts.filter((fact) => fact.asOf.upperMs <= cutoff), prev.C).fact !== null;
  };

  cycles.forEach((cycle, index) => {
    if (cycle.status !== 'accepted') return;
    let kind: NonNullable<CashPlanCycle['predecessor']>['kind'];
    let previous: CycleWork | undefined;
    if (cycle.start !== null) {
      previous = cycles.find((other) => other.C === addDays(cycle.start!, -1));
      kind = previous === undefined ? 'uncaptured' : previous.status === 'accepted' ? 'captured' : 'held';
    } else {
      kind = index === 0 ? 'uncaptured' : 'unidentified';
    }
    const dueUntil = cycle.D ?? (cycles[index + 1]?.C ?? null);
    const dueKnownByFact = dueStatedIn(cycle.C, dueUntil);
    let resolved = false;
    // Resolved only from issuer evidence (a P = 0 read, the not-required phrase, Root's 14:05 exception), not by k−1's own
    // window or its statement asking for nothing: the payment that cured k−1 may itself post after C_k.
    let issuerOnly = false;
    if (kind === 'captured') {
      const prev = previous!;
      if (prev.M !== null && prev.assignedSum >= prev.M) resolved = true;
      else if ((prev.S !== null && prev.S <= 0) || prev.M === 0) resolved = true;
      else if (notRequiredByClose(prev, cycle.C)) resolved = issuerOnly = true;
      else if (!dueKnownByFact && prev.D !== null && prev.D < cycle.C) {
        resolved = pZeroClearsWithin(endOfEasternDay(prev.D), endOfEasternDay(cycle.C), prev.C);
        issuerOnly = resolved;
      }
    } else if (kind === 'uncaptured') {
      resolved = !dueKnownByFact && !graceWithheld && ownPZeroAtClose(cycle);
      issuerOnly = resolved;
    }
    cycle.guard = { kind, resolved };
    const cureUntil = addDays(cycle.C, CURE_POSTING_DAYS);
    for (const identity of counting) {
      const posting = identity.registryPostedOn;
      if (identity.counting!.status !== 'posted' || identity.counting!.uncertain || posting === null) continue;
      if (!(posting > cycle.C && posting <= cycle.windowThrough)) continue;
      if (vetoed(identity, cycle.C) || !resolved) continue;
      if (identity.transactionDates.some((date) => date <= cycle.C)) continue;
      const factDate = unboundFactDate.get(identity.id);
      if (!bindingOf.has(identity.id) && factDate !== undefined && factDate <= cycle.C) continue;
      // Root's ruling of 2026-11-08 (b): it may be k−1's late cure, received before the close, unless an issuer receipt
      // binding dates it after C_k.
      if (issuerOnly && posting <= cureUntil && !((bindingOf.get(identity.id)?.receivedOn ?? cycle.C) > cycle.C)) continue;
      cycle.assigned.add(identity.id);
    }
    cycle.assignedSum = sum([...cycle.assigned].map((id) => amountOf(identityById.get(id)!)));
  });
  const assignedTo = new Map<string, CycleWork>();
  for (const cycle of cycles) for (const id of cycle.assigned) assignedTo.set(id, cycle);

  // ----- Card-level delinquency (R1a / A9) -----
  const delinquency = cardDelinquency(acceptedFacts, counting, (identity) => identity.registryPostedOn,
    (fact) => undoneSince(fact.asOf, null));

  // ----- Per-cycle answers and items -----
  const newest = cycles[cycles.length - 1];
  const out: CashPlanCycle[] = [];
  const statementFactsOf = (cycle: CycleWork) => cycle.linked.filter((o) => o.sourceKind === 'statement-pdf'
    || (o.asOfSource === 'explicit' && asOfOf.get(o.id)!.date === cycle.C));
  cycles.forEach((cycle, index) => {
    const live = mergeLiveFacts(cycle.linked);
    const liveView = liveFactsView(live, isCurrent);
    const isNewest = cycle === newest;
    const successor = cycles[index + 1];
    const base = {
      closingDate: cycle.C,
      currency,
      status: cycle.status,
      heldReason: cycle.heldReason,
      periodStartDate: cycle.start,
      dueDate: cycle.D,
      statementBalanceMinor: cycle.S,
      minimumDueMinor: cycle.M,
      newest: isNewest,
      window: { after: cycle.C, through: cycle.windowThrough, closed: cycle.closed },
      coverageThrough: coverageThrough(coverage, cycle.C, today),
      predecessor: cycle.guard,
      live: liveView,
    };
    // Resolution for display: P-based routes apply to held cycles too. A later observed P = 0 resolves only when it
    // clears every adverse fact (the clearing rule): a later notice keeps the cycle open. Neither it nor the successor's
    // statement P = 0 resolves when a payment that may underlie it was undone since (Root's ruling (a) of 2026-11-08).
    const laterPZero = acceptedFacts.some((fact) => isPZero(fact.observation)
      && fact.asOf.lowerMs > endOfEasternDay(cycle.D ?? cycle.C)
      && !undoneSince(fact.asOf, cycle.C)
      && acceptedFacts.every((other) => !isAdverseRead(other.observation) || clears(fact, other)));
    const carried = successor !== undefined && successor.status === 'accepted'
      ? statementFactsOf(successor).filter((o) => o.pastDueMinor !== null && (o.pastDueMinor > 0 || !undoneSince(asOfOf.get(o.id)!, cycle.C)))
        .map((o) => o.pastDueMinor!) : [];
    if (cycle.status === 'held') {
      const shown = isNewest || !(laterPZero || carried.length > 0);
      out.push({
        ...base, state: 'held', shown,
        answers: { minimumMetByDue: null, minimumMetSoFar: null, statementSatisfied: null, inFlight: false, awaitingPosting: false, issuerShowsOwed: null },
        ledger: { proven: [], possible: [], provenMinor: 0, possibleMinor: 0 },
        attention: shown ? [item('A8', 'cycle', cycle.C, cycle.D, 'cycle', 'this statement is held: its facts disagree or could not be accepted')] : [],
      });
      return;
    }
    const D = cycle.D, M = cycle.M, S = cycle.S;
    // A and U at T, and A by D.
    const proven: CardCreditIdentity[] = [];
    const possible: CardCreditIdentity[] = [];
    for (const identity of counting) {
      if (vetoed(identity, cycle.C)) continue;
      const home = assignedTo.get(identity.id);
      if (home !== undefined && home !== cycle) continue;
      if (home === cycle && provenBy(identity, today)) proven.push(identity);
      else possible.push(identity);
    }
    const A = sum(proven.map(amountOf));
    const U = sum(possible.map(amountOf));
    const provenByDue = D === null ? 0 : sum([...cycle.assigned].map((id) => identityById.get(id)!).filter((identity) => provenBy(identity, D)).map(amountOf));
    // In flight and awaiting posting count only eligible pending rows: a scheduled or future-dated row is never evidence.
    const pendingHere = possible.filter((identity) => identity.counting!.status === 'pending' && !identity.counting!.uncertain
      && identity.madeBy !== null);
    // Not required only by an observed S ≤ 0 (note v2.9 §5.4 states). M = 0 is a met minimum, not this state (#269 finding 4).
    const notRequired = S !== null && S <= 0;
    const dueEnd = D === null ? null : endOfEasternDay(D);
    // Issuer reassurances for this cycle: merged at their cutoff ("now" takes every known fact), never from a conflicting
    // read, undone by a later adverse fact on the cycle or a later undo of a payment they may rest on, and contested by an
    // adverse fact they can't clear (#269 findings 2–3; bcdcbfb6 candidates 1–2).
    const cycleFacts = facts(cycle.linked);
    const allKnown = Number.POSITIVE_INFINITY;
    const phraseAll = reassurance(cycleFacts, allKnown, PHRASE_FIELD, (value) => MET_PHRASES.has(value), cycleFacts, cycle.C);
    const phraseByDue = dueEnd === null ? null
      : reassurance(cycleFacts, dueEnd, PHRASE_FIELD, (value) => MET_PHRASES.has(value), cycleFacts, cycle.C).fact;
    const remainingAll = reassurance(cycleFacts, allKnown, REMAINING_FIELD, (value) => value <= 0, cycleFacts, cycle.C);
    const phraseCurrent = phraseAll.fact !== null && isCurrent(phraseAll.fact);
    const issuerSatisfiedNow = remainingAll.fact !== null && isCurrent(remainingAll.fact);
    // A reassurance disputed by adverse evidence it can't clear is neither proof nor grounds for red; it needs
    // confirmation unless the ledger alone proves the minimum.
    const ledgerProves = M !== null && (A >= M || (D !== null && provenByDue >= M));
    const contested = (phraseAll.contested || remainingAll.contested) && !ledgerProves;
    const remainingCurrent = isCurrent(live.remaining.fact) ? live.remaining.value : null;
    const adverseAfterDue = dueEnd !== null && cycle.linked.some((o) => isAdverseRead(o) && asOfOf.get(o.id)!.lowerMs > dueEnd);
    const ledgerMetByDue = M !== null && D !== null && provenByDue >= M;
    const deadlineConflict = ledgerMetByDue && !notRequired && adverseAfterDue;
    const metByDue: boolean | null = D === null ? null : notRequired || (ledgerMetByDue && !deadlineConflict) || phraseByDue !== null;
    const metSoFar = notRequired || (M !== null && A >= M) || phraseCurrent || metByDue === true;
    const statementSatisfied = (S !== null && (S <= 0 || A >= S)) || issuerSatisfiedNow;
    const scheduledCovers = (value: { date: string | null; minor: number | null } | null) => value !== null && value.date !== null
      && D !== null && value.date <= D && M !== null && value.minor !== null && value.minor >= M;
    const autopayCovers = (value: { kind: CardAutopayKind; fixed: number | null } | null) => value !== null
      && (value.kind === 'on-statement' || value.kind === 'on-minimum' || (value.kind === 'on-fixed' && M !== null && value.fixed !== null && value.fixed >= M));
    const inFlightLedger = M !== null && pendingHere.length > 0 && A + sum(pendingHere.map(amountOf)) >= M;
    const inFlight = inFlightLedger
      || (isCurrent(live.scheduled.fact) && scheduledCovers(live.scheduled.value))
      || (isCurrent(live.autopay.fact) && autopayCovers(live.autopay.value));
    const madeByDue = D === null ? [] : pendingHere.filter((identity) => identity.madeBy !== null && Date.parse(identity.madeBy) <= dueEnd!);
    const awaitingPosting = M !== null && D !== null && madeByDue.length > 0 && provenByDue + sum(madeByDue.map(amountOf)) >= M;
    const guardFires = M !== null && A < M && A + U >= M;
    const guardClear = M !== null && A + U < M;
    const through = base.coverageThrough;
    const coverageOk = through !== null && through >= addDays(today, -COVERAGE_SLACK_DAYS);
    const afterDue = D !== null && today > D;
    const daysToDue = D === null ? null : daysBetween(today, D);
    // Payment-state evidence that conflicts (a tie or incomparable pair with different values) needs confirmation, and is
    // never red: a covering schedule, autopay or phrase remains plausible (#269 finding 1).
    const conflicts = liveView.conflicts.some((field) => PAYMENT_STATE_FIELDS.has(field)) || deadlineConflict || contested;
    // A10: only expired live facts would give assurance (a reassuring phrase, R ≤ 0, a covering schedule or autopay).
    const staleAssurance = !metSoFar && !inFlight && (
      (phraseAll.fact !== null && !phraseCurrent)
      || (remainingAll.fact !== null && !issuerSatisfiedNow)
      || (live.scheduled.fact !== null && !isCurrent(live.scheduled.fact) && scheduledCovers(live.scheduled.value))
      || (live.autopay.fact !== null && !isCurrent(live.autopay.fact) && autopayCovers(live.autopay.value)));
    // R2b's read: the bank showing a payment still due (current R > 0, the same read with no reassuring phrase that still
    // holds, and no covering schedule or autopay).
    const owedRead = live.remaining.fact;
    const issuerShowsOwed = remainingCurrent === null ? null
      : remainingCurrent > 0 && owedRead !== null && !metPhraseHolds(owedRead, cycle.C) && !phraseCurrent;
    const owedUncovered = issuerShowsOwed === true && owedRead !== null
      && !readCovers(owedRead.observation, D, M)
      && !(isCurrent(live.scheduled.fact) && scheduledCovers(live.scheduled.value))
      && !(isCurrent(live.autopay.fact) && autopayCovers(live.autopay.value));

    const items: CashPlanAttentionItem[] = [];
    let state: CardCycleState;
    const a5 = () => items.push(item('A5', 'cycle', cycle.C, D, null,
      "the rest of the statement isn't paid yet; interest may apply if it isn't paid by the due date"));
    if (notRequired) {
      state = 'not-required';
    } else if (D === null || M === null) {
      if (metSoFar) {
        state = statementSatisfied ? 'paid-in-full' : 'minimum-met';
      } else {
        state = 'unknown';
        items.push(item('A2', 'cycle', cycle.C, D, null, D === null ? "this statement's due date is unknown" : "this statement's minimum due is unknown"));
      }
    } else if (afterDue) {
      // After D only the deadline answer counts: a payment whose receipt by D isn't proven is never "paid".
      if (metByDue === true) {
        state = statementSatisfied ? 'paid-in-full' : 'minimum-met';
        if (rules.policy === 'statement' && !statementSatisfied && isNewest) a5();
      } else if (awaitingPosting) {
        state = 'awaiting-posting';
        items.push(item('A1c', 'cycle', cycle.C, D, null, 'a payment made by the due date is waiting to post'));
      } else {
        // R1b needs source-proven, receipt-complete coverage; no import source qualifies in A1, so it fails closed.
        state = 'past-due-unconfirmed';
        items.push(item('A11', 'cycle', cycle.C, D, 'past-due-unconfirmed',
          `Holdr can't confirm the minimum was received by the ${D} due date`));
      }
    } else if (metSoFar) {
      state = statementSatisfied ? 'paid-in-full' : 'minimum-met';
      if (rules.policy === 'statement' && !statementSatisfied && daysToDue !== null && daysToDue <= rules.amberDays) a5();
    } else if (awaitingPosting) {
      state = 'awaiting-posting';
      items.push(item('A1c', 'cycle', cycle.C, D, null, 'a payment made by the due date is waiting to post'));
    } else if (inFlight) {
      state = 'in-flight';
      items.push(item('A1b', 'cycle', cycle.C, D, null, 'a payment is in flight before the due date'));
    } else if (conflicts) {
      // A conflict could hide a covering schedule, autopay or phrase: confirmation, never a red shortfall (finding 1).
      state = 'confirmation-needed';
    } else if (guardFires) {
      state = 'payment-unconfirmed';
      items.push(item('A11', 'cycle', cycle.C, D, 'payment-unconfirmed', "a payment was seen; Holdr can't yet prove which statement it paid"));
    } else if (issuerSatisfiedNow) {
      // The bank currently shows the statement paid, but the ledger can't confirm it: the evidence disagrees, never red.
      state = 'confirmation-needed';
      items.push(item('A11', 'cycle', cycle.C, D, 'confirmation-needed', "the bank shows this statement paid; Holdr can't confirm the payment yet"));
    } else {
      state = coverageOk ? 'unpaid' : 'unknown-coverage';
      const dueSoonRed = daysToDue !== null && daysToDue >= 0 && daysToDue <= rules.redDays;
      const dueSoonAmber = daysToDue !== null && daysToDue >= 0 && daysToDue <= rules.amberDays;
      let red = false;
      if (dueSoonRed && M > 0 && guardClear && !staleAssurance) {
        if (coverageOk) {
          red = true;
          items.push(item('R2a', 'cycle', cycle.C, D, A + U === 0 ? 'no-payment-seen' : 'payments-dont-cover',
            A + U === 0 ? `no payment seen since the ${cycle.C} statement, through ${through}` : `payments seen through ${through} don't cover the minimum`));
        } else {
          items.push(item('A2b', 'cycle', cycle.C, D, null, through === null ? 'no card history covers this statement' : `card history is complete only through ${through}`));
        }
      }
      if (!red && dueSoonAmber && M > 0) items.push(item('A1', 'cycle', cycle.C, D, null, `due ${D}; the minimum isn't paid yet`));
    }
    if (staleAssurance) items.push(item('A10', 'cycle', cycle.C, D, null, "the bank's reassurance is more than 72 hours old"));
    if (conflicts && !notRequired) {
      if (state !== 'paid-in-full' && state !== 'minimum-met') state = 'confirmation-needed';
      // Never red, and never a "not paid yet" claim, from a contradiction: only the confirmation item stands.
      for (let i = items.length - 1; i >= 0; i--) if (['A11', 'R2a', 'A1'].includes(items[i].rule)) items.splice(i, 1);
      items.push(item('A11', 'cycle', cycle.C, D, 'confirmation-needed', 'the bank facts for this statement disagree; confirmation is needed'));
    }
    // R2b on a linked cycle: issuer evidence, no coverage needed; the ledger must not show the minimum met, nothing in
    // flight, and (so widening never creates red) every possible payment counted in full must leave M uncovered.
    const r2bLedgerClear = M === null ? !phraseCurrent && !inFlight : !metSoFar && !inFlight && guardClear;
    if (!conflicts && D !== null && daysToDue !== null && daysToDue >= 0 && daysToDue <= rules.redDays && owedUncovered && r2bLedgerClear && !notRequired) {
      items.push(item('R2b', 'cycle', cycle.C, D, null, `${card.issuer} showed a payment still due on ${D}, as of ${owedRead!.asOf.value}`));
    }
    // Retention: the newest cycle, and every older cycle not yet resolved.
    const resolved = notRequired || (M !== null && cycle.assignedSum >= M) || metByDue === true || laterPZero || carried.length > 0;
    const shown = isNewest || !resolved;
    if (!shown && carried.some((p) => p > 0)) state = 'carried-forward';
    else if (!shown && !notRequired && metByDue !== true && M !== null && cycle.assignedSum >= M) state = 'paid-late';
    out.push({
      ...base,
      state,
      shown,
      answers: {
        minimumMetByDue: metByDue,
        minimumMetSoFar: M === null && !metSoFar ? null : metSoFar,
        statementSatisfied: S === null && remainingCurrent === null && !issuerSatisfiedNow ? null : statementSatisfied,
        inFlight,
        awaitingPosting,
        issuerShowsOwed,
      },
      ledger: {
        proven: proven.map((identity) => identity.id),
        possible: possible.map((identity) => identity.id),
        provenMinor: A,
        possibleMinor: U,
      },
      attention: shown ? items : [],
    });
  });

  // ----- Unlinked bank reads: R2b only -----
  const bankReads: CashPlanBankRead[] = [];
  for (const due of [...new Set(unlinked.map((o) => o.paymentDueDate!))].sort(byText)) {
    const reads = unlinked.filter((o) => o.paymentDueDate === due);
    const live = mergeLiveFacts(reads);
    const minimums = [...new Set(reads.map((o) => o.minimumDueMinor).filter((m): m is number => m !== null))];
    const M = minimums.length === 1 ? minimums[0] : null;
    const owed = live.remaining.fact;
    // The met phrase as an issuer reassurance: merged, never from a conflicting or contested read, and undone by a later
    // adverse read or a later undo of a payment it may rest on (5b01e72f's #269 8bd62afe candidate 3).
    const readFacts = facts(reads);
    const phraseMet = reassurance(readFacts, Number.POSITIVE_INFINITY, PHRASE_FIELD, (value) => MET_PHRASES.has(value), readFacts, null);
    const remainingPaid = reassurance(readFacts, Number.POSITIVE_INFINITY, REMAINING_FIELD, (value) => value <= 0, readFacts, null);
    const phraseCurrent = phraseMet.fact !== null && isCurrent(phraseMet.fact);
    const daysToDue = daysBetween(today, due);
    const attention: CashPlanAttentionItem[] = [];
    const remainingCurrent = isCurrent(owed) ? live.remaining.value : null;
    const view = liveFactsView(live, isCurrent);
    // Conflicting reads are never red: a covering schedule, autopay or phrase remains plausible (#269 finding 1). Nor is
    // a contested reassurance (an implicit R ≤ 0 or met phrase after an explicit owed or past-due read): confirmation.
    const contestedRead = remainingPaid.contested || phraseMet.contested;
    const conflicted = view.conflicts.some((field) => PAYMENT_STATE_FIELDS.has(field)) || contestedRead;
    const coveredNow = (isCurrent(live.scheduled.fact) && live.scheduled.value !== null && live.scheduled.value.date !== null
        && live.scheduled.value.date <= due && (M === null || (live.scheduled.value.minor !== null && live.scheduled.value.minor >= M)))
      || (isCurrent(live.autopay.fact) && live.autopay.value !== null && (live.autopay.value.kind === 'on-statement'
        || live.autopay.value.kind === 'on-minimum'
        || (live.autopay.value.kind === 'on-fixed' && (M === null || (live.autopay.value.fixed !== null && live.autopay.value.fixed >= M)))));
    if (conflicted) {
      attention.push(item('A11', 'bank-read', null, due, 'confirmation-needed', 'the bank facts for this due date disagree; confirmation is needed'));
    } else if (owed !== null && remainingCurrent !== null && remainingCurrent > 0 && !phraseCurrent
      && !metPhraseHolds(owed, null) && !readCovers(owed.observation, due, M) && !coveredNow
      && daysToDue >= 0 && daysToDue <= rules.redDays) {
      attention.push(item('R2b', 'bank-read', null, due, null, `${card.issuer} showed a payment still due on ${due}, as of ${owed.asOf.value}`));
    }
    // A same-read (current) not-required phrase with R > 0: the minimum is met, the statement isn't (statement policy).
    if (!conflicted && rules.policy === 'statement' && phraseCurrent && remainingCurrent !== null && remainingCurrent > 0
      && daysToDue >= 0 && daysToDue <= rules.amberDays) {
      attention.push(item('A5', 'bank-read', null, due, null, "the rest of the statement isn't paid yet; interest may apply if it isn't paid by the due date"));
    }
    bankReads.push({ dueDate: due, minimumDueMinor: M, live: view, attention });
  }

  const cardItems: CashPlanAttentionItem[] = [];
  if (delinquency !== null) {
    if (delinquency.downgraded === null) {
      cardItems.push(item('R1a', 'card', null, null, null, `${card.issuer} shows this card past due, as of ${delinquency.financialAsOf}`));
    } else {
      cardItems.push(item('A9', 'card', null, null, delinquency.downgraded, delinquency.downgraded === 'implicit-later'
        ? "the bank's page shows no past due; waiting for a dated confirmation"
        : 'payments posted after the past-due notice may cover it; waiting for a dated confirmation'));
    }
  }
  if (heldRows.length > 0) cardItems.push(item('A8', 'card', null, null, 'observations', 'some bank facts for this card are held'));
  const cyclesNewestFirst = [...out].reverse();
  return {
    cardAccountId: card.id,
    mode,
    asOf: new Date(T).toISOString(),
    today,
    delinquency,
    cycles: cyclesNewestFirst,
    bankReads,
    attention: [...cardItems, ...cyclesNewestFirst.flatMap((cycle) => cycle.attention), ...bankReads.flatMap((read) => read.attention)],
    bindings: match.bindings,
    heldObservations: heldRows.length,
  };
}

/** Whether the read itself shows a scheduled payment or autopay that covers the minimum (unknown M: any such counts). */
function readCovers(o: CardScheduleObservation, due: string | null, M: number | null): boolean {
  const scheduled = o.scheduledPaymentDate !== null && (due === null || o.scheduledPaymentDate <= due)
    && (M === null || (o.scheduledPaymentMinor !== null && o.scheduledPaymentMinor >= M));
  const autopay = o.autopay === 'on-statement' || o.autopay === 'on-minimum'
    || (o.autopay === 'on-fixed' && (M === null || (o.autopayFixedMinor !== null && o.autopayFixedMinor >= M)));
  return scheduled || autopay;
}

function item(rule: CashPlanRuleId, subject: CashPlanAttentionItem['subject'], closingDate: string | null, dueDate: string | null,
  reason: string | null, copy: string): CashPlanAttentionItem {
  return { rule, severity: CASH_PLAN_RED_RULES.includes(rule) ? 'red' : 'amber', subject, closingDate, dueDate, reason, copy };
}

function liveFactsView(live: LiveMerge, isCurrent: (fact: Fact | null) => boolean): CashPlanLiveFacts {
  const fields = Object.entries(live) as Array<[keyof LiveMerge, MergedField<unknown>]>;
  const latest = fields.map(([, field]) => field.fact).filter((fact): fact is Fact => fact !== null)
    .sort((a, b) => b.asOf.lowerMs - a.asOf.lowerMs)[0] ?? null;
  return {
    remainingStatementMinor: live.remaining.value,
    pastDueMinor: live.pastDue.value,
    currentBalanceMinor: live.currentBalance.value,
    autopay: live.autopay.value?.kind ?? null,
    autopayFixedMinor: live.autopay.value?.fixed ?? null,
    scheduledPaymentDate: live.scheduled.value?.date ?? null,
    scheduledPaymentMinor: live.scheduled.value?.minor ?? null,
    issuerPhrase: live.phrase.value,
    lastPaymentDate: live.lastPayment.value?.date ?? null,
    lastPaymentMinor: live.lastPayment.value?.minor ?? null,
    asOf: latest?.asOf.value ?? null,
    current: isCurrent(latest),
    conflicts: fields.filter(([, field]) => field.conflict).map(([name]) => name).sort(),
  };
}

/** E_c: the last day of committed coverage continuous from the day after the close, capped at today. */
export function coverageThrough(coverage: readonly CardCoverageRange[], closingDate: string, today: string): string | null {
  const start = addDays(closingDate, 1);
  if (start > today) return today;
  const range = mergeCardCoverage(coverage).find((item) => item.start <= start && item.end >= start);
  if (!range) return null;
  return range.end < today ? range.end : today;
}

/**
 * `cardDelinquency`: the latest issuer fact showing P > 0 or a past-due phrase that no reassuring fact clears (the
 * clearing rule). Pending payments, owner assertions and cycle resolutions never clear it, nor does a P = 0 read that a
 * payment undone since may underlie (`voided`; Root's ruling (a) of 2026-11-08). It is downgraded to A9 by an
 * implicit-capture page with a strictly later capture showing no past due, or by counting posted payments with a
 * source-proven posting date after the notice's date that cover its P.
 */
function cardDelinquency(
  facts: readonly Fact[],
  counting: readonly CardCreditIdentity[],
  postedOn: (identity: CardCreditIdentity) => string | null,
  voided: (fact: Fact) => boolean,
): CashPlanDelinquency | null {
  const adverse = facts.filter((fact) => isAdverseRead(fact.observation));
  const reassuring = facts.filter((fact) => isReassuringRead(fact.observation) && fact.observation.pastDueMinor === 0 && !voided(fact));
  const standing = adverse.filter((fact) => !reassuring.some((z) => clears(z, fact)));
  if (standing.length === 0) return null;
  const latest = [...standing].sort((a, b) => b.asOf.lowerMs - a.asOf.lowerMs || b.asOf.upperMs - a.asOf.upperMs
    || (a.observation.id < b.observation.id ? -1 : 1))[0];
  const o = latest.observation;
  let downgraded: CashPlanDelinquency['downgraded'] = null;
  if (reassuring.some((z) => z.observation.asOfSource === 'implicit-capture'
    && Date.parse(z.observation.observedAt) > Date.parse(o.observedAt)
    && standing.every((fact) => Date.parse(z.observation.observedAt) > Date.parse(fact.observation.observedAt)))) {
    downgraded = 'implicit-later';
  } else if (o.pastDueMinor !== null && o.pastDueMinor > 0) {
    const after = sum(counting.filter((identity) => identity.counting!.status === 'posted' && !identity.counting!.uncertain)
      .filter((identity) => { const date = postedOn(identity); return date !== null && date > latest.asOf.date; })
      .map((identity) => identity.counting!.amountMinor));
    if (after >= o.pastDueMinor) downgraded = 'payments-after';
  }
  return {
    pastDueMinor: o.pastDueMinor,
    phrase: o.issuerPhrase === 'past-due' ? 'past-due' : null,
    financialAsOf: latest.asOf.value,
    asOfSource: o.asOfSource,
    sourceKind: o.sourceKind,
    downgraded,
  };
}
