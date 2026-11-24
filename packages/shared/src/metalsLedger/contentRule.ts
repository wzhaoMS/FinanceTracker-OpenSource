/**
 * `METALS_CONTENT_RULE` v2 ('metals-content-v2', design v8 §4.4.1, contract follow-up 1): the fine metal content of one
 * ordered unit, from the first authority that applies, or a hold that names every step that lacked an answer. Mass, the
 * reading of its unit, and the authority for fine content are separate facts, each kept with its basis; nothing is
 * guessed. v2 (from v1) adds the title guard's flag to the evidence and the fingerprint, the `bullion-unconfirmed` hold
 * and the `bullion` decision; a line with no flag gets v1's answers, byte for byte.
 *
 * Authorities, in order:
 * - `owner-confirmed`: the owner's decision, fine troy ounces per ordered unit. A product-wide decision (product ref
 *   and content fingerprint) is reused only by a `single`-pack line with that unique ref and that fingerprint; a
 *   lot-scoped decision (every `multiple` or `unknown` pack, or a missing or non-unique ref) answers only its own lot,
 *   while that lot's active evidence digest is the one it approved. Anything else under an existing decision is held
 *   `confirmation-drift` until confirmed again. A decision answers pack, mass, unit, purity and fineness at once, but
 *   never names the metal.
 * - `coin-specification` (Walmart and CollectPure): a title whose form is a coin, unambiguously (a title naming a coin
 *   design beside a bar or round reads no form, so it gets none), a recognized design in its metal, a `single` pack, a
 *   stated mass equal to a listed denomination, and mass basis `none` (exact and unqualified).
 * - `stated-mass-basis` (Walmart and CollectPure): a bar, ingot, round or bullion title, a `single` pack, mass in `ozt`,
 *   `g` or `kg`, and mass basis `gross` with an exact stated purity (fine = mass × purity) or `fine` (fine = mass).
 * Costco lines carry no raw purity, mass-basis or design evidence, so only the owner can confirm them in v1.
 *
 * A line the title guard flagged (`metalUncertain`, contract follow-up 1) is held `bullion-unconfirmed`: its title
 * reads as no metal, so nothing here counts it as metal on its own reading. The owner's `bullion` decision for it
 * (scoped as a content decision is) releases the hold: it is then a line of the metal its flag names, and the
 * authorities above apply as usual.
 *
 * Pure: no file system, network or clock.
 */

import { sha256, toLetterHex } from '../cardDedupe.js';
import { metalsCoinSpecification } from './coinSpecs.js';
import {
  METALS_BULLION_ANSWERS,
  METALS_RULES,
  type Metal,
  type MetalForm,
  type MetalPack,
  type MetalsBullionAnswer,
  type MetalsCoinDesign,
  type MetalsContentHold,
  type MetalsFineBasis,
  type MetalsFineContent,
  type MetalsLineMetalUncertain,
  type MetalsMassBasis,
  type MetalsPurity,
  type MetalsSource,
  type MetalsStatedMass,
} from './model.js';
import { formatRational, multiply, parseRational, readRational, troyOunces, type Rational } from './rational.js';

export const METALS_CONTENT_RULE = METALS_RULES.content;

/**
 * A line's content evidence: the title rule's facts, the pinned raw-derived observations (null for Costco), and the
 * title guard's flag (null on a line the guard didn't flag).
 */
export interface MetalsContentEvidence {
  source: MetalsSource;
  metal: Metal | null;
  form: MetalForm | null;
  statedMass: MetalsStatedMass | null;
  pack: MetalPack;
  purity: MetalsPurity | null;
  massBasis: MetalsMassBasis | null;
  design: MetalsCoinDesign | null;
  metalUncertain: MetalsLineMetalUncertain | null;
}

/**
 * An owner's decision, with the scope it was approved for; neither kind ever names the metal:
 * - `product-content` (the kind may be left out): fine troy ounces per ordered unit ("n/d");
 * - `bullion`: whether a line the title guard flagged is bullion.
 */
