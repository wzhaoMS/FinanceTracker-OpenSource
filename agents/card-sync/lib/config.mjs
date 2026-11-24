// Configuration for the card-sync receiver: command-line flags first, then environment variables, then safe defaults.
// Everything points at this computer: the Holdr API URL must be http://127.0.0.1:<port>, the receiver only ever listens on
// 127.0.0.1, and the private imports folder must live outside the repository checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(AGENT_DIR, '..', '..');
export const DEFAULT_PORT = 4401;
export const DEFAULT_APP_URL = 'http://127.0.0.1:4000';
export const DEFAULT_WEB_URL = 'http://127.0.0.1:5173';
export const DEFAULT_HISTORY = 12;
export const MAX_HISTORY = 60;
/** The extension ID pinned by the public key in extension/manifest.json (a test recomputes it from the manifest). */
export const PINNED_EXTENSION_ID = 'lhmdiolphfkhifphmgimglieniknblbm';
/** Holdr's fixed owner slots for card accounts; only their display labels are configurable. */
export const OWNER_KEYS = Object.freeze(['alex', 'casey', 'joint']);
export const DEFAULT_OWNER_LABELS = Object.freeze({ alex: 'Alex', casey: 'Casey', joint: 'Joint' });
export const COMMANDS = Object.freeze(['start', 'pair', 'check', 'outbox', 'help']);

/** Every setting: its flag, its environment variable, and what it means (printed by --help). */
export const SETTINGS = Object.freeze([
  { key: 'port', flag: '--port', env: 'HOLDR_SYNC_PORT', help: `receiver port on 127.0.0.1 (default ${DEFAULT_PORT})` },
  { key: 'appUrl', flag: '--app-url', env: 'HOLDR_APP_URL', help: `your local Holdr API, http://127.0.0.1:<port> only (default ${DEFAULT_APP_URL})` },
  { key: 'webUrl', flag: '--web-url', env: 'HOLDR_WEB_URL', help: `the Holdr web page that "Open Holdr" opens (default ${DEFAULT_WEB_URL}; Holdr's https:// address if it runs with --https-origin)` },
  { key: 'tokenFile', flag: '--token-file', env: 'HOLDR_TOKEN_FILE', help: 'the API service token (default <data dir>/service-token)' },
  { key: 'dataDir', flag: '--data-dir', env: 'HOLDR_DATA_DIR', help: "Holdr's data folder (default: start:local's folder once it holds Holdr's service token, else apps/api/data)" },
  { key: 'imports', flag: '--imports', env: 'HOLDR_IMPORTS', help: 'private imports folder (default ~/Holdr/imports)' },
  { key: 'extensionDir', flag: '--extension-dir', env: 'HOLDR_EXTENSION_DIR', help: 'the unpacked extension folder (default agents/card-sync/extension)' },
  { key: 'extensionId', flag: '--extension-id', env: 'HOLDR_EXTENSION_ID', help: `the extension's ID (default ${PINNED_EXTENSION_ID}, pinned by its manifest)` },
  { key: 'history', flag: '--history', env: 'HOLDR_SYNC_HISTORY', help: `closed statements to look back over (default ${DEFAULT_HISTORY}, at most ${MAX_HISTORY})` },
  { key: 'ownerLabels', flag: '--owner-labels', env: 'HOLDR_OWNER_LABELS', help: 'display names for the owner slots, e.g. alex=Alex,casey=Casey,joint=Joint' },
  { key: 'logFile', flag: '--log-file', env: 'HOLDR_SYNC_LOG', help: 'also append the log to this file' },
]);
const SWITCHES = Object.freeze({ '--rotate': 'rotate', '--clean': 'clean', '--help': 'help', '-h': 'help' });

