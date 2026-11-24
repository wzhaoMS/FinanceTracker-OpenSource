/**
 * OFX 1.x (SGML), OFX 2.x (XML), QFX and QBO bank statements (BANKMSGSRSV1 / STMTRS), from any bank: the generic
 * adapter of the checking import tool. Files are tokenized by the card import tool's reader (cardImportTool/ofx.ts),
 * with its limits and refusals: no DTD or entities, nothing longer than it reads, nothing truncated.
 *
 * Read per statement: CURDEF, BANKACCTFROM's ACCTID (its last four digits are kept; the whole number only feeds the
 * leak checks) and ACCTTYPE, BANKTRANLIST's DTSTART and DTEND, LEDGERBAL and AVAILBAL, STATUS codes (to report an
 * error), and when the file was made (SONRS DTSERVER). Per transaction: TRNTYPE (a hint), DTPOSTED, DTUSER, TRNAMT,
 * FITID (the core hashes it), NAME (or PAYEE/NAME), MEMO and CHECKNUM. Only BANKTRANLIST's STMTTRN entries are read,
 * which OFX defines as posted; a file holding a pending list (BANKTRANLISTP) is refused.
 *
 * A bank's TRNAMT is positive for money in and negative for money out, which is the checking sign, so nothing is
 * flipped; a file whose DEBIT and CREDIT rows mostly carry the opposite sign is refused rather than guessed.
 *
 * Every transaction and transaction list in the file must belong to a legitimate bank statement block, each with
 * exactly one list (checkOwnership); a file with several blocks is read only for the one --account picks.
 */
import { cardLast4 } from '../cardNumbers.js';
import { CHECKING_BANK_TYPES } from '../checkingImport.js';
import { currencyExponent, parseAmount } from '../cardImportTool/amount.js';
import { ofxReader, type OfxNode } from '../cardImportTool/ofx.js';
import { ExportFormatError } from '../cardImportTool/parsed.js';
import {
  CheckingExportFormatError,
  withAccountNumbers,
  type CheckingAdapterOptions,
  type CheckingExportAdapter,
  type CheckingExportInput,
  type ParsedCheckingBalance,
  type ParsedCheckingExport,
  type ParsedCheckingRow,
} from './parsed.js';

const { readOfxTree, descendants, childNamed, childrenNamed, valueOf, ofxDateTime, ofxMetadata, describe, statusError, tokenize, treeFromTokens } = ofxReader;
const SINGLE_FIELDS = [...ofxReader.singleFields, 'CHECKNUM'];

/**
 * The card reader's refusals leave as this tool's own, with fixed labels only (Root 03:47Z): no line number (a
 * position in the file) and no element name the file wrote (its own text, which leaves as a fixed label).
 */
function asChecking<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ExportFormatError) {
      throw new CheckingExportFormatError(error.message.replace(/line [0-9]+: /g, '')
        .replace(/<([^<>]*)>/g, (tag, name: string) => (name === 'OFX' ? tag : 'an OFX element')));
    }
    throw error;
  }
}

interface BankStatement {
  node: OfxNode;
  last4: string | null;
  accountType: OfxAccountType | null;
  accountId: string | null;
}

/** The account types OFX defines for BANKACCTFROM; anything else is unreadable, and never repeated in a message. */
const OFX_ACCOUNT_TYPES = ['CHECKING', 'SAVINGS', 'MONEYMRKT', 'CREDITLINE', 'CD'] as const;
type OfxAccountType = (typeof OFX_ACCOUNT_TYPES)[number];
const isOfxAccountType = (value: string): value is OfxAccountType => (OFX_ACCOUNT_TYPES as readonly string[]).includes(value);
/** The transaction types OFX defines (TRNTYPE); only these are kept, as a hint. */
const OFX_TRANSACTION_TYPES: ReadonlySet<string> = new Set(CHECKING_BANK_TYPES);

/** A single-valued element written twice: refused, never resolved by taking one of them. */
function once(node: OfxNode | null, names: readonly string[], where: string): void {
  if (!node) return;
  for (const name of names) {
    if (childrenNamed(node, name).length > 1) throw new CheckingExportFormatError(`${where} repeats ${name}; refusing to guess which one counts`);
  }
}

