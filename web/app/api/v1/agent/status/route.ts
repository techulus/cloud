import { type NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "@/lib/agent-auth";
import {
	applyStatusReport,
	type StatusReport,
} from "@/lib/agent-status";
import {
	type ActiveWorkItem,
	claimNextWorkItem,
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

	if (!data.statusReport || !Array.isArray(data.statusReport.containers)) {
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
		? data.activeWorkItems.filter(isValidActiveWorkItem)
		: [];

	const { accepted, rejected } = await completeWorkItemResults(
		serverId,
		completedWorkItems,
	);

	const rejectedActive = await renewActiveWorkItems(serverId, activeWorkItems);

	const nextWorkItem =
		activeWorkItems.length === 0 ? await claimNextWorkItem(serverId) : null;

	return NextResponse.json({
		ok: true,
		acceptedWorkItemResults: accepted,
		rejectedWorkItemResults: rejected,
		rejectedActiveWorkItems: rejectedActive,
		serverlessTransitionResults,
		workItems: nextWorkItem ? [nextWorkItem] : [],
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

function isValidActiveWorkItem(value: unknown): value is ActiveWorkItem {
	if (!value || typeof value !== "object") return false;

	const candidate = value as ActiveWorkItem;
	return (
		typeof candidate.id === "string" &&
		Number.isInteger(candidate.attempt) &&
		candidate.attempt > 0
	);
}
