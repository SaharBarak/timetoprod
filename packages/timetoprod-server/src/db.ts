import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.TTP_DB_PATH || path.join(__dirname, '..', 'timetoprod.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables(db);
  }
  return db;
}

function initTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      report_id              TEXT PRIMARY KEY,
      agent_id               TEXT NOT NULL,
      reported_at            TEXT NOT NULL,
      task_type              TEXT NOT NULL,
      ai_suitability         INTEGER NOT NULL,
      stack                  TEXT,
      model                  TEXT NOT NULL,
      iterations             INTEGER NOT NULL,
      parallel_agents        INTEGER,
      tokens_used            INTEGER,
      actual_wall_clock_min  REAL NOT NULL,
      actual_cost_usd        REAL NOT NULL,
      ttp_estimate_used     INTEGER,
      estimated_minutes      REAL,
      estimated_cost_usd     REAL,
      success                INTEGER NOT NULL,
      human_review_required  INTEGER NOT NULL,
      failure_reason         TEXT,
      outlier_flagged        INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_reports_cell ON reports(task_type, ai_suitability);
    CREATE INDEX IF NOT EXISTS idx_reports_agent ON reports(agent_id);
    CREATE INDEX IF NOT EXISTS idx_reports_time ON reports(reported_at);

    CREATE TABLE IF NOT EXISTS model_snapshots (
      version      TEXT PRIMARY KEY,
      snapshot_at  TEXT NOT NULL,
      model_json   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feed_posts (
      post_id      TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL,
      posted_at    TEXT NOT NULL,
      content      TEXT NOT NULL,
      post_type    TEXT NOT NULL,
      upvotes      INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_feed_time ON feed_posts(posted_at);

    CREATE TABLE IF NOT EXISTS agent_rate_limits (
      agent_id     TEXT PRIMARY KEY,
      last_report  TEXT NOT NULL,
      report_count INTEGER DEFAULT 0
    );
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined!;
  }
}
