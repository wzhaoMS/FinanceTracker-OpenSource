/**
 * Synthetic metals payloads for tests: invented orders, titles, amounts and last 4s only, never a household's data.
 * Every derived field (content fingerprint, fine content, allocation, card evidence, competitor basis, cap and
 * interval, coverage completeness) is computed by the rules themselves, so a fixture is valid by construction and a
 * test can tamper with one fact at a time.
 */

import { metalsAdmission, metalsSettlementInterval } from '../admission.js';
import { metalsAllocation } from '../allocation.js';
import { metalsContentFingerprint, metalsFineContent, metalsFineContentWire } from '../contentRule.js';
import {
  METALS_CAPTURE_SCHEMAS,
  METALS_CONVERT_POLICY_VERSION,
  METALS_CONVERTER,
  METALS_IMPORT_FORMAT,
  METALS_IMPORT_VERSION,
  METALS_RULES,
  type MetalsAdmissionFacts,
  type MetalsChannel,
  type MetalsCoverageKind,
  type MetalsEvent,
  type MetalsOrderComponent,
  type MetalsSellStatus,
  type MetalsSkeletonLine,
  type MetalsSource,
} from '../model.js';
import {
  metalsNaturalKey,
  type MetalsCompetitor,
  type MetalsCoverage,
  type MetalsHeldRecord,
  type MetalsImportPayload,
  type MetalsLine,
  type MetalsOrder,
  type MetalsPayout,
} from '../payload.js';

/** A one-way key for synthetic native ids. */
export function syntheticKey(source: MetalsSource, kind: string, id: string | number): string {
  return metalsNaturalKey(source, kind as never, ['synthetic', String(id)]);
}

/** The content and descriptive facts of a metal line; money and derived content are filled by syntheticOrder. */
export type SyntheticLineInput = Pick<MetalsLine, 'ordinal' | 'title' | 'productRef' | 'metal' | 'form' | 'statedMass' | 'pack'
  | 'purity' | 'massBasis' | 'design' | 'quantity' | 'unitPriceMinor' | 'events'>
  & Partial<Pick<MetalsLine, 'key' | 'seller' | 'sale' | 'metalUncertain'>>;

export interface SyntheticOrderInput {
  source: MetalsSource;
  channel: MetalsChannel;
  id: string | number;
  date: string;
  skeleton: MetalsSkeletonLine[];
  components?: MetalsOrderComponent[];
  admission?: MetalsAdmissionFacts | null;
  refunds?: MetalsOrder['refunds'];
  lines: SyntheticLineInput[];
  status?: MetalsSellStatus | null;
  tradeMoment?: string | null;
  completedDate?: string | null;
  payouts?: MetalsPayout[];
}

const lineKind = (source: MetalsSource, channel: MetalsChannel) =>
  source === 'collectpure' ? 'sline' : source === 'costco' && channel === 'warehouse' ? 'wline' : 'line';
const orderKind = (source: MetalsSource, channel: MetalsChannel) =>
  source === 'collectpure' ? 'sell' : source === 'costco' && channel === 'warehouse' ? 'receipt' : 'order';

/** A complete order whose derived fields all come from the rules. */
export function syntheticOrder(input: SyntheticOrderInput): MetalsOrder {
  const side = input.source === 'collectpure' ? 'sell' : 'buy';
  const components = input.components ?? [];
  const allocation = metalsAllocation(input.skeleton, components);
  const admission = side === 'buy' ? (input.admission ?? null) : null;
  const lines = input.lines.map((line): MetalsLine => {
    const money = allocation.lines.find((entry) => entry.ordinal === line.ordinal);
    if (!money) throw new Error(`syntheticOrder: line ${line.ordinal} is not a principal skeleton line`);
    const evidence = {
      source: input.source, metal: line.metal, form: line.form, statedMass: line.statedMass, pack: line.pack,
      purity: line.purity, massBasis: line.massBasis, design: line.design, metalUncertain: line.metalUncertain ?? null,
    };
    return {
      key: line.key ?? syntheticKey(input.source, lineKind(input.source, input.channel), `${input.id}:${line.ordinal}`),
      ordinal: line.ordinal,
      title: line.title,
      productRef: line.productRef,
      metal: line.metal,
      metalUncertain: line.metalUncertain ?? null,
      form: line.form,
      statedMass: line.statedMass,
      pack: line.pack,
      purity: line.purity,
      massBasis: line.massBasis,
      design: line.design,
      contentFingerprint: metalsContentFingerprint(evidence),
      fine: metalsFineContentWire(metalsFineContent(evidence)),
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      amountMinor: input.skeleton[line.ordinal].amountMinor,
      directMinor: money.directMinor,
      allocated: money.allocated,
      costMinor: side === 'buy' ? money.totalMinor : null,
      netMinor: side === 'sell' ? money.totalMinor : null,
      complete: money.complete,
      events: line.events,
      seller: line.seller ?? null,
      sale: side === 'sell' ? (line.sale ?? { program: null, premium: null, inspection: 'passed' }) : null,
    };
  });
  return {
    key: syntheticKey(input.source, orderKind(input.source, input.channel), input.id),
    side,
    channel: input.channel,
    date: input.date,
    tradeMoment: side === 'sell' ? (input.tradeMoment ?? `${input.date}T15:00:00Z`) : null,
    completedDate: input.completedDate ?? null,
    currency: 'USD',
    status: side === 'sell' ? (input.status ?? 'complete') : null,
    skeleton: input.skeleton,
    components,
    admission,
    // A flagged line keeps its order out of card evidence, as a converter writes it.
    evidence: admission && lines.every((line) => line.metalUncertain === null)
      ? (metalsAdmission(input.source, input.channel, admission)?.evidence ?? [])
      : [],
    refunds: input.refunds ?? [],
    payouts: input.payouts ?? [],
    unattributedMinor: allocation.unattributedMinor,
    fullPriceMinor: allocation.fullPriceMinor,
    lines,
  };
}

