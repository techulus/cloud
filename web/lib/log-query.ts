export const LOG_TIME_RANGES = ["1h", "6h", "24h", "7d"] as const;
export type LogTimeRange = (typeof LOG_TIME_RANGES)[number];

export const DEFAULT_LOG_TIME_RANGE: LogTimeRange = "24h";
export const MAX_LOG_SEARCH_LENGTH = 200;

const LOG_CURSOR_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

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

export function isLogCursor(value: string): boolean {
	const match = LOG_CURSOR_PATTERN.exec(value);
	if (!match) return false;

	const [
		,
		yearValue,
		monthValue,
		dayValue,
		hourValue,
		minuteValue,
		secondValue,
	] = match;
	const year = Number(yearValue);
	const month = Number(monthValue);
	const day = Number(dayValue);
	const hour = Number(hourValue);
	const minute = Number(minuteValue);
	const second = Number(secondValue);
	const offsetHour = Number(match[7] || 0);
	const offsetMinute = Number(match[8] || 0);
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [
		31,
		leapYear ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	][month - 1];

	return (
		daysInMonth !== undefined &&
		day >= 1 &&
		day <= daysInMonth &&
		hour <= 23 &&
		minute <= 59 &&
		second <= 59 &&
		offsetHour <= 23 &&
		offsetMinute <= 59
	);
}

export function normalizeLogCursor(
	value: string | null | undefined,
): string | undefined {
	const cursor = value?.trim();
	if (!cursor) return undefined;
	if (!isLogCursor(cursor)) {
		throw new RangeError("Invalid log cursor");
	}
	return cursor;
}

export function parseLogLimit(
	value: string | null | undefined,
	defaultValue: number,
	maxValue: number = 1000,
): number {
	if (value === null || value === undefined || value === "") {
		return defaultValue;
	}
	if (!/^\d+$/.test(value)) {
		throw new RangeError("Invalid log limit");
	}

	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new RangeError("Invalid log limit");
	}
	return Math.min(limit, maxValue);
}

export function parseLogListParams(
	searchParams: URLSearchParams,
	defaultLimit: number,
): {
	search: string | undefined;
	before: string | undefined;
	limit: number;
	range: LogTimeRange;
} {
	const search = normalizeLogSearch(searchParams.get("q"));
	const before = normalizeLogCursor(searchParams.get("before"));
	const limit = parseLogLimit(searchParams.get("limit"), defaultLimit);
	const rangeValue = searchParams.get("range") || DEFAULT_LOG_TIME_RANGE;
	const range = LOG_TIME_RANGES.find((option) => option === rangeValue);
	if (!range) {
		throw new RangeError("Invalid log range");
	}

	return { search, before, limit, range };
}

export function invalidLogQueryResponse(error: unknown): Response {
	return Response.json(
		{ message: error instanceof Error ? error.message : "Invalid log query" },
		{ status: 400 },
	);
}

export function escapeLogRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function splitLogSearchMatches(
	text: string,
	search: string,
): Array<{ text: string; isMatch: boolean }> {
	if (!search) return [{ text, isMatch: false }];

	const regex = new RegExp(`(${escapeLogRegex(search)})`, "gi");
	const normalizedSearch = search.toLowerCase();
	return text.split(regex).map((part) => ({
		text: part,
		isMatch: part.toLowerCase() === normalizedSearch,
	}));
}
