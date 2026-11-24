import { parseCommandJson } from './commandJson.js';

export interface ServeExpectations {
  readonly host: string;
  readonly socketPath: string;
  readonly holdrPorts?: readonly number[];
  readonly legacyPort?: number;
}
export const SERVE_CODES = [
  'serve-output-invalid', 'serve-schema-unknown', 'funnel-enabled', 'foreground-config', 'services-config',
  'tcp-terminate-tls', 'tcp-forward-to-holdr', 'tcp-forward', 'path-handler', 'other-handler',
  'cookie-neighbour', 'plain-http-serve', 'same-origin-mount', 'proxy-target-mismatch', 'serve-shape-mismatch',
] as const;
export type ServeCode = typeof SERVE_CODES[number];
export type ServeVerdict = 'approved-dist' | 'approved-vite' | 'empty' | 'refused' | 'error';
export interface ServeResult { readonly verdict: ServeVerdict; readonly codes: readonly ServeCode[] }

const FIELDS: Record<string, Record<string, string>> = {
  ServeConfig: { TCP: 'map:TCPPortHandler', Web: 'map:WebServerConfig', Services: 'map:ServiceConfig', AllowFunnel: 'map:bool', Foreground: 'map:ServeConfig' },
  TCPPortHandler: { HTTPS: 'bool', HTTP: 'bool', TCPForward: 'string', TerminateTLS: 'string', ProxyProtocol: 'int' },
  WebServerConfig: { Handlers: 'map:HTTPHandler' },
  HTTPHandler: { Path: 'string', Proxy: 'string', Text: 'string', AcceptAppCaps: 'strings', Redirect: 'string' },
  ServiceConfig: { TCP: 'map:TCPPortHandler', Web: 'map:WebServerConfig', Tun: 'bool' },
};
export const jsonObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const entries = (value: unknown) => jsonObject(value) ? Object.entries(value) : [];
const has = (value: Record<string, unknown>, name: string) => Object.hasOwn(value, name);

export function approvedServeShape(mode: 'dist' | 'vite', expectations: ServeExpectations) {
  return {
    TCP: { '443': { HTTPS: true } },
    Web: { [`${expectations.host}:443`]: { Handlers: { '/': {
      Proxy: mode === 'dist' ? `unix:${expectations.socketPath}` : `http://127.0.0.1:${expectations.legacyPort ?? 8888}`,
    } } } },
  };
}

/** Go MarshalIndent: this fixed shape has declaration-order fields and one-key maps. */
export function canonicalServeJson(mode: 'dist' | 'vite', expectations: ServeExpectations): string {
  return JSON.stringify(approvedServeShape(mode, expectations), null, 2)
    .replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n';
}

function schemaKnown(value: unknown, type: string, foreground = false, depth = 0): boolean {
  if (depth > 16) return false;
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'int') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2;
  if (type === 'string') return typeof value === 'string';
  if (type === 'strings') return Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (type.startsWith('map:')) {
    if (value === null) return true;
    if (!jsonObject(value)) return false;
    return Object.entries(value).every(([key, item]) => {
      if (type === 'map:TCPPortHandler' && (!/^[1-9][0-9]{0,4}$/.test(key) || Number(key) > 65535)) return false;
      return schemaKnown(item, type.slice(4), foreground, depth + 1);
    });
  }
  if (!jsonObject(value)) return false;
  return Object.entries(value).every(([key, item]) => has(FIELDS[type], key)
    && !(key === 'Foreground' && foreground)
    && schemaKnown(item, FIELDS[type][key], foreground || key === 'Foreground', depth + 1));
}

/** Every key at every level is one of Serve's known fields, with its type (also used by the TCP-owner guard, B-D27). */
export function serveSchemaKnown(config: unknown): boolean {
  return schemaKnown(config, 'ServeConfig');
}

