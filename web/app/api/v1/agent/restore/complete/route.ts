import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { volumeBackups, services } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyAgentRequest } from "@/lib/agent-auth";

export async function POST(request: NextRequest) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	let data: { backupId: string; success: boolean; error?: string };
	try {
		data = JSON.parse(body);
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const { backupId, success, error } = data;

	if (!backupId) {
		return NextResponse.json({ error: "Missing backupId" }, { status: 400 });
	}

	const backup = await db
		.select()
		.from(volumeBackups)
		.where(eq(volumeBackups.id, backupId))
		.then((r) => r[0]);

	if (!backup || !backup.isMigrationBackup) {
		return NextResponse.json({ ok: true });
	}

	if (!success) {
		await db
			.update(services)
			.set({
				migrationStatus: "failed",
				migrationError: error || "Restore failed",
			})
			.where(eq(services.id, backup.serviceId));
	}

	return NextResponse.json({ ok: true });
}
