/**
 * A fixed matrix of unflagged content evidence and owner content decisions (synthetic), and one digest of the content
 * rule's answers over it: each line's fingerprint and fine-content wire form, alone and with decisions. The contract
 * follow-up pins the digest metals-content-v1 gives, so a line with no flag keeps v1's answers byte for byte.
 *
 * It uses only what v1 accepts (content decisions, no kind), so the same function runs against the v1 rule.
 */

import { sha256, toLetterHex } from '../../cardDedupe.js';
import type { MetalsContentContext, MetalsContentDecision, MetalsContentEvidence, MetalsContentResult } from '../contentRule.js';
import type { MetalsFineContent, MetalsSource } from '../model.js';

export interface MetalsContentRuleFunctions {
  fingerprint: (evidence: MetalsContentEvidence) => string;
  fine: (evidence: MetalsContentEvidence, context?: MetalsContentContext) => MetalsContentResult;
  wire: (result: MetalsContentResult) => MetalsFineContent;
}

const SOURCES: readonly MetalsSource[] = ['costco', 'walmart', 'collectpure'];
const METALS = ['XAU', 'XAG', 'XPT', null] as const;
const FORMS = ['bar', 'coin', 'round', 'bullion', null] as const;
const MASSES = [
  { value: '1', unit: 'ozt' }, { value: '1', unit: 'oz' }, { value: '1/10', unit: 'oz' }, { value: '0.1', unit: 'oz' },
  { value: '1/4', unit: 'oz' }, { value: '10', unit: 'g' }, { value: '1', unit: 'kg' }, { value: '0', unit: 'g' }, null,
] as const;
const PACKS = ['single', 'multiple', 'unknown'] as const;
const PURITIES = [null, { text: '.9999', value: '9999/10000' }, { text: '22K', value: '11/12' }] as const;
const BASES = ['none', 'fine', 'gross', 'unknown'] as const;
const DESIGNS = [null, 'eagle'] as const;

/** Every unflagged evidence of the matrix, in a fixed order (Costco carries no raw purity, mass basis or design). */
export function metalsContentPinEvidence(): MetalsContentEvidence[] {
  const cases: MetalsContentEvidence[] = [];
  for (const source of SOURCES) {
    const raw = source !== 'costco';
    for (const metal of METALS) for (const form of FORMS) for (const statedMass of MASSES) for (const pack of PACKS) {
      for (const purity of raw ? PURITIES : [null]) for (const massBasis of raw ? BASES : [null]) for (const design of raw ? DESIGNS : [null]) {
        cases.push({
          source, metal, form, statedMass: statedMass ? { ...statedMass } : null, pack, purity: purity ? { ...purity } : null,
          massBasis, design, metalUncertain: null,
        });
      }
    }
  }
  return cases;
}

/** One of eight decision contexts, by case index: matching, stale, foreign, shared, refless and malformed decisions. */
function pinContext(index: number, fingerprint: string): MetalsContentContext {
  const product = (troyOzPerUnit: string, print = fingerprint): MetalsContentDecision =>
    ({ scope: 'product', productRef: 'walmart:pin-ref', fingerprint: print, troyOzPerUnit });
  const lot = (evidenceDigest: string, lotKey = 'pin-lot'): MetalsContentDecision =>
    ({ scope: 'lot', lotKey, evidenceDigest, troyOzPerUnit: '1/10' });
  const base = { lotKey: 'pin-lot', productRef: 'walmart:pin-ref' as string | null, productRefUnique: true, evidenceDigest: 'pin-digest' };
  switch (index % 8) {
    case 0: return { ...base, decisions: [product('1/1')] };
    case 1: return { ...base, decisions: [lot('pin-digest')] };
    case 2: return { ...base, decisions: [lot('pin-other')] };
    case 3: return { ...base, decisions: [product('1/1', 'a'.repeat(64))] };
    case 4: return { ...base, productRefUnique: false, decisions: [product('1/1')] };
    case 5: return { ...base, productRef: null, decisions: [product('1/1')] };
    case 6: return { ...base, decisions: [product('0/1')] };
    default: return { ...base, decisions: [lot('pin-digest', 'pin-other-lot'), product('2/1')] };
  }
}

/** The number of cases and one letter-hex digest of every answer, in order. */
export function metalsContentPinDigest(rule: MetalsContentRuleFunctions): { cases: number; digest: string } {
  const evidence = metalsContentPinEvidence();
  const lines = evidence.map((entry, index) => {
    const fingerprint = rule.fingerprint(entry);
    const alone = rule.wire(rule.fine(entry));
    const decided = rule.wire(rule.fine(entry, pinContext(index, fingerprint)));
    return `${fingerprint}|${JSON.stringify(alone)}|${JSON.stringify(decided)}`;
  });
  return { cases: evidence.length, digest: toLetterHex(sha256(new TextEncoder().encode(lines.join('\n')))) };
}
