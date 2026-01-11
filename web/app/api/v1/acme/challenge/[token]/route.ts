import { NextRequest } from "next/server";
import { getChallenge } from "@/lib/acme-manager";

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ token: string }> },
) {
	const { token } = await params;

	console.log(`[acme-challenge] received request for token=${token}`);

	const challenge = await getChallenge(token);

	if (!challenge) {
		console.log(`[acme-challenge] token=${token} not found or expired`);
		return new Response("Not Found", { status: 404 });
	}

	console.log(
		`[acme-challenge] token=${token} found, returning key authorization`,
	);
	return new Response(challenge.keyAuthorization, {
		status: 200,
		headers: { "Content-Type": "text/plain" },
	});
}
