/**
 * Fifth Third Bank checking activity CSV (online banking: the account's activity, Download, CSV).
 *
 * Read by header name, never by position, so a reordered or extended export reads right or fails loudly:
 * - Date: the posting date, MM/DD/YYYY. `Posted Date` and `Posting Date` are read the same way, and a
 *   `Transaction Date` column, when the export has one beside it, is kept as the transaction date.
 * - Description: the bank's descriptor, as raw text that the converter redacts.
 * - Amount: one signed column, negative when money left the account. An export may split it into Debit and
 *   Credit columns instead; both are then read as amounts out and in.
 * - Check Number (digits only), Balance (the running balance after the row), a transaction type and a
 *   Pending/Posted status, when the export has them.
 * Every other column is dropped unread and listed by its header name. A file whose header names no posting
 * date, description or amount is refused, never read by position.
 *
 * Fifth Third's export (header `Date,Description,Check Number,Amount`, no Balance) lists blocks of days one after
 * another, each block newest first, so its rows are not in date order. Rows are handed on oldest first: without a
 * balance, in date order, a day's rows the other way round from the file; dedupe keys count the rows of a date and
 * amount, so they never depend on the order. With a Balance column the file must be in date order (either way),
 * and the order within a day is proven: every balance must be the previous one plus the amounts between them, and a
 * day whose rows chain only the other way round is turned round. A file in which the chain still breaks is
 * refused: rows are missing, or the export was edited.
 *
 * The CSV states neither its account nor its dates nor when it was downloaded: the converter asks for the
 * dates the download covered, and only complete days are imported. Problems name the line and the column,
 * never a value.
 *
 * A CSV names no bank, and other banks' headers use the same words (Wells Fargo's is `DATE, DESCRIPTION, AMOUNT,
 * CHECK #, STATUS`). So the converter picks this format on its own only for the exact header layouts listed in
 * FIFTH_THIRD_CSV_LAYOUTS; any other header it reads only when told (`--format fifththird-csv`).
 */
import { currencyExponent, parseAmount } from '../cardImportTool/amount.js';
import { parseExportDate, safeColumnLabel } from '../cardImportTool/amexCsv.js';
import { CsvError, parseCsv } from '../cardImportTool/csv.js';
import {
  fifthThirdAccountIdentity,
  fifthThirdAccountTokenProblem,
  fifthThirdKnownAccountNumbers,
  type FifthThirdAccountIdentity,
} from './fifthThirdAccount.js';
import {
  CheckingExportFormatError,
  withAccountNumbers,
  type CheckingAdapterOptions,
  type CheckingExportAdapter,
  type CheckingExportInput,
  type CheckingRowProblem,
  type ParsedCheckingExport,
  type ParsedCheckingRow,
} from './parsed.js';

export const FIFTH_THIRD_INSTITUTION = 'fifththird';
export const FIFTH_THIRD_CSV_SOURCE = 'fifththird-csv';
/**
 * Header layouts the converter recognizes as Fifth Third's without `--format` (compared without case or extra
 * spaces): the activity export's own header. A file with any other header is read only when the format is given.
 */
export const FIFTH_THIRD_CSV_LAYOUTS: ReadonlyArray<readonly string[]> = Object.freeze([
  Object.freeze(['Date', 'Description', 'Check Number', 'Amount']),
]);
/** Four years of a busy account fit; the payload's own limit is 50,000 rows. */
const CSV_LIMITS = { maxRecords: 60_002, maxFields: 32, maxFieldLength: 10_000 };

type Role =
  | 'date' | 'transactionDate' | 'description' | 'amount' | 'debit' | 'credit' | 'checkNumber' | 'balance' | 'type'
  | 'status' | 'account';

const COLUMNS: Readonly<Record<string, Role>> = {
  date: 'date',
  'posted date': 'date',
  'posting date': 'date',
  'post date': 'date',
  'transaction date': 'transactionDate',
  description: 'description',
  'transaction description': 'description',
  amount: 'amount',
  'transaction amount': 'amount',
  debit: 'debit',
  debits: 'debit',
  withdrawal: 'debit',
  withdrawals: 'debit',
  'withdrawals/debits': 'debit',
  'withdrawals / debits': 'debit',
  credit: 'credit',
  credits: 'credit',
  deposit: 'credit',
  deposits: 'credit',
  'deposits/credits': 'credit',
  'deposits / credits': 'credit',
  'check number': 'checkNumber',
  'check #': 'checkNumber',
  'check no': 'checkNumber',
  'check no.': 'checkNumber',
  checknumber: 'checkNumber',
  'check num': 'checkNumber',
  balance: 'balance',
  'running balance': 'balance',
  type: 'type',
  'transaction type': 'type',
  'debit/credit': 'type',
  'debit / credit': 'type',
  'credit/debit': 'type',
  'credit / debit': 'type',
  'dr/cr': 'type',
  'cr/dr': 'type',
  status: 'status',
  'transaction status': 'status',
  account: 'account',
  'account number': 'account',
  'account #': 'account',
};

