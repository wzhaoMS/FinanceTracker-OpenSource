/**
 * Wells Fargo checking statements (the monthly PDF e-statement), read from the positioned text pdf.js gives for each
 * page. Only what the statement prints is used:
 * - the statement period: Wells Fargo prints none. Its date is page 1's dated line (`October 7, 2026 Page 1 of 6`),
 *   and the period runs from the summary's `Beginning balance on M/D` to its `Ending balance on M/D`, which is that
 *   date (Root R1, 14:12Z). A statement that prints its period (`Month D, YYYY - Month D, YYYY`) is read by it, and
 *   both, when printed, must agree. The account number: its last four are kept; the whole number only feeds the leak
 *   checks;
 * - the activity summary: `Beginning balance on M/D`, `Deposits/Additions`, `Withdrawals/Subtractions`,
 *   `Ending balance on M/D`, each from its own column, left of the account box beside it (R3);
 * - the `Transaction history` table: Date | Check Number | Description | Deposits/Additions | Withdrawals/Subtractions |
 *   Ending daily balance, its rows continuing over pages and over several lines each;
 * - after the table's Totals, two lists: `Summary of checks written`, whose every check must be a check row of the
 *   table, and `Items returned unpaid`, which is not activity and is only counted (R5).
 *
 * Which column an amount sits in decides its sign, so columns come from the header's positions on each page, and
 * nothing is guessed: a statement is converted only when its opening balance plus its rows is its closing balance,
 * its deposit and withdrawal totals are the rows' totals, and every ending daily balance follows from the rows before
 * it (the core checks all three). Every amount is read whole by one grammar (at most one sign, parentheses paired):
 * a summary amount only from its label's own line, and every token among the table's amounts is one, or its row
 * refuses. The account kind comes only from a title line in the statement's header. Errors say what was not found
 * where, never what the statement says.
 */
import { isCardImportDate } from '../cardImport.js';
import { parseAmount } from '../cardImportTool/amount.js';
import {
  CheckingExportFormatError,
  withAccountNumbers,
  type CheckingAdapterOptions,
  type CheckingExportAdapter,
  type CheckingExportInput,
  type CheckingPdfPage,
  type ParsedCheckingExport,
  type ParsedCheckingRow,
} from './parsed.js';

interface Token {
  text: string;
  x: number;
  right: number;
}

interface Line {
  page: number;
  y: number;
  tokens: Token[];
  text: string;
}

