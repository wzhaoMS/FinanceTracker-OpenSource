import type { QuoteFreshness, QuoteSession } from './types.js';

/**
 * Classify a quote's freshness given when it was taken.
 *
 * Rules (US/Eastern):
 *   live     — taken during today's regular session (9:30 AM–4:00 PM ET)
 *              AND less than `liveWindowMs` (default 30 min) old.
 *   delayed  — taken during the most-recent regular session (open or
 *              the latest weekday close), but older than `liveWindowMs`.
 *              On a weekday before 9:30, this is "delayed (waiting for open)";
 *              after 4 PM, this is "delayed (today's close)".
 *   eod      — markets are closed (weekend, before/after hours) and the
 *              quote is from the most recent regular close.
 *   stale    — markets are OPEN right now, but the quote is from a
 *              prior session — i.e. we couldn't get fresher data.
 *
 * `now` is injectable for tests.
 */
export function classifyFreshness(
  asOfMs: number,
  now: Date = new Date(),
  liveWindowMs: number = 30 * 60 * 1000,
): QuoteFreshness {
  const session = currentMarketSession(now);
  const ageMs = now.getTime() - asOfMs;
  const sameSession = inSameSession(asOfMs, now);

  if (session.kind === 'open') {
    if (sameSession && ageMs <= liveWindowMs) return 'live';
    if (sameSession) return 'delayed';
    return 'stale';
  }
  // Markets closed. We expect the quote to be from the latest close.
  // If it predates that, label it `stale`; otherwise `eod`.
  if (asOfMs >= session.lastCloseMs) return 'eod';
  return 'stale';
}

interface MarketSessionInfo {
  /**
   * Coarse open/closed split, kept for `classifyFreshness` back-compat.
   * `'open'` means the regular session 09:30–16:00 ET. Pre/after-hours
   * report as `'closed'` here so freshness rules stay strict against the
   * *regular* session — that's what brokerages mean by "live".
   */
  kind: 'open' | 'closed';
  /**
   * Fine-grained US session at `now`. Use this for *labeling* (badge,
   * day-change cell, chart headline). Distinct from `kind` because the
   * pre-market and after-hours sessions ARE active markets even though
   * `kind === 'closed'` for freshness purposes.
   */
  session: QuoteSession;
  /** Epoch ms of the most recent regular-session close (today's, last weekday's, etc.). */
  lastCloseMs: number;
  /** Epoch ms of today's open if it has happened or will today; else 0. */
  todayOpenMs: number;
}

/**
 * Return whether US equity markets are open right now plus a few helper
 * timestamps. Holidays are NOT modeled — that's an acceptable v1 limitation
 * (a holiday quote is just labeled `stale` or `delayed`, never wrong-priced).
 *
 * The four sessions:
 *   pre-market   weekday 04:00–09:30 ET
 *   regular      weekday 09:30–16:00 ET (kind='open')
 *   after-hours  weekday 16:00–20:00 ET
 *   closed       everything else
 */
export function currentMarketSession(now: Date = new Date()): MarketSessionInfo {
  const et = etParts(now);
  // US weekday? 1 (Mon) – 5 (Fri)
  const isWeekday = et.weekday >= 1 && et.weekday <= 5;

  // Compute today's 04:00, 09:30, 16:00, 20:00 ET as epoch ms.
  const todayPreOpenMs = etTimeToEpoch(now, 4, 0);
  const todayOpenMs = etTimeToEpoch(now, 9, 30);
  const todayCloseMs = etTimeToEpoch(now, 16, 0);
  const todayAhEndMs = etTimeToEpoch(now, 20, 0);
  const t = now.getTime();

  let session: QuoteSession;
  let kind: 'open' | 'closed';
  if (!isWeekday) {
    session = 'closed';
    kind = 'closed';
  } else if (t >= todayPreOpenMs && t < todayOpenMs) {
    session = 'pre-market';
    kind = 'closed';
  } else if (t >= todayOpenMs && t < todayCloseMs) {
    session = 'regular';
    kind = 'open';
  } else if (t >= todayCloseMs && t < todayAhEndMs) {
    session = 'after-hours';
    kind = 'closed';
  } else {
    session = 'closed';
    kind = 'closed';
  }

  // lastCloseMs: today's 16:00 if we're past it on a weekday, else the
  // most recent prior weekday's 16:00.
  let lastCloseMs: number;
  if (isWeekday && t >= todayCloseMs) {
    lastCloseMs = todayCloseMs;
  } else {
    lastCloseMs = previousCloseMs(now);
  }
  return { kind, session, lastCloseMs, todayOpenMs: isWeekday ? todayOpenMs : 0 };
}

function inSameSession(asOfMs: number, now: Date): boolean {
  const session = currentMarketSession(now);
  // "Same session" means asOf is between today's open (if applicable) and now.
  return asOfMs >= session.todayOpenMs && asOfMs <= now.getTime();
}

/** Convert an arbitrary `now` to its US/Eastern Y/M/D/H/M parts via Intl. */
function etParts(now: Date): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24, // Intl returns 24 at midnight in some locales
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday] ?? 0,
  };
}

/**
 * Get the epoch ms for `hour:minute` on the same calendar date as `now`,
 * interpreted in US/Eastern. We brute-force this by formatting candidate
 * timestamps until ET parts match — avoids pulling in tz-aware libs.
 */
function etTimeToEpoch(now: Date, hour: number, minute: number): number {
  const target = etParts(now);
  // Construct a Date at the desired hour/min in UTC, then nudge until the
  // ET formatted output matches. Two candidates (UTC-4 and UTC-5) handle DST.
  const candidates = [
    Date.UTC(target.year, target.month - 1, target.day, hour + 4, minute, 0),
    Date.UTC(target.year, target.month - 1, target.day, hour + 5, minute, 0),
  ];
  for (const c of candidates) {
    const p = etParts(new Date(c));
    if (p.year === target.year && p.month === target.month && p.day === target.day && p.hour === hour && p.minute === minute) {
      return c;
    }
  }
  // Fall back to the first candidate; one-hour error is acceptable for a freshness label.
  return candidates[0];
}

/** Walk back day by day until we find a weekday, then return its 16:00 ET. */
function previousCloseMs(now: Date): number {
  for (let offset = 1; offset <= 7; offset++) {
    const d = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const p = etParts(d);
    if (p.weekday >= 1 && p.weekday <= 5) {
      return etTimeToEpoch(d, 16, 0);
    }
  }
  return now.getTime();
}
