import { isIP } from 'node:net';
import path from 'node:path';
import { SHA256_HEX, WebReleaseError } from '@finance-tracker/shared/web-release';

import { refuseRemovedLanSettings } from '../control/holdrConf.js';
import { ControlError } from '../control/errors.js';
import { isLoopbackAddress } from './network.js';

export type ReleaseIngressConfig = {
  readonly mode: 'dist' | 'local';
  readonly port: number;
  readonly releaseDir: string;
  readonly releaseDigest: string;
  readonly dataDir: string;
  readonly controlDir: string;
  readonly allowedOrigins: readonly string[];
} & (
  | { readonly mode: 'dist'; readonly publicOrigin: string; readonly socketPath: string }
  | { readonly mode: 'local'; readonly ingressPort: number }
);
export type IngressConfig = { readonly mode: 'dev'; readonly host: string; readonly port: number } | ReleaseIngressConfig;

const fail = (code: string): never => { throw new WebReleaseError(code); };
const present = (env: NodeJS.ProcessEnv, key: string) => env[key] !== undefined;

function port(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1024 || Number(value) > 65535) return fail('E0I_PORTS');
  return Number(value);
}

function publicOrigin(value: string | undefined): string {
  if (!value) return fail('E0I_PUBLIC_ORIGIN');
  try {
    const url = new URL(value);
    const dns = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    if (url.protocol === 'https:' && url.origin === value && !url.port && !isIP(url.hostname)
      && url.hostname.length <= 253 && dns.test(url.hostname)) return value;
  } catch { /* reported as the same value-free configuration error */ }
  return fail('E0I_PUBLIC_ORIGIN');
}

export function resolveIngressConfig(env: NodeJS.ProcessEnv): IngressConfig {
  // In every mode: the removed LAN modes' settings (HOLDR_LAN_HTTP=1, HOLDR_LAN_HTTPS_*) stop the start (E0I_LAN_REMOVED).
  refuseRemovedLanSettings(env);
  const mode = env.HOLDR_WEB_MODE ?? 'vite';
  if (!['vite', 'dist', 'local'].includes(mode)) return fail('E0I_MODE_INVALID');
  if (mode !== 'dist' && present(env, 'HOLDR_SERVE_SOCKET')) return fail('E0I_MODE_MISMATCH');
  if (mode !== 'local' && present(env, 'HOLDR_INGRESS_PORT')) return fail('E0I_MODE_MISMATCH');
  if (mode === 'vite') {
    if (['HOLDR_WEB_RELEASE_DIR', 'HOLDR_WEB_RELEASE_DIGEST', 'HOLDR_TAILSCALE_CLI'].some((key) => present(env, key))) {
      return fail('E0I_MODE_MISMATCH');
    }
    if (env.HOLDR_DEVICE_API !== undefined && env.HOLDR_DEVICE_API !== '0') return fail('E0I_DEVICE_API');
    if (present(env, 'HOLDR_INGRESS_DIAG')) return fail('E0I_DIAG');
    // Plain HTTP, so on this computer only, as the release modes require below (E0I_BIND): a loopback address or localhost.
    const host = env.HOLDR_HOST?.trim() || '127.0.0.1';
    if (host.toLowerCase() !== 'localhost' && !isLoopbackAddress(host)) {
      throw new ControlError('E0I_BIND', 1, 'HOLDR_HOST must be 127.0.0.1, ::1 or localhost');
    }
    return Object.freeze({ mode: 'dev', host, port: Number(env.PORT ?? 4000) });
  }
  if (mode === 'local' && present(env, 'HOLDR_PUBLIC_ORIGIN')) return fail('E0I_MODE_MISMATCH');
  if (env.NODE_ENV !== 'production') return fail('E0I_NODE_ENV');
  if (env.HOLDR_HOST !== undefined && env.HOLDR_HOST !== '127.0.0.1') return fail('E0I_BIND');
  const localPort = port(env.PORT, 4000);
  const releaseDir = env.HOLDR_WEB_RELEASE_DIR;
  const releaseDigest = env.HOLDR_WEB_RELEASE_DIGEST;
  if (!releaseDir || !path.isAbsolute(releaseDir) || !releaseDigest || !SHA256_HEX.test(releaseDigest)) return fail('E0I_RELEASE_CONFIG');
  const dataDir = env.HOLDR_DATA_DIR;
  const controlDir = env.HOLDR_CONTROL_DIR;
  if (!dataDir || !path.isAbsolute(dataDir)) return fail('E0I_DATA_DIR_UNSET');
  if (!controlDir || !path.isAbsolute(controlDir)) return fail('E0I_CONTROL_DIR_UNSET');
  if (env.HOLDR_DEVICE_API !== undefined && env.HOLDR_DEVICE_API !== '0' && !(mode === 'dist' && env.HOLDR_DEVICE_API === '1')) {
    return fail('E0I_DEVICE_API');
  }
  if (env.HOLDR_INGRESS_DIAG !== undefined && (env.HOLDR_INGRESS_DIAG !== '1' || !/^[0-9a-f]{32}$/.test(env.HOLDR_E2E_RUN_ID ?? ''))) {
    return fail('E0I_DIAG');
  }
  const common = { port: localPort, releaseDir, releaseDigest, dataDir, controlDir };
  if (mode === 'dist') {
    const origin = publicOrigin(env.HOLDR_PUBLIC_ORIGIN);
    if (env.WEB_ORIGIN !== undefined && env.WEB_ORIGIN !== origin) return fail('E0I_WEB_ORIGIN');
    const socketPath = env.HOLDR_SERVE_SOCKET;
    if (!socketPath || !path.isAbsolute(socketPath) || path.normalize(socketPath) !== socketPath
      || Buffer.byteLength(socketPath) > 100 || /[\0\r\n]/.test(socketPath)) return fail('E0I_SOCKET_PATH');
    return Object.freeze({ ...common, mode, publicOrigin: origin, socketPath, allowedOrigins: Object.freeze([origin]) });
  }
  const ingressPort = port(env.HOLDR_INGRESS_PORT, 8888);
  if (ingressPort === localPort) return fail('E0I_PORTS');
  const allowedOrigins = [`http://127.0.0.1:${ingressPort}`, `http://localhost:${ingressPort}`];
  if (env.WEB_ORIGIN !== undefined && env.WEB_ORIGIN !== allowedOrigins.join(',')) return fail('E0I_WEB_ORIGIN');
  return Object.freeze({ ...common, mode: 'local', ingressPort, allowedOrigins: Object.freeze(allowedOrigins) });
}
