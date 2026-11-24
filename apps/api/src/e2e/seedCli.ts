import { parseArgs } from 'node:util';

import { seedDisposableDataDir } from './syntheticSeed.js';

/**
 * Seed a disposable data directory with the synthetic e2e household:
 *
 *   tsx src/e2e/seedCli.ts --data-dir <dir>
 *
 * Then start the API with HOLDR_DATA_DIR=<dir>. Refuses directories that may
 * hold real data (see prepareDisposableDataDir); scripts/e2e-disposable.mjs
 * runs this for you.
 */

const USAGE = 'usage: tsx src/e2e/seedCli.ts --data-dir <new or disposable directory>';

function main(): number {
  let values: { 'data-dir'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        'data-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    console.error(`[e2e-seed] ${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  // Deliberately no default: the API's own default directory is the live database.
  const dataDir = values['data-dir'] ?? process.env.HOLDR_DATA_DIR;
  if (!dataDir) {
    console.error(`[e2e-seed] no target directory\n${USAGE}`);
    return 2;
  }
  try {
    const result = seedDisposableDataDir(dataDir);
    console.log(`[e2e-seed] seeded ${result.dbFile}`);
    console.log(
      `[e2e-seed] ${result.accounts} accounts, ${result.transactions} transactions `
      + `(${result.firstTradeDate} → ${result.lastTradeDate}), ${result.dailyBars} daily bars, `
      + `${result.snapshots} snapshots (latest ${result.latestSnapshot ?? 'none'}), ${result.intradayBars} intraday bars, `
      + `${result.metalCloses} metal closes`,
    );
    console.log(`[e2e-seed] held: ${result.heldSymbols.join(', ')}`);
    console.log(`SEEDED accounts=${result.accounts} transactions=${result.transactions}`);
    return 0;
  } catch (error) {
    console.error(`[e2e-seed] ${(error as Error).message}`);
    return 1;
  }
}

process.exitCode = main();
