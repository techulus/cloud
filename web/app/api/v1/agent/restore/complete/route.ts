import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { volumeBackups } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { inngest } from "@/lib/inngest/client";
import { revalidatePath } from "next/cache";

export async function POST(request: NextRequest) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	let data: {
		backupId: string;
		success: boolean;
		error?: string;
		isMigrationRestore?: boolean;
	};
	try {
		data = JSON.parse(body);
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const { backupId, success, error, isMigrationRestore } = data;

	if (!backupId) {
		return NextResponse.json({ error: "Missing backupId" }, { status: 400 });
	}

	const backup = await db
		.select()
		.from(volumeBackups)
		.where(eq(volumeBackups.id, backupId))
		.then((r) => r[0]);

	if (!backup) {
		return NextResponse.json({ ok: true });
	}

	const isMigration = isMigrationRestore ?? backup.isMigrationBackup ?? false;

	revalidatePath("/dashboard/projects");

	if (success) {
		await inngest.send({
			name: "restore/completed",
			data: {
				backupId,
				volumeId: backup.volumeId,
				serviceId: backup.serviceId,
				isMigrationRestore: isMigration,
			},
		});

		if (isMigration) {
			await inngest.send({
				name: "migration/restore-completed",
				data: {
					backupId,
					serviceId: backup.serviceId,
				},
			});
		}
	} else {
		await inngest.send({
			name: "restore/failed",
			data: {
				backupId,
				volumeId: backup.volumeId,
				serviceId: backup.serviceId,
				error: error || "Restore failed",
				isMigrationRestore: isMigration,
			},
		});

		if (isMigration) {
			await inngest.send({
				name: "migration/restore-failed",
				data: {
					backupId,
					serviceId: backup.serviceId,
					error: error || "Restore failed",
				},
			});
		}
	}

	return NextResponse.json({ ok: true });
}
