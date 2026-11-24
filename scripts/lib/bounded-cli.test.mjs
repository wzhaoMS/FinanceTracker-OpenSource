import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The bounded runner of the operator scripts' CLI calls (B-D33, B2 review finding 4), for real, POSIX only.
const runner = fileURLToPath(new URL('./bounded-cli.mjs', import.meta.url));
const posix = { skip: process.platform === 'win32' };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function run(args, { signalAfterMs } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [runner, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    if (signalAfterMs) setTimeout(() => child.kill('SIGTERM'), signalAfterMs);
    child.once('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), 'bounded-cli-'));
  const script = async (name, body) => {
    const file = path.join(dir, name);
    await writeFile(file, `#!/bin/bash\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  };
  return { dir, script, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('passes the output and the status through; a signal is 128 + n; a missing file is 127; usage errors are 64', posix, async () => {
  const s = await scratch();
  try {
    const ok = await s.script('ok', 'printf "%s|" "$@"; echo err >&2; exit 3');
    assert.deepEqual(await run(['5', ok, 'serve', '--https=443', 'off']).then(({ code, stdout, stderr }) => ({ code, stdout, stderr })),
      { code: 3, stdout: 'serve|--https=443|off|', stderr: 'err\n' });
    assert.equal((await run(['5', await s.script('zero', 'echo done')])).stdout, 'done\n');
    assert.equal((await run(['5', await s.script('killed', 'kill -KILL $$')])).code, 137);
    const missing = await run(['5', path.join(s.dir, 'absent')]);
    assert.equal(missing.code, 127);
    assert.match(missing.stderr, /could not start/);
    for (const args of [[], ['0', ok], ['301', ok], ['5', 'relative'], ['x', ok]]) assert.equal((await run(args)).code, 64, args.join(' '));
  } finally { await s.cleanup(); }
});

test('a command that hangs is stopped at the deadline with 124, together with everything it started', posix, async () => {
  const s = await scratch();
  try {
    const pids = path.join(s.dir, 'pids');
    // Ignores SIGTERM, and leaves a grandchild that would hold the output pipe open.
    const hang = await s.script('hang', `trap '' TERM; sleep 60 & echo $! > "${pids}"; echo $$ >> "${pids}"; wait`);
    const result = await run(['1', hang]);
    assert.equal(result.code, 124);
    assert.match(result.stderr, /did not finish within 1s; stopped/);
    assert.ok(result.ms < 4_000, `${result.ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const pid of (await readFile(pids, 'utf8')).trim().split('\n').map(Number)) assert.equal(alive(pid), false, `pid ${pid}`);
  } finally { await s.cleanup(); }
});

test('a child left behind by a command that exited is killed, so the caller is not held by its pipe', posix, async () => {
  const s = await scratch();
  try {
    const pidFile = path.join(s.dir, 'left');
    const leaves = await s.script('leaves', `sleep 60 & echo $! > "${pidFile}"; echo configured; exit 0`);
    const result = await run(['10', leaves]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'configured\n');
    assert.ok(result.ms < 4_000, `${result.ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(alive(Number(await readFile(pidFile, 'utf8'))), false);
  } finally { await s.cleanup(); }
});

test('SIGTERM to the runner kills the command\'s group first', posix, async () => {
  const s = await scratch();
  try {
    const pidFile = path.join(s.dir, 'pid');
    const hang = await s.script('hang', `echo $$ > "${pidFile}"; trap '' TERM; while :; do sleep 1; done`);
    const result = await run(['60', hang], { signalAfterMs: 500 });
    assert.equal(result.code, 143);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(existsSync(pidFile));
    assert.equal(alive(Number(await readFile(pidFile, 'utf8'))), false);
  } finally { await s.cleanup(); }
});
