// The encrypted channel between the extension and the local receiver, shared by both sides (Web Crypto only, so it runs
// in the extension's service worker and in Node). The pairing key never travels: each request starts with a challenge
// that the receiver signs with a key derived from the pairing key, and the request and its answer are sealed with
// AES-GCM under another derived key, bound to that one challenge. A captured request cannot be replayed. The extension
// proves it holds the pairing key when it asks for a challenge, so nothing else on this computer can make the receiver
// keep one, and names its challenge in a header, so the receiver reads no request body without one.
export const CHANNEL_PREFIX = '/sync/channel';
export const MAX_CHANNEL_BYTES = 32 * 1024 * 1024;
/** The request header that names the challenge a sealed request answers. */
export const CHALLENGE_HEADER = 'x-holdr-challenge';
/** How far a challenge request's time may be from the receiver's (both run on this computer). */
export const CHALLENGE_REQUEST_SKEW_MS = 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const HEX = /^[0-9a-f]{64}$/;
export const randomHex = (bytes = 32) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
export function loopbackOrigin(value) {
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}$/.test(value)) throw new Error('Receiver must be an explicit loopback HTTP origin');
  return new URL(value).origin;
}
export function channelPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n#]/.test(value)) throw new Error('Invalid receiver path');
  const url = new URL(value, 'http://127.0.0.1');
  if (url.pathname.startsWith(CHANNEL_PREFIX)) throw new Error('Nested channel requests are not allowed');
  return url.pathname + url.search;
}
export function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
export function fromBase64(text) {
  if (typeof text !== 'string' || text.length > 46 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('Invalid encrypted envelope');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
export async function channelKeys(token, instance) {
  if (!HEX.test(token || '') || !HEX.test(instance || '')) throw new Error('Invalid pairing material');
  const material = await crypto.subtle.importKey('raw', fromHex(token), 'HKDF', false, ['deriveKey']);
  const derive = (info, algorithm, uses) => crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: fromHex(instance), info: encoder.encode(info) },
    material, algorithm, false, uses,
  );
  return {
    proof: await derive('holdr-channel-v1-server-proof', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']),
    encryption: await derive('holdr-channel-v1-encryption', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
  };
}
const proofBytes = (challenge) => encoder.encode(JSON.stringify([
  'holdr-channel-v1', challenge.nonce, challenge.ticket, challenge.instance, challenge.origin, challenge.expires,
]));
export async function signChallenge(keys, challenge) {
  return toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', keys.proof, proofBytes(challenge))));
}
export async function checkChallenge(keys, challenge) {
  return crypto.subtle.verify('HMAC', keys.proof, fromBase64(challenge.proof), proofBytes(challenge));
}
/** The key that signs a request for a challenge: derived from the pairing key alone, since no challenge exists yet. */
export async function challengeRequestKey(token) {
  if (!HEX.test(token || '')) throw new Error('Invalid pairing material');
  const material = await crypto.subtle.importKey('raw', fromHex(token), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('holdr-channel-v1-client'), info: encoder.encode('holdr-channel-v1-challenge-request') },
    material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'],
  );
}
const challengeRequestBytes = (request) => encoder.encode(JSON.stringify([
  'holdr-channel-v1-challenge-request', request.nonce, request.origin, request.at,
]));
export async function signChallengeRequest(key, request) {
  return toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, challengeRequestBytes(request))));
}
export async function checkChallengeRequest(key, request) {
  return crypto.subtle.verify('HMAC', key, fromBase64(request.proof), challengeRequestBytes(request));
}
export function frame(header, body = new Uint8Array()) {
  if (typeof body === 'string') body = encoder.encode(body);
  else body = new Uint8Array(body);
  const metadata = encoder.encode(JSON.stringify(header));
  if (metadata.length > 16384 || body.length > MAX_CHANNEL_BYTES) throw new Error('Channel message is too large');
  const result = new Uint8Array(4 + metadata.length + body.length);
  new DataView(result.buffer).setUint32(0, metadata.length);
  result.set(metadata, 4); result.set(body, 4 + metadata.length);
  return result;
}
export function unframe(bytes) {
  if (bytes.length < 4 || bytes.length > MAX_CHANNEL_BYTES + 16388) throw new Error('Invalid channel frame');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (length > 16384 || length > bytes.length - 4) throw new Error('Invalid channel frame');
  return { header: JSON.parse(decoder.decode(bytes.subarray(4, 4 + length))), body: bytes.subarray(4 + length) };
}
const aad = (direction, challenge) => encoder.encode(JSON.stringify([
  'holdr-channel-v1', direction, challenge.instance, challenge.nonce, challenge.ticket, challenge.origin,
]));
export async function seal(keys, challenge, direction, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(direction, challenge) }, keys.encryption, bytes);
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) };
}
export async function open(keys, challenge, direction, envelope) {
  const iv = fromBase64(envelope.iv);
  if (iv.length !== 12) throw new Error('Invalid channel IV');
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad(direction, challenge) }, keys.encryption, fromBase64(envelope.ciphertext),
  ));
}
async function readJson(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty channel response');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Error('Channel response too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(decoder.decode(bytes));
}
export function createSecureClient({ base, getToken, fetchImpl = globalThis.fetch }) {
  base = loopbackOrigin(base);
  return {
    async request(method, path, { body, headers = {} } = {}) {
      path = channelPath(path);
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'PUT'].includes(method)) throw new Error('Invalid channel method');
      const token = await getToken();
      const nonce = randomHex();
      const at = Date.now();
      const proof = await signChallengeRequest(await challengeRequestKey(token), { nonce, origin: base, at });
      const response = await fetchImpl(base + CHANNEL_PREFIX + '/challenge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce, at, proof }),
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Object.assign(new Error('Receiver authentication unavailable'), { status: response.status });
      const challenge = await readJson(response, 4096);
      if (challenge.nonce !== nonce || challenge.origin !== base || !HEX.test(challenge.instance || '') || !HEX.test(challenge.ticket || '')
          || !Number.isSafeInteger(challenge.expires) || challenge.expires <= Date.now() || challenge.expires > Date.now() + 120000) {
        throw new Error('Receiver authentication failed');
      }
      const keys = await channelKeys(token, challenge.instance);
      if (!await checkChallenge(keys, challenge)) throw new Error('Receiver authentication failed');
      const allowedHeaders = {};
      for (const [name, value] of new Headers(headers)) {
        if (['content-type', 'x-holdr-request', 'origin'].includes(name)) allowedHeaders[name] = value;
      }
      const envelope = await seal(keys, challenge, 'request', frame({ method, path, headers: allowedHeaders }, body));
      const result = await fetchImpl(base + CHANNEL_PREFIX + '/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json', [CHALLENGE_HEADER]: nonce },
        body: JSON.stringify({ nonce, ticket: challenge.ticket, instance: challenge.instance, ...envelope }),
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(360000),
      });
      if (!result.ok) throw Object.assign(new Error('Authenticated receiver request failed'), { status: result.status });
      const decoded = unframe(await open(keys, challenge, 'response', await readJson(result, 46 * 1024 * 1024)));
      if (!Number.isInteger(decoded.header.status) || decoded.header.status < 200 || decoded.header.status > 599) throw new Error('Invalid authenticated response');
      return new Response([204, 205, 304].includes(decoded.header.status) || method === 'HEAD' ? null : decoded.body,
        { status: decoded.header.status, headers: decoded.header.headers });
    },
  };
}
