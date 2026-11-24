import type { Database } from 'better-sqlite3';
import { digest, exact, POLICY_DIGEST, refuse } from './policy.js';
import type { Binding, BindingProposal, CardIdentity, RootApproval } from './types.js';

export function readCardInventory(db: Database): CardIdentity[] {
  return db.prepare(`SELECT id,issuer,owner,last4,currency,status FROM card_accounts ORDER BY id`).all() as CardIdentity[];
}
export function inventoryDigest(cards: CardIdentity[]): string {
  return digest([...cards].sort((a, b) => a.id.localeCompare(b.id)).map(c => ({
    id: c.id, issuer: c.issuer, owner: c.owner, last4: c.last4, currency: c.currency, status: c.status,
  })));
}
function validateBindings(input: unknown, cards: CardIdentity[]): Binding[] {
  if (!Array.isArray(input) || input.length > 100) return refuse();
  const bindings: Binding[] = [];
  for (const value of input) {
    const b = exact(value, ['network', 'last4', 'cardAccountId']);
    const network = b.network;
    if ((network !== 'visa' && network !== 'mastercard' && network !== 'amex' && network !== 'discover')
      || typeof b.last4 !== 'string' || !/^\d{4}$/.test(b.last4) || typeof b.cardAccountId !== 'string'
      || !cards.some(c => c.id === b.cardAccountId && c.last4 === b.last4 && c.status === 'active')) return refuse();
    bindings.push({ network, last4: b.last4, cardAccountId: b.cardAccountId });
  }
  // A shared last4/network cannot choose between household cards, even if account IDs differ.
  if (new Set(bindings.map(b => `${b.network}:${b.last4}`)).size !== bindings.length
    || new Set(bindings.map(b => b.cardAccountId)).size !== bindings.length) return refuse();
  return bindings.sort((a, b) => a.cardAccountId.localeCompare(b.cardAccountId));
}
export function proposeBindings(input: unknown, cards: CardIdentity[]): BindingProposal {
  return { format: 'holdr.amazon-binding-proposal', version: 1, policyDigest: POLICY_DIGEST,
    inventoryDigest: inventoryDigest(cards), bindings: validateBindings(input, cards) };
}
export function validateProposal(input: unknown, cards: CardIdentity[]): BindingProposal {
  const p = exact(input, ['format', 'version', 'policyDigest', 'inventoryDigest', 'bindings']);
  const expected = proposeBindings(p.bindings, cards);
  if (digest(expected) !== digest(input)) return refuse();
  return expected;
}
export function validateApproval(input: unknown, proposal: BindingProposal): RootApproval {
  const a = exact(input, ['format', 'version', 'authority', 'decision', 'proposalDigest', 'policyDigest', 'inventoryDigest']);
  if (a.format !== 'holdr.amazon-root-approval' || a.version !== 1 || a.authority !== 'Root' || a.decision !== 'approved'
    || a.proposalDigest !== digest(proposal) || a.policyDigest !== POLICY_DIGEST
    || a.inventoryDigest !== proposal.inventoryDigest) return refuse();
  return { format: 'holdr.amazon-root-approval', version: 1, authority: 'Root', decision: 'approved',
    proposalDigest: digest(proposal), policyDigest: POLICY_DIGEST, inventoryDigest: proposal.inventoryDigest };
}
export function activeBindings(db: Database, cards: CardIdentity[]): Binding[] {
  const rows = db.prepare(`SELECT p.data_json AS proposal,a.data_json AS approval
    FROM amazon_binding_proposals p JOIN amazon_binding_approvals a ON a.proposal_digest=p.digest`).all() as Array<{ proposal: string; approval: string }>;
  const bindings: Binding[] = [];
  for (const row of rows) {
    const proposal = JSON.parse(row.proposal) as BindingProposal;
    // Identity drift suspends authority; new ledger transactions do not.
    if (proposal.inventoryDigest !== inventoryDigest(cards) || proposal.policyDigest !== POLICY_DIGEST) continue;
    const checked = validateProposal(proposal, cards);
    validateApproval(JSON.parse(row.approval), checked);
    bindings.push(...checked.bindings);
  }
  return [...new Map(bindings.map(b => [digest(b), b])).values()];
}
