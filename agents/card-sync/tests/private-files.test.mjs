import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createLogger } from '../lib/logger.mjs';
import { listOutbox, outboxName, supersededFiles, sweepOutboxTemp, writeOutbox } from '../lib/outbox.mjs';
import { ensurePairing, loadState, PairingError, readPairing } from '../lib/pairing.mjs';
import {
  ADMINISTRATORS_SID, currentUserSid, inspectPrivate, makePrivateDir, makePrivateFile, parseWindowsAcl, readWindowsAcl, SYSTEM_SID, system32,
} from '../lib/private-fs.mjs';
import { createRawStore, RAW_NAME, rawName, RawCleanupError } from '../lib/raw-store.mjs';
import { tempDir } from './helpers.mjs';

const SOURCE_ID = `amex-${'k'.repeat(64)}`;
const windows = process.platform === 'win32';
const PRIVATE = { ok: true, problem: null, owner: 'current' };
const UNREADABLE = { ok: false, problem: 'access list could not be read', owner: null };
const SAMPLE_SID = 'S-1-5-21-1000-2000-3000-1001';
const OTHER_SID = 'S-1-5-21-1000-2000-3000-1002';
const EVERYONE_SID = 'S-1-1-0';
const allow = (sid) => ({ sid, type: 'Allow' });

/** whoami, icacls and PowerShell as Windows answers them, recorded; `acl` is what PowerShell reports for any path. */
function fakeWindows(acl = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    const program = path.win32.basename(command).toLowerCase();
    if (program === 'whoami.exe') return `"sample-pc\\sample","${SAMPLE_SID}"\r\n`;
    if (program === 'powershell.exe') {
      return JSON.stringify({ owner: SAMPLE_SID, aceTypes: ['AccessAllowed', 'AccessAllowed'], aces: [allow(SAMPLE_SID), allow(SYSTEM_SID)], ...acl });
    }
    return '';
  };
  return { run, calls };
}

