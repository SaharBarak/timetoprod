import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TASK_TYPES,
  HUMAN_BASELINE_MINUTES,
  MACHINE_COST_PER_MINUTE_USD,
  MACHINE_COST_PER_HOUR_USD,
  type TaskType,
  type CalibrationModel,
} from './schema.js';
import { insertReport, checkAndUpdateRateLimit, flagReportAsOutlier, getModelSnapshotByVersion } from './db-helpers.js';
import { getCurrentModel, refreshModel, computeCellStats } from './model-engine.js';
import { isOutlier } from './outlier.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'timetoprod',
    version: '0.1.0',
  });

  // Tool 1: estimate_task
  server.tool(
    'estimate_task',
    'Query a calibrated cost/time estimate before starting a task. Returns median time, cost range, acceleration factor, and confidence level based on aggregated actuals from real agent runs.',
    {
      description: z.string().describe('Natural language task description'),
      task_type: z.enum(TASK_TYPES).optional().describe('Task type (skip auto-classification if provided)'),
      ai_suitability: z.number().int().min(1).max(5).optional().describe('AI suitability 1-5 (skip auto-classification if provided)'),
      stack: z.array(z.string()).optional().describe('Tech stack, e.g. ["typescript", "node"]'),
    },
    async (params) => {
      let taskType = params.task_type as TaskType | undefined;
      let suitability = params.ai_suitability;

      // Auto-classify if not provided
      if (!taskType || !suitability) {
        const desc = params.description.toLowerCase();
        if (/crud|endpoint|scaffold|boilerplate|template|migration/i.test(desc)) {
          taskType = taskType || 'BOILERPLATE';
          suitability = suitability || 5;
        } else if (/webhook|api|sdk|wrapper|integration|adapter/i.test(desc)) {
          taskType = taskType || 'INTEGRATION';
          suitability = suitability || 4;
        } else if (/algorithm|business.?rule|state.?machine|validation/i.test(desc)) {
          taskType = taskType || 'LOGIC';
          suitability = suitability || 3;
        } else if (/architect|design|schema|module|infrastructure/i.test(desc)) {
          taskType = taskType || 'ARCHITECTURE';
          suitability = suitability || 2;
        } else if (/bug|fix|debug|error|regression/i.test(desc)) {
          taskType = taskType || 'DEBUG';
          suitability = suitability || 3;
        } else if (/ui|ux|component|style|css|copy|documentation/i.test(desc)) {
          taskType = taskType || 'CREATIVE';
          suitability = suitability || 3;
        } else {
          taskType = taskType || 'LOGIC';
          suitability = suitability || 3;
        }
      }

      const model = getCurrentModel();
      const cell = model.cells[taskType]?.[String(suitability)];
      const humanBaseline = HUMAN_BASELINE_MINUTES[taskType]?.[String(suitability)] || 240;

      if (!cell || cell.sample_count === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              task_type: taskType,
              ai_suitability: suitability,
              median_minutes: null,
              cost_range: { p25: null, median: null, p75: null },
              acceleration_factor: null,
              confidence: 'low',
              sample_count: 0,
              advisory: `No calibration data for ${taskType}/${suitability} yet. Human baseline: ${humanBaseline} min. Report your actuals after completion to help build the model.`,
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            task_type: taskType,
            ai_suitability: suitability,
            median_minutes: cell.median_minutes,
            cost_range: {
              p25: Math.round(cell.p25_minutes * MACHINE_COST_PER_MINUTE_USD * 100) / 100,
              median: cell.median_cost_usd,
              p75: cell.p75_cost_usd,
            },
            acceleration_factor: cell.acceleration_factor,
            confidence: cell.confidence,
            sample_count: cell.sample_count,
            advisory: `${taskType}/${suitability}: median ${cell.median_minutes}m, ${cell.acceleration_factor}x faster than human baseline. ${cell.confidence} confidence from ${cell.sample_count} reports.`,
          }, null, 2),
        }],
      };
    }
  );

  // Tool 2: classify_task
  server.tool(
    'classify_task',
    'Classify a natural-language task description into task type and AI suitability score.',
    {
      description: z.string().describe('Natural language task description'),
    },
    async (params) => {
      const desc = params.description.toLowerCase();
      let task_type: TaskType = 'LOGIC';
      let ai_suitability = 3;
      let reasoning = '';

      if (/crud|endpoint|scaffold|boilerplate|template|migration|type def/i.test(desc)) {
        task_type = 'BOILERPLATE'; ai_suitability = 5;
        reasoning = 'Task appears to be repetitive, well-defined work.';
      } else if (/webhook|api|sdk|wrapper|integration|adapter|transform|connect/i.test(desc)) {
        task_type = 'INTEGRATION'; ai_suitability = 4;
        reasoning = 'Task involves connecting systems with defined interfaces.';
      } else if (/algorithm|business.?rule|state.?machine|validation|calculat/i.test(desc)) {
        task_type = 'LOGIC'; ai_suitability = 3;
        reasoning = 'Task requires domain-specific logic.';
      } else if (/architect|design|schema|module|infrastructure|system.?design/i.test(desc)) {
        task_type = 'ARCHITECTURE'; ai_suitability = 2;
        reasoning = 'Task involves high-level design decisions.';
      } else if (/bug|fix|debug|error|regression|performance|trace/i.test(desc)) {
        task_type = 'DEBUG'; ai_suitability = 3;
        reasoning = 'Task involves diagnosis and repair.';
      } else if (/ui|ux|component|design|style|css|copy|documentation|prompt/i.test(desc)) {
        task_type = 'CREATIVE'; ai_suitability = 3;
        reasoning = 'Task involves creative or generative work.';
      } else {
        reasoning = 'Could not confidently classify. Defaulting to LOGIC/3.';
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            task_type,
            ai_suitability,
            reasoning,
            confidence: reasoning.includes('Could not') ? 'low' : 'medium',
          }, null, 2),
        }],
      };
    }
  );

  // Tool 3: reverse_calculate
  server.tool(
    'reverse_calculate',
    'Translate a human development estimate into machine cost equivalent. Use for client proposals and SOWs.',
    {
      human_hours: z.number().min(0.1).describe('Estimated human developer hours'),
      human_rate_usd: z.number().min(1).describe('Human hourly rate in USD'),
      task_type: z.enum(TASK_TYPES).optional().describe('Task type for model-backed estimate'),
      ai_suitability: z.number().int().min(1).max(5).optional().describe('AI suitability 1-5'),
    },
    async (params) => {
      const { human_hours, human_rate_usd, task_type, ai_suitability } = params;
      const human_cost_usd = human_hours * human_rate_usd;

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

      if (machine_minutes === null) {
        machine_minutes = (human_hours * 60) / 5;
      }

      const machine_cost_usd = Math.round(machine_minutes * MACHINE_COST_PER_MINUTE_USD * 100) / 100;
      const machine_wall_clock_hours = Math.round((machine_minutes / 60) * 100) / 100;
      const acceleration_factor = machine_minutes > 0 ? Math.round(((human_hours * 60) / machine_minutes) * 10) / 10 : 0;
      const savings_usd = Math.round((human_cost_usd - machine_cost_usd) * 100) / 100;
      const savings_pct = Math.round((1 - machine_cost_usd / human_cost_usd) * 10000) / 100;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            human_cost_usd,
            machine_cost_usd,
            machine_wall_clock_hours,
            acceleration_factor,
            savings_usd,
            savings_pct,
            confidence,
            advisory: `${human_hours}h @ $${human_rate_usd}/hr = $${human_cost_usd} human cost. Machine equivalent: $${machine_cost_usd} (${savings_pct}% savings). ${confidence} confidence.`,
          }, null, 2),
        }],
      };
    }
  );

  // Tool 4: report_actual
  server.tool(
    'report_actual',
    'Report a completed task\'s actual cost, time, and deliverables. Call this after every task completes. Include task goal and what was produced.',
    {
      task_type: z.enum(TASK_TYPES).describe('Task type'),
      ai_suitability: z.number().int().min(1).max(5).describe('AI suitability 1-5'),
      actual_wall_clock_minutes: z.number().min(0.01).describe('Actual wall-clock minutes'),
      actual_cost_usd: z.number().min(0).describe('Actual cost in USD'),
      iterations: z.number().int().min(1).describe('Loop iteration count'),
      model: z.string().describe('Model used, e.g. "claude-sonnet-4-6"'),
      success: z.boolean().describe('Whether the task completed successfully'),
      human_review_required: z.boolean().describe('Whether human review was needed'),
      stack: z.array(z.string()).optional().describe('Tech stack'),
      parallel_agents: z.number().int().optional().describe('Number of concurrent agents'),
      ttp_estimate_used: z.boolean().optional().describe('Whether TimeToProd estimate was queried before'),
      estimated_minutes: z.number().optional().describe('TimeToProd-estimated minutes (if queried)'),
      estimated_cost_usd: z.number().optional().describe('TimeToProd-estimated cost (if queried)'),
      failure_reason: z.enum(["context_overflow", "spec_ambiguity", "tool_error", "timeout", "other"]).optional().describe('Failure reason if not successful'),
      // Task definition
      task_goal: z.string().optional().describe('What the agent was asked to accomplish'),
      task_acceptance_criteria: z.array(z.string()).optional().describe('Acceptance criteria for the task'),
      task_repo: z.string().optional().describe('Repository name, e.g. "owner/repo"'),
      task_pr_url: z.string().optional().describe('Pull request URL if one was created'),
      // Deliverables
      artifacts: z.array(z.object({
        type: z.enum(["file", "endpoint", "test", "migration", "config", "documentation", "component", "fix", "refactor"]),
        path: z.string().optional(),
        action: z.enum(["created", "modified", "deleted"]),
        description: z.string().optional(),
      })).optional().describe('What was produced — files, endpoints, tests, etc.'),
      files_changed: z.number().int().optional().describe('Total files changed'),
      lines_added: z.number().int().optional().describe('Lines of code added'),
      lines_removed: z.number().int().optional().describe('Lines of code removed'),
      tests_added: z.number().int().optional().describe('Number of tests added'),
      // Time breakdown
      planning_minutes: z.number().optional().describe('Minutes spent planning/understanding'),
      coding_minutes: z.number().optional().describe('Minutes spent writing code'),
      testing_minutes: z.number().optional().describe('Minutes spent running/fixing tests'),
      debugging_minutes: z.number().optional().describe('Minutes spent debugging'),
      // Code quality
      code_quality_index: z.number().int().min(1).max(100).optional().describe('Composite code quality score 1-100'),
      code_quality_breakdown: z.object({
        test_coverage: z.number().int().min(0).max(100).optional(),
        lint_clean: z.number().int().min(0).max(100).optional(),
        type_safety: z.number().int().min(0).max(100).optional(),
        complexity: z.number().int().min(0).max(100).optional(),
        documentation: z.number().int().min(0).max(100).optional(),
        security: z.number().int().min(0).max(100).optional(),
      }).optional().describe('Per-factor quality breakdown'),
    },
    async (params) => {
      const agent_id = 'mcp-agent-' + Date.now().toString(36);

      const report = {
        agent_id,
        task_type: params.task_type,
        ai_suitability: params.ai_suitability,
        actual_wall_clock_minutes: params.actual_wall_clock_minutes,
        actual_cost_usd: params.actual_cost_usd,
        iterations: params.iterations,
        model: params.model,
        success: params.success,
        human_review_required: params.human_review_required,
        stack: params.stack,
        parallel_agents: params.parallel_agents,
        ttp_estimate_used: params.ttp_estimate_used,
        estimated_wall_clock_minutes: params.estimated_minutes,
        estimated_cost_usd: params.estimated_cost_usd,
        failure_reason: params.failure_reason,
        task: params.task_goal ? {
          goal: params.task_goal,
          acceptance_criteria: params.task_acceptance_criteria,
          repo: params.task_repo,
          pr_url: params.task_pr_url,
        } : undefined,
        deliverables: params.artifacts ? {
          artifacts: params.artifacts,
          files_changed: params.files_changed,
          lines_added: params.lines_added,
          lines_removed: params.lines_removed,
          tests_added: params.tests_added,
        } : undefined,
        time_breakdown: params.planning_minutes != null ? {
          planning_minutes: params.planning_minutes,
          coding_minutes: params.coding_minutes,
          testing_minutes: params.testing_minutes,
          debugging_minutes: params.debugging_minutes,
        } : undefined,
        code_quality_index: params.code_quality_index,
        code_quality_breakdown: params.code_quality_breakdown,
      };

      const allowed = checkAndUpdateRateLimit(agent_id);

      const { report_id } = insertReport(report);

      const outlierDetected = isOutlier(
        params.task_type,
        params.ai_suitability,
        params.actual_wall_clock_minutes,
        params.actual_cost_usd
      );

      if (outlierDetected) {
        flagReportAsOutlier(report_id);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              accepted: false,
              report_id,
              reason: 'Report flagged as outlier. It will be reviewed before incorporation.',
            }, null, 2),
          }],
        };
      }

      const model = refreshModel();
      const cell = model.cells[params.task_type as TaskType]?.[String(params.ai_suitability)];

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            accepted: true,
            report_id,
            model_version: model.version,
            delta: cell ? `Your report updated ${params.task_type}/${params.ai_suitability}: median now ${cell.median_minutes}m from ${cell.sample_count} reports.` : undefined,
          }, null, 2),
        }],
      };
    }
  );

  // Tool 5: get_model
  server.tool(
    'get_model',
    'Download the full calibration model. Useful for caching locally or analysis.',
    {
      version: z.string().optional().describe('Specific model version (defaults to latest)'),
    },
    async (params) => {
      let model: CalibrationModel | null;
      if (params.version) {
        model = getModelSnapshotByVersion(params.version);
        if (!model) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'Model version not found' }),
            }],
          };
        }
      } else {
        model = getCurrentModel();
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(model, null, 2),
        }],
      };
    }
  );

  return server;
}
