/**
 * Exact-key schemas for every message the extension passes between worlds,
 * between extension contexts and to or from Holdr, built on the contract's
 * strict JSON toolkit (`snapshotStrictJson` + `checkExactKeys`):
 *
 * 1. the input is read once into a detached plain-JSON snapshot (no getters
 *    run, no prototypes, no forbidden keys, card detectors on every value,
 *    bounded size), then
 * 2. the snapshot must match the schema exactly: every key known, every key
 *    present, every value of its type, grammar, enum or range.
 *
 * The result is a fresh object built from the snapshot, never the caller's
 * object. Issues are `{code, path}` only and never carry a value.
 */
import {
  CARD_SYNC_MAX_ISSUES,
  CardSyncIssueList,
  cardSyncIndexPath,
  checkExactKeys,
  isJsonObject,
  snapshotStrictJson,
  type CardSyncIssue,
  type JsonValue,
  type StrictJsonLimits,
} from '@finance-tracker/shared';

export interface ConstSpec<V extends string | number | boolean | null = string | number | boolean | null> {
  readonly t: 'const';
  readonly value: V;
}
export interface EnumSpec<V extends string = string> {
  readonly t: 'enum';
  readonly values: readonly V[];
}
export interface StringSpec {
  readonly t: 'string';
  readonly max: number;
  readonly test: (value: string) => boolean;
}
export interface IntSpec {
  readonly t: 'int';
  readonly min: number;
  readonly max: number;
}
export interface BoolSpec {
  readonly t: 'bool';
}
export interface NullableSpec<I extends Spec = Spec> {
  readonly t: 'nullable';
  readonly inner: I;
}
export interface ArraySpec<I extends Spec = Spec> {
  readonly t: 'array';
  readonly item: I;
  readonly max: number;
}
export interface ObjectSpec<K extends Record<string, Spec> = Record<string, Spec>> {
  readonly t: 'object';
  readonly keys: K;
}
export type EmbedResult<V> = { ok: true; value: V } | { ok: false; issues: readonly CardSyncIssue[] };
/** A value judged by another validator (a v2 payload, a projected batch), whose issue paths are re-rooted here. */
export interface EmbedSpec<V = unknown> {
  readonly t: 'embed';
  readonly knownKeys: ReadonlySet<string>;
  readonly validate: (value: JsonValue) => EmbedResult<V>;
}

export type Spec = ConstSpec | EnumSpec | StringSpec | IntSpec | BoolSpec | NullableSpec | ArraySpec | ObjectSpec | EmbedSpec;

export type Infer<S> = S extends ConstSpec<infer V>
  ? V
  : S extends EnumSpec<infer V>
    ? V
    : S extends StringSpec
      ? string
      : S extends IntSpec
        ? number
        : S extends BoolSpec
          ? boolean
          : S extends NullableSpec<infer I>
            ? Infer<I> | null
            : S extends ArraySpec<infer I>
              ? Array<Infer<I>>
              : S extends ObjectSpec<infer K>
                ? { [P in keyof K]: Infer<K[P]> }
                : S extends EmbedSpec<infer V>
                  ? V
                  : never;

export const S = Object.freeze({
  const: <V extends string | number | boolean | null>(value: V): ConstSpec<V> => ({ t: 'const', value }),
  enum: <V extends string>(values: readonly V[]): EnumSpec<V> => ({ t: 'enum', values }),
  string: (test: RegExp | ((value: string) => boolean), max: number): StringSpec => ({
    t: 'string',
    max,
    test: typeof test === 'function' ? test : (value: string) => test.test(value),
  }),
  int: (min: number, max: number): IntSpec => ({ t: 'int', min, max }),
  bool: (): BoolSpec => ({ t: 'bool' }),
  nullable: <I extends Spec>(inner: I): NullableSpec<I> => ({ t: 'nullable', inner }),
  array: <I extends Spec>(item: I, max: number): ArraySpec<I> => ({ t: 'array', item, max }),
  object: <K extends Record<string, Spec>>(keys: K): ObjectSpec<K> => ({ t: 'object', keys }),
  embed: <V>(knownKeys: ReadonlySet<string>, validate: (value: JsonValue) => EmbedResult<V>): EmbedSpec<V> => ({
    t: 'embed',
    knownKeys,
    validate,
  }),
});

