/**
 * Raw export bytes to a redacted `holdr.card-import` payload plus a summary
 * for the person running the tool. Pure: no file system, clock, locale or
 * network, so every computer produces byte-identical JSON for the same file
 * and options. Messages name lines and columns, never cell values.
 *
 * Row status: an export of a statement period that has not closed can hold
 * authorizations that later change or disappear (a cancelled order), so its
 * rows must not be written as posted, which counts them as spending for good.
 * Only a Wells Fargo CSV marks rows pending (and those are only ever refused
 * under `posted`), an Amex CSV states nothing about its period, and the tool
 * has no clock, so there is no default: every
 * conversion says `status` (posted for a closed statement, pending for an
 * open period) or, with posted dates, `closedThrough`. An OFX file's own
 * dates (when it was made, where its list ends, when rows posted) are only
 * an extra check (`periodEvidence`): they warn when `posted` meets a list
 * that reaches the day the file was made, and bound `closedThrough`. They
 * never prove that a statement closed.
 *
 * Housing payments: a Bilt export marks rent and mortgage payments made
 * through the card. Whether they count as spending is the owner's to say, so
 * an export that holds any needs `loanPayments` (spending: purchases and
 * their refunds; not-spending: kind `other`, listed but never counted); there
 * is no default.
 */
import {
  buildCardImportPayload,
  CARD_IMPORT_MAX_RAW_TEXT,
  CardImportError,
  findCardImportSensitivePaths,
  isCardImportDate,
  reconcileCardImport,
  sanitizeCardText,
  serializeCardImportPayload,
  type CardImportDraftRow,
  type CardImportPayload,
  type CardImportReconciliation,
  type CardImportRowStatus,
  type CardImportStatement,
} from '../cardImport.js';
import { cardExternalIdHash } from '../cardDedupe.js';
import type { CardOwner, CardTransactionKind } from '../types.js';
import { currencyExponent, parseAmount } from './amount.js';
import { parseAmexCsv, type DateOrder } from './amexCsv.js';
import { parseBiltCsv } from './biltCsv.js';
import { classifyCardKind } from './classify.js';
import { decodeExport, type ExportEncoding } from './decode.js';
import { showsCardDigits } from './leaks.js';
import { parseOfx, type OfxSign } from './ofx.js';
import type { ParsedExport, ParsedRow, RowProblem, StatementMoment } from './parsed.js';
import { describeMoment, madeOnDates, reachesMadeOnDay } from './statementDates.js';
import { parseWfCsv } from './wfCsv.js';

