import { describe, expect, it } from 'vitest';

import {
  METALS_TITLE_GUARD,
  metalsCardCapture,
  metalsChargeParts,
  metalsReceiptCharges,
  type Metal,
  type MetalsAdmissionFacts,
  type MetalsBullionAnswer,
  type MetalsLine,
  type MetalsLineMetalUncertain,
  type MetalsOrder,
} from '@finance-tracker/shared/metals-ledger';
import { delivered, metalItem, syntheticKey, syntheticOrder } from '@finance-tracker/shared/metals-ledger-fixtures';
import type { MetalsBullionPreview } from '@finance-tracker/shared/metals-api';

import { metalsCaptureInput } from './cardCheck.js';
import { metalsCardCheckSource, metalsProofRecords } from './cardCheckInputs.js';
import { metalsBullionPreview } from './decisions.js';
import {
  buildMetalsLedgerGraph,
  metalsHeldForMetals,
  metalsProductRefUnique,
  metalsResolveContent,
  type MetalsBullionDecisionInput,
  type MetalsCoverageInput,
  type MetalsDecisionInput,
  type MetalsHoldInput,
  type MetalsLedgerGraph,
  type MetalsLedgerInputs,
} from './ledger.js';
import { metalsConflictVersionMetals } from './source.js';
import { MetalsViews } from './views.js';

// Synthetic only: an invented order, card row, last 4, accounts and import ids; no database, clock or network.

const ACCOUNT = 'synthetic-walmart-account';
const CARD = 'synthetic-card-account';
const TODAY = '2030-03-20';
/** Every import here is made at this one instant. */
const INSTANT = '2030-03-20T12:00:00.000Z';
/** Two import ids, each sorting before or after the other as text. */
const LOW_ID = `mtl-imp-${'a'.repeat(32)}`;
const HIGH_ID = `mtl-imp-${'b'.repeat(32)}`;

/** A Walmart order of one 1 ozt gold bar, paid by one Visa card ending 1111. */
const ORDER = syntheticOrder({
  source: 'walmart', channel: 'online', id: 'g3c1', date: '2030-01-10',
  skeleton: [metalItem(0, 200000)],
  components: [{ kind: 'tax', amountMinor: 0 }],
  admission: {
    fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 200000 }],
    refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 200000,
  },
  lines: [{
    ordinal: 0, title: 'Sample Refinery 1 ozt Gold Bar FINE GOLD .9999', productRef: 'walmart:100001', metal: 'XAU', form: 'bar',
    statedMass: { value: '1', unit: 'ozt' }, pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null,
    quantity: 1, unitPriceMinor: 200000, events: [delivered(1, '2030-01-14')], seller: 'Sample Bullion Shop',
  }],
});

/** An import of the order's account, with its causal sequence number. */
const anImport = (importId: string, importSeq: number): MetalsLedgerInputs['imports'][number] => ({
  importId, importSeq, source: 'walmart', accountId: ACCOUNT, capturedAt: null, importedAt: INSTANT, captureSchema: null,
  converterVersion: 'holdr-metals-convert 1.0.0',
});
/** An import that read the order. */
const read = (importId: string): MetalsLedgerInputs['observations'][number] => ({ importId, accountId: ACCOUNT, orderKey: ORDER.key });
/** An import that couldn't read the order: its record is held. */
const held = (importId: string): MetalsHoldInput => ({
  importId, seq: 0, source: 'walmart', accountId: ACCOUNT, key: ORDER.key, channel: 'online', date: '2030-01-10', reason: 'unreadable',
  check: 'detail-shape',
});

/** The ledger with the order, an approved binding of its card, and the one charge it made. */
function graph(imports: MetalsLedgerInputs['imports'], observations: MetalsLedgerInputs['observations'], holds: MetalsHoldInput[],
  coverage: MetalsCoverageInput[] = []): MetalsLedgerGraph {
  return buildMetalsLedgerGraph({
    orders: [{ order: ORDER, digest: 'd'.repeat(64), quarantined: false, conflictMetals: [] }],
    observations,
    accounts: [{ accountId: ACCOUNT, source: 'walmart', label: 'Walmart account' }],
    imports,
    competitors: [],
    competitorObservations: [],
    holds,
    coverage,
    bindings: [{ kind: 'card', source: 'walmart', network: 'visa', last4: '1111', accountId: CARD, state: 'active', accountStatus: 'active',
      accountOwner: 'owner-a', peerAccountIds: [CARD] }],
    decisions: [],
    bullionDecisions: [],
    cardAccounts: [{ id: CARD, issuer: 'samplebank', owner: 'owner-a', nickname: null, last4: '1111', last5: null, status: 'active' }],
    cardRows: [{ id: 'row-1', accountId: CARD, date: '2030-01-11', amountMinor: 200000, kind: 'purchase', currency: 'USD', merchant: null,
      description: 'WALMART.COM SAMPLE' }],
    checking: { installed: false, accounts: [], rows: [], coverage: [] },
  });
}

/** Which of the order's records stay held, and what its charge's link says. */
const outcome = (built: MetalsLedgerGraph) => ({
  held: built.openHolds.map((hold) => hold.key),
  links: (built.cardLinksByOrder.get(ORDER.key) ?? []).map((link) => link.state),
});

