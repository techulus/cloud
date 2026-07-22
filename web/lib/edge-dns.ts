import { isIP } from "node:net";
import { z } from "zod";

export const EDGE_HEARTBEAT_FRESH_MS = 75_000;

export const edgeDnsConfigInputSchema = z
	.object({
		enabled: z.boolean(),
		zoneId: z.string().trim(),
		accessKey: z.string(),
		confirmScope: z.boolean(),
	})
	.superRefine((config, context) => {
		if (config.enabled && !config.zoneId) {
			context.addIssue({
				code: "custom",
				path: ["zoneId"],
				message: "Zone ID is required",
			});
		}
	});

export type EdgeDnsConfigInput = z.infer<typeof edgeDnsConfigInputSchema>;
export type EdgeDnsConfig = Pick<EdgeDnsConfigInput, "enabled" | "zoneId"> & {
	provider: "bunny";
	encryptedAccessKey: string;
	claimedHostname: string;
};
export type EdgeDnsSyncState = {
	status: "idle" | "syncing" | "success" | "error" | "skipped";
	lastAttemptAt?: string;
	lastSuccessAt?: string;
	desiredTargets: string[];
	currentTargets: string[];
	providerRecordIds?: string[];
	error?: string;
	message?: string;
};

export type EdgeProxy = {
	id: string;
	name: string;
	isProxy: boolean;
	status: string;
	lastHeartbeat: Date | null;
	publicIp: string | null;
	networkHealth: { tunnelUp?: boolean } | null;
};

export function getEffectiveEdgeDomain(fallback: string | null) {
	const env = process.env.EDGE_DOMAIN?.trim().replace(/\.$/, "");
	const stored = fallback?.trim().replace(/\.$/, "");
	return env
		? { hostname: env, source: "env" as const }
		: stored
			? { hostname: stored, source: "fallback" as const }
			: { hostname: null, source: "unconfigured" as const };
}

export function computeEdgeEligibility(proxies: EdgeProxy[], now = new Date()) {
	const excluded: Array<{ id: string; name: string; reasons: string[] }> = [];
	const targets = new Set<string>();
	for (const proxy of proxies) {
		const reasons: string[] = [];
		if (!proxy.isProxy) reasons.push("Not configured as a proxy");
		if (proxy.status !== "online") reasons.push("Offline");
		if (
			!proxy.lastHeartbeat ||
			now.getTime() - proxy.lastHeartbeat.getTime() > EDGE_HEARTBEAT_FRESH_MS
		)
			reasons.push("Heartbeat is stale");
		if (!proxy.publicIp || isIP(proxy.publicIp) !== 4)
			reasons.push("No valid IPv4 address");
		if (proxy.networkHealth?.tunnelUp !== true)
			reasons.push("Tunnel is not ready");
		if (reasons.length)
			excluded.push({ id: proxy.id, name: proxy.name, reasons });
		else targets.add(proxy.publicIp as string);
	}
	return { targets: [...targets].sort(), excluded };
}
