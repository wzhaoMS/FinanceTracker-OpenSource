import fs from 'node:fs';
import path from 'node:path';

import { SHA256_HEX, SOURCE_COMMIT } from '@finance-tracker/shared/web-release';
import { REMOVED_LAN_SETTINGS, removedLanMessage, removedLanSetting } from '@finance-tracker/shared/lan-https';

import { fail } from './errors.js';
import { readPrivateFile } from './files.js';
import { REPO_ROOT, isCanonicalAbsolute, releaseDirFor } from './paths.js';
import { parseMetalsEstimateUnmatched, parseMetalsFungible } from '../services/metalsRead/policy.js';

/**
 * `holdr.conf` (design §8.1, §7.1): the start configuration every Holdr process reads, so neither the production mode nor
 * the data and control dirs depend on how a process was started. KEY=VALUE lines, parsed, never sourced.
 *
 * `HOLDR_NATIVE_COMMIT` / `HOLDR_NATIVE_MANIFEST` are B deviation B-D1: A2's socket provider requires an externally pinned
 * native manifest, and the deploy record that pins the release (`HOLDR_WEB_RELEASE`) pins the native reader the same way.
 *
 * `HOLDR_METALS_PRICES` turns on the Gold page's daily spot closes: `1` fetches, `0` (or no line) doesn't, and any other
 * value is refused. It is a file key so production, whose start script gives the API a clean environment, turns prices on
 * with one line here and a restart; the API reads it from the effective environment like every other key (index.ts).
 * `HOLDR_METALS_FUNGIBLE`, the owner's assignment policy, is a file key for the same reason: a comma list of distinct
 * metals (`XAU`, `XAU,XAG`; services/metalsRead/policy.ts) whose units are assigned oldest first across forms; no line
 * is metals-assignment-v1, and any other value is refused. `HOLDR_METALS_ESTIMATE_UNMATCHED`, the owner's estimate
 * switch, is one too, of the same grammar: the metals whose sold units with no recorded purchase take an estimated cost
 * (`metals-estimate-nearest-v1`); no line estimates nothing, and any other value is refused.
 *
 * The removed LAN modes' settings (`HOLDR_LAN_HTTP`, `HOLDR_LAN_HTTPS_*`; packages/shared/src/lanHttps.ts) are refused by
 * name, here as a line and in the environment, never ignored (E0I_LAN_REMOVED).
 */
export const CONF_KEYS = [
  'HOLDR_WEB_MODE', 'HOLDR_PUBLIC_ORIGIN', 'HOLDR_WEB_RELEASE', 'HOLDR_DATA_DIR', 'HOLDR_CONTROL_DIR', 'HOLDR_SERVE_SOCKET',
  'HOLDR_TAILSCALE_CLI', 'HOLDR_DEVICE_API', 'HOLDR_INGRESS_PORT', 'HOLDR_LEGACY_VITE_ROLLBACK', 'HOLDR_NATIVE_COMMIT',
  'HOLDR_NATIVE_MANIFEST', 'HOLDR_METALS_PRICES', 'HOLDR_METALS_FUNGIBLE', 'HOLDR_METALS_ESTIMATE_UNMATCHED',
] as const;
export type ConfKey = typeof CONF_KEYS[number];
export type ConfValues = Readonly<Partial<Record<ConfKey, string>>>;

