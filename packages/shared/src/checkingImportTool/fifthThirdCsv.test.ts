import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import {
  describeFifthThirdCsvLayout,
  FIFTH_THIRD_CSV_LAYOUTS,
  FIFTH_THIRD_CSV_SOURCE,
  FIFTH_THIRD_INSTITUTION,
  fifthThirdCsvAdapter,
  looksLikeFifthThirdCsv,
  parseFifthThirdCsv,
  runningBalanceBreaks,
} from './fifthThirdCsv.js';
import { detectCheckingExportAdapters } from './adapters.js';
import { CheckingConvertError, convertCheckingExports } from './convert.js';
import { CheckingExportFormatError, type ParsedCheckingRow } from './parsed.js';

const fixtureText = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/fifththird/${name}`, import.meta.url)), 'utf8');
/** Fifth Third's own export layout: `Date,Description,Check Number,Amount`, blocks of days each newest first, no balance. */
const EXPORT = fixtureText('activity.csv');
/** The same month with a running Balance column: a layout read only when the format is given. */
const BALANCED = fixtureText('activity-balance.csv');
const lines = (text: string) => text.split(/\r?\n/).filter((line) => line !== '');
const header = (text: string) => lines(text)[0];
const body = (text: string) => lines(text).slice(1);
const csv = (head: string, rows: readonly string[]) => `${[head, ...rows].join('\r\n')}\r\n`;

/** Values of the synthetic fixture that must never appear in a message. */
const FIXTURE_VALUES = [
  'GROCERY', 'PAYROLL', 'CHASE', 'AMEX', 'SAVINGS', '9876', '1042', '42.17', '1,234.56', '1234.56', '3,200.00', '987.65',
  '2,532.57', '2,543.57', '5,700.00', '500.00', '11.00', '0.12',
];

function assertValueFree(message: string): void {
  for (const value of FIXTURE_VALUES) assert.ok(!message.includes(value), `message shows a value: ${value}`);
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof CheckingExportFormatError, `expected a format refusal, got ${String(error)}`);
    assertValueFree(error.message);
    return error.message;
  }
  assert.fail('expected the file to be refused');
}

const amounts = (rows: readonly ParsedCheckingRow[]) => rows.map((row) => row.amountMinor);
const dayAmounts = (rows: readonly ParsedCheckingRow[]) => rows.map((row) => `${row.postedDate} ${row.amountMinor}`).sort();

describe('Fifth Third activity CSV', () => {
  it('reads Fifth Third\'s own export: blocks of days each newest first, no balance, put in date order with exact cents', () => {
    const { parsed, report } = parseFifthThirdCsv(EXPORT);
    assert.deepEqual(detectCheckingExportAdapters({ kind: 'text', text: EXPORT }).map((adapter) => adapter.source), [FIFTH_THIRD_CSV_SOURCE]);
    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(parsed.droppedColumns, []);
    assert.equal(report.fileOrder, 'unsorted');
    assert.equal(report.balancePairsChecked, 0);
    assert.deepEqual(parsed.rows.map((row) => row.postedDate), [
      '2026-09-01', '2026-09-01', '2026-09-02', '2026-09-02', '2026-09-03', '2026-09-03', '2026-09-03', '2026-09-08',
      '2026-09-15', '2026-09-30',
    ]);
    assert.deepEqual(amounts(parsed.rows), [320000, -10000, -123456, -98765, -25000, -4217, -4217, -50000, 12, -1100]);
    // Within a day, the other way round from the file, as with every Fifth Third listing.
    assert.deepEqual(parsed.rows.map((row) => row.line), [8, 7, 6, 5, 4, 3, 2, 11, 10, 9]);
    assert.ok(parsed.rows.every((row) => row.runningBalanceMinor === null && !row.pending && row.externalId === null));
    assert.equal(parsed.rows.find((row) => row.checkNumber !== null)?.checkNumber, '1042');
    assert.deepEqual(parsed.notes, ['the rows were listed in blocks of days rather than in date order; they were put in date order']);
    // The same days and amounts as the month with a running balance.
    assert.deepEqual(dayAmounts(parsed.rows), dayAmounts(parseFifthThirdCsv(BALANCED).parsed.rows));
  });

  it('reads the export the same in any row order, since nothing in it depends on the order', () => {
    const rows = body(EXPORT);
    for (const order of [[...rows].reverse(), [rows[9], rows[0], rows[5], rows[1], rows[8], rows[2], rows[7], rows[3], rows[6], rows[4]]]) {
      const parsed = parseFifthThirdCsv(csv(header(EXPORT), order)).parsed;
      assert.deepEqual(dayAmounts(parsed.rows), dayAmounts(parseFifthThirdCsv(EXPORT).parsed.rows));
      assert.deepEqual(parsed.rows.map((row) => row.postedDate), [...parsed.rows.map((row) => row.postedDate)].sort());
    }
  });

  it('reads every row with exact cents, oldest first, with its check number and running balance', () => {
    const { parsed, report } = parseFifthThirdCsv(BALANCED);
    assert.equal(parsed.institution, FIFTH_THIRD_INSTITUTION);
    assert.equal(parsed.source, FIFTH_THIRD_CSV_SOURCE);
    assert.equal(parsed.currency, 'USD');
    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(parsed.droppedColumns, []);
    assert.equal(report.fileOrder, 'newest-first');
    assert.equal(report.balancePairsChecked, 9);
    assert.deepEqual(parsed.rows.map((row) => row.postedDate), [
      '2026-09-01', '2026-09-01', '2026-09-02', '2026-09-02', '2026-09-03', '2026-09-03', '2026-09-03', '2026-09-08',
      '2026-09-15', '2026-09-30',
    ]);
    assert.deepEqual(amounts(parsed.rows), [320000, -10000, -123456, -98765, -25000, -4217, -4217, -50000, 12, -1100]);
    assert.deepEqual(parsed.rows.map((row) => row.runningBalanceMinor), [
      570000, 560000, 436544, 337779, 312779, 308562, 304345, 254345, 254357, 253257,
    ]);
    const check = parsed.rows.find((row) => row.checkNumber !== null)!;
    assert.equal(check.checkNumber, '1042');
    assert.equal(check.amountMinor, -25000);
    assert.equal(parsed.rows.filter((row) => row.pending).length, 0);
    assert.ok(parsed.rows.every((row) => row.externalId === null && row.transactionDate === null));
    // Opening balance + credits - debits = closing balance, from the bank's own running balance.
    const first = parsed.rows[0];
    const opening = first.runningBalanceMinor! - first.amountMinor;
    const credits = parsed.rows.filter((row) => row.amountMinor > 0).reduce((sum, row) => sum + row.amountMinor, 0);
    const debits = parsed.rows.filter((row) => row.amountMinor < 0).reduce((sum, row) => sum - row.amountMinor, 0);
    assert.equal(opening, 250000);
    assert.equal(credits, 320012);
    assert.equal(debits, 316755);
    assert.equal(opening + credits - debits, parsed.rows.at(-1)!.runningBalanceMinor);
  });

  it('keeps line numbers of the file for every row', () => {
    const { parsed } = parseFifthThirdCsv(BALANCED);
    assert.deepEqual(parsed.rows.map((row) => row.line), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it('reads the same rows from a file listed oldest first', () => {
    const reversed = csv(header(BALANCED), [...body(BALANCED)].reverse());
    const { parsed, report } = parseFifthThirdCsv(reversed);
    assert.equal(report.fileOrder, 'oldest-first');
    assert.deepEqual(amounts(parsed.rows), amounts(parseFifthThirdCsv(BALANCED).parsed.rows));
  });

  it('turns a day round when only the other order chains its running balances', () => {
    const rows = body(BALANCED);
    // Newest first by date, but the three rows of 09/03 in posting order.
    const mixedDay = [...rows.slice(0, 3), rows[5], rows[4], rows[3], ...rows.slice(6)];
    const { parsed, report } = parseFifthThirdCsv(csv(header(BALANCED), mixedDay));
    assert.equal(report.daysTurned, 1);
    assert.deepEqual(amounts(parsed.rows), amounts(parseFifthThirdCsv(BALANCED).parsed.rows));
    assert.deepEqual(runningBalanceBreaks(parsed.rows).breaks, []);
  });

  it('refuses a file whose running balance breaks, naming the line only', () => {
    const rows = body(BALANCED);
    const missing = [...rows.slice(0, 6), ...rows.slice(7)];
    const message = refusal(() => parseFifthThirdCsv(csv(header(BALANCED), missing)));
    assert.match(message, /running balance does not follow from the amounts at line \d+/);
    assert.match(message, /rows are missing or the export was edited/);
    const edited = rows.map((row) => row.replace('-987.65', '-987.66'));
    assert.match(refusal(() => parseFifthThirdCsv(csv(header(BALANCED), edited))), /running balance/);
  });

  it('names the unreadable row when it is what breaks the chain', () => {
    const rows = body(BALANCED).map((row) => row.replace('-987.65', '-98x.65'));
    const message = refusal(() => parseFifthThirdCsv(csv(header(BALANCED), rows)));
    assert.match(message, /1 row could not be read \(line 8: Amount is not a number\)/);
  });

  it('gives the same posted dates and amounts when the bank changes descriptors', () => {
    const drifted = BALANCED
      .replace('POS PURCHASE SAMPLE GROCERY,-42.17,,"3,043.45"', 'POS PURCHASE SAMPLE GROCERY #0042 SAMPLE CITY OH,-42.17,,"3,043.45"')
      .replace('AMEX EPAYMENT ACH PMT', 'AMERICAN EXPRESS ACH PMT EPAYMENT')
      .replace('ATM WITHDRAWAL SAMPLE ST', 'ATM WITHDRAWAL 0901 SAMPLE ST');
    assert.notEqual(drifted, BALANCED);
    const before = parseFifthThirdCsv(BALANCED).parsed.rows;
    const after = parseFifthThirdCsv(drifted).parsed.rows;
    assert.notDeepEqual(after.map((row) => row.description), before.map((row) => row.description));
    assert.deepEqual(dayAmounts(after), dayAmounts(before));
  });

  it('reads Debit and Credit columns as money out and in', () => {
    const split = csv('Date,Description,Debit,Credit,Balance', [
      '09/02/2026,AMEX EPAYMENT ACH PMT,987.65,,"3,377.79"',
      '09/02/2026,WEB INITIATED PAYMENT AT CHASE CREDIT CRD EPAY,"1,234.56",,"4,365.44"',
      '09/01/2026,ATM WITHDRAWAL SAMPLE ST,100.00,,"5,600.00"',
      '09/01/2026,DIRECT DEPOSIT CONTOSO PAYROLL,,"3,200.00","5,700.00"',
    ]);
    assert.deepEqual(amounts(parseFifthThirdCsv(split).parsed.rows), [320000, -10000, -123456, -98765]);
    const both = csv('Date,Description,Debit,Credit', ['09/01/2026,X,1.00,2.00']);
    assert.deepEqual(parseFifthThirdCsv(both).parsed.problems, [{ line: 2, reason: 'has both a Debit and a Credit' }]);
    const neither = csv('Date,Description,Debit,Credit', ['09/01/2026,X,,']);
    assert.deepEqual(parseFifthThirdCsv(neither).parsed.problems, [{ line: 2, reason: 'has neither a Debit nor a Credit' }]);
    const negativeCredit = csv('Date,Description,Debit,Credit', ['09/01/2026,X,,-2.00']);
    assert.deepEqual(parseFifthThirdCsv(negativeCredit).parsed.problems, [{ line: 2, reason: 'Credit is negative' }]);
  });

  it('reads amounts exactly and refuses fractions of a cent', () => {
    const file = csv('Date,Description,Amount', [
      '09/03/2026,A,$1.10',
      '09/02/2026,B,($2.20)',
      '09/02/2026,C,-0.07',
      '09/01/2026,D,1.234',
      '09/01/2026,E,12.3.4',
    ]);
    const { parsed } = parseFifthThirdCsv(file);
    assert.deepEqual(amounts(parsed.rows), [-7, -220, 110]);
    assert.deepEqual(parsed.problems, [
      { line: 5, reason: 'Amount has more than 2 decimal places' },
      { line: 6, reason: 'Amount is not a number' },
    ]);
  });

  it('keeps pending rows apart from the running balance', () => {
    const file = csv('Date,Description,Amount,Balance,Status', [
      '10/01/2026,PENDING CARD PURCHASE,-25.00,,Pending',
      '09/30/2026,MONTHLY SERVICE FEE,-11.00,"2,532.57",Posted',
      '09/15/2026,INTEREST PAID,0.12,"2,543.57",Posted',
    ]);
    const { parsed } = parseFifthThirdCsv(file);
    assert.deepEqual(parsed.rows.map((row) => row.pending), [false, false, true]);
    const unknown = csv('Date,Description,Amount,Status', ['09/15/2026,X,1.00,Maybe']);
    assert.deepEqual(parseFifthThirdCsv(unknown).parsed.problems, [{ line: 2, reason: 'Status is neither Pending nor Posted' }]);
  });

  it('drops columns it does not read, naming plain headers only', () => {
    const file = csv('Date,Description,Amount,Memo,Ref 123456789', ['09/15/2026,INTEREST PAID,0.12,SECRET MEMO,77777777']);
    const { parsed } = parseFifthThirdCsv(file);
    assert.deepEqual(parsed.droppedColumns, ['Memo', 'column 5']);
    assert.equal(parsed.rows[0].sourceTexts.includes('SECRET MEMO'), false);
    assert.ok(!JSON.stringify(parsed.rows).includes('77777777'));
  });

  it('keeps an account number only for the leak check and its last four digits', () => {
    const file = csv('Date,Description,Amount,Account Number', ['09/15/2026,INTEREST PAID,0.12,XXXXXX4321']);
    const { parsed } = parseFifthThirdCsv(file);
    assert.equal(parsed.accountLast4, '4321');
    assert.equal(parsed.accountNumberRaw, 'XXXXXX4321');
    const two = csv('Date,Description,Amount,Account Number', ['09/15/2026,A,0.12,XXXXXX4321', '09/14/2026,B,0.12,XXXXXX8765']);
    assert.match(refusal(() => parseFifthThirdCsv(two)), /more than one account \(2\)/);
  });

  it('keeps one account identity: whole numbers must agree, and the richest cell is kept (review C15, C16, Root ruling)', () => {
    const head = 'Date,Description,Amount,Account Number';
    // Two whole numbers that share their last four are two accounts.
    assert.match(refusal(() => parseFifthThirdCsv(csv(head, ['09/15/2026,A,0.12,9990004321', '09/14/2026,B,0.12,8880004321']))), /more than one account \(2\)/);
    assert.match(refusal(() => parseFifthThirdCsv(csv(head, ['09/15/2026,A,0.12,XXX0004321', '09/14/2026,B,0.12,XXX1114321']))), /more than one account \(2\)/);
    // A cell that is not one account number is a row problem, never cut back to its last digits.
    assert.deepEqual(parseFifthThirdCsv(csv(head, ['09/15/2026,A,0.12,XXXXXX4321 5678'])).parsed.problems,
      [{ line: 2, reason: 'Account Number is not one account number' }]);
    // Masked and whole printings of one account: the whole number is kept, before or after the masked one, so a row
    // showing it is masked in the payload.
    for (const cells of [['XXXXXX4321', '9990004321'], ['9990004321', 'XXXXXX4321']]) {
      const file = csv(head, [`09/15/2026,TRANSFER REF 9990004321,-1.00,${cells[0]}`, `09/14/2026,INTEREST PAID,0.12,${cells[1]}`]);
      const { parsed } = parseFifthThirdCsv(file);
      assert.deepEqual([parsed.accountLast4, parsed.accountNumberRaw], ['4321', '9990004321']);
      const { payload } = convertCheckingExports([{ name: 'file 1', parsed }], { institution: 'fifththird', label: 'Fifth Third Checking', through: '2026-09-15' });
      assert.ok(!JSON.stringify(payload).includes('9990004321'));
      assert.deepEqual(payload.segments[0].rows.map((row) => row.description), ['INTEREST PAID', 'TRANSFER REF ***4321']);
    }
    // Cells that agree but show different digits prove more together: their union is kept, and every cell is known to
    // the guard, so five consecutive digits only the second cell shows are masked too (V07, Root ruling).
    const partial = parseFifthThirdCsv(csv(head, ['09/15/2026,TRANSFER REF 00043,-1.00,999X004321', '09/14/2026,INTEREST PAID,0.12,XXX0004321'])).parsed;
    assert.deepEqual([partial.accountLast4, partial.accountNumberRaw, partial.otherAccountNumbersRaw], ['4321', '9990004321', ['999X004321', 'XXX0004321']]);
    const masked = convertCheckingExports([{ name: 'file 1', parsed: partial }], { institution: 'fifththird', label: 'Fifth Third Checking', through: '2026-09-15' }).payload;
    assert.ok(masked.segments[0].rows.every((row) => !row.description.replace(/[^0-9]/g, '').includes('00043')));
    // Five consecutive digits that only the two cells together show are masked as well (V08).
    const together = parseFifthThirdCsv(csv(head, ['09/15/2026,TRANSFER REF 12345,-1.00,12X45678', '09/14/2026,INTEREST PAID,0.12,XX345678'])).parsed;
    assert.equal(together.accountNumberRaw, '12345678');
    const unioned = convertCheckingExports([{ name: 'file 1', parsed: together }], { institution: 'fifththird', label: 'Fifth Third Checking', through: '2026-09-15' }).payload;
    assert.ok(unioned.segments[0].rows.every((row) => !row.description.replace(/[^0-9]/g, '').includes('12345')));
  });

  it('guards text fields, never dates, against the account\'s digits; each field on its own (Root ruling on the guard\'s scope)', () => {
    const head = 'Date,Description,Check Number,Amount,Account Number';
    const options = { institution: 'fifththird', label: 'Fifth Third Checking', through: '2026-09-02' };
    const convert = (rows: string[]) => convertCheckingExports([{ name: 'file 1', parsed: parseFifthThirdCsv(csv(head, rows)).parsed }], options);
    // A five-digit account number that dates such as 2026-09-01 contain: the dates are no account number.
    const { payload } = convert(['09/02/2026,INTEREST PAID,,0.12,20260', '09/01/2026,PAYROLL,,1.00,20260']);
    assert.deepEqual(payload.segments[0].rows.map((row) => row.postedDate), ['2026-09-01', '2026-09-02']);
    assert.deepEqual(payload.account.last4, '0260');
    // In a text field the same digits are masked, as a run or split by other characters (or the row is refused), while
    // the dates, which hold them too, are left as they are.
    const projected = (text: string | null) => (text ?? '').replace(/[^0-9]/g, '');
    const masked = convert(['09/02/2026,TRANSFER REF 20260,,-1.00,20260', '09/01/2026,PAYROLL,,1.00,20260']).payload;
    assert.ok(masked.segments[0].rows.some((row) => row.description === 'TRANSFER REF ***0260'));
    for (const description of ['TRANSFER REF 2026-0', 'TRANSFER REF 2 0 2 6 0', 'REF 1202601']) {
      let written: string | null = null;
      try {
        const { payload } = convert([`09/02/2026,${description},,-1.00,20260`, '09/01/2026,PAYROLL,,1.00,20260']);
        assert.ok(payload.segments[0].rows.every((row) => !projected(row.description).includes('20260') && !projected(row.checkNumber).includes('20260')), description);
        assert.deepEqual(payload.segments[0].rows.map((row) => row.postedDate), ['2026-09-01', '2026-09-02']);
        written = JSON.stringify(payload);
      } catch (error) {
        assert.ok(error instanceof CheckingConvertError, `${description}: ${String(error)}`);
      }
      if (written !== null) assert.ok(written.includes('2026-09-02'));
    }
    // Fields are never joined: a description ending in 202 beside check number 60 shows no account number.
    const apart = convert(['09/02/2026,CHECK 202,60,-1.00,20260', '09/01/2026,PAYROLL,,1.00,20260']).payload;
    assert.deepEqual(apart.segments[0].rows.map((row) => [row.description, row.checkNumber]), [['PAYROLL', null], ['CHECK 202', '60']]);
  });

  it('takes the account identity from every cell, a row it cannot read included (review C18)', () => {
    const head = 'Date,Description,Amount,Account Number';
    // A quoted description over 9,998 lines puts the second record, the only one with the whole number, on line 10000.
    const tall = (account: string) => csv(head, [`09/02/2026,"S${'\n'.repeat(9997)}",-1.00,XXXXXX4321`, `09/01/2026,SYNTHETIC,PRIVATE_PAYEE_ZEBRA,${account}`]);
    const { parsed } = parseFifthThirdCsv(tall('1000034321'));
    assert.deepEqual([parsed.accountLast4, parsed.accountNumberRaw], ['4321', '1000034321']);
    // The problem's line stays the integer it is; the message naming it is what the converter masks.
    assert.deepEqual(parsed.problems, [{ line: 10000, reason: 'Amount is not a number' }]);
    assert.throws(() => convertCheckingExports([{ name: 'file 1', parsed }], { institution: 'fifththird', label: 'Fifth Third Checking', through: '2026-09-30' }),
      (error: Error) => error instanceof CheckingConvertError && /Amount is not a number/.test(error.message) && !error.message.includes('10000'));
    // A cell that is not one account number is a row problem, and still known to the guard.
    const unread = parseFifthThirdCsv(tall('1000034321 X')).parsed;
    assert.deepEqual([unread.accountNumberRaw, unread.otherAccountNumbersRaw], ['XXXXXX4321', ['1000034321 X']]);
    assert.throws(() => convertCheckingExports([{ name: 'file 1', parsed: unread }], { institution: 'fifththird', label: 'Fifth Third Checking', through: '2026-09-30' }),
      (error: Error) => error instanceof CheckingConvertError && !error.message.includes('10000'));
  });

  it('carries the account numbers it read in every later refusal, for the converter\'s guard, never showing them', () => {
    // What agreeing cells prove only together is carried as well (V10, Root ruling 03:37Z).
    try {
      parseFifthThirdCsv(csv('Date,Description,Amount,Debit/Credit,Account Number', ['09/03/2026,A,1.00,Debit,100X034321', '09/02/2026,B,-2.00,Debit,XXX0034321']));
      assert.fail('expected a refusal');
    } catch (error) {
      assert.ok(error instanceof CheckingExportFormatError);
      assert.match(error.message, /1 of 2 amounts are signed against their Type column/);
      assert.deepEqual(error.accountNumbersRaw.filter((raw) => /^[0-9X]+$/.test(raw)).sort(), ['1000034321', '100X034321', 'XXX0034321']);
    }
    const rows = ['09/30/2026,FEE,11.00', '09/15/2026,INTEREST,0.12', '09/08/2026,TRANSFER,500.00', '09/03/2026,POS,42.17', '09/01/2026,PAYROLL,1.00']
      .map((row, index) => `${row},${index === 2 ? '9990004321' : 'XXXXXX4321'}`);
    try {
      parseFifthThirdCsv(csv('Date,Description,Amount,Account Number', rows));
      assert.fail('expected a refusal');
    } catch (error) {
      assert.ok(error instanceof CheckingExportFormatError);
      assert.match(error.message, /no amount in this file is negative/);
      assert.ok(![JSON.stringify(error), inspect(error), error.message].some((shown) => shown.includes('9990004321')));
      assert.ok(error.accountNumbersRaw.includes('9990004321'));
    }
  });

  it('a mistyped whole account number in --account is refused before anything is read, never echoed (review P2)', () => {
    assert.throws(() => parseFifthThirdCsv(BALANCED, { accountLast4: '9990004321' }),
      (error: Error) => error.message === '--account must be the last four digits of the account number');
    assert.throws(() => fifthThirdCsvAdapter.parse({ kind: 'text', text: 'not even a CSV "' }, { accountLast4: '9990004321' }),
      (error: Error) => error.message === '--account must be the last four digits of the account number');
    const withAccount = csv('Date,Description,Amount,Account Number', ['09/15/2026,INTEREST PAID,0.12,XXXXXX4321']);
    assert.throws(() => parseFifthThirdCsv(withAccount, { accountLast4: '8765' }),
      (error: Error) => error.message === 'this file is for account 4321, not the one --account names');
    assert.equal(parseFifthThirdCsv(withAccount, { accountLast4: '4321' }).parsed.accountLast4, '4321');
  });

  it('refuses a lone Transaction Date, which is not a posting date, and keeps one beside a posting Date (Root ruling)', () => {
    const file = csv('Transaction Date,Description,Amount,Balance', [
      '09/15/2026,INTEREST PAID,0.12,"2,543.57"',
      '09/08/2026,ONLINE TRANSFER TO SAVINGS XXXXXX9876,-500.00,"2,543.45"',
    ]);
    assert.match(refusal(() => parseFifthThirdCsv(file)), /has a Transaction Date but no posting Date column/);
    const both = csv('Posted Date,Transaction Date,Description,Amount', ['09/15/2026,09/14/2026,INTEREST PAID,0.12']);
    assert.deepEqual(parseFifthThirdCsv(both).parsed.rows.map((row) => [row.postedDate, row.transactionDate]), [['2026-09-15', '2026-09-14']]);
  });

  it('with an explicit format, reads an unknown header only when each required column is named exactly once (Root ruling)', () => {
    const rows = ['09/15/2026,INTEREST PAID,0.12,X'];
    assert.equal(parseFifthThirdCsv(csv('Date,Description,Amount,Unused', rows)).parsed.rows.length, 1);
    assert.match(refusal(() => parseFifthThirdCsv(csv('Date,Description,Unused,Other', rows))), /does not look like a Fifth Third activity CSV/);
    assert.match(refusal(() => parseFifthThirdCsv(csv('Date,Posted Date,Description,Amount', ['09/15/2026,09/15/2026,X,0.12']))), /more than one Date column/);
    assert.match(refusal(() => parseFifthThirdCsv(csv('Date,Description,Transaction Description,Amount', ['09/15/2026,X,Y,0.12']))), /more than one Description column/);
    assert.match(refusal(() => parseFifthThirdCsv(csv('Date,Description,Amount,Transaction Amount', ['09/15/2026,X,0.12,0.12']))), /more than one Amount column/);
    assert.match(refusal(() => parseFifthThirdCsv(csv('Date,Description,Amount,Credit', ['09/15/2026,X,0.12,0.12']))), /one or the other/);
    assert.match(refusal(() => parseFifthThirdCsv(csv('Date,Description,Debit', ['09/15/2026,X,0.12']))), /does not look like a Fifth Third activity CSV/);
  });

  it('refuses amounts it cannot tell the direction of, rather than guess', () => {
    const typed = csv('Date,Description,Amount,Debit/Credit', [
      '09/03/2026,POS PURCHASE SAMPLE GROCERY,42.17,Debit',
      '09/02/2026,AMEX EPAYMENT ACH PMT,987.65,Debit',
      '09/01/2026,DIRECT DEPOSIT CONTOSO PAYROLL,"3,200.00",Credit',
    ]);
    assert.match(refusal(() => parseFifthThirdCsv(typed)), /2 of 3 amounts are signed against their Type column/);
    const unsigned = csv('Date,Description,Amount', [
      '09/30/2026,MONTHLY SERVICE FEE,11.00', '09/15/2026,INTEREST PAID,0.12', '09/08/2026,ONLINE TRANSFER,500.00',
      '09/03/2026,POS PURCHASE,42.17', '09/02/2026,EPAY,987.65', '09/01/2026,PAYROLL,"3,200.00"',
    ]);
    assert.match(refusal(() => parseFifthThirdCsv(unsigned)), /no amount in this file is negative/);
    // Consistent labels and a few deposits only are fine.
    const signed = csv('Date,Description,Amount,Debit/Credit', ['09/03/2026,POS PURCHASE,-42.17,Debit', '09/01/2026,PAYROLL,"3,200.00",Credit']);
    assert.deepEqual(parseFifthThirdCsv(signed).parsed.rows.map((row) => row.typeHint), ['CREDIT', 'DEBIT']);
    const deposits = csv('Date,Description,Amount', ['09/15/2026,INTEREST PAID,0.12', '09/01/2026,PAYROLL,"3,200.00"']);
    assert.equal(parseFifthThirdCsv(deposits).parsed.rows.length, 2);
  });

  it('refuses one amount signed against its type, never outvoted by rows that agree, pending ones included (review)', () => {
    const header = 'Date,Description,Amount,Debit/Credit,Status';
    const minority = csv(header, ['09/03/2026,A,-1.00,Debit,Posted', '09/02/2026,B,99.00,Debit,Posted', '09/01/2026,C,2.00,Credit,Posted']);
    assert.match(refusal(() => parseFifthThirdCsv(minority)), /1 of 3 amounts are signed against their Type column \(money out must be negative\), first at line 3/);
    const diluted = csv(header, ['09/03/2026,A,1.00,Debit,Posted', '09/02/2026,B,-2.00,Debit,Pending', '09/01/2026,C,-3.00,Debit,Pending']);
    assert.match(refusal(() => parseFifthThirdCsv(diluted)), /1 of 3 amounts are signed against their Type column/);
    // Types that prove every row's direction are not refused for being all money in.
    const credits = csv(header, Array.from({ length: 5 }, (_, index) => `09/0${5 - index}/2026,INTEREST,1.00,Credit,Posted`));
    assert.deepEqual(parseFifthThirdCsv(credits).parsed.rows.map((row) => row.amountMinor), [100, 100, 100, 100, 100]);
    const untypedCredits = csv(header, [...Array.from({ length: 4 }, (_, index) => `09/0${5 - index}/2026,INTEREST,1.00,Credit,Posted`), '09/01/2026,X,1.00,,Posted']);
    assert.match(refusal(() => parseFifthThirdCsv(untypedCredits)), /no amount in this file is negative/);
  });

  it('describes its layout without a cell or header text', () => {
    assert.deepEqual(fifthThirdCsvAdapter.describe!({ kind: 'text', text: EXPORT }), {
      readable: true, headerRead: true, knownLayout: true, columns: ['Date', 'Description', 'Check Number', 'Amount'], dataRecords: 10, fieldCounts: { 4: 10 },
    });
    assert.deepEqual(fifthThirdCsvAdapter.describe!({ kind: 'text', text: BALANCED }), {
      readable: true, headerRead: true, knownLayout: false, columns: ['Date', 'Description', 'Amount', 'Check Number', 'Balance'], dataRecords: 10, fieldCounts: { 5: 10 },
    });
    const unknown = describeFifthThirdCsvLayout(csv('Posting Day,Payee SECRET,Amt', ['09/15/2026,CONTOSO,0.12']));
    assert.deepEqual(unknown, { readable: true, headerRead: false, knownLayout: false, columns: [null, null, null], dataRecords: 1, fieldCounts: { 3: 1 } });
    const broken = describeFifthThirdCsvLayout('Date,Description,Amount\r\n09/15/2026,"CONTOSO,0.12\r\n');
    assert.deepEqual(broken, { readable: false, reason: 'a quoted field is not closed (the file may be truncated)' });
    assert.ok(!JSON.stringify([unknown, broken]).includes('SECRET') && !JSON.stringify([unknown, broken]).includes('CONTOSO'));
  });

  it('reads check numbers as digits and leaves out labels that are not plain words', () => {
    const file = csv('Date,Description,Amount,Check Number,Type', [
      '09/15/2026,CHECK,-1.00,0001042,Check',
      '09/14/2026,DEBIT,-1.00,0,Debit Card 12345678',
      '09/13/2026,CHECK,-1.00,10A2,Check',
    ]);
    const { parsed } = parseFifthThirdCsv(file);
    assert.deepEqual(parsed.rows.map((row) => [row.checkNumber, row.typeHint]), [[null, null], ['1042', 'CHECK']]);
    assert.deepEqual(parsed.problems, [{ line: 4, reason: 'Check Number is not a number of at most 10 digits' }]);
    assert.deepEqual(parsed.notes, ['1 transaction type labels were not plain words and were left out']);
  });

  describe('refuses malformed input without showing a value', () => {
    it('a file that is not a Fifth Third activity CSV', () => {
      assert.match(refusal(() => parseFifthThirdCsv('')), /empty/);
      assert.match(refusal(() => parseFifthThirdCsv(body(BALANCED).join('\n'))), /does not look like a Fifth Third activity CSV/);
      assert.match(refusal(() => parseFifthThirdCsv(csv('Date,Description,Balance', ['09/30/2026,X,1.00']))), /Amount/);
      assert.match(refusal(() => parseFifthThirdCsv(csv('Date,Amount,Amount,Description', []))), /more than one Amount column/);
      assert.match(refusal(() => parseFifthThirdCsv(csv('Date,Description,Amount,Debit', []))), /one or the other/);
    });

    it('a truncated or mangled file', () => {
      const cut = BALANCED.slice(0, BALANCED.indexOf('"-1,234.56"') + 3);
      assert.match(refusal(() => parseFifthThirdCsv(cut)), /^the CSV is malformed: a quoted field is not closed/);
      const short = csv(header(BALANCED), ['09/30/2026,MONTHLY SERVICE FEE,-11.00']);
      assert.deepEqual(parseFifthThirdCsv(short).parsed.problems, [{ line: 2, reason: 'has 3 columns, the header has 5 (the file may be truncated)' }]);
      const long = csv(header(BALANCED), ['09/30/2026,MONTHLY SERVICE FEE,-11.00,,"2,532.57",SURPRISE']);
      assert.deepEqual(parseFifthThirdCsv(long).parsed.problems, [{ line: 2, reason: 'has 6 columns, the header has 5' }]);
    });

    it('dates that are not MM/DD/YYYY, and rows with a running balance out of date order', () => {
      const file = csv('Date,Description,Amount', ['2026-09-30,A,1.00', '13/01/2026,B,1.00', '09/31/2026,C,1.00', '9/1/26,D,1.00']);
      assert.deepEqual(parseFifthThirdCsv(file).parsed.problems.map((problem) => problem.line), [2, 3, 4, 5]);
      assert.ok(parseFifthThirdCsv(file).parsed.problems.every((problem) => problem.reason === 'Date is not a valid MM/DD/YYYY date'));
      const shuffled = csv(header(BALANCED), [body(BALANCED)[3], body(BALANCED)[0], body(BALANCED)[9]]);
      assert.match(refusal(() => parseFifthThirdCsv(shuffled)), /not in date order, so their running balance cannot be followed/);
    });
  });

  it('is found by its header and parses through the adapter interface', () => {
    assert.equal(looksLikeFifthThirdCsv(EXPORT), true);
    assert.equal(looksLikeFifthThirdCsv(`\ufeff${EXPORT.replace('Check Number', 'CHECK  NUMBER')}`), true);
    assert.equal(fifthThirdCsvAdapter.detect({ kind: 'text', text: EXPORT }), true);
    assert.equal(fifthThirdCsvAdapter.detect({ kind: 'text', text: '"09/30/2026","-11.00","*","","FEE"\n' }), false);
    assert.equal(fifthThirdCsvAdapter.detect({ kind: 'text', text: 'OFXHEADER:100\nDATA:OFXSGML\n<OFX>' }), false);
    assert.equal(fifthThirdCsvAdapter.detect({ kind: 'pdf', pages: [] }), false);
    assert.deepEqual(fifthThirdCsvAdapter.parse({ kind: 'text', text: EXPORT }, {}), parseFifthThirdCsv(EXPORT).parsed);
    assert.deepEqual(fifthThirdCsvAdapter.parse({ kind: 'text', text: BALANCED }, {}), parseFifthThirdCsv(BALANCED).parsed);
    assert.throws(() => fifthThirdCsvAdapter.parse({ kind: 'pdf', pages: [] }, {}), CheckingExportFormatError);
  });

  it('claims only its known header layouts, so another bank\'s CSV with the same words stays that bank\'s', () => {
    // Wells Fargo's current download: every column is one this reader knows, but the layout is not Fifth Third's.
    const wellsFargo = 'DATE,DESCRIPTION,AMOUNT,CHECK #,STATUS\r\n"09/30/2026","MONTHLY SERVICE FEE","-11.00","","Posted"\r\n';
    assert.equal(fifthThirdCsvAdapter.detect({ kind: 'text', text: wellsFargo }), false);
    assert.deepEqual(detectCheckingExportAdapters({ kind: 'text', text: wellsFargo }).map((adapter) => adapter.source), ['wf-csv']);
    // A header in another order, or with a Balance column, is read when the format is given, never picked on its own.
    const reordered = csv('Description,Date,Balance,Amount,Check Number', ['MONTHLY SERVICE FEE,09/30/2026,"2,532.57",-11.00,']);
    assert.deepEqual(detectCheckingExportAdapters({ kind: 'text', text: reordered }), []);
    assert.deepEqual(amounts(fifthThirdCsvAdapter.parse({ kind: 'text', text: reordered }, {}).rows), [-1100]);
    assert.deepEqual(detectCheckingExportAdapters({ kind: 'text', text: BALANCED }), []);
    assert.deepEqual(FIFTH_THIRD_CSV_LAYOUTS.map((layout) => layout.join(',')), [header(EXPORT)]);
  });
});
