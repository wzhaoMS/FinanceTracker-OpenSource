import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { convertCardExport } from './convert.js';
import { parseOfx, redactOfxForPage } from './ofx.js';

const fixture = readFileSync(new URL('./fixtures/statement.qfx', import.meta.url), 'utf8');
const convert = (text: string) => convertCardExport(new TextEncoder().encode(text), {
  format: 'ofx', issuer: 'citi', status: 'posted',
});

test('page redaction removes account/display PANs without changing offline payload or FITIDs', () => {
  const output = redactOfxForPage(fixture, '1111');
  assert.ok(output.includes('<ACCTID>1111</ACCTID>'));
  assert.ok(!output.includes('4111111111111111'));
  assert.ok(!output.includes('371449635398431'));
  assert.ok(!output.includes('sampleuser'));
  const before = parseOfx(fixture, { sign: null, cards: [] });
  const after = parseOfx(output, { sign: null, cards: [] });
  assert.deepEqual(after.rows.map((row) => row.externalId), before.rows.map((row) => row.externalId));
  assert.equal(convert(output).json, convert(fixture).json);
});
test('numeric entities cannot hide a PAN in a kept display field', () => {
  const encoded = [...'371449635398431'].map((digit) => `&#${digit.charCodeAt(0)};`).join('');
  const output = redactOfxForPage(fixture.replace('371449635398431', encoded), '1111');
  assert.ok(!output.includes(encoded));
  assert.ok(!output.includes('371449635398431'));
});
test('an account ending mismatch refuses the export', () => {
  assert.throws(() => redactOfxForPage(fixture, '9999'));
});
test('a FITID containing a known PAN is refused rather than modified', () => {
  assert.throws(() => redactOfxForPage(fixture.replace('2026090524692166221000123', 'ref4111111111111111tail'), '1111'));
});
test('card-secret labels in individual or joined fields refuse the export', () => {
  for (const text of [
    fixture.replace('SAN FRANCISCO CA', 'CVV 123'),
    fixture.replace('TRADER JOE&apos;S #123', 'CVV').replace('SAN FRANCISCO CA', '123'),
    fixture.replace('<LANGUAGE>ENG', '<USERPASS>synthetic-secret\n<LANGUAGE>ENG'),
  ]) assert.throws(() => redactOfxForPage(text, '1111'));
});
test('unsafe partial PAN text split across NAME and MEMO is refused', () => {
  const text = fixture.replace('TRADER JOE&apos;S #123', 'CARD 41111111').replace('SAN FRANCISCO CA', '11111111');
  assert.throws(() => redactOfxForPage(text, '1111'));
});
test('DTD/entity expansion and unsupported correction semantics cannot leave the page', () => {
  assert.throws(() => redactOfxForPage('<!DOCTYPE OFX [<!ENTITY secret "synthetic">]>' + fixture, '1111'));
  assert.throws(() => redactOfxForPage(fixture.replace('<TRNTYPE>DEBIT', '<CORRECTFITID>synthetic\n<TRNTYPE>DEBIT'), '1111'));
});
