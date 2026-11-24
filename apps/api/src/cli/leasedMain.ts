import { runLeasedRole } from './leasedRoles.js';

// Started only by scripts/holdr-leased.sh: `exec node --import <tsx>/dist/loader.mjs leasedMain.ts <role> [args]`.
process.umask(0o077);
const [role, ...args] = process.argv.slice(2);
process.exitCode = await runLeasedRole(role, args, { env: process.env, io: process });
