import type { RequestHandler } from 'express';
import { sendRefusal } from './securityHeaders.js';

export interface ParsedIngressTarget {
  readonly rawPath: string;
  readonly query: string;
  readonly segments: readonly string[];
  readonly first: string;
}
export interface TargetRefusal { readonly refuse: 400 | 404 | 414; readonly code: string }

const UNRESERVED_ESCAPE = /%(?:4[1-9A-F]|5[0-9AF]|6[1-9A-F]|7[0-9AE]|3[0-9]|2[DE])/i;

export function parseIngressTarget(target: string | undefined): ParsedIngressTarget | TargetRefusal {
  if (typeof target !== 'string') return { refuse: 400, code: 'request-target-form' };
  if (Buffer.byteLength(target) > 4096) return { refuse: 414, code: 'uri-too-long' };
  if (!target.startsWith('/') || target.startsWith('//')) return { refuse: 400, code: 'request-target-form' };
  const q = target.indexOf('?');
  const rawPath = q === -1 ? target : target.slice(0, q);
  const query = q === -1 ? '' : target.slice(q);
  if (Buffer.byteLength(rawPath) > 2048) return { refuse: 414, code: 'uri-too-long' };
  if (!/^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]+$/.test(rawPath) || /[^\x21-\x7e]|#|\\/.test(query)) {
    return { refuse: 400, code: 'request-target-chars' };
  }
  if (/%(?![0-9A-Fa-f]{2})/.test(rawPath)) return { refuse: 400, code: 'bad-percent-encoding' };
  if (/%(?:2f|5c|25|00|3f|23|[01][0-9a-f]|7f)/i.test(rawPath)) return { refuse: 400, code: 'forbidden-escape' };
  if (UNRESERVED_ESCAPE.test(rawPath)) return { refuse: 400, code: 'non-canonical-escape' };
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
    if (decodeURI(rawPath) !== decoded) return { refuse: 400, code: 'forbidden-escape' };
  } catch {
    return { refuse: 400, code: 'bad-percent-encoding' };
  }
  const segments = decoded.split('/').slice(1);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === '' && segments.length !== 1 && i !== segments.length - 1) return { refuse: 400, code: 'empty-path-segment' };
    if (segment === '.' || segment === '..') return { refuse: 400, code: 'dot-segment' };
  }
  if (decoded.toLowerCase().startsWith('/__open-in-editor')) return { refuse: 404, code: 'not-found' };
  return Object.freeze({ rawPath, query, segments: Object.freeze(segments), first: rawPath.split('/')[1].toLowerCase() });
}

export const requestTargetGuard: RequestHandler = (req, res, next) => {
  const parsed = parseIngressTarget(req.originalUrl ?? req.url);
  if ('refuse' in parsed) return sendRefusal(req, res, parsed.refuse, parsed.code);
  req.holdrTarget = parsed;
  next();
};
