import fs from 'node:fs';
import path from 'node:path';

import { ControlError, EXIT } from './errors.js';
import { defaultConfPath } from './holdrConf.js';
import { REPO_ROOT, contains, isCanonicalAbsolute, managedLive, nonLiveEntry } from './paths.js';

/**
 * What a `leave` validates (B1 review 2, the B2 review's cross-cutting note; deviation B-D36 as revised after B1 round 2,
 * finding 3). A tree validates itself only where it is positively what the start script runs, never by default: a rollback
 * kit, a staging tree or any other copy says nothing about the live deployment.
 *
 * - Explicit target options (`--snap --target-root --target-config`): exactly those, as before (B-D22, B-D23), unless the
 *   named root is laid out as a staging tree or a kit (`nonLiveLayout`), which is refused (B round 4).
 * - From a kit (`KR/FinanceTracker` next to `KR/holdr.conf` and `KR/kit-runtime.txt`) the target comes from the kit's pinned
 *   operation context. The command must run with `HOLDR_CONFIG=KR/holdr.conf` (KC). The live tree is the managed one
 *   (`$HOLDR_ROOT/FinanceTracker` or `~/Holdr/FinanceTracker`) and the live configuration is the one the
 *   start script reads (`~/Library/Application Support/Holdr/holdr.conf`):
 *   - live configuration byte-equal to KC (a completed apply): the live tree validates itself, with its own code and
 *     node_modules, against the live configuration;
 *   - live configuration byte-equal to this deployment's snapshot `~/holdr-snapshots/<stamp>/holdr.conf`, or absent while the
 *     snapshot has `holdr.conf.absent` (a revert): the kit validates the live tree against the snapshot, exactly as the
 *     explicit revert options do;
 *   - anything else: refused (`E0I_LEAVE_TARGET`), naming the explicit options.
 * - Never itself when this tree sits beside a `holdr.conf` or `kit-runtime.txt` (`nonLiveLayout`: a staging tree, or a kit
 *   with incomplete metadata), checked before anything else, whatever HOLDR_ROOT says (B1 round-3 finding 1).
 * - Itself (`self`), only when this tree is physically the managed live tree (`managedLive`, which refuses a HOLDR_ROOT
 *   naming a staging tree or a kit) and runs with the live configuration (or with none while none exists), or in a verified
 *   disposable stack (the caller's full check: a run identity, `HOLDR_CONFIG=none`, a disposable data directory).
 * - Anything else is refused (`E0I_LEAVE_TARGET`): a kit with incomplete metadata, a staging tree, a copy. The refusal names
 *   the explicit target that validates the live deployment instead (§11.2 step 5).
 */
export type LeaveTarget =
  | { readonly kind: 'self'; readonly args: readonly string[]; readonly as: 'live' | 'disposable' }
  | { readonly kind: 'explicit'; readonly args: readonly string[] }
  | { readonly kind: 'live'; readonly root: string; readonly config: string }
  | { readonly kind: 'revert'; readonly args: readonly string[] };

const isFile = (file: string) => {
  try { return fs.lstatSync(file).isFile(); } catch { return false; }
};
const exists = (file: string) => {
  try { fs.lstatSync(file); return true; } catch { return false; }
};
const sameBytes = (a: string, b: string) => {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
};
const refuse = (detail: string): never => { throw new ControlError('E0I_LEAVE_TARGET', EXIT.usage, detail); };

/** `KR` when `root` is a rollback kit's tree (`KR/FinanceTracker` with `KR/holdr.conf` and `KR/kit-runtime.txt`), else null. */
export function kitRoot(root = REPO_ROOT): string | null {
  if (path.basename(root) !== 'FinanceTracker') return null;
  const kr = path.dirname(root);
  return isFile(path.join(kr, 'kit-runtime.txt')) && isFile(path.join(kr, 'holdr.conf')) ? kr : null;
}

const physical = (file: string | null) => { try { return file ? fs.realpathSync(file) : null; } catch { return null; } };

/**
 * The directory beside `root` that makes it a staging tree or a rollback kit (a `holdr.conf` or `kit-runtime.txt` next to
 * it, by its path or its physical path), or null (B-D44's rule, applied to the running tree: B1 round-3 finding 1).
 */
export function nonLiveLayout(root = REPO_ROOT): string | null {
  for (const dir of new Set([path.dirname(root), path.dirname(physical(root) ?? root)])) {
    if (nonLiveEntry(dir)) return dir;
  }
  return null;
}

/**
 * This tree is physically the managed live tree (`managedLive`) and `configPath` is the live configuration the start script
 * reads, or both are absent (B1 round-2 finding 3: self-validation only on positive identification). A tree laid out as a
 * staging tree or a kit never is, whatever HOLDR_ROOT names (B1 round-3 finding 1).
 */
export function isManagedLiveSelf(env: NodeJS.ProcessEnv, configPath: string | null, root = REPO_ROOT): boolean {
  if (!env.HOME || !isCanonicalAbsolute(env.HOME) || nonLiveLayout(root)) return false;
  let tree: string | undefined;
  try {
    tree = managedLive(env)?.tree;
  } catch {
    return false;
  }
  if (!tree || physical(root) !== tree) return false;
  const live = defaultConfPath(env.HOME);
  return configPath === null ? !exists(live) : isFile(live) && physical(configPath) === physical(live);
}

