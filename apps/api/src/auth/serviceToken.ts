import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Service token for local scripts and the card sync agent. Generated on the API's first
 * start into the data directory (mode 0600) and accepted only as
 * `Authorization: Bearer <token>` on direct loopback connections, never
 * through the web proxy. Delete the file and restart the API to rotate it.
 * It can change data; AI agents read with the agent token instead
 * (auth/agentToken.ts), which is made the same way by loadOrCreateTokenFile.
 */

export const SERVICE_TOKEN_FILE_NAME = 'service-token';

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export interface LoadedServiceToken {
  token: string;
  created: boolean;
  /** The file was group/world accessible and has been reset to 0600. */
  repairedMode: boolean;
}

/** A kind of token file: its name in errors, how a new value is made, and what a valid value looks like. */
export interface TokenFileKind {
  label: string;
  generate(): string;
  pattern: RegExp;
}

const SERVICE_TOKEN_KIND: TokenFileKind = {
  label: 'service token',
  generate: () => randomBytes(32).toString('hex'),
  pattern: TOKEN_PATTERN,
};

function createExclusively(file: string, value: string): boolean {
  // Write a complete temp file, then hard-link it into place: the link fails if
  // the token already exists, and readers never observe a half-written file.
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${value}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function loadOrCreateServiceToken(file: string): LoadedServiceToken {
  return loadOrCreateTokenFile(file, SERVICE_TOKEN_KIND);
}

/**
 * Reads the token in `file`, first creating it with a new value when it does not exist: a regular file of this user's,
 * mode 0600 (tightened if looser, except on Windows, where it has its directory's ACL), holding one valid value.
 */
export function loadOrCreateTokenFile(file: string, kind: TokenFileKind): LoadedServiceToken {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const created = fs.existsSync(file) ? false : createExclusively(file, kind.generate());
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error(`${kind.label} ${file} is not a regular file`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${kind.label} ${file} is owned by another user`);
  }
  let repairedMode = false;
  // Mode bits say nothing on Windows (Node reports 0o666 whatever the ACL,
  // and chmod cannot change it), so they are neither checked nor "repaired"
  // there; the file has its directory's ACL (for an e2e run, the run
  // directory, which the runner restricts to the user and SYSTEM).
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    fs.chmodSync(file, 0o600);
    repairedMode = true;
  }
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!kind.pattern.test(token)) {
    throw new Error(`${kind.label} ${file} is malformed; delete it and restart the API to generate a new one`);
  }
  return { token, created, repairedMode };
}

/** Constant-time comparison that does not leak the expected token's length. */
export function serviceTokenMatches(expected: string, presented: string): boolean {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}
