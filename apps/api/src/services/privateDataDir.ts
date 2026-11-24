import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { POWERSHELL_TIMEOUT_MS, restrictToUser, system32, takeOwnership } from '../e2e/windowsAcl.js';

/** How a new data folder is made private on Windows; injected by tests. */
export interface WindowsFolderPrivacy {
  currentUserSid(): string;
  restrict(dir: string, sid: string): void;
}

/** The current user's SID from `whoami /user /fo csv /nh` ("DOMAIN\name","S-1-…"), which answers faster than PowerShell. */
export function parseWhoamiUserSid(output: string): string {
  const match = /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(output.trim());
  if (!match) throw new Error("whoami did not report the current user's SID");
  return match[1];
}

const windowsFolderPrivacy: WindowsFolderPrivacy = {
  currentUserSid: () => parseWhoamiUserSid(execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true,
  })),
  restrict: (dir, sid) => {
    restrictToUser(dir, sid);
    takeOwnership(dir, sid);
  },
};

/**
 * Create `dir` and every missing folder above it, each private to the current user: mode 0700 on macOS and Linux; on
 * Windows, where a new folder would inherit its parent's ACL (often readable by other accounts), an ACL for the current
 * user and SYSTEM only, owned by the current user. Folders that already exist are left as they are. Returns the folders
 * it created, outermost first. When a new folder cannot be made private, the folders it created are removed again (if
 * still empty) and it throws.
 */
export function ensurePrivateDataDir(
  dir: string, platform: NodeJS.Platform = process.platform, windows: WindowsFolderPrivacy = windowsFolderPrivacy,
): string[] {
  const missing: string[] = [];
  for (let current = path.resolve(dir); !fs.existsSync(current);) {
    missing.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (missing.length === 0) return missing;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') return missing;
  try {
    const sid = windows.currentUserSid();
    for (const created of missing) windows.restrict(created, sid);
  } catch (error) {
    for (const created of [...missing].reverse()) {
      try {
        fs.rmdirSync(created);
      } catch {
        // Not empty, or already gone: leave it.
      }
    }
    throw new Error(`could not make the new data folder ${dir} private to the current user: ${(error as Error).message}`);
  }
  return missing;
}
