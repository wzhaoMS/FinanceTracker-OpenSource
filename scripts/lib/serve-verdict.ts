// The start script's, holdr-stop's and holdr-publish-legacy's Serve verdict (design §8.2–§8.4): see apps/api/src/control/serveVerdict.ts.
// No top-level await: tsx runs scripts/lib/*.ts as CommonJS (the repository root has no "type": "module").
import { describeError, exitCodeOf } from '../../apps/api/src/control/errors.js';
import { runServeVerdict } from '../../apps/api/src/control/serveVerdict.js';

runServeVerdict(process.argv.slice(2), process.env, process).then((code) => {
  process.exitCode = code;
}, (error: unknown) => {
  process.stderr.write(`serve-verdict: ${describeError(error)}\n`);
  process.exitCode = exitCodeOf(error);
});
