/**
 * What the worker tells its own popup and options page. It never contains
 * the device credential. It does not carry the frozen payload text either:
 * the popup reads those exact bytes straight from trusted session storage.
 */
import type { CardSyncIssue, CardSyncMode } from '@finance-tracker/shared';
import type { Binding, PlanCounts } from './holdrApi.js';
import type { AccountSummary, CollectorCode, CollectorState, PageState, ScopeEntry, UiErrorCode } from './messages.js';
import type { ShapeReport } from './shapeReport.js';

export interface IssuerView {
  adapterId: string;
  issuer: string;
  label: string;
  mode: CardSyncMode;
  hostPermission: string;
  riskNotes: string[];
  enabled: boolean;
  permission: boolean;
  consentCurrent: boolean;
  mainPassiveAccepted: boolean;
  active: boolean;
  shapeAvailable: boolean;
  rateLimitedUntil: number | null;
  /** This adapter version's contract paused after the site changed what it sends; it stays off until an update. */
  shapeChanged: boolean;
}

export interface CollectorView {
  docRef: string;
  adapterId: string;
  label: string;
  mode: CardSyncMode;
  tabId: number;
  pageState: PageState;
  state: CollectorState;
  code: CollectorCode | null;
  issues: CardSyncIssue[];
  accounts: AccountSummary[];
}

export interface CaptureView {
  captureId: string;
  clientRunId: string;
  adapterId: string;
  label: string;
  docRef: string;
  accountRef: string;
  bindingId: string;
  bindingLabel: string;
  scopes: ScopeEntry[];
  stage: string;
  createdAt: number;
  expiresAt: number | null;
  digest: string | null;
  byteLength: number | null;
  rows: number;
  pending: number;
  posted: number;
  runId: string | null;
  observationSetId: string | null;
  acceptance: string | null;
  acceptedAt: string | null;
  acceptExpiresAt: string | null;
  previewId: string | null;
  planDigest: string | null;
  plan: { counts: PlanCounts; expiresAt: string } | null;
  ownerReview: { reviewCount: number; counts: PlanCounts } | null;
  committing: boolean;
  commitUncertain: boolean;
  committedAt: string | null;
  error: UiErrorCode | null;
  holdrError: string | null;
  issues: CardSyncIssue[];
}

export interface UiState {
  target: 'production' | 'test' | 'acceptance';
  holdrOrigin: string;
  version: string;
  paused: boolean;
  storage: { session: boolean; local: boolean };
  device: {
    status: 'unpaired' | 'pending' | 'active' | 'revoked' | 'expired' | 'outdated';
    deviceLabel: string | null;
    fingerprint: string | null;
    deviceExpiresAt: string | null;
    persisted: boolean;
  };
  trustBrowser: boolean;
  syncEnabled: boolean | null;
  bindings: Binding[];
  issuers: IssuerView[];
  collectors: CollectorView[];
  unreachableCollectors: number;
  capture: CaptureView | null;
  shape: { adapterId: string; label: string; expiresAt: number; reports: ShapeReport[] } | null;
  lastRuns: Array<{ captureId: string; adapterId: string; bindingLabel: string; rows: number; digest: string; observationSetId: string; status: string; at: string }>;
}

export type UiReply = { ok: true; state: UiState } | { ok: false; code: UiErrorCode; state: UiState | null };
