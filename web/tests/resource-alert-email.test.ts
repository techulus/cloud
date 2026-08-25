import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sendMail: vi.fn(),
	close: vi.fn(),
}));

vi.mock("nodemailer", () => ({
	default: {
		createTransport: vi.fn(() => ({
			sendMail: mocks.sendMail,
			close: mocks.close,
		})),
	},
}));

vi.mock("@/db/queries", () => ({
	getSmtpConfig: vi.fn(() => ({
		enabled: true,
		fromName: "Techulus Cloud",
		fromAddress: "cloud@example.com",
		host: "smtp.example.com",
		port: 587,
		username: "",
		password: "",
		encryption: "starttls",
		timeout: 10_000,
		alertEmails: "alerts@example.com",
	})),
}));

vi.mock("@/lib/notifications", () => ({
	notificationEventIsEnabled: vi.fn(() => true),
}));

import { deliverNotificationEmail } from "@/lib/email";

describe("resource alert email", () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllEnvs();
	});

	it("includes the threshold and server link", async () => {
		vi.stubEnv("APP_URL", "https://cloud.example.com");

		await deliverNotificationEmail(
			{
				kind: "server.resource_usage",
				occurrenceId: "resource-1",
				serverId: "server-1",
				serverName: "Edge",
				resource: "cpu",
				usagePercent: 94.25,
				thresholdPercent: 90,
				detectedAt: "2026-08-25T10:00:00.000Z",
			},
			"alerts@example.com",
		);

		expect(mocks.sendMail).toHaveBeenCalledOnce();
		const message = mocks.sendMail.mock.calls[0]?.[0];
		expect(message).toMatchObject({
			to: "alerts@example.com",
			subject: 'Alert: High CPU usage on "Edge"',
		});
		expect(message?.html).toContain("94.3%");
		expect(message?.html).toContain("90%");
		expect(message?.html).toContain(
			"https://cloud.example.com/dashboard/servers/server-1",
		);
	});
});
