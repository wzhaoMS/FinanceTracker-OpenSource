/**
 * The production target has no repository-owned origin. A production artifact
 * is built for one operator-supplied private Tailscale HTTPS origin.
 */
import type { BuildTarget } from './targetTypes.js';
import { PLAN_TIMINGS } from './timings.js';

declare const __HOLDR_EXTENSION_ORIGIN__: string;

function target(holdrOrigin: string): BuildTarget {
  return Object.freeze({
    name: 'production',
    holdrOrigin,
    adapters: Object.freeze([]),
    timings: PLAN_TIMINGS,
  });
}

export function productionOriginProblem(value: string | undefined): string | null {
  if (!value) return 'HOLDR_EXTENSION_ORIGIN is required';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.port || url.username || url.password) {
      return 'HOLDR_EXTENSION_ORIGIN must be one exact HTTPS origin without a port, path, credentials, query or fragment';
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/.test(url.hostname)) {
      return 'HOLDR_EXTENSION_ORIGIN must be a Tailscale MagicDNS origin: https://<machine>.<tailnet>.ts.net';
    }
    if (/(?:^|\.)example(?:\.|$)/.test(url.hostname)) return 'HOLDR_EXTENSION_ORIGIN must not be a placeholder';
    return null;
  } catch {
    return 'HOLDR_EXTENSION_ORIGIN must be a valid HTTPS origin';
  }
}

export function createProductionTarget(value: string | undefined): BuildTarget {
  const problem = productionOriginProblem(value);
  if (problem) throw new Error(problem);
  return target(value!);
}

// esbuild replaces this symbol with the validated build-time origin. The
// invalid fallback keeps Node-side source inspection importable but can never
// pass the production manifest checks.
export const TARGET: BuildTarget = typeof __HOLDR_EXTENSION_ORIGIN__ === 'string'
  ? createProductionTarget(__HOLDR_EXTENSION_ORIGIN__)
  : target('https://invalid.invalid');
