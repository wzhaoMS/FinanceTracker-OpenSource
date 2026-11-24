import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { heldSymbolsAcrossAccounts } from '@finance-tracker/shared';

import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { createHistoryRepo, getSymbolHistory, marketDate, rangeBounds } from '../services/symbolHistory.js';
import { getPortfolioHistory, getPortfolioPerformance } from '../services/portfolioHistory.js';
import {
  DISPOSABLE_MARKER,
  QUIET_BUSINESS_DAYS,
  SYNTHETIC_ACCOUNT_IDS,
  SYNTHETIC_MARKET,
  SYNTHETIC_METAL_MARKET,
  assertDisposableDataDir,
  buildSyntheticDataset,
  isInsideApiDataDir,
  prepareDisposableDataDir,
  seedDisposableDataDir,
  seedSyntheticHousehold,
  type SyntheticMarket,
} from './syntheticSeed.js';

const FRIDAY_EVENING = new Date('2026-10-16T22:57:00Z'); // 18:57 New York
const SUNDAY = new Date('2026-10-18T15:00:00Z');
const MONDAY_BEFORE_SESSION = new Date('2026-10-19T07:00:00Z'); // 03:00 New York
// Seeding writes ~50k rows and a full replay walks 4.5 years of ledger; about
// a second each here, so leave headroom for a loaded machine.
const SEEDING_TIMEOUT_MS = 30_000;

/**
 * Directory links: junctions on Windows, which any user may create there
 * (Node reports them as symlinks), symlinks elsewhere. Targets are absolute.
 */
const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';
/**
 * macOS and Linux only: tests that use chmod to let others write (on Windows
 * the ACL decides, and chmod cannot change it) or create file symlinks
 * (Windows allows those only with a privilege or Developer Mode). Each names
 * its Windows counterpart, mostly in pathSafety.windows.test.ts (ACLs
 * injected) and windowsAcl.win32.test.ts (real ACLs and NTFS hard links).
 */
const posixOnly = it.skipIf(process.platform === 'win32');

function businessDaysBack(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  for (let left = count; left > 0;) {
    date.setUTCDate(date.getUTCDate() - 1);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) left--;
  }
  return date.toISOString().slice(0, 10);
}

