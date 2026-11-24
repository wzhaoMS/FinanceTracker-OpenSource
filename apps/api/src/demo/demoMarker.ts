import fs from 'node:fs';
import path from 'node:path';

/**
 * The demo folder's marker (`npm run demo`; scripts/start-local.mjs writes it and keeps the same rules): a regular file
 * beside the demo's `data` folder holding exactly this text, then `seeded <YYYY-MM-DD>` once a seed has finished.
 */
export const DEMO_MARKER = '.holdr-demo';
const MARKER_PATTERN = /^Holdr demo data \(synthetic\)\. Safe to delete\.\n(?:seeded \d{4}-\d{2}-\d{2}\n)?$/;
const MARKER_MAX_BYTES = 256;

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

/** Whether `demoRoot` holds the demo's marker: a regular file, not a link, with exactly the text the launcher writes. */
export function hasExactDemoMarker(demoRoot: string): boolean {
  const file = path.join(demoRoot, DEMO_MARKER);
  const stat = lstatOrNull(file);
  if (!stat?.isFile() || stat.size > MARKER_MAX_BYTES) return false;
  return MARKER_PATTERN.test(fs.readFileSync(file, 'utf8'));
}

/** `target` with its deepest existing folder resolved through links, the rest as written. */
function physicalPath(target: string): string {
  const rest: string[] = [];
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return target;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...rest);
}

/**
 * The demo folder that `dir` is or lies in, as written or through links: the nearest folder, `dir` included, holding a
 * `.holdr-demo` entry of any kind; null when there is none. The demo deletes that folder whenever it makes its data again,
 * so Holdr's own tools keep a real data folder out of it.
 */
export function demoFolderAround(dir: string): string | null {
  const requested = path.resolve(dir);
  let physical = requested;
  try {
    physical = physicalPath(requested);
  } catch {
    // Unreadable above: the path as written is still checked.
  }
  for (const start of new Set([requested, physical])) {
    for (let current = start; ; current = path.dirname(current)) {
      if (lstatOrNull(path.join(current, DEMO_MARKER))) return current;
      if (path.dirname(current) === current) break;
    }
  }
  return null;
}
