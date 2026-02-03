"use server";

import { setSetting } from "@/db/queries";
import { revalidatePath } from "next/cache";
import isEmail from "validator/es/lib/isEmail";
import {
	SETTING_KEYS,
	type EmailAlertsConfig,
	emailAlertsConfigSchema,
} from "@/lib/settings-keys";
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

export async function updateEmailAlertsConfig(config: EmailAlertsConfig) {
	try {
		const validated = emailAlertsConfigSchema.parse(config);
		await setSetting(SETTING_KEYS.EMAIL_ALERTS_CONFIG, validated);
		revalidatePath("/dashboard/settings");
		return { success: true };
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(
				getZodErrorMessage(error, "Invalid email alerts configuration"),
			);
		}
		throw error;
	}
}
