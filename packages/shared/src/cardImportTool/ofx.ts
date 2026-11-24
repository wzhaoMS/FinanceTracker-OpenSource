/**
 * OFX 1.x (SGML, leaf tags left open), OFX 2.x (XML), QFX and QBO credit
 * card statements, read with a small tolerant tokenizer instead of an XML
 * parser: DTDs and entity declarations are refused outright, and only the
 * five predefined entities and numeric character references are decoded, so
 * there is no external entity, entity expansion or network access to abuse.
 *
 * Allowlist per transaction: TRNTYPE (classification only), DTPOSTED, DTUSER,
 * TRNAMT, FITID (hashed), NAME (or PAYEE/NAME), MEMO and SIC. ACCTID, which
 * may be a full card number, is reduced to its last four digits and never
 * leaves this module otherwise. Credit-card TRNAMT is negative for charges;
 * Holdr's sign is the opposite, and `--ofx-sign inverted` handles issuers
 * that write charges as positive amounts.
 *
 * Only BANKTRANLIST's STMTTRN entries are read, which OFX defines as posted
 * transactions (DTPOSTED is required); the separate pending list
 * (BANKTRANLISTP) is never read. Statement-level values used: CURDEF,
 * ACCTID's last four, LEDGERBAL, STATUS codes (to report an error), the
 * list's DTSTART and DTEND, and when the file was made (SONRS DTSERVER).
 * DTEND, DTSERVER and the posted dates show whether the list reaches into a
 * statement period that had not closed when the file was made. Dates are
 * stored as written; their times and offsets are read only to compare them
 * in one time zone (statementDates.ts). A DTEND or DTSERVER that is there
 * but cannot be read whole refuses the file rather than skip that check.
 */
import { cardLast4, containsCardNumber, isCardSecretField, redactCardNumbers } from '../cardNumbers.js';
import { containsCardSecret } from '../cardSecrets.js';
import { CARD_IMPORT_MAX_RAW_TEXT, isCardImportDate, sanitizeCardText } from '../cardImport.js';
import { normalizeCardText } from '../cardText.js';
import { currencyExponent, parseAmount } from './amount.js';
import { ExportFormatError, type ParsedExport, type ParsedRow, type RowProblem, type StatementMoment } from './parsed.js';
import { cardNumberCandidates, showsCardDigits } from './leaks.js';

export type OfxSign = 'standard' | 'inverted';

export interface OfxOptions {
  /** Null when the user did not choose; a file that looks inverted is then refused. */
  sign: OfxSign | null;
  /** Last-4 values selecting the statement when a file holds several cards. */
  cards: readonly string[];
}

interface OfxNode {
  name: string;
  text: string;
  children: OfxNode[];
  parent: OfxNode | null;
  line: number;
}

type Token =
  | { kind: 'start'; name: string; selfClosing: boolean; line: number }
  | { kind: 'end'; name: string; line: number }
  | { kind: 'text'; text: string; line: number };

const LIMITS = { tokens: 2_000_000, depth: 64, textLength: 20_000 };
const NAME = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
// Elements that contain other elements; in SGML files every other element is a leaf whose
// value ends at the next tag.
const AGGREGATES = new Set([
  'OFX', 'SIGNONMSGSRSV1', 'SONRS', 'STATUS', 'FI', 'SIGNUPMSGSRSV1', 'ACCTINFOTRNRS', 'ACCTINFORS', 'ACCTINFO',
  'CREDITCARDMSGSRSV1', 'CCSTMTTRNRS', 'CCSTMTRS', 'CCACCTFROM', 'CCACCTTO', 'CCACCTINFO', 'CCSTMTENDTRNRS', 'CCSTMTENDRS',
  'CCCLOSING', 'BANKMSGSRSV1', 'STMTTRNRS', 'STMTRS', 'BANKACCTFROM', 'BANKACCTTO', 'BANKACCTINFO', 'STMTENDTRNRS',
  'STMTENDRS', 'CLOSING', 'BANKTRANLIST', 'STMTTRN', 'PAYEE', 'CURRENCY', 'ORIGCURRENCY', 'LEDGERBAL', 'AVAILBAL',
  'BALLIST', 'BAL', 'REWARDINFO', 'INVSTMTMSGSRSV1', 'INVSTMTTRNRS', 'INVSTMTRS', 'INVACCTFROM', 'INVTRANLIST',
  'INVPOSLIST', 'INVBAL', 'INV401KBAL', 'IMAGEDATA', 'MSGSETLIST', 'SIGNONINFOLIST',
]);
const SINGLE_FIELDS = ['TRNTYPE', 'DTPOSTED', 'DTUSER', 'TRNAMT', 'FITID', 'NAME', 'MEMO', 'SIC', 'PAYEE', 'CURRENCY', 'ORIGCURRENCY'];
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, ref: string) => {
    if (ref[0] !== '#') return NAMED_ENTITIES[ref] ?? whole;
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    const allowed = code === 0x9 || code === 0xa || code === 0xd
      || (code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff));
    return allowed ? String.fromCodePoint(code) : whole;
  });
}

