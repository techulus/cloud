import db from "@/db";
import { deployment, project, server } from "@/db/schema";
import { eq } from "drizzle-orm";
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

	const body = JSON.parse(rawBody);

	const { containers, images, networks } = body;

	await db
		.update(server)
		.set({
			status: "active",
			configuration: JSON.stringify({ containers, images, networks }),
		})
		.where(eq(server.id, serverDetails.id));

	const projectsWithServices = await db.query.project.findMany({
		where: eq(project.organizationId, serverDetails.organizationId),
		with: {
			services: {
				with: {
					deployments: {
						where: eq(deployment.status, "pending"),
					},
				},
			},
		},
	});

	const actions: {
		service_id: string;
		deployment_id: string;
		operation: "create" | "update" | "delete";
		image: string;
		tag: string;
		secrets: {
			name: string;
			value: string;
		}[];
	}[] = [];

	for (const project of projectsWithServices) {
		for (const service of project.services) {
			if (!service.configuration) {
				continue;
			}

			actions.push({
				service_id: service.id,
				deployment_id: service.deployments[0].id,
				operation: "create",
				image: service.configuration.image,
				tag: service.configuration.tag ?? "latest",
				secrets: [
					{
						name: "BROADCAST_KEY",
						value: "test",
					},
					{
						name: "SIGNING_KEY",
						value: "test",
					},
				],
			});
		}
	}

	console.log(JSON.stringify(actions, null, 2));

	return NextResponse.json({ ok: true, actions });
}
