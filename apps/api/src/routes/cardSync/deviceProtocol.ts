import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  canonicalJson, cardSyncPayloadDigest, CARD_SYNC_V2_MAX_BYTES, isCardSyncDigest, isCardSyncId,
  parseCardSyncPairingCode, snapshotStrictJson, toLetterHex, validateCardSyncPayloadV2,
  type CardSyncIssue, type CardSyncPayloadV2, type JsonObject, type JsonValue,
} from '@finance-tracker/shared';
import { parseCommandJson } from '../../ingress/commandJson.js';
import { rawHeaderValues } from '../../ingress/listenerProfile.js';
import { deviceFingerprint, deviceTokenDigest, newCardSyncId, pairingCodeDigest } from '../../services/cardSyncDigests.js';
import { CARD_SYNC_ABORT_REASONS, type CardSyncAbortReason, type CardSyncRunRefusal } from '../../services/cardSync/runs.js';
import type { CardSyncRefusalCode } from '../../services/cardSync/refusals.js';

export const DEVICE_CLIENT_MARKER = 'extension-v1';
export const DEVICE_SMALL_BODY_BYTES = 16 * 1024;
/** E3's exact wrapper adds fewer than 64 bytes to its canonical payload. */
export const DEVICE_UPLOAD_BODY_BYTES = CARD_SYNC_V2_MAX_BYTES + 64;
export const DEVICE_CLIENT_VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;
export const DEVICE_LABEL = /^[A-Za-z][A-Za-z0-9 ._-]{0,31}$/;
export const DEVICE_ENDPOINTS = Object.freeze([
  { name: 'redeem', method: 'post', path: '/pairings/redeem', match: /^\/card-sync\/pairings\/redeem$/ },
  { name: 'capabilities', method: 'get', path: '/capabilities', match: /^\/card-sync\/capabilities$/ },
  { name: 'run', method: 'post', path: '/runs', match: /^\/card-sync\/runs$/ },
  { name: 'observations', method: 'post', path: '/observations', match: /^\/card-sync\/observations$/ },
  { name: 'prepare', method: 'post', path: '/imports/preview', match: /^\/card-sync\/imports\/preview$/ },
  { name: 'commit', method: 'post', path: '/imports/commit', match: /^\/card-sync\/imports\/commit$/ },
  { name: 'receipt', method: 'get', path: '/runs/:runId/receipt', match: /^\/card-sync\/runs\/run_[a-p]{32}\/receipt$/ },
  { name: 'abort', method: 'post', path: '/runs/:runId/abort', match: /^\/card-sync\/runs\/run_[a-p]{32}\/abort$/ },
] as const);
export type DeviceEndpointName = typeof DEVICE_ENDPOINTS[number]['name'];
export type DeviceHttpCode = CardSyncRefusalCode | 'bad-request' | 'unauthorized' | 'too-large' | 'unsupported-media-type'
  | 'unavailable' | 'rate-limited' | 'internal-error' | 'authorization-blocked' | 'device-pending' | 'credential-not-allowed';

export class DeviceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: DeviceHttpCode,
    readonly issues?: readonly CardSyncIssue[],
    readonly runRefusal?: CardSyncRunRefusal,
  ) { super(code); this.name = 'DeviceHttpError'; }
}

const invalid = (path = '$', code: CardSyncIssue['code'] = 'invalid-format'): never => {
  throw new DeviceHttpError(400, 'bad-request', [{ code, path }]);
};
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);

export function deviceEndpoint(path: string, method: string) {
  return DEVICE_ENDPOINTS.find((entry) => entry.match.test(path)
    && (entry.method.toUpperCase() === method || method === 'OPTIONS' || (method === 'HEAD' && entry.method === 'get')));
}

export function singleDeviceHeader(req: IncomingMessage, name: string): string | undefined {
  const values = rawHeaderValues(req, name);
  if (values.length > 1) return invalid();
  return values[0];
}

