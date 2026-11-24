/**
 * The acceptance suite's throwaway TLS identity (tests/acceptance): a valid
 * self-signed server certificate for exactly one host, short-lived, whose
 * SPKI hash is the one Chromium's pin compares, and the Serve stand-in in
 * front of a loopback upstream forwarding as Tailscale Serve does.
 */
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { selfSignedIdentity } from '../acceptance/selfSigned.js';
import { startServeStandIn } from '../acceptance/serve.js';

test('the throwaway certificate: one host, self-signed, server auth, two days; the pin is its SPKI SHA-256', () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  const identity = selfSignedIdentity('holdr.test', now);
  const cert = new X509Certificate(identity.cert);
  assert.equal(cert.subjectAltName, 'DNS:holdr.test');
  assert.equal(cert.subject, 'CN=holdr.test');
  assert.equal(cert.issuer, cert.subject);
  assert.equal(cert.ca, false);
  assert.ok(cert.verify(cert.publicKey));
  assert.equal(cert.checkHost('holdr.test'), 'holdr.test');
  assert.equal(cert.checkHost('node3.example.ts.net'), undefined);
  assert.deepEqual(cert.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.ok(Date.parse(cert.validFrom) <= now.getTime());
  assert.ok(Date.parse(cert.validTo) - now.getTime() <= 2 * 86_400_000);
  const spki = cert.publicKey.export({ type: 'spki', format: 'der' });
  assert.equal(identity.spkiSha256, createHash('sha256').update(spki).digest('base64'));
  assert.notEqual(selfSignedIdentity('holdr.test').spkiSha256, identity.spkiSha256, 'a fresh key every time');
  assert.throws(() => selfSignedIdentity('holdr.test/../x'));
});

test('the Serve stand-in terminates TLS for its host and forwards as Serve does, dropping what the browser claimed', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    res.writeHead(201, { 'content-type': 'application/json', connection: 'keep-alive', 'x-holdr-error': 'none' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const identity = selfSignedIdentity('holdr.test');
  const serve = await startServeStandIn({ identity, publicHost: 'holdr.test', upstream: { port: (upstream.address() as AddressInfo).port } });
  try {
    const answer = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const request = https.request(
        {
          host: '127.0.0.1',
          port: serve.port,
          servername: 'holdr.test',
          ca: identity.cert,
          method: 'POST',
          path: '/card-sync/runs?x=1',
          headers: {
            'content-type': 'application/json',
            forwarded: 'for=203.0.113.9',
            via: '1.1 elsewhere',
            'x-forwarded-for': '203.0.113.9',
            'x-forwarded-host': 'evil.test',
            'x-real-ip': '203.0.113.9',
          },
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
        },
      );
      request.on('error', reject);
      request.end('{}');
    });
    assert.equal(answer.status, 201);
    assert.equal(answer.body, '{"ok":true}');
    assert.equal(answer.headers['x-holdr-error'], 'none');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].host, 'localhost');
    assert.equal(seen[0]['x-forwarded-host'], 'holdr.test');
    assert.equal(seen[0]['x-forwarded-proto'], 'https');
    assert.equal(seen[0]['x-forwarded-for'], '100.101.102.103');
    for (const name of ['forwarded', 'via', 'x-real-ip']) assert.equal(seen[0][name], undefined, name);
    // The query is passed on (Holdr refuses it); only method, path and status are recorded.
    assert.deepEqual(serve.requests, [{ method: 'POST', path: '/card-sync/runs', status: 201 }]);
  } finally {
    await serve.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
