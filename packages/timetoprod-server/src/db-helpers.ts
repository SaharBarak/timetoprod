import { getDb } from './db.js';
import { v4 as uuidv4 } from 'uuid';
import type { TaskReport, CalibrationModel } from './schema.js';

// Insert a task report
export function insertReport(report: TaskReport): { report_id: string; reported_at: string } {
  const db = getDb();
  const report_id = uuidv4();
  const reported_at = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO reports (
      report_id, agent_id, reported_at, task_type, ai_suitability,
      stack, model, iterations, parallel_agents, tokens_used,
      actual_wall_clock_min, actual_cost_usd, ttp_estimate_used,
      estimated_minutes, estimated_cost_usd, success,
      human_review_required, failure_reason, outlier_flagged
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `);

  stmt.run(
    report_id,
    report.agent_id,
    reported_at,
    report.task_type,
    report.ai_suitability,
    report.stack ? JSON.stringify(report.stack) : null,
    report.model,
    report.iterations,
    report.parallel_agents ?? null,
    report.tokens_used ?? null,
    report.actual_wall_clock_minutes,
    report.actual_cost_usd,
    report.ttp_estimate_used ? 1 : 0,
    report.estimated_wall_clock_minutes ?? null,
    report.estimated_cost_usd ?? null,
    report.success ? 1 : 0,
    report.human_review_required ? 1 : 0,
    report.failure_reason ?? null,
    0
  );

  return { report_id, reported_at };
}

// Flag a report as outlier
export function flagReportAsOutlier(report_id: string): void {
  const db = getDb();
  db.prepare('UPDATE reports SET outlier_flagged = 1 WHERE report_id = ?').run(report_id);
}

// Get reports for a specific cell (non-outlier only)
export function getCellReports(task_type: string, ai_suitability: number): Array<{
  actual_wall_clock_min: number;
  actual_cost_usd: number;
  success: number;
  human_review_required: number;
  model: string;
  stack: string | null;
  reported_at: string;
}> {
  const db = getDb();
  return db.prepare(`
    SELECT actual_wall_clock_min, actual_cost_usd, success, human_review_required, model, stack, reported_at
    FROM reports
    WHERE task_type = ? AND ai_suitability = ? AND outlier_flagged = 0
    ORDER BY reported_at DESC
  `).all(task_type, ai_suitability) as any[];
}

// Get total report count
export function getTotalReportCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM reports WHERE outlier_flagged = 0').get() as any;
  return row.count;
}

// Get reports in the last hour
export function getReportsLastHour(): number {
  const db = getDb();
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
  const row = db.prepare('SELECT COUNT(*) as count FROM reports WHERE reported_at > ?').get(oneHourAgo) as any;
  return row.count;
}

// Save model snapshot
export function saveModelSnapshot(version: string, model: CalibrationModel): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO model_snapshots (version, snapshot_at, model_json)
    VALUES (?, ?, ?)
  `).run(version, new Date().toISOString(), JSON.stringify(model));
}

// Get latest model snapshot
export function getLatestModelSnapshot(): CalibrationModel | null {
  const db = getDb();
  const row = db.prepare('SELECT model_json FROM model_snapshots ORDER BY snapshot_at DESC LIMIT 1').get() as any;
  return row ? JSON.parse(row.model_json) : null;
}

// Get model snapshot by version
export function getModelSnapshotByVersion(version: string): CalibrationModel | null {
  const db = getDb();
  const row = db.prepare('SELECT model_json FROM model_snapshots WHERE version = ?').get(version) as any;
  return row ? JSON.parse(row.model_json) : null;
}

// Rate limiting
export function checkAndUpdateRateLimit(agent_id: string, windowMinutes: number = 10): boolean {
  const db = getDb();
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMinutes * 60000).toISOString();

  const existing = db.prepare('SELECT last_report, report_count FROM agent_rate_limits WHERE agent_id = ?').get(agent_id) as any;

  if (existing && existing.last_report > windowStart) {
    return false; // Rate limited
  }

  db.prepare(`
    INSERT INTO agent_rate_limits (agent_id, last_report, report_count)
    VALUES (?, ?, 1)
    ON CONFLICT(agent_id) DO UPDATE SET last_report = ?, report_count = report_count + 1
  `).run(agent_id, now.toISOString(), now.toISOString());

  return true; // Allowed
}

// Feed posts
export function insertFeedPost(agent_id: string, content: string, post_type: string): string {
  const db = getDb();
  const post_id = uuidv4();
  const posted_at = new Date().toISOString();

  db.prepare(`
    INSERT INTO feed_posts (post_id, agent_id, posted_at, content, post_type)
    VALUES (?, ?, ?, ?, ?)
  `).run(post_id, agent_id, posted_at, content, post_type);

  return post_id;
}

export function getFeedPosts(limit: number = 20, before?: string, type?: string): any[] {
  const db = getDb();
  let query = 'SELECT * FROM feed_posts WHERE 1=1';
  const params: any[] = [];

  if (before) {
    query += ' AND posted_at < ?';
    params.push(before);
  }
  if (type) {
    query += ' AND post_type = ?';
    params.push(type);
  }

  query += ' ORDER BY posted_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params);
}

export function upvoteFeedPost(post_id: string): void {
  const db = getDb();
  db.prepare('UPDATE feed_posts SET upvotes = upvotes + 1 WHERE post_id = ?').run(post_id);
}

// Get recent reports for the live feed
export function getRecentReports(limit: number = 50): any[] {
  const db = getDb();
  return db.prepare(`
    SELECT report_id, task_type, ai_suitability, actual_wall_clock_min, actual_cost_usd,
           model, stack, success, reported_at
    FROM reports
    WHERE outlier_flagged = 0
    ORDER BY reported_at DESC
    LIMIT ?
  `).all(limit);
}

// Get all distinct cells that have data
export function getAllCellData(): Array<{ task_type: string; ai_suitability: number }> {
  const db = getDb();
  return db.prepare(`
    SELECT DISTINCT task_type, ai_suitability
    FROM reports
    WHERE outlier_flagged = 0
  `).all() as any[];
}
