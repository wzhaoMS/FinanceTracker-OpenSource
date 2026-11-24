import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateOptionPosition, aggregatePosition, aggregatePositions, dayChangeDisplayLabel, formatCurrency, formatGainLoss, formatPercent, formatShownAmount, formatShownPercent, heldSymbolsAcrossAccounts, positionMarketValue, positionsPnLPercent, summarizeBySymbol, summarizePortfolio, type MultiAccountSummary, type SymbolSummary } from './portfolio.js';
import type { Account, Quote, Transaction } from './types.js';

const txs: Transaction[] = [
  { id: '1', accountId: 'a1', symbol: 'AAPL', date: '2025-01-10', quantity: 10, pricePerUnit: 150, fees: 1, currency: 'USD' },
  { id: '2', accountId: 'a1', symbol: 'AAPL', date: '2025-03-01', quantity: 5,  pricePerUnit: 170, fees: 1, currency: 'USD' },
  { id: '3', accountId: 'a1', symbol: 'AAPL', date: '2025-04-15', quantity: -4, pricePerUnit: 180, fees: 1, currency: 'USD' },
];

describe('aggregatePosition', () => {
  it('computes quantity, weighted-average cost, and cost basis on buys', () => {
    const buys: Transaction[] = txs.slice(0, 2); // only the two buys
    const p = aggregatePosition('AAPL', buys)!;
    assert.equal(p.quantity, 15);
    // buy cost = (10*150 + 1) + (5*170 + 1) = 1501 + 851 = 2352, qty = 15 → avg = 156.8
    assert.ok(Math.abs(p.averageCost - 2352 / 15) < 1e-6);
    assert.equal(p.costBasis, 2352);
    // Sanity: costBasis === quantity * averageCost for pure-buy histories.
    assert.ok(Math.abs(p.costBasis - p.quantity * p.averageCost) < 1e-6);
  });

  it('reduces cost basis at average cost on sells, NOT by proceeds', () => {
    // Reviewer 3 case: buy 10 @ 100, sell 4 @ 200. Proceeds $800 must NOT
    // bleed into remaining cost basis.
    const lot: Transaction[] = [
      { id: 'b', accountId: 'x', symbol: 'X', date: '2025-01-01', quantity: 10, pricePerUnit: 100, currency: 'USD' },
      { id: 's', accountId: 'x', symbol: 'X', date: '2025-02-01', quantity: -4, pricePerUnit: 200, currency: 'USD' },
    ];
    const p = aggregatePosition('X', lot)!;
    assert.equal(p.quantity, 6);
    assert.equal(p.averageCost, 100); // unchanged by the sell
    assert.equal(p.costBasis, 600);   // 6 shares × $100; NOT 1000 - 800 = 200
    // The strict invariant: remaining basis matches remaining shares × avg cost.
    assert.ok(Math.abs(p.costBasis - p.quantity * p.averageCost) < 1e-9);
  });

  it('preserves the invariant across buy/sell/buy sequences', () => {
    const seq: Transaction[] = [
      { id: '1', accountId: 'x', symbol: 'X', date: '2025-01-01', quantity: 10, pricePerUnit: 100, currency: 'USD' },
      { id: '2', accountId: 'x', symbol: 'X', date: '2025-02-01', quantity: 10, pricePerUnit: 200, currency: 'USD' },
      // Avg cost now (10*100 + 10*200)/20 = $150
      { id: '3', accountId: 'x', symbol: 'X', date: '2025-03-01', quantity: -5, pricePerUnit: 300, currency: 'USD' },
      // After sell: qty 15, avg unchanged at $150, cost = 15 * 150 = 2250
    ];
    const p = aggregatePosition('X', seq)!;
    assert.equal(p.quantity, 15);
    assert.equal(p.averageCost, 150);
    assert.equal(p.costBasis, 2250);
    assert.ok(Math.abs(p.costBasis - p.quantity * p.averageCost) < 1e-9);
  });

  it('resets the lot when fully closed, then a new buy starts fresh', () => {
    const seq: Transaction[] = [
      { id: '1', accountId: 'x', symbol: 'X', date: '2025-01-01', quantity: 10, pricePerUnit: 100, currency: 'USD' },
      { id: '2', accountId: 'x', symbol: 'X', date: '2025-02-01', quantity: -10, pricePerUnit: 250, currency: 'USD' },
      { id: '3', accountId: 'x', symbol: 'X', date: '2025-03-01', quantity: 5, pricePerUnit: 300, currency: 'USD' },
    ];
    const p = aggregatePosition('X', seq)!;
    assert.equal(p.quantity, 5);
    // The new lot is a clean buy at $300, ignoring the closed-and-reopened history.
    assert.equal(p.averageCost, 300);
    assert.equal(p.costBasis, 1500);
  });

  it('handles fees on both buys and sells without breaking the invariant', () => {
    const seq: Transaction[] = [
      { id: '1', accountId: 'x', symbol: 'X', date: '2025-01-01', quantity: 10, pricePerUnit: 100, fees: 5, currency: 'USD' },
      // Lot cost = 10*100 + 5 = 1005; avg = 100.5
      { id: '2', accountId: 'x', symbol: 'X', date: '2025-02-01', quantity: -3, pricePerUnit: 110, fees: 1, currency: 'USD' },
      // Cost removed = 3 * 100.5 + 1 = 302.5; remaining basis = 1005 - 302.5 = 702.5
      // Remaining qty 7; avg unchanged at 100.5
    ];
    const p = aggregatePosition('X', seq)!;
    assert.equal(p.quantity, 7);
    assert.ok(Math.abs(p.averageCost - 100.5) < 1e-9);
    assert.ok(Math.abs(p.costBasis - 702.5) < 1e-9);
  });

  it('processes transactions in chronological order regardless of input order', () => {
    const out: Transaction[] = [
      { id: '2', accountId: 'x', symbol: 'X', date: '2025-02-01', quantity: -4, pricePerUnit: 200, currency: 'USD' },
      { id: '1', accountId: 'x', symbol: 'X', date: '2025-01-01', quantity: 10, pricePerUnit: 100, currency: 'USD' },
    ];
    const p = aggregatePosition('X', out)!;
    assert.equal(p.quantity, 6);
    assert.equal(p.averageCost, 100);
    assert.equal(p.costBasis, 600);
  });

  it('returns null for unknown symbols', () => {
    assert.equal(aggregatePosition('TSLA', txs), null);
  });
});

describe('option positions', () => {
  const optionSymbol = 'NBIS260731P00165000';
  const openingFills: Transaction[] = [
    {
      id: 'sto-4', accountId: 'x', symbol: optionSymbol, date: '2026-07-10',
      quantity: -4, pricePerUnit: 6.10, fees: 2.72, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    },
    {
      id: 'sto-1', accountId: 'x', symbol: optionSymbol, date: '2026-07-10',
      quantity: -1, pricePerUnit: 8.45, fees: 0.68, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    },
  ];

  it('aggregates the verified sell-to-open fills as a signed short liability', () => {
    const position = aggregateOptionPosition(optionSymbol, openingFills)!;
    assert.equal(position.quantity, -5);
    assert.ok(Math.abs(position.costBasis - -3281.60) < 1e-9);
    assert.ok(Math.abs(position.averageCost - 6.5632) < 1e-9);
    assert.equal(positionMarketValue(position, { price: 6.05 }), -3025);

    const summary = summarizePortfolio(openingFills, [{
      symbol: optionSymbol, price: 6.05, currency: 'USD', asOf: 0,
    }]);
    assert.equal(summary.positions.length, 1);
    assert.ok(Math.abs(summary.totalUnrealizedPnL - 256.60) < 1e-9);
  });

  it('reduces signed basis proportionally on close and resets on full close', () => {
    const partial = aggregateOptionPosition(optionSymbol, [
      ...openingFills,
      {
        id: 'btc-2', accountId: 'x', symbol: optionSymbol, date: '2026-07-11',
        quantity: 2, pricePerUnit: 4, fees: 1, currency: 'USD',
        instrumentType: 'option', contractMultiplier: 100, positionEffect: 'close',
      },
    ])!;
    assert.equal(partial.quantity, -3);
    assert.ok(Math.abs(partial.costBasis - -1968.96) < 1e-9);

    const closed = aggregateOptionPosition(optionSymbol, [
      ...openingFills,
      {
        id: 'btc-5', accountId: 'x', symbol: optionSymbol, date: '2026-07-11',
        quantity: 5, pricePerUnit: 4, fees: 1, currency: 'USD',
        instrumentType: 'option', contractMultiplier: 100, positionEffect: 'close',
      },
    ])!;
    assert.equal(closed.quantity, 0);
    assert.equal(closed.costBasis, 0);
  });

  it('rejects over-closes and keeps NBIS equity separate from its option contract', () => {
    assert.throws(() => aggregateOptionPosition(optionSymbol, [
      ...openingFills,
      {
        id: 'btc-6', accountId: 'x', symbol: optionSymbol, date: '2026-07-11',
        quantity: 6, pricePerUnit: 4, currency: 'USD',
        instrumentType: 'option', contractMultiplier: 100, positionEffect: 'close',
      },
    ]), /exceeds/);

    const positions = aggregatePositions([
      { id: 'nbis-stock', accountId: 'x', symbol: 'NBIS', date: '2026-07-01', quantity: 10, pricePerUnit: 200, currency: 'USD' },
      ...openingFills,
    ]);
    assert.deepEqual(positions.map((position) => position.symbol).sort(), [optionSymbol, 'NBIS'].sort());
    assert.deepEqual(heldSymbolsAcrossAccounts([
      { id: 'nbis-stock', accountId: 'x', symbol: 'NBIS', date: '2026-07-01', quantity: 10, pricePerUnit: 200, currency: 'USD' },
      ...openingFills,
    ]), ['NBIS', optionSymbol]);
  });
});

describe('summarizePortfolio', () => {
  it('values positions and reports missing quotes', () => {
    const quotes: Quote[] = [
      { symbol: 'AAPL', price: 200, currency: 'USD', asOf: Date.now() },
    ];
    const allTxs = [
      ...txs,
      { id: '4', accountId: 'a1', symbol: 'MSFT', date: '2025-02-01', quantity: 3, pricePerUnit: 400, currency: 'USD' } as Transaction,
    ];
    const s = summarizePortfolio(allTxs, quotes);
    assert.equal(s.positions.length, 1);
    assert.deepEqual(s.missingQuotes, ['MSFT']);
    assert.equal(s.valueAvailable, false);
    assert.equal(s.positions[0].marketValue, 11 * 200);
    // After fix: AAPL avg cost = 156.8, sell of 4 removes 4 * 156.8 + 1 = 628.2 from basis
    // basis remaining = 2352 - 628.2 = 1723.8; market = 11 * 200 = 2200
    assert.ok(Math.abs(s.positions[0].costBasis - 1723.8) < 1e-6);
    assert.equal(s.totalUnrealizedPnL, 0);
  });
});

