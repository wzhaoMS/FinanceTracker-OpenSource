/**
 * holdr-retail-convert-owner-only: the retail converter run with its outputs checked owner-only (Root's follow-up of
 * #308, scope (a), 11/09). Stand-ins for the ACL reader, the converter's start, the report's writer and the real-path
 * reader let every rule run without the real ones. The rules take Windows paths, as the command runs on Windows only
 * (Root's Q-W1), so those tests run on Windows only; the platform, --help and pin tests run anywhere. On Windows, one
 * test runs the real converter end to end in a real owner-only folder. Synthetic fixtures only.
 * Every test passes `unexpected: rethrow`: an error that no declared refusal covers leaves unchanged and fails the test
 * as itself, so it can never become data for an assertion (Root's addendum 3(e)). Only the test of the default
 * reporter gives it errors, marked ones; and the test of a real-path failure records what reaches the handler, which
 * must be the one marked error it injected, by identity.
 * Each test asserts first what was started and which ACLs were read, then the refusal and the exit status: a failure
 * shows the run's path before its outcome, which a failure caught on the way could also produce.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, chai, describe, expect, it } from 'vitest';

import {
  syntheticCostcoCapture,
  syntheticMembershipSpec,
  syntheticSensitiveValues,
  type SyntheticCaptureSpec,
} from '@finance-tracker/shared/retail-capture-fixtures';

import { ADMINISTRATORS_SID, readCurrentUserSid, readWindowsAcls, restrictToUser, system32, takeOwnership, type WindowsAcl } from '../e2e/windowsAcl.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';
import { OutputRefusal, ownerOnlyAcl, platformOutputAccess, type OutputAccess } from './ownerOnlyOutput.js';
import { RETAIL_CONVERT_EXIT, runRetailConvertCli } from './retailConvert.js';
import {
  CONVERTER_CWD,
  converterCommand,
  NO_NETWORK_PRELOAD,
  reportUnexpected,
  RETAIL_CONVERT_OWNER_ONLY_EXIT as EXIT,
  RETAIL_CONVERT_OWNER_ONLY_REFUSALS,
  RETAIL_CONVERT_OWNER_ONLY_USAGE,
  RETAIL_CONVERTER_MAIN,
  runRetailConvertOwnerOnlyCli,
  spawnConverter,
  type ConvertSpawner,
  type OwnerOnlySeams,
  type RealPath,
  type ReportWriter,
  type UnexpectedError,
} from './retailConvertOwnerOnly.js';

const PREFIX = 'holdr-retail-convert-owner-only: ';
/** The preload's git blob (Root, 11/09): any change to noNetwork.mjs fails here and needs a reviewed re-pin. */
const NO_NETWORK_PRELOAD_BLOB = '97685bc91ff417c331cc0964473d9b2eb6fcb9f5';
/** The command takes Windows paths only: a test that runs it through paths runs on Windows. */
const onWindows = process.platform === 'win32';

/** A synthetic current user and another one: the shared rule compares SIDs as strings. */
const USER = 'S-synthetic-user';
const OTHER = 'S-synthetic-other';
const ownerOnly = (owner = USER): WindowsAcl => ({ owner, aceTypes: ['AccessAllowed'], aces: [{ sid: owner, rights: 1, type: 'Allow' }] });
const sharedWith = (sid: string): WindowsAcl => ({
  owner: USER,
  aceTypes: ['AccessAllowed', 'AccessAllowed'],
  aces: [{ sid: USER, rights: 1, type: 'Allow' }, { sid, rights: 1, type: 'Allow' }],
});
/** An error a test injects, marked so that a kill classifier can tell it from any other. */
const injected = (message: string) => Object.assign(new Error(message), { marker: 'retail-owner-only-test' });

/**
 * A stand-in Windows ACL reader. It records each path it is asked about, as `name/` for a directory, `name:bytes` for a
 * file and `name:missing` for nothing there, before it can fail. Then it fails for a missing path, as the real reader
 * does, and otherwise gives the ACL set for the base name (owner-only by default) or throws the error set for it.
 */
function fakeAccess(acls: Record<string, WindowsAcl | Error> = {}, platform: NodeJS.Platform = 'win32') {
  const checked: string[] = [];
  const access: OutputAccess = {
    platform,
    currentUserSid: () => USER,
    readAcls: (paths) => paths.map((target) => {
      const name = path.basename(target);
      const stat = statSync(target, { throwIfNoEntry: false });
      checked.push(stat === undefined ? `${name}:missing` : stat.isDirectory() ? `${name}/` : `${name}:${stat.size}`);
      const acl = stat === undefined ? injected('synthetic reader: nothing there') : acls[name] ?? ownerOnly();
      if (acl instanceof Error) throw acl;
      return acl;
    }),
  };
  return { access, checked };
}

const PAYLOAD_TEXT = '{"synthetic":true}\n';
const SHA = 'ab'.repeat(32);

/** The converter's report as it prints it, plus whatever else is given (values the command must never echo). */
function converterReport(written: boolean, extra: Record<string, unknown> = {}) {
  return `${JSON.stringify({
    code: written ? 'retail-converted' : 'retail-held',
    converter: 'holdr-retail-convert 1.4.0',
    receipts: { read: 3, accepted: written ? 3 : 2, held: written ? 0 : 1 },
    sensitive: syntheticSensitiveValues(),
    ...extra,
    payload: { sha256: SHA, bytes: PAYLOAD_TEXT.length, written },
  }, null, 2)}\n`;
}

/** What the stand-in converter does: its status, signal or start failure, its stdout, and what it leaves at --out. */
interface Behaviour {
  status?: number | null;
  signal?: string | null;
  error?: Error;
  stdout?: string;
  /** At the payload's path: a file (the default), nothing, a directory, or a junction to `junctionTarget`. */
  leaves?: 'file' | 'nothing' | 'dir' | 'junction';
}

