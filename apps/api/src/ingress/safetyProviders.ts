import path from 'node:path';
import { isIP } from 'node:net';
import { WebReleaseError } from '@finance-tracker/shared/web-release';
import {
  attestOnce, createAttestationPoller, createAttestationState, VERIFIED_RUNTIMES,
} from './attestation.js';
import { writeAttestationStatus } from './attestationStatus.js';
import { createSocketSafety, socketAncestors } from './socketPath.js';
import { verifyPinnedNativeHelper, type NativePin } from './nativeHelper.js';
import type { ServeExpectations } from './serveConfig.js';

export function assertVerifiedRuntime(runtime = { platform: process.platform, node: process.versions.node, uv: process.versions.uv }): void {
  if (!VERIFIED_RUNTIMES.some((known) => Object.keys(known).every((key) => known[key as keyof typeof known] === runtime[key as keyof typeof runtime]))) {
    throw new WebReleaseError('E0I_RUNTIME_UNVERIFIED');
  }
}

/** Components only: deliberately no beforeDatabaseOpen or automatic start/bind. B owns that gate. */
export function createIngressSafetyProviders(options: {
  mode: 'dist' | 'local';
  native: NativePin;
  cli: string;
  expectations: ServeExpectations;
  stateFile?: string;
  log?: (line: string) => void;
}) {
  if (options.mode !== 'dist' && options.mode !== 'local') throw new WebReleaseError('E0I_MODE_INVALID');
  if (options.mode === 'dist') assertVerifiedRuntime();
  socketAncestors(options.expectations.socketPath);
  const host = options.expectations.host;
  if (host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) || isIP(host)
    || new URL(`https://${host}`).hostname !== host) throw new WebReleaseError('E0I_PUBLIC_ORIGIN');
  if (!path.isAbsolute(options.cli)) throw new WebReleaseError('E0I_SERVE');
  if (options.stateFile !== undefined && options.stateFile !== path.join(path.dirname(options.expectations.socketPath), 'ingress-state.json')) {
    throw new WebReleaseError('E0I_SOCKET_PATH');
  }
  verifyPinnedNativeHelper(options.native);
  const socket = createSocketSafety({ socketPath: options.expectations.socketPath, native: options.native });
  const state = createAttestationState({
    mode: options.mode,
    onChange: options.stateFile ? (view) => writeAttestationStatus(options.stateFile!, view) : undefined,
  });
  const poller = createAttestationPoller(state, () => attestOnce({
    cli: options.cli, expectations: options.expectations, mode: options.mode,
    checkPath: async () => {
      const result = await socket.inspect(options.mode === 'dist' ? 'poll' : 'boot');
      return { ok: result.ok, codes: result.findings.map((finding) =>
        finding.code === 'socket-replaced' || finding.code === 'socket-missing' ? finding.code : 'socket-path-unsafe') };
    },
  }), { log: options.log });
  return {
    admission: state.admission, socketSafety: socket.safety, preflightSocket: socket.preflight,
    state: state.view, pollOnce: poller.pollOnce, start: poller.start, stop: poller.stop,
  };
}
