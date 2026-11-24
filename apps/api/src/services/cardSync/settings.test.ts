import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CardSyncFixtures } from '../../testing/cardSyncFixtures.js';
import { cardSyncActorRef, newCardSyncId } from '../cardSyncDigests.js';
import { SqliteStateRepo } from '../sqliteStateRepo.js';
import { cardSyncRefusalCode } from './refusals.js';

// E1b design §5.0 (authorization changes advance the generation) and §5.1
// (settings, issuers and generation), on the repository's own connection.

const T0 = '2026-10-17T10:00:00.000Z';
const OWNER = cardSyncActorRef('local-user-owner');

let repo: SqliteStateRepo;

beforeEach(() => {
  repo = new SqliteStateRepo({ file: ':memory:', now: () => new Date(T0) });
});

afterEach(() => {
  repo.close();
});

const db = () => repo.internalGetDb();
const step = () => ({ expectedGeneration: repo.getCardSyncAuthorizationGeneration(), nextGeneration: newCardSyncId('agn_') });
const state = () => ({
  policy: db().prepare('SELECT * FROM card_sync_policy').all(),
  issuers: db().prepare('SELECT * FROM card_sync_issuer_policy ORDER BY id').all(),
  audit: db().prepare('SELECT event_type, actor_kind, actor_ref, code, authorization_generation FROM card_sync_audit_events ORDER BY rowid').all(),
  plans: db().prepare('SELECT id, status, cancel_reason FROM card_sync_commit_plans ORDER BY rowid').all(),
});
/** Refused with exactly this card-sync code, and nothing written. */
const refused = (code: string, write: () => unknown) => {
  const before = state();
  let error: unknown;
  try {
    write();
  } catch (caught) {
    error = caught;
  }
  expect(cardSyncRefusalCode(error), String(error)).toBe(code);
  expect(state()).toEqual(before);
};

