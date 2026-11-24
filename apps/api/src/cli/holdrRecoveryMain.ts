import { systemRunner } from '../control/exec.js';
import { runHoldrRecovery } from './holdrRecovery.js';

// Control files and anything init creates must not be readable by other accounts.
process.umask(0o077);
process.exitCode = await runHoldrRecovery(process.argv.slice(2), { env: process.env, io: process, run: systemRunner });
