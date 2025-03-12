"use server";

import { randomUUID } from "node:crypto";
import { temporalClient } from "@/lib/temporal";

const flyToken = process.env.FLY_API_TOKEN;

export async function createProject({ name }: { name: string }) {
	try {
		const client = await temporalClient();

		const handle = await client.start("createApp", {
			args: [
				flyToken,
				{
					app_name: `${randomUUID()}-${name}`,
				},
			],
			taskQueue: "service-deployment",
			workflowId: randomUUID(),
		});

		console.log(
			`Started Workflow ${handle.workflowId} with RunID ${handle.firstExecutionRunId}`,
		);
		const result = await handle.result();

		console.log(result);
	} catch (error) {
		console.error(error);
		return { error: "Failed to create project" };
	}
}
