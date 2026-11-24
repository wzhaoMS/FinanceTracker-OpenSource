import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nativeFixture } from './nativeFixtures.js';
import { PATHCHECK_FORMAT } from './nativeHelper.js';
import { createSocketSafety, decodeAclMask, evaluateSocketPath, parsePathcheck, runPathcheck, type PathRecord } from './socketPath.js';
import { listenChecked } from './server.js';
import { closeServers } from './fixtures.js';

const sample: PathRecord[] = [
  { kind: 'dir', path: '/', type: 'dir', uid: 0, gid: 0, mode: 0o755, dev: '1', ino: '9007199254740993', aclPresent: false, acl: [] },
  { kind: 'dir', path: '/r', type: 'dir', uid: 501, gid: 20, mode: 0o700, dev: '1', ino: '3', aclPresent: false, acl: [] },
  { kind: 'absent', path: '/r/s' },
];
const output = (objects: unknown[]) => [{ format: PATHCHECK_FORMAT }, ...objects, { done: true, objects: objects.length }].map((line) => JSON.stringify(line)).join('\n') + '\n';
const parse = (objects: unknown[]) => parsePathcheck({ exitCode: 0, stdout: output(objects) }, '/r/s');

describe('strict pathcheck protocol and policy', () => {
  it('preserves identities above the JavaScript integer boundary and freezes the parsed facts', () => {
    const result = parse(sample);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.objects[0]).toHaveProperty('ino', '9007199254740993');
      expect(Object.isFrozen(result.objects[0])).toBe(true);
      expect(evaluateSocketPath(result.objects, { holdrUid: 501, phase: 'boot' }).ok).toBe(true);
    }
  });
  it.each([
    ['0x200000', ['generic_all'], ['writesecurity', 'delete_child']],
    ['0x800000', ['generic_write'], ['writesecurity', 'delete_child']],
    ['0x400000', ['generic_execute'], ['search']],
    ['0x1000000', ['generic_read'], ['list', 'readattr', 'readextattr', 'readsecurity']],
  ])('expands %s using the XNU masks', (mask, generic, rights) => {
    const decoded = decodeAclMask(mask as string)!;
    expect(decoded.generic).toEqual(generic);
    expect(decoded.perms).toEqual(expect.arrayContaining(rights as string[]));
    expect(decoded.perms).not.toContain('chown');
    expect(decoded.perms).not.toContain('synchronize');
  });
  it.each(['0x40000000', '0xffffffffffffffff', '0x0200000', '0X200000', '0x10000000000000000'])('refuses unknown/noncanonical mask %s', (mask) => {
    expect(decodeAclMask(mask)).toBeNull();
  });
  it.each([
    { type: 'allow', principal: 'gid', id: 12, mask: '0x200000', generic: ['generic_all'], perms: [], flags: [] },
    { type: 'allow', principal: 'gid', id: 12, mask: '0x1000', generic: [], perms: [], flags: [] },
    { type: 'allow', principal: 'gid', id: 12, mask: '0x40000000', generic: [], perms: [], flags: [] },
    { type: 'allow', principal: 'gid', id: 12, perms: ['list'], flags: [] },
  ])('rejects forged or revision-4 entries: %j', (entry) => {
    expect(parse([{ ...sample[0], aclPresent: true, acl: [entry] }, ...sample.slice(1)])).toEqual({ ok: false, code: 'pathcheck-output-invalid' });
  });
  it('rejects omitted, duplicated, reordered or invented ancestors and revision-4 empty output', () => {
    for (const objects of [sample.slice(1), [sample[0], sample[0], ...sample.slice(1)], [sample[1], sample[0], sample[2]],
      [sample[0], { ...sample[1], path: '/wrong' }, sample[2]], [sample[0], sample[1]], [...sample, sample[2]]]) {
      expect(parse(objects)).toHaveProperty('ok', false);
    }
    expect(parsePathcheck({ exitCode: 0, stdout: output(sample).split('\n').slice(1).join('\n') }, '/r/s')).toHaveProperty('ok', false);
  });
  it('rejects invalid numbers, mismatched ACL presence, unknown fields, missing terminators, duplicate keys and whitespace', () => {
    for (const patch of [{ uid: -1 }, { ino: 9007199254740992 }, { mode: 0o10000 }, { extra: 1 }, { aclPresent: 'false' }]) {
      expect(parse([{ ...sample[0], ...patch }, ...sample.slice(1)])).toHaveProperty('ok', false);
    }
    for (const stdout of [output(sample).trimEnd(), output(sample).replace('"done":true', '"done":false'),
      output(sample).replace('"uid":0', '"uid":0,"uid":0'), output(sample).replace('{"format"', '{ "format"')]) {
      expect(parsePathcheck({ exitCode: 0, stdout }, '/r/s')).toHaveProperty('ok', false);
    }
  });
  it('evaluates the full mask rather than accepting per-right omissions', () => {
    const decoded = decodeAclMask('0x200000')!;
    const records = structuredClone(sample);
    Object.assign(records[0], { aclPresent: true, acl: [{ type: 'allow', principal: 'gid', id: 12, mask: '0x200000', ...decoded, flags: [] }] });
    const parsed = parse(records);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(evaluateSocketPath(parsed.objects, { holdrUid: 501, phase: 'boot' }).findings).toContainEqual({ path: '/', code: 'acl-allows-modify' });
  });
  it('requires a recorded identity for poll and exact 0700 at the run directory', () => {
    const socket = { ...sample[1], kind: 'socket', type: 'socket', path: '/r/s' } as PathRecord;
    const records = [sample[0], sample[1], socket];
    expect(evaluateSocketPath(records, { holdrUid: 501, phase: 'poll' }).findings).toContainEqual({ path: '/r/s', code: 'socket-replaced' });
    expect(evaluateSocketPath([sample[0], { ...sample[1], mode: 0o1700 }, sample[2]] as PathRecord[], { holdrUid: 501, phase: 'boot' }).ok).toBe(false);
  });
});

