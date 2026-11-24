import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  CodeIdentityError,
  MAX_ATTESTATION_BYTES,
  createApiAttestation,
  type ApiAttestationInput,
  type ApiReleaseAttestation,
} from './codeIdentity.mjs';

/**
 * The release attestation this API process serves at GET /release/attestation (card-upload migration B-b, ROOT B3):
 * computed once at startup, before anything listens, and never again. `body` is its exact JSON, serialized once, so
 * every answer is the same bytes and pid and startedAt cannot change for the process's life. When it could not be
 * computed, the route answers 503 and `code` says why, as a value-free token (never a path or a message). `ms` is how
 * long the computation took (the startup cost, reported in the log).
 */
export type ReleaseAttestation =
  | { readonly status: 'ready'; readonly attestation: ApiReleaseAttestation; readonly body: string; readonly ms: number }
  | { readonly status: 'unavailable'; readonly code: string; readonly ms: number };

/**
 * T, the tree the uploader's release manifest pins: the directory that holds apps/ and packages/, four levels above
 * this module, written as it resolves (computeCodeIdentity refuses any other spelling).
 */
export function liveRoot(): string {
  return fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
}

/** This process as createApiAttestation describes it, with performance.timeOrigin as its start. */
export function processAttestationInput(): ApiAttestationInput {
  return {
    pid: process.pid,
    startedAt: performance.timeOrigin,
    execPath: process.execPath,
    version: process.version,
    execArgv: process.execArgv,
    cwd: process.cwd(),
    entry: process.argv[1],
    env: process.env,
    liveRoot: liveRoot(),
  };
}

/** Never throws: an attestation that cannot be computed, or would not fit the gate's size limit, is `unavailable`. */
export function computeReleaseAttestation(input: () => ApiAttestationInput = processAttestationInput): ReleaseAttestation {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const attestation = createApiAttestation(input());
    const body = JSON.stringify(attestation);
    if (Buffer.byteLength(body) > MAX_ATTESTATION_BYTES) {
      return Object.freeze({ status: 'unavailable', code: 'attestation-too-large', ms: ms() });
    }
    return Object.freeze({ status: 'ready', attestation, body, ms: ms() });
  } catch (error) {
    const code = error instanceof CodeIdentityError && /^[a-z][a-z-]{0,63}$/.test(error.code) ? error.code : 'attestation-failed';
    return Object.freeze({ status: 'unavailable', code, ms: ms() });
  }
}

/** The one startup log line: the cost, or why GET /release/attestation answers 503. Value-free either way. */
export function describeReleaseAttestation(state: ReleaseAttestation): string {
  return state.status === 'ready'
    ? `[holdr-api] release attestation ready (${state.ms} ms)`
    : `[holdr-api] release attestation unavailable (${state.code}); GET /release/attestation answers 503`;
}
