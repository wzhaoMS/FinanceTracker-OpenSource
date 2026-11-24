import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  COLLECTPURE_METALS_CONVERTER,
  METALS_CONVERTER,
  METALS_COSTCO_CONVERTER,
  MetalsConvertError,
  type MetalsCaptureConverter,
  type MetalsCaptureFile,
  type MetalsConverter,
  type MetalsConvertOutput,
  type MetalsRetailPayloadConverter,
  walmartCaptureConverter,
} from '@finance-tracker/shared/metals-convert';
import {
  METALS_SOURCES,
  serializeMetalsImportPayload,
  validateMetalsImportPayload,
  type MetalsSource,
} from '@finance-tracker/shared/metals-ledger';

import type { Io } from './controlCommon.js';
import { assertOwnerOnlyDirectory, isWindowsAliasName, OutputRefusal, platformOutputAccess, writeOwnerOnlyNewFile, type OutputAccess } from './ownerOnlyOutput.js';

export const METALS_CONVERT_USAGE = `Usage: holdr-metals-convert --source walmart|collectpure --folder DIR --manifest FILE --dry-run
       holdr-metals-convert --source walmart|collectpure --folder DIR --manifest FILE --out NEW_FILE [--skip-held]
       holdr-metals-convert --source costco --retail-payload FILE --dry-run
       holdr-metals-convert --source costco --retail-payload FILE --out NEW_FILE [--skip-held]

Turns one source account's evidence into one owner-only holdr.metals-import payload for the Root-GO'd metals import.
Offline: no network, no database.

  --source NAME          costco, walmart or collectpure
  --folder DIR           Walmart, CollectPure: the account's capture folder under the owner-only HoldrRetailImports,
                         named after its source (walmart, walmart-2, ...), or a snapshot folder nested in it where the
                         source keeps them (collectpure\snapYYYYMMDD): converted on its own, under its account's name
  --manifest FILE        the capture's private manifest (manifest.private.json): every file read must be listed there,
                         relative to the manifest's own folder, with its exact size and SHA-256
  --retail-payload FILE  Costco: one membership's holdr.retail-import payload, as holdr-retail-convert wrote it
  --dry-run              read and check everything, print the report, write nothing
  --out NEW_FILE         where the payload goes: a new file (never overwritten), outside the capture: outside both the
                         account folder and the manifest's folder, compared by real paths (links resolved). Owner-only:
                         its directory must be one only you can open (Windows: by its ACL, read by SID), and the new
                         file is checked the same way before a byte is written; nothing is ever repaired, so a place
                         that isn't owner-only, or can't be checked, is refused (output-not-owner-only,
                         output-uncheckable); so is, first, a path with a folder or file name that Windows reads as
                         another file or a device, like NUL or a name ending in a dot (output-name-refused)
  --skip-held            with --out: write the payload even when some records are held (default: write nothing then)

Links are never followed. Every payload is checked by the holdr.metals-import validator, which recomputes every derived
fact, before anything is written. Prints a JSON report of counts, closed codes, dates and digests: never an amount,
title, name, place, card ending, file name or native number.
`;

export const METALS_CONVERT_EXIT = { ok: 0, refused: 1, usage: 64 } as const;

/**
 * Each source's converter, or null while it is not yet available. Each source's own change adds its entry here and
 * nothing else; the blank lines keep those changes apart.
 */
export const METALS_CONVERT_SOURCES: Readonly<Record<MetalsSource, MetalsConverter | null>> = {
  // Costco (G1a-costco): --retail-payload FILE.
  costco: METALS_COSTCO_CONVERTER,

  // Walmart (G1b): --folder DIR --manifest FILE.
  walmart: walmartCaptureConverter,

  // CollectPure (G1c): --folder DIR --manifest FILE.
  collectpure: COLLECTPURE_METALS_CONVERTER,
};

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 50_000;
const VALUE_OPTIONS = ['--source', '--folder', '--manifest', '--retail-payload', '--out'] as const;
const FLAGS = ['--dry-run', '--skip-held', '--help', '--version'] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;

class UsageError extends Error {}

