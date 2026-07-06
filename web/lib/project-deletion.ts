import type { deployments } from "@/db/schema";

type ProjectDeletionDeployment = Pick<
	typeof deployments.$inferSelect,
	"runtimeDesiredState"
>;

export function blocksProjectDeletion(deployment: ProjectDeletionDeployment) {
	// Sleeping serverless deployments still have runtime intent and can wake.
	return deployment.runtimeDesiredState !== "removed";
}
