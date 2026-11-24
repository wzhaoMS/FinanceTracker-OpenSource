/**
 * A build target: everything that differs between the production artifact
 * and the fake-issuer test artifact. Exactly one target module is bundled
 * (esbuild aliases `#target`), so a production bundle cannot contain a fake
 * host or a test switch, and the build check verifies that from the output.
 */
import type { AdapterDescriptor } from '../adapters/types.js';
import type { Timings } from './timings.js';

export interface BuildTarget {
  /** `acceptance`: the fake-issuer build with the production id, for the macOS suite against E2c itself (config/acceptance.ts). */
  readonly name: 'production' | 'test' | 'acceptance';
  /** The single Holdr origin the worker may contact; fixed at build time, never taken from a page or a user. */
  readonly holdrOrigin: string;
  readonly adapters: readonly AdapterDescriptor[];
  readonly timings: Timings;
}