/** The live tree for messages: `managedLive`'s, or a placeholder when there is none or it is refused. */
function liveTreeForMessage(env: NodeJS.ProcessEnv): string {
  try {
    return managedLive(env)?.tree ?? '<T>';
  } catch {
    return '<T>';
  }
}

/** The seed's marker of a disposable data directory (`DISPOSABLE_MARKER`, e2e/syntheticSeed.ts, which a leased role may not load). */
export const DISPOSABLE_MARKER_NAME = '.holdr-e2e-disposable';

/**
 * The leased role's own check of a disposable stack, without the seed's module (it may start a process on Windows, and a
 * leased role may not load one): a run identity, `HOLDR_CONFIG=none` and the seed's marker, a private regular file of this
 * user, in the data directory. The CLIs that choose the target run the seed's full check (`isDisposableDataDir`).
 */
export function disposableStackFacts(env: NodeJS.ProcessEnv, configPath: string | null, dataDir: string): boolean {
  if (!/^[0-9a-f]{32}$/.test(env.HOLDR_E2E_RUN_ID ?? '') || configPath !== null || env.HOLDR_CONFIG !== 'none') return false;
  try {
    const marker = fs.lstatSync(path.join(dataDir, DISPOSABLE_MARKER_NAME));
    return marker.isFile() && marker.nlink === 1 && marker.uid === process.getuid?.();
  } catch {
    return false;
  }
}

/** How to validate the live deployment from here instead (§11.2 step 5): a snapshot of it, named as the target. */
const nameTarget = (tree: string) => `name the live deployment instead: snapshot it (rollback-kit.sh snapshot --snap <SNAP> --tree ${tree}), `
  + `then --snap <SNAP> --target-root ${tree} --target-config <SNAP/holdr.conf|none>`;

export function leaveTarget(env: NodeJS.ProcessEnv, configPath: string | null, explicit: readonly string[], root = REPO_ROOT,
  options: { disposable?: boolean } = {}): LeaveTarget {
  if (explicit.length) {
    // Exactly the named target (B-D22, B-D23), but never a staging tree or a kit standing in for the live deployment.
    const targetRoot = explicit[explicit.indexOf('--target-root') + 1];
    const layout = targetRoot ? nonLiveLayout(targetRoot) : null;
    if (layout) refuse(`the named target ${targetRoot} is a staging tree or a rollback kit (${layout} holds a holdr.conf or kit-runtime.txt), not the live deployment`);
    return { kind: 'explicit', args: explicit };
  }
  const kr = kitRoot(root);
  if (!kr) {
    // The layout first (B1 round-3 finding 1): no HOLDR_ROOT, configuration or disposable claim makes such a tree validate itself.
    const layout = nonLiveLayout(root);
    if (layout) {
      refuse(`${layout} looks like a rollback kit or a staging tree, not the live deployment, and validates nothing by itself; ${nameTarget(liveTreeForMessage(env))}`);
    }
    if (isManagedLiveSelf(env, configPath, root)) return { kind: 'self', args: [], as: 'live' };
    if (options.disposable) return { kind: 'self', args: [], as: 'disposable' };
    return refuse(`${root} is neither the managed live tree run with the live configuration nor a verified disposable stack; ${nameTarget(liveTreeForMessage(env))}`);
  }
  const kc = path.join(kr, 'holdr.conf');
  if (physical(configPath) !== physical(kc)) refuse(`from the rollback kit ${kr}, run with HOLDR_CONFIG=${kc}`);
  if (!env.HOME || !isCanonicalAbsolute(env.HOME)) refuse('HOME must be an absolute path');
  let tree: string | undefined;
  try {
    tree = managedLive(env)?.tree;
  } catch (error) {
    return refuse(`no live tree: ${(error as { detail?: string }).detail ?? 'HOLDR_ROOT'}`);
  }
  if (!tree) return refuse('the live tree (HOLDR_ROOT/FinanceTracker or ~/Holdr/FinanceTracker) does not exist');
  if (contains(kr, tree) || contains(tree, kr)) refuse(`the live tree ${tree} overlaps the kit ${kr}`);
  const live = defaultConfPath(env.HOME!);
  const snap = path.join(env.HOME!, 'holdr-snapshots', path.basename(kr));
  const usage = `name the target: --snap ${snap} --target-root ${tree} --target-config <file|none>`;
  if (isFile(live) && sameBytes(live, kc)) return { kind: 'live', root: tree, config: live };
  const snapConfig = path.join(snap, 'holdr.conf');
  if (isFile(snapConfig) ? isFile(live) && sameBytes(live, snapConfig) : !exists(live) && isFile(path.join(snap, 'holdr.conf.absent'))) {
    return { kind: 'revert', args: ['--snap', snap, '--target-root', tree, '--target-config', isFile(snapConfig) ? snapConfig : 'none'] };
  }
  return refuse(`from the rollback kit ${kr}: the live configuration ${live} is neither the kit's nor ${snap}'s; ${usage}`);
}

/** One line for the operator: what this leave validates. */
export function describeLeaveTarget(target: LeaveTarget): string {
  switch (target.kind) {
    case 'self': return target.as === 'live' ? 'validating this tree, the managed live tree, with the live configuration'
      : 'validating this disposable stack';
    case 'explicit': return `validating ${target.args[target.args.indexOf('--target-root') + 1]} as named (${target.args.join(' ')})`;
    case 'live': return `rollback kit: validating the live tree ${target.root} with its own code and the live configuration ${target.config}`;
    case 'revert': return `rollback kit: validating the reverted live tree (${target.args.join(' ')})`;
  }
}