// ---------------------------------------------------------------------------
// summarizeBySymbol — combined holdings by asset
// ---------------------------------------------------------------------------

const acc = (id: string, name: string, cash = 0): Account => ({
  id, name, cashBalance: cash, currency: 'USD',
});

describe('summarizeBySymbol', () => {
  it('combines the same symbol across two accounts and preserves contributors', () => {
    const accounts = [acc('hsa', 'HSA', 100), acc('ira', 'IRA', 0)];
    const txs: Transaction[] = [
      { id: 't1', accountId: 'hsa', symbol: 'NVDA', date: '2025-01-01', quantity: 10, pricePerUnit: 100, currency: 'USD' },
      { id: 't2', accountId: 'ira', symbol: 'NVDA', date: '2025-02-01', quantity: 20, pricePerUnit: 80,  currency: 'USD' },
    ];
    const quotes: Quote[] = [
      { symbol: 'NVDA', price: 200, currency: 'USD', asOf: 0 },
    ];
    const s = summarizeBySymbol(accounts, txs, quotes);
    assert.equal(s.rows.length, 1);
    const r = s.rows[0];
    assert.equal(r.symbol, 'NVDA');
    assert.equal(r.quantity, 30);
    // cost basis = 10*100 + 20*80 = 2600; market = 30*200 = 6000
    assert.equal(r.costBasis, 2600);
    assert.equal(r.marketValue, 6000);
    assert.equal(r.contributors.length, 2);
    // sorted by marketValue descending
    assert.equal(r.contributors[0].accountId, 'ira'); // 20*200 = 4000
    assert.equal(r.contributors[0].marketValue, 4000);
    assert.equal(r.contributors[1].accountId, 'hsa'); // 10*200 = 2000
    // average cost is buy-weighted: (10*100 + 20*80) / 30 = 2600/30
    assert.ok(Math.abs(r.averageCost - 2600 / 30) < 1e-6);
  });

  it('counts a joint account once when included once (caller responsibility)', () => {
    const joint = acc('joint', 'Joint', 0);
    const txs: Transaction[] = [
      { id: 't1', accountId: 'joint', symbol: 'VTI', date: '2025-01-01', quantity: 100, pricePerUnit: 200, currency: 'USD' },
    ];
    const quotes: Quote[] = [{ symbol: 'VTI', price: 250, currency: 'USD', asOf: 0 }];
    const s = summarizeBySymbol([joint], txs, quotes);
    assert.equal(s.rows[0].marketValue, 25000);
    assert.equal(s.rows[0].contributors.length, 1);
  });

  it('marks aggregate NAV unavailable when any held equity quote is missing', () => {
    const a = acc('a', 'A', 0);
    const txs: Transaction[] = [
      { id: 't1', accountId: 'a', symbol: 'OBSCURE', date: '2025-01-01', quantity: 5, pricePerUnit: 50, currency: 'USD' },
    ];
    const s = summarizeBySymbol([a], txs, []);
    assert.equal(s.rows.length, 1);
    assert.equal(s.rows[0].missingQuote, true);
    assert.equal(s.rows[0].marketValue, 0);
    assert.deepEqual(s.missingQuotes, ['OBSCURE']);
    assert.equal(s.valueAvailable, false);
  });

  it('marks household and account NAV unavailable when a short option quote is missing', () => {
    const account = acc('a', 'A', 10_000);
    const option: Transaction = {
      id: 'put', accountId: 'a', symbol: 'NBIS260731P00165000', date: '2026-07-10',
      quantity: -5, pricePerUnit: 6.5632, fees: 3.4, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    };
    const symbolSummary = summarizeBySymbol([account], [option], []);
    assert.equal(symbolSummary.valueAvailable, false);
    assert.equal(symbolSummary.rows.length, 1);
    assert.equal(symbolSummary.rows[0].missingQuote, true);
    assert.equal(symbolSummary.totalUnrealizedPnL, 0);

    const accountSummary = summarizeByAccount([account], [option], []);
    assert.equal(accountSummary.valueAvailable, false);
    assert.equal(accountSummary.accounts[0].valueAvailable, false);
    assert.equal(accountSummary.accounts[0].rows.some((row) => row.symbol === option.symbol), true);

    const portfolio = summarizePortfolio([option], []);
    assert.equal(portfolio.valueAvailable, false);
    assert.deepEqual(portfolio.missingQuotes, [option.symbol]);
  });

  it('retains offsetting long and short option exposure across accounts', () => {
    const symbol = 'NBIS260731P00165000';
    const long: Transaction = {
      id: 'long', accountId: 'long-account', symbol, date: '2026-07-10',
      quantity: 2, pricePerUnit: 4, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    };
    const short: Transaction = {
      id: 'short', accountId: 'short-account', symbol, date: '2026-07-10',
      quantity: -2, pricePerUnit: 6, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    };
    const accounts = [acc('long-account', 'Long'), acc('short-account', 'Short')];
    const quoted = summarizeBySymbol(accounts, [long, short], [
      { symbol, price: 5, currency: 'USD', asOf: 0 },
    ]);
    assert.equal(quoted.rows.length, 1);
    assert.equal(quoted.rows[0].quantity, 0);
    assert.equal(quoted.rows[0].marketValue, 0);
    assert.equal(quoted.rows[0].unrealizedPnL, 400);
    assert.equal(quoted.rows[0].contributors.length, 2);

    const unquoted = summarizeBySymbol(accounts, [long, short], []);
    assert.equal(unquoted.rows.length, 1);
    assert.equal(unquoted.valueAvailable, false);
    assert.deepEqual(unquoted.missingQuotes, [symbol]);
    assert.equal(unquoted.cash.pctOfTotal, 0);
  });

  it('includes cash in the total and breaks it out per account', () => {
    const accounts = [acc('a', 'A', 500), acc('b', 'B', 1000), acc('c', 'C', 0)];
    const s = summarizeBySymbol(accounts, [], []);
    assert.equal(s.totalMarketValue, 1500);
    assert.equal(s.cash.total, 1500);
    // contributors only include non-zero cash accounts.
    assert.equal(s.cash.contributors.length, 2);
    assert.equal(s.cash.pctOfTotal, 100);
  });

  it('filters transactions to in-scope accounts only (per-user view simulation)', () => {
    // simulate "View as Alex": Alex's solo + joint, but exclude Casey's solo
    const alexSolo = acc('alex-solo', 'Alex Solo', 0);
    const joint = acc('joint', 'Joint', 0);
    const caseySolo = acc('casey-solo', 'Casey Solo', 0);
    const txs: Transaction[] = [
      { id: 't1', accountId: 'alex-solo',    symbol: 'AAPL', date: '2025-01-01', quantity: 10, pricePerUnit: 100, currency: 'USD' },
      { id: 't2', accountId: 'joint',       symbol: 'VTI',  date: '2025-01-01', quantity: 50, pricePerUnit: 200, currency: 'USD' },
      { id: 't3', accountId: 'casey-solo', symbol: 'TSLA', date: '2025-01-01', quantity: 20, pricePerUnit: 300, currency: 'USD' },
    ];
    const quotes: Quote[] = [
      { symbol: 'AAPL', price: 110, currency: 'USD', asOf: 0 },
      { symbol: 'VTI',  price: 220, currency: 'USD', asOf: 0 },
      { symbol: 'TSLA', price: 350, currency: 'USD', asOf: 0 },
    ];

    const alexView = summarizeBySymbol([alexSolo, joint], txs, quotes);
    const symbols = alexView.rows.map((r) => r.symbol).sort();
    assert.deepEqual(symbols, ['AAPL', 'VTI']);
    // TSLA was filtered out because its account isn't in scope.
    assert.ok(!alexView.rows.some((r) => r.symbol === 'TSLA'));
  });

  it('totals cost basis and unrealized P&L correctly across multiple symbols', () => {
    const a = acc('a', 'A', 100);
    const txs: Transaction[] = [
      { id: 't1', accountId: 'a', symbol: 'X', date: '2025-01-01', quantity: 10, pricePerUnit: 100, currency: 'USD' },
      { id: 't2', accountId: 'a', symbol: 'Y', date: '2025-01-01', quantity:  5, pricePerUnit:  50, currency: 'USD' },
    ];
    const quotes: Quote[] = [
      { symbol: 'X', price: 150, currency: 'USD', asOf: 0 },
      { symbol: 'Y', price:  40, currency: 'USD', asOf: 0 },
    ];
    const s = summarizeBySymbol([a], txs, quotes);
    // positions market = 10*150 + 5*40 = 1500 + 200 = 1700
    // + cash 100 → total 1800
    assert.equal(s.totalMarketValue, 1800);
    // cost basis = 1000 + 250 + 100 cash = 1350
    assert.equal(s.totalCostBasis, 1350);
    assert.equal(s.totalUnrealizedPnL, 1800 - 1350);
    // pctOfTotal sums roughly to (1700/1800)*100 across rows; cash takes the rest.
    const sumRowPct = s.rows.reduce((sum, r) => sum + r.pctOfTotal, 0);
    assert.ok(Math.abs(sumRowPct + s.cash.pctOfTotal - 100) < 1e-9);
  });

  it('skips zero-net-quantity symbols (fully sold positions)', () => {
    const a = acc('a', 'A', 0);
    const txs: Transaction[] = [
      { id: 't1', accountId: 'a', symbol: 'GONE', date: '2025-01-01', quantity:  10, pricePerUnit: 100, currency: 'USD' },
      { id: 't2', accountId: 'a', symbol: 'GONE', date: '2025-02-01', quantity: -10, pricePerUnit: 120, currency: 'USD' },
    ];
    const quotes: Quote[] = [{ symbol: 'GONE', price: 130, currency: 'USD', asOf: 0 }];
    const s = summarizeBySymbol([a], txs, quotes);
    assert.equal(s.rows.length, 0);
  });
});

