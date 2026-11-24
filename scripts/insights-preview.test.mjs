// scripts/insights-preview.mts, run for real (through tsx) on a synthetic database: what it prints, what it refuses, and
// the file --values writes. Synthetic data only: made-up merchants, so any of their names in the output is a leak.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'insights-preview.mts');
const Database = createRequire(path.join(repo, 'apps', 'api', 'package.json'))('better-sqlite3');
const TODAY = '2026-10-16';
/** Anything of the synthetic data's values in what is printed: a merchant's words or an amount. */
const VALUES = /\b(?:synthetic|zebra|wombat|quokka|koala|emu)\b|\$|\d,\d{3}|\d\.\d{2}\b/i;

function syntheticDatabase(dir) {
  const file = path.join(dir, 'finance.db');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE card_accounts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, currency TEXT NOT NULL);
    CREATE TABLE card_transactions (
      id TEXT PRIMARY KEY, card_account_id TEXT NOT NULL, transaction_date TEXT NOT NULL, status TEXT NOT NULL,
      amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, original_currency TEXT, kind TEXT NOT NULL,
      description TEXT NOT NULL, merchant TEXT, issuer_category TEXT, user_category TEXT);`);
  db.prepare('INSERT INTO card_accounts VALUES (?, ?, ?)').run('card-a', 'alex', 'USD');
  db.prepare('INSERT INTO card_accounts VALUES (?, ?, ?)').run('card-b', 'casey', 'USD');
  const rows = [
    // A subscription that went up this month, a fare billed twice, a large one-off, groceries on irregular days, a fee.
    ...['2026-06-07', '2026-07-07', '2026-08-07', '2026-09-07'].map((date) => [date, 1549, 'SYNTHETIC ZEBRA STREAMING']),
    ['2026-10-07', 1799, 'SYNTHETIC ZEBRA STREAMING'],
    ['2026-10-08', 4500, 'SYNTHETIC WOMBAT CAFE'],
    ['2026-10-09', 4500, 'SYNTHETIC WOMBAT CAFE'],
    ['2026-10-03', 450000, 'SYNTHETIC QUOKKA ELECTRONICS'],
    ...['2026-07-03', '2026-08-19', '2026-09-09', '2026-10-02'].map((date) => [date, 12000, 'SYNTHETIC KOALA GROCER']),
    ['2026-10-01', 9500, 'SYNTHETIC ANNUAL FEE', 'fee'],
    ['2026-10-05', 2500, 'SYNTHETIC EMU BAKERY', 'purchase', 'card-b'],
  ];
  const insert = db.prepare(`INSERT INTO card_transactions VALUES (?, ?, ?, 'posted', ?, 'USD', NULL, ?, ?, NULL, NULL, NULL)`);
  rows.forEach(([date, amount, description, kind = 'purchase', card = 'card-a'], index) => insert.run(`row-${index}`, card, date, amount, kind, description));
  db.close();
  return file;
}

function preview(args) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { cwd: repo, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const made = [];
process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insights-preview-'));
  made.push(dir);
  return dir;
};

/** The file is readable by the current user alone: mode 0600, or on Windows one ACL entry and nothing inherited. */
function assertOwnerOnly(file) {
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    return;
  }
  const listing = execFileSync(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [file], { encoding: 'utf8', windowsHide: true })
    .replace(file, '');
  assert.equal((listing.match(/:\(/g) ?? []).length, 1, listing);
  assert.doesNotMatch(listing, /\(I\)/, listing);
}

test('prints counts and kinds only, and never writes the database', { timeout: 300_000 }, () => {
  const dir = scratch();
  const db = syntheticDatabase(dir);
  const before = digest(db);
  for (const args of [[db, '--today', TODAY], [db, '--today', TODAY, '--owner', 'casey', '--counts-only']]) {
    const run = preview(args);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout + run.stderr, VALUES);
    assert.equal(run.stdout.match(/^== /gm)?.length, 6);
    assert.equal(run.stdout.match(/^ {3}findings: /gm)?.length, 6);
  }
  const all = preview([db, '--today', TODAY]).stdout;
  assert.match(all, /^14 pending and posted rows on all cards; USD; today 2026-10-16$/m);
  assert.match(all, /^ {3}first 6: pace, duplicates, large, /m);
  assert.deepEqual(fs.readdirSync(dir), ['finance.db']);
  assert.equal(digest(db), before);
});

test('--values needs --out, --out needs --values, and --out must be outside the repository', { timeout: 300_000 }, () => {
  const dir = scratch();
  const db = syntheticDatabase(dir);
  const inside = path.join(repo, 'apps', 'insights-values.json');
  const refusals = [
    [[db, '--values'], /--values needs --out/],
    [[db, '--out', path.join(dir, 'values.json')], /--out is only for --values/],
    [[db, '--values', '--out', inside], /outside this repository/],
    [[db, '--values', '--out', path.join(dir, 'missing', 'values.json')], /directory that exists/],
    [[db, '--values', '--out', db], /must not be the database/],
    [[db, '--values', '--out', dir], /must name a file/],
    [[db, '--values', '--counts-only', '--out', path.join(dir, 'values.json')], /exclude each other/],
  ];
  for (const [args, message] of refusals) {
    const run = preview(args);
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stderr}`);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, message);
    assert.doesNotMatch(run.stderr, VALUES);
  }
  assert.equal(fs.existsSync(inside), false);
  assert.deepEqual(fs.readdirSync(dir), ['finance.db']);
});

