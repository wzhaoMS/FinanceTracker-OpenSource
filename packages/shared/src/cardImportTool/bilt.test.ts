import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateCardImportPayload } from '../cardImport.js';
import { containsCardData } from '../cardNumbers.js';
import { containsLongDigitRun } from '../cardText.js';
import { BILT_HOUSING_CATEGORY } from './biltCsv.js';
import { runCardImportCli, type CliIo } from './cli.js';
import { convertCardExport, ConvertError, type ConvertOptions } from './convert.js';

const fixture = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));
const fixtureText = () => new TextDecoder().decode(fixture('bilt-activity.csv'));
const TEST_PANS = ['4111111111111111', '5555555555554444'];
/** bilt.com's export header, verbatim (2026-10). */
const HEADER = 'Transaction Date,Posted Date,Description,Amount,Card Last 4,Name on Card,Raw Merchant Name';
const NAME = 'SAMPLE CARDHOLDER';

interface SyntheticRow {
  date: string;
  posted?: string;
  description: string;
  amount: string;
  card?: string;
  raw?: string;
  name?: string;
}

/** A synthetic Bilt CSV with the export's columns; a row without a card is account-level, as Bilt writes payments. */
function biltCsv(rows: readonly SyntheticRow[], header = HEADER): Uint8Array {
  const quote = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return bytes(`${[header, ...rows.map((row) => [
    row.date, row.posted ?? row.date, row.description, row.amount, row.card ?? '',
    row.card === undefined ? '' : row.name ?? NAME, row.raw ?? '',
  ].map(quote).join(','))].join('\r\n')}\r\n`);
}

const PURCHASE: SyntheticRow = { date: '2026-03-02', posted: '2026-03-03', description: 'Northwind Grocery', amount: '42.10', card: '1111', raw: 'NORTHWIND GROC 0042' };
const PAYMENT: SyntheticRow = { date: '2026-03-10', description: 'Payment', amount: '-965.21' };
const HOUSING_CHARGE: SyntheticRow = { date: '2026-03-31', description: 'Bilt Housing Payment', amount: '2450.00', card: '2222', raw: 'BILT HOUSING' };
const HOUSING_FUNDING: SyntheticRow = { date: '2026-03-31', description: 'Bilt Housing Payment', amount: '-2450.00' };

const base: Partial<ConvertOptions> & Pick<ConvertOptions, 'format'> = { format: 'bilt-csv', status: 'export', loanPayments: 'not-spending' };
function convert(file: Uint8Array, options: Partial<ConvertOptions> = {}) {
  return convertCardExport(file, { ...base, ...options });
}

function assertNoPrivateText(text: string): void {
  assert.doesNotMatch(text, /\d{13}/);
  assert.equal(containsLongDigitRun(text), false);
  assert.ok(!text.includes(NAME), 'shows the name on the card');
  for (const pan of TEST_PANS) {
    for (let i = 0; i + 5 <= pan.length; i += 1) assert.ok(!text.includes(pan.slice(i, i + 5)), 'exposes five digits of a test card number');
  }
}

function assertJsonSafe(json: string): void {
  assertNoPrivateText(json);
  const parsed = JSON.parse(json);
  for (const row of parsed.rows) {
    for (const field of ['description', 'merchant', 'issuerCategory']) {
      if (row[field] !== null) assert.equal(containsCardData(row[field]), false, field);
    }
  }
  assert.ok(validateCardImportPayload(parsed).ok);
}

