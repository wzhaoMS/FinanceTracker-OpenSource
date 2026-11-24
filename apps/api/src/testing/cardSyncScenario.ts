import type { Database as DB } from 'better-sqlite3';
import {
  buildCardSyncPayloadV2, canonicalJson, cardExternalIdHash, cardSyncObservedRange, cardSyncPayloadDigest,
  type CardSyncCoverageEntry, type CardSyncPayloadV2, type CardSyncRowDraftV2, type JsonValue,
} from '@finance-tracker/shared';

import { cardSyncActorRef, deviceFingerprint, deviceTokenDigest, newCardSyncId, pairingCodeDigest, randomCardSyncLetters }
  from '../services/cardSyncDigests.js';
import {
  SqliteStateRepo, type CardScopeDraft, type CardSourceBindingView, type CardSyncAcceptanceReceipt,
} from '../services/sqliteStateRepo.js';

/**
 * A card-sync world for repository tests: one repository on a test clock,
 * and E2's part done the way the design describes it (codes and tokens from
 * a CSPRNG, only their digests passed on; payloads built with E1a's
 * builder). Synthetic data only.
 */

export const SCENARIO_T0 = '2026-10-17T10:00:00.000Z';
export const SCENARIO_OWNER = cardSyncActorRef('local-user-owner');

export interface ScenarioDevice {
  deviceId: string;
  token: string;
  pairingId: string;
}

/** One row of a scenario payload: the bank fields and how the row is identified. */
export interface ScenarioRow {
  scope: string;
  date: string;
  posted?: string | null;
  status?: 'pending' | 'posted';
  amount: number;
  kind?: string;
  description: string;
  merchant?: string | null;
  category?: string | null;
  /** A stable issuer id (hashed into the source's first stable namespace); none makes a capture (fingerprint) row. */
  id?: string;
  /** Further stable ids, each `[namespace, raw id]`. */
  secondary?: Array<[string, string]>;
  original?: { amount: number; currency: string };
}

const STABLE_NAMESPACE: Record<string, string> = {
  'chase-api': 'chase-api:sor:v1', 'amex-api-rest': 'amex-api-rest:identifier:v1', 'citi-api': 'citi-api:transaction:v1',
};
const MODES: Record<string, string> = {
  'chase-api': 'isolated-read', 'amex-api-recent': 'main-passive', 'amex-api-rest': 'isolated-read', 'citi-api': 'main-passive',
  'wf-dom': 'dom-passive',
};

export class CardSyncScenario {
  clock = Date.parse(SCENARIO_T0);
  readonly repo: SqliteStateRepo;

  constructor(file = ':memory:') {
    this.repo = new SqliteStateRepo({ file, now: () => new Date(this.clock) });
  }

  get db(): DB {
    return this.repo.internalGetDb();
  }

  now(): string {
    return new Date(this.clock).toISOString();
  }

  tick(seconds: number): void {
    this.clock += seconds * 1000;
  }

  generation(): string {
    return this.repo.getCardSyncAuthorizationGeneration();
  }

  step() {
    return { expectedGeneration: this.generation(), nextGeneration: newCardSyncId('agn_') };
  }

  enable(issuer: 'amex' | 'chase' | 'citi' | 'wellsfargo' = 'chase'): void {
    this.repo.enableCardSyncIssuer({
      issuer, expectedVersion: this.repo.getCardSyncSettings().settingsVersion, contractVersion: 1, riskAcknowledged: true,
      mainWorldAcknowledged: issuer === 'amex' || issuer === 'citi', actorRef: SCENARIO_OWNER, ...this.step(),
    });
  }

  account(issuer = 'chase', currency = 'USD'): string {
    return this.repo.createCardAccount({ issuer, owner: 'joint', last4: '3391', currency }).id;
  }

