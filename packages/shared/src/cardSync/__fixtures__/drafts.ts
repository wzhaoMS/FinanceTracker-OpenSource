/**
 * Synthetic card-sync fixtures, built deterministically from invented data:
 * no real account, card, merchant or amount appears here. Ids come from
 * fixed labels, external ids are invented strings hashed with
 * `cardExternalIdHash`, text goes through `prepareCardSyncText`, amounts
 * through `parseDecimalToMinor` and the sign helpers, so the fixtures also
 * exercise the producer helpers an adapter uses.
 *
 * `npx tsx src/cardSync/__fixtures__/generate.ts` rewrites the JSON files in
 * `valid/` from these builders; a test fails if they ever differ.
 */
import { cardExternalIdHash, sha256 } from '../../cardDedupe.js';
import { cardAmountFromDirection, parseDecimalToMinor, type CardAmountDirection } from '../amounts.js';
import { formatCardSyncId, type CardSyncIdKind } from '../ids.js';
import type { ProjectedBankBatchV1, ProjectedTransaction } from '../projectedBatch.js';
import { CARD_SYNC_CONTRACT_VERSION, type CardSyncIdentityNamespace } from '../registry.js';
import { CARD_SYNC_TEXT_LIMITS, prepareCardSyncText } from '../text.js';
import {
  buildCardSyncPayloadV2,
  cardSyncObservedRange,
  type CardSyncCoverageEntry,
  type CardSyncDraftV2,
  type CardSyncPayloadV2,
  type CardSyncRowDraftV2,
  type CardSyncSecondaryId,
} from '../wireV2.js';
import type { CardTransactionKind } from '../../types.js';

/** A deterministic id of `kind` for a fixture label. */
export function fixtureId(kind: CardSyncIdKind, label: string): string {
  return formatCardSyncId(kind, sha256(Uint8Array.from(label, (char) => char.charCodeAt(0) & 0xff)).slice(0, 16));
}

function text(raw: string | null, field: keyof typeof CARD_SYNC_TEXT_LIMITS): string | null {
  if (raw === null) return null;
  const result = prepareCardSyncText(raw, CARD_SYNC_TEXT_LIMITS[field]);
  if (!result.ok) throw new Error(`fixture text refused: ${result.problem}`);
  return result.text;
}

/** Holdr minor units from issuer decimal text and an explicit debit/credit direction. */
function money(decimal: string, direction: CardAmountDirection): number {
  const magnitude = parseDecimalToMinor(decimal, 2, { grouping: 'comma' });
  if (!magnitude.ok) throw new Error(`fixture amount refused: ${magnitude.problem}`);
  const signed = cardAmountFromDirection(magnitude.minor, direction);
  if (!signed.ok) throw new Error(`fixture amount refused: ${signed.problem}`);
  return signed.minor;
}

interface RowSpec {
  scope: string;
  date: string;
  posted: string | null;
  status?: 'pending' | 'posted';
  amount: string;
  direction: CardAmountDirection;
  kind: CardTransactionKind;
  description: string;
  merchant?: string | null;
  category?: string | null;
  id?: { namespace: CardSyncIdentityNamespace; raw: string } | null;
  secondary?: Array<{ namespace: CardSyncIdentityNamespace; raw: string }>;
  original?: { decimal: string; currency: string; exponent: number } | null;
  captureNamespace: CardSyncIdentityNamespace;
}

function row(spec: RowSpec): CardSyncRowDraftV2 {
  const amountMinor = money(spec.amount, spec.direction);
  let originalAmountMinor: number | null = null;
  if (spec.original) {
    const parsed = parseDecimalToMinor(spec.original.decimal, spec.original.exponent);
    if (!parsed.ok) throw new Error(`fixture original amount refused: ${parsed.problem}`);
    originalAmountMinor = spec.direction === 'credit' ? -parsed.minor : parsed.minor;
  }
  return {
    transactionDate: spec.date,
    postedDate: spec.posted,
    status: spec.status ?? 'posted',
    amountMinor,
    kind: spec.kind,
    description: text(spec.description, 'description')!,
    merchant: text(spec.merchant ?? null, 'merchant'),
    issuerCategory: text(spec.category ?? null, 'issuerCategory'),
    externalIdHash: spec.id ? cardExternalIdHash(spec.id.raw) : null,
    cardScopeId: spec.scope,
    identityNamespace: spec.id ? spec.id.namespace : spec.captureNamespace,
    secondaryIds: (spec.secondary ?? []).map((secondary): CardSyncSecondaryId => ({
      namespace: secondary.namespace,
      idHash: cardExternalIdHash(secondary.raw),
    })),
    originalAmountMinor,
    originalCurrency: spec.original ? spec.original.currency : null,
  };
}

