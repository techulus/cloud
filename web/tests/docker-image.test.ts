import { describe, expect, it, vi } from "vitest";
import { validateDockerImageInternal } from "@/lib/docker-image";

describe("Docker image syntax validation", () => {
	it.each([
		"alpine",
		"owner/api:release-1",
		"ghcr.io/acme/api:release",
		`localhost:5000/api@sha256:${"a".repeat(64)}`,
	])("accepts %s without network access", async (image) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(validateDockerImageInternal(image)).resolves.toEqual({
			valid: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it.each([
		"",
		"https://ghcr.io/acme/api:tag",
		"ghcr.io/acme//api:tag",
		"ghcr.io/acme/api?x:tag",
		"UPPER/repo:tag",
		"alpine@sha256:short",
	])("rejects %s", async (image) => {
		await expect(validateDockerImageInternal(image)).resolves.toMatchObject({
			valid: false,
		});
	});
});
