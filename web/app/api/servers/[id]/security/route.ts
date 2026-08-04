import { headers } from "next/headers";
import { getServerDetails } from "@/db/queries";
import { auth } from "@/lib/auth";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return new Response("Unauthorized", { status: 401 });
	}

	const { id } = await params;
	const server = await getServerDetails(id);

	if (!server?.isProxy) {
		return Response.json({ message: "Server not found" }, { status: 404 });
	}

	return Response.json({
		status: server.status,
		crowdsecHealth: server.crowdsecHealth ?? null,
	});
}
