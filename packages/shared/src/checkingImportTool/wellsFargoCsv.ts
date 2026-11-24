/**
 * Wells Fargo's account activity CSV download, in either layout Wells Fargo has served:
 * - the current one: a header row `DATE, DESCRIPTION, AMOUNT, CHECK #, STATUS`, then one row per transaction with the
 *   posting date (MM/DD/YYYY), the description, the signed amount (money out negative), a check number or nothing,
 *   and `Posted` or `Pending`;
 * - the older "Comma Delimited" one: no header and five columns: date, amount, `*`, check number, description.
 * Wells Fargo writes no balance, no reference and no period into either file, so the converter needs --through (the
 * last day whose activity was complete when it was downloaded) and keys rows by content alone. Pending rows are
 * returned as pending, which the converter never imports.
 */
import { isCardImportDate } from '../cardImport.js';
import { parseAmount } from '../cardImportTool/amount.js';
import { CsvError, parseCsv, type CsvRecord } from '../cardImportTool/csv.js';
import {
  CheckingExportFormatError,
  withAccountNumbers,
  type CheckingAdapterOptions,
  type CheckingExportAdapter,
  type CheckingExportInput,
  type ParsedCheckingExport,
  type ParsedCheckingRow,
} from './parsed.js';

const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const LIMITS = { maxRecords: 60_002, maxFields: 16, maxFieldLength: 10_000 };
const HEADER = ['DATE', 'DESCRIPTION', 'AMOUNT', 'CHECK #', 'STATUS'];
const HEADER_LINE = /^"?DATE"?,"?DESCRIPTION"?,"?AMOUNT"?,"?CHECK #"?,"?STATUS"?\s*(?:\r\n|\r|\n|$)/i;
const LEGACY_LINE = /^"\d{2}\/\d{2}\/\d{4}","[-+]?[0-9,]*\.?[0-9]*","\*","[0-9]*","/;

function isoDate(raw: string): string | null {
  const match = DATE.exec(raw.trim());
  if (!match) return null;
  const date = `${match[3]}-${match[1]}-${match[2]}`;
  return isCardImportDate(date) ? date : null;
}

function firstLine(text: string): string {
  return text.replace(/^\ufeff/, '').split(/\r\n|\r|\n/, 1)[0] ?? '';
}

interface Fields {
  date: string;
  amount: string;
  check: string;
  description: string;
  status: string | null;
}

/** One record's fields by layout; a record of another shape refuses the file, naming its line. */
function fieldsOf(record: CsvRecord, headed: boolean): Fields {
  const fields = record.fields;
  if (fields.length !== 5) throw new CheckingExportFormatError(`line ${record.line}: has ${fields.length} columns; a Wells Fargo CSV has 5`);
  if (headed) {
    const [date, description, amount, check, status] = fields;
    return { date, amount, check, description, status };
  }
  const [date, amount, marker, check, description] = fields;
  if (marker.trim() !== '*' && marker.trim() !== '') {
    throw new CheckingExportFormatError(`line ${record.line}: column 3 is not the * Wells Fargo writes; this does not look like a Wells Fargo CSV`);
  }
  return { date, amount, check, description, status: null };
}

/**
 * Parses the decoded text of a Wells Fargo checking CSV download. The format names no account number, so the file's
 * identity is known (empty) from the start, and its refusals never leave it unknown.
 */
export function parseWellsFargoCsv(text: string): ParsedCheckingExport {
  return withAccountNumbers([], () => readWellsFargoCsv(text));
}

function readWellsFargoCsv(text: string): ParsedCheckingExport {
  let records: CsvRecord[];
  try {
    records = parseCsv(text.replace(/^\ufeff/, ''), LIMITS).filter((record) => !record.fields.every((field) => field.trim() === ''));
  } catch (error) {
    if (error instanceof CsvError) throw new CheckingExportFormatError(`the CSV is malformed: ${error.message}`);
    throw error;
  }
  const headed = records.length > 0 && records[0].fields.length === HEADER.length
    && records[0].fields.every((field, index) => field.trim().toUpperCase() === HEADER[index]);
  if (!headed && records.length > 0 && /date/i.test(records[0].fields[0] ?? '')) {
    throw new CheckingExportFormatError(`line ${records[0].line}: the header is not ${HEADER.join(', ')}; this layout is not supported`);
  }
  const rows: ParsedCheckingRow[] = [];
  const problems: ParsedCheckingExport['problems'] = [];
  for (const record of headed ? records.slice(1) : records) {
    const { date, amount: amountRaw, check: checkRaw, description, status } = fieldsOf(record, headed);
    const postedDate = isoDate(date);
    if (!postedDate) {
      problems.push({ line: record.line, reason: 'the date is not a valid MM/DD/YYYY date' });
      continue;
    }
    const amount = parseAmount(amountRaw, 2, { thousands: true });
    if (!amount.ok) {
      problems.push({ line: record.line, reason: `the amount ${amount.reason}` });
      continue;
    }
    const check = checkRaw.trim();
    if (check !== '' && !/^[0-9]{1,10}$/.test(check)) {
      problems.push({ line: record.line, reason: 'the check number column holds something other than 1 to 10 digits' });
      continue;
    }
    const state = status?.trim().toLowerCase() ?? 'posted';
    if (state !== 'posted' && state !== 'pending') {
      problems.push({ line: record.line, reason: 'the status is neither Posted nor Pending' });
      continue;
    }
    rows.push({
      line: record.line,
      postedDate,
      transactionDate: null,
      amountMinor: amount.minor,
      description,
      checkNumber: check === '' ? null : check,
      typeHint: null,
      externalId: null,
      runningBalanceMinor: null,
      pending: state === 'pending',
      sourceTexts: [description, checkRaw],
    });
  }
  // Wells Fargo lists newest first; the payload wants oldest first. Within a day the order is kept, reversed with the file.
  const descending = rows.length > 1 && rows[0].postedDate > rows[rows.length - 1].postedDate;
  const ordered = (descending ? [...rows].reverse() : rows)
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (a.row.postedDate < b.row.postedDate ? -1 : a.row.postedDate > b.row.postedDate ? 1 : a.index - b.index))
    .map(({ row }) => row);
  return {
    institution: 'wellsfargo',
    source: 'wf-csv',
    currency: 'USD',
    accountLast4: null,
    accountType: null,
    accountNumberRaw: null,
    madeAt: null,
    coverage: null,
    statement: null,
    ledgerBalance: null,
    availableBalance: null,
    rows: ordered,
    problems,
    droppedColumns: [],
    notes: headed ? [] : ['the older layout without a header row'],
  };
}

export const wellsFargoCsvAdapter: CheckingExportAdapter = Object.freeze({
  source: 'wf-csv',
  institution: 'wellsfargo',
  input: 'text',
  description: 'Wells Fargo account activity CSV (DATE, DESCRIPTION, AMOUNT, CHECK #, STATUS; or the older five columns with *)',
  detect: (input: CheckingExportInput) => input.kind === 'text' && (HEADER_LINE.test(firstLine(input.text)) || LEGACY_LINE.test(firstLine(input.text))),
  parse: (input: CheckingExportInput, _options: CheckingAdapterOptions) => {
    if (input.kind !== 'text') throw new CheckingExportFormatError('a CSV file is text, not a PDF');
    return parseWellsFargoCsv(input.text);
  },
});
