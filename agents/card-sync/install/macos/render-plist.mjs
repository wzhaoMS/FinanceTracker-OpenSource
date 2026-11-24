// Writes the LaunchAgent that starts the Holdr card sync receiver (experimental) whenever you log in to macOS:
// ~/Library/LaunchAgents/local.holdr.card-sync.plist, mode 0644. Every value is XML-escaped, so paths may hold &, <, >,
// quotes or |. It also creates the log folder (~/Library/Logs/Holdr, mode 0700), which launchd needs before it starts the
// receiver, and checks the file with `plutil -lint` before putting it in place. From the checkout, in the Terminal where
// `npm run agent` works:
//   launchctl bootout gui/$(id -u)/local.holdr.card-sync 2>/dev/null
//   node agents/card-sync/install/macos/render-plist.mjs [options]
//   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.holdr.card-sync.plist
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError, pathInside, REPO_ROOT, resolveConfig, SETTINGS } from '../../lib/config.mjs';

export const LABEL = 'local.holdr.card-sync';
const P = path.posix;
// Settings that name a file or folder are made absolute here: launchd starts the receiver in the checkout.
const PATH_SETTINGS = new Set(['tokenFile', 'dataDir', 'imports', 'extensionDir']);
const RECEIVER_SETTINGS = SETTINGS.filter((setting) => setting.key !== 'logFile');
const OWN_OPTIONS = { '--node': 'node', '--log-dir': 'logDir', '--out': 'out' };

export const USAGE = `Writes the LaunchAgent that starts the Holdr card sync receiver at login (macOS).

Usage: node agents/card-sync/install/macos/render-plist.mjs [options]

  --node PATH       the node to run (default: the first node on PATH, as \`command -v node\` finds it)
  --log-dir FOLDER  the receiver's log folder (default ~/Library/Logs/Holdr), created owner-only
  --out FILE        where to write it (default ~/Library/LaunchAgents/${LABEL}.plist)
  --print           print the file and write nothing

The receiver's settings go into the LaunchAgent only when you give them, as options or as their environment variables
(npm run agent -- help lists them); without them the receiver uses its own defaults, as \`npm run agent\` does:
  ${RECEIVER_SETTINGS.map((setting) => setting.flag).join(', ')}
`;

export class RenderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderError';
  }
}

/** `value` as XML character data: &, <, >, " and ' escaped; characters a property list cannot hold refused. */
export function xmlText(value) {
  const text = String(value);
  if (/[\u0000-\u001f\u007f\ufffe\uffff]/.test(text) || !text.isWellFormed()) {
    throw new RenderError('a value holds a control character (a line break, say), which a LaunchAgent cannot carry');
  }
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** The LaunchAgent: `node` runs the receiver in `repo` with `args`, its log in `logDir` (all macOS paths). */
export function renderPlist({ node, repo, logDir, args = [] }) {
  const strings = [node, P.join(repo, 'agents', 'card-sync', 'receiver.mjs'), '--log-file', P.join(logDir, 'card-sync-receiver.log'), ...args];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- The Holdr card sync receiver (experimental), written by agents/card-sync/install/macos/render-plist.mjs. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings.map((value) => `    <string>${xmlText(value)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlText(repo)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardErrorPath</key>
  <string>${xmlText(P.join(logDir, 'card-sync-receiver-errors.log'))}</string>
</dict>
</plist>
`;
}

/** The first executable `node` on PATH, as the shell finds it (a stable link, not the versioned file it points at). */
function nodeOnPath(searchPath) {
  for (const dir of String(searchPath ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'node');
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Not here.
    }
  }
  return null;
}

/**
 * What to write, from the options and environment: `{ xml, out, logDir, print, help }`. Paths are macOS paths, made
 * absolute against `cwd` and `homedir`; the receiver's settings are checked as the receiver will check them.
 */
export function planLaunchAgent({ argv = [], env = {}, cwd, homedir, repo = REPO_ROOT, execPath = process.execPath } = {}) {
  const own = {};
  const receiver = {};
  let print = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--print') {
      print = true;
      continue;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const setting = RECEIVER_SETTINGS.find((candidate) => candidate.flag === name);
    if (!setting && !Object.hasOwn(OWN_OPTIONS, name)) {
      if (name === '--log-file') throw new RenderError('the log file is <log folder>/card-sync-receiver.log: choose the folder with --log-dir');
      throw new RenderError(`unknown option ${/^--?[a-z][a-z0-9-]{0,30}$/.test(name) ? name : '(unrecognized)'}; try --help`);
    }
    const value = eq === -1 ? argv[(index += 1)] : arg.slice(eq + 1);
    if (value === undefined || value === '') throw new RenderError(`${name} needs a value`);
    const target = setting ? receiver : own;
    const key = setting ? setting.key : OWN_OPTIONS[name];
    if (Object.hasOwn(target, key)) throw new RenderError(`${name} was given twice`);
    target[key] = value;
  }
  const absolute = (value) => {
    if (value === '~') return homedir;
    return value.startsWith('~/') ? P.join(homedir, value.slice(2)) : P.resolve(cwd, value);
  };
  const args = [];
  for (const setting of RECEIVER_SETTINGS) {
    const fromEnv = typeof env[setting.env] === 'string' && env[setting.env].trim() !== '' ? env[setting.env].trim() : undefined;
    const value = receiver[setting.key] ?? fromEnv;
    if (value !== undefined) args.push(setting.flag, PATH_SETTINGS.has(setting.key) ? absolute(value) : value);
  }
  const node = own.node ? absolute(own.node) : nodeOnPath(env.PATH) ?? execPath;
  const logDir = absolute(own.logDir ?? '~/Library/Logs/Holdr');
  const out = absolute(own.out ?? `~/Library/LaunchAgents/${LABEL}.plist`);
  // As the receiver compares folders: letter case ignored (~/holdr is ~/Holdr on a Mac), links resolved on the Mac itself.
  if (pathInside(logDir, repo, { platform: 'darwin' })) throw new RenderError('--log-dir must be outside the repository checkout');
  // The receiver checks its settings the same way when launchd starts it; better to hear about a mistake now.
  resolveConfig({
    argv: [...args, '--log-file', P.join(logDir, 'card-sync-receiver.log')], env: {}, platform: 'darwin', homedir, cwd: repo,
    repoRoot: repo, agentDir: P.join(repo, 'agents', 'card-sync'),
  });
  return { xml: renderPlist({ node, repo, logDir, args }), out, logDir, node, print, help: false };
}

