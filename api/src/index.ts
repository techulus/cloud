import { WorkflowClient } from "@temporalio/client";
import { Connection } from "@temporalio/client";
import { randomUUIDv7 } from "bun";
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => {
	return c.json({ message: "Hello!" });
});

app.post("/deploy", async (c) => {
	const { image } = await c.req.json();

	const connection = await Connection.connect({
		address: process.env.TEMPORAL_ADDRESS || "127.0.0.1:7233",
	});
	const client = new WorkflowClient({ connection, namespace: "default" });

	const handle = await client.start("deployService", {
		args: [image],
		taskQueue: "service-deployment",
		workflowId: randomUUIDv7(),
	});

	console.log(
		`Started Workflow ${handle.workflowId} with RunID ${handle.firstExecutionRunId}`,
	);
	console.log(await handle.result());

	return c.json({ message: "Done" });
});

export default {
	fetch: app.fetch,
	port: process.env.PORT || 3000,
};
