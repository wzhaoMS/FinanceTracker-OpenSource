import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findCardImportSensitivePaths, reconcileCardImport, validateCardImportPayload } from '../cardImport.js';
import {
  layoutA,
  layoutB,
  layoutC,
  pagesOf,
  SYNTHETIC_LAST4,
  SYNTHETIC_SENSITIVE,
  type Cell,
  type SyntheticStatement,
} from './__fixtures__/discoverStatements.js';
import {
  convertDiscoverStatements,
  DISCOVER_STATEMENT_PARSER,
  DiscoverConvertError,
  type DiscoverStatementFile,
} from './discoverStatements.js';
import { parseDiscoverStatement } from './discoverStatement.js';

/** An invented card's history: December (layout A), three months of layout B, a quiet year, a quiet month, then 2026 (C). */
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
const FEBRUARY: SyntheticStatement = {
  open: '2020-02-12', close: '2020-03-11', previousMinor: 3550,
  credits: [{ date: '02/20', description: 'DIRECTPAY FULL BALANCE', minor: 3550 }, { date: '02/25', description: 'CONTOSO COFFEE RETURN', minor: 1250 }],
};
/** The credit balance paid out: printed under Purchases, as Discover does. */
const MARCH: SyntheticStatement = {
  open: '2020-03-12', close: '2020-04-11', previousMinor: -1250,
  purchases: [{ date: '03/14', description: 'CREDIT BALANCE REFUND CHECK', category: 'Miscellaneous', minor: 1250 }],
};
const QUIET: SyntheticStatement = { open: '2021-06-12', close: '2021-07-11', previousMinor: 0 };
const C_2026 = { open: '2026-05-25', close: '2026-06-27', previousMinor: 0 };

const VALUES = ['CONTOSO', 'FABRIKAM', 'SAMPLE BOOKS', 'SEATTLE', 'DIRECTPAY', 'INTERNET PAYMENT', '17.34', '12.50', '23.00', '35.50', '25.00', '1734',
  '3550', ...SYNTHETIC_SENSITIVE];

let digests = 0;
const file = (cells: Cell[][], digest?: string): DiscoverStatementFile => {
  digests += 1;
  return { name: `file ${digests}`, digest: digest ?? `digest-${digests}`, pages: pagesOf(cells) };
};
const history = () => {
  digests = 0;
  return [file(layoutA(DECEMBER)), file(layoutB(JANUARY)), file(layoutB(FEBRUARY)), file(layoutB(MARCH)), file(layoutB(QUIET)), file(layoutC(C_2026))];
};

function expectValueFree(text: string) {
  for (const value of VALUES) assert.ok(!text.includes(value), `shows ${value}`);
}

