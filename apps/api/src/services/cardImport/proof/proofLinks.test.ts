import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { proposeBindings, readCardInventory } from '../../amazon/bindings.js';
import { rootApproval, syntheticCapture } from '../../amazon/fixtures.testSupport.js';
import { importAmazonCapture, recordBindingProposal, recordRootApproval } from '../../amazon/importer.js';
import { linkedCardRows } from '../../amazon/savedOrders.js';
import { SAVED_FRESH } from '../../amazon/savedOrdersFixtures.testSupport.js';
import type { PaymentObservation } from '../../amazon/types.js';
import { indexesOf } from '../plan.js';
import { commitWithProof, ProofHold, type ProofCommitResult } from './commitWithProof.js';
import { diffLinks, type LinksDiff } from './links.js';
import type { ProofReceipt } from './receipt.js';
import { payloadText, ProofWorld, sha256 } from '../../../testing/cardImportProofWorld.js';
import {
  serializeCardImportPayload, validateCardImportPayload, type CardAccount, type CardImportDraftRow,
} from '@finance-tracker/shared';

// Entirely synthetic: an invented order, card ending, descriptors and amounts.
// D12 + G-LINKS (ROOT): a promotion may rewrite a row's text, but not where an Amazon order links. A pending tips-class
// row is never a candidate; posted with its text unchanged it still is not, so the order keeps its one link. Posted with
// plain Amazon text, it becomes a second candidate and the order's link is lost at the next settle: that holds.
const NOW = '2026-10-24T05:00:00.000Z';
const LINKED = 'AMAZON.COM*SYNTH CHARGE A', TIPS = 'AMAZON TIPS*SYNTH';
let dir: string, w: ProofWorld, card: CardAccount, backups = 0;
const backup = () => path.join(dir, `backup-${++backups}.db`);

function ledgerCapture() {
  const c = syntheticCapture();
  c.staging.runId = '00000000-0000-4000-8000-000000000001';
  c.staging.orders = [];
  c.staging.payments = [{
    date: '2026-09-11', money: { currency: 'USD', amountMinor: 1000 }, kind: 'charge', status: 'completed',
    method: { kind: 'card', network: 'visa', last4: '9001' }, orderIds: [SAVED_FRESH], identity: 'native-row',
    provenance: { source: 'ledger', status: 'Charged', page: 0, ordinal: 0 },
  } satisfies PaymentObservation];
  const none = { status: 'held' as const, reason: 'selector-failed' as const, pages: 0, records: 0, rejected: 0 };
  c.staging.coverage = { orders: none, details: none, refunds: none,
    payments: { status: 'partial', reason: 'budget', pages: 1, records: 1, rejected: 0 } };
  return c;
}

const posted = (description: string) => payloadText('chase', [
  { transactionDate: '2026-09-11', postedDate: '2026-09-13', status: 'posted', amountMinor: 1000, kind: 'purchase', description,
    externalId: 'proof-amz-2' } satisfies CardImportDraftRow,
], { start: '2026-09-13', end: '2026-09-13' }, { statement: true });

/** The proof driven as the route drives it, with `fault` written inside its transaction just after the import itself. */
function proveWith(body: string, fault: () => void = () => undefined): ProofCommitResult {
  const checked = validateCardImportPayload(JSON.parse(body));
  if (!checked.ok) throw new Error('synthetic payload invalid');
  const payload = checked.payload;
  const commitOnce = () => {
    const plan = w.repo.previewCardImport({ cardAccountId: card.id, payload }).plan;
    return w.repo.commitCardImport({ cardAccountId: card.id, payload, decisions: {}, shown: {
      possibleDuplicateRows: indexesOf(plan, 'possible-duplicate'), pendingMatchRows: indexesOf(plan, 'pending-match'),
      dismissedMatchRows: indexesOf(plan, 'dismissed-match'), stalePendingIds: plan.stale.map((row) => row.id),
    } });
  };
  return commitWithProof({ db: w.db, repo: w.repo, account: card, payload, payloadSha256: sha256(serializeCardImportPayload(payload)),
    route: 'commit', now: Date.now }, { mode: 'automatic', jobId: sha256('synthetic-links-fault-job'), attempt: 1,
    deadlineMs: Date.now() + 30_000, statementPolicy: 'require-match' }, {
    commit() {
      const result = commitOnce();
      if (result.status === 'decision-required') throw new Error('synthetic plan not clean');
      fault();
      return {
        outcome: result.status === 'imported' ? 'committed' : 'nothing-new', planDigest: result.preview.previewDigest,
        newCount: result.status === 'imported' ? result.batch.newCount : 0, promotedCount: result.counts.pendingPostedCount,
        skippedRows: [], heldCount: 0, reviewCount: 0,
      };
    },
    reapplyAddsNothing: () => commitOnce().status === 'nothing-new',
  });
}

