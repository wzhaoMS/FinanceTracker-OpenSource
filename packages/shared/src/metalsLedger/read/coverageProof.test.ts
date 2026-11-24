import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { METALS_COVERAGE_PROOF_RULE as API_PROOF_RULE, type MetalsCoverageGap, type MetalsCoverageProof, type MetalsSourceRosterAnswer } from '../../metalsApi.js';
import { METALS_CAPTURE_SCHEMAS, METALS_SOURCES, type MetalsCoverageKind, type MetalsSource } from '../model.js';
import { metalsBindingDigest, metalsBindingEvidence, type MetalsBindingKey } from './bindingDigest.js';
import type { MetalsCardCaptureResult, MetalsCardCaptureRow } from './capture.js';
import type { MetalsStatedCoverage } from './coverage.js';
import {
  METALS_COVERAGE_PROOF_RULE,
  metalsCoverageProof,
  type MetalsCoverageCatalog,
  type MetalsCoverageProofInput,
  type MetalsRosterAnswerStored,
  type MetalsRosterClaim,
} from './coverageProof.js';

/** Synthetic ledgers only: invented accounts, labels, windows, records and rows. */
const ACCOUNTS = [
  { accountId: 'acct-costco', source: 'costco' as const, label: 'Costco membership 1', retired: false },
  { accountId: 'acct-walmart', source: 'walmart' as const, label: 'Walmart account 1', retired: false },
  { accountId: 'acct-cp', source: 'collectpure' as const, label: 'CollectPure account 1', retired: false },
];
const ref = (accountId: string) => {
  const account = ACCOUNTS.find((entry) => entry.accountId === accountId);
  assert.ok(account, accountId);
  return { accountId: account.accountId, source: account.source, label: account.label };
};
const entry = (accountId: string, source: MetalsSource, kind: MetalsCoverageKind, from: string, to: string,
  overrides: Partial<MetalsStatedCoverage> = {}): MetalsStatedCoverage => ({
  accountId, source, kind, from, to, complete: true, captureSchema: null, converterVersion: 'holdr-metals-convert 1.0.0', ...overrides,
});
const COSTCO_ONLINE = entry('acct-costco', 'costco', 'online', '2029-01-01', '2030-09-30');
const COSTCO_WAREHOUSE = entry('acct-costco', 'costco', 'warehouse', '2029-01-01', '2030-09-30');
const WALMART_ONLINE = entry('acct-walmart', 'walmart', 'online', '2029-01-01', '2030-09-30', { captureSchema: METALS_CAPTURE_SCHEMAS.walmart });
/** Whole history: CollectPure's sell orders under the full-count contract, though they start after acquisitionStart. */
const CP_SELL_ORDERS = entry('acct-cp', 'collectpure', 'sell-orders', '2030-05-01', '2030-09-30', { captureSchema: METALS_CAPTURE_SCHEMAS.collectpure });
const COVERAGE = [COSTCO_ONLINE, COSTCO_WAREHOUSE, WALMART_ONLINE, CP_SELL_ORDERS];
const RECORDS: MetalsCoverageProofInput['records'] = {
  buys: [{ source: 'costco', metal: 'XAU', date: '2030-03-01' }, { source: 'walmart', metal: 'XAG', date: '2030-04-01' }],
  sales: [{ source: 'collectpure', metal: 'XAU', agreedDay: '2030-06-01', included: true }],
  metalUnknown: { lots: 0, saleLines: 0 },
};
const DECIDED = '2030-09-01T00:00:00Z';
const ANSWER: MetalsSourceRosterAnswer = {
  acquisitionStart: '2030-01-01',
  sources: [
    { source: 'costco', bought: true, sold: false, accounts: 'all-imported' },
    { source: 'walmart', bought: true, sold: false, accounts: 'all-imported' },
    { source: 'collectpure', bought: false, sold: true, accounts: 'all-imported' },
  ],
  elsewhere: { places: 0 }, otherWays: false, exemptions: [],
};
const atAnswer = (accounts: typeof ACCOUNTS) => accounts.map(({ accountId, source, retired }) => ({ accountId, source, retired }));
const storedOf = (answer: MetalsSourceRosterAnswer = ANSWER, overrides: Partial<MetalsRosterAnswerStored> = {}): MetalsRosterAnswerStored => ({
  answer, decidedAt: DECIDED, exemptions: [], importedAccountsAtAnswer: atAnswer(ACCOUNTS), sourcesAtAnswer: [...METALS_SOURCES], ...overrides,
});
const withSource = (source: MetalsSource, change: Partial<MetalsSourceRosterAnswer['sources'][number]>, answer = ANSWER): MetalsSourceRosterAnswer =>
  ({ ...answer, sources: answer.sources.map((item) => (item.source === source ? { ...item, ...change } : item)) });

const captureRow = (overrides: Partial<MetalsCardCaptureRow> = {}): MetalsCardCaptureRow => ({
  rowId: 'row-1', accountId: 'card-a', date: '2030-03-15', amountMinor: 25_000, merchantClass: 'walmart-online', group: 'walmart',
  scope: 'mixed-online', source: 'walmart', status: 'outside-coverage', reasons: ['outside-coverage'], explainedBy: null, ...overrides,
});
const mixedRow = (rowId: string, date: string, source: 'costco' | 'walmart' = 'walmart') =>
  captureRow({ rowId, date, group: source, source, merchantClass: source === 'costco' ? 'costco-online' : 'walmart-online' });
const explainedRow = (rowId: string, date: string) => captureRow({ rowId, date, status: 'explained', reasons: [], explainedBy: 'walmart-1#0' });
const dealerRow = (rowId: string, date: string, group = 'dealer:APMEX') =>
  captureRow({ rowId, date, group, merchantClass: 'bullion-dealer', scope: 'gold-only', source: null });
const processorRow = (rowId: string, date: string) => captureRow({
  rowId, date, group: 'unresolved:pm-technologies', merchantClass: null, scope: 'gold-only', source: null, status: 'held', reasons: ['alias-unresolved'],
});
const aliasRow = (rowId: string, date: string) =>
  captureRow({ rowId, date, group: 'alias:samplepure', merchantClass: null, scope: 'gold-only', source: 'collectpure' });
const captured = (rows: MetalsCardCaptureRow[]): MetalsCardCaptureResult => ({
  rule: 'metals-card-capture-v1', aliasPolicy: 'metals-capture-alias-v1', rows, credits: [],
  outOfScope: { warehouse: 0, samsClub: 0, store: 0, unclassed: 0 }, unchecked: [],
});