export type StrictResult<V> = { ok: true; value: V } | { ok: false; issues: CardSyncIssue[] };

/** Limits for small control messages: commands, configs, statuses, Holdr control responses. */
export const SMALL_MESSAGE_LIMITS: Readonly<StrictJsonLimits> = Object.freeze({
  maxDepth: 8,
  maxKeysPerObject: 32,
  maxArrayLength: 100,
  maxNodes: 5_000,
  maxStringLength: 1_024,
  maxKeyLength: 64,
  maxBytes: 64 * 1024,
});

/** Limits for an envelope carrying one v2 payload or one projected batch (2 MiB each) one level down. */
export const BATCH_MESSAGE_LIMITS: Readonly<StrictJsonLimits> = Object.freeze({
  maxDepth: 7,
  maxKeysPerObject: 32,
  maxArrayLength: 2_000,
  maxNodes: 60_100,
  maxStringLength: 1_024,
  maxKeyLength: 64,
  maxBytes: 2 * 1024 * 1024 + 4 * 1024,
});

const BAD: unique symbol = Symbol('bad');

const knownKeyCache = new WeakMap<object, ReadonlySet<string>>();

/** Every key a schema names, so issue paths can show them; any other key shows as `<key>`. */
export function specKnownKeys(spec: Spec): ReadonlySet<string> {
  const cached = knownKeyCache.get(spec);
  if (cached) return cached;
  const keys = new Set<string>();
  const visit = (node: Spec): void => {
    switch (node.t) {
      case 'nullable':
        visit(node.inner);
        break;
      case 'array':
        visit(node.item);
        break;
      case 'object':
        for (const [key, child] of Object.entries(node.keys)) {
          keys.add(key);
          visit(child);
        }
        break;
      case 'embed':
        for (const key of node.knownKeys) keys.add(key);
        break;
      default:
        break;
    }
  };
  visit(spec);
  knownKeyCache.set(spec, keys);
  return keys;
}

function reroot(base: string, path: string): string {
  return path === '$' ? base : `${base}${path.slice(1)}`;
}

function check(value: JsonValue, spec: Spec, path: string, issues: CardSyncIssueList): unknown {
  switch (spec.t) {
    case 'const':
      if (value !== spec.value) {
        issues.add(typeof value === typeof spec.value ? 'invalid-enum' : 'wrong-type', path);
        return BAD;
      }
      return value;
    case 'enum':
      if (typeof value !== 'string') {
        issues.add('wrong-type', path);
        return BAD;
      }
      if (!(spec.values as readonly string[]).includes(value)) {
        issues.add('invalid-enum', path);
        return BAD;
      }
      return value;
    case 'string':
      if (typeof value !== 'string') {
        issues.add('wrong-type', path);
        return BAD;
      }
      if (value.length > spec.max || !spec.test(value)) {
        issues.add('invalid-format', path);
        return BAD;
      }
      return value;
    case 'int':
      if (typeof value !== 'number') {
        issues.add('wrong-type', path);
        return BAD;
      }
      if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
        issues.add('out-of-range', path);
        return BAD;
      }
      return value;
    case 'bool':
      if (typeof value !== 'boolean') {
        issues.add('wrong-type', path);
        return BAD;
      }
      return value;
    case 'nullable':
      return value === null ? null : check(value, spec.inner, path, issues);
    case 'array': {
      if (!Array.isArray(value)) {
        issues.add('wrong-type', path);
        return BAD;
      }
      if (value.length > spec.max) {
        issues.add('too-many-items', path);
        return BAD;
      }
      const out: unknown[] = [];
      let failed = false;
      value.forEach((item, index) => {
        const child = check(item, spec.item, cardSyncIndexPath(path, index), issues);
        if (child === BAD) failed = true;
        else out.push(child);
      });
      return failed ? BAD : out;
    }
    case 'object': {
      if (!isJsonObject(value)) {
        issues.add('wrong-type', path);
        return BAD;
      }
      const names = Object.keys(spec.keys);
      let failed = !checkExactKeys(value, path, names, issues);
      const out: Record<string, unknown> = {};
      for (const name of names) {
        if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
        const child = check(value[name], spec.keys[name], `${path}.${name}`, issues);
        if (child === BAD) failed = true;
        else Object.defineProperty(out, name, { value: child, enumerable: true, writable: true, configurable: true });
      }
      return failed ? BAD : out;
    }
    case 'embed': {
      const result = spec.validate(value);
      if (!result.ok) {
        for (const issue of result.issues) issues.add(issue.code, reroot(path, issue.path));
        if (result.issues.length === 0) issues.add('unreadable', path);
        return BAD;
      }
      return result.value;
    }
    default:
      issues.add('unreadable', path);
      return BAD;
  }
}

