import type {
	builds,
	deploymentPorts,
	deployments,
	githubInstallations,
	githubRepos,
	projects,
	rollouts,
	secrets,
	serviceReplicas,
	servicePorts,
	services,
	serviceVolumes,
	servers,
} from "./schema";

export type Server = typeof servers.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Service = typeof services.$inferSelect;
export type ServicePort = typeof servicePorts.$inferSelect;
export type ServiceVolume = typeof serviceVolumes.$inferSelect;
export type ServiceReplica = typeof serviceReplicas.$inferSelect;
export type Secret = typeof secrets.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type DeploymentPort = typeof deploymentPorts.$inferSelect;
export type Rollout = typeof rollouts.$inferSelect;
export type GithubRepo = typeof githubRepos.$inferSelect;
export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type Build = typeof builds.$inferSelect;

export type DeploymentStatus = NonNullable<Deployment["status"]>;
export type HealthStatus = Deployment["healthStatus"];

export type RolloutStatus = NonNullable<Rollout["status"]>;

export type BuildStatus = NonNullable<Build["status"]>;

export type ServiceWithDetails = Service & {
	ports: ServicePort[];
	configuredReplicas: Array<ServiceReplica & { serverName: string }>;
	deployments: Array<
		Deployment & {
			server: Pick<Server, "name" | "wireguardIp"> | null;
			ports: Array<
				Pick<DeploymentPort, "id" | "hostPort"> & { containerPort: number }
			>;
		}
	>;
	volumes?: ServiceVolume[];
	secrets?: Array<Pick<Secret, "key"> & { updatedAt: Date | string }>;
	rollouts?: Rollout[];
	lockedServer?: Pick<Server, "name"> | null;
};
