#!/usr/bin/env node
// Start Holdr on this computer: the API and the web app on 127.0.0.1, your data in a private per-user
// folder outside the repository. One implementation for Windows, macOS and Linux. Needs Node.js 22.
//
//   npm run start:local [-- options]       your own data, at http://127.0.0.1:5173
//   npm run demo [-- options]              the synthetic demo household (its own folder, offline), at http://localhost:5174
//
//   --data-dir DIR       data folder (default: HOLDR_DATA_DIR, else the per-user folder below);
//                        with --demo, the demo folder (default: the holdr-demo folder below)
//   --api-port N         API port on 127.0.0.1 (default: PORT, else 4000; the demo uses 4001)
//   --web-port N         web port on 127.0.0.1 (default 5173; the demo uses 5174)
//   --https-origin URL   the https://<machine>.<tailnet>.ts.net address other devices use through
//                        Tailscale Serve (sets HOLDR_PUBLIC_ORIGIN for the API and the web server)
//   --dev                serve the web app with Vite's dev server (hot reload) instead of the build
//   --rebuild            rebuild packages/shared and the web app before starting
//   --demo               start the demo (what npm run demo does)
//   --reset              demo only: delete the demo folder and seed it again
//   --keep-data          demo only: keep the demo data as it is, even when it was made on an earlier day
//                        (by default the demo is made again for today the first time it starts on a new day)
//   --password-stdin     demo only: read the demo user's password from standard input
//                        (default: a new random one each start, printed once Holdr is running)
//   --password PW        demo only: the demo user's password (other programs can see it; prefer --password-stdin)
//   -h, --help           show this help
//
// Default data folders (each missing folder is created readable by you only; an existing data folder
// is made readable by you only, or refused when it belongs to another account or lies in the demo's folder):
//   Windows  %LOCALAPPDATA%\Holdr\data                   demo: %LOCALAPPDATA%\Holdr\holdr-demo
//   macOS    ~/Library/Application Support/Holdr/data     demo: ~/Library/Application Support/Holdr/holdr-demo
//   Linux    ~/.local/share/holdr/data ($XDG_DATA_HOME)   demo: ~/.local/share/holdr/holdr-demo
//
// The demo deletes and makes its folder again only when the folder holds nothing it did not make.
// A .env file in the repository root is read first (not by the demo); variables already set in the environment win.
// The demo gives its servers only the system's own variables (PATH, the temp and home folders, ...) and its settings.
// The shared package and the web app are built when their build is missing or older than the sources.
// Ctrl+C stops both servers.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import util from 'node:util';

import { childEnv, dropProductionControl, realSystem, startGroup, system32 } from './e2e-disposable.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(REPO, 'apps', 'api');
const WEB_DIR = path.join(REPO, 'apps', 'web');
const SHARED_DIR = path.join(REPO, 'packages', 'shared');
const OFFLINE_PRELOAD = path.join(REPO, 'scripts', 'e2e-offline-fetch.mjs');
const TSC = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
const VITE = path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
/** Written after a successful build; its time is compared with the sources'. */
export const BUILD_STAMP = '.holdr-build-stamp';
/**
 * The file in a demo folder that marks it as one: the demo deletes no folder without it, and start:local and the holdr-*
 * commands refuse a data folder in a folder that holds one.
 */
export const DEMO_MARKER = '.holdr-demo';
export const DEMO_USER = 'demo';
const DEFAULT_PORTS = { api: 4000, web: 5173 };
const DEMO_PORTS = { api: 4001, web: 5174 };
/** The Node.js this repository supports (package.json engines): 22.x from 22.3. */
const NODE_REQUIRED = { major: 22, minor: 3 };

export class UsageError extends Error {}

/** The comment at the top of this file. */
export function usage() {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/).slice(1);
  return lines.slice(0, lines.findIndex((line) => !line.startsWith('//'))).map((line) => line.replace(/^\/\/ ?/, '')).join('\n');
}

export function validatePort(value, flag) {
  if (!/^\d+$/.test(String(value))) throw new UsageError(`${flag} must be a port number, not '${value}'`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new UsageError(`${flag} must be from 1 to 65535`);
  return port;
}

/** Options from the command line; ports and the data folder fall back to the environment in resolveOptions. */
export function parseArgs(argv) {
  const options = {
    dataDir: '', apiPort: '', webPort: '', httpsOrigin: '', password: '', dev: false, rebuild: false, demo: false, reset: false,
    keepData: false, passwordStdin: false, help: false,
  };
  const valued = { '--data-dir': 'dataDir', '--api-port': 'apiPort', '--web-port': 'webPort', '--https-origin': 'httpsOrigin', '--password': 'password' };
  const flags = {
    '--dev': 'dev', '--rebuild': 'rebuild', '--demo': 'demo', '--reset': 'reset', '--keep-data': 'keepData', '--password-stdin': 'passwordStdin',
    '--help': 'help', '-h': 'help',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (Object.hasOwn(valued, flag)) {
      const value = inline ?? (index + 1 < argv.length ? argv[(index += 1)] : undefined);
      if (value === undefined || value === '') throw new UsageError(`${flag} needs a value`);
      options[valued[flag]] = value;
    } else if (Object.hasOwn(flags, arg)) {
      options[flags[arg]] = true;
    } else {
      throw new UsageError(`unknown option ${arg} (see --help)`);
    }
  }
  if (!options.demo && (options.reset || options.password || options.keepData || options.passwordStdin)) {
    throw new UsageError('--reset, --keep-data, --password and --password-stdin are for the demo (npm run demo)');
  }
  if (options.reset && options.keepData) throw new UsageError('--reset makes the demo again; --keep-data keeps it as it is: choose one');
  if (options.password && options.passwordStdin) throw new UsageError('give the demo password with --password or --password-stdin, not both');
  if (options.demo && options.httpsOrigin) throw new UsageError('the demo runs on this computer only; --https-origin is not available with --demo');
  return options;
}

/**
 * `value` as an https origin (`https://host`, no path, query, credentials or port other than 443), or a UsageError.
 * Tailscale Serve gives https://<machine>.<tailnet>.ts.net.
 */
export function parseHttpsOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`--https-origin must be an address like https://holdr.example.ts.net, not '${value}'`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '') || !url.hostname.includes('.')) {
    throw new UsageError(`--https-origin must be an https origin with a host name only, like https://holdr.example.ts.net (got '${value}')`);
  }
  return `https://${url.hostname}`;
}

