import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalManifest, MAX_FILE_BYTES, MAX_MANIFEST_BYTES, MAX_RELEASE_BYTES, MAX_RELEASE_FILES,
  parseManifest, RELEASE_FORMAT, RELEASE_PATH, releaseError, SHA256_HEX, SOURCE_COMMIT,
  validateReleaseContents, WebReleaseError, type ReleaseManifest,
} from './manifest.js';

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

function inspect(file: string, missing: string): fs.Stats {
  try {
    return fs.lstatSync(file);
  } catch {
    return releaseError(missing);
  }
}

function plainDirectory(dir: string): void {
  const stat = inspect(dir, 'E0I_RELEASE_PATH');
  if (stat.isSymbolicLink()) releaseError('E0I_RELEASE_SYMLINK');
  if (!stat.isDirectory()) releaseError('E0I_RELEASE_PATH');
}

function readPlainFile(file: string, limit: number, missing: string, limitsCode = 'E0I_RELEASE_LIMITS'): Buffer {
  const before = inspect(file, missing);
  if (before.isSymbolicLink()) releaseError('E0I_RELEASE_SYMLINK');
  if (!before.isFile()) releaseError('E0I_RELEASE_EXTRA');
  if (before.nlink !== 1) releaseError('E0I_RELEASE_HARDLINK');
  if (before.size > limit) releaseError(limitsCode);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return releaseError(missing);
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.nlink !== 1) releaseError('E0I_RELEASE_HASH');
    const buffer = Buffer.alloc(opened.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const count = fs.readSync(fd, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    const after = fs.fstatSync(fd);
    if (read !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1) releaseError('E0I_RELEASE_HASH');
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

export function readReleaseFiles(publicDir: string): Map<string, Buffer> {
  plainDirectory(publicDir);
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = (dir: string, relative: string): void => {
    const entries = fs.readdirSync(dir).sort();
    if (entries.length === 0) releaseError('E0I_RELEASE_EXTRA');
    if (entries.length > MAX_RELEASE_FILES + 1) releaseError('E0I_RELEASE_LIMITS');
    for (const name of entries) {
      if (name.startsWith('.')) releaseError('E0I_RELEASE_DOTFILE');
      const rel = relative ? `${relative}/${name}` : name;
      const full = path.join(dir, name);
      const stat = inspect(full, 'E0I_RELEASE_MISSING');
      if (stat.isSymbolicLink()) releaseError('E0I_RELEASE_SYMLINK');
      if (stat.isDirectory()) {
        if (rel !== 'assets') releaseError('E0I_RELEASE_EXTRA');
        walk(full, rel);
      } else {
        if (!RELEASE_PATH.test(rel)) releaseError('E0I_RELEASE_EXTRA');
        total += stat.size;
        if (files.size >= MAX_RELEASE_FILES || total > MAX_RELEASE_BYTES) releaseError('E0I_RELEASE_LIMITS');
        files.set(rel, readPlainFile(full, MAX_FILE_BYTES, 'E0I_RELEASE_MISSING'));
      }
    }
  };
  walk(publicDir, '');
  return files;
}

export function buildManifest(publicDir: string, sourceCommit: string): {
  manifest: ReleaseManifest; bytes: string; digest: string;
} {
  if (!SOURCE_COMMIT.test(sourceCommit)) releaseError('E0I_MANIFEST_INVALID');
  const contents = readReleaseFiles(publicDir);
  validateReleaseContents(contents);
  const bytes = canonicalManifest({
    format: RELEASE_FORMAT,
    sourceCommit,
    files: [...contents].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, body]) => ({ path: name, size: body.length, sha256: sha256(body) })),
  });
  return { manifest: parseManifest(bytes), bytes, digest: sha256(bytes) };
}

function readVerifiedRelease(dir: string, digest: string): {
  manifest: ReleaseManifest; files: ReadonlyMap<string, Buffer>; digest: string;
} {
  if (!path.isAbsolute(dir) || !SHA256_HEX.test(digest)) releaseError('E0I_RELEASE_CONFIG');
  const root = inspect(dir, 'E0I_RELEASE_PATH');
  if (!root.isDirectory() || root.isSymbolicLink() || fs.realpathSync(dir) !== dir
    || (process.getuid && root.uid !== process.getuid()) || (root.mode & 0o022) !== 0) {
    releaseError('E0I_RELEASE_PATH');
  }
  if (fs.readdirSync(dir).some((name) => name !== 'manifest.json' && name !== 'public')) releaseError('E0I_RELEASE_EXTRA');
  const bytes = readPlainFile(path.join(dir, 'manifest.json'), MAX_MANIFEST_BYTES, 'E0I_MANIFEST_MISSING', 'E0I_MANIFEST_INVALID');
  const manifest = parseManifest(bytes.toString('utf8'));
  if (!Buffer.from(canonicalManifest(manifest)).equals(bytes)) releaseError('E0I_MANIFEST_INVALID');
  if (sha256(bytes) !== digest) releaseError('E0I_MANIFEST_DIGEST');
  const files = readReleaseFiles(path.join(dir, 'public'));
  const expected = new Set(manifest.files.map((file) => file.path));
  for (const name of files.keys()) if (!expected.has(name)) releaseError('E0I_RELEASE_EXTRA');
  for (const file of manifest.files) {
    const body = files.get(file.path);
    if (!body) releaseError('E0I_RELEASE_MISSING');
    if (body.length !== file.size || sha256(body) !== file.sha256) releaseError('E0I_RELEASE_HASH');
  }
  validateReleaseContents(files);
  return { manifest, files, digest };
}

export function verifyRelease(dir: string, digest: string): ReturnType<typeof readVerifiedRelease> {
  try {
    return readVerifiedRelease(dir, digest);
  } catch (error) {
    if (error instanceof WebReleaseError) throw error;
    return releaseError('E0I_RELEASE_PATH');
  }
}
