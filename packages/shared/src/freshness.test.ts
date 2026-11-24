import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFreshness, currentMarketSession } from './freshness.js';

// Helper: build a Date from US/Eastern Y/M/D h:m. Caller-side EDT/EST math.
function et(year: number, month: number, day: number, hour: number, minute: number, offsetHours = -4): Date {
  // offsetHours -4 = EDT (Mar–Nov), -5 = EST. Use -4 for May 2026 which is EDT.
  return new Date(Date.UTC(year, month - 1, day, hour - offsetHours, minute, 0));
}

describe('classifyFreshness', () => {
  it('live: quote taken 5 min ago, market open', () => {
    const now = et(2026, 5, 6, 10, 30);                  // Wed 10:30 AM ET
    const asOf = now.getTime() - 5 * 60_000;
    assert.equal(classifyFreshness(asOf, now), 'live');
  });

  it('delayed: same session but >30 min old', () => {
    const now = et(2026, 5, 6, 10, 30);
    const asOf = now.getTime() - 60 * 60_000;            // 1 hour ago, still after 9:30
    assert.equal(classifyFreshness(asOf, now), 'delayed');
  });

  it('stale: market open now but quote is from yesterday', () => {
    const now = et(2026, 5, 6, 10, 30);                  // Wed open
    const asOf = et(2026, 5, 5, 16, 0).getTime();        // Tue close
    assert.equal(classifyFreshness(asOf, now), 'stale');
  });

  it('eod: quote at the most recent close, market closed (after 4 PM)', () => {
    const now = et(2026, 5, 6, 18, 0);                   // Wed 6 PM ET
    const asOf = et(2026, 5, 6, 16, 0).getTime();        // today's close
    assert.equal(classifyFreshness(asOf, now), 'eod');
  });

  it('eod: weekend with last Friday close', () => {
    const now = et(2026, 5, 9, 14, 0);                   // Sat 2 PM ET
    const asOf = et(2026, 5, 8, 16, 0).getTime();        // Fri close
    assert.equal(classifyFreshness(asOf, now), 'eod');
  });

  it('stale: weekend but quote is older than the most recent close', () => {
    const now = et(2026, 5, 9, 14, 0);                   // Sat
    const asOf = et(2026, 5, 7, 16, 0).getTime();        // Thu close (older)
    assert.equal(classifyFreshness(asOf, now), 'stale');
  });

  it('eod: pre-market on a weekday with last close from prior weekday', () => {
    const now = et(2026, 5, 6, 7, 0);                    // Wed 7 AM, before open
    const asOf = et(2026, 5, 5, 16, 0).getTime();        // Tue close
    assert.equal(classifyFreshness(asOf, now), 'eod');
  });
});

describe('currentMarketSession', () => {
  it('open during regular hours', () => {
    const now = et(2026, 5, 6, 12, 0);
    assert.equal(currentMarketSession(now).kind, 'open');
  });
  it('closed before 9:30', () => {
    const now = et(2026, 5, 6, 9, 0);
    assert.equal(currentMarketSession(now).kind, 'closed');
  });
  it('closed after 16:00', () => {
    const now = et(2026, 5, 6, 16, 30);
    assert.equal(currentMarketSession(now).kind, 'closed');
  });
  it('closed on Saturday', () => {
    const now = et(2026, 5, 9, 12, 0);
    assert.equal(currentMarketSession(now).kind, 'closed');
  });
});

describe('currentMarketSession — fine-grained session', () => {
  it('regular: 12:00 ET on a weekday', () => {
    assert.equal(currentMarketSession(et(2026, 5, 6, 12, 0)).session, 'regular');
  });
  it('regular at exactly 09:30 (start of regular)', () => {
    assert.equal(currentMarketSession(et(2026, 5, 6, 9, 30)).session, 'regular');
  });
  it('pre-market at 04:00 (start of pre-market)', () => {
    assert.equal(currentMarketSession(et(2026, 5, 6, 4, 0)).session, 'pre-market');
  });
  it('pre-market at 09:29 (one minute before regular)', () => {
    assert.equal(currentMarketSession(et(2026, 5, 6, 9, 29)).session, 'pre-market');
  });
  it('after-hours at 16:00 (start of after-hours)', () => {
    assert.equal(currentMarketSession(et(2026, 5, 6, 16, 0)).session, 'after-hours');
  });
  it('after-hours at 19:59 (one minute before end)', () => {
    assert.equal(currentMarketSession(et(2026, 5, 6, 19, 59)).session, 'after-hours');
  });
  it('closed at 20:00 (end of after-hours)', () => {
    assert.equal(currentMarketSession(et(2026, 5, 6, 20, 0)).session, 'closed');
  });
  it('closed at 03:59 (one minute before pre-market)', () => {
    assert.equal(currentMarketSession(et(2026, 5, 6, 3, 59)).session, 'closed');
  });
  it('closed all day Saturday (no extended hours on weekends)', () => {
    assert.equal(currentMarketSession(et(2026, 5, 9, 12, 0)).session, 'closed');
    assert.equal(currentMarketSession(et(2026, 5, 9, 4, 0)).session, 'closed');
    assert.equal(currentMarketSession(et(2026, 5, 9, 18, 0)).session, 'closed');
  });
  it('closed all day Sunday', () => {
    assert.equal(currentMarketSession(et(2026, 5, 10, 12, 0)).session, 'closed');
  });

  it('kind=open iff session=regular', () => {
    // Spot-check the invariant: only the regular session counts as open
    // for freshness purposes. Pre/after-hours quotes during their own
    // sessions still classify as `live`/`delayed` semantics where they
    // make sense, but the freshness classifier treats them as closed.
    assert.equal(currentMarketSession(et(2026, 5, 6, 12, 0)).kind, 'open');
    assert.equal(currentMarketSession(et(2026, 5, 6, 5, 0)).kind, 'closed');
    assert.equal(currentMarketSession(et(2026, 5, 6, 17, 0)).kind, 'closed');
  });
});
