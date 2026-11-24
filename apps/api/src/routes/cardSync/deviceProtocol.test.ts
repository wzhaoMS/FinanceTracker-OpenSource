import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { canonicalJson, cardSyncPayloadDigest, isCardSyncDeviceToken, isCardSyncId, type JsonValue } from '@finance-tracker/shared';
import { CARD_SYNC_V2_FIXTURE_BUILDERS, chaseFixture, fixtureId } from '@finance-tracker/shared/card-sync-fixtures';
import { deviceFingerprint, deviceTokenDigest, pairingCodeDigest } from '../../services/cardSyncDigests.js';
import {
  DEVICE_ENDPOINTS, DEVICE_UPLOAD_BODY_BYTES, DeviceHttpError, deviceEndpoint, displayDeviceFingerprint,
  newDeviceCredential, parseDeviceAbort, parseDeviceCommit, parseDevicePrepare, parseDeviceRedeem, parseDeviceRun,
  parseDeviceUpload, readDeviceAuthorization, singleDeviceHeader,
} from './deviceProtocol.js';

const TOKEN = `hdv1_${'a'.repeat(64)}`;
const CODE = 'b'.repeat(32);
const RUN = fixtureId('run', 'e2c-run');
const CLIENT_RUN = fixtureId('clientRun', 'e2c-client-run');
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const request = (headers: string[]) => {
  const req = new IncomingMessage(new Socket());
  req.rawHeaders = headers;
  return req;
};
const envelope = (payload = chaseFixture(), runId = RUN) => Buffer.from(
  `{"payload":${canonicalJson(payload as unknown as JsonValue)},"runId":${JSON.stringify(runId)}}`,
);

function failure(work: () => unknown): DeviceHttpError {
  try { work(); } catch (error) { expect(error).toBeInstanceOf(DeviceHttpError); return error as DeviceHttpError; }
  throw Error('expected a fixed refusal');
}

describe('E2c credential and route primitives', () => {
  it('generates only CSPRNG letter-format ids/tokens and computes digests/fingerprint with the shared server functions', () => {
    const first = newDeviceCredential();
    const second = newDeviceCredential();
    expect(isCardSyncId('device', first.deviceId)).toBe(true);
    expect(isCardSyncDeviceToken(first.token)).toBe(true);
    expect(first.token).not.toBe(second.token);
    expect(first.deviceId).not.toBe(second.deviceId);
    expect(first.tokenDigest).toBe(deviceTokenDigest(first.token));
    expect(first.fingerprint).toBe(deviceFingerprint(first.token));
    expect(displayDeviceFingerprint(first.fingerprint)).toMatch(/^[a-p]{4}(?:-[a-p]{4}){3}$/);
  });

  it('returns only a digest to the credential resolver', () => {
    expect(readDeviceAuthorization(request(['Authorization', `HoldrDevice ${TOKEN}`]))).toEqual({ digest: deviceTokenDigest(TOKEN) });
    expect(readDeviceAuthorization(request(['Authorization', `HoldrPair ${CODE}`]), true)).toEqual({ digest: pairingCodeDigest(CODE) });
    const grouped = CODE.toUpperCase().match(/.{4}/g)!.join('-');
    expect(readDeviceAuthorization(request(['Authorization', `HoldrPair ${grouped}`]), true)).toEqual({ digest: pairingCodeDigest(CODE) });
  });

  it.each([
    [], ['Authorization', `Bearer ${TOKEN}`], ['Authorization', `holdrdevice ${TOKEN}`],
    ['Authorization', `HoldrDevice ${TOKEN} `], ['Authorization', `HoldrDevice  ${TOKEN}`],
    ['Authorization', `HoldrDevice ${TOKEN}`, 'Authorization', `HoldrDevice ${TOKEN}`],
    ['Authorization', `HoldrDevice ${TOKEN}`, 'Cookie', ''], ['Authorization', `HoldrDevice ${TOKEN}`, 'cOoKiE', 'synthetic=1'],
    ['Authorization', `HoldrPair ${CODE}`],
  ].map((headers) => ({ headers })))('refuses credential form %# without echoing it', ({ headers }) => {
    const error = failure(() => readDeviceAuthorization(request(headers)));
    expect(error.status).toBe(401);
    expect(error.message).toBe('unauthorized');
    expect(error.message).not.toContain(TOKEN);
  });

  it('never accepts a device token as a pairing code or guesses a duplicate header', () => {
    expect(failure(() => readDeviceAuthorization(request(['Authorization', `HoldrDevice ${TOKEN}`]), true)).code).toBe('pairing-invalid');
    expect(failure(() => singleDeviceHeader(request(['Idempotency-Key', CLIENT_RUN, 'idempotency-key', CLIENT_RUN]), 'idempotency-key')).code).toBe('bad-request');
  });

  it('knows only the eight exact E3 endpoints and guarded GET/HEAD/OPTIONS forms', () => {
    expect(DEVICE_ENDPOINTS).toHaveLength(8);
    expect(deviceEndpoint('/card-sync/capabilities', 'HEAD')?.name).toBe('capabilities');
    expect(deviceEndpoint('/card-sync/observations', 'OPTIONS')?.name).toBe('observations');
    for (const target of ['/card-sync/owner/state', '/card-sync/observations/', '/CARD-SYNC/capabilities', '/card-sync/runs/bad/receipt']) {
      expect(deviceEndpoint(target, 'GET')).toBeUndefined();
    }
  });
});

