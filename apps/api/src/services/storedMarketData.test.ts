import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStateRepo } from './sqliteStateRepo.js';
import { createHistoryRepo } from './symbolHistory.js';
import { createStoredQuoteFetcher, marketDataModeOf, newYorkCloseMs, storedQuotes } from './storedMarketData.js';
import { resolveQuotes } from './quoteResolver.js';

// HOLDR_MARKET_DATA=stored (the demo): quotes are the newest stored close, the close before it the day's baseline,
// labelled synthetic; nothing else is asked.

let dir: string;
let state: SqliteStateRepo;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdr-stored-market-'));
  state = new SqliteStateRepo({ file: path.join(dir, 'finance.db') });
});
afterEach(() => {
  state.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('stored market data', () => {
  it('is on for HOLDR_MARKET_DATA=stored only, and refuses any value but live or stored', () => {
    expect(marketDataModeOf({})).toBe('live');
    expect(marketDataModeOf({ HOLDR_MARKET_DATA: ' live ' })).toBe('live');
    expect(marketDataModeOf({ HOLDR_MARKET_DATA: 'stored' })).toBe('stored');
    expect(() => marketDataModeOf({ HOLDR_MARKET_DATA: 'stord' })).toThrow(/live.*stored/);
  });

  it('dates a close at 16:00 in New York, in winter and summer time', () => {
    expect(new Date(newYorkCloseMs('2026-01-15')).toISOString()).toBe('2026-01-15T21:00:00.000Z');
    expect(new Date(newYorkCloseMs('2026-07-15')).toISOString()).toBe('2026-07-15T20:00:00.000Z');
  });

  it('quotes the newest stored close on or before today with the close before it as the baseline', async () => {
    createHistoryRepo(state).upsertBars([
      { symbol: 'AAA', t: '2026-05-04', close: 100, source: 'stooq' },
      { symbol: 'AAA', t: '2026-05-05', close: 104, source: 'stooq' },
      { symbol: 'AAA', t: '2026-05-05', close: 105, source: 'nasdaq' },
      { symbol: 'AAA', t: '2026-05-07', close: 999, source: 'nasdaq' },
      { symbol: 'BBB', t: '2026-05-05', close: 20, source: 'nasdaq' },
    ]);
    const now = new Date('2026-05-06T14:00:00Z');
    const quotes = storedQuotes(state.internalGetDb(), ['aaa', 'BBB', 'NONE'], now);
    expect(quotes.map((quote) => quote.symbol)).toEqual(['AAA', 'BBB']);
    const [aaa, bbb] = quotes;
    // One close per date (nasdaq over stooq), tomorrow's never.
    expect(aaa).toMatchObject({ price: 105, source: 'synthetic', currency: 'USD', changeBasis: 'previousClose', baselinePrice: 100, dayChange: 5 });
    expect(aaa.dayChangePercent).toBeCloseTo(5);
    expect(aaa.asOf).toBe(Date.parse('2026-05-05T20:00:00Z'));
    expect(bbb.baselinePrice).toBeUndefined();
    // A close dated today is never later than now.
    expect(storedQuotes(state.internalGetDb(), ['AAA'], new Date('2026-05-07T14:00:00Z'))[0]).toMatchObject({ price: 999, asOf: Date.parse('2026-05-07T14:00:00Z') });

    // Through the quotes resolver, as GET /quotes answers: missing symbols are missing, nothing is fetched.
    const resolution = await resolveQuotes(state, ['AAA', 'NONE'], {}, createStoredQuoteFetcher(state.internalGetDb(), () => now), now);
    expect(resolution.quotes.map((quote) => [quote.symbol, quote.source])).toEqual([['AAA', 'synthetic']]);
    expect(resolution.missingSymbols).toEqual(['NONE']);
  });
});