type CoverageSpec = Omit<CardSyncCoverageEntry, 'observed'> & {
  /** `rows` computes the hull of this scope's rows with this status on the given basis. */
  observed: CardSyncCoverageEntry['observed'] | { rows: 'transaction' | 'posted' };
};

function coverage(rows: readonly CardSyncRowDraftV2[], specs: readonly CoverageSpec[]): CardSyncCoverageEntry[] {
  return specs.map((spec) => {
    let observed: CardSyncCoverageEntry['observed'];
    if (spec.observed !== null && 'rows' in spec.observed) {
      const matching = rows.filter((candidate) => candidate.cardScopeId === spec.cardScopeId && candidate.status === spec.status);
      const range = cardSyncObservedRange(matching, spec.observed.rows);
      if (range === undefined) throw new Error('fixture coverage needs posted dates');
      observed = range;
    } else {
      observed = spec.observed;
    }
    return { ...spec, observed };
  });
}

function build(draft: CardSyncDraftV2): CardSyncPayloadV2 {
  const result = buildCardSyncPayloadV2(draft);
  if (!result.ok) throw new Error(`fixture payload refused: ${JSON.stringify(result.issues)}`);
  return result.payload;
}

// ---------------------------------------------------------------------------
// Chase: isolated read, stable SOR ids with derived secondary ids, two cards
// ---------------------------------------------------------------------------

export function chaseFixture(): CardSyncPayloadV2 {
  const primary = fixtureId('cardScope', 'chase/scope/primary');
  const authorized = fixtureId('cardScope', 'chase/scope/authorized-user');
  const capture = 'chase-api:capture:v1' as const;
  const sor = (n: string) => ({ namespace: 'chase-api:sor:v1' as const, raw: `SYN-SOR-${n}` });
  const derived = (n: string) => ({ namespace: 'chase-api:derived:v1' as const, raw: `SYN-DERIVED-${n}` });
  const rows = [
    row({ scope: primary, date: '2026-09-14', posted: '2026-09-15', amount: '12.34', direction: 'debit', kind: 'purchase', description: 'SYNTHETIC COFFEE ROASTERS #42 OAKLAND CA', merchant: 'Synthetic Coffee Roasters', category: 'Food & Drink', id: sor('A1'), secondary: [derived('A1')], captureNamespace: capture }),
    row({ scope: primary, date: '2026-09-20', posted: '2026-09-22', amount: '45.00', direction: 'credit', kind: 'refund', description: 'RETURN: EXAMPLE OUTDOOR GEAR', merchant: 'Example Outdoor Gear', category: 'Shopping', id: sor('A2'), secondary: [derived('A2')], captureNamespace: capture }),
    row({ scope: primary, date: '2026-09-25', posted: '2026-09-25', amount: '1,500.00', direction: 'credit', kind: 'payment', description: 'AUTOMATIC PAYMENT - THANK YOU', id: sor('A3'), captureNamespace: capture }),
    row({ scope: primary, date: '2026-10-01', posted: '2026-10-01', amount: '3.21', direction: 'debit', kind: 'interest', description: 'PURCHASE INTEREST CHARGE', category: 'Fees & Adjustments', id: sor('A4'), captureNamespace: capture }),
    row({ scope: authorized, date: '2026-10-03', posted: '2026-10-04', amount: '39.00', direction: 'debit', kind: 'purchase', description: 'CAFE EXEMPLAIRE PARIS FR', merchant: 'Cafe Exemplaire', category: 'Food & Drink', id: sor('B1'), secondary: [derived('B1')], original: { decimal: '35.50', currency: 'EUR', exponent: 2 }, captureNamespace: capture }),
    row({ scope: authorized, date: '2026-10-03', posted: '2026-10-04', amount: '1.17', direction: 'debit', kind: 'fee', description: 'FOREIGN TRANSACTION FEE', category: 'Fees & Adjustments', id: sor('B2'), captureNamespace: capture }),
    row({ scope: primary, date: '2026-10-14', posted: null, status: 'pending', amount: '8.75', direction: 'debit', kind: 'purchase', description: 'SYNTHETIC CORNER MARKET', id: sor('A5'), captureNamespace: capture }),
    row({ scope: authorized, date: '2026-10-15', posted: null, status: 'pending', amount: '23.10', direction: 'debit', kind: 'purchase', description: 'EXAMPLE FUEL STOP 0042', id: sor('B3'), captureNamespace: capture }),
  ];
  const window = { start: '2026-09-14', end: '2026-10-14', dateBasis: 'transaction' as const };
  return build({
    contractVersion: CARD_SYNC_CONTRACT_VERSION,
    source: 'chase-api',
    parserVersion: 'holdr-ext-chase@0.1.0',
    issuer: 'chase',
    currency: 'USD',
    owner: 'joint',
    cards: ['3391', '7720'],
    bindingId: fixtureId('binding', 'chase/binding'),
    bindingVersion: 3,
    captureId: fixtureId('capture', 'chase/capture/1'),
    observedAt: '2026-10-16T14:05:09.123Z',
    mode: 'isolated-read',
    coverage: coverage(rows, [
      { cardScopeId: primary, status: 'posted', requested: window, observed: { rows: 'transaction' }, completeness: 'complete', pageCount: 2, termination: 'end-marker' },
      { cardScopeId: primary, status: 'pending', requested: window, observed: { rows: 'transaction' }, completeness: 'partial', pageCount: 2, termination: 'end-marker' },
      { cardScopeId: authorized, status: 'posted', requested: window, observed: { rows: 'posted' }, completeness: 'complete', pageCount: 2, termination: 'end-marker' },
      { cardScopeId: authorized, status: 'pending', requested: window, observed: { rows: 'transaction' }, completeness: 'partial', pageCount: 2, termination: 'end-marker' },
    ]),
    rejectedCount: 0,
    statement: null,
    rows,
  });
}