/** The tokens of `text` from `from`, pushed onto `tokens` as they are read (so a caller keeps those read before a refusal). */
function tokenize(text: string, from: number, tokens: Token[] = []): Token[] {
  let line = 1;
  for (let k = 0; k < from; k += 1) if (text.charCodeAt(k) === 10) line += 1;
  const advance = (to: number, at: number) => {
    for (let k = at; k < to; k += 1) if (text.charCodeAt(k) === 10) line += 1;
  };
  let i = from;
  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > LIMITS.tokens) throw new ExportFormatError('the OFX file has too many elements');
  };
  while (i < text.length) {
    if (text[i] !== '<') {
      let next = text.indexOf('<', i);
      if (next === -1) next = text.length;
      if (next - i > LIMITS.textLength) throw new ExportFormatError(`line ${line}: an OFX value is longer than ${LIMITS.textLength} characters`);
      push({ kind: 'text', text: decodeEntities(text.slice(i, next)), line });
      advance(next, i);
      i = next;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) throw new ExportFormatError(`line ${line}: a comment is not closed (the file may be truncated)`);
      advance(end + 3, i);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end === -1) throw new ExportFormatError(`line ${line}: a CDATA section is not closed (the file may be truncated)`);
      if (end - i - 9 > LIMITS.textLength) throw new ExportFormatError(`line ${line}: an OFX value is longer than ${LIMITS.textLength} characters`);
      push({ kind: 'text', text: text.slice(i + 9, end), line });
      advance(end + 3, i);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end === -1) throw new ExportFormatError(`line ${line}: a processing instruction is not closed`);
      advance(end + 2, i);
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', i)) throw new ExportFormatError(`line ${line}: OFX files must not contain markup declarations`);
    const close = text.indexOf('>', i + 1);
    const nextOpen = text.indexOf('<', i + 1);
    if (close === -1) throw new ExportFormatError(`line ${line}: a tag is not closed (the file may be truncated)`);
    if (nextOpen !== -1 && nextOpen < close) throw new ExportFormatError(`line ${line}: a tag is not closed`);
    const inner = text.slice(i + 1, close).trim();
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      if (!NAME.test(name)) throw new ExportFormatError(`line ${line}: malformed closing tag`);
      push({ kind: 'end', name: name.toUpperCase(), line });
    } else {
      const selfClosing = inner.endsWith('/');
      const name = (selfClosing ? inner.slice(0, -1) : inner).trim().split(/\s/, 1)[0];
      if (!NAME.test(name)) throw new ExportFormatError(`line ${line}: malformed tag`);
      push({ kind: 'start', name: name.toUpperCase(), selfClosing, line });
    }
    advance(close + 1, i);
    i = close + 1;
  }
  return tokens;
}

