/**
 * A Discover card's statement PDFs (parsed by discoverStatement.ts) to one redacted `holdr.card-import` payload per
 * statement, for the existing import path (the Spending tab's Import, or POST /card-imports/preview and /commit), with
 * a value-free report. Pure: no file system, clock or network; the converter CLI reads the PDFs.
 *
 * One payload per statement, so each carries its own statement figures (Previous and New Balance, charges and
 * credits) for the import's own reconciliation, and its coverage is its period: a month without a statement stays a
 * gap in the card's history instead of being claimed as imported. Every row is posted (a statement lists what posted
 * in its period). Rows carry no issuer reference, so they are keyed by content (date, amount, description and their
 * place among identical rows), as for a Wells Fargo CSV: importing a statement again adds nothing.
 *
 * Kinds: the statement's own layout says which rows are purchases (`purchase`). A row under Payments and Credits is
 * a card payment, a refund or another credit by its wording (classifyCardKind, as for every other export). A credit
 * balance refund (Discover paying a credit balance out, or taking that back) is `other` in either section.
 *
 * Across statements, a statement is held (refused, never written) when:
 * - it is the same file as another (`duplicate`), or prints the same period with the same rows (`duplicate`) or with
 *   other rows (`overlap`, both held), or its period overlaps any other's, nested or not (`overlap`, every one held):
 *   every statement of the card whose period was read counts, one held for another reason included;
 * - it prints a row another statement prints too, the same date, amount and description (`duplicate`, both held): the
 *   import keys such rows by their content, so it would keep one and drop the other as already imported;
 * - it follows the statement before it without a gap but its Previous Balance is not that statement's New Balance
 *   (`chain`, both held);
 * - it follows a gap (`unproven-gap`), unless the owner accepts the gaps (`acceptGaps`). No statement proves the days
 *   between two others empty: Discover issues none for a period without activity and without a balance, but equal
 *   balances on both sides (even zero) allow any activity that nets to nothing, and a statement may simply not have
 *   been downloaded. Accepted, a gap stays a gap: the payloads' coverage never includes its days, so Holdr shows them
 *   as missing history;
 * - its coverage would reach past the periods of the statements written with it (`coverage`): a row dated before its
 *   period (a charge that posted later) stretches a payload's coverage back to it, which is no claim while a written
 *   statement covers that day, but a false one in a gap or before the first statement.
 * So the payloads' coverage is the union of the written statements' periods and never more, and every day between two
 * of them is reported as uncovered. Holdr keeps each import's coverage apart and joins only ranges that touch, so it
 * shows those days as not imported, never as days without spending.
 * Every gap is reported with its dates, its day count and whether the balance carried across it (one that did not
 * proves a statement with activity is missing), never as proven.
 */
import {
  buildCardImportPayload,
  CARD_IMPORT_KINDS,
  CardImportError,
  findCardImportSensitivePaths,
  reconcileCardImport,
  sanitizeCardText,
  serializeCardImportPayload,
  type CardImportDraftRow,
  type CardImportPayload,
} from '../cardImport.js';
import type { CardTransactionKind } from '../types.js';
import { classifyCardKind } from './classify.js';
import {
  DISCOVER_ISSUER,
  DISCOVER_STATEMENT_SOURCE,
  DiscoverStatementError,
  parseDiscoverStatement,
  type DiscoverLayout,
  type DiscoverRefusalReason,
  type ParsedDiscoverStatement,
} from './discoverStatement.js';
import { showsCardDigits } from './leaks.js';
import type { StatementPdfPage } from './parsed.js';
import { dateOfDay, dayNumber } from './statementDates.js';

export const DISCOVER_STATEMENT_TOOL_VERSION = '1.0.0';
export const DISCOVER_STATEMENT_PARSER = `holdr-discover-statement@${DISCOVER_STATEMENT_TOOL_VERSION}`;

export interface DiscoverStatementFile {
  /** A label for messages (`file 3`), never a file name. */
  name: string;
  /** SHA-256 of the file's bytes: the same file given twice is one statement. */
  digest: string;
  pages: readonly StatementPdfPage[];
  /** Why the file could not be read as a PDF at all (value-free); it is then held as no statement. */
  unreadable?: string | null;
}

