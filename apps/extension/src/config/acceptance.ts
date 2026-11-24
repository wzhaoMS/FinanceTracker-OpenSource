/**
 * The acceptance target (E2c M6): the fake-issuer build, pinned to Holdr's
 * synthetic HTTPS origin and carrying the production extension id, the only
 * id Holdr's device API admits (E2c pins it from build/manifest.ts). It exists
 * only to run this extension against E2c itself, through a real browser and
 * TLS, in the macOS acceptance suite (tests/acceptance). `holdr.test` resolves
 * nowhere: the suite's egress gate tunnels exactly `holdr.test:443` to the
 * synthetic Holdr on loopback. The build can reach neither the production
 * Holdr (another origin, no permission for it) nor a real issuer (fake
 * `*.e3.test` sites only); the build checks keep it that way.
 */
import { FAKE_ADAPTERS } from '../adapters/fake/descriptors.js';
import { FAKE_TARGET_TIMINGS } from './fakeTimings.js';
import type { BuildTarget } from './targetTypes.js';

export const TARGET: BuildTarget = Object.freeze({
  name: 'acceptance',
  holdrOrigin: 'https://holdr.test',
  adapters: FAKE_ADAPTERS,
  // Holdr's real device API over TLS, not a fake answering at once: the plan's wait for an answer.
  timings: Object.freeze({ ...FAKE_TARGET_TIMINGS, holdrTimeoutMs: 15_000 }),
});
