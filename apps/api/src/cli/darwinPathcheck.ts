import { spawnSync } from 'node:child_process';

import { loadConfiguration } from '../control/holdrConf.js';
import type { CommandResult } from '../ingress/boundedCommand.js';
import { verifyPinnedNativeHelper, type NativePin } from '../ingress/nativeHelper.js';
import { parsePathcheck, socketAncestors, type PathRecord } from '../ingress/socketPath.js';

/**
 * macOS facts for the owner-only output check, from the repository's pinned native reader: holdr-pathcheck
 * (apps/api/native, protocol holdr-pathcheck/5). For one path it reports every directory from / down, then the path
 * itself, each with its owner, mode and every ACL entry, decoded from the raw ACL. Any ACL API failure fails it closed;
 * it never skips an entry. This module is a consumer only: the helper, its pin and its parser are the ingress's, unchanged.
 * - The pin is holdr.conf's HOLDR_NATIVE_COMMIT and HOLDR_NATIVE_MANIFEST, checked by verifyPinnedNativeHelper.
 * - The parser is parsePathcheck.
 * The path reaches the helper as its one argument, never through a shell, under a fixed environment. Nothing of the
 * helper's output or errors leaves here but the parsed records.
 */

export const PATHCHECK_TIMEOUT_MS = 5000;
export const PATHCHECK_MAX_BYTES = 256 * 1024;

/** Runs the verified helper on one path, synchronously. A failure to run is a result parsePathcheck refuses. */
export type PathcheckRunner = (binaryPath: string, target: string) => CommandResult;

export const runPathcheckSync: PathcheckRunner = (binaryPath, target) => {
  const run = spawnSync(binaryPath, [target], {
    env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PATHCHECK_TIMEOUT_MS,
    maxBuffer: PATHCHECK_MAX_BYTES,
  });
  if (run.error) {
    const code = (run.error as NodeJS.ErrnoException).code;
    return { exitCode: code === 'ETIMEDOUT' ? 'timeout' : code === 'ENOBUFS' ? 'overflow' : 'spawn-error', stdout: '' };
  }
  return { exitCode: run.status ?? 'spawn-error', stdout: run.stdout ?? '' };
};

/** The native reader's pin as holdr.conf states it: the same pin the ingress verifies. */
export function holdrConfNativePin(env: NodeJS.ProcessEnv = process.env): NativePin {
  const effective = loadConfiguration(env).env;
  return { sourceCommit: effective.HOLDR_NATIVE_COMMIT ?? '', manifestDigest: effective.HOLDR_NATIVE_MANIFEST ?? '' };
}

/**
 * The helper's records for `target`: its directories from / down, then `target` itself. Throws, naming no path, for a
 * path the helper can't take (not absolute, over 100 bytes, `//`, a trailing slash or a control character), a pin or
 * helper that doesn't verify, a failure the helper reports, or output parsePathcheck refuses.
 */
export function readPinnedPathcheck(target: string, pin: NativePin, run: PathcheckRunner = runPathcheckSync,
  verify: (pin: NativePin) => { binaryPath: string } = verifyPinnedNativeHelper): readonly PathRecord[] {
  socketAncestors(target);
  const { binaryPath } = verify(pin);
  const parsed = parsePathcheck(run(binaryPath, target), target);
  if (!parsed.ok) throw new Error(parsed.code);
  return parsed.objects;
}
