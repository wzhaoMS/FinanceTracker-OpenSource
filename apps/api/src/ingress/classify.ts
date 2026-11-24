import { HOLDR_API_PATH_PREFIXES } from '@finance-tracker/shared';
import type { ParsedIngressTarget } from './requestTarget.js';
import type { WebFile, WebRelease } from './webRelease.js';

const API_PREFIXES = new Set<string>(HOLDR_API_PATH_PREFIXES);
/**
 * First path segments of the API routes served only to a direct loopback caller (network.ts isDirectLoopback: the
 * requests identify honours the service token on): the release attestation (card-upload migration B-b,
 * routes/releaseAttestation.ts). They are deliberately not in the shared HOLDR_API_PATH_PREFIXES, so no web proxy
 * forwards them; for every other request they are classified like any other path (a release file, else not found).
 */
export const DIRECT_API_PATH_PREFIXES: readonly string[] = Object.freeze(['release']);
const DIRECT_PREFIXES = new Set<string>(DIRECT_API_PATH_PREFIXES);
export type PathClass = { kind: 'api' } | { kind: 'not-found' } | { kind: 'method-not-allowed' }
  | { kind: 'document' | 'asset'; file: WebFile };

export function classifyPath(method: string, parsed: ParsedIngressTarget, release?: WebRelease, directLoopback = false): PathClass {
  if (API_PREFIXES.has(parsed.first)) return { kind: 'api' };
  if (directLoopback && DIRECT_PREFIXES.has(parsed.first)) return { kind: 'api' };
  const document = parsed.rawPath === '/' || parsed.rawPath === '/index.html';
  const file = release?.get(document ? '/index.html' : parsed.rawPath);
  if (!file) return { kind: 'not-found' };
  if (method !== 'GET' && method !== 'HEAD') return { kind: 'method-not-allowed' };
  return { kind: document ? 'document' : 'asset', file };
}
