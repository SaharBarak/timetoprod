import { describe, it, expect } from 'vitest';
import { TaskReportSchema, EstimateQuerySchema, ReverseCalculateSchema, FeedPostSchema, TASK_TYPES, HUMAN_BASELINE_MINUTES } from '../schema.js';

describe('TaskReportSchema', () => {
  const validReport = {
    agent_id: 'agent-abc123',
    task_type: 'INTEGRATION',
    ai_suitability: 4,
    model: 'claude-sonnet-4-6',
    iterations: 12,
    actual_wall_clock_minutes: 38,
    actual_cost_usd: 6.20,
    success: true,
    human_review_required: false,
  };

  it('accepts a valid minimal report', () => {
    const result = TaskReportSchema.safeParse(validReport);
    expect(result.success).toBe(true);
  });

  it('accepts a report with all optional fields', () => {
    const result = TaskReportSchema.safeParse({
      ...validReport,
      stack: ['typescript', 'node', 'postgres'],
      parallel_agents: 3,
      tokens_used: 50000,
      ttp_estimate_used: true,
      estimated_wall_clock_minutes: 42,
      estimated_cost_usd: 7.10,
      failure_reason: 'timeout',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid task_type', () => {
    const result = TaskReportSchema.safeParse({ ...validReport, task_type: 'INVALID' });
    expect(result.success).toBe(false);
  });

  it('rejects ai_suitability out of range', () => {
    expect(TaskReportSchema.safeParse({ ...validReport, ai_suitability: 0 }).success).toBe(false);
    expect(TaskReportSchema.safeParse({ ...validReport, ai_suitability: 6 }).success).toBe(false);
  });

  it('rejects negative wall clock minutes', () => {
    const result = TaskReportSchema.safeParse({ ...validReport, actual_wall_clock_minutes: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const { agent_id, ...incomplete } = validReport;
    const result = TaskReportSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it('rejects empty agent_id', () => {
    const result = TaskReportSchema.safeParse({ ...validReport, agent_id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects iterations of 0', () => {
    const result = TaskReportSchema.safeParse({ ...validReport, iterations: 0 });
    expect(result.success).toBe(false);
  });
});

describe('EstimateQuerySchema', () => {
  it('accepts valid query', () => {
    const result = EstimateQuerySchema.safeParse({ task_type: 'LOGIC', ai_suitability: 3 });
    expect(result.success).toBe(true);
  });

  it('accepts with optional stack', () => {
    const result = EstimateQuerySchema.safeParse({ task_type: 'DEBUG', ai_suitability: 2, stack: 'python,django' });
    expect(result.success).toBe(true);
  });
});

describe('FeedPostSchema', () => {
  it('accepts valid feed post', () => {
    const result = FeedPostSchema.safeParse({
      agent_id: 'agent-xyz',
      content: 'Observed that INTEGRATION/5 tasks are 2x faster with claude-sonnet-4-6 vs claude-sonnet-4-5',
      post_type: 'insight',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid post_type', () => {
    const result = FeedPostSchema.safeParse({
      agent_id: 'agent-xyz',
      content: 'test',
      post_type: 'invalid',
    });
    expect(result.success).toBe(false);
  });
});

describe('TASK_TYPES', () => {
  it('has exactly 6 types', () => {
    expect(TASK_TYPES).toHaveLength(6);
  });

  it('includes all expected types', () => {
    expect(TASK_TYPES).toContain('BOILERPLATE');
    expect(TASK_TYPES).toContain('INTEGRATION');
    expect(TASK_TYPES).toContain('LOGIC');
    expect(TASK_TYPES).toContain('ARCHITECTURE');
    expect(TASK_TYPES).toContain('DEBUG');
    expect(TASK_TYPES).toContain('CREATIVE');
  });
});

describe('HUMAN_BASELINE_MINUTES', () => {
  it('has entries for all task types', () => {
    for (const type of TASK_TYPES) {
      expect(HUMAN_BASELINE_MINUTES[type]).toBeDefined();
      for (let s = 1; s <= 5; s++) {
        expect(typeof HUMAN_BASELINE_MINUTES[type][String(s)]).toBe('number');
      }
    }
  });
});
