import { createHmac } from "node:crypto";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { registryCredentials } from "@/db/schema";
import type { RegistryCredential } from "@/db/types";
import { encryptRegistryPassword } from "@/lib/crypto";
import { resolveEncryptionKey } from "@/lib/kms";
import {
	registryAuthKey,
	resolveGarConfiguration,
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
	const gar = resolveGarConfiguration(env);
	return [
		{
			id: `system:${gar.host}`,
			host: gar.host,
			username: "_json_key_base64",
			password: gar.agentKeyBase64,
			tlsVerify: true,
		},
	];
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
			"A custom registry collides with the managed GAR configuration",
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
