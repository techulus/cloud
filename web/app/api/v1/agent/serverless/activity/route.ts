import { type NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "@/lib/agent-auth";
import {
	isProxyServer,
	recordServerlessRequestFinish,
	recordServerlessRequestHeartbeat,
	recordServerlessRequestStart,
	resolveServerlessServiceId,
} from "@/lib/serverless";

type ActivityRequestBody = {
	serviceId?: string;
	host?: string;
	event?: "start" | "heartbeat" | "finish";
};

export async function POST(request: NextRequest) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	if (!(await isProxyServer(auth.serverId))) {
		return NextResponse.json(
			{ error: "Serverless activity is only available to proxy servers" },
			{ status: 403 },
		);
	}

	let data: ActivityRequestBody;
	try {
		data = body ? JSON.parse(body) : {};
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (
		data.event !== "start" &&
		data.event !== "heartbeat" &&
		data.event !== "finish"
	) {
		return NextResponse.json(
			{ error: "event must be 'start', 'heartbeat', or 'finish'" },
			{ status: 400 },
		);
	}

	const serviceId = await resolveServerlessServiceId({
		serviceId: data.serviceId,
		host: data.host,
	});
	if (!serviceId) {
		return NextResponse.json({ error: "Service not found" }, { status: 404 });
	}

	if (data.event === "start") {
		await recordServerlessRequestStart({
			serviceId,
			proxyServerId: auth.serverId,
		});
	} else if (data.event === "heartbeat") {
		await recordServerlessRequestHeartbeat({
			serviceId,
			proxyServerId: auth.serverId,
		});
	} else {
		await recordServerlessRequestFinish({
			serviceId,
			proxyServerId: auth.serverId,
		});
	}

	return NextResponse.json({ ok: true, serviceId });
}
