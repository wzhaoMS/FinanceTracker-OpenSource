import { createRunDirectories, removeRunDirectory } from './runDir.js';

/**
 * Run-directory helper for scripts/e2e-disposable.mjs:
 *
 *   tsx src/e2e/runDirCli.ts create <work-dir> [label]        prints KEY=value lines
 *   tsx src/e2e/runDirCli.ts remove <dir> <identity-chain>    deletes only a verified dir
 *
 * The identity chains (RUN_DIR_ID, DATA_DIR_ID) list the `<device>:<inode>`
 * of every directory from the work directory down, as recorded at creation.
 */

const USAGE = 'usage: tsx src/e2e/runDirCli.ts create <work-dir> [label] | remove <dir> <identity-chain>';

function main(): number {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'create' && (args.length === 1 || args.length === 2)) {
      const dirs = createRunDirectories(args[0], { label: args[1] });
      console.log(`RUN_DIR=${dirs.runDir}`);
      console.log(`DATA_DIR=${dirs.dataDir}`);
      console.log(`LOG_DIR=${dirs.logDir}`);
      console.log(`RUN_DIR_ID=${dirs.runDirId}`);
      console.log(`DATA_DIR_ID=${dirs.dataDirId}`);
      return 0;
    }
    if (command === 'remove' && args.length === 2) {
      console.log(removeRunDirectory(args[0], args[1]));
      return 0;
    }
  } catch (error) {
    console.error(`[e2e-run-dir] ${(error as Error).message}`);
    return 1;
  }
  console.error(USAGE);
  return 2;
}

process.exitCode = main();
