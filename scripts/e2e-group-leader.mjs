// Holds a POSIX process group for one process of the disposable e2e stack.
// Started only by scripts/e2e-disposable.mjs (startGroup), never by hand:
//
//   node scripts/e2e-group-leader.mjs <program> [arguments...]
//
// The runner starts it in a new session and process group, with an IPC
// channel, and keeps it as its child. It starts <program> as its own child,
// in the same group, with this process's working directory, environment and
// stdio, and reports { type: 'started', pid }, then { type: 'exit', code,
// signal, killed } once it has reaped <program> (or { type: 'error',
// message } if <program> could not start).
//
// It ignores SIGTERM, SIGINT and SIGHUP and does not exit on its own. While
// the runner has not reaped it, it is a member of the group, so the group's
// ID cannot be reused and the runner can signal everything left in the group.
//
// <program> can leave the group (setsid()), out of reach of any group signal,
// so the leader also ends it through its own child handle, by PID, which is
// safe while <program> has not been reaped. On { type: 'stop', graceMs } from
// the runner it sends <program> SIGTERM, then SIGKILL after graceMs, and
// reports its exit once it has reaped it. The runner ends the group, and this
// process, only after that report.
//
// If the runner goes away (the IPC channel closes, or a report cannot be
// sent) the leader shuts down: it ends <program> the same way, then the rest
// of its group, itself included. It never starts <program> once the channel
// is closed.
import { spawn } from 'node:child_process';

/** How long <program> gets after SIGTERM when the runner is gone. */
const SHUTDOWN_GRACE_MS = 5_000;

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});

const [program, ...args] = process.argv.slice(2);
if (typeof process.send !== 'function' || !program) {
  console.error('[e2e-group-leader] only scripts/e2e-disposable.mjs starts this');
  process.exit(2);
}

let child = null;
let killed = false;
let ending = null;
let shuttingDown = false;

const running = () => child !== null && child.pid !== undefined && child.exitCode === null && child.signalCode === null;

/**
 * End <program> through its child handle: SIGTERM, then SIGKILL after
 * `graceMs` if it still runs. Resolves once it has been reaped. Runs once.
 */
function endProgram(graceMs) {
  ending ??= new Promise((resolve) => {
    if (!running()) {
      resolve();
      return;
    }
    let timer;
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
    timer = setTimeout(() => {
      if (!running()) return;
      killed = true;
      child.kill('SIGKILL');
    }, graceMs);
  });
  return ending;
}

/** The runner is gone, or cannot be told anything: end <program>, then the group with this process. Runs once. */
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const group = -process.pid; // this process leads the group, and is still in it
  try {
    process.kill(group, 'SIGTERM');
  } catch {
    // Nothing else is left in the group.
  }
  endProgram(SHUTDOWN_GRACE_MS).then(() => {
    try {
      process.kill(group, 'SIGKILL');
    } finally {
      process.exit(1);
    }
  });
}

/** Report to the runner; a report that cannot be delivered means the runner is gone. */
function report(message) {
  if (shuttingDown) return;
  try {
    process.send(message, (error) => {
      if (error) shutdown();
    });
  } catch {
    shutdown();
  }
}

// Every way the channel can fail is handled before anything is started.
process.on('disconnect', shutdown);
process.on('error', shutdown);
process.on('message', (message) => {
  if (message?.type === 'stop') endProgram(Number.isFinite(message.graceMs) ? message.graceMs : SHUTDOWN_GRACE_MS);
});
if (!process.connected) process.exit(1);

child = spawn(program, args, { stdio: 'inherit' });
child.once('spawn', () => report({ type: 'started', pid: child.pid }));
child.once('error', (error) => report({ type: 'error', message: error.message }));
child.once('exit', (code, signal) => report({ type: 'exit', code, signal, killed }));
