export const dynamic = "force-dynamic";

import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { listEnvironments } from "@/db/queries";

export async function GET(
	_: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { id: projectId } = await params;
	const envs = await listEnvironments(projectId);

	return Response.json(envs);
}