describe('E2c strict small requests', () => {
  it('accepts the declared redeem, run, prepare, commit and abort forms', () => {
    expect(parseDeviceRedeem(json({ clientVersion: '0.1.0', deviceLabel: 'Laptop Chrome' }))).toEqual({
      clientVersion: '0.1.0', deviceLabel: 'Laptop Chrome',
    });
    const run = { clientRunId: CLIENT_RUN, bindingId: fixtureId('binding', 'binding'), bindingVersion: 1,
      adapterVersion: 'holdr-ext-chase@0.1.0', contractVersion: 1, trigger: 'manual' };
    expect(parseDeviceRun(json(run))).toEqual(run);
    const prepare = { runId: RUN, observationSetId: fixtureId('observationSet', 'set') };
    expect(parseDevicePrepare(json(prepare))).toEqual(prepare);
    const commit = { runId: RUN, previewId: fixtureId('preview', 'preview'), payloadDigest: `pd1:${'a'.repeat(64)}`, planDigest: `pl1:${'b'.repeat(64)}` };
    expect(parseDeviceCommit(json(commit))).toEqual(commit);
    expect(parseDeviceAbort(json({ reason: 'user-cancelled' }))).toEqual({ reason: 'user-cancelled' });
  });

  it('rejects extras, duplicate escaped keys, malformed JSON, invalid types and non-manual runs', () => {
    for (const bytes of [
      json({ clientVersion: '0.1.0', deviceLabel: 'Laptop', extra: true }),
      Buffer.from('{"clientVersion":"0.1.0","deviceLabel":"Laptop","device\\u004cabel":"other"}'),
      Buffer.from('{'), json({ clientVersion: 1, deviceLabel: 'Laptop' }),
    ]) expect(failure(() => parseDeviceRedeem(bytes)).status).toBeGreaterThanOrEqual(400);
    expect(failure(() => parseDeviceRedeem(json({ clientVersion: '0.1.0', deviceLabel: '1 Chrome' }))).code).toBe('bad-request');
    expect(failure(() => parseDeviceAbort(json({ reason: 'arbitrary-private-text' }))).issues).toEqual([{ code: 'invalid-enum', path: '$.reason' }]);
    expect(failure(() => parseDeviceRun(json({
      clientRunId: CLIENT_RUN, bindingId: fixtureId('binding', 'binding'), bindingVersion: 1,
      adapterVersion: 'holdr-ext-chase@0.1.0', contractVersion: 1, trigger: 'auto',
    }))).issues).toEqual([{ code: 'invalid-enum', path: '$.trigger' }]);
  });
});

describe('E1a validation and exact received payload bytes', () => {
  it.each(Object.entries(CARD_SYNC_V2_FIXTURE_BUILDERS))('keeps %s bytes without rebuilding or stripping any payload field', (_name, build) => {
    const payload = build();
    const body = envelope(payload);
    const parsed = parseDeviceUpload(body);
    const canonical = canonicalJson(payload as unknown as JsonValue);
    expect(parsed.runId).toBe(RUN);
    expect(parsed.payload).toEqual(payload);
    expect(parsed.canonicalJson).toBe(canonical);
    expect(body.subarray(11, 11 + Buffer.byteLength(canonical))).toEqual(Buffer.from(parsed.canonicalJson));
    expect(parsed.payloadDigest).toBe(cardSyncPayloadDigest(payload));
  });

  it('answers E1a value-free issues as 422 and identifies the refusal to record', () => {
    const payload = chaseFixture();
    const invalid = { ...payload, version: 1 };
    const error = failure(() => parseDeviceUpload(json({ payload: invalid, runId: RUN })));
    expect(error).toMatchObject({ status: 422, code: 'payload-invalid', runRefusal: 'payload-invalid' });
    expect(error.issues?.some((issue) => issue.code === 'unsupported-version')).toBe(true);
    expect(error.issues!.length).toBeLessThanOrEqual(20);
    const unsafe = { ...payload, rows: [{ ...payload.rows[0], description: '4111 1111 1111 1111' }] };
    const guard = failure(() => parseDeviceUpload(json({ payload: unsafe, runId: RUN })));
    expect(guard).toMatchObject({ status: 422, code: 'payload-invalid', runRefusal: 'card-data' });
    expect(JSON.stringify(guard.issues)).not.toContain('4111');
  });

  it('refuses duplicate keys and byte-changing noncanonical envelopes instead of normalizing and storing them', () => {
    const body = envelope().toString();
    const alternate = [
      ` ${body}`, body.replace('{"payload":', '{ "payload":'), body.replace(',"runId":', ', "runId":'),
      body.replace('{"payload":', `{"runId":"${RUN}","payload":`),
      JSON.stringify(JSON.parse(body), null, 2),
    ];
    for (const text of alternate) {
      const error = failure(() => parseDeviceUpload(Buffer.from(text)));
      expect(error).toMatchObject({ status: 400, code: 'payload-digest-mismatch', runRefusal: 'payload-digest-mismatch' });
    }
  });

  it('refuses malformed UTF-8, BOM, truncated JSON and oversized bodies with bounded fixed issues', () => {
    for (const bytes of [Buffer.from([0xc0, 0xaf]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), envelope()]), Buffer.from('{"payload":')]) {
      expect(failure(() => parseDeviceUpload(bytes))).toMatchObject({ status: 422, code: 'payload-invalid', runRefusal: 'payload-invalid' });
    }
    expect(failure(() => parseDeviceUpload(Buffer.alloc(DEVICE_UPLOAD_BODY_BYTES + 1)))).toMatchObject({
      status: 413, code: 'too-large', runRefusal: 'too-large',
    });
  });
});