// ---------------------------------------------------------------------------
// Amex RECENT: passive MAIN observation, capture fingerprints only, a basic
// card and a "holder unknown" scope, a rejected row, partial coverage
// ---------------------------------------------------------------------------

export function amexFixture(): CardSyncPayloadV2 {
  const basic = fixtureId('cardScope', 'amex/scope/basic');
  const unknown = fixtureId('cardScope', 'amex/scope/holder-unknown');
  const capture = 'amex-api-recent:capture:v1' as const;
  const rows = [
    row({ scope: basic, date: '2026-10-01', posted: null, amount: '95.00', direction: 'debit', kind: 'fee', description: 'ANNUAL MEMBERSHIP FEE', category: 'Fees & Adjustments', captureNamespace: capture }),
    row({ scope: basic, date: '2026-10-02', posted: null, amount: '64.20', direction: 'debit', kind: 'purchase', description: 'SYNTHETIC GROCERY MARKET', category: 'Merchandise & Supplies-Groceries', captureNamespace: capture }),
    // The same purchase twice on the same day: both rows stay, told apart by occurrence.
    row({ scope: basic, date: '2026-10-02', posted: null, amount: '64.20', direction: 'debit', kind: 'purchase', description: 'SYNTHETIC GROCERY MARKET', category: 'Merchandise & Supplies-Groceries', captureNamespace: capture }),
    row({ scope: basic, date: '2026-10-05', posted: null, amount: '19.99', direction: 'credit', kind: 'refund', description: 'EXAMPLE ONLINE STORE RETURN', captureNamespace: capture }),
    row({ scope: basic, date: '2026-10-06', posted: null, amount: '1,250.00', direction: 'credit', kind: 'payment', description: 'MOBILE PAYMENT - THANK YOU', captureNamespace: capture }),
    row({ scope: basic, date: '2026-10-06', posted: null, amount: '20.00', direction: 'credit', kind: 'adjustment', description: 'DIGITAL ENTERTAINMENT CREDIT', captureNamespace: capture }),
    row({ scope: unknown, date: '2026-10-07', posted: null, amount: '15.00', direction: 'debit', kind: 'purchase', description: 'EXAMPLE PARKING GARAGE', category: 'Transportation-Parking', captureNamespace: capture }),
    row({ scope: unknown, date: '2026-10-12', posted: null, status: 'pending', amount: '42.00', direction: 'debit', kind: 'purchase', description: 'SYNTHETIC BISTRO', captureNamespace: capture }),
  ];
  const today = { start: '2026-10-16', end: '2026-10-16', dateBasis: 'observation' as const };
  return build({
    contractVersion: CARD_SYNC_CONTRACT_VERSION,
    source: 'amex-api-recent',
    parserVersion: 'holdr-ext-amex@0.1.0',
    issuer: 'amex',
    currency: 'USD',
    owner: 'casey',
    cards: ['2999'],
    bindingId: fixtureId('binding', 'amex/binding'),
    bindingVersion: 1,
    captureId: fixtureId('capture', 'amex/capture/1'),
    observedAt: '2026-10-16T15:30:00.000Z',
    mode: 'main-passive',
    coverage: coverage(rows, [
      { cardScopeId: basic, status: 'posted', requested: null, observed: { rows: 'transaction' }, completeness: 'unknown', pageCount: 1, termination: 'snapshot' },
      { cardScopeId: basic, status: 'pending', requested: null, observed: null, completeness: 'unknown', pageCount: 1, termination: 'snapshot' },
      { cardScopeId: unknown, status: 'posted', requested: null, observed: { rows: 'transaction' }, completeness: 'unknown', pageCount: 1, termination: 'snapshot' },
      { cardScopeId: unknown, status: 'pending', requested: null, observed: today, completeness: 'unknown', pageCount: 1, termination: 'snapshot' },
    ]),
    // One row had a transaction type this contract does not know; it was dropped and counted.
    rejectedCount: 1,
    statement: null,
    rows,
  });
}

