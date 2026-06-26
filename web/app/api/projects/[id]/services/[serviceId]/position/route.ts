import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";
import { db } from "@/db";
import { services } from "@/db/schema";
import { auth } from "@/lib/auth";

const positionSchema = z.object({
	canvasX: z.number().int().min(0).max(10000),
	canvasY: z.number().int().min(0).max(10000),
});

export async function PATCH(
	request: Request,
	{ params }: { params: Promise<{ id: string; serviceId: string }> },
) {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { id: projectId, serviceId } = await params;
	const parsed = positionSchema.safeParse(await request.json());

	if (!parsed.success) {
		return Response.json({ error: "Invalid position" }, { status: 400 });
	}

	const [service] = await db
		.update(services)
		.set(parsed.data)
		.where(
			and(
				eq(services.id, serviceId),
				eq(services.projectId, projectId),
				isNull(services.deletedAt),
			),
		)
		.returning({
			id: services.id,
			canvasX: services.canvasX,
			canvasY: services.canvasY,
		});

	if (!service) {
		return Response.json({ error: "Service not found" }, { status: 404 });
	}

	return Response.json(service);
}
