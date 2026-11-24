import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { checkingDayKeys } from '../checkingImport.js';
import { detectCheckingExportAdapters } from './adapters.js';
import { convertCheckingExports } from './convert.js';
import { parseFifthThirdCsv } from './fifthThirdCsv.js';
import {
  describeFifthThirdStatementLayout,
  FIFTH_THIRD_STATEMENT_SOURCE,
  fifthThirdStatementAdapter,
  parseFifthThirdStatement,
  statementLines,
} from './fifthThirdStatement.js';
import { CheckingExportFormatError, type CheckingPdfPage, type ParsedCheckingRow } from './parsed.js';

type Cell = [number, number, string];
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/fifththird/${name}`, import.meta.url)), 'utf8');
const LAYOUT = JSON.parse(fixture('statement-2026-09.layout.json')) as { pages: Cell[][] };

/** pdf.js-like items: Helvetica 9 pt is about 4.5 points per character. */
function pagesOf(pages: Cell[][]): CheckingPdfPage[] {
  return pages.map((cells) => ({ items: cells.map(([x, y, text]) => ({ text, x, y, width: text.length * 4.5 })) }));
}
const statement = () => pagesOf(LAYOUT.pages);
/** The layout with `edit` applied to a copy of its pages. */
function edited(edit: (pages: Cell[][]) => void): CheckingPdfPage[] {
  const pages = LAYOUT.pages.map((cells) => cells.map((cell) => [...cell] as Cell));
  edit(pages);
  return pagesOf(pages);
}
const cellAt = (pages: Cell[][], text: string) => {
  for (const cells of pages) {
    const index = cells.findIndex((cell) => cell[2] === text);
    if (index !== -1) return { cells, index };
  }
  throw new Error(`no cell ${text}`);
};
/** Removes every cell of the line that `text` is on. */
const dropLine = (pages: Cell[][], text: string) => {
  const { cells, index } = cellAt(pages, text);
  const y = cells[index][1];
  for (let i = cells.length - 1; i >= 0; i -= 1) if (cells[i][1] === y) cells.splice(i, 1);
};
const replaceText = (pages: Cell[][], from: string, to: string) => {
  const { cells, index } = cellAt(pages, from);
  cells[index][2] = to;
};

const FIXTURE_VALUES = ['CONTOSO', 'GROCERY', 'CHASE', '2,500.00', '2,532.57', '1,234.56', '2,917.55', '3,200.12', '4321', '9876', '1042'];
function refusal(pages: CheckingPdfPage[]): string {
  try {
    parseFifthThirdStatement(pages);
  } catch (error) {
    assert.ok(error instanceof CheckingExportFormatError, String(error));
    for (const value of FIXTURE_VALUES) assert.ok(!error.message.includes(value), `shows ${value}: ${error.message}`);
    return error.message;
  }
  assert.fail('expected the statement to be refused');
}

const dayAmounts = (rows: readonly ParsedCheckingRow[]) => rows.map((row) => [row.postedDate, row.amountMinor]);

describe('Fifth Third statement PDF', () => {
  it('assembles lines from positioned text, top to bottom and left to right', () => {
    const lines = statementLines(statement());
    assert.equal(lines[0].text, 'Fifth Third Bank Statement Period Date: 9/1/2026 - 9/30/2026');
    assert.ok(lines.some((line) => line.text === '09/02 1,234.56 WEB INITIATED PAYMENT AT CHASE CREDIT CRD EPAY'));
    // pdf.js may hand over every character apart: they still make one line, spaced where they stand apart.
    const spelled = [...'09/15 0.12'].map((char, index) => ({ text: char, x: 50 + index * 4.5, y: 100, width: 4.5 }));
    assert.equal(statementLines([{ items: spelled }])[0].text, '09/15 0.12');
  });

  it('reads the period, the account, the summary and every row in exact cents', () => {
    const parsed = parseFifthThirdStatement(statement());
    assert.equal(parsed.source, FIFTH_THIRD_STATEMENT_SOURCE);
    assert.equal(parsed.institution, 'fifththird');
    assert.equal(parsed.accountLast4, '4321');
    assert.equal(parsed.accountType, 'CHECKING');
    assert.deepEqual(parsed.coverage, { start: '2026-09-01', end: '2026-09-30' });
    assert.deepEqual(parsed.statement, { openingBalanceMinor: 250000, closingBalanceMinor: 253257, depositsMinor: 320012, withdrawalsMinor: 316755 });
    assert.deepEqual(dayAmounts(parsed.rows), [
      ['2026-09-01', 320000], ['2026-09-01', -10000], ['2026-09-02', -123456], ['2026-09-02', -98765], ['2026-09-03', -25000],
      ['2026-09-03', -4217], ['2026-09-03', -4217], ['2026-09-08', -50000], ['2026-09-15', 12], ['2026-09-30', -1100],
    ]);
    assert.deepEqual(parsed.problems, []);
    const check = parsed.rows.find((row) => row.checkNumber !== null)!;
    assert.deepEqual([check.checkNumber, check.amountMinor, check.typeHint], ['1042', -25000, 'CHECK']);
    // A wrapped description joins its row.
    assert.equal(parsed.rows[2].description, 'WEB INITIATED PAYMENT AT CHASE CREDIT CRD EPAY PPD ID: 0000000000');
    // Only each day's last row carries the day's ending balance.
    assert.deepEqual(parsed.rows.map((row) => row.runningBalanceMinor), [null, 560000, null, 337779, null, null, 304345, 254345, 254357, 253257]);
    assert.ok(parsed.rows.every((row) => row.sourceTexts.includes('XXXXXX4321')));
  });

  it('gives the same days, amounts and keys as the activity download of the same month', () => {
    const fromPdf = parseFifthThirdStatement(statement()).rows;
    const fromCsv = parseFifthThirdCsv(fixture('activity.csv')).parsed.rows;
    const keys = (rows: readonly ParsedCheckingRow[]) => [...new Set(rows.map((row) => row.postedDate))]
      .map((date) => checkingDayKeys(rows.filter((row) => row.postedDate === date)).sort());
    assert.deepEqual([...dayAmounts(fromPdf)].sort(), [...dayAmounts(fromCsv)].sort());
    assert.deepEqual(keys(fromPdf), keys(fromCsv));
  });

  it('dates rows of a period that runs into a new year in the right year', () => {
    const pages = edited((cells) => {
      replaceText(cells, 'Statement Period Date: 9/1/2026 - 9/30/2026', 'Statement Period Date: 12/16/2026 - 1/15/2027');
      replaceText(cells, 'Statement Period Date: 9/1/2026 - 9/30/2026', 'Statement Period Date: 12/16/2026 - 1/15/2027');
      for (const [from, to] of [['09/01', '12/20'], ['09/02', '12/31'], ['09/03', '01/02'], ['09/08', '01/05'], ['09/15', '01/09'], ['09/30', '01/15']]) {
        for (const page of cells) for (const cell of page) if (cell[2] === from) cell[2] = to;
      }
    });
    const parsed = parseFifthThirdStatement(pages);
    assert.deepEqual(parsed.coverage, { start: '2026-12-16', end: '2027-01-15' });
    assert.deepEqual([...new Set(parsed.rows.map((row) => row.postedDate))], ['2026-12-20', '2026-12-31', '2027-01-02', '2027-01-05', '2027-01-09', '2027-01-15']);
  });

  describe('refuses, naming what failed and never a value', () => {
    it('a statement with a row it could not read', () => {
      assert.match(refusal(edited((pages) => dropLine(pages, 'AMEX EPAYMENT ACH PMT'))), /counts 7 Withdrawals \/ Debits but 6 rows were read/);
      assert.match(refusal(edited((pages) => replaceText(pages, '987.65', '987.6S'))), /line \d+: a Withdrawals \/ Debits row could not be read/);
    });

    it('a figure read as the prefix of a longer one (review: "$2,500.001" was read as 2,500.00)', () => {
      assert.match(refusal(edited((pages) => replaceText(pages, '$2,500.00', '$2,500.001'))), /Beginning Balance is not one whole amount/);
      assert.match(refusal(edited((pages) => replaceText(pages, '$2,532.57', '$2,532.570'))), /Ending Balance is not one whole amount/);
      assert.match(refusal(edited((pages) => replaceText(pages, '-2,917.55', '-2,917.551'))), /line \d+: an Account Summary line is not a count and one whole amount/);
      assert.match(refusal(edited((pages) => replaceText(pages, '7 items totaling $2,917.55', '7 items totaling $2,917.551'))), /heading's count and total are not a number and one whole amount/);
      assert.match(refusal(edited((pages) => {
        for (const page of pages) for (const cell of page) if (cell[2] === 'Statement Period Date: 9/1/2026 - 9/30/2026') cell[2] = 'Statement Period Date: 9/1/2026 - 9/30/20261';
      })), /statement period is not two MM\/DD\/YYYY dates/);
      assert.match(refusal(edited((pages) => {
        for (const page of pages) for (const cell of page) if (cell[2] === 'Statement Period Date: 9/1/2026 - 9/30/2026') cell[2] = 'Statement Period Date: 9/1/2026 - 9/30/2026X';
      })), /statement period is not two MM\/DD\/YYYY dates/);
    });

    it('reads the period and the account number as whole tokens, never a prefix (review F19, F20)', () => {
      const period = (to: string) => edited((pages) => {
        for (const page of pages) for (const cell of page) if (cell[2] === 'Statement Period Date: 9/1/2026 - 9/30/2026') cell[2] = to;
      });
      for (const end of ['9/30/2026-1', '9/30/2026+1', '9/30/2026.1', '9/30/2026/1']) {
        assert.match(refusal(period(`Statement Period Date: 9/1/2026 - ${end}`)), /line \d+: the statement period is not two MM\/DD\/YYYY dates/, end);
      }
      assert.match(refusal(period('Statement Period Date: 9/1/2026-1 - 9/30/2026')), /statement period is not two MM\/DD\/YYYY dates/);
      assert.deepEqual(parseFifthThirdStatement(period('Statement Period Date: 9/1/2026-9/30/2026')).coverage, { start: '2026-09-01', end: '2026-09-30' });
      // An account number with anything stuck to it is refused, never cut back to the prefix that looks like one, so no
      // account is guessed (with or without --account).
      for (const stuck of ['XXXXXX4321-5678X', 'XXXXXX4321X', 'XXXXXX4321 5678', 'XXXXXX4321-']) {
        const pages = edited((cells) => {
          for (const page of cells) for (const cell of page) if (cell[2] === 'Account Number: XXXXXX4321') cell[2] = `Account Number: ${stuck}`;
        });
        assert.match(refusal(pages), /^an account number the statement prints is not one whole number/, stuck);
        assert.throws(() => parseFifthThirdStatement(pages, { accountLast4: '4321' }), /an account number the statement prints is not one whole number/);
      }
      // The Account Summary's title names the account as well, and must name the same one.
      assert.match(refusal(edited((pages) => replaceText(pages, 'Account Summary - XXXXXX4321', 'Account Summary - XXXXXX8765'))), /covers 2 accounts/);
      assert.match(refusal(edited((pages) => replaceText(pages, 'Account Summary - XXXXXX4321', 'Account Summary - XXXXXX4321X'))), /an account number the statement prints is not one whole number/);
      // A label is read wherever it stands on its line: a second account number, or one with something stuck to it,
      // beside other text is refused, never passed over.
      const beside = (cell: Cell) => edited((pages) => pages[0].push(cell));
      assert.equal(parseFifthThirdStatement(beside([50, 732, 'SAMPLE CUSTOMER'])).accountLast4, '4321');
      assert.match(refusal(beside([50, 718, 'Linked Account Number: XXXXXX8765'])), /covers 2 accounts/);
      assert.match(refusal(beside([50, 718, 'SAMPLE CUSTOMER Account Number: XXXXXX4321-5678X'])), /an account number the statement prints is not one whole number/);
      assert.match(refusal(beside([50, 718, 'Checking Account Summary - XXXXXX8765'])), /covers 2 accounts/);
    });

    it('keeps one account identity: whole numbers must agree, and the richest printing is kept (review F22-F24, Root ruling)', () => {
      const printed = (first: string, second: string, title: string) => edited((pages) => {
        let page = 0;
        for (const cells of pages) {
          for (const cell of cells) if (cell[2] === 'Account Number: XXXXXX4321') cell[2] = `Account Number: ${page === 0 ? first : second}`;
          page += 1;
        }
        replaceText(pages, 'Account Summary - XXXXXX4321', `Account Summary - ${title}`);
        replaceText(pages, 'AMEX EPAYMENT ACH PMT', 'TRANSFER REF 9990004321');
      });
      // Two whole numbers sharing their last four are two accounts.
      assert.match(refusal(printed('9990004321', '9990004321', '8880004321')), /covers 2 accounts/);
      assert.match(refusal(printed('9990004321', '99990004321', 'XXXXXX4321')), /covers 2 accounts/);
      assert.match(refusal(printed('XXX0004321', 'XXX1114321', 'XXXXXX4321')), /covers 2 accounts/);
      // The same number whole and masked is one account, kept whole in whichever order the printings come.
      for (const [first, second, title] of [['9990004321', 'XXXXXX4321', 'XXXXXX4321'], ['XXXXXX4321', 'XXXXXX4321', '9990004321'], ['XXXXXX4321', '9990004321', 'XXX0004321']]) {
        const parsed = parseFifthThirdStatement(printed(first, second, title));
        assert.deepEqual([parsed.accountLast4, parsed.accountNumberRaw], ['4321', '9990004321'], `${first} ${second} ${title}`);
        // So a row that shows the whole number is masked in the payload.
        const { payload } = convertCheckingExports([{ name: 'file 1', parsed }], { institution: 'fifththird', label: 'Fifth Third Checking' });
        assert.ok(!JSON.stringify(payload).includes('9990004321'));
        assert.ok(payload.segments[0].rows.some((row) => row.description === 'TRANSFER REF ***4321'));
      }
      // Printings that agree but show different digits prove more together: their union is kept, and every printing is
      // known to the guard, so five consecutive digits only one printing shows are masked too (V07, Root ruling).
      const partial = parseFifthThirdStatement(edited((pages) => {
        for (const page of pages) for (const cell of page) if (cell[2] === 'Account Number: XXXXXX4321') cell[2] = 'Account Number: 999X004321';
        replaceText(pages, 'Account Summary - XXXXXX4321', 'Account Summary - XXX0004321');
        replaceText(pages, 'AMEX EPAYMENT ACH PMT', 'TRANSFER REF 00043');
      }));
      assert.deepEqual([partial.accountLast4, partial.accountNumberRaw, partial.otherAccountNumbersRaw], ['4321', '9990004321', ['999X004321', 'XXX0004321']]);
      const masked = convertCheckingExports([{ name: 'file 1', parsed: partial }], { institution: 'fifththird', label: 'Fifth Third Checking' }).payload;
      assert.ok(masked.segments[0].rows.every((row) => !row.description.replace(/[^0-9]/g, '').includes('00043')));
      // Five consecutive digits that only the two printings together show are masked as well (V08).
      const together = parseFifthThirdStatement(edited((pages) => {
        for (const page of pages) for (const cell of page) if (cell[2] === 'Account Number: XXXXXX4321') cell[2] = 'Account Number: 12X45678';
        replaceText(pages, 'Account Summary - XXXXXX4321', 'Account Summary - XX345678');
        replaceText(pages, 'AMEX EPAYMENT ACH PMT', 'TRANSFER REF 12345');
      }));
      assert.equal(together.accountNumberRaw, '12345678');
      const unioned = convertCheckingExports([{ name: 'file 1', parsed: together }], { institution: 'fifththird', label: 'Fifth Third Checking' }).payload;
      assert.ok(unioned.segments[0].rows.every((row) => !row.description.replace(/[^0-9]/g, '').includes('12345')));
      // The guard reads text fields, never dates: a five-digit account number inside 2026-09-01 is no leak, while the
      // same digits in a description are masked.
      const short = parseFifthThirdStatement(edited((pages) => {
        for (const page of pages) {
          for (const cell of page) {
            if (cell[2] === 'Account Number: XXXXXX4321') cell[2] = 'Account Number: 20260';
            if (cell[2] === 'Account Summary - XXXXXX4321') cell[2] = 'Account Summary - 20260';
          }
        }
        replaceText(pages, 'AMEX EPAYMENT ACH PMT', 'TRANSFER REF 20260');
      }));
      const { payload } = convertCheckingExports([{ name: 'file 1', parsed: short }], { institution: 'fifththird', label: 'Fifth Third Checking' });
      assert.equal(payload.account.last4, '0260');
      assert.equal(payload.segments[0].coverage.start, '2026-09-01');
      assert.ok(payload.segments[0].rows.some((row) => row.description === 'TRANSFER REF ***0260'));
    });

    it('carries the account numbers it read in every later refusal, for the converter\'s guard, never showing them', () => {
      const carried = (pages: CheckingPdfPage[]): readonly string[] => {
        try {
          parseFifthThirdStatement(pages);
        } catch (error) {
          assert.ok(error instanceof CheckingExportFormatError);
          assert.ok(![JSON.stringify(error), inspect(error), error.message].some((shown) => shown.includes('9990004321')));
          return error.accountNumbersRaw;
        }
        assert.fail('expected a refusal');
      };
      const whole = (edit: (pages: Cell[][]) => void) => edited((pages) => {
        for (const page of pages) for (const cell of page) if (cell[2] === 'Account Number: XXXXXX4321') cell[2] = 'Account Number: 9990004321';
        edit(pages);
      });
      assert.ok(carried(whole((pages) => replaceText(pages, '987.65', '987.66'))).includes('9990004321'));
      assert.ok(carried(whole((pages) => { for (const page of pages) for (const cell of page) if (cell[2] === 'Fifth Third Bank') cell[2] = 'Synthetic Other Bank'; })).includes('9990004321'));
      assert.ok(carried(whole((pages) => replaceText(pages, 'Account Summary - XXXXXX4321', 'Account Summary - 9990004321X'))).includes('9990004321'));
      // Identity first: the page-bounds refusal carries it too (V09), and so does every refusal what agreeing printings
      // prove only together (V10, Root ruling 03:37Z).
      assert.ok(carried(whole((pages) => pages[1].push([-0.25, 400, 'SAMPLE']))).includes('9990004321'));
      const partial = (edit: (pages: Cell[][]) => void) => edited((pages) => {
        for (const page of pages) for (const cell of page) if (cell[2] === 'Account Number: XXXXXX4321') cell[2] = 'Account Number: 100X034321';
        replaceText(pages, 'Account Summary - XXXXXX4321', 'Account Summary - XXX0034321');
        edit(pages);
      });
      for (const edit of [(pages: Cell[][]) => replaceText(pages, '1', '10000'), (pages: Cell[][]) => pages[0].push([-0.25, 400, 'SAMPLE'])]) {
        const known = carried(partial(edit));
        assert.ok(known.includes('1000034321') && known.includes('100X034321') && known.includes('XXX0034321'), known.join(' '));
      }
      // A refusal before any account number can be read names no line: fixed labels only.
      assert.equal(refusal(edited((pages) => replaceText(pages, 'Account Summary - XXXXXX4321', 'Account Summary - XXXXXX4321-5678X'))),
        'an account number the statement prints is not one whole number showing its last four digits');
      // Root 04:08Z: every refusal after the identity step is identity-known. A printing that is not one whole number
      // leaves that step unfinished (Root 04:04Z), so its refusal is identity-unknown (the converter then prints the whole
      // run with fixed labels), still carrying every printing for the guard.
      const errorOf = (pages: CheckingPdfPage[]) => {
        try {
          parseFifthThirdStatement(pages);
        } catch (error) {
          assert.ok(error instanceof CheckingExportFormatError);
          return error;
        }
        assert.fail('expected a refusal');
      };
      for (const edit of [
        (pages: Cell[][]) => replaceText(pages, '987.65', '987.66'),
        (pages: Cell[][]) => { for (const page of pages) for (const cell of page) if (cell[2] === 'Fifth Third Bank') cell[2] = 'Synthetic Other Bank'; },
        (pages: Cell[][]) => pages[1].push([-0.25, 400, 'SAMPLE']),
      ]) {
        assert.equal(errorOf(whole(edit)).identityKnown, true);
      }
      const stuck = errorOf(whole((pages) => replaceText(pages, 'Account Summary - XXXXXX4321', 'Account Summary - 9990004321X')));
      assert.equal(stuck.identityKnown, false);
      assert.ok(stuck.accountNumbersRaw.includes('9990004321') && stuck.accountNumbersRaw.includes('9990004321X'), stuck.accountNumbersRaw.join(' '));
    });

    it('a Daily Balance Summary or Checks line it cannot read whole (review: a malformed daily entry was skipped)', () => {
      assert.match(refusal(edited((pages) => replaceText(pages, '3,377.79', '3,377.80X'))), /a Daily Balance Summary line holds something other than dates and balances/);
      assert.match(refusal(edited((pages) => replaceText(pages, '5,600.00', '5,600.0'))), /a Daily Balance Summary line holds something other than dates and balances/);
      assert.match(refusal(edited((pages) => replaceText(pages, '250.00', '250.0O'))), /a Checks line holds something other than check numbers, dates and amounts/);
    });

    it('a count or total printed twice, differently (review: an earlier one was overwritten by a later one)', () => {
      const pages = edited((cells) => {
        const { cells: page, index } = cellAt(cells, 'Account Summary - XXXXXX4321');
        page.splice(index + 1, 0, [90, 693, '8'], [100, 693, 'Withdrawals / Debits'], [250, 693, '-2,917.55']);
      });
      assert.match(refusal(pages), /the Account Summary states two different counts or totals for Withdrawals \/ Debits/);
      const heading = edited((cells) => {
        const { cells: page } = cellAt(cells, 'Withdrawals / Debits - continued');
        const at = page.findIndex((cell) => cell[2] === 'Withdrawals / Debits - continued');
        page.splice(at + 1, 0, [400, 720, '6 items totaling $2,917.55']);
      });
      assert.match(refusal(heading), /the section heading states two different counts or totals for Withdrawals \/ Debits/);
    });

    it('a statement of another bank laid out the same way, even when its format is given (review)', () => {
      const foreign = edited((pages) => {
        for (const page of pages) for (const cell of page) cell[2] = cell[2].replace(/Fifth Third/g, 'Contoso');
      });
      assert.equal(fifthThirdStatementAdapter.detect({ kind: 'pdf', pages: foreign }), false);
      assert.match(refusal(foreign), /does not look like a Fifth Third statement: no page's header or footer band names Fifth Third Bank or 53\.com/);
      assert.throws(() => fifthThirdStatementAdapter.parse({ kind: 'pdf', pages: foreign }, {}), /header or footer band names Fifth Third Bank or 53\.com/);
      // A product name alone is no bank's name: another bank's page may mention a Fifth Third product or payment.
      const productOnly = edited((pages) => {
        for (const page of pages) for (const cell of page) if (cell[2] === 'Fifth Third Bank') cell[2] = 'Contoso Bank';
      });
      assert.equal(fifthThirdStatementAdapter.detect({ kind: 'pdf', pages: productOnly }), false);
      assert.match(refusal(productOnly), /header or footer band names Fifth Third Bank or 53\.com/);
    });

    it('takes the bank only from its header or footers, never from a transaction that names it (review F16)', () => {
      const counterparty = edited((pages) => {
        for (const page of pages) {
          for (const cell of page) {
            if (cell[2] === 'Fifth Third Bank') cell[2] = 'Synthetic Other Bank';
            if (cell[2] === 'Account Type: Fifth Third Momentum Checking') cell[2] = 'Account Type: Synthetic Other Checking';
          }
        }
        replaceText(pages, 'ATM WITHDRAWAL 0901 SAMPLE ST', 'TRANSFER TO Fifth Third Bank');
      });
      assert.ok(statementLines(counterparty).some((line) => line.text.endsWith('TRANSFER TO Fifth Third Bank')));
      assert.equal(fifthThirdStatementAdapter.detect({ kind: 'pdf', pages: counterparty }), false);
      assert.match(refusal(counterparty), /no page's header or footer band names Fifth Third Bank or 53\.com/);
      assert.throws(() => fifthThirdStatementAdapter.parse({ kind: 'pdf', pages: counterparty }, {}), /footer band names Fifth Third Bank/);
      // A wrapped description line naming the bank is transaction text too.
      const wrapped = edited((pages) => {
        for (const page of pages) for (const cell of page) if (cell[2] === 'Fifth Third Bank') cell[2] = 'Synthetic Other Bank';
        replaceText(pages, 'PPD ID: 0000000000', 'FIFTH THIRD BANK 53.COM');
      });
      assert.match(refusal(wrapped), /header or footer band names Fifth Third Bank or 53\.com/);
      // Its own footer band is where the bank speaks too: a statement that names itself only there is read.
      const footerOnly = (y: number) => edited((pages) => {
        for (const page of pages) {
          for (const cell of page) {
            if (cell[2] === 'Fifth Third Bank') cell[2] = 'Synthetic Header';
            if (/^Page \d of 2$/.test(cell[2])) {
              cell[2] = `For more information visit www.53.com ${cell[2]}`;
              cell[1] = y;
            }
          }
        }
      });
      assert.equal(fifthThirdStatementAdapter.detect({ kind: 'pdf', pages: footerOnly(22) }), true);
      assert.equal(parseFifthThirdStatement(footerOnly(22)).rows.length, 10);
      // Above the band it is the page's body, whatever it says.
      assert.match(refusal(footerOnly(60)), /header or footer band names Fifth Third Bank or 53\.com/);
    });

    it('takes its bank from fixed header and footer bands only, never from where its body ends (review F21, F26, F27, Root rulings)', () => {
      const rebrand = (pages: Cell[][]) => {
        for (const page of pages) {
          for (const cell of page) {
            if (cell[2] === 'Fifth Third Bank') cell[2] = 'Synthetic Other Bank';
            if (cell[2] === 'Account Type: Fifth Third Momentum Checking') cell[2] = 'Account Type: Synthetic Other Checking';
          }
        }
      };
      const refused = (pages: CheckingPdfPage[]) => {
        assert.equal(fifthThirdStatementAdapter.detect({ kind: 'pdf', pages }), false);
        assert.match(refusal(pages), /header or footer band names Fifth Third Bank or 53\.com/);
      };
      // A wrapped description that ends like a footer is transaction text, where it stands (F21).
      refused(edited((pages) => {
        rebrand(pages);
        replaceText(pages, 'PPD ID: 0000000000', 'TRANSFER TO Fifth Third Bank Page 1 of 2');
      }));
      // So is one in the footer band but in the Description column, where a wrapped description stands.
      refused(edited((pages) => {
        rebrand(pages);
        pages[0].push([180, 30, 'TRANSFER TO Fifth Third Bank Page 1 of 2']);
      }));
      // A line just below the last row, outside the bands, is the body's (F27); so is one between the rows.
      refused(edited((pages) => {
        rebrand(pages);
        pages[0].push([220, 410, 'TRANSFER TO Fifth Third Bank']);
      }));
      refused(edited((pages) => {
        rebrand(pages);
        pages[0].push([50, 453, 'Fifth Third Bank Page 1 of 2']);
      }));
      // A page without a body has no bands: an extra page naming the bank proves nothing (F26).
      refused(edited((pages) => {
        rebrand(pages);
        pages.push([[50, 760, 'TRANSFER TO Fifth Third Bank']], [[50, 22, 'Fifth Third Bank'], [500, 22, 'Page 3 of 3']]);
      }));
      // Inside a band, a mention of the bank is no identity: a line that reads as a transaction never is (F28).
      for (const cells of [[[50, 750, 'TRANSFER TO Fifth Third Bank']], [[50, 750, 'TRANSFER TO'], [150, 750, 'Fifth Third Bank']],
        [[50, 750, 'TRANSFER TO www.53.com']], [[50, 750, 'ZELLE 53.com']], [[50, 750, 'PAYMENT FROM FIFTH THIRD BANK']]] as Cell[][]) {
        refused(edited((pages) => {
          rebrand(pages);
          pages[0].push(...cells);
        }));
      }
      // Inside a band, outside the Description column, on a page with a body, in the bank's own form: its name heading
      // a line, or its web address.
      for (const cell of [[300, 22, 'Fifth Third Bank, Member FDIC'], [300, 775, 'Fifth Third Bank'], [300, 775, 'Online Banking at 53.com'],
        [36, 22, 'For more information visit www.53.com']] as Cell[]) {
        const named = edited((pages) => {
          rebrand(pages);
          pages[1].push(cell);
        });
        assert.equal(parseFifthThirdStatement(named).rows.length, 10, cell[2]);
      }
    });

    it('refuses a page with text outside US Letter bounds, where the bands are unknown (Root ruling)', () => {
      for (const cell of [[50, 800, 'SAMPLE'], [620, 400, 'SAMPLE'], [-1, 400, 'SAMPLE'], [50, -1, 'SAMPLE']] as Cell[]) {
        const message = refusal(edited((pages) => pages[1].push(cell)));
        assert.match(message, /^page 2 holds text outside a US Letter page, so its header and footer bands are unknown/, String(cell));
        assert.equal(describeFifthThirdStatementLayout(edited((pages) => pages[1].push(cell))).pageOutsideLetter, 2);
      }
      // On the edges is inside; and both synthetic statements, laid out on Letter pages, are read.
      assert.equal(parseFifthThirdStatement(edited((pages) => pages[0].push([0, 0, 'SAMPLE'], [612, 792, 'SAMPLE']))).rows.length, 10);
      assert.equal(describeFifthThirdStatementLayout(statement()).pageOutsideLetter, null);
    });

    it('activity it cannot see is never taken for no activity (review P1)', () => {
      // Branded, with a period, an account and equal balances, but no section counts: nothing proves the month was quiet.
      const silent = pagesOf([[
        [50, 760, 'Fifth Third Bank'], [400, 760, 'Statement Period Date: 9/1/2026 - 9/30/2026'], [400, 746, 'Account Type: Fifth Third Momentum Checking'], [400, 732, 'Account Number: XXXXXX4321'],
        [50, 686, '09/01'], [90, 686, 'Beginning Balance'], [250, 686, '$2,500.00'],
        [50, 630, '09/30'], [90, 630, 'Ending Balance'], [250, 630, '$2,500.00'],
      ]]);
      assert.match(refusal(silent), /prints no count and total for Checks, so its activity cannot be proven complete/);
      // Offsetting activity under a section or summary line it does not know.
      assert.match(refusal(edited((pages) => {
        const { cells: page, index } = cellAt(pages, '2 items totaling $3,200.12');
        page.splice(index + 1, 0, [50, 645, 'Other Credits'], [400, 645, '1 items totaling $50.00']);
      })), /line \d+: a section this reader does not know prints a total/);
      assert.match(refusal(edited((pages) => {
        const { cells: page, index } = cellAt(pages, 'Account Summary - XXXXXX4321');
        page.splice(index + 1, 0, [90, 693, '1'], [100, 693, 'Other Debits'], [250, 693, '-50.00']);
      })), /the Account Summary counts activity this reader does not know/);
      assert.match(refusal(edited((pages) => {
        const { cells: page } = cellAt(pages, 'Daily Balance Summary');
        page.push([50, 100, 'Other Activity'], [50, 86, '09/04'], [100, 86, '50.00'], [180, 86, 'OFFSETTING CREDIT']);
      })), /line \d+: a Daily Balance Summary line holds something other than dates and balances/);
      // Before any section, a dated line is a row of a section this reader does not know.
      assert.match(refusal(edited((pages) => {
        const { cells: page } = cellAt(pages, 'Checks');
        page.push([50, 614, '09/04'], [100, 614, '50.00'], [180, 614, 'OFFSETTING CREDIT']);
      })), /a dated line outside the sections this reader knows/);
    });

    it('reads a financial line whole or refuses it, never skipping it as page furniture (review F18)', () => {
      // A contradictory daily balance on a line that also ends in "continued": read whole, so refused.
      const contradictory = edited((pages) => {
        replaceText(pages, '3,377.79', '3,377.80');
        replaceText(pages, '2,532.57', '2,532.57 continued');
      });
      assert.match(refusal(contradictory), /line \d+: a Daily Balance Summary line holds something other than dates and balances/);
      // The same suffix on a summary line or a heading with its total; in a description it is just a word of the row.
      assert.match(refusal(edited((pages) => replaceText(pages, '-2,917.55', '-2,917.55 continued'))), /an Account Summary line is not a count and one whole amount/);
      assert.match(refusal(edited((pages) => replaceText(pages, '$2,532.57', '$2,532.57 continued'))), /Ending Balance is not one whole amount/);
      assert.match(refusal(edited((pages) => replaceText(pages, '7 items totaling $2,917.55', '7 items totaling $2,917.55 continued'))),
        /heading's count and total are not a number and one whole amount/);
      assert.match(refusal(edited((pages) => replaceText(pages, 'Daily Balance Summary', 'Daily Balance Summary 09/30 2,532.57'))),
        /the Daily Balance Summary heading carries a date or an amount/);
      const described = parseFifthThirdStatement(edited((pages) => replaceText(pages, 'MONTHLY SERVICE FEE', 'MONTHLY SERVICE FEE continued')));
      assert.equal(described.rows.at(-1)!.description, 'MONTHLY SERVICE FEE continued');
      // Furniture on a line of its own, with no figure, is still skipped.
      const furniture = edited((pages) => {
        const { cells: page } = cellAt(pages, 'Daily Balance Summary');
        page.push([50, 524, 'continued'], [50, 510, '(continued on next page)']);
      });
      assert.equal(parseFifthThirdStatement(furniture).rows.length, 10);
      const layout = describeFifthThirdStatementLayout(furniture) as { sections: Record<string, { noise: number; unread: number }> };
      assert.deepEqual(layout.sections['Daily Balance Summary'], { ...layout.sections['Daily Balance Summary'], noise: 4, unread: 0 });
    });

    it('a statement that does not say it is a checking account, or names both kinds (model review)', () => {
      const typeLine = 'Account Type: Fifth Third Momentum Checking';
      assert.match(refusal(edited((pages) => dropLine(pages, typeLine))), /does not say what kind of account it is/);
      assert.match(refusal(edited((pages) => {
        const { cells: page, index } = cellAt(pages, typeLine);
        page.splice(index + 1, 0, [400, 739, 'Fifth Third Relationship Savings']);
      })), /names both a checking and a savings account/);
      // Savings is read as savings, and the converter refuses anything but checking.
      const savings = parseFifthThirdStatement(edited((pages) => replaceText(pages, typeLine, 'Account Type: Fifth Third Relationship Savings')));
      assert.equal(savings.accountType, 'SAVINGS');
      assert.throws(() => convertCheckingExports([{ name: 'file 1', parsed: savings }], { institution: 'fifththird', label: 'Fifth Third Checking' }),
        /is a statement of a SAVINGS account, not a checking account/);
      // An Account Type label beside other text on its line counts as well.
      assert.match(refusal(edited((pages) => pages[0].push([50, 718, 'Linked Account Type: Relationship Savings']))), /names both a checking and a savings account/);
    });

    it('a mistyped whole account number in --account is refused before anything is read, never echoed (review P2)', () => {
      for (const run of [
        () => parseFifthThirdStatement(statement(), { accountLast4: '9990004321' }),
        () => fifthThirdStatementAdapter.parse({ kind: 'pdf', pages: [] }, { accountLast4: '9990004321' }),
      ]) {
        assert.throws(run, (error: Error) => error.message === '--account must be the last four digits of the account number');
      }
    });
  });

  describe('reads each row in the column order its section prints (review: an amount-first guess took a description\'s number)', () => {
    /** One October with the Date, Description, Amount layout, whose descriptions start with numbers that also add up. */
    const descriptionFirst = (rows: Cell[] = [
      [50, 500, '10/01'], [100, 500, '6.00 PRIVATE_PAYEE_ALPHA'], [450, 500, '10.00'],
      [50, 486, '10/02'], [100, 486, '24.00 PRIVATE_PAYEE_BETA'], [450, 486, '20.00'],
    ], heading: Cell[] = [[50, 514, 'Date'], [100, 514, 'Description'], [450, 514, 'Amount']]) => pagesOf([[
      [50, 760, 'Fifth Third Bank'], [400, 760, 'Statement Period Date: 10/1/2026 - 10/31/2026'], [400, 746, 'Account Type: Fifth Third Momentum Checking'], [400, 732, 'Account Number: XXXXXX4321'],
      [50, 686, '10/01'], [90, 686, 'Beginning Balance'], [250, 686, '$100.00'],
      [90, 672, '0'], [100, 672, 'Checks'], [250, 672, '0.00'],
      [90, 658, '2'], [100, 658, 'Withdrawals / Debits'], [250, 658, '-30.00'],
      [90, 644, '0'], [100, 644, 'Deposits / Credits'], [250, 644, '0.00'],
      [50, 630, '10/31'], [90, 630, 'Ending Balance'], [250, 630, '$70.00'],
      [50, 528, 'Withdrawals / Debits'], [400, 528, '2 items totaling $30.00'],
      ...heading,
      ...rows,
      [50, 440, 'Daily Balance Summary'],
      [50, 426, '10/01'], [100, 426, '90.00'], [200, 426, '10/02'], [250, 426, '70.00'],
    ]]);

    it('takes each amount from the Amount column', () => {
      const parsed = parseFifthThirdStatement(descriptionFirst());
      assert.deepEqual(parsed.rows.map((row) => [row.postedDate, row.amountMinor, row.description]), [
        ['2026-10-01', -1000, '6.00 PRIVATE_PAYEE_ALPHA'], ['2026-10-02', -2000, '24.00 PRIVATE_PAYEE_BETA'],
      ]);
      const sections = describeFifthThirdStatementLayout(descriptionFirst()).sections as Record<string, { columnOrder: string }>;
      assert.equal(sections['Withdrawals / Debits'].columnOrder, 'Date Description Amount');
    });

    it('refuses an Amount cell that is not one whole amount, rather than take one from the description', () => {
      const rows: Cell[] = [[50, 500, '10/01'], [100, 500, '6.00 PRIVATE_PAYEE_ALPHA'], [450, 500, '10.00x'], [50, 486, '10/02'], [100, 486, '24.00 PRIVATE_PAYEE_BETA'], [450, 486, '20.00']];
      assert.match(refusal(descriptionFirst(rows)), /line \d+: a Withdrawals \/ Debits row could not be read/);
    });

    it('refuses rows whose cells are not where the heading prints the columns', () => {
      const amountFirstHeading: Cell[] = [[50, 514, 'Date'], [100, 514, 'Amount'], [180, 514, 'Description']];
      assert.match(refusal(descriptionFirst(undefined, amountFirstHeading)), /row's amount or description is not in the column its heading prints/);
    });

    it('refuses rows before any column heading', () => {
      assert.match(refusal(descriptionFirst(undefined, [])), /row comes before its Date, Amount and Description heading/);
    });
  });

  it('reads a statement with no activity when it says so: every count printed as zero', () => {
    const quiet = pagesOf([[
      [50, 760, 'Fifth Third Bank'], [400, 760, 'Statement Period Date: 9/1/2026 - 9/30/2026'], [400, 746, 'Account Type: Fifth Third Momentum Checking'], [400, 732, 'Account Number: XXXXXX4321'],
      [50, 686, '09/01'], [90, 686, 'Beginning Balance'], [250, 686, '$2,500.00'],
      [90, 672, '0'], [100, 672, 'Checks'], [250, 672, '0.00'],
      [90, 658, '0'], [100, 658, 'Withdrawals / Debits'], [250, 658, '0.00'],
      [90, 644, '0'], [100, 644, 'Deposits / Credits'], [250, 644, '0.00'],
      [50, 630, '09/30'], [90, 630, 'Ending Balance'], [250, 630, '$2,500.00'],
    ]]);
    const parsed = parseFifthThirdStatement(quiet);
    assert.deepEqual(parsed.rows, []);
    assert.deepEqual(parsed.statement, { openingBalanceMinor: 250000, closingBalanceMinor: 250000, depositsMinor: 0, withdrawalsMinor: 0 });
  });

  describe('as Fifth Third prints statements today (synthetic October: no checks, negatives as $(…), 53.com)', () => {
    const OCTOBER = JSON.parse(fixture('statement-2026-10.layout.json')) as { pages: Cell[][] };
    const october = (edit?: (pages: Cell[][]) => void) => {
      const pages = OCTOBER.pages.map((cells) => cells.map((cell) => [...cell] as Cell));
      edit?.(pages);
      return pagesOf(pages);
    };
    const OCTOBER_VALUES = ['9990004321', '4,421.57', '1,311.00', '3,200.00', '5,732.57', 'CONTOSO', 'CHASE'];
    const octoberRefusal = (pages: CheckingPdfPage[]) => {
      const message = refusal(pages);
      for (const value of OCTOBER_VALUES) assert.ok(!message.includes(value), `shows ${value}: ${message}`);
      return message;
    };

    it('reads a bare Checks label, $(…) negatives, a Fee Summary, Date/Amount daily pairs and an unmasked account number', () => {
      const parsed = parseFifthThirdStatement(october());
      assert.deepEqual(detectCheckingExportAdapters({ kind: 'pdf', pages: october() }).map((adapter) => adapter.source), [FIFTH_THIRD_STATEMENT_SOURCE]);
      assert.deepEqual([parsed.accountLast4, parsed.accountType], ['4321', 'CHECKING']);
      assert.deepEqual(parsed.coverage, { start: '2026-10-01', end: '2026-10-31' });
      assert.deepEqual(parsed.statement, { openingBalanceMinor: 253257, closingBalanceMinor: 442157, depositsMinor: 320000, withdrawalsMinor: 131100 });
      assert.deepEqual(dayAmounts(parsed.rows), [['2026-10-01', 320000], ['2026-10-02', -100000], ['2026-10-15', -30000], ['2026-10-31', -1100]]);
      assert.deepEqual(parsed.rows.map((row) => row.runningBalanceMinor), [573257, 473257, 443257, 442157]);
      assert.ok(parsed.rows.every((row) => row.checkNumber === null && row.sourceTexts.includes('9990004321')));
      const layout = describeFifthThirdStatementLayout(october());
      assert.deepEqual(layout.summaryFound, ['opening', 'checks (blank)', 'withdrawals', 'deposits', 'closing']);
      assert.deepEqual([layout.summaryUnknown, layout.unreadShapes], [[], []]);
      assert.deepEqual(layout.skippedShapes, [
        { shape: 'Daily Balance Summary: <int>', count: 1 }, { shape: 'Daily Balance Summary: This page <w> <w> <w>', count: 1 },
      ]);
    });

    it('chains with the statement before it: one record, every balance following from the rows', () => {
      const { payload, report } = convertCheckingExports([
        { name: 'September', parsed: parseFifthThirdStatement(statement()) },
        { name: 'October', parsed: parseFifthThirdStatement(october()) },
      ], { institution: 'fifththird', label: 'Fifth Third Momentum Checking' });
      assert.deepEqual(payload.segments.map((segment) => segment.coverage), [
        { start: '2026-09-01', end: '2026-09-30' }, { start: '2026-10-01', end: '2026-10-31' },
      ]);
      assert.deepEqual(report.balanceChain, { checked: 10, gaps: 0 });
      // An October whose opening balance is not September's closing one is a gap the chain shows.
      const later = parseFifthThirdStatement(october((pages) => {
        replaceText(pages, '$2,532.57', '$2,532.58');
        replaceText(pages, '$4,421.57', '$4,421.58');
        for (const [from, to] of [['5,732.57', '5,732.58'], ['4,732.57', '4,732.58'], ['4,432.57', '4,432.58'], ['4,421.57', '4,421.58']]) replaceText(pages, from, to);
      }));
      assert.throws(() => convertCheckingExports([
        { name: 'September', parsed: parseFifthThirdStatement(statement()) }, { name: 'October', parsed: later },
      ], { institution: 'fifththird', label: 'Fifth Third Momentum Checking' }), /balance/);
    });

    it('names its bank in its header and footers; either one is enough, transaction text never is', () => {
      const footerOnly = october((pages) => replaceText(pages, 'Questions? Visit 53.com', 'Questions? Visit a branch'));
      assert.equal(parseFifthThirdStatement(footerOnly).rows.length, 4);
      const neither = october((pages) => {
        replaceText(pages, 'Questions? Visit 53.com', 'Questions? Visit a branch');
        for (const page of pages) for (const cell of page) cell[2] = cell[2].replace('www.53.com', 'www.example.com');
        replaceText(pages, 'AMEX EPAYMENT ACH PMT', 'TRANSFER TO FIFTH THIRD BANK 53.COM');
      });
      assert.equal(fifthThirdStatementAdapter.detect({ kind: 'pdf', pages: neither }), false);
      assert.match(octoberRefusal(neither), /header or footer band names Fifth Third Bank or 53\.com/);
    });

    it('reads its Fee Summary whole, and refuses an amount it states anywhere it does not read (Root 03:13Z census)', () => {
      const layout = describeFifthThirdStatementLayout(october()) as { sections: Record<string, { rows: number; unread: number }> };
      assert.deepEqual([layout.sections['Fee Summary'].rows, layout.sections['Fee Summary'].unread], [2, 0]);
      assert.match(octoberRefusal(october((pages) => replaceText(pages, '($0.00)', '($0.0O)'))), /line \d+: a Fee Summary row is not its Total label and a whole amount in each column its heading declares/);
      assert.match(octoberRefusal(october((pages) => pages[0].push([550, 582, '($0.00)']))), /line \d+: a Fee Summary row does not hold exactly one amount under each column its heading declares/);
      // Before, between and after the read parts, with the amount whole or split into words. A whole-dollar amount that
      // ends its line is a figure; one inside a sentence of a notice is not (see the January and February notices).
      for (const cell of [[300, 750, 'Earn a bonus of $200'], [84, 610, 'Other fees 5.00'], [300, 706, 'Rate 1 .25']] as Cell[]) {
        assert.match(octoberRefusal(october((pages) => pages[0].push(cell))), /states a date or an amount outside the statement's summary, sections and Fee Summary/, cell[2]);
      }
      assert.match(octoberRefusal(october((pages) => pages[0].push([36, 470, 'PAGE TOTAL 1 311 .00']))), /a Withdrawals \/ Debits line holds an amount or date but is not a row/);
      // A fee label wrapped onto its own line carries no amount and is passed over.
      assert.equal(parseFifthThirdStatement(october((pages) => pages[0].push([280, 561, 'and Unpaid Item Fees']))).rows.length, 4);
    });

    it('reads every Total row of its Fee Summary whole, one amount in each column its heading declares (F31, F32, Root 04:10Z)', () => {
      type FeeCounts = { rows: number; misplaced: number; noise: number; skipped: number; unread: number };
      const fees = (pages: CheckingPdfPage[]) => (describeFifthThirdStatementLayout(pages) as { sections: Record<string, FeeCounts> }).sections['Fee Summary'];
      // F31: a declared row whose cells are unreadable, unmarked or blank refuses the statement; it is never passed over.
      for (const [name, to] of [['an unreadable cent', '0.0O'], ['a missing cent', '0.0'], ['a word', 'UNKNOWN_VALUE'], ['no cells', null]] as const) {
        const pages = october((cells) => {
          cells[0] = cells[0].flatMap((cell): Cell[] => (cell[1] === 582 && [410, 480].includes(cell[0]) ? (to === null ? [] : [[cell[0], cell[1], to]]) : [cell]));
        });
        assert.match(octoberRefusal(pages), /line \d+: a Fee Summary row is not its Total label and a whole amount in each column its heading declares/, name);
        assert.deepEqual([fees(pages).rows, fees(pages).unread, fees(pages).skipped], [1, 1, 0], name);
      }
      // F32: the heading's columns, never another row, say how many amounts a row holds and where they stand.
      const plain = (cells: Cell[][]) => {
        for (const cell of cells[0]) if ([582, 568].includes(cell[1]) && [410, 480].includes(cell[0])) cell[2] = '0.00';
      };
      assert.equal(parseFifthThirdStatement(october(plain)).rows.length, 4);
      const noYearToDate = october((cells) => {
        plain(cells);
        cells[0] = cells[0].filter((cell) => !(cell[0] === 480 && [582, 568].includes(cell[1])));
      });
      const bothUnderThisPeriod = october((cells) => {
        plain(cells);
        for (const cell of cells[0]) if (cell[0] === 480 && [582, 568].includes(cell[1])) cell[0] = 437;
      });
      for (const pages of [noYearToDate, bothUnderThisPeriod]) {
        assert.match(octoberRefusal(pages), /line \d+: a Fee Summary row does not hold exactly one amount under each column its heading declares/);
        assert.deepEqual([fees(pages).rows, fees(pages).misplaced], [0, 2]);
      }
      // Besides its Total rows, only a label wrapped in the label column, or the page's own furniture in its fixed
      // bands, is passed over: a line under the declared columns refuses, whatever its label.
      const unlabelled = october((cells) => cells[0].push([280, 561, 'Returned Item Fees'], [410, 561, 'UNKNOWN_VALUE']));
      assert.match(octoberRefusal(unlabelled), /line \d+: a Fee Summary line is neither a Total row nor a label wrapped in its label column/);
      assert.equal(fees(unlabelled).unread, 1);
      const atFoot = (footerY: number) => october((cells) => {
        for (const cell of cells[0]) {
          if ([596, 582, 568].includes(cell[1]) && cell[0] >= 280) cell[1] -= 496;
          else if (cell[1] === 22) cell[1] = footerY;
        }
      });
      assert.equal(parseFifthThirdStatement(atFoot(22)).rows.length, 4);
      // Both pages' footers (the last section runs on over the second page) are the pages' own furniture.
      assert.deepEqual([fees(atFoot(22)).rows, fees(atFoot(22)).noise, fees(atFoot(22)).unread], [2, 2, 0]);
      assert.match(octoberRefusal(atFoot(50)), /line \d+: a Fee Summary line is neither a Total row nor a label wrapped in its label column/);
    });

    it('a bare Checks label proves no checks only when none is read, and never beside a count', () => {
      const withCheck = october((pages) => pages[0].push([36, 330, 'Checks'], [36, 316, '1042'], [80, 316, '10/20'], [130, 316, '25.00']));
      assert.match(octoberRefusal(withCheck), /prints no count and total for Checks, so its activity cannot be proven complete/);
      const both = october((pages) => pages[0].push([70, 655, '1'], [84, 655, 'Checks'], [250, 655, '$(25.00)']));
      assert.match(octoberRefusal(both), /prints its Checks line both blank and with a count/);
      const unknown = october((pages) => pages[0].push([84, 641, 'Other Activity']));
      assert.match(octoberRefusal(unknown), /line \d+: an Account Summary line this reader does not know/);
      const suffix = october((pages) => replaceText(pages, '31', '31 X'));
      assert.match(octoberRefusal(suffix), /Beginning Balance is not one whole amount/);
      const negative = october((pages) => replaceText(pages, '$(1,311.00)', '$(1,311.00'));
      assert.match(octoberRefusal(negative), /an Account Summary line is not a count and one whole amount/);
    });
  });

  describe('layouts real statements print, as synthetic November (no deposits), December (notices), January and February (notices with whole-dollar terms)', () => {
    const month = (name: '2026-10' | '2026-11' | '2026-12' | '2027-01' | '2027-02', edit?: (pages: Cell[][]) => void) => {
      const pages = (JSON.parse(fixture(`statement-${name}.layout.json`)) as { pages: Cell[][] }).pages;
      const copy = pages.map((cells) => cells.map((cell) => [...cell] as Cell));
      edit?.(copy);
      return pagesOf(copy);
    };
    const MONTH_VALUES = ['9990004321', '4,421.57', '4,160.57', '6,849.57', '9,538.57', '12,477.57', '3,200.00', '261.00', '511.00', 'CONTOSO', 'CHASE', 'AMEX'];
    const refusedWith = (pages: CheckingPdfPage[]) => {
      const message = refusal(pages);
      for (const value of MONTH_VALUES) assert.ok(!message.includes(value), `shows ${value}: ${message}`);
      return message;
    };
    /** A Deposits / Credits section with one row, after the Daily Balance Summary; with or without its count and total. */
    const depositSection = (withTotal: boolean) => (pages: Cell[][]) => {
      pages[0].push([36, 420, 'Deposits / Credits'], [36, 406, 'Date'], [141, 406, 'Amount'], [202, 406, 'Description'],
        [36, 392, '11/10'], [150, 392, '5.00'], [204, 392, 'SYNTHETIC CREDIT']);
      if (withTotal) pages[0].push([300, 420, '1 items totaling $5.00']);
    };
    const NOTICE = 'ACCOUNT. WE ARE HERE TO HELP YOU 24/7 AT 53.COM OR BY PHONE';

    it('reads a month without deposits: a bare Deposits / Credits summary label and no Deposits section', () => {
      const parsed = parseFifthThirdStatement(month('2026-11'));
      assert.deepEqual([parsed.accountLast4, parsed.accountType], ['4321', 'CHECKING']);
      assert.deepEqual(parsed.coverage, { start: '2026-11-01', end: '2026-11-30' });
      assert.deepEqual(parsed.statement, { openingBalanceMinor: 442157, closingBalanceMinor: 416057, depositsMinor: 0, withdrawalsMinor: 26100 });
      assert.deepEqual(dayAmounts(parsed.rows), [['2026-11-03', -25000], ['2026-11-30', -1100]]);
      assert.deepEqual(parsed.rows.map((row) => row.runningBalanceMinor), [417157, 416057]);
      const layout = describeFifthThirdStatementLayout(month('2026-11'));
      assert.deepEqual(layout.summaryFound, ['opening', 'checks (blank)', 'withdrawals', 'deposits (blank)', 'closing']);
      assert.deepEqual([layout.summaryUnknown, layout.unreadShapes], [[], []]);
      // Beside a zero count it says the same thing, and reads.
      assert.equal(parseFifthThirdStatement(month('2026-11', (pages) => pages[0].push([70, 641, '0'], [84, 641, 'Deposits / Credits'], [250, 641, '$0.00']))).rows.length, 2);
    });

    it('a bare Deposits / Credits label proves no deposits only when none is read, never beside a count, and the balances still hold', () => {
      assert.match(refusedWith(month('2026-11', depositSection(true))),
        /the Account Summary prints its Deposits \/ Credits label with no count and no amount, but Deposits \/ Credits rows were read/);
      assert.match(refusedWith(month('2026-11', depositSection(false))), /prints no count and total for Deposits \/ Credits, so its activity cannot be proven complete/);
      assert.match(refusedWith(month('2026-11', (pages) => pages[0].push([70, 641, '1'], [84, 641, 'Deposits / Credits'], [250, 641, '$5.00']))),
        /prints its Deposits \/ Credits line both blank and with a count/);
      assert.match(refusedWith(month('2026-11', (pages) => replaceText(pages, '$4,160.57', '$4,165.57'))), /Beginning Balance \+ deposits - checks - withdrawals is not the Ending Balance/);
      assert.match(refusedWith(month('2026-11', (pages) => replaceText(pages, '4,171.57', '4,176.57'))), /the Daily Balance Summary does not follow from the rows/);
      // Only the labels Fifth Third prints bare are known so: a bare Withdrawals / Debits label is not.
      assert.match(refusedWith(month('2026-11', (pages) => pages[0].push([84, 641, 'Withdrawals / Debits']))), /line \d+: an Account Summary line this reader does not know/);
      // The bare Checks label is held to the same rule: a check read under a printed count and total contradicts it.
      const checked = month('2026-10', (pages) => pages[0].push([36, 330, 'Checks'], [300, 330, '1 checks totaling $25.00'],
        [36, 316, '1042'], [80, 316, '10/20'], [130, 316, '25.00']));
      assert.match(refusal(checked), /the Account Summary prints its Checks label with no count and no amount, but Checks rows were read/);
    });

    it('reads a statement whose notices mention Fifth Third, checking and savings accounts and 24/7', () => {
      const parsed = parseFifthThirdStatement(month('2026-12'));
      assert.deepEqual([parsed.accountLast4, parsed.accountType], ['4321', 'CHECKING']);
      assert.deepEqual(parsed.statement, { openingBalanceMinor: 416057, closingBalanceMinor: 684957, depositsMinor: 320000, withdrawalsMinor: 51100 });
      assert.deepEqual(dayAmounts(parsed.rows), [['2026-12-01', 320000], ['2026-12-05', -50000], ['2026-12-31', -1100]]);
      const layout = describeFifthThirdStatementLayout(month('2026-12')) as {
        accountKinds: string[]; unreadShapes: unknown[]; summaryUnknown: unknown[]; sections: Record<string, { rows: number; skipped: number; unread: number }>;
      };
      assert.deepEqual([layout.accountKinds, layout.unreadShapes, layout.summaryUnknown], [['CHECKING'], [], []]);
      // The notice after the Daily Balance Summary is text without a figure, passed over.
      assert.deepEqual(layout.sections['Daily Balance Summary'], { ...layout.sections['Daily Balance Summary'], rows: 1, unread: 0 });
    });

    it('takes the account kind only from Account Type lines and whole-line Fifth Third product titles, never from a notice', () => {
      // A product title naming savings anywhere before the Account Summary is still a second kind (model review).
      assert.match(refusedWith(month('2026-12', (pages) => pages[0].push([43, 640, 'Fifth Third Relationship Savings']))), /names both a checking and a savings account/);
      // So is an Account Type label, wherever it stands on its line.
      assert.match(refusedWith(month('2026-12', (pages) => pages[0].push([43, 640, 'LINKED ACCOUNT TYPE: RELATIONSHIP SAVINGS']))), /names both a checking and a savings account/);
      // A notice that names checking does not make an untitled statement a checking one.
      assert.match(refusedWith(month('2026-12', (pages) => dropLine(pages, 'Account Type: 53 MOMENTUM CHECKING'))), /does not say what kind of account it is/);
    });

    it('a notice may say 24/7 or state a whole-dollar term, but a date or a figure it states still refuses the statement (Root 03:13Z census)', () => {
      // A date is a month 1-12 and a day 1-31: these are not.
      for (const token of ['24/7', '13/1', '0/12', '12/32', '99/99']) {
        assert.equal(parseFifthThirdStatement(month('2026-12', (pages) => replaceText(pages, NOTICE, `ACCOUNT. CALL ${token} AT 53.COM`))).rows.length, 3, token);
      }
      // A whole-dollar term inside a sentence is prose; one that ends its line, or with cents, is a figure.
      assert.equal(parseFifthThirdStatement(month('2026-12', (pages) => replaceText(pages, NOTICE, 'ACCOUNT. A $5 FEE APPLIES'))).rows.length, 3);
      for (const text of ['ACCOUNT. STARTING 1/15 CALL US AT 53.COM', 'ACCOUNT. CALL BY 12/31 AT 53.COM', 'ACCOUNT. FEES APPLY OF UP TO $5', 'ACCOUNT. FEES OF 5.00 APPLY']) {
        assert.match(refusedWith(month('2026-12', (pages) => replaceText(pages, NOTICE, text))),
          /states a date or an amount outside the statement's summary, sections and Fee Summary/, text);
      }
      // A line that starts with a date is a row of a table this reader does not know.
      assert.match(refusedWith(month('2026-12', (pages) => replaceText(pages, NOTICE, '12/15 PLEASE CALL US AT 53.COM'))), /a dated line outside the sections this reader knows/);
      // After the Daily Balance Summary the same: 24/7 is passed over (the fixture), a date refuses.
      assert.match(refusedWith(month('2026-12', (pages) => replaceText(pages, 'YOUR DEBIT CARD SETTINGS AT ANY TIME', 'YOUR DEBIT CARD SETTINGS BY 12/31'))),
        /a Daily Balance Summary line holds something other than dates and balances/);
    });

    it('reads notices whose prose states whole-dollar terms: before the Account Summary (January) and after the Daily Balance Summary (February)', () => {
      const january = parseFifthThirdStatement(month('2027-01'));
      assert.deepEqual([january.accountLast4, january.accountType], ['4321', 'CHECKING']);
      assert.deepEqual(january.statement, { openingBalanceMinor: 684957, closingBalanceMinor: 953857, depositsMinor: 320000, withdrawalsMinor: 51100 });
      assert.deepEqual(dayAmounts(january.rows), [['2027-01-02', 320000], ['2027-01-05', -50000], ['2027-01-31', -1100]]);
      const february = parseFifthThirdStatement(month('2027-02'));
      assert.deepEqual(february.statement, { openingBalanceMinor: 953857, closingBalanceMinor: 1247757, depositsMinor: 320000, withdrawalsMinor: 26100 });
      assert.deepEqual(dayAmounts(february.rows), [['2027-02-01', 320000], ['2027-02-03', -25000], ['2027-02-26', -1100]]);
      assert.deepEqual(february.rows.map((row) => row.runningBalanceMinor), [1273857, 1248857, 1247757]);
      for (const name of ['2027-01', '2027-02'] as const) {
        const layout = describeFifthThirdStatementLayout(month(name)) as { unreadShapes: unknown[]; summaryUnknown: unknown[] };
        assert.deepEqual([layout.unreadShapes, layout.summaryUnknown], [[], []], name);
      }
      // February's notice, on the page its Daily Balance Summary runs on, is passed over: its term shown by its kind only.
      const layout = describeFifthThirdStatementLayout(month('2027-02')) as {
        skippedShapes: Array<{ shape: string }>; sections: Record<string, { skipped: number; unread: number }>;
      };
      assert.deepEqual([layout.sections['Daily Balance Summary'].skipped, layout.sections['Daily Balance Summary'].unread], [3, 0]);
      assert.ok(layout.skippedShapes.some(({ shape }) => shape.startsWith('Daily Balance Summary:') && shape.includes('<$whole>')));
    });

    it('takes a whole-dollar term for prose only as a word inside a sentence of a notice; anything else is still a figure (Root 03:13Z census)', () => {
      const BANKS = 'WITH $50B TO $250B IN DEPOSITS. VISIT A BRANCH FOR MORE DETAILS.';
      const UP_TO = 'WILL BE UP TO $25. USE THE FIFTH THIRD MOBILE APP TO SET ALERTS ON YOUR BALANCE AND';
      const before = (text: string) => month('2027-01', (pages) => replaceText(pages, BANKS, text));
      const after = (text: string) => month('2027-02', (pages) => replaceText(pages, UP_TO, text));
      // Prose: a whole number of dollars, with a K, M or B scale and at most one closing mark, a word on each side of it.
      for (const text of ['EARN A $200 BONUS TODAY', 'BALANCES OF $1,500 OR MORE QUALIFY', 'FROM $10K TO $5m IN DEPOSITS', 'UP TO $25! ASK US HOW']) {
        assert.equal(parseFifthThirdStatement(before(text)).rows.length, 3, text);
        assert.equal(parseFifthThirdStatement(after(text)).rows.length, 3, text);
      }
      // Still a figure: cents, a $ apart from its digits, signed, in parentheses, with a decimal part or another suffix,
      // at either end of its line or alone, beside a number, or on a line that states a date.
      for (const text of [
        'WITH $50.00 TO $250B IN DEPOSITS', 'WITH $ 50B TO $250B IN DEPOSITS', 'WITH ($50B) TO $250B IN DEPOSITS', 'WITH -$50B TO $250B IN DEPOSITS',
        'WITH $50.5B TO $250B IN DEPOSITS', 'WITH $50BN TO $250B IN DEPOSITS', 'WITH $50B+ TO $250B IN DEPOSITS', '$50B TO $250B IN DEPOSITS',
        'BANKS WITH DEPOSITS OF $250B', '$250B', 'WITH $50B 2027 DEPOSITS', 'WITH $50B TO $250B IN DEPOSITS BY 1/31',
      ]) {
        assert.match(refusedWith(before(text)), /states a date or an amount outside the statement's summary, sections and Fee Summary/, text);
        assert.match(refusedWith(after(text)), /a Daily Balance Summary line holds something other than dates and balances/, text);
      }
      // A line that starts with a count is shaped as a summary line: a whole-dollar term there is still a figure.
      assert.match(refusedWith(before('2 BANKS WITH $50B TO $250B IN DEPOSITS')), /the Account Summary counts activity this reader does not know/);
      assert.match(refusedWith(after('2 BANKS WITH $50B TO $250B IN DEPOSITS')), /a Daily Balance Summary line holds something other than dates and balances/);
      // Only where the bank prints its notices (Root 23:41Z, 23:46Z): before the Account Summary heading, and in the Daily
      // Balance Summary around its balances, outside the header and footer bands. After the Ending Balance (before the Fee
      // Summary), in a band or between sections the same prose term is a figure (review F226-1).
      const PROSE = 'Offers up to $25 today';
      const CENSUS = /states a date or an amount outside the statement's summary, sections and Fee Summary/;
      const DAILY_FIGURE = /a Daily Balance Summary line holds something other than dates and balances/;
      assert.equal(parseFifthThirdStatement(month('2027-01', (pages) => pages[0].push([43, 650, PROSE]))).rows.length, 3);
      assert.equal(parseFifthThirdStatement(month('2027-02', (pages) => pages[1].push([43, 570, PROSE]))).rows.length, 3);
      assert.match(refusedWith(month('2027-01', (pages) => pages[0].push([36, 548, PROSE]))), CENSUS);
      assert.match(refusedWith(month('2027-01', (pages) => pages[0].push([36, 708, PROSE]))), CENSUS);
      assert.match(refusedWith(month('2027-01', (pages) => pages[0].push([36, 38, PROSE]))), DAILY_FIGURE);
      assert.match(refusedWith(month('2027-02', (pages) => pages[1].push([43, 30, PROSE]))), DAILY_FIGURE);
      assert.match(refusedWith(month('2027-01', (pages) => pages[0].push([36, 424, PROSE]))), /a Withdrawals \/ Debits line holds an amount or date but is not a row/);
      // --explain says the same: the notice line before the Account Summary is passed over, the line after it is unread.
      const unread = (y: number) => (describeFifthThirdStatementLayout(month('2027-01', (pages) => pages[0].push([43, y, PROSE]))) as {
        unreadShapes: unknown[];
      }).unreadShapes.length;
      assert.deepEqual([unread(650), unread(548)], [0, 1]);
      // In the activity sections, the Fee Summary and the headings nothing changes: any $ before a digit is a figure.
      assert.match(refusedWith(month('2027-01', (pages) => pages[0].push([36, 445, 'FEES OF UP TO $25 MAY APPLY']))),
        /a Withdrawals \/ Debits line holds an amount or date but is not a row/);
      assert.match(refusedWith(month('2027-01', (pages) => pages[0].push([280, 501, 'FEES OF UP TO $25 MAY APPLY']))),
        /a Fee Summary line is neither a Total row nor a label wrapped in its label column/);
      assert.match(refusedWith(month('2027-01', (pages) => replaceText(pages, 'Daily Balance Summary', 'Daily Balance Summary UP TO $25 SHOWN'))),
        /the Daily Balance Summary heading carries a date or an amount/);
      // Nor in the bank's own identity: a band line with a whole-dollar term is never the bank naming itself.
      const brandOnlyIn = (header: string) => month('2027-01', (pages) => {
        replaceText(pages, 'Questions? Visit 53.com', header);
        for (const page of pages) for (const cell of page) cell[2] = cell[2].replace('www.53.com', 'www.example.com');
      });
      assert.equal(parseFifthThirdStatement(brandOnlyIn('Questions? Visit 53.com')).rows.length, 3);
      assert.match(refusedWith(brandOnlyIn('Questions? Visit 53.com for a $200 bonus offer')), /no page's header or footer band names Fifth Third Bank or 53\.com/);
    });

    it('reads a $ with a sign between it and its digits as a figure everywhere (Root 23:46Z census hardening)', () => {
      const before = (text: string) => month('2027-01', (pages) => replaceText(pages, 'WITH $50B TO $250B IN DEPOSITS. VISIT A BRANCH FOR MORE DETAILS.', text));
      const after = (text: string) => month('2027-02', (pages) => replaceText(pages, 'WILL BE UP TO $25. USE THE FIFTH THIRD MOBILE APP TO SET ALERTS ON YOUR BALANCE AND', text));
      for (const form of ['$-25', '$+25', '$\u221225', '$ - 25', '$(-25)', '-$25']) {
        // After the Account Summary, in an activity section, and in both notice regions.
        assert.match(refusedWith(month('2026-10', (pages) => pages[0].push([84, 610, `Other fees ${form}`]))),
          /states a date or an amount outside the statement's summary, sections and Fee Summary/, form);
        assert.match(refusedWith(month('2027-01', (pages) => pages[0].push([36, 445, `ADJUSTMENT ${form} APPLIED`]))),
          /a Withdrawals \/ Debits line holds an amount or date but is not a row/, form);
        assert.match(refusedWith(before(`WITH ${form} TO $250B IN DEPOSITS`)), /states a date or an amount outside the statement's summary, sections and Fee Summary/, form);
        assert.match(refusedWith(after(`WILL BE UP TO ${form} USE THE APP`)), /a Daily Balance Summary line holds something other than dates and balances/, form);
      }
    });

    // Review of #226: the whole-dollar cases of e36b4c32's harness (F33-F36, Root 23:53Z) in both notice regions, and the
    // lead's placements; the reader and --explain agree on each (no unread shape if and only if the statement reads).
    const NOTICE_REGIONS = [
      { name: 'before the Account Summary', month: '2027-01', text: 'WITH $50B TO $250B IN DEPOSITS. VISIT A BRANCH FOR MORE DETAILS.' },
      { name: 'around the daily balances', month: '2027-02', text: 'WILL BE UP TO $25. USE THE FIFTH THIRD MOBILE APP TO SET ALERTS ON YOUR BALANCE AND' },
    ] as const;
    const inNotice = (region: (typeof NOTICE_REGIONS)[number], text: string) => month(region.month, (pages) => replaceText(pages, region.text, text));
    const unreadOf = (pages: CheckingPdfPage[]) => (describeFifthThirdStatementLayout(pages) as { unreadShapes: unknown[] }).unreadShapes;

    it('reads every whole-dollar prose term in both notice regions, its rows and balances unchanged (review F33)', () => {
      const prose = [
        'EARN A $25 BONUS TODAY', 'A $0 FEE MAY APPLY', 'BALANCES OF $1,500 OR MORE QUALIFY', 'BALANCES OF $12,345,678 OR MORE QUALIFY',
        ...['$10K', '$5M', '$50B', '$10k', '$5m', '$50b'].map((term) => `FROM ${term} TO OTHER LEVELS`), 'BALANCES OF $1,500K OR MORE QUALIFY',
        ...['.', ',', ';', ':', '!', '?'].map((mark) => `UP TO $25${mark} ASK US HOW`), 'FROM $10K TO $5M IN DEPOSITS',
        'IN 2027 BANKS WITH $25 FEES MAY QUALIFY', 'PRIVATE_PAYEE_ZEBRA $25 FEES APPLY',
        // A hyphen inside a neighbouring word is no sign against the term (review F37 controls).
        'FEE-FREE $25 BONUS APPLIES', 'FEE $25 NO-FUSS BONUS APPLIES',
      ];
      for (const region of NOTICE_REGIONS) {
        const expected = parseFifthThirdStatement(month(region.month));
        for (const text of prose) {
          const parsed = parseFifthThirdStatement(inNotice(region, text));
          assert.deepEqual([dayAmounts(parsed.rows), parsed.statement], [dayAmounts(expected.rows), expected.statement], `${region.name}: ${text}`);
          assert.deepEqual(unreadOf(inNotice(region, text)), [], `${region.name}: ${text}`);
        }
      }
    });

    it('refuses every near-miss in both notice regions, --explain naming it unread (review F34, Root 23:53Z)', () => {
      const nearMisses = [
        'A $25.00 FEE APPLIES', 'A 25.00 FEE APPLIES', 'A $25 . 00 FEE APPLIES', 'A $25.0 0 FEE APPLIES', 'A $ 25 FEE APPLIES', 'A $ 25B FEE APPLIES',
        'A -$25 FEE APPLIES', 'A +$25 FEE APPLIES', 'A $-25 FEE APPLIES', 'A $+25 FEE APPLIES', 'A $ -25 FEE APPLIES', 'A $ +25 FEE APPLIES',
        'A $\u221225 FEE APPLIES', 'A $\u201325 FEE APPLIES', 'A - $25 FEE APPLIES', 'A FEE- $25 APPLIES', 'A FEE OF $25 -NET APPLIES',
        'A ($25) FEE APPLIES', 'A $(25) FEE APPLIES', 'A ($-25) FEE APPLIES', 'A ( $25 ) FEE APPLIES', 'A $25.5 FEE APPLIES', 'A $25.000 FEE APPLIES',
        'A $25.! FEE APPLIES', 'A $1,50 FEE APPLIES', 'A $1,500,00 FEE APPLIES', 'A $25USD FEE APPLIES', 'A $25MM FEE APPLIES', 'A $25+ FEE APPLIES',
        'FEES UPTO$25 MAY APPLY', 'A $25FEE MAY APPLY', '$25 FEES MAY APPLY', 'FEES OF UP TO $25', '$25', 'FEES OF $25 2027 APPLY',
        'FEES OF 2027 $25 APPLY', 'FEES OF $25 NEXT2 APPLY', 'FEES OF YEAR2 $25 APPLY', 'FROM $25 $50 IN DEPOSITS',
        '2 BANKS WITH $25 FEES APPLY', '99999 BANKS WITH $25 FEES APPLY', '100000 BANKS WITH $25 FEES APPLY', '1,000 BANKS WITH $25 FEES APPLY',
        '2.5 BANKS WITH $25 FEES APPLY', '1/31 FEES OF $25 APPLY', 'FEES BY 1/31 OF $25 APPLY', 'FEES OF $25 APPLY BY 1/31',
        // Signs and parentheses against the term on either side, split from it or not (review F37).
        'FEE- $25 APPLIES', 'FEE+ $25 APPLIES', 'FEE( $25 APPLIES', 'FEE $25 -APPLIES', 'FEE $25 +APPLIES', 'FEE $25 )APPLIES',
        'FEE - $25 APPLIES', 'FEE $25 + APPLIES', 'FEE $(-25) APPLIES',
        // A line whose first letter or digit, after NFKC, is a digit: whatever stands before it (review F37, R14, Root 00:10Z).
        ...['0', '2.5', '-2', '+2', '(2)', '#2', '1e3', '100000', '1,000', '- 2', '+ 2', '( 2 )', '# 2', '#1', '(1)', '\u2022 2', '\uFF12', '\u00B2']
          .map((prefix) => `${prefix} BANKS WITH $25 FEES APPLY`),
      ];
      for (const region of NOTICE_REGIONS) {
        for (const text of nearMisses) {
          refusedWith(inNotice(region, text));
          assert.notDeepEqual(unreadOf(inNotice(region, text)), [], `${region.name}: ${text}`);
        }
      }
    });

    it('takes a notice term for prose only in the notice regions, the reader and --explain agreeing on every placement (lead re-check)', () => {
      const LINE = 'EARN A $200 BONUS TODAY';
      const placements: Array<[string, '2027-01' | '2027-02', number, number, number, boolean]> = [
        ['before the Account Summary heading', '2027-01', 0, 43, 650, true],
        ['just below the header band, before the heading', '2027-01', 0, 43, 695, true],
        ['just below the header band, before the heading (February)', '2027-02', 0, 43, 695, true],
        ['after the daily balances, on their page (January)', '2027-01', 0, 43, 300, true],
        ['after the daily balances, on their page (February)', '2027-02', 1, 43, 560, true],
        ['a further trailing notice line on the daily page (February)', '2027-02', 1, 43, 570, true],
        ['the header band', '2027-01', 0, 43, 705, false],
        ['the header band, higher', '2027-01', 0, 43, 750, false],
        ['after the Account Summary heading, before its Beginning Balance', '2027-01', 0, 43, 623, false],
        ['between the Ending Balance and the first heading', '2027-01', 0, 36, 548, false],
        ['the footer band of the daily page (January)', '2027-01', 0, 43, 35, false],
        ['the footer band of the daily page (February)', '2027-02', 1, 43, 35, false],
        ['a later page without daily balances, its body', '2027-01', 1, 43, 600, false],
        ['a later page without daily balances, its header band', '2027-01', 1, 43, 760, false],
        // The bands' edges (review F38): the header band starts at y 700, the footer band ends at y 40.
        ['just below the header band', '2027-01', 0, 43, 699, true],
        ['the header band at its edge', '2027-01', 0, 43, 700, false],
        ['just above the footer band of the daily page (January)', '2027-01', 0, 43, 41, true],
        ['the footer band at its edge (January)', '2027-01', 0, 43, 40, false],
        ['just above the footer band of the daily page (February)', '2027-02', 1, 43, 41, true],
        ['the footer band at its edge (February)', '2027-02', 1, 43, 40, false],
        ['between the daily heading and its balances (February)', '2027-02', 1, 43, 673, true],
        ['the header band of the daily page (February)', '2027-02', 1, 43, 710, false],
      ];
      for (const [name, which, page, x, y, reads] of placements) {
        const pages = month(which, (cells) => cells[page].push([x, y, LINE]));
        if (reads) {
          assert.equal(parseFifthThirdStatement(pages).rows.length, 3, name);
          assert.deepEqual(unreadOf(pages), [], name);
        } else {
          refusedWith(pages);
          assert.notDeepEqual(unreadOf(pages), [], name);
        }
      }
    });

    it('never relaxes an activity section, the Fee Summary, a heading, the Account Summary or the bank identity (review F36)', () => {
      const PROSE = 'FEES OF UP TO $25 MAY APPLY';
      for (const edit of [
        (pages: Cell[][]) => pages[0].push([36, 445, PROSE]), (pages: Cell[][]) => pages[0].push([36, 375, PROSE]),
        (pages: Cell[][]) => pages[0].push([280, 501, PROSE]), (pages: Cell[][]) => pages[0].push([43, 609, PROSE]),
        (pages: Cell[][]) => replaceText(pages, 'Daily Balance Summary', `Daily Balance Summary ${PROSE}`),
        (pages: Cell[][]) => replaceText(pages, 'Fee Summary', `Fee Summary ${PROSE}`),
        (pages: Cell[][]) => replaceText(pages, 'Withdrawals / Debits', `Withdrawals / Debits ${PROSE}`),
      ]) {
        refusedWith(month('2027-01', edit));
      }
      assert.match(refusal(edited((pages) => pages[0].push([50, 545, PROSE]))), /a Checks line holds something other than check numbers, dates and amounts/);
      // A row's own description may say anything.
      assert.equal(parseFifthThirdStatement(month('2027-01', (pages) => replaceText(pages, 'AMEX EPAYMENT ACH PMT', 'PAYMENT FOR A $25 ITEM'))).rows.length, 3);
      for (const band of ['header', 'footer'] as const) {
        for (const money of [false, true]) {
          const pages = month('2027-01', (cells) => {
            for (const page of cells) for (const cell of page) cell[2] = cell[2].replaceAll('53.com', 'example.com');
            const bankLine = `Questions? Visit 53.com${money ? ' for a $25 bonus' : ''}`;
            if (band === 'header') replaceText(cells, 'Questions? Visit example.com', bankLine);
            else replaceText(cells, 'For more information about your account visit www.example.com', bankLine);
          });
          if (money) assert.match(refusedWith(pages), /no page's header or footer band names Fifth Third Bank or 53\.com/, band);
          else assert.equal(parseFifthThirdStatement(pages).rows.length, 3, band);
        }
      }
    });

    it('chains September to February: one record, every balance following from the rows', () => {
      const { payload, report } = convertCheckingExports([
        { name: 'September', parsed: parseFifthThirdStatement(statement()) },
        ...(['2026-10', '2026-11', '2026-12', '2027-01', '2027-02'] as const).map((name) => ({ name, parsed: parseFifthThirdStatement(month(name)) })),
      ], { institution: 'fifththird', label: 'Fifth Third Momentum Checking' });
      assert.deepEqual(payload.segments.map((segment) => segment.coverage.end), ['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
      assert.deepEqual(report.balanceChain, { checked: 22, gaps: 0 });
    });
  });

  describe('more refusals', () => {

    it('rows that do not add up to the totals, or to the balances', () => {
      assert.match(refusal(edited((pages) => replaceText(pages, '987.65', '987.66'))), /do not add up to the Account Summary's total/);
      assert.match(refusal(edited((pages) => replaceText(pages, '$2,532.57', '$2,532.58'))), /is not the Ending Balance/);
      assert.match(refusal(edited((pages) => replaceText(pages, '3,377.79', '3,377.80'))), /Daily Balance Summary does not follow/);
    });

    it('a row moved to another day', () => {
      const message = refusal(edited((pages) => {
        const { cells, index } = cellAt(pages, 'AMEX EPAYMENT ACH PMT');
        const y = cells[index][1];
        for (const cell of cells) if (cell[1] === y && cell[2] === '09/02') cell[2] = '09/03';
      }));
      assert.match(message, /Daily Balance Summary does not follow/);
    });

    it('a file that is not one Fifth Third statement', () => {
      assert.match(refusal([]), /no text/);
      assert.match(refusal([{ items: [] }]), /no text/);
      assert.match(refusal(edited((pages) => {
        for (const page of pages) for (let i = page.length - 1; i >= 0; i -= 1) if (page[i][2].startsWith('Statement Period Date')) page.splice(i, 1);
      })), /states no "Statement Period Date"/);
      assert.match(refusal(edited((pages) => replaceText(pages, 'Statement Period Date: 9/1/2026 - 9/30/2026', 'Statement Period Date: 8/1/2026 - 8/31/2026'))), /holds 2 statement periods/);
      assert.match(refusal(edited((pages) => replaceText(pages, 'Account Number: XXXXXX4321', 'Account Number: XXXXXX8765'))), /covers 2 accounts/);
      assert.match(refusal(edited((pages) => dropLine(pages, 'Beginning Balance'))), /no Beginning Balance/);
      assert.match(refusal(edited((pages) => {
        for (const text of ['Daily Balance Summary', '5,600.00', '3,377.79']) dropLine(pages, text);
      })), /no Daily Balance Summary to check its rows against/);
      // Without its heading, the summary's lines would read as rows of the section above: their cells are not where that
      // section's columns stand, so the statement is refused.
      assert.match(refusal(edited((pages) => dropLine(pages, 'Daily Balance Summary'))), /Deposits \/ Credits row's amount or description is not in the column its heading prints/);
    });

    it('a row dated outside the period', () => {
      assert.match(refusal(edited((pages) => replaceText(pages, '09/08', '10/08'))), /not dated in the statement period/);
    });
  });

  it('describes its layout without a value, to tell why a statement was refused', () => {
    const layout = describeFifthThirdStatementLayout(statement());
    assert.deepEqual(layout.summaryFound, ['opening', 'checks', 'withdrawals', 'deposits', 'closing']);
    const counts = { misplaced: 0, wrapped: 0, skipped: 0, unread: 0 };
    assert.deepEqual(layout.sections, {
      'Checks': { headings: 1, withTotal: 1, columnOrder: null, rows: 1, noise: 2, ...counts },
      'Withdrawals / Debits': { headings: 2, withTotal: 1, columnOrder: 'Date Amount Description', rows: 7, noise: 3, ...counts, wrapped: 1 },
      'Deposits / Credits': { headings: 1, withTotal: 1, columnOrder: 'Date Amount Description', rows: 2, noise: 0, ...counts },
      'Daily Balance Summary': { headings: 1, withTotal: 0, columnOrder: null, rows: 2, noise: 2, ...counts },
    });
    const broken = describeFifthThirdStatementLayout(edited((pages) => replaceText(pages, '987.65', '987.6S')));
    const json = JSON.stringify(broken);
    for (const value of FIXTURE_VALUES) assert.ok(!json.includes(value), `shows ${value}`);
    assert.ok((broken.unreadShapes as Array<{ shape: string }>).some((entry) => entry.shape === 'Withdrawals / Debits: <mm/dd> <w> <w> <w> <w> <w>'));
  });

  it('is found by its first page and parses through the adapter interface', () => {
    assert.deepEqual(detectCheckingExportAdapters({ kind: 'pdf', pages: statement() }).map((adapter) => adapter.source), [FIFTH_THIRD_STATEMENT_SOURCE]);
    assert.equal(fifthThirdStatementAdapter.detect({ kind: 'text', text: 'Fifth Third Statement Period Date' }), false);
    assert.deepEqual(fifthThirdStatementAdapter.parse({ kind: 'pdf', pages: statement() }, {}), parseFifthThirdStatement(statement()));
    assert.deepEqual(fifthThirdStatementAdapter.describe!({ kind: 'pdf', pages: statement() }), describeFifthThirdStatementLayout(statement()));
    assert.throws(() => fifthThirdStatementAdapter.parse({ kind: 'pdf', pages: statement() }, { accountLast4: '8765' }), /is for account 4321, not the one --account names/);
    assert.throws(() => fifthThirdStatementAdapter.parse({ kind: 'text', text: '' }, {}), CheckingExportFormatError);
  });
});
