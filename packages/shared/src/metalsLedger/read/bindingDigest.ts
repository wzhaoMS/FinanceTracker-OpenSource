/**
 * Evidence-bound exemptions (card cross-check design v3.2 §6.5, §7.4): a roster binding's evidence and its digest, and
 * the roster preview's digest. The server computes every digest, on the preview, inside the answer's write and on every
 * read; the client never supplies one.
 *
 * - A binding's evidence is every in-scope usable purchase row of its groups, at any date, that isn't explained: a
 *   `source:` key's mixed group or alias groups, a `group:` key's own group. Credits and out-of-scope rows never count.
 * - Its digest binds each row's identity and content, never a count, behind a domain, a format version, the capture rule,
 *   the alias policy and the key, so the same rows under two keys never share one. The coverage label is left out
 *   (`outside-coverage` and `no-capture-match` both read `unexplained`), so extending coverage never stales an answer.
 * - Every field comes from the capture and the imported accounts alone, before and apart from the roster: an answer can
 *   never stale its own binding, and a binding is current again whenever its evidence returns to what was answered.
 *
 * Pure: no file system, network or clock.
 */

import { sha256, toLetterHex } from '../../cardDedupe.js';
import type { MetalsSource } from '../model.js';
import { METALS_CAPTURE_ALIAS_POLICY, METALS_CARD_CAPTURE_RULE, type MetalsCardCaptureResult, type MetalsCardCaptureRow } from './capture.js';

/** `source:<source>` (a mixed source, or the source an alias maps to) or `group:<group>` (a dealer or processor group). */
export type MetalsBindingKey = `source:${MetalsSource}` | `group:${string}`;

const BINDING_DOMAIN = 'holdr.metals-binding-evidence';
const PREVIEW_DOMAIN = 'holdr.metals-roster-preview';
const FORMAT = 1;
const encoder = new TextEncoder();
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const digestOf = (preimage: string) => `lh1:${toLetterHex(sha256(encoder.encode(preimage)))}`;

/** Whether a capture row is a binding's evidence: in-scope, not explained, of the key's groups. */
function evidenceOf(row: MetalsCardCaptureRow, key: MetalsBindingKey): boolean {
  if (row.status === 'explained') return false;
  if (key.startsWith('source:')) {
    return row.source === key.slice('source:'.length) && (row.scope === 'mixed-online' || row.group.startsWith('alias:'));
  }
  return row.group === key.slice('group:'.length);
}

/**
 * The binding a capture row's evidence belongs to: its source's for a mixed or alias row, its group's otherwise (null
 * only for an alias row without a source, which capture never gives). For every key the preview can show, the rows
 * metalsBindingEvidence binds are exactly the rows not explained whose key this is.
 */
export function metalsBindingKeyOf(row: Pick<MetalsCardCaptureRow, 'scope' | 'group' | 'source'>): MetalsBindingKey | null {
  if (row.scope === 'mixed-online' || row.group.startsWith('alias:')) return row.source === null ? null : `source:${row.source}`;
  return `group:${row.group}`;
}

/** A binding's evidence: its row count and its canonical preimage (no whitespace; rows by id; accounts by id). */
export function metalsBindingEvidence(capture: MetalsCardCaptureResult, key: MetalsBindingKey,
  importedAccounts: ReadonlyArray<{ accountId: string; source: MetalsSource; retired: boolean }>): { rows: number; canonical: string } {
  const rows = capture.rows.filter((row) => evidenceOf(row, key)).sort((a, b) => compareText(a.rowId, b.rowId))
    .map((row) => [
      row.rowId, row.accountId, row.date, row.amountMinor, 'USD', 'purchase', row.merchantClass ?? row.scope, row.group, row.scope,
      row.status === 'outside-coverage' || row.status === 'no-capture-match' ? 'unexplained' : row.status,
      row.reasons.filter((reason) => reason !== 'outside-coverage' && reason !== 'no-capture-match'),
    ]);
  const accounts = key.startsWith('source:')
    ? importedAccounts.filter((account) => account.source === key.slice('source:'.length))
      .map((account): [string, boolean] => [account.accountId, account.retired])
      .sort((a, b) => compareText(a[0], b[0]) || Number(a[1]) - Number(b[1]))
    : [];
  return {
    rows: rows.length,
    canonical: JSON.stringify([BINDING_DOMAIN, FORMAT, METALS_CARD_CAPTURE_RULE, METALS_CAPTURE_ALIAS_POLICY, key, rows, accounts]),
  };
}

/** A binding's digest: `lh1:` and the letter-hex SHA-256 of its canonical preimage's UTF-8. */
export function metalsBindingDigest(evidence: { canonical: string }): string {
  return digestOf(evidence.canonical);
}

/**
 * The roster preview's digest (§7.4): every binding's key, row count and digest, and the imported accounts per source,
 * under its own domain and hashed as a binding's. Bindings by key; accounts by source, then id.
 */
export function metalsRosterPreviewDigest(preview: {
  bindings: ReadonlyArray<{ key: MetalsBindingKey; rows: number; digest: string }>;
  importedAccounts: ReadonlyArray<{ source: MetalsSource; accountId: string; retired: boolean }>;
}): string {
  const bindings = [...preview.bindings].sort((a, b) => compareText(a.key, b.key) || compareText(a.digest, b.digest) || a.rows - b.rows)
    .map((binding) => [binding.key, binding.rows, binding.digest]);
  const accounts = [...preview.importedAccounts]
    .sort((a, b) => compareText(a.source, b.source) || compareText(a.accountId, b.accountId) || Number(a.retired) - Number(b.retired))
    .map((account) => [account.source, account.accountId, account.retired]);
  return digestOf(JSON.stringify([PREVIEW_DOMAIN, FORMAT, bindings, accounts]));
}