const LABELS: Readonly<Record<Role, string>> = {
  date: 'Date',
  transactionDate: 'Transaction Date',
  description: 'Description',
  amount: 'Amount',
  debit: 'Debit',
  credit: 'Credit',
  checkNumber: 'Check Number',
  balance: 'Balance',
  type: 'Type',
  status: 'Status',
  account: 'Account Number',
};

const CHECK_NUMBER = /^[0-9]{1,10}$/;
const TYPE_LABEL = /^[A-Za-z][A-Za-z0-9 ./&'()-]{0,39}$/;
const NOT_FIFTH_THIRD = 'this does not look like a Fifth Third activity CSV: its first line must be a header naming Date, '
  + 'Description and Amount (or Debit and Credit)';

/** `unsorted`: dates both rise and fall, as in Fifth Third's own export (blocks of days, each newest first). */
export type FileOrder = 'oldest-first' | 'newest-first' | 'single-date' | 'unsorted';

export interface FifthThirdCsvReport {
  /** How the file listed its rows. */
  fileOrder: FileOrder;
  /** Days whose rows the running balance put the other way round from the rest of the file. */
  daysTurned: number;
  /** Consecutive balances checked against the amounts between them. */
  balancePairsChecked: number;
}

function headerKey(name: string): string {
  return name.normalize('NFKC').replace(/^\ufeff/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

interface Header {
  roles: Map<Role, number>;
  width: number;
  dropped: string[];
}

function readHeader(fields: readonly string[]): Header | null {
  const roles = new Map<Role, number>();
  const dropped: string[] = [];
  for (const [index, name] of fields.entries()) {
    const role = COLUMNS[headerKey(name)];
    if (!role) {
      if (name.trim() !== '') dropped.push(safeColumnLabel(name, index));
      continue;
    }
    if (roles.has(role)) throw new CheckingExportFormatError(`the header has more than one ${LABELS[role]} column`);
    roles.set(role, index);
  }
  // Each required column is found once by its own name: a Transaction Date is not a posting date, so a file whose only
  // date is one is refused rather than read as if it were.
  if (!roles.has('date') && roles.has('transactionDate')) {
    throw new CheckingExportFormatError('the header has a Transaction Date but no posting Date column; this layout is not supported');
  }
  const hasAmount = roles.has('amount') || (roles.has('debit') && roles.has('credit'));
  if (!roles.has('date') || !roles.has('description') || !hasAmount) return null;
  if (roles.has('amount') && (roles.has('debit') || roles.has('credit'))) {
    throw new CheckingExportFormatError('the header has an Amount column and Debit or Credit columns; it must have one or the other');
  }
  return { roles, width: fields.length, dropped };
}

function firstRecord(text: string) {
  try {
    return parseCsv(text)[0] ?? null;
  } catch {
    return null;
  }
}

/** True when the text's first line is a header this adapter reads. Never throws. */
export function looksLikeFifthThirdCsv(text: string): boolean {
  const first = firstRecord(text.replace(/^\ufeff/, '').slice(0, 4096).split(/\r\n|\r|\n/, 1)[0] ?? '');
  if (!first) return false;
  const layout = first.fields.map(headerKey).join('|');
  return FIFTH_THIRD_CSV_LAYOUTS.some((known) => known.map(headerKey).join('|') === layout);
}

/**
 * What the reader finds in a CSV's layout, for `--explain` when a file is refused: which columns it reads (by its
 * own names for them, null for a column it would drop), whether the header is one it reads, and how many fields
 * the records have. Never a cell or header text of the file.
 */
export function describeFifthThirdCsvLayout(text: string): Record<string, unknown> {
  let records;
  try {
    records = parseCsv(text.replace(/^\ufeff/, ''), CSV_LIMITS);
  } catch (error) {
    return { readable: false, reason: error instanceof CsvError ? csvReason(error) : 'the CSV cannot be read' };
  }
  if (records.length === 0) return { readable: true, dataRecords: 0 };
  const columns = records[0].fields.map((name) => {
    const role = COLUMNS[headerKey(name)];
    return role ? LABELS[role] : null;
  });
  let headerRead = false;
  try {
    headerRead = readHeader(records[0].fields) !== null;
  } catch {
    headerRead = false;
  }
  const widths = new Map<number, number>();
  for (const record of records.slice(1)) widths.set(record.fields.length, (widths.get(record.fields.length) ?? 0) + 1);
  return {
    readable: true,
    headerRead,
    knownLayout: looksLikeFifthThirdCsv(text),
    columns,
    dataRecords: records.length - 1,
    fieldCounts: Object.fromEntries([...widths.entries()].sort((a, b) => a[0] - b[0])),
  };
}

type AmountRead = { ok: true; minor: number } | { ok: false; reason: string };

function readSplitAmount(debitRaw: string, creditRaw: string, exponent: number): AmountRead {
  const syntax = { thousands: true, symbols: true };
  const debit = nonEmpty(debitRaw) ? parseAmount(debitRaw, exponent, syntax) : null;
  const credit = nonEmpty(creditRaw) ? parseAmount(creditRaw, exponent, syntax) : null;
  if (debit && !debit.ok) return { ok: false, reason: `Debit ${debit.reason}` };
  if (credit && !credit.ok) return { ok: false, reason: `Credit ${credit.reason}` };
  const out = debit && debit.ok && debit.minor !== 0 ? -Math.abs(debit.minor) : null;
  const into = credit && credit.ok && credit.minor !== 0 ? credit.minor : null;
  if (into !== null && into < 0) return { ok: false, reason: 'Credit is negative' };
  if (out !== null && into !== null) return { ok: false, reason: 'has both a Debit and a Credit' };
  if (out !== null) return { ok: true, minor: out };
  if (into !== null) return { ok: true, minor: into };
  if (debit || credit) return { ok: true, minor: 0 };
  return { ok: false, reason: 'has neither a Debit nor a Credit' };
}

function dateOrder(dates: readonly string[]): FileOrder {
  let up = false;
  let down = false;
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index] > dates[index - 1]) up = true;
    else if (dates[index] < dates[index - 1]) down = true;
  }
  if (up && down) return 'unsorted';
  if (down) return 'newest-first';
  if (up) return 'oldest-first';
  return 'single-date';
}

