import type { ServiceRevisionActor } from "@/lib/service-revision-actor";

export type BuildEvents = {
	"build/trigger": {
		data: {
			serviceId: string;
			serviceRevisionId: string;
			buildRequestId: string;
			trigger: "manual" | "scheduled" | "push";
			commitSha: string;
			commitMessage: string;
			branch: string;
			author?: string;
			actor?: ServiceRevisionActor | null;
			githubDeploymentId?: number;
		};
	};
	"build/started": {
		data: {
			buildId: string;
			serviceId: string;
			serviceRevisionId: string;
			buildGroupId: string;
			actor?: ServiceRevisionActor | null;
		};
	};
	"build/cancelled": {
		data: {
			buildId: string;
			buildGroupId: string;
		};
	};
	"build/completed": {
		data: {
			buildId: string;
			serviceId: string;
			serviceRevisionId: string;
			buildGroupId: string;
			status: "success" | "failed";
			imageUri?: string;
			error?: string;
		};
	};
	"manifest/completed": {
		data: {
			serviceId: string;
			serviceRevisionId: string;
			buildGroupId: string;
			imageUri: string;
		};
	};
	"manifest/failed": {
		data: {
			serviceId: string;
			serviceRevisionId: string;
			buildGroupId: string;
			error: string;
		};
	};
};
