export const dynamic = "force-dynamic";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { secrets } from "@/db/schema";
import { requireRequestDeveloperRole } from "@/lib/api-auth";
import { decryptSecret } from "@/lib/crypto";
import { EncryptionKeyUnavailableError } from "@/lib/kms";

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string; secretId: string }> },
) {
	const sessionResult = await requireRequestDeveloperRole(request);
	if (!sessionResult.ok) {
		return sessionResult.response;
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
		const decryptedValue = await decryptSecret(secret[0].encryptedValue);

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
	} catch (error) {
		if (error instanceof EncryptionKeyUnavailableError) {
			console.error("Secret encryption key unavailable:", error);
			return Response.json(
				{ error: "Secret encryption service unavailable" },
				{ status: 503 },
			);
		}
		return Response.json(
			{ error: "Failed to decrypt secret" },
			{ status: 500 },
		);
	}
}
