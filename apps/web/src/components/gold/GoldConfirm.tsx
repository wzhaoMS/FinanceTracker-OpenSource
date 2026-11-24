import { useEffect, useId, useRef, useState, type RefObject } from 'react';

import { Disclosure } from '../Disclosure';
import { Spinner, TitleWithSpinner } from '../Spinner';
import { apiErrorMessage } from '../spending/spendingApi';
import {
  confirmMetalsContent,
  conflictReason,
  isConflict,
  isNotFound,
  revokeMetalsContent,
  type Metal,
  type MetalsContentPreview,
  type MetalsProduct,
  type MetalsProducts,
} from './goldApi';
import {
  BATCH_NOTE,
  CONTENT_BASIS_WORDS,
  CONTENT_HOLD_WORDS,
  DRIFT_TEXT,
  REFUSED_WRITE_TEXT,
  affectsText,
  batchPreviewText,
  confirmCardText,
  confirmableAll,
  confirmed,
  decisionText,
  linesNoun,
  metalName,
  packText,
  parseTroyOzInput,
  plural,
  previewText,
  productGroups,
  proposalQuestion,
  refusedBatchText,
  scopeText,
  sourceName,
  statedText,
  toConfirm,
  type GoldProductGroup,
} from './goldText';

const STALE = 'Something changed since this preview, so nothing was saved. Preview again to see what it does now.';

const stalePreview = (reason: unknown) => conflictReason(reason) === 'preview-stale';
/** The write was refused (not found, or any other conflict): nothing saved, and the product still waits for the owner. */
const refused = (reason: unknown) => isNotFound(reason) || (isConflict(reason) && !stalePreview(reason));
/** A refusal that means the page's rows are read again: a stale preview, or a refused write. */
const outOfDate = (reason: unknown) => stalePreview(reason) || refused(reason);
const outOfDateText = (reason: unknown) => (stalePreview(reason) ? STALE : REFUSED_WRITE_TEXT);

/** The row's identity, stable across reads: its scope (a purchase's row stays itself when its order's evidence changes). */
export function productKey(product: MetalsProduct): string {
  return product.scope.kind === 'product' ? `product:${product.scope.ref}:${product.scope.fingerprint}` : `lot:${product.scope.lotKey}`;
}

const rowTitle = (product: MetalsProduct) => product.titles[0]?.trim() || 'Title not shown';

/** What to send as one unit's fine troy ounces: the proposal exactly while it is unchanged, else what was typed. */
function amountToSend(product: MetalsProduct, typed: string): string | null {
  if (product.proposal && typed.trim() === product.proposal.troyOzPerUnit.display) return product.proposal.troyOzPerUnit.exact;
  return parseTroyOzInput(typed);
}

type PreviewStep = { kind: 'preview'; preview: MetalsContentPreview; amount: string; undo: boolean; writing: boolean };
type Step = { kind: 'idle' } | { kind: 'asking' } | PreviewStep;

/**
 * One row: one product and content fingerprint, or one purchase (a pack, a purchase whose pack is unclear, or one with
 * no usable product reference). It says what the titles say and the pack assessment, proposes what one ordered unit
 * contains, lets the owner change it, previews what confirming would change, and only then confirms. A confirmed row
 * can be undone the same way. Focus stays in the row: on the preview's own button once it shows, back on Preview or
 * Undo… when it is cancelled or refused.
 */
