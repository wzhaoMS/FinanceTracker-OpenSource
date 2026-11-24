/**
 * What every `holdr-metals-convert` source shares (design v8 §5.1): the one converter version every payload names, the
 * refusal a converter throws, and the shape of a source's entry in the CLI's registry
 * (apps/api/src/cli/metalsConvert.ts). The CLI reads and checks the files; a converter only ever sees their bytes.
 *
 * Pure: no file system, network or clock.
 */

import type { MetalsSource } from '../model.js';
import { serializeMetalsImportPayload, validateMetalsImportPayload, type MetalsImportPayload, type MetalsOrder } from '../payload.js';

/**
 * The converters' one release (`METALS_CONVERTER_VERSION`) and what every payload names (`METALS_CONVERTER`): defined
 * in the contract (model.ts), whose validator accepts only that release, and re-exported here for the converters and
 * the CLI.
 */
export { METALS_CONVERTER, METALS_CONVERTER_VERSION } from '../model.js';

const CODE = /^[a-z][a-z0-9-]{1,47}$/;
/** A structural path: `$` or a schema key, then `.key` and `[index]` steps; never a value. */
const AT = /^(?:\$|[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]{1,6}\])*$/;

/**
 * A refusal of a converter's whole input: nothing of it is converted. Its code is a closed, kebab-case name each
 * converter documents (`schema-unsupported`, `capture-unreadable`, …), and `at` a structural path at most; anything
 * else given is replaced, so the message can never carry a value.
 */
export class MetalsConvertError extends Error {
  readonly code: string;
  readonly at: string | null;
  constructor(code: string, at?: string) {
    const safeCode = CODE.test(code) ? code : 'converter-invalid';
    const safeAt = at !== undefined && AT.test(at) ? at : null;
    super(safeAt === null ? safeCode : `${safeCode} at ${safeAt}`);
    this.name = 'MetalsConvertError';
    this.code = safeCode;
    this.at = safeAt;
  }
}

/** A conversion's report, a plain object of counts, closed codes, dates and digests only, printed as it is. */
export type MetalsConvertReport = object;

/** What a converter returns: the payload, its canonical text (the exact bytes the CLI writes) and its report. */
export interface MetalsConvertOutput<R extends MetalsConvertReport = MetalsConvertReport> {
  payload: MetalsImportPayload;
  json: string;
  report: R;
}

/** One file of a capture folder, as the CLI read it: a regular file, listed in the manifest with this size and SHA-256. */
export interface MetalsCaptureFile {
  /** Its path inside the account folder, `/`-separated: `walmart.json`, `raw/detail-<n>.json`. Never printed. */
  path: string;
  bytes: Uint8Array;
}

/** Where a capture folder's files are: a directory of the folder (`''` for the folder itself) and the names read there. */
export interface MetalsCaptureFiles {
  dir: string;
  name: RegExp;
  /** The folder is refused when no such file is there. */
  required: boolean;
}

/** A capture folder's files, read and checked, with the version the payload must name. */
export interface MetalsCaptureFolder {
  /** The account folder's own name (`walmart`, `walmart-2`, …), which the payload names, even for a snapshot. */
  folder: string;
  /** A snapshot's own folder name (`snap20261108`) when the files are a snapshot nested in the account folder, else null. */
  snapshot: string | null;
  /** Every file the converter's layout lists, in layout order, then by name. */
  files: readonly MetalsCaptureFile[];
  converterVersion: string;
}

/** A source converted from a capture folder under the owner's private manifest (Walmart, CollectPure). */
export interface MetalsCaptureConverter {
  readonly input: 'capture-folder';
  readonly source: MetalsSource;
  /** The account folder's name. */
  readonly folder: RegExp;
  /**
   * A snapshot folder's name, when the source keeps snapshots of the same layout nested in the account folder
   * (CollectPure's `snap<yyyymmdd>`). A snapshot is converted on its own and names its account folder.
   */
  readonly snapshot?: RegExp;
  /** Every file the converter reads, in the given folder only (never in a nested one); nothing else is read. */
  readonly files: readonly MetalsCaptureFiles[];
  convert(capture: MetalsCaptureFolder): MetalsConvertOutput;
}

/** One payload of another Holdr converter, as the CLI read it (a regular file, never a link). */
export interface MetalsRetailPayloadFile {
  bytes: Uint8Array;
  converterVersion: string;
}

/** A source converted from another converter's payload (Costco: one membership's holdr.retail-import file). */
export interface MetalsRetailPayloadConverter {
  readonly input: 'retail-payload';
  readonly source: MetalsSource;
  convert(retail: MetalsRetailPayloadFile): MetalsConvertOutput;
}

/** A source's entry in the CLI's registry. */
export type MetalsConverter = MetalsCaptureConverter | MetalsRetailPayloadConverter;

/**
 * A converter's last step: the payload checked by the validator, which recomputes every derived fact, and its canonical
 * text. A payload that fails is a converter fault: `converter-invalid` at the first issue's path.
 */
export function metalsConvertOutput<R extends MetalsConvertReport>(payload: MetalsImportPayload, report: R): MetalsConvertOutput<R> {
  const checked = validateMetalsImportPayload(payload);
  if (!checked.ok) throw new MetalsConvertError('converter-invalid', checked.issues[0]?.path);
  return { payload, json: serializeMetalsImportPayload(payload), report };
}

// ---------------------------------------------------------------------------
// The owner's one-time questions (Q1 and Q1b), stated the same way by every source's report
// ---------------------------------------------------------------------------

