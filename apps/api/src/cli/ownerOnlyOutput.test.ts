import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADMINISTRATORS_SID, readCurrentUserSid, readWindowsAcls, readWindowsFileAcl, restrictToUser, SYSTEM_SID, takeOwnership, type WindowsAcl,
} from '../e2e/windowsAcl.js';
import type { PathObject, PathRecord } from '../ingress/socketPath.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { ALIAS_FOLDERS, ORDINARY_NAMES, WINDOWS_DEVICE_NAMES, windowsAliasPaths } from '../testing/windowsAliasPaths.js';
import {
  assertOwnerOnlyDirectory, InputRefusal, isWindowsAliasName, OUTPUT_REFUSALS, OutputRefusal, ownerOnlyAcl, platformOutputAccess,
  readOwnerOnlyFile, writeOwnerOnlyNewFile, type OutputAccess, type OwnerOnlyReadPoint,
} from './ownerOnlyOutput.js';

// Synthetic only: files in a scratch directory, and stand-in policy readers that report what the path names when asked.

/** apps/api: where a child resolves tsx, as the package's own scripts run it. */
const API_DIR = fileURLToPath(new URL('../..', import.meta.url));
let dir: string;
beforeEach(async () => { dir = await makeScratchDir('owner-only-read-'); });
afterEach(async () => { await removeScratchDir(dir); });

const USER_SID = 'S-1-5-21-11-22-33-501';
const USERS_SID = 'S-1-5-32-545';
const UID = 501;

