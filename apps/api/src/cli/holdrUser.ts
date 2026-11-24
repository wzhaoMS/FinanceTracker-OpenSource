import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { DEFAULT_SCRYPT_PARAMS, MAX_PASSWORD_LENGTH, hashPassword, passwordProblem, type ScryptParams } from '../auth/password.js';
import { changeWithAuthorizationLockHeld, reconcileChangeBlock, type AuthorizationFenceContext } from '../control/authorizationChange.js';
import { configuredControlDir } from '../control/controlDir.js';
import { ControlError } from '../control/errors.js';
import { systemRunner } from '../control/exec.js';
import { existingAncestor } from '../control/files.js';
import { loadConfiguration } from '../control/holdrConf.js';
import { leaseEnvPresent, withAuthorizationLock } from '../control/lifecycle.js';
import { computeMachineId } from '../control/machineId.js';
import type { Runner } from '../control/runner.js';
import { openWriterDb } from '../control/writerDb.js';
import { cardSyncActorRef } from '../services/cardSyncDigests.js';
import { cardSyncRefusalCode } from '../services/cardSync/refusals.js';
import { newGeneration } from '../control/syncAuthState.js';
import { resolveDataPaths } from '../dataDir.js';
import { DEMO_MARKER, demoFolderAround } from '../demo/demoMarker.js';
import type { E2eDataDir } from '../e2e/runIdentity.js';
import { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { LocalAuthRepo, UserExistsError, normalizeUsername, usernameProblem } from '../services/localAuthRepo.js';

/**
 * Server-side account management for Holdr sign-in (there is no signup
 * endpoint). Run on the machine that holds the database:
 *
 *   npm run holdr-user -- add <username>
 *   npm run holdr-user -- passwd <username>
 *   npm run holdr-user -- list
 *   npm run holdr-user -- remove <username>
 *
 * Passwords are typed without echo, or piped with --password-stdin. The CLI
 * writes straight to SQLite (WAL), so it works while the API is running.
 *
 * Like the API, it reads holdr.conf (HOLDR_CONFIG, else the default path when
 * present) so a command typed on the Holdr server opens the configured data dir, and
 * with a control dir it takes part in the lifecycle protocol: a shared
 * lifecycle lease, then the marker normal, before the database opens (exit 75
 * while maintenance holds the lock, exit 3 in maintenance).
 *
 * `passwd` and `remove` also end that user's browser credentials for card sync (E1b design §10 item 6): every browser
 * the user paired that is not yet revoked, expired ones included, is revoked `password-reset`, each one a narrowing
 * authorization change. One host authorization lock spans enumeration, every revocation and the durable credential/session
 * invalidation, including when there are no devices. Owner changes revalidate the original session and credential epoch
 * inside that lock, so an already-authenticated request cannot revive authority after reset/removal completes.
 * A busy lock refuses the command (exit 75) with nothing changed.
 *
 * With HOLDR_E2E_RUN_ID set (scripts/e2e-disposable.mjs creates its sign-in
 * user this way) the CLI applies the API's disposable-directory rules: it
 * refuses any data directory that may hold real data and works only in the
 * physical directory that passed the check (src/e2e/runIdentity.ts).
 *
 * It refuses a data directory in the demo's folder (one that holds `.holdr-demo`,
 * src/demo/demoMarker.ts): `npm run demo` deletes that folder whenever it makes the
 * demo again, so a real household's users and data must never live there.
 */

export const USAGE = `Usage: npm run holdr-user -- <command> [options]

Commands:
  add <username>      Create a user (asks for the password twice)
  passwd <username>   Set a new password and sign that user out everywhere
  list                List users and their active sessions
  remove <username>   Delete a user and end all of their sessions

Options:
  --password-stdin    Read the password (one line) from standard input instead of prompting;
                      in PowerShell pipe it into npm.cmd, not npm:
                      $pw | npm.cmd run holdr-user -- add <username> --password-stdin
  --yes               Skip the confirmation for remove
  --data-dir <dir>    API data directory (default: HOLDR_DATA_DIR, which npm run holdr-user
                      sets to your per-user data folder; else apps/api/data)
  -h, --help          Show this help
`;

export type CliStdin = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

export interface CliIo {
  stdin: CliStdin;
  stdout: Writable;
  stderr: Writable;
}

export interface CliOptions {
  io: CliIo;
  env?: Record<string, string | undefined>;
  cwd?: string;
  defaultDataDir: string;
  scryptParams?: ScryptParams;
  now?: () => Date;
  /** Runs ioreg/df/diskutil for this machine's id (the fence names it); tests pass a synthetic system. */
  run?: Runner;
}

class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

interface ParsedArgs {
  command?: string;
  username?: string;
  passwordStdin: boolean;
  yes: boolean;
  dataDir?: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { passwordStdin: false, yes: false, help: false };
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--password-stdin') parsed.passwordStdin = true;
    else if (arg === '--yes' || arg === '-y') parsed.yes = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--data-dir') {
      const value = argv[index + 1];
      if (!value) throw new CliError('--data-dir needs a directory', 2);
      parsed.dataDir = value;
      index += 1;
    } else if (arg.startsWith('--data-dir=')) parsed.dataDir = arg.slice('--data-dir='.length);
    else if (arg.startsWith('-')) throw new CliError(`unknown option ${arg}`, 2);
    else positionals.push(arg);
  }
  [parsed.command, parsed.username] = positionals;
  if (positionals.length > 2) throw new CliError(`unexpected argument ${positionals[2]}`, 2);
  return parsed;
}