  binding(input: { accountId?: string; source?: string; scopes?: CardScopeDraft[] } = {}): CardSourceBindingView {
    const source = input.source ?? 'chase-api';
    const issuer = source.startsWith('amex') ? 'amex' : source.startsWith('citi') ? 'citi' : source === 'wf-dom' ? 'wellsfargo' : 'chase';
    return this.repo.createCardSourceBinding({
      cardAccountId: input.accountId ?? this.account(issuer), source, label: 'Card activity', actorRef: SCENARIO_OWNER, ...this.step(),
      scopes: input.scopes ?? [{ label: 'Alex card', holderAlias: 'alex', last4: '1111' }, { label: 'Casey card', holderAlias: 'casey', last4: '2222' }],
    }).value;
  }

  /** A browser through the whole invitation: created, redeemed and approved for these bindings. */
  device(bindingIds: string[]): ScenarioDevice {
    const code = randomCardSyncLetters();
    const pairingId = this.repo.createCardSyncPairing({
      actorRef: SCENARIO_OWNER, codeDigest: pairingCodeDigest(code), bindingIds, replacesDeviceId: null, ...this.step(),
    }).value.pairingId;
    const token = `hdv1_${randomCardSyncLetters()}${randomCardSyncLetters()}`;
    const deviceId = newCardSyncId('dev_');
    const redeemed = this.repo.redeemCardSyncPairing({
      codeDigest: pairingCodeDigest(code), deviceId, tokenDigest: deviceTokenDigest(token), fingerprint: deviceFingerprint(token),
      label: 'Laptop Chrome', clientVersion: '1.2.3', ...this.step(),
    });
    if (!redeemed.ok) throw new Error('scenario redeem failed');
    this.repo.approveCardSyncPairing({ pairingId, deviceId, fingerprint: deviceFingerprint(token), actorRef: SCENARIO_OWNER, ...this.step() });
    return { deviceId, token, pairingId };
  }

  run(device: ScenarioDevice, binding: CardSourceBindingView, trigger: 'manual' | 'auto' = 'manual'): string {
    return this.repo.createCardSyncRun({
      deviceId: device.deviceId, clientRunId: `crn_${randomCardSyncLetters()}`, bindingId: binding.bindingId,
      bindingVersion: this.repo.getCardSourceBinding(binding.bindingId)!.bindingVersion, adapterVersion: 'holdr-ext@0.1.0',
      contractVersion: 1, trigger, expectedGeneration: this.generation(),
    }).runId;
  }

  /** A valid v2 payload of these rows for the binding, as E1a's builder makes it, with coverage derived from the rows. */
  payload(binding: CardSourceBindingView, rows: ScenarioRow[], options: { captureId?: string; statement?: CardSyncPayloadV2['statement'];
    observedAt?: string; cards?: string[]; owner?: CardSyncPayloadV2['owner'] } = {}): CardSyncPayloadV2 {
    const current = this.repo.getCardSourceBinding(binding.bindingId)!;
    const capture = `${current.source}:capture:v1`;
    const drafts: CardSyncRowDraftV2[] = rows.map((row) => ({
      transactionDate: row.date, postedDate: row.posted === undefined ? (row.status === 'pending' ? null : row.date) : row.posted,
      status: row.status ?? 'posted', amountMinor: row.amount, kind: (row.kind ?? 'purchase') as CardSyncRowDraftV2['kind'],
      description: row.description, merchant: row.merchant ?? null, issuerCategory: row.category ?? null,
      externalIdHash: row.id === undefined ? null : cardExternalIdHash(row.id), cardScopeId: row.scope,
      identityNamespace: (row.id === undefined ? capture : STABLE_NAMESPACE[current.source]) as CardSyncRowDraftV2['identityNamespace'],
      secondaryIds: (row.secondary ?? []).map(([namespace, raw]) => ({
        namespace: namespace as CardSyncRowDraftV2['identityNamespace'], idHash: cardExternalIdHash(raw),
      })) as CardSyncRowDraftV2['secondaryIds'],
      originalAmountMinor: row.original?.amount ?? null, originalCurrency: row.original?.currency ?? null,
    }));
    const groups = new Map<string, CardSyncRowDraftV2[]>();
    for (const draft of drafts) {
      const key = `${draft.cardScopeId}|${draft.status}`;
      groups.set(key, [...(groups.get(key) ?? []), draft]);
    }
    const coverage: CardSyncCoverageEntry[] = [...groups.entries()].map(([key, group]) => {
      const [cardScopeId, status] = key.split('|') as [string, 'pending' | 'posted'];
      return {
        cardScopeId, status, requested: null, observed: cardSyncObservedRange(group, 'transaction')!, completeness: 'partial',
        pageCount: 1, termination: 'more-available',
      };
    });
    const built = buildCardSyncPayloadV2({
      contractVersion: 1, source: current.source as CardSyncPayloadV2['source'], parserVersion: 'holdr-ext@0.1.0',
      issuer: current.issuer, currency: 'USD', owner: options.owner ?? 'joint', cards: options.cards ?? [],
      bindingId: current.bindingId, bindingVersion: current.bindingVersion,
      captureId: options.captureId ?? `cpt_${randomCardSyncLetters()}`, observedAt: options.observedAt ?? this.now(),
      mode: MODES[current.source] as CardSyncPayloadV2['mode'], coverage, rejectedCount: 0, statement: options.statement ?? null,
      rows: drafts,
    });
    if (!built.ok) throw new Error(`scenario payload refused: ${JSON.stringify(built.issues)}`);
    return built.payload;
  }

