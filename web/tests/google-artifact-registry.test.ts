import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAccessToken: vi.fn() }));

vi.mock("google-auth-library", () => ({
	GoogleAuth: class {
		getAccessToken = mocks.getAccessToken;
	},
}));

import {
	deleteGarProtectionTag,
	deleteGarServicePackage,
	ensureGarProtectionTag,
} from "@/lib/google-artifact-registry";

const SERVICE_ACCOUNT_KEY = Buffer.from(
	JSON.stringify({
		type: "service_account",
		project_id: "credentials-project",
		private_key:
			"-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
		client_email: "admin@credentials-project.iam.gserviceaccount.com",
		token_uri: "https://oauth2.googleapis.com/token",
	}),
).toString("base64");
const IMAGE =
	"us-central1-docker.pkg.dev/google-project/techulus-images/project-1/service-1:revision-123";
const API_PACKAGE =
	"https://artifactregistry.googleapis.com/v1/projects/google-project/locations/us-central1/repositories/techulus-images/packages/project-1%2Fservice-1";
const OPERATION =
	"projects/google-project/locations/us-central1/operations/delete-123";

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("Google Artifact Registry client", () => {
	afterEach(() => vi.useRealTimers());
	beforeEach(() => {
		vi.restoreAllMocks();
		mocks.getAccessToken.mockReset();
		mocks.getAccessToken.mockResolvedValue("access-token");
		process.env.GAR_REPOSITORY =
			"us-central1-docker.pkg.dev/google-project/techulus-images";
		process.env.GAR_AGENT_KEY_BASE64 = SERVICE_ACCOUNT_KEY;
		process.env.GAR_ADMIN_KEY_BASE64 = SERVICE_ACCOUNT_KEY;
	});

	it("creates a deterministic protection tag for the source version", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				jsonResponse({
					name: "source",
					version:
						"projects/p/locations/l/repositories/r/packages/pkg/versions/v1",
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValueOnce(new Response(null, { status: 200 }))
			.mockResolvedValueOnce(
				jsonResponse({
					name: "protected",
					version:
						"projects/p/locations/l/repositories/r/packages/pkg/versions/v1",
				}),
			);

		await expect(ensureGarProtectionTag(IMAGE)).resolves.toEqual({
			version: "projects/p/locations/l/repositories/r/packages/pkg/versions/v1",
			protectionTag: "protected-revision-123",
		});
		expect(fetchMock).toHaveBeenNthCalledWith(
			3,
			`${API_PACKAGE}/tags?tagId=protected-revision-123`,
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer access-token",
					"Content-Type": "application/json",
				}),
				body: JSON.stringify({
					version:
						"projects/p/locations/l/repositories/r/packages/pkg/versions/v1",
				}),
			}),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			4,
			`${API_PACKAGE}/tags/protected-revision-123`,
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer access-token",
				}),
			}),
		);
	});

	it("accepts an existing protection tag only when it targets the same version", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				jsonResponse({ name: "source", version: "version-1" }),
			)
			.mockResolvedValueOnce(
				jsonResponse({ name: "protected", version: "version-2" }),
			);

		await expect(ensureGarProtectionTag(IMAGE)).rejects.toThrow(
			"references a different version",
		);
	});

	it("treats missing protection tags and packages as already deleted", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 404 }));

		await expect(deleteGarProtectionTag(IMAGE)).resolves.toBeUndefined();
		await expect(
			deleteGarServicePackage("project-1", "service-1"),
		).resolves.toBeUndefined();
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			`${API_PACKAGE}/tags/protected-revision-123`,
			API_PACKAGE,
		]);
	});

	it("accepts an immediately completed deletion", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				jsonResponse({ name: OPERATION, done: true, response: {} }),
			);
		await expect(
			deleteGarServicePackage("project-1", "service-1"),
		).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it.each([false, true])(
		"waits for the deletion operation (failure: %s)",
		async (fails) => {
			vi.useFakeTimers();
			const fetchMock = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(jsonResponse({ name: OPERATION }))
				.mockResolvedValueOnce(jsonResponse({ name: OPERATION, done: false }))
				.mockResolvedValueOnce(
					jsonResponse({
						name: OPERATION,
						done: true,
						...(fails
							? { error: { code: 13, message: "sensitive provider details" } }
							: { response: {} }),
					}),
				);
			const settled = vi.fn();
			const deletion = deleteGarServicePackage("project-1", "service-1");
			void deletion.then(settled, settled);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(settled).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(2_000);
			if (fails) {
				await expect(deletion).rejects.toThrow(
					"GAR package deletion operation failed",
				);
			} else {
				await expect(deletion).resolves.toBeUndefined();
			}
			expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
				API_PACKAGE,
				`https://artifactregistry.googleapis.com/v1/${OPERATION}`,
				`https://artifactregistry.googleapis.com/v1/${OPERATION}`,
			]);
		},
	);

	it.each([
		{},
		{ name: "https://untrusted.example/operation" },
		{ name: OPERATION, done: true },
	])("rejects malformed deletion operations: %j", async (body) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body));
		await expect(
			deleteGarServicePackage("project-1", "service-1"),
		).rejects.toThrow("invalid operation");
	});

	it("bounds pending deletion polling to sixty seconds", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => jsonResponse({ name: OPERATION }));
		const deletion = deleteGarServicePackage("project-1", "service-1").catch(
			(error) => error,
		);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await deletion).toEqual(new Error("GAR package deletion timed out"));
		expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
		expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
	});

	it("times out and aborts a stalled GAR request", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(() => new Promise(() => {}));
		const deletion = deleteGarServicePackage("project-1", "service-1").catch(
			(error) => error,
		);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await deletion).toEqual(new Error("GAR package deletion timed out"));
		expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
	});

	it("rejects images outside the configured repository without network access", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		await expect(
			deleteGarProtectionTag(
				"europe-docker.pkg.dev/google-project/other/project-1/service-1:revision-123",
			),
		).rejects.toThrow("unmanaged GAR image");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("redacts authentication failures", async () => {
		mocks.getAccessToken.mockRejectedValue(new Error("private key content"));
		await expect(deleteGarProtectionTag(IMAGE)).rejects.toThrow(
			"GAR protection tag deletion authentication failed",
		);
	});
});
