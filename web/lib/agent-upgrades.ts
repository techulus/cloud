import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { servers, workQueue } from "@/db/schema";

const GITHUB_RELEASE_BASE_URL =
	"https://github.com/techulus/cloud/releases/download";
const TARGET_VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

type ServerMeta = { arch?: string; os?: string } | null;

export function validateAgentTargetVersion(targetVersion: string) {
	const version = targetVersion.trim();
	if (!TARGET_VERSION_PATTERN.test(version)) {
		throw new Error("Invalid target version");
	}
	return version;
}

function getReleaseArch(meta: ServerMeta) {
	if (meta?.os && meta.os !== "linux") {
		throw new Error(`Agent upgrades are only supported for Linux servers`);
	}
	if (meta?.arch === "amd64" || meta?.arch === "arm64") return meta.arch;
	throw new Error("Server architecture is unknown or unsupported");
}

async function fetchExpectedSha256(targetVersion: string, arch: string) {
	const response = await fetch(
		`${GITHUB_RELEASE_BASE_URL}/${targetVersion}/checksums.txt`,
		{ cache: "no-store" },
	);
	if (!response.ok) {
		throw new Error(`Failed to fetch release checksums (${response.status})`);
	}

	const assetName = `agent-linux-${arch}`;
	const checksums = await response.text();
	for (const line of checksums.split("\n")) {
		const [checksum, fileName] = line.trim().split(/\s+/);
		if (fileName === assetName && /^[0-9a-f]{64}$/i.test(checksum)) {
			return checksum.toLowerCase();
		}
	}

	throw new Error(`Checksum for ${assetName} was not found`);
}

export async function enqueueAgentUpgrade(
	serverId: string,
	targetVersionInput: string,
) {
	const targetVersion = validateAgentTargetVersion(targetVersionInput);

	const [server] = await db
		.select({
			id: servers.id,
			status: servers.status,
			meta: servers.meta,
			agentHealth: servers.agentHealth,
		})
		.from(servers)
		.where(eq(servers.id, serverId))
		.limit(1);

	if (!server) throw new Error("Server not found");
	if (server.status !== "online") throw new Error("Server must be online");
	if (server.agentHealth?.version === targetVersion) {
		await db
			.update(servers)
			.set({
				agentUpgradeTargetVersion: targetVersion,
				agentUpgradeStatus: "succeeded",
				agentUpgradeStartedAt: null,
				agentUpgradeError: null,
			})
			.where(eq(servers.id, serverId));
		return { status: "succeeded" as const };
	}

	const arch = getReleaseArch(server.meta);
	const expectedSha256 = await fetchExpectedSha256(targetVersion, arch);

	try {
		await db.transaction(async (tx) => {
			await tx
				.update(servers)
				.set({
					agentUpgradeTargetVersion: targetVersion,
					agentUpgradeStatus: "queued",
					agentUpgradeStartedAt: null,
					agentUpgradeError: null,
				})
				.where(eq(servers.id, serverId));

			await tx.insert(workQueue).values({
				id: randomUUID(),
				serverId,
				type: "upgrade_agent",
				payload: JSON.stringify({ targetVersion, expectedSha256 }),
			});
		});
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw new Error("Agent upgrade already in progress");
		}
		throw error;
	}

	return { status: "queued" as const };
}

function isUniqueViolation(error: unknown) {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as Error & { code?: string }).code === "23505"
	);
}

export async function clearCompletedAgentUpgrade(serverId: string) {
	await db
		.update(servers)
		.set({
			agentUpgradeTargetVersion: null,
			agentUpgradeStatus: "idle",
			agentUpgradeStartedAt: null,
			agentUpgradeError: null,
		})
		.where(
			and(
				eq(servers.id, serverId),
				eq(servers.agentUpgradeStatus, "succeeded"),
			),
		);
}
