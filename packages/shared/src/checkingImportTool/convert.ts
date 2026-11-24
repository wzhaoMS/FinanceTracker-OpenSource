/**
 * The generic core of the checking import tool: parsed bank exports (one per file, from any adapter) to one redacted
 * `holdr.checking-import` payload, plus a report of counts and dates only. It never names a bank and never prints a
 * value: amounts, balances, descriptions and account numbers stay in the payload, which only the owner handles.
 *
 * What it guarantees, or it refuses the whole conversion:
 * - Complete days only. A segment covers the days its file says it lists (a statement period, OFX DTSTART..DTEND),
 *   cut at the day before the file was made and at --through, so activity still posting on the download day is never
 *   half-imported; a format that says neither (a bank CSV) needs --through. Rows after the cut are left out and
 *   counted; a row outside the days its own file states is a malformed file.
 * - Every stated balance adds up. A statement's opening balance plus its rows is its closing balance, and its printed
 *   deposit and withdrawal totals are the rows' totals; running and ending daily balances follow row by row; the
 *   bank's ledger balance and --expect-opening/closing-balance agree with the rows. These become end-of-day anchors,
 *   which must also chain across files over the days they cover.
 * - Files that share a day agree on it (the same amounts), so a QFX, a CSV and a statement of one day are one record.
 * - Text is stored as card import stores it (sanitizeCardText): card numbers and 13+ digit runs are kept as `***`
 *   plus their last four, the account number likewise, and a row whose stored text could still show more of a card
 *   number, or holds a card secret, refuses the conversion. No text the tool stores or prints holds five consecutive
 *   digits of a known account number in its digit-only projection, however they are split: they are masked as `*`.
 *   Bank references are kept only as hashes.
 */
import { cardExternalIdHash } from '../cardDedupe.js';
import { cardImportTextProblem, normalizeCardImportText, sanitizeCardText } from '../cardImport.js';
import { containsCardSecret } from '../cardSecrets.js';
import { normalizeCardText } from '../cardText.js';
import { currencyExponent } from '../cardImportTool/amount.js';
import { showsCardDigits } from '../cardImportTool/leaks.js';
import {
  addCheckingDays,
  CHECKING_BANK_TYPES,
  checkCheckingBalanceChain,
  checkingDayNets,
  checkingImportDays,
  CHECKING_IMPORT_FORMAT,
  CHECKING_IMPORT_LIMITS,
  CHECKING_IMPORT_NO_DESCRIPTION,
  CHECKING_IMPORT_VERSION,
  isCheckingDate,
  sortCheckingSegments,
  summarizeCheckingImport,
  validateCheckingImportPayload,
  type CheckingAnchorKind,
  type CheckingImportAnchor,
  type CheckingImportCoverage,
  type CheckingImportPayload,
  type CheckingImportRow,
  type CheckingImportSegment,
  type CheckingImportSummary,
} from '../checkingImport.js';
import type { ParsedCheckingExport, ParsedCheckingRow } from './parsed.js';

export const CHECKING_IMPORT_TOOL_VERSION = '1.0.0';
export const CHECKING_IMPORT_TOOL_PARSER = `holdr-checking-import@${CHECKING_IMPORT_TOOL_VERSION}`;

/** Letters and hyphens only: no digit of an account number can ride in a bank slug. */
const SLUG = /^[a-z][a-z-]{0,31}$/;
/** The transaction types stored as a row's bank type: OFX's own vocabulary, which an adapter maps its bank's types to. */
const STORED_BANK_TYPES: ReadonlySet<string> = new Set(CHECKING_BANK_TYPES);
/** Account types other than checking that a message may name (OFX's own, and what statement adapters report). */
const NON_CHECKING_TYPES: readonly string[] = ['SAVINGS', 'MONEYMRKT', 'CREDITLINE', 'CD'];
/** Currencies a checking account here may be in: a fixed list, so the report only ever names one of them. */
const KNOWN_CURRENCIES: ReadonlySet<string> = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'CNY', 'HKD', 'SGD', 'TWD', 'KRW', 'INR', 'MXN']);

