import fs from 'node:fs';
import path from 'node:path';

import { WebReleaseError } from '@finance-tracker/shared/web-release';

import { ControlError, EXIT, fail } from '../control/errors.js';
import { writePrivateFileAtomic } from '../control/files.js';
import {
  CONF_KEYS, applyHoldrConf, locateHoldrConf, parseHoldrConf, readHoldrConf, type ConfKey, type ConfValues,
} from '../control/holdrConf.js';
import { REPO_ROOT, isCanonicalAbsolute } from '../control/paths.js';
import { resolveIngressConfig } from '../ingress/config.js';
import type { Io } from './controlCommon.js';

export const SET_MODE_USAGE = `Usage: npm run holdr-ingress -- set-mode <dist|local|vite> [options]

  dist  [--release <digest>] [--origin <https://name>] [--socket <path>]
        production; origin, socket and device setting come from holdr.conf.dist (saved when dist was left) unless given
  local [--release <digest>]
        break-glass: the release on http://127.0.0.1:8888, never verified ingress, no device routes
  vite  --legacy-rollback
        the guarded legacy Vite rollback; only while holdr.conf carries HOLDR_LEGACY_VITE_ROLLBACK=1 (before AL1 sign-off)

Rewrites holdr.conf atomically with the complete key set of the target mode (validated with the API's rules), keeps the
previous dist file as holdr.conf.dist, takes no lifecycle lock and restarts nothing: run the start script afterwards.
`;

/** The order keys are written in; mode-independent keys first. */
const KEY_ORDER: readonly ConfKey[] = [
  'HOLDR_WEB_MODE', 'HOLDR_PUBLIC_ORIGIN', 'HOLDR_WEB_RELEASE', 'HOLDR_DATA_DIR', 'HOLDR_CONTROL_DIR', 'HOLDR_SERVE_SOCKET',
  'HOLDR_TAILSCALE_CLI', 'HOLDR_DEVICE_API', 'HOLDR_INGRESS_PORT', 'HOLDR_LEGACY_VITE_ROLLBACK', 'HOLDR_NATIVE_COMMIT',
  'HOLDR_NATIVE_MANIFEST', 'HOLDR_METALS_PRICES', 'HOLDR_METALS_FUNGIBLE', 'HOLDR_METALS_ESTIMATE_UNMATCHED',
];

export type Mode = 'dist' | 'local' | 'vite';

export interface SetModeOptions {
  readonly release?: string;
  readonly origin?: string;
  readonly socket?: string;
  readonly legacyRollback?: boolean;
}

/**
 * The complete key set of `target` (design §3.3, §7.1) from the current file and `holdr.conf.dist`: the mode-independent keys
 * (data and control dirs, the legacy key, the native pins) come from the current file only, which is authoritative: a key
 * removed there stays removed (above all `HOLDR_LEGACY_VITE_ROLLBACK`, which AL1 sign-off deletes; B-D18 as revised after
 * the B2 review). The companion supplies only what leaving a mode dropped: `dist` restores origin, socket and the device
 * setting from it (or `--origin` / `--socket`), and the release and the Tailscale CLI when the current file has none; `local`
 * sets `HOLDR_DEVICE_API=0` and drops every dist-only key; `vite` keeps neither a release nor the Tailscale CLI (A's K1 forbids
 * both in vite, deviation B-D18): the start script publishes with its own CLI, and `set-mode dist` brings both back. The
 * metals prices switch, `HOLDR_METALS_PRICES` (O93), is mode-independent too: every mode keeps it from the current file,
 * and so do the owner's metals assignment policy, `HOLDR_METALS_FUNGIBLE`, and estimate switch,
 * `HOLDR_METALS_ESTIMATE_UNMATCHED`.
 */
