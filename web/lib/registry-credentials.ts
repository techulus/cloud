import { createHmac } from "node:crypto";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { registryCredentials } from "@/db/schema";
import type { RegistryCredential } from "@/db/types";
import { encryptRegistryPassword } from "@/lib/crypto";
import { resolveEncryptionKey } from "@/lib/kms";
import {
	parseRegistryEndpoint,
	registryAuthKey,
} from "@/lib/registry-reference";

export type RegistryMetadata = {
	id: string;
	host: string;
	username: string;
	tlsVerify: boolean;
	system: boolean;
	updatedAt: string | null;
};
export type AgentRegistry = {
	id: string;
	host: string;
	authKey: string;
	username: string;
	encryptedPassword: string;
	tlsVerify: boolean;
	system: boolean;
};
export type AgentRegistryBundle = {
	version: string;
	registries: AgentRegistry[];
};

type SystemCredential = {
	id: string;
	host: string;
	username: string;
	password: string;
	tlsVerify: boolean;
};

type RegistryEnvironment = Record<string, string | undefined>;

export function resolveSystemRegistryCredentials(
	env: RegistryEnvironment = process.env,
): SystemCredential[] {
	const endpointValues = [env.REGISTRY_HOST, env.REGISTRY_URL].filter(
		(value): value is string => Boolean(value),
	);
	const username = env.REGISTRY_USERNAME;
	const password = env.REGISTRY_PASSWORD;
	const insecure = env.REGISTRY_INSECURE;
	const configured =
		endpointValues.length > 0 ||
		username !== undefined ||
		password !== undefined ||
		insecure !== undefined;
	if (!configured) return [];
	if (
		endpointValues.length === 0 ||
		!username ||
		!password ||
		(insecure !== undefined && insecure !== "true" && insecure !== "false")
	) {
		throw new Error("Built-in registry configuration is incomplete");
	}
	const hosts = [...new Set(endpointValues.map(parseRegistryEndpoint))].sort();
	return hosts.map((host) => ({
		id: `system:${host}`,
		host,
		username,
		password,
		tlsVerify: insecure !== "true",
	}));
}

async function readCustomCredentials(): Promise<RegistryCredential[]> {
	return db
		.select()
		.from(registryCredentials)
		.orderBy(asc(registryCredentials.host));
}

function assertNoSystemCollisions(
	custom: RegistryCredential[],
	system: SystemCredential[],
) {
	const reserved = new Set(system.map((credential) => credential.host));
	const collision = custom.find((credential) => reserved.has(credential.host));
	if (collision)
		throw new Error(
			"A custom registry collides with the built-in registry configuration",
		);
}

export async function listRegistryMetadata(): Promise<RegistryMetadata[]> {
	const [custom, system] = await Promise.all([
		readCustomCredentials(),
		Promise.resolve(resolveSystemRegistryCredentials()),
	]);
	assertNoSystemCollisions(custom, system);
	return [
		...system.map((entry) => ({
			id: entry.id,
			host: entry.host,
			username: entry.username,
			tlsVerify: entry.tlsVerify,
			system: true,
			updatedAt: null,
		})),
		...custom.map((entry) => ({
			id: entry.id,
			host: entry.host,
			username: entry.username,
			tlsVerify: entry.tlsVerify,
			system: false,
			updatedAt: entry.updatedAt.toISOString(),
		})),
	].sort((a, b) => a.host.localeCompare(b.host));
}

export async function getRegistryBundle(): Promise<AgentRegistryBundle> {
	const custom = await readCustomCredentials();
	const system = resolveSystemRegistryCredentials();
	assertNoSystemCollisions(custom, system);
	const version = await calculateRegistryBundleVersion(custom, system);
	const systemEntries = await Promise.all(
		system.map(async (entry) => ({
			id: entry.id,
			host: entry.host,
			authKey: registryAuthKey(entry.host),
			username: entry.username,
			encryptedPassword: await encryptRegistryPassword(
				entry.password,
				entry.id,
				entry.host,
			),
			tlsVerify: entry.tlsVerify,
			system: true,
		})),
	);
	const registries = [
		...custom.map((entry) => ({
			id: entry.id,
			host: entry.host,
			authKey: registryAuthKey(entry.host),
			username: entry.username,
			encryptedPassword: entry.encryptedPassword,
			tlsVerify: entry.tlsVerify,
			system: false,
		})),
		...systemEntries,
	].sort((a, b) => a.host.localeCompare(b.host));
	return { version, registries };
}

export async function calculateRegistryBundleVersion(
	custom: Pick<
		RegistryCredential,
		"id" | "host" | "username" | "encryptedPassword" | "tlsVerify"
	>[],
	system: SystemCredential[] = resolveSystemRegistryCredentials(),
): Promise<string> {
	const versionInput = [
		...custom.map((entry) => [
			entry.id,
			entry.host,
			entry.username,
			entry.encryptedPassword,
			entry.tlsVerify,
		]),
		...system.map((entry) => [
			entry.id,
			entry.host,
			entry.username,
			entry.password,
			entry.tlsVerify,
		]),
	].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
	const key = await resolveEncryptionKey();
	return createHmac("sha256", key)
		.update("registry-bundle-version:v1\0")
		.update(JSON.stringify(versionInput))
		.digest("hex");
}

export async function getRegistryBundleVersion(): Promise<string> {
	return (await getRegistryBundle()).version;
}

export function getReservedSystemRegistryHosts(): Set<string> {
	return new Set(resolveSystemRegistryCredentials().map((entry) => entry.host));
}
