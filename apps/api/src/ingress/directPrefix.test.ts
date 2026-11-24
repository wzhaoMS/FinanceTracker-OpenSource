import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { HOLDR_API_PATH_PREFIXES } from '@finance-tracker/shared';

import { DIRECT_API_PATH_PREFIXES, classifyPath } from './classify.js';
import { parseIngressTarget } from './requestTarget.js';
import { createWebIngress } from './staticResponder.js';
import type { HoldrIngressFacts, WebIngressOptions } from './types.js';
import type { WebFile, WebRelease } from './webRelease.js';
import { listenLoopback } from '../testing/loopback.js';

/**
 * The direct-only API prefixes (card-upload migration B-b: GET /release/attestation) on the real createWebIngress, with
 * the listener facts the ingress servers attach (ingress/listenerProfile.ts) fabricated, so every profile runs here,
 * Windows included. A path under them is an API path only for a direct loopback request; any other request gets exactly
 * what it got before they existed.
 */

const OPEN = { refusal: () => null };
const NO_FILES = { digest: 'synthetic', manifest: {}, get: () => undefined } as unknown as WebRelease;
const DIST: WebIngressOptions = { mode: 'dist', publicOrigin: 'https://holdr.test', release: NO_FILES, admission: OPEN };
const LOCAL: WebIngressOptions = { mode: 'local', ingressPort: 8888, release: NO_FILES, admission: OPEN };
const facts = (listener: HoldrIngressFacts['listener'], mode: HoldrIngressFacts['mode'], profile: HoldrIngressFacts['profile']) =>
  Object.freeze({ listener, mode, profile, clientAddress: '127.0.0.1' }) as HoldrIngressFacts;

/** [name, options, the facts the listener attached, whether the request comes from a direct loopback listener]. */
const PROFILES: Array<[string, WebIngressOptions, HoldrIngressFacts | undefined, boolean]> = [
  ['dev without listener facts (createApp alone)', { mode: 'dev' }, undefined, true],
  ['dev listener', { mode: 'dev' }, facts('local', 'dev', 'dev'), true],
  ['dist direct listener', DIST, facts('local', 'dist', 'direct'), true],
  ['break-glass direct listener', LOCAL, facts('local', 'local', 'direct'), true],
  ['dist Serve socket', DIST, facts('ingress', 'dist', 'serve'), false],
  ['break-glass browser listener', LOCAL, facts('ingress', 'local', 'local-browser'), false],
];
const PROXIED: Array<Record<string, string>> = [
  { 'X-Forwarded-For': '100.64.0.2' }, { 'X-Forwarded-Host': 'holdr.test' }, { 'X-Forwarded-Proto': 'https' },
  { Forwarded: 'for=100.64.0.2' }, { 'X-Real-IP': '100.64.0.2' }, { Via: '1.1 proxy' }, { 'Tailscale-User-Login': 'alex@example.com' },
  { Host: 'holdr.test' }, { Host: 'homeserver.local:4000' },
];

/** createWebIngress as createApp mounts it; whatever it lets through reaches the API (here, a marker). */
function ingress(options: WebIngressOptions, attached: HoldrIngressFacts | undefined): Express {
  const app = express();
  app.use((req, _res, next) => {
    if (attached) Object.defineProperty(req, 'holdrIngress', { value: attached });
    next();
  });
  app.use(createWebIngress(options));
  app.use((_req, res) => { res.json({ reached: 'api' }); });
  return app;
}

async function get(app: Express, target: string, headers: Record<string, string> = {}) {
  const res = await request(await listenLoopback(app)).get(target).set(headers);
  return { status: res.status, api: res.body?.reached === 'api', code: res.headers['x-holdr-error'] as string | undefined };
}

function parsed(target: string) {
  const result = parseIngressTarget(target);
  if ('refuse' in result) throw new Error(`invalid test vector: ${target}`);
  return result;
}

describe('direct-only API paths at the ingress', () => {
  it('lists only the release attestation, which no web proxy forwards', () => {
    expect([...DIRECT_API_PATH_PREFIXES]).toEqual(['release']);
    for (const prefix of DIRECT_API_PATH_PREFIXES) expect(HOLDR_API_PATH_PREFIXES).not.toContain(prefix);
  });

  it.each(PROFILES)('on the %s: /release is an API path only from a direct loopback listener', async (_name, options, attached, direct) => {
    const app = ingress(options, attached);
    for (const target of ['/release/attestation', '/release', '/RELEASE/Attestation/', '/release/attestation?x=1']) {
      expect(await get(app, target), target).toEqual(direct
        ? { status: 200, api: true, code: undefined }
        : { status: 404, api: false, code: 'not-found' });
    }
  });

  it.each(PROFILES.filter(([, , , direct]) => direct))('on the %s: not for a request through a proxy or to another host', async (_name, options, attached) => {
    const app = ingress(options, attached);
    for (const headers of PROXIED) {
      expect(await get(app, '/release/attestation', headers), JSON.stringify(headers))
        .toEqual({ status: 404, api: false, code: 'not-found' });
    }
  });

  it.each(PROFILES)('on the %s: every shared API prefix and every other path is classified as before', async (_name, options, attached) => {
    const app = ingress(options, attached);
    for (const prefix of HOLDR_API_PATH_PREFIXES) {
      expect(await get(app, `/${prefix}/x`), prefix).toEqual({ status: 200, api: true, code: undefined });
    }
    for (const target of ['/releases/attestation', '/releasex', '/x/release/attestation', '/foo']) {
      expect(await get(app, target), target).toEqual({ status: 404, api: false, code: 'not-found' });
    }
  });

  it('classifyPath: a direct-only prefix is the API only when the caller is direct, on whole first segments', () => {
    for (const target of ['/release/attestation', '/release', '/RELEASE/ATTESTATION', '/release/a/b?c=d']) {
      expect(classifyPath('GET', parsed(target)).kind, target).toBe('not-found');
      expect(classifyPath('GET', parsed(target), undefined, true).kind, target).toBe('api');
      expect(classifyPath('POST', parsed(target), undefined, true).kind, target).toBe('api');
    }
    for (const target of ['/releases', '/releasex/attestation', '/x/release', '/']) {
      expect(classifyPath('GET', parsed(target), undefined, true).kind, target).toBe('not-found');
    }
    // Static classification is unchanged for everyone else: a release file at that path stays a file.
    const file = { contentType: 'application/json', etag: '"synthetic"', bytes: () => Buffer.from('{}') } as unknown as WebFile;
    const release = { get: (rawPath: string) => (rawPath === '/release/attestation' ? file : undefined) } as unknown as WebRelease;
    expect(classifyPath('GET', parsed('/release/attestation'), release)).toEqual({ kind: 'asset', file });
    expect(classifyPath('GET', parsed('/release/attestation'), release, true)).toEqual({ kind: 'api' });
    for (const prefix of HOLDR_API_PATH_PREFIXES) {
      expect(classifyPath('GET', parsed(`/${prefix}/x`)).kind, prefix).toBe('api');
    }
  });
});
