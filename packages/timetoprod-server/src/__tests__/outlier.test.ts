import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../db.js';
import { insertReport } from '../db-helpers.js';
import { isOutlier } from '../outlier.js';

beforeEach(() => {
  process.env.TTP_DB_PATH = ':memory:';
  getDb();
});

afterEach(() => {
  closeDb();
  delete process.env.TTP_DB_PATH;
});

function makeReport(minutes: number) {
  return {
    agent_id: 'test-' + Math.random().toString(36).slice(2),
    task_type: 'INTEGRATION' as const,
    ai_suitability: 4 as const,
    model: 'claude-sonnet-4-6',
    iterations: 10,
    actual_wall_clock_minutes: minutes,
    actual_cost_usd: minutes * 0.17,
    success: true,
    human_review_required: false,
  };
}

describe('isOutlier', () => {
  it('returns false with fewer than 3 data points', () => {
    insertReport(makeReport(30));
    insertReport(makeReport(40));
    expect(isOutlier('INTEGRATION', 4, 1000, 170)).toBe(false);
  });

  it('returns false for normal values with IQR method', () => {
    for (let i = 0; i < 5; i++) {
      insertReport(makeReport(30 + i * 5));
    }
    expect(isOutlier('INTEGRATION', 4, 40, 6.80)).toBe(false);
  });

  it('returns true for extreme outliers with IQR method', () => {
    for (let i = 0; i < 5; i++) {
      insertReport(makeReport(30 + i * 2));
    }
    // 500 minutes is way outside IQR
    expect(isOutlier('INTEGRATION', 4, 500, 85)).toBe(true);
  });

  it('returns false for normal values with sigma method', () => {
    for (let i = 0; i < 15; i++) {
      insertReport(makeReport(30 + Math.random() * 20));
    }
    expect(isOutlier('INTEGRATION', 4, 40, 6.80)).toBe(false);
  });

  it('returns true for extreme outliers with sigma method', () => {
    for (let i = 0; i < 15; i++) {
      insertReport(makeReport(30 + i));
    }
    expect(isOutlier('INTEGRATION', 4, 5000, 850)).toBe(true);
  });
});
