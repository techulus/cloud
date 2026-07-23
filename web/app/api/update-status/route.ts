import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { refreshControlPlaneUpgradeState } from "@/lib/control-plane-updates";

export async function GET() {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const state = await refreshControlPlaneUpgradeState();
	return Response.json(state);
}
