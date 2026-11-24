import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIngressTarget } from '../../ingress/requestTarget.js';
import { deviceBody, deviceBodyReader } from './deviceBody.js';
import { DEVICE_EXTENSION_ORIGINS, assertDeviceCors, deviceCors, devicePreflight } from './deviceCors.js';
import { DEVICE_UPLOAD_BODY_BYTES, DeviceHttpError } from './deviceProtocol.js';

const TOKEN = `hdv1_${'a'.repeat(64)}`;
const AUTH = ['Authorization', `HoldrDevice ${TOKEN}`];
const sockets: Socket[] = [];
afterEach(() => { vi.useRealTimers(); for (const socket of sockets.splice(0)) socket.destroy(); });

function exchange(method = 'POST', path = '/card-sync/observations', headers = [...AUTH, 'Content-Type', 'application/json']) {
  const socket = new Socket();
  sockets.push(socket);
  const req = new IncomingMessage(socket) as Request;
  req.method = method;
  req.url = path;
  req.rawHeaders = headers;
  const target = parseIngressTarget(path);
  if ('refuse' in target) throw Error('fixture path');
  req.holdrTarget = target;
  const fields = new Map<string, unknown>();
  const res = Object.assign(new EventEmitter(), {
    statusCode: 0, ended: false,
    setHeader(name: string, value: unknown) { fields.set(name.toLowerCase(), value); },
    removeHeader(name: string) { fields.delete(name.toLowerCase()); },
    vary(name: string) { fields.set('vary', `${fields.get('vary') ?? ''},${name}`); },
    status(code: number) { this.statusCode = code; return this; },
    end() { this.ended = true; },
  });
  return { req, res: res as unknown as Response, rawRes: res, fields, next: vi.fn() };
}

describe('bounded device bodies before authorization.lock', () => {
  it('retains the exact received byte sequence and does not reply or invoke a repository', () => {
    const f = exchange();
    deviceBodyReader(f.req, f.res, f.next);
    const bytes = Buffer.from('{"payload":{"literal":"é"},"runId":"not-yet-validated"}');
    f.req.emit('data', bytes.subarray(0, 17));
    f.req.emit('data', bytes.subarray(17));
    expect(f.next).not.toHaveBeenCalled();
    f.req.emit('end');
    expect(f.next).toHaveBeenCalledOnce();
    expect(deviceBody(f.req)).toEqual(bytes);
    expect(f.rawRes.ended).toBe(false);
  });

  it.each(['text/plain', 'application/json; charset=iso-8859-1', 'application/json; charset="utf-8'])('retains a media-type refusal (%s) for the guarded handler', (type) => {
    const f = exchange('POST', '/card-sync/observations', [...AUTH, 'Content-Type', type]);
    deviceBodyReader(f.req, f.res, f.next);
    expect(f.next).toHaveBeenCalledOnce();
    expect(() => deviceBody(f.req)).toThrowError(DeviceHttpError);
    try { deviceBody(f.req); } catch (error) {
      expect(error).toMatchObject({ status: 415, code: 'unsupported-media-type', runRefusal: 'payload-invalid' });
    }
    expect(f.rawRes.ended).toBe(false);
    expect(f.fields.get('connection')).toBe('close');
  });

  it.each(['application/json', 'application/json; charset=utf-8', 'application/json; charset="UTF-8"'])('accepts only uncompressed UTF-8 JSON metadata (%s)', (type) => {
    const f = exchange('POST', '/card-sync/runs', [...AUTH, 'Content-Type', type]);
    deviceBodyReader(f.req, f.res, f.next);
    f.req.emit('data', Buffer.from('{}'));
    f.req.emit('end');
    expect(deviceBody(f.req)).toEqual(Buffer.from('{}'));
  });

  it('refuses compressed input, declared oversized input and chunked oversized input without buffering it', () => {
    for (const extra of [['Content-Encoding', 'gzip'], ['Content-Length', String(DEVICE_UPLOAD_BODY_BYTES + 1)], []]) {
      const f = exchange('POST', '/card-sync/observations', [...AUTH, 'Content-Type', 'application/json', ...extra]);
      deviceBodyReader(f.req, f.res, f.next);
      if (extra.length === 0) f.req.emit('data', Buffer.alloc(DEVICE_UPLOAD_BODY_BYTES + 1));
      expect(f.next).toHaveBeenCalledOnce();
      expect(() => deviceBody(f.req)).toThrowError(DeviceHttpError);
      expect(f.rawRes.ended).toBe(false);
    }
  });

  it('leaves credentials untouched for D while buffering bounded bytes, and does not touch owner paths', () => {
    const mixed = exchange('POST', '/card-sync/observations', [...AUTH, 'Cookie', 'session=private', 'Content-Type', 'application/json']);
    deviceBodyReader(mixed.req, mixed.res, mixed.next);
    expect(mixed.next).not.toHaveBeenCalled();
    mixed.req.emit('data', Buffer.from('{}'));
    mixed.req.emit('end');
    expect(mixed.next).toHaveBeenCalledOnce();
    expect(deviceBody(mixed.req)).toEqual(Buffer.from('{}'));
    const owner = exchange('POST', '/card-sync/owner/pairings', ['Cookie', 'session=private']);
    deviceBodyReader(owner.req, owner.res, owner.next);
    expect(owner.next).toHaveBeenCalledOnce();
    expect(() => deviceBody(owner.req)).toThrow('bad-request');
    expect(owner.fields.size).toBe(0);
  });

  it('bounds an incomplete body and does not let an aborted stream trigger late work or an uncaught error', () => {
    vi.useFakeTimers();
    const timeout = exchange();
    deviceBodyReader(timeout.req, timeout.res, timeout.next);
    vi.advanceTimersByTime(15_000);
    expect(timeout.next).toHaveBeenCalledOnce();
    expect(() => deviceBody(timeout.req)).toThrow('bad-request');
    const aborted = exchange();
    deviceBodyReader(aborted.req, aborted.res, aborted.next);
    aborted.req.emit('data', Buffer.from('{'));
    aborted.req.emit('aborted');
    expect(() => aborted.req.emit('error', Error('PRIVATE_CANARY'))).not.toThrow();
    vi.advanceTimersByTime(15_000);
    expect(aborted.next).not.toHaveBeenCalled();
  });
});

