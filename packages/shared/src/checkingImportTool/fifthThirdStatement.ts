/**
 * Fifth Third checking statement PDF (online banking: Statements, the account's monthly statement), read from the
 * positioned text pdf.js gives the converter. Statements reach further back than the activity download (about 200
 * days), so they carry the account's older history.
 *
 * Read: the statement period (`Statement Period Date: M/D/YYYY - M/D/YYYY`), the account number (its last four
 * digits; the whole of it only feeds the leak checks) from `Account Number:` and `Account Summary - <number>`, the
 * account's kind from its `Account Type:` line (or a whole-line Fifth Third product title; a notice that mentions
 * checking and savings accounts is never read for it), the Account Summary (Beginning Balance, Checks, Withdrawals /
 * Debits, Deposits / Credits, Ending Balance; negatives as `$(1,234.56)`, and a bare `Checks` or `Deposits / Credits`
 * label in a month without that activity), the Checks, Withdrawals / Debits and Deposits / Credits sections (one row
 * per item: posting date, amount, description, in the column order the section's heading prints; a check's number)
 * and the Daily Balance Summary.
 * A description that wraps onto the next line is joined to its row when that line starts in the description column.
 *
 * The bank is known only from where the bank names itself: the header and footer bands of its pages (the top 92 and
 * the bottom 40 points of a US Letter page, fixed by the page's geometry, never inferred from where the body ends).
 * A row, a description wrapped under it or any other line of the body may name Fifth Third as a counterparty: none
 * of them counts, and a page without a body has no bands.
 *
 * The account number may be printed in several places, masked or whole: every printing must agree with the others
 * digit for digit, and what they prove together is kept (with every printing), so the converter masks the number
 * wherever any printing shows it.
 *
 * Every line that carries a date or an amount is read whole or refused, never skipped or cut back to a prefix: a
 * period, an account number, a summary line, a heading's count and total, a row, a daily balance. A date is a month
 * and day that can be one (`24/7` is not). Where the bank prints its notices, before the Account Summary heading and
 * in the Daily Balance Summary around its balances on a page that prints them (never in a page's header or footer
 * band), a whole-dollar term inside a sentence of prose (`UP TO $25.`, `$10K TO $250K`) is no amount: every figure of a
 * statement has cents. Page furniture (`Page n of m`, column headings, `continued`) is skipped only as a whole line
 * without a figure.
 *
 * Nothing is taken on trust; the file is refused, naming what failed and never a value, unless:
 * - each section's rows add up to the total and the count the Account Summary (or the section heading) prints;
 * - Beginning Balance + deposits - checks - withdrawals = Ending Balance;
 * - every Daily Balance Summary balance follows from the one before and that day's rows, so an unread row on any day
 *   refuses the statement instead of going missing.
 * Rows come oldest first. Within a day a statement lists deposits, checks and withdrawals apart, so the bank's
 * posting order is unknown: only the day's last row carries the day's ending balance, which holds in any order.
 */
import { isCardImportDate } from '../cardImport.js';
import { parseAmount } from '../cardImportTool/amount.js';
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
  type CheckingPdfPage,
  type CheckingPdfTextItem,
  type ParsedCheckingExport,
  type ParsedCheckingRow,
} from './parsed.js';
import { FIFTH_THIRD_INSTITUTION } from './fifthThirdCsv.js';

export const FIFTH_THIRD_STATEMENT_SOURCE = 'fifththird-statement';

/** Where a piece of a line's text came from: text offsets [start, end) set by one item at x, width wide. */
export interface StatementSpan {
  start: number;
  end: number;
  x: number;
  width: number;
}

/** One line of a page: items on the same baseline, left to right. */
export interface StatementLine {
  /** 1-based page number. */
  page: number;
  /** 1-based line number across the document, for messages. */
  number: number;
  y: number;
  items: CheckingPdfTextItem[];
  /** The items' text, whitespace collapsed, a space where they stand apart. */
  text: string;
  /** Each item's place in `text`, to tell where on the page a piece of text stands. */
  spans: StatementSpan[];
}

/** Items closer than this (in PDF points) to a line's baseline belong to it. */
const BASELINE_TOLERANCE = 2;
/** A gap wider than this between two items is a space. */
const WORD_GAP = 1;
/** A description (or its wrapped line) starts within this distance of its column's heading. */
const COLUMN_TOLERANCE = 4;
/** A right-aligned amount may start this far left of its column heading, or end this far right of it. */
const AMOUNT_SLACK = 40;

/** Groups each page's items into lines, top to bottom, and joins each line's items left to right. */
export function statementLines(pages: readonly CheckingPdfPage[]): StatementLine[] {
  const lines: StatementLine[] = [];
  pages.forEach((page, pageIndex) => {
    const items = page.items
      .filter((item) => typeof item.text === 'string' && item.text.trim() !== '' && [item.x, item.y, item.width].every(Number.isFinite))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const grouped: Array<{ y: number; items: CheckingPdfTextItem[] }> = [];
    for (const item of items) {
      const line = grouped.find((candidate) => Math.abs(candidate.y - item.y) <= BASELINE_TOLERANCE);
      if (line) line.items.push(item);
      else grouped.push({ y: item.y, items: [item] });
    }
    grouped.sort((a, b) => b.y - a.y);
    for (const line of grouped) {
      line.items.sort((a, b) => a.x - b.x);
      let text = '';
      let end: number | null = null;
      let spaceAfter = false;
      const spans: StatementSpan[] = [];
      for (const item of line.items) {
        const piece = item.text.replace(/\s+/g, ' ').trim();
        const apart = end !== null && item.x - end > WORD_GAP;
        if (text !== '' && (apart || spaceAfter || /^\s/.test(item.text))) text += ' ';
        spans.push({ start: text.length, end: text.length + piece.length, x: item.x, width: Math.max(0, item.width) });
        text += piece;
        end = item.x + Math.max(0, item.width);
        spaceAfter = /\s$/.test(item.text);
      }
      lines.push({ page: pageIndex + 1, number: lines.length + 1, y: line.y, items: line.items, text, spans });
    }
  });
  return lines;
}

/** The x on the page of the character at `offset` of a line's text (spread evenly over its item's width). */
function xAt(line: StatementLine, offset: number): number {
  const span = line.spans.find((candidate) => offset >= candidate.start && offset < candidate.end)
    ?? line.spans.find((candidate) => candidate.start >= offset)
    ?? line.spans[line.spans.length - 1];
  const length = Math.max(1, span.end - span.start);
  return span.x + (span.width * Math.max(0, Math.min(offset - span.start, length))) / length;
}

/** The x on the page where the text ending just before `offset` ends. */
function xEnd(line: StatementLine, offset: number): number {
  const span = line.spans.find((candidate) => offset > candidate.start && offset <= candidate.end)
    ?? line.spans[line.spans.length - 1];
  const length = Math.max(1, span.end - span.start);
  return span.x + (span.width * Math.max(0, Math.min(offset - span.start, length))) / length;
}

/** Where a Withdrawals / Debits or Deposits / Credits section prints its columns, from its own column heading line. */
interface Columns {
  amountFirst: boolean;
  /** The Amount heading's left and right edges. */
  amountFrom: number;
  amountTo: number;
  /** The Description heading's left edge, where every description (and its wrapped lines) starts. */
  descriptionX: number;
}

const COLUMN_HEADING = /^Date (?:Amount Description|Description Amount)$/i;

function columnsOf(line: StatementLine): Columns | null {
  if (!COLUMN_HEADING.test(line.text)) return null;
  const amount = line.text.search(/\bAmount\b/i);
  const description = line.text.search(/\bDescription\b/i);
  return {
    amountFirst: amount < description,
    amountFrom: xAt(line, amount),
    amountTo: xEnd(line, amount + 'Amount'.length),
    descriptionX: xAt(line, description),
  };
}

type Section = 'checks' | 'withdrawals' | 'deposits' | 'daily' | 'fees';

