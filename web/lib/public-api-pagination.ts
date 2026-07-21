type NamedCursor = {
	name: string;
	id: string;
};

export type NamedPage = {
	limit: number;
	cursor: NamedCursor | undefined;
};

export type TimestampCursor = {
	createdAt: string;
	id: string;
};

const timestampPattern =
	/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

function isValidTimestamp(value: string): boolean {
	const match = timestampPattern.exec(value);
	if (!match) return false;

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const offsetHour = Number(match[8] ?? 0);
	const offsetMinute = Number(match[9] ?? 0);
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
		year >= 1 &&
		daysInMonth !== undefined &&
		day >= 1 &&
		day <= daysInMonth &&
		hour <= 23 &&
		minute <= 59 &&
		second <= 59 &&
		(offsetHour < 14 || (offsetHour === 14 && offsetMinute === 0)) &&
		offsetMinute <= 59
	);
}

export function encodeTimestampCursor(value: TimestampCursor): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeTimestampCursor(
	value: string | null,
): TimestampCursor | null | undefined {
	if (!value) return undefined;
	if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;

	try {
		const parsed = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		) as Partial<TimestampCursor>;
		if (
			typeof parsed.id !== "string" ||
			parsed.id.length < 1 ||
			parsed.id.length > 200 ||
			typeof parsed.createdAt !== "string" ||
			!isValidTimestamp(parsed.createdAt)
		) {
			return null;
		}
		return { id: parsed.id, createdAt: parsed.createdAt };
	} catch {
		return null;
	}
}

export function timestampPage(url: URL): {
	limit: number;
	cursor: TimestampCursor | undefined;
} {
	const rawLimit = url.searchParams.get("limit");
	const limit = rawLimit === null ? 25 : Number(rawLimit);
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new RangeError("limit must be an integer from 1 to 100");
	}

	const cursor = decodeTimestampCursor(url.searchParams.get("cursor"));
	if (cursor === null) throw new RangeError("Invalid cursor");
	return { limit, cursor };
}

export function nextTimestampCursor<
	T extends { id: string; cursorCreatedAt: string },
>(items: T[], limit: number): string | null {
	const last = items.slice(0, limit).at(-1);
	return items.length > limit && last
		? encodeTimestampCursor({
				id: last.id,
				createdAt: last.cursorCreatedAt,
			})
		: null;
}

function decodeCursor(value: string | null): NamedCursor | null | undefined {
	if (!value) return undefined;
	if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;

	try {
		const parsed = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		) as Partial<NamedCursor>;
		if (
			typeof parsed.name !== "string" ||
			parsed.name.length > 512 ||
			typeof parsed.id !== "string" ||
			parsed.id.length < 1 ||
			parsed.id.length > 200
		) {
			return null;
		}
		return { name: parsed.name, id: parsed.id };
	} catch {
		return null;
	}
}

export function namedPage(url: URL): NamedPage {
	const rawLimit = url.searchParams.get("limit");
	const limit = rawLimit === null ? 100 : Number(rawLimit);
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new RangeError("limit must be an integer from 1 to 100");
	}

	const cursor = decodeCursor(url.searchParams.get("cursor"));
	if (cursor === null) throw new RangeError("Invalid cursor");
	return { limit, cursor };
}

export function nextNamedCursor<T extends NamedCursor>(
	items: T[],
	limit: number,
): string | null {
	const last = items.slice(0, limit).at(-1);
	return items.length > limit && last
		? Buffer.from(
				JSON.stringify({ name: last.name, id: last.id }),
				"utf8",
			).toString("base64url")
		: null;
}