function buildTree(tokens: Token[], xml: boolean): OfxNode {
  const stack: OfxNode[] = [];
  let root: OfxNode | null = null;
  for (const token of tokens) {
    if (token.kind === 'start') {
      let top = stack[stack.length - 1];
      // SGML leaves have no end tag: a leaf ends where the next tag starts.
      if (!xml && top && !AGGREGATES.has(top.name)) {
        stack.pop();
        top = stack[stack.length - 1];
      }
      const node: OfxNode = { name: token.name, text: '', children: [], parent: top ?? null, line: token.line };
      if (!top) {
        if (root) break;
        if (token.name !== 'OFX') throw new ExportFormatError('the OFX body must start with <OFX>');
        root = node;
      } else {
        top.children.push(node);
      }
      stack.push(node);
      if (stack.length > LIMITS.depth) throw new ExportFormatError(`line ${token.line}: OFX elements are nested too deeply`);
      if (token.selfClosing) stack.pop();
    } else if (token.kind === 'end') {
      let index = stack.length - 1;
      while (index >= 0 && stack[index].name !== token.name) index -= 1;
      // An end tag for a leaf that was already closed implicitly is harmless.
      if (index >= 0) stack.length = index;
      if (stack.length === 0 && root) break;
    } else {
      const top = stack[stack.length - 1];
      if (!top) {
        if (token.text.trim() !== '') throw new ExportFormatError(`line ${token.line}: text outside the <OFX> element`);
        continue;
      }
      if (top.text.length + token.text.length > LIMITS.textLength) {
        throw new ExportFormatError(`line ${token.line}: an OFX value is longer than ${LIMITS.textLength} characters`);
      }
      top.text += token.text;
    }
  }
  if (!root) throw new ExportFormatError('the file has no <OFX> element');
  const open = stack.filter((node) => xml || AGGREGATES.has(node.name));
  if (open.length > 0) throw new ExportFormatError(`<${open[open.length - 1].name}> is not closed (the file may be truncated)`);
  return root;
}

function hasMixedContent(node: OfxNode): boolean {
  if (node.children.length > 0 && node.text.trim() !== '') return true;
  return node.children.some(hasMixedContent);
}

// Characters a card span can end in (digits, masks, separators); X runs only outside words.
const TRAILING_SPAN = /[\p{Nd}\p{Pd}\u2212\s*•●∗⁎#·.\/\\,_|']+$/u;
const TRAILING_X_MASK = /(^|[\s\p{Pd}\u2212.\/\\,_|'])[Xx]+$/u;

function withoutTrailingSpan(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(TRAILING_SPAN, '').replace(TRAILING_X_MASK, '$1');
    if (next === out) return out.trim();
    out = next;
  }
}

/** What NAME or MEMO says for overlap: stored-text normalization, then letters and digits only, in upper case. */
function overlapKey(text: string): string {
  return normalizeCardText(text).replace(/\p{Cf}/gu, '').toUpperCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

/**
 * The description from NAME and MEMO. Issuers often repeat NAME in MEMO,
 * written a little differently (spacing, invisible or full-width characters,
 * case). Joining both would keep two copies of whatever NAME holds, and
 * redaction, which sees each copy whole, can then leave a shortened copy of a
 * card number beside the redacted one. So overlap is decided on what both say
 * once normalized: a MEMO that contains NAME is the description on its own, a
 * NAME that contains MEMO likewise, and only different texts are joined
 * (before redaction, so a card number split across them is caught).
 */
function describe(name: string | null, memo: string | null): string {
  if (!name) return memo ?? '';
  if (!memo) return name;
  const nameKey = overlapKey(name);
  const memoKey = overlapKey(memo);
  if (memoKey.includes(nameKey)) return memo;
  if (nameKey.includes(memoKey)) return name;
  return `${name} ${memo}`;
}

/** Where `needle` occurs in `text`, ignoring case when that changes no length; -1 when it does not. */
function indexIgnoringCase(text: string, needle: string): number {
  const upperText = text.toUpperCase();
  const upperNeedle = needle.toUpperCase();
  if (upperText.length === text.length && upperNeedle.length === needle.length) return upperText.indexOf(upperNeedle);
  return text.indexOf(needle);
}

/**
 * The merchant, taken from the description as Holdr stores it (normalized and
 * redacted as a whole, not cut): NAME as the description shows it, else the
 * most leading words of NAME it shows, without a trailing partial number. A
 * card number running from NAME into MEMO, or repeated in MEMO, is redacted
 * there, so the merchant never shows digits the description hides. NAME
 * itself is used only when it holds no digit at all.
 */
function merchantName(name: string | null, description: string): string | null {
  if (!name || name.length > CARD_IMPORT_MAX_RAW_TEXT || description.length > CARD_IMPORT_MAX_RAW_TEXT) return null;
  const storedName = sanitizeCardText(name, CARD_IMPORT_MAX_RAW_TEXT);
  if (storedName === null) return null;
  const storedDescription = sanitizeCardText(description, CARD_IMPORT_MAX_RAW_TEXT) ?? '';
  const words = storedName.split(' ');
  const shown = (count: number) => indexIgnoringCase(storedDescription, words.slice(0, count).join(' '));
  // When NAME's first words show, so do fewer of them: search for the most.
  let low = 0;
  let high = words.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (shown(middle) >= 0) low = middle;
    else high = middle - 1;
  }
  if (low === 0) return /[0-9]/.test(storedName) ? null : storedName;
  const length = words.slice(0, low).join(' ').length;
  const at = shown(low);
  const merchant = storedDescription.slice(at, at + length);
  if (low === words.length) return merchant;
  const kept = withoutTrailingSpan(merchant);
  return kept === '' ? null : kept;
}

function childrenNamed(node: OfxNode, name: string): OfxNode[] {
  return node.children.filter((child) => child.name === name);
}

function childNamed(node: OfxNode | null | undefined, name: string): OfxNode | null {
  return node ? node.children.find((child) => child.name === name) ?? null : null;
}

function valueOf(node: OfxNode | null | undefined, name: string): string | null {
  const child = childNamed(node, name);
  if (!child) return null;
  const value = child.text.trim();
  return value === '' ? null : value;
}

function descendants(node: OfxNode, name: string, out: OfxNode[] = []): OfxNode[] {
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    descendants(child, name, out);
  }
  return out;
}

const OFX_DATETIME = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:\.\d{1,3})?)?)?)?\s*(?:\[([^\]]{0,40})\])?$/;
// [gmt offset[:tz name]]: hours, optionally with a decimal fraction (`-5`, `+5.5`, `0`); the name is not read.
const OFX_OFFSET = /^\s*([+-]?)(\d{1,2})(?:\.(\d{1,2}))?\s*(?::.*)?$/;

