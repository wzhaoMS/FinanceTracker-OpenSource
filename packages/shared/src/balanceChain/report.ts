/**
 * The balance-chain report (`holdr.balance-chain-report` v1; design W6 v1 §6): what the read-only CLI prints and the
 * read-only GET answers, one account per entry. Value-free by construction, and checked by a strict schema before it
 * leaves (`formatBalanceChainReport`): only listed keys; whole numbers 0–9,999; strings only as dates, account keys,
 * issuer slugs, a last four under `last4`, letter-hex refs and digests, and closed words; no run of five or more digits
 * anywhere. Never an amount, a balance, a residual or a band.
 *
 * The line printed with every account's `detail` is the baseline W4's admission reads (`parseBalanceChainBaseline`).
 */
import { sha256, toLetterHex } from '../cardDedupe.js';
import type { BalanceChainBaseline, BalanceChainBaselineAccount } from './admission.js';
import {
  BALANCE_ANCHOR_KINDS,
  BALANCE_CHAIN_VERIFIER,
  BALANCE_STEP_REASONS,
  type BalanceChainAnchorRef,
  type BalanceChainResult,
  type BalanceChainState,
  type BalanceChainStep,
  type BalanceStepReason,
  type BalanceStepVerdict,
} from './verify.js';

export const BALANCE_CHAIN_REPORT_FORMAT = 'holdr.balance-chain-report';
export const BALANCE_CHAIN_REPORT_VERSION = 1;

export type BalanceChainStoreState = 'present' | 'absent' | 'conflict';

export interface BalanceChainReportAccount {
  kind: 'card' | 'checking';
  /** `balanceChainAccountKey(id)`: the id itself when it is a standard `card-acct-`/`chk-acct-` id. */
  id: string;
  /** The issuer or bank slug, or `other` when it is not lowercase words. */
  issuer: string;
  last4: string | null;
  status: 'active' | 'closed';
  readable: boolean;
  dateBasis: 'posting' | 'timing';
  state: BalanceChainState;
  result: 'pass' | 'fail' | 'unknown';
  reconciledFrom: string | null;
  reconciledThrough: string | null;
  latestRun: { from: string; through: string; steps: number } | null;
  latestAnchor: string | null;
  latestStatementAnchor: string | null;
  history: { from: string; through: string; uncoveredRuns: number } | null;
  anchors: {
    total: number;
    chained: number;
    beforeHistory: number;
    conflicted: number;
    /** Statement facts from an extractor version that isn't on the allowlist. */
    untrusted: number;
    /** Statement facts that can't anchor: held for another reason, no C or S, or another currency. */
    excluded: number;
    byKind: Record<string, number>;
  };
  steps: { total: number; pass: number; fail: number; unknown: number; byReason: Record<string, number> };
  firstProblem: { from: string; to: string; verdict: BalanceStepVerdict; reason: BalanceStepReason } | null;
  detail?: { anchors: BalanceChainAnchorRef[]; steps: BalanceChainStep[] };
}

export interface BalanceChainReport {
  format: typeof BALANCE_CHAIN_REPORT_FORMAT;
  version: typeof BALANCE_CHAIN_REPORT_VERSION;
  verifier: typeof BALANCE_CHAIN_VERIFIER;
  rules: string;
  timingWindowDays: number;
  stores: { checking: BalanceChainStoreState; statementFacts: BalanceChainStoreState };
  accounts: BalanceChainReportAccount[];
}

const STANDARD_ID = /^(?:card|chk)-acct-[a-p]{32}$/;
const DIGEST = /^lh1:[a-p]{64}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const WORD = /^[a-z]+(?:-[a-z]+)*$/;
const LAST4 = /^[0-9]{4}$/;
const REF = /^(?:lh1:[a-p]{64}|chk-imp-[a-p]{32})$/;
const encoder = new TextEncoder();

/** An account's key in reports and baselines: its id when standard, else a letter-hex digest of it (no digit leaves). */
export function balanceChainAccountKey(id: string): string {
  return STANDARD_ID.test(id) ? id : `lh1:${toLetterHex(sha256(encoder.encode(JSON.stringify(['holdr.balance-chain-account', id]))))}`;
}

