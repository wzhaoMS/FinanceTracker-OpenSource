import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATE, type OwnerState } from './ownerApi';
import { createOwnerClient, isOwnerApiError, type OwnerTransport } from './ownerClient';
import { FakeOwnerServer, fakeOwnerTransport } from './fakeOwnerServer';
import { parseStrict } from './strict';

const state = () => createOwnerClient(fakeOwnerTransport(new FakeOwnerServer({ recentAuth: 'granted' })), 'mock').getState();
const inventory = (base: OwnerState, cursor: string | null = null) => ({
  bindings: { total: base.bindings.filter((row) => row.status !== 'retired').length, nextCursor: null },
  devices: { total: base.devices.filter((row) => row.status === 'pending' || row.status === 'active').length + 1, nextCursor: cursor },
  pairings: { total: base.pairings.filter((row) => row.status === 'open' || row.status === 'redeemed').length, nextCursor: null },
});

test('additive inventory fields do not make required keys or unknown metadata permissive', async () => {
  const base = await state();
  assert.equal(parseStrict(STATE, base).ok, true);
  assert.equal(parseStrict(STATE, { ...base, inventory: { ...inventory(base), unexpected: true } }).ok, false);
  const missing = { ...base } as Partial<OwnerState>;
  delete missing.generatedAt;
  assert.equal(parseStrict(STATE, missing).ok, false);
  assert.equal(parseStrict(STATE, { ...base, inventory: undefined }).ok, false);
});

test('a claimed live total without enough records is an error, never a silently partial State', async () => {
  const base = await state();
  const client = createOwnerClient({ async request() {
    return { kind: 'json', status: 200, body: { ...base, inventory: inventory(base) } };
  } });
  await assert.rejects(client.getState(), (error) => isOwnerApiError(error) && error.kind === 'invalid-answer');
});

test('cyclic authority continuations terminate without publishing the incomplete inventory', async () => {
  const base = await state();
  let calls = 0;
  const cursor = 'abcdefgh';
  const transport: OwnerTransport = { async request(_method, path) {
    calls++;
    return { kind: 'json', status: 200, body: path.endsWith('/state') ? { ...base, inventory: inventory(base, cursor) }
      : { devices: [], quota: [], total: inventory(base).devices.total, nextCursor: cursor } };
  } };
  await assert.rejects(createOwnerClient(transport).getState(), (error) => isOwnerApiError(error) && error.kind === 'invalid-answer');
  assert.equal(calls, 2);
});
