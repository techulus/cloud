"use server";

import { revalidatePath } from "next/cache";
import isEmail from "validator/es/lib/isEmail";
import { ZodError } from "zod";
import { setSetting } from "@/db/queries";
import { requireAdminRole } from "@/lib/auth";
import {
	checkAndPersistControlPlaneUpdate,
	refreshControlPlaneUpgradeState,
	startControlPlaneUpgrade,
} from "@/lib/control-plane-updates";
import { buildTimeoutSchema } from "@/lib/schemas";
import {
	type EmailAlertsConfig,
	emailAlertsConfigSchema,
	SETTING_KEYS,
} from "@/lib/settings-keys";
import { getZodErrorMessage } from "@/lib/utils";

export async function updateBuildServers(serverIds: string[]) {
	await requireAdminRole();
	await setSetting(SETTING_KEYS.SERVERS_ALLOWED_FOR_BUILDS, serverIds);
	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function updateBuildTimeout(minutes: number) {
	await requireAdminRole();
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
	await requireAdminRole();
	const trimmed = email.trim();
	if (trimmed && !isEmail(trimmed)) {
		throw new Error("Invalid email address");
	}
	await setSetting(SETTING_KEYS.ACME_EMAIL, trimmed || null);
	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function updateProxyDomain(domain: string) {
	await requireAdminRole();
	const trimmed = domain.trim();
	await setSetting(SETTING_KEYS.PROXY_DOMAIN, trimmed || null);
	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function updateEmailAlertsConfig(config: EmailAlertsConfig) {
	await requireAdminRole();
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

export async function checkControlPlaneUpdatesNow() {
	await requireAdminRole();
	const state = await checkAndPersistControlPlaneUpdate();
	revalidatePath("/dashboard/settings");
	return state;
}

export async function upgradeControlPlane(targetVersion: string) {
	await requireAdminRole();
	const state = await startControlPlaneUpgrade(targetVersion);
	revalidatePath("/dashboard/settings");
	return state;
}

export async function refreshControlPlaneUpgradeStatus() {
	await requireAdminRole();
	const state = await refreshControlPlaneUpgradeState();
	revalidatePath("/dashboard/settings");
	return state;
}
