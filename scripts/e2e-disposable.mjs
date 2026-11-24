#!/usr/bin/env node
// Run the Playwright suite against a throwaway Holdr stack seeded with
// synthetic data. Never reads or writes apps/api/data. One implementation for
// macOS, Linux and Windows (Git Bash, PowerShell or cmd); scripts/e2e-disposable.sh
// and `npm run test:e2e` both run this file.
//
//   node scripts/e2e-disposable.mjs [options] [--] [playwright test arguments]
//   npm run test:e2e -- [options] [--] [playwright test arguments]
//
//   --api-port N     API port (HOLDR_E2E_API_PORT; default: a free port)
//   --web-port N     Vite port (HOLDR_E2E_WEB_PORT; default: a free port)
//   --work-dir DIR   parent of the per-run directory; only you may be able to
//                    write to it, and only you or root (SYSTEM or
//                    Administrators on Windows) to each directory above it up
//                    to your home or the repo (HOLDR_E2E_WORK_DIR; default:
//                    <repo>/.e2e-tmp, or <your temp folder>\holdr-e2e on Windows)
//   --keep           keep the run's data and logs after it finishes (its
//                    service token and saved sign-in are always deleted)
//
// Each run creates a private run-<UTC stamp>-<pid>-<random>/ with data/ and
// logs/ under the work dir, each exclusively (never through an existing
// entry; on Windows each one's ACL is then limited to you and SYSTEM), seeds
// data/ with apps/api/src/e2e/seedCli.ts, creates the sign-in user e2e there
// with the holdr-user CLI (the API's disposable-dir check; a random password
// kept in memory and handed over on standard input), and starts the API
// (HOLDR_DATA_DIR=data, SNAPSHOTS_ENABLED=0, every outbound request refused,
// a random HOLDR_E2E_RUN_ID, its service token in the run dir, outside
// data/) and Vite (browser API calls stay on its own origin) on 127.0.0.1.
// It checks that the service token works on the API's port and is refused
// through Vite, then runs Playwright with HOLDR_E2E_WRITES=1, WEB_URL, the
// same HOLDR_E2E_RUN_ID (which its global setup must find behind WEB_URL
// before it signs in) and the e2e credentials. It stops every process tree it
// started (each one's process group, held by scripts/e2e-group-leader.mjs, on
// macOS and Linux; taskkill /T by PID on Windows) and deletes the run
// directory only while it is still the one it created. Logs are kept when the
// run fails; an interrupted run (Ctrl-C) is removed like a passing one. The
// service token and the saved sign-in are deleted in every case.
//
//   npm run test:e2e
//   npm run test:e2e -- --api-port 4106 --web-port 5306 -- tests/smoke.e2e.ts -g "Symbol chart"
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// P-NET: refuses any listener of this runner's (its port checks) beyond 127.0.0.1 or ::1.
import './loopback-only.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(REPO, 'apps', 'api');
const WEB_DIR = path.join(REPO, 'apps', 'web');
const OFFLINE_PRELOAD = path.join(REPO, 'scripts', 'e2e-offline-fetch.mjs');
export const GROUP_LEADER = path.join(REPO, 'scripts', 'e2e-group-leader.mjs');

/** Files the runner starts with `node`, relative to the repo. */
export const TOOLS = {
  tsx: ['node_modules/tsx/package.json', 'apps/api/node_modules/tsx/package.json'],
  vite: ['node_modules/vite/bin/vite.js'],
  playwright: ['node_modules/@playwright/test/cli.js'],
};

/** The comment at the top of this file. */
export function usage() {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/).slice(1);
  return lines.slice(0, lines.findIndex((line) => !line.startsWith('//'))).map((line) => line.replace(/^\/\/ ?/, '')).join('\n');
}

/** Exit status for each signal that interrupts a run (128 + its number, as a shell reports it). */
export const SIGNAL_STATUS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGBREAK: 149 };

export class UsageError extends Error {}

/**
 * Options from the command line, with defaults from the environment. Unknown
 * arguments, and everything after `--`, go to Playwright.
 */
export function parseArgs(argv, env = process.env) {
  const options = {
    apiPort: env.HOLDR_E2E_API_PORT || '',
    webPort: env.HOLDR_E2E_WEB_PORT || '',
    workDir: env.HOLDR_E2E_WORK_DIR || '',
    keep: false,
    help: false,
    playwrightArgs: [],
  };
  const valued = { '--api-port': 'apiPort', '--web-port': 'webPort', '--work-dir': 'workDir' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (Object.hasOwn(valued, flag)) {
      const value = inline ?? (index + 1 < argv.length ? argv[(index += 1)] : undefined);
      if (value === undefined || value === '') throw new UsageError(`${flag} needs a value`);
      options[valued[flag]] = value;
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
      return options;
    } else if (arg === '--') {
      options.playwrightArgs.push(...argv.slice(index + 1));
      break;
    } else {
      options.playwrightArgs.push(arg);
    }
  }
  return options;
}

