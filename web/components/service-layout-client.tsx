"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useMemo } from "react";
import useSWR from "swr";
import type { ServiceWithDetails as Service } from "@/db/types";
import { fetcher } from "@/lib/fetcher";
import {
	buildCurrentConfig,
	diffConfigs,
	parseDeployedConfig,
} from "@/lib/service-config";
import { cn } from "@/lib/utils";
import { DeploymentStatusBar } from "./service-details/deployment-status-bar";

interface ServiceLayoutClientProps {
	serviceId: string;
	projectId: string;
	projectSlug: string;
	envName: string;
	children: React.ReactNode;
}

export function ServiceLayoutClient({
	serviceId,
	projectId,
	projectSlug,
	envName,
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
		pathname.includes("/configuration") || pathname.includes("/builds");

	const tabs = [
		{ name: "Architecture", href: basePath },
		{ name: "Configuration", href: `${basePath}/configuration` },
		...(service?.sourceType === "github"
			? [{ name: "Builds", href: `${basePath}/builds` }]
			: []),
		{ name: "Logs", href: `${basePath}/logs` },
		{ name: "Requests", href: `${basePath}/requests` },
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
				<nav className="flex gap-1 border-b px-4 pt-1.5">
					{[1, 2, 3, 4].map((i) => (
						<div
							key={i}
							className="h-8 w-24 bg-zinc-200 dark:bg-zinc-700 rounded animate-pulse mb-1.5"
						/>
					))}
				</nav>
				<div className="container max-w-7xl mx-auto px-4 py-6">
					<div className="space-y-6">
						<div className="h-6 w-48 bg-zinc-200 dark:bg-zinc-700 rounded animate-pulse" />
						<div className="grid gap-4">
							<div className="h-32 bg-zinc-200 dark:bg-zinc-700 rounded-lg animate-pulse" />
							<div className="h-32 bg-zinc-200 dark:bg-zinc-700 rounded-lg animate-pulse" />
						</div>
					</div>
				</div>
			</>
		);
	}

	return (
		<>
			<nav className="flex gap-1 border-b overflow-x-auto overflow-y-hidden scrollbar-none px-4 py-1.5">
				{tabs.map((tab) => (
					<Link
						key={tab.href}
						href={tab.href}
						className={cn(
							"px-3 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0",
							isActiveTab(tab.href)
								? "bg-accent text-foreground"
								: "text-muted-foreground hover:text-foreground hover:bg-accent/50",
						)}
					>
						{tab.name}
					</Link>
				))}
			</nav>

			<div
				className={cn(
					"px-4 py-6",
					isConstrainedTab && "container max-w-7xl mx-auto",
				)}
			>
				<ServiceContext.Provider
					value={{
						service,
						projectSlug,
						envName,
						onUpdate: handleActionComplete,
					}}
				>
					{children}
				</ServiceContext.Provider>
			</div>

			<DeploymentStatusBar
				changes={pendingChanges}
				service={service}
				projectSlug={projectSlug}
				envName={envName}
				onUpdate={handleActionComplete}
			/>
		</>
	);
}

interface ServiceContextType {
	service: Service;
	projectSlug: string;
	envName: string;
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
