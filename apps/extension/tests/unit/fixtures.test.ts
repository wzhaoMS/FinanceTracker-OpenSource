/**
 * The contract's golden fixtures and invalid corpus through the extension's
 * three validation layers (contract §15, plan §4.1):
 * 1. MAIN → ISOLATED: the bridge message schema (the projected batch is
 *    judged by `validateProjectedBankBatch` inside it);
 * 2. ISOLATED: the same schema again, then `mergeProjectedBatches`;
 * 3. collector → worker: the `collector-batch/v1` schema with the v2 payload,
 *    then `validateCardSyncPayloadV2`; and the observation request Holdr gets.
 * Valid fixtures pass every layer; every invalid case is refused by every
 * layer, with its expected code, and no getter runs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeProjectedBatches, validateCardSyncPayloadV2, type CardSyncIssue } from '@finance-tracker/shared';
import { CARD_SYNC_INVALID_CORPUS, CARD_SYNC_V2_FIXTURE_BUILDERS, PROJECTED_BATCH_FIXTURE_BUILDERS, getterCalls } from '@finance-tracker/shared/card-sync-fixtures';
import { BATCH_MESSAGE_LIMITS, parseStrict, parseStrictUnion } from '../../src/common/strict.js';
import { OBSERVATION_REQUEST } from '../../src/contracts/holdrApi.js';
import { BRIDGE_CHANNEL, BRIDGE_FROM_MAIN, COLLECTOR_MESSAGES } from '../../src/contracts/messages.js';

const NONCE = `nnc_${'a'.repeat(32)}`;
const STREAM = `stm_${'b'.repeat(32)}`;
const CAPTURE = `cpt_${'c'.repeat(32)}`;
const RUN = `run_${'d'.repeat(32)}`;

const bridgeLayer = (batch: unknown) => parseStrictUnion({ channel: BRIDGE_CHANNEL, kind: 'batch', nonce: NONCE, batch, gen: 0 }, 'kind', BRIDGE_FROM_MAIN, { limits: BATCH_MESSAGE_LIMITS });
const workerLayer = (payload: unknown) =>
  parseStrictUnion({ type: 'collector-batch/v1', adapterId: 'fake-chase', seq: 1, streamHandle: STREAM, captureId: CAPTURE, payload }, 'type', COLLECTOR_MESSAGES, { limits: BATCH_MESSAGE_LIMITS });
const holdrLayer = (payload: unknown) => parseStrict({ payload, runId: RUN }, OBSERVATION_REQUEST, { limits: BATCH_MESSAGE_LIMITS });

function codes(issues: readonly CardSyncIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

test('every golden projected batch passes the bridge schema in MAIN and ISOLATED, and the ISOLATED merge', () => {
  for (const [name, build] of Object.entries(PROJECTED_BATCH_FIXTURE_BUILDERS)) {
    const sent = bridgeLayer(build());
    assert.ok(sent.ok, name);
    // What crosses window.postMessage is a structured clone; ISOLATED parses the message again.
    const received = parseStrictUnion(structuredClone(sent.value), 'kind', BRIDGE_FROM_MAIN, { limits: BATCH_MESSAGE_LIMITS });
    assert.ok(received.ok, name);
    assert.ok(received.value.kind === 'batch');
    assert.ok(mergeProjectedBatches([received.value.batch]).ok, name);
  }
});

test('every golden v2 payload passes the collector→worker schema, the worker validator and the observation request schema', () => {
  for (const [name, build] of Object.entries(CARD_SYNC_V2_FIXTURE_BUILDERS)) {
    const message = workerLayer(build());
    assert.ok(message.ok, name);
    assert.ok(message.value.type === 'collector-batch/v1');
    assert.ok(validateCardSyncPayloadV2(message.value.payload).ok, name);
    assert.ok(holdrLayer(message.value.payload).ok, name);
  }
});

test('every invalid corpus case is refused by every layer with its code, and no getter runs', () => {
  assert.ok(CARD_SYNC_INVALID_CORPUS.length >= 100);
  for (const item of CARD_SYNC_INVALID_CORPUS) {
    getterCalls.count = 0;
    const value = item.mutate(item.base());
    if (item.target === 'projected') {
      const bridge = bridgeLayer(value);
      assert.equal(bridge.ok, false, `${item.id}: bridge accepted`);
      assert.ok(!bridge.ok && codes(bridge.issues).includes(item.expect.code), `${item.id}: bridge codes ${!bridge.ok && codes(bridge.issues)}`);
      assert.equal(mergeProjectedBatches([value]).ok, false, `${item.id}: merge accepted`);
    } else {
      const worker = workerLayer(value);
      assert.equal(worker.ok, false, `${item.id}: worker accepted`);
      assert.ok(!worker.ok && codes(worker.issues).includes(item.expect.code), `${item.id}: worker codes ${!worker.ok && codes(worker.issues)}`);
      assert.equal(validateCardSyncPayloadV2(value).ok, false, `${item.id}: validator accepted`);
      assert.equal(holdrLayer(value).ok, false, `${item.id}: request accepted`);
    }
    assert.equal(getterCalls.count, 0, `${item.id}: a getter ran`);
  }
});