describe('dayChangeDisplayLabel', () => {
  it('returns null when no basis (provider had no baseline)', () => {
    assert.equal(dayChangeDisplayLabel({}), null);
  });
  it('returns null when freshness is stale', () => {
    assert.equal(
      dayChangeDisplayLabel({ changeBasis: 'previousClose', freshness: 'stale', session: 'regular' }),
      null,
    );
  });
  it('returns null when basis is open (Stooq close-vs-open)', () => {
    assert.equal(
      dayChangeDisplayLabel({ changeBasis: 'open', freshness: 'eod', session: 'closed' }),
      null,
    );
  });
  it("returns 'Today' for previousClose during regular hours", () => {
    assert.equal(
      dayChangeDisplayLabel({ changeBasis: 'previousClose', freshness: 'live', session: 'regular' }),
      'Today',
    );
  });
  it("returns 'Today' for previousClose when market is closed", () => {
    assert.equal(
      dayChangeDisplayLabel({ changeBasis: 'previousClose', freshness: 'eod', session: 'closed' }),
      'Today',
    );
  });
  it("returns 'Pre-market' for previousClose during pre-market session", () => {
    assert.equal(
      dayChangeDisplayLabel({ changeBasis: 'previousClose', freshness: 'live', session: 'pre-market' }),
      'Pre-market',
    );
  });
  it("returns 'After hours' for previousClose during after-hours session", () => {
    assert.equal(
      dayChangeDisplayLabel({ changeBasis: 'previousClose', freshness: 'live', session: 'after-hours' }),
      'After hours',
    );
  });
  it("returns '24h' for crypto regardless of session", () => {
    assert.equal(
      dayChangeDisplayLabel({ changeBasis: '24h', freshness: 'live', session: 'after-hours' }),
      '24h',
    );
    assert.equal(
      dayChangeDisplayLabel({ changeBasis: '24h', freshness: 'eod', session: 'closed' }),
      '24h',
    );
  });
  it("returns 'Recent' for provider basis", () => {
    assert.equal(
      dayChangeDisplayLabel({ changeBasis: 'provider', freshness: 'eod', session: 'regular' }),
      'Recent',
    );
  });
});

// ---------------------------------------------------------------------------
// aggregatePositions short-position suppression
// ---------------------------------------------------------------------------
describe('aggregatePositions short suppression', () => {
  it('drops symbols whose net quantity is negative', () => {
    // The activity-importer scenario: we have SELL transactions for MSFT
    // and FBTC (because the user previously held them) but no historical
    // BUYs, because the broker activity feed only goes back 90 days.
    // The math should not surface "you hold -52 MSFT" as a position.
    const onlySells: Transaction[] = [
      { id: 's1', accountId: 'a1', symbol: 'MSFT', date: '2026-04-07', quantity: -52, pricePerUnit: 371.34, currency: 'USD' },
      { id: 's2', accountId: 'a1', symbol: 'FBTC', date: '2026-04-09', quantity: -276, pricePerUnit: 62.59, currency: 'USD' },
      { id: 'b1', accountId: 'a1', symbol: 'TSLA', date: '2026-05-07', quantity: 0.97, pricePerUnit: 245.22, currency: 'USD' },
    ];
    const positions = aggregatePositions(onlySells);
    assert.equal(positions.length, 1);
    assert.equal(positions[0].symbol, 'TSLA');
  });

  it('keeps symbols whose net quantity is positive even after partial sells', () => {
    const partial: Transaction[] = [
      { id: 'b1', accountId: 'a1', symbol: 'AAPL', date: '2026-01-01', quantity: 10, pricePerUnit: 150, currency: 'USD' },
      { id: 's1', accountId: 'a1', symbol: 'AAPL', date: '2026-02-01', quantity: -3, pricePerUnit: 160, currency: 'USD' },
    ];
    const positions = aggregatePositions(partial);
    assert.equal(positions.length, 1);
    assert.equal(positions[0].symbol, 'AAPL');
    assert.ok(Math.abs(positions[0].quantity - 7) < 1e-9);
  });
});

describe('heldSymbolsAcrossAccounts', () => {
  it('returns only current positive positions without cross-account cancellation', () => {
    const rows: Transaction[] = [
      { id: 'a-buy', accountId: 'a', symbol: 'AAPL', date: '2026-01-01', quantity: 3, pricePerUnit: 100, currency: 'USD' },
      // An incomplete ledger in another account must not cancel account a's holding.
      { id: 'b-sell', accountId: 'b', symbol: 'AAPL', date: '2026-02-01', quantity: -5, pricePerUnit: 110, currency: 'USD' },
      { id: 'gone-buy', accountId: 'a', symbol: 'GONE', date: '2026-01-01', quantity: 2, pricePerUnit: 10, currency: 'USD' },
      { id: 'gone-sell', accountId: 'a', symbol: 'GONE', date: '2026-03-01', quantity: -2, pricePerUnit: 12, currency: 'USD' },
      { id: 'msft-buy', accountId: 'b', symbol: 'MSFT', date: '2026-01-01', quantity: 1, pricePerUnit: 300, currency: 'USD' },
    ];

    assert.deepEqual(heldSymbolsAcrossAccounts(rows), ['AAPL', 'MSFT']);
  });
});

// ---------------------------------------------------------------------------
// Snapshot/activity dedup — prevents the household-value double-count where
// a "Pull positions" snapshot row and a "Sync activity" BUY row for the same
// (account, symbol) are both summed.
// ---------------------------------------------------------------------------
import { dropImportedSnapshotsWhereActivityExists, summarizeByAccount } from './portfolio.js';

describe('dropImportedSnapshotsWhereActivityExists', () => {
  const baseSnap: Transaction = {
    id: 'snap', accountId: 'a1', symbol: 'NBIS', date: '2026-05-07',
    quantity: 199.806, pricePerUnit: 175.17, currency: 'USD', notes: 'imported',
  };
  const baseAct: Transaction = {
    id: 'act', accountId: 'a1', symbol: 'NBIS', date: '2026-04-15',
    quantity: 199.806, pricePerUnit: 170, currency: 'USD',
    notes: 'YOU BOUGHT NEBIUS GROUP N V COM USD0.01 CL A (NBIS) (Cash)',
    sourceFingerprint: 'deadbeefcafef00d',
  };

  it('drops the legacy snapshot row when an activity row exists for same (account, symbol)', () => {
    const out = dropImportedSnapshotsWhereActivityExists([baseSnap, baseAct]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'act');
  });

  it('drops modern pos:* snapshot rows the same way', () => {
    const posSnap: Transaction = { ...baseSnap, id: 'pos-snap', notes: undefined, sourceFingerprint: 'pos:NBIS' };
    const out = dropImportedSnapshotsWhereActivityExists([posSnap, baseAct]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'act');
  });

  it('keeps the snapshot when only the snapshot exists (no activity for that pair)', () => {
    const out = dropImportedSnapshotsWhereActivityExists([baseSnap]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'snap');
  });

  it('keeps the snapshot when activity exists for a DIFFERENT account', () => {
    const otherAcct: Transaction = { ...baseAct, accountId: 'a2', id: 'act-a2' };
    const out = dropImportedSnapshotsWhereActivityExists([baseSnap, otherAcct]);
    // a1's snapshot must survive even though there's activity for a2/NBIS.
    assert.equal(out.length, 2);
    assert.ok(out.some((t) => t.id === 'snap'));
  });

  it('keeps the snapshot when activity exists for a DIFFERENT symbol in same account', () => {
    const otherSym: Transaction = { ...baseAct, symbol: 'TSLA', id: 'act-tsla' };
    const out = dropImportedSnapshotsWhereActivityExists([baseSnap, otherSym]);
    assert.equal(out.length, 2);
  });

  it('does not drop hand-entered rows (notes do not start with "imported")', () => {
    const handEntered: Transaction = {
      ...baseSnap, id: 'manual', notes: 'bought at brokerage in person',
    };
    const out = dropImportedSnapshotsWhereActivityExists([handEntered, baseAct]);
    // both survive — the hand-entered row is not a snapshot.
    assert.equal(out.length, 2);
  });

  it('returns the input unchanged when no activity rows are present', () => {
    const out = dropImportedSnapshotsWhereActivityExists([baseSnap]);
    assert.equal(out, out); // identity check happens implicitly via length
    assert.equal(out.length, 1);
  });
});

describe('summarizeByAccount snapshot/activity dedup (regression)', () => {
  it('counts shares once when both a snapshot row and activity rows exist', () => {
    // Reproduces the household-value bug exactly: NBIS @ 199.806 shares
    // shows up in both the position snapshot AND the BUY activity row.
    // Before the fix, summarizeByAccount summed them → 399.612 shares.
    const accounts: Account[] = [
      { id: 'a1', name: 'Alex · Fidelity HSA', type: 'HSA', cashBalance: 0, currency: 'USD' },
    ];
    const allTxs: Transaction[] = [
      { id: 'snap', accountId: 'a1', symbol: 'NBIS', date: '2026-05-07',
        quantity: 199.806, pricePerUnit: 175.17, currency: 'USD', notes: 'imported' },
      { id: 'act', accountId: 'a1', symbol: 'NBIS', date: '2026-04-15',
        quantity: 199.806, pricePerUnit: 170, currency: 'USD',
        notes: 'YOU BOUGHT NEBIUS GROUP N V COM USD0.01 CL A (NBIS) (Cash)',
        sourceFingerprint: 'deadbeefcafef00d' },
    ];
    const quotes: Quote[] = [
      { symbol: 'NBIS', price: 200, currency: 'USD', asOf: 1778191200 },
    ];
    const summary = summarizeByAccount(accounts, allTxs, quotes);
    assert.equal(summary.accounts.length, 1);
    const positionRows = summary.accounts[0].rows.filter((r) => r.kind === 'position');
    assert.equal(positionRows.length, 1);
    // Activity qty wins; snapshot dropped.
    assert.ok(Math.abs(positionRows[0].quantity! - 199.806) < 1e-9);
    // Market value reflects single qty, not double.
    assert.ok(Math.abs(summary.grandTotalMarketValue - 199.806 * 200) < 1e-6);
  });
});

// ---------------------------------------------------------------------------
// Portfolio's one gain/loss percent: a synthetic household as main computed it
// ---------------------------------------------------------------------------

