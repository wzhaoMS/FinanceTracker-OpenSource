/**
 * Card payments and the checking debits that paid them, matched one to one.
 *
 * A payment to a credit card is a transfer from one of the owner's checking accounts (Wells Fargo, Fifth Third, …),
 * never spending. Every posted payment to a card (`isCardPaymentToCard`, posted) on every card account is matched with
 * the posted checking debit that paid it, from any checking account Holdr has imported:
 *
 * - **Candidates.** A debit is a candidate for a payment when both are posted, in the same currency, of exactly the
 *   same amount in minor units (card payments and checking debits are both stored negative), and the debit is dated
 *   from `daysBefore` days before the payment's transaction date to `daysAfter` days after it. Its descriptor must
 *   read as a card payment (`classifyCheckingDebit`) and identify the payment's issuer: an exact alias from a fixed
 *   list, read as whole tokens (`cardPaymentPayeeMatchesIssuer`), for that issuer's cards only (no issuer stands in for
 *   another: Bilt never for Wells Fargo, nor the other way round, save a debit naming Bilt from before Cardless issued
 *   the Bilt card, below). Only ASCII whitespace and ASCII punctuation separate
 *   tokens, and a name of several words matches only those words adjacent with ASCII whitespace alone between them
 *   (`CAPITAL ONE`, never `CAPITAL-ONE`). A descriptor with anything but printable ASCII in it (any other letter, mark
 *   or digit, a symbol, an emoji, a hidden character) is never read for an issuer at all, nor is one that carries a
 *   name only across punctuation. A debit naming no issuer ("credit card payment"), a card's product alone
 *   (`… TO MICRO CENTER`) save to the card that carries it (below), or anything the list does not name exactly (an
 *   unknown word, a word with a digit, a cut-off or lookalike name), is never a candidate: it is only offered to the
 *   owner. A pair the owner rejected is never a candidate again.
 * - **A masked card number.** A debit naming one issuer, or a card's product alone (then Wells Fargo, its issuer; the
 *   product's words adjacent with ASCII whitespace alone between them, as an issuer's), that prints a masked card number
 *   (`XXXXXX1234`) whose last four are those of exactly one card of that issuer, when every card of that issuer in Holdr
 *   has its last four, identifies that card: it is a candidate for that card's payments only, so two cards of one
 *   issuer are told apart and a card's product alone may pair. A checking account's own number (banks print the paying
 *   account's too) names no card; any other number leaves the debit as it was.
 * - **Matched.** A pair is matched by itself only when each is the other's one candidate: payment and debit are a
 *   group of their own. Anything else (one payment and several debits, several payments and one debit, two cards of
 *   one issuer paid the same amount on close dates) is ambiguous: the whole group goes to the owner, and Holdr picks
 *   nothing, except where one of the two rules below proves the pairing (interchangeable rows, payer references). A
 *   debit naming more than one issuer (`several`) is a candidate for each one's cards, and its group always
 *   goes to the owner: the order of the rules never picks one. So does the group of a payment whose own text (its
 *   description, merchant or category) has anything but printable ASCII in it: such a payment keeps its candidates, so
 *   a same-issuer payment beside it is never matched alone either.
 * - **The owner's group.** A group holding a pair the owner rejected is the owner's in full (Root 02:32Z, 03:30Z), the
 *   group read with that pair in it and with every row the owner answered since. No rule pairs any of its rows by
 *   itself while the rejection stands: not one to one, not as interchangeable rows, not by reference, and none of its
 *   payments is settled as returned by the card (a reversal is only offered). So rejecting a pair (**Not this one**, or
 *   the Undo of a pair matched from evidence), and then confirming another pair of the group or saying a payment of it
 *   was paid elsewhere, never hands the rejected debit to another payment or card. What is left of the group is held
 *   for the owner until the owner answers each of its rows.
 * - **A pull its bank returned unpaid.** A debit with a posted credit of exactly its amount to its account, from its
 *   day to `debitReturnDays` after, that reads as an item returned (returned, reversed, dishonoured, misposted, NSF,
 *   unpaid; never a fee) never paid a card (Root 02:32Z). No rule pairs it, its group is the owner's, and it proves no
 *   reference. Where it and its return are each other's only such, the two net to zero: the pull is no candidate at
 *   all, is never offered, and is listed apart (`returnedDebits`), so the rest of its group is read without it.
 * - **A retry of a returned pull (Root, RECON-34 B).** A debit reading RETRY may stand in for a pull its bank returned
 *   unpaid: the same checking account, currency, amount and one named issuer, the pull dated up to `retryDays` before it,
 *   each the other's only such. It is then a candidate for the one payment the pull itself was a candidate for, by the
 *   pull's days and read as the retry is (the card its masked number names, its issuer on its day and the day Cardless
 *   issued the Bilt card, the carriers), that it may pay too (`retries`), no more than `confirmDays` from it, one to
 *   one as ever, only where nothing else is read for either side: it may pay no payment by its own days, that payment
 *   fits no other debit (a netted pull aside) nor another retry, and no reversal on its card may be its return. Else
 *   it keeps its own days.
 * - **A pull that came back.** The two rules below that settle a held group from evidence are stricter still: they read
 *   no group holding a debit with a posted credit of exactly its amount to its account, from its day to
 *   `debitReturnDays` after, whatever its words (a transfer back cannot be told from a return), and such a pull proves
 *   no reference. Its group is the owner's (`came-back`); one to one, only a pull returned unpaid is refused.
 * - **Interchangeable rows (Root 02:05Z, relaxed 04:24Z).** A group held for the owner is settled where its payments
 *   are interchangeable: two or more on one card, of one transaction and posted date, amount and currency, each reading
 *   as the same kind of card payment (`cardPaymentRowKind`: never a reversal, a return or a credit; their descriptions
 *   may differ), with identical candidate sets, no more debits than payments, and every debit one that would pair a lone
 *   payment by itself (none naming several issuers). The owner's groups and those holding a pull that came back are
 *   never read. A held group is a whole component of the candidate pairs, so none of its debits fits a payment outside
 *   it. Whichever debit pays which payment, every per-card, per-account, per-day and per-month figure is then the same.
 *   A description cue that clearly pairs a payment with a debit (`paymentChannelCue`: AUTOPAY with an AUTO PAY debit,
 *   ONLINE with a WEB one, each named by exactly one payment and one debit of the group) chooses that pair; the rest
 *   are paired in canonical order, date then id (`evidence: interchangeable`, with `pairedBy`). A payment left over has
 *   no debit: it is unmatched, and what is only offered (a Bilt-era transfer) stays offered.
 * - **A payer reference.** A group held for the owner is still settled where the checking side's own words say which
 *   card each debit paid. A debit's payer reference (`checkingPayerReference`) is its descriptor's words and reference
 *   numbers. A masked number, or one of seven digits or more, is read as its last four. An identifier mixing letters
 *   with four digits or more is kept as written. Dates, times and every shorter number are left out, and a descriptor with
 *   no reference number has no reference. A reference identifies a card once at least `referenceProofs` pairs proven
 *   without any reference tie it to that card, and none ties it to another. Those pairs are the ones the rules matched
 *   alone or the owner confirmed, with a pull that did not come back. In a held group, a candidate whose debit's
 *   reference identifies its payment's card is
 *   matched (`evidence: reference`) when it is the only such candidate of its payment and of its debit. A debit matched
 *   this way is never offered again. What is left of the group is grouped again. A payment and a debit left as each
 *   other's one candidate are matched too (`remainder`), unless the debit's reference was ever proven for another card;
 *   anything else stays with the owner, and a row left with no candidate is unmatched (never settled as returned: only
 *   offered). No reference is read in the owner's groups, in a group holding a pull that came back, or in one with a
 *   debit naming several issuers or a payment whose text is not plain ASCII.
 * - **Owner decisions.** The owner confirms a pair (it is then matched whatever else is near), rejects a pair (its group
 *   is then the owner's), says a payment was paid from another account (not from checking), or that a debit is not a
 *   card payment. Decisions name
 *   rows by id, and row ids never change on re-import, so an import of the same files again changes nothing. A
 *   decision whose rows no longer fit (gone, another amount or currency) is reported as stale and does nothing.
 * - **Both sides.** Payments without a debit and card-payment debits without a payment are listed with why: the other
 *   side was not imported for that date, no card of the debit's issuer is in Holdr, or nothing matched. A payment
 *   with no candidate also lists debits of its exact amount and dates the rules could not tie to it (naming another
 *   issuer, none, an unrecognized one, or not reading as a card payment): possible, for the owner to confirm, never
 *   matched by themselves.
 * - **Returned by the card.** A payment the card itself reversed (a posted payment-kind row on the same card adding
 *   exactly its amount back, from the payment's day to `returnDays` after: the bank refused the pull) was never paid,
 *   so it needs no checking debit. It is settled as returned, and listed so, only where the payment has no checking
 *   candidate of its own nor an owner's answer; it and the reversal are each the other's only such; the reversal says
 *   the card took a payment back (returned, reversed, dishonoured, misposted, NSF) and names no fee; and both rows'
 *   text is plain ASCII. Else each reversal is offered to the owner with the payment (`possibleReversals`): a
 *   payment-worded charge read as a payment adds an amount back too. A payment its card reversed but that has a
 *   candidate (paid again, with its debit) is matched as any other, and does not compete for the reversal unless its
 *   debit came back (a credit of its amount to its account within `debitReturnDays` after it, so it did not stand):
 *   then the reversal fits it too, and is only offered.
 * - **Bilt.** A debit to Bilt is an ordinary payment to the Bilt card. Bilt charges a housing payment (rent, a
 *   mortgage) to the Bilt card and clears it the same day with a payment it pulls from the bank: the card shows a
 *   housing payment row (a payment whose description, merchant or category says housing, rent, mortgage or loan, as a
 *   whole token: `HOUSINGÉ` does not) and checking a Bilt debit that says so (`bilt-housing`). The two lanes never
 *   cross, in matching, in what is offered and in what the owner may confirm (`crossesBiltLanes`): a housing pull pays
 *   only a Bilt housing payment row, and a housing payment row is paid only by a housing pull, never by any other debit
 *   (an ordinary card payment, one that reads as no card payment, an unknown one). So a same-amount Pay-card payment
 *   beside a housing pull is never taken for it, nor offered. A row whose own lane has no counterpart is a gap with its
 *   reason; a housing pull with no housing row is listed on its own (`biltHousing`), never as a card-payment debit
 *   without its card row. Cardless issues the Bilt card from `biltCardlessFrom`; before it Wells Fargo did, and that
 *   card's history is on the Wells Fargo card account it became. So a debit from before that day naming Bilt (not a
 *   housing pull) pays that Wells Fargo card too (Root, RECON-34), as the rules find it in the rows (`biltCarrier`): the
 *   one Wells Fargo card the debits naming Bilt from then fit (the owner's confirmation, whatever the debit's number says;
 *   a masked number naming it; or a payment of its exact amount within the rules' days; never a pair the owner rejected).
 *   It is then a candidate for that card's payments, and for a Bilt card's with history from then, one to one as ever (two
 *   such payments close by are the owner's). No such card, or several, and it pays no Wells Fargo card, not even one its
 *   number names: only offered, as before. Its masked number is read among the Wells Fargo cards and the Bilt cards with
 *   history from then: the number the Bilt card had then is the Cardless card's now. It is never a candidate for a Bilt
 *   card's payment from that day on.
 * - **A card's product alone (Root, RECON-34 A).** A transfer naming one Wells Fargo card product alone
 *   (`… TO MICRO CENTER`, its words spaced as an issuer's) pays the Wells Fargo card the rows show carries that product
 *   (`productCarriers`), found as the Bilt card's carrier is: the one Wells Fargo card the transfers naming that product
 *   fit. It is then a candidate for that card's payments, one to one as ever. No such card, or several, and it pays
 *   none: only offered, as before. One whose masked number names a Wells Fargo card pays that card, as before.
 *
 * Nothing here is spending: payments stay transfers, and no total of spending reads this. Pure and deterministic:
 * the same rows and decisions give the same answer in any order.
 */
import { isCardPaymentToCard } from './cardPayments.js';
import { mergeCardCoverage, type CardCoverageRange } from './cardSpending.js';
import type { CardTransaction } from './types.js';

export const CARD_PAYMENT_RECONCILIATION_RULES = {
  /** Bumped whenever a rule below or a descriptor rule changes what matches. Stored with every owner decision. */
  version: 6,
  /**
   * Debits dated up to this many days before the payment's transaction date, or this many after it: a bank posts
   * the debit a business day or two either side of the day the issuer credits the card, weekends and holidays included.
   */
  daysBefore: 5,
  daysAfter: 5,
  /** The owner may confirm a pair at most this many days apart, either way. */
  confirmDays: 15,
  /** Debits listed per unmatched payment (and payments per unmatched debit) as possible, for the owner. */
  maxSuggestions: 5,
  /**
   * A payment the card itself reverses within this many days after it (its issuer returning it: the bank refused the
   * pull) is returned, and needs no checking debit (`returned`).
   */
  returnDays: 30,
  /**
   * A checking debit came back (its bank returned it) when a credit of exactly its amount reaches its account within this
   * many days after it: it did not stand, so the payment tied to it competes for the card's reversals too.
   */
  debitReturnDays: 15,
  /**
   * A debit reading RETRY may stand in for a pull its bank returned unpaid dated up to this many days before it (Root,
   * RECON-34 B: `retries`).
   */
  retryDays: 15,
  /**
   * A payer reference identifies a card once at least this many pairs proven without any reference tie it to that
   * card, and none ties it to another (`checkingPayerReference`). Proven pairs are the ones the rules matched alone or
   * the owner confirmed.
   */
  referenceProofs: 2,
  /**
   * The first day Cardless issues the Bilt card (see cardImportTool/biltCsv.ts). Before it Wells Fargo did, and that card's
   * history is on the Wells Fargo card account it became; the Cardless card kept its number. So a debit naming Bilt
   * dated before this day pays that Wells Fargo card, as the rows show it (Root, RECON-34: `biltCarrier`), and a payment
   * on a Bilt card dated on or after this day is never paid by a debit dated before it, whatever the debit names.
   */
  biltCardlessFrom: '2026-02-07',
} as const;

/**
 * The issuers a checking descriptor can name; `unrecognized`, a card payment naming a payee the rules do not know (any
 * word but payment, card and transfer words and plain numbers); and `several`, one naming more than one issuer. Only a
 * single issuer named by an exact alias identifies a card: the other two never pay a card by themselves.
 */
export const CARD_PAYMENT_PAYEES = [
  'amex', 'apple', 'bankofamerica', 'barclays', 'bilt', 'capitalone', 'cardless', 'chase', 'citi', 'discover',
  'fifththird', 'synchrony', 'usbank', 'wellsfargo', 'unrecognized', 'several',
] as const;
export type CardPaymentPayee = (typeof CARD_PAYMENT_PAYEES)[number];

export const CARD_PAYMENT_PAYEE_LABELS: Readonly<Record<CardPaymentPayee, string>> = Object.freeze({
  amex: 'American Express',
  apple: 'Apple Card',
  bankofamerica: 'Bank of America',
  barclays: 'Barclays',
  bilt: 'Bilt',
  capitalone: 'Capital One',
  cardless: 'Cardless',
  chase: 'Chase',
  citi: 'Citi',
  discover: 'Discover',
  fifththird: 'Fifth Third',
  synchrony: 'Synchrony',
  usbank: 'U.S. Bank',
  wellsfargo: 'Wells Fargo',
  unrecognized: 'Unrecognized issuer',
  several: 'More than one issuer',
});

