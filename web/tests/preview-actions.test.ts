import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const updateValues: Array<Record<string, unknown>> = [];
	const query = {
		from: vi.fn(() => query),
		where: vi.fn(() => query),
		// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
		then: (
			resolve: (value: unknown[]) => unknown,
			reject?: (reason: unknown) => unknown,
		) => Promise.resolve([{ id: "repo-1" }]).then(resolve, reject),
	};
	return {
		updateValues,
		getService: vi.fn(),
		requireDeveloperRole: vi.fn(),
		requirePreviewDomain: vi.fn(),
		send: vi.fn(),
		createReconcile: vi.fn((data, options) => ({
			name: "preview/service-reconcile-requested",
			data,
			...options,
		})),
		createSync: vi.fn((data, options) => ({
			name: "preview/sync-requested",
			data,
			...options,
		})),
		createClose: vi.fn((data, options) => ({
			name: "preview/close-requested",
			data,
			...options,
		})),
		db: {
			select: vi.fn(() => query),
			update: vi.fn(() => ({
				set: vi.fn((values: Record<string, unknown>) => {
					updateValues.push(values);
					return { where: vi.fn().mockResolvedValue(undefined) };
				}),
			})),
		},
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/db/queries", () => ({ getService: mocks.getService }));
vi.mock("@/lib/auth", () => ({
	requireDeveloperRole: mocks.requireDeveloperRole,
}));
vi.mock("@/lib/preview-deployments", () => ({
	requirePreviewDomain: mocks.requirePreviewDomain,
}));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		previewServiceReconcileRequested: { create: mocks.createReconcile },
		previewSyncRequested: { create: mocks.createSync },
		previewCloseRequested: { create: mocks.createClose },
	},
}));

import {
	redeployPreview,
	removePreview,
	setPreviewDeploymentsEnabled,
} from "@/actions/previews";

const service = {
	id: "service-1",
	sourceType: "github",
	stateful: false,
	previewDeploymentsEnabled: false,
};

describe("preview deployment actions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.updateValues.length = 0;
		mocks.getService.mockResolvedValue(service);
		mocks.requireDeveloperRole.mockResolvedValue({ user: { id: "user-1" } });
		mocks.requirePreviewDomain.mockResolvedValue("apps.example.com");
		mocks.send.mockResolvedValue(undefined);
	});

	it("requires the developer role before reading a service", async () => {
		mocks.requireDeveloperRole.mockRejectedValue(new Error("Forbidden"));

		await expect(
			setPreviewDeploymentsEnabled("service-1", true),
		).rejects.toThrow("Forbidden");
		expect(mocks.getService).not.toHaveBeenCalled();
		expect(mocks.db.update).not.toHaveBeenCalled();
	});

	it("enables previews only after the automatic subdomain is ready", async () => {
		await expect(
			setPreviewDeploymentsEnabled("service-1", true),
		).resolves.toEqual({ success: true });

		expect(mocks.requirePreviewDomain).toHaveBeenCalledOnce();
		expect(mocks.updateValues).toEqual([{ previewDeploymentsEnabled: true }]);
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "preview/service-reconcile-requested",
				data: { baseServiceId: "service-1" },
			}),
		);
	});

	it("rejects stateful services without changing configuration", async () => {
		mocks.getService.mockResolvedValue({ ...service, stateful: true });

		await expect(
			setPreviewDeploymentsEnabled("service-1", true),
		).rejects.toThrow("only for stateless services");
		expect(mocks.db.update).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("does not enable previews when no automatic subdomain is configured", async () => {
		mocks.requirePreviewDomain.mockRejectedValue(
			new Error("Automatic Subdomain Domain must be configured"),
		);

		await expect(
			setPreviewDeploymentsEnabled("service-1", true),
		).rejects.toThrow("Automatic Subdomain Domain must be configured");
		expect(mocks.db.update).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("queues a forced redeploy only for an enabled base service", async () => {
		mocks.getService.mockResolvedValue({
			...service,
			previewDeploymentsEnabled: true,
		});

		await expect(redeployPreview("service-1", 42)).resolves.toEqual({
			success: true,
		});
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "preview/sync-requested",
				data: {
					baseServiceId: "service-1",
					pullRequestNumber: 42,
					force: true,
				},
			}),
		);
	});

	it("queues an explicit preview teardown through the base service", async () => {
		await expect(removePreview("service-1", 42)).resolves.toEqual({
			success: true,
		});
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "preview/close-requested",
				data: {
					baseServiceId: "service-1",
					pullRequestNumber: 42,
					reason: "removed manually",
				},
			}),
		);
	});
});
