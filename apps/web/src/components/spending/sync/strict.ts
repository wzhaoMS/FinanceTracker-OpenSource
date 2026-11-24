/**
 * Exact-key schemas for the card-sync owner API (E2a–E2d; the E8-M proposal shaped it), built on
 * the E1a strict-JSON toolkit: a value is first read once into a detached
 * plain-JSON snapshot (`snapshotStrictJson`: no getters run, no prototype or
 * forbidden keys, Holdr's card detectors on every key and value, bounded
 * size), and the snapshot must then match the schema exactly: every key
 * known, every required key present, every value of its type, grammar, enum or range. Only declared optional fields may
 * be absent; this supports the additive inventory continuation metadata without accepting arbitrary extra keys.
 * Issues are `{code, path}` only and never carry a value.
 */
import {
  CardSyncIssueList,
  cardSyncIndexPath,
  checkExactKeys,
  isJsonObject,
  snapshotStrictJson,
  type CardSyncIssue,
  type JsonValue,
  type StrictJsonLimits,
} from '@finance-tracker/shared';

export interface StringSpec { readonly t: 'string'; readonly max: number; readonly test: (value: string) => boolean }
export interface IntSpec { readonly t: 'int'; readonly min: number; readonly max: number }
export interface BoolSpec { readonly t: 'bool' }
export interface ConstSpec<V extends string | boolean> { readonly t: 'const'; readonly value: V }
export interface EnumSpec<V extends string> { readonly t: 'enum'; readonly values: readonly V[] }
export interface NullableSpec<I extends Spec> { readonly t: 'nullable'; readonly inner: I }
export interface OptionalSpec<I extends Spec> { readonly t: 'optional'; readonly inner: I }
export interface ArraySpec<I extends Spec> { readonly t: 'array'; readonly item: I; readonly max: number }
export interface ObjectSpec<K extends Record<string, Spec>> { readonly t: 'object'; readonly keys: K }
/** A value judged by its own validator (an embedded v2 payload); null refuses it. */
export interface EmbedSpec<V> { readonly t: 'embed'; readonly validate: (value: JsonValue) => V | null }

export type Spec =
  | StringSpec
  | IntSpec
  | BoolSpec
  | ConstSpec<string | boolean>
  | EnumSpec<string>
  | NullableSpec<any>
  | OptionalSpec<any>
  | ArraySpec<any>
  | ObjectSpec<any>
  | EmbedSpec<any>;

export type Infer<T> = T extends StringSpec
  ? string
  : T extends IntSpec
    ? number
    : T extends BoolSpec
      ? boolean
      : T extends ConstSpec<infer V>
        ? V
        : T extends EnumSpec<infer V>
          ? V
          : T extends OptionalSpec<infer I>
            ? Infer<I>
          : T extends NullableSpec<infer I>
            ? Infer<I> | null
            : T extends ArraySpec<infer I>
              ? Array<Infer<I>>
              : T extends ObjectSpec<infer K>
                ? { [P in keyof K as K[P] extends OptionalSpec<any> ? never : P]: Infer<K[P]> }
                  & { [P in keyof K as K[P] extends OptionalSpec<any> ? P : never]?: Infer<K[P]> }
                : T extends EmbedSpec<infer V>
                  ? V
                  : never;

export const S = {
  string(test: RegExp | ((value: string) => boolean), max: number): StringSpec {
    return { t: 'string', max, test: typeof test === 'function' ? test : (value) => test.test(value) };
  },
  int(min: number, max: number): IntSpec {
    return { t: 'int', min, max };
  },
  bool(): BoolSpec {
    return { t: 'bool' };
  },
  const<V extends string | boolean>(value: V): ConstSpec<V> {
    return { t: 'const', value };
  },
  enum<V extends string>(values: readonly V[]): EnumSpec<V> {
    return { t: 'enum', values };
  },
  nullable<I extends Spec>(inner: I): NullableSpec<I> {
    return { t: 'nullable', inner };
  },
  optional<I extends Spec>(inner: I): OptionalSpec<I> {
    return { t: 'optional', inner };
  },
  array<I extends Spec>(item: I, max: number): ArraySpec<I> {
    return { t: 'array', item, max };
  },
  object<K extends Record<string, Spec>>(keys: K): ObjectSpec<K> {
    return { t: 'object', keys };
  },
  embed<V>(validate: (value: JsonValue) => V | null): EmbedSpec<V> {
    return { t: 'embed', validate };
  },
};

/** Every object key a schema names: issue paths show these by name, and a unit test runs them through the key policy. */
export function schemaKeys(spec: Spec, into: Set<string> = new Set()): Set<string> {
  if (spec.t === 'object') {
    for (const [key, child] of Object.entries(spec.keys as Record<string, Spec>)) {
      into.add(key);
      schemaKeys(child, into);
    }
  } else if (spec.t === 'array') {
    schemaKeys(spec.item as Spec, into);
  } else if (spec.t === 'nullable' || spec.t === 'optional') {
    schemaKeys(spec.inner as Spec, into);
  }
  return into;
}

