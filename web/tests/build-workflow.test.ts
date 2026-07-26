import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const queryResults: unknown[][] = [];
	function query(result: unknown[]) {
		const builder = {
			from: vi.fn(() => builder),
			where: vi.fn(() => builder),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
			then: (
				resolve: (value: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};
		return builder;
	}
	return {
		queryResults,
		select: vi.fn(() => query(queryResults.shift() ?? [])),
		deployServiceRevisionInternal: vi.fn(),
	};
});

vi.mock("@/db", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/deploy-service", () => ({
	deployServiceRevisionInternal: mocks.deployServiceRevisionInternal,
}));
vi.mock("@/lib/inngest/client", () => ({
	inngest: {
		createFunction: vi.fn(
			(_options: unknown, handler: (input: unknown) => unknown) => handler,
		),
	},
}));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		buildStarted: { name: "build/started" },
		buildCancelled: { name: "build/cancelled" },
		buildCompleted: { name: "build/completed" },
		manifestCompleted: { name: "manifest/completed" },
	},
}));

import { buildWorkflow } from "@/lib/inngest/functions/build-workflow";

function invoke(serviceRevisionId: string, buildGroupId: string) {
	const step = {
		run: vi.fn(async (_name: string, operation: () => unknown) => operation()),
		waitForEvent: vi.fn(),
	};
	const handler = buildWorkflow as unknown as (input: {
		event: { data: Record<string, unknown> };
		step: typeof step;
	}) => Promise<unknown>;
	return {
		result: handler({
			event: {
				data: {
					buildId: `${buildGroupId}-amd64`,
					serviceId: "service-1",
					serviceRevisionId,
					buildGroupId,
				},
			},
			step,
		}),
		step,
	};
}

function completedGroup(
	serviceRevisionId: string,
	buildGroupId: string,
	image: string,
) {
	const group = [
		{
			id: `${buildGroupId}-amd64`,
			status: "completed",
			serviceRevisionId,
			targetPlatform: "linux/amd64",
			imageUri: `${image}-amd64`,
		},
		{
			id: `${buildGroupId}-arm64`,
			status: "completed",
			serviceRevisionId,
			targetPlatform: "linux/arm64",
			imageUri: `${image}-arm64`,
		},
	];
	mocks.queryResults.push(
		group,
		[
			{
				status: "completed",
				payload: JSON.stringify({
					serviceId: "service-1",
					serviceRevisionId,
					buildGroupId,
					finalImageUri: image,
					images: [`${image}-amd64`, `${image}-arm64`],
				}),
			},
		],
		group,
	);
}

describe("revision-first build completion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.queryResults.length = 0;
		mocks.deployServiceRevisionInternal.mockResolvedValue({
			rolloutId: "rollout-1",
			created: true,
		});
	});

	it("deploys each out-of-order build using its own immutable revision", async () => {
		completedGroup("revision-new", "group-new", "registry/app:revision-new");
		await invoke("revision-new", "group-new").result;

		completedGroup("revision-old", "group-old", "registry/app:revision-old");
		await invoke("revision-old", "group-old").result;

		expect(mocks.deployServiceRevisionInternal).toHaveBeenNthCalledWith(
			1,
			"service-1",
			"revision-new",
			"registry/app:revision-new",
		);
		expect(mocks.deployServiceRevisionInternal).toHaveBeenNthCalledWith(
			2,
			"service-1",
			"revision-old",
			"registry/app:revision-old",
		);
	});

	it("leaves a failed build revision without a rollout", async () => {
		mocks.queryResults.push([
			{
				id: "build-failed",
				status: "failed",
				serviceRevisionId: "revision-failed",
			},
		]);

		await expect(
			invoke("revision-failed", "group-failed").result,
		).resolves.toEqual({
			status: "failed",
			reason: "build_failed",
			buildGroupId: "group-failed",
		});
		expect(mocks.deployServiceRevisionInternal).not.toHaveBeenCalled();
	});

	it("uses persisted completion when the build event was missed", async () => {
		const image = "registry/app:revision-missed-build-event";
		const pending = {
			id: "missed-build-amd64",
			status: "building",
			targetPlatform: "linux/amd64",
			imageUri: null,
		};
		const completed = {
			...pending,
			status: "completed",
			imageUri: `${image}-amd64`,
		};
		mocks.queryResults.push(
			[pending],
			[completed],
			[
				{
					status: "completed",
					payload: JSON.stringify({
						serviceId: "service-1",
						serviceRevisionId: "revision-missed-build-event",
						buildGroupId: "group-missed-build-event",
						finalImageUri: image,
						images: [`${image}-amd64`],
					}),
				},
			],
			[completed],
		);

		const { result, step } = invoke(
			"revision-missed-build-event",
			"group-missed-build-event",
		);
		step.waitForEvent.mockResolvedValue(null);
		await expect(result).resolves.toEqual(
			expect.objectContaining({ status: "completed" }),
		);
		expect(mocks.deployServiceRevisionInternal).toHaveBeenCalledWith(
			"service-1",
			"revision-missed-build-event",
			image,
		);
	});

	it("uses persisted manifest completion when its event was missed", async () => {
		const image = "registry/app:revision-missed-manifest-event";
		const group = [
			{
				id: "missed-manifest-amd64",
				status: "completed",
				targetPlatform: "linux/amd64",
				imageUri: `${image}-amd64`,
			},
		];
		mocks.queryResults.push(
			group,
			[],
			[
				{
					status: "completed",
					payload: JSON.stringify({
						serviceId: "service-1",
						serviceRevisionId: "revision-missed-manifest-event",
						buildGroupId: "group-missed-manifest-event",
						finalImageUri: image,
						images: [`${image}-amd64`],
					}),
				},
			],
			group,
		);

		const { result, step } = invoke(
			"revision-missed-manifest-event",
			"group-missed-manifest-event",
		);
		step.waitForEvent.mockResolvedValue(null);
		await expect(result).resolves.toEqual(
			expect.objectContaining({ status: "completed" }),
		);
		expect(mocks.deployServiceRevisionInternal).toHaveBeenCalledWith(
			"service-1",
			"revision-missed-manifest-event",
			image,
		);
	});

	it("rejects a manifest that omits a platform build", async () => {
		const image = "registry/app:revision-incomplete-manifest";
		const group = [
			{
				id: "incomplete-amd64",
				status: "completed",
				targetPlatform: "linux/amd64",
				imageUri: `${image}-amd64`,
			},
			{
				id: "incomplete-arm64",
				status: "completed",
				targetPlatform: "linux/arm64",
				imageUri: `${image}-arm64`,
			},
		];
		mocks.queryResults.push(
			group,
			[
				{
					status: "completed",
					payload: JSON.stringify({
						serviceId: "service-1",
						serviceRevisionId: "revision-incomplete-manifest",
						buildGroupId: "group-incomplete-manifest",
						finalImageUri: image,
						images: [`${image}-amd64`],
					}),
				},
			],
			group,
		);

		await expect(
			invoke("revision-incomplete-manifest", "group-incomplete-manifest")
				.result,
		).rejects.toThrow(
			"Build manifest does not contain the complete platform group",
		);
		expect(mocks.deployServiceRevisionInternal).not.toHaveBeenCalled();
	});
});
