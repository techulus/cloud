export type NavigationItemKind =
	| "page"
	| "project"
	| "environment"
	| "service"
	| "server";

export type NavigationGroup = "Pages" | "Projects" | "Services" | "Servers";

export interface NavigationItem {
	id: string;
	kind: NavigationItemKind;
	group: NavigationGroup;
	label: string;
	description?: string;
	href: string;
	keywords: string[];
}

export interface NavigationResponse {
	items: NavigationItem[];
}

export interface NavigationEntityRow {
	projectId: string;
	projectName: string;
	projectSlug: string;
	environmentId: string | null;
	environmentName: string | null;
	serviceId: string | null;
	serviceName: string | null;
	serviceHostname: string | null;
}

export interface NavigationServerRow {
	id: string;
	name: string;
}

const pageItems: NavigationItem[] = [
	{
		id: "page:dashboard",
		kind: "page",
		group: "Pages",
		label: "Dashboard",
		href: "/dashboard",
		keywords: ["home", "projects", "servers"],
	},
	{
		id: "page:settings",
		kind: "page",
		group: "Pages",
		label: "Settings",
		href: "/dashboard/settings",
		keywords: ["global", "configuration", "members"],
	},
];

const environmentPages = [
	{ key: "overview", label: "Overview", suffix: "", aliases: ["canvas"] },
	{
		key: "deleted",
		label: "Deleted services",
		suffix: "/deleted",
		aliases: ["trash", "restore"],
	},
	{
		key: "import-compose",
		label: "Import Compose",
		suffix: "/import-compose",
		aliases: ["docker compose", "create services"],
	},
] as const;

const servicePages = [
	{
		key: "deployments",
		label: "Deployments",
		suffix: "",
		aliases: ["deploy", "rollouts"],
	},
	{
		key: "configuration",
		label: "Configuration",
		suffix: "/configuration",
		aliases: ["config", "settings"],
	},
	{ key: "metrics", label: "Metrics", suffix: "/metrics", aliases: ["usage"] },
	{ key: "logs", label: "Logs", suffix: "/logs", aliases: ["output"] },
	{
		key: "requests",
		label: "Requests",
		suffix: "/requests",
		aliases: ["http", "traffic"],
	},
	{ key: "builds", label: "Builds", suffix: "/builds", aliases: ["ci"] },
	{
		key: "backups",
		label: "Backups",
		suffix: "/backups",
		aliases: ["restore"],
	},
	{
		key: "changes",
		label: "Changes",
		suffix: "/changelog",
		aliases: ["changelog", "history"],
	},
] as const;

const serverPages = [
	{ key: "overview", label: "Overview", suffix: "", aliases: ["details"] },
	{ key: "metrics", label: "Metrics", suffix: "/metrics", aliases: ["usage"] },
	{ key: "logs", label: "Logs", suffix: "/logs", aliases: ["output"] },
	{
		key: "settings",
		label: "Settings",
		suffix: "/settings",
		aliases: ["configuration", "config"],
	},
] as const;

export function buildNavigationItems(
	entityRows: NavigationEntityRow[],
	serverRows: NavigationServerRow[],
): NavigationItem[] {
	const items = [...pageItems];
	const projects = new Map<string, NavigationEntityRow>();
	const environments = new Map<string, NavigationEntityRow>();
	const services = new Map<string, NavigationEntityRow>();

	for (const row of entityRows) {
		projects.set(row.projectId, row);
		if (row.environmentId && row.environmentName) {
			environments.set(row.environmentId, row);
		}
		if (row.serviceId && row.serviceName) {
			services.set(row.serviceId, row);
		}
	}

	for (const project of [...projects.values()].sort((a, b) =>
		a.projectName.localeCompare(b.projectName),
	)) {
		items.push({
			id: `project:${project.projectId}:settings`,
			kind: "project",
			group: "Projects",
			label: `${project.projectName} — Settings`,
			description: "Project",
			href: `/dashboard/projects/${project.projectSlug}/settings`,
			keywords: [
				project.projectName,
				project.projectSlug,
				"project",
				"configuration",
			],
		});
	}

	for (const environment of [...environments.values()].sort((a, b) =>
		`${a.projectName}/${a.environmentName}`.localeCompare(
			`${b.projectName}/${b.environmentName}`,
		),
	)) {
		const basePath = `/dashboard/projects/${environment.projectSlug}/${environment.environmentName}`;
		for (const page of environmentPages) {
			items.push({
				id: `environment:${environment.environmentId}:${page.key}`,
				kind: "environment",
				group: "Projects",
				label: `${environment.projectName} / ${environment.environmentName} — ${page.label}`,
				description: "Environment",
				href: `${basePath}${page.suffix}`,
				keywords: [
					environment.projectName,
					environment.projectSlug,
					environment.environmentName as string,
					"environment",
					...page.aliases,
				],
			});
		}
	}

	for (const service of [...services.values()].sort((a, b) =>
		`${a.projectName}/${a.environmentName}/${a.serviceName}`.localeCompare(
			`${b.projectName}/${b.environmentName}/${b.serviceName}`,
		),
	)) {
		const basePath = `/dashboard/projects/${service.projectSlug}/${service.environmentName}/services/${service.serviceId}`;
		for (const page of servicePages) {
			items.push({
				id: `service:${service.serviceId}:${page.key}`,
				kind: "service",
				group: "Services",
				label: `${service.serviceName} — ${page.label}`,
				description: `${service.projectName} / ${service.environmentName}`,
				href: `${basePath}${page.suffix}`,
				keywords: [
					service.serviceName as string,
					service.serviceHostname ?? "",
					service.projectName,
					service.projectSlug,
					service.environmentName as string,
					"service",
					...page.aliases,
				],
			});
		}
	}

	for (const server of [...serverRows].sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const basePath = `/dashboard/servers/${server.id}`;
		for (const page of serverPages) {
			items.push({
				id: `server:${server.id}:${page.key}`,
				kind: "server",
				group: "Servers",
				label: `${server.name} — ${page.label}`,
				description: "Server",
				href: `${basePath}${page.suffix}`,
				keywords: [server.name, "server", ...page.aliases],
			});
		}
	}

	return items;
}
