import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { redactSentryEvent } from "@/lib/sentry";

describe("Sentry event redaction", () => {
	it("redacts credentials and sensitive assignments from error text", () => {
		const event = redactSentryEvent({
			type: undefined,
			exception: {
				values: [
					{
						value:
							"DATABASE_URL=postgres://admin:secret@db.example.com/cloud Bearer abc.def",
					},
				],
			},
		} as ErrorEvent);

		const value = event.exception?.values?.[0]?.value;
		expect(value).not.toContain("secret");
		expect(value).not.toContain("abc.def");
		expect(value).toContain("DATABASE_URL=[REDACTED]");
		expect(value).toContain("Bearer [REDACTED]");
	});

	it("redacts sensitive structured fields and stack source context", () => {
		const event = redactSentryEvent({
			type: undefined,
			extra: {
				registryPassword: "hunter2",
				safeValue: "visible",
			},
			exception: {
				values: [
					{
						stacktrace: {
							frames: [
								{
									context_line:
										'connect("postgres://user:password@db.example.com/cloud")',
								},
							],
						},
					},
				],
			},
		} as ErrorEvent);

		expect(event.extra).toMatchObject({
			registryPassword: "[REDACTED]",
			safeValue: "visible",
		});
		expect(
			event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.context_line,
		).toContain("postgres://[REDACTED]:[REDACTED]@db.example.com/cloud");
	});

	it("does not traverse internal SDK metadata", () => {
		const metadata: Record<string, unknown> = {};
		metadata.self = metadata;

		const event = redactSentryEvent({
			type: undefined,
			sdkProcessingMetadata: metadata,
		} as ErrorEvent);

		expect(event.sdkProcessingMetadata).toBe(metadata);
	});
});
