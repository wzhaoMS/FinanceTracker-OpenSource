import { Router, type Express } from 'express';
import { appDeviceMiddlewareStage } from '../app.js';
import { DEVICE_ROUTE_PATH, isDeviceAdmissionRoute } from '../ingress/deviceRouter.js';
import {
  isVerifiedExpressBuiltin, isVerifiedExpressLayer, isVerifiedRouter, isVerifiedRouteLayer, type ExpressLayer,
} from '../ingress/expressIdentity.js';
import { isCardSpendingDevicePassthrough } from '../routes/cardSpending.js';

interface Layer extends ExpressLayer {
  handle: ((...args: unknown[]) => unknown);
  route?: { path: unknown; methods: Record<string, boolean>; stack: Layer[] };
  regexp: RegExp & { fast_slash?: boolean };
  keys: Array<{ name: string | number }>;
  method?: string;
}
interface RouterState { stack: Layer[]; params?: Record<string, unknown[]> }
export interface DeviceRouteEntry { readonly method: string; readonly path: string }

const fail = (reason: string): never => { throw new Error(`device route admission: ${reason}`); };
const signature = (regexp: RegExp) => `${regexp.source}/${regexp.flags}`;
const compiled = new Map<string, Set<string>>();
const parameters = (layer: Layer) => layer.keys.map(({ name }) => String(name));
const routeSignature = (layer: Layer) => `${signature(layer.regexp)} ${JSON.stringify(parameters(layer))}`;

function mountPath(layer: Layer): string {
  if (!(layer.regexp instanceof RegExp)) return fail('unknown mount');
  if (layer.regexp.fast_slash && layer.regexp.source === '^\\/?(?=\\/|$)' && layer.keys.length === 0) return '';
  const match = /^\^((?:\\\/[a-zA-Z0-9_-]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  if (!match || layer.keys.length !== 0) return fail('non-literal or unknown mount');
  return match[1].replace(/\\\//g, '/');
}

/** Only whole literal/parameter segments are analyzable; verify the actual Express compiler and parameter keys as well. */
function routePath(layer: Layer): string {
  const value = layer.route!.path;
  if (typeof value !== 'string' || !DEVICE_ROUTE_PATH.test(value)) return fail('unknown route path');
  let accepted = compiled.get(value);
  if (!accepted) {
    accepted = new Set();
    for (const caseSensitive of [false, true]) for (const strict of [false, true]) {
      const router = Router({ caseSensitive, strict });
      router.get(value, (_req, _res) => undefined);
      accepted.add(routeSignature((router as unknown as RouterState).stack[0]));
    }
    compiled.set(value, accepted);
  }
  if (!accepted.has(routeSignature(layer))) return fail('unknown compiled route matcher');
  return value;
}

function deviceMatch(layer: Layer, prefix: string, relative: string): boolean {
  // With the compiler-checked grammar there is exactly one segment shape. Substitute the protected namespace for a
  // parameter in its position and a non-owner value elsewhere, then ask this layer's actual matcher, not a path regex.
  const full = prefix + relative;
  const segments = full.slice(1).split('/').map((part, index) => part.startsWith(':') ? index === 0 ? 'card-sync' : 'device-probe' : part);
  if (segments[0]?.toLowerCase() !== 'card-sync' || segments[1]?.toLowerCase() === 'owner') return false;
  const probe = `/${segments.join('/')}`.slice(prefix.length);
  return RegExp.prototype.test.call(layer.regexp, probe);
}

function intersectsDevices(prefix: string): boolean {
  const segments = prefix.split('/').filter(Boolean);
  return segments.length === 0 || (segments[0].toLowerCase() === 'card-sync' && segments[1]?.toLowerCase() !== 'owner');
}

/**
 * E2's actual mounted-app proof. Build apps with createApp (or createVerifiedApp in isolated fixtures), and inspectable
 * containers with createVerifiedRouter. Those factories certify dispatch identity, never authorization. Unknown ambient
 * middleware, forwarding closures, forged stacks, parameter hooks and unsupported compiled matchers fail closed.
 */
export function assertDeviceRoutesGuarded(
  app: Express | Router,
  options: { requireDeviceRoutes?: boolean; expected?: readonly DeviceRouteEntry[] } = {},
): readonly DeviceRouteEntry[] {
  const root = (app as unknown as { _router?: RouterState })._router ?? app as unknown as RouterState;
  if (!isVerifiedRouter(root)) return fail('unverified Express router identity');
  const result: DeviceRouteEntry[] = [];
  const visiting = new Set<RouterState>();
  let afterDevice = false;

  function walk(router: RouterState, prefix: string): void {
    if (visiting.has(router)) return fail('cyclic router');
    visiting.add(router);
    const local: Array<{ entry: DeviceRouteEntry; matcher: string }> = [];
    for (const layer of router.stack) {
      if (!isVerifiedExpressLayer(layer)) return fail('unverified Express layer');
      if (layer.route) {
        if (!isVerifiedRouteLayer(layer)) return fail('unverified route dispatch');
        const path = routePath(layer);
        if (!deviceMatch(layer, prefix, path)) continue;
        const full = prefix + path;
        if (parameters(layer).some((name) => (router.params?.[name]?.length ?? 0) > 0)) return fail(`parameter callback before ${full}`);
        if (afterDevice) return fail(`device route after owner middleware at ${full}`);
        const route = layer.route;
        if (!isVerifiedRouteLayer(layer) || route.stack.length !== 1 || !isDeviceAdmissionRoute(route.stack[0].handle)
          || route.stack[0].handle_request !== layer.handle_request || route.stack[0].handle_error !== layer.handle_error) {
          return fail(`unguarded ${full}`);
        }
        const methods = Object.keys(route.methods).filter((method) => route.methods[method]);
        if (methods.length !== 1 || !/^(get|head|post|put|patch|delete|options)$/.test(methods[0])) return fail(`unknown method at ${full}`);
        if (route.stack[0].method !== methods[0]) return fail(`unknown handler method at ${full}`);
        const entry = Object.freeze({ method: methods[0].toUpperCase(), path: full });
        result.push(entry);
        local.push({ entry, matcher: signature(layer.regexp) });
        continue;
      }
      const mounted = prefix + mountPath(layer);
      if (!intersectsDevices(mounted)) continue;
      // Ambient identities are audited against root-relative paths, not arbitrary protected mounts.
      if (mounted === '') {
        if (isVerifiedExpressBuiltin(layer)) continue;
        const stage = appDeviceMiddlewareStage(app as Express, layer.handle);
        if (stage) {
          if (stage === 'after-device') afterDevice = true;
          continue;
        }
        if (isCardSpendingDevicePassthrough(layer.handle)) continue;
      }
      if (!isVerifiedRouter(layer.handle)) return fail(`unverified middleware before admission at ${mounted || '/'}`);
      walk(layer.handle as unknown as RouterState, mounted);
    }
    for (const { entry, matcher } of local) {
      if (entry.method !== 'OPTIONS' && !local.some((candidate) => candidate.entry.method === 'OPTIONS' && candidate.matcher === matcher)) {
        return fail(`implicit OPTIONS without admission at ${entry.path}`);
      }
    }
    visiting.delete(router);
  }

  walk(root, '');
  if ((options.requireDeviceRoutes ?? true) && result.length === 0) return fail('no device routes enumerated');
  if (options.expected) {
    const keys = (routes: readonly DeviceRouteEntry[]) => routes.map(({ method, path }) => `${method} ${path}`).sort();
    if (JSON.stringify(keys(result)) !== JSON.stringify(keys(options.expected))) return fail('device route catalog differs');
  }
  return Object.freeze(result);
}