function bankStatements(root: OfxNode): { statements: BankStatement[]; cardStatements: number } {
  const statements = descendants(root, 'STMTRS').map((node): BankStatement => {
    // An account block's identity must be unambiguous in every block, or no block can be told apart from the others.
    once(node, ['BANKACCTFROM'], 'an account block');
    const from = childNamed(node, 'BANKACCTFROM');
    once(from, ['ACCTID'], 'an account block');
    const accountId = valueOf(from, 'ACCTID');
    const accountType = (valueOf(from, 'ACCTTYPE') ?? '').toUpperCase();
    return { node, accountId, last4: accountId ? cardLast4(accountId) : null, accountType: isOfxAccountType(accountType) ? accountType : null };
  });
  return { statements, cardStatements: descendants(root, 'CCSTMTRS').length };
}

/**
 * The one bank statement the file is read for. A file with several account blocks is read only when --account picks
 * exactly one by its last four; the others are never read (no row, date or balance of theirs is used) and appear in
 * the output only as a count. No block, or more than one, matching refuses the whole file, as does any element the
 * picked block repeats.
 */
function chooseStatement(root: OfxNode, options: CheckingAdapterOptions): { statement: BankStatement; others: number } {
  const wanted = options.accountLast4;
  // Never echoed: a value that is not four digits could be anything, a full account or card number included.
  if (wanted !== undefined && !/^[0-9]{4}$/.test(wanted)) throw new CheckingExportFormatError('--account must be the last four digits of the account number');
  const { statements, cardStatements } = bankStatements(root);
  if (statements.length === 0) {
    for (const wrapper of descendants(root, 'STMTTRNRS')) {
      if (statusError(wrapper)) throw new CheckingExportFormatError('the bank reported an error instead of a statement');
    }
    throw new CheckingExportFormatError(cardStatements > 0
      ? 'this OFX file holds a credit card statement, not a bank statement; use the card import tool'
      : 'this OFX file holds no bank statement');
  }
  if (statements.length > 1 && wanted === undefined) {
    throw new CheckingExportFormatError(`this file holds ${statements.length} bank statements; choose one with --account LAST4`);
  }
  const candidates = wanted === undefined ? statements : statements.filter((statement) => statement.last4 === wanted);
  if (candidates.length === 0) throw new CheckingExportFormatError('no statement in this file is for the account --account names');
  if (candidates.length > 1) throw new CheckingExportFormatError(`${candidates.length} statements in this file are for the account --account names; download one account per file`);
  const [statement] = candidates;
  if (statusError(statement.node.parent)) throw new CheckingExportFormatError('the bank reported an error instead of a statement');
  once(childNamed(statement.node, 'BANKACCTFROM'), ['BANKID', 'ACCTTYPE'], 'BANKACCTFROM');
  if (statement.accountType === null) {
    throw new CheckingExportFormatError(`BANKACCTFROM states no ACCTTYPE that OFX defines (${OFX_ACCOUNT_TYPES.join(', ')}); refusing to guess which kind of account this is`);
  }
  const others = statements.length - 1 + cardStatements + descendants(root, 'INVSTMTRS').length;
  return { statement, others };
}

/**
 * A balance the file states, read whole or the file is refused (Root rule 3): its amount and its date and time. A
 * ledger balance checks the rows; an available balance is only recorded (it counts holds), but neither is ever
 * quietly dropped.
 */
function balanceOf(node: OfxNode | null, exponent: number, name: 'LEDGERBAL' | 'AVAILBAL'): ParsedCheckingBalance | null {
  if (!node) return null;
  once(node, ['BALAMT', 'DTASOF'], name);
  const raw = valueOf(node, 'BALAMT');
  const parsed = raw === null ? null : parseAmount(raw, exponent, { decimalComma: true });
  const asOf = valueOf(node, 'DTASOF') === null ? null : ofxMetadata(valueOf(node, 'DTASOF'), `${name} DTASOF`)?.date ?? null;
  if (parsed && parsed.ok && asOf) return { amountMinor: parsed.minor, asOf };
  throw new CheckingExportFormatError(`${name} is there but its BALAMT or DTASOF cannot be read; refusing rather than skip it`);
}

/**
 * Root rule 1: every transaction (STMTTRN) and transaction list (BANKTRANLIST) in the file belongs to exactly one
 * legitimate bank statement block (a STMTRS in its own STMTTRNRS in BANKMSGSRSV1), and every such block holds exactly
 * one list. An orphan list or row anywhere, a block with no list or with two, a statement out of its place, a card
 * statement's or a pending list refuses the whole file, whether its block is read or not: no transaction is ever left
 * out because of where it was written.
 */