function ProductRow({ product, metal, writesDisabled, onChanged, announce }: {
  product: MetalsProduct;
  metal: Metal;
  writesDisabled: boolean;
  onChanged: () => void;
  announce: (text: string) => void;
}) {
  const inputId = useId();
  const [typed, setTyped] = useState(product.proposal?.troyOzPerUnit.display ?? '');
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const focusNext = useRef<'primary' | 'start' | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    (target === 'primary' ? primaryRef : startRef).current?.focus();
  }, [step]);
  const confirmedRow = product.hold === null && product.decision !== null;
  const title = rowTitle(product);
  const rowMetal = product.proposal?.metal ?? product.stated.metal ?? metal;
  const busy = step.kind === 'asking' || (step.kind === 'preview' && step.writing);

  const showPreview = (next: Omit<PreviewStep, 'kind' | 'writing'>) => {
    focusNext.current = 'primary';
    setStep({ kind: 'preview', writing: false, ...next });
  };
  const back = (message: string | null) => {
    focusNext.current = 'start';
    setStep({ kind: 'idle' });
    setError(message);
  };
  const fail = (reason: unknown) => {
    if (outOfDate(reason)) {
      // The rows are out of date: said once for the section (this row may move lists when read again), then read again,
      // so each row shows its current scope and decision.
      setStep({ kind: 'idle' });
      setError(null);
      announce(outOfDateText(reason));
      onChanged();
      return;
    }
    back(apiErrorMessage(reason));
  };

  const preview = async () => {
    if (busy) return;
    const amount = amountToSend(product, typed);
    if (!amount) {
      setError(`Enter the troy ounces of fine ${metalName(rowMetal)} in one unit as the order sells it, for example 1 or 0.1.`);
      return;
    }
    setError(null);
    setStep({ kind: 'asking' });
    try {
      const answer = await confirmMetalsContent(product.scope, { metal: rowMetal, troyOzPerUnit: amount, preview: null });
      if (answer.written) throw new Error('The preview was written');
      showPreview({ preview: answer.preview, amount, undo: false });
    } catch (reason) {
      fail(reason);
    }
  };

  const confirm = async (current: PreviewStep) => {
    if (current.writing) return;
    setError(null);
    setStep({ ...current, writing: true });
    try {
      const answer = await confirmMetalsContent(product.scope, { metal: rowMetal, troyOzPerUnit: current.amount, preview: current.preview.digest });
      if (!answer.written) {
        showPreview({ preview: answer.preview, amount: current.amount, undo: false });
        setError(STALE);
        return;
      }
      setStep({ kind: 'idle' });
      announce(`Confirmed: ${title} holds ${answer.decision.troyOzPerUnit.display} troy oz of fine ${metalName(answer.decision.metal)} per unit.`);
      onChanged();
    } catch (reason) {
      fail(reason);
    }
  };

  const previewUndo = async () => {
    if (!product.decision || busy) return;
    setError(null);
    setStep({ kind: 'asking' });
    try {
      const answer = await revokeMetalsContent(product.scope, product.decision.id, null);
      if (answer.revoked) throw new Error('The undo was written');
      showPreview({ preview: answer.preview, amount: product.decision.troyOzPerUnit.exact, undo: true });
    } catch (reason) {
      fail(reason);
    }
  };

  const undo = async (current: PreviewStep) => {
    if (!product.decision || current.writing) return;
    setError(null);
    setStep({ ...current, writing: true });
    try {
      const answer = await revokeMetalsContent(product.scope, product.decision.id, current.preview.digest);
      if (!answer.revoked) {
        showPreview({ preview: answer.preview, amount: current.amount, undo: true });
        setError(STALE);
        return;
      }
      setStep({ kind: 'idle' });
      announce(`Undone: ${title} is held again until you confirm what it contains.`);
      onChanged();
    } catch (reason) {
      fail(reason);
    }
  };

  const holdWords = product.hold ? CONTENT_HOLD_WORDS[product.hold] : null;
  return (
    <li className="gold-confirm-row" data-testid="gold-confirm-row" data-scope={product.scope.kind} data-drift={product.drift ? 'true' : undefined}
      data-confirmed={confirmedRow ? 'true' : undefined}>
      <p className="gold-row-name">{title}</p>
      {product.titles.length > 1 ? (
        <p className="gold-help">Also sold as: {product.titles.slice(1).join(' · ')}</p>
      ) : null}
      {product.drift ? <p className="gold-warning" data-testid="gold-drift">{DRIFT_TEXT}: it counts for nothing until you confirm it.</p> : null}
      <dl className="gold-details">
        <div><dt>Title says</dt><dd>{statedText(product)}</dd></div>
        <div><dt>Pack</dt><dd>{packText(product)}</dd></div>
        <div><dt>From</dt><dd>{sourceName(product.source)}</dd></div>
        {holdWords && !product.drift ? <div><dt>Why it waits</dt><dd>{holdWords}</dd></div> : null}
      </dl>
      <p className="gold-help">{scopeText(product)}</p>
      {confirmedRow ? (
        <p className="gold-confirmed" data-testid="gold-decision">
          {decisionText(product, metal)}{product.basis === 'owner-confirmed' ? '' : ` (${CONTENT_BASIS_WORDS[product.basis ?? 'owner-confirmed']})`}.
        </p>
      ) : (
        <>
          {product.proposal ? <p className="gold-proposal" data-testid="gold-proposal">{proposalQuestion(product, metal)}</p> : (
            <p className="gold-proposal">Nothing in the title suggests a weight: enter what one unit contains.</p>
          )}
          <label className="gold-field" htmlFor={inputId}>
            <span>Troy oz of fine {metalName(rowMetal)} per unit{product.pack === 'multiple' ? ' (the whole pack)' : ''}</span>
            <input id={inputId} inputMode="decimal" autoComplete="off" value={typed} disabled={writesDisabled || busy}
              onChange={(event) => { setTyped(event.target.value); setStep({ kind: 'idle' }); setError(null); }} />
          </label>
        </>
      )}
      {step.kind === 'preview' ? (
        <div className="gold-preview" role="status" data-testid="gold-preview">
          <p>{previewText(step.preview, step.undo, linesNoun(product))}</p>
          <div className="gold-actions">
            <button ref={primaryRef} type="button" className="gold-button primary" disabled={writesDisabled}
              aria-disabled={step.writing ? true : undefined} onClick={() => { void (step.undo ? undo(step) : confirm(step)); }}>
              {step.undo ? 'Undo confirmation' : 'Confirm'}
            </button>
            <button type="button" className="gold-button" aria-disabled={step.writing ? true : undefined}
              onClick={() => { if (!step.writing) back(null); }}>
              {step.undo ? 'Keep it' : 'Cancel'}
            </button>
            {step.writing ? <Spinner label={step.undo ? 'Undoing' : 'Confirming'} /> : null}
          </div>
        </div>
      ) : (
        <div className="gold-actions">
          <button ref={startRef} type="button" className="gold-button" disabled={writesDisabled} aria-disabled={busy ? true : undefined}
            onClick={() => { void (confirmedRow ? previewUndo() : preview()); }}>
            {confirmedRow ? 'Undo…' : 'Preview'}
          </button>
          {busy ? <Spinner label="Asking what it would change" /> : null}
        </div>
      )}
      {error ? <p className="gold-error-text" role="alert">{error}</p> : null}
    </li>
  );
}