function memoryIo(files: Record<string, Uint8Array>) {
  const out = { stdout: '', stderr: '', written: new Map<string, string>() };
  const io: CliIo = {
    readFile(path) {
      const file = files[path];
      if (!file) throw new Error('no such file');
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

describe('Bilt CSV (bilt.com Download as CSV)', () => {
  it('reads the export\'s seven columns: exact amounts, payments, fees, refunds and the housing charge its payment clears', () => {
    const { json, payload, report } = convert(fixture('bilt-activity.csv'));
    assertJsonSafe(json);
    assert.deepEqual([payload.source, payload.issuer, payload.currency, payload.owner, payload.cards], ['bilt-csv', 'bilt', 'USD', null, []]);
    assert.deepEqual(payload.rows.map((row) => [row.transactionDate, row.postedDate, row.status, row.amountMinor, row.kind, row.description, row.merchant, row.issuerCategory]), [
      ['2026-03-02', '2026-03-03', 'posted', 4210, 'purchase', 'NORTHWIND GROC 0042', 'Northwind Grocery', null],
      ['2026-03-03', '2026-03-04', 'posted', 1850, 'purchase', 'PROSEWARE BISTRO', null, null],
      ['2026-03-03', '2026-03-04', 'posted', 1850, 'purchase', 'PROSEWARE BISTRO', null, null],
      ['2026-03-07', '2026-03-08', 'posted', -1200, 'refund', 'FABRIKAM BOOKS 7', 'Fabrikam Books', null],
      ['2026-03-10', '2026-03-10', 'posted', -96521, 'payment', 'Payment', null, null],
      ['2026-03-12', '2026-03-12', 'posted', 49500, 'fee', 'Annual Fee', null, null],
      ['2026-03-31', '2026-03-31', 'posted', 245000, 'other', 'BILT HOUSING', 'Bilt Housing Payment', BILT_HOUSING_CATEGORY],
      ['2026-03-31', '2026-03-31', 'posted', -245000, 'payment', 'Bilt Housing Payment', null, BILT_HOUSING_CATEGORY],
      ['2026-04-02', '2026-04-03', 'posted', -30000, 'payment', 'Pay card', null, null],
      ['2026-04-05', '2026-04-06', 'posted', 8800, 'purchase', 'BUDGET RENT A CAR', null, null],
      ['2026-04-08', '2026-04-09', 'posted', 31240, 'purchase', 'TAILSPIN TRVL 7781', 'Tailspin Travel', null],
    ]);
    // Every row has a posted date, so each is keyed by a reference made from it (hashed); two identical
    // purchases on one day are both kept, under different keys.
    const keys = payload.rows.map((row) => row.externalIdHash);
    assert.ok(payload.rows.every((row) => row.externalIdHash !== null && row.fingerprint === null));
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(report.droppedColumns, ['Name on Card']);
    assert.deepEqual([report.rowsRead, payload.rejectedCount], [11, 0]);
    assert.deepEqual([payload.totals.posted.count, payload.totals.posted.chargesMinor, payload.totals.posted.creditsMinor], [11, 342450, -372721]);
    assert.equal(payload.totals.pending.count, 0);
    assert.deepEqual(report.housing, { choice: 'not-spending', count: 1, posted: 1, pending: 0, chargesMinor: 245000, creditsMinor: 0 });
    assert.deepEqual([report.status.basis, report.status.posted, report.status.pending, report.status.period], ['export', 11, 0, 'unknown']);
    assert.deepEqual(payload.coverage, { start: '2026-03-03', end: '2026-04-09' });
    assert.deepEqual(report.notes, [
      'rows by card (last 4, never written): 1111 6, 2222 1, account-level 4',
      '3 account-level rows were written as card payments (their Description says pay or payment, or they fund a housing charge)',
      '1 housing charge, each cleared the same day by an equal payment from the bank',
    ]);
  });

  it('never reads Name on Card: not written, not printed, and its text cannot refuse a row', () => {
    const file = biltCsv([{ ...PURCHASE, name: 'CARD 4111 1111 1111 1111 CVV 123' }, PAYMENT]);
    const { json, report } = convert(file);
    assertJsonSafe(json);
    assert.doesNotMatch(json + JSON.stringify(report), /CVV|4111/);
    assert.throws(() => convert(file, { members: [{ name: NAME, owner: 'alex' }] }), /no Card Member column/);
  });

  it('take payments from the export\'s layout: account-level rows that say pay or payment, never refunds', () => {
    const file = biltCsv([
      PURCHASE,
      { date: '2026-03-10', description: 'Payment', amount: '-100.00' },
      { date: '2026-03-11', description: 'Pay card', amount: '-200.00' },
      { date: '2026-03-12', description: 'Payment Autopay', amount: '-300.00' },
      { date: '2026-03-13', description: 'Payment returned', amount: '300.00' },
      // An account-level credit that is no payment, and a card-level credit that mentions one, keep their text classification.
      { date: '2026-03-14', description: 'Credit Adjustment', amount: '-5.00' },
      { date: '2026-03-15', description: 'Sample payment processing refund', amount: '-7.00', card: '1111', raw: 'SAMPLE PAYMENTS CO' },
    ]);
    assert.deepEqual(convert(file).payload.rows.map((row) => [row.amountMinor, row.kind]), [
      [4210, 'purchase'],
      [-10000, 'payment'], [-20000, 'payment'], [-30000, 'payment'], [30000, 'payment'], [-500, 'refund'], [-700, 'refund'],
    ]);
    // Bilt writes money spent positive; an export whose payments are mostly positive is refused, never flipped.
    const flipped = biltCsv([{ ...PURCHASE, amount: '-42.10' }, { ...PAYMENT, amount: '965.21' }, { date: '2026-03-11', description: 'Pay card', amount: '200.00' }]);
    assert.throws(() => convert(flipped), /2 of 2 payments to the card are positive amounts, the opposite of Bilt's sign/);
  });

  it('take a card charge worded as a payment, in either text, for a purchase unless it says the payment was returned', () => {
    const file = biltCsv([
      PURCHASE,
      // A bill paid with the card: payment wording only in Bilt's Description, or only in the Raw Merchant Name.
      { date: '2026-03-04', description: 'Online payment', amount: '45.00', card: '1111', raw: 'SYNTHETIC UTILITY CO' },
      { date: '2026-03-05', description: 'Synthetic Water', amount: '30.00', card: '1111', raw: 'WEB PAYMENT SYNTHETIC WATER' },
      // A payment returned, said in either text, and in a compound payment word too.
      { date: '2026-03-06', description: 'Payment returned', amount: '120.00', card: '1111', raw: 'SYNTHETIC BANK' },
      { date: '2026-03-07', description: 'Synthetic Bank', amount: '80.00', card: '1111', raw: 'RETURNED PAYMENT' },
      { date: '2026-03-08', description: 'AUTOPYMT REVERSAL', amount: '60.00', card: '1111', raw: 'SYNTHETIC LENDER' },
      { date: '2026-03-08', description: 'Synthetic Lender', amount: '70.00', card: '1111', raw: 'RETURNED AUTOPAYMENT' },
      // A compound payment word alone on a card charge: a bill paid with the card.
      { date: '2026-03-09', description: 'Autopmt', amount: '25.00', card: '1111', raw: 'SYNTHETIC GYM' },
      // Account-level rows that say payment are the payments Bilt's layout settles first, whatever their sign or other words.
      { date: '2026-03-10', description: 'Payment', amount: '-965.21' },
      { date: '2026-03-11', description: 'Online payment', amount: '45.00' },
      // A card credit worded as a payment is a card payment, as before.
      { date: '2026-03-12', description: 'Online payment', amount: '-20.00', card: '1111', raw: 'SYNTHETIC UTILITY CO' },
    ]);
    const { payload } = convert(file);
    assert.deepEqual(payload.rows.map((row) => [row.amountMinor, row.kind]), [
      [4210, 'purchase'], [4500, 'purchase'], [3000, 'purchase'], [12000, 'payment'], [8000, 'payment'], [6000, 'payment'], [7000, 'payment'],
      [2500, 'purchase'], [-96521, 'payment'], [4500, 'payment'], [-2000, 'payment'],
    ]);
    assert.deepEqual(payload.totals.posted.byKind.purchase, { count: 4, amountMinor: 14210 });
  });

  it('pair each housing charge with the payment that clears it the same day, and ask the owner how the charge counts', () => {
    assert.throws(() => convert(fixture('bilt-activity.csv'), { loanPayments: null }), (error: Error) => {
      assert.ok(error instanceof ConvertError);
      assert.match(error.message, /this export marks 1 row as housing payments/);
      assert.match(error.message, /--loan-payments spending/);
      assert.match(error.message, /--loan-payments not-spending/);
      return true;
    });
    const spending = convert(fixture('bilt-activity.csv'), { loanPayments: 'spending' });
    const notSpending = convert(fixture('bilt-activity.csv'), { loanPayments: 'not-spending' });
    assert.deepEqual([spending.payload.rows[6].kind, notSpending.payload.rows[6].kind], ['purchase', 'other']);
    // The payment that clears it is a card payment either way, and only the charge's kind differs: same keys.
    assert.deepEqual([spending.payload.rows[7].kind, notSpending.payload.rows[7].kind], ['payment', 'payment']);
    const withoutKind = (rows: typeof spending.payload.rows) => rows.map(({ kind: _kind, ...rest }) => rest);
    assert.deepEqual(withoutKind(spending.payload.rows), withoutKind(notSpending.payload.rows));

    // A rent or mortgage word on a card row is a housing charge only with its same-day, same-size payment.
    const rental = { date: '2026-04-05', posted: '2026-04-06', description: 'Budget Rent A Car', amount: '88.00', card: '1111', raw: 'BUDGET RENT A CAR' };
    const mortgage = { date: '2026-05-01', description: 'Sample Mortgage Servicing', amount: '1800.00', card: '2222', raw: 'SAMPLE MORTGAGE' };
    const mortgageFunding = { date: '2026-05-01', description: 'Housing payment', amount: '-1800.00' };
    const paired = convert(biltCsv([rental, mortgage, mortgageFunding]));
    assert.deepEqual(paired.payload.rows.map((row) => [row.kind, row.issuerCategory]), [
      ['purchase', null], ['other', BILT_HOUSING_CATEGORY], ['payment', BILT_HOUSING_CATEGORY],
    ]);
    // Not the same day, or not the same size: no pair, so no housing charge (and no answer needed).
    for (const funding of [{ ...mortgageFunding, date: '2026-05-02' }, { ...mortgageFunding, amount: '-1799.99' }]) {
      const unpaired = convert(biltCsv([mortgage, funding]), { loanPayments: null });
      assert.deepEqual(unpaired.payload.rows.map((row) => row.kind), ['purchase', 'payment']);
      assert.equal(unpaired.report.housing!.count, 0);
    }
    // One payment clears one charge.
    const twice = convert(biltCsv([mortgage, { ...mortgage, card: '1111' }, mortgageFunding]));
    assert.deepEqual(twice.payload.rows.map((row) => row.kind), ['other', 'purchase', 'payment']);
    // A Bilt housing row without its payment in the file (a download range that splits the pair) is refused, never guessed.
    assert.throws(() => convert(biltCsv([PURCHASE, HOUSING_CHARGE])), (error: Error) => {
      assert.ok(error instanceof ConvertError);
      assert.deepEqual(error.problems, [{ line: 3, reason: 'is a Bilt housing row without the same-day payment that funds it in this file; download a range that holds both' }]);
      return true;
    });
    // Its payment alone is still a card payment.
    assert.deepEqual(convert(biltCsv([HOUSING_FUNDING]), { loanPayments: null }).payload.rows.map((row) => row.kind), ['payment']);
    // A file without housing charges needs no answer, and other formats refuse one.
    assert.equal(convert(biltCsv([PURCHASE, PAYMENT]), { loanPayments: null }).report.housing!.count, 0);
    assert.throws(() => convertCardExport(fixture('amex-basic.csv'), { format: 'amex-csv', status: 'posted', loanPayments: 'spending' }),
      /--loan-payments applies to bilt-csv exports only/);
  });

  it('write every row posted, as the export shows, or split at the newest closing date; a row without a Posted Date refuses the file', () => {
    const blank = { date: '2026-03-12', posted: '', description: 'Tailspin Travel', amount: '312.40', card: '1111', raw: 'TAILSPIN TRVL 7781' };
    const file = biltCsv([PURCHASE, blank, { ...blank, date: '2026-03-13' }]);
    // A blank Posted Date counts before any other check of its row: a row that is also invalid otherwise (here a
    // date that does not exist), or cut off before its Posted Date, cannot be dropped by --skip-invalid instead.
    const alsoInvalid = bytes(`${HEADER}\r\n2026-03-02,2026-03-03,Northwind Grocery,42.10,1111,${NAME},NORTHWIND GROC 0042\r\n`
      + `2026-02-30,,Tailspin Travel,312.40,1111,${NAME},TAILSPIN TRVL 7781\r\n2026-03-13\r\n2026-03-14,,Shop,1.00,1111\r\n`
      + `2026-03-15,,Shop,2.00,1111,${NAME},SHOP,EXTRA\r\n`);
    for (const options of [{}, { skipInvalid: true }]) {
      assert.throws(() => convert(alsoInvalid, options), /^ExportFormatError: 4 rows have no Posted Date/, JSON.stringify(options));
    }
    // bilt-csv is posted-only: an authorization's key could never match its posted row's, so nothing is written,
    // whatever the status asked for and with --skip-invalid too; the message counts rows and names no value.
    for (const options of [{}, { status: 'posted' as const }, { status: 'pending' as const }, { status: null, closedThrough: '2026-03-02' }, { skipInvalid: true }]) {
      assert.throws(() => convert(file, options), (error: Error) => {
        assert.equal(error.message, '2 rows have no Posted Date: a Bilt export is imported only when every row has posted (an authorization '
          + 'could not be matched to its posted row later); download the range again once they have posted');
        return true;
      }, JSON.stringify(options));
    }
    const { io, out } = memoryIo({ 'bilt.csv': file });
    assert.equal(runCardImportCli(['bilt-csv', 'bilt.csv', '--status', 'export', '--skip-invalid', '--out', 'bilt.json'], io), 1);
    assert.equal(out.written.size, 0);
    assert.match(out.stderr, /error: 2 rows have no Posted Date/);
    assertNoPrivateText(out.stderr);

    assert.throws(() => convert(fixture('bilt-activity.csv'), { status: null }), (error: Error) => {
      assert.match(error.message, /^say whether this export's statement period has closed/);
      assert.match(error.message, /for an OFX file or a Bilt export, --closed-through YYYY-MM-DD/);
      assert.match(error.message, /--status export writes every row as posted, as its Posted Date shows/);
      return true;
    });
    const exported = convert(fixture('bilt-activity.csv'));
    assert.deepEqual(new Set(exported.payload.rows.map((row) => row.status)), new Set(['posted']));
    assert.equal(convert(fixture('bilt-activity.csv'), { status: 'posted' }).json, exported.json);
    // All pending, or rows posted after the newest statement's closing date pending: the keys their posted rows will have.
    const keysOf = (result: typeof exported) => result.payload.rows.map((row) => row.externalIdHash);
    const pending = convert(fixture('bilt-activity.csv'), { status: 'pending' });
    assert.deepEqual(new Set(pending.payload.rows.map((row) => row.status)), new Set(['pending']));
    assert.deepEqual(keysOf(pending), keysOf(exported));
    const split = convert(fixture('bilt-activity.csv'), { status: null, closedThrough: '2026-04-05' });
    assert.deepEqual(split.payload.rows.map((row) => row.status), [...Array(9).fill('posted'), 'pending', 'pending']);
    assert.deepEqual(keysOf(split), keysOf(exported));
    assert.throws(() => convert(fixture('bilt-activity.csv'), { status: null, closedThrough: '2026-04-09' }), /is not before the newest date in this export/);
    assert.throws(() => convertCardExport(fixture('amex-basic.csv'), { format: 'amex-csv', status: 'export' }), /--status export needs an export that shows/);
  });

  it('write byte-identical JSON on every run, and key overlapping downloads alike even when Transaction Date moves a day', () => {
    const whole = convert(fixture('bilt-activity.csv'));
    assert.equal(convert(fixture('bilt-activity.csv')).json, whole.json);
    const keysOf = (result: typeof whole) => result.payload.rows.map((row) => row.externalIdHash);
    // The same file with LF line ends, and a shorter download of the same whole days, key alike.
    assert.equal(convert(bytes(fixtureText().replace(/\r\n/g, '\n'))).json, whole.json);
    const lines = fixtureText().trimEnd().split('\r\n');
    assert.deepEqual(keysOf(convert(bytes([lines[0], ...lines.slice(2, 6)].join('\r\n')))), keysOf(whole).slice(1, 5));
    // A download whose time zone moves a row's Transaction Date a day keeps its key: posted date, amount and text.
    const moved = convert(bytes(fixtureText().replace('2026-03-07,2026-03-08,Fabrikam', '2026-03-08,2026-03-08,Fabrikam')));
    assert.equal(moved.payload.rows[3].transactionDate, '2026-03-08');
    assert.deepEqual(keysOf(moved), keysOf(whole));
    // Another posted date, amount or text is another row.
    for (const changed of ['2026-03-07,2026-03-09,Fabrikam Books,-12.00', '2026-03-07,2026-03-08,Fabrikam Books,-12.01']) {
      const other = convert(bytes(fixtureText().replace(/2026-03-07,2026-03-08,Fabrikam Books,-12\.00/, changed)));
      assert.notEqual(keysOf(other)[3], keysOf(whole)[3]);
    }
    assert.ok(whole.payload.rows.every((row) => row.externalIdHash !== null && row.fingerprint === null));
    assert.throws(() => convert(fixture('bilt-activity.csv'), { ignoreIds: true }), /--ignore-ids does not apply to bilt-csv/);
  });

  it('redact card numbers and refuse card secrets in either text column, naming lines but never values', () => {
    const file = biltCsv([
      { ...PURCHASE, description: 'Sample Store 4111 1111 1111 1111', raw: 'SAMPLE STORE' },
      { ...PURCHASE, description: 'Sample Order', raw: 'ORD 12345678901234567' },
    ]);
    const { json, payload, report } = convert(file);
    assertJsonSafe(json);
    assert.deepEqual(payload.rows.map((row) => [row.description, row.merchant]), [['SAMPLE STORE', 'Sample Store ***1111'], ['ORD ***4567', 'Sample Order']]);
    assert.equal(report.redactedRows, 2);
    const secret = biltCsv([PAYMENT, { ...PURCHASE, description: 'Shop', raw: 'SHOP CVV 321' }]);
    for (const skipInvalid of [false, true]) {
      assert.throws(() => convert(secret, { skipInvalid }), (error: Error) => {
        assert.ok(error instanceof ConvertError);
        assert.deepEqual(error.problems.map((problem) => problem.line), [3]);
        assert.match(error.problems[0].reason, /^description must not contain a card security code, PIN or expiry date/);
        assert.doesNotMatch(error.message + JSON.stringify(error.problems), /321|CVV/);
        return true;
      });
    }
  });

  it('refuse other headers and bad rows, naming lines and columns only', () => {
    assert.throws(() => convert(bytes('Date,Description,Amount\r\n2026-03-02,SHOP,1.00\r\n')),
      /does not look like a Bilt card CSV export: .*\(missing Transaction Date, Posted Date, Card Last 4, Raw Merchant Name\)/);
    assert.throws(() => convert(bytes(`${HEADER},Amount\r\n`)), /more than one Amount column/);
    const extra = convert(bytes(`${HEADER},Rewards Earned\r\n2026-03-02,2026-03-03,Northwind Grocery,42.10,1111,${NAME},NORTHWIND GROC 0042,126\r\n`));
    assert.deepEqual(extra.report.droppedColumns, ['Name on Card', 'Rewards Earned']);
    assert.doesNotMatch(extra.json, /126/);
    const bad = biltCsv([
      PURCHASE,
      { ...PURCHASE, date: '2026-02-30' },
      { ...PURCHASE, posted: '2026-03-01' },
      { ...PURCHASE, amount: '1,042.10' },
      { ...PURCHASE, amount: '$42.10' },
      { ...PURCHASE, amount: '42.105' },
      { ...PURCHASE, card: '11' },
      { ...PURCHASE, description: '', raw: '' },
    ]);
    assert.throws(() => convert(bad), (error: Error) => {
      assert.ok(error instanceof ConvertError);
      assert.deepEqual(error.problems.map((problem) => [problem.line, problem.reason]), [
        [3, 'Transaction Date is not a valid date'], [4, 'Posted Date is before Transaction Date'], [5, 'Amount is not a number'],
        [6, 'Amount is not a number'], [7, 'Amount has more than 2 decimal places'], [8, 'Card Last 4 is not four digits'],
        [9, 'Description and Raw Merchant Name are both empty'],
      ]);
      return true;
    });
    assert.deepEqual([convert(bad, { skipInvalid: true }).payload.rows.length, convert(bad, { skipInvalid: true }).payload.rejectedCount], [1, 7]);
    assert.throws(() => convert(bytes(`${HEADER}\r\n2026-03-02,2026-03-03,Shop,1.00,1111\r\n`)), (error: Error) => error instanceof ConvertError
      && error.problems[0].reason === 'has 5 columns, the header has 7 (the file may be truncated)');
    assert.throws(() => convert(fixture('bilt-activity.csv'), { issuer: 'wellsfargo' }), /bilt-csv exports are always issuer bilt/);
    assert.throws(() => convert(fixture('bilt-activity.csv'), { cards: ['2310'] }), /--card is not supported for bilt-csv/);
  });

  it('check statement figures against the posted rows', () => {
    const match = convert(fixture('bilt-activity.csv'), { expected: { previousBalance: '1,000.00', newBalance: '697.29' } });
    assert.equal(match.report.reconciliation.status, 'match');
    assert.equal(convert(fixture('bilt-activity.csv'), { expected: { charges: '1.00' } }).report.reconciliation.status, 'mismatch');
  });
});

describe('Bilt CSV on the command line', () => {
  it('prints the housing decision, statuses and per-card counts, never names, descriptions or cell text', () => {
    const { io, out } = memoryIo({ 'bilt.csv': fixture('bilt-activity.csv') });
    const status = runCardImportCli(['bilt-csv', 'bilt.csv', '--status', 'export', '--loan-payments', 'not-spending', '--out', 'bilt.json'], io);
    assert.equal(status, 0, out.stderr);
    assert.equal(out.written.get('bilt.json'), convert(fixture('bilt-activity.csv')).json);
    assert.match(out.stderr, /^holdr-card-import 1\.0\.3: bilt-csv, issuer bilt, USD/);
    assert.match(out.stderr, /\nRows: 11 read, 11 kept, 0 rejected\n/);
    assert.match(out.stderr, /\nDropped columns: Name on Card\n/);
    assert.match(out.stderr, /\nStatus: as the export marks each row \(--status export\): 11 settled rows posted, 0 pending rows pending\n/);
    assert.match(out.stderr, /\nHousing payments: 1 rows \(1 posted, 0 pending\), charges 2,450\.00, credits 0\.00: not spending \(--loan-payments not-spending/);
    assert.match(out.stderr, /\nNote: rows by card \(last 4, never written\): 1111 6, 2222 1, account-level 4\n/);
    assertNoPrivateText(out.stderr);
    assert.doesNotMatch(out.stderr, /Northwind|NORTHWIND|Proseware|Tailspin|Budget|Fabrikam/i);

    const missing = memoryIo({ 'bilt.csv': fixture('bilt-activity.csv') });
    assert.equal(runCardImportCli(['bilt-csv', 'bilt.csv', '--status', 'export', '--out', 'bilt.json'], missing.io), 1);
    assert.equal(missing.out.written.size, 0);
    assert.match(missing.out.stderr, /error: this export marks 1 row as housing payments/);
    const usage = memoryIo({ 'x.csv': fixture('amex-basic.csv') });
    assert.equal(runCardImportCli(['amex-csv', 'x.csv', '--status', 'posted', '--loan-payments', 'spending'], usage.io), 2);
    assert.match(usage.out.stderr, /--loan-payments applies to bilt-csv only/);
    const exportElsewhere = memoryIo({ 'x.csv': fixture('amex-basic.csv') });
    assert.equal(runCardImportCli(['amex-csv', 'x.csv', '--status', 'export'], exportElsewhere.io), 2);
    assert.match(exportElsewhere.out.stderr, /--status must be one of posted, pending\n/);
    const wrong = memoryIo({ 'bilt.csv': fixture('bilt-activity.csv') });
    assert.equal(runCardImportCli(['bilt-csv', 'bilt.csv', '--status', 'export', '--loan-payments', 'maybe'], wrong.io), 2);
    assert.match(wrong.out.stderr, /--loan-payments must be one of spending, not-spending/);
  });
});
