import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createServer } from '../lib/cli.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { MAX_OUTPUT_CHARS } from '../lib/format.mjs';
import { READ_ROUTES } from '../lib/holdr-api.mjs';
import { taxTreatment } from '../lib/tools.mjs';
import {
  NOW, OPTION, OWN_LISTENER, SERVICE_TOKEN, TOKEN, callTool, cardRows, closedPort, initialize, startFakeHoldr, tempDir, writeToken,
} from './helpers.mjs';

const TOOL_NAMES = [
  'holdr_health', 'get_portfolio_summary', 'list_positions', 'list_investment_transactions', 'get_metals_holdings',
  'get_spending_summary', 'list_card_transactions', 'get_card_benefits', 'get_spending_forecast',
];

async function setup(t, { holdrOptions, version = '2025-11-25', tokenDir } = {}) {
  const holdr = await startFakeHoldr(t, holdrOptions);
  const dir = tokenDir ?? tempDir(t);
  if (!tokenDir) writeToken(dir);
  const config = resolveConfig({ argv: ['--app-url', holdr.url, '--data-dir', dir], env: {} });
  const { api, server, tools } = createServer(config, { now: () => NOW, listenerCheck: OWN_LISTENER });
  t.after(() => api.close());
  await initialize(server, version);
  return { holdr, server, tools, dir };
}

test('tools/list: nine read-only tools, each with a precise description and a closed JSON Schema for its arguments', async (t) => {
  const { server } = await setup(t);
  const { result } = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(result.tools.map((tool) => tool.name), TOOL_NAMES);
  for (const tool of result.tools) {
    assert.match(tool.name, /^[a-z][a-z0-9_]{2,63}$/, tool.name);
    assert.ok(tool.title && tool.title.length <= 40, `${tool.name} has a short title`);
    assert.ok(tool.description.length >= 120, `${tool.name} describes itself`);
    assert.deepEqual(
      { readOnlyHint: tool.annotations.readOnlyHint, destructiveHint: tool.annotations.destructiveHint, idempotentHint: tool.annotations.idempotentHint },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    );
    const schema = tool.inputSchema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    for (const [name, property] of Object.entries(schema.properties)) {
      assert.ok(property.type, `${tool.name}.${name} has a type`);
      assert.ok(typeof property.description === 'string' && property.description.length > 10, `${tool.name}.${name} is described`);
      if (property.type === 'array') assert.ok(property.items?.enum, `${tool.name}.${name} lists its items`);
      if (property.pattern) new RegExp(property.pattern, 'u');
    }
  }
  const byName = Object.fromEntries(result.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.list_card_transactions.inputSchema.properties.limit.maximum, 500);
  assert.deepEqual(byName.holdr_health.inputSchema.properties, {});
  assert.equal(byName.get_portfolio_summary.annotations.openWorldHint, true, 'prices come from public market data through Holdr');
  assert.equal(byName.get_card_benefits.annotations.openWorldHint, false);
});

test('every request is a GET to a read route, with the bearer token, straight to loopback, with no browser or proxy headers', async (t) => {
  const { holdr, server } = await setup(t);
  for (const name of TOOL_NAMES) {
    const { result } = await callTool(server, name, name === 'get_portfolio_summary' ? { includePerformance: true } : {});
    assert.equal(result.isError, false, `${name}: ${result.content[0].text}`);
  }
  assert.ok(holdr.requests.length >= 15);
  for (const request of holdr.requests) {
    assert.equal(request.method, 'GET');
    assert.ok(READ_ROUTES.includes(request.path), request.path);
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers.host, `127.0.0.1:${holdr.port}`);
    for (const header of ['origin', 'cookie', 'forwarded', 'x-forwarded-for', 'x-real-ip', 'via', 'x-holdr-request']) {
      assert.equal(request.headers[header], undefined, header);
    }
  }
  assert.deepEqual(new Set(holdr.requests.map((request) => request.path)), new Set(READ_ROUTES));
});

