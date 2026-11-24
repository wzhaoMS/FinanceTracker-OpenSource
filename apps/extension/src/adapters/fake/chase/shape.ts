/**
 * Fake Chase in shape mode (test build only): the page's own requests to its
 * account list and activity endpoints, observed passively for field names
 * and types. Never projects rows.
 */
import type { MainAdapter } from '../../../main/observer.js';
import { FAKE_CHASE } from '../descriptors.js';

export const FAKE_CHASE_SHAPE: MainAdapter = {
  adapterId: FAKE_CHASE.id,
  issuer: FAKE_CHASE.issuer,
  shapeContracts: FAKE_CHASE.shapeContracts,
  contracts: [
    {
      contract: 'chase.bootstrap',
      method: 'POST',
      origin: FAKE_CHASE.pageOrigin,
      path: /^\/fake-api\/accounts\/list$/,
      template: '/fake-api/accounts/list',
      queryKeys: [],
      requestBody: 'none',
      maxResponseBytes: 2 * 1024 * 1024,
    },
    {
      contract: 'chase.activity',
      method: 'GET',
      origin: FAKE_CHASE.pageOrigin,
      path: /^\/fake-api\/accounts\/[A-Za-z0-9._~-]{1,64}\/activity$/,
      template: '/fake-api/accounts/:opaque/activity',
      queryKeys: ['start', 'end', 'count', 'cursor'],
      requestBody: 'none',
      maxResponseBytes: 2 * 1024 * 1024,
    },
  ],
  project: () => null,
};
