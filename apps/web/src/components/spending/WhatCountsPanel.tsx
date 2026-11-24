import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CARD_ASSET_CATEGORY,
  CARD_METALS_MERCHANT_CLASSES,
  cardCurrencyExponent,
  type CardMetalsMerchantClass,
  type CardTransactionView,
} from '@finance-tracker/shared';

import { Disclosure } from '../Disclosure';
import { ChevronRight } from '../icons';
import { Spinner, TitleWithSpinner } from '../Spinner';
import { useUpdatingMark } from '../useUpdatingMark';
import {
  apiErrorMessage,
  createSpendingRule,
  isRulePreviewStale,
  previewSpendingRule,
  revokeSpendingRule,
  updateCardTransaction,
  type AssetPurchaseView,
  type AssetSuggestionView,
  type SpendingAccountingResponse,
  type SpendingRuleInput,
  type SpendingRulePreview,
} from './spendingApi';
import { formatMinor, formatRowAmount, longDate, shortDate } from './spendingFormat';
import {
  MERCHANT_CLASS_LABELS,
  TIER_LABELS,
  accountingFor,
  defaultRuleMinimum,
  exclusionSourceText,
  notMetalsCategory,
  pendingNoteText,
  queueEffectText,
  ruleText,
  rulePreviewText,
  sameRuleInput,
  suggestionReason,
  whatCountsStatement,
  type StatementRow,
} from './whatCounts';
import './whatCounts.css';

/** Weaker suggestions wait behind this many shown ones. */
const SHOWN_SUGGESTIONS = 12;

interface Props {
  accounting: SpendingAccountingResponse | null;
  currency: string;
  /** The period shown, in a sentence: "October 2026", "the last 90 days". */
  periodPhrase: string;
  loading: boolean;
  /**
   * What counts couldn't be read for this view, and none of an earlier read is shown: its error, said in place of the
   * panel's body, until a read of the view succeeds. Never a panel that goes silently.
   */
  failure?: string | null;
  /** What counts' own read failed (the other panels were read): its Try again reads What counts again. */
  onRetry?: () => void;
  writesDisabled: boolean;
  /** A row changed: refresh everything that reads it. */
  onChanged: (row?: CardTransactionView) => void;
  onOpen: (id: string) => void;
}

/**
 * What counts as spending in the view. Folded, it is one line: how many charges wait for the owner's word, with Review
 * (the page only places the panel; the panel keeps its own compact state). Open, it shows first the charges that may be
 * precious metals waiting for the owner's word, then the card activity as a statement in two groups, counted as
 * spending and not, each line a label and its signed amount, adding up to all card activity to the cent, then the
 * owner's rules, folded. Anything that moves focus to the panel (the overview's Excluded chip) opens it. Nothing here
 * changes a total by itself: the owner confirms a row (its category becomes "Precious metals"), keeps it as spending
 * (its category becomes the owner's own), or makes a rule. Its errors stay here, through the refresh that follows a
 * change.
 */
