import { proxyActivities } from "@temporalio/workflow";

import type * as activities from "./activities";

export async function createApp(
	token: Parameters<typeof activities.createApp>[0],
	payload: Parameters<typeof activities.createApp>[1],
): Promise<{ id: string; created_at: number }> {
	const { createApp } = proxyActivities<typeof activities>({
		retry: {
			initialInterval: "1 second",
			maximumInterval: "1 minute",
			backoffCoefficient: 2,
			maximumAttempts: 1,
		},
		startToCloseTimeout: "1 minute",
	});

	const result = await createApp(token, payload);

	return result;
}
