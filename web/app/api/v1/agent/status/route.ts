import { type NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { applyStatusReport, type StatusReport } from "@/lib/agent-status";
import {
	type ActiveWorkItem,
	claimWorkItems,
	completeWorkItemResults,
	renewActiveWorkItems,
	type WorkItemResult,
} from "@/lib/work-queue";

type StatusRequestBody = {
	statusReport?: StatusReport;
	completedWorkItems?: WorkItemResult[];
	activeWorkItems?: ActiveWorkItem[];
	serverlessTransitions?: unknown[];
};

export async function POST(request: NextRequest) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	let data: StatusRequestBody;
	try {
		data = JSON.parse(body);
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (
		!data.statusReport ||
		!Array.isArray(data.statusReport.containers) ||
		typeof data.statusReport.containersComplete !== "boolean"
	) {
		return NextResponse.json(
			{ error: "Invalid statusReport payload" },
			{ status: 400 },
		);
	}

	const { serverId } = auth;

	const serverlessTransitions = Array.isArray(data.serverlessTransitions)
		? data.serverlessTransitions
		: [];

	const { serverlessTransitionResults } = await applyStatusReport(
		serverId,
		data.statusReport,
		serverlessTransitions,
	);

	const completedWorkItems = Array.isArray(data.completedWorkItems)
		? data.completedWorkItems.filter(isValidWorkItemResult)
		: [];
	const activeWorkItems = Array.isArray(data.activeWorkItems)
		? data.activeWorkItems
		: [];
	if (!activeWorkItems.every(isValidActiveWorkItem)) {
		return NextResponse.json(
			{ error: "Invalid activeWorkItems payload" },
			{ status: 400 },
		);
	}

	const { accepted, rejected } = await completeWorkItemResults(
		serverId,
		completedWorkItems,
	);

	const rejectedActive = await renewActiveWorkItems(serverId, activeWorkItems);

	const workItems = await claimWorkItems(serverId, activeWorkItems);

	return NextResponse.json({
		ok: true,
		acceptedWorkItemResults: accepted,
		rejectedWorkItemResults: rejected,
		rejectedActiveWorkItems: rejectedActive,
		serverlessTransitionResults,
		workItems,
	});
}

function isValidWorkItemResult(value: unknown): value is WorkItemResult {
	if (!value || typeof value !== "object") return false;

	const candidate = value as WorkItemResult;
	return (
		typeof candidate.id === "string" &&
		Number.isInteger(candidate.attempt) &&
		candidate.attempt > 0 &&
		(candidate.status === "completed" || candidate.status === "failed") &&
		(candidate.error === undefined || typeof candidate.error === "string")
	);
}

function isValidWorkType(value: unknown): value is ActiveWorkItem["type"] {
	switch (value) {
		case "deploy":
		case "reconcile":
		case "stop":
		case "restart":
		case "build":
		case "create_manifest":
		case "force_cleanup":
		case "cleanup_volumes":
		case "backup_volume":
		case "restore_volume":
		case "upgrade_agent":
			return true;
		default:
			return false;
	}
}

function isValidActiveWorkItem(value: unknown): value is ActiveWorkItem {
	if (!value || typeof value !== "object") return false;

	const candidate = value as ActiveWorkItem;
	return (
		typeof candidate.id === "string" &&
		isValidWorkType(candidate.type) &&
		Number.isInteger(candidate.attempt) &&
		candidate.attempt > 0
	);
}