function checkOwnership(root: OfxNode): void {
  const legitimate = (node: OfxNode | null): boolean => node?.name === 'STMTRS' && node.parent?.name === 'STMTTRNRS'
    && node.parent.parent?.name === 'BANKMSGSRSV1' && node.parent.parent.parent === root;
  for (const statement of descendants(root, 'STMTRS')) {
    if (!legitimate(statement)) {
      throw new CheckingExportFormatError('the file holds a bank statement (STMTRS) outside a STMTTRNRS in BANKMSGSRSV1; refusing to guess what it belongs to');
    }
    if (childrenNamed(statement, 'BANKTRANLIST').length !== 1) {
      throw new CheckingExportFormatError('a bank statement in the file holds no BANKTRANLIST, or more than one; each must hold exactly one');
    }
  }
  if (descendants(root, 'BANKTRANLIST').some((list) => !legitimate(list.parent))) {
    throw new CheckingExportFormatError('the file holds a transaction list outside a bank statement; refusing rather than leave its transactions out');
  }
  if (descendants(root, 'STMTTRN').some((transaction) => transaction.parent?.name !== 'BANKTRANLIST')) {
    throw new CheckingExportFormatError('the file holds transactions outside a transaction list; refusing rather than leave them out');
  }
  if (descendants(root, 'BANKTRANLISTP').length > 0 || descendants(root, 'STMTTRNP').length > 0) {
    throw new CheckingExportFormatError('the file holds pending transactions; download posted transactions only');
  }
}

/**
 * Root rule 1 (02:47Z): the input is exactly one OFX document and nothing else. Every tag the reader could read as an
 * OFX element, however it is spelled (the reader trims a tag, the name after its slash and its first word, and reads
 * any case: `</ OFX>`, `< /OFX>`, `<ofx>`), found in the whole input, must be exactly one `<OFX>` and then one `</OFX>`,
 * written as such. Before them only the OFX header (`KEY:VALUE` lines, or the `<?xml?>` and `<?OFX?>` instructions)
 * and whitespace; after them only whitespace. The reader returns the first document alone, so anything else in the
 * file (a second document, a list or a row before or after it, an early close) would otherwise go unread.
 */
function oneDocument(text: string): void {
  const ofxTags = [...text.matchAll(/<([^<>]*)>/g)].filter((tag) => {
    const inner = tag[1].trim();
    const name = inner.startsWith('/') ? inner.slice(1).trim() : (inner.endsWith('/') ? inner.slice(0, -1) : inner).trim().split(/\s/, 1)[0];
    return name.toUpperCase() === 'OFX';
  });
  if (ofxTags.length !== 2 || ofxTags[0][0] !== '<OFX>' || ofxTags[1][0] !== '</OFX>') {
    throw new CheckingExportFormatError('the file must be exactly one OFX document, written <OFX> ... </OFX>; refusing rather than read only part of it');
  }
  const [start, end] = ofxTags;
  const header = text.slice(0, start.index).replace(/<\?(?:xml|OFX)\b[^<>]*\?>/gi, '');
  if (header.split(/\r?\n/).some((line) => line.trim() !== '' && !/^[A-Za-z][A-Za-z0-9]*:[^<>]*$/.test(line.trim()))) {
    throw new CheckingExportFormatError('the file holds something other than the OFX header before its <OFX> document; refusing rather than leave it unread');
  }
  if (text.slice((end.index ?? 0) + end[0].length).trim() !== '') {
    throw new CheckingExportFormatError('the file holds something after its </OFX>; refusing rather than leave it unread');
  }
}

/**
 * Root 03:37Z/04:08Z: the account numbers the reader itself reads, with its own tokenizer and tree builder (the same
 * functions readOfxTree runs), before anything can refuse the file: every ACCTID up to wherever the reader stops, the
 * input's open elements closed there. `complete` only when the reader lexed all of the input as the one document (its
 * header before it, nothing after): otherwise numbers it never reached may remain, and the converter prints every
 * diagnostic of the run with fixed labels.
 */
function readerIdentity(text: string): { ids: string[]; complete: boolean } {
  const start = /<OFX\s*>/i.exec(text);
  if (!start) return { ids: [], complete: false };
  const tokens: ReturnType<typeof tokenize> = [];
  let complete = true;
  try {
    tokenize(text, start.index, tokens);
  } catch {
    complete = false;
  }
  tokens.push({ kind: 'end', name: 'OFX', line: 0 });
  let root: OfxNode;
  try {
    root = treeFromTokens(text.slice(0, start.index), tokens);
  } catch {
    return { ids: [], complete: false };
  }
  try {
    oneDocument(text);
  } catch {
    complete = false;
  }
  return { ids: [...new Set(descendants(root, 'ACCTID').map((node) => node.text.trim()).filter((id) => id !== ''))], complete };
}

