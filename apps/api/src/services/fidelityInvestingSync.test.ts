import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from './sqliteStateRepo.js';
import { computeFingerprint } from './activityParser.js';
import { getPortfolioHistory } from './portfolioHistory.js';
import { createHistoryRepo } from './symbolHistory.js';
import {
  FIDELITY_CASH_ADOPTED_REASON,
  fidelityInvestingDigest, importFidelityInvesting, validateFidelityInvestingInput,
  type FidelityInvestingCapture, type FidelityInvestingPolicy,
} from './fidelityInvestingSync.js';

const NOW = '2026-10-19T12:00:00.000Z';
const sourceId = `fidelity-${'a'.repeat(64)}`;
const key = (n: number): string => n.toString(16).padStart(64, '0');
let dir: string;
let repo: SqliteStateRepo;
let capture: FidelityInvestingCapture;
let policy: FidelityInvestingPolicy;
const db = () => repo.internalGetDb();
const run = () => importFidelityInvesting(repo, capture, policy, { backupDirectory: dir, now: () => new Date(NOW), mode: 'full-backfill' });
// Vitest annotates uncaught errors, whereas the service deliberately freezes them.
const incrementalRun = (now = NOW) => importFidelityInvesting(repo, capture, policy, { backupDirectory: dir, now: () => new Date(now) })
  .catch((error: Error) => { throw new Error(error.message); });
const account = () => capture.accounts[0];
const trades = () => repo.listTransactions('synthetic');
const count = (table: string) => db().prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
const cards = () => db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'card_%'")
  .all().map(r => {
    const { name } = r as { name: string };
    return [name, db().prepare(`SELECT * FROM "${name}"`).all()];
  });
function syntheticCliArgs(root: string, args: string[], maintenance = false, now?: string, emptyBackup = false): string[] {
  // The CLI takes no injected clock, so a pinned `now` replaces the child's Date before the runner loads.
  const clock = now === undefined ? '' : `
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [${JSON.stringify(now)}])); }
      static now() { return NativeDate.parse(${JSON.stringify(now)}); }
    };`;
  // The class the pre-open backup's readback stops (the backup sweep, 11/09): better-sqlite3 takes a first busy step as
  // done, so the backup resolves with nothing copied.
  const backup = emptyBackup ? `
    const { default: Driver } = await import('better-sqlite3');
    Driver.prototype.backup = async () => ({ totalPages: 0, remainingPages: 0 });` : '';
  const script = `
    import fs from 'node:fs';
    import { pathToFileURL } from 'node:url';${clock}${backup}
    const {runFidelityInvestingCli} = await import(pathToFileURL(process.argv[1]).href);
    try {
      process.exitCode = await runFidelityInvestingCli(process.argv.slice(2), {
        withLease: async (env, work) => {
          if (!env.HOLDR_CONTROL_DIR || ${maintenance}) throw Error('synthetic maintenance refusal');
          return work();
        },
        readPolicy: file => fs.readFileSync(file)
      });
    } catch (error) {
      // Only the readback's own refusal is named: any other error may carry a path.
      console.error(error?.message === 'fidelity pre-open backup readback failed' ? error.message : 'synthetic CLI refused');
      process.exitCode = 1;
    }
  `;
  return ['--import', 'tsx', '--input-type=module', '-e', script, '--', path.join(root, 'tools', 'holdr-investing-sync', 'runner.mts'), ...args];
}

describe('Fidelity incremental proof policy (product default)', () => {
  const coveredRow = () => ({
    key: key(1), date: '2026-09-01', description: 'OPAQUE LEGACY DEPOSIT', symbol: 'SYN',
    quantity: 8, pricePerUnit: null, amount: 0, fees: 0,
  });
  beforeEach(async () => {
    repo.createTransaction({
      id: 'opaque-legacy', accountId: 'synthetic', date: '2026-09-01', symbol: 'SYN',
      quantity: 8, pricePerUnit: 5, currency: 'USD', notes: 'preserve exactly', sourceFingerprint: 'opaque-legacy',
    });
    seedCutoff(100);
    account().activity = [coveredRow()];
    account().positions[0].quantity = 8;
    account().cashBalance = 100; account().totalValue = 156;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', baseline: true, added: 0, audited: 1 });
    capture.capturedAt = '2026-10-19T12:00:30.000Z';
    account().activity = [{
      key: key(10), date: '2026-10-19', description: 'YOU BOUGHT SYNTHETIC (SYN) (Cash)',
      symbol: 'SYN', quantity: 2, pricePerUnit: 5, amount: -10, fees: 0,
    }];
    account().positions = [{ symbol: 'SYN', quantity: 10, pricePerUnit: 7, costBasis: 50 }];
    account().cashBalance = 90; account().totalValue = 160;
  });

  const rawLegacy = () => db().prepare("SELECT * FROM transactions WHERE id = 'opaque-legacy'").get();
  const cursor = () => db().prepare('SELECT * FROM fidelity_investing_incremental').get();
  it('tracks core plus pending as economic cash and does not charge settlement twice', async () => {
    account().cashBalance = 100; account().pendingBalance = -10;
    account().positions[0].marketValue = 70;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 1 });
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(90);
    expect(db().prepare('SELECT cash_balance FROM fidelity_investing_incremental').pluck().get()).toBe(90);
    capture.capturedAt = '2026-10-19T12:01:00.000Z';
    account().cashBalance = 90; account().pendingBalance = 0;
    expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(90);
  });

  it('accepts large quote-only changes with unchanged quantities and proven economic cash', async () => {
    await incrementalRun();
    capture.capturedAt = '2026-10-19T12:01:00.000Z';
    account().positions[0].marketValue = 70000;
    account().positions[0].pricePerUnit = 7000;
    account().totalValue = 70090;
    expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
  });

  it('derives an unknown new-position basis only from the full native quantity and execution evidence', async () => {
    account().activity[0].symbol = 'NEW';
    account().positions[0].quantity = 8;
    account().positions[0].costBasis = 40;
    account().positions.push({ symbol: 'NEW', quantity: 2, pricePerUnit: 7, costBasis: null, marketValue: 14 });
    account().positions[0].marketValue = 56;
    const beforeCards = cards();
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 1 });
    expect(db().prepare('SELECT cost_basis FROM account_snapshots WHERE taken_at = ?')
      .pluck().get(capture.capturedAt)).toBe(140);
    expect(account().positions[1].costBasis).toBeNull();
    expect(cards()).toEqual(beforeCards);
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
  });

  it.each([-100, 0, 100])('holds unknown incremental basis on inconsistent native NET even when account cash reconciles: %s', async amount => {
    account().activity[0].symbol = 'NEW';
    account().activity[0].amount = amount;
    account().positions[0].quantity = 8;
    account().positions[0].costBasis = 40;
    account().positions.push({ symbol: 'NEW', quantity: 2, pricePerUnit: 7, costBasis: null });
    account().cashBalance = 100 + amount;
    account().totalValue = account().cashBalance + 70;
    const before = trades(), beforeCursor = cursor();
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'held', reason: 'unknown-position-basis-unproven', added: 0, audited: 0,
    });
    expect(trades()).toEqual(before); expect(cursor()).toEqual(beforeCursor);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(100);
  });

  it('proves a fully sold-out position from native activity and keeps the closing ledger row', async () => {
    Object.assign(account().activity[0], { description: 'YOU SOLD SYNTHETIC', quantity: -8, amount: 40, pricePerUnit: 5 });
    account().positions = []; account().cashBalance = 140; account().totalValue = 140;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 1 });
    expect(trades().reduce((n, t) => n + t.quantity, 0)).toBe(0);
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
  });

  it('holds an absent native position without native closing quantity instead of deleting the old position', async () => {
    account().activity = []; account().positions = []; account().cashBalance = 100; account().totalValue = 100;
    const before = trades(), beforeCursor = cursor();
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'held', reason: 'closed-position-activity-unproven', added: 0, audited: 0,
    });
    expect(trades()).toEqual(before); expect(cursor()).toEqual(beforeCursor);
  });

  it('never auto-binds a different source hash even when its last4 matches an approved account', async () => {
    const approved = JSON.stringify(policy);
    account().sourceId = 'fidelity-' + 'b'.repeat(64);
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'held', reason: 'explicit-account-binding-required', added: 0, audited: 0,
    });
    expect(JSON.stringify(policy)).toBe(approved);
    expect(count('fidelity_investing_sources')).toBe(1);
  });

  it.each(['cash', 'holdings'])('native row valuation never bypasses the incremental %s proof', async proof => {
    account().positions[0].marketValue = 70.03;
    account().totalValue = 160.03;
    if (proof === 'cash') { account().cashBalance = 91; account().totalValue = 161.03; }
    else account().positions[0].quantity = 11;
    const before = trades(), beforeCursor = cursor(), beforeCards = cards();
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'held', reason: proof === 'cash' ? 'projected-cash-mismatch' : 'projected-holdings-mismatch',
      added: 0, rekeyed: 0, audited: 0,
    });
    expect(trades()).toEqual(before);
    expect(cursor()).toEqual(beforeCursor);
    expect(cards()).toEqual(beforeCards);
  });

  it('replays covered missing-price history and opaque overlap while preserving every legacy byte and card table', async () => {
    account().activity.unshift(coveredRow());
    const legacy = rawLegacy(), beforeCards = cards();
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'applied', added: 1, rekeyed: 0, audited: 1, activityTypes: { trade: 1, otherQuantity: 1 },
    });
    expect(rawLegacy()).toEqual(legacy);
    expect(cards()).toEqual(beforeCards);
    expect(cursor()).toMatchObject({ cutoff_day: '2026-10-19', cash_balance: 90 });
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, rekeyed: 0, audited: 0, duplicates: 1 });
    expect(count('account_cash_events')).toBe(0);
  });

  it('freezes initial cutoff separately from receipt watermark and imports a later unseen same-day row', async () => {
    await incrementalRun();
    const initial = cursor();
    repo.close();
    repo = new SqliteStateRepo({ file: path.join(dir, 'test.sqlite') });
    capture.capturedAt = '2026-10-19T12:00:45.000Z';
    account().activity.push({ ...account().activity[0], key: key(11), quantity: 1, amount: -5 });
    account().positions[0].quantity = 11; account().positions[0].costBasis = 55;
    account().cashBalance = 85; account().totalValue = 162;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 1, audited: 1, duplicates: 1 });
    expect(cursor()).toMatchObject({ cutoff_day: '2026-10-19', cash_balance: 85 });
    expect(cursor()).not.toEqual(initial);
    expect(db().prepare('SELECT captured_at FROM fidelity_investing_sources').pluck().get()).toBe(capture.capturedAt);
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0, duplicates: 2 });
  });

  it('accepts seven-day overlap without requiring already audited history to be replayed', async () => {
    await incrementalRun();
    capture.capturedAt = '2026-10-19T12:00:45.000Z';
    account().coverage.from = '2026-10-12';
    account().activity = [];
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
    expect(trades()).toHaveLength(2);
  });

  it.each([[0.02, 'applied'], [0.021, 'held']])('enforces two-cent projected cash tolerance at %s', async (delta, status) => {
    account().cashBalance += Number(delta); account().totalValue += Number(delta);
    expect((await incrementalRun()).accounts[0].status).toBe(status);
  });

  it.each([
    ['projected-cash-mismatch', () => { account().cashBalance = 91; account().totalValue = 161; }],
    ['projected-holdings-mismatch', () => { account().positions[0].quantity = 11; account().totalValue = 167; }],
    ['incomplete-incremental-coverage', () => {
      db().prepare("UPDATE fidelity_investing_sources SET captured_at = '2026-10-18T12:00:00.000Z'").run();
      account().coverage.from = '2026-10-19';
    }],
    ['same-day-execution-order-unproven', () => {
      account().activity.push({ ...account().activity[0], key: key(11), quantity: -1, amount: 5 });
      account().positions[0].quantity = 9; account().cashBalance = 95; account().totalValue = 158;
    }],
  ] as const)('holds %s without writing source, cursor, audit or legacy changes', async (reason, mutate) => {
    const legacy = rawLegacy(), before = cursor();
    mutate();
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'held', reason, added: 0, rekeyed: 0, audited: 0, duplicates: 0 });
    expect(count('fidelity_investing_sources')).toBe(1);
    expect(count('fidelity_investing_activity')).toBe(1);
    expect(cursor()).toEqual(before);
    expect(rawLegacy()).toEqual(legacy);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(100);
  });

  it('does not hide or evict an imported snapshot baseline when adding same-symbol native activity', async () => {
    db().prepare("UPDATE transactions SET source_fingerprint = NULL, notes = 'imported position'").run();
    db().prepare('UPDATE fidelity_investing_incremental SET ledger_digest = ?').run(fidelityInvestingDigest(trades()));
    const legacy = rawLegacy();
    expect((await incrementalRun()).accounts[0].reason).toBe('incremental-baseline-would-be-hidden');
    expect(rawLegacy()).toEqual(legacy);
    expect(trades()).toHaveLength(1);
  });

  it('can preserve a snapshot baseline when no new native activity would hide that symbol', async () => {
    db().prepare("UPDATE transactions SET source_fingerprint = 'pos:SYN'").run();
    db().prepare('UPDATE fidelity_investing_incremental SET ledger_digest = ?').run(fidelityInvestingDigest(trades()));
    const legacy = rawLegacy();
    account().activity[0].symbol = 'NEW';
    account().positions[0].quantity = 8; account().positions[0].costBasis = 40;
    account().positions.push({ symbol: 'NEW', quantity: 2, pricePerUnit: 7, costBasis: 10 });
    expect((await incrementalRun()).accounts[0].status).toBe('applied');
    expect(rawLegacy()).toEqual(legacy);
  });

  it.each(['ledger', 'cash', 'key'] as const)('holds subsequent %s changes without advancing verified state', async change => {
    await incrementalRun();
    const before = cursor(), watermark = db().prepare('SELECT * FROM fidelity_investing_sources').get();
    capture.capturedAt = '2026-10-19T12:00:45.000Z';
    if (change === 'ledger') db().prepare("UPDATE transactions SET quantity = 9 WHERE id = 'opaque-legacy'").run();
    if (change === 'cash') db().prepare("UPDATE accounts SET cash_balance = 99 WHERE id = 'synthetic'").run();
    if (change === 'key') account().activity[0].fees = 1;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'held', audited: 0, added: 0 });
    expect(cursor()).toEqual(before);
    expect(db().prepare('SELECT * FROM fidelity_investing_sources').get()).toEqual(watermark);
  });

  it.each([null, 0])('derives NET effective price for %s without counting fees twice and retains original evidence digest', async price => {
    account().activity[0].pricePerUnit = price;
    account().activity[0].amount = -11; account().activity[0].fees = 1;
    account().cashBalance = 89; account().totalValue = 159;
    expect((await incrementalRun()).accounts[0].status).toBe('applied');
    expect(trades()[1]).toMatchObject({ pricePerUnit: 5.5, fees: 0, quantity: 2 });
    expect(db().prepare('SELECT content_digest FROM fidelity_investing_activity WHERE activity_key = ?').pluck().get(key(10)))
      .toBe(fidelityInvestingDigest(account().activity[0]));
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
  });

  it('preserves total basis on a positive split delta without using a market price', async () => {
    Object.assign(account().activity[0], { description: 'STOCK SPLIT SYNTHETIC', quantity: 8, amount: 0, pricePerUnit: null });
    account().positions[0].quantity = 16; account().positions[0].costBasis = 40;
    account().cashBalance = 100; account().totalValue = 212;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', activityTypes: { split: 1 } });
    expect(trades()[1]).toMatchObject({ pricePerUnit: 0, fees: 0 });
    const { aggregatePositions } = await import('@finance-tracker/shared');
    expect(aggregatePositions(trades())[0].costBasis).toBe(40);
    expect((await incrementalRun()).accounts[0].status).toBe('applied');
  });

  it.each([false, true])('derives option premium from NET without multiplying native valuation twice: native=%s', async native => {
    const symbol = 'NEW261120P00010000';
    Object.assign(account().activity[0], {
      description: 'YOU BOUGHT OPENING TRANSACTION PUT (NEW) SYNTHETIC NOV 20 26 $10 (100 SHS) (Cash)',
      symbol, quantity: 1, pricePerUnit: null, amount: -201, fees: 1,
    });
    account().positions[0].quantity = 8;
    account().positions.push({ symbol, quantity: 1, pricePerUnit: 2, costBasis: 201 });
    account().cashBalance = -101; account().totalValue = 155;
    if (native) {
      account().positions[0].marketValue = 56;
      account().positions[1].marketValue = 200.03;
      account().totalValue = 155.03;
    }
    expect((await incrementalRun()).accounts[0].status).toBe('applied');
    expect(trades()[1]).toMatchObject({ pricePerUnit: 2.01, fees: 0, contractMultiplier: 100, instrumentType: 'option' });
  });

  it('keeps unsupported option metadata fail-closed despite an available NET amount', async () => {
    Object.assign(account().activity[0], { symbol: 'NEW261120P00010000', pricePerUnit: null });
    expect((await incrementalRun()).accounts[0].reason).toBe('missing-option-metadata');
  });

  it.each(['SYN', 'NEW'])('honors a positive execution price on zero-NET activity for %s rather than allocating snapshot basis', async symbol => {
    Object.assign(account().activity[0], { description: 'RSU DEPOSIT', symbol, pricePerUnit: 5, amount: 0, fees: 1 });
    if (symbol === 'NEW') {
      account().positions[0].quantity = 8;
      account().positions.push({ symbol, quantity: 2, pricePerUnit: 7, costBasis: 30 });
    }
    account().cashBalance = 100; account().totalValue = 170;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 1 });
    expect(trades()[1]).toMatchObject({ symbol, quantity: 2, pricePerUnit: 5, fees: 1 });
  });

  it('never infers an unsupported option multiplier from the amount', async () => {
    Object.assign(account().activity[0], {
      description: 'YOU BOUGHT OPENING TRANSACTION PUT (NEW) SYNTHETIC NOV 20 26 $10 (10 SHS) (Cash)',
      symbol: 'NEW261120P00010000', pricePerUnit: null,
    });
    expect((await incrementalRun()).accounts[0].reason).toBe('unsupported-option');
  });

  it('keeps already verified incremental sources out of explicit full-backfill mode', async () => {
    await incrementalRun();
    expect((await run()).accounts[0].reason).toBe('incremental-source-requires-separate-migration');
    expect(trades()).toHaveLength(2);
  });

  it('does not advance an established source while policy-ignored', async () => {
    await incrementalRun();
    const before = cursor(), watermark = db().prepare('SELECT * FROM fidelity_investing_sources').get();
    policy = { bindings: [], ignoredSources: [sourceId] };
    capture.capturedAt = '2026-10-19T12:00:45.000Z';
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'ignored', added: 0, audited: 0, rekeyed: 0 });
    expect(cursor()).toEqual(before);
    expect(db().prepare('SELECT * FROM fidelity_investing_sources').get()).toEqual(watermark);
  });

  it.each([
    ['TRANSFERRED IN KIND', 'inKindTransfer'], ['RSU DEPOSIT', 'rsuDeposit'],
    ['ESPP DEPOSIT', 'esppDeposit'], ['REINVESTMENT', 'reinvestment'],
  ])('uses uniquely attributable captured total basis only for an entire new holding: %s', async (description, type) => {
    Object.assign(account().activity[0], { description, symbol: 'NEW', amount: 0, pricePerUnit: null });
    account().positions[0].quantity = 8; account().positions[0].costBasis = 40;
    account().positions.push({ symbol: 'NEW', quantity: 2, pricePerUnit: 20, costBasis: 30 });
    account().cashBalance = 100; account().totalValue = 196;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', activityTypes: { [type]: 1 } });
    expect(trades()[1]).toMatchObject({ symbol: 'NEW', quantity: 2, pricePerUnit: 15, fees: 0 });
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', audited: 0, duplicates: 1 });
  });

  it.each(['REVERSE STOCK SPLIT', 'RSU DEPOSIT', 'ESPP DEPOSIT', 'TRANSFERRED IN KIND', 'REINVESTMENT', 'UNKNOWN ADJUSTMENT'])(
    'holds quantity-only events without a safe type/basis rule: %s', async description => {
      Object.assign(account().activity[0], { description, amount: 0, pricePerUnit: null });
      expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'held', reason: 'quantity-only-basis-unproven', audited: 0 });
      expect(trades()).toHaveLength(1);
    },
  );

  it('does not allocate current basis across multiple unknown deposit lots', async () => {
    Object.assign(account().activity[0], { description: 'RSU DEPOSIT', symbol: 'NEW', amount: 0, pricePerUnit: null });
    account().activity.push({ ...account().activity[0], key: key(11), date: '2026-10-02' });
    account().positions.push({ symbol: 'NEW', quantity: 4, pricePerUnit: 20, costBasis: 30 });
    expect((await incrementalRun()).accounts[0].reason).toBe('quantity-only-basis-unproven');
  });

  it('does not count core redemption again for a security purchase', async () => {
    account().activity.push({
      ...account().activity[0], key: key(11), description: 'YOU SOLD CORE', symbol: 'SPAXX', quantity: -10, pricePerUnit: 1, amount: 10,
    });
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', audited: 2, activityTypes: { trade: 1, coreSettlement: 1 } });
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(90);
  });

  it('does not subtract core purchase from an external cash deposit', async () => {
    account().activity = [
      { ...account().activity[0], symbol: null, quantity: 0, amount: 20, description: 'ELECTRONIC FUNDS TRANSFER' },
      { ...account().activity[0], key: key(11), description: 'YOU BOUGHT CORE', symbol: 'SPAXX', quantity: 20, pricePerUnit: 1, amount: -20 },
    ];
    account().positions[0].quantity = 8; account().cashBalance = 120; account().totalValue = 176;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 2 });
  });

  it('counts core dividend income but not its core reinvestment leg', async () => {
    account().activity = [
      { ...account().activity[0], symbol: 'SPAXX', quantity: 0, amount: 1, description: 'CASH DIVIDEND' },
      { ...account().activity[0], key: key(11), description: 'REINVESTMENT', symbol: 'SPAXX', quantity: 1, pricePerUnit: 1, amount: -1 },
    ];
    account().positions[0].quantity = 8; account().cashBalance = 101; account().totalValue = 157;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 2, activityTypes: { coreIncome: 1, coreSettlement: 1 } });
  });

  it('holds unknown core quantity activity instead of inventing its economic cash impact', async () => {
    Object.assign(account().activity[0], { symbol: 'SPAXX', description: 'UNKNOWN CORE ADJUSTMENT' });
    expect((await incrementalRun()).accounts[0].reason).toBe('unsupported-core-cash-activity');
  });

  it('holds a failed account but atomically advances a different verified account', async () => {
    const held = { ...structuredClone(account()), sourceId: `fidelity-${'b'.repeat(64)}`, last4: '5678' };
    capture.accounts.push(held);
    expect((await incrementalRun()).accounts.map(a => a.status)).toEqual(['applied', 'held']);
    expect(count('fidelity_investing_sources')).toBe(1);
    expect(count('fidelity_investing_incremental')).toBe(1);
    expect(count('fidelity_investing_receipts')).toBe(2);
  });

  it('rolls back verified watermark, initial cutoff, audit and trades with a late receipt failure', async () => {
    await incrementalRun();
    const before = cursor(), watermark = db().prepare('SELECT * FROM fidelity_investing_sources').get();
    db().exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON fidelity_investing_receipts BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    capture.capturedAt = '2026-10-19T12:00:45.000Z';
    account().activity.push({ ...account().activity[0], key: key(11), quantity: 1, amount: -5 });
    account().positions[0].quantity = 11; account().cashBalance = 85; account().totalValue = 162;
    await expect(incrementalRun()).rejects.toThrow('fidelity investing import failed');
    expect(cursor()).toEqual(before);
    expect(db().prepare('SELECT * FROM fidelity_investing_sources').get()).toEqual(watermark);
    expect(trades()).toHaveLength(2);
    expect(count('fidelity_investing_activity')).toBe(2);
    expect(count('fidelity_investing_receipts')).toBe(2);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(90);
  });
});

