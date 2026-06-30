export const METRIC_RANGE_OPTIONS = {
	"1h": { durationMs: 60 * 60 * 1000, stepSeconds: 60 },
	"6h": { durationMs: 6 * 60 * 60 * 1000, stepSeconds: 60 },
	"24h": { durationMs: 24 * 60 * 60 * 1000, stepSeconds: 5 * 60 },
	"7d": { durationMs: 7 * 24 * 60 * 60 * 1000, stepSeconds: 30 * 60 },
	"30d": { durationMs: 30 * 24 * 60 * 60 * 1000, stepSeconds: 2 * 60 * 60 },
} as const;

export type MetricRange = keyof typeof METRIC_RANGE_OPTIONS;

export const METRIC_RANGE_KEYS = Object.keys(
	METRIC_RANGE_OPTIONS,
) as MetricRange[];

export function parseMetricRange(value: string | null): MetricRange {
	if (value && value in METRIC_RANGE_OPTIONS) {
		return value as MetricRange;
	}
	return "1h";
}
