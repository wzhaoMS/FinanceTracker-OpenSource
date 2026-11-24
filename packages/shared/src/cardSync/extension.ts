/**
 * Pure contracts used by synthetic extension targets. Do not traverse the
 * application barrel: unrelated catalog initialization can retain real-site URLs.
 */
export * from './index.js';
export { CARD_IMPORT_MAX_AMOUNT_MINOR, CARD_IMPORT_NO_DESCRIPTION, isCardImportDate } from '../cardImport.js';
export { cardExternalIdHash, toLetterHex } from '../cardDedupe.js';
