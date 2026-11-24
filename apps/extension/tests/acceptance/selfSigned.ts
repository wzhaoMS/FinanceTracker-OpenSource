/**
 * A throwaway TLS identity for the acceptance suite's synthetic Holdr: a fresh
 * P-256 key and a self-signed X.509 v3 certificate for one host name (SAN,
 * server auth, two days), made here in plain DER so the suite needs no
 * OpenSSL. The browser trusts exactly this key through Chromium's
 * `--ignore-certificate-errors-spki-list` (its SHA-256 SPKI pin), which
 * changes nothing for any other certificate. Never used outside tests.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let value = n; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const oid = (...bytes: number[]) => tlv(0x06, Buffer.from(bytes));
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
const octets = (bytes: Buffer) => tlv(0x04, bytes);
const critical = tlv(0x01, Buffer.from([0xff]));
/** UTCTime, YYMMDDHHMMSSZ. */
const time = (at: Date) => tlv(0x17, Buffer.from(`${at.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`, 'ascii'));

const ECDSA_WITH_SHA256 = oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
const COMMON_NAME = oid(0x55, 0x04, 0x03);
const BASIC_CONSTRAINTS = oid(0x55, 0x1d, 0x13);
const KEY_USAGE = oid(0x55, 0x1d, 0x0f);
const EXTENDED_KEY_USAGE = oid(0x55, 0x1d, 0x25);
const SUBJECT_ALT_NAME = oid(0x55, 0x1d, 0x11);
const SERVER_AUTH = oid(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01);

export interface TlsIdentity {
  readonly cert: string;
  readonly key: string;
  /** Base64 SHA-256 of the DER SubjectPublicKeyInfo: Chromium's SPKI pin. */
  readonly spkiSha256: string;
}

export function selfSignedIdentity(host: string, now = new Date()): TlsIdentity {
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error('host name');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const serial = randomBytes(16);
  // Positive and minimally encoded: the top bit clear, the next set.
  serial[0] = (serial[0] & 0x3f) | 0x40;
  const name = sequence(set(sequence(COMMON_NAME, utf8(host))));
  const algorithm = sequence(ECDSA_WITH_SHA256);
  const extensions = tlv(0xa3, sequence(
    sequence(BASIC_CONSTRAINTS, critical, octets(sequence())),
    // digitalSignature only.
    sequence(KEY_USAGE, critical, octets(tlv(0x03, Buffer.from([0x07, 0x80])))),
    sequence(EXTENDED_KEY_USAGE, octets(sequence(SERVER_AUTH))),
    sequence(SUBJECT_ALT_NAME, octets(sequence(tlv(0x82, Buffer.from(host, 'ascii'))))),
  ));
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))),
    tlv(0x02, serial),
    algorithm,
    name,
    sequence(time(new Date(now.getTime() - 3_600_000)), time(new Date(now.getTime() + 2 * 86_400_000))),
    name,
    spki,
    extensions,
  );
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const certificate = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])));
  const lines = certificate.toString('base64').match(/.{1,64}/g) ?? [];
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    spkiSha256: createHash('sha256').update(spki).digest('base64'),
  };
}
