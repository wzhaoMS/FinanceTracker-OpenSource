import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fail } from './errors.js';

const callbacks = new AsyncLocalStorage<true>();

/** Includes continuations spawned by the callback, even after its request has finished or expired. */
export function withinDeviceCallback<T>(work: () => T): T {
  return callbacks.run(true, work);
}

export function assertDeviceLockAcquisition(file: string, mode: 'shared' | 'exclusive'): void {
  if (!callbacks.getStore()) return;
  const name = path.basename(file);
  if (name === 'authorization.lock' || (name === 'lifecycle.lock' && mode === 'exclusive')) {
    fail('E0I_DEVICE_LOCK_REENTRANCY', 'device callbacks cannot acquire authorization or exclusive lifecycle locks');
  }
}
