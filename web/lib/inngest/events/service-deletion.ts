import type { ServiceRevisionActor } from "@/lib/service-revision-actor";

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
			actor?: ServiceRevisionActor | null;
		};
	};
};