// ---------------------------------------------------------------------------
// Amex servicing REST: isolated read, identifier ids with reference secondary
// ---------------------------------------------------------------------------

export function amexRestFixture(): CardSyncPayloadV2 {
  const basic = fixtureId('cardScope', 'amex-rest/scope/basic');
  const capture = 'amex-api-rest:capture:v1' as const;
  const identifier = (n: string) => ({ namespace: 'amex-api-rest:identifier:v1' as const, raw: `SYN-IDENTIFIER-${n}` });
  const reference = (n: string) => ({ namespace: 'amex-api-rest:reference:v1' as const, raw: `SYN-REFERENCE-${n}` });
  const rows = [
    row({ scope: basic, date: '2026-09-30', posted: '2026-10-01', amount: '210.40', direction: 'debit', kind: 'purchase', description: 'EXAMPLE HOTEL TOKYO', merchant: 'Example Hotel', original: { decimal: '31200', currency: 'JPY', exponent: 0 }, id: identifier('1'), secondary: [reference('1')], captureNamespace: capture }),
    row({ scope: basic, date: '2026-10-02', posted: '2026-10-03', amount: '58.00', direction: 'credit', kind: 'refund', description: 'EXAMPLE AIRLINE REFUND', id: identifier('2'), captureNamespace: capture }),
    row({ scope: basic, date: '2026-10-04', posted: '2026-10-04', amount: '2.75', direction: 'debit', kind: 'purchase', description: 'SYNTHETIC TRANSIT FARE', captureNamespace: capture }),
  ];
  return build({
    contractVersion: CARD_SYNC_CONTRACT_VERSION,
    source: 'amex-api-rest',
    parserVersion: 'holdr-ext-amex@0.1.0',
    issuer: 'amex',
    currency: 'USD',
    owner: 'alex',
    cards: ['2008'],
    bindingId: fixtureId('binding', 'amex-rest/binding'),
    bindingVersion: 2,
    captureId: fixtureId('capture', 'amex-rest/capture/1'),
    observedAt: '2026-10-16T16:00:00.500Z',
    mode: 'isolated-read',
    coverage: coverage(rows, [
      { cardScopeId: basic, status: 'posted', requested: { start: '2026-09-17', end: '2026-10-16', dateBasis: 'posted' }, observed: { rows: 'posted' }, completeness: 'partial', pageCount: 10, termination: 'cap' },
      { cardScopeId: basic, status: 'pending', requested: null, observed: null, completeness: 'unknown', pageCount: 0, termination: 'not-read' },
    ]),
    rejectedCount: 0,
    statement: null,
    rows,
  });
}