/** Where Holdr keeps data for this user: an application-data folder per operating system, never inside the repository. */
export function defaultDataRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : path.win32.join(env.USERPROFILE || home, 'AppData', 'Local');
    return path.win32.join(base, 'Holdr');
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'Holdr');
  const xdg = env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.posix.join(home, '.local', 'share');
  return path.posix.join(xdg, 'holdr');
}

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);
export const defaultDataDir = (options = {}) => pathFor(options.platform ?? process.platform).join(defaultDataRoot(options), 'data');
export const defaultDemoRoot = (options = {}) => pathFor(options.platform ?? process.platform).join(defaultDataRoot(options), 'holdr-demo');

/**
 * Text with this user's home folder written short, as the documentation writes it: on Windows `%LOCALAPPDATA%` and
 * `%USERPROFILE%` (in any letter case, either slash), elsewhere `~`. Everything the launcher prints goes through it,
 * its servers' output included, so a pasted log never carries the account name a home folder holds.
 */
export function homeMasker({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [];
  const add = (folder, short) => {
    if (!folder || folder.length < 3) return;
    const parts = folder.split(/[\\/]+/).filter(Boolean);
    if (parts.length < 2) return;
    const separator = platform === 'win32' ? '[\\\\/]+' : '/+';
    const lead = platform === 'win32' ? '' : '/';
    rules.push([new RegExp(`${lead}${parts.map(escape).join(separator)}(?=$|[\\\\/\\s"'\`:;,)\\]])`, platform === 'win32' ? 'gi' : 'g'), short]);
  };
  if (platform === 'win32') {
    add(env.LOCALAPPDATA, '%LOCALAPPDATA%');
    add(env.USERPROFILE || home, '%USERPROFILE%');
  } else {
    add(home, '~');
  }
  return (text) => rules.reduce((masked, [pattern, short]) => masked.replace(pattern, short), String(text));
}

const mask = homeMasker();
/** A path as the launcher shows it: the home folder written short. */
export const displayPath = (target, where) => (where ? homeMasker(where) : mask)(target);

/**
 * The hardened macOS deployment's configuration this process would load (HOLDR_CONFIG, or holdr.conf under
 * ~/Library/Application Support/Holdr), or null. The local launcher refuses to run beside one (the demo, which reads
 * no holdr.conf, may).
 */
export function hardenedConfig(env = process.env, exists = fs.existsSync) {
  if (env.HOLDR_CONFIG?.trim()) return env.HOLDR_CONFIG.trim();
  const home = env.HOME;
  if (!home || !home.startsWith('/')) return null;
  const file = path.posix.join(home, 'Library', 'Application Support', 'Holdr', 'holdr.conf');
  return exists(file) ? file : null;
}

/**
 * Read `file` (a .env file) into `env`: every variable it sets that `env` does not have yet. Returns the names it set.
 * A missing file sets nothing.
 */
export function loadDotEnv(file, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const applied = [];
  for (const [name, value] of Object.entries(util.parseEnv(text))) {
    if (env[name] !== undefined) continue;
    env[name] = value;
    applied.push(name);
  }
  return applied;
}

/** Ports, folders and origin for this start, from the options, then the environment, then the defaults. */
export function resolveOptions(options, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const ports = options.demo ? DEMO_PORTS : DEFAULT_PORTS;
  const apiPort = options.apiPort ? validatePort(options.apiPort, '--api-port')
    : !options.demo && env.PORT ? validatePort(env.PORT, 'PORT') : ports.api;
  const webPort = options.webPort ? validatePort(options.webPort, '--web-port') : ports.web;
  if (apiPort === webPort) throw new UsageError('the API and web ports must differ');
  const where = { platform, env, home };
  const fs_ = pathFor(platform);
  const demoRoot = options.demo ? fs_.resolve(options.dataDir || defaultDemoRoot(where)) : null;
  const dataDir = demoRoot ? fs_.join(demoRoot, 'data')
    : fs_.resolve(options.dataDir || env.HOLDR_DATA_DIR?.trim() || defaultDataDir(where));
  const originSetting = options.httpsOrigin || (options.demo ? '' : env.HOLDR_PUBLIC_ORIGIN?.trim() ?? '');
  // An origin given on the command line must be https; one from the environment is the API's to check.
  const httpsOrigin = options.httpsOrigin ? parseHttpsOrigin(options.httpsOrigin)
    : originSetting.startsWith('https://') ? originSetting : null;
  // The demo is opened on localhost, the start:local on 127.0.0.1: browsers keep a host's cookies whatever the port,
  // so the two sign-ins never replace each other's session.
  const url = `http://${options.demo ? 'localhost' : '127.0.0.1'}:${webPort}`;
  return { apiPort, webPort, dataDir, demoRoot, httpsOrigin, url, dataDirIsDefault: !demoRoot && !options.dataDir && !env.HOLDR_DATA_DIR?.trim() };
}

const unique = (values) => [...new Set(values)];

/**
 * The system's own variables, which the demo's processes get and nothing else from this one's environment (nor a
 * .env file's): the program search path, the temp, home and system folders, the locale and the terminal's.
 */
const SYSTEM_VARIABLES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE',
  'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'XDG_RUNTIME_DIR',
]);