/** A competitor whose basis, cap and interval come from its admission facts. */
export function syntheticCompetitor(
  source: MetalsSource,
  channel: MetalsChannel,
  id: string | number,
  date: string,
  admission: MetalsAdmissionFacts,
): MetalsCompetitor {
  const admitted = metalsAdmission(source, channel, admission);
  if (!admitted) throw new Error('syntheticCompetitor: no card funding');
  return {
    orderKey: syntheticKey(source, orderKind(source, channel), id),
    channel,
    date,
    interval: metalsSettlementInterval(date, channel),
    admission,
    basis: admitted.basis,
    capMinor: admitted.capMinor,
  };
}

export function syntheticCoverage(kind: MetalsCoverageKind, from: string, to: string, stated: number | null, seen: number): MetalsCoverage {
  return { kind, from, to, stated, seen, complete: stated !== null && stated === seen };
}

/** One metal item line of a skeleton. */
export function metalItem(ordinal: number, amountMinor: number, extra: Partial<MetalsSkeletonLine> = {}): MetalsSkeletonLine {
  return { ordinal, kind: 'item', amountMinor, shippingMinor: null, feeParent: null, couponTarget: null, taxFlag: null, metal: true, ...extra };
}

/** One other (non-metal) item line of a skeleton. */
export function otherItem(ordinal: number, amountMinor: number, extra: Partial<MetalsSkeletonLine> = {}): MetalsSkeletonLine {
  return metalItem(ordinal, amountMinor, { metal: false, ...extra });
}

export const delivered = (quantity: number, date: string, occurrence = 1): MetalsEvent =>
  ({ kind: 'delivered', date, dateBasis: 'stated', quantity, occurrence });

export const inStore = (quantity: number, date: string): MetalsEvent =>
  ({ kind: 'delivered', date, dateBasis: 'in-store', quantity, occurrence: 1 });

/** A payload around the given records; the source's input and rules are filled in. */
export function syntheticPayload(
  source: MetalsSource,
  records: { orders?: MetalsOrder[]; competitors?: MetalsCompetitor[]; held?: MetalsHeldRecord[]; coverage?: MetalsCoverage[] },
): MetalsImportPayload {
  return {
    format: METALS_IMPORT_FORMAT,
    version: METALS_IMPORT_VERSION,
    source,
    account: { folder: source, identityLast4: source === 'costco' ? '0000' : null },
    converterVersion: METALS_CONVERTER,
    policyVersion: METALS_CONVERT_POLICY_VERSION,
    rules: { ...METALS_RULES },
    input: source === 'costco'
      ? { retailPayloadSha256: 'a'.repeat(64), retailFormat: 3, retailPolicyVersion: 5 }
      : { schema: METALS_CAPTURE_SCHEMAS[source], captureDigest: 'b'.repeat(64), capturedAt: '2030-01-31T12:00:00Z', files: 3 },
    coverage: records.coverage ?? [],
    orders: records.orders ?? [],
    competitors: records.competitors ?? [],
    held: records.held ?? [],
  };
}

/** A Walmart order the `walmart-order-total@1` class admits: one card, one group, its stated total the grand total. */
export function walmartAdmittedOrder(id: string | number, date = '2030-01-10'): MetalsOrder {
  return syntheticOrder({
    source: 'walmart',
    channel: 'online',
    id,
    date,
    skeleton: [metalItem(0, 200000)],
    components: [{ kind: 'tax', amountMinor: 0 }],
    admission: {
      fulfilment: { shipments: 1 },
      methods: [{ kind: 'card', network: 'visa', last4: '1111', amountMinor: 200000 }],
      refunded: false,
      cancelled: false,
      partlyCancelled: false,
      grossTotalMinor: 200000,
    },
    lines: [{
      ordinal: 0,
      title: 'Sample Refinery 1 ozt Gold Bar FINE GOLD .9999',
      productRef: 'walmart:100001',
      metal: 'XAU',
      form: 'bar',
      statedMass: { value: '1', unit: 'ozt' },
      pack: 'single',
      purity: { text: '.9999', value: '9999/10000' },
      massBasis: 'fine',
      design: null,
      quantity: 1,
      unitPriceMinor: 200000,
      events: [delivered(1, new Date(Date.parse(`${date}T00:00:00Z`) + 4 * 86_400_000).toISOString().slice(0, 10))],
      seller: 'Sample Bullion Shop',
    }],
  });
}