test('holdr_health: version, counts and how recent each card\'s transactions are', async (t) => {
  const { server } = await setup(t);
  const { data, summary } = await callTool(server, 'holdr_health');
  assert.equal(data.status, 'ok');
  assert.equal(data.holdr.schemaVersion, 17);
  assert.equal(data.holdr.investmentAccounts, 3);
  assert.equal(data.server.readOnly, true);
  assert.equal(data.today, '2026-11-24');
  const amex = data.cards.find((card) => card.id === 'card-amex');
  assert.deepEqual(amex, {
    id: 'card-amex', card: 'Sample Platinum Card …1005', issuer: 'amex', owner: 'alex', status: 'active', currency: 'USD',
    transactions: 225, firstDate: '2025-08-23', lastDate: '2026-11-24',
  });
  assert.equal(data.cards.find((card) => card.id === 'card-old').card, 'Citi …3003');
  assert.match(summary, /Holdr is running at http:\/\/127\.0\.0\.1:\d+, database schema 17: 3 investment accounts/);
  assert.match(summary, /through 2026-11-24/);
});

test('get_portfolio_summary: totals, allocation and accounts as the Portfolio page computes them, numbers masked', async (t) => {
  const { holdr, server } = await setup(t);
  const { data, result, summary } = await callTool(server, 'get_portfolio_summary');
  assert.deepEqual(data.totals, {
    marketValue: 15450.5, cash: 1250.5, positionsValue: 14200, positionsCostBasis: 11000.75, unrealizedGain: 3199.25,
    unrealizedGainPct: 29.08, valueComplete: true,
  });
  const brokerage = data.accounts.find((account) => account.id === 'acct-brokerage');
  assert.deepEqual(brokerage, {
    id: 'acct-brokerage', name: 'Sample Brokerage', type: 'Individual', number: '***5678', currency: 'USD', taxTreatment: 'taxable',
    marketValue: 12500, cash: 1000, positionsValue: 11500, positionsCostBasis: 8900.75, unrealizedGain: 2599.25, unrealizedGainPct: 29.2, positions: 3,
  });
  assert.equal(data.accounts.find((account) => account.id === 'acct-hsa').name, 'Sample HSA ***7890');
  assert.deepEqual(data.byTaxTreatment.map((entry) => entry.treatment), ['taxable', 'tax-free (Roth)', 'HSA']);
  assert.deepEqual(data.byAccountType[0], { type: 'Individual', marketValue: 12500, pct: 80.9 });
  assert.deepEqual(data.byAssetClass.map((entry) => entry.assetClass), ['stocks, ETFs and funds', 'crypto', 'cash', 'options']);
  assert.deepEqual(data.topHoldings[0], { symbol: 'BTC-USD', marketValue: 6000, pct: 38.83 });
  assert.deepEqual(data.prices.stale, ['QQQ']);
  assert.match(summary, /\$15,450\.50 across 3 accounts, \$1,250\.50 of it cash, unrealized gain \$3,199\.25 \(29\.08%\)/);
  const quotes = holdr.requests.filter((request) => request.path === '/quotes');
  assert.equal(quotes.length, 1);
  assert.deepEqual(quotes[0].query.symbols.split(',').sort(), ['BTC-USD', 'QQQ', 'SMPL', 'VTI', OPTION].sort());
  const everything = JSON.stringify(result);
  for (const secret of ['Z12345678', 'R0004321', '1234567890', TOKEN]) assert.ok(!everything.includes(secret), secret);
});

test('get_portfolio_summary: an account filter, returns over time, and missing prices left out of the totals', async (t) => {
  const { holdr, server } = await setup(t);
  delete holdr.state.data.quotes.QQQ;
  const { data, summary } = await callTool(server, 'get_portfolio_summary', { account: 'roth', includePerformance: true });
  assert.deepEqual(data.accounts.map((account) => account.id), ['acct-roth']);
  assert.equal(data.totals.valueComplete, false);
  assert.equal(data.totals.unrealizedGain, null);
  assert.deepEqual(data.prices.missing, ['QQQ']);
  assert.deepEqual(data.accounts[0].missingPrices, ['QQQ']);
  assert.match(summary, /No price for QQQ/);
  assert.equal(holdr.requests.find((request) => request.path === '/portfolio/performance').query.accounts, 'acct-roth');
  assert.deepEqual(data.performance.periods[0], {
    period: 'YTD', from: '2025-12-31', to: '2026-11-24', timeWeightedPct: 12.34, timeWeightedAnnualizedPct: null, moneyWeightedPct: 12,
    moneyWeightedAnnualizedPct: null, gain: 400, netDeposits: 100, startValue: 1000, endValue: 1500, benchmarksPct: { QQQ: 20, SPY: null },
  });
  const byNumber = await callTool(server, 'get_portfolio_summary', { account: '5678' });
  assert.deepEqual(byNumber.data.accounts.map((account) => account.id), ['acct-brokerage']);
  const none = await callTool(server, 'get_portfolio_summary', { account: 'Brokerage 2' });
  assert.equal(none.result.isError, true);
  assert.match(none.result.content[0].text, /No investment account matches "Brokerage 2"\. Accounts: Sample Brokerage \(Individual\) \[acct-brokerage\]/);
});

