/**
 * Every checking export format the converter reads. A bank adds its formats here, one line each, with the adapter in
 * its own module; the generic core (convert.ts) never names a bank.
 */
import { bankOfxAdapter } from './bankOfx.js';
import { fifthThirdCsvAdapter } from './fifthThirdCsv.js';
import { fifthThirdStatementAdapter } from './fifthThirdStatement.js';
import type { CheckingExportAdapter, CheckingExportInput } from './parsed.js';
import { wellsFargoCsvAdapter } from './wellsFargoCsv.js';
import { wellsFargoStatementAdapter } from './wellsFargoStatement.js';

export const CHECKING_EXPORT_ADAPTERS: readonly CheckingExportAdapter[] = Object.freeze([
  bankOfxAdapter,
  wellsFargoCsvAdapter,
  wellsFargoStatementAdapter,
  fifthThirdCsvAdapter,
  fifthThirdStatementAdapter,
]);

/** The adapter whose source slug is `source`, or null. */
export function checkingExportAdapter(source: string): CheckingExportAdapter | null {
  return CHECKING_EXPORT_ADAPTERS.find((adapter) => adapter.source === source) ?? null;
}

/** The adapters that recognize `input`; the converter uses one only when exactly one does. */
export function detectCheckingExportAdapters(input: CheckingExportInput): CheckingExportAdapter[] {
  return CHECKING_EXPORT_ADAPTERS.filter((adapter) => adapter.input === input.kind && adapter.detect(input));
}
