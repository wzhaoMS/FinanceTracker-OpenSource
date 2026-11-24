import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  metalsBullionAnswer,
  metalsContentFingerprint,
  metalsFineContent,
  metalsFineContentWire,
  type MetalsContentContext,
  type MetalsContentDecision,
  type MetalsContentEvidence,
  type MetalsContentResult,
} from './contentRule.js';
import { sha256, toLetterHex } from '../cardDedupe.js';
import { metalsContentPinDigest } from './__fixtures__/contentPin.js';
import { type Metal, type MetalsBullionAnswer, type MetalsLineMetalUncertain } from './model.js';
import { divide, equals, formatRational, rational, GRAMS_PER_TROY_OUNCE, type Rational } from './rational.js';

/** Synthetic evidence only. */
const bar = (overrides: Partial<MetalsContentEvidence> = {}): MetalsContentEvidence => ({
  source: 'walmart', metal: 'XAU', form: 'bar', statedMass: { value: '1', unit: 'ozt' }, pack: 'single',
  purity: null, massBasis: 'none', design: null, metalUncertain: null, ...overrides,
});
const eagle = (overrides: Partial<MetalsContentEvidence> = {}): MetalsContentEvidence => bar({
  form: 'coin', statedMass: { value: '1', unit: 'oz' }, purity: { text: '22K', value: '11/12' }, design: 'eagle', ...overrides,
});
const flag = (overrides: Partial<MetalsLineMetalUncertain> = {}): MetalsLineMetalUncertain =>
  ({ guard: 'metal-guard-v1', evidence: ['shape-with-weight'], metal: 'XAU', ...overrides });
/** A title the rule refused and the guard flagged: no metal, form or stated mass of its own. */
const flagged = (overrides: Partial<MetalsContentEvidence> = {}) =>
  bar({ metal: null, form: null, statedMass: null, metalUncertain: flag(), ...overrides });

function known(result: MetalsContentResult): { troyOz: Rational; basis: string } {
  assert.equal(result.known, true, JSON.stringify(metalsFineContentWire(result)));
  return result as { troyOz: Rational; basis: string };
}

function heldAs(result: MetalsContentResult, hold: string, missing?: string[]): void {
  assert.equal(result.known, false);
  if (result.known) return;
  assert.equal(result.hold, hold);
  if (missing) assert.deepEqual(result.missing, missing);
}