/** A batch confirmation stopped because a product no longer covers what its preview showed. */
class StaleBatch extends Error {
  constructor() {
    super(STALE);
    this.name = 'StaleBatch';
  }
}

/**
 * "Confirm all as proposed": each single product listed with what it covers, previewed, then confirmed one by one. Each
 * earlier confirmation changes recorded holdings, so each product is asked again just before it is written and written
 * only while it still covers exactly the purchases and units its preview showed; otherwise the batch stops there.
 */
function ConfirmAll({ products, metal, writesDisabled, onChanged, announce }: {
  products: MetalsProduct[];
  metal: Metal;
  writesDisabled: boolean;
  onChanged: () => void;
  announce: (text: string) => void;
}) {
  const [previews, setPreviews] = useState<Map<string, MetalsContentPreview> | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const focusNext = useRef<'confirm' | 'preview' | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    (target === 'confirm' ? confirmRef : previewRef).current?.focus();
  }, [previews, working]);
  const asProposed = (product: MetalsProduct) => ({ metal: product.proposal!.metal, troyOzPerUnit: product.proposal!.troyOzPerUnit.exact });

  const previewAll = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      const found = new Map<string, MetalsContentPreview>();
      for (const product of products) {
        const answer = await confirmMetalsContent(product.scope, { ...asProposed(product), preview: null });
        if (answer.written) throw new Error('The preview was written');
        found.set(productKey(product), answer.preview);
      }
      focusNext.current = 'confirm';
      setPreviews(found);
    } catch (reason) {
      setPreviews(null);
      if (outOfDate(reason)) {
        announce(stalePreview(reason) ? STALE : refusedBatchText(0));
        onChanged();
      } else {
        setError(apiErrorMessage(reason));
      }
    } finally {
      setWorking(false);
    }
  };

  const confirmAll = async () => {
    if (!previews || working) return;
    setWorking(true);
    setError(null);
    let done = 0;
    let reread = false;
    try {
      for (const product of products) {
        const shown = previews.get(productKey(product));
        if (!shown) continue;
        const fresh = await confirmMetalsContent(product.scope, { ...asProposed(product), preview: null });
        if (fresh.written) throw new Error('The preview was written');
        if (fresh.preview.lots !== shown.lots || fresh.preview.units !== shown.units) throw new StaleBatch();
        const answer = await confirmMetalsContent(product.scope, { ...asProposed(product), preview: fresh.preview.digest });
        if (!answer.written) throw new StaleBatch();
        done += 1;
      }
      announce(`Confirmed ${plural(done, 'product', 'products')} as proposed.`);
    } catch (reason) {
      const stale = reason instanceof StaleBatch || stalePreview(reason);
      reread = stale || outOfDate(reason);
      const confirmedNote = done > 0 ? `${plural(done, 'product was', 'products were')} confirmed. ` : '';
      const message = stale ? `${confirmedNote}${STALE}` : reread ? refusedBatchText(done) : `${confirmedNote}${apiErrorMessage(reason)}`;
      // Once anything was saved or the rows are read again, the lists change: said once for the section.
      if (done > 0 || reread) announce(message);
      else {
        setError(message);
        focusNext.current = 'preview';
      }
    } finally {
      setWorking(false);
      setPreviews(null);
      if (done > 0 || reread) onChanged();
    }
  };

  return (
    <Disclosure className="gold-confirm-all" summary={`Confirm all as proposed (${products.length})`}>
      <p className="gold-help">
        These {products.length} products, each as proposed. Packs, purchases whose pack is unclear and purchases with no usable
        product reference aren&apos;t here: each of those is confirmed on its own.
      </p>
      <ul className="gold-confirm-all-list" data-testid="gold-confirm-all-list">
        {products.map((product) => {
          const preview = previews?.get(productKey(product));
          return (
            <li key={productKey(product)}>
              <span className="gold-row-name">{rowTitle(product)}</span>
              <span className="gold-help">{proposalQuestion(product, metal)?.replace(/\?$/, '')}</span>
              {preview ? <span className="gold-help" data-testid="gold-confirm-all-preview">{batchPreviewText(preview, linesNoun(product))}</span> : null}
            </li>
          );
        })}
      </ul>
      {previews ? <p className="gold-help">{BATCH_NOTE}</p> : null}
      <div className="gold-actions">
        {previews ? (
          <>
            <button ref={confirmRef} type="button" className="gold-button primary" disabled={writesDisabled}
              aria-disabled={working ? true : undefined} onClick={() => { void confirmAll(); }}>
              Confirm all {products.length}
            </button>
            <button type="button" className="gold-button" aria-disabled={working ? true : undefined}
              onClick={() => { if (!working) { focusNext.current = 'preview'; setPreviews(null); } }}>Cancel</button>
          </>
        ) : (
          <button ref={previewRef} type="button" className="gold-button" disabled={writesDisabled} aria-disabled={working ? true : undefined}
            onClick={() => { void previewAll(); }}>
            Preview all {products.length}
          </button>
        )}
        {working ? <Spinner label="Working through the products" /> : null}
      </div>
      {error ? <p className="gold-error-text" role="alert">{error}</p> : null}
    </Disclosure>
  );
}