describe('disposable data directory guard', () => {
  let root: string;
  let savedHome: { HOME?: string; USERPROFILE?: string };

  beforeEach(async () => {
    root = fs.realpathSync(await mkdtemp(path.join(tmpdir(), 'ft-e2e-seed-')));
    // The ancestor checks stop at the home directory (or the checkout); make
    // it this private test root so the host's temp directory does not matter.
    // os.homedir() is HOME, or USERPROFILE on Windows.
    savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = root;
    process.env.USERPROFILE = root;
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedHome)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('recognises the API default data directory in any checkout', () => {
    expect(isInsideApiDataDir('/srv/FinanceTracker/apps/api/data')).toBe(true);
    expect(isInsideApiDataDir('/srv/FinanceTracker/Apps/API/Data/e2e')).toBe(true);
    expect(isInsideApiDataDir('/srv/FinanceTracker/apps/api/data-e2e')).toBe(false);
    expect(isInsideApiDataDir('/srv/FinanceTracker/.e2e-tmp/run-1/data')).toBe(false);
  });

  it('refuses apps/api/data, directly or through a symlink, without creating anything', () => {
    const live = path.join(root, 'checkout', 'apps', 'api', 'data');
    expect(() => prepareDisposableDataDir(live)).toThrow(/default \(live\) data directory/);
    expect(fs.existsSync(live)).toBe(false);

    fs.mkdirSync(live, { recursive: true });
    fs.symlinkSync(live, path.join(root, 'innocent-link'), DIR_LINK);
    expect(() => prepareDisposableDataDir(path.join(root, 'innocent-link', 'e2e'))).toThrow(/live/);
    expect(fs.readdirSync(live)).toEqual([]);
  });

  it('refuses an existing directory that has files but no disposable marker', () => {
    const dir = path.join(root, 'someone-elses-data');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'finance.db'), 'not ours');
    expect(() => prepareDisposableDataDir(dir)).toThrow(/no \.holdr-e2e-disposable marker/);
    expect(fs.readFileSync(path.join(dir, 'finance.db'), 'utf8')).toBe('not ours');
    expect(fs.existsSync(path.join(dir, DISPOSABLE_MARKER))).toBe(false);
  });

  it('creates and marks a new directory, and marks an empty one', () => {
    const fresh = path.join(root, 'nested', 'fresh');
    expect(prepareDisposableDataDir(fresh)).toBe(fresh);
    expect(fs.existsSync(path.join(fresh, DISPOSABLE_MARKER))).toBe(true);

    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    prepareDisposableDataDir(empty);
    expect(fs.readdirSync(empty)).toEqual([DISPOSABLE_MARKER]);
  });

  it('checks read-only with assertDisposableDataDir: no directory and no marker is ever created', () => {
    const missing = path.join(root, 'missing');
    expect(() => assertDisposableDataDir(missing)).toThrow(/ENOENT/);
    expect(fs.existsSync(missing)).toBe(false);

    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty, { mode: 0o700 });
    expect(() => assertDisposableDataDir(empty)).toThrow(/has no \.holdr-e2e-disposable marker/);
    expect(fs.readdirSync(empty)).toEqual([]);

    const marked = prepareDisposableDataDir(path.join(root, 'marked'));
    expect(assertDisposableDataDir(marked)).toBe(marked);
    expect(fs.readdirSync(marked)).toEqual([DISPOSABLE_MARKER]);
  });

  it('seeds a new directory once and refuses to seed over existing rows', () => {
    const dir = path.join(root, 'stack', 'data');
    const result = seedDisposableDataDir(dir, FRIDAY_EVENING);
    expect(result.dbFile).toBe(path.join(dir, 'finance.db'));
    expect(result.accounts).toBe(5);
    expect(result.transactions).toBeGreaterThan(100);
    expect(result.heldSymbols).toContain('NBIS');

    expect(() => seedDisposableDataDir(dir, FRIDAY_EVENING)).toThrow(/already has rows in accounts, transactions/);
    const repo = new SqliteStateRepo({ file: result.dbFile });
    try {
      expect(repo.counts()).toEqual({ accounts: result.accounts, transactions: result.transactions });
      // The metals ledger's closes are stored as its read side keeps CNBC's series.
      const metals = repo.internalGetDb().prepare(
        "SELECT DISTINCT symbol, range_kind, source FROM symbol_price_bars WHERE symbol LIKE 'holdr:metal:%' ORDER BY symbol",
      ).all();
      expect(metals).toEqual([
        { symbol: 'holdr:metal:XAG', range_kind: 'daily', source: 'cnbc-spot-daily' },
        { symbol: 'holdr:metal:XAU', range_kind: 'daily', source: 'cnbc-spot-daily' },
      ]);
      // Every close the seed reports is stored, at least about a year of business days for each metal.
      const stored = repo.internalGetDb().prepare("SELECT COUNT(*) AS n FROM symbol_price_bars WHERE symbol LIKE 'holdr:metal:%'").get() as { n: number };
      expect(result.metalCloses).toBe(stored.n);
      expect(result.metalCloses).toBeGreaterThan(SYNTHETIC_METAL_MARKET.length * 200);
    } finally {
      repo.close();
    }
  }, SEEDING_TIMEOUT_MS);

  describe('directories other users could change', () => {
    // Windows: ACLs that let Authenticated Users, Everyone or Users write are refused
    // (pathSafety.windows.test.ts; a real Users grant in windowsAcl.win32.test.ts).
    posixOnly.each([0o777, 0o770, 0o1777])('refuses an existing data directory with mode %o, empty or marked, writing nothing', (mode) => {
      const empty = path.join(root, 'empty');
      fs.mkdirSync(empty);
      fs.chmodSync(empty, mode);
      expect(() => prepareDisposableDataDir(empty)).toThrow(/writable by its group or by other users/);
      expect(fs.readdirSync(empty)).toEqual([]);

      const marked = path.join(root, 'marked');
      fs.mkdirSync(marked);
      fs.writeFileSync(path.join(marked, DISPOSABLE_MARKER), 'marked by this test');
      fs.chmodSync(marked, mode);
      expect(() => seedDisposableDataDir(marked, FRIDAY_EVENING)).toThrow(/writable by its group or by other users/);
      expect(fs.readdirSync(marked)).toEqual([DISPOSABLE_MARKER]);
      expect(fs.readFileSync(path.join(marked, DISPOSABLE_MARKER), 'utf8')).toBe('marked by this test');
    });

    // Windows: the seed is refused below a directory whose ACL lets Authenticated Users write,
    // and nothing is created below one (pathSafety.windows.test.ts).
    posixOnly('refuses a data directory below a directory others can write to, creating nothing', () => {
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      expect(() => seedDisposableDataDir(path.join(shared, 'stack', 'data'), FRIDAY_EVENING))
        .toThrow(/shared .*writable by its group or by other users/);
      expect(fs.readdirSync(shared)).toEqual([]);

      const existing = path.join(shared, 'data');
      fs.mkdirSync(existing, { mode: 0o700 });
      expect(() => prepareDisposableDataDir(existing)).toThrow(/above .*data/);
      expect(fs.readdirSync(existing)).toEqual([]);
    });

    it.runIf(process.platform === 'darwin')('refuses a data directory whose ACL lets others write', () => {
      const dir = path.join(root, 'acl');
      fs.mkdirSync(dir, { mode: 0o700 });
      execFileSync('chmod', ['+a', 'group:staff allow add_file,delete_child', dir]);
      expect(() => prepareDisposableDataDir(dir)).toThrow(/ACL that lets others write .*group:staff allow add_file,delete_child/);
      expect(fs.readdirSync(dir)).toEqual([]);
    });
  });

  describe('links that could lead to real data', () => {
    const makeMockLiveDb = (file: string): Buffer => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const db = new Database(file);
      db.exec("CREATE TABLE live_sentinel (note TEXT); INSERT INTO live_sentinel VALUES ('mock live row')");
      db.close();
      return fs.readFileSync(file);
    };
    const markedDir = (name: string): string => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, DISPOSABLE_MARKER), 'marked by this test');
      return dir;
    };

    // Windows: no counterpart for a file symlink, which needs a privilege there; the
    // hard-linked marker below is the unprivileged way to point a marker elsewhere, and runs there.
    posixOnly('never writes through a symlinked marker', () => {
      const live = path.join(root, 'mock-live', 'finance.db');
      const before = makeMockLiveDb(live);
      const dir = path.join(root, 'data');
      fs.mkdirSync(dir);
      fs.symlinkSync(live, path.join(dir, DISPOSABLE_MARKER));
      expect(() => seedDisposableDataDir(dir, FRIDAY_EVENING)).toThrow(/is a symbolic link/);
      expect(fs.readFileSync(live).equals(before)).toBe(true);
      expect(fs.readdirSync(dir)).toEqual([DISPOSABLE_MARKER]);
    });

    it('refuses a hard-linked marker', () => {
      const elsewhere = path.join(root, 'elsewhere.txt');
      fs.writeFileSync(elsewhere, 'not a marker');
      const dir = path.join(root, 'data');
      fs.mkdirSync(dir);
      fs.linkSync(elsewhere, path.join(dir, DISPOSABLE_MARKER));
      expect(() => prepareDisposableDataDir(dir)).toThrow(/has 2 hard links/);
      expect(fs.readFileSync(elsewhere, 'utf8')).toBe('not a marker');
    });

    const refusesLinkedDatabaseFile = (name: string, _kind: string, link: 'symlink' | 'hardlink', message: RegExp) => {
      const live = path.join(root, 'mock-live', 'finance.db');
      const before = makeMockLiveDb(live);
      const dir = markedDir('data');
      if (link === 'symlink') fs.symlinkSync(live, path.join(dir, name));
      else fs.linkSync(live, path.join(dir, name));
      expect(() => seedDisposableDataDir(dir, FRIDAY_EVENING)).toThrow(message);
      expect(fs.readFileSync(live).equals(before)).toBe(true);
      expect(fs.readdirSync(path.dirname(live))).toEqual(['finance.db']);
    };
    it.each([
      ['finance.db', 'a hard link', 'hardlink', /has 2 hard links/],
    ] as const)('refuses %s that is %s to another database before opening it', refusesLinkedDatabaseFile);
    // Windows: no counterpart for a file symlink, which needs a privilege there; hard links
    // (above, and in windowsAcl.win32.test.ts) are the unprivileged way, and run there.
    posixOnly.each([
      ['finance.db', 'a symlink', 'symlink', /is a symbolic link/],
      ['finance.db-wal', 'a symlink', 'symlink', /is a symbolic link/],
    ] as const)('refuses %s that is %s to another database before opening it', refusesLinkedDatabaseFile);

    it('refuses a data directory that is itself a symlink', () => {
      const target = path.join(root, 'target');
      fs.mkdirSync(target);
      const dir = path.join(root, 'data');
      fs.symlinkSync(target, dir, DIR_LINK);
      expect(() => prepareDisposableDataDir(dir)).toThrow(/not a plain directory/);
      expect(fs.readdirSync(target)).toEqual([]);
    });

    it('never rewrites an existing marker and refuses unexpected files next to it', () => {
      const dir = markedDir('data');
      seedDisposableDataDir(dir, FRIDAY_EVENING);
      expect(fs.readFileSync(path.join(dir, DISPOSABLE_MARKER), 'utf8')).toBe('marked by this test');

      const other = markedDir('other');
      fs.writeFileSync(path.join(other, 'state.json'), '{}');
      expect(() => prepareDisposableDataDir(other)).toThrow(/unexpected state\.json/);
    }, SEEDING_TIMEOUT_MS);
  });
});

