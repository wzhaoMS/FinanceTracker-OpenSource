import type { ReactNode } from 'react';
import { formatRowAmount, kindLabel, longDate } from '../spendingFormat';
import type { BindingScope, Candidate, DecisionAction, OwnerState, ReviewItem, RowView, SetSummary, TxnValues } from './ownerApi';
import { scopeTextById } from './syncFormat';
import { actionText, decisionText } from './syncText';

/** One decision the owner can pick for an item: the action and the transaction or card it names. */
export interface DecisionOption {
  key: string;
  action: DecisionAction;
  transactionId: string | null;
  cardScopeId: string | null;
  label: string;
}

export function optionKey(action: DecisionAction, transactionId: string | null, cardScopeId: string | null): string {
  return `${action}|${transactionId ?? ''}|${cardScopeId ?? ''}`;
}

function candidateLabel(candidate: Candidate, currency: string): string {
  return `${candidate.description} · ${formatRowAmount(candidate.amountMinor, currency)} · ${longDate(candidate.transactionDate)}`;
}

/**
 * The known cards a set's rows may be put on: its binding's, or for a file set (no binding, X18) those of every binding
 * of its card account, as Holdr checks them.
 */
export function knownScopesFor(set: Pick<SetSummary, 'bindingId' | 'cardAccountRef'>, state: OwnerState | null): BindingScope[] {
  const bindings = (state?.bindings ?? []).filter((binding) => (set.bindingId !== null
    ? binding.bindingId === set.bindingId
    : binding.cardAccountRef === set.cardAccountRef && binding.status !== 'retired'));
  return bindings.flatMap((binding) => binding.scopes.filter((scope) => scope.kind === 'known' && scope.status === 'active'));
}

/**
 * The row a decision is about: the candidate it names, or for a correction the item's own row, which its stored identity
 * names, so the decision names none (E1b `ck_rvw_draft_shape`: only `same-transaction` and `attribute-and-link` carry a
 * transaction).
 */
function decisionTarget(entry: ReviewItem, action: DecisionAction, transactionId: string | null): Candidate | null {
  if (transactionId !== null) return entry.candidates.find((candidate) => candidate.transactionId === transactionId) ?? null;
  return action === 'accept-correction' ? entry.candidates[0] ?? null : null;
}

/** A decision on this item as the owner reads it, worded by what it does to its target (if it names one). */
export function decisionLabel(entry: ReviewItem, action: DecisionAction, transactionId: string | null): string {
  const target = decisionTarget(entry, action, transactionId);
  return decisionText(action, entry.category, entry.observation?.status ?? null, target?.status ?? null);
}

/**
 * The decisions offered for an item: only the actions Holdr allows, each with
 * the one candidate or card it needs. A candidate on a different known card
 * is never offered for linking. Amounts are in the set's currency.
 */
export function decisionOptions(entry: ReviewItem, knownScopes: readonly BindingScope[], state: OwnerState | null, currency = 'USD'): DecisionOption[] {
  const options: DecisionOption[] = [];
  const several = entry.candidates.length > 1;
  for (const action of entry.allowedActions) {
    const base = actionText(action, entry.category);
    if (action === 'same-transaction' || action === 'attribute-and-link') {
      for (const candidate of entry.candidates) {
        if (candidate.blockedReason !== null) continue;
        if (action === 'attribute-and-link' && (candidate.scopeKind === 'known' || !entry.observation)) continue;
        const cardScopeId = action === 'attribute-and-link' ? entry.observation?.cardScopeId ?? null : null;
        const target = action === 'attribute-and-link' ? ` (${scopeTextById(state, cardScopeId)})` : '';
        const label = decisionLabel(entry, action, candidate.transactionId);
        options.push({
          key: optionKey(action, candidate.transactionId, cardScopeId),
          action,
          transactionId: candidate.transactionId,
          cardScopeId,
          label: several ? `${label}${target}: ${candidateLabel(candidate, currency)}` : `${label}${target}`,
        });
      }
    } else if (action === 'attribute') {
      for (const scope of knownScopes) {
        options.push({
          key: optionKey(action, null, scope.cardScopeId),
          action,
          transactionId: null,
          cardScopeId: scope.cardScopeId,
          label: `${base}: ${scopeTextById(state, scope.cardScopeId)}`,
        });
      }
    } else {
      const label = action === 'accept-correction' ? decisionLabel(entry, action, null) : base;
      options.push({ key: optionKey(action, null, null), action, transactionId: null, cardScopeId: null, label });
    }
  }
  return options;
}

