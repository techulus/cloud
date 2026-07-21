export function imageUsesMutableReference(image: string): boolean {
	if (image.includes("@")) return false;

	const lastSlash = image.lastIndexOf("/");
	const lastColon = image.lastIndexOf(":");
	if (lastColon <= lastSlash) return true;

	return image.slice(lastColon + 1) === "latest";
}

export function imageIsUnqualified(image: string): boolean {
	const imageWithoutDigest = image.split("@")[0];
	return !imageWithoutDigest.includes("/");
}

export function imageNeedsProductionPinning(image: string): boolean {
	return image !== "" && imageUsesMutableReference(image);
}

const DOCKER_AUTH_URL = "https://auth.docker.io/token";
const DOCKER_MANIFEST_BASE = "https://registry-1.docker.io/v2";
const DOCKER_TAGS_BASE = "https://hub.docker.com/v2/repositories";
const GHCR_TOKEN_URL = "https://ghcr.io/token";
const GHCR_MANIFEST_BASE = "https://ghcr.io/v2";
const MANIFEST_ACCEPT =
	"application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

function isValidImageReferencePart(reference: string): boolean {
	const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
	const digestPattern = /^[A-Za-z0-9_+.-]+:[0-9a-fA-F]{32,256}$/;

	return (
		reference === "latest" ||
		tagPattern.test(reference) ||
		digestPattern.test(reference)
	);
}

function isValidImageNamePart(part: string): boolean {
	const segmentPattern = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
	return part.split("/").every((segment) => segmentPattern.test(segment));
}

function isValidRegistry(registry: string): boolean {
	if (!/^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::[0-9]+)?$/.test(registry)) {
		return false;
	}
	try {
		const url = new URL(`https://${registry}`);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.pathname === "/" &&
			url.search === "" &&
			url.hash === "" &&
			url.hostname !== ""
		);
	} catch {
		return false;
	}
}

function encodePathSegments(value: string): string {
	return value
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

function getBearerToken(value: unknown): string | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	for (const candidate of [record.token, record.access_token]) {
		if (
			typeof candidate === "string" &&
			candidate.trim() === candidate &&
			candidate.length > 0 &&
			!candidate.includes("\r") &&
			!candidate.includes("\n")
		) {
			return candidate;
		}
	}
	return null;
}

async function readBearerToken(response: Response): Promise<string | null> {
	try {
		const value: unknown = await response.json();
		return getBearerToken(value);
	} catch {
		return null;
	}
}

function parseImageReference(image: string): {
	registry: string;
	repositoryPath: string;
	tag: string | null;
	digest: string | null;
} {
	let registry = "docker.io";
	let tag: string | null = null;
	let digest: string | null = null;
	let imagePath = image;

	const digestIndex = imagePath.indexOf("@");
	if (digestIndex !== -1) {
		digest = imagePath.substring(digestIndex + 1);
		imagePath = imagePath.substring(0, digestIndex);
	}
	const tagIndex = imagePath.lastIndexOf(":");
	if (tagIndex > imagePath.lastIndexOf("/")) {
		tag = imagePath.substring(tagIndex + 1);
		imagePath = imagePath.substring(0, tagIndex);
	} else if (!digest) {
		tag = "latest";
	}

	const parts = imagePath.split("/");
	const first = parts[0] ?? "";
	const hasExplicitRegistry =
		parts.length > 1 &&
		(first.toLowerCase() === "localhost" ||
			first.includes(".") ||
			first.includes(":") ||
			first.toLowerCase() !== first);
	const nameParts = hasExplicitRegistry ? parts.slice(1) : parts;
	if (hasExplicitRegistry) {
		registry =
			first.toLowerCase() === "index.docker.io"
				? "docker.io"
				: first.toLowerCase();
	}
	let repositoryPath = nameParts.join("/");
	if (registry === "docker.io" && nameParts.length === 1) {
		repositoryPath = `library/${repositoryPath}`;
	}

	return { registry, repositoryPath, tag, digest };
}

export async function validateDockerImageInternal(
	image: string,
): Promise<{ valid: boolean; error?: string }> {
	try {
		const { registry, repositoryPath, tag, digest } =
			parseImageReference(image);
		const reference = digest || tag || "latest";

		if (
			!isValidImageReferencePart(reference) ||
			(tag !== null && !isValidImageReferencePart(tag))
		) {
			return { valid: false, error: "Invalid image tag or digest" };
		}
		if (!isValidRegistry(registry) || !isValidImageNamePart(repositoryPath)) {
			return { valid: false, error: "Invalid image name" };
		}
		const encodedRepositoryPath = encodePathSegments(repositoryPath);
		const encodedReference = encodeURIComponent(reference);

		if (registry === "docker.io") {
			if (digest) {
				const tokenUrl = new URL(DOCKER_AUTH_URL);
				tokenUrl.search = new URLSearchParams({
					service: "registry.docker.io",
					scope: `repository:${repositoryPath}:pull`,
				}).toString();
				const tokenResponse = await fetch(tokenUrl, { redirect: "error" });
				if (!tokenResponse.ok) {
					return {
						valid: false,
						error: "Failed to authenticate with Docker Hub",
					};
				}
				const token = await readBearerToken(tokenResponse);
				if (!token) {
					return {
						valid: false,
						error: "Failed to authenticate with Docker Hub",
					};
				}
				const manifestUrl = `${DOCKER_MANIFEST_BASE}/${encodedRepositoryPath}/manifests/${encodedReference}`;
				const manifestResponse = await fetch(manifestUrl, {
					redirect: "error",
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: MANIFEST_ACCEPT,
					},
				});
				if (manifestResponse.status === 404) {
					return {
						valid: false,
						error: "Image digest not found on Docker Hub",
					};
				}
				if (!manifestResponse.ok) {
					return { valid: false, error: "Failed to validate image" };
				}
				return { valid: true };
			}

			const url = `${DOCKER_TAGS_BASE}/${encodedRepositoryPath}/tags/${encodedReference}`;
			const response = await fetch(url, {
				method: "GET",
				redirect: "error",
			});
			if (response.status === 404) {
				return { valid: false, error: "Image or tag not found on Docker Hub" };
			}
			if (!response.ok) {
				return { valid: false, error: "Failed to validate image" };
			}
			return { valid: true };
		}

		if (registry === "ghcr.io") {
			const tokenUrl = new URL(GHCR_TOKEN_URL);
			tokenUrl.search = new URLSearchParams({
				scope: `repository:${repositoryPath}:pull`,
			}).toString();
			const tokenResponse = await fetch(tokenUrl, { redirect: "error" });
			if (!tokenResponse.ok) {
				return {
					valid: false,
					error: "Image not found on GitHub Container Registry",
				};
			}
			const token = await readBearerToken(tokenResponse);
			if (!token) {
				return {
					valid: false,
					error: "Image not found on GitHub Container Registry",
				};
			}
			const manifestUrl = `${GHCR_MANIFEST_BASE}/${encodedRepositoryPath}/manifests/${encodedReference}`;
			const manifestResponse = await fetch(manifestUrl, {
				redirect: "error",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: MANIFEST_ACCEPT,
				},
			});
			if (manifestResponse.status === 404) {
				return {
					valid: false,
					error: `Image ${digest ? "digest" : "tag"} not found on GitHub Container Registry`,
				};
			}
			if (!manifestResponse.ok) {
				return { valid: false, error: "Failed to validate image" };
			}
			return { valid: true };
		}

		return { valid: true };
	} catch (error) {
		console.error("Image validation error:", error);
		return { valid: false, error: "Failed to validate image" };
	}
}
