import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { MetalsEvent } from '../model.js';
import { metalsLotUnitsAsOf, type MetalsLotLifecycleInput, type MetalsLotUnits } from './lifecycle.js';

/** Synthetic lots only: invented dates and quantities. */
const event = (
  kind: MetalsEvent['kind'],
  date: string | null,
  quantity: number,
  dateBasis: MetalsEvent['dateBasis'] = date === null ? null : 'stated',
): MetalsEvent => ({ kind, date, dateBasis, quantity, occurrence: 1 });
const lot = (quantity: number, events: MetalsEvent[], orderDate = '2030-01-05'): MetalsLotLifecycleInput => ({ orderDate, quantity, events });
const expected = (fields: Partial<MetalsLotUnits> & { ordered: number }): MetalsLotUnits => ({
  cancelled: 0, returned: 0, delivered: 0, awaiting: 0, shippedAwaiting: false, dateUnknown: false, assignableDateUnknown: false, ...fields,
});

/** The lot's units as of a date, which must exist, after checking ordered = cancelled + returned + delivered + awaiting. */
function unitsAsOf(input: MetalsLotLifecycleInput, asOf: string): MetalsLotUnits {
  const units = metalsLotUnitsAsOf(input, asOf);
  assert.ok(units, `the lot is ordered by ${asOf}`);
  assert.equal(units.cancelled + units.returned + units.delivered + units.awaiting, units.ordered, `the units add up as of ${asOf}`);
  for (const count of [units.cancelled, units.returned, units.delivered, units.awaiting]) assert.ok(count >= 0, `no negative count as of ${asOf}`);
  return units;
}

