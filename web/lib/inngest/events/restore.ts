export type RestoreEvents = {
	"restore/trigger": {
		data: {
			serviceId: string;
			backupId: string;
			targetServerId?: string;
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
};