/** An answer with evidence-bound exemptions, each digest computed from the capture as the preview would show it. */
function answered(capture: MetalsCardCaptureResult, exemptions: Array<[MetalsBindingKey, MetalsRosterClaim]>, answer = ANSWER,
  accounts = ACCOUNTS): MetalsRosterAnswerStored {
  return storedOf({ ...answer, exemptions: exemptions.map(([key, claim]) => ({ key, claim })) }, {
    importedAccountsAtAnswer: atAnswer(accounts),
    exemptions: exemptions.map(([key, claim]) => {
      const evidence = metalsBindingEvidence(capture, key, atAnswer(accounts));
      return { key, claim, digest: metalsBindingDigest(evidence), rows: evidence.rows };
    }),
  });
}

type Proved = { proof: MetalsCoverageProof; catalog: MetalsCoverageCatalog };
const scopesOf = (proof: MetalsCoverageProof) =>
  [{ name: 'asOf', gaps: proof.asOfScope.gaps }, ...proof.sales.map((scope) => ({ name: `sales:${scope.metal}`, gaps: scope.gaps }))];
/** A card-row gap's count (its rows, its card-rows trigger's, or the roster's rows); null for any other gap. */
function cardCount(gap: MetalsCoverageGap): number | null {
  if (gap.variant === 'unsupported-dealer' || gap.variant === 'alias-unresolved' || gap.variant === 'unexplained-charges' || gap.variant === 'roster') {
    return gap.rows;
  }
  if (gap.variant === 'missing-account' || gap.variant === 'missing-kind') {
    const trigger = gap.triggers.find((candidate) => candidate.by === 'card-rows');
    return trigger !== undefined && trigger.by === 'card-rows' ? trigger.rows : 0;
  }
  return null;
}

/**
 * Control 30 (C6): every non-explained row cites at least one entry and every reference resolves; a financial entry is in
 * each scope it names, a diagnostic in none; each card-row gap's count equals the rows citing it; no outside-financial-need.
 */
function checkCatalog({ proof, catalog }: Proved, capture: MetalsCardCaptureResult | null): void {
  const entries = new Map(catalog.gaps.map((item) => [item.id, item]));
  const citing = (id: string) => [...catalog.rowGaps.values()].filter((ids) => ids.includes(id)).length;
  const open = capture === null ? [] : capture.rows.filter((row) => row.status !== 'explained');
  assert.deepEqual([...catalog.rowGaps.keys()].sort(), open.map((row) => row.rowId).sort());
  for (const [rowId, ids] of catalog.rowGaps) {
    assert.ok(ids.length > 0, `${rowId} cites an entry`);
    for (const id of ids) assert.ok(entries.has(id), `${rowId} cites ${id}, which resolves`);
  }
  for (const item of catalog.gaps) {
    assert.ok(item.reason === null || item.reason === 'before-acquisition-start' || item.reason === 'exempted', item.id);
    assert.ok(citing(item.id) > 0, `${item.id} is cited`);
    if (item.kind === 'diagnostic') {
      assert.deepEqual(item.scopes, [], item.id);
      assert.ok(item.id === 'diag|before-acquisition-start' || item.id === 'diag|exempted', item.id);
      continue;
    }
    assert.equal(item.reason, null, item.id);
    for (const name of item.scopes) {
      assert.ok(scopesOf(proof).find((scope) => scope.name === name)?.gaps.some((gap) => gap.id === item.id), `${item.id} is in ${name}`);
    }
  }
  for (const scope of scopesOf(proof)) {
    for (const gap of scope.gaps) {
      const count = cardCount(gap);
      if (count === null) continue;
      assert.equal(citing(gap.id), count, `${scope.name}: ${gap.id} is cited by exactly its rows`);
      if (count > 0) assert.ok(entries.get(gap.id)?.scopes.includes(scope.name), `${gap.id} names ${scope.name}`);
    }
  }
}

function proofOf(overrides: Partial<MetalsCoverageProofInput> = {}): Proved {
  const input: MetalsCoverageProofInput = {
    snapshot: 'snap-1', asOf: '2030-09-30', today: '2030-09-30', sources: METALS_SOURCES, importedAccounts: ACCOUNTS, coverage: COVERAGE,
    records: RECORDS, capture: captured([]), roster: { installed: true, asking: false, stored: storedOf() },
    cardHistory: [{ accountId: 'card-a', covered: [{ from: '2029-01-01', to: '2030-12-31' }] }], ...overrides,
  };
  const result = metalsCoverageProof(input);
  checkCatalog(result, input.capture);
  return result;
}
const rosterWith = (stored: MetalsRosterAnswerStored | null, installed = true) => ({ roster: { installed, asking: false, stored } });
const idsOf = (gaps: readonly MetalsCoverageGap[]) => gaps.map((gap) => gap.id);
const gapOf = (gaps: readonly MetalsCoverageGap[], id: string) => gaps.find((gap) => gap.id === id);
const SIX = ['card-check-only', 'non-card-funding', 'stored-value-only', 'warehouse-and-store', 'cards-not-in-holdr', 'undiscovered-dealers'];

describe('coverage proof: a complete, current world', () => {
  it('every scope with a need is complete, both totals are complete, and only the six standing limits are listed', () => {
    const { proof, catalog } = proofOf();
    assert.equal(proof.rule, METALS_COVERAGE_PROOF_RULE);
    assert.equal(METALS_COVERAGE_PROOF_RULE, API_PROOF_RULE);
    assert.deepEqual([proof.rule, proof.snapshot, proof.asOf], ['metals-coverage-proof-v1', 'snap-1', '2030-09-30']);
    assert.deepEqual(proof.roster, {
      state: 'current', asking: false, decidedAt: DECIDED, acquisitionStart: '2030-01-01', problems: [], bindings: [],
    });
    const asOfNeed = { buy: { from: '2030-01-01', to: '2030-09-30' }, sell: { from: '2030-01-01', to: '2030-09-30' } };
    assert.deepEqual(proof.asOfScope, { state: 'complete', need: asOfNeed, gaps: [] });
    assert.deepEqual(proof.sales, [
      { metal: 'XAG', state: 'no-sales', need: null, gaps: [] },
      { metal: 'XAU', state: 'complete', need: { buy: { from: '2030-01-01', to: '2030-06-01' }, sell: asOfNeed.sell }, gaps: [] },
    ]);
    assert.deepEqual(proof.totals, {
      realized: { metals: ['XAU'], state: 'complete' }, estimate: { metals: ['XAG', 'XAU'], state: 'complete' }, metalUnknown: { lots: 0, saleLines: 0 },
    });
    assert.deepEqual(proof.limits, SIX);
    assert.deepEqual(catalog, { gaps: [], rowGaps: new Map(), cardHistory: [] });
  });

  it('the basis inside the proof: CollectPure sell orders are whole history; payouts are never needed', () => {
    // Only the reviewed basis reaches back before the entry's first day; a bare version is a window.
    const bare = proofOf({ coverage: [COSTCO_ONLINE, COSTCO_WAREHOUSE, WALMART_ONLINE, { ...CP_SELL_ORDERS, converterVersion: '1.0.0' }] });
    assert.deepEqual(gapOf(bare.proof.asOfScope.gaps, 'acct-cp|sell-orders'), {
      id: 'acct-cp|sell-orders', variant: 'imported-window', account: ref('acct-cp'), kind: 'sell-orders', need: { from: '2030-01-01', to: '2030-09-30' },
      covered: [{ from: '2030-05-01', to: '2030-09-30' }], missing: [{ from: '2030-01-01', to: '2030-04-30' }],
    });
    assert.ok(!idsOf(proofOf().proof.asOfScope.gaps).includes('acct-cp|payouts'));
  });
});

