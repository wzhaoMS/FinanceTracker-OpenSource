import { spawn, type ChildProcess, type StdioNull, type StdioPipe } from 'node:child_process';

import type { CommandResult } from '../ingress/boundedCommand.js';
import { LEASE_FD_VAR, LEASE_VAR, proveInheritedLease } from './lifecycle.js';
import type { Runner } from './runner.js';

type Stdio = StdioNull | StdioPipe;

/**
 * The only way Node code in a lease-accepting role starts a child (§9.3 lease-aware path, rule 2): it proves that the
 * inherited descriptor is the lifecycle lease and maps it to the child's fd 3, with `HOLDR_LIFECYCLE_LEASE_FD=3` and the
 * nonce. libuv spawns with POSIX_SPAWN_CLOEXEC_DEFAULT, so without this mapping the child would not hold the lease.
 * `leaseLint.test.ts` fails any other `node:child_process` use reachable from a lease-accepting role.
 */
export function spawnLeased(controlDir: string, file: string, args: readonly string[], options: {
  env?: NodeJS.ProcessEnv; cwd?: string; stdio?: readonly [Stdio, Stdio, Stdio];
} = {}): ChildProcess {
  const { fd, lease } = proveInheritedLease(process.env, controlDir);
  const [stdin, stdout, stderr] = options.stdio ?? ['ignore', 'inherit', 'inherit'];
  return spawn(file, [...args], {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), [LEASE_FD_VAR]: '3', [LEASE_VAR]: lease },
    stdio: [stdin, stdout, stderr, fd],
    shell: false,
  });
}

/** A bounded runner for read-only tools inside a lease (lsof, ioreg, diskutil, df, tmutil): every child gets the lease. */
export function leasedRunner(controlDir: string, timeoutMs = 10_000, maxBuffer = 1024 * 1024): Runner {
  return (file, args) => new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnLeased(controlDir, file, args, { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ exitCode: 'spawn-error', stdout: '' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: CommandResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ exitCode: 'timeout', stdout: '' }); }, timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBuffer) { child.kill('SIGKILL'); finish({ exitCode: 'overflow', stdout: '' }); return; }
      chunks.push(chunk);
    });
    child.once('error', (error: NodeJS.ErrnoException) => finish({ exitCode: error.code === 'ENOENT' ? 'missing' : 'spawn-error', stdout: '' }));
    child.once('close', (code) => finish({ exitCode: code ?? 'spawn-error', stdout: Buffer.concat(chunks).toString('utf8') }));
  });
}