/**
 * `base` cut to the system's own variables (by name, any letter case on Windows). With `api`, HOME goes too: the API
 * finds a hardened deployment's holdr.conf only through HOME, and the demo never reads one.
 */
export function demoBaseEnv(base, platform = process.platform, { api = false } = {}) {
  const key = (name) => (platform === 'win32' ? name.toUpperCase() : name);
  return Object.fromEntries(Object.entries(base).filter(([name, value]) => value !== undefined && SYSTEM_VARIABLES.has(key(name))
    && !(api && key(name) === 'HOME')));
}

/** The API's environment: loopback, this data folder, the web server's origins; the demo's is offline and its own. */
export function apiEnvFor(base, { dataDir, apiPort, webPort, httpsOrigin, demo }, platform = process.platform) {
  const userOrigins = (base.WEB_ORIGIN ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  const overrides = {
    HOLDR_DATA_DIR: dataDir,
    PORT: String(apiPort),
    HOLDR_HOST: '127.0.0.1',
    WEB_ORIGIN: unique([`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`, ...(demo ? [] : userOrigins)]).join(','),
  };
  if (httpsOrigin) overrides.HOLDR_PUBLIC_ORIGIN = httpsOrigin;
  if (demo) {
    Object.assign(overrides, {
      // No snapshots or live prices: quotes, history and metal values come from the stored synthetic closes
      // (HOLDR_MARKET_DATA=stored), and no provider is ever asked.
      HOLDR_MARKET_DATA: 'stored',
      SNAPSHOTS_ENABLED: '0',
      HOLDR_INTRADAY_PRICES: '0',
      BROKER_BRIDGE_URL: 'http://broker-bridge.demo.invalid',
      QLIB_THESIS_URL: 'http://thesis.demo.invalid',
    });
    return childEnv(demoBaseEnv(base, platform, { api: true }), overrides, { platform });
  }
  return childEnv(base, overrides, {
    platform,
    drop: (name) => dropProductionControl(name) || /^HOLDR_E2E_/i.test(name),
  });
}

/** The web server's (and the web build's) environment: API calls stay on its own origin, through its proxy. */
export function webEnvFor(base, { apiPort, httpsOrigin, demo }, platform = process.platform) {
  const overrides = { VITE_API_BASE: '', HOLDR_API_TARGET: `http://127.0.0.1:${apiPort}` };
  if (httpsOrigin) overrides.HOLDR_PUBLIC_ORIGIN = httpsOrigin;
  if (demo) return childEnv(demoBaseEnv(base, platform), overrides, { platform });
  return childEnv(base, overrides, { platform, drop: (name) => /^vite_/i.test(name) });
}

/** The command that publishes the web server to the tailnet over HTTPS. */
export const tailscaleServeCommand = (webPort) => `tailscale serve --bg --https=443 http://127.0.0.1:${webPort}`;

/** Where the `tailscale` command is, and what it may need, on each operating system: printed with the command. */
export function tailscaleHints(platform = process.platform) {
  if (platform === 'darwin') {
    return [
      'on macOS, add the tailscale command once: with the standalone Tailscale app, choose',
      'Settings → CLI integration → Show me how → Install Now; with the App Store app, or for this Terminal window only:',
      'alias tailscale=/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    ];
  }
  if (platform === 'win32') return ['if Windows answers "Access denied", run it once in an administrator PowerShell'];
  return [];
}

/**
 * The lines printed once both servers answer. With an https origin that address leads: the API then issues Secure sign-in
 * cookies, so signing in works only there, on this computer too.
 */
export function runningBanner({ demo = false, url, httpsOrigin = null, webPort, dataDir, demoRoot, password, passwordStdin = false },
  platform = process.platform) {
  const lines = ['', `${demo ? 'The Holdr demo' : 'Holdr'} is running: ${httpsOrigin ?? url}`];
  if (httpsOrigin) lines.push(`  open that address on this computer too: its sign-in cookies are Secure, so ${url} cannot sign you in`);
  if (demo) {
    lines.push(
      `  sign in as ${DEMO_USER}, password: ${passwordStdin ? '(the one you gave)' : password}`,
      `  demo folder: ${displayPath(demoRoot)} (synthetic data; safe to delete)`,
      '  everything shown is invented, and the demo makes no network requests',
      '  it opens on localhost, so signing in here never signs you out of your own Holdr at 127.0.0.1',
    );
  } else {
    lines.push(`  data folder: ${displayPath(dataDir)}`);
  }
  if (httpsOrigin?.endsWith('.ts.net')) {
    lines.push(`  publish it once with: ${tailscaleServeCommand(webPort)}`, ...tailscaleHints(platform).map((hint) => `    ${hint}`));
  } else if (httpsOrigin) {
    lines.push(`  point your HTTPS proxy for ${httpsOrigin} at http://127.0.0.1:${webPort}`);
  }
  lines.push('  stop: Ctrl+C', '');
  return lines;
}

/** The newest modification time under `entries` (files or folders; node_modules, dist and build output skipped). */
export function newestMtime(entries) {
  let newest = 0;
  const skip = new Set(['node_modules', 'dist', '.turbo', 'releases', 'test-results', 'playwright-report']);
  const visit = (entry) => {
    let stat;
    try {
      stat = fs.statSync(entry);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) if (!skip.has(child)) visit(path.join(entry, child));
    } else {
      newest = Math.max(newest, stat.mtimeMs);
    }
  };
  for (const entry of entries) visit(entry);
  return newest;
}

/**
 * Whether `outDir` needs a build: no build stamp (and no `marker` output file, e.g. tsc's `index.js`, to date it by), or
 * an input changed after it.
 */
export function needsBuild(outDir, inputs, { force = false, marker = null } = {}) {
  if (force) return true;
  const mtimeOf = (file) => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  };
  const built = mtimeOf(path.join(outDir, BUILD_STAMP)) ?? (marker ? mtimeOf(path.join(outDir, marker)) : null);
  if (built === null) return true;
  return newestMtime(inputs) > built;
}

