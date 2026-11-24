import type Database from 'better-sqlite3';

/**
 * Every table of a database by name, with its row count. A backup better-sqlite3 left empty passes integrity_check,
 * quick_check and a check that some table is absent (its online backup takes a first busy step as done: the backup
 * sweep, 11/09); it matches its source here only when the source has no table at all.
 */
export function tablesAndCounts(db: Database.Database): Array<[string, number]> {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all() as string[];
  return names.map((name): [string, number] =>
    [name, db.prepare(`SELECT count(*) FROM "${name.replaceAll('"', '""')}"`).pluck().get() as number]);
}