/** No cookie of any kind, no duplicate Authorization, and no normalization of a device bearer. */
export function readDeviceAuthorization(req: IncomingMessage, pairing = false): { digest: string } {
  const authorization = rawHeaderValues(req, 'authorization');
  if (rawHeaderValues(req, 'cookie').length !== 0 || authorization.length !== 1) throw new DeviceHttpError(401, 'unauthorized');
  if (pairing) {
    const prefix = 'HoldrPair ';
    const code = authorization[0].startsWith(prefix) ? parseCardSyncPairingCode(authorization[0].slice(prefix.length)) : null;
    if (code === null) throw new DeviceHttpError(401, 'pairing-invalid');
    return { digest: pairingCodeDigest(code) };
  }
  const match = /^HoldrDevice (hdv1_[a-p]{64})$/.exec(authorization[0]);
  if (!match) throw new DeviceHttpError(401, 'unauthorized');
  return { digest: deviceTokenDigest(match[1]) };
}

/** Only the returned token goes to the dedicated redeem response; repository arguments use the other fields. */
export function newDeviceCredential() {
  const token = `hdv1_${toLetterHex(randomBytes(32))}`;
  return Object.freeze({
    deviceId: newCardSyncId('dev_'), token, tokenDigest: deviceTokenDigest(token), fingerprint: deviceFingerprint(token),
  });
}

export function displayDeviceFingerprint(fingerprint: string): string {
  if (!/^[a-p]{16}$/.test(fingerprint)) throw new DeviceHttpError(500, 'internal-error');
  return fingerprint.match(/.{4}/g)!.join('-');
}

function text(bytes: Buffer, upload = false): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch {
    throw new DeviceHttpError(upload ? 422 : 400, upload ? 'payload-invalid' : 'bad-request',
      [{ code: 'ill-formed-unicode', path: '$' }], upload ? 'payload-invalid' : undefined);
  }
}

function smallObject(bytes: Buffer, fields: readonly string[]): JsonObject {
  if (bytes.length > DEVICE_SMALL_BODY_BYTES) throw new DeviceHttpError(413, 'too-large');
  let parsed: unknown;
  try { parsed = parseCommandJson(text(bytes)); } catch { return invalid(); }
  const snapshot = snapshotStrictJson(parsed, {
    knownKeys: new Set(fields), limits: { maxBytes: DEVICE_SMALL_BODY_BYTES, maxDepth: 2, maxNodes: 100, maxStringLength: 256 },
  });
  if (!snapshot.ok) throw new DeviceHttpError(422, 'payload-invalid', snapshot.issues.slice(0, 20));
  if (!object(snapshot.value)) return invalid('$', 'wrong-type');
  if (Object.keys(snapshot.value).some((key) => !fields.includes(key))) return invalid('$.<key>', 'unknown-key');
  for (const field of fields) if (!Object.hasOwn(snapshot.value, field)) return invalid(`$.${field}`, 'missing-key');
  return snapshot.value;
}

function id(value: unknown, kind: Parameters<typeof isCardSyncId>[0], path: string): string {
  return isCardSyncId(kind, value) ? value : invalid(path);
}

export function parseDeviceRedeem(bytes: Buffer): { clientVersion: string; deviceLabel: string } {
  const value = smallObject(bytes, ['clientVersion', 'deviceLabel']);
  if (typeof value.clientVersion !== 'string' || !DEVICE_CLIENT_VERSION.test(value.clientVersion)) return invalid('$.clientVersion');
  if (typeof value.deviceLabel !== 'string' || !DEVICE_LABEL.test(value.deviceLabel)) return invalid('$.deviceLabel');
  return { clientVersion: value.clientVersion, deviceLabel: value.deviceLabel };
}

export function parseDeviceRun(bytes: Buffer) {
  const value = smallObject(bytes, ['clientRunId', 'bindingId', 'bindingVersion', 'adapterVersion', 'contractVersion', 'trigger']);
  const clientRunId = id(value.clientRunId, 'clientRun', '$.clientRunId');
  const bindingId = id(value.bindingId, 'binding', '$.bindingId');
  if (!Number.isInteger(value.bindingVersion) || Number(value.bindingVersion) < 1 || Number(value.bindingVersion) > 2_147_483_647) return invalid('$.bindingVersion');
  if (typeof value.adapterVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/.test(value.adapterVersion)) return invalid('$.adapterVersion');
  if (!Number.isInteger(value.contractVersion) || Number(value.contractVersion) < 1 || Number(value.contractVersion) > 99) return invalid('$.contractVersion');
  if (value.trigger !== 'manual') return invalid('$.trigger', 'invalid-enum');
  return { clientRunId, bindingId, bindingVersion: Number(value.bindingVersion), adapterVersion: value.adapterVersion,
    contractVersion: Number(value.contractVersion), trigger: 'manual' as const };
}