/** The dollar figures main computed for this household before the change (879a9dce), to the last bit. */
const MAIN_DOLLARS = {
  byAccount: {
    accounts: [
      {
        id: 'syn-a',
        cashValue: 1234.56,
        positionsMarketValue: 3214.15,
        totalMarketValue: 4448.71,
        totalCostBasis: 3960.5499999999997,
        totalUnrealizedPnL: 488.1600000000003,
        rows: [
          ['AAPL', 2061.07, 1726, 335.07000000000016],
          ['MSFT', 1153.08, 999.99, 153.08999999999992],
          ['Cash', 1234.56, 1234.56, 0],
        ],
      },
      {
        id: 'syn-b',
        cashValue: 250.05,
        positionsMarketValue: 3839.7714000000005,
        totalMarketValue: 4089.8214000000007,
        totalCostBasis: 2828.5945,
        totalUnrealizedPnL: 1261.2269000000006,
        rows: [
          ['VTI', 3544.4964000000004, 2594.1845, 950.3119000000006],
          ['AAPL', 1405.275, 1203, 202.2750000000001],
          ['NBIS260731P00165000', -1110, -1218.64, 108.6400000000001],
          ['Cash', 250.05, 250.05, 0],
        ],
      },
      {
        id: 'syn-c',
        cashValue: 0,
        positionsMarketValue: 2618.14,
        totalMarketValue: 2618.14,
        totalCostBasis: 2296.1,
        totalUnrealizedPnL: 322.03999999999996,
        rows: [
          ['SGOV', 2009.8, 2009.6, 0.20000000000004547],
          ['NVDA', 608.34, 286.5, 321.84000000000003],
        ],
      },
      {
        id: 'syn-d',
        cashValue: 500,
        positionsMarketValue: 0,
        totalMarketValue: 500,
        totalCostBasis: 500,
        totalUnrealizedPnL: 0,
        rows: [
          ['Cash', 500, 500, 0],
        ],
      },
    ],
    grandTotalMarketValue: 11656.6714,
    grandTotalCostBasis: 9585.2445,
    grandTotalUnrealizedPnL: 2071.4268999999986,
  },
  bySymbol: {
    rows: [
      [
        'VTI',
        3544.4964000000004,
        2594.1845,
        950.3119000000006,
        [
          ['syn-b', 3544.4964000000004, 2594.1845, 950.3119000000006],
        ],
      ],
      [
        'AAPL',
        3466.3450000000003,
        2929,
        537.3450000000003,
        [
          ['syn-a', 2061.07, 1726, 335.07000000000016],
          ['syn-b', 1405.275, 1203, 202.2750000000001],
        ],
      ],
      [
        'SGOV',
        2009.8,
        2009.6,
        0.20000000000004547,
        [
          ['syn-c', 2009.8, 2009.6, 0.20000000000004547],
        ],
      ],
      [
        'MSFT',
        1153.08,
        999.99,
        153.08999999999992,
        [
          ['syn-a', 1153.08, 999.99, 153.08999999999992],
        ],
      ],
      [
        'NVDA',
        608.34,
        286.5,
        321.84000000000003,
        [
          ['syn-c', 608.34, 286.5, 321.84000000000003],
        ],
      ],
      [
        'NBIS260731P00165000',
        -1110,
        -1218.64,
        108.6400000000001,
        [
          ['syn-b', -1110, -1218.64, 108.6400000000001],
        ],
      ],
    ],
    cash: 1984.61,
    totalMarketValue: 11656.671400000001,
    totalCostBasis: 9585.244499999999,
    totalUnrealizedPnL: 2071.426900000002,
  },
};

/** The cash-inclusive percents main showed for it (the retired ones), and each holding's own. */
const MAIN_PERCENTS = {
  accounts: [
    ['syn-a', 12.325560843822204],
    ['syn-b', 44.58846610922847],
    ['syn-c', 14.025521536518443],
    ['syn-d', 0],
  ],
  household: 21.610579677962292,
  combined: 21.610579677962335,
  accountRows: [
    [
      ['AAPL', 19.413093858632685],
      ['MSFT', 15.309153091530908],
      ['Cash', 0],
    ],
    [
      ['VTI', 36.63239449622803],
      ['AAPL', 16.814214463840408],
      ['NBIS260731P00165000', 8.914855904943222],
      ['Cash', 0],
    ],
    [
      ['SGOV', 0.00995222929936532],
      ['NVDA', 112.33507853403142],
    ],
    [
      ['Cash', 0],
    ],
  ],
  symbolRows: [
    [
      'VTI',
      36.63239449622803,
      [36.63239449622803],
    ],
    [
      'AAPL',
      18.34568111983613,
      [19.413093858632685, 16.814214463840408],
    ],
    [
      'SGOV',
      0.00995222929936532,
      [0.00995222929936532],
    ],
    [
      'MSFT',
      15.309153091530908,
      [15.309153091530908],
    ],
    [
      'NVDA',
      112.33507853403142,
      [112.33507853403142],
    ],
    [
      'NBIS260731P00165000',
      8.914855904943222,
      [8.914855904943222],
    ],
  ],
};

// ---------------------------------------------------------------------------
// Portfolio's one gain/loss percent: positions only, cash left out (Root, 05:57Z and 09:32Z)
// ---------------------------------------------------------------------------

describe("positionsPnLPercent: Portfolio's one gain/loss percent", () => {
  it("is the gain or loss over the positions' cost, with the cost's size as the base", () => {
    assert.equal(positionsPnLPercent(500, 1000), 50);
    assert.equal(positionsPnLPercent(-200, 1000), -20);
    assert.equal(positionsPnLPercent(0, 1000), 0);
    // A short option's credit is a negative cost: its size is the base, so a gain still reads as a gain.
    assert.equal(positionsPnLPercent(100, -500), 20);
  });

  it('is null, never 0, when it is unknown: a missing price, no cost (zero within float noise), or no number', () => {
    assert.equal(positionsPnLPercent(500, 1000, false), null);
    assert.equal(positionsPnLPercent(500, 0), null);
    // Float residue from costs that cancel (0.1 + 0.2 - 0.3) is no cost.
    assert.equal(positionsPnLPercent(500, 0.1 + 0.2 - 0.3), null);
    assert.equal(positionsPnLPercent(500, -1e-13), null);
    assert.equal(positionsPnLPercent(Number.NaN, 1000), null);
    assert.equal(positionsPnLPercent(500, Number.POSITIVE_INFINITY), null);
  });

  it('keeps a real cost under a cent: 0.001 shares bought at $4, now $5, gained 25%', () => {
    const cost = 0.001 * 4;
    const gain = 0.001 * 5 - cost;
    assert.ok(Math.abs(cost - 0.004) < 1e-15);
    assert.equal(formatPercent(positionsPnLPercent(gain, cost)!, 2, false), '25.00%');
  });

  it('reads a gain or loss within float noise of zero as exactly 0, never -0.00%', () => {
    assert.ok(Object.is(positionsPnLPercent(-2.8e-17, 1), 0));
    assert.ok(Object.is(positionsPnLPercent(-1e-10, 100), 0));
    assert.equal(formatPercent(positionsPnLPercent(-1e-14, 0.5)!, 2, false), '0.00%');
    // A real move keeps its sign and size.
    assert.equal(positionsPnLPercent(-0.01, 100), -0.01);
  });
});

/** The dollar figures of both summaries, in the shape MAIN_DOLLARS was recorded in. */
function dollarsOf(byAccount: MultiAccountSummary, bySymbol: SymbolSummary) {
  return {
    byAccount: {
      accounts: byAccount.accounts.map((account) => ({
        id: account.account.id,
        cashValue: account.cashValue,
        positionsMarketValue: account.positionsMarketValue,
        totalMarketValue: account.totalMarketValue,
        totalCostBasis: account.totalCostBasis,
        totalUnrealizedPnL: account.totalUnrealizedPnL,
        rows: account.rows.map((row) => [row.symbol, row.marketValue, row.costBasis, row.unrealizedPnL]),
      })),
      grandTotalMarketValue: byAccount.grandTotalMarketValue,
      grandTotalCostBasis: byAccount.grandTotalCostBasis,
      grandTotalUnrealizedPnL: byAccount.grandTotalUnrealizedPnL,
    },
    bySymbol: {
      rows: bySymbol.rows.map((row) => [
        row.symbol, row.marketValue, row.costBasis, row.unrealizedPnL,
        row.contributors.map((contributor) => [contributor.accountId, contributor.marketValue, contributor.costBasis, contributor.unrealizedPnL]),
      ]),
      cash: bySymbol.cash.total,
      totalMarketValue: bySymbol.totalMarketValue,
      totalCostBasis: bySymbol.totalCostBasis,
      totalUnrealizedPnL: bySymbol.totalUnrealizedPnL,
    },
  };
}

