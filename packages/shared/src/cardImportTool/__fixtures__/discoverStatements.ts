/**
 * Synthetic Discover statement layouts for tests: every name, amount, date and card number here is invented. Each
 * builder returns pages of `[x, y, text]` cells in PDF points (y grows upwards), placed where the three layouts
 * (A 2019, B 2020-2025, C 2026) print them, so tests can read them directly (`pagesOf`) or as a PDF set in Helvetica
 * 9 pt (apps/api testing/syntheticPdf.ts `positionedPdf`), which pdf.js measures with the same widths as `pagesOf`.
 */
import type { StatementPdfPage } from '../parsed.js';

export type Cell = [number, number, string];

/** Helvetica's advance widths (1/1000 em) for printable ASCII, as the standard font metrics give them. */
const HELVETICA: Readonly<Record<string, number>> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278,
  '/': 278, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015, '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333,
  s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, '{': 334, '|': 260, '}': 334, '~': 584, '\u00ae': 737,
};
const FONT_SIZE = 9;

/** The width of `text` in Helvetica 9 pt, as pdf.js reports it for a synthetic PDF. */
export function helveticaWidth(text: string): number {
  let units = 0;
  for (const char of text) units += char >= '0' && char <= '9' ? 556 : HELVETICA[char] ?? 556;
  return (units * FONT_SIZE) / 1000;
}

/** pdf.js-like items from cells. */
export function pagesOf(pages: ReadonlyArray<ReadonlyArray<Cell>>): StatementPdfPage[] {
  return pages.map((cells) => ({ items: cells.map(([x, y, text]) => ({ text, x, y, width: helveticaWidth(text) })) }));
}

/** A cell whose text ends at `rightEdge`: a right-aligned amount. */
const rightAligned = (rightEdge: number, y: number, text: string): Cell => [Math.round((rightEdge - helveticaWidth(text)) * 100) / 100, y, text];