describe('coverage proof: control 7 (canonical gaps, nothing fabricated)', () => {
  it('an imported account plus a missing second membership', () => {
    const { proof } = proofOf(rosterWith(storedOf(withSource('costco', { accounts: { notImported: 1 } }))));
    const gap = {
      id: 'missing-account|costco', variant: 'missing-account', source: 'costco', imported: 1, missing: 1,
      triggers: [{ by: 'roster', decidedAt: DECIDED }, { by: 'admitted-records', records: 1 }], exemption: 'none',
    };
    assert.deepEqual(proof.asOfScope.gaps, [gap]);
    assert.deepEqual(proof.sales[1].gaps, [gap]);
    assert.equal(proof.roster.state, 'current');
  });

  it('no account imported: a source-level gap, never a fabricated account or window', () => {
    const accounts = ACCOUNTS.filter((account) => account.source !== 'walmart');
    const { proof } = proofOf({
      importedAccounts: accounts, ...rosterWith(storedOf(withSource('walmart', { accounts: { notImported: 1 } }), { importedAccountsAtAnswer: atAnswer(accounts) })),
    });
    assert.deepEqual(proof.asOfScope.gaps, [{
      id: 'missing-account|walmart', variant: 'missing-account', source: 'walmart', imported: 0, missing: 1,
      triggers: [{ by: 'roster', decidedAt: DECIDED }, { by: 'admitted-records', records: 1 }], exemption: 'none',
    }]);
  });

  it('a retired account still needs its windows and never counts as imported (both refuse more; reads refuse a retirement today)', () => {
    const retired = ACCOUNTS.map((account) => (account.source === 'walmart' ? { ...account, retired: true } : account));
    const { proof } = proofOf({
      importedAccounts: retired,
      coverage: COVERAGE.map((item) => (item.accountId === 'acct-walmart' ? { ...item, from: '2030-02-01' } : item)),
      ...rosterWith(storedOf(ANSWER, { importedAccountsAtAnswer: atAnswer(retired) })),
    });
    const ids = idsOf(proof.asOfScope.gaps);
    assert.ok(ids.includes('acct-walmart|online'), 'its window gap stays');
    assert.ok(ids.includes('missing-account|walmart'), 'it never counts as imported');
  });

  it('an unsupported dealer: its rows on or after acquisitionStart enter every scope with a need', () => {
    const capture = captured([dealerRow('d-1', '2030-03-15')]);
    const { proof, catalog } = proofOf({ capture });
    const gap = { id: 'dealer|dealer:APMEX', variant: 'unsupported-dealer', group: 'dealer:APMEX', label: 'APMEX', rows: 1, exemption: 'none' };
    assert.deepEqual(proof.asOfScope.gaps, [gap]);
    assert.deepEqual(proof.sales[1].gaps, [gap]);
    assert.deepEqual(catalog.gaps, [{ id: 'dealer|dealer:APMEX', kind: 'financial', scopes: ['asOf', 'sales:XAU'], reason: null }]);
    assert.deepEqual(catalog.rowGaps, new Map([['d-1', ['dealer|dealer:APMEX']]]));
  });

  it('sell-only coverage: payouts never stand in for sell orders, and a sell-only source bought at lacks a kind', () => {
    const payouts = entry('acct-cp', 'collectpure', 'payouts', '2029-01-01', '2030-09-30', { captureSchema: METALS_CAPTURE_SCHEMAS.collectpure });
    const { proof } = proofOf({ coverage: [COSTCO_ONLINE, COSTCO_WAREHOUSE, WALMART_ONLINE, payouts] });
    assert.deepEqual(proof.asOfScope.gaps, [{
      id: 'acct-cp|sell-orders', variant: 'imported-window', account: ref('acct-cp'), kind: 'sell-orders', need: { from: '2030-01-01', to: '2030-09-30' },
      covered: [], missing: [{ from: '2030-01-01', to: '2030-09-30' }],
    }]);
    const bought = proofOf(rosterWith(storedOf(withSource('collectpure', { bought: true }))));
    assert.deepEqual(bought.proof.asOfScope.gaps, [{
      id: 'missing-kind|collectpure|buy', variant: 'missing-kind', source: 'collectpure', side: 'buy', accounts: [ref('acct-cp')],
      triggers: [{ by: 'roster', decidedAt: DECIDED }], exemption: 'none',
    }]);
  });

  it('the capture window\'s left edge: a window starting after acquisitionStart keeps the days between', () => {
    const late = { ...COSTCO_ONLINE, from: '2030-02-01' };
    const { proof } = proofOf({ coverage: [late, COSTCO_WAREHOUSE, WALMART_ONLINE, CP_SELL_ORDERS] });
    assert.deepEqual(proof.asOfScope.gaps, [{
      id: 'acct-costco|online', variant: 'imported-window', account: ref('acct-costco'), kind: 'online', need: { from: '2030-01-01', to: '2030-09-30' },
      covered: [{ from: '2030-02-01', to: '2030-09-30' }], missing: [{ from: '2030-01-01', to: '2030-01-31' }],
    }]);
    assert.deepEqual(proof.sales[1].gaps, [{
      id: 'acct-costco|online', variant: 'imported-window', account: ref('acct-costco'), kind: 'online', need: { from: '2030-01-01', to: '2030-06-01' },
      covered: [{ from: '2030-02-01', to: '2030-06-01' }], missing: [{ from: '2030-01-01', to: '2030-01-31' }],
    }]);
  });
});

