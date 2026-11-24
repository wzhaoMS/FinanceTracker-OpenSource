import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { cardExternalIdHash, sha256, toLetterHex } from '../cardDedupe.js';
import { validateCardImportPayload } from '../cardImport.js';
import { containsCardData } from '../cardNumbers.js';
import { cardSpendingRole } from '../cardSpending.js';
import { containsLongDigitRun } from '../cardText.js';
import type { CardTransactionKind } from '../types.js';
import { currencyExponent, formatMinor, parseAmount } from './amount.js';
import { classifyCardKind } from './classify.js';
import { runCardImportCli, type CliIo } from './cli.js';
import { convertCardExport, ConvertError, EXPORT_FORMATS, type ConvertOptions } from './convert.js';
import { parseCsv, CsvError } from './csv.js';
import { decodeExport } from './decode.js';
import { dateOfDay, dayNumber, describeMoment, madeOnDates, reachesMadeOnDay } from './statementDates.js';

const fixture = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));
const NAMES = /ALEX|JORDAN|SAMPLE USER/;

const TEST_PANS = ['4111111111111111', '371449635398431', '5555555555554444'];

/** Everything a person or another program could see must be free of card data: at most four digits of a card survive. */
function assertNoCardData(text: string): void {
  assert.doesNotMatch(text, /\d{13}/);
  assert.equal(containsLongDigitRun(text), false);
  for (const pan of TEST_PANS) {
    for (let i = 0; i + 5 <= pan.length; i += 1) assert.ok(!text.includes(pan.slice(i, i + 5)), 'exposes five digits of a test card number');
  }
}

function assertJsonSafe(json: string): void {
  assertNoCardData(json);
  const parsed = JSON.parse(json);
  for (const row of parsed.rows) {
    for (const field of ['description', 'merchant', 'issuerCategory']) {
      if (row[field] !== null) assert.equal(containsCardData(row[field]), false, field);
    }
  }
  assert.ok(validateCardImportPayload(parsed).ok);
}

/** Converts as a closed statement (`--status posted`) unless the test gives `status` or `closedThrough` itself. */
function convert(file: string | Uint8Array, options: Partial<ConvertOptions> & Pick<ConvertOptions, 'format'>) {
  const stated = 'status' in options || 'closedThrough' in options ? options : { ...options, status: 'posted' as const };
  return convertCardExport(typeof file === 'string' ? fixture(file) : file, stated);
}

function memoryIo(files: Record<string, Uint8Array>) {
  const out = { stdout: '', stderr: '', written: new Map<string, string>() };
  const io: CliIo = {
    readFile(path, maxBytes) {
      const file = files[path];
      if (!file) throw new Error('no such file');
      if (file.length > maxBytes) throw new Error('too large');
      return file;
    },
    writeFile(path, text, overwrite) {
      if ((files[path] || out.written.has(path)) && !overwrite) throw new Error('the file exists (use --force to replace it)');
      out.written.set(path, text);
    },
    samePath: (a, b) => a === b,
    stdout: (text) => {
      out.stdout += text;
    },
    stderr: (text) => {
      out.stderr += text;
    },
  };
  return { io, out };
}

describe('amounts', () => {
  it('parses exact minor units without floating point and refuses extra precision', () => {
    const ok = (text: string, exponent = 2, syntax = {}) => {
      const result = parseAmount(text, exponent, syntax);
      assert.ok(result.ok, text);
      return result.minor;
    };
    assert.equal(ok('12.34'), 1234);
    assert.equal(ok('-0.10'), -10);
    assert.equal(ok('+5'), 500);
    assert.equal(ok('.5'), 50);
    assert.equal(ok('0.29'), 29);
    assert.equal(ok('1.005', 3), 1005);
    assert.equal(ok('12.300'), 1230);
    assert.equal(ok('1,234.56', 2, { thousands: true }), 123456);
    assert.equal(ok('($1,234.56)', 2, { thousands: true, symbols: true }), -123456);
    assert.equal(ok('\u221212.00'), -1200);
    assert.equal(ok('-12,34', 2, { decimalComma: true }), -1234);
    assert.equal(ok('1500', 0), 1500);
    assert.equal(Object.is(ok('-0.00'), -0), false);
    for (const bad of ['', '12.345', '1,234.56', '12a', '1e5', '--1', '9999999999999999', 'NaN', '12.']) {
      assert.equal(parseAmount(bad, 2).ok, false, bad);
    }
    assert.equal(currencyExponent('JPY'), 0);
    assert.equal(currencyExponent('KWD'), 3);
    assert.equal(formatMinor(-123456, 2), '-1,234.56');
    assert.equal(formatMinor(5, 2), '0.05');
  });
});

describe('decoding', () => {
  const cafe = 'Date,Description,Amount\n09/14/2026,CAFÉ ÉCLAIR,4.50\n';
  const expected = convert(bytes(cafe), { format: 'amex-csv' }).json;

  it('reads UTF-8 with and without a BOM, Windows-1252 and UTF-16 to the same JSON', () => {
    const cp1252 = new Uint8Array([...cafe].map((char) => (char === 'É' ? 0xc9 : char.charCodeAt(0))));
    const utf16 = (littleEndian: boolean) => {
      const out = [littleEndian ? 0xff : 0xfe, littleEndian ? 0xfe : 0xff];
      for (const char of cafe) {
        const code = char.charCodeAt(0);
        out.push(...(littleEndian ? [code & 0xff, code >> 8] : [code >> 8, code & 0xff]));
      }
      return new Uint8Array(out);
    };
    for (const input of [new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(cafe)]), cp1252, utf16(true), utf16(false)]) {
      assert.equal(convert(input, { format: 'amex-csv' }).json, expected);
    }
    assert.equal(decodeExport(cp1252).encoding, 'windows-1252');
    assert.match(expected, /CAFÉ ÉCLAIR/);
    const smart = new Uint8Array([0x93, 0x41, 0x94, 0x96, 0x80]);
    assert.equal(decodeExport(smart).text, '\u201cA\u201d\u2013\u20ac');
  });

  it('refuses binary files, invalid UTF-8 when UTF-8 is required, and odd UTF-16', () => {
    assert.throws(() => decodeExport(new Uint8Array([0x41, 0x00, 0x42])), /NUL/);
    assert.throws(() => decodeExport(new Uint8Array([0xc3, 0x28]), 'utf-8'), /not valid UTF-8/);
    assert.throws(() => decodeExport(new Uint8Array([0xef, 0xbb, 0xbf, 0xff])), /not valid UTF-8/);
    assert.throws(() => decodeExport(new Uint8Array([0xff, 0xfe, 0x41])), /odd number/);
    assert.equal(decodeExport(new Uint8Array([0xed, 0xa0, 0x80])).encoding, 'windows-1252');
  });
});

describe('CSV records', () => {
  it('handles quotes, escaped quotes, embedded line breaks and every line ending', () => {
    const records = parseCsv('a,"b ""q"", c","line\r\nbreak"\r\nx,,z\ry,"",\n\n,,\n');
    assert.deepEqual(records.map((record) => [record.line, record.fields]), [
      [1, ['a', 'b "q", c', 'line\nbreak']],
      [3, ['x', '', 'z']],
      [4, ['y', '', '']],
    ]);
  });

  it('fails on truncated or mangled quoting and on oversized input, naming lines only', () => {
    assert.throws(() => parseCsv('a,b\n1,"open 4111111111111111'), (error: Error) => error instanceof CsvError && /line 2/.test(error.message) && !/4111/.test(error.message));
    assert.throws(() => parseCsv('a,"b"c\n'), /after a closing quote/);
    assert.throws(() => parseCsv(`a\n${'x'.repeat(10_001)}\n`), /longer than/);
    assert.throws(() => parseCsv(`${'a,'.repeat(70)}a\n`), /more than 64 fields/);
    assert.throws(() => parseCsv('a\n'.repeat(10_010)), /more than 10002 records/);
  });
});