describe('Owner-approved authoritative capture-time baseline', () => {
  beforeEach(() => {
    repo.createTransaction({
      id: 'opaque-legacy', accountId: 'synthetic', date: '2026-10-19', symbol: 'SYN',
      quantity: 8, pricePerUnit: 5, currency: 'USD', notes: 'untouched legacy', sourceFingerprint: 'opaque-legacy',
    });
    // Charting 1W here ends in the snapshot view, whose backtest reference asks quote and price
    // providers for its symbols. The tests never reach the network: without this each 1W chart
    // waited on it for about five seconds, past vitest's default timeout on macOS and Linux.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the tests do not reach the network'); }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('covers all historical and boundary-day keys without importing/rekeying and privately audits authoritative cash adoption', async () => {
    account().activity[0].date = '2026-10-19';
    account().activity[0].pricePerUnit = null;
    account().activity[0].amount = 0;
    const legacy = db().prepare('SELECT * FROM transactions').all(), beforeCards = cards();
    const receipt = await incrementalRun();
    expect(receipt.accounts[0]).toMatchObject({
      status: 'applied', added: 0, rekeyed: 0, audited: 4, baseline: true, baselineCashAdoption: true,
    });
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(10);
    expect(db().prepare('SELECT * FROM fidelity_investing_incremental').get()).toMatchObject({
      previous_cash_balance: 0, cash_balance: 10, baseline_cash_adopted: 1, baseline_at: NOW,
      baseline_digest: fidelityInvestingDigest(capture),
    });
    expect(db().prepare('SELECT DISTINCT kind FROM fidelity_investing_activity').pluck().all()).toEqual(['baseline-covered']);
    expect(db().prepare('SELECT * FROM transactions').all()).toEqual(legacy);
    expect(cards()).toEqual(beforeCards);
    // Adopting the broker's cash is a correction of the capture day's history, not a market move.
    expect(db().prepare('SELECT account_id, effective_date, detected_at, reason FROM account_history_invalidations').all()).toEqual([
      { account_id: 'synthetic', effective_date: '2026-10-19', detected_at: NOW, reason: FIDELITY_CASH_ADOPTED_REASON },
    ]);
    const initial = db().prepare('SELECT * FROM fidelity_investing_incremental').get();
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0, duplicates: 0 });
    expect(db().prepare('SELECT * FROM fidelity_investing_incremental').get()).toEqual(initial);
    expect(count('account_history_invalidations')).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain('previous_cash_balance');
    expect(JSON.stringify(receipt)).not.toContain('cashBalance');
  });

  it('marks a verified baseline without adoption when cash already agrees', async () => {
    account().cashBalance = 0; account().totalValue = 56;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', baseline: true, baselineCashAdoption: false });
    expect(count('account_history_invalidations')).toBe(0);
  });

  it('records no correction for an adoption within two cents', async () => {
    account().cashBalance = 0.02; account().totalValue = 56.02;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', baseline: true, baselineCashAdoption: true });
    expect(count('account_history_invalidations')).toBe(0);
  });

  it.each([
    ['core and pending that add up to Holdr\'s cash', 10, -10, 56, false, 0],
    ['pending cash Holdr did not have', 0, 10, 66, true, 1],
  ])('compares the economic cash, core plus pending: %s', async (_case, core, pending, total, adopted, corrections) => {
    account().cashBalance = core; account().pendingBalance = pending; account().totalValue = total;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', baseline: true, baselineCashAdoption: adopted });
    expect(count('account_history_invalidations')).toBe(corrections);
  });

  it('measures the 1D chart from the cash adoption instead of counting it as a gain', async () => {
    const snapshot = db().prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
      VALUES (?, 'synthetic', ?, ?, ?, ?)`);
    // The snapshot job before the capture, with Holdr's own cash (0); after the import, with the broker's (10).
    for (const time of ['11:30', '11:35', '11:40']) snapshot.run(`job-${time}`, `2026-10-19T${time}:00.000Z`, 56, 40, 0);
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', baselineCashAdoption: true });
    snapshot.run('job-12:05', '2026-10-19T12:05:00.000Z', 66, 50, 10);
    snapshot.run('job-12:10', '2026-10-19T12:10:00.000Z', 66.5, 50, 10);

    const chart = await getPortfolioHistory({ state: repo, history: createHistoryRepo(repo) }, '1D', undefined, new Date('2026-10-19T12:15:00.000Z'));

    expect(chart.points.map((point) => [point.t.slice(11, 16), point.value, Boolean(point.unreliable)])).toEqual([
      ['11:30', 56, true], ['11:35', 56, true], ['11:40', 56, true],
      ['12:00', 66, false], ['12:05', 66, false], ['12:10', 66.5, false],
    ]);
    expect(chart.summary).toMatchObject({ startValue: 66, endValue: 66.5, change: 0.5 });
  });

  it('starts the correction at the last observation before the capture, so 1W does not count it either', async () => {
    const snapshot = db().prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
      VALUES (?, 'synthetic', ?, ?, ?, ?)`);
    // Thursday's and Friday's last ticks with Holdr's own cash; nothing on Monday before the capture.
    snapshot.run('job-thu', '2026-10-15T23:55:00.000Z', 55, 40, 0);
    snapshot.run('job-fri', '2026-10-16T23:55:00.000Z', 56, 40, 0);
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', baselineCashAdoption: true });
    expect(db().prepare('SELECT effective_date FROM account_history_invalidations').pluck().all()).toEqual(['2026-10-16']);
    snapshot.run('job-mon', '2026-10-19T12:10:00.000Z', 66.5, 50, 10);

    const week = await getPortfolioHistory({ state: repo, history: createHistoryRepo(repo) }, '1W', undefined, new Date('2026-10-19T12:15:00.000Z'));

    expect(week.points.map((point) => [point.t, point.value, Boolean(point.unreliable)])).toEqual([
      ['2026-10-15T23:55:00.000Z', 55, false],
      ['2026-10-16T23:55:00.000Z', 56, true],
      [NOW, 66, false],
      ['2026-10-19T12:10:00.000Z', 66.5, false],
    ]);
    // Measured from the correction, not from Friday's figure with the old cash (that would be +10.50).
    expect(week.summary).toMatchObject({ startValue: 66, change: 0.5 });
  });

  it('restarts the household at the correction when the account was last observed in a tick that left another out', async () => {
    repo.createAccount({ id: 'other', name: 'Other', cashBalance: 0, currency: 'USD' });
    const snapshot = db().prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
      VALUES (?, ?, ?, ?, ?, ?)`);
    // Friday's ticks observe both accounts; Monday's tick before the capture had no live quote for the other one.
    for (const t of ['2026-10-16T23:50:00.000Z', '2026-10-16T23:55:00.000Z']) {
      snapshot.run(`job-s-${t}`, 'synthetic', t, 56, 40, 0);
      snapshot.run(`job-o-${t}`, 'other', t, 100, 100, 0);
    }
    snapshot.run('job-s-mon', 'synthetic', '2026-10-19T11:55:00.000Z', 56, 40, 0);
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', baselineCashAdoption: true });
    // The account's own correction starts on Monday, the day it was last observed.
    expect(db().prepare('SELECT effective_date FROM account_history_invalidations').pluck().all()).toEqual(['2026-10-19']);
    for (const [t, value] of [['2026-10-19T12:05:00.000Z', 66], ['2026-10-19T12:10:00.000Z', 66.5]] as const) {
      snapshot.run(`job-s-${t}`, 'synthetic', t, value, 50, 10);
      snapshot.run(`job-o-${t}`, 'other', t, 100, 100, 0);
    }

    const week = await getPortfolioHistory({ state: repo, history: createHistoryRepo(repo) }, '1W', undefined, new Date('2026-10-19T12:15:00.000Z'));

    // The household leaves out Monday's partial tick and the capture; its last point before the correction is Friday's.
    expect(week.points.map((point) => [point.t, point.value, Boolean(point.unreliable)])).toEqual([
      ['2026-10-16T23:50:00.000Z', 156, true],
      ['2026-10-16T23:55:00.000Z', 156, true],
      ['2026-10-19T12:05:00.000Z', 166, false],
      ['2026-10-19T12:10:00.000Z', 166.5, false],
    ]);
    expect(week.summary).toMatchObject({ startValue: 166, change: 0.5 });
  });

  it('uses native row valuation for baseline and replay without altering legacy trades or card tables', async () => {
    account().positions[0].marketValue = 56.03;
    account().totalValue = 66.03;
    const legacy = db().prepare('SELECT * FROM transactions').all(), beforeCards = cards();
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'applied', added: 0, rekeyed: 0, audited: 4, baseline: true, baselineCashAdoption: true,
    });
    expect(db().prepare('SELECT market_value FROM account_snapshots WHERE taken_at = ?').pluck().get(NOW)).toBe(66.03);
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, rekeyed: 0, audited: 0 });
    expect(db().prepare('SELECT * FROM transactions').all()).toEqual(legacy);
    expect(cards()).toEqual(beforeCards);
  });

  it('does not relax old packets without retained native valuation', async () => {
    account().totalValue = 66.03;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'held', reason: 'snapshot-total-mismatch' });
    expect(count('fidelity_investing_incremental')).toBe(0);
    expect(count('fidelity_investing_activity')).toBe(0);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(0);
  });

  it('keeps a native zero row value rather than falling back to a stale nonzero last quote', async () => {
    account().positions[0].marketValue = 0;
    account().totalValue = 10;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', baseline: true, added: 0 });
    expect(db().prepare('SELECT market_value FROM account_snapshots WHERE taken_at = ?').pluck().get(NOW)).toBe(10);
  });

  it.each([-0.020001, -0.02, 0.02, 0.020001])('keeps the native snapshot check at two cents: delta=%s', async delta => {
    account().positions[0].marketValue = 56;
    account().totalValue = 66 + delta;
    const result = (await incrementalRun()).accounts[0];
    expect(result.status).toBe(Math.abs(delta) <= 0.02 ? 'applied' : 'held');
    if (result.status === 'held') {
      expect(result.reason).toBe('snapshot-total-mismatch');
      expect(count('fidelity_investing_activity')).toBe(0);
      expect(repo.getAccount('synthetic')!.cashBalance).toBe(0);
    }
  });

  it.each([null, undefined, NaN, Infinity, '56.03'])('rejects malformed native valuation: %s', value => {
    Object.assign(account().positions[0], { marketValue: value });
    expect(() => validateFidelityInvestingInput(capture, policy)).toThrow('invalid fidelity investing input');
  });

  it('rejects mixed native/legacy valuation fields and never infers missing row values', () => {
    account().positions[0].marketValue = 56;
    account().positions.push({ symbol: 'OTHER', quantity: 1, pricePerUnit: 1, costBasis: 1 });
    expect(() => validateFidelityInvestingInput(capture, policy)).toThrow('invalid fidelity investing input');
  });

  it('holds unknown basis when native quantity has no execution/basis explanation', async () => {
    account().positions[0].costBasis = null;
    account().activity = [];
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'held', reason: 'unknown-position-basis-unproven', added: 0, audited: 0,
    });
    expect(count('fidelity_investing_incremental')).toBe(0);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(0);
  });

  it.each([NaN, Infinity])('never converts nonfinite basis into an allowed unknown basis: %s', async value => {
    account().positions[0].costBasis = value;
    await expect(incrementalRun()).rejects.toThrow('invalid fidelity investing input');
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(0);
  });

  it.each([-400, 0, 40, -39])('holds a first baseline with unknown basis and contradictory native NET: %s', async amount => {
    account().positions[0].costBasis = null;
    account().activity = [{ key: key(32), date: '2026-10-15', description: 'YOU BOUGHT SYNTHETIC',
      symbol: 'SYN', quantity: 8, pricePerUnit: 5, amount, fees: 0 }];
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'held', reason: 'unknown-position-basis-unproven', added: 0, audited: 0,
    });
    expect(count('fidelity_investing_incremental')).toBe(0);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(0);
  });

  it.each([0, 1])('proves first-baseline unknown basis from signed execution NET including fees: %s', async fees => {
    account().positions[0].costBasis = null;
    account().activity = [{ key: key(32), date: '2026-10-15', description: 'YOU BOUGHT SYNTHETIC',
      symbol: 'SYN', quantity: 8, pricePerUnit: 5, amount: -40 - fees, fees }];
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', baseline: true, added: 0 });
    expect(db().prepare('SELECT cost_basis FROM account_snapshots WHERE taken_at = ?')
      .pluck().get(capture.capturedAt)).toBe(account().cashBalance + 40 + fees);
  });

  it('adopts proven core-plus-pending cash at baseline without losing the explicit pending input', async () => {
    account().cashBalance = 20; account().pendingBalance = -10;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', baseline: true, baselineCashAdoption: true });
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(10);
    expect(account().pendingBalance).toBe(-10);
  });

  it.each([null, undefined, Infinity, '0'])('rejects malformed explicit pending components: %s', value => {
    Object.assign(account(), { pendingBalance: value });
    expect(() => validateFidelityInvestingInput(capture, policy)).toThrow('invalid fidelity investing input');
  });

  it.each([
    ['2026-10-20T01:00:00.000Z', '2026-10-19'],
    ['2026-03-09T01:00:00.000Z', '2026-03-08'],
    ['2026-11-02T01:00:00.000Z', '2026-11-01'],
  ])('baselines and imports using Eastern coverage across UTC midnight and DST: %s', async (instant, easternDay) => {
    db().prepare("UPDATE accounts SET updated_at = '2026-01-01T12:00:00.000Z'").run();
    db().prepare("UPDATE transactions SET date = '2026-01-01'").run();
    capture.capturedAt = instant;
    account().coverage.to = easternDay; account().activity = [];
    expect((await incrementalRun(instant)).accounts[0]).toMatchObject({ status: 'applied', baseline: true });
    expect(db().prepare('SELECT cutoff_day FROM fidelity_investing_incremental').pluck().get()).toBe(easternDay);
    capture.capturedAt = new Date(Date.parse(instant) + 30_000).toISOString();
    account().coverage.from = easternDay;
    account().activity = [{
      key: key(10), date: easternDay, description: 'SYNTHETIC BUY', symbol: 'SYN',
      quantity: 1, pricePerUnit: 5, amount: -5, fees: 0,
    }];
    account().positions[0].quantity = 9; account().cashBalance = 5; account().totalValue = 68;
    expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({ status: 'applied', added: 1 });
  });

  it('requires coverage of the previous Eastern observation day, not its UTC day', async () => {
    capture.capturedAt = '2026-10-20T01:00:00.000Z';
    account().coverage.to = '2026-10-19'; account().activity = [];
    await incrementalRun(capture.capturedAt);
    capture.capturedAt = '2026-10-20T05:00:00.000Z';
    account().coverage = { from: '2026-10-20', to: '2026-10-20' };
    expect((await incrementalRun(capture.capturedAt)).accounts[0].reason).toBe('incomplete-incremental-coverage');
  });

  it('accepts retained adjacent-day boundary coverage without requiring an exact end-day equality', async () => {
    capture.capturedAt = '2026-10-20T01:00:00.000Z';
    account().coverage.to = '2026-10-20';
    expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({ status: 'applied', baseline: true });
  });

  it('holds mismatching native holdings without baselining, adopting cash or auditing keys', async () => {
    account().positions[0].quantity = 9; account().totalValue = 73;
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'held', reason: 'baseline-holdings-mismatch', added: 0, audited: 0, rekeyed: 0,
    });
    expect(count('fidelity_investing_sources')).toBe(0);
    expect(count('fidelity_investing_incremental')).toBe(0);
    expect(count('fidelity_investing_activity')).toBe(0);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(0);
  });

  it('proves each symbol rather than merely matching the total number of shares', async () => {
    account().positions[0].symbol = 'OTHER';
    expect((await incrementalRun()).accounts[0].reason).toBe('baseline-holdings-mismatch');
    expect(count('fidelity_investing_incremental')).toBe(0);
  });

  it.each([[5e-9, 'applied'], [2e-8, 'held']])('enforces share-rounding tolerance at %s', async (delta, status) => {
    account().positions[0].quantity += Number(delta);
    account().totalValue += Number(delta) * 7;
    expect((await incrementalRun()).accounts[0].status).toBe(status);
  });

  it('imports unseen same-boundary-day activity later, without repeating authoritative cash adoption', async () => {
    await incrementalRun();
    const initial = db().prepare('SELECT previous_cash_balance, baseline_at, baseline_digest, baseline_cash_adopted FROM fidelity_investing_incremental').get();
    capture.capturedAt = '2026-10-19T12:00:30.000Z';
    account().activity.push({ ...account().activity[0], key: key(10), date: '2026-10-19', quantity: 1, amount: -5 });
    account().positions[0].quantity = 9; account().cashBalance = 5; account().totalValue = 68;
    const result = (await incrementalRun()).accounts[0];
    expect(result).toMatchObject({ status: 'applied', added: 1, audited: 1, rekeyed: 0 });
    expect(result.baselineCashAdoption).toBeUndefined();
    expect(db().prepare('SELECT previous_cash_balance, baseline_at, baseline_digest, baseline_cash_adopted FROM fidelity_investing_incremental').get()).toEqual(initial);
    expect(db().prepare('SELECT cash_balance, ledger_digest FROM fidelity_investing_incremental').get())
      .toEqual({ cash_balance: 5, ledger_digest: fidelityInvestingDigest(trades()) });
  });

  it('checks immutable boundary-day covered content even though no historical trade was fabricated', async () => {
    account().activity[0].date = '2026-10-19';
    await incrementalRun();
    const initial = db().prepare('SELECT * FROM fidelity_investing_incremental').get();
    capture.capturedAt = '2026-10-19T12:00:30.000Z';
    account().activity[0].fees = 1;
    expect((await incrementalRun()).accounts[0].reason).toBe('activity-key-content-conflict');
    expect(db().prepare('SELECT * FROM fidelity_investing_incremental').get()).toEqual(initial);
    expect(trades()).toHaveLength(1);
  });

  it.each(['unbound', 'ignored'])('does not baseline or adopt cash for an %s source', async variant => {
    policy = { bindings: [], ignoredSources: variant === 'ignored' ? [sourceId] : [] };
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: variant === 'ignored' ? 'ignored' : 'held', audited: 0, added: 0 });
    expect(count('fidelity_investing_incremental')).toBe(0);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(0);
  });

  it('rolls back adoption, private previous cash, covered keys and watermark when the baseline receipt fails', async () => {
    // Create empty importer tables using a held account, before adding a late-failure trigger.
    policy.bindings = [];
    await incrementalRun();
    policy.bindings = [{ sourceId, last4: '1234', accountId: 'synthetic' }];
    db().exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON fidelity_investing_receipts BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    await expect(incrementalRun()).rejects.toThrow('fidelity investing import failed');
    expect(count('fidelity_investing_sources')).toBe(0);
    expect(count('fidelity_investing_incremental')).toBe(0);
    expect(count('fidelity_investing_activity')).toBe(0);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(0);
    expect(count('account_snapshots')).toBe(0);
    expect(count('account_cash_history')).toBe(0);
    expect(trades()).toHaveLength(1);
  });

  it('does not silently re-anchor sources from the prior full-backfill importer', async () => {
    db().prepare('DELETE FROM transactions').run();
    await run();
    expect((await incrementalRun()).accounts[0].reason).toBe('existing-source-requires-reviewed-cutoff');
  });

  it('refuses earlier incremental development schema without inventing baseline audit provenance', async () => {
    db().exec(`CREATE TABLE fidelity_investing_incremental (
      source_id TEXT PRIMARY KEY, cutoff_day TEXT NOT NULL, ledger_digest TEXT NOT NULL, cash_balance REAL NOT NULL
    )`);
    await expect(incrementalRun()).rejects.toThrow('fidelity incremental schema requires reviewed migration');
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(0);
    expect(trades()).toHaveLength(1);
  });
});

async function stdinCli(envelope: unknown, maintenance = false, now?: string) {
  const policyFile = path.join(dir, 'policy.json');
  await writeFile(policyFile, JSON.stringify(policy));
  const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
  return spawnSync(process.execPath, syntheticCliArgs(root, [
    '--apply', '--stdin', '--db', path.join(dir, 'test.sqlite'), '--policy', policyFile, '--backup-directory', dir,
    '--control-root', path.join(dir, 'control')], maintenance, now),
  { cwd: root, encoding: 'utf8', input: JSON.stringify(envelope) });
}

function seedCutoff(cash = -53, day = '2026-09-30') {
  if (db().prepare("SELECT 1 FROM account_snapshots WHERE id = 'cutoff'").get()) return;
  db().prepare('UPDATE accounts SET cash_balance = ? WHERE id = ?').run(cash, 'synthetic');
  db().prepare(`INSERT OR IGNORE INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
    VALUES ('cutoff', 'synthetic', ?, ?, ?, ?)`).run(`${day}T23:59:59.000Z`, cash, cash, cash);
}

function seedCliBaseline() {
  repo.createTransaction({
    id: 'cli-legacy', accountId: 'synthetic', date: '2026-10-01', symbol: 'SYN',
    quantity: 8, pricePerUnit: 5, currency: 'USD',
  });
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'fidelity-investing-test-')));
  await mkdir(path.join(dir, 'control'), { mode: 0o700 });
  repo = new SqliteStateRepo({ file: path.join(dir, 'test.sqlite') });
  repo.write({ accounts: [{ id: 'synthetic', name: 'Synthetic Fidelity', currency: 'USD', cashBalance: 0, accountNumber: '1234' }], transactions: [] });
  db().prepare("UPDATE accounts SET updated_at = '2026-10-19T11:00:00.000Z'").run();
  capture = {
    format: 'holdr.fidelity-investing-capture', version: 1, capturedAt: NOW,
    accounts: [{
      sourceId, last4: '1234', currency: 'USD', coverage: { from: '2021-10-19', to: '2026-10-19' },
      activity: [
        { key: key(1), date: '2026-10-01', description: 'SYNTHETIC BUY', symbol: 'SYN', quantity: 10, pricePerUnit: 5, amount: -50, fees: 0 },
        { key: key(2), date: '2026-10-02', description: 'SYNTHETIC SELL', symbol: 'SYN', quantity: -2, pricePerUnit: 6, amount: 12, fees: 0 },
        { key: key(3), date: '2026-10-03', description: 'SYNTHETIC CASH', symbol: 'SPAXX', quantity: 0, pricePerUnit: 1, amount: 100, fees: 0 },
        { key: key(4), date: '2026-10-04', description: 'SYNTHETIC DIVIDEND', symbol: null, quantity: 0, pricePerUnit: null, amount: 1, fees: 0 },
      ],
      positions: [{ symbol: 'SYN', quantity: 8, pricePerUnit: 7, costBasis: 40 }],
      cashBalance: 10, totalValue: 66,
    }],
  };
  policy = { bindings: [{ sourceId, last4: '1234', accountId: 'synthetic' }], ignoredSources: [] };
});

afterEach(async () => {
  vi.restoreAllMocks();
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

describe('Append-only Fidelity cash observations', () => {
  const history = () => db().prepare('SELECT * FROM account_cash_history ORDER BY account_id, as_of_date').all();
  const seedLegacy = (day: string, method = 'broker-activity') => {
    db().prepare(`INSERT INTO account_cash_history
      (account_id, as_of_date, cash_balance, currency, broker, account_last4, source_hash, method, imported_at)
      VALUES ('synthetic', ?, 321, 'USD', 'fidelity', '1234', 'synthetic-legacy', ?, '2026-10-01T00:00:00.000Z')`)
      .run(day, method);
  };

  it.each([undefined, -3, 3, -20])('appends core plus pending without changing ledger replay semantics: %s', async pending => {
    if (pending !== undefined) account().pendingBalance = pending;
    account().totalValue += pending ?? 0;
    const cash = 10 + (pending ?? 0);
    expect((await run()).accounts[0]).toMatchObject({ status: 'applied', added: 2 });
    expect(history()).toEqual([expect.objectContaining({
      account_id: 'synthetic', as_of_date: '2026-10-19', cash_balance: cash, currency: 'USD',
      broker: 'fidelity', account_last4: '1234', source_hash: fidelityInvestingDigest(capture), method: 'fidelity-capture',
    })]);
    const before = history();
    expect((await run()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
    expect(history()).toEqual(before);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(cash);
  });

  it('uses the capture market day, not the UTC or import day, and appends on the next market day', async () => {
    capture.capturedAt = '2026-10-20T01:00:00.000Z';
    expect((await importFidelityInvesting(repo, capture, policy, {
      backupDirectory: dir, now: () => new Date('2026-10-20T12:00:00.000Z'), mode: 'full-backfill',
    })).accounts[0].status).toBe('applied');
    const before = history();
    expect(before).toEqual([expect.objectContaining({ as_of_date: '2026-10-19' })]);
    capture.capturedAt = '2026-10-20T05:00:00.000Z';
    expect((await importFidelityInvesting(repo, capture, policy, {
      backupDirectory: dir, now: () => new Date('2026-10-20T12:00:00.000Z'), mode: 'full-backfill',
    })).accounts[0].status).toBe('applied');
    expect(history()).toEqual([...before, expect.objectContaining({
      as_of_date: '2026-10-20', cash_balance: 10, method: 'fidelity-capture', source_hash: fidelityInvestingDigest(capture),
    })]);
  });

  it.each(['broker-activity', 'fidelity-capture'])('preserves a conflicting same-day %s row byte-for-byte', async method => {
    seedLegacy('2026-10-18');
    seedLegacy('2026-10-19', method);
    const before = history();
    expect((await run()).accounts[0].status).toBe('applied');
    expect(history()).toEqual(before);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(10);
    expect((await run()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
    expect(history()).toEqual(before);
  });

  it('keeps the first same-day observation even when a later applied capture changes economic cash', async () => {
    expect((await run()).accounts[0].status).toBe('applied');
    const before = history();
    capture.capturedAt = '2026-10-19T12:00:30.000Z';
    account().cashBalance = 20; account().totalValue = 76;
    expect((await run()).accounts[0].status).toBe('applied');
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(20);
    expect(history()).toEqual(before);
  });

  it('records a baseline and later incremental day while preserving legacy rows, and is reversible by method', async () => {
    seedCliBaseline();
    seedLegacy('2026-10-18');
    const legacy = history();
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', baseline: true });
    capture.capturedAt = '2026-10-20T12:00:00.000Z';
    account().coverage.to = '2026-10-20';
    account().activity.push({
      key: key(10), date: '2026-10-20', description: 'YOU BOUGHT SYNTHETIC (SYN) (Cash)',
      symbol: 'SYN', quantity: 1, pricePerUnit: 5, amount: -5, fees: 0,
    });
    account().positions[0].quantity = 9;
    account().cashBalance = 5; account().totalValue = 68;
    expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({ status: 'applied', added: 1 });
    expect(history()).toEqual([...legacy,
      expect.objectContaining({ as_of_date: '2026-10-19', cash_balance: 10, method: 'fidelity-capture' }),
      expect.objectContaining({ as_of_date: '2026-10-20', cash_balance: 5, method: 'fidelity-capture' }),
    ]);
    const before = history();
    expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
    expect(history()).toEqual(before);
    expect(db().prepare("DELETE FROM account_cash_history WHERE account_id = ? AND method = 'fidelity-capture'")
      .run('synthetic').changes).toBe(2);
    expect(history()).toEqual(legacy);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(5);
    expect(trades()).toHaveLength(2);
  });

  it.each(['unbound', 'ignored', 'total-mismatch'])('does not append for a %s account', async variant => {
    seedLegacy('2026-10-18');
    const before = history();
    if (variant === 'unbound' || variant === 'ignored') policy.bindings = [];
    if (variant === 'ignored') policy.ignoredSources = [sourceId];
    if (variant === 'total-mismatch') account().totalValue++;
    expect((await run()).accounts[0].status).toBe(variant === 'ignored' ? 'ignored' : 'held');
    expect(history()).toEqual(before);
  });

  it('rolls back ledger, cash, snapshots and source state if a cash-history insert fails', async () => {
    policy.bindings = [];
    await incrementalRun();
    policy.bindings = [{ sourceId, last4: '1234', accountId: 'synthetic' }];
    db().exec("CREATE TRIGGER fail_cash_history BEFORE INSERT ON account_cash_history BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    await expect(run()).rejects.toThrow('fidelity investing import failed');
    expect(history()).toEqual([]);
    expect(trades()).toEqual([]);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(0);
    for (const table of ['fidelity_investing_sources', 'fidelity_investing_activity', 'account_snapshots', 'account_history_invalidations']) {
      expect(count(table)).toBe(0);
    }
    expect(count('fidelity_investing_receipts')).toBe(1);
  });
});

describe('Owner-authorized T0 bridged baseline', () => {
  const option = 'TST261016P00010000';
  beforeEach(() => {
    repo.createTransaction({ id: 'bridge-legacy', accountId: 'synthetic', date: '2026-10-01',
      symbol: option, quantity: -1, pricePerUnit: 1, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
      sourceFingerprint: 'opaque-legacy', notes: 'unchanged' });
    db().prepare("UPDATE accounts SET cash_balance = 1200 WHERE id = 'synthetic'").run();
    account().activity = [
      { key: key(50), date: '2026-10-01', symbol: '-TST261016P10', quantity: -1,
        pricePerUnit: 1, amount: 100, fees: 0,
        description: 'YOU SOLD OPENING TRANSACTION PUT (TST) SYNTHETIC OCT 16 26 $10 (100 SHS) (Cash)' },
      { key: key(60), date: '2026-10-19', symbol: '-TST261016P10', quantity: 1,
        pricePerUnit: null, amount: 0, fees: 0,
        description: 'ASSIGNED AS OF 2026-10-16 PUT (TST) SYNTHETIC OCT 16 26 $10 (100 SHS) (Cash)' },
      { key: key(61), date: '2026-10-19', symbol: 'TST', quantity: 100,
        pricePerUnit: 10, amount: -1000, fees: 0,
        description: 'YOU BOUGHT ASSIGNED SYNTHETIC (TST) (Cash)' },
    ];
    account().positions = [{ symbol: 'TST', quantity: 100, pricePerUnit: 12, costBasis: null, marketValue: 1200 }];
    account().cashBalance = 1200;
    account().pendingBalance = -1000;
    account().totalValue = 1400;
  });
  const raw = () => db().prepare("SELECT * FROM transactions WHERE id = 'bridge-legacy'").get();
  const assertHeld = async (reason?: string) => {
    const legacy = raw(), before = trades(), beforeCards = cards();
    const beforeCashHistory = db().prepare('SELECT * FROM account_cash_history').all();
    const result = (await incrementalRun()).accounts[0];
    expect(result).toMatchObject({ status: 'held', added: 0, audited: 0, rekeyed: 0 });
    if (reason) expect(result.reason).toBe(reason);
    expect(result.baseline).toBeUndefined(); expect(result.bridgedBaseline).toBeUndefined();
    expect(trades()).toEqual(before); expect(raw()).toEqual(legacy); expect(cards()).toEqual(beforeCards);
    expect(db().prepare('SELECT * FROM account_cash_history').all()).toEqual(beforeCashHistory);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(1200);
    for (const table of ['fidelity_investing_sources', 'fidelity_investing_incremental',
      'fidelity_investing_bridges', 'fidelity_investing_activity', 'account_snapshots', 'account_history_invalidations']) {
      expect(count(table)).toBe(0);
    }
  };

  it('bridges a short put assignment at the latest provable day, preserves all legacy bytes and replays zero', async () => {
    const legacy = raw(), beforeCards = cards();
    const receipt = await incrementalRun();
    expect(receipt.accounts[0]).toMatchObject({ status: 'applied', added: 2, rekeyed: 0, duplicates: 0,
      audited: 3, baseline: true, baselineCashAdoption: false, bridgedBaseline: true, bridgedRowCount: 2 });
    expect(raw()).toEqual(legacy); expect(cards()).toEqual(beforeCards);
    expect(db().prepare('SELECT * FROM fidelity_investing_bridges').get()).toMatchObject({
      cutoff_day: '2026-10-18', row_count: 2, cash_delta: -1000, cash_adopted: 0,
    });
    expect(repo.listCashHistory('synthetic')).toEqual([expect.objectContaining({
      date: '2026-10-19', cashBalance: 200, method: 'fidelity-capture', sourceHash: fidelityInvestingDigest(capture),
    })]);
    expect(db().prepare('SELECT * FROM fidelity_investing_incremental').get()).toMatchObject({
      cutoff_day: '2026-10-18', previous_cash_balance: 1200, cash_balance: 200, baseline_cash_adopted: 0,
    });
    expect(db().prepare('SELECT activity_key, kind FROM fidelity_investing_activity ORDER BY activity_key').all()).toEqual([
      { activity_key: key(50), kind: 'baseline-covered' }, { activity_key: key(60), kind: 'security' },
      { activity_key: key(61), kind: 'security' },
    ]);
    expect(db().prepare('SELECT cost_basis FROM account_snapshots').pluck().get()).toBe(1100);
    const bridge = db().prepare('SELECT * FROM fidelity_investing_bridges').get();
    const replay = (await incrementalRun()).accounts[0];
    expect(replay).toMatchObject({ status: 'applied', added: 0, rekeyed: 0, audited: 0, duplicates: 2 });
    expect(replay.bridgedBaseline).toBeUndefined();
    expect(db().prepare('SELECT * FROM fidelity_investing_bridges').get()).toEqual(bridge);
    expect(Object.keys(receipt.accounts[0]).sort()).toEqual(['last4', 'status', 'added', 'rekeyed', 'duplicates',
      'audited', 'activityTypes', 'baseline', 'baselineCashAdoption', 'bridgedBaseline', 'bridgedRowCount'].sort());
    expect(JSON.stringify(receipt)).not.toMatch(/TST|1200|1000|cash_delta|source_id|cutoff_day|opaque/);
  });

  it.each([-0.019, 0, 0.019, -0.021, 0.021, 50])('distinguishes proven bridge cash from private baseline adoption: %s', async delta => {
    account().pendingBalance! += delta; account().totalValue += delta;
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'applied', bridgedBaseline: true, baselineCashAdoption: Math.abs(delta) > 0.02,
    });
    expect(db().prepare('SELECT cash_adopted, cash_delta FROM fidelity_investing_bridges').get()).toEqual({
      cash_adopted: Number(Math.abs(delta) > 0.02), cash_delta: -1000,
    });
  });

  it.each([0, 50])('records activity and cash correction invalidations for a bridge with residual adoption %s', async delta => {
    db().prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
      VALUES ('synthetic-before-bridge', 'synthetic', '2026-10-16T16:00:00.000Z', 1000, 1100, 1200)`).run();
    account().pendingBalance! += delta; account().totalValue += delta;
    const beforeCards = cards(), legacy = raw();
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'applied', bridgedBaseline: true, added: 2, baselineCashAdoption: delta !== 0,
    });
    const corrections = db().prepare(`SELECT account_id, effective_date, detected_at, reason
      FROM account_history_invalidations ORDER BY effective_date`).all();
    expect(corrections).toEqual([
      { account_id: 'synthetic', effective_date: '2026-10-16', detected_at: NOW, reason: FIDELITY_CASH_ADOPTED_REASON },
      { account_id: 'synthetic', effective_date: '2026-10-19', detected_at: NOW, reason: 'fidelity investing activity imported' },
    ]);
    expect(raw()).toEqual(legacy); expect(cards()).toEqual(beforeCards);
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
    expect(db().prepare(`SELECT account_id, effective_date, detected_at, reason
      FROM account_history_invalidations ORDER BY effective_date`).all()).toEqual(corrections);
  });

  it.each([-0.021, -0.019, 0, 0.019, 0.021])('keeps bridge cash correction threshold separate from security invalidation: %s', async delta => {
    account().activity = [{ key: key(60), date: '2026-10-19', symbol: '-TST261016P10', quantity: 1,
      pricePerUnit: null, amount: 0, fees: 0,
      description: 'EXPIRED PUT (TST) SYNTHETIC OCT 16 26 $10 (100 SHS) (Cash)' }];
    account().positions = []; account().pendingBalance = delta; account().totalValue = 1200 + delta;
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'applied', added: 1, bridgedBaseline: true, baselineCashAdoption: Math.abs(delta) > 0.02,
    });
    const reasons = db().prepare('SELECT reason FROM account_history_invalidations').pluck().all();
    expect(reasons.filter(reason => reason === 'fidelity investing activity imported')).toHaveLength(1);
    expect(reasons.filter(reason => reason === FIDELITY_CASH_ADOPTED_REASON)).toHaveLength(Math.abs(delta) > 0.02 ? 1 : 0);
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
    expect(count('account_history_invalidations')).toBe(reasons.length);
  });

  it.each(['same-day', 'later', 'future'])('refuses overlap with latest stored activity: %s', async variant => {
    db().prepare("UPDATE transactions SET date = ? WHERE id = 'bridge-legacy'")
      .run(variant === 'same-day' ? '2026-10-19' : variant === 'later' ? '2026-10-20' : '2027-01-01');
    await assertHeld('baseline-holdings-mismatch');
  });

  it('requires complete coverage back through the candidate T0', async () => {
    account().coverage.from = '2026-10-19'; account().activity.shift();
    await assertHeld('baseline-holdings-mismatch');
  });

  it.each(['event', 'history'])('T0 cannot precede the latest stored cash %s date', async variant => {
    if (variant === 'event') {
      db().prepare(`INSERT INTO account_cash_events
        (id, account_id, event_date, event_type, amount, currency, broker, account_last4, description, source_fingerprint)
        VALUES ('synthetic-cash', 'synthetic', '2026-10-19', 'deposit', 1, 'USD', 'fidelity', '1234', 'synthetic', 'synthetic')`).run();
    } else {
      db().prepare(`INSERT INTO account_cash_history
        (account_id, as_of_date, cash_balance, currency, broker, account_last4, source_hash, method)
        VALUES ('synthetic', '2026-10-19', 1200, 'USD', 'fidelity', '1234', 'synthetic', 'synthetic')`).run();
    }
    const events = db().prepare('SELECT * FROM account_cash_events').all();
    const history = db().prepare('SELECT * FROM account_cash_history').all();
    await assertHeld('baseline-holdings-mismatch');
    expect(db().prepare('SELECT * FROM account_cash_events').all()).toEqual(events);
    expect(db().prepare('SELECT * FROM account_cash_history').all()).toEqual(history);
  });

  it.each(['pending', 'marketValue'])('requires native economic/valuation evidence: %s', async field => {
    if (field === 'pending') delete account().pendingBalance;
    else delete account().positions[0].marketValue;
    await assertHeld('bridged-baseline-evidence-unproven');
  });

  it.each(['missing-leg', 'duplicate-leg', 'strike', 'quantity', 'descriptor', 'multiplier', 'net', 'price'])(
    'holds incomplete or contradictory native assignment evidence: %s', async variant => {
      if (variant === 'missing-leg') {
        account().activity.splice(1, 1);
        // Preserve the rollback shape, but not lifecycle evidence.
        account().activity.push({ key: key(65), date: '2026-10-19', symbol: '-TST261016P10', quantity: 1,
          pricePerUnit: 1, amount: 0, fees: 0, description: 'OPAQUE QUANTITY' });
      }
      if (variant === 'duplicate-leg') {
        account().activity.push({ ...account().activity[2], key: key(65) });
        account().positions[0].quantity = 200; account().positions[0].marketValue = 2400;
        account().positions[0].costBasis = 1900; account().totalValue = 2600;
      }
      if (variant === 'strike') account().activity[2].amount = -900;
      if (variant === 'quantity') {
        account().activity[2].quantity = 99; account().positions[0].quantity = 99;
      }
      if (variant === 'descriptor') account().activity[1].description = account().activity[1].description.replace('$10', '$11');
      if (variant === 'multiplier') account().activity[1].description = account().activity[1].description.replace('100 SHS', '10 SHS');
      if (variant === 'net') account().activity[1].amount = 1;
      if (variant === 'price') account().activity[2].pricePerUnit = 9;
      await assertHeld();
    });

  it('does not infer unknown assigned-stock basis from quotes or stored option premiums', async () => {
    account().activity.shift();
    await assertHeld('option-lifecycle-basis-unproven');
  });

  it('proves rollback per symbol, not aggregate quantity', async () => {
    account().positions[0].symbol = 'OTHER';
    await assertHeld('baseline-holdings-mismatch');
  });

  it.each(['YOU BOUGHT EXERCISED SYNTHETIC (TST) (Cash)', 'STOCK SPLIT', 'ACAT IN-KIND TRANSFER', 'RSU DEPOSIT'])(
    'does not widen the bridge event allowlist: %s', async description => {
      account().positions[0].costBasis = 900;
      account().activity[1].description = account().activity[1].description.replace('ASSIGNED', 'EXERCISED');
      account().activity[2].description = description;
      await assertHeld();
    });

  it('rejects offsetting contradictory NETs even when native basis is known and aggregate cash agrees', async () => {
    account().positions[0].costBasis = 900;
    account().activity.push(
      { key: key(70), date: '2026-10-19', description: 'YOU BOUGHT SYNTHETIC (NEW) (Cash)',
        symbol: 'NEW', quantity: 1, pricePerUnit: 2, amount: -3, fees: 0 },
      { key: key(71), date: '2026-10-19', description: 'YOU BOUGHT SYNTHETIC (NEW) (Cash)',
        symbol: 'NEW', quantity: 1, pricePerUnit: 2, amount: -1, fees: 0 },
    );
    account().positions.push({ symbol: 'NEW', quantity: 2, pricePerUnit: 2, costBasis: 4, marketValue: 4 });
    account().pendingBalance = -1004;
    await assertHeld('bridged-baseline-evidence-unproven');
  });

  it('holds even a fully proven exercise because the new bridge does not authorize exercise', async () => {
    db().prepare("UPDATE transactions SET symbol = 'TST261016C00010000', quantity = 1 WHERE id = 'bridge-legacy'").run();
    account().activity = [
      { ...account().activity[1], symbol: '-TST261016C10', quantity: -1,
        description: 'EXERCISED CALL (TST) SYNTHETIC OCT 16 26 $10 (100 SHS) (Cash)' },
      { ...account().activity[2], description: 'YOU BOUGHT EXERCISED SYNTHETIC (TST) (Cash)' },
    ];
    account().positions[0].costBasis = 1100;
    await assertHeld('bridged-baseline-evidence-unproven');
  });

  it('counts explicit native trades, cash and core settlement without double-charging core', async () => {
    account().activity.push(
      { key: key(70), date: '2026-10-19', description: 'YOU BOUGHT SYNTHETIC (NEW) (Cash)',
        symbol: 'NEW', quantity: 1, pricePerUnit: 2, amount: -2, fees: 0 },
      { key: key(71), date: '2026-10-19', description: 'CASH DIVIDEND', symbol: null,
        quantity: 0, pricePerUnit: null, amount: 1, fees: 0 },
      { key: key(72), date: '2026-10-19', description: 'YOU SOLD CORE', symbol: 'SPAXX',
        quantity: -2, pricePerUnit: 1, amount: 2, fees: 0 },
    );
    account().positions.push({ symbol: 'NEW', quantity: 1, pricePerUnit: 2, costBasis: 2, marketValue: 2 });
    account().pendingBalance = -1001;
    account().totalValue = 1401;
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'applied', added: 3, audited: 6, bridgedRowCount: 5, baselineCashAdoption: false,
    });
    expect(db().prepare('SELECT cash_delta FROM fidelity_investing_bridges').pluck().get()).toBe(-1001);
  });

  it.each([null, 'SPAXX', 'FCASH'])('accepts strictly shaped native DIRECT DEBIT as audited bridge cash: %s', async symbol => {
    account().activity.push({ key: key(70), date: '2026-10-19', description: 'DIRECT DEBIT',
      symbol, quantity: 0, pricePerUnit: null, amount: -1, fees: 0 });
    account().pendingBalance = -1001;
    account().totalValue = 1399;
    const first = (await incrementalRun()).accounts[0];
    expect(first).toMatchObject({
      status: 'applied', added: 2, audited: 4, bridgedBaseline: true, bridgedRowCount: 3, baselineCashAdoption: false,
    });
    expect(db().prepare('SELECT cash_delta FROM fidelity_investing_bridges').pluck().get()).toBe(-1001);
    expect(db().prepare('SELECT kind FROM fidelity_investing_activity WHERE activity_key = ?').pluck().get(key(70)))
      .toBe('cash-or-nonsecurity');
    expect(trades().some(tx => tx.sourceFingerprint === key(70))).toBe(false);
    expect(count('account_cash_events')).toBe(0);
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
  });

  it('accepts an anchored native DIRECT DEBIT prefix without retaining its suffix in the receipt', async () => {
    account().activity.push({ key: key(70), date: '2026-10-19', description: 'DIRECT DEBIT SYNTHETIC',
      symbol: null, quantity: 0, pricePerUnit: null, amount: -1, fees: 0 });
    account().pendingBalance = -1001;
    account().totalValue = 1399;
    const receipt = await incrementalRun();
    expect(receipt.accounts[0]).toMatchObject({ status: 'applied', added: 2, audited: 4, bridgedRowCount: 3 });
    expect(JSON.stringify(receipt)).not.toMatch(/DIRECT DEBIT|SYNTHETIC/);
  });

  it.each(['INTEREST', 'REDEMPTION', 'YOU BOUGHT'])(
    'uses native NET for proven core DIRECT DEBIT without suffix reclassification: %s', async suffix => {
      account().activity.push({ key: key(70), date: '2026-10-19',
        description: `DIRECT DEBIT SYNTHETIC ${suffix}`, symbol: 'SPAXX',
        quantity: 0, pricePerUnit: null, amount: -1, fees: 0 });
      account().pendingBalance = -1001;
      account().totalValue = 1399;
      expect((await incrementalRun()).accounts[0]).toMatchObject({
        status: 'applied', added: 2, audited: 4, bridgedRowCount: 3, baselineCashAdoption: false,
      });
      expect(db().prepare('SELECT cash_delta FROM fidelity_investing_bridges').pluck().get()).toBe(-1001);
      expect(trades().some(tx => tx.sourceFingerprint === key(70))).toBe(false);
      expect(count('account_cash_events')).toBe(0);
    });

  it.each(['positive', 'zero', 'quantity', 'fees', 'security',
    'leading-text', 'joined-prefix', 'hyphen-prefix', 'near-prefix'])(
    'holds a nonconforming DIRECT DEBIT without bridge writes: %s', async variant => {
      const row = { key: key(70), date: '2026-10-19', description: 'DIRECT DEBIT',
        symbol: null as string | null, quantity: 0, pricePerUnit: null as number | null, amount: -1, fees: 0 };
      if (variant === 'positive') row.amount = 1;
      if (variant === 'zero') row.amount = 0;
      if (variant === 'quantity') { row.quantity = 1; row.symbol = 'SPAXX'; row.pricePerUnit = 1; }
      if (variant === 'fees') row.fees = 1;
      if (variant === 'security') row.symbol = 'TST';
      if (variant === 'leading-text') row.description = 'SYNTHETIC DIRECT DEBIT';
      if (variant === 'joined-prefix') row.description = 'DIRECT DEBITED';
      if (variant === 'hyphen-prefix') row.description = 'DIRECT DEBIT-REVERSAL';
      if (variant === 'near-prefix') row.description = 'DIRECT DEBITS';
      account().activity.push(row);
      account().pendingBalance! += row.amount; account().totalValue += row.amount;
      await assertHeld();
    });

  it('rejects non-USD captures before DIRECT DEBIT can qualify for bridge evidence', async () => {
    account().activity.push({ key: key(70), date: '2026-10-19', description: 'DIRECT DEBIT',
      symbol: null, quantity: 0, pricePerUnit: null, amount: -1, fees: 0 });
    Object.assign(account(), { currency: 'EUR' });
    await expect(incrementalRun()).rejects.toThrow('invalid fidelity investing input');
    expect(trades()).toHaveLength(1);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(1200);
  });

  it('selects the latest exact day instead of replaying an earlier round trip', async () => {
    account().activity.push(
      { key: key(70), date: '2026-10-15', description: 'OPAQUE OLD BUY', symbol: 'OLD',
        quantity: 1, pricePerUnit: null, amount: 0, fees: 0 },
      { key: key(71), date: '2026-10-16', description: 'OPAQUE OLD SELL', symbol: 'OLD',
        quantity: -1, pricePerUnit: null, amount: 0, fees: 0 },
    );
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 2, bridgedRowCount: 2 });
    expect(db().prepare('SELECT cutoff_day FROM fidelity_investing_bridges').pluck().get()).toBe('2026-10-18');
    expect(trades().some(tx => tx.symbol === 'OLD')).toBe(false);
  });

  it('never uses a future Eastern activity day as evidence before capture', async () => {
    capture.capturedAt = '2026-10-20T01:00:00.000Z';
    account().coverage.to = '2026-10-20';
    account().activity[1].date = account().activity[2].date = '2026-10-20';
    const result = (await incrementalRun(capture.capturedAt)).accounts[0];
    expect(result).toMatchObject({ status: 'held', reason: 'baseline-holdings-mismatch', added: 0 });
    expect(count('fidelity_investing_bridges')).toBe(0);
  });

  it.each([1, -1])('bridges only a native-confirmed expiration against stored option side %s', async side => {
    db().prepare("UPDATE transactions SET quantity = ?, position_effect = 'open' WHERE id = 'bridge-legacy'").run(side);
    account().activity = [{ key: key(60), date: '2026-10-19', symbol: '-TST261016P10', quantity: -side,
      pricePerUnit: null, amount: 0, fees: 0,
      description: 'EXPIRED PUT (TST) SYNTHETIC OCT 16 26 $10 (100 SHS) (Cash)' }];
    account().positions = []; account().pendingBalance = 0; account().totalValue = 1200;
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'applied', added: 1, bridgedBaseline: true, bridgedRowCount: 1, baselineCashAdoption: false,
    });
  });

  it('holds an expiration that would open an option instead of closing a stored position', async () => {
    db().prepare("UPDATE transactions SET symbol = 'BASE', quantity = 1, instrument_type = NULL, contract_multiplier = NULL, position_effect = NULL WHERE id = 'bridge-legacy'").run();
    account().activity = [{ key: key(60), date: '2026-10-19', symbol: '-TST261016P10', quantity: 1,
      pricePerUnit: null, amount: 0, fees: 0,
      description: 'EXPIRED PUT (TST) SYNTHETIC OCT 16 26 $10 (100 SHS) (Cash)' }];
    account().positions = [
      { symbol: 'BASE', quantity: 1, pricePerUnit: 1, costBasis: 1, marketValue: 1 },
      { symbol: '-TST261016P10', quantity: 1, pricePerUnit: 0, costBasis: 0, marketValue: 0 },
    ];
    await assertHeld('invalid-projected-ledger');
  });

  it('does not hide an imported stored snapshot to make the new rows fit', async () => {
    db().prepare("UPDATE transactions SET source_fingerprint = 'pos:synthetic' WHERE id = 'bridge-legacy'").run();
    await assertHeld('incremental-baseline-would-be-hidden');
  });

  it('does not create a full history from an empty stored ledger', async () => {
    db().prepare('DELETE FROM transactions').run();
    await assertHeld('baseline-holdings-mismatch');
  });

  it('holds unseen pre-T0 rows on a later capture rather than overlapping legacy history', async () => {
    await incrementalRun();
    capture.capturedAt = '2026-10-19T12:00:30.000Z';
    account().activity.push({ key: key(70), date: '2026-10-18', description: 'CASH DIVIDEND', symbol: null,
      quantity: 0, pricePerUnit: null, amount: 1, fees: 0 });
    const before = trades();
    expect((await incrementalRun()).accounts[0]).toMatchObject({
      status: 'held', reason: 'bridged-baseline-overlap', added: 0, audited: 0,
    });
    expect(trades()).toEqual(before);
  });

  it('imports new post-T0 activity after the bridge without adopting cash again', async () => {
    await incrementalRun();
    capture.capturedAt = '2026-10-19T12:00:30.000Z';
    account().activity.push({ key: key(70), date: '2026-10-19', description: 'YOU BOUGHT SYNTHETIC (TST) (Cash)',
      symbol: 'TST', quantity: 1, pricePerUnit: 10, amount: -10, fees: 0 });
    account().positions[0].quantity = 101; account().positions[0].costBasis = 910;
    account().positions[0].marketValue = 1212; account().pendingBalance = -1010; account().totalValue = 1402;
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 1, audited: 1 });
  });

  describe('Exact-content activity key drift (synthetic four-twin replay)', () => {
    const audit = () => db().prepare('SELECT * FROM fidelity_investing_activity ORDER BY activity_key').all();
    const aliases = () => db().prepare('SELECT * FROM fidelity_investing_activity_aliases ORDER BY activity_key').all();
    const financialState = () => Object.fromEntries([
      'transactions', 'accounts', 'account_snapshots', 'account_cash_history', 'account_history_invalidations',
      'fidelity_investing_sources', 'fidelity_investing_incremental', 'fidelity_investing_bridges',
      'fidelity_investing_activity', 'fidelity_investing_activity_aliases',
    ].map(table => [table, db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    beforeEach(async () => {
      account().activity.push(
        { key: key(62), date: '2026-10-19', description: 'DIRECT DEBIT SYNTHETIC', symbol: null,
          quantity: 0, pricePerUnit: null, amount: -2, fees: 0 },
        { key: key(63), date: '2026-10-19', description: 'CASH DIVIDEND SYNTHETIC', symbol: 'SPAXX',
          quantity: 0, pricePerUnit: 1, amount: 3, fees: 0 },
      );
      account().pendingBalance = -999; account().totalValue = 1401;
      expect((await incrementalRun()).accounts[0]).toMatchObject({
        status: 'applied', added: 2, audited: 5, bridgedRowCount: 4, baselineCashAdoption: false,
      });
      capture.capturedAt = '2026-10-19T12:00:30.000Z';
      account().activity = account().activity.map(row => row.key === key(50) ? row
        : { ...row, key: key(Number.parseInt(row.key, 16) + 100) });
      account().activity.push(
        { key: key(70), date: '2026-10-19', description: 'CASH DEPOSIT NEW SYNTHETIC', symbol: null,
          quantity: 0, pricePerUnit: null, amount: 7, fees: 0 },
        { key: key(71), date: '2026-10-19', description: 'DIRECT DEBIT NEW SYNTHETIC', symbol: null,
          quantity: 0, pricePerUnit: null, amount: -2, fees: 0 },
        { key: key(72), date: '2026-10-19', description: 'INTEREST NEW SYNTHETIC', symbol: 'SPAXX',
          quantity: 0, pricePerUnit: 1, amount: 1, fees: 0 },
      );
      account().pendingBalance = -993; account().totalValue = 1407;
    });

    const held = async (reason: string) => {
      const before = financialState();
      expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({
        status: 'held', reason, added: 0, rekeyed: 0, audited: 0, duplicates: 0,
      });
      expect(financialState()).toEqual(before);
    };

    it('resolves four twins, closes 1->0 and holdings 2->0, and proves cash including three genuinely new rows', async () => {
      const beforeTrades = trades(), beforeAudit = audit(), beforeCards = cards();
      const originalDigest = db().prepare('SELECT baseline_digest FROM fidelity_investing_incremental').pluck().get();
      const mismatchCounts = (projected: { symbol: string; quantity: number }[]) => {
        const net = new Map<string, number>();
        for (const tx of projected) net.set(tx.symbol, (net.get(tx.symbol) ?? 0) + tx.quantity);
        const expected = new Map(account().positions.map(p => [p.symbol, p.quantity]));
        const symbols = [...new Set([...net.keys(), ...expected.keys()])];
        return {
          closed: [...net].filter(([symbol, quantity]) => quantity !== 0 && (expected.get(symbol) ?? 0) === 0).length,
          holdings: symbols.filter(symbol => (net.get(symbol) ?? 0) !== (expected.get(symbol) ?? 0)).length,
        };
      };
      // Key-only planning would reapply both assignment legs and trip the closed-position gate.
      const oldKeys = new Set((beforeAudit as { activity_key: string }[]).map(row => row.activity_key));
      const keyOnlyAdditions = account().activity.filter(row => !oldKeys.has(row.key) && row.quantity !== 0)
        .map(row => ({ symbol: row.symbol === '-TST261016P10' ? option : row.symbol!, quantity: row.quantity }));
      expect(mismatchCounts([...beforeTrades, ...keyOnlyAdditions])).toEqual({ closed: 1, holdings: 2 });
      const input = JSON.stringify(capture);
      const receipt = await incrementalRun();
      expect(receipt.captureDigest).toBe(fidelityInvestingDigest(capture));
      expect(receipt.accounts[0]).toMatchObject({ status: 'applied', added: 0, rekeyed: 0, duplicates: 2, audited: 7 });
      expect(mismatchCounts(trades())).toEqual({ closed: 0, holdings: 0 });
      expect(trades()).toEqual(beforeTrades); expect(cards()).toEqual(beforeCards);
      expect(JSON.stringify(capture)).toBe(input);
      expect(audit().filter(row => beforeAudit.some(old => JSON.stringify(old) === JSON.stringify(row)))).toEqual(beforeAudit);
      expect(aliases()).toEqual([60, 61, 62, 63].map(n => ({
        source_id: sourceId, activity_key: key(n + 100), canonical_key: key(n),
      })));
      for (const row of account().activity) {
        expect(db().prepare('SELECT content_digest FROM fidelity_investing_activity WHERE source_id = ? AND activity_key = ?')
          .pluck().get(sourceId, row.key)).toBe(fidelityInvestingDigest(row));
      }
      expect(repo.getAccount('synthetic')!.cashBalance).toBe(207);
      expect(db().prepare('SELECT cash_balance, baseline_digest FROM fidelity_investing_incremental').get())
        .toEqual({ cash_balance: 207, baseline_digest: originalDigest });
      expect(db().prepare('SELECT capture_digest FROM fidelity_investing_sources').pluck().get()).toBe(receipt.captureDigest);
      expect(db().prepare('SELECT capture_digest FROM fidelity_investing_receipts ORDER BY rowid DESC LIMIT 1').pluck().get())
        .toBe(receipt.captureDigest);
      expect(db().prepare('SELECT cash_balance FROM account_snapshots WHERE taken_at = ?').pluck().get(capture.capturedAt)).toBe(207);
      expect(count('account_cash_events')).toBe(0);
      expect(JSON.stringify(receipt)).not.toMatch(/TST|SYNTHETIC|canonical_key|content_digest|207|993/);
      const before = financialState();
      expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, rekeyed: 0, duplicates: 2, audited: 0 });
      expect(financialState()).toEqual(before);
    });

    it('reevaluates an exact fresh capture despite a prior held importer receipt for that digest', async () => {
      const digest = fidelityInvestingDigest(capture);
      const previousHeld = [{ last4: '1234', status: 'held', reason: 'closed-position-activity-unproven',
        added: 0, rekeyed: 0, duplicates: 0, audited: 0 }];
      db().prepare('INSERT INTO fidelity_investing_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('synthetic-held-receipt', digest, fidelityInvestingDigest(policy), capture.capturedAt, NOW,
          JSON.stringify(previousHeld), null, null);
      expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 7 });
      expect(db().prepare('SELECT COUNT(*) FROM fidelity_investing_receipts WHERE capture_digest = ?').pluck().get(digest)).toBe(2);
      expect(db().prepare('SELECT result_json FROM fidelity_investing_receipts WHERE id = ?').pluck().get('synthetic-held-receipt'))
        .toBe(JSON.stringify(previousHeld));
    });

    it('recognizes covered keys before the bridge cutoff without creating historical trades', async () => {
      account().activity[0] = { ...account().activity[0], key: key(150) };
      expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 8 });
      expect(db().prepare('SELECT kind FROM fidelity_investing_activity WHERE activity_key = ?').pluck().get(key(150)))
        .toBe('baseline-covered');
      expect(trades()).toHaveLength(3);
      expect(aliases()).toHaveLength(5);
    });

    it('upgrades the prior schema additively without changing original audit rows', async () => {
      const before = audit();
      db().exec('DROP TABLE fidelity_investing_activity_aliases');
      expect((await incrementalRun()).accounts[0].status).toBe('applied');
      for (const row of before) expect(audit()).toContainEqual(row);
      expect(aliases()).toHaveLength(4);
      expect(db().pragma('foreign_key_check')).toEqual([]);
    });

    it('retains canonical provenance across future captures, further key drift, and an old-key-only return', async () => {
      await incrementalRun();
      const beforeTrades = trades();
      capture.capturedAt = '2026-10-19T12:01:00.000Z';
      expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
      capture.capturedAt = '2026-10-19T12:02:00.000Z';
      account().activity = account().activity.map(row => row.key === key(160) ? { ...row, key: key(260) } : row);
      expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 1 });
      expect(aliases()).toContainEqual({ source_id: sourceId, activity_key: key(260), canonical_key: key(60) });
      capture.capturedAt = '2026-10-19T12:03:00.000Z';
      account().activity = account().activity.map(row => row.key === key(260) ? { ...row, key: key(60) } : row);
      expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
      expect(trades()).toEqual(beforeTrades);
      expect(repo.getAccount('synthetic')!.cashBalance).toBe(207);
    });

    it.each(['security', 'cash', 'covered'])('holds an original and its new key appearing together: %s', async kind => {
      const n = kind === 'security' ? 160 : kind === 'cash' ? 162 : 50;
      const twin = account().activity.find(row => row.key === key(n))!;
      account().activity.push({ ...twin, key: key(n === 50 ? 150 : n - 100) });
      await held('activity-key-content-conflict');
    });

    it('holds two unknown twins competing for one old identity', async () => {
      account().activity.push({ ...account().activity.find(row => row.key === key(162))!, key: key(262) });
      await held('activity-key-content-conflict');
    });

    it('holds when equal-content historical rows make a new identity ambiguous', async () => {
      const twin = account().activity.find(row => row.key === key(162))!;
      const old = { ...twin, key: key(262) };
      db().prepare('INSERT INTO fidelity_investing_activity VALUES (?, ?, ?, ?)')
        .run(sourceId, old.key, fidelityInvestingDigest(old), 'cash-or-nonsecurity');
      await held('activity-key-content-conflict');
    });

    it.each(['original', 'alias', 'alias-coappearance', 'further-alias-coappearance'])(
      'holds conflicting content or repeated canonical identity after aliasing: %s', async variant => {
        await incrementalRun();
        capture.capturedAt = '2026-10-19T12:01:00.000Z';
        const twin = account().activity.find(row => row.key === key(162))!;
        if (variant === 'alias') twin.description += ' CHANGED';
        else if (variant === 'original') account().activity.push({ ...twin, key: key(62), amount: -3 });
        else account().activity.push({ ...twin, key: key(variant === 'alias-coappearance' ? 62 : 262) });
        await held('activity-key-content-conflict');
      });

    it.each(['date', 'description', 'symbol', 'quantity', 'pricePerUnit', 'amount', 'fees'] as const)(
      'never aliases a row whose non-key %s differs', async field => {
        const row = account().activity.find(row => row.key === key(162))!;
        if (field === 'date') row.date = '2026-10-18';
        else if (field === 'description') row.description += ' CHANGED';
        else if (field === 'symbol') row.symbol = 'FCASH';
        else if (field === 'quantity') row.quantity = 1;
        else if (field === 'pricePerUnit') row.pricePerUnit = 1;
        else row[field] = 1;
        const before = financialState();
        const result = (await incrementalRun()).accounts[0];
        expect(result.status).toBe('held');
        expect(aliases()).toEqual([]);
        expect(financialState()).toEqual(before);
      });

    it('does not borrow a twin from a different source', async () => {
      // The active source lacks this audit; another approved source cannot provide its identity.
      const old = { ...account().activity.find(row => row.key === key(162))!, key: key(62) };
      db().prepare('DELETE FROM fidelity_investing_activity WHERE activity_key = ?').run(key(62));
      repo.createAccount({ id: 'other', name: 'Synthetic other', currency: 'USD', cashBalance: 0 });
      const otherSource = 'fidelity-' + 'b'.repeat(64);
      db().prepare('INSERT INTO fidelity_investing_sources VALUES (?, ?, ?, ?, ?)')
        .run(otherSource, 'other', NOW, key(900), NOW);
      db().prepare('INSERT INTO fidelity_investing_activity VALUES (?, ?, ?, ?)')
        .run(otherSource, old.key, fidelityInvestingDigest(old), 'cash-or-nonsecurity');
      await held('projected-cash-mismatch');
    });

    it.each(['cash', 'holdings', 'total', 'key-content'])('holds without partial aliases/audit/financial writes when %s proof fails', async proof => {
      if (proof === 'cash') { account().pendingBalance! += 1; account().totalValue += 1; }
      if (proof === 'holdings') account().positions[0].quantity += 1;
      if (proof === 'total') account().totalValue += 1;
      if (proof === 'key-content') account().activity[0].description += ' CHANGED';
      await held(proof === 'cash' ? 'projected-cash-mismatch' : proof === 'holdings' ? 'projected-holdings-mismatch'
        : proof === 'total' ? 'snapshot-total-mismatch' : 'activity-key-content-conflict');
    });

    it('requires the canonical ledger row for a security twin', async () => {
      db().prepare('UPDATE transactions SET source_fingerprint = ? WHERE source_fingerprint = ?').run(key(999), key(60));
      db().prepare('UPDATE fidelity_investing_incremental SET ledger_digest = ?').run(fidelityInvestingDigest(trades()));
      await held('ledger-key-content-conflict');
    });

    it('rolls aliases, audits, cash, and snapshots back if the final receipt write fails', async () => {
      const before = financialState(), receipts = count('fidelity_investing_receipts');
      db().exec("CREATE TRIGGER fail_alias_receipt BEFORE INSERT ON fidelity_investing_receipts BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
      await expect(incrementalRun()).rejects.toThrow('fidelity investing import failed');
      expect(financialState()).toEqual(before);
      expect(count('fidelity_investing_receipts')).toBe(receipts);
    });
  });

  it('rolls back the whole bridge if writing the receipt fails', async () => {
    policy.bindings = []; await incrementalRun();
    policy.bindings = [{ sourceId, last4: '1234', accountId: 'synthetic' }];
    db().exec("CREATE TRIGGER fail_bridge_receipt BEFORE INSERT ON fidelity_investing_receipts BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    const before = trades();
    await expect(incrementalRun()).rejects.toThrow('fidelity investing import failed');
    expect(trades()).toEqual(before);
    expect(count('fidelity_investing_bridges')).toBe(0);
    expect(count('fidelity_investing_sources')).toBe(0);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(1200);
  });

  it.each(['unknown', 'missing-price', 'contradictory-net', 'wrong-side', 'opaque-cash'])(
    'never treats an unexplained quantity or cash row as an explicit native trade: %s', async variant => {
      account().positions[0].costBasis = 900;
      const row = { key: key(70), date: '2026-10-19', description: 'YOU BOUGHT SYNTHETIC (NEW) (Cash)',
        symbol: 'NEW', quantity: 1, pricePerUnit: 2 as number | null, amount: -2, fees: 0 };
      if (variant === 'unknown') row.description = 'OPAQUE SECURITY MOVEMENT';
      if (variant === 'missing-price') row.pricePerUnit = null;
      if (variant === 'contradictory-net') row.amount = -3;
      if (variant === 'wrong-side') row.description = 'YOU SOLD SYNTHETIC (NEW) (Cash)';
      if (variant === 'opaque-cash') { row.description = 'OPAQUE CASH'; row.quantity = 0; row.amount = 0; }
      account().activity.push(row);
      if (row.quantity) account().positions.push({ symbol: 'NEW', quantity: 1, pricePerUnit: 2, costBasis: 2, marketValue: 2 });
      await assertHeld('bridged-baseline-evidence-unproven');
    });
});

