/**
 * Fifth Third's export formats side by side: the activity CSV, QFX (Quicken), QBO (QuickBooks) and OFX of the same
 * synthetic September. They must read as one record: the same posted dates and exact amounts, the same content keys,
 * and balances that chain. Every fixture is synthetic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  checkCheckingBalanceChain,
  checkingDayKeys,
  checkingDayNets,
  checkingImportDays,
  type CheckingImportAnchor,
  type CheckingImportSegment,
} from '../checkingImport.js';
import { checkingExportAdapter, detectCheckingExportAdapters } from './adapters.js';
import { FIFTH_THIRD_CSV_SOURCE } from './fifthThirdCsv.js';
import { CheckingExportFormatError, type ParsedCheckingExport } from './parsed.js';

const fixtureText = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/fifththird/${name}`, import.meta.url)), 'utf8');
const FILES = ['activity.csv', 'activity.qfx', 'activity.qbo', 'activity.ofx'] as const;

function parse(text: string): ParsedCheckingExport {
  const adapters = detectCheckingExportAdapters({ kind: 'text', text });
  assert.equal(adapters.length, 1, 'exactly one adapter recognizes the file');
  return adapters[0].parse({ kind: 'text', text }, {});
}

const parsedFiles = () => Object.fromEntries(FILES.map((name) => [name, parse(fixtureText(name))])) as Record<(typeof FILES)[number], ParsedCheckingExport>;

/** The segment a converter would write for a file covering September, descriptions aside. */
function segment(parsed: ParsedCheckingExport, anchors: CheckingImportAnchor[] = []): CheckingImportSegment {
  return {
    source: parsed.source,
    coverage: { start: '2026-09-01', end: '2026-09-30' },
    anchors,
    rows: parsed.rows.filter((row) => !row.pending).map((row) => ({
      postedDate: row.postedDate,
      amountMinor: row.amountMinor,
      description: 'SYNTHETIC',
      checkNumber: row.checkNumber,
      bankType: null,
      externalIdHash: null,
    })),
  };
}

/** End-of-day balances from a running balance: the last row of each day states it. */
function dailyAnchors(parsed: ParsedCheckingExport): CheckingImportAnchor[] {
  const byDay = new Map<string, number>();
  for (const row of parsed.rows) if (!row.pending && row.runningBalanceMinor !== null) byDay.set(row.postedDate, row.runningBalanceMinor);
  return [...byDay.entries()].map(([date, balanceMinor]) => ({ date, balanceMinor, kind: 'daily' as const }));
}

const keysByDay = (parsed: ParsedCheckingExport) => {
  const days = new Map<string, Array<{ postedDate: string; amountMinor: number }>>();
  for (const row of parsed.rows) days.set(row.postedDate, [...(days.get(row.postedDate) ?? []), row]);
  return Object.fromEntries([...days.entries()].map(([date, rows]) => [date, checkingDayKeys(rows).sort()]));
};