describe('card sync settings (§5.1)', () => {
  it('starts running, at version 1, with every issuer off and a generation of its own', () => {
    expect(repo.getCardSyncSettings()).toMatchObject({
      paused: false, pausedAt: null, settingsVersion: 1, reviewRetentionDays: 30, receiptRetentionDays: 7,
      quotas: { maxRunsPerDeviceDay: 50, accountSets: 100, globalBytes: 52_428_800 },
      issuers: ['amex', 'chase', 'citi', 'wellsfargo'].map((issuer) => ({
        issuer, enabled: false, enabledAt: null, approvedContractVersion: null, riskAcknowledgedAt: null, mainWorldAccepted: false,
        revision: 1,
      })),
    });
    expect(repo.getCardSyncAuthorizationGeneration()).toMatch(/^agn_[a-p]{32}$/);
  });

  it('pauses: advances the generation, cancels the prepared extension plans and audits both; a repeat changes nothing', () => {
    const account = repo.createCardAccount({ issuer: 'chase', owner: 'alex', last4: '3391', currency: 'USD' }).id;
    const fx = new CardSyncFixtures(db(), Date.parse(T0));
    const g = fx.graph(account);
    const plan = fx.preparedPlan(g, fx.extensionSet(g, fx.pairedDevice(g, 'approved').deviceId));
    const pause = step();

    refused('generation-mismatch', () => repo.pauseCardSync({ actorRef: OWNER, ...pause, expectedGeneration: newCardSyncId('agn_') }));
    refused('invalid-request', () => repo.pauseCardSync({ actorRef: OWNER, ...pause, nextGeneration: pause.expectedGeneration }));
    refused('invalid-request', () => repo.pauseCardSync({ actorRef: OWNER, ...pause, nextGeneration: 'agn_1234' }));
    refused('principal-not-allowed', () => repo.pauseCardSync({ actorRef: `dev_${'a'.repeat(32)}`, ...pause }));

    const paused = repo.pauseCardSync({ actorRef: OWNER, ...pause });
    expect(paused).toMatchObject({ changed: true, authorizationGeneration: pause.nextGeneration,
      value: { paused: true, pausedAt: T0, settingsVersion: 2 } });
    expect(state().plans).toEqual([{ id: plan, status: 'cancelled', cancel_reason: 'generation-changed' }]);
    expect(state().audit.slice(-2)).toEqual([
      { event_type: 'sync-paused', actor_kind: 'session', actor_ref: OWNER, code: null, authorization_generation: null },
      { event_type: 'generation-advanced', actor_kind: 'session', actor_ref: OWNER, code: 'sync-paused',
        authorization_generation: pause.nextGeneration },
    ]);

    const again = step();
    const before = state();
    expect(repo.pauseCardSync({ actorRef: OWNER, ...again })).toMatchObject({ changed: false, authorizationGeneration: again.expectedGeneration });
    expect(state()).toEqual(before);
  });

  it('resumes at the settings version the owner saw', () => {
    repo.pauseCardSync({ actorRef: OWNER, ...step() });
    refused('version-conflict', () => repo.resumeCardSync({ expectedVersion: 1, actorRef: OWNER, ...step() }));
    const resume = step();
    expect(repo.resumeCardSync({ expectedVersion: 2, actorRef: OWNER, ...resume }))
      .toMatchObject({ changed: true, authorizationGeneration: resume.nextGeneration, value: { paused: false, settingsVersion: 3 } });
    expect(repo.resumeCardSync({ expectedVersion: 3, actorRef: OWNER, ...step() })).toMatchObject({ changed: false });
  });

  it('enables an issuer only with the risk acknowledged, a supported contract and, for Amex and Citi, MAIN-world consent', () => {
    const enable = (o: Record<string, unknown>) => repo.enableCardSyncIssuer({
      issuer: 'chase', expectedVersion: repo.getCardSyncSettings().settingsVersion, contractVersion: 1, riskAcknowledged: true,
      mainWorldAcknowledged: false, actorRef: OWNER, ...step(), ...o,
    } as never);
    refused('policy-invalid', () => enable({ issuer: 'discover' }));
    refused('policy-invalid', () => enable({ riskAcknowledged: false }));
    refused('contract-unsupported', () => enable({ contractVersion: 2 }));
    refused('main-world-required', () => enable({ issuer: 'amex' }));
    refused('version-conflict', () => enable({ expectedVersion: 7 }));

    const chase = enable({});
    expect(chase).toMatchObject({ changed: true, value: { settingsVersion: 2 } });
    expect(chase.value.issuers.find((i) => i.issuer === 'chase')).toEqual({
      issuer: 'chase', enabled: true, enabledAt: T0, approvedContractVersion: 1, riskAcknowledgedAt: T0, mainWorldAccepted: false,
      revision: 2,
    });
    expect(enable({})).toMatchObject({ changed: false, value: { settingsVersion: 2 } });
    expect(enable({ issuer: 'amex', mainWorldAcknowledged: true }).value.issuers.find((i) => i.issuer === 'amex'))
      .toMatchObject({ enabled: true, mainWorldAccepted: true, revision: 2 });
  });

  it('disables an issuer, withdrawing its consent and moving both revisions; a repeat changes nothing', () => {
    repo.enableCardSyncIssuer({ issuer: 'citi', expectedVersion: 1, contractVersion: 1, riskAcknowledged: true,
      mainWorldAcknowledged: true, actorRef: OWNER, ...step() });
    const disable = step();
    const off = repo.disableCardSyncIssuer({ issuer: 'citi', actorRef: OWNER, ...disable });
    expect(off).toMatchObject({ changed: true, authorizationGeneration: disable.nextGeneration, value: { settingsVersion: 3 } });
    expect(off.value.issuers.find((i) => i.issuer === 'citi')).toEqual({
      issuer: 'citi', enabled: false, enabledAt: null, approvedContractVersion: 1, riskAcknowledgedAt: null, mainWorldAccepted: false,
      revision: 3,
    });
    expect(repo.disableCardSyncIssuer({ issuer: 'citi', actorRef: OWNER, ...step() })).toMatchObject({ changed: false });
  });

  it('changes retention and quotas within the schema\'s ranges, at the version the owner saw, without a generation step', () => {
    const generation = repo.getCardSyncAuthorizationGeneration();
    refused('policy-invalid', () => repo.updateCardSyncRetention({ expectedVersion: 1, reviewRetentionDays: 91, actorRef: OWNER }));
    refused('policy-invalid', () => repo.updateCardSyncRetention({ expectedVersion: 1, receiptRetentionDays: 0, actorRef: OWNER }));
    refused('policy-invalid', () => repo.updateCardSyncRetention({ expectedVersion: 1, quotas: { accountSets: 1.5 }, actorRef: OWNER }));
    refused('policy-invalid', () => repo.updateCardSyncRetention({ expectedVersion: 1, quotas: { cards: 3 } as never, actorRef: OWNER }));
    refused('version-conflict', () => repo.updateCardSyncRetention({ expectedVersion: 2, reviewRetentionDays: 14, actorRef: OWNER }));
    const updated = repo.updateCardSyncRetention({
      expectedVersion: 1, reviewRetentionDays: 14, quotas: { accountSets: 50, globalRows: 1000 }, actorRef: OWNER,
    });
    expect(updated).toMatchObject({ settingsVersion: 2, reviewRetentionDays: 14, quotas: { accountSets: 50, globalRows: 1000 } });
    expect(repo.getCardSyncAuthorizationGeneration()).toBe(generation);
    expect(state().audit.at(-1)).toMatchObject({ event_type: 'policy-changed', actor_ref: OWNER });
  });
});
