import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { workQueue } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { deployService } from "@/actions/projects";
import { inngest } from "@/lib/inngest/client";

export async function POST(request: NextRequest) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	let data: { id?: string; status?: "completed" | "failed"; error?: string };
	try {
		data = JSON.parse(body);
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (
		typeof data.id !== "string" ||
		(data.status !== "completed" && data.status !== "failed")
	) {
		return NextResponse.json(
			{ error: "Missing required fields: id, status" },
			{ status: 400 },
		);
	}

	const { serverId } = auth;

	const result = await db
		.update(workQueue)
		.set({
			status: data.status,
		})
		.where(and(eq(workQueue.id, data.id), eq(workQueue.serverId, serverId)))
		.returning();

	if (result.length === 0) {
		return NextResponse.json(
			{ error: "Work queue item not found" },
			{ status: 404 },
		);
	}

	const item = result[0];

	if (item.type === "create_manifest" && item.payload) {
		try {
			const payload = JSON.parse(item.payload) as {
				serviceId?: string;
				finalImageUri?: string;
				buildGroupId?: string;
			};

			if (data.status === "completed") {
				if (payload.serviceId && payload.finalImageUri) {
					await inngest.send({
						name: "manifest/completed",
						data: {
							serviceId: payload.serviceId,
							buildGroupId: payload.buildGroupId || "",
							imageUri: payload.finalImageUri,
						},
					});
				}

				if (payload.serviceId) {
					console.log(
						`[work-queue] create_manifest completed, triggering deployment for service ${payload.serviceId}`,
					);
					deployService(payload.serviceId).catch((error) => {
						console.error(
							`[work-queue] deployment failed after create_manifest:`,
							error,
						);
					});
				}
			} else if (data.status === "failed" && payload.serviceId) {
				await inngest.send({
					name: "manifest/failed",
					data: {
						serviceId: payload.serviceId,
						buildGroupId: payload.buildGroupId || "",
						error: data.error || "Manifest creation failed",
					},
				});
			}
		} catch (error) {
			console.error(`[work-queue] failed to parse payload:`, error);
		}
	}

	return NextResponse.json({ ok: true });
}
