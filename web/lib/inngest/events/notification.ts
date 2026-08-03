export type NotificationEvent =
	| {
			kind: "server.offline";
			occurrenceId: string;
			serverId: string;
			serverName: string;
			serverIp?: string;
	  }
	| {
			kind: "manual_recovery.required";
			occurrenceId: string;
			serverId: string;
			serverName: string;
			serverIp?: string;
			impactedReplicas: number;
			serviceNames: string[];
	  }
	| {
			kind: "build.failed";
			occurrenceId: string;
			serviceId: string;
			buildId: string;
			error?: string;
	  }
	| {
			kind: "deployment.failed";
			occurrenceId: string;
			serviceId: string;
			serverId: string | null;
			failedStage?: string;
	  }
	| {
			kind: "member.invited";
			occurrenceId: string;
			to: string;
			inviterName: string;
			role: string;
			inviteUrl: string;
	  };

export type NotificationEvents = {
	"notification/requested": { data: NotificationEvent };
};