/**
 * An OFX datetime (YYYYMMDD[HH[MM[SS[.XXX]]]][[offset[:TZ]]]) as written by
 * the issuer; null when it is not one or its date does not exist. The date
 * is what Holdr stores, exactly as before. `exact` is false when a time or
 * an offset is written but cannot be read: the moment then leaves it unknown.
 */
function ofxDateTime(raw: string | null): { moment: StatementMoment; exact: boolean } | null {
  if (!raw) return null;
  const match = OFX_DATETIME.exec(raw);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (!isCardImportDate(date)) return null;
  let exact = true;
  let time: number | null = null;
  if (match[4] !== undefined) {
    const [hour, minute, second] = [match[4], match[5] ?? '00', match[6] ?? '00'].map(Number);
    if (hour <= 23 && minute <= 59 && second <= 60) time = hour * 60 + minute;
    else exact = false;
  }
  let offset: number | null = null;
  if (match[7] !== undefined) {
    const zone = OFX_OFFSET.exec(match[7]);
    const fraction = zone?.[3] ?? '';
    const fractionMinutes = fraction === '' ? 0 : (Number(fraction) * 60) / 10 ** fraction.length;
    const minutes = zone ? Number(zone[2]) * 60 + fractionMinutes : NaN;
    if (zone && Number.isInteger(minutes) && minutes % 15 === 0 && minutes <= (zone[1] === '-' ? 12 * 60 : 14 * 60)) {
      offset = (zone[1] === '-' ? -minutes : minutes) + 0;
    } else {
      // A zone is named but cannot be read: keep only the date, so no check takes the time for one without a zone.
      exact = false;
      time = null;
    }
  }
  return { moment: { date, time, offset }, exact };
}

/** The date part of an OFX datetime, as written by the issuer. */
function ofxDate(raw: string | null): string | null {
  return ofxDateTime(raw)?.moment.date ?? null;
}

