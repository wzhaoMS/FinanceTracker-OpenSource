import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import { deviceCorsFailure } from './deviceCors.js';
import {
  DEVICE_SMALL_BODY_BYTES, DEVICE_UPLOAD_BODY_BYTES, DeviceHttpError, deviceEndpoint,
  singleDeviceHeader,
} from './deviceProtocol.js';

type BodyRead = { readonly bytes: Buffer } | { readonly error: DeviceHttpError };
const bodies = new WeakMap<IncomingMessage, BodyRead>();
const BODY_TIMEOUT_MS = 15_000;

/** Read after D and credential resolution, so even a refused upload can be associated with its authenticated run. */
export function deviceBody(req: IncomingMessage): Buffer {
  const result = bodies.get(req);
  if (!result) throw new DeviceHttpError(400, 'bad-request');
  if ('error' in result) throw result.error;
  return result.bytes;
}

/**
 * A global, path-selective parser before the device mount, never on /owner. It does no repository work and holds no
 * authorization lock while reading. Errors are retained for the guarded handler, not answered before it can record a refusal.
 */
export const deviceBodyReader: RequestHandler = (req, res, next) => {
  const endpoint = deviceEndpoint(req.holdrTarget?.rawPath ?? req.path, req.method);
  if (!endpoint || req.method !== 'POST') { next(); return; }
  const upload = endpoint.name === 'observations';
  const limit = upload ? DEVICE_UPLOAD_BODY_BYTES : DEVICE_SMALL_BODY_BYTES;
  let done = false;
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const chunks: Buffer[] = [];

  function cleanup() {
    if (timer) clearTimeout(timer);
    req.off('data', data);
    req.off('end', end);
    req.off('aborted', aborted);
  }
  function finish(result: BodyRead) {
    if (done) return;
    done = true;
    cleanup();
    bodies.set(req, result);
    chunks.length = 0;
    if ('error' in result) {
      res.setHeader('Connection', 'close');
      req.resume();
    }
    next();
  }
  function data(chunk: unknown) {
    if (!Buffer.isBuffer(chunk)) { finish({ error: new DeviceHttpError(500, 'internal-error') }); return; }
    length += chunk.length;
    if (length > limit) {
      finish({ error: new DeviceHttpError(413, 'too-large', [{ code: 'too-large', path: '$' }], upload ? 'too-large' : undefined) });
      return;
    }
    chunks.push(chunk);
  }
  function end() { finish({ bytes: Buffer.concat(chunks, length) }); }
  function failed() {
    finish({ error: new DeviceHttpError(400, 'bad-request', undefined, upload ? 'payload-invalid' : undefined) });
  }
  function aborted() {
    if (done) return;
    done = true;
    cleanup();
    chunks.length = 0;
    // Peer cancellation is not a server refusal. No response, background DB write or delayed authorization is attempted.
  }

  req.once('error', failed);
  try {
    const cors = deviceCorsFailure(req);
    if (cors) throw cors;
    const contentType = singleDeviceHeader(req, 'content-type');
    const encoding = singleDeviceHeader(req, 'content-encoding');
    if (!contentType || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i.test(contentType)
      || (encoding !== undefined && encoding.toLowerCase() !== 'identity')) {
      throw new DeviceHttpError(415, 'unsupported-media-type', undefined, upload ? 'payload-invalid' : undefined);
    }
    const contentLength = singleDeviceHeader(req, 'content-length');
    if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) {
      throw new DeviceHttpError(413, 'too-large', [{ code: 'too-large', path: '$' }], upload ? 'too-large' : undefined);
    }
  } catch (error) {
    finish({ error: error instanceof DeviceHttpError ? error : new DeviceHttpError(400, 'bad-request') });
    return;
  }
  req.on('data', data);
  req.once('end', end);
  req.once('aborted', aborted);
  timer = setTimeout(() => finish({
    error: new DeviceHttpError(408, 'bad-request', [{ code: 'unreadable', path: '$' }], upload ? 'payload-invalid' : undefined),
  }), BODY_TIMEOUT_MS);
};
