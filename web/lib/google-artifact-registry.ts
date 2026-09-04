import { GoogleAuth } from "google-auth-library";
import {
	parseImageReference,
	resolveGarConfiguration,
	type GarConfiguration,
} from "@/lib/registry-reference";

const ARTIFACT_REGISTRY_API = "https://artifactregistry.googleapis.com/v1";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

type GarRevision = {
	packageId: string;
	packagePath: string;
	sourceTag: string;
	protectionTag: string;
};

type GarTag = {
	name: string;
	version: string;
};

let cachedAuth: { key: string; auth: GoogleAuth } | undefined;

function googleAuth(configuration: GarConfiguration) {
	if (cachedAuth?.key === configuration.adminKeyBase64) return cachedAuth.auth;
	const auth = new GoogleAuth({
		credentials: configuration.adminCredentials,
		scopes: [CLOUD_PLATFORM_SCOPE],
	});
	cachedAuth = { key: configuration.adminKeyBase64, auth };
	return auth;
}

function packagePath(configuration: GarConfiguration, packageId: string) {
	return `projects/${configuration.googleProjectId}/locations/${configuration.location}/repositories/${configuration.repositoryId}/packages/${encodeURIComponent(packageId)}`;
}

function parseGarRevisionImage(
	image: string,
	configuration: GarConfiguration,
): GarRevision {
	let parsed: ReturnType<typeof parseImageReference>;
	try {
		parsed = parseImageReference(image);
	} catch {
		throw new Error("Malformed or unmanaged GAR image reference");
	}
	const prefix = `${configuration.googleProjectId}/${configuration.repositoryId}/`;
	if (
		parsed.host !== configuration.host ||
		!parsed.repository.startsWith(prefix) ||
		parsed.digest ||
		!parsed.tag?.startsWith("revision-") ||
		parsed.tag === "revision-"
	) {
		throw new Error("Malformed or unmanaged GAR image reference");
	}
	const packageId = parsed.repository.slice(prefix.length);
	if (
		packageId.split("/").length !== 2 ||
		packageId.split("/").some((segment) => !segment)
	) {
		throw new Error("Malformed or unmanaged GAR image reference");
	}
	return {
		packageId,
		packagePath: packagePath(configuration, packageId),
		sourceTag: parsed.tag,
		protectionTag: `protected-${parsed.tag}`,
	};
}

async function garRequest(
	action: string,
	url: string,
	init: RequestInit = {},
): Promise<Response> {
	const configuration = resolveGarConfiguration();
	let accessToken: string | null | undefined;
	try {
		accessToken = await googleAuth(configuration).getAccessToken();
	} catch {
		throw new Error(`GAR ${action} authentication failed`);
	}
	if (!accessToken) throw new Error(`GAR ${action} authentication failed`);
	try {
		return await fetch(url, {
			...init,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...init.headers,
			},
		});
	} catch {
		throw new Error(`GAR ${action} request failed`);
	}
}

async function readTag(
	action: string,
	packageResource: string,
	tag: string,
): Promise<GarTag | null> {
	const response = await garRequest(
		action,
		`${ARTIFACT_REGISTRY_API}/${packageResource}/tags/${encodeURIComponent(tag)}`,
	);
	if (response.status === 404) return null;
	if (!response.ok)
		throw new Error(`GAR ${action} failed (${response.status})`);
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new Error(`GAR ${action} returned an invalid response`);
	}
	if (
		!body ||
		typeof body !== "object" ||
		typeof (body as Record<string, unknown>).name !== "string" ||
		typeof (body as Record<string, unknown>).version !== "string"
	) {
		throw new Error(`GAR ${action} returned an invalid response`);
	}
	return body as GarTag;
}

async function verifyProtectionTag(revision: GarRevision, version: string) {
	const protection = await readTag(
		"protection tag lookup",
		revision.packagePath,
		revision.protectionTag,
	);
	if (!protection || protection.version !== version) {
		throw new Error("GAR protection tag does not reference the source version");
	}
}

export async function ensureGarProtectionTag(image: string) {
	const configuration = resolveGarConfiguration();
	const revision = parseGarRevisionImage(image, configuration);
	const source = await readTag(
		"source tag lookup",
		revision.packagePath,
		revision.sourceTag,
	);
	if (!source) throw new Error("GAR source revision tag was not found");
	const existing = await readTag(
		"protection tag lookup",
		revision.packagePath,
		revision.protectionTag,
	);
	if (existing) {
		if (existing.version !== source.version) {
			throw new Error("GAR protection tag references a different version");
		}
		return { version: source.version, protectionTag: revision.protectionTag };
	}

	const response = await garRequest(
		"protection tag creation",
		`${ARTIFACT_REGISTRY_API}/${revision.packagePath}/tags?tagId=${encodeURIComponent(revision.protectionTag)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ version: source.version }),
		},
	);
	if (response.status !== 409 && !response.ok) {
		throw new Error(`GAR protection tag creation failed (${response.status})`);
	}
	await verifyProtectionTag(revision, source.version);
	return { version: source.version, protectionTag: revision.protectionTag };
}

export async function deleteGarProtectionTag(image: string) {
	const configuration = resolveGarConfiguration();
	const revision = parseGarRevisionImage(image, configuration);
	const response = await garRequest(
		"protection tag deletion",
		`${ARTIFACT_REGISTRY_API}/${revision.packagePath}/tags/${encodeURIComponent(revision.protectionTag)}`,
		{ method: "DELETE" },
	);
	if (response.status !== 404 && !response.ok) {
		throw new Error(`GAR protection tag deletion failed (${response.status})`);
	}
}

export async function deleteGarServicePackage(
	techulusProjectId: string,
	serviceId: string,
) {
	const configuration = resolveGarConfiguration();
	const packageId = `${techulusProjectId}/${serviceId}`;
	const parsed = parseImageReference(
		`${configuration.imageBase}/${packageId}:revision-package-validation`,
	);
	const prefix = `${configuration.googleProjectId}/${configuration.repositoryId}/`;
	if (
		parsed.host !== configuration.host ||
		parsed.repository.slice(prefix.length) !== packageId
	) {
		throw new Error("Invalid managed GAR service package");
	}
	const response = await garRequest(
		"package deletion",
		`${ARTIFACT_REGISTRY_API}/${packagePath(configuration, packageId)}?force=true`,
		{ method: "DELETE" },
	);
	if (response.status !== 404 && !response.ok) {
		throw new Error(`GAR package deletion failed (${response.status})`);
	}
}
