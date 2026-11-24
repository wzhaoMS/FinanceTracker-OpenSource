import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  convertCostcoCapture,
  RETAIL_CONVERTER,
  RetailConvertError,
  retailDigest,
} from '@finance-tracker/shared/retail-import-tool';

import type { Io } from './controlCommon.js';

export const RETAIL_CONVERT_USAGE = `Usage: holdr-retail-convert --folder DIR --manifest FILE --dry-run
       holdr-retail-convert --folder DIR --manifest FILE --out NEW_FILE [--skip-held]

Turns one Costco membership's capture folder (costco, costco-2, ... under the owner-only HoldrRetailImports) into one
redacted holdr.retail-import payload for the Root-GO'd \`holdr-retail import\`. Offline: no network, no database.

  --folder DIR       the membership's folder: its costco.json and its raw responses (raw/detail-*.json and
                     raw/receipts/receipt-*.json)
  --manifest FILE    the capture's private manifest (manifest.private.json): every file read must be listed there,
                     relative to the manifest's own folder, with its exact size and SHA-256
  --dry-run          read and check everything, print the report, write nothing
  --out NEW_FILE     where the payload goes: a new file (never overwritten), owner-only, outside the capture: outside
                     both the membership folder and the manifest's folder, compared by real paths (links resolved)
  --skip-held        with --out: write the payload even when some records are held (default: write nothing then)

Every record must hold its money identities and agree between the consolidated file and its raw response, or it is
held, and the report says why. Prints a JSON report of counts, closed codes, dates and the payload's SHA-256: never an
amount, item, name, place, card ending, file name or native number.
`;

export const RETAIL_CONVERT_EXIT = { ok: 0, refused: 1, usage: 64 } as const;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 50_000;
const VALUE_OPTIONS = ['--folder', '--manifest', '--out'] as const;
const FLAGS = ['--dry-run', '--skip-held', '--help', '--version'] as const;
const FOLDER = /^costco(?:-[1-9][0-9]{0,2})?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

class UsageError extends Error {}

