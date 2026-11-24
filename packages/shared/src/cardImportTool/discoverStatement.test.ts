import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  helveticaWidth,
  layoutA,
  layoutB,
  layoutC,
  pagesOf,
  SYNTHETIC_LAST4,
  SYNTHETIC_SENSITIVE,
  type Cell,
  type SyntheticStatement,
} from './__fixtures__/discoverStatements.js';
import {
  DiscoverStatementError,
  discoverStatementLines,
  looksLikeDiscoverStatement,
  parseDiscoverStatement,
  type DiscoverRefusalReason,
} from './discoverStatement.js';

/** Invented statements: the values below must never appear in a refusal. */
const JANUARY: SyntheticStatement = {
  open: '2020-01-12', close: '2020-02-11', previousMinor: 1734,
  credits: [{ date: '01/20', description: 'DIRECTPAY FULL BALANCE', wrap: ['SEE DETAILS OF YOUR NEXT DIRECTPAY BELOW'], minor: 1734 }],
  purchases: [
    { date: '01/02', description: 'CONTOSO COFFEE', category: 'Restaurants', minor: 1250 },
    { date: '01/15', description: 'FABRIKAM MARKET #123', wrap: ['SEATTLE WA'], category: 'Supermarkets', minor: 2300 },
  ],
};
const DECEMBER: SyntheticStatement = {
  open: '2019-12-12', close: '2020-01-11', previousMinor: 2500,
  credits: [{ date: 'Dec 20', description: 'INTERNET PAYMENT - THANK YOU', minor: 2500 }],
  purchases: [{ date: 'Dec 28', posted: 'Dec 30', description: 'SAMPLE BOOKS #12', wrap: ['800-555-0100 WA'], category: 'Merchandise', minor: 1734 }],
};
const VALUES = ['CONTOSO', 'FABRIKAM', 'SAMPLE BOOKS', 'SEATTLE', '17.34', '12.50', '23.00', '35.50', '25.00', '1,734', ...SYNTHETIC_SENSITIVE];

const copy = (pages: Cell[][]) => pages.map((cells) => cells.map((cell) => [...cell] as Cell));
/** The pages with `edit` applied to a copy of their cells. */
function edited(pages: Cell[][], edit: (cells: Cell[][]) => void): Cell[][] {
  const next = copy(pages);
  edit(next);
  return next;
}
function cellOf(pages: Cell[][], text: string, nth = 0): Cell {
  const found = pages.flat().filter((cell) => cell[2] === text);
  if (!found[nth]) throw new Error(`no cell ${text}`);
  return found[nth];
}
const replace = (pages: Cell[][], from: string, to: string, nth = 0) => {
  cellOf(pages, from, nth)[2] = to;
};
/** Removes every cell on the baseline of the cell that reads `text`. */
const dropLine = (pages: Cell[][], text: string) => {
  const target = cellOf(pages, text);
  for (const cells of pages) {
    if (!cells.includes(target)) continue;
    for (let index = cells.length - 1; index >= 0; index -= 1) if (Math.abs(cells[index][1] - target[1]) < 0.5) cells.splice(index, 1);
  }
};

function refusal(pages: Cell[][], reason: DiscoverRefusalReason): string {
  try {
    parseDiscoverStatement(pagesOf(pages));
  } catch (error) {
    assert.ok(error instanceof DiscoverStatementError, String(error));
    for (const value of VALUES) assert.ok(!error.message.includes(value), `shows ${value}: ${error.message}`);
    assert.equal(error.reason, reason, error.message);
    return error.message;
  }
  assert.fail('expected the statement to be refused');
}

