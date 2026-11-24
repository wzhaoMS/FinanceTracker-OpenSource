import type { Database as DB, Statement } from 'better-sqlite3';

/**
 * Valid card-sync schema v15 rows for tests, written through the connection
 * the caller chooses (the repository's own, so this build's card guards check
 * every value). The shapes are the design validator's fixtures
 * (testing/cardSyncValidator.ts); ids and digests come from a seeded
 * generator in the letters-only grammar of design §2.0.3, times from a fixed
 * clock, so every run writes the same rows.
 */

const LETTERS = 'abcdefghijklmnop';
export const CARD_SYNC_FIXTURE_DAY_S = 86_400;

export type CardSyncFixtureRow = Record<string, string | number | null>;

/** An account's sync graph: who acts, a confirmed binding and the card scope it carries. */
export interface CardSyncGraph {
  usr: string;
  accountId: string;
  knownScopeId: string;
  bindingId: string;
  generation: string;
}

/** Where a fixture pairing ends after its redemption by a new device. */
export type CardSyncPairingEnd = 'redeemed' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export class CardSyncFixtures {
  private prng: number;
  private readonly inserts = new Map<string, Statement>();

  constructor(
    readonly db: DB,
    private readonly t0 = Date.parse('2026-10-17T10:00:00.000Z'),
    seed = 0x2545f491,
  ) {
    this.prng = seed >>> 0;
  }

  /** `n` letters a–p from the seeded xorshift32 generator. */
  letters(n: number): string {
    let out = '';
    for (let i = 0; i < n; i += 1) {
      this.prng ^= this.prng << 13; this.prng >>>= 0;
      this.prng ^= this.prng >>> 17;
      this.prng ^= this.prng << 5; this.prng >>>= 0;
      out += LETTERS[this.prng & 15];
    }
    return out;
  }

  /** `prefix` + 32 letters: every card-sync id. */
  id(prefix: string): string {
    return prefix + this.letters(32);
  }

  /** `prefix` + 64 letters: every card-sync digest. */
  digest(prefix: string): string {
    return prefix + this.letters(64);
  }

  /** The fixed clock, `seconds` after its start, in the schema's timestamp grammar. */
  at(seconds = 0): string {
    return new Date(this.t0 + seconds * 1000).toISOString();
  }

  insert(table: string, row: CardSyncFixtureRow): void {
    const columns = Object.keys(row);
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    let statement = this.inserts.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.inserts.set(sql, statement);
    }
    statement.run(columns.map((column) => row[column]));
  }

  /** A known card scope and a confirmed `chase-api` binding carrying it, on a `chase` USD account. */
  graph(accountId: string): CardSyncGraph {
    const usr = this.id('usr_');
    const { generation } = this.db.prepare('SELECT authorization_generation AS generation FROM card_sync_policy')
      .get() as { generation: string };
    const knownScopeId = this.id('scp_');
    this.insert('card_scopes', {
      id: knownScopeId, card_account_id: accountId, kind: 'known', holder_alias: 'alex', last4: '1234', label: 'Alex card',
      status: 'active', version: 1, confirmed_by_ref: usr, confirmed_at: this.at(), retired_at: null, created_at: this.at(),
      updated_at: this.at(),
    });
    const bindingId = this.id('bnd_');
    this.insert('card_source_bindings', {
      id: bindingId, card_account_id: accountId, issuer: 'chase', currency: 'USD', source: 'chase-api',
      source_account_digest: null, label: 'Chase activity', status: 'confirmed', status_reason: null, version: 1,
      confirmed_by_ref: usr, confirmed_at: this.at(), retired_at: null, created_at: this.at(), updated_at: this.at(),
    });
    this.insert('card_source_binding_scopes', {
      id: this.id('card-bscope-'), binding_id: bindingId, card_scope_id: knownScopeId, card_account_id: accountId,
      card_scope_kind: 'known', binding_version: 1, status: 'active', created_at: this.at(), revoked_at: null,
    });
    return { usr, accountId, knownScopeId, bindingId, generation };
  }

  /**
   * A pairing opened for the graph's binding and redeemed by a new (pending)
   * device, then taken through the lifecycle's legal steps to `end`:
   * `approved` (device active), `rejected` (device revoked, `rejected`),
   * `expired` (device expired, `pending-expired`), or `cancelled` (device
   * revoked by a password reset, its invitation closed).
   */
  pairedDevice(g: CardSyncGraph, end: CardSyncPairingEnd): { pairingId: string; deviceId: string } {
    const pairingId = this.id('pai_');
    this.insert('card_sync_pairings', {
      id: pairingId, code_digest: this.digest('hph1:'), status: 'open', replaces_device_id: null, created_by_ref: g.usr,
      created_at: this.at(), expires_at: this.at(300), failed_attempts: 0, authorization_generation: g.generation,
      redeemed_at: null, closed_at: null,
    });
    this.insert('card_sync_pairing_scopes', {
      id: this.id('card-pscope-'), pairing_id: pairingId, binding_id: g.bindingId, binding_version: 1, mode: 'isolated-read',
      contract_version: 1,
    });
    this.db.prepare("UPDATE card_sync_pairings SET status = 'redeemed', code_digest = NULL, redeemed_at = ? WHERE id = ?")
      .run(this.at(60), pairingId);
    const deviceId = this.id('dev_');
    this.insert('card_sync_devices', {
      id: deviceId, pairing_id: pairingId, token_digest: this.digest('hdh1:'), fingerprint: this.letters(16), label: 'Laptop',
      client_version: '1.0.0', owner_ref: g.usr, status: 'pending', created_at: this.at(60), pending_expires_at: this.at(600),
      activated_at: null, activated_by_ref: null, expires_at: null, closed_at: null, close_reason: null,
      authorization_generation: g.generation, last_used_at: null,
    });
    const pairing = (status: string, closedAt: string) => this.db
      .prepare('UPDATE card_sync_pairings SET status = ?, closed_at = ? WHERE id = ?').run(status, closedAt, pairingId);
    const closeDevice = (status: string, reason: string, closedAt: string) => this.db
      .prepare('UPDATE card_sync_devices SET status = ?, token_digest = NULL, closed_at = ?, close_reason = ? WHERE id = ?')
      .run(status, closedAt, reason, deviceId);
    switch (end) {
      case 'redeemed':
        break;
      case 'approved':
        pairing('approved', this.at(120));
        this.db.prepare("UPDATE card_sync_devices SET status = 'active', activated_at = ?, activated_by_ref = ?, expires_at = ? WHERE id = ?")
          .run(this.at(120), g.usr, this.at(120 + 29 * CARD_SYNC_FIXTURE_DAY_S), deviceId);
        break;
      case 'rejected':
        pairing('rejected', this.at(120));
        closeDevice('revoked', 'rejected', this.at(120));
        break;
      case 'expired':
        closeDevice('expired', 'pending-expired', this.at(660));
        pairing('expired', this.at(660));
        break;
      case 'cancelled':
        closeDevice('revoked', 'password-reset', this.at(200));
        pairing('cancelled', this.at(200));
        break;
    }
    return { pairingId, deviceId };
  }

  /** An active grant of the graph's binding to a device; with `consent`, auto-sync on with its full consent record. */
  grant(g: CardSyncGraph, deviceId: string, { consent = false }: { consent?: boolean } = {}): string {
    const id = this.id('card-dscope-');
    this.insert('card_sync_device_scopes', {
      id, device_id: deviceId, binding_id: g.bindingId, binding_version: 1, mode: 'isolated-read', contract_version: 1,
      status: 'active', granted_by_ref: g.usr, granted_at: this.at(120), revoked_at: null, auto_sync: consent ? 1 : 0,
      consent_contract_version: consent ? 1 : null, consent_guard_revision: consent ? 4 : null,
      consent_issuer_revision: consent ? 1 : null, consent_binding_version: consent ? 1 : null,
      consent_by_ref: consent ? g.usr : null, consent_at: consent ? this.at(130) : null,
    });
    return id;
  }

  /** An accepted (closed) run of a device on the graph's binding. */
  acceptedRun(g: CardSyncGraph, deviceId: string, o: CardSyncFixtureRow = {}): string {
    const id = this.id('run_');
    this.insert('card_sync_runs', {
      id, device_id: deviceId, client_run_id: this.id('crn_'), binding_id: g.bindingId, card_account_id: g.accountId,
      binding_version: 1, adapter_version: 'chase@0.1.0', contract_version: 1, run_trigger: 'manual',
      authorization_generation: g.generation, created_at: this.at(150), upload_expires_at: this.at(750),
      acceptance_state: 'accepted', payload_digest: this.digest('pd1:'), refusal_code: null, accepted_at: this.at(200),
      closed_at: this.at(200), aborted_at: null, abort_reason: null, ...o,
    });
    return id;
  }

  /** The observation set a device's accepted run delivered: `needs-review`, version 1, no rows. */
  extensionSet(g: CardSyncGraph, deviceId: string, o: CardSyncFixtureRow = {}): string {
    const id = this.id('obs_');
    this.insert('card_sync_observation_sets', {
      id, origin: 'extension', card_account_id: g.accountId, issuer: 'chase', currency: 'USD',
      run_id: this.acceptedRun(g, deviceId), device_id: deviceId, binding_id: g.bindingId, binding_version: 1,
      capture_id: this.id('cpt_'), payload_digest: this.digest('pd1:'), contract_version: 1, mode: 'isolated-read',
      observed_at: this.at(190), owner: 'joint', import_batch_id: null, file_chunk: null, source: 'chase-api',
      parser_version: 'holdr-ext-chase@0.1.0', authorization_generation: g.generation, guard_revision: 4,
      accepted_at: this.at(200), expires_at: this.at(200 + 30 * CARD_SYNC_FIXTURE_DAY_S), state: 'needs-review', version: 1,
      review_ledger_revision: 0, row_count: 0, byte_count: 100, producer_rejected_count: 0, statement_present: 0,
      receipt_state: 'kept', ...o,
    });
    return id;
  }

  /** The owner's prepared commit plan for a set (one declared insert). */
  preparedPlan(g: CardSyncGraph, setId: string): string {
    const id = this.id('prv_');
    this.insert('card_sync_commit_plans', {
      id, plan_kind: 'set', card_account_id: g.accountId, observation_set_id: setId, set_version: 1, principal_kind: 'session',
      device_id: null, actor_ref: g.usr, binding_id: g.bindingId, binding_version: 1, payload_digest: this.digest('pd1:'),
      plan_digest: this.digest('pl1:'), auto_eligible: 0, source_reviewed: 0, action_count: 1, count_insert: 1, count_update: 0,
      count_unchanged: 0, count_aliased: 0, count_matched: 0, count_attributed: 0, count_promoted: 0, count_corrected: 0,
      count_rejected: 0, count_unmatched: 0, count_superseded: 0, ledger_revision: 0, policy_revision: 1,
      issuer_policy_revision: 1, contract_version: 1, guard_revision: 4, authorization_generation: g.generation,
      created_at: this.at(400), expires_at: this.at(1000), status: 'prepared', closed_at: null, cancel_reason: null,
    });
    return id;
  }

  /** An owner's `policy-changed` audit row at `createdAt`. */
  auditEvent(g: CardSyncGraph, createdAt: string): string {
    const id = this.id('card-audit-');
    this.insert('card_sync_audit_events', {
      id, event_type: 'policy-changed', actor_kind: 'session', actor_ref: g.usr, created_at: createdAt,
    });
    return id;
  }
}
