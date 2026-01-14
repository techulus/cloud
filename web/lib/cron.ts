import { Cron } from "croner";
import {
	checkAndRecoverStaleServers,
	checkAndRunScheduledDeployments,
} from "@/lib/scheduler";
import {
	renewExpiringCertificates,
	cleanupExpiredChallenges,
} from "@/lib/acme-manager";
import { runScheduledBackups, cleanupOldBackups } from "@/lib/backup-scheduler";

export function startCronEngine() {
	console.log("[cron] starting cron engine");

	new Cron("*/1 * * * *", async () => {
		console.log("[cron] running stale server check");
		await checkAndRecoverStaleServers();
	});

	new Cron("*/15 * * * *", async () => {
		console.log("[cron] checking scheduled deployments");
		await checkAndRunScheduledDeployments();
	});

	new Cron("0 2 * * *", async () => {
		console.log("[cron] checking for expiring certificates");
		await renewExpiringCertificates();
	});

	new Cron("*/10 * * * *", async () => {
		await cleanupExpiredChallenges();
	});

	new Cron("*/15 * * * *", async () => {
		console.log("[cron] checking scheduled backups");
		await runScheduledBackups();
	});

	new Cron("0 3 * * *", async () => {
		console.log("[cron] cleaning up old backups");
		await cleanupOldBackups();
	});
}
