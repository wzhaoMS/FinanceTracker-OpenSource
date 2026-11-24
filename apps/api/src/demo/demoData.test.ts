import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aggregatePositions, classifyCheckingDebit, validateCheckingImportPayload } from '@finance-tracker/shared';
import type { MetalsLine } from '@finance-tracker/shared/metals-ledger';

import { verifyPassword } from '../auth/password.js';
import { cashOwedView } from '../services/cashOwed.js';
import { createCheckingLedgerReader } from '../services/checking/ledger.js';
import { LocalAuthRepo } from '../services/localAuthRepo.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import {
  DEMO_CARDS,
  DEMO_CHECKING,
  DEMO_METALS_CARD_LAST4,
  DEMO_SPENDING_MONTHS,
  DEMO_USER,
  buildDemoHousehold,
  buildDemoSpending,
} from './demoData.js';
import { DEMO_MARKER, assertDemoDataDir, assertOnlyDemoData, prepareDemoDataDir, resetDemoPassword, seedDemoDataDir } from './demoSeed.js';
import { addDays } from './demoCalendar.js';
import { DEMO_MONTHLY_CONTRIBUTIONS } from './demoInvesting.js';

// The demo household (npm run demo): the same data for the same day, only ever written to a new folder, and
// synthetic throughout. Owner identifiers are never written here: they come from the local, git-ignored
// .privacy-scan.local list and PRIVACY_SCAN_BLOCKLIST, as for scripts/privacy-scan.mjs.

const NOW = new Date('2026-03-18T15:30:00Z');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MARKER_TEXT = 'Holdr demo data (synthetic). Safe to delete.\n';

