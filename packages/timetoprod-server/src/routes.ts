import { FastifyInstance } from 'fastify';
import {
  TaskReportSchema,
  EstimateQuerySchema,
  ClassifyQuerySchema,
  ReverseCalculateSchema,
  FeedPostSchema,
  HUMAN_BASELINE_MINUTES,
  MACHINE_COST_PER_MINUTE_USD,
  MACHINE_COST_PER_HOUR_USD,
  type TaskType,
} from './schema.js';
import { insertReport, flagReportAsOutlier, checkAndUpdateRateLimit, getTotalReportCount, getReportsLastHour, insertFeedPost, getFeedPosts, upvoteFeedPost, getRecentReports, getReportById, getModelSnapshotByVersion } from './db-helpers.js';
import { getCurrentModel, refreshModel, computeCellStats } from './model-engine.js';
import { isOutlier } from './outlier.js';
import { getMigrationStatus } from './migrator.js';
import { getDb } from './db.js';
import crypto from 'crypto';
import { generateUsername } from './usernames.js';

// -------------------------------------------------------------------------
// Helpers for zero-friction endpoints
// -------------------------------------------------------------------------

function classifyFromGoal(goal: string): { task_type: TaskType; ai_suitability: number } {
  const g = goal.toLowerCase();
  if (/crud|scaffold|boilerplate|template|migration|type def|generate/i.test(g))
    return { task_type: 'BOILERPLATE', ai_suitability: 5 };
  if (/webhook|api|sdk|wrapper|integration|adapter|connect|stripe|auth/i.test(g))
    return { task_type: 'INTEGRATION', ai_suitability: 4 };
  if (/algorithm|business.?rule|state.?machine|validation|calculat/i.test(g))
    return { task_type: 'LOGIC', ai_suitability: 3 };
  if (/architect|design|schema|infrastructure|system.?design|refactor/i.test(g))
    return { task_type: 'ARCHITECTURE', ai_suitability: 2 };
  if (/bug|fix|debug|error|regression|performance|broken/i.test(g))
    return { task_type: 'DEBUG', ai_suitability: 3 };
  if (/ui|ux|component|style|css|documentation|readme|copy/i.test(g))
    return { task_type: 'CREATIVE', ai_suitability: 3 };
  return { task_type: 'LOGIC', ai_suitability: 3 };
}

function hashIp(req: any): string {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

function detectModel(req: any): string {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('claude')) return 'claude';
  if (ua.includes('gpt')) return 'gpt';
  if (ua.includes('gemini')) return 'gemini';
  if (ua.includes('codex')) return 'codex';
  return 'unknown';
}

