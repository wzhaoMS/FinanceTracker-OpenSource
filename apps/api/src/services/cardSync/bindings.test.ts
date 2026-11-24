import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CardSyncFixtures, type CardSyncGraph } from '../../testing/cardSyncFixtures.js';
import type { CardSyncAdmission } from '../cardLedger/admissions.js';
import { cardSyncActorRef, newCardSyncId } from '../cardSyncDigests.js';
import { CardSyncStatements } from '../cardSyncStatements.js';
import { HoldrGuardRefusal } from '../dbErrors.js';
import { SqliteStateRepo, type CardScopeDraft, type CardSourceBindingView } from '../sqliteStateRepo.js';
import { setCardSyncAutoSync, UNKNOWN_SCOPE_LABEL } from './bindings.js';
import { cardSyncRefusalCode } from './refusals.js';

// E1b design §5.2 (scopes and bindings, the auto-sync switch) and §5.3.1's
// binding paths, with tests D10, D13, D14, D21–D23, D33 and D34 of §7.

const T0 = '2026-10-17T10:00:00.000Z';
const OWNER = cardSyncActorRef('local-user-owner');
const TABLES = [
  'card_scopes', 'card_source_bindings', 'card_source_binding_scopes', 'card_sync_policy', 'card_sync_issuer_policy',
  'card_sync_pairings', 'card_sync_devices', 'card_sync_device_scopes', 'card_sync_observation_sets', 'card_sync_commit_plans',
  'card_sync_audit_events',
];

let repo: SqliteStateRepo;
let clock: number;
let fx: CardSyncFixtures;

beforeEach(() => {
  clock = Date.parse(T0);
  repo = new SqliteStateRepo({ file: ':memory:', now: () => new Date(clock) });
  fx = new CardSyncFixtures(repo.internalGetDb(), Date.parse(T0));
});

afterEach(() => {
  repo.close();
});

