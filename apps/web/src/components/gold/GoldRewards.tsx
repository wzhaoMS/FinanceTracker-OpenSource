import { useId } from 'react';

import { Disclosure } from '../Disclosure';
import { Spinner } from '../Spinner';
import type { MetalsOverview, MetalsPurchases } from './goldApi';
import { REWARDS_INCOMPLETE, REWARDS_NONE_KEPT, REWARDS_NONE_RECORDED, REWARDS_REFUND_NOTE, periodPurchasesComplete, rewardsReadsCurrent, rewardsStatus } from './goldRewardsStatus';
import { plural, usd } from './goldText';

const NETWORK_WORDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  unknown: 'a card of unstated network',
};

/**
 * Est. rewards (ROOT O101): their own line, an estimate kept apart from the market gain or loss, from the shared rewards
 * math over the period's purchases. No rate is stored on this Holdr yet, so it says what each card and membership needs
 * ("rate needed") and never shows a guessed figure; the disclosure says how the estimate is made once rates are given.
 * The figure is qualified by the period's purchases (G1d's P1, ROOT O137): Partial while some aren't counted, and words,
 * never "$0.00", when no purchase is kept or on the way. While either read is under way the line stays where it is, marked
 * as being read, and says nothing about the period until both are current and answer it (5b01e72f's N9); its fold is the
 * page's, so a read never closes it (G1d).
 */
export function GoldRewards({ purchases, overview, busy, open, onOpenChange }: {
  purchases: MetalsPurchases | null;
  overview: MetalsOverview;
  /** Whether each read is under way (it keeps its last answer meanwhile). */
  busy: { purchases: boolean; overview: boolean };
  /** "How rewards are estimated", open or not: kept by the page, so that a read never closes it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const titleId = useId();
  const reading = busy.purchases || busy.overview;
  // Both reads current and answering the same metal and period; until then nothing is claimed about the period.
  const status = purchases && rewardsReadsCurrent(purchases, overview, busy)
    ? rewardsStatus(purchases, undefined, periodPurchasesComplete(overview)) : null;
  if (!status && !reading) return null;
  return (
    <section className="gold-rewards" aria-labelledby={titleId} data-testid="gold-rewards" aria-busy={reading || undefined}>
      <p className="gold-rewards-line">
        <span id={titleId} className="gold-rewards-label">Est. rewards</span>{' '}
        {status ? (
          <>
            <span className="gold-figure" data-state={status.state} data-testid="gold-rewards-figure">
              {status.state === 'none'
                ? <span className="gold-totals-words">{REWARDS_NONE_KEPT}</span>
                : <span className="num">{status.state === 'unknown' ? '—' : usd(status.figure.minor ?? 0)}</span>}
              {status.state === 'unknown' ? <span className="gold-state">Unknown</span> : status.state === 'partial' ? <span className="gold-state">Partial</span> : null}
            </span>{' '}
            {status.orders === 0 ? (
              status.state === 'unknown' ? <span className="gold-row-sub" data-testid="gold-rewards-none">{REWARDS_NONE_RECORDED}</span> : null
            ) : (
              <span className="gold-row-sub">
                an estimate on this period&apos;s purchases, kept apart from the gain or loss
                {status.needs.length > 0 ? `; needs ${status.needs.join(', ')}` : ''}
              </span>
            )}
          </>
        ) : <Spinner label="Updating" testId="gold-rewards-reading" />}
      </p>
      {status && status.orders > 0 && status.incomplete
        ? <p className="gold-help" data-testid="gold-rewards-incomplete">{REWARDS_INCOMPLETE}</p> : null}
      <Disclosure summary="How rewards are estimated" className="gold-rewards-more" open={open} onOpenChange={onOpenChange}>
        {status ? (
          <ul className="gold-rewards-list" data-testid="gold-rewards-cards">
            {status.cards.map((card) => (
              <li key={card.account.id}>
                <span className="gold-row-name">{card.account.name}{card.account.ending ? ` ··${card.account.ending}` : ''}</span>
                <span className="gold-help">{plural(card.orders, 'order', 'orders')} · <span className="num">{usd(card.chargedMinor)}</span> charged · rate needed</span>
              </li>
            ))}
            {status.unlinked.map((entry) => (
              <li key={entry.network}>
                <span className="gold-row-name">{NETWORK_WORDS[entry.network] ?? entry.network}</span>
                <span className="gold-help">{plural(entry.orders, 'order', 'orders')} paid by a card whose charge isn&apos;t linked: which card, and its rate, aren&apos;t known</span>
              </li>
            ))}
            {status.costcoMemberships.map((membership) => (
              <li key={membership.accountId}>
                <span className="gold-row-name">{membership.label}</span>
                <span className="gold-help">{plural(membership.orders, 'order', 'orders')} · tier, and whether gold earns the Executive reward, aren&apos;t known</span>
              </li>
            ))}
            {status.shopCardOrders > 0 ? (
              <li>
                <span className="gold-row-name">Shop Card</span>
                <span className="gold-help">{plural(status.shopCardOrders, 'order', 'orders')}: the reward counts on the card that bought the Shop Card, not known yet</span>
              </li>
            ) : null}
            {status.cards.length === 0 && status.unlinked.length === 0 && status.costcoMemberships.length === 0 && status.shopCardOrders === 0
              ? <li><span className="gold-help">No purchase in this period earns a card reward that Holdr can see.</span></li> : null}
          </ul>
        ) : null}
        <ul className="gold-rewards-notes">
          <li>No rate is stored on this Holdr yet. Each card&apos;s rate is your answer, per card, never one rate for a whole network, and never a guess.</li>
          <li>{REWARDS_REFUND_NOTE}</li>
          <li>
            Costco&apos;s Executive reward: 2% of eligible Costco spending, net of returns, at most $1,250 per membership year, the cap
            shared with all Costco spending; gold&apos;s share of a year&apos;s capped reward is proportional to its spending, whatever period is shown.
            Not counted for gold until you confirm gold earns it. Default; you can change it.
          </li>
          <li>Paid by Shop Card: the reward counts on the card that bought the Shop Card. Default; you can change it.</li>
          <li>
            Once every rate is known, a return including rewards adds them on a matched basis: a sale&apos;s profit gains the rewards of
            the purchase units it sold (earliest units first), and holdings those of the units still held.
          </li>
        </ul>
      </Disclosure>
    </section>
  );
}
