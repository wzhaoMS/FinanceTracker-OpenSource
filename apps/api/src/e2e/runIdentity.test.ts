import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunIdentity, isDisposableDataDir } from './runIdentity.js';
import { DISPOSABLE_MARKER, prepareDisposableDataDir } from './syntheticSeed.js';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRELOAD = path.resolve(API_DIR, '..', '..', 'scripts', 'e2e-offline-fetch.mjs');
// Retargets a symlink on the way to HOLDR_DATA_DIR once the API has checked the directory.
const RETARGET_AFTER_CHECK = path.join(API_DIR, 'src', 'e2e', '__fixtures__', 'retargetAfterCheck.mjs');
// What Playwright's global setup uses to accept or refuse a stack.
const BROWSER_GATE = path.resolve(API_DIR, '..', 'web', 'tests', 'stack-identity.ts');
const RUN_ID = '0123456789abcdef0123456789abcdef';

/**
 * macOS and Linux only: tests that create file symlinks (Windows allows them
 * only with a privilege or Developer Mode), that treat chmod 0o777 as "others
 * can write" (on Windows the ACL decides, and chmod cannot change it), or that
 * rename a file or directory the running API holds open (Windows refuses).
 * Their Windows equivalents: pathSafety.windows.test.ts (ACLs granting others
 * write, refused at startup, at the next pre-open check and in /health, also
 * after a change on the same file; junctions; hard links) and
 * windowsAcl.win32.test.ts (the same against real ACLs, icacls, junctions and
 * NTFS hard links). Everything else here runs on Windows too.
 */
const posixOnly = it.skipIf(process.platform === 'win32');
/**
 * Directory links: junctions on Windows, which any user may create there
 * (Node reports them as symlinks), symlinks elsewhere. Targets are absolute.
 */
const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';
// Each API start compiles the server with tsx: a second or two.
const API_TIMEOUT_MS = 60_000;

/** A mock live database outside the data directory, with a row that must survive. */
function makeMockLiveDb(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'finance.db');
  const db = new Database(file);
  db.exec("CREATE TABLE live_sentinel (note TEXT); INSERT INTO live_sentinel VALUES ('mock live row')");
  db.close();
  return file;
}

/** Names, kinds, sizes and link counts: any change to the directory shows. */
function snapshot(dir: string): string[] {
  return fs.readdirSync(dir).sort().map((name) => {
    const stats = fs.lstatSync(path.join(dir, name));
    return `${name} ${stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'dir' : 'file'} ${stats.size} nlink=${stats.nlink}`;
  });
}

type Fixture = (root: string) => { dataDir: string; live?: string };

/** A marked, private data dir where `name` links to a mock live database. */
const linkedToLiveDb = (link: 'symlink' | 'hard link', name = 'finance.db'): Fixture => (root) => {
  const live = makeMockLiveDb(path.join(root, 'mock-live'));
  const dataDir = prepareDisposableDataDir(path.join(root, 'data'));
  if (link === 'symlink') fs.symlinkSync(live, path.join(dataDir, name));
  else fs.linkSync(live, path.join(dataDir, name));
  return { dataDir, live };
};

