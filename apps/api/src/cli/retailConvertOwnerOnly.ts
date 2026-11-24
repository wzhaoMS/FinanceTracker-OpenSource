/**
 * `holdr-retail-convert-owner-only`: the owner's retail converter (`holdr-retail-convert`, unchanged) run with its
 * outputs checked owner-only through the shared ownerOnlyOutput module. This is the method of Root's real dry runs
 * (11/09), formalized; any failure stops the run:
 * 1. Windows only. Any other platform is refused before anything is read: the method was proven there alone.
 * 2. Every path is a full path on a local drive (`C:\…`), resolved once. A relative or drive-relative path, a rooted
 *    path without a drive, a UNC or device path (`\\server\share`, `\\?\…`, `\\.\…`) and a stream (`file:name`) are
 *    refused before anything is read. So is an output path (--out, --report) with a folder or file name that Windows
 *    reads as another file or a device: one ending in a dot or a space, or a device name such as NUL, COM1 or CONIN$,
 *    with any extension (the shared module's `isWindowsAliasName`), as `output-name-refused`. The capture folder and the
 *    manifest must exist and be no link themselves (as a direct run refuses one), and are taken by their real paths,
 *    once: a link or junction on the way to them is followed, and a real path off the local drives (a link to a share
 *    resolves to `\\server\share\…`) is refused. The converter gets exactly the paths checked here. Paths are local by
 *    form and by real path; mapped network drives aren't detected.
 * 3. The run folder, where both outputs go, is checked by `assertOwnerOnlyDirectory` on its real path before the
 *    converter starts, so before any capture is read or any byte is written. It lies outside the capture folder and the
 *    folder of its manifest: captures are only read.
 * 4. The converter runs as a child under the no-network preload (`NO_NETWORK_PRELOAD`, below), a tripwire and
 *    not a sandbox: this Node, tsx, the preload, the converter and its own options, as an argument array with no shell.
 *    It creates its payload exclusively ('wx'), as it always has; its import pin and its tests are untouched.
 * 5. After it exits, whatever its status, the payload is checked by `ownerOnlyAcl`, once claimed for the current user if an
 *    elevated shell made Administrators its owner (`claimNewFile`). A payload that fails the check, or
 *    that the converter doesn't vouch for, is removed. A link, junction or directory at the payload's path is never
 *    followed or removed.
 * 6. The converter's report is written through `writeOwnerOnlyNewFile`. If that fails, the payload is removed too, so
 *    that a refused run leaves no output (should that removal itself fail, the run ends as an unexpected error).
 * This command reads no capture itself, and opens no connection of its own: Windows may contact a share while it
 * resolves a link that leads to one, and the run is then refused. The ACL reader starts PowerShell, so it runs without
 * the preload; only the converter runs under it. stdout is value-free: codes, counts and digests, never a path, a date
 * or a title. The full report, dates included, goes only to the owner-only report file.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { WindowsAcl } from '../e2e/windowsAcl.js';
import type { Io } from './controlCommon.js';
import { assertOwnerOnlyDirectory, claimNewFile, isWindowsAliasName, ownerOnlyAcl, OutputRefusal, platformOutputAccess, writeOwnerOnlyNewFile, type OutputAccess } from './ownerOnlyOutput.js';

export const RETAIL_CONVERT_OWNER_ONLY_USAGE = `Usage: holdr-retail-convert-owner-only --folder DIR --manifest FILE --dry-run --report NEW_FILE
       holdr-retail-convert-owner-only --folder DIR --manifest FILE --out NEW_FILE [--skip-held] --report NEW_FILE

Runs holdr-retail-convert, unchanged, on Windows, with its outputs checked owner-only:
  --report NEW_FILE  where the converter's report goes: a new file, written owner-only
  --out NEW_FILE     where the payload goes: a new file in the same folder as --report
  --folder, --manifest, --dry-run, --out and --skip-held go to the converter (see holdr-retail-convert --help).
  Every path is a full path on a local drive, like C:\\folder\\file: no relative, UNC or device path. Each is resolved
  once. The capture folder and the manifest must exist and be no link themselves; links on the way to them are followed
  to their real paths, which must be on a local drive too. The converter gets the paths as checked. The folder of
  --report must exist, be no link, be owner-only, and be outside the capture folder and the folder of its manifest.
  No folder or file name on --out or --report may end in a dot or a space or name a device, like NUL, COM1 or
  CONIN$, with any extension: Windows reads such a name as another file or a device (output-name-refused).
  stdout: one line of codes, counts and digests. The full report, dates included, is only in --report.
`;

export const RETAIL_CONVERT_OWNER_ONLY_EXIT = { ok: 0, refused: 1, usage: 64 } as const;

/** Codes of this command's own refusals, beside the shared output refusals. They name no path. */
export const RETAIL_CONVERT_OWNER_ONLY_REFUSALS = ['retail-convert-child-failed', 'retail-convert-output-mismatch'] as const;
export type RetailConvertOwnerOnlyRefusal = (typeof RETAIL_CONVERT_OWNER_ONLY_REFUSALS)[number];

