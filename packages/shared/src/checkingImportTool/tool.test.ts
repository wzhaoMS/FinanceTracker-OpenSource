import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import { validateCheckingImportPayload } from '../checkingImport.js';
import { detectCheckingExportAdapters } from './adapters.js';
import { parseBankOfx } from './bankOfx.js';
import {
  CheckingConvertError,
  checkingCurrencyExponent,
  convertCheckingExports,
  knownAccountDigits,
  maskKnownAccountDigits,
  type CheckingConvertOptions,
} from './convert.js';
import { CheckingExportFormatError, type CheckingPdfPage, type CheckingPdfTextItem, type ParsedCheckingExport } from './parsed.js';
import { parseWellsFargoCsv } from './wellsFargoCsv.js';
import { describeWellsFargoStatementLayout, parseWellsFargoStatement } from './wellsFargoStatement.js';

// Synthetic only: every name, number and amount below is made up.
const ACCOUNT = '9876542931';

interface OfxRow { type: string; date: string; amount: string; fitid?: string; name: string; memo?: string; check?: string }

function qfx(rows: OfxRow[], options: { start?: string; end?: string; server?: string; ledger?: [string, string]; account?: string; accountType?: string } = {}): string {
  const at = (date: string) => `${date.replace(/-/g, '')}120000.000[-4:EDT]`;
  const trn = rows.map((row) => ['<STMTTRN>', `<TRNTYPE>${row.type}`, `<DTPOSTED>${at(row.date)}`, `<TRNAMT>${row.amount}`,
    ...(row.fitid ? [`<FITID>${row.fitid}`] : []), ...(row.check ? [`<CHECKNUM>${row.check}`] : []), `<NAME>${row.name}`,
    ...(row.memo ? [`<MEMO>${row.memo}`] : []), '</STMTTRN>'].join('\n')).join('\n');
  return [
    'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE', 'ENCODING:USASCII', 'CHARSET:1252', 'COMPRESSION:NONE',
    'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '',
    '<OFX>', '<SIGNONMSGSRSV1>', '<SONRS>', '<STATUS>', '<CODE>0', '<SEVERITY>INFO', '</STATUS>',
    `<DTSERVER>${at(options.server ?? '2026-10-21')}`, '<LANGUAGE>ENG', '</SONRS>', '</SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1>', '<STMTTRNRS>', '<TRNUID>1', '<STATUS>', '<CODE>0', '<SEVERITY>INFO', '</STATUS>', '<STMTRS>', '<CURDEF>USD',
    '<BANKACCTFROM>', '<BANKID>121000248', `<ACCTID>${options.account ?? ACCOUNT}`, `<ACCTTYPE>${options.accountType ?? 'CHECKING'}`, '</BANKACCTFROM>',
    '<BANKTRANLIST>', `<DTSTART>${at(options.start ?? '2026-10-01')}`, `<DTEND>${at(options.end ?? '2026-10-21')}`, trn, '</BANKTRANLIST>',
    ...(options.ledger ? ['<LEDGERBAL>', `<BALAMT>${options.ledger[0]}`, `<DTASOF>${at(options.ledger[1])}`, '</LEDGERBAL>'] : []),
    '</STMTRS>', '</STMTTRNRS>', '</BANKMSGSRSV1>', '</OFX>', '',
  ].join('\r\n');
}

const OCTOBER: OfxRow[] = [
  { type: 'DEBIT', date: '2026-10-02', amount: '-250.00', fitid: 'F1', name: 'AMEX EPAYMENT ACH PMT', memo: 'AMEX EPAYMENT ACH PMT 261002 W1234 SYNTHETIC HOLDER' },
  { type: 'CREDIT', date: '2026-10-05', amount: '3000.00', fitid: 'F2', name: 'SYNTHETIC PAYROLL', memo: 'DIR DEP 1234567890123456' },
  { type: 'DEBIT', date: '2026-10-05', amount: '-50.00', fitid: 'F3', name: 'ZELLE TO SYNTHETIC FRIEND' },
  { type: 'DEBIT', date: '2026-10-05', amount: '-50.00', fitid: 'F4', name: 'ATM WITHDRAWAL' },
  { type: 'CHECK', date: '2026-10-15', amount: '-120.00', fitid: 'F5', check: '1001', name: 'CHECK' },
  { type: 'DEBIT', date: '2026-10-21', amount: '-10.00', fitid: 'F6', name: 'SYNTHETIC COFFEE' },
];
// The October file's ledger balance, as of the day it was made: 5,010.00 at the end of 10-20, less 10.00 on 10-21.
const OCTOBER_QFX = qfx(OCTOBER, { ledger: ['5000.00', '2026-10-21'] });

const OCTOBER_CSV = [
  '"10/21/2026","-10.00","*","","SYNTHETIC COFFEE"',
  '"10/15/2026","-120.00","*","1001","CHECK"',
  '"10/05/2026","-50.00","*","","ATM WITHDRAWAL"',
  '"10/05/2026","-50.00","*","","ZELLE TO SYNTHETIC FRIEND"',
  '"10/05/2026","3000.00","*","","SYNTHETIC PAYROLL DIR DEP 1234567890123456"',
  '"10/02/2026","-250.00","*","","AMEX EPAYMENT ACH PMT 261002 W1234 SYNTHETIC HOLDER"',
  '',
].join('\r\n');

const W = 5;
const item = (text: string, x: number, y: number): CheckingPdfTextItem => ({ text, x, y, width: text.length * W });
const right = (text: string, edge: number, y: number): CheckingPdfTextItem => item(text, edge - text.length * W, y);
const header = (y: number): CheckingPdfTextItem[] => [
  item('Check', 75, y + 10), item('Deposits/', 380, y + 10), item('Withdrawals/', 445, y + 10), item('Ending daily', 515, y + 10),
  item('Date', 40, y), item('Number', 75, y), item('Description', 120, y), item('Additions', 380, y), item('Subtractions', 445, y), item('balance', 525, y),
];

/** A September statement laid out as Wells Fargo's: summary, then the table over two pages, rows over two lines. */
function septemberStatement(overrides: { withdrawalsTotal?: string; secondRowColumn?: 'deposits' | 'withdrawals' } = {}): CheckingPdfPage[] {
  const secondEdge = overrides.secondRowColumn === 'deposits' ? 420 : 490;
  return [
    { items: [
      item('Everyday Checking', 40, 760),
      item(`Account number: ${ACCOUNT}`, 40, 745), item('September 1, 2026 - September 30, 2026', 250, 745),
      item('Statement period activity summary', 40, 650),
      item('Beginning balance on 9/1', 40, 635), right('$2,000.00', 300, 635),
      item('Deposits/Additions', 40, 620), right('1,000.00', 300, 620),
      item('Withdrawals/Subtractions', 40, 605), right(overrides.withdrawalsTotal ?? '- 520.00', 300, 605),
      item('Ending balance on 9/30', 40, 590), right('$2,480.00', 300, 590),
      item('Transaction history', 40, 500),
      ...header(470),
      item('9/2', 40, 455), item('Online Transfer From Savings Ref #IB0SYNTH', 120, 455), right('1,000.00', 420, 455), right('3,000.00', 565, 455),
      item('9/10', 40, 440), item('1001', 75, 440), item('Check', 120, 440), right('120.00', secondEdge, 440),
      item('9/10', 40, 425), item('Purchase authorized on 09/08 Synthetic Store', 120, 425), right('80.00', 490, 425), right('2,800.00', 565, 425),
      item('S0000000000000001234 Card 5678', 120, 415),
      item('Sheet Seq = 0001', 40, 60),
      item('(c) 2026 Wells Fargo Bank, N.A. All rights reserved. Member FDIC.', 40, 40),
    ] },
    { items: [
      item(`Account number: ${ACCOUNT} September 1, 2026 - September 30, 2026 Page 2 of 2`, 40, 760),
      item('Transaction history (continued)', 40, 700),
      ...header(670),
      item('9/20', 40, 655), item('AMEX EPAYMENT ACH PMT 260920 W1234 SYNTHETIC HOLDER', 120, 655), right('320.00', 490, 655), right('2,480.00', 565, 655),
      item('Ending balance on 9/30', 120, 640), right('2,480.00', 565, 640),
      item('Totals', 120, 625), right('$1,000.00', 420, 625), right('$520.00', 490, 625),
      item('The Ending Daily Balance does not reflect any pending withdrawals or holds', 40, 600),
    ] },
  ];
}

const OPTIONS: CheckingConvertOptions = { institution: 'wellsfargo', label: 'Wells Fargo Everyday Checking' };

function convert(files: ParsedCheckingExport[], options: Partial<CheckingConvertOptions> = {}) {
  return convertCheckingExports(files.map((parsed, index) => ({ name: `file ${index + 1}`, parsed })), { ...OPTIONS, ...options });
}

/** Refused, with every issue naming files, lines, fields or dates, and none quoting a value. */
function refused(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: Error) => {
    assert.ok(error instanceof CheckingConvertError, error.message);
    assert.match(error.message, pattern);
    assert.ok(!/9876542931|1234567890123456|SYNTHETIC|5,010|3000\.00/.test(error.message), error.message);
    return true;
  });
}