/** Parses a decoded OFX/QFX/QBO file into the rows of one bank statement. */
export function parseBankOfx(text: string, options: CheckingAdapterOptions = {}): ParsedCheckingExport {
  // Identity from the reader itself, read before anything can refuse the file (Root 03:37Z/04:08Z): every account
  // number it names, in any block (each statement's, a transfer's other account, a card's). A refusal before the whole
  // input is read carries those read so far, and is identity-known only when the reader lexed all of it.
  const identity = readerIdentity(text);
  const early = <T>(read: () => T): T => {
    try {
      return read();
    } catch (error) {
      if (error instanceof CheckingExportFormatError) throw new CheckingExportFormatError(error.message, identity.ids, identity.complete);
      throw error;
    }
  };
  const root = early(() => asChecking(() => readOfxTree(text)));
  early(() => oneDocument(text));
  const accountIds = [...new Set([...identity.ids, ...descendants(root, 'ACCTID').map((node) => node.text.trim()).filter((id) => id !== '')])];
  return withAccountNumbers(accountIds, () => asChecking(() => {
    const sessions = descendants(root, 'SONRS');
    if (sessions.length > 1) throw new CheckingExportFormatError('the file repeats SONRS; refusing to guess when it was made');
    once(sessions[0] ?? null, ['DTSERVER'], 'SONRS');
    const { statement, others } = chooseStatement(root, options);
    once(statement.node, ['CURDEF', 'BANKTRANLIST', 'LEDGERBAL', 'AVAILBAL'], 'the statement');
    const currency = (valueOf(statement.node, 'CURDEF') ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new CheckingExportFormatError('the statement has no valid CURDEF currency');
    const exponent = currencyExponent(currency);
    const tranList = childNamed(statement.node, 'BANKTRANLIST');
    // The list and its dates say which days the file speaks for: without them a file would certify days it never listed.
    if (!tranList) throw new CheckingExportFormatError('the statement has no BANKTRANLIST, so it lists no days');
    checkOwnership(root);
    once(tranList, ['DTSTART', 'DTEND'], 'BANKTRANLIST');
    const listStart = ofxMetadata(valueOf(tranList, 'DTSTART'), 'DTSTART (where the transaction list starts)')?.date ?? null;
    const listEnd = ofxMetadata(valueOf(tranList, 'DTEND'), 'DTEND (where the transaction list ends)')?.date ?? null;
    if (!listStart || !listEnd) throw new CheckingExportFormatError('BANKTRANLIST does not state both DTSTART and DTEND, so the file does not say which days it lists');
    if (listStart > listEnd) throw new CheckingExportFormatError('BANKTRANLIST starts after it ends');
    const coverage = { start: listStart, end: listEnd };
    const madeAt = ofxMetadata(valueOf(sessions[0] ?? null, 'DTSERVER'), 'DTSERVER (when the file was made)')?.date ?? null;
    const notes: string[] = others > 0 ? [`${others} other statement${others === 1 ? '' : 's'} in the file ${others === 1 ? 'was' : 'were'} not read`] : [];

    const rows: ParsedCheckingRow[] = [];
    const problems: ParsedCheckingExport['problems'] = [];
    const typed: Array<{ type: string; amount: number }> = [];
    for (const trn of childrenNamed(tranList, 'STMTTRN')) {
      const line = trn.line;
      const repeated = SINGLE_FIELDS.find((field) => childrenNamed(trn, field).length > 1);
      if (repeated) {
        problems.push({ line, reason: `transaction repeats ${repeated}` });
        continue;
      }
      if (childNamed(trn, 'CORRECTFITID') || childNamed(trn, 'CORRECTACTION')) {
        problems.push({ line, reason: 'transaction corrects an earlier one (CORRECTACTION), which is not supported' });
        continue;
      }
      const type = (valueOf(trn, 'TRNTYPE') ?? '').toUpperCase();
      if (!/^[A-Z][A-Z0-9_.-]{1,19}$/.test(type)) {
        problems.push({ line, reason: 'TRNTYPE is missing or invalid' });
        continue;
      }
      // A posting date and time is read whole: one whose time or offset cannot be read is not taken for its date alone.
      const posted = ofxDateTime(valueOf(trn, 'DTPOSTED'));
      if (!posted || !posted.exact) {
        problems.push({ line, reason: 'DTPOSTED is missing or not a valid date and time' });
        continue;
      }
      const userRaw = valueOf(trn, 'DTUSER');
      const user = ofxDateTime(userRaw);
      if (userRaw !== null && (!user || !user.exact)) {
        problems.push({ line, reason: 'DTUSER is not a valid date and time' });
        continue;
      }
      const userDate = user?.moment.date ?? null;
      const amountRaw = valueOf(trn, 'TRNAMT');
      const amount = amountRaw === null ? null : parseAmount(amountRaw, exponent, { decimalComma: true });
      if (!amount || !amount.ok) {
        problems.push({ line, reason: amount ? `TRNAMT ${amount.reason}` : 'TRNAMT is missing' });
        continue;
      }
      const trnCurrency = (valueOf(childNamed(trn, 'CURRENCY'), 'CURSYM') ?? currency).toUpperCase();
      if (trnCurrency !== currency) {
        problems.push({ line, reason: 'transaction amount is in a different currency than the statement' });
        continue;
      }
      const checkRaw = valueOf(trn, 'CHECKNUM');
      if (checkRaw !== null && !/^[0-9]{1,10}$/.test(checkRaw)) {
        problems.push({ line, reason: 'CHECKNUM is not 1 to 10 digits' });
        continue;
      }
      const checkNumber = checkRaw;
      const name = valueOf(trn, 'NAME') ?? valueOf(childNamed(trn, 'PAYEE'), 'NAME');
      const memo = valueOf(trn, 'MEMO');
      typed.push({ type, amount: amount.minor });
      rows.push({
        line,
        postedDate: posted.moment.date,
        transactionDate: userDate,
        amountMinor: amount.minor,
        description: describe(name, memo),
        checkNumber,
        typeHint: type,
        externalId: valueOf(trn, 'FITID'),
        runningBalanceMinor: null,
        pending: false,
        sourceTexts: [name, memo, name && memo ? `${name} ${memo}` : null, name && memo ? `${memo} ${name}` : null, checkRaw],
      });
      // The type is kept only when OFX defines it, so no other text of the file is ever stored as one.
      if (!OFX_TRANSACTION_TYPES.has(type)) rows[rows.length - 1].typeHint = null;
    }

    // A bank's DEBIT is money out (negative). Most DEBIT/CREDIT rows signed the other way means a convention this
    // adapter does not know; never guess.
    const signed = typed.filter((entry) => (entry.type === 'DEBIT' || entry.type === 'CREDIT') && entry.amount !== 0);
    const inverted = signed.filter((entry) => (entry.type === 'DEBIT') === (entry.amount > 0)).length;
    if (signed.length > 0 && inverted * 2 > signed.length) {
      throw new CheckingExportFormatError(`${inverted} of ${signed.length} DEBIT/CREDIT amounts have the opposite of the usual bank sign; this file is not supported`);
    }

    // Oldest first: some banks list newest first. Within a day the file's order is kept (reversed with the list).
    const descending = rows.length > 1 && rows[0].postedDate > rows[rows.length - 1].postedDate;
    const ordered = (descending ? [...rows].reverse() : rows)
      .map((row, index) => ({ row, index }))
      .sort((a, b) => (a.row.postedDate < b.row.postedDate ? -1 : a.row.postedDate > b.row.postedDate ? 1 : a.index - b.index))
      .map(({ row }) => row);
    return {
      institution: null,
      source: 'ofx',
      currency,
      accountLast4: statement.last4,
      accountType: statement.accountType,
      accountNumberRaw: statement.accountId,
      otherAccountNumbersRaw: accountIds.filter((id) => id !== statement.accountId),
      madeAt,
      coverage,
      statement: null,
      ledgerBalance: balanceOf(childNamed(statement.node, 'LEDGERBAL'), exponent, 'LEDGERBAL'),
      availableBalance: balanceOf(childNamed(statement.node, 'AVAILBAL'), exponent, 'AVAILBAL'),
      rows: ordered,
      problems,
      droppedColumns: [],
      notes,
    };
  }));
}

export const bankOfxAdapter: CheckingExportAdapter = Object.freeze({
  source: 'ofx',
  institution: null,
  input: 'text',
  description: 'OFX, QFX (Quicken) or QBO (QuickBooks) bank statement, from any bank',
  detect: (input: CheckingExportInput) => input.kind === 'text' && /<OFX\s*>/i.test(input.text.slice(0, 64 * 1024)),
  parse: (input: CheckingExportInput, options: CheckingAdapterOptions) => {
    if (input.kind !== 'text') throw new CheckingExportFormatError('an OFX file is text, not a PDF');
    return parseBankOfx(input.text, options);
  },
});
