/**
 * The invalid corpus: one case per contract rule, each a minimal mutation of
 * a valid synthetic fixture with the exact issue (`code` and `path`) the
 * validator must report. Unless `exact` is false, that issue is the only one.
 * Cases that need values JSON cannot carry (getters, NaN, proxies, cycles)
 * build them here, which is why the corpus is code rather than JSON.
 */
import { cardExternalIdHash } from '../../cardDedupe.js';
import type { CardSyncIssue } from '../issues.js';
import {
  amexFixture,
  amexRestFixture,
  chaseFixture,
  citiFixture,
  fixtureId,
  projectedChaseActivityFixture,
  projectedCitiTransactionsFixture,
  projectedWellsFargoAccountsFixture,
  wellsFargoFixture,
} from './drafts.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Value = any;

export interface CardSyncInvalidCase {
  /** Stable kebab-case id. */
  id: string;
  /** The rule the case breaks, in one line. */
  rule: string;
  target: 'v2' | 'projected';
  base: () => Value;
  /** Receives a fresh copy of the base fixture; returns the value to validate. */
  mutate: (value: Value) => unknown;
  expect: CardSyncIssue;
  /** Default true: the expected issue is the only issue. */
  exact?: boolean;
}

/** Counts getter calls on objects the corpus builds, so tests can assert none ran. */
export const getterCalls = { count: 0 };

function withGetter<T extends object>(object: T, key: string, value: unknown): T {
  Object.defineProperty(object, key, {
    get() {
      getterCalls.count += 1;
      return value;
    },
    enumerable: true,
    configurable: true,
  });
  return object;
}

/** Rebuilds `object` with `key` first, so budget-driven paths do not depend on fixture sizes. */
function withFirstKey(object: Value, key: string, value: unknown): Value {
  return { [key]: value, ...object };
}

const PAN = '4111 1111 1111 1111';
const hash = (label: string) => cardExternalIdHash(`SYN-CORPUS-${label}`);
const otherFingerprint = `cfp1:${'a'.repeat(64)}`;

function v2(
  id: string,
  rule: string,
  base: () => Value,
  mutate: (value: Value) => unknown,
  code: CardSyncIssue['code'],
  path: string,
  exact = true,
): CardSyncInvalidCase {
  return { id, rule, target: 'v2', base, mutate, expect: { code, path }, exact };
}

function projected(
  id: string,
  rule: string,
  base: () => Value,
  mutate: (value: Value) => unknown,
  code: CardSyncIssue['code'],
  path: string,
  exact = true,
): CardSyncInvalidCase {
  return { id, rule, target: 'projected', base, mutate, expect: { code, path }, exact };
}

const set = (apply: (value: Value) => void) => (value: Value) => {
  apply(value);
  return value;
};