describe('Fifth Third formats', () => {
  it('each format is recognized by exactly one adapter', () => {
    assert.deepEqual(FILES.map((name) => detectCheckingExportAdapters({ kind: 'text', text: fixtureText(name) }).map((adapter) => adapter.source)), [
      [FIFTH_THIRD_CSV_SOURCE], ['ofx'], ['ofx'], ['ofx'],
    ]);
    assert.equal(checkingExportAdapter(FIFTH_THIRD_CSV_SOURCE)?.institution, 'fifththird');
  });

  it('all four read the same posted dates and exact amounts, oldest first', () => {
    const files = parsedFiles();
    const expected = [
      ['2026-09-01', 320000], ['2026-09-01', -10000], ['2026-09-02', -123456], ['2026-09-02', -98765], ['2026-09-03', -25000],
      ['2026-09-03', -4217], ['2026-09-03', -4217], ['2026-09-08', -50000], ['2026-09-15', 12], ['2026-09-30', -1100],
    ];
    for (const name of FILES) {
      assert.deepEqual(files[name].rows.map((row) => [row.postedDate, row.amountMinor]), expected, name);
      assert.deepEqual(files[name].problems, [], name);
      assert.equal(files[name].currency, 'USD', name);
      assert.equal(files[name].rows.find((row) => row.amountMinor === -25000)?.checkNumber, '1042', name);
    }
    for (const name of ['activity.qfx', 'activity.qbo', 'activity.ofx'] as const) {
      assert.equal(files[name].accountLast4, '4321', name);
      assert.equal(files[name].accountType, 'CHECKING', name);
      assert.deepEqual(files[name].coverage, { start: '2026-09-01', end: '2026-09-30' }, name);
      assert.equal(files[name].madeAt, '2026-10-02', name);
      assert.deepEqual(files[name].ledgerBalance, { amountMinor: 253257, asOf: '2026-09-30' }, name);
      assert.ok(files[name].rows.every((row) => row.externalId !== null && row.runningBalanceMinor === null), name);
    }
  });

  it('keys every day the same whichever format, wording or reference it came from', () => {
    const files = parsedFiles();
    const csvKeys = keysByDay(files['activity.csv']);
    for (const name of FILES) assert.deepEqual(keysByDay(files[name]), csvKeys, name);
    // The two identical purchases of 09/03 are two rows with two keys.
    assert.equal(new Set(csvKeys['2026-09-03']).size, 3);
    // Descriptions differ between formats, and so do references: neither is part of a key.
    assert.notDeepEqual(files['activity.csv'].rows.map((row) => row.description), files['activity.qfx'].rows.map((row) => row.description));
    const renumbered = parse(fixtureText('activity.qfx').replace(/<FITID>S2026/g, '<FITID>R2026'));
    assert.notDeepEqual(renumbered.rows.map((row) => row.externalId), files['activity.qfx'].rows.map((row) => row.externalId));
    assert.deepEqual(keysByDay(renumbered), csvKeys);
  });

  it('four segments of the same days agree, so they are one record, and every balance chains', () => {
    const files = parsedFiles();
    const csv = files['activity.csv'];
    // Fifth Third's export states no balance; the same month with a running balance gives the opening and daily ones.
    const withBalance = checkingExportAdapter(FIFTH_THIRD_CSV_SOURCE)!.parse({ kind: 'text', text: fixtureText('activity-balance.csv') }, {});
    const opening = withBalance.rows[0].runningBalanceMinor! - withBalance.rows[0].amountMinor;
    const segments = [
      segment(csv),
      segment(withBalance, [{ date: '2026-08-31', balanceMinor: opening, kind: 'opening' }, ...dailyAnchors(withBalance)]),
      ...(['activity.qfx', 'activity.qbo', 'activity.ofx'] as const).map((name) => {
        const ledger = files[name].ledgerBalance!;
        return segment(files[name], [{ date: ledger.asOf, balanceMinor: ledger.amountMinor, kind: 'ledger' }]);
      }),
    ];
    const { days, disagreements } = checkingImportDays(segments);
    assert.deepEqual(disagreements, []);
    assert.equal(days.length, 30);
    assert.equal(days.reduce((sum, day) => sum + day.rows.length, 0), 10);
    const nets = checkingDayNets(days);
    const chain = checkCheckingBalanceChain(segments.flatMap((each) => each.anchors), (date) => nets.get(date) ?? null);
    assert.deepEqual(chain.mismatches, []);
    assert.equal(chain.gaps, 0);
    // 08/31 (opening), the six days with a running balance, and 09/30 again from each LEDGERBAL: six pairs.
    assert.equal(chain.checked, 6);
    // Opening + credits - debits = closing.
    const credits = csv.rows.filter((row) => row.amountMinor > 0).reduce((sum, row) => sum + row.amountMinor, 0);
    const debits = csv.rows.filter((row) => row.amountMinor < 0).reduce((sum, row) => sum - row.amountMinor, 0);
    assert.equal(opening + credits - debits, files['activity.qfx'].ledgerBalance!.amountMinor);
  });

  it('a download missing a row disagrees with the others on that day, and its balance no longer chains', () => {
    const files = parsedFiles();
    const qfx = fixtureText('activity.qfx');
    const block = /<STMTTRN>\r?\n<TRNTYPE>POS[\s\S]*?<\/STMTTRN>\r?\n/.exec(qfx);
    assert.ok(block);
    const short = parse(qfx.slice(0, block.index) + qfx.slice(block.index + block[0].length));
    assert.equal(short.rows.length, 9);
    const segments = [segment(files['activity.csv']), segment(short)];
    assert.deepEqual(checkingImportDays(segments).disagreements, ['2026-09-03']);
    const alone = [segment(short, [{ date: '2026-08-31', balanceMinor: 250000, kind: 'opening' }, { date: '2026-09-30', balanceMinor: 253257, kind: 'ledger' }])];
    const nets = checkingDayNets(checkingImportDays(alone).days);
    assert.deepEqual(checkCheckingBalanceChain(alone[0].anchors, (date) => nets.get(date) ?? null).mismatches, ['2026-09-30']);
  });

  it('refuses a damaged QFX, QBO or OFX without showing a value', () => {
    const values = ['CONTOSO', 'GROCERY', 'CHASE', '1234.56', '2532.57', '9990004321', 'S20260901A0001'];
    const refused = (text: string, pattern: RegExp) => {
      try {
        checkingExportAdapter('ofx')!.parse({ kind: 'text', text }, {});
      } catch (error) {
        assert.ok(error instanceof CheckingExportFormatError, String(error));
        assert.match(error.message, pattern);
        for (const value of values) assert.ok(!error.message.includes(value), `shows ${value}`);
        return;
      }
      assert.fail('expected a refusal');
    };
    const qfx = fixtureText('activity.qfx');
    refused(qfx.slice(0, qfx.indexOf('<NAME>CHASE') + 8), /is not closed \(the file may be truncated\)/);
    refused(fixtureText('activity.qbo').replace(/<CURDEF>USD\r?\n/, ''), /CURDEF/);
    const xml = fixtureText('activity.ofx').replace(/<STMTRS>[\s\S]*<\/STMTRS>/, '');
    const status = xml.indexOf('<CODE>0</CODE>', xml.indexOf('<STMTTRNRS>'));
    refused(`${xml.slice(0, status)}<CODE>2000</CODE>${xml.slice(status + '<CODE>0</CODE>'.length)}`, /bank reported an error/);
    refused(qfx.replace('<OFX>', '<!DOCTYPE OFX>\n<OFX>'), /DTD|declarations/);
    const rows = parse(qfx.replace(/<TRNAMT>-42\.17(\r?\n<FITID>S20260903A0003)/, '<TRNAMT>-42.171$1'));
    assert.equal(rows.problems.length, 1);
    assert.match(rows.problems[0].reason, /TRNAMT has more than 2 decimal places/);
  });
});
