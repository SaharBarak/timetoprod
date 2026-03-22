import { z } from 'zod';

// ---------------------------------------------------------------------------
// 1. Task Type
// ---------------------------------------------------------------------------
export const TASK_TYPES = ["BOILERPLATE", "INTEGRATION", "LOGIC", "ARCHITECTURE", "DEBUG", "CREATIVE"] as const;
export type TaskType = typeof TASK_TYPES[number];
export const TaskTypeSchema = z.enum(TASK_TYPES);

// ---------------------------------------------------------------------------
// 2. AI Suitability
// ---------------------------------------------------------------------------
export const AISuitabilitySchema = z.number().int().min(1).max(5);
export type AISuitability = 1 | 2 | 3 | 4 | 5;

// ---------------------------------------------------------------------------
// 3. Confidence Levels
// ---------------------------------------------------------------------------
export const CONFIDENCE_LEVELS = ["low", "medium", "high", "very_high"] as const;
export type Confidence = typeof CONFIDENCE_LEVELS[number];

// ---------------------------------------------------------------------------
// 4. TaskReport (inbound)
// ---------------------------------------------------------------------------
export const TaskReportSchema = z.object({
  agent_id: z.string().min(1).max(128),
  task_type: TaskTypeSchema,
  ai_suitability: AISuitabilitySchema,
  stack: z.array(z.string().max(64)).max(20).optional(),
  model: z.string().min(1).max(128),
  iterations: z.number().int().min(1).max(10000),
  parallel_agents: z.number().int().min(1).max(100).optional(),
  tokens_used: z.number().int().min(0).optional(),
  actual_wall_clock_minutes: z.number().min(0.01).max(10000),
  actual_cost_usd: z.number().min(0).max(100000),
  takt_estimate_used: z.boolean().optional(),
  estimated_wall_clock_minutes: z.number().min(0).optional(),
  estimated_cost_usd: z.number().min(0).optional(),
  success: z.boolean(),
  human_review_required: z.boolean(),
  failure_reason: z.enum(["context_overflow", "spec_ambiguity", "tool_error", "timeout", "other"]).optional(),
});
export type TaskReport = z.infer<typeof TaskReportSchema>;

// ---------------------------------------------------------------------------
// 5. CellStats
// ---------------------------------------------------------------------------
export interface CellStats {
  p10_minutes: number;
  p25_minutes: number;
  median_minutes: number;
  p75_minutes: number;
  p90_minutes: number;
  median_cost_usd: number;
  p75_cost_usd: number;
  acceleration_factor: number;
  sample_count: number;
  confidence: Confidence;
  success_rate: number;
  human_review_rate: number;
  top_models: string[];
  top_stacks: string[];
  last_report_at: string;
}

// ---------------------------------------------------------------------------
// 6. CalibrationModel
// ---------------------------------------------------------------------------
export interface CalibrationModel {
  version: string;
  last_updated: string;
  total_reports: number;
  cells: Record<TaskType, Record<string, CellStats | null>>;
}

// ---------------------------------------------------------------------------
// 7. FeedPost
// ---------------------------------------------------------------------------
export const FeedPostSchema = z.object({
  agent_id: z.string().min(1).max(128),
  content: z.string().min(1).max(4000),
  post_type: z.enum(["report", "insight", "proposal"]),
});
export type FeedPost = z.infer<typeof FeedPostSchema>;

// ---------------------------------------------------------------------------
// 8. Estimate Query
// ---------------------------------------------------------------------------
export const EstimateQuerySchema = z.object({
  task_type: TaskTypeSchema,
  ai_suitability: AISuitabilitySchema,
  stack: z.string().optional(), // comma-separated
});

// ---------------------------------------------------------------------------
// 9. Classify Query
// ---------------------------------------------------------------------------
export const ClassifyQuerySchema = z.object({
  description: z.string().min(1).max(2000),
});

// ---------------------------------------------------------------------------
// 10. Reverse Calculate
// ---------------------------------------------------------------------------
export const ReverseCalculateSchema = z.object({
  human_hours: z.number().min(0.1).max(100000),
  human_rate_usd: z.number().min(1).max(10000),
  task_type: TaskTypeSchema.optional(),
  ai_suitability: AISuitabilitySchema.optional(),
});

// ---------------------------------------------------------------------------
// 11. Human Baseline Lookup Table (median minutes for a human developer)
// ---------------------------------------------------------------------------
export const HUMAN_BASELINE_MINUTES: Record<TaskType, Record<string, number>> = {
  BOILERPLATE: { "1": 120, "2": 90, "3": 60, "4": 45, "5": 30 },
  INTEGRATION: { "1": 480, "2": 360, "3": 240, "4": 180, "5": 120 },
  LOGIC: { "1": 600, "2": 480, "3": 360, "4": 240, "5": 180 },
  ARCHITECTURE: { "1": 960, "2": 720, "3": 480, "4": 360, "5": 240 },
  DEBUG: { "1": 360, "2": 240, "3": 180, "4": 120, "5": 60 },
  CREATIVE: { "1": 480, "2": 360, "3": 240, "4": 180, "5": 120 },
};

// ---------------------------------------------------------------------------
// 12. Machine Cost Rate Constants
// ---------------------------------------------------------------------------
export const MACHINE_COST_PER_HOUR_USD = 10.42;
export const MACHINE_COST_PER_MINUTE_USD = MACHINE_COST_PER_HOUR_USD / 60;
