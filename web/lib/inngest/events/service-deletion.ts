export type ServiceDeletionEvents = {
	"service-deletion/started": {
		data: {
			serviceId: string;
			reusableBackupIds: string[];
		};
	};
	"service-restore/started": {
		data: {
			serviceId: string;
			targetServerId: string | null;
			backupIds: string[];
		};
	};
};
