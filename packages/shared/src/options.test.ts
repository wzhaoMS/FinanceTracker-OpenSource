import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildOccSymbol, formatOptionSymbol, parseOccSymbol } from './options.js';

describe('OCC option identity', () => {
  it('round-trips the verified NBIS weekly put contract', () => {
    const symbol = buildOccSymbol({
      underlyingSymbol: 'NBIS',
      expirationDate: '2026-07-31',
      optionType: 'put',
      strikePrice: 165,
    });
    assert.equal(symbol, 'NBIS260731P00165000');
    assert.deepEqual(parseOccSymbol(symbol), {
      symbol,
      underlyingSymbol: 'NBIS',
      expirationDate: '2026-07-31',
      optionType: 'put',
      strikePrice: 165,
    });
    assert.equal(formatOptionSymbol(symbol), "NBIS Jul 31 '26 $165 Put");
  });

  it('rejects malformed dates, strikes, and adjusted roots', () => {
    assert.equal(parseOccSymbol('NBIS260732P00165000'), null);
    assert.equal(parseOccSymbol('NBIS260731P00000000'), null);
    assert.equal(parseOccSymbol('NBIS1260731P00165000'), null);
    assert.throws(() => buildOccSymbol({
      underlyingSymbol: 'NBIS', expirationDate: '2026-02-30', optionType: 'put', strikePrice: 165,
    }));
    assert.throws(() => buildOccSymbol({
      underlyingSymbol: 'NBIS', expirationDate: '2026-07-31', optionType: 'put', strikePrice: 165.0009,
    }));
  });
});