const NUMBER = String.raw`(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\.[0-9]{2}`;
/** An amount as statements print it: 1,234.56, $1,234.56, -1,234.56, 1,234.56-, and negatives as $(1,234.56) or ($1,234.56). */
const MONEY = String.raw`(?:-?\$?\s?-?${NUMBER}-?|\$?\(\$?${NUMBER}\))`;
/** Ends a token: an amount or date is read whole or not at all, never as the prefix of a longer one. */
const END = String.raw`(?=\s|$)`;
const MM_DD = String.raw`\d{1,2}\/\d{1,2}`;
/**
 * A month and day that can be a date (1-12 / 1-31): what makes a line dated. `24/7` in a notice is no date; a row's
 * own date is still read as MM_DD and must then be a day of the period.
 */
const CALENDAR_MM_DD = String.raw`(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12][0-9]|3[01])`;
const PERIOD = /Statement Period Date:?\s*(\d{1,2}\/\d{1,2}\/\d{4})(?=\s|-|–|$)\s*(?:-|–|to|through)\s*(\d{1,2}\/\d{1,2}\/\d{4})(?=\s|$)/i;
/**
 * The account number: everything after its label, wherever the label stands on its line, which must be one whole
 * number (masked digits allowed), or refused. A label mid-line is read too, so a second account number is never
 * passed over.
 */
const ACCOUNT_NUMBER = /(?:^|\s)Account Number\b:?\s*(.*)$/i;
/** The Account Summary's title names the account too (`Account Summary - <number>`), read the same way. */
const ACCOUNT_SUMMARY_TITLE = /(?:^|\s)Account Summary\s*-\s*(.*)$/i;
const SUMMARY: Readonly<Record<'opening' | 'checks' | 'withdrawals' | 'deposits' | 'closing', RegExp>> = {
  opening: new RegExp(String.raw`^(?:${MM_DD}\s+)?Beginning Balance\s+(${MONEY})(?:\s+Number of Days in Period\s+\d{1,3})?$`, 'i'),
  checks: new RegExp(String.raw`^(\d{1,5})\s+Checks?\s+(${MONEY})$`, 'i'),
  withdrawals: new RegExp(String.raw`^(\d{1,5})\s+Withdrawals\s*\/\s*Debits\s+(${MONEY})$`, 'i'),
  deposits: new RegExp(String.raw`^(\d{1,5})\s+Deposits\s*\/\s*Credits\s+(${MONEY})$`, 'i'),
  closing: new RegExp(String.raw`^(?:${MM_DD}\s+)?Ending Balance\s+(${MONEY})$`, 'i'),
};
const HEADINGS: ReadonlyArray<[Section, RegExp]> = [
  ['checks', /^Checks\b/i],
  ['withdrawals', /^Withdrawals\s*\/\s*Debits\b/i],
  ['deposits', /^Deposits\s*\/\s*Credits\b/i],
  ['daily', /^Daily Balance Summary\b/i],
  ['fees', /^Fee Summary\b/i],
];
/** A section heading line that prints its count and total, read whole: `<section>[ - continued] N items totaling $X`. */
const HEADING_TOTAL = new RegExp(
  String.raw`^(?:Checks|Withdrawals\s*\/\s*Debits|Deposits\s*\/\s*Credits)(?:\s*-\s*continued)?\s+(\d{1,5})\s+(?:items?|checks?)\s+total(?:l?ing)?\s+(${MONEY})$`,
  'i',
);
/** A section heading line with nothing else on it. */
const HEADING_ONLY = /^(?:Checks|Withdrawals\s*\/\s*Debits|Deposits\s*\/\s*Credits|Daily Balance Summary)(?:\s*-\s*continued)?$/i;
/** The signature of a section's printed count and total, wherever it stands: `N items totaling`. */
const SECTION_TOTAL = /(?<![\w.,/-])\d{1,5}\s+(?:items?|checks?)\s+total(?:l?ing)?\b/i;
const ITEM_AMOUNT_FIRST = new RegExp(String.raw`^(${MM_DD})\s+(${MONEY})\s+(\S.*)$`, 'd');
const ITEM_DESCRIPTION_FIRST = new RegExp(String.raw`^(${MM_DD})\s+(\S.*?)\s+(${MONEY})$`, 'd');
const CHECK_ENTRY = String.raw`\d{1,10}\s*(?:[*is]\s+)*${MM_DD}\s+${MONEY}`;
const CHECK = new RegExp(String.raw`(?:^|\s)(\d{1,10})\s*(?:[*is]\s+)*(${MM_DD})\s+(${MONEY})${END}`, 'g');
/** A Checks line is check entries and nothing else; a Daily Balance Summary line is dates and balances only. */
const CHECK_LINE = new RegExp(String.raw`^${CHECK_ENTRY}(?:\s+${CHECK_ENTRY})*$`);
const DAILY = new RegExp(String.raw`(?:^|\s)(${MM_DD})\s+(${MONEY})${END}`, 'g');
const DAILY_LINE = new RegExp(String.raw`^${MM_DD}\s+${MONEY}(?:\s+${MM_DD}\s+${MONEY})*$`);
/**
 * A Fee Summary row: a `Total …` fee label, then one whole amount per column (This Period, Year To Date, …). The fees
 * are rows of Withdrawals / Debits already; their summary is read whole and checked for shape, never counted twice.
 */
const FEE_ROW = new RegExp(String.raw`^Total(?:\s+[A-Za-z][A-Za-z'/&,.-]*){1,6}((?:\s+${MONEY}){1,4})$`, 'id');
const FEE_AMOUNT = new RegExp(String.raw`(?:^|\s)(${MONEY})(?=\s|$)`, 'gd');
/** A Fee Summary row starts with its Total label: such a line is a fee row, read whole whatever survives of it. */
const FEE_ROW_LABEL = /^Total\b/i;
/**
 * A line that carries a date or an amount, as a row would: never skipped, read whole or refused. An amount is found as
 * the statement census finds it, in the line with its spaces removed: cents (1.00), or a $ before a digit, with at
 * most a sign or an opening parenthesis between them, however the line splits them into words ($ 7, ( $ 7 ), $-7,
 * $ + 7, 7 .00).
 */