const NAME = 'holdr-retail-convert-owner-only';
const VALUE_OPTIONS: readonly string[] = ['--folder', '--manifest', '--out', '--report'];
const FLAGS: readonly string[] = ['--dry-run', '--skip-held', '--help'];
/** The converter's exit statuses (RETAIL_CONVERT_EXIT): anything else means it didn't end normally. */
const CONVERTER_EXITS: readonly number[] = [0, 1, 64];
/** The converter's report codes; anything else is reported as null. */
const CONVERTER_CODES: readonly string[] = ['retail-convert-dry-run', 'retail-converted', 'retail-held'];
/** A full path on a local drive: a drive letter, a colon and a separator, and no other colon (no stream). */
const LOCAL_DRIVE_PATH = /^[A-Za-z]:[\\/][^:]*$/;

const here = path.dirname(fileURLToPath(import.meta.url));
/** The converter's entry point. */
export const RETAIL_CONVERTER_MAIN = path.join(here, 'retailConvertMain.ts');
/**
 * The preload under which the converter runs: a tripwire, not a sandbox. The common Node entry points for connections,
 * name lookups and child processes throw; others stay open (see the preload's header).
 */
export const NO_NETWORK_PRELOAD = path.resolve(here, '..', '..', '..', '..', 'packages', 'shared', 'src', 'cardImportTool', 'testing', 'noNetwork.mjs');
/** Where the converter runs: apps/api, as npm runs it, so `--import tsx` resolves as it does there. */
export const CONVERTER_CWD = path.resolve(here, '..', '..');

/** What a converter child gave back: its exit status (null when a signal ended it), that signal, its stdout, and a start failure. */
export interface ConvertChild {
  status: number | null;
  signal: string | null;
  stdout: string;
  error?: Error;
}
export type ConvertSpawner = (file: string, args: readonly string[], cwd: string) => ConvertChild;
/** What happens to an error that no declared refusal covers; returns the exit status. */
export type UnexpectedError = (error: unknown, io: Io) => number;
/** Writes the report: a new file, checked owner-only before a byte is written (`writeOwnerOnlyNewFile`). */
export type ReportWriter = (file: string, text: string, access: OutputAccess) => void;
/** A path's real path, every link and junction on it followed (`fs.realpathSync.native`): `\\server\share\…` for a share. */
export type RealPath = (file: string) => string;

/** The converter's command: this Node, tsx, the preload, then the converter with its own arguments. */
export function converterCommand(converterArgs: readonly string[]): { file: string; args: string[]; cwd: string } {
  return {
    file: process.execPath,
    args: ['--import', 'tsx', '--import', pathToFileURL(NO_NETWORK_PRELOAD).href, RETAIL_CONVERTER_MAIN, ...converterArgs],
    cwd: CONVERTER_CWD,
  };
}

