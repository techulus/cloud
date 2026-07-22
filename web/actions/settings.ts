"use server";

import { revalidatePath } from "next/cache";
import isEmail from "validator/es/lib/isEmail";
import { ZodError } from "zod";
import { getSetting, setSetting } from "@/db/queries";
import { requireAdminRole, requireAuth } from "@/lib/auth";
import { validateBunnyConnection } from "@/lib/bunny-dns";
import {
	checkAndPersistControlPlaneUpdate,
	refreshControlPlaneAboutState,
	startControlPlaneUpgrade,
} from "@/lib/control-plane-updates";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
	type EdgeDnsConfig,
	type EdgeDnsConfigInput,
	type EdgeDnsSyncState,
	edgeDnsConfigInputSchema,
	getEffectiveEdgeDomain,
} from "@/lib/edge-dns";
import { enqueueEdgeDnsReconciliation } from "@/lib/edge-dns-service";
import { buildTimeoutSchema } from "@/lib/schemas";
import {
	type EmailAlertsConfig,
	emailAlertsConfigSchema,
	SETTING_KEYS,
} from "@/lib/settings-keys";
import { getZodErrorMessage } from "@/lib/utils";

async function requireAdminSession() {
	const session = await requireAdminRole();
	if (!session) {
		throw new Error("Unauthorized");
	}

	return session;
}

export async function updateBuildServers(serverIds: string[]) {
	await requireAdminSession();
	await setSetting(SETTING_KEYS.SERVERS_ALLOWED_FOR_BUILDS, serverIds);
	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function updateBuildTimeout(minutes: number) {
	await requireAdminSession();
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
	await requireAdminSession();
	const trimmed = email.trim();
	if (trimmed && !isEmail(trimmed)) {
		throw new Error("Invalid email address");
	}
	await setSetting(SETTING_KEYS.ACME_EMAIL, trimmed || null);
	revalidatePath("/dashboard/settings");
	return { success: true };
}

async function resolveEdgeAccessKey(inputKey: string) {
	if (inputKey) return inputKey;
	const existing = await getSetting<EdgeDnsConfig>(
		SETTING_KEYS.EDGE_DNS_CONFIG,
	);
	if (!existing?.encryptedAccessKey)
		throw new Error("Bunny API key is required");
	return decryptSecret(existing.encryptedAccessKey);
}

export async function testEdgeDnsConnection(input: EdgeDnsConfigInput) {
	await requireAdminSession();
	const validated = edgeDnsConfigInputSchema.parse(input);
	const fallback = await getSetting<string>(SETTING_KEYS.PROXY_DOMAIN);
	const hostname = getEffectiveEdgeDomain(fallback).hostname;
	if (!hostname)
		throw new Error("Configure EDGE_DOMAIN before enabling Edge DNS");
	const validation = await validateBunnyConnection(
		validated.zoneId,
		await resolveEdgeAccessKey(validated.accessKey),
		hostname,
	);
	return {
		zoneDomain: validation.zoneDomain,
		recordName: validation.name,
		existingARecordCount: validation.exactARecords.length,
	};
}

export async function saveEdgeDnsConfig(input: EdgeDnsConfigInput) {
	await requireAdminSession();
	const validated = edgeDnsConfigInputSchema.parse(input);
	const existing = await getSetting<EdgeDnsConfig>(
		SETTING_KEYS.EDGE_DNS_CONFIG,
	);
	if (!validated.enabled) {
		if (existing) {
			await setSetting(SETTING_KEYS.EDGE_DNS_CONFIG, {
				...existing,
				enabled: false,
			} satisfies EdgeDnsConfig);
		}
		revalidatePath("/dashboard/settings");
		return { success: true };
	}
	const key = await resolveEdgeAccessKey(validated.accessKey);
	const fallback = await getSetting<string>(SETTING_KEYS.PROXY_DOMAIN);
	const hostname = getEffectiveEdgeDomain(fallback).hostname;
	if (!hostname)
		throw new Error("Configure EDGE_DOMAIN before enabling Edge DNS");
	const scopeChanged =
		existing?.zoneId !== validated.zoneId ||
		existing?.claimedHostname !== hostname;
	if (scopeChanged && !validated.confirmScope) {
		throw new Error(
			"Confirm the managed DNS scope before enabling synchronization",
		);
	}
	const validation = await validateBunnyConnection(
		validated.zoneId,
		key,
		hostname,
	);
	await setSetting(SETTING_KEYS.EDGE_DNS_CONFIG, {
		enabled: true,
		zoneId: validated.zoneId,
		provider: "bunny",
		encryptedAccessKey: await encryptSecret(key),
		claimedHostname: hostname,
	} satisfies EdgeDnsConfig);
	if (scopeChanged) {
		const previous = await getSetting<EdgeDnsSyncState>(
			SETTING_KEYS.EDGE_DNS_SYNC_STATE,
		);
		await setSetting(SETTING_KEYS.EDGE_DNS_SYNC_STATE, {
			status: "idle",
			desiredTargets: [],
			currentTargets: validation.exactARecords.flatMap(
				(record) => record.Value ?? [],
			),
			providerRecordIds: validation.exactARecords.map((record) =>
				String(record.Id),
			),
			message: validation.exactARecords.length
				? `Adopted ${validation.exactARecords.length} existing A record(s)${existing ? "; the previous managed scope was left unchanged" : ""}`
				: `Claimed an empty DNS record set${existing ? "; the previous managed scope was left unchanged" : ""}`,
			lastAttemptAt: previous?.lastAttemptAt,
			lastSuccessAt: previous?.lastSuccessAt,
		} satisfies EdgeDnsSyncState);
	}
	await enqueueEdgeDnsReconciliation("config-saved").catch((error) => {
		console.error("Failed to enqueue Edge DNS reconciliation:", error);
	});
	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function syncEdgeDnsNow() {
	await requireAdminSession();
	await enqueueEdgeDnsReconciliation("manual");
	return { success: true };
}

export async function updateEmailAlertsConfig(config: EmailAlertsConfig) {
	await requireAdminSession();
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
	await requireAdminSession();
	const state = await checkAndPersistControlPlaneUpdate();
	revalidatePath("/dashboard/settings");
	return state;
}

export async function upgradeControlPlane(targetVersion: string) {
	await requireAdminSession();
	const state = await startControlPlaneUpgrade(targetVersion);
	revalidatePath("/dashboard/settings");
	return state;
}

export async function refreshControlPlaneAboutStatus() {
	await requireAuth();
	const state = await refreshControlPlaneAboutState();
	revalidatePath("/dashboard/settings");
	return state;
}