/** One account's report entry, from its verdicts and identity. */
export function balanceChainReportAccount(
  identity: { kind: 'card' | 'checking'; id: string; issuer: string; last4: string | null; status: 'active' | 'closed' },
  result: BalanceChainResult,
  counts: { untrusted: number; excluded: number },
  withDetail: boolean,
): BalanceChainReportAccount {
  const byReason: Record<string, number> = {};
  for (const step of result.steps) byReason[step.reason] = (byReason[step.reason] ?? 0) + 1;
  const problem = result.steps.find((step) => step.verdict !== 'pass');
  const account: BalanceChainReportAccount = {
    kind: identity.kind,
    id: balanceChainAccountKey(identity.id),
    issuer: WORD.test(identity.issuer) ? identity.issuer : 'other',
    last4: identity.last4 !== null && LAST4.test(identity.last4) ? identity.last4 : null,
    status: identity.status === 'closed' ? 'closed' : 'active',
    readable: result.readable,
    dateBasis: result.dateBasis,
    state: result.state,
    result: result.result,
    reconciledFrom: result.reconciledFrom,
    reconciledThrough: result.reconciledThrough,
    latestRun: result.latestRun,
    latestAnchor: result.latestAnchor,
    latestStatementAnchor: result.latestStatementAnchor,
    history: result.history,
    anchors: {
      total: result.anchors.total,
      chained: result.anchors.chained,
      beforeHistory: result.anchors.beforeHistory,
      conflicted: result.anchors.conflicted,
      untrusted: counts.untrusted,
      excluded: counts.excluded,
      byKind: Object.fromEntries(Object.entries(result.anchors.byKind).filter((entry): entry is [string, number] => entry[1] !== undefined)),
    },
    steps: {
      total: result.steps.length,
      pass: result.steps.filter((step) => step.verdict === 'pass').length,
      fail: result.steps.filter((step) => step.verdict === 'fail').length,
      unknown: result.steps.filter((step) => step.verdict === 'unknown').length,
      byReason,
    },
    firstProblem: problem ? { from: problem.from, to: problem.to, verdict: problem.verdict, reason: problem.reason } : null,
  };
  if (withDetail) account.detail = { anchors: result.anchors.list.map((anchor) => ({ ...anchor })), steps: result.steps.map((step) => ({ ...step })) };
  return account;
}

// ---------------------------------------------------------------------------------------------------------------------
// The strict schema
// ---------------------------------------------------------------------------------------------------------------------

type Check = (value: unknown) => boolean;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count: Check = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 9_999;
const date: Check = (value) => typeof value === 'string' && DATE.test(value);
const optionalDate: Check = (value) => value === null || date(value);
const oneOf = (...values: readonly unknown[]): Check => (value) => values.includes(value);
const matches = (pattern: RegExp): Check => (value) => typeof value === 'string' && pattern.test(value);
const nullable = (check: Check): Check => (value) => value === null || check(value);
const list = (check: Check): Check => (value) => Array.isArray(value) && value.every(check);
/** An object with exactly the `required` keys plus any of the `optional` ones, each passing its check. */
const shape = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => (value) => {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  if (!Object.keys(required).every((name) => Object.hasOwn(value, name))) return false;
  return keys.every((name) => {
    const check = Object.hasOwn(required, name) ? required[name] : Object.hasOwn(optional, name) ? optional[name] : undefined;
    return check !== undefined && check(value[name]);
  });
};
/** A map of closed words to counts. */
const counted = (words: readonly string[]): Check => (value) => record(value)
  && Object.entries(value).every(([name, item]) => words.includes(name) && count(item));

const VERDICTS = ['pass', 'fail', 'unknown'] as const;
const STATES = ['failing', 'balanced', 'partly-balanced', 'not-yet-checked'] as const;
const STORES = ['present', 'absent', 'conflict'] as const;

