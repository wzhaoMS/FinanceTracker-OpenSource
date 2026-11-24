import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebReleaseError } from '@finance-tracker/shared/web-release';
import type { AttestationView } from './attestation.js';

export function writeAttestationStatus(file: string, state: AttestationView): void {
  const dir = path.dirname(file);
  const root = fs.lstatSync(dir);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.()
    || (root.mode & 0o7777) !== 0o700 || fs.realpathSync(dir) !== dir) throw new WebReleaseError('E0I_SOCKET_DIR');
  try {
    const existing = fs.lstatSync(file);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== root.uid || existing.nlink !== 1
      || (existing.mode & 0o7777) !== 0o600) throw new WebReleaseError('E0I_SOCKET_DIR');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = path.join(dir, `.attestation-${process.pid}-${randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify({
        format: 'holdr-ingress-state/1', ...state,
        runtime: { platform: process.platform, node: process.versions.node, uv: process.versions.uv },
      }) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { fs.rmSync(temporary, { force: true }); }
}
