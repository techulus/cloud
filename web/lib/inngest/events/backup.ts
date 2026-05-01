export type BackupEvents = {
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
};
