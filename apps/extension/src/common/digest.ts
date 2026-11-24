/**
 * Digests are the contract's (`cardSyncPayloadDigest`, `pd1:`;
 * `cardSyncPlanDigest`, `pl1:`): SHA-256 over the UTF-8 bytes of the
 * canonical JSON, in letters a–p. What the extension adds is the check that
 * ties a digest to the exact frozen text the popup shows: that text must be
 * canonical JSON itself (re-serializing it gives the same text), so the
 * digest of its value is the digest of those very bytes.
 */
import { canonicalJson, cardSyncPayloadDigest, isCardSyncDigest, type JsonValue } from '@finance-tracker/shared';

/** The `pd1:` digest of frozen text, or null when the text is not exactly canonical JSON. */
export function frozenTextDigest(text: string): string | null {
  try {
    const value = JSON.parse(text) as JsonValue;
    if (canonicalJson(value) !== text) return null;
    return cardSyncPayloadDigest(value);
  } catch {
    return null;
  }
}

export function isPayloadDigest(value: unknown): value is string {
  return isCardSyncDigest('payload', value);
}

export function isPlanDigest(value: unknown): value is string {
  return isCardSyncDigest('plan', value);
}
