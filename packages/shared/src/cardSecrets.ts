import { normalizeCardText } from './cardText.js';

// Patterns run on the scan form below: lower case, one space between words,
// so each label needs only one spelling. Every quantifier is bounded except
// SEPARATOR, and a separator run can only be scanned by the label directly in
// front of it, so matching stays linear. Separators cover prose and
// assignments (`:` `=` `-` `#` `.`), record delimiters (`,` `;` `|`, and tabs
// and newlines, which the scan form turns into spaces) and the brackets that
// wrap labels or values, opening and closing.
const SEPARATOR = String.raw`[ :=#.\-|,;<>()\[\]{}\u2013\u2014]*`;
const FILLER = String.raw`(?:(?:is|no|num|number|code|value|date)\b${SEPARATOR})?`;
// A short bracketed note right after a label, such as a format hint:
// expiry (MM/YY), exp [mm/yy], security code (CVV2), CVV (3 digits).
const HINT = String.raw`(?: ?[(\[{<][^()\[\]{}<>]{0,24}[)\]}>])?`;
const acronym = (letters: string) => letters.split('').join('[. ]?');

const SECURITY_CODE_LABEL = [
  `${acronym('cvv')}2?`,
  `${acronym('cvc')}2?`,
  `${acronym('cvn')}2?`,
  'cav2',
  acronym('cid'),
  acronym('csc'),
  '(?:card ?)?security ?code',
  'card ?verification ?(?:code|value|number)',
].join('|');
const PIN_LABEL = 'pin(?: ?(?:code|number|no))?';
const EXPIRY_PREFIX = String.raw`exp(?:iry|iration)?\.?`;
const EXPIRY_LABEL = [
  String.raw`exp(?:iry|iration|ires|ire|iring|ired)?\.?(?: ?date)?`,
  'valid ?(?:thru|through|until|till)',
  'good ?(?:thru|through)',
  'mm ?/ ?yy(?:yy)?',
  'mmyy(?:yy)?',
].join('|');

const MONTH = '(?:0?[1-9]|1[0-2])';
const YEAR = '(?:[0-9]{4}|[0-9]{2})';
const MONTH_NAME = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,6}\.?`;
const EXPIRY_VALUE = [
  String.raw`${MONTH} ?[/\-.] ?${YEAR}`,
  String.raw`(?:19|20)[0-9]{2} ?[/\-.] ?${MONTH}`,
  '(?:0[1-9]|1[0-2])[0-9]{2}',
  String.raw`${MONTH_NAME} ?[/\-,.]? ?${YEAR}`,
].join('|');

const MONTH_UNIT = String.raw`(?:month|mon|mm|[(\[{<] ?(?:month|mm) ?[)\]}>])`;
const YEAR_UNIT = String.raw`(?:year|yr|yyyy|yy|[(\[{<] ?(?:year|yyyy|yy) ?[)\]}>])`;

const CARD_SECRET = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:` +
    String.raw`(?:${SECURITY_CODE_LABEL})${HINT}${SEPARATOR}${FILLER}[0-9](?:[ \-]?[0-9]){2,3}(?![ \-]?[0-9])` +
    String.raw`|(?:${PIN_LABEL})${HINT}${SEPARATOR}${FILLER}[0-9](?:[ \-]?[0-9]){3,11}(?![ \-]?[0-9])` +
    String.raw`|${EXPIRY_PREFIX} ?${MONTH_UNIT}${HINT}${SEPARATOR}${FILLER}${MONTH}(?![0-9/])` +
    String.raw`|${EXPIRY_PREFIX} ?${YEAR_UNIT}${HINT}${SEPARATOR}${FILLER}${YEAR}(?![0-9])` +
    String.raw`|(?:${EXPIRY_LABEL})${HINT}${SEPARATOR}${FILLER}(?:${EXPIRY_VALUE})(?![0-9/]|[\-.][0-9])` +
  ')',
  'u',
);

/**
 * Text reduced so that every spelling of a label reads the same: camelCase,
 * snake_case and kebab-case keys split into words (securityCode,
 * security_code, security-code), quotes and backslashes (JSON, escaped JSON,
 * quoted values) and any whitespace run become one space, all lower case.
 * A hyphen between letters only, so value dates like 12-29 keep theirs.
 */
function scanForm(text: string): string {
  return normalizeCardText(text)
    .replace(/(?<=[\p{Ll}\p{Nd}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu, ' ')
    .replace(/["'`\\_\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f\u00ab\u00bb]|(?<=\p{L})-(?=\p{L})/gu, ' ')
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

/**
 * True when the text labels a card secret and gives its value: a security
 * code (CVV, CVC, CVV2, CVN, CAV2, CID, CSC, security code, card verification
 * value) with 3–4 digits, a PIN with 4–12 digits, an expiry (exp, expiry,
 * expiration, expires, exp date, valid thru, good thru, MM/YY) with a month
 * and year such as 12/29, 12-2029, 2029-12, 1229 or Dec 2029, or an expiry
 * month or year on its own (expMonth 12, exp_year 2029).
 *
 * Labels may be written in any case, as camelCase, snake_case or kebab-case
 * keys, as dotted or spaced acronyms, wrapped in brackets ((CVV), [CVV]), or
 * followed by a bracketed format hint (Expiry (MM/YY), security code (CVV2)).
 * Label and value may be joined by any run of whitespace, quotes, record
 * delimiters (`,` `;` `|`, tab, newline), brackets, `:` `=` `#` `-` `.` `>`,
 * or words like "is", "no." and "number". That covers prose ("CVV is NNN"),
 * assignments (cvv = 'NNN'), records (cvv, NNN) and JSON ({"cvv":"NNN"}),
 * where NNN stands for the digits.
 * Invisible characters and NFKC variants are normalized away first.
 *
 * A label must start a word and be followed by its value. So merchant names
 * that merely begin with the same letters (EXPEDIA, CVS PHARMACY, PINTEREST,
 * EXP REALTY), labels followed by other words (PIN, INC 1234) and full dates
 * (expires 12/29/2026) do not match.
 * This is separate from card number detection (`containsCardData`).
 */
export function containsCardSecret(text: string): boolean {
  return CARD_SECRET.test(scanForm(text));
}