/** A refusal of the whole run, by a closed code and counts only. */
class Refusal extends Error {
  constructor(readonly code: string, readonly count?: number) {
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

/** The capture files a membership folder holds, by the names the pull writes, in a fixed order. */
function captureFiles(folder: string): { consolidated: string; receipts: string[]; details: string[] } {
  const consolidated = path.join(folder, 'costco.json');
  const raw = path.join(folder, 'raw');
  const receiptsDir = path.join(raw, 'receipts');
  const list = (dir: string, pattern: RegExp) => {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat) return [];
    if (!stat.isDirectory()) throw new Refusal('capture-unreadable');
    return fs.readdirSync(dir).filter((name) => pattern.test(name)).sort().map((name) => path.join(dir, name));
  };
  return {
    consolidated,
    receipts: list(receiptsDir, /^receipt-[0-9a-f]{8,64}\.json$/),
    details: list(raw, /^detail-[0-9]{1,20}\.json$/),
  };
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

function parse(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Refusal('capture-unreadable');
  }
}

/** Writes the payload as a new owner-only file: nothing is ever replaced. */
function writePayload(out: string, json: string): void {
  const fd = fs.openSync(out, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** `holdr-retail-convert`: the owner's offline converter of retail captures. Returns the exit status. */
export async function runRetailConvertCli(argv: readonly string[], io: Io): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`holdr-retail-convert: ${(error as Error).message}\n${RETAIL_CONVERT_USAGE}`);
    return RETAIL_CONVERT_EXIT.usage;
  }
  if (args.flags.has('--help')) {
    io.stdout.write(RETAIL_CONVERT_USAGE);
    return RETAIL_CONVERT_EXIT.ok;
  }
  if (args.flags.has('--version')) {
    io.stdout.write(`${RETAIL_CONVERTER}\n`);
    return RETAIL_CONVERT_EXIT.ok;
  }
  try {
    if (args.rest.length > 0) throw new UsageError('unexpected argument');
    const folder = args.values.get('--folder');
    const manifestFile = args.values.get('--manifest');
    const out = args.values.get('--out');
    const dryRun = args.flags.has('--dry-run');
    if (folder === undefined || manifestFile === undefined) throw new UsageError('give --folder DIR and --manifest FILE');
    if ((out === undefined) === !dryRun) throw new UsageError('give --dry-run or --out NEW_FILE (one of them)');
    if (dryRun && args.flags.has('--skip-held')) throw new UsageError('--skip-held goes with --out, not --dry-run');
    const name = path.basename(path.resolve(folder));
    if (!FOLDER.test(name)) throw new UsageError('--folder must be a membership folder named costco or costco-N');
    const folderStat = fs.lstatSync(folder, { throwIfNoEntry: false });
    if (!folderStat?.isDirectory()) throw new UsageError('--folder must be an existing directory');
    if (out !== undefined) {
      if (fs.lstatSync(out, { throwIfNoEntry: false })) throw new UsageError('--out already exists; name a new file');
      const parent = path.dirname(path.resolve(out));
      if (!fs.statSync(parent, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError('--out must be in an existing directory');
      // By real paths: no link or junction on either path can lead the output back into the capture.
      const target = path.join(realPath(parent), path.basename(out));
      if (isWithin(realPath(folder), target)) throw new UsageError('--out must be outside the capture folder');
      const manifestDir = path.dirname(path.resolve(manifestFile));
      if (fs.lstatSync(manifestDir, { throwIfNoEntry: false }) && isWithin(realPath(manifestDir), target)) {
        throw new UsageError("--out must be outside the folder of the capture's manifest");
      }
    }
    const manifest = readManifest(manifestFile);
    const root = path.dirname(path.resolve(manifestFile));
    const files = captureFiles(path.resolve(folder));
    const consolidatedBytes = readVerified(files.consolidated, root, manifest);
    const rawReceipts = files.receipts.map((file) => parse(readVerified(file, root, manifest)));
    const rawDetails = files.details.map((file) => parse(readVerified(file, root, manifest)));
    const { json, report } = convertCostcoCapture({
      folder: name,
      consolidated: parse(consolidatedBytes),
      consolidatedDigest: retailDigest(new Uint8Array(consolidatedBytes)),
      rawReceipts,
      rawDetails,
      files: 1 + rawReceipts.length + rawDetails.length,
    });
    const held = report.receipts.held;
    const write = out !== undefined && (held === 0 || args.flags.has('--skip-held'));
    if (write) writePayload(out!, json);
    const output = {
      code: dryRun ? 'retail-convert-dry-run' : write ? 'retail-converted' : 'retail-held',
      ...report,
      payload: { sha256: createHash('sha256').update(json).digest('hex'), bytes: Buffer.byteLength(json), written: write },
    };
    io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (held > 0 && !args.flags.has('--skip-held')) {
      io.stderr.write(`holdr-retail-convert: ${held} of ${report.receipts.read} records were held`
        + `${out !== undefined ? ', so nothing was written' : ''} (see the report; --skip-held writes the others)\n`);
      return RETAIL_CONVERT_EXIT.refused;
    }
    return RETAIL_CONVERT_EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`holdr-retail-convert: ${error.message}\n`);
      return RETAIL_CONVERT_EXIT.usage;
    }
    if (error instanceof Refusal) {
      io.stderr.write(`holdr-retail-convert: ${error.code}\n`);
      return RETAIL_CONVERT_EXIT.refused;
    }
    if (error instanceof RetailConvertError) {
      // Its message is its code and at most a structural path, never a value.
      io.stderr.write(`holdr-retail-convert: ${error.message}\n`);
      return RETAIL_CONVERT_EXIT.refused;
    }
    const code = (error as { code?: unknown }).code;
    // Anything else may quote a file: only its type (or a file system error's code) leaves.
    io.stderr.write(`holdr-retail-convert: failed (${typeof code === 'string' && /^E[A-Z]{2,12}$/.test(code) ? code : error instanceof Error ? error.name : 'error'})\n`);
    return RETAIL_CONVERT_EXIT.refused;
  }
}
