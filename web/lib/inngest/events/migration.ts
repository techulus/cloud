export type MigrationEvents = {
	"migration/started": {
		data: {
			serviceId: string;
			targetServerId: string;
			sourceServerId: string;
			sourceDeploymentId: string;
			sourceContainerId: string;
			volumes: { id: string; name: string }[];
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
};