/** A group of purchase rows with the same title and details: each still confirmed on its own (§11: packs per purchase). */
function GroupRows({ group, metal, writesDisabled, onChanged, announce }: {
  group: GoldProductGroup;
  metal: Metal;
  writesDisabled: boolean;
  onChanged: () => void;
  announce: (text: string) => void;
}) {
  const product = group.rows[0];
  return (
    <li className="gold-confirm-group" data-testid="gold-confirm-group">
      <p className="gold-row-name">{rowTitle(product)}</p>
      <p className="gold-help">
        {sourceName(product.source)} · {affectsText(group)} · {plural(group.rows.length, 'purchase', 'purchases')} with the same title and details,
        each confirmed on its own
      </p>
      <Disclosure summary={`Confirm each (${group.rows.length})`} className="gold-confirm-fold">
        <ul className="gold-confirm-list">
          {group.rows.map((row) => (
            <ProductRow key={productKey(row)} product={row} metal={metal} writesDisabled={writesDisabled} onChanged={onChanged} announce={announce} />
          ))}
        </ul>
      </Disclosure>
    </li>
  );
}

/**
 * Confirm product contents (§4.4.1, §11; Astra's redesign): above the figures, compact: how many products wait and how
 * many records they reach, and "Review products". Open, the products are grouped by exact product and content: a
 * product-wide row confirms in one action; purchase rows with the same title and details sit in one group, each still
 * confirmed on its own. Every write is previewed first; "Confirm all as proposed" covers single products only.
 * Confirmed rows can be undone, which holds their purchases again.
 */