/** Content confirmations over a set of unflagged lots. */
export interface MetalsConfirmationParts {
  /** One per product ref and content fingerprint among the `single`-pack lots with a metal and a ref. */
  productScoped: number;
  /** One per lot for every other lot with a metal: a `multiple` or `unknown` pack, or no product ref. */
  lotScoped: number;
  /** The lots with no metal (their title names several metals): no confirmation can name a metal. */
  metalUnknown: number;
}

/**
 * Q1, the owner's one-time content confirmations (§4.4.1), over the unflagged lots: `productScoped`, `lotScoped` and
 * `metalUnknown` over every one, `productRefs` the product refs among them, and `notCancelledOrReturned` the same parts
 * over the lots with a unit neither cancelled nor returned (delivered and kept, or awaiting delivery): a lot whose every
 * unit was cancelled or returned changes no figure, whatever it contains. Q1 itself is `needed`, product-scoped plus
 * lot-scoped over those open lots; `neededIncludingFullyCancelledOrReturned` is the same over every unflagged lot.
 */
export interface MetalsConfirmationCounts {
  needed: number;
  neededIncludingFullyCancelledOrReturned: number;
  productRefs: number;
  productScoped: number;
  lotScoped: number;
  metalUnknown: number;
  notCancelledOrReturned: MetalsConfirmationParts;
}

/** Bullion decisions over a set of flagged lots. */
export interface MetalsBullionParts {
  /** `productScoped` plus `lotScoped`. */
  needed: number;
  /** One per product ref and content fingerprint (the whole flag included) among the flagged lots with a ref, any pack. */
  productScoped: number;
  /** One per flagged lot with no product ref. */
  lotScoped: number;
}

/**
 * Q1b, beside Q1: the owner's bullion decisions (§4c.1), over the flagged lots (`metalUncertain` set) with a unit kept
 * or on the way; `includingFullyCancelledOrReturned` counts the same over every flagged lot. A flagged lot is counted
 * here only, never in Q1 (not even as `metalUnknown`): content alone never releases its bullion hold, so its bullion
 * decision comes before any content confirmation.
 */
export interface MetalsBullionCounts extends MetalsBullionParts {
  includingFullyCancelledOrReturned: MetalsBullionParts;
}

/** Q1 and Q1b: a report's `confirmations` and `bullion` blocks. */
export interface MetalsOwnerQuestionCounts {
  confirmations: MetalsConfirmationCounts;
  bullion: MetalsBullionCounts;
}

/**
 * The owner's questions over a payload's orders, the one computation every source's report states. The lots are the
 * buy orders' lines; a sale order is skipped (a disposition needs neither answer). A lot is open while a unit is neither
 * cancelled nor returned: its `cancelled` and `returned` events' quantities sum to less than its own. Counts only.
 */
export function metalsOwnerQuestionCounts(orders: readonly MetalsOrder[]): MetalsOwnerQuestionCounts {
  const refs = new Set<string>();
  const products = new Set<string>();
  const openProducts = new Set<string>();
  const bullionProducts = new Set<string>();
  const openBullionProducts = new Set<string>();
  const every: MetalsConfirmationParts = { productScoped: 0, lotScoped: 0, metalUnknown: 0 };
  const open: MetalsConfirmationParts = { productScoped: 0, lotScoped: 0, metalUnknown: 0 };
  const everyFlagged: MetalsBullionParts = { needed: 0, productScoped: 0, lotScoped: 0 };
  const openFlagged: MetalsBullionParts = { needed: 0, productScoped: 0, lotScoped: 0 };
  for (const order of orders) {
    if (order.side !== 'buy') continue;
    for (const line of order.lines) {
      const gone = line.events.filter((event) => event.kind === 'cancelled' || event.kind === 'returned')
        .reduce((total, event) => total + event.quantity, 0);
      const isOpen = gone < line.quantity;
      const product = line.productRef === null ? null : `${line.productRef}\x00${line.contentFingerprint}`;
      if (line.metalUncertain !== null) {
        // Q1b only: its bullion decision comes first, product-wide by ref and fingerprint whatever the pack, else lot-scoped.
        if (product !== null) {
          bullionProducts.add(product);
          if (isOpen) openBullionProducts.add(product);
        } else {
          everyFlagged.lotScoped += 1;
          if (isOpen) openFlagged.lotScoped += 1;
        }
        continue;
      }
      if (line.productRef !== null) refs.add(line.productRef);
      if (line.metal === null) {
        every.metalUnknown += 1;
        if (isOpen) open.metalUnknown += 1;
      } else if (line.pack === 'single' && product !== null) {
        products.add(product);
        if (isOpen) openProducts.add(product);
      } else {
        every.lotScoped += 1;
        if (isOpen) open.lotScoped += 1;
      }
    }
  }
  every.productScoped = products.size;
  open.productScoped = openProducts.size;
  everyFlagged.productScoped = bullionProducts.size;
  everyFlagged.needed = everyFlagged.productScoped + everyFlagged.lotScoped;
  openFlagged.productScoped = openBullionProducts.size;
  openFlagged.needed = openFlagged.productScoped + openFlagged.lotScoped;
  return {
    confirmations: {
      needed: open.productScoped + open.lotScoped,
      neededIncludingFullyCancelledOrReturned: every.productScoped + every.lotScoped,
      productRefs: refs.size,
      productScoped: every.productScoped,
      lotScoped: every.lotScoped,
      metalUnknown: every.metalUnknown,
      notCancelledOrReturned: open,
    },
    bullion: { ...openFlagged, includingFullyCancelledOrReturned: everyFlagged },
  };
}