export function WhatCountsPanel(props: Props) {
  const { accounting, currency } = props;
  const entry = accountingFor(accounting?.accounting, currency);
  const suggestions = useMemo(() => (accounting?.suggestions ?? []).filter((item) => item.currency === currency), [accounting, currency]);
  const assets = useMemo(() => (accounting?.assetPurchases ?? []).filter((item) => item.currency === currency), [accounting, currency]);
  const rules = accounting?.rules.items ?? [];
  const activeRules = rules.filter((rule) => rule.revokedAt === null);
  const [open, setOpen] = useState(false);
  // Review asked for the waiting charges: their heading takes focus once it is shown.
  const [reviewing, setReviewing] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showAssets, setShowAssets] = useState(false);
  const ids = useId();
  const queueHead = useRef<HTMLHeadingElement>(null);
  const failure = props.failure ?? null;
  // Read again with the list: what is shown is the last read's, dimmed at once until a moment after the new one lands.
  // A read that failed is not held: its error says what happened.
  const updating = useUpdatingMark(props.loading && accounting !== null, { failed: failure !== null });
  // A failed read read again: nothing is shown to mark, only that it is being read.
  const reading = failure !== null && props.loading;
  const toggle = useRef<HTMLButtonElement>(null);
  /** Its Try again was pressed while focused: once What counts is read and the error goes, focus goes to its title. */
  const retried = useRef(false);
  const retry = (button: HTMLButtonElement) => {
    retried.current = document.activeElement === button;
    props.onRetry?.();
  };
  useLayoutEffect(() => {
    if (failure !== null) return;
    const focus = retried.current;
    retried.current = false;
    // Only once What counts was read (another view, chosen meanwhile, has none yet), and only when the button went with
    // its error and focus fell to the page.
    if (!focus || accounting === null || (document.activeElement !== null && document.activeElement !== document.body)) return;
    toggle.current?.focus();
  }, [failure]);
  useEffect(() => {
    if (!reviewing || !open) return;
    queueHead.current?.focus();
    setReviewing(false);
  }, [reviewing, open]);
  if (failure === null && !entry && suggestions.length === 0) return null;

  /**
   * Saves owner decisions one row at a time and stops at the first refusal. Whatever was saved is refreshed; a
   * refusal says which part did not go through.
   */
  const decide = async (changes: Array<{ id: string; userCategory: string }>) => {
    setBusy(true);
    setError(null);
    let last: CardTransactionView | undefined;
    let saved = 0;
    try {
      for (const change of changes) {
        last = await updateCardTransaction(change.id, { userCategory: change.userCategory });
        saved += 1;
      }
    } catch (reason) {
      const message = apiErrorMessage(reason);
      setError(changes.length > 1 ? `Saved ${saved} of ${changes.length}; the rest were not changed: ${message}` : message);
    } finally {
      setBusy(false);
      if (saved > 0) props.onChanged(last);
    }
  };
  const notMetals = (item: { id: string; category: string }) => {
    const keep = notMetalsCategory(item.category);
    // Uncategorized: the owner picks the category it is, in its details.
    if (keep === null) props.onOpen(item.id);
    else void decide([{ id: item.id, userCategory: keep }]);
  };
  const shown = showAll ? suggestions : suggestions.slice(0, SHOWN_SUGGESTIONS);
  const shownCharges = shown.filter((item) => item.kind === 'purchase');
  const disabled = props.writesDisabled || busy;
  const waiting = suggestions.length;
  const bodyId = `${ids}-body`;

  const queue = waiting > 0 ? (
    <div className="spending-what-counts-queue" role="group" aria-labelledby={`${ids}-queue`}>
      <h4 id={`${ids}-queue`} ref={queueHead} tabIndex={-1}>To confirm ({waiting})</h4>
      <p className="what-counts-lede" data-testid="queue-effect">{queueEffectText(entry, waiting)}</p>
      <p className="spending-muted what-counts-help">
        Card data cannot tell a gold bar from groceries; only you can. Precious metals are an asset purchase: kept out of
        spending, never hidden from your transactions.
      </p>
      <ul className="spending-what-counts-list">
        {shown.map((item) => (
          <SuggestionRow
            key={item.id}
            item={item}
            disabled={disabled}
            onOpen={props.onOpen}
            onConfirm={() => void decide([{ id: item.id, userCategory: CARD_ASSET_CATEGORY }])}
            onNotMetals={() => notMetals(item)}
          />
        ))}
      </ul>
      <div className="spending-what-counts-actions">
        {shownCharges.length > 1 ? (
          <button
            type="button"
            className="spending-button"
            disabled={disabled}
            onClick={() => void decide(shownCharges.map((item) => ({ id: item.id, userCategory: CARD_ASSET_CATEGORY })))}
          >
            {`Confirm all ${shownCharges.length} charges shown as precious metals`}
          </button>
        ) : null}
        {waiting > SHOWN_SUGGESTIONS ? (
          <button type="button" className="spending-link" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
            {showAll ? `Show the first ${SHOWN_SUGGESTIONS}` : `Show all ${waiting}`}
          </button>
        ) : null}
      </div>
      <RuleEditor
        suggestions={suggestions}
        currency={currency}
        installed={accounting?.rules.installed ?? false}
        disabled={disabled}
        onSaved={() => { setError(null); setRulesOpen(true); props.onChanged(); }}
        onError={setError}
      />
    </div>
  ) : null;

  const statement = entry ? whatCountsStatement(entry) : null;
  const assetLines = statement?.notCounted.filter((row) => row.part === 'asset') ?? [];
  const pendingNote = entry ? pendingNoteText(entry) : null;
  const statementBlock = entry && statement ? (
    entry.activity.count === 0 ? (
      <div className="what-counts-statement" data-testid="reconciliation">
        <p className="what-counts-lede">No posted card activity in {props.periodPhrase}.</p>
        {pendingNote ? <p className="spending-muted what-counts-help">{pendingNote}</p> : null}
      </div>
    ) : (
      <div className="what-counts-statement" data-testid="reconciliation">
        {statement.counted.length > 0 ? (
          <div className="what-counts-group" role="group" aria-labelledby={`${ids}-counted`}>
            <h4 id={`${ids}-counted`} className="what-counts-group-head">Counted as spending</h4>
            {statement.counted.map((row) => <StatementLine key={row.key} row={row} currency={currency} />)}
          </div>
        ) : null}
        {statement.notCounted.length > 0 ? (
          <div className="what-counts-group" role="group" aria-labelledby={`${ids}-not-counted`}>
            <h4 id={`${ids}-not-counted`} className="what-counts-group-head">Not counted</h4>
            {assetLines.length > 0 ? (
              <div className="what-counts-part" data-testid="asset-total">
                {assetLines.map((row, index) => (
                  <StatementLine
                    key={row.key}
                    row={row}
                    currency={currency}
                    note={index === 0 ? (
                      <>
                        An asset, not spending
                        {assets.length > 0 ? (
                          <>
                            {' · '}
                            <button
                              type="button"
                              className="spending-link inline"
                              aria-expanded={showAssets}
                              onClick={() => setShowAssets((value) => !value)}
                            >
                              {showAssets ? 'Hide them' : `Show the ${assets.length}`}
                            </button>
                          </>
                        ) : null}
                      </>
                    ) : null}
                  />
                ))}
                {showAssets && assets.length > 0 ? (
                  <AssetList
                    items={assets}
                    rules={rules}
                    disabled={disabled}
                    onOpen={props.onOpen}
                    onNotMetals={(item) => notMetals({ id: item.id, category: item.spendingCategory })}
                  />
                ) : null}
              </div>
            ) : null}
            {statement.notCounted.filter((row) => row.part !== 'asset').map((row) => <StatementLine key={row.key} row={row} currency={currency} />)}
          </div>
        ) : null}
        <p className="what-counts-row what-counts-total" data-row="activity">
          <span className="what-counts-label">All card activity</span>
          {' '}
          <span className="what-counts-figure num">{formatRowAmount(statement.activityMinor, currency)}</span>
        </p>
        {pendingNote ? <p className="spending-muted what-counts-help">{pendingNote}</p> : null}
      </div>
    )
  ) : null;
  // Unknown, never "Nothing to confirm": the error, in place of the folded line and of the open body alike. What counts'
  // own failure carries its own Try again (and says so, as no page error does); the list's is retried from the page.
  const failed = failure !== null ? (
    <p className="overview-error" role={props.onRetry ? 'status' : undefined} data-testid="what-counts-error">
      {`Couldn't read what counts: ${failure}`}
      {props.onRetry ? (
        <>
          {' '}
          {/* Already being read: pressed again, nothing more is asked for. */}
          <button type="button" className="spending-link inline" aria-disabled={props.loading || undefined}
            onClick={(event) => { if (!props.loading) retry(event.currentTarget); }}>
            {props.loading ? <Spinner label="Trying again" testId="what-counts-retrying" /> : 'Try again'}
          </button>
        </>
      ) : null}
    </p>
  ) : null;

  return (
    <section
      className="spending-panel spending-what-counts"
      aria-label="What counts as spending"
      aria-busy={props.loading || busy}
      data-open={open}
      data-updating={updating ? 'true' : undefined}
      onFocus={(event) => { if (event.target === event.currentTarget) setOpen(true); }}
    >
      <header className="spending-panel-head what-counts-head">
        <TitleWithSpinner busy={updating || reading} label={updating ? 'Updating' : 'Reading what counts'}
          testId={updating ? 'what-counts-updating' : 'what-counts-reading'} deferred={!updating}>
          <h3>
            <button
              ref={toggle}
              type="button"
              className="what-counts-toggle"
              aria-expanded={open}
              aria-controls={open ? bodyId : undefined}
              onClick={() => setOpen((value) => !value)}
            >
              <ChevronRight size={18} className="what-counts-chevron" />
              What counts
            </button>
          </h3>
        </TitleWithSpinner>
        <span className="spending-muted what-counts-scope">Which card activity in {props.periodPhrase} counts as spending</span>
      </header>
      {error ? <div className="spending-error" role="alert">{error}</div> : null}
      {open ? (
        <div id={bodyId} className="what-counts-body">
          {failed}
          {queue}
          {statementBlock}
          {activeRules.length > 0 ? (
            <Disclosure summary={`Your rules (${activeRules.length})`} open={rulesOpen} onOpenChange={setRulesOpen} className="what-counts-rules-fold">
              <ul className="spending-what-counts-rules" aria-label="Your rules">
                {activeRules.map((rule) => (
                  <li key={rule.id}>
                    <span>
                      <strong>Your rule:</strong> {ruleText(rule)}
                      <span className="spending-muted">
                        {` · since ${longDate(rule.createdAt.slice(0, 10))} · takes out ${rule.covers.purchases} `
                          + `${rule.covers.purchases === 1 ? 'charge' : 'charges'} (${formatMinor(rule.covers.netMinor, rule.currency)})`}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="spending-button ghost"
                      disabled={disabled}
                      onClick={() => {
                        setBusy(true);
                        setError(null);
                        revokeSpendingRule(rule.id)
                          .then(() => props.onChanged())
                          .catch((reason: unknown) => setError(apiErrorMessage(reason)))
                          .finally(() => setBusy(false));
                      }}
                    >
                      Remove rule
                    </button>
                  </li>
                ))}
              </ul>
            </Disclosure>
          ) : null}
        </div>
      ) : failed ?? (
        <p className="what-counts-compact" data-testid="what-counts-compact">
          {waiting > 0 ? (
            <>
              <strong className="what-counts-waiting">To confirm ({waiting})</strong>
              {' '}
              <span>Possibly precious metals, counted as spending until you decide.</span>
              {' '}
              <button
                type="button"
                className="spending-button"
                aria-label={`Review ${waiting} to confirm`}
                onClick={() => { setOpen(true); setReviewing(true); }}
              >
                Review
              </button>
            </>
          ) : (
            <span className="what-counts-settled">Nothing to confirm</span>
          )}
        </p>
      )}
    </section>
  );
}