/** Files the order's one stored link under another subject: its card row stays linked, but to other orders. */
function moveStoredLink(): void {
  for (const table of ['amazon_matches', 'amazon_ledger_matches'] as const) {
    const row = w.db.prepare(`SELECT subject_ref AS ref, data_json AS json FROM ${table} WHERE state = 'linked'`).get() as
      { ref: string; json: string } | undefined;
    if (!row) continue;
    const match = JSON.parse(row.json) as { subjectRef: string };
    w.db.prepare(`UPDATE ${table} SET data_json = ? WHERE subject_ref = ?`)
      .run(JSON.stringify({ ...match, subjectRef: `${match.subjectRef}-moved` }), row.ref);
    return;
  }
  throw new Error('no stored link');
}

class Undo extends Error {}
/** What `fault` does to the stored links, on the state as it is, rolled back at once. */
function storedLinksChangedBy(fault: () => void): LinksDiff {
  let diff: LinksDiff | undefined;
  try {
    w.db.transaction(() => {
      const before = linkedCardRows(w.db);
      fault();
      diff = diffLinks(before, linkedCardRows(w.db));
      throw new Undo();
    })();
  } catch (error) {
    if (!(error instanceof Undo)) throw error;
  }
  return diff as LinksDiff;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-links-synthetic-'));
  backups = 0;
  w = new ProofWorld();
  card = w.account('chase', '9001');
  const proposal = proposeBindings([{ network: 'visa', last4: '9001', cardAccountId: card.id }], readCardInventory(w.db));
  await recordBindingProposal(w.db, proposal, backup());
  await recordRootApproval(w.db, proposal, rootApproval(proposal), backup());
  await w.seed(card, payloadText('chase', [
    { transactionDate: '2026-09-11', postedDate: '2026-09-12', amountMinor: 1000, kind: 'purchase', description: LINKED, externalId: 'proof-amz-1' },
    { transactionDate: '2026-09-11', status: 'pending', amountMinor: 1000, kind: 'purchase', description: TIPS, externalId: 'proof-amz-2' },
  ], { start: '2026-09-01', end: '2026-09-30' }));
  await importAmazonCapture(w.db, ledgerCapture(), backup(), NOW);
  w.live('chase');
});
afterEach(() => {
  w.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('G-LINKS on a promotion\'s text (D12)', () => {
  it('links the one posted row before the import', () => {
    const linked = w.db.prepare('SELECT id FROM card_transactions WHERE description = ?').pluck().get(LINKED) as string;
    expect([...linkedCardRows(w.db).keys()]).toEqual([linked]);
  });

  it('passes the promotion when its text leaves the order\'s link where it is', async () => {
    const res = await w.commit(card, posted(TIPS), { jobId: sha256('synthetic-links-job') });
    expect(res.status, res.text).toBe(201);
    expect(res.body.proof).toMatchObject({ counts: { promoted: 1 }, rows: { promotedTextChanged: 0 },
      links: { applicable: true, stored: 1, lost: 0, moved: 0, projectedLost: 0, projectedMoved: 0 } });
  });

  it('holds the promotion when its new text would unlink the order at the next settle, writing nothing', async () => {
    const before = w.image();
    const res = await answered(w.commit(card, posted('AMAZON.COM*SYNTH CHARGE B'), { jobId: sha256('synthetic-links-job') }));
    expect([res.status, res.body.code], res.text).toEqual([409, 'proof-links-projected']);
    expect(w.image().equals(before)).toBe(true);
  });
});

describe('G-LINKS on the stored links', () => {
  it('holds a stored link moved inside the import\'s transaction, though none is lost, writing nothing', () => {
    // A card import never writes the Amazon tables, so a stored link that moves (or appears) is never the import's.
    expect(storedLinksChangedBy(moveStoredLink)).toEqual({ lost: 0, moved: 1, added: 0 });
    const before = w.image();
    let error: unknown;
    try { proveWith(posted(TIPS), moveStoredLink); } catch (caught) { if (!(caught instanceof ProofHold)) throw caught; error = caught; }
    expect(error).toBeInstanceOf(ProofHold);
    expect((error as ProofHold).code).toBe('proof-links-stored');
    expect(w.image().equals(before)).toBe(true);
    // The control: the same promotion, its links left alone, commits.
    let receipt: ProofReceipt | undefined;
    let held: string | null = null;
    try {
      receipt = proveWith(posted(TIPS)).receipt;
    } catch (caught) {
      if (!(caught instanceof ProofHold)) throw caught;
      held = caught.code;
    }
    expect(held, 'the proof held a commit that must pass').toBeNull();
    expect(receipt).toMatchObject({ counts: { promoted: 1 }, links: { applicable: true, stored: 1, lost: 0, moved: 0, added: 0 } });
  });
});

/**
 * The route's answer, as an action: only the declared hold (a 409 with a proof code) or a commit comes back; any other
 * answer fails the test as an error, never as an assertion (ROOT's kill standard, addendum 3 (e)).
 */
async function answered<T extends { status: number; body: { code?: unknown } }>(pending: Promise<T>): Promise<T> {
  const res = await pending;
  const held = res.status === 409 && typeof res.body.code === 'string' && res.body.code.startsWith('proof-');
  if (!held && (res.status < 200 || res.status >= 300)) throw new Error(`the commit route answered ${res.status}`);
  return res;
}
