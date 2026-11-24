/**
 * The one-to-one rule, extracted from the Amazon domain's matcher (Costco receipts 4/7 §2.1): over the candidate
 * edges, each a subject and a card row it could be, a subject links to a row only when that row is its one candidate
 * and the subject is the row's one claimant. An edge given twice counts twice. Who may be a subject, and which edges
 * count, stay each source's own. Pure and deterministic.
 */
export interface UniqueBothWays {
  /** How many candidate edges name the subject: 0 for a subject with none. */
  candidates(subject: string): number;
  /** The row the subject links to: its one candidate, when no other edge names that row. Else null. */
  linked(subject: string): string | null;
  /** How many candidate edges name the row: 0 for a row with none. */
  degree(row: string): number;
}

export function uniqueBothWays(edges: Iterable<{ readonly subject: string; readonly row: string }>): UniqueBothWays {
  const rowsBySubject = new Map<string, string[]>();
  const degrees = new Map<string, number>();
  for (const { subject, row } of edges) {
    const rows = rowsBySubject.get(subject) ?? [];
    rows.push(row);
    rowsBySubject.set(subject, rows);
    degrees.set(row, (degrees.get(row) ?? 0) + 1);
  }
  const degree = (row: string): number => degrees.get(row) ?? 0;
  return Object.freeze({
    candidates: (subject: string): number => rowsBySubject.get(subject)?.length ?? 0,
    linked: (subject: string): string | null => {
      const rows = rowsBySubject.get(subject) ?? [];
      return rows.length === 1 && degree(rows[0]) === 1 ? rows[0] : null;
    },
    degree,
  });
}
