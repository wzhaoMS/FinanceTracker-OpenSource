import { useId, useState, type ReactNode } from 'react';

import { Disclosure } from '../Disclosure';
import { ChevronRight } from '../icons';
import { TitleWithSpinner } from '../Spinner';
import type { Metal, MetalsFunding, MetalsPurchase, MetalsPurchases, MetalsSale, MetalsSales } from './goldApi';
import type { OpenInCardTransactions } from './GoldPage';
import { Figure } from './GoldSummary';
import {
  AGGREGATE_CARD_TEXT,
  CYCLE_PROFIT_LABEL,
  CYCLE_QUARANTINED_TEXT,
  DATE_UNKNOWN_TEXT,
  DECOMPOSITION_NOTE,
  DELIVERY_WORDS,
  EVIDENCE_WORDS,
  QUARANTINE_TEXT,
  RECEIPT_NOTE,
  assignedText,
  assignmentNote,
  cardText,
  contentText,
  cycleSpotText,
  dateText,
  depositSummary,
  fundingText,
  fungibleFor,
  itemTitle,
  measureWarning,
  moneyFigure,
  payoutText,
  PREMIUM_DISAGREEMENT_TEXT,
  premiumText,
  purchaseSummary,
  receiptCounts,
  receiptText,
  refundsText,
  saleNotes,
  saleStatusText,
  saleSummary,
  setAside,
  setAsideMeta,
  signedUsd,
  sourceName,
  SPOT_OFF_WORDS,
  troyOz,
  unitsText,
  unmatchedSaleText,
  usd,
  type GoldSpot,
} from './goldText';

/** A list row: a summary that opens its labelled details; nothing is cut, the summary wraps. */
function Row({ testId, name, meta, children, state }: { testId: string; name: string; meta: string; children: ReactNode; state?: string }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <li className="gold-row" data-testid={testId} data-open={open ? 'true' : 'false'} data-state={state}>
      <button type="button" className="gold-row-toggle" aria-expanded={open} aria-controls={open ? detailsId : undefined}
        onClick={() => setOpen(!open)}>
        <span className="gold-row-text">
          <span className="gold-row-name">{name}</span>
          <span className="gold-row-meta">{meta}</span>
        </span>
        <ChevronRight size={16} className="gold-row-chevron" />
      </button>
      {open ? <div id={detailsId} className="gold-row-details">{children}</div> : null}
    </li>
  );
}

const newestFirst = <T,>(items: readonly T[], date: (item: T) => string) => [...items].sort((a, b) => (date(a) < date(b) ? 1 : date(a) > date(b) ? -1 : 0));

function ConfirmLink({ onConfirm }: { onConfirm: () => void }) {
  return <button type="button" className="gold-link" onClick={onConfirm}>Needs your answer: what it contains</button>;
}