  /** A run and its upload, accepted: the receipt, the payload and the run. */
  accept(device: ScenarioDevice, binding: CardSourceBindingView, rows: ScenarioRow[],
    options: Parameters<CardSyncScenario['payload']>[2] & { trigger?: 'manual' | 'auto' } = {}):
    { receipt: CardSyncAcceptanceReceipt; payload: CardSyncPayloadV2; runId: string } {
    const runId = this.run(device, binding, options.trigger ?? 'manual');
    const payload = this.payload(binding, rows, options);
    const run = this.repo.getCardSyncRun(runId)!;
    const receipt = this.repo.acceptCardSyncObservations({
      deviceId: device.deviceId, runId, clientRunId: run.clientRunId, ...CardSyncScenario.wire(payload),
      expectedGeneration: this.generation(),
    });
    return { receipt, payload, runId };
  }

  /** Accepts rows and commits them with the owner's plan, which must need no decision; the set's id. */
  ingest(device: ScenarioDevice, binding: CardSourceBindingView, rows: ScenarioRow[]): string {
    const { receipt } = this.accept(device, binding, rows);
    const plan = this.repo.prepareCardSyncPlan({
      principal: { kind: 'session', actorRef: SCENARIO_OWNER }, setId: receipt.observationSetId, expectedVersion: 1,
      expectedGeneration: this.generation(),
    });
    if (plan.status !== 'executable') throw new Error('scenario ingest needs no review');
    this.repo.commitCardSyncPlan({
      principal: { kind: 'session', actorRef: SCENARIO_OWNER }, previewId: plan.previewId, payloadDigest: plan.payloadDigest,
      planDigest: plan.planDigest, expectedGeneration: this.generation(),
    });
    return receipt.observationSetId;
  }

  /** The binding's scope ids: its known scopes in order, then the holder-unknown scope. */
  scopes(binding: CardSourceBindingView): { known: string[]; unknown: string } {
    const current = this.repo.getCardSourceBinding(binding.bindingId)!;
    return {
      known: current.scopes.filter((s) => s.kind === 'known' && s.status === 'active').map((s) => s.cardScopeId),
      unknown: current.scopes.find((s) => s.kind === 'unknown')!.cardScopeId,
    };
  }

  /** The canonical bytes and digest E2 would pass to acceptance. */
  static wire(payload: CardSyncPayloadV2): { canonicalJson: string; payloadDigest: string } {
    return { canonicalJson: canonicalJson(payload as unknown as JsonValue), payloadDigest: cardSyncPayloadDigest(payload) };
  }

  close(): void {
    this.repo.close();
  }
}