const portValue = (value: string) => /^[1-9][0-9]{3,4}$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535;
const RULES: Record<ConfKey, (value: string) => boolean> = {
  HOLDR_WEB_MODE: (value) => ['dist', 'local', 'vite'].includes(value),
  HOLDR_PUBLIC_ORIGIN: (value) => /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value),
  HOLDR_WEB_RELEASE: (value) => SHA256_HEX.test(value),
  HOLDR_DATA_DIR: isCanonicalAbsolute,
  HOLDR_CONTROL_DIR: isCanonicalAbsolute,
  HOLDR_SERVE_SOCKET: isCanonicalAbsolute,
  HOLDR_TAILSCALE_CLI: isCanonicalAbsolute,
  HOLDR_DEVICE_API: (value) => value === '0' || value === '1',
  HOLDR_INGRESS_PORT: portValue,
  HOLDR_LEGACY_VITE_ROLLBACK: (value) => value === '1',
  HOLDR_NATIVE_COMMIT: (value) => SOURCE_COMMIT.test(value),
  HOLDR_NATIVE_MANIFEST: (value) => SHA256_HEX.test(value),
  HOLDR_METALS_PRICES: (value) => value === '0' || value === '1',
  HOLDR_METALS_FUNGIBLE: (value) => parseMetalsFungible(value) !== null,
  HOLDR_METALS_ESTIMATE_UNMATCHED: (value) => parseMetalsEstimateUnmatched(value) !== null,
};

/** Every HOLDR_* name some Holdr process reads; anything else is logged by name (never refused, §7.1). */
export const KNOWN_HOLDR_NAMES: ReadonlySet<string> = new Set([
  ...CONF_KEYS, ...REMOVED_LAN_SETTINGS, 'HOLDR_CONFIG', 'HOLDR_WEB_RELEASE_DIR', 'HOLDR_WEB_RELEASE_DIGEST', 'HOLDR_HOST',
  'HOLDR_INGRESS_DIAG', 'HOLDR_E2E_RUN_ID', 'HOLDR_SERVICE_TOKEN_FILE', 'HOLDR_LIFECYCLE_LEASE', 'HOLDR_LIFECYCLE_LEASE_FD',
  'HOLDR_LIFECYCLE_LOCK_PATH', 'HOLDR_LAUNCHD', 'HOLDR_ROOT', 'HOLDR_LOG_DIR', 'HOLDR_TAILSCALE',
  'HOLDR_TAILSCALE_WAIT', 'HOLDR_API_PORT', 'HOLDR_WEB_PORT', 'HOLDR_BRIDGE_PORT', 'HOLDR_BRIDGE_RUNTIME',
  'HOLDR_ATTEST_WAIT', 'HOLDR_INTRADAY_PRICES', 'HOLDR_API_TARGET', 'HOLDR_TAILNET_HOSTNAME', 'HOLDR_TAILNET_ADDRESSES',
  'HOLDR_NODE', 'HOLDR_EXTENSION_ORIGIN',
  // Stored market data only (services/storedMarketData.ts), which the demo (`npm run demo`) sets.
  'HOLDR_MARKET_DATA',
  // The experimental card-sync receiver's settings (agents/card-sync), which a shared environment may hold.
  'HOLDR_SYNC_PORT', 'HOLDR_APP_URL', 'HOLDR_WEB_URL', 'HOLDR_TOKEN_FILE', 'HOLDR_IMPORTS', 'HOLDR_EXTENSION_DIR',
  'HOLDR_EXTENSION_ID', 'HOLDR_SYNC_HISTORY', 'HOLDR_OWNER_LABELS', 'HOLDR_SYNC_LOG',
]);

export const CONF_FILE_LIMIT = 16 * 1024;
export const defaultConfPath = (home: string) => path.join(home, 'Library/Application Support/Holdr/holdr.conf');

export function parseHoldrConf(text: string, label = 'holdr.conf'): ConfValues {
  if (text.includes('\r') || text.includes('\0')) fail('E0I_CONFIG_FILE', `${label}: CR or NUL`);
  const values: Partial<Record<ConfKey, string>> = {};
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  lines.forEach((line, index) => {
    if (line === '' || line.startsWith('#')) return;
    const match = /^(HOLDR_[A-Z_]+)=(.*)$/.exec(line);
    const where = `${label} line ${index + 1}`;
    if (!match) return fail('E0I_CONFIG_FILE', `${where}: not KEY=VALUE`);
    const key = match[1] as ConfKey;
    if ((REMOVED_LAN_SETTINGS as readonly string[]).includes(key)) return fail('E0I_LAN_REMOVED', `${where}: ${removedLanMessage(key)}`);
    if (!(CONF_KEYS as readonly string[]).includes(key)) return fail('E0I_CONFIG_FILE', `${where}: ${match[1]} is not allowed`);
    if (Object.hasOwn(values, key)) return fail('E0I_CONFIG_FILE', `${where}: ${key} repeated`);
    if (!RULES[key](match[2])) return fail('E0I_CONFIG_FILE', `${where}: invalid ${key}`);
    values[key] = match[2];
  });
  return Object.freeze(values);
}

