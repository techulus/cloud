import type { deployments } from "@/db/schema";

type ProjectDeletionDeployment = Pick<
	typeof deployments.$inferSelect,
	"desired"
>;

export function blocksProjectDeletion(deployment: ProjectDeletionDeployment) {
	return deployment.desired;
}
