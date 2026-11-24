import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { runHoldrUserCli, USAGE, type CliStdin } from './holdrUser.js';
import { DISPOSABLE_MARKER, prepareDisposableDataDir, seedDisposableDataDir } from '../e2e/syntheticSeed.js';
import { verifyPassword } from '../auth/password.js';
import { LocalAuthRepo } from '../services/localAuthRepo.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';

const FAST = { ln: 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = await makeScratchDir('cli-');
  dataDir = path.join(root, 'data');
});

afterEach(async () => {
  await removeScratchDir(root);
});

interface Session {
  stdin: PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  rawModes: boolean[];
  stdout: () => string;
  stderr: () => string;
  done: Promise<number>;
}

function sink(): { stream: Writable; text: () => string } {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  return { stream, text: () => text };
}

function run(argv: string[], options: { tty?: boolean; input?: string; env?: Record<string, string> } = {}): Session {
  const stdin = new PassThrough() as Session['stdin'];
  const rawModes: boolean[] = [];
  if (options.tty) {
    stdin.isTTY = true;
    stdin.setRawMode = (mode: boolean) => {
      rawModes.push(mode);
    };
  }
  if (options.input !== undefined) stdin.end(options.input);
  const stdout = sink();
  const stderr = sink();
  const done = runHoldrUserCli(argv, {
    io: { stdin: stdin as CliStdin, stdout: stdout.stream, stderr: stderr.stream },
    env: options.env ?? {},
    cwd: root,
    defaultDataDir: dataDir,
    scryptParams: FAST,
  });
  return { stdin, rawModes, stdout: stdout.text, stderr: stderr.text, done };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error('timed out waiting for the CLI');
}

function withUsers<T>(work: (users: LocalAuthRepo) => T, dir = dataDir): T {
  const repo = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
  try {
    return work(new LocalAuthRepo(repo));
  } finally {
    repo.close();
  }
}

async function addUser(username: string, password = PASSWORD): Promise<void> {
  const session = run(['add', username, '--password-stdin'], { input: `${password}\n` });
  expect(await session.done, session.stderr()).toBe(0);
}