export function writeBuildStamp(outDir) {
  fs.writeFileSync(path.join(outDir, BUILD_STAMP), `${new Date().toISOString()}\n`);
}

/** Whether `version` is a Node.js this repository supports (package.json engines): 22.3 or a later 22.x. */
export function supportedNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major === NODE_REQUIRED.major && minor >= NODE_REQUIRED.minor;
}

/** What to tell someone running an unsupported Node.js, or null. */
export function nodeVersionProblem(version = process.versions.node) {
  if (supportedNode(version)) return null;
  return `Holdr needs Node.js 22 (22.3 or a later 22.x release); this is Node.js ${version}. Its database driver, better-sqlite3, is a native `
    + 'module that npm installs as a prebuilt binary for the Node.js major version that ran npm ci; under another version it '
    + 'does not load, and building it yourself needs Python and a C++ compiler. Install Node.js 22 LTS (https://nodejs.org/, '
    + 'or "nvm install 22" / "fnm install 22"), then run npm ci again in the repository.';
}

/* ------------------------------------------------------------------ */
/* Private folders                                                    */
/* ------------------------------------------------------------------ */

const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';
const CREATOR_OWNER_SID = 'S-1-3-0';

/** Windows: the current user's SID, from whoami. */
export function parseWhoamiSid(output) {
  const match = /"(S-1-[0-9-]+)"\s*$/m.exec(output.trim());
  if (!match) throw new Error('whoami did not report your user SID');
  return match[1];
}

/** icacls arguments that leave `dir` with full control for the user and SYSTEM only, owned by the user. */
export function icaclsPlan(dir, sid) {
  if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error(`${sid} is not a SID`);
  return [
    [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
    [dir, '/setowner', `*${sid}`],
  ];
}

function runChecked(file, args, env) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) });
  if (result.status !== 0) throw new Error(`${path.basename(file)} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim().split('\n')[0]}`);
  return result.stdout;
}

/**
 * Windows PowerShell 5.1: who owns $env:HOLDR_PRIVATE_DIR, who the current user is (and whether this process runs as an
 * administrator), and every access rule on it, as SIDs and numbers only, so nothing depends on the display language.
 */
export const WINDOWS_ACL_SCRIPT = `$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.SecurityIdentifier]
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$acl = Get-Acl -LiteralPath $env:HOLDR_PRIVATE_DIR
[pscustomobject]@{
  user = $identity.User.Value
  admin = $admin
  owner = $acl.GetOwner($sid).Value
  aces = @(foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {
    [pscustomobject]@{ sid = $rule.IdentityReference.Value; rights = [int64][int]$rule.FileSystemRights; type = $rule.AccessControlType.ToString() }
  })
} | ConvertTo-Json -Depth 4 -Compress`;

/** The ACL PowerShell printed for WINDOWS_ACL_SCRIPT, checked: SIDs, numbers, Allow or Deny. */
export function parseWindowsAcl(stdout) {
  const data = JSON.parse(String(stdout).trim());
  const sid = (value) => typeof value === 'string' && /^S-1-\d+(-\d+)+$/.test(value);
  const aces = Array.isArray(data?.aces) ? data.aces : data?.aces ? [data.aces] : [];
  if (!sid(data?.user) || !sid(data?.owner) || !aces.every((ace) => sid(ace?.sid) && Number.isInteger(ace.rights) && ['Allow', 'Deny'].includes(ace.type))) {
    throw new Error('PowerShell did not describe the folder\'s owner and access rules');
  }
  return { user: data.user, admin: data.admin === true, owner: data.owner, aces: aces.map((ace) => ({ sid: ace.sid, rights: ace.rights >>> 0, type: ace.type })) };
}

function inspectWindowsDir(dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
  const script = Buffer.from(WINDOWS_ACL_SCRIPT, 'utf16le').toString('base64');
  const out = runChecked(system32('WindowsPowerShell\\v1.0\\powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', script], { ...env, HOLDR_PRIVATE_DIR: dir });
  return parseWindowsAcl(out);
}

/**
 * Whether a folder that already exists is private: `private`, `tighten` (it is this user's, and others can read it),
 * or a refusal (another account owns it). On Windows by its owner and access rules: the user, SYSTEM and the
 * Administrators group may have access, nobody else (an elevated administrator's folders are owned by the group); elsewhere by
 * its owner's uid and mode bits.
 */
export function privateDirVerdict(facts) {
  if (facts.platform === 'win32') {
    const ours = facts.owner === facts.user || (facts.owner === ADMINISTRATORS_SID && facts.admin);
    if (!ours) return { refuse: 'owner' };
    const others = facts.aces.filter((ace) => ace.type === 'Allow' && ace.rights !== 0
      && ![facts.user, SYSTEM_SID, ADMINISTRATORS_SID].includes(ace.sid) && !(ace.sid === CREATOR_OWNER_SID && facts.owner === facts.user));
    return others.length > 0 ? { tighten: [...new Set(others.map((ace) => ace.sid))] } : 'private';
  }
  if (facts.uid !== facts.processUid) return { refuse: 'owner' };
  return (facts.mode & 0o077) !== 0 ? { tighten: [] } : 'private';
}

/**
 * Whether a folder holds nothing but Holdr's own files: the database and its journal files, the old state file, the
 * service and agent tokens the API writes at every start, and dot files.
 */