/**
 * A stand-in for the converter's start: it records the command, then behaves as told. Like the converter, it refuses an
 * --out that already exists: a usage error, with nothing written.
 */
function fakeConverter(behaviour: Behaviour = {}, junctionTarget = '') {
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  const spawn: ConvertSpawner = (file, args, cwd) => {
    calls.push({ file, args: [...args], cwd });
    const at = args.indexOf('--out');
    const out = at < 0 ? undefined : args[at + 1];
    if (out !== undefined && lstatSync(out, { throwIfNoEntry: false })) return { status: RETAIL_CONVERT_EXIT.usage, signal: null, stdout: '' };
    const leaves = behaviour.leaves ?? 'file';
    if (out !== undefined && leaves === 'file') writeFileSync(out, PAYLOAD_TEXT, { flag: 'wx' });
    if (out !== undefined && leaves === 'dir') mkdirSync(out);
    if (out !== undefined && leaves === 'junction') symlinkSync(junctionTarget, out, 'junction');
    return {
      status: behaviour.status === undefined ? 0 : behaviour.status,
      signal: behaviour.signal ?? null,
      stdout: behaviour.stdout ?? converterReport(out !== undefined),
      error: behaviour.error,
    };
  };
  return { spawn, calls };
}

/** A stand-in report writer: it records what it is asked to write, then refuses with the error given, writing nothing. */
function fakeWriter(error: Error) {
  const writes: Array<{ file: string; text: string }> = [];
  const write: ReportWriter = (file, text) => {
    writes.push({ file, text });
    throw error;
  };
  return { write, writes };
}

/** Errors no declared refusal covers leave unchanged (Root's addendum 3(e)). */
const rethrow: UnexpectedError = (error) => {
  throw error;
};

function run(argv: string[], seams: Partial<OwnerOnlySeams>) {
  const out = { stdout: '', stderr: '' };
  const io = { stdout: { write: (text: string) => (out.stdout += text) }, stderr: { write: (text: string) => (out.stderr += text) } };
  const status = runRetailConvertOwnerOnlyCli(argv, io, { unexpected: rethrow, ...seams });
  return { status, ...out };
}

/** The command's one stdout line, with the converter's facts as given. */
function summary(converterExit: number, facts: { converter: string | null; receipts: unknown; payload: unknown }, report: boolean) {
  return `${JSON.stringify({ code: 'retail-convert-owner-only', converterExit, converter: facts.converter, receipts: facts.receipts, payload: facts.payload, report })}\n`;
}

