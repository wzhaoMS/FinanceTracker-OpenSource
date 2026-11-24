/**
 * One Fifth Third account's identity, from every place a file prints its number: masked (`XXXXXX4321`) or whole
 * (`9990004321`).
 *
 * - Each printing is read whole (`FIFTH_THIRD_ACCOUNT_TOKEN`) and must show its last four digits, or the file is
 *   refused; a number is never cut back to a prefix that looks like one.
 * - Two printings name the same account only when they agree digit for digit wherever both show one, aligned on their
 *   last digit, and two whole numbers must be the same number. Different accounts that merely share their last four
 *   are never merged: the file is refused.
 * - The identity kept is what the printings prove together: position by position from the last digit, the digit any
 *   of them shows (999X004321 and XXX0004321 make 9990004321), whatever order they come in. The adapters pass every
 *   printing on as well, so the converter masks any five consecutive digits that any printing shows.
 */
import { cardLast4 } from '../cardNumbers.js';

/** An account number as printed: digits, masking characters and hyphens, ending in a digit, nothing else. */
export const FIFTH_THIRD_ACCOUNT_TOKEN = /^[0-9Xx*•][0-9Xx*•-]{2,38}[0-9]$/;

export type FifthThirdAccountIdentity =
  | { kind: 'none' }
  | { kind: 'one'; last4: string; raw: string }
  | { kind: 'several'; count: number; unions: string[] };

/** Why a printed account number cannot be read, or null when it can. */
export function fifthThirdAccountTokenProblem(token: string): 'not-whole' | 'no-last-four' | null {
  if (!FIFTH_THIRD_ACCOUNT_TOKEN.test(token)) return 'not-whole';
  return cardLast4(token) === null ? 'no-last-four' : null;
}

/** The digits a printing shows, from its last digit backwards; null where it masks one. */
function shown(token: string): Array<string | null> {
  return [...token.replace(/-/g, '')].reverse().map((char) => (/[0-9]/.test(char) ? char : null));
}

const digitCount = (digits: ReadonlyArray<string | null>) => digits.filter((digit) => digit !== null).length;
const isWhole = (digits: ReadonlyArray<string | null>) => digits.every((digit) => digit !== null);

function sameAccount(a: ReadonlyArray<string | null>, b: ReadonlyArray<string | null>): boolean {
  if (isWhole(a) && isWhole(b) && a.length !== b.length) return false;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== null && b[index] !== null && a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * The one account the printings name, as the union of what they show; or how many different accounts they name.
 * Every printing must already have passed `fifthThirdAccountTokenProblem`.
 */
export function fifthThirdAccountIdentity(tokens: Iterable<string>): FifthThirdAccountIdentity {
  const printings = [...new Set([...tokens].map((token) => token.trim()))]
    .map((token) => ({ token, digits: shown(token) }))
    // Richest first: the most digits shown, then the plainest printing of them.
    .sort((a, b) => digitCount(b.digits) - digitCount(a.digits) || b.digits.length - a.digits.length || a.token.length - b.token.length
      || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  if (printings.length === 0) return { kind: 'none' };
  const accounts: Array<typeof printings> = [];
  for (const printing of printings) {
    const account = accounts.find((members) => members.every((member) => sameAccount(member.digits, printing.digits)));
    if (account) account.push(printing);
    else accounts.push([printing]);
  }
  if (accounts.length > 1) return { kind: 'several', count: accounts.length, unions: accounts.map(union) };
  const raw = union(accounts[0]);
  return { kind: 'one', last4: cardLast4(raw)!, raw };
}

/** What agreeing printings prove together, position by position from the last digit: X where none of them shows it. */
function union(members: ReadonlyArray<{ digits: ReadonlyArray<string | null> }>): string {
  const width = Math.max(...members.map((member) => member.digits.length));
  const digits: string[] = [];
  for (let index = 0; index < width; index += 1) {
    digits.push(members.map((member) => member.digits[index]).find((digit): digit is string => typeof digit === 'string') ?? 'X');
  }
  return digits.reverse().join('');
}

/**
 * Every account number a file's printings make known, for the converter's guard: what each group of agreeing printings
 * proves together, then every printing as printed. Carried on every refusal as on every result, so no digits the
 * printings prove, alone or only together, can reach a message.
 */
export function fifthThirdKnownAccountNumbers(identity: FifthThirdAccountIdentity, printings: Iterable<string>): string[] {
  const unions = identity.kind === 'one' ? [identity.raw] : identity.kind === 'several' ? identity.unions : [];
  return [...new Set([...unions, ...printings])];
}