const write = (name: string, text: string): string => {
  const target = path.join(dir, name);
  fs.writeFileSync(target, text, { mode: 0o600 });
  return target;
};
/** The identity the path names now, as a reader that opens it by path would report it. */
const identityOf = (target: string) => {
  const stat = fs.statSync(target, { bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
};
/** A swap: another file at the path (delete, then create; Windows refuses to rename over an open file). */
const swapIn = (target: string) => {
  fs.rmSync(target);
  fs.writeFileSync(target, 'replacement', { mode: 0o600 });
};
const refusal = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (error) {
    if (error instanceof InputRefusal) return error.reason;
    throw error;
  }
  return null;
};

/** Windows: a one-handle reader stand-in, owner-only unless an entry is added, failing when told to. */
function windows(options: { extra?: WindowsAcl['aces']; fail?: boolean } = {}): OutputAccess {
  return {
    platform: 'win32',
    currentUserSid: () => USER_SID,
    readAcls: () => { throw new Error('not used for a read'); },
    readFileAcl: (target) => {
      if (options.fail) throw new Error('the reader failed');
      const aces: WindowsAcl['aces'] = [{ sid: USER_SID, rights: 0x1f01ff, type: 'Allow' }, { sid: SYSTEM_SID, rights: 0x1f01ff, type: 'Allow' },
        { sid: ADMINISTRATORS_SID, rights: 0x1f01ff, type: 'Allow' }, ...(options.extra ?? [])];
      const { dev, ino } = identityOf(target);
      return { owner: USER_SID, aces, aceTypes: aces.map((ace) => (ace.type === 'Allow' ? 'AccessAllowed' : 'AccessDenied')), volume: dev, index: ino };
    },
  };
}

/** macOS: the pinned reader stand-in, its directory's record then the file's, owner-only unless told otherwise. */
function darwin(options: { uid?: number; mode?: number; type?: PathObject['type'] } = {}): OutputAccess {
  return {
    platform: 'darwin',
    currentUserSid: () => { throw new Error('not used on macOS'); },
    readAcls: () => { throw new Error('not used on macOS'); },
    darwin: {
      currentUid: () => UID,
      readPath: (target): PathRecord[] => {
        const common = { uid: options.uid ?? UID, gid: 20, aclPresent: false, acl: [] };
        return [{ kind: 'dir', path: path.dirname(target), type: 'dir', mode: 0o700, dev: '1', ino: '2', ...common },
          { kind: 'socket', path: target, type: options.type ?? 'other', mode: options.mode ?? 0o600, ...identityOf(target), ...common }];
      },
    },
  };
}

describe('readOwnerOnlyFile: the owner-only read protocol (corrections design r6, section 2.8)', () => {
  it('reads an owner-only file through each platform policy, bound to the descriptor it opened', () => {
    const file = write('input.txt', 'synthetic input');
    expect(readOwnerOnlyFile(file, 64, windows()).toString()).toBe('synthetic input');
    expect(readOwnerOnlyFile(file, 64, darwin()).toString()).toBe('synthetic input');
    expect(readOwnerOnlyFile(file, 15, windows()).toString()).toBe('synthetic input');
  });

  it('refuses by closed reasons, naming no path: missing, malformed, not owner-only and uncheckable', () => {
    const file = write('input.txt', 'synthetic input');
    expect(refusal(() => readOwnerOnlyFile(path.join(dir, 'absent.txt'), 64, windows()))).toBe('missing');
    expect(refusal(() => readOwnerOnlyFile(file, 14, windows()))).toBe('malformed');
    expect(refusal(() => readOwnerOnlyFile(dir, 64, windows()))).toBe('malformed');
    expect(refusal(() => readOwnerOnlyFile(file, 64, windows({ extra: [{ sid: USERS_SID, rights: 0xa9, type: 'Allow' }] })))).toBe('not-owner-only');
    expect(refusal(() => readOwnerOnlyFile(file, 64, darwin({ mode: 0o640 })))).toBe('not-owner-only');
    expect(refusal(() => readOwnerOnlyFile(file, 64, darwin({ uid: UID + 1 })))).toBe('not-owner-only');
    expect(refusal(() => readOwnerOnlyFile(file, 64, windows({ fail: true })))).toBe('uncheckable');
    expect(refusal(() => readOwnerOnlyFile(file, 64, { ...windows(), readFileAcl: undefined }))).toBe('uncheckable');
    expect(refusal(() => readOwnerOnlyFile(file, 64, { ...darwin(), darwin: undefined }))).toBe('uncheckable');
    expect(refusal(() => readOwnerOnlyFile(file, 64, darwin({ type: 'dir' })))).toBe('uncheckable');
    expect(refusal(() => readOwnerOnlyFile('input.txt', 64, windows()))).toBe('uncheckable');
  });

  it('refuses a swap at every step: the identity its policy read, or the path after the read, is not the descriptor\'s', () => {
    for (const point of ['opened', 'checked', 'read'] as const) {
      for (const [name, access] of [['windows', windows()], ['darwin', darwin()]] as const) {
        const file = write(`input-${point}-${name}.txt`, 'synthetic input');
        const probe = (at: OwnerOnlyReadPoint) => { if (at === point) swapIn(file); };
        expect(refusal(() => readOwnerOnlyFile(file, 64, access, probe)), `${name} after ${point}`).toBe('changed');
      }
    }
  });

  it('judges a file swapped in before the open on its own', () => {
    const file = write('input.txt', 'synthetic input');
    swapIn(file);
    expect(readOwnerOnlyFile(file, 64, windows()).toString()).toBe('replacement');
    expect(refusal(() => readOwnerOnlyFile(file, 64, windows({ extra: [{ sid: USERS_SID, rights: 0xa9, type: 'Allow' }] })))).toBe('not-owner-only');
  });

  it.runIf(process.platform !== 'win32')('on POSIX, refuses a link at the path at the open itself, and binds the owner and mode to fstat on Linux', () => {
    const file = write('input.txt', 'synthetic input');
    const link = path.join(dir, 'link.txt');
    fs.symlinkSync(file, link);
    expect(refusal(() => readOwnerOnlyFile(link, 64, darwin()))).toBe('changed');
    const linux: OutputAccess = { ...windows(), platform: 'linux', readFileAcl: undefined };
    expect(readOwnerOnlyFile(file, 64, linux).toString()).toBe('synthetic input');
    fs.chmodSync(file, 0o640);
    expect(refusal(() => readOwnerOnlyFile(file, 64, linux))).toBe('not-owner-only');
  });

  // 9854b7c2's IDENTITY-FIFO-OPEN (#324): a FIFO with no writer at the path is refused by its type, `malformed`, without
  // the open waiting for a writer. The read runs in a child bounded at 5 s, so a blocking open fails this test (the
  // child timed out) instead of hanging the run.
  it.runIf(process.platform !== 'win32')('on POSIX, refuses a FIFO with no writer as malformed, without blocking at the open', () => {
    const fifo = path.join(dir, 'identity.key');
    execFileSync('mkfifo', ['-m', '600', fifo]);
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', [
      'const { readOwnerOnlyFile } = await import(process.argv[1]);',
      'try { readOwnerOnlyFile(process.argv[2], 64); console.log("read"); }',
      'catch (error) { console.log(error.reason ?? error.name); }',
    ].join('\n'), new URL('./ownerOnlyOutput.ts', import.meta.url).href, fifo], { cwd: API_DIR, encoding: 'utf8', timeout: 5_000 });
    expect(child.error?.message ?? null, 'the read finished within 5 s').toBeNull();
    expect(child.stdout.trim()).toBe('malformed');
  }, 20_000);

  it.runIf(process.platform === 'win32')('on Windows, reads the ACL and the identity through one handle: the identity is the descriptor\'s', () => {
    const sid = readCurrentUserSid();
    restrictToUser(dir, sid);
    const file = write('input.txt', 'synthetic input');
    // The current user's, as a normal shell makes them: an elevated one leaves Administrators their owner.
    for (const target of [dir, file]) takeOwnership(target, sid);
    const fd = fs.openSync(file, 'r');
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      const acl = readWindowsFileAcl(file);
      expect({ volume: acl.volume, index: acl.index }).toEqual({ volume: opened.dev.toString(), index: opened.ino.toString() });
      expect(ownerOnlyAcl(acl, sid)).toBe(true);
    } finally {
      fs.closeSync(fd);
    }
    expect(readOwnerOnlyFile(file, 64, platformOutputAccess).toString()).toBe('synthetic input');
  }, 60_000);
});

