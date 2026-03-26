import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

function ensureMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    )
  `);
}

function getAppliedVersions(db: Database.Database): Set<number> {
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as any[];
  return new Set(rows.map(r => r.version));
}

function loadMigrations(): Migration[] {
  const migrationsDir = path.join(__dirname, 'migrations');
  let files: string[];
  try {
    files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }

  return files.map(file => {
    // Expected format: V001__description.sql
    const match = file.match(/^V(\d+)__(.+)\.sql$/);
    if (!match) throw new Error(`Invalid migration filename: ${file}. Expected V001__description.sql`);
    return {
      version: parseInt(match[1], 10),
      name: match[2].replace(/_/g, ' '),
      sql: readFileSync(path.join(migrationsDir, file), 'utf-8'),
    };
  });
}

export function runMigrations(db: Database.Database): { applied: string[]; current: number } {
  ensureMigrationTable(db);
  const applied = getAppliedVersions(db);
  const migrations = loadMigrations();
  const newlyApplied: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(migration.version, migration.name, new Date().toISOString());
    })();

    newlyApplied.push(`V${String(migration.version).padStart(3, '0')}: ${migration.name}`);
  }

  const current = migrations.length > 0
    ? Math.max(...migrations.map(m => m.version))
    : 0;

  return { applied: newlyApplied, current };
}

export function getMigrationStatus(db: Database.Database): {
  current_version: number;
  pending: number;
  applied: Array<{ version: number; name: string; applied_at: string }>;
} {
  ensureMigrationTable(db);
  const appliedVersions = getAppliedVersions(db);
  const migrations = loadMigrations();
  const pending = migrations.filter(m => !appliedVersions.has(m.version)).length;

  const appliedRows = db.prepare(
    'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
  ).all() as any[];

  return {
    current_version: appliedRows.length > 0 ? appliedRows[appliedRows.length - 1].version : 0,
    pending,
    applied: appliedRows,
  };
}