describe('content rule: stated mass basis (Walmart and CollectPure)', () => {
  it('gross mass times an exact purity: 10 g GROSS at 90% is 9 g fine', () => {
    const result = known(metalsFineContent(bar({ statedMass: { value: '10', unit: 'g' }, purity: { text: '90%', value: '9/10' }, massBasis: 'gross' })));
    assert.equal(result.basis, 'stated-mass-basis');
    assert.ok(equals(result.troyOz, divide(rational(9n), GRAMS_PER_TROY_OUNCE)));
  });

  it('a fine mass is the fine content: 1 ozt FINE GOLD .9999 is one troy ounce, never 0.9999', () => {
    const result = known(metalsFineContent(bar({ purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine' })));
    assert.ok(equals(result.troyOz, rational(1n)));
  });

  it('kilograms convert exactly', () => {
    const result = known(metalsFineContent(bar({ statedMass: { value: '1', unit: 'kg' }, massBasis: 'fine' })));
    assert.ok(equals(result.troyOz, divide(rational(1000n), GRAMS_PER_TROY_OUNCE)));
  });

  it('holds a purity with no mass basis, a conflict, an approximation or an unread title', () => {
    for (const massBasis of ['none', 'conflict', 'approximate', 'unknown'] as const) {
      heldAs(metalsFineContent(bar({ purity: { text: '.9999', value: '9999/10000' }, massBasis })), 'mass-basis-unknown', ['mass-basis-unknown']);
    }
    heldAs(metalsFineContent(bar({ massBasis: 'gross' })), 'mass-basis-unknown');
  });

  it('a bare oz is no troy ounce without a specification or the owner', () => {
    heldAs(metalsFineContent(bar({ statedMass: { value: '1', unit: 'oz' }, massBasis: 'fine' })), 'unit-unconfirmed', ['unit-unconfirmed']);
  });
});

describe('content rule: coin specification', () => {
  it('the ordinary 1 oz Eagle at 22K is one troy ounce by specification, never times purity', () => {
    const result = known(metalsFineContent(eagle()));
    assert.equal(result.basis, 'coin-specification');
    assert.ok(equals(result.troyOz, rational(1n)));
  });

  it('reads each listed denomination however the title writes it', () => {
    for (const value of ['1/10', '0.1']) {
      assert.ok(equals(known(metalsFineContent(eagle({ statedMass: { value, unit: 'oz' } }))).troyOz, rational(1n, 10n)));
    }
    assert.ok(equals(known(metalsFineContent(eagle({ statedMass: { value: '1', unit: 'ozt' } }))).troyOz, rational(1n)));
  });

  it('gives no specification for a gross, fine, approximate, conflicting or unread qualifier: held until the owner confirms', () => {
    for (const massBasis of ['gross', 'fine', 'approximate', 'conflict', 'unknown'] as const) {
      heldAs(metalsFineContent(eagle({ massBasis })), 'fine-content-unknown', ['fine-content-unknown', 'unit-unconfirmed']);
    }
  });

  it('gives none for an unlisted denomination, metal or unit, or no design', () => {
    heldAs(metalsFineContent(eagle({ statedMass: { value: '2', unit: 'oz' } })), 'fine-content-unknown');
    heldAs(metalsFineContent(eagle({ metal: 'XAG' })), 'fine-content-unknown');
    heldAs(metalsFineContent(eagle({ statedMass: { value: '31.1', unit: 'g' } })), 'fine-content-unknown');
    heldAs(metalsFineContent(eagle({ design: null })), 'fine-content-unknown');
  });

  it('gives none unless the form is unambiguously a coin: "1 oz Gold Eagle Bar" reads no form and is held', () => {
    heldAs(metalsFineContent(eagle({ form: null })), 'unit-unconfirmed', ['unit-unconfirmed', 'fine-content-unknown']);
    heldAs(metalsFineContent(eagle({ form: 'bar' })), 'unit-unconfirmed', ['unit-unconfirmed', 'mass-basis-unknown']);
    heldAs(metalsFineContent(eagle({ form: 'round' })), 'unit-unconfirmed', ['unit-unconfirmed', 'mass-basis-unknown']);
    heldAs(metalsFineContent(eagle({ form: 'bullion', statedMass: { value: '1', unit: 'ozt' } })), 'mass-basis-unknown', ['mass-basis-unknown']);
    assert.equal(known(metalsFineContent(eagle({ form: 'coin' }))).basis, 'coin-specification');
  });
});

describe('content rule: holds', () => {
  it('names the primary missing step and every other step that lacked authority', () => {
    heldAs(metalsFineContent(bar({ metal: null })), 'metal-unknown', ['metal-unknown', 'mass-basis-unknown']);
    heldAs(metalsFineContent(bar({ pack: 'multiple' })), 'pack-count', ['pack-count', 'mass-basis-unknown']);
    heldAs(metalsFineContent(bar({ pack: 'unknown' })), 'pack-unproven', ['pack-unproven', 'mass-basis-unknown']);
    heldAs(metalsFineContent(bar({ pack: 'unknown', massBasis: 'fine' })), 'pack-unproven', ['pack-unproven']);
    heldAs(metalsFineContent(bar({ statedMass: null })), 'weight-unstated', ['weight-unstated', 'mass-basis-unknown']);
    heldAs(metalsFineContent(bar({ metal: null, pack: 'multiple', statedMass: { value: '1', unit: 'oz' } })), 'metal-unknown',
      ['metal-unknown', 'pack-count', 'unit-unconfirmed', 'mass-basis-unknown']);
    heldAs(metalsFineContent(bar({ form: null, massBasis: 'fine' })), 'fine-content-unknown', ['fine-content-unknown']);
  });

  it('a Costco line never takes a specification or fineness path', () => {
    const costco = { source: 'costco' as const, purity: null, massBasis: null, design: null };
    heldAs(metalsFineContent(bar(costco)), 'fine-content-unknown', ['fine-content-unknown']);
    heldAs(metalsFineContent(bar({ ...costco, statedMass: { value: '1', unit: 'oz' } })), 'unit-unconfirmed',
      ['unit-unconfirmed', 'fine-content-unknown']);
    heldAs(metalsFineContent(eagle(costco)), 'fine-content-unknown', ['fine-content-unknown', 'unit-unconfirmed']);
    heldAs(metalsFineContent(bar({ ...costco, massBasis: 'fine' as never })), 'fine-content-unknown', ['fine-content-unknown']);
  });

  it('carries its wire form exactly', () => {
    assert.deepEqual(metalsFineContentWire(metalsFineContent(eagle({ statedMass: { value: '1/4', unit: 'oz' } }))),
      { troyOz: '1/4', basis: 'coin-specification' });
    assert.deepEqual(metalsFineContentWire(metalsFineContent(bar({ pack: 'unknown' }))),
      { hold: 'pack-unproven', missing: ['pack-unproven', 'mass-basis-unknown'] });
  });
});

describe('content rule: fingerprint', () => {
  it('is letter hex, stable, and changes with every content fact', () => {
    const base = bar({ purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine' });
    const print = metalsContentFingerprint(base);
    assert.match(print, /^[a-p]{64}$/);
    assert.equal(metalsContentFingerprint({ ...base }), print);
    for (const change of [
      { metal: 'XAG' }, { form: 'round' }, { statedMass: { value: '10', unit: 'ozt' } }, { statedMass: { value: '1', unit: 'oz' } },
      { pack: 'multiple' }, { purity: null }, { purity: { text: '999.9', value: '9999/10000' } }, { massBasis: 'gross' },
      { design: 'eagle' }, { metalUncertain: { guard: 'metal-guard-v1', evidence: ['purity'], metal: 'XAU' } },
    ] as Array<Partial<MetalsContentEvidence>>) {
      const changed = metalsContentFingerprint({ ...base, ...change });
      if ('purity' in change && change.purity?.value === '9999/10000') assert.equal(changed, print, 'the same exact purity');
      else assert.notEqual(changed, print, JSON.stringify(change));
    }
  });

  it('keeps an unflagged line\'s fingerprint byte for byte (an independent copy of the unflagged algorithm)', () => {
    const unflagged = (evidence: MetalsContentEvidence) => toLetterHex(sha256(new TextEncoder().encode([
      'holdr.metals-content-fingerprint', evidence.metal ?? '', evidence.form ?? '',
      evidence.statedMass ? `${evidence.statedMass.value} ${evidence.statedMass.unit}` : '', evidence.pack, evidence.purity?.value ?? '',
      evidence.massBasis ?? '', evidence.design ?? '',
    ].join('\u0000'))));
    for (const evidence of [bar(), eagle(), bar({ source: 'costco', purity: null, massBasis: null, statedMass: { value: '1', unit: 'oz' } }),
      bar({ metal: null, form: null, statedMass: null, pack: 'unknown', massBasis: null })]) {
      assert.equal(metalsContentFingerprint(evidence), unflagged(evidence), JSON.stringify(evidence));
    }
  });
});

describe('content rule: a line the title guard flagged (contract follow-up 1)', () => {
  it('is held bullion-unconfirmed first, naming every other step it lacks as a line of the metal its flag names', () => {
    heldAs(metalsFineContent(flagged()), 'bullion-unconfirmed', ['bullion-unconfirmed', 'weight-unstated', 'fine-content-unknown']);
    heldAs(metalsFineContent(flagged({ metalUncertain: flag({ metal: null }) })), 'bullion-unconfirmed',
      ['bullion-unconfirmed', 'metal-unknown', 'weight-unstated', 'fine-content-unknown']);
    assert.deepEqual(metalsFineContentWire(metalsFineContent(flagged())),
      { hold: 'bullion-unconfirmed', missing: ['bullion-unconfirmed', 'weight-unstated', 'fine-content-unknown'] });
  });

  it('is held even when its own facts would read as known', () => {
    const facts: Partial<MetalsContentEvidence> = {
      form: 'bar', statedMass: { value: '1', unit: 'ozt' }, purity: { text: '.9999', value: '9999/10000' }, massBasis: 'fine',
    };
    assert.equal(known(metalsFineContent(bar(facts))).basis, 'stated-mass-basis');
    heldAs(metalsFineContent(flagged(facts)), 'bullion-unconfirmed', ['bullion-unconfirmed']);
    heldAs(metalsFineContent(flagged({ ...facts, metal: 'XAU' })), 'bullion-unconfirmed', ['bullion-unconfirmed']);
    assert.equal(known(metalsFineContent(eagle())).basis, 'coin-specification');
    heldAs(metalsFineContent(eagle({ metal: null, metalUncertain: flag() })), 'bullion-unconfirmed', ['bullion-unconfirmed']);
  });

  it('orders a flagged coin\'s other steps as a coin\'s: fine content before the unit', () => {
    heldAs(metalsFineContent(flagged({ form: 'coin', statedMass: { value: '1', unit: 'oz' } })), 'bullion-unconfirmed',
      ['bullion-unconfirmed', 'fine-content-unknown', 'unit-unconfirmed']);
    heldAs(metalsFineContent(flagged({ form: 'bar', statedMass: { value: '1', unit: 'oz' }, massBasis: 'fine' })), 'bullion-unconfirmed',
      ['bullion-unconfirmed', 'unit-unconfirmed']);
  });

  it('fingerprints the flag: what fired and the metal it names', () => {
    const print = metalsContentFingerprint(flagged());
    assert.equal(metalsContentFingerprint(flagged()), print);
    for (const other of [flagged({ metalUncertain: null }), flagged({ metalUncertain: flag({ evidence: ['shape-with-weight', 'purity'] }) }),
      flagged({ metalUncertain: flag({ metal: 'XAG' }) }), flagged({ metalUncertain: flag({ metal: null }) })]) {
      assert.notEqual(metalsContentFingerprint(other), print, JSON.stringify(other.metalUncertain));
    }
  });
});

describe('content rule: owner decisions (GV4-04, GV5-02)', () => {
  const single = bar({ source: 'costco', purity: null, massBasis: null, statedMass: { value: '1', unit: 'oz' } });
  const product = (evidence: MetalsContentEvidence, troyOzPerUnit = '1/1') =>
    ({ scope: 'product' as const, productRef: 'costco:200001', fingerprint: metalsContentFingerprint(evidence), troyOzPerUnit });
  const context = (decisions: MetalsContentContext['decisions'], overrides: Partial<MetalsContentContext> = {}): MetalsContentContext => ({
    lotKey: 'costco-line-lot-one', productRef: 'costco:200001', productRefUnique: true, evidenceDigest: 'digest-one', decisions, ...overrides,
  });

  it('a product decision answers a compatible single repeat under the same ref', () => {
    const result = known(metalsFineContent(single, context([product(single)], { lotKey: 'costco-line-lot-two' })));
    assert.equal(result.basis, 'owner-confirmed');
    assert.equal(formatRational(result.troyOz), '1/1');
  });

  it('a later line under the ref that turns into a package, or changes denomination or metal, drifts', () => {
    const decisions = [product(single)];
    heldAs(metalsFineContent({ ...single, pack: 'multiple' }, context(decisions)), 'confirmation-drift',
      ['confirmation-drift', 'pack-count', 'unit-unconfirmed', 'fine-content-unknown']);
    heldAs(metalsFineContent({ ...single, statedMass: { value: '1/10', unit: 'oz' } }, context(decisions)), 'confirmation-drift');
    heldAs(metalsFineContent({ ...single, metal: 'XAG' }, context(decisions)), 'confirmation-drift');
  });

  it('a missing or non-unique ref shares no decision', () => {
    heldAs(metalsFineContent(single, context([product(single)], { productRef: null })), 'unit-unconfirmed');
    heldAs(metalsFineContent(single, context([product(single)], { productRefUnique: false })), 'confirmation-drift');
  });

  it('a five-pack and a ten-pack under one ref never share a confirmation: each lot is its own', () => {
    const five = { ...single, pack: 'multiple' as const };
    const fiveLot = { scope: 'lot' as const, lotKey: 'costco-line-five', evidenceDigest: 'digest-five', troyOzPerUnit: '5/1' };
    const answered = known(metalsFineContent(five, context([fiveLot], { lotKey: 'costco-line-five', evidenceDigest: 'digest-five' })));
    assert.equal(formatRational(answered.troyOz), '5/1');
    heldAs(metalsFineContent(five, context([fiveLot], { lotKey: 'costco-line-ten', evidenceDigest: 'digest-ten' })), 'pack-count');
    const unknownPack = { ...single, pack: 'unknown' as const };
    heldAs(metalsFineContent(unknownPack, context([fiveLot], { lotKey: 'costco-line-other' })), 'pack-unproven');
  });

  it('a lot decision is reviewed again when its lot\'s active evidence changes', () => {
    const lot = { scope: 'lot' as const, lotKey: 'costco-line-lot-one', evidenceDigest: 'digest-one', troyOzPerUnit: '1/1' };
    known(metalsFineContent({ ...single, pack: 'unknown' }, context([lot])));
    heldAs(metalsFineContent({ ...single, pack: 'unknown' }, context([lot], { evidenceDigest: 'digest-two' })), 'confirmation-drift');
  });

  it('never answers the metal, and never accepts a non-positive or malformed amount', () => {
    heldAs(metalsFineContent({ ...single, metal: null }, context([product({ ...single, metal: null })])), 'metal-unknown');
    for (const troyOzPerUnit of ['0/1', '-1/1', '2/4', 'one']) {
      heldAs(metalsFineContent(single, context([product(single, troyOzPerUnit)])), 'confirmation-drift');
    }
  });

  it('revoking the decision restores the holds', () => {
    heldAs(metalsFineContent(single, context([])), 'unit-unconfirmed');
  });

  it('one ref may hold a confirmation per fingerprint: each line takes its own, in any order, and a third drifts', () => {
    const tenth = { ...single, statedMass: { value: '1/10', unit: 'oz' as const } };
    const decisions = [product(single, '1/1'), product(tenth, '1/10')];
    for (const ordered of [decisions, [...decisions].reverse()]) {
      assert.equal(formatRational(known(metalsFineContent(single, context(ordered))).troyOz), '1/1');
      assert.equal(formatRational(known(metalsFineContent(tenth, context(ordered))).troyOz), '1/10');
      heldAs(metalsFineContent({ ...single, statedMass: { value: '1/2', unit: 'oz' } }, context(ordered)), 'confirmation-drift');
    }
  });
});

describe('content rule: the owner\'s bullion decision (contract follow-up 1)', () => {
  const LOT = 'walmart-line-lot-one';
  const REF = 'walmart:100002';
  const bullionLot = (answer: MetalsBullionAnswer = 'bullion', evidenceDigest = 'digest-one', lotKey = LOT): MetalsContentDecision =>
    ({ kind: 'bullion', scope: 'lot', lotKey, evidenceDigest, answer });
  const bullionProduct = (evidence: MetalsContentEvidence, answer: MetalsBullionAnswer = 'bullion'): MetalsContentDecision =>
    ({ kind: 'bullion', scope: 'product', productRef: REF, fingerprint: metalsContentFingerprint(evidence), answer });
  const contentLot = (troyOzPerUnit = '1/1'): MetalsContentDecision => ({ scope: 'lot', lotKey: LOT, evidenceDigest: 'digest-one', troyOzPerUnit });
  const context = (decisions: MetalsContentDecision[], overrides: Partial<MetalsContentContext> = {}): MetalsContentContext => ({
    lotKey: LOT, productRef: REF, productRefUnique: true, evidenceDigest: 'digest-one', decisions, ...overrides,
  });
  const unconfirmed = ['bullion-unconfirmed', 'weight-unstated', 'fine-content-unknown'];
  const drifted = ['bullion-unconfirmed', 'confirmation-drift', 'weight-unstated', 'fine-content-unknown'];

  it('releases the hold after a matching bullion decision; then the usual authorities answer, the owner\'s content first', () => {
    heldAs(metalsFineContent(flagged(), context([bullionLot()])), 'weight-unstated', ['weight-unstated', 'fine-content-unknown']);
    const lot = known(metalsFineContent(flagged(), context([bullionLot(), contentLot('1/1')])));
    assert.equal(lot.basis, 'owner-confirmed');
    assert.equal(formatRational(lot.troyOz), '1/1');
    const product = known(metalsFineContent(flagged(), context([bullionProduct(flagged()), contentLot('1/2')])));
    assert.equal(formatRational(product.troyOz), '1/2');
  });

  it('counts a line only after both: a content confirmation without a bullion decision keeps the hold', () => {
    heldAs(metalsFineContent(flagged(), context([contentLot()])), 'bullion-unconfirmed', ['bullion-unconfirmed']);
    heldAs(metalsFineContent(flagged()), 'bullion-unconfirmed', unconfirmed);
    heldAs(metalsFineContent(flagged(), context([])), 'bullion-unconfirmed', unconfirmed);
  });

  it('makes it a line of its flag\'s metal, never the decision\'s or its own; a null metal stays metal-unknown', () => {
    const coin = (metal: Metal | null, own: Metal | null = null) => eagle({ metal: own, metalUncertain: flag({ metal }) });
    assert.equal(known(metalsFineContent(coin('XAU'), context([bullionLot()]))).basis, 'coin-specification');
    heldAs(metalsFineContent(coin('XAG'), context([bullionLot()])), 'fine-content-unknown', ['fine-content-unknown', 'unit-unconfirmed']);
    assert.equal(known(metalsFineContent(coin('XAU', 'XAG'), context([bullionLot()]))).basis, 'coin-specification');
    heldAs(metalsFineContent(coin(null), context([bullionLot(), contentLot()])), 'metal-unknown',
      ['metal-unknown', 'fine-content-unknown', 'unit-unconfirmed']);
  });

  it('not bullion keeps the hold here: the read side takes the line out of metals', () => {
    heldAs(metalsFineContent(flagged(), context([bullionLot('not-bullion'), contentLot()])), 'bullion-unconfirmed', ['bullion-unconfirmed']);
    heldAs(metalsFineContent(flagged(), context([bullionProduct(flagged(), 'not-bullion')])), 'bullion-unconfirmed', unconfirmed);
  });

  it('a decision for its lot or ref that no longer matches has drifted, and brings the hold back', () => {
    heldAs(metalsFineContent(flagged(), context([bullionLot('bullion', 'digest-two')])), 'bullion-unconfirmed', drifted);
    const otherPrint = bullionProduct(flagged({ metalUncertain: flag({ evidence: ['purity'] }) }));
    heldAs(metalsFineContent(flagged(), context([otherPrint])), 'bullion-unconfirmed', drifted);
    heldAs(metalsFineContent(flagged(), context([bullionProduct(flagged())], { productRefUnique: false })), 'bullion-unconfirmed', drifted);
    heldAs(metalsFineContent(flagged(), context([bullionLot('yes' as never)])), 'bullion-unconfirmed', drifted);
    // A later capture whose flag names another metal has another fingerprint: the product's answer no longer matches.
    heldAs(metalsFineContent(flagged({ metalUncertain: flag({ metal: 'XAG' }) }), context([bullionProduct(flagged())])), 'bullion-unconfirmed', drifted);
  });

  it('a decision for another lot, or a ref when the line has none, is no decision for this line', () => {
    heldAs(metalsFineContent(flagged(), context([bullionLot('bullion', 'digest-one', 'walmart-line-lot-two')])), 'bullion-unconfirmed', unconfirmed);
    heldAs(metalsFineContent(flagged(), context([bullionProduct(flagged())], { productRef: null })), 'bullion-unconfirmed', unconfirmed);
  });

  it('answers by its lot first, then its ref, as a content decision does', () => {
    heldAs(metalsFineContent(flagged(), context([bullionProduct(flagged()), bullionLot('not-bullion')])), 'bullion-unconfirmed', unconfirmed);
    heldAs(metalsFineContent(flagged(), context([bullionProduct(flagged(), 'not-bullion'), bullionLot()])), 'weight-unstated');
  });

  it('a product answer is not limited to a single pack', () => {
    const pack = flagged({ pack: 'multiple' });
    heldAs(metalsFineContent(pack, context([bullionProduct(pack)])), 'pack-count', ['pack-count', 'weight-unstated', 'fine-content-unknown']);
  });

  it('tells each case apart through the one exported matcher the read side shares', () => {
    const cases: Array<[MetalsContentEvidence, MetalsContentContext | undefined, ReturnType<typeof metalsBullionAnswer>]> = [
      [flagged(), undefined, { answer: null, drift: false }],
      [flagged(), context([]), { answer: null, drift: false }],
      [flagged(), context([bullionLot()]), { answer: 'bullion', drift: false }],
      [flagged(), context([bullionLot('not-bullion')]), { answer: 'not-bullion', drift: false }],
      [flagged(), context([bullionProduct(flagged(), 'not-bullion')]), { answer: 'not-bullion', drift: false }],
      [flagged(), context([bullionLot('bullion', 'digest-two')]), { answer: null, drift: true }],
      [bar(), context([bullionLot(), bullionProduct(bar())]), { answer: null, drift: false }],
    ];
    for (const [evidence, decided, expected] of cases) assert.deepEqual(metalsBullionAnswer(evidence, decided), expected);
  });

  it('never touches a line with no flag: bullion decisions beside content ones change nothing', () => {
    const single = bar({ source: 'costco', purity: null, massBasis: null, statedMass: { value: '1', unit: 'oz' } });
    const product: MetalsContentDecision = { scope: 'product', productRef: REF, fingerprint: metalsContentFingerprint(single), troyOzPerUnit: '1/1' };
    for (const decisions of [[], [product], [contentLot()], [contentLot('0/1')]]) {
      const alone = metalsFineContentWire(metalsFineContent(single, context(decisions)));
      for (const bullion of [[bullionLot()], [bullionLot('not-bullion', 'digest-two')], [bullionProduct(single)], [bullionProduct(flagged())]]) {
        assert.deepEqual(metalsFineContentWire(metalsFineContent(single, context([...bullion, ...decisions]))), alone, JSON.stringify(decisions));
        assert.deepEqual(metalsFineContentWire(metalsFineContent(single, context([...decisions, ...bullion]))), alone, JSON.stringify(decisions));
      }
    }
    heldAs(metalsFineContent(single, context([bullionProduct(single)])), 'unit-unconfirmed', ['unit-unconfirmed', 'fine-content-unknown']);
    heldAs(metalsFineContent(single, context([bullionLot()])), 'unit-unconfirmed', ['unit-unconfirmed', 'fine-content-unknown']);
  });

  it('binds the whole flag: the guard, the evidence or the metal alone changes the fingerprint (design 4c.1)', () => {
    const print = metalsContentFingerprint(flagged());
    for (const other of [flag({ guard: 'metal-guard-v2' as never }), flag({ evidence: ['bullion-word'] }),
      flag({ evidence: ['shape-with-weight', 'adjacency'] }), flag({ metal: 'XAG' }), flag({ metal: null })]) {
      assert.notEqual(metalsContentFingerprint(flagged({ metalUncertain: other })), print, JSON.stringify(other));
    }
    assert.notEqual(metalsContentFingerprint(flagged({ metalUncertain: null })), print);
    heldAs(metalsFineContent(flagged({ metalUncertain: flag({ guard: 'metal-guard-v2' as never }) }), context([bullionProduct(flagged())])),
      'bullion-unconfirmed', drifted);
  });

  it('an evidence-only change reuses no product decision of either kind (design 4c.1)', () => {
    const before = flagged();
    const after = flagged({ metalUncertain: flag({ evidence: ['shape-with-weight', 'purity'] }) });
    const contentProduct: MetalsContentDecision = { scope: 'product', productRef: REF, fingerprint: metalsContentFingerprint(before), troyOzPerUnit: '1/1' };
    assert.equal(known(metalsFineContent(before, context([bullionProduct(before), contentProduct]))).basis, 'owner-confirmed');
    heldAs(metalsFineContent(after, context([bullionProduct(before), contentProduct])), 'bullion-unconfirmed', drifted);
    heldAs(metalsFineContent(after, context([bullionLot(), contentProduct])), 'confirmation-drift',
      ['confirmation-drift', 'weight-unstated', 'fine-content-unknown']);
  });

  it('reads the raw flag and fingerprint when decisions apply, and changes neither (design 4c.1)', () => {
    const freeze = <T>(value: T): T => {
      if (value !== null && typeof value === 'object') {
        for (const inner of Object.values(value as Record<string, unknown>)) freeze(inner);
        Object.freeze(value);
      }
      return value;
    };
    const evidence = freeze(flagged());
    const print = metalsContentFingerprint(evidence);
    const decisions = freeze([bullionLot(), { scope: 'product', productRef: REF, fingerprint: print, troyOzPerUnit: '1/1' }] as MetalsContentDecision[]);
    assert.equal(known(metalsFineContent(evidence, context(decisions))).basis, 'owner-confirmed');
    assert.equal(metalsContentFingerprint(evidence), print);
    // A decision keyed as if the flag's metal were the line's own (no flag) is no decision for it.
    const asIf: MetalsContentEvidence = { ...evidence, metal: 'XAU', metalUncertain: null };
    const elsewhere: MetalsContentDecision = { scope: 'product', productRef: REF, fingerprint: metalsContentFingerprint(asIf), troyOzPerUnit: '1/1' };
    heldAs(metalsFineContent(evidence, context([bullionLot(), elsewhere])), 'confirmation-drift');
  });
});

describe('content rule: a line with no flag keeps metals-content-v1 byte for byte', () => {
  it('gives the digest metals-content-v1 gave over the synthetic pin matrix (computed at daf8871c)', () => {
    const pin = metalsContentPinDigest({ fingerprint: metalsContentFingerprint, fine: metalsFineContent, wire: metalsFineContentWire });
    assert.deepEqual(pin, { cases: 26460, digest: 'mepcnbblfibhafmfjngknfjjnkinapockmpbgbpikfgcccemhfniihbdniojkiop' });
  });
});
