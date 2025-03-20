import db from "@/db";
import { deployment, server } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { createHmac } from "node:crypto";

function computeSignature(body: string, secret: string) {
	const hmac = createHmac("sha256", secret);
	hmac.update(body);
	return hmac.digest("base64");
}

export async function POST(request: NextRequest) {
	const headers = request.headers;
	const token = headers.get("x-agent-token");
	if (!token) {
		return NextResponse.json(
			{ ok: false, error: "Unauthorized" },
			{ status: 401 },
		);
	}

	const signature = headers.get("x-message-signature");
	if (!signature) {
		return NextResponse.json(
			{ ok: false, error: "Unauthorized" },
			{ status: 401 },
		);
	}

	const serverDetails = await db.query.server.findFirst({
		where: eq(server.token, token),
	});
	if (!serverDetails) {
		return NextResponse.json(
			{ ok: false, error: "Unauthorized" },
			{ status: 401 },
		);
	}

	const rawBody = await request.text();
	const expectedSignature = computeSignature(rawBody, serverDetails.secret);

	if (signature !== expectedSignature) {
		return NextResponse.json(
			{ ok: false, error: "Unauthorized" },
			{ status: 401 },
		);
	}

	const { deployment_id, logs } = JSON.parse(rawBody);

	await db
		.update(deployment)
		.set({
			logs,
		})
		.where(eq(deployment.id, deployment_id));

	return NextResponse.json({ ok: true });
}