describe('Amex CSV', () => {
  const members = [{ name: 'Alex  Sample', owner: 'casey' as const }, { name: 'JORDAN SAMPLE', owner: 'alex' as const }];

  it('keeps only allowlisted columns and redacts the rest of the row away', () => {
    const { json, payload, report } = convert('amex-detailed.csv', { format: 'amex-csv', members });
    assertJsonSafe(json);
    assert.doesNotMatch(json, NAMES);
    for (const dropped of ['Terminal', 'WEBSTER', 'OAKLAND\\nCA', '94607', 'UNITED STATES', 'Guest', 'Return of item', 'XXXX']) {
      assert.ok(!json.includes(dropped), dropped);
    }
    assert.deepEqual(report.droppedColumns, ['Extended Details', 'Appears On Your Statement As', 'Address', 'City/State', 'Zip Code', 'Country']);
    assert.deepEqual(payload.cards, ['0003', '2003']);
    assert.equal(payload.owner, 'joint');
    assert.deepEqual(report.owners, { casey: 6, alex: 2 });
    assert.equal(payload.issuer, 'amex');
    assert.equal(payload.source, 'amex-csv');
    const keys = new Set(payload.rows.flatMap((row) => Object.keys(row)));
    assert.deepEqual([...keys].sort(), ['amountMinor', 'description', 'externalIdHash', 'fingerprint', 'issuerCategory', 'kind', 'merchant', 'postedDate', 'status', 'transactionDate']);
  });

  it('maps signs, kinds, references and categories', () => {
    const { payload } = convert('amex-detailed.csv', { format: 'amex-csv' });
    const byDescription = (start: string) => payload.rows.find((row) => row.description.startsWith(start))!;
    assert.equal(byDescription('AUTOPAY').amountMinor, -120000);
    assert.equal(byDescription('AUTOPAY').kind, 'payment');
    assert.equal(byDescription('AMAZON').kind, 'refund');
    assert.equal(byDescription('ANNUAL').kind, 'fee');
    assert.equal(byDescription('HOTEL').amountMinor, 123456);
    assert.equal(byDescription('UBER').issuerCategory, 'Transportation-Taxis & Coach');
    // The Reference column is hashed without the apostrophes Amex adds for spreadsheets.
    assert.equal(payload.rows[5].externalIdHash, cardExternalIdHash('320262570000000001'));
    assert.equal(payload.rows.filter((row) => row.description === 'BLUE BOTTLE COFFEE OAKLAND CA').length, 2);
    assert.equal(byDescription("'=HYPERLINK").kind, 'purchase');
    assert.deepEqual(payload.totals.posted, {
      count: 8, chargesMinor: 196946, creditsMinor: -122345, netMinor: 74601,
      byKind: {
        purchase: { count: 5, amountMinor: 127446 }, refund: { count: 1, amountMinor: -2345 },
        payment: { count: 1, amountMinor: -120000 }, fee: { count: 1, amountMinor: 69500 },
        interest: { count: 0, amountMinor: 0 }, adjustment: { count: 0, amountMinor: 0 }, other: { count: 0, amountMinor: 0 },
      },
    });
  });

  it('drops Card Member without a mapping and refuses unmapped names without printing them', () => {
    const { payload, report } = convert('amex-detailed.csv', { format: 'amex-csv' });
    assert.equal(payload.owner, null);
    assert.equal(report.memberColumn, 'dropped');
    assert.throws(
      () => convert('amex-detailed.csv', { format: 'amex-csv', members: [members[0]] }),
      (error: Error) => /Card Member is not in the --member mappings/.test(error.message) && !NAMES.test(error.message),
    );
    assert.throws(() => convert('amex-basic.csv', { format: 'amex-csv', members }), /no Card Member column/);
  });

  it('filters by card and computes the owner hint from the kept rows', () => {
    const { payload, report } = convert('amex-detailed.csv', { format: 'amex-csv', members, cards: ['2003'] });
    assert.equal(payload.rows.length, 2);
    assert.equal(report.excludedByCard, 6);
    assert.equal(payload.owner, 'alex');
    assert.deepEqual(payload.cards, ['2003']);
    assert.throws(() => convert('amex-basic.csv', { format: 'amex-csv', cards: ['0003'] }), /Account #/);
  });

  it('fingerprints exports without references and keeps two identical purchases', () => {
    const { payload } = convert('amex-basic.csv', { format: 'amex-csv' });
    const coffees = payload.rows.filter((row) => row.description === 'BLUE BOTTLE COFFEE');
    assert.equal(coffees.length, 2);
    assert.ok(coffees.every((row) => row.externalIdHash === null && row.fingerprint));
    assert.notEqual(coffees[0].fingerprint, coffees[1].fingerprint);
    assert.equal(payload.rows.find((row) => row.amountMinor === -12000)?.kind, 'payment');
  });

  it('refuses wrong columns, ambiguous headers and bad rows unless told to skip them', () => {
    assert.throws(() => convert(bytes('Date,Description,Total\n09/14/2026,X,1.00\n'), { format: 'amex-csv' }), /missing Amount/);
    assert.throws(() => convert(bytes('09/14/2026,ACME 4111111111111111,1.00\n'), { format: 'amex-csv' }), (error: Error) => /does not look like/.test(error.message) && !/4111/.test(error.message));
    assert.throws(() => convert(bytes('Date,Amount,Description,Amount\n'), { format: 'amex-csv' }), /more than one Amount/);
    const broken = 'Date,Description,Amount\n09/14/2026,GOOD,1.00\n09/15/2026,SHORT ROW 4111111111111111\n13/45/2026,BAD DATE,2.00\n09/16/2026,BAD AMOUNT,12.345\n09/17/2026,EXTRA,1.00,surplus\n';
    try {
      convert(bytes(broken), { format: 'amex-csv' });
      assert.fail('expected an error');
    } catch (error) {
      assert.ok(error instanceof ConvertError);
      assert.deepEqual(error.problems.map((problem) => problem.line), [3, 4, 5, 6]);
      assert.doesNotMatch(JSON.stringify(error.problems) + error.message, /4111|SHORT|surplus|12\.345/);
    }
    const skipped = convert(bytes(broken), { format: 'amex-csv', skipInvalid: true });
    assert.equal(skipped.payload.rows.length, 1);
    assert.equal(skipped.payload.rejectedCount, 4);
    assert.equal(skipped.report.rejected.length, 4);
  });

  it('reads day-first dates when asked, and hints when the order looks wrong', () => {
    const uk = bytes('Date,Description,Amount\n14/09/2026,TESCO,4.50\n');
    assert.equal(convert(uk, { format: 'amex-csv', dateOrder: 'dmy', currency: 'GBP' }).payload.rows[0].transactionDate, '2026-09-14');
    const result = convert(uk, { format: 'amex-csv', skipInvalid: true, coverage: { start: '2026-09-01', end: '2026-09-30' } });
    assert.ok(result.report.notes.some((note) => /DMY/.test(note)));
  });
});

describe('Wells Fargo CSV', () => {
  // A synthetic card download in the current layout: header, newest first, Wells Fargo's sign (charges negative).
  const rows = [
    ['10/20/2026', 'FABRIKAM BOOKS SEATTLE WA', '-12.00'],
    ['10/15/2026', 'ONLINE PAYMENT THANK YOU', '250.00'],
    ['10/14/2026', 'PROSEWARE BISTRO', '-18.50'],
    ['10/10/2026', 'CONTOSO OUTFITTERS', '30.00'],
    ['10/02/2026', 'TAILSPIN TOYS 4111111111111111', '-30.00'],
    ['09/30/2026', 'FOREIGN TRANSACTION FEE', '-1.25'],
    ['09/25/2026', 'PROSEWARE BISTRO', '-18.50'],
    ['09/25/2026', 'PROSEWARE BISTRO', '-18.50'],
  ];
  const current = (status = 'Posted', list = rows) => bytes(['"DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"',
    ...list.map(([date, description, amount]) => `"${date}","${description}","${amount}","","${status}"`)].join('\r\n') + '\r\n');
  const legacy = bytes(rows.map(([date, description, amount]) => `"${date}","${amount}","*","","${description}"`).join('\r\n') + '\r\n');
  const wf = { format: 'wf-csv' as const };

  it('reads the current layout: kinds, Holdr sign, fingerprints, no card and no reference', () => {
    const { json, payload, report } = convert(current(), wf);
    assertJsonSafe(json);
    assert.equal(payload.issuer, 'wellsfargo');
    assert.equal(payload.source, 'wf-csv');
    assert.deepEqual(payload.cards, []);
    assert.deepEqual(report.droppedColumns, ['CHECK #']);
    assert.deepEqual(payload.rows.map((row) => [row.transactionDate, row.amountMinor, row.kind]), [
      ['2026-10-20', 1200, 'purchase'], ['2026-10-15', -25000, 'payment'], ['2026-10-14', 1850, 'purchase'],
      ['2026-10-10', -3000, 'refund'], ['2026-10-02', 3000, 'purchase'], ['2026-09-30', 125, 'fee'],
      ['2026-09-25', 1850, 'purchase'], ['2026-09-25', 1850, 'purchase'],
    ]);
    assert.ok(payload.rows.every((row) => row.externalIdHash === null && row.fingerprint && row.postedDate === null));
    assert.notEqual(payload.rows[6].fingerprint, payload.rows[7].fingerprint);
    assert.equal(payload.rows[4].description, 'TAILSPIN TOYS ***1111');
    assert.deepEqual([payload.totals.posted.chargesMinor, payload.totals.posted.creditsMinor], [9875, -28000]);
  });

  it('reads the older headerless layout into the same rows', () => {
    const old = convert(legacy, wf);
    assert.deepEqual(old.payload.rows, convert(current(), wf).payload.rows);
    assert.ok(old.report.notes.some((note) => /older headerless/.test(note)));
    assert.deepEqual(old.report.droppedColumns, ['CHECK #']);
  });

  it('checks statement figures and takes the requested dates as its coverage', () => {
    const checked = convert(current(), { ...wf, coverage: { start: '2026-09-22', end: '2026-10-22' }, expected: { previousBalance: '500.00', newBalance: '318.75' } });
    assert.equal(checked.report.reconciliation.status, 'match');
    assert.deepEqual(checked.payload.coverage, { start: '2026-09-22', end: '2026-10-22' });
    assert.equal(convert(current(), { ...wf, expected: { previousBalance: '500.00', newBalance: '318.76' } }).report.reconciliation.status, 'mismatch');
  });

  it('refuses rows Wells Fargo marks Pending under --status posted, and takes them as pending', () => {
    assert.throws(() => convert(current('Pending'), wf), /8 rows are marked Pending by Wells Fargo/);
    const pending = convert(current('Pending'), { ...wf, status: 'pending' });
    assert.equal(pending.payload.totals.pending.count, 8);
    assert.throws(() => convert(current('Cleared'), wf), (error: Error) => error instanceof ConvertError && error.problems.length === 8
      && /STATUS is neither Posted nor Pending/.test(error.problems[0].reason));
    assert.throws(() => convert(current(), { ...wf, closedThrough: '2026-10-15', status: undefined }), /posted date/);
  });

  it('refuses a deposit account download, or a card file with the other sign, unless the sign is given', () => {
    // A checking account pays its cards: money out, negative, which as card rows would be charges.
    const checking = bytes(['DATE,DESCRIPTION,AMOUNT,CHECK #,STATUS', '10/15/2026,AMEX EPAYMENT ACH PMT,-1200.00,,Posted',
      '10/03/2026,CITI AUTOPAY PAYMENT,-300.00,,Posted', '10/01/2026,PAYROLL DEPOSIT,2500.00,,Posted'].join('\n'));
    assert.throws(() => convert(checking, wf), /2 of 2 card payment rows would be charges.*deposit account/);
    const flipped = current('Posted', rows.map(([date, description, amount]) => [date, description, amount.startsWith('-') ? amount.slice(1) : `-${amount}`]));
    assert.throws(() => convert(flipped, wf), /--ofx-sign inverted/);
    assert.deepEqual(convert(flipped, { ...wf, ofxSign: 'inverted' }).payload.rows, convert(current(), wf).payload.rows);
    // Without a card payment row nothing shows the sign: refused, never read as the usual sign, unless it is given.
    const noPayments = current('Posted', rows.filter(([, description]) => !/PAYMENT/.test(description)));
    assert.throws(() => convert(noPayments, wf), /^ExportFormatError: no card payment row in this file shows the amount sign/);
    assert.deepEqual(convert(noPayments, { ...wf, ofxSign: 'standard' }).payload.rows,
      convert(current(), wf).payload.rows.filter((row) => row.kind !== 'payment'));
  });

  it('reads the amount sign only when every card payment row shows it, or --ofx-sign gives it', () => {
    const purchase = (amount: string) => ['10/20/2026', 'FABRIKAM BOOKS SEATTLE WA', amount];
    const payment = (date: string, amount: string) => [date, 'ONLINE PAYMENT THANK YOU', amount];
    // An inverted file without a payment row (one purchase, written positive): nothing in it shows the sign.
    const inverted = current('Posted', [purchase('12.00')]);
    assert.throws(() => convert(inverted, wf), (error: Error) => {
      assert.equal(error.name, 'ExportFormatError');
      assert.equal(error.message, 'no card payment row in this file shows the amount sign: check a purchase in the file and re-run '
        + 'with --ofx-sign standard (Wells Fargo\'s usual sign: charges negative) or --ofx-sign inverted (charges positive)');
      return true;
    });
    const asInverted = convert(inverted, { ...wf, ofxSign: 'inverted' });
    assert.deepEqual(asInverted.payload.rows.map((row) => [row.amountMinor, row.kind]), [[1200, 'purchase']]);
    // The same purchase in the usual sign is refused alike, and with --ofx-sign standard is the same row.
    const usual = current('Posted', [purchase('-12.00')]);
    assert.throws(() => convert(usual, wf), /^ExportFormatError: no card payment row in this file shows the amount sign/);
    assert.equal(convert(usual, { ...wf, ofxSign: 'standard' }).json, asInverted.json);

    // Payment rows that disagree show no sign either: a 1:1 tie, or one against two, names the counts and both choices.
    const tie = current('Posted', [purchase('-12.00'), payment('10/15/2026', '250.00'), payment('09/15/2026', '-100.00')]);
    assert.throws(() => convert(tie, wf), (error: Error) => {
      assert.equal(error.name, 'ExportFormatError');
      assert.equal(error.message, 'the card payment rows disagree on the amount sign: 1 of 2 are credits under Wells Fargo\'s usual '
        + 'sign (charges negative) and 1 would be charges. Check a purchase in the file and re-run with --ofx-sign standard '
        + '(charges negative) or --ofx-sign inverted (charges positive)');
      return true;
    });
    const minority = current('Posted', [purchase('-12.00'), payment('10/15/2026', '250.00'), payment('09/15/2026', '-100.00'),
      payment('08/15/2026', '75.00')]);
    assert.throws(() => convert(minority, wf), /disagree on the amount sign: 2 of 3 are credits .* and 1 would be charges/);
    // Every payment row agreeing proves the usual sign, as before.
    const agreeing = current('Posted', [purchase('-12.00'), payment('10/15/2026', '250.00'), payment('09/15/2026', '100.00')]);
    assert.deepEqual(convert(agreeing, wf).payload.rows.map((row) => [row.amountMinor, row.kind]),
      [[1200, 'purchase'], [-25000, 'payment'], [-10000, 'payment']]);
    // Given a sign, each converts; payment rows that mostly contradict it are noted, as before.
    assert.equal(convert(tie, { ...wf, ofxSign: 'standard' }).payload.rows.length, 3);
    assert.deepEqual(convert(minority, { ...wf, ofxSign: 'standard' }).report.notes, []);
    assert.deepEqual(convert(minority, { ...wf, ofxSign: 'inverted' }).report.notes, ['most card payment rows would be charges under --ofx-sign inverted']);

    // The command line refuses the same way, --quiet or not: exit status 1, the reason on stderr, no JSON.
    for (const [file, reason] of [[inverted, /no card payment row in this file shows the amount sign/],
      [tie, /the card payment rows disagree on the amount sign: 1 of 2/]] as const) {
      const { io, out } = memoryIo({ 'wf.csv': file });
      assert.equal(runCardImportCli(['wf-csv', 'wf.csv', '--status', 'posted', '--quiet'], io), 1);
      assert.equal(out.stdout, '');
      assert.equal(out.written.size, 0);
      assert.match(out.stderr, /^holdr-card-import: error: /);
      assert.match(out.stderr, reason);
      assert.doesNotMatch(out.stderr, /FABRIKAM|ONLINE PAYMENT|12\.00|250\.00/);
    }
    const signed = memoryIo({ 'wf.csv': inverted });
    assert.equal(runCardImportCli(['wf-csv', 'wf.csv', '--status', 'posted', '--ofx-sign', 'inverted', '--quiet'], signed.io), 0);
    assert.equal(signed.out.stdout, asInverted.json);
  });

  it('names a column it does not know by its position only, never by its header text', () => {
    const header = 'DATE,DESCRIPTION,AMOUNT,CHECK #,STATUS,REVIEW PRIVATE OWNER NAME';
    const file = bytes([header, '10/20/2026,FABRIKAM BOOKS SEATTLE WA,-12.00,,Posted,SYNTHETIC SECRET CELL',
      '10/15/2026,ONLINE PAYMENT THANK YOU,250.00,,Posted,SYNTHETIC SECRET CELL'].join('\r\n'));
    const { json, report } = convert(file, wf);
    assert.deepEqual(report.droppedColumns, ['CHECK #', 'column 6']);
    assert.doesNotMatch(JSON.stringify(report) + json, /REVIEW|PRIVATE|OWNER|SECRET/);
    const { io, out } = memoryIo({ 'wf.csv': file });
    assert.equal(runCardImportCli(['wf-csv', 'wf.csv', '--status', 'posted'], io), 0);
    assert.match(out.stderr, /\nDropped columns: CHECK #, column 6\n/);
    assert.doesNotMatch(out.stderr, /PRIVATE|OWNER|REVIEW|SECRET/);
    // Wherever the unknown column stands, and whatever it says, only its position is named.
    const first = bytes(['SAMPLE CARDHOLDER,DATE,DESCRIPTION,AMOUNT', 'X,10/15/2026,ONLINE PAYMENT THANK YOU,250.00'].join('\n'));
    const named = convert(first, wf);
    assert.deepEqual(named.report.droppedColumns, ['column 1']);
    assert.doesNotMatch(JSON.stringify(named.report) + named.json, /SAMPLE|CARDHOLDER/);
  });

  it('is always issuer wellsfargo, has no card column and names lines, never values', () => {
    assert.throws(() => convert(current(), { ...wf, issuer: 'chase' }), /always issuer wellsfargo/);
    assert.throws(() => convert(current(), { ...wf, cards: ['1111'] }), /--card needs a card column/);
    assert.throws(() => convert(bytes('Date,Payee,Total\n10/20/2026,X 4111111111111111,1.00\n'), wf),
      (error: Error) => /does not look like a Wells Fargo CSV/.test(error.message) && !/4111/.test(error.message));
    const broken = bytes('DATE,DESCRIPTION,AMOUNT,CHECK #,STATUS\n10/20/2026,GOOD,-1.00,,Posted\n13/45/2026,BAD DATE 4111111111111111,-2.00,,Posted\n'
      + '10/21/2026,BAD AMOUNT,-1.234,,Posted\n10/22/2026,SHORT ROW\n');
    // Its one good row shows no sign, so that is refused first; given the sign, the unreadable rows are named.
    assert.throws(() => convert(broken, wf), (error: Error) => /no card payment row/.test(error.message) && !/4111|SHORT|GOOD/.test(error.message));
    try {
      convert(broken, { ...wf, ofxSign: 'standard' });
      assert.fail('expected an error');
    } catch (error) {
      assert.ok(error instanceof ConvertError);
      assert.deepEqual(error.problems.map((problem) => problem.line), [3, 4, 5]);
      assert.doesNotMatch(JSON.stringify(error.problems) + error.message, /4111|SHORT|1\.234/);
    }
  });

  it('runs from the command line', () => {
    const { io, out } = memoryIo({ 'wf.csv': current() });
    assert.equal(runCardImportCli(['wf-csv', 'wf.csv', '--status', 'posted', '--from', '2026-09-22', '--to', '2026-10-22'], io), 0);
    assertJsonSafe(out.stdout);
    assert.match(out.stderr, /wf-csv, issuer wellsfargo, USD/);
    assert.match(out.stderr, /Covers: 2026-09-22 to 2026-10-22/);
    assert.match(out.stderr, /Dropped columns: CHECK #/);
    assertNoCardData(out.stderr);
  });

  it('keys the rows two overlapping downloads share alike, so the overlap imports nothing new', () => {
    // The sign is given: the older download holds no card payment row to show it.
    const keys = (list: string[][]) => JSON.parse(convert(current('Posted', list), { ...wf, ofxSign: 'standard' }).json).rows
      .map((row: { fingerprint: string | null; externalIdHash: string | null }) => row.fingerprint ?? row.externalIdHash);
    const newer = keys(rows.slice(0, 6));
    const older = keys(rows.slice(2));
    assert.equal(older.length, 6);
    assert.deepEqual(newer.slice(2), older.slice(0, 4));
    assert.equal(new Set(older).size, older.length);
    assert.equal(convert(current(), wf).json, convert(current(), wf).json);
  });
});

describe('Bilt and Wells Fargo CSVs in one build', () => {
  // bilt.com's seven columns, in the export's order (biltCsv.ts, fixtures/bilt-activity.csv).
  const BILT_HEADER = 'Transaction Date,Posted Date,Description,Amount,Card Last 4,Name on Card,Raw Merchant Name';
  const bilt = { format: 'bilt-csv' as const, status: 'export' as const, loanPayments: 'not-spending' as const };
  const wf = { format: 'wf-csv' as const, status: 'posted' as const };
  const biltCsv = (rows: readonly string[]) => bytes(`${[BILT_HEADER, ...rows].join('\r\n')}\r\n`);
  const biltKinds = (rows: readonly string[]) => convertCardExport(biltCsv(rows), bilt).payload.rows.map((row) => [row.amountMinor, row.kind]);
  const BILT_PAYMENT = '2026-03-10,2026-03-10,Payment,-965.21,,,';

  it('converts both side by side, each always with its own issuer, and keeps every format\'s choices apart', () => {
    assert.deepEqual([...EXPORT_FORMATS], ['amex-csv', 'ofx', 'bilt-csv', 'wf-csv']);
    const fromBilt = convertCardExport(fixture('bilt-activity.csv'), bilt);
    const fromWf = convertCardExport(fixture('wf-card.csv'), wf);
    for (const result of [fromBilt, fromWf]) assertJsonSafe(result.json);
    assert.deepEqual([fromBilt.payload.source, fromBilt.payload.issuer, fromBilt.payload.rows.length], ['bilt-csv', 'bilt', 11]);
    assert.deepEqual([fromWf.payload.source, fromWf.payload.issuer, fromWf.payload.rows.length], ['wf-csv', 'wellsfargo', 8]);
    // No format loses its issuer: the two CSVs and amex-csv name theirs, ofx still needs one.
    assert.throws(() => convertCardExport(fixture('bilt-activity.csv'), { ...bilt, issuer: 'wellsfargo' }), /bilt-csv exports are always issuer bilt/);
    assert.throws(() => convertCardExport(fixture('wf-card.csv'), { ...wf, issuer: 'bilt' }), /wf-csv exports are always issuer wellsfargo/);
    assert.equal(convertCardExport(fixture('amex-basic.csv'), { format: 'amex-csv', status: 'posted' }).payload.issuer, 'amex');
    assert.throws(() => convertCardExport(fixture('statement-ofx1.ofx'), { format: 'ofx', status: 'posted' }), /--issuer must be a lowercase slug/);
    // wf-csv: posted or pending only, no --closed-through (no posted dates), no --card, no housing choice.
    assert.throws(() => convertCardExport(fixture('wf-card.csv'), { format: 'wf-csv', status: 'export' }),
      /--status export needs an export that shows each row's status \(bilt-csv\); wf-csv does not/);
    assert.throws(() => convertCardExport(fixture('wf-card.csv'), { format: 'wf-csv', closedThrough: '2026-10-15' }), /--closed-through needs every row's posted date/);
    assert.throws(() => convertCardExport(fixture('wf-card.csv'), { ...wf, cards: ['1111'] }), /--card needs a card column/);
    assert.throws(() => convertCardExport(fixture('wf-card.csv'), { ...wf, loanPayments: 'spending' }), /--loan-payments applies to bilt-csv exports only/);

    const files = { 'bilt.csv': fixture('bilt-activity.csv'), 'wf.csv': fixture('wf-card.csv') };
    const both = memoryIo(files);
    assert.equal(runCardImportCli(['bilt-csv', 'bilt.csv', '--status', 'export', '--loan-payments', 'not-spending', '--out', 'bilt.json', '--quiet'], both.io), 0);
    assert.equal(runCardImportCli(['wf-csv', 'wf.csv', '--status', 'posted', '--out', 'wf.json', '--quiet'], both.io), 0);
    assert.deepEqual([both.out.written.get('bilt.json'), both.out.written.get('wf.json')], [fromBilt.json, fromWf.json]);
    const exportStatus = memoryIo(files);
    assert.equal(runCardImportCli(['wf-csv', 'wf.csv', '--status', 'export'], exportStatus.io), 2);
    assert.match(exportStatus.out.stderr, /--status must be one of posted, pending\n/);
    const unknown = memoryIo(files);
    assert.equal(runCardImportCli(['csv', 'wf.csv'], unknown.io), 2);
    assert.match(unknown.out.stderr, /the first argument must be amex-csv, ofx, bilt-csv or wf-csv\n/);
    const help = memoryIo(files);
    assert.equal(runCardImportCli(['--help'], help.io), 0);
    for (const line of [/\n {2}bilt-csv {3}Bilt Card CSV/, /\n {2}wf-csv {5}Wells Fargo/, /amex-csv, bilt-csv and wf-csv default USD/]) {
      assert.match(help.out.stdout, line);
    }
  });

  it('let the balance-transfer rule reach the Bilt rows the export does not classify itself', () => {
    // Bilt's layout settles some kinds first (biltCsv.ts and kindOf in convert.ts): an account-level row that says
    // pay or payment, or funds a housing charge, is a payment; a housing charge takes --loan-payments. Every other
    // row is classified by its text, as for other exports. An early-March account-level credit naming a Wells
    // Fargo card in balance-transfer words is no refund:
    assert.deepEqual(biltKinds(['2026-03-02,2026-03-03,BALANCE TRANSFER WELLS FARGO,-1234.56,,,', BILT_PAYMENT]),
      [[-123456, 'other'], [-96521, 'payment']]);
    // Without such words the rule cannot tell it from a merchant's refund, so it stays one (the runbook's follow-up).
    assert.deepEqual(biltKinds(['2026-03-02,2026-03-03,WELLS FARGO CARD CREDIT,-1234.56,,,', BILT_PAYMENT]),
      [[-123456, 'refund'], [-96521, 'payment']]);
    // Payment words get the export's own payment kind before any text rule.
    assert.deepEqual(biltKinds(['2026-03-02,2026-03-03,Payment from Wells Fargo,-1234.56,,,', BILT_PAYMENT]),
      [[-123456, 'payment'], [-96521, 'payment']]);
  });

  it('read Bilt\'s Description and Raw Merchant Name apart with every wording rule, after Bilt\'s own kinds', () => {
    // bilt-csv stores the Raw Merchant Name as the description and Bilt's Description, where it says something else,
    // as the merchant; each wording rule reads the two apart, and a match in either counts.
    const cases: Array<[string, CardTransactionKind]> = [
      ['2026-03-01,2026-03-02,Northwind Grocery,42.10,1111,SAMPLE CARDHOLDER,NORTHWIND GROC 0042', 'purchase'],
      // Balance-transfer or cash-advance words in either column, either way: never a refund, never spending.
      ['2026-03-02,2026-03-03,BALANCE TRANSFER CREDIT,-1234.56,,,SYNTHETIC OLD CARD', 'other'],
      ['2026-03-03,2026-03-03,Synthetic old card,-1234.56,,,BALANCE TRANSFER CREDIT', 'other'],
      ['2026-03-04,2026-03-04,CASH ADVANCE REVERSAL,-50.00,1111,SAMPLE CARDHOLDER,SYNTHETIC ATM', 'other'],
      ['2026-03-05,2026-03-05,BALANCE TRANSFER,75.00,1111,SAMPLE CARDHOLDER,SYNTHETIC NEW CARD', 'other'],
      ['2026-03-06,2026-03-06,Synthetic transfer,75.00,1111,SAMPLE CARDHOLDER,CASH ADVANCE', 'other'],
      // A fee or interest on one keeps its kinds: the charge, and a credit that is the refund offsetting it.
      ['2026-03-07,2026-03-07,BALANCE TRANSFER FEE,10.00,,,SYNTHETIC OLD CARD', 'fee'],
      ['2026-03-07,2026-03-07,BALANCE TRANSFER FEE,-10.00,,,SYNTHETIC OLD CARD', 'refund'],
      ['2026-03-08,2026-03-08,CASH ADVANCE INTEREST,7.00,,,SYNTHETIC INTEREST', 'interest'],
      ['2026-03-08,2026-03-08,CASH ADVANCE INTEREST,-7.00,,,SYNTHETIC INTEREST', 'refund'],
      // Payment words in Bilt's Description only, on a card row (where no account-level rule applies): a payment.
      ['2026-03-09,2026-03-09,ONLINE PAYMENT - THANK YOU,-20.00,1111,SAMPLE CARDHOLDER,SYNTHETIC REMITTANCE', 'payment'],
      // Bilt's own kinds come first, as #182 (ab417e1d) gives them, whatever the other column says: an account-level
      // row whose Description says pay or payment is a payment, a housing charge takes --loan-payments, and the
      // payment that funds it is a payment.
      [BILT_PAYMENT, 'payment'],
      ['2026-03-11,2026-03-11,Payment,-100.00,,,SYNTHETIC BANK', 'payment'],
      ['2026-03-12,2026-03-12,Payment,-50.00,,,BALANCE TRANSFER', 'payment'],
      ['2026-03-13,2026-03-14,Pay card,-300.00,,,', 'payment'],
      ['2026-03-31,2026-03-31,Bilt Housing Payment,2450.00,2222,SAMPLE CARDHOLDER,BILT HOUSING', 'other'],
      ['2026-03-31,2026-03-31,Bilt Housing Payment,-2450.00,,,', 'payment'],
    ];
    const file = biltCsv(cases.map(([line]) => line));
    const { json, payload } = convertCardExport(file, bilt);
    assertJsonSafe(json);
    assert.deepEqual(payload.rows.map((row) => row.kind), cases.map(([, kind]) => kind));
    // Stored text as #182 writes it: the Raw Merchant Name as the description, Bilt's Description as the merchant.
    assert.deepEqual(payload.rows.slice(1, 4).map((row) => [row.description, row.merchant]), [
      ['SYNTHETIC OLD CARD', 'BALANCE TRANSFER CREDIT'], ['BALANCE TRANSFER CREDIT', 'Synthetic old card'], ['SYNTHETIC ATM', 'CASH ADVANCE REVERSAL']]);
    // The housing choice changes the housing charge alone; nothing but kinds is decided by the wording.
    const spending = convertCardExport(file, { ...bilt, loanPayments: 'spending' }).payload.rows;
    assert.deepEqual(spending.map((row) => row.kind), cases.map(([, kind], index) => (index === cases.length - 2 ? 'purchase' : kind)));
    const withoutKind = (rows: typeof spending) => rows.map(({ kind: _kind, ...rest }) => rest);
    assert.deepEqual(withoutKind(spending), withoutKind(payload.rows));
  });
});

describe('OFX, QFX and QBO', () => {
  const options = { format: 'ofx' as const, issuer: 'samplebank' };

  it('reads OFX 1.x SGML, OFX 2.x XML and QFX into byte-identical JSON', () => {
    const sgml = convert('statement-ofx1.ofx', options);
    assertJsonSafe(sgml.json);
    assert.equal(convert('statement-ofx2.ofx', options).json, sgml.json);
    assert.equal(convert('statement.qfx', options).json, sgml.json);
    const { payload } = sgml;
    assert.deepEqual(payload.cards, ['1111']);
    assert.deepEqual(payload.coverage, { start: '2026-09-01', end: '2026-09-30' });
    assert.equal(payload.rows[0].description, "TRADER JOE'S #123 SAN FRANCISCO CA");
    assert.equal(payload.rows[0].merchant, "TRADER JOE'S #123");
    assert.equal(payload.rows[0].transactionDate, '2026-09-04');
    assert.equal(payload.rows[0].postedDate, '2026-09-05');
    assert.equal(payload.rows[0].externalIdHash, cardExternalIdHash('2026090524692166221000123'));
    assert.deepEqual(payload.rows.map((row) => [row.amountMinor, row.kind]), [
      [4210, 'purchase'], [123456, 'purchase'], [-50000, 'payment'], [-2345, 'refund'], [3900, 'fee'], [1234, 'interest'],
    ]);
    assert.doesNotMatch(sgml.json, /SAMPLEBANK|sampleuser/);
  });

  it('honours the inverted sign convention and refuses to guess', () => {
    const inverted = new TextDecoder().decode(fixture('statement-ofx1.ofx'))
      .replace(/<TRNAMT>-/g, '<TRNAMT>MINUS').replace(/<TRNAMT>(?!MINUS)/g, '<TRNAMT>-').replace(/MINUS/g, '');
    assert.throws(() => convert(bytes(inverted), options), /--ofx-sign inverted/);
    const result = convert(bytes(inverted), { ...options, ofxSign: 'inverted' });
    assert.deepEqual(result.payload.rows.map((row) => row.amountMinor), convert('statement-ofx1.ofx', options).payload.rows.map((row) => row.amountMinor));
  });

  it('refuses DTDs, entity declarations and external entities', () => {
    const base = new TextDecoder().decode(fixture('statement-ofx2.ofx'));
    const attacks = [
      base.replace('<OFX>', '<!DOCTYPE OFX [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><OFX>').replace('Payment Thank You-Mobile', '&xxe;'),
      base.replace('<OFX>', '<!DOCTYPE lol [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><OFX>'),
      base.replace('<OFX>', '<!ENTITY x "y"><OFX>'),
      base.replace('<CURDEF>', '<!ELEMENT x ANY><CURDEF>'),
    ];
    for (const attack of attacks) assert.throws(() => convert(bytes(attack), options), /DTD or entities|markup declarations/);
  });

  it('decodes only predefined and numeric entities, then redacts what they spell', () => {
    const base = new TextDecoder().decode(fixture('statement-ofx2.ofx'));
    const pan = [...'4111111111111111'].map((digit) => `&#${digit.charCodeAt(0)};`).join('');
    const hexPan = [...'371449635398431'].map((digit) => `&#x${digit.charCodeAt(0).toString(16)};`).join('');
    const tricky = base
      .replace('Payment Thank You-Mobile', `Payment Thank You ${pan}`)
      .replace('LATE FEE', `LATE FEE &nbsp;&unknown;&#0;&#xD800; ${hexPan}`)
      .replace('AMAZON MKTPL REFUND', '<![CDATA[AMAZON <MKTPL> 5555 5555 5555 4444]]>');
    const { json, payload } = convert(bytes(tricky), options);
    assertJsonSafe(json);
    assert.match(payload.rows[2].description, /^Payment Thank You \*\*\*1111$/);
    assert.match(payload.rows[4].description, /^LATE FEE &nbsp;&unknown;&#0;&#xD800; \*\*\*8431$/);
    assert.match(payload.rows[3].description, /^AMAZON <MKTPL> \*\*\*4444/);
  });

  it('refuses truncated and malformed files', () => {
    const text = new TextDecoder().decode(fixture('statement-ofx1.ofx'));
    const cut = text.slice(0, text.indexOf('</BANKTRANLIST>'));
    assert.throws(() => convert(bytes(cut), options), /not closed|truncated/);
    assert.throws(() => convert(bytes(text.replace('</OFX>', '')), options), /not closed/);
    assert.throws(() => convert(bytes(text.slice(0, text.lastIndexOf('<'))), options), /truncated|not closed/);
    assert.throws(() => convert(bytes('just text'), options), /no <OFX> element/);
    assert.throws(() => convert(bytes(text.replace('<CURDEF>USD', '<CURDEF>dollars')), options), /CURDEF/);
    const deep = text.replace('<NAME>LATE FEE', `<NAME>LATE FEE${'<CCSTMTRS>'.repeat(80)}`);
    assert.throws(() => convert(bytes(deep), options), /nested too deeply|not closed/);
  });

  it('reports bad transactions by line, and skips them only when asked', () => {
    const text = new TextDecoder().decode(fixture('statement-ofx1.ofx'))
      .replace('<TRNAMT>-42.10', '<TRNAMT>-42.105')
      .replace('<DTPOSTED>20260910', '<DTPOSTED>20261340')
      .replace('<TRNTYPE>FEE', '<TRNTYPE>FEE\r\n<CURRENCY><CURRATE>1.1<CURSYM>EUR</CURRENCY>');
    try {
      convert(bytes(text), options);
      assert.fail('expected an error');
    } catch (error) {
      assert.ok(error instanceof ConvertError);
      assert.deepEqual(error.problems.map((problem) => problem.reason), [
        'TRNAMT has more than 2 decimal places',
        'DTPOSTED is missing or not a valid date',
        'transaction amount is in a different currency than the statement',
      ]);
      assert.ok(error.problems.every((problem) => problem.line > 20));
    }
    assert.equal(convert(bytes(text), { ...options, skipInvalid: true }).payload.rejectedCount, 3);
  });

  it('picks one card statement, and refuses bank statements', () => {
    const text = new TextDecoder().decode(fixture('statement-ofx2.ofx'));
    const start = text.indexOf('<CCSTMTTRNRS>');
    const end = text.indexOf('</CCSTMTTRNRS>') + '</CCSTMTTRNRS>'.length;
    const second = text.slice(start, end).replace('4111111111111111', '5555555555554444').replace(/<FITID>2026/g, '<FITID>X2026');
    const two = text.slice(0, end) + second + text.slice(end);
    assert.throws(() => convert(bytes(two), options), (error: Error) => /choose one with --card/.test(error.message) && /1111, 4444/.test(error.message) && !/4111111|5555555/.test(error.message));
    assert.deepEqual(convert(bytes(two), { ...options, cards: ['4444'] }).payload.cards, ['4444']);
    assert.throws(() => convert(bytes(two), { ...options, cards: ['9999'] }), /no statement/);
    const bank = text.replace(/CREDITCARDMSGSRSV1/g, 'BANKMSGSRSV1').replace(/CCSTMTTRNRS/g, 'STMTTRNRS').replace(/CCSTMTRS/g, 'STMTRS')
      .replace('<CCACCTFROM><ACCTID>4111111111111111</ACCTID></CCACCTFROM>', '<BANKACCTFROM><BANKID>1</BANKID><ACCTID>123</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>');
    assert.throws(() => convert(bytes(bank), options), /bank or investment statements/);
    const error = text.replace('<CCSTMTRS>', '<CCSTMTRSX>').replace('</CCSTMTRS>', '</CCSTMTRSX>')
      .replace('<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>\n      <CCSTMTRSX>', '<STATUS><CODE>2000</CODE><SEVERITY>ERROR</SEVERITY></STATUS>\n      <CCSTMTRSX>');
    assert.throws(() => convert(bytes(error), options), /no credit card statement|code 2000/);
  });

  it('keys transactions that share a FITID by content instead of dropping one', () => {
    const text = new TextDecoder().decode(fixture('statement-ofx1.ofx')).replace('2026091024692166221000124', '2026090524692166221000123');
    const { payload, report } = convert(bytes(text), options);
    assert.equal(payload.rows.length, 6);
    assert.equal(report.repeatedReferenceRows, 2);
    assert.ok(payload.rows[0].fingerprint && payload.rows[1].fingerprint);
  });
});

describe('per-card filtering', () => {
  const twoCards = [
    'Date,Description,Card Member,Account #,Amount',
    '09/14/2026,BLUE BOTTLE COFFEE,ALEX SAMPLE,XXXX-XXXXXX-90003,5.75',
    '09/14/2026,BLUE BOTTLE COFFEE,JORDAN SAMPLE,XXXX-XXXXXX-42003,5.75',
  ].join('\n');

  it('is refused for rows keyed by content, which would give both cards\' coffee one key', () => {
    for (const card of ['0003', '2003']) {
      assert.throws(() => convert(bytes(twoCards), { format: 'amex-csv', cards: [card] }), /--card cannot be used here: 1 row has no Reference that is unique in the whole export/);
    }
    assert.throws(() => convert('amex-detailed.csv', { format: 'amex-csv', cards: ['2003'], ignoreIds: true }), /--ignore-ids matches every row by content/);
    const repeated = new TextDecoder().decode(fixture('amex-detailed.csv')).replace("'320262570000000003'", "'320262570000000008'");
    assert.throws(() => convert(bytes(repeated), { format: 'amex-csv', cards: ['2003'] }), /2 rows have no Reference that is unique in the whole export/);
    const whole = convert(bytes(twoCards), { format: 'amex-csv' }).payload;
    assert.equal(whole.rows.length, 2);
    assert.notEqual(whole.rows[0].fingerprint, whole.rows[1].fingerprint);
    const { io, out } = memoryIo({ 'x.csv': bytes(twoCards) });
    assert.equal(runCardImportCli(['amex-csv', 'x.csv', '--status', 'posted', '--card', '0003', '--out', 'x.json'], io), 1);
    assert.equal(out.written.size, 0);
    assert.match(out.stderr, /Import the whole export into its billing account without --card/);
  });

  it('is refused when a reference repeats on a card that is filtered out', () => {
    const csv = [
      'Date,Description,Card Member,Account #,Amount,Reference',
      '09/14/2026,COFFEE,ALEX SAMPLE,XXXX-XXXXXX-40002,5.00,SAME-REF',
      '09/14/2026,COFFEE,JORDAN SAMPLE,XXXX-XXXXXX-40003,5.00,SAME-REF',
      '09/15/2026,BAGEL,ALEX SAMPLE,XXXX-XXXXXX-40002,3.00,OWN-REF',
    ].join('\n');
    // Each card's subset sees SAME-REF once; uniqueness is judged on the whole export.
    for (const card of ['0002', '0003']) {
      assert.throws(() => convert(bytes(csv), { format: 'amex-csv', cards: [card] }), /1 row has no Reference that is unique in the whole export/);
    }
    const whole = convert(bytes(csv), { format: 'amex-csv' });
    assert.equal(whole.payload.rows.length, 3);
    assert.equal(whole.report.repeatedReferenceRows, 2);
    assert.ok(whole.payload.rows[0].fingerprint && whole.payload.rows[1].fingerprint);
    assert.notEqual(whole.payload.rows[0].fingerprint, whole.payload.rows[1].fingerprint);
  });

  it('is allowed when every kept row has its own reference', () => {
    assert.equal(convert('amex-detailed.csv', { format: 'amex-csv', cards: ['2003'] }).payload.rows.length, 2);
  });
});

describe('long numbers in free text', () => {
  // The shared span rule (Phase 1, guard revision 4) counts a card-length run of digits, masks and
  // separators showing more than four digits as card data, so long references, IBANs and masked
  // numbers are shortened to *** plus their last four before they leave the tool (deliberate
  // over-redaction). Ordinary merchant text, phone numbers, dates and amounts stay as they are.
  const flagged = ['PAYMENT REF 123456789012345', 'IBAN GB29 NWBK 6016 1331 9268 19', '5018 ****0009', 'INV 4111 1111 1111 111', 'XXXX-90003'];
  const ordinary = ['UBER *TRIP 8005928996 CA', 'AMAZON MKTP US*2K4 #1234', 'PAID 09/14/2026 12.50 USD', 'ORDER 2026-09-14 AMT 1,234.56'];
  // Whatever the shared detector decides for this one, the tool and the API agree with it.
  const either = ['CALL 1-800-555-0199 EXT 12345'];

  it('are redacted in descriptions and categories, and ordinary text is kept', () => {
    const samples = [...flagged, ...ordinary, ...either];
    const csv = ['Date,Description,Amount,Category', ...samples.map((text, index) =>
      `09/${10 + index}/2026,"${text}",${index + 1}.00,"${index % 2 === 0 ? text : 'Other'}"`)].join('\n');
    const { json, payload, report } = convert(bytes(csv), { format: 'amex-csv' });
    assertJsonSafe(json);
    samples.forEach((text, index) => {
      const row = payload.rows[index];
      for (const stored of [row.description, row.issuerCategory ?? '']) assert.equal(containsCardData(stored), false, text);
      if (flagged.includes(text)) {
        assert.equal(containsCardData(text), true, `${text} is card data under the span rule`);
        assert.notEqual(row.description, text);
        assert.match(row.description, /\*\*\*/);
      } else if (!containsCardData(text)) {
        assert.equal(row.description, text);
      }
    });
    assert.equal(report.redactedRows, samples.filter((text) => containsCardData(text)).length);
  });

  it('are redacted in OFX names and memos', () => {
    const text = new TextDecoder().decode(fixture('statement-ofx1.ofx'))
      .replace('<NAME>LATE FEE', '<NAME>PAYMENT REF 123456789012345')
      .replace('<MEMO>SAN FRANCISCO CA', '<MEMO>IBAN GB29 NWBK 6016 1331 9268 19');
    const { json, payload } = convert(bytes(text), { format: 'ofx', issuer: 'samplebank' });
    assertJsonSafe(json);
    assert.doesNotMatch(json, /123456789012345|6016 1331/);
    for (const row of payload.rows) for (const stored of [row.description, row.merchant ?? '']) assert.equal(containsCardData(stored), false);
  });
});

describe('text longer than its stored limit', () => {
  // Text is normalized and redacted whole before it is cut to its limit (description 500, merchant
  // 200), so no cut can leave a card number's prefix behind. OFX joins NAME and MEMO first.
  const PAN = '4012888888881881';
  const ofxWith = (name: string, memo: string) => bytes(new TextDecoder().decode(fixture('statement-ofx2.ofx'))
    .replace('<ACCTID>4111111111111111', '<ACCTID>XXXX-1881')
    .replace('<NAME>TRADER JOE&apos;S #123', `<NAME>${name}`)
    .replace('<MEMO>SAN FRANCISCO CA', `<MEMO>${memo}`));
  /** At most the last four digits of PAN survive, in any field of the changed row and in the JSON as a whole. */
  function assertPanHidden(json: string): void {
    assertJsonSafe(json);
    const row = JSON.parse(json).rows[0];
    for (const field of ['description', 'merchant', 'issuerCategory']) {
      const digits = (row[field] ?? '').replace(/\D/g, '');
      for (let i = 0; i + 5 <= PAN.length; i += 1) assert.ok(!digits.includes(PAN.slice(i, i + 5)), `${field} shows five digits of the card number`);
      if (row[field] !== null) assert.equal(containsCardData(row[field]), false);
    }
    for (let i = 0; i + 5 <= PAN.length; i += 1) assert.ok(!json.includes(PAN.slice(i, i + 5)));
  }

  it('redacts NAME and MEMO joined before the cut, even when the padding vanishes in normalization', () => {
    // The reported case: 19,987 zero-width spaces push the joined description past 20,000 characters.
    const name = '\u200b'.repeat(19_987);
    assert.equal(`${name} ${PAN}`.length, 20_004);
    const { io, out } = memoryIo({ 'x.ofx': ofxWith(name, PAN) });
    assert.equal(runCardImportCli(['ofx', 'x.ofx', '--issuer', 'samplebank', '--status', 'posted'], io), 0);
    assertPanHidden(out.stdout);
    const payload = JSON.parse(out.stdout);
    assert.deepEqual(payload.cards, ['1881']);
    assert.equal(payload.rows[0].description, '***1881');
    assert.equal(payload.rows[0].merchant, null);
    assertNoCardData(out.stderr);
  });

  it('cuts only redacted text when the padding survives normalization', () => {
    const cases: Array<[string, string]> = [
      ['A'.repeat(19_987), 'A'.repeat(500)],
      ['A'.repeat(490), `${'A'.repeat(490)} ***1881`],
      // A cut at 500 before redaction would keep 4012 8888 8; after it, only the last four can show.
      ['A'.repeat(495), `${'A'.repeat(495)} ***1`],
      // NAME's trailing space and the joining space collapse into one.
      ['AB '.repeat(165), `${'AB '.repeat(165)}***18`],
      // Spaces collapse only after the 20,000th character: a cut there would have kept 401288888888.
      [`SHOP${' '.repeat(19_981)}AT`, 'SHOP AT ***1881'],
    ];
    for (const [name, description] of cases) {
      const { json, payload } = convert(ofxWith(name, PAN), { format: 'ofx', issuer: 'samplebank' });
      assertPanHidden(json);
      assert.equal(payload.rows[0].description, description);
      assert.ok(payload.rows[0].merchant!.length <= 200);
    }
  });

  it('keeps a card number that straddles NAME and MEMO out of the description and the merchant', () => {
    const cases: Array<[string, string]> = [
      ['SHOP 4012 8888', '8888 1881 REF'],
      ['SHOP 40128888', '88881881'],
      ['SHOP 4012\u200b8888', '88881881'],
      ['SHOP 4012\u00ad', '8888 8888 1881'],
      ['SHOP ４０１２ ８８８８', '8888 1881'],
      ['SHOP 4012 8888', 'SHOP 4012 8888 8888 1881'],
    ];
    for (const [name, memo] of cases) {
      const { json, payload } = convert(ofxWith(name, memo), { format: 'ofx', issuer: 'samplebank' });
      assertPanHidden(json);
      assert.match(payload.rows[0].description, /^SHOP \*\*\*1881( REF)?$/);
      assert.equal(payload.rows[0].merchant, 'SHOP');
    }
    // Ordinary names are the merchant unchanged.
    assert.equal(convert(ofxWith('SHOP #4012', 'STORE 88'), { format: 'ofx', issuer: 'samplebank' }).payload.rows[0].merchant, 'SHOP #4012');
  });

  it('refuses values longer than the parsers take, without printing them', () => {
    const csv = `Date,Description,Amount\n09/14/2026,${'A'.repeat(10_000)}${PAN},1.00\n`;
    const files = { 'x.ofx': ofxWith(`${'A'.repeat(19_990)}${PAN}`, 'MEMO'), 'x.csv': bytes(csv) };
    for (const args of [['ofx', 'x.ofx', '--issuer', 'samplebank', '--status', 'posted', '--out', 'x.json', '--skip-invalid'], ['amex-csv', 'x.csv', '--status', 'posted', '--out', 'x.json', '--skip-invalid']]) {
      const { io, out } = memoryIo(files);
      assert.equal(runCardImportCli(args, io), 1);
      assert.equal(out.written.size, 0);
      assert.equal(out.stdout, '');
      assert.match(out.stderr, /longer than (20000|10000) characters/);
      for (let i = 0; i + 5 <= PAN.length; i += 1) assert.ok(!out.stderr.includes(PAN.slice(i, i + 5)));
      assert.doesNotMatch(out.stderr, /AAAA/);
    }
  });
});

describe('NAME and MEMO that repeat each other', () => {
  // Overlap is decided on what NAME and MEMO say once normalized, so a NAME that MEMO repeats with other
  // spacing, invisible or full-width characters, separators or case is not joined in again: its shortened
  // copy of a card number would survive redaction beside the redacted number and rebuild it.
  const PAN = '4012888888881881';
  const options = { format: 'ofx' as const, issuer: 'samplebank' };
  const ofxWith = (name: string, memo: string) => bytes(new TextDecoder().decode(fixture('statement-ofx2.ofx'))
    .replace('<ACCTID>4111111111111111', '<ACCTID>XXXX-1881')
    .replace('<NAME>TRADER JOE&apos;S #123', `<NAME>${name}`)
    .replace('<MEMO>SAN FRANCISCO CA', `<MEMO>${memo}`));
  /**
   * No five digits of PAN in the JSON, nor in any stored field or the fields read together in any
   * order, digits only, with just the four digits each `***1881` keeps left out.
   */
  function assertPanHidden(json: string): void {
    assertJsonSafe(json);
    for (let i = 0; i + 5 <= PAN.length; i += 1) assert.ok(!json.includes(PAN.slice(i, i + 5)));
    for (const row of JSON.parse(json).rows) {
      const [d, m, c] = [row.description, row.merchant ?? '', row.issuerCategory ?? '']
        .map((text: string) => text.replace(/\*\*\*[0-9]{4}(?![0-9])/g, '').replace(/\D/g, ''));
      for (const digits of [d, m, c, d + m, m + d, d + c, c + d, m + c, c + m, d + m + c, d + c + m, m + d + c, m + c + d, c + d + m, c + m + d]) {
        for (let i = 0; i + 5 <= PAN.length; i += 1) assert.ok(!digits.includes(PAN.slice(i, i + 5)), 'shows five digits of the card number');
      }
    }
  }

  it('keep one copy of a NAME that MEMO repeats written differently, or that repeats MEMO', () => {
    const cases: Array<[string, string, string, string]> = [
      // The reported case: MEMO repeats NAME with a double space.
      ['SHOP 4012 8888 8888', 'SHOP 4012  8888 8888 1881', 'SHOP ***1881', 'SHOP'],
      ['SHOP 4012 8888 8888', 'SHOP 4012\u200b 8888 8888 1881', 'SHOP ***1881', 'SHOP'],
      ['SHOP 4012\u200b8888 8888', 'SHOP 4012 8888 8888 1881', 'SHOP ***1881', 'SHOP'],
      ['SHOP 4012 8888 8888', 'ＳＨＯＰ ４０１２ ８８８８ ８８８８ １８８１', 'SHOP ***1881', 'SHOP'],
      ['Shop 4012 8888 8888', 'SHOP 4012 8888 8888 1881', 'SHOP ***1881', 'SHOP'],
      ['SHOP 4012-8888-8888', 'SHOP 4012 8888 8888 1881', 'SHOP ***1881', 'SHOP'],
      // MEMO a superset of NAME, NAME in its middle.
      ['SHOP 4012 8888 8888', 'PURCHASE AT SHOP 4012 8888 8888 1881 CA', 'PURCHASE AT SHOP ***1881 CA', 'SHOP'],
      // MEMO a suffix of NAME.
      ['SHOP 4012 8888 8888 1881', '8888  8888 1881', 'SHOP ***1881', 'SHOP ***1881'],
      // Ordinary text that repeats: one copy, merchant from the description.
      ['UBER', 'TRIP HELP.UBER.COM', 'TRIP HELP.UBER.COM', 'UBER'],
      ['SHELL OIL', 'Shell Oil 57442 Austin TX', 'Shell Oil 57442 Austin TX', 'Shell Oil'],
    ];
    for (const [name, memo, description, merchant] of cases) {
      const { json, payload } = convert(ofxWith(name, memo), options);
      assertPanHidden(json);
      assert.deepEqual([payload.rows[0].description, payload.rows[0].merchant], [description, merchant], `${name} / ${memo}`);
    }
    const { io, out } = memoryIo({ 'x.ofx': ofxWith('SHOP 4012 8888 8888', 'SHOP 4012  8888 8888 1881') });
    assert.equal(runCardImportCli(['ofx', 'x.ofx', '--issuer', 'samplebank', '--status', 'posted'], io), 0);
    assertPanHidden(out.stdout);
    assertNoCardData(out.stderr);
  });

  it('refuse, as a check apart from the join, a row whose stored text would still show card digits', () => {
    const reason = 'its text would show more than the last four digits of a card number in this row '
      + '(a repeated or shortened copy); remove the number from the export';
    const amex = (rows: string[]) => bytes(['Date,Description,Amount,Category,Account #', ...rows].join('\n'));
    const exports: Array<[string, Uint8Array, Partial<ConvertOptions> & Pick<ConvertOptions, 'format'>, number]> = [
      // NAME and MEMO say different things, so they are joined, and NAME's 12 digits would stay.
      ['joined', ofxWith('PAYMENT 4012 8888 8888', `CARD ${PAN}`), options, 22],
      // MEMO holds the number twice, once shortened.
      ['repeated in MEMO', ofxWith('SHOP', `CARD ${PAN} REF 4012 8888 8888`), options, 22],
      // Across fields: the number in the description, its first 12 digits as the category.
      ['across fields', amex([`09/14/2026,HOTEL ${PAN},10.00,4012 8888 8888,XXXX-XXXXXX-90003`, '09/15/2026,COFFEE,5.00,Dining,XXXX-XXXXXX-90003']), { format: 'amex-csv' }, 2],
      // From another raw field: a full card number as Account #.
      ['from Account #', amex([`09/14/2026,PAYMENT 4012 8888 8888,10.00,Other,${PAN}`, `09/15/2026,COFFEE,5.00,Dining,${PAN}`]), { format: 'amex-csv' }, 2],
      // The shortened copy's groups between extra copies of the number, which redaction leaves as ***1881.
      ['between redactions', amex([
        `09/14/2026,ALPHA 4012 BRAVO ${PAN} CHARLIE 8888 DELTA ${PAN} ECHO 8888,10.00,Other,${PAN}`, `09/15/2026,COFFEE,5.00,Dining,${PAN}`,
      ]), { format: 'amex-csv' }, 2],
      // Across fields, with a redaction in each: each shows four digits, together they show eight.
      ['across fields between redactions', amex([
        `09/14/2026,ALPHA 4012 BRAVO ${PAN} CHARLIE,10.00,${PAN} DELTA 8888,${PAN}`, `09/15/2026,COFFEE,5.00,Dining,${PAN}`,
      ]), { format: 'amex-csv' }, 2],
      // Groups split by control characters, which storage reads as spaces.
      ['control characters', amex([
        `09/14/2026,"PAY 4012\u00018888\u00018888\u00011881 REF 4012 8888 8888",10.00,Other,XXXX-XXXXXX-90003`, '09/15/2026,COFFEE,5.00,Dining,XXXX-XXXXXX-90003',
      ]), { format: 'amex-csv' }, 2],
    ];
    for (const [label, file, opts, line] of exports) {
      try {
        convert(file, opts);
        assert.fail(`expected ${label} to be refused`);
      } catch (error) {
        assert.ok(error instanceof ConvertError, label);
        assert.deepEqual(error.problems, [{ line, reason }], label);
        assert.match(error.message, /^1 row cannot be imported$/);
      }
      const { json, payload, report } = convert(file, { ...opts, skipInvalid: true });
      assertPanHidden(json);
      assert.equal(payload.rejectedCount, 1, label);
      assert.deepEqual(report.rejected, [{ line, reason }], label);
      assert.ok(payload.rows.length >= 1, label);
    }
    // Store numbers and amounts beside a redacted number are not the card's digits.
    const clean = convert(amex([
      `09/14/2026,STORE #204 PAID 12.50 CARD ${PAN},12.50,Other,${PAN}`, `09/15/2026,STORE #204 CARD ${PAN} PAID 12.50,12.50,Other,${PAN}`,
    ]), { format: 'amex-csv' });
    assertPanHidden(clean.json);
    assert.deepEqual(clean.payload.rows.map((row) => row.description), ['STORE #204 PAID 12.50 CARD ***1881', 'STORE #204 CARD ***1881 PAID 12.50']);
    const { io, out } = memoryIo({ 'x.ofx': ofxWith('PAYMENT 4012 8888 8888', `CARD ${PAN}`) });
    assert.equal(runCardImportCli(['ofx', 'x.ofx', '--issuer', 'samplebank', '--status', 'posted', '--out', 'x.json'], io), 1);
    assert.equal(out.written.size, 0);
    assert.match(out.stderr, /line 22: its text would show more than the last four digits of a card number/);
    for (let i = 0; i + 5 <= PAN.length; i += 1) assert.ok(!out.stderr.includes(PAN.slice(i, i + 5)));
    assert.doesNotMatch(out.stderr, /PAYMENT|CARD 4/);
  });
});

describe('card secrets', () => {
  it('refuse the conversion, naming the line and field but never the value, even with --skip-invalid', () => {
    const csv = [
      'Date,Description,Amount,Category',
      '09/14/2026,EXPEDIA 12/29 PINTEREST,1.00,Travel',
      '09/15/2026,CVV 123; expiry 12/29,2.00,Other',
      '09/16/2026,SHOP,3.00,PIN 2468',
    ].join('\n');
    for (const skipInvalid of [false, true]) {
      try {
        convert(bytes(csv), { format: 'amex-csv', skipInvalid });
        assert.fail('expected an error');
      } catch (error) {
        assert.ok(error instanceof ConvertError);
        assert.deepEqual(error.problems.map((problem) => [problem.line, problem.reason.split(' ')[0]]), [[3, 'description'], [4, 'issuerCategory']]);
        assert.match(error.message, /2 rows cannot be imported/);
        assert.doesNotMatch(error.message + JSON.stringify(error.problems), /123|2468|12\/29|CVV/);
      }
    }
    const { io, out } = memoryIo({ 'x.csv': bytes(csv) });
    assert.equal(runCardImportCli(['amex-csv', 'x.csv', '--status', 'posted', '--out', 'x.json'], io), 1);
    assert.equal(out.written.size, 0);
    assert.match(out.stderr, /line 3: description must not contain a card security code, PIN or expiry date; remove it from the export/);
    assert.doesNotMatch(out.stderr, /123|2468|12\/29/);
  });

  it('are refused in OFX names and memos too', () => {
    const text = new TextDecoder().decode(fixture('statement-ofx1.ofx')).replace('<MEMO>SAN FRANCISCO CA', '<MEMO>cvv: 321');
    assert.throws(() => convert(bytes(text), { format: 'ofx', issuer: 'samplebank' }),
      (error: Error) => error instanceof ConvertError && /description must not contain a card security code/.test(JSON.stringify(error.problems)));
  });
});

describe('statement totals', () => {
  it('matches statement figures and uses the OFX ledger balance only when it is as of the end of the statement', () => {
    const ofx = { format: 'ofx' as const, issuer: 'samplebank' };
    const match = convert('statement-ofx1.ofx', { ...ofx, expected: { previousBalance: '1,195.45', charges: '1328.00', credits: '523.45', net: '804.55' } });
    assert.equal(match.report.reconciliation.status, 'match');
    assert.equal(match.report.ledgerUsedAsNewBalance, true);
    assert.deepEqual(match.payload.statement, {
      chargesMinor: 132800, creditsMinor: -52345, netMinor: 80455, previousBalanceMinor: 119545, newBalanceMinor: 200000,
    });
    const mismatch = convert('statement-ofx1.ofx', { ...ofx, expected: { previousBalance: '1,000.00' } });
    assert.equal(mismatch.report.reconciliation.status, 'mismatch');
    assert.equal(mismatch.report.reconciliation.checks[0].differenceMinor, -19545);
    assert.throws(
      () => convert('statement-ofx1.ofx', { ...ofx, coverage: { start: '2026-09-01', end: '2026-10-05' }, expected: { previousBalance: '1195.45' } }),
      /not as of the end/,
    );
    assert.throws(() => convert('amex-basic.csv', { format: 'amex-csv', expected: { newBalance: '1.00' } }), /needs --expect-previous-balance/);
    assert.throws(() => convert('amex-basic.csv', { format: 'amex-csv', expected: { net: 'about 5' } }), /--expect-net is not a number/);
  });
});

describe('statement periods that have not closed', () => {
  // An export of a period that has not closed can hold authorizations that are later cancelled; written
  // as posted they would count as spending for good. Nothing in an export proves its statement closed, so
  // every conversion states the status; an OFX file's own dates, compared in one time zone, only warn
  // about --status posted and bound --closed-through.
  const ofx = { format: 'ofx' as const, issuer: 'samplebank' };
  const open = () => new TextDecoder().decode(fixture('statement-open.qfx'));
  const digest = (json: string) => toLetterHex(sha256(new TextEncoder().encode(json)));
  const statusesOf = (json: string): string[] => JSON.parse(json).rows.map((row: { status: string }) => row.status);
  const keysOf = (json: string): string[] => JSON.parse(json).rows.map((row: { externalIdHash: string | null; fingerprint: string | null }) =>
    row.externalIdHash ?? row.fingerprint);
  const choices = [/--status posted/, /--status pending/, /--closed-through YYYY-MM-DD/];
  const tag = (name: string, value: string | null | undefined) => (value === null || value === undefined ? '' : `<${name}>${value}</${name}>`);
  interface SyntheticRow { posted: string | null; user?: string; amount?: string; name?: string; id?: string }
  /** A synthetic OFX 2 card statement: when it was made, where its list ends, its rows and its ledger balance. */
  function statementFile(parts: {
    made?: string | null; end?: string | null; rows?: SyntheticRow[]; account?: string; ledger?: { amount: string; asOf: string };
  } = {}): Uint8Array {
    const { made = '20261017093000[-4:EDT]', end = '20261017093000[-4:EDT]', account = 'XXXX-1111' } = parts;
    const rows = parts.rows ?? [{ posted: '20261016120000[-4:EDT]', amount: '-16250.00', name: 'CONTOSO ORDER', id: 'SYN-ORDER' }];
    return bytes([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
      `${tag('DTSERVER', made)}<LANGUAGE>ENG</LANGUAGE></SONRS></SIGNONMSGSRSV1>`,
      '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><CCSTMTRS>',
      `<CURDEF>USD</CURDEF><CCACCTFROM><ACCTID>${account}</ACCTID></CCACCTFROM>`,
      `<BANKTRANLIST>${tag('DTSTART', '20260916000000[-4:EDT]')}${tag('DTEND', end)}`,
      ...rows.map((row) => `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE>${tag('DTPOSTED', row.posted)}${tag('DTUSER', row.user)}`
        + `<TRNAMT>${row.amount ?? '-10.00'}</TRNAMT>${tag('FITID', row.id)}<NAME>${row.name ?? 'SAMPLE SHOP'}</NAME></STMTTRN>`),
      '</BANKTRANLIST>',
      parts.ledger ? `<LEDGERBAL><BALAMT>${parts.ledger.amount}</BALAMT><DTASOF>${parts.ledger.asOf}</DTASOF></LEDGERBAL>` : '',
      '</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
    ].join('\n'));
  }
  const openWarning = (reaches: string, made: string) => `--status posted, but this export may include a statement period that has `
    + `not closed: its dates run to ${reaches}, on or after the day it was made (${made}). Every row is written as posted on your `
    + 'word; if that period had not closed, its charges can still change or be cancelled: convert the export again with '
    + '--status pending or --closed-through';
  // The current period's activity, then its statement once closed: the order's authorization
  // (CONTOSO) was cancelled and never posted, and the bistro charge has no reference.
  const header = 'Date,Description,Amount,Reference,Category';
  const currentPeriod = bytes([header,
    "10/16/2026,NORTHWIND GROCERY,42.10,'AXP-1001',Merchandise & Supplies-Groceries",
    '10/17/2026,PROSEWARE BISTRO,18.50,,Restaurant-Restaurant',
    "10/18/2026,CONTOSO SUPERSTORE ORDER,\"16,250.00\",'AXP-1003',Merchandise & Supplies-Internet Purchase",
    "10/19/2026,FABRIKAM BOOKS,12.00,'AXP-1004',Merchandise & Supplies-Book Stores",
  ].join('\n'));
  const closedStatement = bytes([header,
    "10/16/2026,NORTHWIND GROCERY,42.10,'AXP-1001',Merchandise & Supplies-Groceries",
    '10/17/2026,PROSEWARE BISTRO,18.50,,Restaurant-Restaurant',
    "10/19/2026,FABRIKAM BOOKS,12.00,'AXP-1004',Merchandise & Supplies-Book Stores",
    "11/02/2026,TAILSPIN TOYS,30.00,'AXP-0003',Merchandise & Supplies-Toy Stores",
  ].join('\n'));

  it('leave a closed statement byte for byte as holdr-card-import 1.0.3 writes it, and as 1.0.2, 1.0.1 and 1.0.0 wrote it but for parserVersion', () => {
    // Digests of the JSON this version writes (the third column). Changing any of them needs a new
    // CARD_IMPORT_TOOL_VERSION: the same version must write the same bytes. 1.0.3 changed kinds only (payment wording
    // beside a fee word: a fee for a payment, or a fee given back), and so did 1.0.2 (a charge worded as a payment is one
    // only with return or reversal wording) and 1.0.1 (credits the balance-transfer rule matches, and Bilt's Description
    // read beside its Raw Merchant Name). None of these rows is one, so with parserVersion written back each is byte for
    // byte what 1.0.2 wrote (the fourth column), what 1.0.1 wrote (the fifth: #184's head, a978fff6) and what 1.0.0
    // wrote (the sixth: main's tool for amex-csv and ofx, #182's (ab417e1d) for bilt-csv, #184's before 1.0.1
    // (bb6d99fa) for wf-csv).
    const members = [{ name: 'ALEX SAMPLE', owner: 'casey' as const }, { name: 'JORDAN SAMPLE', owner: 'alex' as const }];
    const sameOfx = ['mpgiabiminhlonlchbkeelofcmglpklpddahcgojkacdichakaikmaemadhgpfjb', 'ldcflmmammealecaomnjoeffppbggdinbnjjekccjafifmcaphkjdccnkihgjnob',
      'hihadpchbebbcopchgckkbchkndmmjkhkiajfnnmnllmdfongglglogmnlogbmfj', 'hjipmnoebhphcagahojckjjahjeckpcieggfiiapaacakaihbdhkpabmdckhhiab'] as const;
    const pinned: Array<[string, Partial<ConvertOptions> & Pick<ConvertOptions, 'format'>, string, string, string, string]> = [
      ['amex-basic.csv', { format: 'amex-csv' }, 'eeoddgnndcgidfakmfbanjgbakffcbgflcnpiapoepkpjiccpcmghgboaklmgdgk',
        'odibfbnlhahpahijehheeoaoimekckemabkbhglkobdoceoiaoncfbildgfhphid', 'lmhhokbambjbeoppcmlgjkafnhelpccgogdoicabacjicgjocbipcioodicflboa',
        'cleepapelbeamgkdnlbondpkdiebhmkjjejpjmmfpikplejkoajikpcljkjgahgi'],
      ['amex-basic.csv', { format: 'amex-csv', coverage: { start: '2026-09-01', end: '2026-09-30' } }, 'hjkkbhecjmphijbcgnpfdcpnopkhbfpinpmimigdfkbmkgljjobmdapigmpofbbd',
        'icjflelfbknhflhbocdbimebofcbdgcdcldangpfncamlagplpjcnchadhpagpag', 'pgaiigfagjefcgnpbicndmgfpibgmahmclknmicjmcicenndcdfjmfbomjicocai',
        'flmalaoedfjadnhfnpfpgppedimfnbcgihmkbehplfhlcllgfcmbmlfppgcfmdel'],
      ['amex-detailed.csv', { format: 'amex-csv' }, 'ganfhbcfiodihdkhbffnnhidbeejaokopnglknjjmembmlfbpihjnnpegompeekk',
        'bbjcclgcpimbnpokignamnkojaodogomoaegafjoogifimlnolndkadfnklffjlg', 'encnllkcjahhhgfmllbicaaphnfanaeafnogeekkkjedfokkhbipncocbeehahdg',
        'anegcedgjihjbbecbgnmpekecdbakobmaeeigejlpiohkhlgicdahjpjnmeopkef'],
      ['amex-detailed.csv', { format: 'amex-csv', members }, 'mljjglnkhccfhbkplkmklablmipncdggkebnagefgoognflmbnilchoonldhcbml',
        'egkaaeafdlabamkcnioidcfpifdoedfglbhkkjpkgjiknoogooklkkfojiinpiml', 'kgemojlkgpbljnegflgnomlioegbjgbpkpjacgoabcgffpiemkmaijfemdnhhpnp',
        'gleaabficbokdloiankafociclkkjjgjdjbldhhgglpghmkklghjojcicmmkdhln'],
      ['amex-detailed.csv', { format: 'amex-csv', cards: ['2003'] }, 'ldmgkgphaoljfdkibpdhodfffcbcnciphlfmofpkgfhlhinjolehaopponmgnmgb',
        'pclmkehooonoihbpfhenmjhmimefloonghpacnjicipdofagcfaciikabbjncenm', 'hggmigoomdjkkdhcihdigkfcmikkaoanacnbaffgmkeeenlcdohfaffpeogbnelh',
        'aponmglfoodndedodkmnijdcopjfhlgdkahgicheakcdebfpdmnongmbihmbnifc'],
      ['statement-ofx1.ofx', ofx, ...sameOfx],
      ['statement-ofx2.ofx', ofx, ...sameOfx],
      ['statement.qfx', ofx, ...sameOfx],
      ['statement.qfx', { ...ofx, expected: { previousBalance: '1195.45' } }, 'npnmiieomgmhnflbbjjafcimoofdakikdnkphbghiidhoellgifcjedapankaimd',
        'baeoeahfdcgnbclbnpdaifokfgnbakgjojbicgkifhjaikchfgcnikolpafikhjp', 'dbbeplnimmccjbcebejfeiobdclkfjdidbcjpmklpfdhelobblcmmeiicnpokgbg',
        'dbdmlkjdlladbpncgnmcbeofhoihjkdigjkkfgplcchlnknklljccmbdboekpejj'],
      ['statement-ofx1.ofx', { ...ofx, expected: { previousBalance: '1,195.45', charges: '1328.00', credits: '523.45', net: '804.55' } },
        'ncnljklhcfdhkclomnehecbgbcbgijohnmcpiilcfcdjdafccahobpegifppcnga', 'hegepefdabnflnciadogamdnblcjfjimnafdeeblonjhloniglfjdpdkohcpmikj',
        'dmnjafdbphmcigkigpkkefkgkpgmmiopnghicllfdeaclokmbdjjnkhogheonnlp', 'gegojdcdchhelclonpipjdhpjpbmfpehpccbcljhkkcnjiaoimahicanaimjcjeb'],
      ['bilt-activity.csv', { format: 'bilt-csv', loanPayments: 'not-spending' }, 'mopbdaplompmgfhimlfhkbeegbafnciedhbabhdmfjljibimhffcjmfhbcmholpb',
        'fnkedbpmmpgnpdbagjgjpmdcmciploeacklfheifpblbjecimjocomabfafihfoe', 'iegekedanjmobbaaikchabkfjmkanmmonfnkhpjihbpjiggapljmdpjgjoefbkeg',
        'hlgihbmkofeidffglkaechefodkgpnljgpghkgbopplffmdgknfnmpdjipkcjpdi'],
      ['bilt-activity.csv', { format: 'bilt-csv', loanPayments: 'spending' }, 'dfoohnelljbebipibmcpjpighfgjacijjdnfojofbjlffjdikajekdngadnaccjd',
        'bencgmngepnmjjjcjbplehmdapmhkpmhffjknagilpmmoonhdhjcgdipckchhfdi', 'jhcnmkpgigbhfapnnhiooihmkjhgognmegglddfbhfpiijajfldhjnnphfamfofl',
        'dofdgldpfagbmjbcclmgpfjbjdfbphbilogfdjmelbocbmmhofbiofbaobbelaea'],
      ['wf-card.csv', { format: 'wf-csv' }, 'picjmhmmjkejdldkbiehinheenoakidghgnhhngoanjlpfjbiddbhgcakgcaokkd',
        'mejiagnbngdejkhbjmcgogididbfbfpcnokgjadhaepniohajioilmegiofkakac', 'eldbbpejlmaephkdhpbiknkpbbegpnfjmcdmmnfaooihikcddeoakkpfadckdbic',
        'mpoffjmdogdbmbcbbmehimbjdponngjfabjealcdcepnagjfioaflpfneofkomdk'],
      ['wf-card.csv', { format: 'wf-csv', coverage: { start: '2026-09-22', end: '2026-10-22' } }, 'bpljbekeejbdkkmojjjohibkjcflbebiadbgbpfiblnnpgbdnmgfebbcfelifjpb',
        'bhmapiikfbmkfhfkkkademjblhhejllibgbehilknljjfbjcchllhhjbbaninnlh', 'hpjiaajcpfcelgiacmfdofoombncnpkehhpdngilncliibheeeojecbnbkkpnolo',
        'ngenfnnkdclfblhphdjcklaojbalijocodclfanlnomajbbcgngnclnaklgdkjid'],
    ];
    const written = '"parserVersion": "holdr-card-import@1.0.3"';
    for (const [file, options, expected, v102, v101, v100] of pinned) {
      const label = `${file} ${JSON.stringify(options)}`;
      const result = convert(file, { ...options, status: 'posted' });
      assert.equal(digest(result.json), expected, label);
      // parserVersion is the only place the version is written, once.
      assert.equal(result.json.split(written).length, 2, label);
      assert.equal(digest(result.json.replace(written, '"parserVersion": "holdr-card-import@1.0.2"')), v102, label);
      assert.equal(digest(result.json.replace(written, '"parserVersion": "holdr-card-import@1.0.1"')), v101, label);
      assert.equal(digest(result.json.replace(written, '"parserVersion": "holdr-card-import@1.0.0"')), v100, label);
      assert.deepEqual(new Set(statusesOf(result.json)), new Set(['posted']), label);
      assert.equal(result.payload.totals.pending.count, 0, label);
      assert.deepEqual(result.report.pendingByMonth, [], label);
      assert.deepEqual([result.report.status.basis, result.report.status.status], ['status', 'posted'], label);
      // These closed statements say nothing that suggests an open period.
      assert.deepEqual(result.report.warnings, [], label);
      assert.ok(['closed', 'unknown'].includes(result.report.status.period), label);
    }
  });

  it('refuse any conversion that does not say whether its statement has closed, naming the choices', () => {
    for (const [file, options] of [
      ['amex-basic.csv', { format: 'amex-csv' as const }], ['amex-detailed.csv', { format: 'amex-csv' as const }],
      ['statement-ofx1.ofx', ofx], ['statement-open.qfx', ofx],
    ] as const) {
      assert.throws(() => convert(file, { ...options, status: null }), (error: Error) => {
        assert.ok(error instanceof ConvertError, file);
        assert.match(error.message, /^say whether this export's statement period has closed \(nothing in an export proves it\): /, file);
        for (const choice of choices) assert.match(error.message, choice, file);
        return true;
      });
    }
    const files = { 'basic.csv': fixture('amex-basic.csv'), 'stmt.ofx': fixture('statement-ofx1.ofx'), 'open.qfx': fixture('statement-open.qfx') };
    for (const args of [['amex-csv', 'basic.csv'], ['ofx', 'stmt.ofx', '--issuer', 'samplebank'], ['ofx', 'open.qfx', '--issuer', 'samplebank', '--quiet']]) {
      const { io, out } = memoryIo(files);
      assert.equal(runCardImportCli([...args, '--out', 'x.json'], io), 1, args.join(' '));
      assert.equal(out.written.size, 0);
      assert.equal(out.stdout, '');
      assert.match(out.stderr, /^holdr-card-import: error: say whether this export's statement period has closed/);
      for (const choice of choices) assert.match(out.stderr, choice);
      assertNoCardData(out.stderr);
    }
  });

  it('write an open period as pending with --status pending, keyed as its posted rows will be', () => {
    const posted = convert('amex-detailed.csv', { format: 'amex-csv', status: 'posted' });
    const pending = convert('amex-detailed.csv', { format: 'amex-csv', status: 'pending' });
    assertJsonSafe(pending.json);
    assert.deepEqual(new Set(statusesOf(pending.json)), new Set(['pending']));
    // Every field but the status, dedupe keys included, is the posted row's.
    const withoutStatus = (rows: typeof posted.payload.rows) => rows.map(({ status: _status, ...rest }) => rest);
    assert.deepEqual(withoutStatus(pending.payload.rows), withoutStatus(posted.payload.rows));
    assert.deepEqual({ ...pending.payload, rows: [], totals: null }, { ...posted.payload, rows: [], totals: null });
    // The totals swap: what a statement would post is all pending, and nothing is posted.
    assert.deepEqual(pending.payload.totals, { posted: posted.payload.totals.pending, pending: posted.payload.totals.posted });
    assert.deepEqual(pending.report.status, {
      basis: 'status', status: 'pending', closedThrough: null, posted: 0, pending: 8, period: 'unknown', madeAt: null, reaches: '2026-09-28',
    });
    assert.deepEqual(pending.report.byMonth, []);
    assert.deepEqual(pending.report.pendingByMonth, posted.report.byMonth);
    assert.deepEqual(pending.report.warnings, []);
    assert.equal(pending.report.reconciliation.status, 'unchecked');
  });

  it('give the closed statement\'s rows the keys of the pending rows they post, and none to a cancelled authorization', () => {
    const current = convert(currentPeriod, { format: 'amex-csv', status: 'pending' });
    const statement = convert(closedStatement, { format: 'amex-csv', status: 'posted' });
    assertJsonSafe(current.json);
    assertJsonSafe(statement.json);
    const pendingKeys = keysOf(current.json);
    const postedKeys = keysOf(statement.json);
    // By reference (grocery, books) and, without one, by date, amount and description (bistro).
    assert.deepEqual(postedKeys.slice(0, 3), [pendingKeys[0], pendingKeys[1], pendingKeys[3]]);
    assert.equal(JSON.parse(statement.json).rows[1].fingerprint, JSON.parse(current.json).rows[1].fingerprint);
    assert.ok(!postedKeys.includes(pendingKeys[2]), 'the cancelled authorization has no posted row');
    assert.equal(current.payload.totals.posted.count, 0);
    assert.deepEqual([current.payload.totals.pending.count, current.payload.totals.pending.chargesMinor], [4, 1632260]);
    assert.deepEqual([statement.payload.totals.posted.count, statement.payload.totals.posted.chargesMinor], [4, 10260]);
  });

  it('split an OFX export at --closed-through by posted date', () => {
    const { json, payload, report } = convert(bytes(open()), { ...ofx, closedThrough: '2026-10-15' });
    assertJsonSafe(json);
    assert.deepEqual(payload.rows.map((row) => [row.postedDate, row.status]), [
      ['2026-09-21', 'posted'], ['2026-10-05', 'posted'], ['2026-10-15', 'posted'], ['2026-10-16', 'pending'], ['2026-10-17', 'pending'],
    ]);
    assert.deepEqual([payload.totals.posted.count, payload.totals.posted.chargesMinor, payload.totals.posted.netMinor], [3, 8270, -21730]);
    assert.deepEqual([payload.totals.pending.count, payload.totals.pending.chargesMinor, payload.totals.pending.netMinor], [2, 13724, 13724]);
    assert.deepEqual(report.status, {
      basis: 'closed-through', status: null, closedThrough: '2026-10-15', posted: 3, pending: 2, period: 'open',
      madeAt: '2026-10-17 09:30 UTC-04:00', reaches: '2026-10-17',
    });
    assert.deepEqual(report.byMonth, [{ month: '2026-09', count: 1, netMinor: 6420 }, { month: '2026-10', count: 2, netMinor: -28150 }]);
    assert.deepEqual(report.pendingByMonth, [{ month: '2026-10', count: 2, netMinor: 13724 }]);
    assert.deepEqual(report.warnings, []);
    // Rows keep the issuer's posted date and keys whatever their status, so the statement's import finds them.
    assert.deepEqual(keysOf(json), keysOf(convert(bytes(open()), { ...ofx, status: 'posted' }).json));
    assert.deepEqual(statusesOf(convert(bytes(open()), { ...ofx, closedThrough: '2026-09-20' }).json), Array(5).fill('pending'));
    assert.deepEqual(statusesOf(convert(bytes(open()), { ...ofx, status: 'pending' }).json), Array(5).fill('pending'));
    // Inclusive closing date, whatever the time of day; a transaction date before it does not post a row after it.
    const boundary = convert(statementFile({ rows: [
      { posted: '20261015235959.999[-5:EST]', id: 'SYN-BEFORE' }, { posted: '20261016000000.000[-5:EST]', user: '20261014', id: 'SYN-AFTER' },
    ] }), { ...ofx, closedThrough: '2026-10-15' });
    assert.deepEqual(boundary.payload.rows.map((row) => [row.postedDate, row.status]), [['2026-10-15', 'posted'], ['2026-10-16', 'pending']]);
  });

  it('warn, but write on the owner\'s word, when --status posted meets dates that reach the day the file was made', () => {
    const cases: Array<[string, Uint8Array, string]> = [
      ['the list ends the day it was made', bytes(open()), openWarning('2026-10-17', '2026-10-17 09:30 UTC-04:00')],
      // The reported case: written in GMT, the file was made at 20:30 on October 16 where its dates are written.
      ['made at the same instant, written in GMT', statementFile({ made: '20261017003000[0:GMT]', end: '20261016203000[-4:EDT]' }),
        openWarning('2026-10-16', '2026-10-17 00:30 UTC+00:00, 2026-10-16 where its dates are written')],
      ['made at the same instant, written in the dates\' zone', statementFile({ made: '20261016203000[-4:EDT]', end: '20261016203000[-4:EDT]' }),
        openWarning('2026-10-16', '2026-10-16 20:30 UTC-04:00')],
      ['made in GMT, dated in EST', statementFile({ made: '20261017003000[0:GMT]', end: '20261016193000[-5:EST]' }),
        openWarning('2026-10-16', '2026-10-17 00:30 UTC+00:00, 2026-10-16 where its dates are written')],
      ['a period that ends after the day it was made', statementFile({ end: '20261115000000[-5:EST]' }),
        openWarning('2026-11-15', '2026-10-17 09:30 UTC-04:00')],
      ['no list end, a row posted the day it was made', statementFile({ end: null, rows: [{ posted: '20261017080000[-4:EDT]', id: 'SYN-TODAY' }] }),
        openWarning('2026-10-17', '2026-10-17 09:30 UTC-04:00')],
    ];
    for (const [label, file, warning] of cases) {
      const result = convert(file, { ...ofx, status: 'posted' });
      assertJsonSafe(result.json);
      assert.deepEqual(new Set(statusesOf(result.json)), new Set(['posted']), label);
      assert.equal(result.report.status.period, 'open', label);
      assert.deepEqual(result.report.warnings, [warning], label);
    }
    // Dates that name no time zone, against a file made in one, may or may not reach that day: said so.
    const unzoned = convert(statementFile({ end: '20261017', rows: [{ posted: '20261016', id: 'SYN-UNZONED' }] }), { ...ofx, status: 'posted' });
    assert.equal(unzoned.report.status.period, 'unclear');
    assert.deepEqual(unzoned.report.warnings, ['--status posted, but this export\'s statement period could not be checked: its dates run '
      + 'to 2026-10-17 and it was made 2026-10-17 09:30 UTC-04:00, in time zones that cannot be compared. Every row is written as posted '
      + 'on your word']);
    // Nothing to warn about: made the day after its last date, or a file that does not say when it was made.
    const later = convert(statementFile({ made: '20261018080000[-4:EDT]' }), { ...ofx, status: 'posted' });
    assert.deepEqual([later.report.status.period, later.report.warnings], ['closed', []]);
    const undated = convert(statementFile({ made: null }), { ...ofx, status: 'posted' });
    assert.deepEqual([undated.report.status.period, undated.report.status.madeAt, undated.report.warnings], ['unknown', null, []]);
    assert.equal(convert('amex-basic.csv', { format: 'amex-csv', status: 'posted' }).report.status.period, 'unknown');
    // Pending rows need no warning.
    assert.deepEqual(convert(bytes(open()), { ...ofx, status: 'pending' }).report.warnings, []);

    const files = { 'open.qfx': fixture('statement-open.qfx') };
    const loud = memoryIo(files);
    assert.equal(runCardImportCli(['ofx', 'open.qfx', '--issuer', 'samplebank', '--status', 'posted', '--out', 'open.json'], loud.io), 0);
    assert.equal(loud.out.written.size, 1);
    assert.ok(loud.out.stderr.includes(`\nWarning: ${openWarning('2026-10-17', '2026-10-17 09:30 UTC-04:00')}\n`));
    // --quiet drops the summary, never the warning.
    const quiet = memoryIo(files);
    assert.equal(runCardImportCli(['ofx', 'open.qfx', '--issuer', 'samplebank', '--status', 'posted', '--quiet'], quiet.io), 0);
    assert.equal(quiet.out.stderr, `holdr-card-import: warning: ${openWarning('2026-10-17', '2026-10-17 09:30 UTC-04:00')}\n`);
    assertJsonSafe(quiet.out.stdout);
  });

  it('take the day a file was made in the time zone of each date it is compared with, never by date prefixes', () => {
    const moment = (date: string, time: number | null, offset: number | null) => ({ date, time, offset });
    for (const date of ['1970-01-01', '2024-02-29', '2026-10-17', '2099-12-31']) assert.equal(dateOfDay(dayNumber(date)), date);
    assert.equal(dayNumber('1970-01-01'), 0);
    for (let day = -5; day < 47_500; day += 1) {
      assert.equal(dateOfDay(day), new Date(day * 86_400_000).toISOString().slice(0, 10));
      assert.equal(dayNumber(dateOfDay(day)), day);
    }
    const cases: Array<[string, ReturnType<typeof moment>, ReturnType<typeof moment>, string, string]> = [
      // Both name their offset: one date. 00:30 GMT on the 17th is 20:30 on the 16th at UTC-4.
      ['GMT against UTC-4', moment('2026-10-17', 30, 0), moment('2026-10-16', 1230, -240), '2026-10-16', '2026-10-16'],
      ['UTC+14 against UTC-12', moment('2026-10-17', 23 * 60 + 59, 14 * 60), moment('2026-10-16', 0, -12 * 60), '2026-10-16', '2026-10-16'],
      ['UTC+5:30 against GMT', moment('2026-10-17', 3 * 60, 330), moment('2026-10-16', 0, 0), '2026-10-16', '2026-10-16'],
      // Neither does, and both are of one kind: one convention, one date.
      ['two times without a zone', moment('2026-10-17', 30, null), moment('2026-10-16', 1230, null), '2026-10-17', '2026-10-17'],
      ['two dates alone', moment('2026-10-17', null, null), moment('2026-10-16', null, null), '2026-10-17', '2026-10-17'],
      // A zone is unknown: every date some real offset (UTC-12 to UTC+14) gives.
      ['a zoned time against a date alone', moment('2026-10-17', 570, -240), moment('2026-10-16', null, null), '2026-10-17', '2026-10-18'],
      ['a time without a zone against a date alone', moment('2026-10-17', 570, null), moment('2026-10-16', null, null), '2026-10-16', '2026-10-18'],
      ['a time without a zone against a zoned date', moment('2026-10-17', 570, null), moment('2026-10-16', 0, -240), '2026-10-16', '2026-10-17'],
      ['a zoned date alone, any minute of it', moment('2026-10-17', null, -240), moment('2026-10-16', 0, 0), '2026-10-17', '2026-10-18'],
    ];
    for (const [label, made, other, first, last] of cases) assert.deepEqual(madeOnDates(made, other), { first, last }, label);
    assert.equal(reachesMadeOnDay(moment('2026-10-16', 1230, -240), moment('2026-10-17', 30, 0)), 'yes');
    assert.equal(reachesMadeOnDay(moment('2026-10-15', 1230, -240), moment('2026-10-17', 30, 0)), 'no');
    assert.equal(reachesMadeOnDay(moment('2026-10-17', null, null), moment('2026-10-17', 570, -240)), 'maybe');
    assert.equal(describeMoment(moment('2026-10-17', 570, -240)), '2026-10-17 09:30 UTC-04:00');
    assert.equal(describeMoment(moment('2026-10-17', 570, 345)), '2026-10-17 09:30 UTC+05:45');
    assert.equal(describeMoment(moment('2026-10-17', 570, null)), '2026-10-17 09:30 (no time zone)');
    assert.equal(describeMoment(moment('2026-10-17', null, null)), '2026-10-17');
  });

  it('read the dates these checks need whole, or refuse the file instead of skipping the check', () => {
    for (const made of ['invalid', '20261317093000[-4:EDT]', '20261017253000[-4:EDT]', '20261017093000[EDT]', '20261017093000[+15:X]',
      '20261017093000[-12.5:X]', '20261017093000[-5.3:X]', '2026-10-17']) {
      for (const status of ['posted', 'pending'] as const) {
        assert.throws(() => convert(statementFile({ made }), { ...ofx, status }),
          (error: Error) => error.name === 'ExportFormatError' && /^DTSERVER \(when the file was made\) is not a valid OFX date and time/.test(error.message), made);
      }
    }
    for (const end of ['invalid', '20261017093000[EDT]', '20261017999999']) {
      assert.throws(() => convert(statementFile({ end }), { ...ofx, status: 'pending' }),
        /DTEND \(where the transaction list ends\) is not a valid OFX date and time/, end);
    }
    // Offsets as OFX writes them: hours, with a decimal fraction for half and three-quarter hours.
    for (const [made, text] of [['20261017093000[+5.5:IST]', 'UTC+05:30'], ['20261017093000[-3.5]', 'UTC-03:30'], ['20261017093000[0]', 'UTC+00:00'],
      ['20261017093000[+5.75:NPT]', 'UTC+05:45'], ['20261017093000[+14:LINT]', 'UTC+14:00'], ['20261017093000[-12:X]', 'UTC-12:00']] as const) {
      assert.equal(convert(statementFile({ made }), { ...ofx, status: 'pending' }).report.status.madeAt, `2026-10-17 09:30 ${text}`, made);
    }
    // A row's unreadable offset leaves its time zone unknown to these checks; the row and its date stay as before.
    const row = convert(statementFile({ rows: [{ posted: '20261016120000[EDT]', id: 'SYN-ROW' }] }), { ...ofx, status: 'pending' });
    assert.deepEqual([row.payload.rows.length, row.payload.rows[0].postedDate, row.payload.rejectedCount], [1, '2026-10-16', 0]);
    // It is never taken for a time written without a zone, like this DTSERVER's: the check cannot tell, and says so.
    const unreadable = convert(statementFile({ made: '20261017093000', end: null, rows: [{ posted: '20261016120000[EDT]', id: 'SYN-ROW' }] }),
      { ...ofx, status: 'posted' });
    assert.equal(unreadable.report.status.period, 'unclear');
  });

  it('take --closed-through only with posted dates and before the day the export was made, in its own time zone', () => {
    assert.throws(() => convert('amex-basic.csv', { format: 'amex-csv', closedThrough: '2026-09-15' }),
      /^ConvertError: --closed-through needs every row's posted date .* import the current period's activity with --status pending$/);
    for (const date of ['2026-10-17', '2026-11-15']) {
      assert.throws(() => convert(bytes(open()), { ...ofx, closedThrough: date }),
        new RegExp(`^ConvertError: --closed-through ${date} is not before the day this export was made \\(2026-10-17 09:30 UTC-04:00\\)`));
    }
    assert.deepEqual(statusesOf(convert(bytes(open()), { ...ofx, closedThrough: '2026-10-16' }).json), ['posted', 'posted', 'posted', 'posted', 'pending']);
    // The reported case: 00:30 GMT on the 17th is the 16th where the dates are written, so the 16th has not closed.
    const zoned = statementFile({ made: '20261017003000[0:GMT]', end: '20261016203000[-4:EDT]' });
    const control = statementFile({ made: '20261016203000[-4:EDT]', end: '20261016203000[-4:EDT]' });
    assert.throws(() => convert(zoned, { ...ofx, closedThrough: '2026-10-16' }),
      /--closed-through 2026-10-16 is not before the day this export was made \(2026-10-17 00:30 UTC\+00:00, 2026-10-16 where its dates are written\)/);
    assert.throws(() => convert(control, { ...ofx, closedThrough: '2026-10-16' }), /--closed-through 2026-10-16 is not before the day this export was made/);
    for (const file of [zoned, control]) assert.deepEqual(statusesOf(convert(file, { ...ofx, closedThrough: '2026-10-15' }).json), ['pending']);
    // Dates that name no time zone cannot be placed against a file made in one: a cutoff that close is refused.
    const unzoned = statementFile({ end: '20261017', rows: [{ posted: '20261016', id: 'SYN-UNZONED' }] });
    assert.throws(() => convert(unzoned, { ...ofx, closedThrough: '2026-10-17' }),
      /--closed-through 2026-10-17 may not be before the day this export was made \(2026-10-17 09:30 UTC-04:00\): its dates \(such as 2026-10-17\) are written in time zones that do not let the tool tell/);
    assert.deepEqual(statusesOf(convert(unzoned, { ...ofx, closedThrough: '2026-10-16' }).json), ['posted']);
    // A file that does not say when it was made: no closing date after everything it holds.
    const undated = statementFile({ made: null });
    for (const date of ['2099-11-15', '2026-10-17']) {
      assert.throws(() => convert(undated, { ...ofx, closedThrough: date }),
        new RegExp(`--closed-through ${date} is not before the newest date in this export \\(2026-10-17\\), and the file does not say when it was made`));
    }
    assert.deepEqual(statusesOf(convert(undated, { ...ofx, closedThrough: '2026-10-15' }).json), ['pending']);

    assert.throws(() => convert('amex-basic.csv', { format: 'amex-csv', closedThrough: '2026-02-30' }), /--closed-through must be a valid YYYY-MM-DD date/);
    assert.throws(() => convert('amex-basic.csv', { format: 'amex-csv', status: 'cleared' as never }), /--status must be posted or pending/);
    assert.throws(() => convert('amex-basic.csv', { format: 'amex-csv', status: 'pending', closedThrough: '2026-09-15' }), /cannot be used together/);
    const usage: Array<[string[], RegExp]> = [
      [['--status', 'cleared'], /--status must be one of posted, pending/],
      [['--closed-through', '10/15/2026'], /--closed-through must be a YYYY-MM-DD date/],
      [['--closed-through', '4111111111111111'], /--closed-through must be a YYYY-MM-DD date/],
      [['--status', 'pending', '--closed-through', '2026-10-15'], /--status and --closed-through cannot be used together/],
      [['--status', 'pending', '--status', 'posted'], /--status may be given once/],
    ];
    for (const [args, message] of usage) {
      const { io, out } = memoryIo({ 'open.qfx': fixture('statement-open.qfx') });
      assert.equal(runCardImportCli(['ofx', 'open.qfx', '--issuer', 'samplebank', ...args], io), 2, args.join(' '));
      assert.match(out.stderr, message);
      assertNoCardData(out.stderr);
    }
  });

  it('decide statement figures and the ledger balance on the rows written, after every rejection', () => {
    const figures = { charges: '82.70', credits: '300.00', net: '-217.30' };
    for (const options of [{ status: 'pending' as const }, { closedThrough: '2026-09-20' }]) {
      assert.throws(() => convert(bytes(open()), { ...ofx, ...options, expected: figures }), /every row of this import is pending: leave them out/);
    }
    assert.throws(() => convert('amex-basic.csv', { format: 'amex-csv', status: 'pending', expected: { charges: '53.60' } }), /every row of this import is pending/);
    // The reported case: the only posted row shows card digits and is left out, so the rest is all pending.
    const PAN = '4111111111111111';
    const leaky = (rows: SyntheticRow[], ledger?: { amount: string; asOf: string }) => statementFile({ account: PAN, rows, ledger });
    const leakIsPosted = leaky([
      { posted: '20261015120000[-4:EDT]', name: 'SAMPLE 4111 1111 1111', id: 'SYN-LEAK' },
      { posted: '20261016120000[-4:EDT]', name: 'CONTOSO ORDER', amount: '-16250.00', id: 'SYN-PENDING' },
    ]);
    const split = { ...ofx, closedThrough: '2026-10-15', skipInvalid: true };
    assert.throws(() => convert(leakIsPosted, { ...split, expected: { charges: '0', net: '0' } }), /every row of this import is pending: leave them out/);
    const written = convert(leakIsPosted, split);
    assert.deepEqual([written.payload.totals.posted.count, written.payload.totals.pending.count, written.payload.rejectedCount], [0, 1, 1]);
    // And the other way round: the only pending row is left out, so the ledger balance is the statement's again.
    const leakIsPending = leaky([
      { posted: '20261015120000[-4:EDT]', name: 'NORTHWIND GROCERY', amount: '-20.00', id: 'SYN-POSTED' },
      { posted: '20261016120000[-4:EDT]', name: 'SAMPLE 4111 1111 1111', amount: '-30.00', id: 'SYN-LEAK' },
    ], { amount: '-120.00', asOf: '20261017093000[-4:EDT]' });
    const ledger = convert(leakIsPending, { ...split, expected: { previousBalance: '100.00' } });
    assert.deepEqual([ledger.payload.totals.posted.count, ledger.payload.totals.pending.count, ledger.payload.rejectedCount], [1, 0, 1]);
    assert.equal(ledger.report.ledgerUsedAsNewBalance, true);
    assert.equal(ledger.report.reconciliation.status, 'match');
    assertJsonSafe(ledger.json);
    // A split is checked on its posted part: the statements that closed.
    const checked = convert(bytes(open()), { ...ofx, closedThrough: '2026-10-15', expected: { ...figures, previousBalance: '1,000.00', newBalance: '782.70' } });
    assert.equal(checked.report.reconciliation.status, 'match');
    assert.equal(checked.report.ledgerUsedAsNewBalance, false);
    // The ledger balance also counts the pending rows, so it is no statement's new balance.
    assert.throws(() => convert(bytes(open()), { ...ofx, closedThrough: '2026-10-15', expected: { previousBalance: '1,000.00' } }),
      /--expect-previous-balance needs --expect-new-balance: the OFX ledger balance also counts the rows written as pending/);
    const whole = convert(bytes(open()), { ...ofx, status: 'posted', expected: { previousBalance: '1,320.50' } });
    assert.equal(whole.report.ledgerUsedAsNewBalance, true);
    assert.equal(whole.report.reconciliation.status, 'match');
  });

  it('show the statuses, the warning and the pending totals in the summary', () => {
    const files = { 'basic.csv': fixture('amex-basic.csv'), 'stmt.ofx': fixture('statement-ofx1.ofx'), 'open.qfx': fixture('statement-open.qfx') };
    const cases: Array<[string[], RegExp[], RegExp[]]> = [
      [['amex-csv', 'basic.csv', '--status', 'pending'], [
        /\nStatus: every row pending \(--status pending\): not counted as spending until the closed statement's import posts them\n/,
        /\nPosted: 0 rows, charges 0\.00, credits 0\.00, net 0\.00\n/,
        /\nPending \(not spending\): 4 rows, charges 53\.60, credits -120\.00, net -66\.40\n {2}purchase 3: 53\.60 \| payment 1: -120\.00\n {2}2026-09: 4 rows, net -66\.40\n/,
      ], [/Warning/]],
      [['amex-csv', 'basic.csv', '--status', 'posted'], [
        /\nStatus: every row posted \(--status posted\), on your word that its statement has closed; this export does not say when it was made, so nothing in it can confirm that\n/,
        /\nPosted: 4 rows, charges 53\.60, credits -120\.00, net -66\.40\n/,
      ], [/Pending/, /Warning/]],
      [['ofx', 'stmt.ofx', '--issuer', 'samplebank', '--status', 'posted'], [
        /\nStatus: every row posted \(--status posted\), on your word that its statement has closed; its dates run to 2026-09-30, before the day it was made \(2026-10-01 12:00 UTC\+00:00\), which does not prove it either\n/,
      ], [/Pending/, /Warning/]],
      [['ofx', 'open.qfx', '--issuer', 'samplebank', '--closed-through', '2026-10-15'], [
        /\nStatus: --closed-through 2026-10-15: 3 rows posted on or before it are posted, 2 rows posted after it are pending\n/,
        /\nPosted: 3 rows, charges 82\.70, credits -300\.00, net -217\.30\n {2}purchase 2: 82\.70 \| payment 1: -300\.00\n {2}2026-09: 1 rows, net 64\.20\n {2}2026-10: 2 rows, net -281\.50\n/,
        /\nPending \(not spending\): 2 rows, charges 137\.24, credits 0\.00, net 137\.24\n {2}purchase 2: 137\.24\n {2}2026-10: 2 rows, net 137\.24\n/,
      ], [/Warning/]],
      [['ofx', 'open.qfx', '--issuer', 'samplebank', '--status', 'posted'], [
        /\nStatus: every row posted \(--status posted\), on your word that its statement has closed \(see the warning\)\nWarning: --status posted, but this export may include a statement period that has not closed: its dates run to 2026-10-17, on or after the day it was made \(2026-10-17 09:30 UTC-04:00\)\. Every row is written as posted on your word/,
      ], [/Pending/]],
    ];
    for (const [args, present, absent] of cases) {
      const { io, out } = memoryIo(files);
      assert.equal(runCardImportCli(args, io), 0, args.join(' '));
      for (const pattern of present) assert.match(out.stderr, pattern, args.join(' '));
      for (const pattern of absent) assert.doesNotMatch(out.stderr, pattern, args.join(' '));
      assertJsonSafe(out.stdout);
      assertNoCardData(out.stderr);
    }
    const help = memoryIo(files);
    assert.equal(runCardImportCli(['--help'], help.io), 0);
    assert.match(help.out.stdout, /Statement period \(required: nothing in an export proves that its statement has closed\):/);
    for (const choice of [/--status posted /, /--status pending /, /--closed-through YYYY-MM-DD /]) assert.match(help.out.stdout, choice);
  });
});

describe('classification', () => {
  it('treats card payments as transfers and spots fees, interest and refunds', () => {
    const kind = (amountMinor: number, description: string, extra: Partial<Parameters<typeof classifyCardKind>[0]> = {}) =>
      classifyCardKind({ amountMinor, description, ...extra });
    for (const text of ['AUTOPAY PAYMENT - THANK YOU', 'Payment Thank You-Mobile', 'ONLINE PAYMENT, THANK YOU', 'CAPITAL ONE MOBILE PYMT',
      'AUTOMATIC PAYMENT - THANK YOU', 'INTERNET PAYMENT - THANK YOU', 'ONLINE ACH PAYMENT THANK YOU', 'BA ELECTRONIC PAYMENT', 'DIRECTPAY FULL BALANCE']) {
      assert.equal(kind(-1000, text), 'payment', text);
    }
    assert.equal(kind(-1000, 'PAYPAL *MERCHANT REFUND'), 'refund');
    assert.equal(kind(-1000, 'ONLINE STORE', { typeHint: 'PAYMENT' }), 'payment');
    assert.equal(kind(1000, 'RETURNED PAYMENT'), 'payment');
    assert.equal(kind(1000, 'RETURNED PAYMENT FEE'), 'fee');
    assert.equal(kind(1000, 'LATE FEE'), 'fee');
    assert.equal(kind(1000, 'FOREIGN TRANSACTION FEE'), 'fee');
    assert.equal(kind(1000, 'X', { issuerCategory: 'Fees & Adjustments-Fees & Adjustments' }), 'fee');
    assert.equal(kind(1000, 'INTEREST CHARGE ON PURCHASES'), 'interest');
    assert.equal(kind(1000, 'X', { typeHint: 'INT' }), 'interest');
    assert.equal(kind(-1000, 'LATE FEE REVERSAL'), 'adjustment');
    assert.equal(kind(1000, 'CASH ADVANCE'), 'other');
    assert.equal(kind(1000, 'BALANCE TRANSFER'), 'other');
    // The other end of a balance transfer (the old card paid off by a new one) and a cash advance taken back.
    for (const text of ['BALANCE TRANSFER', 'BALANCE TRANSFER CREDIT', 'CREDIT BALANCE TRANSFER TO NEW CARD', 'CASH ADVANCE REVERSAL',
      'CONVENIENCE CHECK RETURNED']) {
      assert.equal(kind(-1000, text), 'other', text);
    }
    assert.equal(kind(-1000, 'BALANCE TRANSFER FEE REVERSAL'), 'adjustment');
    assert.equal(kind(-1000, 'CASH ADVANCE INTEREST CREDIT'), 'adjustment');
    assert.equal(kind(-1000, 'BALANCE TRANSFER PAYMENT - THANK YOU'), 'payment');
    // A credit of a fee or interest on one, by its wording or its type, keeps its legacy kind: the refund that offsets
    // its charge (an INT credit stays the adjustment it always was).
    for (const text of ['BALANCE TRANSFER FEE', 'CASH ADVANCE INTEREST', 'CASH ADVANCE FEE', 'FINANCE CHARGE CASH ADVANCE']) {
      assert.equal(kind(-1000, text), 'refund', text);
    }
    for (const typeHint of ['FEE', 'SRVCHG']) assert.equal(kind(-1000, 'CASH ADVANCE', { typeHint }), 'refund', typeHint);
    assert.equal(kind(-1000, 'CASH ADVANCE', { typeHint: 'INT' }), 'adjustment');
    // A second text is read by every wording rule on its own, never joined to the description.
    assert.deepEqual([kind(-1000, 'SYNTHETIC OLD CARD', { evidence: 'BALANCE TRANSFER CREDIT' }),
      kind(-1000, 'SYNTHETIC OLD CARD', { evidence: 'BALANCE TRANSFER FEE' }), kind(1000, 'SYNTHETIC OLD CARD', { evidence: 'BALANCE TRANSFER FEE' }),
      kind(1000, 'SYNTHETIC', { evidence: 'CASH ADVANCE INTEREST' }), kind(-1000, 'SYNTHETIC', { evidence: 'ONLINE PAYMENT - THANK YOU' }),
      kind(-1000, 'SYNTHETIC', { evidence: 'LATE FEE REVERSAL' }), kind(1000, 'SYNTHETIC', { evidence: 'CASH ADVANCE' })],
    ['other', 'refund', 'fee', 'interest', 'payment', 'adjustment', 'other']);
    assert.deepEqual([kind(-1000, 'BALANCE', { evidence: 'TRANSFER CREDIT' }), kind(-1000, 'PAYMENT', { evidence: 'THANK YOU' }),
      kind(-1000, 'CASH ADVANCE', { evidence: 'FEE' }), kind(-1000, 'SYNTHETIC', { evidence: null })], ['refund', 'refund', 'other', 'refund']);
    assert.equal(kind(0, 'ZERO'), 'other');
    assert.equal(kind(1000, 'FEED STORE'), 'purchase');
  });

  it('keep a fee or interest pair on a balance transfer or cash advance netting to zero, in every format', () => {
    const net = (rows: ReadonlyArray<{ kind: CardTransactionKind; amountMinor: number }>) =>
      rows.filter((row) => cardSpendingRole(row.kind) === 'spending').reduce((total, row) => total + row.amountMinor, 0);
    const ofxFile = (rows: ReadonlyArray<[type: string, amount: string, name: string]>) => bytes([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20261001120000[-4:EDT]</DTSERVER>',
      '<LANGUAGE>ENG</LANGUAGE></SONRS></SIGNONMSGSRSV1><CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>1</TRNUID>',
      '<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><CCSTMTRS><CURDEF>USD</CURDEF><CCACCTFROM><ACCTID>XXXX-1111</ACCTID></CCACCTFROM>',
      '<BANKTRANLIST><DTSTART>20260901000000[-4:EDT]</DTSTART><DTEND>20260930120000[-4:EDT]</DTEND>',
      ...rows.map(([type, amount, name], index) => `<STMTTRN><TRNTYPE>${type}</TRNTYPE><DTPOSTED>2026091${index}120000[-4:EDT]</DTPOSTED>`
        + `<TRNAMT>${amount}</TRNAMT><FITID>SYN-PAIR-${index}</FITID><NAME>${name}</NAME></STMTTRN>`),
      '</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
    ].join('\n'));
    // Each pair: a 10.00 charge and its 10.00 credit, with the kinds main's classifier gives them.
    for (const [text, legacy] of [['BALANCE TRANSFER FEE', ['fee', 'refund']], ['CASH ADVANCE INTEREST', ['interest', 'refund']]] as const) {
      const files: Array<[string, Uint8Array, Partial<ConvertOptions> & Pick<ConvertOptions, 'format'>]> = [
        ['amex-csv', bytes(`Date,Description,Amount\n09/14/2026,${text},10.00\n09/15/2026,${text},-10.00\n`), { format: 'amex-csv' }],
        ['ofx', ofxFile([['DEBIT', '-10.00', text], ['CREDIT', '10.00', text]]), { format: 'ofx', issuer: 'samplebank' }],
        ['wf-csv', bytes(`DATE,DESCRIPTION,AMOUNT\n09/14/2026,${text},-10.00\n09/15/2026,${text},10.00\n09/16/2026,ONLINE PAYMENT THANK YOU,100.00\n`),
          { format: 'wf-csv' }],
      ];
      for (const [format, file, options] of files) {
        const rows = convert(file, options).payload.rows;
        assert.deepEqual(rows.slice(0, 2).map((row) => [row.amountMinor, row.kind]), [[1000, legacy[0]], [-1000, legacy[1]]], `${format} ${text}`);
        assert.equal(net(rows), 0, `${format} ${text}`);
      }
    }
    // OFX types a fee, a service charge or interest itself: with a cash-advance NAME, the pair keeps its legacy kinds too.
    for (const [type, legacy] of [['FEE', ['fee', 'refund']], ['SRVCHG', ['fee', 'refund']], ['INT', ['interest', 'adjustment']]] as const) {
      const rows = convert(ofxFile([[type, '-10.00', 'CASH ADVANCE'], [type, '10.00', 'CASH ADVANCE']]), { format: 'ofx', issuer: 'samplebank' }).payload.rows;
      assert.deepEqual(rows.map((row) => [row.amountMinor, row.kind]), [[1000, legacy[0]], [-1000, legacy[1]]], type);
      assert.equal(net(rows), 0, type);
    }
  });

  it('changes only the credits the balance-transfer rule matches: every other row is written as before', () => {
    // Legacy pairs: each fixture as it was, and with one balance-transfer credit added.
    const amex = new TextDecoder().decode(fixture('amex-basic.csv')).replace(/\s+$/, '');
    const qfx = new TextDecoder().decode(fixture('statement.qfx'));
    const credit = '<STMTTRN>\n<TRNTYPE>CREDIT\n<DTPOSTED>20260925\n<TRNAMT>400.00\n<FITID>2026092524692166221000129\n'
      + '<NAME>BALANCE TRANSFER CREDIT\n</STMTTRN>\n</BANKTRANLIST>';
    const bilt = new TextDecoder().decode(fixture('bilt-activity.csv')).replace(/\s+$/, '');
    const wf = new TextDecoder().decode(fixture('wf-card.csv')).replace(/\s+$/, '');
    const eol = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');
    const pairs: Array<[Uint8Array, Uint8Array, Partial<ConvertOptions> & Pick<ConvertOptions, 'format'>]> = [
      [fixture('amex-basic.csv'), bytes(`${amex}\n09/17/2026,BALANCE TRANSFER CREDIT,-400.00\n`), { format: 'amex-csv' }],
      [fixture('statement.qfx'), bytes(qfx.replace('</BANKTRANLIST>', credit)), { format: 'ofx', issuer: 'samplebank' }],
      // Bilt's own Description says it, beside another Raw Merchant Name (stored as the description).
      [fixture('bilt-activity.csv'), bytes(`${bilt}${eol(bilt)}2026-04-10,2026-04-10,BALANCE TRANSFER CREDIT,-400.00,,,SYNTHETIC OLD CARD${eol(bilt)}`),
        { format: 'bilt-csv', loanPayments: 'not-spending' }],
      [fixture('wf-card.csv'), bytes(`${wf}${eol(wf)}"09/20/2026","BALANCE TRANSFER CREDIT","400.00","","Posted"${eol(wf)}`), { format: 'wf-csv' }],
    ];
    for (const [before, after, options] of pairs) {
      const old = convert(before, options).payload.rows;
      const now = convert(after, options).payload.rows;
      assert.equal(now.length, old.length + 1, options.format);
      assert.deepEqual(now.slice(0, old.length), old, options.format);
      assert.deepEqual([now[old.length].amountMinor, now[old.length].kind], [-40000, 'other'], options.format);
    }
  });

  it('take a charge worded as a payment for one only when it says the payment was returned or reversed', () => {
    const kind = (amountMinor: number, description: string, extra: Partial<Parameters<typeof classifyCardKind>[0]> = {}) =>
      classifyCardKind({ amountMinor, description, ...extra });
    // Every wording class of the payment pattern, on both signs. A credit is a card payment, as before. A charge is one
    // only with return or reversal wording; any other is read as if the payment wording were not there: a purchase here.
    const classes: Array<[string, string[], CardTransactionKind]> = [
      ['AUTO-PAY', ['AUTOPAY', 'AUTO-PAY', 'AUTO PAY'], 'purchase'],
      ['AUTO PAYMENT', ['AUTO PAYMENT', 'AUTO-PMT', 'AUTOPYMT'], 'purchase'],
      ['AUTOPAYPAYMENT', ['AUTOPAYPAYMENT', 'AUTOPAYPMT'], 'purchase'],
      ['PAYMENT ... THANK YOU', ['PAYMENT - THANK YOU', 'PMT THANKYOU'], 'purchase'],
      ['THANK YOU ... PAYMENT', ['THANK YOU FOR YOUR PAYMENT'], 'purchase'],
      ['ONLINE ... BILL PAYMENT', ['ONLINE PAYMENT', 'MOBILE PYMT', 'INTERNET PMT', 'ELECTRONIC PAYMT', 'ACH PAYMENT', 'WEB PAYMENT',
        'PHONE PAYMENT', 'AUTOMATIC PAYMENT', 'RECURRING PAYMENT', 'BILL PAYMENT', 'ONLINE ACH PAYMENT'], 'purchase'],
      ['E-PAYMENT', ['E-PAYMENT', 'EPAYMENT'], 'purchase'],
      ['PAYMENT RECEIVED, POSTED, FROM', ['PAYMENT RECEIVED', 'PAYMENT POSTED', 'PAYMENT FROM CHECKING'], 'purchase'],
      ['RETURNED ... PAYMENT', ['RETURNED PAYMENT', 'REVERSED PAYMENT', 'DISHONORED PAYMENT', 'DISHONOURED PAYMENT', 'NSF PAYMENT', 'NSF PMT'], 'payment'],
      ['PAYMENT RETURNED ...', ['PAYMENT RETURNED', 'PAYMENT REVERSAL', 'PAYMENT REVERSED', 'PYMT RETURNED'], 'payment'],
      ['DIRECTPAY', ['DIRECTPAY', 'DIRECT PAY'], 'purchase'],
      ['BILLPAY', ['BILLPAY', 'BILL PAY'], 'purchase'],
    ];
    for (const [label, texts, charge] of classes) {
      for (const text of texts) {
        assert.equal(kind(-1000, text), 'payment', `${label}: credit ${text}`);
        assert.equal(kind(-1000, `SYNTHETIC ${text} 0042`), 'payment', `${label}: credit ${text} in other words`);
        assert.equal(kind(1000, text), charge, `${label}: charge ${text}`);
        assert.equal(kind(1000, `SYNTHETIC ${text} 0042`), charge, `${label}: charge ${text} in other words`);
      }
    }
    // A return or reversal word and a payment word (a compound one too), in either order, anywhere in one text. 1.0.1 read
    // only the adjacent forms, so it wrote PAYMENT DISHONORED, PAYMENT NSF or NSF RETURN OF PAYMENT as a purchase.
    for (const text of ['RETURNED ONLINE PAYMENT', 'ONLINE PAYMENT REVERSED', 'REVERSAL - AUTOMATIC PAYMENT', 'PAYMENT DISHONORED',
      'PAYMENT NSF', 'NSF RETURN OF PAYMENT', 'AUTOPAY RETURNED', 'AUTO-PAY REVERSAL', 'E-PAYMENT REVERSED', 'DIRECTPAY REVERSED',
      'BILLPAY RETURNED', 'returned payment']) {
      assert.equal(kind(1000, text), 'payment', text);
    }
    // Without one, the rules after it decide, in their order: interest, fee, other, purchase.
    assert.deepEqual([
      kind(1000, 'RETURNED PAYMENT FEE'), kind(1000, 'LATE PAYMENT FEE'), kind(1000, 'ONLINE PAYMENT', { typeHint: 'FEE' }),
      kind(1000, 'WEB PAYMENT', { typeHint: 'SRVCHG' }), kind(1000, 'BILL PAYMENT', { issuerCategory: 'Fees & Adjustments-Fees & Adjustments' }),
    ], ['fee', 'fee', 'fee', 'fee', 'fee']);
    assert.deepEqual([kind(1000, 'BILL PAYMENT INTEREST CHARGE'), kind(1000, 'PHONE PAYMENT', { typeHint: 'INT' })], ['interest', 'interest']);
    assert.deepEqual([kind(1000, 'ONLINE PAYMENT CASH ADVANCE'), kind(1000, 'BILL PAYMENT BALANCE TRANSFER'),
      kind(1000, 'WEB PAYMENT', { typeHint: 'CASH' }), kind(1000, 'WEB PAYMENT', { typeHint: 'ATM' })], ['other', 'other', 'other', 'other']);
    assert.deepEqual([kind(1000, 'ONLINE PAYMENT - THANK YOU', { typeHint: 'PAYMENT' }), kind(1000, 'RETURNED PAYMENT', { typeHint: 'PAYMENT' }),
      kind(1000, 'SYNTHETIC RETURNED GOODS'), kind(1000, 'NSF SYNTHETIC CO')], ['purchase', 'payment', 'purchase', 'purchase']);
    // Each text on its own: a return word in one and a payment word in the other is no returned payment.
    assert.deepEqual([kind(1000, 'RETURNED', { evidence: 'ONLINE PAYMENT' }), kind(1000, 'ONLINE PAYMENT', { evidence: 'REVERSED' }),
      kind(1000, 'SYNTHETIC UTILITY', { evidence: 'BILL PAYMENT' }), kind(1000, 'SYNTHETIC', { evidence: 'PAYMENT RETURNED' }),
      kind(1000, 'NSF PAYMENT', { evidence: 'SYNTHETIC' }), kind(-1000, 'SYNTHETIC', { evidence: 'WEB PAYMENT' })],
    ['purchase', 'purchase', 'purchase', 'payment', 'payment', 'payment']);
  });

  it('read every payment word the credit rule reads, compounds too, beside a return word on a charge as a returned payment', () => {
    const kind = (amountMinor: number, description: string, extra: Partial<Parameters<typeof classifyCardKind>[0]> = {}) =>
      classifyCardKind({ amountMinor, description, ...extra });
    // A charge's kind with the text as its description, and as a second text (Bilt's Description) beside another one.
    const charge = (text: string) => [kind(1000, text), kind(1000, 'SYNTHETIC', { evidence: text })];
    const returnWords = ['RETURNED', 'REVERSED', 'REVERSAL', 'DISHONORED', 'DISHONOURED', 'NSF'];
    // The compounds a review found the charge rule missing: a payment on a credit, and with a return word on a charge too.
    for (const word of ['AUTOPMT', 'AUTOPYMT', 'AUTOPAYMT', 'AUTOPAYMENT', 'AUTO PAYMENT', 'AUTO-PMT', 'AUTOPAYPMT']) {
      assert.equal(kind(-1000, word), 'payment', word);
      assert.deepEqual(charge(word), ['purchase', 'purchase'], word);
      for (const text of [`RETURNED ${word}`, `${word} REVERSAL`]) assert.deepEqual(charge(text), ['payment', 'payment'], text);
    }
    // Generated: every token of one or two pieces that the credit rule reads as a payment is a payment word on a charge,
    // which a return word either side makes a returned payment; alone, it leaves the charge a purchase.
    const pieces = ['AUTO', 'AUTOPAY', 'E', 'DIRECT', 'BILL', 'ONLINE', 'MOBILE', 'INTERNET', 'ELECTRONIC', 'ACH', 'WEB', 'PHONE',
      'AUTOMATIC', 'RECURRING', 'THANK YOU', 'THANKYOU', 'RECEIVED', 'POSTED', 'FROM', 'PAY', 'PAYMENT', 'PAYMT', 'PYMT', 'PMT'];
    const tokens = new Set(pieces);
    for (const first of pieces) for (const separator of ['', ' ', '-']) for (const second of pieces) tokens.add(`${first}${separator}${second}`);
    const read = [...tokens].flatMap((token) => [token, token.toLowerCase()]).filter((token) => kind(-1000, token) === 'payment');
    for (const token of ['AUTOPAY', 'AUTOPMT', 'AUTOPAYMENT', 'AUTOPAYPMT', 'E-PAYMENT', 'DIRECTPAY', 'BILL PAY', 'ONLINE PMT', 'pymt thankyou']) {
      assert.ok(read.includes(token), token);
    }
    for (const token of read) {
      assert.deepEqual(charge(token), ['purchase', 'purchase'], token);
      for (const word of returnWords) {
        for (const text of [`${word} ${token}`, `${token} ${word}`]) assert.deepEqual(charge(text), ['payment', 'payment'], text);
      }
    }
  });

  it('write a charge worded as a payment as its purchase in every format, and a returned payment and a card payment as before', () => {
    const ofxFile = (rows: ReadonlyArray<[type: string, amount: string, name: string]>) => bytes([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20261001120000[-4:EDT]</DTSERVER>',
      '<LANGUAGE>ENG</LANGUAGE></SONRS></SIGNONMSGSRSV1><CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>1</TRNUID>',
      '<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><CCSTMTRS><CURDEF>USD</CURDEF><CCACCTFROM><ACCTID>XXXX-1111</ACCTID></CCACCTFROM>',
      '<BANKTRANLIST><DTSTART>20260901000000[-4:EDT]</DTSTART><DTEND>20260930120000[-4:EDT]</DTEND>',
      ...rows.map(([type, amount, name], index) => `<STMTTRN><TRNTYPE>${type}</TRNTYPE><DTPOSTED>2026091${index}120000[-4:EDT]</DTPOSTED>`
        + `<TRNAMT>${amount}</TRNAMT><FITID>SYN-BILL-${index}</FITID><NAME>${name}</NAME></STMTTRN>`),
      '</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
    ].join('\n'));
    // Each file: a bill paid with the card (worded as a payment), a payment to the card, and that payment returned.
    const files: Array<[string, Uint8Array, Partial<ConvertOptions> & Pick<ConvertOptions, 'format'>]> = [
      ['amex-csv', bytes('Date,Description,Amount\n09/14/2026,ONLINE PAYMENT SYNTHETIC UTILITY,45.00\n'
        + '09/15/2026,ONLINE PAYMENT - THANK YOU,-120.00\n09/16/2026,RETURNED PAYMENT,120.00\n'), { format: 'amex-csv' }],
      ['ofx', ofxFile([['DEBIT', '-45.00', 'WEB PAYMENT SYNTHETIC WATER'], ['CREDIT', '120.00', 'ONLINE PAYMENT - THANK YOU'],
        ['DEBIT', '-120.00', 'RETURNED PAYMENT']]), { format: 'ofx', issuer: 'samplebank' }],
      ['wf-csv', bytes('DATE,DESCRIPTION,AMOUNT\n09/14/2026,BILL PAYMENT SYNTHETIC POWER,-45.00\n'
        + '09/15/2026,ONLINE PAYMENT - THANK YOU,120.00\n09/16/2026,RETURNED PAYMENT,-120.00\n'), { format: 'wf-csv', ofxSign: 'standard' }],
    ];
    for (const [format, file, options] of files) {
      const { payload } = convert(file, options);
      assert.deepEqual(payload.rows.map((row) => [row.amountMinor, row.kind]), [[4500, 'purchase'], [-12000, 'payment'], [12000, 'payment']], format);
      assert.deepEqual([payload.totals.posted.byKind.purchase, payload.totals.posted.byKind.payment],
        [{ count: 1, amountMinor: 4500 }, { count: 2, amountMinor: 0 }], format);
    }
    // wf-csv's sign check reads every row as a credit, as before: a charge worded as a payment still leaves the sign unproven.
    assert.throws(() => convert(files[2][1], { format: 'wf-csv' }), /the card payment rows disagree on the amount sign/);
  });

  it('write a returned payment worded as a compound (AUTOPMT, AUTOPAYMENT) as a payment on either sign in every format', () => {
    const money = (minor: number) => (minor / 100).toFixed(2);
    const returned = ['RETURNED AUTOPMT', 'AUTOPYMT REVERSAL', 'RETURNED AUTOPAYMT', 'AUTOPAYMENT REVERSAL'];
    // Each as a charge and as a credit (Holdr's sign: money spent positive), then a compound alone on a charge.
    const rows: Array<[string, number]> = [...returned.flatMap((text): Array<[string, number]> => [[text, 1000], [text, -1000]]),
      ['AUTOPMT SYNTHETIC GYM', 2500]];
    const day = (index: number) => 10 + index;
    const files: Array<[string, Uint8Array, Partial<ConvertOptions> & Pick<ConvertOptions, 'format'>]> = [
      ['amex-csv', bytes(['Date,Description,Amount', ...rows.map(([text, minor], index) => `09/${day(index)}/2026,${text},${money(minor)}`), '']
        .join('\n')), { format: 'amex-csv' }],
      ['ofx', bytes(['<?xml version="1.0" encoding="UTF-8"?>',
        '<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD</CURDEF><CCACCTFROM><ACCTID>XXXX-1111</ACCTID></CCACCTFROM><BANKTRANLIST>',
        ...rows.map(([text, minor], index) => `<STMTTRN><TRNTYPE>${minor > 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>202609${day(index)}</DTPOSTED>`
          + `<TRNAMT>${money(-minor)}</TRNAMT><FITID>SYN-AUTO-${index}</FITID><NAME>${text}</NAME></STMTTRN>`),
        '</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>'].join('\n')), { format: 'ofx', issuer: 'samplebank' }],
      ['wf-csv', bytes(['DATE,DESCRIPTION,AMOUNT', ...rows.map(([text, minor], index) => `09/${day(index)}/2026,${text},${money(-minor)}`), '']
        .join('\n')), { format: 'wf-csv', ofxSign: 'standard' }],
    ];
    for (const [format, file, options] of files) {
      assert.deepEqual(convert(file, options).payload.rows.map((row) => [row.amountMinor, row.kind]),
        [...returned.flatMap(() => [[1000, 'payment'], [-1000, 'payment']]), [2500, 'purchase']], format);
    }
  });
});

describe('command line', () => {
  const files = {
    'amex.csv': fixture('amex-detailed.csv'),
    'basic.csv': fixture('amex-basic.csv'),
    'stmt.ofx': fixture('statement-ofx1.ofx'),
    [`Activity_4111111111111111.csv`]: fixture('amex-basic.csv'),
  };

  it('writes the JSON to stdout or --out and the summary to stderr, never raw values', () => {
    const { io, out } = memoryIo(files);
    assert.equal(runCardImportCli(['amex-csv', 'amex.csv', '--status', 'posted', '--member', 'ALEX SAMPLE=casey', '--member=JORDAN SAMPLE=alex'], io), 0);
    assertJsonSafe(out.stdout);
    assertNoCardData(out.stderr);
    assert.doesNotMatch(out.stderr + out.stdout, NAMES);
    assert.match(out.stderr, /Card Member: mapped \(casey 6, alex 2\)/);
    assert.match(out.stderr, /Statement check: not done/);

    const second = memoryIo(files);
    assert.equal(runCardImportCli(['amex-csv', 'Activity_4111111111111111.csv', '--status=posted', '--out', 'out-4111111111111111.json'], second.io), 0);
    assert.equal(second.out.stdout, '');
    assert.equal(second.out.written.get('out-4111111111111111.json'), convert('amex-basic.csv', { format: 'amex-csv' }).json);
    assertNoCardData(second.out.stderr);
    assert.match(second.out.stderr, /Wrote out-\*\*\*1111\.json/);
  });

  it('refuses to overwrite without --force and to write over the export', () => {
    const { io, out } = memoryIo(files);
    assert.equal(runCardImportCli(['amex-csv', 'basic.csv', '--status', 'posted', '--out', 'amex.csv', '--quiet'], io), 1);
    assert.match(out.stderr, /must not be the export file|exists/);
    const again = memoryIo(files);
    assert.equal(runCardImportCli(['amex-csv', 'basic.csv', '--status', 'posted', '--out', 'x.json', '--quiet'], again.io), 0);
    assert.equal(runCardImportCli(['amex-csv', 'basic.csv', '--status', 'posted', '--out', 'x.json', '--quiet'], again.io), 1);
    assert.match(again.out.stderr, /use --force/);
    assert.equal(runCardImportCli(['amex-csv', 'basic.csv', '--status', 'posted', '--out', 'x.json', '--quiet', '--force'], again.io), 0);
  });

  it('exits 3 and writes nothing when the statement does not match, unless --allow-mismatch', () => {
    const { io, out } = memoryIo(files);
    const args = ['ofx', 'stmt.ofx', '--issuer', 'samplebank', '--status', 'posted', '--expect-previous-balance', '1000.00', '--out', 'o.json'];
    assert.equal(runCardImportCli(args, io), 3);
    assert.equal(out.written.size, 0);
    assert.match(out.stderr, /MISMATCH/);
    assert.match(out.stderr, /balance: expected 2,000\.00, computed 1,804\.55 \(off by -195\.45\)/);
    assert.equal(runCardImportCli([...args, '--allow-mismatch'], io), 0);
    assert.equal(out.written.size, 1);
    const ok = memoryIo(files);
    assert.equal(runCardImportCli(['ofx', 'stmt.ofx', '--issuer', 'samplebank', '--status', 'posted', '--expect-previous-balance', '1195.45', '--expect-new-balance', '2000'], ok.io), 0);
    assert.match(ok.out.stderr, /Statement check: MATCH/);
  });

  it('reports usage errors and conversion errors without echoing values', () => {
    const cases: Array<[string[], number, RegExp]> = [
      [[], 2, /first argument/],
      [['csv', 'amex.csv'], 2, /first argument/],
      [['amex-csv'], 2, /export file/],
      [['amex-csv', 'amex.csv', '--4111111111111111'], 2, /unknown option --\?/],
      [['amex-csv', 'amex.csv', '--date-format', 'mmddyyyy'], 2, /--date-format must be/],
      [['amex-csv', 'amex.csv', '--member', 'ALEX SAMPLE=bob'], 2, /--member must look like/],
      [['amex-csv', 'amex.csv', '--from', '2026-09-01'], 2, /together/],
      [['amex-csv', 'amex.csv', '--out', 'a', '--out', 'b'], 2, /once/],
      [['ofx', 'stmt.ofx'], 1, /--issuer/],
      [['amex-csv', 'missing.csv'], 1, /cannot read the export file: no such file/],
      [['amex-csv', 'stmt.ofx', '--status', 'posted'], 1, /does not look like an American Express CSV/],
      [['amex-csv', 'amex.csv'], 1, /^holdr-card-import: error: say whether this export's statement period has closed/],
      [['amex-csv', 'amex.csv', '--card', '90003'], 1, /exactly four digits/],
    ];
    for (const [args, code, message] of cases) {
      const { io, out } = memoryIo(files);
      assert.equal(runCardImportCli(args, io), code, args.join(' '));
      assert.match(out.stderr, message);
      assertNoCardData(out.stderr);
      assert.doesNotMatch(out.stderr, NAMES);
    }
    const help = memoryIo(files);
    assert.equal(runCardImportCli(['--help'], help.io), 0);
    assert.match(help.out.stdout, /Usage: holdr-card-import/);
    const version = memoryIo(files);
    assert.equal(runCardImportCli(['--version'], version.io), 0);
    assert.match(version.out.stdout, /^holdr-card-import 1\.0\.3 \(holdr\.card-import v1, dedupe v1\)\n$/);
  });
});

describe('card numbers split by dots, slashes or mixed separators, end to end', () => {
  it('never reach the JSON or the summary', () => {
    const csv = [
      'Date,Description,Amount',
      '09/14/2026,HOTEL 4111.1111 1111.1111,10.00',
      '09/15/2026,CAFE 4111.1111-1111.1111,4.50',
      '09/16/2026,SHOP 4111.1111.1111.1111,1.00',
      '09/17/2026,BOOKS 4111/1111/1111/1111,2.00',
    ].join('\n');
    const { json, payload } = convert(bytes(csv), { format: 'amex-csv' });
    for (const row of payload.rows) {
      const digits = row.description.replace(/\D/g, '');
      for (let i = 0; i + 5 <= 16; i += 1) assert.ok(!digits.includes('4111111111111111'.slice(i, i + 5)), row.description.slice(0, 5));
    }
    assertJsonSafe(json);
    const { io, out } = memoryIo({ 'x.csv': bytes(csv) });
    assert.equal(runCardImportCli(['amex-csv', 'x.csv', '--status', 'posted'], io), 0);
    assert.equal(out.stdout, json);
  });
});
