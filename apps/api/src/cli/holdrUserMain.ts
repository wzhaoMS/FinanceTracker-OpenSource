import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHoldrUserCli } from './holdrUser.js';

// A fresh install's database (and its WAL files) must not be readable by other accounts.
process.umask(0o077);

// Same default as the API (src/index.ts): apps/api/data next to the sources.
const defaultDataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

process.exitCode = await runHoldrUserCli(process.argv.slice(2), {
  io: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  env: process.env,
  defaultDataDir,
});