export function targetValues(target: Mode, current: ConfValues, companion: ConfValues | null, options: SetModeOptions): Record<string, string> {
  const pick = (key: 'HOLDR_WEB_RELEASE' | 'HOLDR_TAILSCALE_CLI'): string | undefined => current[key] ?? companion?.[key];
  const out: Partial<Record<ConfKey, string>> = { HOLDR_WEB_MODE: target };
  for (const key of ['HOLDR_DATA_DIR', 'HOLDR_CONTROL_DIR', 'HOLDR_LEGACY_VITE_ROLLBACK', 'HOLDR_NATIVE_COMMIT', 'HOLDR_NATIVE_MANIFEST',
    'HOLDR_METALS_PRICES', 'HOLDR_METALS_FUNGIBLE', 'HOLDR_METALS_ESTIMATE_UNMATCHED'] as const) {
    const value = current[key];
    if (value !== undefined) out[key] = value;
  }
  if (!out.HOLDR_DATA_DIR || !out.HOLDR_CONTROL_DIR) fail('E0I_CONFIG_FILE', 'holdr.conf must name HOLDR_DATA_DIR and HOLDR_CONTROL_DIR');
  if (target === 'vite') {
    if (!options.legacyRollback) fail('E0I_USAGE', 'vite needs --legacy-rollback', EXIT.usage);
    if (current.HOLDR_LEGACY_VITE_ROLLBACK !== '1') fail('E0I_TCP_TARGET_RETIRED', 'HOLDR_LEGACY_VITE_ROLLBACK=1 was removed at AL1 sign-off');
    return out as Record<string, string>;
  }
  const release = options.release ?? pick('HOLDR_WEB_RELEASE');
  if (!release) fail('E0I_RELEASE_CONFIG', 'no release: give --release <digest>');
  out.HOLDR_WEB_RELEASE = release;
  const cli = pick('HOLDR_TAILSCALE_CLI');
  if (cli !== undefined) out.HOLDR_TAILSCALE_CLI = cli;
  if (target === 'local') {
    out.HOLDR_DEVICE_API = '0';
    if (current.HOLDR_INGRESS_PORT !== undefined) out.HOLDR_INGRESS_PORT = current.HOLDR_INGRESS_PORT;
    return out as Record<string, string>;
  }
  const fromDist = current.HOLDR_WEB_MODE === 'dist' ? current : companion ?? {};
  const origin = options.origin ?? fromDist.HOLDR_PUBLIC_ORIGIN;
  const socket = options.socket ?? fromDist.HOLDR_SERVE_SOCKET;
  if (!origin || !socket) fail('E0I_CONFIG_FILE', 'dist needs the origin and socket: holdr.conf.dist, or --origin and --socket');
  out.HOLDR_PUBLIC_ORIGIN = origin;
  out.HOLDR_SERVE_SOCKET = socket;
  out.HOLDR_DEVICE_API = fromDist.HOLDR_DEVICE_API ?? '0';
  if (!out.HOLDR_TAILSCALE_CLI) fail('E0I_CONFIG_FILE', 'dist needs HOLDR_TAILSCALE_CLI (from holdr.conf or holdr.conf.dist)');
  return out as Record<string, string>;
}

export function serializeConf(values: Record<string, string>, comment: string): string {
  const lines = [`# Holdr start configuration. KEY=VALUE, one per line, no quotes, no spaces around "=".`, `# ${comment}`];
  for (const key of KEY_ORDER) if (values[key] !== undefined) lines.push(`${key}=${values[key]}`);
  for (const key of Object.keys(values)) if (!(CONF_KEYS as readonly string[]).includes(key)) fail('E0I_INTERNAL', key);
  return `${lines.join('\n')}\n`;
}

/** The API's rules for the target mode (K1–K10) on exactly the file that will be written (§3.3: "validated with the parser"). */
export function validateTarget(target: Mode, text: string, file: string, repoRoot = REPO_ROOT): void {
  const values = parseHoldrConf(text, path.basename(file));
  const env = applyHoldrConf({}, { path: file, values }, repoRoot);
  const config = resolveIngressConfig(target === 'vite' ? { ...env } : { ...env, NODE_ENV: 'production' });
  if ((config.mode === 'dev' ? 'vite' : config.mode) !== target) fail('E0I_MODE_INVALID');
}

