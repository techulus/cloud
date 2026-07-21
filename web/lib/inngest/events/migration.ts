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
			backupId: string;
			serviceId: string;
		};
	};
	"migration/restore-failed": {
		data: {
			backupId: string;
			serviceId: string;
			error: string;
		};
	};
	"migration/restore-finished": {
		data: {
			backupId: string;
			serviceId: string;
			status: "completed" | "failed";
			error?: string;
		};
	};
};
