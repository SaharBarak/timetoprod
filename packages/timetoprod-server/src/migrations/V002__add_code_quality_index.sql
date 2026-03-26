-- V002: Add code quality index (1-100) to reports
-- Captures agent self-assessed or tooling-derived quality score.
-- Factors: test coverage, lint errors, type safety, complexity, documentation.

ALTER TABLE reports ADD COLUMN code_quality_index INTEGER;
ALTER TABLE reports ADD COLUMN code_quality_breakdown TEXT;
