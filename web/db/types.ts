import type { DeployedConfig } from "@/lib/service-config";
import type {
	builds,
	deploymentPorts,
	deployments,
	environments,
	githubInstallations,
	githubRepos,
	memberInvitations,
	projects,
	rollouts,
	secrets,
	servers,
	servicePorts,
	serviceReplicas,
	services,
	serviceVolumes,
	user,
	volumeBackups,
	workQueue,
} from "./schema";

export type Server = typeof servers.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Environment = typeof environments.$inferSelect;
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
export type VolumeBackup = typeof volumeBackups.$inferSelect;
export type WorkQueue = typeof workQueue.$inferSelect;
export type User = typeof user.$inferSelect;
export type MemberInvitation = typeof memberInvitations.$inferSelect;
export type MemberRole = User["role"];
export type InvitableMemberRole = MemberInvitation["role"];

export type DeploymentStatus = NonNullable<Deployment["observedPhase"]>;
export type HealthStatus = Deployment["healthStatus"];
export type RolloutStatus = NonNullable<Rollout["status"]>;
export type BuildStatus = NonNullable<Build["status"]>;

export type HealthStats = {
	cpuUsagePercent: number;
	memoryUsagePercent: number;
	memoryUsedMb: number;
	diskUsagePercent: number;
	diskUsedGb: number;
};

export type ServiceWithDetails = Service & {
	activeConfig?: DeployedConfig | null;
	ports: ServicePort[];
	configuredReplicas: Array<
		ServiceReplica & { serverName: string; serverIsProxy: boolean }
	>;
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
	latestBuild?: Pick<Build, "id" | "status"> | null;
	hasGithubAppRepo?: boolean;
	deletionBackupFallback?: {
		volumeCount: number;
		backedUpVolumeCount: number;
		oldestLatestBackupAt: Date | string | null;
		newestLatestBackupAt: Date | string | null;
	} | null;
};
