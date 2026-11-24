import path from 'node:path';
import { parseArgs } from 'node:util';
import { verifyRelease } from '@finance-tracker/shared/web-release/files';
import { WebReleaseError } from '@finance-tracker/shared/web-release';
import { runAttestCommand } from './attestCommand.js';
import { loadConfiguration } from '../control/holdrConf.js';
import { runPreflightCommand } from './preflightCommand.js';
import { runServeProbe } from './serveProbeCommand.js';
import { runSetMode } from './setModeCommand.js';

try {
  // Lease acceptance needs B's inherited-descriptor proof, not a trusted environment string.
  if (process.env.HOLDR_LIFECYCLE_LEASE_FD !== undefined || process.env.HOLDR_LIFECYCLE_LEASE !== undefined) {
    throw new WebReleaseError('E0I_LEASE_ENV');
  }
  if (process.argv[2] === 'attest') {
    // holdr.conf applies to every command (PR B, design §7.1); a configuration refusal is "unverified" (3) here.
    let env: NodeJS.ProcessEnv | undefined;
    try { env = loadConfiguration(process.env).env; } catch (error) { console.error(error instanceof WebReleaseError ? error.code : 'E0I_CONFIG_FILE'); process.exitCode = 3; }
    if (env) process.exitCode = await runAttestCommand(process.argv.slice(3), env);
  } else if (process.argv[2] === 'preflight') process.exitCode = await runPreflightCommand(process.argv.slice(3), process.env);
  else if (process.argv[2] === 'set-mode') process.exitCode = runSetMode(process.argv.slice(3), process.env, process);
  else if (process.argv[2] === 'serve-probe') process.exitCode = await runServeProbe(process.argv.slice(3), process);
  else {
  const { values, positionals } = parseArgs({
    options: { digest: { type: 'string' } }, allowPositionals: true, strict: true,
  });
  if (positionals[0] !== 'verify-release') throw new WebReleaseError('E0I_RUNTIME_UNAVAILABLE');
  if (positionals.length !== 2 || !values.digest) throw new WebReleaseError('E0I_RELEASE_CONFIG');
  const release = verifyRelease(path.resolve(positionals[1]), values.digest);
  console.log(`VERIFIED digest=${release.digest} files=${release.manifest.files.length} bytes=${release.manifest.files.reduce((sum, file) => sum + file.size, 0)}`);
  }
} catch (error) {
  console.error(error instanceof WebReleaseError ? error.code : 'E0I_RELEASE_CONFIG');
  process.exitCode = 1;
}
