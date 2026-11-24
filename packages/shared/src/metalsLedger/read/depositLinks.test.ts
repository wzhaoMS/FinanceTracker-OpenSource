import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

import {
  METALS_DEPOSIT_WINDOW_DAYS,
  metalsDepositLinks,
  type MetalsCheckingAccount,
  type MetalsCheckingBinding,
  type MetalsCheckingCoverage,
  type MetalsCheckingRow,
  type MetalsDepositLink,
  type MetalsPayoutSubject,
} from './depositLinks.js';
import type { MetalsSource } from '../model.js';

/** Synthetic ledgers only: invented payouts, credits, accounts and last 4s. */
const payout = (key: string, extra: Partial<MetalsPayoutSubject> = {}): MetalsPayoutSubject => ({
  payoutKey: key, saleOrderKey: `sell-${key}`, source: 'collectpure', amountMinor: 500000, initiatedDate: null, payoutDate: '2030-03-04',
  destinationLast4: '7777', status: 'complete', active: true, ...extra,
});
/** A credit naming CollectPure's payout origin, unless `originSources` says otherwise. */
const credit = (id: string, date: string, extra: Partial<MetalsCheckingRow> = {}): MetalsCheckingRow => ({
  id, accountId: 'chk-a', date, amountMinor: 500000, kind: 'credit', currency: 'USD', usable: true, originSources: ['collectpure'], ...extra,
});
const ACCOUNTS: MetalsCheckingAccount[] = [{ id: 'chk-a', last4: '7777' }, { id: 'chk-b', last4: '8888' }, { id: 'chk-z', last4: null }];
const BINDINGS: MetalsCheckingBinding[] = [{ source: 'collectpure', last4: '7777', accountId: 'chk-a', state: 'active' }];
const COVERAGE: MetalsCheckingCoverage[] = [{ accountId: 'chk-a', from: '2030-01-01', to: '2030-12-31' }];
function links(
  payouts: MetalsPayoutSubject[],
  rows: MetalsCheckingRow[],
  options: { bindings?: MetalsCheckingBinding[]; coverage?: MetalsCheckingCoverage[] } = {},
) {
  return metalsDepositLinks({ payouts, rows, accounts: ACCOUNTS, bindings: options.bindings ?? BINDINGS, coverage: options.coverage ?? COVERAGE });
}
const stateOf = (result: ReturnType<typeof links>, key = 'p') => result.links.find((link) => link.payoutKey === key)?.state;
const brief = (link: MetalsDepositLink) => [link.state, link.rowId, link.candidates, link.proof];