describe('holdr-user add', () => {
  it('creates a user from --password-stdin without printing the password', async () => {
    const session = run(['add', 'Alex', '--password-stdin'], { input: `${PASSWORD}\n` });
    expect(await session.done).toBe(0);
    expect(session.stdout()).toBe('Created user alex. Sign in at the Holdr web page.\n');
    expect(session.stderr()).toContain(path.join(dataDir, 'finance.db'));
    expect(session.stdout() + session.stderr()).not.toContain(PASSWORD);
    const stored = withUsers((users) => users.findUser('alex'))!;
    expect(stored.passwordHash.startsWith('$scrypt$ln=10,r=8,p=1$')).toBe(true);
    expect(await verifyPassword(PASSWORD, stored.passwordHash)).toBe(true);
  });

  it('accepts CRLF input but refuses multi-line or empty passwords', async () => {
    expect(await run(['add', 'alex', '--password-stdin'], { input: `${PASSWORD}\r\n` }).done).toBe(0);
    expect(await verifyPassword(PASSWORD, withUsers((users) => users.findUser('alex'))!.passwordHash)).toBe(true);
    const multi = run(['add', 'casey', '--password-stdin'], { input: `${PASSWORD}\nsecond line\n` });
    expect(await multi.done).toBe(1);
    expect(multi.stderr()).toContain('single line');
    const empty = run(['add', 'casey', '--password-stdin'], { input: '\n' });
    expect(await empty.done).toBe(1);
    expect(withUsers((users) => users.countUsers())).toBe(1);
  });

  it('prompts twice without echo on a terminal and supports backspace and arrow keys', async () => {
    const session = run(['add', 'casey'], { tty: true });
    await until(() => session.stderr().includes('New password for casey: '));
    session.stdin.write('correct horse batteryX\u007f');
    session.stdin.write('\u001b[D\r');
    await until(() => session.stderr().includes('Repeat the password: '));
    session.stdin.write(`${PASSWORD}\r`);
    expect(await session.done, session.stderr()).toBe(0);
    expect(session.stdout() + session.stderr()).not.toContain('correct horse');
    expect(session.rawModes).toEqual([true, false, true, false]);
    expect(await verifyPassword(PASSWORD, withUsers((users) => users.findUser('casey'))!.passwordHash)).toBe(true);
  });

  it('refuses mismatched passwords and Ctrl-C', async () => {
    const mismatch = run(['add', 'casey'], { tty: true });
    await until(() => mismatch.stderr().includes('New password'));
    mismatch.stdin.write(`${PASSWORD}\r`);
    await until(() => mismatch.stderr().includes('Repeat'));
    mismatch.stdin.write('something else entirely\r');
    expect(await mismatch.done).toBe(1);
    expect(mismatch.stderr()).toContain('passwords do not match');

    const cancelled = run(['add', 'casey'], { tty: true });
    await until(() => cancelled.stderr().includes('New password'));
    cancelled.stdin.write('half typed\u0003');
    expect(await cancelled.done).toBe(1);
    expect(cancelled.stderr()).toContain('cancelled');
    expect(withUsers((users) => users.countUsers())).toBe(0);
  });

  it('requires --password-stdin when standard input is not a terminal', async () => {
    const session = run(['add', 'alex'], { input: `${PASSWORD}\n` });
    expect(await session.done).toBe(1);
    expect(session.stderr()).toContain('--password-stdin');
    expect(session.stderr()).toContain('npm.cmd');
  });

  it('enforces the password policy and username rules', async () => {
    const short = run(['add', 'alex', '--password-stdin'], { input: 'short\n' });
    expect(await short.done).toBe(1);
    expect(short.stderr()).toContain('at least 8 characters');
    const sameAsName = run(['add', 'alex1234', '--password-stdin'], { input: 'alex1234\n' });
    expect(await sameAsName.done).toBe(1);
    const badName = run(['add', 'alex sample', '--password-stdin'], { input: `${PASSWORD}\n` });
    expect(await badName.done).toBe(1);
    expect(badName.stderr()).toContain('username must be');
  });

  it('refuses a duplicate before asking for a password', async () => {
    await addUser('alex');
    const again = run(['add', 'ALEX'], { tty: true });
    expect(await again.done).toBe(1);
    expect(again.stderr()).toContain('already exists; use: npm run holdr-user -- passwd alex');
    expect(again.stderr()).not.toContain('New password');
  });
});

describe('holdr-user passwd, list, remove', () => {
  it('passwd replaces the hash and signs the user out everywhere', async () => {
    await addUser('alex');
    await addUser('casey');
    const tokens = withUsers((users) => {
      const alex = users.findUser('alex')!;
      const casey = users.findUser('casey')!;
      return [users.createSession(alex.id, 60_000).token, users.createSession(alex.id, 60_000).token,
        users.createSession(casey.id, 60_000).token];
    });
    const session = run(['passwd', 'alex', '--password-stdin'], { input: 'a whole new password\n' });
    expect(await session.done).toBe(0);
    expect(session.stdout()).toBe('Password updated for alex; signed out 2 session(s).\n');
    withUsers((users) => {
      expect(users.findSession(tokens[0])).toBeNull();
      expect(users.findSession(tokens[2])?.username).toBe('casey');
    });
    const hash = withUsers((users) => users.findUser('alex')!.passwordHash);
    expect(await verifyPassword('a whole new password', hash)).toBe(true);
    expect(await verifyPassword(PASSWORD, hash)).toBe(false);
  });

  it('passwd and remove refuse unknown users', async () => {
    await addUser('alex');
    const passwd = run(['passwd', 'ghost', '--password-stdin'], { input: `${PASSWORD}\n` });
    expect(await passwd.done).toBe(1);
    expect(passwd.stderr()).toContain('no user "ghost"');
    const remove = run(['remove', 'ghost', '--yes']);
    expect(await remove.done).toBe(1);
  });

  it('list shows users and active sessions but no hashes', async () => {
    const empty = run(['list']);
    expect(await empty.done).toBe(1);
    expect(empty.stderr()).toContain('no Holdr database');
    await addUser('casey');
    await addUser('alex');
    withUsers((users) => users.createSession(users.findUser('alex')!.id, 60_000));
    const session = run(['list']);
    expect(await session.done).toBe(0);
    const lines = session.stdout().trim().split('\n');
    expect(lines[0]).toMatch(/^USERNAME\s+CREATED\s+ACTIVE SESSIONS$/);
    expect(lines[1]).toMatch(/^alex\s+\d{4}-\d\d-\d\dT[\d:.]+Z\s+1$/);
    expect(lines[2]).toMatch(/^casey\s+.*\s0$/);
    expect(session.stdout()).not.toContain('$scrypt$');
  });

  it('remove needs --yes or a typed confirmation and ends the sessions', async () => {
    await addUser('alex');
    await addUser('casey');
    const token = withUsers((users) => users.createSession(users.findUser('casey')!.id, 60_000).token);

    const piped = run(['remove', 'casey'], { input: 'casey\n' });
    expect(await piped.done).toBe(1);
    expect(piped.stderr()).toContain('pass --yes');

    const wrong = run(['remove', 'casey'], { tty: true });
    await until(() => wrong.stderr().includes('Type the username to confirm'));
    wrong.stdin.end('alex\n');
    expect(await wrong.done).toBe(1);
    expect(withUsers((users) => users.countUsers())).toBe(2);

    const confirmed = run(['remove', 'casey'], { tty: true });
    await until(() => confirmed.stderr().includes('Type the username to confirm'));
    confirmed.stdin.end('casey\n');
    expect(await confirmed.done).toBe(0);
    expect(withUsers((users) => users.findSession(token))).toBeNull();

    const last = run(['remove', 'alex', '--yes']);
    expect(await last.done).toBe(0);
    expect(last.stderr()).toContain('No users remain');
  });
});

