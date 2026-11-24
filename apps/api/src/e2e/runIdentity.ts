import fs from 'node:fs';
import path from 'node:path';

import { dataFilesIn } from '../dataDir.js';
import { exactIdentityOrNull, identityOf } from './pathSafety.js';
import { assertDisposableDataDir, assertDisposableDataDirAsync } from './syntheticSeed.js';

/**
 * The run identity /health reports when HOLDR_E2E_RUN_ID is set. Only
 * scripts/e2e-disposable.mjs sets it, to a fresh random value per run, and it
 * hands the same value to Playwright, whose global setup refuses to run
 * unless the API behind WEB_URL reports it. A production API never has one.
 * An API started with one first runs the seed's read-only check,
 * assertDisposableDataDir, on its data directory and refuses to start unless
 * it passes. The directory and every directory above it must be private,
 * the seed's marker must already exist, and only SQLite's own files may sit
 * next to it, each a regular, singly linked file of ours (on Windows also by
 * its own owner and ACL, which the directory's do not cover). From then on the
 * API opens its files only through the physical directory the check
 * resolved, never through HOLDR_DATA_DIR as given: a symlink on that path
 * could be retargeted after the check.
 *
 * Every later check, before each open, after the SQLite open and on every
 * /health, is the same: the directory's device and inode, then the startup
 * check again in full (the directory, every directory above it and its
 * entries, on Windows their owners and ACLs read again in one PowerShell
 * call), then the files the API opened (device and inode recorded right
 * after the SQLite open), then the directory's device and inode again, all
 * read exactly (as bigints: NTFS file IDs can exceed 2^53). Both lstats must
 * find the directory that passed the check, so the inspection cannot have
 * looked at a replacement. Nothing is cached between checks, so a changed
 * mode or ACL shows at the next one. /health runs it without blocking the
 * event loop and reports disposableDataDir: false once any part fails.
 * src/index.ts imports this module only when the variable is set.
 */
export interface E2eRunIdentity {
  runId: string;
  /** The data directory and the database files are still the ones the API checked and opened. */
  disposableDataDir: boolean;
}

/** A data directory that passed the check, and the files in it the API may open. */
export interface E2eDataDir {
  /** The physical directory that passed the check (no symlink on the way). */
  dataDir: string;
  /** state.json and finance.db inside `dataDir`. */
  jsonFile: string;
  dbFile: string;
  /** Throw unless the data directory is unchanged (see above). Run before each open. */
  assertUnchanged(): void;
  /** Record the device and inode of finance.db, and of -wal and -shm if present, right after the SQLite open. */
  recordOpened(): void;
  /** What /health reports: the same check as assertUnchanged, false on any failure. */
  identity(): Promise<E2eRunIdentity>;
}

/** 128 random bits, as the runner generates them. */
export const RUN_ID_PATTERN = /^[0-9a-f]{32}$/;

/** The files SQLite holds open for the API, compared by identity once opened. */
const OPENED_FILES = ['finance.db', 'finance.db-wal', 'finance.db-shm'] as const;

function plainDirectoryIdentity(dir: string): string {
  const stats = fs.lstatSync(dir, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${dir} is not a plain directory`);
  return identityOf(stats);
}

/** Whether `dataDir` passes the seed's read-only check (creates nothing). */
export function isDisposableDataDir(dataDir: string): boolean {
  try {
    assertDisposableDataDir(dataDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check HOLDR_E2E_RUN_ID and the data directory before the API opens it.
 * Throws for a malformed identity or a directory that is not disposable.
 */
export function createRunIdentity(runId: string, dataDir: string): E2eDataDir {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('HOLDR_E2E_RUN_ID must be 32 lowercase hex characters (scripts/e2e-disposable.mjs makes a random one per run)');
  }
  let resolved: string;
  let checked: string;
  try {
    // The physical directory must be the same before and after the check.
    const physical = fs.realpathSync(path.resolve(dataDir));
    checked = plainDirectoryIdentity(physical);
    resolved = assertDisposableDataDir(dataDir);
    if (resolved !== physical || plainDirectoryIdentity(resolved) !== checked) {
      throw new Error(`${physical} changed while it was being checked`);
    }
  } catch (error) {
    throw new Error(
      `HOLDR_E2E_RUN_ID is set, but ${dataDir} is not a disposable e2e data directory `
      + `(${(error as Error).message}); refusing to start`,
    );
  }

  /** Device and inode of each file the API opened, or is about to open. */
  const opened = new Map<string, string>();

  function sameDirectory(problem: string): void {
    if (plainDirectoryIdentity(resolved) !== checked) throw new Error(`${resolved} ${problem}`);
  }

  function stillChecked(physical: string): void {
    if (physical !== resolved) throw new Error(`${resolved} now resolves to ${physical}`);
  }

  function stillOpened(): void {
    for (const [name, identity] of opened) {
      if (exactIdentityOrNull(path.join(resolved, name)) !== identity) {
        throw new Error(`${path.join(resolved, name)} is no longer the file the API opened`);
      }
    }
  }

  function verify(): void {
    sameDirectory('is no longer the data directory that passed the e2e check');
    stillChecked(assertDisposableDataDir(resolved));
    stillOpened();
    sameDirectory('was replaced while it was being checked');
  }

  async function verifyAsync(): Promise<void> {
    sameDirectory('is no longer the data directory that passed the e2e check');
    stillChecked(await assertDisposableDataDirAsync(resolved));
    stillOpened();
    sameDirectory('was replaced while it was being checked');
  }

  /** Pin `name`'s identity; one pinned before the open must still match. */
  function pin(name: string, required: boolean): void {
    const file = path.join(resolved, name);
    const identity = exactIdentityOrNull(file);
    if (identity === null) {
      if (required) throw new Error(`${file} is missing after the open`);
      return;
    }
    const before = opened.get(name);
    if (before !== undefined && before !== identity) throw new Error(`${file} was replaced while the API was opening it`);
    opened.set(name, identity);
  }

  return {
    dataDir: resolved,
    ...dataFilesIn(resolved),
    assertUnchanged() {
      verify();
      // The database the API is about to open, if it exists already.
      pin('finance.db', false);
    },
    recordOpened() {
      sameDirectory('is no longer the data directory that passed the e2e check');
      for (const name of OPENED_FILES) pin(name, name === 'finance.db');
      verify();
    },
    async identity() {
      try {
        await verifyAsync();
        return { runId, disposableDataDir: true };
      } catch {
        return { runId, disposableDataDir: false };
      }
    },
  };
}
