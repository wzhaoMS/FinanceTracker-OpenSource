import { verifyRelease } from '@finance-tracker/shared/web-release/files';
import type { ReleaseFile, ReleaseManifest } from '@finance-tracker/shared/web-release';

export interface WebFile extends ReleaseFile {
  readonly contentType: string;
  readonly etag: string;
  /** A copy: callers cannot mutate the verified bytes held by the release. */
  bytes(): Buffer;
}
export interface WebRelease {
  readonly digest: string;
  readonly manifest: ReleaseManifest;
  get(rawPath: string): WebFile | undefined;
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  woff2: 'font/woff2', png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon',
};

export function loadWebRelease(options: { dir: string; digest: string }): WebRelease {
  const verified = verifyRelease(options.dir, options.digest);
  const files = new Map<string, WebFile>();
  for (const entry of verified.manifest.files) {
    const body = verified.files.get(entry.path)!;
    files.set(`/${entry.path}`, Object.freeze({
      ...entry,
      contentType: CONTENT_TYPES[entry.path.split('.').pop()!],
      etag: `"sha256-${Buffer.from(entry.sha256, 'hex').toString('base64url')}"`,
      bytes: () => Buffer.from(body),
    }));
  }
  return Object.freeze({ digest: verified.digest, manifest: verified.manifest, get: (rawPath: string) => files.get(rawPath) });
}