/**
 * The output name rule (ROOT, 11/09, after E1's probe in #318): an output path with a folder or file name that Windows
 * reads as another file or a device is refused as `output-name-refused`, on every platform, before anything is read or
 * created. Stand-ins for the module's readers record every call, so each refusal shows that nothing was checked, and the
 * folder's listing that nothing was made. The module's owner-only output rules are tested through their callers
 * (metals*, operatorIo, retailConvertOwnerOnly). Synthetic paths and text only.
 */
const onWindows = process.platform === 'win32';
const USER = 'S-synthetic-user';
const TEXT = '{"synthetic":true}\n';
/** The platforms the module tells apart: the rule comes before all of them. */
const PLATFORMS: readonly NodeJS.Platform[] = ['win32', 'darwin', 'linux'];

/**
 * A stand-in for each reader the module has, recording every call: on Windows the current user's SID and an owner-only
 * ACL; on macOS the current uid and no records from the pinned reader (so a check there fails: the call is what a
 * refusal test looks for). Linux's check reads none: a path that got that far would write, or end as another refusal.
 */
function standIn(platform: NodeJS.Platform) {
  const calls: string[] = [];
  const access: OutputAccess = {
    platform,
    currentUserSid: () => {
      calls.push('sid');
      return USER;
    },
    readAcls: (paths) => paths.map((target): WindowsAcl => {
      calls.push(`acl ${path.basename(target)}`);
      return { owner: USER, aceTypes: ['AccessAllowed'], aces: [{ sid: USER, rights: 1, type: 'Allow' }] };
    }),
    darwin: {
      currentUid: () => {
        calls.push('uid');
        return 501;
      },
      readPath: (target) => {
        calls.push(`records ${path.basename(target)}`);
        return [];
      },
    },
  };
  return { access, calls };
}

type ErrorType = abstract new (...args: never[]) => Error;
/**
 * A check's action part: the error `fn` throws if it is one of the declared types, kept as thrown, or null when `fn`
 * returns. Anything else is re-thrown unchanged, so no catch turns an unexpected error into data for an assertion (ROOT's
 * kill standard, addendum 3(e) and ruling 8); each `expect` on its result is the assertion-only part.
 */
const declared = (fn: () => unknown, ...types: ErrorType[]): Error | null => {
  try {
    fn();
  } catch (error) {
    if (types.some((type) => error instanceof type)) return error as Error;
    throw error;
  }
  return null;
};
/** The shared output refusal's code that `fn` is refused with, or null when it returns. */
const outputRefusal = (fn: () => unknown): string | null => {
  const error = declared(fn, OutputRefusal);
  return error instanceof OutputRefusal ? error.code : null;
};

