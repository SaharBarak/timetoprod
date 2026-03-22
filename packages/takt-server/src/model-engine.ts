import {
  TASK_TYPES,
  CONFIDENCE_LEVELS,
  HUMAN_BASELINE_MINUTES,
  type TaskType,
  type CellStats,
  type CalibrationModel,
  type Confidence,
} from './schema.js';
import { getCellReports, getTotalReportCount, saveModelSnapshot, getAllCellData } from './db-helpers.js';

// Determine confidence level from sample count
function getConfidence(sampleCount: number): Confidence {
  if (sampleCount >= 500) return 'very_high';
  if (sampleCount >= 100) return 'high';
  if (sampleCount >= 10) return 'medium';
  return 'low';
}

// Calculate percentile from sorted array
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

// Get top N items by frequency
function topN(items: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key]) => key);
}

// Compute CellStats for a specific cell
export function computeCellStats(taskType: string, aiSuitability: number): CellStats | null {
  const reports = getCellReports(taskType, aiSuitability);
  if (reports.length === 0) return null;

  const minutes = reports.map(r => r.actual_wall_clock_min).sort((a, b) => a - b);
  const costs = reports.map(r => r.actual_cost_usd).sort((a, b) => a - b);
  const successCount = reports.filter(r => r.success).length;
  const reviewCount = reports.filter(r => r.human_review_required).length;

  const models = reports.map(r => r.model);
  const stacks: string[] = [];
  for (const r of reports) {
    if (r.stack) {
      try {
        const parsed = JSON.parse(r.stack);
        if (Array.isArray(parsed)) stacks.push(...parsed);
      } catch {}
    }
  }

  const humanBaseline = HUMAN_BASELINE_MINUTES[taskType as TaskType]?.[String(aiSuitability)] || 240;
  const medianMinutes = percentile(minutes, 50);
  const accelerationFactor = medianMinutes > 0 ? humanBaseline / medianMinutes : 0;

  return {
    p10_minutes: Math.round(percentile(minutes, 10) * 100) / 100,
    p25_minutes: Math.round(percentile(minutes, 25) * 100) / 100,
    median_minutes: Math.round(medianMinutes * 100) / 100,
    p75_minutes: Math.round(percentile(minutes, 75) * 100) / 100,
    p90_minutes: Math.round(percentile(minutes, 90) * 100) / 100,
    median_cost_usd: Math.round(percentile(costs, 50) * 100) / 100,
    p75_cost_usd: Math.round(percentile(costs, 75) * 100) / 100,
    acceleration_factor: Math.round(accelerationFactor * 10) / 10,
    sample_count: reports.length,
    confidence: getConfidence(reports.length),
    success_rate: Math.round((successCount / reports.length) * 100) / 100,
    human_review_rate: Math.round((reviewCount / reports.length) * 100) / 100,
    top_models: topN(models, 3),
    top_stacks: topN(stacks, 3),
    last_report_at: reports[0]?.reported_at || new Date().toISOString(),
  };
}

// Build the full calibration model
let modelVersionCounter = 0;

export function buildCalibrationModel(): CalibrationModel {
  modelVersionCounter++;
  const version = `0.1.${modelVersionCounter}`;

  const cells: Record<string, Record<string, CellStats | null>> = {};
  for (const taskType of TASK_TYPES) {
    cells[taskType] = {};
    for (let s = 1; s <= 5; s++) {
      cells[taskType][String(s)] = computeCellStats(taskType, s);
    }
  }

  const model: CalibrationModel = {
    version,
    last_updated: new Date().toISOString(),
    total_reports: getTotalReportCount(),
    cells: cells as any,
  };

  // Save snapshot
  saveModelSnapshot(version, model);

  return model;
}

// In-memory cached model
let currentModel: CalibrationModel | null = null;
let modelTimer: ReturnType<typeof setInterval> | null = null;

export function getCurrentModel(): CalibrationModel {
  if (!currentModel) {
    currentModel = buildCalibrationModel();
  }
  return currentModel;
}

// Rebuild model after a new report (call this after inserting a report)
export function refreshModel(): CalibrationModel {
  currentModel = buildCalibrationModel();
  return currentModel;
}

// Start periodic model rebuild (every 60 seconds)
export function startModelRefreshLoop(): void {
  if (modelTimer) return;
  modelTimer = setInterval(() => {
    currentModel = buildCalibrationModel();
  }, 60_000);
}

export function stopModelRefreshLoop(): void {
  if (modelTimer) {
    clearInterval(modelTimer);
    modelTimer = null;
  }
}
