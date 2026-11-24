import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { HOLDR_API_PATH_PREFIXES } from '../apiPaths.js';
import { releaseCssAllowed } from './css.js';

export const RELEASE_FORMAT = 'holdr-web-release/1';
export const RELEASE_PATH = /^(?:index\.html|assets\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.(?:js|css|woff2|png|svg|ico))$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
export const MAX_RELEASE_FILES = 500;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_RELEASE_BYTES = 32 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface ReleaseFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ReleaseManifest {
  readonly format: typeof RELEASE_FORMAT;
  readonly sourceCommit: string;
  readonly files: readonly ReleaseFile[];
}

export class WebReleaseError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WebReleaseError';
  }
}

export function releaseError(code: string): never {
  throw new WebReleaseError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function canonicalManifest(manifest: ReleaseManifest): string {
  return JSON.stringify({
    format: manifest.format,
    sourceCommit: manifest.sourceCommit,
    files: manifest.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  }, null, 2) + '\n';
}

export function parseManifest(text: string): ReleaseManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return releaseError('E0I_MANIFEST_INVALID');
  }
  if (!record(value) || !exactKeys(value, ['format', 'sourceCommit', 'files'])
    || value.format !== RELEASE_FORMAT || typeof value.sourceCommit !== 'string'
    || !SOURCE_COMMIT.test(value.sourceCommit) || !Array.isArray(value.files)) {
    return releaseError('E0I_MANIFEST_INVALID');
  }
  if (value.files.length < 1 || value.files.length > MAX_RELEASE_FILES) releaseError('E0I_RELEASE_LIMITS');
  let total = 0;
  let previous = '';
  let documents = 0;
  const reserved = new Set<string>(HOLDR_API_PATH_PREFIXES);
  const files: ReleaseFile[] = value.files.map((file: unknown) => {
    if (!record(file) || !exactKeys(file, ['path', 'size', 'sha256'])
      || typeof file.path !== 'string' || !RELEASE_PATH.test(file.path)
      || reserved.has(file.path.split('/')[0].toLowerCase()) || file.path <= previous
      || typeof file.sha256 !== 'string' || !SHA256_HEX.test(file.sha256)
      || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0) {
      return releaseError('E0I_MANIFEST_INVALID');
    }
    previous = file.path;
    if (file.path === 'index.html') documents++;
    total += file.size;
    if (file.size > MAX_FILE_BYTES || total > MAX_RELEASE_BYTES) releaseError('E0I_RELEASE_LIMITS');
    return Object.freeze({ path: file.path, size: file.size, sha256: file.sha256 });
  });
  if (documents !== 1) releaseError('E0I_MANIFEST_INVALID');
  const manifest = Object.freeze({
    format: RELEASE_FORMAT,
    sourceCommit: value.sourceCommit,
    files: Object.freeze(files),
  });
  if (canonicalManifest(manifest) !== text) releaseError('E0I_MANIFEST_INVALID');
  return manifest;
}

export function releaseText(bytes: Uint8Array): string {
  if (bytes.includes(0) || bytes.includes(13)) releaseError('E0I_RELEASE_TEXT');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return releaseError('E0I_RELEASE_TEXT');
  }
  if (/sourceMappingURL/i.test(text)) releaseError('E0I_RELEASE_TEXT');
  return text;
}

function assetReference(value: string, paths: ReadonlySet<string>): boolean {
  return value.startsWith('/assets/') && paths.has(value.slice(1));
}

const LINK_ATTRIBUTES = ['rel', 'crossorigin', 'href'];
const ICON_ATTRIBUTES = ['rel', 'href', 'type', 'sizes'];
const ICON_TYPES: Readonly<Record<'svg' | 'png', string>> = { svg: 'image/svg+xml', png: 'image/png' };
/** One `sizes` token: `any`, or width x height in pixels without leading zeros (`32x32`, `180x180`). */
const ICON_SIZES = /^(?:any|[1-9][0-9]{0,3}x[1-9][0-9]{0,3})$/;

/**
 * The `<link>`s a release document may carry: the entry's stylesheet or module preload (`rel`, `crossorigin`, `href`),
 * and the page's icons, `rel="icon"` or `rel="apple-touch-icon"` to a release `.svg` or `.png` with nothing but an
 * optional `type`, which must be that extension's, and an optional single `sizes` token. Every `href` is a file of this
 * release; nothing links to another origin, a `data:` URL or a relative path.
 */
