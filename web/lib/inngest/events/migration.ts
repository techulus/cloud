export type MigrationEvents = {
	"migration/started": {
		data: {
			serviceId: string;
			targetServerId: string;
			sourceServerId: string;
			sourceDeploymentId: string;
			sourceContainerId: string;
			volumes: { id: string; name: string }[];
			isDatabase: boolean;
		};
	};
	"migration/cancelled": {
		data: {
			serviceId: string;
		};
	};
	"migration/backup-completed": {
		data: {
			backupId: string;
			serviceId: string;
		};
	};
	"migration/backup-failed": {
		data: {
			backupId: string;
			serviceId: string;
			error: string;
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
	"migration/deployment-healthy": {
		data: {
			deploymentId: string;
			serviceId: string;
		};
	};
};
