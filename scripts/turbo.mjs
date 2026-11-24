#!/usr/bin/env node
// Run Turborepo with its anonymous usage telemetry and its update check turned off: Holdr sends nothing anywhere, and
// turbo would otherwise report usage to its vendor and ask the npm registry for new versions. The root package.json's
// build, dev, lint, test, typecheck and clean scripts run through this file:
//
//   node scripts/turbo.mjs run build
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const turbo = path.join(path.dirname(require.resolve('turbo/package.json')), 'bin', 'turbo');

const env = { ...process.env, TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', TURBO_NO_UPDATE_NOTIFIER: '1' };
const child = spawn(process.execPath, [turbo, ...process.argv.slice(2)], { env, stdio: 'inherit' });
// Ctrl+C reaches turbo itself, which stops its tasks; this process waits for its exit status.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) process.on(signal, () => {});
child.once('error', (error) => {
  console.error(`could not start turbo: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
