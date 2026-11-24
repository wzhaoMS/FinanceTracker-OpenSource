/**
 * darwinPathcheck.ts on synthetic holdr-pathcheck/5 output, read by the ingress's own parsePathcheck. The helper and its
 * pin verification are stood in for, so no Mac is needed; the real helper is used by the macOS-only test in
 * metalsConvert.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), spawnSync }));

import type { CommandResult } from '../ingress/boundedCommand.js';
import { holdrConfNativePin, PATHCHECK_MAX_BYTES, PATHCHECK_TIMEOUT_MS, readPinnedPathcheck, runPathcheckSync } from './darwinPathcheck.js';

const PIN = { sourceCommit: 'c'.repeat(40), manifestDigest: 'd'.repeat(64) };
const verified = () => ({ binaryPath: '/synthetic/holdr-pathcheck' });
const TARGET = '/Users/sample5/out';

/** One object as the helper prints it, canonical JSON, with `extra` replacing its fields. */
const record = (kind: 'dir' | 'socket', at: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  kind, path: at, type: kind === 'dir' ? 'dir' : 'other', uid: 501, gid: 20, mode: 0o700, dev: '16777220', ino: '4242',
  aclPresent: false, acl: [], ...extra,
});
const entry = (mask = '0x2', perms = ['list']) => ({ type: 'allow', principal: 'gid', id: 12, mask, generic: [], perms, flags: ['inherited'] });

/** The helper's whole output for `target`: its header, every directory from / down, the path itself, and its terminal line. */
function helperOutput(target: string, endpoint: Record<string, unknown> = {}, terminal: unknown = 'done'): string {
  const parts = target.split('/').slice(1, -1);
  const dirs = ['/', ...parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)];
  const last = terminal === 'done' ? { done: true, objects: dirs.length + 1 } : terminal;
  return `${[JSON.stringify({ format: 'holdr-pathcheck/5' }), ...dirs.map((dir) => record('dir', dir)), record('socket', target, endpoint),
    ...(last === null ? [] : [JSON.stringify(last)])].join('\n')}\n`;
}
const runner = (result: CommandResult) => vi.fn((_binary: string, _target: string) => result);

