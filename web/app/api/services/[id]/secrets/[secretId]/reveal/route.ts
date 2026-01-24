export const dynamic = "force-dynamic";

import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { db } from "@/db";
import { secrets } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { decryptSecret } from "@/lib/crypto";

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string; secretId: string }> },
) {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { id: serviceId, secretId } = await params;

	const secret = await db
		.select({ encryptedValue: secrets.encryptedValue })
		.from(secrets)
		.where(and(eq(secrets.id, secretId), eq(secrets.serviceId, serviceId)))
		.limit(1);

	if (secret.length === 0) {
		return Response.json({ error: "Secret not found" }, { status: 404 });
	}

	try {
		const decryptedValue = decryptSecret(secret[0].encryptedValue);

		return new Response(JSON.stringify({ value: decryptedValue }), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store, no-cache, must-revalidate, private",
				Pragma: "no-cache",
				Expires: "0",
				Vary: "Authorization",
			},
		});
	} catch {
		return Response.json(
			{ error: "Failed to decrypt secret" },
			{ status: 500 },
		);
	}
}