/** A seeded generator (mulberry32): deterministic, every bit in play, so small bounds vary too. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return (bound: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * bound);
  };
}

describe('deposit links: the control', () => {
  it('links a complete payout to its one credit with the origin text, as proof, and classifies that credit', () => {
    const result = links([payout('p')], [credit('c1', '2030-03-06')]);
    assert.deepEqual(result.links, [{
      payoutKey: 'p', saleOrderKey: 'sell-p', rule: 'metals-deposit-link-v1', state: 'linked', rowId: 'c1', candidates: ['c1'], proof: true,
    }]);
    assert.deepEqual(result.evidence, [{ rowId: 'c1', classification: 'asset-sale-proceeds', saleKey: 'sell-p', payoutKey: 'p' }]);
  });

  it('takes credits posted from the payout date through five days after, both ends inclusive', () => {
    assert.equal(METALS_DEPOSIT_WINDOW_DAYS, 5);
    assert.equal(stateOf(links([payout('p')], [credit('c', '2030-03-04')])), 'linked');
    assert.equal(stateOf(links([payout('p')], [credit('c', '2030-03-09')])), 'linked');
    assert.equal(stateOf(links([payout('p')], [credit('c', '2030-03-10')])), 'no-candidate');
    assert.equal(stateOf(links([payout('p')], [credit('c', '2030-03-03')])), 'no-candidate');
  });

  it('never takes a debit, an unusable credit, another currency, amount or account', () => {
    for (const extra of [{ kind: 'debit' as const }, { usable: false }, { currency: 'CAD' }, { amountMinor: 500001 }, { accountId: 'chk-b' }]) {
      const result = links([payout('p')], [credit('c', '2030-03-05', extra)], { coverage: [...COVERAGE, { accountId: 'chk-b', from: '2030-01-01', to: '2030-12-31' }] });
      assert.deepEqual(brief(result.links[0]), ['no-candidate', null, [], false], JSON.stringify(extra));
      assert.deepEqual(result.evidence, []);
    }
  });
});

describe('deposit links: what proves a deposit (GD-05)', () => {
  it('an unrelated same-amount credit without the origin text stays a possible deposit, never a link', () => {
    const alone = links([payout('p')], [credit('c', '2030-03-05', { originSources: [] })]);
    assert.deepEqual(brief(alone.links[0]), ['possible', 'c', ['c'], false]);
    assert.deepEqual(alone.evidence, []);
    const two = links([payout('p')], [credit('c', '2030-03-05', { originSources: [] }), credit('d', '2030-03-06', { originSources: [] })]);
    assert.deepEqual(brief(two.links[0]), ['possible', null, ['c', 'd'], false]);
    const beside = links([payout('p')], [credit('c', '2030-03-05', { originSources: [] }), credit('o', '2030-03-06')]);
    assert.deepEqual(brief(beside.links[0]), ['linked', 'o', ['c', 'o'], true]);
    assert.deepEqual(beside.evidence.map((entry) => entry.rowId), ['o']);
  });

  it('a credit in another currency is no candidate, even with the origin text', () => {
    assert.equal(stateOf(links([payout('p')], [credit('c', '2030-03-05', { currency: 'EUR' })])), 'no-candidate');
  });

  it('a pending payout proves nothing but contests the credit it may already be; a failed one contests nothing', () => {
    const pending = links([payout('p', { status: 'pending' }), payout('q', { payoutDate: '2030-03-05' })], [credit('c', '2030-03-06')]);
    assert.deepEqual(brief(pending.links[0]), ['not-complete', null, [], false]);
    assert.deepEqual([stateOf(pending, 'q'), pending.evidence], ['ambiguous', []]);
    // A pending payout contests from the day it was initiated through its date + 5 days; undated, at any date.
    const initiated = payout('p', { status: 'pending', initiatedDate: '2030-02-20', payoutDate: '2030-02-25' });
    assert.equal(stateOf(links([initiated, payout('q', { payoutDate: '2030-02-21' })], [credit('c', '2030-02-22')]), 'q'), 'ambiguous');
    assert.equal(stateOf(links([initiated, payout('q', { payoutDate: '2030-03-04' })], [credit('c', '2030-03-04')]), 'q'), 'linked');
    assert.equal(stateOf(links([payout('p', { status: 'pending', payoutDate: null }), payout('q')], [credit('c', '2030-03-06')]), 'q'), 'ambiguous');
    const failed = links([payout('p', { status: 'failed' }), payout('q', { payoutDate: '2030-03-05' })], [credit('c', '2030-03-06')]);
    assert.deepEqual(brief(failed.links[0]), ['not-complete', null, [], false]);
    assert.equal(stateOf(failed, 'q'), 'linked');
    assert.deepEqual(failed.evidence.map((entry) => entry.payoutKey), ['q']);
  });

  it('a window the account\'s imported coverage doesn\'t include is not-covered, never "none found"', () => {
    const range = (from: string, to: string): MetalsCheckingCoverage => ({ accountId: 'chk-a', from, to });
    assert.equal(stateOf(links([payout('p')], [], { coverage: [range('2030-01-01', '2030-03-08')] })), 'not-covered');
    assert.equal(stateOf(links([payout('p')], [], { coverage: [range('2030-03-05', '2030-12-31')] })), 'not-covered');
    assert.equal(stateOf(links([payout('p')], [], { coverage: [range('2030-01-01', '2030-03-05'), range('2030-03-07', '2030-12-31')] })), 'not-covered');
    assert.equal(stateOf(links([payout('p')], [], { coverage: [{ accountId: 'chk-b', from: '2030-01-01', to: '2030-12-31' }] })), 'not-covered');
    assert.equal(stateOf(links([payout('p')], [], { coverage: [] })), 'not-covered');
    // Covered exactly, or by ranges that meet or overlap in any order: then "none found" can be said.
    assert.equal(stateOf(links([payout('p')], [], { coverage: [range('2030-03-04', '2030-03-09')] })), 'no-candidate');
    assert.equal(stateOf(links([payout('p')], [], { coverage: [range('2030-03-07', '2030-12-31'), range('2030-01-01', '2030-03-06')] })), 'no-candidate');
    assert.equal(stateOf(links([payout('p')], [credit('c', '2030-03-08')], { coverage: [range('2030-03-06', '2030-03-20'), range('2030-02-01', '2030-03-07')] })), 'linked');
  });

  it('two compatible credits stay ambiguous', () => {
    const result = links([payout('p')], [credit('c', '2030-03-05'), credit('d', '2030-03-07')]);
    assert.deepEqual(brief(result.links[0]), ['ambiguous', null, ['c', 'd'], false]);
    assert.deepEqual(result.evidence, []);
  });

  it('one each way: a credit two payouts could take links neither; credits each payout alone can take link both', () => {
    const shared = links([payout('p'), payout('q', { payoutDate: '2030-03-06' })], [credit('c', '2030-03-07')]);
    assert.deepEqual([stateOf(shared, 'p'), stateOf(shared, 'q')], ['ambiguous', 'ambiguous']);
    assert.deepEqual(shared.evidence, []);
    const both = links([payout('p'), payout('q', { payoutDate: '2030-03-06' })], [credit('c', '2030-03-07'), credit('d', '2030-03-08')]);
    assert.deepEqual([stateOf(both, 'p'), stateOf(both, 'q')], ['ambiguous', 'ambiguous']);
    const apart = links([payout('p'), payout('q', { payoutDate: '2030-03-06' })], [credit('c', '2030-03-05'), credit('d', '2030-03-10')]);
    assert.deepEqual([stateOf(apart, 'p'), stateOf(apart, 'q')], ['linked', 'linked']);
    assert.deepEqual(apart.evidence.map((entry) => [entry.payoutKey, entry.rowId]), [['p', 'c'], ['q', 'd']]);
  });

  it('a payout with no date can\'t be placed in a window: it proves nothing and lists the credits it could be, at any date', () => {
    assert.deepEqual(brief(links([payout('p', { payoutDate: null })], [credit('c', '2030-03-05')]).links[0]), ['date-unknown', null, ['c'], false]);
  });
});

describe('deposit links: binding first, and one proof-eligibility predicate (GD-03, GV4-07)', () => {
  it('a destination reaches a checking account only through an active binding', () => {
    assert.equal(stateOf(links([payout('p')], [credit('c', '2030-03-05')], { bindings: [] })), 'binding-missing');
    assert.equal(stateOf(links([payout('p', { destinationLast4: null })], [credit('c', '2030-03-05')])), 'binding-missing');
    assert.equal(stateOf(links([payout('p', { destinationLast4: '8888' })], [credit('c', '2030-03-05')])), 'binding-missing');
    const suspended = links([payout('p')], [credit('c', '2030-03-05')], { bindings: [{ ...BINDINGS[0], state: 'suspended' }] });
    assert.deepEqual([stateOf(suspended), suspended.evidence], ['binding-drift', []]);
    const elsewhere = links([payout('p')], [credit('c', '2030-03-05'), credit('e', '2030-03-05', { accountId: 'chk-b' })], {
      bindings: [{ source: 'collectpure', last4: '7777', accountId: 'chk-b', state: 'active' }],
      coverage: [{ accountId: 'chk-b', from: '2030-01-01', to: '2030-12-31' }],
    });
    assert.deepEqual(brief(elsewhere.links[0]), ['linked', 'e', ['e'], true]);
  });

  it('a destination is bound per (source, last 4): a binding for another source never matches, nor shadows the payout\'s own', () => {
    const otherSource: MetalsCheckingBinding = { source: 'walmart', last4: '7777', accountId: 'chk-a', state: 'active' };
    assert.deepEqual(brief(links([payout('p')], [credit('c', '2030-03-05')], { bindings: [otherSource] }).links[0]), ['binding-missing', null, [], false]);
    assert.equal(stateOf(links([payout('p', { source: 'walmart' })], [credit('c', '2030-03-05')])), 'binding-missing');
    const shadow = links([payout('p')], [credit('c', '2030-03-05')], { bindings: [{ ...otherSource, state: 'suspended' }, ...BINDINGS] });
    assert.deepEqual([stateOf(shadow), shadow.evidence.length], ['linked', 1]);
  });

  it('a quarantined sale keeps its candidate visible but proves nothing and classifies no credit; resolving it reconciles again', () => {
    const quarantined = links([payout('p', { active: false })], [credit('c', '2030-03-05')]);
    assert.deepEqual(brief(quarantined.links[0]), ['ineligible', 'c', ['c'], false]);
    assert.deepEqual(quarantined.evidence, []);
    const resolved = links([payout('p')], [credit('c', '2030-03-05')]);
    assert.deepEqual(brief(resolved.links[0]), ['linked', 'c', ['c'], true]);
    assert.equal(resolved.evidence.length, 1);
  });

  it('a quarantined sale still contests a credit another payout could take: adverse evidence never strengthens a link', () => {
    const result = links([payout('p', { active: false }), payout('q', { payoutDate: '2030-03-05' })], [credit('c', '2030-03-06')]);
    assert.deepEqual([stateOf(result, 'p'), stateOf(result, 'q')], ['ambiguous', 'ambiguous']);
    assert.deepEqual(result.evidence, []);
  });
});

describe('deposit links: one each way over all payouts, even those that can\'t prove a link (§4.4.5)', () => {
  const coveredThrough = (to: string): MetalsCheckingCoverage[] => [{ accountId: 'chk-a', from: '2030-03-04', to }];
  const states = (result: ReturnType<typeof links>) => result.links.map((link) => link.state);

  it('a payout whose window coverage doesn\'t reach still contests the credits it could account for, in any payout order', () => {
    const a = payout('a', { payoutDate: '2030-03-04' });
    const b = payout('b', { payoutDate: '2030-03-06' });
    for (const payouts of [[a, b], [b, a]]) {
      const result = links(payouts, [credit('c', '2030-03-07')], { coverage: coveredThrough('2030-03-09') });
      assert.deepEqual(brief(result.links.find((link) => link.payoutKey === 'a')!), ['ambiguous', null, ['c'], false]);
      assert.deepEqual(brief(result.links.find((link) => link.payoutKey === 'b')!), ['not-covered', null, ['c'], false]);
      assert.deepEqual(result.evidence, []);
    }
    // With B's window covered too, both stay ambiguous: losing coverage never creates a proof.
    const covered = links([a, b], [credit('c', '2030-03-07')], { coverage: coveredThrough('2030-03-11') });
    assert.deepEqual(states(covered), ['ambiguous', 'ambiguous']);
    // A credit before B's window is A's alone.
    assert.deepEqual(states(links([a, b], [credit('c', '2030-03-05')], { coverage: coveredThrough('2030-03-09') })), ['linked', 'not-covered']);
  });

  it('an undated complete payout contests the credits of its amount on its account, at any date', () => {
    const result = links([payout('a'), payout('b', { payoutDate: null })], [credit('c', '2030-03-07')]);
    assert.deepEqual(result.links.map(brief), [['ambiguous', null, ['c'], false], ['date-unknown', null, ['c'], false]]);
    assert.deepEqual(states(links([payout('a'), payout('b', { payoutDate: null, amountMinor: 500001 })], [credit('c', '2030-03-07')])), ['linked', 'date-unknown']);
  });

  it('an unbound or drifted payout contests on its account scope: accounts showing its last 4, or every account without one', () => {
    const a = payout('a');
    // The credit names both CollectPure's and Walmart's payout origins, so the Walmart payouts below can contest it.
    const rows = [credit('c', '2030-03-07', { originSources: ['walmart', 'collectpure'] })];
    // Another source's payout to the same last 4 has no binding, yet could be this credit.
    assert.deepEqual(states(links([a, payout('b', { source: 'walmart' })], rows)), ['ambiguous', 'binding-missing']);
    // A last 4 the credit's account doesn't show can't be it; no last 4 at all could be any account's.
    assert.deepEqual(states(links([a, payout('b', { destinationLast4: '8888' })], rows)), ['linked', 'binding-missing']);
    assert.deepEqual(states(links([a, payout('b', { destinationLast4: null })], rows)), ['ambiguous', 'binding-missing']);
    // A drifted binding contests wherever its last 4 shows, not only on the account it was bound to.
    const drifted: MetalsCheckingBinding[] = [...BINDINGS, { source: 'walmart', last4: '7777', accountId: 'chk-b', state: 'suspended' }];
    assert.deepEqual(states(links([a, payout('b', { source: 'walmart' })], rows, { bindings: drifted })), ['ambiguous', 'binding-drift']);
    // A pending payout may already have landed, so it contests too; a failed one never does.
    assert.deepEqual(states(links([a, payout('b', { status: 'pending', destinationLast4: null })], rows)), ['ambiguous', 'binding-missing']);
    assert.deepEqual(states(links([a, payout('b', { status: 'failed', destinationLast4: null })], rows)), ['linked', 'binding-missing']);
  });

  it('a drifted binding whose account\'s last 4 changed still contests that account, while it exists (C4, as card links do)', () => {
    // chk-a was renumbered: it shows 9999 now, so the binding approved for 7777 drifted, and one for 9999 is active.
    const accounts: MetalsCheckingAccount[] = [{ id: 'chk-a', last4: '9999' }, { id: 'chk-b', last4: '8888' }];
    const bindings: MetalsCheckingBinding[] = [
      { source: 'collectpure', last4: '7777', accountId: 'chk-a', state: 'suspended' },
      { source: 'collectpure', last4: '9999', accountId: 'chk-a', state: 'active' },
    ];
    const run = (payouts: MetalsPayoutSubject[], bound = bindings) =>
      metalsDepositLinks({ payouts, rows: [credit('c', '2030-03-07')], accounts, bindings: bound, coverage: COVERAGE });
    const newNumber = payout('new', { destinationLast4: '9999' });
    const oldNumber = payout('old', { payoutDate: '2030-03-05' });
    // The old number's payout could be the credit on chk-a, though no account shows 7777 now: the new one proves nothing.
    const result = run([newNumber, oldNumber]);
    assert.deepEqual(result.links.map((link) => [link.payoutKey, link.state, link.proof]), [['new', 'ambiguous', false], ['old', 'binding-drift', false]]);
    assert.deepEqual(result.evidence, []);
    // Alone, the new number links; and a drifted binding whose account is gone contests only the accounts showing its last 4.
    assert.deepEqual(brief(run([newNumber]).links[0]), ['linked', 'c', ['c'], true]);
    const gone = bindings.map((binding) => (binding.state === 'suspended' ? { ...binding, accountId: 'chk-gone' } : binding));
    assert.deepEqual(run([newNumber, oldNumber], gone).links.map((link) => link.state), ['linked', 'binding-drift']);
  });
});

describe('deposit links: a credit proves and is contested only within its own source\'s payouts (ROOT: scoped to CollectPure)', () => {
  const walmartBinding: MetalsCheckingBinding = { source: 'walmart', last4: '7777', accountId: 'chk-a', state: 'active' };
  const costcoBinding: MetalsCheckingBinding = { source: 'costco', last4: '7777', accountId: 'chk-a', state: 'active' };

  it('the proof filter: another source\'s bound payout whose only credit names CollectPure\'s origin is never linked, possible at most', () => {
    for (const [source, binding] of [['walmart', walmartBinding], ['costco', costcoBinding]] as const) {
      const alone = links([payout('p', { source })], [credit('c', '2030-03-05')], { bindings: [binding] });
      assert.deepEqual(brief(alone.links[0]), ['possible', 'c', ['c'], false], source);
      assert.deepEqual(alone.evidence, [], source);
    }
    // The control: a credit naming that source's own origin would be its proof, so the scope is the payout's source.
    const own = links([payout('p', { source: 'walmart' })], [credit('c', '2030-03-05', { originSources: ['walmart'] })], { bindings: [walmartBinding] });
    assert.deepEqual(brief(own.links[0]), ['linked', 'c', ['c'], true]);
  });

  it('the contest: another source\'s payout of the same cents, in an overlapping window, leaves the CollectPure payout linked', () => {
    const result = links([payout('p'), payout('w', { source: 'walmart', payoutDate: '2030-03-05' })], [credit('c', '2030-03-06')], {
      bindings: [...BINDINGS, walmartBinding],
    });
    assert.deepEqual(result.links.map(brief), [['linked', 'c', ['c'], true], ['possible', 'c', ['c'], false]]);
    assert.deepEqual(result.evidence.map((entry) => [entry.payoutKey, entry.rowId]), [['p', 'c']]);
    // Unbound, it contests no more; two CollectPure payouts still contest each other, one each way.
    assert.deepEqual(links([payout('p'), payout('w', { source: 'costco' })], [credit('c', '2030-03-06')]).links.map((link) => link.state),
      ['linked', 'binding-missing']);
    assert.deepEqual(links([payout('p'), payout('q', { payoutDate: '2030-03-05' })], [credit('c', '2030-03-06')]).links.map((link) => link.state),
      ['ambiguous', 'ambiguous']);
  });
});

describe('deposit links: monotone (property)', () => {
  it('adding a payout, losing coverage, quarantining a sale, suspending a binding or adding another candidate never creates a link (seeded)', () => {
    const next = seeded(5);
    const day = (offset: number) => new Date(Date.UTC(2030, 2, 1) + offset * 86_400_000).toISOString().slice(0, 10);
    const amounts = [500000, 250000];
    const lastFours: Array<string | null> = ['7777', '7777', '8888', '6666', null];
    const statuses = ['complete', 'complete', 'complete', 'complete', 'pending', 'failed'] as const;
    // Payouts mostly of CollectPure; credits naming no origin, CollectPure's, another source's, or two sources'.
    const payoutSources: readonly MetalsSource[] = ['collectpure', 'collectpure', 'collectpure', 'walmart', 'costco'];
    const originSets: ReadonlyArray<readonly MetalsSource[]> = [[], ['collectpure'], ['collectpure'], ['walmart'], ['costco', 'collectpure']];
    const bindings: MetalsCheckingBinding[] = [
      { source: 'collectpure', last4: '7777', accountId: 'chk-a', state: 'active' },
      { source: 'collectpure', last4: '8888', accountId: 'chk-b', state: 'active' },
    ];
    const randomPayout = (key: string) => payout(key, {
      source: payoutSources[next(payoutSources.length)], amountMinor: amounts[next(2)], initiatedDate: next(3) === 0 ? day(next(10)) : null,
      payoutDate: next(6) === 0 ? null : day(next(10)), destinationLast4: lastFours[next(lastFours.length)], status: statuses[next(statuses.length)],
      active: next(5) !== 0,
    });
    const randomCredit = (id: string) => credit(id, day(next(16)), {
      accountId: ['chk-a', 'chk-a', 'chk-b', 'chk-z'][next(4)], amountMinor: amounts[next(2)], originSources: originSets[next(originSets.length)],
    });
    const proofs = (result: ReturnType<typeof metalsDepositLinks>) =>
      new Set(result.links.filter((link) => link.proof).map((link) => `${link.payoutKey}>${link.rowId}`));
    let linksSeen = 0;
    for (let round = 0; round < 400; round += 1) {
      // A payout and a credit that link unless something contests them, among random others.
      const payouts = [payout(`p-${round}-0`, { payoutDate: day(5) }), ...Array.from({ length: next(4) }, (_, index) => randomPayout(`p-${round}-${index + 1}`))];
      const rows = [credit(`c-${round}-0`, day(6)), ...Array.from({ length: next(5) }, (_, index) => randomCredit(`c-${round}-${index + 1}`))];
      const coverage: MetalsCheckingCoverage[] = [
        { accountId: 'chk-a', from: day(0), to: day(20) },
        { accountId: 'chk-b', from: day(next(6)), to: day(10 + next(10)) },
      ];
      const run = (p = payouts, r = rows, c = coverage, b = bindings) => metalsDepositLinks({ payouts: p, rows: r, accounts: ACCOUNTS, bindings: b, coverage: c });
      const before = proofs(run());
      linksSeen += before.size;
      const lose = next(2);
      const shrunk = day(next(12));
      const quarantined = next(payouts.length);
      const suspended = next(2);
      const variants = [
        run([...payouts, randomPayout(`p-${round}-new`)]),
        run(payouts, rows, coverage.map((range, index) => (index === lose && shrunk < range.to ? { ...range, to: shrunk } : range))),
        run(payouts, rows, coverage.filter((_, index) => index !== lose)),
        run(payouts.map((entry, index) => (index === quarantined ? { ...entry, active: false } : entry))),
        run(payouts, rows, coverage, bindings.map((binding, index) => (index === suspended ? { ...binding, state: 'suspended' as const } : binding))),
        run(payouts, [...rows, { ...rows[next(rows.length)], id: `c-${round}-again` }]),
      ];
      for (const after of variants) {
        for (const proof of proofs(after)) {
          if (proof.startsWith(`p-${round}-new>`)) continue;
          assert.ok(before.has(proof), `round ${round}: a new link ${proof}`);
        }
      }
    }
    assert.ok(linksSeen > 100, `the generated ledgers link something (${linksSeen})`);
  });

  it('C4: a drifted binding also contests its last bound account, which only ever removes proofs (seeded)', () => {
    const next = seeded(44);
    const day = (offset: number) => new Date(Date.UTC(2030, 2, 1) + offset * 86_400_000).toISOString().slice(0, 10);
    const amounts = [500000, 250000];
    // chk-a was renumbered: it shows 9999 now, so the binding approved for 7777 drifted and one for 9999 is active.
    const accounts: MetalsCheckingAccount[] = [{ id: 'chk-a', last4: '9999' }, { id: 'chk-b', last4: '8888' }, { id: 'chk-z', last4: null }];
    const drifted: MetalsCheckingBinding[] = [
      { source: 'collectpure', last4: '7777', accountId: 'chk-a', state: 'suspended' },
      { source: 'collectpure', last4: '9999', accountId: 'chk-a', state: 'active' },
      { source: 'collectpure', last4: '8888', accountId: 'chk-b', state: 'active' },
    ];
    // The same ledger with C4 off: the drifted binding's account gone, so it contests only the accounts showing 7777.
    const off = drifted.map((binding) => (binding.state === 'suspended' ? { ...binding, accountId: 'chk-gone' } : binding));
    const coverage: MetalsCheckingCoverage[] = [{ accountId: 'chk-a', from: day(0), to: day(30) }, { accountId: 'chk-b', from: day(0), to: day(30) }];
    const proofs = (result: ReturnType<typeof metalsDepositLinks>) =>
      new Set(result.links.filter((link) => link.proof).map((link) => `${link.payoutKey}>${link.rowId}`));
    let changed = 0;
    for (let round = 0; round < 300; round += 1) {
      // A new-number payout and an old-number one that could both be one credit on chk-a, among random others.
      const payouts = [
        payout(`p-${round}-new`, { destinationLast4: '9999', payoutDate: day(2) }), payout(`p-${round}-old`, { payoutDate: day(1) }),
        ...Array.from({ length: next(4) }, (_, index) => payout(`p-${round}-${index}`, {
          amountMinor: amounts[next(2)], payoutDate: day(next(10)), destinationLast4: ['7777', '9999', '9999', '8888', null][next(5)],
          status: (['complete', 'complete', 'complete', 'pending', 'failed'] as const)[next(5)], active: next(5) !== 0,
        })),
      ];
      const rows = [credit(`c-${round}-0`, day(4)), ...Array.from({ length: next(4) }, (_, index) => credit(`c-${round}-${index + 1}`, day(next(16)), {
        accountId: ['chk-a', 'chk-a', 'chk-b'][next(3)], amountMinor: amounts[next(2)],
      }))];
      const run = (bindings: MetalsCheckingBinding[]) => metalsDepositLinks({ payouts, rows, accounts, bindings, coverage });
      const before = run(off);
      const after = run(drifted);
      const kept = proofs(before);
      for (const proof of proofs(after)) assert.ok(kept.has(proof), `round ${round}: C4 created ${proof}`);
      if (!isDeepStrictEqual(after, before)) changed += 1;
    }
    assert.ok(changed > 100, `a drifted binding's last bound account matters in the generated ledgers (${changed})`);
  });
});