describe('metals ledger graph: chronology of imports (G3-C1)', () => {
  it('orders imports by their causal sequence, never by id or time: at one instant, either id order, a later hold stays and a later read releases', () => {
    for (const [first, second] of [[LOW_ID, HIGH_ID], [HIGH_ID, LOW_ID]] as const) {
      const imports = [anImport(first, 1), anImport(second, 2)];
      // The order read, then a later import couldn't read it: the hold stays, and bars its charge.
      expect(outcome(graph(imports, [read(first)], [held(second)]))).toEqual({ held: [ORDER.key], links: ['competitor-held'] });
      // A hold, then a later import read the order: the hold is released, and the charge links.
      expect(outcome(graph(imports, [read(second)], [held(first)]))).toEqual({ held: [], links: ['linked'] });
    }
  });

  it('fails closed on an import it doesn\'t know: its held record stays open, and its read releases nothing', () => {
    const known = [anImport(LOW_ID, 1)];
    // A held record from an import this read doesn't know sorts last: no known read comes after it.
    expect(outcome(graph(known, [read(LOW_ID)], [held(HIGH_ID)]))).toEqual({ held: [ORDER.key], links: ['competitor-held'] });
    // A read from an import it doesn't know releases nothing.
    expect(outcome(graph(known, [read(HIGH_ID)], [held(LOW_ID)]))).toEqual({ held: [ORDER.key], links: ['competitor-held'] });
  });
});

describe('metals views over a graph: what an import this read doesn\'t know states (H7)', () => {
  /** The account's online coverage from `from` through today, as an import states it. */
  const coverage = (importId: string, from: string, complete = true): MetalsCoverageInput => ({
    importId, source: 'walmart', accountId: ACCOUNT, kind: 'online', from, to: TODAY, stated: 9, seen: complete ? 9 : 8, complete,
  });
  const viewsOf = (rows: MetalsCoverageInput[]) => new MetalsViews({
    graph: graph([anImport(LOW_ID, 1)], [read(LOW_ID)], [], rows), today: TODAY, screen: () => ({ admissible: [], levelShifts: [] }), fetching: false,
  });
  const holdingCodes = (views: MetalsViews) => views.overview('XAU', { from: null, to: TODAY }, TODAY).holdings.troyOz.reasons.map((reason) => reason.code);

  it('counts no coverage an unknown import states, records no month by it, and never shows it', () => {
    // Its own import's complete coverage covers the holding; the same, stated by an import it doesn't know, doesn't.
    const byImport = [holdingCodes(viewsOf([coverage(LOW_ID, '2029-01-01')])), holdingCodes(viewsOf([coverage(HIGH_ID, '2029-01-01')]))];
    expect(byImport).toEqual([[], ['not-covered']]);
    // Nor does it make a month of the timeline recorded.
    expect(viewsOf([coverage(HIGH_ID, '2029-01-01')]).timeline('XAU', '2030-03', '2030-03').months.map((month) => month.recorded)).toEqual([false]);
    // The coverage shown is its own import's (incomplete), though an unknown import states later, complete coverage.
    const [entry] = viewsOf([coverage(LOW_ID, '2029-01-01', false), coverage(HIGH_ID, '2028-01-01')]).coverageEntries();
    expect(entry.kinds).toEqual([expect.objectContaining({ kind: 'online', from: '2029-01-01', complete: false, ranges: [] })]);
    // A kind only an unknown import states isn't listed, as if never covered.
    expect(viewsOf([coverage(HIGH_ID, '2029-01-01')]).coverageEntries().map((listed) => listed.kinds)).toEqual([[]]);
  });
});

describe('metals read source: the metals of a conflicting version (H6)', () => {
  it('reads stored text that isn\'t JSON as of unknown metal, never failing the read', () => {
    // Only the read's own refusal of such text is caught, as data: a TypeError, by its constructor, name and exact words
    // (the allowlist). Anything else is re-thrown as it is, so no other error can pass for this test's assertion.
    let read: Array<Metal | null> | string;
    try {
      read = metalsConflictVersionMetals('{ not JSON', ORDER.key);
    } catch (error) {
      const refusal = error instanceof TypeError && error.constructor === TypeError && error.name === 'TypeError'
        && error.message === 'a stored order version is not JSON';
      if (!refusal) throw error;
      read = error.message;
    }
    expect(read).toEqual([null]);
  });
});