/** A statement line: its label (and a note under it), and its signed amount at the end. */
function StatementLine({ row, currency, note }: { row: StatementRow; currency: string; note?: ReactNode }) {
  return (
    <p className="what-counts-row" data-row={row.key}>
      <span className="what-counts-label">
        {row.label}
        {note ? <>{' '}<span className="what-counts-note">{note}</span></> : null}
      </span>
      {' '}
      <span className="what-counts-figure num">{formatRowAmount(row.amountMinor, currency)}</span>
    </p>
  );
}

function SuggestionRow(props: {
  item: AssetSuggestionView;
  disabled: boolean;
  onOpen: (id: string) => void;
  onConfirm: () => void;
  onNotMetals: () => void;
}) {
  const { item } = props;
  const keep = notMetalsCategory(item.category);
  return (
    <li className={`spending-what-counts-item tier-${item.tier}`} data-suggestion-id={item.id}>
      <button type="button" className="spending-what-counts-open" onClick={() => props.onOpen(item.id)}>
        <span className="spending-row-date num">{shortDate(item.transactionDate)}</span>
        <span className="spending-what-counts-text">
          <span className="spending-row-merchant">{item.merchantName}</span>
          <span className="spending-row-description">{suggestionReason(item)}</span>
        </span>
        <span className="spending-badge">{TIER_LABELS[item.tier]}</span>
        <span className={`num spending-what-counts-amount${item.amountMinor < 0 ? ' credit' : ''}`}>
          {formatRowAmount(item.amountMinor, item.currency)}
          {item.followingRefundIds.length > 0 ? (
            <span className="spending-row-original">{`refunded ${formatRowAmount(item.followingRefundsMinor, item.currency)}`}</span>
          ) : null}
        </span>
      </button>
      <span className="spending-what-counts-buttons">
        <button type="button" className="spending-button" disabled={props.disabled} onClick={props.onConfirm}>
          {item.kind === 'refund' ? 'Metals refund' : 'Precious metals'}
        </button>
        <button
          type="button"
          className="spending-button ghost"
          disabled={props.disabled}
          title={keep ? `Keep it as spending, under ${keep}` : 'Keep it as spending: pick its category in its details'}
          onClick={props.onNotMetals}
        >
          Not metals
        </button>
      </span>
    </li>
  );
}

