export const LOG_TIME_RANGES = ["1h", "6h", "24h", "7d"] as const;
export type LogTimeRange = (typeof LOG_TIME_RANGES)[number];

export const DEFAULT_LOG_TIME_RANGE: LogTimeRange = "24h";
export const MAX_LOG_SEARCH_LENGTH = 200;

export function isLogTimeRange(value: string): value is LogTimeRange {
	return LOG_TIME_RANGES.some((range) => range === value);
}

export function normalizeLogSearch(
	value: string | null | undefined,
): string | undefined {
	const search = value?.trim();
	if (!search) return undefined;
	if (search.length > MAX_LOG_SEARCH_LENGTH) {
		throw new RangeError(
			`Search must be ${MAX_LOG_SEARCH_LENGTH} characters or fewer`,
		);
	}
	return search;
}
