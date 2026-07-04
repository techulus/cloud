import { type NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "@/lib/agent-auth";
import {
	isProxyServer,
	resolveServerlessTarget,
	wakeAndWaitForServerlessService,
	wakeServerlessService,
} from "@/lib/serverless";

export const maxDuration = 960;

type WakeRequestBody = {
	serviceId?: string;
	host?: string;
	wait?: boolean;
};

export async function POST(request: NextRequest) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	if (!(await isProxyServer(auth.serverId))) {
		return NextResponse.json(
			{ error: "Serverless wake is only available to proxy servers" },
			{ status: 403 },
		);
	}

	let data: WakeRequestBody;
	try {
		data = body ? JSON.parse(body) : {};
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const target = await resolveServerlessTarget({
		serviceId: data.serviceId,
		host: data.host,
	});
	if (!target) {
		return NextResponse.json({ error: "Service not found" }, { status: 404 });
	}

	const result =
		data.wait === false
			? await wakeServerlessService({
					serviceId: target.serviceId,
					port: target.port,
					proxyServerId: auth.serverId,
				})
			: await wakeAndWaitForServerlessService({
					serviceId: target.serviceId,
					port: target.port,
					proxyServerId: auth.serverId,
				});

	if (result.status === "not_found") {
		return NextResponse.json(
			{ error: "Service not found", result },
			{ status: 404 },
		);
	}
	if (result.status === "not_serverless") {
		return NextResponse.json(
			{ error: "Service is not serverless", result },
			{ status: 409 },
		);
	}
	if (result.status === "unsupported") {
		return NextResponse.json(
			{
				error: "Serverless wake only supports stateless public HTTP services",
				result,
			},
			{ status: 422 },
		);
	}
	if (result.status === "no_deployments") {
		return NextResponse.json(
			{ error: "No sleeping or ready deployments found", result },
			{ status: 409 },
		);
	}
	if ("timedOut" in result && result.timedOut) {
		return NextResponse.json(
			{ error: "Timed out waiting for serverless service to wake", result },
			{ status: 504 },
		);
	}

	return NextResponse.json({ ok: true, result });
}
