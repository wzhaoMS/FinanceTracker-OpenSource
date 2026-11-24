// The API's code identity and its release attestation (card-upload migration B-a). One algorithm, shared by the API,
// which computes its identity at startup and serves it (B-b wires the route), and by the Mac uploader's admission
// gate, which compares that identity with its release manifest. The gate loads this before it has verified anything
// else, so it uses Node builtins only. Identity fields only: never file contents, values or secrets.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODE_IDENTITY_ALGORITHM = 'holdr.api-code-identity/1';
/** Trees of regular files, relative to the live root. Every file counts; a link or special entry is refused. */
export const CODE_IDENTITY_TREES = Object.freeze(['apps/api/src', 'packages/shared/src']);
/** Single files that decide how that code loads. An absent one is recorded as absent (null). */
export const CODE_IDENTITY_FILES = Object.freeze(['apps/api/package.json', 'apps/api/tsconfig.json',
  'node_modules/.package-lock.json', 'node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'package-lock.json',
  'package.json', 'packages/shared/package.json', 'packages/shared/tsconfig.json', 'tsconfig.json']);
export const LOCKFILES = Object.freeze(['node_modules/.package-lock.json', 'package-lock.json']);
export const NATIVE_ADDON = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';

/**
 * The route that serves the attestation (B-b): GET only, for the service principal only. The API honours its service
 * token only from a direct loopback caller; a signed-in browser session, a device or any other principal must never
 * reach this route (refused like any route outside its scope). The body is exactly the attestation below.
 */
export const API_ATTESTATION_PATH = '/release/attestation';
export const ATTESTATION_FORMAT = 'holdr.api-release-attestation';
export const ATTESTATION_VERSION = 1;
export const MAX_ATTESTATION_BYTES = 65536;

export class CodeIdentityError extends Error {
  constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; }
}

const HEX64 = /^[0-9a-f]{64}$/;
const NODE_VERSION = /^v\d+\.\d+\.\d+$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Byte order of the UTF-8 encoding: the same on every platform and locale. */
export const compareText = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

/** The sha256 of a regular file, read through a descriptor that did not follow a link at the last component. */
export function sha256File(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new CodeIdentityError('code-identity-entry', file);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

const resolvesToItself = target => {
  try { return fs.realpathSync.native(target) === target; } catch { return false; }
};
const join = (root, relative) => path.join(root, ...relative.split('/'));

function walkTree(root, relative, entries) {
  const directory = join(root, relative);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = relative + '/' + entry.name;
    if (entry.isDirectory()) walkTree(root, child, entries);
    else if (entry.isFile()) entries.push([child, sha256File(path.join(directory, entry.name))]);
    else throw new CodeIdentityError(entry.isSymbolicLink() ? 'code-identity-link' : 'code-identity-entry', path.join(directory, entry.name));
  }
}

/**
 * [relative path, sha256 or null] for every input, sorted by path. The live root must be written as it resolves; no
 * input may be reached through a link (a linked tree or file is a different identity even with equal bytes).
 */
export function codeIdentityEntries(liveRoot) {
  if (typeof liveRoot !== 'string' || !path.isAbsolute(liveRoot) || !resolvesToItself(liveRoot)) {
    throw new CodeIdentityError('code-identity-root', String(liveRoot));
  }
  const entries = [];
  for (const tree of CODE_IDENTITY_TREES) {
    const directory = join(liveRoot, tree);
    let info;
    try { info = fs.lstatSync(directory); } catch { throw new CodeIdentityError('code-identity-missing', directory); }
    if (!info.isDirectory() || !resolvesToItself(directory)) throw new CodeIdentityError('code-identity-link', directory);
    walkTree(liveRoot, tree, entries);
  }
  for (const relative of CODE_IDENTITY_FILES) {
    const file = join(liveRoot, relative);
    let info;
    try { info = fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') { entries.push([relative, null]); continue; }
      throw new CodeIdentityError('code-identity-entry', file);
    }
    if (!info.isFile()) throw new CodeIdentityError(info.isSymbolicLink() ? 'code-identity-link' : 'code-identity-entry', file);
    if (!resolvesToItself(file)) throw new CodeIdentityError('code-identity-link', file);
    entries.push([relative, sha256File(file)]);
  }
  return entries.sort((a, b) => compareText(a[0], b[0]));
}
export const codeIdentityDigest = entries => sha256Hex(JSON.stringify([CODE_IDENTITY_ALGORITHM, entries]));
export function computeCodeIdentity(liveRoot) {
  const entries = codeIdentityEntries(liveRoot);
  return { algorithm: CODE_IDENTITY_ALGORITHM, digest: codeIdentityDigest(entries), entries };
}

