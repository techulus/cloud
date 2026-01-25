import { relations } from "drizzle-orm";
import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	real,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text("image"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => /* @__PURE__ */ new Date())
		.notNull(),
});

export const session = pgTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: timestamp("expires_at").notNull(),
		token: text("token").notNull().unique(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
	"account",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at"),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
		scope: text("scope"),
		password: text("password"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
	"verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
	sessions: many(session),
	accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id],
	}),
}));

export const accountRelations = relations(account, ({ one }) => ({
	user: one(user, {
		fields: [account.userId],
		references: [user.id],
	}),
}));

type ServerMeta = {
	arch?: string;
	os?: string;
	hostname?: string;
};

export const servers = pgTable("servers", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	publicIp: text("public_ip"),
	privateIp: text("private_ip"),
	subnetId: integer("subnet_id"),
	wireguardIp: text("wireguard_ip"),
	wireguardPublicKey: text("wireguard_public_key"),
	signingPublicKey: text("signing_public_key"),
	isProxy: boolean("is_proxy").default(false).notNull(),
	status: text("status", { enum: ["pending", "online", "offline", "unknown"] })
		.notNull()
		.default("pending"),
	lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
	resourcesCpu: integer("resources_cpu"),
	resourcesMemory: integer("resources_memory"),
	resourcesDisk: integer("resources_disk"),
	meta: jsonb("meta").$type<ServerMeta>(),
	agentToken: text("agent_token"),
	tokenCreatedAt: timestamp("token_created_at", { withTimezone: true }),
	tokenUsedAt: timestamp("token_used_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const projects = pgTable("projects", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	slug: text("slug").notNull().unique(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const environments = pgTable(
	"environments",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("environments_project_id_name_idx").on(
			table.projectId,
			table.name,
		),
	],
);

