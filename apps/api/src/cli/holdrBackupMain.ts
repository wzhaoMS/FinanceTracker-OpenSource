import { runHoldrBackup } from './holdrBackup.js';

// Backups hold the ledger: 0700 directories, 0600 files (K19).
process.umask(0o077);
process.exitCode = await runHoldrBackup(process.argv.slice(2), { env: process.env, io: process });
