/**
 * Ids. Contract and control-envelope ids (`cpt_`, `stm_`, `cnd_`, `hld_`,
 * `crn_`, and Holdr's `run_`, `obs_`, `prv_`, `dev_`) are the contract's
 * (`formatCardSyncId`, `isCardSyncId`). The extension's own bookkeeping ids
 * use the same grammar, a fixed prefix, `_` and exactly 32 letters a–p: no
 * digits, so no id can look like card data to Holdr's detectors, and no
 * structure to read meaning into.
 */
import { formatCardSyncId, toLetterHex, type CardSyncIdKind } from '@finance-tracker/shared';

export const LOCAL_ID_PREFIXES = Object.freeze({
  /** A collector document known to the worker (tab + document), never a browser id. */
  document: 'doc',
  /** The MAIN↔ISOLATED bridge nonce of one document. */
  nonce: 'nnc',
} as const);

export type LocalIdKind = keyof typeof LOCAL_ID_PREFIXES;

const LOCAL_PATTERNS: Readonly<Record<LocalIdKind, RegExp>> = Object.freeze({
  document: /^doc_[a-p]{32}$/,
  nonce: /^nnc_[a-p]{32}$/,
});

function randomBytes16(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export function newLocalId(kind: LocalIdKind): string {
  return `${LOCAL_ID_PREFIXES[kind]}_${toLetterHex(randomBytes16())}`;
}

export function isLocalId(kind: LocalIdKind, value: unknown): value is string {
  return typeof value === 'string' && LOCAL_PATTERNS[kind].test(value);
}

/** A fresh contract id of `kind` from 16 random bytes. */
export function newCardSyncId(kind: CardSyncIdKind): string {
  return formatCardSyncId(kind, randomBytes16());
}
