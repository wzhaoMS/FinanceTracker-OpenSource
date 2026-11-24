import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStateRepo } from '../../apps/api/src/services/sqliteStateRepo.js';
import { importFidelityInvesting, validateFidelityInvestingInput } from '../../apps/api/src/services/fidelityInvestingSync.js';
import { fidelityTransportAudit, validateFidelityTransport } from './transport.mjs';
import { readPrivateFile } from '../../apps/api/src/control/files.js';
import { withWriterLease } from '../../apps/api/src/control/writerDb.js';

export function canonical(file: string, directory: boolean): void {
  const stat = lstatSync(file);
  if (!path.isAbsolute(file) || path.resolve(file) !== file || realpathSync.native(file) !== file
    || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
    throw new Error('noncanonical import path');
  }
  if (directory && typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700)) {
    throw new Error('import directory must be private');
  }
}

/** Every table of a database by name, with its row count: what a backup of it must hold, exactly. */
function tablesAndCounts(db: Database.Database): string {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all() as string[];
  return JSON.stringify(names.map((name) =>
    [name, db.prepare(`SELECT count(*) FROM "${name.replaceAll('"', '""')}"`).pluck().get()]));
}

/**
 * Backs the database up to `destination`, a new file, and reads the copy back before the import may begin.
 * better-sqlite3 takes a backup's first busy step as done, which leaves the file empty (the backup sweep, 11/09). One
 * read transaction holds the tables counted here and the pages the backup copies, so the copy must hold exactly them.
 */
async function backUpAndReadBack(database: string, destination: string): Promise<void> {
  const original = new Database(database, { readonly: true, fileMustExist: true });
  try {
    closeSync(openSync(destination, 'wx', 0o600));
    original.exec('BEGIN');
    const counted = tablesAndCounts(original);
    await original.backup(destination);
    original.exec('COMMIT');
    const copy = new Database(destination, { fileMustExist: true });
    try {
      // A copy of a WAL database is marked WAL: in DELETE mode it stays one file, with no -wal or -shm beside it.
      copy.pragma('journal_mode = DELETE');
      if (tablesAndCounts(copy) !== counted) throw new Error('fidelity pre-open backup readback failed');
    } finally { copy.close(); }
  } finally { original.close(); }
}

/** Dependency overrides are for programmatic synthetic tests, never CLI flags or stdin. */
export async function runFidelityInvestingCli(args: string[], dependencies: {
  withLease?: typeof withWriterLease;
  readPolicy?: (file: string) => Buffer;
} = {}): Promise<number> {
  const stdin = args.includes('--stdin');
  const flags = stdin ? ['--db', '--policy', '--backup-directory', '--control-root']
    : ['--db', '--capture', '--policy', '--backup-directory', '--control-root'];
  if (args.length !== (stdin ? 10 : 11) || args[0] !== '--apply' || (stdin && args[1] !== '--stdin')
    || flags.some(flag => args.filter(a => a === flag).length !== 1)) {
    throw new Error('usage');
  }
  const values = new Map<string, string>();
  for (let i = stdin ? 2 : 1; i < args.length; i += 2) {
    if (!flags.includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('usage');
    values.set(args[i], args[i + 1]);
  }
  const directory = values.get('--backup-directory')!;
  const control = values.get('--control-root')!;
  const checkPaths = () => {
    for (const [flag, value] of values) canonical(value, flag === '--backup-directory' || flag === '--control-root');
    if (directory === control || directory.startsWith(`${control}${path.sep}`)) throw new Error('backup must be outside control root');
  };
  checkPaths();
  const readPolicy = dependencies.readPolicy ?? ((file: string) => {
    const bytes = readPrivateFile(file, { code: 'E0I_POLICY', limit: 1024 * 1024 });
    if (!bytes) throw new Error('missing private policy');
    return bytes;
  });
  const policy: unknown = JSON.parse(readPolicy(values.get('--policy')!).toString('utf8'));
  const envelope = stdin ? validateFidelityTransport(JSON.parse(readFileSync(0, 'utf8')), policy) : undefined;
  const capture: unknown = envelope?.capture ?? JSON.parse(readFileSync(values.get('--capture')!, 'utf8'));
  validateFidelityInvestingInput(capture, policy);
  return (dependencies.withLease ?? withWriterLease)({ ...process.env, HOLDR_CONTROL_DIR: control }, async () => {
    checkPaths();
    // The lifecycle shared lease and normal marker precede even the read-only DB open.
    await backUpAndReadBack(values.get('--db')!, path.join(directory, `fidelity-preopen-${randomUUID()}.sqlite`));
    checkPaths();
    const state = new SqliteStateRepo({ file: values.get('--db')! });
    try {
      const transport = envelope && fidelityTransportAudit(envelope);
      const receipt = await importFidelityInvesting(state, capture, policy, { backupDirectory: directory, transport });
      const held = receipt.accounts.some(a => a.status === 'held') || !!envelope?.heldSources.length;
      console.log(JSON.stringify(envelope
        ? { ...transport, captureDigest: receipt.captureDigest, status: held ? 'held' : 'complete', accounts: receipt.accounts }
        : { accounts: receipt.accounts }));
      return held ? 2 : 0;
    } finally { state.close(); }
  });
}