describe('Native option lifecycle proofs', () => {
  const rawSymbol = (type: 'call' | 'put') => `-TST261016${type === 'call' ? 'C' : 'P'}10`;
  const canonicalSymbol = (type: 'call' | 'put') => `TST261016${type === 'call' ? 'C' : 'P'}00010000`;
  async function prepare(type: 'call' | 'put', side: 1 | -1, withStock = false) {
    const option = canonicalSymbol(type);
    repo.createTransaction({ id: 'native-option-open', accountId: 'synthetic', date: '2026-10-01',
      symbol: option, quantity: side, pricePerUnit: 1, fees: 0, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open', sourceFingerprint: key(50) });
    account().activity = [{
      key: key(50), date: '2026-10-01', symbol: rawSymbol(type), quantity: side,
      pricePerUnit: 1, amount: -side * 100, fees: 0,
      description: `YOU ${side > 0 ? 'BOUGHT' : 'SOLD'} OPENING TRANSACTION ${type.toUpperCase()} (TST) SYNTHETIC OCT 16 26 $10 (100 SHS) (Cash)`,
    }];
    account().positions = [{ symbol: rawSymbol(type), quantity: side, pricePerUnit: 2,
      costBasis: side * 100, marketValue: side * 200 }];
    if (withStock) {
      repo.createTransaction({ id: 'native-stock-open', accountId: 'synthetic', date: '2026-10-01',
        symbol: 'TST', quantity: 100, pricePerUnit: 5, fees: 0, currency: 'USD', sourceFingerprint: key(51) });
      account().activity.push({ key: key(51), date: '2026-10-01', symbol: 'TST', quantity: 100,
        pricePerUnit: 5, amount: -500, fees: 0, description: 'YOU BOUGHT SYNTHETIC (TST) (Cash)' });
      account().positions.push({ symbol: 'TST', quantity: 100, pricePerUnit: 7, costBasis: 500, marketValue: 700 });
    }
    account().cashBalance = 1000;
    account().pendingBalance = 0;
    account().totalValue = 1000 + side * 200 + (withStock ? 700 : 0);
    expect((await incrementalRun()).accounts[0]).toMatchObject({ status: 'applied', baseline: true });
    capture.capturedAt = '2026-10-19T12:00:30.000Z';
  }
  function event(type: 'call' | 'put', kind: 'exercise' | 'assignment' | 'expiration', side: 1 | -1) {
    const verb = kind === 'exercise' ? 'EXERCISED' : kind === 'assignment' ? 'ASSIGNED' : 'EXPIRED';
    return { key: key(60), date: '2026-10-19', symbol: rawSymbol(type), quantity: -side,
      pricePerUnit: null, amount: 0, fees: 0,
      description: `${verb} AS OF 2026-10-16 ${type.toUpperCase()} (TST) SYNTHETIC OCT 16 26 $10 (100 SHS) (Cash)` };
  }
  async function prepareDelivery(type: 'call' | 'put', kind: 'exercise' | 'assignment') {
    const side = kind === 'exercise' ? 1 : -1;
    const buysStock = kind === 'exercise' ? type === 'call' : type === 'put';
    await prepare(type, side, !buysStock);
    const quantity = buysStock ? 100 : -100;
    account().activity.push(event(type, kind, side), {
      key: key(61), date: '2026-10-19', symbol: 'TST', quantity, pricePerUnit: 10, amount: -quantity * 10, fees: 0,
      description: `YOU ${buysStock ? 'BOUGHT' : 'SOLD'} ${kind === 'exercise' ? 'EXERCISED' : 'ASSIGNED'} SYNTHETIC (TST) (Cash)`,
    });
    account().positions = buysStock ? [{ symbol: 'TST', quantity: 100, pricePerUnit: 12, costBasis: null, marketValue: 1200 }] : [];
    account().pendingBalance = -quantity * 10;
    account().totalValue = 1000
      + account().pendingBalance! + (buysStock ? 1200 : 0);
  }

  it.each([['call', 'exercise'], ['put', 'assignment'], ['put', 'exercise'], ['call', 'assignment']] as const)(
    'proves both legs and strike cash for %s %s, then replays without new writes', async (type, kind) => {
      await prepareDelivery(type, kind);
      const beforeCards = cards();
      const first = (await incrementalRun(capture.capturedAt)).accounts[0];
      expect(first).toMatchObject({ status: 'applied', added: 2, audited: 2, activityTypes: { [kind]: 2 } });
      expect(trades().filter(t => t.symbol === canonicalSymbol(type)).reduce((n, t) => n + t.quantity, 0)).toBe(0);
      if (account().positions.length) {
        expect(db().prepare('SELECT cost_basis FROM account_snapshots WHERE taken_at = ?').pluck().get(capture.capturedAt))
          .toBe(kind === 'exercise' ? 1100 : 900);
        expect(account().positions[0].costBasis).toBeNull();
        expect(trades().find(t => t.sourceFingerprint === key(61))?.pricePerUnit).toBe(10);
      }
      expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0, rekeyed: 0 });
      expect(cards()).toEqual(beforeCards);
    });

  it.each([1, -1] as const)('expires a native-confirmed option on side %s without inventing proceeds', async side => {
    await prepare('put', side);
    account().activity.push(event('put', 'expiration', side));
    account().positions = []; account().totalValue = 1000;
    expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({
      status: 'applied', added: 1, activityTypes: { expiration: 1 },
    });
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(1000);
    expect(trades().find(t => t.sourceFingerprint === key(60))).toMatchObject({
      pricePerUnit: 0, contractMultiplier: 100, positionEffect: 'close',
    });
    expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({ status: 'applied', added: 0, audited: 0 });
  });

  it('never closes an expired-by-calendar option without a native closing activity row', async () => {
    await prepare('call', 1);
    account().positions = []; account().totalValue = 1000;
    const before = trades();
    expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({
      status: 'held', reason: 'closed-position-activity-unproven', added: 0,
    });
    expect(trades()).toEqual(before);
  });

  it.each(['option-leg', 'stock-leg', 'wrong-ratio', 'adjusted-contract', 'nonzero-close-price'])(
    'holds unproven assignment atomically: %s', async failure => {
      await prepareDelivery('put', 'assignment');
      if (failure === 'option-leg') account().activity = account().activity.filter(r => r.key !== key(60));
      if (failure === 'stock-leg') account().activity = account().activity.filter(r => r.key !== key(61));
      if (failure === 'wrong-ratio') account().activity.find(r => r.key === key(61))!.quantity = 99;
      if (failure === 'adjusted-contract') account().activity.find(r => r.key === key(60))!.description =
        account().activity.find(r => r.key === key(60))!.description.replace('(100 SHS)', '(200 SHS)');
      if (failure === 'nonzero-close-price') account().activity.find(r => r.key === key(60))!.pricePerUnit = 1;
      const before = trades(), beforeCash = repo.getAccount('synthetic')!.cashBalance;
      expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({
        status: 'held', reason: 'option-lifecycle-leg-unproven', added: 0, audited: 0,
      });
      expect(trades()).toEqual(before); expect(repo.getAccount('synthetic')!.cashBalance).toBe(beforeCash);
    });

  it('keeps unknown stock basis and pending held without native opening premium evidence', async () => {
    await prepareDelivery('put', 'assignment');
    account().activity = account().activity.filter(r => r.key !== key(50));
    const before = trades(), beforeCash = repo.getAccount('synthetic')!.cashBalance;
    expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({
      status: 'held', reason: 'option-lifecycle-basis-unproven', added: 0, audited: 0,
    });
    expect(account().positions[0].costBasis).toBeNull();
    expect(trades()).toEqual(before); expect(repo.getAccount('synthetic')!.cashBalance).toBe(beforeCash);
  });

  it('holds contradictory native premium consideration instead of guessing an adjusted stock basis', async () => {
    await prepareDelivery('put', 'assignment');
    account().activity.find(r => r.key === key(50))!.amount = 999;
    // An unchanged audited key is rejected before any attempted basis calculation.
    expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({
      status: 'held', reason: 'activity-key-content-conflict', added: 0, audited: 0,
    });
  });

  it('rejects expiration before native contract expiry', async () => {
    await prepare('put', -1);
    const expired = event('put', 'expiration', -1);
    expired.date = '2026-10-15';
    account().activity.push(expired); account().positions = []; account().totalValue = 1000;
    expect((await incrementalRun(capture.capturedAt)).accounts[0]).toMatchObject({
      status: 'held', reason: 'option-lifecycle-leg-unproven', added: 0, audited: 0,
    });
  });
});