describe('coverage proof: control 8 (a matched card inventory certifies nothing beyond itself)', () => {
  it('every card row explained, beside a warehouse gap: gate (b) stays incomplete, with the standing limits', () => {
    const capture = captured([explainedRow('row-1', '2030-03-15'), explainedRow('row-2', '2030-04-15')]);
    const { proof, catalog } = proofOf({ capture, coverage: [COSTCO_ONLINE, WALMART_ONLINE, CP_SELL_ORDERS] });
    assert.deepEqual(idsOf(proof.asOfScope.gaps), ['acct-costco|warehouse']);
    assert.deepEqual([proof.asOfScope.state, proof.totals.estimate.state, proof.totals.realized.state], ['incomplete', 'incomplete', 'incomplete']);
    assert.ok(proof.limits.includes('stored-value-only') && proof.limits.includes('warehouse-and-store') && proof.limits.includes('non-card-funding'));
    assert.equal(catalog.rowGaps.size, 0);
  });
});

describe('coverage proof: control 12 (a stale exemption), control 22 (an answer never stales its own binding), ABA', () => {
  const first = captured([dealerRow('d-1', '2030-03-15')]);
  const stored = answered(first, [['group:dealer:APMEX', 'no-metal-purchases']]);

  it('a current no-metal-purchases group answer removes the dealer\'s card-row trigger; its rows cite exempted', () => {
    const { proof, catalog } = proofOf({ capture: first, ...rosterWith(stored) });
    assert.equal(proof.roster.state, 'current');
    assert.deepEqual(proof.roster.bindings, [{ key: 'group:dealer:APMEX', claim: 'no-metal-purchases', rows: 1, state: 'current' }]);
    assert.deepEqual([proof.asOfScope.state, proof.asOfScope.gaps], ['complete', []]);
    assert.deepEqual(catalog.gaps, [{ id: 'diag|exempted', kind: 'diagnostic', scopes: [], reason: 'exempted' }]);
    assert.deepEqual(catalog.rowGaps, new Map([['d-1', ['diag|exempted']]]));
  });

  it('another row in that group stales the binding: the gap returns marked stale, and the roster reads stale', () => {
    const second = captured([dealerRow('d-1', '2030-03-15'), dealerRow('d-2', '2030-04-15')]);
    const { proof, catalog } = proofOf({ capture: second, ...rosterWith(stored) });
    assert.deepEqual([proof.roster.state, proof.roster.problems], ['stale', ['evidence-changed']]);
    assert.deepEqual(proof.roster.bindings, [{ key: 'group:dealer:APMEX', claim: 'no-metal-purchases', rows: 2, state: 'stale' }]);
    assert.deepEqual(proof.asOfScope.gaps, [
      { id: 'dealer|dealer:APMEX', variant: 'unsupported-dealer', group: 'dealer:APMEX', label: 'APMEX', rows: 2, exemption: 'stale' },
      { id: 'roster', variant: 'roster', state: 'stale', problems: ['evidence-changed'], rows: 0 },
    ]);
    assert.deepEqual(catalog.rowGaps, new Map([['d-1', ['dealer|dealer:APMEX']], ['d-2', ['dealer|dealer:APMEX']]]));
    // ABA: once the evidence returns to what was answered, the binding is current again.
    assert.equal(proofOf({ capture: first, ...rosterWith(stored) }).proof.roster.state, 'current');
  });

  it('a digest from another domain or format version never matches: the binding reads stale (ROOT, O123 acceptance)', () => {
    const evidence = metalsBindingEvidence(first, 'group:dealer:APMEX', atAnswer(ACCOUNTS));
    const preimage = JSON.parse(evidence.canonical) as unknown[];
    assert.deepEqual(preimage.slice(0, 2), ['holdr.metals-binding-evidence', 1]);
    const altered = (index: number, value: unknown) =>
      metalsBindingDigest({ canonical: JSON.stringify(preimage.map((part, at) => (at === index ? value : part))) });
    assert.equal(altered(1, 1), metalsBindingDigest(evidence), 'the unaltered preimage gives the real digest');
    for (const digest of [altered(0, 'holdr.metals-roster-preview'), altered(1, 2)]) {
      assert.notEqual(digest, metalsBindingDigest(evidence));
      const forged: MetalsRosterAnswerStored = { ...stored, exemptions: stored.exemptions.map((exemption) => ({ ...exemption, digest })) };
      const { proof } = proofOf({ capture: first, ...rosterWith(forged) });
      assert.deepEqual([proof.roster.state, proof.roster.problems, proof.roster.bindings.map((binding) => binding.state)],
        ['stale', ['evidence-changed'], ['stale']]);
    }
  });

  it('answering, then reading the same evidence: every binding stays current', () => {
    const capture = captured([dealerRow('d-1', '2030-03-15'), mixedRow('w-1', '2030-03-20'), processorRow('p-1', '2030-05-01')]);
    const bindings: Array<[MetalsBindingKey, MetalsRosterClaim]> = [
      ['group:dealer:APMEX', 'no-metal-purchases'], ['source:walmart', 'accounts-complete'], ['group:unresolved:pm-technologies', 'no-metal-purchases'],
    ];
    const { proof, catalog } = proofOf({ capture, ...rosterWith(answered(capture, bindings)) });
    assert.deepEqual(proof.roster.bindings.map((binding) => binding.state), ['current', 'current', 'current']);
    assert.deepEqual([proof.roster.state, proof.asOfScope.state, proof.totals.realized.state], ['current', 'complete', 'complete']);
    assert.deepEqual([...catalog.rowGaps.values()], [['diag|exempted'], ['diag|exempted'], ['diag|exempted']]);
  });
});

describe('coverage proof: control 14 (R6: no invented window)', () => {
  it('a dealer charge long after the last sale, or after asOf, still enters the sales scope; nothing waives it', () => {
    const capture = captured([dealerRow('d-late', '2030-08-15'), dealerRow('d-after', '2030-10-15')]);
    const { proof } = proofOf({ capture });
    assert.deepEqual(gapOf(proof.sales[1].gaps, 'dealer|dealer:APMEX'),
      { id: 'dealer|dealer:APMEX', variant: 'unsupported-dealer', group: 'dealer:APMEX', label: 'APMEX', rows: 2, exemption: 'none' });
    assert.deepEqual([proof.sales[1].state, proof.totals.realized.state], ['incomplete', 'incomplete']);
  });
});

