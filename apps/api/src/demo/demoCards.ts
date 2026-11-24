import type { BenefitProductChoice, CardOwner } from '@finance-tracker/shared';

import type { CardImportRow } from '../services/sqliteStateRepo.js';
import { addMonths } from './demoCalendar.js';

/** Full months of card history before the current one. */
export const DEMO_SPENDING_MONTHS = 15;

/** The first day of the demo's card history for `today` (YYYY-MM-DD): the first of the month fifteen months back. */
export const demoHistoryStart = (today: string): string => `${addMonths(today.slice(0, 7), -DEMO_SPENDING_MONTHS)}-01`;

/**
 * The demo household's cards. Nicknames name their products, so the Benefits tab recognizes the premium ones from
 * the catalog (American Express Gold and Platinum, Citi Strata Elite); the everyday Chase card and the cash-back card,
 * which have no statement credits, are set to track no benefits. Card endings are fixed synthetic values.
 */

export type DemoCardKey = 'alex-gold' | 'casey-platinum' | 'casey-visa' | 'joint-cash' | 'joint-strata';

export interface DemoCard {
  key: DemoCardKey;
  issuer: 'amex' | 'chase' | 'citi';
  owner: CardOwner;
  nickname: string;
  last4: string;
  /** The Benefits tab's product choice: by nickname (`auto`) or none at all. */
  productChoice: BenefitProductChoice;
  /** The month (1–12) the card's annual fee posts and its cardmember year starts; null for a card without a fee. */
  anniversaryMonth: number | null;
  /** The day of the month the card's autopay pays the last statement (its due date). */
  payDay: number;
}

export const DEMO_CARDS: readonly DemoCard[] = Object.freeze([
  { key: 'alex-gold', issuer: 'amex', owner: 'alex', nickname: 'Alex Gold Card', last4: '1001', productChoice: 'auto', anniversaryMonth: 3, payDay: 22 },
  { key: 'casey-platinum', issuer: 'amex', owner: 'casey', nickname: 'Casey Platinum Card', last4: '5005', productChoice: 'auto', anniversaryMonth: 6, payDay: 24 },
  { key: 'casey-visa', issuer: 'chase', owner: 'casey', nickname: 'Casey Everyday Visa', last4: '2002', productChoice: 'none', anniversaryMonth: null, payDay: 18 },
  { key: 'joint-cash', issuer: 'citi', owner: 'joint', nickname: 'Household Cash Back', last4: '3003', productChoice: 'none', anniversaryMonth: null, payDay: 20 },
  { key: 'joint-strata', issuer: 'citi', owner: 'joint', nickname: 'Joint Strata Elite', last4: '6006', productChoice: 'auto', anniversaryMonth: 9, payDay: 26 },
]);

export const demoCard = (key: DemoCardKey): DemoCard => DEMO_CARDS.find((card) => card.key === key)!;

/** A card row with the card it belongs to. */
export interface DemoCardRow extends CardImportRow {
  card: DemoCardKey;
}

/** One of the owner's Benefits tab marks for a period of a benefit Holdr can't read off statements (Uber Cash). */
export interface DemoBenefitMark {
  card: DemoCardKey;
  benefitId: string;
  periodStart: string;
  status: 'used' | 'partial' | 'unused';
  usedMinor: number | null;
}
