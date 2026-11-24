// Test helpers: temporary folders, a fake Holdr API on 127.0.0.1 that answers the read routes with a synthetic household,
// and small MCP clients. Every listener binds 127.0.0.1 explicitly, and nothing here reaches the network. All names,
// numbers and amounts are invented.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MCP_DIR = path.resolve(TESTS_DIR, '..');
export const REPO_ROOT = path.resolve(MCP_DIR, '..', '..');
export const SERVER = path.join(MCP_DIR, 'server.mjs');
/** A synthetic agent token (holdr_agent_ and 64 hex characters), and a synthetic service token the server must refuse. */
export const TOKEN = `holdr_agent_${'ab'.repeat(32)}`;
export const SERVICE_TOKEN = 'cd'.repeat(32);
export const TODAY = '2026-11-24';
export const NOW = new Date(2026, 10, 24, 12, 0, 0);

/** A temporary folder removed after the test. */
export function tempDir(t, prefix = 'holdr-mcp-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A data folder holding a token file as Holdr makes one (`agent-token` unless `name` says otherwise). Returns the file. */
export function writeToken(dir, token = TOKEN, name = 'agent-token') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return file;
}

/**
 * A listener check (lib/listener.mjs, checkListener) that finds this account's program on every port, for tests that are
 * not about the check: the real one asks the operating system, which takes about a second on Windows.
 */
export const OWN_LISTENER = async () => ({ state: 'yours', pids: [process.pid] });

/** A port on 127.0.0.1 that nothing listens on (it was free a moment ago). */
export async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export const OPTION = 'SMPL261218C00200000';

