import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../db.js';
import { insertReport } from '../db-helpers.js';
import { computeCellStats, buildCalibrationModel, getCurrentModel, refreshModel } from '../model-engine.js';

// Use in-memory DB for tests
beforeEach(() => {
  process.env.TAKT_DB_PATH = ':memory:';
  getDb(); // Initialize
});

afterEach(() => {
  closeDb();
  delete process.env.TAKT_DB_PATH;
});

function makeReport(overrides: Partial<Parameters<typeof insertReport>[0]> = {}) {
  return {
    agent_id: 'test-agent-' + Math.random().toString(36).slice(2),
    task_type: 'INTEGRATION' as const,
    ai_suitability: 4 as const,
    model: 'claude-sonnet-4-6',
    iterations: 10,
    actual_wall_clock_minutes: 40,
    actual_cost_usd: 6.50,
    success: true,
    human_review_required: false,
    ...overrides,
  };
}

describe('computeCellStats', () => {
  it('returns null for empty cell', () => {
    const stats = computeCellStats('INTEGRATION', 4);
    expect(stats).toBeNull();
  });

  it('computes stats for a single report', () => {
    insertReport(makeReport({ actual_wall_clock_minutes: 30, actual_cost_usd: 5.00 }));
    const stats = computeCellStats('INTEGRATION', 4);
    expect(stats).not.toBeNull();
    expect(stats!.median_minutes).toBe(30);
    expect(stats!.median_cost_usd).toBe(5.00);
    expect(stats!.sample_count).toBe(1);
    expect(stats!.confidence).toBe('low');
  });

  it('computes correct median for multiple reports', () => {
    insertReport(makeReport({ actual_wall_clock_minutes: 10, actual_cost_usd: 2.00 }));
    insertReport(makeReport({ actual_wall_clock_minutes: 20, actual_cost_usd: 4.00 }));
    insertReport(makeReport({ actual_wall_clock_minutes: 30, actual_cost_usd: 6.00 }));
    insertReport(makeReport({ actual_wall_clock_minutes: 40, actual_cost_usd: 8.00 }));
    insertReport(makeReport({ actual_wall_clock_minutes: 50, actual_cost_usd: 10.00 }));

    const stats = computeCellStats('INTEGRATION', 4);
    expect(stats).not.toBeNull();
    expect(stats!.median_minutes).toBe(30);
    expect(stats!.sample_count).toBe(5);
    expect(stats!.confidence).toBe('low');
  });

  it('computes success rate correctly', () => {
    insertReport(makeReport({ success: true }));
    insertReport(makeReport({ success: true }));
    insertReport(makeReport({ success: false }));

    const stats = computeCellStats('INTEGRATION', 4);
    expect(stats!.success_rate).toBeCloseTo(0.67, 1);
  });

  it('computes acceleration factor', () => {
    // Human baseline for INTEGRATION/4 = 180 minutes
    insertReport(makeReport({ actual_wall_clock_minutes: 18 }));
    const stats = computeCellStats('INTEGRATION', 4);
    expect(stats!.acceleration_factor).toBe(10); // 180 / 18
  });

  it('tracks top models', () => {
    insertReport(makeReport({ model: 'claude-sonnet-4-6' }));
    insertReport(makeReport({ model: 'claude-sonnet-4-6' }));
    insertReport(makeReport({ model: 'claude-opus-4-6' }));

    const stats = computeCellStats('INTEGRATION', 4);
    expect(stats!.top_models[0]).toBe('claude-sonnet-4-6');
  });

  it('returns medium confidence at 10+ samples', () => {
    for (let i = 0; i < 10; i++) {
      insertReport(makeReport({ actual_wall_clock_minutes: 30 + i }));
    }
    const stats = computeCellStats('INTEGRATION', 4);
    expect(stats!.confidence).toBe('medium');
  });
});

describe('buildCalibrationModel', () => {
  it('builds model with all cells', () => {
    insertReport(makeReport());
    const model = buildCalibrationModel();

    expect(model.version).toBeDefined();
    expect(model.total_reports).toBe(1);
    expect(model.cells.INTEGRATION['4']).not.toBeNull();
    expect(model.cells.BOILERPLATE['1']).toBeNull();
  });

  it('increments version on each build', () => {
    const m1 = buildCalibrationModel();
    const m2 = buildCalibrationModel();
    expect(m1.version).not.toBe(m2.version);
  });
});

describe('getCurrentModel / refreshModel', () => {
  it('returns a model even with no data', () => {
    const model = getCurrentModel();
    expect(model).toBeDefined();
    expect(model.total_reports).toBe(0);
  });

  it('refreshModel updates the cached model', () => {
    getCurrentModel(); // Initialize
    insertReport(makeReport());
    const updated = refreshModel();
    expect(updated.total_reports).toBe(1);
  });
});