/** A refusal of the whole run, by a closed code and at most a structural path. */
class Refusal extends Error {
  constructor(readonly code: string, readonly at?: string) {
    super(code);
  }
}

interface Args {
  values: Map<string, string>;
  flags: Set<string>;
  rest: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((VALUE_OPTIONS as readonly string[]).includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      if (values.has(arg)) throw new UsageError(`${arg} is given twice`);
      values.set(arg, value);
      i += 1;
    } else if ((FLAGS as readonly string[]).includes(arg)) flags.add(arg);
    else if (arg.startsWith('--')) throw new UsageError('unknown option');
    else rest.push(arg);
  }
  return { values, flags, rest };
}

const caseOf = (file: string) => (process.platform === 'win32' ? file.toLowerCase() : file);
/** A path with every link and junction on it resolved. */
const realPath = (file: string) => fs.realpathSync.native(path.resolve(file));
/** Whether `target` is `dir` itself or inside it (without case on Windows). */
function isWithin(dir: string, target: string): boolean {
  const relative = path.relative(caseOf(dir), caseOf(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
/** A manifest-relative path, compared with `/` (and without case on Windows). */
const manifestKey = (relative: string) => {
  const forward = relative.replace(/\\/g, '/');
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
};

interface ManifestEntry {
  bytes: number;
  sha256: string;
}

/** The manifest's entries by path. Any other shape refuses the run. */
function readManifest(file: string): Map<string, ManifestEntry> {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Refusal('manifest-unreadable');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Refusal('manifest-unreadable');
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new Refusal('manifest-unreadable');
  const entries = new Map<string, ManifestEntry>();
  for (const entry of files) {
    const { path: relative, bytes, sha256 } = (entry ?? {}) as Record<string, unknown>;
    if (typeof relative !== 'string' || relative === '' || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0
      || typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      throw new Refusal('manifest-unreadable');
    }
    const key = manifestKey(relative);
    if (entries.has(key)) throw new Refusal('manifest-unreadable');
    entries.set(key, { bytes, sha256 });
  }
  return entries;
}

/**
 * The files a capture folder holds by its converter's layout, in layout order and then by name. A directory of the
 * layout that is a link, or not a directory, refuses the folder; so does a required file that isn't there.
 */
function captureFiles(folder: string, converter: MetalsCaptureConverter): string[] {
  const found: string[] = [];
  for (const { dir, name, required } of converter.files) {
    const at = dir === '' ? folder : path.join(folder, ...dir.split('/'));
    const stat = fs.lstatSync(at, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Refusal('capture-unreadable');
    const names = stat ? fs.readdirSync(at).filter((entry) => name.test(entry)).sort() : [];
    if (required && names.length === 0) throw new Refusal('capture-unreadable');
    found.push(...names.map((entry) => path.join(at, entry)));
    if (found.length > MAX_FILES) throw new Refusal('too-many-files');
  }
  return found;
}

/**
 * Reads one capture file and checks it against the manifest: a regular file (no link), listed under its path relative
 * to the manifest's folder, with that exact size and SHA-256.
 */
function readVerified(file: string, root: string, manifest: Map<string, ManifestEntry>): Buffer {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) throw new Refusal('capture-unreadable');
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Refusal('manifest-mismatch');
  const listed = manifest.get(manifestKey(relative));
  const bytes = fs.readFileSync(file);
  if (!listed || listed.bytes !== bytes.length || listed.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
    throw new Refusal('manifest-mismatch');
  }
  return bytes;
}

/**
 * Checks on --out, before anything is read: first, no folder or file name on it that Windows reads as another file or a
 * device (`isWindowsAliasName`); then a new file in an existing directory, outside every given folder, the directory
 * owner-only (by its real path, where its ACL applies).
 */
function checkOut(out: string, outside: ReadonlyArray<{ dir: string; message: string }>, access: OutputAccess): void {
  if (isWindowsAliasName(out)) throw new OutputRefusal('output-name-refused');
  if (fs.lstatSync(out, { throwIfNoEntry: false })) throw new UsageError('--out already exists; name a new file');
  const parent = path.dirname(path.resolve(out));
  if (!fs.statSync(parent, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError('--out must be in an existing directory');
  // By real paths: no link or junction on either path can lead the output back into the capture.
  const target = path.join(realPath(parent), path.basename(out));
  for (const { dir, message } of outside) {
    if (fs.lstatSync(dir, { throwIfNoEntry: false }) && isWithin(realPath(dir), target)) throw new UsageError(message);
  }
  assertOwnerOnlyDirectory(realPath(parent), access);
}

function convertCaptureFolder(converter: MetalsCaptureConverter, args: Args, out: string | undefined, access: OutputAccess): MetalsConvertOutput {
  const source = converter.source;
  if (args.values.has('--retail-payload')) throw new UsageError(`--retail-payload is not for ${source}: give --folder and --manifest`);
  const folder = args.values.get('--folder');
  const manifestFile = args.values.get('--manifest');
  if (folder === undefined || manifestFile === undefined) throw new UsageError('give --folder DIR and --manifest FILE');
  const base = path.resolve(folder);
  const name = path.basename(base);
  // A snapshot nested in the account folder is converted on its own, under its account folder's name.
  const snapshot = !converter.folder.test(name) && converter.snapshot?.test(name) === true ? name : null;
  const account = snapshot === null ? base : path.dirname(base);
  if (!converter.folder.test(path.basename(account))) {
    throw new UsageError(`--folder must be a ${source} account folder named ${source} or ${source}-N`
      + `${converter.snapshot ? ', or a snapshot folder inside one' : ''}`);
  }
  for (const dir of snapshot === null ? [base] : [base, account]) {
    if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError('--folder must be an existing directory');
  }
  if (out !== undefined) {
    checkOut(out, [
      { dir: account, message: '--out must be outside the capture folder' },
      { dir: path.dirname(path.resolve(manifestFile)), message: "--out must be outside the folder of the capture's manifest" },
    ], access);
  }
  const manifest = readManifest(manifestFile);
  const root = path.dirname(path.resolve(manifestFile));
  const files: MetalsCaptureFile[] = captureFiles(base, converter).map((file) => ({
    path: path.relative(base, file).split(path.sep).join('/'),
    bytes: new Uint8Array(readVerified(file, root, manifest)),
  }));
  return converter.convert({ folder: path.basename(account), snapshot, files, converterVersion: METALS_CONVERTER });
}

function convertRetailPayload(converter: MetalsRetailPayloadConverter, args: Args, out: string | undefined, access: OutputAccess): MetalsConvertOutput {
  const source = converter.source;
  if (args.values.has('--folder') || args.values.has('--manifest')) {
    throw new UsageError(`--folder and --manifest are not for ${source}: give --retail-payload`);
  }
  const file = args.values.get('--retail-payload');
  if (file === undefined) throw new UsageError('give --retail-payload FILE');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new UsageError('--retail-payload must be an existing file, not a link');
  if (out !== undefined) checkOut(out, [], access);
  if (stat.size > MAX_FILE_BYTES) throw new Refusal('retail-payload-unreadable');
  return converter.convert({ bytes: new Uint8Array(fs.readFileSync(file)), converterVersion: METALS_CONVERTER });
}

/** The output, checked once more as the exact text to be written: valid, canonical, of this source and version. */
function checkedOutput(source: MetalsSource, output: MetalsConvertOutput): { held: number; orders: number; competitors: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.json);
  } catch {
    throw new Refusal('converter-invalid');
  }
  const checked = validateMetalsImportPayload(parsed);
  if (!checked.ok) throw new Refusal('converter-invalid', checked.issues[0]?.path);
  const payload = checked.payload;
  if (payload.source !== source || payload.converterVersion !== METALS_CONVERTER || serializeMetalsImportPayload(payload) !== output.json) {
    throw new Refusal('converter-invalid');
  }
  return { held: payload.held.length, orders: payload.orders.length, competitors: payload.competitors.length };
}

const isSource = (value: string): value is MetalsSource => (METALS_SOURCES as readonly string[]).includes(value);
const STRUCTURAL = /^(?:\$|[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]{1,6}\])*$/;

/**
 * `holdr-metals-convert`: the owner's offline converter of metals evidence. Returns the exit status. `sources` and
 * `access` (how an output place is checked owner-only) are the real ones unless a test gives others.
 */
export async function runMetalsConvertCli(
  argv: readonly string[],
  io: Io,
  sources: Readonly<Record<MetalsSource, MetalsConverter | null>> = METALS_CONVERT_SOURCES,
  access: OutputAccess = platformOutputAccess,
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`holdr-metals-convert: ${(error as Error).message}\n${METALS_CONVERT_USAGE}`);
    return METALS_CONVERT_EXIT.usage;
  }
  if (args.flags.has('--help')) {
    io.stdout.write(METALS_CONVERT_USAGE);
    return METALS_CONVERT_EXIT.ok;
  }
  if (args.flags.has('--version')) {
    io.stdout.write(`${METALS_CONVERTER}\n`);
    return METALS_CONVERT_EXIT.ok;
  }
  try {
    if (args.rest.length > 0) throw new UsageError('unexpected argument');
    const source = args.values.get('--source');
    if (source === undefined || !isSource(source)) throw new UsageError('give --source costco, walmart or collectpure');
    const out = args.values.get('--out');
    const dryRun = args.flags.has('--dry-run');
    const skipHeld = args.flags.has('--skip-held');
    if ((out === undefined) === !dryRun) throw new UsageError('give --dry-run or --out NEW_FILE (one of them)');
    if (dryRun && skipHeld) throw new UsageError('--skip-held goes with --out, not --dry-run');
    const converter = sources[source];
    if (converter === null) {
      io.stderr.write(`holdr-metals-convert: --source ${source} is not yet available\n`);
      return METALS_CONVERT_EXIT.refused;
    }
    if (converter.source !== source) throw new Refusal('converter-invalid');
    const output = converter.input === 'capture-folder'
      ? convertCaptureFolder(converter, args, out, access)
      : convertRetailPayload(converter, args, out, access);
    const counts = checkedOutput(source, output);
    const write = out !== undefined && (counts.held === 0 || skipHeld);
    if (write) writeOwnerOnlyNewFile(out!, output.json, access);
    const report = {
      code: dryRun ? 'metals-convert-dry-run' : write ? 'metals-converted' : 'metals-held',
      source,
      converter: METALS_CONVERTER,
      report: output.report,
      payload: {
        sha256: createHash('sha256').update(output.json).digest('hex'),
        bytes: Buffer.byteLength(output.json),
        written: write,
        ...counts,
      },
    };
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (counts.held > 0 && !skipHeld) {
      io.stderr.write(`holdr-metals-convert: ${counts.held} record${counts.held === 1 ? ' was' : 's were'} held`
        + `${out !== undefined ? ', so nothing was written' : ''} (see the report; --skip-held writes the others)\n`);
      return METALS_CONVERT_EXIT.refused;
    }
    return METALS_CONVERT_EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`holdr-metals-convert: ${error.message}\n`);
      return METALS_CONVERT_EXIT.usage;
    }
    if (error instanceof Refusal) {
      const at = error.at !== undefined && STRUCTURAL.test(error.at) ? ` at ${error.at}` : '';
      io.stderr.write(`holdr-metals-convert: ${error.code}${at}\n`);
      return METALS_CONVERT_EXIT.refused;
    }
    if (error instanceof OutputRefusal) {
      io.stderr.write(`holdr-metals-convert: ${error.code}\n`);
      return METALS_CONVERT_EXIT.refused;
    }
    if (error instanceof MetalsConvertError) {
      // Its message is its code and at most a structural path, never a value.
      io.stderr.write(`holdr-metals-convert: ${error.message}\n`);
      return METALS_CONVERT_EXIT.refused;
    }
    const code = (error as { code?: unknown }).code;
    // Anything else may quote a file: only its type (or a file system error's code) leaves.
    io.stderr.write(`holdr-metals-convert: failed (${typeof code === 'string' && /^E[A-Z]{2,12}$/.test(code) ? code : error instanceof Error ? error.name : 'error'})\n`);
    return METALS_CONVERT_EXIT.refused;
  }
}
