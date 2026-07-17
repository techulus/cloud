import type { ServiceRevisionActor } from "@/lib/service-revision-actor";

export type BuildEvents = {
	"build/trigger": {
		data: {
			serviceId: string;
			trigger: "manual" | "scheduled" | "push";
			githubRepoId?: string;
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
			buildGroupId: string | null;
			actor?: ServiceRevisionActor | null;
		};
	};
	"build/cancelled": {
		data: {
			buildId: string;
			buildGroupId: string | null;
		};
	};
	"build/completed": {
		data: {
			buildId: string;
			serviceId: string;
			buildGroupId: string | null;
			status: "success" | "failed";
			imageUri?: string;
			error?: string;
		};
	};
	"manifest/completed": {
		data: {
			serviceId: string;
			buildGroupId: string;
			imageUri: string;
		};
	};
	"manifest/failed": {
		data: {
			serviceId: string;
			buildGroupId: string;
			error: string;
		};
	};
};