test('list_positions: each holding with cost, price and gain; filters by symbol and sorts', async (t) => {
  const { server } = await setup(t);
  const { data } = await callTool(server, 'list_positions');
  assert.equal(data.total, 5);
  const vti = data.positions.find((row) => row.symbol === 'VTI');
  assert.deepEqual(vti, {
    accountId: 'acct-brokerage', account: 'Sample Brokerage', symbol: 'VTI', assetClass: 'stocks, ETFs and funds', quantity: 15,
    averageCost: 210.05, costBasis: 3150.75, price: 300, priceAsOf: '2026-11-24T20:00:00.000Z', priceFreshness: 'eod', marketValue: 4500,
    unrealizedGain: 1349.25, unrealizedGainPct: 42.82, dayChangePct: 0.5, pctOfAccount: 36, currency: 'USD',
  });
  const option = data.positions.find((row) => row.symbol === OPTION);
  assert.equal(option.marketValue, 700);
  assert.equal(option.contractMultiplier, 100);
  assert.equal(option.assetClass, 'options');
  assert.equal(data.positions.find((row) => row.symbol === 'QQQ').priceFreshness, 'stale (last stored price)');
  assert.deepEqual(data.positions.map((row) => row.marketValue), [...data.positions.map((row) => row.marketValue)].sort((a, b) => b - a));
  const filtered = await callTool(server, 'list_positions', { symbol: 'vti, qqq', sort: 'symbol' });
  assert.deepEqual(filtered.data.positions.map((row) => row.symbol), ['QQQ', 'VTI']);
  assert.equal(filtered.data.positions[1].pctOfAccount, 36, 'shares of the account count every holding, not only the ones asked for');
  const limited = await callTool(server, 'list_positions', { limit: 2 });
  assert.equal(limited.data.shown, 2);
  assert.equal(limited.data.total, 5);
});

test('list_investment_transactions: trades and cash events newest first, with filters and pages', async (t) => {
  const { server } = await setup(t);
  const all = await callTool(server, 'list_investment_transactions');
  assert.equal(all.data.total, 9);
  assert.deepEqual(all.data.items.slice(0, 3).map((item) => `${item.date} ${item.type}`), ['2026-09-30 dividend', '2026-07-01 buy', '2026-06-01 sell']);
  const sell = all.data.items.find((item) => item.date === '2026-06-01');
  assert.deepEqual(sell, {
    date: '2026-06-01', type: 'sell', accountId: 'acct-brokerage', account: 'Sample Brokerage', symbol: 'VTI', quantity: 5, price: 250,
    amount: 1250, currency: 'USD', notes: 'Trim, confirmation ***4321',
  });
  assert.equal(all.data.items.find((item) => item.type === 'dividend').description, 'DIVIDEND VTI REF ***5678');
  const option = all.data.items.find((item) => item.symbol === OPTION);
  assert.deepEqual(option.option, { effect: 'open', contractMultiplier: 100 });
  assert.equal(option.amount, 500);
  const contributions = await callTool(server, 'list_investment_transactions', { account: 'Roth IRA', types: ['deposit'], period: 'this-year' });
  assert.deepEqual(contributions.data.items.map((item) => item.amount), [7000]);
  assert.equal(contributions.data.range.from, '2026-01-01');
  const vti = await callTool(server, 'list_investment_transactions', { symbol: 'vti', limit: 2 });
  assert.deepEqual(vti.data.items.map((item) => item.date), ['2026-06-01', '2026-03-05']);
  assert.equal(vti.data.nextOffset, 2);
  const next = await callTool(server, 'list_investment_transactions', { symbol: 'VTI', limit: 2, offset: 2 });
  assert.deepEqual(next.data.items.map((item) => item.date), ['2026-01-05']);
  assert.equal(next.data.nextOffset, null);
  const clash = await callTool(server, 'list_investment_transactions', { period: 'last-month', from: '2026-01-01' });
  assert.equal(clash.result.isError, true);
  assert.match(clash.result.content[0].text, /one of period, month, or from\/to/);
  const badDate = await callTool(server, 'list_investment_transactions', { from: '2026-02-30' });
  assert.match(badDate.result.content[0].text, /from must be a real date/);
});

