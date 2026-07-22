export function getEffectiveEdgeDomain(fallback: string | null) {
	const env = process.env.EDGE_DOMAIN?.trim().replace(/\.$/, "");
	const stored = fallback?.trim().replace(/\.$/, "");
	return env
		? { hostname: env, source: "env" as const }
		: stored
			? { hostname: stored, source: "fallback" as const }
			: { hostname: null, source: "unconfigured" as const };
}