/**
 * Lines (in the given order) where a running balance does not follow from the previous balance and the
 * amounts since: for consecutive rows with a balance, balance[j] = balance[i] + amounts of rows i+1..j.
 * Pending rows are left out of the chain.
 */
export function runningBalanceBreaks(rows: readonly ParsedCheckingRow[]): { breaks: number[]; pairs: number } {
  const breaks: number[] = [];
  let pairs = 0;
  let previous: number | null = null;
  let sinceThen = 0;
  for (const row of rows) {
    if (row.pending) continue;
    sinceThen += row.amountMinor;
    if (row.runningBalanceMinor === null) continue;
    if (previous !== null) {
      pairs += 1;
      if (row.runningBalanceMinor !== previous + sinceThen) breaks.push(row.line);
    }
    previous = row.runningBalanceMinor;
    sinceThen = 0;
  }
  return { breaks, pairs };
}

function chains(rows: readonly ParsedCheckingRow[], before: number | null): boolean {
  let balance = before;
  for (const row of rows) {
    if (row.pending) continue;
    if (balance !== null) balance += row.amountMinor;
    if (row.runningBalanceMinor === null) continue;
    if (balance !== null && row.runningBalanceMinor !== balance) return false;
    balance = row.runningBalanceMinor;
  }
  return true;
}

function lastBalance(rows: readonly ParsedCheckingRow[], before: number | null): number | null {
  let balance = before;
  for (const row of rows) {
    if (row.pending) continue;
    if (balance !== null) balance += row.amountMinor;
    if (row.runningBalanceMinor !== null) balance = row.runningBalanceMinor;
  }
  return balance;
}

/**
 * Oldest first; within a day, the posting order the running balance proves. Without a balance to decide, a
 * day's rows are read newest first, as Fifth Third lists activity. An unsorted file (only ever one without a
 * balance) is put in date order, stably, after that reversal.
 */