function blocklist(): string[] {
  const local = path.join(REPO_ROOT, '.privacy-scan.local');
  const text = [process.env.PRIVACY_SCAN_BLOCKLIST ?? '', fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : ''].join('\n');
  return text.split(/[\r\n,]+/).map((line) => line.replace(/#.*/, '').trim().toLowerCase()).filter((term) => term.length >= 3);
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdr-demo-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the demo household', () => {
  it('is the same for the same day and moves with the day', () => {
    expect(JSON.stringify(buildDemoHousehold(NOW))).toBe(JSON.stringify(buildDemoHousehold(new Date(NOW))));
    const later = buildDemoSpending('2026-04-18');
    expect(later.coverage).toEqual({ start: '2025-01-01', end: '2026-04-18' });
    expect(buildDemoSpending('2026-03-18').coverage).toEqual({ start: '2024-12-01', end: '2026-03-18' });
    // Anchored on the New York date: 01:30 UTC is still the evening before there.
    expect(buildDemoHousehold(new Date('2026-03-19T01:30:00Z')).today).toBe('2026-03-18');
  });

  it('has fifteen months of everyday spending on five cards, with refunds, payments, credits, fees and pending charges', () => {
    const { spending, today } = buildDemoHousehold(NOW);
    const { rows, coverage } = spending;
    expect(new Set(rows.map((row) => row.transactionDate.slice(0, 7))).size).toBe(DEMO_SPENDING_MONTHS + 1);
    expect(rows.every((row) => row.transactionDate >= coverage.start && row.transactionDate <= today)).toBe(true);
    expect(rows.every((row) => Number.isSafeInteger(row.amountMinor) && row.currency === 'USD')).toBe(true);
    expect(new Set(rows.map((row) => row.card))).toEqual(new Set(DEMO_CARDS.map((card) => card.key)));
    const kinds = new Set(rows.map((row) => row.kind));
    for (const kind of ['purchase', 'refund', 'payment', 'adjustment', 'fee']) expect(kinds).toContain(kind);
    expect(rows.filter((row) => row.kind === 'refund').every((row) => row.amountMinor < 0)).toBe(true);
    expect(rows.filter((row) => row.kind === 'payment').every((row) => row.amountMinor < 0)).toBe(true);
    expect(rows.some((row) => row.status === 'pending')).toBe(true);
    const categories = new Set(rows.map((row) => row.issuerCategory));
    for (const category of ['Merchandise & Supplies-Groceries', 'Restaurant-Restaurant', 'Transportation-Fuel', 'Travel-Airline',
      'Entertainment-Streaming Services', 'Merchandise & Supplies-Internet Purchase', 'Utilities-Electric & Water']) {
      expect(categories).toContain(category);
    }
    // Recurring bills come every month.
    const music = rows.filter((row) => row.description === 'LUCERNE MUSIC SUBSCRIPTION');
    expect(new Set(music.map((row) => row.transactionDate.slice(0, 7))).size).toBeGreaterThanOrEqual(DEMO_SPENDING_MONTHS);
  });

  it('spends more at the holidays', () => {
    const { rows } = buildDemoSpending('2026-03-18');
    const shopping = (month: string) => rows.filter((row) => row.kind === 'purchase' && row.transactionDate.startsWith(month)
      && ['Merchandise & Supplies-Internet Purchase', 'Merchandise & Supplies-Clothing Stores', 'Merchandise & Supplies-Furnishing',
        'Merchandise & Supplies-Book Stores', 'Merchandise & Supplies-Sporting Goods Stores'].includes(row.issuerCategory ?? ''))
      .reduce((total, row) => total + row.amountMinor, 0);
    const december = shopping('2025-12');
    const others = ['2025-04', '2025-05', '2025-06', '2025-08', '2025-09', '2026-01', '2026-02'].map(shopping);
    expect(december).toBeGreaterThan(1.5 * (others.reduce((total, value) => total + value, 0) / others.length));
  });

  it('pays each card\'s last statement in full on its due date, from the joint checking account', () => {
    const household = buildDemoHousehold(NOW);
    const { statements, payments } = household.spending;
    for (const card of DEMO_CARDS) {
      const january = statements.find((statement) => statement.card === card.key && statement.month === '2026-01')!;
      const payment = payments.find((row) => row.card === card.key && row.transactionDate === january.due);
      if (january.balanceMinor > 0) expect(payment?.amountMinor).toBe(-january.balanceMinor);
      expect(january.due).toBe(`2026-02-${String(card.payDay).padStart(2, '0')}`);
    }
    // The checking export validates, covers the card history through yesterday, and has each autopay's debit.
    const validation = validateCheckingImportPayload(household.checking);
    expect(validation.issues).toEqual([]);
    const [segment] = household.checking.segments;
    expect(segment.coverage).toEqual({ start: household.spending.coverage.start, end: '2026-03-17' });
    expect(household.checking.account).toMatchObject({ institution: DEMO_CHECKING.institution, last4: DEMO_CHECKING.last4 });
    const debits = segment.rows.filter((row) => classifyCheckingDebit(row.description).class === 'card-payment');
    for (const payment of payments.filter((row) => row.transactionDate <= '2026-03-12')) {
      expect(debits.some((row) => row.amountMinor === payment.amountMinor && row.postedDate >= payment.transactionDate
        && row.postedDate <= `${payment.transactionDate.slice(0, 8)}${String(Number(payment.transactionDate.slice(8)) + 3).padStart(2, '0')}`)).toBe(true);
    }
    expect(segment.rows.some((row) => row.amountMinor > 0 && /PAYROLL|DIR DEP/.test(row.description))).toBe(true);
    // Never overdrawn: the opening balance carries every month.
    let balance = segment.anchors[0].balanceMinor;
    for (const row of segment.rows) {
      balance += row.amountMinor;
      expect(balance).toBeGreaterThan(0);
    }
    expect(segment.anchors.at(-1)!.balanceMinor).toBe(balance);
  });

  it('invests about $60,000 in five accounts: whole shares, an index fund in fractions, a position at a loss, and cash events', () => {
    const { portfolio, cashEvents, checking } = buildDemoHousehold(NOW);
    const held = (accountId: string) => aggregatePositions(portfolio.transactions.filter((transaction) => transaction.accountId === accountId))
      .filter((position) => Math.abs(position.quantity) > 1e-9);
    const lastClose = (symbol: string) => portfolio.dailyBars.filter((bar) => bar.symbol === symbol).at(-1)!.close;
    const valueOf = (account: (typeof portfolio.accounts)[number]) => account.cashBalance
      + held(account.id).reduce((total, position) => total + position.quantity * lastClose(position.symbol), 0);
    const values = Object.fromEntries(portfolio.accounts.map((account) => [account.id, valueOf(account)]));
    const total = Object.values(values).reduce((sum, value) => sum + value, 0);
    expect(total).toBeGreaterThan(60_000);
    expect(total).toBeLessThan(65_000);
    for (const [id, [low, high]] of Object.entries({
      'demo-alex-brokerage': [12_000, 18_000], 'demo-alex-roth': [10_000, 15_000], 'demo-casey-brokerage': [7_000, 12_000],
      'demo-casey-retirement': [18_000, 25_000], 'demo-casey-hsa': [3_000, 5_500],
    })) {
      expect(values[id], id).toBeGreaterThan(low);
      expect(values[id], id).toBeLessThan(high);
    }
    expect(portfolio.accounts.every((account) => account.cashBalance >= 0 && account.cashBalance < 1_000)).toBe(true);
    // Whole shares, except the 401(k)'s index fund, bought in fractions with every paycheck and still held.
    expect(portfolio.transactions.filter((transaction) => !Number.isInteger(transaction.quantity)).every((transaction) => transaction.symbol === 'FNILX'
      && transaction.accountId === 'demo-casey-retirement')).toBe(true);
    expect(held('demo-casey-retirement').map((position) => position.symbol)).toEqual(['FNILX']);
    // Trims and an exit, a crypto ETF, and one position bought near a high, held at a loss today.
    expect(portfolio.transactions.some((transaction) => transaction.notes === 'Position exit')).toBe(true);
    expect(portfolio.transactions.filter((transaction) => transaction.notes === 'Rebalance trim').length).toBeGreaterThan(3);
    expect(held('demo-casey-hsa').some((position) => position.symbol === 'FBTC')).toBe(true);
    const losing = portfolio.accounts.flatMap((account) => held(account.id)).filter((position) => lastClose(position.symbol) < position.averageCost);
    expect(losing.length).toBeGreaterThan(0);

    expect(new Set(cashEvents.map((event) => event.eventType))).toEqual(new Set(['dividend', 'interest', 'deposit']));
    expect(cashEvents.every((event) => /^\d{4}$/.test(event.accountLast4) && event.amount > 0)).toBe(true);
    // Each month's deposits are the contributions the ledger invests; the brokerage ones are checking's transfers.
    const month = '2026-02';
    const deposited = (accountId: string) => cashEvents.filter((event) => event.accountId === accountId && event.eventType === 'deposit'
      && event.date.startsWith(month)).reduce((sum, event) => sum + event.amount, 0);
    for (const [key, amount] of Object.entries(DEMO_MONTHLY_CONTRIBUTIONS)) {
      expect(deposited(`demo-${key.replace(/[A-Z]/, (letter) => `-${letter.toLowerCase()}`)}`), key).toBe(amount);
    }
    const transfers = checking.segments[0].rows.filter((row) => row.description.startsWith('ONLINE TRANSFER TO SAMPLE BROKERAGE')
      && row.postedDate.startsWith(month));
    expect(transfers.map((row) => -row.amountMinor / 100).sort((a, b) => a - b)).toEqual([
      DEMO_MONTHLY_CONTRIBUTIONS.caseyBrokerage, DEMO_MONTHLY_CONTRIBUTIONS.alexBrokerage, DEMO_MONTHLY_CONTRIBUTIONS.alexRoth,
    ].sort((a, b) => a - b));
  });

  it('owns a little gold and silver bought over the years, sold some at a gain and some at a loss, and a portfolio with history', () => {
    const { metals, metalsSales, portfolio } = buildDemoHousehold(NOW);
    const metalsHeld = new Set(metals.orders.flatMap((order) => order.lines.map((line) => line.metal)));
    expect(metalsHeld).toEqual(new Set(['XAU', 'XAG']));
    expect(metals.orders.every((order) => order.admission?.methods.every((method) => 'last4' in method && method.last4 === DEMO_METALS_CARD_LAST4)))
      .toBe(true);
    // Fractional gold coins and one-ounce silver rounds, each with its fine content known: about 0.55 troy ounces of
    // gold and 20 of silver left after the sales.
    const ounces = (line: MetalsLine) => {
      expect('troyOz' in line.fine, line.title ?? '').toBe(true);
      const [num, den] = (line.fine as { troyOz: string }).troyOz.split('/').map(Number);
      return (num / den) * line.quantity;
    };
    const net = (metal: string) => [...metals.orders, ...metalsSales.orders].flatMap((order) => order.lines.filter((line) => line.metal === metal)
      .map((line) => (order.side === 'buy' ? 1 : -1) * ounces(line))).reduce((sum, value) => sum + value, 0);
    expect(net('XAU')).toBeCloseTo(0.55, 6);
    expect(net('XAG')).toBeCloseTo(20, 6);
    expect(metalsSales.orders).toHaveLength(2);
    expect(metalsSales.orders.every((order) => order.side === 'sell' && order.status === 'complete' && order.payouts.length === 1
      && order.payouts[0].destinationLast4 === DEMO_CHECKING.last4)).toBe(true);
    // Each sale sells a product the household bought (the same content), after it was delivered.
    for (const sale of metalsSales.orders) {
      const [line] = sale.lines;
      const bought = metals.orders.filter((order) => order.lines[0].contentFingerprint === line.contentFingerprint && order.date < sale.date);
      expect(bought.length).toBeGreaterThan(0);
    }
    // Against the oldest lot of its product: a gain and a loss, whatever the day (weekdays, weekends, holidays), both
    // within the last six months (the Gold page's default view).
    for (const now of [NOW, new Date('2026-07-05T16:00:00Z'), new Date('2026-11-24T20:00:00Z'), new Date('2027-02-27T15:00:00Z'), new Date('2028-01-02T23:00:00Z')]) {
      const household = buildDemoHousehold(now);
      const profits = household.metalsSales.orders.map((sale) => {
        const [line] = sale.lines;
        const oldest = household.metals.orders.filter((order) => order.lines[0].contentFingerprint === line.contentFingerprint)
          .sort((left, right) => left.date.localeCompare(right.date))[0];
        return sale.payouts[0].amountMinor - oldest.lines[0].unitPriceMinor! * line.quantity;
      });
      expect(profits.map(Math.sign), household.today).toEqual([1, -1]);
      expect(household.metalsSales.orders.every((sale) => sale.date > addDays(household.today, -90))).toBe(true);
    }
    expect(portfolio.accounts.map((account) => account.name)).toEqual([
      'Alex · Brokerage', 'Alex · Roth IRA', 'Casey · Brokerage', 'Casey · Retirement', 'Casey · HSA',
    ]);
    expect(portfolio.transactions.length).toBeGreaterThan(100);
    expect(portfolio.metalCloses.some((row) => row.symbol === 'holdr:metal:XAU')).toBe(true);
    // No e2e labels, and none of the e2e guard tests' level shifts: each day's close is within 20% of the day before.
    expect(JSON.stringify(portfolio)).not.toMatch(/e2e/i);
    for (const metal of ['XAU', 'XAG']) {
      const closes = portfolio.metalCloses.filter((row) => row.symbol === `holdr:metal:${metal}`).map((row) => row.close);
      expect(closes.slice(1).every((close, index) => Math.abs(close / closes[index] - 1) < 0.2)).toBe(true);
    }
  });

  it('is synthetic: fictional merchants, fixed card endings, no account-number-like digits, no owner identifier', () => {
    const household = buildDemoHousehold(NOW);
    const last4s = new Set([...DEMO_CARDS.map((card) => card.last4), DEMO_METALS_CARD_LAST4, DEMO_CHECKING.last4]);
    expect(last4s).toEqual(new Set(['1001', '2002', '3003', '4004', '5005', '6006', '7007']));
    for (const row of household.spending.rows) {
      expect(row.description).toMatch(/^[A-Z][A-Z #&'*.-]*(?:#\d{1,4})?[A-Z #&'*.-]*$/);
      expect(row.description).not.toMatch(/\d{5,}/);
    }
    expect(household.portfolio.accounts.every((account) => /^DEMO-\d{3}$/.test(account.accountNumber ?? ''))).toBe(true);
    const text = JSON.stringify(household).toLowerCase();
    expect(text).not.toMatch(/\b\d{12,19}\b/);
    for (const term of blocklist()) expect(text.includes(term), 'an owner identifier from the local blocklist').toBe(false);
  });
});

describe('seeding the demo folder', () => {
  it('writes the household, its optional tables and a demo user into a new folder only', async () => {
    const dataDir = path.join(dir, 'holdr-demo', 'data');
    const summary = await seedDemoDataDir(dataDir, { password: 'demo-pass-123', now: NOW });
    expect(summary).toMatchObject({ dataDir, today: '2026-03-18', accounts: 5, cards: 5, metalOrders: 7, metalSales: 2 });
    expect(summary.cashEvents).toBeGreaterThan(50);
    expect(summary.checkingRows).toBeGreaterThan(100);
    expect(fs.readdirSync(dataDir).filter((name) => !name.startsWith('finance.db'))).toEqual([]);
    const repo = new SqliteStateRepo({ file: path.join(dataDir, 'finance.db') });
    try {
      const cards = repo.listCardAccounts();
      expect(cards.map((card) => card.nickname)).toEqual(DEMO_CARDS.map((card) => card.nickname));
      // The everyday and cash-back cards have no statement credits: they track no benefits, so none waits to be set up.
      const settings = repo.listCardBenefitSettings();
      for (const nickname of ['Casey Everyday Visa', 'Household Cash Back']) {
        expect(settings.find((entry) => entry.cardAccountId === cards.find((card) => card.nickname === nickname)!.id)?.productChoice, nickname)
          .toBe('none');
      }
      expect(repo.listCardBenefitMarks().length).toBeGreaterThan(10);
      expect(repo.listAllCashEvents().length).toBe(summary.cashEvents);
      const owed = cashOwedView(repo.internalGetDb(), new Date(NOW.getTime() + 60_000));
      expect(owed.installed).toBe(true);
      expect(owed.cards.every((card) => card.read !== null && card.read.currentBalanceMinor !== null)).toBe(true);
      expect(createCheckingLedgerReader(repo.internalGetDb()).listAccounts()).toHaveLength(1);
      const user = new LocalAuthRepo(repo).findUser(DEMO_USER)!;
      expect(await verifyPassword('demo-pass-123', user.passwordHash)).toBe(true);
    } finally {
      repo.close();
    }
    // The password helper changes a demo folder's only: one with the marker beside its data folder.
    await expect(resetDemoPassword(dataDir, 'another-pass-456')).rejects.toThrow(/not a demo folder/);
    fs.writeFileSync(path.join(dir, 'holdr-demo', DEMO_MARKER), `${MARKER_TEXT}seeded 2026-03-18\n`);
    await resetDemoPassword(dataDir, 'another-pass-456');
    const again = new SqliteStateRepo({ file: path.join(dataDir, 'finance.db') });
    try {
      expect(await verifyPassword('another-pass-456', new LocalAuthRepo(again).findUser(DEMO_USER)!.passwordHash)).toBe(true);
    } finally {
      again.close();
    }
    // A folder with anything in it is never seeded, so a real database is never written to.
    await expect(seedDemoDataDir(dataDir, { password: 'demo-pass-123', now: NOW })).rejects.toThrow(/new, empty directory/);
  }, 60_000);

  it('refuses apps/api/data, files, non-empty folders, a weak password and a database that is not the demo\'s', async () => {
    expect(() => prepareDemoDataDir(path.join(dir, 'checkout', 'apps', 'api', 'data'))).toThrow(/default data directory/);
    expect(fs.existsSync(path.join(dir, 'checkout'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'file'), '');
    expect(() => prepareDemoDataDir(path.join(dir, 'file'))).toThrow(/not a plain directory/);
    fs.mkdirSync(path.join(dir, 'used'));
    fs.writeFileSync(path.join(dir, 'used', 'finance.db'), '');
    expect(() => prepareDemoDataDir(path.join(dir, 'used'))).toThrow(/new, empty directory/);
    await expect(seedDemoDataDir(path.join(dir, 'weak'), { password: 'demo', now: NOW })).rejects.toThrow(/at least 8/);
    expect(fs.existsSync(path.join(dir, 'weak'))).toBe(false);
    fs.mkdirSync(path.join(dir, 'missing'));
    fs.writeFileSync(path.join(dir, DEMO_MARKER), MARKER_TEXT);
    await expect(resetDemoPassword(path.join(dir, 'missing'), 'demo-pass-123')).rejects.toThrow(/no demo database/);
    // A marker beside a real household's database: still refused, by what the database holds.
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    const repo = new SqliteStateRepo({ file: path.join(real, 'finance.db') });
    try {
      new LocalAuthRepo(repo).createUser('owner', 'scrypt$placeholder');
    } finally {
      repo.close();
    }
    await expect(resetDemoPassword(real, 'demo-pass-123')).rejects.toThrow(/does not hold the demo household/);
  });

  it('checks, read-only, that a demo folder holds nothing but the demo\'s before the launcher deletes it', async () => {
    const root = path.join(dir, 'holdr-demo');
    const dataDir = path.join(root, 'data');
    await seedDemoDataDir(dataDir, { password: 'demo-pass-123', now: NOW });
    const file = path.join(dataDir, 'finance.db');
    // Only the demo's own marker, word for word, makes it a demo folder.
    expect(() => assertDemoDataDir(dataDir)).toThrow(/not a demo folder/);
    fs.writeFileSync(path.join(root, DEMO_MARKER), `${MARKER_TEXT}seeded 2026-03-18\nmy notes\n`);
    expect(() => assertDemoDataDir(dataDir)).toThrow(/not a demo folder/);
    await expect(resetDemoPassword(dataDir, 'another-pass-456')).rejects.toThrow(/not a demo folder/);
    fs.writeFileSync(path.join(root, DEMO_MARKER), `${MARKER_TEXT}seeded 2026-03-18\n`);
    const before = fs.readFileSync(file);
    assertDemoDataDir(dataDir);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    // A card an earlier demo made (another ending, transactions the demo's seed imported) is still the demo's.
    const earlier = new SqliteStateRepo({ file });
    try {
      earlier.internalGetDb().prepare("UPDATE card_accounts SET last4 = '8008' WHERE last4 = '1001'").run();
    } finally {
      earlier.close();
    }
    assertDemoDataDir(dataDir);
    // Anything of a real household is counted (never named): a user, an account, a card, a statement imported into a demo card.
    const repo = new SqliteStateRepo({ file });
    try {
      new LocalAuthRepo(repo).createUser('owner', 'scrypt$placeholder');
      repo.createAccount({ id: 'brokerage-1', name: 'Brokerage', type: 'Individual', cashBalance: 0, currency: 'USD' });
      repo.createCardAccount({ issuer: 'amex', owner: 'alex', nickname: 'Everyday', last4: '9876', currency: 'USD' });
      repo.internalGetDb().prepare(`INSERT INTO card_import_batches
        (id, card_account_id, source, parser_version, row_count, new_count, duplicate_count, rejected_count)
        SELECT 'batch-statement', id, 'amex-csv', 'amex-1', 0, 0, 0, 0 FROM card_accounts WHERE last4 = '8008'`).run();
    } finally {
      repo.close();
    }
    expect(() => assertDemoDataDir(dataDir))
      .toThrow(/it holds 1 sign-in user, 1 investment account, 1 card, 1 card statement import the demo did not make$/);
    // No database yet (a seed that stopped before writing one) holds nothing of anyone's.
    fs.rmSync(dataDir, { recursive: true });
    fs.mkdirSync(dataDir);
    assertDemoDataDir(dataDir);
  }, 60_000);

  it('reads a partial or older demo database as it is: missing tables are empty, and nothing is added', () => {
    const file = path.join(dir, 'partial.db');
    const db = new Database(file);
    db.exec("CREATE TABLE local_users (id TEXT PRIMARY KEY, username TEXT NOT NULL); INSERT INTO local_users VALUES ('u1', 'demo');");
    db.close();
    assertOnlyDemoData(file);
    const check = new Database(file, { readonly: true });
    try {
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all()).toEqual(['local_users']);
    } finally {
      check.close();
    }
  });
});
