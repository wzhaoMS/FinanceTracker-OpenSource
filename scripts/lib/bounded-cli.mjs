// Bounded external commands for the operator scripts (deviation B-D33; B2 review finding 4). Every Tailscale CLI call that the
// start script, the legacy publisher, the rollback kit and deploy-apply make from bash goes through this runner, so that no
// hanging CLI can hold the start lock or a maintenance lease indefinitely:
//
//   node scripts/lib/bounded-cli.mjs <seconds 1-300> <absolute file> [args...]
//
// The command runs in its own process group with stdin closed; its stdout and stderr are passed through. Exit status: the
// command's own, 128 + n when signal n ended it, 124 when the deadline passed (the whole group is killed first), 127 when the
// file could not be started, 64 for a usage error. Once the command has exited, whatever it left in its group is killed too, so
// a lingering child can neither hold the caller's pipe nor outlive the call. A timer independent of every child event ends this
// process at the deadline, and SIGINT, SIGTERM or SIGHUP kill the group before this process exits. Plain Node, no dependency:
// it runs inside a maintenance lease (with fd 3 closed by the caller) without npm, npx or a tsx launcher.
import { spawn } from 'node:child_process';
import os from 'node:os';

const [secondsText = '', file = '', ...args] = process.argv.slice(2);
if (!/^[1-9][0-9]{0,2}$/.test(secondsText) || Number(secondsText) > 300 || !file.startsWith('/')) {
  process.stderr.write('Usage: bounded-cli.mjs <seconds 1-300> <absolute file> [args...]\n');
  process.exit(64);
}
const what = [file, ...args.slice(0, 2)].join(' ');

let child;
try {
  child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
} catch {
  process.stderr.write(`bounded-cli: could not start ${file}\n`);
  process.exit(127);
}
const killGroup = () => {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is gone */ }
};
let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  killGroup();
  process.exitCode = code;
  // Let the passed-through output drain, but never wait on it for long.
  setTimeout(() => process.exit(code), 2_000).unref();
};
const deadline = setTimeout(() => {
  killGroup();
  process.stderr.write(`bounded-cli: ${what} did not finish within ${secondsText}s; stopped\n`);
  process.exit(124);
}, Number(secondsText) * 1000);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    killGroup();
    process.exit(128 + os.constants.signals[signal]);
  });
}
// A reader that stops early (`| head -n 1`) must not turn a finished command into a failure here.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once('error', () => {
  process.stderr.write(`bounded-cli: could not start ${file}\n`);
  finish(127);
});
// After the command exits, its group is killed so that a lingering child cannot keep the pipes (and 'close') open.
child.once('exit', () => killGroup());
child.once('close', (code, signal) => finish(code ?? 128 + (os.constants.signals[signal] ?? 0)));
