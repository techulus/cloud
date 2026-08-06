export type ServiceCronEvents = {
	"service-cron/execute": {
		data: { cronId: string; schedule: string; scheduledFor: string };
	};
};