export const services = pgTable("services", {
	id: text("id").primaryKey(),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	environmentId: text("environment_id")
		.notNull()
		.references(() => environments.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	hostname: text("hostname").unique(),
	image: text("image").notNull(),
	sourceType: text("source_type", { enum: ["image", "github"] })
		.notNull()
		.default("image"),
	githubRepoUrl: text("github_repo_url"),
	githubBranch: text("github_branch").default("main"),
	githubRootDir: text("github_root_dir"),
	replicas: integer("replicas").notNull().default(1),
	stateful: boolean("stateful").notNull().default(false),
	autoPlace: boolean("auto_place").notNull().default(true),
	lockedServerId: text("locked_server_id").references(() => servers.id, {
		onDelete: "set null",
	}),
	healthCheckCmd: text("health_check_cmd"),
	healthCheckInterval: integer("health_check_interval").default(10),
	healthCheckTimeout: integer("health_check_timeout").default(5),
	healthCheckRetries: integer("health_check_retries").default(3),
	healthCheckStartPeriod: integer("health_check_start_period").default(30),
	startCommand: text("start_command"),
	resourceCpuLimit: real("resource_cpu_limit"),
	resourceMemoryLimitMb: integer("resource_memory_limit_mb"),
	deployedConfig: text("deployed_config"),
	deploymentSchedule: text("deployment_schedule"),
	lastScheduledDeploymentRunAt: timestamp("last_scheduled_deployment_run_at", {
		withTimezone: true,
	}),
	backupEnabled: boolean("backup_enabled").default(false),
	backupSchedule: text("backup_schedule"),
	migrationStatus: text("migration_status", {
		enum: ["stopping", "backing_up", "deploying_target", "restoring", "starting", "failed"],
	}),
	migrationTargetServerId: text("migration_target_server_id").references(
		() => servers.id,
		{ onDelete: "set null" },
	),
	migrationBackupId: text("migration_backup_id"),
	migrationError: text("migration_error"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const serviceReplicas = pgTable("service_replicas", {
	id: text("id").primaryKey(),
	serviceId: text("service_id")
		.notNull()
		.references(() => services.id, { onDelete: "cascade" }),
	serverId: text("server_id")
		.notNull()
		.references(() => servers.id, { onDelete: "cascade" }),
	count: integer("count").notNull().default(1),
});

export const servicePorts = pgTable("service_ports", {
	id: text("id").primaryKey(),
	serviceId: text("service_id")
		.notNull()
		.references(() => services.id, { onDelete: "cascade" }),
	port: integer("port").notNull(),
	isPublic: boolean("is_public").notNull().default(false),
	domain: text("domain").unique(),
	protocol: text("protocol", { enum: ["http", "tcp", "udp"] })
		.notNull()
		.default("http"),
	externalPort: integer("external_port"),
	tlsPassthrough: boolean("tls_passthrough").notNull().default(false),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const serviceVolumes = pgTable("service_volumes", {
	id: text("id").primaryKey(),
	serviceId: text("service_id")
		.notNull()
		.references(() => services.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	containerPath: text("container_path").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const volumeBackups = pgTable(
	"volume_backups",
	{
		id: text("id").primaryKey(),
		volumeId: text("volume_id")
			.notNull()
			.references(() => serviceVolumes.id, { onDelete: "cascade" }),
		volumeName: text("volume_name").notNull(),
		serviceId: text("service_id")
			.notNull()
			.references(() => services.id, { onDelete: "cascade" }),
		serverId: text("server_id").references(() => servers.id, {
			onDelete: "set null",
		}),
		status: text("status", {
			enum: ["pending", "uploading", "completed", "failed"],
		})
			.notNull()
			.default("pending"),
		storagePath: text("storage_path"),
		sizeBytes: bigint("size_bytes", { mode: "number" }),
		checksum: text("checksum"),
		errorMessage: text("error_message"),
		isMigrationBackup: boolean("is_migration_backup").default(false),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		index("volume_backups_volume_id_idx").on(table.volumeId),
		index("volume_backups_service_id_idx").on(table.serviceId),
		index("volume_backups_created_at_idx").on(table.createdAt),
	],
);

export const secrets = pgTable("secrets", {
	id: text("id").primaryKey(),
	serviceId: text("service_id")
		.notNull()
		.references(() => services.id, { onDelete: "cascade" }),
	key: text("key").notNull(),
	encryptedValue: text("encrypted_value").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const deployments = pgTable(
	"deployments",
	{
		id: text("id").primaryKey(),
		serviceId: text("service_id")
			.notNull()
			.references(() => services.id, { onDelete: "cascade" }),
		serverId: text("server_id")
			.notNull()
			.references(() => servers.id, { onDelete: "cascade" }),
		containerId: text("container_id"),
		ipAddress: text("ip_address"),
		status: text("status", {
			enum: [
				"pending",
				"pulling",
				"starting",
				"healthy",
				"running",
				"draining",
				"stopping",
				"stopped",
				"failed",
				"rolled_back",
				"unknown",
			],
		})
			.notNull()
			.default("pending"),
		healthStatus: text("health_status", {
			enum: ["none", "starting", "healthy", "unhealthy"],
		}),
		rolloutId: text("rollout_id"),
		previousDeploymentId: text("previous_deployment_id"),
		failedStage: text("failed_stage"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("deployments_container_id_idx").on(table.containerId),
		index("deployments_rollout_id_idx").on(table.rolloutId),
		index("deployments_service_id_idx").on(table.serviceId),
		index("deployments_server_id_idx").on(table.serverId),
		index("deployments_status_idx").on(table.status),
	],
);

export const rollouts = pgTable(
	"rollouts",
	{
		id: text("id").primaryKey(),
		serviceId: text("service_id")
			.notNull()
			.references(() => services.id, { onDelete: "cascade" }),
		status: text("status", {
			enum: ["in_progress", "completed", "failed", "rolled_back"],
		})
			.notNull()
			.default("in_progress"),
		currentStage: text("current_stage"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [index("rollouts_service_id_idx").on(table.serviceId)],
);

export const deploymentPorts = pgTable("deployment_ports", {
	id: text("id").primaryKey(),
	deploymentId: text("deployment_id")
		.notNull()
		.references(() => deployments.id, { onDelete: "cascade" }),
	servicePortId: text("service_port_id")
		.notNull()
		.references(() => servicePorts.id, { onDelete: "cascade" }),
	hostPort: integer("host_port").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const workQueue = pgTable(
	"work_queue",
	{
		id: text("id").primaryKey(),
		serverId: text("server_id")
			.notNull()
			.references(() => servers.id, { onDelete: "cascade" }),
		type: text("type", {
			enum: [
				"deploy",
				"stop",
				"restart",
				"force_cleanup",
				"cleanup_volumes",
				"build",
				"backup_volume",
				"restore_volume",
			],
		}).notNull(),
		payload: text("payload").notNull(),
		status: text("status", {
			enum: ["pending", "processing", "completed", "failed"],
		})
			.notNull()
			.default("pending"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		startedAt: timestamp("started_at", { withTimezone: true }),
		attempts: integer("attempts").notNull().default(0),
	},
	(table) => [
		index("work_queue_server_status_idx").on(table.serverId, table.status),
	],
);

export const githubInstallations = pgTable("github_installations", {
	id: text("id").primaryKey(),
	installationId: integer("installation_id").notNull().unique(),
	accountLogin: text("account_login").notNull(),
	accountType: text("account_type", {
		enum: ["User", "Organization"],
	}).notNull(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const githubRepos = pgTable(
	"github_repos",
	{
		id: text("id").primaryKey(),
		installationId: integer("installation_id")
			.notNull()
			.references(() => githubInstallations.installationId, {
				onDelete: "cascade",
			}),
		repoId: integer("repo_id").notNull().unique(),
		repoFullName: text("repo_full_name").notNull(),
		defaultBranch: text("default_branch").notNull().default("main"),
		serviceId: text("service_id")
			.unique()
			.references(() => services.id, { onDelete: "cascade" }),
		deployBranch: text("deploy_branch"),
		autoDeploy: boolean("auto_deploy").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("github_repos_installation_id_idx").on(table.installationId),
		index("github_repos_service_id_idx").on(table.serviceId),
	],
);

export const builds = pgTable(
	"builds",
	{
		id: text("id").primaryKey(),
		githubRepoId: text("github_repo_id").references(() => githubRepos.id, {
			onDelete: "cascade",
		}),
		serviceId: text("service_id")
			.notNull()
			.references(() => services.id, { onDelete: "cascade" }),
		commitSha: text("commit_sha").notNull(),
		commitMessage: text("commit_message"),
		branch: text("branch").notNull(),
		author: text("author"),
		status: text("status", {
			enum: [
				"pending",
				"claimed",
				"cloning",
				"building",
				"pushing",
				"completed",
				"failed",
				"cancelled",
			],
		})
			.notNull()
			.default("pending"),
		imageUri: text("image_uri"),
		error: text("error"),
		githubDeploymentId: bigint("github_deployment_id", { mode: "number" }),
		claimedBy: text("claimed_by").references(() => servers.id, {
			onDelete: "set null",
		}),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		startedAt: timestamp("started_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("builds_status_idx").on(table.status),
		index("builds_service_id_idx").on(table.serviceId),
		index("builds_github_repo_id_idx").on(table.githubRepoId),
	],
);

export const settings = pgTable("settings", {
	key: text("key").primaryKey(),
	value: jsonb("value").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull()
		.$onUpdate(() => new Date()),
});

export const acmeChallenges = pgTable("acme_challenges", {
	token: text("token").primaryKey(),
	keyAuthorization: text("key_authorization").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const domainCertificates = pgTable(
	"domain_certificates",
	{
		id: text("id").primaryKey(),
		domain: text("domain").notNull().unique(),
		certificate: text("certificate").notNull(),
		certificateKey: text("certificate_key").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull()
			.$onUpdate(() => new Date()),
	},
	(table) => [index("domain_certificates_expires_at_idx").on(table.expiresAt)],
);
