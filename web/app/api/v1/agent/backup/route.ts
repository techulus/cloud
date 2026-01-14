import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { volumeBackups } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { continueMigrationAfterBackup } from "@/actions/migrations";

export async function POST(request: NextRequest) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	let data: { backupId: string; sizeBytes: number; checksum: string };
	try {
		data = JSON.parse(body);
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const { backupId, sizeBytes, checksum } = data;

	if (!backupId || !checksum) {
		return NextResponse.json(
			{ error: "Missing required fields" },
			{ status: 400 },
		);
	}

	await db
		.update(volumeBackups)
		.set({
			status: "completed",
			sizeBytes,
			checksum,
			completedAt: new Date(),
		})
		.where(eq(volumeBackups.id, backupId));

	await continueMigrationAfterBackup(backupId);

	return NextResponse.json({ ok: true });
}
