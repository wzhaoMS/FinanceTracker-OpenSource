/**
 * Wells Fargo "Download Account Activity" CSV, the deepest export Wells
 * Fargo offers for a credit card: up to 25 months, where its Quicken (QFX)
 * download reaches 18.
 *
 * Two layouts are read:
 * - the current one, with a header row naming DATE, DESCRIPTION, AMOUNT and
 *   usually CHECK # and STATUS (Posted or Pending), newest rows first;
 * - the older one without a header: five columns, the date, the amount, `*`,
 *   a check number or nothing, and the description.
 *
 * Allowlist: DATE, DESCRIPTION, AMOUNT and STATUS (read only to refuse a row
 * Wells Fargo marks Pending in a conversion that writes every row as posted).
 * CHECK # and every other column are dropped unread; the summary names CHECK #
 * by that label and any other column by its position only (`column 6`), never
 * by its header text. The file has no
 * reference, card number or posted date: rows are keyed by content
 * (fingerprints), the payload names no card, and DATE is stored as the
 * transaction date.
 *
 * Wells Fargo writes money leaving the account as negative amounts, a card's
 * charges included, and payments and credits as positive ones; Holdr's sign
 * is the opposite. Only card payment rows show which sign a file uses, so
 * without `sign` every one of them must read as a credit under Wells Fargo's
 * usual sign: a file with none, or with payment rows that disagree, is
 * refused rather than read with a guessed sign, which would turn every charge
 * into a credit. A file whose card payments come out as charges is either
 * inverted (re-run with `sign` inverted) or a deposit account's download,
 * where paying a card is money out.
 */
import { currencyExponent, parseAmount } from './amount.js';
import { parseExportDate, type DateOrder } from './amexCsv.js';
import { classifyCardKind } from './classify.js';
import { parseCsv, type CsvRecord } from './csv.js';
import type { OfxSign } from './ofx.js';
import { ExportFormatError, type ParsedExport, type ParsedRow, type RowProblem } from './parsed.js';

export interface WfCsvOptions {
  currency: string;
  dateOrder: DateOrder;
  /**
   * `standard`: charges negative (Wells Fargo's usual sign); `inverted`: charges positive. Null takes
   * `standard` only when the file has card payment rows and every one of them shows it, and refuses otherwise.
   */
  sign: OfxSign | null;
  /** `posted` refuses rows Wells Fargo marks Pending: the conversion would write them as posted. */
  status: 'posted' | 'pending' | null;
}

type WfField = 'date' | 'description' | 'amount' | 'status' | 'check';

const COLUMNS: Record<string, WfField> = {
  date: 'date',
  description: 'description',
  amount: 'amount',
  status: 'status',
  'check #': 'check',
  'check number': 'check',
};
const REQUIRED: readonly WfField[] = ['date', 'description', 'amount'];
const LABELS: Record<WfField, string> = {
  date: 'DATE',
  description: 'DESCRIPTION',
  amount: 'AMOUNT',
  status: 'STATUS',
  check: 'CHECK #',
};
/** The older headerless layout: column positions. */
const LEGACY = { columns: 5, date: 0, amount: 1, marker: 2, check: 3, description: 4 } as const;
const RETURNED = /\b(?:RETURNED|REVERSED|REVERSAL|DISHONOU?RED|NSF)\b/i;