describe('coverage proof: control 15 (an alias source with no imported account)', () => {
  const accounts = ACCOUNTS.filter((account) => account.source !== 'collectpure');
  const records: MetalsCoverageProofInput['records'] = { ...RECORDS, sales: [] };
  const capture = captured([aliasRow('a-1', '2030-03-15')]);

  it('source-level missing-account and missing-kind from card rows, with no fabricated account', () => {
    const { proof, catalog } = proofOf({ importedAccounts: accounts, records, capture, ...rosterWith(null) });
    assert.deepEqual(gapOf(proof.asOfScope.gaps, 'missing-account|collectpure'), {
      id: 'missing-account|collectpure', variant: 'missing-account', source: 'collectpure', imported: 0, missing: null,
      triggers: [{ by: 'card-rows', rows: 1 }], exemption: 'none',
    });
    assert.deepEqual(gapOf(proof.asOfScope.gaps, 'missing-kind|collectpure|buy'), {
      id: 'missing-kind|collectpure|buy', variant: 'missing-kind', source: 'collectpure', side: 'buy', accounts: [],
      triggers: [{ by: 'card-rows', rows: 1 }], exemption: 'none',
    });
    assert.ok(!idsOf(proof.asOfScope.gaps).some((id) => id.startsWith('acct-cp')));
    assert.deepEqual(catalog.rowGaps.get('a-1'), ['missing-account|collectpure', 'missing-kind|collectpure|buy']);
  });

  it('an all-imported answer for a source with no imported account reads contradicted', () => {
    const stored = storedOf(ANSWER, { importedAccountsAtAnswer: atAnswer(accounts) });
    const { proof } = proofOf({ importedAccounts: accounts, records, capture, ...rosterWith(stored) });
    assert.deepEqual([proof.roster.state, proof.roster.problems], ['contradicted', ['all-imported-but-none']]);
    assert.deepEqual(gapOf(proof.asOfScope.gaps, 'missing-account|collectpure'), {
      id: 'missing-account|collectpure', variant: 'missing-account', source: 'collectpure', imported: 0, missing: null,
      triggers: [{ by: 'roster', decidedAt: DECIDED }, { by: 'card-rows', rows: 1 }], exemption: 'none',
    });
  });
});

describe('coverage proof: control 16 (declarations contradicting admitted evidence)', () => {
  const contradicted = (stored: MetalsRosterAnswerStored, problems: string[]) => {
    const { proof } = proofOf(rosterWith(stored));
    assert.deepEqual([proof.roster.state, proof.roster.problems], ['contradicted', problems]);
    assert.deepEqual(gapOf(proof.asOfScope.gaps, 'roster'), { id: 'roster', variant: 'roster', state: 'contradicted', problems, rows: 0 });
    assert.deepEqual([proof.asOfScope.state, proof.totals.estimate.state, proof.totals.realized.state], ['incomplete', 'incomplete', 'incomplete']);
  };

  it('a source answered unused for buys or sales where admitted records show them', () => {
    contradicted(storedOf(withSource('walmart', { bought: false, accounts: null })), ['unused-source-has-buys']);
    contradicted(storedOf(withSource('collectpure', { sold: false, accounts: null })), ['unused-source-has-sales']);
  });

  it('an acquisitionStart after an admitted record', () => {
    contradicted(storedOf({ ...ANSWER, acquisitionStart: '2030-04-01' }), ['start-after-admitted-record']);
  });
});

describe('coverage proof: control 17 (no empty conjunction)', () => {
  it('only unsold holdings with incomplete history: no-sales is never complete, and the estimate names the unsold metal', () => {
    const records: MetalsCoverageProofInput['records'] = {
      buys: [{ source: 'walmart', metal: 'XAG', date: '2030-04-01' }], sales: [], metalUnknown: { lots: 0, saleLines: 0 },
    };
    const { proof } = proofOf({ records, coverage: [COSTCO_ONLINE, COSTCO_WAREHOUSE, CP_SELL_ORDERS] });
    assert.deepEqual(idsOf(proof.asOfScope.gaps), ['acct-walmart|online']);
    assert.deepEqual(proof.sales, [{ metal: 'XAG', state: 'no-sales', need: null, gaps: [] }]);
    assert.deepEqual(proof.totals, {
      realized: { metals: [], state: 'no-sales' }, estimate: { metals: ['XAG'], state: 'incomplete' }, metalUnknown: { lots: 0, saleLines: 0 },
    });
  });

  it('serves the metal-unknown counts as recorded', () => {
    const records: MetalsCoverageProofInput['records'] = { ...RECORDS, buys: [...RECORDS.buys, { source: 'costco', metal: null, date: '2030-05-01' }],
      metalUnknown: { lots: 1, saleLines: 0 } };
    const { proof } = proofOf({ records });
    assert.deepEqual([proof.totals.metalUnknown, proof.totals.estimate.metals], [{ lots: 1, saleLines: 0 }, ['XAG', 'XAU']]);
  });
});

describe('coverage proof: control 20 (a dealer charge before acquisitionStart)', () => {
  const capture = captured([dealerRow('d-early', '2029-12-15')]);

  it('with no binding covering it, the roster reads contradicted, counts the row, and no scope is complete', () => {
    const { proof, catalog } = proofOf({ capture });
    assert.deepEqual([proof.roster.state, proof.roster.problems], ['contradicted', ['start-after-gold-row']]);
    assert.deepEqual(proof.asOfScope.gaps, [{ id: 'roster', variant: 'roster', state: 'contradicted', problems: ['start-after-gold-row'], rows: 1 }]);
    assert.deepEqual(catalog.gaps, [{ id: 'roster', kind: 'financial', scopes: ['asOf', 'sales:XAU'], reason: null }]);
    assert.deepEqual(catalog.rowGaps, new Map([['d-early', ['roster']]]));
    assert.ok([proof.asOfScope, ...proof.sales].every((scope) => scope.state !== 'complete'));
  });

  it('a current no-metal-purchases binding covering it keeps the roster current; the row is diagnostic', () => {
    const { proof, catalog } = proofOf({ capture, ...rosterWith(answered(capture, [['group:dealer:APMEX', 'no-metal-purchases']])) });
    assert.deepEqual([proof.roster.state, proof.asOfScope.state], ['current', 'complete']);
    assert.deepEqual(catalog.rowGaps, new Map([['d-early', ['diag|exempted']]]));
  });

  it('a mixed row before acquisitionStart is diagnostic and contradicts nothing', () => {
    const { proof, catalog } = proofOf({ capture: captured([mixedRow('w-early', '2029-12-20')]) });
    assert.deepEqual([proof.roster.state, proof.asOfScope.state], ['current', 'complete']);
    assert.deepEqual(catalog.gaps, [{ id: 'diag|before-acquisition-start', kind: 'diagnostic', scopes: [], reason: 'before-acquisition-start' }]);
    assert.deepEqual(catalog.rowGaps, new Map([['w-early', ['diag|before-acquisition-start']]]));
  });
});

