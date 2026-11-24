import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { WebReleaseError } from '@finance-tracker/shared/web-release';
import { runBoundedCommand, type CommandResult } from './boundedCommand.js';
import { PATHCHECK_FORMAT, verifyPinnedNativeHelper, type NativePin } from './nativeHelper.js';
import type { SocketIdentity, SocketSafety } from './server.js';

const RIGHTS = [
  ['list', 0x2n], ['add_file', 0x4n], ['search', 0x8n], ['delete', 0x10n], ['add_subdirectory', 0x20n],
  ['delete_child', 0x40n], ['readattr', 0x80n], ['writeattr', 0x100n], ['readextattr', 0x200n],
  ['writeextattr', 0x400n], ['readsecurity', 0x800n], ['writesecurity', 0x1000n], ['chown', 0x2000n], ['synchronize', 0x100000n],
] as const;
const GENERICS = [
  ['generic_all', 0x200000n, 0x1ffen], ['generic_execute', 0x400000n, 0x8n],
  ['generic_write', 0x800000n, 0x1574n], ['generic_read', 0x1000000n, 0xa82n],
] as const;
const GENERIC_BITS = GENERICS.reduce((bits, [, bit]) => bits | bit, 0n);
const KNOWN_BITS = RIGHTS.reduce((bits, [, bit]) => bits | bit, GENERIC_BITS);
const FLAGS = ['inherited', 'file_inherit', 'directory_inherit', 'limit_inherit', 'only_inherit'];
const MUTATING = new Set(['delete', 'delete_child', 'add_file', 'add_subdirectory', 'writeattr', 'writeextattr', 'writesecurity', 'chown']);
const ERRORS = new Set([
  'filesec_init', 'fstatx_np', 'lstatx_np', 'filesec_get_property', 'acl_size', 'calloc', 'acl_copy_ext_native',
  'acl-unknown-layout', 'acl_get_entry', 'acl_get_tag_type', 'acl-unknown-tag', 'acl_get_qualifier', 'mbr_uuid_to_id',
  'acl-unknown-principal-type', 'acl_get_permset_mask_np', 'acl-unknown-rights-bits', 'acl_get_flagset_np',
  'acl_get_flag_np', 'metadata-unstable', 'open_memstream', 'fclose', 'write', 'open', 'openat', 'close', 'dot-segment', 'path-too-long',
]);
const ERRNOS = new Set(['EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'ENOENT', 'EIO', 'ENOMEM', 'EINVAL', 'EAGAIN', 'EOTHER']);

export interface AclEntry {
  readonly type: 'allow' | 'deny';
  readonly principal: 'uid' | 'gid';
  readonly id: number;
  readonly mask: string;
  readonly generic: readonly string[];
  readonly perms: readonly string[];
  readonly flags: readonly string[];
}
export interface PathObject extends SocketIdentity {
  readonly kind: 'dir' | 'socket';
  readonly path: string;
  readonly type: 'dir' | 'socket' | 'symlink' | 'other';
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly aclPresent: boolean;
  readonly acl: readonly AclEntry[];
}
export type PathRecord = PathObject | { readonly kind: 'absent'; readonly path: string };
export type PathCheck = { readonly ok: true; readonly objects: readonly PathRecord[] }
  | { readonly ok: false; readonly code: string };

export function socketAncestors(socketPath: string): string[] {
  if (!socketPath.startsWith('/') || path.posix.normalize(socketPath) !== socketPath || socketPath.endsWith('/')
    || Buffer.byteLength(socketPath) > 100 || /[\x00-\x1f\x7f]/.test(socketPath)) throw new WebReleaseError('E0I_SOCKET_PATH');
  const parts = socketPath.split('/').slice(1, -1);
  return ['/', ...parts.map((_part, index) => '/' + parts.slice(0, index + 1).join('/'))];
}

export function decodeAclMask(mask: string): { generic: string[]; perms: string[] } | null {
  if (!/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(mask)) return null;
  const raw = BigInt(mask);
  if (raw & ~KNOWN_BITS) return null;
  let expanded = raw & ~GENERIC_BITS;
  for (const [, bit, bits] of GENERICS) if (raw & bit) expanded |= bits;
  return {
    generic: GENERICS.filter(([, bit]) => raw & bit).map(([name]) => name),
    perms: RIGHTS.filter(([, bit]) => expanded & bit).map(([name]) => name),
  };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
const uint = (value: unknown, max = 0xffffffff): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const orderedNames = (value: unknown, names: readonly string[]) => Array.isArray(value)
  && value.every((name, index) => typeof name === 'string' && names.includes(name) && (index === 0 || names.indexOf(name) > names.indexOf(value[index - 1])));
const identity = (value: unknown, signed = false) => typeof value === 'string'
  && (signed ? /^(?:0|-?[1-9][0-9]{0,19})$/ : /^(?:0|[1-9][0-9]{0,19})$/).test(value)
  && BigInt(value) >= (signed ? -(1n << 63n) : 0n) && BigInt(value) < (signed ? 1n << 63n : 1n << 64n);

function validRecord(value: unknown, expectedPath: string, endpoint: boolean): value is PathRecord {
  if (!object(value) || value.path !== expectedPath) return false;
  if (endpoint && value.kind === 'absent') return keys(value, ['kind', 'path']);
  if (value.kind !== (endpoint ? 'socket' : 'dir')
    || !keys(value, ['kind', 'path', 'type', 'uid', 'gid', 'mode', 'dev', 'ino', 'aclPresent', 'acl'])
    || !['dir', 'socket', 'symlink', 'other'].includes(value.type as string) || !uint(value.uid) || !uint(value.gid) || !uint(value.mode, 0o7777)
    || !identity(value.dev, true) || !identity(value.ino) || typeof value.aclPresent !== 'boolean'
    || !Array.isArray(value.acl) || value.acl.length > 128 || (!value.aclPresent && value.acl.length !== 0)) return false;
  return value.acl.every((entry: unknown) => {
    if (!object(entry) || !keys(entry, ['type', 'principal', 'id', 'mask', 'generic', 'perms', 'flags'])
      || !['allow', 'deny'].includes(entry.type as string) || !['uid', 'gid'].includes(entry.principal as string) || !uint(entry.id)
      || typeof entry.mask !== 'string' || !orderedNames(entry.flags, FLAGS)) return false;
    const decoded = decodeAclMask(entry.mask);
    return decoded !== null && JSON.stringify(entry.generic) === JSON.stringify(decoded.generic) && JSON.stringify(entry.perms) === JSON.stringify(decoded.perms);
  });
}

export function parsePathcheck(result: CommandResult, socketPath: string): PathCheck {
  const invalid = (): PathCheck => ({ ok: false, code: 'pathcheck-output-invalid' });
  let expected: string[];
  try { expected = [...socketAncestors(socketPath), socketPath]; } catch { return invalid(); }
  if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 256 * 1024 || !result.stdout.endsWith('\n')) {
    return result.exitCode === 0 ? invalid() : { ok: false, code: 'acl-acquisition-failed' };
  }
  let lines: unknown[];
  try {
    lines = result.stdout.slice(0, -1).split('\n').map((line) => {
      const value: unknown = JSON.parse(line);
      if (JSON.stringify(value) !== line) throw Error('noncanonical line');
      return value;
    });
  } catch { return invalid(); }
  const header = lines.shift();
  if (!object(header) || !keys(header, ['format']) || header.format !== PATHCHECK_FORMAT) return invalid();
  const terminal = lines.pop();
  if (lines.length > expected.length || lines.some((line, index) => !validRecord(line, expected[index], index === expected.length - 1))) return invalid();
  if (result.exitCode === 2) {
    if (!object(terminal) || !keys(terminal, ['error', 'path', 'errno', 'code']) || !ERRORS.has(terminal.error as string)
      || !expected.includes(terminal.path as string) || !ERRNOS.has(terminal.errno as string) || !uint(terminal.code) || terminal.code === 0) return invalid();
    const error = terminal.error as string;
    return { ok: false, code: error === 'metadata-unstable' ? 'metadata-unstable'
      : error.startsWith('acl-unknown-') ? 'acl-unrecognized'
      : error === 'openat' && ['ELOOP', 'ENOTDIR'].includes(terminal.errno as string) ? 'not-a-plain-directory'
      : error === 'openat' && terminal.errno === 'ENOENT' ? 'missing' : 'acl-acquisition-failed' };
  }
  if (result.exitCode !== 0) return { ok: false, code: 'acl-acquisition-failed' };
  if (!object(terminal) || !keys(terminal, ['done', 'objects']) || terminal.done !== true || terminal.objects !== expected.length
    || lines.length !== expected.length) return invalid();
  // JSON ownership stays inside the verifier; freeze all arrays/entries before exposing facts.
  const freeze = (value: unknown): unknown => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  return { ok: true, objects: freeze(lines) as readonly PathRecord[] };
}

export interface PathFinding { readonly path: string; readonly code: string }
export function evaluateSocketPath(objects: readonly PathRecord[], options: {
  holdrUid: number; phase: 'boot' | 'preflight' | 'poll'; identity?: SocketIdentity;
}): { ok: boolean; findings: PathFinding[]; socket?: PathObject } {
  const findings: PathFinding[] = [];
  const add = (entry: PathRecord, code: string) => findings.push({ path: entry.path, code });
  const dirs = objects.filter((entry): entry is PathObject => entry.kind === 'dir');
  const runDir = dirs.at(-1);
  const trusted = (entry: AclEntry) => entry.principal === 'uid' && (entry.id === 0 || entry.id === options.holdrUid);
  for (const dir of dirs) {
    if (dir.type !== 'dir') add(dir, 'not-a-plain-directory');
    if (dir.uid !== 0 && dir.uid !== options.holdrUid) add(dir, 'foreign-owner');
    if (dir.mode & 0o022) add(dir, 'group-or-other-writable');
    for (const ace of dir.acl) {
      if (ace.type !== 'allow' || trusted(ace)) continue;
      if (ace.perms.some((right) => MUTATING.has(right))) add(dir, 'acl-allows-modify');
      if (dir === runDir) add(dir, 'endpoint-reachable');
    }
  }
  if (!runDir) findings.push({ path: '/', code: 'missing' });
  else {
    if (runDir.uid !== options.holdrUid) add(runDir, 'run-dir-not-owned');
    if (runDir.mode !== 0o700) add(runDir, 'endpoint-reachable');
  }
  const socket = objects.find((entry): entry is PathObject => entry.kind === 'socket');
  if (socket) {
    if (socket.type !== 'socket') add(socket, 'not-a-socket');
    if (socket.uid !== options.holdrUid) add(socket, 'foreign-owner');
    if (socket.mode & 0o077) add(socket, 'socket-mode');
    if (socket.acl.some((ace) => ace.type === 'allow' && !trusted(ace))) add(socket, 'endpoint-reachable');
    if (options.phase === 'poll' && (!options.identity || socket.dev !== options.identity.dev || socket.ino !== options.identity.ino)) add(socket, 'socket-replaced');
  } else if (options.phase === 'poll') findings.push({ path: objects.at(-1)?.path ?? '/', code: 'socket-missing' });
  return { ok: findings.length === 0, findings, socket };
}

export async function runPathcheck(socketPath: string, native: NativePin): Promise<PathCheck> {
  socketAncestors(socketPath);
  const helper = verifyPinnedNativeHelper(native);
  const result = await runBoundedCommand(helper.binaryPath, [socketPath], {
    timeoutMs: 5000, maxBuffer: 256 * 1024, env: { PATH: '/usr/bin:/bin' },
  });
  return parsePathcheck(result, socketPath);
}

async function connectionState(socketPath: string): Promise<'live' | 'stale' | 'unknown'> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const finish = (state: 'live' | 'stale' | 'unknown') => { socket.destroy(); resolve(state); };
    socket.setTimeout(1000, () => finish('unknown'));
    socket.once('connect', () => finish('live'));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED' ? 'stale' : 'unknown'));
  });
}

