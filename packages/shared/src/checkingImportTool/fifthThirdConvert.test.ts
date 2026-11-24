/**
 * Fifth Third end to end: every 53 format through the generic converter into one `holdr.checking-import` payload.
 * Exact amounts, keys that survive re-downloads and format changes, balances that prove the days complete, and
 * refusals that name what failed, never a value. Synthetic fixtures only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checkingDayKeys, checkingImportDays, validateCheckingImportPayload, type CheckingImportPayload } from '../checkingImport.js';
import { checkingExportAdapter, detectCheckingExportAdapters } from './adapters.js';
import { CheckingConvertError, convertCheckingExports, type CheckingConvertInput, type CheckingConvertOptions } from './convert.js';
import type { CheckingExportInput, CheckingPdfPage } from './parsed.js';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/fifththird/${name}`, import.meta.url)), 'utf8');
const LAYOUT = JSON.parse(fixture('statement-2026-09.layout.json')) as { pages: Array<Array<[number, number, string]>> };
const STATEMENT: CheckingPdfPage[] = LAYOUT.pages.map((cells) => ({ items: cells.map(([x, y, text]) => ({ text, x, y, width: text.length * 4.5 })) }));
const OPTIONS: CheckingConvertOptions = { institution: 'fifththird', label: 'Fifth Third Momentum Checking' };

function input(name: string, value: CheckingExportInput, options: { accountLast4?: string } = {}): CheckingConvertInput {
  const adapters = detectCheckingExportAdapters(value);
  assert.equal(adapters.length, 1, `${name} is recognized by exactly one format`);
  return { name, parsed: adapters[0].parse(value, options) };
}
const text = (name: string, body = fixture(name)) => input(name, { kind: 'text', text: body });
const pdf = (pages: CheckingPdfPage[] = STATEMENT) => input('statement', { kind: 'pdf', pages });
/** The month with a running Balance column: not a layout Fifth Third's export uses, so read only with the format given. */
const balanced = (body = fixture('activity-balance.csv')): CheckingConvertInput => {
  assert.deepEqual(detectCheckingExportAdapters({ kind: 'text', text: body }), []);
  return { name: 'activity-balance.csv', parsed: checkingExportAdapter('fifththird-csv')!.parse({ kind: 'text', text: body }, {}) };
};

/** Every row's content key, per segment: what the import dedupes on. */
function keys(payload: CheckingImportPayload): string[][] {
  return payload.segments.map((segment) => {
    const dates = [...new Set(segment.rows.map((row) => row.postedDate))];
    return dates.flatMap((date) => checkingDayKeys(segment.rows.filter((row) => row.postedDate === date)));
  });
}

const VALUES = ['CONTOSO', 'GROCERY', 'CHASE', 'AMEX', '1234.56', '1,234.56', '2532.57', '2,532.57', '9990004321', 'S20260901A0001', '42.17'];
function refused(run: () => unknown, pattern: RegExp): void {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof CheckingConvertError, String(error));
    assert.match(error.message, pattern);
    for (const value of VALUES) assert.ok(!error.message.includes(value), `shows ${value}: ${error.message}`);
    return;
  }
  assert.fail('expected the conversion to be refused');
}