describe('coverage proof: control 21 (a sale after the sell coverage)', () => {
  it('sell kinds run through asOf: the sales scope and realized stay incomplete past the last captured sale', () => {
    const { proof } = proofOf({ coverage: [COSTCO_ONLINE, COSTCO_WAREHOUSE, WALMART_ONLINE, { ...CP_SELL_ORDERS, to: '2030-07-31' }] });
    const gap = {
      id: 'acct-cp|sell-orders', variant: 'imported-window', account: ref('acct-cp'), kind: 'sell-orders', need: { from: '2030-01-01', to: '2030-09-30' },
      covered: [{ from: '2030-01-01', to: '2030-07-31' }], missing: [{ from: '2030-08-01', to: '2030-09-30' }],
    };
    assert.deepEqual(proof.sales[1].gaps, [gap]);
    assert.deepEqual([proof.sales[1].state, proof.totals.realized.state], ['incomplete', 'incomplete']);
  });
});

describe('coverage proof: every roster state and problem (§7.5)', () => {
  const unproven = ['acct-costco|online', 'acct-costco|warehouse', 'acct-walmart|online', 'prefix', 'roster'];

  it('not installed: every scope with a need is incomplete, with at least roster and prefix; a stored answer is ignored', () => {
    for (const stored of [null, storedOf()]) {
      const { proof } = proofOf(rosterWith(stored, false));
      assert.deepEqual(proof.roster, { state: 'not-installed', asking: false, decidedAt: null, acquisitionStart: null, problems: [], bindings: [] });
      assert.deepEqual(idsOf(proof.asOfScope.gaps), unproven);
      assert.deepEqual(gapOf(proof.asOfScope.gaps, 'roster'), { id: 'roster', variant: 'roster', state: 'not-installed', problems: [], rows: 0 });
      assert.deepEqual(gapOf(proof.asOfScope.gaps, 'acct-costco|online'), {
        id: 'acct-costco|online', variant: 'imported-window', account: ref('acct-costco'), kind: 'online', need: { from: null, to: '2030-09-30' },
        covered: [{ from: '2029-01-01', to: '2030-09-30' }], missing: [{ from: null, to: '2028-12-31' }],
      });
    }
  });

  it('unanswered, and asking passed through', () => {
    const { proof } = proofOf({ roster: { installed: true, asking: true, stored: null } });
    assert.deepEqual([proof.roster.state, proof.roster.asking], ['unanswered', true]);
    assert.deepEqual(idsOf(proof.asOfScope.gaps), unproven);
    assert.deepEqual(proof.asOfScope.need, { buy: { from: null, to: '2030-09-30' }, sell: { from: null, to: '2030-09-30' } });
  });

  it('stale: an account imported or retired since the answer, or the supported sources changed', () => {
    const stale = (overrides: Partial<MetalsCoverageProofInput>, problems: string[]) => {
      const { proof } = proofOf(overrides);
      assert.deepEqual([proof.roster.state, proof.roster.problems], ['stale', problems]);
      assert.deepEqual(gapOf(proof.asOfScope.gaps, 'roster'), { id: 'roster', variant: 'roster', state: 'stale', problems, rows: 0 });
    };
    stale(rosterWith(storedOf(ANSWER, { importedAccountsAtAnswer: atAnswer(ACCOUNTS.filter((account) => account.source !== 'costco')) })),
      ['accounts-changed']);
    stale(rosterWith(storedOf(ANSWER, { importedAccountsAtAnswer: atAnswer(ACCOUNTS).map((account) => ({ ...account, retired: account.source === 'costco' })) })),
      ['accounts-changed']);
    stale({ sources: ['costco', 'walmart'] }, ['sources-changed']);
  });

  it('answer-shape: any field outside its type reads contradicted, and its acquisitionStart counts for nothing', () => {
    const malformed: MetalsSourceRosterAnswer[] = [
      { ...ANSWER, acquisitionStart: '2030-01-02' }, { ...ANSWER, acquisitionStart: '2030-10-01' }, { ...ANSWER, acquisitionStart: '2030-02-30' },
      { ...ANSWER, elsewhere: { places: 100 } }, { ...ANSWER, elsewhere: { places: -1 } }, { ...ANSWER, elsewhere: { places: 1.5 } },
      withSource('costco', { accounts: { notImported: 0 } }), withSource('costco', { accounts: { notImported: 100 } }),
      { ...ANSWER, exemptions: [{ key: 'group:dealer:APMEX', claim: 'maybe' as unknown as MetalsRosterClaim }] },
      { ...ANSWER, sources: [...ANSWER.sources, { source: 'elsewhere' as unknown as MetalsSource, bought: false, sold: false, accounts: null }] },
    ];
    for (const answer of malformed) {
      const { proof } = proofOf(rosterWith(storedOf(answer)));
      assert.deepEqual([proof.roster.state, proof.roster.problems, proof.roster.acquisitionStart], ['contradicted', ['answer-shape'], null], JSON.stringify(answer));
      assert.ok(idsOf(proof.asOfScope.gaps).includes('prefix'));
    }
  });

  it('exemption-disagrees: a claim the answer can\'t make, a binding the preview didn\'t show, or one listed twice', () => {
    const capture = captured([]);
    const disagreeing: MetalsRosterAnswerStored[] = [
      storedOf({ ...ANSWER, exemptions: [{ key: 'group:dealer:APMEX', claim: 'no-metal-purchases' }] }),
      answered(capture, [['source:costco', 'no-metal-purchases']]),
      answered(capture, [['group:dealer:APMEX', 'accounts-complete']]),
      answered(capture, [['source:collectpure', 'accounts-complete']]),
      answered(capture, [['source:walmart', 'accounts-complete']], withSource('walmart', { accounts: { notImported: 1 } })),
      answered(capture, [['group:alias:samplepure', 'no-metal-purchases']]),
      answered(capture, [['group:dealer:APMEX', 'no-metal-purchases'], ['group:dealer:APMEX', 'no-metal-purchases']]),
    ];
    for (const stored of disagreeing) {
      const { proof } = proofOf({ capture, ...rosterWith(stored) });
      assert.deepEqual([proof.roster.state, proof.roster.problems], ['contradicted', ['exemption-disagrees']], JSON.stringify(stored.answer.exemptions));
    }
  });

  it('sources-incomplete: a source missing or repeated, or accounts present for an unused source or missing for a used one', () => {
    const records: MetalsCoverageProofInput['records'] = { ...RECORDS, buys: [{ source: 'walmart', metal: 'XAG', date: '2030-04-01' }] };
    const incomplete: MetalsSourceRosterAnswer[] = [
      { ...ANSWER, sources: ANSWER.sources.filter((item) => item.source !== 'costco') },
      { ...ANSWER, sources: [...ANSWER.sources, ANSWER.sources[0]] },
      withSource('walmart', { accounts: null }),
      withSource('costco', { bought: false, sold: false, accounts: 'all-imported' }),
    ];
    for (const answer of incomplete) {
      const { proof } = proofOf({ records, ...rosterWith(storedOf(answer)) });
      assert.deepEqual([proof.roster.state, proof.roster.problems], ['contradicted', ['sources-incomplete']], JSON.stringify(answer.sources));
    }
  });

  it('contradicted outranks stale, and every problem is listed in order', () => {
    const stored = storedOf(withSource('walmart', { bought: false, accounts: null }), { sourcesAtAnswer: [...METALS_SOURCES] });
    const { proof } = proofOf({ sources: ['costco', 'walmart'], ...rosterWith(stored) });
    assert.deepEqual([proof.roster.state, proof.roster.problems], ['contradicted', ['sources-changed', 'unused-source-has-buys']]);
  });
});