/**
 * Statement metadata that says when the file was made or where its list
 * ends: absent is null, but a value that is there must be read whole (its
 * date, time and offset), or the file is refused instead of skipping checks.
 */
function ofxMetadata(raw: string | null, label: string): StatementMoment | null {
  if (raw === null) return null;
  const parsed = ofxDateTime(raw);
  if (!parsed || !parsed.exact) throw new ExportFormatError(`${label} is not a valid OFX date and time; refusing to guess`);
  return parsed.moment;
}

interface Statement {
  kind: 'credit card' | 'credit line';
  node: OfxNode;
  last4: string | null;
  /** Raw ACCTID, which may be a full card number: only for the leak check, never written. */
  accountId: string | null;
}

function statusError(wrapper: OfxNode | null): string | null {
  const code = valueOf(childNamed(wrapper, 'STATUS'), 'CODE');
  if (code === null || code === '0') return null;
  return `the issuer reported an error instead of a statement${/^\d{1,6}$/.test(code) ? ` (code ${code})` : ''}`;
}

function findStatements(root: OfxNode): { statements: Statement[]; otherAccounts: number } {
  const statements: Statement[] = [];
  let otherAccounts = 0;
  for (const node of descendants(root, 'CCSTMTRS')) {
    const acctId = valueOf(childNamed(node, 'CCACCTFROM'), 'ACCTID');
    statements.push({ kind: 'credit card', node, last4: acctId ? cardLast4(acctId) : null, accountId: acctId });
  }
  for (const node of descendants(root, 'STMTRS')) {
    const from = childNamed(node, 'BANKACCTFROM');
    if ((valueOf(from, 'ACCTTYPE') ?? '').toUpperCase() === 'CREDITLINE') {
      const acctId = valueOf(from, 'ACCTID');
      statements.push({ kind: 'credit line', node, last4: acctId ? cardLast4(acctId) : null, accountId: acctId });
    } else {
      otherAccounts += 1;
    }
  }
  otherAccounts += descendants(root, 'INVSTMTRS').length;
  if (statements.length === 0) {
    for (const wrapper of descendants(root, 'CCSTMTTRNRS')) {
      const error = statusError(wrapper);
      if (error) throw new ExportFormatError(error);
    }
  }
  return { statements, otherAccounts };
}

function chooseStatement(statements: Statement[], otherAccounts: number, cards: readonly string[]): Statement {
  if (statements.length === 0) {
    throw new ExportFormatError(otherAccounts > 0
      ? 'this OFX file holds bank or investment statements, not a credit card statement'
      : 'this OFX file holds no credit card statement');
  }
  const candidates = cards.length > 0 ? statements.filter((statement) => statement.last4 && cards.includes(statement.last4)) : statements;
  const list = statements.map((statement) => statement.last4 ?? '????').join(', ');
  if (candidates.length === 0) throw new ExportFormatError(`no statement in this file is for --card ${cards.join(', ')} (cards: ${list})`);
  if (candidates.length > 1) {
    throw new ExportFormatError(cards.length > 0
      ? `more than one statement matches --card; download one statement per file (cards: ${list})`
      : `this file holds ${statements.length} card statements; choose one with --card LAST4 (cards: ${list})`);
  }
  const error = statusError(candidates[0].node.parent);
  if (error) throw new ExportFormatError(error);
  return candidates[0];
}

