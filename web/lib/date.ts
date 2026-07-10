/** A Date, parseable date string, or Unix timestamp in milliseconds. */
export type DateInput = Date | string | number;

export type DateFormatOptions = {
	fallback?: string;
	timeZone?: string;
};

type DateFormat =
	| "date"
	| "dateTime"
	| "preciseDateTime"
	| "time"
	| "compactDate"
	| "compactDateTime"
	| "utcDateTime";

const DEFAULT_FALLBACK = "—";
const DATE_LOCALE = "en-US";

export const SECOND_IN_MILLISECONDS = 1_000;
export const MINUTE_IN_MILLISECONDS = 60 * SECOND_IN_MILLISECONDS;
export const HOUR_IN_MILLISECONDS = 60 * MINUTE_IN_MILLISECONDS;
export const DAY_IN_MILLISECONDS = 24 * HOUR_IN_MILLISECONDS;

const DATE_FORMATS: Record<DateFormat, Intl.DateTimeFormatOptions> = {
	date: {
		year: "numeric",
		month: "short",
		day: "numeric",
	},
	dateTime: {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	},
	preciseDateTime: {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	},
	time: {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	},
	compactDate: {
		month: "short",
		day: "numeric",
	},
	compactDateTime: {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	},
	utcDateTime: {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZone: "UTC",
		timeZoneName: "short",
	},
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(format: DateFormat, timeZone?: string) {
	const cacheKey = `${format}:${timeZone ?? "local"}`;
	const cached = formatterCache.get(cacheKey);
	if (cached) return cached;

	const formatter = new Intl.DateTimeFormat(DATE_LOCALE, {
		...DATE_FORMATS[format],
		...(timeZone ? { timeZone } : {}),
	});
	formatterCache.set(cacheKey, formatter);
	return formatter;
}

function requireDate(value: DateInput): Date {
	const date = toDate(value);
	if (!date) throw new RangeError("Invalid date");
	return date;
}

function requireValidResult(date: Date): Date {
	if (Number.isNaN(date.getTime())) {
		throw new RangeError("Date arithmetic produced an out-of-range date");
	}
	return date;
}

function requireFinite(value: number, name: string) {
	if (!Number.isFinite(value)) {
		throw new RangeError(`${name} must be a finite number`);
	}
}

function requireInteger(value: number, name: string) {
	requireFinite(value, name);
	if (!Number.isInteger(value)) {
		throw new RangeError(`${name} must be an integer`);
	}
}

function formatWith(
	value: DateInput | null | undefined,
	format: DateFormat,
	options: DateFormatOptions = {},
) {
	const date = toDate(value);
	if (!date) return options.fallback ?? DEFAULT_FALLBACK;
	return getFormatter(format, options.timeZone).format(date);
}

/** Parses leniently and returns null for missing or invalid inputs. */
export function toDate(value: DateInput | null | undefined): Date | null {
	if (value === null || value === undefined || value === "") return null;

	const date =
		value instanceof Date ? new Date(value.getTime()) : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Returns epoch milliseconds, or the supplied fallback for invalid inputs. */
export function getTimestamp(
	value: DateInput | null | undefined,
	fallback = Number.NaN,
): number {
	return toDate(value)?.getTime() ?? fallback;
}

export function formatDate(
	value: DateInput | null | undefined,
	options?: DateFormatOptions,
): string {
	return formatWith(value, "date", options);
}

export function formatDateTime(
	value: DateInput | null | undefined,
	options?: DateFormatOptions,
): string {
	return formatWith(value, "dateTime", options);
}

export function formatPreciseDateTime(
	value: DateInput | null | undefined,
	options?: DateFormatOptions,
): string {
	return formatWith(value, "preciseDateTime", options);
}

export function formatDateTimeUtc(
	value: DateInput | null | undefined,
	options: Pick<DateFormatOptions, "fallback"> = {},
): string {
	return formatWith(value, "utcDateTime", options);
}

export function formatTime(
	value: DateInput | null | undefined,
	options?: DateFormatOptions,
): string {
	return formatWith(value, "time", options);
}

export function formatCompactDate(
	value: DateInput | null | undefined,
	options?: DateFormatOptions,
): string {
	return formatWith(value, "compactDate", options);
}

export function formatCompactDateTime(
	value: DateInput | null | undefined,
	options?: DateFormatOptions,
): string {
	return formatWith(value, "compactDateTime", options);
}

export function formatRelativeTime(
	value: DateInput | null | undefined,
	options: DateFormatOptions & { now?: DateInput } = {},
): string {
	const date = toDate(value);
	const now = toDate(options.now ?? new Date());
	if (!date || !now) return options.fallback ?? DEFAULT_FALLBACK;

	const differenceMs = date.getTime() - now.getTime();
	const isFuture = differenceMs > 0;
	const absoluteSeconds = Math.floor(
		Math.abs(differenceMs) / SECOND_IN_MILLISECONDS,
	);

	if (absoluteSeconds < 60) return "just now";

	const absoluteMinutes = Math.floor(absoluteSeconds / 60);
	if (absoluteMinutes < 60) {
		return isFuture ? `in ${absoluteMinutes}m` : `${absoluteMinutes}m ago`;
	}

	const absoluteHours = Math.floor(absoluteMinutes / 60);
	if (absoluteHours < 24) {
		return isFuture ? `in ${absoluteHours}h` : `${absoluteHours}h ago`;
	}

	const absoluteDays = Math.floor(absoluteHours / 24);
	if (absoluteDays < 7) {
		return isFuture ? `in ${absoluteDays}d` : `${absoluteDays}d ago`;
	}

	return formatDate(date, options);
}

export function formatElapsedDuration(
	durationMs: number,
	options: Pick<DateFormatOptions, "fallback"> = {},
): string {
	if (!Number.isFinite(durationMs)) {
		return options.fallback ?? DEFAULT_FALLBACK;
	}

	const totalSeconds = Math.max(
		0,
		Math.floor(durationMs / SECOND_IN_MILLISECONDS),
	);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
	}
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export function formatElapsedDurationBetween(
	start: DateInput | null | undefined,
	end: DateInput | null | undefined,
	options: Pick<DateFormatOptions, "fallback"> & { now?: DateInput } = {},
): string {
	const startDate = toDate(start);
	const endDate = toDate(end ?? options.now ?? new Date());
	if (!startDate || !endDate) return options.fallback ?? DEFAULT_FALLBACK;

	return formatElapsedDuration(
		endDate.getTime() - startDate.getTime(),
		options,
	);
}

/** Compares valid inputs and throws RangeError if either input is invalid. */
export function isDateBefore(left: DateInput, right: DateInput): boolean {
	return requireDate(left) < requireDate(right);
}

/** Compares valid inputs and throws RangeError if either input is invalid. */
export function isDateAfter(left: DateInput, right: DateInput): boolean {
	return requireDate(left) > requireDate(right);
}

/** Fail-closed: a missing or invalid expiry is treated as expired. */
export function isExpired(
	expiresAt: DateInput | null | undefined,
	now: DateInput = new Date(),
): boolean {
	const expiryDate = toDate(expiresAt);
	if (!expiryDate) return true;
	return expiryDate.getTime() <= requireDate(now).getTime();
}

export function addMilliseconds(date: DateInput, amount: number): Date {
	requireInteger(amount, "amount");
	return requireValidResult(new Date(requireDate(date).getTime() + amount));
}

export function subtractMilliseconds(date: DateInput, amount: number): Date {
	return addMilliseconds(date, -amount);
}

export function addUtcDays(date: DateInput, days: number): Date {
	requireInteger(days, "days");
	const result = requireDate(date);
	result.setUTCDate(result.getUTCDate() + days);
	return requireValidResult(result);
}

export function subtractUtcDays(date: DateInput, days: number): Date {
	return addUtcDays(date, -days);
}

export function differenceInMilliseconds(
	later: DateInput,
	earlier: DateInput,
): number {
	return requireDate(later).getTime() - requireDate(earlier).getTime();
}

export function differenceInElapsedHours(
	later: DateInput,
	earlier: DateInput,
): number {
	return differenceInMilliseconds(later, earlier) / HOUR_IN_MILLISECONDS;
}

export function differenceInElapsedDays(
	later: DateInput,
	earlier: DateInput,
): number {
	return differenceInMilliseconds(later, earlier) / DAY_IN_MILLISECONDS;
}
