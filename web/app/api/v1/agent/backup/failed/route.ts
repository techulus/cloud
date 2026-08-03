import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { volumeBackups } from "@/db/schema";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";

export async function POST(request: NextRequest) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	let data: { backupId: string; error: string };
	try {
		data = JSON.parse(body);
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const { backupId, error } = data;

	if (!backupId) {
		return NextResponse.json({ error: "Missing backupId" }, { status: 400 });
	}

	const { serverId } = auth;

	const backup = await db
		.update(volumeBackups)
		.set({
			status: "failed",
			errorMessage: error || "Unknown error",
		})
		.where(
			and(
				eq(volumeBackups.id, backupId),
				eq(volumeBackups.serverId, serverId),
				inArray(volumeBackups.status, ["pending", "uploading"]),
			),
		)
		.returning({ serviceId: volumeBackups.serviceId })
		.then((rows) => rows[0]);

	if (!backup) {
		return NextResponse.json({ ok: true });
	}

	revalidatePath("/dashboard/projects");

	await inngest.send(
		inngestEvents.resourceStatusChanged.create(
			{
				type: "backup",
				id: backupId,
				parentType: "service",
				parentId: backup.serviceId,
			},
			{ id: `backup-failed-${backupId}` },
		),
	);
	return NextResponse.json({ ok: true });
}
