/**
 * What the worker and the trusted UI know about an issuer adapter: pure,
 * non-secret metadata. The page code of an adapter (ISOLATED collector part,
 * MAIN observer part) lives in its own bundles and never in the worker.
 *
 * Each adapter is fixed to the one mode its source is approved for in the
 * contract (`CARD_SYNC_SOURCE_SPECS`) and never falls back to another mode
 * (plan §3.1). Changing what it reads, how, or what it sends bumps
 * `consentVersion`, which disables the issuer until the user consents again.
 */
import type { CardSyncIssuer, CardSyncMode, CardSyncReadContractId, CardSyncSource } from '@finance-tracker/shared';
import type { ShapeContractSpec } from '../contracts/shapeReport.js';

export interface AdapterScripts {
  /** ISOLATED collector bundle, registered at document_start. */
  readonly isolated: string;
  /** MAIN passive observer bundle, or null when the adapter never runs in MAIN. */
  readonly main: string | null;
  /** MAIN shape-capture bundle (field names and types only), or null when shape mode is unavailable. */
  readonly shapeMain: string | null;
}

export interface AdapterDescriptor {
  /** `[a-z][a-z0-9-]*`, unique in a build. */
  readonly id: string;
  readonly issuer: CardSyncIssuer;
  readonly label: string;
  readonly source: CardSyncSource;
  readonly mode: CardSyncMode;
  readonly parserVersion: string;
  readonly consentVersion: number;
  /** Exact page origin the collector runs on, e.g. `https://secure.chase.com`. */
  readonly pageOrigin: string;
  /** The optional host permission requested for this issuer: exactly `${pageOrigin}/*`. */
  readonly hostPermission: string;
  /** Page paths (pathname prefixes) the collector may report from. */
  readonly pagePaths: readonly string[];
  readonly discoveryContract: CardSyncReadContractId;
  readonly transactionsContract: CardSyncReadContractId;
  readonly scripts: AdapterScripts;
  /**
   * Shape capture (plan §5.1), per observed contract: its fixed method and
   * path template and the confirmed structural names (query keys, header
   * names, body and response keys) a report may name. Any other name,
   * however it is spelled, is reported as `<dynamic-key>`, since a dynamic
   * object key may itself be an account id or routing material. Applied in
   * MAIN and verified in the ISOLATED relay and in the worker.
   */
  readonly shapeContracts: Readonly<Partial<Record<CardSyncReadContractId, ShapeContractSpec>>>;
  /** Plain-text risk notes the user confirms before enabling. */
  readonly riskNotes: readonly string[];
  readonly testOnly: boolean;
}

export const ADAPTER_ID = /^[a-z][a-z0-9-]{1,31}$/;

/** Content-script registration ids are derived from the adapter id and the script role. */
export function registrationId(adapterId: string, role: 'isolated' | 'main' | 'shape-isolated' | 'shape-main'): string {
  return `holdr-${adapterId}-${role}`;
}
