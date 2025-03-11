import { proxyActivities } from "@temporalio/workflow";

import type * as activities from "./activities";

export async function deployService(id: string): Promise<string> {
	const { deployService } = proxyActivities<typeof activities>({
		retry: {
			initialInterval: "1 second",
			maximumInterval: "1 minute",
			backoffCoefficient: 2,
			maximumAttempts: 500,
			nonRetryableErrorTypes: ["InvalidMachineState"],
		},
		startToCloseTimeout: "1 minute",
	});

	await deployService(id);

	return `Deployed service ${id}`;
}
