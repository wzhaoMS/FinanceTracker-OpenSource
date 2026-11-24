import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CommandResult } from '../ingress/boundedCommand.js';
import { initControlDir } from './controlDir.js';
import { systemRunner } from './exec.js';
import { REPO_ROOT, repoPaths } from './paths.js';
import type { Runner } from './runner.js';
import { removeTree, scratchDir } from './testDirs.js';

export const TEST_MACHINE = '0123456789abcdef';

/** A runner that answers tmutil like a successful exclusion and refuses anything else (no system changes in unit tests). */
export const fakeTmutil: Runner = async (file, args): Promise<CommandResult> => {
  if (file === '/usr/bin/tmutil' && args[0] === 'addexclusion') return { exitCode: 0, stdout: '' };
  if (file === '/usr/bin/tmutil' && args[0] === 'isexcluded') return { exitCode: 0, stdout: `[Excluded]    ${args[1]}\n` };
  if (file === '/usr/sbin/lsof') return { exitCode: 1, stdout: '' };
  return { exitCode: 'missing', stdout: '' };
};

/**
 * A disposable private directory outside the repository tree (K20 forbids a control dir inside it): under the real path of
 * `os.tmpdir()` (the test runner points TMPDIR at a scratch directory). Never a real HOME.
 */
export function outsideRepoDir(prefix = 'b'): { dir: string; cleanup: () => void } {
  const base = fs.realpathSync(os.tmpdir());
  const dir = path.join(base, `holdr-${prefix}-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  return { dir, cleanup: () => removeTree(dir) };
}

/**
 * A disposable HOME in which this checkout is the managed live tree: `HOME/Holdr/FinanceTracker` is a
 * symlink to it, and there is no live configuration. A `leave` validates its own tree only there (B1 round-2 finding 3).
 */
export function liveHome(dir: string): string {
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, 'Holdr'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(REPO_ROOT, path.join(home, 'Holdr/FinanceTracker'));
  return home;
}

/** An initialised control dir (`holdr-recovery init` semantics) with the fake machine id. */
export async function controlFixture(options: { run?: Runner } = {}) {
  const outer = outsideRepoDir('ctl');
  const controlDir = path.join(outer.dir, 'control');
  await initControlDir(controlDir, { machine: TEST_MACHINE, run: options.run ?? fakeTmutil, repo: repoPaths() });
  return { root: outer.dir, controlDir, cleanup: outer.cleanup };
}

const PLATFORM = '11111111-2222-3333-4444-555555555555';
const VOLUME = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
/** The machine id `fakeSystem` produces (ioreg/df/diskutil answered synthetically): machineIdFrom(PLATFORM, VOLUME). */
export const FAKE_MACHINE = '9ed4b1ca529fbd59';
export const FAKE_MACHINE_INPUT = { PLATFORM, VOLUME };

/**
 * A runner for CLI tests: synthetic ioreg/df/diskutil (a fixed machine), tmutil answered as a successful exclusion, and the
 * real read-only lsof/ps (holders and ownership must be real).
 */
export const fakeSystem: Runner = async (file, args) => {
  if (file === '/usr/sbin/ioreg') return { exitCode: 0, stdout: `"IOPlatformUUID" = "${PLATFORM}"\n` };
  if (file === '/bin/df') return { exitCode: 0, stdout: 'Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/x 1 1 1 1% /System/Volumes/Data\n' };
  if (file === '/usr/sbin/diskutil') return { exitCode: 0, stdout: `<key>VolumeUUID</key><string>${VOLUME}</string>` };
  if (file === '/usr/bin/tmutil') return fakeTmutil(file, args);
  return systemRunner(file, args);
};

/** A private data dir and a control dir created by `holdr-recovery init` semantics, both outside the repository tree. */
export async function controlEnvFixture(options: { run?: Runner; machine?: string } = {}) {
  const outer = outsideRepoDir('env');
  const dataDir = path.join(outer.dir, 'data');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const controlDir = path.join(outer.dir, 'control');
  await initControlDir(controlDir, { machine: options.machine ?? TEST_MACHINE, run: options.run ?? fakeTmutil, repo: repoPaths() });
  // HOME is disposable (no default holdr.conf there). TMPDIR keeps tsx's compile cache in the runner's scratch directory.
  // HOME makes this checkout the managed live tree (liveHome), so a leave from it validates it.
  const env: NodeJS.ProcessEnv = {
    HOLDR_DATA_DIR: dataDir, HOLDR_CONTROL_DIR: controlDir, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: liveHome(outer.dir),
  };
  return { root: outer.dir, dataDir, controlDir, env, cleanup: outer.cleanup };
}

/** The tsx loader `scripts/holdr-leased.sh` uses: Node with TypeScript in one process, no respawning launcher. */
export const TSX_LOADER = path.join(REPO_ROOT, 'node_modules/tsx/dist/loader.mjs');

/** Captured standard output and error for in-process CLI runs. */
export function captureIo() {
  let out = '';
  let err = '';
  return {
    io: { stdout: { write: (text: string) => { out += text; return true; } }, stderr: { write: (text: string) => { err += text; return true; } } },
    out: () => out,
    err: () => err,
  };
}

/** A separate process holding `file` with O_SHLOCK/O_EXLOCK until it is killed (or `holdMs` passes). */
export async function lockHolder(file: string, mode: 'shared' | 'exclusive', cleanups: Array<() => void>, holdMs?: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    fs.openSync(${JSON.stringify(file)}, fs.constants.O_RDONLY | ${mode === 'exclusive' ? '0x20' : '0x10'});
    process.stdout.write('held\\n');
    ${holdMs === undefined ? 'setInterval(() => {}, 1000);' : `setTimeout(() => process.exit(0), ${holdMs});`}
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  cleanups.push(() => { child.kill('SIGKILL'); });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('exit', () => reject(new Error('lock holder exited early')));
  });
  return child;
}

export const exited = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve();
  else child.once('exit', () => resolve());
});

export async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Replaces the configurable Node resolution line of an operator script with
 * the current test runtime; exactly one line must match.
 */
export function withTestNode(text: string, node = process.execPath): string {
  const lines = text.split('\n');
  const at = lines.flatMap((line, index) => (line === 'NODE="${HOLDR_NODE:-$(command -v node || true)}"' ? [index] : []));
  if (at.length !== 1 || node.includes("'")) throw new Error('expected exactly one configurable Node line and a quotable Node path');
  lines[at[0]] = `NODE='${node}'`;
  return lines.join('\n');
}

/**
 * `scripts/holdr-leased.sh` as the tests run it: a copy pinned to the test Node (`withTestNode`), in a scratch tree
 * that links this repository's `apps` and `node_modules`, so the role runs this repository's code.
 */
export function testLeasedScript(): { script: string; cleanup: () => void } {
  const tree = scratchDir('leased');
  fs.mkdirSync(path.join(tree.dir, 'scripts'), { mode: 0o700 });
  fs.symlinkSync(path.join(REPO_ROOT, 'apps'), path.join(tree.dir, 'apps'));
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tree.dir, 'node_modules'));
  const script = path.join(tree.dir, 'scripts/holdr-leased.sh');
  fs.writeFileSync(script, withTestNode(fs.readFileSync(path.join(REPO_ROOT, 'scripts/holdr-leased.sh'), 'utf8')), { mode: 0o755 });
  return { script, cleanup: tree.cleanup };
}
