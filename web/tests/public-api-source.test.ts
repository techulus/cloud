import { describe, expect, it } from "vitest";
import {
	canonicalGitHubRepository,
	isSafeRepositoryRoot,
	publicSourceSchema,
	replaceConfigurationSchema,
} from "@/lib/public-api";

const completeConfiguration = (overrides: Record<string, unknown> = {}) => ({
	name: "web",
	source: { type: "image", image: "nginx:1.27" },
	hostname: "web",
	ports: [],
	placement: { mode: "automatic", replicas: 1 },
	healthCheck: null,
	startCommand: null,
	resources: null,
	...overrides,
});

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
			replaceConfigurationSchema.safeParse(
				completeConfiguration({
					source: {
						type: "github",
						repository: "https://github.com/owner/repository",
						branch: "   ",
						rootDir: null,
					},
				}),
			).success,
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
			rootDir: null,
			image: "registry.example/app:latest",
		},
	])("rejects mixed source fields", (source) => {
		expect(
			replaceConfigurationSchema.safeParse(completeConfiguration({ source }))
				.success,
		).toBe(false);
	});

	it("requires explicit null to clear rootDir", () => {
		const omitted = publicSourceSchema.safeParse({
			type: "github",
			repository: "https://github.com/owner/repository",
			branch: "main",
		});
		const cleared = publicSourceSchema.parse({
			type: "github",
			repository: "https://github.com/owner/repository",
			branch: "main",
			rootDir: null,
		});

		expect(omitted.success).toBe(false);
		expect(cleared).toHaveProperty("rootDir", null);
	});
});

describe("public API placement schema", () => {
	it("requires every managed field and rejects unknown fields", () => {
		expect(replaceConfigurationSchema.safeParse({ name: "web" }).success).toBe(
			false,
		);
		expect(
			replaceConfigurationSchema.safeParse(
				completeConfiguration({ unmanaged: true }),
			).success,
		).toBe(false);
	});

	it("rejects the removed standalone replicas field", () => {
		expect(replaceConfigurationSchema.safeParse({ replicas: 3 }).success).toBe(
			false,
		);
	});

	it.each([
		{ mode: "automatic", replicas: 3 },
		{ mode: "manual", placements: [{ serverId: "server-1", count: 2 }] },
	])("accepts valid placement intent", (placement) => {
		expect(
			replaceConfigurationSchema.safeParse(completeConfiguration({ placement }))
				.success,
		).toBe(true);
	});

	it.each([
		{ mode: "automatic", replicas: 0 },
		{ mode: "manual", placements: [] },
		{
			mode: "manual",
			placements: [
				{ serverId: "a", count: 6 },
				{ serverId: "b", count: 5 },
			],
		},
		{
			mode: "manual",
			placements: [
				{ serverId: "a", count: 1 },
				{ serverId: "a", count: 1 },
			],
		},
	])("rejects invalid placement intent", (placement) => {
		expect(
			replaceConfigurationSchema.safeParse(completeConfiguration({ placement }))
				.success,
		).toBe(false);
	});
});