/** The executable's real path, the version that process reports, and the executable's sha256. */
export function runtimeIdentity(execPath, version) {
  const real = fs.realpathSync.native(execPath);
  return { execPath: real, version, sha256: sha256File(real) };
}

const PRELOAD_FLAGS = new Set(['--require', '-r', '--import', '--loader', '--experimental-loader']);
function preloadPath(value, cwd) {
  let file;
  if (value.startsWith('file:')) {
    try { file = fileURLToPath(value); } catch { return value; }
  } else if (path.isAbsolute(value) || /^\.\.?(?:[\\/]|$)/.test(value)) file = path.resolve(cwd, value);
  else return value;  // a package name: never a manifest's file path
  try { return fs.realpathSync.native(file); } catch { return file; }
}
/** A process's execArgv as the modules it preloads (real paths, in order) and every other flag, verbatim. */
export function describeExecArgv(execArgv, cwd) {
  const preloads = [], flags = [];
  for (let index = 0; index < execArgv.length; index++) {
    const arg = String(execArgv[index]);
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (!PRELOAD_FLAGS.has(name)) { flags.push(arg); continue; }
    const value = equals > 0 ? arg.slice(equals + 1) : execArgv[++index];
    if (typeof value !== 'string') { flags.push(arg); continue; }
    preloads.push(preloadPath(value, cwd));
  }
  return { preloads, flags };
}

/**
 * The attestation an API computes once at startup and serves unchanged for its whole life (B-b), e.g.
 * createApiAttestation({ pid: process.pid, startedAt: performance.timeOrigin, execPath: process.execPath,
 *   version: process.version, execArgv: process.execArgv, cwd: process.cwd(), entry: process.argv[1],
 *   env: process.env, liveRoot }).
 * Accepted residual (ROOT B3): a file written while the API starts can differ from the bytes it loaded.
 */
export function createApiAttestation({ pid, startedAt, execPath, version, execArgv, cwd, entry, env, liveRoot }) {
  const { preloads, flags } = describeExecArgv(execArgv, cwd);
  const code = computeCodeIdentity(liveRoot);
  return parseApiAttestation({
    format: ATTESTATION_FORMAT, version: ATTESTATION_VERSION, pid, startedAt: new Date(startedAt).toISOString(),
    runtime: runtimeIdentity(execPath, version), entry: fs.realpathSync.native(path.resolve(cwd, entry)), preloads, flags,
    nodeOptions: typeof env.NODE_OPTIONS === 'string' && env.NODE_OPTIONS.trim() !== '',
    code: { algorithm: code.algorithm, digest: code.digest },
  });
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasKeys = (value, keys) => isRecord(value) && Object.keys(value).sort().join(',') === keys;
const isPath = value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && path.isAbsolute(value);
const isTextList = (value, limit) => Array.isArray(value) && value.length <= limit
  && value.every(item => typeof item === 'string' && item.length <= 4096 && !item.includes('\0'));

/** Exactly the attestation's shape and formats, or `api-attestation-invalid`. Returns a frozen copy. */
export function parseApiAttestation(value) {
  const invalid = () => { throw new CodeIdentityError('api-attestation-invalid'); };
  if (!hasKeys(value, 'code,entry,flags,format,nodeOptions,pid,preloads,runtime,startedAt,version')
    || value.format !== ATTESTATION_FORMAT || value.version !== ATTESTATION_VERSION) invalid();
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.startedAt !== 'string'
    || !ISO_TIME.test(value.startedAt) || !Number.isFinite(Date.parse(value.startedAt))
    || new Date(value.startedAt).toISOString() !== value.startedAt) invalid();
  const { runtime, code } = value;
  if (!hasKeys(runtime, 'execPath,sha256,version') || !isPath(runtime.execPath) || typeof runtime.version !== 'string'
    || !NODE_VERSION.test(runtime.version) || typeof runtime.sha256 !== 'string' || !HEX64.test(runtime.sha256)) invalid();
  if (!isPath(value.entry) || !isTextList(value.preloads, 16) || !isTextList(value.flags, 64)
    || typeof value.nodeOptions !== 'boolean') invalid();
  if (!hasKeys(code, 'algorithm,digest') || code.algorithm !== CODE_IDENTITY_ALGORITHM || typeof code.digest !== 'string'
    || !HEX64.test(code.digest)) invalid();
  return Object.freeze({
    format: value.format, version: value.version, pid: value.pid, startedAt: value.startedAt,
    runtime: Object.freeze({ execPath: runtime.execPath, version: runtime.version, sha256: runtime.sha256 }),
    entry: value.entry, preloads: Object.freeze([...value.preloads]), flags: Object.freeze([...value.flags]),
    nodeOptions: value.nodeOptions, code: Object.freeze({ algorithm: code.algorithm, digest: code.digest }),
  });
}