/** Reads a line from a terminal without echoing it. */
function promptHidden(io: CliIo, question: string): Promise<string> {
  const { stdin, stderr } = io;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    // PowerShell's npm.ps1 drops the `--` when input is piped, so npm itself takes --password-stdin and this never sees it.
    return Promise.reject(new CliError('standard input is not a terminal; pipe the password with --password-stdin '
      + '(in PowerShell, pipe into npm.cmd rather than npm, which drops the -- before the options)'));
  }
  stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    let inEscape = false;
    const finish = (error?: Error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (inEscape) {
          // Swallow terminal escape sequences such as arrow keys.
          if (/[A-Za-z~]/.test(ch)) inEscape = false;
          continue;
        }
        if (ch === '\u001b') inEscape = true;
        else if (ch === '\r' || ch === '\n') return finish();
        else if (ch === '\u0003' || (ch === '\u0004' && value === '')) return finish(new CliError('cancelled'));
        else if (ch === '\u007f' || ch === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (ch === '\u0015') value = '';
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode!(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function readPasswordFromStdin(stdin: CliStdin): Promise<string> {
  stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of stdin) {
    data += String(chunk);
    if (data.length > MAX_PASSWORD_LENGTH * 4) throw new CliError('password on standard input is too long');
  }
  const password = data.replace(/\r?\n$/, '');
  if (/[\r\n]/.test(password)) throw new CliError('password on standard input must be a single line');
  if (!password) throw new CliError('no password on standard input');
  return password;
}

function promptLine(io: CliIo, question: string): Promise<string> {
  const rl = createInterface({ input: io.stdin, output: io.stderr, terminal: false });
  return new Promise((resolve) => {
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
    rl.once('close', () => {
      if (!answered) resolve('');
    });
  });
}

async function readNewPassword(io: CliIo, args: ParsedArgs, username: string): Promise<string> {
  const password = args.passwordStdin
    ? await readPasswordFromStdin(io.stdin)
    : await promptHidden(io, `New password for ${username}: `);
  const problem = passwordProblem(password, username);
  if (problem) throw new CliError(problem);
  if (!args.passwordStdin && await promptHidden(io, 'Repeat the password: ') !== password) {
    throw new CliError('passwords do not match');
  }
  return password;
}

function resolveDataDir(args: ParsedArgs, options: CliOptions, env: Readonly<Record<string, string | undefined>>, fromFile: boolean): string {
  const cwd = options.cwd ?? process.cwd();
  if (args.dataDir) {
    const chosen = path.resolve(cwd, args.dataDir);
    // holdr.conf pins the data dir (B-D10): a different --data-dir would bypass the configured lifecycle protocol.
    if (fromFile && chosen !== env.HOLDR_DATA_DIR) {
      throw new CliError('--data-dir differs from HOLDR_DATA_DIR in holdr.conf (E0I_CONFIG_FILE)');
    }
    return chosen;
  }
  // The API's own rule (src/dataDir.ts): HOLDR_DATA_DIR, else apps/api/data. A
  // disposable stack that sets it never gets its users written into the live database.
  return resolveDataPaths(env, options.defaultDataDir, cwd).dataDir;
}

/** With HOLDR_E2E_RUN_ID: the checked disposable directory, or a refusal (see the file comment). */
async function e2eDataDirFor(dataDir: string, options: CliOptions): Promise<E2eDataDir | null> {
  const runId = options.env?.HOLDR_E2E_RUN_ID?.trim();
  if (!runId) return null;
  const { createRunIdentity } = await import('../e2e/runIdentity.js');
  try {
    return createRunIdentity(runId, dataDir);
  } catch (error) {
    throw new CliError((error as Error).message);
  }
}

function requireUsername(args: ParsedArgs): string {
  if (!args.username) throw new CliError(`${args.command} needs a username\n\n${USAGE}`, 2);
  const username = normalizeUsername(args.username);
  const problem = usernameProblem(username);
  if (problem) throw new CliError(problem);
  return username;
}

export async function runHoldrUserCli(argv: string[], options: CliOptions): Promise<number> {
  const { io } = options;
  const now = options.now ?? (() => new Date());
  const scryptParams = options.scryptParams ?? DEFAULT_SCRYPT_PARAMS;
  let repo: SqliteStateRepo | null = null;
  let writer: { close(): void } | null = null;
  try {
    // The lease-variable contract (§9.3 rule 4): no ordinary CLI runs inside a maintenance lease.
    if (leaseEnvPresent(options.env ?? {})) throw new CliError('E0I_LEASE_ENV (holdr-user does not run inside a maintenance lease)');
    const args = parseArgs(argv);
    if (args.help || !args.command) {
      (args.help ? io.stdout : io.stderr).write(USAGE);
      return args.help ? 0 : 2;
    }
    if (!['add', 'passwd', 'list', 'remove'].includes(args.command)) {
      throw new CliError(`unknown command ${args.command}\n\n${USAGE}`, 2);
    }
    const username = args.command === 'list' ? '' : requireUsername(args);
    if (args.command === 'list' && args.username) throw new CliError('list takes no username', 2);

    let config: ReturnType<typeof loadConfiguration>;
    try {
      config = loadConfiguration(options.env ?? {});
    } catch (error) {
      throw new CliError(controlMessage(error));
    }
    const env = config.env;
    const dataDir = resolveDataDir(args, options, env, config.conf?.values.HOLDR_DATA_DIR !== undefined);
    const demoFolder = demoFolderAround(dataDir);
    if (demoFolder) {
      throw new CliError(`${dataDir} is in the demo's folder ${demoFolder} (it holds ${DEMO_MARKER}), and npm run demo deletes that folder `
        + 'whenever it makes the demo again, so holdr-user does not work there. The demo signs in as demo, with the password npm run demo '
        + 'prints; for your own users leave out --data-dir and HOLDR_DATA_DIR, or choose a folder of your own.');
    }
    const e2eDir = await e2eDataDirFor(dataDir, options);
    const dbFile = e2eDir?.dbFile ?? path.join(dataDir, 'finance.db');
    const exists = fs.existsSync(dbFile);
    if (!exists && args.command !== 'add') throw new CliError(`no Holdr database at ${dbFile}`);
    io.stderr.write(`Using ${dbFile}${exists ? '' : ' (new database)'}${e2eDir ? ' (checked e2e data dir)' : ''}\n`);

    // An open connection holds no SQLite lock (WAL), so a slow typist never blocks the running API; the
    // lifecycle lease is shared with the API and only keeps maintenance from starting meanwhile.
    try {
      e2eDir?.assertUnchanged();
      const opened = await openWriterDb(env, () => new SqliteStateRepo({ file: dbFile }));
      writer = opened;
      repo = opened.db;
      e2eDir?.recordOpened();
    } catch (error) {
      if (error instanceof ControlError) throw new CliError(controlMessage(error), error.exitCode);
      if (error instanceof CliError || !e2eDir) throw error;
      throw new CliError((error as Error).message);
    }
    const users = new LocalAuthRepo(repo);

    switch (args.command) {
      case 'add': {
        if (users.findUser(username)) {
          throw new CliError(`user "${username}" already exists; use: npm run holdr-user -- passwd ${username}`);
        }
        const password = await readNewPassword(io, args, username);
        try {
          users.createUser(username, await hashPassword(password, scryptParams), now());
        } catch (err) {
          if (err instanceof UserExistsError) {
            throw new CliError(`user "${username}" already exists; use: npm run holdr-user -- passwd ${username}`);
          }
          throw err;
        }
        io.stdout.write(`Created user ${username}. Sign in at the Holdr web page.\n`);
        return 0;
      }
      case 'passwd': {
        const user = users.findUser(username);
        if (!user) throw new CliError(`no user "${username}"`);
        const password = await readNewPassword(io, args, username);
        const hash = await hashPassword(password, scryptParams);
        const { result, revoked } = await resetCredentials(repo, env, dataDir, options, user.id, () => {
          const changed = users.setPasswordHash(username, hash, { revokeSessions: true, expectedUserId: user.id }, now());
          if (!changed) throw new CliError(`no user "${username}"`);
          return changed;
        });
        io.stdout.write(`Password updated for ${username}; signed out ${result.revokedSessions} session(s).\n`);
        if (revoked > 0) io.stdout.write(`Revoked ${revoked} card sync browser(s) of ${username} (password reset).\n`);
        return 0;
      }
      case 'list': {
        const list = users.listUsers(now());
        if (list.length === 0) {
          io.stdout.write('No users yet. Add one with: npm run holdr-user -- add <username>\n');
          return 0;
        }
        const width = Math.max(8, ...list.map((user) => user.username.length));
        io.stdout.write(`${'USERNAME'.padEnd(width)}  CREATED                   ACTIVE SESSIONS\n`);
        for (const user of list) {
          io.stdout.write(`${user.username.padEnd(width)}  ${user.createdAt.padEnd(24)}  ${user.activeSessions}\n`);
        }
        return 0;
      }
      case 'remove': {
        const user = users.findUser(username);
        if (!user) throw new CliError(`no user "${username}"`);
        if (!args.yes) {
          if (!io.stdin.isTTY) throw new CliError('refusing to remove without confirmation; pass --yes');
          const answer = await promptLine(io, `Remove ${username} and end all of their sessions? Type the username to confirm: `);
          if (answer !== username) throw new CliError('not confirmed; nothing removed');
        }
        const { revoked } = await resetCredentials(repo, env, dataDir, options, user.id, () => {
          if (!users.removeUser(username, user.id)) throw new CliError(`no user "${username}"`);
        });
        const remaining = users.countUsers();
        io.stdout.write(`Removed user ${username}.\n`);
        if (revoked > 0) io.stdout.write(`Revoked ${revoked} card sync browser(s) of ${username} (password reset).\n`);
        if (remaining === 0) io.stderr.write('No users remain: the API now answers 503 until you add one.\n');
        return 0;
      }
    }
    return 2;
  } catch (err) {
    const exitCode = err instanceof CliError ? err.exitCode : 1;
    io.stderr.write(`holdr-user: ${(err as Error).message}\n`);
    return exitCode;
  } finally {
    if (writer) writer.close();
    else repo?.close();
  }
}

/**
 * Revokes every browser of one user that is not yet revoked (E1b §10 item 6; `revokeCardSyncDevice('password-reset')`,
 * actor `system`), then invalidates credentials under the same host lock. No await or lock reacquisition occurs inside it.
 * Each revocation keeps its ordinary durable fence/DB protocol. Without a control dir, widening is unavailable and the
 * repository's generation CAS still serializes each revocation. Password/user writes also bind the originally selected id.
 */
async function resetCredentials<T>(
  repo: SqliteStateRepo, env: Readonly<NodeJS.ProcessEnv>, dataDir: string, options: CliOptions, userId: string, apply: () => T,
): Promise<{ result: T; revoked: number }> {
  const controlDir = configuredControlDir(env);
  let ctx: AuthorizationFenceContext | null = null;
  if (controlDir) {
    let machine: string | null;
    try {
      machine = await computeMachineId(options.run ?? systemRunner, existingAncestor(dataDir));
    } catch {
      machine = null;
    }
    ctx = { controlDir, machine, databaseGeneration: () => repo.getCardSyncAuthorizationGeneration(),
      log: (line) => { options.io.stderr.write(`${line}\n`); } };
  }
  const reset = () => {
    if (ctx) reconcileChangeBlock(ctx);
    const deviceIds = repo.listCardSyncDevicesToRevokeForReset(cardSyncActorRef(userId));
    let revoked = 0;
    for (const deviceId of deviceIds) {
      const revoke = (step: { expectedGeneration: string; nextGeneration: string }) =>
        repo.revokeCardSyncDevice({ deviceId, reason: 'password-reset', actor: { kind: 'system' }, ...step });
      const once = () => ctx ? changeWithAuthorizationLockHeld(ctx, 'narrowing', revoke)
        : revoke({ expectedGeneration: repo.getCardSyncAuthorizationGeneration(), nextGeneration: newGeneration() });
      try {
        if (once().changed) revoked++;
      } catch (error) {
        if (ctx || cardSyncRefusalCode(error) !== 'generation-mismatch') throw error;
        if (once().changed) revoked++;
      }
    }
    return { result: apply(), revoked };
  };
  try {
    return controlDir ? await withAuthorizationLock(controlDir, reset) : reset();
  } catch (error) {
    if (error instanceof ControlError) throw new CliError(controlMessage(error), error.exitCode);
    throw error;
  }
}

function controlMessage(error: unknown): string {
  if (error instanceof ControlError) return error.detail ? `${error.code} (${error.detail})` : error.code;
  return (error as Error).message;
}
