import { eq } from "drizzle-orm";
import { db } from "@/db";
import { servers, settings } from "@/db/schema";
import { reconcileBunny } from "@/lib/bunny-dns";
import { decryptSecret } from "@/lib/crypto";
import {
	computeEdgeEligibility,
	type EdgeDnsConfig,
	type EdgeDnsSyncState,
	getEffectiveEdgeDomain,
} from "@/lib/edge-dns";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { SETTING_KEYS } from "@/lib/settings-keys";

async function getSetting<T>(key: string): Promise<T | null> {
	const [result] = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, key));
	return (result?.value as T) ?? null;
}

async function setSetting<T>(key: string, value: T): Promise<void> {
	await db.insert(settings).values({ key, value }).onConflictDoUpdate({
		target: settings.key,
		set: { value },
	});
}

export async function enqueueEdgeDnsReconciliation(reason: string) {
	await inngest.send(inngestEvents.edgeDnsReconcile.create({ reason }));
}

export async function getEdgeDnsOverview(fallback: string | null) {
	const [config, sync, proxyRows] = await Promise.all([
		getSetting<EdgeDnsConfig>(SETTING_KEYS.EDGE_DNS_CONFIG),
		getSetting<EdgeDnsSyncState>(SETTING_KEYS.EDGE_DNS_SYNC_STATE),
		db
			.select({
				id: servers.id,
				name: servers.name,
				isProxy: servers.isProxy,
				status: servers.status,
				lastHeartbeat: servers.lastHeartbeat,
				publicIp: servers.publicIp,
				networkHealth: servers.networkHealth,
			})
			.from(servers),
	]);
	const effective = getEffectiveEdgeDomain(fallback);
	const eligibility = computeEdgeEligibility(
		proxyRows.filter((row) => row.isProxy),
	);
	return {
		hostname: effective.hostname,
		hostnameSource: effective.source,
		config: config
			? {
					enabled: config.enabled,
					zoneId: config.zoneId,
					claimedHostname: config.claimedHostname,
					hasAccessKey: Boolean(config.encryptedAccessKey),
				}
			: null,
		sync: sync ?? {
			status: "idle" as const,
			desiredTargets: [],
			currentTargets: [],
		},
		excluded: eligibility.excluded,
	};
}

export async function reconcileEdgeDns() {
	const attemptedAt = new Date().toISOString();
	const [config, fallback, previous, proxyRows] = await Promise.all([
		getSetting<EdgeDnsConfig>(SETTING_KEYS.EDGE_DNS_CONFIG),
		getSetting<string>(SETTING_KEYS.PROXY_DOMAIN),
		getSetting<EdgeDnsSyncState>(SETTING_KEYS.EDGE_DNS_SYNC_STATE),
		db
			.select({
				id: servers.id,
				name: servers.name,
				isProxy: servers.isProxy,
				status: servers.status,
				lastHeartbeat: servers.lastHeartbeat,
				publicIp: servers.publicIp,
				networkHealth: servers.networkHealth,
			})
			.from(servers),
	]);
	const desired = computeEdgeEligibility(
		proxyRows.filter((row) => row.isProxy),
	).targets;
	const domain = getEffectiveEdgeDomain(fallback).hostname;
	if (!config?.enabled || !domain) return;
	if (config.claimedHostname !== domain) {
		await setSetting(SETTING_KEYS.EDGE_DNS_SYNC_STATE, {
			...previous,
			status: "error",
			lastAttemptAt: attemptedAt,
			desiredTargets: desired,
			currentTargets: previous?.currentTargets ?? [],
			error:
				"EDGE_DOMAIN no longer matches the claimed Edge DNS hostname; confirm the new scope in Infrastructure settings",
		} satisfies EdgeDnsSyncState);
		return;
	}
	if (desired.length === 0) {
		await setSetting(SETTING_KEYS.EDGE_DNS_SYNC_STATE, {
			...previous,
			status: "skipped",
			lastAttemptAt: attemptedAt,
			desiredTargets: [],
			currentTargets: previous?.currentTargets ?? [],
			message: "No eligible IPv4 proxy targets; provider records retained",
		} satisfies EdgeDnsSyncState);
		return;
	}
	const currentTargets = previous?.currentTargets ?? [];
	const knownTargetsMatch =
		currentTargets.length === desired.length &&
		currentTargets.every((target, index) => target === desired[index]);
	if (!knownTargetsMatch || previous?.status !== "success") {
		await setSetting(SETTING_KEYS.EDGE_DNS_SYNC_STATE, {
			...previous,
			status: "syncing",
			lastAttemptAt: attemptedAt,
			desiredTargets: desired,
			currentTargets,
		} satisfies EdgeDnsSyncState);
	}
	try {
		const result = await reconcileBunny(
			config,
			await decryptSecret(config.encryptedAccessKey),
			domain,
			desired,
			previous?.providerRecordIds ?? [],
		);
		await setSetting(SETTING_KEYS.EDGE_DNS_SYNC_STATE, {
			status: "success",
			lastAttemptAt: attemptedAt,
			lastSuccessAt: new Date().toISOString(),
			desiredTargets: desired,
			...result,
			message: `Synchronized ${result.currentTargets.length} target(s)`,
		} satisfies EdgeDnsSyncState);
	} catch (error) {
		await setSetting(SETTING_KEYS.EDGE_DNS_SYNC_STATE, {
			...previous,
			status: "error",
			lastAttemptAt: attemptedAt,
			desiredTargets: desired,
			currentTargets: previous?.currentTargets ?? [],
			error:
				error instanceof Error ? error.message : "DNS synchronization failed",
		} satisfies EdgeDnsSyncState);
		throw error;
	}
}
