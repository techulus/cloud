import { z } from "zod";
import type { RolloutStatus } from "@/db/types";
import type { DisplayServiceRevisionActor } from "@/lib/service-revision-actor";
import type {
	ServiceRevisionHealthCheck,
	ServiceRevisionPort,
	ServiceRevisionSpec,
} from "@/lib/service-revision-spec";

const serviceRevisionSpecSchema = z.strictObject({
	schemaVersion: z.literal(2),
	image: z.string(),
	source: z.discriminatedUnion("type", [
		z.strictObject({ type: z.literal("image"), image: z.string() }),
		z.strictObject({
			type: z.literal("github"),
			repository: z.string().url(),
			repositoryId: z.number().int().positive().nullable(),
			branch: z.string().min(1),
			commitSha: z.string().regex(/^[0-9a-f]{40}$/),
			rootDir: z.string().min(1).nullable(),
			authentication: z.discriminatedUnion("type", [
				z.strictObject({ type: z.literal("anonymous") }),
				z.strictObject({
					type: z.literal("github_app"),
					installationId: z.number().int().positive(),
				}),
			]),
		}),
	]),
	hostname: z.string(),
	stateful: z.boolean(),
	serverless: z.strictObject({
		enabled: z.boolean(),
		sleepAfterSeconds: z.number(),
		wakeTimeoutSeconds: z.number(),
	}),
	healthCheck: z
		.strictObject({
			cmd: z.string(),
			interval: z.number(),
			timeout: z.number(),
			retries: z.number(),
			startPeriod: z.number(),
		})
		.nullable(),
	startCommand: z.string().nullable(),
	resourceLimits: z.strictObject({
		cpuCores: z.number().nullable(),
		memoryMb: z.number().nullable(),
	}),
	placements: z.array(
		z.strictObject({ serverId: z.string(), count: z.number() }),
	),
	ports: z.array(
		z.strictObject({
			containerPort: z.number(),
			isPublic: z.boolean(),
			domain: z.string().nullable(),
			protocol: z.enum(["http", "tcp", "udp"]),
			externalPort: z.number().nullable(),
			tlsPassthrough: z.boolean(),
		}),
	),
	secrets: z.array(
		z.strictObject({
			key: z.string(),
			encryptedValue: z.string(),
			updatedAt: z.string(),
		}),
	),
	volumes: z.array(
		z.strictObject({ name: z.string(), containerPath: z.string() }),
	),
});

export type ServiceRevisionChange = {
	field: string;
	from: string;
	to: string;
};

export type ServiceRevisionComparison =
	| { kind: "initial" }
	| { kind: "changes"; changes: ServiceRevisionChange[] }
	| { kind: "unavailable" };

export type ServiceRevisionChangelogItem = {
	id: string;
	createdAt: string;
	actor: DisplayServiceRevisionActor | null;
	comparison: ServiceRevisionComparison;
	rollout: {
		id: string;
		status: RolloutStatus;
	} | null;
};

export type ServiceRevisionChangelogResponse = {
	revisions: ServiceRevisionChangelogItem[];
	nextCursor: string | null;
};

export function parseServiceRevisionSpec(value: unknown): ServiceRevisionSpec {
	return serviceRevisionSpecSchema.parse(value);
}

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b, "en");
}

function enabled(value: boolean): string {
	return value ? "Enabled" : "Disabled";
}

function healthCheckDescription(
	healthCheck: ServiceRevisionHealthCheck,
): string {
	return `${healthCheck.cmd} (interval ${healthCheck.interval}s, timeout ${healthCheck.timeout}s, retries ${healthCheck.retries}, start period ${healthCheck.startPeriod}s)`;
}

function portIdentity(port: ServiceRevisionPort): string {
	return `${port.containerPort}/${port.protocol}/${port.domain ?? "(none)"}`;
}

function portLabel(port: ServiceRevisionPort): string {
	return `${port.containerPort}/${port.protocol}`;
}

function portDescription(port: ServiceRevisionPort): string {
	return [
		`container ${port.containerPort}`,
		`protocol ${port.protocol}`,
		port.isPublic ? "public" : "internal",
		`domain ${port.domain ?? "(none)"}`,
		`external ${port.externalPort ?? "(default)"}`,
		`TLS passthrough ${enabled(port.tlsPassthrough).toLowerCase()}`,
	].join(", ");
}

