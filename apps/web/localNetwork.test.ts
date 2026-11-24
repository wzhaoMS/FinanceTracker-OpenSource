import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isFunnelRequest,
  isLocalClient,
  isTailnetClient,
  parsePublicOriginHostname,
  parseTailnetAddresses,
  parseTailnetHostname,
} from './localNetwork.js';

test('allows loopback and link-local clients without a DHCP address', () => {
  for (const address of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1', '169.254.10.20', 'fe80::1234', 'fe80::1234%en1']) {
    assert.equal(isLocalClient(address, []), true, address);
  }
});

test('accepts the connected IPv4 subnet including mapped IPv6 addresses', () => {
  const networks = ['192.168.24.65/22'];
  for (const address of ['192.168.24.68', '192.168.27.250', '::ffff:192.168.24.68']) {
    assert.equal(isLocalClient(address, networks), true, address);
  }
  for (const address of ['192.168.28.1', '192.168.1.116', '8.8.8.8', '::ffff:8.8.8.8']) {
    assert.equal(isLocalClient(address, networks), false, address);
  }
});

test('accepts connected IPv6 subnets but not other public networks', () => {
  const networks = ['fd12:3456:789a:1::10/64', '2001:db8:1234:5678::10/64'];
  for (const address of ['fd12:3456:789a:1::20', '2001:db8:1234:5678::20']) {
    assert.equal(isLocalClient(address, networks), true, address);
  }
  for (const address of ['fd12:3456:789a:2::20', '2001:db8:1234:5679::20', '2606:4700:4700::1111']) {
    assert.equal(isLocalClient(address, networks), false, address);
  }
});

test('uses the current network rather than retaining an old router subnet', () => {
  assert.equal(isLocalClient('192.168.1.116', ['192.168.24.65/22']), false);
  assert.equal(isLocalClient('192.168.1.116', ['192.168.1.65/24']), true);
  assert.equal(isLocalClient('192.168.24.68', ['192.168.1.65/24']), false);
});

test('rejects missing peers and invalid or unrestricted network entries', () => {
  for (const address of [undefined, '', 'invalid', '192.168.1.1.example.com']) {
    assert.equal(isLocalClient(address, ['192.168.1.65/24']), false);
  }
  for (const network of ['0.0.0.0/0', '::/0', '192.168.1.1/33', '::1/129', '192.168.1.1/-1', 'bad/24', '192.168.1.1', '192.168.1.1/24/extra']) {
    assert.equal(isLocalClient('8.8.8.8', [network]), false, network);
    assert.equal(isLocalClient('2606:4700:4700::1111', [network]), false, network);
  }
});

test('accepts tailnet peers that connect to this host\'s Tailscale address', () => {
  const own = ['100.101.102.103', 'fd7a:115c:a1e0::1234'];
  assert.equal(isTailnetClient('100.64.0.7', '100.101.102.103', own), true);
  assert.equal(isTailnetClient('::ffff:100.64.0.7', '::ffff:100.101.102.103', own), true);
  assert.equal(isTailnetClient('fd7a:115c:a1e0::5678', 'fd7a:115c:a1e0::1234', own), true);
});

test('rejects tailnet-range peers outside the pinned Tailscale addresses', () => {
  const own = ['100.101.102.103'];
  assert.equal(isTailnetClient('100.64.0.7', '192.168.24.65', own), false, 'arrived on the LAN address');
  assert.equal(isTailnetClient('100.64.0.7', '100.101.102.103', []), false, 'Tailscale was down at startup');
  assert.equal(isTailnetClient('100.64.0.7', '192.168.24.65', ['192.168.24.65']), false, 'pin outside the tailnet');
  assert.equal(isTailnetClient('100.96.0.5', '100.96.0.2', own), false, 'another VPN using CGNAT addresses');
  assert.equal(isTailnetClient('fd7a:115c:a1e0::5', 'fd7a:115c:a1e0::1234', own), false, 'unpinned IPv6 address');
  for (const remote of ['192.168.24.68', '8.8.8.8', '100.128.0.1', '100.63.255.255', 'fd7a:115c:a1e1::1', undefined, '', 'invalid']) {
    assert.equal(isTailnetClient(remote, '100.101.102.103', own), false, String(remote));
  }
  assert.equal(isTailnetClient('100.64.0.7', undefined, own), false, 'missing local address');
});

test('parses pinned addresses from `tailscale ip` output and drops anything else', () => {
  assert.deepEqual(parseTailnetAddresses('100.101.102.103,fd7a:115c:a1e0::1234,'), ['100.101.102.103', 'fd7a:115c:a1e0::1234']);
  assert.deepEqual(parseTailnetAddresses('100.101.102.103\n192.168.24.65 8.8.8.8,,garbage,::1'), ['100.101.102.103']);
  assert.deepEqual(parseTailnetAddresses(undefined), []);
  assert.deepEqual(parseTailnetAddresses(''), []);
});

test('allows only the exact MagicDNS machine name as an extra Vite host', () => {
  assert.deepEqual(parseTailnetHostname('holdr.example.ts.net'), ['holdr.example.ts.net']);
  assert.deepEqual(parseTailnetHostname(' Holdr.Example.TS.net. '), ['holdr.example.ts.net']);
  for (const value of [
    undefined, '', '.ts.net', '.example.ts.net', 'example.ts.net', 'www.holdr.example.ts.net',
    'holdr.example.ts.net.evil.example', 'homeserver.local', 'evil.example.com', '100.101.102.103',
    '-holdr.example.ts.net', 'holdr-.example.ts.net', 'holdr_host.example.ts.net',
    'holdr.example.ts.net,evil.example.com', `${'a'.repeat(64)}.example.ts.net`,
  ]) {
    assert.deepEqual(parseTailnetHostname(value), [], String(value));
  }
});

test('allows the exact HOLDR_PUBLIC_ORIGIN hostname as an extra Vite host', () => {
  assert.deepEqual(parsePublicOriginHostname('https://Holdr.example.ts.net'), ['holdr.example.ts.net']);
  assert.deepEqual(parsePublicOriginHostname(' https://holdr.example.com:8443/ '), ['holdr.example.com']);
  for (const value of [undefined, '', 'holdr.example.ts.net', 'https://.ts.net', 'https://h.example/app',
    'https://user8@example.com', 'ftp://h.example', 'https://h.example?x=1']) {
    assert.deepEqual(parsePublicOriginHostname(value), [], String(value));
  }
});

test('recognizes Tailscale Funnel requests by the header tailscaled sets', () => {
  assert.equal(isFunnelRequest({ 'tailscale-funnel-request': '?1' }), true);
  assert.equal(isFunnelRequest({ 'tailscale-user-login': 'alex@example.com' }), false);
  assert.equal(isFunnelRequest({}), false);
});