/** A sale's details; `fungible`: the owner's fungible policy names its metal (its note says "across all forms"). */
function SaleDetails({ sale, spot, fungible, onConfirm }: { sale: MetalsSale; spot: GoldSpot; fungible: boolean; onConfirm: () => void }) {
  const unmatched = unmatchedSaleText(sale);
  // What part of a profit or loss came from the spot price needs closes: none while values at spot don't show.
  const spotOff = spot === 'shown' ? null : SPOT_OFF_WORDS[spot];
  return (
    <>
      <dl className="gold-details">
        <div><dt>Units</dt><dd>{sale.quantity}</dd></div>
        <div>
          <dt>Fine content</dt>
          <dd>{contentText(sale.content)}{!sale.content.known ? <> · <ConfirmLink onConfirm={onConfirm} /></> : null}</dd>
        </div>
        <div><dt>Money</dt><dd>{usd(sale.grossMinor)} gross · {usd(sale.feesMinor)} fees · {usd(sale.netMinor)} net</dd></div>
        <div><dt>Agreed</dt><dd>{dateText(sale.agreedDate)} at {sale.account.label}</dd></div>
        <div><dt>Status</dt><dd>{saleStatusText(sale)}</dd></div>
        {sale.program ? <div><dt>Program</dt><dd>{sale.program}</dd></div> : null}
        {sale.premium ? (
          <div data-testid="gold-premium">
            <dt>Dealer&apos;s stated premium</dt>
            <dd>
              {sale.premium.text} ({sale.premium.basis === 'troy_ounce' ? 'per troy oz' : 'per unit'})
              {sale.premiumDisagreement ? <span className="gold-help-inline">{PREMIUM_DISAGREEMENT_TEXT}</span> : null}
            </dd>
          </div>
        ) : null}
        {sale.payouts.length === 0 ? <div><dt>Payout</dt><dd>None recorded yet</dd></div> : sale.payouts.map((payout) => (
          <div key={payout.key} data-testid="gold-payout">
            <dt>{sale.payouts.length > 1 ? 'A payout of the order' : 'Payout of the order'}</dt>
            <dd>{payoutText(payout)}</dd>
          </div>
        ))}
      </dl>
      {unmatched ? <p className="gold-warning" data-testid="gold-unmatched">{unmatched}</p> : null}
      {sale.cycles.length > 0 ? (
        <div className="gold-cycles">
          <p className="gold-cycles-head">Assigned purchases</p>
          <ul className="gold-list">
            {sale.cycles.map((cycle) => (
              <li key={cycle.lotKey} className="gold-cycle" data-testid="gold-cycle">
                <dl className="gold-details">
                  <div><dt>Bought</dt><dd>{dateText(cycle.orderDate)} at {cycle.account.label}</dd></div>
                  <div><dt>Units</dt><dd>{cycle.units} · {troyOz(cycle.troyOz)}</dd></div>
                  <div><dt>Held</dt><dd>{cycle.daysFromOrderToSale} {cycle.daysFromOrderToSale === 1 ? 'day' : 'days'} from order to sale</dd></div>
                  <div><dt>Cost</dt><dd>{cycle.costMinor === null ? '— (the purchase\'s cost is incomplete)' : usd(cycle.costMinor)}</dd></div>
                  <div><dt>Proceeds</dt><dd>{usd(cycle.proceedsMinor)}</dd></div>
                  <div>
                    <dt>{CYCLE_PROFIT_LABEL}</dt>
                    <dd className={cycle.profitMinor === null || cycle.profitMinor === 0 ? undefined : cycle.profitMinor > 0 ? 'gain' : 'loss'}>
                      {cycle.profitMinor === null ? '— (unknown while the cost is incomplete)' : signedUsd(cycle.profitMinor)}
                    </dd>
                  </div>
                  <div>
                    <dt>From spot-price change</dt>
                    <dd>{spotOff ?? (cycle.fromSpotMinor === null ? '— (a spot price is missing)' : signedUsd(cycle.fromSpotMinor))}</dd>
                  </div>
                  <div>
                    <dt>From premiums and fees</dt>
                    <dd>{spotOff ?? (cycle.fromPremiumsMinor === null ? '— (needs the profit or loss and both spot prices)'
                      : signedUsd(cycle.fromPremiumsMinor))}</dd>
                  </div>
                  {!spotOff && cycleSpotText(sale, cycle.purchaseSpot) ? <div><dt>Spot</dt><dd>{cycleSpotText(sale, cycle.purchaseSpot)}</dd></div> : null}
                </dl>
                {cycle.lotQuarantined ? <p className="gold-warning" data-testid="gold-cycle-contested">{CYCLE_QUARANTINED_TEXT}</p> : null}
              </li>
            ))}
          </ul>
          <p className="gold-note" data-testid="gold-assignment-note">{assignmentNote(fungible)}</p>
          <p className="gold-help">{DECOMPOSITION_NOTE}</p>
        </div>
      ) : null}
      {saleNotes(sale).map((note) => (
        <p key={note.key} className={note.warning ? 'gold-warning' : 'gold-help'} data-testid={`gold-sale-${note.key}`}>{note.text}</p>
      ))}
    </>
  );
}