describe('Fidelity investing import', () => {
  it('writes original investing tables atomically and repeats with zero additions', async () => {
    const first = await run();
    expect(first.accounts).toEqual([{ last4: '1234', status: 'applied', added: 2, rekeyed: 0, duplicates: 0, audited: 4 }]);
    expect(trades().map(t => t.quantity)).toEqual([10, -2]);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(10);
    expect(count('account_snapshots')).toBe(1);
    // The imported trades (from their own date) and the adopted cash (the capture day) are each recorded.
    expect(count('account_history_invalidations')).toBe(2);
    expect(count('account_cash_events')).toBe(0);
    expect((await run()).accounts[0]).toEqual({ last4: '1234', status: 'applied', added: 0, rekeyed: 0, duplicates: 2, audited: 0 });
    expect(count('fidelity_investing_receipts')).toBe(2);
    expect(count('account_snapshots')).toBe(1);
    expect(count('account_history_invalidations')).toBe(2);
    const backups = (await readdir(dir)).filter(f => f.startsWith('fidelity-investing-'));
    expect(backups).toHaveLength(2);
    const backupCounts = backups.map(file => {
      const backup = new Database(path.join(dir, file), { readonly: true });
      try { return backup.prepare('SELECT COUNT(*) FROM transactions').pluck().get(); }
      finally { backup.close(); }
    });
    expect(backupCounts.sort()).toEqual([0, 2]);
    expect(db().prepare('SELECT cost_basis FROM account_snapshots').pluck().get()).toBe(50);
  });

  it('matches a proven legacy economic row once and preserves IDs and notes', async () => {
    account().activity = [account().activity[0], { ...account().activity[0], key: key(5) }];
    account().activity.forEach(r => { r.description = 'YOU BOUGHT SYNTHETIC (SYN) (Cash)'; });
    account().positions[0].quantity = 20; account().totalValue = 150;
    const fingerprint = computeFingerprint({ date: '2026-10-01', accountLast4: '1234', action: 'BUY', symbol: 'SYN', quantity: 10, pricePerUnit: 5 });
    repo.createTransaction({ id: 'legacy', accountId: 'synthetic', date: '2026-10-01', symbol: 'SYN', quantity: 10, pricePerUnit: 5, currency: 'USD', sourceFingerprint: fingerprint, notes: 'keep this note' });
    expect((await run()).accounts[0]).toMatchObject({ status: 'applied', added: 1, rekeyed: 1 });
    expect(trades()[0].id).toBe('legacy');
    expect(trades()[0].notes).toBe('keep this note');
    expect((await run()).accounts[0]).toMatchObject({ added: 0, rekeyed: 0, duplicates: 2 });
  });

  it('reserves native-key matches before consuming identical legacy rows', async () => {
    account().activity = [{ ...account().activity[0], key: key(5) }, account().activity[0]];
    account().positions[0].quantity = 20; account().totalValue = 150;
    repo.createTransaction({ id: 'native', accountId: 'synthetic', date: '2026-10-01', symbol: 'SYN', quantity: 10, pricePerUnit: 5, currency: 'USD', sourceFingerprint: key(1) });
    expect((await run()).accounts[0]).toMatchObject({ status: 'applied', added: 1, duplicates: 1 });
  });

  it.each(['pos:synthetic', undefined])('holds synthetic baseline %s without deleting it', async fp => {
    repo.createTransaction({ id: 'baseline', accountId: 'synthetic', date: '2020-01-01', symbol: 'SYN', quantity: 8, pricePerUnit: 5, currency: 'USD', sourceFingerprint: fp, notes: 'imported synthetic snapshot' });
    expect((await run()).accounts[0].reason).toBe('synthetic-baseline-requires-reviewed-migration');
    expect(trades()).toHaveLength(1);
    expect(trades()[0].id).toBe('baseline');
    expect(count('account_snapshots')).toBe(0);
  });

  it.each([
    ['missing-security-price', () => { account().activity[0].pricePerUnit = null; }],
    ['missing-security-symbol', () => { account().activity[0].symbol = null; }],
    ['projected-holdings-mismatch', () => { account().positions[0].quantity = 9; }],
    ['snapshot-total-mismatch', () => { account().totalValue = 67; }],
    ['explicit-account-binding-required', () => { policy.bindings = []; }],
    ['explicit-account-binding-required', () => { policy.bindings[0].last4 = '9999'; }],
  ] as const)('holds unsafe account: %s', async (reason, mutate) => {
    mutate();
    expect((await run()).accounts[0]).toMatchObject({ status: 'held', reason, added: 0, rekeyed: 0 });
    expect(trades()).toHaveLength(0);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(0);
    expect(count('fidelity_investing_receipts')).toBe(1);
  });

  it('preserves unmatched manual activity rather than replaying history over it', async () => {
    repo.createTransaction({ id: 'unmatched', accountId: 'synthetic', date: '2026-10-02', symbol: 'OTHER', quantity: 1, pricePerUnit: 1, currency: 'USD' });
    expect((await run()).accounts[0].reason).toBe('unmatched-existing-activity-in-coverage');
    expect(trades()).toHaveLength(1);
  });

  it.each([undefined, 'opaque-synthetic', key(99)])('holds unproven overlap without relabeling: %s', async fingerprint => {
    repo.createTransaction({ id: 'unproven', accountId: 'synthetic', date: '2026-10-01', symbol: 'SYN', quantity: 10, pricePerUnit: 5, currency: 'USD', sourceFingerprint: fingerprint });
    expect((await run()).accounts[0].reason).toBe('unmatched-existing-activity-in-coverage');
    expect(trades()).toHaveLength(1);
    expect(trades()[0].sourceFingerprint).toBe(fingerprint);
  });

  it('includes precoverage opening trades when reconciling a partial history', async () => {
    repo.createTransaction({ id: 'opening', accountId: 'synthetic', date: '2020-01-01', symbol: 'SYN', quantity: 1, pricePerUnit: 5, currency: 'USD' });
    account().positions[0].quantity = 9; account().totalValue = 73;
    expect((await run()).accounts[0]).toMatchObject({ status: 'applied', added: 2 });
    expect(trades()).toHaveLength(3);
  });

  it('does not hide short equity positions via shared aggregation', async () => {
    account().activity = [account().activity[1]]; account().positions = [];
    account().totalValue = 10;
    expect((await run()).accounts[0].reason).toBe('projected-holdings-mismatch');
  });

  it('explicitly ignores a source without creating a binding or activity', async () => {
    policy = { bindings: [], ignoredSources: [sourceId] };
    expect((await run()).accounts[0].status).toBe('ignored');
    expect(count('fidelity_investing_sources')).toBe(0);
    expect(count('fidelity_investing_activity')).toBe(0);
  });

  it('holds changed contents under the same immutable activity key', async () => {
    await run();
    capture.capturedAt = '2026-10-19T12:00:30.000Z';
    account().activity[0].description = 'CORRECTED SYNTHETIC';
    expect((await run()).accounts[0].reason).toBe('activity-key-content-conflict');
    expect(trades()).toHaveLength(2);
  });

  it('canonicalizes JSON object key order for repeat capture and activity digests', async () => {
    const first = await run();
    const reordered: unknown = JSON.parse(JSON.stringify(capture, (_key, value: unknown) => (
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse()) : value
    )));
    const second = await importFidelityInvesting(repo, reordered, policy, { backupDirectory: dir, now: () => new Date(NOW), mode: 'full-backfill' });
    expect(second.captureDigest).toBe(first.captureDigest);
    expect(second.accounts[0]).toMatchObject({ status: 'applied', added: 0, duplicates: 2 });
  });

  it('holds changed ledger rows with an unchanged native key', async () => {
    await run();
    db().prepare('UPDATE transactions SET quantity = 11 WHERE source_fingerprint = ?').run(key(1));
    expect((await run()).accounts[0].reason).toBe('ledger-key-content-conflict');
  });

  it('pins sources to existing investing accounts across policy changes', async () => {
    await run();
    repo.createAccount({ id: 'other', name: 'Synthetic other', cashBalance: 0, currency: 'USD' });
    policy.bindings[0].accountId = 'other';
    expect((await run()).accounts[0].reason).toBe('source-binding-conflict');
  });

  it('rejects older or conflicting same-instant captures', async () => {
    await run();
    capture.capturedAt = '2026-10-19T11:59:00.000Z';
    expect((await run()).accounts[0].reason).toBe('stale-or-conflicting-capture');
    capture.capturedAt = NOW; account().cashBalance = 11; account().totalValue = 67;
    expect((await run()).accounts[0].reason).toBe('stale-or-conflicting-capture');
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(10);
  });

  it('holds conflicting snapshots before any ledger mutation', async () => {
    db().prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
      VALUES ('conflict', 'synthetic', ?, 1, 1, 1)`).run(NOW);
    expect((await run()).accounts[0].reason).toBe('existing-snapshot-conflict');
    expect(trades()).toHaveLength(0);
  });

  it.each(['full-backfill', 'incremental'] as const)('does not race a derived job observation after capture: %s', async mode => {
    if (mode === 'incremental') repo.createTransaction({ id: 'stored', accountId: 'synthetic',
      date: '2026-10-14', symbol: 'SYN', quantity: 8, pricePerUnit: 5, currency: 'USD' });
    const tick = '2026-10-19T12:01:00.000Z';
    db().prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
      VALUES (?, 'synthetic', ?, 1, 1, 1)`).run(`snap-synthetic-${tick}`, tick);
    const derived = db().prepare('SELECT * FROM account_snapshots').all();
    const result = await importFidelityInvesting(repo, capture, policy, {
      backupDirectory: dir, now: () => new Date('2026-10-19T12:03:00.000Z'), mode,
    });
    expect(result.accounts[0]).toMatchObject({ status: 'applied', added: mode === 'incremental' ? 0 : 2 });
    if (mode === 'incremental') expect(result.accounts[0].baseline).toBe(true);
    expect(db().prepare('SELECT * FROM account_snapshots WHERE taken_at = ?').all(tick)).toEqual(derived);
    expect(db().prepare('SELECT COUNT(*) FROM account_snapshots WHERE taken_at = ?').pluck().get(NOW)).toBe(1);
  });

  it.each([null, '', '00000000-0000-4000-8000-000000000001', 'snap-synthetic-wrong-time', 'snap-other-2026-10-19T12:01:00.000Z',
    'snap-synthetic-2026-10-19T12:00:00.000Z'])('keeps genuine or unclassified newer observations fail-closed: %s', async id => {
    const tick = '2026-10-19T12:00:30.000Z';
    db().prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
      VALUES (?, 'synthetic', ?, 1, 1, 1)`).run(`snap-synthetic-${tick}`, tick);
    db().prepare(`INSERT INTO account_snapshots (id, account_id, taken_at, market_value, cost_basis, cash_balance)
      VALUES (?, 'synthetic', '2026-10-19T12:01:00.000Z', 1, 1, 1)`).run(id);
    const receipt = await importFidelityInvesting(repo, capture, policy, {
      backupDirectory: dir, now: () => new Date('2026-10-19T12:03:00.000Z'), mode: 'full-backfill',
    });
    expect(receipt.accounts[0]).toMatchObject({ status: 'held', reason: 'newer-account-observation-exists', added: 0, audited: 0 });
    expect(trades()).toHaveLength(0);
  });

  it('holds same-day opposite trades rather than assigning arbitrary execution order', async () => {
    account().activity[1].date = account().activity[0].date;
    expect((await run()).accounts[0].reason).toBe('same-day-execution-order-unproven');
    expect(trades()).toHaveLength(0);
  });

  it('holds a missing same-day purchase ahead of a proven existing sale', async () => {
    account().activity[1].date = account().activity[0].date;
    account().activity[1].description = 'YOU SOLD SYNTHETIC (SYN) (Cash)';
    const fingerprint = computeFingerprint({ date: '2026-10-01', accountLast4: '1234', action: 'SELL', symbol: 'SYN', quantity: -2, pricePerUnit: 6 });
    repo.createTransaction({ id: 'existing-sale', accountId: 'synthetic', date: '2026-10-01', symbol: 'SYN', quantity: -2, pricePerUnit: 6, currency: 'USD', sourceFingerprint: fingerprint });
    expect((await run()).accounts[0].reason).toBe('same-day-execution-order-unproven');
    expect(trades()).toHaveLength(1);
    expect(trades()[0].sourceFingerprint).toBe(fingerprint);
  });

  it('does not overwrite a later manual cash correction even without a newer snapshot', async () => {
    repo.updateAccount('synthetic', { cashBalance: 5 });
    db().prepare("UPDATE accounts SET updated_at = '2026-10-19T12:05:00.000Z'").run();
    expect((await run()).accounts[0].reason).toBe('newer-account-change-exists');
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(5);
    expect(trades()).toHaveLength(0);
  });

  it('distinguishes the importer write timestamp from an independent cash correction', async () => {
    await run();
    // A newer observation can precede the prior import's wall-clock write.
    capture.capturedAt = '2026-10-19T12:00:30.000Z';
    account().cashBalance = 11; account().totalValue = 67;
    expect((await importFidelityInvesting(repo, capture, policy, {
      backupDirectory: dir, now: () => new Date('2026-10-19T12:10:00.000Z'), mode: 'full-backfill',
    })).accounts[0].status).toBe('applied');
    capture.capturedAt = '2026-10-19T12:01:00.000Z';
    account().cashBalance = 12; account().totalValue = 68;
    expect((await importFidelityInvesting(repo, capture, policy, {
      backupDirectory: dir, now: () => new Date('2026-10-19T12:11:00.000Z'), mode: 'full-backfill',
    })).accounts[0].status).toBe('applied');
  });

  it('identical replay leaves a subsequent manual cash correction untouched', async () => {
    await run();
    repo.updateAccount('synthetic', { cashBalance: 5 });
    expect((await run()).accounts[0]).toMatchObject({ status: 'applied', added: 0 });
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(5);
  });

  it('imports and reconciles option contracts using shared option metadata and multipliers', async () => {
    const symbol = 'SYN261120P00010000';
    account().activity = [{
      key: key(6), date: '2026-10-01', symbol, quantity: -1, pricePerUnit: 2, amount: 200, fees: 0,
      description: 'YOU SOLD OPENING TRANSACTION PUT (SYN) SYNTHETIC NOV 20 26 $10 (100 SHS) (Cash)',
    }];
    account().positions = [{ symbol, quantity: -1, pricePerUnit: 1, costBasis: -200 }];
    account().cashBalance = 300; account().totalValue = 200;
    expect((await run()).accounts[0]).toMatchObject({ status: 'applied', added: 1 });
    expect(trades()[0]).toMatchObject({ instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open', quantity: -1 });
    expect((await run()).accounts[0]).toMatchObject({ added: 0, duplicates: 1 });
  });

  it('holds option contracts lacking parser-confirmed metadata', async () => {
    account().activity[0].symbol = 'SYN261120P00010000';
    expect((await run()).accounts[0].reason).toBe('missing-option-metadata');
  });

  it('holds invalid option closes even when the raw net quantity agrees', async () => {
    account().activity = [{
      key: key(6), date: '2026-10-01', symbol: 'SYN261120P00010000', quantity: -1, pricePerUnit: 2, amount: 200, fees: 0,
      description: 'YOU SOLD CLOSING TRANSACTION PUT (SYN) SYNTHETIC NOV 20 26 $10 (100 SHS) (Cash)',
    }];
    account().positions = [{ symbol: 'SYN261120P00010000', quantity: -1, pricePerUnit: 1, costBasis: -200 }];
    expect((await run()).accounts[0].reason).toBe('invalid-projected-ledger');
  });

  it('allows a held capture to succeed after its private policy is corrected', async () => {
    policy.bindings[0].last4 = '9999'; await run();
    policy.bindings[0].last4 = '1234';
    expect((await run()).accounts[0]).toMatchObject({ status: 'applied', added: 2 });
  });

  it('rolls back schema, trades, cash and receipts on a late database error', async () => {
    db().exec(`CREATE TRIGGER fail_snapshot BEFORE INSERT ON account_snapshots BEGIN SELECT RAISE(ABORT, 'PRIVATE SYNTHETIC VALUE'); END`);
    await expect(run()).rejects.toThrow('fidelity investing import failed');
    expect(trades()).toHaveLength(0);
    expect(repo.getAccount('synthetic')!.cashBalance).toBe(0);
    expect(count('account_snapshots')).toBe(0);
    expect(db().prepare("SELECT name FROM sqlite_master WHERE name = 'fidelity_investing_receipts'").get()).toBeUndefined();
  });

  it('does not write importer schema when backup fails', async () => {
    await expect(importFidelityInvesting(repo, capture, policy, { backupDirectory: path.join(dir, 'missing'), now: () => new Date(NOW) })).rejects.toThrow();
    expect(trades()).toHaveLength(0);
    expect(db().prepare("SELECT name FROM sqlite_master WHERE name = 'fidelity_investing_receipts'").get()).toBeUndefined();
  });

  it('migrates earlier importer metadata schema after backup without guessing write provenance', async () => {
    db().exec(`
      CREATE TABLE fidelity_investing_sources (
        source_id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE,
        captured_at TEXT NOT NULL, capture_digest TEXT NOT NULL
      );
      CREATE TABLE fidelity_investing_receipts (
        id TEXT PRIMARY KEY, capture_digest TEXT NOT NULL, policy_digest TEXT NOT NULL,
        captured_at TEXT NOT NULL, imported_at TEXT NOT NULL, result_json TEXT NOT NULL
      );
    `);
    expect((await run()).accounts[0].status).toBe('applied');
    expect((db().pragma('table_info(fidelity_investing_receipts)') as { name: string }[]).map(c => c.name)).toContain('job_id');
    expect((await run()).accounts[0].added).toBe(0);
  });

  it.each([false, true])('revalidates same/external-connection changes during backup: %s', async external => {
    const raw = db();
    const backup = raw.backup.bind(raw);
    vi.spyOn(raw, 'backup').mockImplementation(async (...args) => {
      const info = await backup(...args);
      const writer = external ? new Database(path.join(dir, 'test.sqlite')) : raw;
      try { writer.prepare("UPDATE accounts SET cash_balance = 1 WHERE id = 'synthetic'").run(); }
      finally { if (external) writer.close(); }
      return info;
    });
    await expect(run()).rejects.toThrow('database changed during backup');
    expect(trades()).toHaveLength(0);
  });

  it('detaches caller data before asynchronous backup', async () => {
    const promise = run();
    account().positions[0].quantity = 100;
    expect((await promise).accounts[0].status).toBe('applied');
  });

  it('commits safe and held accounts with one durable receipt', async () => {
    const secondSource = `fidelity-${'b'.repeat(64)}`;
    capture.accounts.push({ ...structuredClone(account()), sourceId: secondSource, last4: '5678' });
    const receipt = await run();
    expect(receipt.accounts.map(a => a.status)).toEqual(['applied', 'held']);
    expect(count('fidelity_investing_receipts')).toBe(1);
    expect(trades()).toHaveLength(2);
  });

  it('keeps descriptions and values out of returned receipts and durable audit', async () => {
    account().activity[0].description = 'PRIVATE SYNTHETIC DESCRIPTION';
    const receipt = await run();
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE SYNTHETIC DESCRIPTION');
    const audit = db().prepare('SELECT * FROM fidelity_investing_activity').all();
    expect(JSON.stringify(audit)).not.toContain('PRIVATE SYNTHETIC DESCRIPTION');
    expect(JSON.stringify(trades())).not.toContain('PRIVATE SYNTHETIC DESCRIPTION');
  });

  it.each([
    () => { account().activity.push({ ...account().activity[0] }); },
    () => { account().activity[0].date = '2026-02-30'; },
    () => { account().activity[0].quantity = Number.NaN; },
    () => { account().activity[0].fees = -1; },
    () => { policy.ignoredSources.push(sourceId); },
    () => { account().sourceId = 'unhashed'; },
    () => { Object.assign(account(), { acctNum: 'SYNTHETIC' }); },
    () => { account().coverage.from = '2027-01-01'; },
    () => { capture.capturedAt = '2026-10-19'; },
  ])('rejects malformed input without writes', async mutate => {
    mutate();
    expect(() => validateFidelityInvestingInput(capture, policy)).toThrow('invalid fidelity investing input');
    await expect(run()).rejects.toThrow();
    expect(trades()).toHaveLength(0);
    expect((await readdir(dir)).filter(f => f.startsWith('fidelity-investing-'))).toHaveLength(0);
  });

  it.each(['2026-10-17T12:00:00.000Z', '2026-10-20T12:00:00.000Z'])('rejects stale/future instant %s', async instant => {
    capture.capturedAt = instant;
    account().coverage.to = '2026-10-17';
    await expect(run()).rejects.toThrow('stale or future dated');
  });

  it('runs the CLI on disposable synthetic data and repeats with zero additions', async () => {
    seedCliBaseline();
    const liveNow = new Date().toISOString();
    capture.capturedAt = liveNow;
    account().coverage.to = liveNow.slice(0, 10);
    const captureFile = path.join(dir, 'capture.json');
    const policyFile = path.join(dir, 'policy.json');
    await writeFile(captureFile, JSON.stringify(capture));
    await writeFile(policyFile, JSON.stringify(policy));
    const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
    const args = syntheticCliArgs(root, [
      '--apply', '--db', path.join(dir, 'test.sqlite'), '--capture', captureFile,
      '--policy', policyFile, '--backup-directory', dir, '--control-root', path.join(dir, 'control')]);
    const first = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout).accounts[0]).toMatchObject({ added: 0, audited: 4, baseline: true, baselineCashAdoption: true });
    const second = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    expect(second.stderr).toBe('');
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).accounts[0].added).toBe(0);
    expect((await readdir(dir)).filter(f => f.startsWith('fidelity-preopen-'))).toHaveLength(2);
  });

  it('reads its pre-open backup back table by table, and stops before the import when the backup copied nothing', async () => {
    seedCliBaseline();
    const captureFile = path.join(dir, 'capture.json');
    const policyFile = path.join(dir, 'policy.json');
    await writeFile(captureFile, JSON.stringify(capture));
    await writeFile(policyFile, JSON.stringify(policy));
    const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
    // The child's driver resolves every backup with nothing copied, as better-sqlite3 does after a first busy step.
    const result = spawnSync(process.execPath, syntheticCliArgs(root, [
      '--apply', '--db', path.join(dir, 'test.sqlite'), '--capture', captureFile,
      '--policy', policyFile, '--backup-directory', dir, '--control-root', path.join(dir, 'control')], false, NOW, true),
    { cwd: root, encoding: 'utf8' });
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('fidelity pre-open backup readback failed\n');
    expect(result.status).toBe(1);
    // The empty file stays, never trusted. No import began: no import backup, and the seeded trade alone.
    const preopen = (await readdir(dir)).filter(f => f.startsWith('fidelity-preopen-'));
    expect(preopen).toHaveLength(1);
    expect((await stat(path.join(dir, preopen[0]))).size).toBe(0);
    expect((await readdir(dir)).filter(f => f.startsWith('fidelity-investing-'))).toHaveLength(0);
    expect(trades()).toHaveLength(1);
  });

  it('authenticates stdin envelope identity and stores a transaction-bound transport receipt', async () => {
    seedCliBaseline();
    // capturedAt and coverage stay on the fixture's NOW market day; the CLI child runs at NOW too.
    const body = { capture, heldSources: [], heldActivity: [], cancelled: 1, boundaryRows: 2 };
    const jobId = fidelityInvestingDigest(body);
    const first = await stdinCli({ jobId, ...body }, false, NOW);
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    const receipt = JSON.parse(first.stdout);
    expect(receipt).toMatchObject({ jobId, captureDigest: fidelityInvestingDigest(capture), status: 'complete', heldSources: 0, heldActivity: 0, cancelled: 1, boundaryRows: 2 });
    expect(receipt.accounts[0]).toMatchObject({ added: 0, baseline: true, baselineCashAdoption: true });
    const stored = db().prepare('SELECT job_id, transport_json FROM fidelity_investing_receipts').get() as { job_id: string; transport_json: string };
    expect(stored.job_id).toBe(jobId);
    expect(JSON.parse(stored.transport_json)).toMatchObject({ jobId, cancelled: 1, boundaryRows: 2 });
    const second = await stdinCli({ ...body, jobId }, false, NOW);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).accounts[0].added).toBe(0);
  });

  it('never reports complete when the envelope contains an unsupported source', async () => {
    seedCliBaseline();
    // At NOW the bound account applies, so only the unsupported source can hold the envelope.
    const heldId = `fidelity-${'b'.repeat(64)}`;
    const body = {
      capture, heldSources: [{ sourceId: heldId, last4: '5678', reason: 'unsupported-fidelity-holding' }],
      heldActivity: [{ sourceId: heldId, activity: account().activity[0] }], cancelled: 0, boundaryRows: 0,
    };
    const result = await stdinCli({ jobId: fidelityInvestingDigest(body), ...body }, false, NOW);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'held', heldSources: 1, heldActivity: 1 });
    expect(count('fidelity_investing_receipts')).toBe(1);
    expect(trades()).toHaveLength(1);
  });

  it('keeps an all-unsupported capture durably held without fabricating an account', async () => {
    capture.capturedAt = new Date().toISOString();
    capture.accounts = [];
    const body = {
      capture, heldSources: [{ sourceId, last4: '1234', reason: 'unsupported-fidelity-holding' }],
      heldActivity: [], cancelled: 0, boundaryRows: 0,
    };
    const result = await stdinCli({ jobId: fidelityInvestingDigest(body), ...body });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'held', accounts: [], heldSources: 1 });
    expect(count('fidelity_investing_receipts')).toBe(1);
    expect(trades()).toHaveLength(0);
  });

  it('refuses maintenance before any database open or backup', async () => {
    capture.capturedAt = new Date().toISOString();
    const body = { capture, heldSources: [], heldActivity: [], cancelled: 0, boundaryRows: 0 };
    const result = await stdinCli({ jobId: fidelityInvestingDigest(body), ...body }, true);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect((await readdir(dir)).filter(f => f.startsWith('fidelity-'))).toHaveLength(0);
    expect(trades()).toHaveLength(0);
  });

  it.skipIf(process.platform === 'darwin')('production CLI cannot bypass native lifecycle locks on a non-Mac host', async () => {
    capture.capturedAt = new Date().toISOString();
    const body = { capture, heldSources: [], heldActivity: [], cancelled: 0, boundaryRows: 0 };
    const policyFile = path.join(dir, 'policy.json');
    await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
    const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'tools', 'holdr-investing-sync', 'cli.mts'),
      '--apply', '--stdin', '--db', path.join(dir, 'test.sqlite'), '--policy', policyFile,
      '--backup-directory', dir, '--control-root', path.join(dir, 'control')],
    { cwd: root, encoding: 'utf8', input: JSON.stringify({ jobId: fidelityInvestingDigest(body), ...body }) });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect((await readdir(dir)).filter(f => f.startsWith('fidelity-'))).toHaveLength(0);
    expect(trades()).toHaveLength(0);
  });

  it.each(['job', 'extra', 'unscoped-held-row', 'negative-count'])('rejects malformed stdin transport before opening the database: %s', async variant => {
    capture.capturedAt = new Date().toISOString();
    const body: Record<string, unknown> = { capture, heldSources: [], heldActivity: [], cancelled: 0, boundaryRows: 0 };
    if (variant === 'extra') body.db = 'untrusted-path';
    if (variant === 'unscoped-held-row') body.heldActivity = [{ sourceId, activity: account().activity[0] }];
    if (variant === 'negative-count') body.cancelled = -1;
    const result = await stdinCli({ ...body, jobId: variant === 'job' ? key(99) : fidelityInvestingDigest(body) });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('untrusted-path');
    expect((await readdir(dir)).filter(f => f.startsWith('fidelity-'))).toHaveLength(0);
    expect(trades()).toHaveLength(0);
  });
});
