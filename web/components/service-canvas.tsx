"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";
import {
	Box,
	ChevronDownIcon,
	Globe,
	HardDrive,
	Lock,
	Settings,
} from "lucide-react";
import type { Environment, ServiceWithDetails } from "@/db/types";
import { fetcher } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import { CreateServiceDialog } from "./create-service-dialog";
import { getStatusColorFromDeployments } from "./ui/canvas-wrapper";
import { Button, buttonVariants } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "./ui/empty";

function ServiceCardSkeleton() {
	return (
		<div className="flex flex-col items-center gap-2 w-70">
			<div className="w-full p-3 rounded-xl border-2 border-zinc-200 dark:border-zinc-700 bg-slate-100/50 dark:bg-slate-800/50">
				<div className="flex items-center gap-2">
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-1.5">
							<div className="h-4 w-24 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
							<div className="h-2 w-2 bg-slate-200 dark:bg-slate-700 rounded-full animate-pulse" />
						</div>
					</div>
				</div>
				<div className="mt-2 space-y-1.5">
					<div className="flex items-center gap-1.5">
						<div className="h-3 w-3 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
						<div className="h-3 w-32 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
					</div>
				</div>
				<div className="mt-2">
					<div className="flex items-center justify-between">
						<div className="h-3 w-12 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
						<div className="h-4 w-8 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
					</div>
				</div>
			</div>
		</div>
	);
}