describe('coverage proof: gap variants and triggers', () => {
  it('missing-source and other-acquisition come from the answer and no answer removes them', () => {
    const { proof } = proofOf(rosterWith(storedOf({ ...ANSWER, elsewhere: { places: 2 }, otherWays: true })));
    assert.deepEqual(proof.asOfScope.gaps, [
      { id: 'missing-source|elsewhere', variant: 'missing-source', places: 2, decidedAt: DECIDED },
      { id: 'other-acquisition', variant: 'other-acquisition', decidedAt: DECIDED },
    ]);
    assert.equal(proof.roster.state, 'current');
  });

  it('an unresolved processor group, and its current no-metal-purchases exemption', () => {
    const capture = captured([processorRow('p-1', '2030-05-01')]);
    const gap = { id: 'alias|pm-technologies', variant: 'alias-unresolved', group: 'unresolved:pm-technologies', rows: 1, exemption: 'none' };
    assert.deepEqual(proofOf({ capture }).proof.asOfScope.gaps, [gap]);
    const exempted = proofOf({ capture, ...rosterWith(answered(capture, [['group:unresolved:pm-technologies', 'no-metal-purchases']])) });
    assert.deepEqual([exempted.proof.asOfScope.gaps, exempted.catalog.rowGaps.get('p-1')], [[], ['diag|exempted']]);
  });

  it('unexplained mixed charges yield to an exemption only in a scope where every imported window is complete (R3)', () => {
    const capture = captured([mixedRow('w-1', '2030-03-20')]);
    const plain = proofOf({ capture });
    assert.deepEqual(plain.proof.asOfScope.gaps, [
      { id: 'unexplained|walmart', variant: 'unexplained-charges', group: 'walmart', source: 'walmart', rows: 1, exemption: 'none' },
    ]);
    const shortWalmart = { ...WALMART_ONLINE, to: '2030-08-31' };
    const { proof, catalog } = proofOf({
      capture, coverage: [COSTCO_ONLINE, COSTCO_WAREHOUSE, shortWalmart, CP_SELL_ORDERS], ...rosterWith(answered(capture, [['source:walmart', 'accounts-complete']])),
    });
    assert.deepEqual(idsOf(proof.asOfScope.gaps), ['acct-walmart|online', 'unexplained|walmart']);
    assert.deepEqual([proof.sales[1].state, proof.sales[1].gaps], ['complete', []]);
    assert.deepEqual(catalog.gaps, [
      { id: 'diag|exempted', kind: 'diagnostic', scopes: [], reason: 'exempted' },
      { id: 'unexplained|walmart', kind: 'financial', scopes: ['asOf'], reason: null },
    ]);
    assert.deepEqual(catalog.rowGaps.get('w-1'), ['diag|exempted', 'unexplained|walmart']);
  });

  it('a stale source binding returns its unexplained gap marked stale', () => {
    const answeredFor = captured([mixedRow('w-1', '2030-03-20')]);
    const later = captured([mixedRow('w-1', '2030-03-20'), mixedRow('w-2', '2030-04-20')]);
    const { proof } = proofOf({ capture: later, ...rosterWith(answered(answeredFor, [['source:walmart', 'accounts-complete']])) });
    assert.deepEqual(gapOf(proof.asOfScope.gaps, 'unexplained|walmart'),
      { id: 'unexplained|walmart', variant: 'unexplained-charges', group: 'walmart', source: 'walmart', rows: 2, exemption: 'stale' });
  });

  it('missing-kind from the answer and from admitted records', () => {
    const records: MetalsCoverageProofInput['records'] = {
      ...RECORDS, sales: [...RECORDS.sales, { source: 'walmart', metal: 'XAG', agreedDay: '2030-05-01', included: false }],
    };
    const { proof } = proofOf({ records, ...rosterWith(storedOf(withSource('walmart', { sold: true }))) });
    assert.deepEqual(proof.asOfScope.gaps, [{
      id: 'missing-kind|walmart|sell', variant: 'missing-kind', source: 'walmart', side: 'sell', accounts: [ref('acct-walmart')],
      triggers: [{ by: 'roster', decidedAt: DECIDED }, { by: 'admitted-records', records: 1 }], exemption: 'none',
    }]);
  });

  it('a source\'s no-metal-purchases removes only its card-row triggers, never a gap the roster raised', () => {
    const alias = captured([aliasRow('a-1', '2030-06-15')]);
    assert.deepEqual(idsOf(proofOf({ capture: alias }).proof.asOfScope.gaps), ['missing-kind|collectpure|buy']);
    const exempted = proofOf({ capture: alias, ...rosterWith(answered(alias, [['source:collectpure', 'no-metal-purchases']])) });
    assert.deepEqual([exempted.proof.asOfScope.gaps, exempted.catalog.rowGaps.get('a-1')], [[], ['diag|exempted']]);

    const records: MetalsCoverageProofInput['records'] = { ...RECORDS, buys: [{ source: 'walmart', metal: 'XAG', date: '2030-04-01' }] };
    const costco = captured([mixedRow('c-1', '2030-04-10', 'costco')]);
    const unusedForBuys = withSource('costco', { bought: false, sold: true });
    const { proof, catalog } = proofOf({ records, capture: costco, ...rosterWith(answered(costco, [['source:costco', 'no-metal-purchases']], unusedForBuys)) });
    assert.equal(proof.roster.state, 'current');
    assert.deepEqual(proof.asOfScope.gaps, [{
      id: 'missing-kind|costco|sell', variant: 'missing-kind', source: 'costco', side: 'sell', accounts: [ref('acct-costco')],
      triggers: [{ by: 'roster', decidedAt: DECIDED }], exemption: 'none',
    }]);
    assert.deepEqual(catalog.rowGaps.get('c-1'), ['diag|exempted']);
  });
});