const DATE_TOKEN = new RegExp(String.raw`(?:^|\s)${CALENDAR_MM_DD}(?=\s|$)`);
/** A line's text with its spaces removed, so an amount split into words is still found whole. */
const compact = (text: string) => text.replace(/\s+/g, '');
const CENTS = /[0-9]\.[0-9]{2}/;
/** A `$` and a digit, with at most signs (minus, the minus sign, an en dash, plus) or an opening parenthesis between them. */
const DOLLAR = /\$[-\u2212\u2013+(]*[0-9]/;
const ROW_SHAPED = { test: (text: string): boolean => DATE_TOKEN.test(text) || CENTS.test(compact(text)) || DOLLAR.test(compact(text)) };
const STARTS_WITH_DATE = new RegExp(String.raw`^${CALENDAR_MM_DD}(?=\s|$)`);
/** An Account Summary line of the shape `<count> <label> …<amount>`: one of the three it knows, or refused. */
const COUNTED_LINE = /^\d{1,5}\s+[A-Za-z]/;
/**
 * A line that starts with a number, whatever it is (`3`, `100000`, `1,000`, `2.5`, `1e3`) and whatever stands before it
 * (`-2`, `- 2`, `( 2 )`, `#2`, `# 2`): after NFKC, its first letter or digit is a digit (Root 23:53Z, 00:10Z).
 */
const NUMBER_LEADING = { test: (text: string): boolean => /^[^A-Za-z0-9]*[0-9]/.test(text.normalize('NFKC')) };
/**
 * A whole-dollar amount as the bank's prose writes one, a word of its own: `$25`, `$1,500`, or with a scale `$10K`,
 * `$5M`, `$20B`, with at most one closing punctuation mark (`UP TO $25.`). It has no cents: Fifth Third prints every
 * figure of a statement with cents.
 */
const WHOLE_DOLLAR_WORD = /^\$(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)[KMB]?[.,;:!?]?$/i;
/** A word of prose: it holds a letter and no digit. */
const PROSE_WORD = /^[^0-9]*[A-Za-z][^0-9]*$/;
/** A sign or a parenthesis at the edge of a word, set against an amount beside it (`FEE- $25`, `$25 +MORE`). */
const SIGN_BEFORE = /[-\u2212\u2013+(]$/;
const SIGN_AFTER = /^[-\u2212\u2013+)]/;
/**
 * Where the bank prints its notices (`censusOf`): a line that states a figure of the statement. As `ROW_SHAPED`, except
 * that a whole-dollar amount standing inside a sentence of prose is a notice's term (`UP TO $25.`, `WITH $10K TO $250K IN
 * DEPOSITS`), not a figure: a word of prose on each side of it, neither one with a sign or a parenthesis against it, on a
 * line whose first letter or digit is not a digit (`NUMBER_LEADING`). Anything else is still one: cents however split into words, a `$`
 * set apart from its digits, any sign beside the `$` or its digits (`$-25`, `- $25`, `+$25`, `($-25)`), parentheses, a
 * decimal part or another suffix, a term at either end of a line, alone or beside a number, and every date.
 */
const STATES_FIGURE = {
  test: (text: string): boolean => {
    if (!ROW_SHAPED.test(text)) return false;
    if (DATE_TOKEN.test(text) || CENTS.test(compact(text)) || NUMBER_LEADING.test(text)) return true;
    const words = text.split(' ');
    const rest = words.filter((word, index) => {
      const before = words[index - 1] ?? '';
      const after = words[index + 1] ?? '';
      return !(WHOLE_DOLLAR_WORD.test(word) && PROSE_WORD.test(before) && !SIGN_BEFORE.test(before) && PROSE_WORD.test(after) && !SIGN_AFTER.test(after));
    });
    return DOLLAR.test(compact(rest.join(' ')));
  },
};
/** A known Account Summary label after a count: the line must then read whole as a count and one amount. */
const SUMMARY_LABEL = /^\d{1,5}\s+(?:Checks?|Withdrawals\s*\/\s*Debits|Deposits\s*\/\s*Credits)\b/i;
const LAST_FOUR = /^[0-9]{4}$/;
/** Where the statement states its account's kind: a line with an `Account Type` label (wherever it stands on the line). */
const ACCOUNT_TYPE_LABEL = /\bAccount Type\b/i;
/**
 * A Fifth Third product title, a whole line and nothing else (`Fifth Third Relationship Savings`): the bank naming an
 * account's kind. A line that only mentions kinds (a notice about "checking and savings accounts") is never read for it.
 */
const PRODUCT_TITLE = /^Fifth\s*Third\s+(?:[A-Za-z0-9®™'&.-]+\s+){0,3}(?:Checking|Savings|Money\s*Market)(?:\s+Account)?[®™]?$/i;
const ACCOUNT_KINDS: ReadonlyArray<[RegExp, 'CHECKING' | 'SAVINGS']> = [
  [/\bChecking\b/i, 'CHECKING'],
  [/\bSavings\b|\bMoney\s*Market\b/i, 'SAVINGS'],
];
/**
 * Account Summary labels Fifth Third prints with no count and no amount in a month without that activity. Each is
 * accepted only with no row of its kind read anywhere and never beside a count of its kind; any other bare line in the
 * Account Summary (a bare Withdrawals / Debits included) is one this reader does not know.
 */
const BARE_SUMMARY_LABELS: ReadonlyArray<['checks' | 'deposits', RegExp]> = [
  ['checks', /^Checks$/i],
  ['deposits', /^Deposits\s*\/\s*Credits$/i],
];

/**
 * The kinds of account the statement names before its first summary line or section: on its `Account Type` lines and
 * its whole-line Fifth Third product titles only, never in a notice's prose.
 */
function accountKinds(lines: readonly StatementLine[]): Set<'CHECKING' | 'SAVINGS'> {
  const kinds = new Set<'CHECKING' | 'SAVINGS'>();
  for (const line of lines) {
    if (Object.values(SUMMARY).some((pattern) => pattern.test(line.text)) || HEADINGS.some(([, pattern]) => pattern.test(line.text))) break;
    if (!ACCOUNT_TYPE_LABEL.test(line.text) && !PRODUCT_TITLE.test(line.text)) continue;
    for (const [pattern, kind] of ACCOUNT_KINDS) if (pattern.test(line.text)) kinds.add(kind);
  }
  return kinds;
}

/**
 * The account's kind as the statement names it: CHECKING or SAVINGS, so the converter can refuse anything but a
 * checking account. None, or both, is refused: an untitled statement proves nothing, and a statement naming both
 * kinds may be a combined one.
 */
function accountKind(lines: readonly StatementLine[]): 'CHECKING' | 'SAVINGS' {
  const kinds = accountKinds(lines);
  if (kinds.size === 0) fail('the statement does not say what kind of account it is (no Account Type before its Account Summary)');
  if (kinds.size > 1) fail('the statement names both a checking and a savings account; one account per statement is supported');
  return [...kinds][0];
}
/**
 * Lines that repeat on every page or explain the layout, each matched whole, never a row or part of one. A line that
 * carries a date or an amount is never noise, whatever else it says (`ROW_SHAPED`).
 */
const NOISE = [
  /^Page \d+ of \d+$/i,
  /^Date\s+(?:Amount\s+Description|Description\s+Amount)$/i,
  /^(?:Number\s+(?:Date Paid|Date)\s+Amount\s*)+$/i,
  /^(?:Date\s+(?:Balance|Amount)\s*)+$/i,
  /^\*\s*Indicates gap in check sequence(?:\s+[A-Za-z=\s]*)?$/i,
  /^\(?continued(?: on next page)?\)?$/i,
];
/** A line that is nothing but the page count. Counted as furniture by `--explain`; never issuer evidence by itself. */
const PAGE_COUNT = /\bPage \d+ of \d+$/i;

function isNoise(text: string): boolean {
  return !ROW_SHAPED.test(text) && NOISE.some((pattern) => pattern.test(text));
}

/** A line of the statement's structure: a summary line, the Account Summary title, a section heading or a column heading. */
function isLandmark(text: string): boolean {
  return Object.values(SUMMARY).some((pattern) => pattern.test(text)) || /^Account Summary\b/i.test(text) || ACCOUNT_SUMMARY_TITLE.test(text)
    || HEADINGS.some(([, pattern]) => pattern.test(text)) || COLUMN_HEADING.test(text);
}

/**
 * Fifth Third prints its statements on US Letter pages, 612 x 792 points, with y growing upwards from the bottom edge.
 * The header and footer bands are fixed on every page: the top 92 points and the bottom 40 points. A page with text
 * outside Letter bounds is no page these bands fit, and refuses the statement.
 */
const PAGE_RIGHT = 612;
const PAGE_TOP = 792;
const HEADER_BAND_FROM = PAGE_TOP - 92;
const FOOTER_BAND_TO = 40;

/** The first page (1-based) holding a text item whose origin is outside US Letter bounds, or null. */
function pageOutsideLetter(pages: readonly CheckingPdfPage[]): number | null {
  const inside = (item: CheckingPdfTextItem) => Number.isFinite(item.x) && Number.isFinite(item.y)
    && item.x >= 0 && item.x <= PAGE_RIGHT && item.y >= 0 && item.y <= PAGE_TOP;
  const index = pages.findIndex((page) => !page.items.every(inside));
  return index === -1 ? null : index + 1;
}

/**
 * The bank's own identity forms: its name heading a line (with its legal suffix at most), or its web address. A line
 * that reads as a transaction (it starts with a transaction's kind, or names a direction to or from someone) is a
 * mention, never the bank's own identity, whatever it names.
 */
const BANK_NAME_ITEM = /^Fifth\s*Third\s+Bank(?:,?\s+(?:N\.\s?A\.|NA|National Association))?(?:[.,]?\s+Member\s+FDIC)?\.?$/i;
const BANK_WEB_ADDRESS = /(?:^|[\s(])(?:https?:\/\/)?(?:www\.)?53\.com(?=$|[\s.,;:)/])/i;
const TRANSACTION_PHRASE = /^(?:TRANSFERS?|PAYMENTS?|PMT|PAID|DEPOSITS?|WITHDRAWALS?|ACH|XFER|PURCHASES?|DEBITS?|CREDITS?|ZELLE|WIRE|POS|ATM|EPAY|CHECKS?|BILL)\b|\b(?:TO|FROM)\b/i;

function ownBankIdentity(line: StatementLine): boolean {
  if (TRANSACTION_PHRASE.test(line.text)) return false;
  return BANK_NAME_ITEM.test(line.items[0].text.trim()) || line.items.some((item) => BANK_WEB_ADDRESS.test(item.text));
}

/**
 * Whether the statement names its own bank where only the bank speaks: in the header or footer band, fixed by the
 * page's geometry and the same on every page, never inferred from where the body ends, and in one of the bank's own
 * identity forms (`ownBankIdentity`), never a mention. Only a page with a body (a date or an amount, or a landmark)
 * has bands; and in a band, a line with a date or an amount, a landmark, or a line starting in a Description column
 * (where a row's wrapped description stands) is the body's, never identity. A row, a description wrapped under it, or
 * any line between them may name Fifth Third as a counterparty: none of them counts.
 */
function namesItsBank(lines: readonly StatementLine[]): boolean {
  const bodied = new Set(lines.filter((line) => ROW_SHAPED.test(line.text) || isLandmark(line.text)).map((line) => line.page));
  const descriptionColumns = lines.flatMap((line) => {
    const columns = columnsOf(line);
    return columns ? [columns.descriptionX] : [];
  });
  return lines.some((line) => bodied.has(line.page)
    && inBands(line)
    && !ROW_SHAPED.test(line.text) && !isLandmark(line.text)
    && !descriptionColumns.some((x) => Math.abs(line.spans[0].x - x) <= COLUMN_TOLERANCE)
    && ownBankIdentity(line));
}

function money(raw: string): number | null {
  const text = raw.replace(/\s+/g, '');
  const parenthesized = new RegExp(String.raw`^\$?\(\$?(${NUMBER})\)$`).exec(text);
  if (parenthesized) {
    const read = parseAmount(parenthesized[1], 2, { thousands: true });
    return read.ok ? -read.minor : null;
  }
  const trailingMinus = text.endsWith('-');
  const read = parseAmount(trailingMinus ? `-${text.slice(0, -1)}` : text, 2, { thousands: true, symbols: true });
  return read.ok ? read.minor : null;
}

function isoDate(raw: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!match) return null;
  const date = `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  return isCardImportDate(date) ? date : null;
}

/** A statement's MM/DD as a date inside its period (which may span a new year). */
function periodDate(raw: string, period: { start: string; end: string }): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})$/.exec(raw);
  if (!match) return null;
  const monthDay = `${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  for (const year of new Set([period.start.slice(0, 4), period.end.slice(0, 4)])) {
    const date = `${year}-${monthDay}`;
    if (isCardImportDate(date) && date >= period.start && date <= period.end) return date;
  }
  return null;
}

interface Item {
  line: number;
  section: 'checks' | 'withdrawals' | 'deposits';
  date: string;
  /** Positive as printed; the section gives the sign. */
  magnitude: number;
  description: string;
  checkNumber: string | null;
  sourceTexts: string[];
}

interface Totals {
  count: number | null;
  magnitude: number | null;
}

const SECTION_NAMES: Readonly<Record<Section, string>> = {
  checks: 'Checks',
  withdrawals: 'Withdrawals / Debits',
  deposits: 'Deposits / Credits',
  daily: 'Daily Balance Summary',
  fees: 'Fee Summary',
};

/** A value column the Fee Summary's heading declares (This Period, Year To Date, …): its heading's left and right edges. */
interface FeeColumn {
  from: number;
  to: number;
}

/** Pieces of one column heading stand at most a word space apart; columns stand much further apart. */
const FEE_HEADING_GAP = 4.5;

/**
 * The value columns the Fee Summary's heading line declares: the heading's own pieces after `Fee Summary`, left to
 * right, pieces a word space apart or closer joined as one column heading (`2026 Year To Date`).
 */
function feeColumnsOf(line: StatementLine): FeeColumn[] {
  const labelEnd = /^Fee Summary\b/i.exec(line.text)?.[0].length ?? 0;
  const columns: FeeColumn[] = [];
  for (const span of line.spans) {
    const start = Math.max(span.start, labelEnd);
    const piece = line.text.slice(start, span.end);
    if (piece.trim() === '') continue;
    const from = xAt(line, start + (piece.length - piece.trimStart().length));
    const to = span.x + span.width;
    const previous = columns[columns.length - 1];
    if (previous && from - previous.to <= FEE_HEADING_GAP) previous.to = Math.max(previous.to, to);
    else columns.push({ from, to });
  }
  return columns;
}

/**
 * A Fee Summary row read whole: its `Total …` label, then whole amounts, each standing under exactly one column the
 * heading declares (overlapping that column heading's extent), and every declared column holding exactly one. Column
 * completeness comes from the heading, never from another row. 'unreadable' when the line is not a Total label and
 * whole amounts (a cell missing or unreadable), 'misplaced' when its amounts do not fill the declared columns one each.
 */
function feeRowAmounts(line: StatementLine, columns: readonly FeeColumn[]): number[] | 'unreadable' | 'misplaced' {
  const match = FEE_ROW.exec(line.text);
  const group = match?.indices?.[1];
  if (!match || !group) return 'unreadable';
  const filled = columns.map(() => 0);
  const amounts: number[] = [];
  for (const found of match[1].matchAll(FEE_AMOUNT)) {
    const amount = money(found[1]);
    const at = found.indices?.[1];
    if (amount === null || !at) return 'unreadable';
    const from = xAt(line, group[0] + at[0]);
    const to = xEnd(line, group[0] + at[1]);
    const under = columns.flatMap((column, index) => (from < column.to && to > column.from ? [index] : []));
    if (under.length !== 1) return 'misplaced';
    filled[under[0]] += 1;
    amounts.push(amount);
  }
  return columns.length > 0 && filled.every((count) => count === 1) ? amounts : 'misplaced';
}

/** Whether a line stands in a page's fixed header or footer band (US Letter), where the page's own furniture is. */
function inBands(line: StatementLine): boolean {
  return (line.y >= HEADER_BAND_FROM && line.y <= PAGE_TOP) || (line.y >= 0 && line.y <= FOOTER_BAND_TO);
}

/**
 * Whether a line stands where the bank prints its notices (Root 23:41Z, 23:46Z): before the Account Summary (before the
 * statement's first landmark, its Account Summary heading), or in the Daily Balance Summary around its balances (on a
 * page that prints its heading or one of its balance lines); never in a page's header or footer band, nor anywhere
 * else (after the Ending Balance, between or in the other sections, on a later page). Only there is a notice's
 * whole-dollar term no figure (`STATES_FIGURE`); everywhere else the census is `ROW_SHAPED`.
 */
function censusOf(line: StatementLine, section: Section | null, beforeAccountSummary: boolean, dailyPages: ReadonlySet<number>): {
  test: (text: string) => boolean;
} {
  const notices = !inBands(line) && ((section === 'daily' && dailyPages.has(line.page)) || (section === null && beforeAccountSummary));
  return notices ? STATES_FIGURE : ROW_SHAPED;
}

/** The pages that print the Daily Balance Summary's heading or one of its balance lines. */
function dailyPagesOf(lines: readonly StatementLine[]): Set<number> {
  return new Set(lines.filter((line) => /^Daily Balance Summary\b/i.test(line.text) || DAILY_LINE.test(line.text)).map((line) => line.page));
}

/**
 * How the Fee Summary reads one of its lines. Every `Total …` line is a row the statement declares: read whole
 * (`feeRowAmounts`), never skipped, whatever survives of its cells. Any other line is passed over only when it carries
 * no date or amount and is a label wrapped onto its own line in the label column (left of every declared column), or
 * the page's own furniture in its header or footer band; anything else is a line the Fee Summary would not read.
 */
function feeLine(line: StatementLine, columns: readonly FeeColumn[]): 'row' | 'misplaced' | 'unreadable' | 'passed' {
  if (FEE_ROW_LABEL.test(line.text)) {
    const read = feeRowAmounts(line, columns);
    return Array.isArray(read) ? 'row' : read;
  }
  if (ROW_SHAPED.test(line.text)) return 'unreadable';
  const labelColumnEnd = Math.min(...columns.map((column) => column.from));
  return inBands(line) || line.spans.every((span) => span.x + span.width <= labelColumnEnd) ? 'passed' : 'unreadable';
}

function fail(message: string): never {
  throw new CheckingExportFormatError(message);
}

interface ReadRow {
  date: string;
  amount: string;
  description: string;
}

/**
 * A row of a Withdrawals / Debits or Deposits / Credits section, read in the column order its heading line prints
 * and checked against where those columns stand: the description must start in the Description column and the
 * amount must stand in the Amount column. 'unreadable' when the line has neither shape; 'misplaced' when it has
 * the shape but not the places, which a reader must never guess around.
 */
function readRow(line: StatementLine, columns: Columns): ReadRow | 'unreadable' | 'misplaced' {
  const match = (columns.amountFirst ? ITEM_AMOUNT_FIRST : ITEM_DESCRIPTION_FIRST).exec(line.text);
  if (!match?.indices) return 'unreadable';
  const [amountGroup, descriptionGroup] = columns.amountFirst ? [2, 3] : [3, 2];
  const [amountStart, amountEnd] = match.indices[amountGroup];
  const [descriptionStart] = match.indices[descriptionGroup];
  const amountFrom = xAt(line, amountStart);
  const amountTo = xEnd(line, amountEnd);
  if (Math.abs(xAt(line, descriptionStart) - columns.descriptionX) > COLUMN_TOLERANCE
    || amountTo < columns.amountFrom - AMOUNT_SLACK || amountFrom > columns.amountTo + AMOUNT_SLACK) return 'misplaced';
  return { date: match[1], amount: match[amountGroup], description: match[descriptionGroup] };
}

/** Every printing of the account number: those read whole, and those that are not one whole number. */
function accountPrintings(lines: readonly StatementLine[]): { printed: string[]; unread: string[] } {
  const printed: string[] = [];
  const unread: string[] = [];
  for (const line of lines) {
    const match = ACCOUNT_NUMBER.exec(line.text) ?? ACCOUNT_SUMMARY_TITLE.exec(line.text);
    if (!match) continue;
    // Read whole or refused: a number with anything stuck to it is never cut back to a prefix that looks like one.
    const token = match[1].trim();
    (fifthThirdAccountTokenProblem(token) === null ? printed : unread).push(token);
  }
  return { printed, unread };
}

/** Parses the positioned text of one Fifth Third checking statement. */
export function parseFifthThirdStatement(pages: readonly CheckingPdfPage[], options: CheckingAdapterOptions = {}): ParsedCheckingExport {
  // Checked before anything is read or repeated: a mistyped whole account number is never echoed.
  if (options.accountLast4 !== undefined && !LAST_FOUR.test(options.accountLast4)) fail('--account must be the last four digits of the account number');
  const lines = statementLines(pages);
  if (lines.length === 0) fail('the PDF has no text (a scanned statement cannot be read)');
  // Identity first: every printing of the account number and what they prove together, before anything that can refuse
  // (the page bounds included), so every refusal carries them for the converter to keep out of all it prints.
  const { printed, unread } = accountPrintings(lines);
  const identity = fifthThirdAccountIdentity(printed);
  const known = fifthThirdKnownAccountNumbers(identity, [...printed, ...unread]);
  // A printing that is not one whole number leaves the identity step unfinished (Root 04:04Z): the refusal is a fixed
  // label, carries every printing for the guard, and is identity-unknown, so the run prints fixed labels (Root 04:08Z).
  if (unread.length > 0) {
    throw new CheckingExportFormatError('an account number the statement prints is not one whole number showing its last four digits', known);
  }
  return withAccountNumbers(known, () => {
    // The header and footer bands are fixed for US Letter pages: a page with text outside them is not one this reader knows.
    const outside = pageOutsideLetter(pages);
    if (outside !== null) fail(`page ${outside} holds text outside a US Letter page, so its header and footer bands are unknown; refusing the statement`);
    return readStatement(lines, identity, known, options);
  });
}

function readStatement(lines: readonly StatementLine[], identity: FifthThirdAccountIdentity, known: readonly string[],
  options: CheckingAdapterOptions): ParsedCheckingExport {
  if (!namesItsBank(lines)) {
    fail("this does not look like a Fifth Third statement: no page's header or footer band names Fifth Third Bank or 53.com");
  }

  const periods = new Set<string>();
  let period: { start: string; end: string } | null = null;
  for (const line of lines) {
    const match = PERIOD.exec(line.text);
    if (!match) {
      if (/Statement Period Date/i.test(line.text)) fail(`line ${line.number}: the statement period is not two MM/DD/YYYY dates`);
      continue;
    }
    const start = isoDate(match[1]);
    const end = isoDate(match[2]);
    if (!start || !end || start > end) fail(`line ${line.number}: the statement period is not a valid date range`);
    periods.add(`${start}..${end}`);
    period ??= { start, end };
  }
  if (!period) fail('this does not look like a Fifth Third statement: it states no "Statement Period Date"');
  if (periods.size > 1) fail(`this PDF holds ${periods.size} statement periods; download each statement on its own`);

  // Printings must agree digit for digit (read before anything else); what they prove together is kept, with every printing.
  if (identity.kind === 'several') fail(`this statement covers ${identity.count} accounts; one account per statement is supported`);
  const [accountLast4, accountNumberRaw] = identity.kind === 'one' ? [identity.last4, identity.raw] : [null, null];
  // Every printing is known to the converter's guard as well, never written.
  const otherAccountNumbersRaw = known.filter((token) => token !== accountNumberRaw);
  if (options.accountLast4 !== undefined && accountLast4 !== null && accountLast4 !== options.accountLast4) {
    fail(`this statement is for account ${accountLast4}, not the one --account names`);
  }
  const accountType = accountKind(lines);

  const summary: Partial<Record<'opening' | 'closing', number>> = {};
  const summaryTotals: Partial<Record<'checks' | 'withdrawals' | 'deposits', Totals>> = {};
  const headingTotals: Partial<Record<'checks' | 'withdrawals' | 'deposits', Totals>> = {};
  /** A figure the statement prints twice must be printed the same both times; neither one wins. */
  const keepTotals = (store: typeof summaryTotals, key: 'checks' | 'withdrawals' | 'deposits', totals: Totals, where: string) => {
    const known = store[key];
    if (known && (known.count !== totals.count || known.magnitude !== totals.magnitude)) {
      fail(`the ${where} states two different counts or totals for ${SECTION_NAMES[key]}`);
    }
    store[key] = totals;
  };
  const items: Item[] = [];
  const daily = new Map<string, { balance: number; line: number }>();
  let section: Section | null = null;
  /** Where the current section's columns stand, from its own column heading line (each page prints one). */
  let columns: Columns | null = null;
  let last: Item | null = null;
  /** Between the Beginning and the Ending Balance: the Account Summary, where every line must be one it knows. */
  let inSummary = false;
  /** Account Summary labels printed with no count and no amount (`BARE_SUMMARY_LABELS`): none of that kind this period. */
  const blank = new Set<'checks' | 'withdrawals' | 'deposits'>();
  /** The value columns the current Fee Summary's heading declares: every Total row fills each with one amount. */
  let feeColumns: FeeColumn[] = [];
  /** Until the statement's first landmark (its Account Summary heading): where a notice before it may stand. */
  let beforeAccountSummary = true;
  /** The pages that print the Daily Balance Summary's heading or balances: where a notice around them may stand. */
  const dailyPages = dailyPagesOf(lines);

  for (const line of lines) {
    const text = line.text;
    if (beforeAccountSummary && isLandmark(text)) beforeAccountSummary = false;
    let summaryMatched = false;
    for (const key of ['opening', 'closing'] as const) {
      const match = SUMMARY[key].exec(text);
      if (!match) continue;
      const value = money(match[1]);
      if (value === null) fail(`line ${line.number}: the ${key === 'opening' ? 'Beginning' : 'Ending'} Balance is not an amount`);
      if (summary[key] !== undefined && summary[key] !== value) fail(`the statement states two different ${key === 'opening' ? 'Beginning' : 'Ending'} Balances`);
      summary[key] = value;
      summaryMatched = true;
      inSummary = key === 'opening';
    }
    for (const key of ['checks', 'withdrawals', 'deposits'] as const) {
      const match = SUMMARY[key].exec(text);
      if (!match) continue;
      const value = money(match[2]);
      if (value === null) fail(`line ${line.number}: the Account Summary's ${SECTION_NAMES[key]} total is not an amount`);
      keepTotals(summaryTotals, key, { count: Number(match[1]), magnitude: Math.abs(value) }, 'Account Summary');
      summaryMatched = true;
    }
    if (summaryMatched) {
      section = null;
      last = null;
      continue;
    }
    if (/^(?:\d{1,2}\/\d{1,2}\s+)?(?:Beginning|Ending) Balance\b/i.test(text)) {
      fail(`line ${line.number}: the Account Summary's ${/Beginning/i.test(text) ? 'Beginning' : 'Ending'} Balance is not one whole amount`);
    }
    if (SUMMARY_LABEL.test(text)) {
      fail(`line ${line.number}: an Account Summary line is not a count and one whole amount`);
    }
    if (inSummary) {
      const bare = BARE_SUMMARY_LABELS.find(([, pattern]) => pattern.test(text));
      if (bare) {
        blank.add(bare[0]);
        continue;
      }
      fail(`line ${line.number}: an Account Summary line this reader does not know; run --explain and report the layout`);
    }

    const heading = HEADINGS.find(([, pattern]) => pattern.test(text));
    if (heading) {
      section = heading[0];
      columns = null;
      last = null;
      if (section === 'fees') feeColumns = feeColumnsOf(line);
      // A heading is read whole: its name alone, or its name with the section's count and total. Anything else that
      // carries a figure is refused, never skipped with the heading.
      if (!HEADING_ONLY.test(text) && (SECTION_TOTAL.test(text) || ROW_SHAPED.test(text))) {
        if (section === 'daily' || section === 'fees') fail(`line ${line.number}: the ${SECTION_NAMES[section]} heading carries a date or an amount`);
        const total = HEADING_TOTAL.exec(text);
        const value = total ? money(total[2]) : null;
        if (!total || value === null) fail(`line ${line.number}: the ${SECTION_NAMES[section]} heading's count and total are not a number and one whole amount`);
        keepTotals(headingTotals, section, { count: Number(total[1]), magnitude: Math.abs(value) }, 'section heading');
      }
      continue;
    }
    if (SECTION_TOTAL.test(text)) {
      fail(`line ${line.number}: a section this reader does not know prints a total; run --explain and report the layout`);
    }
    if (section === null) {
      // Outside the sections it knows, a dated line can only be a row of a section it does not know, a counted line with
      // an amount is activity the Account Summary counts that it does not know, and any other figure is one the
      // statement states that this reader would not read: each refuses the statement, never passed over. Only in a
      // notice before the Account Summary is a whole-dollar term inside a sentence no figure (`censusOf`).
      if (STARTS_WITH_DATE.test(text)) fail(`line ${line.number}: a dated line outside the sections this reader knows; run --explain and report the layout`);
      if (COUNTED_LINE.test(text) && ROW_SHAPED.test(text)) {
        fail(`line ${line.number}: the Account Summary counts activity this reader does not know; run --explain and report the layout`);
      }
      if (censusOf(line, section, beforeAccountSummary, dailyPages).test(text)) {
        fail(`line ${line.number}: states a date or an amount outside the statement's summary, sections and Fee Summary; run --explain and report the layout`);
      }
      continue;
    }
    if (section === 'withdrawals' || section === 'deposits') {
      const printed = columnsOf(line);
      if (printed) {
        columns = printed;
        last = null;
        continue;
      }
    }
    if (isNoise(text)) continue;
    // A page's repeated header (period, account number) is never part of a row, unless it carries a date or amount.
    if ((PERIOD.test(text) || ACCOUNT_NUMBER.test(text) || ACCOUNT_SUMMARY_TITLE.test(text)) && !ROW_SHAPED.test(text)) {
      last = null;
      continue;
    }

    if (section === 'fees') {
      // Every Total row is read whole, one amount under each column the heading declares; anything else that is not
      // a label wrapped in the label column or the page's own band furniture refuses (`feeLine`).
      last = null;
      const read = feeLine(line, feeColumns);
      if (read === 'unreadable') {
        fail(FEE_ROW_LABEL.test(text)
          ? `line ${line.number}: a Fee Summary row is not its Total label and a whole amount in each column its heading declares`
          : `line ${line.number}: a Fee Summary line is neither a Total row nor a label wrapped in its label column; run --explain and report the layout`);
      }
      if (read === 'misplaced') fail(`line ${line.number}: a Fee Summary row does not hold exactly one amount under each column its heading declares`);
      continue;
    }

    if (section === 'daily') {
      if (!DAILY_LINE.test(text)) {
        // Around its balances the bank may print a notice: a figure there refuses, a notice's whole-dollar term does not
        // (outside the page's header and footer bands, `censusOf`).
        if (censusOf(line, section, beforeAccountSummary, dailyPages).test(text)) fail(`line ${line.number}: a Daily Balance Summary line holds something other than dates and balances`);
        continue;
      }
      for (const match of text.matchAll(DAILY)) {
        const date = periodDate(match[1], period);
        const balance = money(match[2]);
        if (!date || balance === null) fail(`line ${line.number}: a Daily Balance Summary entry is not a date in the period and an amount`);
        const known = daily.get(date);
        if (known && known.balance !== balance) fail(`line ${line.number}: the Daily Balance Summary states two balances for one day`);
        daily.set(date, { balance, line: line.number });
      }
      continue;
    }

    if (section === 'checks') {
      last = null;
      if (!CHECK_LINE.test(text)) {
        if (ROW_SHAPED.test(text)) fail(`line ${line.number}: a Checks line holds something other than check numbers, dates and amounts`);
        continue;
      }
      for (const match of text.matchAll(CHECK)) {
        const date = periodDate(match[2], period);
        const amount = money(match[3]);
        if (!date || amount === null) fail(`line ${line.number}: a check is not dated in the statement period or its amount is not an amount`);
        items.push({
          line: line.number, section, date, magnitude: Math.abs(amount), description: `CHECK ${match[1]}`,
          checkNumber: match[1].replace(/^0+(?=\d)/, ''), sourceTexts: [text],
        });
      }
      continue;
    }

    const read = columns ? readRow(line, columns) : 'unreadable';
    if (read === 'misplaced') {
      fail(`line ${line.number}: a ${SECTION_NAMES[section]} row's amount or description is not in the column its heading prints`);
    }
    if (read !== 'unreadable') {
      const date = periodDate(read.date, period);
      const amount = money(read.amount);
      if (!date) fail(`line ${line.number}: a ${SECTION_NAMES[section]} row is not dated in the statement period`);
      if (amount === null) fail(`line ${line.number}: a ${SECTION_NAMES[section]} row's amount is not an amount`);
      last = { line: line.number, section, date, magnitude: Math.abs(amount), description: read.description, checkNumber: null, sourceTexts: [text] };
      items.push(last);
      continue;
    }
    // A wrapped description: a line that starts in the Description column, under a row.
    if (last && columns && Math.abs(line.spans[0].x - columns.descriptionX) <= COLUMN_TOLERANCE) {
      last.description = `${last.description} ${text}`;
      last.sourceTexts.push(text, last.description);
      continue;
    }
    if (STARTS_WITH_DATE.test(text)) {
      fail(columns
        ? `line ${line.number}: a ${SECTION_NAMES[section]} row could not be read (date, amount, description)`
        : `line ${line.number}: a ${SECTION_NAMES[section]} row comes before its Date, Amount and Description heading, so its columns are unknown`);
    }
    if (ROW_SHAPED.test(text)) fail(`line ${line.number}: a ${SECTION_NAMES[section]} line holds an amount or date but is not a row`);
    // Anything else (a page's furniture, a note) is no row; the section goes on after it, as it does across a page.
    last = null;
  }

  if (inSummary) fail('the statement\'s Account Summary has a Beginning Balance but no Ending Balance');
  for (const key of blank) {
    const totals = summaryTotals[key];
    if (totals && totals.count !== 0) fail(`the Account Summary prints its ${SECTION_NAMES[key]} line both blank and with a count`);
  }

  if (summary.opening === undefined || summary.closing === undefined) {
    fail('the statement\'s Account Summary has no Beginning Balance or no Ending Balance');
  }
  const opening = summary.opening;
  const closing = summary.closing;

  const sums = { checks: 0, withdrawals: 0, deposits: 0 };
  const counts = { checks: 0, withdrawals: 0, deposits: 0 };
  for (const item of items) {
    sums[item.section] += item.magnitude;
    counts[item.section] += 1;
  }
  for (const key of ['checks', 'withdrawals', 'deposits'] as const) {
    for (const [where, totals] of [['Account Summary', summaryTotals[key]], ['section heading', headingTotals[key]]] as const) {
      if (!totals) continue;
      if (totals.count !== null && totals.count !== counts[key]) {
        fail(`the ${where} counts ${totals.count} ${SECTION_NAMES[key]} but ${counts[key]} rows were read`);
      }
      if (totals.magnitude !== null && totals.magnitude !== sums[key]) {
        fail(`the ${SECTION_NAMES[key]} rows read do not add up to the ${where}'s total; a row was not read`);
      }
    }
    // Silence is not proof of no activity: a statement must print each section's count and total, zero included. The
    // one exception is an Account Summary label printed with no count and no amount (Checks, or Deposits / Credits),
    // as Fifth Third does in a month without that activity: it is accepted only with no row of its kind read anywhere,
    // and the Beginning + deposits - withdrawals = Ending check below then proves the month had none.
    const blankLabel = blank.has(key) && counts[key] === 0;
    if (!summaryTotals[key] && !headingTotals[key] && !blankLabel) {
      fail(`the statement prints no count and total for ${SECTION_NAMES[key]}, so its activity cannot be proven complete`);
    }
    if (blank.has(key) && counts[key] > 0) {
      fail(`the Account Summary prints its ${SECTION_NAMES[key]} label with no count and no amount, but ${SECTION_NAMES[key]} rows were read`);
    }
  }
  if (opening + sums.deposits - sums.checks - sums.withdrawals !== closing) {
    fail('Beginning Balance + deposits - checks - withdrawals is not the Ending Balance; a row was not read');
  }

  // Oldest first: deposits, then checks, then withdrawals within a day (a statement does not say the posting order).
  const rank = { deposits: 0, checks: 1, withdrawals: 2 };
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.date < b.item.date ? -1 : a.item.date > b.item.date ? 1 : rank[a.item.section] - rank[b.item.section] || a.index - b.index))
    .map(({ item }) => item);

  // Every Daily Balance Summary balance must follow from the previous one and the rows between.
  const netByDay = new Map<string, number>();
  for (const item of ordered) netByDay.set(item.date, (netByDay.get(item.date) ?? 0) + (item.section === 'deposits' ? item.magnitude : -item.magnitude));
  const dates = [...new Set([...netByDay.keys(), ...daily.keys()])].sort();
  let balance = opening;
  for (const date of dates) {
    balance += netByDay.get(date) ?? 0;
    const stated = daily.get(date);
    if (stated && stated.balance !== balance) {
      fail(`line ${stated.line}: the Daily Balance Summary does not follow from the rows of that day and the days before; a row was not read`);
    }
  }
  if (daily.size === 0 && ordered.length > 0) fail('the statement has no Daily Balance Summary to check its rows against');

  const rows: ParsedCheckingRow[] = ordered.map((item, index) => {
    const lastOfDay = ordered[index + 1]?.date !== item.date;
    return {
      line: item.line,
      postedDate: item.date,
      transactionDate: null,
      amountMinor: item.section === 'deposits' ? item.magnitude : -item.magnitude,
      description: item.description,
      checkNumber: item.checkNumber,
      typeHint: item.section === 'checks' ? 'CHECK' : item.section === 'deposits' ? 'CREDIT' : 'DEBIT',
      externalId: null,
      runningBalanceMinor: lastOfDay ? daily.get(item.date)?.balance ?? null : null,
      pending: false,
      sourceTexts: [...item.sourceTexts, accountNumberRaw],
    };
  });

  return {
    institution: FIFTH_THIRD_INSTITUTION,
    source: FIFTH_THIRD_STATEMENT_SOURCE,
    currency: 'USD',
    accountLast4,
    accountType,
    accountNumberRaw,
    ...(otherAccountNumbersRaw.length > 0 ? { otherAccountNumbersRaw } : {}),
    madeAt: null,
    coverage: period,
    statement: {
      openingBalanceMinor: opening,
      closingBalanceMinor: closing,
      depositsMinor: sums.deposits,
      withdrawalsMinor: sums.checks + sums.withdrawals,
    },
    ledgerBalance: null,
    availableBalance: null,
    rows,
    problems: [],
    droppedColumns: [],
    notes: [],
  };
}

function looksLikeFifthThirdStatement(pages: readonly CheckingPdfPage[]): boolean {
  const lines = statementLines(pages.slice(0, 2));
  return namesItsBank(lines) && lines.some((line) => /Statement Period Date/i.test(line.text));
}

/** Words of the statement's own layout, kept in a line's shape; every other word is `<w>`. */
const LAYOUT_WORDS = new Set([
  'account', 'amount', 'balance', 'beginning', 'checks', 'check', 'continued', 'credits', 'daily', 'date', 'debits', 'deposits',
  'description', 'ending', 'fifth', 'items', 'item', 'number', 'of', 'page', 'paid', 'period', 'statement', 'summary', 'third',
  'totaling', 'total', 'withdrawals', 'type', 'days', 'in', 'on', 'next', 'indicates', 'gap', 'sequence', 'electronic', 'image',
  'substitute', 'bank', 'fee', 'fees', 'this', 'year', 'to', 'checking', 'savings', '/', '-', '*', ':',
]);

/** A line as token kinds (`<date>`, `<mm/dd>`, `<amount>`, `<int>`, `<w>`), keeping only layout words: no value of the statement. */
function lineShape(text: string): string {
  return text.split(' ').map((token) => {
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(token)) return '<date>';
    if (new RegExp(`^${CALENDAR_MM_DD}$`).test(token)) return '<mm/dd>';
    if (/^\d{1,2}\/\d{1,2}$/.test(token)) return '<int>/<int>';
    if (new RegExp(`^${MONEY}$`).test(token)) return '<amount>';
    if (WHOLE_DOLLAR_WORD.test(token)) return '<$whole>';
    if (/^\d+$/.test(token)) return '<int>';
    const word = token.replace(/:$/, '').toLowerCase();
    return LAYOUT_WORDS.has(word) ? token : '<w>';
  }).join(' ').slice(0, 160);
}

