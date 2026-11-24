import type { IncomingMessage } from 'node:http';
import { isLoopbackAddress, isLoopbackHost, isProxiedRequest, isServeClient, proxyClientAddress } from './network.js';
import { admissionRefusal, type HoldrIngressFacts, type ListenerConfig } from './types.js';

export interface ProfileRefusal { readonly refuse: 400 | 403 | 421 | 503; readonly code: string }

export function rawHeaderValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1]);
  }
  return values;
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const values = rawHeaderValues(req, name);
  return values.length === 1 ? values[0] : undefined;
}

export function classifyListenerRequest(req: IncomingMessage, config: ListenerConfig): HoldrIngressFacts | ProfileRefusal {
  const host = singleHeader(req, 'host')?.toLowerCase();
  if (host === undefined) return { refuse: 400, code: 'host-invalid' };
  if (req.headers['tailscale-funnel-request'] !== undefined) return { refuse: 403, code: 'funnel-refused' };
  const base = { listener: config.listener, mode: config.mode };
  if (config.mode === 'dev') return Object.freeze({ ...base, profile: 'dev', clientAddress: proxyClientAddress(req) });
  if (config.mode === 'dist' && config.listener === 'ingress') {
    // A miswired TCP server must not manufacture the Unix-only profile from forged headers.
    if (req.socket.remoteAddress !== undefined) return { refuse: 421, code: 'misdirected-request' };
    if (host !== 'localhost') return { refuse: 421, code: 'misdirected-request' };
    const publicHost = new URL(config.publicOrigin).hostname;
    const forwardedHost = singleHeader(req, 'x-forwarded-host')?.toLowerCase();
    if (forwardedHost !== publicHost && forwardedHost !== `${publicHost}:443`) return { refuse: 421, code: 'misdirected-request' };
    if (singleHeader(req, 'x-forwarded-proto') !== 'https') return { refuse: 400, code: 'forwarding-headers-invalid' };
    const address = singleHeader(req, 'x-forwarded-for');
    if (address === undefined || !isServeClient(address)) return { refuse: 400, code: 'forwarding-headers-invalid' };
    if (['forwarded', 'via', 'x-real-ip'].some((name) => req.headers[name] !== undefined)) {
      return { refuse: 400, code: 'forwarding-headers-invalid' };
    }
    const refused = admissionRefusal(config.admission);
    if (refused) return { refuse: 503, code: refused };
    return Object.freeze({ ...base, profile: 'serve', clientAddress: address });
  }
  if (isProxiedRequest(req)) return { refuse: 400, code: 'proxied-request-refused' };
  if (!isLoopbackAddress(req.socket.remoteAddress)) return { refuse: 421, code: 'misdirected-request' };
  if (config.listener === 'local') {
    if (!isLoopbackHost(host)) return { refuse: 421, code: 'misdirected-request' };
    return Object.freeze({ ...base, profile: 'direct', clientAddress: req.socket.remoteAddress! });
  }
  if (host !== `127.0.0.1:${config.port}` && host !== `localhost:${config.port}`) return { refuse: 421, code: 'misdirected-request' };
  const refused = admissionRefusal(config.admission);
  if (refused) return { refuse: 503, code: refused };
  return Object.freeze({ ...base, profile: 'local-browser', clientAddress: req.socket.remoteAddress! });
}