export const CARD_IMPORT_TOOL_VERSION = '1.0.3';
export const CARD_IMPORT_TOOL_PARSER = `holdr-card-import@${CARD_IMPORT_TOOL_VERSION}`;
export const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
export const EXPORT_FORMATS = ['amex-csv', 'ofx', 'bilt-csv', 'wf-csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** Formats that name their issuer themselves. */
const FIXED_ISSUERS: Partial<Record<ExportFormat, string>> = { 'amex-csv': 'amex', 'bilt-csv': 'bilt', 'wf-csv': 'wellsfargo' };

/** How housing payments (rent or a loan paid through the card) count: the owner's choice, never a default. */
export const LOAN_PAYMENT_CHOICES = ['spending', 'not-spending'] as const;
export type LoanPaymentsChoice = (typeof LOAN_PAYMENT_CHOICES)[number];

export interface ExpectedTotals {
  /** Statement amounts as typed by the user, e.g. `1,234.56`. */
  charges?: string;
  credits?: string;
  net?: string;
  previousBalance?: string;
  newBalance?: string;
}

export interface MemberMapping {
  name: string;
  owner: CardOwner;
}

export interface ConvertOptions {
  format: ExportFormat;
  /** Issuer slug; fixed by the format for an Amex (`amex`), Bilt (`bilt`) or Wells Fargo (`wellsfargo`) CSV, required for OFX. */
  issuer?: string | null;
  /** Account currency; the CSV formats default to USD, OFX uses CURDEF. */
  currency?: string | null;
  encoding?: ExportEncoding;
  dateOrder?: DateOrder;
  members?: readonly MemberMapping[];
  cards?: readonly string[];
  coverage?: { start: string; end: string } | null;
  expected?: ExpectedTotals;
  skipInvalid?: boolean;
  ignoreIds?: boolean;
  /**
   * Amount sign of an OFX file or a Wells Fargo CSV (`standard`: charges negative). Without it, an OFX file whose
   * DEBIT/CREDIT amounts mostly disagree with `standard` is refused, and a Wells Fargo CSV is read as `standard` only
   * when it has card payment rows and every one of them shows that sign.
   */
  ofxSign?: OfxSign | null;
  /**
   * Every row's status: `posted` for a statement that has closed, `pending`
   * for activity of a period that has not (its charges may still change or
   * be cancelled, so they are not spending until a closed statement posts
   * them), or `export` for each row as the export itself shows it (bilt-csv:
   * posted, as every row's posted date shows). This or
   * `closedThrough` is required: there is no default.
   */
  status?: CardImportRowStatus | 'export' | null;
  /**
   * The closing date of the newest statement that has closed (YYYY-MM-DD):
   * rows posted on or before it are posted, rows posted after it pending.
   * Needs every row's posted date (OFX); not with `status`.
   */
  closedThrough?: string | null;
  /**
   * How the rows the export marks as housing payments count (bilt-csv):
   * `spending` writes them as purchases (refunds when negative),
   * `not-spending` as kind `other`, listed but never counted. Required when
   * the export holds any; there is no default.
   */
  loanPayments?: LoanPaymentsChoice | null;
}

/** The rows an export marks as housing payments, and how they were written. */
export interface HousingReport {
  choice: LoanPaymentsChoice | null;
  count: number;
  posted: number;
  pending: number;
  chargesMinor: number;
  creditsMinor: number;
}

/** What set the rows' statuses: `status`, `closedThrough`, or the export's own marks (`status: 'export'`). */
export type RowStatusBasis = 'status' | 'closed-through' | 'export';

/**
 * What an export's own dates say about its statement period, read in one
 * time zone: `open` when its list end or a posted date is on or after the
 * day the file was made, `closed` when all are before it, `unclear` when
 * their time zones do not let the tool tell, `unknown` when the export does
 * not say when it was made (any Amex CSV). `closed` is no proof: a file made
 * days after its last row can still hold a period that has not closed.
 */
export type PeriodEvidence = 'open' | 'closed' | 'unclear' | 'unknown';

export interface RowStatusReport {
  basis: RowStatusBasis;
  /** The `status` option, when it set the statuses. */
  status: CardImportRowStatus | null;
  /** The `closedThrough` date, when it set the statuses. */
  closedThrough: string | null;
  posted: number;
  pending: number;
  period: PeriodEvidence;
  /** When the export says it was made, as written (`2026-10-17 09:30 UTC-04:00`); null when it does not say. */
  madeAt: string | null;
  /** The latest date its list end or rows reach, as written. */
  reaches: string | null;
}

export interface MonthTotal {
  month: string;
  count: number;
  netMinor: number;
}

export interface ConvertReport {
  format: ExportFormat;
  encoding: string;
  currency: string;
  exponent: number;
  rowsRead: number;
  excludedByCard: number;
  rejected: RowProblem[];
  droppedColumns: string[];
  memberColumn: 'absent' | 'dropped' | 'mapped';
  owners: Partial<Record<CardOwner, number>>;
  cards: Record<string, number>;
  redactedRows: number;
  repeatedReferenceRows: number;
  coverageWidened: boolean;
  ledger: { amountMinor: number; asOf: string } | null;
  ledgerUsedAsNewBalance: boolean;
  reconciliation: CardImportReconciliation;
  status: RowStatusReport;
  /** Housing payments the export marks (bilt-csv); null for formats that mark none. */
  housing: HousingReport | null;
  /** Posted rows by the month of their posted date (transaction date when there is none). */
  byMonth: MonthTotal[];
  /** Pending rows, likewise. */
  pendingByMonth: MonthTotal[];
  /** Things the owner must read before importing, such as `--status posted` on a list that reaches the day it was made. */
  warnings: string[];
  notes: string[];
}

export interface ConvertResult {
  payload: CardImportPayload;
  /** Canonical JSON text, exactly as written to disk. */
  json: string;
  report: ConvertReport;
}

export class ConvertError extends Error {
  readonly problems: RowProblem[];
  constructor(message: string, problems: RowProblem[] = []) {
    super(message);
    this.name = 'ConvertError';
    this.problems = problems;
  }
}

const SLUG = /^[a-z][a-z0-9-]{0,31}$/;
const CARD_DIGITS_SHOWN = 'its text would show more than the last four digits of a card number in this row '
  + '(a repeated or shortened copy); remove the number from the export';
const MAX_REPORTED_PROBLEMS = 20;

function memberKey(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, ' ').trim().toUpperCase();
}

function expectedFigure(raw: string | undefined, label: string, exponent: number, mode: 'magnitude' | 'negative' | 'signed'): number | null {
  if (raw === undefined) return null;
  const parsed = parseAmount(raw, exponent, { thousands: true, symbols: true });
  if (!parsed.ok) throw new ConvertError(`--expect-${label} ${parsed.reason}`);
  if (Math.abs(parsed.minor) > 99_999_999_999) throw new ConvertError(`--expect-${label} is too large`);
  if (mode === 'magnitude') return Math.abs(parsed.minor);
  if (mode === 'negative') return -Math.abs(parsed.minor) + 0;
  return parsed.minor;
}

function referenceHash(row: ParsedRow): string | null {
  return row.externalId && row.externalId.trim() !== '' ? cardExternalIdHash(row.externalId) : null;
}