/** A seeded generator (mulberry32): deterministic, every bit in play, so small bounds vary too. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return (bound: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * bound);
  };
}

describe('lifecycle: a lot\'s units as of a date', () => {
  it('a lot ordered after the date is in no figure; on its order day every unit awaits delivery', () => {
    assert.equal(metalsLotUnitsAsOf(lot(2, []), '2030-01-04'), null);
    assert.deepEqual(unitsAsOf(lot(2, []), '2030-01-05'), expected({ ordered: 2, awaiting: 2 }));
  });

  it('replays shipments, cancellations, deliveries and returns by their own dates', () => {
    const replayed = lot(3, [
      event('shipped', '2030-01-07', 2),
      event('cancelled', '2030-01-08', 1),
      event('delivered', '2030-01-10', 2),
      event('returned', '2030-02-15', 1),
    ]);
    assert.deepEqual(unitsAsOf(replayed, '2030-01-06'), expected({ ordered: 3, awaiting: 3 }));
    assert.deepEqual(unitsAsOf(replayed, '2030-01-07'), expected({ ordered: 3, awaiting: 3, shippedAwaiting: true }));
    assert.deepEqual(unitsAsOf(replayed, '2030-01-08'), expected({ ordered: 3, cancelled: 1, awaiting: 2, shippedAwaiting: true }));
    assert.deepEqual(unitsAsOf(replayed, '2030-01-10'), expected({ ordered: 3, cancelled: 1, delivered: 2 }));
    assert.deepEqual(unitsAsOf(replayed, '2030-02-15'), expected({ ordered: 3, cancelled: 1, returned: 1, delivered: 1 }));
  });

  it('a return dated after a month leaves that month unchanged', () => {
    const kept = lot(2, [event('delivered', '2030-01-10', 2)]);
    const returnedLater = lot(2, [event('delivered', '2030-01-10', 2), event('returned', '2030-02-03', 1)]);
    assert.deepEqual(unitsAsOf(returnedLater, '2030-01-31'), unitsAsOf(kept, '2030-01-31'));
    assert.deepEqual(unitsAsOf(returnedLater, '2030-01-31'), expected({ ordered: 2, delivered: 2 }));
    assert.deepEqual(unitsAsOf(returnedLater, '2030-02-28'), expected({ ordered: 2, delivered: 1, returned: 1 }));
  });

  it('an undated or year-inferred fact is counted, and marks the lot partial (date-unknown)', () => {
    assert.deepEqual(unitsAsOf(lot(2, [event('delivered', null, 2)]), '2030-01-05'), expected({ ordered: 2, delivered: 2, dateUnknown: true }));
    const inferred = lot(2, [event('delivered', '2030-01-10', 2, 'year-inferred')]);
    assert.deepEqual(unitsAsOf(inferred, '2030-01-10'), expected({ ordered: 2, delivered: 2, dateUnknown: true }));
    assert.deepEqual(unitsAsOf(inferred, '2030-01-09'), expected({ ordered: 2, awaiting: 2, dateUnknown: true }));
    const undatedCancel = lot(2, [event('delivered', '2030-01-10', 1), event('cancelled', null, 1)]);
    assert.deepEqual(unitsAsOf(undatedCancel, '2030-01-06'),
      expected({ ordered: 2, cancelled: 1, awaiting: 1, dateUnknown: true, assignableDateUnknown: true }));
    assert.equal(unitsAsOf(lot(2, [event('delivered', '2030-01-10', 2)]), '2030-01-10').dateUnknown, false);
  });

  it('only an uncertain cancellation or return can change how many units a sale may be assigned', () => {
    const undatedReturn = lot(2, [event('delivered', '2030-01-10', 2), event('returned', null, 1)]);
    assert.deepEqual(unitsAsOf(undatedReturn, '2030-01-20'),
      expected({ ordered: 2, delivered: 1, returned: 1, dateUnknown: true, assignableDateUnknown: true }));
    const inferredLater = lot(2, [event('delivered', '2030-01-10', 2), event('returned', '2030-02-15', 1, 'year-inferred')]);
    assert.deepEqual(unitsAsOf(inferredLater, '2030-01-31'), expected({ ordered: 2, delivered: 2, dateUnknown: true, assignableDateUnknown: true }));
    const inferredShipment = lot(2, [event('shipped', '2030-01-08', 2, 'year-inferred'), event('delivered', '2030-01-10', 2)]);
    assert.deepEqual(unitsAsOf(inferredShipment, '2030-01-31'), expected({ ordered: 2, delivered: 2, dateUnknown: true }));
  });

  it('a warehouse sale is delivered at the register, on the receipt date', () => {
    const receipt = lot(3, [event('delivered', '2030-01-05', 3, 'in-store')]);
    assert.equal(metalsLotUnitsAsOf(receipt, '2030-01-04'), null);
    assert.deepEqual(unitsAsOf(receipt, '2030-01-05'), expected({ ordered: 3, delivered: 3 }));
  });

  it('facts that contradict each other as of a date are read conservatively and marked partial', () => {
    const earlyReturn = lot(1, [event('delivered', '2030-01-10', 1), event('returned', '2030-01-08', 1)]);
    assert.deepEqual(unitsAsOf(earlyReturn, '2030-01-09'), expected({ ordered: 1, awaiting: 1, dateUnknown: true, assignableDateUnknown: true }));
    assert.deepEqual(unitsAsOf(earlyReturn, '2030-01-10'), expected({ ordered: 1, returned: 1 }));
    const overCounted = lot(1, [event('delivered', '2030-01-10', 1), event('cancelled', '2030-01-08', 1)]);
    assert.deepEqual(unitsAsOf(overCounted, '2030-01-10'), expected({ ordered: 1, cancelled: 1, dateUnknown: true, assignableDateUnknown: true }));
  });
});

describe('lifecycle: as-of replay (property)', () => {
  it('matches a unit-by-unit replay of generated lots at every date (seeded)', () => {
    const next = seeded(11);
    const day = (offset: number) => new Date(Date.UTC(2030, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
    interface Story { shipped: number | null; delivered: number | null; returned: number | null; cancelled: number | null }
    const seen = { cancelled: 0, returned: 0, delivered: 0, shippedAwaiting: 0 };
    for (let round = 0; round < 300; round += 1) {
      const order = next(20);
      const stories: Story[] = [];
      for (let unit = 0, quantity = 1 + next(6); unit < quantity; unit += 1) {
        const fate = next(4);
        const shipped = fate >= 2 || next(2) === 0 ? order + next(5) : null;
        const delivered = fate >= 2 ? shipped! + next(5) : null;
        stories.push({
          shipped: fate === 1 ? null : shipped,
          delivered,
          returned: fate === 3 ? delivered! + 1 + next(20) : null,
          cancelled: fate === 1 ? order + next(10) : null,
        });
      }
      const grouped = new Map<string, number>();
      for (const story of stories) {
        for (const kind of ['shipped', 'delivered', 'returned', 'cancelled'] as const) {
          if (story[kind] !== null) grouped.set(`${kind}|${story[kind]}`, (grouped.get(`${kind}|${story[kind]}`) ?? 0) + 1);
        }
      }
      const events = [...grouped].map(([key, quantity]) => {
        const [kind, offset] = key.split('|');
        return event(kind as MetalsEvent['kind'], day(Number(offset)), quantity);
      });
      const input = lot(stories.length, events, day(order));
      for (let offset = order - 1; offset <= order + 40; offset += 1) {
        const asOf = day(offset);
        if (offset < order) {
          assert.equal(metalsLotUnitsAsOf(input, asOf), null);
          continue;
        }
        const by = (at: number | null) => at !== null && at <= offset;
        const deliveredBy = stories.filter((story) => by(story.delivered)).length;
        const cancelled = stories.filter((story) => by(story.cancelled)).length;
        const awaiting = stories.length - cancelled - deliveredBy;
        const reference: MetalsLotUnits = {
          ordered: stories.length,
          cancelled,
          returned: stories.filter((story) => by(story.returned)).length,
          delivered: stories.filter((story) => by(story.delivered) && !by(story.returned)).length,
          awaiting,
          shippedAwaiting: awaiting > 0 && stories.some((story) => by(story.shipped)),
          dateUnknown: false,
          assignableDateUnknown: false,
        };
        const units = unitsAsOf(input, asOf);
        assert.deepEqual(units, reference, `round ${round} as of ${asOf}`);
        seen.cancelled += units.cancelled;
        seen.returned += units.returned;
        seen.delivered += units.delivered;
        seen.shippedAwaiting += units.shippedAwaiting ? 1 : 0;
      }
      // Any one fact undated or year-inferred: still counted, the units still add up, and every figure is partial.
      if (events.length === 0) continue;
      const marked = next(events.length);
      const changes: Array<(entry: MetalsEvent) => MetalsEvent> = [
        (entry) => ({ ...entry, date: null, dateBasis: null }),
        (entry) => ({ ...entry, dateBasis: 'year-inferred' }),
      ];
      for (const change of changes) {
        const partial = lot(stories.length, events.map((entry, index) => (index === marked ? change(entry) : entry)), day(order));
        const moves = events[marked].kind === 'cancelled' || events[marked].kind === 'returned';
        for (let offset = order; offset <= order + 40; offset += 5) {
          const units = unitsAsOf(partial, day(offset));
          assert.equal(units.dateUnknown, true);
          assert.equal(units.assignableDateUnknown, moves, `round ${round}: ${events[marked].kind} as of ${day(offset)}`);
        }
      }
    }
    for (const [name, count] of Object.entries(seen)) assert.ok(count > 0, `the generated lots exercise ${name}`);
  });
});
