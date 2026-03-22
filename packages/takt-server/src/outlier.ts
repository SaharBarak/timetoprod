import { getCellReports } from './db-helpers.js';

/**
 * Check if a new report value is an outlier for the given cell.
 * Uses IQR method for sparse cells (<10 samples), 3σ for larger cells.
 * Returns true if the value is an outlier.
 */
export function isOutlier(
  taskType: string,
  aiSuitability: number,
  wallClockMinutes: number,
  costUsd: number
): boolean {
  const reports = getCellReports(taskType, aiSuitability);

  // Can't detect outliers with fewer than 3 data points
  if (reports.length < 3) return false;

  const minutes = reports.map(r => r.actual_wall_clock_min).sort((a, b) => a - b);

  if (reports.length < 10) {
    // IQR-based for sparse cells
    return isIQROutlier(minutes, wallClockMinutes);
  } else {
    // 3σ for larger cells
    return isSigmaOutlier(minutes, wallClockMinutes);
  }
}

function isIQROutlier(sorted: number[], value: number): boolean {
  const q1Index = Math.floor(sorted.length * 0.25);
  const q3Index = Math.floor(sorted.length * 0.75);
  const q1 = sorted[q1Index];
  const q3 = sorted[q3Index];
  const iqr = q3 - q1;
  const lowerBound = q1 - 3 * iqr; // Use 3× IQR for wider tolerance
  const upperBound = q3 + 3 * iqr;
  return value < lowerBound || value > upperBound;
}

function isSigmaOutlier(values: number[], value: number): boolean {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  return Math.abs(value - mean) > 3 * stdDev;
}
