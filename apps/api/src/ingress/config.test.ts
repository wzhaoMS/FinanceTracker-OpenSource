import { describe, expect, it } from 'vitest';
import { resolveIngressConfig } from './config.js';

const dist: NodeJS.ProcessEnv = {
  HOLDR_WEB_MODE: 'dist', NODE_ENV: 'production', PORT: '4115', HOLDR_PUBLIC_ORIGIN: 'https://holdr.test',
  HOLDR_SERVE_SOCKET: '/holdr/run/ingress.sock', HOLDR_WEB_RELEASE_DIR: '/holdr/releases/aaaaaaaaaaaa',
  HOLDR_WEB_RELEASE_DIGEST: 'a'.repeat(64), HOLDR_DATA_DIR: '/holdr/data', HOLDR_CONTROL_DIR: '/holdr/control',
};

describe('opt-in ingress configuration', () => {
  it('keeps unset/vite mode and the legacy origin/bind defaults', () => {
    expect(resolveIngressConfig({})).toEqual({ mode: 'dev', port: 4000, host: '127.0.0.1' });
    expect(resolveIngressConfig({ HOLDR_WEB_MODE: 'vite', HOLDR_PUBLIC_ORIGIN: 'https://holdr.test', HOLDR_HOST: '::1', PORT: '4115' }))
      .toEqual({ mode: 'dev', port: 4115, host: '::1' });
  });
  it('binds dev mode, plain HTTP, to this computer only: a loopback HOLDR_HOST or localhost, anything else stops the start', () => {
    for (const host of ['127.0.0.1', ' 127.0.0.1 ', '127.0.0.2', '::1', 'localhost', 'LOCALHOST', '', '  ']) {
      expect(resolveIngressConfig({ HOLDR_HOST: host }), JSON.stringify(host)).toMatchObject({ mode: 'dev', host: host.trim() || '127.0.0.1' });
    }
    for (const host of ['0.0.0.0', '::', '192.0.2.10', '[::1]', '::ffff:192.0.2.10', 'holdr.example.com', 'localhost.example.com', '127.0.0.1.example.com']) {
      expect(() => resolveIngressConfig({ HOLDR_WEB_MODE: 'vite', HOLDR_HOST: host }), host).toThrow(/E0I_BIND/);
    }
  });
  // Dist mode serves on a Unix-domain socket, given here as a POSIX path. Windows' path.normalize rewrites its
  // separators, so resolveIngressConfig refuses it there (E0I_SOCKET_PATH): macOS and Linux only.
  it.skipIf(process.platform === 'win32')('requires release-mode origins to be exact and derives cookie settings from configuration', () => {
    expect(resolveIngressConfig(dist)).toMatchObject({ mode: 'dist', allowedOrigins: ['https://holdr.test'], port: 4115 });
    const local = { ...dist, HOLDR_WEB_MODE: 'local', HOLDR_PUBLIC_ORIGIN: undefined, HOLDR_SERVE_SOCKET: undefined, HOLDR_INGRESS_PORT: '5315' };
    expect(resolveIngressConfig(local)).toMatchObject({ mode: 'local', ingressPort: 5315, allowedOrigins: ['http://127.0.0.1:5315', 'http://localhost:5315'] });
  });
  it.each([
    ['HOLDR_WEB_MODE', 'DIST', 'E0I_MODE_INVALID'], ['NODE_ENV', undefined, 'E0I_NODE_ENV'],
    ['HOLDR_HOST', '::', 'E0I_BIND'], ['HOLDR_HOST', '', 'E0I_BIND'], ['PORT', '0', 'E0I_PORTS'],
    ['PORT', '65536', 'E0I_PORTS'], ['PORT', '4115junk', 'E0I_PORTS'], ['PORT', '4e3', 'E0I_PORTS'],
    ['HOLDR_PUBLIC_ORIGIN', undefined, 'E0I_PUBLIC_ORIGIN'], ['HOLDR_PUBLIC_ORIGIN', 'http://holdr.test', 'E0I_PUBLIC_ORIGIN'],
    ['HOLDR_PUBLIC_ORIGIN', 'https://127.0.0.1', 'E0I_PUBLIC_ORIGIN'], ['HOLDR_PUBLIC_ORIGIN', 'https://[::1]', 'E0I_PUBLIC_ORIGIN'],
    ['HOLDR_PUBLIC_ORIGIN', 'https://Holdr.test', 'E0I_PUBLIC_ORIGIN'], ['HOLDR_PUBLIC_ORIGIN', 'https://holdr.test.', 'E0I_PUBLIC_ORIGIN'],
    ['HOLDR_PUBLIC_ORIGIN', 'https://holdr.test/', 'E0I_PUBLIC_ORIGIN'], ['HOLDR_PUBLIC_ORIGIN', 'https://holdr.test:444', 'E0I_PUBLIC_ORIGIN'],
    ['HOLDR_PUBLIC_ORIGIN', 'https://u:user4@example.com', 'E0I_PUBLIC_ORIGIN'],
    ['WEB_ORIGIN', 'https://holdr.test,http://localhost:5315', 'E0I_WEB_ORIGIN'],
    ['HOLDR_LAN_HTTP', '1', 'E0I_LAN_REMOVED'], ['HOLDR_LAN_HTTPS_IP', '192.0.2.10', 'E0I_LAN_REMOVED'],
    ['HOLDR_WEB_RELEASE_DIR', undefined, 'E0I_RELEASE_CONFIG'],
    ['HOLDR_WEB_RELEASE_DIR', 'relative', 'E0I_RELEASE_CONFIG'], ['HOLDR_WEB_RELEASE_DIGEST', 'A'.repeat(64), 'E0I_RELEASE_CONFIG'],
    ['HOLDR_DATA_DIR', undefined, 'E0I_DATA_DIR_UNSET'], ['HOLDR_CONTROL_DIR', 'relative', 'E0I_CONTROL_DIR_UNSET'],
    ['HOLDR_DEVICE_API', 'true', 'E0I_DEVICE_API'], ['HOLDR_INGRESS_DIAG', '1', 'E0I_DIAG'],
    ['HOLDR_SERVE_SOCKET', 'relative', 'E0I_SOCKET_PATH'], ['HOLDR_SERVE_SOCKET', '/' + 'a'.repeat(100), 'E0I_SOCKET_PATH'],
    ['HOLDR_SERVE_SOCKET', '/holdr/../socket', 'E0I_SOCKET_PATH'], ['HOLDR_SERVE_SOCKET', '/holdr/\0socket', 'E0I_SOCKET_PATH'],
    ['HOLDR_INGRESS_PORT', '5315', 'E0I_MODE_MISMATCH'],
  ] as const)('fails closed for %s=%s with %s', (key, value, code) => {
    expect(() => resolveIngressConfig({ ...dist, [key]: value })).toThrow(code);
  });
  it.each(['HOLDR_WEB_RELEASE_DIR', 'HOLDR_WEB_RELEASE_DIGEST', 'HOLDR_SERVE_SOCKET', 'HOLDR_INGRESS_PORT', 'HOLDR_TAILSCALE_CLI'])('refuses %s in the default mode', (key) => {
    expect(() => resolveIngressConfig({ [key]: '' })).toThrow('E0I_MODE_MISMATCH');
  });
  it('refuses the removed LAN modes in the default mode too; HOLDR_LAN_HTTP=0 asks for none', () => {
    for (const env of [{ HOLDR_LAN_HTTP: '1' }, { HOLDR_LAN_HTTPS_PORT: '8443' }]) expect(() => resolveIngressConfig(env)).toThrow('E0I_LAN_REMOVED');
    expect(resolveIngressConfig({ HOLDR_LAN_HTTP: '0' })).toEqual({ mode: 'dev', port: 4000, host: '127.0.0.1' });
  });
  it('refuses partial local switches and colliding ports', () => {
    expect(() => resolveIngressConfig({ ...dist, HOLDR_WEB_MODE: 'local' })).toThrow('E0I_MODE_MISMATCH');
    expect(() => resolveIngressConfig({
      ...dist, HOLDR_WEB_MODE: 'local', HOLDR_PUBLIC_ORIGIN: undefined, HOLDR_SERVE_SOCKET: undefined, HOLDR_INGRESS_PORT: '4115',
    })).toThrow('E0I_PORTS');
  });
});
