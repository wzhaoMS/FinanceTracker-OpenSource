import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AGENT_TOKEN_FILE_NAME, AGENT_TOKEN_PATTERN, AGENT_TOKEN_PREFIX, loadOrCreateAgentToken } from './agentToken.js';
import { AGENT_READ_ONLY_CODE, AGENT_READ_ROUTES, AGENT_ROUTE_CODE, agentRefusal, maskAccountNumber } from './agentScope.js';
import { loadOrCreateServiceToken, SERVICE_TOKEN_FILE_NAME } from './serviceToken.js';
import { makeScratchDir, removeScratchDir } from '../testing/scratchDir.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await makeScratchDir('agent-token-');
  file = path.join(dir, 'data', AGENT_TOKEN_FILE_NAME);
});

afterEach(async () => {
  await removeScratchDir(dir);
});

describe('agent token file', () => {
  it('is generated on first start as holdr_agent_ and 32 random bytes, in a 0600 file of its own', async () => {
    const first = loadOrCreateAgentToken(file);
    expect(first.created).toBe(true);
    expect(first.repairedMode).toBe(false);
    expect(first.token).toMatch(/^holdr_agent_[0-9a-f]{64}$/);
    // Mode bits say nothing on Windows (Node reports 0o666 there).
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, 'utf8')).trim()).toBe(first.token);
    expect(await readdir(path.dirname(file))).toEqual([AGENT_TOKEN_FILE_NAME]);
  });

  it('is reused on later starts, and differs from the service token next to it', () => {
    const first = loadOrCreateAgentToken(file);
    expect(loadOrCreateAgentToken(file)).toEqual({ token: first.token, created: false, repairedMode: false });
    const service = loadOrCreateServiceToken(path.join(path.dirname(file), SERVICE_TOKEN_FILE_NAME));
    expect(service.token).not.toBe(first.token);
    expect(AGENT_TOKEN_PATTERN.test(service.token)).toBe(false);
  });

  it('refuses a file that holds anything but an agent token, a service token included', async () => {
    loadOrCreateAgentToken(file);
    const others = ['password', 'ab'.repeat(32), `${AGENT_TOKEN_PREFIX}${'AB'.repeat(32)}`, `${AGENT_TOKEN_PREFIX}${'ab'.repeat(31)}`];
    for (const content of others) {
      await writeFile(file, `${content}\n`);
      expect(() => loadOrCreateAgentToken(file), content).toThrow(/agent token .* is malformed/);
    }
  });

  it('leaves the service token file exactly as it was made before', () => {
    expect(loadOrCreateServiceToken(path.join(dir, SERVICE_TOKEN_FILE_NAME)).token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('agent scope', () => {
  it('lets the agent GET and HEAD the reviewed read routes, in any case and with one trailing slash', () => {
    for (const template of AGENT_READ_ROUTES) {
      const route = template.replace(/:[a-z]+/gi, 'sample-1');
      for (const method of ['GET', 'HEAD']) {
        expect(agentRefusal(method, route), `${method} ${route}`).toBeNull();
        expect(agentRefusal(method, `${route}/`), `${method} ${route}/`).toBeNull();
        expect(agentRefusal(method, route.toUpperCase()), `${method} ${route.toUpperCase()}`).toBeNull();
      }
    }
  });

  it('refuses every other method on every path with agent-read-only', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT', 'get']) {
      for (const route of ['/accounts', '/card-imports/commit', '/spending/benefits/marks', '/nope']) {
        expect(agentRefusal(method, route)?.code, `${method} ${route}`).toBe(AGENT_READ_ONLY_CODE);
      }
    }
  });

  it('refuses reads of sign-in, export, imports, card sync, the attestation, owner-only and unlisted paths', () => {
    const denied = [
      '/auth/me', '/auth/login', '/export', '/export/', '/card-imports/cutover-capability', '/card-imports/cutover-receipt',
      '/card-sync/owner/state', '/card-sync/owner/runs/run-1/payload', '/release/attestation', '/amazon/orders',
      '/amazon/items/ref-1/image', '/retail/costco/receipts', '/spending/rules/preview', '/metals/sources/roster/preview',
      '/thesis', '/thesis/health', '/import/positions', '/accounts/acct-1', '/accounts/acct-1/transactions/extra',
      '/accounts//transactions', '//accounts', '/accounts//', '/card-transactions/a/b', '/', '', '/nope',
      '/health/../export', '/accounts%2F..%2Fexport', '/spending/summaryx', '/spending',
    ];
    for (const route of denied) {
      for (const method of ['GET', 'HEAD']) {
        expect(agentRefusal(method, route)?.code, `${method} ${route}`).toBe(AGENT_ROUTE_CODE);
      }
    }
  });

  it('never lists a route that writes, signs in, exports, imports or syncs', () => {
    for (const template of AGENT_READ_ROUTES) {
      expect(template).toMatch(/^\/[a-z-]+(?:\/(?:[a-z-]+|:[a-z]+))*$/);
      expect(template).not.toMatch(/^\/(?:auth|export|card-imports|card-sync|release|amazon|retail|thesis|import)(?:\/|$)/);
    }
  });

  it('masks an account number to its last four letters or digits', () => {
    expect(maskAccountNumber('Z7418763')).toBe('***8763');
    expect(maskAccountNumber('XXXX-2468')).toBe('***2468');
    expect(maskAccountNumber('7142')).toBe('***7142');
    expect(maskAccountNumber('')).toBe('***');
  });
});
