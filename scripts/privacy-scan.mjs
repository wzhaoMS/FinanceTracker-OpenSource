#!/usr/bin/env node
// Privacy gate for everything this repository publishes. It checks one exact set of files:
//
//   node scripts/privacy-scan.mjs                     the staged index: exactly what `git commit` records (default).
//                                                     Fails while any tracked file differs from the index or an
//                                                     untracked, not-ignored file exists, so what was checked is what
//                                                     gets committed.
//   node scripts/privacy-scan.mjs --tree <tree-ish>   a commit or tree, e.g. `--tree HEAD` in CI
//   node scripts/privacy-scan.mjs --worktree          tracked and untracked (not ignored) files as they are on disk
//   add --require-blocklist                           fail unless a private blocklist (below) is present
//
// Every finding fails the scan. A finding prints a category and a path (with a line where that helps), never the matched
// value; a path segment that holds a finding is shown as ***. The generic checks always run, on file contents and on
// paths: secrets and private keys (Holdr's agent token included), SSH keys and host-key fingerprints, personal home paths
// in any letter case, e-mail addresses (also written with %40), IP addresses and Tailscale names outside the synthetic
// allowlists, card numbers (13 to 19 digits that pass the Luhn check) and social-security numbers. So do the file
// checks: runtime data, host configuration, Holdr's token and pairing-key files, documents, images and archives (except
// metadata-free PNG and WebP images of at most 1 MB under docs/assets/brand/, docs/assets/screenshots/ and
// apps/web/src/assets/brand/), data URIs embedded in SVG files, and structural problems (symbolic links, submodules,
// Git LFS pointers, files over 5 MB, NUL bytes, UTF-16 text). In --worktree mode a tracked file deleted from the disk is
// a pending deletion and is skipped.
//
// Personal identifiers are never stored in this repository. Maintainers keep them in the git-ignored file
// .privacy-scan.local at the repository root (one term per line; `#` starts a comment) and/or in PRIVACY_SCAN_BLOCKLIST
// (comma-separated). The file is UTF-8, or UTF-16 with a byte-order mark (what Windows PowerShell 5.1 writes with `>`);
// a term that holds NUL, a control or invisible character, or bytes that are not UTF-8 stops the scan, since it could
// never match. Terms and text are compared with letter case ignored, after Unicode compatibility folding with accent
// marks removed (NFKD), so `Vélmor` and fullwidth `ＶＥＬＭＯＲ` match `velmor`.
//   - A term of letters and digits matches as a word: text is split at non-alphanumeric characters, camelCase and
//     letter/digit boundaries, so `name`, `NAME_X`, `nameRows` and `name123` all match `name`. A term of five or more
//     characters also matches anywhere inside a word.
//   - Any other term (a name with a space, an address, a host name) matches as a substring with no letter or digit on
//     either side; its spaces match any run of whitespace, line breaks included.
//   - A term of five or more characters with its separators (`.`, `_`, `-`, whitespace) removed also matches text with
//     its separators removed, from the start of a word to the end of one: `Velmor_Tisk`, `velmor.tisk` and `VelmorTisk`
//     for `velmor tisk`, but not `velmor tiskets`. A term of digits only is not joined across `.`, so `12345` never
//     matches the amount `123.45`.
//   - Terms are also looked for in percent-decoded text (`velmor%20tisk`) and in printable text hidden in base64 or
//     base64url runs of 12 or more characters.
// Terms match file contents and paths in every file, with no exemption.
//
// Runs on Node.js 22 (the repository's version) with no dependencies.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage(message) {
  if (message) console.error(`privacy scan: ${message}`);
  console.error('usage: node scripts/privacy-scan.mjs [--index | --tree <tree-ish> | --worktree] [--require-blocklist]');
  process.exit(2);
}

let mode = 'index';
let revision = null;
let requireBlocklist = false;
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--index') mode = 'index';
  else if (arg === '--worktree') mode = 'worktree';
  else if (arg === '--require-blocklist') requireBlocklist = true;
  else if (arg === '--tree') {
    revision = argv[index + 1];
    if (!revision || revision.startsWith('-')) usage('--tree needs a commit or tree');
    mode = 'tree';
    index += 1;
  } else usage(`unknown argument ${JSON.stringify(arg)}`);
}

const git = (args, input) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
  cwd: repo,
  input,
  maxBuffer: 1024 * 1024 * 1024,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const nulList = (buffer) => buffer.toString('utf8').split('\0').filter(Boolean);

// ---------------------------------------------------------------------------------------------------------------------
// The private blocklist
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The text of `.privacy-scan.local`: UTF-8 with or without a byte-order mark, or UTF-16 with one, which Windows
 * PowerShell 5.1 writes with `>` and `Out-File`. Bytes that are not UTF-8 become U+FFFD, which `readBlocklist` refuses,
 * so a file saved in another encoding stops the scan instead of matching nothing.
 */