describe('the account, household and combined summaries share one positions-only gain/loss percent', () => {
  const quote = (symbol: string, price: number): Quote => ({ symbol, price, currency: 'USD', asOf: 0 });
  const buy = (id: string, accountId: string, symbol: string, quantity: number, pricePerUnit: number): Transaction => ({
    id, accountId, symbol, date: '2025-01-02', quantity, pricePerUnit, currency: 'USD',
  });
  const both = (accounts: Account[], transactions: Transaction[], quotes: Quote[]) => ({
    byAccount: summarizeByAccount(accounts, transactions, quotes),
    bySymbol: summarizeBySymbol(accounts, transactions, quotes),
  });

  it('with no cash: the gain over the cost, the same for the account, the household and the combined holdings', () => {
    const { byAccount, bySymbol } = both([acc('a', 'A')], [buy('t1', 'a', 'X', 10, 100)], [quote('X', 130)]);
    assert.equal(byAccount.accounts[0].positionsUnrealizedPnLPercent, 30);
    assert.equal(byAccount.positionsUnrealizedPnLPercent, 30);
    assert.equal(bySymbol.positionsUnrealizedPnLPercent, 30);
    assert.equal(bySymbol.rows[0].unrealizedPnLPercent, 30);
  });

  it('with cash: leaves it out, so $500 on $1,000 of positions is 50%, where the retired percent read 25% of $2,000', () => {
    const { byAccount, bySymbol } = both([acc('a', 'A', 1000)], [buy('t1', 'a', 'AAPL', 10, 100)], [quote('AAPL', 150)]);
    const account = byAccount.accounts[0];
    assert.equal(account.totalMarketValue, 2500);
    assert.equal(account.totalCostBasis, 2000);
    assert.equal(account.totalUnrealizedPnL, 500);
    assert.equal((account.totalUnrealizedPnL / account.totalCostBasis) * 100, 25);
    assert.equal(account.positionsUnrealizedPnLPercent, 50);
    assert.equal(byAccount.positionsUnrealizedPnLPercent, 50);
    assert.equal(bySymbol.positionsUnrealizedPnLPercent, 50);
    assert.equal(account.rows.find((row) => row.kind === 'cash')?.unrealizedPnLPercent, null);
  });

  it('a missing price: null in every scope and for that holding (never 0%, never -100%), the dollars as before', () => {
    const { byAccount, bySymbol } = both(
      [acc('a', 'A', 100)],
      [buy('t1', 'a', 'X', 10, 100), buy('t2', 'a', 'NOQUOTE', 5, 20)],
      [quote('X', 150)],
    );
    assert.equal(byAccount.valueAvailable, false);
    assert.equal(byAccount.grandTotalUnrealizedPnL, 0);
    assert.equal(bySymbol.totalUnrealizedPnL, 0);
    assert.equal(byAccount.accounts[0].positionsUnrealizedPnLPercent, null);
    assert.equal(byAccount.positionsUnrealizedPnLPercent, null);
    assert.equal(bySymbol.positionsUnrealizedPnLPercent, null);
    assert.equal(byAccount.accounts[0].rows.find((row) => row.symbol === 'NOQUOTE')?.unrealizedPnLPercent, null);
    const unpriced = bySymbol.rows.find((row) => row.symbol === 'NOQUOTE')!;
    assert.equal(unpriced.unrealizedPnL, -100);
    assert.equal(unpriced.unrealizedPnLPercent, null);
    assert.equal(unpriced.contributors[0].unrealizedPnLPercent, null);
    // The priced holding keeps its own percent.
    assert.equal(byAccount.accounts[0].rows.find((row) => row.symbol === 'X')?.unrealizedPnLPercent, 50);
    assert.equal(bySymbol.rows.find((row) => row.symbol === 'X')?.unrealizedPnLPercent, 50);
  });

  it('no cost (a $0 basis): null in every scope and for that holding, its gain still in dollars', () => {
    const { byAccount, bySymbol } = both([acc('a', 'A')], [buy('t1', 'a', 'GIFT', 5, 0)], [quote('GIFT', 40)]);
    const account = byAccount.accounts[0];
    assert.equal(account.totalUnrealizedPnL, 200);
    assert.equal(bySymbol.totalUnrealizedPnL, 200);
    assert.equal(account.positionsUnrealizedPnLPercent, null);
    assert.equal(byAccount.positionsUnrealizedPnLPercent, null);
    assert.equal(bySymbol.positionsUnrealizedPnLPercent, null);
    assert.equal(account.rows[0].unrealizedPnLPercent, null);
    assert.equal(bySymbol.rows[0].unrealizedPnLPercent, null);
    assert.equal(bySymbol.rows[0].contributors[0].unrealizedPnLPercent, null);
  });

  it('a real cost under a cent keeps its percent in every scope: 0.001 shares at $4, now $5, read 25.00%', () => {
    const { byAccount, bySymbol } = both([acc('a', 'A')], [buy('t1', 'a', 'TINY', 0.001, 4)], [quote('TINY', 5)]);
    const shown = (percent: number | null) => (percent == null ? null : formatPercent(percent, 2, false));
    assert.deepEqual(
      [byAccount.accounts[0].positionsUnrealizedPnLPercent, byAccount.positionsUnrealizedPnLPercent, bySymbol.positionsUnrealizedPnLPercent,
        byAccount.accounts[0].rows[0].unrealizedPnLPercent, bySymbol.rows[0].unrealizedPnLPercent].map(shown),
      ['25.00%', '25.00%', '25.00%', '25.00%', '25.00%'],
    );
  });

  // Two accounts summing to a percent on a rounding boundary: $0.01 gained on $200.00. Summed account by account and
  // symbol by symbol, the same gain could round to 0.01% and 0.00% (3ddfcd26's review of #252); one canonical sum per
  // scope reads one percent.
  for (const price of [100.005, 101.005]) {
    it(`a rounding boundary (one SYN each at $33.33 and $166.67, $0.10 cash, now $${price}): the household and the combined holdings read one percent`, () => {
      const { byAccount, bySymbol } = both(
        [acc('a', 'A', 0), acc('b', 'B', 0.1)],
        [buy('t1', 'a', 'SYN', 1, 33.33), buy('t2', 'b', 'SYN', 1, 166.67)],
        [quote('SYN', price)],
      );
      assert.equal(bySymbol.positionsUnrealizedPnLPercent, byAccount.positionsUnrealizedPnLPercent);
      assert.equal(
        formatPercent(bySymbol.positionsUnrealizedPnLPercent!, 2, false),
        formatPercent(byAccount.positionsUnrealizedPnLPercent!, 2, false),
      );
      // A holding across accounts is a scope too: SYN is all they hold, so its row reads the same percent.
      assert.equal(bySymbol.rows[0].unrealizedPnLPercent, byAccount.positionsUnrealizedPnLPercent);
      // The dollars each view shows agree too, as before.
      assert.equal(formatCurrency(bySymbol.totalUnrealizedPnL), formatCurrency(byAccount.grandTotalUnrealizedPnL));
      // A one-account scope reads the same percent as that account.
      for (const account of byAccount.accounts) {
        const alone = both([account.account], [buy('t1', 'a', 'SYN', 1, 33.33), buy('t2', 'b', 'SYN', 1, 166.67)], [quote('SYN', price)]);
        assert.equal(alone.byAccount.positionsUnrealizedPnLPercent, account.positionsUnrealizedPnLPercent, account.account.id);
        assert.equal(alone.bySymbol.positionsUnrealizedPnLPercent, account.positionsUnrealizedPnLPercent, account.account.id);
      }
    });
  }

  // A true zero (the quote equals the average cost) summed two ways can land a hair either side of zero; every view
  // reads 0.00% beside it, never "-0.00%" beside a gain (the lead's review of 643bae06 and 7f58142a).
  it('a true zero across two accounts: the row across them, the household and the combined holdings read 0.00%', () => {
    const { byAccount, bySymbol } = both(
      [acc('a', 'A', 100), acc('b', 'B', 0.1)],
      [buy('t1', 'a', 'SYNZ', 1, 0.1), buy('t2', 'b', 'SYNZ', 2, 0.2)],
      [quote('SYNZ', (1 * 0.1 + 2 * 0.2) / 3)],
    );
    const shown = (percent: number | null) => (percent == null ? '—' : formatPercent(percent, 2, false));
    assert.deepEqual(
      [shown(bySymbol.rows[0].unrealizedPnLPercent), shown(byAccount.positionsUnrealizedPnLPercent), shown(bySymbol.positionsUnrealizedPnLPercent)],
      ['0.00%', '0.00%', '0.00%'],
    );
    assert.equal(bySymbol.positionsUnrealizedPnLPercent, byAccount.positionsUnrealizedPnLPercent);
  });

  it('a true zero in one account: its row reads the same 0.00% in the account view and the combined view, as do its totals', () => {
    const { byAccount, bySymbol } = both(
      [acc('a', 'A', 100)],
      [buy('t1', 'a', 'SYNZ', 0.5, 0.1), buy('t2', 'a', 'SYNZ', 2, 0.2)],
      [quote('SYNZ', (0.5 * 0.1 + 2 * 0.2) / 2.5)],
    );
    const shown = (percent: number | null) => (percent == null ? '—' : formatPercent(percent, 2, false));
    const accountRow = byAccount.accounts[0].rows.find((row) => row.kind === 'position')!;
    assert.equal(accountRow.unrealizedPnLPercent, bySymbol.rows[0].unrealizedPnLPercent);
    assert.deepEqual(
      [accountRow.unrealizedPnLPercent, bySymbol.rows[0].unrealizedPnLPercent, byAccount.accounts[0].positionsUnrealizedPnLPercent,
        byAccount.positionsUnrealizedPnLPercent, bySymbol.positionsUnrealizedPnLPercent].map(shown),
      ['0.00%', '0.00%', '0.00%', '0.00%', '0.00%'],
    );
  });

  describe('on a synthetic household of four accounts: with cash, with a short put, with no cash, cash only', () => {
    const put = 'NBIS260731P00165000';
    const accounts: Account[] = [
      { id: 'syn-a', name: 'Synthetic Individual', type: 'Individual', cashBalance: 1234.56, currency: 'USD' },
      { id: 'syn-b', name: 'Synthetic Joint', type: 'Joint', cashBalance: 250.05, currency: 'USD' },
      { id: 'syn-c', name: 'Synthetic Roth IRA', type: 'Roth IRA', cashBalance: 0, currency: 'USD' },
      { id: 'syn-d', name: 'Synthetic Cash', type: 'Individual', cashBalance: 500, currency: 'USD' },
    ];
    const transactions: Transaction[] = [
      { id: 'a1', accountId: 'syn-a', symbol: 'AAPL', date: '2025-01-10', quantity: 10, pricePerUnit: 150.25, fees: 1, currency: 'USD' },
      { id: 'a2', accountId: 'syn-a', symbol: 'AAPL', date: '2025-03-01', quantity: 5, pricePerUnit: 170.1, fees: 1, currency: 'USD' },
      { id: 'a3', accountId: 'syn-a', symbol: 'AAPL', date: '2025-04-15', quantity: -4, pricePerUnit: 180, fees: 1, currency: 'USD' },
      { id: 'a4', accountId: 'syn-a', symbol: 'MSFT', date: '2025-02-01', quantity: 3, pricePerUnit: 333.33, currency: 'USD' },
      { id: 'b1', accountId: 'syn-b', symbol: 'AAPL', date: '2025-02-15', quantity: 7.5, pricePerUnit: 160.4, currency: 'USD' },
      { id: 'b2', accountId: 'syn-b', symbol: 'VTI', date: '2025-05-01', quantity: 12.345, pricePerUnit: 210.1, fees: 0.5, currency: 'USD' },
      {
        id: 'b3', accountId: 'syn-b', symbol: put, date: '2026-07-10', quantity: -2, pricePerUnit: 6.1, fees: 1.36, currency: 'USD',
        instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
      },
      { id: 'c1', accountId: 'syn-c', symbol: 'SGOV', date: '2025-06-01', quantity: 25, pricePerUnit: 100.48, currency: 'USD' },
      { id: 'c2', accountId: 'syn-c', symbol: 'SGOV', date: '2025-08-01', quantity: -5, pricePerUnit: 100.52, currency: 'USD' },
      { id: 'c3', accountId: 'syn-c', symbol: 'NVDA', date: '2024-11-01', quantity: 3, pricePerUnit: 95.5, currency: 'USD' },
    ];
    const quotes: Quote[] = [
      quote('AAPL', 187.37), quote('MSFT', 384.36), quote('VTI', 287.12), quote(put, 5.55), quote('SGOV', 100.49), quote('NVDA', 202.78),
    ];
    const { byAccount, bySymbol } = both(accounts, transactions, quotes);
    const near = (actual: number | null, expected: number) => actual != null && Math.abs(actual - expected) < 1e-9;
    const shown = (percent: number | null) => (percent == null ? null : formatPercent(percent, 2, false));

    it('keeps every dollar figure exactly as main computed it', () => {
      assert.deepEqual(dollarsOf(byAccount, bySymbol), MAIN_DOLLARS);
    });

    it('gives each account G/L ÷ (cost basis − cash), and none to the account with cash only', () => {
      for (const account of byAccount.accounts) {
        if (!account.rows.some((row) => row.kind === 'position')) {
          assert.equal(account.positionsUnrealizedPnLPercent, null, account.account.id);
          continue;
        }
        const expected = (account.totalUnrealizedPnL / Math.abs(account.totalCostBasis - account.cashValue)) * 100;
        assert.ok(near(account.positionsUnrealizedPnLPercent, expected), account.account.id);
      }
    });

    it("gives the household and the combined holdings one percent: all the gain over all the positions' cost", () => {
      const cash = byAccount.accounts.reduce((sum, account) => sum + account.cashValue, 0);
      const expected = (byAccount.grandTotalUnrealizedPnL / (byAccount.grandTotalCostBasis - cash)) * 100;
      assert.ok(near(byAccount.positionsUnrealizedPnLPercent, expected));
      // One canonical sum per scope: the same number to the bit, not merely close.
      assert.equal(bySymbol.positionsUnrealizedPnLPercent, byAccount.positionsUnrealizedPnLPercent);
      assert.equal(shown(bySymbol.positionsUnrealizedPnLPercent), shown(byAccount.positionsUnrealizedPnLPercent));
    });

    it('old vs new: the cash-inclusive percents it retires, and the positions-only ones in their place', () => {
      const before = Object.fromEntries(MAIN_PERCENTS.accounts.map(([id, percent]) => [id, shown(percent as number)]));
      const after = Object.fromEntries(byAccount.accounts.map((account) => [account.account.id, shown(account.positionsUnrealizedPnLPercent)]));
      assert.deepEqual(before, { 'syn-a': '12.33%', 'syn-b': '44.59%', 'syn-c': '14.03%', 'syn-d': '0.00%' });
      // Higher where an account holds cash, the same where it holds none, and unknown (not 0%) with cash alone.
      assert.deepEqual(after, { 'syn-a': '17.91%', 'syn-b': '48.91%', 'syn-c': '14.03%', 'syn-d': null });
      assert.deepEqual([shown(MAIN_PERCENTS.household), shown(MAIN_PERCENTS.combined)], ['21.61%', '21.61%']);
      assert.deepEqual([shown(byAccount.positionsUnrealizedPnLPercent), shown(bySymbol.positionsUnrealizedPnLPercent)], ['27.25%', '27.25%']);
      // The cash-inclusive fields are gone, so no view can show them.
      assert.equal('totalUnrealizedPnLPercent' in byAccount.accounts[0], false);
      assert.equal('grandTotalUnrealizedPnLPercent' in byAccount, false);
      assert.equal('totalUnrealizedPnLPercent' in bySymbol, false);
    });

    it("keeps each holding's own percent to the bit, and gives cash none", () => {
      byAccount.accounts.forEach((account, index) => {
        assert.deepEqual(
          account.rows.map((row) => [row.symbol, row.unrealizedPnLPercent]),
          MAIN_PERCENTS.accountRows[index].map(([symbol, percent]) => [symbol, symbol === 'Cash' ? null : percent]),
        );
      });
      assert.deepEqual(
        bySymbol.rows.map((row) => [row.symbol, row.unrealizedPnLPercent, row.contributors.map((contributor) => contributor.unrealizedPnLPercent)]),
        MAIN_PERCENTS.symbolRows,
      );
    });
  });
});

