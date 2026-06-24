export type BackupEvents = {
	"backup/started": {
		data: {
			backupId: string;
			serviceId: string;
			volumeId: string;
			serverId: string;
		};
	};
};