/**
 * Creates the log folder (owner-only), then writes the LaunchAgent next to `out` (mode 0644), checks it with `lint`
 * when given, and only then renames it into place: an invalid file never replaces a working one.
 */
export function installPlist({ out, xml, logDir, lint = null }) {
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(logDir, 0o700);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const temp = `${out}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, xml, { mode: 0o644, flag: 'wx' });
    fs.chmodSync(temp, 0o644);
    lint?.(temp);
    fs.renameSync(temp, out);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** macOS's own property list check. */
export function plutilLint(file) {
  try {
    execFileSync('/usr/bin/plutil', ['-lint', file], { stdio: 'pipe' });
  } catch {
    throw new RenderError('plutil -lint did not accept the LaunchAgent; nothing was changed');
  }
}

const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

export function main(argv = process.argv.slice(2), {
  env = process.env, cwd = process.cwd(), homedir = os.homedir(), platform = process.platform, repo = REPO_ROOT,
  execPath = process.execPath, stdout = process.stdout, stderr = process.stderr,
} = {}) {
  try {
    // A LaunchAgent and its paths are macOS's: on Windows nothing here would make sense.
    if (platform === 'win32' && !argv.some((arg) => arg === '--help' || arg === '-h')) {
      throw new RenderError('this writes a macOS LaunchAgent: run it on the Mac');
    }
    const plan = planLaunchAgent({ argv, env, cwd, homedir, repo, execPath });
    if (plan.help) {
      stdout.write(USAGE);
      return 0;
    }
    if (plan.print) {
      stdout.write(plan.xml);
      return 0;
    }
    try {
      fs.accessSync(plan.node, fs.constants.X_OK);
    } catch {
      throw new RenderError('--node must be the full path of the node program (command -v node shows it)');
    }
    installPlist({ out: plan.out, xml: plan.xml, logDir: plan.logDir, lint: platform === 'darwin' ? plutilLint : null });
    stdout.write(`Wrote ${plan.out}${platform === 'darwin' ? ' (plutil -lint: OK)' : ''}.\n`
      + `The receiver logs to ${P.join(plan.logDir, 'card-sync-receiver.log')}.\n`
      + `Load it (the first command unloads an older one, if any):\n  launchctl bootout gui/$(id -u)/${LABEL} 2>/dev/null\n`
      + `  launchctl bootstrap gui/$(id -u) ${shellQuote(plan.out)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof RenderError || error instanceof ConfigError) {
      stderr.write(`render-plist: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = main();