function AssetList(props: {
  items: AssetPurchaseView[];
  rules: SpendingAccountingResponse['rules']['items'];
  disabled: boolean;
  onOpen: (id: string) => void;
  onNotMetals: (item: AssetPurchaseView) => void;
}) {
  return (
    <ul className="spending-what-counts-list" aria-label="Precious metals, not counted">
      {props.items.map((item) => (
        <li key={item.id} className="spending-what-counts-item" data-asset-id={item.id}>
          <button type="button" className="spending-what-counts-open" onClick={() => props.onOpen(item.id)}>
            <span className="spending-row-date num">{shortDate(item.transactionDate)}</span>
            <span className="spending-what-counts-text">
              <span className="spending-row-merchant">{item.merchantName}</span>
              <span className="spending-row-description">{`Precious metals · ${exclusionSourceText(item.exclusion, props.rules)}`}</span>
            </span>
            <span className={`num spending-what-counts-amount${item.amountMinor < 0 ? ' credit' : ''}`}>
              {formatRowAmount(item.amountMinor, item.currency)}
            </span>
          </button>
          <span className="spending-what-counts-buttons">
            {/* A refund follows its purchase: the owner decides the purchase. */}
            {item.exclusion.source !== 'paired-refund' ? (
              <button type="button" className="spending-button ghost" disabled={props.disabled} onClick={() => props.onNotMetals(item)}>
                Not metals
              </button>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Make it a rule": a class and a minimum, its preview over every card and date, then the owner's word. The owner makes
 * exactly the rule they saw: a preview is kept with the input it was asked for and shown only while that input is the
 * one on screen; an answer to an older request is dropped; "Make this my rule" waits for a current preview, and sends
 * its match, so the API refuses the rule if what it takes out changed since.
 */
function RuleEditor(props: {
  suggestions: AssetSuggestionView[];
  currency: string;
  installed: boolean;
  disabled: boolean;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const classes = useMemo(() => CARD_METALS_MERCHANT_CLASSES.filter((item) =>
    props.suggestions.some((suggestion) => suggestion.kind === 'purchase' && suggestion.merchantClass === item)), [props.suggestions]);
  const [open, setOpen] = useState(false);
  const [merchantClass, setMerchantClass] = useState<CardMetalsMerchantClass | null>(null);
  const [minimum, setMinimum] = useState('');
  const [preview, setPreview] = useState<{ input: SpendingRuleInput; result: SpendingRulePreview } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  // Each preview request's ticket: an answer counts only while its ticket is the latest, and any edit takes a new one.
  const generation = useRef(0);
  if (classes.length === 0) return null;
  const chosen = merchantClass ?? classes[0];
  const scale = 10 ** cardCurrencyExponent(props.currency);
  const minimumMinor = minimum === '' ? defaultRuleMinimum(props.suggestions, chosen, props.currency) : Math.round(Number(minimum) * scale);
  const valid = Number.isSafeInteger(minimumMinor) && minimumMinor >= 1;
  const input: SpendingRuleInput = { merchantClass: chosen, currency: props.currency, minAmountMinor: minimumMinor };
  // Only a preview of the input on screen says what this rule would do.
  const current = preview !== null && sameRuleInput(preview.input, input) ? preview : null;
  /** An edit: whatever was previewed or is being previewed is no longer this rule's. */
  const edited = () => {
    generation.current += 1;
    setPreview(null);
    setPreviewing(false);
  };
  const close = () => {
    edited();
    setOpen(false);
  };
  if (!open) {
    return (
      <button type="button" className="spending-link" onClick={() => setOpen(true)}>
        Make it a rule for future charges…
      </button>
    );
  }
  return (
    <div className="spending-what-counts-rule" role="group" aria-label="Make it a rule">
      <p>
        <label>
          <span>Treat </span>
          <select
            aria-label="Merchant"
            value={chosen}
            onChange={(event) => { setMerchantClass(event.target.value as CardMetalsMerchantClass); edited(); }}
          >
            {classes.map((item) => <option key={item} value={item}>{MERCHANT_CLASS_LABELS[item]}</option>)}
          </select>
        </label>
        <label>
          <span> charges of </span>
          <input
            aria-label="Minimum amount"
            inputMode="decimal"
            value={minimum === '' ? String(minimumMinor / scale) : minimum}
            onChange={(event) => { setMinimum(event.target.value.replace(/[^0-9.]/g, '')); edited(); }}
          />
        </label>
        <span> or more as precious metals, past and future.</span>
      </p>
      {current
        ? <p className="spending-muted" data-testid="rule-preview">{rulePreviewText(current.result, props.currency)}</p>
        : previewing ? <p className="spending-muted" data-testid="rule-previewing">Previewing…</p> : null}
      {!props.installed ? (
        <p className="spending-muted">Rules need a one-time install on this Holdr first; confirming charges one by one works now.</p>
      ) : null}
      <div className="spending-what-counts-actions">
        <button
          type="button"
          className="spending-button ghost"
          disabled={!valid || saving || previewing}
          onClick={() => {
            const asked = input;
            const ticket = ++generation.current;
            setPreviewing(true);
            previewSpendingRule(asked)
              .then((result) => { if (generation.current === ticket) setPreview({ input: asked, result }); })
              .catch((reason: unknown) => { if (generation.current === ticket) props.onError(apiErrorMessage(reason)); })
              .finally(() => { if (generation.current === ticket) setPreviewing(false); });
          }}
        >
          Preview
        </button>
        <button
          type="button"
          className="spending-button primary"
          disabled={!valid || !current || previewing || !props.installed || props.disabled || saving}
          onClick={() => {
            if (!current) return;
            setSaving(true);
            createSpendingRule(current.input, current.result.match)
              .then(() => { close(); props.onSaved(); })
              .catch((reason: unknown) => {
                // What the rule takes out changed since its preview: nothing was made, and it needs a new preview.
                if (isRulePreviewStale(reason)) edited();
                props.onError(apiErrorMessage(reason));
              })
              .finally(() => setSaving(false));
          }}
        >
          Make this my rule
        </button>
        <button type="button" className="spending-link" onClick={close}>Cancel</button>
      </div>
    </div>
  );
}
