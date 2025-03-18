import db from "@/db";
import { server } from "@/db/schema";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
	const headers = request.headers;
	const token = headers.get("x-agent-token");
	if (!token) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const serverDetails = await db.query.server.findFirst({
		where: eq(server.token, token),
	});
	if (!serverDetails) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const body = await request.json();

	const { containers, images, networks } = body;
	console.log(containers.length, images.length, networks.length);

	await db
		.update(server)
		.set({
			status: "active",
			configuration: JSON.stringify({ containers, images, networks }),
		})
		.where(eq(server.id, serverDetails.id));

	return NextResponse.json({ ok: true, actions: [] });
}