function fail(issues: CardSyncIssueList, code: CardSyncIssue['code'], path: string): false {
  issues.add(code, path);
  return false;
}

function check(spec: Spec, value: JsonValue, path: string, issues: CardSyncIssueList): boolean {
  if (issues.full) return false;
  switch (spec.t) {
    case 'string':
      if (typeof value !== 'string') return fail(issues, 'wrong-type', path);
      if (value.length > spec.max) return fail(issues, 'string-too-long', path);
      return spec.test(value) ? true : fail(issues, 'invalid-format', path);
    case 'int':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail(issues, 'wrong-type', path);
      return value >= spec.min && value <= spec.max ? true : fail(issues, 'out-of-range', path);
    case 'bool':
      return typeof value === 'boolean' ? true : fail(issues, 'wrong-type', path);
    case 'const':
      if (typeof value !== typeof spec.value) return fail(issues, 'wrong-type', path);
      return value === spec.value ? true : fail(issues, 'invalid-enum', path);
    case 'enum':
      if (typeof value !== 'string') return fail(issues, 'wrong-type', path);
      return (spec.values as readonly string[]).includes(value) ? true : fail(issues, 'invalid-enum', path);
    case 'nullable':
      return value === null ? true : check(spec.inner as Spec, value, path, issues);
    case 'optional':
      return check(spec.inner as Spec, value, path, issues);
    case 'array': {
      if (!Array.isArray(value)) return fail(issues, 'wrong-type', path);
      if (value.length > spec.max) return fail(issues, 'too-many-items', path);
      let ok = true;
      value.forEach((item, index) => {
        if (!check(spec.item as Spec, item, cardSyncIndexPath(path, index), issues)) ok = false;
      });
      return ok;
    }
    case 'object': {
      if (!isJsonObject(value)) return fail(issues, 'wrong-type', path);
      const keys = spec.keys as Record<string, Spec>;
      const expected = Object.keys(keys).filter((key) => keys[key].t !== 'optional' || Object.hasOwn(value, key));
      let ok = checkExactKeys(value, path, expected, issues);
      for (const [key, child] of Object.entries(keys)) {
        if (Object.prototype.hasOwnProperty.call(value, key) && !check(child, value[key] as JsonValue, `${path}.${key}`, issues)) ok = false;
      }
      return ok;
    }
    case 'embed':
      return spec.validate(value) === null ? fail(issues, 'inconsistent', path) : true;
    default:
      return fail(issues, 'wrong-type', path);
  }
}

function replaceEmbeds(spec: Spec, value: JsonValue): unknown {
  switch (spec.t) {
    case 'embed':
      return spec.validate(value);
    case 'nullable':
      return value === null ? null : replaceEmbeds(spec.inner as Spec, value);
    case 'optional':
      return replaceEmbeds(spec.inner as Spec, value);
    case 'array':
      return (value as JsonValue[]).map((item) => replaceEmbeds(spec.item as Spec, item));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(spec.keys as Record<string, Spec>)) {
        if (child.t === 'optional' && !Object.hasOwn(value as object, key)) continue;
        out[key] = replaceEmbeds(child, (value as Record<string, JsonValue>)[key]);
      }
      return out;
    }
    default:
      return value;
  }
}

export type StrictParse<V> = { ok: true; value: V } | { ok: false; issues: CardSyncIssue[] };

/**
 * Reads `input` once (a strict snapshot, never the caller's object) and checks
 * it against `spec`. On success the value is the detached snapshot, with any
 * embedded value replaced by what its own validator returned.
 */
export function parseStrictValue(spec: Spec, input: unknown, limits?: Partial<StrictJsonLimits>): StrictParse<unknown> {
  const snapshot = snapshotStrictJson(input, { limits, knownKeys: schemaKeys(spec) });
  if (!snapshot.ok) return { ok: false, issues: snapshot.issues };
  const issues = new CardSyncIssueList();
  if (!check(spec, snapshot.value, '$', issues)) {
    return { ok: false, issues: issues.list.length > 0 ? issues.list : [{ code: 'inconsistent', path: '$' }] };
  }
  return { ok: true, value: replaceEmbeds(spec, snapshot.value) };
}

/** {@link parseStrictValue}, typed by the schema. */
export function parseStrict<T extends Spec>(spec: T, input: unknown, limits?: Partial<StrictJsonLimits>): StrictParse<Infer<T>> {
  return parseStrictValue(spec, input, limits) as StrictParse<Infer<T>>;
}