describe('synthetic dataset', () => {
  it.each([
    ['a weekday evening', FRIDAY_EVENING],
    ['a weekend', SUNDAY],
    ['a weekday before the session opens', MONDAY_BEFORE_SESSION],
  ])('covers the e2e suite on %s', (_label, now) => {
    const dataset = buildSyntheticDataset(now);
    const today = marketDate(now);

    expect(dataset.accounts.every((account) => /^(Alex|Casey) · E2E /.test(account.name))).toBe(true);
    expect(dataset.accounts.every((account) => account.accountNumber?.startsWith('E2E'))).toBe(true);
    expect(dataset.accounts.every((account) => account.cashBalance > 0)).toBe(true);

    const held = heldSymbolsAcrossAccounts(dataset.transactions);
    expect(held).toEqual(expect.arrayContaining(['NBIS', 'NVDA']));
    for (const closed of ['AMD', 'FNILX']) {
      expect(held).not.toContain(closed);
      expect(dataset.transactions.some((row) => row.symbol === closed && row.quantity > 0)).toBe(true);
      expect(dataset.transactions.some((row) => row.symbol === closed && row.quantity < 0)).toBe(true);
    }

    const dates = dataset.transactions.map((row) => row.date).sort();
    expect(dates.at(-1)! < businessDaysBack(today, QUIET_BUSINESS_DAYS - 1)).toBe(true);
    expect(dates[0] < `${Number(today.slice(0, 4)) - 4}${today.slice(4)}`).toBe(true);
    const threeMonthsAgo = rangeBounds('3M', now).from;
    const recent = dataset.transactions.filter((row) => row.date >= threeMonthsAgo);
    expect(recent.filter((row) => row.symbol === 'NBIS').length).toBeGreaterThanOrEqual(4);
    const perDay = new Map<string, number>();
    for (const row of recent) perDay.set(row.date, (perDay.get(row.date) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeGreaterThan(1);

    const fiveYearsBack = rangeBounds('5Y', now).from;
    const latestWeekday = new Date(`${today}T00:00:00Z`).getUTCDay() % 6 === 0 ? businessDaysBack(today, 1) : today;
    for (const model of SYNTHETIC_MARKET) {
      const bars = dataset.dailyBars.filter((bar) => bar.symbol === model.symbol);
      expect(bars[0].t <= fiveYearsBack).toBe(true);
      expect(bars.at(-1)).toMatchObject({ t: latestWeekday, close: model.lastClose });
      expect(bars.every((bar) => bar.close > 0 && bar.low <= Math.min(bar.open, bar.close))).toBe(true);
    }
    const traded = new Set(dataset.transactions.map((row) => row.symbol));
    for (const symbol of [...traded, 'QQQ', 'SPY']) {
      expect(SYNTHETIC_MARKET.some((model) => model.symbol === symbol)).toBe(true);
    }

    const takenAt = Array.from(new Set(dataset.snapshots.map((row) => row.takenAt))).sort();
    expect(takenAt.length).toBeGreaterThan(100);
    expect(Date.parse(takenAt.at(-1)!)).toBeLessThanOrEqual(now.getTime());
    expect(dataset.snapshots).toHaveLength(takenAt.length * dataset.accounts.length);
    const snapshotDays = new Set(takenAt.map((value) => marketDate(new Date(value))));
    for (let back = 1; back <= 5; back++) expect(snapshotDays.has(businessDaysBack(today, back))).toBe(true);
  });

  it('is deterministic for a given clock', () => {
    const first = buildSyntheticDataset(FRIDAY_EVENING);
    const second = buildSyntheticDataset(FRIDAY_EVENING);
    expect(second.transactions).toEqual(first.transactions);
    expect(second.snapshots.slice(-5)).toEqual(first.snapshots.slice(-5));
    expect(second.dailyBars.slice(-5)).toEqual(first.dailyBars.slice(-5));
    expect(second.metalCloses).toEqual(first.metalCloses);
  });

  it('takes a caller\'s own ledger and cash in place of the built-in ones (the demo\'s), snapshots included', () => {
    const { alexBrokerage, caseyRetirement, caseyHsa } = SYNTHETIC_ACCOUNT_IDS;
    const seen: { market?: SyntheticMarket } = {};
    const dataset = buildSyntheticDataset(FRIDAY_EVENING, {
      ledger: (market) => {
        seen.market = market;
        return {
          trades: [
            { k: 20, account: alexBrokerage, symbol: 'MSFT', sellAll: true },
            { k: 40, account: alexBrokerage, symbol: 'MSFT', shares: 2 },
            { k: 30, account: caseyRetirement, symbol: 'FNILX', shares: 12.345 },
          ],
          cashBalances: { [alexBrokerage]: 123.45 },
        };
      },
    });
    expect(dataset.transactions.map((row) => [row.accountId, row.symbol, row.quantity])).toEqual([
      [alexBrokerage, 'MSFT', 2], [caseyRetirement, 'FNILX', 12.345], [alexBrokerage, 'MSFT', -2],
    ]);
    // Each trade fills as the market the ledger was chosen from says.
    expect(dataset.transactions[0].pricePerUnit).toBe(seen.market!.fillPrice(seen.market!.close('MSFT', 40), 2));
    const cash = (id: string) => dataset.accounts.find((account) => account.id === id)!.cashBalance;
    expect([cash(alexBrokerage), cash(caseyHsa)]).toEqual([123.45, 150.25]);
    const latest = dataset.snapshots.filter((row) => row.accountId === alexBrokerage).at(-1)!;
    expect([latest.cashBalance, latest.marketValue]).toEqual([123.45, 123.45]);
  });

  it('gives the metals ledger its own daily closes, never under a ticker, shaped for the price guard', () => {
    const dataset = buildSyntheticDataset(FRIDAY_EVENING);
    const today = marketDate(FRIDAY_EVENING);
    const tickers = new Set(SYNTHETIC_MARKET.map((model) => model.symbol));
    expect(new Set(dataset.metalCloses.map((row) => row.symbol))).toEqual(new Set(['holdr:metal:XAU', 'holdr:metal:XAG']));
    expect(dataset.metalCloses.some((row) => tickers.has(row.symbol))).toBe(false);
    expect(dataset.dailyBars.some((bar) => bar.symbol.startsWith('holdr:'))).toBe(false);
    const closesOf = (metal: string) => dataset.metalCloses.filter((row) => row.symbol === `holdr:metal:${metal}`);
    for (const model of SYNTHETIC_METAL_MARKET) {
      const closes = closesOf(model.metal);
      // The same business days as the stocks', through today.
      expect(closes.map((row) => row.t)).toEqual(dataset.dailyBars.filter((bar) => bar.symbol === 'SPY').map((bar) => bar.t));
      expect(closes.at(-1)!.t).toBe(today);
      expect(closes.every((row) => row.close > 0 && Number.isFinite(row.close))).toBe(true);
      // Its moves of more than 20% from one close to the next are exactly its shifts, each where its model puts it.
      const moves = closes.flatMap((row, index) => (index > 0 && Math.abs(row.close / closes[index - 1].close - 1) > 0.2
        ? [closes.length - 1 - index] : []));
      expect(moves).toEqual(model.shifts.map((shift) => shift.fromBack - 1));
    }
    // Gold: twelve closes at a level 25% up, after hundreds before it at the old one (the guard admits the fourth).
    const gold = closesOf('XAU');
    expect(gold.at(-1)!.close).toBe(Math.round(2650.4 * 1.25 * 100) / 100);
    expect(gold.slice(0, -12).length).toBeGreaterThan(5);
    // Silver: its last eight closes are a unit error, outside any believable price for silver (USD 3 to 200 an ounce).
    const silver = closesOf('XAG');
    expect(silver.slice(-8).every((row) => row.close > 200)).toBe(true);
    expect(silver.slice(0, -8).slice(-20).every((row) => row.close > 3 && row.close < 200)).toBe(true);
  });
});

describe('seeded household served by the API without providers', () => {
  let repo: SqliteStateRepo;
  const fetchSpy = vi.fn(async () => {
    throw new Error('the seeded stack must not need the network');
  });

  beforeEach(() => {
    repo = new SqliteStateRepo({ file: ':memory:', now: () => FRIDAY_EVENING });
    seedSyntheticHousehold(repo, FRIDAY_EVENING);
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
  }, SEEDING_TIMEOUT_MS);

  afterEach(() => {
    vi.unstubAllGlobals();
    repo.close();
  });

  it('answers every portfolio range from market prices, snapshots or the ledger', async () => {
    const deps = { state: repo, history: createHistoryRepo(repo), fetchQuotes: async () => [] };
    // 1D and 1W are computed from the holdings at the seeded intraday prices; without a fetcher nothing is asked for.
    const oneDay = await getPortfolioHistory(deps, '1D', undefined, FRIDAY_EVENING);
    expect(oneDay).toMatchObject({ source: 'intraday_prices', valueMethod: 'holdings_at_market', approximate: false });
    expect(oneDay.points.length).toBeGreaterThan(50);
    const oneWeek = await getPortfolioHistory(deps, '1W', undefined, FRIDAY_EVENING);
    expect(oneWeek).toMatchObject({ source: 'intraday_prices', valueMethod: 'holdings_at_market' });
    expect(oneWeek.points.length).toBeGreaterThan(50);
    expect(oneWeek.returns?.points).toHaveLength(oneWeek.points.length);
    for (const range of ['1M', '3M', 'YTD', '1Y', '5Y', 'ALL'] as const) {
      const result = await getPortfolioHistory(deps, range, undefined, FRIDAY_EVENING);
      expect(result).toMatchObject({ source: 'reconstruction', valueMethod: 'ledger_estimate' });
      expect(result.approximationReasons[0]).toBe("estimated by replaying every recorded transaction at each day's closing price");
      expect(result.approximationReasons.join(' ')).not.toMatch(/refresh failed|no daily price history|no price available/);
      expect(result.returns?.points).toHaveLength(result.points.length);
    }
    const scoped = await getPortfolioHistory(deps, '3M', ['e2e-alex-brokerage'], FRIDAY_EVENING);
    expect(scoped.valueMethod).toBe('ledger_estimate');

    const performance = await getPortfolioPerformance(deps, undefined, FRIDAY_EVENING);
    const inception = performance?.periods.at(-1);
    expect(inception?.key).toBe('INCEPTION');
    expect(inception?.benchmarks.QQQ).not.toBeNull();
    expect(inception?.benchmarks.SPY).not.toBeNull();
    expect(performance?.years.length).toBeGreaterThanOrEqual(4);

    const nbis = await getSymbolHistory(createHistoryRepo(repo), 'NBIS', '3M', FRIDAY_EVENING);
    expect(nbis.supported).toBe(true);
    expect(nbis.sources).toEqual(['synthetic']);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, SEEDING_TIMEOUT_MS);
});

describe('year boundary', () => {
  // A ledger series needs two business days, so YTD replays the ledger only
  // from the year's second weekday. Before that the API serves the first
  // session's observed snapshots or, before any session of the new year, the
  // labeled current-holdings backtest. Every other range is unaffected.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('the seeded stack must not need the network');
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['2027-01-01T18:00:00Z', 'the first weekday, mid-session', 'observed_snapshot', 'snapshots'],
    ['2027-01-04T18:00:00Z', 'the second weekday', 'ledger_estimate', 'reconstruction'],
    ['2028-01-01T15:00:00Z', 'a Saturday New Year, before any session', 'current_holdings_backtest', 'none'],
    ['2028-01-03T18:00:00Z', 'the first weekday after a weekend New Year', 'observed_snapshot', 'snapshots'],
    ['2028-01-04T18:00:00Z', 'that year\'s second weekday', 'ledger_estimate', 'reconstruction'],
  ])('serves YTD at %s (%s) as %s', async (iso, _label, valueMethod, source) => {
    const now = new Date(iso);
    const repo = new SqliteStateRepo({ file: ':memory:', now: () => now });
    try {
      seedSyntheticHousehold(repo, now);
      const deps = { state: repo, history: createHistoryRepo(repo), fetchQuotes: async () => [] };
      const ytd = await getPortfolioHistory(deps, 'YTD', undefined, now);
      expect(ytd).toMatchObject({ supported: true, valueMethod, source });
      expect(ytd.coverage.requestedTo).toBe(marketDate(now));
      // 1D and 1W at market prices show the latest sessions, as before.
      expect((await getPortfolioHistory(deps, '1D', undefined, now)).valueMethod).toBe('holdings_at_market');
      expect((await getPortfolioHistory(deps, '1W', undefined, now)).valueMethod).toBe('holdings_at_market');
      for (const range of ['1M', '3M', '1Y', 'ALL'] as const) {
        expect((await getPortfolioHistory(deps, range, undefined, now)).valueMethod).toBe('ledger_estimate');
      }
    } finally {
      repo.close();
    }
  }, SEEDING_TIMEOUT_MS);
});
