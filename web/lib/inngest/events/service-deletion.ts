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
			rolloutId: string;
			backupIds: string[];
		};
	};
};
