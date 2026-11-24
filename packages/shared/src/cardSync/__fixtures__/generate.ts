/**
 * Rewrites the JSON fixtures in `valid/` from the builders in `drafts.ts`:
 *   npx tsx src/cardSync/__fixtures__/generate.ts      (from packages/shared)
 * Files are two-space JSON with a trailing newline; the canonical bytes of
 * each are what `canonicalJson` gives for the parsed value.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CARD_SYNC_V2_FIXTURE_BUILDERS, PROJECTED_BATCH_FIXTURE_BUILDERS } from './drafts.js';

export function fixtureFileText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const directory = fileURLToPath(new URL('./valid/', import.meta.url));
mkdirSync(directory, { recursive: true });
for (const [name, build] of [...Object.entries(CARD_SYNC_V2_FIXTURE_BUILDERS), ...Object.entries(PROJECTED_BATCH_FIXTURE_BUILDERS)]) {
  writeFileSync(`${directory}${name}`, fixtureFileText(build()));
  process.stdout.write(`wrote ${name}\n`);
}
