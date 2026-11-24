/**
 * Every message, report and Holdr response the extension parses is read with
 * the contract's strict JSON toolkit, so every key its schemas name must pass
 * the contract's key policy (`isForbiddenCardSyncKey`, contract §2, §15a).
 * A forbidden key would make the schema refuse every real message.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isForbiddenCardSyncKey } from '@finance-tracker/shared';
import type { Spec } from '../../src/common/strict.js';
import * as holdrApi from '../../src/contracts/holdrApi.js';
import * as messages from '../../src/contracts/messages.js';
import * as shapeReport from '../../src/contracts/shapeReport.js';

function isSpec(value: unknown): value is Spec {
  return typeof value === 'object' && value !== null && typeof (value as { t?: unknown }).t === 'string';
}

/** Keys of every object schema reachable from `value`; embedded contract validators bring their own keys. */
function collectKeys(value: unknown, into: Set<string>, seen = new Set<unknown>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  if (isSpec(value)) {
    if (value.t === 'object') {
      for (const [key, inner] of Object.entries(value.keys)) {
        into.add(key);
        collectKeys(inner, into, seen);
      }
    } else if (value.t === 'array') collectKeys(value.item, into, seen);
    else if (value.t === 'nullable') collectKeys(value.inner, into, seen);
    return;
  }
  for (const inner of Object.values(value)) collectKeys(inner, into, seen);
}

test('every key of every extension schema passes the contract key policy', () => {
  const keys = new Set<string>();
  for (const module of [messages, holdrApi, shapeReport]) for (const exported of Object.values(module)) collectKeys(exported, keys);
  assert.ok(keys.size > 80, `collected only ${keys.size} keys`);
  assert.deepEqual([...keys].filter((key) => isForbiddenCardSyncKey(key)).sort(), []);
});

test('the names the policy refuses are the ones E3 had to avoid', () => {
  for (const key of ['deviceToken', 'tokenExpiresAt', 'requestHeaderNames', 'response']) assert.equal(isForbiddenCardSyncKey(key), true, key);
  for (const key of ['deviceExpiresAt', 'requestMetaNames', 'responseShape', 'requestShape', 'retryAfterSeconds']) assert.equal(isForbiddenCardSyncKey(key), false, key);
});
