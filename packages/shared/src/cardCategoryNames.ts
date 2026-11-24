/**
 * The card category names that the shared item tree (itemTaxonomy.ts) and the reviewed inference rules
 * (cardCategoryInference.ts) name: the issuers' names (Spending's card categories, as the issuers spell them), and
 * Holdr's own tax category, which no issuer's taxonomy has. This module is the one source of each: both import their
 * names from here and hold no copy, so they can never spell one differently.
 *
 * A value is never changed: the item tree's digests (Amazon's `AMAZON_TAXONOMY_DIGEST` among them) and the inference
 * rules' answers depend on these exact strings. The asset category is cardSpending.ts's `CARD_ASSET_CATEGORY`,
 * imported where it is used. A leaf module: it imports nothing.
 */

export const CARD_CATEGORY_GROCERIES = 'Merchandise & Supplies-Groceries';
export const CARD_CATEGORY_WHOLESALE_STORES = 'Merchandise & Supplies-Wholesale Stores';
export const CARD_CATEGORY_PHARMACIES = 'Merchandise & Supplies-Pharmacies';
export const CARD_CATEGORY_FURNISHING = 'Merchandise & Supplies-Furnishing';
export const CARD_CATEGORY_HARDWARE_SUPPLIES = 'Merchandise & Supplies-Hardware Supplies';
export const CARD_CATEGORY_COMPUTER_SUPPLIES = 'Merchandise & Supplies-Computer Supplies';
export const CARD_CATEGORY_ELECTRONICS_STORES = 'Merchandise & Supplies-Electronics Stores';
export const CARD_CATEGORY_INTERNET_PURCHASE = 'Merchandise & Supplies-Internet Purchase';
export const CARD_CATEGORY_GENERAL_RETAIL = 'Merchandise & Supplies-General Retail';
export const CARD_CATEGORY_ARTS_JEWELRY = 'Merchandise & Supplies-Arts & Jewelry';
export const CARD_CATEGORY_BOOK_STORES = 'Merchandise & Supplies-Book Stores';
export const CARD_CATEGORY_CLOTHING_STORES = 'Merchandise & Supplies-Clothing Stores';
export const CARD_CATEGORY_SPORTING_GOODS_STORES = 'Merchandise & Supplies-Sporting Goods Stores';
export const CARD_CATEGORY_OFFICE_SUPPLIES = 'Business Services-Office Supplies';
export const CARD_CATEGORY_RESTAURANT = 'Restaurant-Restaurant';
export const CARD_CATEGORY_BAR_CAFE = 'Restaurant-Bar & Café';
export const CARD_CATEGORY_AUTO_SERVICES = 'Transportation-Auto Services';
export const CARD_CATEGORY_FUEL = 'Transportation-Fuel';
export const CARD_CATEGORY_TAXIS_COACH = 'Transportation-Taxis & Coach';
export const CARD_CATEGORY_PARKING_CHARGES = 'Transportation-Parking Charges';
export const CARD_CATEGORY_TOLLS_FEES = 'Transportation-Tolls & Fees';
export const CARD_CATEGORY_AIRLINE = 'Travel-Airline';
export const CARD_CATEGORY_LODGING = 'Travel-Lodging';
export const CARD_CATEGORY_VEHICLE_RENTAL = 'Travel-Vehicle Rental';
export const CARD_CATEGORY_TRAVEL_AGENCIES = 'Travel-Travel Agencies';
export const CARD_CATEGORY_FEES_ADJUSTMENTS = 'Fees & Adjustments-Fees & Adjustments';

/** Holdr's own category for a tax paid by card: no issuer's taxonomy has one. */
export const CARD_TAX_CATEGORY = 'Taxes';

/** Every name above, in the order declared: exactly the names the item tree and the inference rules use. */
export const CARD_CATEGORY_NAMES = Object.freeze([
  CARD_CATEGORY_GROCERIES,
  CARD_CATEGORY_WHOLESALE_STORES,
  CARD_CATEGORY_PHARMACIES,
  CARD_CATEGORY_FURNISHING,
  CARD_CATEGORY_HARDWARE_SUPPLIES,
  CARD_CATEGORY_COMPUTER_SUPPLIES,
  CARD_CATEGORY_ELECTRONICS_STORES,
  CARD_CATEGORY_INTERNET_PURCHASE,
  CARD_CATEGORY_GENERAL_RETAIL,
  CARD_CATEGORY_ARTS_JEWELRY,
  CARD_CATEGORY_BOOK_STORES,
  CARD_CATEGORY_CLOTHING_STORES,
  CARD_CATEGORY_SPORTING_GOODS_STORES,
  CARD_CATEGORY_OFFICE_SUPPLIES,
  CARD_CATEGORY_RESTAURANT,
  CARD_CATEGORY_BAR_CAFE,
  CARD_CATEGORY_AUTO_SERVICES,
  CARD_CATEGORY_FUEL,
  CARD_CATEGORY_TAXIS_COACH,
  CARD_CATEGORY_PARKING_CHARGES,
  CARD_CATEGORY_TOLLS_FEES,
  CARD_CATEGORY_AIRLINE,
  CARD_CATEGORY_LODGING,
  CARD_CATEGORY_VEHICLE_RENTAL,
  CARD_CATEGORY_TRAVEL_AGENCIES,
  CARD_CATEGORY_FEES_ADJUSTMENTS,
  CARD_TAX_CATEGORY,
] as const);
export type CardCategoryName = (typeof CARD_CATEGORY_NAMES)[number];
