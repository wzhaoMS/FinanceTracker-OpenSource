import type Database from 'better-sqlite3';

import { digest } from '../amazon/policy.js';
import { toValueFreeDbError } from '../dbErrors.js';
import { RetailRefusal } from './common.js';
import { RETAIL_SCHEMA_DIGEST, requireRetailSchema } from './schema.js';
import { RETAIL_POLICY_DIGEST } from './versions.js';

/**
 * Bindings, propose only (plan v5 §7, Q-B1): which Holdr card accounts each card identity the stored receipts name could
 * be. Read-only. The proposal is an owner-only file (`holdr.retail-binding-proposal` v1); approval and revocation arrive
 * with PR 4, beside the activation preview, and nothing here writes a binding.
 *
 * Only `card` and `card-refund` tenders name a card identity (network, last four), merchant-wide over every stored
 * version: never a debit, cash, Shop Card, certificate or coupon tender. Every card account whose last four matches is a
 * candidate, whatever its status, and a shared last four lists them all: nothing here chooses a card.
 */

export const RETAIL_BINDING_PROPOSAL_FORMAT = 'holdr.retail-binding-proposal' as const;

export interface RetailBindingCandidate {
  cardAccountId: string;
  issuer: string;
  owner: string | null;
  status: string;
}

export interface RetailBindingIdentity {
  candidates: RetailBindingCandidate[];
  last4: string;
  network: string;
}

export interface RetailBindingProposal {
  databaseRef: string;
  format: typeof RETAIL_BINDING_PROPOSAL_FORMAT;
  identities: RetailBindingIdentity[];
  inventoryDigest: string;
  pairs: [];
  policyDigest: string;
  schemaDigest: string;
  version: 1;
}

/** What `bindings propose` prints: counts only. */
export interface RetailBindingSummary {
  identities: number;
  oneCandidate: number;
  severalCandidates: number;
  noCandidate: number;
}

interface CardAccount {
  id: string;
  issuer: string;
  owner: string | null;
  last4: string | null;
  status: string;
}

/** Every Holdr card account (id, issuer, owner, last four, status), or none when the card tables are absent. */
function cardInventory(db: Database.Database): CardAccount[] {
  const installed = db.prepare(`SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'card_accounts'`).get() !== undefined;
  return installed ? db.prepare('SELECT id, issuer, owner, last4, status FROM card_accounts ORDER BY id').all() as CardAccount[] : [];
}

/** The inventory digest (lowercase hex): any change to a card account's id, issuer, owner, last four or status changes it. */
export const retailInventoryDigest = (accounts: readonly CardAccount[]): string => digest({
  format: 'holdr.retail-binding-inventory', version: 1,
  accounts: accounts.map(({ id, issuer, owner, last4, status }) => ({ id, issuer, owner, last4, status })),
});

/** The proposal and its value-free summary. Read-only; the tables must be installed and hold no reserved value. */
export function proposeRetailBindings(db: Database.Database, databaseRef: string): { proposal: RetailBindingProposal; summary: RetailBindingSummary } {
  try {
    return db.transaction(() => {
      requireRetailSchema(db);
      const inventory = cardInventory(db);
      const named = db.prepare(`SELECT DISTINCT network, last4 FROM retail_tender_facts WHERE kind IN ('card', 'card-refund') AND last4 IS NOT NULL
        ORDER BY network, last4`).all() as Array<{ network: string; last4: string }>;
      const identities = named.map(({ network, last4 }): RetailBindingIdentity => ({
        candidates: inventory.filter((account) => account.last4 === last4)
          .map((account) => ({ cardAccountId: account.id, issuer: account.issuer, owner: account.owner, status: account.status })),
        last4,
        network,
      }));
      const proposal: RetailBindingProposal = {
        databaseRef, format: RETAIL_BINDING_PROPOSAL_FORMAT, identities, inventoryDigest: retailInventoryDigest(inventory), pairs: [],
        policyDigest: RETAIL_POLICY_DIGEST, schemaDigest: RETAIL_SCHEMA_DIGEST, version: 1,
      };
      return {
        proposal,
        summary: {
          identities: identities.length,
          oneCandidate: identities.filter((identity) => identity.candidates.length === 1).length,
          severalCandidates: identities.filter((identity) => identity.candidates.length > 1).length,
          noCandidate: identities.filter((identity) => identity.candidates.length === 0).length,
        },
      };
    })();
  } catch (error) {
    if (error instanceof RetailRefusal) throw error;
    throw toValueFreeDbError('propose retail bindings', error);
  }
}

/**
 * The proposal file's text: its keys and each entry's in sorted order (as the types above declare them), two-space
 * indents, one final newline. Its SHA-256 is what a PR 4 approval names.
 */
export const serializeRetailBindingProposal = (proposal: RetailBindingProposal): string => `${JSON.stringify({
  databaseRef: proposal.databaseRef,
  format: proposal.format,
  identities: proposal.identities.map((identity) => ({
    candidates: identity.candidates.map((candidate) => ({
      cardAccountId: candidate.cardAccountId, issuer: candidate.issuer, owner: candidate.owner, status: candidate.status,
    })),
    last4: identity.last4,
    network: identity.network,
  })),
  inventoryDigest: proposal.inventoryDigest,
  pairs: [],
  policyDigest: proposal.policyDigest,
  schemaDigest: proposal.schemaDigest,
  version: proposal.version,
}, null, 2)}\n`;
