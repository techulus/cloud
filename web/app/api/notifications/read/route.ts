import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { auth } from "@/lib/auth";

export async function POST(request: Request) {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session)
		return Response.json({ error: "Unauthorized" }, { status: 401 });

	const body = (await request.json().catch(() => null)) as {
		id?: unknown;
		markAll?: unknown;
	} | null;
	if (!body || (typeof body.id !== "string" && body.markAll !== true)) {
		return Response.json(
			{ error: "Provide a notification ID or markAll" },
			{ status: 400 },
		);
	}

	const conditions = [
		eq(notifications.userId, session.user.id),
		isNull(notifications.readAt),
	];
	if (typeof body.id === "string")
		conditions.push(eq(notifications.id, body.id));
	const updated = await db
		.update(notifications)
		.set({ readAt: new Date() })
		.where(and(...conditions))
		.returning({ id: notifications.id });

	return Response.json({ updated: updated.length });
}
