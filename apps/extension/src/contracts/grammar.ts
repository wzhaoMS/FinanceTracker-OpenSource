/**
 * Grammars shared by the extension's message schemas. Every value grammar is
 * letters-only or fixed-format, so no legitimate message can trip Holdr's
 * card detectors, and every key used here passes the contract's
 * never-sent key policy (a unit test checks both).
 */
import {
  CARD_SYNC_COMPLETENESS,
  CARD_SYNC_ISSUE_CODES,
  CARD_SYNC_ISSUE_PATH,
  CARD_SYNC_ISSUERS,
  CARD_SYNC_READ_CONTRACT_IDS,
  CARD_SYNC_SOURCES,
  CARD_SYNC_TERMINATIONS,
  cardSyncTextIssue,
  isCardImportDate,
  isCardSyncId,
  isCardSyncPairingCode,
  isCardSyncTimestamp,
  type CardSyncIdKind,
} from '@finance-tracker/shared';
import { ADAPTER_ID } from '../adapters/types.js';
import { isPayloadDigest, isPlanDigest } from '../common/digest.js';
import { isLocalId, type LocalIdKind } from '../common/ids.js';
import { S } from '../common/strict.js';

export const contractId = (kind: CardSyncIdKind) => S.string((value) => isCardSyncId(kind, value), 40);
export const localId = (kind: LocalIdKind) => S.string((value) => isLocalId(kind, value), 40);

export const LAST4 = S.string(/^[0-9]{4}$/, 4);
export const ADAPTER = S.string(ADAPTER_ID, 32);
export const DATE = S.string(isCardImportDate, 10);
export const TIMESTAMP = S.string(isCardSyncTimestamp, 24);
export const ISSUER = S.enum(CARD_SYNC_ISSUERS);
export const SOURCE = S.enum(CARD_SYNC_SOURCES);
export const READ_CONTRACT = S.enum(CARD_SYNC_READ_CONTRACT_IDS);
export const TERMINATION = S.enum(CARD_SYNC_TERMINATIONS);
export const COMPLETENESS = S.enum(CARD_SYNC_COMPLETENESS);
export const PAYLOAD_DIGEST = S.string(isPayloadDigest, 68);
export const PLAN_DIGEST = S.string(isPlanDigest, 68);
/** Redacted, canonical display text (product hints, binding and scope labels). */
export const HINT_TEXT = S.string((value) => cardSyncTextIssue(value, 100) === null, 100);
export const LABEL_TEXT = S.string((value) => cardSyncTextIssue(value, 64) === null, 64);
/**
 * A device label chosen by the user, e.g. `Laptop Chrome`: no free-form user agent, path or address. A letter first and
 * at most 32 characters, what both Holdr's device API and its repository accept (E2c M3; the repository would take 40,
 * the API only 32).
 */
export const DEVICE_LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9 ._-]{0,31}$/;
export const DEVICE_LABEL = S.string(DEVICE_LABEL_PATTERN, 32);
/** This build's version as Holdr pairs it and checks it on every request (`X-Holdr-Client-Version`, E2c M1). */
export const CLIENT_VERSION_PATTERN = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;
export const CLIENT_VERSION = S.string(CLIENT_VERSION_PATTERN, 11);
/** An exact web origin (scheme, host, optional port), as Holdr names its own in capabilities (`holdrOrigin`, E0-I §6.7). */
export const ORIGIN = S.string((value) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}, 255);
export const PARSER_VERSION = S.string(/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/, 64);
/** 128-bit pairing code: 32 letters a–p (`isCardSyncPairingCode`; shown in 8 groups of 4). */
export const PAIRING_CODE = S.string(isCardSyncPairingCode, 32);
export const ISSUE = S.object({
  code: S.enum(CARD_SYNC_ISSUE_CODES),
  path: S.string(CARD_SYNC_ISSUE_PATH, 200),
});
