import { Cron } from "croner";
import { checkAndRecoverStaleServers } from "@/lib/scheduler";

export function startCronEngine() {
	console.log("[cron] starting cron engine");

	new Cron("*/1 * * * *", async () => {
		console.log("[cron] running stale server check");
		await checkAndRecoverStaleServers();
	});
}
