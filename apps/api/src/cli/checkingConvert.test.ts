import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { validateCheckingImportPayload } from '@finance-tracker/shared';

import { digest } from '../services/amazon/policy.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { pdfDocument } from '../testing/syntheticPdf.js';
import { CHECKING_CONVERT_EXIT, CHECKING_CONVERT_USAGE, runCheckingConvertCli } from './checkingConvert.js';
import { pdfTextPages } from './checkingPdfText.js';

// Synthetic only: every account number, name, amount and description below is made up.
type Cell = [x: number, y: number, text: string];

/** A real PDF whose pages show each cell's text at its position, in Helvetica 9. */
function positionedPdf(pages: Cell[][]): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  const font = 3 + pages.length * 2;
  for (const cells of pages) {
    const content = cells.map(([x, y, text]) => `BT /F1 9 Tf ${x} ${y} Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  return pdfDocument(objects);
}

const right = (text: string, edge: number, y: number): Cell => [edge - text.length * 5, y, text];
const header = (y: number): Cell[] => [
  [75, y + 10, 'Check'], [380, y + 10, 'Deposits/'], [445, y + 10, 'Withdrawals/'], [515, y + 10, 'Ending daily'],
  [40, y, 'Date'], [75, y, 'Number'], [120, y, 'Description'], [380, y, 'Additions'], [445, y, 'Subtractions'], [525, y, 'balance'],
];
const STATEMENT: Cell[][] = [
  [
    [40, 760, 'Everyday Checking'], [40, 745, 'Account number: 9876542931'], [250, 745, 'September 1, 2026 - September 30, 2026'],
    [40, 650, 'Statement period activity summary'],
    [40, 635, 'Beginning balance on 9/1'], right('$2,000.00', 300, 635),
    [40, 620, 'Deposits/Additions'], right('1,000.00', 300, 620),
    [40, 605, 'Withdrawals/Subtractions'], right('- 520.00', 300, 605),
    [40, 590, 'Ending balance on 9/30'], right('$2,480.00', 300, 590),
    [40, 500, 'Transaction history'], ...header(470),
    [40, 455, '9/2'], [120, 455, 'Online Transfer From Savings Ref #IB0SYNTH'], right('1,000.00', 420, 455), right('3,000.00', 565, 455),
    [40, 440, '9/10'], [75, 440, '1001'], [120, 440, 'Check'], right('120.00', 490, 440),
    [40, 425, '9/10'], [120, 425, 'Purchase authorized on 09/08 Synthetic Store'], right('80.00', 490, 425), right('2,800.00', 565, 425),
    [120, 415, 'S0000000000000001234 Card 5678'],
    [40, 40, '(c) 2026 Wells Fargo Bank, N.A. All rights reserved. Member FDIC.'],
  ],
  [
    [40, 760, 'Account number: 9876542931 September 1, 2026 - September 30, 2026 Page 2 of 2'],
    [40, 700, 'Transaction history (continued)'], ...header(670),
    [40, 655, '9/20'], [120, 655, 'CITI AUTOPAY 123456789012345 SYNTH'], right('320.00', 490, 655), right('2,480.00', 565, 655),
    [120, 640, 'Ending balance on 9/30'], right('2,480.00', 565, 640),
    [120, 625, 'Totals'], right('$1,000.00', 420, 625), right('$520.00', 490, 625),
    [40, 600, 'The Ending Daily Balance does not reflect any pending withdrawals or holds'],
  ],
];

const at = (date: string) => `${date.replace(/-/g, '')}120000.000[-4:EDT]`;
const trn = (type: string, date: string, amount: string, fitid: string, name: string) =>
  `<STMTTRN>\n<TRNTYPE>${type}\n<DTPOSTED>${at(date)}\n<TRNAMT>${amount}\n<FITID>${fitid}\n<NAME>${name}\n</STMTTRN>`;
const QFX = ['OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', '', '<OFX>', '<SIGNONMSGSRSV1>', '<SONRS>', '<STATUS>', '<CODE>0', '<SEVERITY>INFO', '</STATUS>',
  `<DTSERVER>${at('2026-10-21')}`, '</SONRS>', '</SIGNONMSGSRSV1>', '<BANKMSGSRSV1>', '<STMTTRNRS>', '<TRNUID>1', '<STATUS>', '<CODE>0', '<SEVERITY>INFO',
  '</STATUS>', '<STMTRS>', '<CURDEF>USD', '<BANKACCTFROM>', '<BANKID>121000248', '<ACCTID>9876542931', '<ACCTTYPE>CHECKING', '</BANKACCTFROM>',
  '<BANKTRANLIST>', `<DTSTART>${at('2026-10-01')}`, `<DTEND>${at('2026-10-21')}`,
  trn('DEBIT', '2026-10-02', '-250.00', 'F1', 'AMEX EPAYMENT ACH PMT'), trn('CREDIT', '2026-10-05', '3000.00', 'F2', 'SYNTHETIC PAYROLL'),
  trn('DEBIT', '2026-10-21', '-10.00', 'F3', 'SYNTHETIC COFFEE'), '</BANKTRANLIST>',
  '<LEDGERBAL>', '<BALAMT>5220.00', `<DTASOF>${at('2026-10-21')}`, '</LEDGERBAL>', '</STMTRS>', '</STMTTRNRS>', '</BANKMSGSRSV1>', '</OFX>', ''].join('\r\n');
const CSV = ['"10/21/2026","-10.00","*","","SYNTHETIC COFFEE"', '"10/05/2026","3000.00","*","","SYNTHETIC PAYROLL"',
  '"10/02/2026","-250.00","*","","AMEX EPAYMENT ACH PMT 261002 W1234 SYNTH HOLDER"', ''].join('\r\n');

let dir: string, stdout: string, stderr: string;
const run = (args: string[]) => runCheckingConvertCli(args, { stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } });
const file = (name: string, content: string | Buffer) => {
  const target = path.join(dir, name);
  fs.writeFileSync(target, content);
  return target;
};
beforeEach(async () => {
  stdout = '';
  stderr = '';
  dir = await makeScratchDir('checking-convert-');
});
afterEach(async () => { await removeScratchDir(dir); });

describe('holdr-checking-convert', () => {
  it('reads a statement PDF back with every piece of text where it was put', async () => {
    const pages = await pdfTextPages(positionedPdf(STATEMENT));
    expect(pages).toHaveLength(2);
    const nine = pages[0].items.find((item) => item.text === '9/2');
    expect(nine).toMatchObject({ x: 40, y: 455 });
    await expect(pdfTextPages(Buffer.from('%PDF-1.4 not really'))).rejects.toThrow('the PDF could not be opened');
  });

  it('converts a statement, a QFX and a CSV of one account into one payload, printing counts, dates and checks only', async () => {
    const out = path.join(dir, 'wf-checking.json');
    const code = await run(['--institution', 'wellsfargo', '--label', 'Wells Fargo Everyday Checking', '--out', out, '--through', '2026-10-20',
      file('statement.pdf', positionedPdf(STATEMENT)), file('activity.qfx', QFX), file('activity.csv', CSV)]);
    expect(stderr).toBe('');
    expect(code).toBe(CHECKING_CONVERT_EXIT.ok);
    const report = JSON.parse(stdout);
    const payload = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(validateCheckingImportPayload(payload).ok).toBe(true);
    expect(report).toMatchObject({
      code: 'checking-converted', parser: 'holdr-checking-import@1.0.0',
      account: { institution: 'wellsfargo', last4: '2931', label: 'Wells Fargo Everyday Checking', currency: 'USD' },
      summary: { segments: 3, rows: 6, coverage: [{ start: '2026-09-01', end: '2026-10-20' }] },
      balanceChain: { checked: 5, gaps: 0 },
      payloadDigest: digest(payload),
    });
    expect(report.files.map((entry: { name: string; source: string }) => [entry.name, entry.source]))
      .toEqual([['file 1', 'wf-statement'], ['file 2', 'ofx'], ['file 3', 'wf-csv']]);
    expect(stdout).not.toMatch(/9876542931|SYNTH|AMEX|2,480|248000|5220|522000|123456789012345/);
    const text = JSON.stringify(payload);
    expect(text).not.toMatch(/9876542931|123456789012345|"F1"/);
    expect(payload.segments[0].rows[3].description).toBe('CITI AUTOPAY ***2345 SYNTH');
    if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  });

  it('refuses, writing nothing, when files disagree, and never overwrites --out', async () => {
    const out = path.join(dir, 'never.json');
    const disagreeing = CSV.replace('"10/05/2026","3000.00"', '"10/05/2026","3000.01"');
    expect(await run(['--institution', 'wellsfargo', '--label', 'Wells Fargo Everyday Checking', '--out', out, '--through', '2026-10-20',
      file('activity.qfx', QFX), file('activity.csv', disagreeing)])).toBe(CHECKING_CONVERT_EXIT.refused);
    expect(stderr).toMatch(/disagree on 1 of them: 2026-10-05/);
    expect(stderr).not.toMatch(/3000|SYNTH/);
    expect(fs.existsSync(out)).toBe(false);
    stderr = '';
    const existing = file('existing.json', 'keep');
    expect(await run(['--institution', 'wellsfargo', '--label', 'Checking', '--out', existing, '--through', '2026-10-20', file('a.qfx', QFX)])).toBe(CHECKING_CONVERT_EXIT.usage);
    expect(fs.readFileSync(existing, 'utf8')).toBe('keep');
    expect(await run(['--institution', 'wellsfargo', '--label', 'Checking 2931', '--out', out, file('b.qfx', QFX)])).toBe(CHECKING_CONVERT_EXIT.usage);
    expect(await run(['--institution', 'wellsfargo', '--label', 'Checking', '--out', out, '--through', '2026-10-20', file('notes.txt', 'nothing to see')]))
      .toBe(CHECKING_CONVERT_EXIT.refused);
    expect(stderr).toMatch(/file 1: is not a format this tool recognizes/);
    stdout = '';
    expect(await run(['--institution', 'wellsfargo', '--label', 'Checking', '--account', '2931', '--through', '2026-10-20', '--dry-run', file('c.csv', CSV)]))
      .toBe(CHECKING_CONVERT_EXIT.ok);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'checking-dry-run', summary: { rows: 2 } });
    expect(fs.existsSync(out)).toBe(false);
  });

  it('reads balances the owner copied in the files\' own currency units', async () => {
    const jpy = ['OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', '', '<OFX>', '<SIGNONMSGSRSV1>', '<SONRS>', '<STATUS>', '<CODE>0', '<SEVERITY>INFO',
      '</STATUS>', `<DTSERVER>${at('2026-10-21')}`, '</SONRS>', '</SIGNONMSGSRSV1>', '<BANKMSGSRSV1>', '<STMTTRNRS>', '<TRNUID>1', '<STATUS>', '<CODE>0',
      '<SEVERITY>INFO', '</STATUS>', '<STMTRS>', '<CURDEF>JPY', '<BANKACCTFROM>', '<BANKID>1', '<ACCTID>9876542931', '<ACCTTYPE>CHECKING',
      '</BANKACCTFROM>', '<BANKTRANLIST>', `<DTSTART>${at('2026-10-01')}`, `<DTEND>${at('2026-10-20')}`, trn('DEBIT', '2026-10-02', '-10', 'J1', 'SYNTHETIC KIOSK'),
      '</BANKTRANLIST>', '</STMTRS>', '</STMTTRNRS>', '</BANKMSGSRSV1>', '</OFX>', ''].join('\r\n');
    const yen = file('yen.qfx', jpy);
    expect(await run(['--institution', 'syntheticbank', '--label', 'Checking', '--dry-run', '--expect-opening-balance', '100',
      '--expect-closing-balance', '90', yen])).toBe(CHECKING_CONVERT_EXIT.ok);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'checking-dry-run', account: { currency: 'JPY' }, files: [{ checks: ['expected-balances'] }] });
    stdout = '';
    expect(await run(['--institution', 'syntheticbank', '--label', 'Checking', '--dry-run', '--expect-opening-balance', '100.50',
      '--expect-closing-balance', '90', yen])).toBe(CHECKING_CONVERT_EXIT.usage);
    expect(stderr).toMatch(/--expect-opening-balance has more than 0 decimal places/);
    stderr = '';
    // A currency without a known minor unit: the copied balances cannot be read in it.
    const unknown = file('xyz.qfx', jpy.replace('<CURDEF>JPY', '<CURDEF>XYZ'));
    expect(await run(['--institution', 'syntheticbank', '--label', 'Checking', '--dry-run', '--expect-closing-balance', '90', unknown]))
      .toBe(CHECKING_CONVERT_EXIT.usage);
    expect(stderr).toMatch(/need a currency whose minor unit this tool knows/);
  });

  it('prints every diagnostic with fixed labels when a file\'s account numbers are unknown (Root 04:08Z)', async () => {
    // An OFX the reader refuses at line 10440 (its account unknown), with a CSV refused at line 10440, in both orders.
    const deep = file('deep.qfx', `${'\r\n'.repeat(10431)}<OFX>\r\n<BANKMSGSRSV1>\r\n<STMTTRNRS>\r\n<STMTRS>\r\n<BANKACCTFROM>\r\n<ACCTID>77<?synthetic?>10440\r\n`
      + '<ACCTTYPE>CHECKING\r\n</BANKACCTFROM>\r\n<BROKEN');
    const rows = Array.from({ length: 10439 }, () => '"10/25/2026","-1.00","*","","SYNTHETIC ROW"');
    const columns = file('columns.csv', [...rows, '"10/25/2026","-1.00","*",""', ''].join('\r\n'));
    for (const files of [[deep, columns], [columns, deep]]) {
      stdout = '';
      stderr = '';
      expect(await run(['--explain', ...files])).toBe(CHECKING_CONVERT_EXIT.ok);
      const explained = JSON.parse(stdout);
      expect(explained.files.map((entry: { refused: string }) => entry.refused).sort())
        .toEqual(['a tag is not closed (the file may be truncated)', 'line #: has # columns; a Wells Fargo CSV has #']);
      expect(explained.files.map((entry: { name: string }) => entry.name)).toEqual(['file 1', 'file 2']);
      expect(await run(['--institution', 'wellsfargo', '--label', 'Checking', '--dry-run', '--through', '2026-10-25', ...files]))
        .toBe(CHECKING_CONVERT_EXIT.refused);
      expect(stderr).toMatch(/2 files were refused/);
      expect(stderr).toMatch(/file [12]: a tag is not closed \(the file may be truncated\)/);
      expect(stderr).toMatch(/file [12]: line #: has # columns; a Wells Fargo CSV has #/);
      expect(stdout + stderr).not.toContain('10440');
    }
    // A file no format reads leaves its numbers unknown too.
    stderr = '';
    expect(await run(['--institution', 'wellsfargo', '--label', 'Checking', '--dry-run', '--through', '2026-10-25', file('notes.txt', 'synthetic 7710440'), columns]))
      .toBe(CHECKING_CONVERT_EXIT.refused);
    expect(stderr).toMatch(/file 2: line #: has # columns/);
    expect(stderr).not.toContain('10440');
  });

  it('keeps five digits of any account number the files name out of all it prints, across files', async () => {
    // A seven-digit account whose digits a line number of another file repeats.
    const qfx = file('a.qfx', QFX.replace('<ACCTID>9876542931', '<ACCTID>7710440'));
    const rows = Array.from({ length: 10439 }, () => '"10/25/2026","-1.00","*","","SYNTHETIC ROW"');
    const badDate = file('dates.csv', [...rows, '"13/45/2026","-1.00","*","","SYNTHETIC ROW"', ''].join('\r\n'));
    expect(await run(['--explain', badDate, qfx])).toBe(CHECKING_CONVERT_EXIT.ok);
    // The line number is structural (a whole number) and stays; text holding the same digits is masked (below).
    expect(JSON.parse(stdout).files[0].problems).toEqual([{ line: 10440, reason: 'the date is not a valid MM/DD/YYYY date' }]);
    stdout = '';
    expect(await run(['--institution', 'wellsfargo', '--label', 'Checking', '--dry-run', '--through', '2026-10-25', badDate, qfx]))
      .toBe(CHECKING_CONVERT_EXIT.refused);
    expect(stderr).toMatch(/file 1 line \*\*\*\*\*: the date is not a valid/);
    // A file refused before the file naming the account is read: every file is read before anything is printed.
    const columns = file('columns.csv', [...rows, '"10/25/2026","-1.00","*",""', ''].join('\r\n'));
    expect(await run(['--institution', 'wellsfargo', '--label', 'Checking', '--dry-run', '--through', '2026-10-25', columns, qfx]))
      .toBe(CHECKING_CONVERT_EXIT.refused);
    expect(stderr).toMatch(/file 1: line \*\*\*\*\*: has 4 columns/);
    expect(stderr).not.toContain('10440');
  });

  it('leaves structural fields as they are, never the same digits in text (Root 02:31Z)', async () => {
    // A five-digit account whose digits the first covered day repeats: 2026-10-01 reads 20261001, which holds 26100.
    const qfx = file('a.qfx', QFX.replace('<ACCTID>9876542931', '<ACCTID>26100'));
    expect(await run(['--explain', qfx])).toBe(CHECKING_CONVERT_EXIT.ok);
    expect(JSON.parse(stdout).files[0]).toMatchObject({ coverage: { start: '2026-10-01', end: '2026-10-21' }, madeAt: '2026-10-21', accountLast4: '6100' });
    stdout = '';
    expect(await run(['--institution', 'wellsfargo', '--label', 'Checking', '--dry-run', qfx])).toBe(CHECKING_CONVERT_EXIT.ok);
    const report = JSON.parse(stdout);
    expect(report.files[0].coverage).toEqual({ start: '2026-10-01', end: '2026-10-20' });
    expect(report.summary.coverage).toEqual([{ start: '2026-10-01', end: '2026-10-20' }]);
    expect(report.parser).toBe('holdr-checking-import@1.0.0');
    expect(report.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    stdout = '';
    // The same day written in a refusal's text is masked: a diagnostic is text ("1 of them: 2026-10-01" holds 26100).
    const disagreeing = file('b.csv', '"10/01/2026","-1.00","*","","SYNTHETIC ROW"\r\n');
    expect(await run(['--institution', 'wellsfargo', '--label', 'Checking', '--dry-run', '--through', '2026-10-01', qfx, disagreeing]))
      .toBe(CHECKING_CONVERT_EXIT.refused);
    expect(stderr).toMatch(/disagree on 1 of them: 20\*\*-\*\*-\*1/);
  });

  it('explains what it found in each file without writing anything or printing values', async () => {
    expect(await run(['--explain', file('statement.pdf', positionedPdf(STATEMENT)), file('activity.qfx', QFX)])).toBe(CHECKING_CONVERT_EXIT.ok);
    const explained = JSON.parse(stdout);
    expect(explained.code).toBe('checking-explained');
    expect(explained.files[0]).toMatchObject({ name: 'file 1', format: 'wf-statement', rows: 4, statesStatementBalances: true, runningBalances: 3,
      coverage: { start: '2026-09-01', end: '2026-09-30' }, layout: { pages: 2, periodFound: true, transactionHistoryFound: true } });
    expect(explained.files[1]).toMatchObject({ name: 'file 2', format: 'ofx', rows: 3, madeAt: '2026-10-21', accountType: 'CHECKING' });
    expect(stdout).not.toMatch(/9876542931|SYNTH|AMEX|2,480|5220/);
    expect(fs.readdirSync(dir).sort()).toEqual(['activity.qfx', 'statement.pdf']);
    stdout = '';
    // --account is checked before any file is read and never echoed, in --explain too.
    expect(await run(['--explain', '--account', '4111111111111111', path.join(dir, 'activity.qfx')])).toBe(CHECKING_CONVERT_EXIT.usage);
    expect(stderr).toMatch(/--account must be the last four digits/);
    expect(stderr + stdout).not.toContain('4111');
    stderr = '';
    expect(await run(['--formats'])).toBe(0);
    expect(stdout).toMatch(/ofx +any bank/);
    expect(stdout).toMatch(/wf-statement +wellsfargo/);
    stdout = '';
    expect(await run(['--help'])).toBe(0);
    expect(stdout).toBe(CHECKING_CONVERT_USAGE);
  });
});