/** `1234` as `12.34`, `123456` as `1,234.56`. */
export function money(minor: number): string {
  const digits = String(Math.abs(minor)).padStart(3, '0');
  return `${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${digits.slice(-2)}`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** `2019-09-06` as `09/06/2019`. */
const slashed = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
/** `2019-09-06` as `Sep 06, 2019`. */
const named = (date: string) => `${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} ${date.slice(8, 10)}, ${date.slice(0, 4)}`;
const dayCount = (open: string, close: string) => Math.round((Date.UTC(+close.slice(0, 4), +close.slice(5, 7) - 1, +close.slice(8, 10))
  - Date.UTC(+open.slice(0, 4), +open.slice(5, 7) - 1, +open.slice(8, 10))) / 86_400_000) + 1;

/** An invented card number (the issuer's published test number): it must never reach any output. */
export const SYNTHETIC_CARD_NUMBER = '6011111111111117';
export const SYNTHETIC_LAST4 = '1117';
/** The scan line at the foot of a payment coupon: the card number among other digits. */
const scanLine = (minor: number) => `${SYNTHETIC_CARD_NUMBER}${String(Math.abs(minor)).padStart(9, '0')}0000250004`;

export interface SyntheticCredit {
  /** `MM/DD` (B) or `Mon DD` (A). */
  date: string;
  /** Layout A only: the post date, `Mon DD` (default: the transaction date). */
  posted?: string;
  description: string;
  /** More description lines printed under the row. */
  wrap?: string[];
  /** Positive: taken off the balance. */
  minor: number;
}

export interface SyntheticPurchase extends Omit<SyntheticCredit, 'minor'> {
  category: string;
  /** Positive: added to the balance. */
  minor: number;
}

export interface SyntheticStatement {
  last4?: string;
  open: string;
  close: string;
  previousMinor: number;
  credits?: SyntheticCredit[];
  purchases?: SyntheticPurchase[];
}

/** The summary figures a statement's rows make. */
export function figuresOf(statement: SyntheticStatement): { credits: number; purchases: number; newBalance: number } {
  const credits = (statement.credits ?? []).reduce((total, row) => total + row.minor, 0);
  const purchases = (statement.purchases ?? []).reduce((total, row) => total + row.minor, 0);
  return { credits, purchases, newBalance: statement.previousMinor - credits + purchases };
}

/** A signed balance as the summaries print one: `$12.34`, a credit balance `-$12.34`. */
const balance = (minor: number) => `${minor < 0 ? '-' : ''}$${money(minor)}`;

/** Layout B (2020 to 2025): four pages, the transactions on page 3 beside the Cashback Bonus box. */
export function layoutB(statement: SyntheticStatement): Cell[][] {
  const last4 = statement.last4 ?? SYNTHETIC_LAST4;
  const { credits, purchases, newBalance } = figuresOf(statement);
  const period = `${slashed(statement.open)} - ${slashed(statement.close)}`;
  const year = statement.close.slice(0, 4);
  const header = (page: number): Cell[] => [
    [542.8, 767.3, `Page ${page} of 4`],
    [18, 765.5, 'DISCOVER IT'], [70.3, 765.5, 'CARD ENDING IN'], [123.5, 765.5, last4],
    [18, 756.8, 'ALEX SAMPLE'], [398, 757, `OPEN TO CLOSE DATE: ${period}`],
  ];
  const summary = (y: number, label: string, amount: string): Cell[] => [[38, y, label], rightAligned(272.3, y, amount)];
  const page1: Cell[] = [
    [136, 753.8, 'DISCOVER IT'], [188.5, 753.8, 'CARD ENDING'], [234, 753.8, `IN ${last4}`],
    [136, 742.5, 'CARDMEMBER SINCE 2019'],
    [42.5, 686.3, 'Account Summary'], [174, 688, period], [311.3, 686.3, 'Payment Information'],
    ...summary(666.8, 'Previous Balance', balance(statement.previousMinor)), [404.5, 664.8, 'Minimum Payment'],
    [307, 664.5, 'New Balance'], [503.3, 664.5, 'Payment Due Date'],
    ...summary(654, 'Payments and Credits', credits === 0 ? '+$0.00' : `-$${money(credits)}`),
    [307, 650.5, '$'], [404.5, 650.5, '$'], [311.3, 646.8, money(newBalance)], [409, 646.8, '0.00'], [503.3, 646.8, slashed(statement.close)],
    ...summary(641.3, 'Purchases', `+$${money(purchases)}`),
    ...summary(628.5, 'Balance Transfers', '+$0.00'), [307, 627, 'Late Payment Warning:'], [389.8, 627, 'If we do not receive your payment'],
    ...summary(615.8, 'Cash Advances', '+$0.00'), [307, 617, 'listed above, you may have to pay a late fee of up to $40.'],
    ...summary(603, 'Fees Charged', '+$0.00'),
    ...summary(590.3, 'Interest Charged', '+$0.00'),
    [307, 591, `DirectPay of $${money(Math.max(newBalance, 0))} on May 25, ${year}.`],
    [307, 581, 'See "DirectPay" for details.'],
    ...summary(572, 'New Balance:', balance(newBalance)),
    [38, 555, 'See Interest Charge Calculation section following the'], [387, 555, 'Fees and Interest Charged section'],
    [38, 544, 'Interest Charged section for APR information'],
    [38, 530, 'Credit Line'], [244.3, 530, '$5,000'], [38, 516, 'Credit Line Available'], [244.3, 516, '$5,000'],
    [38, 504, 'Cash Advance Credit Line'], [244.3, 504, '$1,000'], [38, 491, 'Cash Advance Credit Line Available'], [244.3, 491, '$1,000'],
    [111, 444, '780'], [172, 444, `AS OF ${statement.close.slice(5, 7)}/${statement.close.slice(8, 10)}/${year.slice(2)}`],
    [380, 247.3, 'NOTICE: See reverse side'],
    [42.5, 232, 'Payment Coupon'], [362, 231, `ACCOUNT NUMBER ENDING IN ${last4}`],
    [362, 217, 'New Balance'], rightAligned(596, 217, money(newBalance)),
    [362, 204, 'Minimum Payment Due'], rightAligned(596, 204, '0.00'), [362, 190, 'Payment Due Date'], [536, 190, slashed(statement.close)],
    [46, 155, 'ALEX SAMPLE'], [46, 144, '100 SAMPLE ST'], [46, 132, 'SAMPLETOWN ZZ 00000-0000'],
    [54, 31, scanLine(newBalance)],
  ];
  const page2: Cell[] = [
    ...header(2),
    [18, 741, 'Important Information'], [303, 741, 'Minimum Payment Due, plus any past due amount'],
    [18, 672, 'You have 60 days to dispute a charge on your statement.'], [303, 672, 'Credits or payments made after the Close Date.'],
    [18, 628, 'Payments. You may pay all or part of your Account balance at any time.'],
  ];
  const rows: Cell[] = [];
  let y = 643;
  const rowsOf = (list: ReadonlyArray<SyntheticCredit | SyntheticPurchase>, credit: boolean) => {
    for (const row of list) {
      rows.push([38, y, row.date], [80, y, row.description], rightAligned(405.4, y, credit ? `-$${money(row.minor)}` : `$${money(row.minor)}`));
      if (!credit) rows.push([256.5, y, (row as SyntheticPurchase).category]);
      for (const wrapped of row.wrap ?? []) {
        y -= 11;
        rows.push([80, y, wrapped]);
      }
      y -= 11.5;
    }
  };
  const page3: Cell[] = [
    ...header(3),
    [42.5, 687, 'Transactions'], [418.5, 686.8, 'Cashback Bonus'], [521.8, 686.8, 'Rewards'],
    [414, 667, 'PREVIOUS BALANCE'], rightAligned(593.9, 667, '$1.23'),
    [414, 653, 'EARNED THIS PERIOD'], [421, 639.3, '1% Cashback Bonus'], rightAligned(594.1, 639.3, `+$${money(Math.round(purchases / 100))}`),
    [414, 625.3, 'REDEEMED THIS PERIOD'], rightAligned(593.9, 625.3, '-$0.00'),
    [414, 604.8, 'CASHBACK BONUS BALANCE'], rightAligned(593.9, 604.8, '$1.23'),
  ];
  if ((statement.credits ?? []).length === 0 && (statement.purchases ?? []).length === 0) {
    page3.push([38, 669, 'NO ACTIVITY FOR THIS BILLING PERIOD']);
    y = 640;
  } else {
    if ((statement.credits ?? []).length > 0) {
      page3.push([38, 668.5, 'TRANS.'], [38, 658, 'DATE'], [80, 658, 'PAYMENTS AND CREDITS'], rightAligned(405.4, 658, 'AMOUNT'));
      rowsOf(statement.credits ?? [], true);
      y -= 9;
    }
    if ((statement.purchases ?? []).length > 0) {
      page3.push([38, y + 10, 'TRANS.'], [38, y, 'DATE'], [80, y, 'PURCHASES'], [256.5, y, 'MERCHANT CATEGORY'], rightAligned(405.4, y, 'AMOUNT'));
      y -= 11.2;
      rowsOf(statement.purchases ?? [], false);
    }
    page3.push(...rows);
    y -= 12;
  }
  // The Cashback Bonus box's note stands 2.2 points above the fees total's label and 1.9 above its amount: grouped
  // across the whole page, the note would take the amount away from its label.
  page3.push(
    [42.5, y, 'Fees and Interest Charged'],
    [414, y - 26.4, '5% Cashback Bonus at restaurants'],
    [38, y - 28.6, 'TOTAL FEES FOR THIS PERIOD'], rightAligned(405.4, y - 28.3, '$0.00'),
    [38, y - 49.1, 'TOTAL INTEREST FOR THIS PERIOD'], rightAligned(405.4, y - 49.1, '$0.00'),
    [38, y - 69, `${year} TOTALS YEAR-TO-DATE CHARGED`], rightAligned(405.4, y - 69, 'AMOUNT'),
    [38, y - 79, `TOTAL FEES CHARGED IN ${year}`], rightAligned(405.3, y - 79, '$0.00'),
    [38, y - 89, `TOTAL INTEREST CHARGED IN ${year}`], rightAligned(405.3, y - 89, '$0.00'),
    [43, y - 120, 'Interest Charge Calculation'],
    [38, y - 138, 'Your Annual Percentage Rate (APR) is the annual interest rate on your account.'],
    [38, y - 151, 'Days in'], [132, y - 151, `BILLING PERIOD: ${dayCount(statement.open, statement.close)} DAYS`],
    [38, y - 175, 'Purchases'], [150, y - 175, '19.24%'], [213, y - 175, '(v)'], [276, y - 175, '$0.00'], [385, y - 175, '$0.00'],
    [38, y - 188, 'Cash Advances'], [150, y - 188, '25.24%'], [213, y - 188, '(v)'], [276, y - 188, '$0.00'], [385, y - 188, '$0.00'],
    [500, 18, 'Continued on next page'],
  );
  const page4: Cell[] = [
    ...header(4),
    [23, 705, 'Information For You'],
    [18, 510, 'You may not receive a statement if you have no account activity'],
    [167, 377, '02/20'], [200, 377, '03/20'], [234, 377, '04/20'], [268, 377, '05/20'], [301, 377, '06/20'], [334, 377, '07/20'],
  ];
  return [page1, page2, page3, page4];
}

/** Layout A (2019): its summary's operators stand apart; its rows carry a category, two dates and a `$` of their own. */
export function layoutA(statement: SyntheticStatement): Cell[][] {
  const last4 = statement.last4 ?? SYNTHETIC_LAST4;
  const { credits, purchases, newBalance } = figuresOf(statement);
  const year = statement.close.slice(0, 4);
  const header = (page: number): Cell[] => [
    [24.5, 771.3, 'ALEX SAMPLE'], [162, 771.3, `Account number ending in ${last4}`], [313, 771.3, 'Open Date:'], [357, 771.3, named(statement.open)],
    [402.9, 771.3, '- Close Date:'], [451.5, 771.3, named(statement.close)], [533, 771.3, `Page ${page}`], [559.9, 771.3, 'of 4'],
  ];
  const component = (y: number, operator: string, label: string, minor: number): Cell[] => [
    [operator === '-' ? 167.8 : 166.3, y + 2.4, operator], [42.8, y, label], [227.8, y, `$${money(minor)}`],
  ];
  const dueDate = `${FULL_MONTHS[Number(statement.close.slice(5, 7)) % 12]} 02, ${year}`;
  const page1: Cell[] = [
    [480.5, 745.8, 'Discover it'], [556.3, 745.8, 'Card'],
    [473.8, 731.8, `Account number ending in ${last4}`],
    [390, 719.5, `Open Date: ${named(statement.open)} - Close Date: ${named(statement.close)}`],
    [498.3, 708.5, 'Cardmember Since 2019'], [540.8, 689.8, 'Page 1 of 4'],
    [38, 672, 'ACCOUNT SUMMARY'], [271, 672, 'PAYMENT INFORMATION'],
    [42.8, 654, 'Previous Balance'], [227.8, 654, balance(statement.previousMinor)],
    [286.5, 654.5, 'New Balance'], rightAligned(570.1, 654.5, balance(newBalance)),
    ...component(642.5, '-', 'Payments and Credits', credits),
    [286.5, 639.8, 'Minimum Payment Due'], rightAligned(570, 639.8, '$0.00'),
    ...component(630.8, '+', 'Purchases', purchases),
    [286.5, 626.8, 'Payment Due Date'], rightAligned(570.1, 626.8, dueDate),
    ...component(619.3, '+', 'Balance Transfers', 0),
    ...component(607.5, '+', 'Cash Advances', 0),
    [286.5, 607, 'Late Payment Warning:'], [378.3, 607, 'If we do not receive your payment by the'],
    [286.5, 598, 'date listed above, you may have to pay a late fee of up to $40.'],
    ...component(595.8, '+', 'Fees Charged', 0),
    ...component(584.3, '+', 'Interest Charged', 0),
    [42.8, 570.5, 'New Balance'], [227.8, 570.5, balance(newBalance)],
    [43, 532, 'Credit Line'], [223, 532, '$5,000'], [286, 532, 'Opening Balance'], [551, 532, '1.23'],
    [38, 356, 'Thank you for your continued participation in DirectPay'],
    [38, 347, `automatic payments. Your next DirectPay payment of $${money(Math.max(newBalance, 0))}`],
    [38, 338, `will be debited on Nov 02, ${year}. See "DirectPay" for details.`],
    [46, 145, '100 SAMPLE ST'], [54, 31, scanLine(newBalance)],
  ];
  const page2: Cell[] = [...header(2), [16, 754, 'Important Information'], [300, 664, 'Statements show credits posted before the Close Date.']];
  const rows: Cell[] = [];
  let y = 582.5;
  let previousGroup: string | null = null;
  const rowsOf = (list: ReadonlyArray<SyntheticCredit | SyntheticPurchase>, credit: boolean) => {
    for (const row of list) {
      const group = credit ? 'Payments and Credits' : (row as SyntheticPurchase).category;
      if (group !== previousGroup) rows.push([38, y, group]);
      previousGroup = group;
      rows.push([155.3, y, row.date], [213.8, y, row.posted ?? row.date], [260.5, y, row.description], [505.8, y, '$'],
        rightAligned(587.2, y, credit ? `-${money(row.minor)}` : money(row.minor)));
      for (const wrapped of row.wrap ?? []) {
        y -= 13;
        rows.push([260.5, y, wrapped]);
      }
      y -= 19.7;
    }
  };
  rowsOf(statement.credits ?? [], true);
  rowsOf(statement.purchases ?? [], false);
  const page3: Cell[] = [
    ...header(3),
    [38, 606, 'Transactions'], [155.3, 595.8, 'Trans. Date'], [213.8, 595.8, 'Post Date'],
    ...rows,
    [505.8, y - 5, '$'], [38, y - 10, 'Fees'], [260.5, y - 10, 'TOTAL FEES FOR THIS PERIOD'], rightAligned(587, y - 10, '0.00'),
    [506, y - 32, '$'], [38, y - 37, 'Interest Charged'], [260.8, y - 37, 'TOTAL INTEREST FOR THIS PERIOD'], rightAligned(587.3, y - 37, '0.00'),
    [38, y - 72, `${year} Totals Year-to-Date`],
    [506, y - 83.8, '$'], [260.8, y - 88.3, `TOTAL FEES CHARGED IN ${year}`], rightAligned(587.3, y - 88.3, '0.00'),
    [506, y - 102.8, '$'], [260.8, y - 112.3, `TOTAL INTEREST CHARGED IN ${year}`], rightAligned(587.3, y - 112.3, '0.00'),
    [38, y - 135, 'Interest Charge Calculation'],
    [38, y - 161, 'Days in Billing Period:'], [140, y - 161, `${dayCount(statement.open, statement.close)} days`],
    [38, y - 182, 'Purchases'], [189, y - 182, '19.24%'], [297, y - 182, '(v)'], [405, y - 182, '$0.00'], [513, y - 182, '$0.00'],
    [300, 23, 'NOTICE: SEE REVERSE SIDE'],
  ];
  const page4: Cell[] = [
    ...header(4), [27, 706, 'Information For You'],
    [167, 377, '10/18'], [200, 377, '11/18'], [234, 377, '12/18'], [268, 377, '01/19'], [301, 377, '02/19'], [334, 377, '03/19'],
  ];
  return [page1, page2, page3, page4];
}

/** Layout C (2026), as seen: a statement without activity. */
export function layoutC(statement: Pick<SyntheticStatement, 'last4' | 'open' | 'close' | 'previousMinor'>): Cell[][] {
  const last4 = statement.last4 ?? SYNTHETIC_LAST4;
  const period = `${slashed(statement.open)} - ${slashed(statement.close)}`;
  const year = statement.close.slice(0, 4);
  const header = (page: number): Cell[] => [
    [554, 773, `Page ${page} of 4`], [115, 766, `Discover it Card ending in ${last4}`], [115, 751, 'CARDMEMBER SINCE 2019'],
    [115, 737, `OPEN TO CLOSE DATE: ${period}`],
  ];
  const summary = (y: number, label: string, amount: string): Cell[] => [[38.2, y, label], rightAligned(271.7, y, amount)];
  const page1: Cell[] = [
    ...header(1),
    [41.8, 713.3, 'Account Summary'], [175.7, 714, period], [292, 712.3, 'Payment Information'],
    ...summary(693.8, 'Previous Balance', balance(statement.previousMinor)),
    [288, 694.6, 'New Balance'], [378.2, 693.8, 'Minimum Payment'], [488.2, 694.6, 'Payment Due Date'],
    ...summary(679.9, 'Payments and Credits', '$0.00'),
    [288, 679.7, balance(statement.previousMinor)], [378.2, 679.7, '$0.00'], [488.2, 679.7, slashed(statement.close)],
    ...summary(666, 'Transactions', '+ $0.00'), [288, 666.2, 'For online payments, the deadline is 8 p.m. ET'],
    [288, 656.6, 'statement closing date and the cutoff is 5 p.m. ET.'],
    ...summary(652.1, 'Cash Advances', '+ $0.00'), [288, 647, `Next statement closing date: August 27, ${year}`],
    ...summary(638.2, 'Fees Charged', '+ $0.00'), [288, 632.2, 'LATE PAYMENT WARNING:'], [387.1, 632.2, 'If we do not receive your payment'],
    ...summary(624.2, 'Interest Charged', '+ $0.00'), [288, 622.6, 'date, you may have to pay a late fee of up to $41.'],
    [38.2, 607, 'New Balance:'], rightAligned(272.1, 607, balance(statement.previousMinor)),
    [38.2, 564, 'Credit Line'], [228, 564, '$5,000.00'],
    [29, 107, `Payment Due Date: Aug 24, ${year}`], [219, 107, `Account ending in ${last4}`],
    [32, 87, 'New Balance'], [131, 87, 'Minimum Payment Due'], [247, 87, 'Amount Enclosed'],
    [32, 70, balance(statement.previousMinor)], [131, 70, '$0.00'],
    [260, 18, SYNTHETIC_CARD_NUMBER.slice(0, 8)], [398, 18, SYNTHETIC_CARD_NUMBER.slice(8)],
  ];
  const page3: Cell[] = [
    ...header(3),
    [42, 713, 'Transactions'], [418, 713, 'Rewards Summary'],
    [414, 696, 'PREVIOUS BALANCE'], rightAligned(593.7, 696, '$0.00'), [102, 692, 'Log in to see recent transactions.'],
    [414, 681, 'EARNED THIS PERIOD'], rightAligned(593.7, 681, '$0.00'), [38, 673, 'NO ACTIVITY FOR THIS BILLING PERIOD'],
    [414, 666, 'REDEEMED THIS PERIOD'], rightAligned(593.7, 666, '$0.00'),
    [414, 648, 'CASHBACK BONUS BALANCE'], rightAligned(593.7, 648, '$0.00'),
    [42, 641, 'Fees and Interest Charged'],
    [38, 624, 'TOTAL FEES FOR THIS PERIOD'], rightAligned(401.6, 624, '$0.00'),
    [38, 597, 'TOTAL INTEREST FOR THIS PERIOD'], rightAligned(401.6, 597, '$0.00'),
    [38, 570, `${year} TOTALS YEAR-TO-DATE CHARGED`], [371, 570, 'AMOUNT'],
    [38, 558, `TOTALS FEES CHARGED IN ${year}`], rightAligned(401.6, 558, '$0.00'),
    [38, 544, `TOTALS INTEREST CHARGED IN ${year}`], rightAligned(401.6, 544, '$0.00'),
    [42, 514, 'Interest Charge Calculation'],
    [38, 482, 'Interest Charge on'], [142, 482, `BILLING PERIOD: ${dayCount(statement.open, statement.close)} DAYS`],
    [494, 24, 'Continued on next page'],
  ];
  return [page1, [...header(2), [36, 756, 'How We Calculate Interest Charges']], page3,
    [...header(4), [36, 345, 'You may not receive a statement if you have no card account activity']]];
}

/** Invented values no report or message may show: the holder's name and address, and the card number. */
export const SYNTHETIC_SENSITIVE: readonly string[] = ['ALEX SAMPLE', '100 SAMPLE ST', 'SAMPLETOWN', SYNTHETIC_CARD_NUMBER, '60111111'];