export const CARD_SYNC_INVALID_CORPUS: readonly CardSyncInvalidCase[] = Object.freeze([
  // -------------------------------------------------------------------------
  // Strict JSON: structure and safety (checked before the schema)
  // -------------------------------------------------------------------------
  v2('strict-unreadable-proxy', 'an exotic object that throws while being read is refused, not propagated', chaseFixture, set((p) => {
    p.rows[0] = new Proxy(p.rows[0], { ownKeys() { throw new Error('trap'); } });
  }), 'unreadable', '$.rows[0]'),
  v2('strict-undefined', 'undefined is not a JSON value', chaseFixture, set((p) => { p.rows[0].merchant = undefined; }), 'not-json-value', '$.rows[0].merchant'),
  v2('strict-function', 'functions are not JSON values', chaseFixture, set((p) => { p.owner = () => 'alex'; }), 'not-json-value', '$.owner'),
  v2('strict-bigint', 'bigints are not JSON values', chaseFixture, set((p) => { p.bindingVersion = 3n; }), 'not-json-value', '$.bindingVersion'),
  v2('strict-nan', 'NaN is not a JSON number', chaseFixture, set((p) => { p.rows[0].amountMinor = Number.NaN; }), 'non-finite-number', '$.rows[0].amountMinor'),
  v2('strict-infinity', 'infinities are not JSON numbers', chaseFixture, set((p) => { p.rejectedCount = Number.POSITIVE_INFINITY; }), 'non-finite-number', '$.rejectedCount'),
  v2('strict-negative-zero', '-0 is refused', chaseFixture, set((p) => { p.rejectedCount = -0; }), 'negative-zero', '$.rejectedCount'),
  v2('strict-fraction', 'numbers are integers', chaseFixture, set((p) => { p.rows[0].amountMinor = 12.5; }), 'not-integer', '$.rows[0].amountMinor'),
  v2('strict-class-instance', 'objects must be plain', chaseFixture, set((p) => { p.statement = new Date(0); }), 'not-plain-object', '$.statement'),
  v2('strict-sparse-array', 'arrays must be dense', chaseFixture, set((p) => { delete p.cards[0]; }), 'invalid-array', '$.cards'),
  v2('strict-array-extra-property', 'arrays carry no extra properties', chaseFixture, set((p) => { p.cards.extra = 'x'; }), 'invalid-array', '$.cards'),
  v2('strict-getter', 'accessors are refused and never invoked', chaseFixture, set((p) => { withGetter(p.rows[0], 'description', 'SYNTHETIC COFFEE'); }), 'accessor-property', '$.rows[0].description'),
  v2('strict-non-enumerable', 'non-enumerable properties are refused', chaseFixture, set((p) => {
    Object.defineProperty(p.rows[0], 'description', { value: 'SYNTHETIC COFFEE', enumerable: false });
  }), 'hidden-property', '$.rows[0].description'),
  v2('strict-symbol-key', 'symbol-keyed properties are refused', chaseFixture, set((p) => { p.rows[0][Symbol('hidden')] = 1; }), 'hidden-property', '$.rows[0].<key>'),
  v2('strict-proto-key', '__proto__ keys are refused', chaseFixture, (p) => JSON.parse(JSON.stringify(p).replace(/^\{/, '{"__proto__":{"polluted":true},')), 'prototype-key', '$.<key>'),
  v2('strict-constructor-key', 'constructor keys are refused', chaseFixture, set((p) => { p.rows[0].constructor = 'x'; }), 'prototype-key', '$.rows[0].<key>'),
  v2('strict-forbidden-key', 'keys that may never be sent are refused anywhere', chaseFixture, set((p) => { p.rows[0].rawResponse = 'x'; }), 'forbidden-key', '$.rows[0].<key>'),
  v2('strict-cycle', 'cycles are refused', chaseFixture, set((p) => {
    const loop: Value = {};
    loop.again = loop;
    p.statement = loop;
  }), 'cyclic-reference', '$.statement.<key>'),
  v2('strict-too-deep', 'nesting is bounded', chaseFixture, set((p) => { p.rows[0].merchant = [[[[[1]]]]]; }), 'too-deep', '$.rows[0].merchant[0][0][0][0]'),
  v2('strict-too-many-keys', 'keys per object are bounded', chaseFixture, set((p) => {
    p.statement = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`figure${String.fromCharCode(97 + (index % 26))}${index >= 26 ? 'b' : ''}`, 1]));
  }), 'too-many-keys', '$.statement'),
  v2('strict-too-many-items', 'arrays are bounded (rows at most 2,000)', chaseFixture, set((p) => { p.rows = Array.from({ length: 2_001 }, () => 1); }), 'too-many-items', '$.rows'),
  v2('strict-too-many-nodes', 'the total number of values is bounded', chaseFixture,
    (p) => withFirstKey(p, 'bulk', Array.from({ length: 2_000 }, () => Array.from({ length: 31 }, () => 0))),
    'too-many-nodes', '$.<key>[1874][29]'),
  v2('strict-string-too-long', 'strings are bounded before any scanning', chaseFixture, set((p) => { p.rows[0].description = 'A'.repeat(1_025); }), 'string-too-long', '$.rows[0].description'),
  v2('strict-key-too-long', 'keys are bounded', chaseFixture, set((p) => { p['k'.repeat(65)] = 1; }), 'key-too-long', '$.<key>'),
  v2('strict-too-large', 'the canonical UTF-8 size is at most 2 MiB', chaseFixture,
    (p) => withFirstKey(p, 'bulk', Array.from({ length: 1_100 }, () => '\u00e9'.repeat(1_000))),
    'too-large', '$.<key>[1046]'),
  v2('strict-lone-surrogate', 'strings are well-formed Unicode', chaseFixture, set((p) => { p.rows[0].description = 'SYNTHETIC \ud800 COFFEE'; }), 'ill-formed-unicode', '$.rows[0].description'),
  v2('strict-lone-surrogate-key', 'keys are well-formed Unicode', chaseFixture, set((p) => { p.rows[0]['bad\udc00'] = 1; }), 'ill-formed-unicode', '$.rows[0].<key>'),
  v2('strict-card-number-value', 'no card number in any value', chaseFixture, set((p) => { p.rows[0].description = `SYNTHETIC ${PAN}`; }), 'card-data', '$.rows[0].description'),
  v2('strict-card-number-key', 'no card number in any key', chaseFixture, set((p) => { p.rows[0]['4111111111111111'] = 'x'; }), 'card-data', '$.rows[0].<key>'),
  v2('strict-card-number-number', 'no identifier-sized number', chaseFixture, set((p) => { p.bindingVersion = 4111111111111111; }), 'card-data', '$.bindingVersion'),
  v2('strict-masked-card', 'a mask followed by five or more digits is card data', chaseFixture, set((p) => { p.rows[0].merchant = 'CARD XXXX-90003'; }), 'card-data', '$.rows[0].merchant'),
  v2('strict-card-secret-value', 'no card secret in any value', chaseFixture, set((p) => { p.rows[0].merchant = 'CVV 123'; }), 'card-secret', '$.rows[0].merchant'),
  v2('strict-card-secret-pair', 'no card secret split across a key and its value', chaseFixture, set((p) => { p.rows[0].x_cvv = '123'; }), 'card-secret', '$.rows[0].<key>'),

  // -------------------------------------------------------------------------
  // Root
  // -------------------------------------------------------------------------
  v2('root-not-object', 'the payload is an object', chaseFixture, () => [], 'wrong-type', '$'),
  v2('root-missing-format', 'format is required', chaseFixture, set((p) => { delete p.format; }), 'missing-key', '$.format'),
  v2('root-format', 'format is holdr.card-import', chaseFixture, set((p) => { p.format = 'holdr.card-export'; }), 'unsupported-format', '$.format'),
  v2('root-version', 'version is exactly 2', chaseFixture, set((p) => { p.version = 3; }), 'unsupported-version', '$.version'),
  v2('root-contract-version', 'contractVersion is a supported contract', chaseFixture, set((p) => { p.contractVersion = 2; }), 'unsupported-contract', '$.contractVersion'),
  v2('root-unknown-key', 'no key outside the schema', chaseFixture, set((p) => { p.notes = 'x'; }), 'unknown-key', '$.<key>'),
  v2('root-missing-key', 'every root key is required', chaseFixture, set((p) => { delete p.captureId; }), 'missing-key', '$.captureId'),
  v2('root-source-enum', 'source is a registered extension source, not an open slug', chaseFixture, set((p) => { p.source = 'chase-csv'; }), 'invalid-enum', '$.source'),
  v2('root-parser-version', 'parserVersion is 1 to 64 letters, digits or ._@+-', chaseFixture, set((p) => { p.parserVersion = 'holdr ext'; }), 'invalid-format', '$.parserVersion'),
  v2('root-issuer-enum', 'issuer is registered', chaseFixture, set((p) => { p.issuer = 'discover'; }), 'invalid-enum', '$.issuer'),
  v2('root-issuer-source', "issuer is the source's issuer", chaseFixture, set((p) => { p.issuer = 'amex'; }), 'source-mismatch', '$.issuer'),
  v2('root-currency', 'USD only in this release', chaseFixture, set((p) => { p.currency = 'EUR'; }), 'invalid-enum', '$.currency'),
  v2('root-owner', 'owner is alex, casey, joint or null', chaseFixture, set((p) => { p.owner = 'sample'; }), 'invalid-enum', '$.owner'),
  v2('root-cards-count', 'at most 20 card hints', chaseFixture, set((p) => { p.cards = Array.from({ length: 21 }, (_, index) => String(5184 + index)); }), 'too-many-items', '$.cards'),
  v2('root-cards-format', 'card hints are four digits', chaseFixture, set((p) => { p.cards = ['33910']; }), 'invalid-format', '$.cards[0]'),
  v2('root-cards-unsorted', 'card hints are sorted', chaseFixture, set((p) => { p.cards = ['7720', '3391']; }), 'unsorted', '$.cards[1]'),
  v2('root-cards-duplicate', 'card hints are unique', chaseFixture, set((p) => { p.cards = ['3391', '3391']; }), 'duplicate', '$.cards[1]'),
  v2('root-binding-id', 'bindingId is bnd_ and 32 letters a-p', chaseFixture, set((p) => { p.bindingId = `bnd_${'q'.repeat(32)}`; }), 'invalid-format', '$.bindingId'),
  v2('root-binding-version', 'bindingVersion is a positive integer', chaseFixture, set((p) => { p.bindingVersion = 0; }), 'out-of-range', '$.bindingVersion'),
  v2('root-capture-id', 'captureId has the capture prefix', chaseFixture, set((p) => { p.captureId = fixtureId('cardScope', 'not-a-capture'); }), 'invalid-format', '$.captureId'),
  v2('root-observed-at', 'observedAt is UTC with milliseconds and Z', chaseFixture, set((p) => { p.observedAt = '2026-10-16T14:05:09Z'; }), 'invalid-timestamp', '$.observedAt'),
  v2('root-observed-at-offset', 'observedAt has no offset', chaseFixture, set((p) => { p.observedAt = '2026-10-16T14:05:09.123+00:00'; }), 'invalid-timestamp', '$.observedAt'),
  v2('root-mode-enum', 'mode is registered', chaseFixture, set((p) => { p.mode = 'active-read'; }), 'invalid-enum', '$.mode'),
  v2('root-mode-source', "mode is the source's approved mode", chaseFixture, set((p) => { p.mode = 'main-passive'; }), 'source-mismatch', '$.mode'),
  v2('root-rejected-count', 'rejectedCount is 0 to 2,000', chaseFixture, set((p) => { p.rejectedCount = 2_001; }), 'out-of-range', '$.rejectedCount'),
  v2('root-rows-plus-rejected', 'rows plus rejectedCount is at most 2,000', chaseFixture, set((p) => { p.rejectedCount = 1_993; }), 'too-many-items', '$.rows'),
  v2('root-rows-type', 'rows is an array', chaseFixture, set((p) => { p.rows = {}; }), 'wrong-type', '$.rows'),

  // -------------------------------------------------------------------------
  // Statement (v1 rules) and totals (recomputed)
  // -------------------------------------------------------------------------
  v2('statement-type', 'statement is null or an object', chaseFixture, set((p) => { p.statement = 'none'; }), 'wrong-type', '$.statement'),
  v2('statement-empty', 'a statement without figures is null', chaseFixture, set((p) => {
    p.statement = { chargesMinor: null, creditsMinor: null, netMinor: null, previousBalanceMinor: null, newBalanceMinor: null };
  }), 'inconsistent', '$.statement'),
  v2('statement-balance-pair', 'previous and new balance come together', chaseFixture, set((p) => {
    p.statement = { chargesMinor: null, creditsMinor: null, netMinor: null, previousBalanceMinor: 81_240, newBalanceMinor: null };
  }), 'inconsistent', '$.statement.newBalanceMinor'),
  v2('statement-charges-sign', 'statement charges are not negative', chaseFixture, set((p) => {
    p.statement = { chargesMinor: -1, creditsMinor: null, netMinor: null, previousBalanceMinor: null, newBalanceMinor: null };
  }), 'sign-mismatch', '$.statement.chargesMinor'),
  v2('statement-credits-sign', 'statement credits are not positive', chaseFixture, set((p) => {
    p.statement = { chargesMinor: null, creditsMinor: 1, netMinor: null, previousBalanceMinor: null, newBalanceMinor: null };
  }), 'sign-mismatch', '$.statement.creditsMinor'),
  v2('totals-count', 'totals match the rows', chaseFixture, set((p) => { p.totals.posted.count += 1; }), 'totals-mismatch', '$.totals.posted.count'),
  v2('totals-by-kind', 'totals by kind match the rows', chaseFixture, set((p) => { p.totals.pending.byKind.purchase.amountMinor += 1; }), 'totals-mismatch', '$.totals.pending.byKind.purchase.amountMinor'),
  v2('totals-shape', 'totals have the exact v1 shape', chaseFixture, set((p) => { delete p.totals.posted.byKind; }), 'missing-key', '$.totals.posted.byKind'),

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------
  v2('row-unknown-key', 'rows never carry userCategory or notes', chaseFixture, set((p) => { p.rows[0].userCategory = 'Coffee'; }), 'unknown-key', '$.rows[0].<key>'),
  v2('row-missing-scope', 'cardScopeId is required', chaseFixture, set((p) => { delete p.rows[0].cardScopeId; }), 'missing-key', '$.rows[0].cardScopeId'),
  v2('row-scope-format', 'cardScopeId is scp_ and 32 letters a-p', chaseFixture, set((p) => { p.rows[0].cardScopeId = 'scp_primary'; }), 'invalid-format', '$.rows[0].cardScopeId'),
  v2('row-transaction-date', 'transactionDate is a real calendar day', chaseFixture, set((p) => { p.rows[0].transactionDate = '2026-02-30'; }), 'invalid-date', '$.rows[0].transactionDate'),
  v2('row-posted-date', 'postedDate is null or a real calendar day', chaseFixture, set((p) => { p.rows[0].postedDate = '2026-13-01'; }), 'invalid-date', '$.rows[0].postedDate'),
  v2('row-date-shape', 'dates are YYYY-MM-DD issuer days, not timestamps', chaseFixture, set((p) => { p.rows[0].transactionDate = '2026-09-14T00:00:00Z'; }), 'invalid-date', '$.rows[0].transactionDate'),
  v2('row-status', 'status is pending or posted (no removed)', chaseFixture, set((p) => { p.rows[0].status = 'removed'; }), 'invalid-enum', '$.rows[0].status'),
  v2('row-pending-posted-date', 'a pending row has no posted date', chaseFixture, set((p) => { p.rows[6].postedDate = '2026-10-15'; }), 'inconsistent', '$.rows[6].postedDate'),
  v2('row-amount-type', 'amounts are numbers in minor units', chaseFixture, set((p) => { p.rows[0].amountMinor = '12.34'; }), 'wrong-type', '$.rows[0].amountMinor'),
  v2('row-amount-range', "amounts stay within v1's bound", chaseFixture, set((p) => { p.rows[0].amountMinor = 10_000_000_000; }), 'out-of-range', '$.rows[0].amountMinor'),
  v2('row-kind', 'kind is a v1 kind', chaseFixture, set((p) => { p.rows[0].kind = 'transfer'; }), 'invalid-enum', '$.rows[0].kind'),
  v2('row-purchase-sign', 'purchases, fees and interest are positive', chaseFixture, set((p) => { p.rows[0].amountMinor = -1_234; }), 'sign-mismatch', '$.rows[0].amountMinor'),
  v2('row-refund-sign', 'refunds are negative', chaseFixture, set((p) => { p.rows[1].amountMinor = 4_500; }), 'sign-mismatch', '$.rows[1].amountMinor'),
  v2('row-description-empty', 'description is not empty', chaseFixture, set((p) => { p.rows[0].description = ''; }), 'text-empty', '$.rows[0].description'),
  v2('row-description-length', 'description is at most 500 characters', chaseFixture, set((p) => { p.rows[0].description = 'A'.repeat(501); }), 'text-too-long', '$.rows[0].description'),
  v2('row-description-spacing', 'text uses single spaces (refused, never fixed)', chaseFixture, set((p) => { p.rows[0].description = 'SYNTHETIC  COFFEE'; }), 'text-not-canonical', '$.rows[0].description'),
  v2('row-description-invisible', 'text has no invisible characters', chaseFixture, set((p) => { p.rows[0].description = 'SYN\u200bTHETIC COFFEE'; }), 'text-not-canonical', '$.rows[0].description'),
  v2('row-description-nfkc', 'text is in NFKC form', chaseFixture, set((p) => { p.rows[0].description = '\uff23\uff21\uff26\uff25'; }), 'text-not-canonical', '$.rows[0].description'),
  v2('row-description-format-char', 'text has no format characters redaction would drop', chaseFixture, set((p) => { p.rows[0].description = 'SYNTHETIC\u0600 COFFEE'; }), 'text-not-canonical', '$.rows[0].description'),
  v2('row-description-formula', 'text does not start with = + - @', chaseFixture, set((p) => { p.rows[0].description = '=HYPERLINK("x")'; }), 'text-not-canonical', '$.rows[0].description'),
  v2('row-merchant-type', 'merchant is text or null', chaseFixture, set((p) => { p.rows[0].merchant = 42; }), 'wrong-type', '$.rows[0].merchant'),
  v2('row-category-length', 'issuerCategory is at most 100 characters', chaseFixture, set((p) => { p.rows[0].issuerCategory = 'C'.repeat(101); }), 'text-too-long', '$.rows[0].issuerCategory'),
  v2('row-external-id-format', 'externalIdHash is a version 1 hash', chaseFixture, set((p) => { p.rows[2].externalIdHash = `xid1:${'q'.repeat(64)}`; }), 'invalid-format', '$.rows[2].externalIdHash'),
  v2('row-fingerprint-format', 'fingerprint is a version 1 fingerprint', amexFixture, set((p) => { p.rows[0].fingerprint = 'cfp1:abc'; }), 'invalid-format', '$.rows[0].fingerprint'),
  v2('row-identity-neither', 'a row has an external id hash or a fingerprint', chaseFixture, set((p) => {
    p.rows[2].externalIdHash = null;
    p.rows[2].identityNamespace = 'chase-api:capture:v1';
  }), 'identity-conflict', '$.rows[2]'),
  v2('row-identity-both', 'a row has only one of the two', chaseFixture, set((p) => { p.rows[2].fingerprint = otherFingerprint; }), 'identity-conflict', '$.rows[2]'),
  v2('row-namespace-enum', 'identityNamespace is registered', chaseFixture, set((p) => { p.rows[2].identityNamespace = 'chase-api:sor:v2'; }), 'invalid-enum', '$.rows[2].identityNamespace'),
  v2('row-namespace-source', "identityNamespace belongs to the payload's source", chaseFixture, set((p) => { p.rows[2].identityNamespace = 'citi-api:transaction:v1'; }), 'source-mismatch', '$.rows[2].identityNamespace'),
  v2('row-namespace-kind', 'a hashed id uses a stable namespace, a fingerprint the capture namespace', chaseFixture, set((p) => { p.rows[2].identityNamespace = 'chase-api:capture:v1'; }), 'identity-conflict', '$.rows[2].identityNamespace'),
  v2('row-secondary-count', 'at most 3 secondary ids', chaseFixture, set((p) => {
    p.rows[0].secondaryIds = ['1', '2', '3', '4'].map((label) => ({ namespace: 'chase-api:derived:v1', idHash: hash(label) }));
  }), 'too-many-items', '$.rows[0].secondaryIds'),
  v2('row-secondary-shape', 'secondary ids are exactly {namespace, idHash}', chaseFixture, set((p) => { p.rows[0].secondaryIds[0].note = 'x'; }), 'unknown-key', '$.rows[0].secondaryIds[0].<key>'),
  v2('row-secondary-primary-namespace', "a secondary id is not in the primary id's namespace", chaseFixture, set((p) => { p.rows[0].secondaryIds[0].namespace = 'chase-api:sor:v1'; }), 'identity-conflict', '$.rows[0].secondaryIds[0].namespace'),
  v2('row-secondary-capture-namespace', 'secondary ids use stable namespaces', chaseFixture, set((p) => { p.rows[0].secondaryIds[0].namespace = 'chase-api:capture:v1'; }), 'identity-conflict', '$.rows[0].secondaryIds[0].namespace'),
  v2('row-secondary-namespace-repeat', 'one secondary id per namespace', chaseFixture, set((p) => {
    p.rows[0].secondaryIds.push({ namespace: 'chase-api:derived:v1', idHash: hash('second') });
  }), 'duplicate', '$.rows[0].secondaryIds[1].namespace'),
  v2('row-secondary-on-fingerprint', 'rows without a stable id carry no secondary ids', amexFixture, set((p) => {
    p.rows[0].secondaryIds = [{ namespace: 'amex-api-rest:identifier:v1', idHash: hash('fp') }];
  }), 'identity-conflict', '$.rows[0].secondaryIds'),
  v2('row-original-pair', 'originalAmountMinor and originalCurrency are both set or both null', chaseFixture, set((p) => { p.rows[4].originalCurrency = null; }), 'inconsistent', '$.rows[4].originalCurrency'),
  v2('row-original-format', 'originalCurrency is an upper-case ISO code', chaseFixture, set((p) => { p.rows[4].originalCurrency = 'eur'; }), 'invalid-format', '$.rows[4].originalCurrency'),
  v2('row-original-registered', 'originalCurrency has a confirmed exponent', chaseFixture, set((p) => { p.rows[4].originalCurrency = 'XAU'; }), 'invalid-enum', '$.rows[4].originalCurrency'),
  v2('row-original-same-currency', 'the original currency differs from the billing currency', chaseFixture, set((p) => { p.rows[4].originalCurrency = 'USD'; }), 'inconsistent', '$.rows[4].originalCurrency'),
  v2('row-original-sign', 'the original amount has the sign of amountMinor', chaseFixture, set((p) => { p.rows[4].originalAmountMinor = -3_550; }), 'sign-mismatch', '$.rows[4].originalAmountMinor'),
  v2('row-fingerprint-mismatch', 'fingerprints are recomputed with assignCardDedupeKeys', amexFixture, set((p) => { p.rows[0].fingerprint = otherFingerprint; }), 'fingerprint-mismatch', '$.rows[0].fingerprint'),
  v2('row-repeated-external-id', 'an issuer id appears once per payload', chaseFixture, set((p) => { p.rows[3].externalIdHash = p.rows[2].externalIdHash; }), 'duplicate', '$.rows[3].externalIdHash'),
  v2('row-repeated-secondary-id', 'a (scope, namespace, digest) identity appears once per payload, secondary ids included', chaseFixture, set((p) => { p.rows[1].secondaryIds[0].idHash = p.rows[0].secondaryIds[0].idHash; }), 'duplicate', '$.rows[1].secondaryIds[0].idHash'),
  v2('row-id-primary-and-secondary', 'an identity is not primary in one row and secondary in another', chaseFixture, set((p) => {
    p.rows[3].identityNamespace = 'chase-api:derived:v1';
    p.rows[3].externalIdHash = p.rows[0].secondaryIds[0].idHash;
  }), 'duplicate', '$.rows[3].externalIdHash'),
  v2('row-text-hint-completes-card', 'text next to a card hint never completes a card number', chaseFixture, set((p) => {
    p.cards = ['3391', '4242', '7720'];
    p.rows[2].description = '424242424242';
  }), 'card-data', '$.rows[2]'),
  v2('row-card-split-two-fields', 'a card number split across two text fields is refused', chaseFixture, set((p) => {
    p.rows[0].description = 'SYNTHETIC 42424242';
    p.rows[0].merchant = '42424242 COFFEE';
  }), 'card-data', '$.rows[0]'),
  v2('row-card-split-three-fields', 'a card number split across all three text fields is refused', chaseFixture, set((p) => {
    p.rows[0].description = '424242';
    p.rows[0].merchant = '42424';
    p.rows[0].issuerCategory = '24242';
  }), 'card-data', '$.rows[0]'),
  v2('row-secret-split-fields', 'a card secret split across text fields is refused', chaseFixture, set((p) => {
    p.rows[2].description = 'CVV';
    p.rows[2].merchant = '123';
  }), 'card-secret', '$.rows[2]'),
  v2('row-text-masked-hint', 'a masked last four in the text counts as a card hint', chaseFixture, set((p) => {
    p.rows[0].description = 'SYNTHETIC 424242424242';
    p.rows[0].merchant = 'CARD ***4242';
  }), 'card-data', '$.rows[0]'),
  v2('row-text-fragmented-card', 'whole digit runs between words and redactions never rebuild a card number with a kept last four', chaseFixture, set((p) => {
    p.rows[1].description = 'ALPHA 4012 BRAVO ***1881 CHARLIE 8888 DELTA ***1881 ECHO 8888';
  }), 'card-data', '$.rows[1]'),
  v2('row-text-fragmented-card-split', 'the same fragments split across description and merchant are refused', chaseFixture, set((p) => {
    p.rows[1].description = 'ALPHA 4012 BRAVO ***1881 CHARLIE 8888';
    p.rows[1].merchant = 'DELTA ***1881 ECHO 8888';
  }), 'card-data', '$.rows[1]'),
  v2('row-text-token-fragments', 'a card number hidden entirely in redaction tokens is refused', chaseFixture, set((p) => {
    p.rows[1].description = 'ALPHA ***4012 BRAVO ***8888 CHARLIE ***8888 DELTA ***1881';
  }), 'card-data', '$.rows[1]'),

  // -------------------------------------------------------------------------
  // Coverage
  // -------------------------------------------------------------------------
  v2('coverage-count', 'at most 40 coverage entries', chaseFixture, set((p) => {
    p.coverage = Array.from({ length: 41 }, (_, index) => ({ ...p.coverage[0], cardScopeId: fixtureId('cardScope', `extra-${index}`) }));
  }), 'too-many-items', '$.coverage'),
  v2('coverage-unknown-key', 'coverage entries have exact keys', chaseFixture, set((p) => { p.coverage[0].complete = true; }), 'unknown-key', '$.coverage[0].<key>'),
  v2('coverage-scope', 'coverage cardScopeId follows the id grammar', chaseFixture, set((p) => { p.coverage[0].cardScopeId = 'primary'; }), 'invalid-format', '$.coverage[0].cardScopeId'),
  v2('coverage-status', 'coverage status is pending or posted', chaseFixture, set((p) => { p.coverage[0].status = 'all'; }), 'invalid-enum', '$.coverage[0].status'),
  v2('coverage-range-type', 'requested and observed are null or a date range', chaseFixture, set((p) => { p.coverage[0].requested = 'last 30 days'; }), 'wrong-type', '$.coverage[0].requested'),
  v2('coverage-range-date', 'range bounds are calendar days', chaseFixture, set((p) => { p.coverage[0].requested.start = '2026-09-31'; }), 'invalid-date', '$.coverage[0].requested.start'),
  v2('coverage-range-order', 'a range starts no later than it ends', chaseFixture, set((p) => {
    p.coverage[0].requested.start = '2026-10-15';
    p.coverage[0].requested.end = '2026-09-14';
  }), 'date-order', '$.coverage[0].requested'),
  v2('coverage-date-basis', 'dateBasis is transaction, posted or observation', chaseFixture, set((p) => { p.coverage[0].requested.dateBasis = 'statement'; }), 'invalid-enum', '$.coverage[0].requested.dateBasis'),
  v2('coverage-completeness', 'completeness is unknown, partial or complete', chaseFixture, set((p) => { p.coverage[0].completeness = 'full'; }), 'invalid-enum', '$.coverage[0].completeness'),
  v2('coverage-termination', 'termination is registered', chaseFixture, set((p) => { p.coverage[0].termination = 'done'; }), 'invalid-enum', '$.coverage[0].termination'),
  v2('coverage-page-count', 'pageCount is 0 to 100', chaseFixture, set((p) => { p.coverage[0].pageCount = 101; }), 'out-of-range', '$.coverage[0].pageCount'),
  v2('coverage-complete-needs-end-marker', 'completeness is at most the termination allows: a stop before the end is at most partial', chaseFixture, set((p) => { p.coverage[0].termination = 'cap'; }), 'inconsistent', '$.coverage[0].completeness'),
  v2('coverage-complete-needs-window', 'an end marker without a requested window allows only unknown', chaseFixture, set((p) => { p.coverage[0].requested = null; }), 'inconsistent', '$.coverage[0].completeness'),
  v2('coverage-snapshot-ceiling', 'a passive snapshot allows only unknown', amexFixture, set((p) => { p.coverage[0].completeness = 'partial'; }), 'inconsistent', '$.coverage[0].completeness'),
  v2('coverage-pages-without-read', 'pageCount is 0 exactly when termination is not-read', chaseFixture, set((p) => { p.coverage[0].pageCount = 0; }), 'inconsistent', '$.coverage[0].pageCount'),
  v2('coverage-not-read-pages', 'a not-read entry has no pages', amexRestFixture, set((p) => { p.coverage[1].pageCount = 1; }), 'inconsistent', '$.coverage[1].pageCount'),
  v2('coverage-not-read-completeness', 'a not-read entry has unknown completeness', amexRestFixture, set((p) => { p.coverage[1].completeness = 'partial'; }), 'inconsistent', '$.coverage[1].completeness'),
  v2('coverage-not-read-observed', 'a not-read entry observed nothing', amexRestFixture, set((p) => {
    p.coverage[1].observed = { start: '2026-10-16', end: '2026-10-16', dateBasis: 'observation' };
  }), 'inconsistent', '$.coverage[1].observed'),
  v2('coverage-duplicate', 'one entry per card scope and status', chaseFixture, set((p) => { p.coverage.push({ ...p.coverage[0] }); }), 'duplicate', '$.coverage[4]'),
  v2('coverage-missing-for-row', 'every row has an entry for its scope and status', chaseFixture, set((p) => { p.coverage.splice(1, 1); }), 'coverage-mismatch', '$.rows[6].cardScopeId'),
  v2('coverage-observed-hull', "observed is exactly the rows' dates on its basis", chaseFixture, set((p) => { p.coverage[0].observed.end = '2026-10-02'; }), 'coverage-mismatch', '$.coverage[0].observed'),
  v2('coverage-observed-null-with-rows', 'observed is set when the entry has rows', chaseFixture, set((p) => { p.coverage[0].observed = null; }), 'coverage-mismatch', '$.coverage[0].observed'),
  v2('coverage-observed-without-rows', 'observed on a transaction or posted basis needs rows', amexFixture, set((p) => {
    p.coverage[1].observed = { start: '2026-10-01', end: '2026-10-01', dateBasis: 'transaction' };
  }), 'coverage-mismatch', '$.coverage[1].observed'),
  v2('coverage-posted-basis-needs-dates', 'a posted basis needs every row to have a posted date', amexFixture, set((p) => { p.coverage[0].observed.dateBasis = 'posted'; }), 'coverage-mismatch', '$.coverage[0].observed'),
  v2('coverage-observation-posted', 'an observation-basis range is for pending entries only', chaseFixture, set((p) => {
    p.coverage[0].observed = { start: '2026-10-16', end: '2026-10-16', dateBasis: 'observation' };
  }), 'inconsistent', '$.coverage[0].observed'),
  v2('coverage-observation-one-day', 'an observation-basis range is a single day', wellsFargoFixture, set((p) => {
    p.coverage[1].observed = { start: '2026-10-15', end: '2026-10-16', dateBasis: 'observation' };
  }), 'inconsistent', '$.coverage[1].observed'),
  v2('coverage-observation-near-observed-at', 'an observation-basis day is within one day of observedAt', wellsFargoFixture, set((p) => {
    p.coverage[1].observed = { start: '2026-10-10', end: '2026-10-10', dateBasis: 'observation' };
  }), 'inconsistent', '$.coverage[1].observed'),
  v2('coverage-requested-observation-day', 'an observation-basis requested day is within one day of observedAt', citiFixture, set((p) => {
    p.coverage[1].requested = { start: '2026-10-01', end: '2026-10-01', dateBasis: 'observation' };
  }), 'inconsistent', '$.coverage[1].requested'),
  v2('coverage-observation-without-rows', 'observed is row-derived on every basis: null without rows', amexFixture, set((p) => {
    p.coverage[1].observed = { start: '2026-10-16', end: '2026-10-16', dateBasis: 'observation' };
  }), 'coverage-mismatch', '$.coverage[1].observed'),
  v2('coverage-complete-with-rejects', 'nothing is complete when rows were rejected', chaseFixture, set((p) => {
    p.rejectedCount = 1;
    p.coverage[2].completeness = 'partial';
  }), 'inconsistent', '$.coverage[0].completeness'),

  // -------------------------------------------------------------------------
  // projected-bank-batch/v1
  // -------------------------------------------------------------------------
  projected('projected-type', 'type is exactly projected-bank-batch/v1', projectedChaseActivityFixture, set((b) => { b.type = 'projected-bank-batch/v2'; }), 'unsupported-format', '$.type'),
  projected('projected-missing-type', 'type is required', projectedChaseActivityFixture, set((b) => { delete b.type; }), 'missing-key', '$.type'),
  projected('projected-contract-version', 'contractVersion is supported', projectedChaseActivityFixture, set((b) => { b.contractVersion = 0; }), 'unsupported-contract', '$.contractVersion'),
  projected('projected-contract', 'contract is a registered read contract', projectedChaseActivityFixture, set((b) => { b.contract = 'chase.payments'; }), 'invalid-enum', '$.contract'),
  projected('projected-contract-issuer', "the contract is the issuer's", projectedChaseActivityFixture, set((b) => { b.issuer = 'amex'; }), 'source-mismatch', '$.contract'),
  projected('projected-stream-handle', 'streamHandle is stm_ and 32 letters a-p', projectedChaseActivityFixture, set((b) => { b.streamHandle = 'https://secure.example.test/stream'; }), 'invalid-format', '$.streamHandle'),
  projected('projected-sequence', 'sequence is 0 to 9,999', projectedChaseActivityFixture, set((b) => { b.sequence = 10_000; }), 'out-of-range', '$.sequence'),
  projected('projected-accounts-count', 'at most 20 account candidates', projectedWellsFargoAccountsFixture, set((b) => {
    b.accounts = Array.from({ length: 21 }, (_, index) => ({ ref: fixtureId('accountCandidate', `many-${index}`), last4: null, productHint: null }));
  }), 'too-many-items', '$.accounts'),
  projected('projected-account-ref-repeat', 'candidate refs are unique', projectedWellsFargoAccountsFixture, set((b) => { b.accounts[1].ref = b.accounts[0].ref; }), 'duplicate', '$.accounts[1].ref'),
  projected('projected-account-last4', 'a candidate shows at most four digits', projectedWellsFargoAccountsFixture, set((b) => { b.accounts[1].last4 = '80861'; }), 'invalid-format', '$.accounts[1].last4'),
  projected('projected-product-hint', 'product hints are canonical text', projectedWellsFargoAccountsFixture, set((b) => { b.accounts[0].productHint = 'Example  Card'; }), 'text-not-canonical', '$.accounts[0].productHint'),
  projected('projected-account-reference', 'transactions refer to a declared candidate', projectedChaseActivityFixture, set((b) => {
    b.transactions[0].accountRef = fixtureId('accountCandidate', 'undeclared');
  }), 'unknown-reference', '$.transactions[0].accountRef'),
  projected('projected-coverage-reference', 'coverage refers to a declared candidate', projectedChaseActivityFixture, set((b) => {
    b.coverage[0].accountRef = fixtureId('accountCandidate', 'undeclared');
  }), 'unknown-reference', '$.coverage[0].accountRef'),
  projected('projected-holder-ref', 'holderRef is hld_ and 32 letters a-p', projectedCitiTransactionsFixture, set((b) => { b.transactions[0].holderRef = 'JANE SAMPLE'; }), 'invalid-format', '$.transactions[0].holderRef'),
  projected('projected-holder-groups', 'at most 20 holder groups', projectedChaseActivityFixture, set((b) => {
    const row = b.transactions[0];
    b.transactions = Array.from({ length: 21 }, (_, index) => ({
      ...row,
      holderRef: fixtureId('holderGroup', `group-${index}`),
      externalIdHash: hash(`group-${index}`),
      secondaryIds: [],
    }));
    b.coverage = [{ ...b.coverage[0], observed: { start: row.transactionDate, end: row.transactionDate, dateBasis: 'transaction' } }];
  }), 'too-many-items', '$.transactions'),
  projected('projected-card-last4', 'cardLast4 is four digits', projectedChaseActivityFixture, set((b) => { b.transactions[0].cardLast4 = '33a1'; }), 'invalid-format', '$.transactions[0].cardLast4'),
  projected('projected-no-fingerprint', 'fingerprints are assigned only in v2', projectedChaseActivityFixture, set((b) => { b.transactions[0].fingerprint = otherFingerprint; }), 'unknown-key', '$.transactions[0].<key>'),
  projected('projected-no-scope', 'card scopes are assigned only after binding', projectedChaseActivityFixture, set((b) => { b.transactions[0].cardScopeId = fixtureId('cardScope', 'early'); }), 'unknown-key', '$.transactions[0].<key>'),
  projected('projected-no-url', 'no URL', projectedChaseActivityFixture, set((b) => { b.nextUrl = '/svc/next'; }), 'forbidden-key', '$.<key>'),
  projected('projected-no-headers', 'no headers', projectedChaseActivityFixture, set((b) => { b.transactions[0].headers = { accept: 'json' }; }), 'forbidden-key', '$.transactions[0].<key>'),
  projected('projected-no-cookie', 'no cookies', projectedChaseActivityFixture, set((b) => { b.accounts[0].cookie = 'x'; }), 'forbidden-key', '$.accounts[0].<key>'),
  projected('projected-no-selector', 'no selectors', projectedChaseActivityFixture, set((b) => { b.accounts[0].accountSelector = 'x'; }), 'forbidden-key', '$.accounts[0].<key>'),
  projected('projected-no-raw-state', 'no raw page state', projectedChaseActivityFixture, set((b) => { b.__INITIAL_STATE__ = {}; }), 'forbidden-key', '$.<key>'),
  projected('projected-no-names', 'no cardholder names', projectedCitiTransactionsFixture, set((b) => { b.transactions[0].cardMemberName = 'x'; }), 'forbidden-key', '$.transactions[0].<key>'),
  projected('projected-no-token', 'no bank tokens', projectedChaseActivityFixture, set((b) => { b.accounts[0].accountToken = 'x'; }), 'forbidden-key', '$.accounts[0].<key>'),
  projected('projected-discovery-has-no-rows', 'account discovery contracts carry no transactions', projectedWellsFargoAccountsFixture, set((b) => {
    const chase = projectedChaseActivityFixture();
    b.transactions = [{ ...chase.transactions[0], accountRef: b.accounts[0].ref, identityNamespace: 'wf-dom:capture:v1', externalIdHash: null, secondaryIds: [] }];
  }), 'inconsistent', '$.transactions'),
  projected('projected-row-rules', 'transactions follow the v2 row rules', projectedChaseActivityFixture, set((b) => { b.transactions[0].amountMinor = -1; }), 'sign-mismatch', '$.transactions[0].amountMinor'),
  projected('projected-repeated-id', 'an (account, namespace, digest) identity appears once per batch', projectedChaseActivityFixture, set((b) => {
    b.transactions[3].externalIdHash = b.transactions[2].externalIdHash;
  }), 'duplicate', '$.transactions[3].externalIdHash'),
  projected('projected-product-hint-completes-card', 'a product hint next to a last four never completes a card number', projectedWellsFargoAccountsFixture, set((b) => {
    b.accounts[0].productHint = 'Example Card 424242424242';
    b.accounts[0].last4 = '4242';
  }), 'card-data', '$.accounts[0]'),
  projected('projected-text-hint-completes-card', 'transaction text next to any last four in the batch never completes a card number', projectedChaseActivityFixture, set((b) => {
    b.transactions[2].description = 'PAYMENT 424242424242';
    b.transactions[2].cardLast4 = '4242';
  }), 'card-data', '$.transactions[2]'),
  projected('projected-coverage-hull', 'observed coverage matches the transactions', projectedChaseActivityFixture, set((b) => { b.coverage[0].observed.start = '2026-09-13'; }), 'coverage-mismatch', '$.coverage[0].observed'),
]);

/** Fixtures the corpus mutates, for tests that check every base is valid. */
export const CARD_SYNC_CORPUS_BASES = Object.freeze({
  v2: [chaseFixture, amexFixture, amexRestFixture, citiFixture, wellsFargoFixture],
  projected: [projectedChaseActivityFixture, projectedCitiTransactionsFixture, projectedWellsFargoAccountsFixture],
});
