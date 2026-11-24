import { systemRunner } from '../control/exec.js';
import { runHoldrLifecycle } from './holdrLifecycle.js';

process.umask(0o077);
process.exitCode = await runHoldrLifecycle(process.argv.slice(2), {
  env: process.env, io: process, run: systemRunner,
  // The work keeps the lease if the wrapper is killed; a signal the wrapper receives is passed on to the work.
  onSignal: (forward) => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => forward(signal));
  },
});