export interface CheckingConvertInput {
  /** How messages name the file, e.g. `file 3`; never a path, which could hold anything. */
  name: string;
  parsed: ParsedCheckingExport;
}

export interface CheckingConvertOptions {
  /** The bank's slug, e.g. `wellsfargo`; a file whose format belongs to another bank is refused. */
  institution: string;
  /** The account's display name, with no digits. */
  label: string;
  /** Required when no file states the account number; otherwise every file must state this one. */
  accountLast4?: string;
  /** The last day whose activity was complete when the files were downloaded; caps every file. */
  through?: string;
  /** First day a file that states no period speaks for (its first row's day otherwise). One such file only. */
  from?: string;
  /** Balances copied from the bank for a single file: at the end of the day before its first day, and of its last day. */
  expectOpeningBalanceMinor?: number;
  expectClosingBalanceMinor?: number;
  /** False leaves an OFX ledger balance (LEDGERBAL) out of the checks. */
  useLedgerBalance?: boolean;
}

export interface CheckingConvertFileReport {
  name: string;
  source: string;
  coverage: CheckingImportCoverage;
  rows: number;
  /** Rows dated after the last complete day (the download day, --through): a later download brings them. */
  leftOutAfterCoverage: number;
  /** Rows the bank had not posted. */
  leftOutPending: number;
  anchors: number;
  /** Which balance checks this file passed, by name. */
  checks: string[];
  notes: string[];
}

export interface CheckingConvertReport {
  account: { institution: string; last4: string; label: string; currency: string };
  files: CheckingConvertFileReport[];
  summary: CheckingImportSummary;
  balanceChain: { checked: number; gaps: number };
}

export interface CheckingConvertResult {
  payload: CheckingImportPayload;
  report: CheckingConvertReport;
}

/** The conversion is refused. `issues` name files, lines, fields and dates, never values. */
export class CheckingConvertError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(issues.length ? `${message}:\n  ${issues.slice(0, 40).join('\n  ')}${issues.length > 40 ? `\n  … and ${issues.length - 40} more` : ''}` : message);
    this.name = 'CheckingConvertError';
    this.issues = issues;
  }
}

function accountDigitsOf(raw: string | null): string | null {
  if (!raw) return null;
  const digits = normalizeCardImportText(raw).replace(/[^0-9]/g, '');
  return digits.length >= ACCOUNT_RUN_WINDOW ? digits : null;
}

/** The digits of every account number the parsed files name (each file's own, and other blocks'), five digits or more. */
export function knownAccountDigits(parsed: ReadonlyArray<Pick<ParsedCheckingExport, 'accountNumberRaw' | 'otherAccountNumbersRaw'>>): string[] {
  const all = parsed.flatMap((file) => [file.accountNumberRaw, ...(file.otherAccountNumbersRaw ?? [])].map(accountDigitsOf));
  return [...new Set(all.filter((digits): digits is string => digits !== null))];
}

/** How many consecutive digits of an account number count as showing it. */
const ACCOUNT_RUN_WINDOW = 5;

/**
 * Text with no five consecutive digits of a known account number in its digit-only projection: its digits read in
 * order (in any script), whatever separates them (spaces, punctuation, letters, lines). Every digit that is part of
 * such a run is masked as `*`, however the copy is split (`9876-5`, `98 76 5`), so only a last four can remain. For
 * every text the tool stores or prints.
 */
export function maskKnownAccountDigits(text: string, accountDigits: readonly string[]): string {
  if (accountDigits.length === 0) return text;
  const chars = Array.from(text);
  const at: number[] = [];
  let projection = '';
  chars.forEach((char, index) => {
    const digits = /[0-9]/.test(char) ? char : /\p{N}/u.test(char) ? normalizeCardText(char).replace(/[^0-9]/g, '') : '';
    for (const digit of digits) {
      at.push(index);
      projection += digit;
    }
  });
  const masked = new Set<number>();
  for (const digits of accountDigits) {
    for (let start = 0; start + ACCOUNT_RUN_WINDOW <= digits.length; start += 1) {
      const window = digits.slice(start, start + ACCOUNT_RUN_WINDOW);
      for (let found = projection.indexOf(window); found !== -1; found = projection.indexOf(window, found + 1)) {
        for (let k = found; k < found + ACCOUNT_RUN_WINDOW; k += 1) masked.add(at[k]);
      }
    }
  }
  return masked.size === 0 ? text : chars.map((char, index) => (masked.has(index) ? '*' : char)).join('');
}

