import fs from 'node:fs';
import path from 'node:path';

import { WebReleaseError } from '@finance-tracker/shared/web-release';

import { resolveIngressConfig } from '../ingress/config.js';
import { configuredControlDir } from './controlDir.js';
import { ControlError, EXIT, fail } from './errors.js';
import { applyHoldrConf, locateHoldrConf, readHoldrConf, type HoldrConf } from './holdrConf.js';
import { MARKER_FILE, readMarker } from './lifecycle.js';
import { isCanonicalAbsolute, releaseDirFor } from './paths.js';

/**
 * The start script's configuration (design §8.1, §8.2 steps 3–4; K5, K26): holdr.conf through the same strict reader as the
 * API and every CLI, resolved against the tree being started (`--root`), validated with A's rules for the mode, plus the
 * lifecycle marker. `scripts/lib/start-config.ts` prints the result as NUL-separated `key\0value\0` pairs for bash.
 */
export interface StartConfig {
  readonly mode: 'dist' | 'local' | 'vite';
  readonly config: string;
  readonly origin: string;
  readonly digest: string;
  readonly releaseDir: string;
  readonly dataDir: string;
  readonly controlDir: string;
  readonly socket: string;
  readonly cli: string;
  readonly deviceApi: string;
  readonly ingressPort: string;
  readonly legacy: string;
  readonly marker: string;
  readonly distOrigin: string;
  readonly distSocket: string;
  readonly nativeCommit: string;
  readonly nativeManifest: string;
}

function readDistCompanionIfPresent(conf: HoldrConf | null): { origin: string; socket: string } {
  if (!conf) return { origin: '', socket: '' };
  const file = path.join(path.dirname(conf.path), 'holdr.conf.dist');
  if (!fs.existsSync(file)) return { origin: '', socket: '' };
  const values = readHoldrConf(file).values;
  return { origin: values.HOLDR_PUBLIC_ORIGIN ?? '', socket: values.HOLDR_SERVE_SOCKET ?? '' };
}

function markerState(controlDir: string | null): string {
  if (!controlDir) return 'none';
  if (!fs.existsSync(path.join(controlDir, MARKER_FILE))) return 'missing';
  const current = readMarker(controlDir);
  if (!current) return 'invalid';
  return current.state === 'normal' ? 'normal' : `maintenance:${current.reason}`;
}