function headerKey(name: string): string {
  return name.normalize('NFKC').replace(/^\ufeff/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isLegacyRecord(record: CsvRecord, order: DateOrder): boolean {
  return record.fields.length === LEGACY.columns && record.fields[LEGACY.marker].trim() === '*'
    && parseExportDate(record.fields[LEGACY.date], order) !== null;
}

interface Layout {
  legacy: boolean;
  columns: Map<WfField, number>;
  width: number;
  dropped: string[];
  body: CsvRecord[];
}

function readLayout(records: CsvRecord[], order: DateOrder): Layout {
  const first = records[0];
  if (isLegacyRecord(first, order)) {
    const columns = new Map<WfField, number>([
      ['date', LEGACY.date], ['amount', LEGACY.amount], ['check', LEGACY.check], ['description', LEGACY.description],
    ]);
    return { legacy: true, columns, width: LEGACY.columns, dropped: [LABELS.check], body: records };
  }
  const columns = new Map<WfField, number>();
  const dropped: string[] = [];
  first.fields.forEach((name, index) => {
    const role = COLUMNS[headerKey(name)];
    if (!role) {
      // Named by position only: a header cell can hold any text, a name or an account number included.
      if (name.trim() !== '') dropped.push(`column ${index + 1}`);
      return;
    }
    if (columns.has(role)) throw new ExportFormatError(`the header has more than one ${LABELS[role]} column`);
    columns.set(role, index);
    if (role === 'check') dropped.push(LABELS.check);
  });
  const missing = REQUIRED.filter((role) => !columns.has(role));
  if (missing.length > 0) {
    throw new ExportFormatError(
      'this does not look like a Wells Fargo CSV export: the first line must be a header with '
      + `${REQUIRED.map((role) => LABELS[role]).join(', ')} (missing ${missing.map((role) => LABELS[role]).join(', ')}), `
      + 'or a row of the older five-column layout (date, amount, *, check number, description)',
    );
  }
  return { legacy: false, columns, width: first.fields.length, dropped, body: records.slice(1) };
}

export function parseWfCsv(text: string, options: WfCsvOptions): ParsedExport {
  const records = parseCsv(text);
  if (records.length === 0) throw new ExportFormatError('the CSV file is empty');
  const layout = readLayout(records, options.dateOrder);
  const exponent = currencyExponent(options.currency);
  const rows: ParsedRow[] = [];
  const problems: RowProblem[] = [];
  let pendingMarked = 0;
  for (const record of layout.body) {
    const { fields, line } = record;
    if (fields.length < layout.width) {
      problems.push({ line, reason: `has ${fields.length} columns, ${layout.legacy ? 'the layout' : 'the header'} has ${layout.width} (the file may be truncated)` });
      continue;
    }
    if (fields.slice(layout.width).some((value) => value.trim() !== '')) {
      problems.push({ line, reason: `has ${fields.length} columns, ${layout.legacy ? 'the layout' : 'the header'} has ${layout.width}` });
      continue;
    }
    const cell = (role: WfField): string | null => {
      const index = layout.columns.get(role);
      return index === undefined ? null : fields[index];
    };
    if (layout.legacy && fields[LEGACY.marker].trim() !== '*') {
      problems.push({ line, reason: 'column 3 is not * as in the rest of the file' });
      continue;
    }
    const transactionDate = parseExportDate(cell('date')!, options.dateOrder);
    if (!transactionDate) {
      problems.push({ line, reason: `${LABELS.date} is not a valid ${options.dateOrder.toUpperCase()} date` });
      continue;
    }
    const amount = parseAmount(cell('amount')!, exponent, { thousands: true, symbols: true });
    if (!amount.ok) {
      problems.push({ line, reason: `${LABELS.amount} ${amount.reason}` });
      continue;
    }
    const status = cell('status');
    if (status !== null) {
      const word = status.trim().toLowerCase();
      if (word === 'pending') {
        pendingMarked += 1;
      } else if (word !== 'posted') {
        problems.push({ line, reason: `${LABELS.status} is neither Posted nor Pending` });
        continue;
      }
    }
    rows.push({
      line,
      transactionDate,
      postedDate: null,
      postedAt: null,
      amountMinor: amount.minor,
      description: cell('description')!,
      merchant: null,
      issuerCategory: null,
      externalId: null,
      last4: null,
      member: null,
      typeHint: null,
      sourceTexts: [cell('description'), cell('check')],
    });
  }
  if (pendingMarked > 0 && options.status === 'posted') {
    throw new ExportFormatError(
      `${pendingMarked} row${pendingMarked === 1 ? ' is' : 's are'} marked Pending by Wells Fargo, and --status posted would `
      + 'write every row as posted: download the activity again without "Include pending transactions", or convert it '
      + 'with --status pending',
    );
  }

  // Card payments are credits in Holdr's sign, and the only rows that show which sign a file uses.
  // Without --ofx-sign, every one of them must read as a credit under the usual sign: no payment
  // row, or payment rows that disagree, leave the sign unproven, and a wrong one would turn every
  // charge into a credit, so it is never guessed. (A file without a readable row has nothing to sign:
  // the converter reports its unreadable rows, if any, instead.) A returned or reversed payment is a
  // charge, so it does not count, nor does a row that names a fee: a fee for a payment, or one given back,
  // is no card payment (classifyCardKind).
  const flipOf = (sign: OfxSign) => (sign === 'standard' ? -1 : 1);
  const payments = rows.filter((row) => row.amountMinor !== 0 && !RETURNED.test(row.description)
    && classifyCardKind({ amountMinor: -Math.abs(row.amountMinor), description: row.description }) === 'payment');
  const asCharges = (sign: OfxSign) => payments.filter((row) => row.amountMinor * flipOf(sign) > 0).length;
  const notes: string[] = [];
  const sign: OfxSign = options.sign ?? 'standard';
  if (options.sign === null && rows.length > 0) {
    const charges = asCharges('standard');
    if (payments.length === 0) {
      throw new ExportFormatError(
        'no card payment row in this file shows the amount sign: check a purchase in the file and re-run with '
        + '--ofx-sign standard (Wells Fargo\'s usual sign: charges negative) or --ofx-sign inverted (charges positive)',
      );
    }
    if (charges * 2 > payments.length) {
      throw new ExportFormatError(
        `${charges} of ${payments.length} card payment rows would be charges under Wells Fargo's usual sign `
        + '(charges negative, payments and credits positive). A deposit account\'s download (checking or savings), where '
        + 'paying a card is money out, cannot be imported as card spending; for a card whose file writes charges as '
        + 'positive amounts, check a purchase in the file and re-run with --ofx-sign inverted',
      );
    }
    if (charges > 0) {
      throw new ExportFormatError(
        `the card payment rows disagree on the amount sign: ${payments.length - charges} of ${payments.length} are credits `
        + `under Wells Fargo's usual sign (charges negative) and ${charges} would be charges. Check a purchase in the file `
        + 'and re-run with --ofx-sign standard (charges negative) or --ofx-sign inverted (charges positive)',
      );
    }
  } else if (options.sign !== null && payments.length > 0 && asCharges(options.sign) * 2 > payments.length) {
    notes.push(`most card payment rows would be charges under --ofx-sign ${options.sign}`);
  }
  for (const row of rows) row.amountMinor = row.amountMinor * flipOf(sign) + 0;
  if (layout.legacy) notes.push('read the older headerless Wells Fargo layout');

  return {
    source: 'wf-csv',
    issuer: 'wellsfargo',
    currency: options.currency,
    coverage: null,
    madeAt: null,
    listEndAt: null,
    ledger: null,
    rows,
    problems,
    droppedColumns: layout.dropped,
    hasMemberColumn: false,
    hasCardColumn: false,
    notes,
  };
}