/**
 * What a checking debit is, read from its descriptor:
 * - `card-payment`: a payment to a credit card, naming one issuer (`payee`), more than one (`several`, with each in
 *   `payees`), a payee the rules do not recognize (`unrecognized`), or none at all (null);
 * - `bilt-housing`: rent or a mortgage Bilt pulled from the bank to clear a housing charge on the Bilt card the same
 *   day. Only a descriptor that names Bilt alone and says so (rent, mortgage, loan, housing, BiltProtect); any other
 *   debit to Bilt pays the Bilt card. It pays only a Bilt housing payment row (`isBiltHousingPayment`);
 * - `other`: anything else: transfers, bills, loans and mortgages, money sent to people, debit card purchases, checks.
 */
export type CheckingDebitClass = 'card-payment' | 'bilt-housing' | 'other';

export interface CheckingDebitClassification {
  class: CheckingDebitClass;
  /**
   * The issuer the descriptor names, for a card payment (`several` when it names more than one, `unrecognized` for a
   * payee the rules do not know, null when it names none at all) and a Bilt housing pull; else null.
   */
  payee: CardPaymentPayee | null;
  /** For `several`: every issuer it names, each by an exact alias. */
  payees?: CardPaymentPayee[];
  /** The descriptor rule that decided, for tests and reviews. */
  rule: string;
}

/** Words that pay a card, in full or as banks abbreviate them. */
const PAYS = /\b(?:EPAYMENT|E PAYMENT|EPAY|E PAY|ACH PMT|PMT|PYMT|PYMNT|PAYMT|PMNT|PAYMENT|AUTOPAY|AUTO PAY)\b/;
const BILT = /\bBILT(?:REWARDS|CARD|PROTECT)?\b/;
/** Bilt housing: rent or a mortgage pulled from the bank (BiltProtect, Bilt Rent, a mortgage through Bilt). */
const HOUSING = /\b(?:RENT|RENTAL|MORTGAGE|MTG|HOUSING|HOMELOAN|HOME LOAN|LOAN|LEASE|BILTPROTECT)\b/;
/** Money sent to people: never a card payment, whatever a name in it says. */
const PEOPLE = /\b(?:ZELLE|VENMO|PAYPAL|CASH APP|SQUARE CASH|SQ CASH)\b/;
/** A purchase with the checking account's own debit card (at any merchant, an issuer's name included). */
const DEBIT_CARD = /\b(?:PURCHASE AUTHORIZED ON|RECURRING PAYMENT AUTHORIZED ON|PURCHASE RETURN|POS PURCHASE|DEBIT CARD PURCHASE|CHECKCARD|CHECK CARD)\b/;
/** A loan or mortgage paid to a bank that also issues cards. */
const LOANS = /\b(?:MORTGAGE|MTG|HOME LOAN|HOMELOAN|AUTO LOAN|LOAN|STUDENT|LEASE|HELOC)\b/;
/** A transfer to a card (Wells Fargo's own online transfers to its cards read this way). */
const TRANSFER_TO_CARD = /\bTRANSFER\b.*\bTO\b.*\b(?:CARD|VISA|MASTERCARD)\b/;

interface PayeeRule {
  payee: CardPaymentPayee;
  /** The issuer's name, as banks print it. */
  name: RegExp;
  /** Its own payment words; the generic card-payment words count as well. */
  pays: RegExp;
}

/**
 * The issuers' names and their own payment words, as banks print them (digits never matter). A name is an exact alias
 * from this fixed list, read as whole tokens, the words of a longer one adjacent with ASCII whitespace alone between
 * them (`CAPITAL ONE`, never `CAPITAL-ONE`, `CAPITAL+ONE`, a lone `CAPITAL`, a cut-off `AMERICAN EXP` or a lookalike
 * `AMERICAN EXPEDITING`): only such a name identifies an issuer, and only an identified issuer's debit is ever matched
 * by the rules. A card's product name (`AUTOGRAPH`, `ACTIVE CASH`, `REFLECT`, `MICRO CENTER`) is no issuer's alias: it
 * names one card, not its issuer, so only beside the issuer's own name does it count, as a payment word. The first rule
 * whose name the descriptor carries decides: a payment if the issuer's payment words or the generic ones are there
 * too, else anything but a card payment (a transfer to the issuer's bank, say). A descriptor naming an issuer never
 * falls through to "names no issuer".
 */
const PAYEE_RULES: readonly PayeeRule[] = [
  { payee: 'amex', name: /\b(?:AMEX|AMERICAN EXPRESS|AMERICANEXPRESS)\b/, pays: PAYS },
  { payee: 'citi', name: /\b(?:CITI|CITICARD|CITICARDS|CITIBANK)\b/, pays: /\b(?:AUTOPAY|AUTO PAY|PAYMENT|PMT|PYMT|CARD|CRD)\b/ },
  { payee: 'chase', name: /\bCHASE\b/, pays: /\b(?:CRD|CARD|EPAY|E PAY|AUTOPAY|AUTO PAY)\b/ },
  { payee: 'discover', name: /\b(?:DISCOVER|DISC BANK)\b/, pays: PAYS },
  { payee: 'capitalone', name: /\b(?:CAPITAL ONE|CAPITALONE|CAP ONE|CAPONE)\b/, pays: /\b(?:PMT|PYMT|PAYMENT|AUTOPAY|AUTO PAY|CRCARDPMT)\b/ },
  { payee: 'barclays', name: /\b(?:BARCLAYCARD|BARCLAYS)\b/, pays: /\b(?:CREDITCARD|CREDIT CARD|CARD|PAYMENT|PMT)\b/ },
  { payee: 'apple', name: /\b(?:APPLECARD|APPLE CARD|GSBANK|GS BANK)\b/, pays: PAYS },
  { payee: 'synchrony', name: /\b(?:SYNCHRONY|SYNCB)\b/, pays: PAYS },
  { payee: 'bankofamerica', name: /\b(?:BK OF AMER|BK AMER|BANK OF AMERICA|BOFA)\b/, pays: /\b(?:VISA|MC|CARD|CRD)\b/ },
  { payee: 'usbank', name: /\b(?:US BANK|USBANK|U S BANK)\b/, pays: /\b(?:VISA|CARD|CRD)\b/ },
  { payee: 'fifththird', name: /\b(?:FIFTH THIRD|FIFTHTHIRD)\b/, pays: /\b(?:CARD|CRD|CREDIT CARD)\b/ },
  { payee: 'cardless', name: /\bCARDLESS\b/, pays: /\b(?:CARD|PAYMENT|PMT)\b/ },
  { payee: 'wellsfargo', name: /\b(?:WF|WELLS FARGO)\b/, pays: /\b(?:CREDIT CARD|CARD|CRD|VISA|MASTERCARD|AUTOGRAPH|ACTIVE CASH|REFLECT|MICRO CENTER)\b/ },
];

/**
 * An online transfer to a card named by its product alone (Wells Fargo's to its own cards, `… TO MICRO CENTER …`):
 * a card payment, but to one card of possibly several, its issuer not named. It pays only the one Wells Fargo card the
 * rows show carries that product (`productCarriers`; Root, RECON-34 A); with none, it is only offered to the owner.
 */
const TRANSFER_TO_PRODUCT = /\bTRANSFER\b.*\bTO\b.*\b(?:AUTOGRAPH|ACTIVE CASH|REFLECT|MICRO CENTER)\b/;
/** The Wells Fargo card products a transfer may name alone (`TRANSFER_TO_PRODUCT`), each read as whole, spaced words. */
const CARD_PRODUCTS = ['AUTOGRAPH', 'ACTIVE CASH', 'REFLECT', 'MICRO CENTER'] as const;
/** A debit that says it is a bank's second try at a pull (`AMEX EPAYMENT RETRY PYMT`, `CITI AUTOPAY PAYMENT RETRY`). */
const RETRY = /\bRETRY\b/;

/** A payment to some card naming no issuer the rules know: never matched by itself (`namesNoPayee` tells the two kinds apart). */
const GENERIC = /\b(?:CREDIT CARD|CREDITCARD|CRCARDPMT|CRD PMT|CARD PMT|CARD PAYMENT|CC PMT|CC PAYMENT|CARD AUTOPAY|CARD AUTO PAY)\b/;

/**
 * The only words a descriptor naming no payee at all may carry: payment, card, transfer and bank-format words. With
 * any other word (an issuer the rules do not know, a bank, a name, a word with a digit in it such as `M1` or `N26`) it
 * may name a payee (`unrecognized`). Either way it pays no card by itself: the owner may confirm it.
 */
const ISSUER_FREE_WORDS = new Set([
  'A', 'ACCOUNT', 'ACCT', 'ACH', 'AUTO', 'AUTOPAY', 'BILL', 'BILLPAY', 'CARD', 'CARDS', 'CC', 'CCD', 'CO', 'CONF',
  'CONFIRMATION', 'CR', 'CRCARDPMT', 'CRD', 'CREDIT', 'CREDITCARD', 'DEBIT', 'DES', 'E', 'EPAY', 'EPAYMENT', 'FOR', 'FROM',
  'ID', 'INDN', 'INTERNET', 'LINE', 'MC', 'MASTERCARD', 'MOBILE', 'NO', 'NUMBER', 'OF', 'ON', 'ONLINE', 'PAY', 'PAYMENT',
  'PAYMENTS', 'PAYMT', 'PHONE', 'PMNT', 'PMT', 'PPD', 'PYMNT', 'PYMT', 'RECURRING', 'REF', 'SCHEDULED', 'TEL', 'THE', 'TO',
  'TRANSFER', 'VISA', 'WEB', 'WWW', 'XFER',
]);
/** A plain number of four or more digits (a reference, a date, a masked number's last four), or a mask of X. */
const REFERENCE = /^(?:\d{4,}|X{2,}\d{0,4})$/;

/** True when a normalized descriptor carries nothing but issuer-free words, references and masks. */
function namesNoPayee(text: string): boolean {
  return text.split(' ').every((word) => REFERENCE.test(word) || ISSUER_FREE_WORDS.has(word));
}

/**
 * What separates tokens: ASCII whitespace and ASCII punctuation, nothing else. A letter, mark or digit in any script, a
 * symbol, an emoji or a control character is part of its token, so `HOUSINGÉ`, `CITI©` and `CAPITAL💰ONE` are each one
 * token, never `HOUSING`, `CITI` or `CAPITAL ONE`.
 */
const SEPARATOR = /([\t\n\v\f\r\x20-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]+)/;
const ASCII_WHITESPACE = /^[\t\n\v\f\r ]+$/;
/**
 * Text the rules may identify anything in: printable ASCII and ASCII whitespace alone. Anything else (any other letter,
 * mark or digit, a symbol, an emoji, `©`, `€`, U+FFFD, a hidden or control character) leaves it unproven: never matched
 * by itself, at most offered to the owner.
 */
const PLAIN_ASCII = /^[\t\n\v\f\r\x20-\x7E]*$/;
const ASCII_WORD = /^[A-Z0-9]+$/;

interface Token {
  /** The token, its ASCII letters upper-cased and nothing else changed. */
  text: string;
  /** Whether ASCII whitespace alone separates it from the token before. */
  spaced: boolean;
}

function tokensOf(text: unknown): Token[] {
  if (typeof text !== 'string') return [];
  // Split with a capturing group: token, separator, token, …; only the first and the last token can be empty.
  const parts = text.split(SEPARATOR);
  const tokens: Token[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    if (parts[index] === '') continue;
    tokens.push({
      text: parts[index].replace(/[a-z]+/g, (letters) => letters.toUpperCase()),
      spaced: index > 0 && ASCII_WHITESPACE.test(parts[index - 1]),
    });
  }
  return tokens;
}

/**
 * A descriptor's tokens one space apart, ASCII letters upper-cased. Nothing is deleted or changed but separators and
 * ASCII case: `E-PAYMENT` reads `E PAYMENT`, `***1234` reads `1234`, and `CITIÉ` or `CAPITAL💰ONE` stays one token.
 */
export function normalizeCheckingDescriptor(description: string): string {
  return tokensOf(description).map((token) => token.text).join(' ');
}

/** A token as the word patterns read it: plain ASCII letters and digits as itself, anything else an opaque `~`. */
function wordOf(token: Token): string {
  return ASCII_WORD.test(token.text) ? token.text : '~';
}

/**
 * The words one space apart, whatever ASCII separates them (`E-PAYMENT` reads `E PAYMENT`): what says a debit pays a
 * card, sends money to people or pays a loan.
 */
function wordText(tokens: readonly Token[]): string {
  return tokens.map(wordOf).join(' ');
}

/**
 * The words one space apart only where ASCII whitespace alone separates them, else ` ~ `: what names an issuer or a
 * housing payment. A single word matches a whole token wherever it stands; a name of several words only those words
 * adjacent as written, so `CAPITAL+ONE`, `CAPITAL-ONE` and `CAPITAL € ONE` are never `CAPITAL ONE`.
 */
function nameText(tokens: readonly Token[]): string {
  return tokens.map((token, index) => (index === 0 ? '' : token.spaced ? ' ' : ' ~ ') + wordOf(token)).join('');
}

/** Whether a descriptor's words say it pays some card, whoever's: an unproven one is read for nothing more. */
function paysSomeCard(text: string): boolean {
  return PAYS.test(text) || GENERIC.test(text) || TRANSFER_TO_CARD.test(text) || TRANSFER_TO_PRODUCT.test(text)
    || PAYEE_RULES.some((rule) => rule.name.test(text) && rule.pays.test(text));
}

/** What a checking debit's descriptor says it is (see {@link CheckingDebitClass}). */
export function classifyCheckingDebit(description: string): CheckingDebitClassification {
  const tokens = tokensOf(description);
  if (tokens.length === 0) return { class: 'other', payee: null, rule: 'empty' };
  const text = wordText(tokens);
  const names = nameText(tokens);
  if (PEOPLE.test(text)) return { class: 'other', payee: null, rule: 'people' };
  if (DEBIT_CARD.test(text)) return { class: 'other', payee: null, rule: 'debit-card' };
  // Unproven: read only for whether it pays a card at all; no issuer or housing pull is ever named from it.
  const unproven = (rule: string): CheckingDebitClassification => (paysSomeCard(text)
    ? { class: 'card-payment', payee: 'unrecognized', rule }
    : { class: 'other', payee: null, rule });
  if (!PLAIN_ASCII.test(description)) return unproven('not-ascii');
  const rules = PAYEE_RULES.filter((rule) => rule.name.test(names));
  const bilt = BILT.test(names);
  const named = [...new Set<CardPaymentPayee>([...(bilt ? ['bilt' as const] : []), ...rules.map((rule) => rule.payee)])].sort();
  // A name read only across punctuation or a symbol (`CAPITAL-ONE`, `CAPITAL+ONE`, `WELLS/FARGO`) is no alias.
  if (PAYEE_RULES.some((rule) => !named.includes(rule.payee) && rule.name.test(text))) return unproven('split-name');
  const generic = GENERIC.test(text) || TRANSFER_TO_CARD.test(text);
  if (bilt && HOUSING.test(names)) {
    // A housing pull only where it names Bilt alone and says so; naming another issuer too, it is neither.
    return named.length === 1
      ? { class: 'bilt-housing', payee: 'bilt', rule: 'bilt-housing' }
      : { class: 'other', payee: null, rule: 'bilt-housing-several-issuers' };
  }
  // Any other debit to Bilt alone pays the Bilt card.
  if (bilt && named.length === 1) return { class: 'card-payment', payee: 'bilt', rule: 'bilt' };
  if (LOANS.test(text)) return { class: 'other', payee: null, rule: 'loan' };
  if (named.length > 1) {
    // More than one issuer named: none is identified. The owner decides; the rule list's order never does.
    return bilt || generic || rules.some((rule) => rule.pays.test(text))
      ? { class: 'card-payment', payee: 'several', payees: named, rule: 'several-issuers' }
      : { class: 'other', payee: null, rule: 'several-issuers-not-a-payment' };
  }
  if (rules.length > 0) {
    const payee = rules[0].payee;
    return generic || rules.some((rule) => rule.pays.test(text))
      ? { class: 'card-payment', payee, rule: payee }
      : { class: 'other', payee: null, rule: `${payee}-not-a-payment` };
  }
  // A card's product name alone names a card, not its issuer.
  if (TRANSFER_TO_PRODUCT.test(text)) return { class: 'card-payment', payee: 'unrecognized', rule: 'product-name' };
  if (generic) {
    return namesNoPayee(text)
      ? { class: 'card-payment', payee: null, rule: 'generic' }
      : { class: 'card-payment', payee: 'unrecognized', rule: 'generic-named' };
  }
  return { class: 'other', payee: null, rule: 'other' };
}