function readOfxTree(text: string): OfxNode {
  if (/<!\s*(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i.test(text)) {
    throw new ExportFormatError('OFX files must not declare a DTD or entities; refusing this file');
  }
  const start = /<OFX\s*>/i.exec(text);
  if (!start) throw new ExportFormatError('this does not look like an OFX, QFX or QBO file (no <OFX> element)');
  return treeFromTokens(text.slice(0, start.index), tokenize(text, start.index));
}

/** The tree of a document's tokens, `head` being the text before its <OFX>: read as XML when the head says so and it reads cleanly as XML, as SGML otherwise. */
function treeFromTokens(head: string, tokens: Token[]): OfxNode {
  let root: OfxNode | null = null;
  if (/<\?xml\b/i.test(head) || /OFXHEADER\s*=\s*"?2/i.test(head)) {
    // OFX 2 closes every element, so unknown aggregates keep their children. A file that only
    // claims to be XML but leaves leaves open puts text and children on one node: read it as SGML.
    try {
      const xmlRoot = buildTree(tokens, true);
      if (!hasMixedContent(xmlRoot)) root = xmlRoot;
    } catch {
      root = null;
    }
  }
  root ??= buildTree(tokens, false);
  return root;
}

/** Parses a decoded OFX/QFX/QBO file into rows of one credit card statement. */
export function parseOfx(text: string, options: OfxOptions): ParsedExport {
  const root = readOfxTree(text);
  const { statements, otherAccounts } = findStatements(root);
  const statement = chooseStatement(statements, otherAccounts, options.cards);
  const currency = (valueOf(statement.node, 'CURDEF') ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ExportFormatError('the statement has no valid CURDEF currency');
  const exponent = currencyExponent(currency);
  const tranList = childNamed(statement.node, 'BANKTRANLIST');
  const listStart = ofxDate(valueOf(tranList, 'DTSTART'));
  const listEndAt = ofxMetadata(valueOf(tranList, 'DTEND'), 'DTEND (where the transaction list ends)');
  const listEnd = listEndAt?.date ?? null;
  const coverage = listStart && listEnd && listStart <= listEnd ? { start: listStart, end: listEnd } : null;
  const madeAt = ofxMetadata(valueOf(descendants(root, 'SONRS')[0], 'DTSERVER'), 'DTSERVER (when the file was made)');

  const rows: ParsedRow[] = [];
  const problems: RowProblem[] = [];
  const raw: Array<{ type: string; amount: number }> = [];
  for (const trn of tranList ? childrenNamed(tranList, 'STMTTRN') : []) {
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
    if (!/^[A-Z.]{2,20}$/.test(type)) {
      problems.push({ line, reason: 'TRNTYPE is missing or invalid' });
      continue;
    }
    const posted = ofxDateTime(valueOf(trn, 'DTPOSTED'));
    if (!posted) {
      problems.push({ line, reason: 'DTPOSTED is missing or not a valid date' });
      continue;
    }
    const postedDate = posted.moment.date;
    const userRaw = valueOf(trn, 'DTUSER');
    const userDate = ofxDate(userRaw);
    if (userRaw !== null && !userDate) {
      problems.push({ line, reason: 'DTUSER is not a valid date' });
      continue;
    }
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
    const name = valueOf(trn, 'NAME') ?? valueOf(childNamed(trn, 'PAYEE'), 'NAME');
    const memo = valueOf(trn, 'MEMO');
    const description = describe(name, memo);
    const sic = valueOf(trn, 'SIC');
    raw.push({ type, amount: amount.minor });
    rows.push({
      line,
      transactionDate: userDate ?? postedDate,
      postedDate,
      // An unreadable time or offset is left unknown here, never guessed; the date is kept as before.
      postedAt: posted.moment,
      amountMinor: amount.minor,
      description,
      merchant: merchantName(name, description),
      issuerCategory: sic && /^\d{4}$/.test(sic) ? `SIC ${sic}` : null,
      externalId: valueOf(trn, 'FITID'),
      last4: statement.last4,
      member: null,
      typeHint: type,
      sourceTexts: [name, memo, name && memo ? `${name} ${memo}` : null, name && memo ? `${memo} ${name}` : null, statement.accountId],
    });
  }

  // Credit card TRNAMT is negative for charges. Debits written as positive (or credits as
  // negative) mean the issuer uses the opposite convention; never guess silently.
  const typed = raw.filter((entry) => (entry.type === 'DEBIT' || entry.type === 'CREDIT') && entry.amount !== 0);
  const inverted = typed.filter((entry) => (entry.type === 'DEBIT') === (entry.amount > 0)).length;
  const notes: string[] = [];
  let sign = options.sign;
  if (sign === null) {
    if (typed.length > 0 && inverted * 2 > typed.length) {
      throw new ExportFormatError(
        `${inverted} of ${typed.length} DEBIT/CREDIT amounts have the opposite of the usual credit card sign; `
        + 'check a purchase in the file and re-run with --ofx-sign inverted (or --ofx-sign standard to keep the usual sign)',
      );
    }
    sign = 'standard';
  } else if (typed.length > 0 && (sign === 'standard' ? inverted : typed.length - inverted) * 2 > typed.length) {
    notes.push(`most DEBIT/CREDIT amounts disagree with --ofx-sign ${sign}`);
  }
  const flip = sign === 'standard' ? -1 : 1;
  for (const row of rows) row.amountMinor = row.amountMinor * flip + 0;

  let ledger: ParsedExport['ledger'] = null;
  const ledgerNode = childNamed(statement.node, 'LEDGERBAL');
  if (ledgerNode) {
    const balance = valueOf(ledgerNode, 'BALAMT');
    const parsed = balance === null ? null : parseAmount(balance, exponent, { decimalComma: true });
    const asOf = ofxDate(valueOf(ledgerNode, 'DTASOF'));
    if (parsed && parsed.ok && asOf) ledger = { amountMinor: parsed.minor * flip + 0, asOf };
    else notes.push('LEDGERBAL is incomplete and was ignored');
  }
  if (statement.kind === 'credit line') notes.push('read a bank statement of type CREDITLINE as a credit card statement');
  return {
    source: 'ofx',
    issuer: null,
    currency,
    coverage,
    madeAt,
    listEndAt,
    ledger,
    rows,
    problems,
    droppedColumns: [],
    hasMemberColumn: false,
    hasCardColumn: statement.last4 !== null,
    notes,
  };
}

/** Page-boundary gate: keep OFX semantics/FITIDs, but never export a full card number. */
export function redactOfxForPage(text: string, expectedLast4: string): string {
  const refuse = (stage = 'unsafe-field'): never => { throw new ExportFormatError(`OFX page privacy check failed: ${stage}`); };
  if (!/^\d{4}$/.test(expectedLast4) || text.length > 20_000_000) refuse('input-bound');
  const root = readOfxTree(text);
  const { statements, otherAccounts } = findStatements(root);
  if (statements.length !== 1 || otherAccounts !== 0 || statements[0].last4 !== expectedLast4) refuse('account-binding');
  const account = statements[0].accountId ?? '';
  const knownNumbers = cardNumberCandidates(account);
  const accountDigits = normalizeCardText(account).replace(/\D/g, '');
  if (accountDigits.length >= 12) knownNumbers.add(accountDigits);
  const visit = (node: OfxNode, callback: (node: OfxNode) => void) => {
    callback(node);
    for (const child of node.children) visit(child, callback);
  };
  visit(root, (node) => {
    if (isCardSecretField(node.name) || /PASS(?:WORD)?|TOKEN|COOKIE|SECRET|OTP|MFA/i.test(node.name)
      || containsCardSecret(`${node.name} ${node.text}`)) refuse('secret-field');
    if (node.name === 'NAME' || node.name === 'MEMO') {
      for (const number of cardNumberCandidates(node.text)) knownNumbers.add(number);
    }
    if (node.name === 'STMTTRN') {
      const name = valueOf(node, 'NAME') ?? valueOf(childNamed(node, 'PAYEE'), 'NAME') ?? '';
      const memo = valueOf(node, 'MEMO') ?? '';
      for (const combined of [`${name} ${memo}`, `${memo} ${name}`]) {
        if (containsCardSecret(combined)) refuse('secret-text');
        for (const number of cardNumberCandidates(combined)) knownNumbers.add(number);
      }
    }
  });
  const children: Record<string, readonly string[]> = {
    OFX: ['SIGNONMSGSRSV1', 'CREDITCARDMSGSRSV1', 'BANKMSGSRSV1'],
    SIGNONMSGSRSV1: ['SONRS'], SONRS: ['STATUS', 'DTSERVER', 'LANGUAGE'],
    STATUS: ['CODE', 'SEVERITY'],
    CREDITCARDMSGSRSV1: ['CCSTMTTRNRS'], CCSTMTTRNRS: ['STATUS', 'CCSTMTRS'],
    CCSTMTRS: ['CURDEF', 'CCACCTFROM', 'BANKTRANLIST', 'LEDGERBAL', 'AVAILBAL'],
    CCACCTFROM: ['ACCTID'], BANKTRANLIST: ['DTSTART', 'DTEND', 'STMTTRN'],
    BANKMSGSRSV1: ['STMTTRNRS'], STMTTRNRS: ['STATUS', 'STMTRS'],
    STMTRS: ['CURDEF', 'BANKACCTFROM', 'BANKTRANLIST', 'LEDGERBAL', 'AVAILBAL'],
    BANKACCTFROM: ['ACCTID', 'ACCTTYPE'],
    STMTTRN: ['TRNTYPE', 'DTPOSTED', 'DTUSER', 'TRNAMT', 'FITID', 'NAME', 'MEMO', 'SIC', 'PAYEE', 'CURRENCY', 'ORIGCURRENCY'],
    PAYEE: ['NAME'], CURRENCY: ['CURRATE', 'CURSYM'], ORIGCURRENCY: ['CURRATE', 'CURSYM'],
    LEDGERBAL: ['BALAMT', 'DTASOF'], AVAILBAL: ['BALAMT', 'DTASOF'],
  };
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const serialize = (node: OfxNode): string => {
    const allowed = children[node.name];
    if (allowed) {
      if (node.text.trim()) refuse('aggregate-text');
      if (node.name === 'STMTTRN') {
        const name = valueOf(node, 'NAME') ?? valueOf(childNamed(node, 'PAYEE'), 'NAME');
        const memo = valueOf(node, 'MEMO');
        if (showsCardDigits(
          [name ? redactCardNumbers(name) : null, memo ? redactCardNumbers(memo) : null],
          [name, memo, `${name ?? ''} ${memo ?? ''}`, `${memo ?? ''} ${name ?? ''}`, account],
        )) refuse('split-card-text');
      }
      return `<${node.name}>${node.children.filter((child) => allowed.includes(child.name)).map(serialize).join('')}</${node.name}>`;
    }
    if (node.children.length) refuse('leaf-children');
    let value = node.text.trim();
    if (node.name === 'ACCTID') value = expectedLast4;
    else {
      if (node.name === 'NAME' || node.name === 'MEMO') value = redactCardNumbers(value);
      const digits = normalizeCardText(value).replace(/\D/g, '');
      if (containsCardNumber(value) || [...knownNumbers].some((number) => digits.includes(number))) refuse(node.name === 'FITID' ? 'unsafe-fitid' : 'card-digits');
    }
    return `<${node.name}>${escape(value)}</${node.name}>`;
  };
  const output = '<?xml version="1.0" encoding="UTF-8"?>\n' + serialize(root);
  const before = parseOfx(text, { sign: null, cards: [] });
  const after = parseOfx(output, { sign: null, cards: [] });
  const semantics = (parsed: ParsedExport) => ({
    currency: parsed.currency, coverage: parsed.coverage, madeAt: parsed.madeAt,
    listEndAt: parsed.listEndAt, ledger: parsed.ledger,
    rows: parsed.rows.map(({ transactionDate, postedDate, postedAt, amountMinor, externalId, typeHint }) =>
      ({ transactionDate, postedDate, postedAt, amountMinor, externalId, typeHint })),
  });
  if (before.problems.length || after.problems.length
    || JSON.stringify(semantics(before)) !== JSON.stringify(semantics(after))) refuse('changed-semantics');
  return output;
}

/**
 * This reader's building blocks for the checking import tool's bank statements (checkingImportTool/bankOfx.ts), so a
 * bank file is tokenized with the same limits and refused for the same reasons as a card file. Read-only helpers;
 * nothing here changes how card files are read.
 */
export type { OfxNode };
export const ofxReader = Object.freeze({
  readOfxTree, descendants, childNamed, childrenNamed, valueOf, ofxDateTime, ofxDate, ofxMetadata, describe, statusError,
  tokenize, treeFromTokens,
  singleFields: SINGLE_FIELDS as readonly string[],
});
