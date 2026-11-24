// The deployment's snapshot, rollback kit, apply and revert (design §11.3–§11.5) on disposable trees: a small copy of this
// repository (scripts, the API and shared sources, the packages the CLIs load) plays the live tree T and the staged
// candidate; nothing touches a real HOME, ~/bin, Tailscale or Holdr data. macOS only (APFS clones, O_EXLOCK leases).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, cp, symlink, readdir, stat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

import { fakeTailscale, markerText, repo, serveShape, withTestTools, writeLockf, ORIGIN } from './start-finance-mac.fixture.mjs';

const darwin = { skip: process.platform !== 'darwin' };
const NPM = path.join(path.dirname(process.execPath), 'npm');
const TEST_API_PORT = Number(process.env.HOLDR_TEST_API_PORT ?? 4125);
const TEST_WEB_PORT = Number(process.env.HOLDR_TEST_WEB_PORT ?? 5325);
const TEST_PREFLIGHT_BRIDGE_PORT = process.env.HOLDR_TEST_API_PORT ? (TEST_API_PORT === 4115 ? 4116 : 4115) : 5324;
const PACKAGES = ['tsx', 'esbuild', '@esbuild', 'get-tsconfig', 'resolve-pkg-maps', 'better-sqlite3', 'bindings', 'file-uri-to-path',
  'parse5', 'entities', 'css-tree', 'mdn-data', 'source-map-js'];

/**
 * A working Holdr tree in miniature: the real scripts and sources, and the node_modules the CLIs and roles load. The operator
 * scripts' configurable Node line is pinned to this test's runtime in the disposable copies.
 */
async function miniTree(dir, { modules = true } = {}) {
  await mkdir(dir, { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) await cp(path.join(repo, file), path.join(dir, file));
  await cp(path.join(repo, 'scripts'), path.join(dir, 'scripts'), { recursive: true, verbatimSymlinks: true,
    filter: (source) => !source.endsWith('.test.mjs') });
  for (const name of await readdir(path.join(dir, 'scripts'))) {
    if (!name.endsWith('.sh')) continue;
    const file = path.join(dir, 'scripts', name);
    const text = await readFile(file, 'utf8');
    if (text.includes('NODE="${HOLDR_NODE:-$(command -v node || true)}"')) await writeFile(file, withTestTools(text));
  }
  for (const part of ['package.json', 'tsconfig.json', 'src']) {
    await cp(path.join(repo, 'apps/api', part), path.join(dir, 'apps/api', part), { recursive: true, filter: (source) => !/\.test\.ts$|\.integration\.ts$/.test(source) });
  }
  // The CLIs load @finance-tracker/shared from its compiled dist (npm run build --workspace @finance-tracker/shared).
  assert.ok(existsSync(path.join(repo, 'packages/shared/dist/index.js')), 'build packages/shared before these tests');
  for (const part of ['package.json', 'src', 'dist']) await cp(path.join(repo, 'packages/shared', part), path.join(dir, 'packages/shared', part), { recursive: true });
  if (modules) await addModules(dir);
}
async function addModules(dir) {
  await mkdir(path.join(dir, 'node_modules/.bin'), { recursive: true });
  await mkdir(path.join(dir, 'node_modules/@finance-tracker'), { recursive: true });
  for (const name of PACKAGES) {
    const result = spawnSync('/bin/cp', ['-cRp', path.join(repo, 'node_modules', name), path.join(dir, 'node_modules', name)]);
    assert.equal(result.status, 0, String(result.stderr));
  }
  await symlink('../tsx/dist/cli.mjs', path.join(dir, 'node_modules/.bin/tsx'));
  await symlink('../../packages/shared', path.join(dir, 'node_modules/@finance-tracker/shared'));
  await symlink('../../apps/api', path.join(dir, 'node_modules/@finance-tracker/api'));
}

function run(file, args, { env, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.once('close', (code) => resolve({ code, output }));
  });
}

