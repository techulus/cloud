import type { ServiceRevisionActor } from "@/lib/service-revision-actor";

export type MigrationEvents = {
	"migration/started": {
		data: {
			serviceId: string;
			targetServerId: string;
			sourceServerId: string;
			sourceDeploymentId: string;
			sourceServiceRevisionId: string;
			sourceContainerId: string;
			volumes: { id: string; name: string }[];
			actor?: ServiceRevisionActor | null;
		};
	};
	"migration/cancelled": {
		data: {
			serviceId: string;
		};
	};
	"migration/restore-completed": {
		data: {
			workItemId?: string;
			backupId: string;
			serviceId: string;
		};
	};
	"migration/restore-failed": {
		data: {
			workItemId?: string;
			backupId: string;
			serviceId: string;
			error: string;
		};
	};
	"migration/restore-finished": {
		data: {
			workItemId?: string;
			backupId: string;
			serviceId: string;
			status: "completed" | "failed";
			error?: string;
		};
	};
};
