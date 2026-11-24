/**
 * Fifth Third through the offline converter, end to end: a generated synthetic statement PDF read by pdf.js, and the
 * CLI turning a CSV, a QFX and that PDF of one month into one payload. Synthetic fixtures only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateCheckingImportPayload } from '@finance-tracker/shared';
import { fifthThirdStatementAdapter, parseFifthThirdStatement } from '@finance-tracker/shared/checking-import-tool';

import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { positionedPdf } from '../testing/syntheticPdf.js';
import { runCheckingConvertCli } from './checkingConvert.js';
import { pdfTextPages } from './checkingPdfText.js';

const FIXTURES = fileURLToPath(new URL('../../../../packages/shared/src/checkingImportTool/fixtures/fifththird/', import.meta.url));
const fixturePath = (name: string) => path.join(FIXTURES, name);
type Cell = [number, number, string];
const LAYOUT = JSON.parse(readFileSync(fixturePath('statement-2026-09.layout.json'), 'utf8')) as { pages: Cell[][] };
const OCTOBER = JSON.parse(readFileSync(fixturePath('statement-2026-10.layout.json'), 'utf8')) as { pages: Cell[][] };
const NOVEMBER = JSON.parse(readFileSync(fixturePath('statement-2026-11.layout.json'), 'utf8')) as { pages: Cell[][] };
const DECEMBER = JSON.parse(readFileSync(fixturePath('statement-2026-12.layout.json'), 'utf8')) as { pages: Cell[][] };
const JANUARY = JSON.parse(readFileSync(fixturePath('statement-2027-01.layout.json'), 'utf8')) as { pages: Cell[][] };
const FEBRUARY = JSON.parse(readFileSync(fixturePath('statement-2027-02.layout.json'), 'utf8')) as { pages: Cell[][] };
const STATEMENT_LAYOUTS = {
  '2026-09': LAYOUT,
  '2026-10': OCTOBER,
  '2026-11': NOVEMBER,
  '2026-12': DECEMBER,
  '2027-01': JANUARY,
  '2027-02': FEBRUARY,
} as const;
const VALUES = ['CONTOSO', 'GROCERY', 'CHASE', 'AMEX', '1234.56', '1,234.56', '2532.57', '2,532.57', '9990004321', 'S20260901A0001', '4,421.57', '1,311.00',
  '4,160.57', '6,849.57', '261.00', '511.00', '9,538.57', '12,477.57'];

function run(argv: string[]) {
  const out = { stdout: '', stderr: '' };
  const io = { stdout: { write: (text: string) => (out.stdout += text) }, stderr: { write: (text: string) => (out.stderr += text) } };
  return runCheckingConvertCli(argv, io).then((status) => ({ status, ...out }));
}

function expectValueFree(text: string) {
  for (const value of VALUES) expect(text, `shows ${value}`).not.toContain(value);
}

/** Replaces the text of the first cell (or every cell, with `all`) that reads `from`. */
function replaceCell(pages: Cell[][], from: string, to: string, all = false) {
  let found = false;
  for (const page of pages) {
    for (const cell of page) {
      if (cell[2] !== from || (found && !all)) continue;
      cell[2] = to;
      found = true;
    }
  }
  if (!found) throw new Error('no such synthetic cell');
}