test('Windows: a private folder or file gets full control for this account and SYSTEM only, and this account as its owner', (t) => {
  const dir = path.join(tempDir(t), 'imports');
  const { run, calls } = fakeWindows();
  const icacls = system32('icacls.exe');
  makePrivateDir(dir, { platform: 'win32', run });
  assert.deepEqual(calls, [
    [system32('whoami.exe'), '/user', '/fo', 'csv', '/nh'],
    [icacls, dir, '/reset', '/q'],
    [icacls, dir, '/inheritance:r', '/grant:r', `*${SAMPLE_SID}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/q'],
    [icacls, dir, '/setowner', `*${SAMPLE_SID}`, '/q'],
  ]);
  assert.match(icacls, /^[A-Za-z]:\\.+\\System32\\icacls\.exe$/i, 'by full path, never whatever PATH finds first');
  const file = path.join(dir, 'local-key.json');
  fs.writeFileSync(file, '{}');
  calls.length = 0;
  makePrivateFile(file, { platform: 'win32', run });
  assert.deepEqual(calls, [
    [icacls, file, '/reset', '/q'],
    [icacls, file, '/inheritance:r', '/grant:r', `*${SAMPLE_SID}:F`, '*S-1-5-18:F', '/q'],
    [icacls, file, '/setowner', `*${SAMPLE_SID}`, '/q'],
  ]);
  // When Windows does not let this account take the folder over, the folder is refused.
  const refusing = (command, args) => {
    if (args.includes('/setowner')) throw new Error('Access is denied.');
    return run(command, args);
  };
  assert.throws(() => makePrivateDir(dir, { platform: 'win32', run: refusing }), /Access is denied/);
});

test('Windows: private is Holdr\'s owner-only rule: owned by you, and only you, SYSTEM and Administrators allowed in', (t) => {
  const dir = tempDir(t);
  const check = (acl) => inspectPrivate(dir, { platform: 'win32', run: fakeWindows(acl).run });
  assert.deepEqual(check({}), PRIVATE, 'you and SYSTEM: the folder that npm run start:local and the README create');
  assert.deepEqual(check({ aceTypes: ['AccessAllowed', 'AccessAllowed', 'AccessAllowed'], aces: [allow(SAMPLE_SID), allow(SYSTEM_SID), allow(ADMINISTRATORS_SID)] }),
    PRIVATE, 'Administrators too, as in a folder inside your user profile');
  assert.deepEqual(check({ aceTypes: ['AccessDenied', 'AccessAllowed'], aces: [{ sid: EVERYONE_SID, type: 'Deny' }, allow(SAMPLE_SID)] }),
    PRIVATE, 'a deny entry only takes access away');
  assert.deepEqual(check({ aces: [allow(SAMPLE_SID), allow(EVERYONE_SID)] }), { ok: false, problem: 'other accounts have access', owner: 'current' });
  assert.deepEqual(check({ owner: OTHER_SID }), { ok: false, problem: 'owned by another account', owner: 'other' });
  assert.deepEqual(check({ owner: ADMINISTRATORS_SID }), { ok: false, problem: 'owned by the Administrators group, not by you', owner: 'administrators' });
  assert.deepEqual(check({ aceTypes: null, aces: [] }), { ok: false, problem: 'it has no access list, so everyone has access', owner: 'current' });
  assert.deepEqual(check({ aceTypes: ['AccessAllowed', 'AccessAllowedCallback'] }),
    { ok: false, problem: 'its access list has entries that cannot be checked', owner: 'current' });
  assert.deepEqual(check({ owner: null }), UNREADABLE);
  assert.deepEqual(check({ aces: [{ sid: 'Everyone', type: 'Allow' }] }), UNREADABLE, 'SIDs only, never names');
  assert.deepEqual(inspectPrivate(dir, { platform: 'win32', run: () => 'not json' }), UNREADABLE);
  assert.deepEqual(inspectPrivate(path.join(dir, 'missing'), { platform: 'win32', run: fakeWindows().run }), { ok: false, problem: 'missing', owner: null });
  // Windows PowerShell 5.1 writes a one-item list as the item, or as { value, Count }; a missing list is never "none".
  const one = { owner: SAMPLE_SID, aceTypes: ['AccessAllowed'], aces: [allow(SAMPLE_SID)] };
  assert.deepEqual(parseWindowsAcl(JSON.stringify({ owner: SAMPLE_SID, aceTypes: 'AccessAllowed', aces: allow(SAMPLE_SID) })), one);
  assert.deepEqual(parseWindowsAcl(JSON.stringify({ owner: SAMPLE_SID, aceTypes: { value: ['AccessAllowed'], Count: 1 }, aces: { value: [allow(SAMPLE_SID)], Count: 1 } })), one);
  assert.throws(() => parseWindowsAcl(JSON.stringify({ owner: SAMPLE_SID, aces: [] })), /no owner/);
});

test('the imports folder becomes private to this account (Windows: you and SYSTEM, nothing inherited, owned by you)', (t) => {
  const root = tempDir(t);
  const dir = path.join(root, 'imports');
  makePrivateDir(dir);
  assert.deepEqual(inspectPrivate(dir), PRIVATE);
  if (windows) {
    const me = currentUserSid();
    const acl = readWindowsAcl(dir);
    assert.deepEqual(acl.aces.map((ace) => `${ace.type} ${ace.sid}`).sort(), [`Allow ${SYSTEM_SID}`, `Allow ${me}`].sort());
    assert.ok(acl.aceTypes.every((type) => type === 'AccessAllowed'));
    const icacls = (...args) => execFileSync(system32('icacls.exe'), [...args, '/q'], { windowsHide: true, stdio: 'ignore' });
    // The folder the README and docs/importing-data.md have you create is private as it is.
    const readme = path.join(root, 'readme');
    fs.mkdirSync(readme);
    icacls(readme, '/inheritance:r', '/grant:r', `*${me}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`);
    icacls(readme, '/setowner', `*${me}`);
    assert.deepEqual(inspectPrivate(readme), PRIVATE);
    // A folder that other accounts could read before is locked down too.
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    icacls(shared, '/grant', `*${EVERYONE_SID}:(OI)(CI)R`);
    assert.equal(inspectPrivate(shared).problem, 'other accounts have access');
    makePrivateDir(shared);
    assert.deepEqual(inspectPrivate(shared), PRIVATE);
    // Files written inside inherit its access list (and belong to the Administrators group when written elevated).
    fs.writeFileSync(path.join(shared, 'inside.txt'), 'synthetic');
    const inside = inspectPrivate(path.join(shared, 'inside.txt'));
    if (inside.owner === 'administrators') assert.equal(inside.problem, 'owned by the Administrators group, not by you');
    else assert.deepEqual(inside, PRIVATE);
  } else {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    fs.chmodSync(dir, 0o755);
    assert.equal(inspectPrivate(dir).ok, false);
    makePrivateDir(dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(dir, link, 'junction');
    assert.throws(() => makePrivateDir(link), /not a plain folder/);
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
  }
});

test('a raw export is written once into a new owner-only file and read back; its name never reveals the card', async (t) => {
  const dir = tempDir(t);
  makePrivateDir(dir);
  const store = createRawStore(dir);
  const name = rawName(SOURCE_ID, '2026-08-14');
  assert.match(name, RAW_NAME);
  assert.equal(name.includes('91005'), false);
  const file = store.stage(name, 'SYNTHETIC,RAW\r\n');
  assert.equal(store.read(file), 'SYNTHETIC,RAW\r\n');
  if (!windows) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => store.stage(name, 'again'), { code: 'EEXIST' });
  assert.throws(() => store.stage('statement.csv', 'x'), /invalid raw export name/);
  assert.throws(() => store.read(path.join(dir, '..', 'elsewhere.csv')), /invalid raw export path/);
  await store.remove(file);
  assert.equal(fs.existsSync(file), false);
  await store.remove(file);
});

test('leftover raw exports are deleted at start; unknown files are reported and kept', async (t) => {
  const dir = tempDir(t);
  const store = createRawStore(dir);
  const leftover = store.stage(rawName(SOURCE_ID, '2026-07-14'), 'SYNTHETIC');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');
  const swept = await createRawStore(dir).sweep();
  assert.deepEqual(swept, { removed: 1, unknown: ['notes.txt'] });
  assert.equal(fs.existsSync(leftover), false);
  assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true);
});

test('when a raw export cannot be deleted, syncing pauses until it is gone; a failed write leaves no file', async (t) => {
  const dir = tempDir(t);
  let attempts = 0;
  const locked = createRawStore(dir, {
    unlink: () => { attempts += 1; throw Object.assign(new Error('synthetic lock'), { code: 'EBUSY' }); },
    delay: async () => {},
  });
  const file = locked.stage(rawName(SOURCE_ID, '2026-06-14'), 'SYNTHETIC');
  await assert.rejects(locked.remove(file), RawCleanupError);
  assert.equal(attempts, 5);
  assert.equal(locked.blocked, true);
  assert.throws(() => locked.stage(rawName(SOURCE_ID, '2026-05-14'), 'more'), RawCleanupError);
  let transient = 0;
  const retrying = createRawStore(dir, {
    unlink: (target) => { transient += 1; if (transient < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); fs.unlinkSync(target); },
    delay: async () => {},
  });
  await retrying.remove(file);
  assert.equal(fs.existsSync(file), false);
  const failing = createRawStore(dir, {
    write: (fd) => { fs.writeSync(fd, 'SYNTHETIC PARTIAL'); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
  });
  const name = rawName(SOURCE_ID, '2026-04-14');
  assert.throws(() => failing.stage(name, 'SYNTHETIC'), /disk full/);
  assert.equal(fs.existsSync(path.join(dir, name)), false);
});

test('outbox files are written whole, named by card ending and dates, and replaced by a file that covers them', (t) => {
  const dir = tempDir(t);
  const older = outboxName('91005', { start: '2026-07-15', end: '2026-09-09' });
  const newer = outboxName('91005', { start: '2026-07-15', end: '2026-09-10' });
  assert.equal(older, 'amex-91005-2026-07-15-to-2026-09-09.json');
  writeOutbox(dir, older, '{"older":true}');
  writeOutbox(dir, newer, '{"newer":true}');
  writeOutbox(dir, outboxName('22002', { start: '2026-08-01', end: '2026-09-10' }), '{}');
  writeOutbox(dir, newer, '{"newer":2}');
  assert.equal(fs.readFileSync(path.join(dir, newer), 'utf8'), '{"newer":2}');
  if (!windows) assert.equal(fs.statSync(path.join(dir, newer)).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, `.${newer}.0badc0de.tmp`), 'partial');
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'not ours');
  assert.equal(sweepOutboxTemp(dir), 1);
  const entries = listOutbox(dir);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [older, newer, 'amex-22002-2026-08-01-to-2026-09-10.json'].sort());
  assert.deepEqual(supersededFiles(entries, '91005', { start: '2026-07-15', end: '2026-09-10' }, newer).map((entry) => entry.name), [older]);
  assert.deepEqual(listOutbox(path.join(dir, 'missing')), []);
  assert.throws(() => writeOutbox(dir, '../escape.json', '{}'), /invalid outbox file name/);
});

test('pairing: a new 64-hex key in a private file; a port change keeps the key; --rotate replaces it; damage is reported', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'local-key.json');
  const first = ensurePairing(file, { port: 4401 });
  assert.equal(first.created, true);
  assert.match(first.pairing.pairingKey, /^[0-9a-f]{64}$/);
  assert.deepEqual(readPairing(file), { pairingKey: first.pairing.pairingKey, receiverPort: 4401 });
  if (windows) assert.deepEqual(inspectPrivate(file), PRIVATE);
  else assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(ensurePairing(file, { port: 4401 }), { pairing: first.pairing, created: false, changed: false });
  const moved = ensurePairing(file, { port: 4402 });
  assert.equal(moved.changed, true);
  assert.equal(moved.pairing.pairingKey, first.pairing.pairingKey);
  const rotated = ensurePairing(file, { port: 4402, rotate: true });
  assert.notEqual(rotated.pairing.pairingKey, first.pairing.pairingKey);
  assert.deepEqual(fs.readdirSync(dir), ['local-key.json'], 'no temporary file is left behind');
  fs.writeFileSync(file, '{"format":"holdr-card-sync-pairing","version":1,"pairingKey":"short","receiverPort":4401}');
  assert.throws(() => readPairing(file), PairingError);
  assert.throws(() => ensurePairing(file, { port: 4401 }), /damaged/);
  assert.throws(() => ensurePairing(path.join(dir, 'missing', 'local-key.json'), { port: 4401 }), /extension folder was not found/);
  const state = loadState(path.join(dir, 'state.json'));
  assert.match(state.identitySalt, /^[0-9a-f]{64}$/);
  assert.deepEqual(loadState(path.join(dir, 'state.json')), state);
});

test('the log file is kept small while the receiver runs: past its size it becomes <file>.1, and no line is lost', (t) => {
  const file = path.join(tempDir(t), 'logs', 'receiver.log');
  const logger = createLogger({ file, stream: { write() {} }, maxBytes: 400 });
  t.after(() => logger.close());
  for (let count = 0; count < 12; count += 1) logger.event({ kind: 'channel-refused', count });
  logger.close();
  const before = fs.readFileSync(`${file}.1`, 'utf8');
  const now = fs.readFileSync(file, 'utf8');
  assert.ok(fs.statSync(`${file}.1`).size > 400 && fs.statSync(file).size <= 400, 'rotated once it grew past the limit');
  const counts = `${before}${now}`.trim().split('\n').map((line) => Number(/count=(\d+)$/.exec(line)[1]));
  assert.deepEqual(counts, Array.from({ length: 12 }, (_, count) => count));
  if (!windows) for (const name of [file, `${file}.1`]) assert.equal(fs.statSync(name).mode & 0o777, 0o600);
});
