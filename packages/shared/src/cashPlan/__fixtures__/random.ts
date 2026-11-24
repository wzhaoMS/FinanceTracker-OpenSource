import { addDays } from '../dates.js';
import { cardRow, csvPayment, dashboard, et, ofxPayment, pendingPayment, refund, statement, type History } from './history.js';

/** Random synthetic histories for the relative property test (seeded; invented cards, dates and cents only). */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomHistory(seed: number): History {
  const rand = prng(seed);
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const chance = (p: number) => rand() < p;
  const base = addDays('2026-02-01', int(0, 240));
  const cycleCount = int(1, 4);
  const cycles: Array<{ C: string; D: string }> = [];
  const observations: History['observations'] = [];
  for (let i = 0; i < cycleCount; i++) {
    const C = addDays(base, i * 30 + int(-2, 2));
    const D = addDays(C, pick([18, 22, 25, 28, 33]));
    cycles.push({ C, D });
    const start = i > 0 && chance(0.6) ? addDays(cycles[i - 1].C, chance(0.92) ? 1 : int(-3, 5)) : chance(0.15) ? addDays(C, -int(25, 35)) : undefined;
    observations.push(statement(C, {
      D,
      S: pick([0, 2500, 5000, 10000, 20000]),
      M: chance(0.9) ? pick([0, 2500, 5000, 7500]) : undefined,
      P: pick([undefined, 0, 0, 2500]),
      start: start !== undefined && start < C ? start : undefined,
    }));
  }
  const last = cycles[cycles.length - 1];
  const asOfDate = addDays(last.C, int(0, 34));
  const asOf = et(asOfDate, int(0, 23), int(0, 59));
  const span = (from: string, to: string) => addDays(from, int(0, Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000))));
  const cycleAt = (date: string) => [...cycles].reverse().find((cycle) => addDays(cycle.C, 1) <= date) ?? cycles[0];
  const rows: History['rows'] = [];
  const returned: string[] = [];
  const uncertain: string[] = [];
  const reversalDates: Record<string, string> = {};
  const from = addDays(cycles[0].C, -12);
  const payments = int(0, 7);
  for (let i = 0; i < payments; i++) {
    const id = `p${i}`;
    const minor = pick([2500, 5000, 5000]);
    const kind = rand();
    if (kind < 0.4) {
      const posted = span(from, asOfDate);
      const txn = chance(0.3) ? addDays(posted, -int(0, 4)) : posted;
      if (chance(0.3)) {
        const seen = addDays(posted, -int(0, 4));
        rows.push(cardRow({ id: `${id}-pending`, status: 'removed', removedReason: pick(['superseded', 'settled-into'] as const), removedFromStatus: 'pending',
          mergedIntoId: id, source: 'chase-api', amountMinor: -minor, transactionDate: chance(0.15) ? addDays(seen, int(1, 6)) : seen, createdAt: et(seen, int(0, 23)) }));
      }
      rows.push(ofxPayment(id, minor, posted, { txn, createdAt: et(addDays(posted, int(0, 2)), int(0, 23)) }));
      if (chance(0.1)) returned.push(id);
      else if (chance(0.1)) uncertain.push(id);
      if (chance(0.7)) reversalDates[id] = addDays(posted, int(0, 6));
    } else if (kind < 0.6) {
      const day = span(from, asOfDate);
      rows.push(csvPayment(id, minor, day, et(addDays(day, int(0, 3)), int(0, 23))));
      if (chance(0.1)) uncertain.push(id);
      if (chance(0.7)) reversalDates[id] = addDays(day, int(0, 6));
    } else if (kind < 0.85) {
      const seen = span(from, asOfDate);
      rows.push(pendingPayment(id, minor, et(seen, int(0, 23)), chance(0.2) ? { txn: addDays(seen, int(1, 9)) } : {}));
    } else {
      const seen = span(from, asOfDate);
      rows.push(cardRow({ id, status: 'removed', removedReason: pick(['cancelled', 'dismissed'] as const), removedFromStatus: 'pending', source: 'chase-api',
        amountMinor: -minor, transactionDate: seen, createdAt: et(seen, 10), removedAt: chance(0.8) ? et(addDays(seen, int(0, 6)), 15) : null }));
    }
  }
  const credits = int(0, 2);
  for (let i = 0; i < credits; i++) rows.push(refund(`r${i}`, pick([2500, 5000]), et(span(from, asOfDate), int(0, 23))));
  // Issuer reads: most name a real payment (its cents, received up to three days before it posted), read after it posted.
  const reads = int(0, 4);
  const named = rows.filter((row) => row.postedDate !== null && row.status === 'posted' && row.kind === 'payment');
  for (let i = 0; i < reads; i++) {
    const target = named.length > 0 && chance(0.6) ? pick(named) : null;
    const earliest = target ? target.postedDate! : addDays(cycles[0].C, 1);
    if (earliest > asOfDate) continue;
    const day = target ? addDays(earliest, Math.min(int(0, 6), Math.round((Date.parse(asOfDate) - Date.parse(earliest)) / 86_400_000))) : span(earliest, asOfDate);
    const at = et(day, int(0, 23), int(0, 59));
    const cycle = cycleAt(day);
    const d = target ? addDays(target.postedDate!, -int(0, 3)) : addDays(day, -int(0, 12));
    const minor = target ? -target.amountMinor : pick([2500, 5000]);
    observations.push(dashboard(at, {
      C: chance(0.8) ? cycle.C : undefined,
      D: cycle.D,
      lastPayment: target || chance(0.7) ? [d, minor] : undefined,
      P: chance(0.3) ? pick([0, 2500]) : undefined,
      R: chance(0.3) ? pick([0, 5000]) : undefined,
      phrase: chance(0.08) ? pick(['not-required', 'paid', 'past-due', 'none'] as const) : undefined,
      implicit: chance(0.25),
      asOfDate: chance(0.15) ? day : undefined,
    }));
    // Sometimes a second read at the same instant disagrees on one payment-state field (a held conflict).
    if (chance(0.12)) {
      const field = pick(['phrase', 'scheduled', 'R', 'P', 'autopay'] as const);
      observations.push(dashboard(at, {
        C: cycle.C, D: cycle.D, implicit: false,
        ...(field === 'phrase' ? { phrase: pick(['paid', 'none', 'not-required'] as const) } : {}),
        ...(field === 'scheduled' ? { scheduled: [cycle.D, pick([2500, 5000])] as [string, number] } : {}),
        ...(field === 'R' ? { R: pick([0, 5000]) } : {}),
        ...(field === 'P' ? { P: pick([0, 2500]) } : {}),
        ...(field === 'autopay' ? { autopay: pick(['on-minimum', 'off'] as const) } : {}),
      }));
    }
  }
  const coverage = chance(0.8) ? [{ start: '2025-01-01', end: '2027-12-31' }] : (() => {
    const gap = span(from, asOfDate);
    return [{ start: '2025-01-01', end: addDays(gap, -1) }, { start: addDays(gap, int(1, 4)), end: '2027-12-31' }];
  })();
  return { observations, rows, asOf, coverage, returned, uncertain, reversalDates };
}