function postingOrder(rows: readonly ParsedCheckingRow[], order: FileOrder): { rows: ParsedCheckingRow[]; daysTurned: number } {
  const base = order === 'oldest-first' ? [...rows] : [...rows].reverse();
  if (order === 'unsorted') base.sort((a, b) => (a.postedDate < b.postedDate ? -1 : a.postedDate > b.postedDate ? 1 : 0));
  const days: ParsedCheckingRow[][] = [];
  for (const row of base) {
    const day = days[days.length - 1];
    if (day && day[0].postedDate === row.postedDate) day.push(row);
    else days.push([row]);
  }
  const ordered: ParsedCheckingRow[] = [];
  let daysTurned = 0;
  let balance: number | null = null;
  for (const day of days) {
    let chosen = day;
    if (day.length > 1 && !chains(day, balance)) {
      const turned = [...day].reverse();
      if (chains(turned, balance)) {
        chosen = turned;
        daysTurned += 1;
      }
    }
    ordered.push(...chosen);
    balance = lastBalance(chosen, balance);
  }
  return { rows: ordered, daysTurned };
}

export interface FifthThirdCsvResult {
  parsed: ParsedCheckingExport;
  report: FifthThirdCsvReport;
}

const MONEY_OUT_TYPES = new Set(['DEBIT', 'DR', 'D', 'WITHDRAWAL']);
const MONEY_IN_TYPES = new Set(['CREDIT', 'CR', 'C', 'DEPOSIT']);
/** Rows above which a file without a single negative amount cannot be a checking account's signed activity. */
const UNSIGNED_SUSPICION_ROWS = 5;

/** True when the row's type column says which way its money moved. */
function hasDirectionType(row: ParsedCheckingRow): boolean {
  return row.typeHint !== null && (MONEY_OUT_TYPES.has(row.typeHint) || MONEY_IN_TYPES.has(row.typeHint));
}

/**
 * The amounts must be signed (money out negative). Refused rather than guessed:
 * - any row, posted or pending, whose type column says debit or credit against its amount's sign: one
 *   contradiction is enough, never outvoted by rows that agree;
 * - with one Amount column and no balance to prove signs, a file of several rows without a single negative
 *   amount, unless every one of those rows has a type column that says its direction.
 */
function refuseUnsignedAmounts(rows: readonly ParsedCheckingRow[], roles: ReadonlyMap<Role, number>): void {
  const typed = rows.filter((row) => row.amountMinor !== 0 && hasDirectionType(row));
  const against = typed.filter((row) => MONEY_OUT_TYPES.has(row.typeHint!) === row.amountMinor > 0);
  if (against.length > 0) {
    throw new CheckingExportFormatError(
      `${against.length} of ${typed.length} amounts are signed against their Type column (money out must be negative), `
      + `first at line ${against[0].line}; this layout is not supported`,
    );
  }
  const posted = rows.filter((row) => !row.pending);
  if (roles.has('amount') && !roles.has('balance') && posted.length >= UNSIGNED_SUSPICION_ROWS
    && posted.every((row) => row.amountMinor >= 0) && !posted.every(hasDirectionType)) {
    throw new CheckingExportFormatError(
      'no amount in this file is negative, so it does not show which way money moved (unsigned amounts); this layout is not supported',
    );
  }
}

/** Parses the decoded text of a Fifth Third activity CSV. */
export function parseFifthThirdCsv(text: string, options: CheckingAdapterOptions = {}): FifthThirdCsvResult {
  // Checked before anything is read or repeated: a mistyped whole account number is never echoed.
  if (options.accountLast4 !== undefined && !/^[0-9]{4}$/.test(options.accountLast4)) {
    throw new CheckingExportFormatError('--account must be the last four digits of the account number');
  }
  let records;
  try {
    records = parseCsv(text.replace(/^\ufeff/, ''), CSV_LIMITS);
  } catch (error) {
    // No account number is known yet, so the refusal names no line: fixed labels only.
    if (error instanceof CsvError) throw new CheckingExportFormatError(`the CSV is malformed: ${csvReason(error)}`);
    throw error;
  }
  if (records.length === 0) throw new CheckingExportFormatError('the CSV file is empty');
  const header = readHeader(records[0].fields);
  if (!header) throw new CheckingExportFormatError(NOT_FIFTH_THIRD);
  // Identity first: every Account Number cell and what the cells prove together, before anything that can refuse, so
  // every refusal carries them for the converter to keep out of all it prints.
  const accountColumn = header.roles.get('account');
  const accountCells = accountColumn === undefined ? []
    : [...new Set(records.slice(1).map((record) => record.fields[accountColumn]).filter(nonEmpty).map((cell) => cell.trim()))];
  const identity = fifthThirdAccountIdentity(accountCells.filter((cell) => fifthThirdAccountTokenProblem(cell) === null));
  const known = fifthThirdKnownAccountNumbers(identity, accountCells);
  return withAccountNumbers(known, () => readRecords(records.slice(1), header, identity, known, options));
}

