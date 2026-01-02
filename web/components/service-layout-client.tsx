"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import {
	buildCurrentConfig,
	diffConfigs,
	parseDeployedConfig,
} from "@/lib/service-config";
import { cn } from "@/lib/utils";
import { DeploymentStatusBar } from "./service-details/deployment-status-bar";
import type { ServiceWithDetails as Service } from "@/db/types";
import { createContext, useContext } from "react";
import { Spinner } from "./ui/spinner";

interface ServiceLayoutClientProps {
	serviceId: string;
	projectId: string;
	projectSlug: string;
	children: React.ReactNode;
}

export function ServiceLayoutClient({
	serviceId,
	projectId,
	projectSlug,
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

	const basePath = `/dashboard/projects/${projectSlug}/services/${service?.id}`;

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
			<div className="min-h-screen flex items-center justify-center">
				<Spinner />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<nav className="flex gap-1 border-b -mt-2">
				{tabs.map((tab) => (
					<Link
						key={tab.href}
						href={tab.href}
						className={cn(
							"px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
							isActiveTab(tab.href)
								? "border-primary text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/50",
						)}
					>
						{tab.name}
					</Link>
				))}
			</nav>

			<ServiceContext.Provider
				value={{ service, projectSlug, onUpdate: handleActionComplete }}
			>
				{children}
			</ServiceContext.Provider>

			<DeploymentStatusBar
				changes={pendingChanges}
				service={service}
				projectSlug={projectSlug}
				onUpdate={handleActionComplete}
			/>
		</div>
	);
}

interface ServiceContextType {
	service: Service;
	projectSlug: string;
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