describe('coverage proof: the card check failed, and no sales', () => {
  it('every scope and every total is unavailable and carries card-check, a metal with no sales too (§8.2)', () => {
    const { proof, catalog } = proofOf({ capture: null });
    const unavailable = { state: 'unavailable', need: null, gaps: [{ id: 'card-check', variant: 'card-check-unavailable' }] };
    assert.deepEqual(proof.asOfScope, unavailable);
    assert.deepEqual(proof.sales, [{ metal: 'XAG', ...unavailable }, { metal: 'XAU', ...unavailable }]);
    assert.deepEqual(proof.totals, {
      realized: { metals: ['XAU'], state: 'unavailable' }, estimate: { metals: ['XAG', 'XAU'], state: 'unavailable' }, metalUnknown: { lots: 0, saleLines: 0 },
    });
    assert.deepEqual([catalog.gaps, catalog.rowGaps.size], [[], 0]);
    // With no sale at all, realized is unavailable too, never no-sales.
    assert.deepEqual(proofOf({ capture: null, records: { ...RECORDS, sales: [] } }).proof.totals.realized, { metals: [], state: 'unavailable' });
  });

  it('a stored binding can\'t be verified without the card check: it reads stale', () => {
    const capture = captured([dealerRow('d-1', '2030-03-15')]);
    const { proof } = proofOf({ capture: null, ...rosterWith(answered(capture, [['group:dealer:APMEX', 'no-metal-purchases']])) });
    assert.deepEqual([proof.roster.state, proof.roster.problems, proof.roster.bindings.map((binding) => binding.state)],
      ['stale', ['evidence-changed'], ['stale']]);
  });
});

describe('coverage proof: control 31 (C7: card history is a limit, never a gap)', () => {
  const cardHistory = [
    { accountId: 'card-b', covered: [] },
    { accountId: 'card-a', covered: [{ from: '2030-03-01', to: '2030-12-31' }] },
    { accountId: 'card-c', covered: [{ from: '2029-01-01', to: '2030-12-31' }] },
    { accountId: 'card-d', covered: [{ from: '2030-05-01', to: '2030-12-31' }, { from: '2029-01-01', to: '2030-03-31' }] },
  ];

  it('names each held card account\'s unsynced days, ascending and disjoint, and lists card-history', () => {
    const { proof, catalog } = proofOf({ cardHistory });
    assert.deepEqual(catalog.cardHistory, [
      { accountId: 'card-a', unsynced: [{ from: '2030-01-01', to: '2030-02-28' }] },
      { accountId: 'card-b', unsynced: [{ from: '2030-01-01', to: '2030-09-30' }] },
      { accountId: 'card-d', unsynced: [{ from: '2030-04-01', to: '2030-04-30' }] },
    ]);
    assert.deepEqual(proof.limits, [...SIX, 'card-history']);
    // No gap, scope, verdict or total changes.
    const without = proofOf({ cardHistory: [] });
    assert.deepEqual({ ...proof, limits: [] }, { ...without.proof, limits: [] });
    assert.deepEqual(without.proof.limits, SIX);
  });

  it('while acquisitionStart is unknown the need starts at the earliest admitted record, or at asOf with none', () => {
    const unanswered = proofOf({ cardHistory, ...rosterWith(null) });
    assert.deepEqual(unanswered.catalog.cardHistory, [
      { accountId: 'card-b', unsynced: [{ from: '2030-03-01', to: '2030-09-30' }] },
      { accountId: 'card-d', unsynced: [{ from: '2030-04-01', to: '2030-04-30' }] },
    ]);
    const empty = proofOf({ cardHistory, records: { buys: [], sales: [], metalUnknown: { lots: 0, saleLines: 0 } }, ...rosterWith(null) });
    assert.deepEqual(empty.catalog.cardHistory, [{ accountId: 'card-b', unsynced: [{ from: '2030-09-30', to: '2030-09-30' }] }]);
  });
});

describe('coverage proof: control 30 (C6: conservation; at least one citation per row; no outside-financial-need)', () => {
  it('cites every non-explained row from the trigger accounting alone', () => {
    const capture = captured([
      mixedRow('w-1', '2030-03-20'), mixedRow('w-2', '2029-12-20'), mixedRow('c-1', '2030-04-10', 'costco'), dealerRow('d-1', '2030-03-15'),
      dealerRow('d-2', '2029-11-01', 'merchant:SAMPLE BULLION'), processorRow('p-1', '2030-05-01'), aliasRow('a-1', '2030-06-15'),
      explainedRow('e-1', '2030-03-25'),
    ]);
    const { proof, catalog } = proofOf({ capture, ...rosterWith(answered(capture, [['group:unresolved:pm-technologies', 'no-metal-purchases']])) });
    assert.deepEqual([proof.roster.state, proof.roster.problems], ['contradicted', ['start-after-gold-row']]);
    assert.deepEqual(idsOf(proof.asOfScope.gaps),
      ['alias|pm-technologies', 'dealer|dealer:APMEX', 'missing-kind|collectpure|buy', 'roster', 'unexplained|costco', 'unexplained|walmart']);
    assert.deepEqual(catalog.rowGaps, new Map([
      ['w-1', ['unexplained|walmart']], ['w-2', ['diag|before-acquisition-start']], ['c-1', ['unexplained|costco']], ['d-1', ['dealer|dealer:APMEX']],
      ['d-2', ['roster']], ['p-1', ['alias|pm-technologies']], ['a-1', ['missing-kind|collectpure|buy']],
    ]));
    assert.ok(catalog.gaps.every((item) => (item.reason as string | null) !== 'outside-financial-need'));
  });
});