describe('checking import tool: OFX bank statements', () => {
  it('reads a checking statement: posted rows oldest first, last four, ledger and when it was made', () => {
    const parsed = parseBankOfx(OCTOBER_QFX);
    assert.equal(parsed.accountLast4, '2931');
    assert.equal(parsed.accountType, 'CHECKING');
    assert.equal(parsed.madeAt, '2026-10-21');
    assert.deepEqual(parsed.coverage, { start: '2026-10-01', end: '2026-10-21' });
    assert.deepEqual(parsed.ledgerBalance, { amountMinor: 500000, asOf: '2026-10-21' });
    assert.deepEqual(parsed.rows.map((row) => row.amountMinor), [-25000, 300000, -5000, -5000, -12000, -1000]);
    assert.equal(parsed.rows[4].checkNumber, '1001');
    // A newest-first file reads the same.
    const reversed = parseBankOfx(qfx([...OCTOBER].reverse(), { ledger: ['5000.00', '2026-10-21'] }));
    assert.deepEqual(reversed.rows.map((row) => row.postedDate), parsed.rows.map((row) => row.postedDate));
  });

  it('refuses card statements, files with several accounts, other sign conventions and bank errors', () => {
    const card = OCTOBER_QFX.replace(/BANKMSGSRSV1/g, 'CREDITCARDMSGSRSV1').replace(/STMTTRNRS/g, 'CCSTMTTRNRS').replace(/STMTRS/g, 'CCSTMTRS')
      .replace(/<BANKACCTFROM>[\s\S]*?<\/BANKACCTFROM>/, '<CCACCTFROM>\r\n<ACCTID>4111111111111111\r\n</CCACCTFROM>');
    assert.throws(() => parseBankOfx(card), (error: Error) => error instanceof CheckingExportFormatError && /credit card statement/.test(error.message));
    const start = OCTOBER_QFX.indexOf('<STMTTRNRS>');
    const end = OCTOBER_QFX.indexOf('</STMTTRNRS>') + '</STMTTRNRS>'.length;
    const two = OCTOBER_QFX.slice(0, end) + OCTOBER_QFX.slice(start, end).replace(ACCOUNT, '1111229739') + OCTOBER_QFX.slice(end);
    // Several account blocks: read only when --account picks exactly one; the others are never read, only counted.
    assert.throws(() => parseBankOfx(two), (error: Error) => /holds 2 bank statements; choose one with --account LAST4$/.test(error.message) && !/2931|9739/.test(error.message));
    const picked = parseBankOfx(two, { accountLast4: '2931' });
    assert.equal(picked.accountLast4, '2931');
    assert.equal(picked.rows.length, OCTOBER.length);
    assert.deepEqual(picked.notes, ['1 other statement in the file was not read']);
    assert.deepEqual(picked.otherAccountNumbersRaw, ['1111229739']);
    assert.equal(parseBankOfx(two, { accountLast4: '9739' }).accountLast4, '9739');
    assert.throws(() => parseBankOfx(two, { accountLast4: '9999' }), (error: Error) => /no statement in this file is for the account --account names/.test(error.message) && !/2931|9739|9999/.test(error.message));
    const twins = OCTOBER_QFX.slice(0, end) + OCTOBER_QFX.slice(start, end) + OCTOBER_QFX.slice(end);
    assert.throws(() => parseBankOfx(twins, { accountLast4: '2931' }), /2 statements in this file are for the account --account names/);
    assert.throws(() => parseBankOfx(OCTOBER_QFX, { accountLast4: '9739' }), /no statement in this file is for the account --account names/);
    // A repeat inside the picked block refuses; one inside a block that is not read does not matter.
    const otherBlock = OCTOBER_QFX.slice(start, end).replace(ACCOUNT, '1111229739');
    const pickedRepeat = OCTOBER_QFX.slice(0, start) + OCTOBER_QFX.slice(start, end).replace('<CURDEF>USD', '<CURDEF>USD\r\n<CURDEF>EUR') + otherBlock + OCTOBER_QFX.slice(end);
    assert.throws(() => parseBankOfx(pickedRepeat, { accountLast4: '2931' }), /the statement repeats CURDEF/);
    assert.equal(parseBankOfx(pickedRepeat, { accountLast4: '9739' }).accountLast4, '9739');
    // A block whose identity is ambiguous makes every block ambiguous.
    const twoIds = OCTOBER_QFX.slice(0, end) + otherBlock.replace('<ACCTID>1111229739', '<ACCTID>1111229739\r\n<ACCTID>5555666677') + OCTOBER_QFX.slice(end);
    assert.throws(() => parseBankOfx(twoIds, { accountLast4: '2931' }), /an account block repeats ACCTID/);
    // Another account the file names is redacted in the picked account's rows like this one's.
    const mentioning = parseBankOfx(two.replace('<NAME>ATM WITHDRAWAL', '<NAME>ONLINE TRANSFER TO 1111229739'), { accountLast4: '2931' });
    const { payload } = convert([mentioning]);
    assert.ok(payload.segments[0].rows.some((row) => row.description === 'ONLINE TRANSFER TO ***9739'));
    assert.ok(!JSON.stringify(payload).includes('1111229739'));
    const inverted = qfx(OCTOBER.map((row) => ({ ...row, amount: row.amount.startsWith('-') ? row.amount.slice(1) : `-${row.amount}` })));
    assert.throws(() => parseBankOfx(inverted), /opposite of the usual bank sign/);
    const failed = OCTOBER_QFX.replace('<TRNUID>1\r\n<STATUS>\r\n<CODE>0', '<TRNUID>1\r\n<STATUS>\r\n<CODE>2000').replace(/<STMTRS>[\s\S]*<\/STMTRS>/, '');
    assert.throws(() => parseBankOfx(failed), /bank reported an error/);
    assert.throws(() => parseBankOfx('<!DOCTYPE x><OFX></OFX>'), /DTD/);
  });

  it('refuses anything it would otherwise have to skip or guess: repeats, stray rows, unreadable stated values, no account type', () => {
    const refuses = (text: string, pattern: RegExp) => assert.throws(() => parseBankOfx(text), (error: Error) => {
      assert.ok(error instanceof CheckingExportFormatError, error.message);
      assert.match(error.message, pattern);
      assert.ok(!/9876542931|4111111111111111|SYNTHETIC|250\.00/.test(error.message), error.message);
      return true;
    });
    const list = OCTOBER_QFX.slice(OCTOBER_QFX.indexOf('<BANKTRANLIST>'), OCTOBER_QFX.indexOf('</BANKTRANLIST>') + '</BANKTRANLIST>'.length);
    const extra = list.replace(/<STMTTRN>[\s\S]*<\/STMTTRN>/, '<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20261003\r\n<TRNAMT>-9.00\r\n<NAME>EXTRA\r\n</STMTTRN>');
    refuses(OCTOBER_QFX.replace('</BANKTRANLIST>', `</BANKTRANLIST>\r\n${extra}`), /the statement repeats BANKTRANLIST/);
    refuses(OCTOBER_QFX.replace('<LEDGERBAL>', '<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20261003\r\n<TRNAMT>-9.00\r\n<NAME>STRAY\r\n</STMTTRN>\r\n<LEDGERBAL>'),
      /transactions outside a transaction list/);
    refuses(OCTOBER_QFX.replace('<BALAMT>5000.00', '<BALAMT>5,000.00.00'), /LEDGERBAL is there but its BALAMT or DTASOF cannot be read/);
    refuses(OCTOBER_QFX.replace('<DTASOF>20261021120000.000[-4:EDT]', '<DTASOF>20261021250000.000[-4:EDT]'), /LEDGERBAL DTASOF/);
    refuses(OCTOBER_QFX.replace('</LEDGERBAL>', '</LEDGERBAL>\r\n<AVAILBAL>\r\n<BALAMT>not-readable\r\n<DTASOF>20261021\r\n</AVAILBAL>'), /AVAILBAL is there but/);
    refuses(OCTOBER_QFX.replace('<SEVERITY>INFO\r\n</STATUS>\r\n<STMTRS>', '<SEVERITY>INFO\r\n</STATUS>\r\n<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20261003\r\n<TRNAMT>-9.00\r\n<NAME>OUTSIDE\r\n</STMTTRN>\r\n<STMTRS>'),
      /transactions outside a transaction list/);
    assert.deepEqual(parseBankOfx(OCTOBER_QFX.replace('<DTPOSTED>20261002120000.000[-4:EDT]', '<DTPOSTED>20261002250000.000[-4:EDT]')).problems
      .map((problem) => problem.reason), ['DTPOSTED is missing or not a valid date and time']);
    refuses(OCTOBER_QFX.replace('<BALAMT>5000.00', '<BALAMT>5000.00\r\n<BALAMT>4000.00'), /LEDGERBAL repeats BALAMT/);
    refuses(OCTOBER_QFX.replace('<ACCTTYPE>CHECKING\r\n', ''), /no ACCTTYPE that OFX defines/);
    refuses(OCTOBER_QFX.replace('<ACCTTYPE>CHECKING', '<ACCTTYPE>SAVINGSPRIVATE'), /no ACCTTYPE that OFX defines/);
    assert.throws(() => parseBankOfx(OCTOBER_QFX.replace('<ACCTTYPE>CHECKING', '<ACCTTYPE>SAVINGSPRIVATE')), (error: Error) => !error.message.includes('PRIVATE'));
    refuses(OCTOBER_QFX.replace(/<BANKTRANLIST>[\s\S]*<\/BANKTRANLIST>/, ''), /has no BANKTRANLIST/);
    refuses(OCTOBER_QFX.replace(/<DTEND>[^\r\n]*\r\n/, ''), /does not state both DTSTART and DTEND/);
    refuses(OCTOBER_QFX.replace('<ACCTTYPE>CHECKING', '<ACCTTYPE>CHECKING\r\n<ACCTTYPE>SAVINGS'), /BANKACCTFROM repeats ACCTTYPE/);
    refuses(OCTOBER_QFX.replace('<DTSTART>20261001120000.000[-4:EDT]', '<DTSTART>2026-10-01'), /DTSTART \(where the transaction list starts\)/);
    refuses(OCTOBER_QFX.replace('<DTSTART>20261001', '<DTSTART>20261101'), /starts after it ends/);
    refuses(OCTOBER_QFX.replace('<DTSERVER>', '<DTSERVER>20261021\r\n<DTSERVER>'), /SONRS repeats DTSERVER/);
    // --account is never echoed, whatever it holds.
    assert.throws(() => parseBankOfx(OCTOBER_QFX, { accountLast4: '4111111111111111' }), (error: Error) =>
      /--account must be the last four digits/.test(error.message) && !error.message.includes('4111'));
    const malformedCheck = parseBankOfx(OCTOBER_QFX.replace('<CHECKNUM>1001', '<CHECKNUM>10-01'));
    assert.deepEqual(malformedCheck.problems.map((problem) => problem.reason), ['CHECKNUM is not 1 to 10 digits']);
    // A type OFX does not define is never kept (it could be any text of the file); the row still is.
    const oddType = convert([parseBankOfx(OCTOBER_QFX.replace('<TRNTYPE>CHECK', '<TRNTYPE>X98765429'))]);
    assert.equal(oddType.payload.segments[0].rows[4].bankType, null);
    assert.ok(!JSON.stringify(oddType).includes('X98765429'));
    // A check number holding five or more digits of the account number refuses: it cannot be redacted.
    refused(() => convert([parseBankOfx(OCTOBER_QFX.replace('<CHECKNUM>1001', '<CHECKNUM>6542931'))]), /would still show more than four digits/);
  });

  it('reads only a file whose every transaction and list belongs to one legitimate statement block with one list', () => {
    const refuses = (text: string, pattern: RegExp, accountLast4?: string) => assert.throws(() => parseBankOfx(text, { accountLast4 }), (error: Error) => {
      assert.ok(error instanceof CheckingExportFormatError, error.message);
      assert.match(error.message, pattern);
      return true;
    });
    const start = OCTOBER_QFX.indexOf('<STMTTRNRS>');
    const end = OCTOBER_QFX.indexOf('</STMTTRNRS>') + '</STMTTRNRS>'.length;
    const other = OCTOBER_QFX.slice(start, end).replace(ACCOUNT, '1111229739');
    const withOther = (block: string) => OCTOBER_QFX.slice(0, end) + block + OCTOBER_QFX.slice(end);
    const list = OCTOBER_QFX.slice(OCTOBER_QFX.indexOf('<BANKTRANLIST>'), OCTOBER_QFX.indexOf('</BANKTRANLIST>') + '</BANKTRANLIST>'.length);
    const extra = list.replace(/<STMTTRN>[\s\S]*<\/STMTTRN>/,
      '<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20261003120000.000[-4:EDT]\r\n<TRNAMT>-9.00\r\n<NAME>EXTRA\r\n</STMTTRN>');
    // A list of no legitimate block: directly under STMTTRNRS, inside the read list, a card statement's.
    refuses(OCTOBER_QFX.replace('</STATUS>\r\n<STMTRS>', `</STATUS>\r\n${extra}\r\n<STMTRS>`), /a transaction list outside a bank statement/);
    refuses(OCTOBER_QFX.replace('</BANKTRANLIST>', `${extra}\r\n</BANKTRANLIST>`), /a transaction list outside a bank statement/);
    const card = OCTOBER_QFX.replace(/BANKMSGSRSV1/g, 'CREDITCARDMSGSRSV1').replace(/STMTTRNRS/g, 'CCSTMTTRNRS').replace(/STMTRS/g, 'CCSTMTRS')
      .replace(/<BANKACCTFROM>[\s\S]*?<\/BANKACCTFROM>/, '<CCACCTFROM>\r\n<ACCTID>4111111111111111\r\n</CCACCTFROM>');
    const cards = card.slice(card.indexOf('<CREDITCARDMSGSRSV1>'), card.indexOf('</CREDITCARDMSGSRSV1>') + '</CREDITCARDMSGSRSV1>'.length);
    refuses(OCTOBER_QFX.replace('</BANKMSGSRSV1>', `</BANKMSGSRSV1>\r\n${cards}`), /a transaction list outside a bank statement/);
    // A row of no list, and pending rows.
    refuses(OCTOBER_QFX.replace('</STATUS>\r\n<STMTRS>', '</STATUS>\r\n<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<NAME>ORPHAN\r\n</STMTTRN>\r\n<STMTRS>'),
      /transactions outside a transaction list/);
    refuses(OCTOBER_QFX.replace('</BANKTRANLIST>',
      '</BANKTRANLIST>\r\n<BANKTRANLISTP>\r\n<STMTTRNP>\r\n<TRNTYPE>DEBIT\r\n<TRNAMT>-9.00\r\n<NAME>PENDING\r\n</STMTTRNP>\r\n</BANKTRANLISTP>'), /pending transactions/);
    // A block that is not read passes the same check, one list in its place; a statement out of its place refuses.
    refuses(withOther(other.replace('</BANKTRANLIST>', `</BANKTRANLIST>\r\n${extra}`)), /each must hold exactly one/, '2931');
    refuses(withOther(other.replace(/<BANKTRANLIST>[\s\S]*<\/BANKTRANLIST>\r\n/, '')), /each must hold exactly one/, '2931');
    refuses(withOther(other.slice(other.indexOf('<STMTRS>'), other.indexOf('</STMTRS>') + '</STMTRS>'.length)), /outside a STMTTRNRS in BANKMSGSRSV1/, '2931');
    // Two legitimate blocks, each with its one list: the picked one is read, and no row of the other. Two statements in
    // one response (STMTTRNRS) are each legitimate too.
    const picked = parseBankOfx(withOther(other.replace('<NAME>SYNTHETIC COFFEE', '<NAME>OTHER ACCOUNT ROW')), { accountLast4: '2931' });
    assert.equal(picked.rows.length, OCTOBER.length);
    assert.ok(picked.rows.every((row) => !row.description.includes('OTHER ACCOUNT')));
    const statementOf = (text: string) => text.slice(text.indexOf('<STMTRS>'), text.indexOf('</STMTRS>') + '</STMTRS>'.length);
    const shared = OCTOBER_QFX.replace('</STMTRS>', `</STMTRS>\r\n${statementOf(other).replace('<NAME>SYNTHETIC COFFEE', '<NAME>OTHER ACCOUNT ROW')}`);
    const sharing = parseBankOfx(shared, { accountLast4: '9739' });
    assert.deepEqual([sharing.accountLast4, sharing.rows.length, sharing.rows.some((row) => row.description.includes('OTHER ACCOUNT'))], ['9739', OCTOBER.length, true]);
  });

  it('reads only an input that is exactly one OFX document: its header before it, whitespace after it', () => {
    const refuses = (text: string, pattern: RegExp) => assert.throws(() => parseBankOfx(text), (error: Error) => {
      assert.ok(error instanceof CheckingExportFormatError, error.message);
      assert.match(error.message, pattern);
      return true;
    });
    const at = OCTOBER_QFX.indexOf('<OFX>');
    const [header, body] = [OCTOBER_QFX.slice(0, at), OCTOBER_QFX.slice(at)];
    const list = OCTOBER_QFX.slice(OCTOBER_QFX.indexOf('<BANKTRANLIST>'), OCTOBER_QFX.indexOf('</BANKTRANLIST>') + '</BANKTRANLIST>'.length);
    const row = '<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20261003120000.000[-4:EDT]\r\n<TRNAMT>-9.00\r\n<FITID>X1\r\n<NAME>TRAILING\r\n</STMTTRN>';
    // A second document, a row or list after the document, a list before it: the reader would read the first document
    // alone, so the whole input refuses (Root 02:47Z).
    refuses(`${OCTOBER_QFX}${body}`, /exactly one OFX document/);
    refuses(`${OCTOBER_QFX}${row}\r\n`, /something after its <\/OFX>/);
    refuses(`${OCTOBER_QFX}${list}\r\n`, /something after its <\/OFX>/);
    refuses(`${header}${list}\r\n${body}`, /something other than the OFX header before its <OFX> document/);
    refuses(`${header}SYNTHETIC NOTE\r\n${body}`, /something other than the OFX header/);
    refuses(`${header}<!-- note -->\r\n${body}`, /something other than the OFX header/);
    // An early close in any spelling the reader accepts (whitespace, tabs, newlines, NBSP, case) followed by more of the
    // file, or a document opened or closed in such a spelling: the whole input refuses.
    for (const close of ['</ OFX>', '< /OFX>', '</OFX >', '</\tOFX>', '<\n/OFX>', '</OFX\r\n>', '</\u00A0OFX>', '</ofx>']) {
      refuses(OCTOBER_QFX.replace('</BANKMSGSRSV1>', `</BANKMSGSRSV1>\r\n${close}\r\n${list}`), /exactly one OFX document/);
      refuses(OCTOBER_QFX.replace('</OFX>', close), /exactly one OFX document/);
    }
    for (const open of ['<OFX >', '< OFX>', '<ofx>']) refuses(OCTOBER_QFX.replace('<OFX>', open), /exactly one OFX document|no <OFX> element/);
    // The OFX header (SGML lines, or the xml and OFX instructions) and whitespace around the document are all it may hold.
    assert.equal(parseBankOfx(`\r\n${OCTOBER_QFX}\r\n\r\n`).rows.length, OCTOBER.length);
    const leaf = (name: string, value: string) => `<${name}>${value}</${name}>`;
    const xml = ['<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
      '<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>',
      `<OFX><SIGNONMSGSRSV1><SONRS><STATUS>${leaf('CODE', '0')}${leaf('SEVERITY', 'INFO')}</STATUS>${leaf('DTSERVER', '20261021120000.000[-4:EDT]')}</SONRS></SIGNONMSGSRSV1>`
      + `<BANKMSGSRSV1><STMTTRNRS>${leaf('TRNUID', '1')}<STATUS>${leaf('CODE', '0')}${leaf('SEVERITY', 'INFO')}</STATUS><STMTRS>${leaf('CURDEF', 'USD')}`
      + `<BANKACCTFROM>${leaf('BANKID', '121000248')}${leaf('ACCTID', ACCOUNT)}${leaf('ACCTTYPE', 'CHECKING')}</BANKACCTFROM>`
      + `<BANKTRANLIST>${leaf('DTSTART', '20261001120000.000[-4:EDT]')}${leaf('DTEND', '20261021120000.000[-4:EDT]')}`
      + `<STMTTRN>${leaf('TRNTYPE', 'DEBIT')}${leaf('DTPOSTED', '20261002120000.000[-4:EDT]')}${leaf('TRNAMT', '-250.00')}${leaf('FITID', 'F1')}${leaf('NAME', 'SYNTHETIC')}</STMTTRN>`
      + '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>', ''].join('\r\n');
    assert.deepEqual(parseBankOfx(xml).rows.map((entry) => entry.amountMinor), [-25000]);
  });

  it('knows every account number the file names, carries them in refusals without showing them, and names no element of the file', () => {
    // A transfer's other account (BANKACCTTO) is known like another block's: redacted in the rows.
    const transfer = parseBankOfx(OCTOBER_QFX.replace('<NAME>ATM WITHDRAWAL',
      '<BANKACCTTO>\r\n<BANKID>121000248\r\n<ACCTID>5555666677\r\n<ACCTTYPE>SAVINGS\r\n</BANKACCTTO>\r\n<NAME>TRANSFER TO 5666677'));
    assert.deepEqual(transfer.otherAccountNumbersRaw, ['5555666677']);
    assert.ok(convert([transfer]).payload.segments[0].rows.some((row) => row.description === 'TRANSFER TO ***6677'));
    // A refusal carries the file's account numbers for the converter's output guard; they are never serialized.
    const carried = (text: string): readonly string[] => {
      try {
        parseBankOfx(text);
      } catch (error) {
        assert.ok(error instanceof CheckingExportFormatError);
        assert.ok(![JSON.stringify(error), inspect(error), error.message].some((shown) => shown.includes(ACCOUNT)));
        assert.ok(error.identityKnown);
        return error.accountNumbersRaw;
      }
      return assert.fail('not refused');
    };
    const inverted = qfx(OCTOBER.map((row) => ({ ...row, amount: row.amount.startsWith('-') ? row.amount.slice(1) : `-${row.amount}` })));
    assert.deepEqual(carried(inverted), [ACCOUNT]);
    assert.deepEqual(carried(OCTOBER_QFX.replace('<DTASOF>20261021120000.000[-4:EDT]', '<DTASOF>20261021250000.000[-4:EDT]')), [ACCOUNT]);
    const start = OCTOBER_QFX.indexOf('<STMTTRNRS>');
    const end = OCTOBER_QFX.indexOf('</STMTTRNRS>') + '</STMTTRNRS>'.length;
    assert.deepEqual(carried(OCTOBER_QFX.slice(0, end) + OCTOBER_QFX.slice(start, end).replace(ACCOUNT, '1111229739') + OCTOBER_QFX.slice(end)),
      [ACCOUNT, '1111229739']);
    // An element the file leaves open is named by a fixed label, never by its tag (the file's own text).
    const open = '<?xml version="1.0" encoding="UTF-8"?>\r\n<?OFX OFXHEADER="200" VERSION="220"?>\r\n<OFX><SIGNONMSGSRSV1><X9876542931>';
    assert.throws(() => parseBankOfx(open), (error: Error) => error.message === 'an OFX element is not closed (the file may be truncated)');
    // Identity from the reader itself (Root 03:37Z-04:08Z): a file the reader refuses (at line 10440, its account named
    // plainly, with entities, in CDATA or split by a comment or an instruction) carries the account the reader read
    // before it stopped, read by the reader's own tokenizer and tree builder; with the rest of the input unread, its
    // identity is not known whole, and the reader's refusal names no line of it.
    const malformed = (acctid: string, tail: string) => `${'\r\n'.repeat(10431)}<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n`
      + `<BANKACCTFROM>\r\n<ACCTID>${acctid}\r\n<ACCTTYPE>CHECKING\r\n</BANKACCTFROM>\r\n${tail}`;
    for (const [tail, message] of [['<BROKEN', 'a tag is not closed (the file may be truncated)'], ['</1>', 'malformed closing tag']]) {
      for (const acctid of ['7710440', '&#55;710440', '<![CDATA[7710440]]>', '77<!-- synthetic -->10440', '77<?synthetic?>10440']) {
        assert.throws(() => parseBankOfx(malformed(acctid, tail)), (error: Error) => {
          assert.ok(error instanceof CheckingExportFormatError);
          assert.deepEqual([error.message, error.identityKnown, error.accountNumbersRaw], [message, false, ['7710440']], acctid);
          return true;
        });
      }
    }
    // Read whole, each form is the account the reader reads, and a later refusal carries it, identity known.
    for (const acctid of ['&#55;710440', '<![CDATA[7710440]]>', '77<!-- synthetic -->10440', '77<?synthetic?>10440']) {
      const known = qfx(OCTOBER.map((row) => ({ ...row, amount: row.amount.startsWith('-') ? row.amount.slice(1) : `-${row.amount}` })), { account: acctid });
      assert.throws(() => parseBankOfx(known), (error: Error) => error instanceof CheckingExportFormatError && error.identityKnown
        && error.accountNumbersRaw.join() === '7710440');
    }
    // A CSV names no account number: its refusals leave no identity unknown.
    assert.throws(() => parseWellsFargoCsv('"10/02/2026","-1.00","*",""\r\n'), (error: Error) => error instanceof CheckingExportFormatError && error.identityKnown);
  });

  it('converts complete days only, carries the ledger balance back to the last of them, and keeps no raw value', () => {
    const { payload, report } = convert([parseBankOfx(OCTOBER_QFX)]);
    const [segment] = payload.segments;
    // Made on 10-21, so 10-21 may still be posting: the segment ends on 10-20 and 10-21's row waits for a later file.
    assert.deepEqual(segment.coverage, { start: '2026-10-01', end: '2026-10-20' });
    assert.equal(report.files[0].leftOutAfterCoverage, 1);
    assert.deepEqual(segment.anchors, [{ date: '2026-10-20', balanceMinor: 501000, kind: 'ledger' }]);
    assert.deepEqual(report.files[0].checks, ['ledger-balance']);
    assert.equal(payload.account.last4, '2931');
    assert.ok(segment.rows.every((row) => row.externalIdHash && /^xid1:[a-p]{64}$/.test(row.externalIdHash)));
    assert.equal(segment.rows[1].description, 'SYNTHETIC PAYROLL DIR DEP ***3456');
    assert.equal(segment.rows[4].checkNumber, '1001');
    const json = JSON.stringify(payload);
    assert.ok(!json.includes(ACCOUNT) && !json.includes('1234567890123456') && !json.includes('"F1"'));
    assert.ok(validateCheckingImportPayload(payload).ok);
    const reportJson = JSON.stringify(report);
    assert.ok(!/SYNTHETIC|5010|501000|-250|25000/.test(reportJson), reportJson);
    // --through caps further; --no-ledger-balance leaves the ledger out.
    const capped = convert([parseBankOfx(OCTOBER_QFX)], { through: '2026-10-10', useLedgerBalance: false });
    assert.deepEqual(capped.payload.segments[0].coverage, { start: '2026-10-01', end: '2026-10-10' });
    assert.deepEqual(capped.payload.segments[0].anchors, []);
    assert.equal(capped.report.files[0].leftOutAfterCoverage, 2);
  });

  it('refuses a statement of another account type, and files of different accounts', () => {
    refused(() => convert([parseBankOfx(qfx(OCTOBER, { accountType: 'SAVINGS' }))]), /SAVINGS account, not a checking account/);
    refused(() => convert([parseBankOfx(OCTOBER_QFX), parseBankOfx(qfx(OCTOBER, { account: '1111229739' }))]), /different accounts/);
  });

  it('refuses a ledger balance it cannot check against the rows, unless the owner leaves it out', () => {
    const late = parseBankOfx(qfx(OCTOBER, { ledger: ['5000.00', '2026-10-25'] }));
    refused(() => convert([late]), /ledger balance is dated outside the days its transaction list covers.*--no-ledger-balance/);
    assert.deepEqual(convert([late], { useLedgerBalance: false }).payload.segments[0].anchors, []);
  });
});