test('get_metals_holdings: troy ounces, cost and value at spot per metal, caveats, and the purchase lots', async (t) => {
  const { holdr, server } = await setup(t);
  const { data, summary } = await callTool(server, 'get_metals_holdings');
  assert.deepEqual(data.metals.map((metal) => metal.metal), ['gold', 'silver']);
  const gold = data.metals[0];
  assert.deepEqual(gold.holdings, { troyOz: 3, units: 3, cost: 6000, value: 7951.2, gain: 1951.2, gainPct: 32.52, awaitingDeliveryTroyOz: 0 });
  assert.deepEqual(gold.price, { usdPerTroyOz: 2650.4, closeDate: '2026-11-21' });
  assert.deepEqual(gold.byForm[0], { form: 'coin', fineTroyOzPerUnit: 1, unitsHeld: 3, troyOz: 3, cost: 6000, value: 7951.2, gain: 1951.2 });
  assert.deepEqual(gold.toCheck, { records: 1, needsYou: ['confirm-content'] });
  assert.deepEqual(data.metals[1].caveats, ['value is partial: price-stale (1)']);
  assert.deepEqual(data.lots.map((lot) => `${lot.metal} ${lot.orderDate}`), ['gold 2026-02-01', 'gold 2025-03-01', 'silver 2025-05-01']);
  assert.equal(data.lots[0].title, 'Sample 1 oz Gold Coin, order ***6789');
  assert.equal(data.lots[0].premiumPerOz, 45);
  assert.ok(!JSON.stringify(data).includes('91005'), 'no card ending beyond four digits');
  assert.match(summary, /gold: 3 troy oz in 3 units, cost \$6,000\.00, worth \$7,951\.20 at the 2026-11-21 close \(\$2,650\.40\/oz\): gain \$1,951\.20 \(32\.52%\)/);
  const silver = await callTool(server, 'get_metals_holdings', { metal: 'silver', includeLots: false });
  assert.deepEqual(silver.data.metals.map((metal) => metal.code), ['XAG']);
  assert.equal(silver.data.lots, undefined);
  assert.equal(holdr.requests.filter((request) => request.path === '/metals/overview').at(-1).query.metal, 'XAG');
  holdr.state.routes['/metals/overview'] = { installed: false };
  const absent = await callTool(server, 'get_metals_holdings');
  assert.equal(absent.result.isError, false);
  assert.deepEqual(absent.data, { installed: false });
});

