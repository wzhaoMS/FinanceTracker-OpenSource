import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStateRepo } from './sqliteStateRepo.js';
import { resolveQuotes } from './quoteResolver.js';

let state: SqliteStateRepo;

beforeEach(() => {
  state = new SqliteStateRepo({ file: ':memory:' });
});

afterEach(() => state.close());

describe('resolveQuotes', () => {
  it('uses a persisted intraday mark only for provider misses', async () => {
    state.internalGetDb().prepare(
      `INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source)
       VALUES (?, 'intraday', ?, ?, ?)`,
    ).run('NBIS260918P00170000', '2026-08-27T18:10:00.000Z', 2.55, 'cboe');
    const result = await resolveQuotes(
      state,
      ['AAPL', 'NBIS260918P00170000'],
      {},
      async () => [{
        symbol: 'AAPL', price: 200, currency: 'USD', asOf: Date.now(), source: 'nasdaq',
      }],
      new Date('2026-08-27T18:15:00.000Z'),
    );

    expect(result.quotes).toHaveLength(2);
    expect(result.quotes[1]).toMatchObject({
      symbol: 'NBIS260918P00170000',
      price: 2.55,
      source: 'cache',
      freshness: 'stale',
    });
    expect(result.fallbackSymbols).toEqual(['NBIS260918P00170000']);
    expect(result.missingSymbols).toEqual([]);
  });

  it('falls back after a provider error and reports symbols with no stored mark', async () => {
    state.internalGetDb().prepare(
      `INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source)
       VALUES (?, 'intraday', ?, ?, ?)`,
    ).run('AAPL', '2026-08-27T18:10:00.000Z', 199, 'nasdaq');
    const result = await resolveQuotes(
      state,
      ['AAPL', 'MISSING'],
      {},
      async () => { throw new Error('offline'); },
      new Date('2026-08-27T18:15:00.000Z'),
    );

    expect(result.quotes.map((quote) => quote.symbol)).toEqual(['AAPL']);
    expect(result.fallbackSymbols).toEqual(['AAPL']);
    expect(result.missingSymbols).toEqual(['MISSING']);
  });

  it('rejects zero and ancient persisted marks', async () => {
    const insert = state.internalGetDb().prepare(
      `INSERT INTO symbol_price_bars (symbol, range_kind, t, close, source)
       VALUES (?, 'intraday', ?, ?, ?)`,
    );
    insert.run('ZERO', '2026-08-27T18:10:00.000Z', 0, 'nasdaq');
    insert.run('OLD', '2026-08-01T18:10:00.000Z', 100, 'nasdaq');
    const result = await resolveQuotes(
      state,
      ['ZERO', 'OLD'],
      {},
      async () => [],
      new Date('2026-08-27T18:15:00.000Z'),
    );
    expect(result.quotes).toEqual([]);
    expect(result.missingSymbols).toEqual(['ZERO', 'OLD']);
  });
});