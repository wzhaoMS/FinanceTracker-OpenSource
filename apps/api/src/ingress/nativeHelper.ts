import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@finance-tracker/shared/web-release/files';
import { SOURCE_COMMIT, SHA256_HEX, WebReleaseError } from '@finance-tracker/shared/web-release';

export const PATHCHECK_FORMAT = 'holdr-pathcheck/5';
export const NATIVE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../native');
export interface NativeManifest {
  format: 'holdr-native/1';
  reportFormat: typeof PATHCHECK_FORMAT;
  sourceCommit: string;
  sources: { 'holdr-pathcheck.c': string; 'acl_decode.h': string };
  binary: { path: 'holdr-pathcheck'; size: number; sha256: string };
}

export function nativeFailure(): never { throw new WebReleaseError('E0I_NATIVE_HELPER'); }
export const nativeManifestBytes = (manifest: NativeManifest) => JSON.stringify(manifest, null, 2) + '\n';

export function readNativeFile(file: string, limit: number, executable = false): Buffer {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !process.getuid || before.uid !== process.getuid()
    || before.mode & 0o022 || before.size > limit || (executable && !(before.mode & 0o100)) || fs.realpathSync(file) !== file) nativeFailure();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) nativeFailure();
    const bytes = Buffer.alloc(before.size + 1);
    let read = 0;
    while (read < bytes.length) {
      const n = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (!n) break;
      read += n;
    }
    const after = fs.fstatSync(fd);
    if (read !== before.size || after.size !== opened.size || after.ctimeMs !== opened.ctimeMs || after.mtimeMs !== opened.mtimeMs) nativeFailure();
    return bytes.subarray(0, read);
  } finally { fs.closeSync(fd); }
}

export interface NativePin { sourceCommit: string; manifestDigest: string; buildDir?: string; sourceDir?: string }

export function verifyPinnedNativeHelper(pin: NativePin) {
  if (!pin || !SOURCE_COMMIT.test(pin.sourceCommit ?? '') || !SHA256_HEX.test(pin.manifestDigest ?? '')) nativeFailure();
  return verifyNativeHelper(pin);
}

export function verifyNativeHelper(options: { buildDir?: string; sourceDir?: string; sourceCommit?: string; manifestDigest?: string } = {}) {
  try {
    if (process.platform !== 'darwin') nativeFailure();
    const sourceDir = options.sourceDir ?? NATIVE_DIR;
    const buildDir = options.buildDir ?? path.join(NATIVE_DIR, 'build');
    const bytes = readNativeFile(path.join(buildDir, 'native-manifest.json'), 8192);
    if (options.manifestDigest !== undefined && (!SHA256_HEX.test(options.manifestDigest) || sha256(bytes) !== options.manifestDigest)) nativeFailure();
    const value = JSON.parse(bytes.toString('utf8')) as NativeManifest;
    if (!value || value.format !== 'holdr-native/1' || value.reportFormat !== PATHCHECK_FORMAT
      || !SOURCE_COMMIT.test(value.sourceCommit) || (options.sourceCommit !== undefined && value.sourceCommit !== options.sourceCommit)
      || !value.sources || !value.binary || value.binary.path !== 'holdr-pathcheck'
      || !Number.isSafeInteger(value.binary.size) || value.binary.size < 1 || value.binary.size > 8 * 1024 * 1024) nativeFailure();
    const canonical: NativeManifest = {
      format: 'holdr-native/1', reportFormat: PATHCHECK_FORMAT, sourceCommit: value.sourceCommit,
      sources: { 'holdr-pathcheck.c': value.sources['holdr-pathcheck.c'], 'acl_decode.h': value.sources['acl_decode.h'] },
      binary: { path: 'holdr-pathcheck', size: value.binary.size, sha256: value.binary.sha256 },
    };
    if (nativeManifestBytes(canonical) !== bytes.toString('utf8')) nativeFailure();
    for (const name of ['holdr-pathcheck.c', 'acl_decode.h'] as const) {
      if (!SHA256_HEX.test(value.sources[name]) || sha256(readNativeFile(path.join(sourceDir, name), 1024 * 1024)) !== value.sources[name]) nativeFailure();
    }
    const binaryPath = path.join(buildDir, 'holdr-pathcheck');
    const binary = readNativeFile(binaryPath, 8 * 1024 * 1024, true);
    if (binary.length !== value.binary.size || !SHA256_HEX.test(value.binary.sha256) || sha256(binary) !== value.binary.sha256) nativeFailure();
    Object.freeze(canonical.sources);
    Object.freeze(canonical.binary);
    return Object.freeze({ binaryPath, manifestDigest: sha256(bytes), manifest: Object.freeze(canonical) });
  } catch { return nativeFailure(); }
}
