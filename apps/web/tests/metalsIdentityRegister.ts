import { EventEmitter } from 'node:events';

import { runMetalsCli } from '../../api/src/cli/metals.js';

/**
 * Test-only, for the Gold e2e stack (tests/metalsStack.ts). It registers one synthetic Costco folder in a new owner-only
 * folder registry through holdr-metals' own `identity-register` (#324; corrections design r6, section 2.8).
 *
 * The command runs in-process on a stand-in terminal. That is the CLI's own test seam (`terminal`, which
 * cli/metals.test.ts drives the same way), and it types the synthetic payload's last 4 twice.
 *
 * The command, its owner-only checks and its owner-only write are the production ones, unchanged. An e2e has no terminal,
 * and production keeps its terminal-only rule: no flag, environment variable or other input path is added to it. This
 * file is never shipped, and it refuses to run outside a disposable e2e run.
 *
 * Usage, from apps/api (as tests/metalsStack.ts runs holdr-metals):
 *   node --import tsx <this file> identity-register --registry NEW [--from FILE] --source costco --folder FOLDER LAST4
 * LAST4 is the synthetic payload's own four digits, typed on the stand-in terminal and never passed to the command.
 */

const argv = process.argv.slice(2);
const last4 = argv.at(-1) ?? '';
const args = argv.slice(0, -1);
if (!process.env.HOLDR_E2E_RUN_ID) throw new Error('metalsIdentityRegister runs only inside a disposable e2e run (HOLDR_E2E_RUN_ID)');
if (args[0] !== 'identity-register' || !/^[0-9]{4}$/.test(last4)) {
  throw new Error('usage: metalsIdentityRegister.ts identity-register --registry NEW [--from FILE] --source costco --folder FOLDER LAST4');
}

/** A TTY stand-in for the CLI's no-echo reader: each time the reader resumes it, it types the next answer and Enter. */
function typing(...answers: string[]): NodeJS.ReadStream {
  const tty = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => tty,
    resume() {
      const next = answers.shift();
      if (next !== undefined) setImmediate(() => tty.emit('data', Buffer.from(`${next}\r`, 'latin1')));
      return tty;
    },
    pause: () => tty,
  });
  return tty as unknown as NodeJS.ReadStream;
}

process.exitCode = await runMetalsCli(args, {
  env: process.env,
  io: { stdout: process.stdout, stderr: process.stderr },
  terminal: typing(last4, last4),
});