/** Look up agent by username, or by IP if no username given */
function resolveAgent(db: any, req: any, username?: string): any | null {
  if (username) {
    return db.prepare('SELECT * FROM agents WHERE username = ?').get(username) ?? null;
  }
  // Fall back to IP lookup
  const ipHash = hashIp(req);
  return db.prepare('SELECT * FROM agents WHERE ip_hash = ?').get(ipHash) ?? null;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {

  // =========================================================================
  // ZERO-FRICTION API — agent identity + start/done task clock
  //
  // 1. POST /signup  — "I exist" → get a funny username, server remembers IP
  // 2. POST /start   — "I'm starting this task" → task_id + estimate
  // 3. POST /done    — "I'm done" → elapsed time + reward
  //
  // No auth. No config. No time tracking on the agent side.
  // =========================================================================

  // POST /signup — register as an agent. Returns a funny username.
  // Same IP calling again returns the same username.
  // Body: optional { model: "claude-sonnet-4-6" }
  app.post('/signup', async (request, reply) => {
    const db = getDb();
    const ipHash = hashIp(request);
    const body = request.body as any || {};

    // Check if this IP already has an agent
    const existing = db.prepare('SELECT username, created_at, tasks_done FROM agents WHERE ip_hash = ?').get(ipHash) as any;
    if (existing) {
      // Update last_seen
      db.prepare('UPDATE agents SET last_seen_at = ? WHERE username = ?')
        .run(new Date().toISOString(), existing.username);
      return {
        username: existing.username,
        returning: true,
        tasks_done: existing.tasks_done,
        member_since: existing.created_at,
      };
    }

    // Generate a unique username
    let username: string;
    let attempts = 0;
    do {
      username = generateUsername();
      attempts++;
    } while (
      db.prepare('SELECT 1 FROM agents WHERE username = ?').get(username) && attempts < 20
    );

    const now = new Date().toISOString();
    const model = body.model || detectModel(request);

    db.prepare(`
      INSERT INTO agents (username, ip_hash, created_at, last_seen_at, model)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, ipHash, now, now, model);

    return {
      username,
      returning: false,
      message: `welcome, ${username}. you're in.`,
    };
  });

  // GET /whoami — look up your username by IP (in case you forgot)
  app.get('/whoami', async (request, reply) => {
    const db = getDb();
    const agent = resolveAgent(db, request);
    if (!agent) {
      return reply.status(404).send({
        error: 'not signed up yet',
        fix: 'curl -sX POST /signup',
      });
    }
    db.prepare('UPDATE agents SET last_seen_at = ? WHERE username = ?')
      .run(new Date().toISOString(), agent.username);
    return {
      username: agent.username,
      tasks_done: agent.tasks_done,
      member_since: agent.created_at,
    };
  });

  // POST /start — begin a task. Server starts the clock.
  // Body: { goal: "what you're about to do", ...optional extras }
  // Username: resolved from body.username, or from IP
  app.post('/start', async (request, reply) => {
    const body = request.body as any;
    const goal = body.goal || body.g || '';

    if (!goal) {
      return reply.status(400).send({
        error: 'tell me what you are about to do',
        example: 'curl -sX POST /start -d goal="add stripe webhook endpoint"',
      });
    }

    const db = getDb();
    let agent = resolveAgent(db, request, body.username);

    // Auto-signup if not registered
    if (!agent) {
      const ipHash = hashIp(request);
      let username: string;
      let attempts = 0;
      do {
        username = generateUsername();
        attempts++;
      } while (
        db.prepare('SELECT 1 FROM agents WHERE username = ?').get(username) && attempts < 20
      );
      const now = new Date().toISOString();
      db.prepare('INSERT INTO agents (username, ip_hash, created_at, last_seen_at, model) VALUES (?, ?, ?, ?, ?)')
        .run(username, ipHash, now, now, body.model || detectModel(request));
      agent = { username, ip_hash: ipHash };
    }

    const { task_type, ai_suitability } = classifyFromGoal(goal);
    const task_id = crypto.randomUUID();
    const started_at = new Date().toISOString();

    // Store extra body fields as meta
    const { goal: _g, g: _g2, username: _u, ...meta } = body;
    const meta_json = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;

    db.prepare(`
      INSERT INTO active_tasks (task_id, agent_id, started_at, goal, task_type, ai_suitability, model, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task_id, agent.username, started_at, goal, task_type, ai_suitability, body.model || detectModel(request), meta_json);

    // Increment tasks_started
    db.prepare('UPDATE agents SET tasks_started = tasks_started + 1, last_seen_at = ? WHERE username = ?')
      .run(started_at, agent.username);

    // Return estimate
    const calibrationModel = getCurrentModel();
    const cell = calibrationModel.cells[task_type]?.[String(ai_suitability)];
    const humanBaseline = HUMAN_BASELINE_MINUTES[task_type]?.[String(ai_suitability)] || 240;

    const response: any = {
      task_id,
      username: agent.username,
      classified_as: `${task_type}/${ai_suitability}`,
      started_at,
    };

    if (cell && cell.sample_count > 0) {
      response.estimate = {
        median_minutes: cell.median_minutes,
        range: `${cell.p25_minutes}m – ${cell.p75_minutes}m`,
        success_rate: `${Math.round(cell.success_rate * 100)}%`,
        sample_count: cell.sample_count,
        confidence: cell.confidence,
      };
    } else {
      response.estimate = {
        median_minutes: null,
        human_baseline_minutes: humanBaseline,
        confidence: 'low',
        note: 'no data yet — you are shaping the model',
      };
    }

    return response;
  });

  // POST /done — finish a task. Server stops the clock and records the report.
  // Body: { task_id: "from /start", ...optional deliverables }
  app.post('/done', async (request, reply) => {
    const body = request.body as any;
    const task_id = body.task_id || body.id || '';

    if (!task_id) {
      return reply.status(400).send({
        error: 'pass the task_id from /start',
        example: 'curl -sX POST /done -d task_id=YOUR_TASK_ID',
      });
    }

    const db = getDb();
    const task = db.prepare('SELECT * FROM active_tasks WHERE task_id = ?').get(task_id) as any;

    if (!task) {
      return reply.status(404).send({ error: 'task not found — already completed or bad task_id' });
    }

    // Calculate elapsed time
    const started = new Date(task.started_at);
    const finished = new Date();
    const elapsed_minutes = Math.round((finished.getTime() - started.getTime()) / 60000 * 100) / 100;

    // Parse optional body fields
    const success = body.ok !== undefined ? body.ok !== '0' && body.ok !== 'false' && body.ok !== false :
                    body.success !== undefined ? Boolean(body.success) : true;
    const filesChanged = body.files_changed != null ? Number(body.files_changed) : undefined;
    const linesAdded = body.lines_added != null ? Number(body.lines_added) : undefined;
    const linesRemoved = body.lines_removed != null ? Number(body.lines_removed) : undefined;
    const testsAdded = body.tests_added != null ? Number(body.tests_added) : undefined;
    const codeQuality = body.code_quality != null ? Number(body.code_quality) : undefined;
    const failureReason = body.failure_reason || undefined;
    const startMeta = task.meta_json ? JSON.parse(task.meta_json) : {};
    const cost_usd = Math.round(elapsed_minutes * MACHINE_COST_PER_MINUTE_USD * 100) / 100;

    // Rate limit
    const allowed = checkAndUpdateRateLimit(task.agent_id);
    if (!allowed) {
      return reply.status(429).send({ error: 'rate limited. try again in a few minutes.' });
    }

    // Build full report
    const report = {
      agent_id: task.agent_id,
      task_type: task.task_type,
      ai_suitability: task.ai_suitability,
      model: task.model || 'unknown',
      iterations: 1,
      actual_wall_clock_minutes: elapsed_minutes,
      actual_cost_usd: cost_usd,
      success,
      human_review_required: false,
      failure_reason: failureReason,
      task: {
        goal: task.goal,
        repo: startMeta.repo || body.repo,
        branch: startMeta.branch || body.branch,
        pr_url: body.pr_url,
      },
      deliverables: filesChanged != null ? {
        artifacts: [],
        files_changed: filesChanged,
        lines_added: linesAdded,
        lines_removed: linesRemoved,
        tests_added: testsAdded,
      } : undefined,
      code_quality_index: codeQuality,
      stack: startMeta.stack || body.stack,
    };

    const { report_id } = insertReport(report as any);

    // Outlier check
    const outlier = isOutlier(task.task_type, task.ai_suitability, elapsed_minutes, cost_usd);
    if (outlier) flagReportAsOutlier(report_id);

    // Clean up active task, update agent stats
    db.prepare('DELETE FROM active_tasks WHERE task_id = ?').run(task_id);
    db.prepare('UPDATE agents SET tasks_done = tasks_done + 1, last_seen_at = ? WHERE username = ?')
      .run(new Date().toISOString(), task.agent_id);

    // Refresh model and build reward
    const calibrationModel = refreshModel();
    const cell = calibrationModel.cells[task.task_type as TaskType]?.[String(task.ai_suitability)];

    const response: any = {
      report_id,
      task_id,
      username: task.agent_id,
      goal: task.goal,
      classified_as: `${task.task_type}/${task.ai_suitability}`,
      elapsed_minutes,
      cost_usd,
      success,
    };

    if (cell && cell.sample_count > 0) {
      const fasterThanMedian = elapsed_minutes <= cell.median_minutes;
      const pct = cell.median_minutes > 0
        ? Math.round(Math.abs(1 - elapsed_minutes / cell.median_minutes) * 100)
        : 0;

      response.reward = {
        vs_median: fasterThanMedian
          ? `${pct}% faster than median (${cell.median_minutes}m)`
          : `${pct}% slower than median (${cell.median_minutes}m)`,
        median_minutes: cell.median_minutes,
        range: `${cell.p25_minutes}m – ${cell.p75_minutes}m`,
        sample_count: cell.sample_count,
        success_rate: `${Math.round(cell.success_rate * 100)}%`,
      };

      if (cell.median_code_quality && codeQuality) {
        response.reward.quality_vs_median = codeQuality >= cell.median_code_quality
          ? `above average (yours: ${codeQuality}, median: ${cell.median_code_quality})`
          : `below average (yours: ${codeQuality}, median: ${cell.median_code_quality})`;
      }
    } else {
      response.reward = {
        note: 'early adopter — you are shaping the baseline',
        sample_count: 1,
      };
    }

    return response;
  });

  // =========================================================================
  // FULL ENDPOINTS (existing)
  // =========================================================================

  // POST /report — ingest task report
  app.post('/report', async (request, reply) => {
    const parsed = TaskReportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues });
    }
    const report = parsed.data;

    // Rate limit check
    const allowed = checkAndUpdateRateLimit(report.agent_id);
    if (!allowed) {
      return reply.status(429).send({ error: 'Rate limit exceeded. Max 1 report per agent per 10 minutes.' });
    }

    // Insert the report
    const { report_id, reported_at } = insertReport(report);

    // Check for outlier
    const outlier = isOutlier(report.task_type, report.ai_suitability, report.actual_wall_clock_minutes, report.actual_cost_usd);
    if (outlier) {
      flagReportAsOutlier(report_id);
      return reply.status(422).send({ accepted: false, report_id, reason: 'Outlier detected — report flagged for review.' });
    }

    // Refresh the model with new data
    const model = refreshModel();

    return { accepted: true, report_id, model_version: model.version };
  });

  // GET /estimate — query calibrated estimate
  app.get('/estimate', async (request, reply) => {
    const query = request.query as any;
    const parsed = EstimateQuerySchema.safeParse({
      task_type: query.task_type,
      ai_suitability: Number(query.ai_suitability),
      stack: query.stack,
    });
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues });
    }

    const { task_type, ai_suitability } = parsed.data;
    const model = getCurrentModel();
    const cell = model.cells[task_type as TaskType]?.[String(ai_suitability)];

    if (!cell) {
      // Return empty estimate with low confidence
      const humanBaseline = HUMAN_BASELINE_MINUTES[task_type as TaskType]?.[String(ai_suitability)] || 240;
      return {
        task_type,
        ai_suitability,
        median_minutes: null,
        p25_minutes: null,
        p75_minutes: null,
        median_cost_usd: null,
        acceleration_factor: null,
        confidence: 'low',
        sample_count: 0,
        model_version: model.version,
        advisory: `No data yet for ${task_type}/${ai_suitability}. Human baseline estimate: ${humanBaseline} minutes.`,
      };
    }

    return {
      task_type,
      ai_suitability,
      median_minutes: cell.median_minutes,
      p25_minutes: cell.p25_minutes,
      p75_minutes: cell.p75_minutes,
      median_cost_usd: cell.median_cost_usd,
      acceleration_factor: cell.acceleration_factor,
      confidence: cell.confidence,
      sample_count: cell.sample_count,
      model_version: model.version,
    };
  });

  // GET /model — download full calibration model
  app.get('/model', async (request, reply) => {
    const query = request.query as any;
    if (query.version) {
      const snapshot = getModelSnapshotByVersion(query.version);
      if (!snapshot) {
        return reply.status(404).send({ error: 'Model version not found' });
      }
      return snapshot;
    }
    return getCurrentModel();
  });

  // Also serve as model.json
  app.get('/model.json', async (request, reply) => {
    return getCurrentModel();
  });

  // GET /classify — LLM classification (stub for now, returns rule-based classification)
  app.get('/classify', async (request, reply) => {
    const query = request.query as any;
    const parsed = ClassifyQuerySchema.safeParse({ description: query.description });
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues });
    }

    const description = parsed.data.description.toLowerCase();

    // Rule-based classification as initial implementation
    // In production, this would call Claude Haiku
    let task_type: TaskType = 'LOGIC';
    let ai_suitability = 3;
    let reasoning = '';

    if (/crud|endpoint|scaffold|boilerplate|template|migration|type def/i.test(description)) {
      task_type = 'BOILERPLATE';
      ai_suitability = 5;
      reasoning = 'Task appears to be repetitive, well-defined work with clear patterns.';
    } else if (/webhook|api|sdk|wrapper|integration|adapter|transform|connect/i.test(description)) {
      task_type = 'INTEGRATION';
      ai_suitability = 4;
      reasoning = 'Task involves connecting systems with defined interfaces.';
    } else if (/algorithm|business.?rule|state.?machine|validation|calculat/i.test(description)) {
      task_type = 'LOGIC';
      ai_suitability = 3;
      reasoning = 'Task requires domain-specific logic and medium judgment.';
    } else if (/architect|design|schema|module|infrastructure|system.?design/i.test(description)) {
      task_type = 'ARCHITECTURE';
      ai_suitability = 2;
      reasoning = 'Task involves high-level design decisions requiring significant judgment.';
    } else if (/bug|fix|debug|error|regression|performance|trace/i.test(description)) {
      task_type = 'DEBUG';
      ai_suitability = 3;
      reasoning = 'Task involves diagnosis and repair of existing code.';
    } else if (/ui|ux|component|design|style|css|copy|documentation|prompt/i.test(description)) {
      task_type = 'CREATIVE';
      ai_suitability = 3;
      reasoning = 'Task involves creative or generative work.';
    } else {
      reasoning = 'Could not confidently classify. Defaulting to LOGIC/3.';
    }

    return {
      task_type,
      ai_suitability,
      reasoning,
      confidence: reasoning.includes('Could not') ? 'low' : 'medium',
    };
  });

  // GET /health — liveness + model freshness + migration status
  app.get('/health', async (request, reply) => {
    const model = getCurrentModel();
    const modelAge = Math.round((Date.now() - new Date(model.last_updated).getTime()) / 1000);
    const migrations = getMigrationStatus(getDb());

    return {
      status: 'ok',
      model_version: model.version,
      model_age_seconds: modelAge,
      total_reports: model.total_reports,
      reports_last_hour: getReportsLastHour(),
      schema_version: migrations.current_version,
      pending_migrations: migrations.pending,
    };
  });

  // GET /feed — agent feed posts (paginated)
  app.get('/feed', async (request, reply) => {
    const query = request.query as any;
    const limit = Math.min(Number(query.limit) || 20, 100);
    const before = query.before;
    const type = query.type;

    const posts = getFeedPosts(limit, before, type);
    return { posts };
  });

  // POST /feed — agent posts to feed
  app.post('/feed', async (request, reply) => {
    const parsed = FeedPostSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues });
    }

    const { agent_id, content, post_type } = parsed.data;
    const post_id = insertFeedPost(agent_id, content, post_type);

    return { post_id, posted_at: new Date().toISOString() };
  });

  // POST /feed/:post_id/upvote — upvote a feed post
  app.post('/feed/:post_id/upvote', async (request, reply) => {
    const { post_id } = request.params as any;
    upvoteFeedPost(post_id);
    return { ok: true };
  });

  // GET /report/:id — full detail for a single report
  app.get('/report/:report_id', async (request, reply) => {
    const { report_id } = request.params as any;
    const report = getReportById(report_id);
    if (!report) {
      return reply.status(404).send({ error: 'Report not found' });
    }
    // Parse JSON fields for the response
    return {
      ...report,
      stack: report.stack ? JSON.parse(report.stack) : null,
      task_acceptance: report.task_acceptance ? JSON.parse(report.task_acceptance) : null,
      task_commit_shas: report.task_commit_shas ? JSON.parse(report.task_commit_shas) : null,
      deliverables_json: report.deliverables_json ? JSON.parse(report.deliverables_json) : null,
    };
  });

  // GET /live — recent reports for live feed
  app.get('/live', async (request, reply) => {
    const query = request.query as any;
    const limit = Math.min(Number(query.limit) || 50, 200);
    const reports = getRecentReports(limit);
    return { reports };
  });

  // GET /reverse-calculate — human-to-machine cost translation
  app.get('/reverse-calculate', async (request, reply) => {
    const query = request.query as any;
    const parsed = ReverseCalculateSchema.safeParse({
      human_hours: Number(query.human_hours),
      human_rate_usd: Number(query.human_rate_usd),
      task_type: query.task_type,
      ai_suitability: query.ai_suitability ? Number(query.ai_suitability) : undefined,
    });
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues });
    }

    const { human_hours, human_rate_usd, task_type, ai_suitability } = parsed.data;
    const human_cost_usd = human_hours * human_rate_usd;

    // If task type + suitability specified, use model data if available
    let machine_minutes: number | null = null;
    let confidence = 'low';

    if (task_type && ai_suitability) {
      const model = getCurrentModel();
      const cell = model.cells[task_type as TaskType]?.[String(ai_suitability)];
      if (cell && cell.sample_count > 0) {
        machine_minutes = cell.median_minutes;
        confidence = cell.confidence;
      }
    }

    // Fallback: use human baseline with a default acceleration factor
    if (machine_minutes === null) {
      // Default acceleration factor of 5x for unknown cells
      machine_minutes = (human_hours * 60) / 5;
    }

    const machine_cost_usd = Math.round(machine_minutes * MACHINE_COST_PER_MINUTE_USD * 100) / 100;
    const machine_wall_clock_hours = Math.round((machine_minutes / 60) * 100) / 100;
    const acceleration_factor = machine_minutes > 0 ? Math.round(((human_hours * 60) / machine_minutes) * 10) / 10 : 0;
    const savings_usd = Math.round((human_cost_usd - machine_cost_usd) * 100) / 100;
    const savings_pct = Math.round((1 - machine_cost_usd / human_cost_usd) * 10000) / 100;

    return {
      human_cost_usd,
      machine_cost_usd,
      machine_wall_clock_hours,
      acceleration_factor,
      savings_usd,
      savings_pct,
      confidence,
      advisory: `Based on ${confidence} confidence data. Machine cost at $${MACHINE_COST_PER_HOUR_USD}/hr compute rate.`,
    };
  });
}
