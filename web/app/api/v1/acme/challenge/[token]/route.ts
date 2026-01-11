import { NextRequest } from "next/server";
import { getChallenge } from "@/lib/acme-manager";

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ token: string }> },
) {
	const { token } = await params;

	const challenge = await getChallenge(token);

	if (!challenge) {
		return new Response("Not Found", { status: 404 });
	}

	return new Response(challenge.keyAuthorization, {
		status: 200,
		headers: { "Content-Type": "text/plain" },
	});
}
