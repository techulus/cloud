import { describe, expect, it } from "vitest";
import {
	canonicalGitHubRepository,
	configurationPatchSchema,
	isSafeRepositoryRoot,
	publicSourceSchema,
} from "@/lib/public-api";

describe("public API GitHub sources", () => {
	it.each([
		[
			" https://github.com/Techulus/Cloud.git/ ",
			"https://github.com/Techulus/Cloud",
		],
		[
			"https://github.com/owner/repository",
			"https://github.com/owner/repository",
		],
	])("canonicalizes %s", (input, expected) => {
		expect(canonicalGitHubRepository(input)).toBe(expected);
	});

	it.each([
		"http://github.com/owner/repository",
		"https://gitHub.example/owner/repository",
		"https://user:password@github.com/owner/repository",
		"https://github.com:8443/owner/repository",
		"https://github.com/owner/repository/issues",
		"https://github.com/owner/repository?tab=readme",
		"git@github.com:owner/repository.git",
	])("rejects non-canonicalizable repository URL %s", (url) => {
		expect(() => canonicalGitHubRepository(url)).toThrow();
	});

	it.each([
		"app",
		"packages/web",
		"packages\\web",
		".",
		"a/./b",
	])("accepts safe repository root %s", (rootDir) =>
		expect(isSafeRepositoryRoot(rootDir)).toBe(true));

	it.each([
		"",
		"/etc",
		"C:\\repo",
		"D:/repo",
		"\\\\server\\share",
		"../outside",
		"app/../../outside",
		"app\\..\\outside",
	])("rejects unsafe repository root %j", (rootDir) => {
		expect(isSafeRepositoryRoot(rootDir)).toBe(false);
	});

	it("normalizes a valid GitHub source", () => {
		expect(
			publicSourceSchema.parse({
				type: "github",
				repository: " https://github.com/owner/repository.git ",
				branch: " feature/test ",
				rootDir: " packages\\web ",
			}),
		).toEqual({
			type: "github",
			repository: "https://github.com/owner/repository",
			branch: "feature/test",
			rootDir: "packages/web",
		});
	});

	it("requires a nonblank GitHub branch", () => {
		expect(
			configurationPatchSchema.safeParse({
				source: {
					type: "github",
					repository: "https://github.com/owner/repository",
					branch: "   ",
				},
			}).success,
		).toBe(false);
	});

	it.each([
		{
			type: "image",
			image: "registry.example/app:latest",
			repository: "https://github.com/owner/repository",
		},
		{
			type: "github",
			repository: "https://github.com/owner/repository",
			branch: "main",
			image: "registry.example/app:latest",
		},
	])("rejects mixed source fields", (source) => {
		expect(configurationPatchSchema.safeParse({ source }).success).toBe(false);
	});

	it("distinguishes omitted rootDir from explicit null", () => {
		const omitted = publicSourceSchema.parse({
			type: "github",
			repository: "https://github.com/owner/repository",
			branch: "main",
		});
		const cleared = publicSourceSchema.parse({
			...omitted,
			rootDir: null,
		});

		expect(omitted).not.toHaveProperty("rootDir");
		expect(cleared).toHaveProperty("rootDir", null);
	});
});