/** Sales of the period, by day agreed (§11): date and product, then net and deposit state; the rest in labelled details. */
export function GoldSales({ metal, read, error, busy, scope, spot, onConfirm }: {
  metal: Metal;
  read: MetalsSales | null;
  error: string | null;
  busy: boolean;
  scope: string;
  spot: GoldSpot;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const sales = newestFirst((read?.sales ?? []).filter((sale) => sale.status !== 'cancelled'), (sale) => sale.tradeMoment);
  const fungible = fungibleFor(read, metal);
  return (
    <section id="gold-sales" className="gold-card gold-sales" aria-labelledby={titleId} data-testid="gold-sales" tabIndex={-1}
      data-updating={busy ? 'true' : undefined} aria-busy={busy || undefined}>
      <TitleWithSpinner busy={busy}><h3 id={titleId}>Sales</h3></TitleWithSpinner>
      <p className="gold-scope">Agreed over {scope}.</p>
      {error ? <p className="gold-error-text" role="alert">Sales couldn&apos;t be read: {error}</p> : null}
      {read && sales.length === 0 ? <p className="gold-help">No sales in this period.</p> : null}
      {sales.length > 0 ? (
        <ul className="gold-rows">
          {sales.map((sale) => (
            <Row key={sale.key} testId="gold-sale" name={`${dateText(sale.agreedDate)} · ${itemTitle(sale, metal)}`} meta={saleSummary(sale)}
              state={depositSummary(sale.payouts)}>
              <SaleDetails sale={sale} spot={spot} fungible={fungible} onConfirm={onConfirm} />
            </Row>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function PurchaseDetails({ purchase, metal, onOpenCharge, onOpenInCardTransactions, onConfirm }: {
  purchase: MetalsPurchase;
  metal: Metal;
  onOpenCharge: (id: string) => void;
  onOpenInCardTransactions: OpenInCardTransactions;
  onConfirm: () => void;
}) {
  const premium = premiumText(purchase);
  const funding = fundingText(purchase.funding);
  const costWarning = measureWarning(purchase.costMinor, metal);
  return (
    <>
      <dl className="gold-details">
        <div><dt>Units</dt><dd>{unitsText(purchase.units)}</dd></div>
        <div>
          <dt>Fine content</dt>
          <dd>{contentText(purchase.content)}{!purchase.content.known ? <> · <ConfirmLink onConfirm={onConfirm} /></> : null}</dd>
        </div>
        {premium ? <div><dt>Premium</dt><dd>{premium}</dd></div> : null}
        <div>
          <dt>Cost</dt>
          <dd><Figure measure={purchase.costMinor} text={moneyFigure(purchase.costMinor)} />{costWarning ? ` · ${costWarning}` : ''}</dd>
        </div>
        <div>
          <dt>Delivery</dt>
          <dd>{DELIVERY_WORDS[purchase.delivery.state]}{purchase.delivery.date ? `, ${dateText(purchase.delivery.date)}` : ''}</dd>
        </div>
        <div><dt>Ordered</dt><dd>{dateText(purchase.orderDate)} at {purchase.account.label}</dd></div>
        {purchase.seller ? <div><dt>Seller</dt><dd>{purchase.seller}</dd></div> : null}
        {funding ? <div><dt>Paid with</dt><dd>{funding}</dd></div> : null}
        {purchase.cards.map((card, index) => (
          <div key={`${card.evidenceClass}-${index}`} data-testid="gold-card-charge" data-state={card.state}>
            <dt>Card charge</dt>
            <dd>
              <span>{cardText(card)}</span>
              <span className="gold-help-inline">Evidence: {EVIDENCE_WORDS[card.evidenceClass]}</span>
              {card.row ? (
                <span className="gold-actions">
                  <button type="button" className="gold-button" onClick={() => onOpenCharge(card.row!.id)}>Open charge</button>
                  <button type="button" className="gold-link" onClick={() => onOpenInCardTransactions({ id: card.row!.id, date: card.row!.date })}>
                    Open in Card transactions
                  </button>
                </span>
              ) : null}
            </dd>
          </div>
        ))}
        {purchase.cardEvidence === 'aggregate' ? (
          <div data-testid="gold-card-charge" data-state="aggregate"><dt>Card charge</dt><dd>{AGGREGATE_CARD_TEXT}</dd></div>
        ) : null}
        <div><dt>Sales</dt><dd>{assignedText(purchase) ?? 'Not assigned to a sale'}</dd></div>
        {refundsText(purchase.refunds) ? <div><dt>Refunds of the order</dt><dd>{refundsText(purchase.refunds)}</dd></div> : null}
      </dl>
      {purchase.dateUnknown ? <p className="gold-help">{DATE_UNKNOWN_TEXT}</p> : null}
      {purchase.quarantined ? <p className="gold-warning">{QUARANTINE_TEXT}</p> : null}
    </>
  );
}

/**
 * Purchases of the period, by order date (§11): date and product, then cost and delivery state; units, content,
 * funding, the card charge and what it was assigned to in labelled details. Above them, the receipt block: which card
 * charges receipts show as all precious metal, each metal named.
 */
export function GoldPurchases({ metal, read, funding, fundingError, error, busy, scope, onOpenCharge, onOpenInCardTransactions, onConfirm }: {
  metal: Metal;
  read: MetalsPurchases | null;
  funding: MetalsFunding | null;
  fundingError: string | null;
  error: string | null;
  busy: boolean;
  scope: string;
  onOpenCharge: (id: string) => void;
  onOpenInCardTransactions: OpenInCardTransactions;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const purchases = newestFirst((read?.purchases ?? []).filter((purchase) => !setAside(purchase)), (purchase) => purchase.orderDate);
  const receipts = funding ? receiptCounts(funding.purchases) : [];
  return (
    <section id="gold-purchases" className="gold-card gold-purchases" aria-labelledby={titleId} data-testid="gold-purchases" tabIndex={-1}
      data-updating={busy ? 'true' : undefined} aria-busy={busy || undefined}>
      <TitleWithSpinner busy={busy}><h3 id={titleId}>Purchases</h3></TitleWithSpinner>
      <p className="gold-scope">Ordered over {scope}.</p>
      {receipts.length > 0 ? (
        <div className="gold-receipts" data-testid="gold-receipts">
          <p className="gold-row-name">{receiptText(receipts)}</p>
          <p className="gold-help">{RECEIPT_NOTE}</p>
        </div>
      ) : null}
      {fundingError ? (
        <p className="gold-error-text" role="alert" data-testid="gold-receipts-error">Receipts couldn&apos;t be read: {fundingError}</p>
      ) : null}
      {error ? <p className="gold-error-text" role="alert">Purchases couldn&apos;t be read: {error}</p> : null}
      {read && purchases.length === 0 ? <p className="gold-help">No purchases in this period.</p> : null}
      {purchases.length > 0 ? (
        <ul className="gold-rows">
          {purchases.map((purchase) => (
            <Row key={purchase.key} testId="gold-purchase"
              name={`${dateText(purchase.orderDate)} · ${itemTitle(purchase, metal)}, ${sourceName(purchase.account.source)}`}
              meta={purchaseSummary(purchase)} state={purchase.delivery.state}>
              <PurchaseDetails purchase={purchase} metal={metal} onOpenCharge={onOpenCharge} onOpenInCardTransactions={onOpenInCardTransactions}
                onConfirm={onConfirm} />
            </Row>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * Cancelled, returned and refunded (§11), folded: listed apart, never among what counts, never gone. The page shows it
 * only while both its reads answer the period chosen (goldReads: periodCancelled) and keeps its fold open or closed
 * meanwhile (`open`), so a read again after a write never folds it away.
 */
export function GoldCancelled({ metal, purchases, sales, scope, open, onOpenChange }: {
  metal: Metal;
  purchases: MetalsPurchases | null;
  sales: MetalsSales | null;
  scope: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const lots = newestFirst((purchases?.purchases ?? []).filter(setAside), (purchase) => purchase.orderDate);
  // An order's refunds repeat on each of its lots: said once, on its first set-aside lot, or as the order's own row.
  const setAsideOrders = new Set(lots.map((purchase) => purchase.orderKey));
  const refundShownOn = new Map<string, string>();
  for (const purchase of lots) if (purchase.refunds.length > 0 && !refundShownOn.has(purchase.orderKey)) refundShownOn.set(purchase.orderKey, purchase.key);
  const refunded = new Map<string, MetalsPurchase[]>();
  for (const purchase of purchases?.purchases ?? []) {
    if (purchase.refunds.length === 0 || setAsideOrders.has(purchase.orderKey)) continue;
    refunded.set(purchase.orderKey, [...(refunded.get(purchase.orderKey) ?? []), purchase]);
  }
  const refundedOrders = newestFirst([...refunded.values()], (lines) => lines[0].orderDate);
  const cancelledSales = newestFirst((sales?.sales ?? []).filter((sale) => sale.status === 'cancelled'), (sale) => sale.tradeMoment);
  const count = lots.length + refundedOrders.length + cancelledSales.length;
  if (count === 0) return null;
  return (
    <section className="gold-card gold-cancelled" aria-label="Cancelled, returned and refunded" data-testid="gold-cancelled">
      <Disclosure summary={`Cancelled, returned and refunded (${count})`} open={open} onOpenChange={onOpenChange}>
        <p className="gold-scope">Over {scope}. Cancelled and returned units count in no figure above; refunds are shown as the store shows them.</p>
        <ul className="gold-list">
          {lots.map((purchase) => (
            <li key={purchase.key} data-testid="gold-set-aside">
              <p className="gold-row-name">{dateText(purchase.orderDate)} · {itemTitle(purchase, metal)}, {sourceName(purchase.account.source)}</p>
              <p className="gold-row-meta">{setAsideMeta(purchase)}</p>
              {refundShownOn.get(purchase.orderKey) === purchase.key ? <p className="gold-row-meta">{refundsText(purchase.refunds)}</p> : null}
            </li>
          ))}
          {refundedOrders.map((lines) => (
            <li key={lines[0].orderKey} data-testid="gold-refunded">
              <p className="gold-row-name">
                {dateText(lines[0].orderDate)} · {itemTitle(lines[0], metal)}{lines.length > 1 ? ` and ${lines.length - 1} more` : ''}, {sourceName(lines[0].account.source)}
              </p>
              <p className="gold-row-meta">{refundsText(lines[0].refunds)}</p>
            </li>
          ))}
          {cancelledSales.map((sale) => (
            <li key={sale.key} data-testid="gold-set-aside">
              <p className="gold-row-name">{dateText(sale.agreedDate)} · {itemTitle(sale, metal)} (sale)</p>
              <p className="gold-row-meta">Cancelled · {sale.quantity} {sale.quantity === 1 ? 'unit' : 'units'}</p>
            </li>
          ))}
        </ul>
      </Disclosure>
    </section>
  );
}