export const USAGE = `Holdr card sync receiver (experimental)

Usage: node agents/card-sync/receiver.mjs [command] [options]
       npm run agent -- [command] [options]

Commands:
  start           run the receiver on 127.0.0.1 (the default command)
  pair            create the pairing key the extension reads; --rotate replaces it
  check           check the configuration, the imports folder, the pairing and your local Holdr
  outbox          list the converted files waiting for import; --clean deletes those Holdr already holds
  help            show this text

Options (each also reads the environment variable shown):
${SETTINGS.map((setting) => `  ${`${setting.flag} VALUE`.padEnd(24)}${setting.env.padEnd(22)}${setting.help}`).join('\n')}
`;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const printable = (value) => (/^--?[a-z][a-z0-9-]{0,30}$/.test(value) ? value : '(unrecognized)');

/** Splits argv into one command, flag values and switches. Values never appear in errors. */
export function parseArgs(argv) {
  const values = {};
  const switches = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (Object.hasOwn(SWITCHES, arg)) {
      switches[SWITCHES[arg]] = true;
      continue;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const setting = SETTINGS.find((candidate) => candidate.flag === name);
    if (setting) {
      let value;
      if (eq === -1) {
        value = argv[index + 1];
        index += 1;
      } else {
        value = arg.slice(eq + 1);
      }
      if (value === undefined || value === '') throw new ConfigError(`${name} needs a value`);
      if (Object.hasOwn(values, setting.key)) throw new ConfigError(`${name} was given twice`);
      values[setting.key] = value;
      continue;
    }
    if (arg.startsWith('-')) throw new ConfigError(`unknown option ${printable(name)}`);
    positional.push(arg);
  }
  if (positional.length > 1) throw new ConfigError('give at most one command');
  const command = positional[0] ?? 'start';
  if (!COMMANDS.includes(command)) throw new ConfigError(`unknown command ${/^[a-z-]{1,20}$/.test(command) ? command : '(unrecognized)'}; try help`);
  return { command: switches.help ? 'help' : command, values, switches };
}

/**
 * The API origin: plain HTTP on 127.0.0.1, the address Holdr listens on, since the service token must never leave this
 * computer. Not localhost or [::1]: a name can resolve to ::1 first, where Holdr does not listen but another program could.
 */
export function loopbackApiOrigin(value, label = 'HOLDR_APP_URL') {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${label} is not a URL`);
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new ConfigError(`${label} must be http://127.0.0.1:<port>, where Holdr listens (not localhost or [::1]): the agent only talks to the Holdr on this computer`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ConfigError(`${label} must be just the origin, such as ${DEFAULT_APP_URL}`);
  }
  return url.origin;
}

/** The web page "Open Holdr" opens: a loopback HTTP address, or any HTTPS address, without credentials. */
export function webOrigin(value, label = 'HOLDR_WEB_URL') {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${label} is not a URL`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new ConfigError(`${label} must be an http:// address on this computer or an https:// address`);
  }
  if (url.username || url.password || url.search || url.hash) throw new ConfigError(`${label} must not carry credentials, a query or a fragment`);
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/**
 * The data folder `npm run start:local` uses when none is given (scripts/start-local.mjs, defaultDataDir): Holdr's API
 * keeps its service token there.
 */
export function startLocalDataDir({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : path.win32.join(env.USERPROFILE || homedir, 'AppData', 'Local');
    return path.win32.join(base, 'Holdr', 'data');
  }
  if (platform === 'darwin') return path.posix.join(homedir, 'Library', 'Application Support', 'Holdr', 'data');
  const xdg = env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.posix.join(homedir, '.local', 'share');
  return path.posix.join(xdg, 'holdr', 'data');
}

/**
 * `target` as the disk resolves it, as far as its folders exist: the real path of its nearest existing folder (links,
 * junctions and the letter case on disk resolved by `realpath`), followed by the rest of it unchanged.
 */
export function realPathSoFar(target, { P = path, realpath = fs.realpathSync.native } = {}) {
  const rest = [];
  let current = target;
  for (;;) {
    try {
      return P.join(realpath(current), ...rest);
    } catch {
      const parent = P.dirname(current);
      if (parent === current) return target;
      rest.unshift(P.basename(current));
      current = parent;
    }
  }
}

/**
 * Whether `child` is `parent` or inside it. Letter case is ignored on Windows and macOS, whose disks ignore it (so `~/holdr`
 * is the folder `~/Holdr`), and on the computer running this (`realpath` given) links are resolved as far as folders exist.
 */