describe('holdr-user arguments', () => {
  it('prints usage', async () => {
    const help = run(['--help']);
    expect(await help.done).toBe(0);
    expect(help.stdout()).toBe(USAGE);
    expect(await run([]).done).toBe(2);
    expect(await run(['frobnicate']).done).toBe(2);
    expect(await run(['add']).done).toBe(2);
    expect(await run(['list', 'extra']).done).toBe(2);
    expect(await run(['list', '--force']).done).toBe(2);
  });

  it('honors --data-dir over HOLDR_DATA_DIR over the default', async () => {
    const viaEnv = run(['add', 'envuser', '--password-stdin'], { input: `${PASSWORD}\n`, env: { HOLDR_DATA_DIR: 'from-env' } });
    expect(await viaEnv.done).toBe(0);
    expect(existsSync(path.join(root, 'from-env', 'finance.db'))).toBe(true);
    const viaFlag = run(['add', 'flaguser', '--password-stdin', '--data-dir', 'from-flag'], {
      input: `${PASSWORD}\n`,
      env: { HOLDR_DATA_DIR: 'from-env' },
    });
    expect(await viaFlag.done).toBe(0);
    expect(withUsers((users) => users.findUser('flaguser'), path.join(root, 'from-flag'))).not.toBeNull();
    expect(existsSync(path.join(dataDir, 'finance.db'))).toBe(false);
  });

  it('refuses a data folder in the demo\'s folder, which npm run demo deletes when it makes the demo again', async () => {
    const demo = path.join(root, 'holdr-demo');
    mkdirSync(path.join(demo, 'data'), { recursive: true });
    writeFileSync(path.join(demo, '.holdr-demo'), 'Holdr demo data (synthetic). Safe to delete.\nseeded 2026-03-18\n');
    for (const env of [{ HOLDR_DATA_DIR: path.join(demo, 'data') }, { HOLDR_DATA_DIR: demo }]) {
      const session = run(['add', 'alex', '--password-stdin'], { input: `${PASSWORD}\n`, env });
      expect(await session.done).toBe(1);
      expect(session.stderr()).toContain("is in the demo's folder");
    }
    const viaFlag = run(['passwd', 'demo', '--password-stdin', '--data-dir', path.join(demo, 'data', 'nested')], { input: `${PASSWORD}\n` });
    expect(await viaFlag.done).toBe(1);
    expect(viaFlag.stderr()).toContain('npm run demo deletes that folder');
    expect(readdirSync(path.join(demo, 'data'))).toEqual([]);
  });
});