/** The minor-unit exponent of a currency this tool knows (2 for USD, 0 for JPY), or null for any other. */
export function checkingCurrencyExponent(currency: string): number | null {
  return KNOWN_CURRENCIES.has(currency) ? currencyExponent(currency) : null;
}

/**
 * Account-number digits in a description, redacted as card numbers are: a run of digits that holds the whole of one
 * of the account numbers, or five consecutive digits of it (a shortened copy, such as its last seven), becomes `***`
 * plus that account's last four when the run ends in them, and `***` alone otherwise, so a redaction never keeps
 * digits from inside an account number. A copy split by other characters is masked after (maskKnownAccountDigits).
 */
function redactAccountNumber(text: string, accountDigits: readonly string[]): string {
  if (accountDigits.length === 0) return text;
  return normalizeCardImportText(text).replace(/[0-9]+/g, (run) => {
    const account = accountDigits.find((digits) => maskKnownAccountDigits(run, [digits]) !== run);
    if (!account) return run;
    return run.endsWith(account.slice(-4)) ? `***${account.slice(-4)}` : '***';
  });
}

function minDate(...dates: Array<string | null | undefined>): string | null {
  const known = dates.filter((date): date is string => typeof date === 'string');
  return known.length ? known.reduce((a, b) => (a < b ? a : b)) : null;
}

interface FileResult {
  segment: CheckingImportSegment;
  report: CheckingConvertFileReport;
}

/** How many times card redaction and the account mask may each run on one description before it must be stable. */
const REDACTION_PASSES = 6;

/**
 * A description as it is stored: its account numbers redacted (redactAccountNumber), then card redaction
 * (sanitizeCardText) and the account mask (maskKnownAccountDigits: whatever redaction left of an account number, a
 * copy split by spaces, punctuation or letters, masked whole) in turn until neither changes it. The mask can leave a
 * masked number that shows more than four digits (five digits of an account number read across two fields of one
 * description, masked in each, leave the rest of the second field after `*`), which card redaction then shortens to
 * its last four. Text still changing after the last pass is returned as it is: the check after it refuses whatever
 * the detectors still flag.
 */
function storedDescription(description: string, accountDigits: readonly string[]): string {
  let text = redactAccountNumber(description, accountDigits);
  for (let pass = 0; pass < REDACTION_PASSES; pass += 1) {
    const sanitized = sanitizeCardText(text, CHECKING_IMPORT_LIMITS.description);
    if (sanitized === null) return CHECKING_IMPORT_NO_DESCRIPTION;
    const masked = maskKnownAccountDigits(sanitized, accountDigits);
    if (masked === text) return masked;
    text = masked;
  }
  return text;
}

function storedRow(row: ParsedCheckingRow, file: string, accountRaw: string | null, accountDigits: readonly string[],
  issues: string[], notes: string[]): CheckingImportRow | null {
  const at = `${file} line ${row.line}`;
  if (row.description.length > 65_536) {
    issues.push(`${at}: the description is longer than this tool reads`);
    return null;
  }
  if (containsCardSecret(row.description)) {
    issues.push(`${at}: the description holds a card security code, PIN or expiry date; remove it from the export`);
    return null;
  }
  const description = storedDescription(row.description, accountDigits);
  const problem = cardImportTextProblem(description, CHECKING_IMPORT_LIMITS.description);
  if (problem) {
    issues.push(`${at}: the stored description ${problem}`);
    return null;
  }
  // A check number is stored as the bank printed it, or not at all: one holding account digits cannot be masked.
  if (showsCardDigits([description, row.checkNumber], [...row.sourceTexts, accountRaw])
    || (row.checkNumber !== null && maskKnownAccountDigits(row.checkNumber, accountDigits) !== row.checkNumber)) {
    issues.push(`${at}: the stored text would still show more than four digits of a card or account number; remove it from the export`);
    return null;
  }
  let externalIdHash: string | null = null;
  if (row.externalId !== null && row.externalId.trim() !== '') {
    try {
      externalIdHash = cardExternalIdHash(row.externalId);
    } catch {
      notes.push(`line ${row.line}: the bank reference is not usable and was left out`);
    }
  }
  // Only a type from this fixed list is stored: anything else could be any text of the file.
  const bankType = row.typeHint !== null && STORED_BANK_TYPES.has(row.typeHint) ? row.typeHint : null;
  return { postedDate: row.postedDate, amountMinor: row.amountMinor + 0, description, checkNumber: row.checkNumber, bankType, externalIdHash };
}