export interface DiscoverConvertOptions {
  /** The card's last four digits: a statement for another card is held. */
  card: string;
  /**
   * The owner accepts every gap between the statements as missing history (no statement covers it): the statement
   * after a gap is then written instead of held. Never a default: nothing in the statements proves a gap empty.
   */
  acceptGaps?: boolean;
}

export type DiscoverHoldReason = DiscoverRefusalReason | 'other-card' | 'card-data' | 'duplicate' | 'overlap' | 'chain' | 'unproven-gap' | 'coverage';

export interface DiscoverStatementOutcome {
  name: string;
  status: 'accepted' | 'held';
  reason: DiscoverHoldReason | null;
  /** Why it was held: names lines, fields and other files, never a value. */
  message: string | null;
  layout: DiscoverLayout | null;
  period: { start: string; end: string } | null;
  rows: number;
  noActivity: boolean;
  /** Read whole and reconciled to the cent on its own (before the checks across statements). */
  reconciled: boolean;
}

/** Days between two statements' periods, by dates only. */
export interface DiscoverGap {
  /** The Close Date before the gap and the Open Date after it. */
  after: string;
  before: string;
  /** The gap's first and last day: no statement covers them, and no payload's coverage does. */
  from: string;
  to: string;
  days: number;
  /** The Previous Balance after the gap is the New Balance before it; when not, a statement with activity is missing. */
  balanceCarried: boolean;
  /** Always false: no statement proves the days between two others had no activity (see the module comment). */
  proven: false;
  /** The owner accepted the gap as missing history (`acceptGaps`), so the statement after it is written. */
  accepted: boolean;
}

export interface DiscoverConvertReport {
  parser: string;
  issuer: string;
  card: string;
  statements: {
    read: number;
    accepted: number;
    held: number;
    heldByReason: Partial<Record<DiscoverHoldReason, number>>;
    /** Statements that were read whole and reconciled on their own, accepted or later held across statements. */
    reconciled: number;
  };
  /** Accepted statements by layout. */
  layouts: Partial<Record<DiscoverLayout, number>>;
  /** From the first accepted statement's Open Date to the last one's Close Date (gaps inside are listed below). */
  periods: { first: string; last: string } | null;
  /** Rows of the accepted statements. */
  rows: { total: number; byKind: Record<CardTransactionKind, number>; first: string | null; last: string | null };
  noActivityStatements: number;
  /** Accepted statements with a row dated before their period (a charge that posted later): their coverage starts there. */
  coverageWidened: number;
  /**
   * What the payloads claim, as Holdr will record it: `ranges`, the union of their coverage (the written statements'
   * periods, joined where adjacent), and `uncovered`, every window between two ranges, which no payload covers (Holdr
   * shows such days as not imported, never as days without spending).
   */
  coverage: { ranges: Array<{ start: string; end: string }>; uncovered: Array<{ from: string; to: string; days: number }> };
  continuity: { adjacent: number; gaps: DiscoverGap[]; overlaps: number; duplicates: number; chainBreaks: number; repeatedRows: number };
  files: DiscoverStatementOutcome[];
}

export interface DiscoverStatementPayload {
  name: string;
  period: { start: string; end: string };
  payload: CardImportPayload;
  /** Canonical JSON, exactly as written to disk. */
  json: string;
}

export interface DiscoverConvertResult {
  report: DiscoverConvertReport;
  /** One payload per accepted statement, oldest first. */
  payloads: DiscoverStatementPayload[];
}

export class DiscoverConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoverConvertError';
  }
}

interface Candidate {
  outcome: DiscoverStatementOutcome;
  parsed: ParsedDiscoverStatement;
  payload: DiscoverStatementPayload;
  coverageWidened: boolean;
}

const hold = (outcome: DiscoverStatementOutcome, reason: DiscoverHoldReason, message: string) => {
  outcome.status = 'held';
  outcome.reason = reason;
  outcome.message = message;
};

