import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { TAILNET_SUBNETS } from '@finance-tracker/shared/tailnet';

function contains(list: BlockList, address: string | undefined): boolean {
  const normalized = address?.split('%')[0] ?? '';
  const family = isIP(normalized);
  return family !== 0 && list.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

function tailnetRanges(): BlockList {
  const ranges = new BlockList();
  for (const [subnet, prefix, family] of TAILNET_SUBNETS) ranges.addSubnet(subnet, prefix, family);
  return ranges;
}

// Pinned from `tailscale ip` at service start; inferring from interfaces could admit other VPNs' CGNAT peers.
export function parseTailnetAddresses(value: string | undefined): string[] {
  const ranges = tailnetRanges();
  return (value ?? '').split(/[\s,]+/).filter((address) => contains(ranges, address));
}

// Exact MagicDNS name (<machine>.<tailnet>.ts.net) from `tailscale status`; Vite would treat a leading dot as a wildcard.
const MAGICDNS_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/;

export function parseTailnetHostname(value: string | undefined): string[] {
  const name = (value ?? '').trim().toLowerCase().replace(/\.$/, '');
  return MAGICDNS_NAME.test(name) ? [name] : [];
}

// Hostname of HOLDR_PUBLIC_ORIGIN, the HTTPS name browsers use (normally the MagicDNS name behind Tailscale Serve).
export function parsePublicOriginHostname(value: string | undefined): string[] {
  try {
    const url = new URL((value ?? '').trim());
    const bare = !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    const name = url.hostname.toLowerCase();
    return (url.protocol === 'https:' || url.protocol === 'http:') && bare && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name)
      ? [name]
      : [];
  } catch {
    return [];
  }
}

// tailscaled sets this on requests that reach Serve through Tailscale Funnel (the public internet)
// and drops copies sent by clients, so only Funnel traffic carries it.
export const FUNNEL_HEADER = 'tailscale-funnel-request';

export function isFunnelRequest(headers: Record<string, string | string[] | undefined>): boolean {
  return headers[FUNNEL_HEADER] !== undefined;
}

export function isTailnetClient(
  remoteAddress: string | undefined,
  localAddress: string | undefined,
  ownAddresses: readonly string[],
): boolean {
  const ranges = tailnetRanges();
  const own = new BlockList();
  for (const address of ownAddresses) {
    const family = isIP(address);
    if (family && contains(ranges, address)) own.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
  }
  return contains(ranges, remoteAddress) && contains(own, localAddress);
}

export function isLocalClient(
  address: string | undefined,
  connectedNetworks: readonly string[] = Object.values(networkInterfaces()).flatMap(
    (entries) => entries?.flatMap((entry) => entry.cidr ? [entry.cidr] : []) ?? [],
  ),
): boolean {
  if (!address) return false;
  const normalized = address.split('%')[0];
  const family = isIP(normalized);
  if (!family) return false;
  const allowed = new BlockList();
  const networks = ['127.0.0.0/8', '::1/128', '169.254.0.0/16', 'fe80::/10', ...connectedNetworks];
  for (const network of networks) {
    const [subnet, prefixText, extra] = network.split('/');
    const subnetFamily = isIP(subnet);
    const prefix = Number(prefixText);
    if (extra !== undefined || !subnetFamily || !/^\d+$/.test(prefixText ?? '')
      || prefix <= 0 || prefix > (subnetFamily === 4 ? 32 : 128)) continue;
    allowed.addSubnet(subnet, prefix, subnetFamily === 4 ? 'ipv4' : 'ipv6');
  }
  return allowed.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}