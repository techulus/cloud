import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { volumeBackups } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { inngest } from "@/lib/inngest/client";
import { revalidatePath } from "next/cache";

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
		.select()
		.from(volumeBackups)
		.where(
			and(eq(volumeBackups.id, backupId), eq(volumeBackups.serverId, serverId)),
		)
		.then((r) => r[0]);

	if (!backup) {
		return NextResponse.json({ error: "Backup not found" }, { status: 404 });
	}

	await db
		.update(volumeBackups)
		.set({
			status: "failed",
			errorMessage: error || "Unknown error",
		})
		.where(eq(volumeBackups.id, backupId));

	revalidatePath("/dashboard/projects");

	await inngest.send({
		name: "backup/failed",
		data: {
			backupId,
			volumeId: backup.volumeId,
			serviceId: backup.serviceId,
			error: error || "Unknown error",
			isMigrationBackup: backup.isMigrationBackup ?? false,
		},
	});

	if (backup.isMigrationBackup) {
		await inngest.send({
			name: "migration/backup-failed",
			data: {
				backupId,
				serviceId: backup.serviceId,
				error: error || "Unknown error",
			},
		});
	}

	return NextResponse.json({ ok: true });
}
