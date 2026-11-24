/**
 * Narrow readers for untrusted issuer JSON, for adapters: each reads one own
 * data property of one expected type and never invokes a getter. Anything
 * unexpected is reported as `undefined`, and adapters treat an unexpected
 * shape as a stopped contract, never as a reason to look elsewhere.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

export function str(record: Record<string, unknown>, key: string, max = 4_096): string | undefined {
  const value = own(record, key);
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

export function strOrNull(record: Record<string, unknown>, key: string, max = 4_096): string | null | undefined {
  const value = own(record, key);
  if (value === null) return null;
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

export function num(record: Record<string, unknown>, key: string): number | undefined {
  const value = own(record, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function bool(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = own(record, key);
  return typeof value === 'boolean' ? value : undefined;
}

export function list(record: Record<string, unknown>, key: string, max = 2_000): unknown[] | undefined {
  const value = own(record, key);
  return Array.isArray(value) && value.length <= max ? value : undefined;
}

/** True when `record` has exactly these keys (no more, no fewer). */
export function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}
