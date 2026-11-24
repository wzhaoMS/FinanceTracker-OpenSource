/**
 * Per-issuer dynamic content-script registration (plan §3.3). Scripts are
 * registered only for adapters that are enabled with current consent, whose
 * optional host permission is granted, while the extension is not paused.
 * MAIN observers additionally need the user's MAIN-passive consent; during
 * shape mode the issuer's MAIN observer is replaced by the shape observer.
 *
 * Every registration is top-frame only, never matches about:blank or data:
 * frames, runs at document_start and does not persist across browser
 * sessions; the worker re-registers on start after re-checking consent,
 * permission and version. Unregistering does not unload scripts already in a
 * page; stopping those is the collectors' job.
 */
import type { AdapterDescriptor } from '../adapters/types.js';
import { registrationId } from '../adapters/types.js';
import type { IssuerSetting, Settings, ShapeState } from './storage.js';

/** The generic ISOLATED relay used during shape mode. */
export const SHAPE_RELAY_SCRIPT = 'shape-isolated.js';

export interface DesiredScript {
  id: string;
  js: string[];
  matches: string[];
  runAt: 'document_start';
  allFrames: false;
  matchOriginAsFallback: false;
  persistAcrossSessions: false;
  world: 'ISOLATED' | 'MAIN';
}

/** True when an adapter may run: enabled, consent current, permission granted, MAIN consent when it needs MAIN, not paused. */
export function adapterActive(adapter: AdapterDescriptor, settings: Settings, granted: ReadonlySet<string>): boolean {
  const setting = settings.issuers[adapter.id];
  if (settings.paused || !setting || !setting.enabled) return false;
  if (setting.consentVersion !== adapter.consentVersion) return false;
  if (!granted.has(adapter.hostPermission)) return false;
  if (adapter.mode === 'main-passive' && !setting.mainPassiveAccepted) return false;
  return true;
}

/** True while this adapter version's contract is paused after the site changed what it sends. */
export function shapeChangedPause(adapter: AdapterDescriptor, setting: IssuerSetting | undefined): boolean {
  return setting?.shapeChangedVersion === adapter.parserVersion;
}

function script(id: string, file: string, adapter: AdapterDescriptor, world: 'ISOLATED' | 'MAIN'): DesiredScript {
  return {
    id,
    js: [file],
    matches: [adapter.hostPermission],
    runAt: 'document_start',
    allFrames: false,
    matchOriginAsFallback: false,
    persistAcrossSessions: false,
    world,
  };
}

export function desiredScripts(
  adapters: readonly AdapterDescriptor[],
  settings: Settings,
  granted: ReadonlySet<string>,
  shape: ShapeState | null,
): DesiredScript[] {
  const scripts: DesiredScript[] = [];
  for (const adapter of adapters) {
    if (shape && shape.adapterId === adapter.id) {
      // Shape mode replaces the issuer's collector and observer: field names and types only, nothing for Holdr.
      // It also runs for a contract paused after a site change, to record the new form.
      const allowed = adapterActive(adapter, settings, granted)
        || (!settings.paused && granted.has(adapter.hostPermission) && shapeChangedPause(adapter, settings.issuers[adapter.id]));
      if (allowed && adapter.scripts.shapeMain) {
        scripts.push(script(registrationId(adapter.id, 'shape-isolated'), SHAPE_RELAY_SCRIPT, adapter, 'ISOLATED'));
        scripts.push(script(registrationId(adapter.id, 'shape-main'), adapter.scripts.shapeMain, adapter, 'MAIN'));
      }
      continue;
    }
    if (!adapterActive(adapter, settings, granted)) continue;
    scripts.push(script(registrationId(adapter.id, 'isolated'), adapter.scripts.isolated, adapter, 'ISOLATED'));
    if (adapter.scripts.main) scripts.push(script(registrationId(adapter.id, 'main'), adapter.scripts.main, adapter, 'MAIN'));
  }
  return scripts;
}

function same(a: chrome.scripting.RegisteredContentScript, b: DesiredScript): boolean {
  return (
    a.id === b.id
    && JSON.stringify(a.js ?? []) === JSON.stringify(b.js)
    && JSON.stringify(a.matches ?? []) === JSON.stringify(b.matches)
    && (a.world ?? 'ISOLATED') === b.world
    && (a.runAt ?? 'document_idle') === b.runAt
    && (a.allFrames ?? false) === b.allFrames
    && (a.persistAcrossSessions ?? true) === b.persistAcrossSessions
  );
}

/** Makes the registered set exactly the desired set: unknown or changed registrations are removed first. */
export async function applyRegistrations(desired: readonly DesiredScript[]): Promise<void> {
  const current = await chrome.scripting.getRegisteredContentScripts();
  const wanted = new Map(desired.map((item) => [item.id, item]));
  const remove = current.filter((item) => {
    const target = wanted.get(item.id);
    return !target || !same(item, target);
  });
  if (remove.length > 0) await chrome.scripting.unregisterContentScripts({ ids: remove.map((item) => item.id) });
  const keep = new Set(current.filter((item) => !remove.includes(item)).map((item) => item.id));
  const add = desired.filter((item) => !keep.has(item.id));
  if (add.length > 0) await chrome.scripting.registerContentScripts(add.map((item) => ({ ...item, js: [...item.js], matches: [...item.matches] })));
}

/**
 * Removes one issuer's shape-mode scripts at once, before its pages are told
 * to stop, so no new page gets them meanwhile (the full reconcile with the
 * caller's settings follows).
 */
export async function unregisterShapeScripts(adapterId: string): Promise<void> {
  const ids = new Set([registrationId(adapterId, 'shape-isolated'), registrationId(adapterId, 'shape-main')]);
  const present = (await chrome.scripting.getRegisteredContentScripts()).filter((item) => ids.has(item.id)).map((item) => item.id);
  if (present.length > 0) await chrome.scripting.unregisterContentScripts({ ids: present });
}
