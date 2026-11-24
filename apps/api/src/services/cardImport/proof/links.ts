import type { Database } from 'better-sqlite3';

import { hasAmazonSchema } from '../../amazon/schema.js';
import { linkedCardRows, settleAmazon } from '../../amazon/settle.js';

/**
 * G-LINKS (design v1.1 §3.4, ROOT D2).
 * - Stored: the linked card rows as stored. A card import never writes the Amazon tables, so any change is a bug, and it
 *   holds.
 * - Projected: the matcher "always recompute[s] against the entire ledger" (`matcher.ts`), so a new card row can unlink
 *   or move an order at the next Amazon settle. The real settle (`settleAmazon`) runs in a savepoint that is always
 *   rolled back, before the import (P1) and after it (P2). P1 → P2 must lose and move nothing. P0 (stored) → P1 drift
 *   is reported only: this import did not cause it.
 * Without the Amazon tables (a fresh database), links are not applicable.
 */

export type LinkedRows = ReadonlyMap<string, string>;

class ProjectionRollback extends Error {}

export function amazonLinksApplicable(db: Database): boolean {
  return hasAmazonSchema(db);
}

export function storedLinks(db: Database): LinkedRows {
  return linkedCardRows(db);
}

/** What the next Amazon settle would link, on the current (uncommitted) state; the database is left exactly as it was. */
export function projectedLinks(db: Database, now: string): LinkedRows {
  if (!db.inTransaction) throw new Error('projected links need the proof transaction');
  let projected: LinkedRows = new Map();
  try {
    db.transaction(() => {
      settleAmazon(db, now);
      projected = linkedCardRows(db);
      throw new ProjectionRollback();
    })();
  } catch (error) {
    if (!(error instanceof ProjectionRollback)) throw error;
  }
  return projected;
}

export interface LinksDiff {
  lost: number;
  moved: number;
  added: number;
}

/** Card rows linked before and no longer linked (lost), linked to other orders (moved), or newly linked (added). */
export function diffLinks(before: LinkedRows, after: LinkedRows): LinksDiff {
  let lost = 0, moved = 0, added = 0;
  for (const [row, orders] of before) {
    if (!after.has(row)) lost += 1;
    else if (after.get(row) !== orders) moved += 1;
  }
  for (const row of after.keys()) if (!before.has(row)) added += 1;
  return { lost, moved, added };
}
