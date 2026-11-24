import { runFidelityInvestingCli } from './runner.mjs';
import { exitCodeOf } from '../../apps/api/src/control/errors.js';

process.umask(0o077);
runFidelityInvestingCli(process.argv.slice(2)).then(code => {
  process.exitCode = code;
}).catch((error: unknown) => {
  // Foreign errors can contain paths, raw JSON or SQLite values.
  console.error('Fidelity investing import failed. Check lifecycle state, private input, policy, database and backup access. Required: --apply [--stdin | --capture FILE] --db FILE --policy FILE --backup-directory DIR --control-root DIR');
  process.exitCode = exitCodeOf(error);
});