describe('checking import tool: Wells Fargo CSV', () => {
  it('reads five quoted columns, newest first, into posted rows oldest first', () => {
    const parsed = parseWellsFargoCsv(OCTOBER_CSV);
    assert.equal(parsed.institution, 'wellsfargo');
    assert.equal(parsed.rows.length, 6);
    assert.equal(parsed.rows[0].postedDate, '2026-10-02');
    assert.equal(parsed.rows[5].postedDate, '2026-10-21');
    assert.equal(parsed.rows.find((row) => row.checkNumber === '1001')?.amountMinor, -12000);
    assert.equal(detectCheckingExportAdapters({ kind: 'text', text: OCTOBER_CSV }).map((adapter) => adapter.source).join(), 'wf-csv');
    assert.equal(detectCheckingExportAdapters({ kind: 'text', text: OCTOBER_QFX }).map((adapter) => adapter.source).join(), 'ofx');
    assert.throws(() => parseWellsFargoCsv('"10/02/2026","-250.00","X","","A"\r\n'), /column 3/);
    assert.throws(() => parseWellsFargoCsv('"10/02/2026","-250.00","*","A"\r\n'), /has 4 columns/);
    assert.equal(parseWellsFargoCsv('"13/02/2026","-250.00","*","","A"\r\n').problems.length, 1);
  });

  it('reads the current layout: a DATE, DESCRIPTION, AMOUNT, CHECK #, STATUS header, pending rows marked', () => {
    const current = [
      '"DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"',
      '"10/21/2026","SYNTHETIC COFFEE","-10.00","","Pending"',
      '"10/15/2026","CHECK","-120.00","1001","Posted"',
      '"10/05/2026","SYNTHETIC PAYROLL","3000.00","","Posted"',
      '',
    ].join('\r\n');
    assert.equal(detectCheckingExportAdapters({ kind: 'text', text: current }).map((adapter) => adapter.source).join(), 'wf-csv');
    const parsed = parseWellsFargoCsv(current);
    assert.deepEqual(parsed.rows.map((row) => [row.postedDate, row.amountMinor, row.checkNumber, row.pending]), [
      ['2026-10-05', 300000, null, false], ['2026-10-15', -12000, '1001', false], ['2026-10-21', -1000, null, true],
    ]);
    const { report } = convert([parsed], { through: '2026-10-21', accountLast4: '2931' });
    assert.equal(report.files[0].rows, 2);
    assert.equal(report.files[0].leftOutPending, 1);
    assert.throws(() => parseWellsFargoCsv('"DATE","AMOUNT","DESCRIPTION"\r\n'), /header is not DATE, DESCRIPTION, AMOUNT, CHECK #, STATUS/);
    assert.equal(parseWellsFargoCsv(current.replace('"Posted"', '"Reversed"')).problems[0].reason, 'the status is neither Posted nor Pending');
  });

  it('needs --through, then covers its first row through that day', () => {
    refused(() => convert([parseWellsFargoCsv(OCTOBER_CSV)], { accountLast4: '2931' }), /pass --through YYYY-MM-DD/);
    refused(() => convert([parseWellsFargoCsv(OCTOBER_CSV)], { through: '2026-10-20' }), /pass --account LAST4/);
    const { payload, report } = convert([parseWellsFargoCsv(OCTOBER_CSV)], { through: '2026-10-20', accountLast4: '2931' });
    assert.deepEqual(payload.segments[0].coverage, { start: '2026-10-02', end: '2026-10-20' });
    assert.equal(report.files[0].leftOutAfterCoverage, 1);
    assert.equal(payload.segments[0].rows.length, 5);
  });

  it('agrees with the QFX of the same days, which then count once; a disagreeing day refuses both', () => {
    const { payload, report } = convert([parseWellsFargoCsv(OCTOBER_CSV), parseBankOfx(OCTOBER_QFX)], { through: '2026-10-20' });
    assert.deepEqual(payload.segments.map((segment) => segment.source), ['ofx', 'wf-csv']);
    assert.equal(report.summary.days, 20);
    assert.deepEqual(report.summary.coverage, [{ start: '2026-10-01', end: '2026-10-20' }]);
    const missingRow = OCTOBER_CSV.replace('"10/05/2026","-50.00","*","","ATM WITHDRAWAL"\r\n', '');
    refused(() => convert([parseWellsFargoCsv(missingRow), parseBankOfx(OCTOBER_QFX)], { through: '2026-10-20' }), /disagree on 1 of them: 2026-10-05/);
  });
});

describe('checking import tool: Wells Fargo statement PDF', () => {
  it('reads the summary and every row, its sign from the column it sits in, over lines and pages', () => {
    const parsed = parseWellsFargoStatement(septemberStatement());
    assert.deepEqual(parsed.coverage, { start: '2026-09-01', end: '2026-09-30' });
    assert.equal(parsed.accountLast4, '2931');
    assert.deepEqual(parsed.statement, { openingBalanceMinor: 200000, closingBalanceMinor: 248000, depositsMinor: 100000, withdrawalsMinor: 52000 });
    assert.deepEqual(parsed.rows.map((row) => [row.postedDate, row.amountMinor, row.runningBalanceMinor, row.checkNumber]), [
      ['2026-09-02', 100000, 300000, null],
      ['2026-09-10', -12000, null, '1001'],
      ['2026-09-10', -8000, 280000, null],
      ['2026-09-20', -32000, 248000, null],
    ]);
    assert.equal(parsed.rows[2].description, 'Purchase authorized on 09/08 Synthetic Store S0000000000000001234 Card 5678');
    assert.deepEqual(parsed.problems, []);
    const layout = describeWellsFargoStatementLayout(septemberStatement());
    assert.equal(layout.periodFound, true);
    assert.equal((layout.headers as unknown[]).length, 2);
    assert.ok(!JSON.stringify(layout).includes(ACCOUNT));
    // Recognized by Wells Fargo's own labels; another bank's statement that names Wells Fargo in a row is not claimed.
    assert.deepEqual(detectCheckingExportAdapters({ kind: 'pdf', pages: septemberStatement() }).map((adapter) => adapter.source), ['wf-statement']);
    const other: CheckingPdfPage[] = [{ items: [item('Fifth Third Bank', 40, 760), item('9/20 WELLS FARGO CARD PAYMENT 320.00', 40, 600)] }];
    assert.deepEqual(detectCheckingExportAdapters({ kind: 'pdf', pages: other }), []);
  });

  it('converts a statement whose balances add up, keeping its opening, daily and closing balances', () => {
    const { payload, report } = convert([parseWellsFargoStatement(septemberStatement())]);
    const [segment] = payload.segments;
    assert.equal(segment.source, 'wf-statement');
    assert.deepEqual(segment.anchors.map((anchor) => [anchor.date, anchor.kind]), [
      ['2026-08-31', 'opening'], ['2026-09-02', 'daily'], ['2026-09-10', 'daily'], ['2026-09-20', 'daily'], ['2026-09-30', 'closing'],
    ]);
    assert.deepEqual(report.files[0].checks, ['statement-balances', 'statement-totals', 'running-balances']);
    assert.equal(segment.rows[2].description, 'Purchase authorized on 09/08 Synthetic Store S***1234 Card 5678');
  });

  it('refuses a statement read into the wrong column or whose totals differ', () => {
    // The table's own Totals catch a row read into the wrong column; without them, the summary's balances do.
    assert.throws(() => parseWellsFargoStatement(septemberStatement({ secondRowColumn: 'deposits' })), /Totals are not the sums of its rows/);
    const untotalled = septemberStatement({ secondRowColumn: 'deposits' });
    untotalled[1].items = untotalled[1].items.filter((entry) => entry.y !== 625);
    refused(() => convert([parseWellsFargoStatement(untotalled)]), /opening balance plus the rows is not the closing balance/);
    refused(() => convert([parseWellsFargoStatement(septemberStatement({ withdrawalsTotal: '- 530.00' }))]), /withdrawals total/);
    assert.throws(() => parseWellsFargoStatement([{ items: [item('Nothing here', 40, 700)] }]), /statement period/);
  });

  it('reads parenthesized and minus-signed balances as negative, and an unpaired parenthesis as unreadable', () => {
    const overdrawn = (opening: string, closing: string): CheckingPdfPage[] => [{ items: [
      item('Everyday Checking', 40, 760), item(`Account number: ${ACCOUNT}`, 40, 745), item('September 1, 2026 - September 30, 2026', 250, 745),
      item('Wells Fargo Bank, N.A.', 40, 730),
      item('Beginning balance on 9/1', 40, 635), right(opening, 300, 635),
      item('Deposits/Additions', 40, 620), right('0.00', 300, 620),
      item('Withdrawals/Subtractions', 40, 605), right('- 0.00', 300, 605),
      item('Ending balance on 9/30', 40, 590), right(closing, 300, 590),
      item('Transaction history', 40, 500), ...header(470),
      item('Totals', 120, 440), right('$0.00', 420, 440), right('$0.00', 490, 440),
    ] }];
    const parsed = parseWellsFargoStatement(overdrawn('($100.00)', '($100.00)'));
    assert.deepEqual([parsed.statement?.openingBalanceMinor, parsed.statement?.closingBalanceMinor], [-10000, -10000]);
    assert.ok(convert([parsed]).payload.segments[0].anchors.every((anchor) => anchor.balanceMinor === -10000));
    assert.deepEqual([parseWellsFargoStatement(overdrawn('-$100.00', '$100.00-')).statement?.openingBalanceMinor,
      parseWellsFargoStatement(overdrawn('-$100.00', '$100.00-')).statement?.closingBalanceMinor], [-10000, -10000]);
    assert.throws(() => parseWellsFargoStatement(overdrawn('($100.00', '($100.00)')), /activity summary/);
  });

  it('reads every amount whole by one grammar, from its own line or column, and refuses any it cannot', () => {
    const edited = (y: number, from: string, to: string | null): CheckingPdfPage[] => septemberStatement().map((page, index) => (index === 0
      ? { items: page.items.flatMap((entry) => (entry.y === y && entry.text === from ? (to === null ? [] : [right(to, entry.x + entry.width, y)]) : [entry])) }
      : page));
    const reasons = (pages: CheckingPdfPage[]) => parseWellsFargoStatement(pages).problems.map((problem) => problem.reason);
    const unreadable = ['row on page 1 has an amount whose form or sign cannot be read'];
    // In the table, anything that can only be an amount is one, never description: a balance outside the grammar, or
    // a signed deposit or withdrawal, refuses its row.
    for (const balance of ['(3,000.00', '+3,000.00', '(-3,000.00)', '-3,000.00-', '3,000.00CR', '3,000', '$-3,000.00', 'UNREADABLE']) {
      assert.deepEqual(reasons(edited(455, '3,000.00', balance)), unreadable, balance);
    }
    assert.deepEqual(reasons(edited(455, '1,000.00', '-1,000.00')), unreadable);
    assert.deepEqual(reasons(edited(455, '1,000.00', 'PENDING')), unreadable);
    assert.deepEqual(reasons(edited(440, '120.00', '(120.00')), unreadable);
    assert.deepEqual(reasons(edited(440, '120.00', '120.00-')), unreadable);
    const detached = septemberStatement();
    detached[0].items.push(item('-', 515, 455));
    assert.deepEqual(reasons(detached), unreadable);
    refused(() => convert([parseWellsFargoStatement(edited(455, '3,000.00', '($90.00'))]), /form or sign cannot be read/);
    // A balance may be negative, with exactly one sign.
    for (const balance of ['(3,000.00)', '($3,000.00)', '-3,000.00', '-$3,000.00', '3,000.00-']) {
      const parsed = parseWellsFargoStatement(edited(455, '3,000.00', balance));
      assert.deepEqual([parsed.problems, parsed.rows[0].runningBalanceMinor], [[], -300000], balance);
    }
    // In the summary, the amount on its label's own line only: never one from the next line, never part of a token.
    const summaryRefused = (pages: CheckingPdfPage[], name: string) => assert.throws(() => parseWellsFargoStatement(pages),
      new RegExp(`the activity summary's ${name} is there but its amount cannot be read`));
    for (const opening of ['+-$2,000.00', '($2,000.00', '(-$2,000.00)', 'N/A', '$2,000']) summaryRefused(edited(635, '$2,000.00', opening), 'Beginning balance');
    summaryRefused(edited(635, '$2,000.00', null), 'Beginning balance');
    summaryRefused(edited(620, '1,000.00', '1,OOO.00'), 'Deposits/Additions');
    summaryRefused(edited(605, '- 520.00', '- - 520.00'), 'Withdrawals/Subtractions');
    // The whole field after the label, anchored at both ends (Root 02:47Z): a sign set apart after the digits, a second
    // sign or any other text refuses, and nothing is read from a part of it; the label must start its line.
    const fields: ReadonlyArray<readonly [number, string, string]> = [[635, '$2,000.00', 'Beginning balance'], [590, '$2,480.00', 'Ending balance']];
    for (const [y, amount, name] of fields) {
      for (const value of [`${amount} -`, `(${amount}) -`, `-${amount} -`, `${amount} suffix`]) summaryRefused(edited(y, amount, value), name);
    }
    const prefixed = septemberStatement();
    prefixed[0].items.push(item('Note:', 5, 635));
    summaryRefused(prefixed, 'Beginning balance');
    const twice = septemberStatement();
    twice[0].items.push(item('Beginning balance on 9/1', 40, 520), right('$2,000.00', 300, 520));
    assert.throws(() => parseWellsFargoStatement(twice), /states Beginning balance on more than one line/);
    // A sign or parenthesis printed apart from the digits is part of the amount.
    assert.equal(parseWellsFargoStatement(edited(635, '$2,000.00', '( $2,000.00 )')).statement?.openingBalanceMinor, -200000);
    assert.equal(parseWellsFargoStatement(septemberStatement()).statement?.withdrawalsMinor, 52000);
  });

  it('leaves no row unread: a second table after the Totals, or an amount outside the table, refuses', () => {
    const withPage2 = (extra: CheckingPdfTextItem[]): CheckingPdfPage[] => {
      const pages = septemberStatement();
      pages[1].items.push(...extra);
      return pages;
    };
    const row = (y: number) => [item('9/25', 40, y), item('Synthetic extra', 120, y), right('5.00', 490, y), right('2,475.00', 565, y)];
    assert.throws(() => parseWellsFargoStatement(withPage2([...header(560), ...row(545)])), /another transaction table after its Totals/);
    // A row after the Totals that no list explains (Root R5, 14:12Z).
    assert.throws(() => parseWellsFargoStatement(withPage2(row(580))), /a dated row on page 2 after its Totals that no list it reads explains/);
    // A page between the table's pages that has rows but no header of its own.
    const pages = septemberStatement();
    pages.splice(1, 0, { items: [item('Transaction history (continued)', 40, 700), ...row(655)] });
    assert.throws(() => parseWellsFargoStatement(pages), /states an amount on page 2 outside its summary and transaction table rows/);
    assert.equal(parseWellsFargoStatement(septemberStatement()).rows.length, 4);
  });

  it('reads every amount of the statement: rows anywhere else, invalid dates and headerless pages refuse (Root 03:13Z)', () => {
    const extra = (date: string, y: number, shift = 0) =>
      [item(date, 40 + shift, y), item('SYNTHETIC EXTRA ROW', 120 + shift, y), right('20.00', 490 + shift, y), right('70.00', 565 + shift, y)];
    const footer = (total: string, balance: string, shift = 0) => [item('Ending balance on 1/31', 120 + shift, 440), right(balance, 565 + shift, 440),
      item('Totals', 120 + shift, 425), right('0.00', 420 + shift, 425), right(total, 490 + shift, 425)];
    const shiftedHeader = (shift: number) => header(470).map((entry) => ({ ...entry, x: entry.x + shift }));
    const january = (withdrawn = '10.00', closing = '$90.00', table: CheckingPdfTextItem[] = footer('10.00', '90.00')): CheckingPdfPage[] => [{ items: [
      item('Everyday Checking', 40, 760), item(`Account number: ${ACCOUNT}`, 40, 745), item('January 1, 2026 - January 31, 2026', 250, 745),
      item('Beginning balance on 1/1', 40, 650), right('$100.00', 300, 650), item('Deposits/Additions', 40, 635), right('0.00', 300, 635),
      item('Withdrawals/Subtractions', 40, 620), right(withdrawn, 300, 620), item('Ending balance on 1/31', 40, 605), right(closing, 300, 605),
      item('Transaction history', 40, 500), ...header(470),
      item('1/2', 40, 455), item('SYNTHETIC BANK ROW', 120, 455), right('10.00', 490, 455), right('90.00', 565, 455), ...table,
    ] }];
    const rowsOf = (pages: CheckingPdfPage[]) => convert([parseWellsFargoStatement(pages)]).payload.segments[0].rows.length;
    const refusesWhole = (pages: CheckingPdfPage[], what: string) => assert.throws(() => convert([parseWellsFargoStatement(pages)]),
      (error: Error) => error instanceof CheckingConvertError || error instanceof CheckingExportFormatError, what);
    // Positive controls: one row; two rows that reconcile; a two-page table whose second page's own header moves its columns.
    assert.equal(rowsOf(january()), 1);
    assert.equal(rowsOf(january('30.00', '$70.00', [...extra('1/3', 448), ...footer('30.00', '70.00')])), 2);
    const shifted = january('30.00', '$70.00', []);
    shifted.push({ items: [...shiftedHeader(100), ...extra('1/3', 455, 100), ...footer('30.00', '70.00', 100)] });
    assert.equal(rowsOf(shifted), 2);
    // A row with a valid date or an invalid one, before Transaction history, before the header, inside the table, after
    // the Totals: never left out.
    for (const date of ['1/3', '1/32', '13/2']) {
      for (const y of [550, 490, 448, 400]) {
        const pages = january();
        pages[0].items.push(...extra(date, y));
        refusesWhole(pages, `${date} at ${y}`);
      }
    }
    // A page with a row but no header of its own, whatever columns the next page's header has.
    for (const shift of [0, 100]) {
      const pages = january('10.00', '$90.00', []);
      pages.push({ items: [item('Transaction history (continued)', 40, 700), ...extra('1/3', 455)] });
      pages.push({ items: [...shiftedHeader(shift), ...footer('10.00', '90.00', shift)] });
      refusesWhole(pages, `headerless page, next header shifted ${shift}`);
    }
    // The table's own Totals and ending balance are what its rows and the summary say, or the statement refuses.
    assert.throws(() => parseWellsFargoStatement(january('10.00', '$90.00', footer('11.00', '90.00'))), /Totals are not the sums of its rows/);
    assert.throws(() => parseWellsFargoStatement(january('10.00', '$90.00', footer('10.00', '91.00'))), /ending balance is not the statement's closing balance/);
    assert.throws(() => parseWellsFargoStatement(january('10.00', '$90.00', footer('10.00 -', '90.00'))), /cannot be read as one amount per column/);
    // A page that states amounts without a table header of its own: the table's footer alone refuses. The summary alone
    // on its page is read by its labels and needs none (Root R4, 14:12Z); any other amount there still refuses.
    const summaryOnly = january();
    summaryOnly.push({ items: summaryOnly[0].items.filter((entry) => entry.y < 500) });
    summaryOnly[0].items = summaryOnly[0].items.filter((entry) => entry.y >= 500);
    assert.equal(parseWellsFargoStatement(summaryOnly).rows.length, 1);
    summaryOnly[0].items.push(item('Synthetic unread credit', 40, 560), right('5.00', 300, 560));
    assert.throws(() => parseWellsFargoStatement(summaryOnly), /states an amount on page 1 outside its summary and transaction table rows/);
    const footerOnly = january('10.00', '$90.00', []);
    footerOnly.push({ items: footer('10.00', '90.00') });
    refusesWhole(footerOnly, 'footer alone on a page');
    // An amount split into words is still an amount: one outside the rows refuses, anywhere through the Totals. After the
    // Totals, prose that states an amount (a fee summary, a notice) is not activity and is not read (Root R5, 14:12Z).
    for (const text of ['Synthetic unparsed debit $ 7', 'Synthetic unparsed debit ($ 7)', 'Synthetic unparsed debit 7 .00', 'Synthetic fee -$7']) {
      const before = january();
      before[0].items.push(item(text, 40, 550));
      assert.throws(() => parseWellsFargoStatement(before), /states an amount on page 1 outside its summary and transaction table rows/, `${text} before the table`);
      const after = january();
      after[0].items.push(item(text, 40, 400));
      assert.deepEqual(parseWellsFargoStatement(after).rows.length, 1, `${text} after the Totals`);
    }
  });

  it('takes the account kind from a title line of the header alone, refusing savings, combined and untitled statements', () => {
    const titled = (title: string) => septemberStatement().map((page, index) => (index === 0
      ? { items: page.items.map((entry) => (entry.text === 'Everyday Checking' ? { ...entry, text: title } : entry)) } : page));
    assert.equal(parseWellsFargoStatement(titled('Everyday Checking')).accountType, 'CHECKING');
    const savings = parseWellsFargoStatement(titled('Way2Save Savings'));
    assert.equal(savings.accountType, 'SAVINGS');
    refused(() => convert([savings]), /SAVINGS account, not a checking account/);
    assert.throws(() => parseWellsFargoStatement(titled('Combined statement of accounts')), /combined statement/);
    assert.throws(() => parseWellsFargoStatement(titled('Statement')), /no account title in its header/);
    // The kind never comes from body text, whole or in pieces, nor from a lone kind word anywhere.
    const prose = titled('Statement');
    prose[0].items.push(item('Overdraft protection: linked checking account', 40, 560));
    assert.throws(() => parseWellsFargoStatement(prose), /no account title in its header/);
    for (const y of [560, 752]) {
      const pieces = titled('Statement');
      pieces[0].items.push(item('Overdraft protection:', 40, y), item('linked', 150, y), item('Checking', 185, y), item('account', 230, y));
      assert.throws(() => parseWellsFargoStatement(pieces), /no account title in its header/);
      const lone = titled('Statement');
      lone[0].items.push(item('Checking', 40, y));
      assert.throws(() => parseWellsFargoStatement(lone), /no account title in its header/);
    }
    assert.throws(() => parseWellsFargoStatement(titled('Checking')), /no account title in its header/);
    assert.equal(parseWellsFargoStatement(titled('Wells Fargo Everyday Checking')).accountType, 'CHECKING');
    assert.equal(parseWellsFargoStatement(titled('Way2Save® Savings')).accountType, 'SAVINGS');
    // A savings account named in the body, as one linked for overdraft protection, does not change it; two titles of
    // different kinds in the header refuse.
    const linked = septemberStatement();
    linked[0].items.push(item('Overdraft Protection: linked Way2Save Savings', 40, 560), item('Way2Save Savings', 40, 545));
    assert.equal(parseWellsFargoStatement(linked).accountType, 'CHECKING');
    const both = septemberStatement();
    both[0].items.push(item('Way2Save Savings', 40, 752));
    assert.throws(() => parseWellsFargoStatement(both), /names accounts of different kinds/);
    assert.equal(describeWellsFargoStatementLayout(titled('Way2Save Savings')).accountKind, 'savings');
  });

  it('chains a statement into the next activity download over the days both cover', () => {
    const files = [parseWellsFargoStatement(septemberStatement()), parseBankOfx(OCTOBER_QFX), parseWellsFargoCsv(OCTOBER_CSV)];
    const { payload, report } = convert(files, { through: '2026-10-20' });
    assert.deepEqual(report.summary.coverage, [{ start: '2026-09-01', end: '2026-10-20' }]);
    // Opening, three daily balances and the closing of September, then October's ledger balance: five pairs checked.
    assert.deepEqual(report.balanceChain, { checked: 5, gaps: 0 });
    assert.equal(payload.segments.length, 3);
    // A ledger balance one cent off breaks the chain across files.
    const off = parseBankOfx(qfx(OCTOBER, { ledger: ['5000.01', '2026-10-21'] }));
    refused(() => convert([parseWellsFargoStatement(septemberStatement()), off], { through: '2026-10-20' }), /do not follow from the rows between them, at 2026-10-20/);
  });
});

// A statement laid out as Wells Fargo prints them (positions as measured on real statements, every value synthetic):
// no printed period, page 1's dated line, the summary beside the account box, the table over two pages, then prose
// and two lists after the Totals (Root R1–R5, 14:12Z).
const realHeader = (y: number): CheckingPdfTextItem[] => [
  item('Check', 124, y + 10), item('Deposits/', 404, y + 10), item('Withdrawals/', 458, y + 10), item('Ending', 525, y + 10), item('daily', 560, y + 10),
  item('Date', 63, y), item('Number', 117, y), item('Description', 150, y), item('Additions', 404, y), item('Subtractions', 462, y), item('balance', 540, y),
];
const datedLine = (date: string, page: number, y: number) => [item(date, 36, y), item(`Page ${page} of 3`, 36 + date.length * W + 10, y)];

function octoberStatement(): CheckingPdfPage[] {
  return [
    { items: [
      item('Wells Fargo Everyday Checking', 36, 751), ...datedLine('October 7, 2026', 1, 738),
      item('Questions?', 374, 635), item('Available by phone 24 hours a day, 7 days a week:', 374, 617),
      item('SYNTHETIC OWNER', 36, 614), item('1 SYNTHETIC WAY', 36, 603),
      item('You and Wells Fargo', 36, 449), item('Thank you for being a loyal Wells Fargo customer.', 36, 435),
    ] },
    { items: [
      ...datedLine('October 7, 2026', 2, 758),
      item(`Account number: ${ACCOUNT} (primary account)`, 356, 592),
      item('Statement period activity summary', 36, 589),
      item('SYNTHETIC OWNER', 356, 579),
      item('Beginning balance on 9/9', 65, 576), right('$2,000.00', 345, 576),
      item('Deposits/Additions', 65, 564), right('1,000.00', 345, 564),
      item('Synthetic account terms and conditions apply', 356, 556),
      item('Withdrawals/Subtractions', 65, 552), right('- 520.00', 345, 552),
      item('For Direct Deposit use', 356, 542),
      item('Ending balance on 10/7', 65, 538), right('$2,480.00', 345, 538),
      item('Routing Number (RTN): 000000000', 356, 533),
      item('Overdraft Protection', 36, 502), item('This account is not currently covered by Overdraft Protection.', 36, 491),
      item('Transaction history', 36, 446), ...realHeader(416),
      item('9/10', 45, 398), item('Online Transfer From Savings Ref #IB0SYNTH', 150, 398), right('1,000.00', 445, 398), right('3,000.00', 585, 398),
      item('9/20', 45, 380), item('1001', 120, 380), item('Check', 150, 380), right('120.00', 510, 380), right('2,880.00', 585, 380),
      item('9/25', 45, 362), item('Purchase authorized on 09/23 Synthetic Store', 150, 362), right('80.00', 510, 362), right('2,800.00', 585, 362),
      item('S0000000000000001234 Card 5678', 150, 352),
    ] },
    { items: [
      ...datedLine('October 7, 2026', 3, 758),
      item('Transaction History (continued)', 36, 687), ...realHeader(659),
      item('10/2', 45, 631), item('AMEX EPAYMENT ACH PMT 261002 W1234 SYNTHETIC', 150, 631), right('320.00', 510, 631), right('2,480.00', 585, 631),
      item('Totals', 62, 417), right('$1,000.00', 445, 417), right('$520.00', 510, 417),
      item('The Ending Daily Balance does not reflect any pending withdrawals or holds on deposited funds', 61, 370),
      item('Summary of checks written (checks listed are also displayed in the preceding Transaction history)', 40, 340),
      item('Number', 60, 330), item('Date', 110, 330), item('Amount', 180, 330),
      item('1001', 60, 320), item('9/20', 110, 320), right('120.00', 215, 320),
      item('Items returned unpaid', 36, 300),
      item('Date', 62, 287), item('Description', 95, 287), item('Amount', 538, 287),
      item('9/28', 61, 278), item('SYNTHETIC CARD CO EPAYMENT 260928 PPD Reference # 000000000000001', 95, 278), right('$75.00', 570, 278),
      item('Monthly service fee summary', 36, 254),
      item('Fee period 09/01/2026 - 09/30/2026', 63, 207), item('Standard monthly service fee $10.00', 283, 207), item('You paid $0.00', 459, 207),
      item('• Minimum daily balance', 63, 121), right('$500.00', 330, 121), right('$2,480.00', 420, 121),
      item('IMPORTANT ACCOUNT INFORMATION', 64, 90), item('An overdraft fee of $35 may apply to an item paid into an overdraft.', 36, 80),
    ] },
  ];
}

/** The statement with every item whose text is a key of `texts` given that text instead. */
const retext = (pages: CheckingPdfPage[], texts: Record<string, string>): CheckingPdfPage[] =>
  pages.map((page) => ({ items: page.items.map((entry) => (entry.text in texts ? { ...entry, text: texts[entry.text] } : entry)) }));
/** The statement with the item of page 3 at height `y` whose text is `from` given `to` instead. */
const retextAt = (y: number, from: string, to: string): CheckingPdfPage[] => octoberStatement().map((page, index) => (index !== 2 ? page
  : { items: page.items.map((entry) => (entry.y === y && entry.text === from ? { ...entry, text: to } : entry)) }));
const withItems = (pages: CheckingPdfPage[], page: number, items: CheckingPdfTextItem[]): CheckingPdfPage[] =>
  pages.map((entry, index) => (index === page - 1 ? { items: [...entry.items, ...items] } : entry));

describe('checking import tool: Wells Fargo statement PDF, as Wells Fargo prints it (Root R1–R5, 14:12Z)', () => {
  it('reads the period from page 1\'s date and the summary\'s dates, the summary beside its account box, every row, and the lists after the Totals', () => {
    const parsed = parseWellsFargoStatement(octoberStatement());
    assert.deepEqual(parsed.coverage, { start: '2026-09-09', end: '2026-10-07' });
    assert.deepEqual([parsed.accountType, parsed.accountLast4], ['CHECKING', '2931']);
    assert.deepEqual(parsed.statement, { openingBalanceMinor: 200000, closingBalanceMinor: 248000, depositsMinor: 100000, withdrawalsMinor: 52000 });
    assert.deepEqual(parsed.rows.map((row) => [row.postedDate, row.amountMinor, row.checkNumber, row.runningBalanceMinor]), [
      ['2026-09-10', 100000, null, 300000], ['2026-09-20', -12000, '1001', 288000], ['2026-09-25', -8000, null, 280000], ['2026-10-02', -32000, null, 248000],
    ]);
    assert.equal(parsed.rows[2].description, 'Purchase authorized on 09/23 Synthetic Store S0000000000000001234 Card 5678');
    // The items returned unpaid are counted with their dates, never imported; the fee summary and notices are not read.
    assert.deepEqual(parsed.notes, ['the statement lists 1 item returned unpaid (2026-09-28); not activity, not imported']);
    const { report } = convert([parsed]);
    assert.deepEqual(report.files[0].checks, ['statement-balances', 'statement-totals', 'running-balances']);
    assert.deepEqual(report.files[0].notes, parsed.notes);
    const layout = describeWellsFargoStatementLayout(octoberStatement());
    assert.deepEqual([layout.periodFound, layout.statementDateFound, layout.accountKind, layout.accountNumberFound, layout.accountBoxBesideSummary, layout.listsAfterTotals],
      [true, true, 'checking', true, true, ['Summary of checks written', 'Items returned unpaid']]);
  });

  it('R1: the period runs from the Beginning to the Ending balance date, which is the statement\'s date; a January statement begins in December', () => {
    const january = parseWellsFargoStatement(retext(octoberStatement(), {
      'October 7, 2026': 'January 8, 2026', 'Beginning balance on 9/9': 'Beginning balance on 12/9', 'Ending balance on 10/7': 'Ending balance on 1/8',
      '9/10': '12/10', '9/20': '12/20', '9/25': '12/25', '10/2': '1/2', '9/28': '12/28',
    }));
    assert.deepEqual(january.coverage, { start: '2025-12-09', end: '2026-01-08' });
    assert.deepEqual(january.rows.map((row) => row.postedDate), ['2025-12-10', '2025-12-20', '2025-12-25', '2026-01-02']);
    assert.deepEqual(january.notes, ['the statement lists 1 item returned unpaid (2025-12-28); not activity, not imported']);
    assert.throws(() => parseWellsFargoStatement(retext(octoberStatement(), { 'Ending balance on 10/7': 'Ending balance on 10/6' })),
      /the activity summary's Ending balance date is not the statement date/);
    assert.throws(() => parseWellsFargoStatement(retext(octoberStatement(), { 'Beginning balance on 9/9': 'Beginning balance on 10/8' })),
      /Beginning balance date does not begin the statement period/);
    assert.throws(() => parseWellsFargoStatement(withItems(octoberStatement(), 1, datedLine('October 8, 2026', 1, 700))), /page 1 states more than one statement date/);
    const undated = octoberStatement();
    undated[0].items = undated[0].items.filter((entry) => entry.y !== 738);
    assert.throws(() => parseWellsFargoStatement(undated), /no statement period was found/);
    // A printed period is read as before, and must then agree with the summary's dates.
    assert.deepEqual(parseWellsFargoStatement(withItems(octoberStatement(), 1, [item('September 9, 2026 - October 7, 2026', 250, 700)])).coverage,
      { start: '2026-09-09', end: '2026-10-07' });
    assert.throws(() => parseWellsFargoStatement(withItems(octoberStatement(), 1, [item('September 9, 2026 - October 6, 2026', 250, 700)])),
      /printed period and its summary's dates disagree/);
    // The fee period of the fee summary is never the statement's: changing it changes nothing.
    assert.deepEqual(parseWellsFargoStatement(retext(octoberStatement(), { 'Fee period 09/01/2026 - 09/30/2026': 'Fee period 08/01/2026 - 08/31/2026' })).coverage,
      { start: '2026-09-09', end: '2026-10-07' });
  });

  it('R2: the account kind comes from a title above the statement date', () => {
    const below = octoberStatement();
    below[0].items = below[0].items.map((entry) => (entry.text === 'Wells Fargo Everyday Checking' ? { ...entry, y: 700 } : entry));
    assert.throws(() => parseWellsFargoStatement(below), /no account title in its header \(above its statement date or period\)/);
    assert.equal(parseWellsFargoStatement(retext(octoberStatement(), { 'Wells Fargo Everyday Checking': 'Wells Fargo Way2Save Savings' })).accountType, 'SAVINGS');
  });

  it('R3: a summary amount is the rest of its label\'s line left of the account box, whose text may share the line', () => {
    // As statements of early 2024 print it: the box's lines at the summary lines' heights.
    const sharing = octoberStatement().map((page, index) => (index !== 1 ? page : { items: page.items.map((entry) => (
      entry.text === 'SYNTHETIC OWNER' ? { ...entry, y: 576 } : entry.text === 'Synthetic account terms and conditions apply' ? { ...entry, y: 552 } : entry)) }));
    const parsed = parseWellsFargoStatement(sharing);
    assert.deepEqual(parsed.statement, { openingBalanceMinor: 200000, closingBalanceMinor: 248000, depositsMinor: 100000, withdrawalsMinor: 52000 });
    // An amount in the box beside a summary line refuses; so does anything but one amount left of the box.
    const besides = withItems(sharing, 2, [item('$5.00', 470, 576)]);
    assert.throws(() => parseWellsFargoStatement(besides), /a line of the activity summary has an amount in the account box beside it/);
    assert.throws(() => parseWellsFargoStatement(retext(sharing, { '$2,000.00': '$2,000.00 -' })), /Beginning balance is there but its amount cannot be read/);
    // Without a box right of the labels, the whole line is the field, as before.
    assert.throws(() => parseWellsFargoStatement(withItems(septemberStatement(), 1, [item('SYNTHETIC OWNER', 378, 635)])),
      /Beginning balance is there but its amount cannot be read/);
  });

  it('R4: the summary alone on its page needs no table header there; any other amount on that page still does', () => {
    const moved = octoberStatement();
    const summary = moved[1].items.filter((entry) => entry.y > 480 && entry.y < 600);
    moved[1].items = moved[1].items.filter((entry) => !summary.includes(entry));
    moved[0].items.push(...summary.map((entry) => ({ ...entry, y: entry.y - 200 })));
    const parsed = parseWellsFargoStatement(moved);
    assert.deepEqual([parsed.statement?.openingBalanceMinor, parsed.rows.length], [200000, 4]);
    assert.throws(() => parseWellsFargoStatement(withItems(moved, 1, [item('Synthetic promotional credit $25.00', 36, 200)])),
      /states an amount on page 1 outside its summary and transaction table rows/);
  });

  it('R5: after the Totals, prose is not read, a check listed must be a check row, items returned unpaid are counted, and any other row refuses', () => {
    // A row shaped like a transaction that no list explains: a date first, or a number then a date.
    assert.throws(() => parseWellsFargoStatement(withItems(octoberStatement(), 3, [item('9/30', 45, 190), item('SYNTHETIC LATE ROW', 150, 190), right('9.00', 510, 190)])),
      /a dated row on page 3 after its Totals that no list it reads explains/);
    assert.throws(() => parseWellsFargoStatement(withItems(octoberStatement(), 3, [item('1002', 60, 190), item('9/30', 110, 190), right('9.00', 215, 190)])),
      /a dated row on page 3 after its Totals that no list it reads explains/);
    assert.throws(() => parseWellsFargoStatement(withItems(octoberStatement(), 3, realHeader(190))), /another transaction table after its Totals/);
    // Every check listed is a check row of the table: number, date and amount, each row once.
    for (const [from, to] of [['120.00', '121.00'], ['1001', '1002'], ['9/20', '9/21']] as const) {
      assert.throws(() => parseWellsFargoStatement(retextAt(320, from, to)), /Summary of checks written lists a check on page 3 that is not a check row of its table/, `${from} -> ${to}`);
    }
    const twice = octoberStatement();
    twice[2].items.push(item('Number', 260, 330), item('Date', 310, 330), item('Amount', 380, 330), item('1001', 260, 320), item('9/20', 310, 320), right('120.00', 415, 320));
    assert.throws(() => parseWellsFargoStatement(twice), /not a check row of its table/);
    const grouped = octoberStatement();
    grouped[2].items.push(item('Number', 260, 330), item('Date', 310, 330), item('Amount', 380, 330));
    assert.equal(parseWellsFargoStatement(grouped).rows.length, 4);
    assert.throws(() => parseWellsFargoStatement(retextAt(330, 'Number', 'Numbers')), /Summary of checks written has no Number Date Amount header/);
    assert.throws(() => parseWellsFargoStatement(withItems(octoberStatement(), 3, [item('*', 230, 320)])), /Summary of checks written has a line on page 3 that is not checks/);
    // An item returned unpaid is read whole: a date of the period, its description, one amount.
    for (const [from, to] of [['9/28', '10/9'], ['$75.00', '-$75.00'], ['SYNTHETIC CARD CO EPAYMENT 260928 PPD Reference # 000000000000001', 'SYNTHETIC CARD CO 5.00']] as const) {
      assert.throws(() => parseWellsFargoStatement(retext(octoberStatement(), { [from]: to })), /Items returned unpaid list has an item on page 3 that cannot be read whole/, to);
    }
    // Its Amount cell is read whole by the one grammar (Root 14:41Z): a sign, a parenthesis, a second amount or a split
    // number in it refuses, never taken for description; nor may the description state an amount, however split.
    const returnedCell = (cell: string, description = 'SYNTHETIC CARD CO EPAYMENT 260928 PPD Reference # 000000000000001') => octoberStatement().map((page, index) => (index !== 2 ? page
      : { items: [...page.items.filter((entry) => entry.y !== 278 || entry.text === '9/28'), item(description, 95, 278), right(cell, 570, 278)] }));
    assert.deepEqual(parseWellsFargoStatement(returnedCell('$75.00')).notes, ['the statement lists 1 item returned unpaid (2026-09-28); not activity, not imported']);
    assert.deepEqual(parseWellsFargoStatement(returnedCell('$ 75.00')).notes.length, 1);
    for (const cell of ['- $7.00', '+ $7.00', '( $7.00', '$5 $7.00', '5 .00 $7.00', '$7.00 suffix', '( $7.00 )']) {
      assert.throws(() => parseWellsFargoStatement(returnedCell(cell)), /Items returned unpaid list has an item on page 3 that cannot be read whole/, cell);
    }
    for (const description of ['SYNTHETIC RETURN $ 7', 'SYNTHETIC RETURN 7 .00', 'SYNTHETIC RETURN ($ 7)']) {
      assert.throws(() => parseWellsFargoStatement(returnedCell('$75.00', description)), /Items returned unpaid list has an item on page 3 that cannot be read whole/, description);
    }
    // Only that exact heading is read (Root 14:41Z): under any other, a bare `Items returned` included, its rows refuse.
    for (const heading of ['Items returned', 'Items returned unpaid:', 'Returned items']) {
      assert.throws(() => parseWellsFargoStatement(retext(octoberStatement(), { 'Items returned unpaid': heading })),
        /a dated row on page 3 after its Totals that no list it reads explains/, heading);
    }
    assert.throws(() => parseWellsFargoStatement(retextAt(287, 'Description', 'Details')), /Items returned unpaid list has no Date Description Amount header/);
    // Prose stating amounts (the fee summary, notices) after the Totals: not read, however it states them.
    const prose = withItems(octoberStatement(), 3, [item('Synthetic notice: fees of $ 7 and ($ 7) and 7 .00 may apply', 36, 60)]);
    assert.equal(parseWellsFargoStatement(prose).rows.length, 4);
  });
});

describe('checking import tool: generic core', () => {
  /** A bank CSV with a running balance column, as an adapter returns it (oldest first). */
  function runningExport(balances: Array<number | null>): ParsedCheckingExport {
    const amounts = [-2500, 10000, -500, -500];
    const dates = ['2026-10-02', '2026-10-03', '2026-10-03', '2026-10-06'];
    return {
      institution: 'fifththird', source: 'fifththird-csv', currency: 'USD', accountLast4: '1234', accountType: null, accountNumberRaw: null,
      madeAt: null, coverage: null, statement: null, ledgerBalance: null, availableBalance: null,
      rows: amounts.map((amountMinor, index) => ({
        line: index + 2, postedDate: dates[index], transactionDate: null, amountMinor, description: `SYNTHETIC ${index}`, checkNumber: null,
        typeHint: null, externalId: null, runningBalanceMinor: balances[index], pending: false, sourceTexts: [`SYNTHETIC ${index}`],
      })),
      problems: [], droppedColumns: [], notes: [],
    };
  }

  it('derives the opening and each day-end balance from running balances, and refuses a broken chain', () => {
    const { payload } = convertCheckingExports([{ name: 'file 1', parsed: runningExport([47500, 57500, 57000, 56500]) }],
      { institution: 'fifththird', label: 'Fifth Third checking', through: '2026-10-06' });
    assert.deepEqual(payload.segments[0].anchors.map((anchor) => [anchor.date, anchor.balanceMinor, anchor.kind]), [
      ['2026-10-01', 50000, 'opening'], ['2026-10-02', 47500, 'daily'], ['2026-10-03', 57000, 'daily'], ['2026-10-06', 56500, 'daily'],
    ]);
    // A day's last row without a balance: its balance still follows from the rows before it.
    const partial = convertCheckingExports([{ name: 'file 1', parsed: runningExport([47500, 57500, null, null]) }],
      { institution: 'fifththird', label: 'Fifth Third checking', through: '2026-10-06' });
    assert.deepEqual(partial.payload.segments[0].anchors.map((anchor) => anchor.balanceMinor), [50000, 47500, 57000, 56500]);
    assert.throws(() => convertCheckingExports([{ name: 'file 1', parsed: runningExport([47500, 57500, 57100, 56500]) }],
      { institution: 'fifththird', label: 'Fifth Third checking', through: '2026-10-06' }), /file 1 line 4: the balance printed there does not follow/);
  });

  it('checks balances the owner copied from the bank, for a single file only', () => {
    const csv = parseWellsFargoCsv(OCTOBER_CSV);
    const base = { through: '2026-10-20', accountLast4: '2931' };
    const ok = convert([csv], { ...base, expectOpeningBalanceMinor: 248000, expectClosingBalanceMinor: 501000 });
    assert.deepEqual(ok.report.files[0].checks, ['expected-balances']);
    refused(() => convert([csv], { ...base, expectOpeningBalanceMinor: 248000, expectClosingBalanceMinor: 501001 }), /--expect-opening-balance plus the rows/);
    refused(() => convert([csv, parseBankOfx(OCTOBER_QFX)], { ...base, expectClosingBalanceMinor: 501000 }), /apply to a single file/);
  });

  it('redacts card and account numbers, and refuses card secrets and anything that could still show them', () => {
    const withText = (description: string) => {
      const parsed = parseWellsFargoCsv(OCTOBER_CSV);
      parsed.rows[0] = { ...parsed.rows[0], description, sourceTexts: [description] };
      parsed.accountNumberRaw = ACCOUNT;
      return parsed;
    };
    const options = { through: '2026-10-20', accountLast4: '2931' };
    const redacted = convert([withText(`ONLINE TRANSFER TO CARD 4111 1111 1111 1111 FROM ${ACCOUNT}`)], options);
    assert.equal(redacted.payload.segments[0].rows[0].description, 'ONLINE TRANSFER TO CARD ***1111 FROM ***2931');
    // A shortened copy of the account number keeps no more than its last four; one from inside it keeps no digit.
    assert.equal(convert([withText('TRANSFER FROM ACCOUNT 6542931')], options).payload.segments[0].rows[0].description, 'TRANSFER FROM ACCOUNT ***2931');
    assert.equal(convert([withText('REF 9876542 931')], options).payload.segments[0].rows[0].description, 'REF *** 931');
    refused(() => convert([withText('SYNTHETIC CARD CVV 123')], options), /card security code, PIN or expiry date/);
    // Split into runs too short to redact (by separators or letters), five of its digits would still show: masked.
    const stored = (description: string) => convert([withText(description)], options).payload.segments[0].rows[0].description;
    assert.equal(stored('REF 9876-5429'), 'REF ****-****');
    assert.equal(stored('REF 9876-5 W1'), 'REF ****-* W1');
    assert.equal(stored('REF 98A76B5'), 'REF **A**B*');
    // A short account number is guarded too, and no digits ride in a bank slug.
    const short = parseBankOfx(qfx(OCTOBER, { account: '12345' }).replace('<NAME>ATM WITHDRAWAL', '<NAME>TRANSFER 12345'));
    assert.ok(convert([short]).payload.segments[0].rows.some((row) => row.description === 'TRANSFER ***2345'));
    assert.throws(() => convert([parseBankOfx(OCTOBER_QFX)], { institution: 'bank9876542931' }),
      (error: Error) => /--institution must be a lowercase slug of letters and hyphens/.test(error.message) && !error.message.includes('9876'));
  });

  it('masks five consecutive digits of a known account number in the digit-only projection of any text, however split', () => {
    const accounts = knownAccountDigits([{ accountNumberRaw: ACCOUNT, otherAccountNumbersRaw: ['10440', '1234'] }, { accountNumberRaw: null }]);
    assert.deepEqual(accounts, [ACCOUNT, '10440']);
    // Split by separators, letters or lines, or written in other digits: masked. Four of them, or a last four, remain.
    assert.equal(maskKnownAccountDigits('REF 9876-5 TO 2931', accounts), 'REF ****-* TO 2931');
    assert.equal(maskKnownAccountDigits('A9876B5', accounts), 'A****B*');
    assert.equal(maskKnownAccountDigits('line 9876\nline 5', accounts), 'line ****\nline *');
    assert.equal(maskKnownAccountDigits('ref \uFF19\uFF18\uFF17\uFF16\uFF15 and \u2079\u2078\u2077\u2076\u2075', accounts), 'ref ***** and *****');
    assert.equal(maskKnownAccountDigits('line 10440 of 6823', accounts), 'line ***** of 6823');
    assert.equal(maskKnownAccountDigits('rows 98 and 76; ***2931', accounts), 'rows 98 and 76; ***2931');
    assert.equal(maskKnownAccountDigits('line 10440', []), 'line 10440');
    assert.deepEqual(['USD', 'JPY', 'XYZ'].map((currency) => checkingCurrencyExponent(currency)), [2, 0, null]);
    // The core's own refusals too: a line number of one file that holds digits of another file's account is masked.
    const csv = parseWellsFargoCsv(OCTOBER_CSV);
    csv.problems.push({ line: 10440, reason: 'the date is not a valid MM/DD/YYYY date' });
    assert.throws(() => convert([csv, parseBankOfx(qfx(OCTOBER, { account: '7710440' }))], { through: '2026-10-20' }),
      (error: Error) => /file 1 line \*\*\*\*\*: the date is not a valid/.test(error.message) && !error.message.includes('10440'));
    // And every text of the report it returns, a name the caller gave a file included.
    const { report } = convertCheckingExports([{ name: 'statement 98765', parsed: parseBankOfx(OCTOBER_QFX) }], OPTIONS);
    assert.equal(report.files[0].name, 'statement *****');
    assert.ok(!JSON.stringify(report).includes('98765'));
  });

  it('redacts a description until nothing changes: the account mask across two fields leaves no number showing more than a last four', () => {
    // The real shape of one Wells Fargo ACH description (synthetic values): five digits of the account read across two
    // of its fields, `98` ending one and `765` starting the next. Masked in each, they leave `***` and seven more digits
    // of the second field, a masked number that card detection refuses; card redaction shortens it to a last four, and
    // the account mask then finds nothing more.
    const description = 'ACH CO#12A98 SYNTH PMT /ID=WEB SYNTH REF# 7655501234P TRN#310245678901 IND# A10293847';
    assert.equal(maskKnownAccountDigits(description, [ACCOUNT]),
      'ACH CO#12A** SYNTH PMT /ID=WEB SYNTH REF# ***5501234P TRN#310245678901 IND# A10293847');
    const stored = 'ACH CO#12A** SYNTH PMT /ID=WEB SYNTH REF# ***1234P TRN#310245678901 IND# A10293847';
    const csv = parseWellsFargoCsv(OCTOBER_CSV.replace('ZELLE TO SYNTHETIC FRIEND', description));
    const ofx = parseBankOfx(qfx(OCTOBER.map((row) => (row.fitid === 'F3' ? { ...row, name: description } : row)), { ledger: ['5000.00', '2026-10-21'] }));
    const descriptions = (files: ParsedCheckingExport[]) => convert(files, { through: '2026-10-20' }).payload.segments
      .map((segment) => segment.rows.filter((row) => row.description.startsWith('ACH CO#')).map((row) => row.description));
    // The QFX names the account: alone, and with the CSV in either order, every copy is stored redacted, the same.
    assert.deepEqual(descriptions([ofx]), [[stored]]);
    assert.deepEqual(descriptions([csv, ofx]), [[stored], [stored]]);
    assert.deepEqual(descriptions([ofx, csv]), [[stored], [stored]]);
    assert.equal(maskKnownAccountDigits(stored, [ACCOUNT]), stored);
    // A CSV names no account number: on its own, nothing in it can be masked (convert every file of the account in one run).
    assert.deepEqual(convert([csv], { through: '2026-10-20', accountLast4: '2931' }).payload.segments[0].rows
      .filter((row) => row.description.startsWith('ACH CO#')).map((row) => row.description), [description]);
    // The final check still refuses what redaction cannot remove.
    refused(() => convert([parseBankOfx(qfx(OCTOBER.map((row) => (row.fitid === 'F3' ? { ...row, name: `${description} CVV 123` } : row))))],
      { through: '2026-10-20' }), /card security code, PIN or expiry date/);
  });

  it('leaves structural fields as they are, never the same digits in a text field (Root 02:31Z)', () => {
    // A five-digit account that every September 2026 date repeats: 2026-09-01 reads 20260901.
    const september: OfxRow[] = [
      { type: 'DEBIT', date: '2026-09-02', amount: '-25.00', fitid: 'S1', name: 'SYNTHETIC SHOP 2026-09-01' },
      { type: 'DEBIT', date: '2026-09-03', amount: '-10.00', fitid: 'S2', name: 'TRANSFER REF 20260' },
      { type: 'CHECK', date: '2026-09-04', amount: '-5.00', fitid: 'S3', name: 'CHECK', check: '1002' },
    ];
    const statement = (rows: OfxRow[]) => parseBankOfx(qfx(rows, { account: '20260', start: '2026-09-01', end: '2026-09-30', server: '2026-10-01' }));
    const { payload, report } = convertCheckingExports([{ name: 'file 20260', parsed: statement(september) }], OPTIONS);
    const [segment] = payload.segments;
    // Dates, amounts and counts: as they are, in the payload and in the report; the conversion does not refuse.
    assert.deepEqual(segment.coverage, { start: '2026-09-01', end: '2026-09-30' });
    assert.deepEqual(segment.rows.map((row) => [row.postedDate, row.amountMinor]), [['2026-09-02', -2500], ['2026-09-03', -1000], ['2026-09-04', -500]]);
    assert.deepEqual(report.files[0].coverage, { start: '2026-09-01', end: '2026-09-30' });
    assert.deepEqual(report.summary.coverage, [{ start: '2026-09-01', end: '2026-09-30' }]);
    assert.equal(report.summary.rows, 3);
    // The same digits in a text field: masked (a description, a file's name), or refused where they cannot be (a
    // check number).
    assert.deepEqual(segment.rows.map((row) => row.description), ['SYNTHETIC SHOP ****-*9-01', 'TRANSFER REF ***0260', 'CHECK']);
    assert.equal(report.files[0].name, 'file *****');
    refused(() => convert([statement(september.map((row) => (row.check ? { ...row, check: '20260' } : row)))]), /would still show more than four digits/);
  });
});