export interface ParseOptions {
  limits?: Readonly<StrictJsonLimits>;
  maxIssues?: number;
}

/** Reads `input` once and checks it against `spec` exactly. Never throws; never echoes a value. */
export function parseStrict<T extends Spec>(input: unknown, spec: T, options: ParseOptions = {}): StrictResult<Infer<T>> {
  return parseStrictAny(input, spec, options) as StrictResult<Infer<T>>;
}

/** `parseStrict` without type inference, for callers that name the result type themselves. */
export function parseStrictAny(input: unknown, spec: Spec, options: ParseOptions = {}): StrictResult<unknown> {
  const known = specKnownKeys(spec);
  const snapshot = snapshotStrictJson(input, { limits: options.limits ?? SMALL_MESSAGE_LIMITS, knownKeys: known, maxIssues: options.maxIssues });
  if (!snapshot.ok) return { ok: false, issues: snapshot.issues };
  const issues = new CardSyncIssueList(options.maxIssues ?? CARD_SYNC_MAX_ISSUES);
  const value = check(snapshot.value, spec, '$', issues);
  if (value === BAD || issues.size > 0) {
    if (issues.size === 0) issues.add('unreadable', '$');
    return { ok: false, issues: issues.list };
  }
  return { ok: true, value };
}

/**
 * A discriminated union: reads the tag (an own string field) from the
 * snapshot, then checks the whole value against that variant only.
 */
export function parseStrictUnion<V extends Record<string, ObjectSpec>>(
  input: unknown,
  tagKey: string,
  variants: V,
  options: ParseOptions = {},
): StrictResult<{ [K in keyof V]: Infer<V[K]> }[keyof V]> {
  const known = new Set<string>([tagKey]);
  for (const variant of Object.values(variants)) for (const key of specKnownKeys(variant)) known.add(key);
  const snapshot = snapshotStrictJson(input, { limits: options.limits ?? SMALL_MESSAGE_LIMITS, knownKeys: known, maxIssues: options.maxIssues });
  if (!snapshot.ok) return { ok: false, issues: snapshot.issues };
  const root = snapshot.value;
  if (!isJsonObject(root)) return { ok: false, issues: [{ code: 'wrong-type', path: '$' }] };
  if (!Object.prototype.hasOwnProperty.call(root, tagKey)) return { ok: false, issues: [{ code: 'missing-key', path: `$.${tagKey}` }] };
  const tag = root[tagKey];
  if (typeof tag !== 'string') return { ok: false, issues: [{ code: 'wrong-type', path: `$.${tagKey}` }] };
  if (!Object.prototype.hasOwnProperty.call(variants, tag)) return { ok: false, issues: [{ code: 'invalid-enum', path: `$.${tagKey}` }] };
  const issues = new CardSyncIssueList(options.maxIssues ?? CARD_SYNC_MAX_ISSUES);
  const value = check(root, variants[tag], '$', issues);
  if (value === BAD || issues.size > 0) {
    if (issues.size === 0) issues.add('unreadable', '$');
    return { ok: false, issues: issues.list };
  }
  return { ok: true, value: value as { [K in keyof V]: Infer<V[K]> }[keyof V] };
}

/** A short, value-free summary of issues for a status line or a log: `code at path; …`. */
export function describeIssues(issues: readonly CardSyncIssue[], max = 3): string {
  return issues
    .slice(0, max)
    .map((issue) => `${issue.code} at ${issue.path}`)
    .join('; ');
}