export type MetalsContentDecision =
  | { kind?: 'product-content'; scope: 'product'; productRef: string; fingerprint: string; troyOzPerUnit: string }
  | { kind?: 'product-content'; scope: 'lot'; lotKey: string; evidenceDigest: string; troyOzPerUnit: string }
  | { kind: 'bullion'; scope: 'product'; productRef: string; fingerprint: string; answer: MetalsBullionAnswer }
  | { kind: 'bullion'; scope: 'lot'; lotKey: string; evidenceDigest: string; answer: MetalsBullionAnswer };
type ContentDecision = Exclude<MetalsContentDecision, { kind: 'bullion' }>;
type BullionDecision = Extract<MetalsContentDecision, { kind: 'bullion' }>;
const isBullionDecision = (decision: MetalsContentDecision): decision is BullionDecision => decision.kind === 'bullion';
const isContentDecision = (decision: MetalsContentDecision): decision is ContentDecision => decision.kind !== 'bullion';
const isBullionAnswer = (answer: unknown): answer is MetalsBullionAnswer => (METALS_BULLION_ANSWERS as readonly unknown[]).includes(answer);

/** Where a line stands for the owner's decisions: its lot, its product ref, and its order's active evidence digest. */
export interface MetalsContentContext {
  lotKey: string;
  /** Null when the source gives none. */
  productRef: string | null;
  /** Whether the ref names one product only (a ref shared by different products answers for none of them). */
  productRefUnique: boolean;
  evidenceDigest: string;
  /** Every live decision of the line's lot and of its ref, of both kinds, never pre-filtered by fingerprint. */
  decisions: readonly MetalsContentDecision[];
}

/** Fine content per ordered unit, exact, or held. */
export type MetalsContentResult =
  | { known: true; troyOz: Rational; basis: MetalsFineBasis }
  | { known: false; hold: MetalsContentHold; missing: MetalsContentHold[] };

const FINGERPRINT_TAG = 'holdr.metals-content-fingerprint';
const encoder = new TextEncoder();

/**
 * The content fingerprint: a one-way digest, in letter hex, of the line's derived content evidence (metal, form, stated
 * mass and unit, pack, purity, mass basis, coin design, and a flagged line's whole flag: its guard, evidence and metal).
 * A spelling change that derives the same evidence keeps it. It is always the raw line's: a decision never changes it.
 */
export function metalsContentFingerprint(evidence: MetalsContentEvidence): string {
  const facts = [
    evidence.metal ?? '',
    evidence.form ?? '',
    evidence.statedMass ? `${evidence.statedMass.value} ${evidence.statedMass.unit}` : '',
    evidence.pack,
    evidence.purity?.value ?? '',
    evidence.massBasis ?? '',
    evidence.design ?? '',
  ];
  // A flag is content evidence: the guard, what fired in its closed order, and the metal it names, as one more fact, so a
  // flagged line never shares an unflagged line's shape. An unflagged line's fingerprint is unchanged, byte for byte.
  const flag = evidence.metalUncertain ?? null;
  if (flag !== null) facts.push(`metal-uncertain:${flag.guard}:${flag.evidence.join(',')}:${flag.metal ?? ''}`);
  return toLetterHex(sha256(encoder.encode([FINGERPRINT_TAG, ...facts].join('\u0000'))));
}

const BAR_LIKE: ReadonlySet<MetalForm> = new Set(['bar', 'ingot', 'round', 'bullion']);

/**
 * The order holds are listed in; the first is the primary hold. A line the title guard flagged is held
 * `bullion-unconfirmed` first. A coin's stated mass is a denomination, which only a specification reads as troy ounces,
 * so its first missing fact is its fine content; for anything else it is the unit.
 */
const HOLD_ORDER: readonly MetalsContentHold[] = [
  'bullion-unconfirmed', 'confirmation-drift', 'metal-unknown', 'pack-count', 'pack-unproven', 'weight-unstated',
  'unit-unconfirmed', 'mass-basis-unknown', 'fine-content-unknown',
];
const HOLD_ORDER_COIN: readonly MetalsContentHold[] = [
  'bullion-unconfirmed', 'confirmation-drift', 'metal-unknown', 'pack-count', 'pack-unproven', 'weight-unstated',
  'fine-content-unknown', 'unit-unconfirmed', 'mass-basis-unknown',
];