/** Starts the converter: an argument array, no shell and no window; stdout captured, stderr (value-free by the converter's rule) passed on. */
export const spawnConverter: ConvertSpawner = (file, args, cwd) => {
  const result = spawnSync(file, args, {
    cwd, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 2 ** 28, stdio: ['ignore', 'pipe', 'inherit'],
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', error: result.error };
};

/** By default, an unexpected error leaves as its file system code or its type only: it may quote a path. */
export const reportUnexpected: UnexpectedError = (error, io) => {
  const code = (error as { code?: unknown }).code;
  io.stderr.write(`${NAME}: failed (${typeof code === 'string' && /^E[A-Z]{2,12}$/.test(code) ? code : error instanceof Error ? error.name : 'error'})\n`);
  return RETAIL_CONVERT_OWNER_ONLY_EXIT.refused;
};

/**
 * The command's outside world: the ACL reader, the converter's start, the report's writer, the real-path reader, and
 * the handler of unexpected errors.
 */
export interface OwnerOnlySeams {
  access: OutputAccess;
  spawn: ConvertSpawner;
  write: ReportWriter;
  realPath: RealPath;
  unexpected: UnexpectedError;
}

class UsageError extends Error {}
/** A stop by a closed code that names no path. */
class Stop extends Error {
  constructor(readonly code: RetailConvertOwnerOnlyRefusal) {
    super(code);
  }
}

interface Args {
  values: Map<string, string>;
  flags: Set<string>;
  /** The converter's options, in their order: every value option but --report, and every flag. */
  order: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const order: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (VALUE_OPTIONS.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      if (values.has(arg)) throw new UsageError(`${arg} is given twice`);
      values.set(arg, value);
      if (arg !== '--report') order.push(arg);
      i += 1;
    } else if (FLAGS.includes(arg)) {
      if (flags.has(arg)) throw new UsageError(`${arg} is given twice`);
      flags.add(arg);
      order.push(arg);
    } else {
      throw new UsageError(arg.startsWith('--') ? 'unknown option' : 'unexpected argument');
    }
  }
  return { values, flags, order };
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Whether `target` is `dir` or inside it (path.relative compares case-insensitively on Windows). */
function isWithin(dir: string, target: string): boolean {
  const relative = path.relative(dir, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** A path's real path by `realPath`, or null when there is nothing there. */
function realPathOrNull(file: string, realPath: RealPath): string | null {
  try {
    return realPath(file);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
}

/** The converter's report, if it printed one: its code, counts and payload facts, each kept only when of its type. */
function readReport(stdout: string) {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  const r = report as { code?: unknown; receipts?: Record<string, unknown>; payload?: Record<string, unknown> };
  const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null);
  return {
    code: typeof r.code === 'string' && CONVERTER_CODES.includes(r.code) ? r.code : null,
    receipts: { read: count(r.receipts?.read), accepted: count(r.receipts?.accepted), held: count(r.receipts?.held) },
    payload: {
      written: typeof r.payload?.written === 'boolean' ? r.payload.written : null,
      sha256: typeof r.payload?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.payload.sha256) ? r.payload.sha256 : null,
      bytes: count(r.payload?.bytes),
    },
  };
}

/** Removes what the converter left at `out` when it is a regular file; a link, junction or directory is left alone. */
function removePayload(out: string): void {
  if (fs.lstatSync(out, { throwIfNoEntry: false })?.isFile()) fs.rmSync(out, { force: true });
}

/** Checks the payload the converter left, if any, by the shared ACL rule for the user `sid`; removes it when it fails. */
function checkPayload(out: string, access: OutputAccess, sid: string): void {
  const stat = fs.lstatSync(out, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (!stat.isFile()) throw new OutputRefusal('output-uncheckable');
  let acl: WindowsAcl | undefined;
  // Only the reader's or the owner change's own failure is "uncheckable", as in the shared module: this try holds them alone.
  try {
    acl = claimNewFile(out, access.readAcls([out])[0], access, sid);
  } catch {
    removePayload(out);
    throw new OutputRefusal('output-uncheckable');
  }
  if (acl === undefined || !ownerOnlyAcl(acl, sid)) {
    removePayload(out);
    throw new OutputRefusal('output-not-owner-only');
  }
}

/**
 * `holdr-retail-convert-owner-only`. Returns the exit status: the converter's own when every check passed, 1 when a
 * check refused, 64 for a usage error. The seams are the real ACL reader, child start, report writer, real-path reader
 * and unexpected-error report unless a test gives stand-ins.
 */
export function runRetailConvertOwnerOnlyCli(argv: readonly string[], io: Io, seams: Partial<OwnerOnlySeams> = {}): number {
  const { access = platformOutputAccess, spawn = spawnConverter, write = writeOwnerOnlyNewFile, realPath = fs.realpathSync.native, unexpected = reportUnexpected } = seams;
  if (access.platform !== 'win32') {
    io.stderr.write(`${NAME}: output-uncheckable (Windows only)\n`);
    return RETAIL_CONVERT_OWNER_ONLY_EXIT.usage;
  }
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr.write(`${NAME}: ${error.message}\n${RETAIL_CONVERT_OWNER_ONLY_USAGE}`);
    return RETAIL_CONVERT_OWNER_ONLY_EXIT.usage;
  }
  if (args.flags.has('--help')) {
    io.stdout.write(RETAIL_CONVERT_OWNER_ONLY_USAGE);
    return RETAIL_CONVERT_OWNER_ONLY_EXIT.ok;
  }
  try {
    // 1. The arguments, before anything is read. Each path is resolved once: that string is checked and passed on.
    const paths = new Map<string, string>();
    for (const [name, value] of args.values) {
      if (!LOCAL_DRIVE_PATH.test(value)) throw new UsageError(`${name} must be a full path on a local drive, like C:\\folder\\file`);
      paths.set(name, path.resolve(value));
    }
    const report = paths.get('--report');
    if (report === undefined) throw new UsageError('give --report NEW_FILE');
    const out = paths.get('--out');
    // The shared rule, on the whole of each output path (its run folder too), as every command reports it.
    for (const file of [report, out]) {
      if (file !== undefined && isWindowsAliasName(file)) throw new OutputRefusal('output-name-refused');
    }
    const runDir = path.dirname(report);
    if (out !== undefined && !samePath(path.dirname(out), runDir)) throw new UsageError('--out and --report go in one folder');
    if (out !== undefined && samePath(out, report)) throw new UsageError('--out and --report must be two files');
    if (!fs.lstatSync(runDir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError('the folder of --report must be an existing directory, not a link');
    for (const [name, file] of [['--report', report], ['--out', out]] as const) {
      if (file !== undefined && fs.lstatSync(file, { throwIfNoEntry: false })) throw new UsageError(`${name} already exists; name a new file`);
    }

    // 2. The capture folder and the manifest, each by its real path, taken once: it must exist and be no link itself (as
    //    a direct run refuses one), and no link or junction on the way to it may lead off the local drives. The
    //    converter gets these real paths.
    for (const name of ['--folder', '--manifest']) {
      const given = paths.get(name);
      if (given === undefined) continue;
      if (fs.lstatSync(given, { throwIfNoEntry: false })?.isSymbolicLink()) throw new UsageError(`${name} must not be a link`);
      const resolved = realPathOrNull(given, realPath);
      if (resolved === null) throw new UsageError(`${name} must exist`);
      if (!LOCAL_DRIVE_PATH.test(resolved)) throw new UsageError(`${name} must lead to a local drive, not to a share`);
      paths.set(name, resolved);
    }

    // 3. The run folder, on its real path, before the converter starts.
    const real = realPath(runDir);
    // The module takes a real path: a link or junction on the way to the folder can't be checked as given.
    if (!samePath(real, runDir)) throw new OutputRefusal('output-uncheckable');
    const manifest = paths.get('--manifest');
    // Real paths all: the manifest's folder is one too.
    for (const dir of [paths.get('--folder'), manifest === undefined ? undefined : path.dirname(manifest)]) {
      if (dir !== undefined && isWithin(dir, real)) throw new UsageError('--report must be outside the capture folder and the folder of its manifest');
    }
    assertOwnerOnlyDirectory(real, access);
    // The payload is checked for this same user. Read before the converter starts, its failure leaves nothing behind.
    const sid = access.currentUserSid();

    // 4. The converter, given the very paths checked here.
    const command = converterCommand(args.order.flatMap((name) => {
      const value = paths.get(name);
      return value === undefined ? [name] : [name, value];
    }));
    const child = spawn(command.file, command.args, command.cwd);
    const status = child.status;
    const facts = readReport(child.stdout);

    // 5. The payload, whatever the converter's status.
    if (out !== undefined) checkPayload(out, access, sid);
    if (child.error !== undefined || status === null || !CONVERTER_EXITS.includes(status)) {
      if (out !== undefined) removePayload(out);
      throw new Stop('retail-convert-child-failed');
    }
    if (out !== undefined && (fs.lstatSync(out, { throwIfNoEntry: false }) !== undefined) !== (facts?.payload.written === true)) {
      removePayload(out);
      throw new Stop('retail-convert-output-mismatch');
    }

    // 6. The report. If it can't be written, the payload goes too: a refused run leaves no output.
    let reportWritten = false;
    if (child.stdout !== '') {
      try {
        write(report, child.stdout, access);
      } catch (error) {
        if (out !== undefined) removePayload(out);
        throw error;
      }
      reportWritten = true;
    }
    io.stdout.write(`${JSON.stringify({
      code: 'retail-convert-owner-only',
      converterExit: status,
      converter: facts?.code ?? null,
      receipts: facts?.receipts ?? null,
      payload: facts?.payload ?? null,
      report: reportWritten,
    })}\n`);
    return status;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${NAME}: ${error.message}\n`);
      return RETAIL_CONVERT_OWNER_ONLY_EXIT.usage;
    }
    if (error instanceof OutputRefusal || error instanceof Stop) {
      io.stderr.write(`${NAME}: ${error.code}\n`);
      return RETAIL_CONVERT_OWNER_ONLY_EXIT.refused;
    }
    return unexpected(error, io);
  }
}
