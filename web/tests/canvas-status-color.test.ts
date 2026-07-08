import { describe, expect, it } from "vitest";
import {
	getStatusColor,
	getStatusColorFromDeployments,
} from "@/components/ui/canvas-wrapper";

describe("canvas status colors", () => {
	it("uses a distinct color for sleeping deployments", () => {
		expect(getStatusColorFromDeployments([{ observedPhase: "sleeping" }])).toEqual(
			getStatusColor("sleeping"),
		);
		expect(getStatusColorFromDeployments([{ observedPhase: "sleeping" }])).not.toEqual(
			getStatusColor("stopped"),
		);
	});

	it("keeps active and failed states higher priority than sleeping", () => {
		expect(
			getStatusColorFromDeployments([
				{ observedPhase: "sleeping" },
				{ observedPhase: "healthy" },
			]),
		).toEqual(getStatusColor("running"));
		expect(
			getStatusColorFromDeployments([
				{ observedPhase: "sleeping" },
				{ observedPhase: "failed" },
			]),
		).toEqual(getStatusColor("failed"));
	});
});