const db = () => repo.internalGetDb();
const step = () => ({ expectedGeneration: repo.getCardSyncAuthorizationGeneration(), nextGeneration: newCardSyncId('agn_') });
const dump = () => Object.fromEntries(TABLES.map((table) => [table, db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

function attempt(write: () => unknown): unknown {
  try {
    write();
  } catch (caught) {
    return caught;
  }
  throw new Error('expected a refusal');
}

/** Refused with exactly this card-sync code, and nothing written. */
function refused(code: string, write: () => unknown): void {
  const before = dump();
  const error = attempt(write);
  expect(cardSyncRefusalCode(error), String(error)).toBe(code);
  expect(dump()).toEqual(before);
}

const account = (issuer = 'chase', currency = 'USD') =>
  repo.createCardAccount({ issuer, owner: 'joint', last4: '3391', currency }).id;
const scope = (label: string, holderAlias: CardScopeDraft['holderAlias'], last4: string | null): CardScopeDraft =>
  ({ label, holderAlias, last4 });
const create = (cardAccountId: string, scopes = [scope('Alex card', 'alex', '1111'), scope('Casey card', 'casey', '2222')],
  source = 'chase-api') => repo.createCardSourceBinding({ cardAccountId, source, label: 'Chase activity', scopes, actorRef: OWNER, ...step() });
const auditTail = (n: number) => db().prepare(`SELECT event_type, actor_kind, actor_ref, card_account_id, binding_id, device_id, code,
    version_before, version_after, item_count, authorization_generation FROM card_sync_audit_events ORDER BY rowid DESC LIMIT ?`)
  .all(n).reverse() as Array<Record<string, unknown>>;
const row = (table: string, id: string) => db().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;
const grantsOf = (deviceId: string) => db().prepare(`SELECT binding_version, mode, contract_version, status, revoked_at, auto_sync,
    consent_at, granted_by_ref FROM card_sync_device_scopes WHERE device_id = ? ORDER BY rowid`).all(deviceId);
const graphOf = (view: CardSourceBindingView): CardSyncGraph => ({
  usr: OWNER, accountId: view.cardAccountRef, knownScopeId: view.scopes[0].cardScopeId, bindingId: view.bindingId,
  generation: repo.getCardSyncAuthorizationGeneration(),
});
const enableChase = () => repo.enableCardSyncIssuer({
  issuer: 'chase', expectedVersion: repo.getCardSyncSettings().settingsVersion, contractVersion: 1, riskAcknowledged: true,
  mainWorldAcknowledged: false, actorRef: OWNER, ...step(),
});

describe('creating a binding (§5.2)', () => {
  it('creates the known scopes and the account unknown one, granted at version 1; audits and advances the generation', () => {
    const acct = account();
    const generation = step();
    const created = repo.createCardSourceBinding({
      cardAccountId: acct, source: 'chase-api', label: 'Chase activity', actorRef: OWNER, ...generation,
      scopes: [scope('Alex card', 'alex', '1111'), scope('Shared card', 'joint', null)],
    });
    expect(created.changed).toBe(true);
    expect(created.authorizationGeneration).toBe(generation.nextGeneration);
    expect(repo.getCardSyncAuthorizationGeneration()).toBe(generation.nextGeneration);
    const view = created.value;
    expect(view).toEqual({
      bindingId: expect.stringMatching(/^bnd_[a-p]{32}$/), bindingVersion: 1, issuer: 'chase', source: 'chase-api',
      bindingLabel: 'Chase activity', cardAccountRef: acct, status: 'confirmed', statusReason: null, confirmedAt: T0,
      scopes: [
        { cardScopeId: expect.stringMatching(/^scp_[a-p]{32}$/), kind: 'known', scopeLabel: 'Alex card', holderAlias: 'alex',
          last4: '1111', status: 'active' },
        { cardScopeId: expect.stringMatching(/^scp_/), kind: 'known', scopeLabel: 'Shared card', holderAlias: 'joint', last4: null,
          status: 'active' },
        { cardScopeId: expect.stringMatching(/^scp_/), kind: 'unknown', scopeLabel: UNKNOWN_SCOPE_LABEL, holderAlias: 'unknown',
          last4: null, status: 'active' },
      ],
      autoSync: { gate: 'closed', eligible: false, revision: 1, devices: [] },
      deviceIds: [],
    });
    expect(db().prepare(`SELECT card_scope_kind, binding_version, status FROM card_source_binding_scopes WHERE binding_id = ?
      ORDER BY rowid`).all(view.bindingId)).toEqual([
      { card_scope_kind: 'known', binding_version: 1, status: 'active' },
      { card_scope_kind: 'known', binding_version: 1, status: 'active' },
      { card_scope_kind: 'unknown', binding_version: 1, status: 'active' },
    ]);
    expect(row('card_scopes', view.scopes[0].cardScopeId)).toMatchObject({ confirmed_by_ref: OWNER, confirmed_at: T0, version: 1 });
    expect(auditTail(3)).toEqual([
      { event_type: 'scope-created', actor_kind: 'session', actor_ref: OWNER, card_account_id: acct, binding_id: view.bindingId,
        device_id: null, code: null, version_before: null, version_after: null, item_count: 3, authorization_generation: null },
      { event_type: 'binding-created', actor_kind: 'session', actor_ref: OWNER, card_account_id: acct, binding_id: view.bindingId,
        device_id: null, code: null, version_before: null, version_after: 1, item_count: 3, authorization_generation: null },
      { event_type: 'generation-advanced', actor_kind: 'session', actor_ref: OWNER, card_account_id: null, binding_id: null,
        device_id: null, code: 'binding-created', version_before: null, version_after: null, item_count: null,
        authorization_generation: generation.nextGeneration },
    ]);
    expect(repo.getCardSourceBinding(view.bindingId)).toEqual(view);
    expect(repo.listCardSourceBindings()).toEqual([view]);
    expect(repo.listCardSourceBindings({ cardAccountId: account() })).toEqual([]);
  });

  it('shares the account unknown scope between the bindings of one account, and lets two cards share a last four', () => {
    const acct = account('amex');
    const recent = create(acct, [scope('Basic card', 'alex', '0003'), scope('Basic card again', 'alex', '0003')], 'amex-api-recent').value;
    const rest = create(acct, [scope('Basic card', 'alex', '0003')], 'amex-api-rest').value;
    expect(rest.scopes.at(-1)!.cardScopeId).toBe(recent.scopes.at(-1)!.cardScopeId);
    expect(new Set([...recent.scopes, ...rest.scopes].map((s) => s.cardScopeId)).size).toBe(4);
    expect(auditTail(3)[0]).toMatchObject({ event_type: 'scope-created', item_count: 1 });
    expect(repo.listCardSourceBindings({ cardAccountId: acct }).map((view) => view.source)).toEqual(['amex-api-recent', 'amex-api-rest']);
  });

  it('refuses a bad creation before writing anything', () => {
    const acct = account();
    const good = { cardAccountId: acct, source: 'chase-api', label: 'Chase activity', scopes: [scope('Alex card', 'alex', '1111')],
      actorRef: OWNER };
    refused('principal-not-allowed', () => repo.createCardSourceBinding({ ...good, actorRef: `dev_${'a'.repeat(32)}`, ...step() }));
    refused('generation-mismatch', () => repo.createCardSourceBinding({ ...good, ...step(), expectedGeneration: newCardSyncId('agn_') }));
    refused('invalid-request', () => repo.createCardSourceBinding({ ...good, ...step(), nextGeneration: 'agn_x' }));
    refused('invalid-request', () => repo.createCardSourceBinding({ ...good, source: 'chase-web', ...step() }));
    for (const label of ['', ' Chase', 'Chase  activity', 'Chase\u0007', 'x'.repeat(65)]) {
      refused('invalid-request', () => repo.createCardSourceBinding({ ...good, label, ...step() }));
    }
    const bad: unknown[][] = [
      [], Array.from({ length: 40 }, (_, i) => scope(`Card ${String.fromCharCode(97 + (i % 26))}`, 'alex', null)),
      [scope('Alex card', 'unknown' as 'alex', null)], [scope('Alex card', 'alex', '12a4')], [scope('Alex card', 'alex', '12345')],
      [{ ...scope('Alex card', 'alex', '1111'), cardScopeId: null }], [scope(' Alex', 'alex', null)], ['Alex card'], [null],
    ];
    for (const scopes of bad) {
      refused('scope-invalid', () => repo.createCardSourceBinding({ ...good, scopes: scopes as CardScopeDraft[], ...step() }));
    }
    refused('not-found', () => repo.createCardSourceBinding({ ...good, cardAccountId: 'card-acct-nope', ...step() }));
    refused('card-account-mismatch', () => repo.createCardSourceBinding({ ...good, source: 'citi-api', ...step() }));
    const euro = account('chase', 'EUR');
    refused('card-account-mismatch', () => repo.createCardSourceBinding({ ...good, cardAccountId: euro, ...step() }));
    // Card data in a label stays the guards' refusal (§5.0), with nothing written.
    const before = dump();
    expect(attempt(() => repo.createCardSourceBinding({ ...good, label: 'Card 4111 1111 1111 1111', ...step() })))
      .toBeInstanceOf(HoldrGuardRefusal);
    expect(attempt(() => repo.createCardSourceBinding({ ...good, scopes: [scope('4111111111111111', 'alex', null)], ...step() })))
      .toBeInstanceOf(HoldrGuardRefusal);
    expect(dump()).toEqual(before);
  });

  it('allows one live binding per account and source; after retiring it, a new one works (D14)', () => {
    const acct = account();
    const first = create(acct).value;
    refused('binding-exists', () => create(acct));
    repo.retireCardSourceBinding({ bindingId: first.bindingId, expectedVersion: 1, actorRef: OWNER, ...step() });
    const second = create(acct).value;
    expect(second.bindingId).not.toBe(first.bindingId);
    expect(repo.listCardSourceBindings({ cardAccountId: acct }).map((view) => [view.status, view.bindingVersion]))
      .toEqual([['retired', 2], ['confirmed', 1]]);
  });
});

describe('confirming a binding again (§5.2, §5.3.1; D10, D14, D22, D23)', () => {
  it('keeps, renames, adds and retires scopes; leaves devices stale unless re-granted; blocks older sets', () => {
    enableChase();
    const acct = account();
    const before = create(acct).value;
    const [alex, casey, unknown] = before.scopes;
    const g = graphOf(before);
    const consenting = fx.pairedDevice(g, 'approved').deviceId;
    fx.grant(g, consenting, { consent: true });
    const regranted = fx.pairedDevice(g, 'approved').deviceId;
    fx.grant(g, regranted);
    const set = fx.extensionSet(g, consenting);
    const plan = fx.preparedPlan(g, set);
    const generation = step();

    const confirmed = repo.confirmCardSourceBinding({
      bindingId: before.bindingId, expectedVersion: 1, label: 'Chase cards', actorRef: OWNER, ...generation,
      scopes: [{ cardScopeId: alex.cardScopeId, label: 'Alex main card', holderAlias: 'joint', last4: '1111' },
        { cardScopeId: null, label: 'New card', holderAlias: 'member-a', last4: null }],
      regrantDeviceIds: [regranted],
    });
    expect(confirmed).toMatchObject({ changed: true, authorizationGeneration: generation.nextGeneration });
    const view = confirmed.value;
    expect(view).toMatchObject({
      bindingVersion: 2, bindingLabel: 'Chase cards', status: 'confirmed', statusReason: null, confirmedAt: T0,
      autoSync: { revision: 2, eligible: false, devices: [{ deviceId: regranted, enabled: false, consentedAt: null }] },
    });
    expect(view.scopes.map((s) => [s.cardScopeId === alex.cardScopeId, s.scopeLabel, s.holderAlias, s.last4, s.kind])).toEqual([
      [true, 'Alex main card', 'joint', '1111', 'known'], [false, 'New card', 'member-a', null, 'known'],
      [false, UNKNOWN_SCOPE_LABEL, 'unknown', null, 'unknown'],
    ]);
    expect(view.scopes[2].cardScopeId).toBe(unknown.cardScopeId);
    expect(new Set(view.deviceIds)).toEqual(new Set([consenting, regranted]));
    // A scope left out is retired, its id kept for the rows that point at it.
    expect(row('card_scopes', casey.cardScopeId)).toMatchObject({ status: 'retired', retired_at: T0, version: 2 });
    expect(row('card_scopes', alex.cardScopeId)).toMatchObject({ status: 'active', label: 'Alex main card', version: 2, last4: '1111' });
    expect(db().prepare(`SELECT binding_version, status, count(*) AS n FROM card_source_binding_scopes WHERE binding_id = ?
      GROUP BY binding_version, status ORDER BY binding_version`).all(before.bindingId))
      .toEqual([{ binding_version: 1, status: 'revoked', n: 3 }, { binding_version: 2, status: 'active', n: 3 }]);
    // Consent withdrawn; the device not re-granted keeps its old grant, now stale; the re-granted one has a fresh grant.
    expect(grantsOf(consenting)).toEqual([{ binding_version: 1, mode: 'isolated-read', contract_version: 1, status: 'active',
      revoked_at: null, auto_sync: 0, consent_at: null, granted_by_ref: OWNER }]);
    expect(grantsOf(regranted)).toEqual([
      { binding_version: 1, mode: 'isolated-read', contract_version: 1, status: 'revoked', revoked_at: T0, auto_sync: 0,
        consent_at: null, granted_by_ref: OWNER },
      { binding_version: 2, mode: 'isolated-read', contract_version: 1, status: 'active', revoked_at: null, auto_sync: 0,
        consent_at: null, granted_by_ref: OWNER },
    ]);
    // The open set accepted under version 1 is blocked; its receipt stays kept (D34); the generation advance cancelled its plan.
    expect(row('card_sync_observation_sets', set)).toMatchObject({ state: 'blocked-review', version: 2, receipt_state: 'kept' });
    expect(row('card_sync_commit_plans', plan)).toMatchObject({ status: 'cancelled', cancel_reason: 'generation-changed' });
    expect(auditTail(6).map((a) => [a.event_type, a.device_id, a.item_count, a.version_before, a.version_after, a.code])).toEqual([
      ['device-regranted', regranted, null, null, 2, null],
      ['scope-created', null, 1, null, null, null],
      ['scope-changed', null, 1, null, null, null],
      ['scope-retired', null, 1, null, null, null],
      ['binding-confirmed', null, 3, 1, 2, null],
      ['generation-advanced', null, null, null, null, 'binding-confirmed'],
    ]);
  });

  it('confirms a binding that needs reconfirmation, and a confirmation that changes no scope still moves both counters', () => {
    const view = create(account()).value;
    db().prepare(`UPDATE card_source_bindings SET status = 'needs-reconfirmation', status_reason = 'restored-from-backup',
      version = 2 WHERE id = ?`).run(view.bindingId);
    const scopes = view.scopes.filter((s) => s.kind === 'known')
      .map((s) => ({ cardScopeId: s.cardScopeId, label: s.scopeLabel, holderAlias: s.holderAlias as 'alex', last4: s.last4 }));
    const confirmed = repo.confirmCardSourceBinding({
      bindingId: view.bindingId, expectedVersion: 2, label: view.bindingLabel, scopes, regrantDeviceIds: [], actorRef: OWNER, ...step(),
    }).value;
    expect(confirmed).toMatchObject({ bindingVersion: 3, status: 'confirmed', statusReason: null, autoSync: { revision: 2 } });
    expect(confirmed.scopes.map((s) => s.cardScopeId)).toEqual(view.scopes.map((s) => s.cardScopeId));
    expect(auditTail(2).map((a) => a.event_type)).toEqual(['binding-confirmed', 'generation-advanced']);
    // With every known card left out, only the unknown scope stays granted.
    const bare = repo.confirmCardSourceBinding({
      bindingId: view.bindingId, expectedVersion: 3, label: view.bindingLabel, scopes: [], regrantDeviceIds: [], actorRef: OWNER, ...step(),
    }).value;
    expect(bare.scopes.map((s) => s.kind)).toEqual(['unknown']);
  });

  it('refuses a bad confirmation before writing anything', () => {
    const view = create(account()).value;
    const other = create(account()).value;
    const [alex, , unknown] = view.scopes;
    const g = graphOf(view);
    const pending = fx.pairedDevice(g, 'redeemed').deviceId;
    const ungranted = fx.pairedDevice(g, 'approved').deviceId;
    const granted = fx.pairedDevice(g, 'approved').deviceId;
    fx.grant(g, granted);
    const keep = { cardScopeId: alex.cardScopeId, label: 'Alex card', holderAlias: 'alex' as const, last4: '1111' };
    const good = { bindingId: view.bindingId, expectedVersion: 1, label: 'Chase activity', scopes: [keep], regrantDeviceIds: [granted],
      actorRef: OWNER };
    // A re-grant records the issuer's approved contract; with none ever approved there is nothing to grant.
    refused('contract-unsupported', () => repo.confirmCardSourceBinding({ ...good, ...step() }));
    enableChase();
    refused('not-found', () => repo.confirmCardSourceBinding({ ...good, bindingId: newCardSyncId('bnd_'), ...step() }));
    refused('not-found', () => repo.confirmCardSourceBinding({ ...good, bindingId: 'bnd_1', ...step() }));
    refused('principal-not-allowed', () => repo.confirmCardSourceBinding({ ...good, actorRef: 'usr_x', ...step() }));
    refused('generation-mismatch', () => repo.confirmCardSourceBinding({ ...good, ...step(), expectedGeneration: newCardSyncId('agn_') }));
    refused('version-conflict', () => repo.confirmCardSourceBinding({ ...good, expectedVersion: 2, ...step() }));
    refused('invalid-request', () => repo.confirmCardSourceBinding({ ...good, label: 'Chase ', ...step() }));
    for (const regrantDeviceIds of [[granted, granted], ['dev_1'], Array.from({ length: 51 }, () => newCardSyncId('dev_'))]) {
      refused('invalid-request', () => repo.confirmCardSourceBinding({ ...good, regrantDeviceIds, ...step() }));
    }
    refused('scope-immutable', () => repo.confirmCardSourceBinding({ ...good, scopes: [{ ...keep, last4: '9999' }], ...step() }));
    refused('scope-immutable', () => repo.confirmCardSourceBinding({ ...good, scopes: [{ ...keep, last4: null }], ...step() }));
    for (const cardScopeId of [unknown.cardScopeId, other.scopes[0].cardScopeId, newCardSyncId('scp_')]) {
      refused('scope-invalid', () => repo.confirmCardSourceBinding({ ...good, scopes: [{ ...keep, cardScopeId }], ...step() }));
    }
    refused('scope-invalid', () => repo.confirmCardSourceBinding({ ...good, scopes: [keep, keep], ...step() }));
    refused('scope-invalid', () => repo.confirmCardSourceBinding({ ...good, scopes: [{ ...keep, cardScopeId: 'scp_1' }], ...step() }));
    // A listed device must be active, unexpired and hold a grant of the binding.
    for (const deviceId of [pending, ungranted, newCardSyncId('dev_')]) {
      refused('not-found', () => repo.confirmCardSourceBinding({ ...good, regrantDeviceIds: [deviceId], ...step() }));
    }
    clock = Date.parse(T0) + 30 * 86_400_000;
    refused('not-found', () => repo.confirmCardSourceBinding({ ...good, ...step() }));
    clock = Date.parse(T0);
    repo.retireCardSourceBinding({ bindingId: view.bindingId, expectedVersion: 1, actorRef: OWNER, ...step() });
    refused('binding-retired', () => repo.confirmCardSourceBinding({ ...good, expectedVersion: 2, regrantDeviceIds: [], ...step() }));
  });
});

describe('retiring a binding (§5.2, §5.3.1; D23, D34)', () => {
  it('revokes every grant with its consent, blocks the open sets and cancels their plans; terminal and idempotent', () => {
    const acct = account();
    const view = create(acct).value;
    const g = graphOf(view);
    const device = fx.pairedDevice(g, 'approved').deviceId;
    fx.grant(g, device, { consent: true });
    const set = fx.extensionSet(g, device);
    const plan = fx.preparedPlan(g, set);
    refused('version-conflict', () => repo.retireCardSourceBinding({ bindingId: view.bindingId, expectedVersion: 2, actorRef: OWNER, ...step() }));
    refused('invalid-request', () => repo.retireCardSourceBinding({ bindingId: view.bindingId, expectedVersion: '1' as unknown as number,
      actorRef: OWNER, ...step() }));

    const generation = step();
    const retired = repo.retireCardSourceBinding({ bindingId: view.bindingId, expectedVersion: 1, actorRef: OWNER, ...generation });
    expect(retired).toMatchObject({ changed: true, authorizationGeneration: generation.nextGeneration,
      value: { status: 'retired', bindingVersion: 2, autoSync: { revision: 2, devices: [] }, deviceIds: [] } });
    expect(retired.value.scopes).toEqual(view.scopes);
    expect(row('card_source_bindings', view.bindingId)).toMatchObject({ retired_at: T0, status_reason: null });
    expect(grantsOf(device)).toEqual([{ binding_version: 1, mode: 'isolated-read', contract_version: 1, status: 'revoked',
      revoked_at: T0, auto_sync: 0, consent_at: null, granted_by_ref: OWNER }]);
    expect(row('card_sync_observation_sets', set)).toMatchObject({ state: 'blocked-review', version: 2, receipt_state: 'kept' });
    expect(row('card_sync_commit_plans', plan)).toMatchObject({ status: 'cancelled', cancel_reason: 'binding-changed', closed_at: T0 });
    expect(auditTail(2).map((a) => [a.event_type, a.item_count, a.version_before, a.version_after, a.code])).toEqual([
      ['binding-retired', 1, 1, 2, null], ['generation-advanced', null, null, null, 'binding-retired'],
    ]);

    // A repeat changes nothing and does not advance, but still checks the generation (§5.0).
    refused('generation-mismatch', () => repo.retireCardSourceBinding({ bindingId: view.bindingId, expectedVersion: 2, actorRef: OWNER,
      ...step(), expectedGeneration: newCardSyncId('agn_') }));
    const before = dump();
    const again = repo.retireCardSourceBinding({ bindingId: view.bindingId, expectedVersion: 7, actorRef: OWNER, ...step() });
    expect(again).toMatchObject({ changed: false, authorizationGeneration: generation.nextGeneration });
    expect(dump()).toEqual(before);
    // A binding waiting for reconfirmation retires too (narrowing works on any live binding), its reason cleared.
    const waiting = create(account()).value;
    db().prepare(`UPDATE card_source_bindings SET status = 'needs-reconfirmation', status_reason = 'restored-from-backup',
      version = 2 WHERE id = ?`).run(waiting.bindingId);
    expect(repo.retireCardSourceBinding({ bindingId: waiting.bindingId, expectedVersion: 2, actorRef: OWNER, ...step() }).value)
      .toMatchObject({ status: 'retired', statusReason: null, bindingVersion: 3 });
    // Retired is terminal, in the database too.
    expect(() => db().prepare("UPDATE card_source_bindings SET label = 'x', version = version + 1 WHERE id = ?").run(view.bindingId))
      .toThrow(/retired binding never changes/);
  });
});

describe('the auto-sync switch (§5.2; D13, D21, D22, D33)', () => {
  const off = (bindingId: string, generation = step()) =>
    repo.setCardSyncAutoSync({ bindingId, enabled: false, actorRef: OWNER, ...generation });
  const on = (bindingId: string, expectedVersion: number, expectedAutoSyncRevision: number) =>
    repo.setCardSyncAutoSync({ bindingId, enabled: true, expectedVersion, expectedAutoSyncRevision, actorRef: OWNER, ...step() });
  /** A manual run of the binding at version 1 went accepted → plan → commit: what makes it eligible. */
  const commitManualRun = (g: CardSyncGraph, deviceId: string) => {
    const setId = fx.extensionSet(g, deviceId);
    const planId = fx.preparedPlan(g, setId);
    db().prepare("UPDATE card_sync_commit_plans SET status = 'consumed', closed_at = ? WHERE id = ?").run(T0, planId);
    db().prepare(`UPDATE card_sync_observation_sets SET state = 'committed', version = 2, closed_at = ?, close_reason = 'committed',
      closed_by_ref = ? WHERE id = ?`).run(T0, OWNER, setId);
  };

  it('moves the revision on every off, even with no consent to withdraw; then it is no authorization change (D33)', () => {
    const view = create(account()).value;
    const g = graphOf(view);
    const device = fx.pairedDevice(g, 'approved').deviceId;
    fx.grant(g, device);
    const plan = fx.preparedPlan(g, fx.extensionSet(g, device));
    const generation = repo.getCardSyncAuthorizationGeneration();

    const first = off(view.bindingId);
    expect(first).toMatchObject({ changed: false, authorizationGeneration: generation, value: { autoSync: { revision: 2 } } });
    expect(row('card_sync_commit_plans', plan)).toMatchObject({ status: 'prepared' });
    expect(auditTail(1)).toEqual([{ event_type: 'auto-sync-changed', actor_kind: 'session', actor_ref: OWNER,
      card_account_id: view.cardAccountRef, binding_id: view.bindingId, device_id: null, code: 'disabled', version_before: 1,
      version_after: 2, item_count: 0, authorization_generation: null }]);
    expect(off(view.bindingId).value.autoSync.revision).toBe(3);
    expect(row('card_source_bindings', view.bindingId)).toMatchObject({ version: 1, auto_sync_revision: 3 });
    expect(repo.getCardSyncAuthorizationGeneration()).toBe(generation);
    refused('generation-mismatch', () => off(view.bindingId, { ...step(), expectedGeneration: newCardSyncId('agn_') }));
  });

  it('withdraws every consent on off, advancing the generation and cancelling the extension plans (D23)', () => {
    const view = create(account()).value;
    const g = graphOf(view);
    const device = fx.pairedDevice(g, 'approved').deviceId;
    fx.grant(g, device, { consent: true });
    const plan = fx.preparedPlan(g, fx.extensionSet(g, device));
    const generation = step();
    const result = off(view.bindingId, generation);
    expect(result).toMatchObject({ changed: true, authorizationGeneration: generation.nextGeneration,
      value: { autoSync: { revision: 2, devices: [{ deviceId: device, enabled: false, consentedAt: null }] } } });
    expect(grantsOf(device)).toMatchObject([{ status: 'active', auto_sync: 0, consent_at: null }]);
    expect(row('card_sync_commit_plans', plan)).toMatchObject({ status: 'cancelled', cancel_reason: 'generation-changed' });
    expect(auditTail(2).map((a) => [a.event_type, a.item_count, a.code])).toEqual([
      ['auto-sync-changed', 1, 'disabled'], ['generation-advanced', null, 'auto-sync-changed'],
    ]);
  });

  it('changes nothing on a retired binding', () => {
    const view = create(account()).value;
    repo.retireCardSourceBinding({ bindingId: view.bindingId, expectedVersion: 1, actorRef: OWNER, ...step() });
    const before = dump();
    expect(off(view.bindingId)).toMatchObject({ changed: false, value: { autoSync: { revision: 2 } } });
    expect(dump()).toEqual(before);
    refused('binding-retired', () => on(view.bindingId, 2, 2));
  });

  it('refuses an on read before another window off, before eligibility, and while every gate is closed (D13, D21)', () => {
    const view = create(account()).value;
    const g = graphOf(view);
    const device = fx.pairedDevice(g, 'approved').deviceId;
    fx.grant(g, device);
    refused('auto-sync-not-eligible', () => on(view.bindingId, 1, 1));
    off(view.bindingId);
    refused('version-conflict', () => on(view.bindingId, 1, 1));
    refused('version-conflict', () => on(view.bindingId, 2, 2));
    refused('auto-sync-not-eligible', () => on(view.bindingId, 1, 2));
    commitManualRun(g, device);
    expect(repo.getCardSourceBinding(view.bindingId)!.autoSync).toMatchObject({ eligible: true, gate: 'closed' });
    refused('gate-closed', () => on(view.bindingId, 1, 2));
    refused('invalid-request', () => repo.setCardSyncAutoSync({ bindingId: view.bindingId, enabled: 'yes' as unknown as false,
      actorRef: OWNER, ...step() }));
    refused('invalid-request', () => on(view.bindingId, 1, Number.NaN));
    refused('not-found', () => on(newCardSyncId('bnd_'), 1, 2));
    db().prepare(`UPDATE card_source_bindings SET status = 'needs-reconfirmation', status_reason = 'contract-changed', version = 2
      WHERE id = ?`).run(view.bindingId);
    refused('binding-needs-reconfirmation', () => on(view.bindingId, 2, 2));
  });

  it('with a test admission, snapshots consent on every current grant only; stale grants stay without (D13, D7)', () => {
    enableChase();
    const view = create(account()).value;
    const g = graphOf(view);
    const current = fx.pairedDevice(g, 'approved').deviceId;
    fx.grant(g, current);
    const stale = fx.pairedDevice(g, 'approved').deviceId;
    fx.grant(g, stale);
    // Version 2 re-grants `current` only, then a manual run at version 2 commits.
    const confirmed = repo.confirmCardSourceBinding({
      bindingId: view.bindingId, expectedVersion: 1, label: view.bindingLabel, actorRef: OWNER, ...step(),
      scopes: [{ cardScopeId: view.scopes[0].cardScopeId, label: 'Alex card', holderAlias: 'alex', last4: '1111' }],
      regrantDeviceIds: [current],
    }).value;
    const run = fx.acceptedRun(g, current, { binding_version: 2 });
    const setId = fx.extensionSet(g, current, { binding_version: 2, run_id: run });
    const planId = fx.preparedPlan(g, setId);
    db().prepare("UPDATE card_sync_commit_plans SET status = 'consumed', closed_at = ? WHERE id = ?").run(T0, planId);
    db().prepare(`UPDATE card_sync_observation_sets SET state = 'committed', version = 2, closed_at = ?, close_reason = 'committed',
      closed_by_ref = ? WHERE id = ?`).run(T0, OWNER, setId);

    const admitted: Record<string, CardSyncAdmission> = { 'chase-api:sor:v1': { autoInsert: true, lifecycle: false } as unknown as CardSyncAdmission };
    const generation = step();
    const changed = db().transaction(() => setCardSyncAutoSync({
      db: db(), now: T0, statements: new CardSyncStatements(db()), guardRevision: 4,
    }, { bindingId: view.bindingId, enabled: true, expectedVersion: 2, expectedAutoSyncRevision: confirmed.autoSync.revision,
      actorRef: OWNER, ...generation }, admitted)).immediate();
    expect(changed).toMatchObject({ changed: true, authorizationGeneration: generation.nextGeneration,
      value: { autoSync: { gate: 'open', eligible: true, revision: confirmed.autoSync.revision + 1,
        devices: [{ deviceId: current, enabled: true, consentedAt: T0 }] } } });
    const issuerRevision = repo.getCardSyncSettings().issuers.find((issuer) => issuer.issuer === 'chase')!.revision;
    expect(db().prepare(`SELECT binding_version, auto_sync, consent_contract_version, consent_guard_revision, consent_issuer_revision,
        consent_binding_version, consent_by_ref, consent_at FROM card_sync_device_scopes WHERE device_id = ? AND status = 'active'`)
      .get(current)).toEqual({ binding_version: 2, auto_sync: 1, consent_contract_version: 1, consent_guard_revision: 4,
      consent_issuer_revision: issuerRevision, consent_binding_version: 2, consent_by_ref: OWNER, consent_at: T0 });
    expect(grantsOf(stale)).toMatchObject([{ binding_version: 1, status: 'active', auto_sync: 0, consent_at: null }]);
    expect(auditTail(2).map((a) => [a.event_type, a.item_count, a.code])).toEqual([
      ['auto-sync-changed', 1, 'enabled'], ['generation-advanced', null, 'auto-sync-changed'],
    ]);
    // Through the repository the gate stays closed: CARD_SYNC_ADMISSIONS admits nothing in E1b.
    refused('gate-closed', () => on(view.bindingId, 2, confirmed.autoSync.revision + 1));
  });

  it('a confirmation with re-grants moves the revision, so an on read before it never applies (D22)', () => {
    enableChase();
    const view = create(account()).value;
    const g = graphOf(view);
    const device = fx.pairedDevice(g, 'approved').deviceId;
    fx.grant(g, device);
    commitManualRun(g, device);
    refused('gate-closed', () => on(view.bindingId, 1, 1));
    const confirmed = repo.confirmCardSourceBinding({
      bindingId: view.bindingId, expectedVersion: 1, label: view.bindingLabel, actorRef: OWNER, ...step(),
      scopes: [{ cardScopeId: view.scopes[0].cardScopeId, label: 'Alex card', holderAlias: 'alex', last4: '1111' }],
      regrantDeviceIds: [device],
    }).value;
    expect(confirmed.autoSync).toMatchObject({ revision: 2, eligible: false });
    refused('version-conflict', () => on(view.bindingId, 1, 1));
    refused('version-conflict', () => on(view.bindingId, 2, 1));
    refused('auto-sync-not-eligible', () => on(view.bindingId, 2, 2));
  });
});
