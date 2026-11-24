import { randomBytes } from 'node:crypto';

import { ITEM_TAXONOMY_BP_SCALE, toLetterHex } from '@finance-tracker/shared';

import { HoldrRefusal } from '../dbErrors.js';

/**
 * The retail domain's closed codes, ids, purposes and write authority (Costco receipts 2/7, plan v5 §8, §9). A thin typed
 * adapter for this domain: the shared primitives (dbErrors.ts, schemaShape.ts, cli/operatorIo.ts) do the work, and this
 * module only names what is retail's own (plan §3).
 */

/** Done: the command did what it says. The `retail-taxonomy-…` codes are the taxonomy commands' (Costco 3/7 plan v5 §7.5). */
export const RETAIL_DONE_CODES = [
  'retail-planned', 'retail-declaration-valid', 'retail-previewed', 'retail-installed', 'retail-imported', 'retail-quarantine-listed',
  'retail-reviewed', 'retail-bindings-proposed', 'retail-reported',
  'retail-taxonomy-worklist-written', 'retail-taxonomy-mapping-written', 'retail-taxonomy-planned', 'retail-taxonomy-imported',
] as const;
/** Nothing to do: the same install, payload or review file again. No backup, no write. */
export const RETAIL_NOTHING_CODES = ['retail-already-installed', 'retail-already-imported', 'retail-already-reviewed'] as const;
/** Refused, nothing written; `retail-reserved-value` is the integrity STOP (plan §5.7): report to Root, change nothing. */
export const RETAIL_REFUSAL_CODES = [
  'retail-conflict', 'retail-not-installed', 'retail-reserved-value', 'retail-no-shared-lease', 'retail-go-invalid', 'retail-go-id-invalid',
  'retail-purpose-invalid', 'retail-input-mismatch', 'retail-payload-too-large', 'retail-payload-not-canonical', 'retail-payload-invalid',
  'retail-payload-unstorable', 'retail-declaration-invalid', 'retail-declaration-mismatch', 'retail-membership-undeclared',
  'retail-membership-declared-twice', 'retail-membership-unknown', 'retail-membership-conflict', 'retail-receipt-conflict', 'retail-plan-changed',
  'retail-review-invalid', 'retail-review-stale', 'retail-receipt-unknown', 'retail-receipt-not-quarantined', 'retail-path-not-absolute',
  'retail-output-exists', 'retail-output-not-owner-only', 'retail-output-uncheckable', 'retail-output-name-refused', 'retail-clone-is-source',
  'retail-digest-invalid',
  'retail-time-invalid',
  'retail-taxonomy-file-invalid', 'retail-taxonomy-node-unknown', 'retail-taxonomy-source-invalid', 'retail-taxonomy-subject-unknown',
  'retail-taxonomy-worklist-mismatch',
] as const;
/** Every code `holdr-retail` prints (plan §9), from these three lists only. */
export const RETAIL_CODES = [...RETAIL_DONE_CODES, ...RETAIL_NOTHING_CODES, ...RETAIL_REFUSAL_CODES] as const;
export type RetailCode = (typeof RETAIL_CODES)[number];
export type RetailRefusalCode = (typeof RETAIL_REFUSAL_CODES)[number];

/**
 * A refusal whose message is a stable, closed code; `details` holds counts, closed codes, refs, digests, paths into the
 * payload and dates only: never an amount, a last four, a title, a label or a natural key (design v5 §4: natural keys
 * never leave the owner-private database).
 */
export class RetailRefusal extends HoldrRefusal {
  readonly code: RetailRefusalCode;
  readonly details: Record<string, unknown>;