const SYMLINKED_DB: [string, Fixture, RegExp] = [
  'finance.db is a symlink to a live database', linkedToLiveDb('symlink'), /finance\.db is a symbolic link/,
];
const HARD_LINKED_DB: [string, Fixture, RegExp] = [
  'finance.db is a hard link to a live database', linkedToLiveDb('hard link'), /finance\.db has 2 hard links/,
];
const WRITABLE_ANCESTOR: [string, Fixture, RegExp] = [
  'a directory above it is writable by others',
  (root) => {
    // Marked by hand: the seed itself refuses this directory.
    const shared = path.join(root, 'shared');
    const dataDir = path.join(shared, 'data');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dataDir, DISPOSABLE_MARKER), 'marked by this test', { mode: 0o600 });
    fs.chmodSync(shared, 0o777);
    return { dataDir };
  },
  /shared .*is writable by its group or by other users/,
];
/** Unsafe data directories any platform can make. */
const PORTABLE_UNSAFE_DATA_DIRS: [string, Fixture, RegExp][] = [
  HARD_LINKED_DB,
  ['finance.db-shm is a hard link', linkedToLiveDb('hard link', 'finance.db-shm'), /finance\.db-shm has 2 hard links/],
  ['an unexpected file sits next to the marker', (root) => {
    const dataDir = prepareDisposableDataDir(path.join(root, 'data'));
    fs.writeFileSync(path.join(dataDir, 'state.json'), '{"accounts":[]}');
    return { dataDir };
  }, /unexpected state\.json/],
  ['there is no marker, which the check never creates', (root) => {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    return { dataDir };
  }, /has no \.holdr-e2e-disposable marker/],
];
/** Unsafe data directories made with symlinks or chmod: macOS and Linux only (posixOnly). */
const POSIX_UNSAFE_DATA_DIRS: [string, Fixture, RegExp][] = [
  SYMLINKED_DB,
  ['finance.db-wal is a symlink', linkedToLiveDb('symlink', 'finance.db-wal'), /finance\.db-wal is a symbolic link/],
  ['the marker is a symlink', (root) => {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'elsewhere'), 'not a marker');
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(dataDir, DISPOSABLE_MARKER));
    return { dataDir };
  }, /\.holdr-e2e-disposable is a symbolic link/],
  WRITABLE_ANCESTOR,
];

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Start the real API (src/index.ts) the way the runner does, until it listens or exits. */
async function startApi(
  dataDir: string,
  runId: string | undefined,
  options: { preload?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOLDR_DATA_DIR: dataDir,
    PORT: String(port),
    HOLDR_HOST: '127.0.0.1',
    SNAPSHOTS_ENABLED: '0',
    ...options.env,
  };
  delete env.HOLDR_E2E_RUN_ID;
  if (runId !== undefined) env.HOLDR_E2E_RUN_ID = runId;
  // Never the production holdr.conf (PR B, design §7.1): disposable stacks say so, the others get a private HOME.
  if (env.HOLDR_E2E_RUN_ID) env.HOLDR_CONFIG = 'none';
  else env.HOME = path.dirname(dataDir);
  // As file URLs, as the runner passes them: --import reads C:\... as a URL with the scheme c:.
  const preloads = [PRELOAD, ...(options.preload ? [options.preload] : [])].flatMap((file) => ['--import', pathToFileURL(file).href]);
  const child = spawn(process.execPath, ['--import', 'tsx', ...preloads, 'src/index.ts'], {
    cwd: API_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const listening = new Promise<void>((resolve) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('[holdr-api] listening on')) resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
  const state = await Promise.race([listening.then(() => 'listening' as const), exited.then(() => 'exited' as const)]);
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    output: () => output,
    exitCode: () => exited,
    health: async () => (await fetch(`http://127.0.0.1:${port}/health`)).json() as Promise<Record<string, unknown>>,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
    },
  };
}

/** The browser's identity gate (apps/web/tests/stack-identity.ts) against `url`: ACCEPTED or REFUSED: <reason>. */
async function browserIdentityGate(url: string): Promise<string> {
  const script = [
    'const { verifyRunIdentity } = await import(process.env.VERIFIER);',
    "try { await verifyRunIdentity(process.env.VERIFY_URL, process.env.VERIFY_RUN_ID); console.log('ACCEPTED'); }",
    "catch (error) { console.log('REFUSED: ' + error.message); }",
  ].join('\n');
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: API_DIR,
    env: { ...process.env, VERIFIER: pathToFileURL(BROWSER_GATE).href, VERIFY_URL: url, VERIFY_RUN_ID: RUN_ID },
  });
  return stdout.trim();
}

