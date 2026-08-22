import { type NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { reportServerError } from "@/lib/server-errors";
import { hasClaimableWork } from "@/lib/work-queue";
import {
	subscribeToWorkNotifications,
	type WorkNotificationSubscription,
} from "@/lib/work-queue-notifications";

const WORK_WAIT_TIMEOUT_MS = 20_000;

export async function GET(request: NextRequest) {
	const auth = await verifyAgentRequest(request, "");
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	let subscription: WorkNotificationSubscription;
	try {
		subscription = await subscribeToWorkNotifications(auth.serverId);
	} catch (error) {
		reportServerError(error, "agent.work.subscribe", {
			tags: { serverId: auth.serverId },
		});
		console.error("[work-queue] failed to subscribe for notifications:", error);
		try {
			if (await hasClaimableWork(auth.serverId)) {
				return NextResponse.json({ workAvailable: true });
			}
		} catch (queryError) {
			reportServerError(queryError, "agent.work.query", {
				tags: { serverId: auth.serverId },
			});
			console.error("[work-queue] failed to check for work:", queryError);
		}
		return workWaitUnavailable();
	}

	try {
		if (await hasClaimableWork(auth.serverId)) {
			return NextResponse.json({ workAvailable: true });
		}

		const waitResult = await subscription.wait(
			WORK_WAIT_TIMEOUT_MS,
			request.signal,
		);
		if (waitResult === "aborted" || request.signal.aborted) {
			return new Response(null, { status: 499 });
		}

		if (await hasClaimableWork(auth.serverId)) {
			return NextResponse.json({ workAvailable: true });
		}
		if (waitResult === "unavailable") {
			return workWaitUnavailable();
		}
		return NextResponse.json({ workAvailable: false });
	} catch (error) {
		reportServerError(error, "agent.work.wait", {
			tags: { serverId: auth.serverId },
		});
		console.error("[work-queue] failed while waiting for work:", error);
		return workWaitUnavailable();
	} finally {
		subscription.close();
	}
}

function workWaitUnavailable() {
	return NextResponse.json(
		{ error: "Work queue notifications unavailable" },
		{ status: 503, headers: { "Retry-After": "1" } },
	);
}
