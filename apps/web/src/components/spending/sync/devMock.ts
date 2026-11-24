import { createOwnerClient, type CardSyncOwnerClient } from './ownerClient';
import { FakeOwnerServer, fakeOwnerTransport, type FakeScenario } from './fakeOwnerServer';

declare global {
  interface Window {
    /** Development only (VITE_HOLDR_CARD_SYNC_MOCK=1): the fake Holdr, so a developer can play the extension's part from the console. */
    __holdrFakeOwner?: FakeOwnerServer;
  }
}

/** Development only: a fake Holdr on the wall clock with synthetic data. Loaded by ownerClientFactory only in a dev build with the flag set. */
export function createDevMockClient(scenario: string | undefined): CardSyncOwnerClient {
  const chosen: FakeScenario = scenario === 'fresh' || scenario === 'restored' ? scenario : 'demo';
  const server = new FakeOwnerServer({ scenario: chosen, wallClock: true, recentAuth: 'required' });
  window.__holdrFakeOwner = server;
  return createOwnerClient(fakeOwnerTransport(server), 'mock');
}
