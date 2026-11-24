import { parseArgs } from 'node:util';

import { assertDemoDataDir, resetDemoPassword, seedDemoDataDir } from './demoSeed.js';

/**
 * The demo's database helper, run by scripts/start-local.mjs --demo:
 *
 *   tsx src/demo/demoSeedCli.ts seed --data-dir <new or empty dir> [--now <ISO instant>]   (password on standard input)
 *   tsx src/demo/demoSeedCli.ts password --data-dir <demo data dir>                        (password on standard input)
 *   tsx src/demo/demoSeedCli.ts check --data-dir <demo data dir>
 *
 * `seed` writes the synthetic demo household as of `--now` (default: this moment; its New York date is the demo's
 * today) and the `demo` user; `password` gives that user a new password, in a demo folder only; `check` exits 0 only when
 * the folder is a demo folder that holds nothing but the demo's (read-only), which the launcher asks before it deletes
 * one to make it again. Paths are never printed on success: the launcher shows the folder in its own short form.
 */

const USAGE = 'usage: tsx src/demo/demoSeedCli.ts <seed|password|check> --data-dir <dir> [--now <ISO instant>]  '
  + '(seed and password read the password from standard input)';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main(): Promise<number> {
  let parsed: { values: { 'data-dir'?: string; now?: string; help?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { 'data-dir': { type: 'string' }, now: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (error) {
    console.error(`[demo] ${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const [command] = positionals;
  const dataDir = values['data-dir'];
  const now = values.now === undefined ? new Date() : new Date(values.now);
  if (!dataDir || (command !== 'seed' && command !== 'password' && command !== 'check') || positionals.length !== 1
    || Number.isNaN(now.getTime()) || (values.now !== undefined && command !== 'seed')) {
    console.error(`[demo] ${USAGE}`);
    return 2;
  }
  process.umask(0o077);
  try {
    if (command === 'check') {
      assertDemoDataDir(dataDir);
      return 0;
    }
    const password = await readStdin();
    if (command === 'password') {
      await resetDemoPassword(dataDir, password);
      console.log('[demo] demo password updated');
      return 0;
    }
    const summary = await seedDemoDataDir(dataDir, { password, now });
    console.log(`[demo] seeded the demo household for ${summary.today}: ${summary.accounts} investment accounts with ${summary.trades} trades `
      + `and ${summary.cashEvents} dividends, interest payments and contributions; ${summary.cards} cards with ${summary.cardRows} card `
      + `transactions, ${summary.statements} statement and balance reads and ${summary.benefitMarks} benefit marks; `
      + `${summary.checkingRows} checking transactions; ${summary.metalOrders} bullion purchases and ${summary.metalSales} sales`);
    return 0;
  } catch (error) {
    console.error(`[demo] ${(error as Error).message}`);
    return 1;
  }
}

process.exitCode = await main();
