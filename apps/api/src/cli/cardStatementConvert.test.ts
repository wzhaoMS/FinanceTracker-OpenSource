/**
 * Discover statements through the owner's offline converter, end to end: synthetic statement PDFs (Helvetica, set where
 * the three layouts print their text) read by pdf.js, converted as a dry run and into payloads. Synthetic fixtures only.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

import { validateCardImportPayload } from '@finance-tracker/shared';
import { parseDiscoverStatement } from '@finance-tracker/shared/card-import-tool';
import {
  layoutA,
  layoutB,
  layoutC,
  pagesOf,
  SYNTHETIC_LAST4,
  SYNTHETIC_SENSITIVE,
  type Cell,
  type SyntheticStatement,
} from '@finance-tracker/shared/card-statement-fixtures';

import { exceptCardSpendingPaths, mountCardSpendingRoutes } from '../routes/cardSpending.js';
import { readCardSpendingCoverage } from '../routes/cardSpendingOverview.js';
import { createResourceRouter } from '../routes/resources.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { listenLoopback } from '../testing/loopback.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { positionedPdf } from '../testing/syntheticPdf.js';
import { runCardStatementConvertCli } from './cardStatementConvert.js';
import { pdfTextPages } from './checkingPdfText.js';

const DECEMBER: SyntheticStatement = {
  open: '2019-12-12', close: '2020-01-11', previousMinor: 2500,
  credits: [{ date: 'Dec 20', description: 'INTERNET PAYMENT - THANK YOU', minor: 2500 }],
  purchases: [{ date: 'Dec 28', posted: 'Dec 30', description: 'SAMPLE BOOKS #12', wrap: ['800-555-0100 WA'], category: 'Merchandise', minor: 1734 }],
};
const JANUARY: SyntheticStatement = {
  open: '2020-01-12', close: '2020-02-11', previousMinor: 1734,
  credits: [{ date: '01/20', description: 'DIRECTPAY FULL BALANCE', wrap: ['SEE DETAILS OF YOUR NEXT DIRECTPAY BELOW'], minor: 1734 }],
  purchases: [
    { date: '01/02', description: 'CONTOSO COFFEE', category: 'Restaurants', minor: 1250 },
    { date: '01/15', description: 'FABRIKAM MARKET #123', wrap: ['SEATTLE WA'], category: 'Supermarkets', minor: 2300 },
  ],
};
const FEBRUARY: SyntheticStatement = { open: '2020-02-12', close: '2020-03-11', previousMinor: 3550, credits: [{ date: '02/20', description: 'DIRECTPAY FULL BALANCE', minor: 3550 }] };
const LAYOUTS: Array<[string, Cell[][]]> = [
  ['2019-12', layoutA(DECEMBER)], ['2020-01', layoutB(JANUARY)], ['2020-02', layoutB(FEBRUARY)],
  ['2026-07', layoutC({ open: '2026-05-25', close: '2026-06-27', previousMinor: 0 })],
];
const VALUES = ['CONTOSO', 'FABRIKAM', 'SAMPLE BOOKS', 'SEATTLE', 'DIRECTPAY', 'INTERNET PAYMENT', '17.34', '12.50', '23.00', '35.50', '25.00', '1734', '3550',
  ...SYNTHETIC_SENSITIVE];

function run(argv: string[]) {
  const out = { stdout: '', stderr: '' };
  const io = { stdout: { write: (text: string) => (out.stdout += text) }, stderr: { write: (text: string) => (out.stderr += text) } };
  return runCardStatementConvertCli(argv, io).then((status) => ({ status, ...out }));
}

function expectValueFree(text: string) {
  for (const value of VALUES) expect(text, `shows ${value}`).not.toContain(value);
}

describe('Discover statement PDFs through the converter CLI', () => {
  let dir: string;
  let files: string[];
  beforeEach(async () => {
    dir = await makeScratchDir('discover-');
    files = LAYOUTS.map(([month, pages]) => {
      const file = path.join(dir, `statement-${month}.pdf`);
      writeFileSync(file, positionedPdf(pages));
      return file;
    });
  });
  afterEach(async () => {
    await removeScratchDir(dir);
  });

  it('reads each layout through pdf.js exactly as from its cells', async () => {
    for (const [, pages] of LAYOUTS) {
      const fromPdf = parseDiscoverStatement(await pdfTextPages(new Uint8Array(positionedPdf(pages))));
      const fromCells = parseDiscoverStatement(pagesOf(pages));
      expect({ ...fromPdf, rows: fromPdf.rows.map(({ sourceTexts: _, ...row }) => row) })
        .toEqual({ ...fromCells, rows: fromCells.rows.map(({ sourceTexts: _, ...row }) => row) });
    }
  });

  it('converts as a dry run: a value-free report, nothing written; a gap holds the statement after it until accepted', async () => {
    const held = await run(['--card', SYNTHETIC_LAST4, '--dry-run', ...files]);
    expect(held.status).toBe(1);
    expect(held.stderr).toBe('holdr-card-statement-convert: 1 of 4 statements were held (see the report; --skip-held writes the others, '
      + '--accept-gaps accepts the 1 gap before them as missing history)\n');
    expect(JSON.parse(held.stdout).statements).toMatchObject({ accepted: 3, held: 1, heldByReason: { 'unproven-gap': 1 } });
    const result = await run(['--card', SYNTHETIC_LAST4, '--dry-run', '--accept-gaps', ...files]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expectValueFree(result.stdout);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      code: 'card-statements-dry-run', parser: 'holdr-discover-statement@1.0.0', issuer: 'discover', card: SYNTHETIC_LAST4,
      statements: { read: 4, accepted: 4, held: 0, heldByReason: {}, reconciled: 4 },
      layouts: { A: 1, B: 2, C: 1 },
      periods: { first: '2019-12-12', last: '2026-06-27' },
      rows: { total: 6, byKind: { purchase: 3, payment: 3, refund: 0, fee: 0, interest: 0, adjustment: 0, other: 0 } },
      noActivityStatements: 1,
      continuity: { adjacent: 2, gaps: [{ after: '2020-03-11', before: '2026-05-25', days: 2265, balanceCarried: true, proven: false, accepted: true }] },
    });
    expect(report.payloads.map((entry: { name: string; rows: number }) => [entry.name, entry.rows])).toEqual([['file 1', 2], ['file 2', 3], ['file 3', 1], ['file 4', 0]]);
    expect(readdirSync(dir).sort()).toEqual(files.map((file) => path.basename(file)).sort());
  });

  it('writes one payload per statement into a new owner-only directory, never over anything', async () => {
    const out = path.join(dir, 'payloads');
    const result = await run(['--card', SYNTHETIC_LAST4, '--out-dir', out, '--accept-gaps', ...files]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expectValueFree(result.stdout);
    const report = JSON.parse(result.stdout);
    expect(report.code).toBe('card-statements-converted');
    const names = ['discover-1117-2020-01-11.json', 'discover-1117-2020-02-11.json', 'discover-1117-2020-03-11.json', 'discover-1117-2026-06-27.json'];
    expect(readdirSync(out).sort()).toEqual(names);
    for (const [index, name] of names.entries()) {
      const text = readFileSync(path.join(out, name), 'utf8');
      expect(validateCardImportPayload(JSON.parse(text)).ok).toBe(true);
      expect(report.payloads[index]).toMatchObject({ file: name, sha256: createHash('sha256').update(text).digest('hex') });
      for (const value of SYNTHETIC_SENSITIVE) expect(text).not.toContain(value);
      if (process.platform !== 'win32') expect(statSync(path.join(out, name)).mode & 0o777).toBe(0o600);
    }
    if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o700);
    const again = await run(['--card', SYNTHETIC_LAST4, '--out-dir', out, ...files]);
    expect([again.status, again.stderr]).toEqual([64, 'holdr-card-statement-convert: --out-dir already exists; name a new directory\n']);
  });

  it('writes payloads the existing import path takes as they are: each previews as a matching statement, commits, and adds nothing again', async () => {
    const out = path.join(dir, 'payloads');
    const converted = await run(['--card', SYNTHETIC_LAST4, '--out-dir', out, '--accept-gaps', ...files]);
    expect(converted.status).toBe(0);
    const stated = JSON.parse(converted.stdout).coverage;
    expect(stated).toEqual({
      ranges: [{ start: '2019-12-12', end: '2020-03-11' }, { start: '2026-05-25', end: '2026-06-27' }],
      uncovered: [{ from: '2020-03-12', to: '2026-05-24', days: 2265 }],
    });
    const repo = new SqliteStateRepo({ file: ':memory:' });
    try {
      const server = express();
      server.use(exceptCardSpendingPaths(express.json({ limit: '2mb' })));
      server.use(createResourceRouter(repo));
      mountCardSpendingRoutes(server, { repo, requireAuth: (_req, _res, next) => next(), log: () => undefined });
      const account = repo.createCardAccount({ issuer: 'discover', owner: 'alex', last4: SYNTHETIC_LAST4, currency: 'USD', nickname: 'Discover it' });
      const agent = request(await listenLoopback(server));
      const post = (route: string, body: string) => agent.post(`${route}?cardAccountId=${account.id}`).set('Content-Type', 'application/json').send(body);
      const rows: number[] = [];
      for (const name of readdirSync(out).sort()) {
        const body = readFileSync(path.join(out, name), 'utf8');
        const preview = await post('/card-imports/preview', body);
        expect(preview.status, preview.text).toBe(200);
        expect(preview.body.reconciliation.status, name).toBe('match');
        const commit = await post('/card-imports/commit', body);
        expect(commit.status, commit.text).toBe(201);
        expect(commit.body.imported).toBe(true);
        rows.push(commit.body.newCount);
        expect((await post('/card-imports/commit', body)).body).toMatchObject({ imported: false, newCount: 0 });
      }
      // Every statement's rows, the quiet ones recording their dates only.
      expect(rows).toEqual([2, 3, 1, 0]);
      expect(repo.listCardTransactions({ cardAccountId: account.id })).toHaveLength(6);
      // Holdr records each statement's coverage apart and joins only ranges that touch: what the report stated, the gap
      // left uncovered. Its months are unknown, never complete (so never shown as months without spending).
      expect(repo.listCardCoverage().find((entry) => entry.cardAccountId === account.id)!.ranges).toEqual(stated.ranges);
      const months = new Map(readCardSpendingCoverage(repo, { cardAccountId: account.id }, { today: '2026-10-24', from: '2020-01', to: '2026-06' })
        .map(({ month, ...known }) => [month, known]));
      for (const month of ['2020-01', '2020-02']) expect(months.get(month), month).toMatchObject({ complete: true, cardsCovered: 1 });
      for (const month of ['2020-03', '2020-04', '2023-06', '2026-04', '2026-05', '2026-06']) {
        expect(months.get(month), month).toMatchObject({ complete: false, cardsCovered: 0, uncoveredCardIds: [account.id] });
      }
    } finally {
      repo.close();
    }
  });

  it('holds what it cannot prove, and then writes nothing unless told to skip the held statements', async () => {
    const other = path.join(dir, 'other.pdf');
    writeFileSync(other, positionedPdf(layoutB({ ...FEBRUARY, last4: '4242' })));
    const text = path.join(dir, 'notes.txt');
    writeFileSync(text, 'not a statement');
    const dry = await run(['--card', SYNTHETIC_LAST4, '--dry-run', '--accept-gaps', ...files, other, text]);
    expect(dry.status).toBe(1);
    expect(dry.stderr).toBe('holdr-card-statement-convert: 2 of 6 statements were held (see the report; --skip-held writes the others)\n');
    expectValueFree(dry.stdout);
    const report = JSON.parse(dry.stdout);
    expect(report.statements).toMatchObject({ read: 6, accepted: 4, held: 2, heldByReason: { 'other-card': 1, 'not-a-statement': 1 } });
    expect(report.files.slice(4).map((entry: { reason: string; message: string }) => [entry.reason, entry.message])).toEqual([
      ['other-card', `the statement is for the card ending 4242, not ${SYNTHETIC_LAST4}`], ['not-a-statement', 'is not a PDF'],
    ]);
    const out = path.join(dir, 'payloads');
    const refused = await run(['--card', SYNTHETIC_LAST4, '--out-dir', out, '--accept-gaps', ...files, other, text]);
    expect([refused.status, JSON.parse(refused.stdout).code, existsSync(out)]).toEqual([1, 'card-statements-held', false]);
    expect(refused.stderr).toMatch(/2 of 6 statements were held, so nothing was written/);
    const skipped = await run(['--card', SYNTHETIC_LAST4, '--out-dir', out, '--accept-gaps', '--skip-held', ...files, other, text]);
    expect([skipped.status, skipped.stderr, readdirSync(out).length]).toEqual([0, '', 4]);
  });

  it('refuses, through pdf.js, every unread figure, repeated row and conflicting identity the review found (F255-1, -4, -5)', async () => {
    const one: SyntheticStatement = {
      open: '2021-01-01', close: '2021-01-31', previousMinor: 0,
      purchases: [{ date: '01/15', description: 'CONTOSO COFFEE', category: 'Restaurants', minor: 1250 }],
    };
    const under = (cells: Cell[][], x: number | null, text: string) => {
      const page = cells.find((cellsOfPage) => cellsOfPage.some((cell) => cell[2] === 'CONTOSO COFFEE'))!;
      const row = page.find((cell) => cell[2] === 'CONTOSO COFFEE')!;
      page.push([x ?? row[0], row[1] - 5, text]);
      return cells;
    };
    const cases: Array<[string, Cell[][]]> = [
      ['wrapped amount', under(layoutB(one), 80, 'UNREAD ADJUSTMENT $999.99')],
      ['wrapped date and amount', under(layoutB(one), 80, '01/20 UNREAD ADJUSTMENT $999.99')],
      ['category amount', under(layoutB(one), 256.5, 'UNREAD ADJUSTMENT $999.99')],
      ['layout A wrapped amount', under(layoutA({ ...one, purchases: [{ ...one.purchases![0], date: 'Jan 15' }] }), null, 'UNREAD ADJUSTMENT $999.99')],
      ['row beside the Cashback Bonus box', ((cells) => (cells[2].push([430, 620, '01/20'], [460, 620, 'UNREAD ROW'], [555, 620, '$999.99']), cells))(layoutB(one))],
      ['summary figure after New Balance', ((cells) => (cells[0].push([38, 565, 'Purchases'], [230, 565, '+$999.99']), cells))(layoutB(one))],
      ['the same row twice', layoutB({ ...one, purchases: [one.purchases![0], one.purchases![0]] })],
      ['two card endings on one line', ((cells) => (cells[1].push([18, 600, `Account number ending in ${SYNTHETIC_LAST4} Account number ending in 4242`]), cells))(layoutB(one))],
      ['a New Balance under its label that is not the summary\'s', ((cells) => ((cells[0].find((cell) => cell[0] === 311.3 && cell[1] === 646.8)![2] = '99.99'), cells))(layoutB(one))],
      ['an amount in a row\'s description', layoutB({ ...one, purchases: [{ ...one.purchases![0], description: 'CONTOSO COFFEE $999.99' }] })],
      ['two periods on one line', ((cells) => (cells[1].push([18, 600, 'OPEN TO CLOSE DATE: 01/01/2021 - 01/31/2021 OPEN TO CLOSE DATE: 02/01/2021 - 02/28/2021']), cells))(layoutB(one))],
      ['a New Balance printed again with the other sign', ((cells) => (cells[0].push([38, 565, 'New Balance'], [230, 565, '-$12.50']), cells))(layoutB(one))],
      ['a summary label and another amount in one text item', ((cells) => (cells[0].push([38, 565, 'Purchases +$999.99']), cells))(layoutB(one))],
      ['a summary label touching another amount', ((cells) => (cells[0].push([38, 565, 'Purchases+$999.99']), cells))(layoutB(one))],
    ];
    for (const [name, cells] of cases) {
      const input = path.join(dir, 'case.pdf');
      writeFileSync(input, positionedPdf(cells));
      const result = await run(['--card', SYNTHETIC_LAST4, '--dry-run', '--accept-gaps', input]);
      expect(result.status, name).toBe(1);
      expectValueFree(result.stdout);
      expect(JSON.parse(result.stdout).statements, name).toMatchObject({ read: 1, accepted: 0, held: 1 });
    }
  });

  it('refuses usage it cannot follow, never echoing a card number', async () => {
    for (const argv of [
      ['--dry-run', ...files],
      ['--card', '6011111111111117', '--dry-run', ...files],
      ['--card', SYNTHETIC_LAST4, ...files],
      ['--card', SYNTHETIC_LAST4, '--dry-run', '--out-dir', path.join(dir, 'x'), ...files],
      ['--card', SYNTHETIC_LAST4, '--dry-run'],
      ['--card', SYNTHETIC_LAST4, '--dry-run', '--colour', ...files],
      ['--card', SYNTHETIC_LAST4, '--out-dir', files[0], ...files],
    ]) {
      const result = await run(argv);
      expect(result.status, argv.join(' ')).toBe(64);
      expect(result.stdout).toBe('');
      expectValueFree(result.stderr);
    }
    expect((await run(['--help'])).stdout).toContain('Usage: holdr-card-statement-convert');
    expect((await run(['--version'])).stdout).toBe('holdr-discover-statement@1.0.0\n');
  });
});