/** The next time `dir`'s entries are read, put `replacement` in its place first. */
function replaceWhenEntriesAreRead(dir: string, replacement: string): void {
  const realReaddir = fs.readdirSync;
  vi.spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
    if (path.resolve(String(target)) === dir) {
      vi.mocked(fs.readdirSync).mockRestore();
      fs.renameSync(dir, `${dir}-checked`);
      fs.renameSync(replacement, dir);
    }
    return (realReaddir as (...args: unknown[]) => unknown)(target, ...rest);
  }) as never);
}

/** A marked data dir holding plain stand-ins for SQLite's files. */
function dirWithDatabaseFiles(dir: string): string {
  const made = prepareDisposableDataDir(dir);
  for (const name of ['finance.db', 'finance.db-wal', 'finance.db-shm']) fs.writeFileSync(path.join(made, name), name);
  return made;
}

describe('e2e run identity', () => {
  let root: string;
  let savedHome: { HOME?: string; USERPROFILE?: string };

  beforeEach(async () => {
    root = fs.realpathSync(await mkdtemp(path.join(tmpdir(), 'ft-e2e-identity-')));
    // The trusted root for the seed's ancestor checks: os.homedir() is HOME, or USERPROFILE on Windows.
    savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = root;
    process.env.USERPROFILE = root;
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedHome)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
    // Windows may hold a file of a just-stopped API for a moment.
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('accepts only 32 lowercase hex characters', async () => {
    const dir = prepareDisposableDataDir(path.join(root, 'data'));
    for (const runId of ['', 'abc', RUN_ID.toUpperCase(), RUN_ID.slice(1), `${RUN_ID}0`, `${RUN_ID.slice(1)}g`]) {
      expect(() => createRunIdentity(runId, dir), runId).toThrow(/32 lowercase hex characters/);
    }
    expect(await createRunIdentity(RUN_ID, dir).identity()).toEqual({ runId: RUN_ID, disposableDataDir: true });
  });

  posixOnly('refuses a data directory with a symlinked marker, or one others can write to', () => {
    const linkedMarker = path.join(root, 'linked-marker');
    fs.mkdirSync(linkedMarker, { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'elsewhere'), 'not a marker');
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(linkedMarker, DISPOSABLE_MARKER));
    expect(isDisposableDataDir(linkedMarker)).toBe(false);

    const open = prepareDisposableDataDir(path.join(root, 'open'));
    fs.chmodSync(open, 0o777);
    expect(isDisposableDataDir(open)).toBe(false);
  });

  it('refuses data directories the seed did not make, and reports a marker that disappears', async () => {
    const unmarked = path.join(root, 'unmarked');
    fs.mkdirSync(unmarked, { mode: 0o700 });
    expect(() => createRunIdentity(RUN_ID, unmarked)).toThrow(/not a disposable e2e data directory/);

    const live = path.join(root, 'checkout', 'apps', 'api', 'data');
    fs.mkdirSync(live, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(live, DISPOSABLE_MARKER), 'planted');
    expect(isDisposableDataDir(live)).toBe(false);

    const dir = prepareDisposableDataDir(path.join(root, 'data'));
    const checked = createRunIdentity(RUN_ID, dir);
    fs.rmSync(path.join(dir, DISPOSABLE_MARKER));
    expect(await checked.identity()).toEqual({ runId: RUN_ID, disposableDataDir: false });
  });

  const refusesUnsafeDataDir = (_case: string, fixture: Fixture, reason: RegExp) => {
    const { dataDir, live } = fixture(root);
    const before = snapshot(dataDir);
    const liveBytes = live ? fs.readFileSync(live) : null;
    expect(isDisposableDataDir(dataDir)).toBe(false);
    expect(() => createRunIdentity(RUN_ID, dataDir)).toThrow(reason);
    expect(snapshot(dataDir)).toEqual(before);
    if (live && liveBytes) {
      expect(fs.readFileSync(live).equals(liveBytes)).toBe(true);
      expect(fs.readdirSync(path.dirname(live))).toEqual(['finance.db']);
    }
  };
  it.each(PORTABLE_UNSAFE_DATA_DIRS)('refuses a data dir where %s, changing nothing', refusesUnsafeDataDir);
  posixOnly.each(POSIX_UNSAFE_DATA_DIRS)('refuses a data dir where %s, changing nothing', refusesUnsafeDataDir);

  posixOnly('accepts the directory the runner hands the API, and /health notices a file that turns into a link', async () => {
    const dir = prepareDisposableDataDir(path.join(root, 'data'));
    for (const name of ['finance.db', 'finance.db-wal', 'finance.db-shm']) fs.writeFileSync(path.join(dir, name), '');
    const checked = createRunIdentity(RUN_ID, dir);
    expect(await checked.identity()).toEqual({ runId: RUN_ID, disposableDataDir: true });
    fs.rmSync(path.join(dir, 'finance.db-shm'));
    fs.symlinkSync(path.join(dir, 'finance.db'), path.join(dir, 'finance.db-shm'));
    expect(await checked.identity()).toEqual({ runId: RUN_ID, disposableDataDir: false });
    expect(() => checked.assertUnchanged()).toThrow(/finance\.db-shm is a symbolic link/);
    expect(isDisposableDataDir(dir)).toBe(false);
  });

  // On Windows chmod leaves the ACL as it was: pathSafety.windows.test.ts changes ACLs on the same file or directory instead.
  posixOnly.each([
    ['the data directory', (dir: string) => dir],
    ['a directory above it', (dir: string) => path.dirname(dir)],
  ])('re-checks modes at every check: %s made writable by others after startup is refused', async (_, target) => {
    const dir = prepareDisposableDataDir(path.join(root, 'parent', 'data'));
    fs.writeFileSync(path.join(dir, 'finance.db'), '');
    const checked = createRunIdentity(RUN_ID, dir);
    checked.assertUnchanged();
    checked.recordOpened();
    expect(await checked.identity()).toEqual({ runId: RUN_ID, disposableDataDir: true });
    fs.chmodSync(target(dir), 0o777); // the same directory, so the same identity
    expect(() => checked.assertUnchanged()).toThrow(/writable by its group or by other users \(mode 777\)/);
    expect(await checked.identity()).toEqual({ runId: RUN_ID, disposableDataDir: false });
    fs.chmodSync(target(dir), 0o700);
    expect(await checked.identity()).toEqual({ runId: RUN_ID, disposableDataDir: true });
  });

  it('opens files only in the physical directory it checked, never through the symlinked path it was given', async () => {
    const physical = prepareDisposableDataDir(path.join(root, 'private', 'data'));
    fs.mkdirSync(path.join(root, 'shared'), { mode: 0o700 });
    const link = path.join(root, 'shared', 'link');
    fs.symlinkSync(path.join(root, 'private'), link, DIR_LINK);
    // Anyone may write where the link is (on Windows chmod leaves the ACL as it is; nothing below depends on it).
    fs.chmodSync(path.join(root, 'shared'), 0o777);

    const checked = createRunIdentity(RUN_ID, path.join(link, 'data'));
    expect(checked.dataDir).toBe(physical);
    expect(checked.dbFile).toBe(path.join(physical, 'finance.db'));
    expect(checked.jsonFile).toBe(path.join(physical, 'state.json'));
    // Retargeting the symlink afterwards changes nothing the API opens.
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(root, 'elsewhere'), link, DIR_LINK);
    expect(() => checked.assertUnchanged()).not.toThrow();
    expect((await checked.identity()).disposableDataDir).toBe(true);
  });

  it('refuses to open a checked directory that was replaced afterwards', () => {
    const dir = prepareDisposableDataDir(path.join(root, 'data'));
    const checked = createRunIdentity(RUN_ID, dir);
    fs.renameSync(dir, `${dir}-checked`);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.copyFileSync(path.join(`${dir}-checked`, DISPOSABLE_MARKER), path.join(dir, DISPOSABLE_MARKER));
    expect(() => checked.assertUnchanged()).toThrow(/no longer the data directory that passed the e2e check/);
  });

  describe('a directory replaced between the lstat and the entry inspection', () => {
    it('is refused by the startup check', () => {
      const dir = dirWithDatabaseFiles(path.join(root, 'data'));
      replaceWhenEntriesAreRead(dir, dirWithDatabaseFiles(path.join(root, 'replacement')));
      expect(() => createRunIdentity(RUN_ID, dir)).toThrow(/data changed while it was being checked\); refusing to start/);
    });

    it('fails the pre-open check and /health, before any file is pinned', async () => {
      const dir = dirWithDatabaseFiles(path.join(root, 'data'));
      const checked = createRunIdentity(RUN_ID, dir);
      replaceWhenEntriesAreRead(dir, dirWithDatabaseFiles(path.join(root, 'replacement-1')));
      expect(() => checked.assertUnchanged()).toThrow(/data was replaced while it was being checked/);
      // Put the checked directory back, then /health meets the same swap.
      fs.renameSync(dir, `${dir}-replacement-1`);
      fs.renameSync(`${dir}-checked`, dir);
      expect((await checked.identity()).disposableDataDir).toBe(true);
      replaceWhenEntriesAreRead(dir, dirWithDatabaseFiles(path.join(root, 'replacement-2')));
      expect(await checked.identity()).toEqual({ runId: RUN_ID, disposableDataDir: false });
    });

    it('fails /health once the opened files are pinned', async () => {
      const dir = dirWithDatabaseFiles(path.join(root, 'data'));
      const checked = createRunIdentity(RUN_ID, dir);
      checked.assertUnchanged();
      checked.recordOpened();
      expect((await checked.identity()).disposableDataDir).toBe(true);
      replaceWhenEntriesAreRead(dir, dirWithDatabaseFiles(path.join(root, 'replacement')));
      expect(await checked.identity()).toEqual({ runId: RUN_ID, disposableDataDir: false });
    });
  });

  describe('the database files the API opened', () => {
    it('/health fails once finance.db, -wal or -shm is a lookalike, even in the same directory', async () => {
      for (const name of ['finance.db', 'finance.db-wal', 'finance.db-shm']) {
        const dir = dirWithDatabaseFiles(path.join(root, `data-${name}`));
        const checked = createRunIdentity(RUN_ID, dir);
        checked.recordOpened();
        expect((await checked.identity()).disposableDataDir, name).toBe(true);
        // Moved out (SQLite would keep its handle on it) and replaced by a copy.
        fs.renameSync(path.join(dir, name), path.join(root, `opened-${name}`));
        fs.copyFileSync(path.join(root, `opened-${name}`), path.join(dir, name));
        expect((await checked.identity()).disposableDataDir, name).toBe(false);
        expect(() => checked.assertUnchanged(), name).toThrow(new RegExp(`${name.replace('.', '\\.')} is no longer the file the API opened`));
      }
    });

    it('/health fails for a swapped directory whose files are lookalikes', async () => {
      const dir = dirWithDatabaseFiles(path.join(root, 'data'));
      const checked = createRunIdentity(RUN_ID, dir);
      checked.recordOpened();
      fs.renameSync(dir, `${dir}-opened`);
      prepareDisposableDataDir(dir);
      for (const name of ['finance.db', 'finance.db-wal', 'finance.db-shm']) {
        fs.copyFileSync(path.join(`${dir}-opened`, name), path.join(dir, name));
      }
      expect(isDisposableDataDir(dir)).toBe(true);
      expect(await checked.identity()).toEqual({ runId: RUN_ID, disposableDataDir: false });
    });

    it('refuses a finance.db replaced between the pre-open check and the open', () => {
      const dir = dirWithDatabaseFiles(path.join(root, 'data'));
      const checked = createRunIdentity(RUN_ID, dir);
      checked.assertUnchanged();
      fs.renameSync(path.join(dir, 'finance.db'), path.join(root, 'checked-finance.db'));
      fs.copyFileSync(path.join(root, 'checked-finance.db'), path.join(dir, 'finance.db'));
      expect(() => checked.recordOpened()).toThrow(/finance\.db was replaced while the API was opening it/);
    });

    it('requires finance.db after the open', () => {
      const checked = createRunIdentity(RUN_ID, prepareDisposableDataDir(path.join(root, 'data')));
      expect(() => checked.recordOpened()).toThrow(/finance\.db is missing after the open/);
    });
  });

  describe('the API process', () => {
    it('a plain API (no HOLDR_E2E_RUN_ID) reports no run identity', async () => {
      const dir = path.join(root, 'production');
      fs.mkdirSync(dir, { mode: 0o700 });
      const api = await startApi(dir, undefined);
      try {
        expect(api.state, api.output()).toBe('listening');
        const health = await api.health();
        expect(health.ok).toBe(true);
        expect(health).not.toHaveProperty('e2e');
      } finally {
        await api.stop();
      }
    }, API_TIMEOUT_MS);

    it('an API started by the runner reports its run identity on a disposable data dir', async () => {
      const dir = prepareDisposableDataDir(path.join(root, 'disposable'));
      const api = await startApi(dir, RUN_ID);
      try {
        expect(api.state, api.output()).toBe('listening');
        expect((await api.health()).e2e).toEqual({ runId: RUN_ID, disposableDataDir: true });
      } finally {
        await api.stop();
      }
    }, API_TIMEOUT_MS);

    it('refuses to start with a run identity on a data dir that is not disposable, before opening it', async () => {
      const dir = path.join(root, 'production');
      fs.mkdirSync(dir, { mode: 0o700 });
      const api = await startApi(dir, RUN_ID);
      expect(api.state).toBe('exited');
      expect(await api.exitCode()).toBe(1);
      expect(api.output()).toMatch(/is not a disposable e2e data directory .*refusing to start/);
      expect(fs.readdirSync(dir)).toEqual([]);

      const marked = prepareDisposableDataDir(path.join(root, 'marked'));
      const malformed = await startApi(marked, 'not-a-run-id');
      expect(await malformed.exitCode()).toBe(1);
      expect(malformed.output()).toMatch(/32 lowercase hex characters/);
      expect(fs.readdirSync(marked)).toEqual([DISPOSABLE_MARKER]);
    }, API_TIMEOUT_MS);

    it('keeps to the checked directory when a symlink on the way is retargeted between the check and the open', async () => {
      const physical = prepareDisposableDataDir(path.join(root, 'private', 'data'));
      const live = makeMockLiveDb(path.join(root, 'live', 'data'));
      const liveBytes = fs.readFileSync(live);
      // HOLDR_DATA_DIR goes through a symlink in a directory anyone can write to
      // (on Windows chmod leaves the ACL as it is; nothing below depends on it).
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared, { mode: 0o700 });
      const link = path.join(shared, 'link');
      fs.symlinkSync(path.join(root, 'private'), link, DIR_LINK);
      fs.chmodSync(shared, 0o777);

      const api = await startApi(path.join(link, 'data'), RUN_ID, {
        preload: RETARGET_AFTER_CHECK,
        env: { E2E_TEST_RETARGET_LINK: link, E2E_TEST_RETARGET_TO: path.join(root, 'live') },
      });
      let health: Record<string, unknown> | undefined;
      try {
        if (api.state === 'listening') health = await api.health();
      } finally {
        await api.stop();
      }
      expect(api.output()).toContain(`[test] retargeted ${link} -> ${path.join(root, 'live')} after the check`);
      // Byte-identical, and SQLite never opened it: no -wal or -shm beside it.
      expect(fs.readFileSync(live).equals(liveBytes), 'the mock live database was modified').toBe(true);
      expect(fs.readdirSync(path.dirname(live))).toEqual(['finance.db']);
      // The API opened, and /health vouches for, the directory it checked.
      expect(api.state, api.output()).toBe('listening');
      expect(health?.e2e).toEqual({ runId: RUN_ID, disposableDataDir: true });
      expect(fs.readdirSync(physical)).toContain('finance.db');
      expect(api.output()).toContain(`opening only the checked data dir ${physical}`);
    }, API_TIMEOUT_MS);

    // Renames the data directory or finance.db while the API holds the database open: Windows refuses that.
    posixOnly.each([
      ['another marked dir replaces the data dir', (dir: string) => {
        fs.renameSync(dir, `${dir}-opened`);
        prepareDisposableDataDir(dir);
      }],
      ['another marked dir holding lookalike database files replaces the data dir', (dir: string) => {
        fs.renameSync(dir, `${dir}-opened`);
        prepareDisposableDataDir(dir);
        for (const name of ['finance.db', 'finance.db-wal', 'finance.db-shm']) {
          const opened = path.join(`${dir}-opened`, name);
          if (fs.existsSync(opened)) fs.copyFileSync(opened, path.join(dir, name));
        }
      }],
      ['a lookalike finance.db replaces the one the API opened, in the same dir', (dir: string) => {
        fs.renameSync(path.join(dir, 'finance.db'), path.join(path.dirname(dir), 'opened-finance.db'));
        fs.copyFileSync(path.join(path.dirname(dir), 'opened-finance.db'), path.join(dir, 'finance.db'));
      }],
    ] as const)('after startup, /health stops vouching and the browser gate refuses when %s', async (_case, replace) => {
      const dir = prepareDisposableDataDir(path.join(root, 'data'));
      const api = await startApi(dir, RUN_ID);
      try {
        expect(api.state, api.output()).toBe('listening');
        expect((await api.health()).e2e).toEqual({ runId: RUN_ID, disposableDataDir: true });
        expect(await browserIdentityGate(api.url)).toBe('ACCEPTED');
        replace(dir);
        expect((await api.health()).e2e).toEqual({ runId: RUN_ID, disposableDataDir: false });
        expect(await browserIdentityGate(api.url)).toMatch(/^REFUSED: .*does not report a disposable data directory/);
      } finally {
        await api.stop();
      }
    }, API_TIMEOUT_MS);

    const refusesToStart = async (_case: string, fixture: Fixture, reason: RegExp) => {
      const { dataDir, live } = fixture(root);
      const before = snapshot(dataDir);
      const liveBytes = live ? fs.readFileSync(live) : null;
      const api = await startApi(dataDir, RUN_ID);
      try {
        expect(api.state, api.output()).toBe('exited');
        expect(await api.exitCode()).toBe(1);
        expect(api.output()).toMatch(reason);
        expect(api.output()).toMatch(/is not a disposable e2e data directory .*refusing to start/);
      } finally {
        await api.stop();
      }
      expect(snapshot(dataDir)).toEqual(before);
      if (live && liveBytes) {
        // Byte-identical, and SQLite never opened it: no -wal or -shm beside it.
        expect(fs.readFileSync(live).equals(liveBytes)).toBe(true);
        expect(fs.readdirSync(path.dirname(live))).toEqual(['finance.db']);
      }
    };
    it.each([HARD_LINKED_DB])('refuses to start when %s, before migrating or opening anything', refusesToStart, API_TIMEOUT_MS);
    posixOnly.each([SYMLINKED_DB, WRITABLE_ANCESTOR])('refuses to start when %s, before migrating or opening anything', refusesToStart, API_TIMEOUT_MS);
  });
});