export function startConfig(rawEnv: NodeJS.ProcessEnv, root: string, options: { webPort: number; apiPort: number }): StartConfig {
  if (!isCanonicalAbsolute(root)) fail('E0I_USAGE', '--root must be an absolute path', EXIT.usage);
  const location = locateHoldrConf(rawEnv);
  const conf = location.kind === 'file' ? readHoldrConf(location.path) : null;
  // §8.3: with a holdr.conf, vite is only the guarded legacy rollback; after AL1 sign-off removed the key, no TCP target.
  const fileMode = conf?.values.HOLDR_WEB_MODE ?? rawEnv.HOLDR_WEB_MODE ?? 'vite';
  if (conf && fileMode === 'vite' && (conf.values.HOLDR_LEGACY_VITE_ROLLBACK ?? rawEnv.HOLDR_LEGACY_VITE_ROLLBACK) !== '1') {
    fail('E0I_TCP_TARGET_RETIRED', `${conf.path}: vite without HOLDR_LEGACY_VITE_ROLLBACK=1 publishes no TCP target`);
  }
  // A removed LAN setting (HOLDR_LAN_HTTP=1, HOLDR_LAN_HTTPS_*) is refused here, in the file or the environment.
  const env = applyHoldrConf(rawEnv, conf, root);
  const mode = (env.HOLDR_WEB_MODE ?? 'vite') as StartConfig['mode'];
  const companion = readDistCompanionIfPresent(conf);
  const controlDir = configuredControlDir(env);
  const base = {
    config: location.kind === 'file' ? location.path : 'none', marker: markerState(controlDir), legacy: env.HOLDR_LEGACY_VITE_ROLLBACK === '1' ? '1' : '0',
    distOrigin: companion.origin, distSocket: companion.socket, nativeCommit: env.HOLDR_NATIVE_COMMIT ?? '',
    nativeManifest: env.HOLDR_NATIVE_MANIFEST ?? '', deviceApi: env.HOLDR_DEVICE_API ?? '0',
  };
  if (mode === 'vite') {
    // A's rules for vite (K1, K9) with the configured values; the script then keeps login's flow.
    resolveIngressConfig(env);
    return Object.freeze({
      ...base, mode, origin: env.HOLDR_PUBLIC_ORIGIN ?? '', digest: '', releaseDir: '', dataDir: env.HOLDR_DATA_DIR ?? '',
      controlDir: controlDir ?? '', socket: '', cli: '', ingressPort: '',
    });
  }
  const ingressPort = mode === 'local' ? (env.HOLDR_INGRESS_PORT ?? String(options.webPort)) : '';
  // A's rules for the mode (K1–K10) on exactly what the API will be given; no file-system check here (preflight does those).
  const resolved = resolveIngressConfig({
    ...env, NODE_ENV: 'production', HOLDR_HOST: undefined, PORT: String(options.apiPort), WEB_ORIGIN: undefined,
    ...(mode === 'local' ? { HOLDR_INGRESS_PORT: ingressPort } : {}),
  });
  if (resolved.mode === 'dev') return fail('E0I_MODE_INVALID');
  // §8.2 step 3: the release is the directory the script derives from the digest, in the tree being started.
  if (resolved.releaseDir !== releaseDirFor(resolved.releaseDigest, root)) {
    fail('E0I_RELEASE_CONFIG', 'the release dir must be <tree>/apps/web/releases/<first 12 hex of the digest>');
  }
  let releaseOk = false;
  try { releaseOk = fs.lstatSync(resolved.releaseDir).isDirectory(); } catch { releaseOk = false; }
  if (!releaseOk) fail('E0I_RELEASE_CONFIG', `release dir ${resolved.releaseDir} does not exist`);
  const cli = env.HOLDR_TAILSCALE_CLI ?? '';
  if (mode === 'dist' && !cli) fail('E0I_SERVE', 'HOLDR_TAILSCALE_CLI is required in dist');
  return Object.freeze({
    ...base, mode, origin: resolved.mode === 'dist' ? resolved.publicOrigin : '', digest: resolved.releaseDigest,
    releaseDir: resolved.releaseDir, dataDir: resolved.dataDir, controlDir: resolved.controlDir,
    socket: resolved.mode === 'dist' ? resolved.socketPath : '', cli, ingressPort,
  });
}

/** `start-config.ts --root <tree> --web-port <W>`: NUL-separated pairs on stdout; a refusal prints `E0I_X (detail)`, exit 1. */
export function runStartConfig(argv: readonly string[], env: NodeJS.ProcessEnv, io: {
  stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown };
}): number {
  try {
    const port = /^[1-9][0-9]{0,4}$/;
    if (argv.length !== 6 || argv[0] !== '--root' || argv[2] !== '--web-port' || argv[4] !== '--api-port'
      || !port.test(argv[3]) || !port.test(argv[5])) {
      throw new ControlError('E0I_USAGE', EXIT.usage, 'start-config.ts --root <tree> --web-port <port> --api-port <port>');
    }
    const result = startConfig(env, argv[1], { webPort: Number(argv[3]), apiPort: Number(argv[5]) });
    let out = '';
    for (const [key, value] of Object.entries(result)) {
      if (String(value).includes('\0')) fail('E0I_CONFIG_FILE', `NUL in ${key}`);
      out += `${key}\0${value}\0`;
    }
    // The final pair tells bash the list is complete (a process substitution hides the exit status).
    io.stdout.write(`${out}end\0ok\0`);
    return 0;
  } catch (error) {
    const code = error instanceof WebReleaseError ? error.code : 'E0I_INTERNAL';
    const detail = error instanceof ControlError && error.detail ? ` (${error.detail})` : '';
    io.stderr.write(`${code}${detail}\n`);
    return error instanceof ControlError && error.exitCode === EXIT.usage ? EXIT.usage : 1;
  }
}