export function Facts({ children }: { children: ReactNode }) {
  return <dl className="spending-detail-fields sync-facts">{children}</dl>;
}

/** One observed row, in its set's currency; a file import's row carries the card account's file-import scope and the file's own key. */
export function ObservationFacts({ row, state, fromFile = false, currency = 'USD' }: {
  row: RowView;
  state: OwnerState | null;
  fromFile?: boolean;
  currency?: string;
}) {
  return (
    <div className="sync-observation">
      <span className="sync-caption">{fromFile ? `What the file import had (row ${row.rowIndex + 1})` : `What the extension sent (row ${row.rowIndex + 1})`}</span>
      <Facts>
        <dt>Description</dt>
        <dd>{row.description}{row.merchant ? ` · ${row.merchant}` : ''}</dd>
        <dt>Amount</dt>
        <dd className="num">
          {formatRowAmount(row.amountMinor, currency)}
          {row.originalAmountMinor !== null && row.originalCurrency ? ` (${formatRowAmount(row.originalAmountMinor, row.originalCurrency)})` : ''}
          {' · '}{kindLabel(row.kind)}
        </dd>
        <dt>Dates</dt>
        <dd>{longDate(row.transactionDate)}{row.postedDate ? `, posted ${longDate(row.postedDate)}` : ', pending'}</dd>
        <dt>Card</dt>
        <dd>{scopeTextById(state, row.cardScopeId, fromFile ? 'legacy' : undefined)}</dd>
        <dt>Identity</dt>
        <dd>
          {fromFile
            ? 'The file import\'s key for the row: the issuer\'s reference, or its date, amount and description'
            : row.identity === 'stable' ? 'The bank\'s own id' : 'No stable id: known only within this capture'}
        </dd>
      </Facts>
    </div>
  );
}

export function CandidateFacts({ candidate, state, title, currency = 'USD' }: { candidate: Candidate; state: OwnerState | null; title: string; currency?: string }) {
  return (
    <div className={`sync-candidate${candidate.blockedReason ? ' blocked' : ''}`} data-candidate={candidate.transactionId}>
      <span className="sync-caption">{title}</span>
      <Facts>
        <dt>Description</dt>
        <dd>{candidate.description}{candidate.merchant ? ` · ${candidate.merchant}` : ''}</dd>
        <dt>Amount</dt>
        <dd className="num">{formatRowAmount(candidate.amountMinor, currency)} · {kindLabel(candidate.kind)} · {candidate.status}</dd>
        <dt>Dates</dt>
        <dd>{longDate(candidate.transactionDate)}{candidate.postedDate ? `, posted ${longDate(candidate.postedDate)}` : ''}</dd>
        <dt>Card</dt>
        <dd>{scopeTextById(state, candidate.cardScopeId, candidate.scopeKind)}</dd>
        <dt>From</dt>
        <dd>{candidate.sourceKind === 'file' ? 'An offline file import' : 'The extension, earlier'}</dd>
        <dt>Matches on</dt>
        <dd>{candidate.matchedOn.join(', ')}</dd>
        {candidate.userCategory || candidate.notes ? (
          <>
            <dt>Your edits</dt>
            <dd>{[candidate.userCategory ? `category ${candidate.userCategory}` : null, candidate.notes ? `notes: ${candidate.notes}` : null].filter(Boolean).join('; ')} (kept)</dd>
          </>
        ) : null}
      </Facts>
      {candidate.blockedReason === 'different-known-cards' ? (
        <p className="sync-expiry warn">Not offered as the same transaction: it is on a different known card. Two different cards are never merged.</p>
      ) : null}
    </div>
  );
}

/** One side of a plan effect, in its set's currency; legacyScopes are the card accounts' file-import scopes, which no binding lists. */
export function txnSummary(values: TxnValues | null, state: OwnerState | null, legacyScopes: ReadonlySet<string> = new Set(), currency = 'USD'): string {
  if (!values) return '—';
  const scope = !values.cardScopeId ? 'no card'
    : scopeTextById(state, values.cardScopeId, legacyScopes.has(values.cardScopeId) ? 'legacy' : undefined);
  return `${values.description} · ${formatRowAmount(values.amountMinor, currency)} · ${values.status} · ${longDate(values.transactionDate)} · ${scope}`;
}