describe('metals ledger graph: held for metals (G3-int A0, ROOT\'s binding condition 1)', () => {
  const FLAG: MetalsLineMetalUncertain = { guard: METALS_TITLE_GUARD, evidence: ['shape-with-weight', 'troy-or-metric-weight'], metal: 'XAU' };
  const BAR_TITLE = 'Sample Refinery 1 ozt Gold Bar FINE GOLD .9999';
  const FLAGGED_TITLE = 'Sample Refinery 1 ozt Gold Bar Assay Card';
  const CHECKING = 'synthetic-checking-account';
  const DIGEST = 'd'.repeat(64);

  /** A Walmart order of a 1 ozt gold bar and a line the title guard flagged, paid by the Visa card ending 1111. */
  const HELD = syntheticOrder({
    source: 'walmart', channel: 'online', id: 'held-1', date: '2030-01-09',
    skeleton: [metalItem(0, 200000), metalItem(1, 150000)],
    components: [{ kind: 'tax', amountMinor: 0 }],
    admission: {
      fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 350000 }],
      refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: 350000,
    },
    lines: [
      { ordinal: 0, title: BAR_TITLE, productRef: 'walmart:100009', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' }, pack: 'single',
        purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null, quantity: 1, unitPriceMinor: 200000,
        events: [delivered(1, '2030-01-13')], seller: 'Sample Bullion Shop' },
      { ordinal: 1, title: FLAGGED_TITLE, productRef: 'walmart:100002', metal: null, metalUncertain: FLAG, form: null, statedMass: null, pack: 'single',
        purity: null, massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 150000, events: [delivered(1, '2030-01-13')],
        seller: 'Sample Bullion Shop' },
    ],
  });

  /** A CollectPure sale paid out $2,070.00 to a checking account ending 2222 on 2030-02-06: of a gold bar, or of a flagged line. */
  const sale = (id: string, flagged: boolean): MetalsOrder => syntheticOrder({
    source: 'collectpure', channel: 'online', id, date: '2030-02-03', tradeMoment: '2030-02-03T15:00:00Z', status: 'complete',
    completedDate: '2030-02-06',
    skeleton: [metalItem(0, 210000)],
    components: [{ kind: 'platform-fee', amountMinor: -2000 }, { kind: 'insured-shipping', amountMinor: -1000 }],
    payouts: [{ key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '2222', amountMinor: 207000,
      initiatedDate: '2030-02-06', payoutDate: '2030-02-06', status: 'complete' }],
    lines: [flagged
      ? { ordinal: 0, title: FLAGGED_TITLE, productRef: 'collectpure:SKU-CARD1', metal: null, metalUncertain: FLAG, form: null, statedMass: null,
        pack: 'single', purity: null, massBasis: 'none', design: null, quantity: 1, unitPriceMinor: 210000,
        events: [{ kind: 'agreed', date: '2030-02-03', dateBasis: 'stated', quantity: 1, occurrence: 1 }] }
      : { ordinal: 0, title: BAR_TITLE, productRef: 'collectpure:SKU-BAR1', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' },
        pack: 'single', purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine', design: null, quantity: 1, unitPriceMinor: 210000,
        events: [{ kind: 'agreed', date: '2030-02-03', dateBasis: 'stated', quantity: 1, occurrence: 1 }] }],
  });
  const HELD_SALE = sale('held-sale', true);
  const SALE = sale('sale-1', false);

  /**
   * The ledger of the given orders, all read by one import: the Visa card bound with ORDER's charge (2030-01-11) and the
   * held order's (2030-01-10) on it, and the checking account ending 2222 bound with one dealer credit of $2,070.00.
   */
  const ledgerOf = (orders: MetalsOrder[], options: Parameters<typeof buildMetalsLedgerGraph>[1] = {}) => buildMetalsLedgerGraph({
    orders: orders.map((order) => ({ order, digest: DIGEST, quarantined: false, conflictMetals: [] })),
    observations: orders.map((order) => ({ importId: LOW_ID, accountId: ACCOUNT, orderKey: order.key })),
    accounts: [{ accountId: ACCOUNT, source: 'walmart', label: 'Walmart account' }],
    imports: [anImport(LOW_ID, 1)],
    competitors: [],
    competitorObservations: [],
    holds: [],
    coverage: [],
    bindings: [
      { kind: 'card', source: 'walmart', network: 'visa', last4: '1111', accountId: CARD, state: 'active', accountStatus: 'active',
        accountOwner: 'owner-a', peerAccountIds: [CARD] },
      { kind: 'checking', source: 'collectpure', network: null, last4: '2222', accountId: CHECKING, state: 'active', accountStatus: 'active',
        accountOwner: null, peerAccountIds: [CHECKING] },
    ],
    decisions: [],
    bullionDecisions: [],
    cardAccounts: [{ id: CARD, issuer: 'samplebank', owner: 'owner-a', nickname: null, last4: '1111', last5: null, status: 'active' }],
    cardRows: [
      { id: 'row-1', accountId: CARD, date: '2030-01-11', amountMinor: 200000, kind: 'purchase', currency: 'USD', merchant: null,
        description: 'WALMART.COM SAMPLE' },
      { id: 'row-held', accountId: CARD, date: '2030-01-10', amountMinor: 350000, kind: 'purchase', currency: 'USD', merchant: null,
        description: 'WALMART.COM SAMPLE' },
    ],
    checking: {
      installed: true,
      accounts: [{ id: CHECKING, label: 'Sample Checking', last4: '2222', status: 'active' }],
      rows: [{ id: 'credit-1', accountId: CHECKING, date: '2030-02-07', amountMinor: 207000, currency: 'USD', description: 'SAMPLE DEALER ACH CREDIT' }],
      coverage: [{ accountId: CHECKING, from: '2030-01-01', to: '2030-03-19' }],
    },
  }, options);
  const lotDecision = (lotKey: string): MetalsDecisionInput => ({
    id: `mtl-dec-${'c'.repeat(32)}`, scope: 'lot', productRef: null, fingerprint: null, lotKey, evidenceDigest: DIGEST, metal: 'XAU',
    troyOzPerUnit: '1/1', decidedAt: INSTANT,
  });

  it('reads the title guard\'s flag into the line: held bullion-unconfirmed, and a content decision never releases it', () => {
    const [bar, flagged] = HELD.lines;
    const resolve = (line: typeof bar, decisions: MetalsDecisionInput[]) => {
      const { content, decision } = metalsResolveContent('walmart', line, DIGEST, decisions);
      return { hold: content.known ? null : content.hold, basis: content.known ? content.basis : null, decision: decision?.id ?? null };
    };
    expect(resolve(flagged, [])).toEqual({ hold: 'bullion-unconfirmed', basis: null, decision: null });
    // A content-only approval of the flagged line's own lot answers nothing: the bullion gate comes first.
    expect(resolve(flagged, [lotDecision(flagged.key)])).toEqual({ hold: 'bullion-unconfirmed', basis: null, decision: null });
    // The same decision answers a line with no flag (the control).
    expect(resolve(bar, [lotDecision(bar.key)])).toEqual({ hold: null, basis: 'owner-confirmed', decision: `mtl-dec-${'c'.repeat(32)}` });
  });

  it('holds an order while a line is flagged, stored bullion-unconfirmed or read so, and only then', () => {
    const [bar, flagged] = HELD.lines;
    const known = metalsResolveContent('walmart', bar, DIGEST, []).content;
    const unconfirmed = metalsResolveContent('walmart', flagged, DIGEST, []).content;
    const storedUnconfirmed = { ...bar, fine: { hold: 'bullion-unconfirmed' as const, missing: ['bullion-unconfirmed' as const] } };
    const noField = { ...bar, metalUncertain: undefined as unknown as null };
    // One assertion per case, so each clause of the predicate has its own declared site.
    expect(metalsHeldForMetals([{ line: bar, content: known }])).toBe(false);
    expect(metalsHeldForMetals([{ line: bar, content: known }, { line: flagged, content: unconfirmed }])).toBe(true);
    expect(metalsHeldForMetals([{ line: storedUnconfirmed, content: known }])).toBe(true);
    expect(metalsHeldForMetals([{ line: bar, content: unconfirmed }])).toBe(true);
    expect(metalsHeldForMetals([{ line: noField, content: known }])).toBe(true);
  });

  it('keeps every line of a held order, flagged or not, out of the ledger\'s lines: lots, sales and the assignment\'s inputs', () => {
    const built = ledgerOf([ORDER, HELD, HELD_SALE, SALE]);
    expect(built.lines.map((entry) => entry.key).sort()).toEqual([ORDER.lines[0].key, SALE.lines[0].key].sort());
    expect([...built.lineByKey.keys()].sort()).toEqual([ORDER.lines[0].key, SALE.lines[0].key].sort());
    expect(built.heldOrders.map((entry) => entry.order.key)).toEqual([HELD.key, HELD_SALE.key].sort());
    const standing = [...built.orders.values()].map((entry) => [entry.order.key, entry.heldForMetals]).sort();
    expect(standing).toEqual([[ORDER.key, false], [HELD.key, true], [HELD_SALE.key, true], [SALE.key, false]].sort());
  });

  it('feeds a held order to card links as a held barrier, never a subject: its charge never links, and its window bars another\'s', () => {
    const states = (built: MetalsLedgerGraph) => [HELD.key, ORDER.key].map((key) => (built.cardLinksByOrder.get(key) ?? []).map((link) => link.state));
    // Alone, the gold order's charge links (the control).
    expect(states(ledgerOf([ORDER]))).toEqual([[], ['linked']]);
    // The held order (2030-01-09) bars every walmart.com row in its 30-day window, the gold order's included, and is no subject.
    const built = ledgerOf([ORDER, HELD]);
    expect(states(built)).toEqual([[], ['competitor-held']]);
    expect([...built.cardGraph.proofByRow.keys()]).toEqual([]);
  });

  it('gives a held order no charge order: no receipt charge and no parts, whatever links', () => {
    const built = ledgerOf([ORDER, HELD]);
    expect([...built.chargeOrders.keys()]).toEqual([ORDER.key]);
    expect(metalsReceiptCharges(built.cardGraph, built.chargeOrders)).toEqual([]);
    expect(metalsChargeParts('row-held', built.cardGraph, built.chargeOrders)).toEqual({ provable: false, reason: 'not-linked' });
  });

  it('keeps a held sale\'s payouts contesting credits, and proving nothing', () => {
    const matches = { originSources: () => ['collectpure'] as const };
    const deposit = (built: MetalsLedgerGraph, order: MetalsOrder) => {
      const link = built.depositLinks.get(order.payouts[0].key);
      return link ? [link.state, link.proof] : null;
    };
    // Alone, a counted sale's payout links to the credit, as asset-sale proceeds (the control).
    const counted = ledgerOf([SALE], matches);
    expect([deposit(counted, SALE), counted.depositEvidence.length]).toEqual([['linked', true], 1]);
    // A held sale's payout points at the same credit but proves nothing.
    const held = ledgerOf([HELD_SALE], matches);
    expect([deposit(held, HELD_SALE), held.depositEvidence.length]).toEqual([['ineligible', false], 0]);
    // Beside the counted sale, it still contests the credit: neither links.
    const both = ledgerOf([SALE, HELD_SALE], matches);
    expect([deposit(both, SALE), deposit(both, HELD_SALE), both.depositEvidence.length]).toEqual([['ambiguous', false], ['ambiguous', false], 0]);
  });
});

