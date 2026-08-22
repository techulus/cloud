import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	reportServerError: vi.fn(),
}));

vi.mock("@/lib/inngest/client", () => ({
	inngest: {
		createFunction: vi.fn(
			(_options: unknown, handler: (input: unknown) => unknown) => handler,
		),
	},
}));
vi.mock("@/lib/server-errors", () => ({
	reportServerError: mocks.reportServerError,
}));

import { sentryFailureWorkflow } from "@/lib/inngest/functions/sentry-failure-workflow";

type FailureEvent = {
	data: {
		error: { message: string; name: string; stack: string };
		function_id: string;
		run_id: string;
	};
};

function invoke(event: FailureEvent) {
	return (
		sentryFailureWorkflow as unknown as (input: {
			event: FailureEvent;
		}) => Promise<void>
	)({ event });
}

describe("Sentry Inngest failure workflow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("ignores failures from itself", async () => {
		await invoke({
			data: {
				error: { message: "report failed", name: "Error", stack: "stack" },
				function_id: "techulus-cloud-sentry-function-failure",
				run_id: "run-self",
			},
		});

		expect(mocks.reportServerError).not.toHaveBeenCalled();
	});

	it("reports another function after retries are exhausted", async () => {
		await invoke({
			data: {
				error: { message: "build failed", name: "BuildError", stack: "stack" },
				function_id: "techulus-cloud-build-workflow",
				run_id: "run-build",
			},
		});

		expect(mocks.reportServerError).toHaveBeenCalledOnce();
		expect(mocks.reportServerError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "build failed",
				name: "BuildError",
				stack: "stack",
			}),
			"inngest.function.failed",
			{
				tags: { functionId: "techulus-cloud-build-workflow" },
				extra: { runId: "run-build" },
			},
		);
	});
});
