/**
 * Transaction kind from sign, issuer type and description. Deterministic and
 * deliberately small: a card payment is a transfer, not spending, so payment
 * wording is matched on credits. On a charge it means a payment only when the
 * same text says the payment was returned or reversed (RETURNED, REVERSED,
 * REVERSAL, DISHONORED or NSF and a payment word, in either order): any other
 * payment wording on a charge (ONLINE, WEB or BILL PAYMENT: a bill paid with
 * the card) is read as if it were not there. A card payment, or a payment
 * taken back, never names a fee: payment wording beside FEE or FEES is a fee
 * for a payment on a charge ("NSF PAYMENT FEE"), and on a credit a fee given
 * back, of the kind its own charge gets ({@link cardGiveBackKind}): an
 * adjustment for the card's own fee ("RETURNED PAYMENT FEE REVERSAL"), a
 * refund for a merchant's ("SAMPLE UTILITY ONLINE PAYMENT FEE REFUND").
 * Fees and interest
 * are matched on charges; cash advances and balance transfers are `other` (not
 * spending) whichever way they move, except a credit that is a fee or interest
 * by its type or wording, which keeps the refund that offsets its charge;
 * everything else is a purchase (charge) or a refund (credit). A second text
 * (`evidence`) is read by every wording rule apart from the description, never
 * joined to it. The converter prints totals by kind so a misclassified row is
 * easy to spot. Spending reads a stored charge that takes a payment back
 * ({@link isReturnedCardPaymentCharge}) as a card payment whatever kind it was
 * stored with, and a stored payment that names a fee ({@link namesCardFee}) as
 * this classifier kinds it now (cardSpending.ts, `effectiveCardKind`); and its
 * inferred categories file a credit giving a fee or interest back as the
 * charge it gives back ({@link cardGivenBackCharge}).
 */
import type { CardTransactionKind } from './types.js';

const PAY = String.raw`(?:PAYMENT|PAYMT|PYMT|PMT)`;
const PAYMENT = new RegExp([
  String.raw`\bAUTO[\s-]?PAY\b`,
  String.raw`\bAUTO[\s-]?${PAY}\b`,
  String.raw`\bAUTOPAY${PAY}\b`,
  String.raw`\b${PAY}\b.*\bTHANK\s*YOU\b`,
  String.raw`\bTHANK\s*YOU\b.*\b${PAY}\b`,
  String.raw`\b(?:ONLINE|MOBILE|INTERNET|ELECTRONIC|ACH|WEB|PHONE|AUTOMATIC|RECURRING|BILL)\s+(?:ACH\s+)?${PAY}\b`,
  String.raw`\bE-?PAYMENT\b`,
  String.raw`\b${PAY}\s+(?:RECEIVED|POSTED|FROM)\b`,
  String.raw`\b(?:RETURNED|REVERSED|DISHONOU?RED|NSF)\s+${PAY}\b`,
  String.raw`\b${PAY}\s+(?:RETURNED|REVERSAL|REVERSED)\b`,
  String.raw`\bDIRECT\s?PAY\b`,
  String.raw`\bBILL\s?PAY\b`,
].join('|'), 'i');
/**
 * A payment word: PAYMENT or an abbreviation, or any compound the PAYMENT pattern reads as a payment (AUTOPAY, AUTOPMT,
 * AUTOPAYMENT, AUTOPAYPMT, E-PAYMENT, DIRECTPAY, BILL PAY), so a charge reads every one the credit rule reads.
 */
