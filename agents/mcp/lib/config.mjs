// Configuration for the Holdr MCP server: command-line flags first, then environment variables, then safe defaults.
// Everything points at this computer. The Holdr API must be http://127.0.0.1 (the rule agents/card-sync uses), and the
// read-only agent token is looked for in Holdr's data folder, found the way the card sync agent finds it. The server
// never uses the service token, which can change data (holdr-api.mjs refuses it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = 'holdr';
export const SERVER_VERSION = '0.1.0';
export const MCP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(MCP_DIR, '..', '..');
export const DEFAULT_APP_URL = 'http://127.0.0.1:4000';
export const DEMO_APP_URL = 'http://127.0.0.1:4001';
/** The read-only agent token Holdr writes into its data folder at startup (apps/api/src/auth/agentToken.ts). */
export const TOKEN_FILE_NAME = 'agent-token';
/** The service token next to it, which this server never reads; its presence still marks a Holdr data folder. */
export const SERVICE_TOKEN_FILE_NAME = 'service-token';
/** The file `npm run demo` writes into its folder (scripts/start-local.mjs, DEMO_MARKER). */
export const DEMO_MARKER = '.holdr-demo';

/** Every valued setting: its flag, its environment variable, and what it means (printed by --help). */
export const SETTINGS = Object.freeze([
  {
    key: 'appUrl', flag: '--app-url', env: 'HOLDR_APP_URL',
    help: `your Holdr API, on this computer only (default ${DEFAULT_APP_URL}; ${DEMO_APP_URL} with --demo)`,
  },
  {
    key: 'dataDir', flag: '--data-dir', env: 'HOLDR_DATA_DIR',
    help: "Holdr's data folder, which holds its agent-token file (default: npm run start:local's folder, else apps/api/data)",
  },
  {
    key: 'tokenFile', flag: '--token-file', env: 'HOLDR_AGENT_TOKEN_FILE',
    help: "Holdr's read-only agent token file itself (default <data folder>/agent-token)",
  },
]);
const SWITCHES = Object.freeze({ '--demo': 'demo', '--check': 'check', '--version': 'version', '--help': 'help', '-h': 'help' });

export const USAGE = `Holdr MCP server (read-only): lets AI agents read your Holdr data over the Model Context Protocol.

Usage: node agents/mcp/server.mjs [options]

An MCP client (GitHub Copilot CLI, VS Code, Claude Desktop, Cursor, ...) starts this command and talks to it over
standard input and output; docs/agents.md shows how to add it to each. Holdr must be running on this computer
(npm run start:local, or npm run demo). The server reads with Holdr's read-only agent token (the agent-token file Holdr
creates in its data folder when it starts), so every tool only reads: Holdr refuses that token any change.

Options (each also reads the environment variable shown, except with --demo):
${SETTINGS.map((setting) => `  ${`${setting.flag} VALUE`.padEnd(20)}${setting.env.padEnd(18)}${setting.help}`).join('\n')}
  ${'--demo'.padEnd(38)}the demo (npm run demo): ${DEMO_APP_URL} and the demo's data folder
  ${'--check'.padEnd(38)}check the setup and that Holdr answers, print what was found, and exit
  ${'--version'.padEnd(38)}print the version and exit
  ${'-h, --help'.padEnd(38)}show this text
`;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const printable = (value) => (/^--?[a-z][a-z0-9-]{0,30}$/.test(value) ? value : '(unrecognized)');

/** Splits argv into flag values and switches. Values never appear in errors. */
export function parseArgs(argv) {
  const values = {};
  const switches = {};
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
    if (arg.startsWith('-')) throw new ConfigError(`unknown option ${printable(name)} (see --help)`);
    throw new ConfigError('this command takes options only (see --help)');
  }
  return { values, switches };
}

/**
 * The API origin: plain HTTP on 127.0.0.1 only, the address Holdr listens on, since Holdr's tokens must never leave this
 * computer. `localhost` and [::1] are refused: Node may try ::1 first, where Holdr does not listen but another program
 * could. The same rule as agents/card-sync/lib/config.mjs (loopbackApiOrigin); tests/config.test.mjs checks that both agree.
 */
export function loopbackApiOrigin(value, label = 'HOLDR_APP_URL') {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${label} is not a URL`);
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new ConfigError(`${label} must be http://127.0.0.1:<port>, where Holdr listens (not localhost or [::1]): the server only talks to the Holdr on this computer`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ConfigError(`${label} must be just the origin, such as ${DEFAULT_APP_URL}`);
  }
  return url.origin;
}