/** The synthetic household the fake API serves. */
export function household() {
  const accounts = [
    { id: 'acct-brokerage', name: 'Sample Brokerage', type: 'Individual', cashBalance: 1000, currency: 'USD', accountNumber: 'Z12345678' },
    { id: 'acct-roth', name: 'Sample Roth IRA', type: 'Roth IRA', cashBalance: 250.5, currency: 'USD', accountNumber: 'R0004321' },
    { id: 'acct-hsa', name: 'Sample HSA 1234567890', type: 'HSA', cashBalance: 0, currency: 'USD' },
  ];
  const trade = (id, accountId, symbol, date, quantity, pricePerUnit, extra = {}) => ({ id, accountId, symbol, date, quantity, pricePerUnit, currency: 'USD', ...extra });
  const transactions = [
    trade('t1', 'acct-brokerage', 'VTI', '2026-01-05', 10, 200, { fees: 1, notes: 'Opening lot' }),
    trade('t2', 'acct-brokerage', 'VTI', '2026-03-05', 10, 220),
    trade('t3', 'acct-brokerage', 'VTI', '2026-06-01', -5, 250, { notes: 'Trim, confirmation 987654321' }),
    trade('t4', 'acct-brokerage', 'SMPL', '2025-12-01', 5, 150),
    trade('t5', 'acct-brokerage', 'BTC-USD', '2026-02-01', 0.1, 50000),
    trade('t6', 'acct-roth', 'QQQ', '2026-01-10', 4, 400),
    trade('t7', 'acct-roth', OPTION, '2026-07-01', 1, 5, { instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open' }),
  ];
  const cashEvents = [
    { id: 'c1', accountId: 'acct-roth', date: '2026-04-15', eventType: 'deposit', amount: 7000, currency: 'USD', broker: 'sample', accountLast4: '4321', description: 'CONTRIBUTION 2026', sourceFingerprint: 'f'.repeat(64), importedAt: '2026-04-16T00:00:00Z' },
    { id: 'c2', accountId: 'acct-brokerage', date: '2026-09-30', eventType: 'dividend', amount: 42.17, currency: 'USD', broker: 'sample', accountLast4: '5678', description: 'DIVIDEND VTI REF 55512345678', sourceFingerprint: 'e'.repeat(64), importedAt: '2026-10-01T00:00:00Z' },
  ];
  const quotes = {
    VTI: { symbol: 'VTI', price: 300, currency: 'USD', asOf: Date.UTC(2026, 10, 24, 20), source: 'nasdaq', freshness: 'eod', dayChangePercent: 0.5 },
    SMPL: { symbol: 'SMPL', price: 200, currency: 'USD', asOf: Date.UTC(2026, 10, 24, 20), source: 'nasdaq', freshness: 'eod' },
    'BTC-USD': { symbol: 'BTC-USD', price: 60000, currency: 'USD', asOf: Date.UTC(2026, 10, 24, 20), source: 'coingecko', freshness: 'live' },
    QQQ: { symbol: 'QQQ', price: 500, currency: 'USD', asOf: Date.UTC(2026, 10, 20, 20), source: 'cache', freshness: 'stale' },
    [OPTION]: { symbol: OPTION, price: 7, currency: 'USD', asOf: Date.UTC(2026, 10, 24, 20), source: 'cboe', freshness: 'delayed' },
  };
  const cardAccounts = [
    { id: 'card-amex', issuer: 'amex', owner: 'alex', nickname: 'Sample Platinum Card', last4: '1005', last5: '91005', currency: 'USD', status: 'active', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
    { id: 'card-chase', issuer: 'chase', owner: 'casey', nickname: 'Sample Everyday Visa', last4: '2002', currency: 'USD', status: 'active', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
    { id: 'card-old', issuer: 'citi', owner: 'joint', last4: '3003', currency: 'USD', status: 'closed', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
  ];
  return { accounts, transactions, cashEvents, quotes, cardAccounts, cardTransactions: cardRows(450) };
}

/** `count` synthetic card rows, newest first, as GET /card-transactions lists them. */
export function cardRows(count, { longDescriptions = false } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(Date.UTC(2026, 10, 24) - index * 86_400_000).toISOString().slice(0, 10);
    const refund = index % 10 === 9;
    return {
      id: `ctx-${String(index).padStart(4, '0')}`,
      cardAccountId: index % 2 === 0 ? 'card-amex' : 'card-chase',
      source: 'sample-csv',
      transactionDate: day,
      postedDate: day,
      status: index < 2 ? 'pending' : 'posted',
      amountMinor: refund ? -1250 : 1000 + index,
      currency: 'USD',
      kind: refund ? 'refund' : 'purchase',
      description: longDescriptions
        ? `SAMPLE MERCHANT ${index} ${'LONG DESCRIPTION '.repeat(6)}REF 4455667788`
        : index === 3 ? 'NORTHWIND MARKET #104 PHONE 8005550123' : `SAMPLE MERCHANT ${index}`,
      merchant: index === 3 ? 'Northwind Market' : undefined,
      merchantName: index === 3 ? 'Northwind Market' : `SAMPLE MERCHANT ${index}`,
      merchantKey: `sample merchant ${index}`,
      category: index === 5 ? 'Precious metals' : index % 3 === 0 ? 'Restaurant-Restaurant' : 'Merchandise & Supplies-Groceries',
      role: index === 5 ? 'excluded' : 'spending',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
  });
}

function spendingSummary() {
  const amounts = (spendingMinor, count) => ({ spendingMinor, chargesMinor: spendingMinor, creditsMinor: 0, count });
  return {
    totals: [{ currency: 'USD', spendingMinor: 123456, chargesMinor: 130000, creditsMinor: -6544, count: 87, paymentsMinor: -200000, paymentCount: 2, otherMinor: 0, otherCount: 0 }],
    pending: [{ currency: 'USD', count: 2, netMinor: 2001, chargesMinor: 2001, creditsMinor: 0 }],
    byMonth: [{ month: '2026-10', currency: 'USD', ...amounts(123456, 87) }],
    byMonthOwner: [],
    byCategory: [
      { category: 'Merchandise & Supplies-Groceries', currency: 'USD', ...amounts(60000, 40) },
      { category: 'Restaurant-Restaurant', currency: 'USD', ...amounts(30000, 20) },
      { category: 'Restaurant-Bar & Café', currency: 'USD', ...amounts(12000, 15) },
      { category: 'Uncategorized', currency: 'USD', ...amounts(21456, 12) },
    ],
    byMerchant: Array.from({ length: 25 }, (_, index) => ({ merchant: `Sample Merchant ${index}`, merchantKey: `sample merchant ${index}`, currency: 'USD', ...amounts(5000 - index * 100, 3) })),
    otherMerchants: [{ currency: 'USD', merchants: 12, ...amounts(4000, 14) }],
    byCard: [{ cardAccountId: 'card-amex', currency: 'USD', ...amounts(80000, 50) }, { cardAccountId: 'card-chase', currency: 'USD', ...amounts(43456, 37) }],
    byOwner: [{ owner: 'alex', currency: 'USD', ...amounts(80000, 50) }, { owner: 'casey', currency: 'USD', ...amounts(43456, 37) }],
    categories: ['Merchandise & Supplies-Groceries', 'Restaurant-Restaurant'],
    paymentsPossiblyPaidFrom: [],
    categoryBasis: { requested: 'enriched', effective: 'original' },
  };
}

function benefitsReport(year) {
  const period = (label, start, end, availableMinor, usedMinor, state = 'current') => ({
    start, end, label, state, active: true, availableMinor, usedMinor, source: usedMinor === null ? 'none' : 'derived', derivedMinor: usedMinor ?? 0, matches: [], mark: null, issuer: null,
  });
  const benefit = (id, name, cadenceLabel, current, year, extra = {}) => ({
    id, name, kind: 'credit', unit: 'usd', cadence: { every: 'month', basis: 'calendar' }, cadenceLabel, enrollment: true, tracking: 'statement-credit',
    verify: false, needsAnniversary: false, periods: [current], current, year, inTotals: true, ...extra,
  });
  const uber = benefit('uber-cash', 'Uber Cash', 'Monthly', { ...period('Nov 2026', '2026-11-01', '2026-11-30', 1500, 0), daysLeft: 7, remainingMinor: 1500, resetsSoon: true },
    { capturedMinor: 13500, availableMinor: 16500, unknownPeriods: 0 });
  const resy = benefit('resy', 'Resy dining credit', 'Quarterly', { ...period('Q4 2026', '2026-10-01', '2026-12-31', 10000, 4000), daysLeft: 38, remainingMinor: 6000, resetsSoon: false },
    { capturedMinor: 34000, availableMinor: 40000, unknownPeriods: 0 });
  const hotel = benefit('hotel', 'Hotel credit', 'Twice a year', { ...period('Jul–Dec 2026', '2026-07-01', '2026-12-31', 30000, 30000), daysLeft: 38, remainingMinor: 0, resetsSoon: false },
    { capturedMinor: 60000, availableMinor: 60000, unknownPeriods: 0 });
  const certificate = {
    ...benefit('night', 'Free night certificate', 'Yearly', { ...period('2026', '2026-01-01', '2026-12-31', 1, null), daysLeft: 38, remainingMinor: null, resetsSoon: false },
      { capturedMinor: 0, availableMinor: 1, unknownPeriods: 1 }),
    unit: 'count', noun: 'free night', tracking: 'manual', manualReason: 'certificate', inTotals: false,
  };
  return {
    catalogVersion: 'sample-1',
    year,
    today: TODAY,
    cards: [
      {
        cardAccountId: 'card-amex', issuer: 'amex', owner: 'alex', nickname: 'Sample Platinum Card', last4: '1005', last5: '91005', status: 'active',
        product: { id: 'amex-platinum', name: 'The Platinum Card', shortName: 'Platinum', annualFeeMinor: 69500, feeVerify: false, sourceUrl: 'https://example.com/platinum' },
        productSource: 'auto', productChoice: 'auto', anniversaryMonth: null, needsAnniversary: false,
        benefits: [uber, resy, hotel, certificate], issuerTrackers: [], totals: { capturedMinor: 107500, availableMinor: 116500, annualFeesMinor: 69500 },
      },
      {
        cardAccountId: 'card-chase', issuer: 'chase', owner: 'casey', nickname: 'Sample Everyday Visa', last4: '2002', last5: null, status: 'active',
        product: null, productSource: 'none', productChoice: 'auto', anniversaryMonth: null, needsAnniversary: false, benefits: [], issuerTrackers: [],
        totals: { capturedMinor: 0, availableMinor: 0, annualFeesMinor: 0 },
      },
    ],
    household: { capturedMinor: 107500, availableMinor: 116500, annualFeesMinor: 69500, byOwner: {} },
    resetsSoon: [{ cardAccountId: 'card-amex', benefitId: 'uber-cash', benefitName: 'Uber Cash', unit: 'usd', end: '2026-11-30', daysLeft: 7, remainingMinor: 1500, source: 'derived' }],
    products: [],
  };
}

function forecast() {
  const range = (lowerMinor, upperMinor) => ({ lowerMinor, upperMinor, basis: 'tested', coverage: { inside: 8, tested: 10 } });
  const series = (category, pointMinor) => ({
    category, method: 'seasonal-naive', tested: true, historyMonths: 14, thin: false, recentMedianMinor: pointMinor,
    months: ['2026-12', '2027-01', '2027-02'].map((month) => ({ month, pointMinor, range80: range(pointMinor - 10000, pointMinor + 10000), range95: range(pointMinor - 20000, pointMinor + 20000) })),
    backtest: { from: '2026-05', to: '2026-10', months: 6, origins: 6, forecasts: 18, maeMinor: 8000, biasMinor: 100, mase: 0.8, maseBenchmark: 'naive', mape: 7.25, mapeForecasts: 18, calibrationMonths: 6, calibrationForecasts: 18, coverage80: { inside: 8, tested: 10 }, coverage95: { inside: 9, tested: 10 } },
    candidates: [],
  });
  return {
    currency: 'USD', today: TODAY, month: '2026-11',
    months: Array.from({ length: 12 }, (_, index) => {
      const month = `2026-${String(index + 1).padStart(2, '0')}`;
      return { month, spendingMinor: 300000 + index * 1000, oneOffsMinor: index === 10 ? 50000 : 0, everydayMinor: 300000 + index * 1000 - (index === 10 ? 50000 : 0), complete: index < 10, inProgress: index === 10 };
    }).slice(0, 11),
    fit: { from: '2025-10', to: '2026-10', completeMonths: 13, partialMonths: 0, oneOffPurchases: 2, oneOffPurchasesMinor: 150000, oneOffRefundsMinor: 0, oneOffsMinor: 150000 },
    oneOffThresholdMinor: 75000,
    horizon: ['2026-12', '2027-01', '2027-02'],
    total: series(null, 310000),
    categories: Array.from({ length: 12 }, (_, index) => series(`Sample Category ${index}`, 30000 - index * 1000)),
    pace: {
      month: '2026-11', daysElapsed: 24, daysInMonth: 30, spentMinor: 250000, everydaySpentMinor: 240000, oneOffsMinor: 10000, pendingMinor: 2001,
      monthSoFarComplete: true, historyMonths: 13, from: '2025-10', to: '2026-10', restMinor: 70000, typicalMinor: 305000,
      everydayProjectedMinor: 310000, everydayRange80: { lowerMinor: 290000, upperMinor: 330000, coverage: { inside: 8, tested: 10 } },
      projectedMinor: 320000, projectedRange80: { lowerMinor: 300000, upperMinor: 340000, coverage: { inside: 8, tested: 10 } },
    },
    coverage: { firstMonth: '2025-08', gaps: { cards: [] } },
    basis: 'enriched',
  };
}

function patterns() {
  return {
    currency: 'USD', today: TODAY, month: '2026-11',
    anomalies: [{ category: 'Sample Category 1', window: 'month', month: '2026-10', amountMinor: 90000, medianMinor: 30000, sigmaMinor: 5000, sigmaBasis: 'mad', direction: 'high', z: 12, historyMonths: 12, from: '2025-10', to: '2026-09', thin: false }],
    checks: [],
    bills: {
      from: TODAY, to: '2027-01-23', count: 2, totalMinor: 21500,
      items: [
        { date: '2026-11-28', key: 'sample streaming', merchant: 'Sample Streaming', cadence: 'monthly', fixed: true, amountMinor: 1500, expectedBeforeToday: false, late: false, evidence: { occurrences: 12, from: '2025-11', to: '2026-10' }, cardAccountIds: ['card-amex'] },
        { date: '2026-12-02', key: 'sample power', merchant: 'Sample Power & Light', cadence: 'monthly', fixed: false, amountMinor: 20000, expectedBeforeToday: false, late: false, evidence: { occurrences: 12, from: '2025-11', to: '2026-10' }, cardAccountIds: ['card-chase'] },
      ],
      thisMonth: { through: '2026-11-30', dueMinor: 1500, dueCount: 1, chargedMinor: 20000, chargedCount: 1 },
      activeCharges: 2,
    },
  };
}

const measure = (value, state = 'complete', reasons = []) => ({ value, state, reasons });
const troy = (display) => ({ exact: 'n/d', display });

function metalsOverview(metal) {
  const gold = metal === 'XAU';
  return {
    installed: true, metal, metals: [{ metal: 'XAU', lots: 3, sales: 1 }, { metal: 'XAG', lots: 2, sales: 0 }], asOf: TODAY,
    price: { source: 'cnbc', closeDate: '2026-11-21', close: gold ? '2650.4' : '31.25', stale: false, thinHistory: false, levelShift: null, fetching: true },
    holdings: {
      troyOz: measure(troy(gold ? '3.000' : '100.000')),
      costMinor: measure(gold ? 600000 : 250000),
      valueMinor: measure(gold ? 795120 : 312500, gold ? 'complete' : 'partial', gold ? [] : [{ code: 'price-stale', records: 1 }]),
      gainMinor: measure(gold ? 195120 : 62500),
      units: { delivered: gold ? 3 : 100, awaiting: 0, sold: 0, soldFromDelivered: 0, soldFromAwaiting: 0, unmatched: 0, held: gold ? 3 : 100, awaitingUnassigned: 0 },
      awaitingTroyOz: measure(troy('0.000')),
      awaitingUnassignedTroyOz: measure(troy('0.000')),
      contentUnknown: { lots: 0, units: 0, costMinor: 0, sales: 0, saleNetMinor: 0 },
      classes: [{ key: `${metal}|coin|1`, form: 'coin', fineTroyOzPerUnit: troy('1.000'), units: { held: gold ? 3 : 100 }, troyOz: measure(troy(gold ? '3.000' : '100.000')), costMinor: measure(gold ? 600000 : 250000), valueMinor: measure(gold ? 795120 : 312500), gainMinor: measure(gold ? 195120 : 62500), reconciliation: { balanced: true, soldWhileAwaiting: 0, unmatched: 0 } }],
      bySource: [{ accountId: 'm-1', source: 'costco', label: 'Sample warehouse membership', units: gold ? 3 : 100, troyOz: measure(troy(gold ? '3.000' : '100.000')), costMinor: measure(gold ? 600000 : 250000), valueMinor: measure(gold ? 795120 : 312500) }],
      storage: null,
    },
    metalUnknown: { lots: 0, units: 0, costMinor: 0, sales: 0, saleNetMinor: 0 },
    activity: {
      from: null, to: TODAY,
      bought: { lots: 3, units: 3, troyOz: measure(troy('3.000')), costMinor: measure(600000) },
      sold: { lines: 0, units: 0, troyOz: measure(troy('0.000')), grossMinor: measure(0), feesMinor: measure(0), netMinor: measure(0), unmatched: { units: 0, netMinor: 0, reasons: [] } },
      profit: { valueMinor: measure(0), coverage: { basis: 'sale-lines', known: 0, total: 0, unknownContentLines: 0 } },
      payouts: { count: 0, amountMinor: measure(0), mixedMetal: { count: 0, amountMinor: measure(0) } },
    },
    toCheck: { records: 1, needsYou: [{ code: 'confirm-content', products: 1 }], forInformation: [] },
    needsAnswer: { orders: 0, lines: [] },
    coverage: [],
    coverageProof: { status: 'unavailable' },
  };
}

function metalsPurchases(metal) {
  const lot = (key, orderDate, title, units) => ({
    key, orderKey: `order-${key}`, account: { accountId: 'm-1', source: 'costco', label: 'Sample warehouse membership' }, channel: 'online',
    orderDate, dateUnknown: false, title, productRef: 'costco:sample1', form: 'coin', seller: null, quantity: units,
    units: { ordered: units, cancelled: 0, returned: 0, delivered: units, awaiting: 0 }, delivery: { state: 'delivered', date: orderDate },
    costMinor: measure(200000 * units), merchandiseMinor: measure(199000 * units),
    content: { known: true, troyOzPerUnit: troy('1.000'), troyOz: troy(`${units}.000`), basis: 'stated' },
    premiumPaidPerOzMinor: 4500, purchaseSpot: { closeDate: orderDate }, funding: [{ kind: 'card', network: 'visa', amountMinor: 200000 }],
    cardEvidence: 'admitted', cards: [{ evidenceClass: 'a', amountMinor: 200000, state: 'linked', proof: true, row: { id: 'ctx-1', date: orderDate, account: { id: 'card-amex', name: 'Card', ending: '91005' } } }],
    refunds: [], sales: [], quarantined: false,
  });
  return {
    installed: true, metal, from: null, to: TODAY,
    purchases: metal === 'XAU'
      ? [lot('g1', '2025-03-01', 'Sample 1 oz Gold Coin', 1), lot('g2', '2026-02-01', 'Sample 1 oz Gold Coin, order 123456789', 2)]
      : [lot('s1', '2025-05-01', 'Sample Silver Round', 100)],
  };
}

/**
 * A fake Holdr API answering the read routes, behind `Authorization: Bearer <token>`. `state.status` forces an answer
 * status for every route; `state.routes` overrides single routes (`(query) => body`, or `{ status, body }`); `state.delay`
 * delays every answer. `requests` records each request.
 */
export async function startFakeHoldr(t, { token = TOKEN, data = household(), schemaVersion = 17 } = {}) {
  const state = { status: null, routes: {}, delay: 0, data, schemaVersion, benefitsYear: null };
  const requests = [];
  const pageOf = (rows, query) => {
    const limit = Number(query.limit ?? 50);
    const offset = Number(query.offset ?? 0);
    const page = rows.slice(offset, offset + limit);
    return { transactions: page, total: rows.length, limit, offset, nextOffset: offset + page.length < rows.length ? offset + page.length : null };
  };
  const routes = {
    '/health': () => ({ ok: true, service: 'holdr-api', db: 'sqlite', schemaVersion: state.schemaVersion, accounts: state.data.accounts.length, transactions: state.data.transactions.length, snapshots: { enabled: false, count: 0, latest: null } }),
    '/accounts': () => ({ accounts: state.data.accounts }),
    '/transactions': () => ({ transactions: state.data.transactions }),
    '/cash-events': () => ({ cashEvents: state.data.cashEvents }),
    '/quotes': (query) => {
      const symbols = String(query.symbols ?? '').split(',').filter(Boolean);
      const quotes = symbols.map((symbol) => state.data.quotes[symbol]).filter(Boolean);
      return { quotes, fallbackSymbols: quotes.filter((quote) => quote.source === 'cache').map((quote) => quote.symbol), missingSymbols: symbols.filter((symbol) => !state.data.quotes[symbol]) };
    },
    '/portfolio/performance': () => ({
      supported: true, asOf: TODAY, inception: '2025-12-01', completeFrom: null, benchmarks: ['QQQ', 'SPY'],
      periods: [{ key: 'YTD', from: '2025-12-31', to: TODAY, partial: false, startValue: 1000, endValue: 1500, gain: 400, netFlows: 100, timeWeighted: 0.1234, timeWeightedAnnualized: null, moneyWeighted: 0.12, moneyWeightedAnnualized: null, benchmarks: { QQQ: { return: 0.2, annualized: null, from: '2025-12-31', to: TODAY }, SPY: null } }],
      years: [], notes: ['time-weighted: sample note'], approximationReasons: [],
    }),
    '/card-accounts': () => ({ cardAccounts: state.data.cardAccounts }),
    '/card-transactions': (query) => pageOf(state.data.cardTransactions, query),
    '/spending/summary': () => spendingSummary(),
    '/spending/coverage': () => ({ cards: [{ cardAccountId: 'card-amex', ranges: [], transactions: { count: 225, first: '2025-08-23', last: TODAY }, imports: [] }] }),
    '/spending/benefits': (query) => benefitsReport(Number(query.year ?? 2026)),
    '/spending/forecast': () => forecast(),
    '/spending/patterns': () => patterns(),
    '/metals/overview': (query) => metalsOverview(query.metal ?? 'XAU'),
    '/metals/purchases': (query) => metalsPurchases(query.metal ?? 'XAU'),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, url: req.url });
    const send = (status, value) => {
      const body = JSON.stringify(value);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    };
    req.resume();
    req.on('end', () => setTimeout(() => {
      if (state.status) return send(state.status, { error: 'synthetic failure' });
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Invalid credentials' });
      if (req.method !== 'GET') return send(405, { error: 'method-not-allowed' });
      const override = state.routes[url.pathname];
      if (override) {
        const out = typeof override === 'function' ? override(Object.fromEntries(url.searchParams)) : override;
        return out && Object.hasOwn(out, 'status') ? send(out.status, out.body) : send(200, out);
      }
      const route = routes[url.pathname];
      if (!route) return send(404, { error: 'not-found' });
      return send(200, route(Object.fromEntries(url.searchParams)));
    }, state.delay));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, port, requests, state };
}

/** The `_meta` a 2026-07-28 client sends with every request. */
export const modernMeta = (version = '2026-07-28') => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
});

/** A legacy handshake on an in-process server; returns the initialize response. */
export async function initialize(server, protocolVersion = '2025-11-25') {
  const response = await server.handleMessage({
    jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } },
  });
  await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return response;
}

/** Calls a tool on an initialized in-process server; returns `{ result, data }` with the JSON block parsed. */
export async function callTool(server, name, args = {}, id = `call-${name}`) {
  const response = await server.handleMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  if (response.error) throw new Error(`tools/call ${name} failed: ${response.error.message}`);
  const { result } = response;
  const json = result.content.length > 1 ? JSON.parse(result.content[1].text) : null;
  return { result, data: json, summary: result.content[0].text };
}
