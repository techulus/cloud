export type RolloutEvents = {
	"rollout/created": {
		data: {
			rolloutId: string;
			serviceId: string;
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
};