describe('darwinPathcheck: the pinned reader, read by parsePathcheck', () => {
  it('reads every directory from / down, then the path itself, with its owner, mode and ACL entries', () => {
    const run = runner({ exitCode: 0, stdout: helperOutput(TARGET, { aclPresent: true, acl: [entry()] }) });
    const records = readPinnedPathcheck(TARGET, PIN, run, verified);
    expect(run).toHaveBeenCalledWith('/synthetic/holdr-pathcheck', TARGET);
    expect(records.map((object) => [object.kind, object.path])).toEqual([
      ['dir', '/'], ['dir', '/Users'], ['dir', '/Users/sample5'], ['socket', TARGET],
    ]);
    expect(records.at(-1)).toMatchObject({ type: 'other', uid: 501, mode: 0o700, acl: [entry()] });
  });

  it('refuses a path over 100 bytes without running the helper, and takes one of 100', () => {
    const long = `/${'x'.repeat(100)}`;
    const exact = `/${'x'.repeat(99)}`;
    const refused = runner({ exitCode: 0, stdout: helperOutput(long) });
    expect(() => readPinnedPathcheck(long, PIN, refused, verified)).toThrow();
    expect(refused).not.toHaveBeenCalled();
    const taken = runner({ exitCode: 0, stdout: helperOutput(exact) });
    expect(readPinnedPathcheck(exact, PIN, taken, verified).at(-1)).toMatchObject({ kind: 'socket', path: exact });
  });

  it('never runs the helper for a path of another form: relative, with //, a trailing slash or a control character', () => {
    const run = runner({ exitCode: 0, stdout: helperOutput(TARGET) });
    for (const target of ['relative/out', '/Users//out', '/Users/sample4/', '/Users/sample3/o\u0007ut']) {
      expect(() => readPinnedPathcheck(target, PIN, run, verified), target).toThrow();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('never runs the helper when the pin or the helper does not verify', () => {
    const run = runner({ exitCode: 0, stdout: helperOutput(TARGET) });
    expect(() => readPinnedPathcheck(TARGET, PIN, run, () => { throw new Error('E0I_NATIVE_HELPER'); })).toThrow('E0I_NATIVE_HELPER');
    expect(run).not.toHaveBeenCalled();
  });

  /** The helper's output when it fails closed at the path itself: the directories, then its error line. */
  const failure = (error: string, errno = 'EINVAL') => helperOutput(TARGET, {}, { error, path: TARGET, errno, code: 22 }).split('\n')
    .filter((_line, index, lines) => index !== lines.length - 3).join('\n');

  it('refuses an entry whose principal the helper cannot map (mbr_uuid_to_id): the helper fails closed, so it never reaches the rule', () => {
    expect(() => readPinnedPathcheck(TARGET, PIN, runner({ exitCode: 2, stdout: failure('mbr_uuid_to_id', 'ENOENT') }), verified)).toThrow('acl-acquisition-failed');
  });

  it('refuses what the helper reports as a failure, and every output parsePathcheck does not accept', () => {
    const refused: Array<[string, CommandResult]> = [
      ['an ACL entry kind it does not know', { exitCode: 2, stdout: failure('acl-unknown-tag') }],
      ["an entry whose principal it can't read", { exitCode: 2, stdout: failure('acl_get_qualifier', 'ENOMEM') }],
      ['rights bits it does not know', { exitCode: 0, stdout: helperOutput(TARGET, { aclPresent: true, acl: [entry('0x4000000', [])] }) }],
      ['rights that are not its mask', { exitCode: 0, stdout: helperOutput(TARGET, { aclPresent: true, acl: [entry('0x2', ['list', 'add_file'])] }) }],
      ['an entry with no ACL present', { exitCode: 0, stdout: helperOutput(TARGET, { aclPresent: false, acl: [entry()] }) }],
      ['a record for another path', { exitCode: 0, stdout: helperOutput(TARGET).replace('"path":"/Users"', '"path":"/Private"') }],
      ['no terminal line', { exitCode: 0, stdout: helperOutput(TARGET, {}, null) }],
      ['a line that is not canonical', { exitCode: 0, stdout: helperOutput(TARGET).replace('{"kind":"dir","path":"/",', '{"kind": "dir","path":"/",') }],
      ['another protocol', { exitCode: 0, stdout: helperOutput(TARGET).replace('holdr-pathcheck/5', 'holdr-pathcheck/4') }],
      ['a timeout', { exitCode: 'timeout', stdout: '' }],
      ['a helper that does not run', { exitCode: 'spawn-error', stdout: '' }],
    ];
    for (const [what, result] of refused) expect(() => readPinnedPathcheck(TARGET, PIN, runner(result), verified), what).toThrow();
  });

  it('runs the helper with the path as its one argument: no shell, a fixed environment, a timeout and a size cap', () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: 'synthetic', stderr: '', error: undefined });
    expect(runPathcheckSync('/synthetic/holdr-pathcheck', TARGET)).toEqual({ exitCode: 0, stdout: 'synthetic' });
    const [file, args, options] = spawnSync.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect([file, args]).toEqual(['/synthetic/holdr-pathcheck', [TARGET]]);
    expect(options).toEqual({
      env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PATHCHECK_TIMEOUT_MS, maxBuffer: PATHCHECK_MAX_BYTES,
    });
    for (const [code, exitCode] of [['ETIMEDOUT', 'timeout'], ['ENOBUFS', 'overflow'], ['ENOENT', 'spawn-error']] as const) {
      spawnSync.mockReturnValueOnce({ status: null, stdout: 'partial', error: Object.assign(new Error(code), { code }) });
      expect(runPathcheckSync('/synthetic/holdr-pathcheck', TARGET)).toEqual({ exitCode, stdout: '' });
    }
  });

  it('takes the pin from the start configuration the ingress reads, never one the environment contradicts', () => {
    const env = { HOLDR_CONFIG: 'none', HOLDR_E2E_RUN_ID: 'synthetic', HOLDR_NATIVE_COMMIT: PIN.sourceCommit, HOLDR_NATIVE_MANIFEST: PIN.manifestDigest };
    expect(holdrConfNativePin(env)).toEqual(PIN);
    expect(holdrConfNativePin({ HOLDR_CONFIG: 'none', HOLDR_E2E_RUN_ID: 'synthetic' })).toEqual({ sourceCommit: '', manifestDigest: '' });
    expect(() => holdrConfNativePin({ HOLDR_CONFIG: 'none' })).toThrow();
  });
});
