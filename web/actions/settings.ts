"use server";

import { setSetting } from "@/db/queries";
import { revalidatePath } from "next/cache";
import isEmail from "validator/es/lib/isEmail";
import {
	SETTING_KEYS,
	MIN_BACKUP_RETENTION_DAYS,
	MAX_BACKUP_RETENTION_DAYS,
	type BackupStorageConfig,
	type SmtpConfig,
	type EmailAlertsConfig,
	smtpConfigSchema,
	emailAlertsConfigSchema,
} from "@/lib/settings-keys";
import { verifyConnection, sendEmail, getAppBaseUrl } from "@/lib/email";
import { TestEmail } from "@/lib/email/templates/test-email";
import { ZodError } from "zod";
import { getZodErrorMessage } from "@/lib/utils";
import { buildTimeoutSchema } from "@/lib/schemas";

export async function updateBuildServers(serverIds: string[]) {
	await setSetting(SETTING_KEYS.SERVERS_ALLOWED_FOR_BUILDS, serverIds);
	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function updateExcludedServers(serverIds: string[]) {
	await setSetting(
		SETTING_KEYS.SERVERS_EXCLUDED_FROM_WORKLOAD_PLACEMENT,
		serverIds,
	);
	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function updateBuildTimeout(minutes: number) {
	try {
		const validatedMinutes = buildTimeoutSchema.parse(minutes);
		await setSetting(SETTING_KEYS.BUILD_TIMEOUT_MINUTES, validatedMinutes);
		revalidatePath("/dashboard/settings");
		return { success: true };
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(getZodErrorMessage(error, "Invalid build timeout"));
		}
		throw error;
	}
}

export async function updateBackupStorageConfig(config: BackupStorageConfig) {
	if (
		config.retentionDays < MIN_BACKUP_RETENTION_DAYS ||
		config.retentionDays > MAX_BACKUP_RETENTION_DAYS
	) {
		throw new Error(
			`Retention days must be between ${MIN_BACKUP_RETENTION_DAYS} and ${MAX_BACKUP_RETENTION_DAYS}`,
		);
	}

	await setSetting(SETTING_KEYS.BACKUP_STORAGE_CONFIG, config);

	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function updateAcmeEmail(email: string) {
	const trimmed = email.trim();
	if (trimmed && !isEmail(trimmed)) {
		throw new Error("Invalid email address");
	}
	await setSetting(SETTING_KEYS.ACME_EMAIL, trimmed || null);
	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function updateProxyDomain(domain: string) {
	const trimmed = domain.trim();
	await setSetting(SETTING_KEYS.PROXY_DOMAIN, trimmed || null);
	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function updateSmtpConfig(config: SmtpConfig) {
	try {
		const validated = smtpConfigSchema.parse(config);
		await setSetting(SETTING_KEYS.SMTP_CONFIG, validated);
		revalidatePath("/dashboard/settings");
		return { success: true };
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(getZodErrorMessage(error, "Invalid SMTP configuration"));
		}
		throw error;
	}
}

export async function testSmtpConnection(config: SmtpConfig) {
	try {
		await verifyConnection(config);
		return { success: true };
	} catch (error) {
		throw new Error(
			error instanceof Error ? error.message : "Failed to connect to SMTP server",
		);
	}
}

export async function sendTestEmail(config: SmtpConfig, toAddress: string) {
	if (!toAddress.trim()) {
		throw new Error("Recipient email is required");
	}
	if (!isEmail(toAddress.trim())) {
		throw new Error("Invalid recipient email address");
	}

	try {
		await sendEmail(config, {
			to: toAddress.trim(),
			subject: "Test Email from Techulus Cloud",
			template: TestEmail({ baseUrl: getAppBaseUrl() }),
		});
		return { success: true };
	} catch (error) {
		throw new Error(
			error instanceof Error ? error.message : "Failed to send test email",
		);
	}
}

export async function updateEmailAlertsConfig(config: EmailAlertsConfig) {
	try {
		const validated = emailAlertsConfigSchema.parse(config);
		await setSetting(SETTING_KEYS.EMAIL_ALERTS_CONFIG, validated);
		revalidatePath("/dashboard/settings");
		return { success: true };
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(getZodErrorMessage(error, "Invalid email alerts configuration"));
		}
		throw error;
	}
}
