/**
 * A lot's units as of a date (design v8 §4.3). Per lot, in units: ordered = cancelled + returned + delivered + awaiting
 * delivery, where delivered means delivered and kept. As of a date t only facts dated on or before t count, with
 * everything known today, so a later return never rewrites t. A fact whose date is unknown or only year-inferred is
 * counted (it is in the capture, so it happened) but makes every figure it touches partial (`date-unknown`): it is
 * never silently placed. When that fact is a cancellation or a return, it can also change which purchases a sale is
 * assigned (`assignableDateUnknown`).
 *
 * Pure: no file system, network or clock.
 */

import type { MetalsEvent } from '../model.js';

export interface MetalsLotUnits {
  ordered: number;
  cancelled: number;
  returned: number;
  /** Delivered and kept. */
  delivered: number;
  awaiting: number;
  /** Some units await delivery and a shipped event is on record ("Shipped, awaiting delivery"). */
  shippedAwaiting: boolean;
  /** An event it counts has no date or only a year-inferred one, or the events contradict each other as of t. */
  dateUnknown: boolean;
  /**
   * The part of dateUnknown that can move a unit in or out of assignment: a cancellation or return has no date or only
   * a year-inferred one, or the events contradict each other as of t, so how many units are neither cancelled nor
   * returned is uncertain. A delivery's date alone only moves units between delivered and awaiting.
   */
  assignableDateUnknown: boolean;
}

export interface MetalsLotLifecycleInput {
  orderDate: string;
  quantity: number;
  events: readonly MetalsEvent[];
}

const sum = (events: readonly MetalsEvent[]) => events.reduce((total, event) => total + event.quantity, 0);

/** The lot's units as of `asOf` (YYYY-MM-DD), or null when it was ordered after that day. */
export function metalsLotUnitsAsOf(lot: MetalsLotLifecycleInput, asOf: string): MetalsLotUnits | null {
  if (lot.orderDate > asOf) return null;
  let dateUnknown = false;
  let assignableDateUnknown = false;
  const counted = lot.events.filter((event) => {
    if (event.date === null || event.dateBasis === 'year-inferred') {
      dateUnknown = true;
      if (event.kind === 'cancelled' || event.kind === 'returned') assignableDateUnknown = true;
    }
    return event.date === null || event.date <= asOf;
  });
  const of = (kind: MetalsEvent['kind']) => sum(counted.filter((event) => event.kind === kind));
  let cancelled = of('cancelled');
  let delivered = of('delivered');
  let returned = of('returned');
  // The payload guarantees these over all events; a subset dated by t can still contradict itself (a return dated
  // before its delivery). Such a lot is read conservatively and marked partial.
  if (cancelled + delivered > lot.quantity) {
    dateUnknown = assignableDateUnknown = true;
    cancelled = Math.min(cancelled, lot.quantity);
    delivered = lot.quantity - cancelled;
  }
  if (returned > delivered) {
    dateUnknown = assignableDateUnknown = true;
    returned = delivered;
  }
  const awaiting = lot.quantity - cancelled - delivered;
  return {
    ordered: lot.quantity,
    cancelled,
    returned,
    delivered: delivered - returned,
    awaiting,
    shippedAwaiting: awaiting > 0 && of('shipped') > 0,
    dateUnknown,
    assignableDateUnknown,
  };
}