describe('Discover statements to card-import payloads', () => {
  it('writes one payload per statement, each reconciled by the import\'s own check, oldest first, once the owner accepts the gaps', () => {
    const { report, payloads } = convertDiscoverStatements(history(), { card: SYNTHETIC_LAST4, acceptGaps: true });
    assert.deepEqual(report.statements, { read: 6, accepted: 6, held: 0, heldByReason: {}, reconciled: 6 });
    assert.deepEqual(report.layouts, { A: 1, B: 4, C: 1 });
    assert.deepEqual(report.periods, { first: '2019-12-12', last: '2026-06-27' });
    assert.deepEqual(report.rows, {
      total: 8,
      byKind: { purchase: 3, refund: 1, payment: 3, fee: 0, interest: 0, adjustment: 0, other: 1 },
      first: '2019-12-20',
      last: '2020-03-14',
    });
    assert.equal(report.noActivityStatements, 2);
    // January's coffee was bought before its period opened: that payload's coverage starts with it, inside December's.
    assert.equal(report.coverageWidened, 1);
    // A gap is never proven, even with a zero balance on both sides: accepted, its days stay uncovered.
    assert.deepEqual(report.continuity, {
      adjacent: 3,
      gaps: [
        { after: '2020-04-11', before: '2021-06-12', from: '2020-04-12', to: '2021-06-11', days: 426, balanceCarried: true, proven: false, accepted: true },
        { after: '2021-07-11', before: '2026-05-25', from: '2021-07-12', to: '2026-05-24', days: 1778, balanceCarried: true, proven: false, accepted: true },
      ],
      overlaps: 0,
      duplicates: 0,
      chainBreaks: 0,
      repeatedRows: 0,
    });
    // Coverage is the union of the statements' periods and never spans a gap: each gap is an uncovered window.
    assert.deepEqual(report.coverage, {
      ranges: [{ start: '2019-12-12', end: '2020-04-11' }, { start: '2021-06-12', end: '2021-07-11' }, { start: '2026-05-25', end: '2026-06-27' }],
      uncovered: [{ from: '2020-04-12', to: '2021-06-11', days: 426 }, { from: '2021-07-12', to: '2026-05-24', days: 1778 }],
    });
    for (const { payload } of payloads) {
      for (const gap of report.continuity.gaps) {
        assert.ok(payload.coverage.end < gap.from || payload.coverage.start > gap.to, `${payload.coverage.start}..${payload.coverage.end} spans a gap`);
      }
      assert.ok(payloads.some(({ period }) => period.start <= payload.coverage.start && period.end >= payload.coverage.start), 'coverage starts in no period');
    }
    assert.deepEqual(payloads.map((entry) => [entry.name, entry.period.start, entry.payload.coverage.start, entry.payload.coverage.end, entry.payload.rows.length]), [
      ['file 1', '2019-12-12', '2019-12-12', '2020-01-11', 2],
      ['file 2', '2020-01-12', '2020-01-02', '2020-02-11', 3],
      ['file 3', '2020-02-12', '2020-02-12', '2020-03-11', 2],
      ['file 4', '2020-03-12', '2020-03-12', '2020-04-11', 1],
      ['file 5', '2021-06-12', '2021-06-12', '2021-07-11', 0],
      ['file 6', '2026-05-25', '2026-05-25', '2026-06-27', 0],
    ]);
    for (const { payload, json } of payloads) {
      const checked = validateCardImportPayload(JSON.parse(json));
      assert.ok(checked.ok, JSON.stringify(checked));
      assert.deepEqual(findCardImportSensitivePaths(JSON.parse(json)), []);
      assert.deepEqual([payload.source, payload.parserVersion, payload.issuer, payload.currency, payload.owner, payload.cards, payload.rejectedCount],
        ['discover-statement', DISCOVER_STATEMENT_PARSER, 'discover', 'USD', null, [SYNTHETIC_LAST4], 0]);
      assert.equal(reconcileCardImport(payload.totals.posted, payload.statement).status, 'match');
      assert.ok(payload.rows.every((row) => row.status === 'posted' && row.externalIdHash === null && row.fingerprint !== null));
      for (const value of SYNTHETIC_SENSITIVE) assert.ok(!json.includes(value), `payload shows ${value}`);
    }
    const january = payloads[1].payload;
    assert.deepEqual(january.statement, { chargesMinor: 3550, creditsMinor: -1734, netMinor: null, previousBalanceMinor: 1734, newBalanceMinor: 3550 });
    assert.deepEqual(january.rows.map((row) => [row.transactionDate, row.postedDate, row.amountMinor, row.kind, row.description, row.issuerCategory]), [
      ['2020-01-20', null, -1734, 'payment', 'DIRECTPAY FULL BALANCE SEE DETAILS OF YOUR NEXT DIRECTPAY BELOW', null],
      ['2020-01-02', null, 1250, 'purchase', 'CONTOSO COFFEE', 'Restaurants'],
      ['2020-01-15', null, 2300, 'purchase', 'FABRIKAM MARKET #123 SEATTLE WA', 'Supermarkets'],
    ]);
    // Layout A keeps the post date; a merchant's credit is a refund; a credit balance paid out is listed, never counted.
    assert.deepEqual(payloads[0].payload.rows.map((row) => [row.postedDate, row.kind]), [['2019-12-20', 'payment'], ['2019-12-30', 'purchase']]);
    assert.deepEqual(payloads[2].payload.rows.map((row) => row.kind), ['payment', 'refund']);
    assert.deepEqual(payloads[3].payload.rows.map((row) => [row.kind, row.amountMinor]), [['other', 1250]]);
    expectValueFree(JSON.stringify(report));
  });

  it('is deterministic: the same statements make byte-identical payloads, in any order given', () => {
    const first = convertDiscoverStatements(history(), { card: SYNTHETIC_LAST4, acceptGaps: true });
    const second = convertDiscoverStatements(history().reverse(), { card: SYNTHETIC_LAST4, acceptGaps: true });
    assert.deepEqual(second.payloads.map((entry) => entry.json), first.payloads.map((entry) => entry.json));
  });

  it('holds the statement after each gap unless the owner accepts the gaps: no statement proves one empty', () => {
    const { report, payloads } = convertDiscoverStatements(history(), { card: SYNTHETIC_LAST4 });
    assert.deepEqual(report.statements, { read: 6, accepted: 4, held: 2, heldByReason: { 'unproven-gap': 2 }, reconciled: 6 });
    assert.deepEqual(report.files.filter((entry) => entry.status === 'held').map((entry) => [entry.name, entry.message]), [
      ['file 5', 'no statement covers the 426 days before it, and nothing proves they had no activity'],
      ['file 6', 'no statement covers the 1778 days before it, and nothing proves they had no activity'],
    ]);
    assert.deepEqual(report.continuity.gaps.map((gap) => [gap.proven, gap.accepted]), [[false, false], [false, false]]);
    assert.equal(payloads.length, 4);
    assert.deepEqual(report.coverage, { ranges: [{ start: '2019-12-12', end: '2020-04-11' }], uncovered: [] });
  });

  describe('holds a statement it cannot prove, and says why without a value', () => {
    const held = (files: DiscoverStatementFile[]) => {
      const { report, payloads } = convertDiscoverStatements(files, { card: SYNTHETIC_LAST4 });
      expectValueFree(JSON.stringify(report));
      return { report, payloads, outcome: (name: string) => report.files.find((entry) => entry.name === name)! };
    };

    it('the same file twice, or the same statement downloaded twice', () => {
      digests = 0;
      const same = held([file(layoutB(FEBRUARY), 'one'), file(layoutB(FEBRUARY), 'one')]);
      assert.deepEqual([same.outcome('file 2').reason, same.outcome('file 2').message], ['duplicate', 'the same file as file 1']);
      assert.equal(same.payloads.length, 1);
      digests = 0;
      const again = held([file(layoutB(FEBRUARY)), file(layoutB(FEBRUARY))]);
      assert.deepEqual([again.outcome('file 2').reason, again.report.continuity.duplicates], ['duplicate', 1]);
      assert.equal(again.payloads.length, 1);
    });

    it('a row two statements print alike, which the import would keep only once (review F255-4)', () => {
      const coffee = { date: '01/15', description: 'CONTOSO COFFEE', category: 'Restaurants', minor: 1250 };
      const statement = (open: string, close: string, purchase: typeof coffee, paid: string) => layoutB({
        open, close, previousMinor: 0, purchases: [purchase], credits: [{ date: paid, description: 'PAYMENT THANK YOU', minor: 1250 }],
      });
      digests = 0;
      // February lists a January coffee that posted late, the same date, amount and description as January's.
      const twice = held([file(statement('2021-01-01', '2021-01-31', coffee, '01/20')), file(statement('2021-02-01', '2021-02-28', coffee, '02/20'))]);
      assert.deepEqual([twice.outcome('file 1').reason, twice.outcome('file 2').reason, twice.report.continuity.repeatedRows, twice.payloads.length],
        ['duplicate', 'duplicate', 1, 0]);
      assert.match(twice.outcome('file 2').message!,
        /^file 1 page 3 line \d+ and file 2 page 3 line \d+ print the same row \(date, amount and description\): the import would keep only one of them$/);
      // The same coffee on another day is another row.
      digests = 0;
      const apart = held([file(statement('2021-01-01', '2021-01-31', coffee, '01/20')), file(statement('2021-02-01', '2021-02-28', { ...coffee, date: '02/15' }, '02/20'))]);
      assert.deepEqual([apart.report.statements.accepted, apart.report.continuity.repeatedRows], [2, 0]);
    });

    it('two statements of one period that disagree, or periods that overlap, nested ones included (review F255-3)', () => {
      digests = 0;
      const other = held([file(layoutB(JANUARY)), file(layoutB({ ...JANUARY, purchases: [JANUARY.purchases![0]] }))]);
      assert.deepEqual([other.outcome('file 1').reason, other.outcome('file 2').reason, other.payloads.length], ['overlap', 'overlap', 0]);
      digests = 0;
      const overlapping = held([file(layoutB(JANUARY)), file(layoutB({ ...FEBRUARY, open: '2020-02-01', close: '2020-03-11' }))]);
      assert.deepEqual([overlapping.outcome('file 1').reason, overlapping.outcome('file 2').reason], ['overlap', 'overlap']);
      assert.match(overlapping.outcome('file 1').message!, /its period overlaps file 2's/);
      digests = 0;
      // A long period overlaps two later ones that are not its neighbours in date order: every one is held.
      const quiet = (open: string, close: string) => file(layoutB({ open, close, previousMinor: 0 }));
      const nested = held([quiet('2021-01-01', '2021-03-31'), quiet('2021-01-02', '2021-01-03'), quiet('2021-02-01', '2021-02-28')]);
      assert.deepEqual(nested.report.files.map((entry) => [entry.status, entry.reason]), [['held', 'overlap'], ['held', 'overlap'], ['held', 'overlap']]);
      assert.deepEqual([nested.report.continuity.overlaps, nested.payloads.length], [2, 0]);
      // Two disagreeing statements of one long period still bound every period they contain, in any order (review F255-3b).
      const long = (minor: number) => layoutB({ open: '2021-01-01', close: '2021-03-31', previousMinor: 0,
        purchases: [{ date: '01/15', description: 'CONTOSO COFFEE', category: 'Restaurants', minor }],
        credits: [{ date: '01/20', description: 'PAYMENT THANK YOU', minor }] });
      const inside = layoutB({ open: '2021-02-01', close: '2021-02-28', previousMinor: 0 });
      for (const order of [[0, 1, 2], [2, 0, 1], [1, 2, 0]]) {
        digests = 0;
        const cells = [long(1250), long(1350), inside];
        const conflicted = held(order.map((index) => file(cells[index])));
        assert.deepEqual([conflicted.report.statements.held, conflicted.payloads.length], [3, 0], order.join());
        assert.deepEqual(conflicted.report.files.map((entry) => entry.reason), ['overlap', 'overlap', 'overlap'], order.join());
      }
      // A statement held for another reason still speaks for the period it prints: one it contains is held too. A
      // file whose period was never read, or another card's statement, bounds nothing.
      const unread = long(1250).map((cells) => cells.map((cell) => (cell[2] === '$12.50' ? [cell[0], cell[1], '$12.51'] as Cell : cell)));
      for (const order of [[0, 1], [1, 0]]) {
        digests = 0;
        const cells = [unread, inside];
        const bounded = held(order.map((index) => file(cells[index])));
        assert.deepEqual([bounded.report.files.map((entry) => entry.reason).sort(), bounded.payloads.length], [['overlap', 'reconciliation'], 0], order.join());
        assert.deepEqual(bounded.report.files.find((entry) => entry.reason === 'reconciliation')!.period, { start: '2021-01-01', end: '2021-03-31' });
      }
      digests = 0;
      const unrelated = held([file(layoutB({ ...JANUARY, open: '2021-01-01', close: '2021-03-31', last4: '4242', previousMinor: 0, credits: [], purchases: [] })),
        file([[[10, 700, 'not a statement']]]), file(inside)]);
      assert.deepEqual([unrelated.report.files.map((entry) => entry.reason), unrelated.payloads.length], [['other-card', 'not-a-statement', null], 1]);
    });

    it('adjacent statements whose balances do not chain', () => {
      digests = 0;
      const broken = held([file(layoutB(JANUARY)), file(layoutB({ ...FEBRUARY, previousMinor: 3551, credits: [{ ...FEBRUARY.credits![0], minor: 3551 }, FEBRUARY.credits![1]] }))]);
      assert.deepEqual([broken.outcome('file 1').reason, broken.outcome('file 2').reason, broken.report.continuity.chainBreaks], ['chain', 'chain', 1]);
      assert.match(broken.outcome('file 2').message!, /file 2's Previous Balance is not file 1's New Balance, though no day lies between them/);
    });

    it('a gap, even between zero balances: a month left out may have held a purchase and its payment (review F255-2)', () => {
      const january = layoutB({ open: '2021-01-01', close: '2021-01-31', previousMinor: 0 });
      const february = layoutB({
        open: '2021-02-01', close: '2021-02-28', previousMinor: 0,
        credits: [{ date: '02/20', description: 'PAYMENT THANK YOU', minor: 1250 }],
        purchases: [{ date: '02/10', description: 'CONTOSO COFFEE', category: 'Restaurants', minor: 1250 }],
      });
      const march = layoutB({ open: '2021-03-01', close: '2021-03-31', previousMinor: 0 });
      // Such a February reads whole and nets to nothing ...
      assert.equal(parseDiscoverStatement(pagesOf(february)).rows.length, 2);
      // ... so January and March alone prove nothing about it.
      digests = 0;
      const left = held([file(january), file(march)]);
      assert.deepEqual([left.outcome('file 1').status, left.outcome('file 2').reason], ['accepted', 'unproven-gap']);
      assert.deepEqual(left.report.continuity.gaps, [{
        after: '2021-01-31', before: '2021-03-01', from: '2021-02-01', to: '2021-02-28', days: 28, balanceCarried: true, proven: false, accepted: false,
      }]);
      // The owner may accept it as missing history: both are written, the gap stays uncovered.
      digests = 0;
      const accepted = convertDiscoverStatements([file(january), file(march)], { card: SYNTHETIC_LAST4, acceptGaps: true });
      assert.deepEqual([accepted.report.statements.accepted, accepted.payloads.map((entry) => entry.payload.coverage)],
        [2, [{ start: '2021-01-01', end: '2021-01-31' }, { start: '2021-03-01', end: '2021-03-31' }]]);
      assert.deepEqual(accepted.report.continuity.gaps.map((gap) => [gap.proven, gap.accepted]), [[false, true]]);
      assert.deepEqual(accepted.report.coverage.uncovered, [{ from: '2021-02-01', to: '2021-02-28', days: 28 }]);
      // A balance that changed across a gap proves a statement with activity is missing.
      digests = 0;
      const changed = held([file(layoutB(MARCH)), file(layoutB({ ...QUIET, previousMinor: 500 }))]);
      assert.equal(changed.outcome('file 2').reason, 'unproven-gap');
      assert.match(changed.outcome('file 2').message!, /a statement with activity is missing/);
      assert.deepEqual(changed.report.continuity.gaps.map((gap) => [gap.balanceCarried, gap.proven]), [[false, false]]);
    });

    it('coverage that would reach past the written statements\' periods: into a gap, or before the first (review F255-6)', () => {
      const quiet = (open: string, close: string) => layoutB({ open, close, previousMinor: 0 });
      const paid = (open: string, close: string, bought: string, paidOn: string) => layoutB({
        open, close, previousMinor: 0,
        purchases: [{ date: bought, description: 'CONTOSO COFFEE', category: 'Restaurants', minor: 1250 }],
        credits: [{ date: paidOn, description: 'PAYMENT THANK YOU', minor: 1250 }],
      });
      // March lists a coffee bought on February 15, in the gap: written, it would claim February 15 to 28 covered.
      digests = 0;
      const gap = convertDiscoverStatements([file(quiet('2021-01-01', '2021-01-31')), file(paid('2021-03-01', '2021-03-31', '02/15', '03/20'))],
        { card: SYNTHETIC_LAST4, acceptGaps: true });
      expectValueFree(JSON.stringify(gap.report));
      assert.deepEqual(gap.report.files.map((entry) => [entry.status, entry.reason]), [['accepted', null], ['held', 'coverage']]);
      assert.equal(gap.report.files[1].message, 'a row dated 14 days before its period would stretch its coverage back to 2021-02-15, over days no written statement covers');
      assert.deepEqual(gap.payloads.map((entry) => entry.payload.coverage), [{ start: '2021-01-01', end: '2021-01-31' }]);
      // The same row after a statement that covers its day widens nothing that is not covered: written.
      digests = 0;
      const covered = convertDiscoverStatements([file(quiet('2021-02-01', '2021-02-28')), file(paid('2021-03-01', '2021-03-31', '02/15', '03/20'))],
        { card: SYNTHETIC_LAST4 });
      assert.deepEqual([covered.report.statements.accepted, covered.report.coverageWidened, covered.report.coverage],
        [2, 1, { ranges: [{ start: '2021-02-01', end: '2021-03-31' }], uncovered: [] }]);
      // Before the first statement, and then every statement whose coverage leaned on one held: none is written.
      digests = 0;
      const cascade = convertDiscoverStatements([
        file(paid('2021-01-01', '2021-01-31', '12/20', '01/20')),
        file(paid('2021-02-01', '2021-02-28', '01/25', '02/20')),
        file(paid('2021-03-01', '2021-03-31', '02/25', '03/20')),
      ], { card: SYNTHETIC_LAST4 });
      assert.deepEqual(cascade.report.files.map((entry) => entry.reason), ['coverage', 'coverage', 'coverage']);
      assert.deepEqual([cascade.payloads.length, cascade.report.coverage], [0, { ranges: [], uncovered: [] }]);
    });

    it('another card\'s statement, and a statement its reader refuses', () => {
      digests = 0;
      const mixed = held([file(layoutB({ ...JANUARY, last4: '4242' })), file(layoutB({ ...JANUARY, previousMinor: 1 }).map((cells) => cells.map((cell) => (
        cell[2] === '$0.01' ? [cell[0], cell[1], '$0.02'] as Cell : cell))))]);
      assert.deepEqual([mixed.outcome('file 1').reason, mixed.outcome('file 1').message], ['other-card', `the statement is for the card ending 4242, not ${SYNTHETIC_LAST4}`]);
      assert.equal(mixed.outcome('file 2').reason, 'reconciliation');
      assert.deepEqual([mixed.report.statements.accepted, mixed.report.statements.reconciled, mixed.report.statements.heldByReason],
        [0, 0, { 'other-card': 1, reconciliation: 1 }]);
    });
  });

  it('refuses options it cannot use', () => {
    assert.throws(() => convertDiscoverStatements(history(), { card: '11170' }), DiscoverConvertError);
    assert.throws(() => convertDiscoverStatements([], { card: SYNTHETIC_LAST4 }), DiscoverConvertError);
  });
});