describe('Fifth Third through the converter', () => {
  it('converts Fifth Third\'s own CSV export, which states no balance: its days are proven by a QFX or a statement', () => {
    const alone = convertCheckingExports([text('activity.csv')], { ...OPTIONS, through: '2026-09-30', accountLast4: '4321' });
    assert.ok(validateCheckingImportPayload(alone.payload).ok);
    const [segment] = alone.payload.segments;
    assert.equal(segment.source, 'fifththird-csv');
    assert.deepEqual(segment.coverage, { start: '2026-09-01', end: '2026-09-30' });
    assert.deepEqual(segment.rows.map((row) => row.amountMinor), [320000, -10000, -123456, -98765, -25000, -4217, -4217, -50000, 12, -1100]);
    assert.deepEqual(segment.anchors, []);
    assert.deepEqual(alone.report.files[0].checks, []);
    // With the QFX of the same days, the bank's ledger balance and the rows' agreement prove them.
    const { payload, report } = convertCheckingExports([text('activity.csv'), text('activity.qfx')], { ...OPTIONS, through: '2026-09-30' });
    assert.deepEqual(checkingImportDays(payload.segments).disagreements, []);
    assert.deepEqual(report.files.map((file) => file.checks), [[], ['ledger-balance']]);
    assert.deepEqual(keys(payload)[0].sort(), keys(alone.payload)[0].sort());
  });

  it('converts a CSV with a running balance, with the balance as anchors', () => {
    const { payload, report } = convertCheckingExports([balanced()], { ...OPTIONS, through: '2026-09-30', accountLast4: '4321' });
    assert.ok(validateCheckingImportPayload(payload).ok);
    assert.deepEqual(payload.account, { institution: 'fifththird', type: 'checking', last4: '4321', label: 'Fifth Third Momentum Checking', currency: 'USD' });
    const [segment] = payload.segments;
    assert.equal(segment.source, 'fifththird-csv');
    assert.deepEqual(segment.coverage, { start: '2026-09-01', end: '2026-09-30' });
    assert.deepEqual(segment.rows.map((row) => row.amountMinor), [320000, -10000, -123456, -98765, -25000, -4217, -4217, -50000, 12, -1100]);
    assert.deepEqual(segment.anchors, [
      { date: '2026-08-31', balanceMinor: 250000, kind: 'opening' },
      { date: '2026-09-01', balanceMinor: 560000, kind: 'daily' },
      { date: '2026-09-02', balanceMinor: 337779, kind: 'daily' },
      { date: '2026-09-03', balanceMinor: 304345, kind: 'daily' },
      { date: '2026-09-08', balanceMinor: 254345, kind: 'daily' },
      { date: '2026-09-15', balanceMinor: 254357, kind: 'daily' },
      { date: '2026-09-30', balanceMinor: 253257, kind: 'daily' },
    ]);
    assert.deepEqual(report.files[0].checks, ['running-balances']);
    assert.equal(segment.rows.find((row) => row.checkNumber === '1042')?.amountMinor, -25000);
  });

  it('converts the QFX, QBO and OFX with the ledger balance, and the statement with its own balances', () => {
    for (const name of ['activity.qfx', 'activity.qbo', 'activity.ofx']) {
      const { payload, report } = convertCheckingExports([text(name)], OPTIONS);
      assert.deepEqual(payload.segments[0].coverage, { start: '2026-09-01', end: '2026-09-30' }, name);
      assert.deepEqual(payload.segments[0].anchors, [{ date: '2026-09-30', balanceMinor: 253257, kind: 'ledger' }], name);
      assert.ok(payload.segments[0].rows.every((row) => row.externalIdHash !== null && /^xid1:[a-p]{64}$/.test(row.externalIdHash)), name);
      assert.deepEqual(report.files[0].checks, ['ledger-balance'], name);
    }
    const { payload, report } = convertCheckingExports([pdf()], OPTIONS);
    assert.equal(payload.segments[0].source, 'fifththird-statement');
    assert.deepEqual(payload.segments[0].anchors.filter((anchor) => anchor.kind !== 'daily'), [
      { date: '2026-08-31', balanceMinor: 250000, kind: 'opening' },
      { date: '2026-09-30', balanceMinor: 253257, kind: 'closing' },
    ]);
    assert.deepEqual(report.files[0].checks, ['statement-balances', 'statement-totals', 'running-balances']);
  });

  it('every format of the same month together is one record: days agree, balances chain', () => {
    const files = [text('activity.csv'), text('activity.qfx'), text('activity.qbo'), text('activity.ofx'), pdf()];
    const { payload, report } = convertCheckingExports(files, { ...OPTIONS, through: '2026-09-30' });
    assert.equal(payload.segments.length, 5);
    const { days, disagreements } = checkingImportDays(payload.segments);
    assert.deepEqual(disagreements, []);
    assert.equal(days.reduce((sum, day) => sum + day.rows.length, 0), 10);
    assert.deepEqual(report.balanceChain, { checked: 6, gaps: 0 });
    const all = keys(payload);
    for (const segmentKeys of all) assert.deepEqual([...segmentKeys].sort(), [...all[0]].sort());
    // Card payments to Chase and Amex leave the account as money out, for card payment reconciliation; never spending.
    const csv = payload.segments.find((segment) => segment.source === 'fifththird-csv')!;
    assert.deepEqual(csv.rows.filter((row) => /\b(?:CHASE|AMEX)\b/.test(row.description)).map((row) => [row.postedDate, row.amountMinor]), [
      ['2026-09-02', -123456], ['2026-09-02', -98765],
    ]);
  });

  it('a re-download that words rows differently or renumbers references gives the same keys', () => {
    const first = convertCheckingExports([text('activity.csv'), text('activity.qfx')], { ...OPTIONS, through: '2026-09-30' });
    const drifted = fixture('activity.csv')
      .replace('AMEX EPAYMENT ACH PMT', 'AMERICAN EXPRESS ACH PMT EPAYMENT')
      .replace('ATM WITHDRAWAL SAMPLE ST', 'ATM WITHDRAWAL 0901 SAMPLE ST');
    const renumbered = fixture('activity.qfx').replace(/<FITID>S2026/g, '<FITID>R2026').replace('<NAME>POS PURCHASE', '<NAME>DEBIT CARD PURCHASE');
    const again = convertCheckingExports([text('activity.csv', drifted), text('activity.qfx', renumbered)], { ...OPTIONS, through: '2026-09-30' });
    assert.deepEqual(keys(again.payload), keys(first.payload));
    assert.notDeepEqual(again.payload, first.payload);
    // The same files convert to the same bytes on every run.
    assert.equal(JSON.stringify(convertCheckingExports([text('activity.csv'), text('activity.qfx')], { ...OPTIONS, through: '2026-09-30' }).payload), JSON.stringify(first.payload));
  });

  it('only complete days: a download that runs into the day it was made stops the day before', () => {
    const today = fixture('activity.qfx').replace('<DTSERVER>20261002083000.000[-4:EDT]', '<DTSERVER>20260930183000.000[-4:EDT]');
    const { payload, report } = convertCheckingExports([text('activity.qfx', today)], OPTIONS);
    assert.deepEqual(payload.segments[0].coverage, { start: '2026-09-01', end: '2026-09-29' });
    assert.equal(report.files[0].leftOutAfterCoverage, 1);
    assert.ok(payload.segments[0].rows.every((row) => row.postedDate <= '2026-09-29'));
  });

  describe('refuses, naming files, lines and dates but never a value', () => {
    it('a CSV without the last complete day, or without an account', () => {
      refused(() => convertCheckingExports([text('activity.csv')], { ...OPTIONS, accountLast4: '4321' }), /pass --through/);
      refused(() => convertCheckingExports([text('activity.csv')], { ...OPTIONS, through: '2026-09-30' }), /pass --account LAST4/);
    });

    it('two downloads that disagree about a day', () => {
      const qfx = fixture('activity.qfx');
      const block = /<STMTTRN>\r?\n<TRNTYPE>POS[\s\S]*?<\/STMTTRN>\r?\n/.exec(qfx)!;
      const short = qfx.slice(0, block.index) + qfx.slice(block.index + block[0].length);
      refused(() => convertCheckingExports([text('activity.csv'), text('activity.qfx', short)], { ...OPTIONS, through: '2026-09-30' }), /disagree on 1 of them: 2026-09-03|do not follow from its rows/);
    });

    it('a statement or ledger balance the rows do not reach', () => {
      const ledger = fixture('activity.qbo').replace('<BALAMT>2532.57', '<BALAMT>2532.58');
      refused(() => convertCheckingExports([balanced(), text('activity.qbo', ledger)], { ...OPTIONS, through: '2026-09-30' }), /balances/);
      refused(() => convertCheckingExports([text('activity.csv'), pdf(), text('activity.qbo', ledger)], { ...OPTIONS, through: '2026-09-30' }), /balances/);
      refused(() => convertCheckingExports([text('activity.qfx')], { ...OPTIONS, expectOpeningBalanceMinor: 250001 }), /do not follow from its rows/);
    });

    it('files of two accounts, or of another bank', () => {
      const other = fixture('activity.qfx').replace('<ACCTID>9990004321', '<ACCTID>9990008765');
      refused(() => convertCheckingExports([text('activity.qfx'), text('activity.qfx', other)], OPTIONS), /different accounts \(4321, 8765\)/);
      refused(() => convertCheckingExports([text('activity.csv')], { ...OPTIONS, institution: 'wellsfargo', through: '2026-09-30', accountLast4: '4321' }), /from another bank/);
    });
  });

  it('every 53 format is listed for the converter', () => {
    assert.deepEqual(['fifththird-csv', 'fifththird-statement'].map((source) => checkingExportAdapter(source)?.institution), ['fifththird', 'fifththird']);
  });
});