/** A verified release built with the shared builder, placed where the digest says. */
async function buildRelease(tree, label = 'synthetic release') {
  const out = spawnSync(process.execPath, ['--import', path.join(repo, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', `
    import fs from 'node:fs';
    import path from 'node:path';
    import { buildManifest } from ${JSON.stringify(path.join(repo, 'packages/shared/src/webRelease/files.ts'))};
    const root = ${JSON.stringify(path.join(tree, 'apps/web/releases/building'))};
    fs.mkdirSync(path.join(root, 'public/assets'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'public/index.html'), '<!doctype html><html><head><script type="module" crossorigin src="/assets/app-1.js"></script></head><body><div id="root"></div></body></html>\\n');
    fs.writeFileSync(path.join(root, 'public/assets/app-1.js'), ${JSON.stringify(`console.log(${JSON.stringify(label)});\n`)});
    const built = buildManifest(path.join(root, 'public'), 'a'.repeat(40));
    fs.writeFileSync(path.join(root, 'manifest.json'), built.bytes);
    fs.renameSync(root, path.join(path.dirname(root), built.digest.slice(0, 12)));
    console.log(built.digest);
  `], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
}

/** The live tree T (old code), a staged candidate C, the control dir, a data dir and the fake Tailscale CLI. */
const RETIRED = 'scripts/update-casey-brokeragelink-2026-05-12.mjs';

async function deployment({ corruptRelease = false, retiredWriter = false, kitEscape = false } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'holdr-deploy-test-'));
  const root = path.join(home, 'Holdr');
  const T = path.join(root, 'FinanceTracker');
  await miniTree(T);
  // A retired one-off writer the old live tree still has (synthetic canary; never executed).
  if (retiredWriter) await writeFile(path.join(T, RETIRED), 'throw new Error("synthetic retired writer, never run");\n', { mode: 0o755 });
  await mkdir(path.join(home, 'bin'), { recursive: true });
  await writeFile(path.join(home, 'bin/start-finance-mac.sh'), '#!/bin/bash\necho login-era launcher\n', { mode: 0o755 });
  const stage = path.join(home, 'holdr-staging/C');
  const C = path.join(stage, 'FinanceTracker');
  await miniTree(C, { modules: false });
  await writeFile(path.join(C, 'scripts/NEW-IN-C.txt'), 'the candidate\n');
  if (kitEscape) {
    // B2 review 6: a link chain whose text collapses inside K, while the kernel resolves it to HOME/OUTSIDE.
    await mkdir(path.join(C, 'a/b/c'), { recursive: true });
    await mkdir(path.join(C, 'flat'));
    await symlink('../../../flat', path.join(C, 'a/b/c/l'));
    await symlink('a/b/c/l/../../../../OUTSIDE', path.join(C, 'escape'));
    await writeFile(path.join(home, 'OUTSIDE'), 'external canary\n');
  }
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: process.env.TMPDIR,
    HOLDR_ROOT: root, HOLDR_TAILSCALE_WAIT: '0',
  };
  const recorded = await run('/bin/bash', [path.join(C, 'scripts/deploy-apply.sh'), '--record-archive'], { env });
  assert.equal(recorded.code, 0, recorded.output);
  await addModules(C);
  const digest = await buildRelease(C);
  if (corruptRelease) await writeFile(path.join(C, 'apps/web/releases', digest.slice(0, 12), 'public/assets/app-1.js'), 'tampered\n');
  await mkdir(path.join(C, 'apps/api/native/build'), { recursive: true });
  await writeFile(path.join(C, 'apps/api/native/build/placeholder'), 'synthetic\n');
  const tailscale = await fakeTailscale({ home }, '{}\n');
  const dataDir = path.join(home, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  const controlDir = path.join(home, 'Library/Application Support/Holdr/control');
  const socket = path.join(home, 'Library/Application Support/Holdr/run/ingress.sock');
  const candidate = path.join(stage, 'holdr.conf');
  await writeFile(candidate, [`HOLDR_WEB_MODE=dist`, `HOLDR_PUBLIC_ORIGIN=${ORIGIN}`, `HOLDR_WEB_RELEASE=${digest}`, `HOLDR_DATA_DIR=${dataDir}`,
    `HOLDR_CONTROL_DIR=${controlDir}`, `HOLDR_SERVE_SOCKET=${socket}`, `HOLDR_TAILSCALE_CLI=${tailscale.cli}`, 'HOLDR_DEVICE_API=0',
    'HOLDR_LEGACY_VITE_ROLLBACK=1', `HOLDR_NATIVE_COMMIT=${'c'.repeat(40)}`, `HOLDR_NATIVE_MANIFEST=${'d'.repeat(64)}`, ''].join('\n'), { mode: 0o600 });
  // §11.2 step 5: init from the staging tree.
  const init = await run(NPM, ['--silent', 'run', 'holdr-recovery', '--', 'init'], { env: { ...env, HOLDR_CONFIG: candidate }, cwd: C });
  assert.equal(init.code, 0, init.output);
  const SNAP = path.join(home, 'holdr-snapshots/20261017T130000Z');
  const KR = path.join(home, 'holdr-rollback/20261017T130000Z');
  return { home, root, T, stage, C, env, digest, tailscale, dataDir, controlDir, socket, candidate, SNAP, KR, K: path.join(KR, 'FinanceTracker'),
    KC: path.join(KR, 'holdr.conf'), cleanup: () => rm(home, { recursive: true, force: true }) };
}

const lifecycle = (d, args) => run(NPM, ['--silent', 'run', 'holdr-lifecycle', '--', ...args], { env: { ...d.env, HOLDR_CONFIG: d.KC }, cwd: d.K });
const markerState = async (d) => JSON.parse(await readFile(path.join(d.controlDir, 'lifecycle-state'), 'utf8')).state;

test('snapshot, kit, maintenance apply under the lease, and leave (§11.3–§11.4)', { ...darwin, timeout: 600_000 }, async () => {
  const d = await deployment();
  try {
    const snapshot = await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'snapshot', '--snap', d.SNAP, '--tree', d.T],
      { env: { ...d.env, HOLDR_TAILSCALE: d.tailscale.cli } });
    assert.equal(snapshot.code, 0, snapshot.output);
    assert.ok(existsSync(path.join(d.SNAP, 'holdr.conf.absent')), 'first deployment: no live holdr.conf');
    assert.equal(await readFile(path.join(d.SNAP, 'serve-status.json'), 'utf8'), '{}\n');
    const kit = await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'prepare', '--snap', d.SNAP, '--stage', d.stage], { env: d.env });
    assert.equal(kit.code, 0, kit.output);
    assert.match(kit.output, /rollback kit .* verified/);
    assert.equal((await stat(d.KR)).mode & 0o777, 0o700);
    assert.equal(await readFile(d.KC, 'utf8'), await readFile(d.candidate, 'utf8'));
    assert.equal((await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'prepare', '--snap', d.SNAP, '--stage', d.stage], { env: d.env })).code, 1,
      'a kit is never reused');

    assert.equal((await lifecycle(d, ['enter', '--reason', 'deploy'])).code, 0);
    const apply = await lifecycle(d, ['exclusive', '--timeout', '10', '--leave', '--', '/bin/bash', path.join(d.C, 'scripts/deploy-apply.sh'), '--kit', d.K]);
    assert.equal(apply.code, 0, apply.output);
    assert.match(apply.output, /applied C to .* validated offline under the inherited lease/);
    assert.match(apply.output, /lifecycle: normal/);
    assert.equal(await markerState(d), 'normal');
    assert.equal(await readFile(path.join(d.T, 'scripts/NEW-IN-C.txt'), 'utf8'), 'the candidate\n');
    assert.equal(await readFile(path.join(d.home, 'Library/Application Support/Holdr/holdr.conf'), 'utf8'), await readFile(d.candidate, 'utf8'));
    assert.equal((await stat(path.join(d.home, 'Library/Application Support/Holdr/holdr.conf'))).mode & 0o777, 0o600);
    assert.equal(await readFile(path.join(d.home, 'bin/start-finance-mac.sh'), 'utf8'), await readFile(path.join(d.T, 'scripts/start-finance-mac.sh'), 'utf8'));
    assert.ok(existsSync(path.join(d.T, 'apps/web/releases', d.digest.slice(0, 12), 'manifest.json')));
    // The kit is untouched by the deployment.
    assert.equal((await run('/bin/bash', [path.join(d.K, 'scripts/rollback-kit.sh'), 'verify', '--snap', d.SNAP], { env: d.env })).code, 0);
  } finally { await d.cleanup(); }
});

test('an apply failure reverts from the kit inside the same lease: tree, start script, configuration and Serve as recorded (§11.5 row 2)', { ...darwin, timeout: 600_000 }, async () => {
  const d = await deployment({ corruptRelease: true });
  try {
    // A later deployment: the live tree runs an older dist release, its configuration names it, Serve is on the socket.
    const old = await buildRelease(d.T, 'the previous release');
    const live = path.join(d.home, 'Library/Application Support/Holdr/holdr.conf');
    const liveText = (await readFile(d.candidate, 'utf8')).replace(/HOLDR_WEB_RELEASE=.*/, `HOLDR_WEB_RELEASE=${old}`);
    await writeFile(live, liveText, { mode: 0o600 });
    await writeFile(`${d.tailscale.cli}.serve.json`, serveShape(`unix:${d.socket}`));
    const snapshot = await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'snapshot', '--snap', d.SNAP, '--tree', d.T], { env: d.env });
    assert.equal(snapshot.code, 0, snapshot.output);
    assert.equal(await readFile(path.join(d.SNAP, 'holdr.conf'), 'utf8'), liveText);
    assert.equal((await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'prepare', '--snap', d.SNAP, '--stage', d.stage], { env: d.env })).code, 0);
    assert.equal((await lifecycle(d, ['enter', '--reason', 'deploy'])).code, 0);
    // Serve drifted during the window (an operator turned it off): the revert restores the recorded socket target.
    await writeFile(`${d.tailscale.cli}.serve.json`, '{}\n');
    const apply = await lifecycle(d, ['exclusive', '--timeout', '10', '--leave', '--', '/bin/bash', path.join(d.C, 'scripts/deploy-apply.sh'), '--kit', d.K]);
    assert.equal(apply.code, 4, apply.output);
    assert.match(apply.output, /holdr-leased verify-release: E0I_RELEASE_HASH/);
    assert.match(apply.output, /step c failed; reverting/);
    assert.match(apply.output, /reverted .* \(target configuration: .*holdr\.conf; Serve: approved-dist\)/);
    assert.equal(await markerState(d), 'maintenance');
    assert.equal(existsSync(path.join(d.T, 'scripts/NEW-IN-C.txt')), false, 'the tree is the snapshot again');
    assert.equal(await readFile(live, 'utf8'), liveText, 'the target configuration, not the kit configuration');
    assert.equal(await readFile(path.join(d.home, 'bin/start-finance-mac.sh'), 'utf8'), '#!/bin/bash\necho login-era launcher\n');
    assert.equal(await d.tailscale.serveJson(), serveShape(`unix:${d.socket}`));
    const calls = (await d.tailscale.calls()).map((call) => call.args.join(' '));
    assert.ok(!calls.some((call) => call.includes('http://')), 'never a TCP target');
    // B1 review 2 (B2's cross-cutting note): from the kit, a bare leave validates the live deployment, here the revert target,
    // never the kit's own tree and release. With the live release corrupted it refuses and keeps maintenance.
    const liveAsset = path.join(d.T, 'apps/web/releases', old.slice(0, 12), 'public/assets/app-1.js');
    await writeFile(liveAsset, 'live tree corrupted\n');
    const corrupt = await lifecycle(d, ['leave', '--timeout', '5']);
    assert.equal(corrupt.code, 1, corrupt.output);
    assert.match(corrupt.output, /rollback kit: validating the reverted live tree \(--snap /);
    assert.equal(await markerState(d), 'maintenance');
    const explicit = await lifecycle(d, ['leave', '--timeout', '5', '--snap', d.SNAP, '--target-root', d.T, '--target-config', path.join(d.SNAP, 'holdr.conf')]);
    assert.equal(explicit.code, 1, explicit.output);
    // The kit's own validate-offline never validates the kit: only a named target.
    const bare = await lifecycle(d, ['exclusive', '--timeout', '5', '--', '/bin/bash', path.join(d.K, 'scripts/holdr-leased.sh'), 'validate-offline']);
    assert.notEqual(bare.code, 0, bare.output);
    assert.match(bare.output, /E0I_LEAVE_TARGET/);
    // B1 round-2 finding 3: with kit-runtime.txt missing the kit is no longer recognized, and still validates nothing by itself:
    // neither the bare leave nor its role falls back to the kit's own tree.
    const runtime = path.join(d.KR, 'kit-runtime.txt');
    const kept = await readFile(runtime);
    await rm(runtime);
    const partial = await lifecycle(d, ['leave', '--timeout', '5']);
    assert.equal(partial.code, 64, partial.output);
    assert.match(partial.output, /E0I_LEAVE_TARGET .*looks like a rollback kit or a staging tree/);
    const partialRole = await lifecycle(d, ['exclusive', '--timeout', '5', '--', '/bin/bash', path.join(d.K, 'scripts/holdr-leased.sh'), 'validate-offline']);
    assert.notEqual(partialRole.code, 0, partialRole.output);
    assert.match(partialRole.output, /E0I_LEAVE_TARGET/);
    // B1 round-3 finding 1: HOLDR_ROOT naming the incomplete kit's root, run with the real live configuration, makes it no
    // more the live tree: neither the bare leave nor the role inside the lease validates the kit's own tree.
    const kitRooted = { env: { ...d.env, HOLDR_ROOT: d.KR, HOLDR_CONFIG: live }, cwd: d.K };
    const partialRooted = await run(NPM, ['--silent', 'run', 'holdr-lifecycle', '--', 'leave', '--timeout', '5'], kitRooted);
    assert.equal(partialRooted.code, 64, partialRooted.output);
    assert.match(partialRooted.output, /E0I_LEAVE_TARGET .*looks like a rollback kit or a staging tree/);
    const partialRootedRole = await run(NPM, ['--silent', 'run', 'holdr-lifecycle', '--', 'exclusive', '--timeout', '5', '--', '/bin/bash',
      path.join(d.K, 'scripts/holdr-leased.sh'), 'validate-offline'], kitRooted);
    assert.notEqual(partialRootedRole.code, 0, partialRootedRole.output);
    assert.match(partialRootedRole.output, /holdr-leased validate-offline: E0I_LEAVE_TARGET .*is a staging tree or a rollback kit/);
    assert.doesNotMatch(partialRootedRole.output, /VALIDATED/);
    await writeFile(runtime, kept, { mode: 0o600 });
    // Nor does the staging tree, run with the live configuration (live operation state).
    const staged = await run(NPM, ['--silent', 'run', 'holdr-lifecycle', '--', 'leave', '--timeout', '5'],
      { env: { ...d.env, HOLDR_CONFIG: live }, cwd: d.C });
    assert.equal(staged.code, 64, staged.output);
    assert.match(staged.output, /E0I_LEAVE_TARGET/);
    // B1 round-3 finding 1, the review's repro: the staging tree's CLI with HOLDR_ROOT naming the staging parent and the real
    // live configuration. Before the fix the leave took the staging tree for the live one and its role validated the staging
    // release (exit 0); now both refuse.
    const stageRooted = { env: { ...d.env, HOLDR_ROOT: d.stage, HOLDR_CONFIG: live }, cwd: d.C };
    const stagedRooted = await run(NPM, ['--silent', 'run', 'holdr-lifecycle', '--', 'leave', '--timeout', '5'], stageRooted);
    assert.equal(stagedRooted.code, 64, stagedRooted.output);
    assert.match(stagedRooted.output, /E0I_LEAVE_TARGET .*looks like a rollback kit or a staging tree/);
    const stagedRootedRole = await run(NPM, ['--silent', 'run', 'holdr-lifecycle', '--', 'exclusive', '--timeout', '5', '--', '/bin/bash',
      path.join(d.C, 'scripts/holdr-leased.sh'), 'validate-offline'], stageRooted);
    assert.notEqual(stagedRootedRole.code, 0, stagedRootedRole.output);
    assert.match(stagedRootedRole.output, /holdr-leased validate-offline: E0I_LEAVE_TARGET .*is a staging tree or a rollback kit/);
    assert.doesNotMatch(stagedRootedRole.output, /VALIDATED/);
    assert.equal(await markerState(d), 'maintenance');
    // Restored from the snapshot as the revert would (bytes, mode and time).
    assert.equal(spawnSync('/bin/cp', ['-p', path.join(d.SNAP, 'FinanceTracker', path.relative(d.T, liveAsset)), liveAsset]).status, 0);
    const left = await lifecycle(d, ['leave', '--timeout', '5']);
    assert.equal(left.code, 0, left.output);
    assert.equal(await markerState(d), 'normal');
  } finally { await d.cleanup(); }
});

test('a revert to a login-era Vite target keeps Serve on the socket, never publishes TCP, and the lease is required (§11.5)', { ...darwin, timeout: 600_000 }, async () => {
  const d = await deployment();
  try {
    const viteTarget = 'http://127.0.0.1:8888';
    await writeFile(`${d.tailscale.cli}.serve.json`, serveShape(viteTarget));
    const snapshot = await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'snapshot', '--snap', d.SNAP, '--tree', d.T],
      { env: { ...d.env, HOLDR_TAILSCALE: d.tailscale.cli } });
    assert.equal(snapshot.code, 0, snapshot.output);
    assert.equal((await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'prepare', '--snap', d.SNAP, '--stage', d.stage], { env: d.env })).code, 0);
    // Without the lease the role refuses before touching anything.
    const unleased = await run('/bin/bash', [path.join(d.K, 'scripts/deploy-apply.sh'), '--revert', d.SNAP, '--kit', d.K], { env: { ...d.env, HOLDR_CONFIG: d.KC } });
    assert.equal(unleased.code, 3, unleased.output);
    assert.match(unleased.output, /E0I_LEASE_REQUIRED/);
    assert.equal((await lifecycle(d, ['enter', '--reason', 'rollback'])).code, 0);
    await writeFile(`${d.tailscale.cli}.serve.json`, '{}\n');
    const revert = await lifecycle(d, ['exclusive', '--timeout', '10', '--', '/bin/bash', path.join(d.K, 'scripts/deploy-apply.sh'), '--revert', d.SNAP, '--kit', d.K]);
    assert.equal(revert.code, 0, revert.output);
    assert.match(revert.output, /Serve stays on the socket target \(502\)/);
    assert.match(revert.output, /holdr-publish-legacy\.sh" --root/);
    assert.equal(await d.tailscale.serveJson(), serveShape(`unix:${d.socket}`), 'never left empty, never re-published as TCP');
    assert.equal(existsSync(path.join(d.home, 'Library/Application Support/Holdr/holdr.conf')), false, 'holdr.conf.absent: no live file');
    const leave = await lifecycle(d, ['leave', '--timeout', '5', '--snap', d.SNAP, '--target-root', d.T, '--target-config', 'none']);
    assert.equal(leave.code, 0, leave.output);
    assert.equal(await markerState(d), 'normal');
  } finally { await d.cleanup(); }
});

test('B2 review 5: an apply retires the managed files the candidate lists, keeps unmanaged ones, and validation refuses a tree with one', { ...darwin, timeout: 600_000 }, async () => {
  const d = await deployment({ retiredWriter: true });
  try {
    await mkdir(path.join(d.T, 'operator-notes'));
    await writeFile(path.join(d.T, 'operator-notes/keep.txt'), 'unmanaged\n');
    assert.equal((await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'snapshot', '--snap', d.SNAP, '--tree', d.T],
      { env: { ...d.env, HOLDR_TAILSCALE: d.tailscale.cli } })).code, 0);
    assert.equal((await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'prepare', '--snap', d.SNAP, '--stage', d.stage], { env: d.env })).code, 0);
    assert.equal((await lifecycle(d, ['enter', '--reason', 'deploy'])).code, 0);
    const apply = await lifecycle(d, ['exclusive', '--timeout', '10', '--leave', '--', '/bin/bash', path.join(d.C, 'scripts/deploy-apply.sh'), '--kit', d.K]);
    assert.equal(apply.code, 0, apply.output);
    assert.match(apply.output, new RegExp(`retired ${RETIRED.replace(/[.]/g, '\\.')}`));
    assert.equal(existsSync(path.join(d.T, RETIRED)), false, 'the retired writer is gone from the live tree');
    assert.ok(existsSync(path.join(d.SNAP, 'FinanceTracker', RETIRED)), 'the snapshot keeps it for a revert');
    assert.equal(await readFile(path.join(d.T, 'operator-notes/keep.txt'), 'utf8'), 'unmanaged\n');
    assert.equal(await markerState(d), 'normal');
    // A retired file back in the tree: offline validation (and so completion) refuses.
    await writeFile(path.join(d.T, RETIRED), 'synthetic\n', { mode: 0o755 });
    assert.equal((await lifecycle(d, ['enter', '--reason', 'check'])).code, 0);
    const refused = await lifecycle(d, ['leave', '--timeout', '5']);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /FAIL retired files: E0I_RETIRED_PRESENT \(scripts\/update-casey-brokeragelink-2026-05-12\.mjs\)/);
    assert.equal(await markerState(d), 'maintenance');
  } finally { await d.cleanup(); }
});

test('B2 review 6: a kit whose symlink chain resolves outside K is refused by prepare and verify', { ...darwin, timeout: 600_000 }, async () => {
  const d = await deployment({ kitEscape: true });
  try {
    assert.equal((await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'snapshot', '--snap', d.SNAP, '--tree', d.T],
      { env: { ...d.env, HOLDR_TAILSCALE: d.tailscale.cli } })).code, 0);
    const prepared = await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'prepare', '--snap', d.SNAP, '--stage', d.stage], { env: d.env });
    assert.equal(prepared.code, 1, prepared.output);
    assert.match(prepared.output, /rollback-kit: \{"link":"\.\/FinanceTracker\/escape","target":"a\/b\/c\/l\/\.\.\/\.\.\/\.\.\/\.\.\/OUTSIDE"\}: outside/);
    assert.match(prepared.output, /a name or symlink in the kit is refused, absolute or resolves outside K/);
    const verified = await run('/bin/bash', [path.join(d.K, 'scripts/rollback-kit.sh'), 'verify', '--snap', d.SNAP], { env: d.env });
    assert.equal(verified.code, 1, verified.output);
  } finally { await d.cleanup(); }
});

test('B2 round-2 finding 1: delimiter and newline names or targets never pass prepare or verify; contained ones do', { ...darwin, timeout: 900_000 }, async () => {
  const d = await deployment();
  try {
    await writeFile(path.join(d.home, 'OUTSIDE'), 'external canary\n');
    await symlink('OUTSIDE', path.join(d.home, 'outside-link'));
    let stamp = 0;
    const kitFor = async () => {
      const name = `20261018T00000${stamp++}Z`;
      const snap = path.join(d.home, 'holdr-snapshots', name);
      const snapshot = await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'snapshot', '--snap', snap, '--tree', d.T],
        { env: { ...d.env, HOLDR_TAILSCALE: d.tailscale.cli } });
      assert.equal(snapshot.code, 0, snapshot.output);
      const prepared = await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'prepare', '--snap', snap, '--stage', d.stage], { env: d.env });
      return { snap, kr: path.join(d.home, 'holdr-rollback', name), prepared };
    };
    // The review's eight accepted external dependencies (kit-link-record-matrix), each in the staged candidate C.
    const variants = [
      ['delimiter name, absolute target', [['escape -> alias', path.join(d.home, 'OUTSIDE')]], /absolute target/],
      ['delimiter name, parent components', [['escape -> alias', '../../../OUTSIDE']], /outside/],
      ['quoted delimiter name', [['escape " -> " alias', path.join(d.home, 'OUTSIDE')]], /absolute target/],
      ['backslash before the delimiter', [['escape \\ -> alias', path.join(d.home, 'OUTSIDE')]], /absolute target/],
      ['newline target forging a second record', [['escape -> alias', '../../../OUTSIDE\n./FinanceTracker/shadow -> safe']], /a link target with a control character/],
      ['newline in the link path', [['piece\n./FinanceTracker/escape', '../../../../../OUTSIDE']], /a name with a control character/],
      ['trailing newline target, delimiter name', [['escape -> alias', '../../../OUTSIDE\n']], /a link target with a control character/],
      ['delimited chain to an external link', [['jump -> alias', '../../../outside-link'], ['follow -> alias', 'jump -> alias']], /outside/],
    ];
    for (const [what, links, reason] of variants) {
      const made = [];
      for (const [name, target] of links) {
        const file = path.join(d.C, name);
        await mkdir(path.dirname(file), { recursive: true });
        await symlink(target, file);
        made.push(file);
      }
      const { prepared } = await kitFor();
      assert.equal(prepared.code, 1, `${what}: ${prepared.output}`);
      assert.match(prepared.output, reason, what);
      assert.match(prepared.output, /a name or symlink in the kit is refused, absolute or resolves outside K/, what);
      for (const file of made) await rm(file);
      await rm(path.join(d.C, 'piece\n.'), { recursive: true, force: true });
    }
    // Positive controls: a delimiter or quotes inside a contained target are characters, and the kit verifies.
    await writeFile(path.join(d.C, 'inside -> target'), 'pinned inside kit\n');
    await writeFile(path.join(d.C, '"inside -> target"'), 'literal quote bytes\n');
    await symlink('inside -> target', path.join(d.C, 'normal'));
    await symlink('"inside -> target"', path.join(d.C, 'quoted'));
    const good = await kitFor();
    assert.equal(good.prepared.code, 0, good.prepared.output);
    const records = (await readFile(path.join(good.snap, 'rollback-kit.links'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(records.filter((record) => ['./FinanceTracker/normal', './FinanceTracker/quoted'].includes(record.link)),
      [{ link: './FinanceTracker/normal', target: 'inside -> target' }, { link: './FinanceTracker/quoted', target: '"inside -> target"' }]);
    const K = path.join(good.kr, 'FinanceTracker');
    assert.equal((await run('/bin/bash', [path.join(K, 'scripts/rollback-kit.sh'), 'verify', '--snap', good.snap], { env: d.env })).code, 0);
    // After prepare, a link added to the kit, with a newline name or a delimiter name, fails verify.
    for (const [name, target] of [['late\n./FinanceTracker/x', 'file'], ['late -> alias', '../../../OUTSIDE']]) {
      await mkdir(path.dirname(path.join(K, name)), { recursive: true });
      await symlink(target, path.join(K, name));
      const verified = await run('/bin/bash', [path.join(K, 'scripts/rollback-kit.sh'), 'verify', '--snap', good.snap], { env: d.env });
      assert.equal(verified.code, 1, `${JSON.stringify(name)}: ${verified.output}`);
      assert.match(verified.output, /the kit's symlinks differ from .*rollback-kit\.links, or one is refused/);
      await rm(path.join(K, name));
      await rm(path.join(K, 'late\n.'), { recursive: true, force: true });
    }
    assert.equal((await run('/bin/bash', [path.join(K, 'scripts/rollback-kit.sh'), 'verify', '--snap', good.snap], { env: d.env })).code, 0);
  } finally { await d.cleanup(); }
});

/** This checkout's native reader (built once if absent, never overwritten, as the stack tests do), copied into `tree`: its pin. */
function nativeReader(tree) {
  const out = spawnSync(process.execPath, ['--import', path.join(repo, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', `
    import fs from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { NATIVE_DIR, verifyNativeHelper } from ${JSON.stringify(path.join(repo, 'apps/api/src/ingress/nativeHelper.ts'))};
    if (!fs.existsSync(NATIVE_DIR + '/build')) {
      execFileSync(process.execPath, ['--import', 'tsx', ${JSON.stringify(path.join(repo, 'apps/api/scripts/buildNative.ts'))}], { cwd: ${JSON.stringify(repo)}, stdio: 'ignore', timeout: 120_000 });
    }
    const verified = verifyNativeHelper();
    console.log(JSON.stringify({ commit: verified.manifest.sourceCommit, manifest: verified.manifestDigest }));
  `], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const result = spawnSync('/bin/cp', ['-Rp', path.join(repo, 'apps/api/native/'), path.join(tree, 'apps/api/native')]);
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(spawnSync('/bin/rm', ['-f', path.join(tree, 'apps/api/native/build/placeholder')]).status, 0);
  return JSON.parse(out.stdout);
}

const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('B1 round-3 finding 2, B2 round 3: an interrupted first init completes from the staging tree as documented, the login-era API stopped by the live root (§11.2 step 5)', { ...darwin, timeout: 900_000 }, async () => {
  const d = await deployment();
  let api;
  let socketDir;
  try {
    // The login-era live state: a database with a user (K23), read by the old API, which knows nothing of the lifecycle.
    const seeded = spawnSync(process.execPath, ['--import', path.join(d.C, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', `
      import { SqliteStateRepo } from ${JSON.stringify(path.join(d.C, 'apps/api/src/services/sqliteStateRepo.ts'))};
      import { LocalAuthRepo } from ${JSON.stringify(path.join(d.C, 'apps/api/src/services/localAuthRepo.ts'))};
      import { hashPassword } from ${JSON.stringify(path.join(d.C, 'apps/api/src/auth/password.ts'))};
      process.umask(0o077);
      const db = new SqliteStateRepo({ file: ${JSON.stringify(path.join(d.dataDir, 'finance.db'))} });
      new LocalAuthRepo(db).createUser('synthetic-owner', await hashPassword('synthetic fixture password', { ln: 10, r: 8, p: 1 }));
      db.close();
    `], { encoding: 'utf8' });
    assert.equal(seeded.status, 0, seeded.stderr);
    const hashOf = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
    const dbHash = await hashOf(path.join(d.dataDir, 'finance.db'));
    // The candidate pins a real native reader (the staged preflight verifies it, K30) and a socket path the reader accepts
    // (at most 100 bytes: a short private directory under the checkout, as the start-script fixture uses); the bridge runtime
    // exists.
    const pin = nativeReader(d.C);
    socketDir = path.join(repo, `.d-${randomBytes(4).toString('hex')}`);
    await mkdir(socketDir, { mode: 0o700 });
    await writeFile(d.candidate, (await readFile(d.candidate, 'utf8')).replace(/^HOLDR_NATIVE_COMMIT=.*$/m, `HOLDR_NATIVE_COMMIT=${pin.commit}`)
      .replace(/^HOLDR_NATIVE_MANIFEST=.*$/m, `HOLDR_NATIVE_MANIFEST=${pin.manifest}`)
      .replace(/^HOLDR_SERVE_SOCKET=.*$/m, `HOLDR_SERVE_SOCKET=${path.join(socketDir, 's')}`), { mode: 0o600 });
    const runtime = path.join(d.home, 'Library/Application Support/Holdr');
    await mkdir(path.join(runtime, 'portfolio-bridge'), { recursive: true });
    await mkdir(path.join(runtime, '.venv313/bin'), { recursive: true });
    await writeFile(path.join(runtime, 'portfolio-bridge/server.py'), '', { mode: 0o600 });
    await writeFile(path.join(runtime, '.venv313/bin/python'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    // The interrupted init: only lifecycle.lock was created.
    await rm(d.controlDir, { recursive: true, force: true });
    await mkdir(d.controlDir, { mode: 0o700 });
    await writeFile(path.join(d.controlDir, 'lifecycle.lock'), '', { mode: 0o600 });
    const lockIno = (await stat(path.join(d.controlDir, 'lifecycle.lock'))).ino;
    // The login-era API stand-in, running from T: this user's process, cwd T/apps/api, a command naming T/node_modules/… and
    // src/index.ts, on the API port, with finance.db open.
    const T = await realpath(d.T);
    const service = path.join(T, 'node_modules/login-era-api.cjs');
    await writeFile(service, `
      require('node:fs').openSync(${JSON.stringify(path.join(d.dataDir, 'finance.db'))}, 'r');
      const server = require('node:http').createServer((_q, r) => r.end('synthetic login-era API'));
      server.listen(${TEST_API_PORT}, '127.0.0.1', () => process.stdout.write('ready\\n'));
      process.on('SIGTERM', () => { server.close(); process.exit(0); });
    `, { mode: 0o600 });
    api = spawn(process.execPath, [service, 'src/index.ts'], { cwd: path.join(T, 'apps/api'), stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => { api.stdout.once('data', resolve); api.once('exit', () => reject(new Error('the stand-in exited'))); });
    const apiExited = new Promise((resolve) => api.once('exit', resolve));
    // The documented commands: HOLDR_ROOT unset, the staging tree's npm scripts with the candidate configuration. The stop role
    // probes every service port and refuses any listener that is not Holdr's, so web and bridge share this fixture's
    // unused web port. Test port overrides must apply to the listener and every stop/preflight argument together.
    const env = { ...d.env, HOLDR_API_PORT: String(TEST_API_PORT), HOLDR_WEB_PORT: String(TEST_WEB_PORT),
      HOLDR_BRIDGE_PORT: String(TEST_WEB_PORT), HOLDR_LOG_DIR: path.join(d.home, 'logs') };
    delete env.HOLDR_ROOT;
    const staged = (args, extra = {}) => run(NPM, ['--silent', 'run', ...args], { env: { ...env, HOLDR_CONFIG: d.candidate, ...extra }, cwd: d.C });
    const fenceFile = path.join(d.controlDir, 'sync-auth-state');

    // A HOLDR_ROOT naming the staging tree is refused before anything changes: the API runs on, the control dir stays partial.
    const wrongRoot = await staged(['holdr-recovery', '--', 'reinit', '--timeout', '5'], { HOLDR_ROOT: d.stage });
    assert.equal(wrongRoot.code, 64, wrongRoot.output);
    assert.match(wrongRoot.output, /holdr-recovery: E0I_NOT_LIVE \(.*holdr-staging\/C holds holdr\.conf: a staging tree or a rollback kit/);
    assert.deepEqual(await readdir(d.controlDir), ['lifecycle.lock']);
    assert.ok(alivePid(api.pid));

    // Step 5.1: reinit from the staging tree. The stop role is aimed at T's parent and stops the login-era API; the control dir
    // is rebuilt under quarantine around the existing lock; the staging tree validates nothing (64, maintenance).
    const reinit = await staged(['holdr-recovery', '--', 'reinit', '--timeout', '5']);
    assert.equal(reinit.code, 64, reinit.output);
    assert.ok(reinit.output.includes(`holdr-stop --root ${d.root}: the managed live deployment (${T})`), reinit.output);
    assert.match(reinit.output, new RegExp(`holdr-stop 2: stopped api:${api.pid}\\b`));
    assert.match(reinit.output, /holdr-recovery: E0I_LEAVE_TARGET \(.*looks like a rollback kit or a staging tree, not the live deployment/);
    assert.ok(reinit.output.includes(`rollback-kit.sh snapshot --snap <SNAP> --tree ${T}), then --snap <SNAP> --target-root ${T} --target-config <SNAP/holdr.conf|none>`), reinit.output);
    await apiExited;
    assert.equal((await stat(path.join(d.controlDir, 'lifecycle.lock'))).ino, lockIno, 'the existing lock file is kept');
    assert.deepEqual((await readdir(d.controlDir)).sort(), ['authorization.lock', 'lifecycle-state', 'lifecycle.lock', 'recovery.lock', 'sync-auth-state']);
    assert.equal(JSON.parse(await readFile(fenceFile, 'utf8')).reason, 'reinit');
    const quarantined = JSON.parse(await readFile(path.join(d.controlDir, 'lifecycle-state'), 'utf8'));
    assert.deepEqual([quarantined.state, quarantined.reason], ['maintenance', 'reinit']);
    const fence = await readFile(fenceFile);

    // Where the review stopped: the required preflight and backup refuse in maintenance, and so does a bare leave.
    const lockf = await writeLockf(path.join(d.home, 'lockf'));
    const outer = path.join(d.home, 'staged-start.sh');
    await writeFile(outer, withTestTools(await readFile(path.join(repo, 'scripts/start-finance-mac.sh'), 'utf8'), { lockf }), { mode: 0o700 });
    // The start script needs three distinct ports; its read-only preflight never binds or probes the bridge port (it only names
    // it in the API's environment), so any free-standing number serves.
    const preflight = () => run('/bin/bash', [outer, '--preflight'], { env: { ...env, HOLDR_BRIDGE_PORT: String(TEST_PREFLIGHT_BRIDGE_PORT),
      HOLDR_CANDIDATE: d.C, HOLDR_CONFIG: d.candidate } });
    const refusedPreflight = await preflight();
    assert.equal(refusedPreflight.code, 1, refusedPreflight.output);
    assert.match(refusedPreflight.output, /E0I_MAINTENANCE/);
    const refusedBackup = await staged(['holdr-backup', '--', '--tree', d.T]);
    assert.equal(refusedBackup.code, 3, refusedBackup.output);
    assert.equal((await staged(['holdr-lifecycle', '--', 'leave', '--timeout', '5'])).code, 64);
    assert.equal(await markerState(d), 'maintenance');

    // Step 5.2: the snapshot of the live deployment as it is (11.3's, taken early).
    const snapshot = await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'snapshot', '--snap', d.SNAP, '--tree', d.T],
      { env: { ...env, HOLDR_TAILSCALE: d.tailscale.cli } });
    assert.equal(snapshot.code, 0, snapshot.output);
    assert.ok(existsSync(path.join(d.SNAP, 'holdr.conf.absent')));
    // A named target that is the staging tree is no live deployment: refused by the leave and by the role inside a lease.
    const stagingTarget = ['--snap', d.SNAP, '--target-root', d.C, '--target-config', 'none'];
    const namedStage = await staged(['holdr-lifecycle', '--', 'leave', '--timeout', '5', ...stagingTarget]);
    assert.equal(namedStage.code, 64, namedStage.output);
    assert.match(namedStage.output, /holdr-lifecycle: E0I_LEAVE_TARGET \(the named target .*holdr-staging\/C\/FinanceTracker is a staging tree or a rollback kit/);
    const namedStageRole = await staged(['holdr-lifecycle', '--', 'exclusive', '--timeout', '5', '--', '/bin/bash',
      path.join(d.C, 'scripts/holdr-leased.sh'), 'validate-offline', ...stagingTarget]);
    assert.equal(namedStageRole.code, 64, namedStageRole.output);
    assert.match(namedStageRole.output, /holdr-leased validate-offline: E0I_LEAVE_TARGET \(the named target .* is a staging tree or a rollback kit/);
    assert.equal(await markerState(d), 'maintenance');
    // Step 5.3: leave, validating the live deployment named against that snapshot.
    const left = await staged(['holdr-lifecycle', '--', 'leave', '--timeout', '10', '--snap', d.SNAP, '--target-root', d.T, '--target-config', 'none']);
    assert.equal(left.code, 0, left.output);
    for (const line of ['ok   tree:', 'ok   target configuration:', 'ok   start script:', 'ok   K20 control dir', 'ok   K21 fence: blocked (reinit)',
      'ok   database: integrity ok', 'VALIDATED offline under the inherited lease', 'lifecycle: normal']) {
      assert.ok(left.output.includes(line), `${line}\n${left.output}`);
    }
    assert.equal(await markerState(d), 'normal');
    assert.ok((await readFile(fenceFile)).equals(fence), 'the device gate stays blocked (reinit), byte for byte');
    assert.equal(await hashOf(path.join(d.dataDir, 'finance.db')), dbHash);

    // Step 6: the staged preflight, exactly as documented (HOLDR_ROOT unset).
    const staged6 = await preflight();
    assert.equal(staged6.code, 0, staged6.output);
    assert.match(staged6.output, /^PREFLIGHT ok mode=dist serve=empty gate="blocked \(reinit/m);
    // 11.3 with this STAMP: the backup, then prepare with the same snapshot (no second snapshot).
    const backup = await staged(['holdr-backup', '--', '--tree', d.T]);
    assert.equal(backup.code, 0, backup.output);
    assert.match(backup.output, /integrity_check ok/);
    const kit = await run('/bin/bash', [path.join(d.C, 'scripts/rollback-kit.sh'), 'prepare', '--snap', d.SNAP, '--stage', d.stage], { env });
    assert.equal(kit.code, 0, kit.output);
    // 11.4 from the kit: enter, the kit's stopper aimed at the live root, the apply under the lease, and its leave.
    const fromKit = (args) => run(NPM, ['--silent', 'run', 'holdr-lifecycle', '--', ...args], { env: { ...env, HOLDR_CONFIG: d.KC }, cwd: d.K });
    assert.equal((await fromKit(['enter', '--reason', 'deploy'])).code, 0);
    const stopped = await run(path.join(d.K, 'scripts/holdr-stop.sh'), ['--root', d.root, '--expect-version', '2'], { env: { ...env, HOLDR_CONFIG: d.KC } });
    assert.equal(stopped.code, 0, stopped.output);
    assert.match(stopped.output, /holdr-stop 2: nothing to stop/);
    const apply = await fromKit(['exclusive', '--timeout', '10', '--leave', '--', '/bin/bash', path.join(d.C, 'scripts/deploy-apply.sh'), '--kit', d.K]);
    assert.equal(apply.code, 0, apply.output);
    assert.match(apply.output, /applied C to .* validated offline under the inherited lease/);
    assert.equal(await markerState(d), 'normal');
    assert.ok((await readFile(fenceFile)).equals(fence), 'still blocked (reinit) after the apply');
    assert.equal(await hashOf(path.join(d.dataDir, 'finance.db')), dbHash);
  } finally {
    if (api && api.exitCode === null && api.signalCode === null) api.kill('SIGKILL');
    if (socketDir) await rm(socketDir, { recursive: true, force: true });
    await d.cleanup();
  }
});

test('B2 round-2 finding 3: in an extracted archive (no git metadata) the native reader builds only with the commit named', { ...darwin, timeout: 300_000 }, async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'holdr-native-stage-')));
  try {
    const tree = path.join(home, 'holdr-staging/C/FinanceTracker');
    await miniTree(tree);
    await cp(path.join(repo, 'apps/api/native'), path.join(tree, 'apps/api/native'), { recursive: true, filter: (source) => !source.includes('/native/build') });
    await cp(path.join(repo, 'apps/api/scripts'), path.join(tree, 'apps/api/scripts'), { recursive: true });
    assert.notEqual(spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: tree }).status, 0, 'the staged tree has no git metadata');
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: process.env.TMPDIR };
    // The runbook's command before the fix: the builder falls back to `git rev-parse HEAD` and refuses.
    const unnamed = await run(NPM, ['--silent', 'run', 'build:native', '-w', '@finance-tracker/api'], { env, cwd: tree });
    assert.notEqual(unnamed.code, 0, unnamed.output);
    assert.match(unnamed.output, /E0I_NATIVE_HELPER: build or verification failed/);
    // §11.2 step 3 as documented now: the commit is named, as for the web release.
    const commit = 'c0ffee'.padEnd(40, '0');
    const built = await run(NPM, ['--silent', 'run', 'build:native', '-w', '@finance-tracker/api', '--', '--commit', commit], { env, cwd: tree });
    assert.equal(built.code, 0, built.output);
    assert.match(built.output, new RegExp(`^NATIVE commit=${commit} manifest=[0-9a-f]{64} binary=[0-9a-f]{64} format=holdr-pathcheck/5$`, 'm'));
    assert.ok(existsSync(path.join(tree, 'apps/api/native/build/holdr-pathcheck')));
    // The runbook names exactly this command.
    const runbook = await readFile(path.join(repo, 'docs/e0i-ingress.md'), 'utf8');
    assert.match(runbook, /npm run build:native -w @finance-tracker\/api -- --commit C/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
