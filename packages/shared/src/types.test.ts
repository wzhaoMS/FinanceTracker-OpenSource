import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { maskAccountNumber, lastFour } from './types.js';

describe('maskAccountNumber', () => {
  it('takes the last 4 of a longer mixed alphanumeric account id', () => {
    assert.equal(maskAccountNumber('Z85325841'), '***5841');
  });

  it('returns the same input when already exactly 4 chars', () => {
    assert.equal(maskAccountNumber('5841'), '***5841');
  });

  it('does not pad short inputs', () => {
    assert.equal(maskAccountNumber('99'), '***99');
  });

  it('strips separators before masking', () => {
    assert.equal(maskAccountNumber('000-006-741'), '***6741');
  });

  it('returns empty for nullish input', () => {
    assert.equal(maskAccountNumber(undefined), '');
    assert.equal(maskAccountNumber(null), '');
    assert.equal(maskAccountNumber(''), '');
  });
});

describe('lastFour', () => {
  it('extracts last 4 alphanumeric chars', () => {
    assert.equal(lastFour('ROTH IRA 191596741'), '6741');
    assert.equal(lastFour('Z85325841'), '5841');
  });

  it('handles already-masked broker labels', () => {
    // The "***" is non-alphanumeric so it gets stripped before slicing.
    assert.equal(lastFour('ROTH IRA ***6741'), '6741');
  });

  it('returns null when fewer than 4 alphanumeric chars are present', () => {
    assert.equal(lastFour('a'), null);
    assert.equal(lastFour('--'), null);
    assert.equal(lastFour(''), null);
    assert.equal(lastFour(null), null);
  });
});
