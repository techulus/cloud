"use client";

import {
	ArrowLeftRight,
	Box,
	Github,
	Globe,
	HardDrive,
	Lock,
	Network,
	Settings,
	Trash2,
	Upload,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AnchorHTMLAttributes, MouseEvent, PointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { buttonVariants } from "@/components/ui/button";
import { getStatusColorFromDeployments } from "@/components/ui/canvas-wrapper";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import type { Environment, ServiceWithDetails } from "@/db/types";
import { fetcher } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import {
	AddServiceMenu,
	CreateDockerServiceDialog,
	CreateGitHubServiceDialog,
} from "./create-service-dialog";

type CanvasPosition = {
	canvasX: number;
	canvasY: number;
};

const SERVICE_CARD_WIDTH = 320;
const SERVICE_CARD_HEIGHT = 150;
const SERVICE_CARD_GAP_X = 56;
const SERVICE_CARD_GAP_Y = 48;
const DEFAULT_GRID_COLUMNS = 3;
const DEFAULT_GRID_ROWS = 3;
const CANVAS_WIDTH = 1320;
const CANVAS_HEIGHT = 900;
const MIN_CANVAS_SCALE = 0.5;
const SNAP_GRID_SIZE = 24;
const CANVAS_DOT_PATTERN =
	"radial-gradient(circle, color-mix(in oklab, var(--muted-foreground) 36%, transparent) 1px, transparent 1px)";

function getCanvasScale() {
	if (typeof window === "undefined") {
		return 1;
	}

	const availableWidth = window.innerWidth - 96;
	const availableHeight = window.innerHeight - 112;

	return Math.max(
		MIN_CANVAS_SCALE,
		Math.min(1, availableWidth / CANVAS_WIDTH, availableHeight / CANVAS_HEIGHT),
	);
}

function getDefaultServicePosition(index: number): CanvasPosition {
	const gridWidth =
		DEFAULT_GRID_COLUMNS * SERVICE_CARD_WIDTH +
		(DEFAULT_GRID_COLUMNS - 1) * SERVICE_CARD_GAP_X;
	const gridHeight =
		DEFAULT_GRID_ROWS * SERVICE_CARD_HEIGHT +
		(DEFAULT_GRID_ROWS - 1) * SERVICE_CARD_GAP_Y;
	const gridStartX = (CANVAS_WIDTH - gridWidth) / 2;
	const gridStartY = (CANVAS_HEIGHT - gridHeight) / 2;
	const column = index % DEFAULT_GRID_COLUMNS;
	const row = Math.floor(index / DEFAULT_GRID_COLUMNS);

	return {
		canvasX: gridStartX + column * (SERVICE_CARD_WIDTH + SERVICE_CARD_GAP_X),
		canvasY: gridStartY + row * (SERVICE_CARD_HEIGHT + SERVICE_CARD_GAP_Y),
	};
}

function clampPosition(position: CanvasPosition): CanvasPosition {
	return {
		canvasX: Math.max(
			0,
			Math.min(CANVAS_WIDTH - SERVICE_CARD_WIDTH, Math.round(position.canvasX)),
		),
		canvasY: Math.max(
			0,
			Math.min(
				CANVAS_HEIGHT - SERVICE_CARD_HEIGHT,
				Math.round(position.canvasY),
			),
		),
	};
}

function snapPosition(position: CanvasPosition): CanvasPosition {
	return clampPosition({
		canvasX: Math.round(position.canvasX / SNAP_GRID_SIZE) * SNAP_GRID_SIZE,
		canvasY: Math.round(position.canvasY / SNAP_GRID_SIZE) * SNAP_GRID_SIZE,
	});
}

function getServicePosition(
	service: ServiceWithDetails,
	index: number,
): CanvasPosition {
	const fallback = getDefaultServicePosition(index);

	return {
		canvasX: service.canvasX ?? fallback.canvasX,
		canvasY: service.canvasY ?? fallback.canvasY,
	};
}

function ServiceCardSkeleton() {
	return (
		<div className="flex flex-col items-stretch gap-2 w-full md:w-80">
			<div className="flex min-h-36 w-full flex-col p-4 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-slate-100/50 dark:bg-slate-800/50">
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
				<div className="mt-auto pt-2">
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
	className,
}: {
	environments: Environment[];
	selectedEnvName: string;
	projectSlug: string;
	className?: string;
}) {
	const router = useRouter();

	return (
		<div className={cn("flex items-center gap-2", className)}>
			<NativeSelect
				size="sm"
				value={selectedEnvName}
				onChange={(e) =>
					router.push(`/dashboard/projects/${projectSlug}/${e.target.value}`)
				}
			>
				{environments.map((env) => (
					<NativeSelectOption key={env.id} value={env.name}>
						{env.name}
					</NativeSelectOption>
				))}
			</NativeSelect>
			<Link
				href={`/dashboard/projects/${projectSlug}/${selectedEnvName}/deleted`}
				className={cn(
					buttonVariants({ variant: "outline", size: "sm" }),
					"gap-2",
				)}
			>
				<Trash2 className="h-4 w-4" />
				<span className="hidden md:inline">Deleted</span>
			</Link>
			<Link
				href={`/dashboard/projects/${projectSlug}/settings`}
				className={cn(
					buttonVariants({ variant: "outline", size: "sm" }),
					"ml-1 gap-2",
				)}
			>
				<Settings className="h-4 w-4" />
				<span className="hidden md:inline">Settings</span>
			</Link>
		</div>
	);
}

function CanvasContextMenuContent({
	projectSlug,
	envName,
	environments,
	onCreateDocker,
	onCreateGitHub,
}: {
	projectSlug: string;
	envName: string;
	environments: Environment[];
	onCreateDocker: () => void;
	onCreateGitHub: () => void;
}) {
	const router = useRouter();
	return (
		<ContextMenuContent>
			<ContextMenuItem onClick={onCreateGitHub}>
				<Github className="h-4 w-4" />
				GitHub Repo
			</ContextMenuItem>
			<ContextMenuItem onClick={onCreateDocker}>
				<Box className="h-4 w-4" />
				Docker Image
			</ContextMenuItem>
			<ContextMenuItem
				onClick={() =>
					router.push(
						`/dashboard/projects/${projectSlug}/${envName}/import-compose`,
					)
				}
			>
				<Upload className="h-4 w-4" />
				Import Compose
			</ContextMenuItem>
			<ContextMenuSeparator />
			{environments.length > 1 && (
				<ContextMenuSub>
					<ContextMenuSubTrigger>
						<ArrowLeftRight className="h-4 w-4" />
						Switch Environment
					</ContextMenuSubTrigger>
					<ContextMenuSubContent>
						{environments.map((env) => (
							<ContextMenuItem
								key={env.id}
								disabled={env.name === envName}
								onClick={() =>
									router.push(`/dashboard/projects/${projectSlug}/${env.name}`)
								}
							>
								{env.name}
							</ContextMenuItem>
						))}
					</ContextMenuSubContent>
				</ContextMenuSub>
			)}
			<ContextMenuItem
				onClick={() =>
					router.push(`/dashboard/projects/${projectSlug}/settings`)
				}
			>
				<Settings className="h-4 w-4" />
				Project Settings
			</ContextMenuItem>
		</ContextMenuContent>
	);
}

function ServiceCard({
	service,
	projectSlug,
	envName,
	proxyDomain,
	dragHandleProps,
}: {
	service: ServiceWithDetails;
	projectSlug: string;
	envName: string;
	proxyDomain: string | null;
	dragHandleProps?: AnchorHTMLAttributes<HTMLAnchorElement>;
}) {
	const colors = getStatusColorFromDeployments(service.deployments);
	const { className: dragHandleClassName, ...linkProps } =
		dragHandleProps ?? {};
	const publicPorts = service.ports.filter((p) => p.isPublic && p.domain);
	const tcpUdpPorts = service.ports.filter(
		(p) =>
			(p.protocol === "tcp" || p.protocol === "udp") &&
			p.isPublic &&
			p.externalPort,
	);
	const hasInternalDns = service.deployments.some(
		(d) => d.status === "running",
	);
	const runningCount = service.deployments.filter(
		(d) => d.status === "running",
	).length;

	const hasEndpoints =
		publicPorts.length > 0 ||
		(tcpUdpPorts.length > 0 && proxyDomain) ||
		hasInternalDns;

	return (
		<div className="flex flex-col items-stretch gap-2 w-full md:w-80">
			<Link
				{...linkProps}
				href={`/dashboard/projects/${projectSlug}/${envName}/services/${service.id}`}
				className={cn(
					"group block w-full cursor-pointer rounded-xl transition-all duration-200 hover:shadow-lg hover:ring hover:ring-primary/25 dark:hover:ring-primary/55",
					dragHandleClassName,
				)}
			>
				<div className="relative z-10 flex min-h-30 w-full flex-col rounded-xl border border-slate-200 dark:border-slate-700 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm px-2.5 py-2">
					<div className="py-1">
						<div className="flex items-center justify-between gap-2">
							<h3 className="font-semibold text-[15px] text-foreground truncate">
								{service.name}
							</h3>
							<div className="flex items-center gap-1.5 shrink-0">
								<span className="relative flex h-2.5 w-2.5">
									{runningCount > 0 && (
										<span
											className={`animate-ping absolute inline-flex h-full w-full rounded-full ${colors.dot} opacity-75`}
										/>
									)}
									<span
										className={`relative inline-flex rounded-full h-2.5 w-2.5 ${colors.dot}`}
									/>
								</span>
								<span className={`text-xs font-medium ${colors.text}`}>
									{service.deployments.length > 0
										? `${runningCount}/${service.deployments.length}`
										: "Not deployed"}
								</span>
							</div>
						</div>
					</div>

					{hasEndpoints && (
						<div className="mt-2 space-y-1.5">
							{publicPorts.map((port) => (
								<div
									key={port.id}
									className="border-l-2 border-sky-500 pl-2.5 py-0.5"
								>
									<div className="flex items-center gap-2 text-xs text-foreground">
										<Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
										<span className="truncate">{port.domain}</span>
									</div>
								</div>
							))}
							{tcpUdpPorts.length > 0 &&
								proxyDomain &&
								tcpUdpPorts.map((port) => (
									<div
										key={port.id}
										className="border-l-2 border-violet-500 pl-2.5 py-0.5"
									>
										<div className="flex items-center gap-2 text-xs text-foreground font-mono">
											<Network className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
											<span className="truncate">
												{port.protocol}://{proxyDomain}:{port.externalPort}
											</span>
										</div>
									</div>
								))}
							{hasInternalDns && (
								<div className="border-l-2 border-slate-300 dark:border-slate-600 pl-2.5 py-0.5">
									<div className="flex items-center gap-2 text-xs text-foreground">
										<Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
										<span className="truncate">
											{service.hostname || service.name}.internal
										</span>
									</div>
								</div>
							)}
						</div>
					)}
				</div>

				{service.volumes && service.volumes.length > 0 && (
					<div className="-mt-2 rounded-b-xl border border-slate-200 dark:border-slate-700 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm px-3 pt-4 pb-2.5 space-y-1.5">
						{service.volumes.map((volume) => (
							<div
								key={volume.id}
								className="flex items-center gap-2.5 text-muted-foreground"
							>
								<HardDrive className="h-4 w-4 shrink-0" />
								<span className="text-xs font-medium truncate">
									{volume.name}
								</span>
							</div>
						))}
					</div>
				)}
			</Link>
		</div>
	);
}

function DraggableServiceCard({
	service,
	index,
	projectSlug,
	envName,
	proxyDomain,
	canvasScale,
	onPositionChange,
}: {
	service: ServiceWithDetails;
	index: number;
	projectSlug: string;
	envName: string;
	proxyDomain: string | null;
	canvasScale: number;
	onPositionChange: (serviceId: string, position: CanvasPosition) => void;
}) {
	const [dragPosition, setDragPosition] = useState<CanvasPosition | null>(null);
	const dragRef = useRef<{
		pointerId: number;
		startX: number;
		startY: number;
		origin: CanvasPosition;
		moved: boolean;
	} | null>(null);
	const suppressClickRef = useRef(false);
	const position = dragPosition ?? getServicePosition(service, index);

	const handlePointerDown = useCallback(
		(event: PointerEvent<HTMLAnchorElement>) => {
			if (event.button !== 0) {
				return;
			}

			event.currentTarget.setPointerCapture(event.pointerId);
			dragRef.current = {
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				origin: position,
				moved: false,
			};
		},
		[position],
	);

	const handlePointerMove = useCallback(
		(event: PointerEvent<HTMLAnchorElement>) => {
			const drag = dragRef.current;
			if (!drag || drag.pointerId !== event.pointerId) {
				return;
			}

			const deltaX = (event.clientX - drag.startX) / canvasScale;
			const deltaY = (event.clientY - drag.startY) / canvasScale;
			const nextPosition = clampPosition({
				canvasX: drag.origin.canvasX + deltaX,
				canvasY: drag.origin.canvasY + deltaY,
			});

			if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
				drag.moved = true;
				event.preventDefault();
			}

			setDragPosition(nextPosition);
		},
		[canvasScale],
	);

	const handlePointerUp = useCallback(
		(event: PointerEvent<HTMLAnchorElement>) => {
			const drag = dragRef.current;
			if (!drag || drag.pointerId !== event.pointerId) {
				return;
			}

			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
			dragRef.current = null;
			setDragPosition(null);

			if (drag.moved) {
				suppressClickRef.current = true;
				onPositionChange(service.id, snapPosition(position));
			}
		},
		[onPositionChange, position, service.id],
	);

	const handlePointerCancel = useCallback(
		(event: PointerEvent<HTMLAnchorElement>) => {
			const drag = dragRef.current;
			if (!drag || drag.pointerId !== event.pointerId) {
				return;
			}

			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}

			dragRef.current = null;
			setDragPosition(null);
			suppressClickRef.current = false;
		},
		[],
	);

	const handleClickCapture = useCallback(
		(event: MouseEvent<HTMLAnchorElement>) => {
			if (!suppressClickRef.current) {
				return;
			}

			suppressClickRef.current = false;
			event.preventDefault();
			event.stopPropagation();
		},
		[],
	);

	return (
		<div
			className="absolute"
			style={{
				width: SERVICE_CARD_WIDTH,
				transform: `translate(${position.canvasX}px, ${position.canvasY}px)`,
			}}
		>
			<ServiceCard
				service={service}
				projectSlug={projectSlug}
				envName={envName}
				proxyDomain={proxyDomain}
				dragHandleProps={{
					className:
						"touch-none cursor-grab select-none active:cursor-grabbing",
					onPointerDown: handlePointerDown,
					onPointerMove: handlePointerMove,
					onPointerUp: handlePointerUp,
					onPointerCancel: handlePointerCancel,
					onClickCapture: handleClickCapture,
					onDragStart: (event) => event.preventDefault(),
				}}
			/>
		</div>
	);
}