export function validateServeStatus(stdout: string, _mode: 'dist' | 'local' | 'vite', expectations: ServeExpectations): ServeResult {
  let config: unknown;
  try { config = parseCommandJson(stdout); }
  catch { return { verdict: 'error', codes: ['serve-output-invalid'] }; }
  if (config === null || (jsonObject(config) && Object.keys(config).length === 0)) return { verdict: 'empty', codes: [] };
  if (!jsonObject(config)) return { verdict: 'error', codes: ['serve-output-invalid'] };
  const codes = new Set<ServeCode>();
  if (!serveSchemaKnown(config)) codes.add('serve-schema-unknown');
  const site = `${expectations.host}:443`;
  const targets = [`unix:${expectations.socketPath}`, `http://127.0.0.1:${expectations.legacyPort ?? 8888}`];
  const ports = new Set([4000, 8888, 3003, 5173, ...(expectations.holdrPorts ?? [])]);
  const walk = (level: Record<string, unknown>, top: boolean, depth: number): void => {
    if (depth > 16) { codes.add('serve-schema-unknown'); return; }
    if (level.AllowFunnel != null && (!jsonObject(level.AllowFunnel) || entries(level.AllowFunnel).length)) codes.add('funnel-enabled');
    if (level.Foreground != null && (!jsonObject(level.Foreground) || entries(level.Foreground).length)) codes.add('foreground-config');
    if (level.Services != null && (!jsonObject(level.Services) || entries(level.Services).length)) codes.add('services-config');
    for (const [port, handler] of entries(level.TCP)) {
      if (port !== '443') codes.add('cookie-neighbour');
      if (!jsonObject(handler)) continue;
      if (has(handler, 'TerminateTLS')) codes.add('tcp-terminate-tls');
      if (has(handler, 'TCPForward')) {
        const match = typeof handler.TCPForward === 'string' && /^(?:\[[^\]]+\]|[^:]+):([0-9]{1,5})$/.exec(handler.TCPForward);
        codes.add(!match || Number(match[1]) < 1 || Number(match[1]) > 65535 || ports.has(Number(match[1]))
          ? 'tcp-forward-to-holdr' : 'tcp-forward');
      }
      if (handler.HTTP !== undefined && handler.HTTP !== false) {
        codes.add('plain-http-serve');
        codes.add('cookie-neighbour');
      }
      if (port === '443' && !(handler.HTTPS === true && Object.keys(handler).length === 1)) codes.add('serve-shape-mismatch');
    }
    for (const [name, web] of entries(level.Web)) {
      if (name !== site) codes.add(name.replace(/:\d+$/, '') === expectations.host ? 'cookie-neighbour' : 'serve-shape-mismatch');
      if (!jsonObject(web)) continue;
      const handlers = entries(web.Handlers);
      if (top && name === site) {
        const root = handlers.find(([mount]) => mount === '/')?.[1];
        if (handlers.length !== 1 || !jsonObject(root) || Object.keys(root).length !== 1 || typeof root.Proxy !== 'string') codes.add('serve-shape-mismatch');
      }
      for (const [mount, handler] of handlers) {
        if (!jsonObject(handler)) continue;
        if (has(handler, 'Path')) codes.add('path-handler');
        if (has(handler, 'Text') || has(handler, 'Redirect')
          || (has(handler, 'AcceptAppCaps') && (!Array.isArray(handler.AcceptAppCaps) || handler.AcceptAppCaps.length > 0))) codes.add('other-handler');
        if (top && name === site) {
          if (mount !== '/') codes.add('same-origin-mount');
          else if (has(handler, 'Proxy') && !targets.includes(handler.Proxy as string)) codes.add('proxy-target-mismatch');
        }
      }
    }
    for (const key of ['Services', 'Foreground']) {
      for (const [, child] of entries(level[key])) if (jsonObject(child)) walk(child, false, depth + 1);
    }
  };
  walk(config, true, 0);
  if (entries(config.TCP).length !== 1 || entries(config.TCP)[0][0] !== '443'
    || entries(config.Web).length !== 1 || entries(config.Web)[0][0] !== site) codes.add('serve-shape-mismatch');
  if (codes.size) return { verdict: 'refused', codes: [...codes].sort() };
  if (stdout === canonicalServeJson('dist', expectations)) return { verdict: 'approved-dist', codes: [] };
  if (stdout === canonicalServeJson('vite', expectations)) return { verdict: 'approved-vite', codes: [] };
  return { verdict: 'refused', codes: ['serve-schema-unknown'] };
}

export function serveModeDecision(mode: 'dist' | 'local' | 'vite', result: ServeResult): 'admit' | 'pre-start-ok' | 'refused' | 'unknown' {
  if (result.verdict === 'error') return 'unknown';
  if (mode === 'dist' && result.verdict === 'approved-dist') return 'admit';
  return ['empty', 'approved-dist', 'approved-vite'].includes(result.verdict) ? 'pre-start-ok' : 'refused';
}