export function holdrOnlyEntries(names) {
  return names.every((name) => /^(?:finance\.db.*|state\.json.*|service-token.*|agent-token.*|\..*)$/i.test(name));
}

/**
 * PowerShell that leaves a folder to the current user and SYSTEM only, by SID as icaclsPlan does (%USERNAME% is cmd
 * syntax, which PowerShell does not expand; SIDs also work in any display language).
 */
export const WINDOWS_PRIVATE_FOLDER_COMMAND = '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; '
  + 'icacls "<folder>" /inheritance:r /grant:r "*${me}:(OI)(CI)F" \'*S-1-5-18:(OI)(CI)F\'';

export class PrivacyRefusal extends Error {}

/**
 * Make an existing data folder readable by its owner only, when it is this user's and holds Holdr's files only; refuse
 * one another account owns. Returns whether it changed anything. A check that cannot run (no PowerShell) warns.
 */
export function makePrivate(dir, { platform = process.platform, run = runChecked, inspect, report = () => {} } = {}) {
  const where = displayPath(dir);
  let facts;
  try {
    if (platform === 'win32') {
      facts = { platform, ...(inspect ?? inspectWindowsDir)(dir) };
    } else {
      const stat = fs.statSync(dir);
      facts = { platform, uid: stat.uid, mode: stat.mode, processUid: process.getuid?.() ?? stat.uid };
    }
  } catch (error) {
    report(`could not check who can read the data folder ${where} (${String(error.message).split('\n')[0]}); make sure only you can`);
    return false;
  }
  const verdict = privateDirVerdict(facts);
  if (verdict === 'private') return false;
  if (verdict.refuse) {
    throw new PrivacyRefusal(`the data folder ${where} belongs to another account, so Holdr will not use it. Choose a folder of your own `
      + 'with --data-dir (or HOLDR_DATA_DIR), or make yourself its owner first '
      + (platform === 'win32' ? '(in an administrator PowerShell: takeown /f "<folder>" /r /d y).' : '(sudo chown -R "$USER" "<folder>").'));
  }
  if (!holdrOnlyEntries(fs.readdirSync(dir))) {
    throw new PrivacyRefusal(`the data folder ${where} can be read by other accounts and holds files that are not Holdr's, so Holdr will not `
      + 'change who can read it. Keep Holdr\'s data in a folder of its own (--data-dir), or make the folder private yourself '
      + (platform === 'win32' ? `(in PowerShell: ${WINDOWS_PRIVATE_FOLDER_COMMAND}).` : '(chmod 700 "<folder>").'));
  }
  if (platform === 'win32') {
    const icacls = system32('icacls.exe');
    if (verdict.tighten.length > 0) run(icacls, [dir, '/remove:g', ...verdict.tighten.map((sid) => `*${sid}`)]);
    for (const args of icaclsPlan(dir, facts.user)) run(icacls, args);
    const after = privateDirVerdict({ platform, ...(inspect ?? inspectWindowsDir)(dir) });
    if (after !== 'private') throw new PrivacyRefusal(`the data folder ${where} could not be made readable by you only; fix its permissions and start again`);
  } else {
    fs.chmodSync(dir, 0o700);
  }
  report(`made the data folder ${where} readable by you only (other accounts could read it)`);
  return true;
}

/**
 * Create `dir` and any missing folder above it, each readable by the current user only: mode 0700 on macOS and Linux,
 * an ACL for the user and SYSTEM (inheritance removed) on Windows. An existing `dir` is made private the same way when it
 * is this user's (makePrivate; `tighten: false` leaves it as it is). Returns the folders it created.
 */
