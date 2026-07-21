import { afterEach, describe, expect, it, vi } from "vitest";
import { validateDockerImageInternal } from "@/lib/docker-image";

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("Docker image validation requests", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses fixed Docker Hub origins and encoded digest paths", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ token: "docker-token" }))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const digest = `sha256:${"a".repeat(64)}`;

		await expect(
			validateDockerImageInternal(`alpine@${digest}`),
		).resolves.toEqual({ valid: true });

		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Falpine%3Apull",
		);
		expect(fetchMock.mock.calls[0]?.[1]).toEqual({ redirect: "error" });
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			`https://registry-1.docker.io/v2/library/alpine/manifests/sha256%3A${"a".repeat(64)}`,
			{
				redirect: "error",
				headers: {
					Authorization: "Bearer docker-token",
					Accept: expect.any(String),
				},
			},
		);
	});

	it("validates nested Docker Hub repositories instead of treating them as registries", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			validateDockerImageInternal("owner/team/api:release-1"),
		).resolves.toEqual({ valid: true });

		expect(fetchMock).toHaveBeenCalledWith(
			"https://hub.docker.com/v2/repositories/owner/team/api/tags/release-1",
			{ method: "GET", redirect: "error" },
		);
	});

	it("uses fixed GHCR origins and accepts access_token responses", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ access_token: "ghcr-token" }))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			validateDockerImageInternal("ghcr.io/acme/api:release"),
		).resolves.toEqual({ valid: true });

		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://ghcr.io/token?scope=repository%3Aacme%2Fapi%3Apull",
		);
		expect(fetchMock.mock.calls[0]?.[1]).toEqual({ redirect: "error" });
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"https://ghcr.io/v2/acme/api/manifests/release",
			{
				redirect: "error",
				headers: {
					Authorization: "Bearer ghcr-token",
					Accept: expect.any(String),
				},
			},
		);
	});

	it.each([
		{},
		{ token: "" },
		{ token: " " },
		{ token: 123 },
		{ access_token: null },
		null,
		[],
	])("does not request a manifest for malformed bearer token %#", async (tokenBody) => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse(tokenBody));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			validateDockerImageInternal("ghcr.io/acme/api:release"),
		).resolves.toEqual({
			valid: false,
			error: "Image not found on GitHub Container Registry",
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("handles a non-JSON token response as an authentication failure", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("not json", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			validateDockerImageInternal(`alpine@sha256:${"a".repeat(64)}`),
		).resolves.toEqual({
			valid: false,
			error: "Failed to authenticate with Docker Hub",
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it.each([
		"docker.io.evil.example/owner/api:tag",
		"docker.io:443/owner/api:tag",
		"ghcr.io.evil.example/owner/api:tag",
		"localhost:5000/owner/api:tag",
		"REGISTRY/owner/api:tag",
	])("does not contact unsupported registry %s", async (image) => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);

		await expect(validateDockerImageInternal(image)).resolves.toEqual({
			valid: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"docker.io/acme//api:tag",
		"docker.io/acme\\evil/api:tag",
		"docker.io/acme/api?query:tag",
		"docker.io/acme/%2f:tag",
		"ghcr.io/acme/api#fragment:tag",
	])("rejects structural URL characters in %s", async (image) => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);

		await expect(validateDockerImageInternal(image)).resolves.toMatchObject({
			valid: false,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
