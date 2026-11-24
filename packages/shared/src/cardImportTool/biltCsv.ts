/**
 * Bilt Card CSV (issued by Cardless since 2026-02-07): bilt.com → Wallet → Recent activity → View all →
 * ⋮ → Download as CSV, by year, by month or a custom range of up to 365 days. Activity of the earlier
 * Wells Fargo-issued Bilt Mastercard is not in it; that comes from Wells Fargo as OFX/QFX.
 *
 * The export's columns: Transaction Date, Posted Date, Description, Amount, Card Last 4, Name on Card and
 * Raw Merchant Name, matched by header name (case, spacing, `_` and `-` aside), never by position. Name on
 * Card is never read: a cardholder's name has no place in Holdr. Card Last 4 is read only to tell
 * account-level rows (payments, fees, credits: no card) from card rows and to count rows per card in the
 * summary; it is not written. Any other column is dropped unread.
 *
 * Kept: the dates, the amount (exact; positive is money spent, as Bilt writes it, checked against the
 * export's own payments), the Raw Merchant Name as the description (the network's descriptor, which
 * enrichment does not rewrite), Bilt's Description as the description where there is no raw name and as
 * the merchant where it says something else. The export has no reference, and its Transaction Date can
 * move a day between two downloads of the same row, so each row is keyed by a reference made from its
 * posted date, amount and stored description, numbered among identical rows (and hashed like any issuer
 * reference).
 *
 * Status: bilt-csv is a posted-only format. The download holds posted rows only, each with a Posted
 * Date; a row without one refuses the whole file (its key could not match its posted row's later).
 * `--status export` writes every row as posted, as the export shows it; `--closed-through` writes rows
 * posted after the newest statement closing date as pending, and their keys post them in place later.
 *
 * Kinds the export's layout settles: an account-level row whose Description says "pay" or "payment"
 * ("Payment", "Pay card") is a payment to the card from a bank or points (a negative one money in; a
 * positive one a payment taken back), and so is an account-level credit that names housing, rent or a
 * mortgage: the bank funding Bilt books against a housing charge. Neither names a fee (FEE or FEES): a
 * row that does ("Late payment fee", "Returned payment fee", or a fee given back) is classified by its
 * words, as any other row. A housing charge (rent or a mortgage paid through Bilt's virtual housing
 * card) is a card row whose texts name housing, rent or a mortgage and that such a payment of the same
 * amount clears on the same posted date, one payment per charge: whether it counts as spending is the
 * owner's to say (`--loan-payments`). Both are stored under the category {@link BILT_HOUSING_CATEGORY}.
 * A Bilt housing row whose partner is not in the file is refused, never guessed; a rent or mortgage
 * word on any other purchase changes nothing. Everything else is classified by its description, as for
 * other exports.
 *
 * Messages and the summary name lines, columns and counts only, never a cell's text.
 */
import { canonicalCardDescription, sha256, toLetterHex } from '../cardDedupe.js';
import { CARD_IMPORT_NO_DESCRIPTION, sanitizeCardText } from '../cardImport.js';
import { hasCardFeeWord } from '../cardKinds.js';
import type { CardTransactionKind } from '../types.js';
import { currencyExponent, parseAmount } from './amount.js';
import { parseExportDate, safeColumnLabel, type DateOrder } from './amexCsv.js';
import { parseCsv } from './csv.js';
import { ExportFormatError, type ParsedExport, type ParsedRow, type RowProblem } from './parsed.js';

export interface BiltCsvOptions {
  currency: string;
  /** Slash dates' order; null reads ISO dates as ISO and slash dates as US month-first. */
  dateOrder: DateOrder | null;
}

/** Stored as the category of every housing charge and of the payment that clears it. */
export const BILT_HOUSING_CATEGORY = 'Housing payment';

type BiltField = 'date' | 'postedDate' | 'description' | 'amount' | 'card' | 'raw' | 'name';

const COLUMNS: Record<string, BiltField> = {
  'transaction date': 'date',
  'posted date': 'postedDate',
  description: 'description',
  amount: 'amount',
  'card last 4': 'card',
  'raw merchant name': 'raw',
  'name on card': 'name',
};
const LABELS: Record<BiltField, string> = {
  date: 'Transaction Date',
  postedDate: 'Posted Date',
  description: 'Description',
  amount: 'Amount',
  card: 'Card Last 4',
  raw: 'Raw Merchant Name',
  name: 'Name on Card',
};
const REQUIRED: readonly BiltField[] = ['date', 'postedDate', 'description', 'amount', 'card', 'raw'];

const PAYMENT_WORD = /\bPAY(?:MENT)?\b/i;
const BILT_WORD = /\bBILT\b/i;
const HOUSING_WORD = /\b(?:HOUSING|RENT|MORTGAGE)\b/i;

