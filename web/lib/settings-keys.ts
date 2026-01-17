export const SETTING_KEYS = {
	SERVERS_ALLOWED_FOR_BUILDS: "servers_allowed_for_builds",
	SERVERS_EXCLUDED_FROM_WORKLOAD_PLACEMENT:
		"servers_excluded_from_workload_placement",
	BUILD_TIMEOUT_MINUTES: "build_timeout_minutes",
	BACKUP_STORAGE_CONFIG: "backup_storage_config",
	ACME_EMAIL: "acme_email",
	PROXY_DOMAIN: "proxy_domain",
} as const;

export const DEFAULT_BUILD_TIMEOUT_MINUTES = 30;
export const DEFAULT_BACKUP_RETENTION_DAYS = 7;
export const MIN_BACKUP_RETENTION_DAYS = 7;
export const MAX_BACKUP_RETENTION_DAYS = 30;

export type BackupStorageProvider = "s3" | "r2" | "gcs" | "custom";

export type BackupStorageConfig = {
	provider: BackupStorageProvider;
	bucket: string;
	region: string;
	endpoint: string;
	accessKey: string;
	secretKey: string;
	retentionDays: number;
};
