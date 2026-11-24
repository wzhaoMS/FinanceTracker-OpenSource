import { describe, expect, it } from 'vitest';
import { RETAIL_API_CHANNELS, RETAIL_API_QUARANTINE_REASONS } from '@finance-tracker/shared/retail-api';

import { retailSummaryView, type RetailSummaryRows } from './receipts.js';

// The summary's pure view over synthetic rows: the capture ranges' merge (overlapping or touching, by calendar day) and
// the counts' closed lists. The routes' own tests (routes/retail.test.ts) read the same view through PR 2's importer.

const A = `rtl-mbr-${'a'.repeat(32)}`;
const B = `rtl-mbr-${'b'.repeat(32)}`;
const rows = (patch: Partial<RetailSummaryRows>): RetailSummaryRows => ({
  memberships: [{ membershipRef: A, label: 'Sample Household', owner: 'alex' }], imports: [], coverage: [], receipts: [], observed: [],
  held: { keyed: 0, keyless: 0 }, ...patch,
});
const range = (channel: 'online' | 'warehouse', from: string, to: string) => ({ membershipRef: A, channel, from, to });

describe('the Costco receipts summary view', () => {
  it('merges each channel\'s ranges that overlap or touch by calendar day (months, leap days), keeps gaps, by channel then from', () => {
    const view = retailSummaryView(rows({
      imports: [{ membershipRef: A, capturedAt: '2032-03-02T00:00:00.000Z' }],
      coverage: [
        range('warehouse', '2032-03-01', '2032-03-10'),
        range('warehouse', '2032-02-01', '2032-02-28'),
        range('warehouse', '2032-02-29', '2032-02-29'),
        range('warehouse', '2032-03-05', '2032-03-07'),
        range('warehouse', '2032-03-12', '2032-03-20'),
        range('online', '2031-02-28', '2031-03-31'),
        range('online', '2031-01-01', '2031-02-27'),
        range('online', '2030-12-01', '2030-12-30'),
        { ...range('online', '2030-01-01', '2035-12-31'), membershipRef: B },
      ],
    }));
    expect(view.memberships[0].capture).toEqual({
      ranges: [
        { channel: 'online', from: '2030-12-01', to: '2030-12-30' },
        { channel: 'online', from: '2031-01-01', to: '2031-03-31' },
        { channel: 'warehouse', from: '2032-02-01', to: '2032-03-10' },
        { channel: 'warehouse', from: '2032-03-12', to: '2032-03-20' },
      ],
      capturedThrough: '2032-03-02',
    });
  });

  it('lists every channel, state and quarantine reason at zero, and no capture for a membership with no import', () => {
    const view = retailSummaryView(rows({ held: { keyed: 2, keyless: 3 } }));
    const zero = Object.fromEntries(RETAIL_API_CHANNELS.map((channel) => [channel, { active: 0, quarantined: 0 }]));
    expect(view).toEqual({
      format: 'holdr.retail-costco-summary', version: 1, state: 'present',
      memberships: [{ membershipRef: A, label: 'Sample Household', owner: 'alex', receipts: zero, capture: { ranges: [], capturedThrough: null } }],
      receipts: zero,
      quarantine: Object.fromEntries(RETAIL_API_QUARANTINE_REASONS.map((reason) => [reason, 0])),
      held: 5,
    });
  });
});
