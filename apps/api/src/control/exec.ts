import { runBoundedCommand } from '../ingress/boundedCommand.js';
import type { Runner } from './runner.js';

/** Bounded runner for local system tools: fixed PATH, 10 s, 1 MiB. Not for use inside a lease (see leasedSpawn.ts). */
export const systemRunner: Runner = (file, args) => runBoundedCommand(file, args, {
  timeoutMs: 10_000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
});