function parseArgs(argv: readonly string[]): { target: Mode; options: SetModeOptions } {
  const args = [...argv];
  const target = args.shift();
  if (target !== 'dist' && target !== 'local' && target !== 'vite') fail('E0I_USAGE', SET_MODE_USAGE.trim(), EXIT.usage);
  const options: { release?: string; origin?: string; socket?: string; legacyRollback?: boolean } = {};
  while (args.length) {
    const name = args.shift()!;
    if (name === '--legacy-rollback' && target === 'vite' && !options.legacyRollback) { options.legacyRollback = true; continue; }
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) fail('E0I_USAGE', `${name} needs a value`, EXIT.usage);
    if (name === '--release' && target !== 'vite' && options.release === undefined) options.release = value;
    else if (name === '--origin' && target === 'dist' && options.origin === undefined) options.origin = value;
    else if (name === '--socket' && target === 'dist' && options.socket === undefined) options.socket = value;
    else fail('E0I_USAGE', `unexpected argument ${name} for ${target}`, EXIT.usage);
  }
  return { target: target as Mode, options };
}

/**
 * `holdr-ingress set-mode` (design §3.3, R2-7): the only supported way to change the mode. Reads the current holdr.conf
 * strictly, builds the complete key set of the target mode, validates it with the parser and A's rules, saves the current
 * `dist` file as `holdr.conf.dist` when leaving `dist`, and replaces holdr.conf atomically (private temporary file, fsync,
 * rename, directory fsync; deviation B-D20: a unique temporary name instead of a fixed `holdr.conf.next`). No lock, no restart.
 */
export function runSetMode(argv: readonly string[], env: NodeJS.ProcessEnv, io: Io, now = () => new Date()): number {
  try {
    const { target, options } = parseArgs(argv);
    const location = locateHoldrConf(env);
    if (location.kind !== 'file') fail('E0I_CONFIG_FILE', 'no holdr.conf to change (create it as in docs/deployment.md first)');
    const file = location.path;
    if (!fs.existsSync(file)) fail('E0I_CONFIG_FILE', `${file} does not exist`);
    const current = readHoldrConf(file).values;
    const companionFile = path.join(path.dirname(file), 'holdr.conf.dist');
    const companion = fs.existsSync(companionFile) ? readHoldrConf(companionFile).values : null;
    const currentMode = (current.HOLDR_WEB_MODE ?? 'vite') as Mode;
    const values = targetValues(target, current, companion, options);
    for (const [key, value] of Object.entries(values)) {
      if ((key === 'HOLDR_SERVE_SOCKET' || key === 'HOLDR_TAILSCALE_CLI' || key.endsWith('_DIR')) && !isCanonicalAbsolute(value)) {
        fail('E0I_CONFIG_FILE', `${key} must be an absolute path`);
      }
    }
    const text = serializeConf(values, `written by holdr-ingress set-mode ${target} at ${now().toISOString()}`);
    validateTarget(target, text, file);
    const dir = path.dirname(file);
    if (currentMode === 'dist' && target !== 'dist') {
      // The way back: the last valid dist file, exactly as it was.
      const saved = fs.readFileSync(file, 'utf8');
      validateTarget('dist', saved, companionFile);
      writePrivateFileAtomic(dir, 'holdr.conf.dist', saved);
    }
    writePrivateFileAtomic(dir, path.basename(file), text);
    const release = values.HOLDR_WEB_RELEASE ? ` (release ${values.HOLDR_WEB_RELEASE.slice(0, 12)})` : '';
    io.stdout.write(`holdr.conf: ${currentMode} -> ${target}${release}. Run the start script to apply it.\n`);
    if (target === 'local') io.stdout.write('BREAK-GLASS: local only, ingress not verified; other devices get no Holdr until dist is restored.\n');
    return 0;
  } catch (error) {
    const code = error instanceof WebReleaseError ? error.code : 'E0I_INTERNAL';
    const detail = error instanceof ControlError && error.detail ? ` (${error.detail})` : '';
    io.stderr.write(`set-mode refused: ${code}${detail}; holdr.conf unchanged\n`);
    return error instanceof ControlError ? error.exitCode : 1;
  }
}