export function pathInside(child, parent, {
  platform = process.platform, realpath = platform === process.platform ? fs.realpathSync.native : null,
} = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const canonical = (value) => {
    const real = realpath ? realPathSoFar(value, { P, realpath }) : value;
    return platform === 'win32' || platform === 'darwin' ? real.normalize('NFC').toLowerCase() : real;
  };
  const relative = P.relative(canonical(parent), canonical(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${P.sep}`) && !P.isAbsolute(relative));
}

export function parseOwnerLabels(value) {
  const labels = { ...DEFAULT_OWNER_LABELS };
  if (value === undefined) return Object.freeze(labels);
  const seen = new Set();
  for (const part of value.split(',')) {
    const match = /^\s*([a-z]+)\s*=\s*(.+?)\s*$/.exec(part);
    if (!match || !OWNER_KEYS.includes(match[1])) throw new ConfigError('HOLDR_OWNER_LABELS must look like alex=Alex,casey=Casey,joint=Joint');
    if (seen.has(match[1])) throw new ConfigError('HOLDR_OWNER_LABELS names an owner slot twice');
    if (!/^[\p{L}\p{N} .'&()+-]{1,40}$/u.test(match[2])) throw new ConfigError('an owner label must be 1 to 40 letters, digits, spaces or simple punctuation');
    seen.add(match[1]);
    labels[match[1]] = match[2];
  }
  return Object.freeze(labels);
}

/**
 * The receiver's configuration. `platform`, `homedir`, `cwd`, the two roots, `exists` and `realpath` are parameters so that
 * tests can resolve a Windows configuration on macOS and the other way round, without touching the file system. Folders
 * are compared as the disk compares them (pathInside): with `realpath` (by default on the computer running this) links
 * are resolved too.
 */
export function resolveConfig({
  argv = [], env = process.env, platform = process.platform, homedir = os.homedir(), cwd = process.cwd(),
  repoRoot = REPO_ROOT, agentDir = AGENT_DIR, exists = fs.existsSync,
  realpath = platform === process.platform ? fs.realpathSync.native : null,
} = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const inside = (child, parent) => pathInside(child, parent, { platform, realpath });
  const { command, values, switches } = parseArgs(argv);
  const pick = (key) => {
    const setting = SETTINGS.find((candidate) => candidate.key === key);
    if (values[key] !== undefined) return { value: values[key], source: setting.flag };
    const fromEnv = env[setting.env];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { value: fromEnv.trim(), source: setting.env };
    return null;
  };
  const toPath = (raw, label) => {
    if (/[\0\r\n]/.test(raw)) throw new ConfigError(`${label} contains a control character`);
    let value = raw;
    if (value === '~') value = homedir;
    else if (value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'))) value = P.join(homedir, value.slice(2));
    return P.resolve(cwd, value);
  };

  const port = (() => {
    const picked = pick('port');
    if (!picked) return DEFAULT_PORT;
    const number = /^\d{1,5}$/.test(picked.value) ? Number(picked.value) : NaN;
    if (!(number >= 1024 && number <= 65535)) throw new ConfigError(`${picked.source} must be a port number from 1024 to 65535`);
    return number;
  })();
  const appUrlPicked = pick('appUrl');
  const appUrl = appUrlPicked ? loopbackApiOrigin(appUrlPicked.value, appUrlPicked.source) : DEFAULT_APP_URL;
  const webUrlPicked = pick('webUrl');
  const webUrl = webUrlPicked ? webOrigin(webUrlPicked.value, webUrlPicked.source) : DEFAULT_WEB_URL;

  const importsPicked = pick('imports');
  const importsDir = importsPicked ? toPath(importsPicked.value, importsPicked.source) : P.join(homedir, 'Holdr', 'imports');
  const importsLabel = importsPicked?.source ?? 'the imports folder';
  if (P.parse(importsDir).root === importsDir || inside(homedir, importsDir) || inside(repoRoot, importsDir)) {
    throw new ConfigError(`${importsLabel} must be a folder of its own, such as ~/Holdr/imports: it becomes private to your account`);
  }
  if (inside(importsDir, repoRoot)) {
    throw new ConfigError(importsPicked
      ? `${importsLabel} must be outside the repository checkout: it holds bank exports, which must never be committed`
      : 'the default imports folder, ~/Holdr/imports, is inside this repository checkout (Windows and macOS do not tell holdr '
        + 'from Holdr), and bank exports must never be in a checkout: clone Holdr into a folder of its own, such as ~/src/holdr '
        + '(docs/getting-started.md, step 2), or choose another imports folder with --imports');
  }

  const dataPicked = pick('dataDir');
  const tokenPicked = pick('tokenFile');
  const apiTokenSetting = typeof env.HOLDR_SERVICE_TOKEN_FILE === 'string' && env.HOLDR_SERVICE_TOKEN_FILE.trim() !== ''
    ? env.HOLDR_SERVICE_TOKEN_FILE.trim() : null;
  let dataDir;
  let dataSource;
  if (dataPicked) {
    dataDir = toPath(dataPicked.value, dataPicked.source);
    dataSource = dataPicked.source;
  } else {
    // Unset: the folder `npm run start:local` uses, or else the one `npm run dev` uses, whichever holds a token.
    const candidates = [
      { dir: startLocalDataDir({ platform, env, homedir }), source: 'the npm run start:local data folder' },
      { dir: P.join(repoRoot, 'apps', 'api', 'data'), source: 'the npm run dev data folder' },
    ];
    const chosen = candidates.find((candidate) => exists(P.join(candidate.dir, 'service-token'))) ?? candidates[0];
    dataDir = chosen.dir;
    dataSource = chosen.source;
  }
  let tokenFile;
  let tokenSource;
  if (tokenPicked) {
    tokenFile = toPath(tokenPicked.value, tokenPicked.source);
    tokenSource = tokenPicked.source;
  } else if (apiTokenSetting) {
    tokenFile = toPath(apiTokenSetting, 'HOLDR_SERVICE_TOKEN_FILE');
    tokenSource = 'HOLDR_SERVICE_TOKEN_FILE';
  } else {
    tokenFile = P.join(dataDir, 'service-token');
    tokenSource = dataSource;
  }

  const extensionPicked = pick('extensionDir');
  const extensionDir = extensionPicked ? toPath(extensionPicked.value, extensionPicked.source) : P.join(agentDir, 'extension');
  const idPicked = pick('extensionId');
  if (idPicked && !/^[a-p]{32}$/.test(idPicked.value)) {
    throw new ConfigError(`${idPicked.source} must be the 32-letter ID that chrome://extensions shows for this extension`);
  }
  const extensionId = idPicked ? idPicked.value : PINNED_EXTENSION_ID;

  const history = (() => {
    const picked = pick('history');
    if (!picked) return DEFAULT_HISTORY;
    const number = /^\d{1,3}$/.test(picked.value) ? Number(picked.value) : NaN;
    if (!(number >= 1 && number <= MAX_HISTORY)) throw new ConfigError(`${picked.source} must be a number of statements from 1 to ${MAX_HISTORY}`);
    return number;
  })();
  const ownerLabels = parseOwnerLabels(pick('ownerLabels')?.value);
  const logPicked = pick('logFile');
  const logFile = logPicked ? toPath(logPicked.value, logPicked.source) : null;
  if (logFile && inside(logFile, repoRoot)) throw new ConfigError(`${logPicked.source} must be outside the repository checkout`);

  return Object.freeze({
    command,
    rotate: Boolean(switches.rotate),
    clean: Boolean(switches.clean),
    platform,
    port,
    appUrl,
    webUrl,
    dataDir,
    tokenFile,
    tokenSource,
    importsDir,
    rawDir: P.join(importsDir, 'raw'),
    outboxDir: P.join(importsDir, 'outbox'),
    statePath: P.join(importsDir, 'receiver-state.json'),
    extensionDir,
    pairingFile: P.join(extensionDir, 'local-key.json'),
    extensionId,
    extensionIdSource: idPicked?.source ?? 'manifest',
    history,
    ownerLabels,
    logFile,
  });
}