export function ensurePrivateDir(dir, { platform = process.platform, run = runChecked, inspect, tighten = true, report } = {}) {
  const missing = [];
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) {
    missing.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  let sid = null;
  for (const entry of missing) {
    fs.mkdirSync(entry, { mode: 0o700 });
    if (platform === 'win32') {
      sid ??= parseWhoamiSid(run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']));
      for (const args of icaclsPlan(entry, sid)) run(system32('icacls.exe'), args);
    } else {
      fs.chmodSync(entry, 0o700);
    }
  }
  if (!fs.statSync(dir).isDirectory()) throw new Error(`${displayPath(dir)} is not a folder`);
  if (missing.length === 0 && tighten) makePrivate(dir, { platform, run, inspect, report });
  return missing;
}

/* ------------------------------------------------------------------ */
/* The demo                                                           */
/* ------------------------------------------------------------------ */

const NEW_YORK_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The New York calendar date of `now` (YYYY-MM-DD): the demo's today, as the API's market date. */
export function newYorkDate(now = new Date()) {
  const parts = Object.fromEntries(NEW_YORK_DATE.formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const DEMO_MARKER_TEXT = 'Holdr demo data (synthetic). Safe to delete.\n';
/** A whole demo marker: its text, then `seeded <day>` once a seed has finished (apps/api/src/demo/demoMarker.ts checks the same). */
const DEMO_MARKER_PATTERN = /^Holdr demo data \(synthetic\)\. Safe to delete\.\n(?:seeded (\d{4}-\d{2}-\d{2})\n)?$/;

/** The day a demo folder's marker says its seed finished (YYYY-MM-DD), or null: missing, or a seed that never finished. */
export function demoSeededOn(markerText) {
  return DEMO_MARKER_PATTERN.exec(markerText ?? '')?.[1] ?? null;
}

const lstatOrNull = (file) => {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
};

/**
 * The marker of `demoRoot` when the demo wrote it: a regular file (not a link) holding exactly the launcher's text. Null
 * for anything else, a missing marker included.
 */
export function readDemoMarker(demoRoot) {
  const file = path.join(demoRoot, DEMO_MARKER);
  const stat = lstatOrNull(file);
  if (!stat?.isFile() || stat.size > 256) return null;
  const text = fs.readFileSync(file, 'utf8');
  return DEMO_MARKER_PATTERN.test(text) ? text : null;
}

/** `target` with its deepest existing folder resolved through links, the rest as written. */
function physicalPath(target) {
  const rest = [];
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return target;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...rest);
}

/**
 * The demo folder that `dir` is or lies in, as written or through links: the nearest folder, `dir` included, holding a
 * `.holdr-demo` entry of any kind; null when there is none. The demo deletes that folder whenever it makes its data again,
 * so start:local and the holdr-* commands (scripts/holdr-cli.mjs) keep your own data out of it.
 */
export function demoFolderAround(dir) {
  const requested = path.resolve(dir);
  let physical = requested;
  try {
    physical = physicalPath(requested);
  } catch {
    // Unreadable above: the path as written is still checked.
  }
  for (const start of unique([requested, physical])) {
    for (let current = start; ; current = path.dirname(current)) {
      if (lstatOrNull(path.join(current, DEMO_MARKER))) return current;
      if (path.dirname(current) === current) break;
    }
  }
  return null;
}

/** Why a data folder in the demo's folder is refused. */
export function demoFolderRefusal(dataDir, demoFolder) {
  return `the data folder ${displayPath(dataDir)} is in the demo's folder ${displayPath(demoFolder)} (it holds ${DEMO_MARKER}), `
    + 'and npm run demo deletes that folder whenever it makes the demo again, so Holdr keeps your own data out of it. Use npm run demo '
    + 'for the demo; for your own data leave out --data-dir and HOLDR_DATA_DIR (the default folder), or choose a folder of your own.';
}

/**
 * What a marked demo folder holds that the demo did not make, or null: beside its marker only `data`, a plain folder
 * (not a link) of Holdr's own files (holdrOnlyEntries), and dot files or the files Windows Explorer adds. The demo's
 * helper checks the database itself (demoSeedCli.ts check).
 */
export function demoFolderProblem(demoRoot) {
  const clutter = (name) => name.startsWith('.') || /^(?:desktop\.ini|thumbs\.db)$/i.test(name);
  const extra = fs.readdirSync(demoRoot).filter((name) => name !== 'data' && !clutter(name));
  if (extra.length > 0) return `${extra.length === 1 ? 'an entry' : `${extra.length} entries`} beside its data folder`;
  const data = path.join(demoRoot, 'data');
  const stat = lstatOrNull(data);
  if (!stat) return null;
  if (!stat.isDirectory()) return 'a data entry that is not a plain folder';
  if (!holdrOnlyEntries(fs.readdirSync(data).filter((name) => !clutter(name)))) return 'files in its data folder that are not Holdr\'s';
  return null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Delete the checked demo folder `demoRoot` so it can be made again. It is first renamed aside, so a delete that stops
 * half-way (a file still in use) never leaves a folder without its marker where the demo looks for it; then its data goes,
 * its marker last, with retries. A folder that cannot be renamed (the demo still running from it) stops the start with
 * nothing changed; a renamed copy that cannot be deleted is only reported. Returns the renamed path.
 */
export function discardDemoFolder(demoRoot, {
  rename = fs.renameSync, remove = fs.rmSync, report = (message) => warn(message), attempts = 5,
} = {}) {
  const aside = `${demoRoot}.old-${randomBytes(4).toString('hex')}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(demoRoot, aside);
      break;
    } catch (error) {
      if (attempt >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        throw new Fatal(`the demo folder ${displayPath(demoRoot)} could not be moved aside to make it again `
          + `(${error.code ?? error.message}), so nothing was deleted. If the demo still runs in another window, stop it there, then start again.`);
      }
      sleepSync(100 * attempt);
    }
  }
  try {
    for (const name of fs.readdirSync(aside)) {
      if (name !== DEMO_MARKER) remove(path.join(aside, name), { recursive: true, force: true, maxRetries: 5 });
    }
    remove(aside, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    const marked = lstatOrNull(path.join(aside, DEMO_MARKER)) ? `; it still holds its ${DEMO_MARKER} marker` : '';
    report(`the old demo folder ${displayPath(aside)} could not be deleted (${error.code ?? error.message})${marked}: `
      + 'delete it yourself once nothing uses it');
  }
  return aside;
}

/**
 * What to do with the demo folder: `seed` it (none yet, or one a seed left half-written), `reset` it (--reset), `refresh`
 * it (made on another day: the demo always runs up to today), `keep` its data from another day (--keep-data), or `reuse`
 * it (made today).
 */
export function demoPlan({ exists, seeded, databaseExists, today, reset, keepData }) {
  if (!exists) return 'seed';
  if (reset) return 'reset';
  if (seeded === null || !databaseExists) return 'seed';
  if (seeded === today) return 'reuse';
  return keepData ? 'keep' : 'refresh';
}

/* ------------------------------------------------------------------ */
/* Running                                                            */
/* ------------------------------------------------------------------ */

const log = (message) => console.log(`[holdr] ${mask(message)}`);
const warn = (message) => console.error(`[holdr] ${mask(message)}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Fatal extends Error {}

function build(name, args, cwd, env) {
  log(`building ${name}...`);
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Fatal(`building ${name} failed; fix the error above, or run npm ci again`);
}

/** Build packages/shared when its build is missing or older than its sources (`npm ci` builds it too). */
export function ensureSharedBuilt({ rebuild = false } = {}) {
  const sharedDist = path.join(SHARED_DIR, 'dist');
  const inputs = [path.join(SHARED_DIR, 'src'), path.join(SHARED_DIR, 'tsconfig.json'), path.join(SHARED_DIR, 'package.json')];
  if (!needsBuild(sharedDist, inputs, { force: rebuild, marker: 'index.js' })) return false;
  build('packages/shared', [TSC, '-p', path.join(SHARED_DIR, 'tsconfig.json')], REPO, process.env);
  writeBuildStamp(sharedDist);
  return true;
}

function ensureWebBuilt({ dev, rebuild, webEnv }) {
  if (dev) return;
  const webDist = path.join(WEB_DIR, 'dist');
  const webInputs = [path.join(WEB_DIR, 'src'), path.join(WEB_DIR, 'index.html'), path.join(WEB_DIR, 'vite.config.ts'), path.join(SHARED_DIR, 'src'), path.join(REPO, 'package-lock.json')];
  if (needsBuild(webDist, webInputs, { force: rebuild, marker: 'index.html' })) {
    build('the web app', [VITE, 'build'], WEB_DIR, webEnv);
    writeBuildStamp(webDist);
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function waitForHttp(url, group, seconds = 90) {
  for (let waited = 0; waited < seconds * 2; waited += 1) {
    if (!group.running()) return false;
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
      await response.arrayBuffer();
      if (response.ok) return true;
    } catch {
      // Not answering yet.
    }
    await sleep(500);
  }
  return false;
}

/** Copy `stream` to `out` line by line with the home folder written short. */
function forwardMasked(stream, out) {
  if (!stream) return;
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    rest += chunk;
    const lines = rest.split('\n');
    rest = lines.pop();
    for (const line of lines) out.write(`${mask(line)}\n`);
  });
  stream.on('end', () => {
    if (rest) out.write(mask(rest));
    rest = '';
  });
}

/** startGroup with the program's output copied through the home folder mask. */
function startMasked(name, program, args, { cwd, env }) {
  let child = null;
  const system = { ...realSystem, spawn: (...spawnArgs) => (child = realSystem.spawn(...spawnArgs)) };
  const group = startGroup(name, program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }, system);
  forwardMasked(child?.stdout, process.stdout);
  forwardMasked(child?.stderr, process.stderr);
  return group;
}

/**
 * Run a TypeScript helper of apps/api (the demo's seed and password helpers) with `input` on its standard input, under
 * the same offline preload as the demo's API; returns whether it succeeded.
 */
function runApiHelper(args, input, env) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(OFFLINE_PRELOAD).href, ...args], {
    cwd: API_DIR, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 16 << 20,
  });
  if (result.stdout) process.stdout.write(mask(result.stdout));
  if (result.stderr) process.stderr.write(mask(result.stderr));
  return result.status === 0;
}

