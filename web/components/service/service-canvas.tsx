"use client";

import {
	ArrowLeftRight,
	Box,
	Github,
	Globe,
	HardDrive,
	Settings,
	Trash2,
	Upload,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AnchorHTMLAttributes, MouseEvent, PointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
	SUMMARY_CARD_MIN_HEIGHT,
	SummaryCardLine,
	SummaryCardStat,
	SummaryCardTitle,
	SummaryCardValue,
} from "@/components/core/summary-card";
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
import {
	observedReadyPhases,
	observedStartingPhases,
} from "@/lib/deployment-status";
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
const SERVICE_CARD_HEIGHT = SUMMARY_CARD_MIN_HEIGHT;
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

function getStatusLabel(
	deployments: ServiceWithDetails["deployments"],
	runningCount: number,
): string {
	if (deployments.length === 0) {
		return "not deployed";
	}
	if (deployments.some((d) => d.observedPhase === "failed")) {
		return "failed";
	}
	if (runningCount === deployments.length) {
		return "running";
	}
	if (
		deployments.some((d) =>
			(observedStartingPhases as readonly string[]).includes(d.observedPhase),
		)
	) {
		return "deploying";
	}
	if (deployments.every((d) => d.observedPhase === "sleeping")) {
		return "sleeping";
	}
	if (runningCount === 0) {
		return "stopped";
	}

	return "degraded";
}

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
		<div className="flex flex-col items-stretch w-full md:w-80">
			<div
				className="flex w-full flex-col rounded-xl border border-slate-200 dark:border-slate-700 bg-white/50 dark:bg-slate-900/50 px-3.5 py-3"
				style={{ minHeight: SERVICE_CARD_HEIGHT }}
			>
				<div className="h-4 w-32 animate-pulse rounded bg-slate-200 dark:bg-slate-700" />
				<div className="mt-2.5 space-y-2">
					<div className="h-2.5 w-40 animate-pulse rounded bg-slate-200 dark:bg-slate-700" />
					<div className="h-2.5 w-24 animate-pulse rounded bg-slate-200 dark:bg-slate-700" />
				</div>
				<div className="mt-auto space-y-2 pt-3">
					<div className="h-2.5 w-full animate-pulse rounded bg-slate-200 dark:bg-slate-700" />
					<div className="h-2.5 w-full animate-pulse rounded bg-slate-200 dark:bg-slate-700" />
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
	dragHandleProps,
}: {
	service: ServiceWithDetails;
	projectSlug: string;
	envName: string;
	dragHandleProps?: AnchorHTMLAttributes<HTMLAnchorElement>;
}) {
	const colors = getStatusColorFromDeployments(service.deployments);
	const { className: dragHandleClassName, ...linkProps } =
		dragHandleProps ?? {};
	const runningCount = service.deployments.filter((d) =>
		(observedReadyPhases as readonly string[]).includes(d.observedPhase),
	).length;
	const statusLabel = getStatusLabel(service.deployments, runningCount);
	const publicEndpoint = service.ports.find((p) => p.isPublic && p.domain);
	const volumeNames = (service.volumes ?? []).map((v) => v.name).join(", ");

	return (
		<div className="flex flex-col items-stretch w-full md:w-80">
			<Link
				{...linkProps}
				href={`/dashboard/projects/${projectSlug}/${envName}/services/${service.id}`}
				className={cn(
					"group block w-full cursor-pointer rounded-xl transition-all duration-200 hover:ring hover:ring-primary/25 dark:hover:ring-primary/55",
					dragHandleClassName,
				)}
			>
				<div
					className="relative z-10 flex w-full flex-col rounded-xl border border-slate-200 dark:border-slate-700 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm px-3.5 py-3"
					style={{ minHeight: SERVICE_CARD_HEIGHT }}
				>
					<SummaryCardTitle>{service.name}</SummaryCardTitle>

					{(publicEndpoint || volumeNames) && (
						<div className="mt-1.5 space-y-0.5">
							{publicEndpoint?.domain && (
								<SummaryCardLine icon={Globe} value={publicEndpoint.domain} />
							)}
							{volumeNames && (
								<SummaryCardLine icon={HardDrive} value={volumeNames} />
							)}
						</div>
					)}

					<div className="mt-auto pt-3">
						<SummaryCardStat label="replicas">
							<SummaryCardValue>
								{service.deployments.length > 0
									? `${runningCount}/${service.deployments.length}`
									: "0"}
							</SummaryCardValue>
						</SummaryCardStat>
						<SummaryCardStat label="status">
							<span className="flex items-center gap-1.5">
								<span className="relative flex h-2 w-2">
									{runningCount > 0 && (
										<span
											className={`animate-ping absolute inline-flex h-full w-full rounded-full ${colors.dot} opacity-75`}
										/>
									)}
									<span
										className={`relative inline-flex h-2 w-2 rounded-full ${colors.dot}`}
									/>
								</span>
								<span
									className={`font-mono text-xs font-semibold uppercase tracking-wider ${colors.text}`}
								>
									{statusLabel}
								</span>
							</span>
						</SummaryCardStat>
					</div>
				</div>
			</Link>
		</div>
	);
}

function DraggableServiceCard({
	service,
	index,
	projectSlug,
	envName,
	canvasScale,
	onPositionChange,
}: {
	service: ServiceWithDetails;
	index: number;
	projectSlug: string;
	envName: string;
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
							className="absolute top-4 left-4 z-10"
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
						className="absolute top-4 left-4 z-10"
					/>
					<div className="absolute top-4 right-4 z-10">
						<AddServiceMenu {...menuCallbacks} />
					</div>
					<div className="flex min-h-full items-center justify-center px-10 py-6">
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