function EnvironmentSelector({
	environments,
	selectedEnvName,
	projectSlug,
}: {
	environments: Environment[];
	selectedEnvName: string;
	projectSlug: string;
}) {
	const router = useRouter();

	return (
		<div className="absolute top-4 left-4 flex items-center gap-2">
			<DropdownMenu>
				<DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
					{selectedEnvName}
					<ChevronDownIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent side="bottom" align="start">
					{environments.map((env) => (
						<DropdownMenuItem
							key={env.id}
							onClick={() =>
								router.push(`/dashboard/projects/${projectSlug}/${env.name}`)
							}
						>
							{env.name}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			<Link
				href={`/dashboard/projects/${projectSlug}/settings`}
				className={cn(
					buttonVariants({ variant: "outline", size: "sm" }),
					"ml-1 gap-2",
				)}
			>
				<Settings className="h-4 w-4" />
				<span>Settings</span>
			</Link>
		</div>
	);
}

function ServiceCard({
	service,
	projectSlug,
	envName,
}: {
	service: ServiceWithDetails;
	projectSlug: string;
	envName: string;
}) {
	const colors = getStatusColorFromDeployments(service.deployments);
	const publicPorts = service.ports.filter((p) => p.isPublic && p.domain);
	const hasInternalDns = service.deployments.some(
		(d) => d.status === "running",
	);
	const runningCount = service.deployments.filter(
		(d) => d.status === "running",
	).length;

	const hasEndpoints = publicPorts.length > 0 || hasInternalDns;

	return (
		<div className="flex flex-col items-center gap-2 w-70">
			<Link
				href={`/dashboard/projects/${projectSlug}/${envName}/services/${service.id}`}
				className={`
          group relative w-full
          p-3 rounded-xl border-2 ${colors.border} ${colors.bg}
          hover:shadow-lg hover:scale-[1.02]
          transition-all duration-200 ease-out
          cursor-pointer
        `}
			>
				<div className="flex items-center gap-2">
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-1.5">
							<h3 className="font-semibold text-sm text-foreground truncate">
								{service.name}
							</h3>
							<span className={`relative flex h-2 w-2`}>
								<span
									className={`animate-ping absolute inline-flex h-full w-full rounded-full ${colors.dot} opacity-75`}
								/>
								<span
									className={`relative inline-flex rounded-full h-2 w-2 ${colors.dot}`}
								/>
							</span>
						</div>
					</div>
				</div>

				{hasEndpoints && (
					<div className="mt-2 space-y-1.5">
						{publicPorts.map((port) => (
							<div key={port.id} className="flex items-center gap-1.5 text-xs">
								<Globe className="h-3 w-3 text-sky-500" />
								<span className="text-sky-600 dark:text-sky-400">
									{port.domain}
								</span>
							</div>
						))}
						{hasInternalDns && (
							<div className="flex items-center gap-1.5 text-xs">
								<Lock className="h-3 w-3 text-zinc-500" />
								<span className="text-zinc-600 dark:text-zinc-400">
									{service.hostname || service.name}.internal
								</span>
							</div>
						)}
					</div>
				)}

				{service.volumes && service.volumes.length > 0 && (
					<div className="mt-2 space-y-1">
						{service.volumes.map((volume) => (
							<div
								key={volume.id}
								className="flex items-center gap-2 text-xs text-muted-foreground"
							>
								<HardDrive className="h-3.5 w-3.5" />
								<span>{volume.name}</span>
							</div>
						))}
					</div>
				)}

				{service.deployments.length > 0 && (
					<div className="mt-2">
						<div className="flex items-center justify-between">
							<span className="text-xs text-muted-foreground">Replicas</span>
							<span className={`text-sm font-medium ${colors.text}`}>
								{runningCount}/{service.deployments.length}
							</span>
						</div>
					</div>
				)}

				{service.deployments.length === 0 && (
					<div className="mt-2">
						<span className="text-xs text-muted-foreground">Not deployed</span>
					</div>
				)}
			</Link>
		</div>
	);
}

export function ServiceCanvas({
	projectId,
	projectSlug,
	envId,
	envName,
}: {
	projectId: string;
	projectSlug: string;
	envId: string;
	envName: string;
}) {
	const { data: environments } = useSWR<Environment[]>(
		`/api/projects/${projectId}/environments`,
		fetcher,
	);

	const {
		data: services,
		mutate,
		isLoading,
	} = useSWR<ServiceWithDetails[]>(
		`/api/projects/${projectId}/services?environmentId=${envId}`,
		fetcher,
		{
			refreshInterval: 5000,
			revalidateOnFocus: true,
		},
	);

	if (!environments || isLoading) {
		return (
			<div
				className="
          relative -mt-6 -mb-6 p-10
          left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen
          bg-slate-50/50 dark:bg-slate-900/30
          flex items-center justify-center
        "
				style={{
					height: "calc(100vh - 3.5rem)",
					backgroundImage: `radial-gradient(circle, rgb(161 161 170 / 0.2) 1px, transparent 1px)`,
					backgroundSize: "24px 24px",
				}}
			>
				<div className="flex flex-wrap gap-10 justify-center items-center">
					<ServiceCardSkeleton />
					<ServiceCardSkeleton />
				</div>
			</div>
		);
	}

	if (!services || services.length === 0) {
		return (
			<div
				className="
          relative -mt-6 -mb-6
          left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen
          bg-slate-50 dark:bg-slate-900/50
          flex items-center justify-center
        "
				style={{
					height: "calc(100vh - 5rem)",
					backgroundImage: `radial-gradient(circle, rgb(161 161 170 / 0.3) 1px, transparent 1px)`,
					backgroundSize: "20px 20px",
				}}
			>
				<EnvironmentSelector
					environments={environments}
					selectedEnvName={envName}
					projectSlug={projectSlug}
				/>
				<Empty>
					<EmptyMedia variant="icon">
						<Box className="size-5" />
					</EmptyMedia>
					<EmptyTitle>No services yet</EmptyTitle>
					<EmptyDescription>Add your first service to deploy.</EmptyDescription>
					<EmptyContent>
						<CreateServiceDialog
							projectId={projectId}
							environmentId={envId}
							onSuccess={() => mutate()}
						/>
					</EmptyContent>
				</Empty>
			</div>
		);
	}

	return (
		<div
			className="
        relative -mt-6 -mb-6 p-10
        left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen
        bg-slate-50/50 dark:bg-slate-900/30
        flex items-center justify-center overflow-auto
      "
			style={{
				height: "calc(100vh - 3.5rem)",
				backgroundImage: `radial-gradient(circle, rgb(161 161 170 / 0.2) 1px, transparent 1px)`,
				backgroundSize: "24px 24px",
			}}
		>
			<EnvironmentSelector
				environments={environments}
				selectedEnvName={envName}
				projectSlug={projectSlug}
			/>
			<div className="absolute top-4 right-4">
				<CreateServiceDialog
					projectId={projectId}
					environmentId={envId}
					onSuccess={() => mutate()}
				/>
			</div>
			<div className="flex flex-wrap gap-10 justify-center items-center">
				{services.map((service) => (
					<ServiceCard
						key={service.id}
						service={service}
						projectSlug={projectSlug}
						envName={envName}
					/>
				))}
			</div>
		</div>
	);
}