describe('metals ledger graph: the owner\'s bullion answers and the whole-order projection (G3-dec)', () => {
  const FLAG: MetalsLineMetalUncertain = { guard: METALS_TITLE_GUARD, evidence: ['shape-with-weight', 'troy-or-metric-weight'], metal: 'XAU' };
  const BAR_TITLE = 'Sample Refinery 1 ozt Gold Bar FINE GOLD .9999';
  const FLAGGED_TITLE = 'Sample Refinery 1 ozt Gold Bar Assay Card';
  const CHECKING = 'synthetic-checking-account';
  const DIGEST = 'd'.repeat(64);
  const PRODUCT_ID = `mtl-dec-${'p'.repeat(32)}`;
  const LOT_ID = `mtl-dec-${'l'.repeat(32)}`;

  /** A delivered 1 ozt gold bar line by its stated fine mass, $2,000.00 unless given. */
  const barLine = (ordinal: number, unitPriceMinor = 200000) => ({
    ordinal, title: BAR_TITLE, productRef: 'walmart:100009', metal: 'XAU' as const, form: 'bar' as const,
    statedMass: { value: '1', unit: 'ozt' as const }, pack: 'single' as const, purity: null, massBasis: 'fine' as const,
    design: null, quantity: 1, unitPriceMinor, events: [delivered(1, '2030-01-13')], seller: 'Sample Bullion Shop',
  });
  /** A delivered line the title guard flagged, $1,500.00 unless given, of the ref walmart:100002 unless given. */
  const flaggedLine = (ordinal: number, options: { flag?: MetalsLineMetalUncertain; productRef?: string | null; unitPriceMinor?: number } = {}) => ({
    ordinal, title: FLAGGED_TITLE, productRef: options.productRef === undefined ? 'walmart:100002' : options.productRef, metal: null,
    metalUncertain: options.flag ?? FLAG, form: null, statedMass: null, pack: 'single' as const, purity: null, massBasis: 'none' as const, design: null,
    quantity: 1, unitPriceMinor: options.unitPriceMinor ?? 150000, events: [delivered(1, '2030-01-13')], seller: 'Sample Bullion Shop',
  });
  /** One Visa card ending 1111 paying the whole order. */
  const visa = (amountMinor: number): MetalsAdmissionFacts => ({
    fulfilment: { shipments: 1 }, methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor }],
    refunded: false, cancelled: false, partlyCancelled: false, grossTotalMinor: amountMinor,
  });
  /** A Walmart order of the given lines, one skeleton item each, on one Visa card. */
  const walmart = (id: string, date: string, lines: Array<ReturnType<typeof barLine> | ReturnType<typeof flaggedLine>>) => syntheticOrder({
    source: 'walmart', channel: 'online', id, date, skeleton: lines.map((line) => metalItem(line.ordinal, line.unitPriceMinor)),
    components: [{ kind: 'tax', amountMinor: 0 }], admission: visa(lines.reduce((total, line) => total + line.unitPriceMinor, 0)), lines,
  });
  /** A CollectPure sale of one line paid out $2,100.00 in full to the checking account ending 2222 on 2030-02-06: a gold bar, or a flagged line. */
  const saleOf = (id: string, flagged: boolean): MetalsOrder => syntheticOrder({
    source: 'collectpure', channel: 'online', id, date: '2030-02-03', tradeMoment: '2030-02-03T15:00:00Z', status: 'complete',
    completedDate: '2030-02-06', skeleton: [metalItem(0, 210000)],
    payouts: [{ key: syntheticKey('collectpure', 'payout', id), method: 'ach', destinationLast4: '2222', amountMinor: 210000,
      initiatedDate: '2030-02-06', payoutDate: '2030-02-06', status: 'complete' }],
    lines: [{ ...(flagged ? flaggedLine(0, { productRef: `collectpure:SKU-${id}`, unitPriceMinor: 210000 })
      : { ...barLine(0, 210000), productRef: 'collectpure:SKU-BAR1' }),
    events: [{ kind: 'agreed', date: '2030-02-03', dateBasis: 'stated', quantity: 1, occurrence: 1 }], seller: undefined }],
  });

  /**
   * A Walmart order of a gold bar ($2,000.00) and a flagged line ($1,500.00) with its own $50.00 fee and $20.00 coupon,
   * and $9.99 shipping for the whole order, shared by both lines while both are metal: $3,539.99 on the Visa card.
   */
  const MIXED = syntheticOrder({
    source: 'walmart', channel: 'online', id: 'dec-mixed', date: '2030-01-09',
    skeleton: [metalItem(0, 200000), metalItem(1, 150000),
      { ordinal: 2, kind: 'fee', amountMinor: 5000, shippingMinor: null, feeParent: 1, couponTarget: null, taxFlag: null, metal: true },
      { ordinal: 3, kind: 'coupon', amountMinor: -2000, shippingMinor: null, feeParent: null, couponTarget: 1, taxFlag: null, metal: true }],
    components: [{ kind: 'shipping', amountMinor: 999 }],
    admission: visa(353999),
    lines: [barLine(0), flaggedLine(1)],
  });

  /** The owner's answer for a line's product: its ref with its content fingerprint (or another one). */
  const productAnswer = (line: MetalsLine, answer: MetalsBullionAnswer, fingerprint = line.contentFingerprint): MetalsBullionDecisionInput => ({
    id: PRODUCT_ID, scope: 'product', productRef: line.productRef, fingerprint, lotKey: null, evidenceDigest: null, answer, decidedAt: INSTANT,
  });
  /** The owner's answer for one lot, pinned to an order's active version digest. */
  const lotAnswer = (line: MetalsLine, answer: MetalsBullionAnswer, evidenceDigest = DIGEST): MetalsBullionDecisionInput => ({
    id: LOT_ID, scope: 'lot', productRef: null, fingerprint: null, lotKey: line.key, evidenceDigest, answer, decidedAt: INSTANT,
  });

  /**
   * The ledger of the given orders (each active version's digest DIGEST unless given), all read by one import, with these
   * live answers: the Visa card bound with the given charges, and the checking account ending 2222 bound with one dealer
   * credit of $2,100.00.
   */
  const ledgerWith = (orders: MetalsOrder[], bullion: MetalsBullionDecisionInput[], extra: { cardRows?: MetalsLedgerInputs['cardRows']; digest?: string } = {},
    options: Parameters<typeof buildMetalsLedgerGraph>[1] = {}) => buildMetalsLedgerGraph({
    orders: orders.map((order) => ({ order, digest: extra.digest ?? DIGEST, quarantined: false, conflictMetals: [] })),
    observations: orders.map((order) => ({ importId: LOW_ID, accountId: ACCOUNT, orderKey: order.key })),
    accounts: [{ accountId: ACCOUNT, source: 'walmart', label: 'Walmart account' }],
    imports: [anImport(LOW_ID, 1)],
    competitors: [],
    competitorObservations: [],
    holds: [],
    coverage: [],
    bindings: [
      { kind: 'card', source: 'walmart', network: 'visa', last4: '1111', accountId: CARD, state: 'active', accountStatus: 'active',
        accountOwner: 'owner-a', peerAccountIds: [CARD] },
      { kind: 'checking', source: 'collectpure', network: null, last4: '2222', accountId: CHECKING, state: 'active', accountStatus: 'active',
        accountOwner: null, peerAccountIds: [CHECKING] },
    ],
    decisions: [],
    bullionDecisions: bullion,
    cardAccounts: [{ id: CARD, issuer: 'samplebank', owner: 'owner-a', nickname: null, last4: '1111', last5: null, status: 'active' }],
    cardRows: extra.cardRows ?? [],
    checking: {
      installed: true,
      accounts: [{ id: CHECKING, label: 'Sample Checking', last4: '2222', status: 'active' }],
      rows: [{ id: 'credit-1', accountId: CHECKING, date: '2030-02-07', amountMinor: 210000, currency: 'USD', description: 'SAMPLE DEALER ACH CREDIT' }],
      coverage: [{ accountId: CHECKING, from: '2030-01-01', to: '2030-03-19' }],
    },
  }, options);
  /** A walmart.com charge on the bound Visa card. */
  const charge = (id: string, date: string, amountMinor: number): MetalsLedgerInputs['cardRows'][number] => ({
    id, accountId: CARD, date, amountMinor, kind: 'purchase', currency: 'USD', merchant: null, description: 'WALMART.COM SAMPLE',
  });

  it('answers each flagged line through the one matcher: undecided holds its order; a product answer releases every order of its ref and fingerprint', () => {
    const [, flagged] = MIXED.lines;
    // The same product in another order; and a line of its ref the guard read other evidence on (another fingerprint).
    const again = walmart('dec-again', '2030-02-20', [flaggedLine(0)]);
    const other = walmart('dec-other', '2030-02-21', [flaggedLine(0, { flag: { ...FLAG, evidence: ['shape-with-weight'] } })]);
    expect([again.lines[0].contentFingerprint === flagged.contentFingerprint, other.lines[0].contentFingerprint === flagged.contentFingerprint])
      .toEqual([true, false]);
    const standing = (built: MetalsLedgerGraph) => [MIXED, again, other].map((order) => {
      const entry = built.flagged.find((line) => line.order.order.key === order.key)!;
      return [entry.answer, entry.drift, entry.order.heldForMetals, entry.decision?.id ?? null];
    });
    expect(standing(ledgerWith([MIXED, again, other], []))).toEqual([[null, false, true, null], [null, false, true, null], [null, false, true, null]]);
    // One answer for the product: both of its orders released. The ref's line of another fingerprint drifted: held.
    const answered = ledgerWith([MIXED, again, other], [productAnswer(flagged, 'bullion')]);
    expect(standing(answered)).toEqual([['bullion', false, false, PRODUCT_ID], ['bullion', false, false, PRODUCT_ID], [null, true, true, null]]);
    expect(answered.heldOrders.map((order) => order.order.key)).toEqual([other.key]);
  });

  it('defines the product-ref rule once, for both kinds of decision: a present ref names one product', () => {
    expect([metalsProductRefUnique('walmart:100002'), metalsProductRefUnique(null)]).toEqual([true, false]);
  });

  it('answers a line with no product ref on its own lot, only while its order\'s active version digest is the one the answer pinned', () => {
    const order = walmart('dec-lot', '2030-02-22', [flaggedLine(0, { productRef: null })]);
    const [line] = order.lines;
    const standing = (built: MetalsLedgerGraph) => {
      const entry = built.flaggedByKey.get(line.key)!;
      return [entry.answer, entry.drift, entry.order.heldForMetals, entry.decision?.id ?? null, entry.scope];
    };
    const scope = { kind: 'lot', lotKey: line.key };
    expect(standing(ledgerWith([order], [lotAnswer(line, 'bullion')]))).toEqual(['bullion', false, false, LOT_ID, scope]);
    // A later capture of the order (a progression too) is another active version: the answer drifted until given again.
    expect(standing(ledgerWith([order], [lotAnswer(line, 'bullion')], { digest: 'e'.repeat(64) }))).toEqual([null, true, true, LOT_ID, scope]);
  });

  it('holds an order while a flagged line has no answer, and never for a not-bullion line\'s own hold (the one predicate, v1)', () => {
    const [bar, flagged] = MIXED.lines;
    const known = metalsResolveContent('walmart', bar, DIGEST, []).content;
    const unconfirmed = metalsResolveContent('walmart', flagged, DIGEST, []).content;
    const answered = metalsResolveContent('walmart', flagged, DIGEST, [], [productAnswer(flagged, 'bullion')]).content;
    // One assertion per case, so each clause of the predicate has its own declared site.
    expect(metalsHeldForMetals([{ line: bar, content: known }, { line: flagged, content: unconfirmed, answer: null }])).toBe(true);
    expect(metalsHeldForMetals([{ line: bar, content: known }, { line: flagged, content: unconfirmed, answer: 'not-bullion' }])).toBe(false);
    expect(metalsHeldForMetals([{ line: bar, content: known }, { line: flagged, content: answered, answer: 'bullion' }])).toBe(false);
    // Fail-closed: an answer the recomputed content doesn't agree with.
    expect(metalsHeldForMetals([{ line: bar, content: known }, { line: flagged, content: unconfirmed, answer: 'bullion' }])).toBe(true);
  });

  it('takes a not-bullion line out of metals with its fee and coupon, and recomputes the WHOLE order\'s money over the new skeleton', () => {
    const [bar, flagged] = MIXED.lines;
    // As stored: both lines metal, the shipping shared between them, every cent attributed.
    expect([bar.costMinor, bar.complete, flagged.costMinor, MIXED.unattributedMinor]).toEqual([200566, true, 153433, 0]);
    const built = ledgerWith([MIXED], [productAnswer(flagged, 'not-bullion')]);
    const order = built.orders.get(MIXED.key)!;
    expect([order.heldForMetals, order.leftLedger]).toEqual([false, false]);
    expect(order.order.skeleton.map((line) => line.metal)).toEqual([true, false, false, false]);
    // The shipping now reaches a metal line and one that isn't: unattributed, and the bar incomplete at its own cost.
    expect(order.order.lines.map((line) => [line.key, line.costMinor, line.allocated, line.complete])).toEqual([[bar.key, 200000, [], false]]);
    expect([order.order.unattributedMinor, order.order.fullPriceMinor]).toEqual([999, MIXED.fullPriceMinor]);
    expect(built.lines.map((entry) => [entry.key, entry.line.costMinor, entry.raw.costMinor])).toEqual([[bar.key, 200000, 200566]]);
    // Nothing stored changed: the aggregate, its raw skeleton and its lines' money.
    expect([order.stored === MIXED, MIXED.skeleton.map((line) => line.metal), bar.costMinor]).toEqual([true, [true, true, true, true], 200566]);
  });

  it('reads a bullion line as a line of its flag\'s metal with the money as stored; a flag naming several metals is a line of unknown metal', () => {
    const [bar, flagged] = MIXED.lines;
    const built = ledgerWith([MIXED], [productAnswer(flagged, 'bullion')]);
    expect(built.lines.map((entry) => [entry.key, entry.line.metal, entry.raw.metal, entry.line.costMinor, entry.line.complete])).toEqual([
      [bar.key, 'XAU', 'XAU', 200566, true], [flagged.key, 'XAU', null, 153433, true]]);
    const several = walmart('dec-several', '2030-02-23', [flaggedLine(0, { flag: { ...FLAG, metal: null }, productRef: 'walmart:100003' })]);
    const unknown = ledgerWith([several], [productAnswer(several.lines[0], 'bullion')]);
    expect(unknown.lines.map((entry) => [entry.line.metal, entry.content.known ? null : entry.content.hold])).toEqual([[null, 'metal-unknown']]);
  });

  it('feeds an order left with no metal line to card links as a competitor, never a subject: its funding still contests a charge', () => {
    const left = walmart('dec-left', '2030-01-20', [flaggedLine(0, { productRef: 'walmart:100004' })]);
    const gold = walmart('dec-gold', '2030-01-20', [barLine(0, 150000)]);
    const rows = [charge('row-1500', '2030-01-21', 150000)];
    const links = (built: MetalsLedgerGraph) => [left, gold].map((order) => (built.cardLinksByOrder.get(order.key) ?? []).map((link) => link.state));
    // Alone, the gold order's charge links (the control).
    expect(links(ledgerWith([gold], [], { cardRows: rows }))).toEqual([[], ['linked']]);
    // Answered bullion, the flagged order is a subject too: two subjects contest the one charge.
    expect(links(ledgerWith([left, gold], [productAnswer(left.lines[0], 'bullion')], { cardRows: rows }))).toEqual([['ambiguous'], ['ambiguous']]);
    // Not bullion, it left the ledger: no subject of its own, but its card funding still contests the gold order's charge.
    const built = ledgerWith([left, gold], [productAnswer(left.lines[0], 'not-bullion')], { cardRows: rows });
    expect([built.orders.get(left.key)!.leftLedger, links(built), built.lines.map((entry) => entry.key)]).toEqual([true, [[], ['ambiguous']], [gold.lines[0].key]]);
  });

  it('builds a counted order\'s charge parts from its projection: a not-bullion line is another part, a bullion line its flag\'s metal', () => {
    const order = walmart('dec-parts', '2030-02-10', [barLine(0), flaggedLine(1, { productRef: 'walmart:100005' })]);
    const parts = (answer: MetalsBullionAnswer) => {
      const built = ledgerWith([order], [productAnswer(order.lines[1], answer)], { cardRows: [charge('row-3500', '2030-02-11', 350000)] });
      return metalsChargeParts('row-3500', built.cardGraph, built.chargeOrders);
    };
    expect(parts('not-bullion')).toEqual({ provable: true, basis: 'single-card-full-price', parts: [
      { kind: 'precious-metals', metals: ['XAU'], amountMinor: 200000 }, { kind: 'other', metals: [], amountMinor: 150000 }] });
    expect(parts('bullion')).toEqual({ provable: true, basis: 'all-metal', parts: [{ kind: 'precious-metals', metals: ['XAU'], amountMinor: 350000 }] });
  });

  it('keeps the payouts of a sale left with no metal line contesting credits, proving nothing', () => {
    const matches = { originSources: () => ['collectpure'] as const };
    const leftSale = saleOf('dec-left-sale', true);
    const counted = saleOf('dec-counted-sale', false);
    const notBullion = [productAnswer(leftSale.lines[0], 'not-bullion')];
    const deposit = (built: MetalsLedgerGraph, order: MetalsOrder) => {
      const link = built.depositLinks.get(order.payouts[0].key);
      return link ? [link.state, link.proof] : null;
    };
    // Answered bullion, the sale counts and its payout links (the control).
    const bullion = ledgerWith([leftSale], [productAnswer(leftSale.lines[0], 'bullion')], {}, matches);
    expect([deposit(bullion, leftSale), bullion.depositEvidence.length]).toEqual([['linked', true], 1]);
    const alone = ledgerWith([leftSale], notBullion, {}, matches);
    expect([alone.orders.get(leftSale.key)!.leftLedger, deposit(alone, leftSale), alone.depositEvidence.length]).toEqual([true, ['ineligible', false], 0]);
    const both = ledgerWith([counted, leftSale], notBullion, {}, matches);
    expect([deposit(both, counted), deposit(both, leftSale), both.depositEvidence.length]).toEqual([['ambiguous', false], ['ambiguous', false], 0]);
  });

  it('lists an order left with no metal line in no funding row, and none of its payouts\' deposits', () => {
    const left = walmart('dec-left-buy', '2030-01-20', [flaggedLine(0, { productRef: 'walmart:100006' })]);
    const leftSale = saleOf('dec-left-sale-2', true);
    const funding = (answer: MetalsBullionAnswer) => {
      const built = ledgerWith([left, leftSale], [productAnswer(left.lines[0], answer), productAnswer(leftSale.lines[0], answer)], {},
        { originSources: () => ['collectpure'] as const });
      const view = new MetalsViews({ graph: built, today: TODAY, screen: () => ({ admissible: [], levelShifts: [] }), fetching: false })
        .funding({ from: null, to: TODAY });
      return [view.purchases.map((entry) => entry.orderKey), view.sales.map((entry) => entry.orderKey), view.deposits.map((entry) => entry.payoutKey)];
    };
    expect(funding('bullion')).toEqual([[left.key], [leftSale.key], [leftSale.payouts[0].key]]);
    expect(funding('not-bullion')).toEqual([[], [], []]);
  });

  it('binds a preview to the evidence of every line it reaches and to the answer it replaces: either changed, it is another preview', () => {
    const [, flagged] = MIXED.lines;
    const scope = { kind: 'product' as const, ref: flagged.productRef!, fingerprint: flagged.contentFingerprint };
    const preview = (built: MetalsLedgerGraph, answer: MetalsBullionAnswer) =>
      metalsBullionPreview(built, TODAY, { action: 'answer', scope, answer }) as MetalsBullionPreview;
    // The same answer over another active version of its order: the same figures, other evidence.
    const [first, recaptured] = [preview(ledgerWith([MIXED], []), 'bullion'), preview(ledgerWith([MIXED], [], { digest: 'e'.repeat(64) }), 'bullion')];
    expect([first.lines, recaptured.lines, recaptured.digest === first.digest]).toEqual([1, 1, false]);
    // The same answer replacing another live answer of its scope (the same answer, another id): another replaced id.
    const live = productAnswer(flagged, 'bullion');
    const [replacing, replacingOther] = [preview(ledgerWith([MIXED], [live]), 'not-bullion'), preview(ledgerWith([MIXED], [{ ...live, id: LOT_ID }]), 'not-bullion')];
    expect([replacing.lines, replacingOther.lines, replacingOther.digest === replacing.digest]).toEqual([1, 1, false]);
  });

  it('keeps an order left with no metal line a captured order: the card check explains its charge by it; the proof and card links leave it out', () => {
    const left = walmart('dec-left-check', '2030-01-25', [flaggedLine(0, { productRef: 'walmart:100007' })]);
    const gold = walmart('dec-gold-check', '2030-01-20', [barLine(0)]);
    const rows = [charge('row-1500', '2030-01-26', 150000), charge('row-2000', '2030-01-21', 200000)];
    const read = (answer: MetalsBullionAnswer) => {
      const built = ledgerWith([left, gold], [productAnswer(left.lines[0], answer)], { cardRows: rows });
      // #359's capture check over this graph, its source taken from the graph's own inputs as the read model takes it.
      const capture = metalsCardCapture(metalsCaptureInput(built, metalsCardCheckSource(built.built.inputs, {
        credits: [], importedAccounts: [{ accountId: ACCOUNT, source: 'walmart', label: 'Walmart account', retired: false }], cardCoverage: [],
      })));
      const views = new MetalsViews({ graph: built, today: TODAY, screen: () => ({ admissible: [], levelShifts: [] }), fetching: false });
      return {
        leftLedger: built.orders.get(left.key)!.leftLedger,
        capture: capture.rows.map((row) => [row.rowId, row.status, row.explainedBy]),
        buys: metalsProofRecords(views, TODAY).buys.map((buy) => `${buy.source} ${buy.metal} ${buy.date}`).sort(),
        links: [left, gold].map((order) => (built.cardLinksByOrder.get(order.key) ?? []).map((link) => [link.state, link.rowId])),
        // Every link of the whole card graph that names the left order's charge, as its row or a candidate, by order.
        namingLeftRow: built.cardGraph.links.filter((link) => link.rowId === 'row-1500' || link.candidates.includes('row-1500'))
          .map((link) => link.orderKey),
        proofRows: [...built.cardGraph.proofByRow.keys()].sort(),
      };
    };
    const explained = [['row-1500', 'explained', `${left.key}#0`], ['row-2000', 'explained', `${gold.key}#0`]];
    // Answered bullion, the order counts: a buy record of the proof, and its charge links (the control).
    expect(read('bullion')).toEqual({ leftLedger: false, capture: explained, buys: ['walmart XAU 2030-01-20', 'walmart XAU 2030-01-25'],
      links: [[['linked', 'row-1500']], [['linked', 'row-2000']]], namingLeftRow: [left.key], proofRows: ['row-1500', 'row-2000'] });
    // Not bullion, it left the ledger. The capture check still explains its charge by it: a captured order, whatever its
    // metal (C2 b). The proof's records leave it out, and card links read it as a competitor only: no link of its own, the
    // bar's link exactly its own charge, and no link anywhere naming the left order's charge.
    expect(read('not-bullion')).toEqual({ leftLedger: true, capture: explained, buys: ['walmart XAU 2030-01-20'], links: [[], [['linked', 'row-2000']]],
      namingLeftRow: [], proofRows: ['row-2000'] });
  });
});
