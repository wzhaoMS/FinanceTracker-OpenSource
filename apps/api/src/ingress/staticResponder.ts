import type { RequestHandler } from 'express';
import { classifyPath } from './classify.js';
import { isDirectLoopback } from './network.js';
import { parseIngressTarget } from './requestTarget.js';
import { applySecurityHeaders, sendRefusal } from './securityHeaders.js';
import { admissionRefusal, type WebIngressOptions } from './types.js';

export function etagMatches(value: string | string[] | undefined, etag: string): boolean {
  if (value === undefined) return false;
  const text = (Array.isArray(value) ? value.join(',') : value).trim();
  if (text === '*') return true;
  // Parse the whole field: commas inside an opaque tag are not list separators.
  const token = /\s*((?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")\s*(,|$)/y;
  let offset = 0;
  let matches = false;
  while (offset < text.length) {
    token.lastIndex = offset;
    const match = token.exec(text);
    if (!match || (match[2] === ',' && token.lastIndex === text.length)) return false;
    matches ||= match[1].replace(/^W\//, '') === etag;
    offset = token.lastIndex;
  }
  return matches;
}

export function createWebIngress(options: WebIngressOptions = { mode: 'dev' }): RequestHandler {
  return (req, res, next) => {
    const parsed = req.holdrTarget ?? parseIngressTarget(req.url);
    if ('refuse' in parsed) return sendRefusal(req, res, parsed.refuse, parsed.code);
    if (req.headers['tailscale-funnel-request'] !== undefined) return sendRefusal(req, res, 403, 'funnel-refused');
    const facts = req.holdrIngress;
    if (options.mode !== 'dev') {
      // createApp alone must not accidentally become an alternative, unclassified production listener.
      if (!facts || facts.mode !== options.mode) return sendRefusal(req, res, 503, 'ingress-unverified');
      if (facts.profile === 'serve' || facts.profile === 'local-browser') {
        const refused = admissionRefusal(options.admission);
        if (refused) return sendRefusal(req, res, 503, refused);
      }
    }
    const staticAllowed = options.mode !== 'dev'
      && facts?.listener === 'ingress'
      && ((options.mode === 'dist' && facts.profile === 'serve') || (options.mode === 'local' && facts.profile === 'local-browser'));
    const classified = classifyPath(req.method, parsed, staticAllowed ? options.release : undefined, isDirectLoopback(req));
    if (classified.kind === 'api') {
      if (facts?.profile === 'direct' && req.method === 'POST' && parsed.first === 'auth') {
        return sendRefusal(req, res, 403, 'auth-not-on-local-listener');
      }
      return next();
    }
    if (classified.kind === 'not-found') return sendRefusal(req, res, 404, 'not-found');
    if (classified.kind === 'method-not-allowed') return sendRefusal(req, res, 405, 'method-not-allowed', 'GET, HEAD');
    const { file, kind } = classified;
    applySecurityHeaders(res, kind, facts?.profile === 'serve');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', file.size);
    res.setHeader('ETag', file.etag);
    res.setHeader('Cache-Control', kind === 'document' ? 'no-cache' : 'public, max-age=31536000, immutable');
    res.setHeader('Accept-Ranges', 'none');
    if (etagMatches(req.headers['if-none-match'], file.etag)) {
      res.statusCode = 304;
      res.removeHeader('Content-Length');
      res.end();
      return;
    }
    res.statusCode = 200;
    res.end(req.method === 'HEAD' ? undefined : file.bytes());
  };
}