// ---------------------------------------------------------------------------
// Citi: passive MAIN observation, transaction ids with citi-transaction
// secondary ids, a name-only cardholder left in the "holder unknown" scope
// ---------------------------------------------------------------------------

export function citiFixture(): CardSyncPayloadV2 {
  const member = fixtureId('cardScope', 'citi/scope/member');
  const unknown = fixtureId('cardScope', 'citi/scope/holder-unknown');
  const capture = 'citi-api:capture:v1' as const;
  const transaction = (n: string) => ({ namespace: 'citi-api:transaction:v1' as const, raw: `SYN-TXN-${n}` });
  const citiTransaction = (n: string) => ({ namespace: 'citi-api:citi-transaction:v1' as const, raw: `SYN-CITI-TXN-${n}` });
  const rows = [
    row({ scope: member, date: '2026-09-28', posted: '2026-09-29', amount: '120.00', direction: 'debit', kind: 'purchase', description: 'SYNTHETIC HARDWARE STORE', id: transaction('1'), secondary: [citiTransaction('1')], captureNamespace: capture }),
    row({ scope: member, date: '2026-10-01', posted: '2026-10-01', amount: '7.89', direction: 'debit', kind: 'interest', description: 'INTEREST CHARGED ON PURCHASES', id: transaction('2'), captureNamespace: capture }),
    row({ scope: member, date: '2026-10-02', posted: '2026-10-02', amount: '300.00', direction: 'credit', kind: 'payment', description: 'ONLINE PAYMENT, THANK YOU', id: transaction('3'), captureNamespace: capture }),
    row({ scope: unknown, date: '2026-10-03', posted: '2026-10-04', amount: '18.45', direction: 'debit', kind: 'purchase', description: 'EXAMPLE BOOKSHOP', id: transaction('4'), secondary: [citiTransaction('4')], captureNamespace: capture }),
    row({ scope: unknown, date: '2026-10-05', posted: '2026-10-06', amount: '18.45', direction: 'credit', kind: 'refund', description: 'EXAMPLE BOOKSHOP RETURN', id: transaction('5'), captureNamespace: capture }),
    row({ scope: member, date: '2026-10-13', posted: null, status: 'pending', amount: '9.99', direction: 'debit', kind: 'purchase', description: 'EXAMPLE STREAMING SERVICE', id: transaction('6'), captureNamespace: capture }),
  ];
  const window = { start: '2026-09-16', end: '2026-10-16', dateBasis: 'transaction' as const };
  const today = { start: '2026-10-16', end: '2026-10-16', dateBasis: 'observation' as const };
  return build({
    contractVersion: CARD_SYNC_CONTRACT_VERSION,
    source: 'citi-api',
    parserVersion: 'holdr-ext-citi@0.1.0',
    issuer: 'citi',
    currency: 'USD',
    owner: null,
    cards: ['5502'],
    bindingId: fixtureId('binding', 'citi/binding'),
    bindingVersion: 1,
    captureId: fixtureId('capture', 'citi/capture/1'),
    observedAt: '2026-10-16T17:45:12.000Z',
    mode: 'main-passive',
    coverage: coverage(rows, [
      { cardScopeId: member, status: 'posted', requested: window, observed: { rows: 'transaction' }, completeness: 'complete', pageCount: 1, termination: 'end-marker' },
      { cardScopeId: member, status: 'pending', requested: today, observed: { rows: 'transaction' }, completeness: 'complete', pageCount: 1, termination: 'end-marker' },
      { cardScopeId: unknown, status: 'posted', requested: window, observed: { rows: 'transaction' }, completeness: 'complete', pageCount: 1, termination: 'end-marker' },
      // Read to the end with no pending rows for this scope.
      { cardScopeId: unknown, status: 'pending', requested: today, observed: null, completeness: 'complete', pageCount: 1, termination: 'end-marker' },
    ]),
    rejectedCount: 0,
    statement: null,
    rows,
  });
}

// ---------------------------------------------------------------------------
// Wells Fargo: rendered DOM observation only, no issuer ids, Load More visible
// ---------------------------------------------------------------------------