/** A masked card number as banks print it: X's, then the last four digits (`XXXXXX1234`). */
const MASKED_CARD_NUMBER = /^X{2,}(\d{4})$/;
/** The issuer of the card products a transfer may name alone (`… TO MICRO CENTER`): Wells Fargo's. */
const PRODUCT_ISSUER: CardPaymentPayee = 'wellsfargo';

/**
 * The last four digits of each masked card number a descriptor prints, as whole tokens (`XXXXXX1234` gives `1234`),
 * sorted and once each. They may name the card paid, or the account that pays (a bank prints its own account's number
 * on its debits too): only the reconciliation, which knows both, reads them for a card.
 */
export function maskedCardNumbers(description: string): string[] {
  const numbers = new Set<string>();
  for (const token of tokensOf(description)) {
    const masked = MASKED_CARD_NUMBER.exec(token.text);
    if (masked) numbers.add(masked[1]);
  }
  return [...numbers].sort();
}

/** A run of asterisks masking all but a last four (`***1234`, as Holdr's redaction and some banks print it). */
const ASTERISK_LAST4 = /\*+([0-9]{4})(?![0-9])/g;
const DIGITS_ONLY = /^[0-9]+$/;

/** An eight-digit date, as YYYYMMDD or MMDDYYYY: never a reference. */
function isEightDigitDate(text: string): boolean {
  return dayNumber(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`) !== null
    || dayNumber(`${text.slice(4)}-${text.slice(0, 2)}-${text.slice(2, 4)}`) !== null;
}

/**
 * A checking debit's payer reference: what its descriptor says about who paid which account, the same on every payment
 * of one autopay or payee (`CHASE CREDIT CRD AUTOPAY #1234 SAMPLE HOLDER`). It keeps the descriptor's words, upper-cased,
 * and its reference numbers. A masked number (`XXXXXX1234`, `***1234`) or a number of seven digits or more is read as
 * `#` and its last four, so a full and a masked copy agree. An identifier mixing letters with four digits or more
 * (`W1234`) is kept as written. Everything else that holds a digit is left out, since it may change from one payment to
 * the next: dates, times, years, check and sequence numbers, eight-digit dates. Null for a descriptor with no reference
 * number, or anything but plain ASCII.
 */
export function checkingPayerReference(description: unknown): string | null {
  if (typeof description !== 'string' || !PLAIN_ASCII.test(description)) return null;
  const parts: string[] = [];
  let numbered = false;
  for (const { text } of tokensOf(description.replace(ASTERISK_LAST4, ' XX$1 '))) {
    const digits = text.replace(/[^0-9]/g, '').length;
    if (digits === 0) {
      parts.push(text);
      continue;
    }
    const masked = MASKED_CARD_NUMBER.exec(text);
    const reference = masked ? `#${masked[1]}`
      : DIGITS_ONLY.test(text) ? (text.length >= 7 && !(text.length === 8 && isEightDigitDate(text)) ? `#${text.slice(-4)}` : null)
        : digits >= 4 ? text : null;
    if (reference === null) continue;
    parts.push(reference);
    numbered = true;
  }
  return numbered ? parts.join(' ') : null;
}

/**
 * Card account issuer slugs a payee's payments may be for, compared without separators and case: the whole slug
 * (`wells-fargo` reads `wellsfargo`), or its first part (`citi-costco` is a Citi card; `citizens` is not). Each payee
 * names only its own issuer's cards, however they are spelled: no issuer stands in for another (a payment to Bilt never
 * pays a Wells Fargo card, nor the other way round, save one from before Cardless issued the Bilt card, which pays the
 * Wells Fargo card that carried it: `cardPaymentPayeeMayPay`). Neither `unrecognized` nor `several` names any.
 */
const PAYEE_ISSUERS: Readonly<Record<CardPaymentPayee, readonly string[]>> = Object.freeze({
  amex: ['amex', 'americanexpress'],
  apple: ['apple', 'applecard'],
  bankofamerica: ['bankofamerica', 'bofa'],
  barclays: ['barclays', 'barclaycard'],
  bilt: ['bilt'],
  capitalone: ['capitalone'],
  cardless: ['cardless'],
  chase: ['chase'],
  citi: ['citi', 'citibank'],
  discover: ['discover'],
  fifththird: ['fifththird'],
  synchrony: ['synchrony'],
  usbank: ['usbank'],
  wellsfargo: ['wellsfargo'],
  unrecognized: [],
  several: [],
});

/** A card account's issuer slug as the aliases are compared: the whole of it and its first part, letters and digits only. */
function issuerKeys(issuer: unknown): string[] {
  if (typeof issuer !== 'string') return [];
  const lower = issuer.toLowerCase();
  const whole = lower.replace(/[^a-z0-9]/g, '');
  const first = lower.split(/[^a-z0-9]+/).find((part) => part.length > 0) ?? '';
  return [...new Set([whole, first].filter((key) => key.length > 0))];
}

/**
 * True when a debit naming `payee` identifies a card of `issuer` (a card account's slug), so the rules may pair them by
 * themselves. Never for a debit naming no issuer (null), one the rules do not know (`unrecognized`) or more than one
 * (`several`): those are at most offered to the owner.
 */
export function cardPaymentPayeeMatchesIssuer(payee: CardPaymentPayee | null, issuer: string): boolean {
  if (payee === null) return false;
  return issuerKeys(issuer).some((key) => PAYEE_ISSUERS[payee].includes(key));
}

/** Whether a debit dated `date` (YYYY-MM-DD) is from before Cardless issued the Bilt card (`biltCardlessFrom`). */
function beforeBiltCardless(date: unknown): boolean {
  return typeof date === 'string' && ISO_DATE.test(date) && date < CARD_PAYMENT_RECONCILIATION_RULES.biltCardlessFrom;
}

/**
 * True when a debit naming `payee`, dated `date` (YYYY-MM-DD), may pay `card` (a card account's id and issuer slug) by
 * the rules: as `cardPaymentPayeeMatchesIssuer`, save that a debit naming Bilt from before Cardless issued the Bilt card
 * also pays the Wells Fargo card account that carried the Bilt card then (Root, RECON-34): `biltCarrier`, as the
 * reconciliation derives it from the rows (`CardPaymentReconciliation.biltCarrier`; null when it finds none). From that
 * day on Bilt names only its own cards.
 */
export function cardPaymentPayeeMayPay(
  payee: CardPaymentPayee | null,
  date: string,
  card: { id: string; issuer: string },
  biltCarrier: string | null,
): boolean {
  return cardPaymentPayeeMatchesIssuer(payee, card.issuer)
    || (payee === 'bilt' && biltCarrier !== null && card.id === biltCarrier && beforeBiltCardless(date));
}

/** The Bilt card: the only card Bilt runs housing payments through. */
function isBiltCard(issuer: string): boolean {
  return cardPaymentPayeeMatchesIssuer('bilt', issuer);
}

/**
 * True for a payment row on a Bilt card that clears a housing charge (its description, merchant or category says
 * housing, rent, mortgage or loan, as a whole word: `HOUSINGÉ` does not): Bilt funds it from the bank the same day, so
 * its checking debit is a Bilt housing pull, never an ordinary Pay-card payment.
 */
export function isBiltHousingPayment(
  row: Partial<Pick<CardTransaction, 'description' | 'merchant' | 'issuerCategory'>> & Pick<CardTransaction, 'kind'>,
  issuer: string,
): boolean {
  if (!row || row.kind !== 'payment' || !isBiltCard(issuer)) return false;
  return cardTextFields(row).some((text) => HOUSING_PAYMENT.test(nameText(tokensOf(text))));
}

/** The words a Bilt housing payment row carries. */
const HOUSING_PAYMENT = /\b(?:HOUSING|RENT|RENTAL|MORTGAGE|MTG|LOAN|HOMELOAN|HOME LOAN)\b/;

/** A card row's own text: its description, merchant and the issuer's category. */
function cardTextFields(row: Partial<Pick<CardTransaction, 'description' | 'merchant' | 'issuerCategory'>>): unknown[] {
  return [row.description, row.merchant, row.issuerCategory];
}

/**
 * Whether the rules may pair a card row by themselves: its description, merchant and category are each plain ASCII
 * (or absent). Anything else in any of them (a letter, mark or digit beyond ASCII, a symbol, an emoji, a hidden
 * character) leaves the row to the owner: it keeps its candidates, so whatever group it is in goes to the owner.
 */
function cardTextIsPlain(row: Partial<Pick<CardTransaction, 'description' | 'merchant' | 'issuerCategory'>>): boolean {
  return cardTextFields(row).every((text) => text === null || text === undefined || (typeof text === 'string' && PLAIN_ASCII.test(text)));
}

/**
 * The words that say a card took a payment back (returned, reversed, dishonoured, misposted; NSF), as card insights and
 * the converter read them; and a fee's (`RETURNED PAYMENT FEE` is a charge for one, not one).
 */
const TAKEN_BACK = /\b(?:RETURN\w*|REVERS\w*|DISHONOU?R\w*|MISPOST\w*|NSF)\b/;
const FEE = /\b(?:FEE|FEES)\b/;

/**
 * Whether a card row adding a payment's amount back reads, by itself, as the card taking that payment back: its
 * description or merchant, each on its own, says so and neither names a fee, and its text is plain ASCII. A
 * payment-worded charge read as a payment (`AUTOPAY PAYMENT` at a biller) does not: the rules never settle a payment
 * on it, only offer it to the owner.
 */
function readsAsReturnedPayment(row: ReconciliationCardRow): boolean {
  const words = [row.description, row.merchant].map((text) => wordText(tokensOf(text)));
  return cardTextIsPlain(row) && words.some((text) => TAKEN_BACK.test(text)) && !words.some((text) => FEE.test(text));
}

/** The words that say a bank returned an item unpaid, on a checking credit: the card's words, and UNPAID. */
const ITEM_RETURNED = /\b(?:RETURN\w*|REVERS\w*|DISHONOU?R\w*|MISPOST\w*|NSF|UNPAID)\b/;

/**
 * Whether a checking credit reads, by itself, as an item its bank returned unpaid (`UNPAID ITEM RETURN`, `RETURNED
 * ITEM`, `ACH RETURN`, `NSF`): plain ASCII, saying so, and naming no fee. A credit that does not say so (a transfer
 * back, a refund) never marks a pull returned.
 */
export function checkingCreditReadsAsReturnedItem(description: unknown): boolean {
  if (typeof description !== 'string' || !PLAIN_ASCII.test(description)) return false;
  const text = wordText(tokensOf(description));
  return ITEM_RETURNED.test(text) && !FEE.test(text);
}

/**
 * The words that say a payment row is a credit the card gave, not a payment to it: a refund, cash back or a redemption,
 * an adjustment, a dispute or a chargeback, a provisional, statement or courtesy credit.
 */
const CREDITED = /\b(?:REFUND\w*|CASHBACK|CASH BACK|REDEEM\w*|REDEMPTION\w*|ADJUST\w*|ADJ|DISPUTE\w*|CHARGEBACK\w*|PROVISIONAL|STATEMENT CREDIT|COURTESY CREDIT)\b/;

/**
 * The words that say a payment row is no payment that stood: the card took it back (`TAKEN_BACK`'s words), it was never
 * paid (UNPAID), or it failed (failed, declined, rejected, bounced, void, cancelled, a stop payment). For the
 * interchangeable-rows kind guard only, where it holds a group for the owner and settles nothing; what settles a payment
 * as returned by the card (`readsAsReturnedPayment`) reads `TAKEN_BACK` alone.
 */
const NOT_PAID = /\b(?:RETURN\w*|REVERS\w*|DISHONOU?R\w*|MISPOST\w*|NSF|UNPAID|FAIL\w*|DECLIN\w*|REJECT\w*|BOUNCE\w*|VOID\w*|CANCEL\w*|STOP PAYMENT)\b/;

/**
 * What a payment row reads as by its own words, for the interchangeable-rows rule (Root 04:24Z): an ordinary card
 * payment (`payment`), a Bilt housing payment (`housing`), no payment that stood (`reversal`: returned, reversed,
 * dishonoured, misposted, NSF, unpaid, failed, declined, rejected, bounced, void, cancelled, a stop payment), a credit or
 * a fee (`credit`), or nothing the rules read (`unread`: no description, or text that is not plain ASCII). Its
 * description and merchant are read, each on its own.
 */
export type CardPaymentRowKind = 'payment' | 'housing' | 'reversal' | 'credit' | 'unread';

export function cardPaymentRowKind(row: ReconciliationCardRow, issuer: string): CardPaymentRowKind {
  if (!row || typeof row.description !== 'string' || row.description.trim() === '' || !cardTextIsPlain(row)) return 'unread';
  const words = [row.description, row.merchant].map((text) => wordText(tokensOf(text)));
  if (words.some((text) => NOT_PAID.test(text))) return 'reversal';
  if (words.some((text) => CREDITED.test(text) || FEE.test(text))) return 'credit';
  return isBiltHousingPayment(row, issuer) ? 'housing' : 'payment';
}

/** The words that say a payment, or the debit that paid it, was automatic: AUTOPAY, AUTO PAY, AUTOMATIC. */
const AUTO_CUE = /\b(?:AUTOPAY\w*|AUTOMATIC\w*|AUTO)\b/;
/** The words that say it was made online: ONLINE, WEB, INTERNET, MOBILE. */
const ONLINE_CUE = /\b(?:ONLINE|WEB|INTERNET|MOBILE)\b/;

/**
 * The channel a payment row's or a checking debit's own description names, where it names exactly one: an automatic
 * payment (`auto`) or one made online (`online`). Null where it names neither or both, or its text is not plain ASCII.
 * The interchangeable-rows rule's description cue (Root 04:24Z).
 */
export function paymentChannelCue(description: unknown): 'auto' | 'online' | null {
  if (typeof description !== 'string' || !PLAIN_ASCII.test(description)) return null;
  const words = wordText(tokensOf(description));
  const auto = AUTO_CUE.test(words);
  const online = ONLINE_CUE.test(words);
  return auto === online ? null : auto ? 'auto' : 'online';
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------------------------

export type ReconciliationCardRow = Pick<CardTransaction,
  'id' | 'cardAccountId' | 'transactionDate' | 'status' | 'amountMinor' | 'currency' | 'kind'>
  & Partial<Pick<CardTransaction, 'description' | 'merchant' | 'issuerCategory' | 'postedDate'>>;

export interface ReconciliationCardAccount {
  id: string;
  /** The card account's issuer slug (`amex`, `citi`, `bilt`, …). */
  issuer: string;
  /** The card's last four digits, as Holdr stores them: what a masked card number in a debit names. */
  last4?: string | null;
  /** An Amex's last five, read for its last four when `last4` is missing. */
  last5?: string | null;
}

export interface ReconciliationCheckingAccount {
  id: string;
  /**
   * The checking account's own last four digits. A bank prints them, masked, on its own debits (the account that pays),
   * so they never name a card.
   */
  last4?: string | null;
}

/** A checking account row: the checking ledger's own shape (`amountMinor` negative for money out). */
export interface ReconciliationCheckingRow {
  id: string;
  checkingAccountId: string;
  /** YYYY-MM-DD, the bank's posting date. */
  date: string;
  status: 'pending' | 'posted' | 'removed';
  amountMinor: number;
  currency: string;
  description: string;
}

export type CardPaymentDecisionKind = 'confirmed' | 'rejected' | 'elsewhere' | 'not-card-payment';
export const CARD_PAYMENT_DECISION_KINDS: readonly CardPaymentDecisionKind[] = ['confirmed', 'rejected', 'elsewhere', 'not-card-payment'];

/**
 * An owner decision in force: `confirmed` and `rejected` name a payment and a debit, `elsewhere` a payment (paid from
 * another account), `not-card-payment` a debit.
 */
export interface CardPaymentDecision {
  id: string;
  decision: CardPaymentDecisionKind;
  cardTransactionId: string | null;
  checkingTransactionId: string | null;
  /** The payment's (and debit's) amount when decided: negative minor units. */
  amountMinor: number;
  currency: string;
  /** ISO instant; decisions apply oldest first. */
  createdAt: string;
}

export interface CardPaymentCoverage {
  /** A card account's or checking account's id. */
  accountId: string;
  /** Inclusive YYYY-MM-DD ranges known to be stored in full (any order, may overlap). */
  ranges: readonly CardCoverageRange[];
}

export interface CardPaymentReconciliationInput {
  cardAccounts: readonly ReconciliationCardAccount[];
  /** Card rows of any kind and status: only payments to the card are read. */
  cardRows: readonly ReconciliationCardRow[];
  checkingAccounts: readonly ReconciliationCheckingAccount[];
  /** Checking rows of any kind: only posted money out is read. */
  checkingRows: readonly ReconciliationCheckingRow[];
  /** The owner's decisions in force (revoked ones left out). */
  decisions?: readonly CardPaymentDecision[];
  cardCoverage?: readonly CardPaymentCoverage[];
  checkingCoverage?: readonly CardPaymentCoverage[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------------

/** A payment and its debit: matched by the rules, or confirmed by the owner. */
export interface CardPaymentPair {
  paymentId: string;
  debitId: string;
  /** Calendar days from the payment's transaction date to the debit's date; negative when the debit came first. */
  dayOffset: number;
  status: 'matched' | 'confirmed';
  /** The owner's decision, for a confirmed pair. */
  decisionId?: string;
  /**
   * For a pair matched inside a group held for the owner, why it was matched. `interchangeable`: the group's `payments`
   * payments are interchangeable rows (one card, day, amount and kind of card payment, the same candidates; their
   * descriptions may differ), so whichever debit pays which changes no figure; `pairedBy` says whether a description cue
   * chose this pair (`cue`) or canonical order did (`order`). `reference`: its debit's payer reference identifies the
   * payment's card, tied to it by `proofs` proven pairs and to no other card. `remainder`: it was what was left of that
   * group once the pairs matched by reference were taken out. Absent for every other pair.
   */
  evidence?: CardPaymentPairEvidence;
}

export type CardPaymentPairEvidence =
  | { basis: 'interchangeable'; payments: number; pairedBy: 'cue' | 'order' }
  | { basis: 'reference'; proofs: number }
  | { basis: 'remainder' };

/** The first condition of the interchangeable-rows rule a held group failed (`CardPaymentHeldGroupCheck`). */
export type CardPaymentInterchangeRefusal =
  | 'one-payment' | 'more-debits' | 'cards' | 'dates' | 'amounts' | 'kinds' | 'candidates';

/**
 * A pull its bank returned unpaid, netted with its return: a posted credit of exactly its amount to its account, from
 * its day to `debitReturnDays` after, that reads as an item returned, each the other's only such. It paid no card, so
 * it is no candidate, no gap, and in none of the totals' debit parts but its own (`debits.returned`).
 */
export interface ReturnedCheckingDebit {
  debitId: string;
  /** The checking credit that returned it. */
  creditId: string;
  /** Days from the debit to its return. */
  dayOffset: number;
}

/**
 * A pair rules version 3 matched by itself that this version does not: its debit came back unpaid (`returned`); else the
 * owner answered a pair of its group (`answered`); else this version reads a row of its group otherwise than version 3
 * did (`reread`: a debit naming Bilt from before Cardless issued the Bilt card as paying that card's carrier, or a card
 * product named alone as paying the card that carries it, which may then pay a payment beside it). For the operator's
 * report; the API does not show it.
 */
export interface CardPaymentWithheldPair {
  paymentId: string;
  debitId: string;
  reason: 'answered' | 'returned' | 'reread';
}

/**
 * What became of one group the rules alone held for the owner (for the operator's report; the API does not show it).
 * - `interchangeable`: settled as interchangeable rows; `orphanPayments` were left with no debit.
 * - `reference`: settled by payer references and what was left; `partly`: some pairs were, the rest is still held.
 * - `held`: still held in full. `held` says why. No rule read it because the owner answered a pair of it (`answered`:
 *   a rejection anywhere in the group, Undo included), it holds a pull its bank returned unpaid (`returned`), a pull
 *   that came back by any credit of its amount (`came-back`), a debit naming several issuers (`several`) or a payment
 *   whose text is not plain ASCII (`not-plain`). Or no debit's
 *   reference identifies a card of its payments (`unproven`), or some do, but no payment or debit has exactly one such
 *   candidate (`not-unique`).
 */
export interface CardPaymentHeldGroupCheck {
  /** The group's id when the rules held it: its first payment's id (or first debit's). */
  groupId: string;
  paymentIds: string[];
  debitIds: string[];
  outcome: 'interchangeable' | 'reference' | 'partly' | 'held';
  held?: 'answered' | 'returned' | 'came-back' | 'several' | 'not-plain' | 'unproven' | 'not-unique';
  /** Why the interchangeable-rows rule did not apply, where it was read and did not. */
  notInterchangeable?: CardPaymentInterchangeRefusal;
  /** Pairs matched as interchangeable rows, by reference, then as what was left. */
  byInterchange: number;
  byReference: number;
  byRemainder: number;
  /** Payments and debits left with no candidate once those were matched: listed as unmatched. */
  orphanPayments: number;
  orphanDebits: number;
}

/** A candidate pair inside an ambiguous group. */
export interface CardPaymentCandidate {
  paymentId: string;
  debitId: string;
  dayOffset: number;
}

/** Payments and debits whose candidates overlap, so more than one pairing is possible: the owner decides. */
export interface CardPaymentAmbiguity {
  /** Stable while the group's rows stay: its first payment's id (or first debit's). */
  id: string;
  paymentIds: string[];
  debitIds: string[];
  /** Every candidate pair, by payment then offset. */
  candidates: CardPaymentCandidate[];
}

/** Why a payment has no debit. */
export type UnmatchedPaymentReason =
  /** No checking account is in Holdr. */
  | 'no-checking-account'
  /** No checking import covers the payment's date: its debit may be in history not imported yet. */
  | 'checking-not-covered'
  /** Checking is imported for that date and no debit fits: paid from elsewhere, or the descriptor is not recognized. */
  | 'no-checking-debit';

export interface UnmatchedCardPayment {
  paymentId: string;
  reason: UnmatchedPaymentReason;
  /**
   * Free debits of its exact amount, currency and dates the rules did not tie to it (the descriptor names another
   * issuer, none, an unrecognized payee, or does not read as a card payment): possible, for the owner to confirm;
   * never matched by themselves. Never a pair that crosses Bilt's lanes: no housing pull for anything but a Bilt
   * housing payment row, and no card-payment debit for that row.
   */
  possibleDebits: CardPaymentCandidate[];
  /**
   * Reversals on its card that could be its return (`returned`) but are not unique either way: for the owner, never
   * settled by themselves. Absent when there are none.
   */
  possibleReversals?: CardPaymentReversalOption[];
}

/** A reversal on a payment's card that may be its return: `dayOffset` days after the payment. */
export interface CardPaymentReversalOption {
  reversalId: string;
  dayOffset: number;
}

/**
 * A payment the card itself reversed: a reversal on the same card (a posted payment-kind row that adds the amount back)
 * of exactly its amount and currency, dated on it or up to `returnDays` after, the payment with no checking candidate
 * of its own, each the other's only such. It was never paid, so it needs no checking debit.
 */
export interface ReturnedCardPayment {
  paymentId: string;
  reversalId: string;
  /** Days from the payment's transaction date to the reversal's. */
  dayOffset: number;
}

/** Why a card-payment debit has no payment. */
export type UnmatchedDebitReason =
  /** No card account of the issuer it names (or, naming none or an unrecognized payee, no card account at all) is in Holdr. */
  | 'no-card-account'
  /** Such cards are in Holdr, but no import of theirs covers the debit's date. */
  | 'card-not-covered'
  /** A card it can pay is imported for that date and no payment fits. */
  | 'no-card-payment';

export interface UnmatchedCheckingDebit {
  debitId: string;
  payee: CardPaymentPayee | null;
  reason: UnmatchedDebitReason;
  /**
   * Free payments of its exact amount, currency and dates its descriptor does not tie it to (another issuer's cards;
   * any card when it names no issuer or an unrecognized one): possible, for the owner. Never across Bilt's lanes: a
   * housing pull is offered only Bilt housing payment rows, and a card-payment debit never one.
   */
  possiblePayments: CardPaymentCandidate[];
}

export type StaleDecisionReason =
  /** A row it names is not stored, or is no longer a posted payment to a card or a posted debit. */
  | 'row-missing'
  /** Its rows no longer have one amount and currency, or are too far apart. */
  | 'row-changed'
  /** An earlier decision already took one of its rows. */
  | 'conflict'
  /**
   * The pair crosses Bilt's lanes: a Bilt housing pull with anything but a Bilt housing payment row, or that row with
   * anything but a Bilt housing pull.
   */
  | 'housing';

export interface StaleCardPaymentDecision {
  decisionId: string;
  reason: StaleDecisionReason;
}

export interface ReconciliationAmount {
  count: number;
  /** Negative minor units, as stored on either side. */
  amountMinor: number;
}

/** Per currency: every posted payment to a card is in exactly one payment part, every card-payment debit in one debit part. */
export interface CardPaymentReconciliationTotals {
  currency: string;
  payments: {
    all: ReconciliationAmount;
    matched: ReconciliationAmount;
    confirmed: ReconciliationAmount;
    ambiguous: ReconciliationAmount;
    unmatched: ReconciliationAmount;
    elsewhere: ReconciliationAmount;
    /** Payments the card itself reversed (`returned`): settled, with no checking debit. */
    returned: ReconciliationAmount;
    /** Pending payments to a card: not reconciled until they post, and in none of the parts above. */
    pending: ReconciliationAmount;
  };
  debits: {
    /** Debits that read as card payments, Bilt housing pulls paired with a payment, and any other debit the owner confirmed. */
    all: ReconciliationAmount;
    matched: ReconciliationAmount;
    confirmed: ReconciliationAmount;
    ambiguous: ReconciliationAmount;
    unmatched: ReconciliationAmount;
    /** Card-payment debits the owner said are not card payments. In none of the parts above, nor in `all`. */
    notCardPayment: ReconciliationAmount;
    /** Bilt housing pulls with no Bilt housing payment row. In none of the parts above, nor in `all`. */
    biltHousing: ReconciliationAmount;
    /**
     * Pulls their bank returned unpaid, netted with their return (`returnedDebits`). In none of the parts above, nor in
     * `all`. Absent from APIs that predate it.
     */
    returned?: ReconciliationAmount;
  };
}

export interface CardPaymentReconciliation {
  rulesVersion: number;
  pairs: CardPaymentPair[];
  ambiguous: CardPaymentAmbiguity[];
  unmatchedPayments: UnmatchedCardPayment[];
  unmatchedDebits: UnmatchedCheckingDebit[];
  /** Payments the owner said were paid from another account. */
  elsewhere: Array<{ paymentId: string; decisionId: string }>;
  /** Payments the card itself reversed, each with its reversal: settled, needing no checking debit. */
  returned: ReturnedCardPayment[];
  /** Debits the owner said are not card payments. */
  notCardPayments: Array<{ debitId: string; decisionId: string }>;
  /** Bilt housing pulls with no Bilt housing payment row, with why: listed apart from card-payment debits. */
  biltHousing: UnmatchedCheckingDebit[];
  staleDecisions: StaleCardPaymentDecision[];
  /** Pending payments to a card, not reconciled until they post. */
  pendingPayments: string[];
  totals: CardPaymentReconciliationTotals[];
  /** Every checking row read as a debit, with its class: the API shows its payee from here. */
  classes: ReadonlyMap<string, CheckingDebitClassification>;
  /** Each group the rules alone held for the owner, and what became of it (interchangeable rows, payer references). */
  heldGroups: CardPaymentHeldGroupCheck[];
  /** Pulls their bank returned unpaid, each netted with its return: no candidate, no gap. */
  returnedDebits: ReturnedCheckingDebit[];
  /** Pairs rules version 3 matched by itself that this version does not, with why (for the operator's report). */
  withheld: CardPaymentWithheldPair[];
  /**
   * The Wells Fargo card account the rules read as having carried the Bilt card before Cardless issued it (Root,
   * RECON-34): the one Wells Fargo card the debits naming Bilt from then fit, or null when none or several do.
   */
  biltCarrier: string | null;
  /**
   * Per Wells Fargo card product a transfer names alone (`MICRO CENTER`, …), the one Wells Fargo card the transfers naming
   * it fit (Root, RECON-34 A); a product none or several fit is absent. By product.
   */
  productCarriers: Array<{ product: string; cardAccountId: string }>;
  /**
   * Each retry standing in for a pull its bank returned unpaid, with the one payment of the pull's days it may pay
   * (Root, RECON-34 B): that pair is a candidate as any other.
   */
  retries: CardPaymentRetry[];
}

/** A retry standing in for a pull its bank returned unpaid, for the one payment of the pull's days (`retries`). */
export interface CardPaymentRetry {
  debitId: string;
  pullId: string;
  paymentId: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a valid YYYY-MM-DD date, else null. */
function dayNumber(date: unknown): number | null {
  if (typeof date !== 'string' || !ISO_DATE.test(date)) return null;
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date) return null;
  return time / DAY_MS;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Payment {
  row: ReconciliationCardRow;
  day: number;
  issuer: string;
  /** A Bilt housing payment row: only a Bilt housing pull pays it. */
  housing: boolean;
  /** Its own text is plain ASCII (`cardTextIsPlain`): else the rules never pair it by themselves. */
  plain: boolean;
}

interface Debit {
  row: ReconciliationCheckingRow;
  day: number;
  kind: CheckingDebitClassification;
  /**
   * The one card account its masked card number names, when it names one (`identifiedCard`): then it is a candidate for
   * that card's payments only.
   */
  card?: string;
  /**
   * A debit naming Bilt from before Cardless issued the Bilt card whose number names a Wells Fargo card (`card`): it pays
   * that card only as the Bilt card's carrier (`biltCarrier`), never on its number alone (RECON-34, PR280-R1).
   */
  viaCarrier?: boolean;
  /** The card its masked number names as rules version 3 read it (the baseline for `withheld`; PR280-R3). */
  version3Card?: string;
  /**
   * The Wells Fargo card product it names alone (`… TO MICRO CENTER`), its words spaced as an issuer's: it pays the one
   * Wells Fargo card the rows show carries that product (`productCarriers`; Root, RECON-34 A).
   */
  product?: string;
  /**
   * The pull its bank returned unpaid that it retries (Root, RECON-34 B): it may stand in for that pull (`retries`).
   */
  retryOf?: Debit;
}

/**
 * How the rules read a debit: as this version does, with the Wells Fargo card that carried the Bilt card before Cardless
 * issued it (`biltCarrier`), the one carrying each card product a transfer names alone (`productCarriers`), and each
 * retry standing in for its returned pull for one payment (`standIns`, pair keys); or as rules version 3 did (the
 * baseline for `withheld`): no debit naming Bilt pays a Wells Fargo card, a product named alone pays none, a masked
 * number is read as then, and every debit keeps its own days.
 */
type Reading = { biltCarrier: string | null; productCarriers: ReadonlyMap<string, string>; standIns: ReadonlySet<string> } | 'version-3';

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isCurrency = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]{3}$/.test(value);

/** A posted payment to a card with a valid date, amount and currency; else null. */
function paymentOf(row: ReconciliationCardRow, issuers: ReadonlyMap<string, string>): Payment | null {
  if (!row || row.status !== 'posted' || !isCardPaymentToCard(row) || !isCurrency(row.currency)) return null;
  const day = dayNumber(row.transactionDate);
  if (day === null) return null;
  const issuer = issuers.get(row.cardAccountId) ?? '';
  return { row, day, issuer, housing: isBiltHousingPayment(row, issuer), plain: cardTextIsPlain(row) };
}

/** Posted money out with a valid date, amount and currency; else null. */
function debitOf(row: ReconciliationCheckingRow): Debit | null {
  if (!row || row.status !== 'posted' || !isAmount(row.amountMinor) || row.amountMinor >= 0 || !isCurrency(row.currency)) return null;
  const day = dayNumber(row.date);
  return day === null ? null : { row, day, kind: classifyCheckingDebit(row.description) };
}

/** What the rules read every row against: the cards, their issuers, the numbers a masked number is read among. */
interface RowContext {
  cardAccounts: readonly ReconciliationCardAccount[];
  issuers: ReadonlyMap<string, string>;
  /** The checking accounts' own numbers: a debit printing one names no card (banks print the paying account's too). */
  checkingNumbers: ReadonlySet<string>;
  /**
   * The Bilt cards with history from before Cardless issued the Bilt card (the Wells Fargo-issued card kept under issuer
   * bilt): a debit naming Bilt from then may name one of them by its number (`identifiedCard`).
   */
  biltEraCards: ReadonlySet<string>;
  wellsFargoCards: ReadonlySet<string>;
}

function rowContextOf(input: CardPaymentReconciliationInput): RowContext {
  const cardAccounts = input.cardAccounts ?? [];
  const issuers = new Map(cardAccounts.map((account) => [account.id, account.issuer]));
  return {
    cardAccounts,
    issuers,
    checkingNumbers: new Set((input.checkingAccounts ?? []).map((account) => account?.last4)
      .filter((last4): last4 is string => typeof last4 === 'string' && /^\d{4}$/.test(last4))),
    biltEraCards: new Set((input.cardRows ?? []).filter((row) => row && typeof row.cardAccountId === 'string'
      && beforeBiltCardless(row.transactionDate) && isBiltCard(issuers.get(row.cardAccountId) ?? '')).map((row) => row.cardAccountId)),
    wellsFargoCards: new Set(cardAccounts.filter((account) => account && typeof account.id === 'string'
      && cardPaymentPayeeMatchesIssuer('wellsfargo', account.issuer)).map((account) => account.id)),
  };
}

/**
 * A checking row as the rules read it (`debitOf`), with the card its masked number names, now and as version 3 read it,
 * and the card product it names alone.
 */
function readDebit(row: ReconciliationCheckingRow, context: RowContext): Debit | null {
  const debit = debitOf(row);
  if (!debit) return null;
  const card = identifiedCard(debit, context.cardAccounts, context.checkingNumbers, context.biltEraCards);
  if (card !== undefined) debit.card = card;
  // A debit naming Bilt from before Cardless whose number names a Wells Fargo card pays it only as the carrier.
  if (card !== undefined && context.wellsFargoCards.has(card) && debit.kind.payee === 'bilt' && beforeBiltCardless(debit.row.date)) {
    debit.viaCarrier = true;
  }
  const version3Card = identifiedCard(debit, context.cardAccounts, context.checkingNumbers, context.biltEraCards, true);
  if (version3Card !== undefined) debit.version3Card = version3Card;
  const product = productNamed(debit);
  if (product !== undefined) debit.product = product;
  return debit;
}

/**
 * Whether `debit` is a candidate for `payment`: a Bilt housing pull only for a Bilt housing payment row, and that row
 * for nothing else; any other row for a card-payment debit that identifies its card (by its masked number) or its
 * issuer on its day (`cardPaymentPayeeMayPay`: Bilt before Cardless pays the Wells Fargo card that carried it), or names
 * it among several (`isSeveral`: a candidate the rules never pair by themselves, so its group goes to the owner). A debit
 * naming Bilt from before Cardless whose number names a Wells Fargo card pays it only as that carrier. Never a debit from
 * before the day Cardless issues the Bilt card for a payment on a Bilt card from that day on (`beforeCardless`). Read as
 * rules version 3 did (`reading`), no debit naming Bilt pays a Wells Fargo card, and a masked number is read as then.
 */
function debitMayPay(debit: Debit, payment: Payment, reading: Reading): boolean {
  if (beforeCardless(debit, payment)) return false;
  if (payment.housing) return debit.kind.class === 'bilt-housing';
  if (debit.kind.class !== 'card-payment') return false;
  const carrier = reading === 'version-3' ? null : reading.biltCarrier;
  const card = reading === 'version-3' ? debit.version3Card : debit.card;
  if (card !== undefined) {
    if (reading !== 'version-3' && debit.viaCarrier && card !== carrier) return false;
    return payment.row.cardAccountId === card;
  }
  // A transfer naming a card product alone pays the one Wells Fargo card the rows show carries it (RECON-34 A).
  if (debit.product !== undefined) {
    return reading !== 'version-3' && reading.productCarriers.get(debit.product) === payment.row.cardAccountId;
  }
  const names = (payee: CardPaymentPayee | null) =>
    cardPaymentPayeeMayPay(payee, debit.row.date, { id: payment.row.cardAccountId, issuer: payment.issuer }, carrier);
  if (isSeveral(debit)) return (debit.kind.payees ?? []).some(names);
  return names(debit.kind.payee);
}

/** Whether `day` is within the rules' days of a payment's transaction date: `daysBefore` before it to `daysAfter` after. */
function withinDays(payment: Payment, day: number): boolean {
  const offset = day - payment.day;
  return offset >= -CARD_PAYMENT_RECONCILIATION_RULES.daysBefore && offset <= CARD_PAYMENT_RECONCILIATION_RULES.daysAfter;
}

/**
 * Whether the rules read `debit` as a candidate for `payment`, as read (`reading`): of exactly its amount and currency,
 * within the rules' days of it (or a retry standing in for its returned pull for that payment: `standIns`), and paying
 * its card (`debitMayPay`). The owner's answers and a pull netted with its unpaid return are read apart. The one test of
 * a pair, for the rules and for the operator's report alike (`cardPaymentCandidateCheck`; PR280-R4).
 */
function candidateEdge(payment: Payment, debit: Debit, reading: Reading): boolean {
  return debit.row.currency === payment.row.currency && debit.row.amountMinor === payment.row.amountMinor
    && (withinDays(payment, debit.day) || (reading !== 'version-3' && reading.standIns.has(pairKey(payment.row.id, debit.row.id))))
    && debitMayPay(debit, payment, reading);
}

/**
 * The Wells Fargo card product a transfer names alone (`… TO MICRO CENTER`), its words spaced as an issuer's
 * (`MICRO+CENTER` names none), when it names exactly one; else undefined.
 */
function productOf(description: unknown): string | undefined {
  const names = nameText(tokensOf(description));
  if (!TRANSFER_TO_PRODUCT.test(names)) return undefined;
  const named = CARD_PRODUCTS.filter((product) => new RegExp(`\\b${product}\\b`).test(names));
  return named.length === 1 ? named[0] : undefined;
}

function productNamed(debit: Debit): string | undefined {
  return debit.kind.class === 'card-payment' && debit.kind.rule === 'product-name' ? productOf(debit.row.description) : undefined;
}

/**
 * A payment on a Bilt card dated on or after the day Cardless issues it, and a debit dated before that day: the debit
 * paid the Wells Fargo-issued Bilt card, whose history is on another card account, never this payment.
 */
function beforeCardless(debit: Debit, payment: Payment): boolean {
  const from = CARD_PAYMENT_RECONCILIATION_RULES.biltCardlessFrom;
  return isBiltCard(payment.issuer) && payment.row.transactionDate >= from && debit.row.date < from;
}

/** A card account's last four digits, or an Amex's last five read for them; null when Holdr has neither. */
function cardLast4(account: ReconciliationCardAccount): string | null {
  if (typeof account?.last4 === 'string' && /^\d{4}$/.test(account.last4)) return account.last4;
  if (typeof account?.last5 === 'string' && /^\d{5}$/.test(account.last5)) return account.last5.slice(1);
  return null;
}

/**
 * The one card account a card-payment debit's masked card number names (`maskedCardNumbers`), or undefined. Read only
 * for a plain-ASCII debit naming one issuer, or a card's product alone (then its issuer, Wells Fargo), the product's
 * words adjacent with ASCII whitespace alone between them, as an issuer's are (`MICRO+CENTER` stays offered only):
 * among that issuer's cards, all with a known last four, the one whose last four is a masked number the debit prints.
 * A debit naming Bilt from before Cardless issued the Bilt card prints the number the Bilt card had then, which the
 * Cardless card kept: it is read among the Wells Fargo cards and the Bilt cards with history from then (`biltEraCards`),
 * never the Cardless card's (Root, RECON-34); read as rules version 3 did (`version3`), among the Bilt cards. A number of
 * a checking account (the account that pays) names no card. Any other case (no such number, no card or several with it,
 * a card of the issuer with no last four in Holdr) leaves the debit to the rules without it.
 */
function identifiedCard(debit: Debit, cardAccounts: readonly ReconciliationCardAccount[], checkingNumbers: ReadonlySet<string>,
  biltEraCards: ReadonlySet<string>, version3 = false): string | undefined {
  if (debit.kind.class !== 'card-payment') return undefined;
  const product = debit.kind.rule === 'product-name';
  if (product && !TRANSFER_TO_PRODUCT.test(nameText(tokensOf(debit.row.description)))) return undefined;
  const payee = product ? PRODUCT_ISSUER : debit.kind.payee;
  if (payee === null || payee === 'unrecognized' || payee === 'several') return undefined;
  const numbers = maskedCardNumbers(debit.row.description).filter((number) => !checkingNumbers.has(number));
  if (numbers.length === 0) return undefined;
  const era = !version3 && payee === 'bilt' && beforeBiltCardless(debit.row.date);
  const cards = cardAccounts.filter((account) => account && (era
    ? cardPaymentPayeeMatchesIssuer('wellsfargo', account.issuer) || biltEraCards.has(account.id)
    : cardPaymentPayeeMatchesIssuer(payee, account.issuer)));
  if (cards.length === 0 || cards.some((account) => cardLast4(account) === null)) return undefined;
  const named = cards.filter((account) => numbers.includes(cardLast4(account)!));
  return named.length === 1 && typeof named[0].id === 'string' ? named[0].id : undefined;
}

/** A card-payment debit naming more than one issuer: never matched by the rules, whatever its group. */
function isSeveral(debit: Debit): boolean {
  return debit.kind.class === 'card-payment' && debit.kind.payee === 'several';
}

/**
 * Whether a pair crosses Bilt's two lanes: a Bilt housing pull with anything but a Bilt housing payment row, or a Bilt
 * housing payment row with anything but a Bilt housing pull. Such a pair is never matched, offered or confirmed, and a
 * confirmation of one does nothing.
 */
function crossesBiltLanes(debit: Debit, payment: Payment): boolean {
  return (debit.kind.class === 'bilt-housing') !== payment.housing;
}

/** Whether the owner may be offered (or may confirm) `debit` for `payment`: any pair that keeps to Bilt's lanes. */
function debitMayBeOffered(debit: Debit, payment: Payment): boolean {
  return !crossesBiltLanes(debit, payment);
}

function covers(ranges: readonly CardCoverageRange[] | undefined, date: string): boolean {
  return (ranges ?? []).some((range) => range.start <= date && range.end >= date);
}

function coverageIndex(coverage: readonly CardPaymentCoverage[] | undefined): Map<string, CardCoverageRange[]> {
  const byAccount = new Map<string, CardCoverageRange[]>();
  for (const item of coverage ?? []) {
    if (!item || typeof item.accountId !== 'string' || !Array.isArray(item.ranges)) continue;
    for (const range of item.ranges) push(byAccount, item.accountId, range);
  }
  return new Map([...byAccount].map(([id, ranges]) => [id, mergeCardCoverage(ranges)]));
}

const pairKey = (paymentId: string, debitId: string) => JSON.stringify([paymentId, debitId]);
const amountKey = (currency: string, amountMinor: number) => JSON.stringify([currency, amountMinor]);

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function emptyAmount(): ReconciliationAmount {
  return { count: 0, amountMinor: 0 };
}

function emptyTotals(currency: string): CardPaymentReconciliationTotals {
  return {
    currency,
    payments: {
      all: emptyAmount(), matched: emptyAmount(), confirmed: emptyAmount(), ambiguous: emptyAmount(),
      unmatched: emptyAmount(), elsewhere: emptyAmount(), returned: emptyAmount(), pending: emptyAmount(),
    },
    debits: {
      all: emptyAmount(), matched: emptyAmount(), confirmed: emptyAmount(), ambiguous: emptyAmount(),
      unmatched: emptyAmount(), notCardPayment: emptyAmount(), biltHousing: emptyAmount(), returned: emptyAmount(),
    },
  };
}

/** A group of payments and debits linked by candidate pairs, with those pairs. */
interface CandidateGroup {
  payments: string[];
  debits: string[];
  candidates: CardPaymentCandidate[];
}

/** Union-find over string keys. */
class Groups {
  private readonly parent = new Map<string, string>();
  find(key: string): string {
    let root = key;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    let node = key;
    while (node !== root) {
      const next = this.parent.get(node)!;
      this.parent.set(node, root);
      node = next;
    }
    if (!this.parent.has(root)) this.parent.set(root, root);
    return root;
  }
  join(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    // The smaller key roots the group, so groups never depend on the order rows came in.
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

/**
 * Every posted payment to a card matched one to one with the checking debit that paid it, where the rules (or the
 * owner) say which; see the module comment.
 */
export function reconcileCardPayments(input: CardPaymentReconciliationInput): CardPaymentReconciliation {
  const rules = CARD_PAYMENT_RECONCILIATION_RULES;
  const context = rowContextOf(input);
  const { cardAccounts, issuers, wellsFargoCards } = context;
  const cardCoverage = coverageIndex(input.cardCoverage);
  const checkingCoverage = coverageIndex(input.checkingCoverage);
  const checkingAccountIds = (input.checkingAccounts ?? []).map((account) => account.id);

  // Rows by id, first copy wins; then in a fixed order, so nothing depends on the input's.
  const payments = new Map<string, Payment>();
  const pending: ReconciliationCardRow[] = [];
  // Reversals: posted payment-kind rows that add their amount back to the card (a returned payment).
  const reversals = new Map<string, { row: ReconciliationCardRow; day: number }>();
  for (const row of input.cardRows ?? []) {
    if (!row || typeof row.id !== 'string' || payments.has(row.id) || reversals.has(row.id)) continue;
    const payment = paymentOf(row, issuers);
    if (payment) payments.set(row.id, payment);
    else if (row.status === 'pending' && isCardPaymentToCard(row) && isCurrency(row.currency)) pending.push(row);
    else if (row.kind === 'payment' && row.status === 'posted' && isAmount(row.amountMinor) && row.amountMinor > 0 && isCurrency(row.currency)) {
      const day = dayNumber(row.transactionDate);
      if (day !== null) reversals.set(row.id, { row, day });
    }
  }
  const debits = new Map<string, Debit>();
  const classes = new Map<string, CheckingDebitClassification>();
  // Checking credits by account, currency and amount: what tells a debit that came back (`cameBack`), and the credits
  // that read as an item the bank returned unpaid (`returnsOf`).
  const credits = new Map<string, number[]>();
  const returnCredits = new Map<string, Array<{ id: string; day: number }>>();
  const creditIds = new Set<string>();
  const creditKey = (accountId: string, currency: string, amountMinor: number) => `${accountId}\u0000${amountKey(currency, amountMinor)}`;
  for (const row of input.checkingRows ?? []) {
    if (!row || typeof row.id !== 'string' || debits.has(row.id) || creditIds.has(row.id)) continue;
    if (row.status === 'posted' && isAmount(row.amountMinor) && row.amountMinor > 0 && isCurrency(row.currency)
      && typeof row.checkingAccountId === 'string') {
      const day = dayNumber(row.date);
      if (day === null) continue;
      creditIds.add(row.id);
      const key = creditKey(row.checkingAccountId, row.currency, row.amountMinor);
      push(credits, key, day);
      if (checkingCreditReadsAsReturnedItem(row.description)) push(returnCredits, key, { id: row.id, day });
      continue;
    }
    const debit = readDebit(row, context);
    if (!debit) continue;
    debits.set(row.id, debit);
    classes.set(row.id, debit.kind);
  }
  const byPaymentOrder = (a: Payment, b: Payment) => a.day - b.day || compareText(a.row.id, b.row.id);
  const byDebitOrder = (a: Debit, b: Debit) => a.day - b.day || compareText(a.row.id, b.row.id);
  const paymentList = [...payments.values()].sort(byPaymentOrder);
  const debitList = [...debits.values()].sort(byDebitOrder);

  // The owner's decisions, oldest first; each row is taken by at most one.
  const confirmedPairs: CardPaymentPair[] = [];
  const takenPayments = new Map<string, string>();
  const takenDebits = new Map<string, string>();
  const elsewhere: Array<{ paymentId: string; decisionId: string }> = [];
  const notCardPayments: Array<{ debitId: string; decisionId: string }> = [];
  const rejected = new Set<string>();
  const stale: StaleCardPaymentDecision[] = [];
  const decisions = [...(input.decisions ?? [])]
    .filter((item) => item && typeof item.id === 'string')
    .sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id));
  for (const decision of decisions) {
    const payment = decision.cardTransactionId ? payments.get(decision.cardTransactionId) : undefined;
    const debit = decision.checkingTransactionId ? debits.get(decision.checkingTransactionId) : undefined;
    const sameAs = (amountMinor: number, currency: string) => amountMinor === decision.amountMinor && currency === decision.currency;
    if (decision.decision === 'rejected') {
      if (decision.cardTransactionId && decision.checkingTransactionId) {
        rejected.add(pairKey(decision.cardTransactionId, decision.checkingTransactionId));
      }
      continue;
    }
    if (decision.decision === 'elsewhere') {
      if (!payment) stale.push({ decisionId: decision.id, reason: 'row-missing' });
      else if (!sameAs(payment.row.amountMinor, payment.row.currency)) stale.push({ decisionId: decision.id, reason: 'row-changed' });
      else if (takenPayments.has(payment.row.id)) stale.push({ decisionId: decision.id, reason: 'conflict' });
      else {
        takenPayments.set(payment.row.id, decision.id);
        elsewhere.push({ paymentId: payment.row.id, decisionId: decision.id });
      }
      continue;
    }
    if (decision.decision === 'not-card-payment') {
      if (!debit) stale.push({ decisionId: decision.id, reason: 'row-missing' });
      else if (!sameAs(debit.row.amountMinor, debit.row.currency)) stale.push({ decisionId: decision.id, reason: 'row-changed' });
      else if (takenDebits.has(debit.row.id)) stale.push({ decisionId: decision.id, reason: 'conflict' });
      else {
        takenDebits.set(debit.row.id, decision.id);
        notCardPayments.push({ debitId: debit.row.id, decisionId: decision.id });
      }
      continue;
    }
    if (decision.decision !== 'confirmed') continue;
    if (!payment || !debit) {
      stale.push({ decisionId: decision.id, reason: 'row-missing' });
      continue;
    }
    const dayOffset = debit.day - payment.day;
    if (!sameAs(payment.row.amountMinor, payment.row.currency) || !sameAs(debit.row.amountMinor, debit.row.currency)
      || Math.abs(dayOffset) > rules.confirmDays) {
      stale.push({ decisionId: decision.id, reason: 'row-changed' });
    } else if (!debitMayBeOffered(debit, payment)) {
      stale.push({ decisionId: decision.id, reason: 'housing' });
    } else if (takenPayments.has(payment.row.id) || takenDebits.has(debit.row.id)) {
      stale.push({ decisionId: decision.id, reason: 'conflict' });
    } else {
      takenPayments.set(payment.row.id, decision.id);
      takenDebits.set(debit.row.id, decision.id);
      confirmedPairs.push({ paymentId: payment.row.id, debitId: debit.row.id, dayOffset, status: 'confirmed', decisionId: decision.id });
    }
  }

  // Candidates among the rows no decision took, by currency and exact amount (debitMayPay).
  const openPayments = paymentList.filter((payment) => !takenPayments.has(payment.row.id));
  const openDebits = debitList.filter((debit) => !takenDebits.has(debit.row.id));
  const debitsByAmount = new Map<string, Debit[]>();
  for (const debit of openDebits) push(debitsByAmount, amountKey(debit.row.currency, debit.row.amountMinor), debit);
  /** A debit within the rules' days of a payment by its own date: how version 3 read every pair, and carriers are fitted. */
  const inOwnWindow = (payment: Payment, debit: Debit) => withinDays(payment, debit.day);

  // Pulls their bank returned unpaid: a credit of exactly the debit's amount to its account, from its day to
  // `debitReturnDays` after, that reads as an item returned (`checkingCreditReadsAsReturnedItem`). Such a pull never
  // paid a card, so no rule pairs it: a group holding one is the owner's. Where it and its return are each other's only
  // such, the two net to zero: the pull is no candidate at all and is listed apart (`returnedDebits`).
  const returnsOf = (debit: Debit) => (returnCredits.get(creditKey(debit.row.checkingAccountId, debit.row.currency, -debit.row.amountMinor)) ?? [])
    .filter((credit) => credit.day >= debit.day && credit.day - debit.day <= rules.debitReturnDays);
  const returnFits = new Map<string, Array<{ id: string; day: number }>>();
  const creditFits = new Map<string, string[]>();
  for (const debit of debitList) {
    for (const credit of returnsOf(debit)) {
      push(returnFits, debit.row.id, credit);
      push(creditFits, credit.id, debit.row.id);
    }
  }
  const returnedUnpaid = (debitId: string) => returnFits.has(debitId);
  const returnedDebits: ReturnedCheckingDebit[] = [];
  const netted = new Set<string>();
  for (const debit of openDebits) {
    const fits = returnFits.get(debit.row.id) ?? [];
    if (fits.length === 1 && creditFits.get(fits[0].id)!.length === 1) {
      netted.add(debit.row.id);
      returnedDebits.push({ debitId: debit.row.id, creditId: fits[0].id, dayOffset: fits[0].day - debit.day });
    }
  }

  // A retry of a pull its bank returned unpaid (Root, RECON-34 B): a debit reading RETRY, of the same checking account,
  // currency and amount as a pull returned unpaid (`returnedUnpaid`) dated before it by up to `retryDays`, both naming
  // the same one issuer, each the other's only such, may stand in for that pull (`retryOf`; read below). A retry that
  // itself came back unpaid retries nothing. Two pulls it could retry, or two retries of one pull: none.
  const oneIssuer = (debit: Debit) => (debit.kind.class === 'card-payment' && debit.kind.payee !== null
    && debit.kind.payee !== 'unrecognized' && debit.kind.payee !== 'several' ? debit.kind.payee : null);
  const retryKey = (debit: Debit) => JSON.stringify([debit.row.checkingAccountId, debit.row.currency, debit.row.amountMinor, oneIssuer(debit)]);
  const unpaidPulls = new Map<string, Debit[]>();
  for (const debit of debitList) if (returnedUnpaid(debit.row.id) && oneIssuer(debit) !== null) push(unpaidPulls, retryKey(debit), debit);
  const pullsOfRetry = new Map<string, Debit[]>();
  const retriesOfPull = new Map<string, number>();
  for (const debit of debitList) {
    if (oneIssuer(debit) === null || returnedUnpaid(debit.row.id) || !RETRY.test(wordText(tokensOf(debit.row.description)))) continue;
    const pulls = (unpaidPulls.get(retryKey(debit)) ?? [])
      .filter((pull) => pull.day < debit.day && debit.day - pull.day <= rules.retryDays);
    if (pulls.length === 0) continue;
    pullsOfRetry.set(debit.row.id, pulls);
    for (const pull of pulls) retriesOfPull.set(pull.row.id, (retriesOfPull.get(pull.row.id) ?? 0) + 1);
  }
  for (const [retryId, pulls] of pullsOfRetry) {
    if (pulls.length === 1 && retriesOfPull.get(pulls[0].row.id) === 1) debits.get(retryId)!.retryOf = pulls[0];
  }

  // The Wells Fargo cards the rows show a debit naming no card pays (Root, RECON-34), derived from the rows, never named
  // in the rules: the one Wells Fargo card that carried the Bilt card before Cardless issued it, which the debits naming
  // Bilt from then fit; and for each card product a transfer names alone (`… TO MICRO CENTER`), the one Wells Fargo card
  // the transfers naming it fit (RECON-34 A). A debit fits the card the owner confirmed it paid, whatever its number says
  // (PR280-R2); the card its masked number names; or, naming none, a card with a payment of its exact amount and currency
  // within the rules' days. Never a pair the owner rejected, a payment the owner said was paid from elsewhere, a debit the
  // owner said is no card payment, or a pull netted with its unpaid return. No card, or several: no carrier, and no such
  // debit pays a Wells Fargo card by it (only offered, as before).
  const confirmedCards = new Map(confirmedPairs.map((pair) => [pair.debitId, payments.get(pair.paymentId)!.row.cardAccountId]));
  const paidElsewhere = new Set(elsewhere.map((item) => item.paymentId));
  const notCardIds = new Set(notCardPayments.map((item) => item.debitId));
  const paymentsByAmount = new Map<string, Payment[]>();
  for (const payment of paymentList) push(paymentsByAmount, amountKey(payment.row.currency, payment.row.amountMinor), payment);
  const carrierOf = (fitting: readonly Debit[]): string | null => {
    const cards = new Set<string>();
    for (const debit of fitting) {
      if (notCardIds.has(debit.row.id) || netted.has(debit.row.id)) continue;
      const confirmed = confirmedCards.get(debit.row.id);
      if (confirmed !== undefined && wellsFargoCards.has(confirmed)) cards.add(confirmed);
      if (debit.card !== undefined) {
        if (wellsFargoCards.has(debit.card)) cards.add(debit.card);
        continue;
      }
      for (const payment of paymentsByAmount.get(amountKey(debit.row.currency, debit.row.amountMinor)) ?? []) {
        const key = pairKey(payment.row.id, debit.row.id);
        if (!wellsFargoCards.has(payment.row.cardAccountId) || paidElsewhere.has(payment.row.id) || rejected.has(key)) continue;
        if (inOwnWindow(payment, debit)) cards.add(payment.row.cardAccountId);
      }
    }
    return cards.size === 1 ? [...cards][0] : null;
  };
  const biltCarrier = carrierOf(debitList.filter((debit) => debit.kind.class === 'card-payment' && debit.kind.payee === 'bilt'
    && beforeBiltCardless(debit.row.date)));
  const byProduct = new Map<string, Debit[]>();
  for (const debit of debitList) if (debit.product !== undefined) push(byProduct, debit.product, debit);
  const productCarriers = new Map<string, string>();
  for (const product of [...byProduct.keys()].sort()) {
    const card = carrierOf(byProduct.get(product)!);
    if (card !== null) productCarriers.set(product, card);
  }
  /** The carriers alone: what a retry is read by before it may stand in for a pull. */
  const carried: Reading = { biltCarrier, productCarriers, standIns: new Set<string>() };

  // A retry stands in for its returned pull (Root, RECON-34 B) only where nothing else is read for either side: it may
  // pay no payment by its own days; it may pay exactly one payment the pull itself was a candidate for, by the pull's
  // days and the rules' one test of a pair, read as for the retry (`candidateEdge`: the card its masked number names,
  // its issuer on its day and the day Cardless issued the Bilt card, the carriers; PR298-R1), no more than
  // `confirmDays` from it; that payment fits no other debit by its own days (a pull netted with its return aside) nor
  // another retry; and no reversal on its card may be its return. That one pair is then a candidate as any other
  // (`retries`), a group of its own. Else the retry keeps its own days: never two payments, never a payment its pull
  // could not have paid, never a payment another debit may have paid or the card may have taken back.
  const allDebitsByAmount = new Map<string, Debit[]>();
  for (const debit of debitList) push(allDebitsByAmount, amountKey(debit.row.currency, debit.row.amountMinor), debit);
  const takenBackOnCard = (payment: Payment) => [...reversals.values()].some((reversal) => reversal.row.cardAccountId === payment.row.cardAccountId
    && reversal.row.currency === payment.row.currency && reversal.row.amountMinor === -payment.row.amountMinor
    && reversal.day >= payment.day && reversal.day - payment.day <= rules.returnDays);
  const standIns = new Map<string, CardPaymentRetry>();
  const standInsOf = new Map<string, number>();
  for (const debit of debitList) {
    const pull = debit.retryOf;
    if (pull === undefined) continue;
    const same = paymentsByAmount.get(amountKey(debit.row.currency, debit.row.amountMinor)) ?? [];
    if (same.some((payment) => withinDays(payment, debit.day) && debitMayPay(debit, payment, carried))) continue;
    const stood = same.filter((payment) => candidateEdge(payment, pull, carried) && debitMayPay(debit, payment, carried));
    if (stood.length !== 1) continue;
    const [payment] = stood;
    if (Math.abs(debit.day - payment.day) > rules.confirmDays || takenBackOnCard(payment)) continue;
    const others = (allDebitsByAmount.get(amountKey(payment.row.currency, payment.row.amountMinor)) ?? [])
      .filter((other) => other !== debit && !netted.has(other.row.id) && candidateEdge(payment, other, carried));
    if (others.length > 0) continue;
    standIns.set(pairKey(payment.row.id, debit.row.id), { debitId: debit.row.id, pullId: pull.row.id, paymentId: payment.row.id });
    standInsOf.set(payment.row.id, (standInsOf.get(payment.row.id) ?? 0) + 1);
  }
  // Two retries standing in for one payment: neither does.
  for (const [key, standIn] of standIns) if (standInsOf.get(standIn.paymentId)! > 1) standIns.delete(key);
  const reading: Reading = { ...carried, standIns: new Set(standIns.keys()) };
  /** A debit within the rules' days of a payment by its own date, or a retry standing in for its pull (`standIns`). */
  const inWindow = (payment: Payment, debit: Debit) => withinDays(payment, debit.day) || standIns.has(pairKey(payment.row.id, debit.row.id));

  // Every pair that fits, among all rows (those the owner's other answers took, and netted pulls, among them), with the
  // ones the owner rejected. A component holding a rejection is the owner's in full, before any rule reads it, until the
  // owner answers each of its rows or takes the rejection back (`answered`; Root 02:32Z, 03:30Z). It is built before the
  // owner's other answers take their rows, so neither an Undo nor a confirmation or an "elsewhere" on another of its rows
  // ever hands a rejected debit to another payment or card.
  const withRejected = new Groups();
  const rejectedPayments: string[] = [];
  for (const payment of paymentList) {
    for (const debit of allDebitsByAmount.get(amountKey(payment.row.currency, payment.row.amountMinor)) ?? []) {
      if (!candidateEdge(payment, debit, reading)) continue;
      withRejected.join(`p:${payment.row.id}`, `d:${debit.row.id}`);
      if (rejected.has(pairKey(payment.row.id, debit.row.id))) rejectedPayments.push(payment.row.id);
    }
  }
  const answeredRoots = new Set(rejectedPayments.map((id) => withRejected.find(`p:${id}`)));
  /** Whether a payment is in a component holding a pair the owner rejected. */
  const inAnswered = (paymentId: string) => answeredRoots.has(withRejected.find(`p:${paymentId}`));

  const candidates: CardPaymentCandidate[] = [];
  const groups = new Groups();
  const linkedPayments = new Set<string>();
  const linkedDebits = new Set<string>();
  // The pairs as rules version 3 read them (a returned pull among them, no debit naming Bilt a Wells Fargo card's, a
  // masked number read as then), each pair read on its own, for what this version no longer matches (PR280-R3).
  const legacyCandidates: CardPaymentCandidate[] = [];
  for (const payment of openPayments) {
    for (const debit of debitsByAmount.get(amountKey(payment.row.currency, payment.row.amountMinor)) ?? []) {
      if (rejected.has(pairKey(payment.row.id, debit.row.id))) continue;
      const candidate = { paymentId: payment.row.id, debitId: debit.row.id, dayOffset: debit.day - payment.day };
      if (candidateEdge(payment, debit, 'version-3')) legacyCandidates.push(candidate);
      if (!candidateEdge(payment, debit, reading) || netted.has(debit.row.id)) continue;
      candidates.push(candidate);
      groups.join(`p:${payment.row.id}`, `d:${debit.row.id}`);
      linkedPayments.add(payment.row.id);
      linkedDebits.add(debit.row.id);
    }
  }
  const answered = (group: CandidateGroup) => group.payments.some(inAnswered);
  const holdsReturned = (group: CandidateGroup) => group.debits.some(returnedUnpaid);
  const oneToOne = (group: { payments: readonly string[]; debits: readonly string[]; candidates: readonly CardPaymentCandidate[] }) =>
    group.payments.length === 1 && group.debits.length === 1 && group.candidates.length === 1
    && !isSeveral(debits.get(group.debits[0])!) && payments.get(group.payments[0])!.plain;

  // A group of exactly one payment and one debit is matched, unless the debit names several issuers or the payment's own
  // text is not plain ASCII, the owner answered a pair of its group, or its debit came back unpaid; any other group is
  // held for the owner, unless interchangeable rows or payer references settle it (below).
  const members = new Map<string, CandidateGroup>();
  const memberOf = (root: string) => {
    let entry = members.get(root);
    if (!entry) members.set(root, (entry = { payments: [], debits: [], candidates: [] }));
    return entry;
  };
  for (const payment of openPayments) {
    if (linkedPayments.has(payment.row.id)) memberOf(groups.find(`p:${payment.row.id}`)).payments.push(payment.row.id);
  }
  for (const debit of openDebits) {
    if (linkedDebits.has(debit.row.id)) memberOf(groups.find(`d:${debit.row.id}`)).debits.push(debit.row.id);
  }
  for (const candidate of candidates) memberOf(groups.find(`p:${candidate.paymentId}`)).candidates.push(candidate);

  const pairs: CardPaymentPair[] = [...confirmedPairs];
  const ambiguous: CardPaymentAmbiguity[] = [];
  const paymentRank = new Map(paymentList.map((payment, index) => [payment.row.id, index]));
  const debitRank = new Map(debitList.map((debit, index) => [debit.row.id, index]));
  const held: CandidateGroup[] = [];
  for (const group of members.values()) {
    if (oneToOne(group) && !answered(group) && !holdsReturned(group)) {
      const [candidate] = group.candidates;
      pairs.push({ ...candidate, status: 'matched' });
      continue;
    }
    held.push(group);
  }
  const hold = (group: CandidateGroup) => {
    group.candidates.sort((a, b) => paymentRank.get(a.paymentId)! - paymentRank.get(b.paymentId)!
      || Math.abs(a.dayOffset) - Math.abs(b.dayOffset) || a.dayOffset - b.dayOffset
      || debitRank.get(a.debitId)! - debitRank.get(b.debitId)!);
    ambiguous.push({
      id: group.payments[0] ?? group.debits[0],
      paymentIds: group.payments,
      debitIds: group.debits,
      candidates: group.candidates,
    });
  };

  // A debit came back when a credit of exactly its amount reaches its account within `debitReturnDays` after it.
  const cameBack = (debit: Debit) => (credits.get(creditKey(debit.row.checkingAccountId, debit.row.currency, -debit.row.amountMinor)) ?? [])
    .some((day) => day >= debit.day && day - debit.day <= rules.debitReturnDays);

  // Payer references: learned from the pairs proven so far, without any reference (the owner's confirmations and the
  // rules' one-to-one matches), then read on the groups held for the owner. A reference tied to more than one card, or
  // to one card fewer than `referenceProofs` times, identifies none.
  const references = new Map<string, string | null>();
  const referenceOf = (debit: Debit) => {
    if (!references.has(debit.row.id)) references.set(debit.row.id, checkingPayerReference(debit.row.description));
    return references.get(debit.row.id)!;
  };
  const proofs = new Map<string, Map<string, number>>();
  for (const pair of pairs) {
    // A pull that came back (returned unpaid, or a credit of its amount that cannot be told from a return) proves no
    // reference, even where the owner confirmed it.
    if (cameBack(debits.get(pair.debitId)!)) continue;
    const reference = referenceOf(debits.get(pair.debitId)!);
    if (reference === null) continue;
    const card = payments.get(pair.paymentId)!.row.cardAccountId;
    let byCard = proofs.get(reference);
    if (!byCard) proofs.set(reference, (byCard = new Map()));
    byCard.set(card, (byCard.get(card) ?? 0) + 1);
  }
  /** The card a debit's payer reference identifies, and how many proven pairs say so; null when it identifies none. */
  const identified = (debitId: string): { card: string; proofs: number } | null => {
    const reference = referenceOf(debits.get(debitId)!);
    const byCard = reference === null ? undefined : proofs.get(reference);
    if (!byCard || byCard.size !== 1) return null;
    const [[card, count]] = byCard;
    return count >= rules.referenceProofs ? { card, proofs: count } : null;
  };
  /** Whether a debit's payer reference was proven, even once, for a card other than `card`. */
  const provenElsewhere = (debitId: string, card: string) => {
    const reference = referenceOf(debits.get(debitId)!);
    const byCard = reference === null ? undefined : proofs.get(reference);
    return byCard !== undefined && [...byCard.keys()].some((other) => other !== card);
  };
  const cardOf = (paymentId: string) => payments.get(paymentId)!.row.cardAccountId;

  /**
   * Why a held group's payments are not interchangeable rows (Root 02:05Z), or null when they are: two payments or
   * more, no more debits than payments, every payment on one card, of one transaction and posted date, amount and
   * currency, each reading as the same kind of card payment (`cardPaymentRowKind`: an ordinary or a housing payment,
   * never a reversal, a return, a credit or text the rules do not read; descriptions may differ, Root 04:24Z), with
   * identical candidate sets. A group the owner answered, one holding a pull that came
   * back, one with a debit naming several issuers and one with a payment whose text is not plain ASCII are held
   * before. A held group is a whole component of the candidate pairs, so it is closed: no debit of it fits a payment
   * outside it, nor the other way round. Its payments always share one amount and currency (a debit pays only its own
   * amount), and outside an answered group their candidate sets are always the same; both checks stay as Root's
   * conditions read.
   */
  const interchangeRefusal = (group: CandidateGroup): CardPaymentInterchangeRefusal | null => {
    if (group.payments.length < 2) return 'one-payment';
    if (group.debits.length > group.payments.length) return 'more-debits';
    const rows = group.payments.map((id) => payments.get(id)!.row);
    const [first] = rows;
    if (rows.some((row) => row.cardAccountId !== first.cardAccountId)) return 'cards';
    if (rows.some((row) => row.transactionDate !== first.transactionDate || (row.postedDate ?? null) !== (first.postedDate ?? null))) return 'dates';
    if (rows.some((row) => row.amountMinor !== first.amountMinor || row.currency !== first.currency)) return 'amounts';
    const kinds = group.payments.map((id) => cardPaymentRowKind(payments.get(id)!.row, payments.get(id)!.issuer));
    if (kinds.some((kind) => kind !== kinds[0]) || (kinds[0] !== 'payment' && kinds[0] !== 'housing')) return 'kinds';
    const debitsOf = new Map<string, string[]>();
    for (const candidate of group.candidates) push(debitsOf, candidate.paymentId, candidate.debitId);
    const all = [...group.debits].sort().join('\u0000');
    if (group.payments.some((id) => [...(debitsOf.get(id) ?? [])].sort().join('\u0000') !== all)) return 'candidates';
    return null;
  };

  const heldGroups: CardPaymentHeldGroupCheck[] = [];
  // Rows a group's settlement left with no candidate at all: listed as unmatched, as any row with none.
  const orphanPayments = new Set<string>();
  const orphanDebits = new Set<string>();
  for (const group of held) {
    const check: CardPaymentHeldGroupCheck = {
      groupId: group.payments[0] ?? group.debits[0], paymentIds: [...group.payments], debitIds: [...group.debits],
      outcome: 'held', byInterchange: 0, byReference: 0, byRemainder: 0, orphanPayments: 0, orphanDebits: 0,
    };
    heldGroups.push(check);
    // No rule reads a group the owner answered, one holding a pull that came back (returned unpaid, or by any credit of
    // its amount), nor one the rules never pair alone.
    const unread = answered(group) ? 'answered' as const : holdsReturned(group) ? 'returned' as const
      : group.debits.some((id) => cameBack(debits.get(id)!)) ? 'came-back' as const
        : group.debits.some((id) => isSeveral(debits.get(id)!)) ? 'several' as const
          : group.payments.some((id) => !payments.get(id)!.plain) ? 'not-plain' as const : null;
    if (unread) {
      check.held = unread;
      hold(group);
      continue;
    }
    // Interchangeable rows: whichever pays which, every per-card, per-account, per-day and per-month figure is the same.
    // A description cue named by exactly one payment and one debit of the group pairs those two; the rest are paired in
    // canonical order (date, then id), and payments left over have none (Root 04:24Z).
    const refusal = interchangeRefusal(group);
    if (refusal === null) {
      const cued = new Map<string, string>();
      for (const cue of ['auto', 'online'] as const) {
        const cuedPayments = group.payments.filter((id) => paymentChannelCue(payments.get(id)!.row.description) === cue);
        const cuedDebits = group.debits.filter((id) => paymentChannelCue(debits.get(id)!.row.description) === cue);
        if (cuedPayments.length === 1 && cuedDebits.length === 1) cued.set(cuedDebits[0], cuedPayments[0]);
      }
      const byCue = new Set(cued.values());
      const inOrder = group.payments.filter((id) => !byCue.has(id));
      let next = 0;
      for (const debitId of group.debits) {
        const cuePayment = cued.get(debitId);
        const paymentId = cuePayment ?? inOrder[next++];
        const candidate = group.candidates.find((item) => item.paymentId === paymentId && item.debitId === debitId)!;
        pairs.push({
          ...candidate, status: 'matched',
          evidence: { basis: 'interchangeable', payments: group.payments.length, pairedBy: cuePayment === undefined ? 'order' : 'cue' },
        });
      }
      for (const id of inOrder.slice(next)) orphanPayments.add(id);
      check.outcome = 'interchangeable';
      check.byInterchange = group.debits.length;
      check.orphanPayments = group.payments.length - group.debits.length;
      continue;
    }
    check.notInterchangeable = refusal;
    // Payer references.
    const supported = group.candidates.filter((candidate) => identified(candidate.debitId)?.card === cardOf(candidate.paymentId));
    const perPayment = new Map<string, number>();
    const perDebit = new Map<string, number>();
    for (const candidate of supported) {
      perPayment.set(candidate.paymentId, (perPayment.get(candidate.paymentId) ?? 0) + 1);
      perDebit.set(candidate.debitId, (perDebit.get(candidate.debitId) ?? 0) + 1);
    }
    const settled = supported.filter((candidate) => perPayment.get(candidate.paymentId) === 1 && perDebit.get(candidate.debitId) === 1);
    if (settled.length === 0) {
      check.held = supported.length === 0 ? 'unproven' : 'not-unique';
      hold(group);
      continue;
    }
    const tookPayments = new Set(settled.map((candidate) => candidate.paymentId));
    const tookDebits = new Set(settled.map((candidate) => candidate.debitId));
    for (const candidate of settled) {
      pairs.push({ ...candidate, status: 'matched', evidence: { basis: 'reference', proofs: identified(candidate.debitId)!.proofs } });
    }
    check.byReference = settled.length;
    // What is left, grouped again: a payment and a debit left as each other's one candidate are matched too, unless the
    // debit's reference was ever proven for another card; anything else is held for the owner, and a row with no
    // candidate left is unmatched.
    const rest = group.candidates.filter((candidate) => !tookPayments.has(candidate.paymentId) && !tookDebits.has(candidate.debitId));
    const restGroups = new Groups();
    for (const candidate of rest) restGroups.join(`p:${candidate.paymentId}`, `d:${candidate.debitId}`);
    const restPayments = new Set(rest.map((candidate) => candidate.paymentId));
    const restDebits = new Set(rest.map((candidate) => candidate.debitId));
    const parts = new Map<string, CandidateGroup>();
    const partOf = (root: string) => {
      let entry = parts.get(root);
      if (!entry) parts.set(root, (entry = { payments: [], debits: [], candidates: [] }));
      return entry;
    };
    for (const id of group.payments) {
      if (tookPayments.has(id)) continue;
      if (restPayments.has(id)) partOf(restGroups.find(`p:${id}`)).payments.push(id);
      else orphanPayments.add(id);
    }
    for (const id of group.debits) {
      if (tookDebits.has(id)) continue;
      if (restDebits.has(id)) partOf(restGroups.find(`d:${id}`)).debits.push(id);
      else orphanDebits.add(id);
    }
    for (const candidate of rest) partOf(restGroups.find(`p:${candidate.paymentId}`)).candidates.push(candidate);
    check.orphanPayments = group.payments.filter((id) => orphanPayments.has(id)).length;
    check.orphanDebits = group.debits.filter((id) => orphanDebits.has(id)).length;
    check.outcome = 'reference';
    for (const part of parts.values()) {
      const [candidate] = part.candidates;
      if (part.payments.length === 1 && part.debits.length === 1 && part.candidates.length === 1
        && !provenElsewhere(candidate.debitId, cardOf(candidate.paymentId))) {
        pairs.push({ ...candidate, status: 'matched', evidence: { basis: 'remainder' } });
        check.byRemainder += 1;
        continue;
      }
      check.outcome = 'partly';
      hold(part);
    }
  }
  pairs.sort((a, b) => paymentRank.get(a.paymentId)! - paymentRank.get(b.paymentId)!);
  ambiguous.sort((a, b) => paymentRank.get(a.paymentIds[0])! - paymentRank.get(b.paymentIds[0])!);
  heldGroups.sort((a, b) => paymentRank.get(a.paymentIds[0])! - paymentRank.get(b.paymentIds[0])!);

  // What this version no longer matches one to one: each pair the rules matched alone in version 3 that is not matched
  // now, because its debit came back unpaid, the owner answered a pair of its group, or else this version reads one of
  // its rows otherwise (for the operator's report).
  const legacyGroups = new Groups();
  for (const candidate of legacyCandidates) legacyGroups.join(`p:${candidate.paymentId}`, `d:${candidate.debitId}`);
  const legacyMembers = new Map<string, CandidateGroup>();
  for (const candidate of legacyCandidates) {
    const root = legacyGroups.find(`p:${candidate.paymentId}`);
    let entry = legacyMembers.get(root);
    if (!entry) legacyMembers.set(root, (entry = { payments: [], debits: [], candidates: [] }));
    if (!entry.payments.includes(candidate.paymentId)) entry.payments.push(candidate.paymentId);
    if (!entry.debits.includes(candidate.debitId)) entry.debits.push(candidate.debitId);
    entry.candidates.push(candidate);
  }
  const pairKeys = new Set(pairs.map((pair) => pairKey(pair.paymentId, pair.debitId)));
  const withheld: CardPaymentWithheldPair[] = [...legacyMembers.values()]
    .filter((group) => oneToOne(group) && !pairKeys.has(pairKey(group.payments[0], group.debits[0])))
    .map((group) => ({
      paymentId: group.payments[0],
      debitId: group.debits[0],
      reason: returnedUnpaid(group.debits[0]) ? 'returned' as const : inAnswered(group.payments[0]) ? 'answered' as const : 'reread' as const,
    }))
    .sort((a, b) => paymentRank.get(a.paymentId)! - paymentRank.get(b.paymentId)!);

  // What is left on either side, with why, and what the owner might pair it with. First, the payments the card itself
  // reversed: a payment with no candidate of its own (nor an owner's answer) and a reversal on its card of exactly its
  // amount, from its day to `returnDays` after, each the other's only such, is returned and needs no debit, where the
  // reversal reads as the card taking a payment back and both rows' text is plain ASCII. A payment tied to a checking
  // debit (matched, confirmed, or held for the owner with it) is never returned, and does not compete for a reversal
  // unless that debit came back (a credit of its amount to its account within `debitReturnDays` after it): then it did
  // not stand, and the reversal may be that payment's too. Anything else is settled by no rule: each such reversal is
  // offered to the owner with each payment it fits that has no debit. A payment payer references left with no
  // candidate is tied to no debit, as one that never had any.
  const unlinked = openPayments.filter((payment) => !linkedPayments.has(payment.row.id) || orphanPayments.has(payment.row.id));
  const unlinkedIds = new Set(unlinked.map((payment) => payment.row.id));
  const tiedDebits = new Map<string, string[]>();
  for (const pair of pairs) push(tiedDebits, pair.paymentId, pair.debitId);
  for (const group of ambiguous) for (const candidate of group.candidates) push(tiedDebits, candidate.paymentId, candidate.debitId);
  const competing = paymentList.filter((payment) => unlinkedIds.has(payment.row.id)
    || (tiedDebits.get(payment.row.id) ?? []).some((debitId) => cameBack(debits.get(debitId)!)));
  const reversalEdges = new Map<string, CardPaymentReversalOption[]>();
  const reversalTaken = new Map<string, number>();
  for (const payment of competing) {
    for (const reversal of reversals.values()) {
      const offset = reversal.day - payment.day;
      if (reversal.row.cardAccountId !== payment.row.cardAccountId || reversal.row.currency !== payment.row.currency
        || reversal.row.amountMinor !== -payment.row.amountMinor || offset < 0 || offset > rules.returnDays) continue;
      push(reversalEdges, payment.row.id, { reversalId: reversal.row.id, dayOffset: offset });
      reversalTaken.set(reversal.row.id, (reversalTaken.get(reversal.row.id) ?? 0) + 1);
    }
  }
  const returned: ReturnedCardPayment[] = [];
  for (const payment of unlinked) {
    // A payment payer references left with no candidate is never settled as returned on top of that, nor is one of a
    // component the owner answered (Root 03:30Z): each is only offered.
    if (orphanPayments.has(payment.row.id) || inAnswered(payment.row.id)) continue;
    const edges = reversalEdges.get(payment.row.id) ?? [];
    if (edges.length === 1 && reversalTaken.get(edges[0].reversalId) === 1 && payment.plain
      && readsAsReturnedPayment(reversals.get(edges[0].reversalId)!.row)) {
      returned.push({ paymentId: payment.row.id, reversalId: edges[0].reversalId, dayOffset: edges[0].dayOffset });
    }
  }
  const returnedIds = new Set(returned.map((item) => item.paymentId));
  const freePayments = unlinked.filter((payment) => !returnedIds.has(payment.row.id));
  const freeDebits = openDebits.filter((debit) => !netted.has(debit.row.id)
    && (!linkedDebits.has(debit.row.id) || orphanDebits.has(debit.row.id)));
  const freePaymentsByAmount = new Map<string, Payment[]>();
  for (const payment of freePayments) push(freePaymentsByAmount, amountKey(payment.row.currency, payment.row.amountMinor), payment);
  const freeDebitsByAmount = new Map<string, Debit[]>();
  for (const debit of freeDebits) push(freeDebitsByAmount, amountKey(debit.row.currency, debit.row.amountMinor), debit);
  const byCloseness = (a: CardPaymentCandidate, b: CardPaymentCandidate) =>
    Math.abs(a.dayOffset) - Math.abs(b.dayOffset) || a.dayOffset - b.dayOffset
    || debitRank.get(a.debitId)! - debitRank.get(b.debitId)! || paymentRank.get(a.paymentId)! - paymentRank.get(b.paymentId)!;
  const offerable = (payment: Payment, debit: Debit) =>
    inWindow(payment, debit) && debitMayBeOffered(debit, payment) && !rejected.has(pairKey(payment.row.id, debit.row.id));

  const checkingCovered = (date: string) => checkingAccountIds.some((id) => covers(checkingCoverage.get(id), date));
  const unmatchedPayments: UnmatchedCardPayment[] = freePayments.map((payment) => {
    const possibleDebits = (freeDebitsByAmount.get(amountKey(payment.row.currency, payment.row.amountMinor)) ?? [])
      .filter((debit) => offerable(payment, debit))
      .map((debit) => ({ paymentId: payment.row.id, debitId: debit.row.id, dayOffset: debit.day - payment.day }))
      .sort(byCloseness)
      .slice(0, rules.maxSuggestions);
    const reason: UnmatchedPaymentReason = checkingAccountIds.length === 0
      ? 'no-checking-account'
      : checkingCovered(payment.row.transactionDate) ? 'no-checking-debit' : 'checking-not-covered';
    const possibleReversals = [...(reversalEdges.get(payment.row.id) ?? [])]
      .sort((a, b) => a.dayOffset - b.dayOffset || compareText(a.reversalId, b.reversalId));
    return possibleReversals.length > 0
      ? { paymentId: payment.row.id, reason, possibleDebits, possibleReversals }
      : { paymentId: payment.row.id, reason, possibleDebits };
  });

  const leftOver = (debit: Debit): UnmatchedCheckingDebit => {
    // The cards it may be for: the one its masked number names; a housing pull, the Bilt card; naming several issuers,
    // any of theirs; naming none or one the rules do not know, any card. An issuer is read on the debit's day: Bilt before
    // Cardless pays the Wells Fargo card that carried it too.
    const cards = cardAccounts.filter((account) => (debit.card !== undefined
      ? account.id === debit.card
      : debit.kind.class === 'bilt-housing'
        ? isBiltCard(account.issuer)
        : isSeveral(debit)
          ? (debit.kind.payees ?? []).some((payee) => cardPaymentPayeeMayPay(payee, debit.row.date, account, biltCarrier))
          : debit.kind.payee === null || debit.kind.payee === 'unrecognized'
            || cardPaymentPayeeMayPay(debit.kind.payee, debit.row.date, account, biltCarrier)));
    const reason: UnmatchedDebitReason = cards.length === 0
      ? 'no-card-account'
      : cards.some((account) => covers(cardCoverage.get(account.id), debit.row.date)) ? 'no-card-payment' : 'card-not-covered';
    const possiblePayments = (freePaymentsByAmount.get(amountKey(debit.row.currency, debit.row.amountMinor)) ?? [])
      .filter((payment) => offerable(payment, debit))
      .map((payment) => ({ paymentId: payment.row.id, debitId: debit.row.id, dayOffset: debit.day - payment.day }))
      .sort(byCloseness)
      .slice(0, rules.maxSuggestions);
    return { debitId: debit.row.id, payee: debit.kind.payee, reason, possiblePayments };
  };
  const unmatchedDebits = freeDebits.filter((debit) => debit.kind.class === 'card-payment').map(leftOver);
  const biltHousing = freeDebits.filter((debit) => debit.kind.class === 'bilt-housing').map(leftOver);
  const dateOfPayment = (id: string) => payments.get(id)!.day;
  const dateOfDebit = (id: string) => debits.get(id)!.day;
  elsewhere.sort((a, b) => dateOfPayment(a.paymentId) - dateOfPayment(b.paymentId) || compareText(a.paymentId, b.paymentId));
  notCardPayments.sort((a, b) => dateOfDebit(a.debitId) - dateOfDebit(b.debitId) || compareText(a.debitId, b.debitId));
  stale.sort((a, b) => compareText(a.decisionId, b.decisionId));
  pending.sort((a, b) => compareText(a.transactionDate, b.transactionDate) || compareText(a.id, b.id));

  // Totals: every payment and every counted debit in exactly one part.
  const totals = new Map<string, CardPaymentReconciliationTotals>();
  const totalsOf = (currency: string) => {
    let entry = totals.get(currency);
    if (!entry) totals.set(currency, (entry = emptyTotals(currency)));
    return entry;
  };
  const add = (amount: ReconciliationAmount, amountMinor: number) => {
    amount.count += 1;
    amount.amountMinor += amountMinor;
  };
  const addPayment = (id: string, part: Exclude<keyof CardPaymentReconciliationTotals['payments'], 'all' | 'pending'>) => {
    const row = payments.get(id)!.row;
    const entry = totalsOf(row.currency).payments;
    add(entry.all, row.amountMinor);
    add(entry[part], row.amountMinor);
  };
  const addDebit = (id: string, part: Exclude<keyof CardPaymentReconciliationTotals['debits'], 'all'>) => {
    const row = debits.get(id)!.row;
    const entry = totalsOf(row.currency).debits;
    if (part !== 'notCardPayment' && part !== 'biltHousing' && part !== 'returned') add(entry.all, row.amountMinor);
    add(entry[part] ?? (entry[part] = emptyAmount()), row.amountMinor);
  };
  for (const pair of pairs) {
    addPayment(pair.paymentId, pair.status);
    addDebit(pair.debitId, pair.status);
  }
  for (const group of ambiguous) {
    group.paymentIds.forEach((id) => addPayment(id, 'ambiguous'));
    group.debitIds.forEach((id) => addDebit(id, 'ambiguous'));
  }
  for (const item of unmatchedPayments) addPayment(item.paymentId, 'unmatched');
  for (const item of elsewhere) addPayment(item.paymentId, 'elsewhere');
  for (const item of returned) addPayment(item.paymentId, 'returned');
  for (const item of unmatchedDebits) addDebit(item.debitId, 'unmatched');
  for (const item of notCardPayments) {
    // Only a debit that read as a card payment (or a Bilt housing pull) is counted as one the owner took out.
    if (debits.get(item.debitId)!.kind.class !== 'other') addDebit(item.debitId, 'notCardPayment');
  }
  for (const item of biltHousing) addDebit(item.debitId, 'biltHousing');
  for (const item of returnedDebits) addDebit(item.debitId, 'returned');
  for (const row of pending) add(totalsOf(row.currency).payments.pending, row.amountMinor);

  return {
    rulesVersion: rules.version,
    pairs,
    ambiguous,
    unmatchedPayments,
    unmatchedDebits,
    elsewhere,
    returned,
    notCardPayments,
    biltHousing,
    staleDecisions: stale,
    pendingPayments: pending.map((row) => row.id),
    totals: [...totals.values()].sort((a, b) => compareText(a.currency, b.currency)),
    classes,
    heldGroups,
    returnedDebits,
    withheld,
    biltCarrier,
    productCarriers: [...productCarriers].map(([product, cardAccountId]) => ({ product, cardAccountId })),
    retries: [...standIns.values()].sort((a, b) => paymentRank.get(a.paymentId)! - paymentRank.get(b.paymentId)!),
  };
}

/** Why a pair cannot be confirmed (null when it can): the API refuses a confirmation for any of these. */
export type CardPaymentConfirmRefusal =
  | 'not-a-payment'
  | 'not-a-debit'
  | 'amount-differs'
  | 'too-far-apart'
  | 'housing';

/**
 * Whether the owner may confirm (or reject) that `debit` paid `payment` (on a card of `issuer`): a posted payment to a
 * card and a posted debit of exactly its amount and currency, at most `confirmDays` apart, keeping to Bilt's lanes
 * (`housing`: never a housing pull for anything but a Bilt housing payment row, nor that row with anything but a
 * housing pull). Whether either is already taken is the store's to check.
 */
export function cardPaymentConfirmRefusal(
  payment: ReconciliationCardRow,
  debit: ReconciliationCheckingRow,
  issuer: string,
): CardPaymentConfirmRefusal | null {
  const card = paymentOf(payment, new Map([[payment?.cardAccountId, issuer]]));
  if (!card) return 'not-a-payment';
  const bank = debitOf(debit);
  if (!bank) return 'not-a-debit';
  if (bank.row.amountMinor !== card.row.amountMinor || bank.row.currency !== card.row.currency) return 'amount-differs';
  if (Math.abs(bank.day - card.day) > CARD_PAYMENT_RECONCILIATION_RULES.confirmDays) return 'too-far-apart';
  if (!debitMayBeOffered(bank, card)) return 'housing';
  return null;
}

/**
 * The rules' own test of whether a checking debit is a candidate for a card payment (`candidateEdge`), for `input` read
 * as `reconcileCardPayments` read it, with what its result found in the rows: the Wells Fargo card that carried the Bilt
 * card (`biltCarrier`), the one carrying each card product (`productCarriers`) and the retries standing in for their
 * returned pulls (`retries`). A posted payment to a card and a posted debit of exactly its amount and currency, within
 * the rules' days of it (or standing in for its pull), the debit paying that payment's card (Bilt's two lanes, the day
 * Cardless issued the Bilt card, the card a masked number names, the carriers, the issuer named). The owner's answers and
 * a pull netted with its unpaid return are not read. For the operator's report, which re-checks the rules' pairs against
 * the owner's rejections by it, never by a test of its own (PR280-R4).
 */
export function cardPaymentCandidateCheck(
  input: CardPaymentReconciliationInput,
  readings: Pick<CardPaymentReconciliation, 'biltCarrier' | 'productCarriers' | 'retries'>,
): (payment: ReconciliationCardRow, debit: ReconciliationCheckingRow) => boolean {
  const context = rowContextOf(input);
  const reading: Reading = {
    biltCarrier: readings.biltCarrier,
    productCarriers: new Map(readings.productCarriers.map((item) => [item.product, item.cardAccountId])),
    standIns: new Set(readings.retries.map((item) => pairKey(item.paymentId, item.debitId))),
  };
  return (paymentRow, debitRow) => {
    const payment = paymentOf(paymentRow, context.issuers);
    const debit = readDebit(debitRow, context);
    return payment !== null && debit !== null && candidateEdge(payment, debit, reading);
  };
}

/** Whether `row` can be reconciled as a payment (a posted payment to a card with a valid date and currency). */
export function isReconcilableCardPayment(row: ReconciliationCardRow): boolean {
  return paymentOf(row, new Map()) !== null;
}

/** Whole days from a payment's transaction date to a debit's date, negative when the debit came first; null for a bad date. */
export function cardPaymentDayOffset(
  payment: Pick<ReconciliationCardRow, 'transactionDate'>,
  debit: Pick<ReconciliationCheckingRow, 'date'>,
): number | null {
  const from = dayNumber(payment?.transactionDate);
  const to = dayNumber(debit?.date);
  return from === null || to === null ? null : to - from;
}

/** Whether `row` can be reconciled as a debit (posted money out with a valid date and currency). */
export function isReconcilableCheckingDebit(row: ReconciliationCheckingRow): boolean {
  return debitOf(row) !== null;
}
