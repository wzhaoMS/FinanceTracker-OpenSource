import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { METALS_COIN_SPECS, METALS_COIN_SPECS_VERSION, metalsCoinSpecification } from './coinSpecs.js';
import { formatRational } from './rational.js';

describe('coin specifications v1', () => {
  it('pins its version and the whole table (a change to it is a new version)', () => {
    assert.equal(METALS_COIN_SPECS_VERSION, 'metals-coin-specs-v1');
    assert.deepEqual(METALS_COIN_SPECS.map((spec) => [spec.design, spec.metal,
      spec.denominations.map((entry) => `${formatRational(entry.troyOz)}=${formatRational(entry.fineTroyOz)}`)]), [
      ['eagle', 'XAU', ['1/1=1/1', '1/2=1/2', '1/4=1/4', '1/10=1/10']],
      ['buffalo', 'XAU', ['1/1=1/1']],
      ['maple-leaf', 'XAU', ['1/1=1/1', '1/2=1/2', '1/4=1/4', '1/10=1/10', '1/20=1/20']],
      ['krugerrand', 'XAU', ['1/1=1/1', '1/2=1/2', '1/4=1/4', '1/10=1/10']],
      ['britannia', 'XAU', ['1/1=1/1', '1/2=1/2', '1/4=1/4', '1/10=1/10']],
      ['philharmonic', 'XAU', ['1/1=1/1', '1/2=1/2', '1/4=1/4', '1/10=1/10', '1/25=1/25']],
      ['kangaroo', 'XAU', ['1/1=1/1', '1/2=1/2', '1/4=1/4', '1/10=1/10', '1/20=1/20']],
    ]);
  });

  it('reads a listed denomination in troy ounces as titles write it, bare oz included', () => {
    for (const [value, unit, expected] of [['1', 'oz', '1/1'], ['1', 'ozt', '1/1'], ['1/10', 'oz', '1/10'], ['0.1', 'oz', '1/10'],
      ['0.25', 'ozt', '1/4'], ['1/2', 'oz', '1/2']] as const) {
      const fine = metalsCoinSpecification('eagle', 'XAU', { value, unit });
      assert.equal(fine && formatRational(fine), expected, `${value} ${unit}`);
    }
  });

  it('gives nothing for an unlisted design, metal, denomination or unit', () => {
    assert.equal(metalsCoinSpecification('panda', 'XAU', { value: '1', unit: 'oz' }), null);
    assert.equal(metalsCoinSpecification('eagle', 'XAG', { value: '1', unit: 'oz' }), null);
    assert.equal(metalsCoinSpecification('eagle', 'XAU', { value: '2', unit: 'oz' }), null);
    assert.equal(metalsCoinSpecification('buffalo', 'XAU', { value: '1/2', unit: 'oz' }), null);
    assert.equal(metalsCoinSpecification('eagle', 'XAU', { value: '31.1', unit: 'g' }), null);
    assert.equal(metalsCoinSpecification(null, 'XAU', { value: '1', unit: 'oz' }), null);
    assert.equal(metalsCoinSpecification('eagle', null, { value: '1', unit: 'oz' }), null);
    assert.equal(metalsCoinSpecification('eagle', 'XAU', null), null);
  });
});
