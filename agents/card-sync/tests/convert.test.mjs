import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { ConversionError, convertAmexStatements, loadSharedTool, mergeStatementCsvs } from '../lib/convert.mjs';
import { AGENT_DIR, amexCsv, FIXTURES, readFixture, REPO_ROOT } from './helpers.mjs';

const STATEMENT = readFixture('amex-statement-synthetic.csv');
const CURRENT = amexCsv([
  ['08/20/2026', 'SAMPLE BOOKSHOP', '25.00', '320262320000000201'],
  ['08/16/2026', 'SAMPLE COFFEE BAR', '4.50', '320262280000000202'],
]);

test('a synthetic statement export becomes a valid, redacted holdr.card-import v1 payload', async () => {
  const { validateCardImportPayload } = await loadSharedTool();
  const result = await convertAmexStatements({ csvTexts: [STATEMENT], coverage: { start: '2026-07-15', end: '2026-08-14' } });
  assert.equal(result.empty, false);
  const { payload, json } = result;
  assert.equal(validateCardImportPayload(JSON.parse(json)).ok, true);
  assert.equal(payload.format, 'holdr.card-import');
  assert.equal(payload.version, 1);
  assert.equal(payload.source, 'amex-csv');
  assert.equal(payload.issuer, 'amex');
  assert.equal(payload.currency, 'USD');
  assert.equal(payload.owner, null);
  assert.deepEqual(payload.cards, ['1005']);
  assert.deepEqual(payload.coverage, { start: '2026-07-15', end: '2026-08-14' });
  assert.equal(payload.rows.length, 4);
  assert.ok(payload.rows.every((row) => row.status === 'posted' && /^(?:xid|cfp)\d+:/.test(row.externalIdHash ?? row.fingerprint)));
  assert.deepEqual(payload.rows.map((row) => row.amountMinor).sort((a, b) => a - b), [-25000, 450, 1840, 123456]);
  assert.equal(payload.rows.find((row) => row.amountMinor === -25000).kind, 'payment');
  // Card member names, addresses, extended details, references and card numbers never reach the output.
  for (const secret of ['ALEX SAMPLE', 'CASEY SAMPLE', 'EXAMPLE ST', 'SPRINGFIELD', '62701', 'Terminal', '4111', '320262240000000101', 'XXXX-XXXXXX', '91005']) {
    assert.equal(json.includes(secret), false, secret);
  }
  assert.deepEqual({ rows: result.report.rows, droppedColumns: result.report.droppedColumns, memberColumn: result.report.memberColumn },
    { rows: 4, droppedColumns: 6, memberColumn: 'dropped' });
});

test('several statement exports of one card become one file; quiet statements add nothing; the owner hint is kept', async () => {
  const merged = await convertAmexStatements({
    csvTexts: [STATEMENT, '', CURRENT], coverage: { start: '2026-07-15', end: '2026-09-10' }, owner: 'casey',
  });
  assert.equal(merged.payload.rows.length, 6);
  assert.equal(merged.payload.owner, 'casey');
  assert.deepEqual(merged.payload.coverage, { start: '2026-07-15', end: '2026-09-10' });
  // The multi-line quoted fields of the first export survive the merge.
  const { parseCsv } = await loadSharedTool();
  const text = mergeStatementCsvs([STATEMENT, CURRENT], parseCsv);
  const records = parseCsv(text);
  assert.equal(records.length, 7);
  assert.equal(records.filter((record) => record.fields.includes('SPRINGFIELD\nIL')).length, 2);
  assert.equal(mergeStatementCsvs([CURRENT], parseCsv), CURRENT, 'a single export is passed on unchanged');
  assert.equal(mergeStatementCsvs(['', '  '], parseCsv), null);
  assert.deepEqual(await convertAmexStatements({ csvTexts: ['', ''], coverage: { start: '2026-07-15', end: '2026-08-14' } }), { empty: true });
  await assert.rejects(convertAmexStatements({ csvTexts: [CURRENT], owner: 'someone' }), /invalid owner/);
});

test('exports with other columns are not merged, and conversion errors name lines, never values', async () => {
  const other = 'Date,Description,Amount\r\n08/20/2026,SAMPLE BOOKSHOP,25.00\r\n';
  await assert.rejects(convertAmexStatements({ csvTexts: [STATEMENT, other] }), (error) => error instanceof ConversionError && /different columns/.test(error.message));
  const broken = amexCsv([['13/45/2026', 'SAMPLE SECRET MERCHANT', '9.99', '320262990000000301']]);
  await assert.rejects(convertAmexStatements({ csvTexts: [broken] }), (error) => {
    assert.ok(error instanceof ConversionError);
    assert.equal(error.code, 'conversion-failed');
    assert.match(error.lines.join(' '), /line 2/);
    const said = `${error.message} ${error.lines.join(' ')}`;
    for (const value of ['SAMPLE SECRET MERCHANT', '9.99', '13/45/2026', '320262990000000301']) assert.equal(said.includes(value), false, value);
    return true;
  });
  await assert.rejects(convertAmexStatements({ csvTexts: ['"unclosed,quote\r\n'] }), ConversionError);
});

test('the converter loads from packages/shared/src under plain node too (as the auto-start task runs it)', () => {
  const script = `
    const { convertAmexStatements } = await import(${JSON.stringify(pathToFileURL(path.join(AGENT_DIR, 'lib', 'convert.mjs')).href)});
    const { readFileSync } = await import('node:fs');
    const csv = readFileSync(${JSON.stringify(path.join(FIXTURES, 'amex-statement-synthetic.csv'))}, 'utf8');
    const result = await convertAmexStatements({ csvTexts: [csv], coverage: { start: '2026-07-15', end: '2026-08-14' } });
    console.log(result.payload.rows.length, result.payload.format);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '4 holdr.card-import');
});
