"use client";

import { useSyncExternalStore } from "react";
import {
	type DateFormatOptions,
	type DateInput,
	formatCompactDate,
	formatCompactDateTime,
	formatDate,
	formatDateTime,
	formatPreciseDateTime,
	formatTime,
	toDate,
} from "@/lib/date";

type LocalDateFormat =
	| "date"
	| "dateTime"
	| "preciseDateTime"
	| "time"
	| "compactDate"
	| "compactDateTime";

type DateFormatter = (
	value: DateInput | null | undefined,
	options?: DateFormatOptions,
) => string;

const FORMATTERS: Record<LocalDateFormat, DateFormatter> = {
	date: formatDate,
	dateTime: formatDateTime,
	preciseDateTime: formatPreciseDateTime,
	time: formatTime,
	compactDate: formatCompactDate,
	compactDateTime: formatCompactDateTime,
};

const subscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function LocalDate({
	value,
	format = "dateTime",
	fallback = "—",
}: {
	value: DateInput | null | undefined;
	format?: LocalDateFormat;
	fallback?: string;
}) {
	const isHydrated = useSyncExternalStore(
		subscribe,
		getClientSnapshot,
		getServerSnapshot,
	);
	const date = toDate(value);

	if (!date) return <>{fallback}</>;

	const label = FORMATTERS[format](date, {
		fallback,
		timeZone: isHydrated ? undefined : "UTC",
	});

	return (
		<time
			dateTime={date.toISOString()}
			className={isHydrated ? undefined : "invisible"}
			aria-hidden={isHydrated ? undefined : true}
		>
			{label}
		</time>
	);
}
