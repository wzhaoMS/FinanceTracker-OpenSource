import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { TAILNET_SUBNETS } from '@finance-tracker/shared/tailnet';

export const stripMappedPrefix = (address: string): string => address.replace(/^::ffff:/i, '');

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const plain = stripMappedPrefix(address);
  return plain === '::1' || (isIP(plain) === 4 && plain.startsWith('127.'));
}

export function isLoopbackHost(host: string | undefined): boolean {
  const match = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::\d{1,5})?$/i.exec(host?.trim() ?? '');
  if (!match) return false;
  const name = (match[1] ?? match[2]).toLowerCase();
  return name === 'localhost' || isLoopbackAddress(name);
}

export function isProxiedRequest(req: Pick<IncomingMessage, 'headers'>): boolean {
  return Object.keys(req.headers).some((name) =>
    ['forwarded', 'x-real-ip', 'via'].includes(name) || name.startsWith('x-forwarded-') || name.startsWith('tailscale-'));
}

/**
 * A local process talking to the API socket itself. The web proxy and
 * Tailscale Serve connect from loopback too, but always add forwarding
 * headers (and Serve keeps the browser's Host), so neither qualifies.
 * identify (auth/http.ts) honours the service token only for these requests,
 * and the ingress (classify.ts) serves the direct-only API paths only to them.
 */
export function isDirectLoopback(req: IncomingMessage): boolean {
  const facts = req.holdrIngress;
  return (!facts || (facts.listener === 'local' && (facts.profile === 'direct' || facts.profile === 'dev')))
    && isLoopbackAddress(req.socket.remoteAddress)
    && isLoopbackHost(req.headers.host)
    && !isProxiedRequest(req);
}

const tailnet = new BlockList();
for (const [subnet, prefix, family] of TAILNET_SUBNETS) tailnet.addSubnet(subnet, prefix, family);

export function isServeClient(address: string): boolean {
  const family = isIP(address);
  return !address.includes('%') && family !== 0
    && (isLoopbackAddress(address) || tailnet.check(address, family === 4 ? 'ipv4' : 'ipv6'));
}

export function proxyClientAddress(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (isLoopbackAddress(remote)) {
    const value = req.headers['x-forwarded-for'];
    const hops = (Array.isArray(value) ? value.join(',') : value)?.split(',').map((hop) => hop.trim()).filter(Boolean) ?? [];
    const last = hops.length > 0 ? stripMappedPrefix(hops[hops.length - 1]) : '';
    if (isIP(last)) return last;
  }
  return stripMappedPrefix(remote);
}