export function validatePort(value) {
  if (!/^\d+$/.test(value)) throw new UsageError(`invalid port: '${value}'`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new UsageError(`invalid port: ${value}`);
  return port;
}

/** One worker unless the arguments choose (both spec files share the stack). */
export function withDefaultWorkers(args) {
  return args.some((arg) => /^(--workers|-j)/.test(arg)) ? [...args] : ['--workers=1', ...args];
}

/**
 * `base` with `overrides` applied and any variable `drop` matches removed.
 * Windows variable names are case-insensitive, so there every other
 * spelling of an overridden name is removed too.
 */
export function childEnv(base, overrides, { platform = process.platform, drop = () => false } = {}) {
  const key = platform === 'win32' ? (name) => name.toUpperCase() : (name) => name;
  const overridden = new Set(Object.keys(overrides).map(key));
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || overridden.has(key(name)) || drop(name)) continue;
    env[name] = value;
  }
  return { ...env, ...overrides };
}

/**
 * Vite's environment: the browser must call the API through Vite's own
 * origin. VITE_API_BASE would point it elsewhere; process environment values
 * win over apps/web .env files, so it is set empty and every other inherited
 * VITE_ variable is dropped.
 */
export function viteEnv(base, apiPort, platform = process.platform) {
  return childEnv(base, { VITE_API_BASE: '', HOLDR_API_TARGET: `http://127.0.0.1:${apiPort}` }, {
    platform,
    drop: (name) => /^vite_/i.test(name),
  });
}

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/** The sign-in user each run creates in its data directory. */
export const E2E_USER = 'e2e';
/** Files in the run directory that hold credentials: deleted at the end of every run. */
export const SERVICE_TOKEN_FILE = 'service-token';
export const AUTH_STATE_FILE = 'auth-state.json';
export const CREDENTIAL_FILES = [SERVICE_TOKEN_FILE, AUTH_STATE_FILE];

/**
 * A disposable stack never reads the production holdr.conf (HOLDR_CONFIG=none, design §7.1) and never joins a production
 * lifecycle protocol: an inherited control dir or lease variable is dropped.
 */
export const DISPOSABLE_CONFIG = Object.freeze({ HOLDR_CONFIG: 'none' });
export const dropProductionControl = (name) => /^HOLDR_(CONTROL_DIR|LIFECYCLE_LEASE|LIFECYCLE_LEASE_FD)$/i.test(name);

/**
 * The API's environment. Its service token goes to the run directory, outside
 * data/, which may hold only SQLite files. The e2e password is not in it.
 */
export function apiEnv(base, { runDir, dataDir, apiPort, webPort, runId }, platform = process.platform) {
  return childEnv(base, {
    ...DISPOSABLE_CONFIG,
    HOLDR_DATA_DIR: dataDir,
    PORT: String(apiPort),
    HOLDR_HOST: '127.0.0.1',
    SNAPSHOTS_ENABLED: '0',
    WEB_ORIGIN: `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
    BROKER_BRIDGE_URL: 'http://broker-bridge.e2e.invalid',
    QLIB_THESIS_URL: 'http://thesis.e2e.invalid',
    HOLDR_E2E_RUN_ID: runId,
    HOLDR_SERVICE_TOKEN_FILE: pathFor(platform).join(runDir, SERVICE_TOKEN_FILE),
  }, { platform, drop: dropProductionControl });
}

/**
 * Playwright's environment: the stack, its run identity and the credentials
 * global-sign-in.ts signs in with, saving the session in the run directory.
 * The service token is never in it.
 */
export function playwrightEnv(base, { runDir, webPort, runId, password }, platform = process.platform) {
  return childEnv(base, {
    HOLDR_E2E_WRITES: '1',
    WEB_URL: `http://127.0.0.1:${webPort}`,
    HOLDR_E2E_RUN_ID: runId,
    HOLDR_E2E_USER: E2E_USER,
    HOLDR_E2E_PASSWORD: password,
    HOLDR_E2E_AUTH_STATE: pathFor(platform).join(runDir, AUTH_STATE_FILE),
  }, { platform });
}

