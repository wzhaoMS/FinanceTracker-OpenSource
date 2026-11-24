#!/usr/bin/env node
// Run one of the API's command-line tools (apps/api/src/cli/*Main.ts) with the settings `npm run start:local`
// uses: the repository's .env is read first (variables already set win), and HOLDR_DATA_DIR defaults to the
// per-user data folder (scripts/start-local.mjs), unless a hardened deployment's holdr.conf is in use, which
// then decides alone (no .env). A HOLDR_DATA_DIR that is relative, ends in a separator or uses / on Windows is passed
// on absolute and normal, and a data folder in the demo's folder is refused, as start:local refuses one. The root
// package.json's holdr-* scripts that open the data folder (holdr-user, holdr-backup and the importers) run through this
// file; the offline converters and the hardened deployment's tools do not:
//
//   node scripts/holdr-cli.mjs apps/api/src/cli/holdrUserMain.ts add alex
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PrivacyRefusal, REPO, defaultDataDir, demoFolderAround, demoFolderRefusal, displayPath, ensurePrivateDir, ensureSharedBuilt,
  hardenedConfig, loadDotEnv,
} from './start-local.mjs';

/**
 * The CLI's environment: `env` plus the .env file's settings and the default data folder, as start:local has them, with
 * HOLDR_DATA_DIR made absolute and normal (resolved against `cwd` as the API resolves it, without a trailing separator,
 * with the system's own separators), the form holdr-backup and the other tools require. A hardened deployment's commands
 * read holdr.conf instead, never .env (a key both set differently would stop them with E0I_CONFIG_FILE), and holdr.conf
 * decides the data folder.
 */
export function cliEnv(env, {
  dotEnvFile = path.join(REPO, '.env'), platform = process.platform, exists = fs.existsSync, cwd = process.cwd(),
} = {}) {
  const result = { ...env };
  if (!hardenedConfig(result, exists)) loadDotEnv(dotEnvFile, result);
  const hardened = hardenedConfig(result, exists);
  const defaulted = !hardened && !result.HOLDR_DATA_DIR?.trim();
  if (defaulted) result.HOLDR_DATA_DIR = defaultDataDir({ platform, env: result });
  else if (!hardened) result.HOLDR_DATA_DIR = (platform === 'win32' ? path.win32 : path.posix).resolve(cwd, result.HOLDR_DATA_DIR.trim());
  return { env: result, defaulted };
}

/**
 * Every data folder a tool may open: HOLDR_DATA_DIR, each --data-dir (holdr-user) and the folder of each --db file (the
 * importers), relative ones against `cwd`.
 */
export function dataFoldersIn(args, env, cwd = process.cwd()) {
  const folders = env.HOLDR_DATA_DIR?.trim() ? [path.resolve(cwd, env.HOLDR_DATA_DIR.trim())] : [];
  for (let index = 0; index < args.length; index += 1) {
    const [flag, inline] = args[index].startsWith('--') && args[index].includes('=')
      ? [args[index].slice(0, args[index].indexOf('=')), args[index].slice(args[index].indexOf('=') + 1)] : [args[index], undefined];
    if (flag !== '--data-dir' && flag !== '--db') continue;
    const value = inline ?? args[(index += 1)];
    if (!value) continue;
    folders.push(flag === '--db' ? path.dirname(path.resolve(cwd, value)) : path.resolve(cwd, value));
  }
  return [...new Set(folders)];
}

/**
 * The data folder `holdr-user add` is about to create its database in, as holdr-user resolves it (apps/api/src/cli/
 * holdrUser.ts: the last --data-dir, else HOLDR_DATA_DIR, either relative to `cwd`), or null when the command creates
 * nothing: another command, --help, or arguments holdr-user refuses (an unknown option, a missing or extra argument,
 * a --data-dir without a folder).
 */
export function userDataDirToCreate(args, env, cwd = process.cwd()) {
  let dataDir = '';
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--data-dir') {
      if (!args[index + 1]) return null;
      dataDir = args[index + 1];
      index += 1;
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length);
    } else if (arg.startsWith('-')) {
      if (!['--password-stdin', '--yes', '-y'].includes(arg)) return null;
    } else {
      positionals.push(arg);
    }
  }
  if (positionals[0] !== 'add' || positionals.length !== 2) return null;
  const chosen = dataDir || env.HOLDR_DATA_DIR?.trim();
  return chosen ? path.resolve(cwd, chosen) : null;
}

async function main(argv) {
  const [entry, ...args] = argv;
  if (!entry || !/^apps\/api\/src\/cli\/[A-Za-z]+Main\.ts$/.test(entry)) {
    console.error('usage: node scripts/holdr-cli.mjs apps/api/src/cli/<tool>Main.ts [arguments]');
    return 2;
  }
  const { env } = cliEnv(process.env);
  const hardened = hardenedConfig(env);
  // npm run demo deletes its folder whenever it makes the demo again, so no tool opens a data folder in it.
  for (const folder of dataFoldersIn(args, env)) {
    const demoFolder = demoFolderAround(folder);
    if (demoFolder) {
      console.error(demoFolderRefusal(folder, demoFolder));
      return 1;
    }
  }
  // The tools load @finance-tracker/shared from its build: make one if it is missing or stale (npm ci makes one too).
  // A hardened deployment's tree is built by its deploy kit and never changed here.
  try {
    if (!hardened) ensureSharedBuilt();
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  // `holdr-user add` creates the database on first use, so the folder it is about to use (--data-dir, HOLDR_DATA_DIR or
  // the default) is made ready first, as start:local makes its own: a missing one is created readable by this user only,
  // and an existing one is made so too, or refused when another account owns it (ensurePrivateDir). Every other tool
  // reads data that must already be there (a backup of a folder it just created would back up nothing), and a hardened
  // deployment's folders are its deploy kit's.
  const userDataDir = !hardened && entry.endsWith('/holdrUserMain.ts') ? userDataDirToCreate(args, env) : null;
  if (userDataDir) {
    try {
      ensurePrivateDir(userDataDir, { report: (line) => console.error(line) });
    } catch (error) {
      console.error(error instanceof PrivacyRefusal ? error.message
        : `could not make the data folder ${displayPath(userDataDir)} readable by your account only: ${error.message}`);
      return 1;
    }
  }
  const tsx = pathToFileURL(path.join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  const child = spawn(process.execPath, ['--import', tsx, path.join(REPO, ...entry.split('/')), ...args], { cwd: process.cwd(), env, stdio: 'inherit' });
  // Ctrl+C reaches the tool itself; this process waits for its exit status.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) process.on(signal, () => {});
  return new Promise((resolve) => {
    child.once('error', (error) => {
      console.error(`could not start ${entry}: ${error.message}`);
      resolve(1);
    });
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function invokedAsScript() {
  if (!process.argv[1]) return false;
  try {
    const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    return same(fs.realpathSync(process.argv[1]), fs.realpathSync(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (invokedAsScript()) process.exitCode = await main(process.argv.slice(2));