/** Compare two immutable v2 specifications without requiring browser APIs. */
export function diffServiceRevisionSpecs(
	previous: ServiceRevisionSpec,
	current: ServiceRevisionSpec,
	serverNames: ReadonlyMap<string, string> = new Map(),
): ServiceRevisionChange[] {
	const changes: ServiceRevisionChange[] = [];
	const add = (field: string, from: string, to: string) => {
		if (from !== to) changes.push({ field, from, to });
	};

	add("Image", previous.image, current.image);
	add("Source type", previous.source.type, current.source.type);
	if (previous.source.type === "github" && current.source.type === "github") {
		add(
			"GitHub repository",
			previous.source.repository,
			current.source.repository,
		);
		add("GitHub branch", previous.source.branch, current.source.branch);
		add("GitHub commit", previous.source.commitSha, current.source.commitSha);
		add(
			"GitHub root directory",
			previous.source.rootDir ?? "(repository root)",
			current.source.rootDir ?? "(repository root)",
		);
	}
	add("Hostname", previous.hostname, current.hostname);
	add(
		"Service type",
		previous.stateful ? "Stateful" : "Stateless",
		current.stateful ? "Stateful" : "Stateless",
	);
	add(
		"Serverless",
		enabled(previous.serverless.enabled),
		enabled(current.serverless.enabled),
	);
	add(
		"Serverless sleep timeout",
		`${previous.serverless.sleepAfterSeconds}s`,
		`${current.serverless.sleepAfterSeconds}s`,
	);
	add(
		"Serverless wake timeout",
		`${previous.serverless.wakeTimeoutSeconds}s`,
		`${current.serverless.wakeTimeoutSeconds}s`,
	);

	if (previous.healthCheck === null || current.healthCheck === null) {
		add(
			"Health check",
			previous.healthCheck
				? healthCheckDescription(previous.healthCheck)
				: "(none)",
			current.healthCheck
				? healthCheckDescription(current.healthCheck)
				: "(none)",
		);
	} else {
		add(
			"Health check command",
			previous.healthCheck.cmd,
			current.healthCheck.cmd,
		);
		add(
			"Health check interval",
			`${previous.healthCheck.interval}s`,
			`${current.healthCheck.interval}s`,
		);
		add(
			"Health check timeout",
			`${previous.healthCheck.timeout}s`,
			`${current.healthCheck.timeout}s`,
		);
		add(
			"Health check retries",
			String(previous.healthCheck.retries),
			String(current.healthCheck.retries),
		);
		add(
			"Health check start period",
			`${previous.healthCheck.startPeriod}s`,
			`${current.healthCheck.startPeriod}s`,
		);
	}

	add(
		"Start command",
		previous.startCommand ?? "(default)",
		current.startCommand ?? "(default)",
	);
	add(
		"CPU limit",
		previous.resourceLimits.cpuCores === null
			? "(no limit)"
			: `${previous.resourceLimits.cpuCores} cores`,
		current.resourceLimits.cpuCores === null
			? "(no limit)"
			: `${current.resourceLimits.cpuCores} cores`,
	);
	add(
		"Memory limit",
		previous.resourceLimits.memoryMb === null
			? "(no limit)"
			: `${previous.resourceLimits.memoryMb} MB`,
		current.resourceLimits.memoryMb === null
			? "(no limit)"
			: `${current.resourceLimits.memoryMb} MB`,
	);

	const previousPlacements = new Map(
		previous.placements.map((placement) => [placement.serverId, placement]),
	);
	const currentPlacements = new Map(
		current.placements.map((placement) => [placement.serverId, placement]),
	);
	for (const serverId of [
		...new Set([...previousPlacements.keys(), ...currentPlacements.keys()]),
	].sort(compareStrings)) {
		const before = previousPlacements.get(serverId);
		const after = currentPlacements.get(serverId);
		const serverName = serverNames.get(serverId)?.trim();
		add(
			serverName
				? `${serverName} replicas`
				: `Deleted server (${serverId.slice(0, 8)}) replicas`,
			before ? `${before.count} replicas` : "(none)",
			after ? `${after.count} replicas` : "(removed)",
		);
	}

	const previousPorts = new Map(
		previous.ports.map((port) => [portIdentity(port), port]),
	);
	const currentPorts = new Map(
		current.ports.map((port) => [portIdentity(port), port]),
	);
	for (const identity of [
		...new Set([...previousPorts.keys(), ...currentPorts.keys()]),
	].sort(compareStrings)) {
		const before = previousPorts.get(identity);
		const after = currentPorts.get(identity);
		const port = after ?? before;
		add(
			port ? `Port ${portLabel(port)}` : "Port",
			before ? portDescription(before) : "(none)",
			after ? portDescription(after) : "(removed)",
		);
	}

	const previousSecrets = new Map(
		previous.secrets.map((secret) => [secret.key, secret]),
	);
	const currentSecrets = new Map(
		current.secrets.map((secret) => [secret.key, secret]),
	);
	for (const key of [
		...new Set([...previousSecrets.keys(), ...currentSecrets.keys()]),
	].sort(compareStrings)) {
		const before = previousSecrets.get(key);
		const after = currentSecrets.get(key);
		if (!before && after)
			changes.push({ field: "Secret", from: "(none)", to: `${key} (added)` });
		else if (before && !after)
			changes.push({ field: "Secret", from: key, to: "(removed)" });
		else if (
			before &&
			after &&
			(before.encryptedValue !== after.encryptedValue ||
				before.updatedAt !== after.updatedAt)
		) {
			changes.push({ field: "Secret", from: key, to: `${key} (updated)` });
		}
	}

	const previousVolumes = new Map(
		previous.volumes.map((volume) => [volume.name, volume]),
	);
	const currentVolumes = new Map(
		current.volumes.map((volume) => [volume.name, volume]),
	);
	for (const name of [
		...new Set([...previousVolumes.keys(), ...currentVolumes.keys()]),
	].sort(compareStrings)) {
		const before = previousVolumes.get(name);
		const after = currentVolumes.get(name);
		add(
			`Volume ${name}`,
			before?.containerPath ?? "(none)",
			after?.containerPath ?? "(removed)",
		);
	}

	return changes;
}
