/**
 * `shape-report/v1`: what shape-capture mode (plan §5.1) produces. Field
 * names and value types only: scalars become their type before anything is
 * built, arrays keep only their element structure (no index, no length),
 * only the contract's confirmed structural keys are named and every other
 * key becomes `<dynamic-key>` (a dynamic object key may be an account id or
 * routing material, whatever it looks like), query values and dynamic path
 * segments are dropped. Shape reports never go to Holdr: the owner reads
 * them in the popup and copies them by hand.
 */
import { ADAPTER, ISSUER, READ_CONTRACT } from './grammar.js';
import { S, type Infer } from '../common/strict.js';

export const SHAPE_REPORT_TYPE = 'shape-report/v1';
export const SHAPE_DYNAMIC_KEY = '<dynamic-key>';
export const SHAPE_MAX_RESPONSE_ENTRIES = 500;
export const SHAPE_MAX_BODY_ENTRIES = 200;
export const SHAPE_MAX_DEPTH = 12;

export const SHAPE_VALUE_TYPES = ['string', 'number', 'boolean', 'null', 'object', 'array'] as const;
export type ShapeValueType = (typeof SHAPE_VALUE_TYPES)[number];

const SHAPE_PATH = /^\$(?:\.(?:[A-Za-z_][A-Za-z0-9_]{0,63}|<dynamic-key>)|\[\])*$/;
const KEY_NAME = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,63}|<dynamic-key>)$/;
const HEADER_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const HEADER_NAME_OR_DYNAMIC = /^(?:[a-z][a-z0-9-]{0,63}|<dynamic-key>)$/;
const PATH_TEMPLATE = /^(?:\/(?:[A-Za-z0-9._~-]{1,64}|:opaque))+\/?$/;

export const SHAPE_ENTRY = S.object({
  path: S.string(SHAPE_PATH, 400),
  type: S.enum(SHAPE_VALUE_TYPES),
});

export const SHAPE_REPORT = S.object({
  type: S.const(SHAPE_REPORT_TYPE),
  adapterId: ADAPTER,
  issuer: ISSUER,
  contract: READ_CONTRACT,
  method: S.enum(['GET', 'POST'] as const),
  pathTemplate: S.string(PATH_TEMPLATE, 400),
  queryKeys: S.array(S.string(KEY_NAME, 64), 32),
  /** Names of the request's HTTP headers, never their values; unconfirmed names are `<dynamic-key>`. (Keys are named to pass the contract's key policy.) */
  requestMetaNames: S.array(S.string(HEADER_NAME_OR_DYNAMIC, 64), 32),
  requestShape: S.array(SHAPE_ENTRY, SHAPE_MAX_BODY_ENTRIES),
  responseShape: S.array(SHAPE_ENTRY, SHAPE_MAX_RESPONSE_ENTRIES),
  truncated: S.bool(),
});

export type ShapeReport = Infer<typeof SHAPE_REPORT>;
export type ShapeEntry = Infer<typeof SHAPE_ENTRY>;

/** What shape capture (plan §5.1) may report for one observed contract: trusted metadata from the adapter's descriptor. */
export interface ShapeContractSpec {
  readonly method: 'GET' | 'POST';
  /** The contract's fixed path template, dynamic segments as `:opaque`. */
  readonly template: string;
  /** Confirmed structural names: query keys, request header names (lowercase), request body and response keys. */
  readonly names: readonly string[];
}

/** A key a shape report may name: one of the contract's confirmed structural keys (plan §5.1). Any other key is `<dynamic-key>`. */
export function shapeKeyName(key: string, confirmed: ReadonlySet<string>): string {
  return confirmed.has(key) && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ? key : SHAPE_DYNAMIC_KEY;
}

/** A request header name a shape report may name: a confirmed one (lowercase); any other is `<dynamic-key>`. */
export function shapeHeaderName(name: string, confirmed: ReadonlySet<string>): string {
  const lower = name.toLowerCase();
  return confirmed.has(lower) && HEADER_NAME.test(lower) ? lower : SHAPE_DYNAMIC_KEY;
}

/**
 * Whether a report is exactly what its contract allows: the contract's method
 * and fixed path template, and no name but its confirmed ones (checked again
 * in ISOLATED and in the worker, since MAIN's output is advisory).
 */
export function shapeReportConfirmed(report: ShapeReport, spec: ShapeContractSpec | undefined): boolean {
  if (!spec || report.method !== spec.method || report.pathTemplate !== spec.template) return false;
  const confirmed = new Set(spec.names);
  const named = (key: string): boolean => key === SHAPE_DYNAMIC_KEY || confirmed.has(key);
  if (!report.queryKeys.every(named) || !report.requestMetaNames.every(named)) return false;
  for (const entry of [...report.requestShape, ...report.responseShape]) {
    for (const segment of entry.path.slice(1).split('.')) {
      const key = segment.replace(/(?:\[\])+$/, '');
      if (key !== '' && !named(key)) return false;
    }
  }
  return true;
}

/**
 * The key/type entries of a parsed JSON value, depth-first, deduplicated by
 * path. Scalars are replaced by their type before anything else happens;
 * arrays contribute the union of their elements' shapes under `[]`; keys
 * outside `confirmed` are `<dynamic-key>`.
 */
export function shapeEntries(value: unknown, maxEntries: number, confirmed: ReadonlySet<string>): { entries: ShapeEntry[]; truncated: boolean } {
  const seen = new Map<string, ShapeValueType>();
  let truncated = false;
  const typeOf = (node: unknown): ShapeValueType | null => {
    if (node === null) return 'null';
    if (Array.isArray(node)) return 'array';
    switch (typeof node) {
      case 'string':
        return 'string';
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'object':
        return 'object';
      default:
        return null;
    }
  };
  const record = (path: string, type: ShapeValueType): void => {
    if (seen.has(path)) return;
    if (seen.size >= maxEntries) {
      truncated = true;
      return;
    }
    seen.set(path, type);
  };
  const visit = (node: unknown, path: string, depth: number): void => {
    const type = typeOf(node);
    if (type === null) return;
    record(path, type);
    if (depth >= SHAPE_MAX_DEPTH) {
      if (type === 'object' || type === 'array') truncated = true;
      return;
    }
    if (type === 'array') {
      const items = node as unknown[];
      const limit = Math.min(items.length, 50);
      for (let index = 0; index < limit; index += 1) visit(items[index], `${path}[]`, depth + 1);
      if (items.length > limit) truncated = true;
    } else if (type === 'object') {
      const keys = Object.keys(node as object);
      const limit = Math.min(keys.length, 100);
      for (let index = 0; index < limit; index += 1) {
        const key = keys[index];
        const descriptor = Object.getOwnPropertyDescriptor(node as object, key);
        if (!descriptor || !('value' in descriptor)) continue;
        visit(descriptor.value, `${path}.${shapeKeyName(key, confirmed)}`, depth + 1);
      }
      if (keys.length > limit) truncated = true;
    }
  };
  visit(value, '$', 0);
  return { entries: [...seen.entries()].map(([path, type]) => ({ path, type })), truncated };
}