export interface HoldrConf {
  readonly path: string;
  readonly values: ConfValues;
}

/** Regular file, owned by the user, mode 0600, one link (else E0I_CONFIG_FILE); then the strict parser. */
export function readHoldrConf(file: string): HoldrConf {
  const bytes = readPrivateFile(file, { code: 'E0I_CONFIG_FILE', limit: CONF_FILE_LIMIT })!;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail('E0I_CONFIG_FILE', `${file}: not UTF-8`);
  }
  return Object.freeze({ path: file, values: parseHoldrConf(text, path.basename(file)) });
}

export type ConfLocation =
  | { readonly kind: 'none'; readonly reason: 'disabled' | 'absent' }
  | { readonly kind: 'file'; readonly path: string; readonly explicit: boolean };

/**
 * `HOLDR_CONFIG` names the file, or `none` (only with `HOLDR_E2E_RUN_ID`, §7.1). Unset: the default path under `HOME` when
 * that file exists. A disposable stack that leaves `HOLDR_CONFIG` unset while the default file exists is refused
 * (deviation B-D4): it must never take part in production's configuration or lifecycle protocol.
 * Only `env.HOME` is used, never the password database, so in-process callers that pass an explicit environment are isolated.
 */
export function locateHoldrConf(env: NodeJS.ProcessEnv): ConfLocation {
  const setting = env.HOLDR_CONFIG;
  const disposable = Boolean(env.HOLDR_E2E_RUN_ID?.trim());
  if (setting === 'none') {
    if (!disposable) fail('E0I_CONFIG_FILE', 'HOLDR_CONFIG=none needs HOLDR_E2E_RUN_ID');
    return { kind: 'none', reason: 'disabled' };
  }
  if (setting !== undefined) {
    if (!isCanonicalAbsolute(setting)) fail('E0I_CONFIG_FILE', 'HOLDR_CONFIG is not an absolute path');
    return { kind: 'file', path: setting, explicit: true };
  }
  const home = env.HOME;
  if (!home || !isCanonicalAbsolute(home)) return { kind: 'none', reason: 'absent' };
  const file = defaultConfPath(home);
  try {
    fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none', reason: 'absent' };
    return fail('E0I_CONFIG_FILE', file);
  }
  if (disposable) fail('E0I_CONFIG_FILE', 'a disposable stack must set HOLDR_CONFIG=none');
  return { kind: 'file', path: file, explicit: false };
}

/**
 * The environment the process acts on: every key the file sets must be absent from the environment or equal to it, never
 * different (E0I_CONFIG_FILE "conflict"). `HOLDR_WEB_RELEASE=<D>` stands for `HOLDR_WEB_RELEASE_DIGEST=<D>` and
 * `HOLDR_WEB_RELEASE_DIR=<repo>/apps/web/releases/<first 12 hex>`, the directory the start script derives (§8.2 step 3).
 * With a file, `vite` additionally needs `HOLDR_LEGACY_VITE_ROLLBACK=1` (§7.1, §8.3). A removed LAN setting in the
 * environment is refused first (E0I_LAN_REMOVED); the file can hold none (parseHoldrConf).
 */