/**
 * Make sure the demo folder exists, is marked and is seeded for today (its New York date); with `reset`, start over.
 * An existing folder must carry the marker the demo wrote. Before one is deleted to be made again, it must also hold
 * nothing the demo did not make: beside the marker only its data folder of Holdr's own files (demoFolderProblem), and a
 * database with the demo household and the demo user only, which the demo's helper reads read-only. Deleting renames it
 * aside first (discardDemoFolder). The marker is written before seeding (so a folder a seed left half-written is still
 * recognized as the demo's and replaced) and gets its `seeded` line, the day the data runs up to, only once the seed has
 * finished. Returns the data folder.
 */
function prepareDemo(demoRoot, { reset, keepData, password, now }) {
  const marker = path.join(demoRoot, DEMO_MARKER);
  const dataDir = path.join(demoRoot, 'data');
  const stat = lstatOrNull(demoRoot);
  const markerText = stat?.isDirectory() ? readDemoMarker(demoRoot) : null;
  if (stat && markerText === null) {
    throw new Fatal(`${displayPath(demoRoot)} exists but is not a demo folder (no ${DEMO_MARKER} file the demo wrote); move it away first`);
  }
  const exists = stat !== null;
  const today = newYorkDate(now);
  const seeded = demoSeededOn(markerText);
  const plan = demoPlan({ exists, seeded, databaseExists: fs.existsSync(path.join(dataDir, 'finance.db')), today, reset, keepData });
  const env = childEnv(demoBaseEnv(process.env, process.platform, { api: true }), { HOLDR_DATA_DIR: dataDir });
  if (plan === 'reuse' || plan === 'keep') {
    if (plan === 'keep') log(`keeping the demo data made on ${seeded} (--keep-data); it runs up to that day`);
    if (!runApiHelper(['src/demo/demoSeedCli.ts', 'password', '--data-dir', dataDir], `${password}\n`, env)) throw new Fatal('setting the demo password failed');
    return dataDir;
  }
  if (exists) {
    const keepHint = seeded ? '; or start with --keep-data to keep it as it is' : '';
    const notDeleted = (what) => new Fatal(`the demo folder ${displayPath(demoRoot)} holds ${what}, so it is not deleted to make the demo `
      + `again. If nothing in it is yours, delete the folder yourself, then start the demo again${keepHint}.`);
    const problem = demoFolderProblem(demoRoot);
    if (problem) throw notDeleted(problem);
    if (!runApiHelper(['src/demo/demoSeedCli.ts', 'check', '--data-dir', dataDir], '', env)) {
      throw notDeleted('data the demo did not make (see above)');
    }
    if (plan === 'reset') log(`deleting the demo folder ${displayPath(demoRoot)}`);
    else if (plan === 'refresh') log(`the demo data was made on ${seeded}; making it again for ${today} (start with --keep-data to keep it as it is)`);
    else log('the demo folder is incomplete (an earlier start stopped while seeding it); seeding it again');
    discardDemoFolder(demoRoot);
  }
  ensurePrivateDir(demoRoot);
  fs.writeFileSync(marker, DEMO_MARKER_TEXT, { mode: 0o600 });
  log('seeding the demo household (synthetic data)...');
  if (!runApiHelper(['src/demo/demoSeedCli.ts', 'seed', '--data-dir', dataDir, '--now', now.toISOString()], `${password}\n`, env)) {
    throw new Fatal('seeding the demo failed; run npm run demo again to start over');
  }
  fs.writeFileSync(marker, `${DEMO_MARKER_TEXT}seeded ${today}\n`, { mode: 0o600 });
  return dataDir;
}

