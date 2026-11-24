import { describe, expect, it } from 'vitest';

import { localExposureCodes, portGuard } from './serveVerdict.js';

const read = (value: unknown) => ({ ok: true, stdout: typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n` });

describe('TCP-owner guard (§8.3; B-D27 as revised after the B2 review, finding 1)', () => {
  it('clear only for a successful read of a configuration in Serve\'s known schema that targets nothing on the port', () => {
    expect(portGuard(read('{}\n'), 5318)).toBe('clear');
    expect(portGuard(read('null\n'), 5318)).toBe('clear');
    expect(portGuard(read({ TCP: { 443: { HTTPS: true } }, Web: { 'h:443': { Handlers: { '/': { Proxy: 'unix:/run/s' } } } } }), 5318)).toBe('clear');
    expect(portGuard(read({ TCP: { 443: { HTTPS: true } }, Web: { 'h:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4000' } } } } }), 5318)).toBe('clear');
  });

  it('targeted wherever a proxy or forward names the port: top level, Services and Foreground', () => {
    expect(portGuard(read({ Web: { 'h:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5318' } } } } }), 5318)).toBe('targeted');
    expect(portGuard(read({ Services: { 'svc:x': { TCP: { 443: { TCPForward: '127.0.0.1:5318' } } } } }), 5318)).toBe('targeted');
    expect(portGuard(read({ Foreground: { s: { Web: { 'h:443': { Handlers: { '/': { Proxy: 'localhost:5318' } } } } } } }), 5318)).toBe('targeted');
  });

  it('unknown for a failed read, unparseable output, and every field or type outside Serve\'s known schema', () => {
    expect(portGuard({ ok: false, stdout: '' }, 5318)).toBe('unknown');
    for (const stdout of ['{', '{"Web":{},"Web":{}}\n', '[]\n', '"text"\n']) expect(portGuard(read(stdout), 5318), stdout).toBe('unknown');
    for (const value of [
      { FutureServeConfig: { Proxy: 'http://127.0.0.1:5318' } },
      { TCP: [{ TCPForward: '127.0.0.1:5318' }] },
      { Web: 'unavailable' },
      { Web: { h: { Handlers: ['http://127.0.0.1:5318'] } } },
      { TCP: { 443: { FutureForward: '127.0.0.1:5318' } } },
      { TCP: { 443: { HTTPS: 'yes' } } },
      { Web: { 'h:443': { Handlers: { '/': { Proxy: 5318 } } } } },
      { Web: { 'h:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5318' } }, Future: true } } },
      { AllowFunnel: { 'h:443': 'true' } },
    ]) expect(portGuard(read(value), 5318), JSON.stringify(value)).toBe('unknown');
  });
});

describe('local break-glass: A2\'s readiness/exposure split (B1 review 7)', () => {
  it('readiness-only codes are no exposure; anything else is', () => {
    expect(localExposureCodes(['serve-schema-unknown'])).toEqual([]);
    expect(localExposureCodes(['tailscale-not-running', 'cert-domain-missing'])).toEqual([]);
    expect(localExposureCodes(['serve-schema-unknown', 'funnel-enabled'])).toEqual(['funnel-enabled']);
    expect(localExposureCodes(['tcp-forward-to-holdr'])).toEqual(['tcp-forward-to-holdr']);
  });
});