export function GoldConfirmations({ sectionRef, metal, read, error, busy, open, onOpenChange, writesDisabled, onChanged }: {
  sectionRef: RefObject<HTMLElement | null>;
  metal: Metal;
  read: MetalsProducts | null;
  error: string | null;
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  writesDisabled: boolean;
  onChanged: () => void;
}) {
  const titleId = useId();
  const listId = useId();
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  // What was just done, said once and focused, so a reader of the row knows where its row went (`n` repeats a sentence).
  const [said, setSaid] = useState<{ text: string; n: number } | null>(null);
  const announce = (text: string) => setSaid((last) => ({ text, n: (last?.n ?? 0) + 1 }));
  useEffect(() => {
    if (said) statusRef.current?.focus();
  }, [said]);
  const products = read?.products ?? [];
  const waiting = toConfirm(products);
  const done = confirmed(products);
  const all = confirmableAll(products);
  const groups = productGroups(waiting);
  if (!read && !error) return null;
  if (read && waiting.length === 0 && done.length === 0 && !said) return null;
  return (
    <section ref={sectionRef} className="gold-card gold-confirm" aria-labelledby={titleId} data-testid="gold-confirm">
      <div className="gold-confirm-head">
        <div>
          <TitleWithSpinner busy={busy}>
            <h3 id={titleId} tabIndex={-1} data-confirm-heading>Confirm product contents</h3>
          </TitleWithSpinner>
          <p className="gold-help" data-testid="gold-confirm-summary">
            {waiting.length > 0 ? confirmCardText(groups) : `Contents confirmed by you for ${plural(done.length, 'product', 'products')}.`}
          </p>
        </div>
        <button type="button" className="gold-button" aria-expanded={open} aria-controls={listId} onClick={() => onOpenChange(!open)}
          data-testid="gold-review-products">
          {open ? 'Hide products' : 'Review products'}
        </button>
      </div>
      {said ? <p ref={statusRef} className="gold-said" role="status" tabIndex={-1} data-testid="gold-confirm-status">{said.text}</p> : null}
      {error ? <p className="gold-error-text" role="alert">What products contain couldn&apos;t be read: {error}</p> : null}
      {open ? (
        <div id={listId} className="gold-confirm-body">
          <p className="gold-help">
            Ounces, value and profit or loss count a purchase only once Holdr knows what one ordered unit contains. A proposal
            counts for nothing until you confirm it, every confirmation is previewed first, and you can undo it.
          </p>
          {all.length > 1 ? (
            <ConfirmAll products={all} metal={metal} writesDisabled={writesDisabled} onChanged={onChanged} announce={announce} />
          ) : null}
          {groups.length > 0 ? (
            <ul className="gold-confirm-list" data-testid="gold-confirm-groups">
              {groups.map((group) => (group.rows.length === 1 ? (
                <ProductRow key={group.key} product={group.rows[0]} metal={metal} writesDisabled={writesDisabled} onChanged={onChanged}
                  announce={announce} />
              ) : (
                <GroupRows key={group.key} group={group} metal={metal} writesDisabled={writesDisabled} onChanged={onChanged} announce={announce} />
              )))}
            </ul>
          ) : null}
          {done.length > 0 ? (
            <Disclosure summary={`Confirmed by you (${done.length})`} className="gold-confirm-fold">
              <ul className="gold-confirm-list">
                {done.map((product) => (
                  <ProductRow key={productKey(product)} product={product} metal={metal} writesDisabled={writesDisabled} onChanged={onChanged}
                    announce={announce} />
                ))}
              </ul>
            </Disclosure>
          ) : null}
        </div>
      ) : null}
      {busy && !read ? <Spinner label="Reading what products contain" /> : null}
    </section>
  );
}
