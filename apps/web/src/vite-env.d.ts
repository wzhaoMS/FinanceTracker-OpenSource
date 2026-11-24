/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Development only: '1' serves the Spending tab's sync controls from the in-memory fake Holdr, labelled as synthetic. */
  readonly VITE_HOLDR_CARD_SYNC_MOCK?: string;
  /** Development only: the fake's scenario ('demo', 'fresh' or 'restored'). */
  readonly VITE_HOLDR_CARD_SYNC_MOCK_SCENARIO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
