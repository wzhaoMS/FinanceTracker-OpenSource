import { ITEM_TAXONOMY_VERSION_V2 } from '@finance-tracker/shared';

/**
 * The retail taxonomy's formats and version labels (Costco 3/7 plan v5 §6, §7): the one source for the CLI, the tests
 * and the docs check. Retail reads the shared tree's v2 view.
 */

/** The private worklist `taxonomy worklist` writes (§6.1). */
export const RETAIL_TAXONOMY_WORKLIST_FORMAT = 'holdr.retail-taxonomy-worklist' as const;
/** A classifier's output, the input to `taxonomy adopt` (§6.2). */
export const RETAIL_TAXONOMY_ASSIGNMENTS_FORMAT = 'holdr.retail-taxonomy-assignments' as const;
/** A reviewed mapping, written by `adopt` or by hand, imported under a GO (§6.3). */
export const RETAIL_TAXONOMY_MAPPING_FORMAT = 'holdr.retail-taxonomy-mapping' as const;
/** Each file format's version. */
export const RETAIL_TAXONOMY_FILE_VERSION = 1 as const;
/** The tree version every retail file names: the shared tree's v2. */
export const RETAIL_TAXONOMY_VERSION = ITEM_TAXONOMY_VERSION_V2;
/**
 * The same version as the taxonomy imports table's `taxonomy_version` stores it: PR 2's frozen column is a slug, so v2 is
 * `taxonomy-v2`. A stored row of any other label is of another version, never current (Q-T4).
 */
export const RETAIL_TAXONOMY_STORED_VERSION = `taxonomy-v${RETAIL_TAXONOMY_VERSION}` as const;
/** Every taxonomy file, read or written, is at most this size. */
export const RETAIL_TAXONOMY_FILE_MAX_BYTES = 16 * 1024 * 1024;
/** At most this many distinct description pairs per product in the worklist (§6.1). */
export const RETAIL_TAXONOMY_TITLES_MAX = 8;
/** The domain tag of a subject key's digest (§5). */
export const RETAIL_TAXONOMY_SUBJECT_FORMAT = 'holdr.retail-taxonomy-subject' as const;
/** The domain tag of the plan's preimage (§7.3). */
export const RETAIL_TAXONOMY_PLAN_FORMAT = 'holdr.retail-taxonomy-plan' as const;