export function ServiceCanvas({
	projectId,
	projectSlug,
	envId,
	envName,
	proxyDomain,
}: {
	projectId: string;
	projectSlug: string;
	envId: string;
	envName: string;
	proxyDomain: string | null;
}) {
	const { data: environments } = useSWR<Environment[]>(
		`/api/projects/${projectId}/environments`,
		fetcher,
	);

	const [dockerDialogOpen, setDockerDialogOpen] = useState(false);
	const [githubDialogOpen, setGithubDialogOpen] = useState(false);
	const [canvasScale, setCanvasScale] = useState(getCanvasScale);

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

	useEffect(() => {
		const updateCanvasScale = () => setCanvasScale(getCanvasScale());

		window.addEventListener("resize", updateCanvasScale);

		return () => window.removeEventListener("resize", updateCanvasScale);
	}, []);

	const composeHref = `/dashboard/projects/${projectSlug}/${envName}/import-compose`;

	const menuCallbacks = useMemo(
		() => ({
			onSelectDocker: () => setDockerDialogOpen(true),
			onSelectGitHub: () => setGithubDialogOpen(true),
			composeHref,
		}),
		[composeHref],
	);

	const contextMenuCallbacks = useMemo(
		() => ({
			onCreateDocker: () => setDockerDialogOpen(true),
			onCreateGitHub: () => setGithubDialogOpen(true),
		}),
		[],
	);

	const dialogProps = useMemo(
		() => ({
			projectId,
			environmentId: envId,
			projectSlug,
			envName,
			onSuccess: () => mutate(),
		}),
		[projectId, envId, projectSlug, envName, mutate],
	);

	const handlePositionChange = useCallback(
		(serviceId: string, position: CanvasPosition) => {
			const nextPosition = clampPosition(position);

			void mutate(
				(current) =>
					current?.map((service) =>
						service.id === serviceId
							? {
									...service,
									...nextPosition,
								}
							: service,
					),
				false,
			);

			void fetch(`/api/projects/${projectId}/services/${serviceId}/position`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(nextPosition),
			})
				.then(async (response) => {
					if (!response.ok) {
						void mutate();
						return;
					}

					const savedPosition = (await response.json()) as CanvasPosition;

					void mutate(
						(current) =>
							current?.map((service) =>
								service.id === serviceId
									? {
											...service,
											canvasX: savedPosition.canvasX,
											canvasY: savedPosition.canvasY,
										}
									: service,
							),
						false,
					);
				})
				.catch(() => {
					void mutate();
				});
		},
		[mutate, projectId],
	);

	if (!environments || isLoading) {
		return (
			<>
				<div className="flex flex-col gap-4 py-4 md:hidden">
					<ServiceCardSkeleton />
					<ServiceCardSkeleton />
				</div>
				<div
					className="
						hidden md:flex
						relative -mt-6 -mb-6 p-10
						left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen
						bg-slate-50/50 dark:bg-slate-900/30
						items-center justify-center
					"
					style={{
						height: "calc(100vh - 3.5rem)",
						backgroundImage: CANVAS_DOT_PATTERN,
						backgroundSize: "24px 24px",
					}}
				>
					<div className="flex flex-wrap gap-10 justify-center items-center">
						<ServiceCardSkeleton />
						<ServiceCardSkeleton />
					</div>
				</div>
			</>
		);
	}

	if (!services || services.length === 0) {
		return (
			<>
				<CreateDockerServiceDialog
					{...dialogProps}
					open={dockerDialogOpen}
					onOpenChange={setDockerDialogOpen}
				/>
				<CreateGitHubServiceDialog
					{...dialogProps}
					open={githubDialogOpen}
					onOpenChange={setGithubDialogOpen}
				/>
				<div className="flex flex-col gap-4 py-4 md:hidden">
					<div className="flex items-center gap-2">
						<EnvironmentSelector
							environments={environments}
							selectedEnvName={envName}
							projectSlug={projectSlug}
						/>
					</div>
					<Empty>
						<EmptyMedia variant="icon">
							<Box className="size-5" />
						</EmptyMedia>
						<EmptyTitle>No services yet</EmptyTitle>
						<EmptyDescription>
							Add your first service to deploy.
						</EmptyDescription>
						<EmptyContent>
							<AddServiceMenu {...menuCallbacks} />
						</EmptyContent>
					</Empty>
				</div>
				<ContextMenu>
					<ContextMenuTrigger
						className="
						hidden md:flex
						relative -mt-6 -mb-6
						left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen
						bg-slate-50 dark:bg-slate-900/50
						items-center justify-center
					"
						style={{
							height: "calc(100vh - 5rem)",
							backgroundImage: CANVAS_DOT_PATTERN,
							backgroundSize: "20px 20px",
						}}
					>
						<EnvironmentSelector
							environments={environments}
							selectedEnvName={envName}
							projectSlug={projectSlug}
							className="absolute top-4 left-4"
						/>
						<Empty>
							<EmptyMedia variant="icon">
								<Box className="size-5" />
							</EmptyMedia>
							<EmptyTitle>No services yet</EmptyTitle>
							<EmptyDescription>
								Add your first service to deploy.
							</EmptyDescription>
							<EmptyContent>
								<AddServiceMenu {...menuCallbacks} />
							</EmptyContent>
						</Empty>
					</ContextMenuTrigger>
					<CanvasContextMenuContent
						projectSlug={projectSlug}
						envName={envName}
						environments={environments}
						{...contextMenuCallbacks}
					/>
				</ContextMenu>
			</>
		);
	}

	return (
		<>
			<CreateDockerServiceDialog
				{...dialogProps}
				open={dockerDialogOpen}
				onOpenChange={setDockerDialogOpen}
			/>
			<CreateGitHubServiceDialog
				{...dialogProps}
				open={githubDialogOpen}
				onOpenChange={setGithubDialogOpen}
			/>
			<div className="flex flex-col gap-4 py-4 md:hidden">
				<div className="flex items-center justify-between gap-2">
					<EnvironmentSelector
						environments={environments}
						selectedEnvName={envName}
						projectSlug={projectSlug}
					/>
					<AddServiceMenu {...menuCallbacks} />
				</div>
				<div className="flex flex-col gap-4">
					{services.map((service) => (
						<ServiceCard
							key={service.id}
							service={service}
							projectSlug={projectSlug}
							envName={envName}
							proxyDomain={proxyDomain}
						/>
					))}
				</div>
			</div>
			<ContextMenu>
				<ContextMenuTrigger
					className="
						hidden md:block
						relative -mt-6 -mb-6
						left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen
						bg-slate-50/50 dark:bg-slate-900/30
						overflow-auto
					"
					style={{
						height: "calc(100vh - 3.5rem)",
						backgroundImage: CANVAS_DOT_PATTERN,
						backgroundSize: "24px 24px",
					}}
				>
					<EnvironmentSelector
						environments={environments}
						selectedEnvName={envName}
						projectSlug={projectSlug}
						className="absolute top-4 left-4"
					/>
					<div className="absolute top-4 right-4">
						<AddServiceMenu {...menuCallbacks} />
					</div>
					<div className="flex min-h-full items-center justify-center px-10 py-24">
						<div
							className="relative"
							style={{
								width: CANVAS_WIDTH * canvasScale,
								height: CANVAS_HEIGHT * canvasScale,
							}}
						>
							<div
								className="relative"
								style={{
									width: CANVAS_WIDTH,
									height: CANVAS_HEIGHT,
									transform: `scale(${canvasScale})`,
									transformOrigin: "top left",
								}}
							>
								{services.map((service, index) => (
									<DraggableServiceCard
										key={service.id}
										service={service}
										index={index}
										projectSlug={projectSlug}
										envName={envName}
										proxyDomain={proxyDomain}
										canvasScale={canvasScale}
										onPositionChange={handlePositionChange}
									/>
								))}
							</div>
						</div>
					</div>
				</ContextMenuTrigger>
				<CanvasContextMenuContent
					projectSlug={projectSlug}
					envName={envName}
					environments={environments}
					{...contextMenuCallbacks}
				/>
			</ContextMenu>
		</>
	);
}