/** A capture as the pull lays it out, with a manifest of every file (retailConvert.test.ts writes the same layout). */
function writeCapture(root: string, spec: SyntheticCaptureSpec) {
  const folderName = spec.folder ?? 'costco';
  const capture = syntheticCostcoCapture(spec);
  const folder = path.join(root, folderName);
  mkdirSync(path.join(folder, 'raw', 'receipts'), { recursive: true });
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const write = (relative: string, json: unknown) => {
    const text = JSON.stringify(json);
    writeFileSync(path.join(root, relative), text);
    files.push({ path: relative, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
  };
  write(path.join(folderName, 'costco.json'), capture.consolidated);
  capture.rawReceipts.forEach((file, index) => write(path.join(folderName, 'raw', 'receipts', `receipt-${String(index).padStart(16, 'a')}.json`), file.json));
  capture.rawDetails.forEach((file) => write(path.join(folderName, 'raw', file.name), file.json));
  const manifest = path.join(root, 'manifest.private.json');
  // The converter reads only the manifest's files.
  writeFileSync(manifest, JSON.stringify({ lane: 'synthetic', root: 'synthetic', files }));
  return { folder, manifest };
}

describe('holdr-retail-convert-owner-only', () => {
  let scratch: string;
  let root: string;
  let runDir: string;
  let captures: string;
  let folder: string;
  let manifest: string;
  /** Folders a test made outside the scratch directory, removed after it whatever happened. */
  const extraDirs: string[] = [];
  beforeEach(async () => {
    scratch = await makeScratchDir('retail-owner-only-');
    // The real path, so that no junction above the scratch directory reads as a link on the way to the run folder.
    root = realpathSync.native(scratch);
    runDir = path.join(root, 'run');
    captures = path.join(root, 'captures');
    folder = path.join(captures, 'costco');
    manifest = path.join(captures, 'manifest.private.json');
    mkdirSync(runDir);
    mkdirSync(folder, { recursive: true });
    writeFileSync(manifest, '{}');
  });
  afterEach(async () => { await removeScratchDir(scratch); for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
  // Failure messages show values whole (chai cuts them at 40 characters by default), so that a kill classifier can read
  // each failure's actual and expected exactly. Restored after this file.
  const truncateThreshold = chai.config.truncateThreshold;
  beforeAll(() => { chai.config.truncateThreshold = 0; });
  afterAll(() => { chai.config.truncateThreshold = truncateThreshold; });

  const payload = () => path.join(runDir, 'payload.json');
  const report = () => path.join(runDir, 'report.json');
  const convertArgs = () => ['--folder', folder, '--manifest', manifest, '--out', payload(), '--report', report()];
  const dryRunArgs = () => ['--folder', folder, '--manifest', manifest, '--dry-run', '--report', report()];
  const runEntries = () => readdirSync(runDir).sort();
  const firstLine = (text: string) => text.split('\n')[0];
  /** The converter's own arguments: what follows this Node's options and the converter's entry point. */
  const converterArgs = (calls: Array<{ args: string[] }>) => calls.map((call) => call.args.slice(5));
  const written = { converter: 'retail-converted', receipts: { read: 3, accepted: 3, held: 0 }, payload: { written: true, sha256: SHA, bytes: PAYLOAD_TEXT.length } };

  it('refuses every platform but Windows before anything is read or started', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { spawn, calls } = fakeConverter();
      const { access, checked } = fakeAccess({}, platform);
      // The run folder doesn't exist: had anything been checked first, the refusal would name that.
      const result = run(['--folder', folder, '--manifest', manifest, '--dry-run', '--report', path.join(root, 'missing', 'report.json')], { access, spawn });
      expect(calls, platform).toHaveLength(0);
      expect(checked, platform).toHaveLength(0);
      expect(result.stderr, platform).toBe(`${PREFIX}output-uncheckable (Windows only)\n`);
      expect(result.status, platform).toBe(EXIT.usage);
      expect(result.stdout, platform).toBe('');
    }
  });

  it('prints its usage for --help, and checks and starts nothing', () => {
    const { spawn, calls } = fakeConverter();
    const { access, checked } = fakeAccess();
    const result = run(['--help'], { access, spawn });
    expect(calls).toHaveLength(0);
    expect(checked).toHaveLength(0);
    expect(result.stdout).toBe(RETAIL_CONVERT_OWNER_ONLY_USAGE);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(EXIT.ok);
  });

  it.runIf(onWindows)('refuses usage errors before it checks or starts anything', () => {
    writeFileSync(path.join(runDir, 'taken.json'), '{}');
    const other = path.join(root, 'other');
    mkdirSync(other);
    writeFileSync(path.join(other, 'manifest.json'), '{}');
    const target = path.join(root, 'target');
    mkdirSync(target);
    const linked = path.join(root, 'linked');
    symlinkSync(target, linked, 'junction');
    // A link at a capture path itself (lstat reads a junction as one; a file symlink would need a privilege).
    const folderLink = path.join(root, 'folder-link');
    symlinkSync(folder, folderLink, 'junction');
    const manifestLink = path.join(root, 'manifest-link');
    symlinkSync(folder, manifestLink, 'junction');
    const local = (name: string) => `${name} must be a full path on a local drive, like C:\\folder\\file`;
    const outside = '--report must be outside the capture folder and the folder of its manifest';
    // A relative or drive-relative path names a folder that doesn't exist, so even a broken check could write nothing.
    const cases: Array<[string[], string]> = [
      [['--folder', folder, '--manifest', manifest, '--dry-run'], 'give --report NEW_FILE'],
      [[...dryRunArgs(), '--report'], '--report needs a value'],
      [['--folder', folder, '--manifest', '--dry-run', '--report', report()], '--manifest needs a value'],
      [[...dryRunArgs(), '--report', report()], '--report is given twice'],
      [[...dryRunArgs(), '--dry-run'], '--dry-run is given twice'],
      [[...dryRunArgs(), '--bogus'], 'unknown option'],
      [[...dryRunArgs(), 'extra'], 'unexpected argument'],
      [['--folder', folder, '--manifest', manifest, '--dry-run', '--report', path.join('no-such-folder', 'report.json')], local('--report')],
      [['--folder', 'costco', '--manifest', manifest, '--dry-run', '--report', report()], local('--folder')],
      [['--folder', folder, '--manifest', manifest, '--dry-run', '--report', 'C:no-such-folder\\report.json'], local('--report')],
      [['--folder', folder, '--manifest', manifest, '--dry-run', '--report', '\\no-such-folder\\report.json'], local('--report')],
      [['--folder', folder, '--manifest', manifest, '--out', `${payload()}:stream`, '--report', report()], local('--out')],
      [['--folder', folder, '--manifest', manifest, '--dry-run', '--report', `${report()}:stream`], local('--report')],
      [['--folder', '\\\\localhost\\no-such-share\\costco', '--manifest', manifest, '--dry-run', '--report', report()], local('--folder')],
      [['--folder', folder, '--manifest', '//localhost/no-such-share/manifest.json', '--dry-run', '--report', report()], local('--manifest')],
      [['--folder', folder, '--manifest', `\\\\?\\${manifest}`, '--dry-run', '--report', report()], local('--manifest')],
      [['--folder', folder, '--manifest', manifest, '--dry-run', '--report', `\\\\.\\${report()}`], local('--report')],
      [['--folder', folder, '--manifest', manifest, '--out', path.join(other, 'payload.json'), '--report', report()], '--out and --report go in one folder'],
      [['--folder', folder, '--manifest', manifest, '--out', report(), '--report', report()], '--out and --report must be two files'],
      [['--folder', folder, '--manifest', manifest, '--dry-run', '--report', path.join(linked, 'report.json')], 'the folder of --report must be an existing directory, not a link'],
      [['--folder', folder, '--manifest', manifest, '--dry-run', '--report', path.join(root, 'missing', 'report.json')], 'the folder of --report must be an existing directory, not a link'],
      [['--folder', folder, '--manifest', manifest, '--out', path.join(runDir, 'taken.json'), '--report', report()], '--out already exists; name a new file'],
      [['--folder', folder, '--manifest', manifest, '--dry-run', '--report', path.join(runDir, 'taken.json')], '--report already exists; name a new file'],
      [['--folder', folderLink, '--manifest', manifest, '--dry-run', '--report', report()], '--folder must not be a link'],
      [['--folder', folder, '--manifest', manifestLink, '--dry-run', '--report', report()], '--manifest must not be a link'],
      [['--folder', path.join(captures, 'costco-9'), '--manifest', manifest, '--dry-run', '--report', report()], '--folder must exist'],
      [['--folder', folder, '--manifest', path.join(captures, 'missing.json'), '--dry-run', '--report', report()], '--manifest must exist'],
      [['--folder', folder, '--manifest', manifest, '--dry-run', '--report', path.join(folder, 'report.json')], outside],
      [['--folder', folder, '--manifest', path.join(other, 'manifest.json'), '--dry-run', '--report', path.join(folder, 'report.json')], outside],
      [['--folder', folder, '--manifest', manifest, '--dry-run', '--report', path.join(captures, 'report.json')], outside],
    ];
    for (const [argv, message] of cases) {
      // Were a case let through, this stand-in converter would print nothing, write nothing and exit 1.
      const { spawn, calls } = fakeConverter({ status: 1, stdout: '', leaves: 'nothing' });
      const { access, checked } = fakeAccess();
      const result = run(argv, { access, spawn });
      expect(calls, message).toHaveLength(0);
      expect(checked, message).toHaveLength(0);
      expect(firstLine(result.stderr), message).toBe(`${PREFIX}${message}`);
      expect(result.status, message).toBe(EXIT.usage);
      expect(result.stdout, message).toBe('');
    }
    expect(runEntries()).toEqual(['taken.json']);
    expect(readdirSync(folder)).toEqual([]);
    expect(readdirSync(captures).sort()).toEqual(['costco', 'manifest.private.json']);
    expect(readdirSync(other)).toEqual(['manifest.json']);
  });

  it.runIf(onWindows)('refuses an output path with a name Windows reads as another file or a device, before it checks or starts anything', () => {
    // Each form on each output, the run folder's name included: a trailing dot or space, and a device name in any case,
    // with or without extensions, with a space before one. A colon, `\\?\` and `\\.\` meet the local-path rule first
    // (the usage errors above). The shared module's own tests hold every form to the rule.
    const reportAt = (file: string) => ['--folder', folder, '--manifest', manifest, '--dry-run', '--report', file];
    const outAt = (file: string) => ['--folder', folder, '--manifest', manifest, '--out', file, '--report', report()];
    const cases: Array<[string, string[]]> = [
      ['--report ending in a dot', reportAt(`${report()}.`)],
      ['--report ending in a space', reportAt(`${report()} `)],
      ['--report named NUL, in mixed case', reportAt(path.join(runDir, 'nUl'))],
      ['--report named CON, with an extension', reportAt(path.join(runDir, 'CON.json'))],
      ['--report named CONIN$, a space before two extensions', reportAt(path.join(runDir, 'Conin$ .tar.gz'))],
      ['--report named LPT with a superscript 3', reportAt(path.join(runDir, 'lpt\u00B3.json'))],
      ['--report in a run folder ending in a dot', reportAt(path.join(`${runDir}.`, 'report.json'))],
      ['--report in a run folder named COM0', reportAt(path.join(root, 'COM0', 'report.json'))],
      ['--out ending in a dot', outAt(`${payload()}.`)],
      ['--out ending in a space', outAt(`${payload()} `)],
      ['--out named AUX', outAt(path.join(runDir, 'aux'))],
      ['--out named PRN, with an extension', outAt(path.join(runDir, 'PRN.json'))],
      ['--out named CONOUT$', outAt(path.join(runDir, 'conout$.json'))],
      ['--out named COM with a superscript 1, a space before its extension', outAt(path.join(runDir, 'Com\u00B9 .json'))],
      ['--out named LPT9, with two extensions', outAt(path.join(runDir, 'LPT9.tar.gz'))],
      ['--out in a folder ending in a space', outAt(path.join(`${runDir} `, 'payload.json'))],
    ];
    for (const [what, argv] of cases) {
      // Were a case let through, this stand-in converter would print nothing, write nothing and exit 0.
      const { spawn, calls } = fakeConverter({ status: 0, stdout: '', leaves: 'nothing' });
      const { access, checked } = fakeAccess();
      const result = run(argv, { access, spawn });
      expect(calls, what).toHaveLength(0);
      expect(checked, what).toHaveLength(0);
      expect(result.stderr, what).toBe(`${PREFIX}output-name-refused\n`);
      expect(result.status, what).toBe(EXIT.refused);
      expect(result.stdout, what).toBe('');
    }
    expect(runEntries()).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(['captures', 'run']);
  });

  it.runIf(onWindows)('resolves each path once, takes the capture paths by their real paths, and gives the converter the very paths it checked', () => {
    // The captures reached through a junction: the converter gets their real paths, with no link on the way.
    const via = path.join(root, 'via-captures');
    symlinkSync(captures, via, 'junction');
    const { spawn, calls } = fakeConverter();
    const { access, checked } = fakeAccess();
    const forward = (file: string) => file.replace(/\\/g, '/');
    const argv = ['--folder', `${via}\\costco\\sub\\..`, '--manifest', forward(path.join(via, 'manifest.private.json')), '--out', `${runDir}\\.\\payload.json`, '--report', `${forward(runDir)}/sub/../report.json`];
    const result = run(argv, { access, spawn });
    expect(converterArgs(calls)).toEqual([['--folder', folder, '--manifest', manifest, '--out', payload()]]);
    expect(checked).toEqual(['run/', `payload.json:${PAYLOAD_TEXT.length}`, 'report.json:0']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(EXIT.ok);
    expect(runEntries()).toEqual(['payload.json', 'report.json']);
  });

  it.runIf(onWindows)('refuses a capture folder or manifest whose real path is off the local drives, before it checks or starts anything', () => {
    // A link to a share resolves to \\server\share\…. Resolving one here would contact the share, so a real-path
    // stand-in answers for the linked path as Windows does, and passes every other path to the real reader.
    const shares: Array<[string, string, string]> = [
      ['--folder', folder, '\\\\server\\share\\costco'],
      ['--manifest', manifest, '\\\\server\\share\\manifest.private.json'],
    ];
    for (const [name, linked, share] of shares) {
      const { spawn, calls } = fakeConverter();
      const { access, checked } = fakeAccess();
      const realPath: RealPath = (file) => (file === linked ? share : realpathSync.native(file));
      const result = run(dryRunArgs(), { access, spawn, realPath });
      expect(calls, name).toHaveLength(0);
      expect(checked, name).toHaveLength(0);
      expect(result.stderr, name).toBe(`${PREFIX}${name} must lead to a local drive, not to a share\n`);
      expect(result.status, name).toBe(EXIT.usage);
      expect(result.stdout, name).toBe('');
    }
    expect(runEntries()).toEqual([]);
  });

  it.runIf(onWindows)('takes only ENOENT from the real-path reader as a missing capture path: any other failure is unexpected, before it checks or starts anything', () => {
    for (const [name, given] of [['--folder', folder], ['--manifest', manifest]] as const) {
      // The reader fails for this path alone, as an unreachable share might: not with ENOENT, so not "must exist".
      const failure = Object.assign(injected('synthetic realpath failure'), { code: 'EACCES' });
      const realPath: RealPath = (file) => {
        if (file === given) throw failure;
        return realpathSync.native(file);
      };
      // A recording handler, in place of rethrow: it keeps what reached it and answers with a status of its own.
      const reached: unknown[] = [];
      const unexpected: UnexpectedError = (error) => {
        reached.push(error);
        return 113;
      };
      const { spawn, calls } = fakeConverter();
      const { access, checked } = fakeAccess();
      const result = run(dryRunArgs(), { access, spawn, realPath, unexpected });
      expect(calls, name).toHaveLength(0);
      expect(checked, name).toHaveLength(0);
      expect(reached, name).toHaveLength(1);
      expect(reached[0], name).toBe(failure);
      expect(result.status, name).toBe(113);
      expect(result.stderr, name).toBe('');
      expect(result.stdout, name).toBe('');
    }
    expect(runEntries()).toEqual([]);
  });

  it.runIf(onWindows)('refuses an unsafe run folder before the converter starts', () => {
    const unsafe: Array<[string, WindowsAcl | Error, string]> = [
      ['another user may read it', sharedWith(OTHER), 'output-not-owner-only'],
      ['another user owns it', ownerOnly(OTHER), 'output-not-owner-only'],
      ['it has no DACL, which lets everyone in', { owner: USER, aceTypes: null, aces: [] }, 'output-not-owner-only'],
      ['its ACL cannot be read', injected('synthetic reader failure'), 'output-uncheckable'],
    ];
    for (const [what, acl, code] of unsafe) {
      const { spawn, calls } = fakeConverter();
      const { access, checked } = fakeAccess({ run: acl });
      const result = run(convertArgs(), { access, spawn });
      expect(calls, what).toHaveLength(0);
      expect(checked, what).toEqual(['run/']);
      expect(result.stderr, what).toBe(`${PREFIX}${code}\n`);
      expect(result.status, what).toBe(EXIT.refused);
      expect(result.stdout, what).toBe('');
      expect(runEntries(), what).toEqual([]);
    }
  });

  it.runIf(onWindows)('refuses a run folder reached through a junction on the way, before the converter starts', () => {
    const target = path.join(root, 'target');
    mkdirSync(path.join(target, 'run'), { recursive: true });
    const via = path.join(root, 'via');
    symlinkSync(target, via, 'junction');
    const { spawn, calls } = fakeConverter();
    const { access, checked } = fakeAccess();
    const result = run(['--folder', folder, '--manifest', manifest, '--dry-run', '--report', path.join(via, 'run', 'report.json')], { access, spawn });
    expect(calls).toHaveLength(0);
    expect(checked).toHaveLength(0);
    expect(result.stderr).toBe(`${PREFIX}output-uncheckable\n`);
    expect(result.status).toBe(EXIT.refused);
    expect(readdirSync(path.join(target, 'run'))).toEqual([]);
  });

  it.runIf(onWindows)('starts the converter as this Node, tsx and the no-network preload, with its own options in their order and no --report', () => {
    const { spawn, calls } = fakeConverter();
    const { access } = fakeAccess();
    const argv = ['--report', report(), '--folder', folder, '--skip-held', '--manifest', manifest, '--out', payload()];
    const head = ['--import', 'tsx', '--import', pathToFileURL(NO_NETWORK_PRELOAD).href, RETAIL_CONVERTER_MAIN];
    expect(run(argv, { access, spawn }).status).toBe(EXIT.ok);
    expect(calls).toEqual([{ file: process.execPath, args: [...head, '--folder', folder, '--skip-held', '--manifest', manifest, '--out', payload()], cwd: CONVERTER_CWD }]);
    expect(converterCommand(['--dry-run'])).toEqual({ file: process.execPath, args: [...head, '--dry-run'], cwd: CONVERTER_CWD });
    expect(path.relative(CONVERTER_CWD, RETAIL_CONVERTER_MAIN).split(path.sep)).toEqual(['src', 'cli', 'retailConvertMain.ts']);
    expect(path.relative(CONVERTER_CWD, NO_NETWORK_PRELOAD).split(path.sep)).toEqual(['..', '..', 'packages', 'shared', 'src', 'cardImportTool', 'testing', 'noNetwork.mjs']);
    expect(existsSync(RETAIL_CONVERTER_MAIN)).toBe(true);
    expect(existsSync(NO_NETWORK_PRELOAD)).toBe(true);
  });

  it.runIf(onWindows)('writes both outputs: the payload checked after the converter, then the report through the shared module', () => {
    const stdout = converterReport(true);
    const { spawn } = fakeConverter({ stdout });
    const { access, checked } = fakeAccess();
    const result = run(convertArgs(), { access, spawn });
    expect(checked).toEqual(['run/', `payload.json:${PAYLOAD_TEXT.length}`, 'report.json:0']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(EXIT.ok);
    expect(readFileSync(payload(), 'utf8')).toBe(PAYLOAD_TEXT);
    expect(readFileSync(report(), 'utf8')).toBe(stdout);
    expect(result.stdout).toBe(summary(0, written, true));
  });

  it.runIf(onWindows)("keeps the converter's status when it holds records: the report, no payload, exit 1", () => {
    const stdout = converterReport(false);
    const { spawn } = fakeConverter({ status: 1, stdout, leaves: 'nothing' });
    const { access, checked } = fakeAccess();
    const result = run(convertArgs(), { access, spawn });
    expect(checked).toEqual(['run/', 'report.json:0']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(EXIT.refused);
    expect(runEntries()).toEqual(['report.json']);
    expect(readFileSync(report(), 'utf8')).toBe(stdout);
    expect(result.stdout).toBe(summary(1, {
      converter: 'retail-held', receipts: { read: 3, accepted: 2, held: 1 }, payload: { written: false, sha256: SHA, bytes: PAYLOAD_TEXT.length },
    }, true));
  });

  it.runIf(onWindows)("keeps the converter's status on its usage error: neither output, exit 64", () => {
    const { spawn } = fakeConverter({ status: RETAIL_CONVERT_EXIT.usage, stdout: '', leaves: 'nothing' });
    const { access, checked } = fakeAccess();
    const result = run(convertArgs(), { access, spawn });
    expect(checked).toEqual(['run/']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(EXIT.usage);
    expect(runEntries()).toEqual([]);
    expect(result.stdout).toBe(summary(RETAIL_CONVERT_EXIT.usage, { converter: null, receipts: null, payload: null }, false));
  });

  it.runIf(onWindows)('dry-runs with the report only', () => {
    const stdout = `${JSON.stringify({ code: 'retail-convert-dry-run', receipts: { read: 3, accepted: 3, held: 0 }, payload: { sha256: SHA, bytes: 7, written: false } })}\n`;
    const { spawn, calls } = fakeConverter({ stdout });
    const { access, checked } = fakeAccess();
    const result = run(dryRunArgs(), { access, spawn });
    expect(converterArgs(calls)).toEqual([['--folder', folder, '--manifest', manifest, '--dry-run']]);
    expect(checked).toEqual(['run/', 'report.json:0']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(EXIT.ok);
    expect(runEntries()).toEqual(['report.json']);
    expect(result.stdout).toBe(summary(0, {
      converter: 'retail-convert-dry-run', receipts: { read: 3, accepted: 3, held: 0 }, payload: { written: false, sha256: SHA, bytes: 7 },
    }, true));
  });

  it.runIf(onWindows)("keeps only the report's facts of their own type", () => {
    const stdout = `${JSON.stringify({ code: 'not-a-code', receipts: { read: -1, accepted: 1.5, held: '0' }, payload: { sha256: 'AB', bytes: -2, written: 'yes' } })}\n`;
    const { spawn } = fakeConverter({ stdout, leaves: 'nothing' });
    const { access } = fakeAccess();
    const result = run(convertArgs(), { access, spawn });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(EXIT.ok);
    expect(result.stdout).toBe(summary(0, {
      converter: null, receipts: { read: null, accepted: null, held: null }, payload: { written: null, sha256: null, bytes: null },
    }, true));
  });

  it.runIf(onWindows)('removes a payload that fails its check, and writes no report', () => {
    const unsafe: Array<[string, WindowsAcl | Error, string]> = [
      ['someone else may read it', sharedWith(OTHER), 'output-not-owner-only'],
      ['its ACL cannot be read', injected('synthetic reader failure'), 'output-uncheckable'],
    ];
    for (const [what, acl, code] of unsafe) {
      const { spawn } = fakeConverter({ stdout: converterReport(true) });
      const { access, checked } = fakeAccess({ 'payload.json': acl });
      const result = run(convertArgs(), { access, spawn });
      expect(checked, what).toEqual(['run/', `payload.json:${PAYLOAD_TEXT.length}`]);
      expect(result.stderr, what).toBe(`${PREFIX}${code}\n`);
      expect(result.status, what).toBe(EXIT.refused);
      expect(result.stdout, what).toBe('');
      expect(runEntries(), what).toEqual([]);
    }
  });

  it.runIf(onWindows)('claims both outputs for the current user when an elevated shell made Administrators their owner, or keeps neither', () => {
    for (const canClaim of [false, true]) {
      const owners = new Map<string, string>();
      const claimed: string[] = [];
      const { spawn } = fakeConverter({ stdout: converterReport(true) });
      const { access } = fakeAccess();
      // As an elevated shell leaves them: the run folder is the user's own, and a new file Administrators' until claimed.
      const elevated: OutputAccess = {
        ...access,
        readAcls: (paths) => access.readAcls(paths).map((acl, index) => (statSync(paths[index]).isDirectory() ? acl
          : { ...acl, owner: owners.get(paths[index]) ?? ADMINISTRATORS_SID })),
        setOwner: canClaim ? (file, sid) => { claimed.push(`${path.basename(file)} ${sid}`); owners.set(file, sid); } : undefined,
      };
      const result = run(convertArgs(), { access: elevated, spawn });
      if (!canClaim) {
        expect(result.stderr).toBe(`${PREFIX}output-not-owner-only\n`);
        expect(result.status).toBe(EXIT.refused);
        expect(runEntries()).toEqual([]);
        continue;
      }
      expect(claimed).toEqual([`payload.json ${USER}`, `report.json ${USER}`]);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(EXIT.ok);
      expect(runEntries()).toEqual(['payload.json', 'report.json']);
    }
  });

  it.runIf(onWindows)("never follows or removes a directory or junction left at the payload's path, and writes no report", () => {
    const target = path.join(root, 'elsewhere');
    mkdirSync(target);
    writeFileSync(path.join(target, 'keep.txt'), 'keep');
    for (const leaves of ['dir', 'junction'] as const) {
      // A run folder of its own for each, so that one's leftover isn't in the other's way.
      const dir = path.join(root, `run-${leaves}`);
      mkdirSync(dir);
      const out = path.join(dir, 'payload.json');
      const { spawn } = fakeConverter({ stdout: converterReport(true), leaves }, target);
      const { access, checked } = fakeAccess();
      const result = run(['--folder', folder, '--manifest', manifest, '--out', out, '--report', path.join(dir, 'report.json')], { access, spawn });
      expect(checked, leaves).toEqual([`run-${leaves}/`]);
      expect(result.stderr, leaves).toBe(`${PREFIX}output-uncheckable\n`);
      expect(result.status, leaves).toBe(EXIT.refused);
      expect(result.stdout, leaves).toBe('');
      expect(readdirSync(dir), leaves).toEqual(['payload.json']);
      expect(lstatSync(out).isSymbolicLink(), leaves).toBe(leaves === 'junction');
      expect(readdirSync(target), leaves).toEqual(['keep.txt']);
    }
  });

  it.runIf(onWindows)("removes a payload the converter doesn't vouch for, and writes no report", () => {
    const unvouched: Array<[string, Behaviour]> = [
      ['it says it wrote none', { stdout: converterReport(false) }],
      ['it printed no report', { stdout: '' }],
    ];
    for (const [what, behaviour] of unvouched) {
      const { spawn } = fakeConverter(behaviour);
      const { access, checked } = fakeAccess();
      const result = run(convertArgs(), { access, spawn });
      expect(checked, what).toEqual(['run/', `payload.json:${PAYLOAD_TEXT.length}`]);
      expect(result.stderr, what).toBe(`${PREFIX}retail-convert-output-mismatch\n`);
      expect(result.status, what).toBe(EXIT.refused);
      expect(result.stdout, what).toBe('');
      expect(runEntries(), what).toEqual([]);
    }
  });

  it.runIf(onWindows)("refuses the converter's word for a payload it didn't write, and writes no report", () => {
    const { spawn } = fakeConverter({ stdout: converterReport(true), leaves: 'nothing' });
    const { access, checked } = fakeAccess();
    const result = run(convertArgs(), { access, spawn });
    expect(checked).toEqual(['run/']);
    expect(result.stderr).toBe(`${PREFIX}retail-convert-output-mismatch\n`);
    expect(result.status).toBe(EXIT.refused);
    expect(result.stdout).toBe('');
    expect(runEntries()).toEqual([]);
  });

  it.runIf(onWindows)('stops when the converter fails, leaving no payload and no report', () => {
    const failures: Array<[string, Behaviour]> = [
      ['it cannot start', { status: null, error: injected('synthetic start failure'), stdout: '', leaves: 'nothing' }],
      ['a signal ends it', { status: null, signal: 'SIGTERM', stdout: '' }],
      ['it exits with a status of its own', { status: 3, stdout: converterReport(true) }],
      ['its start reports an error beside a normal status', { status: 0, error: injected('synthetic start failure'), stdout: converterReport(true) }],
    ];
    for (const [what, behaviour] of failures) {
      const { spawn } = fakeConverter(behaviour);
      const { access, checked } = fakeAccess();
      const result = run(convertArgs(), { access, spawn });
      expect(checked, what).toEqual(behaviour.leaves === 'nothing' ? ['run/'] : ['run/', `payload.json:${PAYLOAD_TEXT.length}`]);
      expect(result.stderr, what).toBe(`${PREFIX}retail-convert-child-failed\n`);
      expect(result.status, what).toBe(EXIT.refused);
      expect(result.stdout, what).toBe('');
      expect(runEntries(), what).toEqual([]);
    }
  });

  it.runIf(onWindows)('removes the payload when its report cannot be written, so a refused run leaves no output', () => {
    for (const code of ['output-not-owner-only', 'output-uncheckable'] as const) {
      const stdout = converterReport(true);
      const { spawn } = fakeConverter({ stdout });
      const { access, checked } = fakeAccess();
      const { write, writes } = fakeWriter(new OutputRefusal(code));
      const result = run(convertArgs(), { access, spawn, write });
      expect(writes, code).toEqual([{ file: report(), text: stdout }]);
      expect(checked, code).toEqual(['run/', `payload.json:${PAYLOAD_TEXT.length}`]);
      expect(result.stderr, code).toBe(`${PREFIX}${code}\n`);
      expect(result.status, code).toBe(EXIT.refused);
      expect(result.stdout, code).toBe('');
      expect(runEntries(), code).toEqual([]);
    }
    // Then through the shared writer, refusing the report's own check: by the rule, or as unreadable.
    const shared: Array<[WindowsAcl | Error, string]> = [
      [sharedWith(OTHER), 'output-not-owner-only'],
      [injected('synthetic reader failure'), 'output-uncheckable'],
    ];
    for (const [acl, refusal] of shared) {
      const { spawn } = fakeConverter({ stdout: converterReport(true) });
      const { access, checked } = fakeAccess({ 'report.json': acl });
      const result = run(convertArgs(), { access, spawn });
      expect(checked, refusal).toEqual(['run/', `payload.json:${PAYLOAD_TEXT.length}`, 'report.json:0']);
      expect(result.stderr, refusal).toBe(`${PREFIX}${refusal}\n`);
      expect(result.status, refusal).toBe(EXIT.refused);
      expect(result.stdout, refusal).toBe('');
      expect(runEntries(), refusal).toEqual([]);
    }
  });

  it.runIf(onWindows)('prints codes, counts and digests only: no synthetic value, path or date from the report', () => {
    const stdout = converterReport(true, { folder: root, dates: { first: 'SENTINEL-DATE-FIRST', last: 'SENTINEL-DATE-LAST' } });
    const { spawn } = fakeConverter({ stdout });
    const { access } = fakeAccess();
    const result = run(convertArgs(), { access, spawn });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(EXIT.ok);
    for (const value of [...syntheticSensitiveValues(), root, 'SENTINEL-DATE-FIRST', 'SENTINEL-DATE-LAST', 'holdr-retail-convert 1.4.0']) {
      expect(result.stdout, value).not.toContain(value);
    }
    expect(result.stdout).toBe(summary(0, written, true));
  });

  it.runIf(onWindows)('by default, reports an unexpected error by its file system code or its type only, naming no path', () => {
    const marked = <E extends Error>(error: E) => Object.assign(error, { marker: 'retail-owner-only-test' });
    const reported = (error: unknown) => {
      let stderr = '';
      const status = reportUnexpected(error, { stdout: { write: () => true }, stderr: { write: (text: string) => (stderr += text) } });
      return { status, stderr };
    };
    expect(reported(marked(new TypeError(`synthetic failure at ${root}`)))).toEqual({ status: EXIT.refused, stderr: `${PREFIX}failed (TypeError)\n` });
    expect(reported(Object.assign(marked(new Error(`synthetic failure at ${root}`)), { code: 'EACCES' }))).toEqual({ status: EXIT.refused, stderr: `${PREFIX}failed (EACCES)\n` });
    expect(reported(Object.assign(marked(new Error('synthetic failure')), { code: `E${root}` }))).toEqual({ status: EXIT.refused, stderr: `${PREFIX}failed (Error)\n` });
    expect(reported('synthetic failure')).toEqual({ status: EXIT.refused, stderr: `${PREFIX}failed (error)\n` });
    // It is the default: a failure that no refusal covers, here from a stand-in start, leaves through it.
    const throwing: ConvertSpawner = () => {
      throw marked(new TypeError(`synthetic failure at ${root}`));
    };
    let stderr = '';
    const { access } = fakeAccess();
    const status = runRetailConvertOwnerOnlyCli(convertArgs(), { stdout: { write: () => true }, stderr: { write: (text: string) => (stderr += text) } }, { access, spawn: throwing });
    expect({ status, stderr }).toEqual({ status: EXIT.refused, stderr: `${PREFIX}failed (TypeError)\n` });
    expect(runEntries()).toEqual([]);
  });

  it('pins its imports, its one child start, and the preload it runs the converter under', () => {
    const runtime = /^\s*(?:import|export)\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    const imports = (file: string) => [...source(file).matchAll(runtime)].map((match) => match[1] ?? match[2]).sort();
    expect(imports('./retailConvertOwnerOnly.ts')).toEqual(['./ownerOnlyOutput.js', 'node:child_process', 'node:fs', 'node:path', 'node:url']);
    expect(imports('./retailConvertOwnerOnlyMain.ts')).toEqual(['./retailConvertOwnerOnly.js']);
    expect(RETAIL_CONVERT_OWNER_ONLY_REFUSALS).toEqual(['retail-convert-child-failed', 'retail-convert-output-mismatch']);
    const wrapper = source('./retailConvertOwnerOnly.ts');
    expect(wrapper).toContain("import { spawnSync } from 'node:child_process';");
    expect(wrapper.match(/\bspawnSync\(/g)).toHaveLength(1);
    expect(wrapper).toContain("cwd, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 2 ** 28, stdio: ['ignore', 'pipe', 'inherit'],");
    expect(wrapper).not.toMatch(/\bexecSync\b|\bexec\(|\bexecFile|\bfork\(|\bfetch\s*\(|\bimport\s*\(|\brequire\s*\(|\beval\s*\(|\bnew\s+Function\b|\bprocess\.env\b/);
    // The preload (Root, 11/09): its blob is pinned, and it names this command as a production consumer.
    const preload = readFileSync(NO_NETWORK_PRELOAD, 'utf8').replace(/\r\n/g, '\n');
    const bytes = Buffer.from(preload, 'utf8');
    expect(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')).toBe(NO_NETWORK_PRELOAD_BLOB);
    expect(preload).toContain('holdr-retail-convert-owner-only (apps/api/src/cli/retailConvertOwnerOnly.ts)');
  });

  it.runIf(onWindows)('on Windows, for real: converts into an owner-only folder exactly as a direct run does, and refuses one others may read', async () => {
    const sid = readCurrentUserSid();
    const base = realpathSync.native(mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'retail-owner-only-')));
    extraDirs.push(base);
    const own = path.join(base, 'own');
    const shared = path.join(base, 'shared');
    const direct = path.join(base, 'direct');
    for (const dir of [own, shared, direct]) mkdirSync(dir);
    // Owner-only as a normal shell makes them: an elevated shell would leave Administrators their owner.
    for (const dir of [own, shared]) {
      restrictToUser(dir, sid);
      takeOwnership(dir, sid);
    }
    // Everyone (S-1-1-0) may read the shared one.
    execFileSync(system32('icacls.exe'), [shared, '/grant', '*S-1-1-0:(OI)(CI)R'], { stdio: 'ignore' });
    const capture = writeCapture(path.join(base, 'captures'), syntheticMembershipSpec());
    const argsFor = (dir: string) => ['--folder', capture.folder, '--manifest', capture.manifest, '--out', path.join(dir, 'payload.json'), '--report', path.join(dir, 'report.json')];
    const real = run(argsFor(own), { access: platformOutputAccess, spawn: spawnConverter });
    const silent = { stdout: { write: () => true }, stderr: { write: () => true } };
    const directStatus = await runRetailConvertCli(['--folder', capture.folder, '--manifest', capture.manifest, '--out', path.join(direct, 'payload.json')], silent);
    expect(directStatus).toBe(RETAIL_CONVERT_EXIT.ok);
    expect(real.stderr).toBe('');
    expect(real.status).toBe(EXIT.ok);
    expect(readFileSync(path.join(own, 'payload.json'))).toEqual(readFileSync(path.join(direct, 'payload.json')));
    for (const file of ['payload.json', 'report.json']) expect(ownerOnlyAcl(readWindowsAcls([path.join(own, file)])[0], sid), file).toBe(true);
    const report = JSON.parse(readFileSync(path.join(own, 'report.json'), 'utf8')) as { payload: { sha256: string } };
    expect(report.payload.sha256).toBe(createHash('sha256').update(readFileSync(path.join(own, 'payload.json'))).digest('hex'));
    expect(real.stdout).toContain(`"converterExit":0,"converter":"retail-converted"`);
    expect(real.stdout).toContain(`"sha256":"${report.payload.sha256}"`);
    for (const value of [...syntheticSensitiveValues(), base]) expect(real.stdout, value).not.toContain(value);
    const refused = run(argsFor(shared), { access: platformOutputAccess, spawn: spawnConverter });
    expect(refused.status).toBe(EXIT.refused);
    expect(refused.stderr).toBe(`${PREFIX}output-not-owner-only\n`);
    expect(readdirSync(shared)).toEqual([]);
  });
});
