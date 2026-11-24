import { createOwnerClient, type CardSyncOwnerClient } from './ownerClient';
import { apiOwnerTransport } from './ownerTransport';

/**
 * The owner client the Spending tab uses: always the live one, through
 * `services/api.ts`. The fake Holdr is used only in a development build that
 * explicitly sets VITE_HOLDR_CARD_SYNC_MOCK=1, and the UI then labels every
 * screen as synthetic. A production build drops the mock branch entirely
 * (`import.meta.env.DEV` is false there), and nothing falls back to it: a
 * Holdr without the owner API shows "not set up".
 */
export async function loadOwnerClient(): Promise<CardSyncOwnerClient> {
  if (import.meta.env.DEV && import.meta.env.VITE_HOLDR_CARD_SYNC_MOCK === '1') {
    const { createDevMockClient } = await import('./devMock');
    return createDevMockClient(import.meta.env.VITE_HOLDR_CARD_SYNC_MOCK_SCENARIO);
  }
  return createOwnerClient(apiOwnerTransport, 'live');
}
