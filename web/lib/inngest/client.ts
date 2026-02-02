import { EventSchemas, Inngest } from "inngest";

type Events = {
	"rollout/created": {
		data: {
			rolloutId: string;
			serviceId: string;
			deploymentIds: string[];
			serverIds: string[];
			isRollingUpdate: boolean;
		};
	};
	"rollout/cancelled": {
		data: {
			rolloutId: string;
		};
	};
	"deployment/healthy": {
		data: {
			deploymentId: string;
			rolloutId: string;
			serviceId: string;
		};
	};
	"deployment/failed": {
		data: {
			deploymentId: string;
			rolloutId: string;
			serviceId: string;
			reason: string;
		};
	};
	"server/dns-synced": {
		data: {
			serverId: string;
			rolloutId: string;
		};
	};
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
	"backup/started": {
		data: {
			backupId: string;
			serviceId: string;
			volumeId: string;
			serverId: string;
		};
	};
	"backup/completed": {
		data: {
			backupId: string;
			volumeId: string;
			serviceId: string;
			checksum: string;
			sizeBytes: number;
			isMigrationBackup: boolean;
		};
	};
	"backup/failed": {
		data: {
			backupId: string;
			volumeId: string;
			serviceId: string;
			error: string;
			isMigrationBackup: boolean;
		};
	};
	"restore/started": {
		data: {
			backupId: string;
			serviceId: string;
			serverId: string;
		};
	};
	"restore/completed": {
		data: {
			backupId: string;
			volumeId: string;
			serviceId: string;
			isMigrationRestore: boolean;
		};
	};
	"restore/failed": {
		data: {
			backupId: string;
			volumeId: string;
			serviceId: string;
			error: string;
			isMigrationRestore: boolean;
		};
	};
	"build/started": {
		data: {
			buildId: string;
			serviceId: string;
			buildGroupId: string | null;
		};
	};
	"build/cancelled": {
		data: {
			buildId: string;
			buildGroupId: string | null;
		};
	};
	"build/completed": {
		data: {
			buildId: string;
			serviceId: string;
			buildGroupId: string | null;
			status: "success" | "failed";
			imageUri?: string;
			error?: string;
		};
	};
	"manifest/completed": {
		data: {
			serviceId: string;
			buildGroupId: string;
			imageUri: string;
		};
	};
	"manifest/failed": {
		data: {
			serviceId: string;
			buildGroupId: string;
			error: string;
		};
	};
};

export const inngest = new Inngest({
	id: "techulus-cloud",
	schemas: new EventSchemas().fromRecord<Events>(),
});