function addAnchor(anchors: Map<string, CheckingImportAnchor>, date: string, balanceMinor: number, kind: CheckingAnchorKind,
  file: string, issues: string[]): void {
  const known = anchors.get(date);
  if (known && known.balanceMinor !== balanceMinor) {
    issues.push(`${file}: two balances it states for ${date} disagree`);
    return;
  }
  // A closing or daily balance wins over a derived one of the same day; they are equal anyway.
  if (!known || kind === 'closing' || kind === 'opening') anchors.set(date, { date, balanceMinor, kind });
}

function convertFile(input: CheckingConvertInput, options: CheckingConvertOptions, single: boolean, coverageless: number,
  accountDigits: readonly string[], issues: string[]): FileResult | null {
  const { name, parsed } = input;
  const notes = [...parsed.notes];
  const before = issues.length;
  for (const problem of parsed.problems.slice(0, 20)) issues.push(`${name} line ${problem.line}: ${problem.reason}`);
  if (parsed.problems.length > 20) issues.push(`${name}: ${parsed.problems.length - 20} more rows could not be read`);
  if (parsed.problems.length > 0) return null;

  const pending = parsed.rows.filter((row) => row.pending);
  const posted = parsed.rows.filter((row) => !row.pending);
  // The last complete day: before the day the bank made the file, and never after --through.
  const lastComplete = minDate(parsed.madeAt ? addCheckingDays(parsed.madeAt, -1) : null, options.through);
  let start: string;
  let end: string;
  if (parsed.coverage) {
    start = parsed.coverage.start;
    end = minDate(parsed.coverage.end, lastComplete)!;
  } else {
    if (lastComplete === null) {
      issues.push(`${name}: this format does not say when it was made; pass --through YYYY-MM-DD, the last day whose activity was complete when you downloaded it (yesterday, if you downloaded it today)`);
      return null;
    }
    if (options.from !== undefined && coverageless !== 1) {
      issues.push('--from applies to one file that states no period; convert such files one at a time');
      return null;
    }
    const first = posted[0]?.postedDate ?? null;
    if (options.from === undefined && first === null) {
      issues.push(`${name}: the file holds no rows and states no period, so it speaks for no day`);
      return null;
    }
    start = options.from ?? first!;
    end = lastComplete;
  }
  if (start > end) {
    issues.push(`${name}: holds no complete day (it ends on or after the day it was made, or after --through)`);
    return null;
  }
  const outside = posted.filter((row) => row.postedDate < start || (parsed.coverage !== null && row.postedDate > parsed.coverage.end));
  if (outside.length > 0) {
    issues.push(`${name}: ${outside.length} rows are dated outside the days the file says it lists (first at line ${outside[0].line})`);
    return null;
  }
  const inside = posted.filter((row) => row.postedDate <= end);
  const later = posted.filter((row) => row.postedDate > end);

  const rows: CheckingImportRow[] = [];
  for (const row of inside) {
    const stored = storedRow(row, name, parsed.accountNumberRaw, accountDigits, issues, notes);
    if (stored) rows.push(stored);
  }
  if (issues.length > before) return null;

  // Balances the file states, checked against its rows, then kept as end-of-day anchors.
  const anchors = new Map<string, CheckingImportAnchor>();
  const checks: string[] = [];
  const net = (list: readonly ParsedCheckingRow[]) => list.reduce((sum, row) => sum + row.amountMinor, 0);
  const statement = parsed.statement;
  if (statement) {
    if (!parsed.coverage) {
      issues.push(`${name}: states statement balances but no statement period`);
      return null;
    }
    if (statement.openingBalanceMinor + net(posted) !== statement.closingBalanceMinor) {
      issues.push(`${name}: the opening balance plus the rows is not the closing balance; rows are missing or misread`);
    }
    const deposits = posted.filter((row) => row.amountMinor > 0).reduce((sum, row) => sum + row.amountMinor, 0);
    const withdrawals = -posted.filter((row) => row.amountMinor < 0).reduce((sum, row) => sum + row.amountMinor, 0);
    if (statement.depositsMinor !== null && statement.depositsMinor !== deposits) {
      issues.push(`${name}: the rows' money in is not the statement's deposits total`);
    }
    if (statement.withdrawalsMinor !== null && statement.withdrawalsMinor !== withdrawals) {
      issues.push(`${name}: the rows' money out is not the statement's withdrawals total`);
    }
    if (issues.length > before) return null;
    checks.push('statement-balances', ...(statement.depositsMinor !== null || statement.withdrawalsMinor !== null ? ['statement-totals'] : []));
    addAnchor(anchors, addCheckingDays(parsed.coverage.start, -1), statement.openingBalanceMinor, 'opening', name, issues);
    if (end === parsed.coverage.end) addAnchor(anchors, end, statement.closingBalanceMinor, 'closing', name, issues);
  }

  // Running (or ending daily) balances follow row by row, from the opening balance when the statement gives one.
  if (posted.some((row) => row.runningBalanceMinor !== null)) {
    let current: number | null = statement ? statement.openingBalanceMinor : null;
    // Without a stated opening balance, the first printed balance less every row up to it is the balance at the end
    // of the day before the first covered day: every covered day is complete, so no row comes before them.
    const firstPrinted = posted.findIndex((row) => row.runningBalanceMinor !== null);
    if (!statement && firstPrinted !== -1 && posted[firstPrinted].postedDate <= end) {
      const opening = posted[firstPrinted].runningBalanceMinor! - net(posted.slice(0, firstPrinted + 1));
      addAnchor(anchors, addCheckingDays(start, -1), opening, 'opening', name, issues);
      current = opening;
    }
    for (const [index, row] of posted.entries()) {
      if (current !== null) current += row.amountMinor;
      if (row.runningBalanceMinor !== null) {
        if (current !== null && current !== row.runningBalanceMinor) {
          issues.push(`${name} line ${row.line}: the balance printed there does not follow from the rows before it`);
          return null;
        }
        current = row.runningBalanceMinor;
      }
      const lastOfDay = index === posted.length - 1 || posted[index + 1].postedDate !== row.postedDate;
      if (lastOfDay && current !== null && row.postedDate >= start && row.postedDate <= end) {
        addAnchor(anchors, row.postedDate, current, 'daily', name, issues);
      }
    }
    checks.push('running-balances');
  }

  const ledger = parsed.ledgerBalance;
  if (ledger && options.useLedgerBalance !== false) {
    if (ledger.asOf === end) {
      addAnchor(anchors, end, ledger.amountMinor, 'ledger', name, issues);
      checks.push('ledger-balance');
    } else if (ledger.asOf > end && parsed.coverage && parsed.coverage.end >= ledger.asOf) {
      // The bank's balance at its date, less the rows after the last complete day up to it, is that day's balance.
      const after = posted.filter((row) => row.postedDate > end && row.postedDate <= ledger.asOf);
      addAnchor(anchors, end, ledger.amountMinor - net(after), 'ledger', name, issues);
      checks.push('ledger-balance');
      notes.push('the ledger balance was carried back to the last complete day');
    } else if (ledger.asOf >= addCheckingDays(start, -1) && ledger.asOf < end) {
      addAnchor(anchors, ledger.asOf, ledger.amountMinor, 'ledger', name, issues);
      checks.push('ledger-balance');
    } else {
      // A balance the file states is checked, or the owner says to leave it out; it is never skipped quietly.
      issues.push(`${name}: its ledger balance is dated outside the days its transaction list covers, so the rows cannot be checked against it; download the activity through the day you download it, or pass --no-ledger-balance`);
      return null;
    }
  }

  if (single && (options.expectOpeningBalanceMinor !== undefined || options.expectClosingBalanceMinor !== undefined)) {
    if (options.expectOpeningBalanceMinor !== undefined) addAnchor(anchors, addCheckingDays(start, -1), options.expectOpeningBalanceMinor, 'opening', name, issues);
    if (options.expectClosingBalanceMinor !== undefined) addAnchor(anchors, end, options.expectClosingBalanceMinor, 'closing', name, issues);
    if (options.expectOpeningBalanceMinor !== undefined && options.expectClosingBalanceMinor !== undefined
      && options.expectOpeningBalanceMinor + net(inside) !== options.expectClosingBalanceMinor) {
      issues.push(`${name}: --expect-opening-balance plus the rows is not --expect-closing-balance`);
    }
    checks.push('expected-balances');
  }
  if (issues.length > before) return null;

  const segment: CheckingImportSegment = {
    source: parsed.source,
    coverage: { start, end },
    anchors: [...anchors.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    rows,
  };
  // Each file's own balances must chain over its own days before anything is combined.
  const own = checkingDayNets(checkingImportDays([segment]).days);
  const chain = checkCheckingBalanceChain(segment.anchors, (date) => own.get(date) ?? null);
  if (chain.mismatches.length > 0) {
    issues.push(`${name}: its balances do not follow from its rows on ${chain.mismatches.slice(0, 5).join(', ')}`);
    return null;
  }
  return {
    segment,
    report: {
      name, source: parsed.source, coverage: segment.coverage, rows: rows.length, leftOutAfterCoverage: later.length,
      leftOutPending: pending.length, anchors: segment.anchors.length, checks, notes,
    },
  };
}

/**
 * Parsed exports of one checking account to one payload. Refuses (CheckingConvertError) on any unreadable row, any
 * balance that does not add up, any disagreement between files, and any text that could still show card or account
 * digits; nothing is ever skipped silently, because a day is either complete or not imported.
 */
export function convertCheckingExports(inputs: readonly CheckingConvertInput[], options: CheckingConvertOptions): CheckingConvertResult {
  if (inputs.length === 0) throw new CheckingConvertError('no files to convert');
  if (!SLUG.test(options.institution)) throw new CheckingConvertError('--institution must be a lowercase slug of letters and hyphens, such as wellsfargo');
  if (options.through !== undefined && !isCheckingDate(options.through)) throw new CheckingConvertError('--through must be a valid YYYY-MM-DD date');
  if (options.from !== undefined && !isCheckingDate(options.from)) throw new CheckingConvertError('--from must be a valid YYYY-MM-DD date');
  if (options.accountLast4 !== undefined && !/^[0-9]{4}$/.test(options.accountLast4)) throw new CheckingConvertError('--account must be four digits');
  const expecting = options.expectOpeningBalanceMinor !== undefined || options.expectClosingBalanceMinor !== undefined;
  if (expecting && inputs.length !== 1) throw new CheckingConvertError('--expect-opening-balance and --expect-closing-balance apply to a single file; convert it on its own');

  // Every account number the files name (this account's, and other accounts' a file holds) is redacted and
  // leak-checked in the rows, and no refusal ever shows five of its digits in a row either.
  const accountDigits = knownAccountDigits(inputs.map((input) => input.parsed));
  const refuse = (message: string, list: readonly string[]): never => {
    throw new CheckingConvertError(message, list.map((issue) => maskKnownAccountDigits(issue, accountDigits)));
  };
  const issues: string[] = [];
  const currencies = new Set(inputs.map((input) => input.parsed.currency));
  if (currencies.size !== 1) issues.push('the files are in different currencies');
  else if (!KNOWN_CURRENCIES.has([...currencies][0])) issues.push('the files are in a currency this tool does not know');
  for (const { name, parsed } of inputs) {
    if (parsed.institution !== null && parsed.institution !== options.institution) {
      issues.push(`${name}: is a ${parsed.source} file from another bank than --institution`);
    }
    // Only a type from this closed list is ever named in a message; anything else could be any text of the file.
    if (parsed.accountType !== null && parsed.accountType !== 'CHECKING') {
      const kind = NON_CHECKING_TYPES.includes(parsed.accountType) ? parsed.accountType : 'non-checking';
      issues.push(`${name}: is a statement of a ${kind} account, not a checking account`);
    }
    if (parsed.accountLast4 !== null && !/^[0-9]{4}$/.test(parsed.accountLast4)) {
      issues.push(`${name}: states an account number whose last four digits cannot be read`);
    }
  }
  const stated = new Set(inputs.flatMap((input) => (input.parsed.accountLast4 && /^[0-9]{4}$/.test(input.parsed.accountLast4) ? [input.parsed.accountLast4] : [])));
  if (options.accountLast4 !== undefined) stated.add(options.accountLast4);
  if (stated.size > 1) issues.push(`the files are for different accounts (${[...stated].sort().join(', ')}); convert one account at a time`);
  if (stated.size === 0) issues.push('no file states the account number; pass --account LAST4');
  const raws = new Set(inputs.flatMap((input) => (input.parsed.accountNumberRaw ? [accountDigitsOf(input.parsed.accountNumberRaw)] : [])));
  raws.delete(null);
  if (raws.size > 1) issues.push('the files state different account numbers; convert one account at a time');
  if (issues.length > 0) refuse('refused', issues);
  const currency = [...currencies][0];
  const last4 = [...stated][0];

  const coverageless = inputs.filter((input) => input.parsed.coverage === null).length;
  const results: FileResult[] = [];
  for (const input of inputs) {
    const result = convertFile(input, options, inputs.length === 1, coverageless, accountDigits, issues);
    if (result) results.push(result);
  }
  if (issues.length > 0) refuse('refused', issues);

  const segments = sortCheckingSegments(results.map((result) => result.segment));
  const { days, disagreements } = checkingImportDays(segments);
  if (disagreements.length > 0) {
    refuse('refused', [`files that cover the same days disagree on ${disagreements.length} of them: ${disagreements.slice(0, 10).join(', ')}`]);
  }
  const nets = checkingDayNets(days);
  const chain = checkCheckingBalanceChain(segments.flatMap((segment) => segment.anchors), (date) => nets.get(date) ?? null);
  if (chain.mismatches.length > 0) {
    refuse('refused', [`balances from different files do not follow from the rows between them, at ${chain.mismatches.slice(0, 10).join(', ')}`]);
  }
  const payload: CheckingImportPayload = {
    format: CHECKING_IMPORT_FORMAT,
    version: CHECKING_IMPORT_VERSION,
    parserVersion: CHECKING_IMPORT_TOOL_PARSER,
    account: { institution: options.institution, type: 'checking', last4, label: options.label, currency },
    segments,
  };
  const validation = validateCheckingImportPayload(payload);
  if (!validation.ok) refuse('the payload did not validate', validation.issues.map((issue) => `${issue.path}: ${issue.message}`));
  return {
    payload,
    // Every text field of the report (a file's name, its notes, any label) through the same mask as every message;
    // its counts and dates are structural (Root 02:31Z).
    report: maskTexts({
      account: { ...payload.account },
      files: results.map((result) => result.report),
      summary: summarizeCheckingImport(payload),
      balanceChain: { checked: chain.checked, gaps: chain.gaps },
    }, accountDigits),
  };
}

/** Report fields that hold a date: exempt from the account-digit guard while they are exactly one (Root 02:31Z). */
const DATE_FIELDS: ReadonlySet<string> = new Set(['start', 'end']);

/**
 * Every text field of a value, at any depth and each on its own, through maskKnownAccountDigits. Structural fields
 * that never carry a file's text are left as they are while they pass their exact pattern: numbers (counts), and dates
 * (exactly YYYY-MM-DD, a real day) in a date field. A date-shaped value in any other field is text.
 */
function maskTexts<T>(value: T, accountDigits: readonly string[], key?: string): T {
  if (typeof value === 'string') {
    if (key !== undefined && DATE_FIELDS.has(key) && isCheckingDate(value)) return value;
    return maskKnownAccountDigits(value, accountDigits) as T;
  }
  if (Array.isArray(value)) return value.map((item) => maskTexts(item, accountDigits)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, maskTexts(item, accountDigits, name)])) as T;
  }
  return value;
}
