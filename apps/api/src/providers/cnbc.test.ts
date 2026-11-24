import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCnbcQuote, type CnbcResponse } from './cnbc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('parseCnbcQuote — captured fixture', () => {
  it.each([undefined, '', 'N/A', '2026-05-06T12:00:00', '2999-01-01T00:00:00Z', '2999-01-01', '2026-02-31'])(
    'rejects quotes without a reliable trade time: %s', (last_time) => {
      expect(parseCnbcQuote({ FormattedQuoteResult: { FormattedQuote: [{
        symbol: 'AAPL', code: 0, last: '100.00', last_time,
      }] } }, 'AAPL')).toBeNull();
    },
  );

  it('preserves the actual date of a date-only closing quote', () => {
    const quote = parseCnbcQuote({ FormattedQuoteResult: { FormattedQuote: [{
      symbol: 'MSFT', code: 0, last: '512.90', last_time: '2026-09-29',
    }] } }, 'MSFT');
    expect(quote).toMatchObject({ price: 512.9, asOf: Date.parse('2026-09-29T20:00:00Z') });
  });

  it('NBIS: uses previous_day_closing as the baseline', () => {
    const json = JSON.parse(
      readFileSync(path.join(__dirname, '__fixtures__', 'cnbc-nbis.json'), 'utf8'),
    ) as CnbcResponse;
    const q = parseCnbcQuote(json, 'NBIS');
    expect(q).not.toBeNull();
    expect(q!.symbol).toBe('NBIS');
    expect(q!.price).toBe(150);
    expect(q!.source).toBe('cnbc');
    expect(q!.currency).toBe('USD');
    expect(q!.changeBasis).toBe('previousClose');
    expect(q!.baselinePrice).toBe(145);
    expect(q!.dayChange).toBeCloseTo(5, 5);
    // provider says +3.45%, derived ≈ 3.448% — keeps provider value
    expect(q!.dayChangePercent).toBe(3.45);
    // last_time was ISO-8601 with offset, asOf is exact
    expect(new Date(q!.asOf).toISOString()).toBe('2026-03-03T16:30:00.000Z');
  });

  it('returns null when code != 0 (CNBC error response)', () => {
    expect(
      parseCnbcQuote(
        { FormattedQuoteResult: { FormattedQuote: [{ symbol: 'X', code: 1 } as never] } },
        'X',
      ),
    ).toBeNull();
  });

  it('falls back to deriving baseline from `change` when previous_day_closing is missing', () => {
    const json: CnbcResponse = {
      FormattedQuoteResult: {
        FormattedQuote: [
          {
            symbol: 'TEST',
            code: 0,
            last: '110.00',
            change: '+10.00',
            change_pct: '+10.00%',
            currencyCode: 'USD',
            last_time: '2026-05-06T12:00:00.000-0400',
          } as never,
        ],
      },
    };
    const q = parseCnbcQuote(json, 'TEST')!;
    expect(q.changeBasis).toBe('previousClose');
    expect(q.baselinePrice).toBe(100);
    expect(q.dayChange).toBe(10);
    expect(q.dayChangePercent).toBe(10);
  });
});