describe('fixed extension CORS, never on the owner namespace', () => {
  it('prepares headers for a fixed production extension, without treating CORS as device authorization', () => {
    const f = exchange('GET', '/card-sync/capabilities', ['Origin', DEVICE_EXTENSION_ORIGINS[0]]);
    deviceCors(f.req, f.res, f.next);
    expect(f.fields.get('access-control-allow-origin')).toBe(DEVICE_EXTENSION_ORIGINS[0]);
    expect(f.fields.has('access-control-allow-credentials')).toBe(false);
    expect(f.rawRes.ended).toBe(false);
    expect(() => assertDeviceCors(f.req)).not.toThrow();
  });

  it.each(['null', 'https://holdr.test', 'chrome-extension://icilknejhlhobkgcejnkbhbebnkfldmc', '*'])('refuses %s without reflecting it', (origin) => {
    const f = exchange('GET', '/card-sync/capabilities', ['Origin', origin]);
    f.fields.set('access-control-allow-origin', '*');
    deviceCors(f.req, f.res, f.next);
    expect(f.fields.has('access-control-allow-origin')).toBe(false);
    expect(() => assertDeviceCors(f.req)).toThrow('credential-not-allowed');
  });

  it('never adds CORS to owner routes and permits origin-less scripted device clients without CORS', () => {
    for (const [path, headers] of [
      ['/card-sync/owner/state', ['Origin', DEVICE_EXTENSION_ORIGINS[0]]],
      ['/card-sync/capabilities', []],
    ] as const) {
      const f = exchange('GET', path, [...headers]);
      deviceCors(f.req, f.res, f.next);
      expect(f.fields.has('access-control-allow-origin')).toBe(false);
    }
  });

  it('allows only the exact method/header preflight and still requires its guarded callback', () => {
    const headers = [
      'Origin', DEVICE_EXTENSION_ORIGINS[0], 'Access-Control-Request-Method', 'POST',
      'Access-Control-Request-Headers', 'Authorization, Content-Type, X-Holdr-Client, X-Holdr-Client-Version, Idempotency-Key',
    ];
    const good = exchange('OPTIONS', '/card-sync/observations', headers);
    deviceCors(good.req, good.res, good.next);
    expect(good.rawRes.ended).toBe(false);
    devicePreflight(good.req, good.res);
    expect(good.rawRes.statusCode).toBe(204);
    for (const extra of [['Cookie', ''], ['Authorization', `HoldrDevice ${TOKEN}`]]) {
      const bad = exchange('OPTIONS', '/card-sync/observations', [...headers, ...extra]);
      deviceCors(bad.req, bad.res, bad.next);
      expect(() => devicePreflight(bad.req, bad.res)).toThrow('unauthorized');
    }
    const other = exchange('OPTIONS', '/card-sync/observations', [...headers.slice(0, 4), 'Access-Control-Request-Headers', 'Authorization, X-Other']);
    deviceCors(other.req, other.res, other.next);
    expect(() => assertDeviceCors(other.req)).toThrow('credential-not-allowed');
  });

  it('does not approve a malformed route or a skipped CORS middleware as a preflight', () => {
    for (const path of ['/card-sync/runs/bad/receipt', '/card-sync/observations/']) {
      const f = exchange('OPTIONS', path, []);
      deviceCors(f.req, f.res, f.next);
      expect(() => devicePreflight(f.req, f.res)).toThrow('credential-not-allowed');
      expect(f.rawRes.ended).toBe(false);
    }
    const missing = exchange('OPTIONS', '/card-sync/observations', []);
    expect(() => devicePreflight(missing.req, missing.res)).toThrow('credential-not-allowed');
  });
});
