#!/usr/bin/env node
/**
 * Lifts the card-sync schema v15 SQL out of the approved E1b design, so the
 * repository executes exactly the text the design and its validator
 * (validate-ddl.mjs) reviewed, never a retyped copy.
 *
 *   node scripts/card-sync-extract-sql.mjs <path to e1b-schema-design.md> [--check]
 *
 * Writes apps/api/src/services/cardSyncSchemaSql.ts; with `--check`, writes
 * nothing and exits 1 unless that file is exactly what the design yields (a
 * reviewer's proof that the repository runs the approved text). A section's SQL is every
 * ```sql fence that starts with `-- @block <section>`, in document order,
 * joined with a newline; a named statement is the body of a ```sql fence that
 * starts with `-- @query <name>`. Both regular expressions are the
 * validator's own. After regenerating, re-pin the hashes in
 * apps/api/src/services/cardSyncSchemaSql.test.ts and review the diff.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docPath = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const check = process.argv.includes('--check');
if (!docPath) {
  console.error('usage: node scripts/card-sync-extract-sql.mjs <path to e1b-schema-design.md> [--check]');
  process.exit(2);
}
const doc = fs.readFileSync(docPath, 'utf8');
const revision = /^# E1b: .*, revision (\d+)$/m.exec(doc)?.[1];
if (!revision) throw new Error('the document has no "# E1b: …, revision N" title');

const blocks = new Map();
for (const m of doc.matchAll(/```sql\n(-- @block ([0-9.a-z]+)\n[\s\S]*?)```/g)) {
  if (!blocks.has(m[2])) blocks.set(m[2], []);
  blocks.get(m[2]).push(m[1]);
}
const queries = new Map([...doc.matchAll(/```sql\n-- @query ([a-z0-9-]+)\n([\s\S]*?)```/g)].map((m) => [m[1], m[2]]));

const EXPECTED_BLOCKS = ['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.9', '2.10', '2.11', '2.12', '2.13', '2.14',
  '2.15', '2.16', '2.17', '2.18', '2.19', '3.4a', '3.4b', '3.4c'];
const missing = EXPECTED_BLOCKS.filter((section) => !blocks.has(section));
const extra = [...blocks.keys()].filter((section) => !EXPECTED_BLOCKS.includes(section));
if (missing.length || extra.length) throw new Error(`blocks: missing ${missing.join(', ') || 'none'}, unexpected ${extra.join(', ') || 'none'}`);
if (queries.size !== 22) throw new Error(`expected 22 named statements, found ${queries.size}`);

const literal = (text) => `\`${text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``;
const sha256 = createHash('sha256').update(doc).digest('hex');
const out = [
  '/**',
  ' * Card-sync schema v15 (E1b) and its named statements, lifted verbatim from',
  ` * the approved design, e1b-schema-design.md revision ${revision}`,
  ` * (sha256 ${sha256}),`,
  ' * by scripts/card-sync-extract-sql.mjs. Generated: do not edit by hand.',
  ' * Regenerate from the design and re-pin cardSyncSchemaSql.test.ts.',
  ' *',
  ' * CARD_SYNC_BLOCKS: per design section, every `-- @block` fence joined with a',
  ' * newline (the migration runs them in the order of the design\'s §3.1).',
  ' * CARD_SYNC_QUERIES: the 22 `-- @query` statements (cardSyncStatements.ts).',
  ' */',
  `export const CARD_SYNC_DESIGN_SOURCE = { revision: ${revision}, sha256: '${sha256}' } as const;`,
  '',
  'export const CARD_SYNC_BLOCKS = {',
  ...EXPECTED_BLOCKS.map((section) => `  '${section}': ${literal(blocks.get(section).join('\n'))},`),
  '} as const;',
  '',
  'export type CardSyncBlock = keyof typeof CARD_SYNC_BLOCKS;',
  '',
  'export const CARD_SYNC_QUERIES = {',
  ...[...queries].map(([name, sql]) => `  '${name}': ${literal(sql)},`),
  '} as const;',
  '',
  'export type CardSyncQueryName = keyof typeof CARD_SYNC_QUERIES;',
  '',
].join('\n');

const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/api/src/services/cardSyncSchemaSql.ts');
if (check) {
  const same = fs.existsSync(target) && fs.readFileSync(target, 'utf8') === out;
  console.log(`${path.relative(process.cwd(), target)} ${same ? 'is' : 'is NOT'} the SQL of revision ${revision} (sha256 ${sha256})`);
  process.exit(same ? 0 : 1);
}
fs.writeFileSync(target, out);
console.log(`wrote ${path.relative(process.cwd(), target)}: revision ${revision}, ${blocks.size} sections, ${queries.size} statements`);