/** How often each reference occurs in the whole export (before any --card filter). */
function countReferences(rows: readonly ParsedRow[], options: ConvertOptions): Map<string, number> {
  const counts = new Map<string, number>();
  if (options.ignoreIds) return counts;
  for (const row of rows) {
    const hash = referenceHash(row);
    if (hash) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  return counts;
}

/**
 * Fingerprints number identical id-less rows within one export, and payload,
 * storage and fingerprints have no per-row card yet. Importing one card's rows
 * at a time would restart that numbering per card, so the same coffee on two
 * cards of one billing account would get one key and the second would be
 * dropped as a duplicate. The same happens to a reference that repeats on
 * another card: each card's subset sees it once and hashes it to the same
 * key. Until card scope exists, a card subset is allowed only when every row
 * has a reference that is unique in the whole export (`counts`, taken before
 * filtering). An OFX file's statements are separate accounts, each with its
 * own FITID space, so there the whole export is the chosen statement.
 */
function refuseCardSubsetsKeyedByContent(rows: readonly ParsedRow[], counts: ReadonlyMap<string, number>, options: ConvertOptions): void {
  const byContent = options.ignoreIds ? rows.length : rows.filter((row) => {
    const hash = referenceHash(row);
    return hash === null || (counts.get(hash) ?? 0) > 1;
  }).length;
  if (byContent === 0) return;
  const reference = options.format === 'ofx' ? 'FITID' : 'Reference';
  throw new ConvertError(
    `--card cannot be used here: ${options.ignoreIds
      ? '--ignore-ids matches every row by content'
      : `${byContent} ${byContent === 1 ? 'row has' : 'rows have'} no ${reference} that is unique in the whole export`}, `
    + 'so identical purchases on two cards of one billing account would get the same dedupe key and the second would be '
    + 'dropped as a duplicate. Import the whole export into its billing account without --card'
    + (options.format === 'amex-csv' ? ', or download the CSV with "Include all additional transaction details"' : ''),
  );
}

/** The one answer to a conversion that does not say whether its statement period has closed. */
const STATUS_REQUIRED = 'say whether this export\'s statement period has closed (nothing in an export proves it): '
  + '--status posted if every row is on a statement that has closed, --status pending for the activity of a period '
  + 'that has not (its charges can still change or be cancelled, so they are not spending until the closed statement '
  + 'is imported), or, for an OFX file, --closed-through YYYY-MM-DD (the newest closing date: rows posted after it '
  + 'pending, the rest posted)';
/** A Bilt export shows every row posted by its Posted Date, so it offers one more choice. */
const STATUS_REQUIRED_BILT = `${STATUS_REQUIRED.replace('for an OFX file', 'for an OFX file or a Bilt export')}; for a Bilt `
  + 'export, --status export writes every row as posted, as its Posted Date shows (a Bilt export with a row that has none is refused)';

/** Where the list ends and when each row posted, with time and offset: the dates compared with when the file was made. */
function statementMoments(rows: readonly ParsedRow[], parsed: ParsedExport): StatementMoment[] {
  return [parsed.listEndAt, ...rows.map((row) => row.postedAt)].filter((moment): moment is StatementMoment => moment !== null);
}

function latestDate(dates: Iterable<string>): string | null {
  let latest: string | null = null;
  for (const date of dates) if (latest === null || date > latest) latest = date;
  return latest;
}

/** The newest date the export covers: its list end and every row's posted date (transaction date when it has none). */
function newestDate(rows: readonly ParsedRow[], parsed: ParsedExport): string | null {
  return latestDate([...statementMoments(rows, parsed).map((moment) => moment.date), ...rows.map((row) => row.postedDate ?? row.transactionDate)]);
}

/** When the file was made, as written, plus the day that is where `dated` is dated, when that is one other day. */
function madeText(made: StatementMoment, dated: StatementMoment): string {
  const { first, last } = madeOnDates(made, dated);
  return `${describeMoment(made)}${first === last && first !== made.date ? `, ${first} where its dates are written` : ''}`;
}

interface Evidence {
  period: PeriodEvidence;
  reaches: string | null;
  /** For `open` and `unclear`: the latest list date that does, or may, reach the day the file was made. */
  reaching: StatementMoment | null;
}

/**
 * What an export's own dates say about its statement period (PeriodEvidence):
 * its list end and each posted date against the day the file was made, that
 * day taken in the date's own time zone, never by comparing date prefixes
 * written in different zones, and never with a clock.
 */
function periodEvidence(rows: readonly ParsedRow[], parsed: ParsedExport): Evidence {
  const moments = statementMoments(rows, parsed);
  const reaches = newestDate(rows, parsed);
  if (!parsed.madeAt || moments.length === 0) return { period: 'unknown', reaches, reaching: null };
  let open: StatementMoment | null = null;
  let unclear: StatementMoment | null = null;
  for (const moment of moments) {
    const reach = reachesMadeOnDay(moment, parsed.madeAt);
    if (reach === 'yes' && (!open || moment.date > open.date)) open = moment;
    if (reach === 'maybe' && (!unclear || moment.date > unclear.date)) unclear = moment;
  }
  if (open) return { period: 'open', reaches, reaching: open };
  if (unclear) return { period: 'unclear', reaches, reaching: unclear };
  return { period: 'closed', reaches, reaching: null };
}

/** What the owner is told when `--status posted` meets dates that suggest, or cannot rule out, an open period. */
function postedWarnings(evidence: Evidence, parsed: ParsedExport): string[] {
  if (!parsed.madeAt || !evidence.reaching) return [];
  if (evidence.period === 'open') {
    return [`--status posted, but this export may include a statement period that has not closed: its dates run to `
      + `${evidence.reaching.date}, on or after the day it was made (${madeText(parsed.madeAt, evidence.reaching)}). Every row `
      + 'is written as posted on your word; if that period had not closed, its charges can still change or be cancelled: '
      + 'convert the export again with --status pending or --closed-through'];
  }
  return [`--status posted, but this export's statement period could not be checked: its dates run to ${evidence.reaching.date} `
    + `and it was made ${describeMoment(parsed.madeAt)}, in time zones that cannot be compared. Every row is written as posted `
    + 'on your word'];
}

/**
 * `closedThrough` must be before the day the file was made, that day taken
 * in the time zone of each date it splits; time zones that leave this
 * unclear refuse it. A file that does not say when it was made bounds it by
 * its own newest date, so a closing date after everything it holds (say, the
 * open period's future end) is refused either way.
 */
function checkClosedThrough(closedThrough: string, rows: readonly ParsedRow[], parsed: ParsedExport): void {
  if (!parsed.madeAt) {
    const newest = newestDate(rows, parsed);
    if (newest !== null && closedThrough >= newest) {
      throw new ConvertError(
        `--closed-through ${closedThrough} is not before the newest date in this export (${newest}), and the file does not say `
        + 'when it was made, so nothing in it shows that a statement closed then: if every row is on a statement that has '
        + 'closed, use --status posted',
      );
    }
    return;
  }
  let unclear: StatementMoment | null = null;
  for (const moment of statementMoments(rows, parsed)) {
    const { first, last } = madeOnDates(parsed.madeAt, moment);
    if (closedThrough >= last) {
      throw new ConvertError(
        `--closed-through ${closedThrough} is not before the day this export was made (${madeText(parsed.madeAt, moment)}), and `
        + 'a statement period that ends on or after that day had not closed when the file was made: give the closing date of '
        + 'the newest statement that has closed',
      );
    }
    if (closedThrough >= first && (!unclear || moment.date > unclear.date)) unclear = moment;
  }
  if (unclear) {
    throw new ConvertError(
      `--closed-through ${closedThrough} may not be before the day this export was made (${describeMoment(parsed.madeAt)}): `
      + `its dates (such as ${describeMoment(unclear)}) are written in time zones that do not let the tool tell. Give an `
      + 'earlier closing date, or use --status',
    );
  }
}

function parseExport(text: string, options: ConvertOptions): ParsedExport {
  if (options.format === 'amex-csv' || options.format === 'bilt-csv') {
    const fixed = FIXED_ISSUERS[options.format]!;
    if (options.issuer && options.issuer !== fixed) throw new ConvertError(`${options.format} exports are always issuer ${fixed}`);
    const currency = options.currency ?? 'USD';
    if (!/^[A-Z]{3}$/.test(currency)) throw new ConvertError('--currency must be a three-letter uppercase code');
    if (options.format === 'bilt-csv') {
      if ((options.cards ?? []).length > 0) {
        throw new ConvertError('--card is not supported for bilt-csv: import the whole export into its card account');
      }
      return parseBiltCsv(text, { currency, dateOrder: options.dateOrder ?? null });
    }
    return parseAmexCsv(text, { currency, dateOrder: options.dateOrder ?? 'mdy' });
  }
  if (options.format === 'wf-csv') {
    if (options.issuer && options.issuer !== 'wellsfargo') throw new ConvertError('wf-csv exports are always issuer wellsfargo');
    const currency = options.currency ?? 'USD';
    if (!/^[A-Z]{3}$/.test(currency)) throw new ConvertError('--currency must be a three-letter uppercase code');
    // `--status export` never gets here: it is refused for every format but bilt-csv.
    const status = options.status === 'posted' || options.status === 'pending' ? options.status : null;
    return parseWfCsv(text, { currency, dateOrder: options.dateOrder ?? 'mdy', sign: options.ofxSign ?? null, status });
  }
  const parsed = parseOfx(text, { sign: options.ofxSign ?? null, cards: options.cards ?? [] });
  if (options.currency && options.currency !== parsed.currency) {
    throw new ConvertError(`--currency ${options.currency} does not match the statement currency ${parsed.currency}`);
  }
  return parsed;
}

/** Converts one export. Throws `ConvertError` (or a parser error) with value-free messages. */
export function convertCardExport(bytes: Uint8Array, options: ConvertOptions): ConvertResult {
  if (!EXPORT_FORMATS.includes(options.format)) throw new ConvertError(`format must be one of ${EXPORT_FORMATS.join(', ')}`);
  if (bytes.length === 0) throw new ConvertError('the file is empty');
  if (bytes.length > MAX_EXPORT_BYTES) throw new ConvertError(`the file is larger than ${MAX_EXPORT_BYTES / 1024 / 1024} MB`);
  const issuer = FIXED_ISSUERS[options.format] ?? options.issuer;
  if (!issuer || !SLUG.test(issuer)) throw new ConvertError('--issuer must be a lowercase slug such as chase or citi');
  const cards = [...new Set(options.cards ?? [])];
  if (cards.some((card) => !/^[0-9]{4}$/.test(card))) throw new ConvertError('--card takes exactly four digits');
  if (options.format === 'wf-csv' && cards.length > 0) {
    throw new ConvertError('--card needs a card column, and a Wells Fargo CSV has none: import the whole export into its card account');
  }
  const status = options.status ?? null;
  if (status === 'export' && options.format !== 'bilt-csv') {
    throw new ConvertError(`--status export needs an export that shows each row's status (bilt-csv); ${options.format} does not`);
  }
  if (status !== null && status !== 'posted' && status !== 'pending' && status !== 'export') {
    throw new ConvertError(options.format === 'bilt-csv' ? '--status must be posted, pending or export' : '--status must be posted or pending');
  }
  const closedThrough = options.closedThrough ?? null;
  if (closedThrough !== null && !isCardImportDate(closedThrough)) throw new ConvertError('--closed-through must be a valid YYYY-MM-DD date');
  if (status !== null && closedThrough !== null) throw new ConvertError('--status and --closed-through cannot be used together');
  // No default: a status an export cannot prove is the owner's to state, every time.
  if (status === null && closedThrough === null) throw new ConvertError(options.format === 'bilt-csv' ? STATUS_REQUIRED_BILT : STATUS_REQUIRED);
  const loanPayments = options.loanPayments ?? null;
  if (loanPayments !== null && !(LOAN_PAYMENT_CHOICES as readonly string[]).includes(loanPayments)) {
    throw new ConvertError(`--loan-payments must be ${LOAN_PAYMENT_CHOICES.join(' or ')}`);
  }
  if (loanPayments !== null && options.format !== 'bilt-csv') {
    throw new ConvertError('--loan-payments applies to bilt-csv exports only: no other format marks housing payments');
  }
  if (options.ignoreIds && options.format === 'bilt-csv') {
    throw new ConvertError('--ignore-ids does not apply to bilt-csv: its rows are keyed by posted date, which does not change between downloads');
  }

  const decoded = decodeExport(bytes, options.encoding ?? 'auto');
  const parsed = parseExport(decoded.text, options);
  const exponent = currencyExponent(parsed.currency);
  const problems: RowProblem[] = [...parsed.problems];
  const notes = [...parsed.notes];

  // References are checked, and their uniqueness counted, on the whole export before any --card
  // filter: a reference that repeats on a card left out is still not unique.
  const validRows = parsed.rows.filter((row) => {
    // Text is redacted whole, never cut first; a value too long to redact is refused instead.
    const tooLong = (['description', 'merchant', 'issuerCategory'] as const)
      .find((field) => (row[field]?.length ?? 0) > CARD_IMPORT_MAX_RAW_TEXT);
    if (tooLong) {
      problems.push({ line: row.line, reason: `${tooLong} is longer than ${CARD_IMPORT_MAX_RAW_TEXT} characters; refused, never truncated` });
      return false;
    }
    if (options.ignoreIds || row.externalId === null || row.externalId.trim() === '') return true;
    try {
      cardExternalIdHash(row.externalId);
      return true;
    } catch (error) {
      const column = options.format === 'ofx' ? 'FITID' : 'Reference';
      problems.push({ line: row.line, reason: `${column} ${(error as Error).message.replace(/^card external id /, '')}` });
      return false;
    }
  });
  const referenceCounts = countReferences(validRows, options);

  let keptRows = validRows;
  let excludedByCard = 0;
  if (options.format === 'amex-csv' && cards.length > 0) {
    if (!parsed.hasCardColumn) throw new ConvertError('--card needs an Account # column, and this export has none');
    keptRows = validRows.filter((row) => row.last4 !== null && cards.includes(row.last4));
    excludedByCard = validRows.length - keptRows.length;
  }

  const mapping = new Map<string, CardOwner>();
  for (const member of options.members ?? []) {
    const key = memberKey(member.name);
    if (!key) throw new ConvertError('--member needs a name before =');
    if (mapping.has(key) && mapping.get(key) !== member.owner) throw new ConvertError('--member maps the same name to two owners');
    mapping.set(key, member.owner);
  }
  let memberColumn: ConvertReport['memberColumn'] = parsed.hasMemberColumn ? 'dropped' : 'absent';
  if (mapping.size > 0) {
    if (!parsed.hasMemberColumn) throw new ConvertError('--member was given, but this export has no Card Member column');
    memberColumn = 'mapped';
    for (const row of keptRows) {
      if (row.member !== null && !mapping.has(memberKey(row.member))) {
        throw new ConvertError(`line ${row.line}: Card Member is not in the --member mappings (names are never printed)`);
      }
    }
  }
  const ownersOf = (rows: readonly ParsedRow[]) => {
    const owners: Partial<Record<CardOwner, number>> = {};
    for (const row of rows) {
      const owner = row.member === null ? undefined : mapping.get(memberKey(row.member));
      if (owner) owners[owner] = (owners[owner] ?? 0) + 1;
    }
    return owners;
  };

  problems.sort((a, b) => a.line - b.line);
  if (problems.length > 0 && !options.skipInvalid) {
    throw new ConvertError(
      `${problems.length} row${problems.length === 1 ? '' : 's'} could not be read; fix the export or re-run with --skip-invalid`,
      problems.slice(0, MAX_REPORTED_PROBLEMS),
    );
  }
  if (cards.length > 0) refuseCardSubsetsKeyedByContent(keptRows, referenceCounts, options);
  if (closedThrough !== null && keptRows.some((row) => row.postedDate === null)) {
    throw new ConvertError(
      '--closed-through needs every row\'s posted date to tell which statement it is on, and this export has transaction '
      + 'dates only (a charge made before a closing date can post after it). Export each statement on its own, and import '
      + 'the current period\'s activity with --status pending',
    );
  }
  const markedPending = keptRows.filter((row) => row.exportStatus === 'pending').length;
  if (status === 'posted' && markedPending > 0) {
    throw new ConvertError(
      `--status posted, but this export itself marks ${markedPending} row${markedPending === 1 ? '' : 's'} pending: an `
      + 'authorization that can still change or be cancelled, which a posted row would count as spending for good. Use '
      + '--status export (each row as the export marks it) or --status pending',
    );
  }
  if (status === 'export') {
    const unmarked = keptRows.filter((row) => row.exportStatus !== 'posted' && row.exportStatus !== 'pending');
    if (unmarked.length > 0) {
      throw new ConvertError(
        `--status export, but ${unmarked.length} row${unmarked.length === 1 ? ' is' : 's are'} not marked settled or pending `
        + `(line ${unmarked[0].line} first): say --status posted or --status pending for this export`,
      );
    }
  }
  const housingRows = keptRows.filter((row) => row.housingPayment === true).length;
  if (housingRows > 0 && loanPayments === null) {
    throw new ConvertError(
      `this export marks ${housingRows} row${housingRows === 1 ? '' : 's'} as housing payments (rent or a loan paid through `
      + 'the card): say whether they count as spending (nothing in the export decides it): --loan-payments spending (each '
      + 'counts as a purchase, a negative one as its refund) or --loan-payments not-spending (kind other: listed, never '
      + 'counted, like a balance transfer)',
    );
  }
  const statusOf = (row: ParsedRow): CardImportRowStatus => {
    // A row the export itself calls pending is never written as posted.
    if (status === 'export') return row.exportStatus!;
    if (status !== null) return status;
    return row.exportStatus === 'pending' || row.postedDate! > closedThrough! ? 'pending' : 'posted';
  };
  const kindOf = (row: ParsedRow): CardTransactionKind => {
    // The export's own kinds come first, untouched by any wording rule: Bilt's housing charges and the payments
    // its layout settles (biltCsv.ts).
    if (row.housingPayment === true) {
      if (loanPayments === 'not-spending' || row.amountMinor === 0) return 'other';
      return row.amountMinor > 0 ? 'purchase' : 'refund';
    }
    if (row.kind) return row.kind;
    return classifyCardKind({
      amountMinor: row.amountMinor,
      description: sanitizeCardText(row.description, 500) ?? '',
      issuerCategory: row.issuerCategory === null ? null : sanitizeCardText(row.issuerCategory, 100),
      typeHint: row.typeHint,
      // bilt-csv stores the Raw Merchant Name as the description and Bilt's own Description as the merchant: each is
      // read apart. Every other format classifies its description alone, as before.
      evidence: options.format === 'bilt-csv' && row.merchant !== null ? sanitizeCardText(row.merchant, 200) : null,
    });
  };

  const draftOf = (row: ParsedRow): CardImportDraftRow => ({
    transactionDate: row.transactionDate,
    postedDate: row.postedDate,
    status: statusOf(row),
    amountMinor: row.amountMinor,
    kind: kindOf(row),
    description: row.description,
    merchant: row.merchant,
    issuerCategory: row.issuerCategory,
    externalId: options.ignoreIds ? null : row.externalId,
  });

  const expected = options.expected ?? {};
  const figures: CardImportStatement = {
    chargesMinor: expectedFigure(expected.charges, 'charges', exponent, 'magnitude'),
    creditsMinor: expectedFigure(expected.credits, 'credits', exponent, 'negative'),
    netMinor: expectedFigure(expected.net, 'net', exponent, 'signed'),
    previousBalanceMinor: expectedFigure(expected.previousBalance, 'previous-balance', exponent, 'signed'),
    newBalanceMinor: expectedFigure(expected.newBalance, 'new-balance', exponent, 'signed'),
  };
  if (figures.newBalanceMinor !== null && figures.previousBalanceMinor === null) {
    throw new ConvertError('--expect-new-balance needs --expect-previous-balance');
  }
  const requestedCoverage = options.coverage ?? parsed.coverage;

  const build = (rows: readonly ParsedRow[], rejectedCount: number, statement: CardImportStatement | null) => {
    const ownerList = Object.keys(ownersOf(rows)) as CardOwner[];
    try {
      return buildCardImportPayload({
        source: parsed.source,
        parserVersion: CARD_IMPORT_TOOL_PARSER,
        issuer,
        currency: parsed.currency,
        owner: ownerList.length === 0 ? null : ownerList.length === 1 ? ownerList[0] : 'joint',
        cards: rows.flatMap((row) => (row.last4 ? [row.last4] : [])),
        coverage: requestedCoverage,
        rejectedCount,
        statement,
        rows: rows.map(draftOf),
      });
    } catch (error) {
      if (error instanceof CardImportError) {
        const lines = error.issues.map((issue) => {
          const match = /^\$\.rows\[(\d+)\]/.exec(issue.path);
          return { line: match ? rows[Number(match[1])].line : 0, reason: `${issue.path.replace(/^\$\.rows\[\d+\]\.?/, '') || 'row'} ${issue.message}` };
        });
        const count = new Set(lines.filter((line) => line.line > 0).map((line) => line.line)).size;
        throw new ConvertError(count > 0 ? `${count} row${count === 1 ? '' : 's'} cannot be imported` : error.message, lines);
      }
      throw error;
    }
  };
  // Rows whose stored text, field by field or put together, would show five digits of a card
  // number in the row's raw text (leaks.ts): refused, never repaired, whatever the parser did.
  const leaking = (rows: readonly ParsedRow[], payloadRows: CardImportPayload['rows']) => rows.filter((row, index) => {
    const stored = payloadRows[index];
    return showsCardDigits([stored.description, stored.merchant, stored.issuerCategory], row.sourceTexts);
  });
  let rejectedCount = options.skipInvalid ? problems.length : 0;
  let built = build(keptRows, rejectedCount, null);
  const leaked = leaking(keptRows, built.payload.rows);
  if (leaked.length > 0) {
    const refused = leaked.map((row) => ({ line: row.line, reason: CARD_DIGITS_SHOWN }));
    if (!options.skipInvalid) {
      throw new ConvertError(
        `${refused.length} row${refused.length === 1 ? '' : 's'} cannot be imported`,
        refused.slice(0, MAX_REPORTED_PROBLEMS),
      );
    }
    problems.push(...refused);
    problems.sort((a, b) => a.line - b.line);
    const dropped = new Set(leaked);
    keptRows = keptRows.filter((row) => !dropped.has(row));
    rejectedCount = problems.length;
    built = build(keptRows, rejectedCount, null);
    if (leaking(keptRows, built.payload.rows).length > 0) {
      throw new ConvertError('internal check failed: the output still shows card digits; nothing was written');
    }
  }

  // Both rejection passes are done: every decision that depends on the rows' statuses is made on
  // the rows that will be written, never on rows a later pass left out.
  if (closedThrough !== null) checkClosedThrough(closedThrough, keptRows, parsed);
  const evidence = periodEvidence(keptRows, parsed);
  const postedRows = built.payload.totals.posted.count;
  const pendingRows = built.payload.totals.pending.count;
  const figuresGiven = Object.values(figures).some((figure) => figure !== null);
  // Statement figures are checked against posted rows; an import whose rows are all pending has none to check.
  if (figuresGiven && (status === 'pending' || (pendingRows > 0 && postedRows === 0))) {
    throw new ConvertError(
      'the --expect-* figures are checked against the posted rows of a closed statement, and every row of this import is '
      + 'pending: leave them out, and check the figures when you import the statement after it closes',
    );
  }
  let ledgerUsedAsNewBalance = false;
  if (figuresGiven) {
    const statement: CardImportStatement = { ...figures };
    if (statement.previousBalanceMinor !== null && statement.newBalanceMinor === null) {
      // The ledger balance is the new balance only when it is as of the end of the covered dates,
      // and only when every row is posted: it also counts rows this import writes as pending.
      const ledgerAtEnd = parsed.ledger !== null && requestedCoverage !== null && parsed.ledger.asOf === requestedCoverage.end;
      if (ledgerAtEnd && pendingRows === 0) {
        statement.newBalanceMinor = parsed.ledger!.amountMinor;
        ledgerUsedAsNewBalance = true;
      } else {
        throw new ConvertError(!parsed.ledger
          ? '--expect-previous-balance needs --expect-new-balance'
          : ledgerAtEnd
            ? '--expect-previous-balance needs --expect-new-balance: the OFX ledger balance also counts the rows written as pending'
            : '--expect-previous-balance needs --expect-new-balance: the OFX ledger balance is not as of the end of the statement');
      }
    }
    // The same rows again, now with the statement figures: nothing else changes.
    built = build(keptRows, rejectedCount, statement);
  }
  const owners = ownersOf(keptRows);
  const { payload } = built;
  const json = serializeCardImportPayload(payload);
  // Fail closed: the text written to disk must hold no card data and no 13+ digit run anywhere.
  if (/\d{13,}/.test(json) || findCardImportSensitivePaths(JSON.parse(json)).length > 0) {
    throw new ConvertError('internal check failed: the output still contains card data; nothing was written');
  }

  const reconciliation = reconcileCardImport(payload.totals.posted, payload.statement);
  if (ledgerUsedAsNewBalance) {
    notes.push(`new balance taken from the OFX ledger balance as of ${parsed.ledger!.asOf}`);
    const balance = reconciliation.checks.find((check) => check.check === 'balance');
    if (balance && !balance.ok && balance.actualMinor === -balance.expectedMinor) {
      notes.push('the ledger balance matches with the opposite sign; pass --expect-new-balance from the statement');
    }
  }
  const cardsSeen: Record<string, number> = {};
  for (const row of keptRows) if (row.last4) cardsSeen[row.last4] = (cardsSeen[row.last4] ?? 0) + 1;
  const monthsOf = (wanted: CardImportRowStatus): MonthTotal[] => {
    const months = new Map<string, { count: number; netMinor: number }>();
    for (const row of payload.rows) {
      if (row.status !== wanted) continue;
      const month = (row.postedDate ?? row.transactionDate).slice(0, 7);
      const entry = months.get(month) ?? { count: 0, netMinor: 0 };
      entry.count += 1;
      entry.netMinor += row.amountMinor;
      months.set(month, entry);
    }
    return [...months.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([month, entry]) => ({ month, ...entry }));
  };
  if (built.repeatedExternalIdRows.length > 0) {
    notes.push(`${built.repeatedExternalIdRows.length} rows share a reference with another row and are matched by content instead`);
  }
  if (built.coverageWidened) notes.push('some rows fall outside the requested dates; coverage was widened to include them');
  let housing: HousingReport | null = null;
  if (options.format === 'bilt-csv') {
    housing = { choice: loanPayments, count: 0, posted: 0, pending: 0, chargesMinor: 0, creditsMinor: 0 };
    keptRows.forEach((row, index) => {
      if (row.housingPayment !== true) return;
      housing!.count += 1;
      housing![payload.rows[index].status] += 1;
      if (row.amountMinor > 0) housing!.chargesMinor += row.amountMinor;
      else housing!.creditsMinor += row.amountMinor;
    });
    housing.creditsMinor += 0;
  }
  return {
    payload,
    json,
    report: {
      format: options.format,
      encoding: decoded.encoding,
      currency: parsed.currency,
      exponent,
      rowsRead: parsed.rows.length + parsed.problems.length,
      excludedByCard,
      rejected: options.skipInvalid ? problems : [],
      droppedColumns: parsed.droppedColumns,
      memberColumn,
      owners,
      cards: cardsSeen,
      redactedRows: built.redactedRows.length,
      repeatedReferenceRows: built.repeatedExternalIdRows.length,
      coverageWidened: built.coverageWidened,
      ledger: parsed.ledger,
      ledgerUsedAsNewBalance,
      reconciliation,
      status: {
        basis: status === 'export' ? 'export' : status !== null ? 'status' : 'closed-through',
        status: status === 'export' ? null : status,
        closedThrough,
        posted: payload.totals.posted.count,
        pending: payload.totals.pending.count,
        period: evidence.period,
        madeAt: parsed.madeAt ? describeMoment(parsed.madeAt) : null,
        reaches: evidence.reaches,
      },
      housing,
      byMonth: monthsOf('posted'),
      pendingByMonth: monthsOf('pending'),
      warnings: status === 'posted' ? postedWarnings(evidence, parsed) : [],
      notes,
    },
  };
}