const PAY_WORD = String.raw`(?:${PAY}|AUTO[\s-]?PAY|AUTO[\s-]?${PAY}|AUTOPAY${PAY}|E-?PAYMENT|DIRECT\s?PAY|BILL\s?PAY)`;
const HAS_PAY_WORD = new RegExp(String.raw`\b${PAY_WORD}\b`, 'i');
/** Whether a text has any payment word the kind rules know (PAYMENT, PMT, AUTOPAY, BILL PAY, ...). */
export function hasCardPaymentWord(text: string): boolean {
  return HAS_PAY_WORD.test(text);
}
const RETURN_WORD = String.raw`(?:RETURNED|REVERSED|REVERSAL|DISHONOU?RED|NSF)`;
/** A payment returned or reversed: a return word and a payment word, in either order, in one text. */
const RETURNED_PAYMENT = new RegExp(String.raw`\b${RETURN_WORD}\b.*\b${PAY_WORD}\b|\b${PAY_WORD}\b.*\b${RETURN_WORD}\b`, 'i');
const INTEREST = /\bINTEREST\s+CHARGED?\b|\b(?:PURCHASE|CASH\s+ADVANCE|BALANCE\s+TRANSFER)\s+INTEREST\b|\bFINANCE\s+CHARGE\b|\bINTEREST\s+ON\s+(?:PURCHASES|CASH)\b/i;
const FEE = /\b(?:ANNUAL|MEMBERSHIP|LATE(?:\s+PAYMENT)?|RETURNED\s+(?:PAYMENT|CHECK)|FOREIGN\s+(?:TRANSACTION|TRANS|TXN|CURRENCY|EXCHANGE)|INTERNATIONAL\s+(?:TRANSACTION|TXN)|CASH\s+ADVANCE|BALANCE\s+TRANSFER|OVER\s*LIMIT|PLAN|SERVICE|CARD\s+REPLACEMENT|EXPEDITED\s+DELIVERY|PAY\s+OVER\s+TIME)\s+FEES?\b|\bFEE\s*-\s*(?:ANNUAL|LATE)\b|\bANNUAL\s+MEMBERSHIP\b/i;
const CASH_LIKE = /\bCASH\s+ADVANCE\b|\bBALANCE\s+TRANSFER\b|\bCONVENIENCE\s+CHECK\b/i;
const REVERSAL = /\b(?:FEE|FEES|INTEREST|FINANCE\s+CHARGE)\b.*\b(?:REVERSAL|REVERSED|REFUND|CREDIT|ADJ|ADJUSTMENT|WAIVED?|WAIVER)\b|\b(?:REVERSAL|CREDIT|ADJ|ADJUSTMENT)\b.*\b(?:FEE|FEES|INTEREST)\b/i;
const FEE_CATEGORY = /^\s*fees?\s*&\s*adjustments?\b/i;
/**
 * A card's own fee or interest wording, as the charge rules read it (FEE and INTEREST): a charge that has it is a fee or
 * interest, and a credit that has it gives one back. The category rules that file a row over its issuer's category
 * (cardCategoryInference.ts) leave such rows where they are: a charge and its credit share the wording, not the kind.
 */
export const CARD_FEE_OR_INTEREST_WORDING = new RegExp(`${FEE.source}|${INTEREST.source}`, 'i');
/** A word that makes a charge a cost whatever else it says: a fee, a charge or a penalty for something, or interest. */
const COST_WORD = /\b(?:FEES?|CHARGES?|PENALTY|PENALTIES|INTEREST)\b/i;
/**
 * A returned payment whose text the issuer cut short: a return word, then a payment word cut off where the text ends,
 * as Capital One's OFX cuts every name at 25 characters ("Returned Online ACH Payme"). The cut word is a prefix of
 * PAYMENT(S) of at least four letters, or PMT, and only at the very end, so a merchant whose name starts with PAYM
 * ("PAYMENTUS") is never one, with a return word or without. Read rule only: the converter's charge rule
 * (RETURNED_PAYMENT) is unchanged, and stores such a row as a purchase.
 */
const RETURNED_PAYMENT_CUT = new RegExp(String.raw`\b${RETURN_WORD}\b.*\b(?:PAYM(?:E(?:N(?:TS?)?)?)?|PMT)$`, 'i');
/**
 * A fee, named: FEE or FEES, as a word. Never CHARGE, which a payment's own text can say ("PAYMENT TO CHARGE ACCOUNT").
 */