/**
 * What main's summarizePortfolio (the mobile app's summary) computed for the same synthetic trades (879a9dce): its
 * dollars, and its percents, which were already over the positions' cost (it holds no cash).
 */
const MAIN_PORTFOLIO = {
  dollars: {
    totalCostBasis: 7596.101166666665,
    totalMarketValue: 9672.0614,
    totalUnrealizedPnL: 2075.960233333335,
    positions: [
      ['AAPL', 3466.3450000000003, 2924.4666666666667, 541.8783333333336],
      ['MSFT', 1153.08, 999.99, 153.08999999999992],
      ['VTI', 3544.4964000000004, 2594.1845, 950.3119000000006],
      ['NBIS260731P00165000', -1110, -1218.64, 108.6400000000001],
      ['SGOV', 2009.8, 2009.6, 0.20000000000004547],
      ['NVDA', 608.34, 286.5, 321.84000000000003],
    ],
  },
  percents: {
    total: 27.329286271792924,
    positions: [
      ['AAPL', 18.529133517222522],
      ['MSFT', 15.309153091530908],
      ['VTI', 36.63239449622803],
      ['NBIS260731P00165000', 8.914855904943222],
      ['SGOV', 0.00995222929936532],
      ['NVDA', 112.33507853403142],
    ],
  },
};

describe('summarizePortfolio, the mobile summary, takes its percents from the same definition', () => {
  const quote = (symbol: string, price: number): Quote => ({ symbol, price, currency: 'USD', asOf: 0 });
  const buy = (id: string, symbol: string, quantity: number, pricePerUnit: number): Transaction => ({
    id, accountId: 'a', symbol, date: '2025-01-02', quantity, pricePerUnit, currency: 'USD',
  });
  const put = 'NBIS260731P00165000';
  const transactions: Transaction[] = [
    { id: 'a1', accountId: 'syn-a', symbol: 'AAPL', date: '2025-01-10', quantity: 10, pricePerUnit: 150.25, fees: 1, currency: 'USD' },
    { id: 'a2', accountId: 'syn-a', symbol: 'AAPL', date: '2025-03-01', quantity: 5, pricePerUnit: 170.1, fees: 1, currency: 'USD' },
    { id: 'a3', accountId: 'syn-a', symbol: 'AAPL', date: '2025-04-15', quantity: -4, pricePerUnit: 180, fees: 1, currency: 'USD' },
    { id: 'a4', accountId: 'syn-a', symbol: 'MSFT', date: '2025-02-01', quantity: 3, pricePerUnit: 333.33, currency: 'USD' },
    { id: 'b1', accountId: 'syn-b', symbol: 'AAPL', date: '2025-02-15', quantity: 7.5, pricePerUnit: 160.4, currency: 'USD' },
    { id: 'b2', accountId: 'syn-b', symbol: 'VTI', date: '2025-05-01', quantity: 12.345, pricePerUnit: 210.1, fees: 0.5, currency: 'USD' },
    {
      id: 'b3', accountId: 'syn-b', symbol: put, date: '2026-07-10', quantity: -2, pricePerUnit: 6.1, fees: 1.36, currency: 'USD',
      instrumentType: 'option', contractMultiplier: 100, positionEffect: 'open',
    },
    { id: 'c1', accountId: 'syn-c', symbol: 'SGOV', date: '2025-06-01', quantity: 25, pricePerUnit: 100.48, currency: 'USD' },
    { id: 'c2', accountId: 'syn-c', symbol: 'SGOV', date: '2025-08-01', quantity: -5, pricePerUnit: 100.52, currency: 'USD' },
    { id: 'c3', accountId: 'syn-c', symbol: 'NVDA', date: '2024-11-01', quantity: 3, pricePerUnit: 95.5, currency: 'USD' },
  ];
  const quotes: Quote[] = [
    quote('AAPL', 187.37), quote('MSFT', 384.36), quote('VTI', 287.12), quote(put, 5.55), quote('SGOV', 100.49), quote('NVDA', 202.78),
  ];

  it("a normal case: each holding reads positionsPnLPercent, main's to the bit; the total the canonical sum; the dollars main's to the bit", () => {
    const summary = summarizePortfolio(transactions, quotes);
    assert.deepEqual({
      totalCostBasis: summary.totalCostBasis,
      totalMarketValue: summary.totalMarketValue,
      totalUnrealizedPnL: summary.totalUnrealizedPnL,
      positions: summary.positions.map((position) => [position.symbol, position.marketValue, position.costBasis, position.unrealizedPnL]),
    }, MAIN_PORTFOLIO.dollars);
    // The total is the canonical sum over the holdings, holding by holding (as every web scope's): main's value, summed
    // in one fixed way, so equal to main's within float noise and in what it shows.
    const canonical = positionsPnLPercent(
      summary.positions.reduce((sum, position) => sum + (position.marketValue - position.costBasis), 0),
      summary.positions.reduce((sum, position) => sum + position.costBasis, 0),
    );
    assert.equal(summary.positionsUnrealizedPnLPercent, canonical);
    assert.ok(Math.abs(summary.positionsUnrealizedPnLPercent! - MAIN_PORTFOLIO.percents.total) < 1e-9);
    assert.equal(formatPercent(summary.positionsUnrealizedPnLPercent!), formatPercent(MAIN_PORTFOLIO.percents.total));
    for (const position of summary.positions) {
      assert.equal(position.unrealizedPnLPercent, positionsPnLPercent(position.unrealizedPnL, position.costBasis), position.symbol);
    }
    assert.deepEqual(summary.positions.map((position) => [position.symbol, position.unrealizedPnLPercent]), MAIN_PORTFOLIO.percents.positions);
    // The old name is gone, as on the other summaries.
    assert.equal('totalUnrealizedPnLPercent' in summary, false);
  });

  // 3ddfcd26's one-account boundary (GL-P2-2): mobile sums its positions the canonical way, as every web scope does, so
  // one account reads one percent on mobile and on the web, to the bit, at each price, as each app formats it.
  for (const [price, webText, mobileText] of [[100.005, '0.01%', '+0.01%'], [101.005, '1.01%', '+1.01%']] as const) {
    it(`a rounding boundary in one account (SYN at $33.33, TEST at $166.67, both now $${price}): mobile reads the web's percent`, () => {
      const trades = [buy('t1', 'SYN', 1, 33.33), buy('t2', 'TEST', 1, 166.67)];
      const prices = [quote('SYN', price), quote('TEST', price)];
      const mobile = summarizePortfolio(trades, prices);
      const byAccount = summarizeByAccount([acc('a', 'A')], trades, prices);
      const bySymbol = summarizeBySymbol([acc('a', 'A')], trades, prices);
      const values = [
        mobile.positionsUnrealizedPnLPercent, byAccount.accounts[0].positionsUnrealizedPnLPercent,
        byAccount.positionsUnrealizedPnLPercent, bySymbol.positionsUnrealizedPnLPercent,
      ];
      for (const value of values) assert.ok(Object.is(value, values[0]), `${value} vs ${values[0]}`);
      // Mobile signs its percent; the web's formatGainLoss text does not.
      assert.equal(formatPercent(mobile.positionsUnrealizedPnLPercent!), mobileText);
      assert.equal(formatPercent(byAccount.positionsUnrealizedPnLPercent!, 2, false), webText);
      assert.equal(formatCurrency(mobile.totalUnrealizedPnL), formatCurrency(byAccount.grandTotalUnrealizedPnL));
    });
  }

  it('a missing quote: the total percent is null where main read 0, with the dollars as before', () => {
    const summary = summarizePortfolio([buy('t1', 'X', 10, 100), buy('t2', 'NOQUOTE', 5, 20)], [quote('X', 150)]);
    assert.equal(summary.valueAvailable, false);
    assert.deepEqual(summary.missingQuotes, ['NOQUOTE']);
    assert.equal(summary.totalUnrealizedPnL, 0);
    assert.equal(summary.positionsUnrealizedPnLPercent, null);
    // The priced holding keeps its own percent.
    assert.equal(summary.positions[0].unrealizedPnLPercent, 50);
  });

  it("a zero cost: the holding's and the total percent are null where main read 0, its gain still in dollars", () => {
    const summary = summarizePortfolio([buy('t1', 'GIFT', 5, 0)], [quote('GIFT', 40)]);
    assert.equal(summary.valueAvailable, true);
    assert.equal(summary.totalUnrealizedPnL, 200);
    assert.equal(summary.positions[0].unrealizedPnLPercent, null);
    assert.equal(summary.positionsUnrealizedPnLPercent, null);
  });
});