export function applyHoldrConf(env: NodeJS.ProcessEnv, conf: HoldrConf | null, repoRoot = REPO_ROOT): Readonly<NodeJS.ProcessEnv> {
  refuseRemovedLanSettings(env);
  const effective: NodeJS.ProcessEnv = { ...env };
  if (!conf) return Object.freeze(effective);
  const conflict = (key: string) => fail('E0I_CONFIG_FILE', `conflict: ${key} differs between ${conf.path} and the environment`);
  for (const key of CONF_KEYS) {
    const value = conf.values[key];
    if (value === undefined) continue;
    if (key === 'HOLDR_WEB_RELEASE') {
      const dir = releaseDirFor(value, repoRoot);
      if (env.HOLDR_WEB_RELEASE !== undefined && env.HOLDR_WEB_RELEASE !== value) conflict('HOLDR_WEB_RELEASE');
      if (env.HOLDR_WEB_RELEASE_DIGEST !== undefined && env.HOLDR_WEB_RELEASE_DIGEST !== value) conflict('HOLDR_WEB_RELEASE_DIGEST');
      if (env.HOLDR_WEB_RELEASE_DIR !== undefined && env.HOLDR_WEB_RELEASE_DIR !== dir) conflict('HOLDR_WEB_RELEASE_DIR');
      effective.HOLDR_WEB_RELEASE_DIGEST = value;
      effective.HOLDR_WEB_RELEASE_DIR = dir;
      delete effective.HOLDR_WEB_RELEASE;
      continue;
    }
    if (env[key] !== undefined && env[key] !== value) conflict(key);
    effective[key] = value;
  }
  const mode = effective.HOLDR_WEB_MODE ?? 'vite';
  if (mode === 'vite' && effective.HOLDR_LEGACY_VITE_ROLLBACK !== '1') {
    fail('E0I_CONFIG_FILE', `${conf.path}: vite with a holdr.conf needs HOLDR_LEGACY_VITE_ROLLBACK=1`);
  }
  return Object.freeze(effective);
}

/** Refuses a removed LAN setting in `env` by name (E0I_LAN_REMOVED), with what to do instead; `HOLDR_LAN_HTTP=0` passes. */
export function refuseRemovedLanSettings(env: Readonly<NodeJS.ProcessEnv>): void {
  const name = removedLanSetting(env);
  if (name !== null) fail('E0I_LAN_REMOVED', removedLanMessage(name));
}

export interface Configuration {
  readonly location: ConfLocation;
  readonly conf: HoldrConf | null;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export function loadConfiguration(env: NodeJS.ProcessEnv, options: { repoRoot?: string } = {}): Configuration {
  const location = locateHoldrConf(env);
  const conf = location.kind === 'file' ? readHoldrConf(location.path) : null;
  return Object.freeze({ location, conf, env: applyHoldrConf(env, conf, options.repoRoot) });
}

/** Names only: unknown HOLDR_* variables are logged, never their values. */
export function unknownHoldrNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((name) => name.startsWith('HOLDR_') && !name.startsWith('HOLDR_TEST_')
    && !KNOWN_HOLDR_NAMES.has(name)).sort();
}

/**
 * `holdr.conf.dist` next to `holdr.conf`: the last valid `dist` file, saved by `set-mode` when leaving `dist` (§3.3). In
 * `local` it supplies the Serve expectations (public host, socket path) the exposure checks compare against (deviation B-D2).
 */
export function readDistCompanion(conf: HoldrConf | null): { publicOrigin: string; socketPath: string } {
  if (!conf) return fail('E0I_CONFIG_FILE', 'local mode with HOLDR_TAILSCALE_CLI needs holdr.conf and holdr.conf.dist');
  const file = path.join(path.dirname(conf.path), 'holdr.conf.dist');
  const dist = readHoldrConf(file);
  const { HOLDR_WEB_MODE: mode, HOLDR_PUBLIC_ORIGIN: publicOrigin, HOLDR_SERVE_SOCKET: socketPath } = dist.values;
  if (mode !== 'dist' || !publicOrigin || !socketPath) return fail('E0I_CONFIG_FILE', `${file}: not a complete dist file`);
  return { publicOrigin, socketPath };
}