function held(holds: ReadonlySet<MetalsContentHold>, coin: boolean): MetalsContentResult {
  const missing = (coin ? HOLD_ORDER_COIN : HOLD_ORDER).filter((hold) => holds.has(hold));
  if (missing.length === 0) missing.push('fine-content-unknown');
  return { known: false, hold: missing[0], missing };
}

/** The decision that answers this line, the decisions it drifted from, or neither (content decisions only). */
function decisionFor(
  evidence: MetalsContentEvidence,
  context: MetalsContentContext | undefined,
): { answer: Rational | null; drift: boolean } {
  if (!context) return { answer: null, drift: false };
  const decisions = context.decisions.filter(isContentDecision);
  const lot = decisions.find((decision) => decision.scope === 'lot' && decision.lotKey === context.lotKey);
  if (lot && lot.scope === 'lot') {
    const value = readRational(lot.troyOzPerUnit);
    if (lot.evidenceDigest === context.evidenceDigest && value !== null && value.num > 0n) return { answer: value, drift: false };
    return { answer: null, drift: true };
  }
  if (context.productRef === null) return { answer: null, drift: false };
  // Confirmations are scoped to (ref, fingerprint), and one ref may hold several live ones (one per fingerprint): the
  // line takes the one with its own fingerprint, and drifts only when its ref has decisions but none for that.
  const sameRef = decisions.filter((decision) => decision.scope === 'product' && decision.productRef === context.productRef);
  if (sameRef.length === 0) return { answer: null, drift: false };
  const fingerprint = metalsContentFingerprint(evidence);
  const product = sameRef.find((decision) => decision.scope === 'product' && decision.fingerprint === fingerprint);
  const value = product && product.scope === 'product' ? readRational(product.troyOzPerUnit) : null;
  const reusable = evidence.pack === 'single' && context.productRefUnique && value !== null && value.num > 0n;
  return reusable ? { answer: value, drift: false } : { answer: null, drift: true };
}

/**
 * The owner's bullion answer for a flagged line under its context, and whether a decision for it drifted: the one
 * matcher the content rule, the effective skeleton and the read side's "held for metals" predicate all read, so they
 * can never disagree. A line with no flag has no answer and never drifts.
 *
 * It is scoped as a content decision is: the lot's decision while the lot's active evidence digest is the one it
 * approved, else the decision for the line's unique ref with its own fingerprint. Unlike a content decision, a product
 * answer isn't limited to a `single` pack: whether a product is bullion doesn't depend on how many pieces a unit holds,
 * and the pack is in the fingerprint anyway. A decision for the line's lot or ref that no longer matches has drifted,
 * and so has one whose answer is not in the closed list.
 */
export function metalsBullionAnswer(
  evidence: MetalsContentEvidence,
  context?: MetalsContentContext,
): { answer: MetalsBullionAnswer | null; drift: boolean } {
  if ((evidence.metalUncertain ?? null) === null || !context) return { answer: null, drift: false };
  const decisions = context.decisions.filter(isBullionDecision);
  const lot = decisions.find((decision) => decision.scope === 'lot' && decision.lotKey === context.lotKey);
  if (lot && lot.scope === 'lot') {
    if (lot.evidenceDigest === context.evidenceDigest && isBullionAnswer(lot.answer)) return { answer: lot.answer, drift: false };
    return { answer: null, drift: true };
  }
  if (context.productRef === null) return { answer: null, drift: false };
  const sameRef = decisions.filter((decision) => decision.scope === 'product' && decision.productRef === context.productRef);
  if (sameRef.length === 0) return { answer: null, drift: false };
  const fingerprint = metalsContentFingerprint(evidence);
  const product = sameRef.find((decision) => decision.scope === 'product' && decision.fingerprint === fingerprint);
  // Product reuse is eligible only on the line's unique ref, with its own raw fingerprint (its whole flag included) and an
  // answer in the closed list, whatever its pack. Anything else under a decision of its ref has drifted.
  const eligible = product !== undefined && context.productRefUnique && isBullionAnswer(product.answer);
  return eligible ? { answer: product.answer, drift: false } : { answer: null, drift: true };
}