// ---------------------------------------------------------------------------
// formatGainLoss: how Portfolio shows a gain or loss, a zero as "$0.00 (0.00%)" in neither colour (Root, after #252)
// ---------------------------------------------------------------------------

describe('formatGainLoss: a zero gain or loss reads "$0.00 (0.00%)", neutral; anything else as before', () => {
  const zero = { amount: '$0.00', percent: '0.00%', tone: 'neutral', percentTone: 'neutral' };
  const web = (amount: number, percent: number | null, currency?: string) => formatGainLoss(amount, percent, { currency });
  const mobile = (amount: number, percent: number | null) => formatGainLoss(amount, percent, { signedPercent: true });

  it('an exact zero', () => {
    assert.deepEqual(web(0, 0), zero);
    assert.deepEqual(mobile(0, 0), zero);
  });

  it('float noise either side of zero, in the dollars (±5.55e-17) and in the percent (±1e-14)', () => {
    // Through the plain formatters this noise reads "-$0.00", "-0.00%" and, signed, "+0.00%".
    assert.equal(formatCurrency(-5.55e-17), '-$0.00');
    assert.equal(formatPercent(-1e-14, 2, false), '-0.00%');
    assert.equal(formatPercent(1e-14), '+0.00%');
    for (const amount of [5.55e-17, -5.55e-17, 0]) {
      for (const percent of [1e-14, -1e-14, 0]) {
        assert.deepEqual(web(amount, percent), zero, `${amount} ${percent}`);
        assert.deepEqual(mobile(amount, percent), zero, `${amount} ${percent}`);
      }
    }
  });

  it("a sub-cent gain or loss: the amount $0.00, the percent its own, the tone the percent's, with its amount or alone", () => {
    assert.deepEqual(web(0.001, 25), { amount: '$0.00', percent: '25.00%', tone: 'gain', percentTone: 'gain' });
    assert.deepEqual(mobile(0.001, 25), { amount: '$0.00', percent: '+25.00%', tone: 'gain', percentTone: 'gain' });
    assert.deepEqual(web(-0.001, -25), { amount: '$0.00', percent: '-25.00%', tone: 'loss', percentTone: 'loss' });
    assert.deepEqual(mobile(-0.001, -25), { amount: '$0.00', percent: '-25.00%', tone: 'loss', percentTone: 'loss' });
  });

  it("a tiny real percent (±0.004%) reads 0.00%, unsigned: with its amount the amount's tone (neutral if $0.00 too); alone, neutral", () => {
    assert.deepEqual(web(0.04, 0.004), { amount: '$0.04', percent: '0.00%', tone: 'gain', percentTone: 'neutral' });
    assert.deepEqual(mobile(0.04, 0.004), { amount: '$0.04', percent: '0.00%', tone: 'gain', percentTone: 'neutral' });
    assert.deepEqual(web(-0.04, -0.004), { amount: '-$0.04', percent: '0.00%', tone: 'loss', percentTone: 'neutral' });
    assert.deepEqual(mobile(-0.04, -0.004), { amount: '-$0.04', percent: '0.00%', tone: 'loss', percentTone: 'neutral' });
    assert.deepEqual(mobile(0.004, 0.004), zero);
    assert.deepEqual(mobile(-0.004, -0.004), zero);
  });

  it('a loss of a cent beside 0.00% stays a loss: the tone follows the amount shown', () => {
    assert.deepEqual(web(-0.01, -0.001), { amount: '-$0.01', percent: '0.00%', tone: 'loss', percentTone: 'neutral' });
  });

  it("a percent shown alone (mobile's holding rows) takes its own tone: $0.40 on $10,000 reads 0.00%, neutral; 0.01% its sign", () => {
    // $0.40 gained or lost on $10,000 of cost is 0.004%: with its amount a gain or a loss, alone it reads zero.
    assert.deepEqual(mobile(0.4, 0.004), { amount: '$0.40', percent: '0.00%', tone: 'gain', percentTone: 'neutral' });
    assert.deepEqual(mobile(-0.4, -0.004), { amount: '-$0.40', percent: '0.00%', tone: 'loss', percentTone: 'neutral' });
    assert.deepEqual(mobile(1, 0.01), { amount: '$1.00', percent: '+0.01%', tone: 'gain', percentTone: 'gain' });
    assert.deepEqual(mobile(-1, -0.01), { amount: '-$1.00', percent: '-0.01%', tone: 'loss', percentTone: 'loss' });
    assert.deepEqual(web(1, 0.01), { amount: '$1.00', percent: '0.01%', tone: 'gain', percentTone: 'gain' });
    assert.deepEqual(web(-1, -0.01), { amount: '-$1.00', percent: '-0.01%', tone: 'loss', percentTone: 'loss' });
  });

  it("mobile's row and summary for $0.40 gained or lost on 1,000 shares at $10: the row's 0.00% neutral, the summary the amount's tone", () => {
    for (const [price, amount, tone] of [[10.0004, '$0.40', 'gain'], [9.9996, '-$0.40', 'loss']] as const) {
      const summary = summarizePortfolio(
        [{ id: 'syn-large', accountId: 'default', symbol: 'SYN', date: '2025-01-02', quantity: 1000, pricePerUnit: 10, currency: 'USD' }],
        [{ symbol: 'SYN', price, currency: 'USD', asOf: 0 }],
      );
      const [position] = summary.positions;
      const row = formatGainLoss(position.unrealizedPnL, position.unrealizedPnLPercent, { currency: position.currency, signedPercent: true });
      assert.equal(row.percent, '0.00%', String(price));
      assert.equal(row.percentTone, 'neutral', String(price));
      const total = formatGainLoss(summary.totalUnrealizedPnL, summary.positionsUnrealizedPnLPercent, { signedPercent: true });
      assert.equal(`${total.amount} (${total.percent})`, `${amount} (0.00%)`, String(price));
      assert.equal(total.tone, tone, String(price));
    }
  });

  it('each tone agrees with the text it colours, either side of the rounding edge (±0.005% and ±$0.005)', () => {
    for (const percent of [-0.0051, -0.005, -0.0049, -1e-9, 0, 1e-9, 0.0049, 0.005, 0.0051]) {
      for (const amount of [-1, -0.0051, -0.005, -0.0049, 0, 0.0049, 0.005, 0.0051, 1]) {
        for (const shown of [web(amount, percent), mobile(amount, percent)]) {
          const at = `${amount} ${percent} ${shown.amount} (${shown.percent})`;
          assert.equal(shown.percentTone, shown.percent === '0.00%' ? 'neutral' : percent > 0 ? 'gain' : 'loss', at);
          assert.equal(shown.tone, shown.amount === '$0.00' ? shown.percentTone : amount > 0 ? 'gain' : 'loss', at);
        }
      }
    }
  });

  it("an unknown percent reads —: alone, neutral; with a $0.00 amount, neutral; with any other, the amount's tone", () => {
    assert.deepEqual(web(0, null), { amount: '$0.00', percent: '—', tone: 'neutral', percentTone: 'neutral' });
    assert.deepEqual(web(-1e-16, null), { amount: '$0.00', percent: '—', tone: 'neutral', percentTone: 'neutral' });
    assert.deepEqual(web(200, null), { amount: '$200.00', percent: '—', tone: 'gain', percentTone: 'neutral' });
    assert.deepEqual(mobile(-200, null), { amount: '-$200.00', percent: '—', tone: 'loss', percentTone: 'neutral' });
  });

  it('mobile signs a percent and the web does not; neither signs a zero', () => {
    assert.equal(web(500, 50).percent, '50.00%');
    assert.equal(mobile(500, 50).percent, '+50.00%');
    assert.equal(web(-200, -20).percent, '-20.00%');
    assert.equal(mobile(-200, -20).percent, '-20.00%');
    assert.equal(mobile(0, 1e-9).percent, '0.00%');
  });

  it("normal gains and losses read as they did: the plain formatters' text, the amount's tone, with its amount or alone", () => {
    for (const [amount, percent] of [[500, 50], [-200, -20], [1234.56, 12.34], [-0.01, -0.5], [100, 250], [2071.43, 27.25]]) {
      const tone = amount > 0 ? 'gain' : 'loss';
      assert.deepEqual(web(amount, percent), { amount: formatCurrency(amount), percent: formatPercent(percent, 2, false), tone, percentTone: tone });
      assert.deepEqual(mobile(amount, percent), { amount: formatCurrency(amount), percent: formatPercent(percent), tone, percentTone: tone });
    }
    assert.equal(web(100, 250).percent, '250%');
  });

  it('a currency without cents rounds at its own precision', () => {
    assert.deepEqual(web(-0.4, 0, 'JPY'), { amount: formatCurrency(0, 'JPY'), percent: '0.00%', tone: 'neutral', percentTone: 'neutral' });
    assert.equal(web(-0.6, -0.01, 'JPY').amount, formatCurrency(-1, 'JPY'));
    assert.equal(web(-0.6, -0.01, 'JPY').tone, 'loss');
  });
});

