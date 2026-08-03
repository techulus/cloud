import { describe, expect, it } from "vitest";
import { buildNavigationItems } from "@/lib/navigation";

describe("dashboard navigation catalog", () => {
	it("builds every stable child page with searchable context", () => {
		const items = buildNavigationItems(
			[
				{
					projectId: "project-1",
					projectName: "Acme",
					projectSlug: "acme",
					environmentId: "environment-1",
					environmentName: "production",
					serviceId: "service-1",
					serviceName: "API",
					serviceHostname: "api-production",
				},
			],
			[{ id: "server-1", name: "edge-01" }],
		);

		expect(items).toHaveLength(19);
		expect(items.map((item) => item.href)).toEqual(
			expect.arrayContaining([
				"/dashboard",
				"/dashboard/notifications",
				"/dashboard/settings",
				"/dashboard/projects/acme/settings",
				"/dashboard/projects/acme/production",
				"/dashboard/projects/acme/production/deleted",
				"/dashboard/projects/acme/production/import-compose",
				"/dashboard/projects/acme/production/services/service-1",
				"/dashboard/projects/acme/production/services/service-1/configuration",
				"/dashboard/projects/acme/production/services/service-1/metrics",
				"/dashboard/projects/acme/production/services/service-1/logs",
				"/dashboard/projects/acme/production/services/service-1/requests",
				"/dashboard/projects/acme/production/services/service-1/builds",
				"/dashboard/projects/acme/production/services/service-1/backups",
				"/dashboard/projects/acme/production/services/service-1/changelog",
				"/dashboard/servers/server-1",
				"/dashboard/servers/server-1/metrics",
				"/dashboard/servers/server-1/logs",
				"/dashboard/servers/server-1/settings",
			]),
		);
		expect(
			items.find((item) => item.id === "page:notifications"),
		).toMatchObject({
			label: "Notifications",
			keywords: ["alert", "inbox", "activity"],
		});

		const serviceLogs = items.find(
			(item) => item.id === "service:service-1:logs",
		);
		expect(serviceLogs).toMatchObject({
			label: "API — Logs",
			description: "Acme / production",
			keywords: expect.arrayContaining([
				"API",
				"api-production",
				"Acme",
				"production",
			]),
		});
	});

	it("deduplicates entities repeated by joined query rows", () => {
		const row = {
			projectId: "project-1",
			projectName: "Acme",
			projectSlug: "acme",
			environmentId: "environment-1",
			environmentName: "production",
			serviceId: "service-1",
			serviceName: "API",
			serviceHostname: null,
		};

		const items = buildNavigationItems([row, row], []);
		expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
	});
});
