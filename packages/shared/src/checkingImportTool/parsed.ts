/**
 * What a checking export format adapter returns: one bank export file, parsed but not yet redacted. Adapters are pure
 * (no file system, clock or network) and bank-specific; the generic core (convert.ts) does everything else: it
 * redacts and leak-checks every text, hashes references, decides the complete days, checks every balance the file
 * states and writes the `holdr.checking-import` payload.
 *
 * Raw values (descriptions, the account number, bank references) live only in these objects, in the converter's
 * memory on the owner's computer. Nothing here is ever written or printed: problems and notes name lines and fields,
 * never values.
 */

/** A piece of text on a PDF page, in PDF user space (y grows upwards), as pdf.js reads it. */
export interface CheckingPdfTextItem {
  text: string;
  /** Left edge of the text. */
  x: number;
  /** Baseline. */
  y: number;
  width: number;
}

export interface CheckingPdfPage {
  items: CheckingPdfTextItem[];
}

/** Decoded text (CSV, OFX/QFX/QBO), or the positioned text of a PDF's pages. */
export type CheckingExportInput =
  | { kind: 'text'; text: string }
  | { kind: 'pdf'; pages: CheckingPdfPage[] };

export interface ParsedCheckingRow {
  /** 1-based line (text) or row number (PDF) for messages. */
  line: number;
  /** YYYY-MM-DD, the bank's posting date. */
  postedDate: string;
  /** YYYY-MM-DD when the format states another date for the transaction; recorded, never keyed on. */
  transactionDate: string | null;
  /** Integer minor units in the bank's sign: positive = money in, negative = money out. */
  amountMinor: number;
  /** Raw description; the core redacts it. */
  description: string;
  checkNumber: string | null;
  /** The bank's own type (OFX TRNTYPE, a CSV type column); a hint only. */
  typeHint: string | null;
  /** Raw bank reference (OFX FITID); the core hashes it. */
  externalId: string | null;
  /** The balance right after this row, when the format prints one (a running or ending daily balance). */
  runningBalanceMinor: number | null;
  /** A row the bank has not posted yet; the core never imports one. */
  pending: boolean;
  /** Every raw text of the row (fields and the joins the adapter made), for the core's leak checks. */
  sourceTexts: ReadonlyArray<string | null>;
}

/** The figures a statement prints about its own period. */
export interface ParsedCheckingStatement {
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  /** Sum of money in, as printed; null when the statement does not print it. */
  depositsMinor: number | null;
  /** Sum of money out, as a positive number, as printed; null when not printed. */
  withdrawalsMinor: number | null;
}

export interface ParsedCheckingBalance {
  amountMinor: number;
  /** YYYY-MM-DD the balance is stated for. */
  asOf: string;
}

export interface CheckingRowProblem {
  line: number;
  /** Names the field and what is wrong with it, never the value. */
  reason: string;
}

export interface ParsedCheckingExport {
  /** The bank, when the format can only come from one (a bank's own CSV or statement); null for OFX. */
  institution: string | null;
  /** The adapter's slug, written as the segment's source. */
  source: string;
  currency: string;
  accountLast4: string | null;
  /** As the file states it (OFX ACCTTYPE), upper case; null when it does not. */
  accountType: string | null;
  /** Raw account number, for the leak checks only; never written. */
  accountNumberRaw: string | null;
  /**
   * Raw numbers of every other account the file names (another statement's account block, a transfer's other
   * account), for redaction and leak checks only.
   */
  otherAccountNumbersRaw?: string[];
  /** YYYY-MM-DD the bank made the file, when the file says; activity on that day may be incomplete. */
  madeAt: string | null;
  /** The whole days the file says it lists (statement period, OFX DTSTART..DTEND); null when it does not say. */
  coverage: { start: string; end: string } | null;
  statement: ParsedCheckingStatement | null;
  ledgerBalance: ParsedCheckingBalance | null;
  /** Recorded only: an available balance counts holds, so it never anchors anything. */
  availableBalance: ParsedCheckingBalance | null;
  /** Oldest first; within a day, in the bank's posting order. */
  rows: ParsedCheckingRow[];
  problems: CheckingRowProblem[];
  /** Names of columns the format has but Holdr never reads. */
  droppedColumns: string[];
  notes: string[];
}

export interface CheckingAdapterOptions {
  /** Picks the account by its last four digits when a file holds several. */
  accountLast4?: string;
}

/** A bank export format: pure functions from decoded input to a parsed export. */
export interface CheckingExportAdapter {
  /** Slug written as the segment's source, and the converter's --format value. */
  source: string;
  /** The only bank this format comes from, or null for formats any bank writes (OFX). */
  institution: string | null;
  input: CheckingExportInput['kind'];
  /** One line for the converter's help. */
  description: string;
  /** Cheap check that the input looks like this format; used to pick a format when none is given. */
  detect(input: CheckingExportInput): boolean;
  parse(input: CheckingExportInput, options: CheckingAdapterOptions): ParsedCheckingExport;
  /**
   * What the reader finds in the input's layout, for `--explain` when a file is refused: counts, landmarks found and
   * positions only, never text or values of the file.
   */
  describe?(input: CheckingExportInput): Record<string, unknown>;
}

/** A file the adapter cannot read at all. The message names what is wrong, never a value of the file. */
export class CheckingExportFormatError extends Error {
  /**
   * Account numbers the adapter had read before it refused, so that the converter keeps their digits out of all it
   * prints (this message, and other files' messages and reports). Never printed, and not enumerable, so that
   * serializing the error never shows them either.
   */
  declare readonly accountNumbersRaw: readonly string[];
  /**
   * True when the adapter refused after reading every account number the file names (withAccountNumbers). A refusal
   * without it (Root 04:08Z) leaves the file's identity unknown, so every diagnostic of the run is printed with fixed
   * labels and no digit taken from any file.
   */
  readonly identityKnown: boolean;
  constructor(message: string, accountNumbersRaw: ReadonlyArray<string | null> = [], identityKnown = false) {
    super(message);
    this.name = 'CheckingExportFormatError';
    this.identityKnown = identityKnown;
    Object.defineProperty(this, 'accountNumbersRaw', {
      value: Object.freeze(accountNumbersRaw.filter((value): value is string => typeof value === 'string' && value !== '')),
      enumerable: false,
    });
  }
}

/**
 * An adapter's reading once it has read every account number the file names: any refusal inside carries them and is
 * marked identity-known. An adapter reads the file's account numbers first, then everything else inside this.
 */
export function withAccountNumbers<T>(accountNumbersRaw: ReadonlyArray<string | null>, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof CheckingExportFormatError) {
      throw new CheckingExportFormatError(error.message, [...error.accountNumbersRaw, ...accountNumbersRaw], true);
    }
    throw error;
  }
}