describe("the lead's probe fixtures: a true zero reads $0.00 (0.00%), neutral, in every scope", () => {
  const trade = (id: string, accountId: string, quantity: number, pricePerUnit: number, date: string): Transaction => ({
    id, accountId, symbol: 'SYNZ', date, quantity, pricePerUnit, currency: 'USD',
  });
  const zero = { amount: '$0.00', percent: '0.00%', tone: 'neutral', percentTone: 'neutral' };
  // Each scope's gain/loss and percent, as a summary hands them to the views.
  const expectZero = (scopes: Record<string, [number, number | null]>) => {
    for (const [scope, [amount, percent]] of Object.entries(scopes)) {
      assert.deepEqual(formatGainLoss(amount, percent), zero, scope);
      assert.deepEqual(formatGainLoss(amount, percent, { signedPercent: true }), zero, scope);
    }
  };

  it('one account (gl-sign-probe): 0.5 SYNZ at $0.10 and 2 at $0.20, now their average; it read "-$0.00" in the loss colour', () => {
    const accounts = [acc('syn-z', 'Synthetic Zero')];
    const txs = [trade('l1', 'syn-z', 0.5, 0.1, '2025-01-02'), trade('l2', 'syn-z', 2, 0.2, '2025-02-03')];
    const quotes: Quote[] = [{ symbol: 'SYNZ', price: (0.5 * 0.1 + 2 * 0.2) / (0.5 + 2), currency: 'USD', asOf: 0 }];
    const byAccount = summarizeByAccount(accounts, txs, quotes);
    const bySymbol = summarizeBySymbol(accounts, txs, quotes);
    const scopes: Record<string, [number, number | null]> = {
      account: [byAccount.accounts[0].totalUnrealizedPnL, byAccount.accounts[0].positionsUnrealizedPnLPercent],
      household: [byAccount.grandTotalUnrealizedPnL, byAccount.positionsUnrealizedPnLPercent],
      combined: [bySymbol.totalUnrealizedPnL, bySymbol.positionsUnrealizedPnLPercent],
    };
    for (const [scope, [amount]] of Object.entries(scopes)) assert.equal(formatCurrency(amount), '-$0.00', scope);
    expectZero(scopes);
  });

  for (const [title, [qa, pa, qb, pb, cashA, cashB]] of [
    ['3 SYNZ and 0.25 SYNZ, both at $0.30, now $0.30', [3, 0.3, 0.25, 0.3, 0, 0]],
    ['2 and 7 SYNZ at $10.01 with $100 and $0.10 cash, now $10.01', [2, 10.01, 7, 10.01, 100, 0.1]],
  ] as const) {
    it(`two accounts (gl-sign-probe-rows2): ${title}; the row across them, an account's row, the account, household and combined`, () => {
      const accounts = [acc('syn-a', 'Synthetic A', cashA), acc('syn-b', 'Synthetic B', cashB)];
      const txs = [trade('a1', 'syn-a', qa, pa, '2025-01-02'), trade('b1', 'syn-b', qb, pb, '2025-02-03')];
      const quotes: Quote[] = [{ symbol: 'SYNZ', price: (qa * pa + qb * pb) / (qa + qb), currency: 'USD', asOf: 0 }];
      const byAccount = summarizeByAccount(accounts, txs, quotes);
      const bySymbol = summarizeBySymbol(accounts, txs, quotes);
      const scopes: Record<string, [number, number | null]> = {
        'row across accounts': [bySymbol.rows[0].unrealizedPnL, bySymbol.rows[0].unrealizedPnLPercent],
        "an account's row": [byAccount.accounts[0].rows[0].unrealizedPnL, byAccount.accounts[0].rows[0].unrealizedPnLPercent],
        account: [byAccount.accounts[0].totalUnrealizedPnL, byAccount.accounts[0].positionsUnrealizedPnLPercent],
        household: [byAccount.grandTotalUnrealizedPnL, byAccount.positionsUnrealizedPnLPercent],
        combined: [bySymbol.totalUnrealizedPnL, bySymbol.positionsUnrealizedPnLPercent],
      };
      // At least one scope read "-$0.00" through the plain formatter: the case this guards.
      assert.ok(Object.values(scopes).some(([amount]) => formatCurrency(amount) === '-$0.00'));
      expectZero(scopes);
    });
  }
});

// ---------------------------------------------------------------------------
// A value shown on its own (the zero-display sweep, after #253): a zero reads unsigned and neutral, unknown reads "—"
// ---------------------------------------------------------------------------

describe('formatShownAmount and formatShownPercent: a value shown on its own', () => {
  const neutral = (text: string) => ({ text, tone: 'neutral' });

  it('an unknown amount or percent reads "—", neutral, never $0.00 or 0.00%', () => {
    for (const unknown of [null, undefined]) {
      assert.deepEqual(formatShownAmount(unknown), neutral('—'));
      assert.deepEqual(formatShownAmount(unknown, { signed: true }), neutral('—'));
      assert.deepEqual(formatShownPercent(unknown), neutral('—'));
      assert.deepEqual(formatShownPercent(unknown, { signed: true, digits: 1 }), neutral('—'));
    }
  });

  it('a zero and float noise either side read the zero, unsigned and neutral, signed or not', () => {
    // Through the plain formatters, with a "+" for gains, this reads "+$0.00", "-$0.00", "+0.00%" and "-0.00%".
    assert.equal(`${5.55e-17 > 0 ? '+' : ''}${formatCurrency(5.55e-17)}`, '+$0.00');
    assert.equal(formatCurrency(-5.55e-17), '-$0.00');
    assert.equal(formatPercent(1e-14), '+0.00%');
    assert.equal(formatPercent(-1e-14), '-0.00%');
    for (const signed of [false, true]) {
      for (const amount of [0, -0, 5.55e-17, -5.55e-17, 0.004, -0.004]) {
        assert.deepEqual(formatShownAmount(amount, { signed }), neutral('$0.00'), `${amount} ${signed}`);
      }
      for (const percent of [0, -0, 1e-14, -1e-14, 0.004, -0.004]) {
        assert.deepEqual(formatShownPercent(percent, { signed }), neutral('0.00%'), `${percent} ${signed}`);
        assert.deepEqual(formatShownPercent(percent, { signed, digits: 1 }), neutral('0.0%'), `${percent} ${signed}`);
      }
    }
  });

  it('anything else keeps its sign and tone, with "+" before a gain only when signed', () => {
    assert.deepEqual(formatShownAmount(1.23), { text: '$1.23', tone: 'gain' });
    assert.deepEqual(formatShownAmount(1.23, { signed: true }), { text: '+$1.23', tone: 'gain' });
    assert.deepEqual(formatShownAmount(-1.23, { signed: true }), { text: '-$1.23', tone: 'loss' });
    assert.deepEqual(formatShownAmount(0.01, { signed: true }), { text: '+$0.01', tone: 'gain' });
    assert.deepEqual(formatShownPercent(4.56), { text: '4.56%', tone: 'gain' });
    assert.deepEqual(formatShownPercent(4.56, { signed: true }), { text: '+4.56%', tone: 'gain' });
    assert.deepEqual(formatShownPercent(-4.56, { signed: true }), { text: '-4.56%', tone: 'loss' });
    assert.deepEqual(formatShownPercent(0.01, { signed: true }), { text: '+0.01%', tone: 'gain' });
    assert.deepEqual(formatShownPercent(150, { signed: true }), { text: '+150%', tone: 'gain' });
    assert.deepEqual(formatShownPercent(-3.25, { signed: true, digits: 1 }), { text: formatPercent(-3.25, 1), tone: 'loss' });
  });

  it('each tone agrees with the text it colours, either side of the rounding edge', () => {
    for (const value of [-0.0051, -0.005, -0.0049, -1e-9, 0, 1e-9, 0.0049, 0.005, 0.0051, -0.051, -0.049, 0.049, 0.051]) {
      for (const signed of [false, true]) {
        const amount = formatShownAmount(value, { signed });
        assert.equal(amount.tone, amount.text === '$0.00' ? 'neutral' : value > 0 ? 'gain' : 'loss', `${value} ${amount.text}`);
        assert.equal(amount.text, amount.tone === 'neutral' ? '$0.00' : `${signed && value > 0 ? '+' : ''}${formatCurrency(value)}`);
        for (const digits of [1, 2]) {
          const percent = formatShownPercent(value, { signed, digits });
          const zero = formatPercent(0, digits, false);
          assert.equal(percent.tone, percent.text === zero ? 'neutral' : value > 0 ? 'gain' : 'loss', `${value} ${digits} ${percent.text}`);
          assert.equal(percent.text, percent.tone === 'neutral' ? zero : formatPercent(value, digits, signed));
        }
      }
    }
  });

  it("a surface's own formatter decides what reads zero: a compact $0, or a currency without cents", () => {
    const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
    const format = (value: number) => `${value < 0 ? '-' : ''}${compact.format(Math.abs(value))}`;
    assert.deepEqual(formatShownAmount(0.04, { signed: true, format }), neutral(format(0)));
    assert.deepEqual(formatShownAmount(-0.04, { signed: true, format }), neutral(format(0)));
    assert.deepEqual(formatShownAmount(1234, { signed: true, format }), { text: `+${format(1234)}`, tone: 'gain' });
    assert.deepEqual(formatShownAmount(-1234, { signed: true, format }), { text: format(-1234), tone: 'loss' });
    assert.deepEqual(formatShownAmount(-0.4, { currency: 'JPY' }), neutral(formatCurrency(0, 'JPY')));
    assert.deepEqual(formatShownAmount(-0.6, { currency: 'JPY' }), { text: formatCurrency(-1, 'JPY'), tone: 'loss' });
  });
});

describe('formatGainLoss with a part unknown, or a signed amount (the ticker and the charts)', () => {
  it('an unknown amount reads "—" and the percent decides the tone; both unknown read "—", neutral', () => {
    assert.deepEqual(formatGainLoss(undefined, 1.5), { amount: '—', percent: '1.50%', tone: 'gain', percentTone: 'gain' });
    assert.deepEqual(formatGainLoss(null, -1.5), { amount: '—', percent: '-1.50%', tone: 'loss', percentTone: 'loss' });
    assert.deepEqual(formatGainLoss(null, 0), { amount: '—', percent: '0.00%', tone: 'neutral', percentTone: 'neutral' });
    assert.deepEqual(formatGainLoss(undefined, undefined), { amount: '—', percent: '—', tone: 'neutral', percentTone: 'neutral' });
    assert.deepEqual(formatGainLoss(2.5, undefined), { amount: '$2.50', percent: '—', tone: 'gain', percentTone: 'neutral' });
  });

  it('a signed amount writes "+" before a gain, never before a zero', () => {
    const signed = { signedAmount: true, signedPercent: true };
    assert.deepEqual(formatGainLoss(1.23, 4.56, signed), { amount: '+$1.23', percent: '+4.56%', tone: 'gain', percentTone: 'gain' });
    assert.deepEqual(formatGainLoss(-1.23, -4.56, signed), { amount: '-$1.23', percent: '-4.56%', tone: 'loss', percentTone: 'loss' });
    assert.deepEqual(formatGainLoss(5.55e-17, 1e-14, signed), { amount: '$0.00', percent: '0.00%', tone: 'neutral', percentTone: 'neutral' });
    assert.deepEqual(formatGainLoss(-5.55e-17, -1e-14, signed), { amount: '$0.00', percent: '0.00%', tone: 'neutral', percentTone: 'neutral' });
  });
});