/** Sorted, disjoint day ranges covering the same days as `ranges`: overlapping and adjacent ones joined. */
function mergeRanges(ranges: ReadonlyArray<{ start: string; end: string }>): Array<{ start: string; end: string }> {
  const merged: Array<{ start: string; end: string }> = [];
  for (const range of [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))) {
    const last = merged[merged.length - 1];
    if (last && dayNumber(range.start) <= dayNumber(last.end) + 1) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/**
 * Discover paying a credit balance out to the cardholder (printed under Purchases, as it raises the balance to zero)
 * or taking such a payout back (under Payments and Credits): money moved between the card and its holder, never
 * spending nor a merchant's refund, so `other` (listed, never counted) whichever section prints it.
 */
const CREDIT_BALANCE_REFUND = /\bCREDIT\s+BALANCE\s+REFUND\b/i;

/** The kind of a row: purchases as the statement prints them; credits by their wording; credit balance payouts `other`. */
function kindOf(row: ParsedDiscoverStatement['rows'][number]): CardTransactionKind {
  const description = sanitizeCardText(row.description, 500) ?? '';
  if (CREDIT_BALANCE_REFUND.test(description)) return 'other';
  if (row.section === 'purchases') return 'purchase';
  return classifyCardKind({ amountMinor: row.amountMinor, description, typeHint: null });
}

/** One statement's payload, or why it cannot be written: never a value, only rows' places. */
function payloadOf(file: DiscoverStatementFile, parsed: ParsedDiscoverStatement):
  { payload: DiscoverStatementPayload; coverageWidened: boolean } | { reason: DiscoverHoldReason; message: string } {
  const rows: CardImportDraftRow[] = parsed.rows.map((row) => ({
    transactionDate: row.transactionDate,
    postedDate: row.postedDate,
    status: 'posted',
    amountMinor: row.amountMinor,
    kind: kindOf(row),
    description: row.description,
    merchant: null,
    issuerCategory: row.category,
    externalId: null,
  }));
  const { summary } = parsed;
  let built: ReturnType<typeof buildCardImportPayload>;
  try {
    built = buildCardImportPayload({
      source: DISCOVER_STATEMENT_SOURCE,
      parserVersion: DISCOVER_STATEMENT_PARSER,
      issuer: DISCOVER_ISSUER,
      currency: 'USD',
      owner: null,
      cards: [parsed.last4],
      coverage: parsed.period,
      rejectedCount: 0,
      statement: {
        previousBalanceMinor: summary.previousBalanceMinor,
        newBalanceMinor: summary.newBalanceMinor,
        chargesMinor: summary.purchasesMinor + summary.balanceTransfersMinor + summary.cashAdvancesMinor + summary.feesMinor + summary.interestMinor,
        creditsMinor: -summary.paymentsAndCreditsMinor + 0,
        netMinor: null,
      },
      rows,
    });
  } catch (error) {
    if (!(error instanceof CardImportError)) throw error;
    const places = [...new Set(error.issues.flatMap((issue) => {
      const index = /^\$\.rows\[(\d+)\]/.exec(issue.path)?.[1];
      return index === undefined ? [] : [`page ${parsed.rows[Number(index)].page} line ${parsed.rows[Number(index)].line}`];
    }))];
    return { reason: 'card-data', message: `a row cannot be imported: ${places.length > 0 ? places.slice(0, 5).join(', ') : error.message}` };
  }
  // Rows whose stored text, field by field or put together, would show five digits of a card number in the row's
  // raw text (leaks.ts): refused, never repaired.
  const leaking = parsed.rows.flatMap((row, index) => {
    const stored = built.payload.rows[index];
    return showsCardDigits([stored.description, stored.merchant, stored.issuerCategory], row.sourceTexts) ? [`page ${row.page} line ${row.line}`] : [];
  });
  if (leaking.length > 0) {
    return { reason: 'card-data', message: `a row's text would show more than the last four digits of a card number: ${leaking.slice(0, 5).join(', ')}` };
  }
  const json = serializeCardImportPayload(built.payload);
  // Fail closed: the text written to disk must hold no card data and no 13+ digit run anywhere.
  if (/\d{13,}/.test(json) || findCardImportSensitivePaths(JSON.parse(json)).length > 0) {
    return { reason: 'card-data', message: 'the payload would still contain card data' };
  }
  // The import's own check of the statement figures against the rows, as Holdr's API will run it.
  const reconciliation = reconcileCardImport(built.payload.totals.posted, built.payload.statement);
  if (reconciliation.status !== 'match') return { reason: 'reconciliation', message: 'the payload\'s rows do not match the statement\'s figures' };
  return {
    payload: { name: file.name, period: parsed.period, payload: built.payload, json },
    coverageWidened: built.coverageWidened,
  };
}

/** Converts one card's statements. Throws `DiscoverConvertError` only for bad options; each statement is accepted or held. */
export function convertDiscoverStatements(files: readonly DiscoverStatementFile[], options: DiscoverConvertOptions): DiscoverConvertResult {
  if (!/^[0-9]{4}$/.test(options.card)) throw new DiscoverConvertError('the card must be given as its last four digits');
  if (files.length === 0) throw new DiscoverConvertError('give at least one statement');
  const outcomes: DiscoverStatementOutcome[] = [];
  const candidates: Candidate[] = [];
  /** This card's statements held before the checks across statements, whose period was read: they still bound the others'. */
  const heldPeriods: Array<{ outcome: DiscoverStatementOutcome; period: { start: string; end: string } }> = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const outcome: DiscoverStatementOutcome = {
      name: file.name, status: 'accepted', reason: null, message: null, layout: null, period: null, rows: 0, noActivity: false, reconciled: false,
    };
    outcomes.push(outcome);
    const same = seen.get(file.digest);
    if (same !== undefined) {
      hold(outcome, 'duplicate', `the same file as ${same}`);
      continue;
    }
    seen.set(file.digest, file.name);
    if (file.unreadable) {
      hold(outcome, 'not-a-statement', file.unreadable);
      continue;
    }
    let parsed: ParsedDiscoverStatement;
    try {
      parsed = parseDiscoverStatement(file.pages);
    } catch (error) {
      if (!(error instanceof DiscoverStatementError)) throw error;
      hold(outcome, error.reason, error.message);
      if (error.read !== undefined && error.read.last4 === options.card) {
        outcome.period = error.read.period;
        heldPeriods.push({ outcome, period: error.read.period });
      }
      continue;
    }
    Object.assign(outcome, { layout: parsed.layout, period: parsed.period, rows: parsed.rows.length, noActivity: parsed.noActivity });
    if (parsed.last4 !== options.card) {
      hold(outcome, 'other-card', `the statement is for the card ending ${parsed.last4}, not ${options.card}`);
      continue;
    }
    const built = payloadOf(file, parsed);
    if ('reason' in built) {
      hold(outcome, built.reason, built.message);
      heldPeriods.push({ outcome, period: parsed.period });
      continue;
    }
    outcome.reconciled = true;
    candidates.push({ outcome, parsed, payload: built.payload, coverageWidened: built.coverageWidened });
  }

  const continuity: DiscoverConvertReport['continuity'] = { adjacent: 0, gaps: [], overlaps: 0, duplicates: 0, chainBreaks: 0, repeatedRows: 0 };
  const byPeriod = [...candidates].sort((a, b) => (a.parsed.period.start < b.parsed.period.start ? -1 : a.parsed.period.start > b.parsed.period.start ? 1
    : a.parsed.period.end < b.parsed.period.end ? -1 : a.parsed.period.end > b.parsed.period.end ? 1 : 0));
  // The same period twice: one copy when the rows are the same, neither when they are not.
  const kept: Candidate[] = [];
  for (const candidate of byPeriod) {
    const twin = kept.find((other) => other.parsed.period.start === candidate.parsed.period.start && other.parsed.period.end === candidate.parsed.period.end);
    if (!twin) {
      kept.push(candidate);
    } else if (twin.payload.json === candidate.payload.json) {
      continuity.duplicates += 1;
      hold(candidate.outcome, 'duplicate', `the same statement as ${twin.outcome.name}`);
    } else {
      continuity.overlaps += 1;
      hold(candidate.outcome, 'overlap', `prints the same period as ${twin.outcome.name} with other figures or rows`);
      if (twin.outcome.status === 'accepted') hold(twin.outcome, 'overlap', `prints the same period as ${candidate.outcome.name} with other figures or rows`);
    }
  }
  // Every pair of periods, not only neighbours in date order, among every statement read whole (only a second copy of
  // the same statement aside): one already held for another conflict still bounds the periods it overlaps.
  const pool = byPeriod.filter((candidate) => candidate.outcome.reason !== 'duplicate');
  for (let first = 0; first < pool.length; first += 1) {
    for (let second = first + 1; second < pool.length; second += 1) {
      const [one, other] = [pool[first].parsed.period, pool[second].parsed.period];
      if (one.start > other.end || other.start > one.end || (one.start === other.start && one.end === other.end)) continue;
      continuity.overlaps += 1;
      for (const [held, by] of [[pool[first], pool[second]], [pool[second], pool[first]]]) {
        if (held.outcome.status === 'accepted') hold(held.outcome, 'overlap', `its period overlaps ${by.outcome.name}'s`);
      }
    }
  }
  // And a statement of this card held before these checks (its reader refused it, or its payload could not be
  // written) still speaks for its period: a statement whose period overlaps it, the same period included, is held.
  for (const candidate of pool) {
    for (const { outcome, period } of heldPeriods) {
      if (candidate.parsed.period.start > period.end || period.start > candidate.parsed.period.end) continue;
      continuity.overlaps += 1;
      if (candidate.outcome.status === 'accepted') hold(candidate.outcome, 'overlap', `its period overlaps ${outcome.name}'s`);
    }
  }
  // What remains has no overlaps: each statement either follows the one before it at once, or after a gap.
  const chain = pool.filter((candidate) => candidate.outcome.status === 'accepted');
  // A row two statements print alike (date, amount and description) gets one dedupe key in both payloads: the import
  // would keep one of them and take the other for the same row imported again. Both statements are held.
  const keyed = new Map<string, { candidate: Candidate; index: number }>();
  const place = (candidate: Candidate, index: number) => `${candidate.outcome.name} page ${candidate.parsed.rows[index].page} line ${candidate.parsed.rows[index].line}`;
  for (const candidate of chain) {
    candidate.payload.payload.rows.forEach((row, index) => {
      if (row.fingerprint === null) return;
      const earlier = keyed.get(row.fingerprint);
      if (earlier === undefined) {
        keyed.set(row.fingerprint, { candidate, index });
        return;
      }
      continuity.repeatedRows += 1;
      const message = `${place(earlier.candidate, earlier.index)} and ${place(candidate, index)} print the same row (date, amount and description): `
        + 'the import would keep only one of them';
      for (const one of [earlier.candidate, candidate]) if (one.outcome.status === 'accepted') hold(one.outcome, 'duplicate', message);
    });
  }
  // Continuity is read over every statement left after the overlaps, those just held included: their periods stand.
  for (let index = 1; index < chain.length; index += 1) {
    const before = chain[index - 1];
    const after = chain[index];
    const gapDays = dayNumber(after.parsed.period.start) - dayNumber(before.parsed.period.end) - 1;
    const carried = after.parsed.summary.previousBalanceMinor === before.parsed.summary.newBalanceMinor;
    if (gapDays === 0) {
      continuity.adjacent += 1;
      if (!carried) {
        continuity.chainBreaks += 1;
        const message = `${after.outcome.name}'s Previous Balance is not ${before.outcome.name}'s New Balance, though no day lies between them`;
        for (const one of [before, after]) if (one.outcome.status === 'accepted') hold(one.outcome, 'chain', message);
      }
    } else {
      const accepted = options.acceptGaps === true;
      continuity.gaps.push({
        after: before.parsed.period.end, before: after.parsed.period.start,
        from: dateOfDay(dayNumber(before.parsed.period.end) + 1), to: dateOfDay(dayNumber(after.parsed.period.start) - 1),
        days: gapDays, balanceCarried: carried, proven: false, accepted,
      });
      if (!accepted && after.outcome.status === 'accepted') {
        hold(after.outcome, 'unproven-gap', `no statement covers the ${gapDays} days before it, and nothing proves they had no activity`
          + (carried ? '' : ' (its Previous Balance is not the New Balance before them: a statement with activity is missing)'));
      }
    }
  }
  // Coverage is the union of the written statements' periods, never more. A payload's coverage is its period, widened
  // only to a row dated before it (a charge that posted later, which the import requires coverage to hold): within
  // the period of a statement written with it, that claims nothing new; past them (into a gap, or before the first) it
  // would claim days no statement covers, so the statement is held. Holding one takes its period from the union, so
  // this runs until no written coverage leaves the written periods.
  for (;;) {
    const written = candidates.filter((candidate) => candidate.outcome.status === 'accepted');
    const periods = mergeRanges(written.map((candidate) => candidate.parsed.period));
    const reaching = written.filter((candidate) => !periods.some((range) => range.start <= candidate.payload.payload.coverage.start
      && range.end >= candidate.payload.payload.coverage.end));
    if (reaching.length === 0) break;
    for (const candidate of reaching) {
      const { start } = candidate.payload.payload.coverage;
      hold(candidate.outcome, 'coverage', `a row dated ${dayNumber(candidate.parsed.period.start) - dayNumber(start)} days before its period would `
        + `stretch its coverage back to ${start}, over days no written statement covers`);
    }
  }

  const accepted = candidates.filter((candidate) => candidate.outcome.status === 'accepted')
    .sort((a, b) => (a.parsed.period.start < b.parsed.period.start ? -1 : 1));
  const byKind = Object.fromEntries(CARD_IMPORT_KINDS.map((kind) => [kind, 0])) as Record<CardTransactionKind, number>;
  const dates: string[] = [];
  for (const candidate of accepted) {
    for (const row of candidate.payload.payload.rows) {
      byKind[row.kind] += 1;
      dates.push(row.transactionDate);
    }
  }
  dates.sort();
  const heldByReason: Partial<Record<DiscoverHoldReason, number>> = {};
  for (const outcome of outcomes) if (outcome.reason !== null) heldByReason[outcome.reason] = (heldByReason[outcome.reason] ?? 0) + 1;
  const layouts: Partial<Record<DiscoverLayout, number>> = {};
  for (const candidate of accepted) layouts[candidate.parsed.layout] = (layouts[candidate.parsed.layout] ?? 0) + 1;
  const ranges = mergeRanges(accepted.map((candidate) => candidate.payload.payload.coverage));
  const uncovered = ranges.slice(1).map((range, index) => {
    const [from, to] = [dayNumber(ranges[index].end) + 1, dayNumber(range.start) - 1];
    return { from: dateOfDay(from), to: dateOfDay(to), days: to - from + 1 };
  });
  return {
    report: {
      parser: DISCOVER_STATEMENT_PARSER,
      issuer: DISCOVER_ISSUER,
      card: options.card,
      statements: {
        read: files.length,
        accepted: accepted.length,
        held: outcomes.length - accepted.length,
        heldByReason,
        reconciled: outcomes.filter((outcome) => outcome.reconciled).length,
      },
      layouts,
      periods: accepted.length === 0 ? null : { first: accepted[0].parsed.period.start, last: accepted[accepted.length - 1].parsed.period.end },
      rows: { total: dates.length, byKind, first: dates[0] ?? null, last: dates[dates.length - 1] ?? null },
      noActivityStatements: accepted.filter((candidate) => candidate.parsed.noActivity).length,
      coverageWidened: accepted.filter((candidate) => candidate.coverageWidened).length,
      coverage: { ranges, uncovered },
      continuity,
      files: outcomes,
    },
    payloads: accepted.map((candidate) => candidate.payload),
  };
}
