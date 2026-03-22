import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../db.js';
import {
  insertReport,
  getCellReports,
  getTotalReportCount,
  checkAndUpdateRateLimit,
  insertFeedPost,
  getFeedPosts,
  upvoteFeedPost,
  flagReportAsOutlier,
  getRecentReports,
} from '../db-helpers.js';

beforeEach(() => {
  process.env.TAKT_DB_PATH = ':memory:';
  getDb();
});

afterEach(() => {
  closeDb();
  delete process.env.TAKT_DB_PATH;
});

const baseReport = {
  agent_id: 'test-agent',
  task_type: 'INTEGRATION' as const,
  ai_suitability: 4 as const,
  model: 'claude-sonnet-4-6',
  iterations: 10,
  actual_wall_clock_minutes: 38,
  actual_cost_usd: 6.20,
  success: true,
  human_review_required: false,
};

describe('insertReport', () => {
  it('inserts and returns report_id', () => {
    const { report_id, reported_at } = insertReport(baseReport);
    expect(report_id).toBeDefined();
    expect(typeof report_id).toBe('string');
    expect(reported_at).toBeDefined();
  });
});

describe('getCellReports', () => {
  it('returns reports for the correct cell', () => {
    insertReport(baseReport);
    insertReport({ ...baseReport, task_type: 'LOGIC' });

    const reports = getCellReports('INTEGRATION', 4);
    expect(reports).toHaveLength(1);
    expect(reports[0].actual_wall_clock_min).toBe(38);
  });

  it('excludes outlier-flagged reports', () => {
    const { report_id } = insertReport(baseReport);
    flagReportAsOutlier(report_id);

    const reports = getCellReports('INTEGRATION', 4);
    expect(reports).toHaveLength(0);
  });
});

describe('getTotalReportCount', () => {
  it('counts non-outlier reports', () => {
    insertReport(baseReport);
    const { report_id } = insertReport(baseReport);
    flagReportAsOutlier(report_id);

    expect(getTotalReportCount()).toBe(1);
  });
});

describe('checkAndUpdateRateLimit', () => {
  it('allows first report', () => {
    expect(checkAndUpdateRateLimit('agent-1')).toBe(true);
  });

  it('blocks rapid second report', () => {
    checkAndUpdateRateLimit('agent-1');
    expect(checkAndUpdateRateLimit('agent-1')).toBe(false);
  });

  it('allows different agents', () => {
    checkAndUpdateRateLimit('agent-1');
    expect(checkAndUpdateRateLimit('agent-2')).toBe(true);
  });
});

describe('feed posts', () => {
  it('inserts and retrieves feed posts', () => {
    const postId = insertFeedPost('agent-1', 'Test insight', 'insight');
    expect(postId).toBeDefined();

    const posts = getFeedPosts(10);
    expect(posts).toHaveLength(1);
    expect(posts[0].content).toBe('Test insight');
  });

  it('upvotes a feed post', () => {
    const postId = insertFeedPost('agent-1', 'Good insight', 'insight');
    upvoteFeedPost(postId);
    upvoteFeedPost(postId);

    const posts = getFeedPosts(10);
    expect(posts[0].upvotes).toBe(2);
  });

  it('filters by post type', () => {
    insertFeedPost('agent-1', 'insight post', 'insight');
    insertFeedPost('agent-1', 'proposal post', 'proposal');

    const insights = getFeedPosts(10, undefined, 'insight');
    expect(insights).toHaveLength(1);
    expect(insights[0].post_type).toBe('insight');
  });
});

describe('getRecentReports', () => {
  it('returns reports in reverse chronological order', () => {
    insertReport({ ...baseReport, actual_wall_clock_minutes: 10 });
    insertReport({ ...baseReport, actual_wall_clock_minutes: 20 });

    const recent = getRecentReports(10);
    expect(recent).toHaveLength(2);
    // Most recent first
    expect(recent[0].actual_wall_clock_min).toBe(20);
  });
});