const FEE_WORD = /\bFEES?\b/i;

/**
 * Whether a text names a fee (FEE or FEES, as a word: `COFFEE` or `FEED` does not). A card payment never does, nor does
 * a payment the card took back: a text that has payment wording and names a fee is a fee for a payment ("NSF PAYMENT
 * FEE", "RETURNED ONLINE PAYMENT FEE") or a fee given back ("RETURNED PAYMENT FEE REVERSAL").
 */
export function hasCardFeeWord(text: string): boolean {
  return FEE_WORD.test(text);
}

/**
 * Whether a row's own text names a fee ({@link hasCardFeeWord}), in its description or its merchant, each read on its own.
 * The issuer's category is never read: issuers file card payments under fees too ("Fees & Adjustments-Payments").
 */
export function namesCardFee(row: { description: string; merchant?: string | null }): boolean {
  return [row.description, row.merchant].some((text) => typeof text === 'string' && FEE_WORD.test(text));
}

/**
 * A fee or interest named, as the classifier's fee and interest wording names one: FEE or FEES, INTEREST, FINANCE CHARGE,
 * or ANNUAL MEMBERSHIP (a card fee with no FEE word). What a credit that gives one back names.
 */
const GIVEN_BACK_NAME = String.raw`\b(?:FEES?|INTEREST|FINANCE\s+CHARGES?|ANNUAL\s+MEMBERSHIP)\b`;
/** A word that gives a fee or interest back, as the reversal wording reads it. */
const GIVE_BACK = String.raw`\b(?:REVERSAL|REVERSED|REFUND|CREDIT|ADJUSTMENT|ADJ|WAIVED?|WAIVER)\b`;
/** Give-back words leading a text, each before OF, FOR or a separator: "REVERSAL OF LATE FEE", "CREDIT - ANNUAL FEE". */
const LEADING_GIVE_BACK = new RegExp(String.raw`^(?:\W*${GIVE_BACK}(?:\s*[-–—:;,/]+|\s+(?:OF|FOR)\b))+\W*`, 'i');
/** A payment word right before a text's end, or right after its start. */
const PAY_WORD_BEFORE = new RegExp(String.raw`\b${PAY_WORD}\W*$`, 'i');
const PAY_WORD_AFTER = new RegExp(String.raw`^\W*${PAY_WORD}\b`, 'i');

/**
 * The words of the charge a credit gives back, read from the credit's own text: the text less the words that give it
 * back, as the reversal wording reads them (REVERSAL, REVERSED, REFUND, CREDIT, ADJ, ADJUSTMENT, WAIVED, WAIVER). Those
 * are the ones after its last fee or interest name ("NSF PAYMENT FEE REFUND" gives back an "NSF PAYMENT FEE"), and the
 * ones leading the text before OF, FOR or a separator ("REVERSAL OF LATE FEE" and "CREDIT - LATE FEE" give back a "LATE
 * FEE"). Every other word is the charge's own: a bare leading one, as a merchant's name has it ("CREDIT SAMPLE STORE FEE
 * REFUND" gives back a "CREDIT SAMPLE STORE FEE"), one before the fee's name ("PAYMENT REVERSAL FEE REFUND"), and REVERSAL
 * or REVERSED beside a payment word, which names the returned payment a fee is for ("REVERSED PAYMENT FEE REFUND", "FEE
 * FOR REVERSED PAYMENT REFUND"). A fee or interest is named as the classifier's own wording names one: FEE or FEES,
 * INTEREST, FINANCE CHARGE, or ANNUAL MEMBERSHIP. Null for a text that names none.
 */