test('get_spending_summary: the period, card and owner become Holdr\'s query; category groups and top merchants', async (t) => {
  const { holdr, server } = await setup(t);
  const { data, summary } = await callTool(server, 'get_spending_summary', { period: 'last-month', card: 'platinum', owner: 'alex', topMerchants: 5 });
  const query = holdr.requests.find((request) => request.path === '/spending/summary').query;
  assert.deepEqual(query, { cardAccountId: 'card-amex', owner: 'alex', from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(data.range, { from: '2026-10-01', to: '2026-10-31', label: 'last month (2026-10)' });
  assert.deepEqual(data.totals[0], {
    currency: 'USD', spending: 1234.56, charges: 1300, credits: -65.44, count: 87, cardPayments: -2000, cardPaymentCount: 2,
  });
  assert.deepEqual(data.byCategoryGroup.slice(0, 2), [
    { categoryGroup: 'Merchandise & Supplies', currency: 'USD', spending: 600, count: 40 },
    { categoryGroup: 'Restaurant', currency: 'USD', spending: 420, count: 35 },
  ]);
  assert.equal(data.byMerchant.length, 5);
  assert.equal(data.byCard, undefined);
  assert.match(summary, /Card spending, last month \(2026-10\), Sample Platinum Card …1005, owner alex: \$1,234\.56 in 87 posted transactions/);
  const byCard = await callTool(server, 'get_spending_summary', { month: '2026-09', groupBy: ['card', 'owner'] });
  assert.deepEqual(byCard.data.byCard[0], { card: 'Sample Platinum Card …1005', cardAccountId: 'card-amex', currency: 'USD', spending: 800, count: 50 });
  assert.equal(byCard.data.byMonth, undefined);
  assert.equal(holdr.requests.filter((request) => request.path === '/spending/summary').at(-1).query.from, '2026-09-01');
});

test('list_card_transactions: newest first, paged through Holdr 200 rows at a time, at most 500, digits masked', async (t) => {
  const { holdr, server } = await setup(t);
  const first = await callTool(server, 'list_card_transactions');
  assert.equal(first.data.total, 450);
  assert.equal(first.data.shown, 50);
  assert.equal(first.data.nextOffset, 50);
  assert.equal(first.data.currency, 'USD');
  assert.deepEqual(first.data.transactions[0], {
    date: '2026-11-24', status: 'pending', kind: 'purchase', amount: 10,
    merchant: 'SAMPLE MERCHANT 0', category: 'Restaurant-Restaurant', card: 'Sample Platinum Card …1005',
  });
  assert.equal(first.data.transactions[2].status, undefined, 'posted is the usual status and left out');
  const masked = first.data.transactions[3];
  assert.equal(masked.merchant, 'Northwind Market');
  assert.equal(masked.description, 'NORTHWIND MARKET #104 PHONE ***0123');
  assert.equal(first.data.transactions[9].amount, -12.5);
  assert.equal(first.data.transactions[5].role, 'excluded', 'an asset purchase says so');
  assert.equal(first.data.transactions[9].role, undefined, 'a refund is spending, as usual');
  assert.deepEqual(holdr.requests.find((request) => request.path === '/card-transactions').query, { sort: 'date-desc', limit: '50', offset: '0' });

  holdr.requests.length = 0;
  // Short rows, so that all 450 fit the size budget (the next test covers the cut).
  holdr.state.data.cardTransactions = cardRows(450).map((row) => ({ ...row, category: 'Food', merchantName: 'M', description: 'M' }));
  const all = await callTool(server, 'list_card_transactions', { limit: 500, card: '2002', period: 'this-year', kinds: ['purchase', 'refund'], statuses: ['posted'], search: 'sample' });
  const pages = holdr.requests.filter((request) => request.path === '/card-transactions');
  assert.deepEqual(pages.map((page) => [page.query.limit, page.query.offset]), [['200', '0'], ['200', '200'], ['100', '400']]);
  assert.deepEqual({ ...pages[0].query, limit: undefined, offset: undefined }, {
    cardAccountId: 'card-chase', from: '2026-01-01', to: '2026-11-24', kind: 'purchase,refund', status: 'posted', q: 'sample', sort: 'date-desc', limit: undefined, offset: undefined,
  });
  assert.equal(all.data.shown, 450);
  assert.equal(all.data.nextOffset, null);

  const tooMany = await callTool(server, 'list_card_transactions', { limit: 501 });
  assert.equal(tooMany.result.isError, true);
  assert.match(tooMany.result.content[0].text, /limit must be from 1 to 500/);
});

test('list_card_transactions: an answer over the size budget is cut, and says where the next page starts', async (t) => {
  const { holdr, server } = await setup(t);
  holdr.state.data.cardTransactions = cardRows(500, { longDescriptions: true });
  const { data, result, summary } = await callTool(server, 'list_card_transactions', { limit: 500 });
  const text = result.content[1].text;
  assert.ok(text.length <= MAX_OUTPUT_CHARS, `${text.length} characters`);
  assert.ok(data.shown < 500 && data.shown > 100, `${data.shown} shown`);
  assert.equal(data.transactions.length, data.shown);
  assert.deepEqual(data.truncated, { transactions: { shown: data.shown, total: 500 } });
  assert.equal(data.nextOffset, data.shown);
  assert.match(summary, new RegExp(`^500 card transactions match \\(all time\\); ${data.shown} shown from 0, newest first; the next page starts at offset ${data.shown}\\.`));
  assert.match(summary, /Output was cut to fit: transactions \d+ of 500/);
  assert.ok(data.transactions.every((row) => !/4455667788/.test(JSON.stringify(row))));
});

test('get_card_benefits: what each credit has left this period, the days to its reset, and the fee it covers', async (t) => {
  const { holdr, server } = await setup(t);
  const { data, summary } = await callTool(server, 'get_card_benefits', { card: 'Platinum' });
  assert.equal(data.cards.length, 1);
  const card = data.cards[0];
  assert.deepEqual(card.product, { name: 'The Platinum Card', annualFee: 695 });
  assert.deepEqual(card.year, { captured: 1075, available: 1165, annualFee: 695, feeCoveredPct: 154.68 });
  const resy = card.benefits.find((benefit) => benefit.id === 'resy');
  assert.deepEqual(resy.current, {
    period: 'Q4 2026', start: '2026-10-01', end: '2026-12-31', daysLeft: 38, available: 100, used: 40, remaining: 60, usedFrom: 'derived',
  });
  const night = card.benefits.find((benefit) => benefit.id === 'night');
  assert.equal(night.unit, 'free night');
  assert.equal(night.current.remaining, null);
  assert.equal(night.tracking, 'manual (certificate)');
  assert.deepEqual(data.resetsSoon, [{ card: 'Sample Platinum Card …1005', benefit: 'Uber Cash', ends: '2026-11-30', daysLeft: 7, remaining: 15, unit: 'USD' }]);
  assert.match(summary, /Card benefits 2026 \(Sample Platinum Card …1005\): \$1,075\.00 captured this year against a \$695\.00 annual fee \(154\.68% covered\); \$75\.00 left in current periods/);
  const remaining = await callTool(server, 'get_card_benefits', { card: '1005', onlyWithRemaining: true, includePeriods: true, year: 2026 });
  assert.deepEqual(remaining.data.cards[0].benefits.map((benefit) => benefit.id), ['uber-cash', 'resy', 'night']);
  assert.equal(remaining.data.cards[0].benefits[0].periods.length, 1);
  assert.equal(holdr.requests.filter((request) => request.path === '/spending/benefits').at(-1).query.year, '2026');
  const casey = await callTool(server, 'get_card_benefits', { owner: 'casey' });
  assert.deepEqual(casey.data.cards.map((item) => item.card), ['Sample Everyday Visa …2002']);
  const none = await callTool(server, 'get_card_benefits', { card: 'Sapphire' });
  assert.equal(none.result.isError, true);
  assert.match(none.result.content[0].text, /No card matches "Sapphire"\. Cards: Sample Platinum Card …1005 \[card-amex\]; Sample Everyday Visa …2002 \[card-chase\]/);
});

test('get_spending_forecast: this month\'s pace, the next months with ranges, categories, bills and unusual spending', async (t) => {
  const { holdr, server } = await setup(t);
  const { data, summary } = await callTool(server, 'get_spending_forecast', { owner: 'casey', categoriesLimit: 3, historyMonths: 2 });
  assert.deepEqual(holdr.requests.find((request) => request.path === '/spending/forecast').query, { owner: 'casey' });
  assert.deepEqual(data.thisMonth, {
    daysElapsed: 24, daysInMonth: 30, spentSoFar: 2500, everydaySoFar: 2400, oneOffsSoFar: 100, pendingNotCounted: 20.01,
    projectedTotal: 3200, projectedRange80: [3000, 3400], typicalMonth: 3050,
  });
  assert.deepEqual(data.everydayForecast.months[0], { month: '2026-12', estimate: 3100, range80: [3000, 3200], range95: [2900, 3300] });
  assert.equal(data.categories.length, 3);
  assert.equal(data.recentMonths.length, 2);
  assert.deepEqual(data.bills.upcoming[0], { date: '2026-11-28', merchant: 'Sample Streaming', amount: 15, cadence: 'monthly', fixed: true });
  assert.equal(data.unusual[0].direction, 'high');
  assert.match(summary, /2026-11 so far \$2,500\.00 \(day 24 of 30\), heading for about \$3,200\.00 \(typical month \$3,050\.00\); everyday spending in 2026-12 about \$3,100\.00; 2 bills due by 2027-01-23 \(\$215\.00\)/);
  const noBills = await callTool(server, 'get_spending_forecast', { includeBills: false, includeCategories: false });
  assert.equal(noBills.data.bills, undefined);
  assert.equal(noBills.data.categories, undefined);
});

test('a card that matches several or none is a tool error that lists the cards', async (t) => {
  const { server } = await setup(t);
  const several = await callTool(server, 'list_card_transactions', { card: 'sample' });
  assert.equal(several.result.isError, true);
  assert.match(several.result.content[0].text, /"sample" matches 2 cards: Sample Platinum Card …1005 \[card-amex\]; Sample Everyday Visa …2002 \[card-chase\]/);
  const none = await callTool(server, 'get_spending_forecast', { card: '9999' });
  assert.match(none.result.content[0].text, /No card matches "9999"/);
});

test('Holdr not running, or no agent token: a clear tool error, nothing sent, and no file path in the message', async (t) => {
  const dir = tempDir(t);
  const config = resolveConfig({ argv: ['--app-url', `http://127.0.0.1:${await closedPort()}`, '--data-dir', dir], env: {} });
  const { api, server } = createServer(config, { now: () => NOW, listenerCheck: OWN_LISTENER });
  t.after(() => api.close());
  await initialize(server);
  const missing = await callTool(server, 'holdr_health');
  assert.equal(missing.result.isError, true);
  assert.match(missing.summary, /agent token file \(agent-token\) was not found\. Holdr creates it in its data folder when it starts/);
  assert.ok(!missing.summary.includes(dir), 'the data folder is never named');
  // A service token next to it changes nothing: the server never falls back to it.
  writeToken(dir, SERVICE_TOKEN, 'service-token');
  assert.match((await callTool(server, 'holdr_health')).summary, /agent token file \(agent-token\) was not found/);
  writeToken(dir);
  const down = await callTool(server, 'get_spending_summary');
  assert.equal(down.result.isError, true);
  assert.match(down.summary, /Holdr is not running at http:\/\/127\.0\.0\.1:\d+: start it \(npm run start:local/);

  const holdr = await startFakeHoldr(t, { token: `holdr_agent_${'cd'.repeat(32)}` });
  const wrong = createServer(resolveConfig({ argv: ['--app-url', holdr.url, '--data-dir', dir], env: {} }), { listenerCheck: OWN_LISTENER });
  t.after(() => wrong.api.close());
  await initialize(wrong.server);
  const rejected = await callTool(wrong.server, 'list_positions');
  assert.match(rejected.summary, /Holdr refused the agent token/);
  assert.ok(!JSON.stringify(rejected.result).includes(TOKEN));
});

test('the token is read on every request, so a new token works without restarting the server', async (t) => {
  const { holdr, server, dir } = await setup(t);
  assert.equal((await callTool(server, 'holdr_health')).result.isError, false);
  fs.rmSync(path.join(dir, 'agent-token'));
  const before = holdr.requests.length;
  assert.match((await callTool(server, 'holdr_health')).summary, /agent token file \(agent-token\) was not found/);
  assert.equal(holdr.requests.length, before, 'nothing is sent without a token');
  writeToken(dir);
  assert.equal((await callTool(server, 'holdr_health')).result.isError, false);
  assert.ok(holdr.requests.length > before);
});

test('tax treatment is inferred from the account type', () => {
  const cases = {
    'Roth IRA': 'tax-free (Roth)', 'Roth 401(k)': 'tax-free (Roth)', '401(k)': 'tax-deferred', 'Traditional IRA': 'tax-deferred',
    'SEP IRA': 'tax-deferred', HSA: 'HSA', Individual: 'taxable', 'Joint WROS': 'taxable', '529 Plan': 'education', '': 'unknown',
  };
  for (const [type, treatment] of Object.entries(cases)) assert.equal(taxTreatment(type), treatment, type);
  assert.equal(taxTreatment(undefined), 'unknown');
});