describe('Discover statement PDF', () => {
  it('has synthetic statements that stay inside a US Letter page, so a PDF of them keeps every glyph', () => {
    for (const pages of [layoutA(DECEMBER), layoutB(JANUARY), layoutB({ open: '2020-02-12', close: '2020-03-11', previousMinor: 0 }),
      layoutC({ open: '2026-05-25', close: '2026-06-27', previousMinor: 0 })]) {
      for (const [x, y, text] of pages.flat()) {
        assert.ok(x >= 0 && y >= 0 && y <= 792 && x + helveticaWidth(text) <= 612, `${text} at ${x},${y} leaves the page`);
      }
    }
  });

  it('assembles lines from positioned text, and reads each column apart from the box beside it', () => {
    const pages = pagesOf(layoutB(JANUARY));
    const lines = discoverStatementLines(pages);
    assert.ok(lines.some((line) => line.text === 'Account Summary 01/12/2020 - 02/11/2020 Payment Information'));
    // Grouped across the whole page, the Cashback Bonus note takes the fees total's amount away from its label ...
    const label = lines.find((line) => line.text.startsWith('TOTAL FEES FOR THIS PERIOD'))!;
    assert.equal(label.text, 'TOTAL FEES FOR THIS PERIOD');
    // ... which the transactions column, grouped on its own, never does: the statement reads whole.
    assert.equal(parseDiscoverStatement(pages).layout, 'B');
    assert.equal(looksLikeDiscoverStatement(pages), true);
    assert.equal(looksLikeDiscoverStatement([{ items: [{ text: 'Statement Period Date: 9/1/2026 - 9/30/2026', x: 400, y: 760, width: 180 }] }]), false);
  });

  it('reads layout B: the card, the period, the summary and every row in exact cents', () => {
    const parsed = parseDiscoverStatement(pagesOf(layoutB(JANUARY)));
    assert.equal(parsed.layout, 'B');
    assert.equal(parsed.last4, SYNTHETIC_LAST4);
    assert.deepEqual(parsed.period, { start: '2020-01-12', end: '2020-02-11' });
    assert.equal(parsed.billingDays, 31);
    assert.deepEqual(parsed.summary, {
      previousBalanceMinor: 1734, paymentsAndCreditsMinor: 1734, purchasesMinor: 3550, balanceTransfersMinor: 0, cashAdvancesMinor: 0, feesMinor: 0,
      interestMinor: 0, newBalanceMinor: 3550,
    });
    assert.equal(parsed.noActivity, false);
    assert.deepEqual(parsed.rows.map((row) => [row.section, row.transactionDate, row.postedDate, row.amountMinor, row.description, row.category]), [
      ['credits', '2020-01-20', null, -1734, 'DIRECTPAY FULL BALANCE SEE DETAILS OF YOUR NEXT DIRECTPAY BELOW', null],
      // A charge made before the period that posted in it keeps its own date.
      ['purchases', '2020-01-02', null, 1250, 'CONTOSO COFFEE', 'Restaurants'],
      ['purchases', '2020-01-15', null, 2300, 'FABRIKAM MARKET #123 SEATTLE WA', 'Supermarkets'],
    ]);
    assert.ok(parsed.rows.every((row) => row.sourceTexts.includes(row.description)));
    // Prose that merely contains the words is no printing of the card's ending ("pending in").
    const prose = parseDiscoverStatement(pagesOf(edited(layoutB(JANUARY), (pages) => pages[1].push([18, 600, 'Payments pending in your account show later.']))));
    assert.equal(prose.last4, SYNTHETIC_LAST4);
  });

  it('reads layout A: month-name dates, operators apart from their amounts, two dates per row and their category', () => {
    const parsed = parseDiscoverStatement(pagesOf(layoutA(DECEMBER)));
    assert.equal(parsed.layout, 'A');
    assert.deepEqual(parsed.period, { start: '2019-12-12', end: '2020-01-11' });
    assert.equal(parsed.billingDays, 31);
    assert.deepEqual([parsed.summary.previousBalanceMinor, parsed.summary.paymentsAndCreditsMinor, parsed.summary.purchasesMinor, parsed.summary.newBalanceMinor],
      [2500, 2500, 1734, 1734]);
    assert.deepEqual(parsed.rows.map((row) => [row.section, row.transactionDate, row.postedDate, row.amountMinor, row.description, row.category]), [
      ['credits', '2019-12-20', '2019-12-20', -2500, 'INTERNET PAYMENT - THANK YOU', null],
      ['purchases', '2019-12-28', '2019-12-30', 1734, 'SAMPLE BOOKS #12 800-555-0100 WA', 'Merchandise'],
    ]);
  });

  it('reads statements without activity in layouts B and C, and a credit balance', () => {
    const quiet = parseDiscoverStatement(pagesOf(layoutB({ open: '2020-02-12', close: '2020-03-11', previousMinor: -1250 })));
    assert.deepEqual([quiet.layout, quiet.noActivity, quiet.rows.length, quiet.billingDays], ['B', true, 0, 29]);
    assert.deepEqual([quiet.summary.previousBalanceMinor, quiet.summary.newBalanceMinor], [-1250, -1250]);
    const c = parseDiscoverStatement(pagesOf(layoutC({ open: '2026-05-25', close: '2026-06-27', previousMinor: 0 })));
    assert.deepEqual([c.layout, c.noActivity, c.rows.length, c.billingDays, c.period.end], ['C', true, 0, 34, '2026-06-27']);
    assert.equal(c.summary.balanceTransfersMinor, 0);
  });

  it('dates rows of a period that runs into a new year in the right year', () => {
    const b = parseDiscoverStatement(pagesOf(layoutB({
      open: '2020-12-12', close: '2021-01-11', previousMinor: 0,
      purchases: [{ date: '12/10', description: 'CONTOSO COFFEE', category: 'Restaurants', minor: 1250 }, { date: '01/02', description: 'FABRIKAM MARKET', category: 'Supermarkets', minor: 2300 }],
    })));
    assert.deepEqual(b.rows.map((row) => row.transactionDate), ['2020-12-10', '2021-01-02']);
    const a = parseDiscoverStatement(pagesOf(layoutA({ ...DECEMBER, purchases: [{ ...DECEMBER.purchases![0], date: 'Jan 02', posted: 'Jan 03' }] })));
    assert.deepEqual(a.rows.map((row) => [row.transactionDate, row.postedDate]), [['2019-12-20', '2019-12-20'], ['2020-01-02', '2020-01-03']]);
  });

  describe('refuses, naming what failed and never a value', () => {
    it('a row it could not read, or one left out', () => {
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => dropLine(pages, 'CONTOSO COFFEE')), 'reconciliation'),
        /purchases do not add up to the Account Summary's Purchases; a row was not read/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, '$12.50', '$12.5O')), 'layout'), /^page 3 line \d+: a row's amount is not one whole amount$/);
      assert.match(refusal(edited(layoutA(DECEMBER), (pages) => dropLine(pages, 'INTERNET PAYMENT - THANK YOU')), 'reconciliation'),
        /rows under Payments and Credits do not add up/);
      // A figure read as the prefix of a longer one is no figure (still right-aligned under AMOUNT).
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => {
        const amount = cellOf(pages, '$23.00');
        amount[2] = '$23.001';
        amount[0] -= 5.004;
      }), 'layout'), /a row's amount is not one whole amount/);
    });

    it('a summary that does not add up, or that it cannot read whole', () => {
      // The Previous Balance is printed once: changing it breaks only the balance equation. (A New Balance changed in the
      // summary alone now disagrees with its printing on the payment coupon first.)
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, '$17.34', '$17.35')), 'reconciliation'),
        /Previous Balance - Payments and Credits \+ Purchases \+ fees and interest is not the New Balance/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, '$35.50', '$35.51')), 'layout'), /prints New Balance again with another amount/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, '+$35.50', '+$35.50 USD')), 'layout'), /Account Summary's Purchases is not one whole amount/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => dropLine(pages, 'Cash Advances')), 'layout'), /has no Cash Advances line/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[0].push([38, 600, 'Rewards Earned'], [240, 600, '$1.00'])), 'layout'),
        /an Account Summary line this reader does not know/);
      // A label is looked up in its own table only: no object's built-in property passes for one.
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[0].push([38, 600, 'constructor'], [240, 600, '$1.00'])), 'layout'),
        /an Account Summary line this reader does not know/);
    });

    it('a sign it would have to guess', () => {
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, '-$17.34', '$17.34')), 'sign'), /Payments and Credits is not signed -/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, '+$35.50', '-$35.50')), 'sign'), /Purchases is signed -, but it adds/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, '$12.50', '-$12.50')), 'sign'), /a purchase is signed -/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, '-$17.34', '$17.34', 1)), 'sign'), /a row under Payments and Credits is not signed -/);
      // Layout A: one operator per component, none beside a balance, never one stuck to the amount as well.
      assert.match(refusal(edited(layoutA(DECEMBER), (pages) => replace(pages, '-', '+')), 'sign'), /Payments and Credits is not signed -/);
      assert.match(refusal(edited(layoutA(DECEMBER), (pages) => {
        const operator = cellOf(pages, '-');
        pages[0].splice(pages[0].indexOf(operator), 1);
      }), 'sign'), /Payments and Credits does not have exactly one sign/);
      assert.match(refusal(edited(layoutA(DECEMBER), (pages) => pages[0].push([166.3, 656.4, '+'])), 'sign'), /an operator beside Previous Balance/);
      // The second $17.34 of page 1 is the Purchases amount (the first is Payment Information's New Balance).
      assert.match(refusal(edited(layoutA(DECEMBER), (pages) => replace(pages, '$17.34', '+$17.34', 1)), 'sign'), /Purchases does not have exactly one sign/);
      assert.match(refusal(edited(layoutA(DECEMBER), (pages) => replace(pages, '-25.00', '25.00')), 'sign'), /a row under Payments and Credits is not signed -/);
    });

    it('a row outside the columns its heading prints', () => {
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => {
        cellOf(pages, '$23.00')[0] -= 30;
      }), 'layout'), /a row's amount does not stand in the AMOUNT column/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => {
        cellOf(pages, 'CONTOSO COFFEE')[0] += 20;
      }), 'layout'), /a row's description does not start in its column/);
      assert.match(refusal(edited(layoutA(DECEMBER), (pages) => {
        cellOf(pages, 'Dec 30')[0] += 20;
      }), 'layout'), /a row's post date is not in the Post Date column/);
    });

    it('a line with a date or an amount that is no row, inside the transactions or anywhere else', () => {
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[2].push([150, 560.5, 'ADJ 9.99'])), 'layout'),
        /a line of the transactions holds a date or an amount but is not a row/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[1].push([18, 600, '01/22 SAMPLE STORE'], [380, 600, '$9.99'])), 'layout'),
        /^page 2 line \d+: a line outside the transactions holds a transaction date and an amount$/);
      assert.match(refusal(edited(layoutA(DECEMBER), (pages) => pages[3].push([38, 600, 'Merchandise'], [155.3, 600, 'Dec 29'], [505.8, 600, '$'], [570, 600, '9.99'])), 'layout'),
        /a line outside the transactions holds a transaction date and an amount/);
    });

    it('a date or an amount under a row, where a wrapped description or category stands (review F255-1)', () => {
      const under = (layout: Cell[][], description: string, x: number | null, text: string) => edited(layout, (pages) => {
        const row = cellOf(pages, description);
        pages[2].push([x ?? row[0], row[1] - 5, text]);
      });
      for (const [x, text] of [[80, 'UNREAD ADJUSTMENT $999.99'], [80, '01/20 UNREAD ADJUSTMENT $999.99'], [256.5, 'UNREAD ADJUSTMENT $999.99'],
        [80, 'UNREAD ADJUSTMENT 999.99'], [80, 'REFERENCE 01/20']] as const) {
        assert.match(refusal(under(layoutB(JANUARY), 'CONTOSO COFFEE', x, text), 'layout'), /a line of the transactions holds a date or an amount but is not a row/, text);
      }
      assert.match(refusal(under(layoutA(DECEMBER), 'SAMPLE BOOKS #12', null, 'UNREAD ADJUSTMENT $999.99'), 'layout'),
        /a line of the transactions holds a date or an amount but is not a row/);
      // A wrapped line without a date or an amount is still the row's description.
      const wrapped = parseDiscoverStatement(pagesOf(under(layoutB(JANUARY), 'CONTOSO COFFEE', 80, 'STORE 0042 SEATTLE WA')));
      assert.equal(wrapped.rows[1].description, 'CONTOSO COFFEE STORE 0042 SEATTLE WA');
    });

    it('a row beside the transactions, in the Cashback Bonus column (review F255-1)', () => {
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[2].push([430, 620, '01/20'], [460, 620, 'UNREAD ROW'], [555, 620, '$999.99'])), 'layout'),
        /^page 3, line \d+ of the Cashback Bonus column: a line beside the transactions holds a transaction date and an amount$/);
    });

    it('a summary figure printed again with another amount (review F255-1)', () => {
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[0].push([38, 565, 'Purchases'], [230, 565, '+$999.99'])), 'layout'),
        /the statement prints Purchases again with another amount/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[0].push([38, 565, 'Purchases'], [230, 565, '$35.50 or more'])), 'layout'),
        /a line names Purchases with a date or an amount that is not one whole amount/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[1].push([18, 600, 'New Balance:'], [230, 600, '$999.99'])), 'layout'),
        /the statement prints New Balance again with another amount/);
      assert.match(refusal(edited(layoutA(DECEMBER), (pages) => replace(pages, '$17.34', '$71.34')), 'layout'),
        /the statement prints New Balance again with another amount/);
      // Above the Account Summary, too.
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[0].push([38, 720, 'Purchases'], [230, 720, '+$999.99'])), 'layout'),
        /^page 1 line \d+: the statement prints Purchases again with another amount or sign$/);
      // Under its label: the Payment Information box (B, C) and layout C's coupon; beside it: layout B's coupon.
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, '35.50', '53.50')), 'layout'), /the statement prints New Balance again with another amount/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, '35.50', '53.50', 1)), 'layout'), /the statement prints New Balance again with another amount/);
      const quiet = layoutC({ open: '2026-05-25', close: '2026-06-27', previousMinor: 0 });
      for (const [x, y] of [[288, 679.7], [32, 70]]) {
        assert.match(refusal(edited(quiet, (pages) => (pages[0].find((cell) => cell[0] === x && cell[1] === y)![2] = '$9.99')), 'layout'),
          /the statement prints New Balance again with another amount/, `${x},${y}`);
      }
      // On a later page: a line that starts with a summary label and holds an amount is one label and one amount.
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[3].push([38, 420, 'Purchases'], [230, 420, '+$35.50 adjusted'])), 'layout'),
        /^page 4 line \d+: a line names Purchases with a date or an amount that is not one whole amount$/);
      // A row of the Interest Charge Calculation (its label, then an APR) is no printing of the summary's figure, where
      // the table runs on under its heading; anywhere else, it is held to the rule.
      const row: Cell[] = [[38, 400, 'Cash Advances'], [150, 400, '25.24%'], [213, 400, '(v)'], [276, 400, '$0.00'], [385, 400, '$0.00']];
      assert.equal(parseDiscoverStatement(pagesOf(edited(layoutB(JANUARY), (pages) => pages[3].push([38, 420, 'Interest Charge Calculation continued'], ...row)))).layout, 'B');
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[3].push(...row)), 'layout'),
        /^page 4 line \d+: a line names Cash Advances with a date or an amount that is not one whole amount$/);
      // Printed again with the same amount, it is the same figure.
      assert.equal(parseDiscoverStatement(pagesOf(edited(layoutB(JANUARY), (pages) => pages[0].push([38, 565, 'Purchases'], [230, 565, '+$35.50'])))).layout, 'B');
    });

    it('a summary figure printed again with another sign: its signed figure must be the summary\'s (review F255-1a)', () => {
      const push = (line: Cell[]) => edited(layoutB(JANUARY), (pages) => pages[0].push(...line));
      // The New Balance is $35.50 owed: printed again as a credit balance, it contradicts the summary.
      assert.match(refusal(push([[38, 565, 'New Balance'], [230, 565, '-$35.50']]), 'layout'), /^page 1 line \d+: the statement prints New Balance again with another amount or sign$/);
      // Payments and Credits come off the balance and a charge adds to it: printed again the other way, each is refused.
      assert.match(refusal(push([[38, 565, 'Payments and Credits'], [230, 565, '+$17.34']]), 'sign'), /Payments and Credits is not signed -/);
      assert.match(refusal(push([[38, 565, 'Purchases'], [230, 565, '-$35.50']]), 'sign'), /Purchases is signed -, but it adds to the balance/);
      assert.match(refusal(push([[38, 565, 'New Balance'], [230, 565, '+$35.50']]), 'sign'), /New Balance is signed \+/);
      // Signed as the summary signs them, or unsigned as the coupon prints a balance, they are the same figures.
      for (const line of [[[38, 565, 'Payments and Credits'], [230, 565, '-$17.34']], [[38, 565, 'New Balance'], [230, 565, '$35.50']]] as Cell[][]) {
        assert.equal(parseDiscoverStatement(pagesOf(push(line))).layout, 'B', line[1][2]);
      }
      // A credit balance is the same figure printed -$ or unsigned, never +$ or owed.
      const credit = { open: '2021-06-12', close: '2021-07-11', previousMinor: -500 };
      assert.equal(parseDiscoverStatement(pagesOf(edited(layoutB(credit), (pages) => pages[0].push([38, 565, 'New Balance'], [230, 565, '-$5.00'])))).summary.newBalanceMinor, -500);
      assert.equal(parseDiscoverStatement(pagesOf(edited(layoutB(credit), (pages) => pages[0].push([38, 565, 'New Balance'], [230, 565, '5.00'])))).layout, 'B');
      assert.match(refusal(edited(layoutB(credit), (pages) => pages[0].push([38, 565, 'New Balance'], [230, 565, '+$5.00'])), 'sign'), /New Balance is signed \+/);
      // An operator set apart from a figure printed again, as layout A signs its summary, leaves its sign unread.
      assert.match(refusal(push([[38, 565, 'Purchases'], [225, 567.4, '-'], [230, 565, '$35.50']]), 'sign'),
        /^page 1 line \d+: an operator set apart beside Purchases printed again leaves its sign unread$/);
      assert.match(refusal(edited(layoutA(DECEMBER), (pages) => pages[0].push([540, 656.9, '-'])), 'sign'),
        /an operator set apart beside New Balance printed again leaves its sign unread/);
    });

    it('a summary label wherever its line holds it, however the line\'s items were cut (review F255-1b)', () => {
      const push = (line: Cell[]) => edited(layoutB(JANUARY), (pages) => pages[0].push(...line));
      // One item holding the label and the amount; a label after other words; two printings on one line.
      for (const line of [[[38, 565, 'Purchases +$999.99']], [[38, 565, 'Statement Purchases +$999.99']], [[38, 565, 'Purchases +$35.50 Purchases +$999.99']],
        [[38, 565, 'Purchases'], [230, 565, '+$35.50 +$999.99']]] as Cell[][]) {
        assert.match(refusal(push(line), 'layout'), /^page 1 line \d+: (?:the statement prints Purchases again with another amount or sign|a line names Purchases with a date or an amount that is not one whole amount)$/,
          line.map((cell) => cell[2]).join(' | '));
      }
      // The same figure in one item is the same figure; a word that only begins with a label is no label.
      assert.equal(parseDiscoverStatement(pagesOf(push([[38, 565, 'Purchases +$35.50']]))).layout, 'B');
      assert.equal(parseDiscoverStatement(pagesOf(push([[38, 565, 'PurchasesX +$999.99']]))).layout, 'B');
      assert.equal(parseDiscoverStatement(pagesOf(push([[38, 565, 'XPurchases +$999.99']]))).layout, 'B');
      // Items set with no gap join with no space: the label is still read, whatever touches it but a letter.
      for (const line of [[[38, 565, 'Purchases+$999.99']], [[38, 565, 'Purchases'], [38 + helveticaWidth('Purchases'), 565, '+$999.99']],
        [[38, 565, '(Purchases)'], [120, 565, '+$999.99']]] as Cell[][]) {
        assert.match(refusal(push(line), 'layout'), /^page 1 line \d+: (?:the statement prints Purchases again with another amount or sign|a line names Purchases with a date or an amount that is not one whole amount)$/,
          line.map((cell) => cell[2]).join(' | '));
      }
      // Under a label that shares its item with other headings, the box's figure is still compared.
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => {
        const labels = pages[0].filter((cell) => cell[1] === 664.5 || cell[1] === 664.8);
        for (const cell of labels) pages[0].splice(pages[0].indexOf(cell), 1);
        pages[0].push([307, 664.5, 'New Balance Minimum Payment Payment Due Date']);
        replace(pages, '35.50', '53.50');
      }), 'layout'), /the statement prints New Balance again with another amount or sign/);
    });

    it('a date or an amount in a row\'s own description or category (review F255-1)', () => {
      const [coffee, market] = JANUARY.purchases!;
      for (const purchase of [{ ...coffee, description: 'CONTOSO COFFEE $9.99' }, { ...coffee, description: 'CONTOSO COFFEE 9.99' },
        { ...coffee, description: 'CONTOSO 01/20 COFFEE' }, { ...coffee, category: 'Restaurants 9.99' }]) {
        assert.match(refusal(layoutB({ ...JANUARY, purchases: [purchase, market] }), 'layout'),
          /^page 3 line \d+: a row's description or category holds a date or an amount$/, JSON.stringify(purchase));
      }
      assert.match(refusal(layoutA({ ...DECEMBER, purchases: [{ ...DECEMBER.purchases![0], description: 'SAMPLE BOOKS $9.99' }] }), 'layout'),
        /^page 3 line \d+: a row's description holds a date or an amount$/);
    });

    it('the same row twice, even when the totals count both (review F255-4)', () => {
      const twice = { ...JANUARY, credits: [], previousMinor: 0, purchases: [JANUARY.purchases![0], JANUARY.purchases![0]] };
      assert.match(refusal(layoutB(twice), 'duplicate'), /^page 3 line \d+ and page 3 line \d+ print the same row: two identical charges cannot be told from one row printed twice$/);
      assert.match(refusal(layoutA({ ...DECEMBER, purchases: [DECEMBER.purchases![0], DECEMBER.purchases![0]] }), 'duplicate'), /print the same row/);
    });

    it('a period, a billing period or a card ending that does not agree with itself', () => {
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, 'OPEN TO CLOSE DATE: 01/12/2020 - 02/11/2020', 'OPEN TO CLOSE DATE: 01/12/2020 - 02/12/2020')),
        'layout'), /prints two different periods/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, 'BILLING PERIOD: 31 DAYS', 'BILLING PERIOD: 30 DAYS')), 'layout'),
        /billing period's length is not the number of days/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, 'OPEN TO CLOSE DATE: 01/12/2020 - 02/11/2020', 'OPEN TO CLOSE DATE: 01/12/2020 to 02/11/2020')),
        'layout'), /statement period is not printed as two whole dates/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, `ACCOUNT NUMBER ENDING IN ${SYNTHETIC_LAST4}`, 'ACCOUNT NUMBER ENDING IN 4321')), 'layout'),
        /two different card endings/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, `ACCOUNT NUMBER ENDING IN ${SYNTHETIC_LAST4}`, `ACCOUNT NUMBER ENDING IN ${SYNTHETIC_LAST4}0`)),
        'layout'), /a printing of the card's ending is not its last four digits alone/);
      // Every printing on a line, not only its first (review F255-5).
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[1].push([18, 600, `Account number ending in ${SYNTHETIC_LAST4} Account number ending in 4242`])),
        'layout'), /two different card endings/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[1].push([18, 600, `Account number ending in ${SYNTHETIC_LAST4} Account number ending in 42X2`])),
        'layout'), /a printing of the card's ending is not its last four digits alone/);
      const period = 'OPEN TO CLOSE DATE: 01/12/2020 - 02/11/2020';
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, period, `${period} OPEN TO CLOSE DATE: 02/12/2020 - 03/11/2020`)), 'layout'),
        /prints two different periods/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, period, `${period} OPEN TO CLOSE DATE: soon`)), 'layout'),
        /statement period is not printed as two whole dates/);
      const longForm = (pages: Cell[][]) => pages[0].find((cell) => cell[2].startsWith('Open Date:'))!;
      assert.match(refusal(edited(layoutA(DECEMBER), (pages) => (longForm(pages)[2] += ' Open Date: Jan 12, 2020 - Close Date: Feb 11, 2020')), 'layout'),
        /prints two different periods/);
      assert.match(refusal(edited(layoutA(DECEMBER), (pages) => (longForm(pages)[2] += ' Close Date: Feb 11, 2020')), 'layout'),
        /statement period is not printed as two whole dates/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, 'BILLING PERIOD: 31 DAYS', 'BILLING PERIOD: 31 DAYS BILLING PERIOD: 30 DAYS')), 'layout'),
        /two different billing period lengths/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, 'BILLING PERIOD: 31 DAYS', 'BILLING PERIOD: 31 DAYS BILLING PERIOD: 30')), 'layout'),
        /the billing period is not a whole number of days/);
      // A period wording in another case still counts, and nothing reads it whole.
      for (const wording of ['open to close date: 02/12/2020 - 03/11/2020', 'Open Date: soon', 'CLOSE DATE: FEB 11, 2020']) {
        assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[1].push([18, 600, wording])), 'layout'), /statement period is not printed as two whole dates/, wording);
      }
    });

    it('activity this reader has not seen: fees, interest, other sections, a list that runs onto another page', () => {
      // Balance Transfers, Cash Advances, Fees Charged, Interest Charged: the third +$0.00 is Fees Charged.
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => replace(pages, '+$0.00', '+$1.00', 2)), 'unsupported'),
        /charges Fees Charged, whose rows this reader has not seen/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[2].push([38, 570, 'DATE'], [80, 570, 'BALANCE TRANSFERS'], [366.4, 570, 'AMOUNT'])), 'unsupported'),
        /a transactions heading this reader does not know/);
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => {
        const calculation = cellOf(pages, 'Interest Charge Calculation');
        pages[2].splice(pages[2].indexOf(calculation), 1);
        pages[3].push([43, 700, 'Interest Charge Calculation']);
      }), 'unsupported'), /run onto another page/);
    });

    it('a statement that says it has no activity but prints rows, or the other way round', () => {
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => pages[2].push([38, 560, 'NO ACTIVITY FOR THIS BILLING PERIOD'])), 'layout'), /no activity but prints rows/);
      assert.match(refusal(edited(layoutB({ open: '2020-02-12', close: '2020-03-11', previousMinor: 0 }), (pages) => dropLine(pages, 'NO ACTIVITY FOR THIS BILLING PERIOD')),
        'layout'), /prints no rows and does not say it has no activity/);
    });

    it('a row dated outside its period', () => {
      assert.match(refusal(layoutB({ ...JANUARY, purchases: [{ ...JANUARY.purchases![0], date: '06/15' }, JANUARY.purchases![1]] }), 'layout'),
        /a row's date is not in or shortly before the statement period/);
      assert.match(refusal(layoutA({ ...DECEMBER, purchases: [{ ...DECEMBER.purchases![0], posted: 'Jan 15' }] }), 'layout'), /post date is not in the statement period/);
      assert.match(refusal(layoutA({ ...DECEMBER, purchases: [{ ...DECEMBER.purchases![0], date: 'Jan 02', posted: 'Dec 30' }] }), 'layout'),
        /transaction date is not on or shortly before its post date/);
    });

    it('a Cashback Bonus box that does not stand right of the transactions', () => {
      assert.match(refusal(edited(layoutB(JANUARY), (pages) => {
        cellOf(pages, 'PREVIOUS BALANCE')[0] = 300;
      }), 'layout'), /the Cashback Bonus box does not stand right of the transactions/);
    });

    it('anything that is not a Discover statement', () => {
      assert.match(refusal([], 'not-a-statement'), /no text/);
      assert.match(refusal([[[400, 760, 'Fifth Third Bank'], [400, 746, 'Statement Period Date: 9/1/2026 - 9/30/2026']]], 'not-a-statement'),
        /no page names a Discover it card/);
    });
  });
});