describe('holdr-user on a disposable e2e stack (HOLDR_E2E_RUN_ID)', () => {
  const RUN_ID = '0123456789abcdef0123456789abcdef';
  /** Directory links: junctions on Windows, which any user may create there; symlinks elsewhere. */
  const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';

  // The disposable-directory check walks every directory up to the home
  // directory or the repo, and each must be private. A checkout under C:\
  // usually lets Authenticated Users write, so on Windows these tests use a
  // root in the per-user temp folder instead and make it the home directory.
  let savedHome: { HOME?: string; USERPROFILE?: string } | null = null;
  beforeEach(async () => {
    if (process.platform !== 'win32') return;
    savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    await removeScratchDir(root);
    root = realpathSync(await mkdtemp(path.join(tmpdir(), 'ft-cli-e2e-')));
    dataDir = path.join(root, 'data');
    process.env.HOME = root;
    process.env.USERPROFILE = root;
  });
  afterEach(async () => {
    if (!savedHome) return;
    for (const [name, value] of Object.entries(savedHome)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedHome = null;
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('adds the user in the checked disposable directory, next to the seeded data', async () => {
    const disposable = seedDisposableDataDir(path.join(root, 'e2e', 'data')).dataDir;
    const session = run(['add', 'e2e', '--password-stdin'], {
      input: `${PASSWORD}\n`,
      env: { HOLDR_DATA_DIR: disposable, HOLDR_E2E_RUN_ID: RUN_ID },
    });
    expect(await session.done, session.stderr()).toBe(0);
    expect(session.stderr()).toContain('(checked e2e data dir)');
    expect(withUsers((users) => users.findUser('e2e'), disposable)).not.toBeNull();
    // Nothing but SQLite's own files next to the marker: the API's check still passes.
    expect(readdirSync(disposable).every((entry) => entry === DISPOSABLE_MARKER || entry.startsWith('finance.db'))).toBe(true);
  });

  it('refuses a directory that may hold real data, and writes nothing', async () => {
    const unmarked = path.join(root, 'unmarked');
    mkdirSync(unmarked);
    writeFileSync(path.join(unmarked, 'finance.db'), '');
    const live = path.join(root, 'apps', 'api', 'data');
    mkdirSync(live, { recursive: true });
    const marked = prepareDisposableDataDir(path.join(root, 'real', 'data'));
    const linkedDataDir = path.join(root, 'link-to-data');
    symlinkSync(marked, linkedDataDir, DIR_LINK);
    for (const target of [unmarked, live, path.join(root, 'missing'), linkedDataDir]) {
      const session = run(['add', 'e2e', '--password-stdin'], {
        input: `${PASSWORD}\n`,
        env: { HOLDR_DATA_DIR: target, HOLDR_E2E_RUN_ID: RUN_ID },
      });
      expect(await session.done, target).toBe(1);
      expect(session.stderr(), target).toMatch(/is not a disposable e2e data directory .*refusing to start/);
    }
    expect(readdirSync(unmarked)).toEqual(['finance.db']);
    expect(readdirSync(live)).toEqual([]);
    expect(existsSync(path.join(root, 'missing'))).toBe(false);
    // A symlink above the data directory is resolved: the user lands in the physical directory that was checked.
    symlinkSync(path.join(root, 'real'), path.join(root, 'link-to-parent'), DIR_LINK);
    const linked = run(['add', 'e2e', '--password-stdin'], {
      input: `${PASSWORD}\n`,
      env: { HOLDR_DATA_DIR: path.join(root, 'link-to-parent', 'data'), HOLDR_E2E_RUN_ID: RUN_ID },
    });
    expect(await linked.done, linked.stderr()).toBe(0);
    expect(linked.stderr()).toContain(path.join(marked, 'finance.db'));
    expect(withUsers((users) => users.findUser('e2e'), marked)).not.toBeNull();
  });

  it('refuses a malformed run identity', async () => {
    const disposable = prepareDisposableDataDir(path.join(root, 'e2e-data'));
    const session = run(['add', 'e2e', '--password-stdin'], {
      input: `${PASSWORD}\n`,
      env: { HOLDR_DATA_DIR: disposable, HOLDR_E2E_RUN_ID: 'not-a-run-id' },
    });
    expect(await session.done).toBe(1);
    expect(session.stderr()).toMatch(/32 lowercase hex characters/);
    expect(readdirSync(disposable)).toEqual([DISPOSABLE_MARKER]);
  });
});