export function cardGivenBackText(text: string): string | null {
  let end = -1;
  for (const match of text.matchAll(new RegExp(GIVEN_BACK_NAME, 'gi'))) end = match.index + match[0].length;
  if (end < 0) return null;
  const head = text.slice(0, end).replace(LEADING_GIVE_BACK, '');
  const tail = text.slice(end).replace(new RegExp(GIVE_BACK, 'gi'), (word: string, offset: number) => {
    const at = end + offset;
    const returnedPayment = /^REVERS/i.test(word)
      && (PAY_WORD_BEFORE.test(text.slice(0, at)) || PAY_WORD_AFTER.test(text.slice(at + word.length)));
    return returnedPayment ? word : ' ';
  });
  return `${head}${tail}`.replace(/\s+/g, ' ').replace(/[\s\-–—:;,./]+$/, '').trim();
}

/**
 * The charge a credit gives back, read from the credit's own words ({@link cardGivenBackText}, its description and its
 * merchant each on its own) and kinded as the import classifier kinds a charge with those words, with the issuer's
 * marks on the credit (its category, and its OFX type at conversion): a card's own fee or interest ("LATE FEE
 * REVERSAL", "NSF PAYMENT FEE REFUND", "INTEREST CHARGE REVERSAL", or one its issuer files under fees), or a merchant's
 * charge ("SAMPLE PARKING FEE REFUND" gives back a purchase, "SAMPLE PARKING FEE"). Null for a credit whose texts name
 * no fee or interest: it gives back no fee or interest. The kind is the one every converter version gives such a charge
 * (the classifier's charge words and the issuer's category; no converter stores the OFX type), so for a stored credit it
 * is its stored charge's kind; a charge kinded otherwise (by its OFX type alone, or by a producer that kinds rows
 * itself) reads as its words and category say.
 */
export function cardGivenBackCharge(row: {
  description: string;
  merchant?: string | null;
  issuerCategory?: string | null;
  typeHint?: string | null;
}): { kind: CardTransactionKind; description: string; merchant: string | null } | null {
  const description = cardGivenBackText(row.description);
  const merchant = row.merchant ? cardGivenBackText(row.merchant) : null;
  if (description === null && merchant === null) return null;
  const charge = { description: description ?? row.description, merchant: merchant ?? (row.merchant || null) };
  const kind = classifyCardKind({
    amountMinor: 1, description: charge.description, evidence: charge.merchant, issuerCategory: row.issuerCategory ?? null,
    typeHint: row.typeHint ?? null,
  });
  return { kind, ...charge };
}

/**
 * The kind of a credit that gives back a charge of this kind: the kind its own charge gets. A card's fee or interest is
 * given back by an adjustment, a card-cost reversal; a merchant's charge, a merchant's own fee among them, by a refund;
 * a cash advance or a balance transfer stays `other`, and a payment taken back is a payment again. So a charge and its
 * give-back always count in the same way, and ({@link cardGivenBackCharge}) under the same category.
 */
export function cardGiveBackKind(charge: CardTransactionKind): CardTransactionKind {
  if (charge === 'fee' || charge === 'interest') return 'adjustment';
  if (charge === 'purchase') return 'refund';
  return charge;
}

/**
 * A charge that takes back a payment to the card: the issuer debiting the card again for a payment it had credited,
 * because the bank returned it (a verification problem, NSF) or it was reversed. Its own words say so as the charge
 * rules read them (RETURNED, REVERSED, REVERSAL, DISHONORED or NSF and a payment word, in either order: "RETURNED
 * ONLINE ACH PAYMENT", "PAYMENT REVERSAL"), in its description or its merchant, each read on its own. Never a row
 * either of whose texts names a fee, a charge, a penalty or interest, or has the fee or interest wording: a fee for a
 * returned payment ("RETURNED PAYMENT FEE", "NSF PAYMENT FEE") is a cost. A credit or a zero amount is never one.
 *
 * A row stored as a purchase is one with the payment word cut off where the issuer cut the text, too ("Returned Online
 * ACH Payme"). Only such a row: a fee cut short before its FEE reads the same, so a row its issuer marked as a fee (by
 * its type or its category, which the import classifier stores as a fee) keeps that.
 */