/**
 * Fine content per ordered unit by §4.4.1, from the evidence alone (a converter or the validator), or with the owner's
 * decisions (the read side). Deterministic: the same evidence and decisions always give the same answer.
 *
 * A line the title guard flagged is held `bullion-unconfirmed` until its context carries the owner's matching `bullion`
 * answer, naming every other step it would still lack as a line of the one metal its flag names (and
 * `confirmation-drift` when an answer for its lot or ref no longer matches). The gate comes before every authority: no
 * owner content confirmation, coin specification or stated mass basis counts a flagged line on its own. After `bullion`
 * it is a line of that metal, the authoritative one, and the usual authorities apply; a null metal stays
 * `metal-unknown`. `not-bullion` keeps the hold here: the read side takes the line out of metals by rebuilding the whole
 * order (effective.ts). A line with no flag is answered exactly as before the flag existed, whatever bullion decisions
 * its context carries.
 */
export function metalsFineContent(evidence: MetalsContentEvidence, context?: MetalsContentContext): MetalsContentResult {
  const flag = evidence.metalUncertain ?? null;
  if (flag === null) return contentOf(evidence, evidence.metal, context);
  const asBullion = contentOf(evidence, flag.metal, context);
  const bullion = metalsBullionAnswer(evidence, context);
  if (bullion.answer === 'bullion') return asBullion;
  const holds = new Set<MetalsContentHold>(asBullion.known ? [] : asBullion.missing);
  holds.add('bullion-unconfirmed');
  if (bullion.drift) holds.add('confirmation-drift');
  return held(holds, evidence.form === 'coin');
}

/** §4.4.1 for a line of the given metal (its own, or the one its flag names). */
function contentOf(evidence: MetalsContentEvidence, metal: Metal | null, context: MetalsContentContext | undefined): MetalsContentResult {
  const holds = new Set<MetalsContentHold>();
  if (metal === null) holds.add('metal-unknown');

  const decision = decisionFor(evidence, context);
  if (decision.answer !== null && metal !== null) {
    return { known: true, troyOz: decision.answer, basis: 'owner-confirmed' };
  }
  if (decision.drift) holds.add('confirmation-drift');

  if (evidence.pack === 'multiple') holds.add('pack-count');
  else if (evidence.pack === 'unknown') holds.add('pack-unproven');
  const mass = evidence.statedMass ? parseRational(evidence.statedMass.value) : null;
  if (mass === null || mass.num <= 0n) holds.add('weight-unstated');

  const raw = evidence.source !== 'costco';
  const unit = evidence.statedMass?.unit ?? null;
  const coin = evidence.form === 'coin';
  const barLike = evidence.form !== null && BAR_LIKE.has(evidence.form);
  const purity = evidence.purity ? readRational(evidence.purity.value) : null;
  const exactPurity = purity !== null && purity.num > 0n && purity.num <= purity.den;
  const basisEstablishes = evidence.massBasis === 'fine' || (evidence.massBasis === 'gross' && exactPurity);
  if (holds.size === 0 && raw) {
    if (coin && evidence.massBasis === 'none') {
      const fine = metalsCoinSpecification(evidence.design, metal, evidence.statedMass);
      if (fine !== null) return { known: true, troyOz: fine, basis: 'coin-specification' };
    }
    if (barLike && basisEstablishes && (unit === 'ozt' || unit === 'g' || unit === 'kg')) {
      const troy = troyOunces(mass!, unit);
      return { known: true, troyOz: evidence.massBasis === 'fine' ? troy : multiply(troy, purity!), basis: 'stated-mass-basis' };
    }
  }
  // Every step that lacked authority: a bare oz that no specification read; on a bar, ingot, round or bullion line from
  // a raw source, a mass basis that doesn't establish fine content; and fine content itself on a Costco line (only the
  // owner confirms it in v1), a coin with no specification, or a line with no bar-like form.
  if (unit === 'oz') holds.add('unit-unconfirmed');
  if (raw && barLike && !basisEstablishes) holds.add('mass-basis-unknown');
  if (!raw || !barLike) holds.add('fine-content-unknown');
  return held(holds, coin);
}

/** The payload's wire form of a result: troy ounces as "n/d" with the basis, or the hold with every missing step. */
export function metalsFineContentWire(result: MetalsContentResult): MetalsFineContent {
  return result.known
    ? { troyOz: formatRational(result.troyOz), basis: result.basis }
    : { hold: result.hold, missing: [...result.missing] };
}
