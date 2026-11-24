/**
 * The fake-issuer test target. Every origin is a made-up `*.e3.test` host
 * that resolves only through the e2e egress gate, which maps it to a loopback
 * fake server; without the gate nothing here can be reached. Plain HTTP is
 * allowed only in this target. Waits are shortened; every other budget is
 * the plan's.
 */
import { FAKE_ADAPTERS } from '../adapters/fake/descriptors.js';
import { FAKE_TARGET_TIMINGS } from './fakeTimings.js';
import type { BuildTarget } from './targetTypes.js';

export const TARGET: BuildTarget = Object.freeze({
  name: 'test',
  holdrOrigin: 'http://holdr.e3.test',
  adapters: FAKE_ADAPTERS,
  timings: FAKE_TARGET_TIMINGS,
});