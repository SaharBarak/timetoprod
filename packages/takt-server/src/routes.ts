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
import { insertReport, flagReportAsOutlier, checkAndUpdateRateLimit, getTotalReportCount, getReportsLastHour, insertFeedPost, getFeedPosts, upvoteFeedPost, getRecentReports, getModelSnapshotByVersion } from './db-helpers.js';
import { getCurrentModel, refreshModel, computeCellStats } from './model-engine.js';
import { isOutlier } from './outlier.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {

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

  // GET /health — liveness + model freshness
  app.get('/health', async (request, reply) => {
    const model = getCurrentModel();
    const modelAge = Math.round((Date.now() - new Date(model.last_updated).getTime()) / 1000);

    return {
      status: 'ok',
      model_version: model.version,
      model_age_seconds: modelAge,
      total_reports: model.total_reports,
      reports_last_hour: getReportsLastHour(),
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
