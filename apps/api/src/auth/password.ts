import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with node:crypto scrypt (no native dependencies).
 *
 * Stored format (PHC-style and self-describing, so the parameters can be raised
 * later without invalidating existing hashes):
 *
 *   $scrypt$ln=15,r=8,p=3$<salt, base64 without padding>$<key, base64 without padding>
 *
 * ln=15,r=8,p=3 is one of OWASP's equivalent scrypt profiles: about 32 MiB of
 * memory and a few hundred milliseconds per hash.
 */

export interface ScryptParams {
  /** log2 of the CPU/memory cost N. */
  ln: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({ ln: 15, r: 8, p: 3 });

const SALT_BYTES = 16;
const KEY_BYTES = 32;
export const MIN_PASSWORD_LENGTH = 8;
/** Bounds scrypt's input and keeps login bodies small. */
export const MAX_PASSWORD_LENGTH = 1024;

// Refuse stored parameters outside sane bounds instead of letting a corrupt
// row allocate gigabytes or spin for minutes.
const LIMITS = { ln: [10, 20], r: [1, 32], p: [1, 16] } as const;

const PHC_PATTERN = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,})\$([A-Za-z0-9+/]{16,})$/;

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function inRange(value: number, [min, max]: readonly [number, number]): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validParams(params: ScryptParams): boolean {
  return inRange(params.ln, LIMITS.ln) && inRange(params.r, LIMITS.r) && inRange(params.p, LIMITS.p);
}

function parseHash(stored: string): ParsedHash | null {
  const match = PHC_PATTERN.exec(stored);
  if (!match) return null;
  const params = { ln: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  if (!validParams(params)) return null;
  const salt = Buffer.from(match[4], 'base64');
  const key = Buffer.from(match[5], 'base64');
  if (salt.length < SALT_BYTES || key.length < 16) return null;
  return { params, salt, key };
}

/** The same characters hash the same way however the keyboard composed accents. */
function normalize(password: string): string {
  return password.normalize('NFC');
}

function derive(password: string, salt: Buffer, params: ScryptParams, keyLength: number): Promise<Buffer> {
  const N = 2 ** params.ln;
  return new Promise((resolve, reject) => {
    scrypt(
      normalize(password),
      salt,
      keyLength,
      // maxmem must exceed 128·N·r plus scrypt's small extra buffers; Node's 32 MiB default is just short.
      { N, r: params.r, p: params.p, maxmem: 256 * N * params.r + 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

function encode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=+$/, '');
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  if (!validParams(params)) throw new Error('invalid scrypt parameters');
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params, KEY_BYTES);
  return `$scrypt$ln=${params.ln},r=${params.r},p=${params.p}$${encode(salt)}$${encode(key)}`;
}

/**
 * Checks `password` against a stored hash with a constant-time comparison.
 * Returns false (never throws) for a wrong password or a malformed hash.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed || password.length > MAX_PASSWORD_LENGTH) return false;
  const candidate = await derive(password, parsed.salt, parsed.params, parsed.key.length);
  return timingSafeEqual(candidate, parsed.key);
}

/** True when a stored hash is weaker than `params`; the login route then rehashes it. */
export function needsRehash(stored: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return parsed.params.ln < params.ln || parsed.params.r < params.r || parsed.params.p < params.p
    || parsed.key.length < KEY_BYTES;
}

/** Policy for new passwords: a user-facing problem, or null when acceptable. */
export function passwordProblem(password: string, username?: string): string | null {
  if ([...normalize(password)].length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  if (username && password.trim().toLowerCase() === username.toLowerCase()) {
    return 'password must not be the username';
  }
  return null;
}

const dummyHashes = new Map<string, Promise<string>>();

/**
 * A real hash of a random secret. Logins for unknown usernames are checked
 * against it, so they cost the same scrypt work as a wrong password.
 */
export function dummyPasswordHash(params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  const key = `${params.ln},${params.r},${params.p}`;
  let hash = dummyHashes.get(key);
  if (!hash) {
    hash = hashPassword(randomBytes(32).toString('hex'), params);
    dummyHashes.set(key, hash);
  }
  return hash;
}