  constructor(code: RetailRefusalCode, details: Record<string, unknown> = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

const GO_ID = /^[0-9a-f]{32}$/;
const HEX_DIGEST = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A digest or GO id as the database stores it (plan §4.1): the lowercase hex a GO, a file or the output carries (32 or 64
 * characters), in letter hex, through the shared `toLetterHex`. Anything else is `retail-digest-invalid`.
 */
export function retailLetters(hex: string): string {
  if (typeof hex !== 'string' || !HEX_DIGEST.test(hex)) throw new RetailRefusal('retail-digest-invalid');
  return toLetterHex(Buffer.from(hex, 'hex'));
}

/**
 * The ids this domain assigns: a prefix and 128 random bits in letter hex, never derived from a natural key (design v5
 * §4). `rcp-`, `rli-` and `shp-` are the refs the read API shows from PR 5; the others stay in the operator's output.
 * `shp-` and `rtn-` name one distinct observation of a shipment or a tender, never a position (plan §4.3).
 */
export const RETAIL_ID_PREFIXES = [
  'rtl-mbr-', 'rtl-imp-', 'rtl-rev-', 'rtl-bind-', 'rtl-tax-', 'rcp-', 'rrv-', 'rob-', 'rhd-', 'rli-', 'shp-', 'rtn-',
] as const;
export type RetailIdPrefix = (typeof RETAIL_ID_PREFIXES)[number];
export const newRetailId = (prefix: RetailIdPrefix): string => `${prefix}${toLetterHex(randomBytes(16))}`;
/** An id of one prefix, as a file or an option names it. */
export const retailIdPattern = (prefix: RetailIdPrefix): RegExp => new RegExp(`^${prefix}[a-p]{32}$`);

/**
 * The purposes a writer's GO may name, by command (plan §8.4). `taxonomy-import` is the taxonomy's (Costco 3/7 plan v5
 * §6.4): its purposes are the ones the taxonomy imports table stores, so its production purpose is `production-taxonomy`.
 */
export const RETAIL_PURPOSES = {
  install: ['copy-rehearsal', 'production-install'],
  import: ['copy-rehearsal', 'production-import'],
  'review-receipt': ['copy-rehearsal', 'production-review'],
  'taxonomy-import': ['copy-rehearsal', 'production-taxonomy'],
} as const satisfies Record<string, readonly string[]>;
export type RetailWriteCommand = keyof typeof RETAIL_PURPOSES;
/** The writers the preview may run on its own clone, under no GO (plan §8.2): every other writer needs a GO. */
const PREVIEW_COMMANDS: readonly RetailWriteCommand[] = ['install', 'import'];

/** What a taxonomy assignment is about (Costco 3/7 plan v5 §5): a product (merchant, item number) or a department. */
export const RETAIL_TAXONOMY_SUBJECT_KINDS = ['product', 'department'] as const;
export type RetailTaxonomySubjectKind = (typeof RETAIL_TAXONOMY_SUBJECT_KINDS)[number];
/** An agent's confidence in basis points, from 0 to this (the shared tree's scale): the taxonomy table's CHECK bound. */
export const RETAIL_CONFIDENCE_BP_MAX = ITEM_TAXONOMY_BP_SCALE;

/**
 * What the preview's clone records where a GO's purpose goes (plan §8.2): no GO authorizes the clone's install and
 * import, so none is minted or faked; their rows carry this purpose and no GO id, and only the preview writes it.
 */
export const RETAIL_PREVIEW_PURPOSE = 'preview' as const;

/** Who authorizes a write: a Root GO (its id, 32 lowercase hex, and its purpose), or the preview, on its own clone only. */
export type RetailAuthority = { kind: 'go'; goId: string; purpose: string } | { kind: 'preview' };

/** The context every writer takes: when (a 24-character instant), and under which authority. */
export interface RetailWriteContext {
  now: string;
  authority: RetailAuthority;
}

/** A write context as stored: the time, the GO id in letter hex (null for the preview) and the purpose. */
export interface RetailStoredAuthority {
  at: string;
  goId: string | null;
  purpose: string;
}

/**
 * Checks a writer's context before anything is read: a real 24-character instant (`retail-time-invalid`), and a GO id
 * (`retail-go-id-invalid`) and purpose of the command's (`retail-purpose-invalid`), or the preview's authority where the
 * command allows it (install and import, on the clone). A review and a taxonomy import always need a GO.
 */
export function checkRetailWriteContext(context: RetailWriteContext, command: RetailWriteCommand): RetailStoredAuthority {
  const now: unknown = context?.now;
  if (typeof now !== 'string' || !INSTANT.test(now) || Number.isNaN(Date.parse(now)) || new Date(now).toISOString() !== now) {
    throw new RetailRefusal('retail-time-invalid');
  }
  const authority = context.authority;
  if (authority?.kind === 'preview' && PREVIEW_COMMANDS.includes(command)) return { at: now, goId: null, purpose: RETAIL_PREVIEW_PURPOSE };
  if (authority?.kind !== 'go' || typeof authority.goId !== 'string' || !GO_ID.test(authority.goId)) {
    throw new RetailRefusal('retail-go-id-invalid');
  }
  if (!(RETAIL_PURPOSES[command] as readonly string[]).includes(authority.purpose)) throw new RetailRefusal('retail-purpose-invalid');
  return { at: now, goId: retailLetters(authority.goId), purpose: authority.purpose };
}
