"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useMemo } from "react";
import useSWR from "swr";
import type { ServiceWithDetails as Service } from "@/db/types";
import type { ConfigChange } from "@/lib/service-config";
import { fetcher } from "@/lib/fetcher";
import {
	buildCurrentConfig,
	diffConfigs,
	parseDeployedConfig,
} from "@/lib/service-config";
import { cn } from "@/lib/utils";

interface ServiceLayoutClientProps {
	serviceId: string;
	projectId: string;
	projectSlug: string;
	envName: string;
	proxyDomain: string | null;
	children: React.ReactNode;
}

export function ServiceLayoutClient({
	serviceId,
	projectId,
	projectSlug,
	envName,
	proxyDomain,
	children,
}: ServiceLayoutClientProps) {
	const pathname = usePathname();

	const {
		data: services,
		mutate,
		isLoading,
	} = useSWR<Service[]>(`/api/projects/${projectId}/services`, fetcher, {
		refreshInterval: 5000,
		revalidateOnFocus: true,
	});

	const service = services?.find((s) => s.id === serviceId);

	const pendingChanges = useMemo(() => {
		if (!service) return [];

		const deployed = parseDeployedConfig(service.deployedConfig);
		const replicas = (service.configuredReplicas || []).map((r) => ({
			serverId: r.serverId,
			serverName: r.serverName,
			count: r.count,
		}));
		const ports = (service.ports || []).map((p) => ({
			port: p.port,
			isPublic: p.isPublic,
			domain: p.domain,
		}));
		const current = buildCurrentConfig(
			service,
			replicas,
			ports,
			service.secrets,
			service.volumes,
		);
		return diffConfigs(deployed, current);
	}, [service]);

	const handleActionComplete = useCallback(() => {
		mutate();
	}, [mutate]);

	const basePath = `/dashboard/projects/${projectSlug}/${envName}/services/${service?.id}`;

	const isConstrainedTab =
		pathname.includes("/configuration") ||
		pathname.includes("/builds") ||
		pathname.includes("/backups");

	const hasPublicPorts = service?.ports?.some((p) => p.isPublic);

	const tabs = [
		{ name: "Deployments", href: basePath },
		{ name: "Configuration", href: `${basePath}/configuration` },
		{ name: "Logs", href: `${basePath}/logs` },
		...(hasPublicPorts
			? [{ name: "Requests", href: `${basePath}/requests` }]
			: []),
		...(service?.sourceType === "github"
			? [{ name: "Builds", href: `${basePath}/builds` }]
			: []),
		...(service?.stateful
			? [{ name: "Backups", href: `${basePath}/backups` }]
			: []),
	];

	const isActiveTab = (href: string) => {
		if (href === basePath) {
			return pathname === basePath;
		}
		return pathname.startsWith(href);
	};

	if (isLoading || !service) {
		return (
			<>
				<div className="px-4 py-3 overflow-x-auto">
					<nav className="inline-flex items-center gap-1 rounded-lg bg-muted p-[3px] w-max">
						{[1, 2, 3, 4].map((i) => (
							<div
								key={i}
								className="h-7 w-24 bg-background/50 rounded-md animate-pulse"
							/>
						))}
					</nav>
				</div>
				<div className="container max-w-7xl mx-auto px-4 py-2">
					<div className="space-y-6">
						<div className="h-6 w-48 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
						<div className="grid gap-4">
							<div className="h-32 bg-slate-200 dark:bg-slate-700 rounded-lg animate-pulse" />
							<div className="h-32 bg-slate-200 dark:bg-slate-700 rounded-lg animate-pulse" />
						</div>
					</div>
				</div>
			</>
		);
	}

	return (
		<>
			<div className="px-4 py-3 overflow-x-auto">
				<nav className="inline-flex items-center rounded-lg bg-muted p-[3px] w-max">
					{tabs.map((tab) => (
						<Link
							key={tab.href}
							href={tab.href}
							className={cn(
								"px-3 py-1.5 text-sm font-medium rounded-md transition-all whitespace-nowrap shrink-0 border border-transparent",
								isActiveTab(tab.href)
									? "bg-background text-foreground shadow-sm dark:bg-input/30 dark:border-input"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{tab.name}
						</Link>
					))}
				</nav>
			</div>

			<div
				className={cn(
					"px-4 py-2",
					isConstrainedTab && "container max-w-7xl mx-auto",
				)}
			>
				<ServiceContext.Provider
					value={{
						service,
						pendingChanges,
						projectSlug,
						envName,
						proxyDomain,
						onUpdate: handleActionComplete,
					}}
				>
					{children}
				</ServiceContext.Provider>
			</div>
		</>
	);
}

interface ServiceContextType {
	service: Service;
	pendingChanges: ConfigChange[];
	projectSlug: string;
	envName: string;
	proxyDomain: string | null;
	onUpdate: () => void;
}

const ServiceContext = createContext<ServiceContextType | null>(null);

export function useService() {
	const context = useContext(ServiceContext);
	if (!context) {
		throw new Error("useService must be used within ServiceLayoutClient");
	}
	return context;
}
