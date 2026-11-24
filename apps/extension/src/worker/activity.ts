/**
 * Whether an adapter may run right now: settings, consent version, the
 * browser's actual site permission and the global pause, read fresh each
 * time (a worker restart or a permission change in the browser's own UI must
 * never be missed).
 */
import type { AdapterDescriptor } from '../adapters/types.js';
import { adapterActive } from './registration.js';
import { readSettings, type Settings } from './storage.js';

export async function grantedOrigins(): Promise<Set<string>> {
  const all = await chrome.permissions.getAll();
  return new Set(all.origins ?? []);
}

export async function isAdapterActive(adapter: AdapterDescriptor, settings?: Settings): Promise<boolean> {
  return adapterActive(adapter, settings ?? (await readSettings()), await grantedOrigins());
}
