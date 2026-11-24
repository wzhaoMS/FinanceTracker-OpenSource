import { useEffect, useId, useState } from 'react';
import type { CashEventType, Transaction } from '@finance-tracker/shared';
import { formatCurrency, formatOptionSymbol, lastFour, maskAccountNumber } from '@finance-tracker/shared';

import { api, apiRaw } from '../services/api';
import { usePortfolioStore } from '../stores/portfolio';
import { StaleOperationError } from '../stores/storeOp';
import { formatRoute } from '../modes/route';
import { Disclosure } from './Disclosure';
import './investing-entry.css';

/** The page's first question: holdings (or trades) for an account, or a broker statement's value. */
type ImportKind = 'holdings' | 'statement';

/**
 * An account as the import names it, in full: its name, type and masked number ("Alex · Brokerage · Individual ·
 * ***0101"). The same words in every select, the line under it, the preview's title and the outcome, so two accounts
 * of the same name are told apart before anything is saved (Astra's review of #248).
 */
function accountIdentity(account: { name: string; type?: string; accountNumber?: string | null }): string {
  return [account.name, account.type, maskAccountNumber(account.accountNumber)].filter(Boolean).join(' · ');
}

interface ImportPreview {
  transactions: Transaction[];
  rejected: { row: Record<string, string>; reason: string }[];
  mapping: Record<string, string | null>;
  /** Present only when the preview was pulled from the portfolio-bridge sidecar. */
  source?: {
    broker: string;
    sourceUrl: string | null;
    tableCount: number | null;
    candidateCount: number | null;
  };
}

/** Per-account preview returned when the broker page lists multiple accounts. */
interface SectionPreview {
  section: string;
  suggestion: { accountId: string; accountName: string; confidence: number } | null;
  transactions: Transaction[]; // accountId is intentionally blank — UI assigns it
  rejected: { row: Record<string, string>; reason: string }[];
  mapping: Record<string, string | null>;
}

/** Shape returned by /import/from-broker when sections are present. */
interface MultiSectionImportResponse {
  previews: SectionPreview[];
  source: ImportPreview['source'];
  accounts: { id: string; name: string; type?: string; accountNumber?: string }[];
}

/** Discriminator for the union response from /import/from-broker. */
type FromBrokerResponse = ImportPreview | MultiSectionImportResponse;

/** Activity-import row, mirrors the shape from
 *  apps/api/src/routes/brokerActivity.ts. Kept as a structural type so
 *  the UI can be flexible if new status kinds are added later. */
interface ActivityRowStatus {
  kind:
    | 'new'
    | 'duplicate'
    | 'new-cash'
    | 'duplicate-cash'
    | 'no-account-match'
    | 'ambiguous-account-match'
    | 'skip-cash'
    | 'skip-sweep'
    | 'reject-incomplete'
    | 'reject-option-ledger'
    | 'reject-cash-incomplete'
    | 'reject-unknown';
  accountId?: string;
  existingId?: string;
  fingerprint?: string;
  accountLast4?: string | null;
  accountIds?: string[];
  reason?: string;
}

interface ActivityPreviewRow {
  date: string;
  accountLabel: string;
  accountLast4: string | null;
  description: string;
  amount: string;
  action: string;
  symbol: string | null;
  quantity: number | null;
  pricePerUnit: number | null;
  fees: number | null;
  instrumentType?: 'option';
  contractMultiplier?: number;
  positionEffect?: 'open' | 'close';
  cashEventType: CashEventType | null;
  cashAmount: number | null;
  cashOccurrence: number | null;
  fingerprint: string | null;
  status: ActivityRowStatus;
}

interface ActivityImportResponse {
  rows: ActivityPreviewRow[];
  summary: {
    total: number;
    new: number;
    duplicates: number;
    newCash: number;
    duplicateCash: number;
    rejectedCash: number;
    skippedCash: number;
    skippedSweep: number;
    rejected: number;
    noAccountMatch: number;
    ambiguousAccountMatch: number;
  };
  source: { broker: string; sourceUrl: string | null };
  accounts: { id: string; name: string; type?: string; accountNumber?: string }[];
}

interface NavStatementPreview {
  statement: {
    broker: 'schwab';
    statementPeriodStart: string;
    statementPeriodEnd: string;
    observedAt: string;
    nav: number;
    currency: 'USD';
    accountLast4: string;
    sourcePage: number;
  };
  source: {
    documentHash: string;
    fileName?: string;
    page: number;
  };
  previewToken: string;
  accountMatches: Array<{ id: string; name: string; type?: string }>;
  requiresExplicitAccountSelection: boolean;
}

interface NavStatementCommit {
  inserted: boolean;
  observation: {
    id: string;
    accountId: string;
    observedAt: string;
    nav: number;
    importedAt: string;
  };
}

const BROKERS = [
  { key: 'schwab', name: 'Charles Schwab' },
  { key: 'fidelity', name: 'Fidelity' },
  { key: 'citi', name: 'Citi' },
] as const;

const SAMPLE = JSON.stringify(
  {
    headers: ['Symbol', 'Quantity', 'Last price', 'Average cost basis'],
    rows: [
      { Symbol: 'AAPL', Quantity: '50', 'Last price': '$276.87', 'Average cost basis': '$155.20' },
      { Symbol: 'VTI', Quantity: '120', 'Last price': '$353.99', 'Average cost basis': '$210.45' },
    ],
  },
  null,
  2,
);

