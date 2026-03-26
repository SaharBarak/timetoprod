-- V001: Baseline schema
-- This migration represents the initial schema. On fresh databases the tables
-- are created by db.ts initTables(). This migration exists so the version
-- tracking starts at 1 and future migrations have a reference point.
-- It is safe to run on databases that already have these tables (IF NOT EXISTS).

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
  task_goal              TEXT,
  task_acceptance        TEXT,
  task_repo              TEXT,
  task_branch            TEXT,
  task_pr_url            TEXT,
  task_commit_shas       TEXT,
  deliverables_json      TEXT,
  files_changed          INTEGER,
  lines_added            INTEGER,
  lines_removed          INTEGER,
  tests_added            INTEGER,
  tests_passed           INTEGER,
  tests_failed           INTEGER,
  planning_minutes       REAL,
  coding_minutes         REAL,
  testing_minutes        REAL,
  debugging_minutes      REAL,
  review_minutes         REAL
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
