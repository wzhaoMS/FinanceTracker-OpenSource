/**
 * The offline checking import tool as a library (`@finance-tracker/shared/checking-import-tool`): pure functions only,
 * no file system or network. Holdr's API server must never import this; raw bank exports are parsed only on the
 * owner's computer, by the converter CLI (apps/api `holdr-checking-convert`).
 */
export { CHECKING_EXPORT_ADAPTERS, checkingExportAdapter, detectCheckingExportAdapters } from './adapters.js';
export { bankOfxAdapter, parseBankOfx } from './bankOfx.js';
// The card tool's byte decoder and exact amount parser, so the converter CLI needs only this tool.
export { decodeExport, ExportDecodeError, type ExportEncoding } from '../cardImportTool/decode.js';
export { currencyExponent, parseAmount } from '../cardImportTool/amount.js';
export {
  CHECKING_IMPORT_TOOL_PARSER,
  CHECKING_IMPORT_TOOL_VERSION,
  CheckingConvertError,
  checkingCurrencyExponent,
  convertCheckingExports,
  knownAccountDigits,
  maskKnownAccountDigits,
  type CheckingConvertFileReport,
  type CheckingConvertInput,
  type CheckingConvertOptions,
  type CheckingConvertReport,
  type CheckingConvertResult,
} from './convert.js';
export {
  describeFifthThirdCsvLayout,
  FIFTH_THIRD_CSV_LAYOUTS,
  FIFTH_THIRD_CSV_SOURCE,
  FIFTH_THIRD_INSTITUTION,
  fifthThirdCsvAdapter,
  parseFifthThirdCsv,
} from './fifthThirdCsv.js';
export {
  describeFifthThirdStatementLayout,
  FIFTH_THIRD_STATEMENT_SOURCE,
  fifthThirdStatementAdapter,
  parseFifthThirdStatement,
} from './fifthThirdStatement.js';
export { parseWellsFargoCsv, wellsFargoCsvAdapter } from './wellsFargoCsv.js';
export { describeWellsFargoStatementLayout, parseWellsFargoStatement, wellsFargoStatementAdapter } from './wellsFargoStatement.js';
export {
  CheckingExportFormatError,
  withAccountNumbers,
  type CheckingAdapterOptions,
  type CheckingExportAdapter,
  type CheckingExportInput,
  type CheckingPdfPage,
  type CheckingPdfTextItem,
  type CheckingRowProblem,
  type ParsedCheckingBalance,
  type ParsedCheckingExport,
  type ParsedCheckingRow,
  type ParsedCheckingStatement,
} from './parsed.js';
