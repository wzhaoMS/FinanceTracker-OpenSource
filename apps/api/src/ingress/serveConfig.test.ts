import { describe, expect, it } from 'vitest';
import { approvedServeShape, canonicalServeJson, serveModeDecision, validateServeStatus, type ServeCode } from './serveConfig.js';
import { parseCommandJson } from './commandJson.js';

const expectations = { host: 'holdr.test', socketPath: '/holdr/run/ingress.sock', holdrPorts: [4116, 5316] };
const clone = (): Record<string, any> => JSON.parse(canonicalServeJson('dist', expectations));
const validate = (value: unknown) => validateServeStatus(JSON.stringify(value, null, 2) + '\n', 'dist', expectations);

describe('exclusive Serve configuration policy', () => {
  it('pins the exact Go-rendered approved bytes', () => {
    expect(canonicalServeJson('dist', expectations)).toBe(
      '{\n  "TCP": {\n    "443": {\n      "HTTPS": true\n    }\n  },\n  "Web": {\n    "holdr.test:443": {\n      "Handlers": {\n        "/": {\n          "Proxy": "unix:/holdr/run/ingress.sock"\n        }\n      }\n    }\n  }\n}\n');
    expect(canonicalServeJson('dist', { ...expectations, socketPath: '/holdr/a&b/s' })).toContain('a\\u0026b');
  });
  it.each(['dist', 'vite'] as const)('accepts only the canonical %s shape', (mode) => {
    const good = canonicalServeJson(mode, expectations);
    expect(validateServeStatus(good, 'dist', expectations)).toEqual({ verdict: `approved-${mode}`, codes: [] });
    for (const text of [good.trimEnd(), JSON.stringify(approvedServeShape(mode, expectations)) + '\n', good + '\n', good.replace('  "TCP"', '   "TCP"')]) {
      expect(validateServeStatus(text, 'dist', expectations)).toEqual({ verdict: 'refused', codes: ['serve-schema-unknown'] });
    }
  });
  it.each(['{}', '{}\n', 'null\n'])('marks %s as pending, never attested', (text) => {
    const result = validateServeStatus(text, 'dist', expectations);
    expect(result.verdict).toBe('empty');
    expect(serveModeDecision('dist', result)).toBe('pre-start-ok');
  });
  it.each(['garbage', '[]', '{"TCP":', '{"TCP":{},"TCP":{}}', '{"TCP":{},"\\u0054CP":{}}', '{"x":"' + 'x'.repeat(1024 * 1024) + '"}'])
    ('never accepts malformed, duplicate or oversized JSON', (text) => {
      expect(validateServeStatus(text, 'dist', expectations)).toEqual({ verdict: 'error', codes: ['serve-output-invalid'] });
    });
  const cases: Array<[string, (config: Record<string, any>) => void, ServeCode[]]> = [
    ['TLS termination neighbour', (c) => { c.TCP['9443'] = { TCPForward: '127.0.0.1:9000', TerminateTLS: 'holdr.test' }; }, ['tcp-forward', 'tcp-terminate-tls']],
    ['TLS for another name', (c) => { c.TCP['8443'] = { TerminateTLS: 'other.test' }; }, ['tcp-terminate-tls']],
    ['empty TLS field', (c) => { c.TCP['443'].TerminateTLS = ''; }, ['tcp-terminate-tls']],
    ['malformed forward', (c) => { c.TCP['443'] = { TCPForward: 'not a target' }; }, ['tcp-forward-to-holdr']],
    ['forward on 443', (c) => { c.TCP['443'] = { TCPForward: '127.0.0.1:4000' }; }, ['tcp-forward-to-holdr']],
    ['opaque unrelated forward', (c) => { c.TCP['22'] = { TCPForward: '127.0.0.1:22' }; }, ['tcp-forward']],
    ['path ancestor', (c) => { c.Web['holdr.test:443'].Handlers['/files'] = { Path: '/Users' }; }, ['path-handler', 'same-origin-mount']],
    ['path descendant', (c) => { c.Web['holdr.test:443'].Handlers['/files'] = { Path: '/holdr/data/private' }; }, ['path-handler']],
    ['path symlink', (c) => { c.Web['holdr.test:443'].Handlers['/'] = { Path: '/holdr/link' }; }, ['path-handler']],
    ['empty path field', (c) => { c.Web['holdr.test:443'].Handlers['/'].Path = ''; }, ['path-handler']],
    ['text handler', (c) => { c.Web['holdr.test:443'].Handlers['/'] = { Text: 'not echoed' }; }, ['other-handler']],
    ['redirect', (c) => { c.Web['holdr.test:443'].Handlers['/'] = { Redirect: 'https://other.test' }; }, ['other-handler']],
    ['capabilities', (c) => { c.Web['holdr.test:443'].Handlers['/'].AcceptAppCaps = ['cap']; }, ['other-handler']],
    ['different root proxy', (c) => { c.Web['holdr.test:443'].Handlers['/'].Proxy = 'http://127.0.0.1:4000'; }, ['proxy-target-mismatch']],
    ['second mount', (c) => { c.Web['holdr.test:443'].Handlers['/api'] = { Proxy: 'http://127.0.0.1:4000' }; }, ['same-origin-mount']],
    ['second host', (c) => { c.Web['other.test:443'] = c.Web['holdr.test:443']; }, ['serve-shape-mismatch']],
    ['second HTTPS port', (c) => { c.TCP['8443'] = { HTTPS: true }; }, ['cookie-neighbour']],
    ['plain HTTP', (c) => { c.TCP['80'] = { HTTP: true }; }, ['plain-http-serve']],
    ['HTTP on 443', (c) => { c.TCP['443'].HTTP = true; }, ['plain-http-serve']],
    ['empty handlers', (c) => { c.Web['holdr.test:443'].Handlers = {}; }, ['serve-shape-mismatch']],
    ['Funnel', (c) => { c.AllowFunnel = { 'holdr.test:443': true }; }, ['funnel-enabled']],
    ['false Funnel entry', (c) => { c.AllowFunnel = { 'holdr.test:443': false }; }, ['funnel-enabled']],
    ['malformed Funnel', (c) => { c.AllowFunnel = true; }, ['funnel-enabled', 'serve-schema-unknown']],
    ['foreground', (c) => { c.Foreground = { session: {} }; }, ['foreground-config']],
    ['service', (c) => { c.Services = { 'svc:x': { Tun: true } }; }, ['services-config']],
    ['foreground path', (c) => { c.Foreground = { x: { Web: { 'holdr.test:443': { Handlers: { '/': { Path: '/' } } } } } }; }, ['foreground-config', 'path-handler']],
    ['service path', (c) => { c.Services = { x: { Web: { 'holdr.test:443': { Handlers: { '/': { Path: '/' } } } } } }; }, ['services-config', 'path-handler']],
    ['nested foreground', (c) => { c.Foreground = { a: { Foreground: { b: { AllowFunnel: { x: true } } } } }; }, ['serve-schema-unknown', 'foreground-config', 'funnel-enabled']],
    ['unknown root', (c) => { c.NewThing = {}; }, ['serve-schema-unknown']],
    ['unknown TCP', (c) => { c.TCP['443'].HTTP3 = true; }, ['serve-schema-unknown']],
    ['unknown Web config', (c) => { c.Web['holdr.test:443'].Other = {}; }, ['serve-schema-unknown']],
    ['unknown handler', (c) => { c.Web['holdr.test:443'].Handlers['/'].Headers = {}; }, ['serve-schema-unknown']],
    ['unknown service', (c) => { c.Services = { x: { Other: true } }; }, ['serve-schema-unknown', 'services-config']],
    ['wrong HTTPS type', (c) => { c.TCP['443'].HTTPS = 'true'; }, ['serve-schema-unknown']],
    ['invalid port name', (c) => { c.TCP.https = c.TCP['443']; delete c.TCP['443']; }, ['serve-schema-unknown', 'cookie-neighbour']],
    ['oversize port', (c) => { c.TCP['65536'] = { HTTPS: true }; }, ['serve-schema-unknown', 'cookie-neighbour']],
  ];
  it.each(cases)('refuses %s without echoing config values', (_name, mutate, required) => {
    const config = clone();
    mutate(config);
    const result = validate(config);
    expect(result.verdict).toBe('refused');
    expect(result.codes).toEqual(expect.arrayContaining(required));
    expect(Object.keys(result)).toEqual(['verdict', 'codes']);
  });
  for (const host of ['127.0.0.1', 'localhost', '[::1]', '100.101.102.103']) {
    it.each([4000, 8888, 3003, 5173, 4116, 5316])(`refuses a forward via ${host} to Holdr port %i`, (port) => {
      const config = clone();
      config.TCP['9443'] = { TCPForward: `${host}:${port}` };
      expect(validate(config).codes).toContain('tcp-forward-to-holdr');
    });
  }
  it('implements all mode decisions without treating local or vite as attested', () => {
    for (const mode of ['dist', 'local', 'vite'] as const) {
      for (const shape of ['dist', 'vite'] as const) {
        const result = validateServeStatus(canonicalServeJson(shape, expectations), mode, expectations);
        expect(serveModeDecision(mode, result)).toBe(mode === 'dist' && shape === 'dist' ? 'admit' : 'pre-start-ok');
      }
      expect(serveModeDecision(mode, { verdict: 'error', codes: ['serve-output-invalid'] })).toBe('unknown');
    }
  });
  it('does not mistake strings, arrays or escaped punctuation for duplicate object keys', () => {
    expect(parseCommandJson('{"a":["a","a",{"b":"\\"a\\":"}],"c":1}')).toEqual({ a: ['a', 'a', { b: '"a":' }], c: 1 });
  });
});