export function parseDevicePrepare(bytes: Buffer) {
  const value = smallObject(bytes, ['runId', 'observationSetId']);
  return { runId: id(value.runId, 'run', '$.runId'), observationSetId: id(value.observationSetId, 'observationSet', '$.observationSetId') };
}

export function parseDeviceCommit(bytes: Buffer) {
  const value = smallObject(bytes, ['runId', 'previewId', 'payloadDigest', 'planDigest']);
  const runId = id(value.runId, 'run', '$.runId');
  const previewId = id(value.previewId, 'preview', '$.previewId');
  if (!isCardSyncDigest('payload', value.payloadDigest)) return invalid('$.payloadDigest');
  if (!isCardSyncDigest('plan', value.planDigest)) return invalid('$.planDigest');
  return { runId, previewId, payloadDigest: value.payloadDigest, planDigest: value.planDigest };
}

export function parseDeviceAbort(bytes: Buffer): { reason: CardSyncAbortReason } {
  const value = smallObject(bytes, ['reason']);
  if (typeof value.reason !== 'string' || !(CARD_SYNC_ABORT_REASONS as readonly string[]).includes(value.reason)) {
    throw new DeviceHttpError(422, 'bad-request', [{ code: 'invalid-enum', path: '$.reason' }]);
  }
  return { reason: value.reason as CardSyncAbortReason };
}

/** Correlation only, not payload validation or authorization; ambiguous/malformed bodies supply no run identity. */
export function deviceUploadRunId(bytes: Buffer): string | null {
  if (bytes.length > DEVICE_UPLOAD_BODY_BYTES) return null;
  try {
    const value: unknown = parseCommandJson(text(bytes, true));
    return object(value) && isCardSyncId('run', value.runId) ? value.runId : null;
  } catch { return null; }
}

export interface DeviceUpload {
  runId: string;
  payload: CardSyncPayloadV2;
  canonicalJson: string;
  payloadDigest: string;
}

/** Validate first, compare with E3's canonical envelope, then keep the actual received payload substring. Never reserialize for storage. */
export function parseDeviceUpload(bytes: Buffer): DeviceUpload {
  if (bytes.length > DEVICE_UPLOAD_BODY_BYTES) throw new DeviceHttpError(413, 'too-large', [{ code: 'too-large', path: '$' }], 'too-large');
  const received = text(bytes, true);
  let parsed: unknown;
  try { parsed = JSON.parse(received); }
  catch { throw new DeviceHttpError(422, 'payload-invalid', [{ code: 'invalid-format', path: '$' }], 'payload-invalid'); }
  if (!object(parsed) || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, 'payload') || !Object.hasOwn(parsed, 'runId')
    || !isCardSyncId('run', parsed.runId)) {
    throw new DeviceHttpError(422, 'payload-invalid', [{ code: 'invalid-format', path: '$' }], 'payload-invalid');
  }
  const validation = validateCardSyncPayloadV2(parsed.payload);
  if (!validation.ok) {
    const refusal = validation.issues.some((issue) => issue.code === 'card-data' || issue.code === 'card-secret') ? 'card-data' : 'payload-invalid';
    throw new DeviceHttpError(422, 'payload-invalid', validation.issues.slice(0, 20), refusal);
  }
  const canonical = canonicalJson(validation.payload as unknown as JsonValue);
  const prefix = '{"payload":';
  const expected = `${prefix}${canonical},"runId":${JSON.stringify(parsed.runId)}}`;
  if (received !== expected) {
    throw new DeviceHttpError(400, 'payload-digest-mismatch', [{ code: 'inconsistent', path: '$' }], 'payload-digest-mismatch');
  }
  return {
    runId: parsed.runId, payload: validation.payload,
    canonicalJson: received.slice(prefix.length, prefix.length + canonical.length),
    payloadDigest: cardSyncPayloadDigest(validation.payload),
  };
}
