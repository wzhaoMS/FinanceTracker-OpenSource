import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OwnerOnlyRefusal, writeOwnerOnlyFile } from './owner-only-file.mjs';

const USER = 'S-1-5-21-1000-2000-3000-1001';
const USERS = 'S-1-5-32-545';
const TEXT = '{"synthetic": "values"}\n';
const made = [];

process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-only-'));
  made.push(dir);
  return { dir, target: path.join(dir, 'values.json') };
}

/** Windows ACL helpers that record what they saw (paths relative to `dir`), and answer with `acl`. */
function fakeWindows(dir, acl, seen = []) {
  const where = (file) => path.relative(dir, file).split(path.sep);
  return {
    seen,
    currentUserSid: () => USER,
    restrictDirectory: (privateDirectory, sid) => seen.push(['directory', where(privateDirectory), fs.readdirSync(privateDirectory).length, sid]),
    restrictToUser: (file, sid) => seen.push(['file', where(file), fs.readFileSync(file, 'utf8'), sid]),
    readAcl: (file) => {
      seen.push(['read', where(file), fs.readFileSync(file, 'utf8')]);
      return acl;
    },
  };
}

test('POSIX: writes mode 0600, replacing a looser file whole', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const { dir, target } = scratch();
  fs.writeFileSync(target, 'old');
  fs.chmodSync(target, 0o644);
  const before = fs.statSync(target).ino;
  writeOwnerOnlyFile(target, TEXT);
  assert.equal(fs.readFileSync(target, 'utf8'), TEXT);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  // Replaced, never written through: another link to the old file keeps the old text.
  assert.notEqual(fs.statSync(target).ino, before);
  assert.deepEqual(fs.readdirSync(dir), ['values.json']);
});

test('POSIX: a target that is a symlink is replaced, never followed', { skip: process.platform === 'win32' && 'POSIX symlinks' }, () => {
  const { dir, target } = scratch();
  const elsewhere = path.join(dir, 'elsewhere.txt');
  fs.writeFileSync(elsewhere, 'untouched');
  fs.symlinkSync(elsewhere, target);
  writeOwnerOnlyFile(target, TEXT);
  assert.equal(fs.lstatSync(target).isFile(), true);
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'untouched');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['elsewhere.txt', 'values.json']);
});

test('Windows: makes the file inside a directory restricted first, restricts the file and reads its ACL back before a byte is written, then renames it over the target', () => {
  const { dir, target } = scratch();
  fs.writeFileSync(target, 'old');
  const windows = fakeWindows(dir, { aceTypes: ['AccessAllowed'], aces: [{ sid: USER, rights: 0x1f01ff, type: 'Allow' }] });
  writeOwnerOnlyFile(target, TEXT, { platform: 'win32', windows });
  const [privateDirectory] = windows.seen[0][1];
  const file = windows.seen[1][1];
  assert.match(privateDirectory, /^\.values\.json\.[A-Za-z0-9]{6}$/);
  assert.equal(file.length, 2);
  assert.equal(file[0], privateDirectory);
  assert.match(file[1], /^[0-9a-f]{12}\.tmp$/);
  // The directory is restricted while still empty; the file while still empty.
  assert.deepEqual(windows.seen, [['directory', [privateDirectory], 0, USER], ['file', file, '', USER], ['read', file, '']]);
  assert.equal(fs.readFileSync(target, 'utf8'), TEXT);
  assert.deepEqual(fs.readdirSync(dir), ['values.json']);
});

