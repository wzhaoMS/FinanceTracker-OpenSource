/** What each export parser hands to the converter. Raw text here never leaves the tool unredacted. */
import type { CardImportRowStatus } from '../cardImport.js';
import type { CardTransactionKind } from '../types.js';

/**
 * An OFX date and time as the issuer wrote it. Only the calendar date is
 * stored; the time and the offset serve to compare it with other dates of
 * the file in one time zone. Unless the value names an offset, its time zone
 * is unknown: OFX says GMT, but issuers often write local time.
 */
export interface StatementMoment {
  /** YYYY-MM-DD, as written. */
  date: string;
  /** Minutes after the written date's midnight; null for a date alone, or when its offset cannot be read. */
  time: number | null;
  /** The written offset from GMT, in minutes; null when the value names none or it cannot be read. */
  offset: number | null;
}

export interface ParsedRow {
  /** 1-based source line, for messages. */
  line: number;
  transactionDate: string;
  postedDate: string | null;
  /** The posted date with its time and offset as written (OFX DTPOSTED); null when the export has none. */
  postedAt: StatementMoment | null;
  /** Holdr sign: positive = money spent. */
  amountMinor: number;
  description: string;
  merchant: string | null;
  issuerCategory: string | null;
  /** Raw issuer reference from an allowlisted column; only its hash is written. */
  externalId: string | null;
  /** Last four digits of the card the row belongs to, when the export says. */
  last4: string | null;
  /** Raw card member name; mapped to an owner or dropped, never written. */
  member: string | null;
  /** Issuer transaction type (OFX TRNTYPE), used for classification. */
  typeHint: string | null;
  /**
   * The export marks the row as a housing payment (rent or a mortgage paid
   * through the card, as Bilt does). Whether it counts as spending is the
   * owner's to say (`loanPayments`); set only by formats that mark it.
   */
  housingPayment?: boolean;
  /** The kind the export's own layout states; when set, used instead of classifying by text. */
  kind?: CardTransactionKind | null;
  /**
   * The status the export's own layout gives the row (bilt-csv: posted, as
   * its posted date shows); used only when the owner asks for it
   * (`--status export`), and to refuse `--status posted` on rows an export
   * shows as pending.
   */
  exportStatus?: CardImportRowStatus | null;
  /**
   * Raw text the row was read from, never written: only checked so that no
   * stored field shows a card number from it (leaks.ts). OFX: NAME, MEMO,
   * both joined in either order, and ACCTID; Amex CSV: its text columns.
   * References are left out.
   */
  sourceTexts: Array<string | null>;
}

export interface RowProblem {
  line: number;
  /** Names the column or field, never the value. */
  reason: string;
}

export interface ParsedExport {
  source: string;
  /** Known for single-issuer formats (Amex CSV); OFX needs --issuer. */
  issuer: string | null;
  currency: string;
  /** Dates the issuer says the export covers (OFX DTSTART/DTEND). */
  coverage: { start: string; end: string } | null;
  /**
   * When the issuer made the file (OFX SONRS DTSERVER) and where its
   * transaction list ends (BANKTRANLIST DTEND), as written; null when the
   * export does not say. An Amex CSV states neither, so nothing in it shows
   * whether its statement period had closed.
   */
  madeAt: StatementMoment | null;
  listEndAt: StatementMoment | null;
  /** OFX LEDGERBAL in Holdr sign (owed is positive). */
  ledger: { amountMinor: number; asOf: string } | null;
  rows: ParsedRow[];
  problems: RowProblem[];
  /** Header names (or `column N`) of columns that were not allowlisted and were dropped. */
  droppedColumns: string[];
  /** Columns present, by role, for summaries. */
  hasMemberColumn: boolean;
  hasCardColumn: boolean;
  notes: string[];
}

/** A piece of text on a statement PDF's page, in PDF user space (y grows upwards), as pdf.js reads it. */
export interface StatementPdfTextItem {
  text: string;
  /** Left edge of the text. */
  x: number;
  /** Baseline. */
  y: number;
  width: number;
}

/** The positioned text of one page of a statement PDF. */
export interface StatementPdfPage {
  items: StatementPdfTextItem[];
}

export class ExportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportFormatError';
  }
}
