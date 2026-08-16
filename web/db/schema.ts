import { relations, sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	real,
	text,
	timestamp,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ServiceRevisionActor } from "@/lib/service-revision-actor";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";

export const user = pgTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text("image"),
	twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
	role: text("role", { enum: ["admin", "developer", "reader"] })
		.notNull()
		.default("reader"),
	banned: boolean("banned").default(false),
	banReason: text("ban_reason"),
	banExpires: timestamp("ban_expires"),
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
		impersonatedBy: text("impersonated_by"),
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

export const twoFactor = pgTable(
	"two_factor",
	{
		id: text("id").primaryKey(),
		secret: text("secret").notNull(),
		backupCodes: text("backup_codes").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		verified: boolean("verified").default(true),
		failedVerificationCount: integer("failed_verification_count")
			.default(0)
			.notNull(),
		lockedUntil: timestamp("locked_until"),
	},
	(table) => [
		index("twoFactor_secret_idx").on(table.secret),
		index("twoFactor_userId_idx").on(table.userId),
	],
);

export const deviceCode = pgTable(
	"device_code",
	{
		id: text("id").primaryKey(),
		deviceCode: text("device_code").notNull(),
		userCode: text("user_code").notNull(),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		expiresAt: timestamp("expires_at").notNull(),
		status: text("status").notNull(),
		lastPolledAt: timestamp("last_polled_at"),
		pollingInterval: integer("polling_interval"),
		clientId: text("client_id"),
		scope: text("scope"),
	},
	(table) => [
		index("device_code_device_code_idx").on(table.deviceCode),
		index("device_code_user_code_idx").on(table.userCode),
		index("device_code_user_id_idx").on(table.userId),
	],
);

