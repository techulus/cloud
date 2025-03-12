import { Connection, WorkflowClient } from "@temporalio/client";

export const temporalClient = async () => {
	const connection = await Connection.connect({
		address: process.env.TEMPORAL_ADDRESS || "127.0.0.1:7233",
	});
	const client = new WorkflowClient({ connection, namespace: "default" });
	return client;
};