export function wellsFargoFixture(): CardSyncPayloadV2 {
  const card = fixtureId('cardScope', 'wellsfargo/scope/card');
  const capture = 'wf-dom:capture:v1' as const;
  const rows = [
    row({ scope: card, date: '2026-10-08', posted: '2026-10-09', amount: '5.25', direction: 'debit', kind: 'purchase', description: 'SYNTHETIC COFFEE CART', captureNamespace: capture }),
    row({ scope: card, date: '2026-10-08', posted: '2026-10-09', amount: '5.25', direction: 'debit', kind: 'purchase', description: 'SYNTHETIC COFFEE CART', captureNamespace: capture }),
    row({ scope: card, date: '2026-10-10', posted: '2026-10-11', amount: '30.00', direction: 'credit', kind: 'refund', description: 'EXAMPLE SHOE STORE CREDIT', captureNamespace: capture }),
    row({ scope: card, date: '2026-10-11', posted: '2026-10-11', amount: '200.00', direction: 'credit', kind: 'payment', description: 'ONLINE PAYMENT THANK YOU', captureNamespace: capture }),
    row({ scope: card, date: '2026-10-15', posted: null, status: 'pending', amount: '61.30', direction: 'debit', kind: 'purchase', description: 'EXAMPLE GROCERY', captureNamespace: capture }),
  ];
  return build({
    contractVersion: CARD_SYNC_CONTRACT_VERSION,
    source: 'wf-dom',
    parserVersion: 'holdr-ext-wf@0.1.0',
    issuer: 'wellsfargo',
    currency: 'USD',
    owner: 'alex',
    cards: ['8086'],
    bindingId: fixtureId('binding', 'wellsfargo/binding'),
    bindingVersion: 1,
    captureId: fixtureId('capture', 'wellsfargo/capture/1'),
    observedAt: '2026-10-16T18:20:45.999Z',
    mode: 'dom-passive',
    coverage: coverage(rows, [
      { cardScopeId: card, status: 'posted', requested: null, observed: { rows: 'posted' }, completeness: 'partial', pageCount: 1, termination: 'more-available' },
      { cardScopeId: card, status: 'pending', requested: null, observed: { start: '2026-10-16', end: '2026-10-16', dateBasis: 'observation' }, completeness: 'unknown', pageCount: 1, termination: 'snapshot' },
    ]),
    rejectedCount: 0,
    statement: null,
    rows,
  });
}

// ---------------------------------------------------------------------------
// projected-bank-batch/v1
// ---------------------------------------------------------------------------

function projectedRow(
  draft: CardSyncRowDraftV2,
  accountRef: string,
  holderRef: string | null,
  cardLast4: string | null,
): ProjectedTransaction {
  const { cardScopeId: _scope, ...rest } = draft;
  return { accountRef, holderRef, cardLast4, ...rest };
}

/** Chase activity read in the isolated world: one account, per-row card last four. */
export function projectedChaseActivityFixture(): ProjectedBankBatchV1 {
  const account = fixtureId('accountCandidate', 'projected/chase/account');
  const source = chaseFixture();
  const lastFour: Record<string, string> = {
    [fixtureId('cardScope', 'chase/scope/primary')]: '3391',
    [fixtureId('cardScope', 'chase/scope/authorized-user')]: '7720',
  };
  const transactions = source.rows.map(({ fingerprint: _fingerprint, ...rest }) => projectedRow(rest, account, null, lastFour[rest.cardScopeId]));
  const posted = transactions.filter((candidate) => candidate.status === 'posted');
  const pending = transactions.filter((candidate) => candidate.status === 'pending');
  const window = { start: '2026-09-14', end: '2026-10-14', dateBasis: 'transaction' as const };
  return {
    type: 'projected-bank-batch/v1',
    contractVersion: CARD_SYNC_CONTRACT_VERSION,
    issuer: 'chase',
    contract: 'chase.activity',
    streamHandle: fixtureId('stream', 'projected/chase/stream'),
    sequence: 1,
    observedAt: '2026-10-16T14:05:09.123Z',
    currency: 'USD',
    accounts: [{ ref: account, last4: '3391', productHint: text('Synthetic Rewards Visa', 'productHint') }],
    transactions,
    coverage: [
      { accountRef: account, status: 'posted', requested: window, observed: cardSyncObservedRange(posted, 'transaction')!, completeness: 'complete', pageCount: 2, termination: 'end-marker' },
      { accountRef: account, status: 'pending', requested: window, observed: cardSyncObservedRange(pending, 'transaction')!, completeness: 'partial', pageCount: 2, termination: 'end-marker' },
    ],
    rejectedCount: 0,
  };
}

