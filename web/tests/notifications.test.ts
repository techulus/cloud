import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	send: vi.fn(),
	create: vi.fn((data, options) => ({
		name: "notification/requested",
		data,
		...options,
	})),
	deliverEmail: vi.fn(),
	getEmailRecipients: vi.fn(),
}));

vi.mock("@/lib/inngest/client", () => ({
	inngest: {
		send: mocks.send,
		createFunction: vi.fn(
			(_options: unknown, handler: (input: unknown) => unknown) => handler,
		),
	},
}));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: { notificationRequested: { create: mocks.create } },
}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/email", () => ({
	deliverNotificationEmail: mocks.deliverEmail,
	getNotificationEmailRecipients: mocks.getEmailRecipients,
}));

import { notificationDelivery } from "@/lib/inngest/functions/notification-delivery";
import { notify, renderInAppNotification } from "@/lib/notifications";

describe("notification pipeline", () => {
	it("enqueues using the stable occurrence ID", async () => {
		mocks.send.mockResolvedValue({ ids: ["event-1"] });
		const event = {
			kind: "server.offline" as const,
			occurrenceId: "server-offline-server-1-heartbeat",
			serverId: "server-1",
			serverName: "Edge",
		};
		await notify(event);
		expect(mocks.create).toHaveBeenCalledWith(event, {
			id: `notification-${event.kind}-${event.occurrenceId}`,
		});
		expect(mocks.send).toHaveBeenCalledOnce();
	});

	it("renders operational deep links and skips invitations", async () => {
		await expect(
			renderInAppNotification({
				kind: "server.offline",
				occurrenceId: "offline-1",
				serverId: "server-1",
				serverName: "Edge",
			}),
		).resolves.toEqual({
			title: "Server offline: Edge",
			body: "Edge is no longer responding to health checks.",
			href: "/dashboard/servers/server-1",
		});
		await expect(
			renderInAppNotification({
				kind: "member.invited",
				occurrenceId: "invite-1",
				to: "member@example.com",
				inviterName: "Admin",
				role: "reader",
				inviteUrl: "https://example.com/invite/token",
			}),
		).resolves.toBeNull();
	});

	it("runs channels as independent retryable steps", async () => {
		const event = {
			kind: "server.offline" as const,
			occurrenceId: "offline-1",
			serverId: "server-1",
			serverName: "Edge",
		};
		const step = {
			run: vi.fn(async (name: string, operation: () => unknown) =>
				name === "deliver-in-app" ? undefined : operation(),
			),
		};
		mocks.getEmailRecipients.mockResolvedValueOnce(["alerts@example.com"]);
		mocks.deliverEmail.mockRejectedValueOnce(new Error("SMTP unavailable"));
		const handler = notificationDelivery as unknown as (input: {
			event: { data: typeof event };
			step: typeof step;
		}) => Promise<void>;

		await expect(handler({ event: { data: event }, step })).rejects.toThrow(
			"SMTP unavailable",
		);
		expect(step.run.mock.calls.map(([name]) => name)).toEqual([
			"deliver-in-app",
			"resolve-email-recipients",
			expect.stringMatching(/^deliver-email-/),
		]);
		expect(mocks.deliverEmail).toHaveBeenCalledWith(
			event,
			"alerts@example.com",
		);
	});
});
