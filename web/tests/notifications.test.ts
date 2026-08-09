import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const deleteWhere = vi.fn((_condition: SQL) =>
		Promise.resolve({ rowCount: 0 }),
	);
	return {
		send: vi.fn(),
		create: vi.fn((data, options) => ({
			name: "notification/requested",
			data,
			...options,
		})),
		deliverEmail: vi.fn(),
		getEmailRecipients: vi.fn(),
		getAlertsConfig: vi.fn(),
		select: vi.fn(),
		delete: vi.fn(() => ({ where: deleteWhere })),
		deleteWhere,
	};
});

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
vi.mock("@/db", () => ({
	db: { select: mocks.select, delete: mocks.delete },
}));
vi.mock("@/db/queries", () => ({
	getEmailAlertsConfig: mocks.getAlertsConfig,
}));
vi.mock("@/lib/email", () => ({
	deliverNotificationEmail: mocks.deliverEmail,
	getNotificationEmailRecipients: mocks.getEmailRecipients,
}));

import { notificationDelivery } from "@/lib/inngest/functions/notification-delivery";
import {
	cleanupReadNotifications,
	deliverInAppNotification,
	notificationEventIsEnabled,
	notify,
	renderInAppNotification,
} from "@/lib/notifications";

describe("notification pipeline", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.deleteWhere.mockResolvedValue({ rowCount: 0 });
	});

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

	it("renders cron failures with the service deep link", async () => {
		mocks.select.mockReturnValueOnce({
			from: vi.fn(() => ({
				innerJoin: vi.fn(() => ({
					innerJoin: vi.fn(() => ({
						where: vi.fn(() =>
							Promise.resolve([
								{
									serviceName: "API",
									projectName: "Cloud",
									projectSlug: "cloud",
									environmentName: "production",
								},
							]),
						),
					})),
				})),
			})),
		});

		await expect(
			renderInAppNotification({
				kind: "cron.failed",
				occurrenceId: "cron-1",
				serviceId: "service-1",
				path: "/jobs/nightly",
				statusCode: 500,
				error: "HTTP status 500",
			}),
		).resolves.toEqual({
			title: "Cron failed: API",
			body: "/jobs/nightly: HTTP status 500",
			href: "/dashboard/projects/cloud/production/services/service-1",
		});
	});

	it("maps every operational event to its alert toggle", async () => {
		mocks.getAlertsConfig.mockResolvedValue({
			serverOfflineAlert: false,
			buildFailure: false,
			deploymentFailure: false,
			deploymentMovedAlert: false,
			cronFailure: false,
		});

		await expect(
			notificationEventIsEnabled({
				kind: "server.offline",
				occurrenceId: "offline-1",
				serverId: "server-1",
				serverName: "Edge",
			}),
		).resolves.toBe(false);
		await expect(
			notificationEventIsEnabled({
				kind: "manual_recovery.required",
				occurrenceId: "recovery-1",
				serverId: "server-1",
				serverName: "Edge",
				impactedReplicas: 1,
				serviceNames: ["API"],
			}),
		).resolves.toBe(false);
		await expect(
			notificationEventIsEnabled({
				kind: "build.failed",
				occurrenceId: "build-1",
				serviceId: "service-1",
				buildId: "build-1",
			}),
		).resolves.toBe(false);
		await expect(
			notificationEventIsEnabled({
				kind: "deployment.failed",
				occurrenceId: "deployment-1",
				serviceId: "service-1",
				serverId: "server-1",
			}),
		).resolves.toBe(false);
		await expect(
			notificationEventIsEnabled({
				kind: "cron.failed",
				occurrenceId: "cron-1",
				serviceId: "service-1",
				path: "/jobs/nightly",
				statusCode: 500,
				error: "HTTP status 500",
			}),
		).resolves.toBe(false);
	});

	it("defaults missing alert settings to enabled", async () => {
		mocks.getAlertsConfig.mockResolvedValue(null);

		await expect(
			notificationEventIsEnabled({
				kind: "cron.failed",
				occurrenceId: "cron-1",
				serviceId: "service-1",
				path: "/jobs/nightly",
				statusCode: null,
				error: "Cron request failed",
			}),
		).resolves.toBe(true);
	});

	it("skips in-app delivery when the event category is disabled", async () => {
		mocks.getAlertsConfig.mockResolvedValue({
			serverOfflineAlert: false,
			buildFailure: true,
			deploymentFailure: true,
			deploymentMovedAlert: true,
			cronFailure: true,
		});

		await deliverInAppNotification({
			kind: "server.offline",
			occurrenceId: "offline-1",
			serverId: "server-1",
			serverName: "Edge",
		});

		expect(mocks.select).not.toHaveBeenCalled();
	});

	it("deletes only notifications read more than 30 days ago", async () => {
		mocks.deleteWhere.mockResolvedValue({ rowCount: 2 });
		const now = new Date("2026-08-03T12:00:00.000Z");

		await expect(cleanupReadNotifications(now)).resolves.toBe(2);

		expect(mocks.delete).toHaveBeenCalledOnce();
		const condition = mocks.deleteWhere.mock.calls[0]?.[0] as SQL | undefined;
		if (!condition)
			throw new Error("notification cleanup condition is missing");
		const query = new PgDialect().sqlToQuery(condition);
		expect(query.sql).toContain('"notifications"."read_at" is not null');
		expect(query.sql).toContain('"notifications"."read_at" < $1');
		expect(query.params).toEqual(["2026-07-04T12:00:00.000Z"]);
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