function headerKey(name: string): string {
  return name.normalize('NFKC').replace(/^\ufeff/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Text compared for sameness: case, spacing and invisible differences aside. */
function sameText(a: string, b: string): boolean {
  const form = (text: string) => text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim().toUpperCase();
  return form(a) === form(b);
}

/** A date as YYYY-MM-DD: ISO, or slash dates in `order` (US month-first by default). */
function parseBiltDate(raw: string, order: DateOrder | null): string | null {
  const text = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return order === null || order === 'ymd' ? parseExportDate(text, 'ymd') : null;
  return parseExportDate(text, order ?? 'mdy');
}

export function parseBiltCsv(text: string, options: BiltCsvOptions): ParsedExport {
  const records = parseCsv(text);
  if (records.length === 0) throw new ExportFormatError('the CSV file is empty');
  const header = records[0];
  const roles = new Map<BiltField, number>();
  const droppedColumns: string[] = [];
  header.fields.forEach((name, index) => {
    const role = COLUMNS[headerKey(name)];
    if (!role || role === 'name') {
      if (name.trim() !== '') droppedColumns.push(role === 'name' ? LABELS.name : safeColumnLabel(name, index));
      if (!role) return;
    }
    if (roles.has(role)) throw new ExportFormatError(`the header has more than one ${LABELS[role]} column`);
    roles.set(role, index);
  });
  const missing = REQUIRED.filter((role) => !roles.has(role));
  if (missing.length > 0) {
    throw new ExportFormatError(
      `this does not look like a Bilt card CSV export: the first line must be a header with ${REQUIRED.map((role) => LABELS[role]).join(', ')}`
      + ` (missing ${missing.map((role) => LABELS[role]).join(', ')})`,
    );
  }
  const exponent = currencyExponent(options.currency);
  const entries: Array<{ row: ParsedRow; card: string | null; housingWord: boolean; funds: boolean; biltWord: boolean }> = [];
  const problems: RowProblem[] = [];
  const perCard = new Map<string, number>();
  let accountLevel = 0;
  let accountPayments = 0;
  let positivePayments = 0;
  let unposted = 0;
  for (const record of records.slice(1)) {
    const { fields, line } = record;
    // Posted-only, checked before anything else: a row with no Posted Date (or cut off before it) refuses the whole
    // file, so no other problem of that row can let --skip-invalid drop it instead.
    const postedCell = fields[roles.get('postedDate')!];
    if (postedCell === undefined || postedCell.trim() === '') {
      unposted += 1;
      continue;
    }
    if (fields.length !== header.fields.length) {
      problems.push({ line, reason: `has ${fields.length} columns, the header has ${header.fields.length}${fields.length < header.fields.length ? ' (the file may be truncated)' : ''}` });
      continue;
    }
    // Name on Card is never read: only these columns are.
    const cell = (role: Exclude<BiltField, 'name'>): string | null => {
      const value = fields[roles.get(role)!];
      return value.trim() === '' ? null : value;
    };
    const transactionDate = parseBiltDate(cell('date') ?? '', options.dateOrder);
    if (!transactionDate) {
      problems.push({ line, reason: 'Transaction Date is not a valid date' });
      continue;
    }
    const postedDate = parseBiltDate(cell('postedDate')!, options.dateOrder);
    if (!postedDate) {
      problems.push({ line, reason: 'Posted Date is not a valid date' });
      continue;
    }
    if (postedDate < transactionDate) {
      problems.push({ line, reason: 'Posted Date is before Transaction Date' });
      continue;
    }
    const amount = parseAmount(cell('amount') ?? '', exponent);
    if (!amount.ok) {
      problems.push({ line, reason: `Amount ${amount.reason}` });
      continue;
    }
    const card = cell('card');
    if (card !== null && !/^[0-9]{4}$/.test(card.trim())) {
      problems.push({ line, reason: 'Card Last 4 is not four digits' });
      continue;
    }
    const described = cell('description');
    const raw = cell('raw');
    if (described === null && raw === null) {
      problems.push({ line, reason: 'Description and Raw Merchant Name are both empty' });
      continue;
    }
    // The network's descriptor keys the row; Bilt's own words are the merchant when they say something else.
    const description = raw ?? described!;
    const merchant = raw !== null && described !== null && !sameText(raw, described) ? described : null;
    const texts = [described, raw].filter((value): value is string => value !== null);
    const housingWord = texts.some((value) => HOUSING_WORD.test(value));
    // A row that names a fee is no payment, whatever else it says ("Late payment fee", "Returned payment fee", a fee
    // given back): its words classify it.
    const namesFee = texts.some((value) => hasCardFeeWord(value));
    let kind: CardTransactionKind | null = null;
    const trimmedCard = card === null ? null : card.trim();
    // The payment that funds a housing charge: an account-level credit that names housing, rent or a mortgage, and no fee.
    const funds = trimmedCard === null && housingWord && !namesFee && amount.minor < 0;
    if (trimmedCard === null) {
      accountLevel += 1;
      // A payment to the card ("Payment", "Pay card"), or the payment that funds a housing charge.
      if (amount.minor !== 0 && !namesFee && ((described !== null && PAYMENT_WORD.test(described)) || funds)) {
        kind = 'payment';
        accountPayments += 1;
        if (amount.minor > 0) positivePayments += 1;
      }
    } else {
      perCard.set(trimmedCard, (perCard.get(trimmedCard) ?? 0) + 1);
    }
    entries.push({
      card: trimmedCard,
      housingWord,
      funds,
      biltWord: texts.some((value) => BILT_WORD.test(value)),
      row: {
        line,
        transactionDate,
        postedDate,
        postedAt: null,
        amountMinor: amount.minor,
        description,
        merchant,
        // The payment that funds a housing charge carries the housing category too, so it can be told from a card payment.
        issuerCategory: funds ? BILT_HOUSING_CATEGORY : null,
        externalId: null,
        last4: null,
        member: null,
        typeHint: null,
        housingPayment: false,
        kind,
        exportStatus: 'posted',
        sourceTexts: [described, raw, described && raw ? `${described} ${raw}` : null, described && raw ? `${raw} ${described}` : null],
      },
    });
  }
  // bilt-csv is a posted-only format: a row without a Posted Date refuses the whole file, --skip-invalid or not.
  if (unposted > 0) {
    throw new ExportFormatError(
      `${unposted} row${unposted === 1 ? ' has' : 's have'} no Posted Date: a Bilt export is imported only when every row has `
      + 'posted (an authorization could not be matched to its posted row later); download the range again once they have posted',
    );
  }
  // Bilt writes money spent as positive amounts. Its payments say so: refuse a file where most are positive.
  if (accountPayments > 0 && positivePayments * 2 > accountPayments) {
    throw new ExportFormatError(
      `${positivePayments} of ${accountPayments} payments to the card are positive amounts, the opposite of Bilt's sign `
      + '(money spent positive); the tool refuses to guess',
    );
  }
  // A housing charge is a card row that names housing, rent or a mortgage and is cleared the same day by an
  // account-level payment of the same size that names it too (Bilt funds it from the bank). Pairs are
  // taken in file order, one payment per charge.
  const funding = new Map<string, number>();
  const pairKey = (row: ParsedRow, amountMinor: number) => `${row.postedDate}|${amountMinor}`;
  for (const entry of entries) {
    if (entry.funds) {
      const key = pairKey(entry.row, -entry.row.amountMinor);
      funding.set(key, (funding.get(key) ?? 0) + 1);
    }
  }
  const rows: ParsedRow[] = [];
  let housingCharges = 0;
  for (const entry of entries) {
    const { row } = entry;
    if (entry.card !== null && entry.housingWord) {
      const key = pairKey(row, row.amountMinor);
      if (row.amountMinor > 0 && (funding.get(key) ?? 0) > 0) {
        funding.set(key, funding.get(key)! - 1);
        row.housingPayment = true;
        row.issuerCategory = BILT_HOUSING_CATEGORY;
        housingCharges += 1;
      } else if (entry.biltWord) {
        // Bilt's housing row whose funding payment is not in this file: never guessed into a purchase.
        problems.push({ line: row.line, reason: 'is a Bilt housing row without the same-day payment that funds it in this file; download a range that holds both' });
        continue;
      }
    }
    rows.push(row);
  }
  // The export has no reference, and its Transaction Date can move a day between two downloads of the same row,
  // so a row's key is its posted date, amount and stored description, numbered among identical rows:
  // nothing Holdr does not store anyway, and the same in every download that holds that whole day.
  const occurrences = new Map<string, number>();
  for (const row of rows) {
    const text = canonicalCardDescription(sanitizeCardText(row.description, 500) ?? CARD_IMPORT_NO_DESCRIPTION);
    const group = JSON.stringify([row.postedDate, row.amountMinor, text]);
    const occurrence = occurrences.get(group) ?? 0;
    occurrences.set(group, occurrence + 1);
    const key = JSON.stringify(['bilt-csv', 1, row.postedDate, row.amountMinor, text, occurrence]);
    row.externalId = `bilt-csv:${toLetterHex(sha256(new TextEncoder().encode(key)))}`;
  }
  problems.sort((a, b) => a.line - b.line);
  const notes: string[] = [];
  const cards = [...perCard.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([last4, count]) => `${last4} ${count}`);
  notes.push(`rows by card (last 4, never written): ${[...cards, `account-level ${accountLevel}`].join(', ')}`);
  if (accountPayments > 0) {
    notes.push(`${accountPayments} account-level row${accountPayments === 1 ? ' was' : 's were'} written as card payments `
      + '(their Description says pay or payment, or they fund a housing charge)');
  }
  if (housingCharges > 0) {
    notes.push(`${housingCharges} housing charge${housingCharges === 1 ? '' : 's'}, each cleared the same day by an equal payment from the bank`);
  }
  return {
    source: 'bilt-csv',
    issuer: 'bilt',
    currency: options.currency,
    coverage: null,
    madeAt: null,
    listEndAt: null,
    ledger: null,
    rows,
    problems,
    droppedColumns,
    hasMemberColumn: false,
    hasCardColumn: false,
    notes,
  };
}
