import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { auth } from "@/lib/auth";

const PAGE_SIZE = 20;

type Cursor = { createdAt: string; id: string };

function decodeCursor(value: string | null): Cursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(
			Buffer.from(value, "base64url").toString(),
		) as Cursor;
		if (!parsed.id || Number.isNaN(new Date(parsed.createdAt).getTime()))
			return null;
		return parsed;
	} catch {
		return null;
	}
}

function encodeCursor(cursor: Cursor) {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export async function GET(request: NextRequest) {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session)
		return Response.json({ error: "Unauthorized" }, { status: 401 });

	const cursorValue = new URL(request.url).searchParams.get("cursor");
	const cursor = decodeCursor(cursorValue);
	if (cursorValue && !cursor) {
		return Response.json({ error: "Invalid cursor" }, { status: 400 });
	}

	const cursorCondition = cursor
		? or(
				lt(notifications.createdAt, new Date(cursor.createdAt)),
				and(
					eq(notifications.createdAt, new Date(cursor.createdAt)),
					lt(notifications.id, cursor.id),
				),
			)
		: undefined;
	const [rows, unreadRows] = await Promise.all([
		db
			.select({
				id: notifications.id,
				kind: notifications.kind,
				title: notifications.title,
				body: notifications.body,
				href: notifications.href,
				readAt: notifications.readAt,
				createdAt: notifications.createdAt,
			})
			.from(notifications)
			.where(
				cursorCondition
					? and(eq(notifications.userId, session.user.id), cursorCondition)
					: eq(notifications.userId, session.user.id),
			)
			.orderBy(desc(notifications.createdAt), desc(notifications.id))
			.limit(PAGE_SIZE + 1),
		db
			.select({ count: sql<number>`count(*)::int` })
			.from(notifications)
			.where(
				and(
					eq(notifications.userId, session.user.id),
					isNull(notifications.readAt),
				),
			),
	]);
	const hasMore = rows.length > PAGE_SIZE;
	const page = rows.slice(0, PAGE_SIZE);
	const last = page.at(-1);

	return Response.json({
		notifications: page,
		unreadCount: unreadRows[0]?.count ?? 0,
		nextCursor:
			hasMore && last
				? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
				: null,
	});
}