/**
 * What the reader found in a statement's layout, for an owner to share when a statement is refused: page and line
 * counts, which landmarks were found, the Account Summary lines it knows and the shapes of those it does not, and
 * per section how many lines read as rows, wrapped descriptions or page furniture, how many without a figure were
 * passed over (`skipped`) and how many with one could not be read (`unread`: these refuse the statement), with the
 * shapes of both. Token kinds and the statement's own layout words only; no value.
 */
export function describeFifthThirdStatementLayout(pages: readonly CheckingPdfPage[]): Record<string, unknown> {
  const lines = statementLines(pages);
  type Counts = {
    headings: number; withTotal: number; columnOrder: string | null; rows: number; misplaced: number; wrapped: number; noise: number;
    skipped: number; unread: number;
  };
  const sections: Record<string, Counts> = {};
  const unreadShapes = new Map<string, number>();
  const skippedShapes = new Map<string, number>();
  const summaryFound = new Set<string>();
  const summaryUnknown: string[] = [];
  let section: Section | null = null;
  let columns: Columns | null = null;
  let feeColumns: FeeColumn[] = [];
  let underRow = false;
  let inSummary = false;
  let beforeAccountSummary = true;
  const dailyPages = dailyPagesOf(lines);
  for (const line of lines) {
    const text = line.text;
    if (beforeAccountSummary && isLandmark(text)) beforeAccountSummary = false;
    const summaryKey = (Object.keys(SUMMARY) as Array<keyof typeof SUMMARY>).find((key) => SUMMARY[key].test(text));
    if (summaryKey) {
      summaryFound.add(summaryKey);
      if (summaryKey === 'opening') inSummary = true;
      if (summaryKey === 'closing') inSummary = false;
      section = null;
      continue;
    }
    if (inSummary) {
      const bare = BARE_SUMMARY_LABELS.find(([, pattern]) => pattern.test(text));
      if (bare) summaryFound.add(`${bare[0]} (blank)`);
      else summaryUnknown.push(lineShape(text));
      continue;
    }
    const heading = HEADINGS.find(([, pattern]) => pattern.test(text));
    if (heading) {
      section = heading[0];
      columns = null;
      underRow = false;
      if (section === 'fees') feeColumns = feeColumnsOf(line);
      const entry = (sections[SECTION_NAMES[section]] ??= {
        headings: 0, withTotal: 0, columnOrder: null, rows: 0, misplaced: 0, wrapped: 0, noise: 0, skipped: 0, unread: 0,
      });
      entry.headings += 1;
      if (HEADING_TOTAL.test(text)) entry.withTotal += 1;
      continue;
    }
    if (section === null) {
      // A figure outside the summary, the sections and the Fee Summary refuses the statement (`censusOf`, as the parse).
      if (censusOf(line, section, beforeAccountSummary, dailyPages).test(text)) {
        const shape = `Outside the sections: ${lineShape(text)}`;
        unreadShapes.set(shape, (unreadShapes.get(shape) ?? 0) + 1);
      }
      continue;
    }
    const entry = sections[SECTION_NAMES[section]];
    const printed = section === 'withdrawals' || section === 'deposits' ? columnsOf(line) : null;
    if (printed) {
      columns = printed;
      entry.columnOrder = printed.amountFirst ? 'Date Amount Description' : 'Date Description Amount';
      underRow = false;
      continue;
    }
    // In the parse's order: furniture and repeated page headers first, then rows and wrapped descriptions, and only
    // then a page-count line is counted as furniture (a wrapped description that ends like one is still a description).
    if (isNoise(text) || (!ROW_SHAPED.test(text) && (PERIOD.test(text) || ACCOUNT_NUMBER.test(text) || ACCOUNT_SUMMARY_TITLE.test(text)))) {
      entry.noise += 1;
      if (!isNoise(text)) underRow = false;
      continue;
    }
    if (section === 'fees') {
      // As the parse reads it (`feeLine`): a Total row read whole, one whose amounts miss their columns, a line passed
      // over, or one that refuses the statement.
      const fee = feeLine(line, feeColumns);
      if (fee === 'row') entry.rows += 1;
      else if (fee === 'misplaced') entry.misplaced += 1;
      else if (fee === 'passed' && PAGE_COUNT.test(text)) entry.noise += 1;
      else {
        const shape = `${SECTION_NAMES[section]}: ${lineShape(text)}`;
        const [count, shapes] = fee === 'unreadable' ? ['unread', unreadShapes] as const : ['skipped', skippedShapes] as const;
        entry[count] += 1;
        shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
      }
      continue;
    }
    const read = section === 'daily' ? (DAILY_LINE.test(text) ? 'row' : 'unreadable')
      : section === 'checks' ? (CHECK_LINE.test(text) ? 'row' : 'unreadable')
        : columns ? readRow(line, columns) : 'unreadable';
    if (read === 'misplaced') {
      entry.misplaced += 1;
      underRow = false;
      continue;
    }
    if (read !== 'unreadable') {
      entry.rows += 1;
      underRow = section === 'withdrawals' || section === 'deposits';
      continue;
    }
    if (underRow && columns && Math.abs(line.spans[0].x - columns.descriptionX) <= COLUMN_TOLERANCE) {
      entry.wrapped += 1;
      continue;
    }
    underRow = false;
    if (!ROW_SHAPED.test(text) && PAGE_COUNT.test(text)) {
      entry.noise += 1;
      continue;
    }
    // A line with a date or an amount that is not read is what refuses a statement; one without is passed over (in the
    // Daily Balance Summary, as the parse reads it, a notice's whole-dollar term is no figure: `censusOf`).
    const shape = `${SECTION_NAMES[section]}: ${lineShape(text)}`;
    const figure = (section === 'daily' ? censusOf(line, section, beforeAccountSummary, dailyPages) : ROW_SHAPED).test(text);
    const [count, shapes] = figure ? ['unread', unreadShapes] as const : ['skipped', skippedShapes] as const;
    entry[count] += 1;
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  return {
    pages: pages.length,
    lines: lines.length,
    namesItsBank: namesItsBank(lines),
    pageOutsideLetter: pageOutsideLetter(pages),
    periodFound: lines.some((line) => PERIOD.test(line.text)),
    accountNumberFound: lines.some((line) => ACCOUNT_NUMBER.test(line.text)),
    accountKinds: [...accountKinds(lines)],
    summaryFound: [...summaryFound],
    summaryUnknown: summaryUnknown.slice(0, 10),
    sections,
    unreadShapes: [...unreadShapes.entries()].slice(0, 30).map(([shape, count]) => ({ shape, count })),
    skippedShapes: [...skippedShapes.entries()].slice(0, 10).map(([shape, count]) => ({ shape, count })),
  };
}

export const fifthThirdStatementAdapter: CheckingExportAdapter = Object.freeze({
  source: FIFTH_THIRD_STATEMENT_SOURCE,
  institution: FIFTH_THIRD_INSTITUTION,
  input: 'pdf',
  description: 'Fifth Third checking statement PDF (one statement per file)',
  detect: (input: CheckingExportInput) => input.kind === 'pdf' && looksLikeFifthThirdStatement(input.pages),
  parse: (input: CheckingExportInput, options: CheckingAdapterOptions) => {
    if (input.kind !== 'pdf') throw new CheckingExportFormatError('a statement is a PDF, not text');
    return parseFifthThirdStatement(input.pages, options);
  },
  describe: (input: CheckingExportInput) => (input.kind === 'pdf' ? describeFifthThirdStatementLayout(input.pages) : { pdf: false }),
});
