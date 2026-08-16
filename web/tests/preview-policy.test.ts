import { describe, expect, it } from "vitest";
import { previewHostname } from "@/lib/preview-deployments";

describe("preview hostname policy", () => {
	it("generates a stable DNS-safe hostname", () => {
		expect(
			previewHostname({
				serviceName: "Web API 🚀",
				serviceId: "12345678-abcd-4321-abcd-1234567890ab",
				pullRequestNumber: 42,
				domain: "Apps.Example.com.",
			}),
		).toBe("web-api-pr-42-12345678.apps.example.com");
	});

	it("keeps additional public ports unique", () => {
		const input = {
			serviceName: "web",
			serviceId: "12345678-abcd-4321-abcd-1234567890ab",
			pullRequestNumber: 42,
			domain: "apps.example.com",
		};

		expect(previewHostname(input)).toBe("web-pr-42-12345678.apps.example.com");
		expect(previewHostname({ ...input, portIndex: 1 })).toBe(
			"web-pr-42-12345678-p2.apps.example.com",
		);
	});

	it("truncates only the service name to stay within one DNS label", () => {
		const hostname = previewHostname({
			serviceName: "a".repeat(100),
			serviceId: "12345678-abcd-4321-abcd-1234567890ab",
			pullRequestNumber: 123,
			domain: "apps.example.com",
		});

		expect(hostname.split(".")[0]).toHaveLength(63);
		expect(hostname).toMatch(/-pr-123-12345678\.apps\.example\.com$/);
	});

	it("rejects invalid pull request numbers", () => {
		expect(() =>
			previewHostname({
				serviceName: "web",
				serviceId: "12345678-abcd-4321-abcd-1234567890ab",
				pullRequestNumber: 0,
				domain: "apps.example.com",
			}),
		).toThrow("Invalid pull request number");
	});
});