describe.skipIf(process.platform !== 'darwin')('revision-5 reader on real macOS metadata', () => {
  let fixture: ReturnType<typeof nativeFixture>;
  beforeAll(() => { fixture = nativeFixture(); }, 60_000);
  afterAll(() => fixture?.cleanup());
  function check(socket: string, env: NodeJS.ProcessEnv = {}) {
    const result = fixture.read(socket, env);
    const parsed = parsePathcheck(result, socket);
    return { result, parsed, policy: parsed.ok ? evaluateSocketPath(parsed.objects, { holdrUid: process.getuid!(), phase: 'boot' }) : undefined };
  }
  it('round-trips generic ALL/WRITE through native buffers and refuses their real directory grants', () => {
    const base = fixture.mkdir('m');
    const rows = execFileSync(fixture.masks, [base], { encoding: 'utf8' }).trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.valid).toBe(0);
      expect(row.oldVisible).toBe(0);
      expect(row.applied).toBe(0);
      fixture.mkdir(`m/${row.case}/r`, 0o700);
      const result = check(path.join(base, row.case, 'r/s'));
      if (row.case === 'u') {
        expect(row.ok).toBe(false);
        expect(result.parsed).toEqual({ ok: false, code: 'acl-unrecognized' });
      } else if (['a', 'w'].includes(row.case)) {
        expect(row.acl[0].perms).toContain('writesecurity');
        expect(row.acl[0].perms).toContain('delete_child');
        expect(result.policy?.findings.some((finding) => finding.code === 'acl-allows-modify')).toBe(true);
      } else expect(result.policy?.ok).toBe(true);
    }
  });
  it.each([
    ['allow', 'everyone allow delete_child', 'acl-allows-modify'],
    ['staff', 'group:staff allow writesecurity', 'acl-allows-modify'],
    ['deny', 'everyone deny delete', null],
    ['home', 'everyone deny delete', null],
  ])('checks ACL %s on owned fixture ancestors', (name, acl, code) => {
    const dir = fixture.mkdir(String(name));
    fixture.mkdir(`${name}/r`, 0o700);
    fixture.acl(dir, String(acl));
    if (name === 'home') fixture.acl(dir, 'everyone allow delete_child');
    const result = check(path.join(dir, 'r/s'));
    expect(result.parsed.ok).toBe(true);
    if (code || name === 'home') expect(result.policy?.findings.some((finding) => finding.code === (code ?? 'acl-allows-modify'))).toBe(true);
    else expect(result.policy?.ok).toBe(true);
  });
  it('fails on an actual readsecurity acquisition denial, not an empty ACL', () => {
    const dir = fixture.mkdir('denied');
    fixture.mkdir('denied/r', 0o700);
    fixture.acl(dir, `user:${os.userInfo().username} deny readsecurity`);
    try {
      const result = check(path.join(dir, 'r/s'));
      expect(result.result.exitCode).toBe(2);
      expect(result.parsed).toEqual({ ok: false, code: 'acl-acquisition-failed' });
    } finally { execFileSync('/bin/chmod', ['-N', dir]); }
  });
  it('rejects symlinks, group/sticky write bits, reachable endpoints and missing directories', () => {
    const dir = fixture.mkdir('unsafe');
    fixture.mkdir('unsafe/r', 0o700);
    fs.symlinkSync(dir, path.join(fixture.root, 'link'));
    expect(check(path.join(fixture.root, 'link/r/s')).parsed).toEqual({ ok: false, code: 'not-a-plain-directory' });
    for (const mode of [0o775, 0o1777]) {
      fs.chmodSync(dir, mode);
      expect(check(path.join(dir, 'r/s')).policy?.findings.some((finding) => finding.code === 'group-or-other-writable')).toBe(true);
    }
    fs.chmodSync(dir, 0o755);
    fixture.acl(path.join(dir, 'r'), 'everyone allow search');
    expect(check(path.join(dir, 'r/s')).policy?.findings.some((finding) => finding.code === 'endpoint-reachable')).toBe(true);
    expect(check(path.join(fixture.root, 'missing/r/s')).parsed).toEqual({ ok: false, code: 'missing' });
  });
  it.each([
    ['before', 'group-or-other-writable'], ['after', 'group-or-other-writable'], ['torn', 'group-or-other-writable'],
    ['flap', 'metadata-unstable'], ['eio', 'acl-acquisition-failed'], ['prop-eio', 'acl-acquisition-failed'],
  ])('refuses the %s stat/ACL interleaving or acquisition error', (mode, code) => {
    const dir = fixture.mkdir(`q${mode[0]}`);
    fixture.mkdir(`q${mode[0]}/r`, 0o700);
    fixture.acl(dir, 'everyone allow writesecurity');
    const result = check(path.join(dir, 'r/s'), {
      DYLD_INSERT_LIBRARIES: fixture.interposer, HOLDR_RACE_MODE: mode, HOLDR_RACE_INO: fs.statSync(dir, { bigint: true }).ino.toString(),
    });
    if (result.parsed.ok) expect(result.policy?.findings.some((finding) => finding.code === code)).toBe(true);
    else expect(result.parsed.code).toBe(code);
    if (mode === 'flap') expect(result.result.stderr).toContain('target-snapshots=10');
  });
  it('uses ctime in the stability fence even when mode and ACL have returned to their old values', () => {
    const dir = fixture.mkdir('ct');
    fixture.mkdir('ct/r', 0o700);
    const result = check(path.join(dir, 'r/s'), {
      DYLD_INSERT_LIBRARIES: fixture.interposer, HOLDR_RACE_MODE: 'ctime-only', HOLDR_RACE_INO: fs.statSync(dir, { bigint: true }).ino.toString(),
    });
    expect(result.policy?.ok).toBe(true);
    expect(result.result.stderr).toContain('target-snapshots=4');
  });
  it('distinguishes absent ACL from present-empty ACL; production launch drops interposer variables', async () => {
    const dir = fixture.mkdir('empty');
    fixture.mkdir('empty/r', 0o700);
    const socket = path.join(dir, 'r/s');
    const absent = check(socket);
    const empty = check(socket, { DYLD_INSERT_LIBRARIES: fixture.interposer, HOLDR_RACE_MODE: 'empty-acl' });
    expect(absent.parsed.ok && absent.parsed.objects[0]).toHaveProperty('aclPresent', false);
    expect(empty.parsed.ok && empty.parsed.objects[0]).toHaveProperty('aclPresent', true);
    expect(empty.policy?.ok).toBe(true);
    vi.stubEnv('DYLD_INSERT_LIBRARIES', fixture.interposer);
    vi.stubEnv('HOLDR_RACE_MODE', 'prop-eio');
    try { expect((await runPathcheck(socket, fixture.native)).ok).toBe(true); }
    finally { vi.unstubAllEnvs(); }
  });
  it('pins the real bound socket and detects a replacement', async () => {
    const dir = fixture.mkdir('live', 0o700);
    const socketPath = path.join(dir, 's');
    const provider = createSocketSafety({ socketPath, native: fixture.native });
    const server = http.createServer();
    const mask = process.umask(0o077);
    try {
      await listenChecked(server, { mode: 'dist', listener: 'ingress', publicOrigin: 'https://holdr.test', socketPath }, provider.safety);
      expect((await provider.inspect('poll')).ok).toBe(true);
      await expect(provider.preflight()).rejects.toThrow('E0I_SOCKET_IN_USE');
      await expect(provider.preflight(async () => true)).resolves.toHaveProperty('ok', true);
      fs.renameSync(socketPath, socketPath + '.old');
      fs.writeFileSync(socketPath, 'not a socket', { mode: 0o600 });
      expect((await provider.inspect('poll')).findings.some((finding) => finding.code === 'socket-replaced')).toBe(true);
    } finally { process.umask(mask); await closeServers([server]); }
  });
  it('removes only a verified, connection-refused stale socket before binding', async () => {
    const dir = fixture.mkdir('stale', 0o700);
    const socketPath = path.join(dir, 's');
    const child = spawn(process.execPath, ['-e', "process.umask(0o077);require('node:net').createServer().listen('s',()=>console.log('ready'))"], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
      expect(fs.existsSync(socketPath)).toBe(true);
      const provider = createSocketSafety({ socketPath, native: fixture.native });
      await provider.safety.beforeListen(socketPath);
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
  it('ships no reader path that skips the fence or reads stat and ACL separately', () => {
    const source = fs.readFileSync(path.resolve(fixture.binary, '../../../apps/api/native/holdr-pathcheck.c'), 'utf8');
    expect(source).not.toMatch(/HOLDR_TEST_SINGLE_CALL|\b(?:fstat|fstatat|acl_get_fd_np|acl_get_link_np)\s*\(/);
    expect(source).toContain('SNAPSHOT_TRIES 5');
  });
});