describe('owner-only output: a name Windows reads as another file or a device', () => {
  // The file's scratch directory (above), with the alias folders made in it.
  beforeEach(() => {
    for (const folder of ALIAS_FOLDERS) mkdirSync(path.join(dir, folder));
  });
  const listing = () => readdirSync(dir).sort();

  it("names every form of ROOT's rule by its own closed code, and none of the ordinary names beside them", () => {
    expect(OUTPUT_REFUSALS).toEqual(['output-not-owner-only', 'output-uncheckable', 'output-name-refused']);
    expect(WINDOWS_DEVICE_NAMES).toHaveLength(32);
    for (const file of windowsAliasPaths(dir)) expect(isWindowsAliasName(file), file).toBe(true);
    for (const name of ORDINARY_NAMES) {
      expect(isWindowsAliasName(path.join(dir, name)), name).toBe(false);
      expect(isWindowsAliasName(path.join(dir, 'nul-run', name)), name).toBe(false);
    }
    // A share's names are names on the path too: only a drive root is passed over.
    expect(isWindowsAliasName('\\\\server\\share\\new.json')).toBe(false);
    for (const file of ['\\\\server\\share.\\new.json', '\\\\server\\NUL\\new.json', '\\\\server\\share\\com1.json']) {
      expect(isWindowsAliasName(file), file).toBe(true);
    }
  });

  it.runIf(onWindows)("passes over a drive's own colon, and no other", () => {
    for (const file of ['C:\\new.json', 'c:/new.json', 'C:new.json']) expect(isWindowsAliasName(file), file).toBe(false);
    for (const file of ['C:\\new.json:stream', 'C:\\C:\\new.json', 'C:\\run.\\new.json', 'C:\\new.json\\NUL']) {
      expect(isWindowsAliasName(file), file).toBe(true);
    }
  });

  it.runIf(onWindows)("refuses a share behind the NT namespace prefix, as ROOT's O84 asks, before anything is checked or created", () => {
    // SQLite passes `\??\UNC\server\share\…` on to that share, where Node looks under the current drive. On POSIX the
    // backslash form is one relative name, which a write that the rule let through would make in the working folder:
    // so this test runs on Windows, and the fixture's forward-slash forms hold the prefix to the rule everywhere.
    const before = listing();
    for (const share of ['\\??\\UNC\\server\\share\\x.json', '/??/UNC/server/share/x.json']) {
      expect(isWindowsAliasName(share), share).toBe(true);
      for (const platform of PLATFORMS) {
        const { access, calls } = standIn(platform);
        const written = outputRefusal(() => writeOwnerOnlyNewFile(share, TEXT, access));
        const checked = outputRefusal(() => assertOwnerOnlyDirectory(share, access));
        expect(calls, `${platform} ${share}`).toEqual([]);
        expect(written, `${platform} ${share}`).toBe('output-name-refused');
        expect(checked, `${platform} ${share}`).toBe('output-name-refused');
      }
      expect(existsSync(share), share).toBe(false);
    }
    expect(listing()).toEqual(before);
  });

  it('refuses each form as a new file, on every platform, before anything is checked or created', () => {
    const before = listing();
    for (const platform of PLATFORMS) {
      for (const file of windowsAliasPaths(dir)) {
        const { access, calls } = standIn(platform);
        const code = outputRefusal(() => writeOwnerOnlyNewFile(file, TEXT, access));
        expect(calls, `${platform} ${file}`).toEqual([]);
        expect(code, `${platform} ${file}`).toBe('output-name-refused');
        expect(listing(), `${platform} ${file}`).toEqual(before);
      }
    }
    for (const folder of ALIAS_FOLDERS) expect(readdirSync(path.join(dir, folder)), folder).toEqual([]);
  });

  it('refuses each form as a directory, on every platform, before anything is read', () => {
    for (const platform of PLATFORMS) {
      for (const target of [...ALIAS_FOLDERS.map((folder) => path.join(dir, folder)), ...windowsAliasPaths(dir)]) {
        const { access, calls } = standIn(platform);
        const code = outputRefusal(() => assertOwnerOnlyDirectory(target, access));
        expect(calls, `${platform} ${target}`).toEqual([]);
        expect(code, `${platform} ${target}`).toBe('output-name-refused');
      }
    }
  });

  it('still checks and writes a new file with an ordinary name, and checks an ordinary folder', () => {
    mkdirSync(path.join(dir, 'nul-run'));
    for (const file of [...ORDINARY_NAMES.map((name) => path.join(dir, name)), path.join(dir, 'nul-run', 'new.json')]) {
      const { access, calls } = standIn('win32');
      const code = outputRefusal(() => writeOwnerOnlyNewFile(file, TEXT, access));
      expect(calls, file).toEqual([`acl ${path.basename(file)}`, 'sid']);
      expect(code, file).toBeNull();
      expect(readFileSync(file, 'utf8'), file).toBe(TEXT);
    }
    expect(listing()).toEqual([...ALIAS_FOLDERS, ...ORDINARY_NAMES, 'nul-run'].sort());
    const { access, calls } = standIn('win32');
    const code = outputRefusal(() => assertOwnerOnlyDirectory(path.join(dir, 'nul-run'), access));
    expect(calls).toEqual(['acl nul-run', 'sid']);
    expect(code).toBeNull();
  });
});