/** Citi activity observed in MAIN: cardholder groups stand in for the name-only member field. */
export function projectedCitiTransactionsFixture(): ProjectedBankBatchV1 {
  const account = fixtureId('accountCandidate', 'projected/citi/account');
  const holderOne = fixtureId('holderGroup', 'projected/citi/holder/1');
  const holderTwo = fixtureId('holderGroup', 'projected/citi/holder/2');
  const source = citiFixture();
  const member = fixtureId('cardScope', 'citi/scope/member');
  const transactions = source.rows.map(({ fingerprint: _fingerprint, ...rest }) => projectedRow(rest, account, rest.cardScopeId === member ? holderOne : holderTwo, null));
  const posted = transactions.filter((candidate) => candidate.status === 'posted');
  const pending = transactions.filter((candidate) => candidate.status === 'pending');
  return {
    type: 'projected-bank-batch/v1',
    contractVersion: CARD_SYNC_CONTRACT_VERSION,
    issuer: 'citi',
    contract: 'citi.transactions.observe',
    streamHandle: fixtureId('stream', 'projected/citi/stream'),
    sequence: 0,
    observedAt: '2026-10-16T17:45:12.000Z',
    currency: 'USD',
    accounts: [{ ref: account, last4: '5502', productHint: text('Example Cash Back Card', 'productHint') }],
    transactions,
    coverage: [
      { accountRef: account, status: 'posted', requested: { start: '2026-09-16', end: '2026-10-16', dateBasis: 'transaction' }, observed: cardSyncObservedRange(posted, 'transaction')!, completeness: 'complete', pageCount: 1, termination: 'end-marker' },
      { accountRef: account, status: 'pending', requested: { start: '2026-10-16', end: '2026-10-16', dateBasis: 'observation' }, observed: cardSyncObservedRange(pending, 'transaction')!, completeness: 'complete', pageCount: 1, termination: 'end-marker' },
    ],
    rejectedCount: 0,
  };
}

/** Wells Fargo rendered account list: candidates only. */
export function projectedWellsFargoAccountsFixture(): ProjectedBankBatchV1 {
  return {
    type: 'projected-bank-batch/v1',
    contractVersion: CARD_SYNC_CONTRACT_VERSION,
    issuer: 'wellsfargo',
    contract: 'wf.rendered-accounts',
    streamHandle: fixtureId('stream', 'projected/wellsfargo/stream'),
    sequence: 0,
    observedAt: '2026-10-16T18:20:40.000Z',
    currency: 'USD',
    accounts: [
      { ref: fixtureId('accountCandidate', 'projected/wellsfargo/account/1'), last4: '8086', productHint: text('Example Signature Card', 'productHint') },
      { ref: fixtureId('accountCandidate', 'projected/wellsfargo/account/2'), last4: null, productHint: null },
    ],
    transactions: [],
    coverage: [],
    rejectedCount: 0,
  };
}

export const CARD_SYNC_V2_FIXTURE_BUILDERS = Object.freeze({
  'chase.v2.json': chaseFixture,
  'amex.v2.json': amexFixture,
  'amex-rest.v2.json': amexRestFixture,
  'citi.v2.json': citiFixture,
  'wellsfargo.v2.json': wellsFargoFixture,
});

export const PROJECTED_BATCH_FIXTURE_BUILDERS = Object.freeze({
  'projected.chase-activity.json': projectedChaseActivityFixture,
  'projected.citi-transactions.json': projectedCitiTransactionsFixture,
  'projected.wellsfargo-accounts.json': projectedWellsFargoAccountsFixture,
});

export type CardSyncV2FixtureName = keyof typeof CARD_SYNC_V2_FIXTURE_BUILDERS;
export type ProjectedBatchFixtureName = keyof typeof PROJECTED_BATCH_FIXTURE_BUILDERS;
