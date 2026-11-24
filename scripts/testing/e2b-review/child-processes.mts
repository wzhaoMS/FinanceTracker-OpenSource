import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fs, path, TREE, LOADER, HERE } from './probe-common.mts';

export const children = new Set<ReturnType<typeof spawn>>();
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function waitFor(predicate: () => boolean, label: string, ms = 20000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await sleep(20);
  }
}

export function launch(options: any, main = path.join(HERE, 'probe-worker.mts')) {
  const child = spawn(process.execPath, ['--import', LOADER, main, JSON.stringify(options)], {
    cwd: TREE, env: options.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const messages: any[] = [];
  let stdout = '';
  let stderr = '';
  let line = '';
  let exited = false;
  const done = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { exited = true; children.delete(child); resolve({ code, signal }); });
  });
  child.stdout!.on('data', (chunk) => {
    stdout += String(chunk);
    line += String(chunk);
    for (;;) {
      const at = line.indexOf('\n');
      if (at < 0) break;
      const text = line.slice(0, at);
      line = line.slice(at + 1);
      try { messages.push(JSON.parse(text)); } catch { /* leased validation emits ordinary log lines */ }
    }
  });
  child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  return {
    child, messages, done,
    stdout: () => stdout,
    stderr: () => stderr,
    async message(predicate: (value: any) => boolean, label: string) {
      await waitFor(() => messages.some(predicate) || exited, label, 45000);
      const value = messages.find(predicate);
      assert(value, `${label}; early child exit: ${stdout}\n${stderr}`);
      return value;
    },
    async completed() {
      const value = await this.message((m: any) => m.done === true, 'child completion');
      const exit = await done;
      assert.equal(exit.code, 0, `${stdout}\n${stderr}`);
      return { ...value, output: stdout, errorOutput: stderr };
    },
    async kill() {
      if (!exited) {
        assert(child.pid);
        process.kill(child.pid, 0);
        child.kill('SIGKILL');
      }
      const exit = await done;
      assert.equal(exit.signal, 'SIGKILL');
    },
  };
}

export async function cleanupChildren() {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  })));
}