/** The service token in `file`: a regular file holding 64 lowercase hex characters, as the API writes it; otherwise null. */
export function readServiceToken(file, fsImpl = fs) {
  try {
    if (!fsImpl.lstatSync(file).isFile()) return null;
    const token = fsImpl.readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * Headers carrying the service token. Only this process sends them, with its
 * own fetch: the token is never on a command line or in a child's environment.
 */
export function serviceTokenHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Where run directories go by default. On Windows that is the per-user temp
 * folder (under the profile, which only you, SYSTEM and Administrators can
 * write to), by its long physical name: a checkout under C:\ usually inherits
 * "Authenticated Users: Modify", which the privacy checks refuse.
 */
export function defaultWorkDir({
  platform = process.platform,
  repo = REPO,
  tmpdir = os.tmpdir,
  realpath = fs.realpathSync.native,
} = {}) {
  return platform === 'win32' ? path.win32.join(realpath(tmpdir()), 'holdr-e2e') : path.join(repo, '.e2e-tmp');
}

/** KEY=value lines (the run-directory helper's output). */
export function parseKeyValues(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}

/**
 * What happens to the run directory once every process has stopped. Nothing
 * the seed did not accept is ever deleted. A passing or interrupted run is
 * removed whole; a failed one keeps its logs.
 */
export function cleanupPlan({ keep, seeded, status, interrupted }) {
  if (keep) return 'keep';
  if (!seeded) return 'leave';
  if (status === 0 || interrupted) return 'remove-run';
  return 'remove-data';
}

/**
 * Delete the run's service token and saved sign-in, whatever becomes of the
 * run directory (--keep, failed and interrupted runs included). Never
 * recursive and never through a link (a link is removed itself), and only
 * while the run directory is still a plain directory. Returns what could not
 * be deleted.
 */
export function removeCredentials(runDir, fsImpl = fs, platform = process.platform) {
  let stats;
  try {
    stats = fsImpl.lstatSync(runDir);
  } catch (error) {
    return error.code === 'ENOENT' ? [] : [`could not check ${runDir}: ${error.message}`];
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return [`${runDir} is no longer a plain directory; its credential files were not deleted`];
  }
  const problems = [];
  for (const name of CREDENTIAL_FILES) {
    const file = pathFor(platform).join(runDir, name);
    try {
      // Windows refuses to delete a file a just-stopped process still holds: retry briefly there.
      fsImpl.rmSync(file, { force: true, maxRetries: platform === 'win32' ? 10 : 0, retryDelay: 200 });
    } catch (error) {
      problems.push(`could not delete ${file}: ${error.message}`);
    }
  }
  return problems;
}

/** A PID that may be signalled: 0, 1 and negative values would reach other processes. */
export function isSignallablePid(pid) {
  return Number.isInteger(pid) && pid > 1;
}

/** taskkill's arguments for a whole process tree, by PID only. */
export function taskkillArgs(pid) {
  if (!isSignallablePid(pid)) throw new Error(`refusing to taskkill pid ${pid}`);
  return ['/T', '/F', '/PID', String(pid)];
}

/** A program in System32, by absolute path: a bare name would be looked up in the working directory first. */
export function system32(file, env = process.env) {
  return path.win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', file);
}

/* ------------------------------------------------------------------ */
/* Output and the run's state                                         */
/* ------------------------------------------------------------------ */

const isWindows = process.platform === 'win32';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[e2e] ${message}`);
const warn = (message) => console.error(`[e2e] ${message}`);

class Fatal extends Error {}
function die(message) {
  throw new Fatal(message);
}

const state = {
  keep: false,
  /** Set once the run directory exists: { runDir, dataDir, logDir, runDirId, dataDirId, workRoot }. */
  run: null,
  seeded: false,
  /** Process groups (startGroup) of the services by name (api, vite, playwright), and of short helpers. */
  services: new Map(),
  helpers: new Set(),
  stopping: false,
};

/* ------------------------------------------------------------------ */
/* Process groups                                                     */
/* ------------------------------------------------------------------ */

/** What startGroup needs from the operating system; tests pass their own. */
export const realSystem = {
  platform: process.platform,
  spawn,
  kill: (pid, signal) => process.kill(pid, signal),
  /** Windows: end a process tree, by PID. */
  taskkill: (pid) => {
    spawnSync(system32('taskkill.exe'), taskkillArgs(pid), { stdio: 'ignore', windowsHide: true });
  },
  /**
   * POSIX: the PIDs in process group `pgid` now, or null if ps fails. Only
   * used to decide how long to wait, never what to signal.
   */
  groupMembers: (pgid) => {
    try {
      return execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([pid, group]) => Number.isInteger(pid) && group === pgid)
        .map(([pid]) => pid);
    } catch {
      return null;
    }
  },
};

const unreaped = (child) => child.pid !== undefined && child.exitCode === null && child.signalCode === null;

/** Whether `promise` settles within `ms`. */
function settles(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms, false);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Start `program` (with `args`, `cwd`, `env` and `stdio`) as one unit the
 * runner can stop with everything it starts. Returns { name, pgid, stdin,
 * stdout, started (a promise of the program's PID, or undefined if it did
 * not start), exited (a promise of { code, signal, error? }), running(),
 * stop() }; stdin and stdout are pipes when `stdio` asks for them.
 *
 * POSIX: scripts/e2e-group-leader.mjs is started in a new session and
 * process group (so the terminal's Ctrl-C reaches only the runner) and
 * starts `program` as its child, in that group. The leader never exits on
 * its own. While it is this runner's unreaped child it is a member of the
 * group, so the group's ID is certainly this run's, and the group is
 * signalled only then. Once the leader is seen to exit, the ID is dropped for
 * good. stop() waits until the leader runs, then asks it to end `program`
 * through its own child handle (SIGTERM, SIGKILL after `termMs`; this
 * reaches `program` even if it left the group with setsid()) and sends the
 * group SIGTERM for whatever else is in it (the leader ignores it). Once the
 * leader reports `program` reaped, what is left in the group gets up to
 * `settleMs`, then the group, the leader included, gets SIGKILL, and stop()
 * returns when the leader has been reaped.
 *
 * Windows: `program` is a direct child, sharing the console. stop() runs
 * taskkill /T /F /PID only while it has not been reaped: until then the open
 * process handle keeps its PID from being reused. A tree whose root has
 * already exited is left alone.
 */
export function startGroup(name, program, args, { cwd, env = process.env, stdio }, system = realSystem) {
  return system.platform === 'win32'
    ? startWindowsTree(name, program, args, { cwd, env, stdio }, system)
    : startPosixGroup(name, program, args, { cwd, env, stdio }, system);
}

/** The bookkeeping both kinds share: `started` and `exited` settle once. */
function newGroup(name, { stdin, stdout }) {
  let resolveStarted;
  let resolveExited;
  const group = {
    name,
    pgid: null,
    stdin: stdin ?? null,
    stdout: stdout ?? null,
    started: new Promise((resolve) => {
      resolveStarted = resolve;
    }),
    exited: new Promise((resolve) => {
      resolveExited = resolve;
    }),
    done: false,
  };
  group.running = () => !group.done;
  group.markStarted = (pid) => resolveStarted(pid);
  group.finish = (result) => {
    if (group.done) return;
    group.done = true;
    resolveStarted(undefined);
    resolveExited(result);
  };
  return group;
}

function startPosixGroup(name, program, args, { cwd, env, stdio }, system) {
  const leader = system.spawn(process.execPath, [GROUP_LEADER, program, ...args], {
    cwd,
    env,
    stdio: [...stdio, 'ipc'],
    detached: true,
  });
  // The leader starts `program` with its own stdio, so a stdin pipe reaches `program`.
  const group = newGroup(name, leader);
  group.pgid = isSignallablePid(leader.pid) ? leader.pid : null;
  let ending = false;
  let resolveGone;
  const gone = new Promise((resolve) => {
    resolveGone = resolve;
  });
  const lose = (reason) => {
    // Reaped (or never started): from now on its PID, and the group's ID, may be anyone's.
    if (group.pgid !== null && !ending && !group.done) {
      warn(`${name}: its process group leader (pid ${group.pgid}) exited unexpectedly; what is left of the group will not be signalled`);
    }
    group.pgid = null;
    group.finish({ code: null, signal: null, error: reason });
    resolveGone();
  };
  leader.on('message', (message) => {
    if (message?.type === 'started') group.markStarted(message.pid);
    else if (message?.type === 'exit') {
      if (message.killed) warn(`${name} ignored SIGTERM and was killed`);
      group.finish({ code: message.code, signal: message.signal });
    } else if (message?.type === 'error') group.finish({ code: null, signal: null, error: message.message });
  });
  const tell = (message) => {
    try {
      if (leader.connected) leader.send(message, () => {});
    } catch {
      // The leader is gone or going; the group's own signals still apply.
    }
  };
  leader.once('exit', () => lose('its process group leader exited'));
  leader.once('error', (error) => {
    if (leader.pid === undefined) lose(error.message);
  });

  const signal = (sig) => {
    if (group.pgid === null || !unreaped(leader)) return false;
    try {
      system.kill(-group.pgid, sig);
      return true;
    } catch {
      return false;
    }
  };
  const othersLeft = () => {
    if (group.pgid === null) return false;
    const members = system.groupMembers(group.pgid);
    return members !== null && members.some((pid) => pid !== leader.pid);
  };
  let stopping = null;
  group.stop = ({ readyMs = 5_000, termMs = 10_000, reportMs = termMs + 5_000, settleMs = 5_000 } = {}) => (stopping ??= (async () => {
    if (group.pgid === null) return;
    // The leader ignores SIGTERM once its handlers are in place, which it
    // reports (started, or error) before anything else. Until then SIGTERM
    // could end it and lose the group, so a leader that never reports gets
    // only the final SIGKILL.
    if (await settles(group.started, readyMs)) {
      tell({ type: 'stop', graceMs: termMs });
      signal('SIGTERM');
      // The leader kills `program` after termMs at the latest, then reports it reaped.
      if (!group.done && !(await settles(group.exited, reportMs)) && group.pgid !== null) {
        warn(`${name}: no exit reported ${reportMs / 1000} s after it was asked to stop; ending its process group with SIGKILL`);
      } else {
        for (let waited = 0; waited < settleMs && othersLeft(); waited += 250) await sleep(250);
      }
    }
    ending = true;
    signal('SIGKILL');
    if (!(await settles(gone, 5_000))) warn(`${name}: its process group leader (pid ${leader.pid}) did not exit after SIGKILL`);
  })());
  return group;
}

function startWindowsTree(name, program, args, { cwd, env, stdio }, system) {
  const child = system.spawn(program, args, { cwd, env, stdio, windowsHide: true });
  const group = newGroup(name, child);
  child.once('spawn', () => group.markStarted(child.pid));
  child.once('exit', (code, signal) => group.finish({ code, signal }));
  child.once('error', (error) => {
    if (child.pid === undefined) group.finish({ code: null, signal: null, error: error.message });
  });
  let stopping = null;
  group.stop = ({ termMs = 10_000 } = {}) => (stopping ??= (async () => {
    if (!unreaped(child)) return; // its PID may be anyone's now
    system.taskkill(child.pid);
    if (!(await settles(group.exited, termMs))) warn(`${name} (pid ${child.pid}) did not exit after taskkill /T /F`);
  })());
  return group;
}

/* ------------------------------------------------------------------ */
/* The run                                                            */
/* ------------------------------------------------------------------ */

/** Run an apps/api TypeScript helper (src/e2e/*Cli.ts) to completion, returning its stdout. */
async function runApiHelper(args, { internal = false } = {}) {
  if (state.stopping && !internal) throw new Fatal('not starting a helper: the run is stopping');
  const group = startGroup('helper', process.execPath, ['--import', 'tsx', ...args], {
    cwd: API_DIR,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  state.helpers.add(group);
  let stdout = '';
  const drained = new Promise((resolve) => {
    if (!group.stdout) return resolve();
    group.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    group.stdout.once('close', resolve);
  });
  try {
    const { code, error } = await group.exited;
    // On POSIX the group leader holds the output pipe open too, until it is ended.
    await group.stop({ settleMs: 1_000 });
    await settles(drained, 5_000);
    return { ok: code === 0 && !error, stdout };
  } finally {
    state.helpers.delete(group);
  }
}

/** Deletes only while every directory from the work dir down to `dir` is still the one recorded at creation. */
async function removeOwnedDir(dir, identityChain) {
  const { ok } = await runApiHelper(['src/e2e/runDirCli.ts', 'remove', dir, identityChain], { internal: true });
  if (!ok) warn(`left ${dir} in place`);
  return ok;
}

/**
 * Run an apps/api TypeScript entry point to completion with `input` on its
 * standard input (a pipe, so nothing else ever sees it) and its output in the
 * new file `logFile`; returns whether it succeeded.
 */
async function runApiCommand(args, { env, input, logFile }) {
  if (state.stopping) throw new Fatal('not starting a helper: the run is stopping');
  const fd = openLog(logFile);
  let group;
  try {
    group = startGroup('helper', process.execPath, ['--import', 'tsx', ...args], { cwd: API_DIR, env, stdio: ['pipe', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  state.helpers.add(group);
  try {
    // A command that exits before reading closes the pipe; its status tells.
    group.stdin?.on('error', () => {});
    group.stdin?.end(input);
    const { code, error } = await group.exited;
    await group.stop({ settleMs: 1_000 });
    return code === 0 && !error;
  } finally {
    state.helpers.delete(group);
  }
}

/** Stop everything, then keep, leave or remove the run directory; returns what became of it. */
async function cleanup(status, interrupted) {
  for (const name of ['playwright', 'vite', 'api']) await state.services.get(name)?.stop();
  for (const group of [...state.helpers]) await group.stop();
  if (!state.run) return 'no run directory was created';
  const { runDir, dataDir, logDir, runDirId, dataDirId, workRoot } = state.run;
  // Credentials never outlive the run, not even with --keep or a failed run.
  for (const problem of removeCredentials(runDir)) warn(problem);
  switch (cleanupPlan({ keep: state.keep, seeded: state.seeded, status, interrupted })) {
    case 'keep':
      log(`kept ${runDir} (without its service token and saved sign-in)`);
      return `run directory kept: ${runDir}`;
    case 'leave':
      warn(`seeding did not complete; left ${runDir} in place`);
      return `run directory left in place (seeding did not complete): ${runDir}`;
    case 'remove-run': {
      const removed = await removeOwnedDir(runDir, runDirId);
      try {
        fs.rmdirSync(workRoot); // only if empty; never recursive
      } catch {
        // Other runs' directories, or anything else, stay.
      }
      return removed ? 'run directory removed' : `run directory left in place: ${runDir}`;
    }
    default: {
      const removed = await removeOwnedDir(dataDir, dataDirId);
      log(`logs kept in ${logDir}`);
      return removed ? `data removed, logs kept in ${logDir}` : `run directory left in place: ${runDir}`;
    }
  }
}

/** Wait until what was written to `stream` is handed over (or the reader is gone). */
function flush(stream) {
  return new Promise((resolve) => {
    if (stream.destroyed || !stream.writable) return resolve();
    stream.once('error', resolve);
    stream.write('', () => resolve());
  });
}

let finishing = null;
/**
 * Stop everything, clean up, exit. Runs once; later calls (a second Ctrl-C)
 * wait for the first. `signal` names the signal that interrupted the run.
 */
function finish(status, signal = null) {
  finishing ??= (async () => {
    state.stopping = true;
    let exitStatus = status;
    let outcome;
    try {
      outcome = await cleanup(status, signal !== null);
    } catch (error) {
      warn(`cleanup failed: ${error.message}`);
      outcome = 'cleanup failed';
      if (exitStatus === 0) exitStatus = 1;
    }
    // Last, once nothing else writes: Playwright's list reporter rewrites its
    // previous line while it runs, which can hide the "received" line. The
    // newline first keeps it off a line the shell has started through npm
    // (cmd's "Terminate batch job (Y/N)?", or the prompt that came back).
    if (signal !== null) console.error(`\n[e2e] stopped after ${signal}; ${outcome}; exit ${exitStatus}`);
    await flush(process.stdout);
    await flush(process.stderr);
    process.exit(exitStatus);
  })();
  return finishing;
}

function tail(file, lines = 40) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines - 1).join('\n');
  } catch (error) {
    return `(could not read ${file}: ${error.message})`;
  }
}

async function waitForHttp(url, group, logFile) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (!group.running()) {
      warn(`${group.name} exited during startup:`);
      console.error(tail(logFile));
      return false;
    }
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(2_000) });
      await response.arrayBuffer();
      if (response.ok) return true;
    } catch {
      // Not answering yet.
    }
    await sleep(500);
  }
  warn(`${group.name} did not answer ${url} within 60s:`);
  console.error(tail(logFile));
  return false;
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function checkPort(value) {
  const port = validatePort(String(value));
  // Never take over a port: whatever already listens there is left alone.
  if (!(await portIsFree(port))) die(`port ${port} is already in use; choose another (nothing was stopped)`);
  return port;
}

/** A log file created exclusively in the run's private logs/ directory. */
function openLog(file) {
  return fs.openSync(file, 'wx', 0o600);
}

/** Start a long-running service; returns its group and its PID. */
async function startService(name, args, options) {
  if (state.stopping) throw new Fatal(`not starting ${name}: the run is stopping`);
  const group = startGroup(name, process.execPath, args, options);
  state.services.set(name, group);
  const pid = await group.started;
  if (pid === undefined) die(`could not start ${name}`);
  log(`${name} pid ${pid}${group.pgid === null ? '' : `, process group ${group.pgid}`}`);
  return { group, pid };
}

async function run(options) {
  for (const [tool, candidates] of Object.entries(TOOLS)) {
    if (!candidates.some((candidate) => fs.existsSync(path.join(REPO, candidate)))) {
      die(`${candidates[0]} is missing (${tool}); run npm install`);
    }
  }
  if (Number(process.versions.node.split('.')[0]) < 20) die(`Node 20+ is required (found ${process.version})`);

  const apiPort = options.apiPort ? validatePort(options.apiPort) : await pickFreePort();
  let webPort = options.webPort ? validatePort(options.webPort) : await pickFreePort();
  while (!options.webPort && webPort === apiPort) webPort = await pickFreePort();
  if (apiPort === webPort) die('API and web ports must differ');
  await checkPort(apiPort);
  await checkPort(webPort);

  // The run directory and its data/ and logs/ are created exclusively inside
  // a work dir that nobody else can write to (nor any directory above it, up
  // to your home or the repo), and the device and inode of every directory
  // from the work dir down are recorded: cleanup deletes only while all of
  // them are unchanged, from inside the verified parent.
  let workDir = options.workDir;
  if (!workDir) {
    try {
      workDir = defaultWorkDir();
    } catch (error) {
      die(`could not find the default work directory: ${error.message}`);
    }
  }
  const created = await runApiHelper(['src/e2e/runDirCli.ts', 'create', workDir, String(process.pid)]);
  if (!created.ok) die(`could not create a private run directory under ${workDir}`);
  const info = parseKeyValues(created.stdout);
  const keys = ['RUN_DIR', 'DATA_DIR', 'LOG_DIR', 'RUN_DIR_ID', 'DATA_DIR_ID'];
  if (!keys.every((key) => info[key])) die('the run directory helper returned incomplete paths');
  state.run = {
    runDir: info.RUN_DIR,
    dataDir: info.DATA_DIR,
    logDir: info.LOG_DIR,
    runDirId: info.RUN_DIR_ID,
    dataDirId: info.DATA_DIR_ID,
    workRoot: path.dirname(info.RUN_DIR),
  };
  const { runDir, dataDir, logDir } = state.run;

  log(`run directory ${runDir}`);
  log(`api 127.0.0.1:${apiPort}, web 127.0.0.1:${webPort}, outbound requests from the API refused`);

  const seed = await runApiHelper(['src/e2e/seedCli.ts', '--data-dir', dataDir]);
  if (seed.stdout) process.stdout.write(seed.stdout.endsWith('\n') ? seed.stdout : `${seed.stdout}\n`);
  if (!seed.ok) die(`seeding ${dataDir} failed`);
  const seededAccounts = /^SEEDED accounts=(\d+)/m.exec(seed.stdout)?.[1] ?? '';
  state.seeded = true;

  // A fresh identity for this run. The API reports it in /health (and refuses
  // to start with it on a data dir that is not disposable); Playwright's
  // global setup refuses to run unless the stack behind WEB_URL reports it.
  const runId = randomBytes(16).toString('hex');

  // The app requires sign-in. The holdr-user CLI creates this run's user in
  // the seeded data dir; with HOLDR_E2E_RUN_ID it runs the API's
  // disposable-dir check first and writes only in the physical directory that
  // passed it. The password exists only in this process's memory, the CLI's
  // standard input and Playwright's environment.
  const password = randomBytes(18).toString('base64url');
  const userLog = path.join(logDir, 'holdr-user.log');
  const userCreated = await runApiCommand(['src/cli/holdrUserMain.ts', 'add', E2E_USER, '--password-stdin'], {
    env: childEnv(process.env, { ...DISPOSABLE_CONFIG, HOLDR_DATA_DIR: dataDir, HOLDR_E2E_RUN_ID: runId }, { drop: dropProductionControl }),
    input: `${password}\n`,
    logFile: userLog,
  });
  if (!userCreated) {
    console.error(tail(userLog));
    die(`creating the e2e user in ${dataDir} failed`);
  }

  // The preload refuses every outbound connection where it is created (TCP,
  // pipes, UDP, DNS queries; fetch, http(s), tls, http2, WebSocket),
  // loopback included. The broker-bridge and thesis URLs also point at
  // .invalid hosts (RFC 6761, never resolvable), so the owner's local
  // services stay out of reach even without it.
  const apiLog = path.join(logDir, 'api.log');
  const apiFd = openLog(apiLog);
  let api;
  try {
    api = await startService('api', ['--import', 'tsx', '--import', pathToFileURL(OFFLINE_PRELOAD).href, 'src/index.ts'], {
      cwd: API_DIR,
      env: apiEnv(process.env, { runDir, dataDir, apiPort, webPort, runId }),
      stdio: ['ignore', apiFd, apiFd],
    });
  } finally {
    fs.closeSync(apiFd);
  }
  fs.writeFileSync(path.join(runDir, 'api.pid'), `${api.pid}\n`, { flag: 'wx', mode: 0o600 });
  if (!(await waitForHttp(`http://127.0.0.1:${apiPort}/health`, api.group, apiLog))) die('the API did not start');

  // Prove the API opened the seeded database, not a default one, and reports
  // this run's identity. With HOLDR_E2E_RUN_ID it opens only the physical
  // directory it checked, which must be DATA_DIR itself.
  const apiOutput = fs.readFileSync(apiLog, 'utf8');
  if (!apiOutput.includes(`data dir: ${dataDir} (HOLDR_DATA_DIR)`)) {
    die(`the API did not report HOLDR_DATA_DIR=${dataDir}; see ${apiLog}`);
  }
  if (!apiOutput.includes(`opening only the checked data dir ${dataDir}`)) {
    die(`the API did not open ${dataDir} as its checked data dir; see ${apiLog}`);
  }
  // The service token for the runner's own checks. The API writes it to the
  // run dir, outside data/ (which may hold only SQLite files). It stays in
  // this process: sent as a header by its own fetch, never on a command line
  // or in a child's environment.
  const tokenFile = path.join(runDir, SERVICE_TOKEN_FILE);
  const serviceToken = readServiceToken(tokenFile);
  if (!serviceToken) die(`the API wrote no service token to ${tokenFile}; see ${apiLog}`);
  const withToken = serviceTokenHeaders(serviceToken);
  // Without a session /health shows only ok, schemaVersion and the run
  // identity; the token (direct, loopback) gets the counts.
  let health;
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/health`, {
      headers: withToken,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    health = await response.json();
  } catch (error) {
    die(`could not read the API's /health: ${error.message}`);
  }
  if (String(health?.accounts) !== seededAccounts) {
    die(`the API reports ${health?.accounts} accounts but ${seededAccounts || 'an unknown number'} were seeded`);
  }
  if (health?.e2e?.runId !== runId || health?.e2e?.disposableDataDir !== true) {
    die(`the API does not report this run's identity and a disposable data dir; see ${apiLog}`);
  }
  // Prove a broker pull cannot leave the stack before any test runs.
  let isolation;
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/import/activity-from-broker`, {
      method: 'POST',
      headers: { ...withToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ broker: 'e2e-isolation-check' }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    isolation = await response.text();
  } catch (error) {
    isolation = error.message;
  }
  if (!isolation.includes('outbound requests are disabled')) die(`the API's broker-bridge request was not refused: ${isolation}`);

  const webLog = path.join(logDir, 'web.log');
  const webFd = openLog(webLog);
  let vite;
  try {
    vite = await startService('vite', [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(webPort), '--strictPort', '--host', '127.0.0.1'], {
      cwd: WEB_DIR,
      env: viteEnv(process.env, apiPort),
      stdio: ['ignore', webFd, webFd],
    });
  } finally {
    fs.closeSync(webFd);
  }
  fs.writeFileSync(path.join(runDir, 'web.pid'), `${vite.pid}\n`, { flag: 'wx', mode: 0o600 });
  if (!(await waitForHttp(`http://127.0.0.1:${webPort}/health`, vite.group, webLog))) die('Vite did not start');

  // The service token is for local scripts on the API's own port. Through
  // Vite, the browser's only way in, it must be refused: prove both halves.
  const statusWithToken = async (url) => {
    try {
      const response = await fetch(url, { headers: withToken, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      await response.arrayBuffer();
      return response.status;
    } catch (error) {
      return `no answer: ${error.message}`;
    }
  };
  const direct = await statusWithToken(`http://127.0.0.1:${apiPort}/accounts`);
  if (direct !== 200) die(`the service token does not work on the API's own port (HTTP ${direct})`);
  const proxied = await statusWithToken(`http://127.0.0.1:${webPort}/accounts`);
  if (proxied !== 401) die(`the service token was not refused through Vite (HTTP ${proxied})`);
  log('service token: accepted on the API port, refused through Vite');

  // Its global setup (apps/web/tests/global-setup.ts) aborts the run unless
  // the API behind WEB_URL reports HOLDR_E2E_RUN_ID and a disposable data
  // dir, and the app's API requests stay on WEB_URL's origin. Only then does
  // global-sign-in.ts sign in as the e2e user and save the session in the run dir.
  const playwright = await startService('playwright', [path.join(REPO, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', ...withDefaultWorkers(options.playwrightArgs)], {
    cwd: WEB_DIR,
    env: playwrightEnv(process.env, { runDir, webPort, runId, password }),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const { code, signal, error } = await playwright.group.exited;
  if (error) die(`playwright: ${error}`);
  return code ?? 128 + (os.constants.signals[signal] ?? 0);
}

export async function main(argv = process.argv.slice(2)) {
  // A reader that goes away (`| head`) must not crash the runner before it
  // has stopped what it started.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    warn(error.message);
    return finish(1);
  }
  if (options.help) {
    console.log(usage());
    return finish(0);
  }
  state.keep = options.keep;
  for (const [signal, status] of Object.entries(SIGNAL_STATUS)) {
    if (signal === 'SIGBREAK' && !isWindows) continue;
    process.on(signal, () => {
      if (finishing) return; // cleanup is running; it ends the process
      warn(`received ${signal}; stopping the stack`);
      finish(status, signal);
    });
  }
  process.on('uncaughtException', (error) => {
    warn(`unexpected error: ${error.stack ?? error}`);
    finish(1);
  });
  process.on('unhandledRejection', (error) => {
    warn(`unexpected error: ${error?.stack ?? error}`);
    finish(1);
  });
  let status;
  try {
    status = await run(options);
  } catch (error) {
    if (state.stopping) return finishing;
    warn(error instanceof Fatal || error instanceof UsageError ? error.message : `unexpected error: ${error.stack ?? error}`);
    status = 1;
  }
  return finish(status);
}

function invokedAsScript() {
  if (!process.argv[1]) return false;
  try {
    const same = (a, b) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);
    return same(fs.realpathSync(process.argv[1]), fs.realpathSync(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (invokedAsScript()) await main();