function releaseLinkAllowed(attrs: ReadonlyMap<string, string>, paths: ReadonlySet<string>): boolean {
  const rel = attrs.get('rel');
  const href = attrs.get('href') ?? '';
  const only = (allowed: readonly string[]) => [...attrs.keys()].every((name) => allowed.includes(name));
  if (!assetReference(href, paths)) return false;
  if (rel === 'stylesheet' || rel === 'modulepreload') {
    return only(LINK_ATTRIBUTES) && href.endsWith(rel === 'stylesheet' ? '.css' : '.js');
  }
  if ((rel !== 'icon' && rel !== 'apple-touch-icon') || !only(ICON_ATTRIBUTES)) return false;
  const image = href.endsWith('.svg') ? 'svg' : href.endsWith('.png') ? 'png' : null;
  const type = attrs.get('type');
  const sizes = attrs.get('sizes');
  return image !== null && (type === undefined || type === ICON_TYPES[image]) && (sizes === undefined || ICON_SIZES.test(sizes));
}

export function validateReleaseHtml(html: string, paths: ReadonlySet<string>): void {
  let invalid = false;
  const document = parse(html, { onParseError: () => { invalid = true; } });
  let scripts = 0;
  // This is a small Vite entry document, not arbitrary HTML. New resource-bearing forms
  // need an explicit policy instead of slipping past a list of known-dangerous attributes.
  const attributes: Record<string, readonly string[]> = {
    html: ['lang'], head: [], body: [], title: [], meta: ['charset', 'name', 'content'],
    div: ['id', 'class'], script: ['type', 'crossorigin', 'src'], link: ['rel', 'crossorigin', 'href', 'type', 'sizes'],
    svg: ['xmlns', 'width', 'height', 'class', 'aria-hidden'], defs: [],
    filter: ['id', 'x', 'y', 'width', 'height'],
    feturbulence: ['type', 'basefrequency', 'numoctaves', 'seed', 'result'],
    fedisplacementmap: ['in', 'in2', 'scale', 'xchannelselector', 'ychannelselector'],
  };
  const visit = (node: DefaultTreeAdapterMap['node']): void => {
    if ('tagName' in node) {
      const tag = node.tagName.toLowerCase();
      const allowed = Object.hasOwn(attributes, tag) ? attributes[tag] : undefined;
      if (!allowed) invalid = true;
      const svg = ['svg', 'defs', 'filter', 'feturbulence', 'fedisplacementmap'].includes(tag);
      if (node.namespaceURI !== (svg ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml')) invalid = true;
      for (const attr of node.attrs) {
        const name = attr.name.toLowerCase();
        if (!allowed?.includes(name)) invalid = true;
        if (attr.namespace && !(tag === 'svg' && name === 'xmlns' && !attr.prefix && attr.value === 'http://www.w3.org/2000/svg')) invalid = true;
        if ((name === 'src' || name === 'href') && !assetReference(attr.value, paths)) invalid = true;
      }
      if (tag === 'link' && !releaseLinkAllowed(new Map(node.attrs.map((attr) => [attr.name.toLowerCase(), attr.value])), paths)) {
        invalid = true;
      }
      if (tag === 'script') {
        scripts++;
        const attrs = new Map(node.attrs.map((attr) => [attr.name, attr.value]));
        if (attrs.size !== 3 || attrs.get('type') !== 'module' || attrs.get('crossorigin') !== ''
          || !assetReference(attrs.get('src') ?? '', paths)
          || !attrs.get('src')?.endsWith('.js') || node.childNodes.length !== 0) invalid = true;
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  };
  visit(document);
  if (invalid || scripts !== 1) releaseError('E0I_RELEASE_HTML');
}

export function validateReleaseContents(files: ReadonlyMap<string, Uint8Array>): void {
  const paths = new Set(files.keys());
  for (const [name, bytes] of files) {
    if (!RELEASE_PATH.test(name)) releaseError('E0I_RELEASE_EXTRA');
    if (!/\.(?:html|js|css|svg)$/.test(name)) continue;
    const text = releaseText(bytes);
    if (name === 'index.html') validateReleaseHtml(text, paths);
    if (name.endsWith('.css') && !releaseCssAllowed(text, paths)) releaseError('E0I_RELEASE_CSS');
    if (name.endsWith('.js') && /\beval\s*\(|\bnew\s+Function\s*\(/.test(text)) releaseError('E0I_RELEASE_SCRIPT');
  }
  if (!files.has('index.html')) releaseError('E0I_RELEASE_MISSING');
}