export const apikey = pgTable(
	"apikey",
	{
		id: text("id").primaryKey(),
		configId: text("config_id").default("default").notNull(),
		name: text("name"),
		start: text("start"),
		prefix: text("prefix"),
		key: text("key").notNull(),
		referenceId: text("reference_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		refillInterval: integer("refill_interval"),
		refillAmount: integer("refill_amount"),
		lastRefillAt: timestamp("last_refill_at"),
		enabled: boolean("enabled").default(true),
		rateLimitEnabled: boolean("rate_limit_enabled").default(true),
		rateLimitTimeWindow: integer("rate_limit_time_window"),
		rateLimitMax: integer("rate_limit_max"),
		requestCount: integer("request_count").default(0),
		remaining: integer("remaining"),
		lastRequest: timestamp("last_request"),
		expiresAt: timestamp("expires_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
		permissions: text("permissions"),
		metadata: text("metadata"),
	},
	(table) => [
		index("apikey_key_idx").on(table.key),
		index("apikey_config_id_idx").on(table.configId),
		index("apikey_reference_id_idx").on(table.referenceId),
	],
);

export const memberInvitations = pgTable(
	"member_invitations",
	{
		id: text("id").primaryKey(),
		email: text("email").notNull(),
		role: text("role", { enum: ["developer", "reader"] }).notNull(),
		tokenHash: text("token_hash").notNull().unique(),
		status: text("status", {
			enum: ["pending", "accepted", "revoked", "expired"],
		})
			.notNull()
			.default("pending"),
		invitedByUserId: text("invited_by_user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		acceptedByUserId: text("accepted_by_user_id").references(() => user.id, {
			onDelete: "set null",
		}),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		acceptedAt: timestamp("accepted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		index("member_invitations_email_idx").on(table.email),
		index("member_invitations_status_idx").on(table.status),
		index("member_invitations_invited_by_user_id_idx").on(
			table.invitedByUserId,
		),
	],
);

export const notifications = pgTable(
	"notifications",
	{
		id: text("id").primaryKey(),
		eventId: text("event_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		kind: text("kind").notNull(),
		title: text("title").notNull(),
		body: text("body").notNull(),
		href: text("href"),
		readAt: timestamp("read_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("notifications_user_read_created_idx").on(
			table.userId,
			table.readAt,
			table.createdAt,
		),
		index("notifications_user_created_id_idx").on(
			table.userId,
			table.createdAt,
			table.id,
		),
		uniqueIndex("notifications_event_user_unique_idx").on(
			table.eventId,
			table.userId,
		),
	],
);

export const userRelations = relations(user, ({ many, one }) => ({
	sessions: many(session),
	accounts: many(account),
	apiKeys: many(apikey),
	deviceCodes: many(deviceCode),
	twoFactor: one(twoFactor),
	sentMemberInvitations: many(memberInvitations, {
		relationName: "sentMemberInvitations",
	}),
	acceptedMemberInvitations: many(memberInvitations, {
		relationName: "acceptedMemberInvitations",
	}),
	notifications: many(notifications),
}));

export const notificationRelations = relations(notifications, ({ one }) => ({
	user: one(user, {
		fields: [notifications.userId],
		references: [user.id],
	}),
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

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
	user: one(user, {
		fields: [twoFactor.userId],
		references: [user.id],
	}),
}));

export const deviceCodeRelations = relations(deviceCode, ({ one }) => ({
	user: one(user, {
		fields: [deviceCode.userId],
		references: [user.id],
	}),
}));

export const apiKeyRelations = relations(apikey, ({ one }) => ({
	user: one(user, {
		fields: [apikey.referenceId],
		references: [user.id],
	}),
}));

export const memberInvitationRelations = relations(
	memberInvitations,
	({ one }) => ({
		invitedBy: one(user, {
			fields: [memberInvitations.invitedByUserId],
			references: [user.id],
			relationName: "sentMemberInvitations",
		}),
		acceptedBy: one(user, {
			fields: [memberInvitations.acceptedByUserId],
			references: [user.id],
			relationName: "acceptedMemberInvitations",
		}),
	}),
);

type ServerMeta = {
	arch?: string;
	os?: string;
	hostname?: string;
};

export type NetworkPeer = {
	id: string;
	lastSeenSecs: number;
	reachable: boolean;
};

export type NetworkHealth = {
	tunnelUp: boolean;
	peerCount: number;
	peers: NetworkPeer[];
};

export type ContainerHealth = {
	runtimeResponsive: boolean;
	runningContainers: number;
	stoppedContainers: number;
	storageUsedGb: number;
};

export type AgentHealth = {
	version: string;
	uptimeSecs: number;
	capabilities?: string[];
};

export type CrowdSecDecision = {
	scope: string;
	value: string;
	action: string;
	reason: string;
	origin: string;
	expiresAt?: string;
};

export type CrowdSecAlert = {
	id: number;
	detectedAt: string;
	scenario: string;
	sourceIp: string;
	country: string;
	eventCount: number;
};

export type CrowdSecHealth = {
	checkedAt: string;
	lapi: { available: boolean };
	metrics: {
		available: boolean;
		reads: number;
		parsed: number;
		unparsed: number;
	};
	bouncer: {
		available: boolean;
		error?: string;
		registered: boolean;
		revoked: boolean;
		lastPullAt?: string;
	};
	decisions: {
		available: boolean;
		truncated: boolean;
		records: CrowdSecDecision[];
	};
	alerts: {
		available: boolean;
		truncated: boolean;
		records: CrowdSecAlert[];
	};
};

export type AgentUpgradeStatus =
	| "idle"
	| "queued"
	| "upgrading"
	| "succeeded"
	| "failed";

export const servers = pgTable("servers", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	publicIp: text("public_ip"),
	privateIp: text("private_ip"),
	subnetId: integer("subnet_id").unique("servers_subnet_id_unique"),
	wireguardIp: text("wireguard_ip").unique("servers_wireguard_ip_unique"),
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
	networkHealth: jsonb("network_health").$type<NetworkHealth>(),
	containerHealth: jsonb("container_health").$type<ContainerHealth>(),
	agentHealth: jsonb("agent_health").$type<AgentHealth>(),
	crowdsecHealth: jsonb("crowdsec_health").$type<CrowdSecHealth>(),
	agentUpgradeTargetVersion: text("agent_upgrade_target_version"),
	agentUpgradeStatus: text("agent_upgrade_status", {
		enum: ["idle", "queued", "upgrading", "succeeded", "failed"],
	})
		.notNull()
		.default("idle"),
	agentUpgradeStartedAt: timestamp("agent_upgrade_started_at", {
		withTimezone: true,
	}),
	agentUpgradeError: text("agent_upgrade_error"),
	agentToken: text("agent_token"),
	tokenCreatedAt: timestamp("token_created_at", { withTimezone: true }),
	tokenUsedAt: timestamp("token_used_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const registryCredentials = pgTable(
	"registry_credentials",
	{
		id: text("id").primaryKey(),
		host: text("host").notNull(),
		username: text("username").notNull(),
		encryptedPassword: text("encrypted_password").notNull(),
		tlsVerify: boolean("tls_verify").default(true).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [uniqueIndex("registry_credentials_host_idx").on(table.host)],
);

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

export const services = pgTable(
	"services",
	{
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
		autoscalingEnabled: boolean("autoscaling_enabled").notNull().default(false),
		autoscalingMinReplicas: integer("autoscaling_min_replicas")
			.notNull()
			.default(1),
		autoscalingMaxReplicas: integer("autoscaling_max_replicas")
			.notNull()
			.default(1),
		placementMode: text("placement_mode", { enum: ["manual", "automatic"] })
			.notNull()
			.default("manual"),
		lastAutomaticPlacementAt: timestamp("last_automatic_placement_at", {
			withTimezone: true,
		}),
		lastAutomaticRecoveryAttemptAt: timestamp(
			"last_automatic_recovery_attempt_at",
			{ withTimezone: true },
		),
		lastAutoscaleAttemptAt: timestamp("last_autoscale_attempt_at", {
			withTimezone: true,
		}),
		stateful: boolean("stateful").notNull().default(false),
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
		serverlessEnabled: boolean("serverless_enabled").notNull().default(false),
		serverlessSleepAfterSeconds: integer("serverless_sleep_after_seconds")
			.notNull()
			.default(300),
		serverlessWakeTimeoutSeconds: integer("serverless_wake_timeout_seconds")
			.notNull()
			.default(300),
		deploymentSchedule: text("deployment_schedule"),
		lastScheduledDeploymentRunAt: timestamp(
			"last_scheduled_deployment_run_at",
			{
				withTimezone: true,
			},
		),
		backupEnabled: boolean("backup_enabled").default(false),
		backupSchedule: text("backup_schedule"),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		purgeAfter: timestamp("purge_after", { withTimezone: true }),
		originalHostname: text("original_hostname"),
		deletionStatus: text("deletion_status", {
			enum: ["backing_up", "deleting", "restoring", "failed"],
		}),
		deletionError: text("deletion_error"),
		canvasX: integer("canvas_x"),
		canvasY: integer("canvas_y"),
		migrationStatus: text("migration_status", {
			enum: [
				"stopping",
				"backing_up",
				"deploying_target",
				"restoring",
				"starting",
				"failed",
			],
		}),
		migrationTargetServerId: text("migration_target_server_id").references(
			() => servers.id,
			{ onDelete: "set null" },
		),
		migrationBackupId: text("migration_backup_id"),
		migrationError: text("migration_error"),
		previewDeploymentsEnabled: boolean("preview_deployments_enabled")
			.notNull()
			.default(false),
		previewOfServiceId: text("preview_of_service_id"),
		previewPullRequestNumber: integer("preview_pull_request_number"),
		previewCurrentRevisionId: text("preview_current_revision_id"),
		previewGithubDeploymentId: bigint("preview_github_deployment_id", {
			mode: "number",
		}),
		previewError: text("preview_error"),
		previewExpiresAt: timestamp("preview_expires_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("services_project_environment_idx").on(
			table.projectId,
			table.environmentId,
		),
		index("services_environment_id_idx").on(table.environmentId),
		index("services_last_autoscale_attempt_idx").on(
			table.lastAutoscaleAttemptAt,
		),
		foreignKey({
			name: "services_preview_of_service_fk",
			columns: [table.previewOfServiceId],
			foreignColumns: [table.id],
		}).onDelete("restrict"),
		check(
			"services_preview_identity_check",
			sql`(${table.previewOfServiceId} is null) = (${table.previewPullRequestNumber} is null)`,
		),
		check(
			"services_preview_pull_request_number_check",
			sql`${table.previewPullRequestNumber} is null or ${table.previewPullRequestNumber} > 0`,
		),
		check(
			"services_preview_policy_check",
			sql`(
				(${table.previewOfServiceId} is null and (${table.previewDeploymentsEnabled} = false or ${table.stateful} = false))
				or
				(${table.previewOfServiceId} is not null and ${table.previewDeploymentsEnabled} = false and ${table.stateful} = false)
			)`,
		),
		check(
			"services_preview_metadata_check",
			sql`${table.previewOfServiceId} is not null or (
				${table.previewCurrentRevisionId} is null
				and ${table.previewGithubDeploymentId} is null
				and ${table.previewError} is null
				and ${table.previewExpiresAt} is null
			)`,
		),
		uniqueIndex("services_preview_base_pr_unique_idx")
			.on(table.previewOfServiceId, table.previewPullRequestNumber)
			.where(sql`${table.previewOfServiceId} is not null`),
		index("services_preview_expires_at_idx")
			.on(table.previewExpiresAt)
			.where(sql`${table.previewOfServiceId} is not null`),
	],
);

export const serviceCrons = pgTable(
	"service_crons",
	{
		id: text("id").primaryKey(),
		serviceId: text("service_id")
			.notNull()
			.references(() => services.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		schedule: text("schedule").notNull(),
		nextScheduledFor: timestamp("next_scheduled_for", {
			withTimezone: true,
		}).notNull(),
		lastScheduledFor: timestamp("last_scheduled_for", { withTimezone: true }),
		lastAttemptedFor: timestamp("last_attempted_for", { withTimezone: true }),
		lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
		lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
		lastStatus: text("last_status", {
			enum: ["succeeded", "failed", "skipped"],
		}),
		lastStatusCode: integer("last_status_code"),
		lastDurationMs: integer("last_duration_ms"),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("service_crons_service_path_unique_idx").on(
			table.serviceId,
			table.path,
		),
		index("service_crons_due_scan_idx").on(table.nextScheduledFor),
	],
);

export const serviceReplicas = pgTable(
	"service_replicas",
	{
		id: text("id").primaryKey(),
		serviceId: text("service_id")
			.notNull()
			.references(() => services.id, { onDelete: "cascade" }),
		serverId: text("server_id")
			.notNull()
			.references(() => servers.id, { onDelete: "cascade" }),
		count: integer("count").notNull().default(1),
	},
	(table) => [index("service_replicas_service_id_idx").on(table.serviceId)],
);

export const servicePorts = pgTable(
	"service_ports",
	{
		id: text("id").primaryKey(),
		serviceId: text("service_id")
			.notNull()
			.references(() => services.id, { onDelete: "cascade" }),
		port: integer("port").notNull(),
		isPublic: boolean("is_public").notNull().default(false),
		domain: text("domain").unique("service_ports_domain_unique"),
		protocol: text("protocol", { enum: ["http", "tcp", "udp"] })
			.notNull()
			.default("http"),
		externalPort: integer("external_port"),
		tlsPassthrough: boolean("tls_passthrough").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [index("service_ports_service_id_idx").on(table.serviceId)],
);

export const serviceVolumes = pgTable(
	"service_volumes",
	{
		id: text("id").primaryKey(),
		serviceId: text("service_id")
			.notNull()
			.references(() => services.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		containerPath: text("container_path").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [index("service_volumes_service_id_idx").on(table.serviceId)],
);

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
		isDeletionBackup: boolean("is_deletion_backup").default(false),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		index("volume_backups_volume_status_created_at_idx").on(
			table.volumeId,
			table.status,
			table.createdAt,
		),
		index("volume_backups_service_created_at_idx").on(
			table.serviceId,
			table.createdAt,
		),
		index("volume_backups_server_id_idx").on(table.serverId),
		index("volume_backups_created_at_idx").on(table.createdAt),
	],
);

export const secrets = pgTable(
	"secrets",
	{
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
	},
	(table) => [index("secrets_service_id_idx").on(table.serviceId)],
);

export const serviceRevisions = pgTable(
	"service_revisions",
	{
		id: text("id").primaryKey(),
		serviceId: text("service_id")
			.notNull()
			.references(() => services.id, { onDelete: "cascade" }),
		specification: jsonb("specification")
			.$type<ServiceRevisionSpec>()
			.notNull(),
		actor: jsonb("actor").$type<ServiceRevisionActor | null>(),
		artifactDeletedAt: timestamp("artifact_deleted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		unique("service_revisions_id_service_id_unique").on(
			table.id,
			table.serviceId,
		),
		index("service_revisions_service_created_id_idx").on(
			table.serviceId,
			table.createdAt,
			table.id,
		),
	],
);

export const deployments = pgTable(
	"deployments",
	{
		id: text("id").primaryKey(),
		serviceId: text("service_id")
			.notNull()
			.references(() => services.id, { onDelete: "cascade" }),
		serviceRevisionId: text("service_revision_id").notNull(),
		serverId: text("server_id")
			.notNull()
			.references(() => servers.id, { onDelete: "cascade" }),
		containerId: text("container_id"),
		ipAddress: text("ip_address"),
		runtimeDesiredState: text("runtime_desired_state", {
			enum: ["running", "stopped", "removed"],
		})
			.notNull()
			.default("running"),
		trafficState: text("traffic_state", {
			enum: ["candidate", "active", "draining", "inactive"],
		})
			.notNull()
			.default("candidate"),
		observedPhase: text("observed_phase", {
			enum: [
				"pending",
				"pulling",
				"starting",
				"waking",
				"healthy",
				"running",
				"sleeping",
				"stopped",
				"failed",
				"unknown",
			],
		})
			.notNull()
			.default("pending"),
		healthStatus: text("health_status", {
			enum: ["none", "starting", "healthy", "unhealthy"],
		}),
		unhealthyReportCount: integer("unhealthy_report_count")
			.notNull()
			.default(0),
		autohealRestartCount: integer("autoheal_restart_count")
			.notNull()
			.default(0),
		autohealRecreateCount: integer("autoheal_recreate_count")
			.notNull()
			.default(0),
		rolloutId: text("rollout_id"),
		previousDeploymentId: text("previous_deployment_id"),
		failedStage: text("failed_stage"),
		serverlessWakeFailureCount: integer("serverless_wake_failure_count")
			.notNull()
			.default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("deployments_container_id_idx").on(table.containerId),
		index("deployments_rollout_id_idx").on(table.rolloutId),
		index("deployments_service_id_idx").on(table.serviceId),
		index("deployments_service_traffic_runtime_idx").on(
			table.serviceId,
			table.trafficState,
			table.runtimeDesiredState,
		),
		index("deployments_service_revision_id_idx").on(table.serviceRevisionId),
		index("deployments_server_id_idx").on(table.serverId),
		uniqueIndex("deployments_server_id_ip_address_unique_idx")
			.on(table.serverId, table.ipAddress)
			.where(sql`${table.ipAddress} is not null`),
		foreignKey({
			name: "deployments_service_revision_service_fk",
			columns: [table.serviceRevisionId, table.serviceId],
			foreignColumns: [serviceRevisions.id, serviceRevisions.serviceId],
		}).onDelete("no action"),
	],
);

export const rollouts = pgTable(
	"rollouts",
	{
		id: text("id").primaryKey(),
		serviceId: text("service_id")
			.notNull()
			.references(() => services.id, { onDelete: "cascade" }),
		serviceRevisionId: text("service_revision_id").notNull(),
		status: text("status", {
			enum: ["queued", "in_progress", "completed", "failed", "rolled_back"],
		})
			.notNull()
			.default("queued"),
		currentStage: text("current_stage"),
		routingTargets: jsonb("routing_targets")
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		index("rollouts_service_created_at_idx").on(
			table.serviceId,
			table.createdAt,
		),
		index("rollouts_service_status_idx").on(table.serviceId, table.status),
		uniqueIndex("rollouts_service_revision_id_unique_idx").on(
			table.serviceRevisionId,
		),
		foreignKey({
			name: "rollouts_service_revision_service_fk",
			columns: [table.serviceRevisionId, table.serviceId],
			foreignColumns: [serviceRevisions.id, serviceRevisions.serviceId],
		}).onDelete("no action"),
	],
);

export const deploymentPorts = pgTable(
	"deployment_ports",
	{
		id: text("id").primaryKey(),
		deploymentId: text("deployment_id")
			.notNull()
			.references(() => deployments.id, { onDelete: "cascade" }),
		containerPort: integer("container_port").notNull(),
		hostPort: integer("host_port").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("deployment_ports_deployment_id_idx").on(table.deploymentId),
	],
);

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
				"reconcile",
				"stop",
				"restart",
				"force_cleanup",
				"cleanup_volumes",
				"build",
				"backup_volume",
				"restore_volume",
				"create_manifest",
				"upgrade_agent",
				"sync_registries",
				"command",
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
		index("work_queue_server_status_created_at_idx").on(
			table.serverId,
			table.status,
			table.createdAt,
		),
		uniqueIndex("work_queue_one_active_agent_upgrade_idx")
			.on(table.serverId)
			.where(
				sql`${table.type} = 'upgrade_agent' AND ${table.status} IN ('pending', 'processing')`,
			),
		uniqueIndex("work_queue_one_pending_registry_sync_idx")
			.on(table.serverId)
			.where(
				sql`${table.type} = 'sync_registries' AND ${table.status} = 'pending'`,
			),
	],
);

export const serviceCommands = pgTable(
	"service_commands",
	{
		id: text("id").primaryKey(),
		serviceId: text("service_id")
			.notNull()
			.references(() => services.id, { onDelete: "cascade" }),
		deploymentId: text("deployment_id").notNull(),
		serverId: text("server_id").notNull(),
		serverName: text("server_name").notNull(),
		containerId: text("container_id").notNull(),
		actor: jsonb("actor").$type<{ id: string; name: string }>().notNull(),
		command: text("command").notNull(),
		status: text("status", {
			enum: ["pending", "running", "succeeded", "failed", "timed_out"],
		})
			.notNull()
			.default("pending"),
		output: text("output"),
		exitCode: integer("exit_code"),
		outputTruncated: boolean("output_truncated").notNull().default(false),
		errorMessage: text("error_message"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		startedAt: timestamp("started_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		index("service_commands_service_created_id_idx").on(
			table.serviceId,
			table.createdAt,
			table.id,
		),
		index("service_commands_created_at_idx").on(table.createdAt),
	],
);

export const githubInstallations = pgTable(
	"github_installations",
	{
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
	},
	(table) => [index("github_installations_user_id_idx").on(table.userId)],
);

export const githubRepos = pgTable(
	"github_repos",
	{
		id: text("id").primaryKey(),
		installationId: integer("installation_id")
			.notNull()
			.references(() => githubInstallations.installationId, {
				onDelete: "cascade",
			}),
		repoId: integer("repo_id").notNull(),
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
		index("github_repos_repo_id_idx").on(table.repoId),
	],
);

export const builds = pgTable(
	"builds",
	{
		id: text("id").primaryKey(),
		serviceId: text("service_id")
			.notNull()
			.references(() => services.id, { onDelete: "cascade" }),
		serviceRevisionId: text("service_revision_id").notNull(),
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
		targetPlatform: text("target_platform").notNull(),
		buildGroupId: text("build_group_id").notNull(),
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
		index("builds_service_created_at_idx").on(table.serviceId, table.createdAt),
		index("builds_service_revision_id_idx").on(table.serviceRevisionId),
		index("builds_build_group_id_idx").on(table.buildGroupId),
		index("builds_claimed_by_idx").on(table.claimedBy),
		foreignKey({
			name: "builds_service_revision_service_fk",
			columns: [table.serviceRevisionId, table.serviceId],
			foreignColumns: [serviceRevisions.id, serviceRevisions.serviceId],
		}).onDelete("cascade"),
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