/** A CSV parser's reason without the line it names: a refusal before any account number is known prints no input digits. */
function csvReason(error: CsvError): string {
  return error.message.replace(/^line \d+: /, '');
}

function readRecords(records: ReadonlyArray<{ fields: string[]; line: number }>, header: Header, identity: FifthThirdAccountIdentity,
  known: readonly string[], options: CheckingAdapterOptions): FifthThirdCsvResult {
  // One identity from every Account Number cell of the file, rows that cannot be read included: the cells must agree
  // digit for digit (accounts that merely share their last four are refused), what they prove together is kept, and a
  // cell that is not one account number is a row problem but still known to the converter's guard.
  if (identity.kind === 'several') {
    throw new CheckingExportFormatError(`this file holds more than one account (${identity.count}); download each account on its own`);
  }
  const accountLast4 = identity.kind === 'one' ? identity.last4 : null;
  const accountNumberRaw = identity.kind === 'one' ? identity.raw : null;
  // Every cell, a cell that is not one account number included, is known to the converter's guard, never written.
  const otherAccountCells = known.filter((cell) => cell !== accountNumberRaw);
  const { roles, width } = header;
  const currency = 'USD';
  const exponent = currencyExponent(currency);
  const rows: ParsedCheckingRow[] = [];
  const problems: CheckingRowProblem[] = [];
  const notes: string[] = [];
  let typeLabelsDropped = 0;

  for (const { fields, line } of records) {
    if (fields.length < width) {
      problems.push({ line, reason: `has ${fields.length} columns, the header has ${width} (the file may be truncated)` });
      continue;
    }
    if (fields.slice(width).some(nonEmpty)) {
      problems.push({ line, reason: `has ${fields.length} columns, the header has ${width}` });
      continue;
    }
    const cell = (role: Role): string | null => {
      const index = roles.get(role);
      return index === undefined ? null : fields[index];
    };
    const postedDate = parseExportDate(cell('date')!, 'mdy');
    if (!postedDate) {
      problems.push({ line, reason: 'Date is not a valid MM/DD/YYYY date' });
      continue;
    }
    let transactionDate: string | null = null;
    const rawTransactionDate = cell('transactionDate');
    if (nonEmpty(rawTransactionDate)) {
      transactionDate = parseExportDate(rawTransactionDate, 'mdy');
      if (!transactionDate) {
        problems.push({ line, reason: 'Transaction Date is not a valid MM/DD/YYYY date' });
        continue;
      }
    }
    const amount: AmountRead = roles.has('amount')
      ? (() => {
        const read = parseAmount(cell('amount')!, exponent, { thousands: true, symbols: true });
        return read.ok ? read : { ok: false as const, reason: `Amount ${read.reason}` };
      })()
      : readSplitAmount(cell('debit')!, cell('credit')!, exponent);
    if (!amount.ok) {
      problems.push({ line, reason: amount.reason });
      continue;
    }
    let runningBalanceMinor: number | null = null;
    const rawBalance = cell('balance');
    if (nonEmpty(rawBalance)) {
      const balance = parseAmount(rawBalance, exponent, { thousands: true, symbols: true });
      if (!balance.ok) {
        problems.push({ line, reason: `Balance ${balance.reason}` });
        continue;
      }
      runningBalanceMinor = balance.minor;
    }
    let checkNumber: string | null = null;
    const rawCheck = cell('checkNumber');
    if (nonEmpty(rawCheck)) {
      const digits = rawCheck.trim();
      if (!CHECK_NUMBER.test(digits)) {
        problems.push({ line, reason: 'Check Number is not a number of at most 10 digits' });
        continue;
      }
      checkNumber = /^0+$/.test(digits) ? null : digits.replace(/^0+(?=\d)/, '');
    }
    let pending = false;
    const rawStatus = cell('status');
    if (nonEmpty(rawStatus)) {
      const status = headerKey(rawStatus);
      if (status === 'pending') pending = true;
      else if (status !== 'posted' && status !== 'cleared') {
        problems.push({ line, reason: 'Status is neither Pending nor Posted' });
        continue;
      }
    }
    let typeHint: string | null = null;
    const rawType = cell('type');
    if (nonEmpty(rawType)) {
      const label = rawType.normalize('NFKC').replace(/\s+/g, ' ').trim();
      if (TYPE_LABEL.test(label) && !/[0-9]{3,}/.test(label)) typeHint = label.toUpperCase();
      else typeLabelsDropped += 1;
    }
    const rawAccount = cell('account');
    if (nonEmpty(rawAccount)) {
      const problem = fifthThirdAccountTokenProblem(rawAccount.trim());
      if (problem !== null) {
        problems.push({ line, reason: problem === 'no-last-four' ? 'Account Number has no last four digits' : 'Account Number is not one account number' });
        continue;
      }
    }
    const description = cell('description') ?? '';
    rows.push({
      line,
      postedDate,
      transactionDate,
      amountMinor: amount.minor,
      description,
      checkNumber,
      typeHint,
      externalId: null,
      runningBalanceMinor,
      pending,
      sourceTexts: [description, rawType, rawAccount],
    });
  }

  if (options.accountLast4 !== undefined && accountLast4 !== null && accountLast4 !== options.accountLast4) {
    throw new CheckingExportFormatError(`this file is for account ${accountLast4}, not the one --account names`);
  }
  refuseUnsignedAmounts(rows, roles);
  const order = dateOrder(rows.map((row) => row.postedDate));
  if (order === 'unsorted' && roles.has('balance')) {
    throw new CheckingExportFormatError(
      'the rows are not in date order, so their running balance cannot be followed (was the activity sorted by another '
      + 'column?); download it again as the bank lists it',
    );
  }
  const posting = postingOrder(rows, order);
  const chain = runningBalanceBreaks(posting.rows);
  if (chain.breaks.length > 0) {
    const [first, ...more] = chain.breaks;
    const where = `line ${first}${more.length > 0 ? ` and ${more.length} more` : ''}`;
    if (problems.length > 0) {
      throw new CheckingExportFormatError(
        `${problems.length} ${problems.length === 1 ? 'row' : 'rows'} could not be read (line ${problems[0].line}: ${problems[0].reason}), `
        + `and without them the running balance does not follow from the amounts at ${where}; download the activity again`,
      );
    }
    throw new CheckingExportFormatError(
      `the running balance does not follow from the amounts at ${where}: rows are missing or the export was edited; `
      + 'download the activity again',
    );
  }
  if (typeLabelsDropped > 0) notes.push(`${typeLabelsDropped} transaction type labels were not plain words and were left out`);
  if (roles.has('balance') && chain.pairs === 0 && posting.rows.length > 1) notes.push('no two rows had a running balance to check');
  if (posting.daysTurned > 0) notes.push(`${posting.daysTurned} days were listed in the other order within the day; the running balance decided`);
  if (order === 'unsorted') notes.push('the rows were listed in blocks of days rather than in date order; they were put in date order');

  return {
    parsed: {
      institution: FIFTH_THIRD_INSTITUTION,
      source: FIFTH_THIRD_CSV_SOURCE,
      currency,
      accountLast4,
      accountType: null,
      accountNumberRaw,
      ...(otherAccountCells.length > 0 ? { otherAccountNumbersRaw: otherAccountCells } : {}),
      madeAt: null,
      coverage: null,
      ledgerBalance: null,
      availableBalance: null,
      statement: null,
      rows: posting.rows,
      problems,
      droppedColumns: header.dropped,
      notes,
    },
    report: { fileOrder: order, daysTurned: posting.daysTurned, balancePairsChecked: chain.pairs },
  };
}

export const fifthThirdCsvAdapter: CheckingExportAdapter = Object.freeze({
  source: FIFTH_THIRD_CSV_SOURCE,
  institution: FIFTH_THIRD_INSTITUTION,
  input: 'text',
  description: 'Fifth Third account activity CSV (header: Date, Description, Check Number, Amount)',
  detect: (input: CheckingExportInput) => input.kind === 'text' && looksLikeFifthThirdCsv(input.text),
  parse: (input: CheckingExportInput, options: CheckingAdapterOptions) => {
    if (input.kind !== 'text') throw new CheckingExportFormatError('a CSV file is text, not a PDF');
    return parseFifthThirdCsv(input.text, options).parsed;
  },
  describe: (input: CheckingExportInput) => (input.kind === 'text' ? describeFifthThirdCsvLayout(input.text) : { text: false }),
});
