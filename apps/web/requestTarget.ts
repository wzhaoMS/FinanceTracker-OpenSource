import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';

export const isOriginForm = (target: string | undefined): target is string =>
  typeof target === 'string' && target.startsWith('/') && !target.startsWith('//')
  && !target.includes('\\') && !target.includes('#');

export function parseRequestTarget(target: string | undefined) {
  if (!isOriginForm(target)) return undefined;
  const rawPath = target.replace(/[?#].*$/, '');
  if (/%(?:2f|5c|25|00|3f|23)/i.test(rawPath)) return undefined;
  try {
    const pathname = decodeURIComponent(rawPath);
    // HTML and static/transform decoders must agree on the same path.
    if (decodeURI(rawPath) !== pathname) return undefined;
    if (path.posix.normalize(pathname).toLowerCase().startsWith('/__open-in-editor')) return undefined;
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) return undefined;
    return { rawPath, pathname, query: target.slice(rawPath.length) };
  } catch {
    return undefined;
  }
}

type UpgradeOptions = {
  hmrPath?: string;
  handshakeTimeoutMs?: number;
  clientErrorTimeoutMs?: number;
};

type RoutedEvent = 'request' | 'upgrade';
type Listener = Parameters<EventEmitter['on']>[1];
type RawListener = Listener & { listener?: Listener };
const isRouted = (event: string | symbol): event is RoutedEvent => event === 'request' || event === 'upgrade';
const installed = new WeakSet<EventEmitter>();

export function guardHttpDispatch(server: EventEmitter, options: UpgradeOptions = {}) {
  if (installed.has(server)) return;
  installed.add(server);
  const { hmrPath, handshakeTimeoutMs = 3000, clientErrorTimeoutMs = 1000 } = options;
  const registry = new EventEmitter().setMaxListeners(server.getMaxListeners());
  const original = {
    on: server.on.bind(server),
    once: server.once.bind(server),
    prependListener: server.prependListener.bind(server),
    prependOnceListener: server.prependOnceListener.bind(server),
    removeListener: server.removeListener.bind(server),
    removeAllListeners: server.removeAllListeners.bind(server),
    listeners: server.listeners.bind(server),
    rawListeners: server.rawListeners.bind(server),
    listenerCount: server.listenerCount.bind(server),
    eventNames: server.eventNames.bind(server),
    setMaxListeners: server.setMaxListeners.bind(server),
  };
  const retiring = new WeakSet<Socket>();
  original.on('clientError', (_error: Error, socket: Socket) => {
    if (socket.destroyed || retiring.has(socket)) return;
    retiring.add(socket);
    // Keep Vite's 400/431 response, but never wait indefinitely for the peer's FIN.
    const timer = setTimeout(() => socket.destroy(), clientErrorTimeoutMs);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
  });
  const events: RoutedEvent[] = ['request', 'upgrade'];
  for (const event of events) {
    const listeners = original.rawListeners(event) as RawListener[];
    original.removeAllListeners(event);
    for (const listener of listeners) registry.on(event, listener);
  }

  registry.on('removeListener', (event: string | symbol, listener: Listener) => {
    if (isRouted(event)) server.emit('removeListener', event, listener);
  });

  const dispatchers = new Map<RoutedEvent, Listener>();
  for (const event of events) {
    const dispatch: Listener = (...args) => {
      const req = args[0] as IncomingMessage & { originalUrl?: string };
      const socket = event === 'upgrade' ? args[1] as Socket : undefined;
      const writtenBefore = socket?.bytesWritten;
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      if (socket) {
        const destroy = () => { socket.destroy(); };
        const cleanup = () => {
          clearTimeout(handshakeTimer);
          socket.off('end', destroy);
          socket.off('error', destroy);
        };
        socket.once('end', destroy);
        socket.once('error', destroy);
        socket.once('close', cleanup);
        handshakeTimer = setTimeout(() => {
          if (socket.bytesWritten === writtenBefore || socket.writableEnded) socket.destroy();
        }, handshakeTimeoutMs);
        handshakeTimer.unref();
        // Unclaimed upgrade sockets otherwise stay paused and may never observe the peer's FIN.
        socket.resume();
      }
      const refuse = (status: 400 | 403) => {
        if (socket) {
          if (socket.destroyed || socket.writableEnded || socket.bytesWritten !== writtenBefore) {
            socket.destroy();
          } else {
            socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Request'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
          }
        } else {
          const res = args[1] as ServerResponse;
          if (res.headersSent || res.writableEnded || res.destroyed) {
            res.destroy();
          } else {
            res.writeHead(status, { Connection: 'close', 'Content-Length': '0' });
            res.end();
          }
        }
      };
      const parsed = parseRequestTarget(req.url);
      if (!parsed || (req.originalUrl !== undefined && !parseRequestTarget(req.originalUrl))) {
        refuse(403);
        return;
      }
      const upgradeHeader = req.headers?.upgrade;
      const protocol = req.headers?.['sec-websocket-protocol'];
      if (socket && (!hmrPath || parsed.rawPath !== hmrPath || req.method !== 'GET'
        || typeof upgradeHeader !== 'string' || upgradeHeader.toLowerCase() !== 'websocket'
        || (protocol !== 'vite-hmr' && protocol !== 'vite-ping'))) {
        refuse(403);
        return;
      }
      if (socket && protocol === 'vite-ping') {
        const key = req.headers['sec-websocket-key'];
        if (req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string'
          || !/^[A-Za-z0-9+/]{22}==$/.test(key)
          || Buffer.from(key, 'base64').length !== 16 || Buffer.from(key, 'base64').toString('base64') !== key) {
          refuse(400);
          return;
        }
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        // The client needs only WebSocket open. Never give ping head/data bytes to Vite/ws.
        socket.on('error', () => {});
        socket.end(Buffer.concat([
          Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: vite-ping\r\n\r\n`),
          Buffer.from([0x88, 0x02, 0x03, 0xe8]),
        ]), () => socket.destroy());
        return;
      }
      try {
        // Snapshot like EventEmitter.emit; raw once wrappers retain their removal/fired semantics.
        for (const listener of registry.rawListeners(event)) listener.apply(server, args);
      } catch {
        // Connect and HMR parse before middleware. Never let a synchronous parser throw escape.
        refuse(400);
      }
      if (socket && !socket.writableEnded && socket.bytesWritten !== writtenBefore) clearTimeout(handshakeTimer);
    };
    dispatchers.set(event, dispatch);
  }

  const add = (event: string | symbol, listener: Listener, once: boolean, prepend: boolean) => {
    if (!isRouted(event)) {
      return once
        ? (prepend ? original.prependOnceListener : original.once)(event, listener)
        : (prepend ? original.prependListener : original.on)(event, listener);
    }
    server.emit('newListener', event, once ? listener : ((listener as RawListener).listener ?? listener));
    if (once) {
      // Registry-owned once wrappers must still call user callbacks with the HTTP server as this.
      const callback = listener.bind(server);
      if (prepend) registry.prependOnceListener(event, callback);
      else registry.once(event, callback);
      const listeners = registry.rawListeners(event) as RawListener[];
      listeners[prepend ? 0 : listeners.length - 1].listener = listener;
    } else if (prepend) {
      registry.prependListener(event, listener);
    } else {
      registry.on(event, listener);
    }
    return server;
  };
  const remove = (event: string | symbol, listener: Listener) => {
    if (isRouted(event)) {
      registry.removeListener(event, listener);
      return server;
    }
    return original.removeListener(event, listener);
  };

  // Later proxy/plugin registrations must not become unguarded Node listeners. Preserve the
  // public listener identities so Vite's off("upgrade", originalHmrListener) still works.
  Object.assign(server, {
    on: (event: string | symbol, listener: Listener) => add(event, listener, false, false),
    addListener: (event: string | symbol, listener: Listener) => add(event, listener, false, false),
    prependListener: (event: string | symbol, listener: Listener) => add(event, listener, false, true),
    once: (event: string | symbol, listener: Listener) => add(event, listener, true, false),
    prependOnceListener: (event: string | symbol, listener: Listener) => add(event, listener, true, true),
    off: remove,
    removeListener: remove,
    removeAllListeners: (event?: string | symbol) => {
      if (event === undefined) {
        for (const name of events) registry.removeAllListeners(name);
        original.removeAllListeners();
        for (const [name, dispatch] of dispatchers) original.on(name, dispatch);
      } else if (isRouted(event)) {
        registry.removeAllListeners(event);
      } else {
        original.removeAllListeners(event);
      }
      return server;
    },
    listeners: (event: string | symbol) => isRouted(event) ? registry.listeners(event) : original.listeners(event),
    rawListeners: (event: string | symbol) => isRouted(event) ? registry.rawListeners(event) : original.rawListeners(event),
    listenerCount: (event: string | symbol, listener?: Listener) =>
      isRouted(event) ? registry.listenerCount(event, listener) : original.listenerCount(event, listener),
    eventNames: () => original.eventNames().filter((event) => !isRouted(event) || registry.listenerCount(event) > 0),
    setMaxListeners: (count: number) => {
      registry.setMaxListeners(count);
      original.setMaxListeners(count);
      return server;
    },
  });
  for (const [event, dispatch] of dispatchers) original.on(event, dispatch);
}
