import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

/** A loopback server the guard's harness specs start, and what reached it. */
export interface Recorder {
  url: string;
  /** Each HTTP request (`http <path>`) and WebSocket upgrade (`websocket <path>`). */
  reached: string[];
  close: () => Promise<void>;
}

/** The second loopback origin, which stands in for every other host. */
export interface Elsewhere extends Recorder {
  /** TCP connections it accepted since the last reset, with a request or without (a preconnect). */
  connections: () => number;
  reset: () => void;
}

export async function listen(server: http.Server | https.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const scheme = server instanceof https.Server ? 'https' : 'http';
  return `${scheme}://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export const closeServer = (server: http.Server | https.Server) => () => new Promise<void>((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
});

/** A DER element, as X.509 encodes one: its tag, its length, its contents. */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}
const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
function objectId(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const group = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) group.unshift((value & 0x7f) | 0x80);
    bytes.push(...group);
  }
  return der(0x06, Buffer.from(bytes));
}
const utcTime = (date: Date) => der(0x17, Buffer.from(date.toISOString().replace(/^\d\d|[-:T]|\.\d+/g, '')));

/**
 * A certificate for 127.0.0.1 and localhost, signed by its own new key and valid for a day either
 * side of now, for a harness run's HTTPS server: the test browser accepts it with
 * ignoreHTTPSErrors. It is made in memory, with no dependency or external tool, and never stored.
 */
export function selfSignedCertificate(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdsaWithSha256 = sequence(objectId('1.2.840.10045.4.3.2'));
  // CN=127.0.0.1, a UTF8String in a one-attribute RDN.
  const name = sequence(der(0x31, sequence(objectId('2.5.4.3'), der(0x0c, Buffer.from('127.0.0.1')))));
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const now = Date.now();
  // subjectAltName: iPAddress [7] 127.0.0.1 and dNSName [2] localhost.
  const altNames = sequence(der(0x87, Buffer.from([127, 0, 0, 1])), der(0x82, Buffer.from('localhost')));
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), // version 3
    der(0x02, serial),
    ecdsaWithSha256,
    name,
    sequence(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(sequence(objectId('2.5.29.17'), der(0x04, altNames)))),
  );
  const body = sequence(tbs, ecdsaWithSha256, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey))).toString('base64');
  const cert = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  if (!new X509Certificate(cert).verify(publicKey)) throw new Error('the harness certificate does not verify');
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert };
}

/** Records whatever reaches it, and answers every request and WebSocket upgrade. */
export async function elsewhereServer(): Promise<Elsewhere> {
  const reached: string[] = [];
  let connections = 0;
  const server = http.createServer((req, res) => {
    reached.push(`http ${req.url}`);
    res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/javascript' });
    res.end('');
  });
  server.on('connection', () => { connections++; });
  server.on('upgrade', (req, socket) => {
    reached.push(`websocket ${req.url}`);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  return {
    url: await listen(server),
    reached,
    connections: () => connections,
    reset: () => {
      reached.length = 0;
      connections = 0;
    },
    close: closeServer(server),
  };
}