export function createSocketSafety(options: {
  socketPath: string; native: NativePin;
}) {
  socketAncestors(options.socketPath);
  let bound: SocketIdentity | undefined;
  const inspect = async (phase: 'boot' | 'preflight' | 'poll', expected = bound): Promise<ReturnType<typeof evaluateSocketPath>> => {
    const parsed = await runPathcheck(options.socketPath, options.native);
    if (!parsed.ok) return { ok: false, findings: [{ path: options.socketPath, code: parsed.code }] };
    return evaluateSocketPath(parsed.objects, { holdrUid: process.getuid!(), phase, identity: expected });
  };
  const assertSafe = async (phase: 'boot' | 'preflight' | 'poll', expected?: SocketIdentity) => {
    const result = await inspect(phase, expected);
    if (!result.ok) throw new WebReleaseError('E0I_SOCKET_DIR');
    return result;
  };
  const safety: SocketSafety = {
    async beforeListen(socketPath) {
      if (socketPath !== options.socketPath) throw new WebReleaseError('E0I_SOCKET_PATH');
      bound = undefined;
      const result = await assertSafe('boot');
      if (!result.socket) return;
      if (await connectionState(socketPath) !== 'stale') throw new WebReleaseError('E0I_SOCKET_IN_USE');
      const again = await assertSafe('poll', result.socket);
      const actual = fs.lstatSync(socketPath, { bigint: true });
      if (!again.socket || actual.dev.toString() !== again.socket.dev || actual.ino.toString() !== again.socket.ino) throw new WebReleaseError('E0I_SOCKET_IN_USE');
      fs.unlinkSync(socketPath);
      await assertSafe('boot');
    },
    async afterListen(socketPath, identity) {
      if (socketPath !== options.socketPath || !identity) throw new WebReleaseError('E0I_BIND_UNEXPECTED');
      await assertSafe('poll', identity);
      bound = Object.freeze({ ...identity });
    },
  };
  return {
    safety,
    inspect,
    identity: () => bound,
    async preflight(isOwnedByRunningApi?: (identity: SocketIdentity) => Promise<boolean>) {
      const result = await assertSafe('preflight');
      if (result.socket) {
        const connection = await connectionState(options.socketPath);
        if (connection === 'unknown' || (connection === 'live'
          && (!isOwnedByRunningApi || !await isOwnedByRunningApi(result.socket)))) throw new WebReleaseError('E0I_SOCKET_IN_USE');
      }
      return result;
    },
  };
}