describe('Fifth Third statement PDF and converter CLI', () => {
  let dir: string;
  const statementPath = (month: keyof typeof STATEMENT_LAYOUTS) => path.join(dir, `statement-${month}.pdf`);
  beforeEach(async () => {
    dir = await makeScratchDir('fifththird-');
    await Promise.all(Object.entries(STATEMENT_LAYOUTS).map(([month, layout]) =>
      writeFile(statementPath(month as keyof typeof STATEMENT_LAYOUTS), positionedPdf(layout.pages))));
  });
  afterEach(async () => {
    await removeScratchDir(dir);
  });

  it('generates statement PDFs from the synthetic layouts, byte for byte', () => {
    for (const [month, layout] of Object.entries(STATEMENT_LAYOUTS)) {
      expect(positionedPdf(layout.pages).equals(readFileSync(statementPath(month as keyof typeof STATEMENT_LAYOUTS)))).toBe(true);
    }
  });

  it('reads notices whose prose states whole-dollar terms through pdf.js, and chains September to February', async () => {
    const january = parseFifthThirdStatement(await pdfTextPages(new Uint8Array(readFileSync(statementPath('2027-01')))));
    expect(january.statement).toEqual({ openingBalanceMinor: 684957, closingBalanceMinor: 953857, depositsMinor: 320000, withdrawalsMinor: 51100 });
    const february = parseFifthThirdStatement(await pdfTextPages(new Uint8Array(readFileSync(statementPath('2027-02')))));
    expect(february.statement).toEqual({ openingBalanceMinor: 953857, closingBalanceMinor: 1247757, depositsMinor: 320000, withdrawalsMinor: 26100 });
    const out = path.join(dir, 'statements.json');
    const result = await run(['--institution', 'fifththird', '--label', 'Fifth Third Momentum Checking', '--out', out,
      ...(Object.keys(STATEMENT_LAYOUTS) as Array<keyof typeof STATEMENT_LAYOUTS>).map(statementPath)]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expectValueFree(result.stdout);
    const report = JSON.parse(result.stdout);
    expect(report.summary).toMatchObject({ segments: 6, rows: 25, days: 181 });
    expect(report.balanceChain).toEqual({ checked: 22, gaps: 0 });
    expect(validateCheckingImportPayload(JSON.parse(await readFile(out, 'utf8'))).ok).toBe(true);
    const explained = await run(['--explain', statementPath('2027-01'), statementPath('2027-02')]);
    expect(explained.status).toBe(0);
    expectValueFree(explained.stdout);
    const [januaryLayout, februaryLayout] = JSON.parse(explained.stdout).files.map((file: { layout: Record<string, unknown> }) => file.layout);
    expect(januaryLayout).toMatchObject({ unreadShapes: [], summaryUnknown: [] });
    expect(februaryLayout).toMatchObject({ unreadShapes: [], summaryUnknown: [] });
    expect(februaryLayout.sections['Daily Balance Summary']).toMatchObject({ skipped: 3, unread: 0 });
    expect((februaryLayout.skippedShapes as Array<{ shape: string }>).some(({ shape }) => shape.includes('<$whole>'))).toBe(true);
  });

  it('reads a month without deposits and a statement with notices through pdf.js, and chains September to December', async () => {
    const november = parseFifthThirdStatement(await pdfTextPages(new Uint8Array(readFileSync(statementPath('2026-11')))));
    expect(november.statement).toEqual({ openingBalanceMinor: 442157, closingBalanceMinor: 416057, depositsMinor: 0, withdrawalsMinor: 26100 });
    const december = parseFifthThirdStatement(await pdfTextPages(new Uint8Array(readFileSync(statementPath('2026-12')))));
    expect([december.accountType, december.rows.length]).toEqual(['CHECKING', 3]);
    const out = path.join(dir, 'statements.json');
    const result = await run(['--institution', 'fifththird', '--label', 'Fifth Third Momentum Checking', '--out', out,
      ...(['2026-09', '2026-10', '2026-11', '2026-12'] as const).map(statementPath)]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expectValueFree(result.stdout);
    const report = JSON.parse(result.stdout);
    expect(report.summary).toMatchObject({ segments: 4, rows: 19, days: 122 });
    expect(report.balanceChain).toEqual({ checked: 15, gaps: 0 });
    expect(validateCheckingImportPayload(JSON.parse(await readFile(out, 'utf8'))).ok).toBe(true);
    const explained = await run(['--explain', statementPath('2026-11'), statementPath('2026-12')]);
    expect(explained.status).toBe(0);
    expectValueFree(explained.stdout);
    const [novemberLayout, decemberLayout] = JSON.parse(explained.stdout).files.map((file: { layout: Record<string, unknown> }) => file.layout);
    expect(novemberLayout.summaryFound).toEqual(['opening', 'checks (blank)', 'withdrawals', 'deposits (blank)', 'closing']);
    expect(decemberLayout).toMatchObject({ accountKinds: ['CHECKING'], unreadShapes: [], summaryUnknown: [] });
  });

  it('reads a statement laid out as Fifth Third prints them today through pdf.js, and chains it to the month before', async () => {
    const pages = await pdfTextPages(new Uint8Array(readFileSync(statementPath('2026-10'))));
    const parsed = parseFifthThirdStatement(pages);
    expect([parsed.accountLast4, parsed.accountType]).toEqual(['4321', 'CHECKING']);
    expect(parsed.statement).toEqual({ openingBalanceMinor: 253257, closingBalanceMinor: 442157, depositsMinor: 320000, withdrawalsMinor: 131100 });
    expect(parsed.rows.map((row) => [row.postedDate, row.amountMinor])).toEqual([
      ['2026-10-01', 320000], ['2026-10-02', -100000], ['2026-10-15', -30000], ['2026-10-31', -1100],
    ]);
    const out = path.join(dir, 'statements.json');
    const result = await run(['--institution', 'fifththird', '--label', 'Fifth Third Momentum Checking', '--out', out,
      statementPath('2026-09'), statementPath('2026-10')]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expectValueFree(result.stdout);
    const report = JSON.parse(result.stdout);
    expect(report.summary).toMatchObject({ segments: 2, rows: 14, days: 61 });
    expect(report.balanceChain).toEqual({ checked: 10, gaps: 0 });
    expect(validateCheckingImportPayload(JSON.parse(await readFile(out, 'utf8'))).ok).toBe(true);
  });

  it('reads the statement PDF through pdf.js as the layout says', async () => {
    const pages = await pdfTextPages(new Uint8Array(readFileSync(statementPath('2026-09'))));
    const parsed = parseFifthThirdStatement(pages);
    expect(parsed.coverage).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(parsed.accountLast4).toBe('4321');
    expect(parsed.statement).toEqual({ openingBalanceMinor: 250000, closingBalanceMinor: 253257, depositsMinor: 320012, withdrawalsMinor: 316755 });
    expect(parsed.rows.map((row) => [row.postedDate, row.amountMinor])).toEqual([
      ['2026-09-01', 320000], ['2026-09-01', -10000], ['2026-09-02', -123456], ['2026-09-02', -98765], ['2026-09-03', -25000],
      ['2026-09-03', -4217], ['2026-09-03', -4217], ['2026-09-08', -50000], ['2026-09-15', 12], ['2026-09-30', -1100],
    ]);
  });

  it('converts a CSV, a QFX and a statement of one month into one payload, reporting no value', async () => {
    const out = path.join(dir, 'fifththird.json');
    const result = await run([
      '--institution', 'fifththird', '--label', 'Fifth Third Momentum Checking', '--through', '2026-09-30', '--out', out,
      fixturePath('activity.csv'), fixturePath('activity.qfx'), statementPath('2026-09'),
    ]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expectValueFree(result.stdout);
    const report = JSON.parse(result.stdout);
    expect(report.code).toBe('checking-converted');
    expect(report.files.map((file: { source: string }) => file.source)).toEqual(['fifththird-csv', 'ofx', 'fifththird-statement']);
    expect(report.summary).toMatchObject({ segments: 3, rows: 10, days: 30, coverage: [{ start: '2026-09-01', end: '2026-09-30' }] });
    expect(report.balanceChain).toEqual({ checked: 6, gaps: 0 });
    const payload = JSON.parse(await readFile(out, 'utf8'));
    expect(validateCheckingImportPayload(payload).ok).toBe(true);
    expect(payload.account).toEqual({ institution: 'fifththird', type: 'checking', last4: '4321', label: 'Fifth Third Momentum Checking', currency: 'USD' });
  });

  it('explains a statement by its layout, without a value', async () => {
    const result = await run(['--explain', statementPath('2026-09')]);
    expect(result.status).toBe(0);
    expectValueFree(result.stdout);
    const [file] = JSON.parse(result.stdout).files;
    expect(file).toMatchObject({ format: 'fifththird-statement', rows: 10, statesStatementBalances: true, accountLast4: '4321' });
    expect(file.layout.sections['Withdrawals / Debits']).toMatchObject({ rows: 7, wrapped: 1, unread: 0 });
  });

  it('refuses a statement it cannot fully read, naming what failed and no value', async () => {
    const pages = LAYOUT.pages.map((cells) => cells.filter((cell) => cell[1] !== 460 || cells !== LAYOUT.pages[0]));
    const damaged = path.join(dir, 'damaged.pdf');
    await writeFile(damaged, positionedPdf(pages));
    const result = await run(['--institution', 'fifththird', '--label', 'Fifth Third Checking', '--out', path.join(dir, 'never.json'), damaged]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/file 1: the Account Summary counts 7 Withdrawals \/ Debits but 6 rows were read/);
    expectValueFree(result.stderr);
    const explained = await run(['--explain', damaged]);
    expect(explained.status).toBe(0);
    expect(JSON.parse(explained.stdout).files[0].refused).toMatch(/counts 7 Withdrawals/);
  });

  // Review findings on the first head, through the real path: positioned PDF, pdf.js, the CLI. Each must write nothing.
  const edits: Array<[string, (pages: Cell[][]) => void, RegExp]> = [
    ['a malformed daily balance', (pages) => replaceCell(pages, '3,377.79', '3,377.80X'), /Daily Balance Summary line holds something other than dates and balances/],
    ['a summary amount longer than cents', (pages) => replaceCell(pages, '$2,500.00', '$2,500.001'), /Beginning Balance is not one whole amount/],
    ['a summary count printed twice, differently', (pages) => pages[0].push([90, 693, '8 Withdrawals / Debits -2,917.55']), /states two different counts or totals for Withdrawals \/ Debits/],
    ['another bank\'s statement in the same layout', (pages) => replaceCell(pages, 'Fifth Third Bank', 'Contoso Bank', true), /header or footer band names Fifth Third Bank or 53\.com/],
    ['a statement of another bank whose row pays Fifth Third Bank (F16)', (pages) => {
      replaceCell(pages, 'Fifth Third Bank', 'Synthetic Other Bank', true);
      replaceCell(pages, 'Account Type: Fifth Third Momentum Checking', 'Account Type: Synthetic Other Checking');
      replaceCell(pages, 'ATM WITHDRAWAL 0901 SAMPLE ST', 'TRANSFER TO Fifth Third Bank');
    }, /header or footer band names Fifth Third Bank or 53\.com/],
    ['a statement of another bank whose wrapped description ends like a footer (F21)', (pages) => {
      replaceCell(pages, 'Fifth Third Bank', 'Synthetic Other Bank', true);
      replaceCell(pages, 'Account Type: Fifth Third Momentum Checking', 'Account Type: Synthetic Other Checking');
      replaceCell(pages, 'PPD ID: 0000000000', 'TRANSFER TO Fifth Third Bank Page 1 of 2');
    }, /header or footer band names Fifth Third Bank or 53\.com/],
    ['two whole account numbers that share their last four (F22)', (pages) => {
      replaceCell(pages, 'Account Number: XXXXXX4321', 'Account Number: 9990004321', true);
      replaceCell(pages, 'Account Summary - XXXXXX4321', 'Account Summary - 8880004321');
    }, /covers 2 accounts/],
    ['another bank\'s statement with an extra page that names Fifth Third Bank (F26)', (pages) => {
      replaceCell(pages, 'Fifth Third Bank', 'Synthetic Other Bank', true);
      pages.push([[50, 760, 'TRANSFER TO Fifth Third Bank']]);
    }, /header or footer band names Fifth Third Bank or 53\.com/],
    ['another bank\'s statement naming Fifth Third Bank just below its last row (F27)', (pages) => {
      replaceCell(pages, 'Fifth Third Bank', 'Synthetic Other Bank', true);
      pages[0].push([220, 410, 'TRANSFER TO Fifth Third Bank']);
    }, /header or footer band names Fifth Third Bank or 53\.com/],
    ['another bank\'s statement mentioning Fifth Third Bank inside its header band (F28)', (pages) => {
      replaceCell(pages, 'Fifth Third Bank', 'Synthetic Other Bank', true);
      pages[0].push([50, 750, 'TRANSFER TO Fifth Third Bank']);
    }, /header or footer band names Fifth Third Bank or 53\.com/],
    // pdf.js leaves out text wholly outside the page; text crossing its edge comes through, and refuses the statement.
    ['a page with text crossing the left edge of US Letter bounds (Root ruling)', (pages) => pages[1].push([-5, 400, 'SAMPLE']),
      /page 2 holds text outside a US Letter page, so its header and footer bands are unknown/],
    ['an amount the statement states outside its summary, sections and Fee Summary (Root 03:13Z census)',
      (pages) => pages[0].push([300, 750, 'Earn a bonus of $200']), /states a date or an amount outside the statement's summary, sections and Fee Summary/],
    ['a contradictory daily balance on a line ending in "continued" (F18)', (pages) => {
      replaceCell(pages, '3,377.79', '3,377.80');
      replaceCell(pages, '2,532.57', '2,532.57 continued');
    }, /Daily Balance Summary line holds something other than dates and balances/],
    ...['9/30/2026-1', '9/30/2026+1'].map((end): [string, (pages: Cell[][]) => void, RegExp] => [`a period ending '${end}' (F19)`,
      (pages) => replaceCell(pages, 'Statement Period Date: 9/1/2026 - 9/30/2026', `Statement Period Date: 9/1/2026 - ${end}`, true),
      /statement period is not two MM\/DD\/YYYY dates/]),
    ['an account number with something stuck to it, and no --account (F20)',
      (pages) => replaceCell(pages, 'Account Number: XXXXXX4321', 'Account Number: XXXXXX4321-5678X', true), /an account number the statement prints is not one whole number/],
    ['no section counts or totals at all', (pages) => {
      for (const page of pages) {
        for (let i = page.length - 1; i >= 0; i -= 1) {
          if ((page === pages[0] && [672, 658, 644].includes(page[i][1])) || /totaling/.test(page[i][2])) page.splice(i, 1);
        }
      }
    }, /prints no count and total for Checks, so its activity cannot be proven complete/],
  ];
  for (const [name, edit, refusal] of edits) {
    it(`refuses ${name} and writes no payload`, async () => {
      const pages = LAYOUT.pages.map((cells) => cells.map((cell) => [...cell] as Cell));
      edit(pages);
      const file = path.join(dir, 'edited.pdf');
      const out = path.join(dir, 'never.json');
      await writeFile(file, positionedPdf(pages));
      const result = await run(['--institution', 'fifththird', '--label', 'Fifth Third Checking', '--format', 'fifththird-statement', '--out', out, file]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(refusal);
      expectValueFree(result.stderr);
      expect(existsSync(out)).toBe(false);
    });
  }

  // Root 04:10Z (F31, F32), through the real path: every Total row of the Fee Summary is read whole, one amount in each
  // column its heading declares. A declared row never vanishes, and no surviving count stands in for a column.
  const octoberCells = () => OCTOBER.pages.map((cells) => cells.map((cell) => [...cell] as Cell));
  const plainFees = (pages: Cell[][]) => {
    for (const cell of pages[0]) if ([582, 568].includes(cell[1]) && [410, 480].includes(cell[0])) cell[2] = '0.00';
  };
  const ROW_UNREAD = /line \d+: a Fee Summary row is not its Total label and a whole amount in each column its heading declares/;
  const ROW_MISPLACED = /line \d+: a Fee Summary row does not hold exactly one amount under each column its heading declares/;
  const feeEdits: Array<[string, (pages: Cell[][]) => void, RegExp]> = [
    ...([['an unreadable cent', '0.0O'], ['a missing cent', '0.0'], ['a word', 'UNKNOWN_VALUE'], ['no cells', null]] as const)
      .map(([name, to]): [string, (pages: Cell[][]) => void, RegExp] => [`a Fee Summary Total row with ${name} in its columns (F31)`, (pages) => {
        pages[0] = pages[0].flatMap((cell): Cell[] => (cell[1] === 582 && [410, 480].includes(cell[0]) ? (to === null ? [] : [[cell[0], cell[1], to]]) : [cell]));
      }, ROW_UNREAD]),
    ['a Fee Summary with no amount in its Year To Date column (F32)', (pages) => {
      plainFees(pages);
      pages[0] = pages[0].filter((cell) => !(cell[0] === 480 && [582, 568].includes(cell[1])));
    }, ROW_MISPLACED],
    ['a Fee Summary with both amounts of a row under This Period (F32)', (pages) => {
      plainFees(pages);
      for (const cell of pages[0]) if (cell[0] === 480 && [582, 568].includes(cell[1])) cell[0] = 437;
    }, ROW_MISPLACED],
  ];
  for (const [name, edit, refusal] of feeEdits) {
    it(`refuses ${name}, normal and --explain, and writes no payload`, async () => {
      const pages = octoberCells();
      edit(pages);
      const file = path.join(dir, 'fees.pdf');
      const out = path.join(dir, 'never.json');
      await writeFile(file, positionedPdf(pages));
      const result = await run(['--institution', 'fifththird', '--label', 'Fifth Third Checking', '--format', 'fifththird-statement', '--out', out, file]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(refusal);
      expectValueFree(result.stderr);
      expect(existsSync(out)).toBe(false);
      const explained = await run(['--explain', '--format', 'fifththird-statement', file]);
      expect(explained.status).toBe(0);
      expectValueFree(explained.stdout);
      const [explainedFile] = JSON.parse(explained.stdout).files;
      expect(explainedFile.refused).toMatch(refusal);
      const fees = explainedFile.layout.sections['Fee Summary'];
      expect(fees.unread + fees.misplaced).toBeGreaterThan(0);
      expect(fees.skipped).toBe(0);
    });
  }

  it('reads a Fee Summary of plain amounts, and a fee label wrapped onto its own line, through the real path (F31, F32 controls)', async () => {
    const controls: Array<[string, (pages: Cell[][]) => void]> = [
      ['plain', plainFees],
      ['wrapped', (pages) => pages[0].push([280, 561, 'and Unpaid Item Fees'])],
    ];
    for (const [name, edit] of controls) {
      const pages = octoberCells();
      edit(pages);
      const file = path.join(dir, `${name}.pdf`);
      const out = path.join(dir, `${name}.json`);
      await writeFile(file, positionedPdf(pages));
      const result = await run(['--institution', 'fifththird', '--label', 'Fifth Third Checking', '--format', 'fifththird-statement', '--out', out, file]);
      expect(result.stderr, name).toBe('');
      expect(result.status, name).toBe(0);
      expect(JSON.parse(await readFile(out, 'utf8')).segments[0].rows, name).toHaveLength(4);
    }
  });

  // The layouts real statements print (synthetic November to February), and what still refuses beside them, through
  // the real path. Each refusal writes no payload and shows no value.
  const NOTICE = 'ACCOUNT. WE ARE HERE TO HELP YOU 24/7 AT 53.COM OR BY PHONE';
  const BANKS = 'WITH $50B TO $250B IN DEPOSITS. VISIT A BRANCH FOR MORE DETAILS.';
  const UP_TO = 'WILL BE UP TO $25. USE THE FIFTH THIRD MOBILE APP TO SET ALERTS ON YOUR BALANCE AND';
  const CENSUS = /states a date or an amount outside the statement's summary, sections and Fee Summary/;
  const DAILY_FIGURE = /a Daily Balance Summary line holds something other than dates and balances/;
  const laterEdits: Array<[string, { pages: Cell[][] }, (pages: Cell[][]) => void, RegExp]> = [
    ['a bare Deposits / Credits label in a month whose deposit rows are read', NOVEMBER, (pages) => pages[0].push(
      [36, 420, 'Deposits / Credits'], [300, 420, '1 items totaling $5.00'], [36, 406, 'Date'], [141, 406, 'Amount'], [202, 406, 'Description'],
      [36, 392, '11/10'], [150, 392, '5.00'], [204, 392, 'SYNTHETIC CREDIT'],
    ), /prints its Deposits \/ Credits label with no count and no amount, but Deposits \/ Credits rows were read/],
    ['a bare Deposits / Credits label in a month that does not balance without deposits', NOVEMBER,
      (pages) => replaceCell(pages, '$4,160.57', '$4,165.57'), /Beginning Balance \+ deposits - checks - withdrawals is not the Ending Balance/],
    ['a bare Withdrawals / Debits label in the Account Summary', NOVEMBER, (pages) => pages[0].push([84, 641, 'Withdrawals / Debits']),
      /an Account Summary line this reader does not know/],
    ['a Fifth Third savings product title beside a notice', DECEMBER, (pages) => pages[0].push([43, 640, 'Fifth Third Relationship Savings']),
      /names both a checking and a savings account/],
    ['a notice that states a date', DECEMBER, (pages) => replaceCell(pages, NOTICE, 'ACCOUNT. CALL BY 12/31 AT 53.COM'), CENSUS],
    ['a notice whose sentence ends in a whole-dollar figure', DECEMBER, (pages) => replaceCell(pages, NOTICE, 'ACCOUNT. FEES APPLY OF UP TO $5'), CENSUS],
    ['a notice that states an amount with cents', DECEMBER, (pages) => replaceCell(pages, NOTICE, 'ACCOUNT. A $5.00 FEE APPLIES'), CENSUS],
    ['a notice before the Account Summary whose term has cents', JANUARY, (pages) => replaceCell(pages, BANKS, 'WITH $50.00 TO $250B IN DEPOSITS'), CENSUS],
    ['a notice before the Account Summary whose term is set apart from its $', JANUARY, (pages) => replaceCell(pages, BANKS, 'WITH $ 50B TO $250B IN DEPOSITS'), CENSUS],
    ['a notice after the Daily Balance Summary whose term has cents', FEBRUARY,
      (pages) => replaceCell(pages, UP_TO, 'WILL BE UP TO $25.00 USE THE FIFTH THIRD MOBILE APP'), DAILY_FIGURE],
    ['a notice after the Daily Balance Summary whose line ends in a whole-dollar figure', FEBRUARY, (pages) => replaceCell(pages, UP_TO, 'WILL BE UP TO $25'), DAILY_FIGURE],
    // Only in the notice regions (Root 23:46Z): after the Ending Balance, or in a header or footer band, the term is a figure.
    ['a whole-dollar term after the Ending Balance, before the Fee Summary (F226-1)', JANUARY, (pages) => pages[0].push([36, 548, 'Offers up to $25 today']), CENSUS],
    ['a whole-dollar term in the header band (F226-1)', JANUARY, (pages) => pages[0].push([36, 708, 'Offers up to $25 today']), CENSUS],
    ['a whole-dollar term in the footer band (F226-1)', JANUARY, (pages) => pages[0].push([36, 38, 'Offers up to $25 today']), DAILY_FIGURE],
    // A $ with a sign between it and its digits is a figure everywhere (Root 23:46Z census hardening).
    ['a $ with a sign before its digits after the Ending Balance', JANUARY, (pages) => pages[0].push([36, 548, 'ADJUSTMENT $-25 TODAY']), CENSUS],
    ['a $ with a sign before its digits in a notice', JANUARY, (pages) => replaceCell(pages, BANKS, 'WITH $-50B TO $250B IN DEPOSITS'), CENSUS],
    ['a sign set apart after the $ in a notice', FEBRUARY, (pages) => replaceCell(pages, UP_TO, 'A $ +25 FEE APPLIES'), DAILY_FIGURE],
    // A line that starts with a number never gets the exemption, whatever the number (Root 23:53Z).
    ['a notice line starting with a six-digit number', JANUARY, (pages) => replaceCell(pages, BANKS, '100000 BANKS WITH $25 FEES APPLY'), CENSUS],
    ['a notice line starting with a grouped number', FEBRUARY, (pages) => replaceCell(pages, UP_TO, '1,000 BANKS WITH $25 FEES APPLY'), DAILY_FIGURE],
    // Whatever stands before that number, spaced from it or not (review F37, Root 00:10Z).
    ['a notice line starting with a sign set apart from its number', JANUARY, (pages) => replaceCell(pages, BANKS, '- 2 BANKS WITH $25 FEES APPLY'), CENSUS],
    ['a notice line starting with # set apart from its number', FEBRUARY, (pages) => replaceCell(pages, UP_TO, '# 2 BANKS WITH $25 FEES APPLY'), DAILY_FIGURE],
    // Before the Account Summary means before its heading; around the daily balances means on their page (lead re-check).
    ['a whole-dollar term after the Account Summary heading, before its Beginning Balance', JANUARY,
      (pages) => pages[0].push([43, 623, 'EARN A $200 BONUS TODAY']), CENSUS],
    ['a whole-dollar term on a later page without daily balances', JANUARY, (pages) => pages[1].push([43, 600, 'EARN A $200 BONUS TODAY']), DAILY_FIGURE],
  ];
  for (const [name, layout, edit, refusal] of laterEdits) {
    it(`refuses ${name}, normal and --explain, and writes no payload`, async () => {
      const pages = layout.pages.map((cells) => cells.map((cell) => [...cell] as Cell));
      edit(pages);
      const file = path.join(dir, 'later.pdf');
      const out = path.join(dir, 'never.json');
      await writeFile(file, positionedPdf(pages));
      const result = await run(['--institution', 'fifththird', '--label', 'Fifth Third Checking', '--format', 'fifththird-statement', '--out', out, file]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(refusal);
      expectValueFree(result.stderr);
      expect(existsSync(out)).toBe(false);
      const explained = await run(['--explain', '--format', 'fifththird-statement', file]);
      expect(explained.status).toBe(0);
      expectValueFree(explained.stdout);
      expect(JSON.parse(explained.stdout).files[0].refused).toMatch(refusal);
    });
  }

  it('keeps the whole-dollar and split-cents boundaries when a notice line is split into text items, in both notice regions (review F35)', async () => {
    const regions = [{ layout: JANUARY, page: 0, y: 660, text: BANKS }, { layout: FEBRUARY, page: 1, y: 590, text: UP_TO }];
    const variants: Array<[string, Array<[number, string]>, boolean]> = [
      ['whole word', [[103, '$25'], [140, 'APPLIES']], true],
      ['touching dollar and digits', [[103, '$'], [107.5, '25'], [140, 'APPLIES']], true],
      ['dollar apart', [[103, '$'], [119, '25'], [145, 'APPLIES']], false],
      ['touching cents', [[103, '$25'], [116.5, '.00'], [150, 'APPLIES']], false],
      ['split cents', [[103, '$25'], [127, '.'], [140, '0'], [153, '0'], [174, 'APPLIES']], false],
      ['touching signed digits', [[103, '$'], [107.5, '-25'], [145, 'APPLIES']], false],
      ['signed digits apart', [[103, '$'], [119, '-25'], [150, 'APPLIES']], false],
      ['touching scale', [[103, '$25'], [116.5, 'K'], [145, 'APPLIES']], true],
    ];
    let scenario = 0;
    for (const region of regions) {
      for (const [name, pieces, reads] of variants) {
        const pages = region.layout.pages.map((cells) => cells.map((cell) => [...cell] as Cell));
        const page = pages[region.page];
        page.splice(page.findIndex((cell) => cell[2] === region.text), 1,
          ...[[43, 'NOTICE'], [83, 'OF'], ...pieces].map(([x, text]) => [x, region.y, text] as Cell));
        scenario += 1;
        const file = path.join(dir, `split-${scenario}.pdf`);
        const out = path.join(dir, `split-${scenario}.json`);
        await writeFile(file, positionedPdf(pages));
        const label = `${region.y} ${name}`;
        const result = await run(['--institution', 'fifththird', '--label', 'Fifth Third Checking', '--format', 'fifththird-statement', '--out', out, file]);
        expect(result.status, label).toBe(reads ? 0 : 1);
        expect(existsSync(out), label).toBe(reads);
        expectValueFree(result.stdout + result.stderr);
        const [explained] = JSON.parse((await run(['--explain', '--format', 'fifththird-statement', file])).stdout).files;
        expect(Boolean(explained.refused), label).toBe(!reads);
        expect(explained.layout.unreadShapes.length === 0, label).toBe(reads);
      }
    }
  });

  it('never writes a whole account number that any printing shows, statement or CSV, in either order (F24, C16)', async () => {
    const pages = LAYOUT.pages.map((cells) => cells.map((cell) => [...cell] as Cell));
    // A whole number in the first page's header, the masked one after it on the next page.
    replaceCell(pages, 'Account Number: XXXXXX4321', 'Account Number: 9990004321');
    replaceCell(pages, 'AMEX EPAYMENT ACH PMT', 'TRANSFER REF 9990004321');
    const statement = path.join(dir, 'statement.pdf');
    await writeFile(statement, positionedPdf(pages));
    const csvFile = path.join(dir, 'activity.csv');
    await writeFile(csvFile, 'Date,Description,Amount,Account Number\r\n09/15/2026,TRANSFER REF 9990004321,-1.00,XXXXXX4321\r\n'
      + '09/14/2026,INTEREST PAID,0.12,9990004321\r\n');
    for (const [file, extra] of [[statement, []], [csvFile, ['--format', 'fifththird-csv', '--through', '2026-09-15']]] as const) {
      const out = path.join(dir, `${path.basename(file)}.json`);
      const result = await run(['--institution', 'fifththird', '--label', 'Fifth Third Checking', ...extra, '--out', out, file]);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const written = await readFile(out, 'utf8');
      expect(written).not.toContain('9990004321');
      expect(written).toContain('TRANSFER REF ***4321');
      expectValueFree(result.stdout);
    }
  });

  it('masks what agreeing printings prove only together, statement or CSV (V07, V08)', async () => {
    const pages = LAYOUT.pages.map((cells) => cells.map((cell) => [...cell] as Cell));
    replaceCell(pages, 'Account Number: XXXXXX4321', 'Account Number: 12X45678', true);
    replaceCell(pages, 'Account Summary - XXXXXX4321', 'Account Summary - XX345678');
    replaceCell(pages, 'AMEX EPAYMENT ACH PMT', 'TRANSFER REF 12345');
    const statement = path.join(dir, 'statement.pdf');
    await writeFile(statement, positionedPdf(pages));
    const csvFile = path.join(dir, 'activity.csv');
    await writeFile(csvFile, 'Date,Description,Amount,Account Number\r\n09/15/2026,TRANSFER REF 00043,-1.00,999X004321\r\n'
      + '09/14/2026,INTEREST PAID,0.12,XXX0004321\r\n');
    for (const [file, extra, known] of [[statement, [], '12345'], [csvFile, ['--format', 'fifththird-csv', '--through', '2026-09-15'], '00043']] as const) {
      const out = path.join(dir, `${path.basename(file)}.json`);
      const result = await run(['--institution', 'fifththird', '--label', 'Fifth Third Checking', ...extra, '--out', out, file]);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const payload = JSON.parse(await readFile(out, 'utf8')) as { segments: Array<{ rows: Array<{ description: string; checkNumber: string | null }> }> };
      for (const row of payload.segments.flatMap((segment) => segment.rows)) {
        for (const text of [row.description, row.checkNumber ?? '']) expect(text.replace(/[^0-9]/g, '')).not.toContain(known);
      }
    }
  });

  it('carries each file\'s known account identity on every refusal, so no message shows its digits (V09, V10, Root 03:37Z)', async () => {
    const statement = async (name: string, account: string, title: string, edit: (pages: Cell[][]) => void = () => {}) => {
      const pages = LAYOUT.pages.map((cells) => cells.map((cell) => [...cell] as Cell));
      replaceCell(pages, 'Account Number: XXXXXX4321', `Account Number: ${account}`, true);
      replaceCell(pages, 'Account Summary - XXXXXX4321', `Account Summary - ${title}`);
      edit(pages);
      const file = path.join(dir, name);
      await writeFile(file, positionedPdf(pages));
      return file;
    };
    // A refusal that states 10000 (a count), beside a file whose whole account number starts 10000.
    const counted = await statement('counted.pdf', 'XXXXXX4321', 'XXXXXX4321', (pages) => replaceCell(pages, '1', '10000'));
    const outOfBounds = await statement('bounds.pdf', '1000034321', '1000034321', (pages) => pages[1].push([-0.25, 400, 'SAMPLE']));
    const inBounds = await statement('control.pdf', '1000034321', '1000034321');
    const partial = await statement('partial.pdf', '100X034321', 'XXX0034321', (pages) => replaceCell(pages, '1', '10000'));
    const conflict = path.join(dir, 'conflict.csv');
    await writeFile(conflict, 'Date,Description,Amount,Debit/Credit,Account Number\r\n09/03/2026,A,1.00,Debit,100X034321\r\n09/02/2026,B,-2.00,Debit,XXX0034321\r\n');
    const agreeing = path.join(dir, 'agreeing.csv');
    await writeFile(agreeing, 'Date,Description,Amount,Debit/Credit,Account Number\r\n09/03/2026,A,-1.00,Debit,100X034321\r\n09/02/2026,B,-2.00,Debit,XXX0034321\r\n');
    const tall = path.join(dir, 'tall.csv');
    await writeFile(tall, `Date,Description,Amount,Account Number\r\n09/02/2026,"S${'\n'.repeat(9997)}",-1.00,XXXXXX4321\r\n09/01/2026,SYNTHETIC,PRIVATE_PAYEE_ZEBRA,XXXXXX4321\r\n`);
    const pdfArgs = ['--institution', 'fifththird', '--label', 'Fifth Third Checking'];
    const csvArgs = [...pdfArgs, '--format', 'fifththird-csv', '--through', '2026-09-30'];
    for (const [args, files] of [[pdfArgs, [outOfBounds, counted]], [pdfArgs, [inBounds, counted]], [pdfArgs, [partial]],
      [csvArgs, [conflict, tall]], [csvArgs, [agreeing, tall]]] as const) {
      const normal = await run([...args, '--out', path.join(dir, 'never.json'), ...files]);
      expect(normal.status, files.join(' ')).toBe(1);
      expect(normal.stderr, files.join(' ')).not.toContain('10000');
      const explainArgs = args.includes('--format') ? ['--explain', '--format', 'fifththird-csv'] : ['--explain'];
      const explained = await run([...explainArgs, ...files]);
      expect(explained.status).toBe(0);
      expect(explained.stderr).not.toContain('10000');
      // Every text field is guarded; an integer such as a problem's line number is a structural count, exempt.
      const texts = (value: unknown): string[] => (typeof value === 'string' ? [value]
        : Array.isArray(value) ? value.flatMap(texts)
          : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, entry]) => [key, ...texts(entry)]) : []);
      expect(texts(JSON.parse(explained.stdout)).filter((text) => text.includes('10000')), files.join(' ')).toEqual([]);
    }
    expect(existsSync(path.join(dir, 'never.json'))).toBe(false);
  });

  it('masks another file\'s known account in a refusal of a file with no account identity, normal and --explain, both orders (Root 04:04Z)', async () => {
    const statement = async (name: string, edit: (pages: Cell[][]) => void) => {
      const pages = LAYOUT.pages.map((cells) => cells.map((cell) => [...cell] as Cell));
      edit(pages);
      const file = path.join(dir, name);
      await writeFile(file, positionedPdf(pages));
      return file;
    };
    // A statement whose whole account number starts 10000, which reads.
    const known = await statement('known.pdf', (pages) => {
      replaceCell(pages, 'Account Number: XXXXXX4321', 'Account Number: 1000034321', true);
      replaceCell(pages, 'Account Summary - XXXXXX4321', 'Account Summary - 1000034321');
    });
    // A statement that prints no account number at all, refused after its identity step for a count of 10000 checks.
    const none = await statement('none.pdf', (pages) => {
      for (const page of pages) for (let i = page.length - 1; i >= 0; i -= 1) if (/^Account (?:Number|Summary)/.test(page[i][2])) page.splice(i, 1);
      replaceCell(pages, '1 checks totaling $250.00', '10000 checks totaling $250.00');
    });
    // Fifth Third's own CSV export (no account column), whose unreadable row is on line 10000.
    const noneCsv = path.join(dir, 'none.csv');
    await writeFile(noneCsv, `Date,Description,Check Number,Amount\r\n09/02/2026,"S${'\n'.repeat(9997)}",,-1.00\r\n09/01/2026,"SYNTHETIC",,PRIVATE_PAYEE_ZEBRA\r\n`);
    const args = ['--institution', 'fifththird', '--label', 'Fifth Third Checking', '--through', '2026-09-30'];
    const texts = (value: unknown): string[] => (typeof value === 'string' ? [value]
      : Array.isArray(value) ? value.flatMap(texts)
        : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, entry]) => [key, ...texts(entry)]) : []);
    for (const [files, refusal] of [
      [[known, none], /counts \S+ Checks but 1 rows were read/], [[none, known], /counts \S+ Checks but 1 rows were read/],
      [[known, noneCsv], /line \S+: Amount is not a number/], [[noneCsv, known], /line \S+: Amount is not a number/],
    ] as const) {
      const normal = await run([...args, '--out', path.join(dir, 'never.json'), ...files]);
      expect(normal.status).toBe(1);
      expect(normal.stderr).toMatch(refusal);
      expect(normal.stderr).not.toContain('10000');
      const explained = await run(['--explain', ...files]);
      expect(explained.status).toBe(0);
      expect(explained.stderr).not.toContain('10000');
      expect(texts(JSON.parse(explained.stdout)).filter((text) => text.includes('10000'))).toEqual([]);
    }
    expect(existsSync(path.join(dir, 'never.json'))).toBe(false);
    // Control: with no account known in the run, the refusal states its structural count as it is (Root 04:04Z).
    const alone = await run([...args, '--out', path.join(dir, 'never.json'), none]);
    expect(alone.stderr).toMatch(/counts 10000 Checks but 1 rows were read/);
    const aloneCsv = await run([...args, '--account', '4321', '--out', path.join(dir, 'never.json'), noneCsv]);
    expect(aloneCsv.stderr).toMatch(/line 10000: Amount is not a number/);
  });

  it('prints the whole run with fixed labels when a statement prints an account number that is not one whole number (Root 04:04Z, 04:08Z)', async () => {
    const stuck = LAYOUT.pages.map((cells) => cells.map((cell) => [...cell] as Cell));
    replaceCell(stuck, 'Account Number: XXXXXX4321', 'Account Number: XXXXXX4321-5678X', true);
    const stuckFile = path.join(dir, 'stuck.pdf');
    await writeFile(stuckFile, positionedPdf(stuck));
    // A statement refused after its identity step, whose message states structural counts.
    const countedFile = path.join(dir, 'counted.pdf');
    await writeFile(countedFile, positionedPdf(LAYOUT.pages.map((cells) => cells.filter((cell) => cell[1] !== 460 || cells !== LAYOUT.pages[0]))));
    const args = ['--institution', 'fifththird', '--label', 'Fifth Third Checking', '--format', 'fifththird-statement'];
    const labels = /holdr-checking-convert:|[0-9]+ files were refused:|file [0-9]+:?/g;
    for (const files of [[stuckFile, countedFile], [countedFile, stuckFile]]) {
      const normal = await run([...args, '--out', path.join(dir, 'never.json'), ...files]);
      expect(normal.status).toBe(1);
      expect(normal.stderr).toMatch(/an account number the statement prints is not one whole number/);
      expect(normal.stderr).toMatch(/the Account Summary counts # Withdrawals \/ Debits but # rows were read/);
      expect(normal.stderr.replace(labels, '')).not.toMatch(/[0-9]/);
      const explained = await run(['--explain', '--format', 'fifththird-statement', ...files]);
      expect(explained.status).toBe(0);
      const refused = (JSON.parse(explained.stdout).files as Array<{ refused?: string }>).map((file) => file.refused);
      expect(refused).toHaveLength(2);
      for (const text of refused) expect(text).toMatch(/^[^0-9]+$/);
    }
    // Control: alone, the statement refused after its identity step states its counts as they are.
    const alone = await run([...args, '--out', path.join(dir, 'never.json'), countedFile]);
    expect(alone.stderr).toMatch(/counts 7 Withdrawals \/ Debits but 6 rows were read/);
    expect(existsSync(path.join(dir, 'never.json'))).toBe(false);
  });

  it('declines to guess the bank of a CSV whose header is not a known Fifth Third layout, and converts it when told, printing no cell', async () => {
    const input = path.join(dir, 'other-header.csv');
    await writeFile(input, 'Date,Description,Amount,Account Number,Unused\r\n09/01/2026,PRIVATE_PAYEE_ZEBRA,-987.65,9990004321,PRIVATE_PAYEE_ZEBRA\r\n');
    const common = ['--institution', 'fifththird', '--label', 'Fifth Third Checking', '--through', '2026-09-30'];
    const guessed = await run([...common, '--dry-run', input]);
    expect(guessed.status).toBe(1);
    expect(guessed.stderr).toMatch(/file 1: is not a format this tool recognizes; pass --format/);
    const told = await run([...common, '--format', 'fifththird-csv', '--out', path.join(dir, 'told.json'), input]);
    expect(told.status).toBe(0);
    const explained = await run(['--explain', '--format', 'fifththird-csv', input]);
    expect(explained.status).toBe(0);
    for (const output of [guessed.stdout + guessed.stderr, told.stdout + told.stderr, explained.stdout + explained.stderr]) {
      expect(output).not.toMatch(/PRIVATE_PAYEE_ZEBRA|9990004321|987\.65/);
    }
    expect(JSON.parse(explained.stdout).files[0].layout).toMatchObject({ headerRead: true, knownLayout: false, columns: ['Date', 'Description', 'Amount', 'Account Number', null] });
  });

  it('never echoes a whole account number given as --account', async () => {
    const result = await run(['--institution', 'fifththird', '--label', 'Fifth Third Checking', '--account', '9990004321', '--through', '2026-09-30',
      '--out', path.join(dir, 'never.json'), fixturePath('activity.csv')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('9990004321');
    const explained = await run(['--explain', '--account', '9990004321', statementPath('2026-09')]);
    expect(explained.status).toBe(64);
    expect(explained.stdout + explained.stderr).not.toContain('9990004321');
    expect(explained.stderr).toMatch(/--account must be the last four digits of the account number/);
    // The adapters refuse it as well, before reading anything, when called without the CLI.
    expect(() => fifthThirdStatementAdapter.parse({ kind: 'pdf', pages: [] }, { accountLast4: '9990004321' }))
      .toThrow(/^--account must be the last four digits of the account number$/);
  });
});
