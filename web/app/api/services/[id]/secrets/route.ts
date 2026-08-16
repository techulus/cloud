import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { db } from "@/db";
import { getService } from "@/db/queries";
import { secrets } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { id: serviceId } = await params;
	if (!(await getService(serviceId))) {
		return Response.json({ error: "Service not found" }, { status: 404 });
	}

	const secretsList = await db
		.select({
			id: secrets.id,
			key: secrets.key,
			createdAt: secrets.createdAt,
		})
		.from(secrets)
		.where(eq(secrets.serviceId, serviceId))
		.orderBy(secrets.createdAt);

	return Response.json(secretsList);
}
