export const DOCKER_HUB_HOST = "docker.io";
export const DOCKER_HUB_AUTH_KEY = "https://index.docker.io/v1/";

const HOST_PATTERN =
	/^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::(?:[1-9]\d{0,4}))?$/;
const NAME_SEGMENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TAG = /^[\w][\w.-]{0,127}$/;
const DIGEST = /^[A-Za-z][A-Za-z0-9_+.-]*:[0-9a-fA-F]{32,256}$/;
const GAR_REPOSITORY =
	/^([a-z0-9-]+)-docker\.pkg\.dev\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;

export type GarConfiguration = {
	host: string;
	imageBase: string;
	agentKeyBase64: string;
};

function parseServiceAccountKey(value: string | undefined): string {
	try {
		if (
			!value ||
			value !== value.trim() ||
			!/^[A-Za-z0-9+/]+={0,2}$/.test(value)
		)
			throw new Error("invalid base64");
		const decoded = Buffer.from(value, "base64");
		if (
			decoded.length === 0 ||
			decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
		)
			throw new Error("invalid base64");
		const credentials: unknown = JSON.parse(decoded.toString("utf8"));
		if (
			!credentials ||
			typeof credentials !== "object" ||
			(credentials as Record<string, unknown>).type !== "service_account" ||
			typeof (credentials as Record<string, unknown>).project_id !== "string" ||
			!(credentials as Record<string, string>).project_id ||
			typeof (credentials as Record<string, unknown>).private_key !==
				"string" ||
			!(credentials as Record<string, string>).private_key.includes(
				"BEGIN PRIVATE KEY",
			) ||
			typeof (credentials as Record<string, unknown>).client_email !==
				"string" ||
			!(credentials as Record<string, string>).client_email ||
			typeof (credentials as Record<string, unknown>).token_uri !== "string" ||
			!(credentials as Record<string, string>).token_uri
		) {
			throw new Error("invalid service account");
		}
		return value;
	} catch {
		throw new Error(
			"GAR_AGENT_KEY_BASE64 must be a base64-encoded service-account JSON key",
		);
	}
}

export function resolveGarConfiguration(
	env: Record<string, string | undefined> = process.env,
): GarConfiguration {
	const imageBase = env.GAR_REPOSITORY;
	if (!imageBase)
		throw new Error("GAR_REPOSITORY environment variable is required");
	if (imageBase !== imageBase.trim() || imageBase.includes("://")) {
		throw new Error(
			"GAR_REPOSITORY must be <location>-docker.pkg.dev/<project>/<repository>",
		);
	}
	const match = GAR_REPOSITORY.exec(imageBase);
	if (!match) {
		throw new Error(
			"GAR_REPOSITORY must be <location>-docker.pkg.dev/<project>/<repository>",
		);
	}
	const [, location, googleProjectId, repositoryId] = match;
	if (!location || !googleProjectId || !repositoryId)
		throw new Error("Invalid GAR_REPOSITORY");
	return {
		host: `${location}-docker.pkg.dev`,
		imageBase,
		agentKeyBase64: parseServiceAccountKey(env.GAR_AGENT_KEY_BASE64),
	};
}

export function canonicalizeRegistryHost(host: string): string {
	const value = host.trim();
	if (
		!value ||
		host !== value ||
		value.includes("://") ||
		!HOST_PATTERN.test(value)
	) {
		throw new Error(
			"Registry host must be a hostname with an optional port and no scheme or path",
		);
	}
	const parsed = new URL(`https://${value}`);
	if (Number(parsed.port) > 65535) throw new Error("Invalid registry port");
	const hostname = parsed.hostname.toLowerCase();
	if (!hostname.startsWith("[") && !/^\d+(?:\.\d+){3}$/.test(hostname)) {
		if (
			hostname.length > 253 ||
			hostname
				.split(".")
				.some(
					(label) =>
						label.length > 63 ||
						!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
				)
		) {
			throw new Error("Invalid registry hostname");
		}
	}
	const canonical = `${hostname}${parsed.port ? `:${parsed.port}` : ""}`;
	return canonical === "index.docker.io" || canonical === "registry-1.docker.io"
		? DOCKER_HUB_HOST
		: canonical;
}

export function parseRegistryEndpoint(endpoint: string): string {
	const value = endpoint.trim();
	if (!value) throw new Error("Registry endpoint is required");
	const url = new URL(value.includes("://") ? value : `https://${value}`);
	if (
		!/^(https?):$/.test(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"Registry endpoint must not contain credentials, a path, query, or fragment",
		);
	}
	return canonicalizeRegistryHost(url.host);
}

export function registryAuthKey(host: string): string {
	return host === DOCKER_HUB_HOST ? DOCKER_HUB_AUTH_KEY : host;
}

export type ParsedImageReference = {
	host: string;
	repository: string;
	tag: string | null;
	digest: string | null;
	normalized: string;
};

export function parseImageReference(input: string): ParsedImageReference {
	if (!input || input !== input.trim() || /[\\?#\s]/.test(input))
		throw new Error("Invalid image reference syntax");
	const at = input.indexOf("@");
	if (at !== input.lastIndexOf("@")) throw new Error("Invalid image digest");
	let path = at < 0 ? input : input.slice(0, at);
	const digest = at < 0 ? null : input.slice(at + 1);
	if (digest !== null && !DIGEST.test(digest))
		throw new Error("Invalid image digest");
	const lastSlash = path.lastIndexOf("/");
	const colon = path.lastIndexOf(":");
	const tag = colon > lastSlash ? path.slice(colon + 1) : null;
	if (tag !== null) {
		if (!TAG.test(tag)) throw new Error("Invalid image tag");
		path = path.slice(0, colon);
	}
	const parts = path.split("/");
	const first = parts[0] ?? "";
	const explicit =
		parts.length > 1 &&
		(first.includes(".") ||
			first.includes(":") ||
			first === "localhost" ||
			first.startsWith("["));
	const host = explicit ? canonicalizeRegistryHost(first) : DOCKER_HUB_HOST;
	const names = explicit ? parts.slice(1) : parts;
	if (!names.length || names.some((part) => !NAME_SEGMENT.test(part)))
		throw new Error("Invalid image name");
	if (host === DOCKER_HUB_HOST && names.length === 1) names.unshift("library");
	const repository = names.join("/");
	const suffix = digest ? `@${digest}` : tag ? `:${tag}` : "";
	return {
		host,
		repository,
		tag,
		digest,
		normalized: `${host}/${repository}${suffix}`,
	};
}

export function normalizeImageReference(image: string): string {
	return parseImageReference(image).normalized;
}