test('refuses unknown options and bad values before reading anything', { timeout: 300_000 }, () => {
  const dir = scratch();
  const db = syntheticDatabase(dir);
  for (const args of [
    [db, '--bogus'], [db, '--today', '2026-02-30'], [db, '--owner', 'nobody'], [db, '--top', 'x'], [db, '--top'],
    [db, db], [db, '--today', TODAY, '--today', TODAY], [],
  ]) {
    const run = preview(args);
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stdout}`);
    assert.equal(run.stdout, '');
  }
});

test('--values writes the cards to a file the current user alone can read, printing counts only', { timeout: 300_000 }, () => {
  const dir = scratch();
  const db = syntheticDatabase(dir);
  // A directory whose name looks like a value: no path is ever printed, so nothing of it may show.
  const folder = path.join(dir, 'zebra 4,500.00');
  fs.mkdirSync(folder);
  const out = path.join(folder, 'values.json');
  for (let round = 0; round < 2; round += 1) {
    const run = preview([db, '--today', TODAY, '--top', '3', '--values', '--out', out]);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, VALUES);
    assert.doesNotMatch(run.stderr, VALUES);
    assert.match(run.stdout, /in the file given with --out, readable by you alone\. Never share that file, and delete it when done\.$/m);
    assertOwnerOnly(out);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(report.periods.length, 6);
    const month = report.periods[0];
    assert.deepEqual(month.topCards.map((card) => card.kind), ['pace', 'duplicates', 'large']);
    assert.match(month.topCards[1].title, /Synthetic Wombat Cafe/);
    assert.match(JSON.stringify(month.topCards[2]), /\$4,500\.00/);
    // Replaced whole on the second round: nothing else is left beside it.
    assert.deepEqual(fs.readdirSync(folder), ['values.json']);
  }
});

test('a write that fails reports a code only, and leaves the file as it was', { timeout: 300_000 }, () => {
  const dir = scratch();
  const db = syntheticDatabase(dir);
  const folder = path.join(dir, 'quokka 12,345.67');
  fs.mkdirSync(folder);
  const out = path.join(folder, 'values.json');
  if (process.platform === 'win32') {
    // Windows will not rename over a read-only file.
    fs.writeFileSync(out, 'old');
    fs.chmodSync(out, 0o444);
  } else {
    fs.chmodSync(folder, 0o500);
  }
  try {
    const run = preview([db, '--today', TODAY, '--values', '--out', out]);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /^insights-preview: could not write --out; nothing was written \(E[A-Z]+\)$/m);
    assert.doesNotMatch(run.stdout, VALUES);
    assert.doesNotMatch(run.stderr, VALUES);
    assert.deepEqual(fs.readdirSync(folder), process.platform === 'win32' ? ['values.json'] : []);
    if (process.platform === 'win32') assert.equal(fs.readFileSync(out, 'utf8'), 'old');
  } finally {
    if (process.platform === 'win32') fs.chmodSync(out, 0o644);
    else fs.chmodSync(folder, 0o700);
  }
});

test('--out never names the database, whatever name either goes by', { timeout: 300_000 }, () => {
  const dir = scratch();
  const db = syntheticDatabase(dir);
  const before = digest(db);
  const aliases = [path.join(dir, 'other-name.db')];
  fs.linkSync(db, aliases[0]);
  // On a file system that ignores case, the same name in capitals is the database too.
  if (fs.existsSync(path.join(dir, 'FINANCE.DB'))) aliases.push(path.join(dir, 'FINANCE.DB'));
  const cases = [
    ...aliases.map((alias) => [db, alias]),
    // better-sqlite3 trims the name it is given: the database is checked under the name it is opened by, or refused.
    [` ${db}`, db], [`${db} `, db], [`${db}\n`, db], [`file:${db}`, db],
  ];
  for (const [database, out] of cases) {
    const run = preview([database, '--values', '--out', out]);
    assert.equal(run.status, 2, `${JSON.stringify(database)} → ${JSON.stringify(out)}: ${run.stderr}`);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^insights-preview: (?:--out must not be the database|the database must be a file that exists)$/m);
  }
  assert.equal(digest(db), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['finance.db', 'other-name.db']);
});

test('--out must be in a directory that only the current user can change', { timeout: 300_000 }, () => {
  const dir = scratch();
  const db = syntheticDatabase(dir);
  const shared = path.join(dir, 'shared');
  fs.mkdirSync(shared);
  if (process.platform === 'win32') {
    // BUILTIN\Users may change it, and everything made in it.
    execFileSync(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [shared, '/grant', '*S-1-5-32-545:(OI)(CI)M'], { stdio: 'ignore', windowsHide: true });
  } else {
    fs.chmodSync(shared, 0o777);
  }
  const run = preview([db, '--values', '--out', path.join(shared, 'values.json')]);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /only you can change/);
  assert.deepEqual(fs.readdirSync(shared), []);
});

test('macOS: the folder checks print nothing of a listing that fails', { skip: process.platform !== 'darwin' && 'macOS ACL listings', timeout: 120_000 }, () => {
  // `ls` names the file it could not list; that must stay in the error thrown, which the preview never prints.
  const missing = path.join(scratch(), 'zebra 4,500.00');
  const pathSafety = pathToFileURL(path.join(repo, 'apps', 'api', 'src', 'e2e', 'pathSafety.ts')).href;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { aclWriteGrants } from ${JSON.stringify(pathSafety)};
    try { aclWriteGrants(process.argv[1]); } catch { process.exitCode = 7; }`, missing], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 7, run.stderr);
  assert.equal(run.stderr, '');
});
