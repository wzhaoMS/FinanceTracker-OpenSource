/**
 * American Express CSV (the "Download your transactions" CSV, with or
 * without "Include all additional transaction details").
 *
 * Allowlist: Date, Description, Amount, Category, Reference (hashed), Card
 * Member (mapped to an owner or dropped) and Account # (last four digits
 * only). Every other column, including Extended Details, the merchant
 * address and "Appears On Your Statement As", is dropped unread. Amex writes
 * charges as positive amounts and payments and credits as negative ones,
 * which is already Holdr's sign.
 *
 * The file has no status column and no posted date, and states neither its
 * statement period nor the day it was downloaded, so nothing in it tells a
 * closed statement from the current period's activity, which can hold
 * authorizations: the owner says which (the converter's `status`).
 */
import { cardLast4 } from '../cardNumbers.js';
import { isCardImportDate } from '../cardImport.js';
import { currencyExponent, parseAmount } from './amount.js';
import { parseCsv } from './csv.js';
import { ExportFormatError, type ParsedExport, type ParsedRow, type RowProblem } from './parsed.js';

export type DateOrder = 'mdy' | 'dmy' | 'ymd';

export interface AmexCsvOptions {
  currency: string;
  dateOrder: DateOrder;
}

type AmexField = 'date' | 'description' | 'amount' | 'category' | 'reference' | 'member' | 'account';

const COLUMNS: Record<string, AmexField> = {
  date: 'date',
  description: 'description',
  amount: 'amount',
  category: 'category',
  reference: 'reference',
  'card member': 'member',
  cardmember: 'member',
  'account #': 'account',
  'account number': 'account',
};
const REQUIRED: readonly AmexField[] = ['date', 'description', 'amount'];
const LABELS: Record<AmexField, string> = {
  date: 'Date',
  description: 'Description',
  amount: 'Amount',
  category: 'Category',
  reference: 'Reference',
  member: 'Card Member',
  account: 'Account #',
};

function headerKey(name: string): string {
  return name.normalize('NFKC').replace(/^\ufeff/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A dropped column's header as printed in summaries: only short, plain names; anything else by position. */
export function safeColumnLabel(name: string, index: number): string {
  const clean = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return /^[A-Za-z][A-Za-z /#&'().-]{0,40}$/.test(clean) ? clean : `column ${index + 1}`;
}

/** Parses a date in the given order into YYYY-MM-DD, or null. */
export function parseExportDate(raw: string, order: DateOrder): string | null {
  const text = raw.trim();
  let year: string;
  let month: string;
  let day: string;
  if (order === 'ymd') {
    const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
    if (!match) return null;
    [, year, month, day] = match;
  } else {
    const match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
    if (!match) return null;
    if (order === 'mdy') [, month, day, year] = match;
    else [, day, month, year] = match;
  }
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return isCardImportDate(iso) ? iso : null;
}

function stripReferenceQuotes(raw: string): string | null {
  // Amex writes references as 'NNNNNNNNNNNNNNNNNN' (N = digit) so spreadsheets keep them as text; a
  // re-saved file may have lost the apostrophes, so they never count.
  const value = raw.trim().replace(/^'+/, '').replace(/'+$/, '').trim();
  return value === '' ? null : value;
}

export function parseAmexCsv(text: string, options: AmexCsvOptions): ParsedExport {
  const records = parseCsv(text);
  if (records.length === 0) throw new ExportFormatError('the CSV file is empty');
  const header = records[0];
  const roles = new Map<AmexField, number>();
  const droppedColumns: string[] = [];
  header.fields.forEach((name, index) => {
    const role = COLUMNS[headerKey(name)];
    if (!role) {
      if (name.trim() !== '') droppedColumns.push(safeColumnLabel(name, index));
      return;
    }
    if (roles.has(role)) throw new ExportFormatError(`the header has more than one ${LABELS[role]} column`);
    roles.set(role, index);
  });
  const missing = REQUIRED.filter((role) => !roles.has(role));
  if (missing.length > 0) {
    throw new ExportFormatError(
      `this does not look like an American Express CSV export: the first line must be a header with ${REQUIRED.map((role) => LABELS[role]).join(', ')}`
      + ` (missing ${missing.map((role) => LABELS[role]).join(', ')})`,
    );
  }
  const exponent = currencyExponent(options.currency);
  const column = (role: AmexField) => roles.get(role);
  const rows: ParsedRow[] = [];
  const problems: RowProblem[] = [];
  let otherOrderWouldWork = 0;
  for (const record of records.slice(1)) {
    const { fields, line } = record;
    const extra = fields.slice(header.fields.length);
    if (fields.length < header.fields.length) {
      problems.push({ line, reason: `has ${fields.length} columns, the header has ${header.fields.length} (the file may be truncated)` });
      continue;
    }
    if (extra.some((value) => value.trim() !== '')) {
      problems.push({ line, reason: `has ${fields.length} columns, the header has ${header.fields.length}` });
      continue;
    }
    const cell = (role: AmexField): string | null => {
      const index = column(role);
      return index === undefined ? null : fields[index];
    };
    const rawDate = cell('date')!;
    const transactionDate = parseExportDate(rawDate, options.dateOrder);
    if (!transactionDate) {
      const alternative: DateOrder = options.dateOrder === 'mdy' ? 'dmy' : 'mdy';
      if (options.dateOrder !== 'ymd' && parseExportDate(rawDate, alternative)) otherOrderWouldWork += 1;
      problems.push({ line, reason: `Date is not a valid ${options.dateOrder.toUpperCase()} date` });
      continue;
    }
    const amount = parseAmount(cell('amount')!, exponent, { thousands: true, symbols: true });
    if (!amount.ok) {
      problems.push({ line, reason: `Amount ${amount.reason}` });
      continue;
    }
    const rawAccount = cell('account');
    let last4: string | null = null;
    if (rawAccount !== null && rawAccount.trim() !== '') {
      last4 = cardLast4(rawAccount);
      if (!last4) {
        problems.push({ line, reason: 'Account # has no last four digits' });
        continue;
      }
    }
    const category = cell('category');
    const member = cell('member');
    const reference = cell('reference');
    rows.push({
      line,
      transactionDate,
      postedDate: null,
      postedAt: null,
      amountMinor: amount.minor,
      description: cell('description')!,
      merchant: null,
      issuerCategory: category !== null && category.trim() !== '' ? category : null,
      externalId: reference === null ? null : stripReferenceQuotes(reference),
      last4,
      member: member !== null && member.trim() !== '' ? member : null,
      typeHint: null,
      sourceTexts: [cell('description'), category, member, rawAccount],
    });
  }
  const notes: string[] = [];
  if (otherOrderWouldWork > 0) {
    notes.push(`${otherOrderWouldWork} dates would be valid as ${options.dateOrder === 'mdy' ? 'DMY' : 'MDY'}; check --date-format`);
  }
  return {
    source: 'amex-csv',
    issuer: 'amex',
    currency: options.currency,
    coverage: null,
    madeAt: null,
    listEndAt: null,
    ledger: null,
    rows,
    problems,
    droppedColumns,
    hasMemberColumn: roles.has('member'),
    hasCardColumn: roles.has('account'),
    notes,
  };
}
