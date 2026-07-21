import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const dbUser = {
		id: "user-1",
		name: "Alice",
		email: "alice@example.com",
		banned: false,
		banExpires: null as Date | null,
	};
	return {
		createApiKey: vi.fn(),
		verifyApiKey: vi.fn(),
		getSession: vi.fn(),
		getUserRole: vi.fn(),
		dbUser,
		db: {
			select: vi.fn(() => {
				const query = {
					from: vi.fn(() => query),
					where: vi.fn(() => query),
					limit: vi.fn(() => query),
					// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
					then: (
						resolve: (value: unknown[]) => unknown,
						reject?: (reason: unknown) => unknown,
					) => Promise.resolve([dbUser]).then(resolve, reject),
				};
				return query;
			}),
		},
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));

vi.mock("@/lib/auth", () => ({
	auth: {
		api: {
			createApiKey: mocks.createApiKey,
			verifyApiKey: mocks.verifyApiKey,
			getSession: mocks.getSession,
		},
	},
}));

vi.mock("@/lib/members", () => ({
	AdminNotConfiguredError: class AdminNotConfiguredError extends Error {
		code = "ADMIN_NOT_CONFIGURED";
	},
	getUserRole: mocks.getUserRole,
	hasAnyRole: (role: string, allowedRoles: string[]) =>
		allowedRoles.includes(role),
}));

import { POST as createApiKey } from "@/app/api/v1/api-keys/route";
import { requireApiKeyDeveloperRole, requireApiKeyRole } from "@/lib/api-auth";

const session = {
	user: {
		id: "user-1",
		name: "Alice",
		email: "alice@example.com",
	},
	session: {
		id: "session-1",
		expiresAt: new Date("2027-01-01T00:00:00Z"),
	},
};

describe("public API authentication", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue(session);
		mocks.verifyApiKey.mockResolvedValue({
			valid: true,
			error: null,
			key: {
				id: "key-1",
				referenceId: "user-1",
				expiresAt: null,
			},
		});
		Object.assign(mocks.dbUser, {
			id: "user-1",
			name: "Alice",
			email: "alice@example.com",
			banned: false,
			banExpires: null,
		});
		mocks.getUserRole.mockResolvedValue("reader");
		mocks.createApiKey.mockResolvedValue({
			id: "key-1",
			key: "tcl_secret",
			name: "CLI",
		});
	});

	it("rejects cookie and bearer credentials without X-API-Key", async () => {
		const credentialHeaders: HeadersInit[] = [
			{ cookie: "better-auth.session_token=session" },
			{ authorization: "Bearer device-token" },
		];
		for (const headers of credentialHeaders) {
			const result = await requireApiKeyRole(
				new Request("https://cloud.test/api/v1/projects", { headers }),
				["admin", "developer", "reader"],
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.response.status).toBe(401);
				expect(await result.response.json()).toEqual({
					message: "Unauthorized",
					code: "UNAUTHORIZED",
				});
			}
		}
		expect(mocks.verifyApiKey).not.toHaveBeenCalled();
	});

	it("validates only X-API-Key and never falls back to a cookie or bearer token", async () => {
		const result = await requireApiKeyRole(
			new Request("https://cloud.test/api/v1/me", {
				headers: {
					"x-api-key": "tcl_secret",
					cookie: "better-auth.session_token=session",
					authorization: "Bearer device-token",
					"user-agent": "tc/test",
				},
			}),
			["reader"],
		);

		expect(result.ok).toBe(true);
		expect(mocks.verifyApiKey).toHaveBeenCalledWith({
			body: { key: "tcl_secret" },
		});
		expect(mocks.getSession).not.toHaveBeenCalled();
	});

	it("does not accept a valid cookie when the supplied API key is invalid", async () => {
		mocks.verifyApiKey.mockResolvedValue({
			valid: false,
			error: { message: "Invalid API key", code: "INVALID_API_KEY" },
			key: null,
		});
		const result = await requireApiKeyRole(
			new Request("https://cloud.test/api/v1/projects", {
				headers: {
					"x-api-key": "invalid",
					cookie: "better-auth.session_token=valid-session",
				},
			}),
			["reader"],
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.response.status).toBe(401);
			expect(await result.response.json()).toEqual({
				message: "Unauthorized",
				code: "UNAUTHORIZED",
			});
		}
	});

	it("allows readers to read but rejects them from writes", async () => {
		const request = new Request("https://cloud.test/api/v1/projects/p", {
			headers: { "x-api-key": "tcl_secret" },
		});
		const read = await requireApiKeyRole(request, [
			"admin",
			"developer",
			"reader",
		]);
		const write = await requireApiKeyDeveloperRole(request);

		expect(read.ok).toBe(true);
		expect(write.ok).toBe(false);
		if (!write.ok) {
			expect(write.response.status).toBe(403);
			expect(await write.response.json()).toEqual({
				message: "Forbidden",
				code: "FORBIDDEN",
			});
		}
	});

	it("allows bearer or browser sessions to mint a key", async () => {
		const credentialHeaders: HeadersInit[] = [
			{
				authorization: "Bearer device-token",
				"content-type": "application/json",
			},
			{
				cookie: "better-auth.session_token=session",
				"content-type": "application/json",
			},
		];
		for (const headers of credentialHeaders) {
			const response = await createApiKey(
				new Request("https://cloud.test/api/v1/api-keys", {
					method: "POST",
					headers,
					body: JSON.stringify({ name: "CLI" }),
				}),
			);
			expect(response.status).toBe(201);
			expect(await response.json()).toEqual({
				apiKey: "tcl_secret",
				keyId: "key-1",
				name: "CLI",
			});
		}
		expect(mocks.createApiKey).toHaveBeenCalledTimes(2);
	});

	it("does not let an API key mint another API key", async () => {
		const response = await createApiKey(
			new Request("https://cloud.test/api/v1/api-keys", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": "tcl_secret",
				},
				body: JSON.stringify({ name: "CLI" }),
			}),
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			message: "API keys cannot create API keys",
			code: "API_KEY_AUTH_FORBIDDEN",
		});
		expect(mocks.getSession).not.toHaveBeenCalled();
		expect(mocks.verifyApiKey).not.toHaveBeenCalled();
		expect(mocks.createApiKey).not.toHaveBeenCalled();
	});
});