/** The first line of standard input (the demo password for --password-stdin). */
async function readPasswordLine() {
  if (process.stdin.isTTY) log('type the demo password and press Enter');
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.includes('\n')) break;
  }
  process.stdin.pause();
  return text.split(/\r?\n/)[0];
}

async function run(options) {
  const nodeProblem = nodeVersionProblem();
  if (nodeProblem) throw new Fatal(nodeProblem);
  for (const tool of [TSC, VITE, path.join(REPO, 'node_modules', 'tsx', 'package.json')]) {
    if (!fs.existsSync(tool)) throw new Fatal(`${path.relative(REPO, tool)} is missing; run npm ci in the repository first`);
  }
  const password = !options.demo ? '' : options.passwordStdin ? await readPasswordLine() : options.password || randomBytes(12).toString('base64url');
  if (!options.demo) {
    const applied = loadDotEnv(path.join(REPO, '.env'));
    if (applied.length) log(`read ${applied.length} setting(s) from .env`);
    const config = hardenedConfig();
    if (config) {
      throw new Fatal(`a hardened deployment configuration is in use (${displayPath(config)}); npm run start:local is for the single-machine setup. `
        + 'Use the macOS start script for that deployment (docs/deployment.md), or unset HOLDR_CONFIG.');
    }
  }
  const settings = resolveOptions(options);
  const { apiPort, webPort, httpsOrigin } = settings;
  const demoFolder = options.demo ? null : demoFolderAround(settings.dataDir);
  if (demoFolder) throw new Fatal(demoFolderRefusal(settings.dataDir, demoFolder));
  for (const [port, what] of [[apiPort, 'API'], [webPort, 'web']]) {
    if (!(await portIsFree(port))) throw new Fatal(`the ${what} port ${port} is in use (is Holdr already running?); choose another with --${what === 'API' ? 'api' : 'web'}-port`);
  }

  // The API's helpers load @finance-tracker/shared from its build: build it before anything runs them.
  ensureSharedBuilt({ rebuild: options.rebuild });
  let dataDir = settings.dataDir;
  if (options.demo) {
    dataDir = prepareDemo(settings.demoRoot, { reset: options.reset, keepData: options.keepData, password, now: new Date() });
  } else {
    try {
      const created = ensurePrivateDir(dataDir, { report: log });
      if (created.length) log(`created the data folder ${displayPath(dataDir)} (readable by you only)`);
    } catch (error) {
      if (error instanceof PrivacyRefusal) throw new Fatal(error.message);
      throw error;
    }
  }

  const webEnv = webEnvFor(process.env, { apiPort, httpsOrigin, demo: options.demo });
  ensureWebBuilt({ dev: options.dev, rebuild: options.rebuild, webEnv });

  // The demo keeps the offline preload as a backstop: stored market data asks no provider, and the preload refuses any
  // outbound connection that something else might still try.
  const apiArgs = ['--import', 'tsx', ...(options.demo ? ['--import', pathToFileURL(OFFLINE_PRELOAD).href] : []), 'src/index.ts'];
  const api = startMasked('api', process.execPath, apiArgs, {
    cwd: API_DIR,
    env: apiEnvFor(process.env, { dataDir, apiPort, webPort, httpsOrigin, demo: options.demo }),
  });
  services.push(api);
  if (!(await waitForHttp(`http://127.0.0.1:${apiPort}/health`, api))) throw new Fatal('the API did not start; see its output above');

  const webArgs = [VITE, ...(options.dev ? [] : ['preview']), '--port', String(webPort), '--strictPort', '--host', '127.0.0.1'];
  const web = startMasked('web', process.execPath, webArgs, { cwd: WEB_DIR, env: webEnv });
  services.push(web);
  if (!(await waitForHttp(`http://127.0.0.1:${webPort}/`, web))) throw new Fatal('the web server did not start; see its output above');

  console.log(runningBanner({
    demo: options.demo, url: settings.url, httpsOrigin, webPort, dataDir, demoRoot: settings.demoRoot, password,
    passwordStdin: options.passwordStdin,
  }).join('\n'));

  const first = await Promise.race(services.map((group) => group.exited.then((result) => ({ group, result }))));
  // On Windows Ctrl+C reaches the servers too, and one may exit before this process has seen the signal.
  await sleep(1_000);
  if (stopping) return stopping;
  warn(`${first.group.name} exited (code ${first.result.code ?? first.result.signal ?? 'unknown'}); stopping`);
  return 1;
}

const services = [];
let stopping = null;

async function stopAll() {
  for (const group of [...services].reverse()) await group.stop();
}

/** Stop everything once and exit with `status`. */
function finish(status) {
  stopping ??= (async () => {
    await stopAll();
    process.exit(status);
  })();
  return stopping;
}

export async function main(argv = process.argv.slice(2)) {
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    warn(error.message);
    return finish(2);
  }
  if (options.help) {
    console.log(usage());
    return finish(0);
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) {
    process.on(signal, () => {
      if (stopping) return;
      log(`stopping (${signal})...`);
      finish(0);
    });
  }
  let status;
  try {
    status = await run(options);
  } catch (error) {
    if (stopping) return stopping;
    warn(error instanceof Fatal || error instanceof UsageError ? error.message : `unexpected error: ${error.stack ?? error}`);
    status = error instanceof UsageError ? 2 : 1;
  }
  return finish(status);
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

if (invokedAsScript()) await main();