export function ImportPanel() {
  const accounts = usePortfolioStore((s) => s.accounts);
  const addTransaction = usePortfolioStore((s) => s.addTransaction);
  const replaceSnapshotPositions = usePortfolioStore((s) => s.replaceSnapshotPositions);
  const renameAccount = usePortfolioStore((s) => s.renameAccount);
  const beginOp = usePortfolioStore((s) => s.beginOp);
  const writesDisabled = usePortfolioStore((s) => s.apiStatus === 'cache');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [json, setJson] = useState('');
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** What the user is importing: the first question the page asks. */
  const [kind, setKind] = useState<ImportKind>('holdings');
  /** The outcome of the last "Import N transactions", said once it is saved. */
  const [imported, setImported] = useState<{ count: number; account: string | null } | null>(null);
  /** A failure of the bridge routes (under Advanced), said beside them rather than under the paste form. */
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const ids = useId();
  const [broker, setBroker] = useState<(typeof BROKERS)[number]['key']>('schwab');
  // The bridge call blocks for up to ~5min while the user logs in; we want
  // a separate busy flag so the paste flow stays usable in the meantime is
  // overkill — but we DO want a distinct label on the button so the user
  // knows what's happening.
  const [pullingBroker, setPullingBroker] = useState(false);

  // Per-section preview state. Used when the broker page lists multiple
  // accounts on one page (Fidelity, Schwab combined-view). Each section
  // gets its own assigned account-id, "include?" toggle, and per-section
  // commit. Empty when we're in single-account mode.
  const [sections, setSections] = useState<SectionPreview[] | null>(null);
  const [sectionAssignments, setSectionAssignments] = useState<Record<string, string>>({}); // section → accountId
  const [sectionInclude, setSectionInclude] = useState<Record<string, boolean>>({});
  const [committedSections, setCommittedSections] = useState<Record<string, number>>({}); // section → count committed

  // Activity-import state. Independent from positions: a single flat list
  // of rows the bridge scraped from the broker's "Activity & Orders" page,
  // each tagged with status=new|duplicate|skip-cash|skip-sweep|...
  const [activity, setActivity] = useState<ActivityImportResponse | null>(null);
  const [pullingActivity, setPullingActivity] = useState(false);
  const [importSweep, setImportSweep] = useState(false);
  /** Per-fingerprint user opt-in for new rows. Defaults to true; user can
   *  uncheck to skip individual rows before commit. */
  const [activityInclude, setActivityInclude] = useState<Record<string, boolean>>({});
  const [activityCommitted, setActivityCommitted] = useState<Set<string>>(() => new Set());
  const [activityCommitting, setActivityCommitting] = useState(false);

  // Bookmarklet flow: identical to pullFromBroker except the API route
  // is `/import/from-bookmarklet`, which drains the latest capture the
  // bookmarklet posted to the bridge. We track a separate busy flag so
  // the button labels can be specific.
  const [pullingBookmarklet, setPullingBookmarklet] = useState(false);

  const [navFile, setNavFile] = useState<File | null>(null);
  const [navPreview, setNavPreview] = useState<NavStatementPreview | null>(null);
  const [navAccountId, setNavAccountId] = useState('');
  const [navBusy, setNavBusy] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);
  const [navCommit, setNavCommit] = useState<NavStatementCommit | null>(null);

  // This panel often mounts before the portfolio store finishes hydrating.
  // Keep the selected account valid as the async account list arrives or
  // changes; otherwise every preview/pull button stays disabled forever.
  useEffect(() => {
    if (accounts.length === 0) {
      if (accountId) setAccountId('');
      return;
    }
    if (!accountId || !accounts.some((account) => account.id === accountId)) {
      setAccountId(accounts[0].id);
    }
  }, [accounts, accountId]);

  /**
   * Generic "pull from <source>" runner. Both `pullFromBroker` and
   * `pullFromBookmarklet` set up identical state and parse the response
   * the same way — they only differ in the endpoint they hit and the
   * spinner flag. Factored out so a copy-paste bug can't cause the two
   * paths to diverge on response handling.
   */
  const runPull = async (
    endpoint: '/import/from-broker' | '/import/from-bookmarklet',
    setBusyFlag: (v: boolean) => void,
    fallbackLabel: string,
  ) => {
    setBridgeError(null); setPreview(null); setSections(null); setImported(null);
    setSectionAssignments({}); setSectionInclude({}); setCommittedSections({});
    setBusyFlag(true); setBusy(true);
    try {
      const body = await api<FromBrokerResponse>(endpoint, {
        method: 'POST',
        body: { accountId, asOf, broker },
      });
      if ('previews' in body) {
        setSections(body.previews);
        const init: Record<string, string> = {};
        const inc: Record<string, boolean> = {};
        for (const sec of body.previews) {
          init[sec.section] = sec.suggestion?.accountId ?? '';
          inc[sec.section] = sec.suggestion != null && sec.transactions.length > 0;
        }
        setSectionAssignments(init);
        setSectionInclude(inc);
      } else {
        setPreview(body);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : fallbackLabel;
      if (/bridge unreachable/i.test(msg)) {
        setBridgeError(
          msg +
            '\n\nStart the sidecar in a terminal:\n  .venv/bin/python apps/portfolio-bridge/server.py',
        );
      } else {
        setBridgeError(msg);
      }
    } finally {
      setBusyFlag(false); setBusy(false);
    }
  };

  const pullFromBroker = () =>
    runPull('/import/from-broker', setPullingBroker, 'Pull failed');

  const pullFromBookmarklet = () =>
    runPull(
      '/import/from-bookmarklet',
      setPullingBookmarklet,
      'Bookmarklet pull failed',
    );

  /**
   * Commit one section's transactions to the user-assigned account using
   * snapshot semantics: every existing `pos:*`-tagged transaction in the
   * target account is replaced atomically. Same broker pull twice -> same
   * DB state. Doesn't touch manual rows or activity-imported rows.
   *
   * Side effect: if the chosen account has no `accountNumber` set but the
   * section label includes a last-4 (e.g. "ROTH IRA ***6741"), we save
   * the last-4 onto the account. Future pulls from the same broker can
   * then deterministically match this account by last-4 instead of fuzzy
   * string overlap, exactly like the Fidelity flow.
   */
  const commitSection = async (sec: SectionPreview) => {
    const targetId = sectionAssignments[sec.section] || '';
    if (!targetId) {
      setBridgeError(`Choose an account for "${sec.section}" before importing it.`);
      return;
    }
    if (committedSections[sec.section]) return; // guard against double-click
    // One operation for the whole commit: after a sign-out, no further step runs or reports.
    const op = beginOp();
    setBusy(true); setBridgeError(null);
    try {
      // Stamp every preview row with sourceFingerprint = "pos:<symbol>".
      // Symbols are already normalized to upper-case at the API boundary
      // (validateTransaction trims + uppercases), so the same broker
      // pull -> same fingerprint set -> idempotent re-syncs.
      const stamped = sec.transactions.map((tx) => ({
        ...tx,
        accountId: targetId,
        sourceFingerprint: `pos:${(tx.symbol || '').toUpperCase()}`,
      }));
      await replaceSnapshotPositions(targetId, stamped, op);

      // Best-effort: if the section label exposes a last-4 and the target
      // account hasn't been numbered yet, save it. We deliberately don't
      // overwrite an existing accountNumber — the user may have entered
      // a fuller form (e.g. full 9-digit Fidelity number) we shouldn't
      // truncate.
      const targetAcct = accounts.find((a) => a.id === targetId);
      const sectionLast4 = lastFour(sec.section);
      if (targetAcct && sectionLast4 && !lastFour(targetAcct.accountNumber)) {
        try {
          await renameAccount(targetId, { accountNumber: sectionLast4 }, op);
        } catch {
          /* non-fatal: the import already succeeded */
        }
      }

      op.commit(() => setCommittedSections((prev) => ({ ...prev, [sec.section]: stamped.length })));
    } catch (err) {
      op.commit(() => setBridgeError(err instanceof Error ? err.message : 'Import failed'));
    } finally {
      setBusy(false);
    }
  };

  /** Pull the broker's activity-and-orders feed and surface a preview.
   *  Resets all activity state (include map, committed set) so a fresh
   *  pull doesn't carry over stale toggles. */
  const pullActivity = async () => {
    setBridgeError(null); setActivity(null); setActivityCommitted(new Set());
    setActivityInclude({}); setPullingActivity(true); setBusy(true);
    try {
      const body = await api<ActivityImportResponse>('/import/activity-from-broker', {
        method: 'POST',
        body: { broker, importSweep },
      });
      setActivity(body);
      // Default-include every "new" row. Other statuses can't be committed
      // (they're skips/rejects/no-match) so their toggles don't matter.
      const init: Record<string, boolean> = {};
      for (const row of body.rows) {
        if ((row.status.kind === 'new' || row.status.kind === 'new-cash') && row.fingerprint) {
          init[row.fingerprint] = true;
        }
      }
      setActivityInclude(init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Activity pull failed';
      if (/bridge unreachable/i.test(msg)) {
        setBridgeError(
          msg +
            '\n\nStart the sidecar in a terminal:\n  .venv/bin/python apps/portfolio-bridge/server.py',
        );
      } else if (/login timed out/i.test(msg)) {
        setBridgeError(msg + '\n\nFinish logging in to the broker before the 5min timeout next time.');
      } else {
        setBridgeError(msg);
      }
    } finally {
      setPullingActivity(false); setBusy(false);
    }
  };

  /** Commit every checked "new" activity row. Each commit goes to its own
   *  matched account, so we don't need a section-style account picker. */
  const commitActivity = async () => {
    if (!activity) return;
    if (activityCommitting) return;
    // One operation for every row: after a sign-out, no further row is sent.
    const op = beginOp();
    setActivityCommitting(true); setBridgeError(null);
    try {
      const newCommitted = new Set(activityCommitted);
      for (const row of activity.rows) {
        if (row.status.kind !== 'new' && row.status.kind !== 'new-cash') continue;
        if (!row.fingerprint || !activityInclude[row.fingerprint]) continue;
        if (newCommitted.has(row.fingerprint)) continue;
        const accountId = row.status.accountId!;
        const date = parseFidelityDateForCommit(row.date) ?? row.date;
        if (row.status.kind === 'new-cash') {
          if (
            !row.cashEventType
            || row.cashAmount == null
            || row.cashOccurrence == null
            || !row.accountLast4
          ) {
            throw new Error(`Cash event preview is incomplete for ${row.description}`);
          }
          if (!op.current()) throw new StaleOperationError();
          await api(`/accounts/${encodeURIComponent(accountId)}/cash-events`, {
            method: 'POST',
            headers: { 'X-Confirm-Account-Last4': row.accountLast4 },
            body: {
              date,
              eventType: row.cashEventType,
              amount: row.cashAmount,
              currency: 'USD',
              broker: activity.source.broker,
              accountLast4: row.accountLast4,
              description: row.description,
              sourceOccurrence: row.cashOccurrence,
              sourceFingerprint: row.fingerprint,
            },
          });
        } else {
          // Build a Transaction. Note `notes` carries the raw description for
          // user-visible context; the action lives implicitly in qty sign +
          // notes text.
          const tx = {
            id: `act-${crypto.randomUUID()}`,
            accountId,
            symbol: row.symbol ?? '',
            date,
            quantity: row.quantity ?? 0,
            pricePerUnit: row.pricePerUnit ?? 0,
            ...(row.fees != null ? { fees: row.fees } : {}),
            ...(row.instrumentType === 'option'
              ? {
                  instrumentType: 'option' as const,
                  contractMultiplier: row.contractMultiplier,
                  positionEffect: row.positionEffect,
                }
              : {}),
            currency: 'USD',
            notes: row.description,
            sourceFingerprint: row.fingerprint,
          };
          await addTransaction(tx, op);
        }
        newCommitted.add(row.fingerprint);
        // Optimistic UI: bump the committed set after each successful insert.
        if (!op.commit(() => setActivityCommitted(new Set(newCommitted)))) throw new StaleOperationError();
      }
    } catch (err) {
      op.commit(() => setBridgeError(err instanceof Error ? err.message : 'Activity import failed'));
    } finally {
      setActivityCommitting(false);
    }
  };

  const runPreview = async () => {
    setError(null); setPreview(null); setImported(null); setBusy(true);
    try {
      let table: { headers?: unknown; rows?: unknown };
      try {
        table = JSON.parse(json) as typeof table;
      } catch {
        table = {};
      }
      if (!Array.isArray(table.headers) || !Array.isArray(table.rows)) {
        throw new Error('Holdr can\'t read this as a holdings table: it needs the JSON your capture copied, with headers[] and rows[]. See "Holdings table format" under Advanced.');
      }
      const body = await api<ImportPreview>('/import/positions', {
        method: 'POST',
        body: { accountId, asOf, table },
      });
      setPreview(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    // Sequential so the server keeps row order stable; per-tx awaits also
    // mean a 4xx on one tx surfaces immediately instead of fire-and-forget.
    // One operation for every row: after a sign-out, no further row is sent.
    // Rejects when a write fails or a new sign-in cancels it; the store
    // reports the current session's failures, so callers only take the rejection.
    const op = beginOp();
    const count = preview.transactions.length;
    const target = accounts.find((account) => account.id === preview.transactions[0]?.accountId);
    for (const tx of preview.transactions) await addTransaction(tx, op);
    op.commit(() => {
      setPreview(null);
      setJson('');
      setImported({ count, account: target ? accountIdentity(target) : null });
    });
  };

  const previewNavStatement = async () => {
    if (!navFile) return;
    setNavBusy(true); setNavError(null); setNavPreview(null); setNavCommit(null);
    try {
      const result = await apiRaw<NavStatementPreview>(
        '/import/nav-statement/preview',
        navFile,
        navPdfHeaders(navFile),
      );
      setNavPreview(result);
      setNavAccountId('');
    } catch (err) {
      setNavError(err instanceof Error ? err.message : 'Statement preview failed');
    } finally {
      setNavBusy(false);
    }
  };

  const commitNavStatement = async () => {
    if (!navFile || !navPreview || !navAccountId) return;
    setNavBusy(true); setNavError(null);
    try {
      const result = await apiRaw<NavStatementCommit>(
        `/accounts/${encodeURIComponent(navAccountId)}/nav-history/import`,
        navFile,
        {
          ...navPdfHeaders(navFile),
          'X-NAV-Preview-Token': navPreview.previewToken,
          'X-Confirm-Account-Last4': navPreview.statement.accountLast4,
        },
      );
      setNavCommit(result);
    } catch (err) {
      setNavError(err instanceof Error ? err.message : 'Statement import failed');
    } finally {
      setNavBusy(false);
    }
  };

  const choiceIds = { holdings: `${ids}-holdings`, statement: `${ids}-statement` };
  const tableHelpId = `${ids}-table-help`;
  const destinationId = `${ids}-destination`;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const navAccount = accounts.find((account) => account.id === navAccountId);

  /** A holdings preview (pasted or pulled): what will be saved, into which account, then the one action that saves it. */
  const renderPreview = (shown: ImportPreview) => {
    const target = accounts.find((account) => account.id === shown.transactions[0]?.accountId);
    return (
      <section className="preview import-preview" aria-label="Import preview">
        {shown.source ? (
          <p className="import-preview-source">
            Pulled from <strong>{shown.source.broker}</strong>
            {shown.source.sourceUrl ? <> · <code>{shown.source.sourceUrl}</code></> : null}
            {shown.source.tableCount != null
              ? <> · {shown.source.candidateCount} of {shown.source.tableCount} tables matched the positions shape</>
              : null}
          </p>
        ) : null}
        <h3>
          {count(shown.transactions.length, 'transaction', 'transactions')} to import
          {target ? <> into <span className="import-preview-account">{accountIdentity(target)}</span></> : null}
        </h3>
        <p className="import-preview-mapping">
          Columns read: symbol from <code>{shown.mapping.symbol ?? '(none)'}</code>,
          quantity from <code>{shown.mapping.quantity ?? '(none)'}</code>,
          price from <code>{shown.mapping.price ?? '(none)'}</code>,
          cost from <code>{shown.mapping.cost ?? '(none)'}</code>.
        </p>
        {shown.transactions.map((t) => (
          <div className="row" key={t.id}>
            <div>
              <div className="symbol">{t.symbol}</div>
              <div className="muted import-preview-detail">{t.quantity} @ {formatCurrency(t.pricePerUnit, t.currency)}</div>
            </div>
          </div>
        ))}
        {shown.rejected.length > 0 ? (
          <>
            <h3>{count(shown.rejected.length, 'rejected row', 'rejected rows')}</h3>
            {shown.rejected.map((r, i) => (
              <div className="row" key={i}>
                <div>
                  <div className="symbol">{r.row.Symbol ?? r.row.symbol ?? '(no symbol)'}</div>
                  <div className="muted import-preview-detail">{r.reason}</div>
                </div>
              </div>
            ))}
          </>
        ) : null}
        {shown.transactions.length > 0 ? (
          <>
            <p className="import-preview-note">Nothing is saved until you choose Import.</p>
            <button type="button" className="commit" onClick={() => { void commit().catch(() => {}); }}>
              Import {count(shown.transactions.length, 'transaction', 'transactions')}
            </button>
          </>
        ) : null}
      </section>
    );
  };

  return (
    <fieldset className="import-panel" disabled={writesDisabled}>
      <fieldset className="import-choice">
        <legend>What do you want to import?</legend>
        <div className="import-choice-option">
          <input
            id={choiceIds.holdings}
            type="radio"
            name={`${ids}-kind`}
            value="holdings"
            checked={kind === 'holdings'}
            onChange={() => setKind('holdings')}
            aria-describedby={`${choiceIds.holdings}-hint`}
          />
          <label htmlFor={choiceIds.holdings}>Holdings or trades for an account</label>
          <p className="import-choice-hint" id={`${choiceIds.holdings}-hint`}>
            Paste a holdings table, or bring holdings and trades in from your broker under Advanced.
          </p>
        </div>
        <div className="import-choice-option">
          <input
            id={choiceIds.statement}
            type="radio"
            name={`${ids}-kind`}
            value="statement"
            checked={kind === 'statement'}
            onChange={() => setKind('statement')}
            aria-describedby={`${choiceIds.statement}-hint`}
          />
          <label htmlFor={choiceIds.statement}>A broker statement (PDF)</label>
          <p className="import-choice-hint" id={`${choiceIds.statement}-hint`}>
            The account value on a Charles Schwab statement.
          </p>
        </div>
        <p className="import-choice-note">You see a preview first. Nothing is saved until you choose Import.</p>
      </fieldset>

      {kind === 'holdings' ? (
        <section className="import-step import-holdings" aria-label="Holdings or trades for an account">
          <form className="add import-holdings-form" onSubmit={(e) => { e.preventDefault(); void runPreview(); }}>
            {/* The select can cut a long account short; the line under it says the whole account, wrapping. */}
            <div className="import-account-field">
              <label>
                Account
                <select
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  aria-describedby={selectedAccount ? destinationId : undefined}
                >
                  {accounts.length === 0 ? <option value="">No accounts: add one first</option> : null}
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{accountIdentity(a)}</option>
                  ))}
                </select>
              </label>
              {selectedAccount ? (
                <p className="import-destination" id={destinationId}>
                  These holdings go into <span className="import-destination-account">{accountIdentity(selectedAccount)}</span>.
                </p>
              ) : null}
            </div>
            <label>
              As of
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </label>
            <label className="full">
              Holdings table
              <textarea
                rows={8}
                value={json}
                onChange={(e) => setJson(e.target.value)}
                spellCheck={false}
                placeholder="Paste the holdings table here"
                aria-describedby={tableHelpId}
              />
            </label>
            <p className="form-hint import-table-help" id={tableHelpId}>
              Paste the table your capture copied. Its format, a sample and other ways to capture it are under Advanced.
            </p>
            <button type="submit" disabled={busy || !accountId || !json.trim()}>
              {busy && preview == null && !pullingBroker && !pullingBookmarklet && !pullingActivity ? 'Previewing…' : 'Preview import'}
            </button>
          </form>

          {error ? <div className="error import-error" role="alert">{error}</div> : null}
          {accounts.length === 0 ? (
            <p className="import-no-accounts">
              Holdings go into an account, and there is none yet.{' '}
              <button
                type="button"
                className="import-action"
                onClick={() => { window.location.hash = formatRoute({ mode: 'investing', tab: 'accounts' }); }}
              >
                Add account
              </button>
            </p>
          ) : null}
          {preview && !preview.source ? renderPreview(preview) : null}
          {imported ? (
            <p className="import-done" role="status">
              Imported {count(imported.count, 'transaction', 'transactions')}{imported.account ? ` into ${imported.account}` : ''}.
            </p>
          ) : null}

          <Disclosure className="import-advanced" summary="Advanced: the table format, and importing through the Holdr bridge">
            <section className="import-format" aria-label="Holdings table format">
              <h3>Holdings table format</h3>
              <p>
                JSON with <code>headers[]</code> and <code>rows[]</code>, as webhand&apos;s <code>extractAllTables()</code> returns
                it. Holdr finds the symbol, quantity, price and average cost columns by their names.
              </p>
              <pre className="import-sample"><code>{SAMPLE}</code></pre>
              <button type="button" className="import-action" onClick={() => { setJson(SAMPLE); setError(null); }}>
                Use this sample
              </button>
            </section>

            <fieldset className="import-source highlight">
              <legend>From bookmarklet capture</legend>
              <p>
                Setup once: open{' '}
                <a href="http://127.0.0.1:3003/bookmarklet" target="_blank" rel="noreferrer">
                  <code>http://127.0.0.1:3003/bookmarklet</code>
                </a>{' '}
                and drag the <strong>Capture to Holdr</strong> link to your bookmarks bar. Then on any broker tab where
                you&apos;re already logged in, click the bookmark to send the positions to the local bridge. Holdr never
                opens a second window. Requires the <code>portfolio-bridge</code> sidecar to be running. The holdings go
                into the account and date chosen above.
              </p>
              <div className="import-source-row">
                <label className="import-field">
                  Broker
                  <select value={broker} onChange={(e) => setBroker(e.target.value as typeof broker)}>
                    {BROKERS.map((b) => (
                      <option key={b.key} value={b.key}>{b.name}</option>
                    ))}
                  </select>
                </label>
                <button type="button" className="import-action" disabled={busy} onClick={() => { void pullFromBookmarklet(); }}>
                  {pullingBookmarklet
                    ? 'Loading capture\u2026'
                    : `Pull from last ${BROKERS.find((b) => b.key === broker)?.name} bookmarklet capture`}
                </button>
              </div>
            </fieldset>

            <fieldset className="import-source">
              <legend>Pull from broker</legend>
              <p>
                Opens a real Firefox window so you can log in. Cookies persist between pulls. Requires
                the <code>portfolio-bridge</code> sidecar to be running (see <code>apps/portfolio-bridge/README.md</code>).
                The holdings go into the account and date chosen above.
              </p>
              <div className="import-source-row">
                <label className="import-field">
                  Broker
                  <select value={broker} onChange={(e) => setBroker(e.target.value as typeof broker)}>
                    {BROKERS.map((b) => (
                      <option key={b.key} value={b.key}>{b.name}</option>
                    ))}
                  </select>
                </label>
                <button type="button" className="import-action" disabled={busy} onClick={() => { void pullFromBroker(); }}>
                  {pullingBroker ? 'Waiting for login & extracting…' : `Pull positions from ${BROKERS.find((b) => b.key === broker)?.name}`}
                </button>
              </div>
            </fieldset>

            <fieldset className="import-source">
              <legend>Sync activity (last 90 days)</legend>
              <p>
                Pulls trades and typed cash movements from the broker&apos;s activity page. Dividends, transfers,
                contributions and bank movements go to the cash ledger, never the position transaction list. Pulling
                again is safe: rows already imported show as <em>already imported</em> and are not added twice. Each row
                goes to the account its number matches.
              </p>
              <div className="import-source-row">
                <label className="import-field">
                  Broker
                  <select value={broker} onChange={(e) => setBroker(e.target.value as typeof broker)}>
                    {BROKERS.map((b) => (
                      <option key={b.key} value={b.key}>{b.name}</option>
                    ))}
                  </select>
                </label>
                <label className="import-field">
                  <input type="checkbox" checked={importSweep} onChange={(e) => setImportSweep(e.target.checked)} />
                  Import sweep reinvestments
                </label>
                <button type="button" className="import-action" disabled={busy} onClick={() => { void pullActivity(); }}>
                  {pullingActivity ? 'Waiting for login & extracting activity…' : 'Pull activity'}
                </button>
              </div>
              <p className="import-source-note">
                Sweep reinvestments are money-market buys (FDRXX, SPAXX) the broker makes with idle cash; they are left
                out unless you tick the box.
              </p>
            </fieldset>
          </Disclosure>

          {/* The routes fold under Advanced; their results never do (D5): each stays in view, with its counts and its one
            * action, when the fold is closed. */}
          {bridgeError ? <div className="error import-error" role="alert">{bridgeError}</div> : null}

          {activity ? (
            <ActivityPreviewView
              activity={activity}
              include={activityInclude}
              setInclude={setActivityInclude}
              committed={activityCommitted}
              committing={activityCommitting}
              onCommit={() => { void commitActivity(); }}
            />
          ) : null}

          {sections ? (
            <section className="preview import-sections" aria-label="Accounts found">
              <p className="import-sections-intro">
                <strong>{count(sections.length, 'account', 'accounts')} found.</strong> Each maps to an account on its
                own: check the suggestion, change it if it&apos;s wrong, then import each one. A symbol in two of them
                is not added twice, since each goes to a different account.
              </p>
              {sections.map((sec) => {
                const assignedId = sectionAssignments[sec.section] ?? '';
                const isIncluded = sectionInclude[sec.section] ?? false;
                const committedCount = committedSections[sec.section];
                const isCommitted = committedCount != null;
                const assigned = accounts.find((a) => a.id === assignedId);
                const suggested = sec.suggestion ? accounts.find((a) => a.id === sec.suggestion?.accountId) : undefined;
                return (
                  <fieldset
                    key={sec.section}
                    className={`import-section${isIncluded ? '' : ' is-left-out'}${isCommitted ? ' is-imported' : ''}`}
                  >
                    <legend>
                      <label className="import-section-include">
                        <input
                          type="checkbox"
                          checked={isIncluded}
                          disabled={isCommitted}
                          onChange={(e) => setSectionInclude((p) => ({ ...p, [sec.section]: e.target.checked }))}
                        />
                        {sec.section}
                      </label>
                    </legend>
                    <div className="import-section-map">
                      <label className="import-section-account">
                        Map to account
                        <select
                          value={assignedId}
                          disabled={isCommitted}
                          onChange={(e) => setSectionAssignments((p) => ({ ...p, [sec.section]: e.target.value }))}
                        >
                          <option value="">Choose an account</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>{accountIdentity(a)}</option>
                          ))}
                        </select>
                      </label>
                      <p className="import-section-suggestion">
                        {sec.suggestion ? (
                          <>Suggested: <strong>{suggested ? accountIdentity(suggested) : sec.suggestion.accountName}</strong> ({Math.round(sec.suggestion.confidence * 100)}% match)</>
                        ) : 'No confident match: choose the account.'}
                      </p>
                    </div>
                    <p className="import-section-counts">
                      {count(sec.transactions.length, 'position', 'positions')} · {sec.rejected.length} skipped
                    </p>
                    {sec.rejected.length > 0 ? (
                      <Disclosure className="import-section-skipped" summary={`Why ${count(sec.rejected.length, 'row was', 'rows were')} skipped`}>
                        <ul>
                          {sec.rejected.map((r, i) => (
                            <li key={i}>
                              <code>{r.row.Symbol ?? r.row.symbol ?? '(?)'}</code>: {r.reason}
                            </li>
                          ))}
                        </ul>
                      </Disclosure>
                    ) : null}
                    {sec.transactions.length > 0 ? (
                      <ul className="import-section-positions">
                        {sec.transactions.map((t, i) => (
                          <li key={t.id ?? i}>
                            <strong>{t.symbol}</strong>
                            <span className="muted">{t.quantity} @ {formatCurrency(t.pricePerUnit, t.currency)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="import-section-actions">
                      {isCommitted ? (
                        <p className="import-done" role="status">
                          Imported {count(committedCount, 'transaction', 'transactions')}{assigned ? ` into ${accountIdentity(assigned)}` : ''}
                        </p>
                      ) : (
                        <button
                          type="button"
                          className="commit"
                          disabled={busy || !isIncluded || !assignedId || sec.transactions.length === 0}
                          onClick={() => { void commitSection(sec); }}
                        >
                          Import {sec.transactions.length} into {assigned ? accountIdentity(assigned) : 'the chosen account'}
                        </button>
                      )}
                    </div>
                  </fieldset>
                );
              })}
            </section>
          ) : null}

          {preview && preview.source ? renderPreview(preview) : null}
        </section>
      ) : (
        <section className="nav-statement-import" aria-label="A broker statement (PDF)">
          <p className="nav-statement-intro">
            Choose a Charles Schwab statement. Holdr reads the account value on it and shows it to you first; it is saved
            only when you import it into an account.
          </p>
          <div className="nav-statement-upload-row">
            <label className="nav-statement-file">
              Statement PDF
              <input
                type="file"
                accept="application/pdf,.pdf"
                disabled={navBusy}
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setNavFile(file);
                  setNavPreview(null);
                  setNavAccountId('');
                  setNavCommit(null);
                  setNavError(null);
                }}
              />
            </label>
            <button
              type="button"
              className="import-action"
              disabled={!navFile || navBusy}
              onClick={() => { void previewNavStatement(); }}
            >
              {navBusy && !navPreview ? 'Reading statement…' : 'Preview statement'}
            </button>
          </div>

          {navError ? <div className="error nav-statement-error" role="alert">{navError}</div> : null}

          {navPreview ? (
            <div className="nav-statement-preview" aria-live="polite">
              <div className="nav-statement-summary">
                <div><span>Broker</span><strong>Charles Schwab</strong></div>
                <div><span>Statement period</span><strong>{navPreview.statement.statementPeriodStart} to {navPreview.statement.statementPeriodEnd}</strong></div>
                <div><span>Account value</span><strong>{formatCurrency(navPreview.statement.nav, navPreview.statement.currency)}</strong></div>
                <div><span>As of</span><strong>{navPreview.statement.observedAt}</strong></div>
                <div><span>Statement account</span><strong>***{navPreview.statement.accountLast4}</strong></div>
                <div><span>Document</span><strong>{navPreview.source.documentHash.slice(0, 12)}…</strong></div>
              </div>

              {navPreview.accountMatches.length === 1 ? (
                <div className="nav-statement-match">
                  Exact account-number match:{' '}
                  <strong>{accountIdentity(accounts.find((account) => account.id === navPreview.accountMatches[0].id) ?? navPreview.accountMatches[0])}</strong>.
                  Confirm it below.
                </div>
              ) : navPreview.accountMatches.length === 0 ? (
                <div className="nav-statement-warning">
                  No stored account number matches ***{navPreview.statement.accountLast4}. Choose the account yourself; Holdr will not guess.
                </div>
              ) : (
                <div className="nav-statement-warning">
                  Several stored accounts match ***{navPreview.statement.accountLast4}. Choose the one this statement is for.
                </div>
              )}

              <div className="nav-statement-commit-row">
                <label>
                  Import into account
                  <select
                    value={navAccountId}
                    disabled={navBusy || navCommit != null}
                    onChange={(event) => {
                      setNavAccountId(event.target.value);
                      setNavCommit(null);
                    }}
                  >
                    <option value="">Choose an account</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>{accountIdentity(account)}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="commit"
                  disabled={!navAccountId || navBusy || navCommit != null}
                  onClick={() => { void commitNavStatement(); }}
                >
                  {navBusy ? 'Importing…' : 'Import statement value'}
                </button>
              </div>

              {navAccount ? (
                <p className="import-destination">
                  The statement&apos;s value goes into <span className="import-destination-account">{accountIdentity(navAccount)}</span>.
                </p>
              ) : null}

              {navCommit ? (
                <div className="nav-statement-success" role="status">
                  {navCommit.inserted ? 'Imported' : 'Already imported'} {formatCurrency(navCommit.observation.nav, navPreview.statement.currency)} as of {navCommit.observation.observedAt}{navAccount ? ` into ${accountIdentity(navAccount)}` : ''}.
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      )}
    </fieldset>
  );
}

/**
 * Convert Fidelity's "Mon-DD-YYYY" date display into the ISO YYYY-MM-DD
 * the API expects on POST /accounts/:id/transactions. Returns null if
 * the input doesn't match the expected shape so the caller can fall
 * back to the raw string (which will then 400 on the server with a
 * helpful "date must be YYYY-MM-DD" — better than silently committing
 * a bogus date).
 */
function parseFidelityDateForCommit(s: string): string | null {
  const months: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const m = s.trim().match(/^([A-Z][a-z]{2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const mm = months[m[1]];
  if (!mm) return null;
  const dd = m[2].padStart(2, '0');
  return `${m[3]}-${mm}-${dd}`;
}

function navPdfHeaders(file: File): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/pdf' };
  if (/^[\x20-\x7e]+$/.test(file.name)) headers['X-File-Name'] = file.name;
  return headers;
}

interface ActivityPreviewViewProps {
  activity: ActivityImportResponse;
  include: Record<string, boolean>;
  setInclude: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  committed: Set<string>;
  committing: boolean;
  onCommit: () => void;
}

/**
 * One-row-per-activity table. Status drives both the checkbox-enabled
 * state and a colored label, with its reason in words beside it (never a
 * tooltip). Quiet for skip-cash (the bulk of rows in a typical pull) and
 * loud for new/duplicate.
 */
function ActivityPreviewView({
  activity,
  include,
  setInclude,
  committed,
  committing,
  onCommit,
}: ActivityPreviewViewProps) {
  const accountById = new Map(activity.accounts.map((a) => [a.id, a]));
  const newRowCount = activity.rows.filter(
    (r) => (r.status.kind === 'new' || r.status.kind === 'new-cash')
      && r.fingerprint
      && include[r.fingerprint],
  ).length;
  const committedCount = committed.size;
  const remainingNew = newRowCount - committedCount;

  return (
    <section className="preview import-activity" aria-label="Activity preview">
      <div className="import-activity-head">
        <h3>Activity preview</h3>
        <Chip kind="new"        n={activity.summary.new}           label="new" />
        <Chip kind="new"        n={activity.summary.newCash}       label="new cash event" />
        <Chip kind="duplicate"  n={activity.summary.duplicates}    label="already imported" />
        <Chip kind="duplicate"  n={activity.summary.duplicateCash} label="cash already imported" />
        <Chip kind="skip-cash"  n={activity.summary.skippedCash}   label="skipped cash" />
        <Chip kind="skip-sweep" n={activity.summary.skippedSweep}  label="skipped sweep" />
        <Chip kind="reject"     n={activity.summary.rejected}      label="rejected" />
        <Chip kind="reject"     n={activity.summary.rejectedCash}  label="invalid cash" />
        <Chip kind="reject"     n={activity.summary.noAccountMatch} label="no account match" />
        <Chip kind="ambiguous"  n={activity.summary.ambiguousAccountMatch} label="ambiguous account" />
        {activity.source.sourceUrl ? (
          <p className="import-activity-source"><code>{activity.source.sourceUrl}</code></p>
        ) : null}
      </div>

      <div className="import-activity-scroll">
        {/* Explicit table roles: on a phone the rows stack into labelled blocks (investing-entry.css), and a change of
          * display must not cost a screen reader the table. Each value carries its column's name as data-label. */}
        <table className="holdings import-activity-table" role="table">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" className="import-activity-check"><span className="visually-hidden">Include</span></th>
              <th role="columnheader">Date</th>
              <th role="columnheader">Account</th>
              <th role="columnheader">Description</th>
              <th role="columnheader">Action</th>
              <th role="columnheader" className="num">Qty</th>
              <th role="columnheader" className="num">Price</th>
              <th role="columnheader" className="num">Amount</th>
              <th role="columnheader">Status</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {activity.rows.map((row, i) => {
              const fp = row.fingerprint ?? '';
              const isNew = row.status.kind === 'new' || row.status.kind === 'new-cash';
              const isCommitted = fp ? committed.has(fp) : false;
              const checked = isNew && fp ? !!include[fp] : false;
              const acc = row.status.accountId ? accountById.get(row.status.accountId) : undefined;
              return (
                <tr
                  key={fp || `row-${i}`}
                  role="row"
                  className={`${isNew && !checked ? 'is-left-out' : ''}${isCommitted ? ' is-imported' : ''}`.trim() || undefined}
                >
                  <td role="cell" className="import-activity-check" data-label={isNew && fp ? 'Include' : undefined}>
                    {isNew && fp ? (
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isCommitted}
                        aria-label={`Include ${row.description}`}
                        onChange={(e) =>
                          setInclude((prev) => ({ ...prev, [fp]: e.target.checked }))
                        }
                      />
                    ) : null}
                  </td>
                  <td role="cell" className="muted import-activity-nowrap" data-label="Date">{row.date}</td>
                  <td role="cell" className="muted import-activity-account" data-label="Account">
                    {acc ? accountIdentity(acc) : row.accountLabel}
                  </td>
                  <td role="cell" className="import-activity-description" data-label="Description">
                    {row.instrumentType === 'option' && row.symbol ? (
                      <>
                        <strong>{formatOptionSymbol(row.symbol)}</strong>
                        <br />
                        <span className="muted">{row.description}</span>
                      </>
                    ) : row.description}
                  </td>
                  <td role="cell" data-label="Action">{formatActivityAction(row.action)}</td>
                  <td role="cell" className="num" data-label="Qty">
                    {row.quantity != null
                      ? `${row.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}${row.instrumentType === 'option' ? ' contracts' : ''}`
                      : '—'}
                  </td>
                  <td role="cell" className="num" data-label="Price">
                    {row.pricePerUnit != null
                      ? `${formatCurrency(row.pricePerUnit, 'USD')}${row.instrumentType === 'option' ? ' premium' : ''}`
                      : '—'}
                  </td>
                  <td role="cell" className="num muted" data-label="Amount">{row.amount}</td>
                  <td role="cell" data-label="Status">
                    <ActivityStatusBadge status={row.status} committed={isCommitted} />
                  </td>
                </tr>
              );
            })}
            {activity.rows.length === 0 ? (
              <tr role="row"><td role="cell" colSpan={9} className="muted import-activity-empty">
                No activity rows in the past 90 days.
              </td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="import-activity-actions">
        <button
          type="button"
          className="commit"
          disabled={committing || remainingNew === 0}
          onClick={onCommit}
        >
          {committing
            ? `Importing… (${committedCount}/${newRowCount})`
            : remainingNew > 0
              ? `Import ${remainingNew} new record${remainingNew === 1 ? '' : 's'}`
              : committedCount > 0
                ? `Imported ${committedCount}`
                : 'Nothing new to import'}
        </button>
        {committedCount > 0 ? (
          <p className="import-done" role="status">{committedCount} imported</p>
        ) : null}
      </div>
    </section>
  );
}

function Chip({ kind, n, label }: { kind: string; n: number; label: string }) {
  if (n === 0) return null;
  return <span className={`import-chip kind-${kind}`}>{n} {label}</span>;
}

/** A row's status, and why, in words: the reason is text beside the status, not a tooltip. */
function ActivityStatusBadge({
  status,
  committed,
}: {
  status: ActivityRowStatus;
  committed: boolean;
}) {
  const shown = (kind: string, text: string, reason?: string) => (
    <span className={`import-status kind-${kind}`}>
      <span className="import-status-label">{text}</span>
      {reason ? <span className="import-status-reason">{reason}</span> : null}
    </span>
  );
  if (committed) return shown('imported', 'Imported');
  switch (status.kind) {
    case 'new':
      return shown('new', 'new');
    case 'duplicate':
      return shown('duplicate', 'already imported');
    case 'new-cash':
      return shown('new', 'new cash');
    case 'duplicate-cash':
      return shown('duplicate', 'cash imported');
    case 'no-account-match':
      return shown('ambiguous', 'no account match', `No account in Holdr ends in ***${status.accountLast4 ?? '????'}.`);
    case 'ambiguous-account-match':
      return shown('ambiguous', 'ambiguous account', `More than one account ends in ***${status.accountLast4 ?? '????'}.`);
    case 'skip-cash':
      return shown('skip', 'skipped (cash)', status.reason);
    case 'skip-sweep':
      return shown('skip', 'skipped (sweep)', status.reason);
    case 'reject-incomplete':
      return shown('reject', 'incomplete', status.reason);
    case 'reject-option-ledger':
      return shown('reject', 'invalid option ledger', status.reason);
    case 'reject-cash-incomplete':
      return shown('reject', 'invalid cash', status.reason);
    case 'reject-unknown':
      return shown('reject', 'unknown', status.reason);
    default:
      return null;
  }
}

function formatActivityAction(action: string): string {
  const labels: Record<string, string> = {
    BUY_TO_OPEN: 'Buy to open',
    SELL_TO_OPEN: 'Sell to open',
    BUY_TO_CLOSE: 'Buy to close',
    SELL_TO_CLOSE: 'Sell to close',
  };
  return labels[action] ?? action;
}