/**
 * An elevated (administrator) PowerShell makes Administrators the owner of every file it creates (review finding 23): a
 * new output file is claimed for the current user, by SID, before it is checked; nothing that exists is ever changed.
 */
describe('owner-only output from an elevated shell', () => {
  /**
   * Windows as an elevated shell leaves it: everything Administrators' (or `owner`'s) until `setOwner` gives it away, with
   * every call recorded; `setOwner` is missing or fails when told.
   */
  function elevated(options: { owner?: string; setOwner?: 'missing' | 'fails' } = {}) {
    const calls: string[] = [];
    const owners = new Map<string, string>();
    const aces: WindowsAcl['aces'] = [{ sid: USER_SID, rights: 0x1f01ff, type: 'Allow' }, { sid: SYSTEM_SID, rights: 0x1f01ff, type: 'Allow' },
      { sid: ADMINISTRATORS_SID, rights: 0x1f01ff, type: 'Allow' }];
    const access: OutputAccess = {
      platform: 'win32',
      currentUserSid: () => {
        calls.push('sid');
        return USER_SID;
      },
      readAcls: (paths) => paths.map((target) => {
        calls.push(`acl ${path.basename(target)}`);
        return { owner: owners.get(target) ?? options.owner ?? ADMINISTRATORS_SID, aces, aceTypes: aces.map(() => 'AccessAllowed') };
      }),
      setOwner: options.setOwner === 'missing' ? undefined : (target, sid) => {
        calls.push(`owner ${path.basename(target)} ${sid}`);
        if (options.setOwner === 'fails') throw new Error('synthetic icacls failure');
        owners.set(target, sid);
      },
    };
    return { access, calls };
  }
  const file = () => path.join(dir, 'new.json');

  it('claims a new file for the current user, by SID, then checks and writes it', () => {
    const { access, calls } = elevated();
    expect(outputRefusal(() => writeOwnerOnlyNewFile(file(), TEXT, access))).toBeNull();
    expect(calls).toEqual(['acl new.json', 'sid', `owner new.json ${USER_SID}`, 'acl new.json']);
    expect(readFileSync(file(), 'utf8')).toBe(TEXT);
  });

  it('fails closed, leaving no file, when the owner cannot be changed, and never changes another owner', () => {
    for (const [options, code] of [
      [{ setOwner: 'missing' }, 'output-not-owner-only'],
      [{ setOwner: 'fails' }, 'output-uncheckable'],
      [{ owner: USERS_SID }, 'output-not-owner-only'],
    ] as const) {
      const { access, calls } = elevated(options);
      expect(outputRefusal(() => writeOwnerOnlyNewFile(file(), TEXT, access)), JSON.stringify(options)).toBe(code);
      expect(existsSync(file()), JSON.stringify(options)).toBe(false);
      if ('owner' in options) expect(calls).toEqual(['acl new.json', 'sid']);
    }
  });

  it('never changes a directory: one an elevated shell made is refused as it is', () => {
    const { access, calls } = elevated();
    expect(outputRefusal(() => assertOwnerOnlyDirectory(dir, access))).toBe('output-not-owner-only');
    expect(calls).toEqual([`acl ${path.basename(dir)}`, 'sid']);
  });

  it.runIf(onWindows)('on Windows, for real: a new file in an owner-only folder is the current user\'s, from an elevated shell too', () => {
    const sid = readCurrentUserSid();
    restrictToUser(dir, sid);
    takeOwnership(dir, sid);
    expect(outputRefusal(() => writeOwnerOnlyNewFile(file(), TEXT, platformOutputAccess))).toBeNull();
    expect(readFileSync(file(), 'utf8')).toBe(TEXT);
    expect(readWindowsAcls([file()])[0].owner).toBe(sid);
  }, 60_000);
});
