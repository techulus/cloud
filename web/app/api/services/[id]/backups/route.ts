import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { volumeBackups, servers } from "@/db/schema";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const { id: serviceId } = await params;

		const backups = await db
			.select({
				id: volumeBackups.id,
				volumeName: volumeBackups.volumeName,
				status: volumeBackups.status,
				sizeBytes: volumeBackups.sizeBytes,
				createdAt: volumeBackups.createdAt,
				completedAt: volumeBackups.completedAt,
				errorMessage: volumeBackups.errorMessage,
				serverName: servers.name,
			})
			.from(volumeBackups)
			.leftJoin(servers, eq(volumeBackups.serverId, servers.id))
			.where(eq(volumeBackups.serviceId, serviceId))
			.orderBy(desc(volumeBackups.createdAt));

		return NextResponse.json({ backups });
	} catch (error) {
		console.error("[api:backups] failed to fetch backups:", error);
		return NextResponse.json(
			{ error: "Failed to fetch backups" },
			{ status: 500 },
		);
	}
}
