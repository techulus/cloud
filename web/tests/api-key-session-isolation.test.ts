import { describe, expect, it } from "vitest";
import { auth } from "@/lib/auth";

describe("API key session isolation", () => {
	it("does not turn X-API-Key into a dashboard session", async () => {
		const session = await auth.api.getSession({
			headers: new Headers({
				"x-api-key": `tcl_${"x".repeat(64)}`,
			}),
		});

		expect(session).toBeNull();
	});
});
