/**
 * The card import tool's kind rules live in the shared package root (../cardKinds.ts), so a Root-GO'd operator command
 * can set a stored row to the tool's own reading without the API importing the tool (apps/api keeps the offline parsers
 * out: routes/cardSpending.test.ts, "import boundary"). The converters import them from here, unchanged.
 */
export { classifyCardKind, type KindInput } from '../cardKinds.js';
