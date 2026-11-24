import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fifthThirdAccountIdentity, fifthThirdAccountTokenProblem, fifthThirdKnownAccountNumbers } from './fifthThirdAccount.js';

describe('Fifth Third account identity', () => {
  it('reads a printed account number whole, or names why not', () => {
    for (const token of ['9990004321', 'XXXXXX4321', '******4321', '999-000-4321', '20260']) assert.equal(fifthThirdAccountTokenProblem(token), null, token);
    for (const token of ['XXXXXX4321X', 'XXXXXX4321 5678', 'XXXXXX4321-5678X', 'XXXXXX4321-', '...4321', 'CHECKING 4321']) {
      assert.equal(fifthThirdAccountTokenProblem(token), 'not-whole', token);
    }
  });

  it('keeps the union of what the printings of one account show, in any order', () => {
    assert.deepEqual(fifthThirdAccountIdentity([]), { kind: 'none' });
    for (const tokens of [['XXXXXX4321', '9990004321'], ['9990004321', 'XXXXXX4321'], ['XXX0004321', '9990004321', '******4321']]) {
      assert.deepEqual(fifthThirdAccountIdentity(tokens), { kind: 'one', last4: '4321', raw: '9990004321' }, tokens.join(' '));
    }
    assert.deepEqual(fifthThirdAccountIdentity(['XXXXXX4321', 'XXX0004321']), { kind: 'one', last4: '4321', raw: 'XXX0004321' });
    assert.deepEqual(fifthThirdAccountIdentity(['999-000-4321', '9990004321']), { kind: 'one', last4: '4321', raw: '9990004321' });
    // What agreeing printings prove together, position by position (V07, Root ruling).
    for (const tokens of [['999X004321', 'XXX0004321'], ['XXX0004321', '999X004321']]) {
      assert.deepEqual(fifthThirdAccountIdentity(tokens), { kind: 'one', last4: '4321', raw: '9990004321' }, tokens.join(' '));
    }
    assert.deepEqual(fifthThirdAccountIdentity(['999XXX4321', 'XXXXX04321']), { kind: 'one', last4: '4321', raw: '999XX04321' });
    assert.deepEqual(fifthThirdAccountIdentity(['12X45678', 'XX345678']), { kind: 'one', last4: '5678', raw: '12345678' });
    assert.deepEqual(fifthThirdAccountIdentity(['******4321']), { kind: 'one', last4: '4321', raw: 'XXXXXX4321' });
  });

  it('never merges different accounts that share their last four, and keeps what each of them proves', () => {
    assert.deepEqual(fifthThirdAccountIdentity(['9990004321', '8880004321']), { kind: 'several', count: 2, unions: ['8880004321', '9990004321'] });
    assert.deepEqual(fifthThirdAccountIdentity(['9990004321', '99990004321']), { kind: 'several', count: 2, unions: ['99990004321', '9990004321'] });
    assert.deepEqual(fifthThirdAccountIdentity(['XXX0004321', 'XXX1114321', 'XXXXXX4321']), { kind: 'several', count: 2, unions: ['XXX0004321', 'XXX1114321'] });
    assert.deepEqual(fifthThirdAccountIdentity(['XXXXXX4321', 'XXXXXX8765', '9990008765']), { kind: 'several', count: 2, unions: ['9990008765', 'XXXXXX4321'] });
  });

  it('knows every account number the printings make known: each union, then every printing', () => {
    const identity = fifthThirdAccountIdentity(['100X034321', 'XXX0034321']);
    assert.deepEqual(identity, { kind: 'one', last4: '4321', raw: '1000034321' });
    assert.deepEqual(fifthThirdKnownAccountNumbers(identity, ['100X034321', 'XXX0034321', '100X034321 X']), ['1000034321', '100X034321', 'XXX0034321', '100X034321 X']);
    assert.deepEqual(fifthThirdKnownAccountNumbers({ kind: 'none' }, []), []);
  });
});
