import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RETAIL_METAL_PACK_RULE } from '../retailImportTool/metalPackRule.js';
import { RETAIL_METAL_GUARD, RETAIL_METAL_GUARD_EVIDENCE, RETAIL_METAL_TITLE_RULE, RETAIL_METALS } from '../retailImportTool/metalTitleRule.js';
import type { RetailLineMetalUncertain } from '../retailImportTool/payload.js';
import { METALS_CONTENT_RULE } from './contentRule.js';
import { METALS, METALS_CONVERTER, METALS_CONVERTER_VERSION, METALS_GUARD_EVIDENCE, METALS_RULES, METALS_TITLE_GUARD, type MetalsLineMetalUncertain } from './model.js';

describe('METALS_RULES: the retail rules a metals payload names are the ones the retail tool runs', () => {
  it('pins the title rule as the retail tool labels it, so the label and the code never diverge (retail policy 5)', () => {
    assert.equal(METALS_RULES.title, RETAIL_METAL_TITLE_RULE);
  });

  it('names the pack rule the retail tool runs', () => {
    assert.equal(METALS_RULES.pack, RETAIL_METAL_PACK_RULE);
  });

  it('names metals-content-v2: the flag, its hold and the bullion decision are new vocabulary (contract follow-up 1)', () => {
    assert.equal(METALS_RULES.content, 'metals-content-v2');
    assert.equal(METALS_CONTENT_RULE, METALS_RULES.content);
  });
});

describe('the title guard\'s flag: read in the retail tool\'s own vocabulary, pinned (contract follow-up 1)', () => {
  // A flagged line's content fingerprint binds the guard, its evidence in order and the flag's metal: the contract reads
  // the retail tool's own lists, and these values are pinned, so a new guard or order is a deliberate new content rule.
  it('names the retail tool\'s guard, metal-guard-v1', () => {
    assert.equal(METALS_TITLE_GUARD, RETAIL_METAL_GUARD);
    assert.equal(METALS_TITLE_GUARD, 'metal-guard-v1');
  });

  it('reads the guard\'s evidence in the retail tool\'s closed order', () => {
    assert.equal(METALS_GUARD_EVIDENCE, RETAIL_METAL_GUARD_EVIDENCE);
    assert.deepEqual(METALS_GUARD_EVIDENCE, ['bullion-word', 'design-after-metal', 'shape-with-weight', 'troy-or-metric-weight', 'purity', 'adjacency']);
  });

  it('checks a flag\'s metal against the retail tool\'s metals', () => {
    assert.equal(METALS, RETAIL_METALS);
    assert.deepEqual(METALS, ['XAU', 'XAG', 'XPT', 'XPD']);
  });

  it('carries retail format 3\'s line flag in its own shape: each assigns to the other (tsc checks the types)', () => {
    const retail: RetailLineMetalUncertain = { guard: RETAIL_METAL_GUARD, evidence: ['shape-with-weight', 'purity'], metal: 'XAU' };
    const contract: MetalsLineMetalUncertain = retail;
    const back: RetailLineMetalUncertain = contract;
    assert.deepEqual(back, { guard: 'metal-guard-v1', evidence: ['shape-with-weight', 'purity'], metal: 'XAU' });
  });
});

describe('METALS_RULES.titleGuard: the title guard every producer runs, the retail tool\'s own (contract follow-up 1E)', () => {
  it('is the retail tool\'s own guard, metal-guard-v1, the guard a flag names', () => {
    assert.equal(METALS_RULES.titleGuard, RETAIL_METAL_GUARD);
    assert.equal(METALS_RULES.titleGuard, METALS_TITLE_GUARD);
    assert.equal(METALS_RULES.titleGuard, 'metal-guard-v1');
  });
});

describe('the converters\' one release, the only one a payload may name (contract follow-up 1E)', () => {
  it('is 1.1.0, the release where every producer runs the title guard', () => {
    assert.equal(METALS_CONVERTER_VERSION, '1.1.0');
    assert.equal(METALS_CONVERTER, 'holdr-metals-convert 1.1.0');
  });
});
