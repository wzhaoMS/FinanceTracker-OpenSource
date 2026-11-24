import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

type RawDb = Database.Database;

type Row = Record<string, unknown>;

const GUARD = /^trg_card\w*_guard_(insert|update)$/;

const show = (value: unknown) => (value === null || value === undefined ? 'NULL' : String(value));

/**
 * The card schema as design §3.6 defines its golden file
 * (`services/__fixtures__/card-schema-v15.sql`): every card object in
 * sqlite_master sorted by type and name, then per card table its
 * `table_xinfo`, `foreign_key_list`, `index_list` (by name) and each index's
 * `index_xinfo`, then `user_version`. Fresh and upgraded databases must
 * produce the same text. The 62 generated guard triggers (about 1.5 MB of
 * SQL) appear as the SHA-256 of their text: any difference still shows, and
 * the guard tripwire in sqliteStateRepo.test.ts pins the text itself.
 */
export function cardSchemaDump(db: RawDb): string {
  const lines = [
    '-- Holdr card schema (E1b design §3.6 golden file): every card object in sqlite_master by type and name, then per card',
    '-- table its table_xinfo, foreign_key_list, index_list and index_xinfo, then user_version. Fresh and upgraded databases',
    '-- must dump exactly this. Regenerate with `npx vitest run src/services/sqliteStateRepo.cardSync.test.ts -u`, and review.',
    '-- Guard triggers (generated, pinned by the guard tripwire) appear as the SHA-256 of their SQL.',
    '',
  ];
  const objects = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE tbl_name LIKE 'card\\_%' ESCAPE '\\' ORDER BY type, name`).all() as Array<{
    type: string; name: string; tbl_name: string; sql: string | null;
  }>;
  for (const object of objects) {
    lines.push(`-- ${object.type} ${object.name} on ${object.tbl_name}`);
    if (object.sql === null) lines.push('-- (created by SQLite)');
    else if (object.type === 'trigger' && GUARD.test(object.name)) {
      lines.push(`-- guard: sha256 ${createHash('sha256').update(object.sql).digest('hex')}`);
    } else lines.push(`${object.sql};`);
    lines.push('');
  }
  const pragma = (sql: string) => db.prepare(sql).all() as Row[];
  for (const { name: table } of objects.filter((object) => object.type === 'table')) {
    lines.push(`-- ${table}: table_xinfo (cid|name|type|notnull|dflt_value|pk|hidden)`);
    for (const c of pragma(`PRAGMA table_xinfo(${table})`)) {
      lines.push(`--   ${[c.cid, c.name, c.type, c.notnull, show(c.dflt_value), c.pk, c.hidden].join('|')}`);
    }
    lines.push(`-- ${table}: foreign_key_list (id|seq|table|from|to|on_update|on_delete|match)`);
    for (const f of pragma(`PRAGMA foreign_key_list(${table})`)) {
      lines.push(`--   ${[f.id, f.seq, f.table, f.from, show(f.to), f.on_update, f.on_delete, f.match].join('|')}`);
    }
    lines.push(`-- ${table}: index_list (name|unique|origin|partial), then each index's index_xinfo (seqno|cid|name|desc|coll|key)`);
    const indexes = pragma(`PRAGMA index_list(${table})`).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const index of indexes) {
      lines.push(`--   ${[index.name, index.unique, index.origin, index.partial].join('|')}`);
      for (const k of pragma(`PRAGMA index_xinfo(${JSON.stringify(index.name)})`)) {
        lines.push(`--     ${[k.seqno, k.cid, show(k.name), k.desc, k.coll, k.key].join('|')}`);
      }
    }
    lines.push('');
  }
  lines.push(`-- user_version ${show(db.pragma('user_version', { simple: true }))}`);
  return `${lines.join('\n')}\n`;
}
