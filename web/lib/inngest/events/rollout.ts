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
	"server/dns-synced": {
		data: {
			serverId: string;
			rolloutId: string;
		};
	};
};