test('Windows: refuses an ACL that lets anyone else in, or cannot be checked, and leaves the target as it was', () => {
  const acls = [
    { aceTypes: ['AccessAllowed', 'AccessAllowed'], aces: [{ sid: USER, type: 'Allow' }, { sid: USERS, type: 'Allow' }] },
    { aceTypes: ['AccessAllowed'], aces: [{ sid: USERS, type: 'Allow' }] },
    { aceTypes: ['AccessDenied'], aces: [{ sid: USER, type: 'Deny' }] },
    { aceTypes: ['AccessAllowedCallback'], aces: [{ sid: USER, type: 'Allow' }] },
    { aceTypes: [], aces: [] },
    // No DACL at all lets everyone in.
    { aceTypes: null, aces: [] },
  ];
  for (const acl of acls) {
    const { dir, target } = scratch();
    fs.writeFileSync(target, 'old');
    assert.throws(() => writeOwnerOnlyFile(target, TEXT, { platform: 'win32', windows: fakeWindows(dir, acl) }),
      (error) => error instanceof OwnerOnlyRefusal && /readable by you alone/.test(error.message));
    assert.equal(fs.readFileSync(target, 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(dir), ['values.json']);
  }
});

test('a failure at any step writes nothing and leaves nothing behind', () => {
  const { dir, target } = scratch();
  const fail = (step) => ({ ...fakeWindows(dir, null), [step]: () => { throw new Error(`${step} failed`); } });
  for (const step of ['currentUserSid', 'restrictDirectory', 'restrictToUser', 'readAcl']) {
    assert.throws(() => writeOwnerOnlyFile(target, TEXT, { platform: 'win32', windows: fail(step) }), new RegExp(`${step} failed`));
    assert.deepEqual(fs.readdirSync(dir), [], step);
  }
  assert.throws(() => writeOwnerOnlyFile(target, TEXT, { platform: 'win32' }), /without its ACL helpers/);
  // A rename that fails (the target is a directory) removes the private directory and the text written into it.
  fs.mkdirSync(target);
  const windows = fakeWindows(dir, { aceTypes: ['AccessAllowed'], aces: [{ sid: USER, type: 'Allow' }] });
  assert.throws(() => writeOwnerOnlyFile(target, TEXT, { platform: 'win32', windows }));
  assert.deepEqual(fs.readdirSync(dir), ['values.json']);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('a directory that does not exist is an error, with nothing written', () => {
  const { dir } = scratch();
  const missing = path.join(dir, 'missing', 'values.json');
  assert.throws(() => writeOwnerOnlyFile(missing, TEXT, { platform: 'linux' }), { code: 'ENOENT' });
  assert.throws(() => writeOwnerOnlyFile(missing, TEXT, { platform: 'win32', windows: fakeWindows(dir, null) }), { code: 'ENOENT' });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('macOS: refuses, before a byte is written, a file that inherited an ACL entry letting someone else in', { skip: process.platform === 'win32' && 'macOS ACLs' }, () => {
  const { dir, target } = scratch();
  const refused = (error) => error instanceof OwnerOnlyRefusal && /lets someone else in/.test(error.message);
  // What the file's ACL says is passed in here; on macOS the real one is read below too.
  const grants = ['0: group:everyone inherited allow read'];
  assert.throws(() => writeOwnerOnlyFile(target, TEXT, { platform: 'darwin', aclGrants: () => grants }), refused);
  assert.deepEqual(fs.readdirSync(dir), []);
  writeOwnerOnlyFile(target, TEXT, { platform: 'darwin', aclGrants: () => [] });
  assert.equal(fs.readFileSync(target, 'utf8'), TEXT);
  if (process.platform !== 'darwin') return;
  // For real: a directory whose ACL gives every new file read access for everyone.
  fs.rmSync(target);
  execFileSync('/bin/chmod', ['+a', 'group:everyone allow read,file_inherit', dir]);
  assert.throws(() => writeOwnerOnlyFile(target, TEXT), refused);
  assert.deepEqual(fs.readdirSync(dir), []);
  execFileSync('/bin/chmod', ['-N', dir]);
  writeOwnerOnlyFile(target, TEXT);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('an ACL listing that fails prints nothing, not even the name it was given', { skip: !fs.existsSync('/bin/ls') && 'needs /bin/ls' }, () => {
  // `ls` names the file it could not list; that must stay in the error thrown, never reach stderr.
  const missing = path.join(scratch().dir, 'zebra 4,500.00.json');
  const helper = new URL('./owner-only-file.mjs', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { macAclGrants } from ${JSON.stringify(helper)};
    try { macAclGrants(process.argv[1]); } catch { process.exitCode = 7; }`, missing], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 7, run.stderr);
  assert.equal(run.stderr, '');
});