import { DAY_IN_MILLISECONDS, HOUR_IN_MILLISECONDS } from "@/lib/date";

export const METRIC_RANGE_OPTIONS = {
	"1h": { durationMs: HOUR_IN_MILLISECONDS, stepSeconds: 60 },
	"6h": { durationMs: 6 * HOUR_IN_MILLISECONDS, stepSeconds: 60 },
	"24h": { durationMs: DAY_IN_MILLISECONDS, stepSeconds: 5 * 60 },
	"7d": { durationMs: 7 * DAY_IN_MILLISECONDS, stepSeconds: 30 * 60 },
	"30d": {
		durationMs: 30 * DAY_IN_MILLISECONDS,
		stepSeconds: 2 * 60 * 60,
	},
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
