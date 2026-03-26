import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { runMigrations } from './migrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.TTP_DB_PATH || path.join(__dirname, '..', 'timetoprod.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables(db);

    // Run pending migrations
    if (dbPath !== ':memory:') {
      const { applied, current } = runMigrations(db);
      if (applied.length > 0) {
        console.log(`Migrations applied: ${applied.join(', ')} (now at V${String(current).padStart(3, '0')})`);
      }
    }
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
      ttp_estimate_used      INTEGER,
      estimated_minutes      REAL,
      estimated_cost_usd     REAL,
      success                INTEGER NOT NULL,
      human_review_required  INTEGER NOT NULL,
      failure_reason         TEXT,
      outlier_flagged        INTEGER DEFAULT 0,

      -- Task definition: what the agent set out to do
      task_goal              TEXT,
      task_acceptance         TEXT,
      task_repo              TEXT,
      task_branch            TEXT,
      task_pr_url            TEXT,
      task_commit_shas       TEXT,

      -- Deliverables: what was actually produced
      deliverables_json      TEXT,
      files_changed          INTEGER,
      lines_added            INTEGER,
      lines_removed          INTEGER,
      tests_added            INTEGER,
      tests_passed           INTEGER,
      tests_failed           INTEGER,

      -- Time breakdown
      planning_minutes       REAL,
      coding_minutes         REAL,
      testing_minutes        REAL,
      debugging_minutes      REAL,
      review_minutes         REAL,

      -- Code quality
      code_quality_index     INTEGER,
      code_quality_breakdown TEXT
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

    -- Registered agents
    CREATE TABLE IF NOT EXISTS agents (
      username       TEXT PRIMARY KEY,
      ip_hash        TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      last_seen_at   TEXT NOT NULL,
      tasks_started  INTEGER DEFAULT 0,
      tasks_done     INTEGER DEFAULT 0,
      model          TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agents_ip ON agents(ip_hash);

    -- Active tasks: started but not yet finished
    CREATE TABLE IF NOT EXISTS active_tasks (
      task_id        TEXT PRIMARY KEY,
      agent_id       TEXT NOT NULL,
      started_at     TEXT NOT NULL,
      goal           TEXT NOT NULL,
      task_type      TEXT NOT NULL,
      ai_suitability INTEGER NOT NULL,
      model          TEXT,
      meta_json      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_active_agent ON active_tasks(agent_id);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined!;
  }
}
