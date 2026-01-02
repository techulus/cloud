"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo } from "react";
import useSWR, { useSWRConfig } from "swr";
import { deleteService } from "@/actions/projects";
import { fetcher } from "@/lib/fetcher";
import {
	buildCurrentConfig,
	diffConfigs,
	parseDeployedConfig,
} from "@/lib/service-config";
import { cn } from "@/lib/utils";
import { PendingChangesBar } from "./service-details/pending-changes";
import { RolloutStatusBar } from "./service-details/rollout-status";
import type { Service } from "./service-details/types";

export { type Service } from "./service-details/types";

interface ServiceLayoutClientProps {
	projectSlug: string;
	initialService: Service;
	children: React.ReactNode;
}

export function ServiceLayoutClient({
	projectSlug,
	initialService,
	children,
}: ServiceLayoutClientProps) {
	const router = useRouter();
	const pathname = usePathname();
	const { mutate: globalMutate } = useSWRConfig();

	const { data: services, mutate } = useSWR<Service[]>(
		`/api/projects/${initialService.projectId}/services`,
		fetcher,
		{
			fallbackData: [initialService],
			refreshInterval: 5000,
			revalidateOnFocus: true,
		},
	);

	const service =
		services?.find((s) => s.id === initialService.id) || initialService;

	const pendingChanges = useMemo(() => {
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

	const handleActionComplete = () => {
		mutate();
	};

	const basePath = `/dashboard/projects/${projectSlug}/services/${service.id}`;

	const tabs = [
		{ name: "Architecture", href: basePath },
		{ name: "Configuration", href: `${basePath}/configuration` },
		...(service.sourceType === "github"
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

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-lg font-semibold">{service.name}</h1>
			</div>
			<nav className="flex gap-1 border-b -mt-2">
				{tabs.map((tab) => (
					<Link
						key={tab.href}
						href={tab.href}
						className={cn(
							"px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
							isActiveTab(tab.href)
								? "border-primary text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/50"
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

			<PendingChangesBar
				changes={pendingChanges}
				service={service}
				projectSlug={projectSlug}
				onUpdate={handleActionComplete}
			/>

			<RolloutStatusBar service={service} onUpdate={handleActionComplete} />
		</div>
	);
}

import { createContext, useContext } from "react";

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