interface Columns {
  date: number;
  check: { from: number; to: number } | null;
  description: number;
  deposits: number;
  withdrawals: number;
  balance: number;
  /** Amounts are read only right of this x (the description column ends here). */
  amountsFrom: number;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const PERIOD = /\b([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4}) ?[-\u2013\u2014] ?([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4})\b/;
/** Page 1's dated line, as Wells Fargo prints it above every page: `October 7, 2026 Page 1 of 6`. */
const DATED = /^([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4}) Page \d{1,3} of \d{1,3}$/;
/** The summary's two dated labels, each starting its line: the period's first and last day. */
const BEGINNING_ON = /^Beginning balance on (\d{1,2})\/(\d{1,2})(?![0-9/])/i;
const ENDING_ON = /^Ending balance on (\d{1,2})\/(\d{1,2})(?![0-9/])/i;
/** Digits with optional thousands commas, then two decimals. */
const NUMBER = '(?:[0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)\\.[0-9]{2}';
/**
 * The one grammar of an amount, matched against a whole field and anchored at both ends: `1,234.56` or `$1,234.56`,
 * or negative with exactly one sign: `-$1,234.56` (`- 1,234.56`, as statements print a total), `$1,234.56-` or
 * `($1,234.56)`. Anything else before, inside or after it (a `+`, a second sign, a parenthesis without its pair, a
 * sign set apart after the digits, any other text) is no amount: nothing is ever read from part of a field.
 */
const MONEY_FORMS: ReadonlyArray<readonly [RegExp, 1 | -1]> = [
  [new RegExp(`^(?:\\$ ?)?(${NUMBER})$`), 1],
  [new RegExp(`^[-\\u2212] ?(?:\\$ ?)?(${NUMBER})$`), -1],
  [new RegExp(`^(?:\\$ ?)?(${NUMBER})-$`), -1],
  [new RegExp(`^\\( ?(?:\\$ ?)?(${NUMBER}) ?\\)$`), -1],
];
const ROW_DATE = /^(\d{1,2})\/(\d{1,2})$/;
const LINE_TOLERANCE = 2.5;
/** A continuation line of a row sits at most this far below the line before it. */
const CONTINUATION_GAP = 16;

function tokensOf(page: CheckingPdfPage): Array<Token & { y: number }> {
  const tokens: Array<Token & { y: number }> = [];
  for (const item of page.items) {
    const text = item.text.replace(/\s+/g, ' ');
    if (!text.trim() || !Number.isFinite(item.x) || !Number.isFinite(item.y) || !Number.isFinite(item.width)) continue;
    // An item can hold several words; each gets its share of the item's width, by characters.
    const perChar = text.length > 0 ? item.width / text.length : 0;
    for (const match of text.matchAll(/\S+/g)) {
      const x = item.x + perChar * (match.index ?? 0);
      tokens.push({ text: match[0], x, right: x + perChar * match[0].length, y: item.y });
    }
  }
  return tokens;
}

function linesOf(pages: readonly CheckingPdfPage[]): Line[] {
  const lines: Line[] = [];
  pages.forEach((page, index) => {
    const sorted = tokensOf(page).sort((a, b) => b.y - a.y || a.x - b.x);
    const pageLines: Array<{ y: number; tokens: Token[] }> = [];
    for (const token of sorted) {
      const line = pageLines.find((candidate) => Math.abs(candidate.y - token.y) <= LINE_TOLERANCE);
      if (line) line.tokens.push(token);
      else pageLines.push({ y: token.y, tokens: [token] });
    }
    for (const line of pageLines.sort((a, b) => b.y - a.y)) {
      line.tokens.sort((a, b) => a.x - b.x);
      lines.push({ page: index + 1, y: line.y, tokens: line.tokens, text: line.tokens.map((token) => token.text).join(' ') });
    }
  });
  return lines;
}

/** A line of only some of a line's tokens (a column of it), its text theirs. */
const lineOf = (line: Line, tokens: Token[]): Line => ({ ...line, tokens, text: tokens.map((token) => token.text).join(' ') });

/** An amount by the grammar, in cents with its sign, from a whole field; null when the field is anything else. */
function money(field: string): number | null {
  for (const [form, sign] of MONEY_FORMS) {
    const match = form.exec(field);
    if (!match) continue;
    const parsed = parseAmount(match[1], 2, { thousands: true });
    return parsed.ok ? (parsed.minor === 0 ? 0 : sign * parsed.minor) : null;
  }
  return null;
}

/**
 * The amount a summary line states: the whole rest of the line after its label, which must start the line, read by
 * the grammar anchored at both ends (Root rule 3, 02:47Z): never a part of it, never from another line. Null when no
 * line states the label; a label on two lines, one that does not start its line, or a field that is not exactly one
 * amount refuses. The line it reads is added to `read`, for the census of amounts.
 */
function summaryAmount(lines: readonly Line[], label: RegExp, name: string, read: Set<number>): number | null {
  const stated = lines.flatMap((line, index) => {
    const match = label.exec(line.text);
    return match ? [{ index, field: match.index === 0 ? line.text.slice(match[0].length).trim() : null }] : [];
  });
  if (stated.length === 0) return null;
  if (stated.length > 1) throw new CheckingExportFormatError(`the activity summary states ${name} on more than one line; refusing to guess which one counts`);
  const [{ index, field }] = stated;
  const value = field === null ? null : money(field);
  if (value === null) throw new CheckingExportFormatError(`the activity summary's ${name} is there but its amount cannot be read; refusing rather than guess`);
  read.add(index);
  return value;
}

/**
 * A line that states an amount, read or not: its text with spaces removed holds cents (`1.00`) or a `$` before a digit
 * (`$7`), however the amount is split into words (`$ 7`, `($ 7)`, `7 .00`).
 */
const statesAmount = (line: Line) => {
  const compact = line.text.replace(/\s+/g, '');
  return /[0-9]\.[0-9]{2}(?![0-9])/.test(compact) || /\$[-\u2212+(]*[0-9]/.test(compact);
};

/** The amounts a table line states in the money columns, by column, each read whole by the grammar; null if any cannot be. */
function columnAmounts(line: Line, columns: Columns): Record<'deposits' | 'withdrawals' | 'balance', number[]> | null {
  const found: Record<'deposits' | 'withdrawals' | 'balance', number[]> = { deposits: [], withdrawals: [], balance: [] };
  for (const token of line.tokens) {
    if (token.x < columns.amountsFrom) continue;
    const value = money(token.text);
    if (value === null) return null;
    found[columnOf(token, columns)].push(value);
  }
  return found;
}

function monthNumber(name: string): number | null {
  const lower = name.toLowerCase();
  const index = MONTHS.findIndex((month) => month === lower || (lower.length >= 3 && month.startsWith(lower)));
  return index === -1 ? null : index + 1;
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isCardImportDate(date) ? date : null;
}

/**
 * The statement period (Root R1, 14:12Z). A statement that prints its period (`Month D, YYYY - Month D, YYYY`) is read
 * by it. Wells Fargo's own statements print none: their date is page 1's dated line (`October 7, 2026 Page 1 of 6`),
 * and their period runs from the summary's `Beginning balance on M/D` to its `Ending balance on M/D`, which must be
 * that date; the first day is in the statement's year, or the year before when its month comes after the last day's
 * (a January statement begins in December). When both are printed they must agree. The fee period a statement prints
 * in its fee summary is never read.
 */
function statementPeriod(lines: readonly Line[]): { start: string; end: string } {
  const printed = printedPeriod(lines);
  const dated = datedPeriod(lines);
  if (printed && dated && (printed.start !== dated.start || printed.end !== dated.end)) {
    throw new CheckingExportFormatError('the statement\'s printed period and its summary\'s dates disagree; refusing to guess which is right');
  }
  const period = printed ?? dated;
  if (!period) {
    throw new CheckingExportFormatError('no statement period was found: neither a period (Month D, YYYY - Month D, YYYY) nor a statement date on page 1 (Month D, YYYY Page N of M)');
  }
  return period;
}

function printedPeriod(lines: readonly Line[]): { start: string; end: string } | null {
  for (const line of lines.slice(0, 200)) {
    const match = PERIOD.exec(line.text);
    if (!match) continue;
    const startMonth = monthNumber(match[1]);
    const endMonth = monthNumber(match[4]);
    const start = startMonth ? isoDate(Number(match[3]), startMonth, Number(match[2])) : null;
    const end = endMonth ? isoDate(Number(match[6]), endMonth, Number(match[5])) : null;
    if (start && end && start <= end) return { start, end };
  }
  return null;
}

/** The period from page 1's statement date and the summary's dates (R1), or null when page 1 states no date. */
function datedPeriod(lines: readonly Line[]): { start: string; end: string } | null {
  const dated = lines.filter((line) => line.page === 1 && DATED.test(line.text));
  if (dated.length === 0) return null;
  if (dated.length > 1) throw new CheckingExportFormatError('page 1 states more than one statement date; refusing to guess which one is the statement\'s');
  const match = DATED.exec(dated[0].text)!;
  const month = monthNumber(match[1]);
  const year = Number(match[3]);
  const date = month ? isoDate(year, month, Number(match[2])) : null;
  if (!date) throw new CheckingExportFormatError('the statement date on page 1 is not a date');
  const { summary } = summaryColumn(lines, lines.findIndex((line) => /^Transaction history\b/i.test(line.text)));
  const day = (label: RegExp) => {
    const stated = summary.flatMap((line) => {
      const found = label.exec(line.text);
      return found ? [[Number(found[1]), Number(found[2])] as const] : [];
    });
    return stated.length === 1 ? stated[0] : null;
  };
  const beginning = day(BEGINNING_ON);
  const ending = day(ENDING_ON);
  if (!beginning || !ending) {
    throw new CheckingExportFormatError('the activity summary does not state its Beginning and Ending balance dates (on M/D) once each; refusing to guess the statement period');
  }
  if (isoDate(year, ending[0], ending[1]) !== date) {
    throw new CheckingExportFormatError('the activity summary\'s Ending balance date is not the statement date; refusing to guess the statement period');
  }
  const start = isoDate(beginning[0] > ending[0] ? year - 1 : year, beginning[0], beginning[1]);
  if (!start || start > date) {
    throw new CheckingExportFormatError('the activity summary\'s Beginning balance date does not begin the statement period; refusing to guess it');
  }
  return { start, end: date };
}

/**
 * The activity summary's lines (everything before Transaction history), each only what lies in the summary's own
 * column (Root R3, 14:12Z): on a page whose account box (the `Account number` label and what is printed under it: the
 * owner's name, the account terms, the routing numbers) stands right of the summary's dated labels, a line is cut at
 * the box's left edge, that label's x, because the box's text can share a summary line's height (statements of early
 * 2024 print them so). `beside` holds, by line, what lies at or right of that edge: the box's part of the line.
 */
function summaryColumn(lines: readonly Line[], historyAt: number): { summary: Line[]; beside: Array<Line | null> } {
  const before = lines.slice(0, historyAt === -1 ? lines.length : historyAt);
  const edges = new Map<number, number>();
  for (const line of before) {
    const label = line.tokens.findIndex((token, index) => /^Account$/i.test(token.text) && /^number:?$/i.test(line.tokens[index + 1]?.text ?? ''));
    if (label === -1) continue;
    const x = line.tokens[label].x;
    // A box only when the summary's labels on its page stand left of it.
    if (!before.some((other) => other.page === line.page && (BEGINNING_ON.test(other.text) || ENDING_ON.test(other.text)) && other.tokens[0].x < x)) continue;
    edges.set(line.page, Math.min(edges.get(line.page) ?? Infinity, x));
  }
  const part = (line: Line, keep: (token: Token) => boolean): Line => lineOf(line, line.tokens.filter(keep));
  return {
    summary: before.map((line) => (edges.has(line.page) ? part(line, (token) => token.x < edges.get(line.page)!) : line)),
    beside: before.map((line) => (edges.has(line.page) ? part(line, (token) => token.x >= edges.get(line.page)!) : null)),
  };
}

/** M/D of a row, in the statement's period: the year is the one that puts it inside the period. */
function rowDate(text: string, period: { start: string; end: string }): string | null {
  const match = ROW_DATE.exec(text);
  if (!match) return null;
  const [month, day] = [Number(match[1]), Number(match[2])];
  for (const year of [Number(period.end.slice(0, 4)), Number(period.start.slice(0, 4))]) {
    const date = isoDate(year, month, day);
    if (date && date >= period.start && date <= period.end) return date;
  }
  return null;
}

function accountNumber(lines: readonly Line[]): string | null {
  for (const line of lines.slice(0, 200)) {
    const match = /Account number:? ?([0-9][0-9 -]{3,20}[0-9])/i.exec(line.text);
    if (match) return match[1].replace(/[^0-9]/g, '');
  }
  return null;
}

/**
 * A product title: one to four capitalized words, then the account kind (`Everyday Checking`, `Wells Fargo Everyday
 * Checking`, `Way2Save® Savings`). A lone kind word ("Checking") never is one.
 */
const TITLE = /^(?:[A-Z][A-Za-z0-9®™'&.-]*\s+){1,4}(?:Checking|Savings|Money Market|Certificate of Deposit)(?:\s+Account)?[®™]?$/;

/**
 * The kind of account the statement is for, from its title: a whole line of the statement's header (page 1, above the
 * line that states the statement's date or its period, R2) that is a product title and nothing else. Body text is
 * never read for it. A combined statement, no title, or titles of different kinds refuse; the kind never defaults to
 * checking.
 */
function accountKind(lines: readonly Line[], historyAt: number): 'CHECKING' | 'SAVINGS' {
  const pageOne = lines.slice(0, historyAt === -1 ? lines.length : historyAt).filter((line) => line.page === 1);
  if (pageOne.some((line) => /\bCombined statement\b/i.test(line.text))) {
    throw new CheckingExportFormatError('this is a combined statement of several accounts; download the checking account\'s own statement');
  }
  const periodAt = pageOne.findIndex((line) => PERIOD.test(line.text) || DATED.test(line.text));
  const header = periodAt === -1 ? [] : pageOne.slice(0, periodAt);
  const kinds = new Set(header.filter((line) => TITLE.test(line.text)).map((line) =>
    (/\bChecking\b/.test(line.text) && !/\b(Savings|Money Market|Certificate of Deposit)\b/.test(line.text) ? 'CHECKING' as const : 'SAVINGS' as const)));
  if (kinds.size === 0) {
    throw new CheckingExportFormatError('the statement has no account title in its header (above its statement date or period); refusing to take it for checking');
  }
  if (kinds.size > 1) throw new CheckingExportFormatError('the statement\'s header names accounts of different kinds; refusing to guess which one it is for');
  return [...kinds][0];
}

const center = (token: Token) => (token.x + token.right) / 2;

/** The table's columns, from its header (which may take two or three lines), or null when `index` is not one. */
function headerColumns(lines: readonly Line[], index: number): Columns | null {
  const line = lines[index];
  const description = line.tokens.find((token) => /^Description$/i.test(token.text));
  const date = line.tokens.find((token) => /^Date$/i.test(token.text));
  if (!description || !date || date.x > description.x) return null;
  const near = lines.filter((other) => other.page === line.page && Math.abs(other.y - line.y) <= 26).flatMap((other) => other.tokens);
  const find = (pattern: RegExp) => near.filter((token) => pattern.test(token.text) && token.x > description.x);
  const deposits = find(/^(Deposits\/?|Additions|Credits)$/i);
  const withdrawals = find(/^(Withdrawals\/?|Subtractions|Debits)$/i);
  const balance = find(/^(Ending|daily|balance)$/i);
  if (!deposits.length || !withdrawals.length || !balance.length) return null;
  const mean = (tokens: Token[]) => tokens.reduce((sum, token) => sum + center(token), 0) / tokens.length;
  const columns = { deposits: mean(deposits), withdrawals: mean(withdrawals), balance: mean(balance.filter((token) => center(token) > mean(withdrawals))) };
  if (!Number.isFinite(columns.balance) || !(columns.deposits < columns.withdrawals && columns.withdrawals < columns.balance)) return null;
  const checkTokens = near.filter((token) => /^(Check|Number)$/i.test(token.text) && token.x > date.x && token.x < description.x);
  const halfGap = (columns.withdrawals - columns.deposits) / 2;
  return {
    date: date.x,
    check: checkTokens.length ? { from: Math.min(...checkTokens.map((token) => token.x)) - 6, to: Math.max(...checkTokens.map((token) => token.right)) + 6 } : null,
    description: description.x,
    ...columns,
    amountsFrom: columns.deposits - halfGap - 12,
  };
}

/** Which money column an amount's center is in. */
function columnOf(token: Token, columns: Columns): 'deposits' | 'withdrawals' | 'balance' {
  const x = center(token);
  if (x < (columns.deposits + columns.withdrawals) / 2) return 'deposits';
  if (x < (columns.withdrawals + columns.balance) / 2) return 'withdrawals';
  return 'balance';
}

interface Draft {
  line: number;
  page: number;
  lastY: number;
  postedDate: string;
  checkNumber: string | null;
  words: string[];
  deposits: number[];
  withdrawals: number[];
  balances: number[];
  /** An amount that cannot be read whole by the grammar, or a signed deposit or withdrawal: the row refuses. */
  unreadableAmount: boolean;
}

const TABLE_END = /^(Ending balance on|Totals\b|The Ending Daily Balance|Monthly service fee summary|Account transaction fees summary)/i;

/**
 * Puts a token of a row in its place. Left of the amounts it is description. Right of the descriptions every token is
 * an amount, read whole by the grammar into the money column it sits in: nothing there is ever taken for description.
 * A balance may be negative; a deposit or withdrawal is printed unsigned, so a signed one, or anything that cannot be
 * read as an amount (a word in a balance cell included), makes the row refuse rather than be guessed.
 */
function place(draft: Draft, token: Token, columns: Columns): void {
  if (token.x < columns.amountsFrom) {
    draft.words.push(token.text);
    return;
  }
  const value = money(token.text);
  const column = columnOf(token, columns);
  if (value === null) draft.unreadableAmount = true;
  else if (column === 'balance') draft.balances.push(value);
  else if (value < 0) draft.unreadableAmount = true;
  else draft[column].push(value);
}

/** Parses the positioned text of a Wells Fargo checking statement. */
export function parseWellsFargoStatement(pages: readonly CheckingPdfPage[]): ParsedCheckingExport {
  if (pages.length === 0) throw new CheckingExportFormatError('the PDF has no pages');
  const lines = linesOf(pages);
  if (lines.length === 0) throw new CheckingExportFormatError('the PDF has no text (a scanned statement cannot be read)');
  // Read first, so that a refusal below carries it and the converter keeps its digits out of all it prints.
  const account = accountNumber(lines);
  return withAccountNumbers([account], () => readStatement(lines, account));
}

function readStatement(lines: readonly Line[], account: string | null): ParsedCheckingExport {
  const period = statementPeriod(lines);

  const historyAt = lines.findIndex((line) => /^Transaction history\b/i.test(line.text));
  if (historyAt === -1) throw new CheckingExportFormatError('no Transaction history section was found');
  const kind = accountKind(lines, historyAt);
  // Every line whose amounts are read (the summary's, the table's rows, their continuations and the table's own ending
  // balance and Totals): the census at the end refuses an amount on any other line through the Totals.
  const read = new Set<number>();
  const { summary, beside } = summaryColumn(lines, historyAt);
  const opening = summaryAmount(summary, /Beginning balance on \d{1,2}\/\d{1,2}/i, 'Beginning balance', read);
  const deposits = summaryAmount(summary, /Deposits\/Additions/i, 'Deposits/Additions', read);
  const withdrawals = summaryAmount(summary, /Withdrawals\/Subtractions/i, 'Withdrawals/Subtractions', read);
  const closing = summaryAmount(summary, /Ending balance on \d{1,2}\/\d{1,2}/i, 'Ending balance', read);
  if (opening === null || closing === null) {
    throw new CheckingExportFormatError('the activity summary (Beginning balance on M/D, Ending balance on M/D) was not found before Transaction history');
  }
  // The summary's lines, read by their labels (R3): what lies beside one, in the account box, states no amount.
  const summaryRead = new Set(read);
  if ([...summaryRead].some((index) => beside[index] && statesAmount(beside[index]!))) {
    throw new CheckingExportFormatError('a line of the activity summary has an amount in the account box beside it; refusing rather than leave it unread');
  }

  const rows: ParsedCheckingRow[] = [];
  const problems: ParsedCheckingExport['problems'] = [];
  let columns: Columns | null = null;
  let draft: Draft | null = null;
  let done = false;
  let rowNumber = 0;
  let headerPage = 0;
  const finish = () => {
    if (!draft) return;
    const current: Draft = draft;
    draft = null;
    const amounts = current.deposits.length + current.withdrawals.length;
    if (current.unreadableAmount) {
      problems.push({ line: current.line, reason: `row on page ${current.page} has an amount whose form or sign cannot be read` });
      return;
    }
    if (amounts !== 1 || current.balances.length > 1) {
      problems.push({ line: current.line, reason: `row on page ${current.page} has ${amounts} transaction amounts and ${current.balances.length} balances; expected one amount and at most one balance` });
      return;
    }
    const description = current.words.join(' ');
    rows.push({
      line: current.line,
      postedDate: current.postedDate,
      transactionDate: null,
      amountMinor: current.deposits.length ? current.deposits[0] : -current.withdrawals[0],
      description,
      checkNumber: current.checkNumber,
      typeHint: null,
      externalId: null,
      runningBalanceMinor: current.balances.length ? current.balances[0] : null,
      pending: false,
      sourceTexts: [description],
    });
  };

  // The table's own ending balance(s) and Totals, checked against the summary and the rows once all are read.
  const tableEndings: number[] = [];
  const tableTotals: Array<{ deposits: number | null; withdrawals: number | null }> = [];
  // The line after the table's Totals: the activity is closed there (R5); null while no Totals were read.
  let closedAt: number | null = null;
  // Pages with a table header of their own: the only pages that may state amounts (Root rule 3, item 3).
  const headerPages = new Set<number>();
  const unreadableEnd = () => new CheckingExportFormatError('the table states an ending balance or Totals that cannot be read as one amount per column; refusing rather than guess');
  let at = historyAt + 1;
  for (; at < lines.length && !done; at += 1) {
    const line = lines[at];
    const header = headerColumns(lines, at);
    if (header) {
      finish();
      columns = header;
      headerPage = line.page;
      headerPages.add(line.page);
      read.add(at);
      continue;
    }
    // A page's rows are read by its own header's columns, never another page's: a page without one has no rows (and
    // an amount on it refuses, below).
    if (!columns || line.page !== headerPage) continue;
    const first = line.tokens[0];
    const text = line.text.trim();
    if (TABLE_END.test(text)) {
      finish();
      read.add(at);
      if (/^(Ending balance on|Totals\b)/i.test(text)) {
        const amounts = columnAmounts(line, columns);
        if (/^Totals\b/i.test(text)) {
          if (!amounts || amounts.balance.length > 0 || amounts.deposits.length > 1 || amounts.withdrawals.length > 1
            || [...amounts.deposits, ...amounts.withdrawals].some((value) => value < 0)) throw unreadableEnd();
          tableTotals.push({ deposits: amounts.deposits[0] ?? null, withdrawals: amounts.withdrawals[0] ?? null });
          closedAt = at + 1;
        } else {
          if (!amounts || amounts.deposits.length + amounts.withdrawals.length > 0 || amounts.balance.length !== 1) throw unreadableEnd();
          tableEndings.push(amounts.balance[0]);
        }
      }
      done = /^(Totals\b|The Ending Daily Balance)/i.test(text);
      continue;
    }
    // A row starts with a date-shaped word in the date column; its date is then read, and must be a day of the period:
    // a row is never left out because its date cannot be.
    const startsRow = first !== undefined && ROW_DATE.test(first.text) && first.x < columns.description - 4 && Math.abs(first.x - columns.date) < 30;
    if (!startsRow) {
      const current = draft as Draft | null;
      // A continuation line: directly below its row, inside the description column.
      if (current && current.page === line.page && current.lastY - line.y <= CONTINUATION_GAP && first && first.x >= columns.description - 4) {
        current.lastY = line.y;
        read.add(at);
        for (const token of line.tokens) place(current, token, columns);
      } else {
        finish();
      }
      continue;
    }
    finish();
    read.add(at);
    rowNumber += 1;
    const postedDate = rowDate(first.text, period);
    if (postedDate === null) {
      problems.push({ line: rowNumber, reason: `row on page ${line.page} has a date that is not a day of the statement period` });
      continue;
    }
    const next: Draft = {
      line: rowNumber, page: line.page, lastY: line.y, postedDate, checkNumber: null,
      words: [], deposits: [], withdrawals: [], balances: [], unreadableAmount: false,
    };
    for (const token of line.tokens.slice(1)) {
      if (columns.check && next.checkNumber === null && next.words.length === 0 && /^[0-9]{1,10}$/.test(token.text)
        && token.x >= columns.check.from && token.right <= columns.check.to) {
        next.checkNumber = token.text;
        continue;
      }
      place(next, token, columns);
    }
    draft = next;
  }
  finish();
  if (!columns) throw new CheckingExportFormatError('the Transaction history table header (Date, Description, Deposits/Additions, Withdrawals/Subtractions, Ending daily balance) was not found');
  for (let later = at; later < lines.length; later += 1) {
    if (headerColumns(lines, later)) throw new CheckingExportFormatError('the statement holds another transaction table after its Totals; refusing rather than leave its rows unread');
  }
  // Through the table's Totals (all of the statement when it states none), Root rule 3 (03:13Z): every amount the
  // statement states is read. Any line stating one that is not the summary's, a row's or the table's own ending
  // balance or Totals refuses the statement. After the Totals, R5 (14:12Z): readAfterTotals.
  const closed = closedAt ?? lines.length;
  const unread = lines.findIndex((line, index) => index < closed && !read.has(index) && statesAmount(line));
  if (unread !== -1) {
    throw new CheckingExportFormatError(`the statement states an amount on page ${lines[unread].page} outside its summary and transaction table rows; refusing rather than leave it unread`);
  }
  // A page that states amounts through the Totals has a table header of its own, whose columns its lines are read by;
  // the summary's lines are read by their labels and need none (R4).
  const headerless = lines.find((line, index) => index < closed && !summaryRead.has(index) && statesAmount(line) && !headerPages.has(line.page));
  if (headerless) {
    throw new CheckingExportFormatError(`page ${headerless.page} of the statement states amounts but has no transaction table header of its own; refusing rather than read it without one`);
  }
  // What the table states of itself must be what its rows add up to (rows that cannot be read refuse on their own).
  if (problems.length === 0) {
    const sum = (sign: 1 | -1) => rows.reduce((total, row) => total + (Math.sign(row.amountMinor) === sign ? Math.abs(row.amountMinor) : 0), 0);
    if (tableTotals.some((totals) => (totals.deposits !== null && totals.deposits !== sum(1)) || (totals.withdrawals !== null && totals.withdrawals !== sum(-1)))) {
      throw new CheckingExportFormatError('the table\'s Totals are not the sums of its rows; refusing rather than guess which is right');
    }
    if (tableEndings.some((balance) => balance !== closing)) {
      throw new CheckingExportFormatError('the table\'s ending balance is not the statement\'s closing balance; refusing rather than guess which is right');
    }
  }
  // After the Totals (R5), once every row is read: a statement whose rows cannot all be read refuses on them instead.
  const notes = closedAt !== null && problems.length === 0 ? readAfterTotals(lines, closedAt, period, rows) : [];

  return {
    institution: 'wellsfargo',
    source: 'wf-statement',
    currency: 'USD',
    accountLast4: account && account.length >= 4 ? account.slice(-4) : null,
    accountType: kind,
    accountNumberRaw: account,
    madeAt: null,
    coverage: period,
    statement: {
      openingBalanceMinor: opening,
      closingBalanceMinor: closing,
      depositsMinor: deposits === null ? null : Math.abs(deposits),
      withdrawalsMinor: withdrawals === null ? null : Math.abs(withdrawals),
    },
    ledgerBalance: null,
    availableBalance: null,
    rows,
    problems,
    droppedColumns: [],
    notes,
  };
}

/** A line shaped like a transaction: it starts with a date (M/D), or with a number and then a date, and states an amount. */
const rowShaped = (line: Line) => statesAmount(line) && (ROW_DATE.test(line.tokens[0]?.text ?? '')
  || (/^[0-9]{1,10}$/.test(line.tokens[0]?.text ?? '') && ROW_DATE.test(line.tokens[1]?.text ?? '')));

/**
 * After the table's Totals (Root R5, 14:12Z). The activity is closed there: the opening balance plus the rows is the
 * closing balance and the Totals are the rows' sums, exactly. What follows is prose (the monthly service fee summary,
 * notices) whose amounts are not activity and are not read, and two lists, each under its own heading and header:
 * - `Summary of checks written` (Number Date Amount, in one or more groups across a line): every check it lists is
 *   read whole and must be a check row of the table, with the same number, date and amount, each row once;
 * - `Items returned unpaid` (Date Description Amount): every item is read whole (a date of the period, then its
 *   description, then exactly one amount in its Amount column); they are not activity (the table reconciles without
 *   them) and are only counted, with their dates, in a note. That exact heading is the only one read (Root 14:41Z):
 *   under any other (a bare `Items returned` included) the rows are unexplained and refuse.
 * Any other line shaped like a transaction refuses the statement. Returns the notes.
 */
function readAfterTotals(lines: readonly Line[], from: number, period: { start: string; end: string }, rows: readonly ParsedCheckingRow[]): string[] {
  const matched = new Set<ParsedCheckingRow>();
  const returned: string[] = [];
  let at = from;
  while (at < lines.length) {
    const line = lines[at];
    if (/^Summary of checks written\b/i.test(line.text)) at = readChecksWritten(lines, at + 1, period, rows, matched);
    else if (/^Items returned unpaid$/i.test(line.text)) at = readItemsReturned(lines, at + 1, period, returned);
    else if (rowShaped(line)) {
      throw new CheckingExportFormatError(`the statement states a dated row on page ${line.page} after its Totals that no list it reads explains; refusing rather than leave it unread`);
    } else at += 1;
  }
  if (returned.length === 0) return [];
  return [`the statement lists ${returned.length} item${returned.length === 1 ? '' : 's'} returned unpaid (${returned.join(', ')}); not activity, not imported`];
}

/** A list's rows: the lines after its header up to the first that neither states an amount nor starts with a number or date. */
function listRows(lines: readonly Line[], from: number): { rows: Line[]; next: number } {
  let next = from;
  while (next < lines.length && (statesAmount(lines[next]) || /^[0-9]/.test(lines[next].tokens[0]?.text ?? ''))) next += 1;
  return { rows: lines.slice(from, next), next };
}

function readChecksWritten(lines: readonly Line[], at: number, period: { start: string; end: string },
  rows: readonly ParsedCheckingRow[], matched: Set<ParsedCheckingRow>): number {
  const header = lines[at];
  const names = ['Number', 'Date', 'Amount'];
  if (!header || header.tokens.length === 0 || header.tokens.length % 3 !== 0
    || header.tokens.some((token, index) => token.text.toLowerCase() !== names[index % 3].toLowerCase())) {
    throw new CheckingExportFormatError('the statement\'s Summary of checks written has no Number Date Amount header; refusing rather than leave its checks unread');
  }
  const list = listRows(lines, at + 1);
  for (const line of list.rows) {
    const tokens = line.tokens;
    if (tokens.length === 0 || tokens.length % 3 !== 0 || tokens.length > header.tokens.length) {
      throw new CheckingExportFormatError(`the statement's Summary of checks written has a line on page ${line.page} that is not checks (Number Date Amount); refusing rather than guess`);
    }
    for (let group = 0; group < tokens.length; group += 3) {
      const [number, day, amount] = [tokens[group].text, tokens[group + 1].text, tokens[group + 2].text];
      const date = ROW_DATE.test(day) ? rowDate(day, period) : null;
      const value = money(amount);
      const row = /^[0-9]{1,10}$/.test(number) && date !== null && value !== null && value > 0
        ? rows.find((candidate) => !matched.has(candidate) && candidate.checkNumber === number && candidate.postedDate === date && candidate.amountMinor === -value)
        : undefined;
      if (!row) {
        throw new CheckingExportFormatError(`the statement's Summary of checks written lists a check on page ${line.page} that is not a check row of its table (number, date and amount); refusing rather than guess which is right`);
      }
      matched.add(row);
    }
  }
  return list.next;
}

function readItemsReturned(lines: readonly Line[], at: number, period: { start: string; end: string }, returned: string[]): number {
  const header = lines[at];
  if (!header || !/^Date Description Amount$/i.test(header.text)) {
    throw new CheckingExportFormatError('the statement\'s Items returned unpaid list has no Date Description Amount header; refusing rather than leave its items unread');
  }
  // The Amount column, bounded from its label as the table's columns are from theirs: its cell is everything from the
  // label's left edge, less the label's width and a margin, read whole as exactly one amount by the one grammar (Root
  // 14:41Z); a sign, a parenthesis, a second amount or a split number in it refuses. Left of it is the description,
  // which states no amount.
  const label = header.tokens[2];
  const amountsFrom = label.x - (label.right - label.x) - 12;
  const list = listRows(lines, at + 1);
  for (const line of list.rows) {
    const [first, ...rest] = line.tokens;
    const description = rest.filter((token) => token.x < amountsFrom);
    const cell = rest.filter((token) => token.x >= amountsFrom);
    const date = first && ROW_DATE.test(first.text) ? rowDate(first.text, period) : null;
    const value = cell.length > 0 ? money(cell.map((token) => token.text).join(' ')) : null;
    if (date === null || description.length === 0 || value === null || value <= 0 || statesAmount(lineOf(line, description))) {
      throw new CheckingExportFormatError(`the statement's Items returned unpaid list has an item on page ${line.page} that cannot be read whole (a date of the period, its description, then exactly one amount in its Amount column); refusing rather than guess`);
    }
    returned.push(date);
  }
  return list.next;
}

/**
 * What the reader found in a statement's layout, for an owner to share when a statement is refused: page and line
 * counts, which landmarks were found, the table's column positions and how many rows began. Positions and counts
 * only; no text of the statement.
 */
export function describeWellsFargoStatementLayout(pages: readonly CheckingPdfPage[]): Record<string, unknown> {
  const lines = linesOf(pages);
  const historyAt = lines.findIndex((line) => /^Transaction history\b/i.test(line.text));
  const headers = lines.map((_, index) => headerColumns(lines, index)).flatMap((columns, index) => (columns ? [{ page: lines[index].page, ...roundColumns(columns) }] : []));
  let periodFound = true;
  try {
    statementPeriod(lines);
  } catch {
    periodFound = false;
  }
  let kind: string;
  try {
    kind = accountKind(lines, historyAt).toLowerCase();
  } catch {
    kind = 'refused';
  }
  return {
    pages: pages.length,
    lines: lines.length,
    periodFound,
    statementDateFound: lines.some((line) => line.page === 1 && DATED.test(line.text)),
    accountKind: kind,
    accountNumberFound: accountNumber(lines) !== null,
    accountBoxBesideSummary: summaryColumn(lines, historyAt).beside.some((part) => part !== null),
    transactionHistoryFound: historyAt !== -1,
    summaryLabels: ['Beginning balance on', 'Deposits/Additions', 'Withdrawals/Subtractions', 'Ending balance on']
      .filter((label) => lines.slice(0, historyAt === -1 ? lines.length : historyAt).some((line) => line.text.toLowerCase().includes(label.toLowerCase()))),
    headers,
    dateStartedLines: lines.filter((line) => line.tokens[0] && ROW_DATE.test(line.tokens[0].text)).length,
    listsAfterTotals: ['Summary of checks written', 'Items returned unpaid'].filter((heading) => lines.some((line) => line.text.startsWith(heading))),
  };
}

function roundColumns(columns: Columns): Record<string, unknown> {
  const round = (value: number) => Math.round(value);
  return {
    date: round(columns.date), description: round(columns.description), deposits: round(columns.deposits),
    withdrawals: round(columns.withdrawals), balance: round(columns.balance), check: columns.check ? [round(columns.check.from), round(columns.check.to)] : null,
  };
}

export const wellsFargoStatementAdapter: CheckingExportAdapter = Object.freeze({
  source: 'wf-statement',
  institution: 'wellsfargo',
  input: 'pdf',
  description: 'Wells Fargo checking statement PDF (Statements & Documents)',
  // Wells Fargo's own words, both required: another bank's statement can name Wells Fargo in a row, never its labels.
  detect: (input: CheckingExportInput) => {
    if (input.kind !== 'pdf') return false;
    const text = linesOf(input.pages.slice(0, 2)).map((line) => line.text).join('\n');
    return /Wells Fargo/i.test(text) && /Withdrawals\/Subtractions/i.test(text);
  },
  parse: (input: CheckingExportInput, _options: CheckingAdapterOptions) => {
    if (input.kind !== 'pdf') throw new CheckingExportFormatError('a Wells Fargo statement is a PDF');
    return parseWellsFargoStatement(input.pages);
  },
  describe: (input: CheckingExportInput) => (input.kind === 'pdf' ? describeWellsFargoStatementLayout(input.pages) : { pdf: false }),
});
