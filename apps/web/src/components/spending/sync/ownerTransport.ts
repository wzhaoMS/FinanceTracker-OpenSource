import { api } from '../../../services/api';
import type { HttpMethod, OwnerTransport, TransportResult } from './ownerClient';

/**
 * The live transport: every owner call goes through `services/api.ts` `api()`
 * on the page's own origin, with the session cookie and `X-Holdr-Request: 1`
 * (the login branch's CSRF header). Nothing here ever sets `Authorization`:
 * owner routes refuse any credential but the session.
 *
 * `api()` throws on a non-2xx answer with the status and body in the message
 * (the login branch's `ApiError` also carries them as fields); both are read
 * here, and the body is parsed as JSON when it is JSON. A 2xx answer that is
 * not JSON (a page server's HTML fallback) comes back as `other`, so the
 * client can tell "Holdr has no owner API" apart from a real answer.
 */
const STATUS_PREFIX = /^(\d{3})\b[^:]*:\s?([\s\S]*)$/;

function statusAndBody(error: unknown): { status: number; text: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { status?: unknown; body?: unknown; message?: unknown };
  if (typeof record.status === 'number' && typeof record.body === 'string') return { status: record.status, text: record.body };
  if (typeof record.message !== 'string') return null;
  const match = STATUS_PREFIX.exec(record.message);
  return match ? { status: Number(match[1]), text: match[2] } : null;
}

export const apiOwnerTransport: OwnerTransport = {
  async request(method: HttpMethod, path: string, body?: unknown): Promise<TransportResult> {
    try {
      const value = await api<unknown>(path, {
        method,
        body: method === 'POST' ? body ?? {} : undefined,
        headers: { 'X-Holdr-Request': '1' },
      });
      return value === undefined ? { kind: 'other', status: 204 } : { kind: 'json', status: 200, body: value };
    } catch (error) {
      if (error instanceof SyntaxError) return { kind: 'other', status: 200 };
      const failed = statusAndBody(error);
      if (!failed) return { kind: 'network' };
      try {
        return { kind: 'json', status: failed.status, body: JSON.parse(failed.text) as unknown };
      } catch {
        return { kind: 'other', status: failed.status };
      }
    }
  },
};