export function isReturnedCardPaymentCharge(row: {
  amountMinor: number;
  description: string;
  merchant?: string | null;
  /** The kind the row was stored with: only a purchase is read with its payment word cut off. */
  kind?: CardTransactionKind;
}): boolean {
  if (!(row.amountMinor > 0)) return false;
  const texts = [row.description, row.merchant].filter((text): text is string => typeof text === 'string' && text !== '');
  const cut = row.kind === 'purchase';
  return texts.some((text) => RETURNED_PAYMENT.test(text) || (cut && RETURNED_PAYMENT_CUT.test(text)))
    && !texts.some((text) => COST_WORD.test(text) || CARD_FEE_OR_INTEREST_WORDING.test(text));
}

export interface KindInput {
  /** Holdr sign: positive = money spent. */
  amountMinor: number;
  description: string;
  issuerCategory?: string | null;
  /** OFX TRNTYPE, when known. */
  typeHint?: string | null;
  /**
   * A second text of the same row (bilt-csv: Bilt's own Description, beside the Raw Merchant Name stored as the
   * description). Every wording rule tests it on its own, and a match in either text counts; the two are never
   * joined, so no pattern can span them. Null for every other format.
   */
  evidence?: string | null;
}

export function classifyCardKind(input: KindInput): CardTransactionKind {
  const text = input.description;
  const evidence = input.evidence ?? null;
  const says = (pattern: RegExp) => pattern.test(text) || (evidence !== null && pattern.test(evidence));
  const type = (input.typeHint ?? '').toUpperCase();
  const feeCategory = FEE_CATEGORY.test(input.issuerCategory ?? '');
  if (input.amountMinor === 0) return 'other';
  if (input.amountMinor > 0) {
    if (type === 'INT' || says(INTEREST)) return 'interest';
    if (type === 'FEE' || type === 'SRVCHG' || says(FEE) || feeCategory) return 'fee';
    // A returned or reversed payment undoes a transfer; it is not spending either. A fee for one names a fee ("NSF
    // PAYMENT FEE", "RETURNED ONLINE PAYMENT FEE"): it is a fee. Any other payment wording on a charge (a bill paid with
    // the card) says nothing about this card's payments: the rules below read it as usual.
    if (says(RETURNED_PAYMENT)) return says(FEE_WORD) ? 'fee' : 'payment';
    if (type === 'CASH' || type === 'ATM' || says(CASH_LIKE)) return 'other';
    return 'purchase';
  }
  // A card payment never names a fee: a credit worded as a payment that names one gives a fee back, and takes the kind
  // its own charge gets (cardGivenBackCharge, cardGiveBackKind). The card's own fee is offset by an adjustment ("RETURNED
  // PAYMENT FEE REVERSAL", "NSF PAYMENT FEE REFUND", or a fee the issuer marks as its own by its category or type); a
  // merchant's fee for being paid online is a purchase, and its refund a refund ("SAMPLE UTILITY ONLINE PAYMENT FEE REFUND").
  if (type === 'PAYMENT' || says(PAYMENT)) {
    if (!says(FEE_WORD)) return 'payment';
    const charge = cardGivenBackCharge({ description: text, merchant: evidence, issuerCategory: input.issuerCategory, typeHint: input.typeHint });
    return charge === null ? 'adjustment' : cardGiveBackKind(charge.kind);
  }
  if (type === 'INT' || says(REVERSAL) || feeCategory) return 'adjustment';
  // A balance moved to another card, or a cash advance taken back, is never a merchant's
  // refund: as a refund it would take the whole amount off spending. A credit of a fee or
  // interest on one (by its type or its wording) is no principal, though: it keeps the
  // refund that offsets its charge.
  if (says(CASH_LIKE) && !(type === 'FEE' || type === 'SRVCHG' || says(FEE) || says(INTEREST))) return 'other';
  return 'refund';
}