const anchorRef = shape({
  date, kind: oneOf(...BALANCE_ANCHOR_KINDS), source: oneOf('statement-facts', 'checking-import'),
  rank: (value) => typeof value === 'number' && [1, 2, 3, 4].includes(value), state: oneOf('chained', 'before-history', 'conflict'), ref: matches(REF),
  refs: (value) => Array.isArray(value) && value.length >= 1 && value.length <= 16 && value.every(matches(REF)),
});
const step = shape(
  { from: date, to: date, verdict: oneOf(...VERDICTS), reason: oneOf(...BALANCE_STEP_REASONS) },
  { pin: matches(DIGEST), timingWouldExplain: (value) => typeof value === 'boolean' },
);
const account = shape({
  kind: oneOf('card', 'checking'),
  id: (value) => typeof value === 'string' && (STANDARD_ID.test(value) || DIGEST.test(value)),
  issuer: matches(WORD),
  last4: nullable(matches(LAST4)),
  status: oneOf('active', 'closed'),
  readable: (value) => typeof value === 'boolean',
  dateBasis: oneOf('posting', 'timing'),
  state: oneOf(...STATES),
  result: oneOf(...VERDICTS),
  reconciledFrom: optionalDate,
  reconciledThrough: optionalDate,
  latestRun: nullable(shape({ from: date, through: date, steps: count })),
  latestAnchor: optionalDate,
  latestStatementAnchor: optionalDate,
  history: nullable(shape({ from: date, through: date, uncoveredRuns: count })),
  anchors: shape({
    total: count, chained: count, beforeHistory: count, conflicted: count, untrusted: count, excluded: count, byKind: counted(BALANCE_ANCHOR_KINDS),
  }),
  steps: shape({ total: count, pass: count, fail: count, unknown: count, byReason: counted(BALANCE_STEP_REASONS) }),
  firstProblem: nullable(shape({ from: date, to: date, verdict: oneOf(...VERDICTS), reason: oneOf(...BALANCE_STEP_REASONS) })),
}, { detail: shape({ anchors: list(anchorRef), steps: list(step) }) });
const report = shape({
  format: oneOf(BALANCE_CHAIN_REPORT_FORMAT),
  version: oneOf(BALANCE_CHAIN_REPORT_VERSION),
  verifier: oneOf(BALANCE_CHAIN_VERIFIER),
  rules: matches(DIGEST),
  timingWindowDays: count,
  stores: shape({ checking: oneOf(...STORES), statementFacts: oneOf(...STORES) }),
  accounts: list(account),
});

/** Whether `value` is a report the strict schema allows, with no run of five or more digits anywhere in its JSON. */
export function isValueFreeBalanceChainReport(value: unknown): value is BalanceChainReport {
  return report(value) && !/[0-9]{5,}/.test(JSON.stringify(value));
}

/** The report as one JSON line, or null when anything in it falls outside the strict schema or could carry a value. */
export function formatBalanceChainReport(value: BalanceChainReport): string | null {
  return isValueFreeBalanceChainReport(value) ? `${JSON.stringify(value)}\n` : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------------------------------------------------

/** A refusal naming why, never what: the baseline is never quoted. */
export class BalanceChainBaselineRefusal extends Error {
  readonly code: string;
  constructor(code: 'baseline-not-json' | 'baseline-schema' | 'baseline-summary-only' | 'baseline-duplicate-account') {
    super(`balance-chain baseline refused: ${code}`);
    this.code = code;
  }
}

/**
 * The baseline: one `holdr-balance-chain report --detail` line (a trailing newline allowed), every account with its
 * detail. A summary line, anything the schema refuses, or an account listed twice is refused. Whether it matches this
 * build's verifier and rules is the admission's question (a stale baseline holds).
 */
export function parseBalanceChainBaseline(text: string): BalanceChainBaseline {
  let value: unknown;
  try {
    value = JSON.parse(text.endsWith('\n') ? text.slice(0, -1) : text);
  } catch {
    throw new BalanceChainBaselineRefusal('baseline-not-json');
  }
  if (!isValueFreeBalanceChainReport(value)) throw new BalanceChainBaselineRefusal('baseline-schema');
  const accounts = new Map<string, BalanceChainBaselineAccount>();
  for (const entry of value.accounts) {
    if (!entry.detail) throw new BalanceChainBaselineRefusal('baseline-summary-only');
    if (accounts.has(entry.id)) throw new BalanceChainBaselineRefusal('baseline-duplicate-account');
    accounts.set(entry.id, {
      id: entry.id,
      reconciledThrough: entry.reconciledThrough,
      steps: entry.detail.steps.map((item) => ({ from: item.from, to: item.to, verdict: item.verdict, reason: item.reason, ...(item.pin ? { pin: item.pin } : {}) })),
    });
  }
  return { verifier: value.verifier, rules: value.rules, accounts };
}
