/**
 * Playwright fixtures for the acceptance suite (E2c M6; macOS only): the
 * acceptance build, which carries the production extension id, in
 * Playwright's bundled Chromium, against Holdr's real device API over TLS.
 *
 * - `world` (per worker): the run directory, the fake issuers on loopback,
 *   the synthetic Holdr as its own process (target.ts: E2c's app on a dist
 *   Unix socket behind a TLS stand-in for Tailscale Serve), and the egress
 *   gate, which forwards the fake issuers' plain HTTP and tunnels exactly
 *   `holdr.test:443` to that stand-in; everything else is refused, probed
 *   before anything runs.
 * - `ext` (per test): a fresh disposable profile that trusts exactly the
 *   synthetic Holdr's throwaway key (Chromium's SPKI pin), nothing else.
 *
 * The browser never resolves a name, and nothing reaches the production
 * Holdr or any real site. Only processes and directories this run created
 * are touched.
 */
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, test as base } from '@playwright/test';
import { KEYS } from '../../build/manifest.js';
import { FakeIssuers } from '../e2e/fake/issuers.js';
import { openExtension, runDirectory, type ExtensionSession } from '../e2e/support/browser.js';
import { EgressGate } from '../e2e/support/gate.js';

const here = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_ROOT = resolve(here, '..', '..');
export const REPO_ROOT = resolve(EXTENSION_ROOT, '..', '..');
export const ACCEPTANCE_PATH = join(EXTENSION_ROOT, 'dist', 'acceptance');
export const ACCEPTANCE_ID = KEYS.acceptance.id;
export const HOLDR_TUNNEL = 'holdr.test:443';

export interface Target {
  readonly port: number;
  readonly spki: string;
  readonly bindingId: string;
  readonly stderr: string[];
  call<T = Record<string, unknown>>(op: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

/** Starts target.ts (tsx) and waits for its ready line; commands and answers are JSON lines. */
async function startTarget(): Promise<Target> {
  const child = spawn(process.execPath, [join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(here, 'target.ts')], {
    cwd: EXTENSION_ROOT,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let onReady!: (message: { port: number; spki: string; bindingId: string }) => void;
  let onFailed!: (error: Error) => void;
  const ready = new Promise<{ port: number; spki: string; bindingId: string }>((resolveReady, rejectReady) => {
    onReady = resolveReady;
    onFailed = rejectReady;
  });
  const exited = new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  void exited.then((code) => {
    onFailed(new Error(`the synthetic Holdr exited (${code}): ${stderr.join('').slice(-2_000)}`));
    for (const answer of pending.values()) answer({ ok: false, error: 'the synthetic Holdr exited' });
    pending.clear();
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      stderr.push(`(stdout) ${line}\n`);
      return;
    }
    if (message.ready === true) onReady(message as never);
    else if (typeof message.id === 'number') {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const timer = setTimeout(() => onFailed(new Error(`the synthetic Holdr did not start: ${stderr.join('').slice(-2_000)}`)), 180_000);
  const info = await ready.finally(() => clearTimeout(timer));
  let next = 1;
  const call = <T>(op: string, args: Record<string, unknown> = {}) =>
    new Promise<T>((resolveCall, rejectCall) => {
      const id = next++;
      pending.set(id, (message) => (message.ok === true ? resolveCall(message as T) : rejectCall(new Error(`${op}: ${String(message.error)}`))));
      child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  return {
    ...info,
    stderr,
    call,
    async close() {
      if (child.exitCode !== null) return;
      await call('close').catch(() => undefined);
      const timeout = new Promise<'timeout'>((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 30_000));
      if ((await Promise.race([exited, timeout])) === 'timeout' && child.pid) process.kill(child.pid);
    },
  };
}

export interface AcceptanceWorld {
  readonly runDir: string;
  readonly gate: EgressGate;
  readonly issuers: FakeIssuers;
  readonly target: Target;
}

export type AcceptanceExt = Omit<ExtensionSession, 'close'>;

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'test';
}

let profileCounter = 0;

export const test = base.extend<{ ext: AcceptanceExt }, { world: AcceptanceWorld }>({
  world: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const runDir = runDirectory(REPO_ROOT);
      const issuers = await FakeIssuers.start();
      const target = await startTarget();
      const gate = await EgressGate.start(issuers.ports, new Map([[HOLDR_TUNNEL, target.port]]));
      try {
        await gate.probe();
        await use({ runDir, gate, issuers, target });
      } finally {
        writeFileSync(join(runDir, 'logs', 'acceptance-gate-ledger.json'), JSON.stringify(gate.ledger, null, 1));
        writeFileSync(join(runDir, 'logs', 'acceptance-issuer-requests.json'), JSON.stringify(issuers.requests, null, 1));
        const served = await target.call<{ requests: unknown[] }>('requests').catch(() => ({ requests: [] }));
        writeFileSync(join(runDir, 'logs', 'acceptance-holdr-requests.json'), JSON.stringify(served.requests, null, 1));
        await target.close();
        writeFileSync(join(runDir, 'logs', 'acceptance-holdr.stderr.txt'), target.stderr.join(''));
        await gate.close();
        await issuers.close();
      }
    },
    { scope: 'worker' },
  ],
  ext: async ({ world }, use, testInfo) => {
    world.issuers.reset();
    profileCounter += 1;
    const profileDir = join(world.runDir, 'p', `a${profileCounter}`);
    const session = await openExtension({
      path: ACCEPTANCE_PATH,
      id: ACCEPTANCE_ID,
      proxyPort: world.gate.port,
      profileDir,
      extraArgs: [`--ignore-certificate-errors-spki-list=${world.target.spki}`],
    });
    try {
      await use(session);
    } finally {
      writeFileSync(join(world.runDir, 'logs', `acceptance-${testInfo.workerIndex}-${slug(testInfo.title)}.console.txt`), session.consoleLines.join('\n'));
      await session.close();
      if (process.env.E3_E2E_KEEP !== '1') rmSync(profileDir, { recursive: true, force: true });
    }
  },
});

export { expect };
