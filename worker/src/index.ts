import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";

async function run() {
	const connection = await NativeConnection.connect({
		address: process.env.TEMPORAL_ADDRESS || "127.0.0.1:7233",
	});

	const worker = await Worker.create({
		connection: connection as NativeConnection,
		workflowsPath: require.resolve("./workflows"),
		activities,
		namespace: "default",
		taskQueue: "service-deployment",
	});

	await worker.run();
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
