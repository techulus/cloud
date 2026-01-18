import { z } from "zod";

export const SETTING_KEYS = {
	SERVERS_ALLOWED_FOR_BUILDS: "servers_allowed_for_builds",
	SERVERS_EXCLUDED_FROM_WORKLOAD_PLACEMENT:
		"servers_excluded_from_workload_placement",
	BUILD_TIMEOUT_MINUTES: "build_timeout_minutes",
	BACKUP_STORAGE_CONFIG: "backup_storage_config",
	ACME_EMAIL: "acme_email",
	PROXY_DOMAIN: "proxy_domain",
	SMTP_CONFIG: "smtp_config",
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

export const DEFAULT_SMTP_PORT = 587;
export const DEFAULT_SMTP_TIMEOUT = 10000;

const commaSeparatedEmails = z
	.string()
	.transform((val) => val.trim())
	.refine(
		(val) => {
			if (!val) return true;
			const emails = val
				.split(",")
				.map((e) => e.trim())
				.filter(Boolean);
			const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
			return emails.every((email) => emailRegex.test(email));
		},
		{ message: "Invalid email address in list" },
	);

export const smtpConfigSchema = z.object({
	enabled: z.boolean(),
	fromName: z.string().transform((val) => val.trim()),
	fromAddress: z
		.string()
		.min(1, "From address is required")
		.email("Invalid from address")
		.transform((val) => val.trim()),
	host: z
		.string()
		.min(1, "SMTP host is required")
		.transform((val) => val.trim()),
	port: z.number().int().min(1).max(65535, "Port must be between 1 and 65535"),
	username: z.string().transform((val) => val.trim()),
	password: z.string(),
	encryption: z.enum(["starttls", "tls", "none"]),
	timeout: z
		.number()
		.int()
		.min(1000, "Timeout must be at least 1 second")
		.max(60000, "Timeout must be at most 60 seconds"),
	alertEmails: commaSeparatedEmails,
});

export type SmtpEncryption = "starttls" | "tls" | "none";
export type SmtpConfig = z.infer<typeof smtpConfigSchema>;