function decodeBlocklist(bytes) {
  const utf16 = (body, bigEndian) => {
    const even = Buffer.from(body.subarray(0, body.length - (body.length % 2)));
    if (bigEndian) even.swap16();
    return even.toString('utf16le') + (body.length % 2 ? '\uFFFD' : '');
  };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16(bytes.subarray(2), false);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16(bytes.subarray(2), true);
  return new TextDecoder('utf-8').decode(bytes);
}

// A term holding a control character (NUL included), an invisible format character, a lone surrogate, a private-use
// character or U+FFFD (bytes that were not UTF-8) could never match, so it stops the scan.
const UNUSABLE_TERM = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\uFFFD]/u;

/** Unicode compatibility decomposition without accent marks: `é` becomes `e`, fullwidth `Ｅ` becomes `E`. Keeps case. */
const fold = (text) => (/[^\x00-\x7f]/.test(text) ? text.normalize('NFKD').replace(/\p{M}+/gu, '') : text);

/** The terms, folded and lower-cased, and where each unusable term is (never the term itself). */
function readBlocklist() {
  const sources = (process.env.PRIVACY_SCAN_BLOCKLIST ?? '').split(',')
    .map((term, index) => ({ where: `PRIVACY_SCAN_BLOCKLIST entry ${index + 1}`, term }));
  const file = path.join(repo, '.privacy-scan.local');
  if (fs.existsSync(file)) {
    decodeBlocklist(fs.readFileSync(file)).split(/\r\n|\r|\n/).forEach((line, index) => {
      sources.push({ where: `.privacy-scan.local line ${index + 1}`, term: line.replace(/#.*/, '') });
    });
  }
  const terms = new Set();
  const unusable = [];
  for (const { where, term } of sources) {
    const folded = fold(term.trim());
    if (UNUSABLE_TERM.test(folded)) unusable.push(where);
    else if (folded.length >= 3) terms.add(folded.toLowerCase());
  }
  return { terms: [...terms], unusable };
}

const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;
/** Words of a run of letters and digits: split at camelCase and letter/digit boundaries, lower-cased. */
const wordsOf = (run) => (run.match(WORD) ?? []).map((word) => word.toLowerCase());
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const isSeparator = (code) => code === 0x2e || code === 0x5f || code === 0x2d || code === 0x20 || (code >= 0x09 && code <= 0x0d)
  || (code > 0x7f && /\s/.test(String.fromCharCode(code)));

const BLOCKLIST = readBlocklist();
const TERMS = BLOCKLIST.terms.map((term) => {
  const squeezed = term.replace(/[\s._-]+/g, '');
  const entry = {
    term,
    // The term with its separators removed, for text with its separators removed (five characters or more).
    squeezed: squeezed.length >= 5 ? squeezed : null,
    squeezedEdges: [/^[a-z0-9]/.test(squeezed), /[a-z0-9]$/.test(squeezed)],
    digitsOnly: /^[0-9]+$/.test(squeezed),
  };
  if (/^[a-z0-9]+$/.test(term)) return { ...entry, kind: term.length >= 5 ? 'substring' : 'word', words: wordsOf(term) };
  const body = term.split(/\s+/).map(escapeRegExp).join('\\s+');
  return { ...entry, kind: 'bounded', pattern: new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`) };
});

/** Index of the first term in `view`, a folded text, or -1. */
function viewMatch(view) {
  const lower = view.toLowerCase();
  let first = -1;
  const note = (index) => { if (index !== -1 && (first === -1 || index < first)) first = index; };
  let words = null;
  const wordList = () => (words ??= [...view.matchAll(WORD)].map((match) => ({
    word: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length,
  })));
  let squeezed = null;
  for (const entry of TERMS) {
    if (entry.kind === 'substring') note(lower.indexOf(entry.term));
    if (entry.kind === 'bounded') note(entry.pattern.exec(lower)?.index ?? -1);
    // The term's words in a row, however they are joined: `NAME_X` and `nameRows` for `name`, `Name 123` for `name123`.
    if (entry.words && (entry.kind === 'word' || entry.words.length > 1)) note(wordRun(wordList(), entry.words));
    if (entry.squeezed) note(squeezedMatch(squeezed ??= squeeze(lower, wordList()), lower, entry));
  }
  return first;
}

function wordRun(words, wanted) {
  for (let position = 0; position + wanted.length <= words.length; position += 1) {
    if (wanted.every((word, offset) => words[position + offset].word === word)) return words[position].start;
  }
  return -1;
}

/** `lower` without separators, where each of its characters came from, and where the words of the text start and end. */
function squeeze(lower, words) {
  const at = [];
  for (let index = 0; index < lower.length; index += 1) if (!isSeparator(lower.charCodeAt(index))) at.push(index);
  return {
    text: at.map((index) => lower[index]).join(''),
    at,
    starts: new Set(words.map((word) => word.start)),
    ends: new Set(words.map((word) => word.end)),
  };
}

/** The first place the squeezed term spans whole words of the text (`Velmor_Tisk`, `VelmorTisk`), or -1. */
function squeezedMatch(squeezed, lower, entry) {
  const [startsWord, endsWord] = entry.squeezedEdges;
  for (let at = squeezed.text.indexOf(entry.squeezed); at !== -1; at = squeezed.text.indexOf(entry.squeezed, at + 1)) {
    const start = squeezed.at[at];
    const end = squeezed.at[at + entry.squeezed.length - 1] + 1;
    if (startsWord && !squeezed.starts.has(start)) continue;
    if (endsWord && !squeezed.ends.has(end)) continue;
    if (entry.digitsOnly && lower.slice(start, end).includes('.')) continue;
    return start;
  }
  return -1;
}

/** `text` with each run of %XX escapes that is valid UTF-8 decoded; decoded control characters become spaces. */
function percentDecoded(text) {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const decoded = Buffer.from(run.replaceAll('%', ''), 'hex').toString('utf8');
    return decoded.includes('\uFFFD') ? run : decoded.replace(/\p{Cc}/gu, ' ');
  });
}

// A run of base64 or base64url characters long enough to hide a name, in mixed case as encoded text nearly always is.
const BASE64_RUN = /[A-Za-z0-9+/_-]{12,}={0,2}/g;
const PRINTABLE = /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}\t\n\r]+$/u;
/** The printable text a base64 run encodes, or null. */
function base64Text(run) {
  if (!/[a-z]/.test(run) || !/[A-Z]/.test(run)) return null;
  const text = Buffer.from(run, 'base64').toString('utf8');
  return !text.includes('\uFFFD') && PRINTABLE.test(text) ? text : null;
}

/** The line (from 1) of the first blocklist term in `text`, in any of the spellings above, or 0. */
function blocklistLine(text) {
  if (TERMS.length === 0) return 0;
  const view = fold(text);
  const lines = [];
  const plain = viewMatch(view);
  if (plain !== -1) lines.push(lineAt(view, plain));
  if (/%[0-9A-Fa-f]{2}/.test(view)) {
    const decoded = fold(percentDecoded(view));
    const index = viewMatch(decoded);
    if (index !== -1) lines.push(lineAt(decoded, index));
  }
  for (const match of view.matchAll(BASE64_RUN)) {
    const hidden = base64Text(match[0]);
    if (hidden !== null && viewMatch(fold(hidden)) !== -1) {
      lines.push(lineAt(view, match.index));
      break;
    }
  }
  return lines.length ? Math.min(...lines) : 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// The files to check
// ---------------------------------------------------------------------------------------------------------------------

function listEntries() {
  if (mode === 'worktree') {
    return [...new Set(nulList(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])))]
      .map((file) => ({ path: file, mode: null, stage: '0', oid: null }));
  }
  if (mode === 'tree') {
    return nulList(git(['ls-tree', '-r', '-z', '--full-tree', revision])).map((line) => {
      const tab = line.indexOf('\t');
      const [entryMode, , oid] = line.slice(0, tab).split(' ');
      return { path: line.slice(tab + 1), mode: entryMode, stage: '0', oid };
    });
  }
  return nulList(git(['ls-files', '-s', '-z'])).map((line) => {
    const tab = line.indexOf('\t');
    const [entryMode, oid, stage] = line.slice(0, tab).split(' ');
    return { path: line.slice(tab + 1), mode: entryMode, stage, oid };
  });
}

function readBlobs(oids) {
  const unique = [...new Set(oids)];
  const blobs = new Map();
  if (unique.length === 0) return blobs;
  const out = git(['cat-file', '--batch'], `${unique.join('\n')}\n`);
  let offset = 0;
  for (const oid of unique) {
    const newline = out.indexOf(10, offset);
    const header = out.subarray(offset, newline).toString('utf8').split(' ');
    if (header[1] === 'missing') throw new Error(`git object ${oid} is missing`);
    const size = Number(header[2]);
    const start = newline + 1;
    blobs.set(oid, out.subarray(start, start + size));
    offset = start + size + 1;
  }
  return blobs;
}

// ---------------------------------------------------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------------------------------------------------

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const PRIVATE_DATA_EXTENSIONS = new Set([
  '.db', '.db3', '.db-journal', '.db-shm', '.db-wal', '.sqlite', '.sqlite3', '.sqlite-shm', '.sqlite-wal',
  '.sqlite3-shm', '.sqlite3-wal', '.har', '.mhtml', '.warc', '.eml', '.msg', '.mbox', '.kdbx', '.keychain',
  '.keychain-db', '.sock', '.pid',
]);
const KEY_EXTENSIONS = new Set([
  '.key', '.pem', '.p12', '.pfx', '.jks', '.keystore', '.ppk', '.gpg', '.asc', '.crt', '.cer', '.der',
  '.mobileprovision', '.provisionprofile',
]);
const DOCUMENT_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.heic', '.heif', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico', '.xls',
  '.xlsx', '.xlsm', '.numbers', '.ods', '.doc', '.docx', '.pages', '.rtf', '.zip', '.7z', '.rar', '.tar', '.gz',
  '.tgz', '.bz2', '.xz', '.dmg', '.iso', '.mov', '.mp4', '.m4a', '.mp3', '.wav',
]);
const STATEMENT_EXTENSIONS = new Set(['.csv', '.tsv', '.ofx', '.qfx', '.qbo', '.qif', '.iif']);
// The only images the repository may hold are PNG and WebP files under docs/assets/brand/ (rendered from the SVGs
// there), docs/assets/screenshots/ (screenshots of the demo) and apps/web/src/assets/brand/ (the web app's icons, which
// Vite publishes as hashed release assets). Each must be at most 1 MB and made of image data alone: a PNG of the chunks
// in PNG_CHUNKS (no tEXt, iTXt, zTXt, eXIf, iCCP, tIME or other chunk), or a WebP without EXIF, XMP or ICC profile
// chunks (nor its header declaring one). The path is still checked like any other. Every other image or binary file is
// refused, anywhere, as is an image in those folders that fails these checks. SVG files are text and are scanned as
// text, and may not embed data URIs (an image inside one would skip these checks).
const ALLOWED_IMAGE = /^(?:docs\/assets\/(?:brand|screenshots)|apps\/web\/src\/assets\/brand)\/.+\.(?:png|webp)$/i;
const MAX_IMAGE_BYTES = 1024 * 1024;
const PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'sBIT', 'bKGD']);
const WEBP_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);
const WEBP_FRAME_CHUNKS = new Set(['VP8 ', 'VP8L', 'ALPH']);
// VP8X header flags that announce an ICC profile (0x20), EXIF (0x08) or XMP (0x04).
const WEBP_METADATA_FLAGS = 0x20 | 0x08 | 0x04;

/** Whether `bytes` is a PNG of allowed chunks only: IHDR first and once, at least one IDAT, nothing after IEND. */
function metadataFreePng(bytes) {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return false;
  let first = true;
  let imageData = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    const next = offset + 12 + bytes.readUInt32BE(offset);
    if (next > bytes.length || !PNG_CHUNKS.has(type) || first !== (type === 'IHDR')) return false;
    first = false;
    if (type === 'IDAT') imageData = true;
    offset = next;
    if (type === 'IEND') return imageData && offset === bytes.length;
  }
  return false;
}

/** The RIFF chunks between `start` and `end` as [type, payload start, payload end], or null unless they fill it exactly. */
function riffChunks(bytes, start, end) {
  const chunks = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) return null;
    const size = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    const next = payload + size + (size % 2);
    if (next > end) return null;
    chunks.push([bytes.subarray(offset, offset + 4).toString('latin1'), payload, payload + size]);
    offset = next;
  }
  return chunks;
}

/** Whether `bytes` is a WebP of image chunks only (animation frames included), with no metadata chunk or flag. */
function metadataFreeWebp(bytes) {
  if (bytes.length < 20 || bytes.subarray(0, 4).toString('latin1') !== 'RIFF' || bytes.subarray(8, 12).toString('latin1') !== 'WEBP'
    || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  const chunks = riffChunks(bytes, 12, bytes.length);
  if (!chunks) return false;
  let imageData = false;
  for (const [type, start, end] of chunks) {
    if (!WEBP_CHUNKS.has(type)) return false;
    if (type === 'VP8X' && (end === start || (bytes[start] & WEBP_METADATA_FLAGS) !== 0)) return false;
    if (type === 'VP8 ' || type === 'VP8L') imageData = true;
    if (type === 'ANMF') {
      const frame = end - start >= 16 ? riffChunks(bytes, start + 16, end) : null;
      if (!frame || frame.some(([inner]) => !WEBP_FRAME_CHUNKS.has(inner))) return false;
      imageData = true;
    }
  }
  return imageData;
}
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const RUNTIME_OR_GENERATED_PATHS = [
  /(^|\/)node_modules\//, /(^|\/)dist\//, /(^|\/)\.turbo\//, /(^|\/)\.expo\//, /(^|\/)\.next\//, /(^|\/)coverage\//,
  /^apps\/web\/releases\//, /^apps\/api\/data\//, /^data\//, /^backups?\//, /^logs?\//, /^apps\/api\/\.test-tmp\//,
  /^apps\/api\/native\/build\//, /(^|\/)\.i-[^/]*\//, /(^|\/)\.e2e-(tmp|logs)\//,
  /^apps\/web\/(test-results|playwright-report|blob-report)\//, /^apps\/web\/\.last-run\.json$/,
  /^apps\/web\/playwright\/\.auth\//, /(^|\/)\.(real-app-test|card-import-test|web-release-test)-[^/]*\//,
  /\.tsbuildinfo$/, /(^|\/)\.DS_Store$/, /\.log$/i,
];
// Directories of the original private deployment that must never return.
const RETIRED_PRIVATE_PATHS = [
  /^tools\/local-sessions\//, /^tools\/holdr-card-sync\//, /^\.github\/skills\/broker-reconciliation\//, /^docs\/handoff-/i,
];
function hostConfigFile(base) {
  if (/^\.env(\..+)?$/i.test(base)) return base !== '.env.example';
  if (/^holdr\.conf(\..+)?$/i.test(base)) return !base.endsWith('.example');
  return base === '.privacy-scan.local';
}
// Holdr's own secrets: the API's service and agent tokens (and the temporary files it writes them through) and the card
// sync agent's pairing key. They live in the data folder and the extension folder, never in a commit.
const HOLDR_SECRET_FILE = /^(?:(?:service|agent)-token|\.?local-key\.json)(?:\..*)?$/i;

// ---------------------------------------------------------------------------------------------------------------------
// Content rules
// ---------------------------------------------------------------------------------------------------------------------

const SECRET_PATTERNS = [
  new RegExp(['-----BEGIN ', '(?:[A-Z0-9]+ )*', 'PRIVATE KEY', '(?: BLOCK)?-----'].join('')),
  new RegExp(['github_', 'pat_', '[A-Za-z0-9_]{20,}'].join('')),
  new RegExp(['gh', '[pousr]_', '[A-Za-z0-9]{20,}'].join('')),
  new RegExp(['(?:AKIA|ASIA)', '[0-9A-Z]{16}'].join('')),
  new RegExp(['xox', '[baprs]-', '[A-Za-z0-9-]{20,}'].join('')),
  new RegExp(['(?<![A-Za-z0-9])', 'sk-', '[A-Za-z0-9_-]{24,}'].join('')),
  new RegExp(['(?:sk|rk)', '_live_', '[0-9A-Za-z]{16,}'].join('')),
  new RegExp(['AIza', '[0-9A-Za-z_-]{35}'].join('')),
  new RegExp(['tskey-', '[a-z]+-', '[A-Za-z0-9]{8,}'].join('')),
  new RegExp(['npm_', '[A-Za-z0-9]{36}'].join('')),
  new RegExp(['eyJ', '[A-Za-z0-9_-]{10,}', '\\.eyJ', '[A-Za-z0-9_-]{10,}', '\\.[A-Za-z0-9_-]{10,}'].join('')),
  new RegExp(['_auth', '(?:Token)?', '\\s*='].join('')),
  // Holdr's read-only agent token (apps/api/src/auth/agentToken.ts), whose prefix exists so that scanners find it.
  new RegExp(['holdr_', 'agent_', '[0-9a-f]{64}'].join('')),
];
const SSH_PATTERNS = [
  new RegExp(['SHA256', ':', '[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/])'].join('')),
  new RegExp(['(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp[0-9]+|sk-ssh-ed25519@openssh\\.com)', ' AAAA', '[0-9A-Za-z+/]{20,}'].join('')),
];

// Addresses tests use on purpose, outside the always-allowed reserved ranges: synthetic private, CGNAT and link-local
// addresses, boundary cases, well-known public resolvers, and two X.509 object identifiers that look like addresses.
// Add a value only for a synthetic test address; real addresses belong in no file.
const ALLOWED_IPV4 = new Set([
  '1.1.1.1', '1.2.3.4', '2.5.4.3', '2.5.29.17', '6.6.6.6', '8.8.8.8', '93.184.215.14',
  '10.0.0.1', '10.0.0.7', '10.0.0.8', '10.0.0.99',
  '100.1.1.1', '100.63.255.255', '100.64.0.0', '100.64.0.1', '100.64.0.2', '100.64.0.7', '100.64.0.9', '100.64.1.2',
  '100.64.100.50', '100.96.0.2', '100.96.0.5', '100.101.1.2', '100.101.1.3', '100.101.1.4', '100.101.102.103',
  '100.127.255.254', '100.128.0.1',
  '169.254.0.0', '169.254.10.20', '172.16.0.1',
  '192.168.0.0', '192.168.1.0', '192.168.1.1', '192.168.1.20', '192.168.1.65', '192.168.1.116',
  '192.168.23.255', '192.168.24.0', '192.168.24.1', '192.168.24.2', '192.168.24.10', '192.168.24.20', '192.168.24.30',
  '192.168.24.50', '192.168.24.65', '192.168.24.66', '192.168.24.68', '192.168.26.42', '192.168.27.250',
  '192.168.27.254', '192.168.27.255', '192.168.28.1',
]);
const ALLOWED_IPV6 = new Set([
  '2606:4700:4700::1111', 'fd12:3456:789a:1::10', 'fd12:3456:789a:1::20', 'fd12:3456:789a:2::20', 'fd7a:115c:a1e0::',
  'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::5', 'fd7a:115c:a1e0::1234', 'fd7a:115c:a1e0::5678', 'fd7a:115c:a1e1::1',
]);
/** Loopback, unspecified, multicast and broadcast, and the documentation and benchmarking ranges. */
function reservedIpv4([a, b, c]) {
  return a === 0 || a === 127 || a >= 224
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || (a === 198 && (b === 18 || b === 19));
}
const ALLOWED_TAILNETS = new Set(['example', 'test']);
const ALLOWED_MAIL_DOMAIN = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$|^users\.noreply\.github\.com$/i;
const GENERIC_HOME = /^(sample\d*|test(user)?\d*|example|runner|runneradmin|RUNNER~1|user(name)?|me|you|alice|bob|Shared|Public|Default|\$\{?USER\}?|\$HOME|%USERNAME%)$/i;
// Published test card numbers, and synthetic variants on the same test prefixes, that the parsers are exercised with.
const TEST_CARD_NUMBERS = new Set([
  '2223003122003222', '30569309025904', '3530111333300000', '3566002020360505', '371449635398431', '378282246310005',
  '378282246314205', '378282246387649', '38520000023237', '4000000000000000006', '4000056655665556', '4012888888881881',
  '4111111111111111', '4111111111111111797', '4111111111111114254', '4111111111155555', '4222222222222', '4242424242424242',
  '4444555555555555', '5555555555554444', '6011000990139424', '6011111111111117', '6200000000000005', '6304000000000000',
  '6759649826438453',
]);
const ALLOWED_SSN_SHAPES = new Set(['123-45-6789']);

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) value = value * 2 > 9 ? value * 2 - 9 : value * 2;
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Whether digits written in `groups` could be a card number: 13 to 19 digits that pass the Luhn check and start like a
 * card of that length (Visa 13, 16 and 19; Diners Club 14; American Express 15; Mastercard, Discover, JCB, UnionPay and
 * Maestro 16 to 19). Lengths other than 15 and 16, where timestamps, references and Windows SIDs are common, must also be
 * one run or groups that start with four digits.
 */
function cardDigits(groups) {
  const digits = groups.join('');
  if (digits.length < 13 || digits.length > 19 || !luhn(digits) || TEST_CARD_NUMBERS.has(digits)) return false;
  if (digits.length === 15 || digits.length === 16) return /^[2-6]/.test(digits);
  if (groups.length > 1 && (groups[0].length !== 4 || groups.slice(1).some((group) => group.length < 3 || group.length > 6))) return false;
  if (digits.length === 13) return digits.startsWith('4');
  if (digits.length === 14) return /^(?:30[0-5]|3[689])/.test(digits);
  return /^(?:4|35|5[06-8]|6)/.test(digits);
}

/** Whether a run of digits, spaces and hyphens holds a card number: all of it, or card-like groups within it. */
function holdsCardNumber(written) {
  const groups = written.split(/[ -]/);
  if (cardDigits(groups)) return true;
  const cardGroups = (part) => part.length === 1 || (part[0].length === 4 && part.slice(1).every((group) => group.length >= 3 && group.length <= 6));
  for (let from = 0; from < groups.length; from += 1) {
    for (let to = from + 1; to <= groups.length; to += 1) {
      const part = groups.slice(from, to);
      if (part.length < groups.length && cardGroups(part) && cardDigits(part)) return true;
    }
  }
  return false;
}

function lineAt(text, index) {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) line += 1;
  return line;
}

// ---------------------------------------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------------------------------------

const findings = [];
// Paths are printed with every segment that holds a blocklist term or a generic finding shown as ***, so that no output
// reveals a matched value.
const displayed = new Map();
function displayPath(file) {
  if (!displayed.has(file)) {
    const spans = pathFindings(file).map(({ index, length }) => [index, index + length]);
    let start = 0;
    const segments = file.split('/').map((segment) => {
      const end = start + segment.length;
      const masked = blocklistLine(segment) > 0 || spans.some(([from, to]) => from < end && to > start);
      start = end + 1;
      return masked ? '***' : segment;
    });
    displayed.set(file, !segments.includes('***') && blocklistLine(file) > 0 ? '***' : segments.join('/'));
  }
  return displayed.get(file);
}
const report = (category, file, line = null) => findings.push({ category, file: displayPath(file), line });

const HOME_PATH = /(?:\b[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)+|\/Users\/|\/home\/)([^\\/\s"'`<>:*?|]+)/gi;
const EMAIL = /[A-Z0-9._%+-]+(?:@|%40)([A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,})\b/gi;
const IPV4 = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)(?![A-Za-z0-9_])/g;
const IPV6 = /(?<![\w:])(?:[23][0-9a-f]{3}|f[cd][0-9a-f]{2}):(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4}(?![\w:])/gi;
const TAILNET_NAME = /(?<![a-z0-9-])((?:[a-z0-9-]+\.)*[a-z0-9-]+)\.(?:ts\.net|beta\.tailscale\.net)(?![a-z0-9-])/gi;
// 13 to 19 digits, single spaces or hyphens allowed between them, not the decimals of a number.
const CARD_NUMBER = /(?<![0-9A-Za-z]|[0-9]\.)(?:[0-9][ -]?){12,18}[0-9](?![0-9A-Za-z])/g;
const SSN = /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g;

/** The first match of each generic rule in `text`, as { category, index, length }. */
function genericFindings(text) {
  const found = [];
  const add = (category, match) => found.push({ category, index: match.index, length: match[0].length });
  const first = (category, matches, accept = () => true) => {
    for (const match of matches) if (accept(match)) { add(category, match); return; }
  };
  first('secret-material', SECRET_PATTERNS.map((pattern) => pattern.exec(text)).filter(Boolean).sort((a, b) => a.index - b.index));
  first('ssh-key-or-fingerprint', SSH_PATTERNS.map((pattern) => pattern.exec(text)).filter(Boolean).sort((a, b) => a.index - b.index));
  first('machine-specific-user-path', text.matchAll(HOME_PATH), (match) => !GENERIC_HOME.test(match[1]));
  first('non-example-email', text.matchAll(EMAIL), (match) => text.slice(Math.max(0, match.index - 2), match.index) !== '//' // URL userinfo
    && !ALLOWED_MAIL_DOMAIN.test(match[1]));
  first('unapproved-ip-address', [
    ...[...text.matchAll(IPV4)].filter((match) => {
      const octets = match.slice(1, 5).map(Number);
      return !(octets.some((octet) => octet > 255) || reservedIpv4(octets) || ALLOWED_IPV4.has(octets.join('.')));
    }),
    ...[...text.matchAll(IPV6)].filter((match) => !match[0].toLowerCase().startsWith('2001:db8:') && !ALLOWED_IPV6.has(match[0].toLowerCase())),
  ].sort((a, b) => a.index - b.index));
  first('concrete-tailnet-hostname', text.matchAll(TAILNET_NAME), (match) => !ALLOWED_TAILNETS.has(match[1].toLowerCase().split('.').pop()));
  first('possible-card-number', text.matchAll(CARD_NUMBER), (match) => holdsCardNumber(match[0]));
  first('possible-ssn', text.matchAll(SSN), (match) => !ALLOWED_SSN_SHAPES.has(match[0]));
  return found;
}

/** The generic findings in a repository path, with indexes into the path. */
const pathFindings = (file) => genericFindings(`/${file}`).map((finding) => ({ ...finding, index: finding.index - 1 }));

function scanContent(file, text) {
  const extension = path.posix.extname(file).toLowerCase();
  const fixture = /(^|\/)(__fixtures__|fixtures)\//.test(file);

  const blocked = blocklistLine(text);
  if (blocked) report('local-blocklist-term', file, blocked);
  for (const { category, index } of genericFindings(text)) report(category, file, lineAt(text, index));
  if (text.startsWith('version https://git-lfs.github.com/spec/')) report('git-lfs-pointer', file);

  if (file === 'package-lock.json') {
    // Every package comes from the public registry, except the workspaces, which npm records as relative links.
    for (const match of text.matchAll(/"resolved":\s*"([^"]+)"/g)) {
      if (!match[1].startsWith('https://registry.npmjs.org/') && !/^(apps|packages)\/[A-Za-z0-9._-]+$/.test(match[1])) {
        report('non-public-package-source', file, lineAt(text, match.index));
        break;
      }
    }
  }

  if (extension === '.svg') {
    // An image (or any other base64 payload) inside an SVG would bypass the image rules above.
    const embedded = /data:\s*(?:image\/|[^,"'()<>\s]*;\s*base64\s*,)/i.exec(text);
    if (embedded) report('svg-embedded-data-uri', file, lineAt(text, embedded.index));
  }

  if (!fixture && !CODE_EXTENSIONS.has(extension)) {
    const statement = /OFXHEADER:|<OFX>/i.exec(text);
    if (statement) report('financial-statement-outside-fixtures', file, lineAt(text, statement.index));
  }
}

function scanEntry(entry, bytes) {
  const file = entry.path.replaceAll('\\', '/');
  const base = path.posix.basename(file);
  const extension = path.posix.extname(file).toLowerCase();
  const fixture = /(^|\/)(__fixtures__|fixtures)\//.test(file);

  if (entry.stage !== '0') report('unmerged-index-entry', file);
  if (blocklistLine(file)) report('local-blocklist-term-in-path', file);
  for (const { category } of pathFindings(file)) report(`${category}-in-path`, file);
  if (entry.mode === '160000') { report('submodule', file); return; }
  if (entry.mode === '120000') report('symbolic-link', file);
  if (RETIRED_PRIVATE_PATHS.some((pattern) => pattern.test(file))) report('retired-private-path', file);
  if (RUNTIME_OR_GENERATED_PATHS.some((pattern) => pattern.test(file))) report('runtime-or-generated-file', file);
  if (hostConfigFile(base)) report('host-config-or-environment-file', file);
  if (HOLDR_SECRET_FILE.test(base)) report('holdr-token-or-key-file', file);
  if (PRIVATE_DATA_EXTENSIONS.has(extension)) report('private-data-file', file);
  if (KEY_EXTENSIONS.has(extension)) report('key-or-certificate-file', file);
  const allowedImage = entry.mode !== '120000' && ALLOWED_IMAGE.test(file);
  if (DOCUMENT_EXTENSIONS.has(extension) && !allowedImage) report('document-image-or-archive', file);
  if (STATEMENT_EXTENSIONS.has(extension) && !fixture) report('financial-statement-outside-fixtures', file);

  if (bytes === null) { report('unreadable-file', file); return; }
  if (allowedImage) {
    if (bytes.length > MAX_IMAGE_BYTES) report('image-over-1-mb', file);
    else if (!(extension === '.png' ? metadataFreePng(bytes) : metadataFreeWebp(bytes))) report('image-metadata-or-unknown-format', file);
    return;
  }
  if (bytes.length > MAX_FILE_BYTES) { report('file-over-5-mb', file); return; }
  const head = bytes.subarray(0, 16);
  if (head.toString('latin1').startsWith('SQLite format 3')) report('private-data-file', file);
  if (head.toString('latin1').startsWith('%PDF-')) report('document-image-or-archive', file);
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) { report('utf-16-file', file); return; }
  if (bytes.includes(0)) { report('binary-file-with-nul-bytes', file); return; }
  scanContent(file, bytes.toString('utf8'));
}

if (BLOCKLIST.unusable.length > 0) {
  const where = BLOCKLIST.unusable.slice(0, 5).join(', ') + (BLOCKLIST.unusable.length > 5 ? ` and ${BLOCKLIST.unusable.length - 5} more` : '');
  console.error(`privacy scan: unusable blocklist term (${where}): it holds NUL, a control or invisible character, or bytes that`
    + ' are not UTF-8, so it could never match. Save .privacy-scan.local as UTF-8 (in PowerShell: Set-Content -Encoding utf8).');
  process.exit(1);
}
if (requireBlocklist && TERMS.length === 0) {
  console.error('privacy scan: --require-blocklist needs at least one term in .privacy-scan.local or PRIVACY_SCAN_BLOCKLIST');
  process.exit(1);
}

const entries = listEntries();
if (mode === 'index') {
  for (const file of nulList(git(['diff', '--name-only', '-z']))) report('unstaged-change', file);
  for (const file of nulList(git(['ls-files', '-z', '--others', '--exclude-standard']))) report('untracked-file', file);
}
const blobs = mode === 'worktree' ? null : readBlobs(entries.filter((entry) => entry.mode !== '160000').map((entry) => entry.oid));
let checked = 0;
for (const entry of entries) {
  let bytes = null;
  if (entry.mode === '160000') bytes = Buffer.alloc(0);
  else if (blobs) bytes = blobs.get(entry.oid) ?? null;
  else {
    const absolute = path.join(repo, entry.path);
    let stat = null;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      // A tracked file deleted from the working tree is a pending deletion: `git add -A` publishes nothing of it.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
    }
    try {
      if (stat?.isSymbolicLink()) {
        entry.mode = '120000';
        bytes = Buffer.from(fs.readlinkSync(absolute));
      } else bytes = fs.readFileSync(absolute);
    } catch {
      bytes = null;
    }
  }
  checked += 1;
  scanEntry(entry, bytes);
}

const scope = mode === 'index' ? 'staged index' : mode === 'tree' ? `tree ${revision}` : 'working tree';
const terms = TERMS.length ? `${TERMS.length} private blocklist term(s)` : 'no private blocklist';
findings.sort((a, b) => a.category.localeCompare(b.category) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
for (const finding of findings) console.error(`${finding.category}: ${finding.file}${finding.line ? `:${finding.line}` : ''}`);
if (findings.length > 0) {
  console.error(`privacy scan of the ${scope} failed (${terms}): ${findings.length} finding(s); matched values are never printed`);
  process.exit(1);
}
console.log(`privacy scan of the ${scope} passed (${terms}): ${checked} files checked`);
