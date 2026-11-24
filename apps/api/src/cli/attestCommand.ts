import path from 'node:path';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { SOURCE_COMMIT, SHA256_HEX } from '@finance-tracker/shared/web-release';
import { attestOnce, createAttestationState, SUPPORTED_TAILSCALE, type AttestationResult, type PathEvidence } from '../ingress/attestation.js';
import { evaluateSocketPath, runPathcheck, socketAncestors } from '../ingress/socketPath.js';
import { assertVerifiedRuntime } from '../ingress/safetyProviders.js';
import type { NativePin } from '../ingress/nativeHelper.js';
import type { SocketIdentity } from '../ingress/server.js';

type Environment = Readonly<NodeJS.ProcessEnv>;
export interface AttestOnceDeps {
  readonly now: () => bigint;
  readonly observe: (env: Environment) => Promise<unknown>;
}
export interface AttestOutcome {
  readonly exitCode: 0 | 3 | 4;
  readonly codes: readonly string[];
}

const CONFIG_CODES = new Set(['E0I_PUBLIC_ORIGIN', 'E0I_SOCKET_PATH', 'E0I_NATIVE_HELPER', 'E0I_SERVE', 'E0I_RUNTIME_UNVERIFIED']);
class AttestConfigurationError extends Error {
  constructor(readonly code: string) { super(code); }
}
const unverified = (code?: string): AttestOutcome => ({
  exitCode: 3, codes: ['ingress-unverified', ...(code && CONFIG_CODES.has(code) ? [code] : [])],
});

/** The testable command policy. The executable supplies only the fixed real dependencies below. */
export async function runAttestOnce(deps: AttestOnceDeps, env: Environment = process.env): Promise<AttestOutcome> {
  try {
    const state = createAttestationState({ mode: 'dist', now: deps.now });
    const attempt = state.beginAttempt();
    const observation = await deps.observe(env);
    state.record(observation, attempt);
    const view = state.view();
    if (state.admission.refusal() === null && view.verified) return { exitCode: 0, codes: ['ingress-verified'] };
    if (view.name === 'refused') return { exitCode: 4, codes: ['ingress-refused', ...view.codes] };
    return { exitCode: 3, codes: ['ingress-unverified', ...view.codes] };
  } catch (error) {
    return unverified(error instanceof AttestConfigurationError ? error.code : undefined);
  }
}

function settings(env: Environment) {
  const origin = env.HOLDR_PUBLIC_ORIGIN ?? '';
  let host: string;
  try {
    const url = new URL(origin);
    host = url.hostname;
    if (url.protocol !== 'https:' || url.origin !== origin || url.port || isIP(host) || host.length > 253
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) throw Error();
  } catch { throw new AttestConfigurationError('E0I_PUBLIC_ORIGIN'); }
  const socketPath = env.HOLDR_SERVE_SOCKET ?? '';
  try { socketAncestors(socketPath); } catch { throw new AttestConfigurationError('E0I_SOCKET_PATH'); }
  const cli = env.HOLDR_TAILSCALE_CLI ?? '';
  if (!path.isAbsolute(cli) || /[\0\r\n]/.test(cli)) throw new AttestConfigurationError('E0I_SERVE');
  const sourceCommit = env.HOLDR_NATIVE_COMMIT ?? '';
  const manifestDigest = env.HOLDR_NATIVE_MANIFEST ?? '';
  if (!SOURCE_COMMIT.test(sourceCommit) || !SHA256_HEX.test(manifestDigest)) throw new AttestConfigurationError('E0I_NATIVE_HELPER');
  const native: NativePin = { sourceCommit, manifestDigest };
  return { cli, native, expectations: { host, socketPath } };
}

async function observeReal(env: Environment): Promise<AttestationResult> {
  const config = settings(env);
  try { assertVerifiedRuntime(); } catch { throw new AttestConfigurationError('E0I_RUNTIME_UNVERIFIED'); }
  let observedIdentity: SocketIdentity | undefined;
  const checkPath = async (recheck = false): Promise<PathEvidence> => {
    const parsed = await runPathcheck(config.expectations.socketPath, config.native);
    if (!parsed.ok) return { ok: false, codes: ['socket-path-unsafe'] };
    const result = evaluateSocketPath(parsed.objects, {
      holdrUid: process.getuid!(), phase: recheck ? 'poll' : 'preflight', identity: observedIdentity,
    });
    if (!result.socket) return { ok: false, codes: ['socket-missing'] };
    if (!result.ok) return {
      ok: false, codes: [...new Set(result.findings.map((finding) =>
        finding.code === 'socket-replaced' ? 'socket-replaced' : 'socket-path-unsafe'))],
    };
    observedIdentity = { dev: result.socket.dev, ino: result.socket.ino };
    return { ok: true, codes: [] };
  };
  const result = await attestOnce({
    cli: config.cli, expectations: config.expectations, supported: SUPPORTED_TAILSCALE,
    mode: 'dist', home: env.HOME ?? '/', checkPath: () => checkPath(),
  });
  // Never call beforeListen/preflight's connection or cleanup paths, and never publish API state.
  // Before a potential success, require the same safe socket to still be present.
  if (result.kind === 'ok') {
    const final = await checkPath(true);
    if (!final.ok) return { kind: 'refused', codes: final.codes, exposureChecked: result.exposureChecked };
  }
  return result;
}

const REAL_DEPS: AttestOnceDeps = Object.freeze({
  now: () => process.hrtime.bigint(),
  observe: observeReal,
});

/** B can pass loadConfiguration(process.env).env here without replacing any provider. */
export async function runAttestCommand(argv: readonly string[], env: Environment = process.env): Promise<0 | 1 | 3 | 4> {
  try {
    const { values } = parseArgs({ args: [...argv], options: { once: { type: 'boolean' } }, allowPositionals: false, strict: true });
    if (values.once !== true) throw Error('usage');
  } catch {
    console.error('E0I_ATTEST_USAGE');
    return 1;
  }
  const result = await runAttestOnce(REAL_DEPS, env);
  console.log(result.codes.join('\n'));
  return result.exitCode;
}
