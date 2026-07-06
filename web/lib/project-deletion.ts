import type { deployments } from "@/db/schema";

type ProjectDeletionDeployment = Pick<
	typeof deployments.$inferSelect,
	"runtimeDesiredState"
>;

export function blocksProjectDeletion(deployment: ProjectDeletionDeployment) {
	return deployment.runtimeDesiredState !== "removed";
}
