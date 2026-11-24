import { WebReleaseError } from './webRelease/manifest.js';

/**
 * Holdr's legacy LAN modes were removed: plain HTTP to the local network (`HOLDR_LAN_HTTP=1`, the macOS start script's
 * vite mode) and the LAN HTTPS gateway with its own certificate authority (`HOLDR_LAN_HTTPS_*`). Other devices reach
 * Holdr over HTTPS through Tailscale Serve. Their settings are refused by name (`E0I_LAN_REMOVED`), never ignored, so a
 * setup that still asks for one stops with a clear message instead of quietly serving less than it expects.
 */
export const REMOVED_LAN_SETTINGS = [
  'HOLDR_LAN_HTTP',
  'HOLDR_LAN_HTTPS_IP', 'HOLDR_LAN_HTTPS_CIDR', 'HOLDR_LAN_HTTPS_PORT',
  'HOLDR_LAN_HTTPS_CERT', 'HOLDR_LAN_HTTPS_KEY', 'HOLDR_LAN_HTTPS_CA',
] as const;

/**
 * The first removed LAN setting `env` holds, or null. `HOLDR_LAN_HTTP` unset, empty or `0` asks for no LAN mode, which is
 * what Holdr does, and is accepted; any other value of it, and any value of a `HOLDR_LAN_HTTPS_*` setting, is not.
 */
export function removedLanSetting(env: Readonly<Record<string, string | undefined>>): string | null {
  for (const name of REMOVED_LAN_SETTINGS) {
    const value = env[name];
    if (value === undefined || (name === 'HOLDR_LAN_HTTP' && (value === '' || value === '0'))) continue;
    return name;
  }
  return null;
}

/** Why the removed setting `name` is refused and what to do instead. It names the setting, never its value. */
export function removedLanMessage(name: string): string {
  return `${name} is no longer supported: Holdr's LAN modes were removed. Remove the setting; other devices reach Holdr `
    + 'over HTTPS through Tailscale Serve (docs/deployment.md)';
}

/** @deprecated The LAN HTTPS gateway was removed. Kept only until the last callers written for it are gone. */
export interface LanHttpsConfig {
  readonly ip: string;
  readonly origin: string;
}

/**
 * @deprecated The LAN HTTPS gateway was removed. Null when `env` holds no removed LAN setting; otherwise throws
 * `E0I_LAN_REMOVED` naming the setting. Kept only until the last callers written for the gateway are gone.
 */
export function resolveLanHttpsConfig(env: Readonly<Record<string, string | undefined>>): LanHttpsConfig | null {
  const name = removedLanSetting(env);
  if (name === null) return null;
  const error = new WebReleaseError('E0I_LAN_REMOVED');
  error.message = `E0I_LAN_REMOVED: ${removedLanMessage(name)}`;
  throw error;
}