/** Holdr's per-user folder (scripts/start-local.mjs, defaultDataRoot): the data folder and the demo folder are inside. */
export function holdrRoot({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : path.win32.join(env.USERPROFILE || homedir, 'AppData', 'Local');
    return path.win32.join(base, 'Holdr');
  }
  if (platform === 'darwin') return path.posix.join(homedir, 'Library', 'Application Support', 'Holdr');
  const xdg = env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.posix.join(homedir, '.local', 'share');
  return path.posix.join(xdg, 'holdr');
}

const pathsFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/** The data folder `npm run start:local` uses when none is given. */
export function startLocalDataDir(options = {}) {
  return pathsFor(options.platform ?? process.platform).join(holdrRoot(options), 'data');
}

/** The demo's data folder (`npm run demo`): `<Holdr>/holdr-demo/data`. */
export function demoDataDir(options = {}) {
  return pathsFor(options.platform ?? process.platform).join(holdrRoot(options), 'holdr-demo', 'data');
}

/**
 * The server's configuration. `platform`, `homedir`, `cwd`, `repoRoot` and `exists` are parameters so that tests can resolve
 * a Windows configuration on macOS and the other way round, without touching the file system.
 */
export function resolveConfig({
  argv = [], env = process.env, platform = process.platform, homedir = os.homedir(), cwd = process.cwd(),
  repoRoot = REPO_ROOT, exists = fs.existsSync,
} = {}) {
  const P = pathsFor(platform);
  const { values, switches } = parseArgs(argv);
  const command = switches.help ? 'help' : switches.version ? 'version' : switches.check ? 'check' : 'serve';
  const demo = Boolean(switches.demo);
  // The demo is self-contained, as npm run demo is: only flags change it, never this shell's Holdr settings.
  const pick = (key) => {
    const setting = SETTINGS.find((candidate) => candidate.key === key);
    if (values[key] !== undefined) return { value: values[key], source: setting.flag };
    const fromEnv = demo ? undefined : env[setting.env];
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

  const appPicked = pick('appUrl');
  const appUrl = appPicked ? loopbackApiOrigin(appPicked.value, appPicked.source) : demo ? DEMO_APP_URL : DEFAULT_APP_URL;

  const where = { platform, env, homedir };
  const dataPicked = pick('dataDir');
  let dataDir;
  let dataSource;
  if (dataPicked) {
    dataDir = toPath(dataPicked.value, dataPicked.source);
    dataSource = dataPicked.source;
  } else if (demo) {
    dataDir = demoDataDir(where);
    dataSource = "the demo's data folder";
  } else {
    // Unset: the folder `npm run start:local` uses, or else the one `npm run dev` uses, whichever holds Holdr's tokens (the
    // card sync agent's rule; Holdr writes both tokens there, and an API from before agent tokens wrote the service token).
    const candidates = [
      { dir: startLocalDataDir(where), source: 'the npm run start:local data folder' },
      { dir: P.join(repoRoot, 'apps', 'api', 'data'), source: 'the npm run dev data folder' },
    ];
    const holdsTokens = (dir) => exists(P.join(dir, TOKEN_FILE_NAME)) || exists(P.join(dir, SERVICE_TOKEN_FILE_NAME));
    const chosen = candidates.find((candidate) => holdsTokens(candidate.dir)) ?? candidates[0];
    dataDir = chosen.dir;
    dataSource = chosen.source;
  }
  // A demo folder named instead of its data folder (the README lists the demo folder itself): use the data folder in it.
  if (!exists(P.join(dataDir, TOKEN_FILE_NAME)) && exists(P.join(dataDir, DEMO_MARKER))) dataDir = P.join(dataDir, 'data');

  // The agent token only: an explicit file, else the one in the data folder. Never the service token's setting.
  const tokenPicked = pick('tokenFile');
  const tokenFile = tokenPicked ? toPath(tokenPicked.value, tokenPicked.source) : P.join(dataDir, TOKEN_FILE_NAME);
  const tokenSource = tokenPicked ? tokenPicked.source : dataSource;

  return Object.freeze({
    command,
    demo,
    platform,
    appUrl,
    appUrlSource: appPicked?.source ?? (demo ? '--demo' : 'the default'),
    dataDir,
    dataSource,
    tokenFile,
    tokenSource,
  });
}
